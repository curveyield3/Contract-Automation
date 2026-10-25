import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectNativeBuild, compileRepoNativeHardhat, materializeFrozenVendorRootAdapter, collectNativeContractArtifacts } from '../../runner/src/native-build.mjs';
import { runGitHubNativeJob } from '../src/run-job-file.mjs';

const commit = (c) => c.repeat(40);
const sha = (c) => c.repeat(64);

function request(profileId = 'github-native-compile-v2') {
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
    profileId,
    source: {
      repository: 'curveyield3/Audits',
      commit: commit('1'),
      projectPath: 'audit-targets/example'
    },
    configuration: {
      compilers: [{ language: 'solidity', version: '0.8.28' }],
      timeoutMinutes: 20,
      analysis: { slither: { version: '0.11.6' } }
    },
    requestId: `dar-${'2'.repeat(32)}`,
    requestDigest: sha('3')
  };
}

async function hardhatFixture({ lockfile = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v7-native-build-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, devDependencies: { hardhat: '2.29.0' } }));
  await fs.writeFile(path.join(root, 'hardhat.config.js'), 'module.exports = { solidity: "0.8.28" };\n');
  if (lockfile) await fs.writeFile(path.join(root, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3,"packages":{}}\n');
  return root;
}


test('runner-owned adapter materializes the frozen Balancer vendor-root topology without changing source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v7-frozen-vendor-'));
  const workspace = path.join(root, 'workspace');
  const projectRoot = path.join(workspace, 'contracts-repo', 'CurveYield DEX');
  const packageRoots = new Map([
    ['v3-interfaces', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'interfaces')],
    ['v3-vault', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'vault')],
    ['v3-pool-utils', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'pool-utils')],
    ['v3-solidity-utils', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'solidity-utils')],
    ['v3-pool-weighted', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'pool-weighted')],
    ['v3-pool-stable', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'pool-stable')],
    ['v3-pool-hooks', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'pool-hooks')],
    ['v3-pool-reclamm', path.join(workspace, 'vendor', 'balancer-reclamm-upstream')],
    ['v3-standalone-utils', path.join(workspace, 'vendor', 'balancer-v3-upstream', 'pkg', 'standalone-utils')]
  ]);
  for (const target of packageRoots.values()) await fs.mkdir(target, { recursive: true });
  const permit2Target = path.join(projectRoot, 'node_modules', '@uniswap', 'permit2');
  await fs.mkdir(permit2Target, { recursive: true });

  const evidence = await materializeFrozenVendorRootAdapter(projectRoot);
  assert.equal(evidence.status, 'materialized');
  assert.equal(evidence.adapterVersion, 'balancer-frozen-vendor-root-v1');
  assert.equal(evidence.workspaceRelativeToProject, '../..');

  for (const [packageName, target] of packageRoots) {
    const linked = path.join(projectRoot, 'node_modules', '@balancer-labs', packageName);
    assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
    assert.equal(await fs.realpath(linked), await fs.realpath(target));
  }
  const permit2Link = path.join(projectRoot, 'node_modules', 'permit2');
  assert.equal((await fs.lstat(permit2Link)).isSymbolicLink(), true);
  assert.equal(await fs.realpath(permit2Link), await fs.realpath(permit2Target));
});

test('Hardhat native build admission requires a committed npm lockfile', async () => {
  const root = await hardhatFixture({ lockfile: false });
  await assert.rejects(detectNativeBuild(root), /Hardhat exact build requires a committed npm lockfile/);
});

test('Hardhat native build is detected only after config and lockfile admission', async () => {
  const root = await hardhatFixture();
  const detected = await detectNativeBuild(root);
  assert.equal(detected.system, 'hardhat-native');
  assert.equal(detected.lockfile, 'package-lock.json');
  assert.equal(detected.config, 'hardhat.config.js');
});

test('Hardhat native build runs locked dependency install then repository-native compile and records build-info digests', async () => {
  const root = await hardhatFixture();
  await fs.mkdir(path.join(root, 'artifacts-v20', 'build-info'), { recursive: true });
  await fs.writeFile(path.join(root, 'artifacts-v20', 'build-info', 'build-a.json'), '{"solcVersion":"0.8.28"}\n');
  const calls = [];
  const result = await compileRepoNativeHardhat({
    projectRoot: root,
    runCommand: async (call) => {
      calls.push(call);
      return { exitCode: 0, stdout: call.command === 'npx' ? 'Compiled successfully\n' : '', stderr: '' };
    }
  });
  assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npx', '--no-install', 'hardhat', 'compile']
  ]);
  assert.equal(result.system, 'hardhat-native');
  assert.equal(result.status, 'completed');
  assert.equal(result.buildInfo.length, 1);
  assert.equal(result.buildInfo[0].path, 'artifacts-v20/build-info/build-a.json');
  assert.match(result.buildInfo[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.artifacts, []);
});

test('compile-v2 executes exact checkout and build before neutral Slither', async () => {
  const calls = [];
  const result = await runGitHubNativeJob(request(), {
    workspaceRoot: '/tmp/v7-compile-v2',
    checkoutSource: async (source) => {
      calls.push('checkout');
      assert.equal(source.commit, commit('1'));
      return { checkoutRoot: '/tmp/v7-compile-v2/checkout', projectRoot: '/tmp/v7-compile-v2/checkout/audit-targets/example', commit: source.commit };
    },
    buildProject: async () => {
      calls.push('build');
      return { status: 'completed', system: 'hardhat-native', compilerVersion: '0.8.28', artifacts: [] };
    },
    runSlither: async () => {
      calls.push('slither');
      return {
        backend: 'slither', version: '0.11.6', status: 'completed_with_findings', terminal: true,
        componentStatus: 'COMPLETED', continuationDisposition: 'COMPLETE_EVIDENCE', authoritativeFinding: false,
        rawOutput: { exitCode: 255, stdout: '{"success":true,"results":{"detectors":[{}]}}', stderr: '' }
      };
    },
    generateSourceIntelligence: async ({ analysis }) => {
      calls.push('source-intelligence');
      assert.equal(analysis.slither.componentStatus, 'COMPLETED');
      return { schemaVersion: 'curveyield-v7-source-intelligence-technical-bundle-v1', technicalBundleDigest: sha('9') };
    }
  });
  assert.deepEqual(calls, ['checkout', 'build', 'slither', 'source-intelligence']);
  assert.equal(result.profileId, 'github-native-compile-v2');
  assert.equal(result.status, 'completed');
  assert.equal(result.source.commit, commit('1'));
  assert.equal(result.build.system, 'hardhat-native');
  assert.equal(result.analysis.slither.authoritativeFinding, false);
  assert.equal(result.analysisComponentFailureCount, 0);
  assert.equal(result.continuityDisposition, 'COMPLETE_EVIDENCE');
});

test('compile-v2 build admission failure stops before Slither and preserves typed process evidence', async () => {
  const calls = [];
  const result = await runGitHubNativeJob(request(), {
    workspaceRoot: '/tmp/v7-compile-fail',
    checkoutSource: async (source) => {
      calls.push('checkout');
      return { checkoutRoot: '/tmp/v7-compile-fail/checkout', projectRoot: '/tmp/v7-compile-fail/checkout/audit-targets/example', commit: source.commit };
    },
    buildProject: async () => {
      calls.push('build');
      const error = new Error('Repository-native Hardhat compilation failed');
      error.code = 'native_build_failed';
      error.result = { exitCode: 1, stdout: 'compile stdout', stderr: 'compile stderr' };
      throw error;
    },
    runSlither: async () => {
      calls.push('slither');
      throw new Error('Slither must not run after failed build admission');
    }
  });
  assert.deepEqual(calls, ['checkout', 'build']);
  assert.equal(result.status, 'failed');
  assert.equal(result.profileId, 'github-native-compile-v2');
  assert.equal(result.error.message, 'Repository-native Hardhat compilation failed');
  assert.equal(result.error.code, 'native_build_failed');
  assert.deepEqual(result.error.commandEvidence, { exitCode: 1, stdout: 'compile stdout', stderr: 'compile stderr' });
  assert.equal(result.analysis.slither, undefined);
  assert.equal(result.analysisComponentFailureCount, 0);
  assert.equal(result.continuityDisposition, 'COMPLETE_EVIDENCE');
});

test('Hardhat artifacts carry the exact build-info unit even when a shared contract is compiled in several units', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hardhat-shared-unit-'));
  const dir = path.join(root, 'artifacts', 'build-info');
  await fs.mkdir(dir, { recursive: true });
  const info = (contracts) => JSON.stringify({ solcVersion: '0.8.28', input: { sources: {} }, output: { contracts } });
  const shared = { 'lib/IShared.sol': { IShared: { abi: [], evm: { bytecode: { object: '' }, deployedBytecode: { object: '' } } } } };
  await fs.writeFile(path.join(dir, 'a.json'), info({ ...shared, 'src/A.sol': { A: { abi: [], evm: { bytecode: { object: '6000' }, deployedBytecode: { object: '6001' } } } } }));
  await fs.writeFile(path.join(dir, 'b.json'), info({ ...shared, 'src/B.sol': { B: { abi: [], evm: { bytecode: { object: '6002' }, deployedBytecode: { object: '6003' } } } } }));
  const artifacts = await collectNativeContractArtifacts(root);
  assert.deepEqual(artifacts.map((a) => [`${a.sourceName}:${a.contractName}`, a.compilationUnitId]), [
    ['lib/IShared.sol:IShared', 'hardhat-build-info-1'],
    ['src/A.sol:A', 'hardhat-build-info-1'],
    ['src/B.sol:B', 'hardhat-build-info-2']
  ]);
});
