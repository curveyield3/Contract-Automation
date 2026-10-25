import { validateWorkflow } from '../../protocol/src/index.mjs';
import { V7_POLICY } from './v7-policy.mjs';

export const V2_AUTOMATION_RELEASE = Object.freeze({
  repository: 'curveyield3/Contract-Automation',
  branch: 'recovery/v7-execution-layer-v1',
  commit: '612fa50264e587e3f24550bf4dae35719b04211c',
  contractVersion: 'contract-automation-v7-relocated-v1'
});

export const V2_RUNNER_RELEASE = Object.freeze({
  version: 'deep-assurance-github-bridge-v1',
  manifestSha256: '2bebd99bb8ae770eb2feca0de7dc7e54596127a0c768922189e907e6658773dc'
});

export const HISTORICAL_V7_RELEASE_PROVENANCE = Object.freeze({
  repository: 'CurveYield/contract-automation',
  requestBaseCommit: 'ad11d7d5a623c1411cbabb4bb0cd9acf7975bce8',
  trustedRunnerCommit: '999a44d2ecb9deae844cd15669224019e1222171',
  trustedManifestSha256: 'd32cfca35524606a5c85e98fb3dec1bba58bff8a4bc73466ccef496ceab79734',
  status: 'HISTORICAL_DELETED_ORGANIZATION_PROVENANCE_ONLY'
});

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion', 'processId', 'contractAutomationRelease', 'runnerRelease',
  'campaignId', 'assignmentId', 'phaseId', 'gateId', 'profileId', 'source',
  'configuration', 'requestId', 'requestDigest'
]);
const CONFIGURATION_FIELDS = new Set([
  'compilers', 'timeoutMinutes', 'analysis', 'optimizer', 'evmVersion', 'viaIR',
  'deploymentGas', 'simulation', 'build', 'sbom', 'coverage', 'properties', 'harness', 'actions'
]);
const PROFILE_IDS = new Set(Object.values(V7_POLICY.profiles));
const V7_FORK_CHAINS = new Set(['ethereum', 'base', 'katana']);
const FORBIDDEN_DYNAMIC_KEYS = new Set(['command', 'shell', 'script', 'npmScript', 'rawTransaction', 'signedTransaction', 'rpc', 'rpcUrl', 'privateKey', 'privateKeys', 'mnemonic', 'seed', 'secret']);

export class DeepAssuranceRequestValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'DeepAssuranceRequestValidationError';
    this.path = path;
  }
}

function fail(path, message) {
  throw new DeepAssuranceRequestValidationError(path, message);
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}

function string(value, path, { min = 1, max = 512, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(path, `must be a string between ${min} and ${max} characters`);
  if (pattern && !pattern.test(value)) fail(path, 'has invalid format');
  return value;
}

function exactObject(value, expected, path) {
  object(value, path);
  const keys = Object.keys(value);
  const expectedKeys = Object.keys(expected);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key))) fail(path, 'contains unexpected fields');
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail(`${path}.${key}`, `must equal ${expectedValue}`);
  }
}

function scanForbiddenDynamicKeys(value, path = 'configuration') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenDynamicKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DYNAMIC_KEYS.has(key)) fail(`${path}.${key}`, 'requester-controlled execution field is forbidden');
    scanForbiddenDynamicKeys(child, `${path}.${key}`);
  }
}

function safeRelativePath(value, pathLabel, { requireZip = false } = {}) {
  const input = string(value, pathLabel, { max: 512 });
  const normalized = input.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized === '..' || normalized.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    fail(pathLabel, 'must be a safe repository-relative path');
  }
  if (requireZip && !normalized.toLowerCase().endsWith('.zip')) fail(pathLabel, 'must identify a .zip archive');
  return normalized;
}

function validateSource(source) {
  object(source, 'source');
  const allowed = new Set(['repository', 'commit', 'projectPath', 'archivePath', 'archiveSha256']);
  for (const key of Object.keys(source)) if (!allowed.has(key)) fail(`source.${key}`, 'is not allowed');
  string(source.repository, 'source.repository', { max: 200, pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ });
  string(source.commit, 'source.commit', { min: 40, max: 40, pattern: /^[0-9a-f]{40}$/ });
  safeRelativePath(source.projectPath, 'source.projectPath');

  const archiveRequested = source.archivePath !== undefined || source.archiveSha256 !== undefined;
  if (archiveRequested) {
    safeRelativePath(source.archivePath, 'source.archivePath', { requireZip: true });
    string(source.archiveSha256, 'source.archiveSha256', { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ });
  }
}

function validateCompilers(compilers) {
  if (!Array.isArray(compilers) || compilers.length === 0) fail('configuration.compilers', 'must be a non-empty array');
  for (const [index, compiler] of compilers.entries()) {
    object(compiler, `configuration.compilers[${index}]`);
    const allowed = new Set(['language', 'version']);
    for (const key of Object.keys(compiler)) if (!allowed.has(key)) fail(`configuration.compilers[${index}].${key}`, 'is not allowed');
    if (!['solidity', 'vyper'].includes(compiler.language)) fail(`configuration.compilers[${index}].language`, 'must be solidity or vyper');
    string(compiler.version, `configuration.compilers[${index}].version`, { max: 80 });
  }
}

function validateNativeFuzz(nativeFuzz) {
  if (nativeFuzz === false || nativeFuzz === undefined) return;
  object(nativeFuzz, 'configuration.analysis.nativeFuzz');
  const allowed = new Set(['enabled', 'fuzzRuns', 'recoverableExitCodes']);
  for (const key of Object.keys(nativeFuzz)) if (!allowed.has(key)) fail(`configuration.analysis.nativeFuzz.${key}`, 'is not allowed');
  if ('enabled' in nativeFuzz && typeof nativeFuzz.enabled !== 'boolean') fail('configuration.analysis.nativeFuzz.enabled', 'must be boolean');
  if ('fuzzRuns' in nativeFuzz && (!Number.isInteger(nativeFuzz.fuzzRuns) || nativeFuzz.fuzzRuns < 1 || nativeFuzz.fuzzRuns > 1000000)) fail('configuration.analysis.nativeFuzz.fuzzRuns', 'must be an integer from 1 to 1,000,000');
  if ('recoverableExitCodes' in nativeFuzz && (!Array.isArray(nativeFuzz.recoverableExitCodes) || nativeFuzz.recoverableExitCodes.some((value) => !Number.isInteger(value)))) fail('configuration.analysis.nativeFuzz.recoverableExitCodes', 'must contain only integers');
}

function validateAnalysis(analysis) {
  if (analysis === undefined) return;
  object(analysis, 'configuration.analysis');
  const allowed = new Set(['slither', 'medusa', 'nativeFuzz']);
  for (const key of Object.keys(analysis)) if (!allowed.has(key)) fail(`configuration.analysis.${key}`, 'is not allowed');
  if (analysis.slither !== undefined && analysis.slither !== false) {
    object(analysis.slither, 'configuration.analysis.slither');
    for (const key of Object.keys(analysis.slither)) if (key !== 'version') fail(`configuration.analysis.slither.${key}`, 'is not allowed');
  }
  if (analysis.medusa !== undefined && analysis.medusa !== false) {
    object(analysis.medusa, 'configuration.analysis.medusa');
    const allowed = new Set(['version', 'frozenBlockNumber', 'frozenBlockHash']);
    for (const key of Object.keys(analysis.medusa)) if (!allowed.has(key)) fail(`configuration.analysis.medusa.${key}`, 'is not allowed');
    const hasFrozenNumber = Object.prototype.hasOwnProperty.call(analysis.medusa, 'frozenBlockNumber');
    const hasFrozenHash = Object.prototype.hasOwnProperty.call(analysis.medusa, 'frozenBlockHash');
    if (hasFrozenNumber !== hasFrozenHash) fail('configuration.analysis.medusa', 'frozenBlockNumber and frozenBlockHash must be provided together');
    if (hasFrozenNumber) {
      if (!Number.isSafeInteger(analysis.medusa.frozenBlockNumber) || analysis.medusa.frozenBlockNumber < 0) fail('configuration.analysis.medusa.frozenBlockNumber', 'must be a non-negative safe integer');
      string(analysis.medusa.frozenBlockHash, 'configuration.analysis.medusa.frozenBlockHash', { min: 66, max: 66, pattern: /^0x[0-9a-fA-F]{64}$/ });
    }
  }
  validateNativeFuzz(analysis.nativeFuzz);
}

function validateHarness(harness, input) {
  if (harness === undefined) return;
  object(harness, 'configuration.harness');
  const keys = Object.keys(harness);
  if (harness.kind === V7_POLICY.phase6.overlayKind) {
    if (input.phaseId !== 'build-and-test') fail('configuration.harness.kind', 'Phase 6 audit overlays are allowed only for build-and-test');
    const allowed = new Set(['kind', 'bundleId']);
    for (const key of keys) if (!allowed.has(key)) fail(`configuration.harness.${key}`, 'is not allowed for Phase 6 audit overlay');
    string(harness.bundleId, 'configuration.harness.bundleId', { max: 128, pattern: /^[a-z0-9][a-z0-9._-]{0,127}$/ });
    return;
  }
  if ('recipeId' in harness) {
    const allowed = new Set(['recipeId']);
    for (const key of keys) if (!allowed.has(key)) fail(`configuration.harness.${key}`, 'is not allowed for Phase 7 lifecycle recipe');
    if (input.phaseId !== 'fork-simulation-lifecycle') fail('configuration.harness.recipeId', 'lifecycle recipe is allowed only for fork-simulation-lifecycle');
    string(harness.recipeId, 'configuration.harness.recipeId', { max: 160 });
    return;
  }
  fail('configuration.harness', `must be either {kind:${V7_POLICY.phase6.overlayKind},bundleId} or {recipeId}`);
}

function validateDeploymentGas(deploymentGas, { required = false } = {}) {
  if (deploymentGas === undefined) {
    if (required) fail('configuration.deploymentGas', 'is required for Phase 7');
    return;
  }
  object(deploymentGas, 'configuration.deploymentGas');
  for (const key of Object.keys(deploymentGas)) if (key !== 'deployableContracts') fail(`configuration.deploymentGas.${key}`, 'is not allowed');
  if (!Array.isArray(deploymentGas.deployableContracts) || deploymentGas.deployableContracts.length === 0) fail('configuration.deploymentGas.deployableContracts', 'must be a non-empty frozen deployable-contract inventory');
  const seen = new Set();
  for (const [index, item] of deploymentGas.deployableContracts.entries()) {
    object(item, `configuration.deploymentGas.deployableContracts[${index}]`);
    const allowed = new Set(['sourceName', 'contractName']);
    for (const key of Object.keys(item)) if (!allowed.has(key)) fail(`configuration.deploymentGas.deployableContracts[${index}].${key}`, 'is not allowed');
    string(item.sourceName, `configuration.deploymentGas.deployableContracts[${index}].sourceName`, { max: 512 });
    string(item.contractName, `configuration.deploymentGas.deployableContracts[${index}].contractName`, { max: 200 });
    const key = `${item.sourceName}:${item.contractName}`;
    if (seen.has(key)) fail(`configuration.deploymentGas.deployableContracts[${index}]`, `duplicate deployable contract ${key}`);
    seen.add(key);
  }
}

function validateSimulation(simulation, { required = false } = {}) {
  if (simulation === undefined) {
    if (required) fail('configuration.simulation', 'is required for Phase 7');
    return;
  }
  object(simulation, 'configuration.simulation');
  const allowed = new Set(['chain', 'block', 'workflow']);
  for (const key of Object.keys(simulation)) if (!allowed.has(key)) fail(`configuration.simulation.${key}`, 'is not allowed');
  if (!V7_FORK_CHAINS.has(simulation.chain)) fail('configuration.simulation.chain', 'must be ethereum, base or katana for the V7 pinned-fork lifecycle');
  if (!Number.isSafeInteger(simulation.block) || simulation.block < 0) fail('configuration.simulation.block', 'must be a pinned non-negative integer block number');
  try {
    validateWorkflow(simulation.workflow);
  } catch (error) {
    fail(error?.path ? `configuration.simulation${String(error.path).replace(/^\$\.workflow/, '.workflow')}` : 'configuration.simulation.workflow', error?.message ?? 'invalid allowlisted workflow');
  }
}

function validateActions(actions, input) {
  if (actions === undefined) return;
  object(actions, 'configuration.actions');
  const allowed = new Set(['kind', 'executionSet']);
  for (const key of Object.keys(actions)) if (!allowed.has(key)) fail(`configuration.actions.${key}`, 'is not allowed');
  if (input.campaignId !== 'curveyield-dex-fresh-audit-r1' || input.phaseId !== 'lite-p67') fail('configuration.actions', 'is allowed only for the exact CurveYield Lite P6-7 campaign');
  if (actions.kind !== 'curveyield-lite-p67-v1') fail('configuration.actions.kind', 'must equal curveyield-lite-p67-v1');
  if (actions.executionSet !== 'retained-lite-v1') fail('configuration.actions.executionSet', 'must equal retained-lite-v1');
}

function validateConfiguration(configuration, input) {
  object(configuration, 'configuration');
  for (const key of Object.keys(configuration)) if (!CONFIGURATION_FIELDS.has(key)) fail(`configuration.${key}`, 'is not allowed');
  scanForbiddenDynamicKeys(configuration);
  validateCompilers(configuration.compilers);
  validateAnalysis(configuration.analysis);
  validateHarness(configuration.harness, input);
  validateActions(configuration.actions, input);
  if ('timeoutMinutes' in configuration) {
    const value = configuration.timeoutMinutes;
    if (!Number.isInteger(value) || value < 1 || value > 35) fail('configuration.timeoutMinutes', 'must be an integer from 1 to 35');
  }
  if ('optimizer' in configuration) {
    object(configuration.optimizer, 'configuration.optimizer');
    const allowed = new Set(['enabled', 'runs']);
    for (const key of Object.keys(configuration.optimizer)) if (!allowed.has(key)) fail(`configuration.optimizer.${key}`, 'is not allowed');
    if (typeof configuration.optimizer.enabled !== 'boolean' || !Number.isInteger(configuration.optimizer.runs) || configuration.optimizer.runs < 0 || configuration.optimizer.runs > 1000000) fail('configuration.optimizer', 'requires boolean enabled and runs from 0 to 1,000,000');
  }
  if ('evmVersion' in configuration && configuration.evmVersion !== null) string(configuration.evmVersion, 'configuration.evmVersion', { max: 40 });
  if ('viaIR' in configuration && typeof configuration.viaIR !== 'boolean') fail('configuration.viaIR', 'must be boolean');
  const phase7 = input.phaseId === 'fork-simulation-lifecycle';
  validateDeploymentGas(configuration.deploymentGas, { required: phase7 });
  validateSimulation(configuration.simulation, { required: phase7 });
}

export function validateDeepAssuranceRequestV2(input) {
  object(input, '$');
  for (const key of Object.keys(input)) if (!TOP_LEVEL_FIELDS.has(key)) fail(key, 'is not allowed');
  for (const key of TOP_LEVEL_FIELDS) if (!(key in input)) fail(key, 'is required');

  if (input.schemaVersion !== V7_POLICY.requestSchema) fail('schemaVersion', `must equal ${V7_POLICY.requestSchema}`);
  if (input.processId !== V7_POLICY.processId) fail('processId', `must equal ${V7_POLICY.processId}`);
  exactObject(input.contractAutomationRelease, V2_AUTOMATION_RELEASE, 'contractAutomationRelease');
  exactObject(input.runnerRelease, V2_RUNNER_RELEASE, 'runnerRelease');

  string(input.campaignId, 'campaignId', { max: 160 });
  string(input.assignmentId, 'assignmentId', { max: 200 });
  string(input.phaseId, 'phaseId', { max: 100 });
  string(input.gateId, 'gateId', { max: 160 });
  if (!PROFILE_IDS.has(input.profileId)) fail('profileId', `must be ${[...PROFILE_IDS].join(' or ')}`);
  validateSource(input.source);
  validateConfiguration(input.configuration, input);
  string(input.requestId, 'requestId', { min: 36, max: 36, pattern: /^dar-[0-9a-f]{32}$/ });
  string(input.requestDigest, 'requestDigest', { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ });

  return structuredClone(input);
}
