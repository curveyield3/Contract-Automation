import fs from 'node:fs/promises';
import path from 'node:path';
import { validateDeepAssuranceRequestWithV26V1 } from './schema-v26.mjs';
import { validateControllerOperationPointerV1 } from './controller-operation-pointer-v1.mjs';

async function exists(file) {
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function findPrRequests(sourceRoot) {
  const root = path.join(sourceRoot, 'github-native-sim', 'requests');
  let campaignDirs;
  try { campaignDirs = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const campaign of campaignDirs) {
    if (!campaign.isDirectory()) continue;
    const candidate = path.join(root, campaign.name, 'request.json');
    if (await exists(candidate)) found.push(candidate);
  }
  return found.sort();
}

function validateDispatchPath(requestPath) {
  const normalized = String(requestPath ?? '').replaceAll('\\', '/');
  const legacyRequestPath = /^campaigns\/[^/]+\/requests\/[^/]+\.json$/;
  const generatedExecutionPath = /^campaigns\/[^/]+\/controller\/automation\/[^/]+\/EXECUTION_REQUEST_v1\.json$/;
  // Existing controller-operated V7 source-bound test folders, including
  // Phase-8 revalidation of a sealed Phase-6 security proof gap.
  const phaseScopedExecutionPath = /^campaigns\/[^/]+\/controller\/(?:phase6-tests|phase8-revalidation|phase9-reruns)\/[^/]+\/[^/]+\.json$/;
  if (normalized.split('/').some(x=>x==='.'||x==='..'||!x)||
      (!legacyRequestPath.test(normalized) && !generatedExecutionPath.test(normalized) &&
       !phaseScopedExecutionPath.test(normalized))) {
    throw new Error(`Invalid controller request path: ${requestPath ?? ''}`);
  }
  return normalized;
}

async function validateRequestFile(file) {
  const text = await fs.readFile(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`Resolved V7 request is not valid JSON: ${error.message}`); }
  if (parsed?.schemaVersion === 'audit-controller-operation-pointer-v1') {
    return { requestKind: 'controller-operation', request: validateControllerOperationPointerV1(parsed) };
  }
  return { requestKind: 'v7-execution', request: validateDeepAssuranceRequestWithV26V1(parsed) };
}

export async function resolveV7Request({ mode, sourceRoot, requestPath = null, outputPath } = {}) {
  if (!['pr', 'dispatch'].includes(mode)) throw new Error('V7 request resolution mode must be pr or dispatch');
  if (!sourceRoot) throw new Error('V7 request resolution requires sourceRoot');
  if (!outputPath) throw new Error('V7 request resolution requires outputPath');

  let source;
  if (mode === 'pr') {
    const candidates = await findPrRequests(path.resolve(sourceRoot));
    if (candidates.length !== 1) throw new Error(`PR request source must contain exactly one atomic request; found ${candidates.length}`);
    source = candidates[0];
  } else {
    const relative = validateDispatchPath(requestPath);
    source = path.join(path.resolve(sourceRoot), relative);
    if (!(await exists(source))) throw new Error(`Controller request path does not exist: ${relative}`);
  }

  const resolved = await validateRequestFile(source);
  const request = resolved.request;
  const destination = path.resolve(outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return {
    status: 'RESOLVED',
    mode,
    source,
    outputPath: destination,
    requestKind: resolved.requestKind,
    requestId: request.requestId,
    phaseId: request.phaseId ?? null,
    profileId: request.profileId ?? null,
    controllerCommit: request.controller?.commit ?? null,
    controllerRequestPath: request.controller?.requestPath ?? null,
    verifyController: request.verifyController === true,
  };
}
