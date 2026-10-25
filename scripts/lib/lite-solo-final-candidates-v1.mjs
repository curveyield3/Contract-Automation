import path from 'node:path';
import {requiredFile,readJson} from './lite-solo-phase-work-v1.mjs';

export function unresolvedFinalCandidateFailures({root,campaignPath,directory}){
 if(directory?.mode!=='LITE_SOLO')throw new Error('lite-solo final-candidate check requires solo campaign');
 const rel=path.posix.join(campaignPath,'derived/phase-8/PHASE_08_CANONICAL_DATA_v1.json');
 const data=readJson(requiredFile(root,rel,'Phase-8 canonical candidate dispositions'));
 const candidates=data?.actions?.['step-2']?.outputs?.candidateValidations;
 if(!Array.isArray(candidates))return ['Phase-8 canonical candidate validations are missing'];
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
