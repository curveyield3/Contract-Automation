#!/usr/bin/env node
// Controller-owned Phase-5 candidate proof ingestion. Caller is the trusted
// controller workflow after authenticated GitHub Actions artifact retrieval.
// A worker cannot submit this script output as a sealed Phase-5 machine result.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [rootArg,requestArg,runArg,artifactMetaArg,artifactDirArg]=process.argv.slice(2);
if(!rootArg||!requestArg||!runArg||!artifactMetaArg||!artifactDirArg)throw Error('DAI_CORRECTIVE_PROOF_INTAKE_ARGUMENT_MISSING');
const root=path.resolve(rootArg);
const rd=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const r=rd(requestArg),run=rd(runArg),meta=rd(artifactMetaArg);
const id='audit-preview-completion-live-ethereum-dai-6b175474-corrective-r1';
const generation=id+'-g1-20261027T223722639Z';
const source='1c384141058f50d53b9e58b89c0b83aa60bd1066406f017d177121de332705f2';
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const expected=['BOB-0001','BOB-0002','BOB-0003','BOB-0004','BOB-0005','BOB-0007','BOB-0008','CP-DAI-PERMIT-001'];
const expectedCommit='ba67305b7d413b3bbfe0fc05d746c3abfc4c357a';
const expectedRun=40598354432,expectedArtifact=12776328669;
if(r.schemaVersion!=='dai-corrective-controller-proof-ingest-v1'||
 r.requestId!=='dai-corrective-proof-40598354432'||
 r.campaignId!==id||r.campaignGenerationId!==generation||
 r.sourceSha256!==source||r.runId!==expectedRun||
 r.artifactId!==expectedArtifact||r.runnerCommit!==expectedCommit||
 r.allowedWriteScope!=='CONTROLLER_PHASE5_EVIDENCE_ONLY')
 throw Error('DAI_CORRECTIVE_INGEST_INVALID_REQUEST_IDENTITY');
const directoryPath=path.join(root,'Audit Campaign Directory','campaigns',id.replace(/-r\d+$/,'')+'.json');
const d=rd(directoryPath),campaignRoot=path.join(root,'campaigns',id);
if(d.campaignId!==id||d.campaignGenerationId!==generation||
 d.sourceSha256!==source||d.authorityRelease!=='lite-solo-v4'||
 d.campaignStatus!=='ACTIVE'||d.currentAssignment?.phaseSequence!==5||
 d.correctionOf?.campaignId!=='audit-preview-completion-live-ethereum-dai-6b175474-r1'||
 d.correctionOf?.priorSealsImmutable!==true)
 throw Error('DAI_CORRECTIVE_INGEST_CAMPAIGN_NOT_AUTHORIZED');
const mainRun=run.id===expectedRun&&run.status==='completed'&&run.conclusion==='success'&&run.head_sha===expectedCommit&&
 run.repository?.full_name==='curveyield3/Contract-Automation'&&run.event==='push';
if(!mainRun||meta.id!==expectedArtifact||meta.expired!==false||meta.size_in_bytes<=0||
 meta.name!=='dai-corrective-permit-security-evidence-'+expectedCommit)
 throw Error('DAI_CORRECTIVE_INGEST_ACTIONS_PROVENANCE_INVALID');
const evFile=path.join(artifactDirArg,'BOB_EXECUTION_EVIDENCE_v1.json'),
 rawFile=path.join(artifactDirArg,'ANVIL_RAW_RPC_TRANSCRIPT_v1.json');
const ev=rd(evFile),tx=rd(rawFile);
if(ev.schemaVersion!=='dai-live-anvil-bob-assertion-ledger-v1'||
 ev.campaignId!==id||ev.status!=='ALL_TARGETS_PASSED'||
 ev.source?.archiveSha256!==source||
 ev.source?.commit!=='b66ee2b336c949c3ecb0621307b9c188f8f81e89'||
 ev.target?.address?.toLowerCase()!=='0x6b175474e89094c44da98b954eedeac495271d0f'||
 ev.target?.blockNumber!==26283885||
 ev.target?.blockHash?.toLowerCase()!=='0xe9a7c98f604a48f1b8885578ec8f54e73ec33e9f34cc5161c049a59640b6eab5'||
 ev.target?.runtimeSha256!=='5ce810033426a017721777f241665c27bdd4663ca8a1c27558b4b372a1731f4e'||
 ev.target?.redeployed!==false||ev.target?.upstreamStateChanges!==false||
 ev.fork?.status!=='PASS'||
 ev.fork?.deployedTargetAttestation?.status!=='PASS'||
 ev.fork?.deployedTargetAttestation?.mutableWriteObserved!==true||
 ev.fork?.deployedTargetAttestation?.snapshotReverted!==true||
 ev.runner?.workflowRunId!==String(expectedRun)||
 ev.runner?.commit!==expectedCommit||
 ev.runner?.qualificationInvoked!==false)
 throw Error('DAI_CORRECTIVE_INGEST_SOURCE_FORK_OR_PROOF_IDENTITY_INVALID');
if(!Array.isArray(ev.obligations)||ev.obligations.length!==8||
 ev.obligations.map(o=>o.obligationId).join(',')!==expected.join(',')||
 ev.obligations.some(o=>o.status!=='PASS'||o.toolInvoked!==true||
 !Array.isArray(o.steps)||!o.steps.length||o.steps.some(x=>x.pass!==true)))
 throw Error('DAI_CORRECTIVE_INGEST_ASSERTION_EVIDENCE_INVALID');
const count=ev.obligations.reduce((n,o)=>n+o.steps.length,0);
if(count!==76||ev.obligations.at(-1).steps.length!==23||
 ev.failures?.length>0||!Array.isArray(tx)||tx.length!==136||
 tx.filter(t=>t.method==='eth_sendTransaction').length!==15||
 tx.filter(t=>t.method==='evm_snapshot').length!==8||
 tx.filter(t=>t.method==='evm_revert'&&t.result===true).length!==8||
 ev.rawTranscriptSha256!==sha(rawFile))
 throw Error('DAI_CORRECTIVE_INGEST_TRANSACTION_OR_DIGEST_INVALID');
const destDir=path.join(campaignRoot,'controller','phase5-candidate-evidence','dai-fork-40598354432');
const names=['BOB_EXECUTION_EVIDENCE_v1.json','ANVIL_RAW_RPC_TRANSCRIPT_v1.json'];
const put=(name,data)=>{fs.mkdirSync(destDir,{recursive:true});const p=path.join(destDir,name);
 if(fs.existsSync(p)){if(!fs.readFileSync(p).equals(data))throw Error('DAI_CORRECTIVE_INGEST_EXISTING_RECEIPT_CONFLICT');return;}
 fs.writeFileSync(p,data,{flag:'wx'});};
put(names[0],fs.readFileSync(evFile));put(names[1],fs.readFileSync(rawFile));
const rel='campaigns/'+id+'/controller/phase5-candidate-evidence/dai-fork-40598354432/';
const receipt={schemaVersion:'dai-corrective-controller-phase5-executed-proof-v1',status:'EVIDENCE_ACCEPTED_FOR_CANDIDATE_VALIDATION',
 campaignId:id,campaignGenerationId:generation,sourceSha256:source,runId:expectedRun,artifactId:expectedArtifact,
 runCommit:expectedCommit,runUrl:'https://github.com/curveyield3/Contract-Automation/actions/runs/'+expectedRun,
 proofPath:rel+names[0],proofSha256:sha(evFile),rawTranscriptPath:rel+names[1],rawTranscriptSha256:sha(rawFile),
 executedGroups:expected,assertionCount:count,anvilTransactions:15,rollbackSnapshots:8,
 candidateId:'DAI-PERMIT-SIG-001',
 candidateEvidenceStatus:'BOUNDED_SECURITY_TESTS_PASSED_NO_EXHAUSTIVE_DISPROVAL',
 phase5Sealed:false,notV7RawResult:true,notAProvenFinding:false,
 immutablePriorCampaignUnchanged:true,
 securityLimits:['Passing signature tests do not establish physical key custody or prove every ECDSA shape.','Privileged ward roster and governance custody require independent review.']};
put('CONTROLLER_ACCEPTANCE_RECEIPT_v1.json',Buffer.from(JSON.stringify(receipt,null,2)+'\n'));
console.log(JSON.stringify({status:receipt.status,receiptPath:rel+'CONTROLLER_ACCEPTANCE_RECEIPT_v1.json',assertions:count,groups:expected.length,phase5Sealed:false}));
