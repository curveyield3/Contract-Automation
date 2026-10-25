import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/browser-agent-watchdog.yml'), 'utf8');
const filter = workflow.match(/jq -e --arg wake "\$WAKE_ID" '([\s\S]*?)' >\/dev\/null; then/)?.[1];
assert.ok(filter, 'preflight jq filter must be present');

const valid = {
  schemaVersion: 'curveyield-browser-agent-watchdog-state-v1',
  wakeId: 'synthetic-v1', campaignId: 'synthetic-v1', phaseId: 'smoke',
  workerRole: 'reviewer', status: 'ACTIVE', chatUrl: '',
  idleMessage: 'SMOKE ONLY', observation: { assistantCount: 0 },
  gate: { mode: 'FULL_V26', repository: 'curveyield3/Audit-Controller',
    ref: 'main', statePath: '' }
};
const accepts = (state, wake = 'synthetic-v1') =>
  spawnSync('jq', ['-e', '--arg', 'wake', wake, filter],
    { input: JSON.stringify(state), encoding: 'utf8' }).status === 0;

test('scheduled target validation admits an exact inert active state', () => {
  assert.equal(accepts(valid), true);
});

test('malformed or stale target never reaches browser setup', () => {
  const cases = [
    { ...valid, status: 'COMPLETED_CANONICAL_GATE' },
    { ...valid, wakeId: 'another-wake' },
    { ...valid, schemaVersion: 'other' },
    { ...valid, campaignId: '' },
    { ...valid, workerRole: 'unknown' },
    { ...valid, chatUrl: 42 },
    { ...valid, idleMessage: null },
    { ...valid, gate: { ...valid.gate, mode: 'unknown' } },
    { ...valid, gate: { ...valid.gate, statePath: null } },
    { ...valid, observation: null },
    []
  ];
  for (const state of cases) assert.equal(accepts(state), false, JSON.stringify(state));
  assert.equal(accepts(valid, 'different-dispatched-id'), false);
  for (const name of ['Select optional Audit-Controller credential', 'Set up Node.js',
    'Set up isolated browser-agent runtime', 'Supervise agent for one watchdog sweep']) {
    assert.match(workflow, new RegExp('- name: ' + name +
      "\\n\\s+if: steps\\.target\\.outputs\\.valid == 'true'"));
  }
});

test('a state changed after discovery is revalidated before every sweep action', () => {
  const filters = [...workflow.matchAll(/jq -e --arg wake "\$WAKE_ID" '([\s\S]*?)' (?:>\/dev\/null|\/tmp\/watchdog-state\.json >\/dev\/null)/g)]
    .map((match) => match[1].trim().replace(/\s+/g, ' '));
  assert.equal(filters.length, 2);
  assert.equal(filters[0], filters[1]);
  assert.match(workflow, /fetch_state\(\) \{[\s\S]*\.wakeId==\$wake[\s\S]*\.status=="ACTIVE"[\s\S]*\|\| return 1/);
});
