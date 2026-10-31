#!/usr/bin/env node
// Idempotent delivery-only replay of a *published* controller result.
// It never imports or invokes the phase controller, so a retry cannot re-seal.
import fs from 'node:fs';
import path from 'node:path';
import {restoreControllerResultV1} from './lib/lite-boundary-result-v1.mjs';
import {validatePublishedDeliveryV1} from './lib/lite-controller-delivery-state-v1.mjs';

export function prepareControllerDeliveryReplayV1({root,directoryRel,detailRef}={}){
 const directory=JSON.parse(fs.readFileSync(path.join(root,...directoryRel.split('/')),'utf8'));
 if(directory?.schemaVersion!=='curveyield-audit-campaign-directory-entry-v2')
   throw new Error('replay requires canonical campaign directory');
 const campaignPath=directory.workspacePath,campaignId=directory.campaignId;
 if(!/^campaigns\//.test(campaignPath??'')||!/^[-a-zA-Z0-9._]+-r[0-9]+$/.test(campaignId??''))
   throw new Error('invalid replay campaign identity');
 if(typeof detailRef!=='string'||!/^controller\/results\/[a-f0-9]{20}\/INDEX_v1\.json$/.test(detailRef))
   throw new Error('replay detailRef must be a canonical paged-result index');
 if(['STOPPED_BY_HUMAN','BLOCKED','COMPLETE'].includes(directory.campaignStatus))
   throw new Error('replay refused for stopped, blocked or completed campaign');
 const index=JSON.parse(fs.readFileSync(path.join(root,...campaignPath.split('/'),...detailRef.split('/')),'utf8'));
 if(index.campaignId!==campaignId||!/^([a-f0-9]{64})$/.test(index.resultSha256??''))
   throw new Error('replay result is not bound to campaign');
 const response=restoreControllerResultV1({root,campaignPath,envelope:{
   schemaVersion:'curveyield-lite-controller-envelope-v1',status:index.status,
   campaignId,sha256:index.resultSha256,detailRef,counts:{
     resultBytes:index.resultBytes,pageCount:index.pages.length}
 }});
 const resultSha256=index.resultSha256;
 const authority=String(directory.currentAssignment?.workSchemaPath??directory.skillAuthority?.current?.homepagePath??'');
 const isV13=authority.includes('Audit_Litemode_v13');
 const delivery=validatePublishedDeliveryV1({root,campaignPath,resultSha256,now:new Date().toISOString()});
 if(isV13&&!delivery)throw new Error('v13 published controller result has no bound delivery ledger');
 let kind=null,role=null,phaseId=null,milestoneId=null,message=null;
 if(response.status==='NEEDS_REWORK'){
   const assignment=directory.currentAssignment;
   if(assignment?.phaseSequence!==response.phaseSequence||
     assignment.reviewer!==response.reviewer)
     throw new Error('stale reviewer rework replay');
   kind='REVIEWER';role=assignment.reviewer;phaseId=assignment.phaseId;
   milestoneId='PHASE_'+assignment.phaseSequence+'_WORK_PACKET';
   message=response.feedbackText;
 }else if(response.status==='PASS'&&response.sameReviewerAdvanced===true){
   const next=directory.currentAssignment;
   if(!next||next.phaseSequence!==response.nextAssignment?.phaseSequence||
     next.reviewer!==response.nextAssignment?.reviewer)
     throw new Error('stale same-reviewer successor replay');
   kind='REVIEWER';role=next.reviewer;phaseId=next.phaseId;
   milestoneId='PHASE_'+next.phaseSequence+'_WORK_PACKET';
   message='CONTROLLER_PHASE_PASS. Prior phase sealed; proceed now with '+phaseId+
     ' from the canonical campaign directory. Complete every shard and submit once.';
 }else if(response.status==='PASS'&&response.freshSuccessorRequired===true){
   const next=directory.currentAssignment;
   if(!next||next.phaseSequence!==response.nextAssignment?.phaseSequence||
     next.reviewer!==response.nextAssignment?.reviewer)
     throw new Error('stale fresh-successor replay');
   kind='ORCHESTRATOR';role=next.reviewer;phaseId=next.phaseId;
   milestoneId='PHASE_'+next.phaseSequence+'_WORK_PACKET';message=response.feedbackText;
 }else if(['MASTER_REVIEW_INVALID','WAITING_FOR_MASTER_REVIEW'].includes(response.status)){
   if(directory.pendingMasterReview?.segmentId!==response.segmentId)
     throw new Error('stale master replay');
   kind='MASTER';role='master-reviewer';phaseId='master-review';
   milestoneId=directory.pendingMasterReview.segmentId;message=response.feedbackText;
 }else throw new Error('this controller result has no replayable pending delivery');
 if(typeof message!=='string'||!message.trim())throw new Error('replay has no message');
 const fullRef=campaignPath+'/'+detailRef;
 if(Buffer.byteLength(message)>3000)
   message='Controller review requires action. Retrieve all exact, lossless details from '+fullRef+
     ', then resume only your current assigned work; no controller computation is needed.';
 return {schemaVersion:'curveyield-lite-delivery-replay-v1',kind,campaignId,campaignPath,
   role,phaseId,milestoneId,wakeId:delivery?.wakeId??campaignId+'-delivery-replay-'+resultSha256.slice(0,20),
   deliveryManaged:Boolean(delivery),
   messageB64:Buffer.from(message).toString('base64'),
   sourceResultSha256:resultSha256,sourceResultRef:fullRef,
   // A successful GH content fetch proves publication. Browser delivery is
   // confirmed ONLY by its existing first-action wake-ack workflow.
   state:'PUBLISHED_AWAITING_DELIVERY'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 try{
   const [root,directoryRel,detailRef]=process.argv.slice(2);
   const out=prepareControllerDeliveryReplayV1({root,directoryRel,detailRef});
   process.stdout.write(JSON.stringify(out)+'\n');
 }catch(e){process.stderr.write('DELIVERY_REPLAY_REFUSED: '+String(e?.message??e)+'\n');process.exitCode=1;}
}
