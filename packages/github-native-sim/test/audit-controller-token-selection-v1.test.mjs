import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const selector = path.join(repoRoot, 'scripts/select-audit-controller-token.sh');

function runSelector({ primary = '', fallback = '', required = 'true', successToken = '' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-token-select-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${GH_TOKEN:-}" >> "${tmp}/gh-tokens.log"
if [ "\${GH_TOKEN:-}" = "${successToken}" ] && [ -n "${successToken}" ]; then exit 0; fi
exit 1
`);
  fs.chmodSync(gh, 0o755);
  const githubEnv = path.join(tmp, 'github-env');
  const summary = path.join(tmp, 'summary');
  fs.writeFileSync(githubEnv, '');
  fs.writeFileSync(summary, '');
  const result = spawnSync('bash', [selector], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_ENV: githubEnv,
      GITHUB_STEP_SUMMARY: summary,
      AUDIT_CONTROLLER_PRIMARY_TOKEN: primary,
      PREFLIGHTSIM_FALLBACK_TOKEN: fallback,
      AUDIT_CONTROLLER_TOKEN_REQUIRED: required,
    },
  });
  return {
    ...result,
    envFile: fs.readFileSync(githubEnv, 'utf8'),
    summary: fs.readFileSync(summary, 'utf8'),
    probed: fs.existsSync(path.join(tmp, 'gh-tokens.log'))
      ? fs.readFileSync(path.join(tmp, 'gh-tokens.log'), 'utf8').trim().split(/\n/).filter(Boolean)
      : [],
  };
}

test('runtime selector prefers a valid dedicated Audit-Controller token', () => {
  const result = runSelector({ primary: 'primary-good', fallback: 'fallback-good', successToken: 'primary-good' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.probed, ['primary-good']);
  assert.match(result.envFile, /AUDIT_CONTROLLER_CREDENTIAL_SOURCE=AUDIT_CONTROLLER_GITHUB_TOKEN/);
  assert.match(result.envFile, /primary-good/);
});

test('runtime selector falls back when the primary token is present but invalid', () => {
  const result = runSelector({ primary: 'primary-dead', fallback: 'fallback-good', successToken: 'fallback-good' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.probed, ['primary-dead', 'fallback-good']);
  assert.match(result.envFile, /AUDIT_CONTROLLER_CREDENTIAL_SOURCE=PREFLIGHTSIM_GITHUB_TOKEN/);
  assert.match(result.envFile, /fallback-good/);
  assert.doesNotMatch(result.envFile, /primary-dead/);
});

test('runtime selector fails closed when a working token is required', () => {
  const result = runSelector({ primary: 'primary-dead', fallback: 'fallback-dead', successToken: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No configured Audit-Controller credential successfully authenticated/);
});

test('runtime selector can remain empty for optional watchdog access', () => {
  const result = runSelector({ primary: 'primary-dead', fallback: 'fallback-dead', successToken: '', required: 'false' });
  assert.equal(result.status, 0);
  assert.match(result.envFile, /^AUDIT_CONTROLLER_GITHUB_TOKEN=$/m);
  assert.match(result.envFile, /AUDIT_CONTROLLER_CREDENTIAL_SOURCE=NONE/);
});

test('private workflows use runtime authentication probing rather than presence-only secret fallback', () => {
  for (const relative of [
    '.github/workflows/audit-controller-execution.yml',
    '.github/workflows/v7-execution-infrastructure-qualification.yml',
    '.github/workflows/agent-zip-import-v1.yml',
    '.github/workflows/audit-source-initialization-v1.yml',
    '.github/workflows/browser-agent-watchdog.yml',
  ]) {
    const workflow = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.doesNotMatch(workflow, /AUDIT_CONTROLLER_GITHUB_TOKEN\s*\|\|\s*secrets\.PREFLIGHTSIM_GITHUB_TOKEN/);
    assert.match(workflow, /scripts\/select-audit-controller-token\.sh/);
  }
});

test('every direct private controller checkout selects a probed credential first', () => {
  // Project-specific workflows live in subfolders; cover them too.
  const workflows = fs.readdirSync(path.join(repoRoot, '.github/workflows'), { recursive: true })
    .filter((name) => name.endsWith('.yml'));
  let checked = 0;
  for (const name of workflows) {
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows', name), 'utf8');
    const repositories = [...workflow.matchAll(/^          repository: (curveyield3\/(?:Solo-)?Audit-Controller)$/gm)]
      .map((match) => match[1]);
    if (repositories.length === 0) continue;
    checked += repositories.length;
    const selected = workflow.indexOf('run: bash scripts/select-audit-controller-token.sh');
    const firstCheckout = workflow.indexOf('          repository: ' + repositories[0]);
    assert.ok(selected >= 0 && selected < firstCheckout, name);
    assert.match(workflow, /AUDIT_CONTROLLER_TOKEN_REQUIRED: 'true'/);
    assert.match(workflow, /PREFLIGHTSIM_FALLBACK_TOKEN: \$\{\{ secrets\.PREFLIGHTSIM_GITHUB_TOKEN \}\}/);
    for (const repository of repositories) {
      assert.ok(workflow.includes('AUDIT_CONTROLLER_PROBE_REPOSITORY: ' + repository), name);
    }
    const selectedTokens = [...workflow.matchAll(/^          token: \$\{\{ env\.AUDIT_CONTROLLER_GITHUB_TOKEN \}\}$/gm)];
    assert.equal(selectedTokens.length, repositories.length, name);
    assert.doesNotMatch(workflow, /^          token: \$\{\{ secrets\.AUDIT_CONTROLLER_GITHUB_TOKEN \}\}$/m);
  }
  assert.ok(checked >= 20, 'private controller checkouts must remain covered');
});


test('Audit Source Initialization serializes revision allocation and never cancels an active initialization', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/audit-source-initialization-v1.yml'), 'utf8');
  assert.match(workflow, /group:\s*audit-source-initialization/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test('Audit Source Initialization resolves exactly one five-input request from the triggering commit', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/audit-source-initialization-v1.yml'), 'utf8');
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$GITHUB_SHA"/);
  assert.match(workflow, /Exactly one Audit Source Initialization request file must change per trigger/);
  for (const field of ['source_url','agent_chat_1_url','agent_chat_2_url','agent_chat_3_url','agent_chat_4_url']) {
    assert.match(workflow, new RegExp(field + ':'));
  }
  assert.match(workflow, /validate_chat_url/);
  assert.doesNotMatch(workflow, /git diff-tree/);
});
