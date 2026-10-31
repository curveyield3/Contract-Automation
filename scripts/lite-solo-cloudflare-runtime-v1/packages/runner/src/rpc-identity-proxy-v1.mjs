import http from 'node:http';

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

function jsonRpcIdKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function requestMethodMap(requestPayload) {
  const requests = Array.isArray(requestPayload) ? requestPayload : [requestPayload];
  return new Map(
    requests
      .filter((request) => request && typeof request === 'object' && Object.hasOwn(request, 'id'))
      .map((request) => [jsonRpcIdKey(request.id), request.method])
  );
}

function rewriteIdentityResponse(response, method, chainId) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.error || !Object.hasOwn(response, 'result')) return response;
  if (method === 'eth_chainId') return { ...response, result: `0x${chainId.toString(16)}` };
  if (method === 'net_version') return { ...response, result: String(chainId) };
  return response;
}

function rewriteResponsePayload(requestPayload, responsePayload, chainId) {
  if (Array.isArray(responsePayload)) {
    const methods = requestMethodMap(requestPayload);
    return responsePayload.map((response) => {
      if (!response || typeof response !== 'object' || !Object.hasOwn(response, 'id')) return response;
      return rewriteIdentityResponse(response, methods.get(jsonRpcIdKey(response.id)), chainId);
    });
  }
  const request = Array.isArray(requestPayload) ? null : requestPayload;
  return rewriteIdentityResponse(responsePayload, request?.method, chainId);
}

function recordUpstreamIdentity(requestPayload, responsePayload, observation) {
  const methods = requestMethodMap(requestPayload);
  const responses = Array.isArray(responsePayload) ? responsePayload : [responsePayload];
  for (const response of responses) {
    if (!response || typeof response !== 'object' || response.error || !Object.hasOwn(response, 'id') || !Object.hasOwn(response, 'result')) continue;
    const method = methods.get(jsonRpcIdKey(response.id));
    if (method === 'eth_chainId' && typeof response.result === 'string') observation.chainId = response.result;
    if (method === 'net_version' && typeof response.result === 'string') observation.networkId = response.result;
  }
}

function includesIdentityMethod(requestPayload) {
  const requests = Array.isArray(requestPayload) ? requestPayload : [requestPayload];
  return requests.some((request) => request?.method === 'eth_chainId' || request?.method === 'net_version');
}

async function readRequestBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

export async function startRpcIdentityProxy({ upstreamUrl, chainId, fetchImpl = globalThis.fetch }) {
  if (typeof upstreamUrl !== 'string' || upstreamUrl.length === 0) throw new Error('Fork RPC upstream URL is required');
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Fork RPC chainId must be a positive safe integer');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  const upstreamIdentityObservation = { chainId: null, networkId: null };
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'JSON-RPC POST required' });
      return;
    }
    try {
      const rawRequest = await readRequestBody(request);
      const requestPayload = JSON.parse(rawRequest);
      const upstreamResponse = await fetchImpl(upstreamUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: rawRequest
      });
      if (!upstreamResponse?.ok) {
        writeJson(response, 502, { error: 'Fork RPC upstream returned a non-success status' });
        return;
      }
      const rawResponse = await upstreamResponse.text();
      if (!includesIdentityMethod(requestPayload)) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawResponse) });
        response.end(rawResponse);
        return;
      }
      const responsePayload = JSON.parse(rawResponse);
      recordUpstreamIdentity(requestPayload, responsePayload, upstreamIdentityObservation);
      writeJson(response, 200, rewriteResponsePayload(requestPayload, responsePayload, chainId));
    } catch (error) {
      const statusCode = error?.message === 'REQUEST_TOO_LARGE' ? 413 : 502;
      writeJson(response, statusCode, { error: 'Fork RPC identity proxy request failed' });
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  let closed = false;
  return {
    url,
    getUpstreamIdentityObservation() { return structuredClone(upstreamIdentityObservation); },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
