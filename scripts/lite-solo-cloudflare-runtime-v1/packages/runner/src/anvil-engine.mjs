import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WorkflowRuntime } from './workflow-runtime.mjs';
import { startRpcIdentityProxy } from './rpc-identity-proxy-v1.mjs';

const ANVIL_READY_TIMEOUT_MS = 20_000;

export function selectForkEngineName(_evmVersion) {
  return 'anvil';
}

export function buildAnvilArgs({ chainId, forkUrl, block = 'latest', port, hardfork, loadStatePath = null }) {
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Anvil chainId must be a positive safe integer');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Anvil port must be 1-65535');
  if (typeof forkUrl !== 'string' || forkUrl.length === 0) throw new Error('Anvil fork URL is required for all executions, including saved-state replay');
  if(loadStatePath&&(!path.isAbsolute(loadStatePath)||!loadStatePath.endsWith('.json')))throw new Error('snapshot loadStatePath must be absolute JSON');
  if (typeof hardfork !== 'string' || hardfork.length === 0) throw new Error('Anvil hardfork is required');
  const args = [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--chain-id', String(chainId),
    '--hardfork', hardfork
  ];
  // Saved state contains touched accounts; untouched fork state stays on the
  // exact pinned upstream fork. A state-only Anvil silently drops those accounts.
  args.push('--fork-url',forkUrl);
  if(block!=='latest')args.push('--fork-block-number',String(block));
  if(loadStatePath)args.push('--load-state',loadStatePath,'--auto-impersonate');
  args.push('--accounts', '20', '--silent');
  return args;
}

export function buildAnvilLaunchSpec({
  cwd = process.cwd(),
  execPath = process.execPath,
  anvilArgs = []
} = {}) {
  return {
    command: execPath,
    args: [path.resolve(cwd, 'node_modules/@foundry-rs/anvil/bin.mjs'), ...anvilArgs]
  };
}

export function waitForChildSpawn(child) {
  if (!child || typeof child.once !== 'function') {
    return Promise.reject(new Error('Anvil process handle is invalid'));
  }
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener?.('error', onError);
      resolve();
    };
    const onError = (error) => {
      child.removeListener?.('spawn', onSpawn);
      reject(new Error(`Anvil process failed to spawn: ${error?.message ?? String(error)}`, { cause: error }));
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export function createAnvilProviderAdapter(provider) {
  if (!provider || typeof provider.send !== 'function') throw new Error('Anvil provider is required');
  return new Proxy(provider, {
    get(target, property) {
      if (property === 'send') {
        return async (method, params = []) => target.send(
          method === 'evm_setAccountBalance' ? 'anvil_setBalance' : method,
          params
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function collectLiteralActors(workflow) {
  const actors = new Set();
  for (const step of workflow?.steps ?? []) {
    const value = step?.from;
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) actors.add(value.toLowerCase());
  }
  return [...actors];
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForAnvilRpc({ url, child, timeoutMs = ANVIL_READY_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error('Anvil exited before JSON-RPC became ready');
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })
      });
      if (response?.ok) {
        const payload = await response.json();
        if (payload?.result) return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error('Anvil JSON-RPC readiness timeout');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const timedOut = sleep(2_000).then(() => 'timeout');
  if (await Promise.race([exited, timedOut]) === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

export async function startAnvilEngine({
  artifacts,
  workflow,
  chainId,
  forkUrl,
  block = 'latest',
  evmVersion = 'cancun',
  loadStatePath = null,
  quiet = true,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  cwd = process.cwd(),
  execPath = process.execPath
}) {
  let identityProxy = null;
  let child = null;
  let provider = null;
  try {
    identityProxy = await startRpcIdentityProxy({ upstreamUrl: forkUrl, chainId, fetchImpl });
    const port = await reserveLoopbackPort();
    const anvilArgs = buildAnvilArgs({
      chainId,
      forkUrl: identityProxy?.url ?? forkUrl,
      loadStatePath,
      block,
      port,
      hardfork: String(evmVersion).toLowerCase()
    });
    const launch = buildAnvilLaunchSpec({ cwd, execPath, anvilArgs });
    child = spawnImpl(launch.command, launch.args, {
      cwd,
      env: process.env,
      stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit'
    });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    await waitForChildSpawn(child);
    const url = `http://127.0.0.1:${port}`;
    try {
      await waitForAnvilRpc({ url, child, fetchImpl });
    } catch (error) {
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
      throw new Error(`${error.message}${suffix}`, { cause: error });
    }

    const ethers = await import('ethers');
    const realProvider = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
    provider = createAnvilProviderAdapter(realProvider);
    const accounts = await provider.send('eth_accounts', []);
    for (const actor of collectLiteralActors(workflow)) {
      await provider.send('anvil_impersonateAccount', [actor]);
    }
    const runtime = new WorkflowRuntime({ provider, artifacts, ethers });
    const aliases = Object.fromEntries(accounts.map((account, index) => [`account${index}`, account]));
    let closed = false;
    return {
      child,
      provider,
      runtime,
      aliases,
      url,
      engine: 'anvil',
      async close() {
        if (closed) return;
        closed = true;
        const errors = [];
        try { await realProvider.destroy(); } catch (error) { errors.push(error); }
        try { await stopChild(child); } catch (error) { errors.push(error); }
        try { if (identityProxy) await identityProxy.close(); } catch (error) { errors.push(error); }
        if (errors.length > 0) throw errors[0];
      }
    };
  } catch (error) {
    try { if (provider?.destroy) await provider.destroy(); } catch {}
    try { await stopChild(child); } catch {}
    try { if (identityProxy) await identityProxy.close(); } catch {}
    if (String(error?.message ?? '').includes(String(forkUrl))) {
      throw new Error(String(error.message).replaceAll(String(forkUrl), '<redacted-fork-rpc>'), { cause: error });
    }
    throw error;
  }
}

export async function startCompatibleForkEngine(input) {
  return startAnvilEngine(input);
}
