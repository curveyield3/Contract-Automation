import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {p5Fixture,evidence,get,put,json,digest,writeFile,fixture,claim,submit,snapshotWith} from '../support/next-context.mjs';
import {p6Fixture} from '../support/phase6-context.mjs';
import {finalizeReadinessV1} from '../../../lib/lite-solo-unit-queue-v1.mjs';
import {buildDiscoverySummaryV1} from '../../../../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';
import {loadTaxonomyV1} from '../../../../packages/github-native-sim/src/adr-taxonomy-v1.mjs';

const scenario=(id,prepare,run)=>test(id,()=>{const f=prepare(),data={};
 try{run(f,data);evidence(id,'LOCAL','PASS',data)}
 catch(e){evidence(id,'LOCAL','FAIL',{...data,error:String(e.stack||e)});throw e}
 finally{f.cleanup()}});
scenario('A16',()=>p5Fixture('A16'),(f,d)=>{
 // Directly set source-bound economic relation before the real unit plan is built.
 const r=f.campaign+'/work/phase-05/shards/SLAB_0.json',doc=get(f.root,r);
 doc.entries[0].value.relatedCandidateKeys=['C-ONE'];put(f.root,r,doc);
 f.plan();const index=get(f.root,f.campaign+'/work/phase-05/units/UNIT_PLAN_INDEX_v1.json');
 const units=index.pages.flatMap(p=>get(f.root,p.path).units);
 const econ=units.find(x=>x.field==='economicReviewRecords'),recon=units.find(x=>x.field==='reconciliationRecords'),
  target=units.find(x=>x.field==='targetDesigns');
 assert.ok(econ&&recon&&target);
 const batch=f.claim('a16-owner','a16-initial');
 assert.equal(batch.length,2);
 const eb=batch.find(x=>x.unitId===econ.unitId),rb=batch.find(x=>x.unitId===recon.unitId);
 const result=f.submit('a16-owner','a16-econ-approved',[f.p5snapshot(eb,'a16-owner')]);
 assert.deepEqual(result.acceptedUnits,[econ.unitId]);
 const item=f.p5snapshot(rb,'a16-owner');
 fs.rmSync(path.join(f.root,item.submissionPath));
 const pending=f.submit('a16-owner','a16-recon-pending',[item]);
 assert.equal(pending.waitingUnits.length,1);
 const narrow=f.process(f.request('CLAIM','a16-narrow','a16-narrow-only',{lane:'P5-T',desiredUnitCount:10}));
 assert.equal(narrow.claimedUnits.length,0,'target must not be issued while reconciliation is SUBMITTED');
 assert.equal(f.state().units[target.unitId].status,'BLOCKED_DEPENDENCY');
 d.plannerDependencies=target.dependencies;d.linkedEconomic=econ.unitId;d.linkedReconciliation=recon.unitId;
 d.linkedEconDependencyPresent=target.dependencies.includes(econ.unitId);
 assert.ok(target.dependencies.includes(recon.unitId),'linked R must be a dependency');
 assert.ok(target.dependencies.includes(econ.unitId),
  'A16: source-linked economic unit for C-ONE must be accepted before target may issue');
 d.status='LOCAL prerequisite graph passed; final machine evidence still requires qualification';
});
scenario('A17',()=>p5Fixture('A17'),(f,d)=>{
 f.plan();
 const batch=f.claim('a17-worker','a17-first');
 assert.equal(batch.length,2);
 const e=batch.find(x=>x.unitId.startsWith('P5-E'));
 const r=batch.find(x=>x.unitId.startsWith('P5-R'));
 assert.equal(f.submit('a17-worker','a17-first-accept',[f.p5snapshot(e,'a17-worker'),
  f.p5snapshot(r,'a17-worker')]).acceptedUnits.length,2);
 const t=f.claim('a17-worker','a17-target');
 assert.equal(t.length,1);assert.ok(t[0].unitId.startsWith('P5-T'));
 const targeted=f.p5snapshot(t[0],'a17-worker');
 const targetData=get(f.root,targeted.submissionPath);
 targetData.entries[0].value.executionMethod='V7_REQUEST';
 targetData.entries[0].value.executionRequestRef='evidence/missing-v7-source-bound-request.json';
 put(f.root,targeted.submissionPath,targetData);
 targeted.submissionSha256=digest(Buffer.from(json(targetData)));
 const response=f.submit('a17-worker','a17-no-v7',[targeted]);
 assert.equal(response.reworkUnits.length,1,'invalid V7 evidence must be rejected');
 assert.equal(f.state().units[t[0].unitId].status,'REWORK_REQUIRED');
 const ready=finalizeReadinessV1({root:f.root,campaignPath:f.campaign,
  directory:get(f.root,f.directoryPath),phase:5});
 assert.equal(ready.ready,false);
 assert.equal(fs.existsSync(path.join(f.root,f.campaign+'/receipts/PHASE_05_RECEIPT_v1.json')),false);
 d.rework=response.reworkUnits;d.readiness=ready;
 d.status='PARTIAL: no authentic machine evidence/phase seal fixture admitted';
});
scenario('A18',()=>p6Fixture('A18',{baseline:1,proof:0}),(f,d)=>{
 f.plan();const first=f.claim('a18-owner','a18-claim');
 assert.equal(first.length,1);assert.ok(first[0].unitId.startsWith('P6-B'));
 assert.equal(f.claim('a18-racer','a18-race').length,0);
 assert.equal(f.state().units[first[0].unitId].workerId,'a18-owner');
 const script=fs.readFileSync(path.resolve('scripts/lib/lite-solo-unit-queue-v1.mjs'),'utf8');
 d.roundBudgetInQueue=/(maxRounds|roundBudget|roundsConsumed)/.test(script);
 d.worker=first[0].unitId;
 d.status='PARTIAL: group uniqueness verified; no real three-round admission ledger test';
});
scenario('A19',()=>p6Fixture('A19',{baseline:0,proof:1}),(f,d)=>{
 f.plan();const [u]=f.claim('a19-worker','a19-claim');assert.ok(u);
 const original=f.snap(u,'a19-worker');
 const correct=f.submit('a19-worker','a19-inconclusive',[original]);
 assert.equal(correct.acceptedUnits.length,1,'typed inconclusive outcome must be retained');
 const saved=get(f.root,f.state().units[u.unitId].acceptedPath);
 assert.equal(saved.submission.entries[0].value.verdict,'INCONCLUSIVE');
 const hash=f.state().units[u.unitId].acceptedSha256;
 const forged=f.snap(u,'a19-worker',{verdict:'CONFIRMED',
  ledgerRef:'UNEXECUTED',attackAssertionNames:[],controlAssertionNames:[]});
 const challenged=f.submit('a19-worker','a19-forged',[forged]);
 assert.equal(challenged.unchangedUnits.length,1,'accepted snapshot immutable even after forged re-submit');
 assert.equal(f.state().units[u.unitId].acceptedSha256,hash);
 // Independent proof fixture is unaccepted; unauthorized decisive outcome must fail
 // even when all required string fields are syntactically present.
 const fresh=p6Fixture('A19-forged',{baseline:0,proof:1});
 try{
  fresh.plan();
  const [freshUnit]=fresh.claim('a19-forger','a19-forger-claim');
  const fake=fresh.snap(freshUnit,'a19-forger',{verdict:'CONFIRMED',
    ledgerRef:'UNEXECUTED',attackAssertionNames:[],controlAssertionNames:[]});
  const proofCheck=fresh.submit('a19-forger','a19-forged-first',[fake]);
  d.unauthenticatedDecisiveVerdictAccepted=proofCheck.acceptedUnits.includes(freshUnit.unitId);
  assert.equal(proofCheck.acceptedUnits.length,0,
    'SECURITY: unauthenticated CONFIRMED with no ledger or decisive observations must be rejected');
  assert.equal(proofCheck.reworkUnits.length,1);
 }finally{fresh.cleanup();}
 d.status='LOCAL: inconclusive retained, forged decisive denied; final seal/machine runner requires separate qualification';
});
scenario('A20',()=>fixture('A20',{flowCount:3}),(f,d)=>{
 f.plan();
 const inv=get(f.root,f.campaign+'/evidence/review-inventory/REVIEW_INVENTORY_v1.json');
 const contexts=inv.payload.contexts;
 const c=(name,context)=>({tempKey:name,title:'Shared title',description:'Mechanism X',
  classId:'ACCESS_CONTROL',severity:'HIGH',contextIds:[context.contextId],
  anchors:[context.path+':L'+context.lineStart]});
 const state={campaignId:f.directory.campaignId,campaignGenerationId:f.directory.campaignGenerationId,
  sourceSha256:f.directory.sourceSha256,generatedAt:'2026-01-01T00:00:00Z',payload:{reviewPolicy:'correctness-verdict-v13',gaps:[]}};
 const rows=[
  {unitId:'F-001',submission:{rows:[],candidates:[c('obs-a',contexts[0])]}},
  {unitId:'F-002',submission:{rows:[],candidates:[c('obs-b',contexts[1])]}},
  {unitId:'F-003',submission:{rows:[],candidates:[{...c('obs-c',contexts[2]),description:'Different actual security property'}]}}
 ];
 const summary=buildDiscoverySummaryV1({state,inventory:inv,
  plan:{payload:{reviewUnits:[],attackUnits:[]}},acceptedSubmissions:rows,
  taxonomy:loadTaxonomyV1(process.cwd()),now:'2026-01-01T00:00:00Z'});
 const items=summary.payload.reconciliationItems;
 assert.equal(items.length,3,'all original observations should survive discovery');
 assert.equal(new Set(items.map(x=>x.sourceAnchor)).size,3,'distinct source anchors retained');
 d.observations=items.map(x=>({recordKey:x.recordKey,sourceAnchor:x.sourceAnchor}));
 d.status='PARTIAL: discovery preservation verified; mechanism dedup requires real reconciliation acceptance';
});
