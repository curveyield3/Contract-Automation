#!/usr/bin/env node
// Lite-Solo Audit Correction v1: isolated controller-admitted corrective lineage.
// Reuses the existing Lite-Solo v4 phase/unit controllers; never executes tests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {readJson,writeJson,repoFile,requiredFile,preparePhaseWork,validateBoundAuthorityV1} from '../lib/lite-solo-phase-work-v1.mjs';
import {createUnitPlanV1} from '../lib/lite-solo-unit-queue-v1.mjs';
import {renderRemediationDeltaLedgerV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';

const root=path.resolve(process.env.AUDIT_CONTROLLER_ROOT??'.audit-controller');
const input=process.argv[2];
if(!input||!fs.existsSync(input))throw Error('LSC_REQUEST_FILE_REQUIRED');
const request=JSON.parse(fs.readFileSync(input,'utf8'));
const valid=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9.-]*$/.test(s)&&!s.includes('..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const digest=p=>sha(fs.readFileSync(repoFile(root,p)));
const toFile=p=>repoFile(root,p);
const load=p=>readJson(requiredFile(root,p,p));
const save=(p,x)=>writeJson(toFile(p),x);
const when=new Date().toISOString();
const suffix=id=>/^(.*)-r([1-9][0-9]*)$/.exec(id??'');
if(request.schemaVersion!=='curveyield-lite-solo-audit-correction-request-v1'||
 !['PREPARE','LAUNCH'].includes(request.operation)||!valid(request.requestId)||
 !valid(request.sourceCampaignId)||!valid(request.correctionKey)||
 ![4,5,6,8,9,10].includes(request.startPhase))
 throw Error('LSC_INVALID_REQUEST');
const sourceParts=suffix(request.sourceCampaignId);
if(!sourceParts)throw Error('LSC_SOURCE_CAMPAIGN_ID_INVALID');
const sourceSlug=sourceParts[1];
const originalRel='Audit Campaign Directory/campaigns/'+sourceSlug+'.json';
const original=load(originalRel);
const sourcePath=original.workspacePath;
const sourceAnchorRel=original.lastSealedReceiptPath;
if(original.schemaVersion!=='curveyield-audit-campaign-directory-entry-v2'||
 original.campaignId!==request.sourceCampaignId||original.mode!=='LITE_SOLO'||
 original.authorityRelease!=='lite-solo-v4'||
 !['COMPLETE','ACTIVE'].includes(original.campaignStatus)||
 (original.campaignStatus==='COMPLETE'&&original.currentAssignment!==null)||
 (original.campaignStatus==='ACTIVE'&&!original.currentAssignment)||
 typeof sourcePath!=='string'||!sourcePath.startsWith('campaigns/')||
 sourcePath.split('/').includes('..')||
 !/^campaigns\/[a-z0-9A-Z._ -]+\/receipts\/PHASE_[0-9]{2}_RECEIPT_v[1-9][0-9]*\.json$/.test(String(sourceAnchorRel??''))||
 !sourceAnchorRel.startsWith(sourcePath+'/'))
 throw Error('LSC_ADMITTED_LITE_SOLO_V4_SOURCE_REQUIRED');
const sourceAnchor=load(sourceAnchorRel);
if(sourceAnchor.campaign?.campaignGenerationId!==original.campaignGenerationId||
 sourceAnchor.source?.sha256!==original.sourceSha256||
 sourceAnchor.authority?.manifestSha256!==original.authorityDigest||
 (sourceAnchor.validation?.status!=='PASS'&&!(sourceAnchor.phase?.status==='SKIPPED'&&sourceAnchor.validation?.status==='NOT_APPLICABLE'))||
 (original.campaignStatus==='COMPLETE'&&(sourceAnchor.phase?.sequence!==10||sourceAnchor.phase?.status!=='COMPLETE'))||
 (original.campaignStatus==='ACTIVE'&&(sourceAnchor.phase?.status!=='SEALED'&&sourceAnchor.phase?.status!=='SKIPPED')))
 throw Error('LSC_SOURCE_ANCHOR_NOT_ACCEPTED');
if(original.campaignStatus==='ACTIVE'&&original.unitQueueStatePath){
 const state=load(original.unitQueueStatePath);
 if(Object.values(state.units??{}).some(x=>['CLAIMED','SUBMITTED'].includes(x?.status)))
  throw Error('LSC_SOURCE_HAS_INFLIGHT_UNIT_CLAIMS');
}
const source0=load(sourcePath+'/receipts/PHASE_00_RECEIPT_v1.json');
const authRoot=validateBoundAuthorityV1({root,receipt:source0});
if(authRoot!=='Audit Skill - Lite-Solo Authority/lite-solo-v4'||
 source0.source?.sha256!==original.sourceSha256||
 source0.authority?.manifestSha256!==original.authorityDigest||
 sourceAnchor.authority?.manifestSha256!==original.authorityDigest||
 source0.campaign?.campaignGenerationId!==original.campaignGenerationId)
 throw Error('LSC_SOURCE_OR_AUTHORITY_BINDING_INVALID');
const predecessor=request.startPhase-1;
if(sourceAnchor.phase?.sequence<predecessor)throw Error('LSC_SOURCE_NOT_SEALED_THROUGH_PREDECESSOR');
const availableReceipts=fs.readdirSync(toFile(sourcePath+'/receipts'));
const receiptInfo=phase=>{
 const prefix='PHASE_'+String(phase).padStart(2,'0')+'_RECEIPT_v';
 const matched=availableReceipts.map(name=>({name,match:name.match(new RegExp('^'+prefix+'([1-9][0-9]*)\\.json$'))}))
  .filter(x=>x.match).sort((x,y)=>Number(y.match[1])-Number(x.match[1]));
 if(!matched.length)throw Error('LSC_MISSING_SOURCE_SEAL_'+phase);
 const selected=matched[0];
 return {phase,revision:Number(selected.match[1]),path:sourcePath+'/receipts/'+selected.name};
};
const receiptRel=phase=>receiptInfo(phase).path;
const accepted=[];
for(let phase=0;phase<=predecessor;phase++){
 const selected=receiptInfo(phase),rel=selected.path,data=load(rel);
 if(data.phase?.sequence!==phase||
   !['SEALED','SKIPPED'].includes(data.phase?.status)||
   (data.validation?.status!=='PASS'&&!(phase===9&&data.phase?.status==='SKIPPED'))||
   data.source?.sha256!==original.sourceSha256||
   data.campaign?.campaignGenerationId!==original.campaignGenerationId||
   data.authority?.manifestSha256!==original.authorityDigest||
   data.phase?.revision!==selected.revision)
   throw Error('LSC_INVALID_ACCEPTED_PREDECESSOR_PHASE_'+phase);
 accepted.push({...selected,sha256:digest(rel)});
}
const newSlug='lite-solo-correction-'+sourceSlug+'-'+request.correctionKey;
const newId=newSlug+'-r1';
const dest='campaigns/'+newId;
const entryRel='Audit Campaign Directory/campaigns/'+newSlug+'.json';
const stageRel=dest+'/controller/LITE_SOLO_CORRECTION_STAGE_v1.json';
const scopeRel=dest+'/controller/LITE_SOLO_CORRECTION_SCOPE_v1.json';
const originalBinding={campaignId:original.campaignId,campaignGenerationId:original.campaignGenerationId,
 workspacePath:sourcePath,sourceSha256:original.sourceSha256,authorityDigest:original.authorityDigest,
 sourceCampaignStatus:original.campaignStatus,
 sourceDirectoryUpdatedAt:original.updatedAt,
 sourceAnchorReceiptPath:sourceAnchorRel,sourceAnchorReceiptSha256:digest(sourceAnchorRel),
 acceptedPredecessors:accepted};
const stable=JSON.stringify(originalBinding);
const sameSource=(stage)=>{
 if(JSON.stringify(stage.originalBinding)!==stable)throw Error('LSC_SOURCE_BINDING_DRIFT');
 if(digest(sourceAnchorRel)!==stage.originalBinding.sourceAnchorReceiptSha256)throw Error('LSC_SOURCE_ANCHOR_CHANGED');
 for(const p of stage.originalBinding.acceptedPredecessors)
   if(digest(p.path)!==p.sha256)throw Error('LSC_PREDECESSOR_CHANGED_'+p.phase);
};
const inspectUnchanged=(a,b)=>{
 if(!fs.existsSync(a)||!fs.existsSync(b))throw Error('LSC_MISSING_IMPORTED_EVIDENCE');
 const left=fs.statSync(a),right=fs.statSync(b);
 if(left.isDirectory()!==right.isDirectory())throw Error('LSC_IMPORTED_EVIDENCE_TYPE_DRIFT');
 if(left.isDirectory()){
  const aa=fs.readdirSync(a).sort(),bb=fs.readdirSync(b).sort();
  if(JSON.stringify(aa)!==JSON.stringify(bb))throw Error('LSC_IMPORTED_EVIDENCE_TREE_DRIFT');
  for(const name of aa)inspectUnchanged(path.join(a,name),path.join(b,name));
 }else if(sha(fs.readFileSync(a))!==sha(fs.readFileSync(b)))
  throw Error('LSC_IMPORTED_EVIDENCE_BYTES_CHANGED');
};
const stageCampaign=()=>{
 if(fs.existsSync(toFile(dest))||fs.existsSync(toFile(entryRel))){
  if(!fs.existsSync(toFile(dest))||!fs.existsSync(toFile(entryRel)))
   throw Error('LSC_PARTIAL_STAGE');
  const existing=load(stageRel),dir=load(entryRel);
  sameSource(existing);
  if(existing.startPhase!==request.startPhase||dir.campaignId!==newId)
   throw Error('LSC_EXISTING_STAGE_CONFLICT');
  console.log(JSON.stringify({status:dir.campaignStatus,campaignId:newId,replayed:true}));
  return;
 }
 fs.cpSync(toFile(sourcePath),toFile(dest),{recursive:true,errorOnExist:true,force:false});
 const generation=newId+'-g1-'+when.replace(/[-:.]/g,'');
 const dir={schemaVersion:'curveyield-audit-campaign-directory-entry-v2',
  campaignId:newId,campaignGenerationId:generation,campaignName:'Lite-Solo Audit Correction — '+original.campaignName,
  workspacePath:dest,mode:'LITE_SOLO',deliveryTransport:'DIRECT',agent:{actorId:'lite-solo-agent'},
  agentModel:'PARALLEL_WORKER_UNITS',executionModel:'PARALLEL_WORKER_UNITS',
  authorityRelease:'lite-solo-v4',authorityDigest:original.authorityDigest,
  sourceSha256:original.sourceSha256,campaignStatus:'STAGED_PRELAUNCH',currentAssignment:null,
  lastSealedReceiptPath:null,unitPhaseEpoch:1,transportEpoch:0,updatedAt:when,
  correctionOf:{...originalBinding,priorSealsImmutable:true,entryPoint:'LITE_SOLO_AUDIT_CORRECTION_V1'}};
 const stage={schemaVersion:'curveyield-lite-solo-audit-correction-stage-v1',
  campaignId:newId,generationId:generation,originalBinding,
  startPhase:request.startPhase,correctionKey:request.correctionKey,
  status:'AWAITING_SCOPE_REVIEW_AND_LAUNCH',preparedAt:when};
 save(entryRel,dir);save(stageRel,stage);
 save(scopeRel,{schemaVersion:'curveyield-lite-solo-audit-correction-scope-v1',
  campaignId:newId,startPhase:request.startPhase,
  reason:request.reason??'CORRECT_ACCEPTED_SECURITY_ASSURANCE',
  obligationIds:request.obligationIds??[],candidateIds:request.candidateIds??[],
  instruction:'Specify only original source-bound obligation/candidate identifiers. Phase work follows bound Lite-Solo v4 and controller validation.'});
 console.log(JSON.stringify({status:'STAGED_PRELAUNCH',campaignId:newId,scopePath:scopeRel,startPhase:request.startPhase}));
};
const rebind=v=>{
 if(typeof v==='string')return v.replaceAll(sourcePath,dest).replaceAll(original.campaignId,newId);
 if(Array.isArray(v))return v.map(rebind);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rebind(x)]));
 return v;
};
const allFiles=(folder,rx)=>fs.existsSync(toFile(folder))?
 fs.readdirSync(toFile(folder)).filter(rx):[];

const validIds=rows=>Array.isArray(rows)&&rows.every(x=>typeof x==='string'&&/^[A-Za-z0-9._-]+$/.test(x))
 &&new Set(rows).size===rows.length;
const acceptedCandidateKeys=()=>{
 const found=new Map();
 const keys=['candidateRecords','newCandidateRecords','candidateProofRecords','candidateValidations','validatedFindings'];
 for(const phase of [4,5,6,8]){
  const rel=sourcePath+'/derived/phase-'+phase+'/PHASE_'+String(phase).padStart(2,'0')+'_CANONICAL_DATA_v1.json';
  if(!fs.existsSync(toFile(rel)))continue;
  const canonical=load(rel);
  for(const action of Object.values(canonical.actions??{})){
   for(const [name,rows] of Object.entries(action.outputs??{})){
    if(!keys.includes(name)||!Array.isArray(rows))continue;
    for(const row of rows){
     if(!row||typeof row!=='object')continue;
     for(const id of [row.tempKey,row.candidateKey,row.canonicalId,row.findingTempKey]){
      if(typeof id==='string'&&id&&!found.has(id))found.set(id,phase);
     }
    }
   }
  }
 }
 return found;
};
const scopeCheck=(scope,start)=>{
 if(!validIds(scope.obligationIds)||!validIds(scope.candidateIds))
  throw Error('LSC_SCOPE_IDENTITY_LIST_INVALID');
 if(typeof scope.reason!=='string'||!scope.reason.trim())throw Error('LSC_SCOPE_REASON_REQUIRED');
 if(scope.candidateIds.length&&start>8)throw Error('LSC_CANDIDATE_REVISION_REQUIRES_PHASE8_OR_EARLIER');
 const candidates=acceptedCandidateKeys();
 for(const id of scope.candidateIds)
  if(!candidates.has(id))throw Error('LSC_UNKNOWN_ACCEPTED_CANDIDATE_'+id);
 const ledger=load(sourcePath+'/controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json');
 for(const id of scope.obligationIds){
  const row=(ledger.obligations??[]).find(x=>x.obligationId===id);
  if(!row)throw Error('LSC_UNKNOWN_ACCEPTED_OBLIGATION_'+id);
  if(Number(row.requiredPhase)<start)
   throw Error('LSC_START_AFTER_OBLIGATION_DUE_PHASE_'+id);
 }
 for(const row of ledger.obligations??[]){
  if(row.mandatory===true&&['OPEN','IN_PROGRESS','BLOCKED_CARRIED'].includes(row.status)&&
   Number(row.requiredPhase)<start)
   throw Error('LSC_PREDECESSOR_HAS_OVERDUE_MANDATORY_OBLIGATION_'+row.obligationId);
 }
 if(start===9){
  const p8=load(sourcePath+'/derived/phase-8/PHASE_08_CANONICAL_DATA_v1.json');
  const findings=p8.actions?.['step-2']?.outputs?.validatedFindings??[];
  if(!findings.some(x=>x&&typeof x==='object')||
     !fs.existsSync(toFile(sourcePath+'/remediation'))||
     !fs.readdirSync(toFile(sourcePath+'/remediation')).length)
   throw Error('LSC_PHASE9_REQUIRES_ACCEPTED_FINDINGS_AND_REMEDIATION');
 }
 if(start===6){
  const p5=load(sourcePath+'/derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json');
  const designs=p5.actions?.['step-3']?.outputs?.targetDesigns??[];
  if(designs.some(x=>x&&typeof x==='object'&&x.executionMethod!=='NOT_APPLICABLE'))
   throw Error('LSC_PHASE6_EXECUTION_REBIND_UNSUPPORTED_START_AT_PHASE5');
 }
 return {candidateCount:candidates.size};
};
const restoreControls=(start,scope,dir)=>{
 const names=['CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json','SECURITY_TRACEABILITY_GRAPH_v1.json',
  'EVIDENCE_INVALIDATION_MATRIX_v1.json','DOMAIN_APPLICABILITY_REGISTRY_v1.json'];
 for(const name of names){
  const rel=dest+'/controller/'+name;
  if(!fs.existsSync(toFile(rel)))continue;
  const control=rebind(load(rel));
  if(control.campaignBinding){
   control.campaignBinding.campaignId=newId;
   control.campaignBinding.campaignGenerationId=dir.campaignGenerationId;
  }
  if(Array.isArray(control.controllerImports))
   control.controllerImports=control.controllerImports.filter(x=>Number(x.phase)<start);
  if(Array.isArray(control.phaseCheckpoints))
   control.phaseCheckpoints=control.phaseCheckpoints.filter(x=>
    Number(String(x.phaseId??'').replace('phase-',''))<start);
  if(name.startsWith('CARRIED_')){
   const requested=new Set(scope.obligationIds);
   control.obligations=(control.obligations??[]).filter(x=>Number(x.originPhase)<start);
   for(const row of control.obligations){
    const closureAfter=(row.closureEvidenceRefs??[]).some(p=>{
     const m=String(p).match(/(?:phase-|PHASE_)(0?[0-9]{1,2})/i);
     return m&&Number(m[1])>=start;
    });
    if(requested.has(row.obligationId)||Number(row.requiredPhase)>=start||closureAfter){
     row.status='OPEN';row.statusReason=null;row.closureEvidenceRefs=[];
     row.updatedAt=when;
    }
   }
  }
  if(name.startsWith('SECURITY_TRACEABILITY_')){
   control.nodes=(control.nodes??[]).filter(n=>n.originPhase==null||Number(n.originPhase)<start);
   const keep=new Set(control.nodes.map(n=>n.nodeId));
   control.edges=(control.edges??[]).filter(e=>keep.has(e.from??e.source??e.sourceNodeId)
    &&keep.has(e.to??e.target??e.targetNodeId));
  }
  // The accepted source remains immutable; later proof observations must be
  // ingested afresh into the new campaign, never copied as controller PASS.
  save(rel,control);
 }
 for(const n of ['phase8-revalidation','phase5-candidate-evidence','phase6-tests','phase9-reruns',
  'phase5-tests','results','preflight']){
  fs.rmSync(toFile(dest+'/controller/'+n),{recursive:true,force:true});
 }
};
const relatedInputs=(phase)=>{
 const base=dest+'/derived/';
 const exact={
  4:['phase-2/PHASE3_INPUT_v1.json','phase-3/PHASE4_INPUT_v1.json'],
  5:['phase-2/PHASE3_INPUT_v1.json','phase-3/PHASE4_INPUT_v1.json','phase-4/PHASE5_INPUT_v1.json'],
  6:['phase-2/PHASE3_INPUT_v1.json','phase-3/PHASE4_INPUT_v1.json','phase-4/PHASE5_INPUT_v1.json','phase-5/PHASE6_INPUT_v1.json'],
  8:['phase-2/PHASE3_INPUT_v1.json','phase-3/PHASE4_INPUT_v1.json','phase-4/PHASE5_INPUT_v1.json','phase-5/PHASE6_INPUT_v1.json','phase-6/PHASE8_INPUT_v1.json','phase-7/PHASE8_MARKER_INPUT_v1.json'],
  9:['phase-8/PHASE9_REMEDIATION_INPUT_v1.json'],
  10:['phase-8/PHASE10_INPUT_v1.json','phase-9/PHASE10_REMEDIATION_INPUT_v1.json']
 };
 const other={
  6:['evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json','work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md','work/phase-06/LITE_TARGETED_TEST_MATRIX.md'],
  8:['evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json','work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md','work/phase-06/LITE_TARGETED_TEST_MATRIX.md'],
  9:['work/phase-09/PHASE9_REMEDIATION_DELTA_LEDGER.md'],
  10:['work/phase-10/LITE_FINAL_EVIDENCE_INDEX.md']
 };
 return [...(exact[phase]??[]).map(x=>base+x),...(other[phase]??[]).map(x=>dest+'/'+x)]
  .filter(x=>fs.existsSync(toFile(x)));
};
const phase9DeltaRows=()=>{
 const canonical=load(dest+'/derived/phase-8/PHASE_08_CANONICAL_DATA_v1.json');
 const findings=(canonical.actions?.['step-2']?.outputs?.validatedFindings??[])
  .filter(x=>x&&typeof x==='object');
 const files=[];
 const walk=(dir,relative='')=>{
  if(!fs.existsSync(dir))return;
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
   const name=relative?relative+'/'+e.name:e.name;
   if(e.isDirectory())walk(path.join(dir,e.name),name);
   else if(e.isFile())files.push(name);
  }
 };
 walk(toFile(dest+'/remediation'));
 const changed=new Set(),symbols=new Set();
 for(const name of files){
  const ext=path.extname(name).toLowerCase();
  if(!['.patch','.diff'].includes(ext)){changed.add(name);continue;}
  for(const line of fs.readFileSync(toFile(dest+'/remediation/'+name),'utf8').split(/\r?\n/)){
   const match=line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
   if(match&&match[1]!=='/dev/null')changed.add(match[1]);
   if(/^[+-](?![+-])/.test(line)){
    const symbol=line.match(/\b(?:function|contract|library|interface|struct|modifier|event|error)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if(symbol)symbols.add(symbol[1]);
   }
  }
 }
 return findings.map(f=>({
  findingId:f.findingTempKey??f.canonicalId??f.candidateKey,
  oldIdentityRef:'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json',
  remediationIdentityRef:files.map(f=>'remediation/'+f).join(', ')||'NO_REMEDIATION_ARTIFACT',
  changedFilesAndSymbols:'files='+([...changed].join(', ')||'UNRESOLVED')+
   '; symbols='+([...symbols].join(', ')||'NOT_MACHINE_DERIVABLE_FROM_AVAILABLE_REMEDIATION_ARTIFACTS'),
  rootCauseFix:'PENDING_PHASE9_INTERPRETATION',
  staleEvidenceInvalidated:'SEE_CONTROLLER_EVIDENCE_INVALIDATION_STATE',
  decisiveProofRerun:'PENDING_PHASE9',
  affectedSurfaces:[...changed].join(', ')||'UNRESOLVED',
  newEvidenceRefs:files.map(f=>'remediation/'+f).join(', ')||'NONE',
  residualRisk:'PENDING_PHASE9_INTERPRETATION',
  finalDisposition:'PENDING_PHASE9_INTERPRETATION'
 }));
};
const launch=()=>{
 const stage=load(stageRel),dir=load(entryRel),scope=load(scopeRel);
 if(stage.status==='LAUNCHED'&&dir.campaignStatus==='ACTIVE'){
  console.log(JSON.stringify({status:'ALREADY_LAUNCHED',campaignId:newId,phase:dir.currentAssignment?.phaseSequence}));
  return;
 }
 sameSource(stage);
 if(dir.campaignStatus!=='STAGED_PRELAUNCH'||stage.status!=='AWAITING_SCOPE_REVIEW_AND_LAUNCH'||
    stage.campaignId!==newId||stage.generationId!==dir.campaignGenerationId||
    stage.startPhase!==request.startPhase||stage.correctionKey!==request.correctionKey||
    scope.campaignId!==newId||scope.startPhase!==request.startPhase)
  throw Error('LSC_PRELAUNCH_SCOPE_OR_IDENTITY_INVALID');
 scopeCheck(scope,request.startPhase);
 for(const folder of ['source','evidence'])
  inspectUnchanged(toFile(sourcePath+'/'+folder),toFile(dest+'/'+folder));
 const cached=new Map();
 const retain=rel=>{if(fs.existsSync(toFile(dest+'/'+rel)))cached.set(rel,fs.readFileSync(toFile(dest+'/'+rel)));};
 if(request.startPhase===6){
  retain('work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md');
  retain('work/phase-06/LITE_TARGETED_TEST_MATRIX.md');
 }
 if(request.startPhase===10){
  retain('work/phase-10/LITE_FINAL_EVIDENCE_INDEX.md');
  retain('work/phase-10/COVERAGE_MATRIX_v1.json');
 }
 // Eliminate all original-generation receipts in the fork, including older
 // revision siblings. Adopt only controller-verified latest predecessors below.
 fs.rmSync(toFile(dest+'/receipts'),{recursive:true,force:true});
 fs.mkdirSync(toFile(dest+'/receipts'),{recursive:true});
 for(const top of ['work','derived']){
  for(const n of allFiles(dest+'/'+top,n=>/^phase-0?[0-9]+$/.test(n)))
   if(Number(n.slice(6))>=request.startPhase)
    fs.rmSync(toFile(dest+'/'+top+'/'+n),{recursive:true,force:true});
 }
 for(const [rel,bytes] of cached){
  fs.mkdirSync(path.dirname(toFile(dest+'/'+rel)),{recursive:true});
  fs.writeFileSync(toFile(dest+'/'+rel),bytes);
 }
 // All former published reports are historical; the new report is produced
 // only after this correction's actual Phase-10 acceptance.
 const policyBytes=fs.readFileSync(toFile(dest+'/reports/REPORT_PUBLICATION_POLICY_v1.json'));
 fs.rmSync(toFile(dest+'/reports'),{recursive:true,force:true});
 fs.mkdirSync(toFile(dest+'/reports'),{recursive:true});
 fs.writeFileSync(toFile(dest+'/reports/REPORT_PUBLICATION_POLICY_v1.json'),policyBytes);
 if(request.startPhase<=8)fs.rmSync(toFile(dest+'/remediation'),{recursive:true,force:true});
 if(request.startPhase<=5)fs.rmSync(toFile(dest+'/evidence/phase5-boundary'),{recursive:true,force:true});
 for(const name of allFiles(dest+'/submissions',()=>true))
  if(/^PHASE_([0-9]{2})_/.test(name)&&Number(name.slice(6,8))>=request.startPhase)
   fs.rmSync(toFile(dest+'/submissions/'+name),{recursive:true,force:true});
 // Rebase accepted, latest-version predecessors into distinct version-1
 // adoption receipts with immutable original digest and revision provenance.
 for(const item of accepted){
  const rel=dest+'/receipts/PHASE_'+String(item.phase).padStart(2,'0')+'_RECEIPT_v1.json';
  const originalReceipt=load(item.path),copy=rebind(originalReceipt);
  copy.campaign={...copy.campaign,campaignId:newId,campaignGenerationId:dir.campaignGenerationId,
   campaignName:dir.campaignName,workspacePath:dest,campaignDirectoryEntryPath:entryRel,mode:'LITE_SOLO'};
  copy.phase={...copy.phase,revision:1};
  copy.importedFrom={kind:'SOURCE_BOUND_CONTROLLER_ACCEPTED_PREDECESSOR',
   sourceCampaignId:original.campaignId,sourceGenerationId:original.campaignGenerationId,
   sourceReceiptPath:item.path,sourceReceiptSha256:item.sha256,
   sourceReceiptRevision:item.revision,sourceValidation:originalReceipt.validation,
   sourceAuthority:originalReceipt.authority,notNewExecutionEvidence:true};
  copy.validation={...copy.validation,adoption:'HISTORICAL_CONTROLLER_ACCEPTANCE_ONLY'};
  // Repoint fork-local prior receipt references to the new admission
  // receipts; original revision references remain in importedFrom.
  for(const group of ['inputs','evidence','outputs','automation']){
   for(const ref of copy[group]??[]){
    if(typeof ref?.path!=='string')continue;
    const found=ref.path.match(/receipts\/PHASE_(\d{2})_RECEIPT_v[1-9][0-9]*\.json$/);
    if(!found||Number(found[1])>=request.startPhase)continue;
    ref.path=dest+'/receipts/PHASE_'+found[1]+'_RECEIPT_v1.json';
    delete ref.sha256;
   }
  }
  save(rel,copy);
 }
 for(const n of allFiles(dest+'/derived',n=>/^phase-\d+$/.test(n)&&Number(n.slice(6))<request.startPhase)){
  const folder=dest+'/derived/'+n;
  for(const file of allFiles(folder,n=>n.endsWith('.json'))){
   const rel=folder+'/'+file,prior=fs.readFileSync(toFile(rel));
   const rewritten=rebind(JSON.parse(prior));
   rewritten.correctionImport={sourceCampaignId:original.campaignId,originalSha256:sha(prior),
    originalArtifactPath:sourcePath+'/derived/'+n+'/'+file};
   save(rel,rewritten);
  }
 }
 restoreControls(request.startPhase,scope,dir);
 // New policy is computed before imported Phase-0 receipts are finalized.
 const policyRel=dest+'/reports/REPORT_PUBLICATION_POLICY_v1.json';
 const policy=rebind(load(policyRel));
 policy.campaignId=newId;policy.campaignGenerationId=dir.campaignGenerationId;
 const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
 const policyData=JSON.stringify(canonical(policy));
 fs.writeFileSync(toFile(policyRel),policyData);
 dir.publicationPolicyPath=policyRel;dir.publicationPolicySha256=sha(Buffer.from(policyData));
 if(request.startPhase===10&&cached.has('work/phase-10/COVERAGE_MATRIX_v1.json')){
  const matrixRel=dest+'/work/phase-10/COVERAGE_MATRIX_v1.json';
  const matrix=load(matrixRel);
  matrix.correctionHistoricalSource={
   sourceCampaignId:original.campaignId,sourceReceiptPath:sourceAnchorRel,
   sourceReceiptSha256:digest(sourceAnchorRel),
   disclaimer:'Earlier post-seal proof is historical. No newly accepted correction-campaign machine proof is implied.'};
  delete matrix.postSealAcceptedEvidence;
  save(matrixRel,matrix);
 }
 for(const item of accepted){
  const rel=dest+'/receipts/PHASE_'+String(item.phase).padStart(2,'0')+'_RECEIPT_v1.json';
  const receipt=load(rel);
  if(item.phase===0){
   receipt.publicationPolicyPath=policyRel;
   receipt.publicationPolicySha256=dir.publicationPolicySha256;
   for(const ref of receipt.automation??[])
    if(ref.role==='REPORT_PUBLICATION_POLICY'){
     ref.path=policyRel;ref.sha256=dir.publicationPolicySha256;
    }
  }
  for(const group of ['inputs','evidence','outputs','automation']){
   for(const ref of receipt[group]??[]){
    if(typeof ref?.path!=='string')continue;
    const candidate=ref.path.startsWith(dest+'/')?ref.path:dest+'/'+ref.path;
    if(fs.existsSync(toFile(candidate))&&fs.statSync(toFile(candidate)).isFile())
     ref.sha256=digest(candidate);
   }
  }
  save(rel,receipt);
 }
 const previous=dest+'/receipts/PHASE_'+String(predecessor).padStart(2,'0')+'_RECEIPT_v1.json';
 // Only adopt Phase-5 source proof if there are no executable candidate
 // targets; otherwise the corrected campaign must rerun Phase 5 under its own ID.
 let prefillContext={};
 if(request.startPhase===6){
  const p5=load(dest+'/derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json');
  prefillContext={targetDesigns:p5.actions?.['step-3']?.outputs?.targetDesigns??[],
   phase5ExecutionResults:{}};
 }
 if(request.startPhase===9){
  const rows=phase9DeltaRows();
  prefillContext={remediationDeltaRows:rows};
  const ledgerRel=dest+'/work/phase-09/PHASE9_REMEDIATION_DELTA_LEDGER.md';
  fs.mkdirSync(path.dirname(toFile(ledgerRel)),{recursive:true});
  const p8=load(dest+'/derived/phase-8/PHASE_08_CANONICAL_DATA_v1.json');
  fs.writeFileSync(toFile(ledgerRel),renderRemediationDeltaLedgerV1({
   validatedFindings:p8.actions?.['step-2']?.outputs?.validatedFindings??[],
   deltaRows:rows,noRemediation:false}));
 }
 const assignment=preparePhaseWork({root,campaignPath:dest,authorityRoot:authRoot,
  sequence:request.startPhase,reviewer:'lite-solo-agent',
  predecessorReceiptPath:previous,derivedInputPaths:relatedInputs(request.startPhase),
  status:'ACTIVE',prefillContext});
 dir.currentAssignment=assignment;dir.lastSealedReceiptPath=previous;
 dir.campaignStatus='ACTIVE';dir.updatedAt=when;dir.unitPhaseEpoch=1;
 if(request.startPhase<=6)createUnitPlanV1({root,campaignPath:dest,
  directory:dir,phase:request.startPhase,automationRoot:process.cwd()});
 stage.status='LAUNCHED';stage.launchedAt=when;stage.scopeSha256=digest(scopeRel);
 stage.firstAssignmentPhase=request.startPhase;
 save(stageRel,stage);save(entryRel,dir);
 console.log(JSON.stringify({status:'ACTIVE',campaignId:newId,
  phase:request.startPhase,unitQueueIndexPath:dir.currentAssignment?.unitQueueIndexPath??null}));
};
if(request.operation==='PREPARE')stageCampaign();
else{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lite-solo-correction-'));
 try{
  fs.cpSync(toFile(dest),path.join(tmp,'campaign'),{recursive:true});
  fs.copyFileSync(toFile(entryRel),path.join(tmp,'directory.json'));
  try{launch();}
  catch(error){
   fs.rmSync(toFile(dest),{recursive:true,force:true});
   fs.cpSync(path.join(tmp,'campaign'),toFile(dest),{recursive:true});
   fs.copyFileSync(path.join(tmp,'directory.json'),toFile(entryRel));
   throw error;
  }
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
