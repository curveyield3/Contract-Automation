#!/usr/bin/env node
// Dedicated generation-bound machine lane; never seals phases or writes receipts.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {runProcess} from '../packages/github-native-sim/src/execution.mjs';
import {assembleAcceptedUnitShardsV1,finalizeReadinessV1} from './lib/lite-solo-unit-queue-v1.mjs';
import {executePhase5TargetsV1,validateTargetExecutionRequestBindingV1} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';

const args=Object.fromEntries(process.argv.slice(2).reduce((acc,x,i,all)=>{
  if(i%2===0){if(!x.startsWith('--')||!all[i+1])throw Error('invalid argument');acc.push([x.slice(2),all[i+1]]);}
  return acc;
},[]));
const root=path.resolve(args['controller-root']??'.audit-controller');
const campaignId=args['campaign-id'],generationId=args['generation-id'],phase=Number(args.phase);
if(!/^[A-Za-z0-9._-]+-r[0-9]+$/.test(campaignId??'')||
   !/^[A-Za-z0-9._-]{8,150}$/.test(generationId??'')||
   !Number.isInteger(phase)||phase<0||phase>10)
  throw Error('invalid campaign, generation or phase');
const slug=campaignId.replace(/-r[0-9]+$/,'');
const abs=rel=>path.join(root,...String(rel).split('/'));
const read=rel=>JSON.parse(fs.readFileSync(abs(rel),'utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const directory=read('Audit Campaign Directory/campaigns/'+slug+'.json');
if(directory.campaignId!==campaignId||directory.campaignGenerationId!==generationId||
   (phase>0&&directory.currentAssignment?.phaseSequence!==phase)||
   !/^campaigns\//.test(directory.workspacePath??''))
  throw Error('machine execution campaign generation or current phase mismatch');
const campaignPath=directory.workspacePath;
const receipt=read(path.posix.join(campaignPath,'receipts/PHASE_00_RECEIPT_v1.json'));
if(receipt.campaign?.campaignGenerationId!==generationId||
   receipt.source?.sha256!==directory.sourceSha256||
   receipt.authority?.manifestSha256!==directory.authorityDigest)
  throw Error('Phase 0 receipt does not bind this generation/source/authority');
const tag=String(phase).padStart(2,'0');
const manifestRel=path.posix.join(campaignPath,'evidence/phase-'+tag+'-machine/EXECUTION_MANIFEST_v1.json');
const records=[];
function safeRel(rel){
  if(typeof rel!=='string'||rel.startsWith('/')||
     rel.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('unsafe machine request path');
  return rel;
}
function collect(candidateKey,requestRel,result){
  const request=requestRel?read(requestRel):null,rel=result?.evidenceRef;
  const valid=typeof rel==='string'&&rel.startsWith(campaignPath+'/')&&
    rel.endsWith('/raw-result.json')&&fs.existsSync(abs(rel));
  const status=!request?'NOT_APPLICABLE':
    (result?.status==='PASS'&&result?.exitCode===0&&valid?'PASS':'INCOMPLETE');
  records.push({candidateKey,status,requestPath:requestRel??null,
    requestId:request?.requestId??null,requestDigest:request?.requestDigest??null,
    sourceCommit:request?.source?.commit??null,
    harnessBundleId:request?.configuration?.harness?.bundleId??null,
    rawResultPath:valid?rel:null,rawResultSha256:valid?hash(fs.readFileSync(abs(rel))):null,
    exitCode:result?.exitCode??null});
}
if(phase===5){
  const gate=finalizeReadinessV1({root,campaignPath,directory,phase});
  if(!gate.ready)throw Error('Phase 5 has unaccepted units; execute tests only after all questions are completed');
  assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase});
  const out=execFileSync(process.execPath,['scripts/lite-phase5-preflight-v1.mjs',
    root,campaignPath,campaignId,directory.sourceSha256],{encoding:'utf8',maxBuffer:8*1024*1024});
  const preflight=JSON.parse(out.trim().split('\n').at(-1));
  if(preflight.status!=='PREFLIGHT_PASS')throw Error('Phase 5 request preflight failed');
  const preRel=path.posix.join(campaignPath,'controller/preflight/PHASE5_REQUEST_PREFLIGHT_v1.json');
  fs.mkdirSync(path.dirname(abs(preRel)),{recursive:true});
  fs.writeFileSync(abs(preRel),JSON.stringify(preflight,null,2)+'\n');
  const form=read(path.posix.join(campaignPath,'work/phase-05/PHASE_05_WORK_FORM_v1.json'));
  const targets=form.actions?.['step-3']?.outputs?.targetDesigns??[];
  const results=await executePhase5TargetsV1({
    controllerRoot:root,campaignPath,targetDesigns:targets,
    expectedCampaignId:campaignId,expectedCampaignGenerationId:generationId,
    expectedSourceSha256:directory.sourceSha256
  });
  for(const target of targets){
    if(!target||typeof target!=='object')continue;
    const key=String(target.candidateKey??'').trim();
    if(!key)throw Error('missing Phase 5 target identity');
    if(target.executionMethod==='NOT_APPLICABLE'){collect(key,null,results[key]);continue;}
    const binding=validateTargetExecutionRequestBindingV1({
      controllerRoot:root,campaignPath,target,expectedCampaignId:campaignId,
      expectedCampaignGenerationId:generationId,expectedSourceSha256:directory.sourceSha256
    });
    collect(key,String(binding.status).startsWith('PASS_')?
      path.posix.join(campaignPath,binding.requestRef):null,results[key]);
  }
}else{
  // Every other phase uses an explicit same-phase request index created for
  // this exact generation. No global harness traversal or legacy test scan.
  const indexRel=path.posix.join(campaignPath,'work/phase-'+tag+'/MACHINE_EXECUTION_REQUESTS_v1.json');
  if(!fs.existsSync(abs(indexRel)))throw Error('no exact-generation machine request index for this phase');
  const index=read(indexRel);
  if(index.schemaVersion!=='curveyield-lite-machine-request-index-v1'||
     index.campaignId!==campaignId||index.campaignGenerationId!==generationId||
     index.phaseSequence!==phase||index.sourceSha256!==directory.sourceSha256||
     !Array.isArray(index.requests))
    throw Error('machine request index generation/phase/source mismatch');
  const seen=new Set();
  for(const entry of index.requests){
    if(typeof entry?.candidateKey!=='string'||!entry.candidateKey.trim()||
       seen.has(entry.candidateKey))throw Error('missing or duplicate candidate identity');
    seen.add(entry.candidateKey);
    const requestRel=safeRel(entry.requestPath);
    if(!requestRel.startsWith(campaignPath+'/work/phase-'+tag+'/execution-requests/'))
      throw Error('request does not belong to this campaign generation and phase');
    const request=read(requestRel);
    if(request.campaignId!==campaignId||request.source?.archiveSha256!==directory.sourceSha256)
      throw Error('machine request identity differs from the exact campaign generation');
    const ev=path.posix.join(campaignPath,'evidence/phase-'+tag+'-machine',entry.candidateKey);
    const result=await runProcess({
      command:process.execPath,
      args:['packages/github-native-sim/src/v7-cli.mjs','execute','--request',abs(requestRel),
        '--evidence-dir',abs(ev),'--workspace',path.join('.audit-work','machine',generationId,tag,entry.candidateKey),
        '--compact-raw-result'],
      cwd:process.cwd(),timeoutMs:40*60*1000,
      env:{...process.env,AUDIT_CAMPAIGN_GENERATION_ID:generationId}
    });
    collect(entry.candidateKey,requestRel,{
      status:result.exitCode===0?'PASS':'INCOMPLETE',exitCode:result.exitCode,
      evidenceRef:path.posix.join(ev,request.requestId,'raw-result.json')
    });
  }
}
const manifest={schemaVersion:'curveyield-lite-machine-evidence-v1',
  campaignId,campaignGenerationId:generationId,phaseSequence:phase,
  sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
  phaseEpoch:directory.unitPhaseEpoch??null,
  status:records.every(x=>x.status==='PASS'||x.status==='NOT_APPLICABLE')?'COMPLETE':'INCOMPLETE',
  createdAt:new Date().toISOString(),records};
fs.mkdirSync(path.dirname(abs(manifestRel)),{recursive:true});
fs.writeFileSync(abs(manifestRel),JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(JSON.stringify({status:manifest.status,campaignId,
  campaignGenerationId:generationId,phaseSequence:phase,
  manifestPath:manifestRel,recordCount:records.length})+'\n');
