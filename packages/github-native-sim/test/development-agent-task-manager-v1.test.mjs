import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyV7QualificationChanges } from '../../../scripts/classify-v7-qualification-change.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowPath = path.join(root, '.github/workflows/development-agent-task-manager.yml');
const wakePath = path.join(root, 'scripts/browser-agent-wake.mjs');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const wake = fs.readFileSync(wakePath, 'utf8');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('missing state probes are not mistaken for existing managers', () => {
  assert.match(workflow, /if \[\[ "\$active_probe" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then/);
  assert.doesNotMatch(workflow, /\[ -z "\$active_probe" \] \|\|/);
  assert.match(workflow, /if \[\[ "\$existing" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then/);
});

test('declarative request files can start the existing task-manager workflow without manual dispatch', () => {
  assert.match(workflow, /push:\s*\n\s+branches: \[main\][\s\S]*process\/development-agent-task-manager\/requests\/\*\.json/);
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /Resolve declarative start request/);
  assert.match(workflow, /curveyield-development-agent-task-request-v1/);
  assert.match(workflow, /Exactly one task-manager request file must be created or changed per triggering commit/);
  assert.match(workflow, /is already active; refusing to create a duplicate agent/);
  assert.match(workflow, /TASK_MANAGER_REQUEST_PATH=\$request_path/);
});

test('development task manager is a scheduled watchdog-derived supervisor that reuses browser primitives', () => {
  assert.match(workflow, /name: Development Agent Task Manager/);
  assert.match(workflow, /cron: '4-59\/5 \* \* \* \*'/);
  assert.match(workflow, /Discover active development agents/);
  assert.match(workflow, /process\/development-agent-task-manager\/active/);
  assert.match(workflow, /max-parallel:\s*4/);
  assert.match(workflow, /Set up isolated browser-agent runtime/);
  assert.match(workflow, /node scripts\/browser-agent-wake\.mjs/);
  assert.doesNotMatch(workflow, /playwright-core|@browserbasehq\/sdk/);
});

test('missing target branch refs are treated as absent unless they return a real SHA', () => {
  assert.match(workflow, /if ! \[\[ "\$target_head" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then/);
  assert.match(workflow, /\[\[ "\$base_sha" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.doesNotMatch(workflow, /if \[ -z "\$target_head" \]; then/);
});

test('slash-delimited target branches use ref-safe repository lookups', () => {
  assert.match(workflow, /target_branch_uri=.*@uri/);
  assert.match(workflow, /git\/ref\/heads\/\$target_branch_uri/);
  assert.match(workflow, /repos\/\$target_repo\/commits" -f sha="\$target_branch"/);
  assert.doesNotMatch(workflow, /repos\/\$target_repo\/commits\/\$target_branch/);
});

test('one unanswered prompt triggers two immediate refreshed retries with two-minute response windows', () => {
  assert.match(workflow, /responsePolicy:\{attempts:3,minimumWaitMsPerAttempt:120000,refreshBetweenAttempts:true\}/);
  assert.match(workflow, /\.responsePolicy\.attempts==3/);
  assert.match(workflow, /\.responsePolicy\.minimumWaitMsPerAttempt==120000/);
  assert.match(workflow, /for attempt in 1 2 3; do/);
  assert.match(workflow, /export RESPONSE_WAIT_MS='120000'/);
  assert.match(workflow, /if \[ "\$attempt" -gt 1 \]; then export REFRESH_BEFORE_WAKE='true'; fi/);
  assert.match(workflow, /THREE_CONSECUTIVE_UNANSWERED_PROMPTS/);
  assert.doesNotMatch(workflow, /sleep\s+300/);
});

test('unviewable chat is an immediate death signal while provider failure is not', () => {
  assert.match(wake, /chatViewable/);
  assert.match(wake, /conversationUnavailable/);
  assert.match(wake, /deadReason: 'CHAT_UNVIEWABLE'/);
  assert.match(workflow, /chat_viewable=.*\.chatViewable/);
  assert.match(workflow, /failure_reason='CHAT_UNVIEWABLE'/);
  assert.match(workflow, /OBSERVATION_PROVIDER_FAILURE/);
  assert.match(workflow, /PROMPT_PROVIDER_FAILURE/);
  assert.match(workflow, /preserving the current worker for the next sweep rather than guessing that the agent died/);
});

test('wake driver enforces at least 120 seconds for each wake-and-wait attempt', () => {
  assert.match(wake, /action === 'wake_and_wait'/);
  assert.match(wake, /Math\.max\(120000, requestedWait\)/);
  assert.match(wake, /REFRESH_BEFORE_WAKE/);
  assert.match(wake, /await page\.reload/);
  assert.match(wake, /waitForAssistantResponse\(page, before, responseWaitMs\)/);
});

test('dead-agent recovery saves durable branch state before creating a fresh replacement chat', () => {
  const checkpoint = workflow.indexOf('AGENT_DEAD_CHECKPOINT_SAVED');
  const persist = workflow.indexOf('checkpoint dead agent $SAFE_ID');
  const replacement = workflow.indexOf("export WAKE_MODE='create_fresh'", checkpoint);
  assert.ok(checkpoint >= 0);
  assert.ok(persist > checkpoint);
  assert.ok(replacement > persist);
  assert.match(workflow, /checkpoint_sha=.*gh api -X GET "repos\/\$target_repo\/commits" -f sha="\$target_branch"/);
  assert.match(workflow, /exact_resume_head=\$checkpoint_sha/);
  assert.match(workflow, /predecessor_chat=\$predecessor/);
  assert.match(workflow, /replacement_reason=\$failure_reason/);
});

test('completion is machine gated to the exact receipt commit and implementation parent', () => {
  assert.match(workflow, /curveyield-development-task-completion-v1/);
  assert.match(workflow, /all\(\.tests\[\]; \.status=="PASS"\)/);
  assert.match(workflow, /receipt_commit=.*-f path="\$receipt_path"/);
  assert.match(workflow, /\[ "\$receipt_commit" = "\$current_head" \]/);
  assert.match(workflow, /receipt_parent=.*\.parents\[0\]\.sha/);
  assert.match(workflow, /\[ "\$receipt_parent" = "\$implementation_head" \]/);
});

test('pinned specification and skill authority are exact human-supplied bytes', () => {
  const specPath = path.join(root, 'process/development-agent-task-manager/specifications/AUDIT_AUTOMATION_UPGRADE_SPECIFICATION_v1.md');
  const spec = fs.readFileSync(specPath);
  assert.equal(sha256(spec), 'b23743f626cc159f869f22bfa4921b50ed103f600c4e7981d94463861dd1b86a');

  const skillDir = path.join(root, 'process/development-agent-task-manager/authority/audit-v7-v38.3.4');
  const expectedParts = [
    ['SKILL_PART_01.md', '176a01e0148f13e6216494e9f2cb068a140d87c491327d7301176eb54f0b7081'],
    ['SKILL_PART_02.md', '2f14f5ddeb5a992016096e5f936912121c2663b4ae0616adf832d5692f744f63'],
    ['SKILL_PART_03.md', 'c161ace9dab1123d6f47fb2ab25f9139b22fa96455852fd8cdcc976aecb1d654'],
    ['SKILL_PART_04.md', 'd8a799923c7d8ca4edf950a0b2ee0d7a13189d22a078ad6ff54bd2781a048d07'],
    ['SKILL_PART_05.md', '243864c02d83899074216c94dc585e6fd5548c52f3c83cf3752f6df24da8bc7a'],
  ];
  const parts = [];
  for (const [name, expected] of expectedParts) {
    const bytes = fs.readFileSync(path.join(skillDir, name));
    assert.equal(sha256(bytes), expected, name);
    parts.push(bytes);
  }
  assert.equal(sha256(Buffer.concat(parts)), '31558c88bb93eb8ce638a426d1318b7a712cb5a6bd5c2f2c6927bd8b6dc6dc4c');

  const index = fs.readFileSync(path.join(skillDir, 'SKILL_AUTHORITY_INDEX_v1.md'), 'utf8');
  assert.match(index, /aed298c90c3de3bf9e64bf7e49853b7efd994c47ef9e88cc8f35f60977314cd8/);
  assert.match(index, /31558c88bb93eb8ce638a426d1318b7a712cb5a6bd5c2f2c6927bd8b6dc6dc4c/);
});

test('manager re-verifies authority bytes on every supervision sweep', () => {
  assert.match(workflow, /Verify pinned development authorities/);
  assert.match(workflow, /Development specification bytes changed after manager admission/);
  assert.match(workflow, /Skill authority bytes changed after manager admission/);
});

test('declarative request schema is strict and binds a durable target branch', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(root, 'protocol/schemas/curveyield-development-agent-task-request-v1.schema.json'),
    'utf8'
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 'curveyield-development-agent-task-request-v1');
  assert.equal(schema.properties.status.const, 'READY');
  for (const field of ['managerId', 'specificationPath', 'skillPath', 'targetRepository', 'targetBranch']) {
    assert.ok(schema.required.includes(field), field);
  }
});

test('completion schema is strict and requires passing tests', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(root, 'protocol/schemas/curveyield-development-task-completion-v1.schema.json'),
    'utf8'
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 'curveyield-development-task-completion-v1');
  assert.equal(schema.properties.status.const, 'COMPLETE');
  assert.equal(schema.properties.tests.minItems, 1);
  assert.equal(schema.properties.tests.items.properties.status.const, 'PASS');
});

test('manager remains a Contract-Automation workflow and encodes the repository-boundary rule', () => {
  assert.match(workflow, /Audit-Controller must contain no GitHub Actions workflows; workflows belong in Contract-Automation/);
  assert.match(workflow, /Never add a GitHub Actions workflow to Audit-Controller/);
  assert.doesNotMatch(workflow, /gh workflow run[^\n]*--repo\s+curveyield3\/Audit-Controller/);
});

test('task-manager changes stay in the control-light qualification lane', () => {
  const result = classifyV7QualificationChanges([
    '.github/workflows/development-agent-task-manager.yml',
    'scripts/browser-agent-wake.mjs',
    'process/development-agent-task-manager/README_v1.md',
    'process/development-agent-task-manager/specifications/AUDIT_AUTOMATION_UPGRADE_SPECIFICATION_v1.md',
    'process/development-agent-task-manager/authority/audit-v7-v38.3.4/SKILL_AUTHORITY_INDEX_v1.md',
    'protocol/schemas/curveyield-development-task-completion-v1.schema.json',
    'packages/github-native-sim/test/development-agent-task-manager-v1.test.mjs',
  ]);
  assert.equal(result.lane, 'CONTROL_LIGHT');
  assert.equal(result.escalatedPaths, undefined);
});


test('development agents receive a pinned task-lock protocol and task-specific state path', () => {
  assert.match(workflow, /TASK_LOCK_PROTOCOL_PATH: process\/development-agent-task-manager\/TASK_LOCK_PROTOCOL_v1\.md/);
  assert.match(workflow, /TASK_LOCK_TEMPLATE_PATH: process\/development-agent-task-manager\/TASK_LOCK_STATE_TEMPLATE_v1\.md/);
  assert.match(workflow, /task_lock_scope=development_upgrade_only/);
  assert.match(workflow, /task_lock_state_path=\$TASK_MANAGER_TASK_LOCK_STATE_PATH/);
  assert.match(workflow, /task_lock_state_path="process\/development-agent-task-manager\/task-locks\/\$\{safe_id\}_v1\.md"/);
  assert.match(workflow, /taskLock:\{scope:"development_upgrade_only"/);
});

test('development task lock enforces smallest-delta behavior before implementation and during recovery', () => {
  assert.match(workflow, /Before implementation work, read the exact task-lock protocol/);
  assert.match(workflow, /Do not perform implementation work until that lock exists/);
  assert.match(workflow, /eliminates or verifies a REMAINING DELTA item/);
  assert.match(workflow, /Discovery of an adjacent problem is not authorization to repair it/);
  assert.match(workflow, /Re-read the existing task-lock state on the target branch/);
  assert.match(workflow, /Preserve SATISFIED entries unless live verification disproves them/);
  assert.match(workflow, /Do not turn PARKED OBSERVATIONS into scope/);
});

test('machine completion requires a closed task-lock state', () => {
  assert.match(workflow, /task_lock_state_path=.*\.taskLock\.statePath/);
  assert.match(workflow, /remaining_delta=.*awk/);
  assert.match(workflow, /active_blocker=.*awk/);
  assert.match(workflow, /\[ "\$remaining_delta" = "- None" \]/);
  assert.match(workflow, /\[ "\$active_blocker" = "None" \]/);
});

test('managed Project continuity is the default with standalone as explicit exception', () => {
  assert.match(workflow, /continuity_mode:/);
  assert.match(workflow, /default: managed_project/);
  assert.match(workflow, /options: \[managed_project, standalone\]/);
  assert.match(workflow, /CONTINUITY_MODE:.*inputs\.continuity_mode/);
  assert.match(workflow, /continuityMode \/\//);
  assert.match(workflow, /TASK_MANAGER_CONTINUITY_MODE=\$continuity_mode/);

  const schema = JSON.parse(fs.readFileSync(
    path.join(root, 'protocol/schemas/curveyield-development-agent-task-request-v1.schema.json'),
    'utf8'
  ));
  assert.deepEqual(schema.properties.continuityMode.enum, ['managed_project', 'standalone']);
  assert.equal(schema.properties.continuityMode.default, 'managed_project');
});

test('development manager uses corrected home-exit Playwright transport with immutable bootstrap state', () => {
  assert.match(workflow, /tailscale\/github-action@v4/);
  assert.match(workflow, /Route browser phase through home exit node/);
  assert.match(workflow, /Xvfb :99 -screen 0 1920x1080x24/);
  assert.match(workflow, /x11vnc -display :99/);
  assert.match(workflow, /CHATGPT_STORAGE_STATE_B64/);
  assert.match(workflow, /node scripts\/browser-agent-wake\.mjs/);
  assert.doesNotMatch(workflow, /CHATGPT_SESSION_STATE_|actions\/cache\/(?:restore|save)@v4|session-state-v1\.enc\.json/);
  assert.doesNotMatch(workflow, /BROWSERLESS_TOKEN|BROWSERBASE_API_KEY|BROWSERBASE_PROJECT_ID|BROWSERBASE_CONTEXT_ID/);
  assert.doesNotMatch(workflow, /xvfb-run -a node scripts\/browser-agent-wake\.mjs/);
});

test('managed task creates one Project then replacements reopen that exact Project', () => {
  assert.match(workflow, /development-agent-project-create-v1/);
  assert.match(workflow, /development-agent-project-open-v1/);
  assert.match(workflow, /project_url=.*\.projectUrl/);
  assert.match(workflow, /continuity:\{mode:\$continuityMode,project:\{name:\$projectName,url:\$projectUrl\}\}/);
  assert.match(workflow, /replacement_project_url=.*\.projectUrl/);
  assert.match(workflow, /Replacement agent did not reopen the persisted managed Project URL/);

  const create = JSON.parse(fs.readFileSync(
    path.join(root, 'process/browser-routines/development-agent-project-create-v1.json'),
    'utf8'
  ));
  const open = JSON.parse(fs.readFileSync(
    path.join(root, 'process/browser-routines/development-agent-project-open-v1.json'),
    'utf8'
  ));
  assert.deepEqual(create.stages.before_message.map((step) => step.operation), [
    'chatgpt.ensure_chat_mode',
    'chatgpt.create_project',
    'chatgpt.capture_project_share_link',
    'chatgpt.start_current_project_chat',
  ]);
  assert.deepEqual(open.stages.before_message.map((step) => step.operation), [
    'chatgpt.ensure_chat_mode',
    'chatgpt.open_project_url',
    'chatgpt.start_current_project_chat',
  ]);
  assert.ok(!open.stages.before_message.some((step) => step.operation === 'chatgpt.create_project'));
});

test('shared browser script uses generic Project semantics rather than audit routine IDs', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/browser-agent-wake.mjs'), 'utf8');
  assert.match(source, /projectUrlRequired = \/project-open-v1\$\/\.test\(browserRoutineId\)/);
  assert.match(source, /routineBefore\.some\(\(entry\) => entry\.operation === 'chatgpt\.capture_project_share_link'\)/);
  assert.doesNotMatch(source, /browserRoutineId === 'audit-lite-reviewer-project-create-v1'/);
  assert.doesNotMatch(source, /browserRoutineId === 'audit-lite-reviewer-project-open-v1'/);
});

test('task-lock policy is not injected into audit-specific browser workflows', () => {
  const protocol = fs.readFileSync(
    path.join(root, 'FOCUS/TASK LOCKS/TASK_LOCK_PROTOCOL_v1.md'),
    'utf8'
  );
  assert.match(protocol, /does \*\*not\*\* govern audit execution agents or audit campaign orchestration/);

  const workflowDir = path.join(root, '.github/workflows');
  const auditWorkflowNames = fs.readdirSync(workflowDir).filter((name) =>
    /audit|phase0|phase9|reviewer|v7-execution/i.test(name) &&
    name !== 'development-agent-task-manager.yml'
  );
  for (const name of auditWorkflowNames) {
    const body = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    assert.doesNotMatch(body, /TASK_LOCK_PROTOCOL_v1\.md|task_lock_scope=development_upgrade_only/, name);
  }
});


test('initial development-agent launch retries retryable browser challenges on bounded fresh runners', () => {
  assert.match(workflow, /runner_retry_attempt:/);
  assert.match(workflow, /Internal fresh-runner browser retry attempt counter/);
  assert.match(workflow, /retryable=.*select\(\.provider=="github-playwright" and \.retryable==true\)/);
  assert.match(workflow, /max=3/);
  assert.match(workflow, /gh workflow run development-agent-task-manager\.yml/);
  assert.match(workflow, /--field runner_retry_attempt="\$next"/);
  assert.match(workflow, /Fresh-runner development-agent retry \$next\/\$max dispatched/);
  assert.match(workflow, /if: steps\.initial_agent\.outputs\.created == 'true'/);
});

test('fresh-runner retry preserves the exact development task and Project continuity inputs', () => {
  for (const field of [
    'manager_id="$MANAGER_ID"',
    'specification_path="$SPEC_PATH"',
    'skill_path="$SKILL_PATH"',
    'authority_ref="$AUTHORITY_REF"',
    'target_repository="$TARGET_REPOSITORY"',
    'target_branch="$TARGET_BRANCH"',
    'base_ref="$BASE_REF"',
    'continuity_mode="$TASK_MANAGER_CONTINUITY_MODE"',
  ]) {
    assert.match(workflow, new RegExp(field.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')));
  }
  assert.match(workflow, /BROWSER_ROUTINE_ID='development-agent-project-create-v1'/);
  assert.match(workflow, /CHATGPT_PROJECT_NAME="\$TASK_MANAGER_PROJECT_NAME"/);
});


test('development manager uses five-minute ordinary readiness waits and fast-fails challenges', () => {
  assert.equal((workflow.match(/INTERACTIVE_VIEW_ENABLED: 'true'/g) || []).length, 2);
  assert.equal((workflow.match(/MANUAL_CHALLENGE_WAIT_MS: '300000'/g) || []).length, 2);
  assert.match(workflow, /x11vnc -display :99/);
  assert.match(workflow, /HOME_EXIT_NODE/);
});

test('managed Project state persists Project URL while accepting Project-scoped worker chat URLs', () => {
  assert.match(workflow, /\.chatUrl\|type=="string" and test\("\^https:\/\/chatgpt\.com\/\(c\/\|g\/g-p-\[\^\/\]\+\/c\/\)"\)/);
  assert.match(workflow, /projectUrl\|type=="string" and test\("\^https:\/\/chatgpt\.com\/g\/g-p-\[\^\/\]\+\/project\/\?\$"\)/);
  assert.match(workflow, /continuity:\{mode:\$continuityMode,project:\{name:\$projectName,url:\$projectUrl\}\}/);
  assert.match(workflow, /replacement_project_url=.*\.projectUrl/);
  assert.match(workflow, /g\/g-p-\[\^\/\]\+\/c\//);
});
