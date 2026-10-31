import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeepAssuranceRequestWithV26V1 } from './schema-v26.mjs';
import { runGitHubNativeJob as runGitHubNativeJobV1 } from './run-job-file.mjs';
import { runPhase6ExecutionPreflightV1 } from './phase6-execution-preflight-v1.mjs';
import { createPhase6MutableRpcSession, phase6MutableRpcRuntime } from './phase6-mutable-rpc-v1.mjs';
import { runPhase7ForkPreflightV2 } from './phase7-fork-preflight-v2.mjs';
import {stageVerifiedPhase0ForkStateV1} from './phase0-fork-state-reuse-v1.mjs';
import { stagePhase6Snapshot, copyPhase6SnapshotForExecution } from './phase6-staged-snapshot-v1.mjs';
import { attachExecutionDisposition } from './execution-disposition-v1.mjs';
import { stripV26RequestExtensionV1, enrichPhase6V26EvidenceV1, enrichPhase7V26EvidenceV1, attachReproductionEvidenceV1 } from './v26-execution-evidence-v1.mjs';

const DEFAULT_RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function liveScanForkBindingV1(projectRoot) {
  let manifest;
  try { manifest=JSON.parse(await fs.readFile(path.join(projectRoot,'scan-source-manifest.json'),'utf8')); }
  catch(error){if(error?.code==='ENOENT')return null;throw error;}
  if(manifest?.inputMode!=='LIVE_SCAN')return null;
  const pin=manifest.frozenBlock;
  const targets=manifest.resolvedTargets??[];
  if(manifest.chainId!==1||!Number.isSafeInteger(pin?.number)
    ||!/^0x[0-9a-fA-F]{64}$/.test(String(pin?.hash??''))
    ||!Array.isArray(targets)||targets.length===0
    ||targets.some(t=>!/^0x[0-9a-fA-F]{40}$/.test(String(t?.address??''))
      ||!/^[0-9a-fA-F]{64}$/.test(String(t?.runtimeSha256??''))))
    throw new Error('LIVE_SCAN_FORK_TARGET_IDENTITY_INVALID');
  return {frozenBlockNumber:pin.number,frozenBlockHash:pin.hash,
    attestedTargets:targets.map(t=>({address:t.address,runtimeSha256:t.runtimeSha256,
      qualifiedName:t.qualifiedName??null}))};
}


function preflightFailure(request, preflight) {
  const repairRequired = preflight?.nextState === 'RUNNER_REPAIR_REBIND';
  return {
    schemaVersion: 'deep-assurance-github-native-execution-v2', requestId: request.requestId,
    requestDigest: request.requestDigest, profileId: request.profileId, source: structuredClone(request.source),
    status: 'failed', preflight, build: null, deploymentGasEvidence: null, analysis: {}, simulation: null,
    analysisComponentFailureCount: 0, failedStepCount: 0, failedSteps: [],
    continuityDisposition: repairRequired ? 'RUNNER_REPAIR_REBIND_REQUIRED' : 'PREFLIGHT_BLOCKED',
    error: { name: 'V7ExecutionPreflightFailure', message: `${request.phaseId} preflight did not pass`, kind: preflight?.failureKind ?? 'EXECUTION_PREFLIGHT_FAILURE' },
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
}

function terminalNotApplicable(backend, preflightComponent) {
  return {
    backend, status: 'not_applicable', terminal: true, componentStatus: 'NOT_APPLICABLE',
    continuationDisposition: 'COMPLETE_EVIDENCE', failureKind: null,
    reason: preflightComponent?.reason ?? 'TARGET_HARNESS_NOT_PRESENT', preflightDetermined: true, toolInvoked: false,
  };
}

function phase6RequiresMutableRpc(request) {
  const medusaRequested = request.configuration?.analysis?.medusa !== false
    && request.configuration?.analysis?.medusa !== undefined;
  const nativeFuzzRequested = request.configuration?.analysis?.nativeFuzz?.enabled === true;
  const v26 = request.configuration?.v26;
  const coverageRequested = (v26?.foundryCoverageObligations?.length ?? 0) > 0 || v26?.foundryRefinementRequired === true;
  return medusaRequested || nativeFuzzRequested || coverageRequested;
}

function phase6DelegateOptions(delegateOptions, preflight, mutableRpcSession) {
  const options = { ...delegateOptions };
  if (preflight?.mutableRpc?.status === 'PASS') {
    options.phase6MutableRpc = phase6MutableRpcRuntime({ session: mutableRpcSession });
  }
  if (preflight?.medusa?.status === 'NOT_APPLICABLE') options.runMedusa = async () => terminalNotApplicable('medusa', preflight.medusa);
  if (preflight?.nativeFuzz?.status === 'NOT_APPLICABLE') options.runNativeFuzz = async () => terminalNotApplicable('native-fuzz', preflight.nativeFuzz);
  return options;
}

function normalizePhase6TerminalSemantics(result) {
  if (!result || result.status !== 'completed') return result;
  const components = Object.values(result.analysis ?? {}).filter(Boolean);
  const failureCount = components.filter((component) => ['FAILED', 'UNAVAILABLE'].includes(component.componentStatus)).length;
  const limitationCount = components.filter((component) => component.componentStatus === 'NOT_APPLICABLE').length;
  return {
    ...result,
    analysisComponentFailureCount: failureCount,
    analysisNotApplicableCount: limitationCount,
    continuityDisposition: failureCount > 0 ? 'CONTINUE_WITH_LIMITATION' : 'COMPLETE_EVIDENCE',
  };
}

async function executePhase6V2({
  request,
  workspaceRoot,
  environment,
  runnerCommit,
  runnerRoot,
  requestPath,
  delegateOptions,
  createMutableRpcSession,
}) {
  const legacyRequest = stripV26RequestExtensionV1(request);
  let phase6Snapshot = null;
  let mutableRpcSession = null;
  let executionSnapshot = null;
  try {
    if(environment.PHASE5_BOUNDARY_PROGRESS==='true')process.stderr.write('[phase5-v7] Staging exact source and audit overlay\n');
    phase6Snapshot = await stagePhase6Snapshot(legacyRequest, {
      workspaceRoot: path.join(workspaceRoot, 'staging'),
      environment,
      runnerRoot,
    });

    if(environment.PHASE5_BOUNDARY_PROGRESS==='true')process.stderr.write('[phase5-v7] Source snapshot ready; checking fork preflight\n');
    if (phase6RequiresMutableRpc(request)) {
      const medusaForkPin = request.configuration?.analysis?.medusa;
      const sourceFork=await liveScanForkBindingV1(phase6Snapshot.projectRoot);
      if(sourceFork&&medusaForkPin&&medusaForkPin!==false
        &&(medusaForkPin.frozenBlockNumber!=null||medusaForkPin.frozenBlockHash!=null)
        &&(medusaForkPin.frozenBlockNumber!==sourceFork.frozenBlockNumber
          ||String(medusaForkPin.frozenBlockHash).toLowerCase()!==sourceFork.frozenBlockHash.toLowerCase()))
        throw new Error('LIVE_SCAN_FORK_PIN_CONTRADICTS_FROZEN_SOURCE');
      mutableRpcSession = await createMutableRpcSession({
        environment,
        frozenBlockNumber: sourceFork?.frozenBlockNumber
          ??(medusaForkPin&&medusaForkPin!==false?medusaForkPin.frozenBlockNumber??null:null),
        frozenBlockHash: sourceFork?.frozenBlockHash
          ??(medusaForkPin&&medusaForkPin!==false?medusaForkPin.frozenBlockHash??null:null),
        ...(sourceFork?{attestedTargets:sourceFork.attestedTargets}:{}),
      });
    }

    let preflight = await runPhase6ExecutionPreflightV1({
      request: legacyRequest,
      projectRoot: phase6Snapshot.projectRoot,
      runnerCommit,
      environment,
      ...(mutableRpcSession ? { mutableRpcEvidence: mutableRpcSession.evidence } : {}),
    });
    preflight = {
      ...preflight,
      harnessOverlay: phase6Snapshot.harnessOverlay,
      stagedSnapshot: {
        schemaVersion: phase6Snapshot.schemaVersion,
        digestSha256: phase6Snapshot.snapshotDigestSha256,
        fileCount: phase6Snapshot.snapshotFileCount,
        bytes: phase6Snapshot.snapshotBytes,
        sourceCommit: phase6Snapshot.commit,
        materializedOnce: true,
      },
      mutableRpcSession: phase6RequiresMutableRpc(request) ? {
        status: mutableRpcSession?.evidence?.status ?? 'FAIL',
        identityNormalized: mutableRpcSession?.runtime?.identityNormalized === true,
        sharedAcrossPreflightMedusaAndFoundry: mutableRpcSession?.evidence?.status === 'PASS',
        runtimeUrlExposed: false,
      } : { status: 'NOT_REQUIRED' },
    };

    if(environment.PHASE5_BOUNDARY_PROGRESS==='true')process.stderr.write(`[phase5-v7] Preflight status: ${preflight.status}\n`);
    if (preflight.status !== 'PASS') {
      return attachExecutionDisposition({ request, result: preflightFailure(request, preflight), requestPath });
    }

    const delegated = phase6DelegateOptions(delegateOptions, preflight, mutableRpcSession);
    delegated.checkoutSource = async () => {
      executionSnapshot = await copyPhase6SnapshotForExecution(phase6Snapshot, {
        workspaceRoot: path.join(workspaceRoot, 'execution'),
      });
      return executionSnapshot;
    };

    if(environment.PHASE5_BOUNDARY_PROGRESS==='true')process.stderr.write('[phase5-v7] Executing trusted V7 build and Foundry tests\n');
    let result = await runGitHubNativeJobV1(legacyRequest, {
      workspaceRoot: path.join(workspaceRoot, 'execution'),
      environment,
      ...delegated,
    });

    if(environment.PHASE5_BOUNDARY_PROGRESS==='true')process.stderr.write(`[phase5-v7] V7 execution status: ${result.status}\n`);
    result = normalizePhase6TerminalSemantics(result);
    const verified = executionSnapshot?.snapshotDigestSha256 === phase6Snapshot?.snapshotDigestSha256;
    result = {
      ...result,
      preflight: {
        ...preflight,
        executionSnapshotDigestSha256: executionSnapshot?.snapshotDigestSha256 ?? null,
        executionSnapshotVerified: verified,
        secondNetworkCheckoutPerformed: false,
        secondOverlayMaterializationPerformed: false,
      },
    };
    result = await enrichPhase6V26EvidenceV1({
      request,
      result,
      projectRoot: executionSnapshot?.projectRoot ?? phase6Snapshot.projectRoot,
      mutableRpcRuntime: mutableRpcSession?.evidence?.status === 'PASS' ? phase6MutableRpcRuntime({ session: mutableRpcSession }) : null,
      environment,
      runCommand: delegateOptions.runCommand,
    });
    return attachExecutionDisposition({ request, result, requestPath });
  } finally {
    if (mutableRpcSession?.close) await mutableRpcSession.close().catch(() => {});
  }
}

export async function runGitHubNativeJobV2(input, {
  workspaceRoot = path.resolve('.deep-assurance-work-v2'),
  environment = process.env,
  runnerCommit = process.env.GITHUB_SHA ?? null,
  runnerRoot = DEFAULT_RUNNER_ROOT,
  requestPath = '<request.json>',
  createMutableRpcSession = createPhase6MutableRpcSession,
  ...delegateOptions
} = {}) {
  const v26Request = validateDeepAssuranceRequestWithV26V1(input);

  if (v26Request.phaseId === 'build-and-test') {
    return executePhase6V2({
      request: v26Request,
      workspaceRoot,
      environment,
      runnerCommit,
      runnerRoot,
      requestPath,
      delegateOptions,
      createMutableRpcSession,
    });
  }

  const request = stripV26RequestExtensionV1(v26Request);
  // Never honor a caller-supplied state file. Only a V26 descriptor matching
  // the private Phase-0 SHA/campaign/source may authorize restored execution.
  const executionEnvironment={...environment};
  delete executionEnvironment.V7_PHASE0_FORK_STATE_PATH;
  delete executionEnvironment.V7_PHASE0_FORK_FINAL_BLOCK;
  const stateRef=v26Request.configuration?.v26?.phase0ForkState;
  let verifiedState=null;
  if(stateRef){
    try{
      verifiedState=await stageVerifiedPhase0ForkStateV1({
        controllerRoot:executionEnvironment.PHASE5_CONTROLLER_ROOT,
        manifestRef:stateRef.manifestRef,expected:stateRef,
        workspaceRoot:path.join(workspaceRoot,'fork-state-staging')
      });
      executionEnvironment.V7_PHASE0_FORK_STATE_PATH=verifiedState.loadStatePath;
      executionEnvironment.V7_PHASE0_FORK_FINAL_BLOCK=String(verifiedState.finalBlock);
    }catch(error){
      const preflight={status:'FAIL',failureKind:'PHASE0_FORK_STATE_VERIFICATION_FAILED',
        reason:String(error?.message??error).slice(0,500),nextState:'PHASE7_FORK_PREFLIGHT'};
      return attachExecutionDisposition({request:v26Request,
        result:preflightFailure(v26Request,preflight),requestPath});
    }
  }
  let preflight = null;
  if (v26Request.phaseId === 'fork-simulation-lifecycle') {
    preflight = await runPhase7ForkPreflightV2({ request, environment:executionEnvironment });
  }

  if (preflight && preflight.status !== 'PASS') {
    return attachExecutionDisposition({ request: v26Request, result: preflightFailure(v26Request, preflight), requestPath });
  }

  // Phase-5 lifecycle requests may also require Foundry fuzz / explicit
  // Medusa execution BEFORE the deterministic lifecycle steps. Both adapters
  // require the trusted local Anvil URL; the archive dRPC endpoint is only
  // the upstream state source and must never be handed to mutation tools.
  const analysis = request.configuration?.analysis ?? {};
  const forkAnalysisRequested = v26Request.phaseId === 'fork-simulation-lifecycle'
    && (analysis.nativeFuzz?.enabled === true
      || (analysis.medusa !== false && analysis.medusa !== undefined));
  let forkAnalysisSession = null;
  try {
    if (forkAnalysisRequested) {
      const simulation = request.configuration?.simulation;
      const frozenBlockHash = preflight?.checks?.pinnedBlockState?.upstreamHash;
      const frozenBlockNumber = simulation?.block;
      // This shared mutable-Anvil adapter is presently qualified for chain 1.
      // Do not silently downgrade non-Ethereum/Phase-0 snapshot requests.
      if (simulation?.chain !== 'ethereum'
        || !Number.isSafeInteger(frozenBlockNumber)
        || !/^0x[0-9a-fA-F]{64}$/.test(String(frozenBlockHash ?? ''))) {
        const blocked = {status:'FAIL',failureKind:'FORK_ANALYSIS_HISTORICAL_PIN_MISSING',
          reason:'Foundry/Medusa requires a verified Ethereum historical block/hash from trusted fork preflight',
          nextState:'PHASE7_FORK_PREFLIGHT'};
        return attachExecutionDisposition({request:v26Request,
          result:preflightFailure(v26Request,blocked),requestPath});
      }
      forkAnalysisSession = await createMutableRpcSession({
        environment:executionEnvironment, frozenBlockNumber, frozenBlockHash,
      });
      if (forkAnalysisSession?.evidence?.status !== 'PASS' || !forkAnalysisSession?.runtime?.url) {
        const blocked={status:'FAIL',
          failureKind:forkAnalysisSession?.evidence?.failureKind ?? 'MUTABLE_RPC_UNAVAILABLE',
          reason:forkAnalysisSession?.evidence?.reason ?? 'Trusted historical Anvil fork failed identity/pin preflight',
          nextState:'PHASE7_FORK_PREFLIGHT'};
        return attachExecutionDisposition({request:v26Request,
          result:preflightFailure(v26Request,blocked),requestPath});
      }
    }
    let result = await runGitHubNativeJobV1(request, {
      workspaceRoot: path.join(workspaceRoot, 'execution'),
      environment:executionEnvironment,
      ...delegateOptions,
      ...(forkAnalysisSession ? {phase6MutableRpc:phase6MutableRpcRuntime({session:forkAnalysisSession})} : {}),
      verifiedPhase0ForkState:verifiedState,
    });
    result = { ...result, preflight, ...(verifiedState?{phase0ForkStateReuse:{
      status:'VERIFIED',sha256:verifiedState.sha256,chainId:verifiedState.chainId,
      finalBlock:verifiedState.finalBlock}}:{}) };

    if (v26Request.phaseId === 'fork-simulation-lifecycle') {
      result = await enrichPhase7V26EvidenceV1({ request: v26Request, result, environment, fetchImpl: delegateOptions.fetchImpl ?? globalThis.fetch });
    } else {
      result = attachReproductionEvidenceV1(v26Request, result);
    }

    return attachExecutionDisposition({ request: v26Request, result, requestPath });
  } finally {
    // Release the ephemeral local Anvil even when compilation, analysis,
    // lifecycle assertions or evidence serialization fails.
    if (forkAnalysisSession?.close) await forkAnalysisSession.close().catch(() => {});
  }
}

export const runGitHubNativeJob = runGitHubNativeJobV2;
