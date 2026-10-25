import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeepAssuranceRequestV2 } from '../src/schema.mjs';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isCurveYieldLiteP67Request, resolveCurveYieldLiteP67Anvil } from '../src/curveyield-lite-p67-v1.mjs';

function request() {
  return {
    schemaVersion: 'deep-assurance-github-request-v2',
    processId: 'audit-v7-independent-review',
    contractAutomationRelease: {
      repository: 'curveyield3/Contract-Automation',
      branch: 'recovery/v7-execution-layer-v1',
      commit: '612fa50264e587e3f24550bf4dae35719b04211c',
      contractVersion: 'contract-automation-v7-relocated-v1',
    },
    runnerRelease: {
      version: 'deep-assurance-github-bridge-v1',
      manifestSha256: '2bebd99bb8ae770eb2feca0de7dc7e54596127a0c768922189e907e6658773dc',
    },
    campaignId: 'curveyield-dex-fresh-audit-r1',
    assignmentId: 'reviewer-3L-P6_7',
    phaseId: 'lite-p67',
    gateId: 'P67',
    profileId: 'github-native-compile-v2',
    source: {
      repository: 'curveyield3/Audit-Controller',
      commit: 'c41958422daf46c3b929182f90e53b872cedada6',
      projectPath: 'CurveYield_DEX_Fresh_Audit_Package_2026-08-16/workspace/contracts-repo/CurveYield DEX',
      archivePath: 'staging/9aad3d30-2e47-4661-a88e-0bde262f5210.zip',
      archiveSha256: '526a729ce73d493f2ccbb568378a18dd1eec0788d0165e02dc5ceb773b9953ed',
    },
    configuration: {
      compilers: [{ language: 'solidity', version: '0.8.30' }],
      timeoutMinutes: 35,
      analysis: { slither: false, medusa: false, nativeFuzz: false },
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
      viaIR: false,
      actions: { kind: 'curveyield-lite-p67-v1', executionSet: 'retained-lite-v1' },
    },
    requestId: 'dar-11111111111111111111111111111111',
    requestDigest: '1'.repeat(64),
  };
}

test('admits only the exact CurveYield Lite P67 action envelope', () => {
  const admitted = validateDeepAssuranceRequestV2(request());
  assert.equal(isCurveYieldLiteP67Request(admitted), true);

  const wrong = request();
  wrong.configuration.actions.executionSet = 'full';
  assert.throws(() => validateDeepAssuranceRequestV2(wrong), /must equal retained-lite-v1/);

  const otherCampaign = request();
  otherCampaign.campaignId = 'other';
  assert.throws(() => validateDeepAssuranceRequestV2(otherCampaign), /exact CurveYield Lite P6-7 campaign/);
});

test('resolves and marks the pinned request-runtime Anvil wrapper executable', async () => {
  const anvilPath = await resolveCurveYieldLiteP67Anvil();
  assert.match(anvilPath, /node_modules\/@foundry-rs\/anvil\/bin\.mjs$/);
  await fs.access(anvilPath, fsConstants.X_OK);
});
