import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyV7QualificationChanges } from '../../../scripts/classify-v7-qualification-change.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/agent-zip-import-v1.yml'), 'utf8');
const schema = JSON.parse(fs.readFileSync(
  path.join(root, 'protocol/schemas/curveyield-development-authority-import-v1.schema.json'),
  'utf8'
));

test('trigger request discovery is commit-API based and shallow-checkout safe', () => {
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$GITHUB_SHA"/);
  assert.match(workflow, /Exactly one import request file must be created or changed per triggering commit/);
  assert.doesNotMatch(workflow, /git diff-tree/);
});

test('legacy audit source fanout requests are rejected in favor of Audit Source Initialization', () => {
  assert.match(workflow, /curveyield-audit-source-fanout\/v2/);
  assert.match(workflow, /is retired\. Use Audit Source Initialization with only source_url/);
});

test('same importer admits bounded development-authority requests', () => {
  assert.match(workflow, /curveyield-development-authority-import\/v1/);
  assert.match(workflow, /mode='development_authority'/);
  assert.match(workflow, /target_repo=.*\.target\.repository/);
  assert.match(workflow, /test "\$target_repo" = "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /test "\$target_branch" = 'main'/);
  assert.match(workflow, /process\/development-agent-task-manager\/\*/);
  assert.match(workflow, /\[ "\$\(basename -- "\$target_path"\)" = "\$filename" \]/);
});

test('Drive identity and exact bytes are verified before repository write', () => {
  assert.match(workflow, /drive_file_id=.*\.source\.drive_file_id/);
  assert.match(workflow, /test "\$observed_file_id" = "\$DRIVE_FILE_ID"/);
  assert.match(workflow, /sha256sum "\/tmp\/\$FILENAME"/);
  assert.match(workflow, /stat -c '%s' "\/tmp\/\$FILENAME"/);
  assert.match(workflow, /test "\$actual_sha" = "\$EXPECTED_SHA256"/);
  assert.match(workflow, /test "\$actual_size" = "\$EXPECTED_SIZE"/);
});

test('ZIP magic is enforced only for zip-formatted authority objects', () => {
  assert.match(workflow, /if \[ "\$FORMAT" = 'zip' \]; then/);
  assert.match(workflow, /504b0304\|504b0506\|504b0708/);
  assert.match(workflow, /\^\(raw\|zip\)\$/);
});

test('development authority import uses the existing workflow and safe git rebase retry', () => {
  assert.match(workflow, /Import verified development authority into Contract-Automation/);
  const authSetup = workflow.indexOf('gh auth setup-git');
  const clone = workflow.indexOf('gh repo clone "$GITHUB_REPOSITORY"');
  assert.ok(authSetup >= 0 && clone > authSetup);
  assert.match(workflow, /gh repo clone "\$GITHUB_REPOSITORY"/);
  assert.match(workflow, /git fetch origin main/);
  assert.match(workflow, /git rebase origin\/main/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.match(workflow, /for attempt in 1 2 3 4 5; do/);
  assert.doesNotMatch(workflow, /git push --force|--force-with-lease/);
});

test('development authority copy is independently re-read and hash verified', () => {
  assert.match(workflow, /git show "origin\/main:\$TARGET_PATH"/);
  assert.match(workflow, /remote_sha=.*sha256sum/);
  assert.match(workflow, /test "\$remote_sha" = "\$EXPECTED_SHA256"/);
  assert.match(workflow, /curveyield-development-authority-import-report-v1/);
  assert.match(workflow, /authority-import\/reports/);
});

test('legacy authority importer is no longer a source-initialization route', () => {
  assert.match(workflow, /^name: Authority File Import v4/m);
  assert.match(workflow, /curveyield-audit-source-fanout\/v2/);
  assert.match(workflow, /is retired\. Use Audit Source Initialization/);
});

test('development authority schema is strict and Contract-Automation-only', () => {
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schema.const, 'curveyield-development-authority-import/v1');
  assert.equal(schema.properties.source.properties.type.const, 'google-drive');
  assert.deepEqual(schema.properties.source.properties.format.enum, ['raw', 'zip']);
  assert.equal(schema.properties.target.properties.repository.const, 'curveyield3/Contract-Automation');
  assert.equal(schema.properties.target.properties.branch.const, 'main');
  assert.match(schema.properties.target.properties.path.pattern, /process\/development-agent-task-manager/);
});

test('authority importer remains CONTROL_LIGHT', () => {
  const result = classifyV7QualificationChanges([
    '.github/workflows/agent-zip-import-v1.yml',
    '.github/workflows/audit-source-initialization-v1.yml',
    'protocol/schemas/curveyield-development-authority-import-v1.schema.json',
    'packages/github-native-sim/test/agent-zip-import-development-authority-v1.test.mjs',
    'process/development-agent-task-manager/AUTHORITY_IMPORT_PROTOCOL_v1.md'
  ]);
  assert.equal(result.lane, 'CONTROL_LIGHT');
});
