import test from 'node:test';
import assert from 'node:assert/strict';
import { runMedusaAnalysis } from '../src/analysis.mjs';

const input = {
  projectRoot: '/tmp/project',
  version: '1.5.1',
  sourceCommit: '1'.repeat(40),
  rawArtifactRef: 'github-actions://curveyield3/Contract-Automation/qualification/medusa-smoke/noTests/raw.txt',
  rpcUrl: 'http://127.0.0.1:18545',
  rpcBlock: 25821826,
  rpcBlockHash: `0x${'2'.repeat(64)}`,
  rpcProfile: 'SIM_ARCHIVE_PRIMARY_ETHEREUM_01'
};

const noTestsStdout = `⇾ Reading the configuration file at: /tmp/noTests/medusa.json\n⇾ Compiling targets with crytic-compile\n⇾ Finished setting up test chain\n⇾ Creating corpus...\n⇾ Fuzzing with 1 workers\nerror Failed to start fuzzer\n‣ no assertion, property, optimization, or custom tests were found to fuzz\n`;

test('real Medusa 1.5.1 exit-6 no-tests output is typed as NO_TESTS_DISCOVERED and preserves raw evidence', async () => {
  const results = [
    { exitCode: 0, stdout: 'medusa version 1.5.1\n', stderr: '' },
    { exitCode: 6, stdout: noTestsStdout, stderr: '' }
  ];

  const result = await runMedusaAnalysis(input, { runCommand: async () => results.shift() });

  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.failureKind, 'NO_TESTS_DISCOVERED');
  assert.equal(result.componentStatus, 'COMPLETED_WITH_FAILURES');
  assert.equal(result.campaign.status, 'no_tests');
  assert.equal(result.campaign.properties.length, 0);
  assert.equal(result.rawOutput.exitCode, 6);
  assert.match(result.rawOutput.stdout, /no assertion, property, optimization, or custom tests were found to fuzz/);
});
