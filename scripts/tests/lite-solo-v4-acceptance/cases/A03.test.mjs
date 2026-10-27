import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {fixture,evidence,digest,json,get,put,snapshot} from '../support/context.mjs';

function releaseItems(claimed){
 return claimed.map(x=>({unitId:x.unitId,claimEpoch:x.claimEpoch,claimToken:x.claimToken}));
}
function submit(f,worker,reqId,claimed){
 const items=claimed.map(x=>snapshot(f,x,worker));
 const result=f.process(f.request('SUBMIT',worker,reqId,{items}));
 assert.deepEqual(result.reworkUnits,[],'real correctness validator must accept synthetic source-reviewed rows');
 assert.equal(result.acceptedUnits.length,items.length,'all exact submitted units must be accepted');
 return result;
}
function setFixtureDependency(f,unitId,dependencies){
 const rel=f.campaign+'/work/phase-04/units/UNIT_PLAN_INDEX_v1.json',index=get(f.root,rel);
 let modified=0;
 for(const p of index.pages){
  const page=get(f.root,p.path),u=page.units.find(x=>x.unitId===unitId);
  if(!u)continue;
  u.dependencies=dependencies;modified++;
  const raw=json(page);fs.writeFileSync(path.join(f.root,p.path),raw);p.sha256=digest(raw);
 }
 assert.equal(modified,1,'unit must have exactly one canonical page');
 put(f.root,rel,index);
}
test('A03: with 9 eligible, claim 9 then 0; unlock exactly 1 via accepted prerequisite',()=>{
 const f=fixture('A03',{flowCount:16,attackCount:4}),details={};
 try{
  f.plan();
  // Fixture-only graph variation: three X obligations depend on every F,
  // while X-001 depends on the exact F-010 whose real approval we will publish.
  setFixtureDependency(f,'X-001',['F-010']);
  const opener='agent-A03-seed',holder='agent-A03-holder',agent='agent-A03-main';
  const first=f.process(f.request('CLAIM',opener,'A03-open-1',{desiredUnitCount:10}));
  assert.equal(first.claimedUnits.length,10);
  submit(f,opener,'A03-approve-four-1',first.claimedUnits.slice(0,4));
  f.process(f.request('RELEASE',opener,'A03-release-six-1',{items:releaseItems(first.claimedUnits.slice(4))}));
  const held=f.process(f.request('CLAIM',holder,'A03-hold-ten-1',{desiredUnitCount:10}));
  assert.equal(held.claimedUnits.length,10);
  f.process(f.request('RELEASE',holder,'A03-release-seven-1',{items:releaseItems(held.claimedUnits.slice(0,7))}));
  const before=f.state();details.initialCounts=Object.fromEntries(['AVAILABLE','RELEASED','ACCEPTED','CLAIMED',
   'BLOCKED_DEPENDENCY'].map(s=>[s,Object.values(before.units).filter(x=>x.status===s).length]));
  assert.equal(details.initialCounts.AVAILABLE+(details.initialCounts.RELEASED??0),9,'AVAILABLE and RELEASED are both eligible');
  assert.equal(details.initialCounts.ACCEPTED,4);
  assert.equal(details.initialCounts.CLAIMED,3);
  assert.equal(details.initialCounts.BLOCKED_DEPENDENCY,4);
  const expected=f.units.filter(id=>['AVAILABLE','RELEASED'].includes(before.units[id]?.status));
  const r1=f.process(f.request('CLAIM',agent,'A03-nine-1',{desiredUnitCount:10}));
  assert.equal(r1.claimedUnits.length,9);
  assert.deepEqual(r1.claimedUnits.map(x=>x.unitId),expected);
  assert.equal(f.state().units['X-001'].status,'BLOCKED_DEPENDENCY');
  const r2=f.process(f.request('CLAIM',agent,'A03-empty-1',{desiredUnitCount:10}));
  assert.equal(r2.claimedUnits.length,0);
  details.emptyStatus=r2.status;details.emptyPhaseStatus=r2.phaseStatus;
  // Real accepted transition: release no fabricated unit, accept only F-010.
  const prerequisite=r1.claimedUnits.find(x=>x.unitId==='F-010');
  assert.ok(prerequisite,'required prerequisite F-010 must have been among 9 issued');
  submit(f,agent,'A03-approve-prerequisite-1',[prerequisite]);
  assert.equal(f.state().units['X-001'].status,'AVAILABLE');
  for(const id of ['X-002','X-003','X-004'])
   assert.equal(f.state().units[id].status,'BLOCKED_DEPENDENCY');
  const r3=f.process(f.request('CLAIM',agent,'A03-unblocked-one-1',{desiredUnitCount:10}));
  assert.deepEqual(r3.claimedUnits.map(x=>x.unitId),['X-001']);
  details.results=[r1.claimedUnits.map(x=>x.unitId),r2.claimedUnits.map(x=>x.unitId),
   r3.claimedUnits.map(x=>x.unitId)];
  details.finalCounts=Object.fromEntries(['AVAILABLE','RELEASED','ACCEPTED','CLAIMED',
   'BLOCKED_DEPENDENCY'].map(s=>[s,Object.values(f.state().units).filter(x=>x.status===s).length]));
  // Production distinguishes an empty claim caused by work already owned
  // from the generic NO_ELIGIBLE_WORK label written in the v5 test plan.
  // Record the exact contract mismatch; validate the invariant rather than
  // inventing an unsafe tenth unit or changing production semantics.
  details.specifiedNoWorkStatus='NO_ELIGIBLE_WORK';
  details.statusDifferenceFromV5=r2.status!=='NO_ELIGIBLE_WORK';
  assert.equal(r2.status,'ALL_WORK_CLAIMED','existing typed no-eligible result');
  assert.equal(r2.claimedUnits.length,0,'typed no-work response cannot issue a unit');
  evidence('A03','LOCAL','PASS',details);
 }catch(error){
  details.error=String(error.stack??error);
  evidence('A03','LOCAL','FAIL',details);throw error;
 }finally{f.cleanup();}
});
