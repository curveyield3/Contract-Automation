#!/usr/bin/env node
// Lite-Solo Audit Correction v1: isolated controller-admitted corrective lineage.
// Reuses the existing Lite-Solo v4 phase/unit controllers; never executes tests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {readJson,writeJson,repoFile,requiredFile,preparePhaseWork,validateBoundAuthorityV1} from '../lib/lite-solo-phase-work-v1.mjs';
import {createUnitPlanV1} from '../lib/lite-solo-unit-queue-v1.mjs';

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
const terminalRel=original.lastSealedReceiptPath;
if(original.schemaVersion!=='curveyield-audit-campaign-directory-entry-v2'||
 original.campaignId!==request.sourceCampaignId||original.mode!=='LITE_SOLO'||
 original.authorityRelease!=='lite-solo-v4'||original.campaignStatus!=='COMPLETE'||
 original.currentAssignment!==null||typeof sourcePath!=='string'||
 !sourcePath.startsWith('campaigns/')||sourcePath.split('/').includes('..')||
 !terminalRel?.startsWith(sourcePath+'/receipts/PHASE_10_RECEIPT_v'))
 throw Error('LSC_COMPLETED_LITE_SOLO_V4_SOURCE_REQUIRED');
const terminal=load(terminalRel);
const source0=load(sourcePath+'/receipts/PHASE_00_RECEIPT_v1.json');
const authRoot=validateBoundAuthorityV1({root,receipt:source0});
if(authRoot!=='Audit Skill - Lite-Solo Authority/lite-solo-v4'||
 terminal.phase?.sequence!==10||terminal.phase?.status!=='COMPLETE'||
 terminal.validation?.status!=='PASS'||terminal.source?.sha256!==original.sourceSha256||
 source0.source?.sha256!==original.sourceSha256||
 source0.authority?.manifestSha256!==original.authorityDigest||
 terminal.authority?.manifestSha256!==original.authorityDigest||
 source0.campaign?.campaignGenerationId!==original.campaignGenerationId)
 throw Error('LSC_SOURCE_OR_AUTHORITY_BINDING_INVALID');
const predecessor=request.startPhase-1;
const receiptRel=phase=>sourcePath+'/receipts/PHASE_'+String(phase).padStart(2,'0')+'_RECEIPT_v1.json';
const accepted=[];
for(let phase=0;phase<=predecessor;phase++){
 const rel=receiptRel(phase),data=load(rel);
 if(data.phase?.sequence!==phase||
   !['SEALED','SKIPPED'].includes(data.phase?.status)||
   (data.validation?.status!=='PASS'&&!(phase===9&&data.phase?.status==='SKIPPED'))||
   data.source?.sha256!==original.sourceSha256||
   data.campaign?.campaignGenerationId!==original.campaignGenerationId)
   throw Error('LSC_INVALID_ACCEPTED_PREDECESSOR_PHASE_'+phase);
 accepted.push({phase,path:rel,sha256:digest(rel)});
}
const newSlug='lite-solo-correction-'+sourceSlug+'-'+request.correctionKey;
const newId=newSlug+'-r1';
const dest='campaigns/'+newId;
const entryRel='Audit Campaign Directory/campaigns/'+newSlug+'.json';
const stageRel=dest+'/controller/LITE_SOLO_CORRECTION_STAGE_v1.json';
const scopeRel=dest+'/controller/LITE_SOLO_CORRECTION_SCOPE_v1.json';
const originalBinding={campaignId:original.campaignId,campaignGenerationId:original.campaignGenerationId,
 workspacePath:sourcePath,sourceSha256:original.sourceSha256,authorityDigest:original.authorityDigest,
 terminalReceiptPath:terminalRel,terminalReceiptSha256:digest(terminalRel),
 acceptedPredecessors:accepted};
const stable=JSON.stringify(originalBinding);
const sameSource=(stage)=>{
 if(JSON.stringify(stage.originalBinding)!==stable)throw Error('LSC_SOURCE_BINDING_DRIFT');
 if(digest(terminalRel)!==stage.originalBinding.terminalReceiptSha256)throw Error('LSC_SOURCE_TERMINAL_CHANGED');
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
const restoreControls=(start,scope)=>{
 for(const name of ['CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json','SECURITY_TRACEABILITY_GRAPH_v1.json','EVIDENCE_INVALIDATION_MATRIX_v1.json','DOMAIN_APPLICABILITY_REGISTRY_v1.json']){
  const rel=dest+'/controller/'+name;
  if(!fs.existsSync(toFile(rel)))continue;
  const control=rebind(load(rel));
  control.campaignBinding=rebind(control.campaignBinding);
  if(Array.isArray(control.controllerImports))
   control.controllerImports=control.controllerImports.filter(x=>Number(x.phase)<start);
  if(Array.isArray(control.phaseCheckpoints))
   control.phaseCheckpoints=control.phaseCheckpoints.filter(x=>Number(String(x.phaseId??'').replace('phase-',''))<start);
  if(name.startsWith('CARRIED_')){
   const requested=new Set(scope.obligationIds);
   const before=control.obligations??[];
   const unknown=[...requested].filter(id=>!before.some(o=>String(o.obligationId)===id));
   if(unknown.length)throw Error('LSC_UNKNOWN_OBLIGATION_IDS_'+unknown.join('_'));
   control.obligations=before.filter(x=>Number(x.originPhase)<start);
   for(const row of control.obligations){
    const closedIn=(row.closureEvidenceRefs??[]).some(p=>{
     const m=String(p).match(/(?:phase-|PHASE_)(0?[0-9]{1,2})/i);
     return m&&Number(m[1])>=start;
    });
    if(requested.has(String(row.obligationId))||Number(row.requiredPhase)>=start||closedIn){
      row.status='OPEN';row.statusReason=null;row.closureEvidenceRefs=[];row.updatedAt=when;
    }
   }
  }
  if(name.startsWith('SECURITY_TRACEABILITY_')){
   const old=control.nodes??[];
   control.nodes=old.filter(n=>n.originPhase==null||Number(n.originPhase)<start);
   const kept=new Set(control.nodes.map(n=>n.nodeId));
   control.edges=(control.edges??[]).filter(e=>{
    const a=e.from??e.source??e.sourceNodeId, b=e.to??e.target??e.targetNodeId;
    return kept.has(a)&&kept.has(b);
   });
  }
  // Historical accepted predecessor evidence is retained. Downstream nodes,
  // imports and checkpoints are never treated as already accepted in the fork.
  save(rel,control);
 }
 for(const item of ['results','preflight','phase8-revalidation','phase5-candidate-evidence']){
  fs.rmSync(toFile(dest+'/controller/'+item),{recursive:true,force:true});
 }
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
    scope.campaignId!==newId||scope.startPhase!==request.startPhase||
    typeof scope.reason!=='string'||!scope.reason.trim()||
    !Array.isArray(scope.obligationIds)||!Array.isArray(scope.candidateIds)||
    [...scope.obligationIds,...scope.candidateIds].some(x=>typeof x!=='string'||!/^[A-Za-z0-9._-]+$/.test(x)))
  throw Error('LSC_PRELAUNCH_SCOPE_OR_IDENTITY_INVALID');
 for(const folder of ['source','evidence'])
  inspectUnchanged(toFile(sourcePath+'/'+folder),toFile(dest+'/'+folder));
 // The correction MUST NOT inherit future phase seals or accepted submission
 // snapshots; all later phases must be rerun through the normal controller.
 for(const p of allFiles(dest+'/receipts',n=>/^PHASE_([0-9]{2})_RECEIPT_v[0-9]+\.json$/.test(n))){
  const m=p.match(/^PHASE_(\d{2})_/);
  if(Number(m[1])>=request.startPhase)fs.rmSync(toFile(dest+'/receipts/'+p));
 }
 for(const top of ['work','derived']){
  for(const n of allFiles(dest+'/'+top,n=>/^phase-0?[0-9]+$/.test(n))){
   if(Number(n.slice(6))>=request.startPhase)
    fs.rmSync(toFile(dest+'/'+top+'/'+n),{recursive:true,force:true});
  }
 }
 // The original published terminal report and remediation output are historical,
 // not fresh corrective acceptance. Keep their original copies only in source.
 fs.rmSync(toFile(dest+'/reports/delivery'),{recursive:true,force:true});
 if(request.startPhase<=9)fs.rmSync(toFile(dest+'/remediation'),{recursive:true,force:true});
 for(const name of allFiles(dest+'/submissions',()=>true)){
  if(/^PHASE_([0-9]{2})_/.test(name)&&Number(name.slice(6,8))>=request.startPhase)
   fs.rmSync(toFile(dest+'/submissions/'+name),{recursive:true,force:true});
 }
 for(let p=0;p<=predecessor;p++){
  const rel=dest+'/receipts/PHASE_'+String(p).padStart(2,'0')+'_RECEIPT_v1.json';
  const originalReceipt=load(receiptRel(p)),copy=rebind(originalReceipt);
  copy.campaign={...copy.campaign,campaignId:newId,campaignGenerationId:dir.campaignGenerationId,
   campaignName:dir.campaignName,workspacePath:dest,campaignDirectoryEntryPath:entryRel,mode:'LITE_SOLO'};
  copy.importedFrom={kind:'LITE_SOLO_CORRECTION_PREDECESSOR',campaignId:original.campaignId,
   campaignGenerationId:original.campaignGenerationId,receiptPath:receiptRel(p),receiptSha256:digest(receiptRel(p)),
   originalAuthority:originalReceipt.authority};
  save(rel,copy);
 }
 // Rebase copied derived predecessor references, never modify source evidence.
 for(const n of allFiles(dest+'/derived',n=>/^phase-\d+$/.test(n)&&Number(n.slice(6))<request.startPhase)){
  const folder=dest+'/derived/'+n;
  for(const file of allFiles(folder,n=>n.endsWith('.json'))){
   const rel=folder+'/'+file,prior=fs.readFileSync(toFile(rel));
   const rewritten=rebind(JSON.parse(prior));
   rewritten.correctionImport={sourceCampaignId:original.campaignId,originalSha256:sha(prior)};
   save(rel,rewritten);
  }
 }
 restoreControls(request.startPhase,scope);
 // Reconcile imported receipt references against the actual fork-local bytes.
 for(let p=0;p<=predecessor;p++){
  const rel=dest+'/receipts/PHASE_'+String(p).padStart(2,'0')+'_RECEIPT_v1.json';
  const row=load(rel);
  for(const group of ['inputs','evidence','outputs','automation']){
   for(const ref of row[group]??[]){
    if(typeof ref?.path!=='string')continue;
    const loc=ref.path.startsWith(dest+'/')?ref.path:dest+'/'+ref.path;
    if(fs.existsSync(toFile(loc))&&fs.statSync(toFile(loc)).isFile()&&ref.sha256)
     ref.sha256=digest(loc);
   }
  }
  save(rel,row);
 }
 const policyRel=dest+'/reports/REPORT_PUBLICATION_POLICY_v1.json';
 if(fs.existsSync(toFile(policyRel))){
  const policy=rebind(load(policyRel));
  policy.campaignId=newId;policy.campaignGenerationId=dir.campaignGenerationId;
  const canon=(x)=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?
   Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
  const bytes=JSON.stringify(canon(policy));
  fs.writeFileSync(toFile(policyRel),bytes);
  dir.publicationPolicyPath=policyRel;dir.publicationPolicySha256=sha(Buffer.from(bytes));
 }
 const inputs=allFiles(dest+'/derived',n=>/^phase-\d+$/.test(n)&&Number(n.slice(6))<request.startPhase)
  .flatMap(n=>allFiles(dest+'/derived/'+n,f=>f.endsWith('.json')&&!f.startsWith('INDEX'))
  .map(f=>dest+'/derived/'+n+'/'+f));
 const previous=dest+'/receipts/PHASE_'+String(predecessor).padStart(2,'0')+'_RECEIPT_v1.json';
 const assignment=preparePhaseWork({root,campaignPath:dest,authorityRoot:authRoot,
  sequence:request.startPhase,reviewer:'lite-solo-agent',
  predecessorReceiptPath:previous,derivedInputPaths:inputs,status:'ACTIVE'});
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
