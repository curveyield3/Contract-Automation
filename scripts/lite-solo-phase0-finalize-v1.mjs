#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {assertDeployGateEvidenceV2,digestV2} from './lib/phase0-deploy-gate-v2.mjs';
import {compareLiveRuntimeV1} from '../packages/github-native-sim/src/phase0-deployment-profile-v1.mjs';
import { createHash } from 'node:crypto';
import {preparePhaseWork,recordPhaseFinalizationVerificationWarningV1} from './lib/lite-solo-phase-work-v1.mjs';
import {detectionPolicyForAuthorityV1,authorityRootFromHomepageV1} from '../packages/github-native-sim/src/adr-policy-v1.mjs';
import {buildFlowPlanV1} from '../packages/github-native-sim/src/adr-flow-plan-v1.mjs';

function args(argv){const out={};for(let i=2;i<argv.length;i+=2){const k=argv[i],v=argv[i+1];if(!k?.startsWith('--')||v===undefined)throw new Error('arguments must be --key value');out[k.slice(2)]=v;}return out;}
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function digestFile(file){return fs.existsSync(file)?sha(fs.readFileSync(file)):null;}
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
if(receipt.schemaVersion!=='curveyield-lite-phase-receipt-v1'||receipt.campaign?.mode!=='LITE_SOLO'||receipt.phase?.sequence!==0) throw new Error('invalid Phase-0 receipt');
if(!['ACTIVE','EVIDENCE_READY','VALIDATING','BLOCKED'].includes(receipt.phase.status)) throw new Error('Phase-0 receipt has no eligible unfinished state'); // Worker decides whether previous BLOCKED is eligible.
const invalidWorkflowCommitIdentity=!/^[0-9a-f]{40}$/.test(a['contract-automation-sha'])||
 !/^[0-9a-f]{40}$/.test(a['bootstrap-sha']);
 // The two executable revisions may differ after Contract-Automation upgrades.
 // Preserve both values in the receipt without rejecting the campaign.

const githubPhase0Diagnostics=[];
const phase0VerificationWarnings=new Set();
const phase0RecordedDiagnostics=new Set();
function phase0Warning(file,check,reason,expected=null,observed=null){
 const affectedFile=rel(controllerRoot,file);
 const diagnostic=check+': '+reason;
 githubPhase0Diagnostics.push(diagnostic);
 phase0RecordedDiagnostics.add(diagnostic);
 phase0VerificationWarnings.add(recordPhaseFinalizationVerificationWarningV1({
  root:controllerRoot,campaignPath,phase:0,affectedFile,check,reason,expected,observed
 }));
}
if(invalidWorkflowCommitIdentity)
 phase0Warning(receiptPath,'PHASE0_WORKFLOW_COMMIT_FORMAT','Recorded workflow commit identifiers are not both 40-character Git SHAs','Two 40-character lowercase Git commit identifiers',{contractAutomationSha:a['contract-automation-sha'],bootstrapSha:a['bootstrap-sha']});
function evidenceFile(file,label){
 if(!fs.existsSync(file)||!fs.statSync(file).isFile())
  phase0Warning(file,'PHASE0_REQUIRED_EVIDENCE_FILE_MISSING',
   label+' is not present at the issued campaign evidence path',
   'Existing readable '+label+' file','MISSING');
 return file;
}
function readEvidence(file){
 try{return read(file);}
 catch(error){
  phase0Warning(file,'PHASE0_EVIDENCE_JSON_UNREADABLE',
   'Cannot parse the supplied evidence JSON: '+String(error?.message??error),
   'Readable JSON evidence',String(error?.code??'JSON_READ_FAILED'));
  return {};
 }
}

const evidence={
  build:evidenceFile(path.join(campaignRoot,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'),'build identity'),
  executionBuildArtifacts:evidenceFile(path.join(campaignRoot,'evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json'),'reusable build artifacts'),
  sbom:evidenceFile(path.join(campaignRoot,'evidence/dependencies/SBOM_v1.json'),'SBOM'),
  slither:evidenceFile(path.join(campaignRoot,'evidence/static-analysis/SLITHER_v1.json'),'Slither evidence'),
  sourceIntelligence:evidenceFile(path.join(campaignRoot,'evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json'),'Source Intelligence'),
  runtimeOverlay:evidenceFile(path.join(campaignRoot,'evidence/source-intelligence/runtime-deployment-overlay_v1.json'),'runtime overlay'),
  readinessOverlay:evidenceFile(path.join(campaignRoot,'evidence/source-intelligence/assurance-readiness-overlay_v1.json'),'readiness overlay'),
  bundle:evidenceFile(path.join(campaignRoot,'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'),'Source Intelligence bundle'),
  readiness:evidenceFile(path.join(campaignRoot,'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'),'project readiness'),
  deployConfigExecution:evidenceFile(path.join(campaignRoot,'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'),'forked package deploy/config evidence'),
  deployConfigMatrix:evidenceFile(path.join(campaignRoot,'work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md'),'Phase-6 deploy/config matrix'),
  targetedTestMatrix:evidenceFile(path.join(campaignRoot,'work/phase-06/LITE_TARGETED_TEST_MATRIX.md'),'Phase-6 targeted-test matrix'),
  auditSurface:evidenceFile(path.join(campaignRoot,'evidence/phase0/PHASE0_AUDIT_SURFACE_v1.json'),'Phase-0 audit surface'),
  graph:evidenceFile(path.join(campaignRoot,'controller/SECURITY_TRACEABILITY_GRAPH_v1.json'),'traceability graph'),
  ledger:evidenceFile(path.join(campaignRoot,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json'),'obligation ledger'),
  invalidation:evidenceFile(path.join(campaignRoot,'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json'),'evidence invalidation matrix')
};
const sourceSha=receipt.source?.sha256;
if(typeof sourceSha!=='string'||!/^[0-9a-f]{64}$/.test(sourceSha))
 phase0Warning(receiptPath,'PHASE0_CANONICAL_SOURCE_DIGEST_FORMAT','Recorded source digest is missing or malformed','64 lowercase hexadecimal characters',sourceSha??null);
const build=readEvidence(evidence.build);
if(build.source?.archiveSha256Observed!==sourceSha&&build.source?.archiveSha256!==sourceSha)
 phase0Warning(evidence.build,'PHASE0_BUILD_SOURCE_BINDING','Build source SHA-256 differs from receipt source','receipt.source.sha256 = '+String(sourceSha),build.source?.archiveSha256Observed??build.source?.archiveSha256??null);
const bundle=readEvidence(evidence.bundle);
if(bundle.identity?.sourceDigestSha256!==sourceSha)
 phase0Warning(evidence.bundle,'PHASE0_SOURCE_INTELLIGENCE_SOURCE_BINDING','Source Intelligence bundle digest differs from Phase-0 receipt source',sourceSha??null,bundle.identity?.sourceDigestSha256??null);
const artifacts=readEvidence(evidence.executionBuildArtifacts);
if(artifacts.source?.archiveSha256!==sourceSha)
 phase0Warning(evidence.executionBuildArtifacts,'PHASE0_REUSABLE_ARTIFACT_SOURCE_BINDING','Reusable build-artifact source digest differs from original admitted source',sourceSha??null,artifacts.source?.archiveSha256??null);
if(artifacts.schemaVersion!=='curveyield-phase0-execution-build-artifacts-v2'||artifacts.reuseContract?.secondBuildRequired!==false)
 phase0Warning(evidence.executionBuildArtifacts,'PHASE0_BUILD_ARTIFACT_SCHEMA',
  'Execution build-artifact schema or second-build reuse declaration does not match expected original contract',
  {schemaVersion:'curveyield-phase0-execution-build-artifacts-v2',secondBuildRequired:false},
  {schemaVersion:artifacts.schemaVersion??null,secondBuildRequired:artifacts.reuseContract?.secondBuildRequired??null});
const deploy=readEvidence(evidence.deployConfigExecution);
if(deploy.schemaVersion!=='curveyield-lite-phase0-deploy-config-execution-v3'||deploy.executionMode!=='ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY')
 phase0Warning(evidence.deployConfigExecution,'PHASE0_DEPLOY_EVIDENCE_SCHEMA',
  'Deployment evidence schema or execution mode does not match the original source-package fork contract',
  {schemaVersion:'curveyield-lite-phase0-deploy-config-execution-v3',executionMode:'ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY'},
  {schemaVersion:deploy.schemaVersion??null,executionMode:deploy.executionMode??null});
if(deploy.campaignId!==receipt.campaign.campaignId||deploy.sourceSha256!==sourceSha)
 phase0Warning(evidence.deployConfigExecution,'PHASE0_DEPLOY_EVIDENCE_BINDING','Deployment evidence does not reference the exact Phase-0 campaign and source',{campaignId:receipt.campaign.campaignId,sourceSha256:sourceSha??null},{campaignId:deploy.campaignId??null,sourceSha256:deploy.sourceSha256??null});
if(deploy.fork?.engine!=='anvil')
 phase0Warning(evidence.deployConfigExecution,'PHASE0_DEPLOY_FORK_ENGINE',
  'Deployment evidence does not identify the Anvil fork execution engine',
  'anvil',deploy.fork?.engine??null);
try{assertDeployGateEvidenceV2(deploy);}
catch(error){phase0Warning(evidence.deployConfigExecution,'PHASE0_DEPLOY_EVIDENCE_ASSERTION',
 'Exact deployment-evidence assessment failed: '+String(error?.message??error),
 'Source-bound deployment evidence satisfying the issued assessment',String(error?.message??error));}
if(receipt.source?.inputMode==='LIVE_SCAN'){
  if(receipt.source.kind!=='EXPLORER_INITIALIZED_VERIFIED_LIVE_SNAPSHOT'||!Array.isArray(receipt.source.originUrls))
   phase0Warning(receiptPath,'SCAN_RECEIPT_PROVENANCE_MISSING',
    'Phase-0 receipt does not contain the required frozen explorer-scan provenance and URL list',
    {kind:'EXPLORER_INITIALIZED_VERIFIED_LIVE_SNAPSHOT',originUrls:'array'},
    {kind:receipt.source.kind??null,originUrls:receipt.source.originUrls??null});
  const manifestPath=path.resolve(controllerRoot,...String(receipt.source.scanManifestPath??'').split('/'));
  if(!manifestPath.startsWith(campaignRoot+path.sep))throw new Error('SCAN_MANIFEST_PATH_ESCAPES_CAMPAIGN');
  evidenceFile(manifestPath,'frozen LIVE_SCAN source manifest');
  if(digestFile(manifestPath)!==receipt.source.scanManifestSha256)
   phase0Warning(manifestPath,'PHASE0_SCAN_MANIFEST_SHA256','Frozen LIVE_SCAN source manifest bytes do not match recorded source receipt digest',receipt.source.scanManifestSha256??null,digestFile(manifestPath));
  const manifest=readEvidence(manifestPath);
  const {manifestDigestSha256,...unsigned}=manifest;
  const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
  if(manifest.schemaVersion!=='curveyield-scan-source-manifest-v1'||manifest.inputMode!=='LIVE_SCAN'||
     sha(canonical(unsigned))!==manifestDigestSha256||
     manifestDigestSha256!==receipt.source.scanTargetSetSha256)
    phase0Warning(manifestPath,'SCAN_TARGET_SET_IDENTITY_MISMATCH',
     'SCAN manifest canonical digest, schema, input mode, or receipt target-set binding differs',
     {schemaVersion:'curveyield-scan-source-manifest-v1',inputMode:'LIVE_SCAN',
      receiptTargetSetSha256:receipt.source.scanTargetSetSha256??null},
     {schemaVersion:manifest.schemaVersion??null,inputMode:manifest.inputMode??null,
      manifestDigestSha256:manifestDigestSha256??null,recomputedDigestSha256:sha(canonical(unsigned))});
  const requested=Array.isArray(manifest.requestedTargets)?manifest.requestedTargets:[],
      targets=Array.isArray(manifest.resolvedTargets)?manifest.resolvedTargets:[],
      units=Array.isArray(manifest.compilerUnits)?manifest.compilerUnits:[];
  if(!requested.length||!targets.length||targets.length>64||!units.length)
   phase0Warning(manifestPath,'SCAN_SOURCE_TARGETS_INCOMPLETE',
    'Frozen scan target and compiler-unit inventory does not contain the required target coverage',
    {requestedMin:1,resolvedMin:1,resolvedMax:64,compilerUnitsMin:1},
    {requested:requested.length,resolved:targets.length,compilerUnits:units.length});
  if(requested.length!==(receipt.source.originUrls?.length??0))
   phase0Warning(manifestPath,'SCAN_SOURCE_REQUEST_COUNT_MISMATCH',
    'Frozen scan manifest requested-target count differs from Phase-0 receipt origin URL count',
    receipt.source.originUrls?.length??0,requested.length);
  for(let i=0;i<requested.length;i++){
    try{
      const u=new URL(receipt.source.originUrls?.[i]??'https://invalid.example/');
      if(String(requested[i]??'').toLowerCase()!==u.pathname.split('/').pop()?.toLowerCase())githubPhase0Diagnostics.push('SCAN_REQUEST_URL_ADDRESS_MISMATCH');
    }catch(error){githubPhase0Diagnostics.push('SCAN_REQUEST_URL_ASSESSMENT_ERROR: '+String(error?.message??error));}
  }
  if(deploy.status!=='PASS_LIVE_DEPLOYMENT'||deploy.deploymentProfile?.mode!=='LIVE'||
     deploy.fork?.chainId!==manifest.chainId||deploy.fork?.initialBlock!==manifest.frozenBlock?.number||
     deploy.liveDeployment?.blockNumber!==manifest.frozenBlock?.number||
     String(deploy.liveDeployment?.blockHash??'').toLowerCase()!==String(manifest.frozenBlock?.hash??'').toLowerCase()||
     deploy.scanSourceSnapshot?.manifestDigestSha256!==manifestDigestSha256)
    githubPhase0Diagnostics.push('SCAN_FROZEN_LIVE_EVIDENCE_MISMATCH');
  const declared=Array.isArray(deploy.deploymentProfile?.contracts)?deploy.deploymentProfile.contracts:[],
        observed=Array.isArray(deploy.liveDeployment?.contracts)?deploy.liveDeployment.contracts:[];
  if(declared.length!==targets.length||observed.length!==targets.length)githubPhase0Diagnostics.push('SCAN_LIVE_TARGET_COVERAGE_INCOMPLETE');
  const compiled=Array.isArray(artifacts.artifacts)?artifacts.artifacts:[];
  for(let i=0;i<targets.length;i++){
    const t=targets[i],d=declared[i],live=observed[i];
    try{
    if(d?.address?.toLowerCase()!==t?.address||live?.address?.toLowerCase()!==t?.address||
       d?.qualifiedName!==t?.qualifiedName||live?.compilationUnitId!==t?.compilationUnitId||
       live?.runtimeSha256!==t?.runtimeSha256)
      githubPhase0Diagnostics.push('SCAN_TARGET_CODE_BINDING_MISMATCH: '+t.address);
    const artifact=compiled.find(a=>a.compilationUnitId===t.compilationUnitId&&a.qualifiedName===t.qualifiedName);
    if(!artifact)githubPhase0Diagnostics.push('SCAN_TARGET_ARTIFACT_BINDING_MISSING: '+t.address);
    if(live?.sourceBinding==='EXECUTABLE_RUNTIME_MATCH_METADATA_HASH_ONLY'){
      if(!artifact||live.runtimeComparison?.compiled?.toLowerCase()!==artifact.deployedBytecode?.toLowerCase()||
         compareLiveRuntimeV1(live.runtimeComparison?.observed,artifact.deployedBytecode,{allowScanMetadata:true}).sourceBinding!==live.sourceBinding)
        githubPhase0Diagnostics.push('SCAN_TARGET_COMPILED_RUNTIME_BINDING_MISMATCH: '+t.address);
    }else if(live?.sourceBinding!=='EXACT_COMPILED_RUNTIME')githubPhase0Diagnostics.push('SCAN_TARGET_CODE_BINDING_MISMATCH: '+t.address);
    if(!units.some(u=>u.unitId===t.compilationUnitId&&(u.targetBindings??[{address:u.address,qualifiedName:u.qualifiedName}]).some(binding=>binding.qualifiedName===t.qualifiedName&&binding.address===t.address)))
      githubPhase0Diagnostics.push('SCAN_TARGET_COMPILER_INPUT_BINDING_MISSING: '+t.address);
    if(t.proxyImplementation&&!targets.some(candidate=>candidate.address===t.proxyImplementation&&candidate.role==='IMPLEMENTATION'))
      githubPhase0Diagnostics.push('SCAN_PROXY_IMPLEMENTATION_COVERAGE_MISSING: '+t.address);
    }catch(error){githubPhase0Diagnostics.push('SCAN_TARGET_ASSESSMENT_ERROR: '+String(error?.message??error));}
  }
  for(const address of requested)if(!targets.some(t=>t.address===address&&t.role==='REQUESTED'))
    githubPhase0Diagnostics.push('SCAN_REQUESTED_TARGET_NOT_VERIFIED: '+address);
  evidence.scanSourceManifest=manifestPath;
}

if(deploy.reconciliation){
  const rawFile=evidenceFile(path.join(campaignRoot,'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json'),'immutable original fork deploy evidence');
  if(fs.existsSync(rawFile)&&digestV2(fs.readFileSync(rawFile))!==deploy.reconciliation.originalEvidenceSha256)
   phase0Warning(rawFile,'PHASE0_ORIGINAL_DEPLOY_BYTES','Immutable original fork deployment evidence bytes do not match the declared digest',deploy.reconciliation.originalEvidenceSha256??null,digestV2(fs.readFileSync(rawFile)));
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
  githubPhase0Diagnostics.push('PHASE0_OPTIONAL_FLOW_PLAN_UNAVAILABLE: '+String(error?.message??error).slice(0,2000));
  console.error('ADR Phase-0 optional flow plan unavailable: '+String(error?.message??error).slice(0,2000));
}

// v3 cannot promote an absent or incomplete source-review inventory to a
// completed discovery: Phase 4 has to be generated from real source contexts.
if(['machine-intelligence-v7','machine-intelligence-v8'].includes(receipt.authority?.liteRelease)){
  const reviewRoot=path.join(campaignRoot,'evidence/review-inventory');
  const inventory=readEvidence(evidenceFile(path.join(reviewRoot,'REVIEW_INVENTORY_v1.json'),'complete source review inventory'));
  const facts=readEvidence(evidenceFile(path.join(reviewRoot,'SYSTEM_FACTS_v1.json'),'system facts'));
  const plan=readEvidence(evidenceFile(path.join(reviewRoot,'FLOW_PLAN_v1.json'),'flow plan'));
  if(inventory?.payload?.complete!==true||!Array.isArray(inventory?.payload?.contexts)||!inventory.payload.contexts.length)
    githubPhase0Diagnostics.push('LITE_SOLO_INCOMPLETE_REVIEW_INVENTORY: no complete reviewable source-context inventory');
  if(!facts?.payload||!Array.isArray(plan?.payload?.reviewUnits)||!plan.payload.reviewUnits.length||
     !Array.isArray(plan?.payload?.attackUnits)||!plan.payload.attackUnits.length||
     (plan?.payload?.gaps??[]).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code)))
    githubPhase0Diagnostics.push('LITE_SOLO_INCOMPLETE_FLOW_PLAN: required correctness and attack units must be generated from complete inventory');
}

// Existing nonfatal verification diagnostics also receive an adjacent source
// warning; successful checks never create an artifact.
for(const message of githubPhase0Diagnostics){
 if(phase0RecordedDiagnostics.has(message))continue;
 const check=String(message).split(':')[0].trim();
 const reason=String(message);
 const file=/REVIEW_INVENTORY|inventory/i.test(reason)?
  path.join(campaignRoot,'evidence/review-inventory/REVIEW_INVENTORY_v1.json'):
  /FLOW_PLAN|flow plan/i.test(reason)?
  path.join(campaignRoot,'evidence/review-inventory/FLOW_PLAN_v1.json'):
  /SCAN_/i.test(reason)?
  (typeof receipt.source?.scanManifestPath==='string'&&receipt.source.scanManifestPath.startsWith(campaignPath+'/')?
   path.resolve(controllerRoot,...receipt.source.scanManifestPath.split('/')):receiptPath):
  /SOURCE_INTELLIGENCE/i.test(reason)?evidence.bundle:
  /build artifact|reusable build/i.test(reason)?evidence.executionBuildArtifacts:
  /deploy|fork/i.test(reason)?evidence.deployConfigExecution:receiptPath;
 phase0VerificationWarnings.add(recordPhaseFinalizationVerificationWarningV1({
  root:controllerRoot,campaignPath,phase:0,affectedFile:rel(controllerRoot,file),
  check:check||'PHASE0_FINALIZATION_VERIFICATION',reason,
  expected:'Required verification satisfied',observed:'FAILED: '+reason
 }));
}
const now=new Date().toISOString();
const refs=Object.entries(evidence).filter(([,file])=>fs.existsSync(file)&&fs.statSync(file).isFile())
 .map(([role,file])=>({role:role.startsWith('ADR_REVIEW_INVENTORY:')?'ADR_REVIEW_INVENTORY':role,
  path:rel(campaignRoot,file),sha256:digestFile(file)}));
const retired=/PHASE0_RANDOMIZED_SIMULATION|PHASE0_SIMULATION_RUN_INDEX|PHASE5_SIMULATION_BASELINE_INPUT|PHASE6_SIMULATION_BASELINE_INPUT|PHASE0_TELEMETRY_ANALYSIS|MEDUSA/;
receipt.evidence=refs.reduce((rows,row)=>upsert(rows,row),(receipt.evidence??[]).filter(row=>!retired.test(String(row.role??'')+' '+String(row.path??''))));
for(const warningPath of phase0VerificationWarnings){
 const file=path.resolve(controllerRoot,...warningPath.split('/'));
 receipt.evidence=upsert(receipt.evidence,{role:'FINALIZATION_VERIFICATION_WARNING',path:rel(campaignRoot,file),sha256:digestFile(file)});
}
receipt.outputs=(receipt.outputs??[]).filter(row=>!retired.test(String(row.role??'')+' '+String(row.path??'')));
// Missing physical output files remain missing. Never add a false receipt
// evidence reference or an empty digest merely to bypass a verification.
for(const [role,file] of [
 ['PHASE0_AUDIT_SURFACE',evidence.auditSurface],
 ['PRECOMPUTED_DEPLOY_CONFIG_EVIDENCE',evidence.deployConfigMatrix],
 ['PHASE0_FORK_DEPLOY_CONFIG',evidence.deployConfigExecution],
 ['PRECOMPUTED_TARGETED_TEST_EVIDENCE',evidence.targetedTestMatrix]
]){
 if(fs.existsSync(file)&&fs.statSync(file).isFile())
  receipt.outputs=upsert(receipt.outputs,{role,path:rel(campaignRoot,file),sha256:digestFile(file)});
}
receipt.globalControls={
  securityTraceabilityGraph:'controller/SECURITY_TRACEABILITY_GRAPH_v1.json',
  carriedForwardObligationLedger:'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json',
  evidenceInvalidationMatrix:'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json',
  sourceIntelligenceBundle:'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'
};
const ledger=readEvidence(evidence.ledger);
receipt.obligations.due=(ledger.obligations??[]).filter(x=>String(x.status??'OPEN').toUpperCase()==='OPEN'&&String(x.requiredPhase??'')==='1');
// Retired infrastructure qualification is not evidence for a new Phase-0 run.
receipt.automation=(receipt.automation??[]).filter(row=>row?.workflow!=='v7-execution-infrastructure-qualification.yml');
receipt.automation=upsert(receipt.automation,{workflow:'lite-solo-phase0-bootstrap-v1.yml',runId:Number(a['workflow-run-id']),status:'PASS',contractAutomationCommit:a['contract-automation-sha'],bootstrapCommit:a['bootstrap-sha']??a['contract-automation-sha']},'workflow');
receipt.validation={status:'PASS',validatedAt:now,failures:[],validationDelegatedTo:'CLOUDFLARE_WORKER',githubContentValidationPerformed:false,githubDiagnostics:githubPhase0Diagnostics,warningPaths:[...phase0VerificationWarnings],evidenceLimitationsPresent:phase0VerificationWarnings.size>0};
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
if(!((authorityRoot==='Machine Intelligence Audit Controller/Audit Skill v7'&&receipt.authority.liteRelease==='machine-intelligence-v7')||(authorityRoot==='Machine Intelligence Audit Controller/Audit Skill v8'&&receipt.authority.liteRelease==='machine-intelligence-v8')))
 throw new Error('Machine Intelligence authority identity mismatch');
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
  agentModel:'PARALLEL_WORKER_UNITS',
  executionModel:'PARALLEL_WORKER_UNITS',
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
