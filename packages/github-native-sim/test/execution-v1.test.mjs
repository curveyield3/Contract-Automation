import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  V7ExecutionError,
  runPinnedBuild,
  safeRepositoryProjectPath
} from '../src/execution.mjs';

const commit = (c) => c.repeat(40);
const sha = (c) => c.repeat(64);

function request() {
  return {
    schemaVersion: 'deep-assurance-github-request-v2',
    processId: 'audit-v7-independent-review',
    contractAutomationRelease: {
      repository: 'curveyield3/Contract-Automation',
      branch: 'recovery/v7-execution-layer-v1',
      commit: '612fa50264e587e3f24550bf4dae35719b04211c',
      contractVersion: 'contract-automation-v7-relocated-v1'
    },
    runnerRelease: {
      version: 'deep-assurance-github-bridge-v1',
      manifestSha256: '2bebd99bb8ae770eb2feca0de7dc7e54596127a0c768922189e907e6658773dc'
    },
    campaignId: 'campaign-1',
    assignmentId: 'reviewer-1-phase-1-v1',
    phaseId: 'scope-and-provenance',
    gateId: 'exact-scope-provenance-complete',
    profileId: 'github-native-compile-v2',
    source: {
      repository: 'curveyield3/Audits',
      commit: commit('1'),
      projectPath: 'audit-targets/example'
    },
    configuration: {
      compilers: [{ language: 'solidity', version: '0.8.28' }],
      timeoutMinutes: 20,
      analysis: {}
    },
    requestId: `dar-${'2'.repeat(32)}`,
    requestDigest: sha('3')
  };
}

async function tempFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v7-execution-'));
  const checkoutRoot = path.join(root, 'checkout');
  const projectRoot = path.join(checkoutRoot, 'audit-targets', 'example');
  await fs.mkdir(path.join(projectRoot, 'out'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'out', 'Build.json'), '{"ok":true}\n');
  return { root, checkoutRoot, projectRoot };
}

test('safeRepositoryProjectPath rejects traversal and absolute paths', () => {
  assert.throws(() => safeRepositoryProjectPath('/tmp/root', '../escape'), /UNSAFE_PROJECT_PATH/);
  assert.throws(() => safeRepositoryProjectPath('/tmp/root', '/absolute'), /UNSAFE_PROJECT_PATH/);
  assert.equal(safeRepositoryProjectPath('/tmp/root', 'contracts/core'), path.resolve('/tmp/root/contracts/core'));
});

test('runPinnedBuild rejects a checkout that does not resolve to the requested source commit', async () => {
  const { root } = await tempFixture();
  await assert.rejects(
    runPinnedBuild(request(), {
      workspaceRoot: root,
      build: { command: 'forge', args: ['build'], compiler: { name: 'solc', version: '0.8.28' } },
      checkoutExactSourceFn: async () => ({ commit: commit('9') }),
      runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' })
    }),
    (error) => error instanceof V7ExecutionError && error.kind === 'SOURCE_INTEGRITY_FAILURE'
  );
});

test('runPinnedBuild reports compile failure as a typed failure', async () => {
  const { root } = await tempFixture();
  await assert.rejects(
    runPinnedBuild(request(), {
      workspaceRoot: root,
      build: { command: 'forge', args: ['build'], compiler: { name: 'solc', version: '0.8.28' } },
      checkoutExactSourceFn: async () => ({ commit: commit('1') }),
      runCommand: async () => ({ exitCode: 1, stdout: '', stderr: 'compile failed' })
    }),
    (error) => error instanceof V7ExecutionError && error.kind === 'COMPILE_FAILURE' && error.details.exitCode === 1
  );
});

test('successful pinned build records exact source, compiler identity, command status and artifact digests', async () => {
  const { root } = await tempFixture();
  const result = await runPinnedBuild(request(), {
    workspaceRoot: root,
    build: {
      command: 'forge',
      args: ['build'],
      compiler: { name: 'solc', version: '0.8.28' },
      artifactPaths: ['out/Build.json']
    },
    checkoutExactSourceFn: async ({ repository, commit: requestedCommit, destination }) => ({
      repository,
      commit: requestedCommit,
      destination
    }),
    runCommand: async ({ command, args, cwd }) => ({ exitCode: 0, stdout: `${command} ${args.join(' ')} @ ${cwd}`, stderr: '' })
  });

  assert.equal(result.source.repository, 'curveyield3/Audits');
  assert.equal(result.source.commit, commit('1'));
  assert.equal(result.source.projectPath, 'audit-targets/example');
  assert.deepEqual(result.compiler, { name: 'solc', version: '0.8.28' });
  assert.deepEqual(result.command, { command: 'forge', args: ['build'], exitCode: 0 });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].path, 'out/Build.json');
  assert.match(result.artifacts[0].sha256, /^[0-9a-f]{64}$/);
});
