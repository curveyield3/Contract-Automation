import fs from 'node:fs';
import path from 'node:path';
import {fixture,digest,json,get,put,writeFile} from './next-context.mjs';
import {createUnitPlanV1,processUnitRequestV1} from '../../../lib/lite-solo-unit-queue-v1.mjs';

export function p6Fixture(id,{baseline=1,proof=1,conclusion=0}={}){
 const f=fixture(id,{flowCount:1});
 const schema=fs.readFileSync(path.resolve('scripts/tests/lite-solo-v4-acceptance/fixtures/PHASE_06_SCHEMA_v1.json'),'utf8');
 writeFile(f.root,'Audit Skill - Lite-Solo Authority/lite-solo-v4/phases/phase-6/PHASE_06_SCHEMA_v1.json',schema);
 const dir=get(f.root,f.directoryPath);dir.currentAssignment.phaseSequence=6;
 const base=f.campaign+'/work/phase-06/shards';
 dir.currentAssignment.workShardIndexPath=base+'/INDEX_v1.json';put(f.root,f.directoryPath,dir);
 const descriptors=[],rows=[];
 const add=(step,field,key,value)=>{
  const filename='SLAB_'+rows.length+'.json';
  put(f.root,base+'/'+filename,{entries:[{key,value}]});
  descriptors.push({path:['actions',step,field],file:filename,startIndex:rows.filter(x=>x.field===field).length,append:false});
  rows.push({field,key,value,filename,step});
 };
 for(let i=0;i<baseline;i++){
  const idd='BASE-'+String(i+1).padStart(3,'0');
  add('step-4','baselineTestRecords',idd,{
    testGroupId:idd,contract:'Fixture',obligationIds:['OB-'+idd],
    obligationsDetail:'Check deterministic return behavior',requestDirectory:'test-bound',
    harnessDesign:'Source-bound deterministic static baseline request',dispatchRounds:[],
    requestPaths:[],obligationOutcomes:[],limitations:'UNEXECUTED: no evidence fixture'});
 }
 for(let i=0;i<proof;i++){
  const idd='C-'+String(i+1).padStart(3,'0');
  add('step-5','candidateProofRecords',idd,{
    candidateKey:idd,sourceAnchor:'Fixture.sol:L3',phase5Result:'INCONCLUSIVE',
    requestDirectory:'test-bound',verdict:'INCONCLUSIVE',harnessDesign:'Open question about fixture behavior',
    dispatchRounds:[],requestPaths:[],ledgerRef:'UNEXECUTED',attackAssertionNames:[],
    controlAssertionNames:[],reasoning:'No decisive source-bound execution evidence; unresolved'});
 }
 for(let i=0;i<conclusion;i++){
  const idd='CONCLUSION-'+i;add('step-3','mergedExecutionConclusions',idd,{recordKey:idd,conclusion:'UNRESOLVED'});
 }
 put(f.root,base+'/PAGE_v1.json',{shards:descriptors});
 put(f.root,base+'/INDEX_v1.json',{phase:6,pages:[{file:'PAGE_v1.json'}]});
 const plan=()=>createUnitPlanV1({root:f.root,campaignPath:f.campaign,directory:get(f.root,f.directoryPath),phase:6});
 const stateRel=f.campaign+'/work/phase-06/units/UNIT_QUEUE_STATE_v1.json';
 const request=(op,worker,id,extra={})=>({...f.request(op,worker,id,extra),phaseSequence:6});
 const process=r=>{
  const d=get(f.root,f.directoryPath);
  const v=processUnitRequestV1({root:f.root,campaignPath:f.campaign,directory:d,request:r});
  put(f.root,f.directoryPath,d);return v;
 };
 const claim=(worker,id)=>process(request('CLAIM',worker,id,{desiredUnitCount:10})).claimedUnits;
 const snap=(u,worker,overrides={})=>{
  const index=get(f.root,f.campaign+'/work/phase-06/units/UNIT_PLAN_INDEX_v1.json');
  const units=index.pages.flatMap(p=>get(f.root,p.path).units);
  const spec=units.find(x=>x.unitId===u.unitId);
  const old=rows.find(x=>x.field===spec.field&&x.key===spec.recordKeys[0]);
  const value={...old.value,...overrides};
  const data={schemaVersion:'curveyield-lite-solo-unit-submission-v1',entries:[{key:old.key,value}]};
  const rel=f.campaign+'/work/phase-06/units/'+u.unitId+'/submissions/'+worker+
   '/epoch-'+u.claimEpoch+'/SUBMISSION_ATTEMPT_001_v1.json';
  const body=json(data);writeFile(f.root,rel,body);
  return {unitId:u.unitId,claimEpoch:u.claimEpoch,claimToken:u.claimToken,
   packetSha256:u.packetSha256,unitSpecRevision:u.unitSpecRevision,
   submissionPath:rel,submissionSha256:digest(body)};
 };
 const submit=(worker,id,items)=>process(request('SUBMIT',worker,id,{items}));
 return {...f,rows,plan,request,process,claim,snap,submit,state:()=>get(f.root,stateRel),stateRel};
}
export function summary(name,status,details={}){
 return {id:name,status,details};
}
