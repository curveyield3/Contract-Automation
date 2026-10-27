import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,evidence,claim,submit,snapshotWith,pendingItems,
 get,put,writeFile,digest,json,p5Fixture} from '../support/next-context.mjs';
import {p6Fixture} from '../support/phase6-context.mjs';
import {createUnitPlanV1} from '../../../lib/lite-solo-unit-queue-v1.mjs';
const run=(id,make,fn)=>test(id,()=>{
 const f=make(),d={};
 try{fn(f,d);evidence(id,'LOCAL','PASS',d)}
 catch(e){evidence(id,'LOCAL','FAIL',{...d,error:String(e.stack||e)});throw e}
 finally{f.cleanup()}
});
run('A26',()=>fixture('A26',{flowCount:4}),(f,d)=>{
 const directory=get(f.root,f.directoryPath);
 directory.authorityRelease='lite-solo-v3';
 directory.executionModel='SOLO';
 put(f.root,f.directoryPath,directory);
 const hash=digest(fs.readFileSync(path.join(f.root,f.directoryPath)));
 assert.throws(()=>createUnitPlanV1({root:f.root,campaignPath:f.campaign,
  directory,phase:4}),/v4.*requires.*v4-bound/i);
 assert.equal(digest(fs.readFileSync(path.join(f.root,f.directoryPath))),hash);
 assert.equal(fs.existsSync(path.join(f.root,f.stateRel)),false);
 const native=fs.readFileSync(path.resolve('scripts/lite-solo-unit-request-drain-v1.mjs'),'utf8');
 assert.match(native,/authorityRelease!=='lite-solo-v4'/);
 const legacy=fs.readFileSync(path.resolve('.github/workflows/lite-solo-phase-controller-v1.yml'),'utf8');
 assert.ok(legacy.length>200);
 d.status='PARTIAL: v4 rejection and legacy route existence verified; v3 staging acceptance NOT_EXECUTED';
});
run('A27',()=>fixture('A27',{flowCount:2}),(f,d)=>{
 f.plan();
 const directory=get(f.root,f.directoryPath);
 const digestBefore=digest(fs.readFileSync(path.join(f.root,f.directoryPath)));
 assert.equal(directory.authorityRelease,'lite-solo-v4');
 const fake={...directory,authorityRelease:'lite-solo-v3'};
 assert.throws(()=>createUnitPlanV1({root:f.root,campaignPath:f.campaign,directory:fake,phase:4}),/v4.*requires.*v4-bound/i);
 assert.equal(digest(fs.readFileSync(path.join(f.root,f.directoryPath))),digestBefore);
 d.authorityDigest=directory.authorityDigest;
 d.status='PARTIAL: release mismatch blocked; historical v3 byte-for-byte tree comparison NOT_EXECUTED';
});
run('A28',()=>fixture('A28',{flowCount:15}),(f,d)=>{
 f.plan();
 const documents=['SKILL.md','PHASE4_START_HERE.md','PHASE5_START_HERE.md','PHASE6_START_HERE.md'];
 const base=path.resolve('scripts/tests/lite-solo-v4-acceptance/fixtures/authority');
 d.guides={};
 for(const name of documents){
  const content=fs.readFileSync(path.join(base,name),'utf8');
  const lines=content.split('\n');
  const always=lines.findIndex(l=>/NEVER WAIT FOR CONTROLLER APPROVAL/i.test(l));
  const continueLines=lines.flatMap((l,i)=>/immediately continue|immediately work on|without approval polling/i.test(l)?[i+1]:[]);
  assert.ok(always>=0,'missing no-wait authority in '+name);
  assert.ok(continueLines.length>0,'missing immediate continuation in '+name);
  d.guides[name]={noWaitLine:always+1,continueLines};
 }
 const batch=claim(f,'a28-owner','a28-ten');
 const pending=batch.slice(0,5).map(x=>snapshotWith(f,x,'a28-owner'));
 const request=f.request('SUBMIT','a28-owner','a28-queued',{items:pending});
 writeFile(f.root,'process/agent-upload/lite-solo-unit-requests/'+f.directory.campaignId+'/a28-owner-a28-queued.json',json(request));
 // Worker continues independent substantive work with queued approval untouched.
 const draft=snapshotWith(f,batch[5],'a28-owner');
 assert.ok(fs.existsSync(path.join(f.root,draft.submissionPath)));
 assert.equal(f.state().units[batch[5].unitId].status,'CLAIMED');
 d.status='PARTIAL: authority guides + Phase4 held-approval trace; Phase5/6 actual worker loops NOT_EXECUTED';
});
run('A29',()=>p6Fixture('A29',{baseline:115,proof:110}),(f,d)=>{
 // Large real-schema Phase 6 prefills; every group retains its immutable key.
 const base=f.campaign+'/work/phase-06/shards';
 for(const row of f.rows){
  const rel=base+'/'+row.filename,slab=get(f.root,rel);
  if(row.field==='baselineTestRecords')slab.entries[0].value.harnessDesign+=' '+('X'.repeat(4000));
  if(row.field==='candidateProofRecords')slab.entries[0].value.reasoning+=' '+('Y'.repeat(4000));
  put(f.root,rel,slab);
 }
 f.plan();
 const index=get(f.root,f.campaign+'/work/phase-06/units/UNIT_PLAN_INDEX_v1.json');
 const pages=index.pages.map(p=>{
  const filename=path.join(f.root,p.path),raw=fs.readFileSync(filename);
  assert.ok(raw.length<=32768);assert.equal(digest(raw),p.sha256);
  return raw.length;
 });
 const units=index.pages.flatMap(p=>get(f.root,p.path).units);
 assert.equal(units.length,225);
 const allKeys=units.map(u=>u.recordKeys[0]);assert.equal(new Set(allKeys).size,225);
 const worker='a29';const batch=f.claim(worker,'a29-claim');
 assert.equal(batch.length,10,'large cumulative data must not underfill batch');
 const maxShard=Math.max(...f.rows.map(r=>fs.statSync(path.join(f.root,base,r.filename)).size));
 assert.ok(maxShard<=65536);
 // Real validator approves five in one batch; never restore a large aggregate per approval.
 const first=batch.slice(0,5).map(x=>f.snap(x,worker));
 const response=f.submit(worker,'a29-five',{items:first});
 assert.equal(response.acceptedUnits.length,5);
 const accepted=Object.entries(f.state().units).filter(([,v])=>v.status==='ACCEPTED').length;
 assert.equal(accepted,5);
 d.unitCount=units.length;d.aggregateBytes=f.rows.reduce((n,r)=>n+fs.statSync(path.join(f.root,base,r.filename)).size,0);
 d.maxShardBytes=maxShard;d.maxPlanPageBytes=Math.max(...pages);
 assert.ok(d.aggregateBytes>65536);
 d.status='PARTIAL: 225-unit Phase6 paging + claims + 5 approvals pass; full aggregate reconstruction/Phase5 NOT_EXECUTED';
});
run('A30',()=>fixture('A30',{flowCount:40}),(f,d)=>{
 f.plan();const owner='a30-worker';
 const first=claim(f,owner,'a30-claim-1');assert.equal(first.length,10);
 const pending=[];
 for(let batch=0;batch<2;batch++){
  const group=pendingItems(f,first.slice(5*batch,5*(batch+1)),owner);
  const req=f.request('SUBMIT',owner,'a30-pending-'+batch,{items:group});
  const rel='process/agent-upload/lite-solo-unit-requests/'+f.directory.campaignId+'/'+owner+'-'+req.requestId+'.json';
  writeFile(f.root,rel,json(req));pending.push({req,group,rel});
  const result=f.process(req);assert.equal(result.waitingUnits.length,5);
 }
 assert.equal(Object.values(f.state().units).filter(s=>s.status==='SUBMITTED').length,10);
 const second=claim(f,owner,'a30-claim-2');assert.equal(second.length,10);
 const draft=snapshotWith(f,second[0],owner);
 const substantive=fs.readFileSync(path.join(f.root,draft.submissionPath),'utf8');
 assert.ok(substantive.includes('verdict'));
 assert.equal(Object.values(f.state().units).filter(s=>s.status==='SUBMITTED').length,10);
 const late=pending[0]; // Restore the exact source-bound bytes and submit pending request again.
 for(let i=0;i<late.group.length;i++){
  const item=late.group[i];
  const unit=first.find(u=>u.unitId===item.unitId);
  const fixed=snapshotWith(f,unit,owner);
  assert.equal(fixed.submissionSha256,item.submissionSha256);
 }
 const result=f.process(late.req);assert.equal(result.acceptedUnits.length,5);
 assert.equal(f.state().units[second[0].unitId].status,'CLAIMED');
 d.pendingBefore=10;d.newBatch=second.length;d.pendingAfter=5;
 d.status='PARTIAL: queue/source continuation verified; real worker loop and GitHub delayed Actions STAGING_NOT_EXECUTED';
});
