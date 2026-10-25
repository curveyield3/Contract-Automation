const FLOW_SCHEMA='curveyield-flow-review-submission-v1';
const ATTACK_SCHEMA='curveyield-attack-submission-v1';
const REVIEW_RESULTS=new Set(['SUPPORTED','CONCERN','UNRESOLVED','NOT_APPLICABLE']);
const ATTACK_RESULTS=new Set(['BLOCKED','VIABLE','UNCERTAIN']);
const ATTACK_ROLES=new Set(['UNPRIVILEGED','UNPRIVILEGED_CALLER','OTHER_ROLE','DIFFERENT_ROLE',
 'MALICIOUS_TOKEN','MALICIOUS_ADAPTER','MALICIOUS_TOKEN_OR_ADAPTER','MALICIOUS_CALLBACK',
 'MEV','MEV_SEARCHER','CARELESS_ADMIN','ADMIN','PRIVILEGED','PRIVILEGED_ROLE']);
// Constants, immutables and auto-generated getters carry no logic: one per-contract confirmation
// in trivialReviews covers them. Upgrade/storage is a contract property: answered once per
// upgradeable contract in contractChecks. groupChecks cover functions sharing a modifier.
export const TRIVIAL_KINDS_V1=new Set(['CONSTANT','IMMUTABLE','GENERATED_GETTER']);
export function isLiteralConstantV13(context){
 const text=String(context?.declaredValue??'').trim();
 return context?.kind==='CONSTANT'&&Number.isSafeInteger(context?.lineStart)&&
   context.lineStart>=1&&Number.isSafeInteger(context.lineEnd)&&context.lineEnd>=context.lineStart&&
   /^(?:true|false|0x[0-9a-fA-F]+|[0-9][0-9_]*(?:\s+(?:wei|gwei|ether|seconds|minutes|hours|days|weeks))?|["'][^"']{0,256}["'])$/.test(text);
}

const blank=x=>typeof x!=='string'||!x.trim();
const emptyEvidence=x=>blank(x)||['n/a','none','safe','no issue','reviewed'].includes(x.trim().toLowerCase());
const keys=arr=>Array.isArray(arr)?arr.map(x=>typeof x==='string'?x:x?.contextId??x?.flowId??x?.obligationId):[];
const comparable=x=>typeof x==='string'?x.toLowerCase().replace(/\s+/g,' ').trim():'';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const err=(out,code,path,message)=>out.push({code,path,message});
const finish=(errors,value)=>({ok:errors.length===0,errors,value:errors.length===0?value:null});
const validAnchors=(anchors,inventory,errors,path)=>{
 if(!Array.isArray(anchors)){err(errors,'SUBMISSION_SCHEMA',path,'anchors must be an array');return 0;}
 let accepted=0;
 for(let i=0;i<anchors.length;i++){
   if(parseAnchorV1(anchors[i],inventory))accepted++;
   else err(errors,'ANCHOR_INVALID',path+'['+i+']','Invalid or out-of-scope source anchor');
 }
 return accepted;
};
const arr2=x=>Array.isArray(x)?x:[];
const packetIds=(packet,field)=>keys(packet?.[field]??[]);
const requiredFor=(packet,id)=>{
 const direct=packet?.requiredClasses?.[id]??packet?.requiredClasses?.find?.(x=>x.contextId===id)?.classIds ??
 packet?.primaryContexts?.find?.(x=>x.contextId===id)?.requiredClasses ??
 packet?.primaryContexts?.find?.(x=>x.contextId===id)?.classIds ?? [];
 return Array.isArray(direct)?direct:[];
};
function candidateRecords(submission,row,check){
 return [ ...(Array.isArray(submission?.candidates)?submission.candidates:[]),
   ...(Array.isArray(row?.candidates)?row.candidates:[]),
   ...(obj(check?.candidate)?[check.candidate]:[]) ];
}
function hasCandidate(check,all){
 const pointer=check?.candidateTempKey??check?.candidateId??(typeof check?.candidate==='string'?check.candidate:null);
 return obj(check?.candidate)|| (Array.isArray(check?.candidates)&&check.candidates.some(obj))|| (typeof pointer==='string'&&pointer.trim()&&all.some(x=>[x?.tempKey,x?.candidateId,x?.id].includes(pointer)))||
   all.some(x=>x?.classId===check.classId);
}
function validateCandidate(c,inventory,errors,path){
 if(!obj(c)||blank(c.title)||blank(c.description))err(errors,'CANDIDATE_INVALID',path,'Candidate title and description are required');
 const before=errors.length;
 const count=validAnchors(c?.anchors,inventory,errors,path+'.anchors');
 if(count===0)err(errors,'CANDIDATE_INVALID',path,'Candidate requires a valid source anchor');
 return before===errors.length;
}
function checkSchema(submission,expected){
 return obj(submission)&&submission.schemaVersion===expected;
}
export function parseAnchorV1(text,inventory) {
 if(typeof text!=='string')return null;
 const m=/^(.+):L([0-9]+)(?:-L([0-9]+))?$/.exec(text);
 if(!m)return null;
 const path=m[1],lineStart=Number(m[2]),lineEnd=m[3]===undefined?lineStart:Number(m[3]);
 if(!Number.isSafeInteger(lineStart)||!Number.isSafeInteger(lineEnd)||lineStart<1||lineEnd<lineStart)return null;
 const files=inventory?.payload?.sourceUnits??[];
 const file=files.find(s=>s.path===path&&['IN_SCOPE','DEPENDENCY'].includes(s.scopeTier));
 if(!file||!Number.isInteger(file.lineCount)||lineEnd>file.lineCount)return null;
 return {path,lineStart,lineEnd};
}

// Opt-in for new v13-bound campaigns only. Historical v12 packets continue
// through the original per-class validator and produce identical decisions.
function validateVerdictSubmissionV13({packet,submission,inventory}){
 const errors=[];
 const primary=packetIds(packet,'primaryContexts').length?
   packetIds(packet,'primaryContexts'):packetIds(packet,'primaryContextIds');
 const trivial=new Set(packetIds(packet,'trivialContextIds').filter(id=>
    isLiteralConstantV13(arr2(inventory?.payload?.contexts).find(c=>c.contextId===id))));
 const covered=new Set(),seen=new Set(),allCandidates=candidateRecords(submission);
 const reviews=arr2(submission?.trivialReviews);
 for(const [i,review] of reviews.entries()){
   const contexts=arr2(packet.primaryContexts).filter(x=>x.qualifiedContainer===review?.contract&&
     trivial.has(x.contextId));
   if(!contexts.length)err(errors,'TRIVIAL_CONTRACT_UNKNOWN','trivialReviews['+i+']',
     'V13 trivialReviews apply only to literal CONSTANT definitions with source anchors; getters and immutables require verdict rows');
   if(blank(review?.reason??review?.evidence))err(errors,'EVIDENCE_EMPTY','trivialReviews['+i+'].reason','Explain exact literal/getter correctness');
   for(const c of contexts)covered.add(c.contextId);
 }
 for(const [i,row] of arr2(submission?.rows).entries()){
   const p='rows['+i+']',id=row?.contextId;
   if(!primary.includes(id)||covered.has(id))err(errors,'EXTRA_CONTEXT',p+'.contextId','Unassigned or trivially completed row');
   if(seen.has(id))err(errors,'DUPLICATE_CONTEXT',p+'.contextId','Duplicate context verdict');
   seen.add(id);
   if(!['CORRECT','DEFECT','UNRESOLVED'].includes(row?.verdict))
     err(errors,'VERDICT_REQUIRED',p+'.verdict','A correctness verdict (CORRECT/DEFECT) or justified UNRESOLVED is mandatory');
   if(blank(row?.intent)||emptyEvidence(row?.intent))err(errors,'INTENT_REQUIRED',p+'.intent',
     'State what the behavior should do, grounded in source or specification');
   if(blank(row?.reason)||emptyEvidence(row?.reason))err(errors,'REASON_REQUIRED',p+'.reason',
     'Explain actual behavior versus intent with source-line evidence');
   const anchors=validAnchors(row?.anchors,inventory,errors,p+'.anchors');
   if(anchors===0)err(errors,'ANCHOR_REQUIRED',p+'.anchors','Verdict requires source anchor');
   if(row?.verdict==='UNRESOLVED'){
     if(blank(row?.decidingTest?.name)||blank(row?.decidingTest?.expectedObservation))
       err(errors,'UNRESOLVED_TEST_REQUIRED',p+'.decidingTest',
         'Name a decisive test and exact observation that resolves correctness');
   }
   if(row?.verdict==='DEFECT'){
     if(!hasCandidate({...row,classId:row?.classId??'OTHER'},candidateRecords(submission,row,row)))
       err(errors,'DEFECT_WITHOUT_CANDIDATE',p+'.candidate','DEFECT requires an actionable candidate');
   }
   // A checklist cannot silently replace this specification-vs-code pass.
   // Explicit negatives are required even when no NatSpec is present.
   const rules=arr2(packet?.documentationItems).filter(x=>x.contextId===id);
   const inspected=row?.specInspection;
   if(!inspected||!['MATCH','MISMATCH','UNRESOLVED','NO_DOCUMENTED_RULES'].includes(inspected.status)||
      blank(inspected.docsAndCommentsChecked)||blank(inspected.namedConstantsChecked))
     err(errors,'SPEC_INSPECTION_REQUIRED',p+'.specInspection',
       'State comparison, checked README/docs/comments and named-constant search for this context');
   if(inspected?.status==='NO_DOCUMENTED_RULES'&&rules.length)
     err(errors,'SPEC_FALSE_ABSENCE',p+'.specInspection.status','Packet includes documented rules for this context');
   if(!Array.isArray(row?.documentedRules)){
     err(errors,'SPEC_CHECK_REQUIRED',p+'.documentedRules','Document all packet rules, even when the set is empty');
   }else{
     const expectedRules=new Map(rules.map(x=>[x.ruleId,x]));
     const reviewed=new Set();
     for(const [j,item] of row.documentedRules.entries()){
       const cp=p+'.documentedRules['+j+']';
       if(!expectedRules.has(item?.ruleId)||reviewed.has(item?.ruleId))
         err(errors,'SPEC_RULE_UNMATCHED',cp+'.ruleId','Documented rule is unknown or repeated');
       reviewed.add(item?.ruleId);
       const expected=expectedRules.get(item?.ruleId);
       if(blank(item?.rule)||!['MATCH','MISMATCH','UNRESOLVED'].includes(item?.comparison)||
         blank(item?.reason)||item.rule!==expected?.rule)
         err(errors,'SPEC_CHECK_INVALID',cp,
           'Compare exact independently documented rule text; implementation values are not specifications');
     }
     for(const id of expectedRules.keys())if(!reviewed.has(id))
       err(errors,'SPEC_RULE_MISSING',p+'.documentedRules','Not compared: '+id);
   }
   const siblings=arr2(packet?.siblingChecks).filter(x=>
     arr2(x?.members).some(m=>m.contextId===id&&m.function===x.signature));
   if(siblings.length){
     if(!Array.isArray(row?.siblingComparisons)||!row.siblingComparisons.length)
       err(errors,'SIBLING_CHECK_REQUIRED',p+'.siblingComparisons',
         'Compare the exact same-signature sibling implementation');
     else for(const group of siblings){
       // Multiple inheritors may share an identical implementation/context ID.
       const distinct=group.members.some(m=>m.contextId!==id);
       if(!row.siblingComparisons.some(entry=>entry.signature===group.signature&&
          group.members.some(m=>m.contextId===entry.siblingContextId&&
            (distinct?m.contextId!==id:m.contextId===id))&&
          !blank(entry.comparison)))
         err(errors,'SIBLING_IDENTITY_MISSING',p+'.siblingComparisons',
           distinct?'Name exact sibling signature and distinct sibling contextId':
           'Name exact shared inherited contextId and signature');
     }
   }
   if(row?.siblingComparisons!==undefined&&(!Array.isArray(row.siblingComparisons)||
       row.siblingComparisons.some(x=>blank(x?.comparison)||!x?.siblingContextId||!x?.signature)))
     err(errors,'SIBLING_CHECK_INVALID',p+'.siblingComparisons',
       'Sibling or paired-parameter checks need explicit comparison');
   if(row?.candidate!==undefined&&obj(row.candidate))validateCandidate(row.candidate,inventory,errors,p+'.candidate');
    for(const [j,c] of arr2(row?.candidates).entries())validateCandidate(c,inventory,errors,p+'.candidates['+j+']');
 }
 for(const id of primary)if(!seen.has(id)&&!covered.has(id))
   err(errors,'MISSING_CONTEXT','rows','Primary context has no correctness verdict: '+id);
 // The legacy per-class checklist is visible in the packet only as a prompt.
 // It is never accepted as a substitute for a function correctness verdict.
 // V13 candidates carry the two metadata fields required for independent
 // source/class evaluation. This never changes frozen v12 validation.
 const typed=[...arr2(submission?.candidates),...arr2(submission?.rows).flatMap(row=>[
   ...(obj(row?.candidate)?[row.candidate]:[]),...arr2(row?.candidates)
 ])];
 for(const [i,c] of typed.entries()){
   if(typeof c?.classId!=='string'||!/^[A-Z][A-Z0-9_]{2,80}$/.test(c.classId))
     err(errors,'V13_CANDIDATE_CLASS_REQUIRED','typedCandidates['+i+'].classId',
       'Source-grounded taxonomy class required for private seed evaluation');
   if(!['CRITICAL','HIGH','MEDIUM','LOW','INFO','INFORMATIONAL'].includes(c?.severity))
     err(errors,'V13_CANDIDATE_SEVERITY_REQUIRED','typedCandidates['+i+'].severity',
       'Severity is required for independent qualification');
 }

 // V13 still requires the packet's end-to-end flows and integration questions.
 // Per-function correctness verdicts do not discharge cross-contract review.
 const requiredFlows=new Set(packetIds(packet,'flows').length?
   packetIds(packet,'flows'):packetIds(packet,'flowIds'));
 const noted=new Set();
 if(submission?.flowNotes!==undefined&&!Array.isArray(submission.flowNotes))
   err(errors,'SUBMISSION_SCHEMA','flowNotes','Flow notes must be an array');
 for(const [i,note] of arr2(submission?.flowNotes).entries()){
   const p='flowNotes['+i+']',id=note?.flowId;
   if(!requiredFlows.has(id))err(errors,'FLOW_NOTE_EXTRA',p+'.flowId','Flow was not assigned to this unit');
   if(noted.has(id))err(errors,'FLOW_NOTE_DUPLICATE',p+'.flowId','Flow note repeated');
   noted.add(id);
   const count=validAnchors(note?.anchors,inventory,errors,p+'.anchors');
   if(emptyEvidence(note?.note??note?.summary??note?.description)||count===0)
     err(errors,'FLOW_NOTE_EMPTY',p,'Explain the end-to-end flow with source anchors');
 }
 for(const id of requiredFlows)if(!noted.has(id))
   err(errors,'FLOW_NOTE_MISSING','flowNotes','Missing assigned end-to-end flow '+id);

 const questions=new Set(packetIds(packet,'integrationQuestions').length?
   packetIds(packet,'integrationQuestions'):packetIds(packet,'integrationQuestionIds'));
 const answered=new Set();
 if(submission?.integrationAnswers!==undefined&&!Array.isArray(submission.integrationAnswers))
   err(errors,'SUBMISSION_SCHEMA','integrationAnswers','Integration answers must be an array');
 for(const [i,answer] of arr2(submission?.integrationAnswers).entries()){
   const p='integrationAnswers['+i+']',id=answer?.obligationId;
   if(!questions.has(id))err(errors,'QUESTION_EXTRA',p+'.obligationId','Question is not assigned');
   if(answered.has(id))err(errors,'QUESTION_DUPLICATE',p+'.obligationId','Question repeated');
   answered.add(id);
   if(!REVIEW_RESULTS.has(answer?.assessment))
     err(errors,'ASSESSMENT_UNKNOWN',p+'.assessment','Use a recognized integration assessment');
   if(emptyEvidence(answer?.reasoning))
     err(errors,'REASONING_EMPTY',p+'.reasoning','Source-specific integration reasoning required');
   if(validAnchors(answer?.anchors,inventory,errors,p+'.anchors')===0)
     err(errors,'ANCHOR_REQUIRED',p+'.anchors','Integration answer must cite source');
   if(answer?.assessment==='CONCERN'&&!obj(answer?.candidate))
     err(errors,'CONCERN_WITHOUT_CANDIDATE',p+'.candidate','Integration concern needs a candidate');
   if(obj(answer?.candidate))validateCandidate(answer.candidate,inventory,errors,p+'.candidate');
 }
 for(const id of questions)if(!answered.has(id))
   err(errors,'QUESTION_UNANSWERED','integrationAnswers','Unanswered assigned integration question '+id);

 // Upgrade, initializer and storage review is a contract-level obligation,
 // intentionally removed from individual function prompts by the packet builder.
 const requiredContracts=arr2(packet?.contractChecks);
 const observedContracts=new Set();
 if(submission?.contractChecks!==undefined&&!Array.isArray(submission.contractChecks))
   err(errors,'SUBMISSION_SCHEMA','contractChecks','Contract checks must be an array');
 for(const [i,check] of arr2(submission?.contractChecks).entries()){
   const p='contractChecks['+i+']',key=String(check?.contract)+'|'+String(check?.classId);
   if(!requiredContracts.some(x=>x.contract===check?.contract&&x.classId===check?.classId))
     err(errors,'CONTRACT_CHECK_EXTRA',p,'Check is not assigned to this unit');
   if(observedContracts.has(key))err(errors,'CONTRACT_CHECK_DUPLICATE',p,'Contract check repeated');
   observedContracts.add(key);
   if(!REVIEW_RESULTS.has(check?.assessment))
     err(errors,'ASSESSMENT_UNKNOWN',p+'.assessment','Use a recognized contract-level assessment');
   if((check?.assessment==='NOT_APPLICABLE')!==(check?.applicability==='NOT_APPLICABLE'))
     err(errors,'NA_MISMATCH',p+'.applicability','Applicability disagrees with assessment');
   if(emptyEvidence(check?.evidence))
     err(errors,'EVIDENCE_EMPTY',p+'.evidence','Source-grounded upgrade/storage evidence required');
   if(validAnchors(check?.anchors,inventory,errors,p+'.anchors')===0)
     err(errors,'ANCHOR_REQUIRED',p+'.anchors','Contract check must cite source');
   if(check?.assessment==='CONCERN'&&!obj(check?.candidate))
     err(errors,'CONCERN_WITHOUT_CANDIDATE',p+'.candidate','Concern needs a candidate');
   if(obj(check?.candidate))validateCandidate(check.candidate,inventory,errors,p+'.candidate');
 }
 for(const check of requiredContracts)
   if(!observedContracts.has(String(check.contract)+'|'+String(check.classId)))
     err(errors,'CONTRACT_CHECK_MISSING','contractChecks',
       'Missing '+check.classId+' for '+check.contract);
 for(const [i,c] of allCandidates.entries())validateCandidate(c,inventory,errors,'candidates['+i+']');
 return finish(errors,submission);
}

export function validateFlowReviewSubmissionV1({packet,submission,inventory}={}) {
 const errors=[];
 if(!checkSchema(submission,FLOW_SCHEMA)||!Array.isArray(submission?.rows)||
    (submission?.flowNotes!==undefined&&!Array.isArray(submission.flowNotes))||
    (submission?.candidates!==undefined&&!Array.isArray(submission.candidates))){
   err(errors,'SUBMISSION_SCHEMA','$','Unexpected flow-review schema or non-array fields');
   if(!obj(submission)||!Array.isArray(submission?.rows))return finish(errors,submission);
 }
 if(!packet||submission.unitId!==packet.unitId)err(errors,'UNIT_MISMATCH','unitId','Submission does not match assigned unit');
 if(packet?.reviewPolicy==='correctness-verdict-v13'){
   const v13=validateVerdictSubmissionV13({packet,submission,inventory});
   v13.errors.unshift(...errors);
   v13.ok=v13.errors.length===0;
   v13.value=v13.ok?submission:null;
   return v13;
 }
 const primary=packetIds(packet,'primaryContexts').length?packetIds(packet,'primaryContexts'):packetIds(packet,'primaryContextIds');
 const rows=Array.isArray(submission.rows)?submission.rows:[];
 const allCandidates=candidateRecords(submission);
 const repeats=new Map();
 const ctxOf=id=>arr2(packet?.primaryContexts).find(c=>c?.contextId===id);
 const assessmentErrors=(check,cp,needsClass=true)=>{
  if(emptyEvidence(check?.evidence))err(errors,'EVIDENCE_EMPTY',cp+'.evidence','Evidence is blank or generic');
  if(!REVIEW_RESULTS.has(check?.assessment))err(errors,'SUBMISSION_SCHEMA',cp+'.assessment','Unknown review assessment');
  const count=validAnchors(check?.anchors,inventory,errors,cp+'.anchors');
  if(['SUPPORTED','CONCERN','NOT_APPLICABLE'].includes(check?.assessment)&&count===0)
   err(errors,'ANCHOR_REQUIRED',cp+'.anchors','Source anchor required for the assessment');
  if(check?.assessment==='CONCERN'&&!hasCandidate(check,candidateRecords(submission,null,check)))
   err(errors,'CONCERN_WITHOUT_CANDIDATE',cp,'Concern requires a candidate');
  if(obj(check?.candidate))validateCandidate(check.candidate,inventory,errors,cp+'.candidate');
 };
 // trivialReviews: one confirmation per contract for its constants, immutables and getters.
 const trivialCovered=new Set();
 const trivial=arr2(packet?.trivialContextIds);
 for(let i=0;i<arr2(submission.trivialReviews).length;i++){
  const review=submission.trivialReviews[i],tp='trivialReviews['+i+']';
  const covered=trivial.filter(id=>ctxOf(id)?.qualifiedContainer===review?.contract);
  if(!covered.length)err(errors,'TRIVIAL_CONTRACT_UNKNOWN',tp+'.contract','No constants, immutables or getters of this contract in this unit');
  assessmentErrors(review,tp);
  covered.forEach(id=>trivialCovered.add(id));
 }
 // groupChecks: one check for several functions that share a modifier (verified from the inventory).
 const groupCovered=new Map();
 for(let i=0;i<arr2(submission.groupChecks).length;i++){
  const group=submission.groupChecks[i],gp='groupChecks['+i+']',ids=arr2(group?.contextIds);
  if(ids.length<2)err(errors,'GROUP_TOO_SMALL',gp+'.contextIds','A group check needs at least two contexts');
  for(const id of ids){
   if(!primary.includes(id))err(errors,'EXTRA_CONTEXT',gp+'.contextIds','Context is not primary in this unit: '+id);
   else if(!requiredFor(packet,id).includes(group?.classId))err(errors,'CHECK_UNKNOWN_CLASS',gp+'.classId','Class not required for '+id);
  }
  const shared=ids.map(id=>new Set(arr2(ctxOf(id)?.modifiers))).reduce((a,b)=>new Set([...a].filter(x=>b.has(x))));
  if(ids.length>=2&&!shared.size)err(errors,'GROUP_WITHOUT_SHARED_GUARD',gp+'.contextIds','Grouped contexts must share at least one modifier');
  if((group?.assessment==='NOT_APPLICABLE')!==(group?.applicability==='NOT_APPLICABLE'))
   err(errors,'NA_MISMATCH',gp+'.applicability','Applicability disagrees with assessment');
  assessmentErrors(group,gp);
  for(const id of ids){const set=groupCovered.get(id)??new Set();set.add(group?.classId);groupCovered.set(id,set);}
 }
 // contractChecks: every contract-level class assigned to this unit must be answered once.
 for(const required of arr2(packet?.contractChecks)){
  const index=arr2(submission.contractChecks).findIndex(x=>x?.contract===required.contract&&x?.classId===required.classId);
  if(index<0){err(errors,'CONTRACT_CHECK_MISSING','contractChecks','Missing '+required.classId+' for '+required.contract);continue;}
  const check=submission.contractChecks[index];
  if((check?.assessment==='NOT_APPLICABLE')!==(check?.applicability==='NOT_APPLICABLE'))
   err(errors,'NA_MISMATCH','contractChecks['+index+'].applicability','Applicability disagrees with assessment');
  assessmentErrors(check,'contractChecks['+index+']');
 }
 const expected=new Set(primary.filter(id=>!trivialCovered.has(id))),seen=new Set();
 for(let i=0;i<rows.length;i++){
  const row=rows[i],p='rows['+i+']',id=row?.contextId;
  if(!expected.has(id)&&!trivialCovered.has(id))err(errors,'EXTRA_CONTEXT',p+'.contextId','Context is not primary in this unit');
  if(seen.has(id))err(errors,'DUPLICATE_CONTEXT',p+'.contextId','Context occurs more than once');
  seen.add(id);
  if(blank(row?.summary))err(errors,'SUMMARY_EMPTY',p+'.summary','Context summary is blank');
  if(!Array.isArray(row?.checks))err(errors,'SUBMISSION_SCHEMA',p+'.checks','Checks must be an array');
  const grouped=groupCovered.get(id)??new Set();
  const checks=Array.isArray(row?.checks)?row.checks:[],required=trivialCovered.has(id)?[]:requiredFor(packet,id).filter(c=>!grouped.has(c));
  const allowed=new Set(required),observed=new Set();
  for(let j=0;j<checks.length;j++){
   const check=checks[j],cp=p+'.checks['+j+']',classId=check?.classId;
   if(grouped.has(classId))err(errors,'CHECK_DUPLICATE',cp+'.classId','Class already answered by a group check');
   else if(!allowed.has(classId)&&!trivialCovered.has(id))err(errors,'CHECK_UNKNOWN_CLASS',cp+'.classId','Class not required for this context');
   if(observed.has(classId))err(errors,'CHECK_DUPLICATE',cp+'.classId','Class checked more than once');
   observed.add(classId);
   if(emptyEvidence(check?.evidence))err(errors,'EVIDENCE_EMPTY',cp+'.evidence','Evidence is blank or generic');
   if(!REVIEW_RESULTS.has(check?.assessment))err(errors,'SUBMISSION_SCHEMA',cp+'.assessment','Unknown review assessment');
   const count=validAnchors(check?.anchors,inventory,errors,cp+'.anchors');
   if(['SUPPORTED','CONCERN','NOT_APPLICABLE'].includes(check?.assessment)&&count===0)
     err(errors,'ANCHOR_REQUIRED',cp+'.anchors','Source anchor required for the assessment');
   if((check?.assessment==='NOT_APPLICABLE')!==(check?.applicability==='NOT_APPLICABLE'))
     err(errors,'NA_MISMATCH',cp+'.applicability','Applicability disagrees with assessment');
   const candidates=candidateRecords(submission,row,check);
   if(check?.assessment==='CONCERN'&&!hasCandidate(check,candidates))
     err(errors,'CONCERN_WITHOUT_CANDIDATE',cp,'Concern requires a candidate');
   if(obj(check?.candidate))validateCandidate(check.candidate,inventory,errors,cp+'.candidate');
   const normalized=comparable(check?.evidence);
   if(normalized){
     const covered=repeats.get(normalized)??new Set();covered.add(id);repeats.set(normalized,covered);
   }
  }
  for(const requiredClass of required)if(!observed.has(requiredClass))
    err(errors,'CHECK_MISSING',p+'.checks','Missing required class '+requiredClass);
  for(let j=0;j<(Array.isArray(row?.candidates)?row.candidates:[]).length;j++)
    validateCandidate(row.candidates[j],inventory,errors,p+'.candidates['+j+']');
 }
 for(const id of expected)if(!seen.has(id))err(errors,'MISSING_CONTEXT','rows','Primary context missing: '+id);
 for(let i=0;i<(Array.isArray(submission?.candidates)?submission.candidates:[]).length;i++)
  validateCandidate(submission.candidates[i],inventory,errors,'candidates['+i+']');
 for(const [e,contexts] of repeats)if(contexts.size>3)
  err(errors,'REPEATED_EVIDENCE','rows','Identical evidence used in '+contexts.size+' different contexts: '+e.slice(0,70));
 const flows=packetIds(packet,'flows').length?packetIds(packet,'flows'):packetIds(packet,'flowIds');
 const notes=Array.isArray(submission?.flowNotes)?submission.flowNotes:[];
 for(const id of flows){
  const note=notes.find(x=>x?.flowId===id);
  if(!note)err(errors,'FLOW_NOTE_MISSING','flowNotes','Missing flow note: '+id);
  else {
   const p='flowNotes['+notes.indexOf(note)+']';
   const count=validAnchors(note.anchors,inventory,errors,p+'.anchors');
   if(blank(note.note??note.summary??note.description)||count===0)
     err(errors,'FLOW_NOTE_EMPTY',p,'Flow note must contain source-specific prose and valid anchors');
  }
 }
 return finish(errors,submission);
}
export function validateAttackSubmissionV1({packet,submission,inventory}={}) {
 const errors=[];
 if(!checkSchema(submission,ATTACK_SCHEMA)||!Array.isArray(submission?.attackPaths)||
   !Array.isArray(submission?.integrationAnswers)){
  err(errors,'SUBMISSION_SCHEMA','$','Unexpected attack schema or missing/non-array attackPaths or integrationAnswers');
  if(!obj(submission))return finish(errors,submission);
 }
 if(!packet||submission.unitId!==packet.unitId)err(errors,'UNIT_MISMATCH','unitId','Attack submission does not match its unit');
 const expected=new Set(packetIds(packet,'flows').length?packetIds(packet,'flows'):packetIds(packet,'flowIds'));
 const paths=Array.isArray(submission.attackPaths)?submission.attackPaths:[],seenPaths=new Set(),covered=new Set();
 const blocking=new Map();
 for(let i=0;i<paths.length;i++){
   const attack=paths[i],p='attackPaths['+i+']';
   const id=attack?.pathId??attack?.attackId;
   if(blank(id)||seenPaths.has(id))err(errors,'PATH_DUPLICATE_ID',p+'.pathId','Path id missing or duplicated');
   seenPaths.add(id);
   const flowIds=[...new Set([...(Array.isArray(attack?.flowIds)?attack.flowIds:[]),...(attack?.flowId?[attack.flowId]:[])])];
   for(const flowId of flowIds){
     if(!expected.has(flowId))err(errors,'UNKNOWN_FLOW',p+'.flowIds','Unassigned flow '+flowId);
     else covered.add(flowId);
   }
   if(blank(attack?.goal))err(errors,'GOAL_EMPTY',p+'.goal','Attack goal missing');
   if(!Array.isArray(attack?.steps)||attack.steps.length===0||
      attack.steps.some(x=>typeof x!=='string'||!x.trim()))
      err(errors,'STEPS_EMPTY',p+'.steps','Attack steps must be non-empty strings');
   if(!ATTACK_ROLES.has(attack?.role))err(errors,'ROLE_UNKNOWN',p+'.role','Attack role unrecognized');
   const count=validAnchors(attack?.anchors,inventory,errors,p+'.anchors');
   if(count===0)err(errors,'ANCHOR_REQUIRED',p+'.anchors','Attack path must cite source');
   if(attack?.result==='BLOCKED'){
     if(blank(attack?.blockingControl)||count===0)
       err(errors,'BLOCKING_CONTROL_MISSING',p,'Blocked path needs a named anchored control');
     else for(const f of flowIds.filter(x=>expected.has(x))){
       const value=comparable(attack.blockingControl),set=blocking.get(value)??new Set();set.add(f);blocking.set(value,set);
     }
   } else if(['VIABLE','UNCERTAIN'].includes(attack?.result)){
     if(!obj(attack?.candidate))err(errors,'CANDIDATE_REQUIRED',p+'.candidate','Viable/uncertain attack requires a candidate');
     else validateCandidate(attack.candidate,inventory,errors,p+'.candidate');
     const idea=attack?.simulationIdea??attack;
     if(!Array.isArray(idea?.transactionSequence)||!idea.transactionSequence.length||
       blank(idea?.oracle))err(errors,'SIMULATION_IDEA_REQUIRED',p+'.simulationIdea','Transaction sequence and oracle required');
   } else if(!ATTACK_RESULTS.has(attack?.result))
     err(errors,'SUBMISSION_SCHEMA',p+'.result','Unrecognized attack result');
 }
 for(const f of expected)if(!covered.has(f))err(errors,'FLOW_NOT_ATTACKED','attackPaths','No attack path covers '+f);
 for(const [value,flows] of blocking)if(flows.size>3)
   err(errors,'REPEATED_BLOCKING_CONTROL','attackPaths','Repeated blocking control across '+flows.size+' flows: '+value.slice(0,70));
 const questions=new Set(packetIds(packet,'integrationQuestions').length?
   packetIds(packet,'integrationQuestions'):packetIds(packet,'integrationQuestionIds'));
 const answered=new Set(),answers=Array.isArray(submission?.integrationAnswers)?submission.integrationAnswers:[];
 for(let i=0;i<answers.length;i++){
  const ans=answers[i],p='integrationAnswers['+i+']',id=ans?.obligationId;
  if(!questions.has(id))err(errors,'QUESTION_EXTRA',p+'.obligationId','Question not part of unit');
  if(answered.has(id))err(errors,'QUESTION_DUPLICATE',p+'.obligationId','Question answered more than once');
  answered.add(id);
  if(blank(ans?.reasoning)||emptyEvidence(ans.reasoning))
    err(errors,'REASONING_EMPTY',p+'.reasoning','Question needs specific reasoning');
  const count=validAnchors(ans?.anchors,inventory,errors,p+'.anchors');
  if(count===0)err(errors,'ANCHOR_REQUIRED',p+'.anchors','Question must cite source');
  if(ans?.assessment==='CONCERN'&&!obj(ans?.candidate))
    err(errors,'CONCERN_WITHOUT_CANDIDATE',p,'Concern answer must contain a candidate');
  if(obj(ans?.candidate))validateCandidate(ans.candidate,inventory,errors,p+'.candidate');
 }
 for(const id of questions)if(!answered.has(id))err(errors,'QUESTION_UNANSWERED','integrationAnswers','Missing question '+id);
 return finish(errors,submission);
}
export function feedbackTextV1(result,{attempt,maxAttempts,submissionPath,unitId}={}) {
 const errors=Array.isArray(result?.errors)?result.errors:[];
 const lines=['Discovery unit '+unitId+' attempt '+attempt+'/'+maxAttempts+' failed validation.'];
 for(const e of errors.slice(0,60))
  lines.push('- '+e.code+' at '+e.path+': '+e.message);
 if(errors.length>60)lines.push('- … '+(errors.length-60)+' more');
 lines.push('Repair only these items in '+submissionPath+', then push the boundary request again with attempt increased by 1.');
 return lines.join('\n');
}
