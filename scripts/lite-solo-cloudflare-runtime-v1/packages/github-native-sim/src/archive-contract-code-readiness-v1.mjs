function baseEvidence(block, address) {
  return {
    schemaVersion: 'phase7-archive-contract-code-readiness-v1',
    block,
    address,
    rpcMethod: 'eth_getCode'
  };
}

async function responsePayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureEvidence(block, address, response, payload) {
  const rpcError = payload?.error;
  return {
    ...baseEvidence(block, address),
    status: 'unavailable',
    error: {
      kind: response?.ok ? 'JSON_RPC_ERROR' : 'HTTP_ERROR',
      httpStatus: Number.isInteger(response?.status) ? response.status : null,
      rpcCode: Number.isInteger(rpcError?.code) ? rpcError.code : null,
      message: typeof rpcError?.message === 'string' && rpcError.message.length > 0
        ? rpcError.message
        : (response?.ok ? 'Archive RPC returned a JSON-RPC error' : 'Archive RPC returned a non-success HTTP status')
    }
  };
}

export async function probeArchiveContractCode({
  rpcUrl,
  block,
  address,
  fetchImpl = globalThis.fetch
}) {
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) throw new Error('Archive RPC URL is required');
  if (!Number.isSafeInteger(block) || block < 0) throw new Error('Pinned archive block must be a non-negative safe integer');
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Target address must be a 20-byte hex address');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const normalizedAddress = address.toLowerCase();
  const blockTag = `0x${block.toString(16)}`;
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getCode',
        params: [normalizedAddress, blockTag]
      })
    });
  } catch (error) {
    return {
      ...baseEvidence(block, normalizedAddress),
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
  if (!response?.ok || payload?.error) return failureEvidence(block, normalizedAddress, response, payload);

  const code = payload?.result;
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) {
    return {
      ...baseEvidence(block, normalizedAddress),
      status: 'unavailable',
      error: {
        kind: 'INVALID_RESULT',
        httpStatus: Number.isInteger(response?.status) ? response.status : null,
        rpcCode: null,
        message: 'Archive RPC returned invalid contract bytecode'
      }
    };
  }

  const byteLength = (code.length - 2) / 2;
  return {
    schemaVersion: 'phase7-archive-contract-code-readiness-v1',
    status: byteLength === 0 ? 'no_code' : 'code_present',
    block,
    address: normalizedAddress,
    byteLength,
    rpcMethod: 'eth_getCode'
  };
}
