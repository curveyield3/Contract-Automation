import {createHash} from 'node:crypto';
import { startAnvilEngine } from '../../runner/src/anvil-engine.mjs';
import { V7_POLICY } from './v7-policy.mjs';

export const PHASE6_MUTABLE_RPC_ENV = V7_POLICY.mutableRpc.ethereumProfile;
export const PHASE6_MUTABLE_RPC_CHAIN = V7_POLICY.mutableRpc.chain;
export const PHASE6_MUTABLE_RPC_CHAIN_ID = V7_POLICY.mutableRpc.chainId;

function hexQuantity(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${label} must be a hex quantity`);
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} exceeds safe integer range`);
  return parsed;
}

async function rpcCall(url, method, params, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response?.ok) throw new Error(`mutable Anvil RPC ${method} returned HTTP ${response?.status ?? 'unknown'}`);
  const payload = await response.json();
  if (payload?.error) throw new Error(`mutable Anvil RPC ${method} failed: ${payload.error.message ?? 'unknown error'}`);
  if (payload?.result === undefined || payload?.result === null) throw new Error(`mutable Anvil RPC ${method} returned no result`);
  return payload.result;
}

async function probeLiveTargetAndMutability(url, targets, fetchImpl) {
  const attested=[];
  for(const target of targets){
    if(!/^0x[0-9a-fA-F]{40}$/.test(String(target.address??''))||
       !/^[0-9a-fA-F]{64}$/.test(String(target.runtimeSha256??'')))
      throw new Error('LIVE_FORK_TARGET_BINDING_INVALID');
    const code=await rpcCall(url,'eth_getCode',[target.address,'latest'],fetchImpl);
    if(!/^0x(?:[0-9a-fA-F]{2})+$/.test(String(code??'')))throw new Error('LIVE_FORK_DEPLOYED_CODE_MISSING');
    const hash=createHash('sha256').update(Buffer.from(code.slice(2),'hex')).digest('hex');
    if(hash.toLowerCase()!==target.runtimeSha256.toLowerCase())
      throw new Error('LIVE_FORK_DEPLOYED_CODE_MISMATCH: '+target.address);
    attested.push({address:target.address,qualifiedName:target.qualifiedName??null,runtimeSha256:hash});
  }
  // Probe writes on the private local Anvil endpoint only. Revert all mutations.
  const probe='0x000000000000000000000000000000000000bEEF';
  const before=await rpcCall(url,'eth_getBalance',[probe,'latest'],fetchImpl);
  const snapshot=await rpcCall(url,'evm_snapshot',[],fetchImpl);
  if(typeof snapshot!=='string')throw new Error('LIVE_FORK_SNAPSHOT_UNAVAILABLE');
  let writeSucceeded=false;
  let reverted=false;
  try{
    const replacement=BigInt(before)==1n?'0x2':'0x1';
    const payload=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'anvil_setBalance',params:[probe,replacement]})});
    const response=await payload.json();
    if(!payload.ok||response?.error||!Object.hasOwn(response,'result'))
      throw new Error('LIVE_FORK_MUTABLE_WRITE_FAILED');
    const balance=await rpcCall(url,'eth_getBalance',[probe,'latest'],fetchImpl);
    if(BigInt(balance)!==BigInt(replacement))throw new Error('LIVE_FORK_MUTABLE_WRITE_NOT_OBSERVED');
    writeSucceeded=true;
  }finally{
    reverted=(await rpcCall(url,'evm_revert',[snapshot],fetchImpl))===true;
  }
  if(!reverted||!writeSucceeded||
    BigInt(await rpcCall(url,'eth_getBalance',[probe,'latest'],fetchImpl))!==BigInt(before))
    throw new Error('LIVE_FORK_MUTABLE_ROLLBACK_FAILED');
  return {status:'PASS',targets:attested,mutableWriteObserved:true,snapshotReverted:true};
}

async function probeNormalizedRpc(url, fetchImpl, { frozenBlockNumber = null, frozenBlockHash = null } = {}) {
  const chainIdHex = await rpcCall(url, 'eth_chainId', [], fetchImpl);
  const chainId = hexQuantity(chainIdHex, 'eth_chainId');
  const requestPinned = Number.isSafeInteger(frozenBlockNumber) && frozenBlockNumber >= 0 && typeof frozenBlockHash === 'string';
  const blockNumberHex = requestPinned
    ? `0x${frozenBlockNumber.toString(16)}`
    : await rpcCall(url, 'eth_blockNumber', [], fetchImpl);
  const blockNumber = hexQuantity(blockNumberHex, requestPinned ? 'frozenBlockNumber' : 'eth_blockNumber');
  const block = await rpcCall(url, 'eth_getBlockByNumber', [blockNumberHex, false], fetchImpl);
  const blockHash = typeof block?.hash === 'string' ? block.hash : null;
  const chainIdMatchesExpected = chainId === PHASE6_MUTABLE_RPC_CHAIN_ID;
  const blockHashMatchesExpected = requestPinned ? blockHash?.toLowerCase() === frozenBlockHash.toLowerCase() : Boolean(blockHash);
  return {
    status: chainIdMatchesExpected && Boolean(blockHash) && blockHashMatchesExpected ? 'PASS' : 'FAIL',
    chainId,
    chainIdMatchesExpected,
    blockNumber,
    blockHash,
    requestPinned,
    expectedBlockNumber: requestPinned ? frozenBlockNumber : null,
    expectedBlockHash: requestPinned ? frozenBlockHash : null,
    blockHashMatchesExpected,
  };
}

export function resolvePhase6MutableRpcUrl(environment = process.env) {
  const url = environment?.[PHASE6_MUTABLE_RPC_ENV];
  if (typeof url !== 'string' || url.length === 0) throw new Error('Ethereum fork RPC URL is required for Phase 6 local-Anvil execution');
  return url;
}

function failedSessionEvidence(failureKind, reason) {
  return {
    status: 'FAIL', failureKind, profile: PHASE6_MUTABLE_RPC_ENV, chain: PHASE6_MUTABLE_RPC_CHAIN,
    expectedChainId: PHASE6_MUTABLE_RPC_CHAIN_ID, reason,
    backendPolicy: V7_POLICY.mutableRpc.backendPolicy,
    requesterSuppliedRpcAllowed: V7_POLICY.mutableRpc.requesterSuppliedRpcAllowed,
    rpcUrlExposedInEvidence: false,
  };
}

async function probeUpstreamChainId(url, fetchImpl) {
  try {
    return hexQuantity(await rpcCall(url, 'eth_chainId', [], fetchImpl), 'upstream eth_chainId');
  } catch {
    return null;
  }
}

export async function createPhase6MutableRpcSession({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  startEngine = startAnvilEngine,
  frozenBlockNumber = null,
  frozenBlockHash = null,
  attestedTargets = [],
} = {}) {
  let upstreamUrl;
  try { upstreamUrl = resolvePhase6MutableRpcUrl(environment); }
  catch (error) {
    return { evidence: failedSessionEvidence('MUTABLE_RPC_SOURCE_MISSING', error.message), runtime: null, async close() {} };
  }

  let engine;
  try {
    const suppliedNumber=frozenBlockNumber!==null&&frozenBlockNumber!==undefined;
    const suppliedHash=frozenBlockHash!==null&&frozenBlockHash!==undefined;
    if(suppliedNumber!==suppliedHash)throw new Error('HISTORICAL_PIN_INCOMPLETE: both block and hash must be supplied together');
    const requestPinned = suppliedNumber
      && Number.isSafeInteger(frozenBlockNumber) && frozenBlockNumber >= 0
      && /^0x[0-9a-fA-F]{64}$/.test(String(frozenBlockHash));
    if(suppliedNumber&&!requestPinned)throw new Error('HISTORICAL_PIN_INVALID');
    let admittedBlockNumber=frozenBlockNumber;
    let admittedBlockHash=frozenBlockHash;
    // Even the no-explicit-pin route freezes a real block from the approved
    // archive upstream before creating the mutable Anvil. 'latest' must never
    // mean an unbound changing fork that cannot be independently reconciled.
    if(!requestPinned){
      const head=hexQuantity(await rpcCall(upstreamUrl,'eth_blockNumber',[],fetchImpl),'upstream eth_blockNumber');
      const block=await rpcCall(upstreamUrl,'eth_getBlockByNumber',[`0x${head.toString(16)}`,false],fetchImpl);
      if(head<1||Number(BigInt(block?.number??'0x0'))!==head||
         !/^0x[0-9a-fA-F]{64}$/.test(String(block?.hash??'')))
        throw new Error('ARCHIVE_UPSTREAM_BLOCK_HASH_UNAVAILABLE');
      admittedBlockNumber=head; admittedBlockHash=block.hash;
    }
    const placeholderArtifacts = { get() { throw new Error('Phase 6 local-Anvil session does not deploy artifacts directly'); } };
    engine = await startEngine({
      artifacts: placeholderArtifacts,
      workflow: { steps: [] },
      chainId: PHASE6_MUTABLE_RPC_CHAIN_ID,
      forkUrl: upstreamUrl,
      block: admittedBlockNumber,
      evmVersion: 'cancun',
      quiet: true,
      fetchImpl,
    });

    const normalized = await probeNormalizedRpc(engine.url, fetchImpl, { frozenBlockNumber: admittedBlockNumber, frozenBlockHash: admittedBlockHash });
    const upstreamChainId = await probeUpstreamChainId(upstreamUrl, fetchImpl);
    if (normalized.status !== 'PASS') {
      await engine.close().catch(() => {});
      return {
        evidence: {
          ...failedSessionEvidence(
            normalized.requestPinned && normalized.blockHashMatchesExpected === false
              ? 'MUTABLE_RPC_FROZEN_BLOCK_MISMATCH'
              : 'MUTABLE_RPC_IDENTITY_FAILURE',
            normalized.requestPinned && normalized.blockHashMatchesExpected === false
              ? 'Local Phase 6 Anvil did not return the admitted frozen block hash'
              : 'Local Phase 6 Anvil did not reconcile to Ethereum'
          ),
          observedChainId: normalized.chainId,
          chainIdMatchesExpected: normalized.chainIdMatchesExpected,
          blockNumber: normalized.blockNumber,
          blockHash: normalized.blockHash,
          requestPinned, pinSource: requestPinned ? 'REQUEST_FROZEN_BLOCK_HASH' : 'AUTHENTICATED_UPSTREAM_HEAD_FROZEN',
      ...(deployedTargetAttestation?{deployedTargetAttestation}:{}),
          expectedBlockNumber: normalized.expectedBlockNumber,
          expectedBlockHash: normalized.expectedBlockHash,
          blockHashMatchesExpected: normalized.blockHashMatchesExpected,
          identityNormalization: {
            status: 'FAIL', observedUpstreamChainId: upstreamChainId, observedNormalizedChainId: normalized.chainId,
            upstreamIdentityVirtualized: upstreamChainId === null ? null : upstreamChainId !== PHASE6_MUTABLE_RPC_CHAIN_ID,
            mode: 'LOCAL_EPHEMERAL_ANVIL_FORK',
          },
        },
        runtime: null,
        async close() {},
      };
    }

    let deployedTargetAttestation=null;
    if(Array.isArray(attestedTargets)&&attestedTargets.length>0){
      deployedTargetAttestation=await probeLiveTargetAndMutability(engine.url,attestedTargets,fetchImpl);
    }
    let closed = false;
    const evidence = {
      status: 'PASS', failureKind: null, profile: PHASE6_MUTABLE_RPC_ENV, chain: PHASE6_MUTABLE_RPC_CHAIN,
      expectedChainId: PHASE6_MUTABLE_RPC_CHAIN_ID, observedChainId: normalized.chainId, chainIdMatchesExpected: true,
      blockNumber: normalized.blockNumber, blockHash: normalized.blockHash,
      requestPinned, pinSource: requestPinned ? 'REQUEST_FROZEN_BLOCK_HASH' : 'AUTHENTICATED_UPSTREAM_HEAD_FROZEN',
      expectedBlockNumber: normalized.expectedBlockNumber,
      expectedBlockHash: normalized.expectedBlockHash,
      blockHashMatchesExpected: normalized.blockHashMatchesExpected,
      backendPolicy: V7_POLICY.mutableRpc.backendPolicy,
      requesterSuppliedRpcAllowed: V7_POLICY.mutableRpc.requesterSuppliedRpcAllowed,
      rpcUrlExposedInEvidence: false,
      identityNormalization: {
        status: 'PASS', observedUpstreamChainId: upstreamChainId, observedNormalizedChainId: normalized.chainId,
        upstreamIdentityVirtualized: upstreamChainId === null ? null : upstreamChainId !== PHASE6_MUTABLE_RPC_CHAIN_ID,
        mode: 'LOCAL_EPHEMERAL_ANVIL_FORK', rawIdentityProbeBypassUsed: false,
      },
    };
    const runtime = {
      url: engine.url, blockNumber: normalized.blockNumber, blockHash: normalized.blockHash,
      requestPinned, pinSource: requestPinned ? 'REQUEST_FROZEN_BLOCK_HASH' : 'AUTHENTICATED_UPSTREAM_HEAD_FROZEN',
      chain: PHASE6_MUTABLE_RPC_CHAIN, chainId: PHASE6_MUTABLE_RPC_CHAIN_ID,
      profile: PHASE6_MUTABLE_RPC_ENV, identityNormalized: true,
    };
    return {
      evidence,
      runtime,
      async close() {
        if (closed) return;
        closed = true;
        await engine.close();
      },
    };
  } catch (error) {
    if (engine) await engine.close().catch(() => {});
    return {
      evidence: failedSessionEvidence(
        /^LIVE_FORK_[A-Z_]+/.exec(String(error?.message??error))?.[0]??'MUTABLE_RPC_PROBE_FAILURE',
        redactMutableRpcSecret(error?.message??String(error),upstreamUrl)),
      runtime: null,
      async close() {},
    };
  }
}

export async function probePhase6MutableRpc(options = {}) {
  const session = await createPhase6MutableRpcSession(options);
  try { return structuredClone(session.evidence); }
  finally { await session.close().catch(() => {}); }
}

export function phase6MutableRpcRuntime({ session } = {}) {
  if (session?.evidence?.status !== 'PASS' || !session?.runtime?.url) throw new Error('Phase 6 mutable RPC runtime requires an active passing identity-normalized RPC session');
  return { ...session.runtime };
}

export function redactMutableRpcSecret(value, secret) {
  const text = String(value ?? '');
  if (typeof secret !== 'string' || secret.length === 0) return text;
  return text.replaceAll(secret, '<redacted-mutable-anvil-rpc>');
}
