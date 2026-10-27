#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {assertDeployGateEvidenceV2,digestV2} from './lib/phase0-deploy-gate-v2.mjs';
import {compareLiveRuntimeV1} from '../packages/github-native-sim/src/phase0-deployment-profile-v1.mjs';
import { createHash } from 'node:crypto';
import {preparePhaseWork} from './lib/lite-solo-phase-work-v1.mjs';
import {detectionPolicyForAuthorityV1,authorityRootFromHomepageV1} from '../packages/github-native-sim/src/adr-policy-v1.mjs';
import {buildFlowPlanV1} from '../packages/github-native-sim/src/adr-flow-plan-v1.mjs';

function args(argv){const out={};for(let i=2;i<argv.length;i+=2){const k=argv[i],v=argv[i+1];if(!k?.startsWith('--')||v===undefined)throw new Error('arguments must be --key value');out[k.slice(2)]=v;}return out;}
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function digestFile(file){return sha(fs.readFileSync(file));}
function required(file,label){if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw new Error('missing '+label+': '+file);return file;}
function rel(root,file){return path.relative(root,file).replaceAll('\\','/');}
function upsert(rows,row,key='path'){const out=Array.isArray(rows)?structuredClone(rows):[];const i=out.findIndex(x=>x?.[key]===row?.[key]);if(i>=0)out[i]=row;else out.push(row);return out;}

const a=args(process.argv);
for(const k of ['controller-root','campaign-path','contract-automation-sha','bootstrap-sha','workflow-run-id']) if(!a[k]) throw new Error('missing --'+k);
const controllerRoot=path.resolve(a['controller-root']);
const campaignPath=a['campaign-path'];
if(!campaignPath.startsWith('campaigns/')||campaignPath.includes('..')) throw new Error('unsafe campaign path');
const campaignRoot=path.join(controllerRoot,...campaignPath.split('/'));
const receiptPath=path.join(campaignRoot,'receipts/PHASE_00_RECEIPT_v1.json');
const receipt=read(required(receiptPath,'Phase-0 receipt'));
if(receipt.authority?.liteRelease!=='audit-preview-v1'||receipt.auditPreview?.terminalPhase!==4||
  !Number.isSafeInteger(receipt.auditPreview?.permittedContracts)||receipt.auditPreview.permittedContracts<1)
 throw new Error('AUDIT_PREVIEW_INVALID_PERMIT_OR_AUTHORITY');
const countFile=required(path.join(campaignRoot,'evidence/phase0/AUDIT_PREVIEW_CONTRACT_COUNT_v1.json'),'Audit Preview Phase-0 contract count');
const countGate=read(countFile);
if(countGate.status!=='PASS'||countGate.stage!=='deployment'||countGate.permittedContracts!==receipt.auditPreview.permittedContracts||
 !Number.isSafeInteger(countGate.count)||countGate.count>receipt.auditPreview.permittedContracts)
 throw new Error('AUDIT_PREVIEW_ECONTRACT_LIMIT: Number of contracts exceeds permit');

if(receipt.schemaVersion!=='curveyield-lite-phase-receipt-v1'||receipt.campaign?.mode!=='LITE_SOLO'||receipt.phase?.sequence!==0) throw new Error('invalid Phase-0 receipt');
if(!['ACTIVE','EVIDENCE_READY','VALIDATING'].includes(receipt.phase.status)) throw new Error('Phase-0 receipt is not finalizable');
if(!/^[0-9a-f]{40}$/.test(a['contract-automation-sha'])||
   a['contract-automation-sha']!==a['bootstrap-sha'])
  throw new Error('Phase-0 finalizer must seal the exact workflow checkout commit');

const evidence={
  build:required(path.join(campaignRoot,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'),'build identity'),
  executionBuildArtifacts:required(path.join(campaignRoot,'evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json'),'reusable build artifacts'),
  sbom:required(path.join(campaignRoot,'evidence/dependencies/SBOM_v1.json'),'SBOM'),
  slither:required(path.join(campaignRoot,'evidence/static-analysis/SLITHER_v1.json'),'Slither evidence'),
  sourceIntelligence:required(path.join(campaignRoot,'evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json'),'Source Intelligence'),
  runtimeOverlay:required(path.join(campaignRoot,'evidence/source-intelligence/runtime-deployment-overlay_v1.json'),'runtime overlay'),
  readinessOverlay:required(path.join(campaignRoot,'evidence/source-intelligence/assurance-readiness-overlay_v1.json'),'readiness overlay'),
  bundle:required(path.join(campaignRoot,'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'),'Source Intelligence bundle'),
  readiness:required(path.join(campaignRoot,'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'),'project readiness'),
  deployConfigExecution:required(path.join(campaignRoot,'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'),'forked package deploy/config evidence'),
  deployConfigMatrix:required(path.join(campaignRoot,'work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md'),'Phase-6 deploy/config matrix'),
  targetedTestMatrix:required(path.join(campaignRoot,'work/phase-06/LITE_TARGETED_TEST_MATRIX.md'),'Phase-6 targeted-test matrix'),
  auditSurface:required(path.join(campaignRoot,'evidence/phase0/PHASE0_AUDIT_SURFACE_v1.json'),'Phase-0 audit surface'),
  graph:required(path.join(campaignRoot,'controller/SECURITY_TRACEABILITY_GRAPH_v1.json'),'traceability graph'),
  ledger:required(path.join(campaignRoot,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json'),'obligation ledger'),
  invalidation:required(path.join(campaignRoot,'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json'),'evidence invalidation matrix')
};
const sourceSha=receipt.source?.sha256;
if(typeof sourceSha!=='string'||!/^[0-9a-f]{64}$/.test(sourceSha))throw new Error('canonical source digest missing');
const build=read(evidence.build);
if(build.source?.archiveSha256Observed!==sourceSha&&build.source?.archiveSha256!==sourceSha)throw new Error('build identity differs from canonical archive');
const bundle=read(evidence.bundle);
if(bundle.identity?.sourceDigestSha256!==sourceSha)throw new Error('Source Intelligence source digest mismatch');
const artifacts=read(evidence.executionBuildArtifacts);
if(artifacts.schemaVersion!=='curveyield-phase0-execution-build-artifacts-v2'||artifacts.source?.archiveSha256!==sourceSha||artifacts.reuseContract?.secondBuildRequired!==false)throw new Error('reusable build artifact contract is missing');
const deploy=read(evidence.deployConfigExecution);
if(deploy.schemaVersion!=='curveyield-lite-phase0-deploy-config-execution-v3'||deploy.executionMode!=='ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY')throw new Error('Phase-0 requires only source package forked deployment evidence');
if(deploy.campaignId!==receipt.campaign.campaignId||deploy.sourceSha256!==sourceSha||deploy.fork?.engine!=='anvil')throw new Error('Phase-0 fork deployment identity mismatch');
assertDeployGateEvidenceV2(deploy);
if(receipt.source?.inputMode==='LIVE_SCAN'){
  if(receipt.source.kind!=='EXPLORER_INITIALIZED_VERIFIED_LIVE_SNAPSHOT'||!Array.isArray(receipt.source.originUrls))throw new Error('SCAN_RECEIPT_PROVENANCE_MISSING');
  const manifestPath=path.resolve(controllerRoot,...String(receipt.source.scanManifestPath??'').split('/'));
  if(!manifestPath.startsWith(campaignRoot+path.sep))throw new Error('SCAN_MANIFEST_PATH_ESCAPES_CAMPAIGN');
  required(manifestPath,'frozen LIVE_SCAN source manifest');
  if(digestFile(manifestPath)!==receipt.source.scanManifestSha256)throw new Error('SCAN_MANIFEST_FILE_DIGEST_MISMATCH');
  const manifest=read(manifestPath);
  const {manifestDigestSha256,...unsigned}=manifest;
  const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
  if(manifest.schemaVersion!=='curveyield-scan-source-manifest-v1'||manifest.inputMode!=='LIVE_SCAN'||
     sha(canonical(unsigned))!==manifestDigestSha256||
     manifestDigestSha256!==receipt.source.scanTargetSetSha256)
    throw new Error('SCAN_TARGET_SET_IDENTITY_MISMATCH');
  const requested=manifest.requestedTargets??[],targets=manifest.resolvedTargets??[],units=manifest.compilerUnits??[];
  if(!requested.length||!targets.length||targets.length>64||!units.length)throw new Error('SCAN_SOURCE_TARGETS_INCOMPLETE');
  if(requested.length!==receipt.source.originUrls.length)throw new Error('SCAN_SOURCE_REQUEST_COUNT_MISMATCH');
  for(let i=0;i<requested.length;i++){
    const u=new URL(receipt.source.originUrls[i]);
    if(requested[i].toLowerCase()!==u.pathname.split('/').pop()?.toLowerCase())throw new Error('SCAN_REQUEST_URL_ADDRESS_MISMATCH');
  }
  if(deploy.status!=='PASS_LIVE_DEPLOYMENT'||deploy.deploymentProfile?.mode!=='LIVE'||
     deploy.fork?.chainId!==manifest.chainId||deploy.fork?.initialBlock!==manifest.frozenBlock.number||
     deploy.liveDeployment?.blockNumber!==manifest.frozenBlock.number||
     deploy.liveDeployment?.blockHash?.toLowerCase()!==manifest.frozenBlock.hash.toLowerCase()||
     deploy.scanSourceSnapshot?.manifestDigestSha256!==manifestDigestSha256)
    throw new Error('SCAN_FROZEN_LIVE_EVIDENCE_MISMATCH');
  const declared=deploy.deploymentProfile.contracts??[],observed=deploy.liveDeployment.contracts??[];
  if(declared.length!==targets.length||observed.length!==targets.length)throw new Error('SCAN_LIVE_TARGET_COVERAGE_INCOMPLETE');
  const compiled=artifacts.artifacts??[];
  for(let i=0;i<targets.length;i++){
    const t=targets[i],d=declared[i],live=observed[i];
    if(d.address.toLowerCase()!==t.address||live.address.toLowerCase()!==t.address||
       d.qualifiedName!==t.qualifiedName||live.compilationUnitId!==t.compilationUnitId||
       live.runtimeSha256!==t.runtimeSha256)
      throw new Error('SCAN_TARGET_CODE_BINDING_MISMATCH: '+t.address);
    const artifact=compiled.find(a=>a.compilationUnitId===t.compilationUnitId&&a.qualifiedName===t.qualifiedName);
    if(!artifact)throw new Error('SCAN_TARGET_ARTIFACT_BINDING_MISSING: '+t.address);
    if(live.sourceBinding==='EXECUTABLE_RUNTIME_MATCH_METADATA_HASH_ONLY'){
      if(live.runtimeComparison?.compiled?.toLowerCase()!==artifact.deployedBytecode?.toLowerCase()||
         compareLiveRuntimeV1(live.runtimeComparison?.observed,artifact.deployedBytecode,{allowScanMetadata:true}).sourceBinding!==live.sourceBinding)
        throw new Error('SCAN_TARGET_COMPILED_RUNTIME_BINDING_MISMATCH: '+t.address);
    }else if(live.sourceBinding!=='EXACT_COMPILED_RUNTIME')throw new Error('SCAN_TARGET_CODE_BINDING_MISMATCH: '+t.address);
    if(!units.some(u=>u.unitId===t.compilationUnitId&&(u.targetBindings??[{address:u.address,qualifiedName:u.qualifiedName}]).some(binding=>binding.qualifiedName===t.qualifiedName&&binding.address===t.address)))
      throw new Error('SCAN_TARGET_COMPILER_INPUT_BINDING_MISSING: '+t.address);
    if(t.proxyImplementation&&!targets.some(candidate=>candidate.address===t.proxyImplementation&&candidate.role==='IMPLEMENTATION'))
      throw new Error('SCAN_PROXY_IMPLEMENTATION_COVERAGE_MISSING: '+t.address);
  }
  for(const address of requested)if(!targets.some(t=>t.address===address&&t.role==='REQUESTED'))
    throw new Error('SCAN_REQUESTED_TARGET_NOT_VERIFIED: '+address);
  evidence.scanSourceManifest=manifestPath;
}

if(deploy.reconciliation){
  const rawFile=required(path.join(campaignRoot,'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json'),'immutable original fork deploy evidence');
  if(digestV2(fs.readFileSync(rawFile))!==deploy.reconciliation.originalEvidenceSha256)throw new Error('Phase-0 original deployment evidence is not byte-identical');
  evidence.deployConfigExecutionRaw=rawFile;
}

// Optional policy-gated evidence: never block a legacy Phase-0 campaign or the finalizer.
try {
  const root=authorityRootFromHomepageV1(receipt.authority.homepagePath);
  const policy=detectionPolicyForAuthorityV1({
    repoRoot:controllerRoot,authorityRoot:root,
    readJsonIfExists:(relPath)=>{
      const full=path.join(controllerRoot,...relPath.split('/'));
      return fs.existsSync(full)?read(full):null;
    }
  });
  if(policy) {
    const reviewRoot=path.join(campaignRoot,'evidence/review-inventory');
    const locate=name=>path.join(reviewRoot,name);
    const loaded=name=>fs.existsSync(locate(name))?read(locate(name)):null;
    const inventory=loaded('REVIEW_INVENTORY_v1.json');
    const facts=loaded('SYSTEM_FACTS_v1.json');
    const snapshot=loaded('DEPLOYED_STATE_SNAPSHOT_v1.json');
    const header={
      campaignId:receipt.campaign.campaignId,campaignGenerationId:receipt.campaign.campaignGenerationId,
      sourceSha256:sourceSha,taxonomyVersion:'curveyield-defect-taxonomy-v1',
      detectionPolicy:'audit-detection-rebuild-v1',generatedAt:new Date().toISOString()
    };
    const fallbackInventory={...header,schemaVersion:'curveyield-review-inventory-v1',payload:{
      sourceUnits:[],declarations:[],contexts:[],triggers:{},complete:false,
      limitations:[{code:'INVENTORY_INCOMPLETE',path:'*',detail:'Review inventory missing at Phase-0 finalization'}]
    }};
    const fallbackFacts={...header,schemaVersion:'curveyield-system-facts-v1',payload:{
      guardTable:[],siblingGroups:[],valueFlows:[],crossContractEdges:[],dependencyEdges:[]}};
    let plan;
    try {
      plan=buildFlowPlanV1({inventory:inventory??fallbackInventory,facts:facts??fallbackFacts,snapshot});
      if(!inventory||inventory.payload?.complete===false){
        if(!plan.payload.gaps.some(g=>g.code==='INVENTORY_INCOMPLETE')){
          plan.payload.gaps.push({code:'INVENTORY_INCOMPLETE',path:'*',detail:'Missing or incomplete review inventory'});
        }
      }
    } catch(error) {
      plan={...header,schemaVersion:'curveyield-flow-plan-v1',payload:{
        limits:{maxPrimaryContextsPerUnit:40,maxFlowDepth:8,maxIntegrationQuestionsPerAttackUnit:15},
        flows:[],clusters:[],reviewUnits:[],attackUnits:[],integrationQuestions:[],
        gaps:[{code:'PLAN_BUILD_ERROR',detail:String(error?.message??error).slice(0,2000)}],
        capacity:{flows:0,crossContractFlows:0,clusters:0,flowReviewUnits:0,residualUnits:0,attackUnits:0,reviewableContexts:0,integrationQuestions:0}
      }};
    }
    write(locate('FLOW_PLAN_v1.json'),plan);
    for(const name of ['REVIEW_INVENTORY_v1.json','SYSTEM_FACTS_v1.json','DEPLOYED_STATE_SNAPSHOT_v1.json','FLOW_PLAN_v1.json']) {
      const file=locate(name);
      if(fs.existsSync(file))evidence['ADR_REVIEW_INVENTORY:'+name]=file;
    }
  }
} catch(error) {
  // Invalid or absent authority manifests do not alter legacy behavior.
  console.error('ADR Phase-0 optional flow plan unavailable: '+String(error?.message??error).slice(0,2000));
}

// v3 cannot promote an absent or incomplete source-review inventory to a
// completed discovery: Phase 4 has to be generated from real source contexts.
if(receipt.authority?.liteRelease==='audit-preview-v1'){
  const reviewRoot=path.join(campaignRoot,'evidence/review-inventory');
  const inventory=read(required(path.join(reviewRoot,'REVIEW_INVENTORY_v1.json'),'complete source review inventory'));
  const facts=read(required(path.join(reviewRoot,'SYSTEM_FACTS_v1.json'),'system facts'));
  const plan=read(required(path.join(reviewRoot,'FLOW_PLAN_v1.json'),'flow plan'));
  if(inventory?.payload?.complete!==true||!Array.isArray(inventory?.payload?.contexts)||!inventory.payload.contexts.length)
    throw new Error('LITE_SOLO_INCOMPLETE_REVIEW_INVENTORY: no complete reviewable source-context inventory');
  if(!facts?.payload||!Array.isArray(plan?.payload?.reviewUnits)||!plan.payload.reviewUnits.length||
     !Array.isArray(plan?.payload?.attackUnits)||!plan.payload.attackUnits.length||
     (plan?.payload?.gaps??[]).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code)))
    throw new Error('LITE_SOLO_INCOMPLETE_FLOW_PLAN: required correctness and attack units must be generated from complete inventory');
}

const now=new Date().toISOString();
const refs=Object.entries(evidence).map(([role,file])=>({role:role.startsWith('ADR_REVIEW_INVENTORY:')?'ADR_REVIEW_INVENTORY':role,path:rel(campaignRoot,file),sha256:digestFile(file)}));
const retired=/PHASE0_RANDOMIZED_SIMULATION|PHASE0_SIMULATION_RUN_INDEX|PHASE5_SIMULATION_BASELINE_INPUT|PHASE6_SIMULATION_BASELINE_INPUT|PHASE0_TELEMETRY_ANALYSIS|MEDUSA/;
receipt.evidence=refs.reduce((rows,row)=>upsert(rows,row),(receipt.evidence??[]).filter(row=>!retired.test(String(row.role??'')+' '+String(row.path??''))));
receipt.outputs=(receipt.outputs??[]).filter(row=>!retired.test(String(row.role??'')+' '+String(row.path??'')));
receipt.outputs=upsert(receipt.outputs??[],{role:'PHASE0_AUDIT_SURFACE',path:'evidence/phase0/PHASE0_AUDIT_SURFACE_v1.json',sha256:digestFile(evidence.auditSurface)});
receipt.outputs=upsert(receipt.outputs,{role:'AUDIT_PREVIEW_CONTRACT_COUNT',path:'evidence/phase0/AUDIT_PREVIEW_CONTRACT_COUNT_v1.json',sha256:digestFile(countFile)});
receipt.outputs=upsert(receipt.outputs,{role:'PRECOMPUTED_DEPLOY_CONFIG_EVIDENCE',path:'work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md',sha256:digestFile(evidence.deployConfigMatrix)});
receipt.outputs=upsert(receipt.outputs,{role:'PHASE0_FORK_DEPLOY_CONFIG',path:'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',sha256:digestFile(evidence.deployConfigExecution)});
receipt.outputs=upsert(receipt.outputs,{role:'PRECOMPUTED_TARGETED_TEST_EVIDENCE',path:'work/phase-06/LITE_TARGETED_TEST_MATRIX.md',sha256:digestFile(evidence.targetedTestMatrix)});
receipt.globalControls={
  securityTraceabilityGraph:'controller/SECURITY_TRACEABILITY_GRAPH_v1.json',
  carriedForwardObligationLedger:'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json',
  evidenceInvalidationMatrix:'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json',
  sourceIntelligenceBundle:'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'
};
const ledger=read(evidence.ledger);
receipt.obligations.due=(ledger.obligations??[]).filter(x=>String(x.status??'OPEN').toUpperCase()==='OPEN'&&String(x.requiredPhase??'')==='1');
// Retired infrastructure qualification is not evidence for a new Phase-0 run.
receipt.automation=(receipt.automation??[]).filter(row=>row?.workflow!=='v7-execution-infrastructure-qualification.yml');
receipt.automation=upsert(receipt.automation,{workflow:'lite-solo-phase0-bootstrap-v1.yml',runId:Number(a['workflow-run-id']),status:'PASS',contractAutomationCommit:a['contract-automation-sha'],bootstrapCommit:a['bootstrap-sha']??a['contract-automation-sha']},'workflow');
receipt.validation={status:'PASS',validatedAt:now,failures:[]};
receipt.phase.status='SEALED';
receipt.sealedAt=now;
receipt.updatedAt=now;
receipt.handoff={required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:1,sameReviewer:true,status:'NOT_APPLICABLE'};
write(receiptPath,receipt);

const directoryPath=path.join(controllerRoot,...String(receipt.campaign.campaignDirectoryEntryPath).split('/'));
const directory=read(required(directoryPath,'Audit Campaign Directory entry'));
if(directory.campaignId!==receipt.campaign.campaignId) throw new Error('campaign directory identity mismatch');
const sealedPhase0Receipt=rel(controllerRoot,receiptPath);
const authorityRoot=path.posix.dirname(receipt.authority.homepagePath);
if(authorityRoot!=='Audit Skill - Audit Preview/audit-preview-v1')throw new Error('unexpected Audit Preview authority root');
if(directory.mode!=='LITE_SOLO'||directory.agent?.actorId!=='lite-solo-agent'||directory.deliveryTransport!=='DIRECT'||directory.agent?.chatUrl!=null)throw new Error('lite-solo Phase-0 directory identity mismatch');
const assignment=preparePhaseWork({
  root:controllerRoot,
  campaignPath,
  authorityRoot,
  sequence:1,
  reviewer:'lite-solo-agent',
  predecessorReceiptPath:sealedPhase0Receipt,
  derivedInputPaths:[
    path.posix.join(campaignPath,'evidence/phase0/PHASE0_AUDIT_SURFACE_v1.json'),
    path.posix.join(campaignPath,'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json')
  ],
  status:'ACTIVE'
});
const directoryV2={
  schemaVersion:'curveyield-audit-campaign-directory-entry-v2',
  campaignId:receipt.campaign.campaignId,
  campaignGenerationId:receipt.campaign.campaignGenerationId,
  campaignName:receipt.campaign.campaignName,
  workspacePath:campaignPath,
  mode:'LITE_SOLO',
  deliveryTransport:'DIRECT',
  agent:directory.agent,
  agentModel:receipt.authority.liteRelease==='audit-preview-v1'?'PARALLEL_WORKER_UNITS':'ONE_PERSISTENT_AGENT',
  executionModel:receipt.authority.liteRelease==='audit-preview-v1'?'PARALLEL_WORKER_UNITS':null,
  authorityRelease:receipt.authority.liteRelease,
  authorityDigest:receipt.authority.manifestSha256,
  unitPhaseEpoch:1,
  transportEpoch:Number(directory.transportEpoch||0),
  sourceSha256:sourceSha,
  lastSealedReceiptPath:sealedPhase0Receipt,
  campaignStatus:'ACTIVE',
  currentAssignment:assignment,
  updatedAt:now
};
write(directoryPath,directoryV2);

process.stdout.write(JSON.stringify({
  status:'PASS',
  campaignId:receipt.campaign.campaignId,
  campaignName:receipt.campaign.campaignName,
  receiptPath:sealedPhase0Receipt,
  campaignDirectoryEntryPath:receipt.campaign.campaignDirectoryEntryPath,
  successorReviewer:'lite-solo-agent',
  successorPhase:1
})+'\n');
