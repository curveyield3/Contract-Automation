const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^dar-[0-9a-f]{32}$/;
const PROFILES = new Set(['github-native-compile-v2', 'github-native-simulate-v2']);
const STATUSES = new Set(['PASSED', 'FAILED']);
const CONTINUITY = new Set(['COMPLETE_EVIDENCE', 'CONTINUE_WITH_LIMITATION']);
const COMPONENT_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED']);

export class DeepAssuranceResultValidationError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'DeepAssuranceResultValidationError';
    this.path = path;
  }
}

function fail(path, message) { throw new DeepAssuranceResultValidationError(path, message); }
function obj(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  return value;
}
function str(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}
function integer(value, path) {
  if (!Number.isInteger(value) || value < 0) fail(path, 'must be a non-negative integer');
  return value;
}
function hash(value, path) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(path, 'must be a 64-hex SHA-256');
  return value;
}
function commit(value, path) {
  if (typeof value !== 'string' || !COMMIT.test(value)) fail(path, 'must be a 40-hex commit');
  return value;
}
function requestId(value, path) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) fail(path, 'must be dar- plus 32 lowercase hex characters');
  return value;
}
function repository(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) fail(path, 'must be owner/repository');
}
function safePath(value, path) {
  str(value, path);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized === '..' || normalized.includes('../') || normalized.includes('/./')) fail(path, 'must be repository-relative');
}
function githubActionsRef(value, path) {
  if (typeof value !== 'string' || !value.startsWith('github-actions://')) fail(path, 'must be a github-actions:// reference');
}

function validateSource(source) {
  obj(source, 'source');
  repository(source.repository, 'source.repository');
  commit(source.commit, 'source.commit');
  safePath(source.projectPath, 'source.projectPath');
}

function validateArtifactRef(ref, i) {
  obj(ref, `artifactRefs[${i}]`);
  str(ref.name, `artifactRefs[${i}].name`);
  githubActionsRef(ref.ref, `artifactRefs[${i}].ref`);
  hash(ref.sha256, `artifactRefs[${i}].sha256`);
}

function validateEvidenceRef(ref, i) {
  obj(ref, `evidenceRefs[${i}]`);
  str(ref.class, `evidenceRefs[${i}].class`);
  githubActionsRef(ref.ref, `evidenceRefs[${i}].ref`);
  hash(ref.sha256, `evidenceRefs[${i}].sha256`);
  commit(ref.sourceCommit, `evidenceRefs[${i}].sourceCommit`);
}

function validateControllerEvidence(c, result) {
  obj(c, 'controllerEvidence');
  if (c.class !== 'deep-assurance-execution-result') fail('controllerEvidence.class', 'must equal deep-assurance-execution-result');
  githubActionsRef(c.ref, 'controllerEvidence.ref');
  hash(c.sha256, 'controllerEvidence.sha256');
  commit(c.sourceCommit, 'controllerEvidence.sourceCommit');
  if (c.sourceCommit !== result.source.commit) fail('controllerEvidence.sourceCommit', 'must equal source.commit');
  if (c.profileId !== result.profileId) fail('controllerEvidence.profileId', 'must equal profileId');
  if (c.requestId !== result.requestId) fail('controllerEvidence.requestId', 'must equal requestId');
  if (c.requestDigest !== result.requestDigest) fail('controllerEvidence.requestDigest', 'must equal requestDigest');
  if (c.runnerManifestSha256 !== result.runnerManifestSha256) fail('controllerEvidence.runnerManifestSha256', 'must equal runnerManifestSha256');
  githubActionsRef(c.artifactManifestRef, 'controllerEvidence.artifactManifestRef');
  if (c.artifactManifestSha256 !== result.artifactManifestSha256) fail('controllerEvidence.artifactManifestSha256', 'must equal artifactManifestSha256');
  if (c.outputSha256 !== result.outputSha256) fail('controllerEvidence.outputSha256', 'must equal outputSha256');
  if (c.sha256 !== result.outputSha256) fail('controllerEvidence.sha256', 'must equal outputSha256');
  if (!COMPONENT_STATUSES.has(c.componentStatus)) fail('controllerEvidence.componentStatus', 'has unsupported value');
  integer(c.failedStepCount, 'controllerEvidence.failedStepCount');
  integer(c.componentFailureCount, 'controllerEvidence.componentFailureCount');
  if (c.failedStepCount !== result.failedStepCount) fail('controllerEvidence.failedStepCount', 'must equal failedStepCount');
  if (c.componentFailureCount !== result.componentFailureCount) fail('controllerEvidence.componentFailureCount', 'must equal componentFailureCount');
}

export function validateDeepAssuranceResultV1(input) {
  obj(input, '$');
  if (input.schemaVersion !== 'deep-assurance-contract-automation-result-v1') fail('schemaVersion', 'must equal deep-assurance-contract-automation-result-v1');
  requestId(input.requestId, 'requestId');
  hash(input.requestDigest, 'requestDigest');
  validateSource(input.source);
  if (!PROFILES.has(input.profileId)) fail('profileId', 'has unsupported value');
  hash(input.runnerManifestSha256, 'runnerManifestSha256');
  if (!STATUSES.has(input.status)) fail('status', 'must be PASSED or FAILED');
  integer(input.failedStepCount, 'failedStepCount');
  if (!Array.isArray(input.failedSteps)) fail('failedSteps', 'must be an array');
  if (input.failedStepCount !== input.failedSteps.length) fail('failedStepCount', 'must equal failedSteps.length');
  integer(input.componentFailureCount, 'componentFailureCount');
  integer(input.analysisComponentFailureCount, 'analysisComponentFailureCount');
  integer(input.toolchainComponentFailureCount, 'toolchainComponentFailureCount');
  if (input.analysisComponentFailureCount > input.componentFailureCount) fail('analysisComponentFailureCount', 'cannot exceed componentFailureCount');
  if (input.toolchainComponentFailureCount > input.componentFailureCount) fail('toolchainComponentFailureCount', 'cannot exceed componentFailureCount');
  if (!CONTINUITY.has(input.continuityDisposition)) fail('continuityDisposition', 'has unsupported value');
  if (!Array.isArray(input.artifactRefs) || input.artifactRefs.length === 0) fail('artifactRefs', 'must be a non-empty array');
  input.artifactRefs.forEach(validateArtifactRef);
  hash(input.artifactManifestSha256, 'artifactManifestSha256');
  if (input.artifactRefs[0].sha256 !== input.artifactManifestSha256) fail('artifactManifestSha256', 'must match the artifact manifest reference');
  hash(input.outputSha256, 'outputSha256');
  if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) fail('evidenceRefs', 'must be a non-empty array');
  input.evidenceRefs.forEach(validateEvidenceRef);
  validateControllerEvidence(input.controllerEvidence, input);
  obj(input.toolVersions, 'toolVersions');
  obj(input.requestedToolVersions, 'requestedToolVersions');
  return structuredClone(input);
}
