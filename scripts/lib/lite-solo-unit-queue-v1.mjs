import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {repoFile,readJson,writeJson,loadPhaseSchema,validateWorkForm,requiredFile,attachOriginalCanonicalEvidenceRefsV1} from './lite-solo-phase-work-v1.mjs';
import {validateFlowReviewSubmissionV1,validateAttackSubmissionV1} from '../../packages/github-native-sim/src/adr-discovery-validators-v1.mjs';
import {reviewInventoryRelV1} from '../../packages/github-native-sim/src/adr-review-inventory-v1.mjs';
import {buildUnitPacketV1,writeUnitPacketIndexV1,buildDiscoverySummaryV1,readUnitPacketV1} from '../../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';
import {loadTaxonomyV1} from '../../packages/github-native-sim/src/adr-taxonomy-v1.mjs';
import {deriveBaselineObligationsV1} from '../../packages/github-native-sim/src/adr-baseline-obligations-v1.mjs';
import {applyPhaseBoundaryPrefill,resolveTargetExecutionRequestRef,refreshControllerPrefillDigest} from './lite-solo-phase-prefill-v1.mjs';
import {validateTargetExecutionRequestBindingV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {validateLiveForkBaselineRecordV1} from './lite-solo-live-fork-baseline-gate-v1.mjs';
import {materializeSemanticWorkFormV13,secureShardWorkFormV13} from './lite-solo-work-shards-v1.mjs';
import {planSemanticBatchesV1,SEMANTIC_BATCH_READING_GUIDE_V1} from './lite-solo-semantic-batches-v1.mjs';

export const UNIT_POLICY=Object.freeze({issueBatchDefault:50,issueBatchMax:50,approvalBatchMax:50,maxParallelWorkers:null});
export const REQUEST_SCHEMA='curveyield-lite-solo-unit-batch-request-v1';
// Public queue/packet contracts: one authoritative definition, not copied workflow limits.
export const UNIT_QUEUE_STATUSES=Object.freeze(['BLOCKED_DEPENDENCY','AVAILABLE','CLAIMED',
 'SUBMITTED','ACCEPTED','REWORK_REQUIRED','RELEASED']);
export const UNIT_ARTIFACT_SCHEMAS=Object.freeze({
 queue:'curveyield-lite-solo-unit-queue-state-v1',
 plan:'curveyield-lite-solo-unit-plan-v1',
 planPage:'curveyield-lite-solo-unit-plan-page-v1',
 packetIndex:'curveyield-discovery-packet-section-index-v1',
 batchIndex:'curveyield-lite-solo-unit-batch-index-v1',
 batchPage:'curveyield-lite-solo-unit-batch-page-v1',
 submission:'curveyield-lite-solo-unit-submission-v1',
 accepted:'curveyield-lite-solo-accepted-unit-v1',
 result:'curveyield-lite-solo-unit-controller-result-v1'
});
const hex=b=>createHash('sha256').update(b).digest('hex');
const pretty=x=>JSON.stringify(x,null,2)+'\n';
const sha=x=>hex(Buffer.from(pretty(x)));
const read=(root,rel)=>readJson(requiredFile(root,rel));
const maybe=(root,rel)=>fs.existsSync(repoFile(root,rel))?readJson(repoFile(root,rel)):null;
const put=(root,rel,value)=>writeJson(repoFile(root,rel),value);
const safe=s=>typeof s==='string'&&/^[A-Za-z0-9._-]{1,140}$/.test(s)&&!s.startsWith('.');
const dot=(tokens)=>tokens.join('.');
const section=(form,tokens)=>tokens.reduce((obj,key)=>obj?.[key],form);
const rootOf=(campaign,phase)=>path.posix.join(campaign,'work/phase-'+String(phase).padStart(2,'0')+'/units');
const queueRel=(campaign,phase)=>path.posix.join(rootOf(campaign,phase),'UNIT_QUEUE_STATE_v1.json');
const planRel=(campaign,phase)=>path.posix.join(rootOf(campaign,phase),'UNIT_PLAN_INDEX_v1.json');
const unitBase=(campaign,phase,id)=>path.posix.join(rootOf(campaign,phase),id);
// Restore exact current and historical investigative question identities from
// immutable CP/index-page sources. Legacy full question indexes stay read-only.
function hydratePagedQuestionIndexV1(root,index,indexPath){
 if(!index?.historyTail)return index;
 if(index.indexLayout!=='PAGED_IMMUTABLE_CHAIN_V1'||
    !indexPath.endsWith('/questions/QUESTION_INDEX_v1.json'))
  throw Error('Unknown immutable question head layout');
 const prefix=indexPath.slice(0,-'QUESTION_INDEX_v1.json'.length);
 const bound={campaignId:index.campaignId,
  campaignGenerationId:index.campaignGenerationId,
  sourceSha256:index.sourceSha256,authorityDigest:index.authorityDigest,
  phaseSequence:index.phaseSequence,phaseEpoch:index.phaseEpoch,
  unitId:index.unitId,packetSha256:index.packetSha256};
 const pages=[],seen=new Set();let pointer=index.historyTail;
 while(pointer){
  if(typeof pointer.path!=='string'||
     !pointer.path.startsWith(prefix+'index-pages/')||
     !/^INDEX_PAGE_[0-9]{6,}_[0-9]{4}_v1\.json$/.test(
      pointer.path.slice((prefix+'index-pages/').length))||
     !/^[a-f0-9]{64}$/.test(String(pointer.sha256??''))||
     seen.has(pointer.path))
   throw Error('Question page path or immutable reference invalid');
  seen.add(pointer.path);
  const raw=fs.readFileSync(repoFile(root,pointer.path));
  if(hex(raw)!==pointer.sha256)
   throw Error('Committed question page SHA-256 mismatch');
  const page=JSON.parse(raw.toString('utf8'));
  if(page.schemaVersion!=='curveyield-ai-question-index-page-v1'||
     Object.entries(bound).some(([k,v])=>page[k]!==v)||
     page.publishRevision!==pointer.publishRevision||page.part!==pointer.part||
     page.questionOrdinalStart!==pointer.questionOrdinalStart||
     page.questionOrdinalEnd!==pointer.questionOrdinalEnd||
     page.checkpointRevisionStart!==pointer.checkpointRevisionStart||
     page.checkpointRevisionEnd!==pointer.checkpointRevisionEnd||
     !Array.isArray(page.questionAdds)||!Array.isArray(page.answerUpdates)||
     !Array.isArray(page.checkpointRefs))
   throw Error('Committed question page identity mismatch');
  pages.push({page,pointer});pointer=page.previous;
 }
 const questions=[],checkpoints=[],known=new Map(),
  _questionPageSources={},_answerPageSources={};
 for(const {page,pointer} of pages.reverse()){
  for(const [ordinal,q] of page.questionAdds.entries()){
   if(!q||typeof q.questionId!=='string'||known.has(q.questionId))
    throw Error('Duplicate immutable question row');
   const record=structuredClone(q);
   questions.push(record);known.set(record.questionId,record);
   _questionPageSources[record.questionId]={path:pointer.path,
    sha256:pointer.sha256,selector:'questionAdds['+ordinal+'].questionText'};
  }
  for(const [ordinal,u] of page.answerUpdates.entries()){
   const q=known.get(u.questionId);
   if(!q||!Number.isSafeInteger(u.answerCheckpoint)||u.answerCheckpoint<1)
    throw Error('Unissued question in immutable answer page');
   q.answered=true;q.answerCheckpoint=u.answerCheckpoint;
   _answerPageSources[q.questionId]={path:pointer.path,
    sha256:pointer.sha256,selector:'answerUpdates['+ordinal+'].answerCheckpoint'};
  }
  checkpoints.push(...page.checkpointRefs);
 }
 if(questions.length!==index.questionCount||
    questions.filter(q=>q.answered).length!==index.answeredCount||
    checkpoints.length!==index.revision||
    index.nextUnanswered&&
     !questions.some(q=>!q.answered&&q.questionId===index.nextUnanswered.questionId))
  throw Error('Question page history differs from head counters or cursor');
 return {...index,questions,checkpoints,_questionPageSources,_answerPageSources};
}

// Question checkpoints are immutable Audit-Controller GitHub records. The
// index is optional evidence metadata, NEVER a unit/phase acceptance gate.
// Always retain its deterministic path and source-bound lookup identity, even
// before the Worker publishes the first checkpoint.
function questionLedgerReferenceV1({root,campaign,phase,unitId,directory,phaseEpoch,packetSha256}){
 const indexPath=path.posix.join(unitBase(campaign,phase,unitId),
  'questions/QUESTION_INDEX_v1.json');
 const bound={campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,
  sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
  phaseSequence:phase,phaseEpoch,unitId,packetSha256};
 const reference={availability:'NOT_PUBLISHED',indexPath,indexSha256:null,
  revision:null,questionCount:null,answeredCount:null,ledgerStatus:null,
  status:null,checkpointCount:null,...bound};
 if(!Number.isSafeInteger(phaseEpoch)||phaseEpoch<1||
    !/^[a-f0-9]{64}$/.test(String(packetSha256??'')))
  return {...reference,availability:'IDENTITY_UNAVAILABLE'};
 try{
  const file=repoFile(root,indexPath);
  if(!fs.existsSync(file))return reference;
  const raw=fs.readFileSync(file),index=hydratePagedQuestionIndexV1(root,JSON.parse(raw.toString('utf8')),indexPath);
  if(!index||index.schemaVersion!=='curveyield-ai-question-index-v1'||
     Object.entries(bound).some(([k,value])=>index[k]!==value))
   return {...reference,availability:'IDENTITY_MISMATCH'};
  if(!Number.isSafeInteger(index.revision)||index.revision<1||
     !Number.isSafeInteger(index.questionCount)||index.questionCount<0||
     !Number.isSafeInteger(index.answeredCount)||index.answeredCount<0||
     !['ACTIVE','COMPLETE'].includes(index.status)||!Array.isArray(index.questions)||
     !Array.isArray(index.checkpoints)||
     index.questionCount!==index.questions.length||
     index.answeredCount>index.questionCount||
     index.checkpoints.some(ref=>!ref||typeof ref.path!=='string'||
      !ref.path.startsWith(path.posix.dirname(indexPath)+'/checkpoints/')||
      !/^[a-f0-9]{64}$/.test(String(ref.sha256??''))))
   return {...reference,availability:'UNREADABLE'};
  return {...reference,availability:'AVAILABLE',indexSha256:hex(raw),
   revision:index.revision,questionCount:index.questionCount,
   answeredCount:index.answeredCount,ledgerStatus:index.status,
   status:index.status,checkpointCount:index.checkpoints.length};
 }catch{return {...reference,availability:'UNREADABLE'};}
}

// Recover the current committed index independently of the historical accepted
// snapshot's optional reference. The snapshot and queue are READ ONLY here.
// This is used when issuing a LATER assignment; it never rewrites ACCEPTED work.
export function recoverAcceptedQuestionLedgerReferenceV1({
 root,campaignPath,phase,unitId,directory,queue,plan
}){
 const indexPath=path.posix.join(unitBase(campaignPath,phase,unitId),
  'questions/QUESTION_INDEX_v1.json');
 const unavailable={availability:'ACCEPTED_REFERENCE_UNAVAILABLE',indexPath,
  unitId,phaseSequence:phase};
 const unit=plan?.units?.find(row=>row.unitId===unitId);
 const state=queue?.units?.[unitId];
 const expectedPrefix=unitBase(campaignPath,phase,unitId)+'/';
 if(!unit||state?.status!=='ACCEPTED'||typeof state.acceptedPath!=='string'||
    !state.acceptedPath.startsWith(expectedPrefix))
  return unavailable;
 let accepted;
 try{accepted=read(root,state.acceptedPath);}
 catch{return {...unavailable,availability:'ACCEPTED_SNAPSHOT_UNAVAILABLE'};}
 // Original packet hash and phase epoch MUST come from the accepted snapshot,
 // never from a subsequently reassembled shard or an unbound prose reference.
 if(accepted?.unitId!==unitId||
    accepted.campaignGenerationId!==directory.campaignGenerationId||
    accepted.sourceSha256!==directory.sourceSha256||
    accepted.authorityDigest!==directory.authorityDigest||
    accepted.phaseSequence!==phase||
    accepted.phaseEpoch!==plan.phaseEpoch||
    accepted.unitSpecRevision!==unit.unitSpecRevision||
    accepted.submissionSha256!==state.acceptedSha256)
  return unavailable;
 const live=questionLedgerReferenceV1({root,campaign:campaignPath,phase,unitId,
  directory,phaseEpoch:accepted.phaseEpoch,packetSha256:accepted.packetSha256});
 if(live.availability==='AVAILABLE')
  return {...live,referenceOrigin:'CURRENT_COMMITTED_INDEX'};
 // Historical accepted units may predate the explicit availability field.
 // Their original questionLedger was already checked against the source-bound
 // question index at acceptance. Keep its immutable hash discoverable even
 // when the CURRENT branch no longer exposes that index, but do not treat it
 // as newly retrieved content or rewrite the original accepted snapshot.
 const earlier=accepted.questionLedger;
 const legacy=earlier&&earlier.availability===undefined;
 const current=earlier?.availability==='AVAILABLE'&&
    earlier.campaignId===directory.campaignId&&
    earlier.campaignGenerationId===directory.campaignGenerationId&&
    earlier.sourceSha256===directory.sourceSha256&&
    earlier.authorityDigest===directory.authorityDigest&&
    earlier.phaseSequence===phase&&earlier.phaseEpoch===accepted.phaseEpoch&&
    earlier.unitId===unitId&&earlier.packetSha256===accepted.packetSha256;
 if((legacy||current)&&earlier.indexPath===indexPath&&
    /^[a-f0-9]{64}$/.test(String(earlier.indexSha256??'')))
  return {...live,previousCommittedIndex:{indexPath,
   indexSha256:earlier.indexSha256,revision:earlier.revision,
   questionCount:earlier.questionCount,answeredCount:earlier.answeredCount,
   ledgerStatus:earlier.ledgerStatus??earlier.status??null,
   referenceOrigin:'IMMUTABLE_ACCEPTED_SNAPSHOT'}};
 return live;
}
// Publish a provenance-only roster from the ORIGINAL accepted-unit snapshots.
// The same function serves canonical phase packaging and later assignment
// recovery. No text is classified, merged or interpreted and missing histories
// never affect unit acceptance or phase eligibility.
export function collectAcceptedQuestionHistoryRefsV1({
 root,campaignPath,directory,phase
}){
 const roster={schemaVersion:'curveyield-ai-question-history-roster-v1',
  campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,
  sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
  phaseSequence:phase,histories:[],unavailable:{}};
 if(![4,5,6].includes(phase))return roster;
 let queue;
 try{queue=maybe(root,queueRel(campaignPath,phase));}
 catch{return {...roster,availability:'QUEUE_UNREADABLE'};}
 if(!queue)return {...roster,availability:'QUEUE_NOT_PUBLISHED'};
 let plan;
 try{plan=readPlan(root,campaignPath,phase);}
 catch{return {...roster,availability:'PLAN_NOT_READABLE'};}
 if(queue.campaignId!==directory.campaignId||
    queue.campaignGenerationId!==directory.campaignGenerationId||
    queue.sourceSha256!==directory.sourceSha256||
    queue.authorityDigest!==directory.authorityDigest||
    queue.phaseSequence!==phase||queue.phaseEpoch!==plan.phaseEpoch)
  return {...roster,availability:'IDENTITY_MISMATCH'};
 const accepted=(Array.isArray(plan.units)?plan.units:[]).map(u=>u?.unitId)
  .filter(id=>typeof id==='string'&&queue.units?.[id]?.status==='ACCEPTED').sort();
 for(const unitId of accepted){
  // Optional provenance extraction must never veto otherwise accepted work.
  // Distinguish unreadable history from a negative security finding.
  let ref;
  try{ref=recoverAcceptedQuestionLedgerReferenceV1({
    root,campaignPath,phase,unitId,directory,queue,plan});}
  catch{ref={availability:'UNREADABLE',phaseSequence:phase,unitId,
    indexPath:path.posix.join(campaignPath,'work/phase-'+String(phase).padStart(2,'0'),
      'units',unitId,'questions/QUESTION_INDEX_v1.json')};}
  roster.histories.push(ref);
  if(ref.availability!=='AVAILABLE')
   (roster.unavailable[ref.availability]??=[]).push(unitId);
 }
 roster.acceptedUnitCount=accepted.length;
 roster.availability='COLLECTED_NONBLOCKING';
 return roster;
}
// GitHub-only original answer proof. Preserve all original bytes, verify each
// bound UTF-8 content page and the full SHA before publishing canonical links.
function verifiedSegmentedAnswerSourceV1(root,ref,index,question){
 const base=path.posix.dirname(index.questionIndexPath)+'/answers/';
 if(!ref||typeof ref.path!=='string'||!ref.path.startsWith(base)||
    !/^[a-f0-9]{64}$/.test(String(ref.sha256??'')))
  throw Error('original answer manifest pointer missing or outside issued unit');
 const raw=fs.readFileSync(repoFile(root,ref.path));
 if(hex(raw)!==ref.sha256)throw Error('committed original answer manifest SHA mismatch');
 const m=JSON.parse(raw.toString('utf8'));
 const expected={campaignId:index.campaignId,
  generationId:index.campaignGenerationId,sourceSha256:index.sourceSha256,
  authorityDigest:index.authorityDigest,phaseSequence:index.phaseSequence,
  phaseEpoch:index.phaseEpoch,unitId:index.unitId,packetSha256:index.packetSha256,
  questionId:question.questionId,questionSha256:hex(Buffer.from(question.questionText,'utf8')),
  fullSha256:ref.fullSha256,scopeSha256:ref.scopeSha256,
  totalBytes:ref.totalBytes,segmentCount:ref.segmentCount,pageCount:ref.pageCount};
 if(m.schemaVersion!=='curveyield-ai-original-answer-manifest-v1'||
    Object.entries(expected).some(([k,v])=>m[k]!==v)||
    m.pageCount!==m.segmentCount||m.verifiedOriginalSha256!==m.fullSha256||
    m.storage!=='IMMUTABLE_GITHUB_PAGES'||m.originalUtf8BoundaryPages!==true)
  throw Error('original answer manifest scope or contents differ from accepted question');
 const pages=[],seen=new Set();let pointer=m.tail;
 while(pointer){
  if(typeof pointer.path!=='string'||!pointer.path.startsWith(base)||
     seen.has(pointer.path)||!/^[a-f0-9]{64}$/.test(String(pointer.sha256??'')))
   throw Error('invalid/cyclic original answer page reference');
  seen.add(pointer.path);
  const bytes=fs.readFileSync(repoFile(root,pointer.path));
  if(hex(bytes)!==pointer.sha256)throw Error('original GitHub answer page digest mismatch');
  const p=JSON.parse(bytes.toString('utf8'));
  if(p.schemaVersion!=='curveyield-ai-original-answer-page-v1'||
     Object.entries(expected).some(([k,v])=>k==='pageCount'?false:p[k]!==v)||
     p.segmentIndex!==pointer.segmentIndex||p.byteStart!==pointer.byteStart||
     p.byteEnd!==pointer.byteEnd||typeof p.dataBase64!=='string')
   throw Error('original answer page is not source- or ordinal-bound');
  const body=Buffer.from(p.dataBase64,'base64');
  if(body.toString('base64')!==p.dataBase64||
     hex(body)!==p.dataSha256||body.length!==p.byteEnd-p.byteStart)
   throw Error('original answer bytes do not match immutable page digest');
  new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body);
  pages.push({path:pointer.path,sha256:pointer.sha256,index:p.segmentIndex,
   start:p.byteStart,end:p.byteEnd,previous:p.previous});
  pointer=p.previous;
 }
 pages.reverse();
 const digest=createHash('sha256');let offset=0;
 for(let i=0;i<pages.length;i++){
  const p=pages[i];
  if(p.index!==i||p.start!==offset||
    (i===0&&p.previous!==null)||
    (i>0&&(p.previous?.path!==pages[i-1].path||
            p.previous?.sha256!==pages[i-1].sha256)))
   throw Error('original answer page chain is incomplete or reordered');
  const row=JSON.parse(fs.readFileSync(repoFile(root,p.path),'utf8'));
  const data=Buffer.from(row.dataBase64,'base64');
  if(hex(data)!==row.dataSha256)throw Error('original answer source mutated');
  digest.update(data);offset=p.end;
 }
 if(pages.length!==m.pageCount||offset!==m.totalBytes||
    digest.digest('hex')!==m.fullSha256)
  throw Error('original GitHub answer incomplete or full SHA mismatch');
 return {answerManifestSource:{path:ref.path,sha256:ref.sha256,
   selector:'originalAnswerManifest',sourceCommit:ref.sourceCommit??null},
  originalAnswerSha256:m.fullSha256,originalAnswerBytes:m.totalBytes,
  originalPageCount:m.pageCount,
  firstContentPage:pages[0]?{path:pages[0].path,sha256:pages[0].sha256}:null,
  lastContentPage:pages.at(-1)?{path:pages.at(-1).path,
   sha256:pages.at(-1).sha256}:null,
  originalAnswerVerification:'PINNED_COMPLETE_UTF8_AND_FULL_SHA256'};
}

// Direct v8 phases have no queue-owned question checkpoint. The Worker
// publishes a non-confidential sidecar with the accepted ORIGINAL shard
// digest and a SHA-256-verified private R2 answer pointer at phase filing.
// Only a later sealed canonical receipt attests controller acceptance.
function collectDirectQuestionSourcesV1({root,campaignPath,directory,phase}){
 const out={questions:[],histories:[],unavailable:[],sidecars:[],checkpoints:[]};
 for(const sourcePhase of [1,2,3,8,9,10]){
  if(sourcePhase>phase)continue;
  const digits=String(sourcePhase).padStart(2,'0');
  const rel=path.posix.join(campaignPath,'work/phase-'+digits,
   'shards/DIRECT_QUESTION_PROVENANCE_v1.json');
  let raw,sidecar,sourceSha256;
  try{
   raw=fs.readFileSync(repoFile(root,rel));
   sourceSha256=hex(raw);sidecar=JSON.parse(raw.toString('utf8'));
   if(sidecar.schemaVersion!=='curveyield-mi-direct-question-provenance-v1'||
      sidecar.campaignId!==directory.campaignId||
      sidecar.campaignGenerationId!==directory.campaignGenerationId||
      sidecar.sourceSha256!==directory.sourceSha256||
      sidecar.authorityDigest!==directory.authorityDigest||
      sidecar.phaseSequence!==sourcePhase||
      !Array.isArray(sidecar.records))
    throw Error('direct source sidecar campaign/authority mismatch');
  }catch(error){
   out.unavailable.push({phaseSequence:sourcePhase,
    reason:'DIRECT_QUESTION_PROVENANCE_UNAVAILABLE',
    originalSourcePath:rel,diagnostic:String(error?.message??error)});
   continue;
  }
  let acceptance='CURRENT_PHASE_LOCAL_SHARD_ACCEPTED_PENDING_SEAL';
  let receiptPath=null,canonicalPath=null,canonicalSha256=null;
  if(sourcePhase<phase){
   canonicalPath=path.posix.join(campaignPath,'derived/phase-'+sourcePhase,
    'PHASE_'+digits+'_CANONICAL_DATA_v1.json');
   try{
    const canBytes=fs.readFileSync(repoFile(root,canonicalPath));
    const prior=JSON.parse(canBytes.toString('utf8'));
    canonicalSha256=hex(canBytes);
    const relative=path.posix.relative(campaignPath,canonicalPath);
    const sidecarRef=prior?.automationOutputs?.questionAnswerSources?.
     directSourceSidecars?.find(x=>x.path===rel);
    if(sidecarRef?.sha256!==sourceSha256)
     throw Error('historical canonical does not reference exact original direct question sidecar');
    // A sealed rework can produce a revised receipt. Inspect the existing
    // immutable receipt family; do not assume revision 1 remains authoritative.
    const receiptFolder=path.posix.join(campaignPath,'receipts');
    const names=fs.readdirSync(repoFile(root,receiptFolder)).
     filter(name=>new RegExp('^PHASE_'+digits+'_RECEIPT_v[0-9]+\\.json
    out.unavailable.push({phaseSequence:sourcePhase,
     reason:'DIRECT_QUESTION_SOURCE_NOT_RECEIPT_VERIFIED',
     originalSourcePath:rel,sourceSha256,
     diagnostic:String(error?.message??error)});
    continue;
   }
  }
  out.sidecars.push({phaseSequence:sourcePhase,path:rel,sha256:sourceSha256,
   availability:acceptance,acceptedReceiptPath:sourcePhase<phase?receiptPath:null,
   acceptedCanonicalPath:sourcePhase<phase?canonicalPath:null,
   acceptedCanonicalSha256:sourcePhase<phase?canonicalSha256:null});
  out.histories.push({phaseSequence:sourcePhase,availability:acceptance,
   directQuestionSourcePath:rel,directQuestionSourceSha256:sourceSha256,
   acceptedReceiptPath:sourcePhase<phase?receiptPath:null,
   sourceMeaning:'ORIGINAL_DIRECT_FIXED_QUESTION_NOT_SECURITY_VERDICT'});
  for(const [i,record] of sidecar.records.entries()){
   if(!record||record.phaseSequence!==sourcePhase||
      !Number.isSafeInteger(record.step)||
      typeof record.unitId!=='string'||!record.unitId||
      record.originalShardPath!==path.posix.join(
       campaignPath,'work/phase-'+digits,'shards',record.unitId)||
      !/^[a-f0-9]{64}$/.test(record.originalShardSha256??'')||
      !Array.isArray(record.questionSources)){
    out.unavailable.push({phaseSequence:sourcePhase,
     reason:'DIRECT_QUESTION_RECORD_IDENTITY_UNAVAILABLE',sourcePath:rel,index:i});
    continue;
   }
   try{
    const bytes=fs.readFileSync(repoFile(root,record.originalShardPath));
    if(hex(bytes)!==record.originalShardSha256)
     throw Error('original accepted shard SHA-256 differs');
   }catch(error){
    out.unavailable.push({phaseSequence:sourcePhase,unitId:record.unitId,
     reason:'DIRECT_QUESTION_ACCEPTED_SHARD_UNAVAILABLE',
     diagnostic:String(error?.message??error)});
    continue;
   }
   if(!record.questionSources.length){
    out.unavailable.push({phaseSequence:sourcePhase,unitId:record.unitId,
     reason:'NO_ORIGINAL_DIRECT_QUESTION_PROOF_IN_ACCEPTED_SHARD',
     acceptedShardPath:record.originalShardPath});continue;
   }
   const groups=new Map();
   for(const [j,proof] of record.questionSources.entries()){
    if(!proof||proof.schemaVersion!=='curveyield-mi-accepted-direct-question-reference-v1'||
       proof.phaseSequence!==sourcePhase||proof.step!==record.step||
       proof.unitId!==record.unitId||proof.originalField!==record.originalField||
       typeof proof.questionId!=='string'||typeof proof.questionText!=='string'||
       proof.questionSha256!==hex(Buffer.from(proof.questionText,'utf8'))||
       proof.sourceSha256!==directory.sourceSha256||
       proof.authorityDigest!==directory.authorityDigest){
     out.unavailable.push({phaseSequence:sourcePhase,unitId:record.unitId,
      reason:'DIRECT_QUESTION_PROOF_IDENTITY_MISMATCH',sourcePath:rel,
      sourceSelector:'records['+i+'].questionSources['+j+']'});continue;
    }
    const id=JSON.stringify([proof.questionId,proof.questionSha256]);
    const group=groups.get(id)??{proof,versions:[],events:[]};
    const locator='records['+i+'].questionSources['+j+']';
    const event={checkpointRevision:j+1,mode:'DIRECT_SOURCE_BOUND',
     sourcePath:rel,sourceSha256,sourceSelector:locator,
     recordedStatus:proof.availability,
     sourceAcceptance:acceptance};
    group.events.push(event);
    if(proof.availability==='EXACT_PRIVATE_ORIGINAL_SHA256_VERIFIED'&&
       /^[a-f0-9]{64}$/.test(proof.originalAnswerSha256??'')&&
       typeof proof.privateR2Key==='string'&&
       proof.privateR2Key.endsWith('/'+proof.originalAnswerSha256+'.txt')&&
       proof.retrievalOperation==='direct_question_source'){
     group.versions.push({...event,
      originalAnswerSha256:proof.originalAnswerSha256,
      originalAnswerBytes:proof.originalAnswerBytes,
      originalPrivateR2Source:{key:proof.privateR2Key,
       sha256:proof.originalAnswerSha256,
       availability:'WORKER_R2_HASH_VERIFIED_AT_LOCAL_ACCEPTANCE',
       retrievalOperation:'direct_question_source',
       controllerAccepted:acceptance==='ACCEPTED_RECEIPT_BOUND'},
      fullAnswerTextInPublicGithub:false});
    }else out.unavailable.push({phaseSequence:sourcePhase,
     unitId:record.unitId,questionId:proof.questionId,
     reason:proof.availability??'DIRECT_PRIVATE_ANSWER_UNAVAILABLE',
     sourcePath:rel,sourceSelector:locator});
    groups.set(id,group);
   }
   for(const group of groups.values()){
    const proof=group.proof;
    out.questions.push({phaseSequence:sourcePhase,
     unitId:record.unitId,questionId:proof.questionId,
     questionTextSource:{path:rel,sha256:sourceSha256,
      selector:'records['+i+'].questionSources'},
     questionText:proof.questionText,
     questionIndexPath:rel,questionIndexSha256:sourceSha256,
     questionIndexRevision:null,sourceKind:'DIRECT_FIXED_ORIGINAL',
     originalDirectFieldPath:'actions.step-'+record.step+'.outputs.'+record.originalField,
     originalAcceptedShardPath:record.originalShardPath,
     originalAcceptedShardSha256:record.originalShardSha256,
     acceptedUnitPath:record.originalShardPath,
     acceptedUnitArtifactSha256:record.originalShardSha256,
     sourceAcceptance:acceptance,
     acceptedReceiptPath:sourcePhase<phase?receiptPath:null,
     checkpointEvents:group.events,answerVersions:group.versions,
     answered:group.versions.length>0,
     statusFromCurrentIndex:group.versions.length?'ANSWERED_SOURCE_BOUND':
      'ANSWER_SOURCE_UNAVAILABLE_OR_NOT_STAGED',
     securityDisposition:'NOT_INFERRED'});
   }
  }
 }
 return out;
}
// Exact, mechanically verified question sources. The history index and each
// checkpoint are immutable evidence; questions are NOT security outcomes.
// A later phase may refer to any earlier accepted question, including one
// that never contributed to a formal candidate or obligation.
export function collectAcceptedQuestionAnswerSourcesV1({root,campaignPath,directory,phase}){
 const out={schemaVersion:'curveyield-accepted-question-answer-sources-v1',
  phaseSequence:phase,campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,
  questions:[],unavailable:[],histories:[],checkpoints:[],
  directSourceSidecars:[],
  sourceMeaning:'QUESTION_HISTORY_NOT_SECURITY_DISPOSITION'};
 // Direct-phase evidence shares the existing canonical source/link schema.
 // The private answer text remains in R2, never in the public record.
 if(directory.authorityRelease==='machine-intelligence-v8'){
  const direct=collectDirectQuestionSourcesV1({root,campaignPath,directory,phase});
  out.questions.push(...direct.questions);
  out.unavailable.push(...direct.unavailable);
  out.histories.push(...direct.histories);
  out.checkpoints.push(...direct.checkpoints);
  out.directSourceSidecars=direct.sidecars;
 }
 for(const sourcePhase of [4,5,6]){
  if(sourcePhase>phase)continue;
  let refs;
  try{
   refs=collectAcceptedQuestionHistoryRefsV1({
    root,campaignPath,directory,phase:sourcePhase});
  }catch(error){
   out.unavailable.push({phaseSequence:sourcePhase,
    reason:'QUESTION_HISTORY_ROSTER_UNAVAILABLE',
    diagnostic:String(error?.message??error)});continue;
  }
  if(refs.availability!=='COLLECTED_NONBLOCKING')
   out.unavailable.push({phaseSequence:sourcePhase,
    reason:refs.availability??'QUESTION_HISTORY_UNAVAILABLE'});
  let plan=null,queue=null;
  try{
   plan=readPlan(root,campaignPath,sourcePhase);
   queue=read(root,queueRel(campaignPath,sourcePhase));
  }catch{/* Individual history may still retain its original reference. */}
  for(const history of refs.histories??[]){
   const ref={...history};
   out.histories.push(ref);
   const unitId=ref.unitId;
   const owner=queue?.units?.[unitId];
   const expectedUnit=plan?.units?.find(u=>u.unitId===unitId);
   const availability=ref.availability;
   if(availability!=='AVAILABLE'){
    out.unavailable.push({phaseSequence:sourcePhase,unitId,
     reason:availability??'INDEX_NOT_AVAILABLE',
     indexPath:ref.indexPath??null,
     previousCommittedIndex:ref.previousCommittedIndex??null});
    continue;
   }
   if(!owner||owner.status!=='ACCEPTED'||!expectedUnit||
      !owner.acceptedPath){
    out.unavailable.push({phaseSequence:sourcePhase,unitId,
     reason:'QUESTION_OWNER_NOT_ACCEPTED'});continue;
   }
   let accepted,index;
   try{
    accepted=read(root,owner.acceptedPath);
    const original=fs.readFileSync(repoFile(root,ref.indexPath));
    if(hex(original)!==ref.indexSha256)
     throw Error('question index digest does not match accepted reference');
    index=hydratePagedQuestionIndexV1(root,JSON.parse(original.toString('utf8')),ref.indexPath);
    if(index.schemaVersion!=='curveyield-ai-question-index-v1'||
       index.phaseSequence!==sourcePhase||index.unitId!==unitId||
       index.phaseEpoch!==accepted.phaseEpoch||
       index.packetSha256!==accepted.packetSha256||
       index.campaignId!==directory.campaignId||
       index.campaignGenerationId!==directory.campaignGenerationId||
       index.sourceSha256!==directory.sourceSha256||
       index.authorityDigest!==directory.authorityDigest||
       accepted.unitId!==unitId||accepted.phaseSequence!==sourcePhase||
       accepted.submissionSha256!==owner.acceptedSha256||
       accepted.packetSha256!==index.packetSha256)
     throw Error('question index or accepted owner identity differs');
   }catch(error){
    out.unavailable.push({phaseSequence:sourcePhase,unitId,
     reason:'INDEX_OR_ACCEPTED_SOURCE_UNREADABLE',
     diagnostic:String(error?.message??error),
     indexPath:ref.indexPath??null});continue;
   }
   const keyMap=new Map();
   for(const [i,question] of (index.questions??[]).entries()){
    if(!question||typeof question.questionId!=='string'){
     out.unavailable.push({phaseSequence:sourcePhase,unitId,
      questionIndexOrdinal:i,reason:'INDEX_QUESTION_IDENTITY_UNREADABLE',
      questionIndexPath:ref.indexPath});continue;
    }
    const identity=JSON.stringify([sourcePhase,unitId,question.questionId]);
    const entry={phaseSequence:sourcePhase,unitId,
     questionId:question.questionId,round:question.round??null,
     answered:question.answered??null,
     statusFromCurrentIndex:question.answered===true?'ANSWERED':
      question.answered===false?'PLANNED':'INDEX_STATUS_UNSPECIFIED',
     questionTextSource:index._questionPageSources?.[question.questionId]??
      {path:ref.indexPath,sha256:ref.indexSha256,
       selector:'questions['+i+'].questionText'},
     questionIndexPath:ref.indexPath,questionIndexSha256:ref.indexSha256,
     questionIndexRevision:index.revision,
     currentAnswerCheckpoint:question.answerCheckpoint??null,
     currentAnswerCheckpointSource:index._answerPageSources?.[question.questionId]??
      {path:ref.indexPath,sha256:ref.indexSha256,
       selector:'questions['+i+'].answerCheckpoint'},
     packetSha256:accepted.packetSha256,
     acceptedUnitPath:owner.acceptedPath,
     acceptedUnitArtifactSha256:hex(fs.readFileSync(repoFile(root,owner.acceptedPath))),
     acceptedSubmissionSha256:accepted.submissionSha256,
     // Preserve question creation and subsequent source events separately.
     // PLAN/EXPAND with null answers are not answered revisions.
     checkpointEvents:[],answerVersions:[]};
    out.questions.push(entry);keyMap.set(identity,entry);
   }
   // Every immutable checkpoint revision, not just the last answer, remains
   // addressable. An ANSWERS or REVISE event is not a security resolution.
   for(const [checkpointIndex,checkpoint] of (index.checkpoints??[]).entries()){
    if(!checkpoint||typeof checkpoint.path!=='string'){
     out.unavailable.push({phaseSequence:sourcePhase,unitId,
      checkpointIndex,reason:'CHECKPOINT_REFERENCE_UNREADABLE',
      questionIndexPath:ref.indexPath});continue;
    }
    let source,rawSha;
    try{
     const raw=fs.readFileSync(repoFile(root,checkpoint.path));
     rawSha=hex(raw);
     if(rawSha!==checkpoint.sha256)
      throw Error('checkpoint SHA-256 differs from index');
     source=JSON.parse(raw.toString('utf8'));
     if(!Array.isArray(source.records)||
        Number.isSafeInteger(checkpoint.recordCount)&&
         source.records.length!==checkpoint.recordCount)
      throw Error('checkpoint source record count differs from index');
     if(source.schemaVersion!=='curveyield-ai-question-checkpoint-v1'||
        source.phaseSequence!==sourcePhase||source.unitId!==unitId||
        source.packetSha256!==accepted.packetSha256||
        source.campaignGenerationId!==directory.campaignGenerationId||
        source.sourceSha256!==directory.sourceSha256||
        source.authorityDigest!==directory.authorityDigest||
        source.phaseEpoch!==accepted.phaseEpoch||
        source.revision!==checkpoint.revision)
      throw Error('checkpoint source authority identity differs');
    }catch(error){
     out.unavailable.push({phaseSequence:sourcePhase,unitId,
      reason:'CHECKPOINT_UNAVAILABLE',path:checkpoint.path,
      sha256:checkpoint.sha256,revision:checkpoint.revision,
      diagnostic:String(error?.message??error)});continue;
    }
    // PLAN, EXPAND, ANSWERS, REVISE and COMPLETE are durable events.
    // COMPLETE is merely the AI's question-ledger decision, not a
    // determination that every security risk has been resolved.
    out.checkpoints.push({
     phaseSequence:sourcePhase,unitId,
     revision:checkpoint.revision,mode:source.mode,
     path:checkpoint.path,sha256:checkpoint.sha256,
     packetSha256:accepted.packetSha256,
     acceptedUnitPath:owner.acceptedPath,
     recordCount:source.records.length,
     recordedAt:source.recordedAt??null,
     requestId:source.requestId??checkpoint.requestId??null,
     ...(Object.hasOwn(source,'revisionReason')?{
      revisionReasonSource:{path:checkpoint.path,sha256:checkpoint.sha256,
       selector:'revisionReason'}}:{}),
     ...(Object.hasOwn(source,'aiCompletionDecision')?{
      completionDecisionSource:{path:checkpoint.path,sha256:checkpoint.sha256,
       selector:'aiCompletionDecision'}}:{}),
     ...(Object.hasOwn(source,'decision')?{
      completionDecisionSource:{path:checkpoint.path,sha256:checkpoint.sha256,
       selector:'decision'}}:{})
    });
    for(const [i,record] of source.records.entries()){
     if(!record||typeof record.questionId!=='string')continue;
     const identity=JSON.stringify([sourcePhase,unitId,record.questionId]);
     const question=keyMap.get(identity);
     if(!question){
      out.unavailable.push({phaseSequence:sourcePhase,unitId,
       questionId:record.questionId,reason:'CHECKPOINT_QUESTION_NOT_IN_INDEX',
       path:checkpoint.path,revision:checkpoint.revision});continue;
     }
     const checkpointEvent={
      checkpointRevision:checkpoint.revision,mode:source.mode,
      checkpointPath:checkpoint.path,checkpointSha256:checkpoint.sha256,
      checkpointRecordSelector:'records['+i+']',
      ...(Object.hasOwn(record,'questionText')?
       {historicalQuestionTextSelector:'records['+i+'].questionText'}:{}),
      recordedStatus:record.status??null,
      revisionReasonSource:source.mode==='REVISE'&&
       Object.hasOwn(source,'revisionReason')?
       {path:checkpoint.path,sha256:checkpoint.sha256,
        selector:'revisionReason'}:null
     };
     question.checkpointEvents.push(checkpointEvent);
     // An answer version requires an actually authored non-null answer,
     // not a planned question merely appearing in an EXPAND checkpoint.
     if(source.mode==='ANSWERS'||source.mode==='REVISE'){
      if(typeof record.answerText==='string')
       question.answerVersions.push({...checkpointEvent,
        answerTextSourceSelector:'records['+i+'].answerText'});
      else if(record.answerManifest){
       try{
        const sourceBound=verifiedSegmentedAnswerSourceV1(
         root,record.answerManifest,{...index,questionIndexPath:ref.indexPath},question);
        question.answerVersions.push({...checkpointEvent,
         answerTextSourceSelector:'records['+i+'].answerManifest',
         ...sourceBound});
       }catch(error){
        out.unavailable.push({phaseSequence:sourcePhase,unitId,
         questionId:record.questionId,checkpointIndex,
         reason:'SEGMENTED_ANSWER_SOURCE_UNAVAILABLE',
         checkpointPath:checkpoint.path,
         manifestPath:record.answerManifest?.path??null,
         diagnostic:String(error?.message??error)});
       }
      }
     }
    }
   }
  }
 }
 out.questionCount=out.questions.length;
 out.answerVersionCount=out.questions.reduce((n,q)=>n+q.answerVersions.length,0);
 out.checkpointCount=out.checkpoints.length;
 out.availability=out.unavailable.length?'PARTIAL_OR_SOURCE_UNAVAILABLE':'COLLECTED_NONBLOCKING';
 return out;
}

const asArray=x=>Array.isArray(x)?x:[];
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>structuredClone(x);
// Bind acceptance to the exact original-record evidence, even when a parent
// batch is undergoing targeted rework and its unrelated siblings remain valid.
function prerequisiteEvidence(queue,dependencies){
 const evidence={};
 for(const id of asArray(dependencies)){
  const record=queue.acceptedRecords?.[id];
  if(record?.status==='ACCEPTED'&&record.snapshotSha256){
   evidence[id]='RECORD:'+record.snapshotSha256;continue;
  }
  const unit=queue.units[id];
  if(unit?.status==='ACCEPTED'&&unit.acceptedPath&&unit.acceptedSha256){
   evidence[id]='UNIT:'+unit.acceptedPath+':'+unit.acceptedSha256;continue;
  }
  return null;
 }
 return evidence;
}
// The Worker/adapter decides audit prerequisites; GitHub only manages the queue.
const depSatisfied=()=>true;
const dependenciesFresh=()=>true;
const isPhase=(p)=>[4,5,6].includes(p);
const RELEASES=new Set(['machine-intelligence-v7','machine-intelligence-v8']);
const authorityFor=directory=>{
  if(!RELEASES.has(directory.authorityRelease))throw Error('unsupported Machine Intelligence release');
  return directory.authorityRelease==='machine-intelligence-v8'?'Machine Intelligence Audit Controller/Audit Skill v8':'Machine Intelligence Audit Controller/Audit Skill v7';
};
const rowId=(phase,field,index)=>{
 const families={
 '4:discoveryReconciliationRecords':'P4-RC','4:specialistReviewRecords':'P4-SP',
 '4:candidateRecords':'P4-C','4:typedLimitations':'P4-L','4:obligationDispositions':'P4-OB',
 '5:economicReviewRecords':'P5-E','5:reconciliationRecords':'P5-R','5:targetDesigns':'P5-T','5:newCandidateRecords':'P5-R',
 '6:deploymentAssessments':'P6-D','6:targetDispositions':'P6-T',
 '6:baselineTestRecords':'P6-B','6:candidateProofRecords':'P6-P',
 '6:mergedExecutionConclusions':'P6-C','6:obligationDispositions':'P6-C',
 '6:typedExecutionLimitations':'P6-L','6:fullOnlyOmissions':'P6-O','6:newCandidateRecords':'P6-P'
 };
 const prefix=families[phase+':'+field];
 if(!prefix)throw Error('unassigned semantic field '+phase+':'+field);
 return prefix+'-'+String(index+1).padStart(3,'0');
};
function assertParallelSolo(directory,phase,request=null){
 if(!isPhase(phase)||directory.mode!=='LITE_SOLO'||!RELEASES.has(directory.authorityRelease))
  throw Error('Machine Intelligence parallel controller requires the fork-owned authority');
 // This is the executable model of the isolated v7 fork. A historical
 // directory may predate the field; code upgrades must not strand it.
 if(directory.executionModel!=='PARALLEL_WORKER_UNITS')
  directory.executionModel='PARALLEL_WORKER_UNITS';
 if(directory.currentAssignment?.phaseSequence!==phase)throw Error('phase not current/assigned');
 if(request){
  const expected={campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,
   phaseSequence:phase,sourceSha256:directory.sourceSha256,
   auditControllerRef:'machine-intelligence-audit-controller-v1'};
  for(const [key,value] of Object.entries(expected))if(request[key]!==value)throw Error('request identity mismatch: '+key);
  if(request.authorityDigest!==directory.authorityDigest)
   throw Error('authority digest differs from bound campaign');
  if(request.phaseEpoch!==Number(directory.unitPhaseEpoch??1))throw Error('stale phase epoch');
 }
}
function emptyPlan(directory,phase){
 return {schemaVersion:'curveyield-lite-solo-unit-plan-v1',campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,phaseSequence:phase,phaseEpoch:Number(directory.unitPhaseEpoch??1),
  sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
  unitSpecRevision:1,campaignPath:directory.workspacePath,units:[],recordOwnership:{},stage:phase===4?'CORRECTNESS':'SEMANTIC'};
}
function emptyQueue(plan){
 return {schemaVersion:'curveyield-lite-solo-unit-queue-state-v1',campaignId:plan.campaignId,
  campaignGenerationId:plan.campaignGenerationId,phaseSequence:plan.phaseSequence,
  phaseEpoch:plan.phaseEpoch,sourceSha256:plan.sourceSha256,authorityDigest:plan.authorityDigest,
  unitSpecRevision:plan.unitSpecRevision,stage:plan.stage,
  units:{},acceptedRecords:{},processedRequests:{},processedRequestHashes:{},revision:0,finalizeStatus:'NOT_STARTED',newlyEligibleUnitIds:[]};
}
function addUnit(plan,queue,unit){
 if(queue.units[unit.unitId]||plan.units.some(x=>x.unitId===unit.unitId))throw Error('duplicate unit '+unit.unitId);
 const status=asArray(unit.dependencies).length?'BLOCKED_DEPENDENCY':'AVAILABLE';
 plan.units.push(unit);queue.units[unit.unitId]={status,workerId:null,claimEpoch:0,
  claimToken:null,acceptedSha256:null,lastSubmissionSha256:null,lastErrors:[],attempts:0};
}
function assertPlan(queue,plan){
 for(const k of ['campaignId','campaignGenerationId','phaseSequence','phaseEpoch','sourceSha256','authorityDigest','unitSpecRevision'])
  if(queue[k]!==plan[k])throw Error('unit plan/queue identity differs: '+k);
}
const PREFILL_PART_BYTES=12*1024;
const prefillPartRel=(rel,i)=>path.posix.join(path.posix.dirname(rel),'prefill-pages',
 path.posix.basename(rel,'.json')+'_PART_'+String(i+1).padStart(6,'0')+'_v1.json');
function writePagedPrefillV1(root,rel,value){
 const raw=Buffer.from(pretty({value}),'utf8'),count=Math.ceil(raw.length/PREFILL_PART_BYTES);
 for(let i=0;i<count;i++){
  const part=raw.subarray(i*PREFILL_PART_BYTES,(i+1)*PREFILL_PART_BYTES);
  const page={schemaVersion:'curveyield-lite-solo-unit-prefill-page-v1',index:i+1,
   total:count,offset:i*PREFILL_PART_BYTES,sha256:hex(part),base64:part.toString('base64')};
  if(Buffer.byteLength(pretty(page))>24*1024)throw Error('prefill page exceeds 24 KiB');
  put(root,prefillPartRel(rel,i),page);
 }
 const manifest={schemaVersion:'curveyield-lite-solo-unit-prefill-manifest-v1',
  sha256:hex(raw),byteLength:raw.length,partBytes:PREFILL_PART_BYTES,pageCount:count};
 put(root,rel,manifest);return manifest;
}
function readPagedPrefillV1(root,rel,rawManifest){
 const manifest=JSON.parse(rawManifest.toString('utf8'));
 if(manifest.schemaVersion!=='curveyield-lite-solo-unit-prefill-manifest-v1')
  return manifest.value;
 if(!Number.isSafeInteger(manifest.pageCount)||manifest.pageCount<1||
    manifest.partBytes!==PREFILL_PART_BYTES||!/^[a-f0-9]{64}$/.test(manifest.sha256))
  throw Error('invalid bounded prefill manifest');
 const chunks=[];
 for(let i=0;i<manifest.pageCount;i++){
  const page=read(root,prefillPartRel(rel,i));
  if(page.schemaVersion!=='curveyield-lite-solo-unit-prefill-page-v1'||
     page.index!==i+1||page.total!==manifest.pageCount||
     page.offset!==i*PREFILL_PART_BYTES)throw Error('prefill page identity mismatch');
  const part=Buffer.from(page.base64,'base64');
  if(part.length>PREFILL_PART_BYTES||hex(part)!==page.sha256)
   throw Error('prefill page digest mismatch');
  chunks.push(part);
 }
 const full=Buffer.concat(chunks);
 if(full.length!==manifest.byteLength||hex(full)!==manifest.sha256)
  throw Error('prefill reconstruction digest mismatch');
 return JSON.parse(full.toString('utf8')).value;
}
function readPlan(root,campaign,phase){
 const index=read(root,planRel(campaign,phase));
 if(index.schemaVersion!=='curveyield-lite-solo-unit-plan-v1'||!Array.isArray(index.pages))
  throw Error('unrecognized or unpaged v4 unit plan');
 // Normalize only a Git-verified alias of this same exact campaign workspace.
 const prior=index.campaignPath;
 if(prior!==campaign){
  if(typeof prior!=='string'||!/^campaigns\/[^/]+$/.test(prior)||
     !/^campaigns\/[^/]+\/[^/]+$/.test(campaign))
   throw Error('unit plan campaign path mismatch');
  const alias=repoFile(root,prior),current=repoFile(root,campaign);
  if(!fs.lstatSync(alias).isSymbolicLink()||fs.realpathSync(alias)!==fs.realpathSync(current))
   throw Error('unit plan location lacks verified migration alias');
 }
 const canonical=s=>typeof s==='string'&&prior!==campaign&&s.startsWith(prior+'/')
  ?campaign+s.slice(prior.length):s;
 const units=[];
 for(const p of index.pages){
  const raw=fs.readFileSync(repoFile(root,p.path));
  if(hex(raw)!==p.sha256||raw.length>32768)throw Error('unit plan page digest/size mismatch: '+p.path);
  const data=JSON.parse(raw.toString('utf8'));
  for(const u of data.units){
   if(u.initialValueRef){
    const rawValue=fs.readFileSync(repoFile(root,u.initialValueRef));
    if(hex(rawValue)!==u.initialValueSha256)throw Error('unit prefill digest mismatch');
    u.initialValue=readPagedPrefillV1(root,u.initialValueRef,rawValue);
   }
   if(u.issuedMetaRef){
    const raw=fs.readFileSync(repoFile(root,u.issuedMetaRef));
    if(hex(raw)!==u.issuedMetaSha256)
     throw Error('issued roster metadata changed after delivery: '+u.unitId);
    u.issuedMeta=readPagedPrefillV1(root,u.issuedMetaRef,raw);
   }
   if(u.kind==='BATCH'){
    if(!u.membersRef||u.membersRef!==u.packetPath)throw Error('missing batch assignment manifest');
    const raw=fs.readFileSync(repoFile(root,u.membersRef));
    if(hex(raw)!==u.packetSha256)throw Error('batch packet digest mismatch');
    const payload=readPagedPrefillV1(root,u.membersRef,raw);
    if(payload.unitId!==u.unitId||payload.phaseSequence!==phase||
       payload.schemaVersion!=='curveyield-lite-solo-batched-assignment-v1'||
       !Array.isArray(payload.members)||payload.members.length<2)
      throw Error('invalid batch assignment payload');
    u.members=payload.members;
   }
   units.push(u);
  }
 }
 if(units.length!==index.unitCount)throw Error('missing unit plan pages');
 const ownership={};
 for(const u of units){
  for(const m of u.kind==='BATCH'?u.members:[u]){
   if(!m.path)continue;
   const key=m.kind==='APPEND'?dot([...m.path,
    m.appendChunkNumber>1?'APPEND-C'+String(m.appendChunkNumber).padStart(4,'0'):'APPEND']):
    Number.isInteger(m.recordIndex)?dot([...m.path,String(m.recordIndex)]):null;
   if(!key)continue;
   if(ownership[key])throw Error('duplicate canonical unit owner: '+key);
   ownership[key]=u.unitId;
  }
 }
 for(const u of units){
  for(const key of ['packetPath','packetIndexPath','shardPath','membersRef','initialValueRef'])
   if(typeof u[key]==='string')u[key]=canonical(u[key]);
 }
 return {...index,campaignPath:campaign,units,recordOwnership:ownership};
}
function publishPlan(root,campaign,phase,plan,queue){
 assertPlan(queue,plan);
 const planDir=path.posix.join(rootOf(campaign,phase),'plan');
 const previous=maybe(root,planRel(campaign,phase));
 if(previous&&Array.isArray(previous.pages)&&
    Number.isInteger(previous.unitCount)&&
    previous.unitCount<plan.units.length&&
    plan.units.some(u=>u.appendChunkNumber>1)){
  // A new continuation may grow the plan but may NEVER rewrite an already
  // issued plan page. Compare exact stored metadata, including frozen refs,
  // and append new bounded pages only. Existing issued byte hashes persist.
  const priorUnits=previous.pages.flatMap(ref=>{
   const raw=fs.readFileSync(repoFile(root,ref.path));
   if(hex(raw)!==ref.sha256)throw Error('frozen unit plan page digest mismatch');
   return JSON.parse(raw.toString('utf8')).units;
  });
  if(priorUnits.length!==previous.unitCount)
   throw Error('frozen unit plan page count mismatch');
  const serialized=plan.units.map(unit=>{
   const u=clone(unit);
   delete u.issuedMeta;
   if(u.kind==='BATCH')delete u.members;
   if(u.initialValueRef)delete u.initialValue;
   return u;
  });
  for(let i=0;i<priorUnits.length;i++)
   if(JSON.stringify(priorUnits[i])!==JSON.stringify(serialized[i]))
    throw Error('APPEND_CONTINUATION_FROZEN_UNIT_CHANGED: '+
     String(priorUnits[i]?.unitId??i));
  const newPages=[...previous.pages],suffix=serialized.slice(priorUnits.length);
  let pending=[];
  const flush=()=>{
   if(!pending.length)return;
   const file='UNIT_PLAN_PAGE_'+String(newPages.length+1).padStart(4,'0')+'_v1.json';
   const rel=path.posix.join(planDir,file);
   const content={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:pending};
   const raw=pretty(content);
   if(Buffer.byteLength(raw)>32768)throw Error('continuation plan page exceeds 32 KiB');
   put(root,rel,content);
   newPages.push({path:rel,sha256:hex(Buffer.from(raw)),count:pending.length});
   pending=[];
  };
  for(const u of suffix){
   if(pending.length&&Buffer.byteLength(pretty({
    schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:[...pending,u]}))>30000)
    flush();
   pending.push(u);
  }
  flush();
  const {units,recordOwnership,...metadata}=plan;
  put(root,planRel(campaign,phase),{...metadata,unitCount:units.length,pages:newPages});
  put(root,queueRel(campaign,phase),queue);
  return;
 }
 const pages=[];let batch=[];
 const flush=()=>{
  if(!batch.length)return;
  const rel=path.posix.join(planDir,'UNIT_PLAN_PAGE_'+String(pages.length+1).padStart(4,'0')+'_v1.json');
  const payload={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:batch};
  const raw=pretty(payload);
  if(Buffer.byteLength(raw)>32768)throw Error('unit plan page exceeds 32 KiB');
  const filePath=repoFile(root,rel);
  if(!fs.existsSync(filePath)||
     fs.readFileSync(filePath,'utf8')!==raw){
   if(fs.existsSync(filePath)){
    const prior=read(root,rel);
    for(const priorUnit of asArray(prior.units)){
     if(queue.units[priorUnit.unitId]?.status==='ACCEPTED'){
      const current=payload.units.find(u=>u.unitId===priorUnit.unitId);
      if(!current||JSON.stringify(current)!==JSON.stringify(priorUnit))
       throw Error('FROZEN_ACCEPTED_UNIT_METADATA_CHANGED: '+priorUnit.unitId);
     }
    }
   }
   put(root,rel,payload);
  }
  pages.push({path:rel,sha256:hex(Buffer.from(raw)),count:batch.length});batch=[];
 };
 for(const unit of plan.units){
  const u=clone(unit);
  // The original metadata remains in the paged-prefill format.
  delete u.issuedMeta;
  if(u.kind==='BATCH'){
   if(!u.membersRef||!u.packetPath||!u.members?.length)throw Error('invalid batch plan serialization');
   delete u.members;
  }
  if(Buffer.byteLength(pretty(u))>12000&&u.initialValue!==undefined){
   const rel=path.posix.join(unitBase(campaign,phase,u.unitId),'UNIT_PREFILL_v1.json');
   const manifest=writePagedPrefillV1(root,rel,u.initialValue);
   u.initialValueRef=rel;u.initialValueSha256=sha(manifest);delete u.initialValue;
  }
  const trial={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:[...batch,u]};
  if(batch.length&&Buffer.byteLength(pretty(trial))>30000)flush();
  batch.push(u);
 }
 flush();
 const {units,recordOwnership,...metadata}=plan;
 put(root,planRel(campaign,phase),{...metadata,unitCount:units.length,pages});
 put(root,queueRel(campaign,phase),queue);
}
// Issued answer bindings are campaign data: preserve their original bytes
// when the executable Contract-Automation branch is upgraded.
export function freezeIssuedUnitMetaV1({root,campaignPath,phase,issued=[]}){
 if(!issued.length)return false;
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 assertPlan(queue,plan);
 const lookup=new Map(plan.units.map(u=>[u.unitId,u]));
 let changed=false;
 for(const {unitId,meta} of issued){
  const u=lookup.get(unitId);
  if(!u)throw Error('issued metadata references unknown unit '+unitId);
  if(u.issuedMetaRef)continue;
  const rel=path.posix.join(unitBase(campaignPath,phase,unitId),'ISSUED_META_v1.json');
  const manifest=writePagedPrefillV1(root,rel,meta);
  u.issuedMetaRef=rel;u.issuedMetaSha256=sha(manifest);
  changed=true;
 }
 if(changed)publishPlan(root,campaignPath,phase,plan,queue);
 return changed;
}
export function createUnitPlanV1({root,campaignPath,directory,phase,automationRoot=process.cwd()}){
 assertParallelSolo(directory,phase);
 const existing=maybe(root,queueRel(campaignPath,phase));
 if(existing)return existing;
 const plan=emptyPlan(directory,phase),queue=emptyQueue(plan);
 if(phase===4){
  const rel=reviewInventoryRelV1(root,campaignPath,'FLOW_PLAN_v1.json'),flow=read(root,rel);
  const units=[...asArray(flow.payload?.reviewUnits),...asArray(flow.payload?.attackUnits)];
  // Worker owns inventory quality assessment; preserve actual gaps as diagnostics.
  if(asArray(flow.payload?.gaps).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code)))
   plan.githubDiagnostics=[...(plan.githubDiagnostics??[]),'PHASE4_REVIEW_INVENTORY_INCOMPLETE'];
  // With no worker-issued units there are no submissions to package.
  if(!units.length)throw Error('AWAITING_WORKER_ISSUED_PHASE4_UNITS');
  const fIds=units.filter(u=>u.unitId.startsWith('F-')||u.unitId.startsWith('R-')).map(u=>u.unitId);
  for(const u of units){
   if(!/^[FRX]-\d{3}$/.test(u.unitId))throw Error('unsupported discovery unit '+u.unitId);
   const packet=buildUnitPacketV1({root,campaignPath,directory,authorityRoot:authorityFor(directory),
    automationRoot,unitId:u.unitId,state:null,now:new Date().toISOString(),persist:true});
   const packetRel=path.posix.join(campaignPath,'work/phase-04/discovery',u.unitId,'ASSIGNMENT_PACKET_v1.json');
   const idx=writeUnitPacketIndexV1({root,campaignPath,unitId:u.unitId,role:u.unitId.startsWith('X-')?'ATTACK':'FLOW_REVIEW'});
   addUnit(plan,queue,{unitId:u.unitId,kind:u.unitId.startsWith('X-')?'ATTACK':'FLOW',
    dependencies:u.unitId.startsWith('X-')?fIds:[],
    packetPath:packetRel,packetIndexPath:idx,packetSha256:hex(fs.readFileSync(repoFile(root,packetRel))),
    unitSpecRevision:1});
  }
 }else addShardUnits({root,campaignPath,directory,phase,plan,queue});
 queue.newlyEligibleUnitIds=plan.units.filter(x=>queue.units[x.unitId].status==='AVAILABLE').map(x=>x.unitId);
 publishPlan(root,campaignPath,phase,plan,queue);
 directory.unitQueueIndexPath=planRel(campaignPath,phase);
 directory.unitQueueStatePath=queueRel(campaignPath,phase);
 if(directory.currentAssignment?.phaseSequence===phase){
  directory.currentAssignment.unitQueueIndexPath=directory.unitQueueIndexPath;
  directory.currentAssignment.unitQueueStatePath=directory.unitQueueStatePath;
 }
 directory.executionModel='PARALLEL_WORKER_UNITS';
 return queue;
}

function consolidateNewSemanticUnitsV1({root,campaignPath,phase,plan,queue}){
 const proposed=planSemanticBatchesV1(plan.units,phase);
 const selected=proposed.batches.filter(b=>b.members.length>1);
 if(!selected.length)return;
 const replacements=new Map(),removed=new Set(),serial={};
 for(const group of selected){
  const family=group.members[0].unitId.replace(/-[0-9]+$/,'');
  const number=(serial[family]??0)+1;serial[family]=number;
  const id=family+'-B'+String(number).padStart(4,'0');
  if(queue.units[id])throw Error('batched unit identity collision: '+id);
  if(group.members.some(m=>!['AVAILABLE','BLOCKED_DEPENDENCY'].includes(queue.units[m.unitId]?.status)))
   throw Error('cannot rebatch an already claimed, submitted or accepted unit');
  const payload={schemaVersion:'curveyield-lite-solo-batched-assignment-v1',unitId:id,
   phaseSequence:phase,field:group.field,groupKeys:group.groupKeys,members:group.members,
   readingGuide:SEMANTIC_BATCH_READING_GUIDE_V1};
  const packetPath=path.posix.join(unitBase(campaignPath,phase,id),'ASSIGNMENT_PACKET_v1.json');
  const manifest=writePagedPrefillV1(root,packetPath,payload);
  const spec={unitId:id,kind:'BATCH',field:group.field,members:group.members,
   memberUnitIds:group.memberUnitIds,recordCount:group.members.length,
   membersRef:packetPath,packetPath,packetSha256:sha(manifest),
   dependencies:[...new Set(group.members.flatMap(m=>asArray(m.dependencies)))],
   unitSpecRevision:1};
  replacements.set(group.members[0].unitId,spec);
  for(const m of group.members){
   removed.add(m.unitId);delete queue.units[m.unitId];
   plan.recordOwnership[dot([...m.path,String(m.recordIndex)])]=id;
  }
  addUnit(plan,queue,spec);
 }
 const original=plan.units.filter(u=>!removed.has(u.unitId)&&u.kind!=='BATCH');
 plan.units.splice(0,plan.units.length,...original,...replacements.values());
}

function addShardUnits({root,campaignPath,directory,phase,plan,queue}){
 const idxRel=directory.currentAssignment?.workShardIndexPath;
 if(!idxRel)throw Error('missing canonical semantic shard index');
 const index=read(root,idxRel),dir=path.posix.dirname(idxRel);
 if(index.phase!==phase)throw Error('shard phase mismatch');
 const descriptors=asArray(index.pages).flatMap(p=>asArray(read(root,path.posix.join(dir,p.file)).shards));
 const serial={};
 // One monotonic namespace per semantic unit family, including related fields.
 const nextId=field=>{
  const family=rowId(phase,field,0).slice(0,-4);
  const index=serial[family]??0;
  serial[family]=index+1;
  return rowId(phase,field,index);
 };
 for(const d of descriptors){
  const field=d.path?.at(-1);
  if(!field)throw Error('missing work shard field');
  // Controller-owned machine-derived limitation/omission fields are not worker-editable.
  if(phase===6&&['typedExecutionLimitations','fullOnlyOmissions'].includes(field))continue;
  const slab=read(root,path.posix.join(dir,d.file));
  const slabPacketSha256=hex(fs.readFileSync(repoFile(root,path.posix.join(dir,d.file))));
  if(d.append){
   const id=nextId(field),ownership=dot([...d.path,'APPEND']);
   if(plan.recordOwnership[ownership])throw Error('duplicate canonical append owner: '+ownership);
   plan.recordOwnership[ownership]=id;
   const unit={unitId:id,kind:'APPEND',field,shardFile:d.file,shardIndex:0,
    shardPath:path.posix.join(dir,d.file),
    packetSha256:slabPacketSha256,
    recordKeys:[],path:d.path,dependencies:[],unitSpecRevision:1};
   addUnit(plan,queue,unit);continue;
  }
  for(let n=0;n<slab.entries.length;n++){
   const entry=slab.entries[n],id=nextId(field);
   const ownership=dot([...d.path,String(d.startIndex+n)]);
   if(plan.recordOwnership[ownership])throw Error('duplicate canonical record owner: '+ownership);
   plan.recordOwnership[ownership]=id;
   addUnit(plan,queue,{unitId:id,kind:'SHARD',field,shardFile:d.file,
    shardPath:path.posix.join(dir,d.file),
    packetSha256:slabPacketSha256,
    shardIndex:n,recordIndex:d.startIndex+n,
    recordKeys:[entry.key],initialValue:entry.value,path:d.path,
    dependencies:[],unitSpecRevision:1});
  }
 }
 // Preserve semantic prerequisites: target design requires its related reconciliation row,
 // not a blanket dependency on every economic or reconciliation unit.
 if(phase===5){
  const reconc=plan.units.filter(u=>u.field==='reconciliationRecords');
  const novel=plan.units.filter(u=>u.field==='newCandidateRecords');
  const economic=plan.units.filter(u=>u.field==='economicReviewRecords');
  for(const u of plan.units.filter(u=>u.field==='targetDesigns')){
   const candidate=u.initialValue?.candidateKey;
   const linkedEconomic=economic.filter(row=>candidate&&Array.isArray(row.initialValue?.relatedCandidateKeys)&&
    row.initialValue.relatedCandidateKeys.includes(candidate)).map(row=>row.unitId);
   const reconciled=u.kind==='APPEND'?novel.map(row=>row.unitId):
    reconc.filter(row=>candidate&&row.initialValue?.subjectKey===candidate).map(row=>row.unitId);
   u.dependencies=[...new Set([...reconciled,...linkedEconomic])];
  }
 }
 if(phase===6){
  const interpretations=plan.units.filter(u=>['deploymentAssessments','targetDispositions'].includes(u.field));
  const proofs=plan.units.filter(u=>['baselineTestRecords','candidateProofRecords','newCandidateRecords'].includes(u.field));
  // A merged conclusion is global, but obligation rows depend only on matching baseline groups.
  const allPrerequisites=[...interpretations,...proofs].map(u=>u.unitId);
  for(const u of plan.units.filter(u=>u.field==='mergedExecutionConclusions'))
   u.dependencies=allPrerequisites;
  for(const u of plan.units.filter(u=>u.field==='obligationDispositions')){
   const obligationId=u.initialValue?.obligationId;
   u.dependencies=u.kind==='APPEND'?[]:proofs.filter(p=>
    p.field==='baselineTestRecords'&&Array.isArray(p.initialValue?.obligationIds)&&
    p.initialValue.obligationIds.includes(obligationId)).map(p=>p.unitId);
  }
 }
 consolidateNewSemanticUnitsV1({root,campaignPath,phase,plan,queue});
 // Only newly issued available semantic units may transition to dependency-blocked.
 // Reconciliation must never reset persisted ACCEPTED discovery units.
 for(const u of plan.units)if(u.dependencies.length&&queue.units[u.unitId]?.status==='AVAILABLE')
  queue.units[u.unitId].status='BLOCKED_DEPENDENCY';
 const memberIds=new Set(plan.units.flatMap(u=>u.kind==='BATCH'?u.memberUnitIds:[]));
 const missing=new Set(plan.units.flatMap(x=>x.dependencies).filter(id=>!queue.units[id]&&!memberIds.has(id)));
 if(missing.size)throw Error('unsatisfied planner unit references: '+[...missing].join(', '));
}
function validateRequest(request,directory,phase){
 if(request?.schemaVersion!==REQUEST_SCHEMA||!['CLAIM','SUBMIT','RELEASE','FINALIZE'].includes(request.operation))
  throw Error('unsupported v4 request shape/operation');
 for(const key of ['requestId','workerId'])if(!safe(request[key]))throw Error('unsafe '+key);
 if(request.lane!=='AUTO'&&!safe(request.lane))throw Error('invalid lane');
 const common=['schemaVersion','requestId','operation','campaignId','campaignGenerationId','phaseSequence',
  'lane','workerId','sourceSha256','authorityDigest','phaseEpoch','auditControllerRef'];
 const operationFields={
  CLAIM:['desiredUnitCount'],SUBMIT:['items'],RELEASE:['items'],FINALIZE:[]
 };
 const allowed=new Set([...common,...operationFields[request.operation]]);
 for(const key of Object.keys(request))if(!allowed.has(key))throw Error('unexpected controller/request field: '+key);
 assertParallelSolo(directory,phase,request);
 if(request.operation==='CLAIM'){
  if((!Number.isSafeInteger(request.desiredUnitCount)||
    request.desiredUnitCount<1||request.desiredUnitCount>UNIT_POLICY.issueBatchMax)||request.items!==undefined)
   throw Error('CLAIM must request 1–50 units and omit items');
 }else if(request.operation==='SUBMIT'){
  if(!Array.isArray(request.items)||request.items.length<1||request.items.length>UNIT_POLICY.approvalBatchMax)
   throw Error('SUBMIT must explicitly name 1–5 items');
  if(request.items.some(x=>!isObject(x)))throw Error('SUBMIT items must be objects');
  if(new Set(request.items.map(x=>x.unitId)).size!==request.items.length)throw Error('duplicate SUBMIT unit');
  const required=['unitId','claimEpoch','claimToken','packetSha256','submissionPath',
   'submissionSha256','unitSpecRevision'];
  if(request.items.some(x=>!isObject(x)||Object.keys(x).some(key=>!required.includes(key)&&key!=='workerAttemptPath')||
    required.some(key=>!Object.hasOwn(x,key))||
    !safe(x.unitId)||!Number.isSafeInteger(x.claimEpoch)||x.claimEpoch<1||
    !safe(x.claimToken)||!Number.isSafeInteger(x.unitSpecRevision)||x.unitSpecRevision<1||
    !/^[0-9a-f]{64}$/.test(String(x.packetSha256??''))||
    !/^[0-9a-f]{64}$/.test(String(x.submissionSha256??''))||
    typeof x.submissionPath!=='string'||x.submissionPath.length>1024||
    x.submissionPath.startsWith('/')||x.submissionPath.split('/').includes('..')))
   throw Error('SUBMIT item identity, revision, path or hash is malformed');
 }else if(request.operation==='RELEASE'){
  if(!Array.isArray(request.items)||!request.items.length||
    request.items.some(x=>!isObject(x))||
    new Set(request.items.map(x=>x.unitId)).size!==request.items.length||
    request.items.some(x=>Object.keys(x).length!==3||
      !Object.hasOwn(x,'unitId')||!Object.hasOwn(x,'claimEpoch')||
      !Object.hasOwn(x,'claimToken')||!safe(x.unitId)||
      !Number.isSafeInteger(x.claimEpoch)||x.claimEpoch<1||!safe(x.claimToken)))
   throw Error('RELEASE must list only complete distinct owned tokens');
 }else if(request.operation==='FINALIZE'&&
  (request.workerId!=='lite-solo-controller'||request.lane!=='AUTO'))
  throw Error('only the controller may finalize the current phase with AUTO lane');
}
function available(queue,plan,lane='AUTO'){
 return plan.units.filter(u=>['AVAILABLE','RELEASED'].includes(queue.units[u.unitId]?.status)&&depSatisfied(queue,u)
  &&(lane==='AUTO'||u.unitId.startsWith(lane+'-')));
}
function unlock(queue,plan){
 const newIds=[];
 for(const u of plan.units){
  const state=queue.units[u.unitId];
  if(state.status==='BLOCKED_DEPENDENCY'&&depSatisfied(queue,u)){
   state.status='AVAILABLE';newIds.push(u.unitId);
  }
 }
 queue.newlyEligibleUnitIds=newIds;return newIds;
}
// Recover historical Phase-4 discovery units whose ACCEPTED state was overwritten by
// reconciliation dependency setup. Restore only the original controller-accepted,
// source/authority-bound immutable snapshots; never infer acceptance from a worker draft.
function restoreAcceptedDiscoveryV1({root,queue,plan}){
 if(queue.stage!=='RECONCILIATION'||plan.phaseSequence!==4)return [];
 const restored=[];
 for(const u of plan.units){
  if(!['FLOW','ATTACK'].includes(u.kind))continue;
  const state=queue.units[u.unitId];
  if(!state||state.status==='ACCEPTED'||!['AVAILABLE','BLOCKED_DEPENDENCY'].includes(state.status)||
     !state.acceptedPath||!state.acceptedSha256)continue;
  const accepted=read(root,state.acceptedPath);
  if(accepted.schemaVersion!==UNIT_ARTIFACT_SCHEMAS.accepted||accepted.unitId!==u.unitId||
     accepted.phaseSequence!==4||accepted.phaseEpoch!==queue.phaseEpoch||
     accepted.campaignGenerationId!==queue.campaignGenerationId||
     accepted.sourceSha256!==queue.sourceSha256||accepted.authorityDigest!==queue.authorityDigest||
     accepted.unitSpecRevision!==u.unitSpecRevision||
     accepted.packetSha256!==u.packetSha256||
     accepted.workerId!==state.workerId||accepted.claimEpoch!==state.claimEpoch||
     accepted.submissionSha256!==state.acceptedSha256||
     accepted.submission?.unitId!==u.unitId)
   throw Error('accepted discovery recovery identity mismatch: '+u.unitId);
  state.status='ACCEPTED';restored.push(u.unitId);
 }
 return restored;
}
function noWork(queue,plan){
 if(plan.units.every(u=>queue.units[u.unitId].status==='ACCEPTED'))return 'PHASE_COMPLETE';
 if(plan.units.some(u=>queue.units[u.unitId].status==='REWORK_REQUIRED'))return 'AWAITING_WORKER_SUBMISSION';
 // Pending approval and already-held independent work are actionable distinctions.
 // Dependencies are reported only when no pending approval or in-flight claim exists.
 if(plan.units.some(u=>queue.units[u.unitId].status==='SUBMITTED'))return 'AWAITING_APPROVAL';
 if(plan.units.some(u=>queue.units[u.unitId].status==='CLAIMED'))return 'ALL_WORK_CLAIMED';
 if(plan.units.some(u=>queue.units[u.unitId].status==='BLOCKED_DEPENDENCY'))return 'AWAITING_WORKER_SUBMISSION';
 if(available(queue,plan).length)return 'AWAITING_WORKER_SUBMISSION';
 return 'NO_ELIGIBLE_WORK';
}
function batchIndex(root,campaign,phase,requestId,units){
 const dir=path.posix.join(rootOf(campaign,phase),'claims',requestId);
 const pages=[];
 for(let i=0;i<units.length;i+=4){
  const file='BATCH_PAGE_'+String(pages.length+1).padStart(4,'0')+'_v1.json';
  const rel=path.posix.join(dir,file);
  const page={schemaVersion:'curveyield-lite-solo-unit-batch-page-v1',
   units:units.slice(i,i+4)};put(root,rel,page);
  if(Buffer.byteLength(pretty(page))>32768)throw Error('claim index exceeds 32 KiB');
  pages.push({path:rel,sha256:sha(page)});
 }
 const index={schemaVersion:'curveyield-lite-solo-unit-batch-index-v1',
  count:units.length,pages,readingGuide:'Read claimed packetPath and verify packetSha256. BATCH packets are paged prefill manifests: reconstruct the value from digest-checked prefill-pages, preserve each member recordKeys[0] as entries[].key, and submit one multi-entry snapshot under the batch claim. Rework only outstanding member records; accepted siblings remain immutable. For other units use the original one-record form. Commit source/authority-bound immutable worker/claim-epoch/attempt submissions and enqueue 1–5-unit SUBMIT requests. Claim at most 50; only persisted accepted original records unlock dependents.'};
 const rel=path.posix.join(dir,'BATCH_INDEX_v1.json');put(root,rel,index);
 return rel;
}
// Reclaimed units must refer to the original issued bytes, not a shard that
// has been updated by a prior assembly. New units retain the frozen plan SHA.
function issuedPacketDigestForClaimV1({root,campaign,phase,queue,plan,u,state}){
 if(typeof u.packetSha256==='string')return u.packetSha256;
 const prefix=unitBase(campaign,phase,u.unitId)+'/';
 if(typeof state?.acceptedPath==='string'&&state.acceptedPath.startsWith(prefix)){
  try{
   const prior=read(root,state.acceptedPath);
   if(prior.unitId===u.unitId&&
      prior.campaignGenerationId===plan.campaignGenerationId&&
      prior.sourceSha256===plan.sourceSha256&&
      prior.authorityDigest===plan.authorityDigest&&
      prior.phaseSequence===phase&&prior.phaseEpoch===queue.phaseEpoch&&
      prior.unitSpecRevision===u.unitSpecRevision&&
      prior.submissionSha256===state.acceptedSha256&&
      /^[a-f0-9]{64}$/.test(String(prior.packetSha256??'')))
    return prior.packetSha256;
  }catch{/* The original packet is not available for this claim. */}
 }
 return hex(fs.readFileSync(repoFile(root,u.packetPath??u.shardPath)));
}
function handleClaim({root,campaign,phase,queue,plan,request}){
 const held=Object.values(queue.units).filter(u=>u.workerId===request.workerId&&u.status==='CLAIMED').length;
 const capacity=Math.max(0,UNIT_POLICY.issueBatchMax-held);
 const eligible=available(queue,plan,request.lane),selected=eligible.slice(0,Math.min(capacity,request.desiredUnitCount));
 const units=selected.map(u=>{
  const state=queue.units[u.unitId];state.status='CLAIMED';state.workerId=request.workerId;
  state.claimEpoch++;state.claimToken=randomUUID();
  return {unitId:u.unitId,claimEpoch:state.claimEpoch,claimToken:state.claimToken,
   packetPath:u.packetPath??u.shardPath,packetIndexPath:u.packetIndexPath??null,
   packetSha256:issuedPacketDigestForClaimV1({root,campaign,phase,queue,plan,u,state}),
   unitSpecRevision:u.unitSpecRevision};
 });
 const claimId=units.length?'claim-'+request.requestId:null;
 return {status:units.length?'CLAIMED':capacity===0?'WORKER_CLAIM_LIMIT_REACHED':noWork(queue,plan),
  claimId,claimedUnits:units,
  batchIndexPath:units.length?batchIndex(root,campaign,phase,request.requestId,units):null};
}
function itemIdentity(item,u,state,request,root,campaign,phase){
 if(!u||!state)return 'WAITING_SUBMISSION';
 // An accepted snapshot is immutable even when a later attempt arrives.
 if(state.status==='ACCEPTED')
  return state.acceptedSha256===item.submissionSha256?'UNCHANGED':'STALE';
 if(state.workerId!==request.workerId||
    item.claimEpoch!==state.claimEpoch||item.claimToken!==state.claimToken||
    item.unitSpecRevision!==u.unitSpecRevision||
    !['CLAIMED','SUBMITTED','REWORK_REQUIRED'].includes(state.status))return 'STALE';
 const packetRel=u.packetPath??u.shardPath;
 const livePacketSha256=u.packetSha256??hex(fs.readFileSync(repoFile(root,packetRel)));
 let packetBound=item.packetSha256===livePacketSha256;
 if(!packetBound&&state.acceptedPath&&state.acceptedSha256){
  const previous=maybe(root,state.acceptedPath);
  packetBound=previous?.unitId===u.unitId&&
   previous.campaignGenerationId===request.campaignGenerationId&&
   previous.sourceSha256===request.sourceSha256&&
   previous.authorityDigest===request.authorityDigest&&
   previous.phaseSequence===request.phaseSequence&&
   previous.phaseEpoch===request.phaseEpoch&&
   previous.unitSpecRevision===u.unitSpecRevision&&
   previous.packetSha256===item.packetSha256&&
   previous.submissionSha256===state.acceptedSha256;
 }
 if(!packetBound)return 'STALE';
 const allowed=path.posix.join(unitBase(campaign,phase,u.unitId),
   'submissions',request.workerId,'epoch-'+state.claimEpoch);
 const name=typeof item.submissionPath==='string'&&item.submissionPath.startsWith(allowed+'/')
   ?item.submissionPath.slice(allowed.length+1):'';
 if(!/^(?:controller-compiled\/)?SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(name))
  return 'STALE';
 const file=repoFile(root,item.submissionPath);
 if(!fs.existsSync(file))return 'WAITING_SUBMISSION';
 return hex(fs.readFileSync(file))===item.submissionSha256?null:'STALE';
}
// No security or semantic submission validation is performed by GitHub.
// This function remains only for compatibility with existing callers.
function validateShardUnit(){return [];}
// Exact issued record identities are part of the controller's packaging
// contract. These checks do not judge any security finding or AI conclusion.
function assertSubmissionEnvelopeV1(u,submission){
 if(!submission||typeof submission!=='object'||Array.isArray(submission))
  throw Error('submission is not a JSON object');
 if(u.kind==='FLOW'||u.kind==='ATTACK'){
  const schema=u.kind==='FLOW'?'curveyield-flow-review-submission-v1':
   'curveyield-attack-submission-v1';
  if(submission.schemaVersion!==schema||submission.unitId!==u.unitId)
   throw Error('discovery submission does not match the issued unit');
  return;
 }
 if(submission.schemaVersion!=='curveyield-lite-solo-unit-submission-v1'||
    !Array.isArray(submission.entries))
  throw Error('semantic submission envelope does not match the issued schema');
 const entries=submission.entries;
 if(entries.some(x=>!x||typeof x!=='object'||typeof x.key!=='string'||
    !Object.hasOwn(x,'value'))||
    new Set(entries.map(x=>x.key)).size!==entries.length)
  throw Error('duplicate or malformed issued record identities');
 if(u.kind==='SHARD'){
  if(entries.length!==1||entries[0].key!==u.recordKeys?.[0])
   throw Error('fixed record identity or count differs from issued shard');
 }else if(u.kind==='BATCH'){
  const expected=u.members.map(x=>x.recordKeys?.[0]);
  if(entries.length!==expected.length||
     entries.some(x=>!expected.includes(x.key)))
   throw Error('batch record identity/count differs from issued members');
 }else if(u.kind==='APPEND'){
  if(entries.length>1024)throw Error('APPEND exceeds per-chunk controller capacity');
  const prefix=JSON.stringify(u.path),chunk=u.appendChunkNumber??1;
  for(let i=0;i<entries.length;i++){
   const expected=chunk>1?
    prefix+':APPEND-C'+String(chunk).padStart(4,'0')+'-'+
     String(i+1).padStart(4,'0'):
    prefix+':APPEND-'+String(i+1).padStart(4,'0');
   if(entries[i]?.key!==expected)
    throw Error('APPEND changed its controller-assigned chunk record identity');
  }
  if(submission.appendContinuation!==undefined&&
     typeof submission.appendContinuation!=='boolean')
   throw Error('APPEND continuation request must be explicitly boolean');
  // A full accepted chunk is always independently bounded. The next chunk
  // is another issued unit, never an extension of these accepted bytes.
  const slab={schemaVersion:'curveyield-work-shard-v13',kind:'array',
   path:u.path,startIndex:u.appendOrdinalStart??0,entries};
  if(Buffer.byteLength(pretty(slab))>1024*1024)
   throw Error('APPEND_CHUNK_TRANSPORT_LIMIT: supply a smaller chunk');
 }
}
function acceptBatchRecordsV1({root,campaign,phase,u,submission,queue,plan,state,request,digest}){
 // Retain exactly the records MiMo supplied, in Worker-issued member order.
 // Missing records are never fabricated or pronounced correct by GitHub.
 const entries=Array.isArray(submission?.entries)?submission.entries:[];
 const ordered=u.members.flatMap(member=>entries.filter(entry=>entry?.key===member.recordKeys?.[0]));
 const refs=[];queue.acceptedRecords??={};
 for(const member of u.members){
  const entry=ordered.find(item=>item?.key===member.recordKeys?.[0]);
  if(!entry)continue;
  const rel=path.posix.join(unitBase(campaign,phase,u.unitId),'records',member.unitId,
   'ACCEPTED_ATTEMPT_'+String(state.attempts+1).padStart(3,'0')+'_v1.json');
  const snapshot={schemaVersion:'curveyield-lite-solo-accepted-record-v1',unitId:u.unitId,
   memberUnitId:member.unitId,recordKey:entry.key,campaignGenerationId:plan.campaignGenerationId,
   sourceSha256:plan.sourceSha256,authorityDigest:plan.authorityDigest,phaseSequence:phase,
   phaseEpoch:plan.phaseEpoch,claimEpoch:state.claimEpoch,workerId:request.workerId,
   submissionSha256:digest,prerequisiteEvidence:prerequisiteEvidence(queue,member.dependencies),
   entry,validationDelegatedTo:'CLOUDFLARE_WORKER'};
  put(root,rel,snapshot);
  queue.acceptedRecords[member.unitId]={status:'ACCEPTED',path:rel,
   snapshotSha256:sha(snapshot),parentUnitId:u.unitId};refs.push(rel);
 }
 // The ordered accepted snapshot is authoritative for BATCH member
 // positions. Preserve optional authored question links and translate their
 // original entry ordinal to the accepted member ordinal, retaining the raw
 // selector separately. A missing link remains unresolved, not a veto.
 const links=Array.isArray(submission.questionRecordLinks)?
  submission.questionRecordLinks.map(link=>{
   if(!isObject(link))return clone(link);
   const source=typeof link.acceptedOutputSelector==='string'?
    link.acceptedOutputSelector:link.outputSelector;
   let acceptedOutputSelector=source;
   if(typeof source==='string'&&source.startsWith('entries[')){
    const end=source.indexOf(']');
    const ordinal=Number(source.slice(8,end));
    const member=end>8&&Number.isSafeInteger(ordinal)&&ordinal>=0?
     entries[ordinal]:null;
    const position=member?
     ordered.findIndex(e=>e?.key===member.key):-1;
    if(position>=0&&source.slice(end+1).startsWith('.value'))
     acceptedOutputSelector='entries['+position+']'+source.slice(end+1);
   }else if(typeof link.recordKey==='string'){
    const position=ordered.findIndex(e=>e?.key===link.recordKey);
    if(position>=0)acceptedOutputSelector='entries['+position+'].value';
   }
   return {...clone(link),
    ...(typeof source==='string'?{sourceAuthoredOutputSelector:
     link.sourceAuthoredOutputSelector??source}:{}),
    ...(typeof acceptedOutputSelector==='string'?{acceptedOutputSelector}:{})};
  }):null;
 return {errors:[],assembledSubmission:{
  schemaVersion:UNIT_ARTIFACT_SCHEMAS.submission,entries:ordered,
  ...(links?{questionRecordLinks:links}:{}),
  ...(submission.questionRecordLinks!==undefined&&!links?
   {unmappedQuestionRecordLinks:clone(submission.questionRecordLinks)}:{}),
  ...(submission.unmappedQuestionRecordLinks!==undefined?
   {unmappedQuestionRecordLinks:clone(submission.unmappedQuestionRecordLinks)}:{})
 },recordEvidenceRefs:refs};
}
// Source provenance is optional evidence metadata and never an acceptance gate.
// The original Worker path comes from the GitHub adapter, not from an inferred
// controller-compiled filename.
function originalWorkerAttemptReferenceV1({root,campaign,phase,unitId,request,item,state,digest}){
 const sourcePath=typeof item.workerAttemptPath==='string'?item.workerAttemptPath:
  item.submissionPath.includes('/controller-compiled/')?null:item.submissionPath;
 const prefix=path.posix.join(unitBase(campaign,phase,unitId),
  'submissions',request.workerId,'epoch-'+state.claimEpoch)+'/';
 if(!sourcePath||!sourcePath.startsWith(prefix)||
    !/^SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(sourcePath.slice(prefix.length)))
  return {availability:'NOT_RECORDED'};
 if(sourcePath===item.submissionPath)
  return {availability:'AVAILABLE',path:sourcePath,sha256:digest,
   relation:'DIRECT_WORKER_SUBMISSION'};
 try{
  const originalBytes=fs.readFileSync(repoFile(root,sourcePath));
  return {availability:'AVAILABLE',path:sourcePath,sha256:hex(originalBytes),
   relation:'EXPLICIT_GITHUB_ADAPTER_SOURCE'};
 }catch{
  return {availability:'SOURCE_UNAVAILABLE',path:sourcePath,sha256:null};
 }
}
// Original ATTACK extra records are source evidence even if their flow IDs
// cannot be placed in the issued-flow canonical attackPaths collection.
// Never classify, repair, or drop the Worker-authored records here.
function unmappedAttackPathProvenanceV1({root,campaign,u,originalWorkerAttempt,submission=null}){
 const missing=status=>({status,refs:[],allRefs:[],candidateRefs:[]});
 if(originalWorkerAttempt?.availability!=='AVAILABLE')
  return missing(originalWorkerAttempt?.availability??'ORIGINAL_ATTEMPT_UNAVAILABLE');
 const sourcePath=originalWorkerAttempt.path,sourceSha=originalWorkerAttempt.sha256;
 if(typeof sourcePath!=='string'||
    !sourcePath.startsWith(unitBase(campaign,4,u.unitId)+'/submissions/')||
    !/^[a-f0-9]{64}$/.test(String(sourceSha??'')))
  return missing('ORIGINAL_ATTEMPT_IDENTITY_UNAVAILABLE');
 try{
  const sourceBytes=fs.readFileSync(repoFile(root,sourcePath));
  if(hex(sourceBytes)!==sourceSha)return missing('ORIGINAL_ATTEMPT_HASH_MISMATCH');
  const original=JSON.parse(sourceBytes.toString('utf8'));
  const isBound=original?.schemaVersion==='curveyield-machine-bound-answers-v1';
  const isDirect=original?.schemaVersion==='curveyield-attack-submission-v1';
  if(!isBound&&!isDirect)return missing('UNSUPPORTED_ORIGINAL_ATTACK_REPRESENTATION');
  const extras=original?.extraRecords?.attackPaths;
  if(extras===undefined)return missing('NO_EXTRA_ATTACK_PATHS');
  if(!Array.isArray(extras))return missing('EXTRA_ATTACK_PATHS_UNREADABLE');
  let issuedFlows=null,fixedCount=0;
  try{
   const packet=readUnitPacketV1({root,packetPath:u.packetPath});
   if(packet?.payload?.unitId===u.unitId&&Array.isArray(packet.payload.flowIds)){
    issuedFlows=new Set(packet.payload.flowIds);
    // Fixed attack-path entries are one per originally issued flow position,
    // even if two issued positions contain the same flow ID.
    fixedCount=packet.payload.flowIds.length;
   }
  }catch{/* Missing packet does not block acceptance. */}
  const refs=[],allRefs=[],candidateRefs=[];let mappedCount=0;
  extras.forEach((record,index)=>{
   const ids=record?.flowIds;
   const mappingStatus=!issuedFlows?'ISSUED_FLOWS_UNAVAILABLE':
    !Array.isArray(ids)?'MISSING_FLOW_IDS_ARRAY':
    !ids.length?'NO_EXPLICIT_FLOW_IDS':
    ids.some(id=>!issuedFlows.has(id))?'UNISSUED_FLOW_IDS':
    isDirect?'DIRECT_EXTRA_NOT_IN_CANONICAL_PATHS':null;
   // Only the bound-answer compiler places issued-flow extras in the ordinary
   // attackPaths collection. Raw direct extraRecords stay source evidence.
   const canonicalIndex=!mappingStatus?fixedCount+mappedCount++:null;
   const acceptedSelector=canonicalIndex!==null&&
    Array.isArray(submission?.attackPaths)&&canonicalIndex<submission.attackPaths.length
     ?'submission.attackPaths['+canonicalIndex+']':null;
   const status=mappingStatus??(acceptedSelector?'MAPPED_ISSUED_FLOW':
    'COMPILED_EXTRA_SOURCE_UNAVAILABLE');
   const selector='extraRecords.attackPaths['+index+']';
   const fields=record&&typeof record==='object'&&!Array.isArray(record)?record:{};
   const ref={
    originalIndex:index,mappingStatus:status,sourceSelector:selector,
    acceptedSelector,
    originalFlowIds:ids===undefined?null:structuredClone(ids),
    originalPathId:fields.pathId??null,
    originalAnchorsSelector:Object.hasOwn(fields,'anchors')?selector+'.anchors':null,
    originalCandidateSelector:Object.hasOwn(fields,'candidate')?selector+'.candidate':null,
    originalCandidatesSelector:Object.hasOwn(fields,'candidates')?selector+'.candidates':null,
    originalReasoningSelector:Object.hasOwn(fields,'reasoning')?selector+'.reasoning':null,
    originalWorkerAttempt:{availability:'AVAILABLE',path:sourcePath,sha256:sourceSha}
   };
   allRefs.push(ref);
   if(!acceptedSelector){
    refs.push(ref);
    // Preserve every EXPLICIT original nested candidate as its own independent
    // source-bound lead, even when the parent ATTACK flow is not issued.
    // Neither its content nor its source relationship is a security verdict.
    const addOriginalCandidate=(candidate,candidateSelector,kind,candidateIndex)=>{
     if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return;
     candidateRefs.push({
      sourceSelector:candidateSelector,parentSourceSelector:selector,
      originalPathIndex:index,originalPathId:fields.pathId??null,
      originalFlowIds:ids===undefined?null:structuredClone(ids),
      mappingStatus:status,unitId:u.unitId,
      candidateKind:kind,originalCandidateIndex:candidateIndex,
      originalCandidateValueSha256:hex(JSON.stringify(candidate)),
      originalWorkerAttempt:{availability:'AVAILABLE',path:sourcePath,sha256:sourceSha}
     });
    };
    if(Object.hasOwn(fields,'candidate'))
     addOriginalCandidate(fields.candidate,selector+'.candidate','SINGULAR',null);
    if(Array.isArray(fields.candidates))
     fields.candidates.forEach((candidate,j)=>
      addOriginalCandidate(candidate,selector+'.candidates['+j+']','PLURAL',j));
   }
  });
  return {status:issuedFlows?'COLLECTED_NONBLOCKING':'ISSUED_FLOWS_UNAVAILABLE',
   refs,allRefs,candidateRefs};
 }catch{return missing('ORIGINAL_ATTEMPT_UNREADABLE');}
}
function acceptSubmission({root,campaign,phase,request,item,queue,plan,directory}){
 const u=plan.units.find(x=>x.unitId===item.unitId),state=queue.units[item.unitId];
 if(!u||!state)return {unitId:item.unitId,status:'WAITING_SUBMISSION',errors:[]};
 const file=repoFile(root,item.submissionPath);
 if(!fs.existsSync(file)){state.status='SUBMITTED';return {unitId:item.unitId,status:'WAITING_SUBMISSION',errors:[]};}
 const raw=fs.readFileSync(file),digest=hex(raw);
 if(digest!==item.submissionSha256)return {unitId:item.unitId,status:'STALE'};
 // JSON parsing is transport decoding only; no schema, security or content checks.
 const submission=JSON.parse(raw.toString('utf8'));
 assertSubmissionEnvelopeV1(u,submission);
 let batchOutcome=null;
 if(u.kind==='BATCH')batchOutcome=acceptBatchRecordsV1({
  root,campaign,phase,u,submission,queue,plan,state,request,digest});
 state.status='SUBMITTED';state.lastSubmissionSha256=digest;state.attempts++;
 const resultRel=path.posix.join(unitBase(campaign,phase,u.unitId),'results',
  'ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
 const acceptedRel=path.posix.join(unitBase(campaign,phase,u.unitId),
  'ACCEPTED_ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
 const questionLedger=questionLedgerReferenceV1({root,campaign,phase,unitId:u.unitId,
  directory,phaseEpoch:request.phaseEpoch,packetSha256:item.packetSha256});
 const isDiscovery=u.kind==='FLOW'||u.kind==='ATTACK';
 // Preserve this independently for ALL accepted unit kinds, including
 // SHARD/BATCH/APPEND. A compiled submission is not the original AI attempt.
 const sourceProvenance={
  schemaVersion:isDiscovery?'curveyield-discovery-source-provenance-v1':
   'curveyield-semantic-unit-source-provenance-v1',
  submittedPath:item.submissionPath,submittedSha256:digest,
  submittedRepresentation:item.submissionPath.includes('/controller-compiled/')
   ?'CONTROLLER_COMPILED':'DIRECT_WORKER_SUBMISSION',
  originalWorkerAttempt:originalWorkerAttemptReferenceV1({
   root,campaign,phase,unitId:u.unitId,request,item,state,digest})
 };
 if(u.kind==='ATTACK'){
  const extra=unmappedAttackPathProvenanceV1({
   root,campaign,u,originalWorkerAttempt:sourceProvenance.originalWorkerAttempt,submission});
  sourceProvenance.extraAttackPathRefs=extra.allRefs;
  sourceProvenance.unmappedAttackPathRefs=extra.refs;
  sourceProvenance.unmappedAttackCandidateRefs=extra.candidateRefs;
  sourceProvenance.unmappedAttackPathExtractionStatus=extra.status;
 }
 put(root,acceptedRel,{schemaVersion:'curveyield-lite-solo-accepted-unit-v1',unitId:u.unitId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  authorityDigest:directory.authorityDigest,phaseSequence:phase,phaseEpoch:request.phaseEpoch,
  unitSpecRevision:u.unitSpecRevision,packetSha256:item.packetSha256,
  workerId:request.workerId,claimEpoch:state.claimEpoch,submissionSha256:digest,
  prerequisiteEvidence:prerequisiteEvidence(queue,u.dependencies),
  submission:batchOutcome?.assembledSubmission??submission,
  ...(batchOutcome?.recordEvidenceRefs?{recordEvidenceRefs:batchOutcome.recordEvidenceRefs}:{}),
  ...(sourceProvenance?{sourceProvenance}:{}),
  questionLedger,
  validationDelegatedTo:'CLOUDFLARE_WORKER',githubContentValidationPerformed:false});
 state.status='ACCEPTED';state.acceptedSha256=digest;state.acceptedPath=acceptedRel;state.lastErrors=[];
 if(isDiscovery)state.acceptedArtifactSha256=hex(fs.readFileSync(repoFile(root,acceptedRel)));
 put(root,resultRel,{unitId:u.unitId,status:'ACCEPTED',submissionSha256:digest,
  acceptedPath:acceptedRel,validationDelegatedTo:'CLOUDFLARE_WORKER'});
 return {unitId:u.unitId,status:'ACCEPTED',resultRef:resultRel};
}
function handleSubmit({root,campaign,phase,queue,plan,request,directory}){
 const items=[];
 for(const item of request.items){
  const state=queue.units[item.unitId],u=plan.units.find(x=>x.unitId===item.unitId);
  try{
   const identity=itemIdentity(item,u,state,request,root,campaign,phase);
   if(identity){
    if(identity==='WAITING_SUBMISSION'&&state?.workerId===request.workerId)
     state.status='SUBMITTED';
    items.push({unitId:item.unitId,status:identity});
    continue;
   }
   if(state.status==='CLAIMED')state.status='SUBMITTED';
   items.push(acceptSubmission({root,campaign,phase,request,item,queue,plan,directory}));
  }catch(e){
   const reason=String(e.message??e);
   // A transport failure must retain the original claim, not produce acceptance.
   if(state&&state.workerId===request.workerId&&
      state.claimEpoch===item.claimEpoch&&state.claimToken===item.claimToken){
    state.status='SUBMITTED';state.lastErrors=[reason];
   }
   items.push({unitId:item.unitId,status:'WAITING_SUBMISSION',transportError:reason});
  }
 }
 const newlyEligibleUnits=unlock(queue,plan);
 return {status:'SUBMISSION_RECORDED',acceptedUnits:items.filter(x=>x.status==='ACCEPTED').map(x=>x.unitId),
  reworkUnits:items.filter(x=>x.status==='REWORK_REQUIRED'),
  staleUnits:items.filter(x=>x.status==='STALE'),unchangedUnits:items.filter(x=>x.status==='UNCHANGED'),
  waitingUnits:items.filter(x=>x.status==='WAITING_SUBMISSION'),newlyEligibleUnits};
}
function handleRelease({queue,plan,request}){
 const changed=[];
 for(const item of request.items){
  const s=queue.units[item.unitId];
  if(!s||s.workerId!==request.workerId||s.claimEpoch!==item.claimEpoch||
   s.claimToken!==item.claimToken||s.status==='ACCEPTED')continue;
  // Preserve drafts and the previous epoch while making this unit eligible again.
  // The next claim increments the epoch, invalidating the released owner's token.
  s.status='RELEASED';s.workerId=null;s.claimToken=null;changed.push(item.unitId);
 }
 const unblocked=unlock(queue,plan);
 queue.newlyEligibleUnitIds=[...new Set([...changed,...unblocked])];
 return {status:'RELEASED',releasedUnits:changed,newlyEligibleUnits:queue.newlyEligibleUnitIds};
}
function discoveryInput(root,campaign,name){return read(root,reviewInventoryRelV1(root,campaign,name));}
function finishDiscovery({root,campaign,directory,plan,queue,automationRoot}){
 const items=plan.units.filter(u=>['FLOW','ATTACK'].includes(u.kind));
 if(!items.every(u=>queue.units[u.unitId]?.status==='ACCEPTED'))return false;
 if(queue.stage==='RECONCILIATION')return true;
 const state={schemaVersion:'curveyield-discovery-state-v1',campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  generatedAt:new Date().toISOString(),payload:{reviewPolicy:'correctness-verdict-v13',gaps:asArray(discoveryInput(root,campaign,'FLOW_PLAN_v1.json').payload?.gaps)}};
 const acceptedSubmissions=items.map(u=>{
  const acceptedPath=queue.units[u.unitId].acceptedPath;
  const acceptedBytes=fs.readFileSync(repoFile(root,acceptedPath));
  const accepted=JSON.parse(acceptedBytes.toString('utf8'));
  const reconstructed=u.kind==='ATTACK'?unmappedAttackPathProvenanceV1({
   root,campaign,u,originalWorkerAttempt:accepted.sourceProvenance?.originalWorkerAttempt,
   submission:accepted.submission}):null;
  const extra=u.kind==='ATTACK'?{
   refs:Array.isArray(accepted.sourceProvenance?.unmappedAttackPathRefs)
    ?accepted.sourceProvenance.unmappedAttackPathRefs:reconstructed.refs,
   allRefs:Array.isArray(accepted.sourceProvenance?.extraAttackPathRefs)
    ?accepted.sourceProvenance.extraAttackPathRefs:reconstructed.allRefs,
   status:accepted.sourceProvenance?.unmappedAttackPathExtractionStatus??
    reconstructed.status,
   candidateRefs:Array.isArray(accepted.sourceProvenance?.unmappedAttackCandidateRefs)?
    accepted.sourceProvenance.unmappedAttackCandidateRefs:reconstructed.candidateRefs
  }:null;
  return {unitId:u.unitId,submission:accepted.submission,
   sourceReference:{phaseSequence:4,unitId:u.unitId,acceptedPath,
    acceptedSha256:hex(acceptedBytes),sourceSelectorPrefix:'submission',
    submittedPath:accepted.sourceProvenance?.submittedPath??null,
    submittedSha256:accepted.sourceProvenance?.submittedSha256??
     accepted.submissionSha256??null,
    submittedRepresentation:accepted.sourceProvenance?.submittedRepresentation??
     'HISTORICAL_ACCEPTED_SUBMISSION',
    originalWorkerAttempt:accepted.sourceProvenance?.originalWorkerAttempt??
     {availability:'NOT_RECORDED'},
    ...(extra?{unmappedAttackPathRefs:extra.refs,
     unmappedAttackCandidateRefs:extra.candidateRefs,
     extraAttackPathRefs:extra.allRefs,
     unmappedAttackPathExtractionStatus:extra.status}:{})}};
 });
 const inventory=discoveryInput(root,campaign,'REVIEW_INVENTORY_v1.json');
 const summary=buildDiscoverySummaryV1({state,inventory,plan:discoveryInput(root,campaign,'FLOW_PLAN_v1.json'),
  acceptedSubmissions,taxonomy:loadTaxonomyV1(automationRoot),now:new Date().toISOString()});
 put(root,path.posix.join(campaign,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json'),summary);
 put(root,path.posix.join(campaign,'work/phase-06/BASELINE_OBLIGATIONS_v1.json'),
  deriveBaselineObligationsV1({inventory,taxonomy:loadTaxonomyV1(automationRoot),summary}));
 // The original phase prefill is authoritative; refresh once, after complete discovery.
 const assignment=directory.currentAssignment;
 const form={...read(root,path.posix.join(authorityFor(directory),'phases/phase-4/resources/PHASE_04_WORK_FORM_TEMPLATE_v1.json'))};
 const updated=applyPhaseBoundaryPrefill({root,campaignPath:campaign,authorityRoot:authorityFor(directory),sequence:4,
  form,derivedInputPaths:[...asArray(assignment.derivedInputPaths),path.posix.join(campaign,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json')],
  predecessorReceiptPath:assignment.predecessorReceiptPath});
 // Discovery reconstructs the Phase-4 work form; preserve the original
 // receipt-bound references from every earlier accepted substantive phase.
 attachOriginalCanonicalEvidenceRefsV1({
   root,campaignPath:campaign,directory,sequence:4,form:updated});
 // FLOW and ATTACK histories are available to the reconciliation packets of
 // THIS SAME PHASE, before there is any sealed phase-4 canonical output.
 // Original accepted snapshots and original checkpoint files stay untouched.
 const phaseQuestionHistory=items.map(unit=>recoverAcceptedQuestionLedgerReferenceV1({
  root,campaignPath:campaign,phase:4,unitId:unit.unitId,
  directory,queue,plan}));
 updated.automationInputs.questionHistoryRefs=phaseQuestionHistory;
 // Phase-4 reconciliation begins before Phase 4 has a sealed canonical.
 // Make the original accepted FLOW/ATTACK output rows and question histories
 // retrievable NOW, including explicitly linked and unpromoted answers.
 // This is an index of exact accepted bytes, not an inferred relationship.
 updated.automationInputs.discoveryQuestionOutputSourceRefs=
  acceptedSubmissions.map(source=>({
   phaseSequence:4,unitId:source.unitId,
   acceptedUnitPath:source.sourceReference.acceptedPath,
   acceptedUnitArtifactSha256:source.sourceReference.acceptedSha256,
   acceptedSubmissionSelector:'submission',
   questionHistorySource:phaseQuestionHistory.find(
    ref=>ref.unitId===source.unitId)??null,
   explicitQuestionLinkSelector:
    Array.isArray(source.submission?.questionRecordLinks)?
     'submission.questionRecordLinks':null,
   originalQuestionHistoryStatus:
    phaseQuestionHistory.find(ref=>ref.unitId===source.unitId)?.availability??
     'HISTORY_SOURCE_UNAVAILABLE'
  }));
 updated.automationInputs.controllerOwnedAutomationInputs=[...new Set([
  ...(updated.automationInputs.controllerOwnedAutomationInputs??[]),
  'questionHistoryRefs','discoveryQuestionOutputSourceRefs'])];
 refreshControllerPrefillDigest(updated);
 put(root,assignment.workFormPath,updated);
 const shards=secureShardWorkFormV13({root,formRel:assignment.workFormPath,phase:4,retireFull:true});
 assignment.workShardIndexPath=shards.indexRel;
 assignment.controllerPrefillDigestSha256=updated.automationInputs?.controllerPrefillDigestSha256;
 addShardUnits({root,campaignPath:campaign,directory,phase:4,plan,queue});
 queue.stage='RECONCILIATION';plan.stage='RECONCILIATION';
 unlock(queue,plan);return true;
}
// A source-authored appendContinuation:true on an ACCEPTED bounded unit
// explicitly requests another unit in that same issued APPEND family.
// This only issues work; it does not synthesize an accepted submission.
function issueAcceptedAppendContinuationsV1({root,campaign,phase,plan,queue}){
 const created=[];
 for(const previous of [...plan.units]){
  if(previous.kind!=='APPEND'||queue.units?.[previous.unitId]?.status!=='ACCEPTED')
   continue;
  const accepted=read(root,queue.units[previous.unitId].acceptedPath);
  if(accepted?.submission?.appendContinuation!==true)continue;
  if(!Array.isArray(accepted.submission.entries))continue;
  const chunk=(previous.appendChunkNumber??1)+1;
  if(!Number.isSafeInteger(chunk))
   throw Error('APPEND_CONTINUATION_ORDINAL_EXCEEDS_SAFE_INTEGER: '+previous.unitId);
  const seriesId=previous.appendSeriesUnitId??previous.unitId;
  const unitId=seriesId+'-C'+String(chunk).padStart(4,'0');
  const existing=plan.units.find(unit=>unit.unitId===unitId);
  if(existing){
   if(existing.kind!=='APPEND'||existing.continuationAfterUnitId!==previous.unitId||
      existing.appendChunkNumber!==chunk||existing.appendSeriesUnitId!==seriesId)
    throw Error('APPEND_CONTINUATION_ISSUED_IDENTITY_CONFLICT: '+unitId);
   continue; // Replay is idempotent; never issue a duplicate.
  }
  const primaryStart=Number.isInteger(previous.appendOrdinalStart)?
   previous.appendOrdinalStart:read(root,previous.shardPath).startIndex;
  if(!Number.isSafeInteger(primaryStart)||primaryStart<0)
   throw Error('APPEND_CONTINUATION_ISSUED_START_UNAVAILABLE: '+unitId);
  const nextStart=primaryStart+accepted.submission.entries.length;
  const packetPath=path.posix.join(unitBase(campaign,phase,unitId),
   'ASSIGNMENT_PACKET_v1.json');
  const packet={schemaVersion:'curveyield-work-shard-v13',kind:'array',
   path:previous.path,startIndex:nextStart,entries:[],
   appendChunkNumber:chunk,appendSeriesUnitId:seriesId,
   continuationAfterUnitId:previous.unitId,
   continuationInstructions:'Supply at most 1024 typed APPEND records and at most 1 MiB of serialized shard data. Set appendContinuation:true ONLY when another independent bounded unit is required. Original entries and issued metadata remain immutable.'};
  put(root,packetPath,packet);
  const idKey=dot([...previous.path,'APPEND-C'+String(chunk).padStart(4,'0')]);
  if(plan.recordOwnership[idKey])throw Error('continuation ownership already issued: '+idKey);
  const next={unitId,kind:'APPEND',field:previous.field,
   shardFile:previous.shardFile,shardPath:previous.shardPath,
   packetPath,packetSha256:hex(fs.readFileSync(repoFile(root,packetPath))),
   appendChunkNumber:chunk,appendSeriesUnitId:seriesId,
   continuationAfterUnitId:previous.unitId,
   appendOrdinalStart:nextStart,
   shardIndex:0,recordKeys:[],path:clone(previous.path),
   dependencies:[previous.unitId],unitSpecRevision:1};
  plan.recordOwnership[idKey]=unitId;
  addUnit(plan,queue,next);
  created.push(unitId);
 }
 if(created.length)unlock(queue,plan);
 return created;
}

export function processUnitRequestV1({root,campaignPath,directory,request,automationRoot=process.cwd(),trustedController=false}){
 // A worker-origin GitHub request must never become a controller-origin FINALIZE.
 if(request?.operation==='FINALIZE'&&!trustedController)
  throw Error('FINALIZE is controller-internal and cannot be queued by a worker');
 const phase=request.phaseSequence;validateRequest(request,directory,phase);
 let queue=maybe(root,queueRel(campaignPath,phase));
 if(!queue)queue=createUnitPlanV1({root,campaignPath,directory,phase,automationRoot});
 const plan=readPlan(root,campaignPath,phase);assertPlan(queue,plan);
 const recoveredDiscoveryUnits=restoreAcceptedDiscoveryV1({root,queue,plan});
 const requestDigest=sha(request);
 if(queue.processedRequestHashes?.[request.requestId]&&
    queue.processedRequestHashes[request.requestId]!==requestDigest)
  throw Error('request ID reused with different immutable content');
 if(queue.processedRequests[request.requestId])return queue.processedRequests[request.requestId];
 let result;
 if(request.operation==='CLAIM')result=handleClaim({root,campaign:campaignPath,phase,queue,plan,request});
 else if(request.operation==='SUBMIT')result=handleSubmit({root,campaign:campaignPath,phase,queue,plan,request,directory});
 else if(request.operation==='RELEASE')result=handleRelease({queue,plan,request});
 else {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;result={status:'FINALIZE_REQUESTED'};}
 if(result.acceptedUnits?.length) {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;}
 if(recoveredDiscoveryUnits.length){
  queue.newlyEligibleUnitIds=queue.newlyEligibleUnitIds.filter(id=>!recoveredDiscoveryUnits.includes(id));
  result.recoveredAcceptedDiscoveryUnits=recoveredDiscoveryUnits;
 }
 if(phase===4&&queue.stage!=='RECONCILIATION'&&
  plan.units.filter(u=>['FLOW','ATTACK'].includes(u.kind)).every(u=>queue.units[u.unitId]?.status==='ACCEPTED'))
  finishDiscovery({root,campaign:campaignPath,directory,plan,queue,automationRoot});
 let continuationIssueError=null,issuedContinuationUnitIds=[];
 try{
  issuedContinuationUnitIds=issueAcceptedAppendContinuationsV1({
   root,campaign:campaignPath,phase,plan,queue});
 }catch(error){
  // Previously accepted snapshots remain accepted. Diagnose the issuance
  // obstacle without misreporting the phase or deleting earlier work.
  continuationIssueError=String(error?.message??error);
 }
 if(issuedContinuationUnitIds.length){
  queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;
 }
 const nextPhaseStatus=continuationIssueError?
  'AWAITING_APPEND_CONTINUATION_ISSUANCE':noWork(queue,plan);
 result={schemaVersion:UNIT_ARTIFACT_SCHEMAS.result,
  requestId:request.requestId,campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  authorityDigest:directory.authorityDigest,phaseSequence:phase,phaseEpoch:queue.phaseEpoch,
  ...result,
  acceptedUnits:result.acceptedUnits??[],reworkUnits:result.reworkUnits??[],
  staleUnits:result.staleUnits??[],unchangedUnits:result.unchangedUnits??[],
  waitingUnits:result.waitingUnits??[],
  nextPhaseStatus,phaseStatus:nextPhaseStatus,
  ...(issuedContinuationUnitIds.length?{issuedContinuationUnitIds}:{}),
  ...(continuationIssueError?{continuationIssueError}:{}),
  newlyEligibleUnits:[...new Set([...(result.newlyEligibleUnits??[]),
    ...issuedContinuationUnitIds])]};
 queue.revision++;
 queue.processedRequestHashes[request.requestId]=requestDigest;
 if(!asArray(result.waitingUnits).length)queue.processedRequests[request.requestId]=result;
 publishPlan(root,campaignPath,phase,plan,queue);
 directory.unitQueueIndexPath=planRel(campaignPath,phase);
 directory.unitQueueStatePath=queueRel(campaignPath,phase);
 if(directory.currentAssignment?.phaseSequence===phase){
  directory.currentAssignment.unitQueueIndexPath=directory.unitQueueIndexPath;
  directory.currentAssignment.unitQueueStatePath=directory.unitQueueStatePath;
 }
 return result;
}
function durablyAcceptedUnitV1({root,plan,queue,u}){
 const state=queue.units?.[u.unitId];
 if(state?.status!=='ACCEPTED'||!state.acceptedPath||
    !/^[a-f0-9]{64}$/.test(String(state.acceptedSha256??'')))return false;
 const prefix=path.posix.join(plan.campaignPath,'work/phase-'+
  String(plan.phaseSequence).padStart(2,'0'),'units',u.unitId)+'/';
 if(!state.acceptedPath.startsWith(prefix))return false;
 try{
  const snapshot=read(root,state.acceptedPath);
  return snapshot.unitId===u.unitId&&
   snapshot.campaignGenerationId===plan.campaignGenerationId&&
   snapshot.sourceSha256===plan.sourceSha256&&
   snapshot.authorityDigest===plan.authorityDigest&&
   snapshot.phaseSequence===plan.phaseSequence&&
   snapshot.phaseEpoch===plan.phaseEpoch&&
   snapshot.claimEpoch===state.claimEpoch&&
   snapshot.unitSpecRevision===u.unitSpecRevision&&
   snapshot.submissionSha256===state.acceptedSha256&&
   (!u.packetSha256||snapshot.packetSha256===u.packetSha256);
 }catch{return false;}
}
export function finalizeReadinessV1({root,campaignPath,directory,phase}){
 // A prior accepted file is insufficient after a unit is reopened for rework.
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 const pending=plan.units.filter(u=>!durablyAcceptedUnitV1({root,plan,queue,u}));
 if(pending.length)return {ready:false,reason:'AWAITING_DURABLY_ACCEPTED_WORKER_FILES',
  unitIds:pending.map(u=>u.unitId)};
 return {ready:true,plan,queue};
}
// Recover a controller-owned v13 index accidentally re-sharded from a previously
// assembled unit form. The immutable per-record unit plan, not reviewer data,
// fixes the original mandatory identities and APPEND boundary. Do not bypass
// the trusted-index equality checks or manufacture missing substantive records.
function restoreFrozenUnitShardIndexV1({root,campaignPath,phase,assignment,plan}){
 if(![4,5,6].includes(phase))return;
 const workDir=path.posix.dirname(assignment.workShardIndexPath);
 const trustedDir=path.posix.join(campaignPath,'controller/shards/phase-'+String(phase).padStart(2,'0'));
 const trustedRel=path.posix.join(trustedDir,'INDEX_v1.json');
 const working=read(root,assignment.workShardIndexPath),trusted=read(root,trustedRel);
 if(JSON.stringify(working)!==JSON.stringify(trusted))
  throw Error('v13 index authority mismatch before unit-plan recovery');
 const records=plan.units.flatMap(u=>u.kind==='BATCH'?u.members:[u]).filter(u=>
  ['SHARD','APPEND'].includes(u.kind)&&!(u.appendChunkNumber>1));
 let changed=false;
 for(let i=0;i<working.pages.length;i++){
  const desc=working.pages[i],pageRel=path.posix.join(workDir,desc.file);
  const trustedPageRel=path.posix.join(trustedDir,desc.file);
  const page=read(root,pageRel),trustedPage=read(root,trustedPageRel);
  if(JSON.stringify(page)!==JSON.stringify(trustedPage)||sha(page)!==desc.sha256)
   throw Error('v13 index page authority mismatch before unit-plan recovery');
  let pageChanged=false;
  for(const shard of page.shards??[]){
   if(shard.kind!=='array')continue;
   const members=records.filter(u=>u.shardFile===shard.file);
   if(!members.length)continue;
   if(shard.append){
    if(members.length!==1||members[0].kind!=='APPEND'||shard.recordKeys.length)
     throw Error('unexpected append unit-plan identity: '+shard.file);
    const expectedStart=records.filter(u=>u.kind==='SHARD'&&
     JSON.stringify(u.path)===JSON.stringify(shard.path)).length;
    if(shard.startIndex!==expectedStart){
     const slabRel=path.posix.join(workDir,shard.file),slab=read(root,slabRel);
     if(slab.startIndex!==shard.startIndex)throw Error('append shard index mismatch: '+shard.file);
     shard.startIndex=expectedStart;slab.startIndex=expectedStart;put(root,slabRel,slab);
     pageChanged=true;
    }
   }else{
    if(members.some(u=>u.kind!=='SHARD'))throw Error('unexpected fixed unit-plan identity: '+shard.file);
    members.sort((a,b)=>a.shardIndex-b.shardIndex);
    if(members.some((u,j)=>u.shardIndex!==j))
     throw Error('noncontiguous immutable fixed unit-plan ownership: '+shard.file);
    const prefix=JSON.stringify(shard.path)+':';
    const keys=members.map(u=>{
     const key=u.recordKeys?.[0];
     if(typeof key!=='string'||!key.startsWith(prefix))
      throw Error('invalid immutable unit record key: '+shard.file);
     return key.slice(prefix.length);
    });
    const first=Math.min(...members.map(u=>u.recordIndex));
    if(shard.startIndex!==first||JSON.stringify(shard.recordKeys)!==JSON.stringify(keys)){
     shard.startIndex=first;shard.recordKeys=keys;pageChanged=true;
    }
   }
  }
  if(pageChanged){
   put(root,pageRel,page);put(root,trustedPageRel,page);
   working.pages[i].sha256=sha(page);trusted.pages[i].sha256=sha(page);
   changed=true;
  }
 }
 if(changed){
  put(root,assignment.workShardIndexPath,working);put(root,trustedRel,trusted);
 }
}
// Collect accepted continuation page content without creating another
// transport. It is read from the existing immutable accepted unit snapshots.
export function collectAcceptedAppendContinuationsV1({root,campaignPath,phase}){
 if(![4,5,6].includes(Number(phase)))return [];
 if(!maybe(root,planRel(campaignPath,phase))||
    !maybe(root,queueRel(campaignPath,phase)))return [];
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 const pages=[];
 // A continuation request is only fulfilled by a separately issued and
 // accepted successor. Never treat an unfinished accepted chain as complete.
 for(const u of plan.units.filter(unit=>unit.kind==='APPEND')){
  const state=queue.units?.[u.unitId];
  if(state?.status!=='ACCEPTED')continue;
  const snap=read(root,state.acceptedPath);
  if(snap.submission?.appendContinuation!==true)continue;
  const successor=plan.units.find(next=>next.kind==='APPEND'&&
   next.continuationAfterUnitId===u.unitId);
  if(!successor)
   throw Error('APPEND_CONTINUATION_AWAITING_ISSUANCE: '+u.unitId);
 }
 for(const u of plan.units){
  if(u.kind!=='APPEND'||!(u.appendChunkNumber>1))continue;
  const state=queue.units?.[u.unitId];
  if(state?.status!=='ACCEPTED'||!state.acceptedPath)
   throw Error('APPEND_CONTINUATION_AWAITING_ACCEPTED_UNIT: '+u.unitId);
  const snapshot=read(root,state.acceptedPath);
  if(snapshot.unitId!==u.unitId||snapshot.phaseSequence!==phase||
     snapshot.campaignGenerationId!==plan.campaignGenerationId||
     snapshot.sourceSha256!==plan.sourceSha256||
     snapshot.authorityDigest!==plan.authorityDigest||
     snapshot.phaseEpoch!==plan.phaseEpoch||
     snapshot.submissionSha256!==state.acceptedSha256||
     !Array.isArray(snapshot.submission?.entries))
   throw Error('APPEND_CONTINUATION_ACCEPTED_SOURCE_MISMATCH: '+u.unitId);
  pages.push({unitId:u.unitId,path:u.path,
   chunkNumber:u.appendChunkNumber,startIndex:u.appendOrdinalStart,
   continuationAfterUnitId:u.continuationAfterUnitId,
   entries:snapshot.submission.entries});
 }
 return pages.sort((a,b)=>
  JSON.stringify(a.path).localeCompare(JSON.stringify(b.path))||
  a.chunkNumber-b.chunkNumber);
}

export function assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase}){
 // GitHub copies and orders the actual Worker-provided bytes; no additional
 // identity, value, coverage, dependency, or security validation is performed.
 const ready=finalizeReadinessV1({root,campaignPath,directory,phase});
 if(!ready.ready)return {status:'AWAITING_WORKER_FILES',unitIds:ready.unitIds};
 const {plan,queue}=ready,assignment=directory.currentAssignment,byFile=new Map();
 const phaseSchema=loadPhaseSchema(root,authorityFor(directory),phase).schema;
 // Reconstruct issued rows from their immutable member identity, not from an
 // editable raw submission that can rewrite prefilled subject/source fields.
 // This normalizes only controller-owned values; it never judges AI analysis.
 const immutableIssuedValue=(member,entry)=>{
  const issued=member.initialValue;
  if(!issued||typeof issued!=='object'||Array.isArray(issued)||
     !entry?.value||typeof entry.value!=='object'||Array.isArray(entry.value))
   return entry;
  const step=member.path?.[1],field=member.field;
  const action=phaseSchema.actions?.[step]??{};
  const definition=action.fields?.find(spec=>spec.name===field)??{};
  const pinned=new Set([...(definition.controllerPrefillFields??[]),
   ...(action.controllerPrefillFields??[]),
   ...asArray(issued.automationOwnedFields),
   'automationOwnedFields','recordKey','tempKey','candidateKey','obligationId','subjectKey',
   'findingKey','testGroupId','groupKey']);
  const next=clone(entry.value);
  for(const key of pinned){
   if(!Object.hasOwn(issued,key))continue;
   const value=issued[key];
   if(value===undefined||value===null||
      (typeof value==='string'&&(!value.trim()||value.startsWith('<')||value==='TODO')))
    continue;
   next[key]=clone(value);
  }
  return {...entry,value:next};
 };
 for(const u of plan.units.filter(u=>['SHARD','APPEND','BATCH'].includes(u.kind))){
  // Only original issued shards are written back to their indexed working
  // files. Later APPEND chunks are independent accepted source pages.
  if(u.kind==='APPEND'&&u.appendChunkNumber>1)continue;
  const accepted=read(root,queue.units[u.unitId].acceptedPath);
  if(u.kind==='BATCH'){
   const entries=Array.isArray(accepted.submission?.entries)?accepted.submission.entries:[];
   for(const member of u.members){
    const entry=entries.find(e=>e?.key===member.recordKeys?.[0]);
    if(!entry)continue; // Do not invent material that the Worker did not send.
    const group=byFile.get(member.shardPath)??[];
    group.push({unit:member,entries:[immutableIssuedValue(member,entry)]});byFile.set(member.shardPath,group);
   }
  }else{
   const group=byFile.get(u.shardPath)??[];
   const entries=Array.isArray(accepted.submission?.entries)?accepted.submission.entries:[];
   group.push({unit:u,entries:u.kind==='SHARD'?
    entries.map(entry=>immutableIssuedValue(u,entry)):entries});
   byFile.set(u.shardPath,group);
  }
 }
 for(const [rel,group] of byFile){
  const slab=read(root,rel);
  const fixed=group.filter(e=>e.unit.kind==='SHARD').sort((a,b)=>a.unit.shardIndex-b.unit.shardIndex);
  const appended=group.filter(e=>e.unit.kind==='APPEND').sort((a,b)=>a.unit.unitId.localeCompare(b.unit.unitId));
  slab.entries=fixed.length?fixed.flatMap(e=>e.entries):appended.flatMap(e=>e.entries);
  put(root,rel,slab);
 }
 const acceptedContinuations=collectAcceptedAppendContinuationsV1({root,campaignPath,phase});
 materializeSemanticWorkFormV13({root,formRel:assignment.workFormPath,
  acceptedContinuations});
 return {status:'READY_FOR_EXISTING_BOUNDARY_SEAL',workShardIndexPath:assignment.workShardIndexPath,
  validationDelegatedTo:'CLOUDFLARE_WORKER'};
}
// Provenance-only projection of exact accepted SHARD/BATCH/APPEND work.
// Keep it inside the existing canonical artifact (not a new standalone
// database or workflow). Original Worker source status is never a quality gate.
export function collectAcceptedUnitRecordOriginsV1({root,campaignPath,directory,phase}){
 const roster={schemaVersion:'curveyield-accepted-unit-record-origins-v1',
  phaseSequence:phase,campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,
  sourceSha256:directory.sourceSha256,records:[],unavailable:[]};
 if(![4,5,6].includes(phase))return {...roster,availability:'NOT_APPLICABLE'};
 let plan,queue;
 try{
  plan=readPlan(root,campaignPath,phase);
  queue=read(root,queueRel(campaignPath,phase));
 }catch(e)return {...roster,availability:'PLAN_OR_QUEUE_UNAVAILABLE',
  diagnostics:[String(e?.message??e)]};
 if(queue.campaignId!==directory.campaignId||
    queue.campaignGenerationId!==directory.campaignGenerationId||
    queue.phaseSequence!==phase||queue.sourceSha256!==directory.sourceSha256||
    queue.authorityDigest!==plan.authorityDigest||queue.phaseEpoch!==plan.phaseEpoch)
  return {...roster,availability:'ISSUED_IDENTITY_MISMATCH'};
 const units=plan.units.filter(u=>['SHARD','BATCH','APPEND'].includes(u.kind));
 // The same frozen descriptor fixes the canonical append start position during
 // materializeSemanticWorkFormV13. Mutable submitted slab metadata is not the
 // source of truth for the record-to-canonical index relationship.
 const issuedDescriptors=new Map();
 try{
  const trustedDir=path.posix.join(campaignPath,'controller/shards/phase-'+
   String(phase).padStart(2,'0'));
  const index=read(root,path.posix.join(trustedDir,'INDEX_v1.json'));
  for(const pageRef of asArray(index.pages)){
   const page=read(root,path.posix.join(trustedDir,pageRef.file));
   for(const desc of asArray(page.shards))
    issuedDescriptors.set(desc.file,desc);
  }
 }catch{ /* Record exact source identity even if issuance metadata is lost. */ }
 for(const u of units){
  const state=queue.units?.[u.unitId];
  if(state?.status!=='ACCEPTED'||!state.acceptedPath){
   roster.unavailable.push({unitId:u.unitId,status:'NOT_ACCEPTED'});continue;
  }
  let snapshot,acceptedDigest;
  try{
   const raw=fs.readFileSync(repoFile(root,state.acceptedPath));
   acceptedDigest=hex(raw);snapshot=JSON.parse(raw.toString('utf8'));
   if(snapshot.unitId!==u.unitId||snapshot.phaseSequence!==phase||
      snapshot.campaignGenerationId!==directory.campaignGenerationId||
      snapshot.sourceSha256!==directory.sourceSha256||
      snapshot.submissionSha256!==state.acceptedSha256)
    throw Error('accepted unit identity mismatch');
  }catch(e){
   roster.unavailable.push({unitId:u.unitId,status:'ACCEPTED_SNAPSHOT_UNAVAILABLE',
    diagnostic:String(e?.message??e)});continue;
  }
  let original=null,sourceAvailability='NOT_RECORDED';
  const originalRef=snapshot.sourceProvenance?.originalWorkerAttempt;
  if(originalRef?.availability==='AVAILABLE'&&typeof originalRef.path==='string'&&
     /^[a-f0-9]{64}$/.test(String(originalRef.sha256??''))){
   try{
    const raw=fs.readFileSync(repoFile(root,originalRef.path));
    if(hex(raw)!==originalRef.sha256)throw Error('original worker attempt digest mismatch');
    original=JSON.parse(raw.toString('utf8'));sourceAvailability='AVAILABLE';
   }catch(e){sourceAvailability='ORIGINAL_WORKER_SOURCE_UNAVAILABLE';}
  }else sourceAvailability=originalRef?.availability??'NOT_RECORDED';
  const entries=Array.isArray(snapshot.submission?.entries)?snapshot.submission.entries:[];
  const isBound=original?.schemaVersion==='curveyield-machine-bound-answers-v1';
  const originalAnswerSelectors=key=>{
   if(!isBound||!Array.isArray(original.answers))return [];
   const selectors=[];
   for(let i=0;i<original.answers.length;i++){
    let tokens;
    try{tokens=JSON.parse(original.answers[i]?.bindingId??'');}catch{continue;}
    if(Array.isArray(tokens)&&tokens[0]==='entries'&&tokens[1]===key)
     selectors.push('answers['+i+']');
   }
   return selectors;
  };
  const acceptedReference=(member,entry,entryIndex,recordOrdinal,canonicalIndex)=>{
   const collection=member.path?.join('.')??null;
   const sourceSelector='submission.entries['+entryIndex+'].value';
   const originalSelector=sourceAvailability==='AVAILABLE'?
    (isBound?(u.kind==='APPEND'?'appendRecords['+recordOrdinal+']':null):
     original?.schemaVersion==='curveyield-lite-solo-unit-submission-v1'?
      'entries['+entryIndex+'].value':null):null;
   roster.records.push({
    unitId:u.unitId,memberUnitId:member.unitId,
    unitKind:u.kind,field:member.field,collection,
    ...(u.kind==='APPEND'?{
     appendChunkNumber:u.appendChunkNumber??1,
     continuationAfterUnitId:u.continuationAfterUnitId??null,
     appendSeriesUnitId:u.appendSeriesUnitId??u.unitId
    }:{}),
    originalRecordOrdinal:recordOrdinal,canonicalRecordIndex:canonicalIndex,
    canonicalRecordSelector:collection!==null&&Number.isInteger(canonicalIndex)?
     collection+'['+canonicalIndex+']':null,
    recordKey:entry.key,
    acceptedPath:state.acceptedPath,acceptedArtifactSha256:acceptedDigest,
    acceptedSubmissionPath:snapshot.sourceProvenance?.submittedPath??null,
    acceptedSubmissionSha256:snapshot.submissionSha256,
    acceptedSourceSelector:sourceSelector,
    originalWorkerAttempt:{availability:sourceAvailability,
     // Retain recorded expected locations/digests even when content has gone
     // missing; availability is separate from original source identity.
     path:originalRef?.path??null,sha256:originalRef?.sha256??null,
     sourceSelector:originalSelector,
     ...(isBound&&u.kind!=='APPEND'?
      {answerSelectors:originalAnswerSelectors(entry.key)}:{})},
    // Controller-owned binding metadata is authoritative only when compiled
    // by this adapter; a raw submitted entry may contain arbitrary extra keys.
    ...(snapshot.sourceProvenance?.submittedRepresentation==='CONTROLLER_COMPILED'&&
       entry.sourceAuthoredIdentities?
     {sourceAuthoredIdentities:structuredClone(entry.sourceAuthoredIdentities)}:{}),
    ...(snapshot.sourceProvenance?.submittedRepresentation==='CONTROLLER_COMPILED'&&
       entry.controllerSubjectBindings?
     {controllerSubjectBindings:structuredClone(entry.controllerSubjectBindings)}:{})
   });
  };
  if(u.kind==='BATCH'){
   for(const member of u.members){
    const index=entries.findIndex(x=>x?.key===member.recordKeys?.[0]);
    if(index<0){
     roster.unavailable.push({unitId:u.unitId,memberUnitId:member.unitId,
      status:'ISSUED_BATCH_MEMBER_MISSING'});continue;
    }
    acceptedReference(member,entries[index],index,member.shardIndex,
     member.recordIndex);
   }
  }else if(u.kind==='SHARD'){
   const index=entries.findIndex(x=>x?.key===u.recordKeys?.[0]);
   if(index<0){
    roster.unavailable.push({unitId:u.unitId,status:'ISSUED_SHARD_RECORD_MISSING'});
    continue;
   }
   acceptedReference(u,entries[index],index,u.shardIndex,u.recordIndex);
  }else{
   const desc=issuedDescriptors.get(u.shardFile);
   const start=u.appendChunkNumber>1?
    (Number.isSafeInteger(u.appendOrdinalStart)?u.appendOrdinalStart:null):
    desc?.append===true&&Number.isSafeInteger(desc.startIndex)&&
     desc.startIndex>=0?desc.startIndex:null;
   for(const [index,entry] of entries.entries()){
    acceptedReference(u,entry,index,index,
     start===null?null:start+index);
   }
   if(start===null)roster.unavailable.push({unitId:u.unitId,
    status:'APPEND_CANONICAL_POSITION_UNAVAILABLE'});
  }
 }
 roster.availability='COLLECTED_NONBLOCKING';
 roster.acceptedOriginCount=roster.records.length;
 return roster;
}

// Explicit means the AI supplied the reference in a reference-typed field
// or in the optional questionRecordLinks envelope. Ordinary prose and titles
// are deliberately never parsed for associations.
const QUESTION_REFERENCE_FIELDS_V1=new Set([
 'explicitQuestionRefs','questionRefs','questionEvidenceRefs',
 'sourceQuestionRefs','relatedQuestionRefs','investigationQuestionRefs',
 'originatingEvidenceRefs','evidenceRefs','sourceRefs','proofEvidenceRefs',
 'discoveryEvidenceRefs','anchors'
]);
const QUESTION_ID_V1=/^Q-[0-9]{6,}$/;
function typedQuestionReferenceV1(value,{phase,unitId}){
 // A literal checkpoint record selector is already an exact source
 // reference. Resolve it only against VERIFIED index/checkpoint metadata.
 const checkpointPointer=(checkpointPath,selector)=>{
  if(typeof checkpointPath!=='string'||
     !checkpointPath.includes('/questions/checkpoints/')||
     typeof selector!=='string')return null;
  let ordinal=null;
  const recordSelector=selector.endsWith('.answerText')?
   selector.slice(0,-'.answerText'.length):
   selector.endsWith('.questionText')?
    selector.slice(0,-'.questionText'.length):selector;
  if(recordSelector.startsWith('records[')&&recordSelector.endsWith(']')){
   const number=recordSelector.slice(8,-1);
   if(/^[0-9]+$/.test(number))ordinal=Number(number);
  }else if(recordSelector.startsWith('/records/')){
   const number=recordSelector.slice(9);
   if(/^[0-9]+$/.test(number))ordinal=Number(number);
  }
  if(!Number.isSafeInteger(ordinal)||ordinal<0)return null;
  return {checkpointPath,checkpointRecordSelector:'records['+ordinal+']',
   sourceReferenceKind:'EXACT_CHECKPOINT_RECORD_POINTER'};
 };
 const indexPointer=(indexPath,selector)=>{
  if(typeof indexPath!=='string'||
     !indexPath.endsWith('/questions/QUESTION_INDEX_v1.json')||
     typeof selector!=='string')return null;
  let ordinal=null;
  const questionSelector=selector.endsWith('.questionText')?
   selector.slice(0,-'.questionText'.length):selector;
  if(questionSelector.startsWith('questions[')&&questionSelector.endsWith(']')){
   const value=questionSelector.slice(10,-1);
   if(/^[0-9]+$/.test(value))ordinal=Number(value);
  }else if(questionSelector.startsWith('/questions/')){
   const value=questionSelector.slice(11);
   if(/^[0-9]+$/.test(value))ordinal=Number(value);
  }
  if(!Number.isSafeInteger(ordinal)||ordinal<0)return null;
  return {questionIndexPath:indexPath,questionIndexSelector:'questions['+
   ordinal+']',sourceReferenceKind:'EXACT_QUESTION_INDEX_POINTER'};
 };
 if(typeof value==='string'){
  const ref=value.trim();
  const hash=ref.indexOf('#');
  if(hash>0){
   const source=checkpointPointer(ref.slice(0,hash),ref.slice(hash+1))??
    indexPointer(ref.slice(0,hash),ref.slice(hash+1));
   if(source)return source;
  }
  if(QUESTION_ID_V1.test(ref)&&unitId)
   return {phaseSequence:phase,unitId,questionId:ref,
    sourceReferenceKind:'LOCAL_ISSUED_UNIT_REFERENCE'};
  const composite=ref.match(/^(?:phase[-_ ]?)?(\d+)\/([A-Za-z0-9._-]+)\/(Q-[0-9]{6,})(?:@(?:rev(?:ision)?[-_ ]?)?(\d+))?$/i);
  if(composite)return {phaseSequence:Number(composite[1]),
   unitId:composite[2],questionId:composite[3],
   ...(composite[4]?{checkpointRevision:Number(composite[4])}:{}),
   sourceReferenceKind:'EXPLICIT_COMPOSITE_REFERENCE'};
  return null;
 }
 if(isObject(value)&&value.checkpointPath&&value.checkpointRecordSelector){
  const source=checkpointPointer(value.checkpointPath,value.checkpointRecordSelector);
  if(source)return source;
 }
 if(isObject(value)&&value.questionIndexPath&&value.questionIndexSelector){
  const source=indexPointer(value.questionIndexPath,value.questionIndexSelector);
  if(source)return source;
 }
 if(!isObject(value)||!QUESTION_ID_V1.test(String(value.questionId??'')))
  return null;
 const sourcePhase=value.phaseSequence===undefined?phase:Number(value.phaseSequence);
 const sourceUnit=value.unitId??unitId;
 if(!Number.isSafeInteger(sourcePhase)||sourcePhase<1||
    typeof sourceUnit!=='string'||!safe(sourceUnit))
  return null;
 const revision=value.checkpointRevision===undefined?
  null:Number(value.checkpointRevision);
 return {phaseSequence:sourcePhase,unitId:sourceUnit,
  questionId:value.questionId,
  ...(revision!==null&&Number.isSafeInteger(revision)&&revision>=1?
   {checkpointRevision:revision}:{}),
  sourceReferenceKind:'EXPLICIT_STRUCTURED_REFERENCE'};
}
function explicitQuestionRefsInRecordV1(value,{phase,unitId,selector}){
 const refs=[],stack=[{value,selector}];
 while(stack.length){
  const current=stack.pop(),item=current.value;
  if(!item||typeof item!=='object')continue;
  if(Array.isArray(item)){
   for(let i=item.length-1;i>=0;i--)
    if(item[i]&&typeof item[i]==='object')
     stack.push({value:item[i],selector:current.selector+'['+i+']'});
   continue;
  }
  for(const [key,child] of Object.entries(item)){
   const fieldSelector=current.selector+'.'+key;
   if(QUESTION_REFERENCE_FIELDS_V1.has(key)){
    const list=Array.isArray(child)?child:[child];
    for(const [i,ref] of list.entries()){
     const authored=typedQuestionReferenceV1(ref,{phase,unitId});
     const sourceSelector=fieldSelector+
      (Array.isArray(child)?'['+i+']':'');
     if(authored)refs.push({authored,sourceSelector,
      originalExplicitReference:structuredClone(ref)});
     else if(typeof ref==='string'&&(
       /^Q-[0-9]+$/.test(ref.trim())||
       /\/Q-[0-9]+/.test(ref)||
       ref.includes('/questions/checkpoints/')||
       ref.includes('/questions/QUESTION_INDEX_v1.json')||
       key.toLowerCase().includes('question'))||
       isObject(ref)&&Object.hasOwn(ref,'questionId'))
      refs.push({authored:null,sourceSelector,
       originalExplicitReference:structuredClone(ref),
       unavailable:'QUESTION_REFERENCE_IDENTITY_INCOMPLETE'});
    }
   }
   if(child&&typeof child==='object')
    stack.push({value:child,selector:fieldSelector});
  }
 }
 return refs.sort((a,b)=>a.sourceSelector.localeCompare(b.sourceSelector));
}
// Build a many-to-many provenance projection over ACTUAL accepted output
// sources. The original questions and answers remain in their immutable
// index/checkpoint files; this index never substitutes a security verdict.
export function collectExplicitQuestionOutputLinksV1({
 root,campaignPath,directory,phase,canonical,questionSources=null
}){
 const histories=questionSources??collectAcceptedQuestionAnswerSourcesV1({
  root,campaignPath,directory,phase});
 const output={schemaVersion:'curveyield-explicit-question-output-links-v1',
  phaseSequence:phase,associationOrigin:'AI_EXPLICIT_REFERENCE',
  associations:[],nonCanonicalEvidenceAssociations:[],unresolvedReferences:[],
  unpromotedQuestions:[],
  // Original direct field ownership is clerical, not an AI security link.
  originalDirectQuestionFieldOwners:histories.questions.filter(q=>
   q.sourceKind==='DIRECT_FIXED_ORIGINAL').map(q=>({
    phaseSequence:q.phaseSequence,unitId:q.unitId,questionId:q.questionId,
    originalDirectFieldPath:q.originalDirectFieldPath,
    originalAcceptedShardPath:q.originalAcceptedShardPath,
    originalAcceptedShardSha256:q.originalAcceptedShardSha256,
    sourceAcceptance:q.sourceAcceptance,
    originalAnswerVersionCount:q.answerVersions?.length??0,
    associationMeaning:'ISSUED_FIELD_OWNERSHIP_NOT_AI_EXPLICIT_FINDING_LINK'
   })),
  sourceAvailability:histories.availability,
  questionSourcesSelector:'automationOutputs.questionAnswerSources',
  sourceMeaning:'NO_SECURITY_INFERENCE'};
 const questionByIdentity=new Map(histories.questions.map((q,i)=>[
  JSON.stringify([q.phaseSequence,q.unitId,q.questionId]),{q,index:i}]));
 const questionByCheckpoint=new Map(),questionByIndex=new Map();
 for(const [i,question] of histories.questions.entries()){
  const indexKey=JSON.stringify([question.questionIndexPath,
   question.questionTextSource?.selector?.replace(/\.questionText$/,'')]);
  const indexEntries=questionByIndex.get(indexKey)??[];
  indexEntries.push({q:question,index:i});
  questionByIndex.set(indexKey,indexEntries);
  for(const version of question.checkpointEvents??[]){
   const key=JSON.stringify([version.checkpointPath,
    version.checkpointRecordSelector]);
   const candidates=questionByCheckpoint.get(key)??[];
   candidates.push({q:question,index:i,version});
   questionByCheckpoint.set(key,candidates);
  }
 }
 const linked=new Set();
 const appendLink=({ref,record,selector,ownerPhase,ownerUnit,outputOrigin,
  nonCanonical=false})=>{
  if(!ref)return;
  let question=ref.authored;
  if(question?.sourceReferenceKind==='EXACT_CHECKPOINT_RECORD_POINTER'){
   const candidates=questionByCheckpoint.get(JSON.stringify([
    question.checkpointPath,question.checkpointRecordSelector]))??[];
   if(candidates.length===1){
    const match=candidates[0];
    question={phaseSequence:match.q.phaseSequence,unitId:match.q.unitId,
     questionId:match.q.questionId,
     checkpointRevision:match.version.checkpointRevision,
     sourceReferenceKind:'EXACT_CHECKPOINT_RECORD_POINTER'};
   }else question=null;
  }else if(question?.sourceReferenceKind==='EXACT_QUESTION_INDEX_POINTER'){
   const candidates=questionByIndex.get(JSON.stringify([
    question.questionIndexPath,question.questionIndexSelector]))??[];
   if(candidates.length===1){
    const match=candidates[0];
    question={phaseSequence:match.q.phaseSequence,unitId:match.q.unitId,
     questionId:match.q.questionId,
     sourceReferenceKind:'EXACT_QUESTION_INDEX_POINTER'};
   }else question=null;
  }
  if(!question){
   output.unresolvedReferences.push({outputRecordSelector:selector,
    originalOutputSource:outputOrigin,
    originalQuestionReferenceSelector:ref.sourceSelector,
    originalExplicitReference:ref.originalExplicitReference,
    status:ref.unavailable??'QUESTION_REFERENCE_IDENTITY_INCOMPLETE'});
   return;
  }
  const identity=JSON.stringify([question.phaseSequence,question.unitId,question.questionId]);
  const accepted=questionByIdentity.get(identity);
  const revision=question.checkpointRevision??null;
  const version=revision===null?null:accepted?.q.answerVersions.find(
   event=>event.checkpointRevision===revision);
  const questionEvent=revision===null?null:accepted?.q.checkpointEvents.find(
   event=>event.checkpointRevision===revision);
  const association={
   outputRecord:{phaseSequence:phase,selector,
    recordKey:record?.recordKey??null,
    originalAcceptedRecordSource:outputOrigin??null},
   explicitQuestionReference:{
    phaseSequence:question.phaseSequence,unitId:question.unitId,
    questionId:question.questionId,
    ...(revision!==null?{checkpointRevision:revision}:{})},
   originalExplicitReference:ref.originalExplicitReference,
   originalQuestionReferenceSelector:ref.sourceSelector,
   associationOrigin:'AI_EXPLICIT_REFERENCE',
   ...(accepted?{
    questionSourceSelector:'automationOutputs.questionAnswerSources.questions['+
     accepted.index+']',
    originalQuestionTextSource:accepted.q.questionTextSource,
    originalQuestionIndexPath:accepted.q.questionIndexPath,
    originalQuestionIndexSha256:accepted.q.questionIndexSha256,
    acceptedQuestionUnitPath:accepted.q.acceptedUnitPath,
    acceptedQuestionUnitArtifactSha256:accepted.q.acceptedUnitArtifactSha256,
    answerVersionCount:accepted.q.answerVersions.length,
    ...(questionEvent?{exactQuestionEventSource:questionEvent}:{}),
    ...(version?{exactAnswerVersionSource:version}:{})
   }:{})
  };
  if(!accepted||
     revision!==null&&!questionEvent){
   output.unresolvedReferences.push({...association,
    status:!accepted?'ORIGINAL_QUESTION_SOURCE_UNAVAILABLE':
     'REFERENCED_CHECKPOINT_REVISION_UNAVAILABLE'});
   return;
  }
  if(nonCanonical)output.nonCanonicalEvidenceAssociations.push({
    ...association,outputRecord:{
     ...association.outputRecord,formalCanonicalOutput:false}
   });
  else{
   linked.add(identity);output.associations.push(association);
  }
 };
 const register=({value,selector,ownerPhase=phase,ownerUnit=null,
  recordKey=null,origin=null,extraRefs=[],nonCanonical=false})=>{
  const record={recordKey};
  for(const ref of [
   ...explicitQuestionRefsInRecordV1(value,{
    phase:ownerPhase,unitId:ownerUnit,selector}),
   ...extraRefs
  ])appendLink({ref,record,selector,ownerPhase,ownerUnit,
   outputOrigin:origin,nonCanonical});
 };
 // The canonical row index and accepted record-source roster were assembled
 // mechanically before this collector. Do not use prose/title matching.
 const sources=[
  ...(canonical.automationOutputs?.acceptedUnitRecordOrigins?.records??[]),
  ...(canonical.automationOutputs?.directPhaseRecordOrigins?.records??[])
 ];
 const sourceBySelector=new Map();
 for(const source of sources){
  if(!source?.canonicalRecordSelector)continue;
  const key=source.canonicalRecordSelector;
  const refs=sourceBySelector.get(key)??[];
  refs.push(source);sourceBySelector.set(key,refs);
 }
 const saved=new Map(),originalLinkRows=new Map(),consumedLinkRows=new Set();
 // Optional explicitly AI-supplied metadata remains on the accepted unit
 // snapshot. It is not rewritten into fixed issued output objects.
 if([4,5,6].includes(Number(phase))){
  let plan,queue;
  try{plan=readPlan(root,campaignPath,phase);
   queue=read(root,queueRel(campaignPath,phase));}
  catch{plan=null;queue=null;}
  for(const u of plan?.units??[]){
   const state=queue?.units?.[u.unitId];
   if(state?.status!=='ACCEPTED'||!state.acceptedPath)continue;
   let accepted;
   try{
    const raw=fs.readFileSync(repoFile(root,state.acceptedPath));
    accepted=JSON.parse(raw.toString('utf8'));
    if(accepted?.unitId!==u.unitId||
       accepted?.campaignGenerationId!==directory.campaignGenerationId||
       accepted?.sourceSha256!==directory.sourceSha256||
       accepted?.submissionSha256!==state.acceptedSha256)
     throw Error('accepted unit source identity mismatch');
   }catch(error){
    output.unresolvedReferences.push({unitId:u.unitId,
     status:'ACCEPTED_UNIT_SOURCE_UNREADABLE',
     diagnostic:String(error?.message??error)});continue;
   }
   saved.set(u.unitId,{accepted,path:state.acceptedPath});
   const links=accepted.submission?.questionRecordLinks;
   if(Array.isArray(links))
    originalLinkRows.set(u.unitId,links);
   else if(links!==undefined)
    output.unresolvedReferences.push({unitId:u.unitId,
     originalOutputSource:state.acceptedPath,
     originalExplicitReference:structuredClone(links),
     status:'NON_ARRAY_AI_QUESTION_LINK_METADATA'});
   if(accepted.submission?.unmappedQuestionRecordLinks!==undefined)
    output.unresolvedReferences.push({unitId:u.unitId,
     originalOutputSource:state.acceptedPath,
     originalExplicitReference:structuredClone(
      accepted.submission.unmappedQuestionRecordLinks),
     status:'UNMAPPED_AI_QUESTION_LINK_METADATA'});
   if(u.kind==='ATTACK'&&
      Array.isArray(accepted.sourceProvenance?.unmappedAttackPathRefs)&&
      accepted.sourceProvenance.unmappedAttackPathRefs.length){
    // Unissued-flow ATTACK evidence can be absent from the compiled
    // attackPaths array. Keep its authored question relationships on the
    // ORIGINAL, hash-verified Worker source, without promoting it into a
    // canonical finding or falsely assigning an issued flow.
    const originalRef=accepted.sourceProvenance.originalWorkerAttempt;
    let original=null,sourceDiagnostic=null;
    try{
     if(originalRef?.availability!=='AVAILABLE'||
        typeof originalRef.path!=='string'||!originalRef.path.startsWith(
         unitBase(campaignPath,phase,u.unitId)+'/submissions/')||
        !/^[a-f0-9]{64}$/.test(String(originalRef.sha256??'')))
      throw Error('original unissued-flow ATTACK source unavailable');
     const raw=fs.readFileSync(repoFile(root,originalRef.path));
     if(hex(raw)!==originalRef.sha256)
      throw Error('original unissued-flow ATTACK source digest mismatch');
     original=JSON.parse(raw.toString('utf8'));
    }catch(error){sourceDiagnostic=String(error?.message??error);}
    for(const unmapped of accepted.sourceProvenance.unmappedAttackPathRefs){
     const selector=unmapped?.sourceSelector;
     const match=typeof selector==='string'?
      selector.match(/^extraRecords\.attackPaths\[([0-9]+)\]$/):null;
     if(!match)continue; // Other original ATTACK rows are handled below.
     const sourceRow=original?.extraRecords?.attackPaths?.[Number(match[1])];
     if(!sourceRow||typeof sourceRow!=='object'||Array.isArray(sourceRow)){
      output.unresolvedReferences.push({
       unitId:u.unitId,originalQuestionReferenceSelector:selector,
       originalOutputSource:originalRef??null,
       status:'UNMAPPED_ATTACK_EVIDENCE_NOT_RETRIEVABLE',
       diagnostic:sourceDiagnostic});continue;
     }
     const refs=[];
     for(const [k,link] of (originalLinkRows.get(u.unitId)??[]).entries()){
      if(link?.outputSelector!==selector&&
         link?.acceptedOutputSelector!==selector)continue;
      if(!Array.isArray(link.questionRefs))continue;
      consumedLinkRows.add(JSON.stringify([u.unitId,k]));
      for(const [j,ref] of link.questionRefs.entries())
       refs.push({authored:typedQuestionReferenceV1(ref,{phase,unitId:u.unitId}),
        originalExplicitReference:structuredClone(ref),
        sourceSelector:'submission.questionRecordLinks['+k+'].questionRefs['+j+']'});
     }
     register({value:sourceRow,
      selector:'originalWorkerAttempt.'+selector,
      ownerUnit:u.unitId,recordKey:sourceRow.pathId??null,
      nonCanonical:true,
      origin:{acceptedPath:state.acceptedPath,
       acceptedSubmissionSha256:accepted.submissionSha256,
       originalWorkerAttempt:{
        path:originalRef.path,sha256:originalRef.sha256,
        sourceSelector:selector},
       mappingStatus:unmapped.mappingStatus??'UNMAPPED_ATTACK_PATH'},
      extraRefs:refs});
    }
   }
   if(!['FLOW','ATTACK'].includes(u.kind))continue;
   for(const [collection,rows] of Object.entries(accepted.submission??{})){
    if(!Array.isArray(rows)||!['rows','flowNotes','integrationAnswers',
     'contractChecks','attackPaths','trivialReviews','groupChecks','candidates']
      .includes(collection))continue;
    for(const [i,row] of rows.entries()){
     const selector='submission.'+collection+'['+i+']';
     const extra=(originalLinkRows.get(u.unitId)??[])
      .flatMap((link,k)=>{
       if(link?.acceptedOutputSelector!==collection+'['+i+']'&&
          link?.outputSelector!==collection+'['+i+']')return [];
       if(!Array.isArray(link.questionRefs))return [];
       consumedLinkRows.add(JSON.stringify([u.unitId,k]));
       return link.questionRefs
        .map((ref,j)=>({authored:typedQuestionReferenceV1(ref,{
         phase,unitId:u.unitId}),originalExplicitReference:structuredClone(ref),
         sourceSelector:'submission.questionRecordLinks['+k+'].questionRefs['+j+']'}));
      });
     register({value:row,selector,ownerUnit:u.unitId,
      origin:{acceptedPath:state.acceptedPath,
       acceptedSubmissionSha256:accepted.submissionSha256,
       unitId:u.unitId,unitKind:u.kind,
       acceptedRecordSourceSelector:selector},extraRefs:extra});
    }
   }
  }
 }
 for(const [step,action] of Object.entries(canonical.actions??{})){
  for(const [field,rows] of Object.entries(action?.outputs??{})){
   if(!Array.isArray(rows))continue;
   for(const [i,row] of rows.entries()){
    const selector='actions.'+step+'.outputs.'+field+'['+i+']';
    const sources=sourceBySelector.get(selector)??[];
    const original=sources.length===1?sources[0]:null;
    const ownerUnit=original?.unitId??null;
    const additional=[];
    const links=originalLinkRows.get(ownerUnit)??[];
    for(const [k,link] of links.entries()){
     const matches=link?.acceptedOutputSelector===original?.acceptedSourceSelector?.replace(/^submission\./,'')||
      link?.recordKey===original?.recordKey||
      link?.outputSelector===original?.acceptedSourceSelector?.replace(/^submission\./,'');
     if(!matches||!Array.isArray(link.questionRefs))continue;
     consumedLinkRows.add(JSON.stringify([ownerUnit,k]));
     for(const [j,ref] of link.questionRefs.entries())
      additional.push({authored:typedQuestionReferenceV1(ref,{phase,unitId:ownerUnit}),
       originalExplicitReference:structuredClone(ref),
       sourceSelector:'submission.questionRecordLinks['+k+'].questionRefs['+j+']'});
    }
    register({value:row,selector,ownerUnit,recordKey:original?.recordKey??null,
     origin:original??(sources.length?{availability:'DUPLICATE_ORIGINAL_SOURCE'}:
      {availability:'SOURCE_RECORD_ORIGIN_NOT_RECORDED'}),
     extraRefs:additional});
   }
  }
 }
 for(const [unitId,links] of originalLinkRows){
  for(const [i,link] of links.entries()){
   if(consumedLinkRows.has(JSON.stringify([unitId,i])))continue;
   output.unresolvedReferences.push({
    unitId,originalQuestionReferenceSelector:
     'submission.questionRecordLinks['+i+']',
    originalOutputSource:saved.get(unitId)?.path??null,
    originalExplicitReference:structuredClone(link),
    status:'AI_EXPLICIT_OUTPUT_SELECTOR_NOT_FOUND'
   });
  }
 }
 for(const [i,q] of histories.questions.entries()){
  const identity=JSON.stringify([q.phaseSequence,q.unitId,q.questionId]);
  if(linked.has(identity))continue;
  output.unpromotedQuestions.push({
   phaseSequence:q.phaseSequence,unitId:q.unitId,questionId:q.questionId,
   questionSourceSelector:'automationOutputs.questionAnswerSources.questions['+i+']',
   questionTextSource:q.questionTextSource,
   answerVersionCount:q.answerVersions.length,
   statusFromCurrentIndex:q.statusFromCurrentIndex,
   disposition:'NO_EXPLICIT_OUTPUT_LINK_RECORDED_IN_CURRENT_CANONICAL'
  });
 }
 output.associationCount=output.associations.length;
 output.nonCanonicalEvidenceAssociationCount=
  output.nonCanonicalEvidenceAssociations.length;
 output.unpromotedQuestionCount=output.unpromotedQuestions.length;
 output.originalDirectQuestionFieldOwnerCount=output.originalDirectQuestionFieldOwners.length;
 output.availability='COLLECTED_NONBLOCKING';
 return output;
}

export function markFinalizationV1({root,campaignPath,phase,status,details=null}){
 const queue=read(root,queueRel(campaignPath,phase));
 queue.finalizeStatus=status;queue.finalizeDetails=details;
 queue.revision++;put(root,queueRel(campaignPath,phase),queue);
}
export function statusUnitQueueV1({root,campaignPath,phase}){
 const plan=maybe(root,planRel(campaignPath,phase))?readPlan(root,campaignPath,phase):null,queue=maybe(root,queueRel(campaignPath,phase));
 if(!plan||!queue)return null;
 const counts={},workers=new Set();
 for(const [id,s] of Object.entries(queue.units)){counts[s.status]=(counts[s.status]??0)+1;if(s.workerId)workers.add(s.workerId);}
 return {phase,counts,workers:[...workers].sort(),approvalBacklog:Object.values(queue.units).filter(x=>x.status==='SUBMITTED').length,
  eligible:available(queue,plan).map(x=>x.unitId),revision:queue.revision,finalizeStatus:queue.finalizeStatus};
}

// Compatibility surface only. Aggregate audit-quality outcomes are Worker-owned.
// Never invalidate an accepted record, reset a claim, or freeze a GitHub queue.
export function reopenAggregateDefectsV1({deficiencies=[]}={}){
  return {reopenedUnits:[],unmappedDeficiencies:Array.isArray(deficiencies)
    ?deficiencies.map(item=>typeof item==='string'?item:JSON.stringify(item))
    :[],invalidatedRecordIds:[],validationDelegatedTo:'CLOUDFLARE_WORKER'};
}

).test(name)).
     sort((a,b)=>Number(b.match(/_v([0-9]+)\.json$/)?.[1]??0)-
       Number(a.match(/_v([0-9]+)\.json$/)?.[1]??0));
    for(const name of names){
     const candidatePath=path.posix.join(receiptFolder,name);
     let receipt;
     try{receipt=read(root,candidatePath);}catch{continue;}
     const evidence=(receipt.evidence??[]).find(x=>
      x.role==='PHASE_CANONICAL_DATA'&&x.path===relative);
     if(['SEALED','COMPLETE'].includes(receipt.phase?.status)&&
        receipt.phase?.sequence===sourcePhase&&
        receipt.validation?.status==='PASS'&&
        receipt.campaign?.campaignId===directory.campaignId&&
        receipt.campaign?.campaignGenerationId===directory.campaignGenerationId&&
        evidence?.sha256===canonicalSha256){
      receiptPath=candidatePath;break;
     }
    }
    if(!receiptPath)
     throw Error('no sealed revision attests exact original direct-question canonical bytes');
    acceptance='ACCEPTED_RECEIPT_BOUND';
   }catch(error){
    out.unavailable.push({phaseSequence:sourcePhase,
     reason:'DIRECT_QUESTION_SOURCE_NOT_RECEIPT_VERIFIED',
     originalSourcePath:rel,sourceSha256,
     diagnostic:String(error?.message??error)});
    continue;
   }
  }
  out.sidecars.push({phaseSequence:sourcePhase,path:rel,sha256:sourceSha256,
   availability:acceptance,acceptedReceiptPath:sourcePhase<phase?receiptPath:null,
   acceptedCanonicalPath:sourcePhase<phase?canonicalPath:null,
   acceptedCanonicalSha256:sourcePhase<phase?canonicalSha256:null});
  out.histories.push({phaseSequence:sourcePhase,availability:acceptance,
   directQuestionSourcePath:rel,directQuestionSourceSha256:sourceSha256,
   acceptedReceiptPath:sourcePhase<phase?receiptPath:null,
   sourceMeaning:'ORIGINAL_DIRECT_FIXED_QUESTION_NOT_SECURITY_VERDICT'});
  for(const [i,record] of sidecar.records.entries()){
   if(!record||record.phaseSequence!==sourcePhase||
      !Number.isSafeInteger(record.step)||
      typeof record.unitId!=='string'||!record.unitId||
      record.originalShardPath!==path.posix.join(
       campaignPath,'work/phase-'+digits,'shards',record.unitId)||
      !/^[a-f0-9]{64}$/.test(record.originalShardSha256??'')||
      !Array.isArray(record.questionSources)){
    out.unavailable.push({phaseSequence:sourcePhase,
     reason:'DIRECT_QUESTION_RECORD_IDENTITY_UNAVAILABLE',sourcePath:rel,index:i});
    continue;
   }
   try{
    const bytes=fs.readFileSync(repoFile(root,record.originalShardPath));
    if(hex(bytes)!==record.originalShardSha256)
     throw Error('original accepted shard SHA-256 differs');
   }catch(error){
    out.unavailable.push({phaseSequence:sourcePhase,unitId:record.unitId,
     reason:'DIRECT_QUESTION_ACCEPTED_SHARD_UNAVAILABLE',
     diagnostic:String(error?.message??error)});
    continue;
   }
   if(!record.questionSources.length){
    out.unavailable.push({phaseSequence:sourcePhase,unitId:record.unitId,
     reason:'NO_ORIGINAL_DIRECT_QUESTION_PROOF_IN_ACCEPTED_SHARD',
     acceptedShardPath:record.originalShardPath});continue;
   }
   const groups=new Map();
   for(const [j,proof] of record.questionSources.entries()){
    if(!proof||proof.schemaVersion!=='curveyield-mi-accepted-direct-question-reference-v1'||
       proof.phaseSequence!==sourcePhase||proof.step!==record.step||
       proof.unitId!==record.unitId||proof.originalField!==record.originalField||
       typeof proof.questionId!=='string'||typeof proof.questionText!=='string'||
       proof.questionSha256!==hex(Buffer.from(proof.questionText,'utf8'))||
       proof.sourceSha256!==directory.sourceSha256||
       proof.authorityDigest!==directory.authorityDigest){
     out.unavailable.push({phaseSequence:sourcePhase,unitId:record.unitId,
      reason:'DIRECT_QUESTION_PROOF_IDENTITY_MISMATCH',sourcePath:rel,
      sourceSelector:'records['+i+'].questionSources['+j+']'});continue;
    }
    const id=JSON.stringify([proof.questionId,proof.questionSha256]);
    const group=groups.get(id)??{proof,versions:[],events:[]};
    const locator='records['+i+'].questionSources['+j+']';
    const event={checkpointRevision:j+1,mode:'DIRECT_SOURCE_BOUND',
     sourcePath:rel,sourceSha256,sourceSelector:locator,
     recordedStatus:proof.availability,
     sourceAcceptance:acceptance};
    group.events.push(event);
    if(proof.availability==='EXACT_PRIVATE_ORIGINAL_SHA256_VERIFIED'&&
       /^[a-f0-9]{64}$/.test(proof.originalAnswerSha256??'')&&
       typeof proof.privateR2Key==='string'&&
       proof.privateR2Key.endsWith('/'+proof.originalAnswerSha256+'.txt')&&
       proof.retrievalOperation==='direct_question_source'){
     group.versions.push({...event,
      originalAnswerSha256:proof.originalAnswerSha256,
      originalAnswerBytes:proof.originalAnswerBytes,
      originalPrivateR2Source:{key:proof.privateR2Key,
       sha256:proof.originalAnswerSha256,
       availability:'WORKER_R2_HASH_VERIFIED_AT_LOCAL_ACCEPTANCE',
       retrievalOperation:'direct_question_source',
       controllerAccepted:acceptance==='ACCEPTED_RECEIPT_BOUND'},
      fullAnswerTextInPublicGithub:false});
    }else out.unavailable.push({phaseSequence:sourcePhase,
     unitId:record.unitId,questionId:proof.questionId,
     reason:proof.availability??'DIRECT_PRIVATE_ANSWER_UNAVAILABLE',
     sourcePath:rel,sourceSelector:locator});
    groups.set(id,group);
   }
   for(const group of groups.values()){
    const proof=group.proof;
    out.questions.push({phaseSequence:sourcePhase,
     unitId:record.unitId,questionId:proof.questionId,
     questionTextSource:{path:rel,sha256:sourceSha256,
      selector:'records['+i+'].questionSources'},
     questionText:proof.questionText,
     questionIndexPath:rel,questionIndexSha256:sourceSha256,
     questionIndexRevision:null,sourceKind:'DIRECT_FIXED_ORIGINAL',
     originalDirectFieldPath:'actions.step-'+record.step+'.outputs.'+record.originalField,
     originalAcceptedShardPath:record.originalShardPath,
     originalAcceptedShardSha256:record.originalShardSha256,
     acceptedUnitPath:record.originalShardPath,
     acceptedUnitArtifactSha256:record.originalShardSha256,
     sourceAcceptance:acceptance,
     acceptedReceiptPath:sourcePhase<phase?receiptPath:null,
     checkpointEvents:group.events,answerVersions:group.versions,
     answered:group.versions.length>0,
     statusFromCurrentIndex:group.versions.length?'ANSWERED_SOURCE_BOUND':
      'ANSWER_SOURCE_UNAVAILABLE_OR_NOT_STAGED',
     securityDisposition:'NOT_INFERRED'});
   }
  }
 }
 return out;
}
// Exact, mechanically verified question sources. The history index and each
// checkpoint are immutable evidence; questions are NOT security outcomes.
// A later phase may refer to any earlier accepted question, including one
// that never contributed to a formal candidate or obligation.
export function collectAcceptedQuestionAnswerSourcesV1({root,campaignPath,directory,phase}){
 const out={schemaVersion:'curveyield-accepted-question-answer-sources-v1',
  phaseSequence:phase,campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,
  questions:[],unavailable:[],histories:[],checkpoints:[],
  directSourceSidecars:[],
  sourceMeaning:'QUESTION_HISTORY_NOT_SECURITY_DISPOSITION'};
 // Direct-phase evidence shares the existing canonical source/link schema.
 // The private answer text remains in R2, never in the public record.
 if(directory.authorityRelease==='machine-intelligence-v8'){
  const direct=collectDirectQuestionSourcesV1({root,campaignPath,directory,phase});
  out.questions.push(...direct.questions);
  out.unavailable.push(...direct.unavailable);
  out.histories.push(...direct.histories);
  out.checkpoints.push(...direct.checkpoints);
  out.directSourceSidecars=direct.sidecars;
 }
 for(const sourcePhase of [4,5,6]){
  if(sourcePhase>phase)continue;
  let refs;
  try{
   refs=collectAcceptedQuestionHistoryRefsV1({
    root,campaignPath,directory,phase:sourcePhase});
  }catch(error){
   out.unavailable.push({phaseSequence:sourcePhase,
    reason:'QUESTION_HISTORY_ROSTER_UNAVAILABLE',
    diagnostic:String(error?.message??error)});continue;
  }
  if(refs.availability!=='COLLECTED_NONBLOCKING')
   out.unavailable.push({phaseSequence:sourcePhase,
    reason:refs.availability??'QUESTION_HISTORY_UNAVAILABLE'});
  let plan=null,queue=null;
  try{
   plan=readPlan(root,campaignPath,sourcePhase);
   queue=read(root,queueRel(campaignPath,sourcePhase));
  }catch{/* Individual history may still retain its original reference. */}
  for(const history of refs.histories??[]){
   const ref={...history};
   out.histories.push(ref);
   const unitId=ref.unitId;
   const owner=queue?.units?.[unitId];
   const expectedUnit=plan?.units?.find(u=>u.unitId===unitId);
   const availability=ref.availability;
   if(availability!=='AVAILABLE'){
    out.unavailable.push({phaseSequence:sourcePhase,unitId,
     reason:availability??'INDEX_NOT_AVAILABLE',
     indexPath:ref.indexPath??null,
     previousCommittedIndex:ref.previousCommittedIndex??null});
    continue;
   }
   if(!owner||owner.status!=='ACCEPTED'||!expectedUnit||
      !owner.acceptedPath){
    out.unavailable.push({phaseSequence:sourcePhase,unitId,
     reason:'QUESTION_OWNER_NOT_ACCEPTED'});continue;
   }
   let accepted,index;
   try{
    accepted=read(root,owner.acceptedPath);
    const original=fs.readFileSync(repoFile(root,ref.indexPath));
    if(hex(original)!==ref.indexSha256)
     throw Error('question index digest does not match accepted reference');
    index=hydratePagedQuestionIndexV1(root,JSON.parse(original.toString('utf8')),ref.indexPath);
    if(index.schemaVersion!=='curveyield-ai-question-index-v1'||
       index.phaseSequence!==sourcePhase||index.unitId!==unitId||
       index.phaseEpoch!==accepted.phaseEpoch||
       index.packetSha256!==accepted.packetSha256||
       index.campaignId!==directory.campaignId||
       index.campaignGenerationId!==directory.campaignGenerationId||
       index.sourceSha256!==directory.sourceSha256||
       index.authorityDigest!==directory.authorityDigest||
       accepted.unitId!==unitId||accepted.phaseSequence!==sourcePhase||
       accepted.submissionSha256!==owner.acceptedSha256||
       accepted.packetSha256!==index.packetSha256)
     throw Error('question index or accepted owner identity differs');
   }catch(error){
    out.unavailable.push({phaseSequence:sourcePhase,unitId,
     reason:'INDEX_OR_ACCEPTED_SOURCE_UNREADABLE',
     diagnostic:String(error?.message??error),
     indexPath:ref.indexPath??null});continue;
   }
   const keyMap=new Map();
   for(const [i,question] of (index.questions??[]).entries()){
    if(!question||typeof question.questionId!=='string'){
     out.unavailable.push({phaseSequence:sourcePhase,unitId,
      questionIndexOrdinal:i,reason:'INDEX_QUESTION_IDENTITY_UNREADABLE',
      questionIndexPath:ref.indexPath});continue;
    }
    const identity=JSON.stringify([sourcePhase,unitId,question.questionId]);
    const entry={phaseSequence:sourcePhase,unitId,
     questionId:question.questionId,round:question.round??null,
     answered:question.answered??null,
     statusFromCurrentIndex:question.answered===true?'ANSWERED':
      question.answered===false?'PLANNED':'INDEX_STATUS_UNSPECIFIED',
     questionTextSource:index._questionPageSources?.[question.questionId]??
      {path:ref.indexPath,sha256:ref.indexSha256,
       selector:'questions['+i+'].questionText'},
     questionIndexPath:ref.indexPath,questionIndexSha256:ref.indexSha256,
     questionIndexRevision:index.revision,
     currentAnswerCheckpoint:question.answerCheckpoint??null,
     currentAnswerCheckpointSource:index._answerPageSources?.[question.questionId]??
      {path:ref.indexPath,sha256:ref.indexSha256,
       selector:'questions['+i+'].answerCheckpoint'},
     packetSha256:accepted.packetSha256,
     acceptedUnitPath:owner.acceptedPath,
     acceptedUnitArtifactSha256:hex(fs.readFileSync(repoFile(root,owner.acceptedPath))),
     acceptedSubmissionSha256:accepted.submissionSha256,
     // Preserve question creation and subsequent source events separately.
     // PLAN/EXPAND with null answers are not answered revisions.
     checkpointEvents:[],answerVersions:[]};
    out.questions.push(entry);keyMap.set(identity,entry);
   }
   // Every immutable checkpoint revision, not just the last answer, remains
   // addressable. An ANSWERS or REVISE event is not a security resolution.
   for(const [checkpointIndex,checkpoint] of (index.checkpoints??[]).entries()){
    if(!checkpoint||typeof checkpoint.path!=='string'){
     out.unavailable.push({phaseSequence:sourcePhase,unitId,
      checkpointIndex,reason:'CHECKPOINT_REFERENCE_UNREADABLE',
      questionIndexPath:ref.indexPath});continue;
    }
    let source,rawSha;
    try{
     const raw=fs.readFileSync(repoFile(root,checkpoint.path));
     rawSha=hex(raw);
     if(rawSha!==checkpoint.sha256)
      throw Error('checkpoint SHA-256 differs from index');
     source=JSON.parse(raw.toString('utf8'));
     if(!Array.isArray(source.records)||
        Number.isSafeInteger(checkpoint.recordCount)&&
         source.records.length!==checkpoint.recordCount)
      throw Error('checkpoint source record count differs from index');
     if(source.schemaVersion!=='curveyield-ai-question-checkpoint-v1'||
        source.phaseSequence!==sourcePhase||source.unitId!==unitId||
        source.packetSha256!==accepted.packetSha256||
        source.campaignGenerationId!==directory.campaignGenerationId||
        source.sourceSha256!==directory.sourceSha256||
        source.authorityDigest!==directory.authorityDigest||
        source.phaseEpoch!==accepted.phaseEpoch||
        source.revision!==checkpoint.revision)
      throw Error('checkpoint source authority identity differs');
    }catch(error){
     out.unavailable.push({phaseSequence:sourcePhase,unitId,
      reason:'CHECKPOINT_UNAVAILABLE',path:checkpoint.path,
      sha256:checkpoint.sha256,revision:checkpoint.revision,
      diagnostic:String(error?.message??error)});continue;
    }
    // PLAN, EXPAND, ANSWERS, REVISE and COMPLETE are durable events.
    // COMPLETE is merely the AI's question-ledger decision, not a
    // determination that every security risk has been resolved.
    out.checkpoints.push({
     phaseSequence:sourcePhase,unitId,
     revision:checkpoint.revision,mode:source.mode,
     path:checkpoint.path,sha256:checkpoint.sha256,
     packetSha256:accepted.packetSha256,
     acceptedUnitPath:owner.acceptedPath,
     recordCount:source.records.length,
     recordedAt:source.recordedAt??null,
     requestId:source.requestId??checkpoint.requestId??null,
     ...(Object.hasOwn(source,'revisionReason')?{
      revisionReasonSource:{path:checkpoint.path,sha256:checkpoint.sha256,
       selector:'revisionReason'}}:{}),
     ...(Object.hasOwn(source,'aiCompletionDecision')?{
      completionDecisionSource:{path:checkpoint.path,sha256:checkpoint.sha256,
       selector:'aiCompletionDecision'}}:{}),
     ...(Object.hasOwn(source,'decision')?{
      completionDecisionSource:{path:checkpoint.path,sha256:checkpoint.sha256,
       selector:'decision'}}:{})
    });
    for(const [i,record] of source.records.entries()){
     if(!record||typeof record.questionId!=='string')continue;
     const identity=JSON.stringify([sourcePhase,unitId,record.questionId]);
     const question=keyMap.get(identity);
     if(!question){
      out.unavailable.push({phaseSequence:sourcePhase,unitId,
       questionId:record.questionId,reason:'CHECKPOINT_QUESTION_NOT_IN_INDEX',
       path:checkpoint.path,revision:checkpoint.revision});continue;
     }
     const checkpointEvent={
      checkpointRevision:checkpoint.revision,mode:source.mode,
      checkpointPath:checkpoint.path,checkpointSha256:checkpoint.sha256,
      checkpointRecordSelector:'records['+i+']',
      ...(Object.hasOwn(record,'questionText')?
       {historicalQuestionTextSelector:'records['+i+'].questionText'}:{}),
      recordedStatus:record.status??null,
      revisionReasonSource:source.mode==='REVISE'&&
       Object.hasOwn(source,'revisionReason')?
       {path:checkpoint.path,sha256:checkpoint.sha256,
        selector:'revisionReason'}:null
     };
     question.checkpointEvents.push(checkpointEvent);
     // An answer version requires an actually authored non-null answer,
     // not a planned question merely appearing in an EXPAND checkpoint.
     if(source.mode==='ANSWERS'||source.mode==='REVISE'){
      if(typeof record.answerText==='string')
       question.answerVersions.push({...checkpointEvent,
        answerTextSourceSelector:'records['+i+'].answerText'});
      else if(record.answerManifest){
       try{
        const sourceBound=verifiedSegmentedAnswerSourceV1(
         root,record.answerManifest,{...index,questionIndexPath:ref.indexPath},question);
        question.answerVersions.push({...checkpointEvent,
         answerTextSourceSelector:'records['+i+'].answerManifest',
         ...sourceBound});
       }catch(error){
        out.unavailable.push({phaseSequence:sourcePhase,unitId,
         questionId:record.questionId,checkpointIndex,
         reason:'SEGMENTED_ANSWER_SOURCE_UNAVAILABLE',
         checkpointPath:checkpoint.path,
         manifestPath:record.answerManifest?.path??null,
         diagnostic:String(error?.message??error)});
       }
      }
     }
    }
   }
  }
 }
 out.questionCount=out.questions.length;
 out.answerVersionCount=out.questions.reduce((n,q)=>n+q.answerVersions.length,0);
 out.checkpointCount=out.checkpoints.length;
 out.availability=out.unavailable.length?'PARTIAL_OR_SOURCE_UNAVAILABLE':'COLLECTED_NONBLOCKING';
 return out;
}

const asArray=x=>Array.isArray(x)?x:[];
const isObject=x=>x&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>structuredClone(x);
// Bind acceptance to the exact original-record evidence, even when a parent
// batch is undergoing targeted rework and its unrelated siblings remain valid.
function prerequisiteEvidence(queue,dependencies){
 const evidence={};
 for(const id of asArray(dependencies)){
  const record=queue.acceptedRecords?.[id];
  if(record?.status==='ACCEPTED'&&record.snapshotSha256){
   evidence[id]='RECORD:'+record.snapshotSha256;continue;
  }
  const unit=queue.units[id];
  if(unit?.status==='ACCEPTED'&&unit.acceptedPath&&unit.acceptedSha256){
   evidence[id]='UNIT:'+unit.acceptedPath+':'+unit.acceptedSha256;continue;
  }
  return null;
 }
 return evidence;
}
// The Worker/adapter decides audit prerequisites; GitHub only manages the queue.
const depSatisfied=()=>true;
const dependenciesFresh=()=>true;
const isPhase=(p)=>[4,5,6].includes(p);
const RELEASES=new Set(['machine-intelligence-v7','machine-intelligence-v8']);
const authorityFor=directory=>{
  if(!RELEASES.has(directory.authorityRelease))throw Error('unsupported Machine Intelligence release');
  return directory.authorityRelease==='machine-intelligence-v8'?'Machine Intelligence Audit Controller/Audit Skill v8':'Machine Intelligence Audit Controller/Audit Skill v7';
};
const rowId=(phase,field,index)=>{
 const families={
 '4:discoveryReconciliationRecords':'P4-RC','4:specialistReviewRecords':'P4-SP',
 '4:candidateRecords':'P4-C','4:typedLimitations':'P4-L','4:obligationDispositions':'P4-OB',
 '5:economicReviewRecords':'P5-E','5:reconciliationRecords':'P5-R','5:targetDesigns':'P5-T','5:newCandidateRecords':'P5-R',
 '6:deploymentAssessments':'P6-D','6:targetDispositions':'P6-T',
 '6:baselineTestRecords':'P6-B','6:candidateProofRecords':'P6-P',
 '6:mergedExecutionConclusions':'P6-C','6:obligationDispositions':'P6-C',
 '6:typedExecutionLimitations':'P6-L','6:fullOnlyOmissions':'P6-O','6:newCandidateRecords':'P6-P'
 };
 const prefix=families[phase+':'+field];
 if(!prefix)throw Error('unassigned semantic field '+phase+':'+field);
 return prefix+'-'+String(index+1).padStart(3,'0');
};
function assertParallelSolo(directory,phase,request=null){
 if(!isPhase(phase)||directory.mode!=='LITE_SOLO'||!RELEASES.has(directory.authorityRelease))
  throw Error('Machine Intelligence parallel controller requires the fork-owned authority');
 // This is the executable model of the isolated v7 fork. A historical
 // directory may predate the field; code upgrades must not strand it.
 if(directory.executionModel!=='PARALLEL_WORKER_UNITS')
  directory.executionModel='PARALLEL_WORKER_UNITS';
 if(directory.currentAssignment?.phaseSequence!==phase)throw Error('phase not current/assigned');
 if(request){
  const expected={campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,
   phaseSequence:phase,sourceSha256:directory.sourceSha256,
   auditControllerRef:'machine-intelligence-audit-controller-v1'};
  for(const [key,value] of Object.entries(expected))if(request[key]!==value)throw Error('request identity mismatch: '+key);
  if(request.authorityDigest!==directory.authorityDigest)
   throw Error('authority digest differs from bound campaign');
  if(request.phaseEpoch!==Number(directory.unitPhaseEpoch??1))throw Error('stale phase epoch');
 }
}
function emptyPlan(directory,phase){
 return {schemaVersion:'curveyield-lite-solo-unit-plan-v1',campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,phaseSequence:phase,phaseEpoch:Number(directory.unitPhaseEpoch??1),
  sourceSha256:directory.sourceSha256,authorityDigest:directory.authorityDigest,
  unitSpecRevision:1,campaignPath:directory.workspacePath,units:[],recordOwnership:{},stage:phase===4?'CORRECTNESS':'SEMANTIC'};
}
function emptyQueue(plan){
 return {schemaVersion:'curveyield-lite-solo-unit-queue-state-v1',campaignId:plan.campaignId,
  campaignGenerationId:plan.campaignGenerationId,phaseSequence:plan.phaseSequence,
  phaseEpoch:plan.phaseEpoch,sourceSha256:plan.sourceSha256,authorityDigest:plan.authorityDigest,
  unitSpecRevision:plan.unitSpecRevision,stage:plan.stage,
  units:{},acceptedRecords:{},processedRequests:{},processedRequestHashes:{},revision:0,finalizeStatus:'NOT_STARTED',newlyEligibleUnitIds:[]};
}
function addUnit(plan,queue,unit){
 if(queue.units[unit.unitId]||plan.units.some(x=>x.unitId===unit.unitId))throw Error('duplicate unit '+unit.unitId);
 const status=asArray(unit.dependencies).length?'BLOCKED_DEPENDENCY':'AVAILABLE';
 plan.units.push(unit);queue.units[unit.unitId]={status,workerId:null,claimEpoch:0,
  claimToken:null,acceptedSha256:null,lastSubmissionSha256:null,lastErrors:[],attempts:0};
}
function assertPlan(queue,plan){
 for(const k of ['campaignId','campaignGenerationId','phaseSequence','phaseEpoch','sourceSha256','authorityDigest','unitSpecRevision'])
  if(queue[k]!==plan[k])throw Error('unit plan/queue identity differs: '+k);
}
const PREFILL_PART_BYTES=12*1024;
const prefillPartRel=(rel,i)=>path.posix.join(path.posix.dirname(rel),'prefill-pages',
 path.posix.basename(rel,'.json')+'_PART_'+String(i+1).padStart(6,'0')+'_v1.json');
function writePagedPrefillV1(root,rel,value){
 const raw=Buffer.from(pretty({value}),'utf8'),count=Math.ceil(raw.length/PREFILL_PART_BYTES);
 for(let i=0;i<count;i++){
  const part=raw.subarray(i*PREFILL_PART_BYTES,(i+1)*PREFILL_PART_BYTES);
  const page={schemaVersion:'curveyield-lite-solo-unit-prefill-page-v1',index:i+1,
   total:count,offset:i*PREFILL_PART_BYTES,sha256:hex(part),base64:part.toString('base64')};
  if(Buffer.byteLength(pretty(page))>24*1024)throw Error('prefill page exceeds 24 KiB');
  put(root,prefillPartRel(rel,i),page);
 }
 const manifest={schemaVersion:'curveyield-lite-solo-unit-prefill-manifest-v1',
  sha256:hex(raw),byteLength:raw.length,partBytes:PREFILL_PART_BYTES,pageCount:count};
 put(root,rel,manifest);return manifest;
}
function readPagedPrefillV1(root,rel,rawManifest){
 const manifest=JSON.parse(rawManifest.toString('utf8'));
 if(manifest.schemaVersion!=='curveyield-lite-solo-unit-prefill-manifest-v1')
  return manifest.value;
 if(!Number.isSafeInteger(manifest.pageCount)||manifest.pageCount<1||
    manifest.partBytes!==PREFILL_PART_BYTES||!/^[a-f0-9]{64}$/.test(manifest.sha256))
  throw Error('invalid bounded prefill manifest');
 const chunks=[];
 for(let i=0;i<manifest.pageCount;i++){
  const page=read(root,prefillPartRel(rel,i));
  if(page.schemaVersion!=='curveyield-lite-solo-unit-prefill-page-v1'||
     page.index!==i+1||page.total!==manifest.pageCount||
     page.offset!==i*PREFILL_PART_BYTES)throw Error('prefill page identity mismatch');
  const part=Buffer.from(page.base64,'base64');
  if(part.length>PREFILL_PART_BYTES||hex(part)!==page.sha256)
   throw Error('prefill page digest mismatch');
  chunks.push(part);
 }
 const full=Buffer.concat(chunks);
 if(full.length!==manifest.byteLength||hex(full)!==manifest.sha256)
  throw Error('prefill reconstruction digest mismatch');
 return JSON.parse(full.toString('utf8')).value;
}
function readPlan(root,campaign,phase){
 const index=read(root,planRel(campaign,phase));
 if(index.schemaVersion!=='curveyield-lite-solo-unit-plan-v1'||!Array.isArray(index.pages))
  throw Error('unrecognized or unpaged v4 unit plan');
 // Normalize only a Git-verified alias of this same exact campaign workspace.
 const prior=index.campaignPath;
 if(prior!==campaign){
  if(typeof prior!=='string'||!/^campaigns\/[^/]+$/.test(prior)||
     !/^campaigns\/[^/]+\/[^/]+$/.test(campaign))
   throw Error('unit plan campaign path mismatch');
  const alias=repoFile(root,prior),current=repoFile(root,campaign);
  if(!fs.lstatSync(alias).isSymbolicLink()||fs.realpathSync(alias)!==fs.realpathSync(current))
   throw Error('unit plan location lacks verified migration alias');
 }
 const canonical=s=>typeof s==='string'&&prior!==campaign&&s.startsWith(prior+'/')
  ?campaign+s.slice(prior.length):s;
 const units=[];
 for(const p of index.pages){
  const raw=fs.readFileSync(repoFile(root,p.path));
  if(hex(raw)!==p.sha256||raw.length>32768)throw Error('unit plan page digest/size mismatch: '+p.path);
  const data=JSON.parse(raw.toString('utf8'));
  for(const u of data.units){
   if(u.initialValueRef){
    const rawValue=fs.readFileSync(repoFile(root,u.initialValueRef));
    if(hex(rawValue)!==u.initialValueSha256)throw Error('unit prefill digest mismatch');
    u.initialValue=readPagedPrefillV1(root,u.initialValueRef,rawValue);
   }
   if(u.issuedMetaRef){
    const raw=fs.readFileSync(repoFile(root,u.issuedMetaRef));
    if(hex(raw)!==u.issuedMetaSha256)
     throw Error('issued roster metadata changed after delivery: '+u.unitId);
    u.issuedMeta=readPagedPrefillV1(root,u.issuedMetaRef,raw);
   }
   if(u.kind==='BATCH'){
    if(!u.membersRef||u.membersRef!==u.packetPath)throw Error('missing batch assignment manifest');
    const raw=fs.readFileSync(repoFile(root,u.membersRef));
    if(hex(raw)!==u.packetSha256)throw Error('batch packet digest mismatch');
    const payload=readPagedPrefillV1(root,u.membersRef,raw);
    if(payload.unitId!==u.unitId||payload.phaseSequence!==phase||
       payload.schemaVersion!=='curveyield-lite-solo-batched-assignment-v1'||
       !Array.isArray(payload.members)||payload.members.length<2)
      throw Error('invalid batch assignment payload');
    u.members=payload.members;
   }
   units.push(u);
  }
 }
 if(units.length!==index.unitCount)throw Error('missing unit plan pages');
 const ownership={};
 for(const u of units){
  for(const m of u.kind==='BATCH'?u.members:[u]){
   if(!m.path)continue;
   const key=m.kind==='APPEND'?dot([...m.path,
    m.appendChunkNumber>1?'APPEND-C'+String(m.appendChunkNumber).padStart(4,'0'):'APPEND']):
    Number.isInteger(m.recordIndex)?dot([...m.path,String(m.recordIndex)]):null;
   if(!key)continue;
   if(ownership[key])throw Error('duplicate canonical unit owner: '+key);
   ownership[key]=u.unitId;
  }
 }
 for(const u of units){
  for(const key of ['packetPath','packetIndexPath','shardPath','membersRef','initialValueRef'])
   if(typeof u[key]==='string')u[key]=canonical(u[key]);
 }
 return {...index,campaignPath:campaign,units,recordOwnership:ownership};
}
function publishPlan(root,campaign,phase,plan,queue){
 assertPlan(queue,plan);
 const planDir=path.posix.join(rootOf(campaign,phase),'plan');
 const previous=maybe(root,planRel(campaign,phase));
 if(previous&&Array.isArray(previous.pages)&&
    Number.isInteger(previous.unitCount)&&
    previous.unitCount<plan.units.length&&
    plan.units.some(u=>u.appendChunkNumber>1)){
  // A new continuation may grow the plan but may NEVER rewrite an already
  // issued plan page. Compare exact stored metadata, including frozen refs,
  // and append new bounded pages only. Existing issued byte hashes persist.
  const priorUnits=previous.pages.flatMap(ref=>{
   const raw=fs.readFileSync(repoFile(root,ref.path));
   if(hex(raw)!==ref.sha256)throw Error('frozen unit plan page digest mismatch');
   return JSON.parse(raw.toString('utf8')).units;
  });
  if(priorUnits.length!==previous.unitCount)
   throw Error('frozen unit plan page count mismatch');
  const serialized=plan.units.map(unit=>{
   const u=clone(unit);
   delete u.issuedMeta;
   if(u.kind==='BATCH')delete u.members;
   if(u.initialValueRef)delete u.initialValue;
   return u;
  });
  for(let i=0;i<priorUnits.length;i++)
   if(JSON.stringify(priorUnits[i])!==JSON.stringify(serialized[i]))
    throw Error('APPEND_CONTINUATION_FROZEN_UNIT_CHANGED: '+
     String(priorUnits[i]?.unitId??i));
  const newPages=[...previous.pages],suffix=serialized.slice(priorUnits.length);
  let pending=[];
  const flush=()=>{
   if(!pending.length)return;
   const file='UNIT_PLAN_PAGE_'+String(newPages.length+1).padStart(4,'0')+'_v1.json';
   const rel=path.posix.join(planDir,file);
   const content={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:pending};
   const raw=pretty(content);
   if(Buffer.byteLength(raw)>32768)throw Error('continuation plan page exceeds 32 KiB');
   put(root,rel,content);
   newPages.push({path:rel,sha256:hex(Buffer.from(raw)),count:pending.length});
   pending=[];
  };
  for(const u of suffix){
   if(pending.length&&Buffer.byteLength(pretty({
    schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:[...pending,u]}))>30000)
    flush();
   pending.push(u);
  }
  flush();
  const {units,recordOwnership,...metadata}=plan;
  put(root,planRel(campaign,phase),{...metadata,unitCount:units.length,pages:newPages});
  put(root,queueRel(campaign,phase),queue);
  return;
 }
 const pages=[];let batch=[];
 const flush=()=>{
  if(!batch.length)return;
  const rel=path.posix.join(planDir,'UNIT_PLAN_PAGE_'+String(pages.length+1).padStart(4,'0')+'_v1.json');
  const payload={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:batch};
  const raw=pretty(payload);
  if(Buffer.byteLength(raw)>32768)throw Error('unit plan page exceeds 32 KiB');
  const filePath=repoFile(root,rel);
  if(!fs.existsSync(filePath)||
     fs.readFileSync(filePath,'utf8')!==raw){
   if(fs.existsSync(filePath)){
    const prior=read(root,rel);
    for(const priorUnit of asArray(prior.units)){
     if(queue.units[priorUnit.unitId]?.status==='ACCEPTED'){
      const current=payload.units.find(u=>u.unitId===priorUnit.unitId);
      if(!current||JSON.stringify(current)!==JSON.stringify(priorUnit))
       throw Error('FROZEN_ACCEPTED_UNIT_METADATA_CHANGED: '+priorUnit.unitId);
     }
    }
   }
   put(root,rel,payload);
  }
  pages.push({path:rel,sha256:hex(Buffer.from(raw)),count:batch.length});batch=[];
 };
 for(const unit of plan.units){
  const u=clone(unit);
  // The original metadata remains in the paged-prefill format.
  delete u.issuedMeta;
  if(u.kind==='BATCH'){
   if(!u.membersRef||!u.packetPath||!u.members?.length)throw Error('invalid batch plan serialization');
   delete u.members;
  }
  if(Buffer.byteLength(pretty(u))>12000&&u.initialValue!==undefined){
   const rel=path.posix.join(unitBase(campaign,phase,u.unitId),'UNIT_PREFILL_v1.json');
   const manifest=writePagedPrefillV1(root,rel,u.initialValue);
   u.initialValueRef=rel;u.initialValueSha256=sha(manifest);delete u.initialValue;
  }
  const trial={schemaVersion:'curveyield-lite-solo-unit-plan-page-v1',units:[...batch,u]};
  if(batch.length&&Buffer.byteLength(pretty(trial))>30000)flush();
  batch.push(u);
 }
 flush();
 const {units,recordOwnership,...metadata}=plan;
 put(root,planRel(campaign,phase),{...metadata,unitCount:units.length,pages});
 put(root,queueRel(campaign,phase),queue);
}
// Issued answer bindings are campaign data: preserve their original bytes
// when the executable Contract-Automation branch is upgraded.
export function freezeIssuedUnitMetaV1({root,campaignPath,phase,issued=[]}){
 if(!issued.length)return false;
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 assertPlan(queue,plan);
 const lookup=new Map(plan.units.map(u=>[u.unitId,u]));
 let changed=false;
 for(const {unitId,meta} of issued){
  const u=lookup.get(unitId);
  if(!u)throw Error('issued metadata references unknown unit '+unitId);
  if(u.issuedMetaRef)continue;
  const rel=path.posix.join(unitBase(campaignPath,phase,unitId),'ISSUED_META_v1.json');
  const manifest=writePagedPrefillV1(root,rel,meta);
  u.issuedMetaRef=rel;u.issuedMetaSha256=sha(manifest);
  changed=true;
 }
 if(changed)publishPlan(root,campaignPath,phase,plan,queue);
 return changed;
}
export function createUnitPlanV1({root,campaignPath,directory,phase,automationRoot=process.cwd()}){
 assertParallelSolo(directory,phase);
 const existing=maybe(root,queueRel(campaignPath,phase));
 if(existing)return existing;
 const plan=emptyPlan(directory,phase),queue=emptyQueue(plan);
 if(phase===4){
  const rel=reviewInventoryRelV1(root,campaignPath,'FLOW_PLAN_v1.json'),flow=read(root,rel);
  const units=[...asArray(flow.payload?.reviewUnits),...asArray(flow.payload?.attackUnits)];
  // Worker owns inventory quality assessment; preserve actual gaps as diagnostics.
  if(asArray(flow.payload?.gaps).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code)))
   plan.githubDiagnostics=[...(plan.githubDiagnostics??[]),'PHASE4_REVIEW_INVENTORY_INCOMPLETE'];
  // With no worker-issued units there are no submissions to package.
  if(!units.length)throw Error('AWAITING_WORKER_ISSUED_PHASE4_UNITS');
  const fIds=units.filter(u=>u.unitId.startsWith('F-')||u.unitId.startsWith('R-')).map(u=>u.unitId);
  for(const u of units){
   if(!/^[FRX]-\d{3}$/.test(u.unitId))throw Error('unsupported discovery unit '+u.unitId);
   const packet=buildUnitPacketV1({root,campaignPath,directory,authorityRoot:authorityFor(directory),
    automationRoot,unitId:u.unitId,state:null,now:new Date().toISOString(),persist:true});
   const packetRel=path.posix.join(campaignPath,'work/phase-04/discovery',u.unitId,'ASSIGNMENT_PACKET_v1.json');
   const idx=writeUnitPacketIndexV1({root,campaignPath,unitId:u.unitId,role:u.unitId.startsWith('X-')?'ATTACK':'FLOW_REVIEW'});
   addUnit(plan,queue,{unitId:u.unitId,kind:u.unitId.startsWith('X-')?'ATTACK':'FLOW',
    dependencies:u.unitId.startsWith('X-')?fIds:[],
    packetPath:packetRel,packetIndexPath:idx,packetSha256:hex(fs.readFileSync(repoFile(root,packetRel))),
    unitSpecRevision:1});
  }
 }else addShardUnits({root,campaignPath,directory,phase,plan,queue});
 queue.newlyEligibleUnitIds=plan.units.filter(x=>queue.units[x.unitId].status==='AVAILABLE').map(x=>x.unitId);
 publishPlan(root,campaignPath,phase,plan,queue);
 directory.unitQueueIndexPath=planRel(campaignPath,phase);
 directory.unitQueueStatePath=queueRel(campaignPath,phase);
 if(directory.currentAssignment?.phaseSequence===phase){
  directory.currentAssignment.unitQueueIndexPath=directory.unitQueueIndexPath;
  directory.currentAssignment.unitQueueStatePath=directory.unitQueueStatePath;
 }
 directory.executionModel='PARALLEL_WORKER_UNITS';
 return queue;
}

function consolidateNewSemanticUnitsV1({root,campaignPath,phase,plan,queue}){
 const proposed=planSemanticBatchesV1(plan.units,phase);
 const selected=proposed.batches.filter(b=>b.members.length>1);
 if(!selected.length)return;
 const replacements=new Map(),removed=new Set(),serial={};
 for(const group of selected){
  const family=group.members[0].unitId.replace(/-[0-9]+$/,'');
  const number=(serial[family]??0)+1;serial[family]=number;
  const id=family+'-B'+String(number).padStart(4,'0');
  if(queue.units[id])throw Error('batched unit identity collision: '+id);
  if(group.members.some(m=>!['AVAILABLE','BLOCKED_DEPENDENCY'].includes(queue.units[m.unitId]?.status)))
   throw Error('cannot rebatch an already claimed, submitted or accepted unit');
  const payload={schemaVersion:'curveyield-lite-solo-batched-assignment-v1',unitId:id,
   phaseSequence:phase,field:group.field,groupKeys:group.groupKeys,members:group.members,
   readingGuide:SEMANTIC_BATCH_READING_GUIDE_V1};
  const packetPath=path.posix.join(unitBase(campaignPath,phase,id),'ASSIGNMENT_PACKET_v1.json');
  const manifest=writePagedPrefillV1(root,packetPath,payload);
  const spec={unitId:id,kind:'BATCH',field:group.field,members:group.members,
   memberUnitIds:group.memberUnitIds,recordCount:group.members.length,
   membersRef:packetPath,packetPath,packetSha256:sha(manifest),
   dependencies:[...new Set(group.members.flatMap(m=>asArray(m.dependencies)))],
   unitSpecRevision:1};
  replacements.set(group.members[0].unitId,spec);
  for(const m of group.members){
   removed.add(m.unitId);delete queue.units[m.unitId];
   plan.recordOwnership[dot([...m.path,String(m.recordIndex)])]=id;
  }
  addUnit(plan,queue,spec);
 }
 const original=plan.units.filter(u=>!removed.has(u.unitId)&&u.kind!=='BATCH');
 plan.units.splice(0,plan.units.length,...original,...replacements.values());
}

function addShardUnits({root,campaignPath,directory,phase,plan,queue}){
 const idxRel=directory.currentAssignment?.workShardIndexPath;
 if(!idxRel)throw Error('missing canonical semantic shard index');
 const index=read(root,idxRel),dir=path.posix.dirname(idxRel);
 if(index.phase!==phase)throw Error('shard phase mismatch');
 const descriptors=asArray(index.pages).flatMap(p=>asArray(read(root,path.posix.join(dir,p.file)).shards));
 const serial={};
 // One monotonic namespace per semantic unit family, including related fields.
 const nextId=field=>{
  const family=rowId(phase,field,0).slice(0,-4);
  const index=serial[family]??0;
  serial[family]=index+1;
  return rowId(phase,field,index);
 };
 for(const d of descriptors){
  const field=d.path?.at(-1);
  if(!field)throw Error('missing work shard field');
  // Controller-owned machine-derived limitation/omission fields are not worker-editable.
  if(phase===6&&['typedExecutionLimitations','fullOnlyOmissions'].includes(field))continue;
  const slab=read(root,path.posix.join(dir,d.file));
  const slabPacketSha256=hex(fs.readFileSync(repoFile(root,path.posix.join(dir,d.file))));
  if(d.append){
   const id=nextId(field),ownership=dot([...d.path,'APPEND']);
   if(plan.recordOwnership[ownership])throw Error('duplicate canonical append owner: '+ownership);
   plan.recordOwnership[ownership]=id;
   const unit={unitId:id,kind:'APPEND',field,shardFile:d.file,shardIndex:0,
    shardPath:path.posix.join(dir,d.file),
    packetSha256:slabPacketSha256,
    recordKeys:[],path:d.path,dependencies:[],unitSpecRevision:1};
   addUnit(plan,queue,unit);continue;
  }
  for(let n=0;n<slab.entries.length;n++){
   const entry=slab.entries[n],id=nextId(field);
   const ownership=dot([...d.path,String(d.startIndex+n)]);
   if(plan.recordOwnership[ownership])throw Error('duplicate canonical record owner: '+ownership);
   plan.recordOwnership[ownership]=id;
   addUnit(plan,queue,{unitId:id,kind:'SHARD',field,shardFile:d.file,
    shardPath:path.posix.join(dir,d.file),
    packetSha256:slabPacketSha256,
    shardIndex:n,recordIndex:d.startIndex+n,
    recordKeys:[entry.key],initialValue:entry.value,path:d.path,
    dependencies:[],unitSpecRevision:1});
  }
 }
 // Preserve semantic prerequisites: target design requires its related reconciliation row,
 // not a blanket dependency on every economic or reconciliation unit.
 if(phase===5){
  const reconc=plan.units.filter(u=>u.field==='reconciliationRecords');
  const novel=plan.units.filter(u=>u.field==='newCandidateRecords');
  const economic=plan.units.filter(u=>u.field==='economicReviewRecords');
  for(const u of plan.units.filter(u=>u.field==='targetDesigns')){
   const candidate=u.initialValue?.candidateKey;
   const linkedEconomic=economic.filter(row=>candidate&&Array.isArray(row.initialValue?.relatedCandidateKeys)&&
    row.initialValue.relatedCandidateKeys.includes(candidate)).map(row=>row.unitId);
   const reconciled=u.kind==='APPEND'?novel.map(row=>row.unitId):
    reconc.filter(row=>candidate&&row.initialValue?.subjectKey===candidate).map(row=>row.unitId);
   u.dependencies=[...new Set([...reconciled,...linkedEconomic])];
  }
 }
 if(phase===6){
  const interpretations=plan.units.filter(u=>['deploymentAssessments','targetDispositions'].includes(u.field));
  const proofs=plan.units.filter(u=>['baselineTestRecords','candidateProofRecords','newCandidateRecords'].includes(u.field));
  // A merged conclusion is global, but obligation rows depend only on matching baseline groups.
  const allPrerequisites=[...interpretations,...proofs].map(u=>u.unitId);
  for(const u of plan.units.filter(u=>u.field==='mergedExecutionConclusions'))
   u.dependencies=allPrerequisites;
  for(const u of plan.units.filter(u=>u.field==='obligationDispositions')){
   const obligationId=u.initialValue?.obligationId;
   u.dependencies=u.kind==='APPEND'?[]:proofs.filter(p=>
    p.field==='baselineTestRecords'&&Array.isArray(p.initialValue?.obligationIds)&&
    p.initialValue.obligationIds.includes(obligationId)).map(p=>p.unitId);
  }
 }
 consolidateNewSemanticUnitsV1({root,campaignPath,phase,plan,queue});
 // Only newly issued available semantic units may transition to dependency-blocked.
 // Reconciliation must never reset persisted ACCEPTED discovery units.
 for(const u of plan.units)if(u.dependencies.length&&queue.units[u.unitId]?.status==='AVAILABLE')
  queue.units[u.unitId].status='BLOCKED_DEPENDENCY';
 const memberIds=new Set(plan.units.flatMap(u=>u.kind==='BATCH'?u.memberUnitIds:[]));
 const missing=new Set(plan.units.flatMap(x=>x.dependencies).filter(id=>!queue.units[id]&&!memberIds.has(id)));
 if(missing.size)throw Error('unsatisfied planner unit references: '+[...missing].join(', '));
}
function validateRequest(request,directory,phase){
 if(request?.schemaVersion!==REQUEST_SCHEMA||!['CLAIM','SUBMIT','RELEASE','FINALIZE'].includes(request.operation))
  throw Error('unsupported v4 request shape/operation');
 for(const key of ['requestId','workerId'])if(!safe(request[key]))throw Error('unsafe '+key);
 if(request.lane!=='AUTO'&&!safe(request.lane))throw Error('invalid lane');
 const common=['schemaVersion','requestId','operation','campaignId','campaignGenerationId','phaseSequence',
  'lane','workerId','sourceSha256','authorityDigest','phaseEpoch','auditControllerRef'];
 const operationFields={
  CLAIM:['desiredUnitCount'],SUBMIT:['items'],RELEASE:['items'],FINALIZE:[]
 };
 const allowed=new Set([...common,...operationFields[request.operation]]);
 for(const key of Object.keys(request))if(!allowed.has(key))throw Error('unexpected controller/request field: '+key);
 assertParallelSolo(directory,phase,request);
 if(request.operation==='CLAIM'){
  if((!Number.isSafeInteger(request.desiredUnitCount)||
    request.desiredUnitCount<1||request.desiredUnitCount>UNIT_POLICY.issueBatchMax)||request.items!==undefined)
   throw Error('CLAIM must request 1–50 units and omit items');
 }else if(request.operation==='SUBMIT'){
  if(!Array.isArray(request.items)||request.items.length<1||request.items.length>UNIT_POLICY.approvalBatchMax)
   throw Error('SUBMIT must explicitly name 1–5 items');
  if(request.items.some(x=>!isObject(x)))throw Error('SUBMIT items must be objects');
  if(new Set(request.items.map(x=>x.unitId)).size!==request.items.length)throw Error('duplicate SUBMIT unit');
  const required=['unitId','claimEpoch','claimToken','packetSha256','submissionPath',
   'submissionSha256','unitSpecRevision'];
  if(request.items.some(x=>!isObject(x)||Object.keys(x).some(key=>!required.includes(key)&&key!=='workerAttemptPath')||
    required.some(key=>!Object.hasOwn(x,key))||
    !safe(x.unitId)||!Number.isSafeInteger(x.claimEpoch)||x.claimEpoch<1||
    !safe(x.claimToken)||!Number.isSafeInteger(x.unitSpecRevision)||x.unitSpecRevision<1||
    !/^[0-9a-f]{64}$/.test(String(x.packetSha256??''))||
    !/^[0-9a-f]{64}$/.test(String(x.submissionSha256??''))||
    typeof x.submissionPath!=='string'||x.submissionPath.length>1024||
    x.submissionPath.startsWith('/')||x.submissionPath.split('/').includes('..')))
   throw Error('SUBMIT item identity, revision, path or hash is malformed');
 }else if(request.operation==='RELEASE'){
  if(!Array.isArray(request.items)||!request.items.length||
    request.items.some(x=>!isObject(x))||
    new Set(request.items.map(x=>x.unitId)).size!==request.items.length||
    request.items.some(x=>Object.keys(x).length!==3||
      !Object.hasOwn(x,'unitId')||!Object.hasOwn(x,'claimEpoch')||
      !Object.hasOwn(x,'claimToken')||!safe(x.unitId)||
      !Number.isSafeInteger(x.claimEpoch)||x.claimEpoch<1||!safe(x.claimToken)))
   throw Error('RELEASE must list only complete distinct owned tokens');
 }else if(request.operation==='FINALIZE'&&
  (request.workerId!=='lite-solo-controller'||request.lane!=='AUTO'))
  throw Error('only the controller may finalize the current phase with AUTO lane');
}
function available(queue,plan,lane='AUTO'){
 return plan.units.filter(u=>['AVAILABLE','RELEASED'].includes(queue.units[u.unitId]?.status)&&depSatisfied(queue,u)
  &&(lane==='AUTO'||u.unitId.startsWith(lane+'-')));
}
function unlock(queue,plan){
 const newIds=[];
 for(const u of plan.units){
  const state=queue.units[u.unitId];
  if(state.status==='BLOCKED_DEPENDENCY'&&depSatisfied(queue,u)){
   state.status='AVAILABLE';newIds.push(u.unitId);
  }
 }
 queue.newlyEligibleUnitIds=newIds;return newIds;
}
// Recover historical Phase-4 discovery units whose ACCEPTED state was overwritten by
// reconciliation dependency setup. Restore only the original controller-accepted,
// source/authority-bound immutable snapshots; never infer acceptance from a worker draft.
function restoreAcceptedDiscoveryV1({root,queue,plan}){
 if(queue.stage!=='RECONCILIATION'||plan.phaseSequence!==4)return [];
 const restored=[];
 for(const u of plan.units){
  if(!['FLOW','ATTACK'].includes(u.kind))continue;
  const state=queue.units[u.unitId];
  if(!state||state.status==='ACCEPTED'||!['AVAILABLE','BLOCKED_DEPENDENCY'].includes(state.status)||
     !state.acceptedPath||!state.acceptedSha256)continue;
  const accepted=read(root,state.acceptedPath);
  if(accepted.schemaVersion!==UNIT_ARTIFACT_SCHEMAS.accepted||accepted.unitId!==u.unitId||
     accepted.phaseSequence!==4||accepted.phaseEpoch!==queue.phaseEpoch||
     accepted.campaignGenerationId!==queue.campaignGenerationId||
     accepted.sourceSha256!==queue.sourceSha256||accepted.authorityDigest!==queue.authorityDigest||
     accepted.unitSpecRevision!==u.unitSpecRevision||
     accepted.packetSha256!==u.packetSha256||
     accepted.workerId!==state.workerId||accepted.claimEpoch!==state.claimEpoch||
     accepted.submissionSha256!==state.acceptedSha256||
     accepted.submission?.unitId!==u.unitId)
   throw Error('accepted discovery recovery identity mismatch: '+u.unitId);
  state.status='ACCEPTED';restored.push(u.unitId);
 }
 return restored;
}
function noWork(queue,plan){
 if(plan.units.every(u=>queue.units[u.unitId].status==='ACCEPTED'))return 'PHASE_COMPLETE';
 if(plan.units.some(u=>queue.units[u.unitId].status==='REWORK_REQUIRED'))return 'AWAITING_WORKER_SUBMISSION';
 // Pending approval and already-held independent work are actionable distinctions.
 // Dependencies are reported only when no pending approval or in-flight claim exists.
 if(plan.units.some(u=>queue.units[u.unitId].status==='SUBMITTED'))return 'AWAITING_APPROVAL';
 if(plan.units.some(u=>queue.units[u.unitId].status==='CLAIMED'))return 'ALL_WORK_CLAIMED';
 if(plan.units.some(u=>queue.units[u.unitId].status==='BLOCKED_DEPENDENCY'))return 'AWAITING_WORKER_SUBMISSION';
 if(available(queue,plan).length)return 'AWAITING_WORKER_SUBMISSION';
 return 'NO_ELIGIBLE_WORK';
}
function batchIndex(root,campaign,phase,requestId,units){
 const dir=path.posix.join(rootOf(campaign,phase),'claims',requestId);
 const pages=[];
 for(let i=0;i<units.length;i+=4){
  const file='BATCH_PAGE_'+String(pages.length+1).padStart(4,'0')+'_v1.json';
  const rel=path.posix.join(dir,file);
  const page={schemaVersion:'curveyield-lite-solo-unit-batch-page-v1',
   units:units.slice(i,i+4)};put(root,rel,page);
  if(Buffer.byteLength(pretty(page))>32768)throw Error('claim index exceeds 32 KiB');
  pages.push({path:rel,sha256:sha(page)});
 }
 const index={schemaVersion:'curveyield-lite-solo-unit-batch-index-v1',
  count:units.length,pages,readingGuide:'Read claimed packetPath and verify packetSha256. BATCH packets are paged prefill manifests: reconstruct the value from digest-checked prefill-pages, preserve each member recordKeys[0] as entries[].key, and submit one multi-entry snapshot under the batch claim. Rework only outstanding member records; accepted siblings remain immutable. For other units use the original one-record form. Commit source/authority-bound immutable worker/claim-epoch/attempt submissions and enqueue 1–5-unit SUBMIT requests. Claim at most 50; only persisted accepted original records unlock dependents.'};
 const rel=path.posix.join(dir,'BATCH_INDEX_v1.json');put(root,rel,index);
 return rel;
}
// Reclaimed units must refer to the original issued bytes, not a shard that
// has been updated by a prior assembly. New units retain the frozen plan SHA.
function issuedPacketDigestForClaimV1({root,campaign,phase,queue,plan,u,state}){
 if(typeof u.packetSha256==='string')return u.packetSha256;
 const prefix=unitBase(campaign,phase,u.unitId)+'/';
 if(typeof state?.acceptedPath==='string'&&state.acceptedPath.startsWith(prefix)){
  try{
   const prior=read(root,state.acceptedPath);
   if(prior.unitId===u.unitId&&
      prior.campaignGenerationId===plan.campaignGenerationId&&
      prior.sourceSha256===plan.sourceSha256&&
      prior.authorityDigest===plan.authorityDigest&&
      prior.phaseSequence===phase&&prior.phaseEpoch===queue.phaseEpoch&&
      prior.unitSpecRevision===u.unitSpecRevision&&
      prior.submissionSha256===state.acceptedSha256&&
      /^[a-f0-9]{64}$/.test(String(prior.packetSha256??'')))
    return prior.packetSha256;
  }catch{/* The original packet is not available for this claim. */}
 }
 return hex(fs.readFileSync(repoFile(root,u.packetPath??u.shardPath)));
}
function handleClaim({root,campaign,phase,queue,plan,request}){
 const held=Object.values(queue.units).filter(u=>u.workerId===request.workerId&&u.status==='CLAIMED').length;
 const capacity=Math.max(0,UNIT_POLICY.issueBatchMax-held);
 const eligible=available(queue,plan,request.lane),selected=eligible.slice(0,Math.min(capacity,request.desiredUnitCount));
 const units=selected.map(u=>{
  const state=queue.units[u.unitId];state.status='CLAIMED';state.workerId=request.workerId;
  state.claimEpoch++;state.claimToken=randomUUID();
  return {unitId:u.unitId,claimEpoch:state.claimEpoch,claimToken:state.claimToken,
   packetPath:u.packetPath??u.shardPath,packetIndexPath:u.packetIndexPath??null,
   packetSha256:issuedPacketDigestForClaimV1({root,campaign,phase,queue,plan,u,state}),
   unitSpecRevision:u.unitSpecRevision};
 });
 const claimId=units.length?'claim-'+request.requestId:null;
 return {status:units.length?'CLAIMED':capacity===0?'WORKER_CLAIM_LIMIT_REACHED':noWork(queue,plan),
  claimId,claimedUnits:units,
  batchIndexPath:units.length?batchIndex(root,campaign,phase,request.requestId,units):null};
}
function itemIdentity(item,u,state,request,root,campaign,phase){
 if(!u||!state)return 'WAITING_SUBMISSION';
 // An accepted snapshot is immutable even when a later attempt arrives.
 if(state.status==='ACCEPTED')
  return state.acceptedSha256===item.submissionSha256?'UNCHANGED':'STALE';
 if(state.workerId!==request.workerId||
    item.claimEpoch!==state.claimEpoch||item.claimToken!==state.claimToken||
    item.unitSpecRevision!==u.unitSpecRevision||
    !['CLAIMED','SUBMITTED','REWORK_REQUIRED'].includes(state.status))return 'STALE';
 const packetRel=u.packetPath??u.shardPath;
 const livePacketSha256=u.packetSha256??hex(fs.readFileSync(repoFile(root,packetRel)));
 let packetBound=item.packetSha256===livePacketSha256;
 if(!packetBound&&state.acceptedPath&&state.acceptedSha256){
  const previous=maybe(root,state.acceptedPath);
  packetBound=previous?.unitId===u.unitId&&
   previous.campaignGenerationId===request.campaignGenerationId&&
   previous.sourceSha256===request.sourceSha256&&
   previous.authorityDigest===request.authorityDigest&&
   previous.phaseSequence===request.phaseSequence&&
   previous.phaseEpoch===request.phaseEpoch&&
   previous.unitSpecRevision===u.unitSpecRevision&&
   previous.packetSha256===item.packetSha256&&
   previous.submissionSha256===state.acceptedSha256;
 }
 if(!packetBound)return 'STALE';
 const allowed=path.posix.join(unitBase(campaign,phase,u.unitId),
   'submissions',request.workerId,'epoch-'+state.claimEpoch);
 const name=typeof item.submissionPath==='string'&&item.submissionPath.startsWith(allowed+'/')
   ?item.submissionPath.slice(allowed.length+1):'';
 if(!/^(?:controller-compiled\/)?SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(name))
  return 'STALE';
 const file=repoFile(root,item.submissionPath);
 if(!fs.existsSync(file))return 'WAITING_SUBMISSION';
 return hex(fs.readFileSync(file))===item.submissionSha256?null:'STALE';
}
// No security or semantic submission validation is performed by GitHub.
// This function remains only for compatibility with existing callers.
function validateShardUnit(){return [];}
// Exact issued record identities are part of the controller's packaging
// contract. These checks do not judge any security finding or AI conclusion.
function assertSubmissionEnvelopeV1(u,submission){
 if(!submission||typeof submission!=='object'||Array.isArray(submission))
  throw Error('submission is not a JSON object');
 if(u.kind==='FLOW'||u.kind==='ATTACK'){
  const schema=u.kind==='FLOW'?'curveyield-flow-review-submission-v1':
   'curveyield-attack-submission-v1';
  if(submission.schemaVersion!==schema||submission.unitId!==u.unitId)
   throw Error('discovery submission does not match the issued unit');
  return;
 }
 if(submission.schemaVersion!=='curveyield-lite-solo-unit-submission-v1'||
    !Array.isArray(submission.entries))
  throw Error('semantic submission envelope does not match the issued schema');
 const entries=submission.entries;
 if(entries.some(x=>!x||typeof x!=='object'||typeof x.key!=='string'||
    !Object.hasOwn(x,'value'))||
    new Set(entries.map(x=>x.key)).size!==entries.length)
  throw Error('duplicate or malformed issued record identities');
 if(u.kind==='SHARD'){
  if(entries.length!==1||entries[0].key!==u.recordKeys?.[0])
   throw Error('fixed record identity or count differs from issued shard');
 }else if(u.kind==='BATCH'){
  const expected=u.members.map(x=>x.recordKeys?.[0]);
  if(entries.length!==expected.length||
     entries.some(x=>!expected.includes(x.key)))
   throw Error('batch record identity/count differs from issued members');
 }else if(u.kind==='APPEND'){
  if(entries.length>1024)throw Error('APPEND exceeds per-chunk controller capacity');
  const prefix=JSON.stringify(u.path),chunk=u.appendChunkNumber??1;
  for(let i=0;i<entries.length;i++){
   const expected=chunk>1?
    prefix+':APPEND-C'+String(chunk).padStart(4,'0')+'-'+
     String(i+1).padStart(4,'0'):
    prefix+':APPEND-'+String(i+1).padStart(4,'0');
   if(entries[i]?.key!==expected)
    throw Error('APPEND changed its controller-assigned chunk record identity');
  }
  if(submission.appendContinuation!==undefined&&
     typeof submission.appendContinuation!=='boolean')
   throw Error('APPEND continuation request must be explicitly boolean');
  // A full accepted chunk is always independently bounded. The next chunk
  // is another issued unit, never an extension of these accepted bytes.
  const slab={schemaVersion:'curveyield-work-shard-v13',kind:'array',
   path:u.path,startIndex:u.appendOrdinalStart??0,entries};
  if(Buffer.byteLength(pretty(slab))>1024*1024)
   throw Error('APPEND_CHUNK_TRANSPORT_LIMIT: supply a smaller chunk');
 }
}
function acceptBatchRecordsV1({root,campaign,phase,u,submission,queue,plan,state,request,digest}){
 // Retain exactly the records MiMo supplied, in Worker-issued member order.
 // Missing records are never fabricated or pronounced correct by GitHub.
 const entries=Array.isArray(submission?.entries)?submission.entries:[];
 const ordered=u.members.flatMap(member=>entries.filter(entry=>entry?.key===member.recordKeys?.[0]));
 const refs=[];queue.acceptedRecords??={};
 for(const member of u.members){
  const entry=ordered.find(item=>item?.key===member.recordKeys?.[0]);
  if(!entry)continue;
  const rel=path.posix.join(unitBase(campaign,phase,u.unitId),'records',member.unitId,
   'ACCEPTED_ATTEMPT_'+String(state.attempts+1).padStart(3,'0')+'_v1.json');
  const snapshot={schemaVersion:'curveyield-lite-solo-accepted-record-v1',unitId:u.unitId,
   memberUnitId:member.unitId,recordKey:entry.key,campaignGenerationId:plan.campaignGenerationId,
   sourceSha256:plan.sourceSha256,authorityDigest:plan.authorityDigest,phaseSequence:phase,
   phaseEpoch:plan.phaseEpoch,claimEpoch:state.claimEpoch,workerId:request.workerId,
   submissionSha256:digest,prerequisiteEvidence:prerequisiteEvidence(queue,member.dependencies),
   entry,validationDelegatedTo:'CLOUDFLARE_WORKER'};
  put(root,rel,snapshot);
  queue.acceptedRecords[member.unitId]={status:'ACCEPTED',path:rel,
   snapshotSha256:sha(snapshot),parentUnitId:u.unitId};refs.push(rel);
 }
 // The ordered accepted snapshot is authoritative for BATCH member
 // positions. Preserve optional authored question links and translate their
 // original entry ordinal to the accepted member ordinal, retaining the raw
 // selector separately. A missing link remains unresolved, not a veto.
 const links=Array.isArray(submission.questionRecordLinks)?
  submission.questionRecordLinks.map(link=>{
   if(!isObject(link))return clone(link);
   const source=typeof link.acceptedOutputSelector==='string'?
    link.acceptedOutputSelector:link.outputSelector;
   let acceptedOutputSelector=source;
   if(typeof source==='string'&&source.startsWith('entries[')){
    const end=source.indexOf(']');
    const ordinal=Number(source.slice(8,end));
    const member=end>8&&Number.isSafeInteger(ordinal)&&ordinal>=0?
     entries[ordinal]:null;
    const position=member?
     ordered.findIndex(e=>e?.key===member.key):-1;
    if(position>=0&&source.slice(end+1).startsWith('.value'))
     acceptedOutputSelector='entries['+position+']'+source.slice(end+1);
   }else if(typeof link.recordKey==='string'){
    const position=ordered.findIndex(e=>e?.key===link.recordKey);
    if(position>=0)acceptedOutputSelector='entries['+position+'].value';
   }
   return {...clone(link),
    ...(typeof source==='string'?{sourceAuthoredOutputSelector:
     link.sourceAuthoredOutputSelector??source}:{}),
    ...(typeof acceptedOutputSelector==='string'?{acceptedOutputSelector}:{})};
  }):null;
 return {errors:[],assembledSubmission:{
  schemaVersion:UNIT_ARTIFACT_SCHEMAS.submission,entries:ordered,
  ...(links?{questionRecordLinks:links}:{}),
  ...(submission.questionRecordLinks!==undefined&&!links?
   {unmappedQuestionRecordLinks:clone(submission.questionRecordLinks)}:{}),
  ...(submission.unmappedQuestionRecordLinks!==undefined?
   {unmappedQuestionRecordLinks:clone(submission.unmappedQuestionRecordLinks)}:{})
 },recordEvidenceRefs:refs};
}
// Source provenance is optional evidence metadata and never an acceptance gate.
// The original Worker path comes from the GitHub adapter, not from an inferred
// controller-compiled filename.
function originalWorkerAttemptReferenceV1({root,campaign,phase,unitId,request,item,state,digest}){
 const sourcePath=typeof item.workerAttemptPath==='string'?item.workerAttemptPath:
  item.submissionPath.includes('/controller-compiled/')?null:item.submissionPath;
 const prefix=path.posix.join(unitBase(campaign,phase,unitId),
  'submissions',request.workerId,'epoch-'+state.claimEpoch)+'/';
 if(!sourcePath||!sourcePath.startsWith(prefix)||
    !/^SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(sourcePath.slice(prefix.length)))
  return {availability:'NOT_RECORDED'};
 if(sourcePath===item.submissionPath)
  return {availability:'AVAILABLE',path:sourcePath,sha256:digest,
   relation:'DIRECT_WORKER_SUBMISSION'};
 try{
  const originalBytes=fs.readFileSync(repoFile(root,sourcePath));
  return {availability:'AVAILABLE',path:sourcePath,sha256:hex(originalBytes),
   relation:'EXPLICIT_GITHUB_ADAPTER_SOURCE'};
 }catch{
  return {availability:'SOURCE_UNAVAILABLE',path:sourcePath,sha256:null};
 }
}
// Original ATTACK extra records are source evidence even if their flow IDs
// cannot be placed in the issued-flow canonical attackPaths collection.
// Never classify, repair, or drop the Worker-authored records here.
function unmappedAttackPathProvenanceV1({root,campaign,u,originalWorkerAttempt,submission=null}){
 const missing=status=>({status,refs:[],allRefs:[],candidateRefs:[]});
 if(originalWorkerAttempt?.availability!=='AVAILABLE')
  return missing(originalWorkerAttempt?.availability??'ORIGINAL_ATTEMPT_UNAVAILABLE');
 const sourcePath=originalWorkerAttempt.path,sourceSha=originalWorkerAttempt.sha256;
 if(typeof sourcePath!=='string'||
    !sourcePath.startsWith(unitBase(campaign,4,u.unitId)+'/submissions/')||
    !/^[a-f0-9]{64}$/.test(String(sourceSha??'')))
  return missing('ORIGINAL_ATTEMPT_IDENTITY_UNAVAILABLE');
 try{
  const sourceBytes=fs.readFileSync(repoFile(root,sourcePath));
  if(hex(sourceBytes)!==sourceSha)return missing('ORIGINAL_ATTEMPT_HASH_MISMATCH');
  const original=JSON.parse(sourceBytes.toString('utf8'));
  const isBound=original?.schemaVersion==='curveyield-machine-bound-answers-v1';
  const isDirect=original?.schemaVersion==='curveyield-attack-submission-v1';
  if(!isBound&&!isDirect)return missing('UNSUPPORTED_ORIGINAL_ATTACK_REPRESENTATION');
  const extras=original?.extraRecords?.attackPaths;
  if(extras===undefined)return missing('NO_EXTRA_ATTACK_PATHS');
  if(!Array.isArray(extras))return missing('EXTRA_ATTACK_PATHS_UNREADABLE');
  let issuedFlows=null,fixedCount=0;
  try{
   const packet=readUnitPacketV1({root,packetPath:u.packetPath});
   if(packet?.payload?.unitId===u.unitId&&Array.isArray(packet.payload.flowIds)){
    issuedFlows=new Set(packet.payload.flowIds);
    // Fixed attack-path entries are one per originally issued flow position,
    // even if two issued positions contain the same flow ID.
    fixedCount=packet.payload.flowIds.length;
   }
  }catch{/* Missing packet does not block acceptance. */}
  const refs=[],allRefs=[],candidateRefs=[];let mappedCount=0;
  extras.forEach((record,index)=>{
   const ids=record?.flowIds;
   const mappingStatus=!issuedFlows?'ISSUED_FLOWS_UNAVAILABLE':
    !Array.isArray(ids)?'MISSING_FLOW_IDS_ARRAY':
    !ids.length?'NO_EXPLICIT_FLOW_IDS':
    ids.some(id=>!issuedFlows.has(id))?'UNISSUED_FLOW_IDS':
    isDirect?'DIRECT_EXTRA_NOT_IN_CANONICAL_PATHS':null;
   // Only the bound-answer compiler places issued-flow extras in the ordinary
   // attackPaths collection. Raw direct extraRecords stay source evidence.
   const canonicalIndex=!mappingStatus?fixedCount+mappedCount++:null;
   const acceptedSelector=canonicalIndex!==null&&
    Array.isArray(submission?.attackPaths)&&canonicalIndex<submission.attackPaths.length
     ?'submission.attackPaths['+canonicalIndex+']':null;
   const status=mappingStatus??(acceptedSelector?'MAPPED_ISSUED_FLOW':
    'COMPILED_EXTRA_SOURCE_UNAVAILABLE');
   const selector='extraRecords.attackPaths['+index+']';
   const fields=record&&typeof record==='object'&&!Array.isArray(record)?record:{};
   const ref={
    originalIndex:index,mappingStatus:status,sourceSelector:selector,
    acceptedSelector,
    originalFlowIds:ids===undefined?null:structuredClone(ids),
    originalPathId:fields.pathId??null,
    originalAnchorsSelector:Object.hasOwn(fields,'anchors')?selector+'.anchors':null,
    originalCandidateSelector:Object.hasOwn(fields,'candidate')?selector+'.candidate':null,
    originalCandidatesSelector:Object.hasOwn(fields,'candidates')?selector+'.candidates':null,
    originalReasoningSelector:Object.hasOwn(fields,'reasoning')?selector+'.reasoning':null,
    originalWorkerAttempt:{availability:'AVAILABLE',path:sourcePath,sha256:sourceSha}
   };
   allRefs.push(ref);
   if(!acceptedSelector){
    refs.push(ref);
    // Preserve every EXPLICIT original nested candidate as its own independent
    // source-bound lead, even when the parent ATTACK flow is not issued.
    // Neither its content nor its source relationship is a security verdict.
    const addOriginalCandidate=(candidate,candidateSelector,kind,candidateIndex)=>{
     if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return;
     candidateRefs.push({
      sourceSelector:candidateSelector,parentSourceSelector:selector,
      originalPathIndex:index,originalPathId:fields.pathId??null,
      originalFlowIds:ids===undefined?null:structuredClone(ids),
      mappingStatus:status,unitId:u.unitId,
      candidateKind:kind,originalCandidateIndex:candidateIndex,
      originalCandidateValueSha256:hex(JSON.stringify(candidate)),
      originalWorkerAttempt:{availability:'AVAILABLE',path:sourcePath,sha256:sourceSha}
     });
    };
    if(Object.hasOwn(fields,'candidate'))
     addOriginalCandidate(fields.candidate,selector+'.candidate','SINGULAR',null);
    if(Array.isArray(fields.candidates))
     fields.candidates.forEach((candidate,j)=>
      addOriginalCandidate(candidate,selector+'.candidates['+j+']','PLURAL',j));
   }
  });
  return {status:issuedFlows?'COLLECTED_NONBLOCKING':'ISSUED_FLOWS_UNAVAILABLE',
   refs,allRefs,candidateRefs};
 }catch{return missing('ORIGINAL_ATTEMPT_UNREADABLE');}
}
function acceptSubmission({root,campaign,phase,request,item,queue,plan,directory}){
 const u=plan.units.find(x=>x.unitId===item.unitId),state=queue.units[item.unitId];
 if(!u||!state)return {unitId:item.unitId,status:'WAITING_SUBMISSION',errors:[]};
 const file=repoFile(root,item.submissionPath);
 if(!fs.existsSync(file)){state.status='SUBMITTED';return {unitId:item.unitId,status:'WAITING_SUBMISSION',errors:[]};}
 const raw=fs.readFileSync(file),digest=hex(raw);
 if(digest!==item.submissionSha256)return {unitId:item.unitId,status:'STALE'};
 // JSON parsing is transport decoding only; no schema, security or content checks.
 const submission=JSON.parse(raw.toString('utf8'));
 assertSubmissionEnvelopeV1(u,submission);
 let batchOutcome=null;
 if(u.kind==='BATCH')batchOutcome=acceptBatchRecordsV1({
  root,campaign,phase,u,submission,queue,plan,state,request,digest});
 state.status='SUBMITTED';state.lastSubmissionSha256=digest;state.attempts++;
 const resultRel=path.posix.join(unitBase(campaign,phase,u.unitId),'results',
  'ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
 const acceptedRel=path.posix.join(unitBase(campaign,phase,u.unitId),
  'ACCEPTED_ATTEMPT_'+String(state.attempts).padStart(3,'0')+'_v1.json');
 const questionLedger=questionLedgerReferenceV1({root,campaign,phase,unitId:u.unitId,
  directory,phaseEpoch:request.phaseEpoch,packetSha256:item.packetSha256});
 const isDiscovery=u.kind==='FLOW'||u.kind==='ATTACK';
 // Preserve this independently for ALL accepted unit kinds, including
 // SHARD/BATCH/APPEND. A compiled submission is not the original AI attempt.
 const sourceProvenance={
  schemaVersion:isDiscovery?'curveyield-discovery-source-provenance-v1':
   'curveyield-semantic-unit-source-provenance-v1',
  submittedPath:item.submissionPath,submittedSha256:digest,
  submittedRepresentation:item.submissionPath.includes('/controller-compiled/')
   ?'CONTROLLER_COMPILED':'DIRECT_WORKER_SUBMISSION',
  originalWorkerAttempt:originalWorkerAttemptReferenceV1({
   root,campaign,phase,unitId:u.unitId,request,item,state,digest})
 };
 if(u.kind==='ATTACK'){
  const extra=unmappedAttackPathProvenanceV1({
   root,campaign,u,originalWorkerAttempt:sourceProvenance.originalWorkerAttempt,submission});
  sourceProvenance.extraAttackPathRefs=extra.allRefs;
  sourceProvenance.unmappedAttackPathRefs=extra.refs;
  sourceProvenance.unmappedAttackCandidateRefs=extra.candidateRefs;
  sourceProvenance.unmappedAttackPathExtractionStatus=extra.status;
 }
 put(root,acceptedRel,{schemaVersion:'curveyield-lite-solo-accepted-unit-v1',unitId:u.unitId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  authorityDigest:directory.authorityDigest,phaseSequence:phase,phaseEpoch:request.phaseEpoch,
  unitSpecRevision:u.unitSpecRevision,packetSha256:item.packetSha256,
  workerId:request.workerId,claimEpoch:state.claimEpoch,submissionSha256:digest,
  prerequisiteEvidence:prerequisiteEvidence(queue,u.dependencies),
  submission:batchOutcome?.assembledSubmission??submission,
  ...(batchOutcome?.recordEvidenceRefs?{recordEvidenceRefs:batchOutcome.recordEvidenceRefs}:{}),
  ...(sourceProvenance?{sourceProvenance}:{}),
  questionLedger,
  validationDelegatedTo:'CLOUDFLARE_WORKER',githubContentValidationPerformed:false});
 state.status='ACCEPTED';state.acceptedSha256=digest;state.acceptedPath=acceptedRel;state.lastErrors=[];
 if(isDiscovery)state.acceptedArtifactSha256=hex(fs.readFileSync(repoFile(root,acceptedRel)));
 put(root,resultRel,{unitId:u.unitId,status:'ACCEPTED',submissionSha256:digest,
  acceptedPath:acceptedRel,validationDelegatedTo:'CLOUDFLARE_WORKER'});
 return {unitId:u.unitId,status:'ACCEPTED',resultRef:resultRel};
}
function handleSubmit({root,campaign,phase,queue,plan,request,directory}){
 const items=[];
 for(const item of request.items){
  const state=queue.units[item.unitId],u=plan.units.find(x=>x.unitId===item.unitId);
  try{
   const identity=itemIdentity(item,u,state,request,root,campaign,phase);
   if(identity){
    if(identity==='WAITING_SUBMISSION'&&state?.workerId===request.workerId)
     state.status='SUBMITTED';
    items.push({unitId:item.unitId,status:identity});
    continue;
   }
   if(state.status==='CLAIMED')state.status='SUBMITTED';
   items.push(acceptSubmission({root,campaign,phase,request,item,queue,plan,directory}));
  }catch(e){
   const reason=String(e.message??e);
   // A transport failure must retain the original claim, not produce acceptance.
   if(state&&state.workerId===request.workerId&&
      state.claimEpoch===item.claimEpoch&&state.claimToken===item.claimToken){
    state.status='SUBMITTED';state.lastErrors=[reason];
   }
   items.push({unitId:item.unitId,status:'WAITING_SUBMISSION',transportError:reason});
  }
 }
 const newlyEligibleUnits=unlock(queue,plan);
 return {status:'SUBMISSION_RECORDED',acceptedUnits:items.filter(x=>x.status==='ACCEPTED').map(x=>x.unitId),
  reworkUnits:items.filter(x=>x.status==='REWORK_REQUIRED'),
  staleUnits:items.filter(x=>x.status==='STALE'),unchangedUnits:items.filter(x=>x.status==='UNCHANGED'),
  waitingUnits:items.filter(x=>x.status==='WAITING_SUBMISSION'),newlyEligibleUnits};
}
function handleRelease({queue,plan,request}){
 const changed=[];
 for(const item of request.items){
  const s=queue.units[item.unitId];
  if(!s||s.workerId!==request.workerId||s.claimEpoch!==item.claimEpoch||
   s.claimToken!==item.claimToken||s.status==='ACCEPTED')continue;
  // Preserve drafts and the previous epoch while making this unit eligible again.
  // The next claim increments the epoch, invalidating the released owner's token.
  s.status='RELEASED';s.workerId=null;s.claimToken=null;changed.push(item.unitId);
 }
 const unblocked=unlock(queue,plan);
 queue.newlyEligibleUnitIds=[...new Set([...changed,...unblocked])];
 return {status:'RELEASED',releasedUnits:changed,newlyEligibleUnits:queue.newlyEligibleUnitIds};
}
function discoveryInput(root,campaign,name){return read(root,reviewInventoryRelV1(root,campaign,name));}
function finishDiscovery({root,campaign,directory,plan,queue,automationRoot}){
 const items=plan.units.filter(u=>['FLOW','ATTACK'].includes(u.kind));
 if(!items.every(u=>queue.units[u.unitId]?.status==='ACCEPTED'))return false;
 if(queue.stage==='RECONCILIATION')return true;
 const state={schemaVersion:'curveyield-discovery-state-v1',campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  generatedAt:new Date().toISOString(),payload:{reviewPolicy:'correctness-verdict-v13',gaps:asArray(discoveryInput(root,campaign,'FLOW_PLAN_v1.json').payload?.gaps)}};
 const acceptedSubmissions=items.map(u=>{
  const acceptedPath=queue.units[u.unitId].acceptedPath;
  const acceptedBytes=fs.readFileSync(repoFile(root,acceptedPath));
  const accepted=JSON.parse(acceptedBytes.toString('utf8'));
  const reconstructed=u.kind==='ATTACK'?unmappedAttackPathProvenanceV1({
   root,campaign,u,originalWorkerAttempt:accepted.sourceProvenance?.originalWorkerAttempt,
   submission:accepted.submission}):null;
  const extra=u.kind==='ATTACK'?{
   refs:Array.isArray(accepted.sourceProvenance?.unmappedAttackPathRefs)
    ?accepted.sourceProvenance.unmappedAttackPathRefs:reconstructed.refs,
   allRefs:Array.isArray(accepted.sourceProvenance?.extraAttackPathRefs)
    ?accepted.sourceProvenance.extraAttackPathRefs:reconstructed.allRefs,
   status:accepted.sourceProvenance?.unmappedAttackPathExtractionStatus??
    reconstructed.status,
   candidateRefs:Array.isArray(accepted.sourceProvenance?.unmappedAttackCandidateRefs)?
    accepted.sourceProvenance.unmappedAttackCandidateRefs:reconstructed.candidateRefs
  }:null;
  return {unitId:u.unitId,submission:accepted.submission,
   sourceReference:{phaseSequence:4,unitId:u.unitId,acceptedPath,
    acceptedSha256:hex(acceptedBytes),sourceSelectorPrefix:'submission',
    submittedPath:accepted.sourceProvenance?.submittedPath??null,
    submittedSha256:accepted.sourceProvenance?.submittedSha256??
     accepted.submissionSha256??null,
    submittedRepresentation:accepted.sourceProvenance?.submittedRepresentation??
     'HISTORICAL_ACCEPTED_SUBMISSION',
    originalWorkerAttempt:accepted.sourceProvenance?.originalWorkerAttempt??
     {availability:'NOT_RECORDED'},
    ...(extra?{unmappedAttackPathRefs:extra.refs,
     unmappedAttackCandidateRefs:extra.candidateRefs,
     extraAttackPathRefs:extra.allRefs,
     unmappedAttackPathExtractionStatus:extra.status}:{})}};
 });
 const inventory=discoveryInput(root,campaign,'REVIEW_INVENTORY_v1.json');
 const summary=buildDiscoverySummaryV1({state,inventory,plan:discoveryInput(root,campaign,'FLOW_PLAN_v1.json'),
  acceptedSubmissions,taxonomy:loadTaxonomyV1(automationRoot),now:new Date().toISOString()});
 put(root,path.posix.join(campaign,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json'),summary);
 put(root,path.posix.join(campaign,'work/phase-06/BASELINE_OBLIGATIONS_v1.json'),
  deriveBaselineObligationsV1({inventory,taxonomy:loadTaxonomyV1(automationRoot),summary}));
 // The original phase prefill is authoritative; refresh once, after complete discovery.
 const assignment=directory.currentAssignment;
 const form={...read(root,path.posix.join(authorityFor(directory),'phases/phase-4/resources/PHASE_04_WORK_FORM_TEMPLATE_v1.json'))};
 const updated=applyPhaseBoundaryPrefill({root,campaignPath:campaign,authorityRoot:authorityFor(directory),sequence:4,
  form,derivedInputPaths:[...asArray(assignment.derivedInputPaths),path.posix.join(campaign,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json')],
  predecessorReceiptPath:assignment.predecessorReceiptPath});
 // Discovery reconstructs the Phase-4 work form; preserve the original
 // receipt-bound references from every earlier accepted substantive phase.
 attachOriginalCanonicalEvidenceRefsV1({
   root,campaignPath:campaign,directory,sequence:4,form:updated});
 // FLOW and ATTACK histories are available to the reconciliation packets of
 // THIS SAME PHASE, before there is any sealed phase-4 canonical output.
 // Original accepted snapshots and original checkpoint files stay untouched.
 const phaseQuestionHistory=items.map(unit=>recoverAcceptedQuestionLedgerReferenceV1({
  root,campaignPath:campaign,phase:4,unitId:unit.unitId,
  directory,queue,plan}));
 updated.automationInputs.questionHistoryRefs=phaseQuestionHistory;
 // Phase-4 reconciliation begins before Phase 4 has a sealed canonical.
 // Make the original accepted FLOW/ATTACK output rows and question histories
 // retrievable NOW, including explicitly linked and unpromoted answers.
 // This is an index of exact accepted bytes, not an inferred relationship.
 updated.automationInputs.discoveryQuestionOutputSourceRefs=
  acceptedSubmissions.map(source=>({
   phaseSequence:4,unitId:source.unitId,
   acceptedUnitPath:source.sourceReference.acceptedPath,
   acceptedUnitArtifactSha256:source.sourceReference.acceptedSha256,
   acceptedSubmissionSelector:'submission',
   questionHistorySource:phaseQuestionHistory.find(
    ref=>ref.unitId===source.unitId)??null,
   explicitQuestionLinkSelector:
    Array.isArray(source.submission?.questionRecordLinks)?
     'submission.questionRecordLinks':null,
   originalQuestionHistoryStatus:
    phaseQuestionHistory.find(ref=>ref.unitId===source.unitId)?.availability??
     'HISTORY_SOURCE_UNAVAILABLE'
  }));
 updated.automationInputs.controllerOwnedAutomationInputs=[...new Set([
  ...(updated.automationInputs.controllerOwnedAutomationInputs??[]),
  'questionHistoryRefs','discoveryQuestionOutputSourceRefs'])];
 refreshControllerPrefillDigest(updated);
 put(root,assignment.workFormPath,updated);
 const shards=secureShardWorkFormV13({root,formRel:assignment.workFormPath,phase:4,retireFull:true});
 assignment.workShardIndexPath=shards.indexRel;
 assignment.controllerPrefillDigestSha256=updated.automationInputs?.controllerPrefillDigestSha256;
 addShardUnits({root,campaignPath:campaign,directory,phase:4,plan,queue});
 queue.stage='RECONCILIATION';plan.stage='RECONCILIATION';
 unlock(queue,plan);return true;
}
// A source-authored appendContinuation:true on an ACCEPTED bounded unit
// explicitly requests another unit in that same issued APPEND family.
// This only issues work; it does not synthesize an accepted submission.
function issueAcceptedAppendContinuationsV1({root,campaign,phase,plan,queue}){
 const created=[];
 for(const previous of [...plan.units]){
  if(previous.kind!=='APPEND'||queue.units?.[previous.unitId]?.status!=='ACCEPTED')
   continue;
  const accepted=read(root,queue.units[previous.unitId].acceptedPath);
  if(accepted?.submission?.appendContinuation!==true)continue;
  if(!Array.isArray(accepted.submission.entries))continue;
  const chunk=(previous.appendChunkNumber??1)+1;
  if(!Number.isSafeInteger(chunk))
   throw Error('APPEND_CONTINUATION_ORDINAL_EXCEEDS_SAFE_INTEGER: '+previous.unitId);
  const seriesId=previous.appendSeriesUnitId??previous.unitId;
  const unitId=seriesId+'-C'+String(chunk).padStart(4,'0');
  const existing=plan.units.find(unit=>unit.unitId===unitId);
  if(existing){
   if(existing.kind!=='APPEND'||existing.continuationAfterUnitId!==previous.unitId||
      existing.appendChunkNumber!==chunk||existing.appendSeriesUnitId!==seriesId)
    throw Error('APPEND_CONTINUATION_ISSUED_IDENTITY_CONFLICT: '+unitId);
   continue; // Replay is idempotent; never issue a duplicate.
  }
  const primaryStart=Number.isInteger(previous.appendOrdinalStart)?
   previous.appendOrdinalStart:read(root,previous.shardPath).startIndex;
  if(!Number.isSafeInteger(primaryStart)||primaryStart<0)
   throw Error('APPEND_CONTINUATION_ISSUED_START_UNAVAILABLE: '+unitId);
  const nextStart=primaryStart+accepted.submission.entries.length;
  const packetPath=path.posix.join(unitBase(campaign,phase,unitId),
   'ASSIGNMENT_PACKET_v1.json');
  const packet={schemaVersion:'curveyield-work-shard-v13',kind:'array',
   path:previous.path,startIndex:nextStart,entries:[],
   appendChunkNumber:chunk,appendSeriesUnitId:seriesId,
   continuationAfterUnitId:previous.unitId,
   continuationInstructions:'Supply at most 1024 typed APPEND records and at most 1 MiB of serialized shard data. Set appendContinuation:true ONLY when another independent bounded unit is required. Original entries and issued metadata remain immutable.'};
  put(root,packetPath,packet);
  const idKey=dot([...previous.path,'APPEND-C'+String(chunk).padStart(4,'0')]);
  if(plan.recordOwnership[idKey])throw Error('continuation ownership already issued: '+idKey);
  const next={unitId,kind:'APPEND',field:previous.field,
   shardFile:previous.shardFile,shardPath:previous.shardPath,
   packetPath,packetSha256:hex(fs.readFileSync(repoFile(root,packetPath))),
   appendChunkNumber:chunk,appendSeriesUnitId:seriesId,
   continuationAfterUnitId:previous.unitId,
   appendOrdinalStart:nextStart,
   shardIndex:0,recordKeys:[],path:clone(previous.path),
   dependencies:[previous.unitId],unitSpecRevision:1};
  plan.recordOwnership[idKey]=unitId;
  addUnit(plan,queue,next);
  created.push(unitId);
 }
 if(created.length)unlock(queue,plan);
 return created;
}

export function processUnitRequestV1({root,campaignPath,directory,request,automationRoot=process.cwd(),trustedController=false}){
 // A worker-origin GitHub request must never become a controller-origin FINALIZE.
 if(request?.operation==='FINALIZE'&&!trustedController)
  throw Error('FINALIZE is controller-internal and cannot be queued by a worker');
 const phase=request.phaseSequence;validateRequest(request,directory,phase);
 let queue=maybe(root,queueRel(campaignPath,phase));
 if(!queue)queue=createUnitPlanV1({root,campaignPath,directory,phase,automationRoot});
 const plan=readPlan(root,campaignPath,phase);assertPlan(queue,plan);
 const recoveredDiscoveryUnits=restoreAcceptedDiscoveryV1({root,queue,plan});
 const requestDigest=sha(request);
 if(queue.processedRequestHashes?.[request.requestId]&&
    queue.processedRequestHashes[request.requestId]!==requestDigest)
  throw Error('request ID reused with different immutable content');
 if(queue.processedRequests[request.requestId])return queue.processedRequests[request.requestId];
 let result;
 if(request.operation==='CLAIM')result=handleClaim({root,campaign:campaignPath,phase,queue,plan,request});
 else if(request.operation==='SUBMIT')result=handleSubmit({root,campaign:campaignPath,phase,queue,plan,request,directory});
 else if(request.operation==='RELEASE')result=handleRelease({queue,plan,request});
 else {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;result={status:'FINALIZE_REQUESTED'};}
 if(result.acceptedUnits?.length) {queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;}
 if(recoveredDiscoveryUnits.length){
  queue.newlyEligibleUnitIds=queue.newlyEligibleUnitIds.filter(id=>!recoveredDiscoveryUnits.includes(id));
  result.recoveredAcceptedDiscoveryUnits=recoveredDiscoveryUnits;
 }
 if(phase===4&&queue.stage!=='RECONCILIATION'&&
  plan.units.filter(u=>['FLOW','ATTACK'].includes(u.kind)).every(u=>queue.units[u.unitId]?.status==='ACCEPTED'))
  finishDiscovery({root,campaign:campaignPath,directory,plan,queue,automationRoot});
 let continuationIssueError=null,issuedContinuationUnitIds=[];
 try{
  issuedContinuationUnitIds=issueAcceptedAppendContinuationsV1({
   root,campaign:campaignPath,phase,plan,queue});
 }catch(error){
  // Previously accepted snapshots remain accepted. Diagnose the issuance
  // obstacle without misreporting the phase or deleting earlier work.
  continuationIssueError=String(error?.message??error);
 }
 if(issuedContinuationUnitIds.length){
  queue.finalizeStatus='NOT_STARTED';queue.finalizeDetails=null;
 }
 const nextPhaseStatus=continuationIssueError?
  'AWAITING_APPEND_CONTINUATION_ISSUANCE':noWork(queue,plan);
 result={schemaVersion:UNIT_ARTIFACT_SCHEMAS.result,
  requestId:request.requestId,campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
  authorityDigest:directory.authorityDigest,phaseSequence:phase,phaseEpoch:queue.phaseEpoch,
  ...result,
  acceptedUnits:result.acceptedUnits??[],reworkUnits:result.reworkUnits??[],
  staleUnits:result.staleUnits??[],unchangedUnits:result.unchangedUnits??[],
  waitingUnits:result.waitingUnits??[],
  nextPhaseStatus,phaseStatus:nextPhaseStatus,
  ...(issuedContinuationUnitIds.length?{issuedContinuationUnitIds}:{}),
  ...(continuationIssueError?{continuationIssueError}:{}),
  newlyEligibleUnits:[...new Set([...(result.newlyEligibleUnits??[]),
    ...issuedContinuationUnitIds])]};
 queue.revision++;
 queue.processedRequestHashes[request.requestId]=requestDigest;
 if(!asArray(result.waitingUnits).length)queue.processedRequests[request.requestId]=result;
 publishPlan(root,campaignPath,phase,plan,queue);
 directory.unitQueueIndexPath=planRel(campaignPath,phase);
 directory.unitQueueStatePath=queueRel(campaignPath,phase);
 if(directory.currentAssignment?.phaseSequence===phase){
  directory.currentAssignment.unitQueueIndexPath=directory.unitQueueIndexPath;
  directory.currentAssignment.unitQueueStatePath=directory.unitQueueStatePath;
 }
 return result;
}
function durablyAcceptedUnitV1({root,plan,queue,u}){
 const state=queue.units?.[u.unitId];
 if(state?.status!=='ACCEPTED'||!state.acceptedPath||
    !/^[a-f0-9]{64}$/.test(String(state.acceptedSha256??'')))return false;
 const prefix=path.posix.join(plan.campaignPath,'work/phase-'+
  String(plan.phaseSequence).padStart(2,'0'),'units',u.unitId)+'/';
 if(!state.acceptedPath.startsWith(prefix))return false;
 try{
  const snapshot=read(root,state.acceptedPath);
  return snapshot.unitId===u.unitId&&
   snapshot.campaignGenerationId===plan.campaignGenerationId&&
   snapshot.sourceSha256===plan.sourceSha256&&
   snapshot.authorityDigest===plan.authorityDigest&&
   snapshot.phaseSequence===plan.phaseSequence&&
   snapshot.phaseEpoch===plan.phaseEpoch&&
   snapshot.claimEpoch===state.claimEpoch&&
   snapshot.unitSpecRevision===u.unitSpecRevision&&
   snapshot.submissionSha256===state.acceptedSha256&&
   (!u.packetSha256||snapshot.packetSha256===u.packetSha256);
 }catch{return false;}
}
export function finalizeReadinessV1({root,campaignPath,directory,phase}){
 // A prior accepted file is insufficient after a unit is reopened for rework.
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 const pending=plan.units.filter(u=>!durablyAcceptedUnitV1({root,plan,queue,u}));
 if(pending.length)return {ready:false,reason:'AWAITING_DURABLY_ACCEPTED_WORKER_FILES',
  unitIds:pending.map(u=>u.unitId)};
 return {ready:true,plan,queue};
}
// Recover a controller-owned v13 index accidentally re-sharded from a previously
// assembled unit form. The immutable per-record unit plan, not reviewer data,
// fixes the original mandatory identities and APPEND boundary. Do not bypass
// the trusted-index equality checks or manufacture missing substantive records.
function restoreFrozenUnitShardIndexV1({root,campaignPath,phase,assignment,plan}){
 if(![4,5,6].includes(phase))return;
 const workDir=path.posix.dirname(assignment.workShardIndexPath);
 const trustedDir=path.posix.join(campaignPath,'controller/shards/phase-'+String(phase).padStart(2,'0'));
 const trustedRel=path.posix.join(trustedDir,'INDEX_v1.json');
 const working=read(root,assignment.workShardIndexPath),trusted=read(root,trustedRel);
 if(JSON.stringify(working)!==JSON.stringify(trusted))
  throw Error('v13 index authority mismatch before unit-plan recovery');
 const records=plan.units.flatMap(u=>u.kind==='BATCH'?u.members:[u]).filter(u=>
  ['SHARD','APPEND'].includes(u.kind)&&!(u.appendChunkNumber>1));
 let changed=false;
 for(let i=0;i<working.pages.length;i++){
  const desc=working.pages[i],pageRel=path.posix.join(workDir,desc.file);
  const trustedPageRel=path.posix.join(trustedDir,desc.file);
  const page=read(root,pageRel),trustedPage=read(root,trustedPageRel);
  if(JSON.stringify(page)!==JSON.stringify(trustedPage)||sha(page)!==desc.sha256)
   throw Error('v13 index page authority mismatch before unit-plan recovery');
  let pageChanged=false;
  for(const shard of page.shards??[]){
   if(shard.kind!=='array')continue;
   const members=records.filter(u=>u.shardFile===shard.file);
   if(!members.length)continue;
   if(shard.append){
    if(members.length!==1||members[0].kind!=='APPEND'||shard.recordKeys.length)
     throw Error('unexpected append unit-plan identity: '+shard.file);
    const expectedStart=records.filter(u=>u.kind==='SHARD'&&
     JSON.stringify(u.path)===JSON.stringify(shard.path)).length;
    if(shard.startIndex!==expectedStart){
     const slabRel=path.posix.join(workDir,shard.file),slab=read(root,slabRel);
     if(slab.startIndex!==shard.startIndex)throw Error('append shard index mismatch: '+shard.file);
     shard.startIndex=expectedStart;slab.startIndex=expectedStart;put(root,slabRel,slab);
     pageChanged=true;
    }
   }else{
    if(members.some(u=>u.kind!=='SHARD'))throw Error('unexpected fixed unit-plan identity: '+shard.file);
    members.sort((a,b)=>a.shardIndex-b.shardIndex);
    if(members.some((u,j)=>u.shardIndex!==j))
     throw Error('noncontiguous immutable fixed unit-plan ownership: '+shard.file);
    const prefix=JSON.stringify(shard.path)+':';
    const keys=members.map(u=>{
     const key=u.recordKeys?.[0];
     if(typeof key!=='string'||!key.startsWith(prefix))
      throw Error('invalid immutable unit record key: '+shard.file);
     return key.slice(prefix.length);
    });
    const first=Math.min(...members.map(u=>u.recordIndex));
    if(shard.startIndex!==first||JSON.stringify(shard.recordKeys)!==JSON.stringify(keys)){
     shard.startIndex=first;shard.recordKeys=keys;pageChanged=true;
    }
   }
  }
  if(pageChanged){
   put(root,pageRel,page);put(root,trustedPageRel,page);
   working.pages[i].sha256=sha(page);trusted.pages[i].sha256=sha(page);
   changed=true;
  }
 }
 if(changed){
  put(root,assignment.workShardIndexPath,working);put(root,trustedRel,trusted);
 }
}
// Collect accepted continuation page content without creating another
// transport. It is read from the existing immutable accepted unit snapshots.
export function collectAcceptedAppendContinuationsV1({root,campaignPath,phase}){
 if(![4,5,6].includes(Number(phase)))return [];
 if(!maybe(root,planRel(campaignPath,phase))||
    !maybe(root,queueRel(campaignPath,phase)))return [];
 const plan=readPlan(root,campaignPath,phase),queue=read(root,queueRel(campaignPath,phase));
 const pages=[];
 // A continuation request is only fulfilled by a separately issued and
 // accepted successor. Never treat an unfinished accepted chain as complete.
 for(const u of plan.units.filter(unit=>unit.kind==='APPEND')){
  const state=queue.units?.[u.unitId];
  if(state?.status!=='ACCEPTED')continue;
  const snap=read(root,state.acceptedPath);
  if(snap.submission?.appendContinuation!==true)continue;
  const successor=plan.units.find(next=>next.kind==='APPEND'&&
   next.continuationAfterUnitId===u.unitId);
  if(!successor)
   throw Error('APPEND_CONTINUATION_AWAITING_ISSUANCE: '+u.unitId);
 }
 for(const u of plan.units){
  if(u.kind!=='APPEND'||!(u.appendChunkNumber>1))continue;
  const state=queue.units?.[u.unitId];
  if(state?.status!=='ACCEPTED'||!state.acceptedPath)
   throw Error('APPEND_CONTINUATION_AWAITING_ACCEPTED_UNIT: '+u.unitId);
  const snapshot=read(root,state.acceptedPath);
  if(snapshot.unitId!==u.unitId||snapshot.phaseSequence!==phase||
     snapshot.campaignGenerationId!==plan.campaignGenerationId||
     snapshot.sourceSha256!==plan.sourceSha256||
     snapshot.authorityDigest!==plan.authorityDigest||
     snapshot.phaseEpoch!==plan.phaseEpoch||
     snapshot.submissionSha256!==state.acceptedSha256||
     !Array.isArray(snapshot.submission?.entries))
   throw Error('APPEND_CONTINUATION_ACCEPTED_SOURCE_MISMATCH: '+u.unitId);
  pages.push({unitId:u.unitId,path:u.path,
   chunkNumber:u.appendChunkNumber,startIndex:u.appendOrdinalStart,
   continuationAfterUnitId:u.continuationAfterUnitId,
   entries:snapshot.submission.entries});
 }
 return pages.sort((a,b)=>
  JSON.stringify(a.path).localeCompare(JSON.stringify(b.path))||
  a.chunkNumber-b.chunkNumber);
}

export function assembleAcceptedUnitShardsV1({root,campaignPath,directory,phase}){
 // GitHub copies and orders the actual Worker-provided bytes; no additional
 // identity, value, coverage, dependency, or security validation is performed.
 const ready=finalizeReadinessV1({root,campaignPath,directory,phase});
 if(!ready.ready)return {status:'AWAITING_WORKER_FILES',unitIds:ready.unitIds};
 const {plan,queue}=ready,assignment=directory.currentAssignment,byFile=new Map();
 const phaseSchema=loadPhaseSchema(root,authorityFor(directory),phase).schema;
 // Reconstruct issued rows from their immutable member identity, not from an
 // editable raw submission that can rewrite prefilled subject/source fields.
 // This normalizes only controller-owned values; it never judges AI analysis.
 const immutableIssuedValue=(member,entry)=>{
  const issued=member.initialValue;
  if(!issued||typeof issued!=='object'||Array.isArray(issued)||
     !entry?.value||typeof entry.value!=='object'||Array.isArray(entry.value))
   return entry;
  const step=member.path?.[1],field=member.field;
  const action=phaseSchema.actions?.[step]??{};
  const definition=action.fields?.find(spec=>spec.name===field)??{};
  const pinned=new Set([...(definition.controllerPrefillFields??[]),
   ...(action.controllerPrefillFields??[]),
   ...asArray(issued.automationOwnedFields),
   'automationOwnedFields','recordKey','tempKey','candidateKey','obligationId','subjectKey',
   'findingKey','testGroupId','groupKey']);
  const next=clone(entry.value);
  for(const key of pinned){
   if(!Object.hasOwn(issued,key))continue;
   const value=issued[key];
   if(value===undefined||value===null||
      (typeof value==='string'&&(!value.trim()||value.startsWith('<')||value==='TODO')))
    continue;
   next[key]=clone(value);
  }
  return {...entry,value:next};
 };
 for(const u of plan.units.filter(u=>['SHARD','APPEND','BATCH'].includes(u.kind))){
  // Only original issued shards are written back to their indexed working
  // files. Later APPEND chunks are independent accepted source pages.
  if(u.kind==='APPEND'&&u.appendChunkNumber>1)continue;
  const accepted=read(root,queue.units[u.unitId].acceptedPath);
  if(u.kind==='BATCH'){
   const entries=Array.isArray(accepted.submission?.entries)?accepted.submission.entries:[];
   for(const member of u.members){
    const entry=entries.find(e=>e?.key===member.recordKeys?.[0]);
    if(!entry)continue; // Do not invent material that the Worker did not send.
    const group=byFile.get(member.shardPath)??[];
    group.push({unit:member,entries:[immutableIssuedValue(member,entry)]});byFile.set(member.shardPath,group);
   }
  }else{
   const group=byFile.get(u.shardPath)??[];
   const entries=Array.isArray(accepted.submission?.entries)?accepted.submission.entries:[];
   group.push({unit:u,entries:u.kind==='SHARD'?
    entries.map(entry=>immutableIssuedValue(u,entry)):entries});
   byFile.set(u.shardPath,group);
  }
 }
 for(const [rel,group] of byFile){
  const slab=read(root,rel);
  const fixed=group.filter(e=>e.unit.kind==='SHARD').sort((a,b)=>a.unit.shardIndex-b.unit.shardIndex);
  const appended=group.filter(e=>e.unit.kind==='APPEND').sort((a,b)=>a.unit.unitId.localeCompare(b.unit.unitId));
  slab.entries=fixed.length?fixed.flatMap(e=>e.entries):appended.flatMap(e=>e.entries);
  put(root,rel,slab);
 }
 const acceptedContinuations=collectAcceptedAppendContinuationsV1({root,campaignPath,phase});
 materializeSemanticWorkFormV13({root,formRel:assignment.workFormPath,
  acceptedContinuations});
 return {status:'READY_FOR_EXISTING_BOUNDARY_SEAL',workShardIndexPath:assignment.workShardIndexPath,
  validationDelegatedTo:'CLOUDFLARE_WORKER'};
}
// Provenance-only projection of exact accepted SHARD/BATCH/APPEND work.
// Keep it inside the existing canonical artifact (not a new standalone
// database or workflow). Original Worker source status is never a quality gate.
export function collectAcceptedUnitRecordOriginsV1({root,campaignPath,directory,phase}){
 const roster={schemaVersion:'curveyield-accepted-unit-record-origins-v1',
  phaseSequence:phase,campaignId:directory.campaignId,
  campaignGenerationId:directory.campaignGenerationId,
  sourceSha256:directory.sourceSha256,records:[],unavailable:[]};
 if(![4,5,6].includes(phase))return {...roster,availability:'NOT_APPLICABLE'};
 let plan,queue;
 try{
  plan=readPlan(root,campaignPath,phase);
  queue=read(root,queueRel(campaignPath,phase));
 }catch(e)return {...roster,availability:'PLAN_OR_QUEUE_UNAVAILABLE',
  diagnostics:[String(e?.message??e)]};
 if(queue.campaignId!==directory.campaignId||
    queue.campaignGenerationId!==directory.campaignGenerationId||
    queue.phaseSequence!==phase||queue.sourceSha256!==directory.sourceSha256||
    queue.authorityDigest!==plan.authorityDigest||queue.phaseEpoch!==plan.phaseEpoch)
  return {...roster,availability:'ISSUED_IDENTITY_MISMATCH'};
 const units=plan.units.filter(u=>['SHARD','BATCH','APPEND'].includes(u.kind));
 // The same frozen descriptor fixes the canonical append start position during
 // materializeSemanticWorkFormV13. Mutable submitted slab metadata is not the
 // source of truth for the record-to-canonical index relationship.
 const issuedDescriptors=new Map();
 try{
  const trustedDir=path.posix.join(campaignPath,'controller/shards/phase-'+
   String(phase).padStart(2,'0'));
  const index=read(root,path.posix.join(trustedDir,'INDEX_v1.json'));
  for(const pageRef of asArray(index.pages)){
   const page=read(root,path.posix.join(trustedDir,pageRef.file));
   for(const desc of asArray(page.shards))
    issuedDescriptors.set(desc.file,desc);
  }
 }catch{ /* Record exact source identity even if issuance metadata is lost. */ }
 for(const u of units){
  const state=queue.units?.[u.unitId];
  if(state?.status!=='ACCEPTED'||!state.acceptedPath){
   roster.unavailable.push({unitId:u.unitId,status:'NOT_ACCEPTED'});continue;
  }
  let snapshot,acceptedDigest;
  try{
   const raw=fs.readFileSync(repoFile(root,state.acceptedPath));
   acceptedDigest=hex(raw);snapshot=JSON.parse(raw.toString('utf8'));
   if(snapshot.unitId!==u.unitId||snapshot.phaseSequence!==phase||
      snapshot.campaignGenerationId!==directory.campaignGenerationId||
      snapshot.sourceSha256!==directory.sourceSha256||
      snapshot.submissionSha256!==state.acceptedSha256)
    throw Error('accepted unit identity mismatch');
  }catch(e){
   roster.unavailable.push({unitId:u.unitId,status:'ACCEPTED_SNAPSHOT_UNAVAILABLE',
    diagnostic:String(e?.message??e)});continue;
  }
  let original=null,sourceAvailability='NOT_RECORDED';
  const originalRef=snapshot.sourceProvenance?.originalWorkerAttempt;
  if(originalRef?.availability==='AVAILABLE'&&typeof originalRef.path==='string'&&
     /^[a-f0-9]{64}$/.test(String(originalRef.sha256??''))){
   try{
    const raw=fs.readFileSync(repoFile(root,originalRef.path));
    if(hex(raw)!==originalRef.sha256)throw Error('original worker attempt digest mismatch');
    original=JSON.parse(raw.toString('utf8'));sourceAvailability='AVAILABLE';
   }catch(e){sourceAvailability='ORIGINAL_WORKER_SOURCE_UNAVAILABLE';}
  }else sourceAvailability=originalRef?.availability??'NOT_RECORDED';
  const entries=Array.isArray(snapshot.submission?.entries)?snapshot.submission.entries:[];
  const isBound=original?.schemaVersion==='curveyield-machine-bound-answers-v1';
  const originalAnswerSelectors=key=>{
   if(!isBound||!Array.isArray(original.answers))return [];
   const selectors=[];
   for(let i=0;i<original.answers.length;i++){
    let tokens;
    try{tokens=JSON.parse(original.answers[i]?.bindingId??'');}catch{continue;}
    if(Array.isArray(tokens)&&tokens[0]==='entries'&&tokens[1]===key)
     selectors.push('answers['+i+']');
   }
   return selectors;
  };
  const acceptedReference=(member,entry,entryIndex,recordOrdinal,canonicalIndex)=>{
   const collection=member.path?.join('.')??null;
   const sourceSelector='submission.entries['+entryIndex+'].value';
   const originalSelector=sourceAvailability==='AVAILABLE'?
    (isBound?(u.kind==='APPEND'?'appendRecords['+recordOrdinal+']':null):
     original?.schemaVersion==='curveyield-lite-solo-unit-submission-v1'?
      'entries['+entryIndex+'].value':null):null;
   roster.records.push({
    unitId:u.unitId,memberUnitId:member.unitId,
    unitKind:u.kind,field:member.field,collection,
    ...(u.kind==='APPEND'?{
     appendChunkNumber:u.appendChunkNumber??1,
     continuationAfterUnitId:u.continuationAfterUnitId??null,
     appendSeriesUnitId:u.appendSeriesUnitId??u.unitId
    }:{}),
    originalRecordOrdinal:recordOrdinal,canonicalRecordIndex:canonicalIndex,
    canonicalRecordSelector:collection!==null&&Number.isInteger(canonicalIndex)?
     collection+'['+canonicalIndex+']':null,
    recordKey:entry.key,
    acceptedPath:state.acceptedPath,acceptedArtifactSha256:acceptedDigest,
    acceptedSubmissionPath:snapshot.sourceProvenance?.submittedPath??null,
    acceptedSubmissionSha256:snapshot.submissionSha256,
    acceptedSourceSelector:sourceSelector,
    originalWorkerAttempt:{availability:sourceAvailability,
     // Retain recorded expected locations/digests even when content has gone
     // missing; availability is separate from original source identity.
     path:originalRef?.path??null,sha256:originalRef?.sha256??null,
     sourceSelector:originalSelector,
     ...(isBound&&u.kind!=='APPEND'?
      {answerSelectors:originalAnswerSelectors(entry.key)}:{})},
    // Controller-owned binding metadata is authoritative only when compiled
    // by this adapter; a raw submitted entry may contain arbitrary extra keys.
    ...(snapshot.sourceProvenance?.submittedRepresentation==='CONTROLLER_COMPILED'&&
       entry.sourceAuthoredIdentities?
     {sourceAuthoredIdentities:structuredClone(entry.sourceAuthoredIdentities)}:{}),
    ...(snapshot.sourceProvenance?.submittedRepresentation==='CONTROLLER_COMPILED'&&
       entry.controllerSubjectBindings?
     {controllerSubjectBindings:structuredClone(entry.controllerSubjectBindings)}:{})
   });
  };
  if(u.kind==='BATCH'){
   for(const member of u.members){
    const index=entries.findIndex(x=>x?.key===member.recordKeys?.[0]);
    if(index<0){
     roster.unavailable.push({unitId:u.unitId,memberUnitId:member.unitId,
      status:'ISSUED_BATCH_MEMBER_MISSING'});continue;
    }
    acceptedReference(member,entries[index],index,member.shardIndex,
     member.recordIndex);
   }
  }else if(u.kind==='SHARD'){
   const index=entries.findIndex(x=>x?.key===u.recordKeys?.[0]);
   if(index<0){
    roster.unavailable.push({unitId:u.unitId,status:'ISSUED_SHARD_RECORD_MISSING'});
    continue;
   }
   acceptedReference(u,entries[index],index,u.shardIndex,u.recordIndex);
  }else{
   const desc=issuedDescriptors.get(u.shardFile);
   const start=u.appendChunkNumber>1?
    (Number.isSafeInteger(u.appendOrdinalStart)?u.appendOrdinalStart:null):
    desc?.append===true&&Number.isSafeInteger(desc.startIndex)&&
     desc.startIndex>=0?desc.startIndex:null;
   for(const [index,entry] of entries.entries()){
    acceptedReference(u,entry,index,index,
     start===null?null:start+index);
   }
   if(start===null)roster.unavailable.push({unitId:u.unitId,
    status:'APPEND_CANONICAL_POSITION_UNAVAILABLE'});
  }
 }
 roster.availability='COLLECTED_NONBLOCKING';
 roster.acceptedOriginCount=roster.records.length;
 return roster;
}

// Explicit means the AI supplied the reference in a reference-typed field
// or in the optional questionRecordLinks envelope. Ordinary prose and titles
// are deliberately never parsed for associations.
const QUESTION_REFERENCE_FIELDS_V1=new Set([
 'explicitQuestionRefs','questionRefs','questionEvidenceRefs',
 'sourceQuestionRefs','relatedQuestionRefs','investigationQuestionRefs',
 'originatingEvidenceRefs','evidenceRefs','sourceRefs','proofEvidenceRefs',
 'discoveryEvidenceRefs','anchors'
]);
const QUESTION_ID_V1=/^Q-[0-9]{6,}$/;
function typedQuestionReferenceV1(value,{phase,unitId}){
 // A literal checkpoint record selector is already an exact source
 // reference. Resolve it only against VERIFIED index/checkpoint metadata.
 const checkpointPointer=(checkpointPath,selector)=>{
  if(typeof checkpointPath!=='string'||
     !checkpointPath.includes('/questions/checkpoints/')||
     typeof selector!=='string')return null;
  let ordinal=null;
  const recordSelector=selector.endsWith('.answerText')?
   selector.slice(0,-'.answerText'.length):
   selector.endsWith('.questionText')?
    selector.slice(0,-'.questionText'.length):selector;
  if(recordSelector.startsWith('records[')&&recordSelector.endsWith(']')){
   const number=recordSelector.slice(8,-1);
   if(/^[0-9]+$/.test(number))ordinal=Number(number);
  }else if(recordSelector.startsWith('/records/')){
   const number=recordSelector.slice(9);
   if(/^[0-9]+$/.test(number))ordinal=Number(number);
  }
  if(!Number.isSafeInteger(ordinal)||ordinal<0)return null;
  return {checkpointPath,checkpointRecordSelector:'records['+ordinal+']',
   sourceReferenceKind:'EXACT_CHECKPOINT_RECORD_POINTER'};
 };
 const indexPointer=(indexPath,selector)=>{
  if(typeof indexPath!=='string'||
     !indexPath.endsWith('/questions/QUESTION_INDEX_v1.json')||
     typeof selector!=='string')return null;
  let ordinal=null;
  const questionSelector=selector.endsWith('.questionText')?
   selector.slice(0,-'.questionText'.length):selector;
  if(questionSelector.startsWith('questions[')&&questionSelector.endsWith(']')){
   const value=questionSelector.slice(10,-1);
   if(/^[0-9]+$/.test(value))ordinal=Number(value);
  }else if(questionSelector.startsWith('/questions/')){
   const value=questionSelector.slice(11);
   if(/^[0-9]+$/.test(value))ordinal=Number(value);
  }
  if(!Number.isSafeInteger(ordinal)||ordinal<0)return null;
  return {questionIndexPath:indexPath,questionIndexSelector:'questions['+
   ordinal+']',sourceReferenceKind:'EXACT_QUESTION_INDEX_POINTER'};
 };
 if(typeof value==='string'){
  const ref=value.trim();
  const hash=ref.indexOf('#');
  if(hash>0){
   const source=checkpointPointer(ref.slice(0,hash),ref.slice(hash+1))??
    indexPointer(ref.slice(0,hash),ref.slice(hash+1));
   if(source)return source;
  }
  if(QUESTION_ID_V1.test(ref)&&unitId)
   return {phaseSequence:phase,unitId,questionId:ref,
    sourceReferenceKind:'LOCAL_ISSUED_UNIT_REFERENCE'};
  const composite=ref.match(/^(?:phase[-_ ]?)?(\d+)\/([A-Za-z0-9._-]+)\/(Q-[0-9]{6,})(?:@(?:rev(?:ision)?[-_ ]?)?(\d+))?$/i);
  if(composite)return {phaseSequence:Number(composite[1]),
   unitId:composite[2],questionId:composite[3],
   ...(composite[4]?{checkpointRevision:Number(composite[4])}:{}),
   sourceReferenceKind:'EXPLICIT_COMPOSITE_REFERENCE'};
  return null;
 }
 if(isObject(value)&&value.checkpointPath&&value.checkpointRecordSelector){
  const source=checkpointPointer(value.checkpointPath,value.checkpointRecordSelector);
  if(source)return source;
 }
 if(isObject(value)&&value.questionIndexPath&&value.questionIndexSelector){
  const source=indexPointer(value.questionIndexPath,value.questionIndexSelector);
  if(source)return source;
 }
 if(!isObject(value)||!QUESTION_ID_V1.test(String(value.questionId??'')))
  return null;
 const sourcePhase=value.phaseSequence===undefined?phase:Number(value.phaseSequence);
 const sourceUnit=value.unitId??unitId;
 if(!Number.isSafeInteger(sourcePhase)||sourcePhase<1||
    typeof sourceUnit!=='string'||!safe(sourceUnit))
  return null;
 const revision=value.checkpointRevision===undefined?
  null:Number(value.checkpointRevision);
 return {phaseSequence:sourcePhase,unitId:sourceUnit,
  questionId:value.questionId,
  ...(revision!==null&&Number.isSafeInteger(revision)&&revision>=1?
   {checkpointRevision:revision}:{}),
  sourceReferenceKind:'EXPLICIT_STRUCTURED_REFERENCE'};
}
function explicitQuestionRefsInRecordV1(value,{phase,unitId,selector}){
 const refs=[],stack=[{value,selector}];
 while(stack.length){
  const current=stack.pop(),item=current.value;
  if(!item||typeof item!=='object')continue;
  if(Array.isArray(item)){
   for(let i=item.length-1;i>=0;i--)
    if(item[i]&&typeof item[i]==='object')
     stack.push({value:item[i],selector:current.selector+'['+i+']'});
   continue;
  }
  for(const [key,child] of Object.entries(item)){
   const fieldSelector=current.selector+'.'+key;
   if(QUESTION_REFERENCE_FIELDS_V1.has(key)){
    const list=Array.isArray(child)?child:[child];
    for(const [i,ref] of list.entries()){
     const authored=typedQuestionReferenceV1(ref,{phase,unitId});
     const sourceSelector=fieldSelector+
      (Array.isArray(child)?'['+i+']':'');
     if(authored)refs.push({authored,sourceSelector,
      originalExplicitReference:structuredClone(ref)});
     else if(typeof ref==='string'&&(
       /^Q-[0-9]+$/.test(ref.trim())||
       /\/Q-[0-9]+/.test(ref)||
       ref.includes('/questions/checkpoints/')||
       ref.includes('/questions/QUESTION_INDEX_v1.json')||
       key.toLowerCase().includes('question'))||
       isObject(ref)&&Object.hasOwn(ref,'questionId'))
      refs.push({authored:null,sourceSelector,
       originalExplicitReference:structuredClone(ref),
       unavailable:'QUESTION_REFERENCE_IDENTITY_INCOMPLETE'});
    }
   }
   if(child&&typeof child==='object')
    stack.push({value:child,selector:fieldSelector});
  }
 }
 return refs.sort((a,b)=>a.sourceSelector.localeCompare(b.sourceSelector));
}
// Build a many-to-many provenance projection over ACTUAL accepted output
// sources. The original questions and answers remain in their immutable
// index/checkpoint files; this index never substitutes a security verdict.
export function collectExplicitQuestionOutputLinksV1({
 root,campaignPath,directory,phase,canonical,questionSources=null
}){
 const histories=questionSources??collectAcceptedQuestionAnswerSourcesV1({
  root,campaignPath,directory,phase});
 const output={schemaVersion:'curveyield-explicit-question-output-links-v1',
  phaseSequence:phase,associationOrigin:'AI_EXPLICIT_REFERENCE',
  associations:[],nonCanonicalEvidenceAssociations:[],unresolvedReferences:[],
  unpromotedQuestions:[],
  // Original direct field ownership is clerical, not an AI security link.
  originalDirectQuestionFieldOwners:histories.questions.filter(q=>
   q.sourceKind==='DIRECT_FIXED_ORIGINAL').map(q=>({
    phaseSequence:q.phaseSequence,unitId:q.unitId,questionId:q.questionId,
    originalDirectFieldPath:q.originalDirectFieldPath,
    originalAcceptedShardPath:q.originalAcceptedShardPath,
    originalAcceptedShardSha256:q.originalAcceptedShardSha256,
    sourceAcceptance:q.sourceAcceptance,
    originalAnswerVersionCount:q.answerVersions?.length??0,
    associationMeaning:'ISSUED_FIELD_OWNERSHIP_NOT_AI_EXPLICIT_FINDING_LINK'
   })),
  sourceAvailability:histories.availability,
  questionSourcesSelector:'automationOutputs.questionAnswerSources',
  sourceMeaning:'NO_SECURITY_INFERENCE'};
 const questionByIdentity=new Map(histories.questions.map((q,i)=>[
  JSON.stringify([q.phaseSequence,q.unitId,q.questionId]),{q,index:i}]));
 const questionByCheckpoint=new Map(),questionByIndex=new Map();
 for(const [i,question] of histories.questions.entries()){
  const indexKey=JSON.stringify([question.questionIndexPath,
   question.questionTextSource?.selector?.replace(/\.questionText$/,'')]);
  const indexEntries=questionByIndex.get(indexKey)??[];
  indexEntries.push({q:question,index:i});
  questionByIndex.set(indexKey,indexEntries);
  for(const version of question.checkpointEvents??[]){
   const key=JSON.stringify([version.checkpointPath,
    version.checkpointRecordSelector]);
   const candidates=questionByCheckpoint.get(key)??[];
   candidates.push({q:question,index:i,version});
   questionByCheckpoint.set(key,candidates);
  }
 }
 const linked=new Set();
 const appendLink=({ref,record,selector,ownerPhase,ownerUnit,outputOrigin,
  nonCanonical=false})=>{
  if(!ref)return;
  let question=ref.authored;
  if(question?.sourceReferenceKind==='EXACT_CHECKPOINT_RECORD_POINTER'){
   const candidates=questionByCheckpoint.get(JSON.stringify([
    question.checkpointPath,question.checkpointRecordSelector]))??[];
   if(candidates.length===1){
    const match=candidates[0];
    question={phaseSequence:match.q.phaseSequence,unitId:match.q.unitId,
     questionId:match.q.questionId,
     checkpointRevision:match.version.checkpointRevision,
     sourceReferenceKind:'EXACT_CHECKPOINT_RECORD_POINTER'};
   }else question=null;
  }else if(question?.sourceReferenceKind==='EXACT_QUESTION_INDEX_POINTER'){
   const candidates=questionByIndex.get(JSON.stringify([
    question.questionIndexPath,question.questionIndexSelector]))??[];
   if(candidates.length===1){
    const match=candidates[0];
    question={phaseSequence:match.q.phaseSequence,unitId:match.q.unitId,
     questionId:match.q.questionId,
     sourceReferenceKind:'EXACT_QUESTION_INDEX_POINTER'};
   }else question=null;
  }
  if(!question){
   output.unresolvedReferences.push({outputRecordSelector:selector,
    originalOutputSource:outputOrigin,
    originalQuestionReferenceSelector:ref.sourceSelector,
    originalExplicitReference:ref.originalExplicitReference,
    status:ref.unavailable??'QUESTION_REFERENCE_IDENTITY_INCOMPLETE'});
   return;
  }
  const identity=JSON.stringify([question.phaseSequence,question.unitId,question.questionId]);
  const accepted=questionByIdentity.get(identity);
  const revision=question.checkpointRevision??null;
  const version=revision===null?null:accepted?.q.answerVersions.find(
   event=>event.checkpointRevision===revision);
  const questionEvent=revision===null?null:accepted?.q.checkpointEvents.find(
   event=>event.checkpointRevision===revision);
  const association={
   outputRecord:{phaseSequence:phase,selector,
    recordKey:record?.recordKey??null,
    originalAcceptedRecordSource:outputOrigin??null},
   explicitQuestionReference:{
    phaseSequence:question.phaseSequence,unitId:question.unitId,
    questionId:question.questionId,
    ...(revision!==null?{checkpointRevision:revision}:{})},
   originalExplicitReference:ref.originalExplicitReference,
   originalQuestionReferenceSelector:ref.sourceSelector,
   associationOrigin:'AI_EXPLICIT_REFERENCE',
   ...(accepted?{
    questionSourceSelector:'automationOutputs.questionAnswerSources.questions['+
     accepted.index+']',
    originalQuestionTextSource:accepted.q.questionTextSource,
    originalQuestionIndexPath:accepted.q.questionIndexPath,
    originalQuestionIndexSha256:accepted.q.questionIndexSha256,
    acceptedQuestionUnitPath:accepted.q.acceptedUnitPath,
    acceptedQuestionUnitArtifactSha256:accepted.q.acceptedUnitArtifactSha256,
    answerVersionCount:accepted.q.answerVersions.length,
    ...(questionEvent?{exactQuestionEventSource:questionEvent}:{}),
    ...(version?{exactAnswerVersionSource:version}:{})
   }:{})
  };
  if(!accepted||
     revision!==null&&!questionEvent){
   output.unresolvedReferences.push({...association,
    status:!accepted?'ORIGINAL_QUESTION_SOURCE_UNAVAILABLE':
     'REFERENCED_CHECKPOINT_REVISION_UNAVAILABLE'});
   return;
  }
  if(nonCanonical)output.nonCanonicalEvidenceAssociations.push({
    ...association,outputRecord:{
     ...association.outputRecord,formalCanonicalOutput:false}
   });
  else{
   linked.add(identity);output.associations.push(association);
  }
 };
 const register=({value,selector,ownerPhase=phase,ownerUnit=null,
  recordKey=null,origin=null,extraRefs=[],nonCanonical=false})=>{
  const record={recordKey};
  for(const ref of [
   ...explicitQuestionRefsInRecordV1(value,{
    phase:ownerPhase,unitId:ownerUnit,selector}),
   ...extraRefs
  ])appendLink({ref,record,selector,ownerPhase,ownerUnit,
   outputOrigin:origin,nonCanonical});
 };
 // The canonical row index and accepted record-source roster were assembled
 // mechanically before this collector. Do not use prose/title matching.
 const sources=[
  ...(canonical.automationOutputs?.acceptedUnitRecordOrigins?.records??[]),
  ...(canonical.automationOutputs?.directPhaseRecordOrigins?.records??[])
 ];
 const sourceBySelector=new Map();
 for(const source of sources){
  if(!source?.canonicalRecordSelector)continue;
  const key=source.canonicalRecordSelector;
  const refs=sourceBySelector.get(key)??[];
  refs.push(source);sourceBySelector.set(key,refs);
 }
 const saved=new Map(),originalLinkRows=new Map(),consumedLinkRows=new Set();
 // Optional explicitly AI-supplied metadata remains on the accepted unit
 // snapshot. It is not rewritten into fixed issued output objects.
 if([4,5,6].includes(Number(phase))){
  let plan,queue;
  try{plan=readPlan(root,campaignPath,phase);
   queue=read(root,queueRel(campaignPath,phase));}
  catch{plan=null;queue=null;}
  for(const u of plan?.units??[]){
   const state=queue?.units?.[u.unitId];
   if(state?.status!=='ACCEPTED'||!state.acceptedPath)continue;
   let accepted;
   try{
    const raw=fs.readFileSync(repoFile(root,state.acceptedPath));
    accepted=JSON.parse(raw.toString('utf8'));
    if(accepted?.unitId!==u.unitId||
       accepted?.campaignGenerationId!==directory.campaignGenerationId||
       accepted?.sourceSha256!==directory.sourceSha256||
       accepted?.submissionSha256!==state.acceptedSha256)
     throw Error('accepted unit source identity mismatch');
   }catch(error){
    output.unresolvedReferences.push({unitId:u.unitId,
     status:'ACCEPTED_UNIT_SOURCE_UNREADABLE',
     diagnostic:String(error?.message??error)});continue;
   }
   saved.set(u.unitId,{accepted,path:state.acceptedPath});
   const links=accepted.submission?.questionRecordLinks;
   if(Array.isArray(links))
    originalLinkRows.set(u.unitId,links);
   else if(links!==undefined)
    output.unresolvedReferences.push({unitId:u.unitId,
     originalOutputSource:state.acceptedPath,
     originalExplicitReference:structuredClone(links),
     status:'NON_ARRAY_AI_QUESTION_LINK_METADATA'});
   if(accepted.submission?.unmappedQuestionRecordLinks!==undefined)
    output.unresolvedReferences.push({unitId:u.unitId,
     originalOutputSource:state.acceptedPath,
     originalExplicitReference:structuredClone(
      accepted.submission.unmappedQuestionRecordLinks),
     status:'UNMAPPED_AI_QUESTION_LINK_METADATA'});
   if(u.kind==='ATTACK'&&
      Array.isArray(accepted.sourceProvenance?.unmappedAttackPathRefs)&&
      accepted.sourceProvenance.unmappedAttackPathRefs.length){
    // Unissued-flow ATTACK evidence can be absent from the compiled
    // attackPaths array. Keep its authored question relationships on the
    // ORIGINAL, hash-verified Worker source, without promoting it into a
    // canonical finding or falsely assigning an issued flow.
    const originalRef=accepted.sourceProvenance.originalWorkerAttempt;
    let original=null,sourceDiagnostic=null;
    try{
     if(originalRef?.availability!=='AVAILABLE'||
        typeof originalRef.path!=='string'||!originalRef.path.startsWith(
         unitBase(campaignPath,phase,u.unitId)+'/submissions/')||
        !/^[a-f0-9]{64}$/.test(String(originalRef.sha256??'')))
      throw Error('original unissued-flow ATTACK source unavailable');
     const raw=fs.readFileSync(repoFile(root,originalRef.path));
     if(hex(raw)!==originalRef.sha256)
      throw Error('original unissued-flow ATTACK source digest mismatch');
     original=JSON.parse(raw.toString('utf8'));
    }catch(error){sourceDiagnostic=String(error?.message??error);}
    for(const unmapped of accepted.sourceProvenance.unmappedAttackPathRefs){
     const selector=unmapped?.sourceSelector;
     const match=typeof selector==='string'?
      selector.match(/^extraRecords\.attackPaths\[([0-9]+)\]$/):null;
     if(!match)continue; // Other original ATTACK rows are handled below.
     const sourceRow=original?.extraRecords?.attackPaths?.[Number(match[1])];
     if(!sourceRow||typeof sourceRow!=='object'||Array.isArray(sourceRow)){
      output.unresolvedReferences.push({
       unitId:u.unitId,originalQuestionReferenceSelector:selector,
       originalOutputSource:originalRef??null,
       status:'UNMAPPED_ATTACK_EVIDENCE_NOT_RETRIEVABLE',
       diagnostic:sourceDiagnostic});continue;
     }
     const refs=[];
     for(const [k,link] of (originalLinkRows.get(u.unitId)??[]).entries()){
      if(link?.outputSelector!==selector&&
         link?.acceptedOutputSelector!==selector)continue;
      if(!Array.isArray(link.questionRefs))continue;
      consumedLinkRows.add(JSON.stringify([u.unitId,k]));
      for(const [j,ref] of link.questionRefs.entries())
       refs.push({authored:typedQuestionReferenceV1(ref,{phase,unitId:u.unitId}),
        originalExplicitReference:structuredClone(ref),
        sourceSelector:'submission.questionRecordLinks['+k+'].questionRefs['+j+']'});
     }
     register({value:sourceRow,
      selector:'originalWorkerAttempt.'+selector,
      ownerUnit:u.unitId,recordKey:sourceRow.pathId??null,
      nonCanonical:true,
      origin:{acceptedPath:state.acceptedPath,
       acceptedSubmissionSha256:accepted.submissionSha256,
       originalWorkerAttempt:{
        path:originalRef.path,sha256:originalRef.sha256,
        sourceSelector:selector},
       mappingStatus:unmapped.mappingStatus??'UNMAPPED_ATTACK_PATH'},
      extraRefs:refs});
    }
   }
   if(!['FLOW','ATTACK'].includes(u.kind))continue;
   for(const [collection,rows] of Object.entries(accepted.submission??{})){
    if(!Array.isArray(rows)||!['rows','flowNotes','integrationAnswers',
     'contractChecks','attackPaths','trivialReviews','groupChecks','candidates']
      .includes(collection))continue;
    for(const [i,row] of rows.entries()){
     const selector='submission.'+collection+'['+i+']';
     const extra=(originalLinkRows.get(u.unitId)??[])
      .flatMap((link,k)=>{
       if(link?.acceptedOutputSelector!==collection+'['+i+']'&&
          link?.outputSelector!==collection+'['+i+']')return [];
       if(!Array.isArray(link.questionRefs))return [];
       consumedLinkRows.add(JSON.stringify([u.unitId,k]));
       return link.questionRefs
        .map((ref,j)=>({authored:typedQuestionReferenceV1(ref,{
         phase,unitId:u.unitId}),originalExplicitReference:structuredClone(ref),
         sourceSelector:'submission.questionRecordLinks['+k+'].questionRefs['+j+']'}));
      });
     register({value:row,selector,ownerUnit:u.unitId,
      origin:{acceptedPath:state.acceptedPath,
       acceptedSubmissionSha256:accepted.submissionSha256,
       unitId:u.unitId,unitKind:u.kind,
       acceptedRecordSourceSelector:selector},extraRefs:extra});
    }
   }
  }
 }
 for(const [step,action] of Object.entries(canonical.actions??{})){
  for(const [field,rows] of Object.entries(action?.outputs??{})){
   if(!Array.isArray(rows))continue;
   for(const [i,row] of rows.entries()){
    const selector='actions.'+step+'.outputs.'+field+'['+i+']';
    const sources=sourceBySelector.get(selector)??[];
    const original=sources.length===1?sources[0]:null;
    const ownerUnit=original?.unitId??null;
    const additional=[];
    const links=originalLinkRows.get(ownerUnit)??[];
    for(const [k,link] of links.entries()){
     const matches=link?.acceptedOutputSelector===original?.acceptedSourceSelector?.replace(/^submission\./,'')||
      link?.recordKey===original?.recordKey||
      link?.outputSelector===original?.acceptedSourceSelector?.replace(/^submission\./,'');
     if(!matches||!Array.isArray(link.questionRefs))continue;
     consumedLinkRows.add(JSON.stringify([ownerUnit,k]));
     for(const [j,ref] of link.questionRefs.entries())
      additional.push({authored:typedQuestionReferenceV1(ref,{phase,unitId:ownerUnit}),
       originalExplicitReference:structuredClone(ref),
       sourceSelector:'submission.questionRecordLinks['+k+'].questionRefs['+j+']'});
    }
    register({value:row,selector,ownerUnit,recordKey:original?.recordKey??null,
     origin:original??(sources.length?{availability:'DUPLICATE_ORIGINAL_SOURCE'}:
      {availability:'SOURCE_RECORD_ORIGIN_NOT_RECORDED'}),
     extraRefs:additional});
   }
  }
 }
 for(const [unitId,links] of originalLinkRows){
  for(const [i,link] of links.entries()){
   if(consumedLinkRows.has(JSON.stringify([unitId,i])))continue;
   output.unresolvedReferences.push({
    unitId,originalQuestionReferenceSelector:
     'submission.questionRecordLinks['+i+']',
    originalOutputSource:saved.get(unitId)?.path??null,
    originalExplicitReference:structuredClone(link),
    status:'AI_EXPLICIT_OUTPUT_SELECTOR_NOT_FOUND'
   });
  }
 }
 for(const [i,q] of histories.questions.entries()){
  const identity=JSON.stringify([q.phaseSequence,q.unitId,q.questionId]);
  if(linked.has(identity))continue;
  output.unpromotedQuestions.push({
   phaseSequence:q.phaseSequence,unitId:q.unitId,questionId:q.questionId,
   questionSourceSelector:'automationOutputs.questionAnswerSources.questions['+i+']',
   questionTextSource:q.questionTextSource,
   answerVersionCount:q.answerVersions.length,
   statusFromCurrentIndex:q.statusFromCurrentIndex,
   disposition:'NO_EXPLICIT_OUTPUT_LINK_RECORDED_IN_CURRENT_CANONICAL'
  });
 }
 output.associationCount=output.associations.length;
 output.nonCanonicalEvidenceAssociationCount=
  output.nonCanonicalEvidenceAssociations.length;
 output.unpromotedQuestionCount=output.unpromotedQuestions.length;
 output.originalDirectQuestionFieldOwnerCount=output.originalDirectQuestionFieldOwners.length;
 output.availability='COLLECTED_NONBLOCKING';
 return output;
}

export function markFinalizationV1({root,campaignPath,phase,status,details=null}){
 const queue=read(root,queueRel(campaignPath,phase));
 queue.finalizeStatus=status;queue.finalizeDetails=details;
 queue.revision++;put(root,queueRel(campaignPath,phase),queue);
}
export function statusUnitQueueV1({root,campaignPath,phase}){
 const plan=maybe(root,planRel(campaignPath,phase))?readPlan(root,campaignPath,phase):null,queue=maybe(root,queueRel(campaignPath,phase));
 if(!plan||!queue)return null;
 const counts={},workers=new Set();
 for(const [id,s] of Object.entries(queue.units)){counts[s.status]=(counts[s.status]??0)+1;if(s.workerId)workers.add(s.workerId);}
 return {phase,counts,workers:[...workers].sort(),approvalBacklog:Object.values(queue.units).filter(x=>x.status==='SUBMITTED').length,
  eligible:available(queue,plan).map(x=>x.unitId),revision:queue.revision,finalizeStatus:queue.finalizeStatus};
}

// Compatibility surface only. Aggregate audit-quality outcomes are Worker-owned.
// Never invalidate an accepted record, reset a claim, or freeze a GitHub queue.
export function reopenAggregateDefectsV1({deficiencies=[]}={}){
  return {reopenedUnits:[],unmappedDeficiencies:Array.isArray(deficiencies)
    ?deficiencies.map(item=>typeof item==='string'?item:JSON.stringify(item))
    :[],invalidatedRecordIds:[],validationDelegatedTo:'CLOUDFLARE_WORKER'};
}

