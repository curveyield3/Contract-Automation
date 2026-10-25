import test from 'node:test';
import assert from 'node:assert/strict';
import { runGitHubNativeJob } from '../src/run-job-file.mjs';

const sourceCommit = '1'.repeat(40);

function request() {
  return {
    schemaVersion: 'deep-assurance-github-request-v2',
    processId: 'audit-v7-independent-review',
    contractAutomationRelease: {
      repository: 'curveyield3/Contract-Automation',
      branch: 'recovery/v7-execution-layer-v1',
      commit: '612fa50264e587e3f24550bf4dae35719b04211c',
      contractVersion: 'contract-automation-v7-relocated-v1'
    },
    runnerRelease: {
      version: 'deep-assurance-github-bridge-v1',
      manifestSha256: '2bebd99bb8ae770eb2feca0de7dc7e54596127a0c768922189e907e6658773dc'
    },
    campaignId: 'anvil-evidence-test',
    assignmentId: 'phase7-anvil-evidence-binding-v1',
    phaseId: 'fork-simulation-lifecycle',
    gateId: 'phase7-anvil-only',
    profileId: 'github-native-simulate-v2',
    source: {
      repository: 'curveyield3/Solo-Audit-Controller',
      commit: sourceCommit,
      projectPath: 'target'
    },
    configuration: {
      compilers: [{ language: 'solidity', version: '0.8.28' }],
      analysis: { slither: false, medusa: false, nativeFuzz: false },
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: true,
      timeoutMinutes: 20,
      deploymentGas: {
        deployableContracts: [{ sourceName: 'contracts/Vault.sol', contractName: 'Vault' }]
      },
      simulation: {
        chain: 'ethereum',
        block: 25817400,
        workflow: { steps: [{ action: 'mine', blocks: 1 }] }
      }
    },
    requestId: `dar-${'2'.repeat(32)}`,
    requestDigest: '3'.repeat(64)
  };
}

const checkoutSource = async () => ({ commit: sourceCommit, projectRoot: '/tmp/target', checkoutRoot: '/tmp/checkout' });
const buildProject = async () => ({
  status: 'completed',
  compilerVersion: '0.8.28',
  artifacts: [{
    sourceName: 'contracts/Vault.sol',
    contractName: 'Vault',
    abi: [],
    bytecode: '0x6000',
    gasEstimates: { creation: { totalCost: '12345' } }
  }]
});
const executeSimulationWorkflow = async () => ({
  steps: [{ index: 0, action: 'mine', status: 'completed' }],
  context: { deployments: {} }
});

test('Phase 7 rejects a non-Anvil fork engine identity', async () => {
  const result = await runGitHubNativeJob(request(), {
    checkoutSource,
    buildProject,
    environment: { ETHEREUM_FORK_RPC_URL: 'https://private-ethereum.invalid' },
    startSimulationEngine: async () => ({ engine: 'ganache', runtime: {}, aliases: {}, async close() {} }),
    executeSimulationWorkflow
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.simulation?.failureKind, 'FORK_ENGINE_POLICY_FAILURE');
  assert.match(result.error?.message ?? '', /Anvil/i);
});

test('Phase 7 records Anvil as durable simulation evidence', async () => {
  const result = await runGitHubNativeJob(request(), {
    checkoutSource,
    buildProject,
    environment: { ETHEREUM_FORK_RPC_URL: 'https://private-ethereum.invalid' },
    startSimulationEngine: async () => ({ engine: 'anvil', runtime: {}, aliases: {}, async close() {} }),
    executeSimulationWorkflow
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.simulation.engine, 'anvil');
});
