import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {repoFile,readJson,writeJson,loadPhaseSchema,validateWorkForm,requiredFile} from './lite-solo-phase-work-v1.mjs';
import {validateFlowReviewSubmissionV1,validateAttackSubmissionV1} from '../../packages/github-native-sim/src/adr-discovery-validators-v1.mjs';
import {reviewInventoryRelV1} from '../../packages/github-native-sim/src/adr-review-inventory-v1.mjs';
import {buildUnitPacketV1,writeUnitPacketIndexV1,buildDiscoverySummaryV1,readUnitPacketV1} from '../../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';
import {loadTaxonomyV1} from '../../packages/github-native-sim/src/adr-taxonomy-v1.mjs';
import {deriveBaselineObligationsV1} from '../../packages/github-native-sim/src/adr-baseline-obligations-v1.mjs';
import {applyPhaseBoundaryPrefill,resolveTargetExecutionRequestRef} from './lite-solo-phase-prefill-v1.mjs';
import {validateTargetExecutionRequestBindingV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {validateLiveForkBaselineRecordV1} from './lite-solo-live-fork-baseline-gate-v1.mjs';
import {materializeSemanticWorkFormV13,secureShardWorkFormV13} from './lite-solo-work-shards-v1.mjs';
import {planSemanticBatchesV1,SEMANTIC_BATCH_READING_GUIDE_V1} from './lite-solo-semantic-batches-v1.mjs';

export const UNIT_POLICY=Object.freeze({issueBatchDefault:50,issueBatchMax:50,approvalBatchMax:50,maxParallelWorkers:null});
export const REQUEST_SCHEMA='curveyield-lite-solo-unit-batch-request-v1';
// Public queue/packet contracts: one authoritative definition, not copied workflow limits.
export const UNIT_QUEUE_STATUSES=Object.freeze(['BLOCKED_DEPENDENCY','AVAILABLE','CLAIMED',
 'SUBMITTED','ACCEPTED','REWORK_REQUIRED','RELEASED']);
export const UNIT_ARTIFACT_SCHEMAS=Object.freeze({
 queue:'curveyield-lite-solo-unit-queue-state-v1',
 plan:'curveyield-lite-solo-unit-plan-v1',
 planPage:'curveyield-lite-solo-unit-plan-page-v1',
 packetIndex:'curveyield-discovery-packet-section-index-v1',
 batchIndex:'curveyield-lite-solo-unit-batch-index-v1',
 batchPage:'curveyield-lite-solo-unit-batch-page-v1',
 submission:'curveyield-lite-solo-unit-submission-v1',
 accepted:'curveyield-lite-solo-accepted-unit-v1',
 result:'curveyield-lite-solo-unit-controller-result-v1'
});
const hex=b=>createHash('sha256').update(b).digest('hex');
const pretty=x=>JSON.stringify(x,null,2)+'\n';
const sha=x=>hex(Buffer.from(pretty(x)));
const read=(root,rel)=>readJson(requiredFile(root,rel));
const maybe=(root,rel)=>fs.existsSync(repoFile(root,rel))?readJson(repoFile(root,rel)):null;
const put=(root,rel,value)=>writeJson(repoFile(root,rel),value);
const safe=s=>typeof s==='string'&&/^[A-Za-z0-9._-]{1,140}$/.test(s)&&!s.startsWith('.');
const dot=(tokens)=>tokens.join('.');
const section=(form,tokens)=>tokens.reduce((obj,key)=>obj?.[key],form);
const rootOf=(campaign,phase)=>path.posix.join(campaign,'work/phase-'+String(phase).padStart(2,'0')+'/units');
const queueRel=(campaign,phase)=>path.posix.join(rootOf(campaign,phase),'UNIT_QUEUE_STATE_v1.json');
const planRel=(campaign,phase)=>path.posix.join(rootOf(campaign,phase),'UNIT_PLAN_INDEX_v1.json');
const unitBase=(campaign,phase,id)=>path.posix.join(rootOf(campaign,phase),id);
// Question histories are written directly to the isolated Audit-Controller branch by
// the authenticated fork Worker in bounded GitHub checkpoints, never by per-question
// Actions runs. This optional reference is packaging metadata, NOT a quality gate.
function questionLedgerReferenceV1({root,campaign,phase,unitId,directory}){
 const rel=path.posix.join(unitBase(campaign,phase,unitId),'questions/QUESTION_INDEX_v1.json');
 try{
  const file=repoFile(root,rel);
  if(!fs.existsSync(file))return null;
  const raw=fs.readFileSync(file),index=JSON.parse(raw.toString('utf8'));
  if(index.schemaVersion!=='curveyield-ai-question-index-v1'||
    index.campaignId!==directory.campaignId||
    index.campaignGenerationId!==directory.campaignGenerationId||
    index.sourceSha256!==directory.sourceSha256||
    index.authorityDigest!==directory.authorityDigest||
    index.phaseSequence!==phase||index.unitId!==unitId)return null;
  return {indexPath:rel,indexSha256:hex(raw),revision:index.revision,
   questionCount:index.questions?.length??0,answeredCount:index.answeredCount??0,
   status:index.status??'UNKNOWN'};
 }catch{return null;} // Never turn an optional history into a GitHub-side process stop.
}
const asArray=x=>Array.isArray(x)?x:[];
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>structuredClone(x);
// Bind acceptance to the exact original-record evidence, even when a parent
// batch is undergoing targeted rework and its unrelated siblings remain valid.
function prerequisiteEvidence(queue,dependencies){
 const evidence={};
 for(const id of asArray(dependencies)){
  const record=queue.acceptedRecords?.[id];
  if(record?.status==='ACCEPTED'&&record.snapshotSha256){
   evidence[id]='RECORD:'+record.snapshotSha256;continue;
  }
  const unit=queue.units[id];
  if(unit?.status==='ACCEPTED'&&unit.acceptedPath&&unit.acceptedSha256){
   evidence[id]='UNIT:'+unit.acceptedPath+':'+unit.acceptedSha256;continue;
  }
  return null;
 }
 return evidence;
}
// The Worker/adapter decides audit prerequisites; GitHub only manages the queue.
const depSatisfied=()=>true;
const dependenciesFresh=()=>true;
const isPhase=(p)=>[4,5,6].includes(p);
const RELEASES=new Set(['machine-intelligence-v7']);
const authorityFor=directory=>{
  if(!RELEASES.has(directory.authorityRelease))throw Error('unsupported Machine Intelligence release');
  return 'Machine Intelligence Audit Controller/Audit Skill v7';
};
const rowId=(phase,field,index)=>{
 const families={
 '4:discoveryReconciliationRecords':'P4-RC','4:specialistReviewRecords':'P4-SP',
 '4:candidateRecords':'P4-C','4:typedLimitations':'P4-L','4:obligationDispositions':'P4-OB',
 '5:economicReviewRecords':'P5-E','5:reconciliationRecords':'P5-R','5:targetDesigns':'P5-T','5:newCandidateRecords':'P5-R',
 '6:deploymentAssessments':'P6-D','6:targetDispositions':'P6-T',
 '6:baselineTestRecords':'P6-B','6:candidateProofRecords':'P6-P',
 '6:mergedExecutionConclusions':'P6-C','6:obligationDispositions':'P6-C',
 '6:typedExecutionLimitations':'P6-L','6:fullOnlyOmissions':'P6-O','6:newCandidateRecords':'P6-P'
 };
 const prefix=families[phase+':'+field];
 if(!prefix)throw Error('unassigned semantic field '+phase+':'+field);
 return prefix+'-'+String(index+1).padStart(3,'0');
};
function assertParallelSolo(directory,phase,request=null){
 if(!isPhase(phase)||directory.mode!=='LITE_SOLO'||!RELEASES.has(directory.authorityRelease))
  throw Error('Machine Intelligence parallel controller requires the fork-owned authority');
 if(directory.executionModel!=='PARALLEL_WORKER_UNITS')
  throw Error('campaign is not admitted to parallel execution');
 if(directory.currentAssignment?.phaseSequence!==phase)throw Error('phase not current/assigned');
 if(request){
  const expected={campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,
   phaseSequence:phase,sourceSha256:directory.sourceSha256,
   auditControllerRef:'machine-intelligence-audit-controller-v1'};
  for(const [key,value] of Object.entries(expected))if(request[key]!==value)throw Error('request identity mismatch: '+key);
  if(request.authorityDigest!==directory.authorityDigest)
   throw Error('authority digest differs from bound campaign');
  if(request.phaseEpoch!==Number(directory.unitPhaseEpoch??1))throw Error('stale phase epoch');
 }
}
function emptyPlan(directory,phase){
 return {schemaVersion:'curveyield-lite-solo-unit-plan-v1',campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,phaseSequence:phase,phaseEpoch:Number(directory.unitPhaseEpoch??1),
  sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
  unitSpecRevision:1,campaignPath:directory.workspacePath,units:[],recordOwnership:{},stage:phase===4?'CORRECTNESS':'SEMANTIC'};
}
function emptyQueue(plan){
 return {schemaVersion:'curveyield-lite-solo-unit-queue-state-v1',campaignId:plan.campaignId,
  campaignGenerationId:plan.campaignGenerationId,phaseSequence:plan.phaseSequence,
  phaseEpoch:plan.phaseEpoch,sourceSha256:plan.sourceSha256,authorityDigest:plan.authorityDigest,
  unitSpecRevision:plan.unitSpecRevision,stage:plan.stage,
  units:{},acceptedRecords:{},processedRequests:{},processedRequestHashes:{},revision:0,finalizeStatus:'NOT_STARTED',newlyEligibleUnitIds:[]};
}
function addUnit(plan,queue,unit){
 if(queue.units[unit.unitId]||plan.units.some(x=>x.unitId===unit.unitId))throw Error('duplicate unit '+unit.unitId);
 const status=asArray(unit.dependencies).length?'BLOCKED_DEPENDENCY':'AVAILABLE';
 plan.units.push(unit);queue.units[unit.unitId]={status,workerId:null,claimEpoch:0,
  claimToken:null,acceptedSha256:null,lastSubmissionSha256:null,lastErrors:[],attempts:0};
}
function assertPlan(queue,plan){
 for(const k of ['campaignId','campaignGenerationId','phaseSequence','phaseEpoch','sourceSha256','authorityDigest','unitSpecRevision'])
  if(queue[k]!==plan[k])throw Error('unit plan/queue identity differs: '+k);
}
const PREFILL_PART_BYTES=12*1024;
const prefillPartRel=(rel,i)=>path.posix.join(path.posix.dirname(rel),'prefill-pages',
 path.posix.basename(rel,'.json')+'_PART_'+String(i+1).padStart(6,'0')+'_v1.json');
function writePagedPrefillV1(root,rel,value){
 const raw=Buffer.from(pretty({value}),'utf8'),count=Math.ceil(raw.length/PREFILL_PART_BYTES);
 for(let i=0;i<count;i++){
  const part=raw.subarray(i*PREFILL_PART_BYTES,(i+1)*PREFILL_PART_BYTES);
  const page={schemaVersion:'curveyield-lite-solo-unit-prefill-page-v1',index:i+1,
   total:count,offset:i*PREFILL_PART_BYTES,sha256:hex(part),base64:part.toString('base64')};
  if(Buffer.byteLength(pretty(page))>24*1024)throw Error('prefill page exceeds 24 KiB');
  put(root,prefillPartRel(rel,i),page);
 }
 const manifest={schemaVersion:'curveyield-lite-solo-unit-prefill-manifest-v1',
  sha256:hex(raw),byteLength:raw.length,partBytes:PREFILL_PART_BYTES,pageCount:count};
 put(root,rel,manifest);return manifest;
}
function readPagedPrefillV1(root,rel,rawManifest){
 const manifest=JSON.parse(rawManifest.toString('utf8'));
 if(manifest.schemaVersion!=='curveyield-lite-solo-unit-prefill-manifest-v1')
  return manifest.value;
 if(!Number.isSafeInteger(manifest.pageCount)||manifest.pageCount<1||
    manifest.partBytes!==PREFILL_PART_BYTES||!/^[a-f0-9]{64}$/.test(manifest.sha256))
  throw Error('invalid bounded prefill manifest');
 const chunks=[];
 for(let i=0;i<manifest.pageCount;i++){
  const page=read(root,prefillPartRel(rel,i));
  if(page.schemaVersion!=='curveyield-lite-solo-unit-prefill-page-v1'||
     page.index!==i+1||page.total!==manifest.pageCount||
     page.offset!==i*PREFILL_PART_BYTES)throw Error('prefill page identity mismatch');
  const part=Buffer.from(page.base64,'base64');
  if(part.length>PREFILL_PART_BYTES||hex(part)!==page.sha256)
   throw Error('prefill page digest mismatch');
  chunks.push(part);
 }
 const full=Buffer.concat(chunks);
 if(full.length!==manifest.byteLength||hex(full)!==manifest.sha256)
  throw Error('prefill reconstruction digest mismatch');
 return JSON.parse(full.toString('utf8')).value;
}
function readPlan(root,campaign,phase){
 const index=read(root,planRel(campaign,phase));
 if(index.schemaVersion!=='curveyield-lite-solo-unit-plan-v1'||!Array.isArray(index.pages))
  throw Error('unrecognized or unpaged v4 unit plan');
 // Normalize only a Git-verified alias of this same exact campaign workspace.
 const prior=index.campaignPath;
 if(prior!==campaign){
  if(typeof prior!=='string'||!/^campaigns\/[^/]+$/.test(prior)||
     !/^campaigns\/[^/]+\/[^/]+$/.test(campaign))
   throw Error('unit plan campaign path mismatch');
  const alias=repoFile(root,prior),current=repoFile(root,campaign);
  if(!fs.lstatSync(alias).isSymbolicLink()||fs.realpathSync(alias)!==fs.realpathSync(current))
   throw Error('unit plan location lacks verified migration alias');
 }
 const canonical=s=>typeof s==='string'&&prior!==campaign&&s.startsWith(prior+'/')
  ?campaign+s.slice(prior.length):s;
 const units=[];
 for(const p of index.pages){
  const raw=fs.readFileSync(repoFile(root,p.path));
  if(hex(raw)!==p.sha256||raw.length>32768)throw Error('unit plan page digest/size mismatch: '+p.path);
  const data=JSON.parse(raw.toString('utf8'));
  for(const u of data.units){
   if(u.initialValueRef){
    const rawValue=fs.readFileSync(repoFile(root,u.initialValueRef));
    if(hex(rawValue)!==u.initialValueSha256)throw Error('unit prefill digest mismatch');
    u.initialValue=readPagedPrefillV1(root,u.initialValueRef,rawValue);
   }
   if(u.issuedMetaRef){
    const raw=fs.readFileSync(repoFile(root,u.issuedMetaRef));
    if(hex(raw)!==u.issuedMetaSha256)
     throw Error('issued roster metadata changed after delivery: '+u.unitId);
    u.issuedMeta=readPagedPrefillV1(root,u.issuedMetaRef,raw);
   }
   if(u.kind==='BATCH'){
    if(!u.membersRef||u.membersRef!==u.packetPath)throw Error('missing batch assignment manifest');
    const raw=fs.readFileSync(repoFile(root,u.membersRef));
    if(hex(raw)!==u.packetSha256)throw Error('batch packet digest mismatch');
    const payload=readPagedPrefillV1(root,u.membersRef,raw);
    if(payload.unitId!==u.unitId||payload.phaseSequence!==phase||
       payload.schemaVersion!=='curveyield-lite-solo-batched-assignment-v1'||
       !Array.isArray(payload.members)||payload.members.length<2)
      throw Error('invalid batch assignment payload');
    u.members=payload.members;
   }
   units.push(u);
  }
 }
 if(units.length!==index.unitCount)throw Error('missing unit plan pages');
 const ownership={};
 for(const u of units){
  for(const m of u.kind==='BATCH'?u.members:[u]){
   if(!m.path)continue;
   const key=m.kind==='APPEND'?dot([...m.path,'APPEND']):
    Number.isInteger(m.recordIndex)?dot([...m.path,String(m.recordIndex)]):null;
   if(!key)continue;
   if(ownership[key])throw Error('duplicate canonical unit owner: '+key);
   ownership[key]=u.unitId;
  }
 }
 for(const u of units){
  for(const key of ['packetPath','packetIndexPath','shardPath','membersRef','initialValueRef'])
   if(typeof u[key]==='string')u[key]=canonical(u[key]);
 }
 return {...index,campaignPath:campaign,units,recordOwnership:ownership};
}
function publishPlan(root,campaign,phase,plan,queue){
 assertPlan(queue,plan);
 const planDir=path.posix.join(rootOf(campaign,phase),'plan');
 const pages=[];let batch=[];
 const flush=()=>{
  if(!batch.length)return;
  const rel=path.posix.join(planDir,'UNIT_PLAN_PAGE_'+String(pages.length+1).padStart(4,'0')+'_v1.json');
  const payload={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:batch};
  const raw=pretty(payload);
  if(Buffer.byteLength(raw)>32768)throw Error('unit plan page exceeds 32 KiB');
  put(root,rel,payload);pages.push({path:rel,sha256:hex(Buffer.from(raw)),count:batch.length});batch=[];
 };
 for(const unit of plan.units){
  const u=clone(unit);
  // The original metadata remains in the paged-prefill format.
  delete u.issuedMeta;
  if(u.kind==='BATCH'){
   if(!u.membersRef||!u.packetPath||!u.members?.length)throw Error('invalid batch plan serialization');
   delete u.members;
  }
  if(Buffer.byteLength(pretty(u))>12000&&u.initialValue!==undefined){
   const rel=path.posix.join(unitBase(campaign,phase,u.unitId),'UNIT_PREFILL_v1.json');
   const manifest=writePagedPrefillV1(root,rel,u.initialValue);
   u.initialValueRef=rel;u.initialValueSha256=sha(manifest);delete u.initialValue;
  }
  const trial={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:[...batch,u]};
  if(batch.length&&Buffer.byteLength(pretty(trial))>30000)flush();
  batch.push(u);
 }
 flush();
 const {units,recordOwnership,...metadata}=plan;
 put(root,planRel(campaign,phase),{...metadata,unitCount:units.length,pages});
 put(root,queueRel(campaign,phase),queue);
}
// Issued answer bindings are campaign data: preserve their original bytes
// when the executable Contract-Automation branch is upgraded.
export function freezeIssuedUnitMetaV1({root,campaignPath,phase,issued=[]}){
 if(!issued.length)return false;
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 assertPlan(queue,plan);
 const lookup=new Map(plan.units.map(u=>[u.unitId,u]));
 let changed=false;
 for(const {unitId,meta} of issued){
  const u=lookup.get(unitId);
  if(!u)throw Error('issued metadata references unknown unit '+unitId);
  if(u.issuedMetaRef)continue;
  const rel=path.posix.join(unitBase(campaignPath,phase,unitId),'ISSUED_META_v1.json');
  const manifest=writePagedPrefillV1(root,rel,meta);
  u.issuedMetaRef=rel;u.issuedMetaSha256=sha(manifest);
  changed=true;
 }
 if(changed)publishPlan(root,campaignPath,phase,plan,queue);
 return changed;
}
export function createUnitPlanV1({root,campaignPath,directory,phase,automationRoot=process.cwd()}){
 assertParallelSolo(directory,phase);
 const existing=maybe(root,queueRel(campaignPath,phase));
 if(existing)return existing;
 const plan=emptyPlan(directory,phase),queue=emptyQueue(plan);
 if(phase===4){
  const rel=reviewInventoryRelV1(root,campaignPath,'FLOW_PLAN_v1.json'),flow=read(root,rel);
  const units=[...asArray(flow.payload?.reviewUnits),...asArray(flow.payload?.attackUnits)];
  // Worker owns inventory quality assessment; preserve actual gaps as diagnostics.
  if(asArray(flow.payload?.gaps).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code)))
   plan.githubDiagnostics=[...(plan.githubDiagnostics??[]),'PHASE4_REVIEW_INVENTORY_INCOMPLETE'];
  // With no worker-issued units there are no submissions to package.
  if(!units.length)throw Error('AWAITING_WORKER_ISSUED_PHASE4_UNITS');
  const fIds=units.filter(u=>u.unitId.startsWith('F-')||u.unitId.startsWith('R-')).map(u=>u.unitId);
  for(const u of units){
   if(!/^[FRX]-\d{3}$/.test(u.unitId))throw Error('unsupported discovery unit '+u.unitId);
   const packet=buildUnitPacketV1({root,campaignPath,directory,authorityRoot:authorityFor(directory),
    automationRoot,unitId:u.unitId,state:null,now:new Date().toISOString(),persist:true});
   const packetRel=path.posix.join(campaignPath,'work/phase-04/discovery',u.unitId,'ASSIGNMENT_PACKET_v1.json');
   const idx=writeUnitPacketIndexV1({root,campaignPath,unitId:u.unitId,role:u.unitId.startsWith('X-')?'ATTACK':'FLOW_REVIEW'});
   addUnit(plan,queue,{unitId:u.unitId,kind:u.unitId.startsWith('X-')?'ATTACK':'FLOW',
    dependencies:u.unitId.startsWith('X-')?fIds:[],
    packetPath:packetRel,packetIndexPath:idx,packetSha256:hex(fs.readFileSync(repoFile(root,packetRel))),
    unitSpecRevision:1});
  }
 }else addShardUnits({root,campaignPath,directory,phase,plan,queue});
 queue.newlyEligibleUnitIds=plan.units.filter(x=>queue.units[x.unitId].status==='AVAILABLE').map(x=>x.unitId);
 publishPlan(root,campaignPath,phase,plan,queue);
 directory.unitQueueIndexPath=planRel(campaignPath,phase);
 directory.unitQueueStatePath=queueRel(campaignPath,phase);
 if(directory.currentAssignment?.phaseSequence===phase){
  directory.currentAssignment.unitQueueIndexPath=directory.unitQueueIndexPath;
  directory.currentAssignment.unitQueueStatePath=directory.unitQueueStatePath;
 }
 directory.executionModel='PARALLEL_WORKER_UNITS';
 return queue;
}

function consolidateNewSemanticUnitsV1({root,campaignPath,phase,plan,queue}){
 const proposed=planSemanticBatchesV1(plan.units,phase);
 const selected=proposed.batches.filter(b=>b.members.length>1);
 if(!selected.length)return;
 const replacements=new Map(),removed=new Set(),serial={};
 for(const group of selected){
  const family=group.members[0].unitId.replace(/-[0-9]+$/,'');
  const number=(serial[family]??0)+1;serial[family]=number;
  const id=family+'-B'+String(number).padStart(4,'0');
  if(queue.units[id])throw Error('batched unit identity collision: '+id);
  if(group.members.some(m=>!['AVAILABLE','BLOCKED_DEPENDENCY'].includes(queue.units[m.unitId]?.status)))
   throw Error('cannot rebatch an already claimed, submitted or accepted unit');
  const payload={schemaVersion:'curveyield-lite-solo-batched-assignment-v1',unitId:id,
   phaseSequence:phase,field:group.field,groupKeys:group.groupKeys,members:group.members,
   readingGuide:SEMANTIC_BATCH_READING_GUIDE_V1};
  const packetPath=path.posix.join(unitBase(campaignPath,phase,id),'ASSIGNMENT_PACKET_v1.json');
  const manifest=writePagedPrefillV1(root,packetPath,payload);
  const spec={unitId:id,kind:'BATCH',field:group.field,members:group.members,
   memberUnitIds:group.memberUnitIds,recordCount:group.members.length,
   membersRef:packetPath,packetPath,packetSha256:sha(manifest),
   dependencies:[...new Set(group.members.flatMap(m=>asArray(m.dependencies)))],
   unitSpecRevision:1};
  replacements.set(group.members[0].unitId,spec);
  for(const m of group.members){
   removed.add(m.unitId);delete queue.units[m.unitId];
   plan.recordOwnership[dot([...m.path,String(m.recordIndex)])]=id;
  }
  addUnit(plan,queue,spec);
 }
 const original=plan.units.filter(u=>!removed.has(u.unitId)&&u.kind!=='BATCH');
 plan.units.splice(0,plan.units.length,...original,...replacements.values());
}

function addShardUnits({root,campaignPath,directory,phase,plan,queue}){
 const idxRel=directory.currentAssignment?.workShardIndexPath;
 if(!idxRel)throw Error('missing canonical semantic shard index');
 const index=read(root,idxRel),dir=path.posix.dirname(idxRel);
 if(index.phase!==phase)throw Error('shard phase mismatch');
 const descriptors=asArray(index.pages).flatMap(p=>asArray(read(root,path.posix.join(dir,p.file)).shards));
 const serial={};
 // One monotonic namespace per semantic unit family, including related fields.
 const nextId=field=>{
  const family=rowId(phase,field,0).slice(0,-4);
  const index=serial[family]??0;
  serial[family]=index+1;
  return rowId(phase,field,index);
 };
 for(const d of descriptors){
  const field=d.path?.at(-1);
  if(!field)throw Error('missing work shard field');
  // Controller-owned machine-derived limitation/omission fields are not worker-editable.
  if(phase===6&&['typedExecutionLimitations','fullOnlyOmissions'].includes(field))continue;
  const slab=read(root,path.posix.join(dir,d.file));
  const slabPacketSha256=hex(fs.readFileSync(repoFile(root,path.posix.join(dir,d.file))));
  if(d.append){
   const id=nextId(field),ownership=dot([...d.path,'APPEND']);
   if(plan.recordOwnership[ownership])throw Error('duplicate canonical append owner: '+ownership);
   plan.recordOwnership[ownership]=id;
   const unit={unitId:id,kind:'APPEND',field,shardFile:d.file,shardIndex:0,
    shardPath:path.posix.join(dir,d.file),
    packetSha256:slabPacketSha256,
    recordKeys:[],path:d.path,dependencies:[],unitSpecRevision:1};
   addUnit(plan,queue,unit);continue;
  }
  for(let n=0;n<slab.entries.length;n++){
   const entry=slab.entries[n],id=nextId(field);
   const ownership=dot([...d.path,String(d.startIndex+n)]);
   if(plan.recordOwnership[ownership])throw Error('duplicate canonical record owner: '+ownership);
   plan.recordOwnership[ownership]=id;
   addUnit(plan,queue,{unitId:id,kind:'SHARD',field,shardFile:d.file,
    shardPath:path.posix.join(dir,d.file),
    packetSha256:slabPacketSha256,
    shardIndex:n,recordIndex:d.startIndex+n,
    recordKeys:[entry.key],initialValue:entry.value,path:d.path,
    dependencies:[],unitSpecRevision:1});
  }
 }
 // Preserve semantic prerequisites: target design requires its related reconciliation row,
 // not a blanket dependency on every economic or reconciliation unit.
 if(phase===5){
  const reconc=plan.units.filter(u=>u.field==='reconciliationRecords');
  const novel=plan.units.filter(u=>u.field==='newCandidateRecords');
  const economic=plan.units.filter(u=>u.field==='economicReviewRecords');
  for(const u of plan.units.filter(u=>u.field==='targetDesigns')){
   const candidate=u.initialValue?.candidateKey;
   const linkedEconomic=economic.filter(row=>candidate&&Array.isArray(row.initialValue?.relatedCandidateKeys)&&
    row.initialValue.relatedCandidateKeys.includes(candidate)).map(row=>row.unitId);
   const reconciled=u.kind==='APPEND'?novel.map(row=>row.unitId):
    reconc.filter(row=>candidate&&row.initialValue?.subjectKey===candidate).map(row=>row.unitId);
   u.dependencies=[...new Set([...reconciled,...linkedEconomic])];
  }
 }
 if(phase===6){
  const interpretations=plan.units.filter(u=>['deploymentAssessments','targetDispositions'].includes(u.field));
  const proofs=plan.units.filter(u=>['baselineTestRecords','candidateProofRecords','newCandidateRecords'].includes(u.field));
  // A merged conclusion is global, but obligation rows depend only on matching baseline groups.
  const allPrerequisites=[...interpretations,...proofs].map(u=>u.unitId);
  for(const u of plan.units.filter(u=>u.field==='mergedExecutionConclusions'))
   u.dependencies=allPrerequisites;
  for(const u of plan.units.filter(u=>u.field==='obligationDispositions')){
   const obligationId=u.initialValue?.obligationId;
   u.dependencies=u.kind==='APPEND'?[]:proofs.filter(p=>
    p.field==='baselineTestRecords'&&Array.isArray(p.initialValue?.obligationIds)&&
    p.initialValue.obligationIds.includes(obligationId)).map(p=>p.unitId);
  }
 }
 consolidateNewSemanticUnitsV1({root,campaignPath,phase,plan,queue});
 // Only newly issued available semantic units may transition to dependency-blocked.
 // Reconciliation must never reset persisted ACCEPTED discovery units.
 for(const u of plan.units)if(u.dependencies.length&&queue.units[u.unitId]?.status==='AVAILABLE')
  queue.units[u.unitId].status='BLOCKED_DEPENDENCY';
 const memberIds=new Set(plan.units.flatMap(u=>u.kind==='BATCH'?u.memberUnitIds:[]));
 const missing=new Set(plan.units.flatMap(x=>x.dependencies).filter(id=>!queue.units[id]&&!memberIds.has(id)));
 if(missing.size)throw Error('unsatisfied planner unit references: '+[...missing].join(', '));
}
function validateRequest(request,directory,phase){
 if(request?.schemaVersion!==REQUEST_SCHEMA||!['CLAIM','SUBMIT','RELEASE','FINALIZE'].includes(request.operation))
  throw Error('unsupported v4 request shape/operation');
 for(const key of ['requestId','workerId'])if(!safe(request[key]))throw Error('unsafe '+key);
 if(request.lane!=='AUTO'&&!safe(request.lane))throw Error('invalid lane');
 const common=['schemaVersion','requestId','operation','campaignId','campaignGenerationId','phaseSequence',
  'lane','workerId','sourceSha256','authorityDigest','phaseEpoch','auditControllerRef'];
 const operationFields={
  CLAIM:['desiredUnitCount'],SUBMIT:['items'],RELEASE:['items'],FINALIZE:[]
 };
 const allowed=new Set([...common,...operationFields[request.operation]]);
 for(const key of Object.keys(request))if(!allowed.has(key))throw Error('unexpected controller/request field: '+key);
 assertParallelSolo(directory,phase,request);
 if(request.operation==='CLAIM'){
  if((!Number.isSafeInteger(request.desiredUnitCount)||
    request.desiredUnitCount<1||request.desiredUnitCount>UNIT_POLICY.issueBatchMax)||request.items!==undefined)
   throw Error('CLAIM must request 1–50 units and omit items');
 }else if(request.operation==='SUBMIT'){
  if(!Array.isArray(request.items)||request.items.length<1||request.items.length>UNIT_POLICY.approvalBatchMax)
   throw Error('SUBMIT must explicitly name 1–5 items');
  if(request.items.some(x=>!isObject(x)))throw Error('SUBMIT items must be objects');
  if(new Set(request.items.map(x=>x.unitId)).size!==request.items.length)throw Error('duplicate SUBMIT unit');
  const required=['unitId','claimEpoch','claimToken','packetSha256','submissionPath',
   'submissionSha256','unitSpecRevision'];
  if(request.items.some(x=>!isObject(x)||Object.keys(x).length!==required.length||
    required.some(key=>!Object.hasOwn(x,key))||
    !safe(x.unitId)||!Number.isSafeInteger(x.claimEpoch)||x.claimEpoch<1||
    !safe(x.claimToken)||!Number.isSafeInteger(x.unitSpecRevision)||x.unitSpecRevision<1||
    !/^[0-9a-f]{64}$/.test(String(x.packetSha256??''))||
    !/^[0-9a-f]{64}$/.test(String(x.submissionSha256??''))||
    typeof x.submissionPath!=='string'||x.submissionPath.length>1024||
    x.submissionPath.startsWith('/')||x.submissionPath.split('/').includes('..')))
   throw Error('SUBMIT item identity, revision, path or hash is malformed');
 }else if(request.operation==='RELEASE'){
  if(!Array.isArray(request.items)||!request.items.length||
    request.items.some(x=>!isObject(x))||
    new Set(request.items.map(x=>x.unitId)).size!==request.items.length||
    request.items.some(x=>Object.keys(x).length!==3||
      !Object.hasOwn(x,'unitId')||!Object.hasOwn(x,'claimEpoch')||
      !Object.hasOwn(x,'claimToken')||!safe(x.unitId)||
      !Number.isSafeInteger(x.claimEpoch)||x.claimEpoch<1||!safe(x.claimToken)))
   throw Error('RELEASE must list only complete distinct owned tokens');
 }else if(request.operation==='FINALIZE'&&
  (request.workerId!=='lite-solo-controller'||request.lane!=='AUTO'))
  throw Error('only the controller may finalize the current phase with AUTO lane');
}
function available(queue,plan,lane='AUTO'){
 return plan.units.filter(u=>['AVAILABLE','RELEASED'].includes(queue.units[u.unitId]?.status)&&depSatisfied(queue,u)
  &&(lane==='AUTO'||u.unitId.startsWith(lane+'-')));
}
function unlock(queue,plan){
 const newIds=[];
 for(const u of plan.units){
  const state=queue.units[u.unitId];
  if(state.status==='BLOCKED_DEPENDENCY'&&depSatisfied(queue,u)){
   state.status='AVAILABLE';newIds.push(u.unitId);
  }
 }
 queue.newlyEligibleUnitIds=newIds;return newIds;
}
// Recover historical Phase-4 discovery units whose ACCEPTED state was overwritten by
// reconciliation dependency setup. Restore only the original controller-accepted,
// source/authority-bound immutable snapshots; never infer acceptance from a worker draft.
function restoreAcceptedDiscoveryV1({root,queue,plan}){
 if(queue.stage!=='RECONCILIATION'||plan.phaseSequence!==4)return [];
 const restored=[];
 for(const u of plan.units){
  if(!['FLOW','ATTACK'].includes(u.kind))continue;
  const state=queue.units[u.unitId];
  if(!state||state.status==='ACCEPTED'||!['AVAILABLE','BLOCKED_DEPENDENCY'].includes(state.status)||
     !state.acceptedPath||!state.acceptedSha256)continue;
  const accepted=read(root,state.acceptedPath);
  if(accepted.schemaVersion!==UNIT_ARTIFACT_SCHEMAS.accepted||accepted.unitId!==u.unitId||
     accepted.phaseSequence!==4||accepted.phaseEpoch!==queue.phaseEpoch||
     accepted.campaignGenerationId!==queue.campaignGenerationId||
     accepted.sourceSha256!==queue.sourceSha256||accepted.authorityDigest!==queue.authorityDigest||
     accepted.unitSpecRevision!==u.unitSpecRevision||
     accepted.packetSha256!==u.packetSha256||
     accepted.workerId!==state.workerId||accepted.claimEpoch!==state.claimEpoch||
     accepted.submissionSha256!==state.acceptedSha256||
     accepted.submission?.unitId!==u.unitId)
   throw Error('accepted discovery recovery identity mismatch: '+u.unitId);
  state.status='ACCEPTED';restored.push(u.unitId);
 }
 return restored;
}
function noWork(queue,plan){
 if(plan.units.every(u=>queue.units[u.unitId].status==='ACCEPTED'))return 'PHASE_COMPLETE';
 if(plan.units.some(u=>queue.units[u.unitId].status==='REWORK_REQUIRED'))return 'AWAITING_WORKER_SUBMISSION';
 // Pending approval and already-held independent work are actionable distinctions.
 // Dependencies are reported only when no pending approval or in-flight claim exists.
 if(plan.units.some(u=>queue.units[u.unitId].status==='SUBMITTED'))return 'AWAITING_APPROVAL';
 if(plan.units.some(u=>queue.units[u.unitId].status==='CLAIMED'))return 'ALL_WORK_CLAIMED';
 if(plan.units.some(u=>queue.units[u.unitId].status==='BLOCKED_DEPENDENCY'))return 'AWAITING_WORKER_SUBMISSION';
 return 'NO_ELIGIBLE_WORK';
}
function batchIndex(root,campaign,phase,requestId,units){
 const dir=path.posix.join(rootOf(campaign,phase),'claims',requestId);
 const pages=[];
 for(let i=0;i<units.length;i+=4){
  const file='BATCH_PAGE_'+String(pages.length+1).padStart(4,'0')+'_v1.json';
  const rel=path.posix.join(dir,file);
  const page={schemaVersion:'curveyield-lite-solo-unit-batch-page-v1',
   units:units.slice(i,i+4)};put(root,rel,page);
  if(Buffer.byteLength(pretty(page))>32768)throw Error('claim index exceeds 32 KiB');
  pages.push({path:rel,sha256:sha(page)});
 }
 const index={schemaVersion:'curveyield-lite-solo-unit-batch-index-v1',
  count:units.length,pages,readingGuide:'Read claimed packetPath and verify packetSha256. BATCH packets are paged prefill manifests: reconstruct the value from digest-checked prefill-pages, preserve each member recordKeys[0] as entries[].key, and submit one multi-entry snapshot under the batch claim. Rework only outstanding member records; accepted siblings remain immutable. For other units use the original one-record form. Commit source/authority-bound immutable worker/claim-epoch/attempt submissions and enqueue 1–5-unit SUBMIT requests. Claim at most 50; only persisted accepted original records unlock dependents.'};
 const rel=path.posix.join(dir,'BATCH_INDEX_v1.json');put(root,rel,index);
 return rel;
}
// Reclaimed units must refer to the original issued bytes, not a shard that
// has been updated by a prior assembly. New units retain the frozen plan SHA.
function issuedPacketDigestForClaimV1({root,campaign,phase,queue,plan,u,state}){
 if(typeof u.packetSha256==='string')return u.packetSha256;
 const prefix=unitBase(campaign,phase,u.unitId)+'/';
 if(typeof state?.acceptedPath==='string'&&state.acceptedPath.startsWith(prefix)){
  try{
   const prior=read(root,state.acceptedPath);
   if(prior.unitId===u.unitId&&
      prior.campaignGenerationId===plan.campaignGenerationId&&
      prior.sourceSha256===plan.sourceSha256&&
      prior.authorityDigest===plan.authorityDigest&&
      prior.phaseSequence===phase&&prior.phaseEpoch===queue.phaseEpoch&&
      prior.unitSpecRevision===u.unitSpecRevision&&
      prior.submissionSha256===state.acceptedSha256&&
      /^[a-f0-9]{64}$/.test(String(prior.packetSha256??'')))
    return prior.packetSha256;
  }catch{/* The original packet is not available for this claim. */}
 }
 return hex(fs.readFileSync(repoFile(root,u.packetPath??u.shardPath)));
}
function handleClaim({root,campaign,phase,queue,plan,request}){
 const held=Object.values(queue.units).filter(u=>u.workerId===request.workerId&&u.status==='CLAIMED').length;
 const capacity=Math.max(0,UNIT_POLICY.issueBatchMax-held);
 const eligible=available(queue,plan,request.lane),selected=eligible.slice(0,Math.min(capacity,request.desiredUnitCount));
 const units=selected.map(u=>{
  const state=queue.units[u.unitId];state.status='CLAIMED';state.workerId=request.workerId;
  state.claimEpoch++;state.claimToken=randomUUID();
  return {unitId:u.unitId,claimEpoch:state.claimEpoch,claimToken:state.claimToken,
   packetPath:u.packetPath??u.shardPath,packetIndexPath:u.packetIndexPath??null,
   packetSha256:issuedPacketDigestForClaimV1({root,campaign,phase,queue,plan,u,state}),
   unitSpecRevision:u.unitSpecRevision};
 });
 const claimId=units.length?'claim-'+request.requestId:null;
 return {status:units.length?'CLAIMED':capacity===0?'WORKER_CLAIM_LIMIT_REACHED':noWork(queue,plan),
  claimId,claimedUnits:units,
  batchIndexPath:units.length?batchIndex(root,campaign,phase,request.requestId,units):null};
}
function itemIdentity(item,u,state,request,root,campaign,phase){
 if(!u||!state)return 'WAITING_SUBMISSION';
 // An accepted snapshot is immutable even when a later attempt arrives.
 if(state.status==='ACCEPTED')
  return state.acceptedSha256===item.submissionSha256?'UNCHANGED':'STALE';
 if(state.workerId!==request.workerId||
    item.claimEpoch!==state.claimEpoch||item.claimToken!==state.claimToken||
    item.unitSpecRevision!==u.unitSpecRevision||
    !['CLAIMED','SUBMITTED','REWORK_REQUIRED'].includes(state.status))return 'STALE';
 const packetRel=u.packetPath??u.shardPath;
 const livePacketSha256=u.packetSha256??hex(fs.readFileSync(repoFile(root,packetRel)));
 let packetBound=item.packetSha256===livePacketSha256;
 if(!packetBound&&state.acceptedPath&&state.acceptedSha256){
  const previous=maybe(root,state.acceptedPath);
  packetBound=previous?.unitId===u.unitId&&
   previous.campaignGenerationId===request.campaignGenerationId&&
   previous.sourceSha256===request.sourceSha256&&
   previous.authorityDigest===request.authorityDigest&&
   previous.phaseSequence===request.phaseSequence&&
   previous.phaseEpoch===request.phaseEpoch&&
   previous.unitSpecRevision===u.unitSpecRevision&&
   previous.packetSha256===item.packetSha256&&
   previous.submissionSha256===state.acceptedSha256;
 }
 if(!packetBound)return 'STALE';
 const allowed=path.posix.join(unitBase(campaign,phase,u.unitId),
   'submissions',request.workerId,'epoch-'+state.claimEpoch);
 const name=typeof item.submissionPath==='string'&&item.submissionPath.startsWith(allowed+'/')
   ?item.submissionPath.slice(allowed.length+1):'';
 if(!/^(?:controller-compiled\/)?SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(name))
  return 'STALE';
 const file=repoFile(root,item.submissionPath);
 if(!fs.existsSync(file))return 'WAITING_SUBMISSION';
 return hex(fs.readFileSync(file))===item.submissionSha256?null:'STALE';
}
// No security or semantic submission validation is performed by GitHub.
// This function remains only for compatibility with existing callers.
function validateShardUnit(){return [];}
// Exact issued record identities are part of the controller's packaging
// contract. These checks do not judge any security finding or AI conclusion.
function assertSubmissionEnvelopeV1(u,submission){
 if(!submission||typeof submission!=='object'||Array.isArray(submission))
  throw Error('submission is not a JSON object');
 if(u.kind==='FLOW'||u.kind==='ATTACK'){
  const schema=u.kind==='FLOW'?'curveyield-flow-review-submission-v1':
   'curveyield-attack-submission-v1';
  if(submission.schemaVersion!==schema||submission.unitId!==u.unitId)
   throw Error('discovery submission does not match the issued unit');
  return;
 }
 if(submission.schemaVersion!=='curveyield-lite-solo-unit-submission-v1'||
    !Array.isArray(submission.entries))
  throw Error('semantic submission envelope does not match the issued schema');
 const entries=submission.entries;
 if(entries.some(x=>!x||typeof x!=='object'||typeof x.key!=='string'||
    !Object.hasOwn(x,'value'))||
    new Set(entries.map(x=>x.key)).size!==entries.length)
  throw Error('duplicate or malformed issued record identities');
 if(u.kind==='SHARD'){
  if(entries.length!==1||entries[0].key!==u.recordKeys?.[0])
   throw Error('fixed record identity or count differs from issued shard');
 }else if(u.kind==='BATCH'){
  const expected=u.members.map(x=>x.recordKeys?.[0]);
  if(entries.length!==expected.length||
     entries.some(x=>!expected.includes(x.key)))
   throw Error('batch record identity/count differs from issued members');
 }else if(u.kind==='APPEND'){
  if(entries.length>1024)throw Error('APPEND exceeds controller file capacity');
  const root=JSON.stringify(u.path)+':APPEND-';
  for(let i=0;i<entries.length;i++)
   if(entries[i].key!==root+String(i+1).padStart(4,'0'))
    throw Error('APPEND changed its controller-assigned record identity');
 }
}
function acceptBatchRecordsV1({root,campaign,phase,u,submission,queue,plan,state,request,digest}){
 // Retain exactly the records MiMo supplied, in Worker-issued member order.
 // Missing records are never fabricated or pronounced correct by GitHub.
 const entries=Array.isArray(submission?.entries)?submission.entries:[];
 const ordered=u.members.flatMap(member=>entries.filter(entry=>entry?.key===member.recordKeys?.[0]));
 const refs=[];queue.acceptedRecords??={};
 for(const member of u.members){
  const entry=ordered.find(item=>item?.key===member.recordKeys?.[0]);
  if(!entry)continue;
  const rel=path.posix.join(unitBase(campaign,phase,u.unitId),'records',member.unitId,
   'ACCEPTED_ATTEMPT_'+String(state.attempts+1).padStart(3,'0')+'_v1.json');
  const snapshot={schemaVersion:'curveyield-lite-solo-accepted-record-v1',unitId:u.unitId,
   memberUnitId:member.unitId,recordKey:entry.key,campaignGenerationId:plan.campaignGenerationId,
   sourceSha256:plan.sourceSha256,authorityDigest:plan.authorityDigest,phaseSequence:phase,
   phaseEpoch:plan.phaseEpoch,claimEpoch:state.claimEpoch,workerId:request.workerId,
   submissionSha256:digest,prerequisiteEvidence:prerequisiteEvidence(queue,member.dependencies),
   entry,validationDelegatedTo:'CLOUDFLARE_WORKER'};
  put(root,rel,snapshot);
  queue.acceptedRecords[member.unitId]={status:'ACCEPTED',path:rel,
   snapshotSha256:sha(snapshot),parentUnitId:u.unitId};refs.push(rel);
 }
 return {errors:[],assembledSubmission:{
  schemaVersion:UNIT_ARTIFACT_SCHEMAS.submission,entries:ordered},recordEvidenceRefs:refs};
}
function acceptSubmission({root,campaign,phase,request,item,queue,plan,directory}){
 const u=plan.units.find(x=>x.unitId===item.unitId),state=queue.units[item.unitId];
 if(!u||!state)return {unitId:item.unitId,status:'WAITING_SUBMISSION',errors:[]};
 const file=repoFile(root,item.submissionPath);
 if(!fs.existsSync(file)){state.status='SUBMITTED';return {unitId:item.unitId,status:'WAITING_SUBMISSION',errors:[]};}
 const raw=fs.readFileSync(file),digest=hex(raw);
 if(digest!==item.submissionSha256)return {unitId:item.unitId,status:'STALE'};
 // JSON parsing is transport decoding only; no schema, security or content checks.
 const submission=JSON.parse(raw.toString('utf8'));
 assertSubmissionEnvelopeV1(u,submission);
 let batchOutcome=null;
 if(u.kind==='BATCH')batchOutcome=acceptBatchRecordsV1({
  root,campaign,phase,u,submission,queue,plan,state,request,digest});
 state.status='SUBMITTED';state.lastSubmissionSha256=digest;state.attempts++;
 const resultRel=path.posix.join(unitBase(campaign,phase,u.unitId),'results',
  'ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
 const acceptedRel=path.posix.join(unitBase(campaign,phase,u.unitId),
  'ACCEPTED_ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
 const questionLedger=questionLedgerReferenceV1({root,campaign,phase,unitId:u.unitId,directory});
 put(root,acceptedRel,{schemaVersion:'curveyield-lite-solo-accepted-unit-v1',unitId:u.unitId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  authorityDigest:directory.authorityDigest,phaseSequence:phase,phaseEpoch:request.phaseEpoch,
  unitSpecRevision:u.unitSpecRevision,packetSha256:item.packetSha256,
  workerId:request.workerId,claimEpoch:state.claimEpoch,submissionSha256:digest,
  prerequisiteEvidence:prerequisiteEvidence(queue,u.dependencies),
  submission:batchOutcome?.assembledSubmission??submission,
  ...(batchOutcome?.recordEvidenceRefs?{recordEvidenceRefs:batchOutcome.recordEvidenceRefs}:{}),
  ...(questionLedger?{questionLedger}:{}),
  validationDelegatedTo:'CLOUDFLARE_WORKER',githubContentValidationPerformed:false});
 state.status='ACCEPTED';state.acceptedSha256=digest;state.acceptedPath=acceptedRel;state.lastErrors=[];
 put(root,resultRel,{unitId:u.unitId,status:'ACCEPTED',submissionSha256:digest,
  acceptedPath:acceptedRel,validationDelegatedTo:'CLOUDFLARE_WORKER'});
 return {unitId:u.unitId,status:'ACCEPTED',resultRef:resultRel};
}
function handleSubmit({root,campaign,phase,queue,plan,request,directory}){
 const items=[];
 for(const item of request.items){
  const state=queue.units[item.unitId],u=plan.units.find(x=>x.unitId===item.unitId);
  try{
   const identity=itemIdentity(item,u,state,request,root,campaign,phase);
   if(identity){
    if(identity==='WAITING_SUBMISSION'&&state?.workerId===request.workerId)
     state.status='SUBMITTED';
    items.push({unitId:item.unitId,status:identity});
    continue;
   }
   if(state.status==='CLAIMED')state.status='SUBMITTED';
   items.push(acceptSubmission({root,campaign,phase,request,item,queue,plan,directory}));
  }catch(e){
   const reason=String(e.message??e);
   // A transport failure must retain the original claim, not produce acceptance.
   if(state&&state.workerId===request.workerId&&
      state.claimEpoch===item.claimEpoch&&state.claimToken===item.claimToken){
    state.status='SUBMITTED';state.lastErrors=[reason];
   }
   items.push({unitId:item.unitId,status:'WAITING_SUBMISSION',transportError:reason});
  }
 }
 const newlyEligibleUnits=unlock(queue,plan);
 return {status:'SUBMISSION_RECORDED',acceptedUnits:items.filter(x=>x.status==='ACCEPTED').map(x=>x.unitId),
  reworkUnits:items.filter(x=>x.status==='REWORK_REQUIRED'),
  staleUnits:items.filter(x=>x.status==='STALE'),unchangedUnits:items.filter(x=>x.status==='UNCHANGED'),
  waitingUnits:items.filter(x=>x.status==='WAITING_SUBMISSION'),newlyEligibleUnits};
}
function handleRelease({queue,plan,request}){
 const changed=[];
 for(const item of request.items){
  const s=queue.units[item.unitId];
  if(!s||s.workerId!==request.workerId||s.claimEpoch!==item.claimEpoch||
   s.claimToken!==item.claimToken||s.status==='ACCEPTED')continue;
  // Preserve drafts and the previous epoch while making this unit eligible again.
  // The next claim increments the epoch, invalidating the released owner's token.
  s.status='RELEASED';s.workerId=null;s.claimToken=null;changed.push(item.unitId);
 }
 const unblocked=unlock(queue,plan);
 queue.newlyEligibleUnitIds=[...new Set([...changed,...unblocked])];
 return {status:'RELEASED',releasedUnits:changed,newlyEligibleUnits:queue.newlyEligibleUnitIds};
}
function discoveryInput(root,campaign,name){return read(root,reviewInventoryRelV1(root,campaign,name));}
function finishDiscovery({root,campaign,directory,plan,queue,automationRoot}){
 const items=plan.units.filter(u=>['FLOW','ATTACK'].includes(u.kind));
 if(!items.every(u=>queue.units[u.unitId]?.status==='ACCEPTED'))return false;
 if(queue.stage==='RECONCILIATION')return true;
 const state={schemaVersion:'curveyield-discovery-state-v1',campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  generatedAt:new Date().toISOString(),payload:{reviewPolicy:'correctness-verdict-v13',gaps:asArray(discoveryInput(root,campaign,'FLOW_PLAN_v1.json').payload?.gaps)}};
 const acceptedSubmissions=items.map(u=>({unitId:u.unitId,
  submission:read(root,queue.units[u.unitId].acceptedPath).submission}));
 const inventory=discoveryInput(root,campaign,'REVIEW_INVENTORY_v1.json');
 const summary=buildDiscoverySummaryV1({state,inventory,plan:discoveryInput(root,campaign,'FLOW_PLAN_v1.json'),
  acceptedSubmissions,taxonomy:loadTaxonomyV1(automationRoot),now:new Date().toISOString()});
 put(root,path.posix.join(campaign,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json'),summary);
 put(root,path.posix.join(campaign,'work/phase-06/BASELINE_OBLIGATIONS_v1.json'),
  deriveBaselineObligationsV1({inventory,taxonomy:loadTaxonomyV1(automationRoot),summary}));
 // The original phase prefill is authoritative; refresh once, after complete discovery.
 const assignment=directory.currentAssignment;
 const form={...read(root,path.posix.join(authorityFor(directory),'phases/phase-4/resources/PHASE_04_WORK_FORM_TEMPLATE_v1.json'))};
 const updated=applyPhaseBoundaryPrefill({root,campaignPath:campaign,authorityRoot:authorityFor(directory),sequence:4,
  form,derivedInputPaths:[...asArray(assignment.derivedInputPaths),path.posix.join(campaign,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json')],
  predecessorReceiptPath:assignment.predecessorReceiptPath});
 put(root,assignment.workFormPath,updated);
 const shards=secureShardWorkFormV13({root,formRel:assignment.workFormPath,phase:4,retireFull:true});
 assignment.workShardIndexPath=shards.indexRel;
 assignment.controllerPrefillDigestSha256=updated.automationInputs?.controllerPrefillDigestSha256;
 addShardUnits({root,campaignPath:campaign,directory,phase:4,plan,queue});
 queue.stage='RECONCILIATION';plan.stage='RECONCILIATION';
 unlock(queue,plan);return true;
}
export function processUnitRequestV1({root,campaignPath,directory,request,automationRoot=process.cwd(),trustedController=false}){
 // A worker-origin GitHub request must never become a controller-origin FINALIZE.
 if(request?.operation==='FINALIZE'&&!trustedController)
  throw Error('FINALIZE is controller-internal and cannot be queued by a worker');
 const phase=request.phaseSequence;validateRequest(request,directory,phase);
 let queue=maybe(root,queueRel(campaignPath,phase));
 if(!queue)queue=createUnitPlanV1({root,campaignPath,directory,phase,automationRoot});
 const plan=readPlan(root,campaignPath,phase);assertPlan(queue,plan);
 const recoveredDiscoveryUnits=restoreAcceptedDiscoveryV1({root,queue,plan});
 const requestDigest=sha(request);
 if(queue.processedRequestHashes?.[request.requestId]&&
    queue.processedRequestHashes[request.requestId]!==requestDigest)
  throw Error('request ID reused with different immutable content');
 if(queue.processedRequests[request.requestId])return queue.processedRequests[request.requestId];
 let result;
 if(request.operation==='CLAIM')result=handleClaim({root,campaign:campaignPath,phase,queue,plan,request});
 else if(request.operation==='SUBMIT')result=handleSubmit({root,campaign:campaignPath,phase,queue,plan,request,directory});
 else if(request.operation==='RELEASE')result=handleRelease({queue,plan,request});
 else {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;result={status:'FINALIZE_REQUESTED'};}
 if(result.acceptedUnits?.length) {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;}
 if(recoveredDiscoveryUnits.length){
  queue.newlyEligibleUnitIds=queue.newlyEligibleUnitIds.filter(id=>!recoveredDiscoveryUnits.includes(id));
  result.recoveredAcceptedDiscoveryUnits=recoveredDiscoveryUnits;
 }
 if(phase===4&&queue.stage!=='RECONCILIATION'&&
  plan.units.filter(u=>['FLOW','ATTACK'].includes(u.kind)).every(u=>queue.units[u.unitId]?.status==='ACCEPTED'))
  finishDiscovery({root,campaign:campaignPath,directory,plan,queue,automationRoot});
 const nextPhaseStatus=noWork(queue,plan);
 result={schemaVersion:UNIT_ARTIFACT_SCHEMAS.result,
  requestId:request.requestId,campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  authorityDigest:directory.authorityDigest,phaseSequence:phase,phaseEpoch:queue.phaseEpoch,
  ...result,
  acceptedUnits:result.acceptedUnits??[],reworkUnits:result.reworkUnits??[],
  staleUnits:result.staleUnits??[],unchangedUnits:result.unchangedUnits??[],
  waitingUnits:result.waitingUnits??[],newlyEligibleUnits:result.newlyEligibleUnits??[],
  nextPhaseStatus,phaseStatus:nextPhaseStatus};
 queue.revision++;
 queue.processedRequestHashes[request.requestId]=requestDigest;
 if(!asArray(result.waitingUnits).length)queue.processedRequests[request.requestId]=result;
 publishPlan(root,campaignPath,phase,plan,queue);
 directory.unitQueueIndexPath=planRel(campaignPath,phase);
 directory.unitQueueStatePath=queueRel(campaignPath,phase);
 if(directory.currentAssignment?.phaseSequence===phase){
  directory.currentAssignment.unitQueueIndexPath=directory.unitQueueIndexPath;
  directory.currentAssignment.unitQueueStatePath=directory.unitQueueStatePath;
 }
 return result;
}
function durablyAcceptedUnitV1({root,plan,queue,u}){
 const state=queue.units?.[u.unitId];
 if(state?.status!=='ACCEPTED'||!state.acceptedPath||
    !/^[a-f0-9]{64}$/.test(String(state.acceptedSha256??'')))return false;
 const prefix=path.posix.join(plan.campaignPath,'work/phase-'+
  String(plan.phaseSequence).padStart(2,'0'),'units',u.unitId)+'/';
 if(!state.acceptedPath.startsWith(prefix))return false;
 try{
  const snapshot=read(root,state.acceptedPath);
  return snapshot.unitId===u.unitId&&
   snapshot.campaignGenerationId===plan.campaignGenerationId&&
   snapshot.sourceSha256===plan.sourceSha256&&
   snapshot.authorityDigest===plan.authorityDigest&&
   snapshot.phaseSequence===plan.phaseSequence&&
   snapshot.phaseEpoch===plan.phaseEpoch&&
   snapshot.claimEpoch===state.claimEpoch&&
   snapshot.unitSpecRevision===u.unitSpecRevision&&
   snapshot.submissionSha256===state.acceptedSha256&&
   (!u.packetSha256||snapshot.packetSha256===u.packetSha256);
 }catch{return false;}
}
export function finalizeReadinessV1({root,campaignPath,directory,phase}){
 // A prior accepted file is insufficient after a unit is reopened for rework.
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 const pending=plan.units.filter(u=>!durablyAcceptedUnitV1({root,plan,queue,u}));
 if(pending.length)return {ready:false,reason:'AWAITING_DURABLY_ACCEPTED_WORKER_FILES',
  unitIds:pending.map(u=>u.unitId)};
 return {ready:true,plan,queue};
}
// Recover a controller-owned v13 index accidentally re-sharded from a previously
// assembled unit form. The immutable per-record unit plan, not reviewer data,
// fixes the original mandatory identities and APPEND boundary. Do not bypass
// the trusted-index equality checks or manufacture missing substantive records.
function restoreFrozenUnitShardIndexV1({root,campaignPath,phase,assignment,plan}){
 if(![4,5,6].includes(phase))return;
 const workDir=path.posix.dirname(assignment.workShardIndexPath);
 const trustedDir=path.posix.join(campaignPath,'controller/shards/phase-'+String(phase).padStart(2,'0'));
 const trustedRel=path.posix.join(trustedDir,'INDEX_v1.json');
 const working=read(root,assignment.workShardIndexPath),trusted=read(root,trustedRel);
 if(JSON.stringify(working)!==JSON.stringify(trusted))
  throw Error('v13 index authority mismatch before unit-plan recovery');
 const records=plan.units.flatMap(u=>u.kind==='BATCH'?u.members:[u]).filter(u=>['SHARD','APPEND'].includes(u.kind));
 let changed=false;
 for(let i=0;i<working.pages.length;i++){
  const desc=working.pages[i],pageRel=path.posix.join(workDir,desc.file);
  const trustedPageRel=path.posix.join(trustedDir,desc.file);
  const page=read(root,pageRel),trustedPage=read(root,trustedPageRel);
  if(JSON.stringify(page)!==JSON.stringify(trustedPage)||sha(page)!==desc.sha256)
   throw Error('v13 index page authority mismatch before unit-plan recovery');
  let pageChanged=false;
  for(const shard of page.shards??[]){
   if(shard.kind!=='array')continue;
   const members=records.filter(u=>u.shardFile===shard.file);
   if(!members.length)continue;
   if(shard.append){
    if(members.length!==1||members[0].kind!=='APPEND'||shard.recordKeys.length)
     throw Error('unexpected append unit-plan identity: '+shard.file);
    const expectedStart=records.filter(u=>u.kind==='SHARD'&&
     JSON.stringify(u.path)===JSON.stringify(shard.path)).length;
    if(shard.startIndex!==expectedStart){
     const slabRel=path.posix.join(workDir,shard.file),slab=read(root,slabRel);
     if(slab.startIndex!==shard.startIndex)throw Error('append shard index mismatch: '+shard.file);
     shard.startIndex=expectedStart;slab.startIndex=expectedStart;put(root,slabRel,slab);
     pageChanged=true;
    }
   }else{
    if(members.some(u=>u.kind!=='SHARD'))throw Error('unexpected fixed unit-plan identity: '+shard.file);
    members.sort((a,b)=>a.shardIndex-b.shardIndex);
    if(members.some((u,j)=>u.shardIndex!==j))
     throw Error('noncontiguous immutable fixed unit-plan ownership: '+shard.file);
    const prefix=JSON.stringify(shard.path)+':';
    const keys=members.map(u=>{
     const key=u.recordKeys?.[0];
     if(typeof key!=='string'||!key.startsWith(prefix))
      throw Error('invalid immutable unit record key: '+shard.file);
     return key.slice(prefix.length);
    });
    const first=Math.min(...members.map(u=>u.recordIndex));
    if(shard.startIndex!==first||JSON.stringify(shard.recordKeys)!==JSON.stringify(keys)){
     shard.startIndex=first;shard.recordKeys=keys;pageChanged=true;
    }
   }
  }
  if(pageChanged){
   put(root,pageRel,page);put(root,trustedPageRel,page);
   working.pages[i].sha256=sha(page);trusted.pages[i].sha256=sha(page);
   changed=true;
  }
 }
 if(changed){
  put(root,assignment.workShardIndexPath,working);put(root,trustedRel,trusted);
 }
}
export function assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase}){
 // GitHub copies and orders the actual Worker-provided bytes; no additional
 // identity, value, coverage, dependency, or security validation is performed.
 const ready=finalizeReadinessV1({root,campaignPath,directory,phase});
 if(!ready.ready)return {status:'AWAITING_WORKER_FILES',unitIds:ready.unitIds};
 const {plan,queue}=ready,assignment=directory.currentAssignment,byFile=new Map();
 for(const u of plan.units.filter(u=>['SHARD','APPEND','BATCH'].includes(u.kind))){
  const accepted=read(root,queue.units[u.unitId].acceptedPath);
  if(u.kind==='BATCH'){
   const entries=Array.isArray(accepted.submission?.entries)?accepted.submission.entries:[];
   for(const member of u.members){
    const entry=entries.find(e=>e?.key===member.recordKeys?.[0]);
    if(!entry)continue; // Do not invent material that the Worker did not send.
    const group=byFile.get(member.shardPath)??[];
    group.push({unit:member,entries:[entry]});byFile.set(member.shardPath,group);
   }
  }else{
   const group=byFile.get(u.shardPath)??[];
   group.push({unit:u,entries:Array.isArray(accepted.submission?.entries)?accepted.submission.entries:[]});
   byFile.set(u.shardPath,group);
  }
 }
 for(const [rel,group] of byFile){
  const slab=read(root,rel);
  const fixed=group.filter(e=>e.unit.kind==='SHARD').sort((a,b)=>a.unit.shardIndex-b.unit.shardIndex);
  const appended=group.filter(e=>e.unit.kind==='APPEND').sort((a,b)=>a.unit.unitId.localeCompare(b.unit.unitId));
  slab.entries=fixed.length?fixed.flatMap(e=>e.entries):appended.flatMap(e=>e.entries);
  put(root,rel,slab);
 }
 materializeSemanticWorkFormV13({root,formRel:assignment.workFormPath});
 return {status:'READY_FOR_EXISTING_BOUNDARY_SEAL',workShardIndexPath:assignment.workShardIndexPath,
  validationDelegatedTo:'CLOUDFLARE_WORKER'};
}
export function markFinalizationV1({root,campaignPath,phase,status,details=null}){
 const queue=read(root,queueRel(campaignPath,phase));
 queue.finalizeStatus=status;queue.finalizeDetails=details;
 queue.revision++;put(root,queueRel(campaignPath,phase),queue);
}
export function statusUnitQueueV1({root,campaignPath,phase}){
 const plan=maybe(root,planRel(campaignPath,phase))?readPlan(root,campaignPath,phase):null,queue=maybe(root,queueRel(campaignPath,phase));
 if(!plan||!queue)return null;
 const counts={},workers=new Set();
 for(const [id,s] of Object.entries(queue.units)){counts[s.status]=(counts[s.status]??0)+1;if(s.workerId)workers.add(s.workerId);}
 return {phase,counts,workers:[...workers].sort(),approvalBacklog:Object.values(queue.units).filter(x=>x.status==='SUBMITTED').length,
  eligible:available(queue,plan).map(x=>x.unitId),revision:queue.revision,finalizeStatus:queue.finalizeStatus};
}

// Compatibility surface only. Aggregate audit-quality outcomes are Worker-owned.
// Never invalidate an accepted record, reset a claim, or freeze a GitHub queue.
export function reopenAggregateDefectsV1({deficiencies=[]}={}){
  return {reopenedUnits:[],unmappedDeficiencies:Array.isArray(deficiencies)
    ?deficiencies.map(item=>typeof item==='string'?item:JSON.stringify(item))
    :[],invalidatedRecordIds:[],validationDelegatedTo:'CLOUDFLARE_WORKER'};
}
