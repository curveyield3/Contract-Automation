import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFlowReviewSubmissionV1} from '../src/adr-discovery-validators-v1.mjs';

const anchor='contracts/Vault.sol:L4-L8';
const inventory={payload:{sourceUnits:[{path:'contracts/Vault.sol',scopeTier:'IN_SCOPE',lineCount:60}]}};
const packet={unitId:'F-001',reviewPolicy:'correctness-verdict-v13',
 primaryContexts:[{contextId:'CTX-1'}],flowIds:['FLOW-1'],
 integrationQuestionIds:['IOB-1'],
 contractChecks:[{contract:'Vault',classId:'UPGRADE_INIT_STORAGE'}]};
function good(){
 return {schemaVersion:'curveyield-flow-review-submission-v1',unitId:'F-001',candidates:[],
  rows:[{contextId:'CTX-1',verdict:'CORRECT',
   intent:'Only an initialized owner can upgrade the implementation',
   reason:'The ownership guard is checked before the implementation address changes',
   anchors:[anchor],
   specInspection:{status:'NO_DOCUMENTED_RULES',docsAndCommentsChecked:'Reviewed NatSpec and readme for authorization',namedConstantsChecked:'Checked implementation slot constants'},
   documentedRules:[],siblingComparisons:[]}],
  flowNotes:[{flowId:'FLOW-1',note:'The external upgrade entry checks ownership and writes proxy implementation state',anchors:[anchor]}],
  integrationAnswers:[{obligationId:'IOB-1',assessment:'SUPPORTED',
   reasoning:'The external proxy invokes the ownership-checked implementation setter',anchors:[anchor]}],
  contractChecks:[{contract:'Vault',classId:'UPGRADE_INIT_STORAGE',assessment:'SUPPORTED',
   applicability:'APPLICABLE',evidence:'Initializer and storage slots are protected by an owner gate',anchors:[anchor]}]};
}
const validate=s=>validateFlowReviewSubmissionV1({packet,submission:s,inventory});
function has(s,code){const r=validate(s);assert.equal(r.ok,false);assert.ok(r.errors.some(e=>e.code===code),JSON.stringify(r.errors));}
test('v13 accepts fully evidenced flow, integration and contract-level upgrade verdicts',()=>{
 const r=validate(good());assert.equal(r.ok,true,JSON.stringify(r.errors));
});
test('v13 cannot seal a function-only submission while flow traces are missing',()=>{
 const s=good();delete s.flowNotes;has(s,'FLOW_NOTE_MISSING');
 s.flowNotes=[];has(s,'FLOW_NOTE_MISSING');
 s.flowNotes=[{flowId:'FLOW-1',note:'No issue',anchors:[]}];has(s,'FLOW_NOTE_EMPTY');
 s.flowNotes=[good().flowNotes[0],good().flowNotes[0]];has(s,'FLOW_NOTE_DUPLICATE');
 s.flowNotes=[{...good().flowNotes[0],flowId:'OTHER'}];has(s,'FLOW_NOTE_EXTRA');
});
test('v13 enforces all integration questions and anchored dispositions',()=>{
 const s=good();delete s.integrationAnswers;has(s,'QUESTION_UNANSWERED');
 s.integrationAnswers=[{...good().integrationAnswers[0],reasoning:'none'}];has(s,'REASONING_EMPTY');
 s.integrationAnswers=[{...good().integrationAnswers[0],assessment:'CONCERN'}];has(s,'CONCERN_WITHOUT_CANDIDATE');
 s.integrationAnswers=[good().integrationAnswers[0],good().integrationAnswers[0]];has(s,'QUESTION_DUPLICATE');
 s.integrationAnswers=[{...good().integrationAnswers[0],obligationId:'BOGUS'}];has(s,'QUESTION_EXTRA');
});
test('v13 enforces generated contract-level initializer/storage checks',()=>{
 const s=good();delete s.contractChecks;has(s,'CONTRACT_CHECK_MISSING');
 s.contractChecks=[{...good().contractChecks[0],evidence:'safe'}];has(s,'EVIDENCE_EMPTY');
 s.contractChecks=[{...good().contractChecks[0],anchors:[]}];has(s,'ANCHOR_REQUIRED');
 s.contractChecks=[{...good().contractChecks[0],assessment:'CONCERN'}];has(s,'CONCERN_WITHOUT_CANDIDATE');
 s.contractChecks=[good().contractChecks[0],good().contractChecks[0]];has(s,'CONTRACT_CHECK_DUPLICATE');
 s.contractChecks=[{...good().contractChecks[0],contract:'Unassigned'}];has(s,'CONTRACT_CHECK_EXTRA');
});
