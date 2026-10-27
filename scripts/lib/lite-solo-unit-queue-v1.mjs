import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {repoFile,readJson,writeJson,loadPhaseSchema,validateWorkForm,requiredFile} from './lite-solo-phase-work-v1.mjs';
import {validateFlowReviewSubmissionV1,validateAttackSubmissionV1} from '../../packages/github-native-sim/src/adr-discovery-validators-v1.mjs';
import {reviewInventoryRelV1} from '../../packages/github-native-sim/src/adr-review-inventory-v1.mjs';
import {buildUnitPacketV1,writeUnitPacketIndexV1,buildDiscoverySummaryV1} from '../../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';
import {loadTaxonomyV1} from '../../packages/github-native-sim/src/adr-taxonomy-v1.mjs';
import {deriveBaselineObligationsV1} from '../../packages/github-native-sim/src/adr-baseline-obligations-v1.mjs';
import {applyPhaseBoundaryPrefill,resolveTargetExecutionRequestRef} from './lite-solo-phase-prefill-v1.mjs';
import {validateTargetExecutionRequestBindingV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {secureRestoreWorkFormV13,secureShardWorkFormV13} from './lite-solo-work-shards-v1.mjs';

export const UNIT_POLICY=Object.freeze({issueBatchDefault:10,issueBatchMax:10,approvalBatchMax:5,maxParallelWorkers:null});
export const REQUEST_SCHEMA='curveyield-lite-solo-unit-batch-request-v1';
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
const asArray=x=>Array.isArray(x)?x:[];
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>structuredClone(x);
const depSatisfied=(queue,u)=>asArray(u.dependencies).every(k=>queue.units[k]?.status==='ACCEPTED');
const isPhase=(p)=>[4,5,6].includes(p);
const RELEASE='lite-solo-v4';
const AUTHORITY='Audit Skill - Lite-Solo Authority/lite-solo-v4';
const rowId=(phase,field,index)=>{
 const families={
 '4:discoveryReconciliationRecords':'P4-RC','4:specialistReviewRecords':'P4-SP',
 '4:candidateRecords':'P4-C','4:typedLimitations':'P4-L','4:obligationDispositions':'P4-OB',
 '5:economicReviewRecords':'P5-E','5:reconciliationRecords':'P5-R','5:targetDesigns':'P5-T','5:newCandidateRecords':'P5-C',
 '6:deploymentAssessments':'P6-D','6:targetDispositions':'P6-T',
 '6:baselineTestRecords':'P6-B','6:candidateProofRecords':'P6-P',
 '6:mergedExecutionConclusions':'P6-C','6:obligationDispositions':'P6-OB',
 '6:typedExecutionLimitations':'P6-L','6:fullOnlyOmissions':'P6-O','6:newCandidateRecords':'P6-N'
 };
 const prefix=families[phase+':'+field];
 if(!prefix)throw Error('unassigned semantic field '+phase+':'+field);
 return prefix+'-'+String(index+1).padStart(3,'0');
};
function assertV4(directory,phase,request=null){
 if(!isPhase(phase)||directory.mode!=='LITE_SOLO'||directory.authorityRelease!==RELEASE)
  throw Error('v4 controller requires a v4-bound Lite-Solo generation');
 if(directory.executionModel!=='PARALLEL_WORKER_UNITS')
  throw Error('campaign is not admitted to parallel execution');
 if(directory.currentAssignment?.phaseSequence!==phase)throw Error('phase not current/assigned');
 if(request){
  const expected={campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,
   phaseSequence:phase,sourceSha256:directory.sourceSha256,
   auditControllerRef:'main'};
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
  units:{},processedRequests:{},processedRequestHashes:{},revision:0,finalizeStatus:'NOT_STARTED',newlyEligibleUnitIds:[]};
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
function readPlan(root,campaign,phase){
 const index=read(root,planRel(campaign,phase));
 if(index.schemaVersion!=='curveyield-lite-solo-unit-plan-v1'||!Array.isArray(index.pages))
  throw Error('unrecognized or unpaged v4 unit plan');
 const units=[];
 for(const p of index.pages){
  const raw=fs.readFileSync(repoFile(root,p.path));
  if(hex(raw)!==p.sha256||raw.length>32768)throw Error('unit plan page digest/size mismatch: '+p.path);
  const data=JSON.parse(raw.toString('utf8'));
  for(const u of data.units){
   if(u.initialValueRef){
    const rawValue=fs.readFileSync(repoFile(root,u.initialValueRef));
    if(hex(rawValue)!==u.initialValueSha256)throw Error('unit prefill digest mismatch');
    u.initialValue=JSON.parse(rawValue.toString('utf8')).value;
   }
   units.push(u);
  }
 }
 if(units.length!==index.unitCount)throw Error('missing unit plan pages');
 const ownership={};
 for(const u of units)if(u.path&&Number.isInteger(u.recordIndex))
  ownership[dot([...u.path,String(u.recordIndex)])]=u.unitId;
 return {...index,units,recordOwnership:ownership};
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
  if(Buffer.byteLength(pretty(u))>12000&&u.initialValue!==undefined){
   const rel=path.posix.join(unitBase(campaign,phase,u.unitId),'UNIT_PREFILL_v1.json');
   const value={value:u.initialValue};put(root,rel,value);
   u.initialValueRef=rel;u.initialValueSha256=sha(value);delete u.initialValue;
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
export function createUnitPlanV1({root,campaignPath,directory,phase,automationRoot=process.cwd()}){
 assertV4(directory,phase);
 const existing=maybe(root,queueRel(campaignPath,phase));
 if(existing)return existing;
 const plan=emptyPlan(directory,phase),queue=emptyQueue(plan);
 if(phase===4){
  const rel=reviewInventoryRelV1(root,campaignPath,'FLOW_PLAN_v1.json'),flow=read(root,rel);
  const units=[...asArray(flow.payload?.reviewUnits),...asArray(flow.payload?.attackUnits)];
  if(!units.length||asArray(flow.payload?.gaps).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code)))
   throw Error('cannot issue Phase-4 units from missing/incomplete review inventory');
  const fIds=units.filter(u=>u.unitId.startsWith('F-')||u.unitId.startsWith('R-')).map(u=>u.unitId);
  for(const u of units){
   if(!/^[FRX]-\d{3}$/.test(u.unitId))throw Error('unsupported discovery unit '+u.unitId);
   const packet=buildUnitPacketV1({root,campaignPath,directory,authorityRoot:AUTHORITY,
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
function addShardUnits({root,campaignPath,directory,phase,plan,queue}){
 const idxRel=directory.currentAssignment?.workShardIndexPath;
 if(!idxRel)throw Error('missing canonical semantic shard index');
 const index=read(root,idxRel),dir=path.posix.dirname(idxRel);
 if(index.phase!==phase)throw Error('shard phase mismatch');
 const descriptors=asArray(index.pages).flatMap(p=>asArray(read(root,path.posix.join(dir,p.file)).shards));
 const serial={};
 for(const d of descriptors){
  const field=d.path?.at(-1);
  if(!field)throw Error('missing work shard field');
  // Controller-owned machine-derived limitation/omission fields are not worker-editable.
  if(phase===6&&['typedExecutionLimitations','fullOnlyOmissions'].includes(field))continue;
  const slab=read(root,path.posix.join(dir,d.file));
  if(d.append){
   const id=rowId(phase,field,(serial[field]??0)++);
   const unit={unitId:id,kind:'APPEND',field,shardFile:d.file,shardIndex:0,
    shardPath:path.posix.join(dir,d.file),recordKeys:[],path:d.path,dependencies:[],unitSpecRevision:1};
   addUnit(plan,queue,unit);continue;
  }
  for(let n=0;n<slab.entries.length;n++){
   const entry=slab.entries[n],id=rowId(phase,field,(serial[field]??0)++);
   const ownership=dot([...d.path,String(d.startIndex+n)]);
   if(plan.recordOwnership[ownership])throw Error('duplicate canonical record owner: '+ownership);
   plan.recordOwnership[ownership]=id;
   addUnit(plan,queue,{unitId:id,kind:'SHARD',field,shardFile:d.file,
    shardPath:path.posix.join(dir,d.file),shardIndex:n,recordIndex:d.startIndex+n,
    recordKeys:[entry.key],initialValue:entry.value,path:d.path,
    dependencies:[],unitSpecRevision:1});
  }
 }
 // Preserve semantic prerequisites: target design requires its related reconciliation row,
 // not a blanket dependency on every economic or reconciliation unit.
 if(phase===5){
  const reconc=plan.units.filter(u=>u.field==='reconciliationRecords');
  const novel=plan.units.filter(u=>u.field==='newCandidateRecords');
  for(const u of plan.units.filter(u=>u.field==='targetDesigns')){
   const candidate=u.initialValue?.candidateKey;
   u.dependencies=u.kind==='APPEND'?novel.map(r=>r.unitId):
    reconc.filter(r=>candidate&&r.initialValue?.subjectKey===candidate).map(r=>r.unitId);
  }
 }
 if(phase===6){
  const interpretation=plan.units.filter(u=>['deploymentAssessments','targetDispositions'].includes(u.field)).map(u=>u.unitId);
  const proofs=plan.units.filter(u=>['baselineTestRecords','candidateProofRecords'].includes(u.field)).map(u=>u.unitId);
  for(const u of plan.units.filter(u=>u.field==='mergedExecutionConclusions'||u.field==='obligationDispositions'))
   u.dependencies=[...new Set([...interpretation,...proofs])];
 }
 for(const u of plan.units)if(u.dependencies.length)queue.units[u.unitId].status='BLOCKED_DEPENDENCY';
 const missing=new Set(plan.units.flatMap(x=>x.dependencies).filter(id=>!queue.units[id]));
 if(missing.size)throw Error('unsatisfied planner unit references: '+[...missing].join(', '));
}
function validateRequest(request,directory,phase){
 if(request?.schemaVersion!==REQUEST_SCHEMA||!['CLAIM','SUBMIT','RELEASE','FINALIZE'].includes(request.operation))
  throw Error('unsupported v4 request shape/operation');
 for(const key of ['requestId','workerId'])if(!safe(request[key]))throw Error('unsafe '+key);
 if(request.lane!=='AUTO'&&!safe(request.lane))throw Error('invalid lane');
 const common=['schemaVersion','requestId','operation','campaignId','campaignGenerationId','phaseSequence',
  'lane','workerId','sourceSha256','authorityDigest','phaseEpoch','auditControllerRef'];
 const allowed=new Set([...common,...(request.operation==='CLAIM'?['desiredUnitCount']:
  ['items'])]);
 for(const key of Object.keys(request))if(!allowed.has(key))throw Error('unexpected controller/request field: '+key);
 assertV4(directory,phase,request);
 if(request.operation==='CLAIM'){
  if(request.desiredUnitCount!==UNIT_POLICY.issueBatchDefault||request.items!==undefined)
   throw Error('normal CLAIM must request exactly ten and omit items');
 }else if(request.operation==='SUBMIT'){
  if(!Array.isArray(request.items)||request.items.length<1||request.items.length>UNIT_POLICY.approvalBatchMax)
   throw Error('SUBMIT must explicitly name 1–5 items');
  if(new Set(request.items.map(x=>x.unitId)).size!==request.items.length)throw Error('duplicate SUBMIT unit');
  if(request.items.some(x=>!isObject(x)||!safe(x.unitId)||!Number.isInteger(x.claimEpoch)||
    typeof x.claimToken!=='string'||!x.claimToken.trim()||
    !/^[0-9a-f]{64}$/.test(String(x.packetSha256??''))||
    !/^[0-9a-f]{64}$/.test(String(x.submissionSha256??''))))
   throw Error('SUBMIT item identity or hash is malformed');
 }else if(request.operation==='RELEASE'){
  if(!Array.isArray(request.items)||!request.items.length||request.items.some(x=>!safe(x.unitId)||
    !Number.isInteger(x.claimEpoch)||!x.claimToken))throw Error('RELEASE must list complete owned tokens');
 }else if(request.operation==='FINALIZE'&&request.workerId!=='lite-solo-controller')
  throw Error('only the controller may finalize');
}
function available(queue,plan,lane='AUTO'){
 return plan.units.filter(u=>queue.units[u.unitId]?.status==='AVAILABLE'&&depSatisfied(queue,u)
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
function noWork(queue,plan){
 if(plan.units.every(u=>queue.units[u.unitId].status==='ACCEPTED'))return 'PHASE_COMPLETE';
 if(plan.units.some(u=>queue.units[u.unitId].status==='REWORK_REQUIRED'))return 'REWORK_REQUIRED';
 if(plan.units.some(u=>queue.units[u.unitId].status==='BLOCKED_DEPENDENCY'))return 'BLOCKED_DEPENDENCY';
 if(plan.units.some(u=>queue.units[u.unitId].status==='SUBMITTED'))return 'AWAITING_APPROVAL';
 if(plan.units.some(u=>queue.units[u.unitId].status==='CLAIMED'))return 'ALL_WORK_CLAIMED';
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
  count:units.length,pages,readingGuide:'Read paged indexes and only assigned unit pages. Commit immutable worker/claim-epoch/attempt submissions; enqueue 1–5-unit SUBMIT requests, then immediately continue independent claimed units. NEVER wait for controller approval. Claim ten more when eligible; dependent units require persisted ACCEPTED.'};
 const rel=path.posix.join(dir,'BATCH_INDEX_v1.json');put(root,rel,index);
 return rel;
}
function handleClaim({root,campaign,phase,queue,plan,request}){
 const eligible=available(queue,plan,request.lane),selected=eligible.slice(0,UNIT_POLICY.issueBatchMax);
 const units=selected.map(u=>{
  const state=queue.units[u.unitId];state.status='CLAIMED';state.workerId=request.workerId;
  state.claimEpoch++;state.claimToken=randomUUID();
  return {unitId:u.unitId,claimEpoch:state.claimEpoch,claimToken:state.claimToken,
   packetPath:u.packetPath??u.shardPath,packetIndexPath:u.packetIndexPath??null,
   packetSha256:u.packetSha256??hex(fs.readFileSync(repoFile(root,u.shardPath))),
   unitSpecRevision:u.unitSpecRevision};
 });
 return {status:units.length?'CLAIMED':noWork(queue,plan),claimedUnits:units,
  batchIndexPath:units.length?batchIndex(root,campaign,phase,request.requestId,units):null};
}
function itemIdentity(item,u,state,request,root){
 if(item.unitId!==u.unitId||state.workerId!==request.workerId||
  item.claimEpoch!==state.claimEpoch||item.claimToken!==state.claimToken)return 'STALE';
 if(state.status==='ACCEPTED')return 'UNCHANGED';
 if(!['CLAIMED','SUBMITTED','REWORK_REQUIRED'].includes(state.status))return 'STALE';
 const packetRel=u.packetPath??u.shardPath;
 if(item.packetSha256!== (u.packetSha256??hex(fs.readFileSync(repoFile(root,packetRel)))))
  return 'STALE';
 const allowed=path.posix.join(unitBase(request.campaignWorkspacePath,request.phaseSequence,u.unitId),
    'submissions',request.workerId,'epoch-'+state.claimEpoch);
 if(!item.submissionPath?.startsWith(allowed+'/')||
    !/^SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(path.posix.basename(item.submissionPath)))
  return 'STALE';
 return null;
}
function validateShardUnit({root,u,data,phase,schema,queue,plan}){
 const errors=[],entries=asArray(data?.entries);
 if(data?.schemaVersion!=='curveyield-lite-solo-unit-submission-v1'||entries.length!==1&&u.kind!=='APPEND')
  return ['unit snapshot needs one owned record'];
 if(u.kind==='APPEND'){
  if(entries.length>1024||Buffer.byteLength(JSON.stringify(data),'utf8')>1024*1024)
   return ['append unit exceeds existing 1 MiB / 1024-entry authorized capacity'];
 }else if(entries[0]?.key!==u.recordKeys[0])return ['record key differs from immutable prefill identity'];
 const action=schema.actions?.[u.path[1]],field=(action?.fields??[]).find(x=>x.name===u.field);
 if(!field)return ['field is not in bound phase schema'];
 const fixed=[...new Set([...(field.controllerPrefillFields??[]),...(action.controllerPrefillFields??[])])];
 const orig=u.initialValue;
 for(const [i,entry] of entries.entries()){
  const val=entry?.value;
  if(u.kind==='APPEND'&&entry?.key!==JSON.stringify(u.path)+':APPEND-'+String(i+1).padStart(4,'0'))
   errors.push('append identity must match indexed capacity');
  if(phase===5&&u.field==='targetDesigns'&&u.kind!=='APPEND'&&isObject(orig)&&isObject(val)&&orig.candidateKey!==val.candidateKey)
   errors.push('candidateKey identity from accepted Phase 4 is immutable');
  if(u.kind!=='APPEND'&&isObject(orig)&&isObject(val))
   for(const key of fixed)if(JSON.stringify(orig[key])!==JSON.stringify(val[key]))
    errors.push('controller-prefilled '+key+' is read-only');
  if(u.kind!=='APPEND'&&typeof orig==='string'&&orig==='NONE_IDENTIFIED'&&isObject(val))
   errors.push('immutable negative sentinel must remain; use append slot for real records');
  if(field.type==='REQUIRED_RECORD_LIST'&&!(isObject(val)||['NONE_IDENTIFIED','NO_CANDIDATE','NOT_APPLICABLE','NO_ADDITIONAL_OBLIGATION'].includes(val)))
   errors.push('record must be an object or admitted explicit negative');
  if(isObject(val)){
   for(const name of field.itemRequiredFields??[])if(val[name]===undefined||val[name]===null||
    typeof val[name]==='string'&&(!val[name].trim()||val[name].startsWith('<REQUIRED')))
    errors.push(name+' requires substantive evidence');
   for(const [name,allowed] of Object.entries(field.itemFieldAllowedValues??{}))
    if(val[name]!==undefined&&!allowed.includes(String(val[name])))errors.push(name+' invalid enum');
  }else if(typeof val==='string'&&val.startsWith('<REQUIRED'))errors.push('incomplete mandatory field');
  if(phase===5&&u.field==='targetDesigns'&&isObject(val)&&val.executionMethod==='V7_REQUEST'){
   const resolved=resolveTargetExecutionRequestRef({root,campaignPath:plan.campaignPath,target:val});
   if(!resolved)errors.push('target lacks a committed source-bound executable request/harness');
   else {
    const bound=validateTargetExecutionRequestBindingV1({controllerRoot:root,campaignPath:plan.campaignPath,
     target:{...val,executionRequestRef:resolved},expectedCampaignId:plan.campaignId,expectedSourceSha256:plan.sourceSha256});
    if(!String(bound.status).startsWith('PASS_'))errors.push('target binding: '+bound.status+': '+(bound.reasons??[]).join('; '));
   }
  }
 }
 return errors;
}
function acceptSubmission({root,campaign,phase,request,item,queue,plan,schema,directory}){
 const u=plan.units.find(x=>x.unitId===item.unitId),state=queue.units[item.unitId];
 if(!u||!state)return {unitId:item.unitId,status:'STALE',errors:['unknown unit']};
 const identity=itemIdentity(item,u,state,{...request,campaignWorkspacePath:campaign},root);
 if(identity)return {unitId:item.unitId,status:identity,errors:[]};
 if(!/^[0-9a-f]{64}$/.test(item.submissionSha256??''))return {unitId:item.unitId,status:'STALE',errors:['invalid digest']};
 const file=repoFile(root,item.submissionPath);
 if(!fs.existsSync(file)){state.status='SUBMITTED';return {unitId:item.unitId,status:'WAITING_SUBMISSION',errors:[]};}
 const raw=fs.readFileSync(file),digest=hex(raw);
 if(digest!==item.submissionSha256)return {unitId:item.unitId,status:'STALE',errors:['immutable snapshot SHA mismatch']};
 state.status='SUBMITTED';
 if(state.lastSubmissionSha256===digest&&state.lastErrors?.length){
  state.status='REWORK_REQUIRED';
  return {unitId:item.unitId,status:'UNCHANGED',errors:state.lastErrors};
 }
 let submission,errors=[];
 try{submission=JSON.parse(raw.toString('utf8'));}
 catch(e){submission=null;errors=[{path:'$',message:'Malformed JSON: '+String(e.message??e)}];}
 if(!errors.length&&['FLOW','ATTACK'].includes(u.kind)){
  const packet=read(root,u.packetPath),inventory=read(root,reviewInventoryRelV1(root,campaign,'REVIEW_INVENTORY_v1.json'));
  const checked=u.kind==='ATTACK'
   ?validateAttackSubmissionV1({packet:packet.payload,submission,inventory})
   :validateFlowReviewSubmissionV1({packet:packet.payload,submission,inventory});
  errors=checked.errors??[];
 }else if(!errors.length)errors=validateShardUnit({root,u,data:submission,phase,schema,queue,plan}).map(message=>({path:u.unitId,message}));
 state.lastSubmissionSha256=digest;state.attempts++;
 const resultRel=path.posix.join(unitBase(campaign,phase,u.unitId),'results',
  'ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
 if(!errors.length){
  const acceptedRel=path.posix.join(unitBase(campaign,phase,u.unitId),'ACCEPTED_ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
  if(fs.existsSync(repoFile(root,acceptedRel)))throw Error('immutable accepted attempt cannot be overwritten');
  put(root,acceptedRel,{schemaVersion:'curveyield-lite-solo-accepted-unit-v1',unitId:u.unitId,
   campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
   workerId:request.workerId,claimEpoch:state.claimEpoch,submissionSha256:digest,submission});
  state.status='ACCEPTED';state.acceptedSha256=digest;state.acceptedPath=acceptedRel;state.lastErrors=[];
  put(root,resultRel,{unitId:u.unitId,status:'ACCEPTED',submissionSha256:digest,acceptedPath:acceptedRel});
  return {unitId:u.unitId,status:'ACCEPTED',resultRef:resultRel};
 }
 state.status='REWORK_REQUIRED';state.lastErrors=errors;
 put(root,resultRel,{unitId:u.unitId,status:'REWORK_REQUIRED',submissionSha256:digest,errors});
 return {unitId:u.unitId,status:'REWORK_REQUIRED',resultRef:resultRel,errors};
}
function handleSubmit({root,campaign,phase,queue,plan,request,directory}){
 const schema=loadPhaseSchema(root,AUTHORITY,phase).schema,items=[];
 for(const item of request.items){
  // A durably queued request is SUBMITTED, never implicitly ACCEPTED.
  // Missing cross-repository bytes remain pending and retryable.
  const owned=queue.units[item.unitId];
  if(owned?.status==='CLAIMED'&&owned.workerId===request.workerId&&
     owned.claimEpoch===item.claimEpoch&&owned.claimToken===item.claimToken)
   owned.status='SUBMITTED';
  try{items.push(acceptSubmission({root,campaign,phase,request,item,queue,plan,schema,directory}));}
  catch(e){
   const state=queue.units[item.unitId],reason=String(e.message??e);
   if(state&&state.workerId===request.workerId){state.status='REWORK_REQUIRED';state.lastErrors=[reason];}
   items.push({unitId:item.unitId,status:'REWORK_REQUIRED',errors:[reason]});
  }
 }
 const newlyEligibleUnits=unlock(queue,plan);
 return {status:'SUBMISSION_RECORDED',acceptedUnits:items.filter(x=>x.status==='ACCEPTED').map(x=>x.unitId),
  reworkUnits:items.filter(x=>x.status==='REWORK_REQUIRED'),staleUnits:items.filter(x=>x.status==='STALE'),
  unchangedUnits:items.filter(x=>x.status==='UNCHANGED'),waitingUnits:items.filter(x=>x.status==='WAITING_SUBMISSION'),
  newlyEligibleUnits};
}
function handleRelease({queue,plan,request}){
 const changed=[];
 for(const item of request.items){
  const s=queue.units[item.unitId];
  if(!s||s.workerId!==request.workerId||s.claimEpoch!==item.claimEpoch||
   s.claimToken!==item.claimToken||s.status==='ACCEPTED')continue;
  s.status='AVAILABLE';s.workerId=null;s.claimToken=null;changed.push(item.unitId);
 }
 return {status:'RELEASED',releasedUnits:changed,newlyEligibleUnits:unlock(queue,plan)};
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
 const form={...read(root,path.posix.join(AUTHORITY,'phases/phase-4/resources/PHASE_04_WORK_FORM_TEMPLATE_v1.json'))};
 const updated=applyPhaseBoundaryPrefill({root,campaignPath:campaign,authorityRoot:AUTHORITY,sequence:4,
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
export function processUnitRequestV1({root,campaignPath,directory,request,automationRoot=process.cwd()}){
 const phase=request.phaseSequence;validateRequest(request,directory,phase);
 let queue=maybe(root,queueRel(campaignPath,phase));
 if(!queue)queue=createUnitPlanV1({root,campaignPath,directory,phase,automationRoot});
 const plan=readPlan(root,campaignPath,phase);assertPlan(queue,plan);
 if(queue.processedRequests[request.requestId]){
  if(queue.processedRequestHashes?.[request.requestId]!==sha(request))throw Error('processed request ID reused with different content');
  return queue.processedRequests[request.requestId];
 }
 let result;
 if(request.operation==='CLAIM')result=handleClaim({root,campaign:campaignPath,phase,queue,plan,request});
 else if(request.operation==='SUBMIT')result=handleSubmit({root,campaign:campaignPath,phase,queue,plan,request,directory});
 else if(request.operation==='RELEASE')result=handleRelease({queue,plan,request});
 else {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;result={status:'FINALIZE_REQUESTED'};}
 if(result.acceptedUnits?.length) {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;}
 if(phase===4&&queue.stage!=='RECONCILIATION'&&
  plan.units.filter(u=>['FLOW','ATTACK'].includes(u.kind)).every(u=>queue.units[u.unitId]?.status==='ACCEPTED'))
  finishDiscovery({root,campaign:campaignPath,directory,plan,queue,automationRoot});
 result={schemaVersion:'curveyield-lite-solo-unit-controller-result-v1',
  requestId:request.requestId,campaignId:directory.campaignId,phaseSequence:phase,
  ...result,phaseStatus:noWork(queue,plan)};
 queue.revision++;
 if(!asArray(result.waitingUnits).length){queue.processedRequests[request.requestId]=result;
  queue.processedRequestHashes[request.requestId]=sha(request);}
 publishPlan(root,campaignPath,phase,plan,queue);
 directory.unitQueueIndexPath=planRel(campaignPath,phase);
 directory.unitQueueStatePath=queueRel(campaignPath,phase);
 if(directory.currentAssignment?.phaseSequence===phase){
  directory.currentAssignment.unitQueueIndexPath=directory.unitQueueIndexPath;
  directory.currentAssignment.unitQueueStatePath=directory.unitQueueStatePath;
 }
 return result;
}
export function finalizeReadinessV1({root,campaignPath,directory,phase}){
 assertV4(directory,phase);
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 assertPlan(queue,plan);
 if(phase===4&&queue.stage!=='RECONCILIATION')return {ready:false,reason:'discovery and reconciliation not complete'};
 const pending=plan.units.filter(u=>queue.units[u.unitId]?.status!=='ACCEPTED');
 if(pending.length)return {ready:false,reason:'mandatory units remain',unitIds:pending.map(x=>x.unitId)};
 if(queue.finalizeStatus==='SEALED')return {ready:false,reason:'already sealed'};
 if(queue.finalizeStatus==='BLOCKED')return {ready:false,reason:'controller finalization blocked; correct published evidence or issue controller FINALIZE retry'};
 return {ready:true,plan,queue};
}
export function assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase}){
 const ready=finalizeReadinessV1({root,campaignPath,directory,phase});
 if(!ready.ready)throw Error('unsafe finalization: '+ready.reason);
 const {plan,queue}=ready,assignment=directory.currentAssignment;
 const byFile=new Map();
 for(const u of plan.units.filter(u=>['SHARD','APPEND'].includes(u.kind))){
  const accepted=read(root,queue.units[u.unitId].acceptedPath);
  if(queue.units[u.unitId].acceptedSha256!==accepted.submissionSha256)throw Error('accepted digest mismatch');
  const list=byFile.get(u.shardPath)??[];list.push({unit:u,entries:accepted.submission.entries});byFile.set(u.shardPath,list);
 }
 // Rebuild every shard deterministically from accepted immutable snapshots.
 // A failed finalize can retry without appending duplicates to mutable shards.
 for(const [rel,edits] of byFile){
  const slab=read(root,rel);
  const fixed=edits.filter(e=>e.unit.kind==='SHARD').sort((a,b)=>a.unit.shardIndex-b.unit.shardIndex);
  const append=edits.filter(e=>e.unit.kind==='APPEND').sort((a,b)=>a.unit.unitId.localeCompare(b.unit.unitId));
  if(fixed.length&&append.length)throw Error('shard has conflicting fixed and append ownership: '+rel);
  if(fixed.some((e,i)=>e.unit.shardIndex!==i))throw Error('incomplete fixed shard ownership: '+rel);
  slab.entries=fixed.length?fixed.map(e=>e.entries[0]):append.flatMap(e=>e.entries);
  put(root,rel,slab);
 }
 // Full restoration is the pre-existing source-bound schema/identity validator.
 const restored=secureRestoreWorkFormV13({root,indexRel:assignment.workShardIndexPath});
 const form=JSON.parse(restored.content),schema=loadPhaseSchema(root,AUTHORITY,phase).schema;
 const errors=validateWorkForm(schema,form);
 if(errors.length)throw Error('aggregate validation blocked: '+errors.slice(0,15).join('; '));
 // Existing phase controller materializes, validates all semantic gates, executes required
 // already-qualified machine lane (Phase 5), generates a single seal and next assignment.
 return {status:'READY_FOR_EXISTING_BOUNDARY_SEAL',workShardIndexPath:assignment.workShardIndexPath};
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

export function reopenAggregateDefectsV1({root,campaignPath,phase,deficiencies=[]}){
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 const reopened=[],unmapped=[];
 for(const entry of deficiencies){
  const message=typeof entry==='string'?entry:JSON.stringify(entry);
  const found=new Set();
  for(const match of message.matchAll(/(?:actions\.)?(?:step-[0-9]+\.outputs\.)?([A-Za-z][A-Za-z0-9_]*)\[([0-9]+)\]/g)){
   const field=match[1],position=Number(match[2]);
   for(const u of plan.units)if(u.field===field&&u.recordIndex===position)found.add(u.unitId);
  }
  // Machine-binding diagnostics often name candidate keys instead of array indices.
  for(const u of plan.units.filter(x=>['targetDesigns','targetDispositions','candidateProofRecords'].includes(x.field))){
   const state=queue.units[u.unitId];
   const accepted=state?.acceptedPath?maybe(root,state.acceptedPath):null;
   const values=accepted?.submission?.entries?.map(x=>x.value)??[];
   if(values.some(v=>v&&typeof v==='object'&&
      [v.candidateKey,v.tempKey].some(key=>typeof key==='string'&&key.length>=3&&message.includes(key))))
      found.add(u.unitId);
  }
  if(!found.size){unmapped.push(message);continue;}
  for(const id of found){
   const state=queue.units[id];
   if(state.status==='ACCEPTED')state.status='REWORK_REQUIRED';
   state.lastErrors=[...state.lastErrors,message].slice(-30);
   reopened.push(id);
  }
 }
 const result={reopenedUnits:[...new Set(reopened)].sort(),unmappedDeficiencies:unmapped};
 queue.finalizeStatus='REWORK_REQUIRED';queue.finalizeDetails=result;queue.revision++;
 put(root,queueRel(campaignPath,phase),queue);
 return result;
}
