// Typed, controller-owned reopening of a completed, source-bound v11 campaign.
// Authorizes fresh delegated reviewer testing; NEVER executes contracts or edits prior seals.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,requiredFile} from './lite-phase-work-v1.mjs';
import {stageMasterReview} from './lite-master-review-v1.mjs';

const W='campaigns/CurveYield DEX v16 Source/CurveYield DEX v16 Source r4';
const LEGACY_W='campaigns/CurveYield DEX v16 Source r4';
const ID='curveyield-dex-v16-source-r4';
const GEN='curveyield-dex-v16-source-r4-g1-20261005T212825Z';
const SOURCE='201a70f61f14e1919d111a972d090b07cf13e5fc06fee10738785adfb6760f4e';
const SEGMENT='reviewer-4-followup-v1';
const CANDIDATES=['P4-CAND-001','P4-CAND-002'];
const GOVERNANCE='OBL-P3-P3-OBL-005';
const EXPECTED_REQUEST=path.posix.join(W,'controller/POST_COMPLETION_FOLLOWUP_REQUEST_v1.json');
const LEGACY_REQUEST=path.posix.join(LEGACY_W,'controller/POST_COMPLETION_FOLLOWUP_REQUEST_v1.json');
const verifiedAlias=root=>{
  const old=path.join(root,LEGACY_W),active=path.join(root,W);
  return fs.existsSync(old)&&fs.lstatSync(old).isSymbolicLink()&&fs.realpathSync(old)===fs.realpathSync(active);
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const load=(root,rel,label)=>readJson(requiredFile(root,rel,label));
export function validatePostCompletionFollowupV1({root,campaignPath,directory,requestPath}={}){
  const migrated=Boolean(root&&verifiedAlias(root));
  if(!root||!directory||campaignPath!==W||
     (requestPath!==EXPECTED_REQUEST&&!(migrated&&requestPath===LEGACY_REQUEST)))
    throw Error('followup must use exact controller-allocated campaign and request path');
  if(directory.schemaVersion!=='curveyield-audit-campaign-directory-entry-v2'||directory.campaignId!==ID||directory.campaignGenerationId!==GEN||directory.sourceSha256!==SOURCE)throw Error('wrong campaign generation or source; post-completion followup denied');
  if(directory.campaignStatus!=='COMPLETE'||directory.currentAssignment!==null||directory.pendingMasterReview)throw Error('post-completion followup requires an actually COMPLETE campaign with no active assignment');
  if(directory.postCompletionFollowup)throw Error('post-completion followup already admitted; refuse duplicate assignment');
  const request=load(root,requestPath,'typed post-completion followup request');
  if(request.schemaVersion!=='curveyield-lite-post-completion-followup-request-v1'||
     request.campaignId!==ID||request.campaignGenerationId!==GEN||request.sourceSha256!==SOURCE||
     (request.workspacePath!==W&&!(migrated&&request.workspacePath===LEGACY_W))||
     (request.lastSealedReceiptPath!==directory.lastSealedReceiptPath&&
      !(migrated&&request.lastSealedReceiptPath===directory.lastSealedReceiptPath.replace(W,LEGACY_W)))||
     request.governanceObligationId!==GOVERNANCE||
     JSON.stringify(request.candidateIds)!==JSON.stringify(CANDIDATES)||
     request.holdSuccessorDelivery!==true||request.productionMutationsForbidden!==true)
     throw Error('post-completion followup request has wrong source, scope, generation, receipt, or safety bindings');
  const receipt=load(root,directory.lastSealedReceiptPath,'last accepted Phase-10 receipt');
  if(receipt?.phase?.sequence!==10||receipt?.phase?.status!=='COMPLETE'||receipt?.validation?.status!=='PASS'||receipt?.source?.sha256!==SOURCE)
    throw Error('accepted terminal receipt does not bind exact source and PASS state');
  if(!/^Audit Skill - Current Authority\/Audit_Litemode_v(1[1-9]|[2-9][0-9])\/SKILL\.md$/.test(String(receipt?.authority?.homepagePath??'')))
    throw Error('followup must preserve bound v11 audit authority');
  const p8=load(root,path.posix.join(W,'derived/phase-8/PHASE_08_CANONICAL_DATA_v1.json'),'final candidate dispositions');
  const rows=p8?.actions?.['step-2']?.outputs?.candidateValidations??[];
  for(const key of CANDIDATES){
    const row=rows.find(v=>v?.candidateKey===key);
    if(!row)throw Error('requested candidate missing from exact accepted Phase-8 data: '+key);
    if(!/UNCONFIRM|NOT_ESTABLISHED|UNRESOLVED|UNKNOWN|NOT_DISPROVEN/i.test(JSON.stringify(row)))
      throw Error('candidate is not recorded unconfirmed and cannot be included in this narrow followup: '+key);
  }
  const report=fs.readFileSync(requiredFile(root,path.posix.join(W,'work/phase-10/PHASE_10_FINAL_REPORT_v2.md'),'final accepted report'),'utf8');
  if(!report.includes(GOVERNANCE))throw Error('governance obligation absent from accepted final report');
  const snapshot={campaignId:ID,campaignGenerationId:GEN,sourceSha256:SOURCE,lastSealedReceiptPath:directory.lastSealedReceiptPath,terminalReceiptDigestSha256:sha(fs.readFileSync(requiredFile(root,directory.lastSealedReceiptPath,'terminal receipt'))),requestSha256:sha(fs.readFileSync(requiredFile(root,requestPath,'typed followup request')))};
  return {request,receipt,snapshot};
}
export function admitPostCompletionFollowupV1({root,campaignPath,directory,requestPath,now}={}){
  const check=validatePostCompletionFollowupV1({root,campaignPath,directory,requestPath});
  const authorityRoot=path.posix.dirname(check.receipt.authority.homepagePath);
  const staged=stageMasterReview({
    root,campaignPath,directory,predecessor:check.receipt,authorityRoot,
    segmentId:SEGMENT,boundaryPhase:10,
    lastSealedReceiptPath:check.snapshot.lastSealedReceiptPath,
    nextSequence:null,now
  });
  const admission={
    schemaVersion:'curveyield-lite-post-completion-followup-admission-v1',
    ...check.snapshot,requestPath,candidateIds:CANDIDATES,governanceObligationId:GOVERNANCE,
    segmentId:SEGMENT,technicalReviewer:'reviewer-3L',status:'AWAITING_MASTER_TARGETED_TEST_DIRECTIVE',
    originalCampaignStatus:'COMPLETE',originalAcceptedMasterReview:structuredClone(directory.lastAcceptedMasterReview??null),
    priorReceiptsRetained:true,producer:'LITE_PHASE_CONTROLLER',admittedAt:now
  };
  staged.pending.postCompletionFollowup=admission;
  directory.postCompletionFollowup=admission;
  return {admission,pending:staged.pending,recordPath:staged.pending.recordPath};
}
