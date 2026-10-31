import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateDeepAssuranceRequestV2 } from './schema.mjs';
import { V7_POLICY } from './v7-policy.mjs';

const CAMPAIGN_CONFIG = Object.freeze({
  discovery: 'medusa/medusa-discovery-template_v2.json',
  property: 'medusa/medusa-property-template_v2.json',
  targeted: 'medusa/medusa-targeted-template_v2.json',
});

const COMMON_SKELETONS = Object.freeze([
  ['foundry/foundry-template_v2.toml', 'foundry.toml'],
  ['medusa/Phase6MedusaHarness_v2.sol.template', 'test/phase6/Phase6MedusaHarness_v2.sol'],
  ['foundry/Phase6InvariantTargeting_v2.sol.template', 'test/phase6/Phase6InvariantTargeting_v2.sol'],
  ['foundry/Phase6StatefulHandler_v2.sol.template', 'test/phase6/Phase6StatefulHandler_v2.sol'],
  ['foundry/Phase6InvariantSuite_v2.t.sol.template', 'test/phase6/Phase6InvariantSuite_v2.t.sol'],
  ['foundry/Phase6BoundaryFuzz_v2.t.sol.template', 'test/phase6/Phase6BoundaryFuzz_v2.t.sol'],
  ['foundry/Phase6DifferentialFuzz_v2.t.sol.template', 'test/phase6/Phase6DifferentialFuzz_v2.t.sol'],
  ['models/Phase6GhostModel_v2.sol.template', 'test/phase6/Phase6GhostModel_v2.sol'],
]);

const TARGET_PLACEHOLDERS = Object.freeze([
  'PHASE6_DISCOVERY_HARNESS',
  'PHASE6_PROPERTY_HARNESS',
  'PHASE6_TARGETED_HARNESS',
  'PHASE6_ACTION_A',
  'PHASE6_ACTION_B',
  'PHASE6_ACTION_C',
  'PHASE6_MIN_A',
  'PHASE6_MAX_A',
  'PHASE6_MIN_B',
  'PHASE6_MAX_B',
  'PHASE6_MIN_C',
  'PHASE6_MAX_C',
  'PHASE6_MAX_TIME_DELTA',
  'PHASE6_SPECIAL_CONSTANT_COUNT',
  'PHASE6_UPDATE_GHOST_STATE_FOR_ACTION_C',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeId(value, fallback = 'audit') {
  const normalized = String(value ?? fallback).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (normalized || fallback).slice(0, 96);
}

async function readJson(file, label = file) {
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error.message}`); }
  return parsed;
}

async function copySkeleton({ skeletonRoot, bundleRoot, source, destination }) {
  const from = path.join(skeletonRoot, source);
  const to = path.join(bundleRoot, destination);
  const bytes = await fs.readFile(from);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, bytes);
  return { source: destination, destination, sha256: sha256(bytes), bytes: bytes.length, skeleton: source };
}

function sourceBinding(request) {
  return {
    repository: request.source.repository,
    commit: request.source.commit,
    archiveSha256: request.source.archiveSha256 ?? null,
  };
}

export async function initializePhase6HarnessBundle({
  requestPath,
  runnerRoot,
  campaign = 'property',
  type = 'standard',
  bundleId = null,
} = {}) {
  if (!requestPath) throw new Error('Phase 6 harness init requires --request <request.json>');
  if (!runnerRoot) throw new Error('Phase 6 harness init requires runnerRoot');
  if (!Object.hasOwn(CAMPAIGN_CONFIG, campaign)) throw new Error(`Unsupported Phase 6 campaign: ${campaign}; use discovery, property, or targeted`);

  const request = validateDeepAssuranceRequestV2(await readJson(path.resolve(requestPath), 'request'));
  if (request.phaseId !== 'build-and-test') throw new Error('Phase 6 harness init requires a build-and-test request');

  const id = bundleId ?? `${safeId(request.campaignId)}-phase6-${safeId(type)}-${campaign}-v1`;
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) throw new Error(`Invalid generated/provided bundle id: ${id}`);

  const skeletonRoot = path.join(runnerRoot, V7_POLICY.phase6.skeletonRoot);
  const bundleRoot = path.join(runnerRoot, V7_POLICY.phase6.overlayRoot, id);
  try {
    await fs.lstat(bundleRoot);
    throw new Error(`Phase 6 harness bundle already exists: ${id}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(bundleRoot, { recursive: true });

  const files = [];
  files.push(await copySkeleton({
    skeletonRoot,
    bundleRoot,
    source: CAMPAIGN_CONFIG[campaign],
    destination: 'medusa.json',
  }));
  for (const [source, destination] of COMMON_SKELETONS) {
    files.push(await copySkeleton({ skeletonRoot, bundleRoot, source, destination }));
  }

  const manifest = {
    schemaVersion: 'phase6-audit-harness-overlay-v1',
    bundleId: id,
    generatedBy: 'v7:harness:init',
    skeletonKit: V7_POLICY.phase6.skeletonRoot,
    campaign,
    type,
    sourceBinding: sourceBinding(request),
    files: files.map(({ source, destination, sha256: digest, bytes, skeleton }) => ({
      source,
      destination,
      sha256: digest,
      bytes,
      skeleton,
    })),
  };
  await fs.writeFile(path.join(bundleRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    status: 'CREATED_REQUIRES_TARGET_AUTHORING',
    bundleId: id,
    bundleRoot,
    campaign,
    type,
    requestId: request.requestId,
    sourceBinding: manifest.sourceBinding,
    nextAction: 'EDIT_TARGET_SPECIFIC_PLACEHOLDERS_THEN_RUN_V7_HARNESS_VALIDATE',
    validationCommand: `npm run v7:harness:validate -- --bundle ${id} --request ${requestPath}`,
  };
}

function usableRpcLiteral(text) {
  const urls = String(text).match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  return urls.filter((url) => !url.includes('127.0.0.1') && !url.includes('localhost'));
}

function unresolvedMarkers(text) {
  return TARGET_PLACEHOLDERS.filter((marker) => String(text).includes(marker));
}

export async function validatePhase6HarnessBundle({ bundleId, runnerRoot, requestPath = null } = {}) {
  if (!runnerRoot) throw new Error('Phase 6 harness validation requires runnerRoot');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(bundleId ?? '')) throw new Error('Phase 6 harness validation requires a valid --bundle id');

  const bundleRoot = path.join(runnerRoot, V7_POLICY.phase6.overlayRoot, bundleId);
  const manifest = await readJson(path.join(bundleRoot, 'manifest.json'), 'Phase 6 harness manifest');
  const defects = [];
  if (manifest.schemaVersion !== 'phase6-audit-harness-overlay-v1') defects.push({ type: 'MANIFEST_SCHEMA', message: 'manifest schema must equal phase6-audit-harness-overlay-v1' });
  if (manifest.bundleId !== bundleId) defects.push({ type: 'BUNDLE_ID_MISMATCH', message: 'manifest bundleId does not match directory bundle id' });
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) defects.push({ type: 'EMPTY_MANIFEST', message: 'manifest files must be non-empty' });

  if (requestPath) {
    const request = validateDeepAssuranceRequestV2(await readJson(path.resolve(requestPath), 'request'));
    const expected = sourceBinding(request);
    if (JSON.stringify(manifest.sourceBinding ?? null) !== JSON.stringify(expected)) {
      defects.push({ type: 'SOURCE_BINDING_MISMATCH', expected, observed: manifest.sourceBinding ?? null });
    }
  }

  const destinations = new Set();
  const inventory = [];
  for (const [index, entry] of (manifest.files ?? []).entries()) {
    if (!entry || typeof entry !== 'object') {
      defects.push({ type: 'MANIFEST_ENTRY_INVALID', index });
      continue;
    }
    if (destinations.has(entry.destination)) defects.push({ type: 'DUPLICATE_DESTINATION', destination: entry.destination });
    destinations.add(entry.destination);
    const file = path.join(bundleRoot, entry.source ?? '');
    let bytes;
    try { bytes = await fs.readFile(file); }
    catch (error) {
      defects.push({ type: 'FILE_MISSING', source: entry.source, message: error.message });
      continue;
    }
    const digest = sha256(bytes);
    if (entry.sha256 && entry.sha256 !== digest) defects.push({ type: 'FILE_DIGEST_MISMATCH', source: entry.source, expected: entry.sha256, observed: digest });
    const text = bytes.toString('utf8');
    const urls = usableRpcLiteral(text);
    if (urls.length > 0) defects.push({ type: 'FORBIDDEN_RPC_LITERAL', source: entry.source, count: urls.length });
    const markers = unresolvedMarkers(text);
    if (markers.length > 0) defects.push({ type: 'TARGET_AUTHORING_REQUIRED', source: entry.source, markers });
    inventory.push({ source: entry.source, destination: entry.destination, sha256: digest, bytes: bytes.length });
  }

  for (const required of V7_POLICY.phase6.requiredRuntimeFiles) {
    if (!destinations.has(required)) defects.push({ type: 'REQUIRED_RUNTIME_FILE_MISSING', destination: required });
  }

  if (destinations.has('medusa.json')) {
    try {
      const medusa = await readJson(path.join(bundleRoot, 'medusa.json'), 'medusa.json');
      if (medusa?.fuzzing?.forkConfig?.forkModeEnabled !== true) defects.push({ type: 'MEDUSA_FORK_MODE_NOT_ENABLED' });
      const rpcUrl = medusa?.fuzzing?.forkConfig?.rpcUrl;
      if (rpcUrl !== 'PHASE6_RUNTIME_INJECTION_REQUIRED') defects.push({ type: 'MEDUSA_RPC_MUST_BE_RUNTIME_MARKER', observed: rpcUrl ?? null });
    } catch (error) {
      defects.push({ type: 'MEDUSA_CONFIG_INVALID', message: error.message });
    }
  }

  if (destinations.has('foundry.toml')) {
    const foundryText = await fs.readFile(path.join(bundleRoot, 'foundry.toml'), 'utf8');
    if (/\b(rpc_endpoints|eth_rpc_url|fork_url)\b\s*=/.test(foundryText)) defects.push({ type: 'FOUNDRY_CONFIG_SELECTS_RPC' });
  }

  const hardDefects = defects.filter((defect) => defect.type !== 'TARGET_AUTHORING_REQUIRED');
  const authoring = defects.filter((defect) => defect.type === 'TARGET_AUTHORING_REQUIRED');
  const identity = {
    schemaVersion: 'phase6-harness-validation-v1',
    bundleId,
    sourceBinding: manifest.sourceBinding ?? null,
    files: inventory.sort((a, b) => a.destination.localeCompare(b.destination)),
  };
  const bundleDigestSha256 = sha256(Buffer.from(JSON.stringify(identity)));
  const status = hardDefects.length > 0 ? 'INVALID' : authoring.length > 0 ? 'REQUIRES_TARGET_AUTHORING' : 'READY';
  return {
    status,
    bundleId,
    bundleRoot,
    bundleDigestSha256,
    hardDefects,
    authoringRequirements: authoring,
    inventory: identity.files,
    nextAction: status === 'READY' ? 'REFERENCE_BUNDLE_ID_IN_PHASE6_REQUEST' : status === 'REQUIRES_TARGET_AUTHORING' ? 'RESOLVE_LISTED_TARGET_PLACEHOLDERS' : 'REPAIR_BUNDLE',
  };
}
