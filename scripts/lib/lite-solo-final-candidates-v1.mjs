import fs from 'node:fs';
import path from 'node:path';
import {requiredFile,readJson} from './lite-solo-phase-work-v1.mjs';

export function unresolvedFinalCandidateFailures({root,campaignPath,directory}){
 if(directory?.mode!=='LITE_SOLO')throw new Error('lite-solo final-candidate check requires solo campaign');
 const rel=path.posix.join(campaignPath,'derived/phase-8/PHASE_08_CANONICAL_DATA_v1.json');
 const data=readJson(requiredFile(root,rel,'Phase-8 canonical candidate dispositions'));
 const candidates=data?.actions?.['step-2']?.outputs?.candidateValidations;
 if(!Array.isArray(candidates))return ['Phase-8 canonical candidate validations are missing'];
 // A Phase-8 controller-accepted no-candidate sentinel is not an unresolved
 // candidate. Admit it only with the matching sealed Phase-8 receipt, explicit
 // no-findings/no-groups sentinels, and zero source-bound Phase-6 candidates.
 if(candidates.length===1&&candidates[0]==='NONE_IDENTIFIED'){
  const receipt=readJson(requiredFile(root,path.posix.join(campaignPath,'receipts/PHASE_08_RECEIPT_v1.json'),'sealed Phase-8 candidate receipt'));
  const groups=data?.actions?.['step-1']?.outputs?.candidateGroups;
  const findings=data?.actions?.['step-2']?.outputs?.validatedFindings;
  const phase6=readJson(requiredFile(root,path.posix.join(campaignPath,'derived/phase-6/PHASE_06_CANONICAL_DATA_v1.json'),'sealed Phase-6 source candidates'));
  const p6=phase6?.actions??{};
  const negatives=rows=>Array.isArray(rows)&&rows.length===1&&rows[0]==='NONE_IDENTIFIED';
  const baseline=(p6['step-4']?.outputs?.baselineTestRecords??[])
    .flatMap(row=>Array.isArray(row?.obligationOutcomes)?row.obligationOutcomes:[]);
  if(receipt?.phase?.sequence===8&&receipt.phase.status==='SEALED'
    &&receipt?.validation?.status==='PASS'&&negatives(groups)&&negatives(findings)
    &&negatives(p6['step-5']?.outputs?.candidateProofRecords)
    &&negatives(p6['step-5']?.outputs?.newCandidateRecords)
    &&baseline.every(row=>row?.outcome!=='PROPERTY_FAILED'))return [];
  return ['Phase-8 no-candidate sentinel is not backed by sealed candidate and property evidence'];
 }
 const failures=[],ids=new Set();
 for(const c of candidates){
  if(!c||typeof c!=='object'){failures.push('Malformed Phase-8 candidate validation');continue;}
  const id=String(c.candidateKey??'');
  if(!id||ids.has(id))failures.push('Missing or duplicate Phase-8 candidate ID '+id);
  ids.add(id);
  if(c.findingPromotion==='PROMOTE_FINDING')continue;
  if([c.finalDisposition,c.outcome,c.propertyViolation,c.impact].some(v=>/UNCONFIRM|NOT_ESTABLISHED|NOT_DISPROVEN|INCONCLUSIVE|UNRESOLVED|UNKNOWN|UNQUANTIFIED|INSUFFICIENT_EVIDENCE/i.test(String(v??''))))
   failures.push('Candidate '+id+' retains unresolved property, reachability, impact or outcome. Produce decisive authorized evidence or preserve it as an appropriately substantiated finding; lite-solo cannot claim COMPLETE.');
 }
 return failures;
}


// Terminal security assurance cannot be marked COMPLETE while mandatory
// material obligations remain due or when accepted post-seal execution has not
// been reconciled into the controller's authoritative coverage assessment.
// No mutation of old receipts or frozen source is performed here.
export function unresolvedTerminalAssuranceFailures({root,campaignPath,directory,currentForm=null}={}){
 if(directory?.mode!=='LITE_SOLO')throw new Error('terminal assurance requires Lite-Solo campaign');
 const readRel=(rel)=>readJson(requiredFile(root,path.posix.join(campaignPath,rel),rel));
 const failures=[];
 const ledger=readRel('controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json');
 for(const entry of ledger?.obligations??[]){
  if(entry?.mandatory!==true)continue;
  const requiredPhase=Number(entry.requiredPhase);
  if(!Number.isInteger(requiredPhase)||requiredPhase>10)continue;
  const status=String(entry.status??'OPEN').toUpperCase();
  if(!['OPEN','IN_PROGRESS','BLOCKED_CARRIED'].includes(status))continue;
  const id=String(entry.obligationId??'UNKNOWN_OBLIGATION');
  const currentDispositions=Object.values(currentForm?.actions??{}).flatMap(action=>
   (action?.outputs?.obligationDispositions??[]).filter(row=>row&&typeof row==='object'));
  const disposition=currentDispositions.find(row=>row.obligationId===id);
  // At the Phase-10 intake boundary, an obligation may be closed by the
  // CURRENT validated form. No prior OPEN status can be treated as its
  // terminal state; the controller rechecks the materialized ledger after sync.
  const evidence=disposition?.evidenceRefs;
  const hasEvidence=Array.isArray(evidence)
   ?evidence.length>0&&evidence.some(x=>typeof x==='string'&&x.trim()&&!x.startsWith('<'))
   :typeof evidence==='string'&&evidence.trim()&&!evidence.startsWith('<');
  const rationale=String(disposition?.rationale??'');
  if(currentForm&&['SATISFIED','NOT_APPLICABLE'].includes(String(disposition?.disposition))&&
   hasEvidence&&rationale.trim()&&!rationale.startsWith('<'))continue;
  failures.push('Mandatory security obligation '+id+' remains '+status+
   ' at terminal Phase 10; satisfy with decisive source-bound evidence, or use an authorized controller-scoped disposition. A narrative limitation does not satisfy it.');
 }
 // Scan only controller-owned ingested proof receipts, not agent-written paths.
 const base=path.join(root,campaignPath,'controller','phase8-revalidation');
 const accepted=[];
 if(fs.existsSync(base)){
  for(const group of fs.readdirSync(base,{withFileTypes:true})){
   if(!group.isDirectory()||!/^(?:TG-[0-9]{3}|CP-[A-Za-z0-9._-]+)$/.test(group.name))continue;
   const dir=path.join(base,group.name);
   for(const filename of fs.readdirSync(dir)){
    if(!/^CONTROLLER_[A-Za-z0-9_-]*EVIDENCE_INGEST_RECEIPT_[A-Za-z0-9_-]+\.json$/.test(filename))continue;
    const record=readJson(path.join(dir,filename));
    if(record?.campaignId!==directory.campaignId||record?.sourceSha256!==directory.sourceSha256)
     throw new Error('controller proof receipt has contradictory campaign source identity: '+filename);
    if(record?.status==='EVIDENCE_ACCEPTED_FOR_PHASE8_VALIDATION'&&Array.isArray(record.acceptedObligations))
     accepted.push(...record.acceptedObligations);
   }
  }
 }
 if(accepted.length){
  const coverage=readRel('work/phase-10/COVERAGE_MATRIX_v1.json');
  const post=coverage?.postSealAcceptedEvidence;
  const expected=[...new Set(accepted)].sort();
  if(post?.status!=='CONTROLLER_ACCEPTED_BOUNDED_EXECUTION'
     ||JSON.stringify(post.acceptedObligationIds)!==JSON.stringify(expected)
     ||!Number.isInteger(post.acceptedAssertionCount)||post.acceptedAssertionCount<expected.length)
   failures.push('Controller accepted '+expected.length+
    ' post-seal baseline checks, but their actual bounded machine assertions are missing from the authoritative coverage evidence overlay. Reconcile before Phase-10 terminal completion; do not promote unverified individual contexts to PASSED.');
 }
 return failures;
}
