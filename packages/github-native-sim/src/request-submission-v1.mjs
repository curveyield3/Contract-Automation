import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateDeepAssuranceRequestWithV26V1 } from './schema-v26.mjs';
import { validateControllerOperationPointerV1 } from './controller-operation-pointer-v1.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function encodePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

async function githubApi({ repository, token, method = 'GET', route, body = undefined }) {
  if (!token) throw new Error('V7 request submission requires GH_TOKEN or GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'curveyield-contract-automation-v7-submit',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(`GitHub API ${method} ${route} failed with HTTP ${response.status}: ${payload?.message ?? 'unknown error'}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function maybeGetRef({ repository, token, branch }) {
  try {
    return await githubApi({ repository, token, route: `/git/ref/heads/${encodePath(branch)}` });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function verifyBlobBytes({ repository, token, blobSha, expectedBytes }) {
  const blob = await githubApi({ repository, token, route: `/git/blobs/${blobSha}` });
  if (blob?.encoding !== 'base64' || typeof blob?.content !== 'string') throw new Error('GitHub blob verification returned unsupported encoding');
  const observed = Buffer.from(blob.content.replace(/\n/g, ''), 'base64');
  if (!observed.equals(expectedBytes)) throw new Error('Remote Git blob bytes do not exactly match the locally validated request bytes');
  return { bytes: observed.length, sha256: sha256(observed) };
}

async function ensureAtomicDiff({ repository, token, base, head, requestPath }) {
  const compare = await githubApi({ repository, token, route: `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}` });
  const changed = (compare?.files ?? []).map((file) => file.filename).sort();
  if (changed.length !== 1 || changed[0] !== requestPath) {
    throw new Error(`V7 request branch must differ from ${base} by exactly ${requestPath}; observed ${changed.join(', ') || 'no changed files'}`);
  }
  return changed;
}

async function ensureTracePullRequest({ repository, token, base, branch, request, requestKind }) {
  const [owner] = repository.split('/');
  const pulls = await githubApi({
    repository,
    token,
    route: `/pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  });
  if (Array.isArray(pulls) && pulls.length > 0) return pulls[0];
  const execution = requestKind === 'v7-execution';
  return githubApi({
    repository,
    token,
    method: 'POST',
    route: '/pulls',
    body: {
      title: execution ? `V7 request ${request.requestId} — ${request.phaseId}` : `V7 controller operation ${request.requestId}`,
      head: branch,
      base,
      body: execution
        ? `Trace-only V7 execution request. Do not merge.\n\nRequest: ${request.requestId}\nPhase: ${request.phaseId}\nSource: ${request.source.repository}@${request.source.commit}`
        : `Trace-only V7 controller-operation pointer. Do not merge.\n\nRequest: ${request.requestId}\nController: ${request.controller.repository}@${request.controller.commit}`,
      draft: false,
    },
  });
}

export async function submitV7Request({
  requestPath,
  repository = 'curveyield3/Contract-Automation',
  base = 'main',
  branch = null,
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  createPullRequest = true,
} = {}) {
  if (!requestPath) throw new Error('V7 request submission requires --request <request.json>');
  const absolute = path.resolve(requestPath);
  const bytes = await fs.readFile(absolute);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(`Request JSON parse failed before submission: ${error.message}`); }
  const requestKind = parsed?.schemaVersion === 'audit-controller-operation-pointer-v1' ? 'controller-operation' : 'v7-execution';
  const request = requestKind === 'controller-operation'
    ? validateControllerOperationPointerV1(parsed)
    : validateDeepAssuranceRequestWithV26V1(parsed);
  const transportSha256 = sha256(bytes);
  const targetPath = `github-native-sim/requests/${request.requestId}/request.json`;
  const requestBranch = branch ?? `audit-request/${request.requestId}-${transportSha256.slice(0, 8)}`;

  const existingRef = await maybeGetRef({ repository, token, branch: requestBranch });
  if (existingRef) {
    const commit = await githubApi({ repository, token, route: `/git/commits/${existingRef.object.sha}` });
    const tree = await githubApi({ repository, token, route: `/git/trees/${commit.tree.sha}?recursive=1` });
    const entry = (tree?.tree ?? []).find((item) => item.path === targetPath && item.type === 'blob');
    if (!entry) throw new Error(`Existing request branch ${requestBranch} does not contain ${targetPath}`);
    const verified = await verifyBlobBytes({ repository, token, blobSha: entry.sha, expectedBytes: bytes });
    await ensureAtomicDiff({ repository, token, base, head: requestBranch, requestPath: targetPath });
    const pr = createPullRequest ? await ensureTracePullRequest({ repository, token, base, branch: requestBranch, request, requestKind }) : null;
    return {
      status: 'ALREADY_SUBMITTED_VERIFIED',
      requestKind,
      requestId: request.requestId,
      requestDigest: request.requestDigest ?? null,
      transportSha256,
      bytes: verified.bytes,
      repository,
      base,
      branch: requestBranch,
      commit: existingRef.object.sha,
      targetPath,
      pullRequest: pr ? { number: pr.number, url: pr.html_url } : null,
    };
  }

  const baseRef = await githubApi({ repository, token, route: `/git/ref/heads/${encodePath(base)}` });
  const baseCommit = await githubApi({ repository, token, route: `/git/commits/${baseRef.object.sha}` });
  const blob = await githubApi({
    repository,
    token,
    method: 'POST',
    route: '/git/blobs',
    body: { content: bytes.toString('base64'), encoding: 'base64' },
  });
  const tree = await githubApi({
    repository,
    token,
    method: 'POST',
    route: '/git/trees',
    body: {
      base_tree: baseCommit.tree.sha,
      tree: [{ path: targetPath, mode: '100644', type: 'blob', sha: blob.sha }],
    },
  });
  const commit = await githubApi({
    repository,
    token,
    method: 'POST',
    route: '/git/commits',
    body: {
      message: `Submit atomic V7 request ${request.requestId}`,
      tree: tree.sha,
      parents: [baseRef.object.sha],
    },
  });
  await githubApi({
    repository,
    token,
    method: 'POST',
    route: '/git/refs',
    body: { ref: `refs/heads/${requestBranch}`, sha: commit.sha },
  });

  const verified = await verifyBlobBytes({ repository, token, blobSha: blob.sha, expectedBytes: bytes });
  if (verified.sha256 !== transportSha256 || verified.bytes !== bytes.length) throw new Error('Remote request verification digest/length mismatch');
  await ensureAtomicDiff({ repository, token, base, head: requestBranch, requestPath: targetPath });
  const pr = createPullRequest ? await ensureTracePullRequest({ repository, token, base, branch: requestBranch, request, requestKind }) : null;

  return {
    status: 'SUBMITTED_VERIFIED',
    requestKind,
    requestId: request.requestId,
    requestDigest: request.requestDigest ?? null,
    transportSha256,
    bytes: bytes.length,
    repository,
    base,
    branch: requestBranch,
    commit: commit.sha,
    targetPath,
    pullRequest: pr ? { number: pr.number, url: pr.html_url } : null,
  };
}
