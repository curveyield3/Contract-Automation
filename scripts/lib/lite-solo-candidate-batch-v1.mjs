import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validatePhase5CandidateDispositionV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {readSelectedWorkShardRecordsV13,listIndexedWorkShardCandidateKeysV13} from './lite-solo-work-shards-v1.mjs';
import {readCandidateSourceSubsetV1} from './lite-solo-candidate-source-pages-v1.mjs';

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
 let selectedBudgetBytes=0;
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
   const actualRecordBytes=Buffer.byteLength(JSON.stringify({source,row,target:target??null}));
   if(actualRecordBytes>MAX_BYTES||selectedBudgetBytes+actualRecordBytes>MAX_BYTES)
    throw new Error('actual candidate/source/target record bytes exceed the 256 KiB selected-batch budget; submit fewer records or separate the oversized source-backed entry');
   selectedBudgetBytes+=actualRecordBytes;
   selected.push({key:keyOf(source),sourceAnchor:source.sourceAnchor??source.anchors?.[0]??null,
    sourceDigest:sha(source),recordDigest:sha(row),...(target?{targetDigest:sha(target)}:{})});
  }catch(error){issues.push({candidateKey:key,reason:String(error?.message??error)});}
 }
 if(issues.length)return {status:'CANDIDATE_BATCH_REWORK',issues,accepted:0,selectedKeys:readyCandidateKeys};
 if(selectedBudgetBytes>MAX_BYTES)
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
 const byKey=new Map();
 for(const item of previous){
  // Checkpoints are authoritative only about the exact immutable source and
  // reviewer record digest accepted. Edited rows must be re-reviewed.
  try{
   const source=exactCandidate(sources,item.key);
   const row=exactRow(
    item.section==='step-5'?form.actions?.['step-5']?.outputs?.candidateProofRecords:
      phase===5?form.actions?.['step-2']?.outputs?.reconciliationRecords:
        form.actions?.['step-2']?.outputs?.targetDispositions,
    source,item.key);
   const target=phase===5?designs.find(d=>aliases(source).has(String(d.candidateKey??''))):null;
   if(sha(source)===item.sourceDigest&&sha(row)===item.recordDigest&&
      (!item.targetDigest||target&&sha(target)===item.targetDigest))
    byKey.set(item.section+':'+item.key,item);
  }catch{}
 }
 for(const item of selected)byKey.set(section+':'+item.key,{...item,section,acceptedAt:now});
 const complete=new Set([...byKey.values()].filter(i=>i.section===section).map(i=>i.key));
 const allCandidateKeys=[...new Set(sources.map(keyOf).filter(Boolean))];
 const remaining=allCandidateKeys.filter(k=>!complete.has(k));
 const checkpoint={schemaVersion:'curveyield-lite-candidate-batch-checkpoint-v1',
  campaignId:directory.campaignId,sourceSha256:directory.sourceSha256,phase,
  lastBatchAt:now,acceptedRecords:[...byKey.values()].sort((a,b)=>(a.section+':'+a.key).localeCompare(b.section+':'+b.key)),
  progress:{section,total:allCandidateKeys.length,accepted:complete.size,remaining:remaining.length,
    nextCandidateKeys:remaining.slice(0,LIMIT)},
  reviewGuarantee:'SOURCE/STRUCTURE_CHECKPOINT_ONLY__FINAL_PHASE_AND_MACHINE_EVIDENCE_VALIDATION_STILL_REQUIRED'};
 write(root,rel,checkpoint);
 return {status:'CANDIDATE_BATCH_ACCEPTED',accepted:selected.length,checkpointRel:rel,
  checkpointTotal:checkpoint.acceptedRecords.length,progress:checkpoint.progress,selectedKeys:readyCandidateKeys};
}


// Controller-generated cross-phase identity map: no new reviewer-owned schema.
// Fail on collisions so Phase 6 and 8 never join different candidates by
// position or an ambiguous matching source anchor.
export function writeCandidateIdentityIndexV1({root,campaignPath,directory,phase4Canonical,phase5Canonical,now}={}){
 const phase4=records(phase4Canonical?.actions?.['step-3']?.outputs?.candidateRecords);
 const phase5=records(phase5Canonical?.actions?.['step-2']?.outputs?.newCandidateRecords);
 const reconciliation=records(phase5Canonical?.actions?.['step-2']?.outputs?.reconciliationRecords);
 const targets=records(phase5Canonical?.actions?.['step-3']?.outputs?.targetDesigns);
 const ids=new Set(),aliasToId=new Map(),rows=[];
 for(const source of [...phase4,...phase5]){
  const key=keyOf(source),tempKey=String(source.tempKey??''),anchor=String(source.sourceAnchor??source.anchors?.[0]??'');
  if(!key||!anchor||ids.has(key))throw new Error('candidate identity index contains duplicate/missing canonical ID or source anchor: '+key);
  ids.add(key);
  for(const alias of aliases(source)){
   if(aliasToId.has(alias)&&aliasToId.get(alias)!==key)
    throw new Error('candidate alias '+alias+' resolves ambiguously to multiple canonical candidate IDs');
   aliasToId.set(alias,key);
  }
  const matched= reconciliation.filter(r=>[r.subjectKey,r.tempKey,r.canonicalId,r.candidateKey].some(v=>aliases(source).has(String(v??''))));
  if(matched.length!==1)throw new Error('Phase-5 candidate '+key+' has '+matched.length+' canonical reconciliation rows');
  rows.push({candidateKey:key,sourceTempKey:tempKey||null,sourceAnchor:anchor,
   sourceSha256:directory.sourceSha256,sourceRecordSha256:sha(source),
   phase5Disposition:matched[0].phase5ExecutionDisposition,
   phase5DispositionSha256:sha(matched[0]),
   targetCandidateKey:targets.find(t=>aliases(source).has(String(t.candidateKey??'')))?.candidateKey??null,
   obligationId:matched[0].obligationId??null});
 }
 const rel=path.posix.join(campaignPath,'controller/CANDIDATE_IDENTITY_INDEX_v1.json');
 write(root,rel,{schemaVersion:'curveyield-lite-candidate-identity-index-v1',
  campaignId:directory.campaignId,sourceSha256:directory.sourceSha256,generatedAt:now,
  sourcePhase4Canonical:path.posix.join(campaignPath,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json'),
  sourcePhase5Canonical:path.posix.join(campaignPath,'derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json'),
  rowCount:rows.length,rows:rows.sort((a,b)=>a.candidateKey.localeCompare(b.candidateKey)),
  readingGuide:'Controller-validated stable canonical IDs. Use candidateKey for Phase 6/8; sourceTempKey is a lookup alias only. Source-anchor coincidence alone never merges candidates.'});
 return rel;
}


// Source/page/shard selective check, separate from the final full-form seal.
// A checkpoint is deliberately weaker than a phase PASS: it only indicates
// a source-bound record has been reviewed and remains byte-identical.
export function acceptSelectedCandidateBatchV1({root,campaignPath,directory,indexRel,
 phase,readyCandidateKeys,reviewSection='step-2',now}={}){
 if(![5,6].includes(phase)||!Array.isArray(readyCandidateKeys)||
    readyCandidateKeys.length<1||readyCandidateKeys.length>LIMIT||
    new Set(readyCandidateKeys).size!==readyCandidateKeys.length||
    readyCandidateKeys.some(k=>typeof k!=='string'||!k||!/^[A-Za-z0-9._-]+$/.test(k)))
  throw new Error('selected candidate batch needs 1–16 unique safe keys');
 if(!['step-2',...(phase===6?['step-5']:[])].includes(reviewSection))
  throw new Error('invalid phase/section for selected candidate batch');
 const sourceSubset=readCandidateSourceSubsetV1({root,campaignPath,phase,keys:readyCandidateKeys});
 let sources=sourceSubset.records;
 // Phase-5 newly proposed candidates are still editable; unlike Phase-4
 // canonical candidates they have no sealed source-page entry until Phase 5.
 if(phase===5&&sourceSubset.missing.length){
   const newer=readSelectedWorkShardRecordsV13({root,indexRel,
     queries:sourceSubset.missing.map(key=>({lookupId:'new:'+key,step:'step-2',
      field:'newCandidateRecords',aliases:[key]}))});
   for(const key of sourceSubset.missing){
     if(newer['new:'+key])sources.push(newer['new:'+key].record);
   }
 }
 const missing=readyCandidateKeys.filter(key=>!sources.some(x=>aliases(x).has(key)));
 const issues=missing.map(key=>({candidateKey:key,reason:'Candidate absent or ambiguous in sealed predecessor and live new-candidate source shards'}));
 const queries=[];
 for(const key of readyCandidateKeys){
   const source=sources.find(x=>aliases(x).has(key));
   if(!source)continue;
   const canonical=keyOf(source),names=[...aliases(source)];
   const field=phase===5?'reconciliationRecords':
      reviewSection==='step-5'?'candidateProofRecords':'targetDispositions';
   queries.push({lookupId:'row:'+canonical,step:reviewSection,field,aliases:names});
   if(phase===5)queries.push({lookupId:'target:'+canonical,step:'step-3',field:'targetDesigns',aliases:names});
 }
 const rows=queries.length?readSelectedWorkShardRecordsV13({root,indexRel,queries}):{};
 const selected=[];let selectedBudgetBytes=0;
 const hashShard=rel=>digestFileV1(root,rel);
 for(const key of readyCandidateKeys){
   const source=sources.find(x=>aliases(x).has(key));
   if(!source)continue;
   const canonical=keyOf(source),found=rows['row:'+canonical],target=rows['target:'+canonical];
   if(!found){issues.push({candidateKey:key,reason:'Source-bound reviewer record missing from trusted work-shard index'});continue;}
   try{
     if(phase===5){
       const validation=validatePhase5CandidateDispositionV1({
         phase4CandidateRecords:[source],reconciliationRecords:[found.record],
         targetDesigns:target?[target.record]:[]
       });
       if(validation.failures.length)throw new Error(validation.failures.join('; '));
     }else{
       if(!aliases(source).has(String(found.record.candidateKey??'')))
         throw new Error('candidateKey mismatches the predecessor canonical identity');
       validatePhase6SemanticRow(found.record,reviewSection);
     }
     const bytes=Buffer.byteLength(JSON.stringify({source,row:found.record,target:target?.record??null}));
     if(selectedBudgetBytes+bytes>MAX_BYTES)throw new Error('selected actual candidate record bytes exceed 256 KiB');
     selectedBudgetBytes+=bytes;
     selected.push({key:canonical,section:reviewSection,
       sourceAnchor:source.sourceAnchor??source.anchors?.[0]??null,
       sourceDigest:sha(source),recordDigest:sha(found.record),
       recordShardRel:found.shardRel,recordShardSha256:hashShard(found.shardRel),
       ...(target?{targetDigest:sha(target.record),
         targetShardRel:target.shardRel,targetShardSha256:hashShard(target.shardRel)}:{})});
   }catch(error){issues.push({candidateKey:key,reason:String(error?.message??error)});}
 }
 if(issues.length)return {status:'CANDIDATE_BATCH_REWORK',issues,accepted:0,selectedKeys:readyCandidateKeys};
 const rel=path.posix.join(campaignPath,'controller/candidate-batches/PHASE_'+String(phase).padStart(2,'0')+'_CHECKPOINT_v1.json');
 let prior=null;try{prior=read(root,rel);}catch{}
 if(prior&&(prior.schemaVersion!=='curveyield-lite-candidate-batch-checkpoint-v1'||
    prior.campaignId!==directory.campaignId||prior.sourceSha256!==directory.sourceSha256||
    prior.phase!==phase))throw new Error('candidate checkpoint identity/source mismatch');
 const accepted=new Map();
 for(const item of records(prior?.acceptedRecords)){
   try{
     // Any edit to a containing shard invalidates the prior record, even if it
     // was an unrelated entry. This is intentionally conservative.
     if(item.recordShardRel&&item.recordShardSha256===hashShard(item.recordShardRel)&&
        (!item.targetShardRel||item.targetShardSha256===hashShard(item.targetShardRel)))
       accepted.set(item.section+':'+item.key,item);
   }catch{}
 }
 for(const item of selected)accepted.set(item.section+':'+item.key,{...item,acceptedAt:now});
 const completed=new Set([...accepted.values()].filter(x=>x.section===reviewSection).map(x=>x.key));
 const liveNewKeys=phase===5
   ?listIndexedWorkShardCandidateKeysV13({root,indexRel,step:'step-2',field:'newCandidateRecords'}):[];
 const totalKeys=[...new Set([...sourceSubset.keys,...liveNewKeys,...sources.map(keyOf)])];
 const remaining=totalKeys.filter(x=>!completed.has(x));
 const checkpoint={schemaVersion:'curveyield-lite-candidate-batch-checkpoint-v1',
   campaignId:directory.campaignId,sourceSha256:directory.sourceSha256,phase,
   sourceIndexRel:sourceSubset.indexRel,lastBatchAt:now,
   acceptedRecords:[...accepted.values()].sort((a,b)=>(a.section+':'+a.key).localeCompare(b.section+':'+b.key)),
   progress:{section:reviewSection,total:totalKeys.length,accepted:completed.size,
     remaining:remaining.length,nextCandidateKeys:remaining.slice(0,LIMIT)},
   reviewGuarantee:'SELECTED_SHARD_SOURCE_DIGEST_REVIEW_ONLY__FULL_PHASE_EVIDENCE_GATES_STILL_REQUIRED'};
 write(root,rel,checkpoint);
 return {status:'CANDIDATE_BATCH_ACCEPTED',accepted:selected.length,selectedKeys:readyCandidateKeys,
   checkpointRel:rel,checkpointTotal:checkpoint.acceptedRecords.length,progress:checkpoint.progress};
}
function digestFileV1(root,rel){
 const abs=path.join(root,...rel.split('/'));
 return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}


// Source-derived identity verifier used at full Phase-6/8 preparation and
// validation. The sidecar cannot invent candidates or map two identities to
// one: every row is checked against both sealed canonical sources and Phase-5
// reconciliation exactly once.
export function readVerifiedCandidateIdentityIndexV1({root,campaignPath}={}){
 const indexRel=path.posix.join(campaignPath,'controller/CANDIDATE_IDENTITY_INDEX_v1.json');
 const index=read(root,indexRel);
 const p4=read(root,path.posix.join(campaignPath,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json'));
 const p5=read(root,path.posix.join(campaignPath,'derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json'));
 const predecessor=read(root,path.posix.join(campaignPath,'receipts/PHASE_04_RECEIPT_v1.json'));
 if(index.schemaVersion!=='curveyield-lite-candidate-identity-index-v1'||
    !Array.isArray(index.rows)||index.sourceSha256!==predecessor.source?.sha256||
    index.campaignId!==p5.campaignId||index.campaignId!==predecessor.campaign?.campaignId)
   throw new Error('candidate identity index schema/source/campaign mismatch');
 if(index.campaignId!==p5.campaignId||index.rowCount!==index.rows.length)
   throw new Error('candidate identity index total/campaign mismatch');
 const sources=[...records(p4.actions?.['step-3']?.outputs?.candidateRecords),
    ...records(p5.actions?.['step-2']?.outputs?.newCandidateRecords)];
 const reconciliation=records(p5.actions?.['step-2']?.outputs?.reconciliationRecords);
 if(sources.length!==index.rowCount)throw new Error('candidate identity index source count changed');
 const ids=new Set(),aliasMap=new Map(),rows=new Map();
 for(const source of sources){
   const id=keyOf(source);
   if(!id||ids.has(id))throw new Error('duplicate canonical candidate '+id);
   ids.add(id);
   const matched=index.rows.filter(row=>row.candidateKey===id);
   if(matched.length!==1||matched[0].sourceRecordSha256!==sha(source)||
      matched[0].sourceAnchor!==String(source.sourceAnchor??source.anchors?.[0]??''))
     throw new Error('candidate identity row differs from sealed source '+id);
   const r=matched[0],dispositions=reconciliation.filter(x=>[x.subjectKey,x.candidateKey,x.tempKey,x.canonicalId]
      .filter(Boolean).some(alias=>aliases(source).has(String(alias))));
   if(dispositions.length!==1||sha(dispositions[0])!==r.phase5DispositionSha256||
      String(dispositions[0].phase5ExecutionDisposition??'')!==String(r.phase5Disposition??''))
     throw new Error('candidate identity disposition changed or ambiguous for '+id);
   for(const alias of aliases(source)){
     if(aliasMap.has(alias)&&aliasMap.get(alias)!==id)
       throw new Error('candidate index alias collision '+alias);
     aliasMap.set(alias,id);
   }
   rows.set(id,r);
 }
 for(const r of index.rows)if(!rows.has(r.candidateKey))
   throw new Error('candidate identity index includes unsealed row '+r.candidateKey);
 return {indexRel,rows,aliasMap,canonicalKeys:[...rows.keys()]};
}


// A lossless Phase-6 work scheduler: classification determines what evidence
// is necessary, not which source candidates can be ignored. Every Phase-4/5
// candidate remains scheduled and the final phase still proves exact coverage.
export function writePhase6ProofScheduleV1({root,campaignPath,directory,phase4Canonical,phase5Canonical,executionResults={},now}={}){
 const sources=[...records(phase4Canonical?.actions?.['step-3']?.outputs?.candidateRecords),
   ...records(phase5Canonical?.actions?.['step-2']?.outputs?.newCandidateRecords)];
 const rows=records(phase5Canonical?.actions?.['step-2']?.outputs?.reconciliationRecords);
 const outputRows=[];
 for(const source of sources){
  const key=keyOf(source),matches=rows.filter(row=>[row.subjectKey,row.candidateKey,row.tempKey,row.canonicalId]
    .filter(Boolean).some(k=>aliases(source).has(String(k))));
  if(matches.length!==1)throw new Error('Phase-6 proof scheduling needs one Phase-5 disposition for '+key);
  const disposition=matches[0],classification=String(disposition.phase5ExecutionDisposition??'').toUpperCase();
  const result=executionResults[key]??executionResults[source.tempKey]??null;
  const mode=classification==='EXECUTE'
    ?result?.rawResult?.reproduction?.status==='REPRODUCED'&&result?.rawResult?.reproduction?.observedPredicate?.matched===true
      ?'PHASE5_REPRODUCTION_VERIFY_DECISIVENESS':'PHASE6_TARGETED_ASSERTION_PROOF'
    :classification==='DUPLICATE_OF'?'VERIFY_COVERING_EXECUTION_AND_SECURITY_EQUIVALENCE'
    :['RETAIN_OPEN_OBLIGATION','CONDITIONAL_PENDING_EVIDENCE'].includes(classification)
      ?'MANDATORY_PHASE6_OBLIGATION_CLOSURE':'UNSUPPORTED_DISPOSITION_REQUIRES_CORRECTION';
  outputRows.push({candidateKey:key,sourceAnchor:source.sourceAnchor??source.anchors?.[0]??null,
    classification,mode,obligationId:disposition.obligationId??null,
    coveringCandidateKey:disposition.duplicateOfCandidateKey??null,
    phase5EvidenceRef:result?.evidenceRef??'NO_MACHINE_EVIDENCE',
    mandatory:true});
 }
 const rootRel=path.posix.join(campaignPath,'work/phase-06/PROOF_SCHEDULE_INDEX_v1.json');
 const workDir=path.posix.dirname(rootRel),pageRefs=[];
 for(let i=0;i<outputRows.length;i+=16){
  const file='PROOF_SCHEDULE_PAGE_'+String(Math.floor(i/16)+1).padStart(4,'0')+'_v1.json';
  const rel=path.posix.join(workDir,file);
  const content=jsonProofV1({schemaVersion:'curveyield-lite-phase6-proof-page-v1',
    campaignId:directory.campaignId,sourceSha256:directory.sourceSha256,
    firstRecord:i,records:outputRows.slice(i,i+16)});
  const bytes=Buffer.byteLength(content);
  if(bytes>64*1024)throw new Error('Phase-6 proof page exceeds 64 KiB; split candidate metadata');
  const abs=path.join(root,...rel.split('/'));
  fs.mkdirSync(path.dirname(abs),{recursive:true});fs.writeFileSync(abs,content);
  pageRefs.push({rel,count:Math.min(16,outputRows.length-i),bytes,sha256:createHash('sha256').update(content).digest('hex')});
 }
 const index={schemaVersion:'curveyield-lite-phase6-proof-schedule-index-v1',
   campaignId:directory.campaignId,sourceSha256:directory.sourceSha256,createdAt:now,
   totalCandidates:outputRows.length,pages:pageRefs,
   invariant:'EVERY_PREDECESSOR_CANDIDATE_REMAINS_MANDATORY__MODES_ARE_EVIDENCE_REQUIREMENTS_NOT_WAIVERS'};
 write(root,rootRel,index);
 return rootRel;
}
const jsonProofV1=x=>JSON.stringify(x,null,2)+'\n';


export function verifyPhase6ProofScheduleV1({root,campaignPath,canonicalKeys=[]}={}){
 const indexRel=path.posix.join(campaignPath,'work/phase-06/PROOF_SCHEDULE_INDEX_v1.json');
 const index=read(root,indexRel);
 if(index.schemaVersion!=='curveyield-lite-phase6-proof-schedule-index-v1'||
    !Array.isArray(index.pages)||!Number.isInteger(index.totalCandidates))
  throw new Error('Phase-6 proof schedule index invalid');
 const receipt=read(root,path.posix.join(campaignPath,'receipts/PHASE_04_RECEIPT_v1.json'));
 if(index.sourceSha256!==receipt.source?.sha256||index.campaignId!==receipt.campaign?.campaignId)
  throw new Error('Phase-6 proof schedule source identity mismatch');
 const found=[];
 for(const [i,page] of index.pages.entries()){
  const expected=path.posix.join(campaignPath,'work/phase-06',
    'PROOF_SCHEDULE_PAGE_'+String(i+1).padStart(4,'0')+'_v1.json');
  if(page.rel!==expected||page.bytes>64*1024||page.bytes<1)throw new Error('Phase-6 proof page descriptor invalid');
  const bytes=fs.readFileSync(path.join(root,...page.rel.split('/')));
  if(bytes.length!==page.bytes||createHash('sha256').update(bytes).digest('hex')!==page.sha256)
   throw new Error('Phase-6 proof page digest mismatch');
  const obj=JSON.parse(bytes.toString('utf8'));
  if(obj.schemaVersion!=='curveyield-lite-phase6-proof-page-v1'||
     obj.campaignId!==index.campaignId||obj.sourceSha256!==index.sourceSha256||
     obj.firstRecord!==i*16||!Array.isArray(obj.records)||obj.records.length!==page.count)
   throw new Error('Phase-6 proof page offset/identity mismatch');
  found.push(...obj.records.map(row=>String(row.candidateKey??'')));
 }
 if(found.length!==index.totalCandidates||new Set(found).size!==found.length)
  throw new Error('Phase-6 proof schedule has missing/duplicate candidates');
 if(canonicalKeys.length&&
   (canonicalKeys.length!==found.length||canonicalKeys.some(key=>!found.includes(key))))
  throw new Error('Phase-6 proof schedule omits a registered Phase-4/5 candidate');
 return {indexRel,total:index.totalCandidates,pages:index.pages.length};
}
