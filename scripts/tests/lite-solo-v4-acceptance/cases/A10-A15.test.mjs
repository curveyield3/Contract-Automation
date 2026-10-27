import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {reviewInventoryRelV1} from '../../../../packages/github-native-sim/src/adr-review-inventory-v1.mjs';
import {fixture,evidence,digest,json,get,put,writeFile,claim,submit,release,pendingItems,
 snapshotWith,acceptedHashes,rawHash,p5Fixture,git,correctSubmission} from '../support/next-context.mjs';
const run=(id,make,fn)=>test(id,async()=>{
 const f=make(),details={};
 try{await fn(f,details);evidence(id,'LOCAL','PASS',details)}
 catch(e){details.error=String(e.stack??e);evidence(id,'LOCAL','FAIL',details);throw e}
 finally{f.cleanup();}
});
run('A10',()=>p5Fixture('A10'),async(f,d)=>{
 f.plan();const owner='A10-owner',batch=f.claim(owner,'A10-initial');
 assert.equal(batch.length,2);
 const recon=batch.find(x=>x.unitId.startsWith('P5-R-'));
 const econ=batch.find(x=>x.unitId.startsWith('P5-E-'));
 assert.ok(recon&&econ);
 const item=f.p5snapshot(recon,owner),file=path.join(f.root,item.submissionPath);
 fs.rmSync(file);
 const pending=f.submit(owner,'A10-waiting',[item]);
 assert.equal(pending.waitingUnits.length,1);
 const claimAgain=f.claim('A10-second','A10-blocked');
 assert.equal(claimAgain.length,0);
 const target='P5-T-001';
 assert.equal(f.state().units[target].status,'BLOCKED_DEPENDENCY');
 const blocked=f.process(f.request('CLAIM','A10-target','A10-target-only',{lane:'P5-T',desiredUnitCount:10}));
 assert.equal(blocked.claimedUnits.length,0);
 d.stage='P5 R submitted but not accepted; target denied';d.status=blocked.status;
});
run('A11',()=>p5Fixture('A11'),async(f,d)=>{
 f.plan();const owner='A11-owner',batch=f.claim(owner,'A11-initial');
 const recon=batch.find(x=>x.unitId.startsWith('P5-R-'));
 assert.ok(recon);
 assert.equal(f.state().units['P5-T-001'].status,'BLOCKED_DEPENDENCY');
 const completed=f.submit(owner,'A11-accept-recon',[f.p5snapshot(recon,owner)]);
 assert.deepEqual(completed.acceptedUnits,[recon.unitId]);
 assert.equal(f.state().units['P5-T-001'].status,'AVAILABLE');
 const target=f.claim('A11-worker2','A11-next');
 assert.deepEqual(target.map(x=>x.unitId),['P5-T-001']);
 assert.equal(f.state().units['P5-E-001'].status,'CLAIMED');
 d.dependsOn=recon.unitId;d.claimed=target[0].unitId;
});
run('A12',()=>fixture('A12',{flowCount:12}),async(f,d)=>{
 f.plan();const worker='A12-owner',batch=claim(f,worker,'A12-claim');
 const five=batch.slice(0,5),items=five.map(u=>snapshotWith(f,u,worker));
 const bad=correctSubmission(f.packet(five[4].unitId));bad.rows[0].specInspection=null;
 items[4]=snapshotWith(f,five[4],worker,bad,2);
 // The sixth independent unit is substantively started before controller feedback.
 const sixth=f.packet(batch[5].unitId),draft=correctSubmission(sixth);
 snapshotWith(f,batch[5],worker,draft);
 d.trace=['SUBMIT_COMMITTED','NEXT_UNIT_STARTED'];
 const result=submit(f,worker,'A12-partial',items);
 d.trace.push('REWORK_RECEIVED');
 assert.equal(result.acceptedUnits.length,4);
 assert.equal(result.reworkUnits.length,1);
 assert.deepEqual(d.trace,['SUBMIT_COMMITTED','NEXT_UNIT_STARTED','REWORK_RECEIVED']);
 const hashes=acceptedHashes(f.state());
 assert.equal(f.state().units[batch[5].unitId].status,'CLAIMED');
 const fixed=snapshotWith(f,five[4],worker,correctSubmission(f.packet(five[4].unitId)),3);
 const repair=submit(f,worker,'A12-correction',[fixed]);
 assert.equal(repair.acceptedUnits.length,1);
 for(const [unit,hash] of Object.entries(hashes))assert.equal(f.state().units[unit].acceptedSha256,hash);
 d.rework=result.reworkUnits;d.untouchedUnit=batch[5].unitId;
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=40000){
 const end=Date.now()+timeout;while(!check()){if(Date.now()>end)throw Error('barrier timeout');await sleep(35);}
}
run('A13',()=>fixture('A13',{flowCount:30}),async(f,d)=>{
 f.plan();
 git(f.root,'init','-b','main');git(f.root,'add','-A');
 git(f.root,'-c','user.name=Acceptance','-c','user.email=accept@example.test','commit','-m','fixture');
 const remote=path.join(f.temp,'remote.git');
 git(f.temp,'init','--bare','--initial-branch=main',remote);
 git(f.root,'remote','add','origin',remote);git(f.root,'push','origin','main');
 const barrier=path.join(f.temp,'barrier');fs.mkdirSync(barrier);
 const workerFile=path.resolve('scripts/tests/lite-solo-v4-acceptance/support/claim-worker.mjs');
 const workers=['A13-worker-a','A13-worker-b'];const children=[],promises=[];
 try{
  for(const worker of workers){
   const checkout=path.join(f.temp,worker);
   git(f.temp,'clone','--quiet','--branch','main',remote,checkout);
   const child=spawn(process.execPath,[workerFile,checkout,f.campaign,f.directoryPath,barrier,worker],
    {cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
   children.push(child);let stderr='';
   child.stderr.on('data',x=>stderr+=x.toString());
   promises.push(new Promise((res,rej)=>{child.once('error',rej);
    child.once('exit',code=>code===0?res():rej(Error(worker+' exit '+code+' '+stderr+
     (fs.existsSync(path.join(barrier,'error-'+worker+'.txt'))?fs.readFileSync(path.join(barrier,'error-'+worker+'.txt'),'utf8'):''))))}));
  }
  await until(()=>workers.every(w=>fs.existsSync(path.join(barrier,'ready-'+w))));
  const first=workers.map(w=>get(barrier,'ready-'+w));
  assert.deepEqual(first[0],first[1],'both read identical queue revision');
  writeFile(barrier,'go','GO');
  await Promise.all(promises);
  const results=workers.map(w=>get(barrier,'result-'+w+'.json'));
  assert.ok(results.some(x=>x.conflicts>0),'git push CAS conflict must occur');
  assert.equal(new Set(results.flatMap(x=>x.claimedUnits)).size,20);
  const verify=path.join(f.temp,'verify');
  git(f.temp,'clone','--quiet','--branch','main',remote,verify);
  const state=get(verify,f.stateRel);
  assert.equal(Object.values(state.units).filter(x=>x.status==='AVAILABLE').length,10);
  for(const row of results)for(const id of row.claimedUnits)assert.equal(state.units[id].workerId,row.workerId);
  d.workers=results;d.staging='NOT_EXECUTED';
 }finally{for(const child of children)if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');}
});
run('A14',()=>fixture('A14',{flowCount:3}),async(f,d)=>{
 f.plan();const first=claim(f,'A14-old','A14-first');
 const unit=first[0],oldDraft=snapshotWith(f,unit,'A14-old'),oldRaw=fs.readFileSync(path.join(f.root,oldDraft.submissionPath));
 const changed=release(f,'A14-old','A14-release',[unit]);
 assert.deepEqual(changed.releasedUnits,[unit.unitId]);
 const next=claim(f,'A14-new','A14-reclaim').find(x=>x.unitId===unit.unitId);
 assert.ok(next);assert.equal(next.claimEpoch,unit.claimEpoch+1);
 const before=rawHash(f);
 const stale=submit(f,'A14-old','A14-stale',[oldDraft]);
 assert.equal(stale.staleUnits.length,1);
 assert.equal(stale.staleUnits[0].unitId,unit.unitId);
 assert.equal(f.state().units[unit.unitId].workerId,'A14-new');
 assert.deepEqual(fs.readFileSync(path.join(f.root,oldDraft.submissionPath)),oldRaw);
 const accepted=snapshotWith(f,next,'A14-new');
 const yes=submit(f,'A14-new','A14-accepted',[accepted]);
 assert.deepEqual(yes.acceptedUnits,[unit.unitId]);
 const hash=f.state().units[unit.unitId].acceptedSha256;
 const tokenBad={...oldDraft,claimEpoch:next.claimEpoch,claimToken:'wrong-token'};
 const tokenStatus=submit(f,'A14-old','A14-token-bad',[tokenBad]);
 assert.equal(tokenStatus.staleUnits.length,1);
 const replay=submit(f,'A14-old','A14-stale',[oldDraft]);
 assert.deepEqual(replay,stale);
 assert.equal(f.state().units[unit.unitId].acceptedSha256,hash);
 d.staleDetected=true;d.reclaimEpoch=next.claimEpoch;d.staging='NOT_EXECUTED';
});
run('A15',()=>fixture('A15',{flowCount:5,attackCount:2}),async(f,d)=>{
 // Rename the last two source-review units to residual R units before phase-plan generation.
 const rel=reviewInventoryRelV1(f.root,f.campaign,'FLOW_PLAN_v1.json'),flow=get(f.root,rel);
 flow.payload.reviewUnits[3].unitId='R-001';flow.payload.reviewUnits[4].unitId='R-002';put(f.root,rel,flow);
 f.plan();const owner='A15-flow',batch=claim(f,owner,'A15-FR');
 assert.deepEqual(batch.map(x=>x.unitId),['F-001','F-002','F-003','R-001','R-002']);
 const early=claim(f,'A15-attack','A15-X-early');
 assert.equal(early.length,0);
 const four=batch.slice(0,4).map(u=>snapshotWith(f,u,owner));
 assert.equal(submit(f,owner,'A15-four',four).acceptedUnits.length,4);
 const last=pendingItems(f,batch.slice(4),owner);
 const waiting=submit(f,owner,'A15-last-pending',last);
 assert.equal(waiting.waitingUnits.length,1);
 assert.equal(claim(f,'A15-attack','A15-X-still-blocked').length,0);
 // Restore the exact missing immutable bytes and trigger real validator.
 snapshotWith(f,batch[4],owner);
 const completed=submit(f,owner,'A15-last-pending',last);
 assert.equal(completed.acceptedUnits.length,1);
 assert.equal(f.state().units['X-001'].status,'AVAILABLE');
 assert.equal(f.state().units['X-002'].status,'AVAILABLE');
 const attack1=claim(f,'A15-attacker-a','A15-X-a');
 assert.equal(attack1.length,2);
 assert.equal(f.state().stage,'CORRECTNESS','discovery not reconciled until all X accepted');
 assert.equal(fs.existsSync(path.join(f.root,f.campaign+'/receipts/PHASE_04_RECEIPT_v1.json')),false);
 d.gating='all F/R accepted before any X issued';
 d.reconciliation='not exercised: complete X->P4 prefill requires sealed predecessor fixture';
});
