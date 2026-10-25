import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/audit-source-initialization-v1.yml'), 'utf8');
const run = fs.readFileSync(path.join(root, 'scripts/audit-source-initialization/run-v1.sh'), 'utf8');
const resolve = fs.readFileSync(path.join(root, 'scripts/audit-source-initialization/resolve-source-v1.sh'), 'utf8');
const extract = fs.readFileSync(path.join(root, 'scripts/audit-source-initialization/extract-v1.sh'), 'utf8');
const receipt = fs.readFileSync(path.join(root, 'scripts/audit-source-initialization/write-phase0-receipt-v1.py'), 'utf8');
const request = JSON.parse(fs.readFileSync(path.join(root, 'process/audit-source-initialization/REQUEST_TEMPLATE_v1.json'), 'utf8'));

test('Audit Source Initialization accepts source ZIP, four reviewer chats, and one persistent master chat', () => {
  assert.deepEqual(Object.keys(request), [
    'source_url',
    'agent_chat_1_url',
    'agent_chat_2_url',
    'agent_chat_3_url',
    'agent_chat_4_url',
    'master_chat_url',
  ]);
  for (const key of Object.keys(request)) assert.equal(typeof request[key], 'string');
  assert.match(workflow, /source_url:/);
  assert.match(workflow, /agent_chat_1_url:/);
  assert.match(workflow, /agent_chat_2_url:/);
  assert.match(workflow, /agent_chat_3_url:/);
  assert.match(workflow, /agent_chat_4_url:/);
  assert.match(workflow, /master_chat_url:/);
  assert.match(workflow, /validate_chat_url/);
  assert.match(workflow, /master_chat_url must be distinct from every normal reviewer chat URL/);
  assert.match(run, /agentChats/);
  assert.match(run, /"reviewer-1":\$chat1/);
  assert.match(run, /"reviewer-4":\$chat4/);
  assert.match(run, /masterReviewer:\{chatUrl:\$master,reasoning:"MAXIMUM",repairModel:"SOL",repairReasoning:"HIGH"\}/);
  assert.match(run, /mode:"resume_existing"/);
  assert.match(run, /phase1-fixed-x11-normal-chrome-no-chatgpt-page-read-v1/);
  assert.match(run, /pokeIntervalMinutes:20/);
  assert.doesNotMatch(run, /ordinary-pointer-keyboard-only/);
  assert.doesNotMatch(workflow, /campaign_id:\n\s+description:/);
  assert.doesNotMatch(workflow, /audit_name:\n\s+description:/);
});

test('Audit Source Initialization binds reviewer-3L and preserves progressed browser state on exact retries', () => {
  assert.match(workflow, /reviewer-3L/);
  assert.match(run, /"reviewer-3L":\$chat3/);

  const retryStart = run.indexOf('if [[ "$existing_registration_sha" =~ ^[0-9a-f]{40}$ ]]; then');
  const retryElse = run.indexOf('\nelse\n  jq -n', retryStart);
  assert.ok(retryStart >= 0 && retryElse > retryStart);
  const retryBlock = run.slice(retryStart, retryElse);
  assert.match(retryBlock, /existing-audit-browser-registration\.json/);
  assert.match(retryBlock, /\.agentChats=\{/);
  assert.doesNotMatch(retryBlock, /\.activeAssignment\s*=/);
  assert.doesNotMatch(retryBlock, /\.wakeDelivery\s*=/);
});

test('only direct single ZIP files on Google Drive or GitHub are accepted', () => {
  assert.match(resolve, /Google Drive folder submissions are not accepted/);
  assert.match(resolve, /GitHub folders\/repository archives are not accepted/);
  assert.match(resolve, /GitHub URL must identify one \.zip file/);
  assert.match(resolve, /github-contents\.json/);
  assert.match(resolve, /gh_path_url/);
  assert.match(resolve, /gh_ref_url/);
  assert.match(resolve, /quote\(sys\.argv\[1\], safe='\/'\)/);
  assert.match(resolve, /contents\/\$gh_path_url\?ref=\$gh_ref_url/);
  assert.match(resolve, /github-blob\.json/);
  assert.match(resolve, /git\/blobs\/\$blob_sha/);
  assert.match(resolve, /base64\.b64decode/);
  assert.doesNotMatch(resolve, /gh api .*git\/blobs.*--jq '\.content'/);
  assert.doesNotMatch(resolve, /raw=1/);
  assert.doesNotMatch(resolve, /application\/vnd\.github\.raw/);
  assert.match(resolve, /Downloaded object is not a ZIP file/);
  assert.match(resolve, /unzip -tqq/);
});

test('source identity is derived by automation', () => {
  assert.match(resolve, /sha256sum/);
  assert.match(resolve, /stat -c '%s'/);
  assert.match(resolve, /display-base/);
  assert.match(resolve, /slug/);
  assert.match(run, /source_blob=.*git rev-parse/);
  assert.match(run, /admission_commit=.*git rev-parse HEAD/);
});

test('repeated submissions allocate new rN while exact workflow retry is idempotent', () => {
  assert.match(run, /max \+ 1/);
  assert.match(run, /campaign_id="\$slug-r\$revision"/);
  assert.match(run, /new request using the same ZIP is NOT/);
  assert.match(run, /prior-source-init\.json/);
  assert.match(run, /report_sha=.*\.sha \/\/ empty/);
  assert.match(run, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(run, /report_api/);
});

test('campaign source folder contains retained ZIP plus safely unpacked source', () => {
  assert.match(run, /source_dir="\$campaign_root\/source"/);
  assert.match(run, /cp "\$work\/\$filename" "\$source_path"/);
  assert.match(run, /safe_extract_audit_zip/);
  assert.match(extract, /archive entry escapes source directory/);
  assert.match(extract, /symlink archive entry forbidden/);
  assert.match(extract, /embedded \.git path forbidden/);
});

test('workflow writes one Phase-0 receipt plus the separate Audit Campaign Directory entry on Audit-Controller main', () => {
  assert.match(receipt, /PHASE_00_RECEIPT_v1\.json/);
  assert.match(receipt, /curveyield-lite-phase-receipt-v1/);
  assert.match(receipt, /campaignDirectoryEntryPath/);
  assert.match(receipt, /curveyield-audit-campaign-directory-entry-v1/);
  assert.match(run, /export GH_TOKEN="\$AUDIT_CONTROLLER_TOKEN"[\s\S]*gh auth setup-git[\s\S]*gh repo clone curveyield3\/Audit-Controller/);
  assert.ok(run.indexOf('gh auth setup-git') < run.indexOf('gh repo clone curveyield3/Audit-Controller'));
  assert.match(run, /Audit Campaign Directory\/campaigns/);
  assert.doesNotMatch(run, /write-state-v1\.py|CAMPAIGN_STATE_v1|ACTIVE_PHASE_POINTER_v1|SOLO_AUDIT_STATE_v1/);
  assert.match(run, /git push origin HEAD:main/);
});

test('workflow dispatches fully automated Phase 0 after initialization', () => {
  assert.match(run, /lite-phase0-bootstrap-v1\.yml/);
  assert.match(run, /audit_controller_ref=main/);
  assert.doesNotMatch(run, /lite-audit-browser-orchestrator-v1\.yml/);
  assert.match(receipt, /phase0-automation/);
  assert.doesNotMatch(receipt, /web-bootstrap-agent/);
});
