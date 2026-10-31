import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkoutExactSource,
  safeRepositoryProjectPath,
  stageExactArchiveSource,
} from './execution.mjs';
import { materializePhase6HarnessOverlayV1 } from './phase6-harness-overlay-v1.mjs';
import { V7_POLICY } from './v7-policy.mjs';

function requestedBundleId(request) {
  const harness = request?.configuration?.harness;
  if (!harness || harness.kind !== V7_POLICY.phase6.overlayKind) return null;
  return harness.bundleId;
}

function sha256() {
  return createHash('sha256');
}

async function walkFiles(root, current = root, out = []) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await walkFiles(root, absolute, out);
    else if (entry.isFile()) out.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`Phase 6 snapshot refuses non-regular entry: ${absolute}`);
  }
  return out;
}

export async function digestDirectory(root) {
  const files = await walkFiles(root);
  const digest = sha256();
  let totalBytes = 0;
  for (const relative of files) {
    const bytes = await fs.readFile(path.join(root, relative));
    totalBytes += bytes.length;
    digest.update(Buffer.from(relative));
    digest.update(Buffer.from([0]));
    digest.update(bytes);
    digest.update(Buffer.from([0]));
  }
  return {
    digestSha256: digest.digest('hex'),
    fileCount: files.length,
    totalBytes,
  };
}

export async function stagePhase6Snapshot(request, {
  workspaceRoot,
  environment = process.env,
  runnerRoot,
} = {}) {
  const snapshotRoot = path.join(workspaceRoot, 'phase6-snapshot');
  const checkoutRoot = path.join(snapshotRoot, 'checkout');
  await fs.rm(snapshotRoot, { recursive: true, force: true });
  await fs.mkdir(snapshotRoot, { recursive: true });

  const checkout = await checkoutExactSource({
    repository: request.source.repository,
    commit: request.source.commit,
    destination: checkoutRoot,
  }, { environment });
  if (checkout.commit !== request.source.commit) {
    throw new Error(`Phase 6 snapshot source mismatch: expected ${request.source.commit}, received ${checkout.commit}`);
  }

  const stagedArchive = request.source.archivePath
    ? await stageExactArchiveSource({
        checkoutRoot,
        workspaceRoot: path.join(snapshotRoot, 'archive-stage'),
        archivePath: request.source.archivePath,
        archiveSha256: request.source.archiveSha256,
        projectPath: request.source.projectPath,
      })
    : null;
  const projectRoot = stagedArchive?.projectRoot ?? safeRepositoryProjectPath(checkoutRoot, request.source.projectPath);

  const bundleId = requestedBundleId(request);
  const harnessOverlay = bundleId
    ? await materializePhase6HarnessOverlayV1({ projectRoot, runnerRoot, bundleId, source: request.source })
    : null;

  const snapshot = await digestDirectory(projectRoot);
  return {
    schemaVersion: 'phase6-staged-snapshot-v1',
    snapshotRoot,
    checkoutRoot,
    projectRoot,
    commit: checkout.commit,
    source: structuredClone(request.source),
    harnessOverlay,
    snapshotDigestSha256: snapshot.digestSha256,
    snapshotFileCount: snapshot.fileCount,
    snapshotBytes: snapshot.totalBytes,
    ...(stagedArchive ? {
      archivePath: stagedArchive.archivePath,
      archiveSha256: stagedArchive.archiveSha256,
      archiveExtractionRoot: stagedArchive.extractionRoot,
      archiveExtractedBytes: stagedArchive.extractedBytes,
      archiveEntryCount: stagedArchive.entryCount,
    } : {}),
  };
}

export async function copyPhase6SnapshotForExecution(snapshot, { workspaceRoot } = {}) {
  const executionRoot = path.join(workspaceRoot, 'phase6-execution-copy');
  await fs.rm(executionRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(executionRoot), { recursive: true });

  const archiveExtractionRoot = snapshot.archiveExtractionRoot ?? null;
  const copyRoot = archiveExtractionRoot ?? snapshot.projectRoot;
  await fs.cp(copyRoot, executionRoot, {
    recursive: true,
    preserveTimestamps: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== '.git' && base !== 'node_modules';
    },
  });

  let projectRoot = executionRoot;
  if (archiveExtractionRoot) {
    const projectRelative = path.relative(archiveExtractionRoot, snapshot.projectRoot);
    if (path.isAbsolute(projectRelative) || projectRelative.split(path.sep).includes('..')) {
      const error = new Error('Phase 6 archive project root escapes the staged archive extraction root');
      error.kind = 'PHASE6_SNAPSHOT_INTEGRITY_FAILURE';
      throw error;
    }
    projectRoot = projectRelative ? path.join(executionRoot, projectRelative) : executionRoot;
  }

  const copied = await digestDirectory(projectRoot);
  if (copied.digestSha256 !== snapshot.snapshotDigestSha256) {
    const error = new Error('Phase 6 execution copy digest does not match the preflight snapshot');
    error.kind = 'PHASE6_SNAPSHOT_INTEGRITY_FAILURE';
    throw error;
  }
  return {
    commit: snapshot.commit,
    projectRoot,
    snapshotDigestSha256: copied.digestSha256,
    snapshotFileCount: copied.fileCount,
    snapshotBytes: copied.totalBytes,
    harnessOverlay: snapshot.harnessOverlay,
  };
}
