import test from 'node:test';
import assert from 'node:assert/strict';
import { runMedusaAnalysis } from '../src/analysis.mjs';

const input = {
  projectRoot: '/tmp/project',
  version: '1.5.1',
  sourceCommit: '1'.repeat(40),
  rawArtifactRef: 'github-actions://curveyield3/Contract-Automation/runs/1/artifacts/v7-execution/medusa/raw.txt',
  rpcUrl: 'http://127.0.0.1:18545',
  rpcBlock: 25817400,
  rpcBlockHash: `0x${'2'.repeat(64)}`,
  rpcProfile: 'SIM_ARCHIVE_PRIMARY_ETHEREUM_01'
};

test('Medusa parser failure remains terminal evidence with raw stdout and stderr preserved', async () => {
  const results = [
    { exitCode: 0, stdout: 'medusa version 1.5.1\n', stderr: '' },
    { exitCode: 0, stdout: 'REAL_MEDUSA_OUTPUT_NOT_YET_RECOGNIZED\n', stderr: 'REAL_MEDUSA_STDERR_SENTINEL\n' }
  ];

  const result = await runMedusaAnalysis(input, {
    runCommand: async () => results.shift()
  });

  assert.equal(result.backend, 'medusa');
  assert.equal(result.terminal, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureKind, 'EVIDENCE_PARSE_FAILURE');
  assert.equal(result.componentStatus, 'FAILED');
  assert.equal(result.continuationDisposition, 'CONTINUE_WITH_LIMITATION');
  assert.match(result.rawOutput.stdout, /REAL_MEDUSA_OUTPUT_NOT_YET_RECOGNIZED/);
  assert.match(result.rawOutput.stderr, /REAL_MEDUSA_STDERR_SENTINEL/);
  assert.equal(result.rawOutput.stdout.includes(input.rpcUrl), false);
});
