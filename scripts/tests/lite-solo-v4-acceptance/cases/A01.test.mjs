import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,evidence} from '../support/context.mjs';

test('A01: 142 eligible Phase-4 units issue ten, replay exactly, ignore old effort budget',()=>{
 const observations=[],f=fixture('A01',{flowCount:142});let heavy=null;
 try{
  const before=f.plan();assert.equal(Object.keys(before.units).length,142);
  const r1=f.process(f.request('CLAIM','agent-A01-a','A01-claim-1-1',{desiredUnitCount:10}));
  assert.equal(r1.claimedUnits?.length,10,'first claim count');
  assert.deepEqual(r1.claimedUnits.map(x=>x.unitId),f.units.slice(0,10));
  const state1=f.state(),revision=state1.revision;
  assert.equal(Object.values(state1.units).filter(x=>x.status==='AVAILABLE').length,132);
  assert.equal(Object.values(state1.units).filter(x=>x.status==='CLAIMED').length,10);
  for(const x of r1.claimedUnits)assert.ok(f.packet(x.unitId).payload.primaryContexts.length>0);
  const replay=f.process(f.request('CLAIM','agent-A01-a','A01-claim-1-1',{desiredUnitCount:10}));
  assert.deepEqual(replay.claimedUnits,r1.claimedUnits,'idempotent replay');
  assert.equal(f.state().revision,revision,'replay may not mutate revision');
  const r2=f.process(f.request('CLAIM','agent-A01-a','A01-claim-2-1',{desiredUnitCount:10}));
  assert.deepEqual(r2.claimedUnits.map(x=>x.unitId),f.units.slice(10,20));
  assert.equal(new Set([...r1.claimedUnits,...r2.claimedUnits].map(x=>x.unitId)).size,20);
  observations.push({first:r1.claimedUnits.map(x=>x.unitId),second:r2.claimedUnits.map(x=>x.unitId),
   replayStable:true,stateRevision:f.state().revision});
  heavy=fixture('A01-heavy',{flowCount:14,heavy:true});
  heavy.plan();
  const firstTen=heavy.units.slice(0,10);
  const effort=firstTen.reduce((n,id)=>n+2*heavy.packet(id).payload.primaryContexts.length,0);
  assert.ok(effort>150);
  const hard=heavy.process(heavy.request('CLAIM','agent-A01-heavy','A01-heavy-claim-1',{desiredUnitCount:10}));
  assert.equal(hard.claimedUnits.length,10,'old 150 work-item budget must not throttle ten');
  evidence('A01','LOCAL','PASS',{effort,fixtureCount:142,observations});
 }catch(error){
  evidence('A01','LOCAL','FAIL',{error:String(error.stack??error),observations});throw error;
 }finally{f.cleanup();heavy?.cleanup();}
});
