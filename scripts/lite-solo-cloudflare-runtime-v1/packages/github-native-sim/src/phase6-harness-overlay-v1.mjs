import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { V7_POLICY } from './v7-policy.mjs';

const BUNDLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const ALLOWED_ROOT_FILES = new Set(['medusa.json', 'foundry.toml']);
const ALLOWED_PREFIXES = ['test/phase6/', 'audit/phase6/', 'script/phase6/'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty relative path`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized === '..' || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} is unsafe: ${value}`);
  }
  return normalized;
}

function inside(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safeRelative(relative, label));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`${label} escapes its root`);
  return resolved;
}

function destinationAllowed(destination) {
  return ALLOWED_ROOT_FILES.has(destination) || ALLOWED_PREFIXES.some((prefix) => destination.startsWith(prefix));
}

async function destinationMustNotExist(destination, {bytes, allowIdenticalConfig=false} = {}) {
  try {
    const stat=await fs.lstat(destination);
    // Already-admitted live scan archives carry a source-owned foundry.toml.
    // If the overlay's exact bytes match, use it *without modifying source*.
    // Any difference, symlink, directory or non-config collision fails closed.
    if(allowIdenticalConfig&&stat.isFile()&&Buffer.isBuffer(bytes)
      &&(await fs.readFile(destination)).equals(bytes)) return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  throw new Error(`Phase 6 audit overlay refuses to overwrite staged source path: ${destination}`);
}

function validateSourceBinding(manifest, source) {
  const expected = manifest?.sourceBinding;
  if (!expected || typeof expected !== 'object') throw new Error('Phase 6 harness manifest is missing source binding');
  const actualArchive = source?.archiveSha256 ?? null;
  const expectedArchive = expected.archiveSha256 ?? null;
  if (expected.repository !== source?.repository || expected.commit !== source?.commit || expectedArchive !== actualArchive) {
    throw new Error('Phase 6 harness source binding does not match the exact request source binding');
  }
}

function assertNoUsableRpcLiteral(bytes, sourcePath) {
  const text = bytes.toString('utf8');
  const urls = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const forbidden = urls.filter((url) => !url.includes('127.0.0.1') && !url.includes('localhost'));
  if (forbidden.length > 0) throw new Error(`Phase 6 audit overlay contains a forbidden literal RPC URL in ${sourcePath}`);
}

export async function materializePhase6HarnessOverlayV1({ projectRoot, runnerRoot, bundleId, source }) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw new Error('Phase 6 harness overlay requires projectRoot');
  if (typeof runnerRoot !== 'string' || runnerRoot.length === 0) throw new Error('Phase 6 harness overlay requires runnerRoot');
  if (!BUNDLE_ID.test(bundleId ?? '')) throw new Error(`Invalid Phase 6 harness bundle id: ${bundleId ?? ''}`);

  const bundlesRoot = path.join(path.resolve(runnerRoot), V7_POLICY.phase6.overlayRoot);
  const bundleRoot = inside(bundlesRoot, bundleId, 'bundleId');
  const manifestPath = path.join(bundleRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read Phase 6 harness manifest for ${bundleId}: ${error.message}`);
  }

  if (manifest?.schemaVersion !== 'phase6-audit-harness-overlay-v1') throw new Error(`Unsupported Phase 6 harness manifest schema for ${bundleId}`);
  if (manifest?.bundleId !== bundleId) throw new Error(`Phase 6 harness manifest bundleId mismatch for ${bundleId}`);
  validateSourceBinding(manifest, source);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error(`Phase 6 harness manifest ${bundleId} has no files`);

  const materialized = [];
  const destinations = new Set();
  for (const [index, entry] of manifest.files.entries()) {
    if (!entry || typeof entry !== 'object') throw new Error(`Phase 6 harness manifest file[${index}] must be an object`);
    const sourcePath = safeRelative(entry.source, `manifest.files[${index}].source`);
    const destinationPath = safeRelative(entry.destination, `manifest.files[${index}].destination`);
    if (!destinationAllowed(destinationPath)) throw new Error(`Phase 6 harness destination is outside the audit-only allowlist: ${destinationPath}`);
    if (destinations.has(destinationPath)) throw new Error(`Phase 6 harness manifest has duplicate destination: ${destinationPath}`);
    destinations.add(destinationPath);

    const from = inside(bundleRoot, sourcePath, `manifest.files[${index}].source`);
    const to = inside(projectRoot, destinationPath, `manifest.files[${index}].destination`);
    const bytes = await fs.readFile(from);
    const existingIdentical=await destinationMustNotExist(to, {
      bytes, allowIdenticalConfig:destinationPath==='foundry.toml'
    });
    const observedDigest = sha256(bytes);
    if (entry.sha256 && entry.sha256 !== observedDigest) {
      throw new Error(`Phase 6 harness file digest mismatch for ${sourcePath}: expected ${entry.sha256}, observed ${observedDigest}`);
    }
    assertNoUsableRpcLiteral(bytes, sourcePath);
    if(!existingIdentical) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, bytes);
    }
    materialized.push({ source: sourcePath, destination: destinationPath, sha256: observedDigest,
      bytes: bytes.length, reusedUnchangedSourceConfig:existingIdentical });
  }

  for (const required of V7_POLICY.phase6.requiredRuntimeFiles) {
    if (!destinations.has(required)) throw new Error(`Phase 6 harness manifest is missing required runtime destination: ${required}`);
  }

  materialized.sort((a, b) => a.destination.localeCompare(b.destination));
  const overlayIdentity = {
    schemaVersion: 'phase6-audit-harness-overlay-evidence-v1',
    bundleId,
    sourceBinding: {
      repository: source.repository,
      commit: source.commit,
      archiveSha256: source.archiveSha256 ?? null,
    },
    files: materialized,
  };
  return { ...overlayIdentity, overlayDigestSha256: sha256(Buffer.from(JSON.stringify(overlayIdentity))) };
}
