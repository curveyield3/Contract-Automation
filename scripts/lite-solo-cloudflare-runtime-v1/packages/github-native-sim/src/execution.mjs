import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import unzipper from 'unzipper';
import { validateDeepAssuranceRequestV2 } from './schema.mjs';

const MAX_EXTRACTED_ARCHIVE_BYTES = 250 * 1024 * 1024;

export class V7ExecutionError extends Error {
  constructor(kind, message, details = {}) {
    super(`${kind}: ${message}`);
    this.name = 'V7ExecutionError';
    this.kind = kind;
    this.details = details;
  }
}

export function safeRepositoryProjectPath(root, relativePath) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new V7ExecutionError('UNSAFE_PROJECT_PATH', 'workspace root is required');
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new V7ExecutionError('UNSAFE_PROJECT_PATH', 'project path is required');
  }
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized === '..' || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new V7ExecutionError('UNSAFE_PROJECT_PATH', `unsafe repository-relative path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new V7ExecutionError('UNSAFE_PROJECT_PATH', `path escapes repository root: ${relativePath}`);
  }
  return resolved;
}

export function runProcess({
  command, args = [], cwd, env = process.env, onStdout = null, onStderr = null,
  timeoutMs = null, maxStdoutBytes = 16 * 1024 * 1024,
  maxStderrBytes = 2 * 1024 * 1024
}) {
  return new Promise((resolve) => {
    // Bounded diagnostic tails avoid retaining potentially unbounded Foundry
    // and RPC process output in the parent node heap.
    const limit = (value) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, 16 * 1024 * 1024) : 16 * 1024 * 1024;
    const outLimit = limit(maxStdoutBytes), errLimit = limit(maxStderrBytes);
    let outTail = Buffer.alloc(0), errTail = Buffer.alloc(0);
    let stdoutBytes = 0, stderrBytes = 0;
    const retain = (old, chunk, bound) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (next.length >= bound) return Buffer.from(next.subarray(next.length - bound));
      if (old.length + next.length > bound) old = old.subarray(old.length + next.length - bound);
      return Buffer.concat([old, next]);
    };
    let settled = false, timedOut = false;
    const bounded = Number.isSafeInteger(timeoutMs) && timeoutMs > 0;
    const group = bounded && process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, shell: false, detached: group });
    let killTimer = null;
    const terminate = (signal) => {
      try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
    };
    const timeout = bounded ? setTimeout(() => {
      timedOut = true;
      const marker = Buffer.from(`\nV7_EXECUTION_TIMEOUT: subprocess exceeded ${timeoutMs}ms\n`);
      errTail = retain(errTail, marker, errLimit);
      stderrBytes += marker.length;
      terminate('SIGTERM');
      killTimer = setTimeout(() => terminate('SIGKILL'), 5_000);
      killTimer.unref();
    }, timeoutMs) : null;
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (error) {
        const msg = Buffer.from(String(error.message || error));
        errTail = retain(errTail, msg, errLimit);
        stderrBytes += msg.length;
      }
      resolve({
        exitCode: timedOut ? -1 : Number.isInteger(code) ? code : -1,
        signal: signal ?? null, timedOut,
        stdout: outTail.toString('utf8'), stderr: errTail.toString('utf8'),
        stdoutTruncated: stdoutBytes > outTail.length,
        stderrTruncated: stderrBytes > errTail.length,
        stdoutBytes, stderrBytes
      });
    };
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      outTail = retain(outTail, chunk, outLimit);
      if (onStdout) onStdout(chunk.toString(), child);
    });
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length;
      errTail = retain(errTail, chunk, errLimit);
      if (onStderr) onStderr(chunk.toString(), child);
    });
    child.on('error', (error) => finish(-1, null, error));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function requireSuccess(result, kind, command, args) {
  if (!result || result.exitCode !== 0) {
    throw new V7ExecutionError(kind, `${command} ${args.join(' ')} failed`, {
      exitCode: result?.exitCode ?? -1,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? ''
    });
  }
  return result;
}

function authenticatedGitEnvironment(environment) {
  const { AUDIT_CONTROLLER_GITHUB_TOKEN: token, ...baseEnvironment } = environment ?? {};
  if (typeof token !== 'string' || token.length === 0) return baseEnvironment;
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    ...baseEnvironment,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  };
}

export async function checkoutExactSource({ repository, commit, destination, sparsePatterns = null }, {
  runCommand = runProcess,
  environment = process.env
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    throw new V7ExecutionError('SOURCE_INTEGRITY_FAILURE', 'repository must be owner/repository');
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new V7ExecutionError('SOURCE_INTEGRITY_FAILURE', 'commit must be exactly 40 lowercase hex characters');
  }
  const resolvedDestination = path.resolve(destination);
  const resolvedParent = path.dirname(resolvedDestination);
  await fs.mkdir(resolvedParent, { recursive: true });
  const initArgs = ['init', resolvedDestination];
  const init = await runCommand({ command: 'git', args: initArgs, cwd: resolvedParent });
  await requireSuccess(init, 'SOURCE_CHECKOUT_FAILURE', 'git', initArgs);
  // Legacy frozen request metadata may name curveyield3. For this live audit
  // always fetch the EXACT SAME pinned Git commit from canonical curveyield3,
  // without ever contacting the suspended historical owner.
  const effectiveRepository = repository === 'curveyield3/Audit-Controller'
    ? 'curveyield3/Audit-Controller' : repository;
  const remote = `https://github.com/${effectiveRepository}.git`;
  const addRemote = await runCommand({ command: 'git', args: ['remote', 'add', 'origin', remote], cwd: resolvedDestination });
  await requireSuccess(addRemote, 'SOURCE_CHECKOUT_FAILURE', 'git', ['remote', 'add', 'origin', remote]);
  // Optional no-cone sparse patterns: fetch blobs lazily and materialize only the listed paths.
  const sparse = Array.isArray(sparsePatterns) && sparsePatterns.length > 0;
  if (sparse && sparsePatterns.some((p) => typeof p !== 'string' || !p.startsWith('/') || /[\r\n]/.test(p) || p.split('/').includes('..'))) {
    throw new V7ExecutionError('SOURCE_INTEGRITY_FAILURE', 'sparse patterns must be anchored single-line repository paths');
  }
  const fetchArgs = sparse ? ['fetch', '--depth', '1', '--filter=blob:none', 'origin', commit] : ['fetch', '--depth', '1', 'origin', commit];
  let fetch = await runCommand({
    command: 'git',
    args: fetchArgs,
    cwd: resolvedDestination,
    env: authenticatedGitEnvironment(environment)
  });
  // Git HEAD and archive digest checks below retain the frozen source identity.
  await requireSuccess(fetch, 'SOURCE_CHECKOUT_FAILURE', 'git', fetchArgs);
  if (sparse) {
    for (const args of [['config', 'core.sparseCheckout', 'true'], ['config', 'core.sparseCheckoutCone', 'false']]) {
      await requireSuccess(await runCommand({ command: 'git', args, cwd: resolvedDestination }), 'SOURCE_CHECKOUT_FAILURE', 'git', args);
    }
    await fs.mkdir(path.join(resolvedDestination, '.git', 'info'), { recursive: true });
    await fs.writeFile(path.join(resolvedDestination, '.git', 'info', 'sparse-checkout'), `${sparsePatterns.join('\n')}\n`);
  }
  // A blobless (sparse) fetch downloads file contents during checkout, so checkout needs the same credentials.
  const checkout = await runCommand({
    command: 'git',
    args: ['checkout', '--detach', 'FETCH_HEAD'],
    cwd: resolvedDestination,
    ...(sparse ? { env: authenticatedGitEnvironment(environment) } : {})
  });
  await requireSuccess(checkout, 'SOURCE_CHECKOUT_FAILURE', 'git', ['checkout', '--detach', 'FETCH_HEAD']);
  const rev = await runCommand({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: resolvedDestination });
  await requireSuccess(rev, 'SOURCE_CHECKOUT_FAILURE', 'git', ['rev-parse', 'HEAD']);
  const resolvedCommit = String(rev.stdout ?? '').trim();
  if (resolvedCommit !== commit) {
    throw new V7ExecutionError('SOURCE_INTEGRITY_FAILURE', 'checked-out commit does not match requested commit', {
      expectedCommit: commit,
      actualCommit: resolvedCommit
    });
  }
  return { repository, commit: resolvedCommit, destination: resolvedDestination, sparsePatterns: sparse ? [...sparsePatterns] : null };
}

export async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

function archiveEntryRelativePath(entryPath) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', 'unsafe archive entry: empty path');
  }
  const normalized = entryPath.replaceAll('\\', '/');
  const directory = normalized.endsWith('/');
  const trimmed = directory ? normalized.slice(0, -1) : normalized;
  if (!trimmed || trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) {
    throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `unsafe archive entry: ${entryPath}`);
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `unsafe archive entry: ${entryPath}`);
  }
  return { relativePath: parts.join('/'), directory };
}

function archiveEntryIsSymlink(entry) {
  const attributes = Number(entry?.vars?.externalFileAttributes ?? 0);
  const unixMode = (attributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function defaultOpenArchive(filePath) {
  return unzipper.Open.file(filePath);
}

export async function stageExactArchiveSource({
  checkoutRoot,
  workspaceRoot,
  archivePath,
  archiveSha256,
  projectPath
}, {
  openArchive = defaultOpenArchive,
  fsApi = fs,
  digestFile = sha256File
} = {}) {
  const archiveAbsolute = safeRepositoryProjectPath(checkoutRoot, archivePath);
  const actualDigest = await digestFile(archiveAbsolute);
  if (actualDigest !== archiveSha256) {
    throw new V7ExecutionError('SOURCE_INTEGRITY_FAILURE', 'private archive SHA-256 does not match the frozen request', {
      archivePath,
      expectedSha256: archiveSha256,
      actualSha256: actualDigest
    });
  }

  const extractionRoot = path.join(workspaceRoot, 'archive-source');
  await fsApi.rm(extractionRoot, { recursive: true, force: true });
  await fsApi.mkdir(extractionRoot, { recursive: true });
  const opened = await openArchive(archiveAbsolute);
  if (!opened || !Array.isArray(opened.files)) {
    throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', 'archive reader returned no file inventory');
  }

  let extractedBytes = 0;
  for (const entry of opened.files) {
    if (archiveEntryIsSymlink(entry)) {
      throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `symlink archive entry is forbidden: ${entry.path}`);
    }
    const parsed = archiveEntryRelativePath(entry.path);
    const entryType = entry.type ?? (parsed.directory ? 'Directory' : 'File');
    if (!['File', 'Directory'].includes(entryType)) {
      throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `unsupported archive entry type ${entryType}: ${entry.path}`);
    }
    const destination = safeRepositoryProjectPath(extractionRoot, parsed.relativePath);
    if (entryType === 'Directory' || parsed.directory) {
      await fsApi.mkdir(destination, { recursive: true });
      continue;
    }
    const bytes = await entry.buffer();
    extractedBytes += bytes.length;
    if (extractedBytes > MAX_EXTRACTED_ARCHIVE_BYTES) {
      throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `extracted archive exceeds ${MAX_EXTRACTED_ARCHIVE_BYTES} bytes`);
    }
    await fsApi.mkdir(path.dirname(destination), { recursive: true });
    await fsApi.writeFile(destination, bytes);
  }

  let projectRoot = safeRepositoryProjectPath(extractionRoot, projectPath);
  let projectStats;
  try {
    projectStats = await fsApi.stat(projectRoot);
  } catch (error) {
    // Scan-initialized campaigns identify their project from the repository
    // root, while their verified ZIP stores paths relative to its source dir.
    // The archive digest above still gates every byte, and this only removes
    // the archive's own parent prefix, never searches for arbitrary content.
    const archiveDir = path.posix.dirname(archivePath);
    const relativeProject = projectPath.startsWith(archiveDir + '/')
      ? projectPath.slice(archiveDir.length + 1) : null;
    if (!relativeProject) {
      throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `archive project root is missing: ${projectPath}`, { cause: error.message });
    }
    projectRoot = safeRepositoryProjectPath(extractionRoot, relativeProject);
    try {
      projectStats = await fsApi.stat(projectRoot);
    } catch (relativeError) {
      throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `archive project root is missing: ${projectPath}`, { cause: relativeError.message });
    }
  }
  if (!projectStats.isDirectory()) {
    throw new V7ExecutionError('ARCHIVE_SOURCE_FAILURE', `archive project root is not a directory: ${projectPath}`);
  }

  return {
    projectRoot,
    extractionRoot,
    archivePath,
    archiveSha256: actualDigest,
    extractedBytes,
    entryCount: opened.files.length
  };
}

export async function runPinnedBuild(input, {
  workspaceRoot,
  build,
  checkoutExactSourceFn = checkoutExactSource,
  runCommand = runProcess,
  environment = process.env,
  digestFile = sha256File
} = {}) {
  const request = validateDeepAssuranceRequestV2(input);
  if (!workspaceRoot) throw new V7ExecutionError('SOURCE_CHECKOUT_FAILURE', 'workspaceRoot is required');
  if (!build || typeof build.command !== 'string' || build.command.length === 0) {
    throw new V7ExecutionError('COMPILE_FAILURE', 'build command is required');
  }
  if (!build.compiler || typeof build.compiler.name !== 'string' || typeof build.compiler.version !== 'string') {
    throw new V7ExecutionError('COMPILE_FAILURE', 'compiler identity is required');
  }

  await fs.mkdir(workspaceRoot, { recursive: true });
  const checkoutRoot = path.join(workspaceRoot, 'checkout');
  const checkout = await checkoutExactSourceFn({
    repository: request.source.repository,
    commit: request.source.commit,
    destination: checkoutRoot
  }, { runCommand, environment });
  if (!checkout || checkout.commit !== request.source.commit) {
    throw new V7ExecutionError('SOURCE_INTEGRITY_FAILURE', 'checkout did not return the requested commit', {
      expectedCommit: request.source.commit,
      actualCommit: checkout?.commit ?? null
    });
  }

  const staged = request.source.archivePath
    ? await stageExactArchiveSource({
        checkoutRoot,
        workspaceRoot,
        archivePath: request.source.archivePath,
        archiveSha256: request.source.archiveSha256,
        projectPath: request.source.projectPath
      }, { digestFile })
    : null;
  const projectRoot = staged?.projectRoot ?? safeRepositoryProjectPath(checkoutRoot, request.source.projectPath);
  const args = Array.isArray(build.args) ? [...build.args] : [];
  const commandResult = await runCommand({ command: build.command, args, cwd: projectRoot });
  if (!commandResult || commandResult.exitCode !== 0) {
    throw new V7ExecutionError('COMPILE_FAILURE', 'compiler/build command failed', {
      command: build.command,
      args,
      exitCode: commandResult?.exitCode ?? -1,
      stdout: commandResult?.stdout ?? '',
      stderr: commandResult?.stderr ?? ''
    });
  }

  const artifacts = [];
  for (const artifactPath of build.artifactPaths ?? []) {
    const absolute = safeRepositoryProjectPath(projectRoot, artifactPath);
    let stats;
    try {
      stats = await fs.stat(absolute);
    } catch (error) {
      throw new V7ExecutionError('ARTIFACT_MISSING', `expected artifact is missing: ${artifactPath}`, { cause: error.message });
    }
    if (!stats.isFile()) throw new V7ExecutionError('ARTIFACT_MISSING', `expected artifact is not a file: ${artifactPath}`);
    artifacts.push({ path: artifactPath.replaceAll('\\', '/'), sha256: await digestFile(absolute), bytes: stats.size });
  }

  return {
    schemaVersion: 'deep-assurance-pinned-build-evidence/v1',
    source: structuredClone(request.source),
    checkout: {
      repository: request.source.repository,
      commit: checkout.commit,
      ...(staged ? { archivePath: staged.archivePath, archiveSha256: staged.archiveSha256 } : {})
    },
    compiler: structuredClone(build.compiler),
    command: {
      command: build.command,
      args,
      exitCode: commandResult.exitCode
    },
    artifacts
  };
}
