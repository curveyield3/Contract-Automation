import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateV7ExecutionRequestV1} from '../../../scripts/lib/lite-phase5-request-generation-v1.mjs';
import {validateDeepAssuranceRequestWithV26V1} from '../src/schema-v26.mjs';
const digest='a'.repeat(64);
const source={sha256:digest,archiveRepository:'CurveYield2/Audit-Controller',
 archiveCommit:'1'.repeat(40),archivePath:'campaigns/demo r1/source/source.zip',
 extractedContentPath:'campaigns/demo r1/source'};
const target=()=>({candidateKey:'C-005',executionMethod:'V7_REQUEST',reproductionType:'FOUNDRY_TEST',
 setup:'Deploy authorized fixture',prerequisites:['valid fork','owner signer'],
 transactionSequence:['nonowner attack','owner control'],
 oracle:'Nonowner call must revert and owner call must succeed',
 fuzzVariablesAndBounds:'Caller roles and amount boundaries',
 snapshotReuseSafety:'Restore same pinned state before each run',
 expectedSecurityProperty:'No access to roles without authorization',
 expectedMachineObservation:{componentStatus:'COMPLETED'},
 executionBlueprint:{
  projectPath:'campaigns/demo r1/source',
  configuration:{compilers:[{language:'solidity',version:'0.8.28'}],
    timeoutMinutes:20,
    harness:{kind:'runner-owned-audit-overlay-v1',bundleId:'fixture-phase5'},
    analysis:{medusa:{version:'1.5.1'},nativeFuzz:{enabled:true,fuzzRuns:100000}}}
 }});
test('D-T1 missing oracle yields exact per-field rework and no machine request',()=>{
 const invalid=target();delete invalid.oracle;
 const x=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:invalid});
 assert.equal(x.status,'REWORK_REQUIRED');
 assert.ok(x.missing.some(v=>v.field==='oracle'));
 assert.equal(x.request,undefined);
});
test('source-bound executable design yields valid typed V7 request',()=>{
 const x=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:target()});
 assert.equal(x.status,'GENERATED',JSON.stringify(x.missing));
 assert.equal(x.request.configuration.v26.reproduction.candidateId,'C-005');
 assert.deepEqual(x.designEvidence.transactionSequence,['nonowner attack','owner control']);
 assert.match(x.designEvidence.oracle,/Nonowner call must revert/);
 assert.equal(x.request.source.archiveSha256,digest);
 assert.deepEqual(validateDeepAssuranceRequestWithV26V1(x.request),x.request);
 assert.deepEqual(generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:target()}).request,x.request);
});
test('must not invent build identity, override frozen source, or fabricate expected observations',()=>{
 const t=target();t.executionBlueprint.projectPath='different/repo';t.expectedMachineObservation={whatever:true};
 const x=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:t});
 assert.equal(x.status,'REWORK_REQUIRED');
 assert.ok(x.missing.some(v=>v.field==='executionBlueprint.projectPath'));
});

test('D5 generated Anvil requests reuse only exact Phase-0 campaign snapshot and block',()=>{
 const block=25819000,sha='b'.repeat(64);
 const t=target();
 t.reproductionType='ANVIL_WORKFLOW';
 t.expectedMachineObservation={stepLabel:'pin persisted Phase 0 baseline',stepStatus:'completed'};
 t.executionBlueprint={usePhase0ForkState:true,projectPath:'campaigns/demo r1/source',
  configuration:{compilers:[{language:'solidity',version:'0.8.28'}],timeoutMinutes:20,evmVersion:'cancun',
   analysis:{nativeFuzz:{enabled:true,fuzzRuns:100000}},
   harness:{recipeId:'phase0-snapshot-targeted-v1'},
   deploymentGas:{deployableContracts:[{sourceName:'contracts/Vault.sol',contractName:'Vault'}]},
   simulation:{chain:'ethereum',block,
    workflow:{steps:[{action:'snapshot',alias:'baseline',label:'pin persisted Phase 0 baseline'},
     {action:'staticCall',target:'0x000000000000000000000000000000000000bEEF',
       function:'owner() view returns (address)',args:[],label:'verify saved deployment owner'}]}}}};
 const boundSource={...source,reusableForkState:{
  status:'CAPTURED',sha256:sha,sourceSha256:digest,campaignId:'demo-r1',
  chainId:1,finalBlock:block,hardfork:'cancun',
  manifestRef:'campaigns/demo r1/evidence/phase0/PHASE0_FORK_STATE_MANIFEST_v1.json'}};
 const success=generateV7ExecutionRequestV1({
  campaignId:'demo-r1',sourceSha256:digest,phase0Source:boundSource,target:t});
 assert.equal(success.status,'GENERATED',JSON.stringify(success.missing));
 assert.equal(success.request.configuration.v26.phase0ForkState.sha256,sha);
 assert.equal(success.request.configuration.v26.phase0ForkState.finalBlock,block);
 assert.deepEqual(validateDeepAssuranceRequestWithV26V1(success.request),success.request);
 const mismatch=structuredClone(t);
 mismatch.executionBlueprint.configuration.simulation.block=block-1;
 const failed=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,
  phase0Source:boundSource,target:mismatch});
 assert.equal(failed.status,'REWORK_REQUIRED');
 assert.ok(failed.missing.some(x=>x.field==='executionBlueprint.configuration.simulation.block'));
 const forged=structuredClone(t);
 forged.executionBlueprint.configuration.v26={phase0ForkState:{sha256:'f'.repeat(64)}};
 const expected=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,
  phase0Source:boundSource,target:forged});
 assert.equal(expected.status,'GENERATED',JSON.stringify(expected.missing));
 assert.equal(expected.request.configuration.v26.phase0ForkState.sha256,sha,
  'agent cannot override controller-verifiable Phase-0 state digest');
});

test('v13 fail-closed invalid placeholders and missing concrete fuzz budgets',()=>{
 for(const [label,mutate,field] of [
  ['oracle',t=>{t.oracle='<REQUIRED_TEST_ORACLE>';},'oracle'],
  ['transaction',t=>{t.transactionSequence=['TODO'];},'transactionSequence'],
  ['compilers',t=>{t.executionBlueprint.configuration.compilers[0].version='<SOLC>';},'executionBlueprint.configuration'],
  ['missing analysis',t=>{delete t.executionBlueprint.configuration.analysis;},'executionBlueprint.configuration.analysis'],
  ['low budget',t=>{t.executionBlueprint.configuration.analysis.nativeFuzz.fuzzRuns=1;},'executionBlueprint.configuration.analysis.nativeFuzz.fuzzRuns'],
  ['missing harness ID',t=>{delete t.executionBlueprint.configuration.harness.bundleId;},'executionBlueprint.configuration.harness.bundleId']
 ]){
  const design=target();mutate(design);
  const result=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:design});
  assert.equal(result.status,'REWORK_REQUIRED',label);
  assert.ok(result.missing.some(e=>e.field===field),label+': '+JSON.stringify(result.missing));
 }
});
test('Katana Phase0 fork snapshots accept chainId 747474 but never mismatched chain',()=>{
 const targetK=target();
 Object.assign(targetK,{reproductionType:'ANVIL_WORKFLOW',
  expectedMachineObservation:{stepLabel:'owner check',stepStatus:'completed'},
  executionBlueprint:{usePhase0ForkState:true,projectPath:'campaigns/demo r1/source',
    configuration:{compilers:[{language:'solidity',version:'0.8.28'}],evmVersion:'cancun',timeoutMinutes:20,
      analysis:{nativeFuzz:{enabled:true,fuzzRuns:100000}},
      harness:{recipeId:'phase0-snapshot-targeted-v1'},
      deploymentGas:{deployableContracts:[{sourceName:'contracts/Vault.sol',contractName:'Vault'}]},
      simulation:{chain:'katana',block:123,workflow:{steps:[
         {action:'snapshot',alias:'baseline',label:'owner check'}]}}}}});
 const state={...source,reusableForkState:{status:'CAPTURED',sha256:'b'.repeat(64),
   sourceSha256:digest,campaignId:'demo-r1',chainId:747474,finalBlock:123,hardfork:'cancun',
   manifestRef:'campaigns/demo r1/evidence/phase0/PHASE0_FORK_STATE_MANIFEST_v1.json'}};
 const ok=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:state,target:targetK});
 assert.equal(ok.status,'GENERATED',JSON.stringify(ok.missing));
 assert.equal(ok.request.configuration.v26.phase0ForkState.chainId,747474);
 const bad={...state,reusableForkState:{...state.reusableForkState,chainId:1}};
 const denied=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:bad,target:targetK});
 assert.equal(denied.status,'REWORK_REQUIRED');
});

test('D-T1 machine generator refuses an absent/unusable harness and accepts a complete registry bundle',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v13-harness-registry-'));
 try{
  const opts={campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:target(),automationRoot:root};
  const missing=generateV7ExecutionRequestV1(opts);
  assert.equal(missing.status,'REWORK_REQUIRED');
  assert.ok(missing.missing.some(x=>x.field==='executionBlueprint.configuration.harness.bundleId'));
  const bundleDir=path.join(root,'packages/github-native-sim/audit-harnesses/fixture-phase5');
  fs.mkdirSync(bundleDir,{recursive:true});
  fs.writeFileSync(path.join(bundleDir,'medusa.json'),'{}\n');
  fs.writeFileSync(path.join(bundleDir,'foundry.toml'),'[profile.default]\n');
  const ok=generateV7ExecutionRequestV1(opts);
  assert.equal(ok.status,'GENERATED',JSON.stringify(ok.missing));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('r4 candidateId embedded in expected observation is bound as request metadata',()=>{
 const design=target();
 design.expectedMachineObservation={componentStatus:'COMPLETED',candidateId:design.candidateKey};
 const good=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:design});
 assert.equal(good.status,'GENERATED',JSON.stringify(good.missing));
 assert.deepEqual(good.request.configuration.v26.reproduction.expectedObservation,{componentStatus:'COMPLETED'});
 assert.equal(good.request.configuration.v26.reproduction.candidateId,design.candidateKey);
 const wrong=structuredClone(design);
 wrong.expectedMachineObservation.candidateId='not-the-selected-candidate';
 const bad=generateV7ExecutionRequestV1({campaignId:'demo-r1',sourceSha256:digest,phase0Source:source,target:wrong});
 assert.equal(bad.status,'REWORK_REQUIRED');
 assert.ok(bad.missing.some(x=>x.field==='expectedMachineObservation.candidateId'));
});
