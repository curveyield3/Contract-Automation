import { createHash } from 'node:crypto';

function fail(message) { throw new Error(`V8 deployment gas evidence: ${message}`); }
function qualified(item) { return `${item.sourceName}:${item.contractName}`; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function sha256(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function exactDigits(value) { return typeof value === 'string' && /^[0-9]+$/.test(value); }

function validateContractIdentity(item, label) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label} must be an object`);
  if (typeof item.sourceName !== 'string' || !item.sourceName) fail(`${label}.sourceName is required`);
  if (typeof item.contractName !== 'string' || !item.contractName) fail(`${label}.contractName is required`);
}

function validateConfigurationIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) fail('configurationIdentity must be an object');
  if (typeof identity.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(identity.sourceCommit)) fail('configurationIdentity.sourceCommit must be 40 lowercase hex characters');
  if (!identity.compiler || typeof identity.compiler !== 'object') fail('configurationIdentity.compiler is required');
  if (typeof identity.compiler.version !== 'string' || !identity.compiler.version) fail('configurationIdentity compiler version is required');
  if (typeof identity.compiler.language !== 'string' || !identity.compiler.language) fail('configurationIdentity compiler language is required');
  if (identity.optimizer !== undefined && (identity.optimizer === null || typeof identity.optimizer !== 'object' || Array.isArray(identity.optimizer))) fail('configurationIdentity.optimizer must be an object when present');
  if (identity.evmVersion !== undefined && identity.evmVersion !== null && typeof identity.evmVersion !== 'string') fail('configurationIdentity.evmVersion must be a string or null');
  if (identity.viaIR !== undefined && typeof identity.viaIR !== 'boolean') fail('configurationIdentity.viaIR must be boolean when present');
}

export function normalizeDeploymentGasEvidence({ deployableContracts, artifacts, configurationIdentity }) {
  if (!Array.isArray(deployableContracts) || deployableContracts.length === 0) fail('deployableContracts must be a non-empty frozen inventory');
  if (!Array.isArray(artifacts)) fail('artifacts must be an array');
  validateConfigurationIdentity(configurationIdentity);

  const frozen = new Set();
  for (const [index, item] of deployableContracts.entries()) {
    validateContractIdentity(item, `deployableContracts[${index}]`);
    const key = qualified(item);
    if (frozen.has(key)) fail(`duplicate deployable contract: ${key}`);
    frozen.add(key);
  }

  const artifactMap = new Map();
  for (const [index, artifact] of artifacts.entries()) {
    validateContractIdentity(artifact, `artifacts[${index}]`);
    const key = qualified(artifact);
    if (artifactMap.has(key)) fail(`duplicate compiler artifact: ${key}`);
    artifactMap.set(key, artifact);
  }

  const rows = deployableContracts.map((item) => {
    const key = qualified(item);
    const artifact = artifactMap.get(key);
    if (!artifact) {
      return {
        sourceName: item.sourceName,
        contractName: item.contractName,
        qualifiedName: key,
        status: 'UNAVAILABLE',
        deploymentGasEstimate: null,
        codeDepositCost: null,
        executionCost: null,
        reason: 'ARTIFACT_NOT_PRESENT_IN_ACCEPTED_COMPILER_OUTPUT',
      };
    }
    const creation = artifact?.gasEstimates?.creation;
    if (!creation) {
      return {
        sourceName: item.sourceName,
        contractName: item.contractName,
        qualifiedName: key,
        status: 'UNAVAILABLE',
        deploymentGasEstimate: null,
        codeDepositCost: null,
        executionCost: null,
        reason: 'COMPILER_GAS_ESTIMATE_UNAVAILABLE',
      };
    }
    if (!exactDigits(creation.totalCost)) {
      return {
        sourceName: item.sourceName,
        contractName: item.contractName,
        qualifiedName: key,
        status: 'UNAVAILABLE',
        deploymentGasEstimate: null,
        codeDepositCost: exactDigits(creation.codeDepositCost) ? creation.codeDepositCost : null,
        executionCost: exactDigits(creation.executionCost) ? creation.executionCost : null,
        reason: 'NON_NUMERIC_COMPILER_GAS_ESTIMATE',
      };
    }
    return {
      sourceName: item.sourceName,
      contractName: item.contractName,
      qualifiedName: key,
      status: 'AVAILABLE',
      deploymentGasEstimate: creation.totalCost,
      codeDepositCost: exactDigits(creation.codeDepositCost) ? creation.codeDepositCost : null,
      executionCost: exactDigits(creation.executionCost) ? creation.executionCost : null,
      reason: null,
    };
  });

  return {
    schemaVersion: 'audit-v7-contract-deployment-gas-evidence-v1',
    reportTemplate: 'Contract_Deployment_Gas_Report_v1.md',
    sourceCommit: configurationIdentity.sourceCommit,
    configurationIdentity: structuredClone(configurationIdentity),
    configurationIdentitySha256: sha256(configurationIdentity),
    deployableContractCount: deployableContracts.length,
    availableEstimateCount: rows.filter((row) => row.status === 'AVAILABLE').length,
    unavailableEstimateCount: rows.filter((row) => row.status === 'UNAVAILABLE').length,
    rows,
  };
}
