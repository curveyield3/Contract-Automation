import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fixture,evidence,git,get} from '../support/context.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,deadline=60000){
 const end=Date.now()+deadline;
 while(!check()){
  if(Date.now()>end)throw Error('A02 concurrent worker barrier timeout');
  await sleep(45);
 }
}
test('A02: eight OS workers concurrently claim 80 disjoint units through real git CAS',async()=>{
 const f=fixture('A02',{flowCount:100}),details={};const children=[];
 try{
  f.plan();
  git(f.root,'init','-b','main');git(f.root,'add','-A');
  git(f.root,'-c','user.name=Lite Acceptance','-c','user.email=accept@example.test',
   'commit','-m','acceptance isolated baseline');
  const remote=path.join(f.temp,'remote.git');
  git(f.temp,'init','--bare','--initial-branch=main',remote);
  git(f.root,'remote','add','origin',remote);git(f.root,'push','origin','main');
  const barrier=path.join(f.temp,'barrier');fs.mkdirSync(barrier);
  const workerFile=path.resolve('scripts/tests/lite-solo-v4-acceptance/support/claim-worker.mjs');
  const workers=Array.from({length:8},(_,i)=>'agent-A02-'+String.fromCharCode(97+i));
  const exits=workers.map(workerId=>{
   const checkout=path.join(f.temp,workerId);
   git(f.temp,'clone','--quiet','--branch','main',remote,checkout);
   const child=spawn(process.execPath,[workerFile,checkout,f.campaign,
    f.directoryPath,barrier,workerId],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
   children.push(child);
   let stderr='';
   child.stderr.on('data',x=>stderr+=x.toString());
   return new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(Error(workerId+' exit '+code+
     '\n'+stderr+'\n'+(fs.existsSync(path.join(barrier,'error-'+workerId+'.txt'))?
      fs.readFileSync(path.join(barrier,'error-'+workerId+'.txt'),'utf8'):''))));
   });
  });
  await until(()=>workers.every(w=>fs.existsSync(path.join(barrier,'ready-'+w))),50000);
  const first=workers.map(w=>get(barrier,'ready-'+w));
  assert.ok(first.every(v=>JSON.stringify(v)===JSON.stringify(first[0])),
   'barrier must force eight workers to race on the same initial queue revision');
  fs.writeFileSync(path.join(barrier,'go'),'released\n');
  await Promise.all(exits);
  const results=workers.map(w=>get(barrier,'result-'+w+'.json'));
  const all=results.flatMap(x=>x.claimedUnits);
  const conflicts=results.reduce((n,x)=>n+x.conflicts,0);
  assert.ok(conflicts>=1,'real git non-fast-forward conflicts must occur');
  assert.ok(results.every(x=>x.claimedUnits.length===10));
  assert.equal(new Set(all).size,80,'80 unique claimed IDs');
  const verifier=path.join(f.temp,'verify');
  git(f.temp,'clone','--quiet','--branch','main',remote,verifier);
  const state=get(verifier,f.stateRel);
  assert.equal(Object.values(state.units).filter(x=>x.status==='CLAIMED').length,80);
  assert.equal(Object.values(state.units).filter(x=>x.status==='AVAILABLE').length,20);
  for(const result of results)for(const id of result.claimedUnits)
   assert.equal(state.units[id].workerId,result.workerId);
  details.workers=results;details.conflicts=conflicts;details.finalRevision=state.revision;
  details.claimedCount=80;details.availableCount=20;
  evidence('A02','LOCAL','PASS',details);
 }catch(e){
  details.error=String(e.stack??e);
  evidence('A02','LOCAL','FAIL',details);throw e;
 }finally{
  for(const child of children)if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');
  f.cleanup();
 }
});
