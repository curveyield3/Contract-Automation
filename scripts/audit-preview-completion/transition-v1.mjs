#!/usr/bin/env node
// Audit Preview Completion v1. This is an isolated fork bridge, not a mutation
// of the sealed Preview or the installed Lite-Solo workflows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {preparePhaseWork,validateWorkForm,loadPhaseSchema} from '../lib/lite-solo-phase-work-v1.mjs';
import {renderControllerPhaseReport,validatePhaseScaffold} from '../lib/lite-solo-phase-prefill-v1.mjs';
import {createUnitPlanV1} from '../lib/lite-solo-unit-queue-v1.mjs';

const root=path.resolve(process.env.AUDIT_CONTROLLER_ROOT??'.audit-controller');
const reqPath=process.argv[2];
if(!reqPath||!fs.existsSync(reqPath))throw Error('AUDIT_PREVIEW_COMPLETION_REQUEST_MISSING');
const request=JSON.parse(fs.readFileSync(reqPath,'utf8'));
const safe=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9.-]*$/.test(s)&&!s.includes('..');
const inside=rel=>{
  if(typeof rel!=='string'||!rel||path.posix.isAbsolute(rel)||rel.split('/').includes('..'))throw Error('APC_UNSAFE_PATH');
  const resolved=path.resolve(root,rel);
  if(!resolved.startsWith(root+path.sep))throw Error('APC_PATH_OUTSIDE_CONTROLLER');
  return resolved;
};
const read=rel=>JSON.parse(fs.readFileSync(inside(rel),'utf8'));
const write=(rel,obj)=>{const dest=inside(rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,JSON.stringify(obj,null,2)+'\n')};
const text=(rel,value)=>{const dest=inside(rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,value)};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileSha=rel=>sha(fs.readFileSync(inside(rel)));
const hex64=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const ref=(base,relative)=>path.posix.join(base,relative);
const expectedSchema='curveyield-audit-preview-completion-request-v1';
if(request.schemaVersion!==expectedSchema||!['PREPARE','LAUNCH'].includes(request.operation)
  ||!safe(request.previewCampaignId)||!safe(request.requestId))throw Error('APC_REQUEST_INVALID');
const previewId=request.previewCampaignId;
const previewSlug=previewId.replace(/-r\d+$/,'');
if(previewSlug===previewId||!previewSlug.startsWith('audit-preview-'))throw Error('APC_NOT_A_PREVIEW_CAMPAIGN');
const originalDirectoryPath='Audit Campaign Directory/campaigns/'+previewSlug+'.json';
const preview=read(originalDirectoryPath);
if(preview.campaignId!==previewId||preview.product!=='AUDIT_PREVIEW'||preview.campaignStatus!=='PREVIEW_COMPLETE'
  ||preview.authorityRelease!=='audit-preview-v1'||preview.auditPreview?.terminalPhase!==4
  ||preview.lastSealedReceiptPath!==ref(preview.workspacePath,'receipts/PHASE_04_RECEIPT_v1.json'))
  throw Error('APC_PREVIEW_NOT_SEALED');
const oldRoot=preview.workspacePath;
if(!oldRoot?.startsWith('campaigns/')||oldRoot.includes('..'))throw Error('APC_UNSAFE_PREVIEW_ROOT');
const oldReceipts=Array.from({length:5},(_,i)=>read(ref(oldRoot,'receipts/PHASE_'+String(i).padStart(2,'0')+'_RECEIPT_v1.json')));
for(const [i,r] of oldReceipts.entries()){
  if(r.phase?.sequence!==i||r.phase?.status!=='SEALED'||r.validation?.status!=='PASS'
    ||r.source?.sha256!==preview.sourceSha256||r.authority?.liteRelease!=='audit-preview-v1'
    ||r.campaign?.campaignGenerationId!==preview.campaignGenerationId)
    throw Error('APC_PREVIEW_RECEIPT_INVALID_PHASE_'+i);
}
if(!hex64(preview.sourceSha256))throw Error('APC_SOURCE_DIGEST_INVALID');
const newSlug='audit-preview-completion-'+previewSlug.slice('audit-preview-'.length);
const newId=newSlug+'-r1';
const dest='campaigns/'+newId;
const entryPath='Audit Campaign Directory/campaigns/'+newSlug+'.json';
const authorityRoot='Audit Skill - Lite-Solo Authority/lite-solo-v4';
const manifestRel=authorityRoot+'/MANIFEST.json',skillRel=authorityRoot+'/SKILL.md';
const manifestBytes=fs.readFileSync(inside(manifestRel)),skillBytes=fs.readFileSync(inside(skillRel));
const manifest=JSON.parse(manifestBytes.toString('utf8'));
if(manifest.release!=='lite-solo-v4'||manifest.entrypoint!=='SKILL.md')throw Error('APC_V4_AUTHORITY_NOT_INSTALLED');
const blobSha=bytes=>createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');
const authority={
  repository:'curveyield3/Audit-Controller',ref:'main',
  authorityFolderPath:'Audit Skill - Lite-Solo Authority',homepagePath:skillRel,
  liteSkillPath:'curveyield3/Audit-Controller/Audit Skill - Lite-Solo Authority',
  liteSkillBlobSha:blobSha(skillBytes),liteSkillSha256:sha(skillBytes),
  manifestSha256:sha(manifestBytes),manifestGitBlobSha:blobSha(manifestBytes),
  authorityCommitSha:process.env.AUDIT_CONTROLLER_COMMIT_SHA,
  liteRelease:'lite-solo-v4',packageRevision:manifest.packageRevision
};
if(!/^[a-f0-9]{40}$/.test(authority.authorityCommitSha??''))throw Error('APC_AUTHORITY_COMMIT_MISSING');
const originalFormRel=ref(oldRoot,'work/phase-04/PHASE_04_WORK_FORM_v1.json');
const editRel=ref(dest,'work/phase-04/PRELAUNCH_PHASE_04_WORK_FORM_v1.json');
const evidenceRel=ref(dest,'work/phase-04/PHASE_04_ONCHAIN_READONLY_v1.json');
const stageRel=ref(dest,'controller/AUDIT_PREVIEW_COMPLETION_STAGE_v1.json');
const derivedRel=ref(dest,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json');
const derivedInputRel=ref(dest,'derived/phase-3/PHASE4_INPUT_v1.json');
const copyCampaign=()=>{
 if(fs.existsSync(inside(dest))||fs.existsSync(inside(entryPath)))throw Error('APC_CONTINUATION_ALREADY_EXISTS');
 fs.cpSync(inside(oldRoot),inside(dest),{recursive:true,errorOnExist:true,force:false});
 // The prior sealed phase-4 receipt must never appear as the new audit's own receipt.
 fs.rmSync(inside(ref(dest,'receipts/PHASE_04_RECEIPT_v1.json')));
 const form=read(originalFormRel);
 // Proposed minimal correction remains editable before LAUNCH. It is never
 // sealed unless a fresh frozen-block read-only witness is recorded.
 const oldLim=form.actions?.['step-3']?.outputs?.typedLimitations;
 if(Array.isArray(oldLim)){
  form.actions['step-3'].outputs.typedLimitations=oldLim.map(v=>
   typeof v==='string'&&v.startsWith('LIMITATION_LIVE_CONFIGURATION:')
    ?'LIMITATION_LIVE_CONFIGURATION: The admitted Phase-0 fork established exact deployed runtime/source identity and successful read-only token state checks. Audit Preview Completion must additionally record a fresh, block-pinned wards(address) read for known ward candidates before sealing this correction. The sampled ward addresses do not constitute an exhaustive roster without full authenticated historical LogNote/constructor reconciliation. Key custody, external governance/timelocks, backing, redemptions and third-party integrations remain outside the admitted token-only scope. No live state-changing transactions or executable attack tests were performed.'
    :v);
 }
 write(editRel,form);
 const at=new Date().toISOString();
 const dir={
  schemaVersion:'curveyield-audit-campaign-directory-entry-v2',
  campaignId:newId,campaignGenerationId:newId+'-g1-'+at.replace(/[-:.]/g,'').replace('Z','Z'),
  campaignName:'Audit Preview Completion — '+preview.campaignName,
  workspacePath:dest,mode:'LITE_SOLO',deliveryTransport:'DIRECT',
  agent:{actorId:'lite-solo-agent'},agentModel:'PARALLEL_WORKER_UNITS',executionModel:'PARALLEL_WORKER_UNITS',
  authorityRelease:'lite-solo-v4',authorityDigest:sha(manifestBytes),
  sourceSha256:preview.sourceSha256,campaignStatus:'STAGED_PRELAUNCH',currentAssignment:null,
  lastSealedReceiptPath:null,unitPhaseEpoch:1,transportEpoch:0,updatedAt:at,
  previewCompletion:{schemaVersion:'audit-preview-completion-provenance-v1',originalCampaignId:previewId,
   originalGenerationId:preview.campaignGenerationId,originalWorkspacePath:oldRoot,
   originalPhase4ReceiptPath:preview.lastSealedReceiptPath,
   originalPhase4ReceiptSha256:fileSha(preview.lastSealedReceiptPath),
   originalPhase4WorkFormSha256:fileSha(originalFormRel),
   originalAuthorityDigest:preview.authorityDigest,
   originalSourceSha256:preview.sourceSha256,
   status:'STAGED',editWorkFormPath:editRel,readonlyEvidencePath:evidenceRel}
 };
 write(entryPath,dir);
 write(stageRel,{schemaVersion:'audit-preview-completion-prelaunch-v1',campaignId:newId,
  sourcePreviewCampaignId:previewId,sourceSha256:preview.sourceSha256,
  priorPhase4ReceiptSha256:dir.previewCompletion.originalPhase4ReceiptSha256,
  editablePhase4WorkFormPath:editRel,
  notice:'Edit only this forked prelaunch work form. Do not alter the sealed Preview receipts, evidence or authority. LAUNCH performs frozen-block read-only checks and imports accepted prior phase work.',
  status:'AWAITING_OPTIONAL_PHASE4_EDIT_AND_LAUNCH',createdAt:at});
 console.log(JSON.stringify({operation:'PREPARE',status:'STAGED',campaignId:newId,editPath:editRel}));
};
const importHistory=(dir)=>{
 // These prior phases were done under Preview authority. Retain their exact
 // original bytes and identities in importedFrom, never misrepresent their origin.
 const replacement=s=>s.replaceAll(previewId,newId).replaceAll(oldRoot,dest);
 // Rebind only continuation copies of derived semantic data. Original accepted
 // Preview data and all raw machine/chain evidence are retained unchanged.
 for(let phase=1;phase<=3;phase++){
  const folder=ref(dest,'derived/phase-'+phase);
  if(!fs.existsSync(inside(folder)))continue;
  for(const name of fs.readdirSync(inside(folder)).filter(x=>x.endsWith('.json'))){
   const rel=ref(folder,name),data=read(rel);
   const originalBytes=fs.readFileSync(inside(rel));
   const changed=JSON.parse(JSON.stringify(data).replaceAll(oldRoot,dest).replaceAll(previewId,newId));
   if(changed?.workSchemaPath)changed.workSchemaPath=ref(authorityRoot,
     'phases/phase-'+phase+'/PHASE_'+String(phase).padStart(2,'0')+'_SCHEMA_v1.json');
   changed.previewImportProvenance={originalPath:ref(oldRoot,'derived/phase-'+phase+'/'+name),
     originalSha256:sha(originalBytes),originalProduct:'AUDIT_PREVIEW'};
   write(rel,changed);
  }
 }
 for(let phase=0;phase<=3;phase++){
  const id=String(phase).padStart(2,'0');
  const loc=ref(dest,'receipts/PHASE_'+id+'_RECEIPT_v1.json');
  const prior=oldReceipts[phase],r=structuredClone(prior);
  r.importedFrom={product:'AUDIT_PREVIEW',campaignId:previewId,
   campaignGenerationId:preview.campaignGenerationId,
   sealedReceiptPath:ref(oldRoot,'receipts/PHASE_'+id+'_RECEIPT_v1.json'),
   sealedReceiptSha256:fileSha(ref(oldRoot,'receipts/PHASE_'+id+'_RECEIPT_v1.json')),
   originalAuthority:prior.authority,adoptionPolicy:'SOURCE_IDENTICAL_ACCEPTED_PREVIEW_EVIDENCE'};
  r.campaign={...r.campaign,campaignId:newId,campaignGenerationId:dir.campaignGenerationId,
    campaignName:dir.campaignName,workspacePath:dest,campaignDirectoryEntryPath:entryPath,mode:'LITE_SOLO'};
  r.authority=authority;
  r.source={...r.source,
    extractedContentPath:ref(dest,'source'),
    scanManifestPath:r.source?.scanManifestPath?replacement(r.source.scanManifestPath):undefined};
  r.inputs=(r.inputs??[]).map(o=>({...o,path:o.path?.startsWith(oldRoot+'/')?replacement(o.path):o.path}));
  for(const key of ['evidence','outputs']){
    r[key]=(r[key]??[]).map(o=>{
      if(typeof o.path!=='string')return o;
      const relative=o.path.startsWith(oldRoot+'/')?replacement(o.path):ref(dest,o.path);
      const relativeWithin=relative.startsWith(dest+'/')?relative:ref(dest,o.path);
      if(fs.existsSync(inside(relativeWithin))){
       return {...o,path:o.path.startsWith(oldRoot+'/')?replacement(o.path):o.path,sha256:fileSha(relativeWithin)};
      }
      return o;
    });
  }
  r.handoff={...r.handoff,nextPhaseSequence:phase+1};
  write(loc,r);
 }
};
const launch=async()=>{
 const dir=read(entryPath);
 if(dir.campaignId!==newId||dir.campaignStatus!=='STAGED_PRELAUNCH'
  ||dir.sourceSha256!==preview.sourceSha256
  ||dir.previewCompletion?.originalPhase4ReceiptSha256!==fileSha(preview.lastSealedReceiptPath)
  ||dir.previewCompletion?.originalAuthorityDigest!==preview.authorityDigest)
  throw Error('APC_PRELAUNCH_IDENTITY_OR_STATUS_INVALID');
 const proof=read(evidenceRel);
 const scan=read(ref(oldRoot,'source/live-scan-project/scan-source-manifest.json'));
 const daiPresent=scan.resolvedTargets?.some(x=>String(x.address).toLowerCase()==='0x6b175474e89094c44da98b954eedeac495271d0f');
 if(proof.status!=='VERIFIED_READ_ONLY'||proof.chainId!==scan.chainId
  ||proof.blockNumber!==scan.frozenBlock?.number
  ||String(proof.blockHash).toLowerCase()!==String(scan.frozenBlock?.hash).toLowerCase()
  ||proof.sourceSha256!==preview.sourceSha256
  ||!Array.isArray(proof.runtimeChecks)||proof.runtimeChecks.length!==scan.resolvedTargets.length
  ||proof.runtimeChecks.some(x=>x.exactMatch!==true)
  ||!Array.isArray(proof.readOnlyChecks)||!Array.isArray(proof.wardReads)
  ||(daiPresent&&!proof.wardReads.length))
  throw Error('APC_ONCHAIN_VERIFICATION_REQUIRED');
 const form=read(editRel),prior=read(originalFormRel);
 const {schema}=loadPhaseSchema(root,authorityRoot,4);
 const problems=[...validateWorkForm(schema,form),...validatePhaseScaffold(4,form)];
 if(problems.length)throw Error('APC_PHASE4_EDIT_INVALID: '+problems.slice(0,12).join('; '));
 if(form.phase!==prior.phase||form.schemaVersion!==prior.schemaVersion
  ||JSON.stringify(form.automationInputs)!==JSON.stringify(prior.automationInputs))
  throw Error('APC_CONTROLLER_OWNED_FIELDS_CHANGED');
 // Preserve prefilled identities and accepted discovery coverage. Only substantive
 // reviewer outputs may be edited; arbitrary source/coverage/bookkeeping changes fail.
 for(const step of ['step-1','step-2','step-3']){
  if(form.actions?.[step]?.section!==prior.actions?.[step]?.section)throw Error('APC_SECTION_IDENTITY_CHANGED');
 }
 const priorRows=prior.actions?.['step-1']?.outputs?.discoveryReconciliationRecords??[];
 const newRows=form.actions?.['step-1']?.outputs?.discoveryReconciliationRecords??[];
 if(JSON.stringify(priorRows.map(x=>x.recordKey))!==JSON.stringify(newRows.map(x=>x.recordKey)))
  throw Error('APC_DISCOVERY_RECORD_KEYS_CHANGED');
 for(const name of ['specialistReviewRecords','obligationDispositions']){
  const a=prior.actions?.['step-2']?.outputs?.[name]??prior.actions?.['step-3']?.outputs?.[name]??[];
  const b=form.actions?.['step-2']?.outputs?.[name]??form.actions?.['step-3']?.outputs?.[name]??[];
  if(JSON.stringify(a.map?.(x=>x?.recordKey??x?.obligationId))!==JSON.stringify(b.map?.(x=>x?.recordKey??x?.obligationId)))
    throw Error('APC_PREFILL_RECORD_KEYS_CHANGED_'+name);
 }
 // The original Phase-4 form, immutable source and on-chain proof remain available.
 // All changed material interpretations are attributable to this completion fork.
 importHistory(dir);
 const finalFormRel=ref(dest,'work/phase-04/PHASE_04_WORK_FORM_v1.json');
 write(finalFormRel,form);
 const oldCanonical=read(ref(oldRoot,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json'));
 const canonical={...oldCanonical,campaignId:newId,
  workSchemaPath:ref(authorityRoot,'phases/phase-4/PHASE_04_SCHEMA_v1.json'),
  workFormPath:finalFormRel,finalReportPath:ref(dest,'work/phase-04/PHASE_04_FINAL_REPORT_v1.md'),
  actions:form.actions,
  importedFrom:{campaignId:previewId,
    sourceCanonicalDataPath:ref(oldRoot,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json'),
    sourceCanonicalDataSha256:fileSha(ref(oldRoot,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json')),
    readOnlyVerificationPath:evidenceRel},
  generatedAt:new Date().toISOString()};
 write(derivedRel,canonical);
 const reportRel=ref(dest,'work/phase-04/PHASE_04_FINAL_REPORT_v1.md');
 text(reportRel,renderControllerPhaseReport({schema,form,canonical}));
 const receipt=structuredClone(oldReceipts[4]);
 const now=new Date().toISOString();
 receipt.importedFrom={product:'AUDIT_PREVIEW',campaignId:previewId,
  campaignGenerationId:preview.campaignGenerationId,
  originalSealedReceiptPath:preview.lastSealedReceiptPath,
  originalSealedReceiptSha256:fileSha(preview.lastSealedReceiptPath),
  originalAuthority:oldReceipts[4].authority,
  sourceCanonicalSha256:fileSha(ref(oldRoot,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json')),
  supplementalOnchainEvidencePath:evidenceRel};
 receipt.campaign={...receipt.campaign,campaignId:newId,campaignGenerationId:dir.campaignGenerationId,
  campaignName:dir.campaignName,workspacePath:dest,campaignDirectoryEntryPath:entryPath,mode:'LITE_SOLO'};
 receipt.authority=authority;
 receipt.source={...receipt.source,extractedContentPath:ref(dest,'source'),
  scanManifestPath:receipt.source?.scanManifestPath?receipt.source.scanManifestPath.replace(oldRoot,dest):undefined};
 receipt.inputs=[{role:'IMPORTED_PREVIEW_PHASE4_RECEIPT',path:preview.lastSealedReceiptPath,sha256:fileSha(preview.lastSealedReceiptPath)},
  {role:'PREDECESSOR_PHASE3_IMPORT',path:ref(dest,'receipts/PHASE_03_RECEIPT_v1.json')}];
 receipt.evidence=[
  {role:'PHASE_WORK_FORM',path:'work/phase-04/PHASE_04_WORK_FORM_v1.json',sha256:fileSha(finalFormRel)},
  {role:'PHASE_FINAL_REPORT',path:'work/phase-04/PHASE_04_FINAL_REPORT_v1.md',sha256:fileSha(reportRel)},
  {role:'PHASE_CANONICAL_DATA',path:'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json',sha256:fileSha(derivedRel)},
  {role:'READ_ONLY_FROZEN_BLOCK_VERIFICATION',path:'work/phase-04/PHASE_04_ONCHAIN_READONLY_v1.json',sha256:fileSha(evidenceRel)},
  {role:'ORIGINAL_PREVIEW_RECEIPT',path:preview.lastSealedReceiptPath,sha256:fileSha(preview.lastSealedReceiptPath)}
 ];
 receipt.outputs=receipt.evidence;
 receipt.handoff={required:false,boundary:null,incomingReviewer:null,assignedWork:null,
  nextPhaseSequence:5,sameReviewer:true,status:'NOT_APPLICABLE'};
 receipt.validation={status:'PASS',validatedAt:now,failures:[]};
 receipt.sealedAt=now;receipt.updatedAt=now;
 const receiptRel=ref(dest,'receipts/PHASE_04_RECEIPT_v1.json');
 write(receiptRel,receipt);
 dir.lastSealedReceiptPath=receiptRel;
 const next=preparePhaseWork({root,campaignPath:dest,authorityRoot,sequence:5,reviewer:'lite-solo-agent',
   predecessorReceiptPath:receiptRel,status:'ACTIVE',derivedInputPaths:[
    ref(dest,'derived/phase-2/PHASE3_INPUT_v1.json'),
    derivedInputRel,derivedRel]});
 dir.currentAssignment=next;dir.campaignStatus='ACTIVE';
 dir.previewCompletion.status='LAUNCHED';dir.previewCompletion.launchedAt=now;
 dir.previewCompletion.prelaunchFormSha256=fileSha(editRel);
 dir.previewCompletion.onchainVerificationSha256=fileSha(evidenceRel);
 dir.updatedAt=now;
 write(entryPath,dir);
 createUnitPlanV1({root,campaignPath:dest,directory:dir,phase:5,automationRoot:process.cwd()});
 write(stageRel,{...read(stageRel),status:'LAUNCHED',launchedAt:now,
   workFormSha256:fileSha(finalFormRel),onchainVerificationSha256:fileSha(evidenceRel),
   phase4ReceiptPath:receiptRel,phase5AssignmentPath:next.packetPath});
 console.log(JSON.stringify({operation:'LAUNCH',status:'ACTIVE',campaignId:newId,
  nextPhaseSequence:5,phase4ReceiptPath:receiptRel}));
};
if(request.operation==='PREPARE')copyCampaign();
else {
 // Failure must not leave a half-rebound audit, partial Phase-5 queue or a
 // spuriously LAUNCHED directory. This is a transactional transition.
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'audit-preview-completion-'));
 try{
  fs.cpSync(inside(dest),path.join(temp,'campaign'),{recursive:true});
  fs.copyFileSync(inside(entryPath),path.join(temp,'directory.json'));
  try{await launch();}
  catch(error){
   fs.rmSync(inside(dest),{recursive:true,force:true});
   fs.cpSync(path.join(temp,'campaign'),inside(dest),{recursive:true});
   fs.copyFileSync(path.join(temp,'directory.json'),inside(entryPath));
   throw error;
  }
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
