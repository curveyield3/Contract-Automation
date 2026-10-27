#!/usr/bin/env node
// Durable per-campaign Lite-Solo v4 request drainer; invoked by the existing Actions runtime.
// Ordinary work is per-unit. Whole-phase validation/sealing occurs only once all accepted.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {processUnitRequestV1,finalizeReadinessV1,assembleAcceptedUnitShardsV1,markFinalizationV1,statusUnitQueueV1,reopenAggregateDefectsV1} from './lib/audit-preview-unit-queue-v1.mjs';
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
if(directory.campaignId!==campaignId||directory.mode!=='LITE_SOLO'||directory.authorityRelease!=='audit-preview-v1')
 throw Error('request drainer denies non-v4 campaigns');
const campaignPath=directory.workspacePath;
if(typeof campaignPath!=='string'||!campaignPath.startsWith('campaigns/')||campaignPath.split('/').includes('..'))
 throw Error('unsafe campaign workspace');
const receipt=readJson(repoFile(root,campaignPath+'/receipts/PHASE_00_RECEIPT_v1.json'));
if(receipt.authority?.liteRelease!=='audit-preview-v1'||receipt.authority?.manifestSha256!==directory.authorityDigest||
 receipt.campaign?.campaignGenerationId!==directory.campaignGenerationId||
 receipt.source?.sha256!==directory.sourceSha256)throw Error('source/authority generation binding invalid');
const requestDir=path.resolve(arg['requests-root']??'process/agent-upload/audit-preview-unit-requests',campaignId);
const results=[],phase=directory.currentAssignment?.phaseSequence;
if(![4].includes(phase)&&arg.mode!=='drain')throw Error('not a v4 unit phase');
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
let ready=false,seal=null;
if([4].includes(directory.currentAssignment?.phaseSequence)){
 const gate=finalizeReadinessV1Safe(root,campaignPath,directory,directory.currentAssignment.phaseSequence);
 ready=gate.ready;
 if(arg.mode==='finalize'&&ready){
  const seq=directory.currentAssignment.phaseSequence;
  // Existing work-form controller, not a second parallel validation implementation.
  // It performs full semantic/security validation, source-bound execution checks,
  // receipt generation, Phase-7 automatic marker and successor assignment.
  try{
   assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase:seq});
   const output=execFileSync(process.execPath,['scripts/audit-preview-phase-controller-v1.mjs',
    '--controller-root',root,'--campaign-id',campaignId,
    '--campaign-path',campaignPath,'--campaign-directory-path',directoryRel,
    '--phase-sequence',String(seq),'--review-kind','phase','--audit-controller-ref','main'],
   {encoding:'utf8',env:{...process.env,AUDIT_PREVIEW_PHASE4_FINALIZE:'1'},maxBuffer:1024*1024*2});
   const envelope=JSON.parse(output.trim());
   const updated=readJson(directoryFile);
   if((updated.lastSealedReceiptPath!==directory.lastSealedReceiptPath&&
      updated.currentAssignment?.phaseSequence!==seq)||updated.campaignStatus==='PREVIEW_COMPLETE'){
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
 state:phase&&[4].includes(phase)?statusUnitQueueV1({root,campaignPath,phase}):null};
process.stdout.write(JSON.stringify(result)+'\n');
