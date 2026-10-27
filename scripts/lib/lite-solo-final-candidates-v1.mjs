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
