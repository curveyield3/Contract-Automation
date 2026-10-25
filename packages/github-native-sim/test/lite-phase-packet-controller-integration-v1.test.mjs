import {restoreControllerResultV1} from '../../../scripts/lib/lite-boundary-result-v1.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {refreshControllerPrefillDigest} from '../../../scripts/lib/lite-phase-prefill-v1.mjs';
import {requiredFile,repoFile} from '../../../scripts/lib/lite-phase-work-v1.mjs';
import {MASTER_REVIEW_SEGMENTS_V1,collectSegmentArtifacts} from '../../../scripts/lib/lite-master-review-v1.mjs';

const mkdir=p=>fs.mkdirSync(p,{recursive:true});
const writeJson=(p,v)=>{mkdir(path.dirname(p));fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');};
const write=(p,v)=>{mkdir(path.dirname(p));fs.writeFileSync(p,v);};
const readJson=p=>JSON.parse(fs.readFileSync(p,'utf8'));

test('master review topology gates each whole normal-reviewer segment exactly once',()=>{
  assert.deepEqual(MASTER_REVIEW_SEGMENTS_V1.filter(x=>x.segmentId!=='reviewer-4-followup-v1').map(x=>({id:x.segmentId,reviewer:x.reviewerId,phases:[...x.phases],boundary:x.boundaryPhase})),[
    {id:'reviewer-1-phase-01',reviewer:'reviewer-1',phases:[1],boundary:1},
    {id:'reviewer-2-phases-02-05',reviewer:'reviewer-2',phases:[2,3,4,5],boundary:5},
    {id:'reviewer-3l-phases-06-07',reviewer:'reviewer-3L',phases:[6,7],boundary:7},
    {id:'reviewer-4-phases-08-10',reviewer:'reviewer-4',phases:[8,9,10],boundary:10}
  ]);
  const followup=MASTER_REVIEW_SEGMENTS_V1.filter(x=>x.segmentId==='reviewer-4-followup-v1');
  assert.equal(followup.length,1);
  assert.equal(followup[0].reviewerId,'reviewer-4');
  assert.deepEqual([...followup[0].phases],[8,9,10]);
});

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lite-packet-controller-'));
  const campaign='campaigns/demo';
  const dirRel='Audit Campaign Directory/campaigns/demo.json';
  const authority='Audit Skill - Current Authority/Audit_Litemode_v10.2';
  const source='a'.repeat(64);

  const receiptStub=`export function phaseReceiptPath(workspacePath,sequence,revision=1){return workspacePath+'/receipts/PHASE_'+String(sequence).padStart(2,'0')+'_RECEIPT_v'+revision+'.json';}
export function createLitePhaseReceiptV1(input){return {schemaVersion:'curveyield-lite-phase-receipt-v1',campaign:{campaignId:input.campaignId,campaignGenerationId:input.campaignGenerationId,campaignName:input.campaignName,workspacePath:input.workspacePath,campaignDirectoryEntryPath:input.campaignDirectoryEntryPath,mode:'LITE'},phase:{sequence:input.sequence,id:'phase-'+input.sequence,revision:input.revision??1,status:input.status},executor:{type:input.executorType,lineage:input.executorLineage},authority:input.authority,source:{sha256:input.sourceSha256,...input.source},startedAt:input.now,updatedAt:input.now,sealedAt:null,inputs:input.inputs??[],evidence:input.evidence??[],outputs:input.outputs??[],globalControls:input.globalControls??{},obligations:{due:[],created:[],closed:[],carriedForward:[],...(input.obligations??{})},invalidation:{status:'NO_MATERIAL_CHANGE',events:[]},automation:[],validation:input.validation??{status:'PENDING',failures:[]},handoff:input.handoff??{required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:null,sameReviewer:false,status:'NOT_APPLICABLE'},errors:[]};}
`;
  write(path.join(root,'packages/controller-core/src/lite-phase-receipt-v1.mjs'),receiptStub);

  const phase1Schema={
    schemaVersion:'curveyield-lite-phase-work-schema-v1',phase:1,title:'P1',executor:'reviewer-1',automationOnly:false,
    workForm:{campaignPath:'work/phase-01/PHASE_01_WORK_FORM_v1.json',template:'phases/phase-1/resources/PHASE_01_WORK_FORM_TEMPLATE_v1.json'},
    finalReport:{campaignPath:'work/phase-01/PHASE_01_FINAL_REPORT_v1.md',template:'phases/phase-1/resources/PHASE_01_FINAL_REPORT_TEMPLATE_v1.md',requiredSections:['Executive Conclusion','Material Results','Limitations','Unresolved Substantive Questions']},
    actions:{'step-1':{title:'Analyze',formPath:'work/phase-01/PHASE_01_WORK_FORM_v1.json',section:'Step 1 Input — Analyze',fields:[{name:'analysis',type:'REQUIRED_ANALYSIS',consumers:['phase-2']}]}},
    derivedOutputs:[],bookkeepingMappings:{graphRecordPaths:['actions.step-1.outputs.analysis'],obligationRecordPaths:[],invalidationRecordPaths:[]},
    submission:{packetPath:'submissions/PHASE_01_WORK_PACKET_v1.json',requiredPacketStatus:'SUBMITTED',controllerPassToken:'CONTROLLER_PHASE_PASS',bookkeepingBeforeValidationPass:false}
  };
  const phase2Schema={
    schemaVersion:'curveyield-lite-phase-work-schema-v1',phase:2,title:'P2',executor:'reviewer-2',automationOnly:false,
    workForm:{campaignPath:'work/phase-02/PHASE_02_WORK_FORM_v1.json',template:'phases/phase-2/resources/PHASE_02_WORK_FORM_TEMPLATE_v1.json'},
    finalReport:{campaignPath:'work/phase-02/PHASE_02_FINAL_REPORT_v1.md',template:'phases/phase-2/resources/PHASE_02_FINAL_REPORT_TEMPLATE_v1.md',requiredSections:['Executive Conclusion','Material Results','Limitations','Unresolved Substantive Questions']},
    actions:{'step-1':{title:'Analyze next',formPath:'work/phase-02/PHASE_02_WORK_FORM_v1.json',section:'Step 1 Input — Analyze next',fields:[{name:'nextAnalysis',type:'REQUIRED_ANALYSIS',consumers:['phase-3']}]}},
    derivedOutputs:[],bookkeepingMappings:{graphRecordPaths:[],obligationRecordPaths:[],invalidationRecordPaths:[]},
    submission:{packetPath:'submissions/PHASE_02_WORK_PACKET_v1.json',requiredPacketStatus:'SUBMITTED',controllerPassToken:'CONTROLLER_PHASE_PASS',bookkeepingBeforeValidationPass:false}
  };
  writeJson(path.join(root,authority,'phases/phase-1/PHASE_01_SCHEMA_v1.json'),phase1Schema);
  writeJson(path.join(root,authority,'phases/phase-2/PHASE_02_SCHEMA_v1.json'),phase2Schema);
  writeJson(path.join(root,authority,'phases/phase-2/resources/PHASE_02_WORK_FORM_TEMPLATE_v1.json'),{schemaVersion:'curveyield-lite-phase-work-form-v1',phase:2,actions:{'step-1':{section:'Step 1 Input — Analyze next',outputs:{nextAnalysis:'<REQUIRED>'}}}});
  write(path.join(root,authority,'phases/phase-2/resources/PHASE_02_FINAL_REPORT_TEMPLATE_v1.md'),'# Phase 2 Final Report\n\n## Executive Conclusion\n<REQUIRED>\n\n## Material Results\n<REQUIRED>\n\n## Limitations\n<REQUIRED>\n\n## Unresolved Substantive Questions\n<REQUIRED>\n');
  write(path.join(root,authority,'SKILL.md'),'# authority\n');

  const predecessorRel=campaign+'/receipts/PHASE_00_RECEIPT_v1.json';
  writeJson(path.join(root,predecessorRel),{
    authority:{homepagePath:authority+'/SKILL.md',repository:'curveyield3/Audit-Controller'},
    source:{sha256:source},
    globalControls:{sourceIntelligenceBundle:'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'},
    phase:{sequence:0,status:'SEALED'}
  });
  writeJson(path.join(root,campaign,'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'),{schemaVersion:'fixture-source-intelligence-bundle-v1',sourceSha256:source});
  writeJson(path.join(root,campaign,'controller/SECURITY_TRACEABILITY_GRAPH_v1.json'),{nodes:[],edges:[]});
  writeJson(path.join(root,campaign,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json'),{obligations:[]});
  writeJson(path.join(root,campaign,'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json'),{events:[]});

  const formRel=campaign+'/work/phase-01/PHASE_01_WORK_FORM_v1.json';
  const reportRel=campaign+'/work/phase-01/PHASE_01_FINAL_REPORT_v1.md';
  const packetRel=campaign+'/submissions/PHASE_01_WORK_PACKET_v1.json';
  const initialForm={schemaVersion:'curveyield-lite-phase-work-form-v1',phase:1,automationInputs:{predecessorReceiptPath:predecessorRel,derivedInputPaths:[],controllerOwnedAutomationInputs:['predecessorReceiptPath','derivedInputPaths']},actions:{'step-1':{section:'Step 1 Input — Analyze',outputs:{analysis:'<REQUIRED>'}}}};
  const prefillDigest=refreshControllerPrefillDigest(initialForm);
  writeJson(path.join(root,formRel),initialForm);
  // Packet and final report are intentionally absent: controller automation owns both.
  writeJson(path.join(root,dirRel),{
    schemaVersion:'curveyield-audit-campaign-directory-entry-v2',campaignId:'demo-r1',campaignGenerationId:'demo-r1-g1',campaignName:'Demo',workspacePath:campaign,mode:'LITE',sourceSha256:source,lastSealedReceiptPath:predecessorRel,campaignStatus:'ACTIVE',
    currentAssignment:{phaseSequence:1,phaseId:'phase-1',reviewer:'reviewer-1',status:'ACTIVE',workSchemaPath:authority+'/phases/phase-1/PHASE_01_SCHEMA_v1.json',workFormPath:formRel,finalReportPath:reportRel,packetPath:packetRel,predecessorReceiptPath:predecessorRel,derivedInputPaths:[],controllerPrefillDigestSha256:prefillDigest},updatedAt:'2026-09-28T00:00:00Z'
  });
  return {root,campaign,dirRel,formRel,reportRel,packetRel,authority};
}

function run(f){
  const out=execFileSync(process.execPath,['scripts/lite-phase-packet-controller-v1.mjs','--controller-root',f.root,'--campaign-id','demo-r1','--campaign-path',f.campaign,'--campaign-directory-path',f.dirRel,'--phase-sequence','1'],{encoding:'utf8'});
  const envelope=JSON.parse(out.trim());
  return restoreControllerResultV1({root:f.root,campaignPath:f.campaign,envelope});
}

test('controller rejects a campaign id that does not match the canonical directory entry',()=>{
  const f=fixture();
  assert.throws(
    ()=>execFileSync(process.execPath,[
      'scripts/lite-phase-packet-controller-v1.mjs',
      '--controller-root',f.root,
      '--campaign-id','other-r1',
      '--campaign-path',f.campaign,
      '--campaign-directory-path',f.dirRel,
      '--phase-sequence','1'
    ],{encoding:'utf8',stdio:'pipe'}),
    /campaign-id does not match Audit Campaign Directory/
  );
});

test('incomplete semantic work causes exact rework while controller creates the packet and does zero bookkeeping',()=>{
  const f=fixture();
  const graphBefore=fs.readFileSync(path.join(f.root,f.campaign,'controller/SECURITY_TRACEABILITY_GRAPH_v1.json'),'utf8');
  const result=run(f);
  assert.equal(result.status,'NEEDS_REWORK');
  assert.match(result.feedbackText,/actions\.step-1\.outputs\.analysis is missing/);
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'receipts/PHASE_01_RECEIPT_v1.json')),false);
  assert.equal(fs.readFileSync(path.join(f.root,f.campaign,'controller/SECURITY_TRACEABILITY_GRAPH_v1.json'),'utf8'),graphBefore);
  const packet=readJson(path.join(f.root,f.packetRel));
  assert.equal(packet.status,'REWORK_REQUIRED');
  assert.equal(packet.controllerGenerated,true);
  assert.equal(packet.submissionAttempt,1);
  assert.equal(fs.existsSync(path.join(f.root,f.reportRel)),false);
  assert.equal(readJson(path.join(f.root,f.dirRel)).currentAssignment.status,'REWORK_REQUIRED');
});

test('repaired semantic work PASS auto-regenerates packet/report, bookkeeps once, and prepares Phase2',()=>{
  const f=fixture();
  run(f);
  const form=readJson(path.join(f.root,f.formRel));
  form.actions['step-1'].outputs.analysis='Substantive Phase-1 analysis complete.';
  writeJson(path.join(f.root,f.formRel),form);
  const result=run(f);
  assert.equal(result.status,'PASS');
  assert.equal(result.controllerPassToken,'CONTROLLER_PHASE_PASS');
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'receipts/PHASE_01_RECEIPT_v1.json')),true);
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'receipts/PHASE_02_RECEIPT_v1.json')),false);
  const directory=readJson(path.join(f.root,f.dirRel));
  assert.equal(directory.currentAssignment.phaseSequence,2);
  assert.equal(directory.currentAssignment.reviewer,'reviewer-2');
  assert.equal(directory.currentAssignment.status,'WAITING_FOR_SUCCESSOR_AGENT');
  assert.equal(fs.existsSync(path.join(f.root,directory.currentAssignment.workFormPath)),true);
  const acceptedPacket=readJson(path.join(f.root,f.packetRel));
  assert.equal(acceptedPacket.status,'ACCEPTED');
  assert.equal(acceptedPacket.controllerGenerated,true);
  assert.equal(acceptedPacket.submissionAttempt,2);
  assert.equal(fs.existsSync(path.join(f.root,f.reportRel)),true);
  assert.match(fs.readFileSync(path.join(f.root,f.reportRel),'utf8'),/CONTROLLER-GENERATED/);
  const graph=readJson(path.join(f.root,f.campaign,'controller/SECURITY_TRACEABILITY_GRAPH_v1.json'));
  assert.equal(graph.controllerImports.length,1);
});


test('assignment-backed digest rejects tampered controller input even if reviewer recomputes local digest',()=>{
  const f=fixture();
  const form=readJson(path.join(f.root,f.formRel));
  form.automationInputs.derivedInputPaths=['campaigns/demo/derived/forged.json'];
  refreshControllerPrefillDigest(form);
  form.actions['step-1'].outputs.analysis='Complete semantic work.';
  writeJson(path.join(f.root,f.formRel),form);
  const result=run(f);
  assert.equal(result.status,'NEEDS_REWORK');
  assert.match(result.feedbackText,/controller-prefill digest does not match the controller-owned assignment digest|Controller-prefilled\/read-only fields were modified/);
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'receipts/PHASE_01_RECEIPT_v1.json')),false);
});


test('accepted due-obligation disposition updates ledger and sealed receipt consistently',()=>{
  const f=fixture();
  const schemaPath=path.join(f.root,f.authority,'phases/phase-1/PHASE_01_SCHEMA_v1.json');
  const schema=readJson(schemaPath);
  schema.actions['step-1'].fields.push({
    name:'obligationDispositions',
    type:'REQUIRED_RECORD_LIST',
    consumers:['controller-bookkeeping'],
    itemRequiredFields:['obligationId','requiredAction','completionCondition','disposition','rationale','evidenceRefs','carryForwardPhaseOrNone'],
    itemFieldAllowedValues:{disposition:['SATISFIED','CARRY_FORWARD','BLOCKED_CARRIED','NOT_APPLICABLE'],carryForwardPhaseOrNone:['NONE_IDENTIFIED','4','6']}
  });
  schema.bookkeepingMappings.obligationRecordPaths=['actions.step-1.outputs.obligationDispositions'];
  writeJson(schemaPath,schema);

  const ledgerPath=path.join(f.root,f.campaign,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json');
  const obligation={
    obligationId:'OBL-P1-CONTEXT-001',originPhase:'0',originatingFactIds:[],originatingEvidenceRefs:['e0'],
    requiredPhase:'1',requiredReviewer:'reviewer-1',requiredAction:'Interpret Phase-0 evidence',
    completionCondition:'Record semantic disposition',mandatory:true,status:'OPEN',statusReason:null,
    closureEvidenceRefs:[],supersedesOrReplaces:[],createdAt:'2026-09-29T00:00:00Z',updatedAt:'2026-09-29T00:00:00Z'
  };
  writeJson(ledgerPath,{obligations:[obligation],phaseCheckpoints:[]});

  const form=readJson(path.join(f.root,f.formRel));
  form.actions['step-1'].outputs.analysis='Substantive Phase-1 analysis complete.';
  form.actions['step-1'].outputs.obligationDispositions=[{
    obligationId:obligation.obligationId,
    requiredAction:obligation.requiredAction,
    completionCondition:obligation.completionCondition,
    disposition:'SATISFIED',
    rationale:'Phase-1 semantic review completed the obligation.',
    evidenceRefs:['work/phase-01/PHASE_01_WORK_FORM_v1.json'],
    carryForwardPhaseOrNone:'NONE_IDENTIFIED',
    automationOwnedFields:['obligationId','requiredAction','completionCondition']
  }];
  form.automationInputs.expectedDueObligationIds=[obligation.obligationId];
  form.automationInputs.controllerOwnedAutomationInputs=[
    ...(form.automationInputs.controllerOwnedAutomationInputs??[]),
    'expectedDueObligationIds'
  ];
  const digest=refreshControllerPrefillDigest(form);
  writeJson(path.join(f.root,f.formRel),form);
  const directory=readJson(path.join(f.root,f.dirRel));
  directory.currentAssignment.controllerPrefillDigestSha256=digest;
  writeJson(path.join(f.root,f.dirRel),directory);

  const result=run(f);
  assert.equal(result.status,'PASS');
  const ledger=readJson(ledgerPath);
  assert.equal(ledger.obligations[0].status,'SATISFIED');
  assert.ok(ledger.obligations[0].closureEvidenceRefs.some(x=>x.includes('PHASE_01_CANONICAL_DATA_v1.json')));
  const receipt=readJson(path.join(f.root,f.campaign,'receipts/PHASE_01_RECEIPT_v1.json'));
  assert.equal(receipt.obligations.due[0].obligationId,obligation.obligationId);
  assert.equal(receipt.obligations.closed[0].obligationId,obligation.obligationId);
});


function runMaster(f,outcome,segmentId='reviewer-1-phase-01'){
  const args=['scripts/lite-phase-packet-controller-v1.mjs','--controller-root',f.root,'--campaign-id','demo-r1','--campaign-path',f.campaign,'--campaign-directory-path',f.dirRel,'--review-kind','master','--segment-id',segmentId];
  if(outcome)args.push('--master-outcome',outcome,'--master-summary-b64',Buffer.from('Master reviewed the whole segment.').toString('base64'));
  const out=execFileSync(process.execPath,args,{encoding:'utf8'});
  return restoreControllerResultV1({root:f.root,campaignPath:f.campaign,envelope:JSON.parse(out.trim())});
}

function fileSha(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function masterFixture(analysis){
  const f=fixture();
  const directory=readJson(path.join(f.root,f.dirRel));
  directory.masterReview={chatUrl:'https://chatgpt.com/c/master-review-chat',reasoning:'MAXIMUM',repairModel:'SOL',repairReasoning:'HIGH'};
  writeJson(path.join(f.root,f.dirRel),directory);
  const predecessor=readJson(path.join(f.root,directory.lastSealedReceiptPath));
  predecessor.authority.liteSkillSha256=createHash('sha256').update(fs.readFileSync(path.join(f.root,f.authority,'SKILL.md'))).digest('hex');
  predecessor.authority.liteRelease='Audit_Litemode_v11';
  writeJson(path.join(f.root,directory.lastSealedReceiptPath),predecessor);
  writeJson(path.join(f.root,f.campaign,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'),{source:{archiveSha256:'a'.repeat(64)}});
  const form=readJson(path.join(f.root,f.formRel));
  form.actions['step-1'].outputs.analysis=analysis;
  writeJson(path.join(f.root,f.formRel),form);
  return f;
}
// The trusted workflow commits sealed state to Audit-Controller; the controller
// recovers amended originals from that git history.
function commitControllerState(f){
  const git=(...args)=>execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{cwd:f.root,stdio:'pipe'});
  if(!fs.existsSync(path.join(f.root,'.git')))git('init','-q');
  git('add','-A');git('commit','-q','-m','sealed state');
}

test('v11-configured Phase 1 seals but cannot create Phase 2 until master ACCEPT_WITHOUT_MODIFICATIONS',()=>{
  const f=masterFixture('Master-gated Phase-1 analysis.');
  const phaseResult=run(f);
  assert.equal(phaseResult.status,'WAITING_FOR_MASTER_REVIEW');
  assert.match(phaseResult.feedbackText,/MASTER_REVIEW_REQUIRED:/);
  assert.match(phaseResult.feedbackText,/Audit_Litemode_v10\.2\/master-review\/START_HERE\.md/);
  const waiting=readJson(path.join(f.root,f.dirRel));
  assert.equal(waiting.campaignStatus,'WAITING_FOR_MASTER_REVIEW');
  assert.equal(waiting.currentAssignment,null);
  assert.equal(waiting.pendingMasterReview.segmentId,'reviewer-1-phase-01');
  assert.deepEqual(waiting.pendingMasterReview.segmentPhases,[1]);
  assert.match(waiting.pendingMasterReview.bindingsSha256,/^[0-9a-f]{64}$/);
  assert.equal(waiting.pendingMasterReview.sealedWorkForms.length,1);
  assert.match(waiting.pendingMasterReview.sealedWorkForms[0].gitBlobSha1,/^[0-9a-f]{40}$/);
  const recordPath=path.join(f.root,waiting.pendingMasterReview.recordPath);
  const record=readJson(recordPath);
  assert.deepEqual([...new Set(record.reviewedArtifacts.map(x=>x.phase))],[1]);
  for(const kind of ['WORK_FORM','CANONICAL_DATA','PHASE_REPORT','SEALED_RECEIPT','GLOBAL_CONTROL_SOURCEINTELLIGENCEBUNDLE','INPUT_CONTROLLER_GENERATED_PHASE_WORK_PACKET'])assert.ok(record.reviewedArtifacts.some(x=>x.kind===kind),kind);

  const noOutcome=runMaster(f,null);
  assert.equal(noOutcome.status,'MASTER_REVIEW_INVALID');
  assert.match(noOutcome.feedbackText,/masterOutcome must be AMENDED or ACCEPT_WITHOUT_MODIFICATIONS/);

  const sealedForm=fs.readFileSync(path.join(f.root,f.formRel));
  const edited=readJson(path.join(f.root,f.formRel));
  edited.actions['step-1'].outputs.analysis='Silently changed analysis.';
  writeJson(path.join(f.root,f.formRel),edited);
  const acceptWithEdits=runMaster(f,'ACCEPT_WITHOUT_MODIFICATIONS');
  assert.equal(acceptWithEdits.status,'MASTER_REVIEW_INVALID');
  assert.match(acceptWithEdits.feedbackText,/submit AMENDED instead/);
  fs.writeFileSync(path.join(f.root,f.formRel),sealedForm);
  const amendWithoutEdits=runMaster(f,'AMENDED');
  assert.equal(amendWithoutEdits.status,'MASTER_REVIEW_INVALID');
  assert.match(amendWithoutEdits.feedbackText,/submit ACCEPT_WITHOUT_MODIFICATIONS instead/);

  const stoppedDirectory=readJson(path.join(f.root,f.dirRel));
  stoppedDirectory.campaignStatus='STOPPED_BY_HUMAN';
  writeJson(path.join(f.root,f.dirRel),stoppedDirectory);
  const stoppedDirectoryBytes=fs.readFileSync(path.join(f.root,f.dirRel),'utf8');
  const held=runMaster(f,'ACCEPT_WITHOUT_MODIFICATIONS');
  assert.equal(held.status,'MASTER_REVIEW_HELD');
  assert.equal(fs.readFileSync(path.join(f.root,f.dirRel),'utf8'),stoppedDirectoryBytes);
  stoppedDirectory.campaignStatus='WAITING_FOR_MASTER_REVIEW';
  writeJson(path.join(f.root,f.dirRel),stoppedDirectory);

  const accepted=runMaster(f,'ACCEPT_WITHOUT_MODIFICATIONS');
  assert.equal(accepted.status,'PASS');
  assert.equal(accepted.masterReviewAccepted,true);
  assert.equal(accepted.freshSuccessorRequired,true);
  const advanced=readJson(path.join(f.root,f.dirRel));
  assert.equal(Object.hasOwn(advanced,'pendingMasterReview'),false);
  assert.equal(advanced.currentAssignment.phaseSequence,2);
  assert.equal(advanced.campaignStatus,'WAITING_FOR_SUCCESSOR_AGENT');
  assert.equal(advanced.lastAcceptedMasterReview.outcome,'ACCEPT_WITHOUT_MODIFICATIONS');
  assert.equal(readJson(recordPath).decision.outcome,'ACCEPT_WITHOUT_MODIFICATIONS');
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'superseded')),false);
});

test('segment collection binds legacy missing digests but rejects a supplied malformed receipt digest',()=>{
  const f=fixture();
  const directory=readJson(path.join(f.root,f.dirRel));
  directory.masterReview={chatUrl:'https://chatgpt.com/c/master-review-chat',reasoning:'MAXIMUM',repairModel:'SOL',repairReasoning:'HIGH'};
  writeJson(path.join(f.root,f.dirRel),directory);
  const predecessor=readJson(path.join(f.root,directory.lastSealedReceiptPath));
  predecessor.authority.liteSkillSha256=createHash('sha256').update(fs.readFileSync(path.join(f.root,f.authority,'SKILL.md'))).digest('hex');
  writeJson(path.join(f.root,directory.lastSealedReceiptPath),predecessor);
  writeJson(path.join(f.root,f.campaign,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'),{});
  const form=readJson(path.join(f.root,f.formRel));
  form.actions['step-1'].outputs.analysis='Digest-bound Phase-1 analysis.';
  writeJson(path.join(f.root,f.formRel),form);
  run(f);
  const waiting=readJson(path.join(f.root,f.dirRel));
  const receipt=readJson(path.join(f.root,waiting.lastSealedReceiptPath));
  assert.equal(receipt.inputs[0].sha256,undefined);
  const originalReceipt=structuredClone(receipt);
  receipt.inputs[0].sha256='not-a-sha256';
  writeJson(path.join(f.root,waiting.lastSealedReceiptPath),receipt);
  const collect=()=>collectSegmentArtifacts({root:f.root,campaignPath:f.campaign,segment:MASTER_REVIEW_SEGMENTS_V1[0],directory:waiting,expectedAuthority:receipt.authority});
  assert.throws(collect,/invalid sha256/);
  receipt.inputs[0]={role:'PREDECESSOR_RECEIPT',path:''};
  writeJson(path.join(f.root,waiting.lastSealedReceiptPath),receipt);
  assert.throws(collect,/reference path is required/);
  writeJson(path.join(f.root,waiting.lastSealedReceiptPath),originalReceipt);
  const canonicalPath=path.join(f.root,f.campaign,'derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json');
  const canonical=readJson(canonicalPath);
  delete canonical.finalReportPath;
  writeJson(canonicalPath,canonical);
  assert.throws(collect,/required Phase 1 report path is missing/);
});

test('master AMENDED edits are resealed in place and the sealed originals move to superseded/',()=>{
  const f=masterFixture('Reviewable but incomplete Phase-1 analysis.');
  run(f);
  commitControllerState(f);
  const waiting=readJson(path.join(f.root,f.dirRel));
  const sealed=waiting.pendingMasterReview.sealedWorkForms[0];
  const sealedFormBytes=fs.readFileSync(path.join(f.root,f.formRel));
  const sealedReportBytes=fs.readFileSync(path.join(f.root,f.reportRel));
  const canonicalPath=path.join(f.root,f.campaign,'derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json');
  const sealedCanonicalBytes=fs.readFileSync(canonicalPath);

  const tampered=readJson(path.join(f.root,f.formRel));
  tampered.actions['step-1'].outputs.analysis='Corrected evidence-bound Phase-1 analysis.';
  tampered.automationInputs.derivedInputPaths=['campaigns/demo/derived/forged-during-master-review.json'];
  writeJson(path.join(f.root,f.formRel),tampered);
  const rejectedTamper=runMaster(f,'AMENDED');
  assert.equal(rejectedTamper.status,'MASTER_REVIEW_INVALID');
  assert.match(rejectedTamper.feedbackText,/changed controller-owned data outside reviewer-written fields/);

  const amended=JSON.parse(sealedFormBytes.toString('utf8'));
  amended.actions['step-1'].outputs.analysis='Corrected evidence-bound Phase-1 analysis.';
  writeJson(path.join(f.root,f.formRel),amended);
  const forgedCanonical=JSON.parse(sealedCanonicalBytes.toString('utf8'));
  forgedCanonical.actions['step-1'].outputs.analysis='Unreviewed manual derived-product edit.';
  writeJson(canonicalPath,forgedCanonical);
  const rejectedProductEdit=runMaster(f,'AMENDED');
  assert.equal(rejectedProductEdit.status,'MASTER_REVIEW_INVALID');
  assert.match(rejectedProductEdit.feedbackText,/reviewed artifact digest changed/);
  fs.writeFileSync(canonicalPath,sealedCanonicalBytes);
  assert.equal(readJson(path.join(f.root,f.dirRel)).currentAssignment,null);

  const accepted=runMaster(f,'AMENDED');
  assert.equal(accepted.status,'PASS',accepted.feedbackText);
  assert.equal(accepted.masterReviewAccepted,true);
  assert.equal(accepted.masterOutcome,'AMENDED');
  assert.equal(accepted.freshSuccessorRequired,true);
  assert.equal(accepted.nextAssignment.phaseSequence,2);

  // Original seal and receipt remain; the amended phase is resealed as revision 2.
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'receipts/PHASE_01_RECEIPT_v1.json')),true);
  const receipt2=readJson(path.join(f.root,f.campaign,'receipts/PHASE_01_RECEIPT_v2.json'));
  assert.equal(receipt2.masterAmendment.segmentId,'reviewer-1-phase-01');
  assert.equal(receipt2.masterAmendment.amendmentRecordPath,waiting.pendingMasterReview.recordPath);
  assert.equal(receipt2.masterAmendment.priorRevision,1);

  // Revised products occupy the standard locations.
  assert.equal(readJson(path.join(f.root,f.formRel)).actions['step-1'].outputs.analysis,'Corrected evidence-bound Phase-1 analysis.');
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'work/phase-01/PHASE_01_FINAL_REPORT_v2.md')),true);
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'submissions/PHASE_01_WORK_PACKET_v2.json')),true);
  assert.equal(readJson(canonicalPath).actions['step-1'].outputs.analysis,'Corrected evidence-bound Phase-1 analysis.');

  // Outdated reviewer products are preserved byte-for-byte in one superseded/ folder.
  const sup=rel=>path.join(f.root,f.campaign,'superseded',path.posix.relative(f.campaign,rel));
  assert.deepEqual(fs.readFileSync(sup(f.formRel)),sealedFormBytes);
  assert.equal(fileSha(sup(f.formRel)),sealed.sha256);
  assert.deepEqual(fs.readFileSync(sup(f.reportRel)),sealedReportBytes);
  assert.deepEqual(fs.readFileSync(sup(path.posix.join(f.campaign,'derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json'))),sealedCanonicalBytes);
  assert.equal(fs.existsSync(sup(f.packetRel)),true);
  assert.equal(fs.existsSync(path.join(f.root,f.reportRel)),false);
  assert.equal(fs.existsSync(path.join(f.root,f.packetRel)),false);

  const record=readJson(path.join(f.root,waiting.pendingMasterReview.recordPath));
  assert.equal(record.decision.outcome,'AMENDED');
  assert.deepEqual(record.decision.refreshedPhases,[1]);
  assert.deepEqual(record.decision.amendedForms.map(x=>[x.path,x.changedFields]),[[path.posix.relative(f.campaign,f.formRel),['actions.step-1.outputs.analysis']]]);
  const formEntry=record.decision.superseded.find(x=>x.originalPath===path.posix.relative(f.campaign,f.formRel));
  assert.equal(formEntry.supersededPath,'superseded/'+formEntry.originalPath);
  assert.equal(formEntry.sha256,sealed.sha256);
  assert.equal(formEntry.replacedBySha256,fileSha(path.join(f.root,f.formRel)));
  assert.equal(record.decision.superseded.find(x=>x.kind==='PHASE_REPORT').replacedBySha256,null);

  const advanced=readJson(path.join(f.root,f.dirRel));
  assert.equal(Object.hasOwn(advanced,'pendingMasterReview'),false);
  assert.equal(advanced.currentAssignment.phaseSequence,2);
  assert.equal(advanced.campaignStatus,'WAITING_FOR_SUCCESSOR_AGENT');
  assert.equal(advanced.lastSealedReceiptPath,f.campaign+'/receipts/PHASE_01_RECEIPT_v2.json');
  assert.equal(advanced.lastAcceptedMasterReview.outcome,'AMENDED');
});

test('typed held revision2-to-revision3 admission regenerates controller products and resolves EIM-013',()=>{
  const f=fixture();
  const oldAuthority=f.authority;
  const authority='Audit Skill - Current Authority/Audit_Litemode_v10.3';
  mkdir(path.join(f.root,authority,'phases/phase-1/resources'));
  mkdir(path.join(f.root,authority,'phases/phase-2/resources'));
  for(const rel of [
    'phases/phase-1/PHASE_01_SCHEMA_v1.json',
    'phases/phase-2/PHASE_02_SCHEMA_v1.json',
    'phases/phase-2/resources/PHASE_02_WORK_FORM_TEMPLATE_v1.json',
    'phases/phase-2/resources/PHASE_02_FINAL_REPORT_TEMPLATE_v1.md'
  ]){
    const src=path.join(f.root,oldAuthority,rel),dst=path.join(f.root,authority,rel);
    mkdir(path.dirname(dst));fs.copyFileSync(src,dst);
  }
  write(path.join(f.root,authority,'SKILL.md'),'# frozen v10.3 fixture\n');
  writeJson(path.join(f.root,authority,'MANIFEST.json'),{release:'Audit_Litemode_v10.3',entrypoint:'SKILL.md',files:[]});
  const priorFormRel=f.campaign+'/work/phase-01/PHASE_01_WORK_FORM_v2.json';
  const repairedFormRel=f.campaign+'/work/phase-01/PHASE_01_WORK_FORM_v3.json';
  const priorForm=readJson(path.join(f.root,f.formRel));
  priorForm.actions['step-1'].outputs.analysis='Old incomplete interpretation.';
  writeJson(path.join(f.root,priorFormRel),priorForm);
  const repaired=structuredClone(priorForm);
  repaired.actions['step-1'].outputs.analysis='Corrected, source-bound interpretation.';
  writeJson(path.join(f.root,repairedFormRel),repaired);
  const phase0=readJson(path.join(f.root,f.campaign,'receipts/PHASE_00_RECEIPT_v1.json'));
  phase0.authority={...phase0.authority,homepagePath:authority+'/SKILL.md',liteSkillSha256:'bdb90107ea50580e67be91440ce47087de570c4f54b8474c5a3eb852af95ea27'};
  writeJson(path.join(f.root,f.campaign,'receipts/PHASE_00_RECEIPT_v1.json'),phase0);
  const priorReceiptRel=f.campaign+'/receipts/PHASE_01_RECEIPT_v2.json';
  writeJson(path.join(f.root,priorReceiptRel),{
    phase:{sequence:1,revision:2,status:'SEALED'},source:{sha256:'a'.repeat(64)},authority:phase0.authority,
    inputs:[{role:'PREDECESSOR_RECEIPT',path:f.campaign+'/receipts/PHASE_00_RECEIPT_v1.json'}],
    evidence:[{role:'PHASE_WORK_FORM',path:path.posix.relative(f.campaign,priorFormRel),sha256:createHash('sha256').update(fs.readFileSync(path.join(f.root,priorFormRel))).digest('hex')}],
    outputs:[{role:'PHASE_WORK_FORM',path:path.posix.relative(f.campaign,priorFormRel),sha256:createHash('sha256').update(fs.readFileSync(path.join(f.root,priorFormRel))).digest('hex')}]
  });
  const reworkDirectory=readJson(path.join(f.root,f.dirRel));
  reworkDirectory.lastSealedReceiptPath=priorReceiptRel;
  writeJson(path.join(f.root,f.dirRel),reworkDirectory);
  const qualityRel=f.campaign+'/work/phase-01/review/PHASE_01_QUALITY_REVIEW_v2.md';
  const authRel=f.campaign+'/controller/HUMAN_REWORK_AUTHORIZATION_v1.json';
  write(path.join(f.root,qualityRel),'# Quality review\nBounded correction approved.\n');
  const allowedReworkPaths=['actions.step-1.outputs.analysis'];
  writeJson(path.join(f.root,authRel),{schemaVersion:'curveyield-human-rework-authorization-v1',scopeId:'phase1-r2-r3',campaignId:'demo-r1',campaignGenerationId:'demo-r1-g1',phaseSequence:1,fromRevision:2,toRevision:3,sourceSha256:'a'.repeat(64),authorityLogicalRoot:authority,allowedSemanticPaths:allowedReworkPaths,deliveryHold:true,mainCodeMergeAuthorized:false,recordedAt:'2026-10-04T00:00:00Z'});
  writeJson(path.join(f.root,f.campaign,'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json'),{events:[{eventId:'INV-P1-REWORK-001',ruleId:'EIM-013',status:'RESOLVED_BY_PHASE_1_REVISION_2'}]});
  const digest=rel=>createHash('sha256').update(fs.readFileSync(path.join(f.root,rel))).digest('hex');
  const requestRel=f.campaign+'/controller/SEALED_PHASE_REWORK_REQUEST_v1.json';
  writeJson(path.join(f.root,requestRel),{
    schemaVersion:'curveyield-lite-sealed-phase-rework-request-v1',campaignId:'demo-r1',phaseSequence:1,fromRevision:2,toRevision:3,sourceSha256:'a'.repeat(64),
    authority:{logicalRoot:authority,expectedRootSha256:'bdb90107ea50580e67be91440ce47087de570c4f54b8474c5a3eb852af95ea27',expectedManifestSha256:'846be5f90d6e00757b817b1218dfabeb2aa4dff6c92b8e9ff47335d2db83703a'},
    priorReceipt:{path:priorReceiptRel,sha256:digest(priorReceiptRel)},priorWorkForm:{path:priorFormRel,sha256:digest(priorFormRel)},repairedWorkForm:{path:repairedFormRel,sha256:digest(repairedFormRel)},
    qualityReview:{path:qualityRel,sha256:digest(qualityRel)},humanAuthorization:{scopeId:'phase1-r2-r3',recordPath:authRel,recordSha256:digest(authRel),authorizedAt:'2026-10-04T00:00:00Z'},
    generatedFinalReportPath:f.campaign+'/work/phase-01/PHASE_01_FINAL_REPORT_v3.md',generatedPacketPath:f.campaign+'/submissions/PHASE_01_WORK_PACKET_v3.json',
    allowedSemanticPaths:allowedReworkPaths,dependentRefresh:{regenerateCanonical:true,regenerateReport:true,regenerateDerived:true,resealReceipt:true,prepareSuccessorAssignment:true},
    evidenceInvalidation:{eventId:'INV-P1-REWORK-002',ruleId:'EIM-013',requiredPriorStatus:'SEALED_REVISION_2',resolveTo:'RESOLVED_BY_PHASE_1_REVISION_3'},holdSuccessorDelivery:true
  });
  const out=execFileSync(process.execPath,['scripts/lite-phase-packet-controller-v1.mjs','--controller-root',f.root,'--campaign-id','demo-r1','--campaign-path',f.campaign,'--campaign-directory-path',f.dirRel,'--review-kind','sealed-rework','--phase-sequence','1','--rework-request-path',requestRel],{encoding:'utf8'});
  const result=restoreControllerResultV1({root:f.root,campaignPath:f.campaign,envelope:JSON.parse(out.trim())});
  assert.equal(result.status,'PASS');
  assert.equal(result.sealedRework,true);
  const persistentHold=readJson(path.join(f.root,f.campaign,'controller/SUCCESSOR_DELIVERY_HOLD_v1.json'));
  assert.equal(persistentHold.status,'ACTIVE');
  assert.equal(persistentHold.scopeId,'phase1-r2-r3');
  assert.equal(persistentHold.releaseRequiresExplicitHumanAuthorization,true);
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'receipts/PHASE_01_RECEIPT_v3.json')),true);
  const canonical=readJson(path.join(f.root,f.campaign,'derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json'));
  assert.equal(canonical.actions['step-1'].outputs.analysis,'Corrected, source-bound interpretation.');
  const invalid=readJson(path.join(f.root,f.campaign,'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json'));
  assert.equal(invalid.events[0].status,'RESOLVED_BY_PHASE_1_REVISION_2');
  assert.equal(invalid.events[1].eventId,'INV-P1-REWORK-002');
  assert.equal(invalid.events[1].status,'RESOLVED_BY_PHASE_1_REVISION_3');
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'work/phase-01/PHASE_01_FINAL_REPORT_v3.md')),true);
  assert.equal(fs.existsSync(path.join(f.root,f.campaign,'submissions/PHASE_01_WORK_PACKET_v3.json')),true);
  assert.equal(readJson(path.join(f.root,f.dirRel)).currentAssignment.phaseSequence,2);
});


test('legacy v10.3 fallback is read-only and rejects an unpinned frozen package',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lite-frozen-authority-'));
  const frozen='audit-process/v7/frozen-authorities/Audit_Litemode_v10.3';
  write(path.join(root,frozen,'SKILL.md'),'tampered');
  writeJson(path.join(root,frozen,'MANIFEST.json'),{release:'Audit_Litemode_v10.3',entrypoint:'SKILL.md',files:[]});
  assert.throws(()=>requiredFile(root,'Audit Skill - Current Authority/Audit_Litemode_v10.3/SKILL.md'),/root hash mismatch/);
  assert.equal(repoFile(root,'Audit Skill - Current Authority/Audit_Litemode_v10.3/SKILL.md'),path.join(root,'Audit Skill - Current Authority/Audit_Litemode_v10.3/SKILL.md'));
});
