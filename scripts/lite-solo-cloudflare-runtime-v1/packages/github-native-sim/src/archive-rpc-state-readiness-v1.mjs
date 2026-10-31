function asInteger(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(value)) {
    const parsed = Number(BigInt(value));
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  throw new Error(`Invalid ${label}: ${value}`);
}

function baseEvidence(block, account) {
  return {
    schemaVersion: 'phase7-archive-rpc-state-readiness-v1',
    block,
    account,
    rpcMethod: 'eth_getTransactionCount'
  };
}

async function responsePayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureEvidence(block, account, response, payload) {
  const rpcError = payload?.error;
  const httpStatus = Number.isInteger(response?.status) ? response.status : null;
  return {
    ...baseEvidence(block, account),
    status: 'unavailable',
    error: {
      kind: response?.ok ? 'JSON_RPC_ERROR' : 'HTTP_ERROR',
      httpStatus,
      rpcCode: Number.isInteger(rpcError?.code) ? rpcError.code : null,
      message: typeof rpcError?.message === 'string' && rpcError.message.length > 0
        ? rpcError.message
        : (response?.ok ? 'Archive RPC returned a JSON-RPC error' : 'Archive RPC returned a non-success HTTP status')
    }
  };
}

export async function probeArchiveRpcStateReadiness({
  rpcUrl,
  block,
  account,
  fetchImpl = globalThis.fetch
}) {
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) throw new Error('Archive RPC URL is required');
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('Pinned archive block must be a non-negative safe integer');
  if (typeof account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error('Probe account must be a 20-byte hex address');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const blockTag = `0x${block.toString(16)}`;
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionCount',
        params: [account, blockTag]
      })
    });
  } catch (error) {
    return {
      ...baseEvidence(block, account),
      status: 'unavailable',
      error: {
        kind: 'TRANSPORT_ERROR',
        httpStatus: null,
        rpcCode: null,
        message: error?.message ?? String(error)
      }
    };
  }

  const payload = await responsePayload(response);
  if (!response?.ok || payload?.error) return failureEvidence(block, account, response, payload);

  try {
    const nonce = asInteger(payload?.result, 'archive account nonce');
    return {
      schemaVersion: 'phase7-archive-rpc-state-readiness-v1',
      status: 'ready',
      block,
      account,
      nonce,
      rpcMethod: 'eth_getTransactionCount'
    };
  } catch (error) {
    return {
      ...baseEvidence(block, account),
      status: 'unavailable',
      error: {
        kind: 'INVALID_RESULT',
        httpStatus: Number.isInteger(response?.status) ? response.status : null,
        rpcCode: null,
        message: error?.message ?? String(error)
      }
    };
  }
}
