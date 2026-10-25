import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('authority zip sync v2 keeps deterministic packaging and runs only on explicit request', () => {
  const workflow=fs.readFileSync('.github/workflows/sync-lite-authority-zip-v2.yml','utf8');
  const script=fs.readFileSync('scripts/sync-lite-authority-zip-v1.py','utf8');
  assert.match(workflow,/workflow_dispatch:/);
  // Manual only: no schedule, push or workflow_run trigger.
  assert.doesNotMatch(workflow,/^\s+(schedule|push):/m);
  assert.doesNotMatch(workflow,/^\s+workflow_run:/m);
  assert.match(workflow,/git diff --quiet --/);
  assert.match(workflow,/curveyield3\/Audit-Controller/);
  assert.match(workflow,/python3 \.sync-lite-authority-zip-v1\.py/);
  assert.match(script,/date_time=\(1980, 1, 1, 0, 0, 0\)/);
  assert.match(script,/sorted\(p for p in package\.rglob/);
  assert.match(script,/ZIP_DEFLATED/);
  assert.match(script,/manifest\.get\("release"\)/);
  assert.match(script,/package\.rename\(expected_package\)/);
  assert.match(script,/hashlib\.sha256\(data\)\.hexdigest\(\)/);
  assert.match(script,/stale\.unlink\(\)/);
  assert.match(workflow,/git add -A -- 'Audit Skill - Current Authority'/);
});
