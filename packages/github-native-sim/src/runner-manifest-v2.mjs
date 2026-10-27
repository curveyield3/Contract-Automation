import fs from 'node:fs/promises';
import path from 'node:path';
import { V2_AUTOMATION_RELEASE, V2_RUNNER_RELEASE } from './schema.mjs';
import { V7_POLICY } from './v7-policy.mjs';

export const V26_QUALIFIED_CAPABILITIES_V1 = Object.freeze({
  requestExtension: 'configuration.v26-v1',
  components: Object.freeze({
    'v26-result-components-v1': 'audit-v7-github-execution-evidence-v2',
    'v26-build-sbom-v1': 'audit-v7-build-sbom-v1',
    'v26-phase6-campaign-evidence-v1': 'audit-v7-phase6-campaign-evidence-v1',
    'v26-foundry-coverage-v1': 'audit-v7-foundry-coverage-v1',
    'v26-simulation-ledger-v1': 'audit-v7-simulation-lifecycle-ledger-v1',
    'v26-live-attestation-v1': 'audit-v7-live-deployment-attestation-v1',
    'v26-reproduction-v1': 'audit-v7-candidate-reproduction-v1',
  }),
  recipes: Object.freeze(['repeated-lifecycle-v1']),
});

export function buildRunnerManifestV2() {
  return {
    schemaVersion: 'curveyield3-v7-runner-manifest-v2',
    repository: 'curveyield3/Contract-Automation',
    processId: V7_POLICY.processId,
    requestSchema: V7_POLICY.requestSchema,
    profiles: Object.values(V7_POLICY.profiles),
    contractAutomationRelease: V2_AUTOMATION_RELEASE,
    runnerRelease: V2_RUNNER_RELEASE,
    activeWorkflows: {
      execution: V7_POLICY.workflows.execution,
      toolchainSetup: V7_POLICY.workflows.toolchainSetup,
    },
    toolchain: {
      slither: V7_POLICY.tools.slither,
      medusa: V7_POLICY.tools.medusa,
      forge: V7_POLICY.tools.forge,
      anvilPackage: V7_POLICY.tools.anvilPackage,
    },
    mutableRpc: {
      profile: V7_POLICY.mutableRpc.ethereumProfile,
      chain: V7_POLICY.mutableRpc.chain,
      chainId: V7_POLICY.mutableRpc.chainId,
      backendPolicy: V7_POLICY.mutableRpc.backendPolicy,
      requesterSuppliedRpcAllowed: V7_POLICY.mutableRpc.requesterSuppliedRpcAllowed,
    },
    phase6: {
      skeletonRoot: V7_POLICY.phase6.skeletonRoot,
      skeletonReadme: V7_POLICY.phase6.skeletonReadme,
      overlayKind: V7_POLICY.phase6.overlayKind,
      overlayRoot: V7_POLICY.phase6.overlayRoot,
      requiredRuntimeFiles: [...V7_POLICY.phase6.requiredRuntimeFiles],
      medusaBeforeFoundry: V7_POLICY.phase6.medusaBeforeFoundry,
      stagingPolicy: 'SINGLE_VERIFIED_SNAPSHOT_THEN_LOCAL_EXECUTION_COPY',
      rpcIdentityPolicy: V7_POLICY.phase6.rpcIdentityPolicy,
    },
    qualifiedCapabilities: {
      requestExtension: V26_QUALIFIED_CAPABILITIES_V1.requestExtension,
      components: { ...V26_QUALIFIED_CAPABILITIES_V1.components },
      recipes: [...V26_QUALIFIED_CAPABILITIES_V1.recipes],
    },
    commands: {
      execute: 'npm run v7:execute -- --request <request.json>',
      submit: 'npm run v7:submit -- --request <request.json>',
      harnessInit: 'npm run v7:harness:init -- --request <request.json>',
      harnessValidate: 'npm run v7:harness:validate -- --bundle <bundle-id> --request <request.json>',
      toolchainVerify: 'npm run v7:toolchain:verify',
      manifestCheck: 'npm run v7:manifest -- --check',
    },
    evidence: {
      schemaVersion: V7_POLICY.evidence.schemaVersion,
      root: V7_POLICY.evidence.root,
      terminalDispositionRequired: true,
    },
  };
}

export function serializeRunnerManifestV2() {
  return `${JSON.stringify(buildRunnerManifestV2(), null, 2)}\n`;
}

export async function writeRunnerManifestV2({ runnerRoot } = {}) {
  const destination = path.join(runnerRoot, 'process', 'RUNNER_MANIFEST.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, serializeRunnerManifestV2());
  return destination;
}

export async function checkRunnerManifestV2({ runnerRoot } = {}) {
  const destination = path.join(runnerRoot, 'process', 'RUNNER_MANIFEST.json');
  const expected = serializeRunnerManifestV2();
  let observed;
  try { observed = await fs.readFile(destination, 'utf8'); }
  catch (error) { return { status: 'FAIL', reason: error.message, destination }; }
  return observed === expected
    ? { status: 'PASS', destination }
    : { status: 'FAIL', reason: 'RUNNER_MANIFEST_DRIFT', destination };
}
