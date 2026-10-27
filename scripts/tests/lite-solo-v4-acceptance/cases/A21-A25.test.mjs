import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,evidence,digest,json,get,put,writeFile,claim,submit,snapshotWith,
 git,p5Fixture} from '../support/next-context.mjs';
import {processUnitRequestV1,finalizeReadinessV1,markFinalizationV1} from '../../../lib/lite-solo-unit-queue-v1.mjs';
const run=(id,opts,fn)=>test(id,()=>{
 const f=fixture(id,opts),d={};
 try{fn(f,d);evidence(id,'LOCAL','PASS',d)}
 catch(e){evidence(id,'LOCAL','FAIL',{...d,error:String(e.stack||e)});throw e}
 finally{f.cleanup();}
});
run('A21',{flowCount:15},(f,d)=>{
 f.plan();const worker='a21';const u=claim(f,worker,'a21-initial')[0];
 const file=snapshotWith(f,u,worker);
 const request=f.request('SUBMIT',worker,'a21-durable-1',{items:[file]});
 const rdir='process/agent-upload/lite-solo-unit-requests/'+f.directory.campaignId;
 writeFile(f.root,rdir+'/'+worker+'-'+request.requestId+'.json',json(request));
 // Controller notification for this immutable request is intentionally dropped.
 assert.equal(f.state().units[u.unitId].status,'CLAIMED');
 assert.ok(fs.existsSync(path.join(f.root,rdir+'/'+worker+'-'+request.requestId+'.json')));
 const unrelated=f.request('CLAIM','a21-later','a21-later-run',{desiredUnitCount:10});
 const later=f.process(unrelated);assert.equal(later.claimedUnits.length,10);
 // Recovery reads ALL persisted immutable requests, not just latest event.
 const recovered=get(f.root,rdir+'/'+worker+'-'+request.requestId+'.json');
 const result=f.process(recovered);
 assert.deepEqual(result.acceptedUnits,[u.unitId]);
 const replay=f.process(recovered);assert.deepEqual(replay,result);
 assert.equal(f.state().units[u.unitId].attempts,1);
 d.recoveredRequest=request.requestId;d.status='LOCAL_PASS; STAGING_NOT_EXECUTED: actual canceled Actions run not observed';
});
run('A22',{flowCount:142},(f,d)=>{
 f.plan();const worker='a22';const units=[];
 for(let i=0;i<12;i++)units.push(...claim(f,worker,'a22-claim-'+i));
 assert.equal(units.length,120);
 const manifest=[],results=[];
 for(let i=0;i<units.length;i++){
  const reqId='a22-sub-'+String(i+1).padStart(3,'0');
  const item=snapshotWith(f,units[i],worker),r=f.request('SUBMIT',worker,reqId,{items:[item]});
  const ingress='process/agent-upload/lite-solo-unit-requests/'+f.directory.campaignId+'/'+worker+'-'+reqId+'.json';
  writeFile(f.root,ingress,json(r));manifest.push({id:reqId,ingress,item});
 }
 assert.equal(new Set(manifest.map(m=>m.id)).size,120);
 // Only twenty events are assumed delivered. The actual durable request contents
 // are enumerated completely by the equivalent persisted ingress directory.
 const root=path.join(f.root,'process/agent-upload/lite-solo-unit-requests',f.directory.campaignId);
 const filenames=fs.readdirSync(root).sort();assert.equal(filenames.length,120);
 for(const name of filenames){
  const request=get(root,name),result=f.process(request);
  assert.equal(result.acceptedUnits.length,1,'all durable requests must be accepted');
  results.push({id:request.requestId,unit:result.acceptedUnits[0]});
 }
 const prev=Object.values(f.state().units).filter(x=>x.status==='ACCEPTED').length;
 for(const name of filenames){const request=get(root,name);f.process(request);}
 assert.equal(Object.values(f.state().units).filter(x=>x.status==='ACCEPTED').length,prev);
 assert.deepEqual(new Set(results.map(x=>x.id)),new Set(manifest.map(x=>x.id)));
 assert.equal(prev,120);
 d.totalCommitted=120;d.totalTerminal=results.length;d.accepted=prev;
 d.status='LOCAL_PASS; STAGING_NOT_EXECUTED: 120-file external GitHub backlog not exercised';
});
run('A23',{flowCount:12},(f,d)=>{
 f.plan();
 const other=fixture('A23-other',{flowCount:12});
 try{
  other.plan();
  const a=claim(f,'a23-alpha','a23-alpha-claim');
  const b=claim(other,'a23-beta','a23-beta-claim');
  assert.equal(a.length,10);assert.equal(b.length,10);
  assert.notEqual(f.directory.campaignId,other.directory.campaignId);
  assert.equal(f.state().units['F-001'].workerId,'a23-alpha');
  assert.equal(other.state().units['F-001'].workerId,'a23-beta');
  const workflow=fs.readFileSync(path.resolve('.github/workflows/lite-solo-unit-controller-v1.yml'),'utf8');
  assert.match(workflow,/group:\s*lite-solo-unit-\$\{\{\s*matrix\.campaign\s*\}\}/);
  assert.match(workflow,/cancel-in-progress:\s*false/);
  assert.equal(workflow.includes('group: lite-solo-unit-controller-global'),false);
  d.workers=['a23-alpha','a23-beta'];
  d.status='LOCAL_PASS; STAGING_NOT_EXECUTED: beta-started-before-alpha-release not observed';
 }finally{other.cleanup()}
});
run('A24',{flowCount:30},(f,d)=>{
 f.plan();
 git(f.root,'init','-b','main');git(f.root,'add','-A');
 git(f.root,'-c','user.name=Acceptance','-c','user.email=accept@example.test','commit','-m','baseline');
 const bare=path.join(f.temp,'origin.git');git(f.temp,'init','--bare','--initial-branch=main',bare);
 git(f.root,'remote','add','origin',bare);git(f.root,'push','origin','main');
 const cloneA=path.join(f.temp,'a'),cloneB=path.join(f.temp,'b');
 git(f.temp,'clone','--quiet','--branch','main',bare,cloneA);
 git(f.temp,'clone','--quiet','--branch','main',bare,cloneB);
 const copyProcess=(root,worker,reqId)=>{
  const directory=get(root,f.directoryPath),request=f.request('CLAIM',worker,reqId,{desiredUnitCount:10});
  const controller=processUnitRequestV1({root,campaignPath:f.campaign,directory,request});
  put(root,f.directoryPath,directory);
  git(root,'add','-A');
  git(root,'-c','user.name=Acceptance','-c','user.email=accept@example.test',
   'commit','-m',reqId);
  return controller;
 };
 // Controller publication compares the actual heads and recomputes after conflict.
 const first=copyProcess(cloneA,'a24-agentA','a24-reqA');
 copyProcess(cloneB,'a24-agentB','a24-reqB');
 git(cloneA,'push','origin','HEAD:main');
 assert.throws(()=>git(cloneB,'push','origin','HEAD:main'));
 git(cloneB,'fetch','origin','main');git(cloneB,'reset','--hard','origin/main');
 const recomputed=copyProcess(cloneB,'a24-agentB','a24-reqB');
 git(cloneB,'push','origin','HEAD:main');
 const final=path.join(f.temp,'verified');
 git(f.temp,'clone','--quiet','--branch','main',bare,final);
 const queue=get(final,f.stateRel);
 assert.equal(Object.values(queue.units).filter(x=>x.status==='CLAIMED').length,20);
 assert.equal(queue.units[first.claimedUnits[0].unitId].workerId,'a24-agentA');
 assert.equal(queue.units[recomputed.claimedUnits[0].unitId].workerId,'a24-agentB');
 assert.equal(new Set([...first.claimedUnits,...recomputed.claimedUnits].map(u=>u.unitId)).size,20);
 d.nonFastForwardObserved=true;d.recomputedAfterHeadRefresh=true;
 d.status='LOCAL_PASS claim-state CAS; STAGING_NOT_EXECUTED approval conflict with real controller';
});
run('A25',{flowCount:3},(f,d)=>{
 f.plan();
 const first=claim(f,'a25-worker','a25-claim');
 const one=submit(f,'a25-worker','a25-only-one',[snapshotWith(f,first[0],'a25-worker')]);
 assert.equal(one.acceptedUnits.length,1);
 const readiness=finalizeReadinessV1({root:f.root,campaignPath:f.campaign,
  directory:get(f.root,f.directoryPath),phase:4});
 assert.equal(readiness.ready,false);
 assert.equal(fs.existsSync(path.join(f.root,f.campaign+'/receipts/PHASE_04_RECEIPT_v1.json')),false);
 assert.throws(()=>f.process(f.request('FINALIZE','a25-worker','a25-forged')),/controller-internal/i);
 d.negativeGate=readiness.reason;d.status='PARTIAL: no complete 4/5/6 existing boundary seal fixtures';
});
