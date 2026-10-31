import { CHAINS } from '../../protocol/src/index.mjs';
import { startAnvilEngine } from '../../runner/src/anvil-engine.mjs';
import { probeArchiveRpcIdentity } from './archive-rpc-identity-v1.mjs';

const ETHEREUM_ARCHIVE_RPC_ENV = 'ETHEREUM_FORK_RPC_URL';
const IMPERSONATION_PROBE_ACTOR = '0x000000000000000000000000000000000000dEaD';
const ALLOWLISTED_ACTIONS = new Set([
  'deploy', 'call', 'staticCall', 'expectRevert', 'setBalance', 'transferNative',
  'mine', 'increaseTime', 'snapshot', 'revertSnapshot', 'assertBalance', 'assertCall',
]);

function literalTargets(workflow) {
  const targets = new Set();
  for (const step of workflow?.steps ?? []) {
    if (typeof step.target === 'string' && /^0x[0-9a-fA-F]{40}$/.test(step.target)) targets.add(step.target.toLowerCase());
  }
  return [...targets];
}

function checkWorkflowActions(workflow) {
  const unsupported = (workflow?.steps ?? [])
    .map((step, index) => ({ index, action: step?.action }))
    .filter(({ action }) => !ALLOWLISTED_ACTIONS.has(action));
  return {
    status: unsupported.length === 0 ? 'PASS' : 'FAIL',
    unsupported,
    supportedActions: [...ALLOWLISTED_ACTIONS].sort(),
  };
}

function unsupportedArchiveChain(request, workflowActions) {
  const simulation = request.configuration.simulation;
  return {
    schemaVersion: 'audit-v7-phase7-fork-preflight-v1',
    status: 'BLOCKED',
    failureKind: 'ARCHIVE_RPC_UNAVAILABLE',
    requestId: request.requestId,
    sourceCommit: request.source.commit,
    chain: simulation.chain,
    pinnedBlock: simulation.block,
    evmVersion: request.configuration.evmVersion,
    checks: {
      archiveRpcSecret: {
        status: 'UNAVAILABLE',
        admittedArchiveChains: ['ethereum'],
        profile: null,
        reason: `No qualified archive RPC is admitted for ${simulation.chain}`,
      },
      workflowActions,
    },
    nextState: 'PHASE7_FORK_PREFLIGHT',
  };
}

function reconcileUpstreamIdentity({ upstreamIdentity, expectedChainId, localBlock }) {
  const directIdentityMatch = upstreamIdentity.chainIdMatchesExpected === true
    && upstreamIdentity.networkIdMatchesExpected === true;
  const transactionChainMatch = upstreamIdentity.sampleTransaction?.chainId === expectedChainId;
  const localHashMatch = Boolean(localBlock?.hash)
    && Boolean(upstreamIdentity.block?.hash)
    && upstreamIdentity.block.hash.toLowerCase() === localBlock.hash.toLowerCase();
  const reconciled = localHashMatch && (directIdentityMatch || transactionChainMatch);
  return {
    status: reconciled ? 'PASS' : 'FAIL',
    expectedChainId,
    remoteChainId: upstreamIdentity.remoteChainId,
    remoteNetworkId: upstreamIdentity.remoteNetworkId,
    directIdentityMatch,
    sampleTransactionChainId: upstreamIdentity.sampleTransaction?.chainId ?? null,
    transactionChainMatch,
    upstreamBlockHash: upstreamIdentity.block?.hash ?? null,
    localAnvilBlockHash: localBlock?.hash ?? null,
    localHashMatch,
    reconciliationMode: reconciled
      ? (directIdentityMatch ? 'DIRECT_IDENTITY_AND_STATE_MATCH' : 'IDENTITY_PROXY_STATE_RECONCILED')
      : 'UNRECONCILED',
    identityProxyRequired: reconciled && !directIdentityMatch,
  };
}

async function proveImpersonationBalanceControl(provider) {
  const actor = IMPERSONATION_PROBE_ACTOR;
  let impersonated = false;
  try {
    await provider.send('anvil_impersonateAccount', [actor]);
    impersonated = true;
    await provider.send('evm_setAccountBalance', [actor, '0xde0b6b3a7640000']);
    const balance = await provider.getBalance(actor);
    return {
      status: balance === 10n ** 18n ? 'PASS' : 'FAIL',
      actor,
      impersonationSucceeded: true,
      balanceMutationSucceeded: balance === 10n ** 18n,
      observedBalance: balance.toString(),
    };
  } catch (error) {
    return {
      status: 'FAIL', actor, impersonationSucceeded: impersonated,
      balanceMutationSucceeded: false, reason: error?.message ?? String(error),
    };
  } finally {
    if (impersonated) await provider.send('anvil_stopImpersonatingAccount', [actor]).catch(() => {});
  }
}


/**
 * A caller cannot opt into this preflight from a V7 request directly. The
 * V26 runner first verifies SHA-256 and campaign/source/chain/block and stages
 * the immutable state in its own workspace, then adds two private env fields.
 * Saved post-deploy state is not an archive RPC, so never claim remote proof.
 */
async function savedPhase0StatePreflight({request,environment,startEngine,chain,workflowActions}){
 const sim=request.configuration.simulation;
 const stateFile=environment.V7_PHASE0_FORK_STATE_PATH;
 const expectedBlock=Number(environment.V7_PHASE0_FORK_FINAL_BLOCK);
 const fail=(kind,reason)=>({
   schemaVersion:'audit-v7-phase7-fork-preflight-v1',
   status:'FAIL',failureKind:kind,reason,requestId:request.requestId,
   sourceCommit:request.source.commit,chain:sim.chain,pinnedBlock:sim.block,
   nextState:'PHASE7_FORK_PREFLIGHT'});
 if(typeof stateFile!=='string'||!stateFile||!Number.isSafeInteger(expectedBlock)||
    sim.block!==expectedBlock||!['ethereum','base','katana'].includes(sim.chain)||workflowActions.status!=='PASS')
   return fail('PHASE0_SAVED_STATE_MISMATCH',
     'Saved state must match exact pinned post-deployment block and supported chain/workflow');
 const upstreamForkUrl=environment?.[({ethereum:'ETHEREUM_FORK_RPC_URL',base:'RPC_BASE',katana:'RPC_KATANA'})[sim.chain]];
 if(typeof upstreamForkUrl!=='string'||!upstreamForkUrl.trim())return fail('PHASE0_SAVED_STATE_FORK_UNAVAILABLE',
   'Saved state must be layered on an exact-chain qualified fork RPC; no upstream URL is persisted');
 const placeholderArtifacts={get(){throw new Error('Preflight never deploys an artifact');}};
 let engine;
 try{
   engine=await startEngine({artifacts:placeholderArtifacts,workflow:sim.workflow,
     chainId:chain.chainId,forkUrl:upstreamForkUrl,loadStatePath:stateFile,
     block:sim.block,evmVersion:request.configuration.evmVersion});
   const liveChain=Number(BigInt(await engine.provider.send('eth_chainId',[])));
   const liveBlock=Number(BigInt(await engine.provider.send('eth_blockNumber',[])));
   const localHash=liveBlock===sim.block?(await engine.provider.getBlock(sim.block))?.hash??null:null;
   const chainIdentity={status:liveChain===chain.chainId?'PASS':'FAIL',
     expectedChainId:chain.chainId,anvilChainId:liveChain,
     mode:'VERIFIED_PHASE0_SAVED_STATE_LAYERED_FORK_NO_REMOTE_ARCHIVE_ASSERTION'};
   const pinnedBlockState={status:liveBlock===sim.block&&Boolean(localHash)?'PASS':'FAIL',
     number:liveBlock,localHash,expectedBlock:sim.block};
   const codeChecks=[];
   for(const address of literalTargets(sim.workflow)){
     const code=await engine.provider.getCode(address);
     codeChecks.push({address,byteLength:code==='0x'?0:(code.length-2)/2,
       status:code!=='0x'?'PASS':'FAIL'});
   }
   const targetCode={status:codeChecks.length===0?'UNAVAILABLE':
     codeChecks.every(x=>x.status==='PASS')?'PASS':'FAIL',targets:codeChecks};
   const impersonationBalanceControl=await proveImpersonationBalanceControl(engine.provider);
   const anvilLauncher={status:engine.engine==='anvil'?'PASS':'FAIL',engine:engine.engine};
   const exactHardfork={status:engine.engine==='anvil'?'PASS':'FAIL',
     requested:request.configuration.evmVersion,downgradeAllowed:false};
   const snapshotBinding={status:'PASS',source:'V26_VERIFIED_PHASE0_SNAPSHOT',
     chainId:chain.chainId,block:sim.block};
   const checks={anvilLauncher,exactHardfork,snapshotBinding,chainIdentity,pinnedBlockState,
     targetCode,impersonationBalanceControl,workflowActions};
   const pass=Object.values(checks).every(x=>['PASS','UNAVAILABLE'].includes(x.status));
   return{schemaVersion:'audit-v7-phase7-fork-preflight-v1',
     status:pass?'PASS':'FAIL',
     failureKind:pass?null:'FORK_PREFLIGHT_ASSERTION_FAILURE',
     requestId:request.requestId,sourceCommit:request.source.commit,
     chain:sim.chain,pinnedBlock:sim.block,evmVersion:request.configuration.evmVersion,
     checks,nextState:pass?'ACTIVE':'RUNNER_REPAIR_REBIND'};
 }catch(error){return fail('PHASE0_SAVED_STATE_ENGINE_FAILED',String(error?.message??error).slice(0,400));}
 finally{if(engine)await engine.close().catch(()=>{});}
}

export async function runPhase7ForkPreflightV1({
  request,
  environment = process.env,
  startEngine = startAnvilEngine,
  probeUpstreamIdentity = probeArchiveRpcIdentity,
}) {
  if (!request || request.phaseId !== 'fork-simulation-lifecycle') throw new Error('Phase 7 fork preflight requires fork-simulation-lifecycle request');
  if (request.profileId !== 'github-native-simulate-v2') throw new Error('Phase 7 fork preflight requires github-native-simulate-v2');
  const simulation = request.configuration?.simulation;
  if (!simulation) throw new Error('Phase 7 fork preflight requires simulation configuration');
  const chain = CHAINS[simulation.chain];
  if (!chain) throw new Error(`Unsupported Phase 7 chain ${simulation.chain}`);

  const workflowActions = checkWorkflowActions(simulation.workflow);
  if(environment?.V7_PHASE0_FORK_STATE_PATH)
    return savedPhase0StatePreflight({request,environment,startEngine,chain,workflowActions});

  if (simulation.chain !== 'ethereum') return unsupportedArchiveChain(request, workflowActions);

  const forkUrl = environment?.[ETHEREUM_ARCHIVE_RPC_ENV];
  const archiveRpcSecret = {
    status: typeof forkUrl === 'string' && forkUrl.length > 0 ? 'PASS' : 'FAIL',
    profile: ETHEREUM_ARCHIVE_RPC_ENV,
  };
  if (archiveRpcSecret.status !== 'PASS' || workflowActions.status !== 'PASS') {
    return {
      schemaVersion: 'audit-v7-phase7-fork-preflight-v1',
      status: 'FAIL',
      failureKind: archiveRpcSecret.status !== 'PASS' ? 'ARCHIVE_RPC_SECRET_MISSING' : 'UNSUPPORTED_WORKFLOW_ACTION',
      requestId: request.requestId,
      sourceCommit: request.source.commit,
      chain: simulation.chain,
      pinnedBlock: simulation.block,
      evmVersion: request.configuration.evmVersion,
      loadStatePath:environment?.V7_PHASE0_FORK_STATE_PATH??null,
      checks: { archiveRpcSecret, workflowActions },
      nextState: archiveRpcSecret.status !== 'PASS' ? 'PHASE7_FORK_PREFLIGHT' : 'RUNNER_REPAIR_REBIND',
    };
  }

  let upstreamIdentity;
  try {
    upstreamIdentity = await probeUpstreamIdentity({
      rpcUrl: forkUrl,
      block: simulation.block,
      expectedChainId: chain.chainId,
    });
  } catch (error) {
    return {
      schemaVersion: 'audit-v7-phase7-fork-preflight-v1',
      status: 'FAIL', failureKind: 'ARCHIVE_IDENTITY_PROBE_FAILURE',
      requestId: request.requestId, sourceCommit: request.source.commit,
      chain: simulation.chain, pinnedBlock: simulation.block,
      evmVersion: request.configuration.evmVersion,
      checks: { archiveRpcSecret, workflowActions, chainIdentity: { status: 'FAIL', reason: error?.message ?? String(error) } },
      nextState: 'PHASE7_FORK_PREFLIGHT',
    };
  }

  const placeholderArtifacts = { get() { throw new Error('Preflight does not deploy artifacts'); } };
  let engine;
  try {
    engine = await startEngine({
      artifacts: placeholderArtifacts,
      workflow: simulation.workflow,
      chainId: chain.chainId,
      forkUrl,
      block: simulation.block,
      evmVersion: request.configuration.evmVersion,
    });

    const anvilChainIdHex = await engine.provider.send('eth_chainId', []);
    const observedAnvilChainId = Number(BigInt(anvilChainIdHex));
    const localBlock = await engine.provider.getBlock(simulation.block);
    const chainIdentity = reconcileUpstreamIdentity({ upstreamIdentity, expectedChainId: chain.chainId, localBlock });
    chainIdentity.anvilChainId = observedAnvilChainId;
    chainIdentity.anvilChainIdMatchesExpected = observedAnvilChainId === chain.chainId;
    if (!chainIdentity.anvilChainIdMatchesExpected) chainIdentity.status = 'FAIL';

    const pinnedBlockState = {
      status: localBlock?.number === simulation.block && chainIdentity.localHashMatch ? 'PASS' : 'FAIL',
      number: localBlock?.number ?? null,
      localHash: localBlock?.hash ?? null,
      upstreamHash: upstreamIdentity.block?.hash ?? null,
      stateRoot: upstreamIdentity.block?.stateRoot ?? null,
    };

    const codeChecks = [];
    for (const address of literalTargets(simulation.workflow)) {
      const code = await engine.provider.getCode(address);
      codeChecks.push({ address, byteLength: code === '0x' ? 0 : (code.length - 2) / 2, status: code !== '0x' ? 'PASS' : 'FAIL' });
    }
    const targetCode = {
      status: codeChecks.length === 0
        ? 'UNAVAILABLE'
        : (codeChecks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL'),
      targets: codeChecks,
      reason: codeChecks.length === 0
        ? 'No literal external call target exists before deployment; deployment-first audited targets do not exist until lifecycle execution'
        : undefined,
    };

    const impersonationBalanceControl = await proveImpersonationBalanceControl(engine.provider);
    const anvilLauncher = { status: engine.engine === 'anvil' ? 'PASS' : 'FAIL', engine: engine.engine };
    const exactHardfork = {
      status: engine.engine === 'anvil' ? 'PASS' : 'FAIL',
      requested: request.configuration.evmVersion,
      launchArgumentMode: 'EXACT_REQUESTED_HARDFORK_NO_DOWNGRADE',
      downgradeAllowed: false,
    };
    const checks = { anvilLauncher, exactHardfork, archiveRpcSecret, chainIdentity, pinnedBlockState, targetCode, impersonationBalanceControl, workflowActions };
    const status = Object.values(checks).every((check) => ['PASS', 'UNAVAILABLE'].includes(check.status)) ? 'PASS' : 'FAIL';
    return {
      schemaVersion: 'audit-v7-phase7-fork-preflight-v1',
      status, failureKind: status === 'PASS' ? null : 'FORK_PREFLIGHT_ASSERTION_FAILURE',
      requestId: request.requestId, sourceCommit: request.source.commit,
      chain: simulation.chain, pinnedBlock: simulation.block,
      observedPinnedBlockHash: upstreamIdentity.block?.hash ?? null,
      evmVersion: request.configuration.evmVersion,
      checks,
      nextState: status === 'PASS' ? 'ACTIVE' : 'RUNNER_REPAIR_REBIND',
    };
  } catch (error) {
    return {
      schemaVersion: 'audit-v7-phase7-fork-preflight-v1',
      status: 'FAIL', failureKind: 'ANVIL_PREFLIGHT_FAILURE',
      requestId: request.requestId, sourceCommit: request.source.commit,
      chain: simulation.chain, pinnedBlock: simulation.block,
      observedPinnedBlockHash: upstreamIdentity?.block?.hash ?? null,
      evmVersion: request.configuration.evmVersion,
      checks: {
        archiveRpcSecret, workflowActions,
        chainIdentity: {
          status: 'FAIL', expectedChainId: chain.chainId,
          remoteChainId: upstreamIdentity?.remoteChainId ?? null,
          remoteNetworkId: upstreamIdentity?.remoteNetworkId ?? null,
          sampleTransactionChainId: upstreamIdentity?.sampleTransaction?.chainId ?? null,
        },
        anvilLauncher: { status: 'FAIL', reason: error?.message ?? String(error) },
        exactHardfork: { status: 'FAIL', requested: request.configuration.evmVersion, reason: error?.message ?? String(error) },
      },
      nextState: 'RUNNER_REPAIR_REBIND',
    };
  } finally {
    if (engine) await engine.close().catch(() => {});
  }
}
