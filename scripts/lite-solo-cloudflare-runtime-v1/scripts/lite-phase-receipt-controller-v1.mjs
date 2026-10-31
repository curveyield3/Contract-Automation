#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parse(argv){const o={};for(let i=2;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('args must be --key value');o[argv[i].slice(2)]=argv[i+1];}return o;}
function read(f){return JSON.parse(fs.readFileSync(f,'utf8'));}
function write(f,v){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n');}
function requiredFile(root,rel,label){if(typeof rel!=='string'||!rel||rel.startsWith('/')||rel.split('/').includes('..'))throw new Error('unsafe '+label+' path');const f=path.join(root,...rel.split('/'));if(!fs.existsSync(f)||!fs.statSync(f).isFile())throw new Error('missing '+label+': '+rel);return f;}
const transitions={
  1:{next:2,same:false,boundary:'P1_TO_P2',reviewer:'reviewer-2',assigned:'Combined Lite Phases 2–5'},
  2:{next:3,same:true,reviewer:'reviewer-2',assigned:'Phase 3'},
  3:{next:4,same:true,reviewer:'reviewer-2',assigned:'Phase 4'},
  4:{next:5,same:true,reviewer:'reviewer-2',assigned:'Phase 5'},
  5:{next:6,same:false,boundary:'P5_TO_P6',reviewer:'reviewer-3L',assigned:'Merged Lite Phases 6–7'},
  7:{next:8,same:false,boundary:'P67_TO_P8',reviewer:'reviewer-4',assigned:'Combined Lite Phases 8–10'},
  8:{next:9,same:true,reviewer:'reviewer-4',assigned:'Phase 9'},
  9:{next:10,same:true,reviewer:'reviewer-4',assigned:'Phase 10'},
  10:{next:null,same:false,reviewer:null,assigned:null}
};
const a=parse(process.argv);
for(const k of ['controller-root','campaign-path','phase-sequence']) if(a[k]===undefined) throw new Error('missing --'+k);
const root=path.resolve(a['controller-root']);
const campaignPath=a['campaign-path'];
const sequence=Number(a['phase-sequence']);
if(!Number.isInteger(sequence)||sequence<1||sequence>10) throw new Error('phase-sequence must be 1..10');
const campaignRoot=path.join(root,...campaignPath.split('/'));
const libUrl=pathToFileURL(path.join(root,'packages/controller-core/src/lite-phase-receipt-v1.mjs')).href;
const {phaseReceiptPath,createLitePhaseReceiptV1,validateLitePhaseReceiptV1}=await import(libUrl);
const receiptRel=phaseReceiptPath(campaignPath,sequence,1);
const receiptFile=requiredFile(root,receiptRel,'phase receipt');
const receipt=read(receiptFile);
validateLitePhaseReceiptV1(receipt);
if(receipt.phase.sequence!==sequence) throw new Error('receipt phase mismatch');
if(receipt.phase.status!=='EVIDENCE_READY'){
  process.stdout.write(JSON.stringify({status:'NOOP',reason:'PHASE_NOT_EVIDENCE_READY',phaseStatus:receipt.phase.status})+'\n');
  process.exit(0);
}
for(const row of [...(receipt.evidence??[]),...(receipt.outputs??[])]){
  if(row?.path) requiredFile(campaignRoot,row.path,'receipt evidence/output');
}
for(const [key,rel] of Object.entries(receipt.globalControls??{})){
  if(rel) requiredFile(campaignRoot,rel,'global control '+key);
}
const homepage=receipt.authority?.homepagePath;
if(typeof homepage!=='string'||!homepage.endsWith('/SKILL.md')) throw new Error('receipt authority.homepagePath must bind the current Lite SKILL.md');
const authorityRoot=path.posix.dirname(homepage);
const phaseContractRel=path.posix.join(authorityRoot,`phases/phase-${sequence}/PHASE_CONTRACT.json`);
const phaseContract=read(requiredFile(root,phaseContractRel,'current Lite Phase Contract'));
if(phaseContract.phase?.sequence!==sequence) throw new Error('Phase Contract sequence does not match receipt phase');
const recorded=new Set();
for(const row of [...(receipt.evidence??[]),...(receipt.outputs??[])]) if(row?.path) recorded.add(row.path);
for(const rel of Object.values(receipt.globalControls??{})) if(rel) recorded.add(rel);
const receiptLocalPath=path.posix.relative(campaignPath,receiptRel);
recorded.add(receiptLocalPath);
const missingRequired=[];
for(const row of phaseContract.requiredOutputs??[]){
  if(row?.required!==true) continue;
  const artifact=row?.artifact;
  if(typeof artifact!=='string'||!artifact) throw new Error('Phase Contract contains an invalid required output artifact');
  if(!recorded.has(artifact)){missingRequired.push(artifact);continue;}
  if(artifact!==receiptLocalPath) requiredFile(campaignRoot,artifact,`required Phase-${sequence} output`);
}
if(missingRequired.length) throw new Error(`receipt is missing required Phase Contract outputs: ${missingRequired.join(', ')}`);
const now=new Date().toISOString();
receipt.validation={status:'PASS',validatedAt:now,failures:[]};
receipt.phase.status=sequence===10?'COMPLETE':'SEALED';
receipt.sealedAt=now; receipt.updatedAt=now;
let t=transitions[sequence];
if(sequence===8){
  const requested=receipt.handoff?.nextPhaseSequence;
  if(requested!==9 && requested!==10) throw new Error('Phase 8 receipt must set handoff.nextPhaseSequence to 9 when remediation exists or 10 when remediation is skipped');
  t=requested===10
    ? {next:10,same:true,reviewer:'reviewer-4',assigned:'Phase 10'}
    : {next:9,same:true,reviewer:'reviewer-4',assigned:'Phase 9'};
}
const directoryFile=requiredFile(root,receipt.campaign.campaignDirectoryEntryPath,'campaign directory entry');
const directory=read(directoryFile);
if(directory.schemaVersion==='curveyield-audit-campaign-directory-entry-v2') throw new Error('legacy receipt controller is prohibited for current assignment-v2 Lite campaigns; use lite-phase-work-packet-controller-v1.yml');
if(directory.schemaVersion!=='curveyield-audit-campaign-directory-entry-v1') throw new Error('legacy receipt controller requires Audit Campaign Directory v1');
let freshSuccessorRequired=false,sameReviewerAdvanced=false,nextReceiptPath=null;
if(sequence===6){
  const markerPath=phaseReceiptPath(campaignPath,7,1);
  const phase8Path=phaseReceiptPath(campaignPath,8,1);
  receipt.handoff={required:false,boundary:null,incomingReviewer:'phase7-automation',assignedWork:'Automatic Phase 7 completion marker',nextPhaseSequence:7,sameReviewer:false,status:'NOT_APPLICABLE'};
  const marker=createLitePhaseReceiptV1({
    campaignId:receipt.campaign.campaignId,campaignGenerationId:receipt.campaign.campaignGenerationId,campaignName:receipt.campaign.campaignName,
    workspacePath:receipt.campaign.workspacePath,campaignDirectoryEntryPath:receipt.campaign.campaignDirectoryEntryPath,
    sequence:7,executorType:'GITHUB_ACTIONS',executorLineage:'phase7-automation',authority:receipt.authority,sourceSha256:receipt.source.sha256,source:receipt.source,
    status:'SEALED',globalControls:receipt.globalControls,
    obligations:{due:[],created:[],closed:[],carriedForward:receipt.obligations.carriedForward??[]},
    invalidation:receipt.invalidation,
    inputs:[{role:'PREDECESSOR_RECEIPT',path:receiptRel}],
    evidence:receipt.evidence??[],
    outputs:[...(receipt.outputs??[]),{role:'AUTOMATIC_NON_EXECUTABLE_PHASE_MARKER',path:path.posix.relative(campaignPath,markerPath)}],
    automation:[...(receipt.automation??[]),{workflow:'lite-phase-receipt-controller-v1.yml',status:'PASS',action:'AUTOMATIC_PHASE7_MARKER'}],
    validation:{status:'PASS',validatedAt:now,failures:[]},
    handoff:{required:true,boundary:'P67_TO_P8',incomingReviewer:'reviewer-4',assignedWork:'Combined Lite Phases 8–10',nextPhaseSequence:8,sameReviewer:false,status:'SUCCESSOR_PENDING',incomingReceiptPath:phase8Path},
    now
  });
  marker.sealedAt=now;
  marker.updatedAt=now;
  write(path.join(root,...markerPath.split('/')),marker);
  directory.currentReceiptPath=markerPath;
  directory.currentPhaseSequence=7;
  directory.currentReviewer='phase7-automation';
  directory.status='WAITING_FOR_SUCCESSOR_AGENT';
  freshSuccessorRequired=true;
  nextReceiptPath=phase8Path;
}else if(sequence===10){
  receipt.handoff={required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:null,sameReviewer:false,status:'NOT_APPLICABLE'};
  directory.status='COMPLETE'; directory.currentPhaseSequence=10; directory.currentReviewer=receipt.executor.lineage;
}else if(t.same){
  receipt.handoff={required:false,boundary:null,incomingReviewer:t.reviewer,assignedWork:t.assigned,nextPhaseSequence:t.next,sameReviewer:true,status:'NOT_APPLICABLE'};
  let predecessorPath=receiptRel;
  if(sequence===8 && t.next===10){
    const skipped9=createLitePhaseReceiptV1({
      campaignId:receipt.campaign.campaignId,campaignGenerationId:receipt.campaign.campaignGenerationId,campaignName:receipt.campaign.campaignName,
      workspacePath:receipt.campaign.workspacePath,campaignDirectoryEntryPath:receipt.campaign.campaignDirectoryEntryPath,
      sequence:9,executorType:'AI_REVIEWER',executorLineage:'reviewer-4',authority:receipt.authority,sourceSha256:receipt.source.sha256,source:receipt.source,
      status:'SKIPPED',globalControls:receipt.globalControls,obligations:{due:[],created:[],closed:[],carriedForward:receipt.obligations.carriedForward??[]},
      inputs:[{role:'PREDECESSOR_RECEIPT',path:receiptRel}],
      outputs:[{role:'SKIP_REASON',path:'NO_REMEDIATION_ARTIFACTS'}],
      validation:{status:'NOT_APPLICABLE',validatedAt:now,failures:[]},
      handoff:{required:false,boundary:null,incomingReviewer:'reviewer-4',assignedWork:'Phase 10',nextPhaseSequence:10,sameReviewer:true,status:'NOT_APPLICABLE'},now
    });
    skipped9.sealedAt=now;
    const skippedPath=phaseReceiptPath(campaignPath,9,1);
    write(path.join(root,...skippedPath.split('/')),skipped9);
    predecessorPath=skippedPath;
  }
  const next=createLitePhaseReceiptV1({
    campaignId:receipt.campaign.campaignId,campaignGenerationId:receipt.campaign.campaignGenerationId,campaignName:receipt.campaign.campaignName,
    workspacePath:receipt.campaign.workspacePath,campaignDirectoryEntryPath:receipt.campaign.campaignDirectoryEntryPath,
    sequence:t.next,executorType:'AI_REVIEWER',executorLineage:t.reviewer,authority:receipt.authority,sourceSha256:receipt.source.sha256,source:receipt.source,
    status:'ACTIVE',globalControls:receipt.globalControls,obligations:{due:receipt.obligations.carriedForward??[],created:[],closed:[],carriedForward:[]},
    inputs:[{role:'PREDECESSOR_RECEIPT',path:predecessorPath}],
    handoff:{required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:null,sameReviewer:false,status:'NOT_READY'},now
  });
  nextReceiptPath=phaseReceiptPath(campaignPath,t.next,1);
  write(path.join(root,...nextReceiptPath.split('/')),next);
  directory.currentReceiptPath=nextReceiptPath;directory.currentPhaseSequence=t.next;directory.currentReviewer=t.reviewer;directory.status='ACTIVE';
  sameReviewerAdvanced=true;
}else{
  nextReceiptPath=phaseReceiptPath(campaignPath,t.next,1);
  receipt.handoff={required:true,boundary:t.boundary,incomingReviewer:t.reviewer,assignedWork:t.assigned,nextPhaseSequence:t.next,sameReviewer:false,status:'SUCCESSOR_PENDING',incomingReceiptPath:nextReceiptPath};
  directory.status='WAITING_FOR_SUCCESSOR_AGENT';directory.currentPhaseSequence=sequence;directory.currentReviewer=receipt.executor.lineage;
  freshSuccessorRequired=true;
}
directory.updatedAt=now;
write(receiptFile,receipt);write(directoryFile,directory);
process.stdout.write(JSON.stringify({status:'PASS',campaignId:receipt.campaign.campaignId,campaignName:receipt.campaign.campaignName,phaseSequence:sequence,receiptPath:receiptRel,freshSuccessorRequired,sameReviewerAdvanced,nextReceiptPath,boundary:receipt.handoff.boundary})+'\n');
