import test from 'node:test';
import assert from 'node:assert/strict';
import {planSemanticBatchesV1} from '../../../lib/lite-solo-semantic-batches-v1.mjs';
import {p5Fixture,get,put,json,digest,writeFile} from '../support/next-context.mjs';

const member=(i,context='CTX-CONTEXT')=>({
 unitId:'P4-RC-'+String(i).padStart(3,'0'),kind:'SHARD',field:'discoveryReconciliationRecords',
 path:['actions','step-1','outputs','discoveryReconciliationRecords'],recordIndex:i-1,
 recordKeys:['DISC-'+String(i).padStart(4,'0')],initialValue:{
  recordKey:'DISC-'+String(i).padStart(4,'0'),
  contextIds:[context],sourceAnchor:'Fixture.sol:L10-L24',
  reviewerFinding:'Unresolved ACCESS_CONTROL',attackerFinding:'NO_SUBMISSION'
 }
});

test('Phase 4 batches original context observations without losing keys or merging proof units',()=>{
 const source=Array.from({length:621},(_,i)=>member(i+1,'CTX-'+String(Math.floor(i/4)).padStart(4,'0')));
 source.push({unitId:'X-001',kind:'ATTACK'}, {unitId:'P6-P-001',kind:'SHARD',field:'candidateProofRecords'});
 const a=planSemanticBatchesV1(source,4),b=planSemanticBatchesV1(source,4);
 assert.deepEqual(a,b,'source-bound plan must be deterministic');
 assert.equal(a.originalRecordCount,621);
 assert.equal(a.batchedUnitIds.length,621);
 assert.equal(new Set(a.batches.flatMap(p=>p.memberUnitIds)).size,621);
 assert.equal(a.batches.flatMap(p=>p.members).length,621);
 assert.ok(a.batches.length<80,'context packing must substantially reduce queue fragmentation');
 assert.ok(a.unbatchedUnitIds.includes('X-001'));
 assert.ok(a.unbatchedUnitIds.includes('P6-P-001'));
 assert.ok(a.batches.some(p=>p.groupKeys.includes('CTX-0000')&&p.memberUnitIds.length>=4));
});

test('Phase 5 controller retains individual accepted siblings and candidate-specific target eligibility',()=>{
 const f=p5Fixture('semantic-batching');
 try{
  const base=f.campaign+'/work/phase-05/shards/';
  const econ=get(f.root,base+'SLAB_0.json'),recon=get(f.root,base+'SLAB_1.json');
  econ.entries[0].value.relatedCandidateKeys=['C-ONE'];
  for(let i=2;i<=12;i++){
   const v=structuredClone(econ.entries[0].value);
   v.recordKey='ECON-'+i;v.relatedCandidateKeys=['C-TWO'];
   econ.entries.push({key:'ECON-'+i,value:v});
   const r=structuredClone(recon.entries[0].value);
   r.subjectKey='C-TWO';r.sourceAnchor='Fixture.sol:L'+(i+2);
   recon.entries.push({key:'RECON-'+i,value:r});
  }
  put(f.root,base+'SLAB_0.json',econ);put(f.root,base+'SLAB_1.json',recon);
  f.plan();
  const queued=f.state();
  const ids=Object.keys(queued.units);
  assert.equal(ids.length,3,'12 economic + 12 reconciliations should become two units plus target');
  const econId=ids.find(x=>x.startsWith('P5-E-B'));
  const reconId=ids.find(x=>x.startsWith('P5-R-B'));
  const targetId=ids.find(x=>x.startsWith('P5-T-'));
  assert.ok(econId&&reconId&&targetId);
  assert.equal(queued.units[targetId].status,'BLOCKED_DEPENDENCY');
  const claimed=f.claim('batched-worker','batch-claim-1');
  assert.deepEqual(new Set(claimed.map(x=>x.unitId)),new Set([econId,reconId]));
  const findClaim=id=>claimed.find(x=>x.unitId===id);
  const snapshot=(id,sourceEntries,first,last,attempt)=>{
   const u=findClaim(id),entries=sourceEntries.slice(first,last);
   const data={schemaVersion:'curveyield-lite-solo-unit-submission-v1',entries};
   const rel=f.campaign+'/work/phase-05/units/'+id+'/submissions/batched-worker/epoch-'+u.claimEpoch+
    '/SUBMISSION_ATTEMPT_'+String(attempt).padStart(3,'0')+'_v1.json';
   const body=json(data);writeFile(f.root,rel,body);
   return {unitId:id,claimEpoch:u.claimEpoch,claimToken:u.claimToken,
    packetSha256:u.packetSha256,unitSpecRevision:u.unitSpecRevision,
    submissionPath:rel,submissionSha256:digest(body)};
  };
  const firstE=snapshot(econId,econ.entries,0,1,1);
  const firstR=snapshot(reconId,recon.entries,0,1,1);
  const partial=f.submit('batched-worker','batch-partial',[firstE,firstR]);
  assert.equal(partial.reworkUnits.length,2);
  assert.equal(f.state().acceptedRecords['P5-E-001'].status,'ACCEPTED');
  assert.equal(f.state().acceptedRecords['P5-R-001'].status,'ACCEPTED');
  assert.equal(f.state().units[targetId].status,'AVAILABLE',
   'unrelated deficient siblings must not block accepted candidate prerequisites');
  const acceptedE=f.state().acceptedRecords['P5-E-001'].snapshotSha256;
  const acceptedR=f.state().acceptedRecords['P5-R-001'].snapshotSha256;
  const target=f.process(f.request('CLAIM','target-worker','target-claim',
   {lane:'P5-T',desiredUnitCount:1})).claimedUnits;
  assert.equal(target.length,1);
  assert.equal(target[0].unitId,targetId);
  const restE=snapshot(econId,econ.entries,1,12,2);
  const restR=snapshot(reconId,recon.entries,1,12,2);
  const done=f.submit('batched-worker','batch-complete',[restE,restR]);
  assert.deepEqual(new Set(done.acceptedUnits),new Set([econId,reconId]));
  assert.equal(Object.keys(f.state().acceptedRecords).length,24);
  assert.equal(f.state().acceptedRecords['P5-E-001'].snapshotSha256,acceptedE);
  assert.equal(f.state().acceptedRecords['P5-R-001'].snapshotSha256,acceptedR);
  assert.equal(f.state().units[econId].status,'ACCEPTED');
  assert.equal(f.state().units[reconId].status,'ACCEPTED');
 }finally{f.cleanup()}
});
