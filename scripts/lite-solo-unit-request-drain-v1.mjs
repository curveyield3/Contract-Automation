#!/usr/bin/env node
// Durable per-campaign Lite-Solo v4 request drainer; invoked by the existing Actions runtime.
// Ordinary work is per-unit. Whole-phase validation/sealing occurs only once all accepted.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {processUnitRequestV1,finalizeReadinessV1,assembleAcceptedUnitShardsV1,markFinalizationV1,statusUnitQueueV1,reopenAggregateDefectsV1} from './lib/lite-solo-unit-queue-v1.mjs';
import {repoFile,readJson,writeJson} from './lib/lite-solo-phase-work-v1.mjs';
const arg=Object.fromEntries(process.argv.slice(2).reduce((out,s,i,a)=>{
 if(i%2===0){if(!s.startsWith('--')||a[i+1]===undefined)throw Error('invalid CLI parameters');
  out.push([s.slice(2),a[i+1]]);}return out;},[]));
const valid=s=>typeof s==='string'&&/^[A-Za-z0-9._-]+$/.test(s)&&!s.includes('..');
if(!valid(arg['campaign-id']))throw Error('campaign id invalid');
const root=path.resolve(arg.root??'.audit-controller'),campaignId=arg['campaign-id'];
const slug=campaignId.replace(/-r[0-9]+$/,'');
if(slug===campaignId)throw Error('campaign generation suffix missing');
const directoryRel='Audit Campaign Directory/campaigns/'+slug+'.json';
const directoryFile=repoFile(root,directoryRel);
const directory=readJson(directoryFile);
if(directory.campaignId!==campaignId||directory.mode!=='LITE_SOLO'||directory.authorityRelease!=='lite-solo-v4')
 throw Error('request drainer denies non-v4 campaigns');
const campaignPath=directory.workspacePath;
if(typeof campaignPath!=='string'||!campaignPath.startsWith('campaigns/')||campaignPath.split('/').includes('..'))
 throw Error('unsafe campaign workspace');
const receipt=readJson(repoFile(root,campaignPath+'/receipts/PHASE_00_RECEIPT_v1.json'));
if(receipt.authority?.liteRelease!=='lite-solo-v4'||receipt.authority?.manifestSha256!==directory.authorityDigest||
 receipt.campaign?.campaignGenerationId!==directory.campaignGenerationId||
 receipt.source?.sha256!==directory.sourceSha256)throw Error('source/authority generation binding invalid');
const requestDir=path.resolve(arg['requests-root']??'process/agent-upload/lite-solo-unit-requests',campaignId);
const results=[],phase=directory.currentAssignment?.phaseSequence;
if(![4,5,6].includes(phase)&&arg.mode!=='drain')throw Error('not a v4 unit phase');
if(arg.mode!=='finalize'){
 let changed=false;
 const files=fs.existsSync(requestDir)?fs.readdirSync(requestDir).filter(x=>/^[A-Za-z0-9._-]+\.json$/.test(x)).sort():[];
 const queuePath=directory.unitQueueStatePath;
 const recorded=queuePath&&fs.existsSync(repoFile(root,queuePath))?
  readJson(repoFile(root,queuePath)):null;
 // Re-evaluate already-recorded, unmapped aggregate defects after the mapping
 // implementation is repaired. Never reopen unrelated accepted units.
 // A previous v4 boundary attempt can expose index drift caused by its
 // former re-sharding behavior. Retry once through the existing assembler,
 // which verifies and restores identities from the frozen unit plan.
 if(phase===4&&recorded?.finalizeStatus==='BLOCKED'&&
    String(recorded.finalizeDetails?.error??'').startsWith('v13 mandatory work records dropped:')){
  markFinalizationV1({root,campaignPath,phase,status:'NOT_STARTED',details:null});
  changed=true;
 }
 if(phase===4&&recorded?.finalizeStatus==='BLOCKED'&&
    Array.isArray(recorded.finalizeDetails?.unmappedDeficiencies)&&
    recorded.finalizeDetails.unmappedDeficiencies.length){
  const recovery=reopenAggregateDefectsV1({root,campaignPath,phase,
    deficiencies:recorded.finalizeDetails.unmappedDeficiencies});
  if(recovery.reopenedUnits.length)changed=true;
 }
 // Retry a Phase-5 boundary previously blocked only by the canonical/temp-key
 // alias mismatch. The Phase-5 controller independently revalidates every
 // source-bound machine result before it can seal; this does not waive it.
 if(phase===5&&recorded?.finalizeStatus==='BLOCKED'&&
    Array.isArray(recorded.finalizeDetails?.unmappedDeficiencies)&&
    recorded.finalizeDetails.unmappedDeficiencies.length>0&&
    recorded.finalizeDetails.unmappedDeficiencies.every(x=>
     /^Phase 5 mandatory material candidate CAND-[0-9]+ has no targeted machine execution$/.test(String(x)))&&
    Object.values(recorded.units??{}).every(x=>x.status==='ACCEPTED')){
  markFinalizationV1({root,campaignPath,phase,status:'NOT_STARTED',details:null});
  changed=true;
 }
 // A prior boundary may have promoted APPEND rows into frozen fixed-record
 // positions before the unit assembler was installed. Recover its exact
 // immutable unit-plan ownership and recompute protected prefill integrity.
 // Never discard individual accepted work or waive a machine-evidence gate.
 if(phase===5&&recorded?.finalizeStatus==='BLOCKED'&&
    Array.isArray(recorded.finalizeDetails?.unmappedDeficiencies)&&
    recorded.finalizeDetails.unmappedDeficiencies.length>0&&
    recorded.finalizeDetails.unmappedDeficiencies.every(x=>[
     'Reviewer work form controller-prefill digest does not match the controller-owned assignment digest.',
     'Controller-prefilled/read-only fields were modified; restore the generated values before validation.'
    ].includes(String(x)))&&
    Object.values(recorded.units??{}).every(x=>x.status==='ACCEPTED')){
  markFinalizationV1({root,campaignPath,phase,status:'NOT_STARTED',details:null});
  changed=true;
 }
 for(const filename of files){
  const request=JSON.parse(fs.readFileSync(path.join(requestDir,filename),'utf8'));
  if(request.operation==='FINALIZE')throw Error('untrusted ingress may not request controller-only FINALIZE');
  if(request.campaignId!==campaignId||request.phaseSequence!==phase)continue;
  if(filename!==request.workerId+'-'+request.requestId+'.json')
   throw Error('request file identity mismatch: '+filename);
  // Historical completed requests remain immutable; skip expensive plan reloads.
  const prior=recorded?.processedRequests?.[request.requestId];
  if(prior){
   const digest=createHash('sha256').update(JSON.stringify(request,null,2)+'\n').digest('hex');
   if(recorded.processedRequestHashes?.[request.requestId]!==digest)
    throw Error('processed request ID reused with changed bytes: '+request.requestId);
   results.push({requestId:request.requestId,status:prior.status});
   continue;
  }
  // Reject a request with the wrong immutable authority binding without blocking
  // unrelated, correctly bound requests in this durable campaign backlog.
  // An invalid oversized CLAIM is also terminally rejected as an ingress error:
  // it must never prevent other workers' valid claims/submissions from draining.
  // Never relax the bound queue's claim limit or mask other processing failures.
  let result;
  if(request.authorityDigest!==directory.authorityDigest){
   result={schemaVersion:'curveyield-lite-solo-unit-controller-result-v1',
     requestId:request.requestId,campaignId:directory.campaignId,
     campaignGenerationId:directory.campaignGenerationId,
     sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
     phaseSequence:phase,phaseEpoch:directory.unitPhaseEpoch,
     status:'REJECTED_INVALID_AUTHORITY_BINDING',
     error:'authority digest differs from bound campaign'};
  }else{
   try{result=processUnitRequestV1({root,campaignPath,directory,request});}
   catch(error){
    const reason=String(error?.message??error);
    if(request.operation!=='CLAIM'||!reason.startsWith('CLAIM must request 1–50 units'))
     throw error;
    result={schemaVersion:'curveyield-lite-solo-unit-controller-result-v1',
      requestId:request.requestId,campaignId:directory.campaignId,
      campaignGenerationId:directory.campaignGenerationId,
      sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
      phaseSequence:phase,phaseEpoch:directory.unitPhaseEpoch,
      status:'REJECTED_INVALID_REQUEST',error:reason};
   }
  }
  const resultRel=path.posix.join(campaignPath,'work/phase-'+String(phase).padStart(2,'0'),
   'units','controller','results','REQUEST_'+request.requestId+'_v1.json');
  const previous=fs.existsSync(repoFile(root,resultRel))?readJson(repoFile(root,resultRel)):null;
  if(JSON.stringify(previous)!==JSON.stringify(result)){writeJson(repoFile(root,resultRel),result);changed=true;}
  results.push({requestId:request.requestId,status:result.status});
 }
 if(changed){directory.updatedAt=new Date().toISOString();writeJson(directoryFile,directory);}
}
let ready=false,seal=null;
if([4,5,6].includes(directory.currentAssignment?.phaseSequence)){
 const gate=finalizeReadinessV1Safe(root,campaignPath,directory,directory.currentAssignment.phaseSequence);
 ready=gate.ready;
 // The GitHub workflow runs Phase-5 preflight between drain and finalize.
 // Assemble all immutable accepted target rows *before* that preflight, so
 // it never reads stale <REQUIRED> placeholders from reviewer work shards.
 // This is the existing authenticated unit assembler, not another validator.
 if(arg.mode==='drain'&&ready&&directory.currentAssignment.phaseSequence===5){
  assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase:5});
 }
 if(arg.mode==='finalize'&&ready){
  const seq=directory.currentAssignment.phaseSequence;
  // Existing work-form controller, not a second parallel validation implementation.
  // It performs full semantic/security validation, source-bound execution checks,
  // receipt generation, Phase-7 automatic marker and successor assignment.
  try{
   assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase:seq});
   const output=execFileSync(process.execPath,['scripts/lite-solo-phase-controller-v1.mjs',
    '--controller-root',root,'--campaign-id',campaignId,
    '--campaign-path',campaignPath,'--campaign-directory-path',directoryRel,
    '--phase-sequence',String(seq),'--review-kind','phase','--audit-controller-ref','main'],
   {encoding:'utf8',env:{...process.env,LITE_SOLO_V4_FINALIZE:'1'},maxBuffer:1024*1024*2});
   const envelope=JSON.parse(output.trim());
   const updated=readJson(directoryFile);
   if((updated.lastSealedReceiptPath!==directory.lastSealedReceiptPath&&
      updated.currentAssignment?.phaseSequence!==seq)||updated.campaignStatus==='COMPLETE'){
    markFinalizationV1({root,campaignPath,phase:seq,status:'SEALED',
     details:{receiptPath:updated.lastSealedReceiptPath}});
    seal={status:'SEALED',phase:seq,receiptPath:updated.lastSealedReceiptPath};
   }else{
    const current=readJson(directoryFile);
    const packet=current.currentAssignment?.packetPath?readJson(repoFile(root,current.currentAssignment.packetPath)):null;
    const deficits=packet?.controllerValidation?.deficiencies??[];
    const reopened=deficits.length?reopenAggregateDefectsV1({root,campaignPath,phase:seq,deficiencies:deficits}):null;
    if(!reopened)markFinalizationV1({root,campaignPath,phase:seq,status:'BLOCKED',details:{envelopeStatus:envelope.status}});
    seal={status:'NOT_SEALED',phase:seq,envelopeStatus:envelope.status,rework:reopened};
   }
  }catch(error){
   // Reopen only the accountable source unit(s) on an aggregate schema failure.
   // Other execution/integrity failures stay visible as genuine phase blockers.
   const reason=String(error.stderr??error.message??error).slice(0,1800);
   const prefix='aggregate validation blocked: ';
   const rework=reason.startsWith(prefix)
    ?reopenAggregateDefectsV1({root,campaignPath,phase:seq,
      deficiencies:reason.slice(prefix.length).split('; ').filter(Boolean)})
    :null;
   if(!rework)markFinalizationV1({root,campaignPath,phase:seq,status:'BLOCKED',details:{error:reason}});
   seal={status:rework?.reopenedUnits?.length?'REWORK_REQUIRED':'BLOCKED',phase:seq,error:reason,rework};
  }
 }
}
function finalizeReadinessV1Safe(root,campaignPath,directory,phase){
 try{return finalizeReadinessV1({root,campaignPath,directory,phase});}
 catch(e){return {ready:false,reason:String(e.message??e)};}
}
const result={schemaVersion:'curveyield-lite-solo-unit-drain-summary-v1',
 campaignId,phase,processed:results,finalizeReady:ready,seal,
 state:phase&&[4,5,6].includes(phase)?statusUnitQueueV1({root,campaignPath,phase}):null};
process.stdout.write(JSON.stringify(result)+'\n');
