import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createUnitPlanV1,processUnitRequestV1} from '../../../lib/lite-solo-unit-queue-v1.mjs';
import {fixture,evidence,digest,json,get,put,writeFile,snapshot,correctSubmission,git} from './context.mjs';

export {fixture,evidence,digest,json,get,put,writeFile,snapshot,correctSubmission,git};
export const req=(f,op,worker,id,extra={})=>f.request(op,worker,id,extra);
export const claim=(f,worker,id)=>f.process(req(f,'CLAIM',worker,id,{desiredUnitCount:10})).claimedUnits;
export const snapshotWith=(f,claimed,worker,data=null,attempt=1)=>{
 const file=f.campaign+'/work/phase-04/units/'+claimed.unitId+'/submissions/'+worker+
   '/epoch-'+claimed.claimEpoch+'/SUBMISSION_ATTEMPT_'+String(attempt).padStart(3,'0')+'_v1.json';
 const body=json(data??(claimed.unitId.startsWith('X-')
  ?{schemaVersion:'curveyield-attack-submission-v1',unitId:claimed.unitId,attackPaths:[],integrationAnswers:[]}
  :correctSubmission(f.packet(claimed.unitId))));
 writeFile(f.root,file,body);
 return {unitId:claimed.unitId,claimEpoch:claimed.claimEpoch,claimToken:claimed.claimToken,
  packetSha256:claimed.packetSha256,submissionPath:file,submissionSha256:digest(body),
  unitSpecRevision:claimed.unitSpecRevision};
};
export const submit=(f,worker,id,items)=>f.process(req(f,'SUBMIT',worker,id,{items}));
export const release=(f,worker,id,units)=>f.process(req(f,'RELEASE',worker,id,{items:units.map(x=>({
 unitId:x.unitId,claimEpoch:x.claimEpoch,claimToken:x.claimToken}))}));
export const acceptedHashes=(state)=>Object.fromEntries(Object.entries(state.units)
 .filter(([,v])=>v.status==='ACCEPTED').map(([k,v])=>[k,v.acceptedSha256]));
export const rawHash=(f)=>digest(fs.readFileSync(path.join(f.root,f.stateRel)));
export const withCase=(id,fn)=>()=>{
 const f=fixture(id,{flowCount:Math.max(15,Number(process.env.FIXTURE_SIZE||15))}),notes={};
 try{fn(f,notes);evidence(id,'LOCAL','PASS',notes)}
 catch(e){notes.error=String(e.stack??e);evidence(id,'LOCAL','FAIL',notes);throw e}
 finally{f.cleanup()}
};
export function graphDependency(f,unitId,dependencies){
 const rel=f.campaign+'/work/phase-04/units/UNIT_PLAN_INDEX_v1.json';
 const idx=get(f.root,rel);let count=0;
 for(const d of idx.pages){
  const page=get(f.root,d.path),u=page.units.find(x=>x.unitId===unitId);
  if(!u)continue;
  u.dependencies=dependencies;count++;
  const raw=json(page);fs.writeFileSync(path.join(f.root,d.path),raw);d.sha256=digest(raw);
 }
 assert.equal(count,1);
 put(f.root,rel,idx);
 const queue=f.state();
 queue.units[unitId].status='BLOCKED_DEPENDENCY';
 put(f.root,f.stateRel,queue);
}
export function pendingItems(f,units,worker){
 // Queue ownership and SUBMITTED state are true controller transitions.
 // Withhold bytes, not validation, by passing an immutable not-yet-published path.
 return units.map(x=>{
  const i=snapshotWith(f,x,worker);
  fs.rmSync(path.join(f.root,i.submissionPath));
  return i;
 });
}
export function p5Fixture(id){
 const f=fixture(id,{flowCount:1});
 const schema=fs.readFileSync(path.resolve('scripts/tests/lite-solo-v4-acceptance/fixtures/PHASE_05_SCHEMA_v1.json'),'utf8');
 writeFile(f.root,'Audit Skill - Lite-Solo Authority/lite-solo-v4/phases/phase-5/PHASE_05_SCHEMA_v1.json',schema);
 const dir=get(f.root,f.directoryPath);dir.currentAssignment.phaseSequence=5;
 const base=f.campaign+'/work/phase-05/shards';
 dir.currentAssignment.workShardIndexPath=base+'/INDEX_v1.json';
 put(f.root,f.directoryPath,dir);
 const records=[
  {field:'economicReviewRecords',step:'step-1',key:'ECON-1',value:{recordKey:'ECON-1',sourceAnchor:'Fixture.sol:L3',valueFlowOrFormula:'balance grows as deposited',
   unitsAndBounds:'wei 0..100',boundaryCases:'zero deposit',roundingPrecision:'integer down',
   incentiveExtractionAnalysis:'no extraction',solvencyOrConservationAnalysis:'no loss',conclusion:'SAFE',relatedCandidateKeys:[]}},
  {field:'reconciliationRecords',step:'step-2',key:'RECON-1',value:{subjectKey:'C-ONE',subjectType:'CANDIDATE',priorConclusion:'UNCERTAIN',phase5Observation:'Observed source path',
   disposition:'REQUIRES_TEST',rationale:'Decisive sequence is needed',sourceAnchor:'Fixture.sol:L3',downstreamValidationNeed:'target sequence'}},
  {field:'targetDesigns',step:'step-3',key:'TARGET-1',value:{candidateKey:'C-ONE',setup:'Deploy synthetic fixture',
   prerequisites:'Source accepted',transactionSequence:'call review1()',oracle:'Return 1',
   fuzzVariablesAndBounds:'uint 0..1',snapshotReuseSafety:'One call, clean state',
   expectedSecurityProperty:'No mutation',executionMethod:'NOT_APPLICABLE',
   reproductionType:'NOT_APPLICABLE',expectedMachineObservation:'returns one'}},
 ];
 const desc=[];
 for(const [i,r] of records.entries()){
  const filename='SLAB_'+i+'.json';
  put(f.root,base+'/'+filename,{entries:[{key:r.key,value:r.value}]});
  desc.push({path:['actions',r.step,r.field],file:filename,startIndex:0,append:false});
 }
 put(f.root,base+'/PAGE_v1.json',{shards:desc});
 put(f.root,base+'/INDEX_v1.json',{phase:5,pages:[{file:'PAGE_v1.json'}]});
 const plan=()=>createUnitPlanV1({root:f.root,campaignPath:f.campaign,directory:get(f.root,f.directoryPath),phase:5});
 const stateRel=f.campaign+'/work/phase-05/units/UNIT_QUEUE_STATE_v1.json';
 const request=(op,worker,id,extra={})=>({...f.request(op,worker,id,extra),phaseSequence:5});
 const process=r=>{
  const d=get(f.root,f.directoryPath),v=processUnitRequestV1({root:f.root,campaignPath:f.campaign,
    directory:d,request:r});
  put(f.root,f.directoryPath,d);return v;
 };
 const p5snapshot=(u,worker)=>{
  const planIndex=get(f.root,f.campaign+'/work/phase-05/units/UNIT_PLAN_INDEX_v1.json');
  const page=planIndex.pages.map(p=>get(f.root,p.path)).flatMap(x=>x.units);
  const item=page.find(x=>x.unitId===u.unitId);
  const val=records.find(r=>r.field===item.field);
  const data={schemaVersion:'curveyield-lite-solo-unit-submission-v1',entries:[{key:val.key,value:val.value}]};
  const rel=f.campaign+'/work/phase-05/units/'+u.unitId+'/submissions/'+worker+
    '/epoch-'+u.claimEpoch+'/SUBMISSION_ATTEMPT_001_v1.json';
  const body=json(data);writeFile(f.root,rel,body);
  return {unitId:u.unitId,claimEpoch:u.claimEpoch,claimToken:u.claimToken,
   packetSha256:u.packetSha256,unitSpecRevision:u.unitSpecRevision,
   submissionPath:rel,submissionSha256:digest(body)};
 };
 return {...f,records,plan,state:()=>get(f.root,stateRel),stateRel,request,process,
  p5snapshot,claim:(worker,id)=>process(request('CLAIM',worker,id,{desiredUnitCount:10})).claimedUnits,
  submit:(worker,id,items)=>process(request('SUBMIT',worker,id,{items}))};
}
