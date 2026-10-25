import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/audit-controller-execution.yml');

test('canonical V7 execution workflow scopes private controller auth and archive RPC to the steps that require them', () => {
  assert.equal(fs.existsSync(workflowPath), true, 'canonical V7 execution workflow must exist');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /name:\s*Checkout private Audit Controller for manual dispatch/);
  assert.match(workflow, /name:\s*Select working Audit-Controller credential for manual dispatch/);
  assert.match(workflow, /AUDIT_CONTROLLER_PRIMARY_TOKEN:\s*\$\{\{ secrets\.AUDIT_CONTROLLER_GITHUB_TOKEN \}\}/);
  assert.match(workflow, /PREFLIGHTSIM_FALLBACK_TOKEN:\s*\$\{\{ secrets\.PREFLIGHTSIM_GITHUB_TOKEN \}\}/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ env\.AUDIT_CONTROLLER_GITHUB_TOKEN \}\}/);
  assert.match(workflow, /gh api repos\/curveyield3\/Audit-Controller --silent/);
  assert.match(workflow, /gh repo clone curveyield3\/Audit-Controller \.controller-request/);

  assert.match(workflow, /name:\s*Checkout exact private controller for controller operation/);
  assert.match(workflow, /if:\s*env\.V7_REQUEST_KIND == 'controller-operation'/);
  assert.match(workflow, /gh repo clone curveyield3\/Audit-Controller \.controller-operation/);
  assert.match(workflow, /git fetch --depth=1 origin "\$AUDIT_CONTROLLER_REF"/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$AUDIT_CONTROLLER_REF"/);
  assert.match(workflow, /name:\s*Write controller-operation result back to exact private branch/);
  assert.match(workflow, /gh auth setup-git/);
  assert.match(workflow, /name:\s*Execute V7 request/);
  assert.match(workflow, /AUDIT_CONTROLLER_GITHUB_TOKEN:\s*\$\{\{ env\.AUDIT_CONTROLLER_GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /AUDIT_CONTROLLER_GITHUB_TOKEN\s*\|\|\s*secrets\.PREFLIGHTSIM_GITHUB_TOKEN/);
    assert.ok(workflow.includes('ETHEREUM_FORK_RPC_URL: ${{ secrets.ETHEREUM_RPC }}'));
  assert.match(workflow, /npm run v7:execute -- --request \.v7-request\/request\.json/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /path:\s*\.audit-evidence\/v7-execution/);
  assert.doesNotMatch(workflow, /RPC_ETHEREUM:\s*\$\{\{/);
});



test('controller operations reuse only exact successful canonical controller qualification and fall back to inline verify', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /name:\s*Reuse exact controller qualification when available/);
  assert.match(workflow, /controller\.controllerCommit===exact/);
  assert.match(workflow, /controller\.controllerRef===exact/);
  assert.match(workflow, /controller\.runnerQualifiedCommit===status\.qualifiedCommit/);
  assert.match(workflow, /controller\.runnerQualificationRunId/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$run_id/);
  assert.match(workflow, /run\.status!==['"]completed['"]/);
  assert.match(workflow, /run\.conclusion!==['"]success['"]/);
  assert.match(workflow, /run\.name!==['"]V7 Execution Infrastructure Qualification['"]/);
  assert.match(workflow, /run\.event!==['"]workflow_dispatch['"]/);
  assert.match(workflow, /CONTROLLER_VERIFICATION_REUSED=true/);

  const verifyStart=workflow.indexOf('- name: Verify exact controller code when requested');
  assert.ok(verifyStart>=0);
  const verifyEnd=workflow.indexOf('\n      - name:',verifyStart+1);
  const verifyBlock=workflow.slice(verifyStart,verifyEnd===-1?undefined:verifyEnd);
  assert.match(verifyBlock,/CONTROLLER_VERIFICATION_REUSED != 'true'/);
  assert.match(verifyBlock,/npm run verify/);
});


test('V7 execution concurrency is bound to exact request identity rather than mutable PR number alone', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /group:\s*v7-execution-\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*format\('\{0\}-\{1\}',\s*inputs\.controller_ref,\s*inputs\.request_path\)\s*\}\}/);
  assert.doesNotMatch(workflow, /group:\s*v7-execution-\$\{\{\s*github\.event\.pull_request\.number\s*\|\|/);
});

test('exact duplicate V7 executions may supersede while different request revisions remain independent', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/);
  assert.match(workflow, /inputs\.controller_ref/);
  assert.match(workflow, /inputs\.request_path/);
});


test('Lite BUILD_EXECUTION_REQUEST controller operation auto-dispatches the exact generated request after writeback', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /name:\s*Dispatch generated V7 execution request/);
  assert.match(workflow, /OPERATOR_OPERATION == 'BUILD_EXECUTION_REQUEST'/);
  assert.match(workflow, /CONTROLLER_WRITEBACK_COMMIT=\$writeback_commit/);
  assert.match(workflow, /request_path="\$\{WRITEBACK_DIRECTORY%\/\}\/EXECUTION_REQUEST_v1\.json"/);
  assert.match(workflow, /gh workflow run audit-controller-execution\.yml/);
  assert.match(workflow, /-f request_path="\$request_path"/);
  assert.match(workflow, /-f controller_ref="\$CONTROLLER_WRITEBACK_COMMIT"/);
  assert.match(workflow, /deep-assurance-github-request-v2/);
});

test('generated execution request does not wake the semantic reviewer before terminal technical execution', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const wakeStart = workflow.indexOf('- name: Dispatch registered browser-agent wake');
  assert.ok(wakeStart >= 0);
  const wakeBlock = workflow.slice(wakeStart);
  assert.match(wakeBlock, /V7_REQUEST_KIND:-/);
  assert.match(wakeBlock, /BUILD_EXECUTION_REQUEST/);
  assert.match(wakeBlock, /browser wake waits for terminal technical execution/);
});


test('terminal V7 execution writes a durable typed observer receipt before reviewer wake', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const observer = workflow.indexOf('- name: Record terminal V7 execution observer receipt');
  const upload = workflow.indexOf('- name: Upload request-addressable V7 evidence');
  const wake = workflow.indexOf('- name: Dispatch registered browser-agent wake');
  assert.ok(observer >= 0);
  assert.ok(upload > observer);
  assert.ok(wake > upload);
  assert.match(workflow, /curveyield-lite-execution-observer-receipt-v1/);
  assert.match(workflow, /semanticReviewerPollingRequired:false/);
  assert.match(workflow, /route='EVIDENCE_INGESTION'/);
  assert.match(workflow, /route='RUNNER_REPAIR_REQUIRED'/);
  assert.match(workflow, /route='SEMANTIC_HARNESS_REPAIR_REQUIRED'/);
  assert.match(workflow, /route='TYPED_FAILURE_REVIEW_REQUIRED'/);
  assert.match(workflow, /route='EVIDENCE_RECOVERY_REQUIRED'/);
  assert.match(workflow, /EXECUTION_OBSERVER_RECEIPT_v1\.json/);
  assert.match(workflow, /workflowRunId:\$workflow_run_id/);
  assert.match(workflow, /artifactName:\$artifact_name/);
});

test('semantic reviewer callback verifies terminal observer state before a minimal poke', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const wakeStart = workflow.indexOf('- name: Dispatch registered browser-agent wake');
  assert.ok(wakeStart >= 0);
  const wakeBlock = workflow.slice(wakeStart);
  assert.match(wakeBlock, /if:\s*always\(\) && \(env\.V7_REQUEST_KIND == 'v7-execution' \|\| success\(\)\)/);
  assert.match(wakeBlock, /EXECUTION_OBSERVER_RECEIPT/);
  assert.match(wakeBlock, /route="\$\(jq -r '\.route'/);
  assert.match(wakeBlock, /disposition="\$\(jq -r '\.terminal\.disposition'/);
  assert.match(wakeBlock, /next_action="\$\(jq -r '\.terminal\.nextAction'/);
  assert.match(wakeBlock, /Terminal execution observer verified/);
  assert.match(wakeBlock, /wake_message='GET BACK TO WORK'/);
  assert.match(wakeBlock, /watchdog_enabled=false/);
});


test('technical execution uses the canonical FULL-qualified runner commit rather than mutable main', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const cli = fs.readFileSync(path.join(repoRoot, 'packages/github-native-sim/src/v7-cli.mjs'), 'utf8');
  assert.match(workflow, /name:\s*Resolve canonical qualified Contract-Automation runner/);
  assert.match(workflow, /V7_QUALIFICATION_STATUS\.json\?ref=main/);
  assert.match(workflow, /ref:\s*\$\{\{ steps\.qualified_runner\.outputs\.commit \}\}/);
  assert.match(workflow, /V7_RUNNER_COMMIT=\$observed/);
  assert.match(cli, /process\.env\.V7_RUNNER_COMMIT\?\?process\.env\.GITHUB_SHA/);
});

test('C5 carries the exact private writeback branch into terminal execution for C7 ingestion', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /controller_writeback_ref:/);
  assert.match(workflow, /-f controller_writeback_ref="\$WRITEBACK_REF"/);
});

test('Lite C7 stages terminal evidence and dispatches the existing INGEST_EXECUTION_EVIDENCE operation', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const ingest = workflow.indexOf('- name: Prepare automatic Lite evidence ingestion');
  const wake = workflow.indexOf('- name: Dispatch registered browser-agent wake');
  assert.ok(ingest >= 0);
  assert.ok(wake > ingest);
  assert.match(workflow, /EXECUTION_OBSERVER_ROUTE == 'EVIDENCE_INGESTION'/);
  assert.match(workflow, /test "\$remote_head" = "\$CONTROLLER_SOURCE_REF"/);
  assert.match(workflow, /operation:"INGEST_EXECUTION_EVIDENCE"/);
  assert.match(workflow, /executionRequestPath:\$execution_request/);
  assert.match(workflow, /executionEvidencePath:\$execution_evidence/);
  assert.match(workflow, /qualificationPath:\$qualification/);
  assert.match(workflow, /verifyController:true/);
  assert.match(workflow, /gh workflow run audit-controller-execution\.yml/);
  assert.match(workflow, /AUTO_INGESTION_DISPATCHED=true/);
});

test('semantic reviewer callback waits for and verifies durable ingestion receipt before the minimal poke', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const wakeStart = workflow.indexOf('- name: Dispatch registered browser-agent wake');
  assert.ok(wakeStart >= 0);
  const wakeBlock = workflow.slice(wakeStart);
  assert.match(wakeBlock, /Terminal evidence ingestion was dispatched automatically; semantic reviewer wake waits for the durable ingestion receipt/);
  assert.match(wakeBlock, /OPERATOR_OPERATION:-.*INGEST_EXECUTION_EVIDENCE|OPERATOR_OPERATION:-\}" = 'INGEST_EXECUTION_EVIDENCE'/s);
  assert.match(wakeBlock, /EXECUTION_EVIDENCE_INGESTION_RECEIPT_v1\.json/);
  assert.match(wakeBlock, /security_disposition="\$\(jq -r '\.securityDisposition'/);
  assert.match(wakeBlock, /finding_promotion="\$\(jq -r '\.findingPromotion'/);
  assert.match(wakeBlock, /ingestion_digest="\$\(jq -r '\.ingestionDigest'/);
  assert.match(wakeBlock, /EVIDENCE_INGESTED: durable ingestion receipt verified/);
  assert.match(wakeBlock, /wake_message='GET BACK TO WORK'/);
});

test('canonical execution workflow tail is singular and free of the prior duplicated corruption', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.equal((workflow.match(/- name: Upload request-addressable V7 evidence/g) ?? []).length, 1);
  assert.equal((workflow.match(/- name: Dispatch registered browser-agent wake/g) ?? []).length, 1);
  assert.equal((workflow.match(/- name: Prepare automatic Lite evidence ingestion/g) ?? []).length, 1);
  assert.equal(workflow.includes("\\\\n\\\\n\'"), false);
});
