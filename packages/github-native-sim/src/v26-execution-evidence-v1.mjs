import { digestCanonicalV1 } from './canonical-json-v1.mjs';
import { generateBuildSbomV1 } from './sbom-v1.mjs';
import { createPhase6CampaignPlanV1, recordPhase6CampaignV1, evaluatePhase6CampaignPlanV1 } from './phase6-campaign-controller-v1.mjs';
import { runFoundryCoverageV1, evaluateFoundryCoverageObligationsV1, buildFoundryCampaignReceiptV1 } from './foundry-coverage-v1.mjs';
import { buildSimulationLifecycleLedgerV1 } from './simulation-ledger-v1.mjs';
import { attestLiveDeploymentV1 } from './live-deployment-attestation-v1.mjs';
import { normalizeCandidateReproductionV1 } from './reproduction-v1.mjs';

export function stripV26RequestExtensionV1(request){
  const legacy=structuredClone(request);
  if(legacy.configuration) delete legacy.configuration.v26;
  return legacy;
}

function medusaTerminal(component){
  if(component?.failureKind==='PROPERTY_FALSIFICATION') return 'PROPERTY_FALSIFICATION';
  if(component?.failureKind==='NO_TESTS_DISCOVERED') return 'NO_TESTS_DISCOVERED';
  if(component?.componentStatus==='COMPLETED') return 'COMPLETED';
  if(component?.componentStatus==='COMPLETED_WITH_FAILURES') return 'COMPLETED_WITH_FAILURES';
  return 'FAILED';
}
function metric(component,name){
  const campaign=component?.campaign??{};
  const status=campaign.metricAvailability?.[name]??(campaign[name]&&Object.keys(campaign[name]).length?'PRESENT':'UNAVAILABLE_FROM_OUTPUT_MODE');
  return {status,data:status==='PRESENT'?structuredClone(campaign[name]??{}):null};
}
function normalizedBuild(request,build){
  return {compilerDescriptors:structuredClone(request.configuration?.compilers??[]),optimizer:structuredClone(request.configuration?.optimizer??null),evmVersion:request.configuration?.evmVersion??null,viaIR:request.configuration?.viaIR===true,sourceCommit:request.source?.commit??null,artifacts:structuredClone(build?.artifacts??[])};
}
function sourceIdentity(request){ return {repository:request.source.repository,commit:request.source.commit,projectPath:request.source.projectPath,archiveSha256:request.source.archiveSha256??null}; }

export async function enrichPhase6V26EvidenceV1({request,result,projectRoot,mutableRpcRuntime,environment=process.env,runCommand}={}){
  const v26=request?.configuration?.v26;
  if(!v26) return result;
  let enriched={...result};
  if(v26.sbomRequired===true){
    enriched.sbom=await generateBuildSbomV1({projectRoot,request,build:normalizedBuild(request,result?.build)});
  }
  if(v26.phase6CampaignPlan){
    const spec=v26.phase6CampaignPlan;
    let plan=createPhase6CampaignPlanV1(spec);
    const medusa=result?.analysis?.medusa;
    if(medusa){
      plan=recordPhase6CampaignV1(plan,{
        campaignId:`${request.requestId}:${spec.activeCampaignClass}:r${spec.runOrdinal}`,
        campaignClass:spec.activeCampaignClass,
        engine:'medusa',
        harnessBundleDigest:spec.harnessBundleDigest,
        sourceSnapshotDigest:spec.sourceSnapshotDigest,
        rpcBlock:medusa.fork?.blockNumber??mutableRpcRuntime?.blockNumber??null,
        rpcBlockHash:medusa.fork?.blockHash??mutableRpcRuntime?.blockHash??null,
        runOrdinal:spec.runOrdinal,
        refinementOf:spec.refinementOf??null,
        configurationDigest:spec.configurationDigest,
        terminalStatus:medusaTerminal(medusa),
        propertyCount:medusa.campaign?.properties?.length??0,
        falsifiedPropertyCount:medusa.campaign?.falsifiedProperties??0,
        corpus:metric(medusa,'corpus'),coverage:metric(medusa,'coverage'),statistics:metric(medusa,'statistics'),
        rawArtifactRef:medusa.rawArtifactRef??null
      });
    }
    const evaluation=evaluatePhase6CampaignPlanV1(plan);
    enriched.phase6CampaignEvidence={schemaVersion:'audit-v7-phase6-campaign-evidence-v1',sourceSnapshotDigest:spec.sourceSnapshotDigest,harnessBundleDigest:spec.harnessBundleDigest,campaigns:plan.campaigns,evaluation};
    enriched.phase6CampaignEvidence.evidenceDigest=digestCanonicalV1(enriched.phase6CampaignEvidence);
  }
  const coverageRequested=(v26.foundryCoverageObligations?.length??0)>0||v26.foundryRefinementRequired===true;
  if(coverageRequested){
    if(!mutableRpcRuntime?.url) throw new Error('v26 Foundry coverage requires the existing passing Phase 6 mutable RPC runtime');
    const coverage=await runFoundryCoverageV1({projectRoot,sourceCommit:request.source.commit,rpcUrl:mutableRpcRuntime.url,blockNumber:mutableRpcRuntime.blockNumber,blockHash:mutableRpcRuntime.blockHash,rpcProfile:mutableRpcRuntime.profile,environment,rawArtifactRef:`github-actions://${process.env.GITHUB_REPOSITORY??'curveyield3/Contract-Automation'}/runs/${process.env.GITHUB_RUN_ID??'recovery'}/artifacts/v7-execution/foundry-coverage/raw.txt`,...(runCommand?{runCommand}:{})});
    const obligations=evaluateFoundryCoverageObligationsV1(coverage,v26.foundryCoverageObligations??[]);
    const runType=v26.foundryRunType??'baseline';
    const receipt=buildFoundryCampaignReceiptV1({runId:`${request.requestId}:foundry:${runType}`,runType,refinementOf:v26.foundryRefinementOf??null,basisEvidenceIds:v26.foundryBasisEvidenceIds??[],harnessBundleDigest:v26.phase6CampaignPlan?.harnessBundleDigest??digestCanonicalV1(request.configuration?.harness??{}),configurationDigest:v26.phase6CampaignPlan?.configurationDigest??digestCanonicalV1({analysis:request.configuration?.analysis??{},coverage:v26.foundryCoverageObligations??[]}),testResult:result?.analysis?.nativeFuzz??{status:'NOT_EXECUTED'},coverageResult:coverage},{refinementRequired:v26.foundryRefinementRequired===true});
    enriched.foundryCoverage={...coverage,obligationEvaluation:obligations,campaignReceipt:receipt};
    enriched.foundryCoverage.coverageDigest=digestCanonicalV1(enriched.foundryCoverage);
  }
  enriched=attachReproductionEvidenceV1(request,enriched);
  return enriched;
}

async function jsonRpcTransport(url,expectedChainId,fetchImpl=globalThis.fetch){
  let id=0;
  return async(method,params)=>{
    if(method==='eth_chainId') return `0x${Number(expectedChainId).toString(16)}`;
    const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    if(!response?.ok) throw new Error(`attestation RPC ${method} returned HTTP ${response?.status??'unknown'}`);
    const payload=await response.json(); if(payload?.error) throw new Error(`attestation RPC ${method} failed: ${payload.error.message??'unknown error'}`); return payload?.result;
  };
}

export async function enrichPhase7V26EvidenceV1({request,result,environment=process.env,fetchImpl=globalThis.fetch}={}){
  const v26=request?.configuration?.v26; if(!v26) return result;
  let enriched={...result};
  const blockNumber=request.configuration?.simulation?.block??result?.preflight?.pinnedBlock??null;
  const blockHash=result?.preflight?.observedPinnedBlockHash??result?.preflight?.checks?.pinnedBlockState?.upstreamHash??null;
  const recipeId=request.configuration?.harness?.recipeId??null;
  const simulationForLedger={fork:{chain:request.configuration?.simulation?.chain??'ethereum',chainId:1,blockNumber,blockHash,engine:'anvil'},steps:structuredClone(result?.simulation?.steps??[]),segments:[{recipeId,label:recipeId??'lifecycle',stepIndexes:(result?.simulation?.steps??[]).map((_,i)=>i)}]};
  if(v26.simulationLedgerRequired===true){
    enriched.simulationLedger=buildSimulationLifecycleLedgerV1({request:{...request,sourceIdentity:sourceIdentity(request)},build:result?.build,simulation:simulationForLedger,deploymentGasEvidence:result?.deploymentGasEvidence,attestation:null});
  }
  if(v26.liveDeploymentAttestation){
    const rpcUrl=environment.SIM_ARCHIVE_PRIMARY_ETHEREUM_01;
    if(typeof rpcUrl!=='string'||!rpcUrl) throw new Error('live deployment attestation requires SIM_ARCHIVE_PRIMARY_ETHEREUM_01');
    if(!blockHash) throw new Error('live deployment attestation requires the Phase 7 preflight frozen block hash');
    const transport=await jsonRpcTransport(rpcUrl,1,fetchImpl);
    enriched.liveDeploymentAttestation=await attestLiveDeploymentV1({...structuredClone(v26.liveDeploymentAttestation),blockNumber,blockHash,expectedChainId:1},{transport});
    enriched.liveDeploymentAttestation.rpcProfile='SIM_ARCHIVE_PRIMARY_ETHEREUM_01';
    enriched.liveDeploymentAttestation.identityNormalization='PREQUALIFIED_ARCHIVE_IDENTITY';
    enriched.liveDeploymentAttestation.rpcUrlExposed=false;
    if(enriched.simulationLedger){
      enriched.simulationLedger=buildSimulationLifecycleLedgerV1({request:{...request,sourceIdentity:sourceIdentity(request)},build:result?.build,simulation:simulationForLedger,deploymentGasEvidence:result?.deploymentGasEvidence,attestation:enriched.liveDeploymentAttestation});
    }
  }
  enriched=attachReproductionEvidenceV1(request,enriched);
  return enriched;
}

function reproductionObservation(request,result){
  const spec=request.configuration?.v26?.reproduction; if(!spec) return null;
  const expected=spec.expectedObservation;
  if(spec.reproductionType==='MEDUSA_PROPERTY'){
    const observed=(result?.analysis?.medusa?.campaign?.properties??[]).find(p=>p?.name===expected.propertyName)??null;
    return {matched:observed?.status===expected.propertyStatus,expected,observed};
  }
  if(spec.reproductionType==='FOUNDRY_TEST'){
    const observed=result?.analysis?.nativeFuzz?.componentStatus??'FAILED'; return {matched:observed===expected.componentStatus,expected,observed:{componentStatus:observed}};
  }
  const observed=(result?.simulation?.steps??[]).find(s=>s?.label===expected.stepLabel)??null;
  return {matched:observed?.status===expected.stepStatus,expected,observed};
}
export function attachReproductionEvidenceV1(request,result){
  const spec=request?.configuration?.v26?.reproduction; if(!spec) return result;
  const predicate=reproductionObservation(request,result); const unavailable=predicate?.observed==null;
  const status=unavailable?'INCONCLUSIVE':predicate.matched?'REPRODUCED':'NOT_REPRODUCED';
  const reproduction=normalizeCandidateReproductionV1({candidateId:spec.candidateId,sourceIdentity:sourceIdentity(request),reproductionType:spec.reproductionType,engine:{FOUNDRY_TEST:'foundry',MEDUSA_PROPERTY:'medusa',ANVIL_WORKFLOW:'anvil'}[spec.reproductionType],status,evidenceReferences:[result?.phase6CampaignEvidence?.evidenceDigest,result?.foundryCoverage?.coverageDigest,result?.simulationLedger?.ledgerDigest].filter(Boolean),observedPredicate:predicate,rawArtifactRefs:[result?.analysis?.medusa?.rawArtifactRef,result?.analysis?.nativeFuzz?.rawArtifactRef].filter(Boolean)});
  return {...result,reproduction};
}
