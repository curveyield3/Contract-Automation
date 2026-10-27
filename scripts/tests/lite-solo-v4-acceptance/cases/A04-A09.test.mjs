import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,evidence,digest,json,get,writeFile,claim,submit,release,pendingItems,
 snapshotWith,acceptedHashes,rawHash,correctSubmission} from '../support/next-context.mjs';
import {readUnitPacketIndexV1} from '../../../../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';
const run=(id,fn)=>(test(id,()=>{
 const f=fixture(id,{flowCount:id==='A04'?10:Math.max(15,id==='A09'?27:15),heavy:id==='A04'}),d={};
 try{fn(f,d);evidence(id,'LOCAL','PASS',d)}
 catch(e){d.error=String(e.stack??e);evidence(id,'LOCAL','FAIL',d);throw e}
 finally{f.cleanup()}
}));
run('A04',(f,d)=>{
 // Large, valid, independently documented obligations; the real production packet writer
 // performs source-doc discovery and lossless 24 KiB packet section pagination.
 const docs=[];
 for(let i=1;i<=120;i++)
  for(let j=0;j<14;j++)
   docs.push('review'+i+' must preserve exactly the deterministic return semantics under obligation '+j+' with a source-bound documented invariant.');
 writeFile(f.root,f.campaign+'/source/README.md',docs.join('\n')+'\n');
 f.plan();
 const ids=f.units.slice(0,10),packetIndex=[];
 let total=0,effort=0,ruleCount=0,sectionPages=0;
 for(const id of ids){
  const p=f.packet(id).payload,entry=f.campaign+'/index/flow-review/UNIT_'+id+'_INDEX_v1.json';
  const ix=readUnitPacketIndexV1({root:f.root,indexPath:entry});
  assert.deepEqual(ix.primaryContextIds,p.primaryContextIds);
  const expected=new Set((p.documentationItems??[]).map(x=>x.ruleId));
  const actual=new Set();
  for(const page of ix.sectionPages){
   const full=path.join(f.root,page.path),bytes=fs.statSync(full).size;
   assert.ok(bytes<=24576,'packet page must be <=24KiB '+page.path);
   const val=get(f.root,page.path);
   if(val.section==='documentationItems')for(const item of val.items){
    if(item.kind==='JSON_FRAGMENT_BASE64')continue;actual.add(item.ruleId);
   }
   sectionPages++;
  }
  assert.deepEqual(actual,expected,'no documented rule omitted from section pages '+id);
  ruleCount+=expected.size;effort+=2*p.primaryContexts.length+Math.ceil(expected.size/3);
  total+=Buffer.byteLength(json(p));
  packetIndex.push(ix.sectionPages.length);
 }
 d={...d,total,effort,ruleCount,sectionPages,packetIndex};
 assert.ok(total>262144,'all 10 combined packets must exceed historical 256KiB window');
 assert.ok(effort>150,'historical effort cap must be exceeded');
 const batch=claim(f,'A04-worker','A04-claim-1');
 assert.equal(batch.length,10);
 assert.deepEqual(batch.map(x=>x.unitId),ids);
});
run('A05',(f,d)=>{
 f.plan();const worker='A05-worker',units=claim(f,worker,'A05-claim');
 const initial=units.slice(0,2).map(u=>snapshotWith(f,u,worker));
 const response=submit(f,worker,'A05-submit-2',initial);
 assert.deepEqual(response.acceptedUnits,units.slice(0,2).map(u=>u.unitId));
 assert.equal(Object.values(f.state().units).filter(s=>s.status==='CLAIMED').length,8);
 for(const item of initial)assert.equal(f.state().units[item.unitId].acceptedSha256,item.submissionSha256);
 const prev=rawHash(f);
 for(const [name,items] of [['empty',[]],['overlarge',Array.from({length:6},()=>initial[0])]]){
  assert.throws(()=>submit(f,worker,'A05-'+name,items));
  assert.equal(rawHash(f),prev,'invalid batch cannot mutate queue');
 }
 const third=submit(f,worker,'A05-submit-1',[snapshotWith(f,units[2],worker)]);
 assert.equal(third.acceptedUnits.length,1);
 d.accepted=third.acceptedUnits.concat(response.acceptedUnits);
});
run('A06',(f,d)=>{
 writeFile(f.root,f.campaign+'/source/README.md',
  'review5 must return its fixed constant and never mutate state.\n');
 f.plan();const worker='A06-worker',units=claim(f,worker,'A06-claim').slice(0,5);
 const items=units.map(u=>snapshotWith(f,u,worker));
 const fifth=units[4],p=f.packet(fifth.unitId);
 const valid=correctSubmission(p);
 assert.ok(valid.rows[0].documentedRules.length>0,'must test a genuine required documented comparison');
 delete valid.rows[0].documentedRules[0].reason;
 const invalid=snapshotWith(f,fifth,worker,valid,2);items[4]=invalid;
 const first=submit(f,worker,'A06-batch-5',items);
 assert.equal(first.acceptedUnits.length,4);
 assert.equal(first.reworkUnits.length,1);
 assert.equal(first.reworkUnits[0].unitId,fifth.unitId);
 const errors=first.reworkUnits[0].errors;
 assert.ok(errors.some(e=>String(e.path).includes('documentedRules[0]')),'nested missing reason in feedback');
 const saved=acceptedHashes(f.state());
 const fixed=snapshotWith(f,fifth,worker,correctSubmission(p),3);
 const second=submit(f,worker,'A06-repair',[fixed]);
 assert.deepEqual(second.acceptedUnits,[fifth.unitId]);
 for(const [id,hash] of Object.entries(saved))assert.equal(f.state().units[id].acceptedSha256,hash);
 const replay=submit(f,worker,'A06-batch-5',items);
 assert.deepEqual(replay,first);
 assert.equal(f.state().units[fifth.unitId].acceptedSha256,fixed.submissionSha256);
 d={...d,rework:errors,acceptedAfter:Object.keys(acceptedHashes(f.state()))};
});
run('A07',(f,d)=>{
 f.plan();const worker='A07-worker',units=claim(f,worker,'A07-claim').slice(0,5),
 items=units.map(u=>snapshotWith(f,u,worker));
 const response=submit(f,worker,'A07-req-7',items);
 assert.equal(response.acceptedUnits.length,5);
 const hash=rawHash(f),accepted=acceptedHashes(f.state());
 for(let i=0;i<2;i++){
  const replay=submit(f,worker,'A07-req-7',items);
  assert.deepEqual(replay,response);assert.equal(rawHash(f),hash);
 }
 const changed=[...items];changed[0]={...changed[0],submissionSha256:'0'.repeat(64)};
 assert.throws(()=>submit(f,worker,'A07-req-7',changed),/request ID reused/i);
 assert.equal(rawHash(f),hash);
 assert.deepEqual(acceptedHashes(f.state()),accepted);
 d.replayed=2;d.accepted=5;d.stateDigest=hash;
});
run('A08',(f,d)=>{
 f.plan();const worker='A08-worker',units=claim(f,worker,'A08-claim');
 const first=units.slice(0,5).map(u=>snapshotWith(f,u,worker));
 // Author and durably write pending approvals, without running the controller drainer.
 for(const item of first)assert.ok(fs.existsSync(path.join(f.root,item.submissionPath)));
 const pending=f.request('SUBMIT',worker,'A08-queued-batch',{items:first});
 const reqRel='process/agent-upload/lite-solo-unit-requests/'+f.directory.campaignId+'/'+worker+'-'+pending.requestId+'.json';
 writeFile(f.root,reqRel,json(pending));
 d.trace=['SUBMIT_COMMITTED'];
 const next=f.packet(units[5].unitId),review=correctSubmission(next);
 const nextItem=snapshotWith(f,units[5],worker,review);
 assert.ok(fs.existsSync(path.join(f.root,nextItem.submissionPath)));
 d.trace.push('NEXT_UNIT_SOURCE_READ');
 assert.ok(units.slice(0,5).every(u=>f.state().units[u.unitId].status==='CLAIMED'));
 assert.equal(f.state().units[units[5].unitId].status,'CLAIMED');
 const result=submit(f,worker,pending.requestId,first);
 d.trace.push('CONTROLLER_RESULT');assert.equal(result.acceptedUnits.length,5);
 assert.deepEqual(d.trace,['SUBMIT_COMMITTED','NEXT_UNIT_SOURCE_READ','CONTROLLER_RESULT']);
 d.mode='manual worker sequence using real packets; NO production worker-loop export established';
});
run('A09',(f,d)=>{
 f.plan();const worker='A09-worker',ten=claim(f,worker,'A09-first-claim');
 assert.equal(ten.length,10);
 for(let j=0;j<2;j++){
  const slice=ten.slice(j*5,j*5+5),items=pendingItems(f,slice,worker);
  const result=submit(f,worker,'A09-pending-'+j,items);
  assert.equal(result.waitingUnits.length,5);
 }
 for(const u of ten)assert.equal(f.state().units[u.unitId].status,'SUBMITTED');
 const next=claim(f,worker,'A09-second-claim');assert.equal(next.length,10);
 assert.equal(new Set([...next,...ten].map(x=>x.unitId)).size,20);
 assert.equal(Object.values(f.state().units).filter(x=>x.status==='SUBMITTED').length,10);
 assert.ok(f.packet(next[0].unitId).payload.primaryContextIds.length);
 d.pending=10;d.newlyClaimed=10;
});
