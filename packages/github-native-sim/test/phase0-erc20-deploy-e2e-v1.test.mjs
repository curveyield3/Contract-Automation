// Phase-0 deploy lane end to end on a tiny ERC20 fixture: real forge scripts, real Anvil forks, real gate.
// A local Anvil plays the upstream chain, so no RPC secret is needed. Requires forge and anvil on PATH;
// the mandatory "Phase 0 Deployment Only Regression" workflow sets PHASE0_E2E=1 so it never silently skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  startAnvil, detectDeploymentScripts, executeDeploymentScripts, executeDeploymentProfileV1, discoverDeployments
} from '../src/phase0-randomized-simulation-v1.mjs';
import { loadDeploymentProfile, phase0ForkChainForProfile } from '../src/phase0-deployment-profile-v1.mjs';
import { assertDeployGateEvidenceV2 } from '../../../scripts/lib/phase0-deploy-gate-v2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const FIXTURE = path.join(here, 'fixtures/phase0-erc20-v1');
const DEPLOYER = '0x11b78837cadC8E894F1c6e13fA9f3A085a75FA35';
const REQUIRED = process.env.PHASE0_E2E === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return (await res.json()).result;
}
async function upstream(chainId, port) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'node_modules/@foundry-rs/anvil/bin.mjs'), '--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if (await rpc(url, 'eth_chainId')) {
        // Production requires a positive, hash-pinned historical block. A fresh
        // fixture Anvil starts at genesis (block 0), so mine one real fixture block.
        await rpc(url, 'evm_mine');
        const block = await rpc(url, 'eth_getBlockByNumber', ['latest', false]);
        if (BigInt(block?.number ?? 0) > 0n && /^0x[0-9a-f]{64}$/i.test(block?.hash ?? '')) return { url, child };
      }
    } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL'); throw new Error('upstream anvil did not start');
}
async function stage(name, profile) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `phase0-erc20-${name}-`));
  await fs.cp(FIXTURE, root, { recursive: true });
  if (profile) await fs.writeFile(path.join(root, 'audit-deployment.json'), JSON.stringify(profile));
  return root;
}
async function artifactsFrom(root) {
  const j = JSON.parse(await fs.readFile(path.join(root, 'out/MiniToken.sol/MiniToken.json'), 'utf8'));
  return [{ sourceName: 'src/MiniToken.sol', contractName: 'MiniToken', abi: j.abi, bytecode: j.bytecode.object, deployedBytecode: j.deployedBytecode.object }];
}
// Same witness shape and accounting as the production deploy-only lane.
function evidence({ deployment, deployed, anvil, chain, profile }) {
  return {
    schemaVersion: 'curveyield-lite-phase0-deploy-config-execution-v3', executionMode: 'ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY',
    status: deployment.status === 'PASS' ? 'PASS' : 'BLOCKED_SCRIPT_FAILURE',
    fork: { engine: 'anvil', source: chain.rpcSecret, chain: chain.chain, chainId: chain.chainId, upstreamChainId: anvil.upstreamChainId, identityNormalized: anvil.identityNormalized === true },
    deploymentProfile: profile ? { chain: profile.chain, chainId: profile.chainId } : null,
    scriptDispositions: deployment.scriptDispositions, attempts: deployment.attempts, deployedContracts: deployed,
    gaps: deployment.limitations, limitations: deployment.limitations,
    coverage: { detectedScripts: deployment.scriptDispositions.length, executedScripts: deployment.attempts.length, passedScripts: deployment.attempts.filter(a => a.status === 'PASS').length, failedOrUnsupportedScripts: deployment.scriptDispositions.filter(r => r.disposition !== 'EXECUTED_PASS').length, excludedScripts: 0 }
  };
}
async function runLane({ name, upstreamChainId, port, profile }) {
  const up = await upstream(upstreamChainId, port);
  let anvil;
  try {
    const root = await stage(name, profile);
    const loaded = profile ? await loadDeploymentProfile(root) : null;
    const chain = phase0ForkChainForProfile(loaded);
    anvil = await startAnvil({ forkUrl: up.url, projectRoot: root, evmVersion: 'cancun', chainId: chain.chainId, requireUpstreamChainId: Boolean(loaded) });
    const provider = new ethers.JsonRpcProvider(anvil.url, chain.chainId, { staticNetwork: true });
    const start = Number(await provider.getBlockNumber());
    const deployment = loaded
      ? await executeDeploymentProfileV1({ projectRoot: root, anvilUrl: anvil.url, profile: loaded, chain })
      : await executeDeploymentScripts({ projectRoot: root, anvilUrl: anvil.url, account0: (await rpc(anvil.url, 'eth_accounts'))[0], localSigner: anvil.localSigner, detected: await detectDeploymentScripts(root) });
    for (const a of deployment.attempts) assert.equal(a.status, 'PASS', `${name}: ${a.stdout}\n${a.stderr}`);
    const deployed = await discoverDeployments({ provider, artifacts: await artifactsFrom(root), startBlock: start + 1, endBlock: Number(await provider.getBlockNumber()) });
    const token = deployed.find(d => d.contractName === 'MiniToken');
    assert.ok(token, `${name}: MiniToken creation not discovered from bytecode`);
    const erc20 = new ethers.Contract(token.address, ['function balanceOf(address) view returns (uint256)'], provider);
    assert.equal(await erc20.balanceOf('0x0000000000000000000000000000000000007EA5'), 10n ** 18n, `${name}: configuration transfer missing`);
    provider.destroy();
    return { e: evidence({ deployment, deployed, anvil, chain, profile: loaded }), deployment, token };
  } finally {
    try { if (anvil) await anvil.close(); } finally { up.child.kill(); }
  }
}

const available = await fs.access(path.join(repoRoot, 'node_modules/@foundry-rs/anvil/bin.mjs')).then(() => true, () => false);
const skip = !REQUIRED && !available ? 'forge/anvil unavailable (set PHASE0_E2E=1 to require)' : false;

test('legacy Ethereum lane: detected forge script deploys and configures; gate passes', { skip, timeout: 240000 }, async () => {
  const { e } = await runLane({ name: 'legacy', upstreamChainId: 1, port: 9545 });
  assert.equal(e.fork.chainId, 1);
  assert.equal(assertDeployGateEvidenceV2(e), true);
});

test('Ethereum profile lane: declared script runs as the impersonated deployer; gate passes', { skip, timeout: 240000 }, async () => {
  const { e, deployment } = await runLane({ name: 'eth-profile', upstreamChainId: 1, port: 9546,
    profile: { schemaVersion: 'curveyield-audit-deployment-v1', chain: 'ethereum', deployer: DEPLOYER, scripts: ['script/DeployToken.s.sol:DeployToken'] } });
  assert.equal(deployment.attempts[0].sender, DEPLOYER);
  assert.equal(assertDeployGateEvidenceV2(e), true);
});

test('Katana profile lane: real-chain upstream required, chain 747474 fork, gate binds profile', { skip, timeout: 240000 }, async () => {
  const profile = { schemaVersion: 'curveyield-audit-deployment-v1', chain: 'katana', deployer: DEPLOYER, scripts: ['script/DeployToken.s.sol:DeployToken'] };
  const { e } = await runLane({ name: 'katana-profile', upstreamChainId: 747474, port: 9547, profile });
  assert.equal(e.fork.chainId, 747474);
  assert.equal(e.fork.upstreamChainId, 747474);
  assert.equal(assertDeployGateEvidenceV2(e), true);
  assert.throws(() => assertDeployGateEvidenceV2({ ...e, deploymentProfile: null }), /fork/i);
  // A wrong-chain secret is refused before any script runs.
  const wrong = await upstream(1, 9548);
  try {
    const root = await stage('katana-wrong', profile);
    await assert.rejects(startAnvil({ forkUrl: wrong.url, projectRoot: root, chainId: 747474, requireUpstreamChainId: true }), /PHASE0_FORK_RPC_WRONG_CHAIN|requires chainId=747474/);
  } finally { wrong.child.kill(); }
});
