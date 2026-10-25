import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseForgeTestResultsV1,runNativeFuzzAnalysis} from '../src/native-fuzz.mjs';
import {parseMedusaOutput} from '../src/analysis.mjs';
import {buildAssertionLedgerV1} from '../src/adr-assertion-ledger-v1.mjs';
import {writeV7RawResultV1,readV7RawResultV1} from '../src/v7-compact-result-v1.mjs';

const file=fileURLToPath(new URL('../src/adr-assertion-ledger-v1.mjs',import.meta.url));
const output=[
 '\u001b[32mRan 2 tests for test/One.t.sol:First\u001b[0m',
 '[PASS] test_prop_BOB_0001_access() (runs: 256)',
 '[FAIL: insufficient reserves] test_attack_1_withdraw() (runs: 22)',
 'Ran 1 test for test/Two.t.sol:Second',
 '[SKIP] test_control_1_legitimate()',
].join('\n');
test('Forge parser extracts named suites, fuzz tests, colored text, failure reason, skip',()=>{
 const result=parseForgeTestResultsV1(output);
 assert.equal(result.parseStatus,'PARSED');
 assert.deepEqual(result.tests.map(x=>x.status),['PASS','FAIL','SKIPPED']);
 assert.equal(result.tests[1].reason,'insufficient reserves');
 assert.equal(result.tests[2].suite,'test/Two.t.sol:Second');
 assert.equal(parseForgeTestResultsV1('Compiling 10 files').parseStatus,'NONE_FOUND');
});
test('native fuzz attaches named assertions on completed and failed results preserving status',async()=>{
 const base={projectRoot:'/tmp/source',sourceCommit:'a'.repeat(40),
  rawArtifactRef:'github-actions://curveyield3/Contract-Automation/1/artifacts/fuzz',
  command:'forge',args:['test']};
 const success=await runNativeFuzzAnalysis(base,{runCommand:async()=>({exitCode:0,
  stdout:'Ran 1 test for test/A.t.sol:Vault\n[PASS] test_prop_BOB_0001() \nSuite result: ok. 1 passed; 0 failed;',stderr:''})});
 assert.equal(success.status,'completed');assert.equal(success.testResults.tests[0].status,'PASS');
 const failure=await runNativeFuzzAnalysis(base,{runCommand:async()=>({exitCode:1,
  stdout:'Ran 1 test for test/A.t.sol:Vault\n[FAIL: missing] test_attack_1() \nSuite result: FAILED. 0 passed; 1 failed;',stderr:''})});
 assert.equal(failure.status,'failed');assert.equal(failure.testResults.tests[0].status,'FAIL');
});
test('Medusa 1.5.1 CLI output exposes named passed and failed properties',()=>{
 const p=parseMedusaOutput('[PASSED] Property Test: Contract.property_BOB_0001()\n[FAILED] Property Test: Contract.property_BOB_0002()\n');
 assert.deepEqual(p.properties.map(x=>x.status),['passed','failed']);
});
test('assertion ledger extracts Forge and Medusa, no implicit invocation PASS',()=>{
 const evidence={analysis:{nativeFuzz:{toolInvoked:true,testResults:parseForgeTestResultsV1(output)},
  medusa:{toolInvoked:true,campaign:{properties:[{name:'Vault.property_BOB_0003()',status:'failed'},
  {name:'Vault.property_BOB_0004()',status:'passed'}]}}}};
 const result=buildAssertionLedgerV1({evidence});
 assert.equal(result.parseStatus,'PARSED');assert.equal(result.toolInvoked,true);
 assert.ok(result.tests.some(x=>x.name==='test/One.t.sol:First::test_prop_BOB_0001_access()'&&x.status==='PASS'));
 assert.ok(result.tests.some(x=>x.name==='Vault.property_BOB_0003()'&&x.status==='FAIL'));
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'adr-ledger-'));
 try{
  writeV7RawResultV1({evidenceRoot:folder,result:{analysis:evidence.analysis},compact:false});
  const read=readV7RawResultV1(path.join(folder,'raw-result.json'));
  assert.equal(buildAssertionLedgerV1({evidence:read}).tests.length,result.tests.length);
 }finally{fs.rmSync(folder,{recursive:true,force:true});}
});
test('unparseable evidence or absent tool flag never claim a safe execution',()=>{
 assert.equal(buildAssertionLedgerV1({evidence:{disposition:'PASS'}}).parseStatus,'UNPARSEABLE');
 const result=buildAssertionLedgerV1({evidence:{analysis:{nativeFuzz:{
  testResults:parseForgeTestResultsV1(output)}}}});
 assert.equal(result.toolInvoked,null);
 assert.equal(buildAssertionLedgerV1({evidence:null}).parseStatus,'UNPARSEABLE');
});
test('bad CLI input writes UNPARSEABLE JSON and exits 0',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'adr-ledger-cli-'));
 try{
  const out=path.join(dir,'out.json');
  execFileSync(process.execPath,[file,'--evidence',path.join(dir,'missing.json'),'--out',out]);
  const result=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(result.parseStatus,'UNPARSEABLE');assert.equal(typeof result.error,'string');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
