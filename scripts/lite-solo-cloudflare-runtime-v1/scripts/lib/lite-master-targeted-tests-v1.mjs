import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJson,requiredFile} from './lite-phase-work-v1.mjs';

const SHA=/^[0-9a-f]{64}$/;
const ID=/^[A-Za-z0-9._-]+$/;
const REVIEWERS=new Set(['reviewer-1','reviewer-2','reviewer-3','reviewer-3L','reviewer-4']);
// A campaign with a dedicated test-executor chat runs every targeted-test round there:
// it never owns a review segment, so it is always independent of the reviewed work.
const TEST_EXECUTOR='test-executor';
const hasTestExecutor=directory=>typeof directory?.testExecutor?.chatUrl==='string'&&directory.testExecutor.chatUrl.length>0;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const substantial=s=>typeof s==='string'&&s.trim().length>=24;
const inside=(root,rel,prefix)=>{
  if(typeof rel!=='string'||!rel.startsWith(prefix)||rel!==path.posix.normalize(rel)||rel.split('/').includes('..'))throw new Error('targeted-test artifact path escapes its campaign allocation: '+rel);
  const file=requiredFile(root,rel,'campaign-local targeted-test evidence');
  const realRoot=fs.realpathSync(root);
  const allowed=path.join(realRoot,...prefix.split('/').filter(Boolean));
  const real=fs.realpathSync(file);
  if(fs.lstatSync(file).isSymbolicLink()||!real.startsWith(allowed+path.sep))
    throw new Error('targeted-test evidence must be a real regular file inside the allocated campaign directory');
  return file;
};
const location=(campaignPath,segmentId)=>path.posix.join(campaignPath,'work/master-review',segmentId);
const planRel=(campaignPath,segmentId,round)=>path.posix.join(location(campaignPath,segmentId),'TARGETED_TEST_REQUEST_v'+round+'.json');
const evidenceRel=(campaignPath,requestId)=>path.posix.join(campaignPath,'evidence/master-targeted-tests',requestId);
const resultRel=(campaignPath,segmentId,requestId)=>path.posix.join(location(campaignPath,segmentId),'targeted-tests',requestId,'RESULT_v1.json');

export function registerMasterTargetedTests({root,campaignPath,directory,planPath,now}){
  const pending=directory.pendingMasterReview;
  if(!pending||directory.campaignStatus!=='WAITING_FOR_MASTER_REVIEW'||pending.status!=='WAITING_FOR_MASTER_REVIEW')
    throw new Error('targeted tests require a currently pending master-review gate');
  const round=(pending.targetedTests??[]).length+1;
  const required=planRel(campaignPath,pending.segmentId,round);
  if(planPath!==required)throw new Error('targeted-test plan must use '+required);
  const bytes=fs.readFileSync(inside(root,planPath,location(campaignPath,pending.segmentId)+'/'));
  const plan=JSON.parse(bytes.toString('utf8'));
  if(plan.schemaVersion!=='curveyield-lite-master-targeted-tests-v1'||plan.campaignId!==directory.campaignId||plan.segmentId!==pending.segmentId||plan.sourceSha256!==directory.sourceSha256)
    throw new Error('targeted-test plan campaign/segment/source binding mismatch');
  const dedicated=hasTestExecutor(directory);
  if(['reviewer-3-phases-05-07','reviewer-3-phases-05-06'].includes(pending.segmentId)&&!dedicated)
    throw new Error('Phase-5/6 master test directives (and legacy Phase-5/7 directives) require a registered independent test-executor chat');
  if(plan.assignedReviewer===TEST_EXECUTOR?!dedicated:(!REVIEWERS.has(plan.assignedReviewer)||plan.assignedReviewer===pending.reviewerId))
    throw new Error('targeted tests must be assigned to the test executor or a different registered reviewer');
  const assignedReviewer=dedicated?TEST_EXECUTOR:plan.assignedReviewer;
  if(!Array.isArray(plan.tests)||plan.tests.length===0)throw new Error('targeted-test plan requires at least one decisive test');
  const ids=new Set();
  for(const test of plan.tests){
    if(!ID.test(String(test.candidateId??''))||ids.has(test.candidateId))throw new Error('targeted-test plan contains empty or duplicate candidateId');
    ids.add(test.candidateId);
    for(const key of ['securityProperty','setupAndActors','transactionSequence','decisiveAssertions','expectedPassAndFail','economicImpactMethod','requiredRawEvidence'])
      if(!substantial(test[key]))throw new Error('targeted test '+test.candidateId+' requires concrete '+key);
  }
  const requestId=sha(bytes);
  const assignment={requestId,round,planPath,planSha256:requestId,assignedReviewer,...(assignedReviewer!==plan.assignedReviewer?{plannedReviewer:plan.assignedReviewer}:{}),candidateIds:[...ids],status:'AWAITING_EXECUTION',requestedAt:now,resultPath:resultRel(campaignPath,pending.segmentId,requestId)};
  pending.targetedTests=[...(pending.targetedTests??[]),assignment];
  pending.status='WAITING_FOR_TARGETED_TESTS';
  pending.updatedAt=now;
  directory.currentAssignment=null;
  directory.campaignStatus='WAITING_FOR_TARGETED_TESTS';
  directory.updatedAt=now;
  return assignment;
}

export function acceptMasterTargetedTestResults({root,campaignPath,directory,resultPath,now}){
  const pending=directory.pendingMasterReview;
  if(!pending||directory.campaignStatus!=='WAITING_FOR_TARGETED_TESTS'||pending.status!=='WAITING_FOR_TARGETED_TESTS')
    throw new Error('no outstanding master-requested targeted tests');
  const entry=(pending.targetedTests??[]).at(-1);
  if(!entry||entry.status!=='AWAITING_EXECUTION'||resultPath!==entry.resultPath)throw new Error('targeted-test result path does not match pending assignment');
  const bytes=fs.readFileSync(inside(root,resultPath,location(campaignPath,pending.segmentId)+'/targeted-tests/'+entry.requestId+'/'));
  const result=JSON.parse(bytes.toString('utf8'));
  if(result.schemaVersion!=='curveyield-lite-master-targeted-test-result-v1'||result.campaignId!==directory.campaignId||result.segmentId!==pending.segmentId||result.requestId!==entry.requestId||result.sourceSha256!==directory.sourceSha256||result.reviewer!==entry.assignedReviewer)
    throw new Error('targeted-test result campaign/segment/request/source/reviewer binding mismatch');
  if(!Array.isArray(result.tests)||result.tests.length!==entry.candidateIds.length)
    throw new Error('targeted-test result must address every assigned candidate');
  const seen=new Set();
  for(const test of result.tests){
    if(!entry.candidateIds.includes(test.candidateId)||seen.has(test.candidateId))throw new Error('targeted-test result has unknown or repeated candidate');
    seen.add(test.candidateId);
    if(!['CONFIRMED','DISPROVEN','INCONCLUSIVE'].includes(test.disposition)||!substantial(test.executionNarrative)||!substantial(test.observedAssertions)||!substantial(test.impactAssessment))
      throw new Error('targeted-test result lacks explicit disposition, observed assertions, execution and impact for '+test.candidateId);
    if(typeof test.executedCalls!=='number'||!Number.isInteger(test.executedCalls)||test.executedCalls<0)
      throw new Error('executedCalls must be an observed non-negative count, never a requested test budget');
    if(!Array.isArray(test.evidence)||test.evidence.length===0)
      throw new Error('targeted-test result must link durable raw execution evidence for '+test.candidateId);
    for(const ref of test.evidence){
      if(!SHA.test(String(ref.sha256??'')))throw new Error('invalid evidence SHA256 for '+test.candidateId);
      const file=inside(root,ref.path,evidenceRel(campaignPath,entry.requestId)+'/');
      if(sha(fs.readFileSync(file))!==ref.sha256)throw new Error('targeted-test evidence digest mismatch: '+ref.path);
    }
    if(test.disposition!=='INCONCLUSIVE'&&test.executedCalls===0)
      throw new Error('conclusive test requires observed execution, not only requested counts: '+test.candidateId);
    if(entry.assignedReviewer===TEST_EXECUTOR){
      // A green workflow that ran no assertions is not a test.
      if(typeof test.executedAssertions!=='number'||!Number.isInteger(test.executedAssertions)||test.executedAssertions<0)
        throw new Error('executedAssertions must be the observed count of test assertions that ran: '+test.candidateId);
      if(test.disposition!=='INCONCLUSIVE'&&test.executedAssertions===0)
        throw new Error('conclusive test requires executed assertions, not only a successful run: '+test.candidateId);
    }
    if(test.disposition==='INCONCLUSIVE'&&!substantial(test.remainingUncertainty))
      throw new Error('inconclusive test must state the blocker and next feasible recovery step: '+test.candidateId);
  }
  entry.status='EVIDENCE_SUBMITTED';
  entry.resultSha256=sha(bytes);
  entry.receivedAt=now;
  pending.status='WAITING_FOR_MASTER_REVIEW';
  pending.updatedAt=now;
  directory.campaignStatus='WAITING_FOR_MASTER_REVIEW';
  directory.updatedAt=now;
  return entry;
}

// Final campaign completion must never convert a live, potentially material,
// unconfirmed candidate into a no-finding closure by word choice alone.
export function verifyMasterTargetedTestEvidence({root,campaignPath,directory}){
  const pending=directory.pendingMasterReview;
  const failures=[];
  for(const entry of pending?.targetedTests??[]){
    if(entry.status!=='EVIDENCE_SUBMITTED'||!SHA.test(String(entry.resultSha256??''))){
      failures.push('master targeted-test round '+entry.round+' has no admitted evidence');continue;
    }
    try{
      const plan=inside(root,entry.planPath,location(campaignPath,pending.segmentId)+'/');
      if(sha(fs.readFileSync(plan))!==entry.planSha256||entry.planSha256!==entry.requestId)
        throw new Error('immutable targeted-test plan changed');
      const file=inside(root,entry.resultPath,location(campaignPath,pending.segmentId)+'/targeted-tests/'+entry.requestId+'/');
      const bytes=fs.readFileSync(file);
      if(sha(bytes)!==entry.resultSha256)throw new Error('targeted-test result changed after controller admission');
      const result=JSON.parse(bytes.toString('utf8'));
      if(result.requestId!==entry.requestId||result.sourceSha256!==directory.sourceSha256)
        throw new Error('targeted-test result source/request binding changed');
      for(const test of result.tests??[]){
        for(const ref of test.evidence??[]){
          const raw=inside(root,ref.path,evidenceRel(campaignPath,entry.requestId)+'/');
          if(sha(fs.readFileSync(raw))!==ref.sha256)throw new Error('targeted-test raw evidence changed: '+ref.path);
        }
      }
    }catch(error){failures.push('master test round '+entry.round+': '+String(error?.message??error));}
  }
  return failures;
}

export function unresolvedFinalCandidateFailures({root,campaignPath,directory}){
  const phase8=path.posix.join(campaignPath,'derived/phase-8/PHASE_08_CANONICAL_DATA_v1.json');
  const data=readJson(requiredFile(root,phase8,'Phase-8 canonical candidate disposition'));
  const candidates=data?.actions?.['step-2']?.outputs?.candidateValidations;
  if(!Array.isArray(candidates))return ['Phase-8 canonical candidate validations are missing'];
  const failures=[];
  for(const c of candidates){
    if(c.findingPromotion==='PROMOTE_FINDING')continue;
    const unresolved=[c.finalDisposition,c.outcome,c.propertyViolation,c.impact].some(v=>/UNCONFIRM|NOT_ESTABLISHED|NOT_DISPROVEN|INCONCLUSIVE|UNRESOLVED|UNKNOWN|UNQUANTIFIED|INSUFFICIENT_EVIDENCE/i.test(String(v??'')));
    if(unresolved){
      failures.push('Candidate '+c.candidateKey+' retains unresolved reachability/property/impact; no conclusive security disposition. Request further targeted tests through master-review, or promote a substantiated finding.');
    }
  }
  // The sealed original cannot be rewritten. A candidate that was originally
  // marked unconfirmed cannot be cleared by just changing descriptive fields.
  // Require a matching conclusive delegated result and an explicit traceable
  // reference to its raw machine evidence in the refreshed Phase-8 work form.
  const pending=directory.pendingMasterReview;
  const sealed8=(pending?.sealedWorkForms??[]).find(x=>Number(x.phase)===8);
  if(pending?.segmentId==='reviewer-4-phases-08-10'&&!sealed8)
    failures.push('Final master review lacks its immutable sealed Phase-8 original');
  if(sealed8){
    try{
      const original=inside(root,sealed8.sealedOriginalPath,location(campaignPath,pending.segmentId)+'/sealed-originals/');
      const originalBytes=fs.readFileSync(original);
      if(sha(originalBytes)!==sealed8.sha256)throw new Error('sealed Phase-8 original SHA-256 mismatch');
      const previous=JSON.parse(originalBytes.toString('utf8'))?.actions?.['step-2']?.outputs?.candidateValidations??[];
      const resultByCandidate=new Map();
      for(const entry of pending.targetedTests??[]){
        if(entry.status!=='EVIDENCE_SUBMITTED')continue;
        const result=readJson(requiredFile(root,entry.resultPath,'master delegated test result'));
        for(const test of result.tests??[])resultByCandidate.set(test.candidateId,test);
      }
      for(const old of previous){
        const originalUnresolved=[old.finalDisposition,old.outcome,old.propertyViolation,old.impact]
          .some(v=>/UNCONFIRM|NOT_ESTABLISHED|NOT_DISPROVEN|INCONCLUSIVE|UNRESOLVED|UNKNOWN|UNQUANTIFIED|INSUFFICIENT_EVIDENCE/i.test(String(v??'')));
        if(!originalUnresolved)continue;
        const current=candidates.find(x=>x.candidateKey===old.candidateKey);
        if(!current){failures.push('Previously unconfirmed candidate disappeared: '+old.candidateKey);continue;}
        const resolved=resultByCandidate.get(old.candidateKey);
        const expected=current.findingPromotion==='PROMOTE_FINDING'?'CONFIRMED':'DISPROVEN';
        if(!resolved||resolved.disposition!==expected){
          failures.push('Previously unconfirmed '+old.candidateKey+' requires a raw-evidence-bound delegated '+expected+' test result before closure');
          continue;
        }
        const refs=String(current.evidenceRefs??'');
        if(!(resolved.evidence??[]).some(ref=>refs.includes(ref.path)))
          failures.push('Phase-8 '+old.candidateKey+' must cite the exact delegated raw evidence in evidenceRefs');
      }
    }catch(error){failures.push('Cannot verify the sealed original/follow-up linkage: '+String(error?.message??error));}
  }
  // Submitted tests supplement but cannot replace a corrected, evidence-bound
  // phase-8 disposition. A narrative-only master PASS is never sufficient.
  for(const assignment of pending?.targetedTests??[]){
    if(assignment.status!=='EVIDENCE_SUBMITTED')failures.push('Master targeted-test assignment '+assignment.requestId+' lacks verified raw evidence');
  }
  return failures;
}
