import { startRpcIdentityProxy } from './rpc-identity-proxy-v1.mjs';
import { WorkflowRuntime } from './workflow-runtime.mjs';

export { WorkflowRuntime as GanacheWorkflowRuntime } from './workflow-runtime.mjs';

function collectLiteralActors(workflow) {
  const actors = new Set();
  for (const step of workflow.steps) {
    for (const key of ['from']) {
      const value = step[key];
      if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) actors.add(value);
    }
  }
  return [...actors];
}

export function buildGanacheOptions({ workflow, chainId, forkUrl, block = 'latest', quiet = true }) {
  const unlockedAccounts = collectLiteralActors(workflow);
  const options = {
    logging: { quiet },
    chain: { chainId, networkId: chainId, allowUnlimitedContractSize: false },
    wallet: { deterministic: true, totalAccounts: 20, unlockedAccounts }
  };
  if (forkUrl) {
    options.fork = { url: forkUrl };
    if (block !== 'latest') options.fork.blockNumber = block;
  }
  return options;
}

async function closeGanacheServer(server) {
  if (!server) return;
  try {
    await server.close();
  } catch (error) {
    if (!String(error?.message ?? '').toLowerCase().includes('not running')) throw error;
  }
}

export async function startGanacheEngine({
  artifacts,
  workflow,
  chainId,
  forkUrl,
  block = 'latest',
  quiet = true
}) {
  const ganacheModule = await import('ganache');
  const ethers = await import('ethers');
  const ganache = ganacheModule.default ?? ganacheModule;
  let identityProxy = null;
  let server = null;
  let provider = null;

  try {
    if (forkUrl) {
      identityProxy = await startRpcIdentityProxy({ upstreamUrl: forkUrl, chainId });
    }
    const options = identityProxy
      ? buildGanacheOptions({ workflow, chainId, forkUrl: identityProxy.url, block, quiet })
      : buildGanacheOptions({ workflow, chainId, forkUrl, block, quiet });
    server = ganache.server(options);
    await server.listen(0, '127.0.0.1');
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}`;
    provider = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
    const accounts = await provider.send('eth_accounts', []);

    const runtime = new WorkflowRuntime({ provider, artifacts, ethers });
    const aliases = Object.fromEntries(accounts.map((account, index) => [`account${index}`, account]));
    let closed = false;
    return {
      server,
      provider,
      runtime,
      aliases,
      url,
      async close() {
        if (closed) return;
        closed = true;
        const errors = [];
        try { await provider.destroy(); } catch (error) { errors.push(error); }
        try { await closeGanacheServer(server); } catch (error) { errors.push(error); }
        try { if (identityProxy) await identityProxy.close(); } catch (error) { errors.push(error); }
        if (errors.length > 0) throw errors[0];
      }
    };
  } catch (error) {
    try { if (provider) await provider.destroy(); } catch {}
    try { await closeGanacheServer(server); } catch {}
    try { if (identityProxy) await identityProxy.close(); } catch {}
    throw error;
  }
}
