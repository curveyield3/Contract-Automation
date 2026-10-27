import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createUnitPlanV1,processUnitRequestV1} from '../../../lib/lite-solo-unit-queue-v1.mjs';
import {reviewInventoryRelV1} from '../../../../packages/github-native-sim/src/adr-review-inventory-v1.mjs';
import {readUnitPacketV1} from '../../../../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';

export const digest = b=>createHash('sha256').update(b).digest('hex');
export const json = x=>JSON.stringify(x,null,2)+'\n';
export const put = (root,rel,obj)=>{
 const filename=path.join(root,rel);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,json(obj));
};
export const get = (root,rel)=>JSON.parse(fs.readFileSync(path.join(root,rel),'utf8'));
export const writeFile=(root,rel,text)=>{
 const filename=path.join(root,rel);fs.mkdirSync(path.dirname(filename),{recursive:true});fs.writeFileSync(filename,text);
};
export const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
export const outputDir=path.resolve('scripts/tests/lite-solo-v4-acceptance/output');
export function evidence(id,scope,status,details){
 fs.mkdirSync(outputDir,{recursive:true});
 const filepath=path.join(outputDir,id+'_'+scope+'.json');
 fs.writeFileSync(filepath,json({scenarioId:id,scope,status,runTime:new Date().toISOString(),
  implementationCommit:process.env.GITHUB_SHA??'LOCAL',...details}));
 return filepath;
}
export function fixture(id,{flowCount,attackCount=0,heavy=false}={}){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lite-v4-'+id+'-'));
 const root=path.join(temp,'audit-controller');fs.mkdirSync(root);
 const campaign='campaigns/acceptance-'+id.toLowerCase(),slug='acceptance-'+id.toLowerCase();
 const sourceLines=['pragma solidity ^0.8.20;','contract Fixture {'];
 const reviewUnits=[],contexts=[],units=[],attacks=[];
 for(let n=1;n<=flowCount;n++){
  const unitId=n<=100?'F-'+String(n).padStart(3,'0'):'R-'+String(n-100).padStart(3,'0');
  const count=heavy&&n<=10?12:1,primary=[];
  for(let j=0;j<count;j++){
   const id='CTX-'+String(contexts.length+1).padStart(5,'0');
   const name='review'+String(contexts.length+1);
   sourceLines.push('  function '+name+'() external pure returns (uint256) { return '+(contexts.length+1)+'; }');
   const lineStart=sourceLines.length;
   contexts.push({contextId:id,kind:'FUNCTION',canonicalSignature:name+'()',qualifiedContainer:'Fixture',
    path:'Fixture.sol',lineStart,lineEnd:lineStart,modifiers:[],effectiveIn:['Fixture']});
   primary.push(id);
  }
  reviewUnits.push({unitId,role:'FLOW_REVIEW',primaryContextIds:primary,readContextIds:primary,
   flowIds:[],integrationQuestionIds:[]});
  units.push(unitId);
 }
 for(let n=1;n<=attackCount;n++){
  const unitId='X-'+String(n).padStart(3,'0');
  attacks.push({unitId,role:'ATTACK',contracts:['Fixture'],primaryContextIds:[],
   flowIds:[],integrationQuestionIds:[]});
 }
 sourceLines.push('}');
 const source=sourceLines.join('\n')+'\n';
 writeFile(root,campaign+'/source/Fixture.sol',source);
 const hash=digest(source);
 const authorityDigest=digest('admitted lite-solo-v4 synthetic fixture for '+id);
 const directory={schemaVersion:'curveyield-audit-campaign-directory-entry-v2',
  mode:'LITE_SOLO',executionModel:'PARALLEL_WORKER_UNITS',authorityRelease:'lite-solo-v4',
  authorityDigest,sourceSha256:hash,campaignId:slug+'-r1',campaignGenerationId:'gen-'+slug+'-1',
  workspacePath:campaign,unitPhaseEpoch:1,
  currentAssignment:{phaseSequence:4,reviewer:'lite-solo-agent'}};
 const directoryPath='Audit Campaign Directory/campaigns/'+slug+'.json';
 put(root,directoryPath,directory);
 // Use the literal bound v4 phase schema; do not stub phase validation.
 const boundSchema=fs.readFileSync(path.resolve('scripts/tests/lite-solo-v4-acceptance/fixtures/PHASE_04_SCHEMA_v1.json'),'utf8');
 writeFile(root,'Audit Skill - Lite-Solo Authority/lite-solo-v4/phases/phase-4/PHASE_04_SCHEMA_v1.json',boundSchema);
 const inventoryRel=reviewInventoryRelV1(root,campaign,'REVIEW_INVENTORY_v1.json');
 put(root,inventoryRel,{schemaVersion:'test-source-inventory-v1',payload:{contexts,
  sourceUnits:[{path:'Fixture.sol',lineCount:sourceLines.length,scopeTier:'IN_SCOPE'}],triggers:{}}});
 const planRel=reviewInventoryRelV1(root,campaign,'FLOW_PLAN_v1.json');
 put(root,planRel,{schemaVersion:'test-flow-plan-v1',payload:{reviewUnits,attackUnits:attacks,
  flows:[],integrationQuestions:[],gaps:[]}});
 const factsRel=reviewInventoryRelV1(root,campaign,'SYSTEM_FACTS_v1.json');
 put(root,factsRel,{schemaVersion:'test-system-facts-v1',payload:{
  siblingGroups:[],guardTable:[],crossContractEdges:[],valueFlows:[]}});
 const stateRel=campaign+'/work/phase-04/units/UNIT_QUEUE_STATE_v1.json';
 function request(operation,workerId,requestId,fields={}){
  return {schemaVersion:'curveyield-lite-solo-unit-batch-request-v1',requestId,operation,
   workerId,lane:'AUTO',campaignId:directory.campaignId,
   campaignGenerationId:directory.campaignGenerationId,phaseSequence:4,
   sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
   phaseEpoch:1,auditControllerRef:'main',...fields};
 }
 function process(r){
  const live=get(root,directoryPath);
  const result=processUnitRequestV1({root,campaignPath:campaign,directory:live,request:r});
  put(root,directoryPath,live);return result;
 }
 return {root,temp,campaign,directory,directoryPath,units,attacks,stateRel,request,process,
  plan:()=>createUnitPlanV1({root,campaignPath:campaign,directory:get(root,directoryPath),phase:4}),
  state:()=>get(root,stateRel),
  packet:(unitId)=>readUnitPacketV1({root,packetPath:campaign+'/work/phase-04/discovery/'+unitId+'/ASSIGNMENT_PACKET_v1.json'}),
  cleanup:()=>fs.rmSync(temp,{recursive:true,force:true})};
}
export function correctSubmission(packet){
 const p=packet.payload;
 return {schemaVersion:'curveyield-flow-review-submission-v1',unitId:p.unitId,
  rows:p.primaryContextIds.map(id=>{
   const c=p.primaryContexts.find(x=>x.contextId===id);
   const rules=(p.documentationItems??[]).filter(x=>x.contextId===id);
   return {contextId:id,verdict:'CORRECT',
    intent:'Fixture method returns its declared literal without any state mutation.',
    reason:'The fixture implementation returns its constant expression without external calls; no state is written.',
    anchors:[c.path+':L'+c.lineStart+'-L'+c.lineEnd],
    specInspection:{status:rules.length?'MATCH':'NO_DOCUMENTED_RULES',
     docsAndCommentsChecked:'Inspected complete Fixture.sol and source documentation in synthetic fixture.',
     namedConstantsChecked:'Checked deterministic return literal and found no named policy constant.'},
    documentedRules:rules.map(x=>({ruleId:x.ruleId,rule:x.rule,comparison:'MATCH',reason:'Synthetic method obeys documented rule.'})),
    siblingComparisons:[]};
  }),flowNotes:[],integrationAnswers:[],contractChecks:[],candidates:[]};
}
export function snapshot(f,claimed,workerId){
 const packet=f.packet(claimed.unitId),submission=correctSubmission(packet);
 const rel=f.campaign+'/work/phase-04/units/'+claimed.unitId+'/submissions/'+workerId+
  '/epoch-'+claimed.claimEpoch+'/SUBMISSION_ATTEMPT_001_v1.json';
 const raw=json(submission);writeFile(f.root,rel,raw);
 return {unitId:claimed.unitId,claimEpoch:claimed.claimEpoch,claimToken:claimed.claimToken,
  packetSha256:claimed.packetSha256,submissionPath:rel,
  submissionSha256:digest(raw),unitSpecRevision:claimed.unitSpecRevision};
}
