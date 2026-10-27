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
if(!campaignId.startsWith('audit-preview-completion-'))throw Error('APC_REQUEST_WRONG_PRODUCT');
const slug=campaignId.replace(/-r[0-9]+$/,'');
if(slug===campaignId)throw Error('campaign generation suffix missing');
const directoryRel='Audit Campaign Directory/campaigns/'+slug+'.json';
const directoryFile=repoFile(root,directoryRel);
const directory=readJson(directoryFile);
if(directory.previewCompletion?.status!=='LAUNCHED'||!/^[a-f0-9]{64}$/.test(directory.previewCompletion.onchainVerificationSha256??''))throw Error('APC_LAUNCH_PROVENANCE_MISSING');
if(directory.campaignId!==campaignId||directory.mode!=='LITE_SOLO'||directory.authorityRelease!=='lite-solo-v4')
 throw Error('request drainer denies non-v4 campaigns');
const campaignPath=directory.workspacePath;
if(typeof campaignPath!=='string'||!campaignPath.startsWith('campaigns/')||campaignPath.split('/').includes('..'))
 throw Error('unsafe campaign workspace');
const receipt=readJson(repoFile(root,campaignPath+'/receipts/PHASE_00_RECEIPT_v1.json'));
if(receipt.authority?.liteRelease!=='lite-solo-v4'||receipt.authority?.manifestSha256!==directory.authorityDigest||
 receipt.campaign?.campaignGenerationId!==directory.campaignGenerationId||
 receipt.source?.sha256!==directory.sourceSha256)throw Error('source/authority generation binding invalid');
const requestDir=path.resolve(arg['requests-root']??'process/agent-upload/audit-preview-completion-unit-requests',campaignId);
const results=[],phase=directory.currentAssignment?.phaseSequence;
if(![4,5,6].includes(phase)&&arg.mode!=='drain')throw Error('not a v4 unit phase');
if(arg.mode!=='finalize'){
 let changed=false;
 const files=fs.existsSync(requestDir)?fs.readdirSync(requestDir).filter(x=>/^[A-Za-z0-9._-]+\.json$/.test(x)).sort():[];
 const queuePath=directory.unitQueueStatePath;
 const recorded=queuePath&&fs.existsSync(repoFile(root,queuePath))?
  readJson(repoFile(root,queuePath)):null;
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
  const result=processUnitRequestV1({root,campaignPath,directory,request});
  const resultRel=path.posix.join(campaignPath,'work/phase-'+String(phase).padStart(2,'0'),
   'units','controller','results','REQUEST_'+request.requestId+'_v1.json');
  const previous=fs.existsSync(repoFile(root,resultRel))?readJson(repoFile(root,resultRel)):null;
  if(JSON.stringify(previous)!==JSON.stringify(result)){writeJson(repoFile(root,resultRel),result);changed=true;}
  results.push({requestId:request.requestId,status:result.status});
 }
 if(changed){directory.updatedAt=new Date().toISOString();writeJson(directoryFile,directory);}
}
// A sealed, explicit NONE_IDENTIFIED target design requires no machine execution.
// Inspect only controller-accepted target units; all other cases fail closed to
// the campaign-specific human authorization gate.
const noExecutableTargets=(()=>{
 if(directory.currentAssignment?.phaseSequence!==5)return false;
 try{
  const state=readJson(repoFile(root,path.posix.join(campaignPath,'work/phase-05/units/UNIT_QUEUE_STATE_v1.json')));
  const targets=Object.entries(state.units??{}).filter(([id])=>/^P5-T-/.test(id));
  if(!targets.length)return false;
  let sentinelCount=0;
  const expectedKey=JSON.stringify(['actions','step-3','outputs','targetDesigns'])+':0';
  for(const [id,unit] of targets){
   if(unit.status!=='ACCEPTED'||!unit.acceptedPath)return false;
   const accepted=readJson(repoFile(root,unit.acceptedPath));
   if(accepted.unitId!==id||accepted.phaseSequence!==5||
      accepted.sourceSha256!==directory.sourceSha256||
      accepted.authorityDigest!==directory.authorityDigest||
      !Array.isArray(accepted.submission?.entries))return false;
   for(const entry of accepted.submission.entries){
    if(entry?.key!==expectedKey||entry?.value!=='NONE_IDENTIFIED'||++sentinelCount!==1)return false;
   }
  }
  return sentinelCount===1;
 }catch{return false;}
})();

let ready=false,seal=null;
if([4,5,6].includes(directory.currentAssignment?.phaseSequence)){
 const gate=finalizeReadinessV1Safe(root,campaignPath,directory,directory.currentAssignment.phaseSequence);
 ready=gate.ready;
 if(arg.mode==='finalize'&&ready){
  if(directory.currentAssignment?.phaseSequence===5&&!noExecutableTargets&&!(
    directory.machineExecutionAuthorization?.status==='APPROVED'&&
    directory.machineExecutionAuthorization?.sourceSha256===directory.sourceSha256&&
    directory.machineExecutionAuthorization?.scope==='PHASE5_TARGET_EXECUTION'
  ))throw Error('APC_EXPLICIT_PHASE5_TEST_AUTHORIZATION_REQUIRED');
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
 campaignId,phase,processed:results,finalizeReady:ready,phase5NoExecutableTargets:noExecutableTargets,seal,
 state:phase&&[4,5,6].includes(phase)?statusUnitQueueV1({root,campaignPath,phase}):null};
process.stdout.write(JSON.stringify(result)+'\n');
