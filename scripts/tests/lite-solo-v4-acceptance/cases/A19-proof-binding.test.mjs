import test from 'node:test';
import assert from 'node:assert/strict';
import {p6Fixture} from '../support/phase6-context.mjs';
import {evidence,writeFile,json} from '../support/next-context.mjs';

const caseCheck=(id,verdict,attacks,controls,expected,statusOverrides={})=>{
 const f=p6Fixture(id,{baseline:0,proof:1});const info={verdict};
 try{
  f.plan();const [unit]=f.claim(id+'-worker',id+'-claim');
  const ref='controller/phase6-tests/CP-C-001/ASSERTION_LEDGER_v1.json';
  const ledger={schemaVersion:'curveyield-assertion-ledger-v1',parseStatus:'PARSED',
   tool:'forge',toolInvoked:true,executedCalls:null,
   tests:[...attacks.map(([name,status])=>({name,status})),...controls.map(([name,status])=>({name,status}))]};
  writeFile(f.root,f.campaign+'/'+ref,json(ledger));
  const row={verdict,ledgerRef:ref,attackAssertionNames:attacks.map(a=>a[0]),
   controlAssertionNames:controls.map(a=>a[0]),reasoning:verdict==='DISPROVEN'?
    'Anchored reentrancy guard prevents unsafe path and control succeeds':
    'Machine assertion confirms exploit path while healthy control passes',...statusOverrides};
  const submission=f.snap(unit,id+'-worker',row);
  const result=f.submit(id+'-worker',id+'-submit',[submission]);
  assert.equal(result.acceptedUnits.length,expected,'acceptance must reflect ledger assertions');
  assert.equal(result.reworkUnits.length,expected?0:1);
  info.errors=result.reworkUnits;
  evidence(id,'LOCAL','PASS',info);
 }catch(e){info.error=String(e.stack||e);evidence(id,'LOCAL','FAIL',info);throw e}
 finally{f.cleanup()}
};
test('A19B CONFIRMED requires parsed failed attack and passing control',()=>{
 caseCheck('A19B','CONFIRMED',[['test_attack_1','FAIL']],[['test_control_1','PASS']],1);
});
test('A19C DISPROVEN requires blocked attack and passing healthy control',()=>{
 caseCheck('A19C','DISPROVEN',[['test_attack_1','PASS']],[['test_control_1','PASS']],1);
});
test('A19D fabricated PASS outcome cannot justify CONFIRMED',()=>{
 caseCheck('A19D','CONFIRMED',[['test_attack_1','PASS']],[['test_control_1','PASS']],0);
});
test('A19E failed healthy controls invalidate even failed attack',()=>{
 caseCheck('A19E','CONFIRMED',[['test_attack_1','FAIL']],[['test_control_1','FAIL']],0);
});
