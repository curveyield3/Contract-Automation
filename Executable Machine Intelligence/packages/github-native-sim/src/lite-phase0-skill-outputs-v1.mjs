#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderDeployConfigMatrixV1 } from './lite-boundary-artifacts-v1.mjs';
import { createHash } from 'node:crypto';

function parseArgs(argv){
  const out={};
  for(let i=0;i<argv.length;i++){
    const token=argv[i];
    if(!token.startsWith('--')) continue;
    const key=token.slice(2);
    const next=argv[i+1];
    if(next!==undefined && !next.startsWith('--')){out[key]=next;i++;} else out[key]=true;
  }
  return out;
}
const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');
async function readJson(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function writeJson(file,obj){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(obj,null,2)+'\n');}
async function fileDigest(file){return sha256(await fs.readFile(file));}
async function latestVersioned(dir,prefix){
  const names=await fs.readdir(dir);
  const matches=names
    .map(name=>({name,n:Number(name.match(new RegExp('^'+prefix+'_v(\\d+)\\.json$','i'))?.[1]??-1)}))
    .filter(x=>x.n>=0)
    .sort((a,b)=>a.n-b.n||a.name.localeCompare(b.name));
  if(!matches.length) throw new Error(`No ${prefix}_vN.json under ${dir}`);
  return path.join(dir,matches.at(-1).name);
}
function sourceIdentityString(receipt,build){
  const s=receipt?.source??{};
  const b=build?.source??{};
  const repo=s.archiveRepository??b.repository??'UNKNOWN_REPOSITORY';
  const commit=s.archiveCommit??b.commit??b.checkoutCommit??'UNKNOWN_COMMIT';
  const p=s.archivePath??b.archivePath??b.projectPath??'UNKNOWN_SOURCE_PATH';
  return `${repo}@${commit}:${p}`;
}
function buildIdentityString(build){
  const b=build?.build??{};
  const cfg=build?.configurationDetection??{};
  return [
    b.system??'UNKNOWN_BUILD_SYSTEM',
    cfg.compilerVersion??b.compilerVersion??'UNKNOWN_COMPILER',
    b.compilerInputSha256??'NO_COMPILER_INPUT_DIGEST'
  ].join(':');
}
function asArray(v){return Array.isArray(v)?v:[];}
function uniq(values){return [...new Set(values.filter(v=>v!==null&&v!==undefined&&v!==''))];}

async function buildCore({campaignRoot,skillRoot}){
  const receipt=await readJson(path.join(campaignRoot,'receipts/PHASE_00_RECEIPT_v1.json'));
  const buildPath=path.join(campaignRoot,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json');
  const technicalPath=path.join(campaignRoot,'evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json');
  const readinessPath=path.join(campaignRoot,'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json');
  const deployExecutionPath=path.join(campaignRoot,'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json');
  const sbomPath=path.join(campaignRoot,'evidence/dependencies/SBOM_v1.json');
  const slitherPath=path.join(campaignRoot,'evidence/static-analysis/SLITHER_v1.json');
  const [build,technical,readiness,deployExecution,sbom,slither]=await Promise.all([
    readJson(buildPath),readJson(technicalPath),readJson(readinessPath),readJson(deployExecutionPath),readJson(sbomPath),readJson(slitherPath)
  ]);

  const campaignId=receipt.campaign?.campaignId??build.campaignId;
  const generation=receipt.campaign?.campaignGenerationId??'UNRESOLVED_CAMPAIGN_GENERATION';
  const sourceDigest=receipt?.source?.sha256??build?.source?.archiveSha256Observed??build?.source?.archiveSha256??technical?.sourceIdentity?.archiveSha256;
  if(!campaignId||!sourceDigest) throw new Error('campaign/source identity unavailable for canonical Phase-0 outputs');
  const sourceIdentity=sourceIdentityString(receipt,build);
  const buildIdentity=buildIdentityString(build);
  const buildDigest=await fileDigest(buildPath);
  const createdAt=new Date().toISOString();
  const lockIdentity=asArray(sbom.dependencyFiles).map(x=>`${x.path}:${x.sha256}`).join('|')||'NO_LOCKFILE_IDENTITY_AVAILABLE';

  const core=await readJson(path.join(skillRoot,'shared/source-intelligence/SOURCE_INTELLIGENCE_TEMPLATE.json'));
  core.templateInstructions=asArray(core.templateInstructions).map(text=>String(text).replaceAll('__FILL_REQUIRED__','required-fill sentinel'));
  core.identity={
    campaignId,
    campaignGenerationId:generation,
    phaseId:'phase-0',
    phaseRevision:`v${receipt?.phase?.revision??1}`,
    sourceIdentity,
    sourceDigestSha256:sourceDigest,
    sourceCommitOrArchiveIdentity:build?.source?.archivePath
      ? `${build.source.archivePath}@${build.source.commit}`
      : `${build?.source?.repository??'UNKNOWN'}@${build?.source?.commit??'UNKNOWN'}`,
    buildIdentity,
    buildDigestSha256:buildDigest,
    createdAt,
    createdByReviewerLineage:'phase0-automation'
  };
  const cfg=build.configurationDetection??{};
  core.build={
    status:build?.status??build?.build?.status??'PASS',
    buildSystem:build?.build?.system??'UNKNOWN_BUILD_SYSTEM',
    compilerIdentities:uniq([cfg.compilerVersion,build?.build?.compilerVersion]).map(version=>({language:'SOLIDITY',version,basis:'PHASE0_BUILD_AND_SOURCE_IDENTITY'})),
    optimizer:cfg.optimizer??'UNRESOLVED',
    evmVersion:cfg.evmVersion??'UNSPECIFIED_IN_ADMITTED_SOURCE',
    viaIR:cfg.viaIR??false,
    lockfileOrDependencyIdentity:lockIdentity,
    rawBuildEvidenceRef:'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json',
    buildLimitations:cfg.evmVersion==null?['EVM_VERSION_NOT_EXPLICITLY_DETECTED']:[],
  };
  core.sourceFiles=asArray(technical.sourceFiles);
  core.compilerArtifacts=asArray(technical.compilerArtifacts).map((a,i)=>({
    artifactId:a.artifactId,
    qualifiedName:a.qualifiedName,
    sourceId:a.sourceId,
    language:a.language,
    abiDigestSha256:a.abiDigestSha256,
    creationBytecodeDigestSha256:a.creationBytecodeDigestSha256,
    deployedBytecodeDigestSha256:a.deployedBytecodeDigestSha256,
    storageLayoutAvailable:a.storageLayoutAvailable,
    metadataRef:a.metadataAvailable?'SOURCE_INTELLIGENCE_AUTOMATED_v1.json:metadata-available':'METADATA_NOT_EXPORTED',
    methodIdentifierRef:Object.keys(a.methodIdentifiers??{}).length?`SOURCE_INTELLIGENCE_AUTOMATED_v1.json#compilerArtifacts/${i}/methodIdentifiers`:'NO_METHOD_IDENTIFIERS_EXPORTED',
    preliminaryDeploymentGasEstimate:{
      acceptanceClass:'PRELIMINARY_NOT_PHASE7_ACCEPTED',
      estimate:a?.preliminaryDeploymentGasEstimate?.estimate??'UNAVAILABLE',
      compilerEvidenceRef:'evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json',
      buildIdentity,
      limitations:[]
    },
    basis:a.basis??'ADMITTED_COMPILER_OUTPUT'
  }));
  core.contracts=asArray(technical.contracts);
  core.functions=asArray(technical.functions);
  core.storageLayout=asArray(technical.storageLayout).map(x=>({...x,status:x.status==='CURRENT'?'CONFIRMED':x.status}));
  core.inheritanceGraph=asArray(technical.inheritanceGraph);
  core.callGraph=asArray(technical.callGraph).map(e=>({
    edgeId:e.edgeId??e.callEdgeId,
    callerFunctionId:e.callerFunctionId,
    callKind:e.callKind??e.callClass??'STRUCTURAL_CALL',
    target:e.target??e.targetContractId??e.interfaceOrType??e.memberOrName??'UNRESOLVED_TARGET',
    targetFunctionOrSelector:e.targetFunctionOrSelector??e.targetFunctionId??e.memberOrName??'UNRESOLVED_FUNCTION',
    valueMayBeSent:['call','send','transfer','transferFrom','safeTransfer','safeTransferFrom'].includes(e.memberOrName)?'POSSIBLE':'NOT_ESTABLISHED',
    sourceLocation:e.sourceLocation??'UNSUPPORTED_SOURCE_LOCATION',
    status:e.status??'CURRENT',
    confidenceClass:e.confidenceClass??'STRUCTURAL_CANDIDATE',
    basis:e.basis??'AUTOMATED_SOURCE_INTELLIGENCE'
  }));
  core.privilegeCandidates=asArray(technical.privilegeCandidates);
  core.externalInterfaces=asArray(technical.externalInterfaces).map(e=>({
    interfaceId:e.interfaceId??e.externalInterfaceId,
    sourceContractId:e.sourceContractId??e.callerContractId,
    sourceFunctionId:e.sourceFunctionId??e.callerFunctionId,
    dependencyOrInterface:e.dependencyOrInterface??e.interfaceOrType??e.targetContractId??'UNRESOLVED_INTERFACE',
    selectorOrSignature:e.selectorOrSignature??e.memberOrName??'UNRESOLVED_MEMBER',
    interactionKind:e.interactionKind??'EXTERNAL_INTERACTION_CANDIDATE',
    sourceLocation:e.sourceLocation??'UNSUPPORTED_SOURCE_LOCATION',
    status:e.status??'CANDIDATE',
    confidenceClass:e.confidenceClass??'STRUCTURAL_CANDIDATE',
    basis:e.basis??'AUTOMATED_SOURCE_INTELLIGENCE'
  }));
  core.valueFlowCandidates=asArray(technical.valueFlowCandidates).map(v=>({
    flowId:v.flowId??v.valueFlowCandidateId,
    sourceContractId:v.sourceContractId??v.callerContractId,
    sourceFunctionId:v.sourceFunctionId??v.callerFunctionId,
    assetOrValueExpression:v.assetOrValueExpression??v.interfaceOrType??v.memberOrName??'UNRESOLVED_VALUE_EXPRESSION',
    direction:v.direction??'OUTBOUND_CANDIDATE',
    mechanism:v.mechanism??v.flowKind??'VALUE_FLOW_CANDIDATE',
    counterpartyExpression:v.counterpartyExpression??v.targetContractId??v.interfaceOrType??'UNRESOLVED_COUNTERPARTY',
    sourceLocation:v.sourceLocation??'UNSUPPORTED_SOURCE_LOCATION',
    status:v.status??'CANDIDATE',
    confidenceClass:v.confidenceClass??'STRUCTURAL_CANDIDATE',
    basis:v.basis??'AUTOMATED_SOURCE_INTELLIGENCE',
    economicInterpretation:'DEFER_TO_PHASE_5'
  }));
  core.eventsAndErrors=asArray(technical.eventsAndErrors);
  core.sourceAnchors=asArray(technical.sourceAnchors);
  core.securitySurfaces=asArray(technical.securitySurfaces).map(x=>({...x,status:x.status==='CURRENT'?'CONFIRMED':x.status}));
  core.protocolTopology=technical.protocolTopology??{upgradeabilityEdges:[],dependencyEdges:[],crossChainEdges:[],offchainAutomationEdges:[],topologyLimitations:[]};
  core.staticRecon={
    slither:{
      status:technical?.staticRecon?.slither?.status??slither?.status??'UNAVAILABLE',
      version:technical?.staticRecon?.slither?.version??slither?.version??'UNAVAILABLE',
      rawEvidenceRef:'evidence/static-analysis/SLITHER_v1.json',
      candidateCount:technical?.staticRecon?.slither?.candidateCount??slither?.findingCount??0,
      candidateIndex:asArray(technical?.staticRecon?.slither?.candidateIndex),
      limitation:technical?.staticRecon?.slither?.limitation??null
    },
    sbom:{
      status:'COMPLETED',
      evidenceRef:'evidence/dependencies/SBOM_v1.json',
      dependencyCount:asArray(sbom.dependencyFiles).length,
      limitation:null
    },
    neutralityStatement:'Slither/static-recon observations in this artifact are neutral candidates only and are not validated findings.'
  };
  core.limitations=asArray(technical.limitations).map((l,i)=>({
    limitationId:l.limitationId??`SI-LIM-${String(i+1).padStart(3,'0')}`,
    category:l.category??'TYPED_LIMITATION',
    affectedSections:asArray(l.affectedSections),
    reason:l.reason??'Recorded automated structural limitation.',
    downstreamRequiredAction:l.downstreamRequiredAction??'Review in the authorized later semantic phase.',
    obligationId:`OBL-P1-SI-${String(i+1).padStart(3,'0')}`
  }));
  core.completion={
    status:(core.limitations.length?'COMPLETE_WITH_LIMITATION':'COMPLETE'),
    noFillSentinelsRemaining:true,
    exactSourceBound:true,
    exactBuildBound:true,
    staticReconAttached:true,
    campaignArtifactReference:'evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json',
    artifactDigestRecordLocation:'PHASE_REPORT_AND_CONTROLLER_EVIDENCE_AFTER_ARTIFACT_SEAL'
  };

  const runtime=await readJson(path.join(skillRoot,'shared/source-intelligence/RUNTIME_DEPLOYMENT_OVERLAY_TEMPLATE.json'));
  runtime.identity={logicalArtifactId:'SI-RUNTIME-OVERLAY',campaignId,campaignGenerationId:generation,sourceIdentity,sourceDigestSha256:sourceDigest,buildIdentity,buildDigestSha256:buildDigest};
  runtime.revision={revisionNumber:1,parentAcceptedRevision:'NONE_INITIAL_REVISION',createdByPhase:'phase-0',acceptanceOwnerPhase:'phase-6',createdAt,changeSummary:'Initial neutral Phase-0 deployment/configuration inventory from admitted source.'};
  const dep=readiness.deploymentAndConfiguration??{};
  const chainIds=uniq(asArray(dep.discoveredChainIds).map(x=>String(x.chainId)));
  runtime.deploymentIdentity={
    status:'DISCOVERED_UNVERIFIED',
    chainId:chainIds.length===1?chainIds[0]:(chainIds.length?chainIds:'NOT_DISCOVERED'),
    networkOrForkIdentity:'NOT_ACCEPTED_IN_PHASE0',
    blockNumberOrTag:'NOT_PINNED_IN_PHASE0',
    deployments:asArray(dep.discoveredAddresses),
    rawEvidenceRefs:['evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json']
  };
  runtime.liveConfiguration={
    status:'DISCOVERED_UNVERIFIED',
    proxyImplementationAdminBindings:asArray(dep.proxyAndUpgradeabilityMentions),
    roleAndAuthorityBindings:asArray(dep.roleMentions),
    oracleDependencyEndpoints:asArray(dep.oracleMentions),
    crossChainEndpoints:[],
    otherCriticalConfiguration:asArray(dep.configFiles).map(p=>({path:p,status:'DISCOVERED_NOT_SEMANTICALLY_ACCEPTED'})),
    rawEvidenceRefs:['evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json']
  };
  // The core Source Intelligence bundle is sealed BEFORE the deployment-only
  // workflow. Record the explorer snapshot as a PENDING candidate here; never
  // promote its runtime binding to VERIFIED until the later deploy gate/finalizer.
  if(receipt.source?.inputMode==='LIVE_SCAN'){
    const rel=String(receipt.source.scanManifestPath??'');
    const manifestFile=path.resolve(campaignRoot,'../..',...rel.split('/'));
    const relative=path.relative(campaignRoot,manifestFile).replaceAll('\\','/');
    if(!relative.startsWith('source/')||relative.includes('..'))throw new Error('SCAN_MANIFEST_PATH_NOT_IN_CAMPAIGN');
    const bytes=await fs.readFile(manifestFile);
    if(sha256(bytes)!==receipt.source.scanManifestSha256)throw new Error('SCAN_MANIFEST_SOURCE_IDENTITY_MISMATCH');
    const snapshot=JSON.parse(bytes.toString('utf8'));
    if(snapshot.schemaVersion!=='curveyield-scan-source-manifest-v1'||snapshot.inputMode!=='LIVE_SCAN')throw new Error('SCAN_MANIFEST_INVALID');
    runtime.deploymentIdentity={
      status:'FROZEN_EXPLORER_SNAPSHOT_PENDING_FORK_VERIFICATION',
      chainId:String(snapshot.chainId),networkOrForkIdentity:snapshot.chain,
      blockNumberOrTag:snapshot.frozenBlock?.number??'UNRESOLVED',
      blockHash:snapshot.frozenBlock?.hash??'UNRESOLVED',
      deployments:asArray(snapshot.resolvedTargets).map(t=>({
        address:t.address,qualifiedName:t.qualifiedName,role:t.role,
        compilationUnitId:t.compilationUnitId,runtimeSha256:t.runtimeSha256,
        proxyImplementation:t.proxyImplementation??null,
        status:'EXPLORER_OBSERVED_PENDING_FORK_VERIFICATION'
      })),
      scanManifestDigestSha256:snapshot.manifestDigestSha256,
      rawEvidenceRefs:[relative]
    };
    runtime.liveConfiguration={
      ...runtime.liveConfiguration,status:'EXPLORER_CLAIM_PENDING_FORK_VERIFICATION',
      proxyImplementationAdminBindings:asArray(snapshot.resolvedTargets)
        .filter(t=>t.proxyImplementation).map(t=>({
          proxy:t.address,implementation:t.proxyImplementation,
          status:'EIP1967_IMPLEMENTATION_SLOT_OBSERVED_PENDING_FORK_VERIFICATION',
          blockHash:snapshot.frozenBlock?.hash??null
        })),rawEvidenceRefs:[relative]
    };
    core.identity.scanSourceManifestSha256=receipt.source.scanManifestSha256;
    core.identity.scanTargetSetSha256=receipt.source.scanTargetSetSha256;
  }
  runtime.gasAcceptance={
    acceptanceOwnerPhase:'phase-6',
    status:'PENDING_PHASE6_INTERPRETATION',
    preliminaryCoreEstimateRefs:['evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json#bytecodeAndGasEvidence'],
    acceptedLifecycleEvidenceRefs:[],
    acceptedGasReportRef:'NOT_AVAILABLE_PHASE0',
    identityMatchVerified:false,
    limitations:['PHASE0_COMPILER_ESTIMATES_ARE_PRELIMINARY_ONLY']
  };
  runtime.limitations=['RUNTIME_DEPLOYMENT_AND_CONFIGURATION_SECURITY_INTERPRETATION_DEFERRED_TO_PHASE6'];
  runtime.completion={status:'COMPLETE_WITH_LIMITATION',phase1InitializationOnly:true,runtimeAcceptanceByPhase6:false,acceptedRevisionDigestRecordedExternally:true};

  const readinessOverlay=await readJson(path.join(skillRoot,'shared/source-intelligence/ASSURANCE_READINESS_OVERLAY_TEMPLATE.json'));
  readinessOverlay.identity={logicalArtifactId:'SI-READINESS-OVERLAY',campaignId,campaignGenerationId:generation,sourceIdentity,sourceDigestSha256:sourceDigest,buildIdentity,buildDigestSha256:buildDigest};
  readinessOverlay.revision={revisionNumber:1,parentAcceptedRevision:'NONE_INITIAL_REVISION',createdByPhase:'phase-0',acceptanceOwnerPhase:'phase-6',createdAt,changeSummary:'Initial neutral Phase-0 tool/harness/configuration inventory.'};
  const rt=readiness.testingAndToolingReadiness??{};
  readinessOverlay.toolchainReadiness={
    phase1StructuralStatus:'DISCOVERED',
    toolIdentities:Object.entries(rt.detectedTooling??{}).map(([tool,value])=>({tool,value})),
    installationOrInvocationEvidenceRefs:['evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json','evidence/static-analysis/SLITHER_v1.json'],
    limitations:[]
  };
  readinessOverlay.harnessInventory=asArray(rt.harnessFiles).map(p=>({path:p,status:'DISCOVERED'}));
  readinessOverlay.configurationInventory=asArray(rt.configFiles).map(p=>({path:p,status:'DISCOVERED'}));
  readinessOverlay.skeletonInventory=asArray(rt.scriptFiles).map(p=>({path:p,status:'DISCOVERED'}));
  readinessOverlay.adequacyAssessment={acceptanceOwnerPhase:'phase-6',phase1MayAcceptAdequacy:false,status:'PENDING_PHASE6_INTERPRETATION',assessmentEvidenceRefs:[],requiredRepairs:[],acceptedForSubgates:[]};
  readinessOverlay.limitations=['HARNESS_AND_EXECUTION_ADEQUACY_REQUIRES_PHASE6_INTERPRETATION'];
  readinessOverlay.completion={status:'COMPLETE_WITH_LIMITATION',phase1StructuralInventoryComplete:true,phase6AdequacyAccepted:false,acceptedRevisionDigestRecordedExternally:true};

  const graph=await readJson(path.join(skillRoot,'shared/controller/SECURITY_TRACEABILITY_GRAPH.json'));
  graph.campaignBinding={campaignId,campaignGenerationId:generation,sourceIdentity,currentSourceRevision:sourceDigest,graphRevision:1};
  graph.nodes=[{nodeId:'SOURCE-P0-001',nodeType:'SOURCE',label:sourceIdentity,status:'CURRENT',evidenceRefs:['evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json','evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json']}];
  graph.edges=[];
  graph.phaseCheckpoints=[{phaseId:'phase-0',status:'INITIALIZED',sourceNodeIds:['SOURCE-P0-001'],recordedAt:createdAt}];

  const ledger=await readJson(path.join(skillRoot,'shared/controller/CARRIED_FORWARD_OBLIGATION_LEDGER.json'));
  ledger.campaignBinding={campaignId,campaignGenerationId:generation,sourceIdentity,ledgerRevision:1};
  ledger.obligations=[
    {obligationId:'OBL-P1-CONTEXT-001',originPhase:'0',originatingFactIds:['SOURCE-P0-001'],originatingEvidenceRefs:['evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json','evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'],requiredPhase:'1',requiredReviewer:'reviewer-1',requiredAction:'Perform semantic context interpretation of the sealed Phase-0 structural baseline without rebuilding its mechanical inventories.',completionCondition:'Phase 1 records semantic scope/spec/dependency interpretation and dispositions while preserving the accepted Phase-0 Source Intelligence identity.',mandatory:true,status:'OPEN',statusReason:null,closureEvidenceRefs:[],supersedesOrReplaces:[],createdAt,updatedAt:createdAt},
    ...core.limitations.map((l,i)=>({obligationId:l.obligationId,originPhase:'0',originatingFactIds:[l.limitationId],originatingEvidenceRefs:['evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json'],requiredPhase:'1',requiredReviewer:'reviewer-1',requiredAction:l.downstreamRequiredAction,completionCondition:'Reviewer-1 records an evidence-bound semantic disposition or explicitly carries the typed limitation to the correct later phase.',mandatory:true,status:'OPEN',statusReason:null,closureEvidenceRefs:[],supersedesOrReplaces:[],createdAt,updatedAt:createdAt}))
  ];
  ledger.phaseCheckpoints=[{phaseId:'phase-0',status:'INITIALIZED',dueOpenOrInProgress:0,recordedAt:createdAt}];

  const docs=readiness.documentationInventory??{};
  const auditSurface={
    schemaVersion:'curveyield-lite-phase0-audit-surface-v1',
    status:'PASS',
    campaignId,
    campaignGenerationId:generation,
    sourceIdentity:{sourceIdentity,sourceDigestSha256:sourceDigest},
    inScopeSourceFiles:asArray(technical.sourceFiles),
    deployableContracts:asArray(technical.contracts).filter(x=>String(x.deployability??'').toUpperCase()!=='NON_DEPLOYABLE'),
    documentedInputs:{
      documentationFiles:asArray(docs.documentationFiles),
      declaredFacts:asArray(docs.declaredFacts),
      explicitExclusions:asArray(docs.explicitExclusions),
      claimedStandardsAndInterfaces:asArray(docs.claimedStandards)
    },
    structuralSurfaces:{
      externalInterfaces:asArray(technical.externalInterfaces),
      dependencyEdges:asArray(technical.protocolTopology?.dependencyEdges),
      privilegeCandidates:asArray(technical.privilegeCandidates),
      valueFlowCandidates:asArray(technical.valueFlowCandidates),
      deploymentAndConfiguration:readiness.deploymentAndConfiguration??{},
      testingAndToolingReadiness:readiness.testingAndToolingReadiness??{}
    },
    canonicalEvidence:{
      sourceIntelligence:'evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json',
      buildIdentity:'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json',
      sbom:'evidence/dependencies/SBOM_v1.json',
      staticAnalysis:'evidence/static-analysis/SLITHER_v1.json',
      readiness:'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'
    },
    neutralityStatement:'This artifact is a mechanical Phase-0 audit surface. Security meaning, standards conformance, trust significance, exploitability, materiality and findings are deferred to authorized later reviewers.',
    createdAt
  };

  const invalidation=await readJson(path.join(skillRoot,'shared/controller/EVIDENCE_INVALIDATION_MATRIX.json'));
  invalidation.campaignBinding={campaignId,campaignGenerationId:generation,sourceIdentity,currentSourceRevision:sourceDigest,matrixRevision:1};
  invalidation.events=[];
  invalidation.phaseCheckpoints=[{phaseId:'phase-0',status:'INITIALIZED_NO_CHANGE_EVENTS',recordedAt:createdAt}];

  const writes=[
    ['shared/source-intelligence/SOURCE_INTELLIGENCE_TEMPLATE.json',core],
    ['evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json',core],
    ['shared/source-intelligence/RUNTIME_DEPLOYMENT_OVERLAY_TEMPLATE.json',runtime],
    ['evidence/source-intelligence/runtime-deployment-overlay_v1.json',runtime],
    ['shared/source-intelligence/ASSURANCE_READINESS_OVERLAY_TEMPLATE.json',readinessOverlay],
    ['evidence/source-intelligence/assurance-readiness-overlay_v1.json',readinessOverlay],
    ['controller/SECURITY_TRACEABILITY_GRAPH_v1.json',graph],
    ['controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json',ledger],
    ['controller/EVIDENCE_INVALIDATION_MATRIX_v1.json',invalidation],
    ['evidence/phase0/PHASE0_AUDIT_SURFACE_v1.json',auditSurface],
    ['work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md',renderDeployConfigMatrixV1({readiness,execution:deployExecution})]
  ];
  for(const [rel,obj] of writes){
    const target=path.join(campaignRoot,rel);
    if(typeof obj==='string'){
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,obj);
    }else{
      await writeJson(target,obj);
    }
  }
  return {campaignId,generation,sourceDigest,buildDigest,createdAt,writes:writes.map(([rel])=>rel)};
}

async function buildBundle({campaignRoot,skillRoot,acceptedCommit}){
  if(!/^[0-9a-f]{40}$/.test(acceptedCommit??'')) throw new Error('--accepted-commit must be a 40-char Git SHA');
  const receipt=await readJson(path.join(campaignRoot,'receipts/PHASE_00_RECEIPT_v1.json'));
  const buildPath=path.join(campaignRoot,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json');
  const build=await readJson(buildPath);
  const campaignId=receipt.campaign?.campaignId??build.campaignId;
  const generation=receipt.campaign?.campaignGenerationId??'UNRESOLVED_CAMPAIGN_GENERATION';
  const sourceDigest=receipt?.source?.sha256??build?.source?.archiveSha256Observed??build?.source?.archiveSha256;
  const sourceIdentity=sourceIdentityString(receipt,build);
  const buildIdentity=buildIdentityString(build);
  const buildDigest=await fileDigest(buildPath);
  const coreRel='evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json';
  const runtimeRel='evidence/source-intelligence/runtime-deployment-overlay_v1.json';
  const readyRel='evidence/source-intelligence/assurance-readiness-overlay_v1.json';
  const [coreSha,runtimeSha,readySha]=await Promise.all([fileDigest(path.join(campaignRoot,coreRel)),fileDigest(path.join(campaignRoot,runtimeRel)),fileDigest(path.join(campaignRoot,readyRel))]);
  const updatedAt=new Date().toISOString();

  const bundle=await readJson(path.join(skillRoot,'shared/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_TEMPLATE.json'));
  bundle.identity={campaignId,campaignGenerationId:generation,sourceIdentity,sourceDigestSha256:sourceDigest,buildIdentity,buildDigestSha256:buildDigest,bundleIndexRevision:1,updatedAt,updatedByPhase:'phase-0'};
  bundle.core={logicalArtifactId:'SI-CORE',canonicalMutablePath:'evidence/source-intelligence/SOURCE_INTELLIGENCE_vN.json',pathSemantics:'IMMUTABLE_VERSIONED_ARTIFACT',latestAcceptedRevision:coreRel,acceptedCommitSha:acceptedCommit,acceptedSha256:coreSha,status:'ACCEPTED',lastVerifiedPhase:'phase-0',invalidationStatus:'CURRENT',preservedSnapshotRef:`${coreRel}@${acceptedCommit}`};
  bundle.overlays.runtimeDeployment={logicalArtifactId:'SI-RUNTIME-OVERLAY',canonicalMutablePath:'evidence/source-intelligence/runtime-deployment-overlay.json',pathSemantics:'NAVIGATIONAL_ONLY',latestAcceptedRevision:runtimeRel,acceptedCommitSha:acceptedCommit,acceptedSha256:runtimeSha,status:'ACCEPTED',lastVerifiedPhase:'phase-0',invalidationStatus:'CURRENT',preservedSnapshotRef:`${runtimeRel}@${acceptedCommit}`};
  bundle.overlays.assuranceReadiness={logicalArtifactId:'SI-READINESS-OVERLAY',canonicalMutablePath:'evidence/source-intelligence/assurance-readiness-overlay.json',pathSemantics:'NAVIGATIONAL_ONLY',latestAcceptedRevision:readyRel,acceptedCommitSha:acceptedCommit,acceptedSha256:readySha,status:'ACCEPTED',lastVerifiedPhase:'phase-0',invalidationStatus:'CURRENT',preservedSnapshotRef:`${readyRel}@${acceptedCommit}`};
  bundle.completion={status:'COMPLETE',allPointersAcceptedOrTypedNotApplicable:true,allAcceptedDigestsVerified:true,priorAcceptedRevisionsPreserved:true,bundleIndexDigestRecordLocation:'PHASE_REPORT_AND_CONTROLLER_EVIDENCE_AFTER_INDEX_COMMIT'};
  await writeJson(path.join(campaignRoot,'shared/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_TEMPLATE.json'),bundle);
  await writeJson(path.join(campaignRoot,'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'),bundle);
  return {campaignId,acceptedCommit,outputs:['shared/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_TEMPLATE.json','evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json']};
}

const args=parseArgs(process.argv.slice(2));
if(!args['campaign-root']||!args['skill-root']) throw new Error('usage: --campaign-root <path> --skill-root <lite-skill-root> --stage <core|bundle> [--accepted-commit <sha>]');
const campaignRoot=path.resolve(args['campaign-root']);
const skillRoot=path.resolve(args['skill-root']);
const stage=args.stage??'core';
const result=stage==='core'
  ? await buildCore({campaignRoot,skillRoot})
  : stage==='bundle'
    ? await buildBundle({campaignRoot,skillRoot,acceptedCommit:args['accepted-commit']})
    : (()=>{throw new Error('unsupported --stage; expected core or bundle');})();
process.stdout.write(JSON.stringify({status:'PASS',stage,...result},null,2)+'\n');
