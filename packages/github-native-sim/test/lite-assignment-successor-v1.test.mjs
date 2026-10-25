import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const mkdir=p=>fs.mkdirSync(p,{recursive:true});
const write=(p,v)=>{mkdir(path.dirname(p));fs.writeFileSync(p,v);};
const writeJson=(p,v)=>write(p,JSON.stringify(v,null,2)+'\n');

test('fresh successor preparation accepts absent controller-owned final report and emits the short successor message',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lite-successor-'));
  const campaign='campaigns/demo';
  const directoryRel='Audit Campaign Directory/campaigns/demo.json';
  const schemaRel='Audit Skill - Current Authority/Audit_Litemode_v10.2/phases/phase-2/PHASE_02_SCHEMA_v1.json';
  const formRel=campaign+'/work/phase-02/PHASE_02_WORK_FORM_v1.json';
  const reportRel=campaign+'/work/phase-02/PHASE_02_FINAL_REPORT_v1.md';
  const predecessorRel=campaign+'/receipts/PHASE_01_RECEIPT_v1.json';
  write(path.join(root,schemaRel),'{}\n');
  writeJson(path.join(root,formRel),{schemaVersion:'curveyield-lite-phase-work-form-v1',phase:2,actions:{}});
  writeJson(path.join(root,predecessorRel),{phase:{status:'SEALED'}});
  writeJson(path.join(root,directoryRel),{
    schemaVersion:'curveyield-audit-campaign-directory-entry-v2',
    campaignId:'demo-r1',campaignGenerationId:'demo-r1-g1',campaignName:'Demo',workspacePath:campaign,
    campaignStatus:'WAITING_FOR_SUCCESSOR_AGENT',
    currentAssignment:{
      phaseSequence:2,phaseId:'phase-2',reviewer:'reviewer-2',status:'WAITING_FOR_SUCCESSOR_AGENT',
      workSchemaPath:schemaRel,workFormPath:formRel,finalReportPath:reportRel,
      packetPath:campaign+'/submissions/PHASE_02_WORK_PACKET_v1.json',
      predecessorReceiptPath:predecessorRel,derivedInputPaths:[campaign+'/derived/phase-1/PHASE2_INPUT_v1.json']
    }
  });
  assert.equal(fs.existsSync(path.join(root,reportRel)),false);
  const controllerRef='campaign/ref-v1';
  const raw=execFileSync(process.execPath,['scripts/prepare-lite-assignment-successor-v2.mjs','--controller-root',root,'--campaign-directory-path',directoryRel,'--audit-controller-ref',controllerRef],{encoding:'utf8'});
  const result=JSON.parse(raw);
  assert.equal(result.status,'PASS');
  assert.match(result.wakeMessage,/LITE audit: Demo/);
  assert.match(result.wakeMessage,/Reviewer: reviewer-2/);
  assert.match(result.wakeMessage,/Current phase: phase-2/);
  assert.match(result.wakeMessage,/Start phase-2 now/);
  // Short successor message (restored in 0338cfc7): campaign and authority links only.
  assert.match(result.wakeMessage,/Campaign: https:\/\/github\.com\/curveyield3\/Audit-Controller\/tree\/campaign%2Fref-v1\/campaigns\/demo/);
  assert.match(result.wakeMessage,/Current Audit Skill Authority: https:\/\/github\.com\/curveyield3\/Audit-Controller\/blob\/campaign%2Fref-v1\/Audit%20Skill%20-%20Current%20Authority\/Audit_Litemode_v10\.2\/SKILL\.md/);
  assert.match(result.wakeMessage,/ultimate authority/i);
  assert.match(result.wakeMessage,/in order, precisely, with no deviation/i);
  assert.match(result.wakeMessage,/do not redo sealed earlier phases/i);
  assert.doesNotMatch(result.wakeMessage,/Controller validation request schema:/);
  assert.doesNotMatch(result.wakeMessage,/Campaign ID \/ generation:/);
});
