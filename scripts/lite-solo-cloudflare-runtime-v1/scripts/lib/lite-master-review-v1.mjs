import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildMasterDepthSpotCheckV1,validateMasterDepthSpotCheckV1} from './lite-master-depth-spotcheck-v1.mjs';
import {readJson,writeJson,repoFile,requiredFile,loadPhaseSchema,getByPath,authorityRootFromReceipt} from './lite-phase-work-v1.mjs';
import {validatePhaseScaffold} from './lite-phase-prefill-v1.mjs';
import {isV13AuthorityV1,boundReviewerLineupV13,boundReviewerForPhaseV1} from './lite-authority-lineup-v1.mjs';
export {isV13AuthorityV1,boundReviewerLineupV13,boundReviewerForPhaseV1} from './lite-authority-lineup-v1.mjs';
import {validateRecordedPhase5MachineEvidenceV1,inspectPhase5OwnerEvidenceDeferralV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';

export const MASTER_REVIEW_SEGMENTS_V1=Object.freeze([
  Object.freeze({segmentId:'reviewer-1-phase-01',reviewerId:'reviewer-1',phases:Object.freeze([1]),boundaryPhase:1}),
  Object.freeze({segmentId:'reviewer-2-phases-02-05',reviewerId:'reviewer-2',phases:Object.freeze([2,3,4,5]),boundaryPhase:5}),
  Object.freeze({segmentId:'reviewer-3l-phases-06-07',reviewerId:'reviewer-3L',phases:Object.freeze([6,7]),boundaryPhase:7}),
  Object.freeze({segmentId:'reviewer-4-phases-08-10',reviewerId:'reviewer-4',phases:Object.freeze([8,9,10]),boundaryPhase:10}),
  Object.freeze({segmentId:'reviewer-4-followup-v1',reviewerId:'reviewer-4',phases:Object.freeze([8,9,10]),boundaryPhase:10})
]);

const SHA256=/^[0-9a-f]{64}$/;
const CHAT_URL=/^https:\/\/chatgpt\.com\/(?:c\/[A-Za-z0-9_-]+|g\/g-p-[A-Za-z0-9_-]+\/c\/[A-Za-z0-9_-]+)\/?$/;

function digestBytes(bytes){return createHash('sha256').update(bytes).digest('hex');}
function digestFile(file){return digestBytes(fs.readFileSync(file));}
function digestJson(value){return digestBytes(JSON.stringify(value));}
function phaseNumber(value){return String(value).padStart(2,'0');}
function relativeToCampaign(campaignPath,rel){return path.posix.relative(campaignPath,rel);}
function existing(root,rel){const file=repoFile(root,rel);return fs.existsSync(file)&&fs.statSync(file).isFile()?file:null;}
function artifact(root,campaignPath,phase,kind,rel,extra={}){
  const file=requiredFile(root,rel,kind.toLowerCase().replaceAll('_',' '));
  return {phase,kind,path:relativeToCampaign(campaignPath,rel),sha256:digestFile(file),...extra};
}
function receiptCandidates(root,campaignPath,phase){
  const dir=repoFile(root,path.posix.join(campaignPath,'receipts'));
  if(!fs.existsSync(dir))return[];
  const rx=new RegExp('^PHASE_'+phaseNumber(phase)+'_RECEIPT_v([0-9]+)\\.json$');
  return fs.readdirSync(dir).map(name=>({name,match:name.match(rx)})).filter(x=>x.match).map(x=>({
    revision:Number(x.match[1]),rel:path.posix.join(campaignPath,'receipts',x.name)
  })).sort((a,b)=>b.revision-a.revision);
}
function latestReceipt(root,campaignPath,phase,{allowTerminalComplete=false}={}){
  const found=receiptCandidates(root,campaignPath,phase)[0];
  if(!found)throw new Error('master review segment is missing sealed Phase '+phase+' receipt');
  const receipt=readJson(requiredFile(root,found.rel,'Phase '+phase+' receipt'));
  const status=String(receipt?.phase?.status??'');
  // Phase 10 emits COMPLETE during a final master-amendment replay. Treat it
  // as terminal only in the COMPLETE campaign, with a passing final receipt.
  const terminalComplete=phase===10&&allowTerminalComplete&&status==='COMPLETE'
    &&receipt?.validation?.status==='PASS'&&receipt?.handoff?.nextPhaseSequence===null;
  if(!['SEALED','SKIPPED'].includes(status)&&!terminalComplete)
    throw new Error('master review requires sealed/skipped Phase '+phase+' receipt (or validated terminal Phase 10 COMPLETE)');
  return {...found,receipt};
}
function canonicalRel(campaignPath,phase){return path.posix.join(campaignPath,'derived/phase-'+phase,'PHASE_'+phaseNumber(phase)+'_CANONICAL_DATA_v1.json');}
export const MASTER_REVIEW_SEGMENTS_V13=Object.freeze([
  Object.freeze({segmentId:'reviewer-1-phases-01-03',reviewerId:'reviewer-1',phases:Object.freeze([1,2,3]),boundaryPhase:3}),
  Object.freeze({segmentId:'reviewer-2-phase-04',reviewerId:'reviewer-2',phases:Object.freeze([4]),boundaryPhase:4}),
  Object.freeze({segmentId:'reviewer-3-phases-05-06',reviewerId:'reviewer-3',phases:Object.freeze([5,6]),boundaryPhase:6}),
  Object.freeze({segmentId:'reviewer-4-phases-08-10',reviewerId:'reviewer-4',phases:Object.freeze([8,9,10]),boundaryPhase:10})
]);
const MASTER_REVIEW_SEGMENTS_V13_LEGACY=Object.freeze([
  Object.freeze({segmentId:'reviewer-1-phase-01',reviewerId:'reviewer-1',phases:Object.freeze([1]),boundaryPhase:1}),
  Object.freeze({segmentId:'reviewer-2-phases-02-04',reviewerId:'reviewer-2',phases:Object.freeze([2,3,4]),boundaryPhase:4}),
  Object.freeze({segmentId:'reviewer-3-phases-05-07',reviewerId:'reviewer-3',phases:Object.freeze([5,6,7]),boundaryPhase:7}),
  Object.freeze({segmentId:'reviewer-4-phases-08-10',reviewerId:'reviewer-4',phases:Object.freeze([8,9,10]),boundaryPhase:10})
]);
const FOLLOWUP_SEGMENT_V1=Object.freeze({segmentId:'reviewer-4-followup-v1',reviewerId:'reviewer-4',phases:Object.freeze([8,9,10]),boundaryPhase:10});
export const segmentsForAuthorityV1=(authorityRoot,root=null)=>isV13AuthorityV1(authorityRoot)
 ?(root?boundReviewerLineupV13({root,authorityRoot}).masterSegments:MASTER_REVIEW_SEGMENTS_V13)
 :MASTER_REVIEW_SEGMENTS_V1;
function segmentForBoundary(boundaryPhase,authorityRoot=null,root=null){
 return segmentsForAuthorityV1(authorityRoot,root).find(x=>x.boundaryPhase===Number(boundaryPhase))??null;
}
function segmentForId(segmentId,authorityRoot=null,root=null){
 if(segmentId===FOLLOWUP_SEGMENT_V1.segmentId)return FOLLOWUP_SEGMENT_V1;
 return [...(root&&authorityRoot?segmentsForAuthorityV1(authorityRoot,root):[]),...MASTER_REVIEW_SEGMENTS_V13,...MASTER_REVIEW_SEGMENTS_V13_LEGACY,...MASTER_REVIEW_SEGMENTS_V1].find(x=>x.segmentId===segmentId)??null;
}

export function validateMasterReviewConfiguration(directory,{required=false}={}){
  const cfg=directory?.masterReview;
  if(!cfg){
    if(required)throw new Error('v11 campaign requires masterReview configuration');
    return null;
  }
  if(!CHAT_URL.test(String(cfg.chatUrl??'')))throw new Error('masterReview.chatUrl must be a durable ChatGPT conversation URL');
  if(cfg.reasoning!=='MAXIMUM')throw new Error('masterReview.reasoning must be MAXIMUM');
  if(cfg.repairModel!=='SOL')throw new Error('masterReview.repairModel must be SOL');
  if(cfg.repairReasoning!=='HIGH')throw new Error('masterReview.repairReasoning must be HIGH');
  return cfg;
}

export function masterReviewRequired(directory,authorityRoot){
  const rev=Number((String(authorityRoot??'').match(/Audit_Litemode_v(\d+)(?:\.\d+)?(?:_v\d+_\d+)?(?:\/|$)/)||[])[1]??0);
  const isV11OrLater=rev>=11;
  if(isV11OrLater)return Boolean(validateMasterReviewConfiguration(directory,{required:true}));
  return Boolean(directory?.masterReview&&validateMasterReviewConfiguration(directory));
}

function referencedArtifact({root,campaignPath,phase,kind,reference,requireDigest=true}){
  const raw=reference?.path;
  if(typeof raw!=='string'||!raw)throw new Error('sealed receipt reference path is required for Phase '+phase+' '+kind);
  const suppliedDigest=reference.sha256;
  if(requireDigest&&suppliedDigest!==undefined&&suppliedDigest!==null&&suppliedDigest!==''&&!SHA256.test(String(suppliedDigest)))throw new Error('sealed receipt reference has invalid sha256: '+raw);
  const rel=existing(root,raw)?raw:path.posix.join(campaignPath,raw);
  const row=artifact(root,campaignPath,phase,kind,rel);
  if(requireDigest&&SHA256.test(String(suppliedDigest??''))&&suppliedDigest!==row.sha256)throw new Error('sealed receipt reference digest mismatch: '+raw);
  return row;
}
function pushUniqueArtifact(rows,seen,row){
  if(!row)return;
  const key=row.phase+'|'+row.path;
  if(seen.has(key))return;
  seen.add(key);rows.push(row);
}
export function collectSegmentArtifacts({root,campaignPath,segment,directory,expectedAuthority}){
  if(!directory||!expectedAuthority)throw new Error('segment collection requires exact campaign and authority bindings');
  const artifacts=[];const seen=new Set();
  for(const phase of segment.phases){
    const receiptInfo=latestReceipt(root,campaignPath,phase,{allowTerminalComplete:segment.boundaryPhase===10&&directory.campaignStatus==='COMPLETE'});
    const receipt=receiptInfo.receipt;
    if(receipt.campaign?.campaignId!==directory.campaignId||receipt.campaign?.campaignGenerationId!==directory.campaignGenerationId)throw new Error('sealed receipt campaign binding mismatch for Phase '+phase);
    if(receipt.source?.sha256!==directory.sourceSha256)throw new Error('sealed receipt source binding mismatch for Phase '+phase);
    if(Number(receipt.phase?.sequence)!==phase||Number(receipt.phase?.revision)!==receiptInfo.revision)throw new Error('sealed receipt phase/revision binding mismatch for Phase '+phase);
    if(receipt.authority?.homepagePath!==expectedAuthority.homepagePath||receipt.authority?.liteSkillSha256!==expectedAuthority.liteSkillSha256)throw new Error('sealed receipt authority binding mismatch for Phase '+phase);
    const receiptKind=receipt.phase.status==='SKIPPED'?'SKIP_MARKER':'SEALED_RECEIPT';
    if(!Array.isArray(receipt.inputs)||receipt.inputs.length===0)throw new Error('sealed receipt inputs are missing for Phase '+phase);
    if(receiptKind!=='SKIP_MARKER'&&(!Array.isArray(receipt.evidence)||receipt.evidence.length===0||!Array.isArray(receipt.outputs)||receipt.outputs.length===0))throw new Error('sealed receipt evidence/outputs are missing for Phase '+phase);
    if(phase===7){
      const canonical=canonicalRel(campaignPath,phase);
      const canonicalData=readJson(requiredFile(root,canonical,'Phase-7 marker canonical data'));
      pushUniqueArtifact(artifacts,seen,artifact(root,campaignPath,phase,'MACHINE_MARKER',canonical));
      if(canonicalData.workFormPath)pushUniqueArtifact(artifacts,seen,artifact(root,campaignPath,phase,'WORK_FORM',canonicalData.workFormPath));
    }else if(receiptKind!=='SKIP_MARKER'){
      const canonical=canonicalRel(campaignPath,phase);
      const canonicalData=readJson(requiredFile(root,canonical,'Phase '+phase+' canonical data'));
      const authorityRoot=authorityRootFromReceipt({authority:expectedAuthority});
      const phaseSchema=loadPhaseSchema(root,authorityRoot,phase).schema;
      if(phaseSchema.finalReport&&!canonicalData.finalReportPath)throw new Error('required Phase '+phase+' report path is missing from canonical data');
      pushUniqueArtifact(artifacts,seen,artifact(root,campaignPath,phase,'CANONICAL_DATA',canonical));
      pushUniqueArtifact(artifacts,seen,artifact(root,campaignPath,phase,'WORK_FORM',canonicalData.workFormPath));
      if(canonicalData.finalReportPath)pushUniqueArtifact(artifacts,seen,artifact(root,campaignPath,phase,'PHASE_REPORT',canonicalData.finalReportPath));
    }
    for(const [family,refs] of [['INPUT',receipt.inputs],['EVIDENCE',receipt.evidence],['OUTPUT',receipt.outputs]]){
      for(const ref of refs??[]){
        const role=String(ref?.role??family).replace(/[^A-Za-z0-9_-]+/g,'_').toUpperCase();
        pushUniqueArtifact(artifacts,seen,referencedArtifact({root,campaignPath,phase,kind:family+'_'+role,reference:ref}));
      }
    }
    for(const [name,value] of Object.entries(receipt.globalControls??{})){
      if(typeof value!=='string'||!value)continue;
      pushUniqueArtifact(artifacts,seen,referencedArtifact({root,campaignPath,phase,kind:'GLOBAL_CONTROL_'+name.replace(/[^A-Za-z0-9_-]+/g,'_').toUpperCase(),reference:{path:value},requireDigest:false}));
    }
    pushUniqueArtifact(artifacts,seen,artifact(root,campaignPath,phase,receiptKind,receiptInfo.rel,{receiptRevision:receiptInfo.revision}));
  }
  return artifacts;
}

function bindingRecord({root,campaignPath,directory,predecessor,authorityRoot,reviewedArtifacts}){
  const buildRel=path.posix.join(campaignPath,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json');
  const buildFile=requiredFile(root,buildRel,'build/source identity');
  const sourceRel=predecessor?.source?.archivePath??predecessor?.source?.uploadedPath??null;
  const sourceSha=directory.sourceSha256;
  if(!SHA256.test(String(sourceSha??'')))throw new Error('campaign sourceSha256 is invalid');
  const authoritySha=predecessor?.authority?.liteSkillSha256;
  if(!SHA256.test(String(authoritySha??'')))throw new Error('sealed receipt authority digest is missing');
  return {
    source:{path:sourceRel,sha256:sourceSha},
    build:{path:relativeToCampaign(campaignPath,buildRel),sha256:digestFile(buildFile)},
    authority:{
      root:authorityRoot,
      homepagePath:predecessor.authority.homepagePath,
      sha256:authoritySha,
      release:predecessor.authority.liteRelease??null,
      packageRevision:predecessor.authority.packageRevision??null
    },
    segmentManifestSha256:digestJson(reviewedArtifacts)
  };
}

export const MASTER_OUTCOMES_V1=Object.freeze(['AMENDED','ACCEPT_WITHOUT_MODIFICATIONS','REQUEST_TARGETED_TESTS','CLOSE_INCOMPLETE']);
export const SUPERSEDED_DIRECTORY_V1='superseded';

function gitBlobSha1(bytes){return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');}

function sealedOriginalSnapshotPath(campaignPath,segmentId,sealed){
  if(!segmentForId(segmentId)||!Number.isInteger(Number(sealed.phase))||!/^[A-Za-z0-9._-]+$/.test(path.posix.basename(String(sealed.path??''))))throw new Error('invalid master sealed-original snapshot binding');
  return path.posix.join(campaignPath,'work/master-review',segmentId,'sealed-originals','phase-'+phaseNumber(sealed.phase),path.posix.basename(sealed.path));
}

export function stageMasterReview({root,campaignPath,directory,predecessor,authorityRoot,boundaryPhase,segmentId=null,lastSealedReceiptPath,nextSequence,nextDerivedInputPaths=[],successorPrefillContext={},now}){
  const cfg=validateMasterReviewConfiguration(directory,{required:true});
  if(directory.pendingMasterReview)throw new Error('campaign already has pendingMasterReview');
  const segment=segmentId?segmentForId(segmentId,authorityRoot,root):segmentForBoundary(boundaryPhase,authorityRoot,root);
  if(segment&&segment.boundaryPhase!==boundaryPhase)throw new Error('master segment boundary mismatches requested phase');
  if(!segment)throw new Error('unsupported master review boundary '+boundaryPhase);
  const reviewedArtifacts=collectSegmentArtifacts({root,campaignPath,segment,directory,expectedAuthority:predecessor.authority});
  const bindings=bindingRecord({root,campaignPath,directory,predecessor,authorityRoot,reviewedArtifacts});
  // Preserve the exact sealed reviewer originals in this campaign, not only in Git
  // history (which a partial clone may not contain). Never overwrite a snapshot.
  const sealedWorkForms=reviewedArtifacts.filter(x=>x.kind==='WORK_FORM').map(x=>{
    const bytes=fs.readFileSync(repoFile(root,path.posix.join(campaignPath,x.path)));
    if(digestBytes(bytes)!==x.sha256)throw new Error('sealed form changed while staging master review: '+x.path);
    const sealedOriginalPath=sealedOriginalSnapshotPath(campaignPath,segment.segmentId,x);
    const snapshot=repoFile(root,sealedOriginalPath);
    if(fs.existsSync(snapshot)){
      if(!fs.statSync(snapshot).isFile()||!fs.readFileSync(snapshot).equals(bytes))throw new Error('sealed master snapshot already exists with different content: '+sealedOriginalPath);
    }else{
      fs.mkdirSync(path.dirname(snapshot),{recursive:true});
      fs.writeFileSync(snapshot,bytes,{flag:'wx'});
    }
    return {phase:x.phase,path:x.path,sha256:x.sha256,gitBlobSha1:gitBlobSha1(bytes),sealedOriginalPath};
  });
  const depthSpotCheck=(isV13AuthorityV1(authorityRoot)&&boundaryPhase===4)
    ?buildMasterDepthSpotCheckV1({root,campaignPath,campaignId:directory.campaignId,
      sourceSha256:directory.sourceSha256,segmentId:segment.segmentId})
    :null;
  const recordRel=path.posix.join(campaignPath,'work/master-review',segment.segmentId,'MASTER_REVIEW_RECORD_v1.json');
  const record={
    schemaVersion:'curveyield-lite-master-review-record-v1',
    campaignId:directory.campaignId,
    campaignGenerationId:directory.campaignGenerationId,
    segmentId:segment.segmentId,
    reviewerId:segment.reviewerId,
    boundaryPhase:segment.boundaryPhase,
    segmentPhases:[...segment.phases],
    masterIdentity:{chatUrl:cfg.chatUrl,reasoning:'MAXIMUM'},
    bindings,
    reviewedArtifacts,
    ...(depthSpotCheck?{depthSpotCheck}:{}),
    decision:null,
    createdAt:now,
    updatedAt:now
  };
  writeJson(repoFile(root,recordRel),record);
  const pending={
    schemaVersion:'curveyield-lite-master-review-pending-v2',
    segmentId:segment.segmentId,
    reviewerId:segment.reviewerId,
    boundaryPhase:segment.boundaryPhase,
    segmentPhases:[...segment.phases],
    status:'WAITING_FOR_MASTER_REVIEW',
    recordPath:recordRel,
    masterChatUrl:cfg.chatUrl,
    manifestSha256:bindings.segmentManifestSha256,
    bindingsSha256:digestJson(bindings),
    ...(depthSpotCheck?{depthSpotCheckAssignmentSha256:depthSpotCheck.assignmentSha256}:{}),
    sealedWorkForms,
    lastSealedReceiptPath,
    successorPlan:{
      nextPhaseSequence:nextSequence,
      derivedInputPaths:[...nextDerivedInputPaths],
      prefillContext:successorPrefillContext
    },
    createdAt:now,
    updatedAt:now
  };
  directory.pendingMasterReview=pending;
  directory.currentAssignment=null;
  directory.campaignStatus='WAITING_FOR_MASTER_REVIEW';
  directory.updatedAt=now;
  return {segment,pending,record};
}

// Compare semantic JSON objects independent of serialization/key order. Raw byte digests
// remain authoritative for identifying which sealed artifacts changed.
function canonicalJson(value){
  if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function exactJson(a,b){return canonicalJson(a)===canonicalJson(b);}
function validateLockedRecord(record,pending,directory,cfg){
  const failures=[];
  if(record.schemaVersion!=='curveyield-lite-master-review-record-v1')failures.push('master review record schemaVersion mismatch');
  for(const [key,expected] of Object.entries({
    campaignId:directory.campaignId,
    campaignGenerationId:directory.campaignGenerationId,
    segmentId:pending.segmentId,
    reviewerId:pending.reviewerId,
    boundaryPhase:pending.boundaryPhase
  }))if(!exactJson(record[key],expected))failures.push('master review record '+key+' mismatch');
  if(!exactJson(record.segmentPhases,pending.segmentPhases))failures.push('master review record segmentPhases mismatch');
  if(record.masterIdentity?.chatUrl!==cfg.chatUrl||record.masterIdentity?.reasoning!=='MAXIMUM')failures.push('master identity/configuration mismatch');
  if(record.bindings?.segmentManifestSha256!==pending.manifestSha256)failures.push('master manifest digest mismatch');
  if(record.bindings?.source?.sha256!==directory.sourceSha256)failures.push('master source binding does not match current campaign directory');
  if(digestJson(record.bindings)!==pending.bindingsSha256)failures.push('master source/build/authority bindings were modified');
  if(digestJson(record.reviewedArtifacts)!==pending.manifestSha256)failures.push('master reviewedArtifacts were modified');
  if(pending.depthSpotCheckAssignmentSha256&&
    record.depthSpotCheck?.assignmentSha256!==pending.depthSpotCheckAssignmentSha256)
    failures.push('master depth sample assignment was modified');
  return failures;
}
function currentArtifactFailures(root,campaignPath,rows){
  const failures=[];
  for(const row of rows??[]){
    const rel=path.posix.join(campaignPath,row.path);
    const file=existing(root,rel);
    if(!file)failures.push('reviewed artifact missing: '+row.path);
    else if(digestFile(file)!==row.sha256)failures.push('reviewed artifact digest changed: '+row.path);
  }
  return failures;
}
function currentBindingFailures(root,campaignPath,record,directory,authorityRoot){
  const failures=[];
  const bindings=record.bindings??{};
  const build=bindings.build;
  if(!build||typeof build.path!=='string'||!SHA256.test(String(build.sha256??'')))failures.push('build binding is incomplete');
  else{
    const rel=path.posix.join(campaignPath,build.path);
    const file=existing(root,rel);
    if(!file)failures.push('bound build identity is missing: '+build.path);
    else if(digestFile(file)!==build.sha256)failures.push('bound build identity digest changed: '+build.path);
  }
  const authority=bindings.authority;
  if(!authority||typeof authority.homepagePath!=='string'||!SHA256.test(String(authority.sha256??'')))failures.push('authority binding is incomplete');
  else{
    try{
      const boundHome=authorityRoot?path.posix.join(authorityRoot,'SKILL.md'):authority.homepagePath;
      const file=requiredFile(root,boundHome,'bound master-review authority');
      if(digestFile(file)!==authority.sha256)failures.push('bound authority digest changed: '+authority.homepagePath);
    }catch(error){failures.push(String(error.message||error));}
  }
  const source=bindings.source;
  if(!source||!SHA256.test(String(source.sha256??'')))failures.push('source binding is incomplete');
  else if(source.sha256!==directory.sourceSha256)failures.push('source binding does not match current campaign directory');
  else if(typeof source.path==='string'&&source.path&&!/^https?:\/\//.test(source.path)){
    const candidates=[source.path,path.posix.join(campaignPath,source.path)];
    const rel=candidates.find(x=>existing(root,x));
    if(!rel)failures.push('bound source artifact is missing: '+source.path);
    else if(digestFile(existing(root,rel))!==source.sha256)failures.push('bound source artifact digest changed: '+source.path);
  }
  return failures;
}

export function readSealedOriginal(root,sealed,{campaignPath,segmentId}={}){
  if(!/^[0-9a-f]{40}$/.test(String(sealed.gitBlobSha1??''))||!SHA256.test(String(sealed.sha256??'')))throw new Error('sealed work form has invalid Git/SHA256 identity: '+sealed.path);
  if(!campaignPath||!segmentId)throw new Error('sealed original requires campaign and segment context');
  const expected=sealedOriginalSnapshotPath(campaignPath,segmentId,sealed);
  if(sealed.sealedOriginalPath&&sealed.sealedOriginalPath!==expected)throw new Error('sealed original snapshot path mismatch: '+sealed.path);
  const snapshot=requiredFile(root,expected,'campaign-local sealed master-review original');
  const bytes=fs.readFileSync(snapshot);
  if(gitBlobSha1(bytes)!==sealed.gitBlobSha1||digestBytes(bytes)!==sealed.sha256)throw new Error('sealed original campaign snapshot Git/SHA256 digest mismatch: '+expected);
  return bytes;
}
// The bound phase schema is the single authority for reviewer-owned outputs.
// Nested controller-prefilled record attributes remain immutable even though
// the surrounding semantic record is reviewer-owned.
export function masterReviewerFieldContract(schema){
  const out=[];
  for(const [stepKey,action] of Object.entries(schema.actions??{})){
    for(const field of action.fields??[]){
      out.push({path:'actions.'+stepKey+'.outputs.'+field.name,
        controllerPrefillFields:[...(field.controllerPrefillFields??[])]});
    }
  }
  return out;
}
function reviewerOutputPaths(schema){return masterReviewerFieldContract(schema).map(row=>row.path);}
function valueAt(object,dot){return String(dot).split('.').reduce((v,k)=>v===undefined||v===null?undefined:v[k],object);}
function amendmentFailures({root,authorityRoot,sealed,original,amended}){
  const failures=[];
  if(sealed.phase===7)return {failures:['Phase 7 is controller-generated and cannot be amended: '+sealed.path],changedFields:[]};
  const schema=loadPhaseSchema(root,authorityRoot,sealed.phase).schema;
  const owned=reviewerOutputPaths(schema);
  const protectedOriginal=structuredClone(original);
  const protectedAmended=structuredClone(amended);
  for(const dot of owned){deleteObjectPath(protectedOriginal,dot);deleteObjectPath(protectedAmended,dot);}
  if(!exactJson(protectedOriginal,protectedAmended))failures.push('amended work form changed controller-owned data outside reviewer-written fields: '+sealed.path);
  const changedFields=owned.filter(dot=>!exactJson(valueAt(original,dot),valueAt(amended,dot)));
  for(const field of masterReviewerFieldContract(schema)){
    if(!field.controllerPrefillFields.length)continue;
    const before=valueAt(original,field.path),after=valueAt(amended,field.path);
    if(!Array.isArray(before)||!Array.isArray(after))continue;
    const protectedValues=(rows)=>rows.map(row=>{
      if(!row||typeof row!=='object'||Array.isArray(row))return row;
      return Object.fromEntries(field.controllerPrefillFields.map(k=>[k,row[k]]));
    });
    if(!exactJson(protectedValues(before),protectedValues(after))){
      failures.push('amended field changed schema-protected controller-prefilled record attributes: '+sealed.path+'#'+field.path);
    }
  }
  // Some reviewer-visible outputs are separately included in the sealed
  // controller digest (for example Phase-6 typedExecutionLimitations).
  // Name the exact protected path before reporting a generic digest error, so
  // the master can restore the original rather than retrying blindly.
  for(const dot of original?.automationInputs?.controllerOwnedOutputPaths??[]){
    if(!exactJson(valueAt(original,dot),valueAt(amended,dot)))
      failures.push('Controller-owned output modified: '+sealed.path+'#'+dot+
        ' (restore the sealed original value; explain needed corrections in an unprotected reviewer-owned field)');
  }
  // Historical bookkeeping mappings are valid reviewer outputs. The controller
  // must replay them from sealed predecessors, not reject their correction.
  for(const deficiency of validatePhaseScaffold(sealed.phase,amended,original?.automationInputs?.controllerPrefillDigestSha256??null))failures.push(sealed.path+': '+deficiency);
  return {failures,changedFields};
}

export function processMasterReviewSubmission({root,campaignPath,directory,authorityRoot,segmentId,outcome,summary=null,now}){
  const cfg=validateMasterReviewConfiguration(directory,{required:true});
  const pending=directory.pendingMasterReview;
  if(!pending)throw new Error('campaign has no pending master review');
  if(['STOPPED_BY_HUMAN','BLOCKED'].includes(String(directory.campaignStatus??'')))return {status:'MASTER_REVIEW_HELD',failures:['campaign is held by explicit human status '+directory.campaignStatus],pending};
  if(segmentId&&segmentId!==pending.segmentId)throw new Error('submitted segment does not match pending master review');
  const segment=segmentForId(pending.segmentId,authorityRoot,root);
  if(!segment)throw new Error('pending master review segment is unsupported');
  if(pending.status!=='WAITING_FOR_MASTER_REVIEW'||directory.campaignStatus!=='WAITING_FOR_MASTER_REVIEW')
    return {status:'MASTER_REVIEW_HELD',failures:['master is waiting for targeted-test evidence; neither PASS nor another directive is permitted'],pending};
  if(!MASTER_OUTCOMES_V1.includes(String(outcome??'')))return {status:'MASTER_REVIEW_INVALID',failures:['masterOutcome must be '+MASTER_OUTCOMES_V1.join(' or ')],pending};
  const record=readJson(requiredFile(root,pending.recordPath,'master review record'));
  const failures=[
    ...validateLockedRecord(record,pending,directory,cfg),
    ...currentBindingFailures(root,campaignPath,record,directory,authorityRoot)
  ];
  // Independent master-review gate: even a previously SEALED/PASS receipt is
  // insufficient when required machine execution never occurred. Never mutate
  // sealed originals; hold acceptance until a controller-authorized repair.
  // Only reviewer-2's Phase-5 master segment may enter a controlled AMENDED
  // replay before machine evidence is complete. The controller replay itself
  // MUST rerun Phase 5 and satisfy the fail-closed Phase-5 gate, preserving
  // the original sealed receipt under the existing supersession protocol.
  // Ordinary acceptance and every later master segment stay held.
  const machineRepairReplay=(['reviewer-2-phases-02-05','reviewer-3-phases-05-07','reviewer-3-phases-05-06'].includes(pending.segmentId)&&outcome==='AMENDED');
  const isPostCompletionFollowup=pending.segmentId==='reviewer-4-followup-v1'&&
    pending.postCompletionFollowup?.schemaVersion==='curveyield-lite-post-completion-followup-admission-v1';
  if(isPostCompletionFollowup&&outcome==='ACCEPT_WITHOUT_MODIFICATIONS')
    return {status:'MASTER_REVIEW_INVALID',failures:['Post-completion follow-up requires amended evidence-bound security decisions; accepting the original unconfirmed result unchanged is prohibited'],record,pending};
  const requiredFollowupIds=['P4-CAND-001','P4-CAND-002','OBL-P3-P3-OBL-005'];
  const submittedFollowupIds=new Set();
  if(isPostCompletionFollowup){
    for(const item of pending.targetedTests??[]){
      if(item.status!=='EVIDENCE_SUBMITTED')continue;
      for(const key of item.candidateIds??[])submittedFollowupIds.add(key);
    }
    if(outcome==='AMENDED'){
      const missing=requiredFollowupIds.filter(key=>!submittedFollowupIds.has(key));
      if(missing.length)return {status:'MASTER_REVIEW_INVALID',failures:['Follow-up requires verified technical evidence for '+missing.join(', ')+' before master amendment'],record,pending};
    }
  }
  if(segment.boundaryPhase>=5&&!machineRepairReplay&&outcome!=='REQUEST_TARGETED_TESTS'&&!isPostCompletionFollowup){
    try{
      const prior=readJson(requiredFile(root,canonicalRel(campaignPath,5),'Phase-5 canonical data'));
      const ownerDeferral=inspectPhase5OwnerEvidenceDeferralV1({
        controllerRoot:root,campaignPath,campaignId:directory.campaignId,
        sourceSha256:directory.sourceSha256,
        targetDesigns:prior?.actions?.['step-3']?.outputs?.targetDesigns??[]
      });
      if(ownerDeferral){
        if(prior?.automationOutputs?.phase5MachineExecutionGate?.status!=='DEFERRED_UNVERIFIED'||
           prior?.automationOutputs?.phase5MachineExecutionGate?.ownerDirectivePath!==ownerDeferral.path)
          failures.push('Owner evidence deferral is not bound to exact Phase-5 canonical data');
      }else failures.push(...validateRecordedPhase5MachineEvidenceV1({
        controllerRoot:root,campaignPath,
        targetDesigns:prior?.actions?.['step-3']?.outputs?.targetDesigns??[],
        expectedCampaignId:directory.campaignId,expectedSourceSha256:directory.sourceSha256,
        requireCompletedMatrix:true
      }));
    }catch(error){failures.push('Required Phase-5 machine evidence validation failed: '+String(error?.message??error));}
  }
  if(!failures.length&&record.depthSpotCheck&&outcome!=='REQUEST_TARGETED_TESTS')
    failures.push(...validateMasterDepthSpotCheckV1({root,campaignPath,assignment:record.depthSpotCheck}));
  if(failures.length)return {status:'MASTER_REVIEW_HELD',failures,record,pending};
  const sealedByPath=new Map((pending.sealedWorkForms??[]).map(x=>[x.path,x]));
  // Only reviewer work forms may change; every report, canonical record, receipt
  // and machine artifact must still match the sealed segment manifest.
  failures.push(...currentArtifactFailures(root,campaignPath,record.reviewedArtifacts.filter(x=>!sealedByPath.has(x.path))));
  const changed=[];
  for(const sealed of sealedByPath.values()){
    const file=existing(root,path.posix.join(campaignPath,sealed.path));
    if(!file){failures.push('reviewed work form missing: '+sealed.path);continue;}
    const afterSha256=digestFile(file);
    if(afterSha256!==sealed.sha256)changed.push({sealed,file,afterSha256});
  }
  if(failures.length)return {status:'MASTER_REVIEW_INVALID',failures,record,pending};
  if(outcome==='REQUEST_TARGETED_TESTS')
    return {status:'MASTER_TARGETED_TESTS_REQUEST_READY',failures:[],record,pending,segment,outcome};
  if((pending.targetedTests??[]).some(x=>x.status!=='EVIDENCE_SUBMITTED'))
    return {status:'MASTER_REVIEW_INVALID',failures:['required targeted-test assignment has not returned verified evidence'],record,pending};
  if(outcome==='CLOSE_INCOMPLETE'){
    // Administrative terminal close, NOT master acceptance or security PASS.
    // Only this owner-deferred historical campaign may use it. It never replays
    // Phase 5, creates a test directive, or alters a sealed audit artifact.
    if(directory.campaignId!=='live-ethereum-dai-6b175474-r2'||
       pending.segmentId!=='reviewer-4-phases-08-10'||
       pending.boundaryPhase!==10||
       pending.successorPlan?.nextPhaseSequence!==null)
      failures.push('CLOSE_INCOMPLETE requires the exact DAI r2 terminal Phase-10 segment');
    if(changed.length)
      failures.push('CLOSE_INCOMPLETE cannot amend sealed work forms; found changes: '+
        changed.map(x=>x.sealed.path).join(', '));
    if((pending.targetedTests??[]).length)
      failures.push('CLOSE_INCOMPLETE cannot bypass pending master-targeted-test directives');
    if(!String(summary??'').includes('NOT_SECURITY_CLEARED'))
      failures.push('CLOSE_INCOMPLETE summary must explicitly state NOT_SECURITY_CLEARED');
    try{
      const matrix=readJson(requiredFile(root,path.posix.join(campaignPath,
        'work/phase-10/COVERAGE_MATRIX_v1.json'),'final coverage matrix'));
      const form=readJson(requiredFile(root,path.posix.join(campaignPath,
        'work/phase-10/PHASE_10_WORK_FORM_v1.json'),'final reviewer verdict'));
      const ledger=readJson(requiredFile(root,path.posix.join(campaignPath,
        'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json'),'final obligation ledger'));
      const phase9=readJson(requiredFile(root,path.posix.join(campaignPath,
        'receipts/PHASE_09_RECEIPT_v1.json'),'Phase-9 skip receipt'));
      const verdict=String(form?.actions?.['step-3']?.outputs?.liteVerdict??'');
      const incompleteVerdict=verdict.includes('PARTIAL_COVERAGE')&&
        verdict.includes('NOT_YET_QUALIFIED')&&verdict.includes('NOT_SECURITY_CLEARED')&&
        verdict.includes('INCONCLUSIVE_MATERIAL_SECURITY_ASSURANCE');
      const rows=matrix?.rows??[];
      const blocked=(ledger?.obligations??[]).filter(x=>x.status==='BLOCKED_CARRIED').map(x=>x.obligationId);
      const phase9Raw=JSON.stringify(phase9);
      if(!incompleteVerdict)failures.push('Phase-10 reviewer verdict does not explicitly state materially incomplete/non-cleared assurance');
      if(matrix?.label!=='PARTIAL_COVERAGE'||!Number.isInteger(matrix.gapCount)||matrix.gapCount<1||
         !Array.isArray(rows)||rows.length!==matrix.gapCount||
         !rows.some(x=>x.reviewStatus==='CONTRADICTED')||
         !rows.every(x=>x.testStatus==='INCONCLUSIVE'))
        failures.push('Phase-10 coverage matrix does not prove nonzero unresolved, fully inconclusive property-test gaps');
      if(!['OBL-P3-CUSTOM-LIVE-WARD','OBL-P3-AUTO-DOM-015','OBL-P3-AUTO-DOM-019']
        .every(id=>blocked.includes(id)))
        failures.push('The three material blocked obligations must remain BLOCKED_CARRIED');
      if(!phase9Raw.includes('SKIPPED_NO_REMEDIATION'))
        failures.push('Phase 9 must remain explicitly SKIPPED_NO_REMEDIATION');
      const phase5=readJson(requiredFile(root,canonicalRel(campaignPath,5),'Phase-5 canonical data'));
      if(phase5?.automationOutputs?.phase5MachineExecutionGate?.status!=='DEFERRED_UNVERIFIED')
        failures.push('DAI owner-deferred Phase-5 machine status was modified');
      const continuity=readJson(requiredFile(root,canonicalRel(campaignPath,10),'Phase-10 canonical data'))
        ?.automationOutputs?.candidateEvidenceContinuity??[];
      if(!['CAND-001','CAND-002','CAND-003'].every(id=>continuity.some(x=>
        x.candidateKey===id&&x.currentPhaseExecutionStatus==='DEFERRED_UNVERIFIED'&&
        x.phase6ProofVerdict==='INCONCLUSIVE')))
        failures.push('All three evidence-continuity records must preserve their unexecuted/inconclusive status');
      if(!failures.length)return {status:'MASTER_REVIEW_CLOSE_INCOMPLETE_READY',
        failures:[],record,pending,segment,outcome,summary,amendedForms:[],successorPlan:pending.successorPlan,
        incompleteEvidence:{coverageLabel:matrix.label,coverageGapCount:matrix.gapCount,
          contradictedContexts:rows.filter(x=>x.reviewStatus==='CONTRADICTED').map(x=>x.contextId),
          blockedObligationIds:blocked,candidateExecutionStatus:'DEFERRED_UNVERIFIED',
          securityAssurance:'NOT_SECURITY_CLEARED',detectionQualification:'NOT_YET_QUALIFIED',
          phase9Disposition:'SKIPPED_NO_REMEDIATION'}};
    }catch(error){failures.push('Cannot validate incomplete-closure evidence: '+String(error?.message??error));}
    return {status:'MASTER_REVIEW_INVALID',failures,record,pending};
  }
  if(outcome==='ACCEPT_WITHOUT_MODIFICATIONS'){
    if(changed.length)return {status:'MASTER_REVIEW_INVALID',failures:['ACCEPT_WITHOUT_MODIFICATIONS was submitted but work forms changed; submit AMENDED instead: '+changed.map(x=>x.sealed.path).join(', ')],record,pending};
    return {status:'MASTER_REVIEW_ACCEPTED',failures:[],record,pending,segment,outcome,summary,amendedForms:[],successorPlan:pending.successorPlan};
  }
  if(!changed.length)return {status:'MASTER_REVIEW_INVALID',failures:['AMENDED was submitted but no segment work form changed; submit ACCEPT_WITHOUT_MODIFICATIONS instead'],record,pending};
  const amendedForms=[];
  for(const item of changed){
    let original;
    try{original=readSealedOriginal(root,item.sealed,{campaignPath,segmentId:pending.segmentId});}catch(error){failures.push(String(error.message||error));continue;}
    let amended;
    try{amended=readJson(item.file);}catch{failures.push('amended work form is not valid JSON: '+item.sealed.path);continue;}
    const checked=amendmentFailures({root,authorityRoot,sealed:item.sealed,original:JSON.parse(original.toString('utf8')),amended});
    failures.push(...checked.failures);
    if(!checked.changedFields.length&&!checked.failures.length)failures.push('amended work form changed no reviewer-written field: '+item.sealed.path);
    amendedForms.push({phase:item.sealed.phase,path:item.sealed.path,beforeSha256:item.sealed.sha256,afterSha256:item.afterSha256,gitBlobSha1:item.sealed.gitBlobSha1,changedFields:checked.changedFields,originalBytes:original});
  }
  if(failures.length)return {status:'MASTER_REVIEW_INVALID',failures,record,pending};
  return {
    status:'MASTER_AMENDMENT_READY_FOR_REFRESH',
    failures:[],
    record,
    pending,
    segment,
    outcome,
    summary,
    amendedForms,
    affectedPhases:[...new Set(amendedForms.map(x=>x.phase))].sort((a,b)=>a-b),
    amendmentSha256:digestJson(amendedForms.map(({originalBytes,...rest})=>rest)),
    successorPlan:pending.successorPlan
  };
}

export function masterWakeMessage({campaignId,pending,auditControllerRef='main',authorityRoot=null,extraLines=[]}){
  const phases=pending.segmentPhases.length===1?'Phase '+pending.segmentPhases[0]:'Phases '+pending.segmentPhases[0]+'-'+pending.segmentPhases.at(-1);
  const guide=(authorityRoot?authorityRoot+'/':'')+'master-review/START_HERE.md';
  return 'MASTER_REVIEW_REQUIRED: campaign '+campaignId+', segment '+pending.segmentId+' ('+pending.reviewerId+', '+phases+'). '+
    'Read the segment record '+pending.recordPath+' in Audit-Controller. '+
    'Follow the authoritative Audit Skill guide '+guide+' for review, amendment limits, and submission. '+
    'Use the campaign ref '+auditControllerRef+'.'+(extraLines.length?'\n'+extraLines.join('\n'):'');
}

function assertDigest(root,record,label){
  if(!record||typeof record.path!=='string'||!SHA256.test(String(record.sha256??'')))throw new Error(label+' path/sha256 are required');
  const file=requiredFile(root,record.path,label);
  if(digestFile(file)!==record.sha256)throw new Error(label+' digest mismatch');
  return file;
}
function deleteObjectPath(object,dot){
  const parts=String(dot).split('.');
  let current=object;
  for(let i=0;i<parts.length-1;i++){
    if(!current||typeof current!=='object'||!(parts[i] in current))return;
    current=current[parts[i]];
  }
  if(current&&typeof current==='object')delete current[parts.at(-1)];
}
function validateAllowedSemanticPaths(root,authorityRoot,phase,paths){
  const schema=loadPhaseSchema(root,authorityRoot,phase).schema;
  const failures=[];
  for(const semanticPath of paths??[]){
    const match=String(semanticPath).match(/^actions\.([A-Za-z0-9._-]+)\.outputs\.([A-Za-z0-9._-]+)$/);
    if(!match){failures.push('not a reviewer-owned action output: '+semanticPath);continue;}
    const field=(schema.actions?.[match[1]]?.fields??[]).find(x=>x.name===match[2]);
    if(!field)failures.push('not declared by bound phase schema: '+semanticPath);
  }
  return failures;
}
export function admitSealedPhaseRework({root,campaignPath,directory,requestPath,now}){
  const request=readJson(requiredFile(root,requestPath,'sealed-phase rework request'));
  if(request.schemaVersion!=='curveyield-lite-sealed-phase-rework-request-v1')throw new Error('sealed rework request schemaVersion mismatch');
  if(request.campaignId!==directory.campaignId||request.phaseSequence!==1)throw new Error('sealed rework request campaign/phase mismatch');
  if(request.fromRevision!==2||request.toRevision!==3)throw new Error('sealed rework request must be the authorized revision2-to-revision3 repair');
  if(request.holdSuccessorDelivery!==true)throw new Error('sealed rework request must hold successor delivery');
  if(request.sourceSha256!==directory.sourceSha256)throw new Error('sealed rework source binding mismatch');
  const expectedRoot='Audit Skill - Current Authority/Audit_Litemode_v10.3';
  if(request.authority?.logicalRoot!==expectedRoot)throw new Error('sealed rework must remain bound to logical v10.3 authority');
  if(request.authority?.expectedRootSha256!=='bdb90107ea50580e67be91440ce47087de570c4f54b8474c5a3eb852af95ea27')throw new Error('sealed rework authority root digest mismatch');
  if(request.authority?.expectedManifestSha256!=='846be5f90d6e00757b817b1218dfabeb2aa4dff6c92b8e9ff47335d2db83703a')throw new Error('sealed rework authority manifest digest mismatch');
  requiredFile(root,path.posix.join(expectedRoot,'SKILL.md'),'bound v10.3 authority root');
  requiredFile(root,path.posix.join(expectedRoot,'MANIFEST.json'),'bound v10.3 authority manifest');
  if(directory.lastSealedReceiptPath!==request.priorReceipt?.path)throw new Error('sealed rework priorReceipt must equal directory.lastSealedReceiptPath');
  const priorReceiptFile=assertDigest(root,request.priorReceipt,'prior Phase-1 receipt');
  const priorReceipt=readJson(priorReceiptFile);
  if(priorReceipt.phase?.sequence!==1||priorReceipt.phase?.revision!==2||priorReceipt.phase?.status!=='SEALED')throw new Error('prior receipt is not sealed Phase-1 revision2');
  if(priorReceipt.source?.sha256!==directory.sourceSha256&&priorReceipt.sourceSha256!==directory.sourceSha256)throw new Error('prior receipt source mismatch');
  if(path.posix.dirname(priorReceipt.authority?.homepagePath??'')!==expectedRoot)throw new Error('prior receipt authority mismatch');
  const priorFormRef=[...(priorReceipt.evidence??[]),...(priorReceipt.outputs??[])].find(x=>x?.role==='PHASE_WORK_FORM');
  const normalizeReceiptPath=value=>String(value??'').startsWith(campaignPath+'/')?String(value):path.posix.join(campaignPath,String(value??''));
  if(!priorFormRef||normalizeReceiptPath(priorFormRef.path)!==request.priorWorkForm?.path||priorFormRef.sha256!==request.priorWorkForm?.sha256)throw new Error('sealed rework priorWorkForm is not the exact form bound by the prior receipt');
  const priorFormFile=assertDigest(root,request.priorWorkForm,'prior Phase-1 work form');
  const repairedFormFile=assertDigest(root,request.repairedWorkForm,'repaired Phase-1 work form');
  assertDigest(root,request.qualityReview,'Phase-1 quality review');
  if(!request.humanAuthorization?.scopeId||!request.humanAuthorization?.authorizedAt)throw new Error('explicit human rework authorization metadata is required');
  const authorizationFile=assertDigest(root,{path:request.humanAuthorization.recordPath,sha256:request.humanAuthorization.recordSha256},'human rework authorization record');
  const authorization=readJson(authorizationFile);
  const authorizationMatches=
    authorization.schemaVersion==='curveyield-human-rework-authorization-v1'
    && authorization.scopeId===request.humanAuthorization.scopeId
    && authorization.campaignId===directory.campaignId
    && authorization.campaignGenerationId===directory.campaignGenerationId
    && authorization.phaseSequence===1
    && authorization.fromRevision===2
    && authorization.toRevision===3
    && authorization.sourceSha256===directory.sourceSha256
    && authorization.authorityLogicalRoot===expectedRoot
    && authorization.deliveryHold===true
    && authorization.mainCodeMergeAuthorized===false
    && authorization.recordedAt===request.humanAuthorization.authorizedAt
    && exactJson(authorization.allowedSemanticPaths,request.allowedSemanticPaths);
  if(!authorizationMatches)throw new Error('human rework authorization record does not exactly authorize this campaign/source/scope/path set');
  const allowed=request.allowedSemanticPaths;
  if(!Array.isArray(allowed)||allowed.length===0)throw new Error('allowedSemanticPaths must be non-empty');
  const allowedFailures=validateAllowedSemanticPaths(root,expectedRoot,1,allowed);
  if(allowedFailures.length)throw new Error('invalid sealed rework scope: '+allowedFailures.join('; '));
  const priorForm=readJson(priorFormFile);
  const repairedForm=readJson(repairedFormFile);
  const priorProtected=structuredClone(priorForm);
  const repairedProtected=structuredClone(repairedForm);
  for(const semanticPath of allowed){deleteObjectPath(priorProtected,semanticPath);deleteObjectPath(repairedProtected,semanticPath);}
  if(!exactJson(priorProtected,repairedProtected))throw new Error('repaired work form changed data outside allowedSemanticPaths');
  const refresh=request.dependentRefresh??{};
  for(const key of ['regenerateCanonical','regenerateReport','regenerateDerived','resealReceipt','prepareSuccessorAssignment'])if(refresh[key]!==true)throw new Error('dependentRefresh.'+key+' must be true');
  const invalidation=request.evidenceInvalidation??{};
  if(invalidation.eventId!=='INV-P1-REWORK-002'||invalidation.ruleId!=='EIM-013'||invalidation.requiredPriorStatus!=='SEALED_REVISION_2'||invalidation.resolveTo!=='RESOLVED_BY_PHASE_1_REVISION_3')throw new Error('sealed rework invalidation binding mismatch');
  const invalidRel=path.posix.join(campaignPath,'controller/EVIDENCE_INVALIDATION_MATRIX_v1.json');
  const invalid=readJson(requiredFile(root,invalidRel,'evidence invalidation matrix'));
  const events=invalid.events??invalid.invalidationEvents??[];
  if(events.some(x=>x?.eventId==='INV-P1-REWORK-002'||x?.id==='INV-P1-REWORK-002'))throw new Error('INV-P1-REWORK-002 already exists');
  const predecessorInput=(priorReceipt.inputs??[]).find(x=>x?.role==='PREDECESSOR_RECEIPT')?.path;
  if(!predecessorInput)throw new Error('prior Phase-1 receipt lacks predecessor receipt input');
  const loaded=loadPhaseSchema(root,expectedRoot,1);
  const expectedReport=path.posix.join(campaignPath,'work/phase-01/PHASE_01_FINAL_REPORT_v3.md');
  const expectedPacket=path.posix.join(campaignPath,'submissions/PHASE_01_WORK_PACKET_v3.json');
  if(request.generatedFinalReportPath!==expectedReport||request.generatedPacketPath!==expectedPacket)throw new Error('sealed rework must preserve prior products and use report/packet v3 paths');
  if(repairedForm.schemaVersion!=='curveyield-lite-phase-work-form-v1'||repairedForm.phase!==1)throw new Error('repaired work form identity mismatch');
  const prefillDigest=repairedForm.automationInputs?.controllerPrefillDigestSha256;
  if(!SHA256.test(String(prefillDigest??'')))throw new Error('repaired work form lacks controller prefill digest');
  return {
    request,
    authorityRoot:expectedRoot,
    invalidationRel:invalidRel,
    assignment:{
      phaseSequence:1,phaseId:'phase-1',phaseRevision:3,reviewer:'reviewer-1',status:'ACTIVE',
      workSchemaPath:loaded.rel,workFormPath:request.repairedWorkForm.path,
      finalReportPath:request.generatedFinalReportPath,
      packetPath:request.generatedPacketPath,
      predecessorReceiptPath:predecessorInput,derivedInputPaths:priorReceipt.inputs?.filter(x=>x?.role==='DERIVED_INPUT').map(x=>x.path)??[],
      controllerPrefillDigestSha256:prefillDigest,
      sealedRework:{scopeId:request.humanAuthorization.scopeId,requestPath,admittedAt:now}
    }
  };
}
