function asInteger(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    const parsed = Number(BigInt(value));
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`Invalid ${label}: ${value}`);
}

async function rpcCall(rpcUrl, method, params, fetchImpl, id) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  if (!response?.ok) {
    throw new Error(`Archive RPC ${method} returned HTTP ${response?.status ?? 'unknown'}`);
  }
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(`Archive RPC ${method} failed: ${payload.error.message ?? 'unknown JSON-RPC error'}`);
  }
  return payload?.result;
}

function blockEvidence(block, expectedBlock) {
  if (!block || typeof block !== 'object') throw new Error(`Pinned archive block ${expectedBlock} is unavailable`);
  const number = asInteger(block.number, 'block number');
  if (number !== expectedBlock) throw new Error(`Archive RPC returned block ${number}, expected ${expectedBlock}`);
  const transactions = Array.isArray(block.transactions) ? block.transactions : [];
  return {
    number,
    hash: block.hash ?? null,
    parentHash: block.parentHash ?? null,
    stateRoot: block.stateRoot ?? null,
    transactionsRoot: block.transactionsRoot ?? null,
    receiptsRoot: block.receiptsRoot ?? null,
    timestamp: block.timestamp === undefined || block.timestamp === null ? null : asInteger(block.timestamp, 'block timestamp'),
    transactionCount: transactions.length,
    firstTransactionHash: typeof transactions[0] === 'string' ? transactions[0] : (transactions[0]?.hash ?? null)
  };
}

function transactionEvidence(transaction) {
  if (!transaction || typeof transaction !== 'object') return null;
  return {
    hash: transaction.hash ?? null,
    blockNumber: transaction.blockNumber === undefined || transaction.blockNumber === null ? null : asInteger(transaction.blockNumber, 'transaction block number'),
    chainId: transaction.chainId === undefined || transaction.chainId === null ? null : asInteger(transaction.chainId, 'transaction chain id'),
    from: transaction.from ?? null,
    to: transaction.to ?? null,
    type: transaction.type === undefined || transaction.type === null ? null : asInteger(transaction.type, 'transaction type')
  };
}

export async function probeArchiveRpcIdentity({
  rpcUrl,
  block,
  expectedChainId,
  fetchImpl = globalThis.fetch
}) {
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) throw new Error('Archive RPC URL is required');
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('Pinned archive block must be a non-negative safe integer');
  if (!Number.isSafeInteger(expectedChainId) || expectedChainId < 1) throw new Error('Expected chain id must be a positive safe integer');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const remoteChainId = asInteger(await rpcCall(rpcUrl, 'eth_chainId', [], fetchImpl, 1), 'remote chain id');
  const remoteNetworkId = asInteger(await rpcCall(rpcUrl, 'net_version', [], fetchImpl, 2), 'remote network id');
  const blockTag = `0x${block.toString(16)}`;
  const rawBlock = await rpcCall(rpcUrl, 'eth_getBlockByNumber', [blockTag, false], fetchImpl, 3);
  const pinnedBlock = blockEvidence(rawBlock, block);
  const rawTransaction = pinnedBlock.firstTransactionHash
    ? await rpcCall(rpcUrl, 'eth_getTransactionByHash', [pinnedBlock.firstTransactionHash], fetchImpl, 4)
    : null;

  return {
    schemaVersion: 'phase7-archive-rpc-identity-v1',
    expectedChainId,
    remoteChainId,
    remoteNetworkId,
    chainIdMatchesExpected: remoteChainId === expectedChainId,
    networkIdMatchesExpected: remoteNetworkId === expectedChainId,
    block: pinnedBlock,
    sampleTransaction: transactionEvidence(rawTransaction)
  };
}
