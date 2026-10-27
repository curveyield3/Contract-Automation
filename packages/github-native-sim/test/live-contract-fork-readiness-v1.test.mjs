import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyDeploymentExecutionV1,renderDeployConfigMatrixV1} from '../src/lite-boundary-artifacts-v1.mjs';
import {validateLiveForkBaselineRecordV1} from '../../../scripts/lib/lite-solo-live-fork-baseline-gate-v1.mjs';

const address='0x6b175474e89094c44da98b954eedeac495271d0f';
const block=26283885;
const hash='0x'+'a'.repeat(64);
const sourceSha='b'.repeat(64);
const campaign='campaigns/live-contract-test-r1';
const campaignId='live-contract-test-r1';
const write=(root,p,o)=>{
  const target=path.join(root,...p.split('/'));
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,JSON.stringify(o,null,2)+'\n');
};
const execution=()=>({
  status:'PASS_LIVE_DEPLOYMENT',
  executionMode:'ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY',
  deploymentProfile:{mode:'LIVE',contracts:[{address,qualifiedName:'Dai.sol:Dai'}]},
  fork:{engine:'anvil',chainId:1,verifiedHistoricalFork:true,initialBlock:block,pinnedHistoricalHash:hash},
  liveDeployment:{status:'VERIFIED',contracts:[{address,qualifiedName:'Dai.sol:Dai',runtimeSha256:'c'.repeat(64)}]},
  attempts:[]
});
const record=()=>({
  testGroupId:'TG-001',contract:'Dai.sol:Dai',obligationIds:['BOB-0001','BOB-0006'],
  requestDirectory:'controller/phase6-tests/TG-001/',
  requestPaths:['NONE_IDENTIFIED'],dispatchRounds:0,
  obligationOutcomes:[
    {obligationId:'BOB-0001',outcome:'NOT_ACHIEVED',reasonCode:'NO_EXECUTABLE_SETUP'},
    {obligationId:'BOB-0006',outcome:'NOT_APPLICABLE_CONFIRMED'}
  ]
});
const setup=()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'live-fork-regression-'));
  write(root,campaign+'/evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',execution());
  return root;
};
const check=(root,r)=>validateLiveForkBaselineRecordV1({
  root,campaignPath:campaign,campaignId,sourceSha256:sourceSha,record:r
});

test('LIVE_SCAN verified deployment is an existing-address fork target without deployment scripts',()=>{
  const e=execution();
  const classification=classifyDeploymentExecutionV1({execution:e});
  assert.equal(classification.mode,'LIVE_DEPLOYED_FORK');
  assert.equal(classification.status,'LIVE_FORK_SOURCE_VERIFIED');
  assert.equal(classification.blockNumber,block);
  assert.equal(classification.targets[0].address,address);
  const matrix=renderDeployConfigMatrixV1({execution:e,
    readiness:{deploymentAndConfiguration:{deploymentFiles:['audit-deployment.json']}}});
  assert.match(matrix,/Existing live deployment: Dai.sol:Dai/);
  assert.match(matrix,/NOT_REDEPLOYED/);
  assert.match(matrix,/MUTABLE_FORK_PREFLIGHT_REQUIRED/);
  assert.doesNotMatch(matrix,/BLOCKED_NO_ADMITTED_LOCAL_EXECUTION/);
  assert.doesNotMatch(matrix,/No executable setup available/);
});

test('unverified live deployment cannot silently downgrade to missing local scripts',()=>{
  const e=execution();e.liveDeployment.status='UNVERIFIED';
  const classification=classifyDeploymentExecutionV1({execution:e});
  assert.equal(classification.mode,'LIVE_DEPLOYED_FORK');
  assert.equal(classification.status,'LIVE_FORK_ATTESTATION_REQUIRED');
  assert.doesNotMatch(renderDeployConfigMatrixV1({execution:e}),/BLOCKED_NO_ADMITTED_LOCAL_EXECUTION/);
});

test('local source campaigns retain the existing source-deploy classification',()=>{
  const e={attempts:[{script:'deploy-local',status:'PASS'}]};
  assert.equal(classifyDeploymentExecutionV1({execution:e}).mode,'SOURCE_LOCAL_DEPLOY');
  assert.equal(classifyDeploymentExecutionV1({execution:e}).status,'SOURCE_SETUP_EXECUTED');
  assert.match(renderDeployConfigMatrixV1({execution:e}),/deploy-local/);
});

test('live-fork Phase-6 baseline cannot claim no executable setup and zero executions',()=>{
  const root=setup();try{
    const errors=check(root,record()).join(' | ');
    assert.match(errors,/1–3 actual V7 execution rounds/);
    assert.match(errors,/committed V7 Phase-6 test request/);
    assert.match(errors,/NO_EXECUTABLE_SETUP/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('live-fork acceptance requires request-bound preflight and invoked test assertions',()=>{
  const root=setup();
  try{
    const id='v7-live-dai-property-001',digest='d'.repeat(64);
    const requestPath='controller/phase6-tests/TG-001/'+id+'.json';
    const request={requestId:id,requestDigest:digest,campaignId,phaseId:'build-and-test',
      source:{archiveSha256:sourceSha},configuration:{analysis:{nativeFuzz:{enabled:true}}}};
    write(root,campaign+'/'+requestPath,request);
    const base=campaign+'/controller/automation/'+id;
    const machine={requestId:id,requestDigest:digest,blocking:false,disposition:'PASS',
      preflight:{status:'PASS',mutableRpc:{status:'PASS',
        identityNormalization:{status:'PASS'},blockNumber:block,blockHash:hash}}};
    write(root,base+'/EXECUTION_EVIDENCE_v1.json',machine);
    write(root,base+'/ingestion/EXECUTION_EVIDENCE_INGESTION_RECEIPT_v1.json',
      {schemaVersion:'audit-execution-evidence-ingestion-receipt-v1',requestId:id});
    write(root,base+'/ASSERTION_LEDGER_v1.json',
      {schemaVersion:'curveyield-assertion-ledger-v1',parseStatus:'PARSED',toolInvoked:true,
        tests:[{name:'DaiFork::test_prop_BOB-0001_wardMatrix()',status:'PASS'}]});
    const r=record();
    r.dispatchRounds=1;r.requestPaths=[requestPath];
    r.obligationOutcomes[0]={obligationId:'BOB-0001',outcome:'PASSED'};
    assert.deepEqual(check(root,r),[]);
    machine.preflight.mutableRpc.blockHash='0x'+'f'.repeat(64);
    write(root,base+'/EXECUTION_EVIDENCE_v1.json',machine);
    assert.match(check(root,r).join(' | '),/identical historical mutable Anvil fork preflight/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('source-backed not-applicable baseline can be accepted without dispatch',()=>{
  const root=setup();try{
    const r=record();
    r.obligationIds=['BOB-0006'];
    r.obligationOutcomes=[{obligationId:'BOB-0006',outcome:'NOT_APPLICABLE_CONFIRMED'}];
    assert.deepEqual(check(root,r),[]);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
