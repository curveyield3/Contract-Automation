import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validatePhase5CandidateDispositionV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';

// Candidate-batch checkpoints are validation-only. They never replace a phase
// boundary, authorize tests, or act as security disposition evidence.
const LIMIT=16,MAX_BYTES=256*1024;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const records=x=>Array.isArray(x)?x.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)):[];
const keyOf=x=>String(x?.canonicalId??x?.tempKey??x?.candidateKey??'').trim();
const aliases=x=>new Set([x?.canonicalId,x?.tempKey,x?.candidateKey,keyOf(x)].filter(Boolean).map(String));
const read=(root,rel)=>JSON.parse(fs.readFileSync(path.join(root,...rel.split('/')),'utf8'));
const write=(root,rel,value)=>{
 const abs=path.join(root,...rel.split('/'));
 fs.mkdirSync(path.dirname(abs),{recursive:true});
 fs.writeFileSync(abs,JSON.stringify(value,null,2)+'\n');
};
const text=v=>typeof v==='string'&&v.trim().length>=12&&!v.trim().startsWith('<');
function phase5Sources(root,campaignPath,form){
 const p4=read(root,path.posix.join(campaignPath,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json'));
 return [
  ...records(p4.actions?.['step-3']?.outputs?.candidateRecords),
  ...records(form.actions?.['step-2']?.outputs?.newCandidateRecords)
 ];
}
function exactCandidate(candidates,key){
 const found=candidates.filter(x=>aliases(x).has(key));
 if(found.length!==1)throw new Error('candidate '+key+' has '+found.length+' source matches; require exactly one immutable identity');
 return found[0];
}
function exactRow(rows,identity,key){
 const found=records(rows).filter(x=>[x.subjectKey,x.tempKey,x.canonicalId,x.candidateKey].filter(Boolean).some(v=>aliases(identity).has(String(v))));
 if(found.length!==1)throw new Error('candidate '+key+' has '+found.length+' matching editable rows; require exactly one');
 return found[0];
}
function validatePhase6SemanticRow(row,section){
 const required=section==='step-2'
  ?['candidateKey','executionEvidenceRefs','oracleOutcome','reproductionStatus','securityInterpretation','limitations','recommendedPhase8Disposition','requestBindingStatus','requestBindingEvidenceRef','semanticHarnessBindingAssessment']
  :['candidateKey','sourceAnchor','phase5Result','requestDirectory','verdict','harnessDesign','dispatchRounds','requestPaths','ledgerRef','attackAssertionNames','controlAssertionNames','reasoning'];
 for(const field of required){
  const value=row[field];
  if(value===undefined||value===null||typeof value==='string'&&(!value.trim()||value.startsWith('<'))||
     Array.isArray(value)&&value.length===0)
    throw new Error('Phase 6 '+section+' candidate '+String(row.candidateKey)+' incomplete '+field);
 }
 if(section==='step-5'&&!['CONFIRMED','DISPROVEN','INCONCLUSIVE','PHASE5_DECISIVE'].includes(row.verdict))
  throw new Error('Phase 6 candidate '+row.candidateKey+' has unsupported proof verdict');
 if(!text(row.reasoning??row.securityInterpretation))
  throw new Error('Phase 6 candidate '+row.candidateKey+' requires a concrete security interpretation');
}

// Selected complete records can be independently checked in constant-size
// batches. The final phase still revalidates all source/evidence/shard gates.
export function acceptCandidateBatchV1({
 root,campaignPath,directory,form,phase,readyCandidateKeys,reviewSection,now
}={}){
 if(![5,6].includes(phase))throw new Error('candidate batches are supported only in Lite-Solo Phases 5/6');
 if(!Array.isArray(readyCandidateKeys)||readyCandidateKeys.length<1||readyCandidateKeys.length>LIMIT||
    readyCandidateKeys.some(k=>typeof k!=='string'||!k||!/^[A-Za-z0-9._-]+$/.test(k))||
    new Set(readyCandidateKeys).size!==readyCandidateKeys.length)
  throw new Error('candidate batch must name 1-16 unique safe candidate identifiers');
 const section=reviewSection??'step-2';
 if(!['step-2',...(phase===6?['step-5']:[])].includes(section))
  throw new Error('invalid candidate batch review section');
 const sources=phase===5?phase5Sources(root,campaignPath,form):
   phase5Sources(root,campaignPath,read(root,path.posix.join(campaignPath,'derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json')));
 const rows=section==='step-5'?form.actions?.['step-5']?.outputs?.candidateProofRecords:
   phase===5?form.actions?.['step-2']?.outputs?.reconciliationRecords:
     form.actions?.['step-2']?.outputs?.targetDispositions;
 const designs=phase===5?records(form.actions?.['step-3']?.outputs?.targetDesigns):[];
 const selected=[],issues=[];
 for(const key of readyCandidateKeys){
  try{
   const source=exactCandidate(sources,key);
   const row=exactRow(rows,source,key);
   const target=designs.find(d=>aliases(source).has(String(d.candidateKey??'')));
   if(phase===5){
    const validation=validatePhase5CandidateDispositionV1({
     phase4CandidateRecords:[source],reconciliationRecords:[row],
     targetDesigns:target?[target]:[]
    });
    if(validation.failures.length)throw new Error(validation.failures.join('; '));
   }else{
    if(!aliases(source).has(String(row.candidateKey??'')))
     throw new Error('candidate row does not bind to a canonical/source candidate');
    validatePhase6SemanticRow(row,section);
   }
   selected.push({key:keyOf(source),sourceAnchor:source.sourceAnchor??source.anchors?.[0]??null,
    sourceDigest:sha(source),recordDigest:sha(row),...(target?{targetDigest:sha(target)}:{})});
  }catch(error){issues.push({candidateKey:key,reason:String(error?.message??error)});}
 }
 if(issues.length)return {status:'CANDIDATE_BATCH_REWORK',issues,accepted:0,selectedKeys:readyCandidateKeys};
 if(Buffer.byteLength(JSON.stringify(selected))>MAX_BYTES)
  return {status:'CANDIDATE_BATCH_REWORK',issues:[{reason:'selected candidate batch exceeds 256 KiB budget; submit fewer candidates'}],accepted:0};
 const rel=path.posix.join(campaignPath,'controller/candidate-batches/PHASE_'+String(phase).padStart(2,'0')+'_CHECKPOINT_v1.json');
 let prior=null;
 try{prior=read(root,rel);}catch{}
 if(prior&&(
    prior.campaignId!==directory.campaignId||
    prior.sourceSha256!==directory.sourceSha256||
    prior.schemaVersion!=='curveyield-lite-candidate-batch-checkpoint-v1'))
  throw new Error('candidate batch checkpoint identity/source mismatch');
 const previous=records(prior?.acceptedRecords);
 const byKey=new Map(previous.map(item=>[item.section+':'+item.key,item]));
 for(const item of selected)byKey.set(section+':'+item.key,{...item,section,acceptedAt:now});
 const checkpoint={schemaVersion:'curveyield-lite-candidate-batch-checkpoint-v1',
  campaignId:directory.campaignId,sourceSha256:directory.sourceSha256,phase,
  lastBatchAt:now,acceptedRecords:[...byKey.values()].sort((a,b)=>(a.section+':'+a.key).localeCompare(b.section+':'+b.key)),
  reviewGuarantee:'SOURCE/STRUCTURE_CHECKPOINT_ONLY__FINAL_PHASE_AND_MACHINE_EVIDENCE_VALIDATION_STILL_REQUIRED'};
 write(root,rel,checkpoint);
 return {status:'CANDIDATE_BATCH_ACCEPTED',accepted:selected.length,checkpointRel:rel,
  checkpointTotal:checkpoint.acceptedRecords.length,selectedKeys:readyCandidateKeys};
}
