#!/usr/bin/env node
// Called by the existing Lite-Solo Phase Boundary Controller, never by an auditor
// with write access to the audit repository.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
function fail(message){throw new Error('DAI_P8_CONTROLLER_INGEST_REJECTED: '+message);}
function load(p){return JSON.parse(fs.readFileSync(p,'utf8'));}
function sha(p){return createHash('sha256').update(fs.readFileSync(p)).digest('hex');}
function writeOnce(p,data){
  fs.mkdirSync(path.dirname(p),{recursive:true});
  if(fs.existsSync(p)){
    if(!fs.readFileSync(p).equals(data))fail('controller-owned destination is occupied with different bytes: '+p);
    return 'ALREADY_ACCEPTED';
  }
  fs.writeFileSync(p,data,{flag:'wx'});return 'ACCEPTED';
}
const [requestPath,root,campaignPath,artifactDir,runPath]=process.argv.slice(2);
if(!requestPath||!root||!campaignPath||!artifactDir||!runPath)fail('missing bound inputs');
const request=load(requestPath),sub=request.phase8EvidenceSubmission;
const id='audit-preview-completion-live-ethereum-dai-6b175474-r1';
const sourceSha='1c384141058f50d53b9e58b89c0b83aa60bd1066406f017d177121de332705f2';
const runner='7d66c7490fc3cd9ee5c7a42bd48ef9fbb28634fb';
const address='0x6b175474e89094c44da98b954eedeac495271d0f';
const hash='0xe9a7c98f604a48f1b8885578ec8f54e73ec33e9f34cc5161c049a59640b6eab5';
const runtime='5ce810033426a017721777f241665c27bdd4663ca8a1c27558b4b372a1731f4e';
const expected=['BOB-0001','BOB-0002','BOB-0003','BOB-0004','BOB-0005','BOB-0007','BOB-0008'];
if(request.schemaVersion!=='curveyield-lite-solo-phase-boundary-request-v1'
  ||request.reviewKind!=='phase'||request.phaseSequence!==8
  ||request.auditControllerRef!=='main'||request.campaignId!==id
  ||campaignPath!=='campaigns/'+id
  ||sub?.kind!=='DAI_PINNED_MUTABLE_ANVIL_BOB_V1'
  ||sub?.runId!==40586336907||sub?.artifactId!==12770963873
  ||sub?.runnerCommit!==runner||sub?.sourceSha256!==sourceSha)fail('submission identity invalid');
const workspace=path.join(root,campaignPath);
const directory=load(path.join(root,'Audit Campaign Directory','campaigns',id+'.json'));
if(directory.campaignId!==id||directory.workspacePath!==campaignPath
  ||directory.sourceSha256!==sourceSha||directory.mode!=='LITE_SOLO'
  ||directory.authorityRelease!=='lite-solo-v4'||directory.currentAssignment?.phaseSequence!==8
  ||directory.currentAssignment?.status!=='ACTIVE')fail('active directory/source/authority mismatch');
const predecessor=load(path.join(workspace,'receipts/PHASE_07_RECEIPT_v1.json'));
if(predecessor.phase?.sequence!==7||predecessor.phase?.status!=='SEALED')
  fail('sealed Phase-7 predecessor not present');
const run=load(runPath);
if(run.id!==40586336907||run.status!=='completed'||run.conclusion!=='success'
  ||run.head_sha!==runner||run.repository?.full_name!=='curveyield3/Contract-Automation'
  ||run.event!=='push')fail('authenticated runner run not successful or commit mismatched');
const evidenceFile=path.join(artifactDir,'BOB_EXECUTION_EVIDENCE_v1.json');
const transcriptFile=path.join(artifactDir,'ANVIL_RAW_RPC_TRANSCRIPT_v1.json');
const ev=load(evidenceFile),raw=load(transcriptFile);
if(ev.schemaVersion!=='dai-live-anvil-bob-assertion-ledger-v1'
  ||ev.status!=='ALL_SEVEN_PASSED'||ev.campaignId!==id
  ||ev.runner?.workflowRunId!=='40586336907'||ev.runner?.commit!==runner
  ||ev.runner?.qualificationInvoked!==false
  ||ev.source?.archiveSha256!==sourceSha
  ||ev.target?.address?.toLowerCase()!==address
  ||ev.target?.blockNumber!==26283885||ev.target?.blockHash?.toLowerCase()!==hash
  ||ev.target?.runtimeSha256!==runtime
  ||ev.target?.redeployed!==false||ev.target?.upstreamStateChanges!==false
  ||ev.fork?.status!=='PASS'
  ||ev.fork?.deployedTargetAttestation?.status!=='PASS'
  ||ev.fork?.deployedTargetAttestation?.mutableWriteObserved!==true
  ||ev.fork?.deployedTargetAttestation?.snapshotReverted!==true)
  fail('DAI identity, historical fork or origin proof not met');
if(!Array.isArray(ev.obligations)||ev.obligations.length!==7
  ||ev.obligations.map(x=>x.obligationId).join(',')!==expected.join(',')
  ||ev.obligations.some(x=>x.status!=='PASS'||x.toolInvoked!==true
    ||!Array.isArray(x.steps)||!x.steps.length||x.steps.some(y=>y.pass!==true)))
  fail('BOB assertion ledger missing a passing executed obligation');
const assertions=ev.obligations.reduce((n,o)=>n+o.steps.length,0);
if(assertions!==53)fail('assertion count mismatch');
if(!Array.isArray(raw)||raw.length!==107)fail('raw evidence count mismatch');
const count=m=>raw.filter(x=>x.method===m);
if(count('eth_sendTransaction').length!==13||count('evm_snapshot').length!==7
  ||count('evm_revert').length!==7||count('evm_revert').some(x=>x.result!==true)
  ||raw.some(x=>x.method==='eth_sendRawTransaction'))
  fail('state changes, snapshots or reverts invalid');
const rawSha=sha(transcriptFile);
if(rawSha!==ev.rawTranscriptSha256)fail('raw transcript digest differs from assertion ledger');
const folder=path.join(workspace,'controller/phase8-revalidation/TG-001');
const evidenceName='CONTROLLER_INGESTED_DAI_BOB_EXECUTION_ATTEMPT_004_v1.json';
const transcriptName='CONTROLLER_INGESTED_DAI_ANVIL_TRANSCRIPT_ATTEMPT_004_v1.json';
const receiptName='CONTROLLER_DAI_BOB_EVIDENCE_INGEST_RECEIPT_004_v1.json';
const receipt={
  schemaVersion:'lite-solo-controller-phase8-bob-evidence-ingest-v1',
  campaignId:id,campaignGenerationId:directory.campaignGenerationId,
  sourceSha256:sourceSha,phaseSequence:8,
  status:'EVIDENCE_ACCEPTED_FOR_PHASE8_VALIDATION',
  acceptedObligations:expected,assertionCount:assertions,runId:run.id,
  runUrl:'https://github.com/curveyield3/Contract-Automation/actions/runs/'+run.id,
  runCommit:runner,artifactId:sub.artifactId,
  evidencePath:campaignPath+'/controller/phase8-revalidation/TG-001/'+evidenceName,
  rawTranscriptPath:campaignPath+'/controller/phase8-revalidation/TG-001/'+transcriptName,
  evidenceSha256:sha(evidenceFile),rawTranscriptSha256:rawSha,
  sealedPhase6Unmodified:true,phase8Sealed:false,auditCertified:false,
  limitation:'Only the seven executed test scenarios passed; off-chain governance, collateral backing and untested signature variants remain open.'
};
writeOnce(path.join(folder,evidenceName),fs.readFileSync(evidenceFile));
writeOnce(path.join(folder,transcriptName),fs.readFileSync(transcriptFile));
const status=writeOnce(path.join(folder,receiptName),Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
console.log(JSON.stringify({status,campaignId:id,assertions,obligations:expected.length,
  receiptPath:receipt.evidencePath.replace(evidenceName,receiptName),phase8Sealed:false}));
