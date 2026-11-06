export const V7_POLICY = Object.freeze({
  processId: 'audit-v7-independent-review',
  requestSchema: 'deep-assurance-github-request-v2',
  profiles: Object.freeze({
    compile: 'github-native-compile-v2',
    simulate: 'github-native-simulate-v2',
  }),
  tools: Object.freeze({
    slither: '0.11.6',
    medusa: '1.5.1',
    forge: '1.7.1',
    anvilPackage: '1.7.1',
  }),
  workflows: Object.freeze({
    execution: '.github/workflows/audit-controller-execution.yml',
    toolchainSetup: '.github/actions/setup-v7-toolchain/action.yml',
  }),
  mutableRpc: Object.freeze({
    ethereumProfile: 'ETHEREUM_FORK_RPC_URL',
    chain: 'ethereum',
    chainId: 1,
    backendPolicy: 'LOCAL_EPHEMERAL_ANVIL_WITH_UPSTREAM_FORK_RPC',
    requesterSuppliedRpcAllowed: false,
  }),
  phase6: Object.freeze({
    overlayKind: 'runner-owned-audit-overlay-v1',
    overlayRoot: 'packages/github-native-sim/audit-harnesses',
    skeletonRoot: 'packages/github-native-sim/harness-skeletons-v2',
    skeletonReadme: 'packages/github-native-sim/harness-skeletons-v2/README_v2.md',
    medusaBeforeFoundry: true,
    requiredRuntimeFiles: Object.freeze(['medusa.json', 'foundry.toml']),
    rpcIdentityPolicy: 'ONE_NORMALIZED_RPC_SESSION_FOR_PREFLIGHT_MEDUSA_AND_FOUNDRY',
  }),
  evidence: Object.freeze({
    schemaVersion: 'audit-v7-github-execution-evidence-v2',
    root: '.audit-evidence/v7-execution',
  }),
  dispositions: Object.freeze({
    pass: 'PASS',
    findings: 'FINDINGS',
    harnessRequired: 'HARNESS_AUTHORING_REQUIRED',
    runnerRepair: 'RUNNER_REPAIR_REBIND',
    recipeGap: 'RECIPE_GAP',
    infrastructureBlocked: 'INFRASTRUCTURE_BLOCKED',
    executionFailed: 'EXECUTION_FAILED',
  }),
});

export function phase6HarnessRecoveryCommand(requestPath = '<request.json>') {
  return `npm run v7:harness:init -- --request ${requestPath}`;
}

export function executionRecoveryCommand(requestPath = '<request.json>') {
  return `npm run v7:execute -- --request ${requestPath}`;
}
