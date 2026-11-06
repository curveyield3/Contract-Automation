import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest=b=>createHash('sha256').update(b).digest('hex');
const read=(root,rel)=>JSON.parse(fs.readFileSync(path.join(root,...rel.split('/')),'utf8'));
const exists=(root,rel)=>fs.existsSync(path.join(root,...rel.split('/')));
const rel=(campaign,id,file)=>path.posix.join(campaign,'work/phase-04/discovery',id,file);

export function buildMasterDepthSpotCheckV1({root,campaignPath,campaignId,sourceSha256,segmentId}){
 const stateRel=path.posix.join(campaignPath,'work/phase-04/discovery/DISCOVERY_STATE_v1.json');
 if(!exists(root,stateRel))throw new Error('v13 master depth review requires complete discovery state');
 const state=read(root,stateRel).payload,units=[];
 for(const unitId of state.order??[]){
  const info=state.units?.[unitId];
  if(info?.role==='ATTACK')continue;
  const packetRel=rel(campaignPath,unitId,'ASSIGNMENT_PACKET_v1.json');
  if(!exists(root,packetRel))throw new Error('missing discovery unit packet '+unitId);
  const packet=read(root,packetRel).payload;
  if(packet.reviewPolicy!=='correctness-verdict-v13')throw new Error('v13 depth review cannot trust legacy checklist-only unit '+unitId);
  const submissionRel=rel(campaignPath,unitId,'ACCEPTED_SUBMISSION_v1.json');
  if(info.status!=='ACCEPTED'||!exists(root,submissionRel))
    throw new Error('v13 master review cannot skip incomplete unit '+unitId);
  const submissionBytes=fs.readFileSync(path.join(root,...submissionRel.split('/')));
  const submission=JSON.parse(submissionBytes.toString('utf8'));
  const rows=Array.isArray(submission.rows)?submission.rows:[];
  if(rows.length===0&&packet.primaryContextIds?.length)
    throw new Error('v13 master review needs explicit correctness verdict rows for '+unitId);
  const elapsed=Number.isFinite(Date.parse(info.acceptedAt))&&Number.isFinite(Date.parse(info.openedAt))
   ?Date.parse(info.acceptedAt)-Date.parse(info.openedAt):NaN;
  const elapsedPerRow=rows.length?elapsed/rows.length:Infinity;
  const fast=!Number.isFinite(elapsedPerRow)||elapsedPerRow<30000;
  const count=fast?rows.length:Math.max(1,Math.ceil(rows.length*0.1));
  const selected=[...rows].sort((a,b)=>
   digest(sourceSha256+'|'+unitId+'|'+String(a.contextId)).localeCompare(
    digest(sourceSha256+'|'+unitId+'|'+String(b.contextId)))).slice(0,count);
  units.push({unitId,submissionPath:submissionRel,submissionSha256:digest(submissionBytes),
   submittedRowCount:rows.length,elapsedPerRowSeconds:Number.isFinite(elapsedPerRow)?Math.round(elapsedPerRow/1000):null,
   samplingReason:fast?'FAST_OR_MISSING_TIMING_REJUDGE_ALL':'TEN_PERCENT_PER_UNIT',
   contexts:selected.map(row=>({contextId:row.contextId,reviewerVerdict:row.verdict,
     reviewerReasonSha256:digest(String(row.reason??''))}))});
 }
 const report={schemaVersion:'curveyield-master-depth-spotcheck-assignment-v1',campaignId,sourceSha256,
  segmentId,units};
 return {...report,assignmentSha256:digest(JSON.stringify(report))};
}

export function validateMasterDepthSpotCheckV1({root,campaignPath,assignment}){
 const failures=[];
 const base=path.posix.join(campaignPath,'work/master-review',assignment.segmentId,
  'DEPTH_SPOTCHECK_RESULTS_v1.json');
 if(!exists(root,base))return ['Master must independently rejudge required 10% and fast-unit depth sample: '+base];
 const report=read(root,base);
 if(report.schemaVersion!=='curveyield-master-depth-spotcheck-results-v1'||
  report.campaignId!==assignment.campaignId||report.sourceSha256!==assignment.sourceSha256||
  report.segmentId!==assignment.segmentId||report.assignmentSha256!==assignment.assignmentSha256)
   return ['Master depth spot-check report identity/assignment digest mismatch'];
 const reviewed=Array.isArray(report.rows)?report.rows:[];
 const keys=new Set();
 for(const item of reviewed){
  const key=String(item.unitId)+'|'+String(item.contextId);
  if(keys.has(key))failures.push('duplicate master spot-check '+key);
  keys.add(key);
  const unit=assignment.units.find(x=>x.unitId===item.unitId);
  const expected=unit?.contexts.find(x=>x.contextId===item.contextId);
  if(!expected){failures.push('extraneous master spot-check '+key);continue;}
  if(!['CORRECT','DEFECT','UNRESOLVED'].includes(item.masterVerdict)||
    typeof item.independentReason!=='string'||item.independentReason.trim().length<24||
    typeof item.sourceAnchor!=='string'||!/:[Ll][0-9]+/.test(item.sourceAnchor))
    failures.push('missing independent source-anchored correctness rejudgment '+key);
  if(item.masterVerdict==='UNRESOLVED'&&(!item.decidingTest?.name||!item.decidingTest?.expectedObservation))
    failures.push('unresolved master spot-check lacks decisive test '+key);
  if(item.masterVerdict==='DEFECT'&&!item.candidateKey)
    failures.push('master defect lacks actionable candidate '+key);
  if(item.masterVerdict!==expected.reviewerVerdict&&item.masterVerdict!=='UNRESOLVED'&&!item.candidateKey)
    failures.push('changed master verdict requires candidate/amendment '+key);
 }
 for(const unit of assignment.units)for(const context of unit.contexts)
  if(!keys.has(unit.unitId+'|'+context.contextId))
    failures.push('master depth sample not independently reviewed '+unit.unitId+' '+context.contextId);
 return failures;
}
