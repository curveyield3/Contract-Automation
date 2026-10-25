import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateControllerOperationPointerV1 } from '../src/controller-operation-pointer-v1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const workflowPath = path.join(repoRoot, '.github/workflows/audit-controller-execution.yml');
const resolverPath = path.join(repoRoot, 'packages/github-native-sim/src/request-resolution-v1.mjs');

test('canonical V7 bridge resolves exactly one atomic request file from request PRs', () => {
  assert.equal(fs.existsSync(workflowPath), true, 'canonical V7 execution workflow must exist');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const resolver = fs.readFileSync(resolverPath, 'utf8');

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /github-native-sim\/requests\/\*\*\/request\.json/);
  assert.match(workflow, /name:\s*Checkout atomic request source for PR/);
  assert.match(workflow, /path:\s*\.request-source/);
  assert.match(workflow, /npm run v7 -- resolve --mode pr --source \.request-source --output \.v7-request\/request\.json/);
  assert.match(resolver, /const candidates = await findPrRequests/);
  assert.match(resolver, /candidates\.length !== 1/);
  assert.match(resolver, /PR request source must contain exactly one atomic request/);
    assert.ok(workflow.includes('ETHEREUM_FORK_RPC_URL: ${{ secrets.ETHEREUM_RPC }}'));
  assert.doesNotMatch(workflow, /push:\s*[\s\S]*github-native-sim\/requests/);
});

test('canonical bridge preserves existing V7 execution lane and adds controller operations inside the same workflow', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /name:\s*Execute V7 request/);
  assert.match(workflow, /if:\s*env\.V7_REQUEST_KIND == 'v7-execution'/);
  assert.match(workflow, /npm run v7:execute -- --request \.v7-request\/request\.json/);
  assert.match(workflow, /name:\s*Checkout exact private controller for controller operation/);
  assert.match(workflow, /if:\s*env\.V7_REQUEST_KIND == 'controller-operation'/);
  assert.match(workflow, /audit-operator-cli-v1\.mjs/);
  assert.equal(fs.existsSync(path.join(repoRoot, '.github/workflows/audit-operator-bridge-v1.yml')), false, 'parallel audit operator workflow must not exist');
});

test('controller-only requests skip heavyweight V7 technical setup', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  for (const step of [
    'Cache npm download cache',
    'Install trusted runner dependencies',
    'Install and verify canonical V7 toolchain',
    'Verify canonical runner manifest',
  ]) {
    const start = workflow.indexOf(`- name: ${step}`);
    assert.ok(start >= 0, `missing step ${step}`);
    const slice = workflow.slice(start, workflow.indexOf('\n      - name:', start + 1) === -1 ? undefined : workflow.indexOf('\n      - name:', start + 1));
    assert.match(slice, /if:\s*env\.V7_REQUEST_KIND == 'v7-execution'/);
  }
});

test('canonical V7 bridge keeps untrusted PR request checkout free of private credentials', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const prCheckoutStart = workflow.indexOf('- name: Checkout atomic request source for PR');
  const prCheckoutEnd = workflow.indexOf('\n      - name:', prCheckoutStart + 1);
  const manualPrivateCheckoutStart = workflow.indexOf('- name: Checkout private Audit Controller for manual dispatch');
  assert.ok(prCheckoutStart >= 0 && prCheckoutEnd > prCheckoutStart && manualPrivateCheckoutStart > prCheckoutStart);
  const prCheckout = workflow.slice(prCheckoutStart, prCheckoutEnd);
  assert.doesNotMatch(prCheckout, /AUDIT_CONTROLLER_GITHUB_TOKEN/);
  assert.doesNotMatch(prCheckout, /PREFLIGHTSIM_GITHUB_TOKEN/);
  assert.doesNotMatch(prCheckout, /SIM_ARCHIVE_PRIMARY_ETHEREUM_01/);
  const privateLane = workflow.slice(manualPrivateCheckoutStart);
  assert.match(privateLane, /AUDIT_CONTROLLER_PRIMARY_TOKEN:\s*\$\{\{ secrets\.AUDIT_CONTROLLER_GITHUB_TOKEN \}\}/);
  assert.match(privateLane, /PREFLIGHTSIM_FALLBACK_TOKEN:\s*\$\{\{ secrets\.PREFLIGHTSIM_GITHUB_TOKEN \}\}/);
  assert.match(privateLane, /GH_TOKEN:\s*\$\{\{ env\.AUDIT_CONTROLLER_GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(privateLane, /AUDIT_CONTROLLER_GITHUB_TOKEN\s*\|\|\s*secrets\.PREFLIGHTSIM_GITHUB_TOKEN/);
  assert.match(privateLane, /gh api repos\/curveyield3\/Audit-Controller --silent/);
  assert.match(privateLane, /gh repo clone curveyield3\/Audit-Controller/);
});

test('controller operation pointer is exact, minimal, and bound to one private request path', () => {
  const pointer = validateControllerOperationPointerV1({
    schemaVersion: 'audit-controller-operation-pointer-v1',
    processId: 'audit-v7-independent-review',
    requestId: 'awr-test-v1',
    controller: {
      repository: 'curveyield3/Audit-Controller',
      commit: 'a'.repeat(40),
      requestPath: '.deep-assurance/operator/requests/awr-test-v1.json',
    },
    verifyController: true,
  });
  assert.equal(pointer.controller.commit, 'a'.repeat(40));
  assert.equal(pointer.verifyController, true);
  assert.throws(() => validateControllerOperationPointerV1({
    ...pointer,
    controller: { ...pointer.controller, requestPath: '../secret.json' },
  }), /requestPath/);
  assert.throws(() => validateControllerOperationPointerV1({
    ...pointer,
    controller: { ...pointer.controller, repository: 'curveyield3/Other' },
  }), /repository/);
});



test('V7 resolve command remains lightweight before execution dependencies are installed', () => {
  const cliPath = path.join(repoRoot, 'packages/github-native-sim/src/v7-cli.mjs');
  const cli = fs.readFileSync(cliPath, 'utf8');
  assert.doesNotMatch(cli, /^import .*run-job-file-v2\.mjs/m);
  assert.doesNotMatch(cli, /^import .*phase6-harness-authoring-v1\.mjs/m);
  assert.doesNotMatch(cli, /^import .*runner-manifest-v2\.mjs/m);
  assert.doesNotMatch(cli, /^import .*v7-toolchain-v1\.mjs/m);
  assert.match(cli, /await import\('\.\/run-job-file-v2\.mjs'\)/);
});
