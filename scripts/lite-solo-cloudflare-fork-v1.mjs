#!/usr/bin/env node
/**
 * Isolated Cloudflare Lite-Solo fork adapter.
 * No old workflow dispatch, no legacy agent-upload ingress, no synthetic PASS.
 * The immutable campaign-bound controller remains the sole phase-sealing authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readJson, writeJson, repoFile, loadPhaseSchema, validateBoundAuthorityV1, EXPLICIT_NEGATIVES} from './lib/lite-solo-phase-work-v1.mjs';
import {readUnitPacketIndexV1, readUnitPacketV1} from '../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';
import {qualifiesLiteralTrivialReviewV13} from '../packages/github-native-sim/src/adr-discovery-validators-v1.mjs';
import {processUnitRequestV1} from './lib/lite-solo-unit-queue-v1.mjs';
import {generateV7ExecutionRequestV1} from './lib/lite-phase5-request-generation-v1.mjs';
import {verifyPhase0ForkStateV1} from '../packages/github-native-sim/src/phase0-fork-state-reuse-v1.mjs';

const OP = process.env.FORK_OPERATION;
const payload = JSON.parse(process.env.FORK_PAYLOAD_JSON || '{}');
const correlationId = process.env.FORK_CORRELATION_ID || '';
const secret = process.env.FORK_CALLBACK_TOKEN;
const ROOT = path.resolve('.audit-controller');
const MACHINE_AUTH='Machine Intelligence Audit Controller/Audit Skill v7';
let AUTH=MACHINE_AUTH;
const CONTROLLER = 'curveyield3/Audit-Controller';
const MACHINE_REF='machine-intelligence-audit-controller-v1';
const allowedOperations = new Set(['PHASE_0_INITIALIZE','PHASE_NEXT_STEP','PHASE_VALIDATE_STEP','PHASE_VALIDATE_UNIT','PHASE_FINALIZE']);
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value,null,2)+'\n');
const strict = (condition, message) => {if (!condition) throw Error(message);};
const safeId = value => {strict(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,150}$/.test(value),'unsafe identity');return value;};
const safePath = value => {strict(typeof value==='string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(x=>!x||x==='..'||x==='.'),'unsafe path');return value;};
const phaseNo = n => String(n).padStart(2,'0');
const relative = value => repoFile(ROOT,safePath(value));
const read = value => readJson(relative(value));
const cmd = (bin,args,options={}) => execFileSync(bin,args,{encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe'],...options});
const need = (key) => {const v=payload[key];strict(v!==undefined && v!==null && v!=='','missing '+key);return v;};

strict(allowedOperations.has(OP),'unsupported fork operation');
safeId(need('audit_id'));
strict(/^https:\/\//.test(need('callback_url')),'worker callback must be HTTPS');
strict(secret && secret.length >= 16,'CLOUDFLARE_FORK_TOKEN secret is missing');
strict(typeof process.env.CLOUDFLARE_WORKER_URL==='string'&&process.env.CLOUDFLARE_WORKER_URL.startsWith('https://'),'fixed CLOUDFLARE_WORKER_URL is required');
{
  const expected = new URL(process.env.CLOUDFLARE_WORKER_URL);
  const supplied = new URL(payload.callback_url);
  strict(expected.origin===supplied.origin && expected.pathname.replace(/\/$/,'')===supplied.pathname.replace(/\/$/,''),'worker callback origin is not configured origin');
}
strict(!new URL(payload.callback_url).username && !new URL(payload.callback_url).password,'callback credentials not allowed');
if(OP==='PHASE_VALIDATE_STEP'||OP==='PHASE_VALIDATE_UNIT'||OP==='PHASE_FINALIZE'){
  strict(correlationId && correlationId===payload.correlation_id,'workflow correlation mismatch');
}
async function callback(route,body){
  const endpoint = new URL(route,payload.callback_url.replace(/\/?$/,'/'));
  strict(endpoint.origin===new URL(payload.callback_url).origin,'invalid callback origin');
  let last;
  for(let i=0;i<3;i++){
    try{
      const response=await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({...body,auditId:payload.audit_id,correlationId})});
      const result=await response.text();
      if(!response.ok)throw Error('Worker rejected '+route+' HTTP '+response.status+': '+result.slice(0,900));
      return result;
    }catch(e){last=e;if(i<2)await new Promise(r=>setTimeout(r,1500*(i+1)));}
  }
  throw last;
}
function readGitHubJson(apiPath){
  const raw=cmd('gh',['api','repos/'+CONTROLLER+'/'+apiPath]);
  return JSON.parse(raw);
}
function directoryKey(campaignId){return 'Audit Campaign Directory/campaigns/'+campaignId.replace(/-r[0-9]+$/,'')+'.json';}
function checkout(){
  const id=safeId(need('campaign_id'));
  strict(/-r[0-9]+$/.test(id),'campaign revision missing');
  const target=directoryKey(id);
  const encoded=target.split('/').map(encodeURIComponent).join('/');
  const meta=readGitHubJson('contents/'+encoded+'?ref='+encodeURIComponent(MACHINE_REF));
  strict(meta.type==='file'&&meta.encoding==='base64','campaign directory missing');
  const directory=JSON.parse(Buffer.from(meta.content.replace(/\s/g,''),'base64').toString('utf8'));
  strict(directory.campaignId===id&&directory.campaignGenerationId===payload.generation_id,'campaign generation mismatch');
  strict(directory.mode==='LITE_SOLO'&&directory.authorityRelease==='machine-intelligence-v7','not a Machine Intelligence campaign');
  AUTH=MACHINE_AUTH;
  strict(directory.authorityDigest===payload.authority_digest,'bound authority digest mismatch');
  safePath(directory.workspacePath);
  cmd('bash',['scripts/lite-solo-checkout-bound-controller-v1.sh','.audit-controller',MACHINE_REF,directory.workspacePath]);
  const local=read(target);
  strict(local.campaignId===id&&local.campaignGenerationId===payload.generation_id,'checkout selected a different campaign');
  strict(local.workspacePath===directory.workspacePath,'campaign workspace path changed');
  const p0=read(local.workspacePath+'/receipts/PHASE_00_RECEIPT_v1.json');
  strict(p0.phase?.status==='SEALED','Phase-0 prerequisite receipt is not structurally sealed'); // Worker owns content validation.
  strict(p0.authority?.manifestSha256===local.authorityDigest,'source-bound manifest identity changed');
  strict(p0.source?.sha256===local.sourceSha256,'admitted source identity changed');
  const boundRoot=validateBoundAuthorityV1({root:ROOT,receipt:p0});
  strict(boundRoot===AUTH,'unexpected frozen audit authority');
  return {directory:local,p0,campaignPath:directory.workspacePath,directoryPath:target};
}
function assertAssigned(c,phase){
  strict(c.directory.currentAssignment?.phaseSequence===phase,'phase is not active in controller');
  strict(c.directory.currentAssignment?.workSchemaPath?.startsWith(AUTH+'/phases/phase-'+phase+'/'),'bound phase schema changed');
}
function publishCanonical(c){
  cmd('git',['-C',ROOT,'config','user.name','CurveYield Cloudflare Fork Controller']);
  cmd('git',['-C',ROOT,'config','user.email','lite-solo-cloudflare-fork@users.noreply.github.com']);
  cmd('git',['-C',ROOT,'add','--',c.campaignPath,c.directoryPath]);
  if(!cmd('git',['-C',ROOT,'diff','--cached','--name-only']).trim())return;
  cmd('git',['-C',ROOT,'commit','-m','audit(lite-solo): seal '+c.directory.campaignId+' via isolated Cloudflare fork']);
  // A different campaign may commit concurrently. Rebase only when its changes
  // do not touch this campaign/directory; never replay stale controller decisions.
  for(let attempt=0;attempt<4;attempt++){
    try{cmd('git',['-C',ROOT,'push','origin','HEAD:'+MACHINE_REF]);return;}
    catch(error){
      cmd('git',['-C',ROOT,'fetch','origin',MACHINE_REF]);
      const upstream=cmd('git',['-C',ROOT,'rev-parse','origin/'+MACHINE_REF]).trim();
      let base;
      try{base=cmd('git',['-C',ROOT,'merge-base','HEAD','origin/'+MACHINE_REF]).trim();}
      catch{
        // The canonical Lite-Solo checkout is depth-one, so a concurrent
        // main update may require the missing ancestry before safe comparison.
        cmd('git',['-C',ROOT,'fetch','--no-tags','--deepen=64','--filter=blob:none','origin',MACHINE_REF]);
        base=cmd('git',['-C',ROOT,'merge-base','HEAD','origin/'+MACHINE_REF]).trim();
      }
      if(upstream===base)throw error; // Not a concurrent update: do not blindly retry.
      const touched=cmd('git',['-C',ROOT,'diff','--name-only',base,'origin/'+MACHINE_REF,'--',c.campaignPath,c.directoryPath]).trim();
      strict(!touched,'CONTROLLER_CAMPAIGN_CHANGED_REVALIDATION_REQUIRED: '+touched);
      // Historical frozen authority is worktree-only; retain it across rebase.
      cmd('git',['-C',ROOT,'-c','rebase.autoStash=true','rebase','origin/'+MACHINE_REF]);
    }
  }
  throw Error('CONTROLLER_PUBLICATION_CONTENTION: safe retries exhausted');
}
function markPhase10Delivery(c,receiptPath){
  const current=read(c.directoryPath);
  strict(current.campaignId===c.directory.campaignId&&current.campaignGenerationId===c.directory.campaignGenerationId,
    'Phase-10 completion identity changed');
  strict(current.campaignStatus==='COMPLETE'&&current.currentAssignment==null&&
    current.lastSealedReceiptPath===receiptPath&&
    receiptPath.startsWith(c.campaignPath+'/receipts/PHASE_10_RECEIPT_v'),
    'Phase-10 controller has not sealed a terminal receipt');
  strict(read(receiptPath).phase?.status==='COMPLETE','Phase-10 terminal receipt is not structurally complete'); // Worker owns semantic acceptance.
  strict(process.env.GITHUB_OUTPUT,'GitHub delivery output is unavailable');
  fs.appendFileSync(process.env.GITHUB_OUTPUT,'phase10_sealed=true\nphase10_receipt='+receiptPath+'\n');
}
function phaseFinalize(c){
 const phase=Number(need('phase')),commit=need('source_commit');
 // The Worker determines eligibility; GitHub organizes and seals the files.
 // No Phase-5 test/preflight, semantic gate, reviewer rework or rejection.
 const requestDir=fs.mkdtempSync('/tmp/machine-intelligence-finalize-');
 try{
  const output=cmd('node',['scripts/lite-solo-unit-request-drain-v1.mjs',
   '--root',ROOT,'--campaign-id',c.directory.campaignId,
   '--requests-root',requestDir,'--mode','finalize'],{maxBuffer:16*1024*1024});
  const result=JSON.parse(output.trim().split('\n').at(-1));
  publishCanonical(c);
  if(result.seal?.status!=='SEALED')return; // Await actual input bytes, never reject audit quality.
  return callback('/fork/phase-sealed',{status:'PASS',campaignId:c.directory.campaignId,
   generationId:c.directory.campaignGenerationId,phase,sourceCommit:commit,
   canonicalReceipt:result.seal.receiptPath,validationDelegatedTo:'CLOUDFLARE_WORKER'});
 }finally{fs.rmSync(requestDir,{recursive:true,force:true});}
}
function loadPagedPrefill(rel){
  const manifest=read(rel);
  if(manifest.schemaVersion!=='curveyield-lite-solo-unit-prefill-manifest-v1')
    return manifest.value;
  strict(manifest.pageCount>=1&&manifest.pageCount<=2048&&manifest.partBytes===12288,'invalid paged prefill');
  const parts=[];
  for(let i=1;i<=manifest.pageCount;i++){
    const name=path.posix.basename(rel,'.json')+'_PART_'+String(i).padStart(6,'0')+'_v1.json';
    const part=read(path.posix.dirname(rel)+'/prefill-pages/'+name);
    strict(part.schemaVersion==='curveyield-lite-solo-unit-prefill-page-v1'&&part.index===i&&part.total===manifest.pageCount,'incorrect prefill part');
    const raw=Buffer.from(part.base64,'base64');
    strict(sha(raw)===part.sha256,'prefill page integrity mismatch');
    parts.push(raw);
  }
  const raw=Buffer.concat(parts);
  strict(raw.length===manifest.byteLength&&sha(raw)===manifest.sha256,'full prefill integrity mismatch');
  return JSON.parse(raw.toString('utf8')).value;
}
function unitPlan(c){
  const a=c.directory.currentAssignment,p=Number(a.phaseSequence);
  strict([4,5,6].includes(p),'wrong unit phase');
  const planRel=safePath(a.unitQueueIndexPath),queueRel=safePath(a.unitQueueStatePath);
  const plan=read(planRel),queue=read(queueRel);
  strict(plan.schemaVersion==='curveyield-lite-solo-unit-plan-v1'&&queue.schemaVersion==='curveyield-lite-solo-unit-queue-state-v1','unknown unit plan/queue format');
  for(const field of ['campaignId','campaignGenerationId','phaseSequence','phaseEpoch','sourceSha256','authorityDigest'])
    strict(plan[field]===queue[field],'unit plan/queue mismatch: '+field);
  strict(plan.campaignId===c.directory.campaignId&&plan.sourceSha256===c.directory.sourceSha256&&plan.authorityDigest===c.directory.authorityDigest,'unit identity mismatch');
  const units=[];
  for(const ref of plan.pages){
    safePath(ref.path);
    const raw=fs.readFileSync(relative(ref.path));
    strict(sha(raw)===ref.sha256&&raw.length<=32768,'unit plan page integrity error');
    const page=JSON.parse(raw.toString('utf8'));
    strict(page.schemaVersion==='curveyield-lite-solo-unit-plan-page-v1'&&page.units.length===ref.count,'invalid unit page');
    for(const x of page.units){
      if(x.initialValueRef){
        const rawValue=fs.readFileSync(relative(x.initialValueRef));
        strict(sha(rawValue)===x.initialValueSha256,'unit initial value manifest mismatch');
        x.initialValue=loadPagedPrefill(x.initialValueRef);
      }
      if(x.kind==='BATCH'){
        const packetRaw=fs.readFileSync(relative(x.packetPath));
        strict(sha(packetRaw)===x.packetSha256,'batch manifest digest mismatch');
        const packet=loadPagedPrefill(x.packetPath);
        strict(packet.schemaVersion==='curveyield-lite-solo-batched-assignment-v1'&&packet.unitId===x.unitId,'unit batch identity error');
        x.members=packet.members;
      }
      units.push(x);
    }
  }
  strict(units.length===plan.unitCount,'unit plan missing records');
  return {plan,queue,units,planRel,queueRel};
}
function unitField(schema,u){
  const pathTokens=u.path||(u.members?.[0]?.path);
  const action=schema.actions?.[pathTokens?.[1]];
  return action?.fields?.find(x=>x.name===pathTokens?.[3]);
}
function assignedExecutionSupport(c,u){
 const phase=Number(c.directory.currentAssignment?.phaseSequence);
 if(phase!==5&&phase!==6)return [];
 const values=(u.kind==='BATCH'?u.members:[u]).map(m=>m?.initialValue).filter(v=>v&&typeof v==='object');
 const stage=String(u.path?.[1]||u.members?.[0]?.path?.[1]||'');
 if(phase===5&&stage!=='step-3'||phase===6&&!['step-4','step-5'].includes(stage))return [];
 const paths=new Set(),workspace=phase===6?c.campaignPath+'/controller/phase6-tests/':c.campaignPath+'/work/phase-05/';
 const add=p=>{
   if(typeof p!=='string'||!p.trim()||p.includes('<')||p==='NONE_IDENTIFIED')return;
   let resolved=p.startsWith(c.campaignPath+'/')?p:path.posix.join(c.campaignPath,p);
   if(!resolved.startsWith(workspace)||!/\.(?:json|sol|toml|md)$/.test(resolved))return;
   safePath(resolved);paths.add(resolved);
 };
 for(const v of values){
   add(v.executionRequestRef);
   for(const p of Array.isArray(v.requestPaths)?v.requestPaths:[])add(p);
   // The directory itself is a controller-prefilled bound scope, never an
   // arbitrary agent-selected workspace. These are optional existing-lane
   // inputs: machine assertions and acceptance remain controller-owned.
   const dir=v.requestDirectory;
   if(phase===6&&typeof dir==='string'&&dir&&!dir.includes('<')){
     const resolved=dir.startsWith(c.campaignPath+'/')?dir:path.posix.join(c.campaignPath,dir);
     if(resolved.startsWith(workspace)){safePath(resolved);
       for(const name of ['request.json','run-2.json','run-3.json','harness.sol','foundry.toml','medusa.json'])add(resolved+'/'+name);
     }
   }
 }
 strict(paths.size<=24,'controller-prefilled execution support exceeds per-unit manifest');
 return [...paths].map(path=>({path,maxBytes:1024*1024,required:false}));
}
// GitHub controller/adapter issues exact answer destinations as assignment metadata.
// No new schema inference, independent AI judgment, Worker source mutation, or
// Actions-per-question orchestration. The original controller's required record
// ownership and accepted-work assembly remain authoritative.
const ANSWER_BINDING_VERSION='curveyield-machine-answer-binding-v1';
const MECHANICAL_ID_FIELDS=new Set([
 'assetKey','actorKey','boundaryKey','transitionKey','requirementKey','dependencyKey',
 'standardKey','driverKey','tempKey','findingTempKey','recordKey','groupKey'
]);
const MACHINE_EXECUTION_FIELDS=new Map([
 ['executionEvidenceRefs','AUTHENTICATED_EXECUTION_EVIDENCE_REFS'],
 ['executionRequestRef','AUTHENTICATED_EXECUTION_REQUEST_REF'],
 ['automationResolvedExecutionRequest','AUTHENTICATED_EXECUTION_REQUEST_BINDING'],
 ['executionEvidenceRef','AUTHENTICATED_EXECUTION_EVIDENCE_REF'],
 ['requestBindingStatus','AUTHENTICATED_REQUEST_BINDING_STATUS'],
 ['requestBindingEvidenceRef','AUTHENTICATED_REQUEST_BINDING_EVIDENCE_REF'],
 ['dispatchRounds','AUTHENTICATED_DISPATCH_ROUNDS'],
 ['requestPaths','AUTHENTICATED_REQUEST_PATHS'],
 ['rerunEvidenceRefs','AUTHENTICATED_RERUN_EVIDENCE_REFS'],
 ['ledgerRef','AUTHENTICATED_PROOF_LEDGER_REF']
]);
const isPendingAnswerValue=v=>typeof v==='string'&&(
 !v.trim()||v.startsWith('<REQUIRED')||v.startsWith('<CONTROLLER_')||
 v==='<fill>'||v==='TODO'
);
const negativeSentinel=v=>(typeof v==='string'&&EXPLICIT_NEGATIVES.has(v))||
 (Array.isArray(v)&&v.length===1&&typeof v[0]==='string'&&EXPLICIT_NEGATIVES.has(v[0]));
// Exact admitted execution-request file + authenticated ingestion tuple.
// No guessing of request paths, round counts, proof outcomes, or semantic results.
// A GitHub-created request is a real binding BEFORE any machine execution.
// Do not require a PASS result merely to locate its immutable request path.
function boundMachineRequestsV1(c,row){
 const paths=[],root=c.campaignPath,cd=c.directory;
 const add=rel=>{if(typeof rel==='string'&&rel.startsWith(root+'/'))paths.push(rel);};
 const key=typeof row?.candidateKey==='string'?row.candidateKey:null;
 if(key&&/^[A-Za-z0-9_.-]{1,150}$/.test(key))
  add(path.posix.join(root,'work/phase-05/execution-requests',key+'.json'));
 if(typeof row?.executionRequestRef==='string'&&
   row.executionRequestRef.startsWith('work/phase-05/execution-requests/'))
  add(path.posix.join(root,row.executionRequestRef));
 if(typeof row?.requestDirectory==='string'&&
   /^(?:controller\/phase6-tests|controller\/phase9-reruns)\//.test(row.requestDirectory)){
  const dir=path.posix.join(root,row.requestDirectory);
  try{
   const abs=relative(dir);
   if(fs.existsSync(abs)&&fs.statSync(abs).isDirectory())
    for(const name of fs.readdirSync(abs))
     if(/^[A-Za-z0-9_.-]+\.json$/.test(name))add(path.posix.join(dir,name));
  }catch{ /* No executed or issued requests yet; leave as unresolved. */ }
 }
 const found=[];
 for(const rel of new Set(paths)){
  let request;
  try{
   if(!fs.existsSync(relative(rel)))continue;
   request=read(rel);
  }catch{continue;}
  if(typeof request?.requestId!=='string'||!/^[A-Za-z0-9_.-]{1,150}$/.test(request.requestId)||
     typeof request.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(request.requestDigest)||
     request.campaignId!==cd.campaignId)continue;
  const sourceHash=request.sourceSha256??request.source?.archiveSha256??request.source?.sha256;
  if(sourceHash!==cd.sourceSha256)continue;
  if(key&&String(request.assignmentId??'').startsWith('phase5-target-')&&
     request.assignmentId!=='phase5-target-'+key)continue;
  found.push({request,requestId:request.requestId,requestDigest:request.requestDigest,
   requestPath:rel,requestSha256:sha(fs.readFileSync(relative(rel)))});
 }
 return found;
}
// Ingested evidence of a failed run is still authentic evidence of failure;
// it must never be discarded or presented as a PASS proof.
function verifiedMachineSourcesV1(c,row){
 const verified=[];
 for(const source of boundMachineRequestsV1(c,row)){
  const parent=path.posix.join(c.campaignPath,'controller/automation',source.requestId);
  const evidencePath=path.posix.join(parent,'EXECUTION_EVIDENCE_v1.json');
  const receiptPath=path.posix.join(parent,
   'ingestion/EXECUTION_EVIDENCE_INGESTION_RECEIPT_v1.json');
  let machine,receipt;
  try{
   if(!fs.existsSync(relative(evidencePath))||!fs.existsSync(relative(receiptPath)))continue;
   machine=read(evidencePath);receipt=read(receiptPath);
  }catch{continue;}
  // The ingestion receipt must bind the exact machine-evidence file bytes.
  // Request ID alone, or the execution file's own digest claim, is insufficient.
  const evidenceSha256=sha(fs.readFileSync(relative(evidencePath)));
  if(receipt?.schemaVersion!=='audit-execution-evidence-ingestion-receipt-v1'||
     receipt.requestId!==source.requestId||
     receipt.requestDigest!==source.requestDigest||
     receipt.artifactDigest!==evidenceSha256||
     machine?.requestId!==source.requestId||
     machine?.requestDigest!==source.requestDigest)continue;
  const cleanExecution=machine.blocking===false&&
   ['PASS','FINDINGS'].includes(machine.disposition)&&
   (machine.failedStepCount??0)===0&&
   (machine.analysisComponentFailureCount??0)===0&&
   (machine.failedSteps?.length??0)===0&&
   (!machine.preflight||machine.preflight.status==='PASS');
  verified.push({...source,executionEvidenceRef:evidencePath,
   ingestionReceiptRef:receiptPath,evidenceSha256,
   qualifiedExecution:cleanExecution,
   machineFields:Object.fromEntries(['dispatchRounds','requestPaths','ledgerRef',
    'requestBindingStatus','requestBindingEvidenceRef','automationResolvedExecutionRequest']
    .filter(k=>machine[k]!==undefined).map(k=>[k,machine[k]]))});
 }
 return verified;
}
function machineVerifiedValueV1(c,row,key){
 const requests=boundMachineRequestsV1(c,row),sources=verifiedMachineSourcesV1(c,row);
 if(key==='executionRequestRef'&&requests.length===1)
  return {value:path.posix.relative(c.campaignPath,requests[0].requestPath),
   requestBound:true,sources:requests};
 if(key==='requestPaths'&&requests.length)
  return {value:requests.map(r=>r.requestPath),requestBound:true,sources:requests};
 // A failed attempt remains in its immutable evidence file for diagnosis,
 // but it must not fill a field consumed as successful execution proof.
 const qualified=sources.filter(r=>r.qualifiedExecution);
 if(key==='executionEvidenceRefs'&&qualified.length)
  return {value:qualified.map(r=>r.executionEvidenceRef),sources:qualified,
   qualifiedAsProof:true};
 if(key==='executionEvidenceRef'&&qualified.length===1)
  return {value:qualified[0].executionEvidenceRef,sources:qualified,
   qualifiedAsProof:true};
 if(!sources.length)return null;
 const exact=sources.filter(x=>Object.hasOwn(x.machineFields,key));
 if(exact.length!==1)return null; // Never choose between conflicting observations.
 // A failed machine attempt may document a failure, but cannot populate
 // proof-bearing ledger/binding references without a qualified execution.
 if(['ledgerRef','requestBindingEvidenceRef','rerunEvidenceRefs'].includes(key)&&
    !exact[0].qualifiedExecution)return null;
 return {value:exact[0].machineFields[key],sources:exact,
  qualifiedAsProof:exact[0].qualifiedExecution};
}
function unresolvedMachineFieldV1(field,old){
 if(old!==undefined&&old!==null&&!isPendingAnswerValue(old))return old;
 if(field==='executionEvidenceRefs')return ['NO_MACHINE_EVIDENCE'];
 if(field==='requestPaths')return [];
 if(field==='requestBindingStatus')return 'UNVERIFIED';
 if(field==='requestBindingEvidenceRef')return 'NO_BINDING_EVIDENCE';
 return 'UNRESOLVED';
}

function controllerAnswerFieldBindingV1({c,fieldName,sourceRow,definition,itemField,
 actionPrefillFields=[],actionCollectedFields=[],appendNew=false}){
 const value=sourceRow?.[itemField],allowed=definition?.itemFieldAllowedValues?.[itemField]??null;
 const collected=[...(definition?.controllerCollectedFields??[]),...actionCollectedFields].includes(itemField);
 const owned=[...(definition?.controllerPrefillFields??[]),...actionPrefillFields].includes(itemField)||
   (Array.isArray(sourceRow?.automationOwnedFields)&&sourceRow.automationOwnedFields.includes(itemField));
 if(appendNew&&owned&&(value===undefined||isPendingAnswerValue(value))){
  // No prefilled value exists for an APPEND; never copy or erase a new row.
  if(MECHANICAL_ID_FIELDS.has(itemField))
   return {field:itemField,source:'ALLOCATE_MECHANICALLY_IF_NEW',
    deterministicRule:'MI_PHASE_ISSUED_UNIT_FIELD_RECORD_ORDINAL',
    issuer:'GITHUB_CONTROLLER',selector:'phaseSequence/unitId/field/itemOrdinal',
    collisionPolicy:'DO_NOT_OVERWRITE_PREVIOUS_IDS'};
  if(allowed?.length)return {field:itemField,source:'AI_EXACT_ENUM',
   allowedValues:[...allowed],conversion:'LITERAL_TOKEN_ONLY'};
  if(['subjectKey','candidateKey','obligationId','findingKey'].includes(itemField))
   return {field:itemField,source:'BIND_EXISTING_CONTROLLER_SUBJECT',
    authoritativeSelector:'ISSUED_ROW_OR_ACCEPTED_PREDECESSOR_EXACT_KEY',
    unmatchedIdentityPolicy:'UNRESOLVED_DO_NOT_INVENT_EXISTING_SUBJECT'};
  return {field:itemField,source:'AI_SECURITY_ANSWER',
   answerMode:'VERBATIM_UNLESS_SCHEMA_REQUIRES_ARRAY_OR_OBJECT'};
 }
 if(collected)return {field:itemField,source:'CONTROLLER_COLLECT_AFTER_EXECUTION',
  evidenceKind:MACHINE_EXECUTION_FIELDS.get(itemField)??'CONTROLLER_BOUND_EXECUTION_RESULT',
  exactControllerInput:value??null,requiresAuthenticatedIngestion:true,
  verifiedEvidence:c?machineVerifiedValueV1(c,sourceRow,itemField):null,
  fieldOwner:'CONTROLLER',noEvidencePolicy:'UNRESOLVED_NOT_PROVEN'};
 if(owned||(MECHANICAL_ID_FIELDS.has(itemField)&&typeof value==='string'&&
    value.trim()&&!isPendingAnswerValue(value)&&!negativeSentinel(value))){
  return {field:itemField,source:'PRESERVE_ISSUED_VALUE',value,
   immutable:owned||MECHANICAL_ID_FIELDS.has(itemField)};
 }
 if(MACHINE_EXECUTION_FIELDS.has(itemField))return {field:itemField,source:'CONTROLLER_VERIFIED_EXECUTION',
  verifiedEvidence:c?machineVerifiedValueV1(c,sourceRow,itemField):null,
  evidenceKind:MACHINE_EXECUTION_FIELDS.get(itemField),
  authorizedRequestDirectory:sourceRow?.requestDirectory??null,
  evidenceRequiredBeforeConclusiveVerdict:true,noEvidencePolicy:'UNRESOLVED_NOT_PROVEN'};
 if(allowed?.length)return {field:itemField,source:'AI_EXACT_ENUM',
  allowedValues:[...allowed],conversion:'LITERAL_TOKEN_ONLY'};
 if(MECHANICAL_ID_FIELDS.has(itemField))return {field:itemField,
  source:'ALLOCATE_MECHANICALLY_IF_NEW',
  deterministicRule:'MI_PHASE_ISSUED_UNIT_FIELD_RECORD_ORDINAL',
  issuer:'GITHUB_CONTROLLER',
  selector:'phaseSequence/unitId/field/itemOrdinal',
  collisionPolicy:'DO_NOT_OVERWRITE_PREVIOUS_IDS'};
 if(itemField==='subjectKey'||itemField==='candidateKey'||itemField==='obligationId'||
    itemField==='findingKey')return {field:itemField,source:'BIND_EXISTING_CONTROLLER_SUBJECT',
      authoritativeSelector:'ISSUED_ROW_OR_ACCEPTED_PREDECESSOR_EXACT_KEY',
      unmatchedIdentityPolicy:'UNRESOLVED_DO_NOT_INVENT_EXISTING_SUBJECT'};
 if(/(?:EvidenceRefs|Anchors)$/.test(itemField)||itemField==='evidenceRefs')
  return {field:itemField,source:'AI_EXACT_SOURCE_BOUND_REFERENCES',
   evidencePolicy:'PRESERVE_ACTUAL_SOURCE_OR_MACHINE_IDENTITY_NO_INFERENCE'};
 return {field:itemField,source:'AI_SECURITY_ANSWER',
  answerMode:'VERBATIM_UNLESS_SCHEMA_REQUIRES_ARRAY_OR_OBJECT'};
}
function semanticAnswerBindingV1({c,u,schema,initial}){
 const memberUnits=u.kind==='BATCH'?u.members:(u.kind==='APPEND'?[]:[u]);
 const anchor=u.path??memberUnits[0]?.path;
 const step=anchor?.[1],fieldName=anchor?.[3]??u.field;
 const action=schema.actions?.[step],definition=action?.fields?.find(f=>f.name===fieldName);
 strict(definition,'controller unit has no declared phase output definition');
 const actionPrefillFields=action?.controllerPrefillFields??[];
 const actionCollectedFields=action?.controllerCollectedFields??[];
 const countPolicy=u.kind==='APPEND'?'AI_CHOSEN_APPEND_ONLY':'EXACT_ISSUED_RECORD_COUNT';
 const fieldPath=anchor.join('.');
 const entries=memberUnits.map((member,i)=>({
  memberUnitId:member.unitId,entryIndex:i,
  entryKey:member.recordKeys?.[0]??null,
  submissionValuePath:'entries['+i+'].value',
  canonicalFieldPath:member.path?.join('.')??fieldPath,
  canonicalRecordIndex:member.recordIndex??null,
  valueKind:typeof member.initialValue==='string'?'SCALAR_OR_SENTINEL':
   Array.isArray(member.initialValue)?'ARRAY':member.initialValue&&typeof member.initialValue==='object'?'OBJECT':'SCALAR',
  ...(negativeSentinel(member.initialValue)?{issuedNegativeSentinel:member.initialValue,
   policy:'PRESERVE_ISSUED_NEGATIVE_IN_FIXED_UNIT_USE_APPEND_FOR_NEW_RECORDS'}:{}),
  ...(Array.isArray(member.initialValue)&&member.initialValue.length===0?
   {issuedEmptyArray:true}:{}),
  bindings:definition.type==='REQUIRED_RECORD_LIST'&&member.initialValue&&
   typeof member.initialValue==='object'&&!Array.isArray(member.initialValue)
   ?[...new Set([...(definition.itemRequiredFields??[]),
      ...(definition.controllerCollectedFields??[]),...actionCollectedFields,
      ...(definition.conditionalExecutionBlueprint?['executionBlueprint']:[])])].map(itemField=>controllerAnswerFieldBindingV1({
     c,fieldName,sourceRow:member.initialValue,definition,itemField,
     actionPrefillFields,actionCollectedFields}))
   :[]
 }));
 const ownedOutput=String(definition.owner??'').startsWith('CONTROLLER_')||(schema.controllerOwnedOutputPaths??[])
  .includes(fieldPath)||Boolean(schema.controllerOwnedDefaults?.[fieldName]);
 return {
  schemaVersion:ANSWER_BINDING_VERSION,phaseSequence:schema.phase,unitKind:u.kind,
  unitId:u.unitId,submissionSchemaVersion:initial.schemaVersion,
  exactEnvelope:{schemaVersion:initial.schemaVersion,entries:'ARRAY_OF_EXACT_ISSUED_KEYS_AND_VALUES'},
  field:fieldName,step,canonicalFieldPath:fieldPath,recordCountPolicy:countPolicy,
  issuedRecordCount:entries.length,appendMaximumRecords:1024,
  appendEntryKeyRule:u.kind==='APPEND'?
   'JSON_STRINGIFY_CANONICAL_PATH_PLUS_COLON_PLUS_APPEND_DASH_FOUR_DIGIT_ORDINAL':null,
  appendSubjectCountSource:u.kind==='APPEND'?'AI_EXPLICIT_SUBJECT_COUNT':null,
  fixedEntryKeysImmutable:true,existingPrefillsImmutable:true,
  controllerOwnedOutput:ownedOutput,
  allowedNegativeSentinels:[...EXPLICIT_NEGATIVES].sort(),
  emptyHandling:{
   fixed:'PRESERVE_EACH_CONTROLLER_ISSUED_RECORD_OR_EXACT_NEGATIVE_SENTINEL',
   append:'ZERO_ITEMS_MEANS_EMPTY_APPEND_SUBMISSION_NOT_AN_ADDED_SENTINEL',
   sourceSpecifiedEmptyArray:'PRESERVE_LITERAL_EMPTY_ARRAY_WITHOUT_AI_FILLER',
   noEvidence:'DO_NOT_FABRICATE_EXECUTION_RESULTS'
  },
  scalarAnswer:definition.type==='REQUIRED_ENUM'?
   {source:'AI_EXACT_ENUM',allowedValues:definition.allowed??[]}:
   definition.type==='REQUIRED_LIST'?{source:'AI_LIST_OR_ISSUED_SENTINEL',
    requiredArray:entries.some(e=>e.valueKind==='ARRAY'),
    elementJsonType:'string',parse:'EXPLICIT_LIST_ITEMS_ONLY'}:
   {source:ownedOutput?'PRESERVE_CONTROLLER_OWNED':'AI_VERBATIM',
    requiredSchemaType:definition.type},
  controllerCollectedBindings:[...new Set([...(definition.controllerCollectedFields??[]),
     ...actionCollectedFields])].map(itemField=>
    controllerAnswerFieldBindingV1({c,fieldName,sourceRow:memberUnits[0]?.initialValue??{},
     definition,itemField,actionPrefillFields,actionCollectedFields})),
  recordFieldTemplate:definition.type==='REQUIRED_RECORD_LIST'
    ?[...new Set([...(definition.itemRequiredFields??[]),
      ...(definition.controllerCollectedFields??[]),...actionCollectedFields,
      ...Object.keys(definition.itemFieldAllowedValues??{}),
      ...(definition.controllerPrefillFields??[]).filter(f=>MECHANICAL_ID_FIELDS.has(f)),
      ...(definition.conditionalExecutionBlueprint?['executionBlueprint']:[]),
      ...actionPrefillFields.filter(f=>MECHANICAL_ID_FIELDS.has(f))])]
     .map(itemField=>controllerAnswerFieldBindingV1({
      c,fieldName,sourceRow:memberUnits[0]?.initialValue??{},definition,itemField,
      actionPrefillFields,actionCollectedFields,appendNew:u.kind==='APPEND'})) :[],
  entries
 };
}
function discoveryAnswerBindingV1({u,packet,initial}){
 const data=packet.payload,flow=u.kind==='FLOW';
 const requiredContexts=Array.isArray(data.primaryContextIds)?data.primaryContextIds:[];
 const requiredFlows=Array.isArray(data.flowIds)?data.flowIds:[];
 const requiredQuestions=Array.isArray(data.integrationQuestionIds)?data.integrationQuestionIds:[];
 const checks=Array.isArray(data.contractChecks)?data.contractChecks:[];
 const docs=Array.isArray(data.documentationItems)?data.documentationItems:[];
 const siblings=Array.isArray(data.siblingChecks)?data.siblingChecks:[];
 const eligibleLiteralTrivial=new Set(Array.isArray(data.trivialContextIds)?data.trivialContextIds:[]);
 const rowRecords=flow?requiredContexts.map((id,i)=>{
   const found=(initial.rows??[]).find(x=>x.contextId===id);
   const rules=docs.filter(x=>x.contextId===id);
   const paired=siblings.filter(g=>(g.members??[]).some(m=>m.contextId===id&&m.function===g.signature));
   return {issuedContextOrdinal:i,destination:'rows[byContextId='+id+']',keyField:'contextId',key:id,
    sourceSelector:'packet.payload.primaryContextIds['+i+']',
    countPolicy:eligibleLiteralTrivial.has(id)?'ROW_OR_VERIFIED_TRIVIAL_REVIEW':'REQUIRED_CONTEXT_ROW',
    nested:{
      specInspection:{destination:'rows['+i+'].specInspection',countPolicy:'SINGLE_OBJECT',
        allowedStatus:['MATCH','MISMATCH','UNRESOLVED','NO_DOCUMENTED_RULES']},
      documentedRules:{destination:'rows['+i+'].documentedRules',
        countPolicy:'EXACT_PACKET_RULE_IDS',rules:rules.map(r=>({ruleId:r.ruleId,
          rule:r.rule,sourceSelector:'packet.payload.documentationItems'})),
        allowedComparison:['MATCH','MISMATCH','UNRESOLVED']},
      siblingComparisons:{destination:'rows['+i+'].siblingComparisons',
        countPolicy:'REQUIRED_PACKET_SIBLING_GROUPS',groups:paired.map(g=>({
          signature:g.signature,memberContextIds:(g.members??[]).map(m=>m.contextId)}))}
    },
    allowedVerdict:['CORRECT','DEFECT','UNRESOLVED'],
    controllerPrefill:found?.contextId});
 }):[];
 const attack=flow?[]:requiredFlows.map((id,i)=>({
  recordIndex:i,destination:'attackPaths['+i+']',
  keyField:'flowIds',key:[id],sourceSelector:'packet.payload.flowIds['+i+']',
  countPolicy:'AT_LEAST_ONE_ATTACK_PATH_PER_ISSUED_FLOW',
  allowedResult:['BLOCKED','VIABLE','UNCERTAIN'],
  allowedRole:['UNPRIVILEGED','UNPRIVILEGED_CALLER','OTHER_ROLE','DIFFERENT_ROLE',
   'MALICIOUS_TOKEN','MALICIOUS_ADAPTER','MALICIOUS_TOKEN_OR_ADAPTER',
   'MALICIOUS_CALLBACK','MEV','MEV_SEARCHER','CARELESS_ADMIN','ADMIN',
   'PRIVILEGED','PRIVILEGED_ROLE'],
  conditionals:{viableOrUncertain:'REQUIRES_AI_AUTHORED_CANDIDATE_AND_SIMULATION_IDEA',
   blocked:'REQUIRES_SOURCE_ANCHORED_BLOCKING_CONTROL'}
 }));
 return {schemaVersion:ANSWER_BINDING_VERSION,phaseSequence:4,step:0,unitKind:u.kind,
  unitId:u.unitId,submissionSchemaVersion:initial.schemaVersion,
  outputRoot:'DIRECT_DISCOVERY_SUBMISSION_NOT_ACTIONS_STEP_ZERO',
  actualInputFormat:u.kind==='FLOW'?'curveyield-flow-review-submission-v1':
   'curveyield-attack-submission-v1',
  fixedRecordKeys:[
   {field:flow?'rows':'attackPaths',countPolicy:flow?'EACH_CONTEXT_ROW_OR_ELIGIBLE_TRIVIAL_REVIEW':
     'ISSUED_FLOW_COVERAGE_PLUS_AI_DISCOVERED_PATHS',
    sourceSelector:flow?'packet.payload.primaryContextIds':'packet.payload.flowIds',
    records:flow?rowRecords:attack},
   {field:'integrationAnswers',countPolicy:'EXACT_ISSUED_OBLIGATIONS',
    sourceSelector:'packet.payload.integrationQuestionIds',
    records:requiredQuestions.map((key,i)=>({recordIndex:i,
     destination:'integrationAnswers['+i+']',keyField:'obligationId',key,
     allowedAssessment:['SUPPORTED','CONCERN','UNRESOLVED','NOT_APPLICABLE']}))},
   ...(flow?[
    {field:'flowNotes',countPolicy:'EXACT_ISSUED_FLOWS',
     sourceSelector:'packet.payload.flowIds',records:requiredFlows.map((key,i)=>({
       recordIndex:i,destination:'flowNotes['+i+']',keyField:'flowId',key}))},
    {field:'contractChecks',countPolicy:'EXACT_ISSUED_CONTRACT_CLASSES',
     sourceSelector:'packet.payload.contractChecks',
     records:checks.map((row,i)=>({recordIndex:i,
      destination:'contractChecks['+i+']',keyFields:['contract','classId'],
      key:{contract:row.contract,classId:row.classId},
      allowedAssessment:['SUPPORTED','CONCERN','UNRESOLVED','NOT_APPLICABLE'],
      prefilledApplicability:'AI_EXACT_CHOICE_FROM_PACKET_EVIDENCE'}))}
   ]:[])
  ],
  optionalRecords:flow?[
   {field:'trivialReviews',countPolicy:'ONLY_IF_PACKET_ELIGIBLE_LITERAL_CONSTANT',
    eligibleContextIds:[...eligibleLiteralTrivial],
    substitution:'MAY_REMOVE_MATCHING_ROW_ONLY_WHEN_SOURCE_VALIDATOR_ACCEPTS_TRIVIAL_REVIEW'},
   {field:'candidates',countPolicy:'AI_CHOSEN_DISTINCT_CANDIDATES',
    requiredTypedFields:['title','description','anchors','classId','severity'],
    severityChoices:['CRITICAL','HIGH','MEDIUM','LOW','INFO','INFORMATIONAL']},
   {field:'groupChecks',countPolicy:'ONLY_IF_SOURCE_VERIFIED_SHARED_MODIFIER'}
  ]:[
   {field:'attackPaths',countPolicy:'AI_APPEND_DISTINCT_PATHS',
    preserveBaselineFlowCoverage:true},
   {field:'integrationAnswers[*].candidate',countPolicy:'AI_CHOSEN_IF_CONCERN',
    requiredTypedFields:['title','description','anchors']}
  ],
  emptyHandling:'PRESERVE_EMPTY_OPTIONAL_ARRAYS_IF_NO_REAL_SUBJECT',
  sourceEvidenceRequired:true,selectionByAIOnly:true
 };
}

function buildUnitMeta(c,u,schema){
  const index=u.packetIndexPath?readUnitPacketIndexV1({root:ROOT,indexPath:safePath(u.packetIndexPath)}):null;
  const discoveryPacket=['FLOW','ATTACK'].includes(u.kind)?readUnitPacketV1({root:ROOT,packetPath:safePath(u.packetPath)}):null;
  if(discoveryPacket)strict(discoveryPacket.payload?.unitId===u.unitId,'discovery packet identity mismatch');
  let initial,inputSchema;
  if(u.kind==='FLOW'){
    const ids=index?.primaryContextIds||[];
    initial={schemaVersion:'curveyield-flow-review-submission-v1',unitId:u.unitId,
      rows:ids.map(contextId=>({contextId,verdict:'<REQUIRED_CORRECT_DEFECT_OR_UNRESOLVED>',
        intent:'<REQUIRED>',reason:'<REQUIRED>',anchors:[],
        specInspection:{status:'<REQUIRED>',docsAndCommentsChecked:'<REQUIRED>',namedConstantsChecked:'<REQUIRED>'},
        documentedRules:(discoveryPacket?.payload?.documentationItems??[])
         .filter(rule=>rule.contextId===contextId)
         .map(rule=>({ruleId:rule.ruleId,rule:rule.rule,comparison:'<REQUIRED>',reason:'<REQUIRED>'})),
        siblingComparisons:(discoveryPacket?.payload?.siblingChecks??[])
         .filter(group=>(group.members??[]).some(m=>m.contextId===contextId&&m.function===group.signature))
         .flatMap(group=>{
          const others=(group.members??[]).filter(m=>m.contextId!==contextId);
          return (others.length?others:group.members).map(counterpart=>({
           siblingContextId:counterpart.contextId,signature:group.signature,
           comparison:'<REQUIRED>'}));
         })})),
      flowNotes:(index?.flowIds||[]).map(flowId=>({flowId,note:'<REQUIRED>',anchors:[]})),
      integrationAnswers:(index?.integrationQuestionIds||[]).map(obligationId=>({obligationId,assessment:'<REQUIRED>',reasoning:'<REQUIRED>',anchors:[]})),
      contractChecks:(discoveryPacket?.payload?.contractChecks??[]).map(row=>({
       contract:row.contract,classId:row.classId,assessment:'<REQUIRED>',
       applicability:'<REQUIRED>',evidence:'<REQUIRED>',anchors:[]})),
      trivialReviews:[],groupChecks:[],candidates:[]};
    inputSchema={type:'object',required:['schemaVersion','unitId','rows'],
      properties:{schemaVersion:{type:'string',enum:['curveyield-flow-review-submission-v1']},
        unitId:{type:'string',enum:[u.unitId]},rows:{type:'array',minItems:0,maxItems:ids.length},
        trivialReviews:{type:'array'},groupChecks:{type:'array'},
        flowNotes:{type:'array'},integrationAnswers:{type:'array'},contractChecks:{type:'array'},candidates:{type:'array'}}};
  }else if(u.kind==='ATTACK'){
    initial={schemaVersion:'curveyield-attack-submission-v1',unitId:u.unitId,
      attackPaths:(index?.flowIds||[]).map((flowId,i)=>({pathId:'PATH-'+String(i+1).padStart(3,'0'),
        flowIds:[flowId],goal:'<REQUIRED>',role:'<REQUIRED_VALID_ATTACK_ROLE>',
        steps:['<REQUIRED>'],anchors:[],result:'<REQUIRED_BLOCKED_VIABLE_OR_UNCERTAIN>',
        blockingControl:'<REQUIRED_IF_BLOCKED>',simulationIdea:{transactionSequence:['<REQUIRED_IF_VIABLE>'],oracle:'<REQUIRED_IF_VIABLE>'}})),
      integrationAnswers:(index?.integrationQuestionIds||[]).map(obligationId=>({obligationId,assessment:'<REQUIRED>',reasoning:'<REQUIRED>',anchors:[]}))};
    inputSchema={type:'object',required:['schemaVersion','unitId','attackPaths','integrationAnswers'],
      properties:{schemaVersion:{type:'string',enum:['curveyield-attack-submission-v1']},
        unitId:{type:'string',enum:[u.unitId]},attackPaths:{type:'array',minItems:(index?.flowIds?.length??0)>0?1:0},integrationAnswers:{type:'array'}}};
  }else{
    initial={schemaVersion:'curveyield-lite-solo-unit-submission-v1',
      entries:u.kind==='APPEND'?[]:(u.kind==='BATCH'?u.members:[u]).map(m=>({key:m.recordKeys?.[0],value:m.initialValue}))};
    inputSchema={type:'object',required:['schemaVersion','entries'],
      properties:{schemaVersion:{type:'string',enum:['curveyield-lite-solo-unit-submission-v1']},
        entries:{type:'array',minItems:u.kind==='APPEND'?0:1,maxItems:1024}}};
  }
  const packetPath=u.packetPath||u.shardPath;
  strict(packetPath&&safePath(packetPath).startsWith(c.campaignPath+'/'),'unit packet path outside campaign');
  const packetSha256=u.packetSha256||sha(fs.readFileSync(relative(packetPath)));
  const answerRouting=discoveryPacket
   ?discoveryAnswerBindingV1({u,packet:discoveryPacket,initial})
   :semanticAnswerBindingV1({c,u,schema,initial});
  const answerTransport=machineAnswerDirectoryV1(u,initial,answerRouting);
  return {unitId:u.unitId,kind:u.kind,step:0,stage:'',unitSpecRevision:u.unitSpecRevision,
    packetPath,packetSha256,packetIndexPath:u.packetIndexPath||null,recordKeys:u.recordKeys||[],
    dependencies:u.dependencies||[],path:u.path,members:u.members,field:u.field,
    inputTemplate:initial,validationSchema:inputSchema,answerRouting,answerTransport,
    templateSha256:sha(JSON.stringify(initial)),schemaSha256:sha(JSON.stringify(inputSchema)),
    supportingFileRequirements:assignedExecutionSupport(c,u),evidenceRefs:u.packetIndexPath?[u.packetIndexPath]:[]};
}
async function unitNextStep(c){
  const phase=Number(need('phase')),step=Number(need('step'));
  assertAssigned(c,phase);
  const {plan,queue,units,planRel,queueRel}=unitPlan(c);
  strict(phase===plan.phaseSequence&&plan.phaseEpoch===queue.phaseEpoch,'wrong controller phase epoch');
  const stage=step===0?(String(payload.stage||'').includes('ATTACK')?'ATTACK_REVIEW':'FLOW_REVIEW'):
    step===1?'STEP_1':step===2?'STEP_2':step===3?'STEP_3':step===4?'STEP_4':'STEP_5';
  const schema=loadPhaseSchema(ROOT,AUTH,phase).schema;
  const eligible=units.filter(u=>{
    const family=step===0?(stage==='FLOW_REVIEW'?'FLOW':'ATTACK'):null;
    const sameStep=step===0?u.kind===family:
       (u.kind==='BATCH'?schema.actions['step-'+step]?.fields?.some(f=>f.name===u.field):
         u.path?.[1]==='step-'+step);
    return sameStep&&['AVAILABLE','RELEASED','REWORK_REQUIRED'].includes(queue.units?.[u.unitId]?.status)&&
      (u.dependencies||[]).every(dep=>(queue.acceptedRecords?.[dep]?.status==='ACCEPTED'&&!!queue.acceptedRecords[dep].snapshotSha256)||
        (queue.units?.[dep]?.status==='ACCEPTED'&&!!queue.units[dep].acceptedPath&&!!queue.units[dep].acceptedSha256));
  });
  strict(eligible.length>0,'no eligible units in current controller stage; do not invent work');
  const roster=eligible.map(u=>{const x=buildUnitMeta(c,u,schema);x.step=step;x.stage=stage;return x;});
  const rosterDigest=sha(JSON.stringify(roster));
  const planSha256=sha(fs.readFileSync(relative(planRel)));
  const queueSha256=sha(fs.readFileSync(relative(queueRel)));
  const pageLimit=10,pageCount=Math.ceil(roster.length/pageLimit);
  strict(pageCount<=1000,'unit roster pagination limit exceeded');
  for(let i=0;i<pageCount;i++){
    const slice=roster.slice(i*pageLimit,(i+1)*pageLimit);
    await callback('/fork/roster-page',{campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
      phase,step,stage,authorityDigest:c.directory.authorityDigest,sourceSha256:c.directory.sourceSha256,
      planSha256,queueSha256,phaseEpoch:plan.phaseEpoch,rosterDigest,rosterCount:roster.length,
      pageCount,pageIndex:i,pageSha256:sha(JSON.stringify(slice)),units:slice});
  }
}


function unitRelevant(u,phase,step,stage,schema){
  if(step===0)return phase===4&&u.kind===(stage==='ATTACK_REVIEW'?'ATTACK':'FLOW');
  if(u.kind==='BATCH')return (schema.actions['step-'+step]?.fields||[]).some(f=>f.name===u.field);
  return u.path?.[1]==='step-'+step;
}
// Preserve the Phase-6 proof prerequisite ordering without blocking empty stages.
function orderedMachineStagesV1(phase){
 const steps=phase===6?[1,2,4,5,3]:[1,2,3];
 return [...(phase===4?[{step:0,stage:'FLOW_REVIEW'},{step:0,stage:'ATTACK_REVIEW'}]:[]),
  ...steps.map(step=>({step,stage:'STEP_'+step}))];
}
function stageUnitsV1(c,source,phase,step,stage){
 const schema=loadPhaseSchema(ROOT,AUTH,phase).schema;
 return source.units.filter(u=>unitRelevant(u,phase,step,stage,schema));
}
function stageAcceptedV1(source,u){
 const state=source.queue.units?.[u.unitId];
 if(state?.status!=='ACCEPTED'||typeof state.acceptedPath!=='string'||
    !/^[a-f0-9]{64}$/.test(String(state.acceptedSha256??'')))return false;
 const expectedRoot=source.plan.campaignPath+'/work/phase-'+
  phaseNo(source.plan.phaseSequence)+'/units/'+u.unitId+'/';
 if(!state.acceptedPath.startsWith(expectedRoot))return false;
 try{
  const record=read(state.acceptedPath);
  return record?.unitId===u.unitId&&
   record.campaignGenerationId===source.plan.campaignGenerationId&&
   record.sourceSha256===source.plan.sourceSha256&&
   record.authorityDigest===source.plan.authorityDigest&&
   record.phaseSequence===source.plan.phaseSequence&&
   record.phaseEpoch===source.plan.phaseEpoch&&
   record.submissionSha256===state.acceptedSha256;
 }catch{return false;}
}
function eligibleStage(c,source,phase,step,stage){
 // The adapter decides prerequisites; GitHub only sorts unfiled units by stage.
 const schema=loadPhaseSchema(ROOT,AUTH,phase).schema;
 return source.units.filter(u=>unitRelevant(u,phase,step,stage,schema)&&
  ['AVAILABLE','RELEASED','REWORK_REQUIRED'].includes(source.queue.units?.[u.unitId]?.status));
}
function stageDigest(c,source,phase,step,stage){
  return sha(JSON.stringify(eligibleStage(c,source,phase,step,stage).map(u=>{
    const x=buildUnitMeta(c,u,loadPhaseSchema(ROOT,AUTH,phase).schema);
    x.step=step;x.stage=stage;return x;
  })));
}
function submittedUnitFile(c,phase,u,item={}){
 const unitRoot=relative(c.campaignPath+'/work/phase-'+phaseNo(phase)+'/units/'+u.unitId+'/submissions');
 strict(fs.existsSync(unitRoot),'missing Worker-filed submission for '+u.unitId);
 const options=[];
 for(const worker of fs.readdirSync(unitRoot)){
  strict(/^cfw-[A-Za-z0-9_.-]{1,135}$/.test(worker),'unrecognized Worker submission owner');
  const epochs=path.join(unitRoot,worker);
  if(!fs.statSync(epochs).isDirectory())continue;
  for(const entry of fs.readdirSync(epochs)){
   if(!/^epoch-[1-9][0-9]*$/.test(entry))continue;
   const epoch=Number(entry.slice(6));
   if(!Number.isSafeInteger(epoch))continue;
   const dir=path.join(epochs,entry);
   if(!fs.statSync(dir).isDirectory())continue;
   for(const filename of fs.readdirSync(dir)){
    if(!/^SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(filename))continue;
    const attempt=Number(filename.match(/[0-9]{3,6}/)[0]);
    if(Number.isSafeInteger(item.attempt)&&item.attempt!==attempt)continue;
    if(Number.isSafeInteger(item.claim_epoch)&&item.claim_epoch!==epoch)continue;
    const full=path.join(dir,filename);
    options.push({workerId:worker,epoch,attempt,filename:full,rel:path.posix.relative(ROOT,full)});
   }
  }
 }
 options.sort((a,b)=>b.epoch-a.epoch||b.attempt-a.attempt);
 strict(options.length&&(!options[1]||
   options[0].epoch!==options[1].epoch||options[0].attempt!==options[1].attempt),
   'missing or ambiguous requested Worker submission: '+u.unitId);
 return options[0];
}

/**
 * Validate one Worker-published unit against the SAME canonical controller
 * validator used by the original wave. No other unit is claimed or modified.
 * Worker leases remain independent, so the agent can claim its next packet.
 */
async function materializePhase5Request(c,u,submitted){
 if(Number(c.directory.currentAssignment.phaseSequence)!==5||u.field!=='targetDesigns')return;
 const candidates=Array.isArray(submitted?.entries)?submitted.entries:[];
 const phase0Source={...read(c.campaignPath+'/receipts/PHASE_00_RECEIPT_v1.json').source};
 const manifestRel=c.campaignPath+'/evidence/phase0/PHASE0_FORK_STATE_MANIFEST_v1.json';
 if(fs.existsSync(relative(manifestRel))){
   try{
     const manifest=read(manifestRel);
     const validated=await verifyPhase0ForkStateV1({root:relative(c.campaignPath+'/evidence/phase0'),manifest});
     if(validated!==false&&manifest.sourceSha256===c.directory.sourceSha256&&manifest.campaignId===c.directory.campaignId)
       phase0Source.reusableForkState={...manifest,manifestRef:manifestRel};
   }catch{phase0Source.reusableForkState={status:'INVALID'};}
 }
 for(const entry of candidates){
   const target=entry?.value;
   if(target?.executionMethod!=='V7_REQUEST')continue;
   const name=safeId(String(target.candidateKey||'').replace(/[^A-Za-z0-9._-]/g,'_'));
   const rel=c.campaignPath+'/work/phase-05/execution-requests/'+name+'.json';
   if(fs.existsSync(relative(rel)))continue; // Existing immutable requests are validator-owned.
   const generated=generateV7ExecutionRequestV1({campaignId:c.directory.campaignId,
     sourceSha256:c.directory.sourceSha256,phase0Source,target,automationRoot:process.cwd()});
   if(generated.status!=='GENERATED')continue; // Controller returns existing named rework.
   fs.mkdirSync(path.dirname(relative(rel)),{recursive:true});
   writeJson(relative(rel),generated.request);
   const evidence=c.campaignPath+'/work/phase-05/execution-requests/'+name+'.design-v1.json';
   writeJson(relative(evidence),{schemaVersion:'curveyield-phase5-machine-design-v1',
     campaignId:c.directory.campaignId,sourceSha256:c.directory.sourceSha256,
     candidateKey:target.candidateKey,requestDigest:generated.request.requestDigest,...generated.designEvidence});
 }
}
// GitHub-side literal answer assembler. This is optional: existing full JSON
// submissions are unchanged. No Worker change or Actions-per-question trigger.
const MACHINE_BOUND_ANSWERS_V1='curveyield-machine-bound-answers-v1';
const answerBindingId=(collection,subject,field)=>JSON.stringify([collection,subject,field]);
const subjectOf=(field,row)=>field==='rows'?row.contextId:
 field==='flowNotes'?row.flowId:
 field==='integrationAnswers'?row.obligationId:
 field==='contractChecks'?JSON.stringify([row.contract,row.classId]):
 field==='attackPaths'?row.pathId:null;
const allocatedRecordId=(phase,unit,field,number)=>
 'MI-'+String(phase).padStart(2,'0')+'-'+unit+'-'+
 String(field).replace(/[^A-Za-z0-9_-]/g,'_')+'-'+String(number).padStart(4,'0');
function preserveDiscoveryKeys(original,response,field){
 if(!Array.isArray(original)||!Array.isArray(response))return original;
 if(field==='documentedRules'){
  const byId=new Map(response.filter(x=>x&&typeof x.ruleId==='string').map(x=>[x.ruleId,x]));
  return original.map(x=>{const y=byId.get(x.ruleId);return y?{...x,
   comparison:y.comparison??x.comparison,reason:y.reason??x.reason}:x;});
 }
 if(field==='siblingComparisons'){
  const byId=new Map(response.filter(x=>x&&x.signature&&x.siblingContextId)
   .map(x=>[JSON.stringify([x.signature,x.siblingContextId]),x]));
  return original.map(x=>{const y=byId.get(JSON.stringify([x.signature,x.siblingContextId]));
   return y?{...x,comparison:y.comparison??x.comparison}:x;});
 }
 return original;
}
// Exact binding IDs are issued with the existing GitHub-side work packet;
// neither the AI nor Cloudflare chooses a destination or a record identity.
// Purely mechanical input-type checking. Security conclusions and exact enum
// choices are written by the AI; the controller never chooses a verdict.
function machineAnswerExpectedTypeV1(field,initialKind,sourceType){
 const arrays=new Set(['anchors','steps','documentedRules','siblingComparisons','candidates',
  'evidenceRefs','executionEvidenceRefs','relatedCandidateKeys','relatedRequirementKeys',
  'relatedHypothesisKeys','attackAssertionNames','controlAssertionNames','obligationIds',
  'contextIds','flowIds','prerequisites','transactionSequence','fuzzVariablesAndBounds',
  'requestPaths','obligationOutcomes','limitations','obligationsDetail']);
 if(arrays.has(field))return 'array';
 if(['specInspection','candidate','decidingTest','simulationIdea','executionBlueprint'].includes(field))
  return 'object';
 // The enclosing record is an OBJECT; that does NOT make its text fields
 // objects. Types unknown to the issuer remain schema-declared, not guessed.
 if(initialKind==='ARRAY')return 'array';
 if(sourceType==='LITERAL_TOKEN_ONLY')return 'string';
 return 'SCHEMA_DECLARED';
}
function checkMachineAnswerLiteralV1(spec,value){
 strict(spec&&spec.source==='AI_TYPED_LITERAL','field must be issued by the controller');
 if(Array.isArray(spec.allowedValues)&&spec.allowedValues.length)
  strict(typeof value==='string'&&spec.allowedValues.includes(value),
   'AI typed answer must be one exact issued enumeration for '+spec.field);
 if(value===null){
  strict(['candidate','decidingTest','simulationIdea','candidates'].includes(spec.field),
   'null only permitted for a genuinely absent optional security result: '+spec.field);
  return;
 }
 if(spec.expectedJsonType==='array'||spec.expectedJsonType==='string-array')
  strict(Array.isArray(value),'AI answer must supply typed array for '+spec.field);
 if(spec.expectedJsonType==='string-array')
  strict(value.every(item=>typeof item==='string'),
   'list records must contain literal string elements, never nested arrays');
 if(spec.expectedJsonType==='object')strict(value!==null&&typeof value==='object'&&
  !Array.isArray(value),'AI answer must supply typed object for '+spec.field);
 if(spec.expectedJsonType==='string')strict(typeof value==='string',
  'AI answer must supply one exact literal string for '+spec.field);
 if(spec.field==='specInspection')
  strict(value&&typeof value==='object'&&!Array.isArray(value)&&
   ['MATCH','MISMATCH','UNRESOLVED','NO_DOCUMENTED_RULES'].includes(value.status)&&
   typeof value.docsAndCommentsChecked==='string'&&value.docsAndCommentsChecked.trim()&&
   typeof value.namedConstantsChecked==='string'&&value.namedConstantsChecked.trim(),
   'specInspection requires status, documented checks and named-constant review');
 if(spec.field==='documentedRules')
  strict(Array.isArray(value)&&value.every(rule=>rule&&typeof rule==='object'&&
   !Array.isArray(rule)&&typeof rule.ruleId==='string'&&rule.ruleId.trim()&&
   typeof rule.rule==='string'&&rule.rule.trim()&&
   ['MATCH','MISMATCH','UNRESOLVED'].includes(rule.comparison)&&
   typeof rule.reason==='string'&&rule.reason.trim()),
   'documentedRules require exact source rule, allowed comparison and reason');
 if(spec.field==='siblingComparisons')
  strict(Array.isArray(value)&&value.every(row=>row&&typeof row==='object'&&
   !Array.isArray(row)&&typeof row.siblingContextId==='string'&&row.siblingContextId.trim()&&
   typeof row.signature==='string'&&row.signature.trim()&&
   typeof row.comparison==='string'&&row.comparison.trim()),
   'siblingComparisons require exact identity, signature and comparison');
 if(spec.field==='candidate'||spec.field==='candidates'){
  const [collection]=JSON.parse(spec.bindingId);
  const candidates=Array.isArray(value)?value:[value];
  const requireClassification=collection==='rows'||spec.field==='candidates';
  for(const candidate of candidates){
   strict(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)&&
    typeof candidate.title==='string'&&candidate.title.trim()&&
    typeof candidate.description==='string'&&candidate.description.trim()&&
    Array.isArray(candidate.anchors)&&candidate.anchors.length>0&&
    candidate.anchors.every(x=>typeof x==='string'&&x.trim()),
    'candidate must have title, description and actual source anchors');
   if(requireClassification)
    strict(typeof candidate.classId==='string'&&candidate.classId.trim()&&
     ['CRITICAL','HIGH','MEDIUM','LOW','INFO','INFORMATIONAL'].includes(candidate.severity),
     'function-wide V13 discovery candidates need exact class and severity');
   else if(candidate.severity!==undefined)
    strict(['CRITICAL','HIGH','MEDIUM','LOW','INFO','INFORMATIONAL'].includes(candidate.severity),
     'optional candidate severity must be an issued literal token');
  }
 }
}

function checkExtraDiscoveryRecordsV1(field,records,route){
 strict(Array.isArray(records),field+' must be an array of typed records');
 const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 const nonempty=v=>typeof v==='string'&&Boolean(v.trim());
 const anchors=v=>Array.isArray(v)&&v.length>0&&v.every(nonempty);
 const roles=new Set(route?.fixedRecordKeys?.find(x=>x.field==='attackPaths')
  ?.records?.flatMap(x=>x.allowedRole??[])??[]);
 for(const row of records){
  strict(obj(row),'discovery '+field+' must contain objects, not literals');
  if(field==='trivialReviews')
   strict(nonempty(row.contract)&&
    ['SUPPORTED','CONCERN','UNRESOLVED','NOT_APPLICABLE'].includes(row.assessment)&&
    nonempty(row.evidence)&&anchors(row.anchors),
    'trivialReviews need contract, assessment, evidence and typed source anchors');
  else if(field==='groupChecks')
   strict(Array.isArray(row.contextIds)&&row.contextIds.every(nonempty)&&
    nonempty(row.classId)&&
    ['SUPPORTED','CONCERN','UNRESOLVED','NOT_APPLICABLE'].includes(row.assessment)&&
    nonempty(row.evidence)&&anchors(row.anchors),
    'groupChecks need context identities, class, assessment and source evidence');
  else if(field==='candidates')
   strict(nonempty(row.title)&&nonempty(row.description)&&
    nonempty(row.classId)&&
    ['CRITICAL','HIGH','MEDIUM','LOW','INFO','INFORMATIONAL'].includes(row.severity)&&
    anchors(row.anchors),
    'discovery candidates need title, description, class, severity and typed anchors');
  else if(field==='attackPaths')
   strict(Array.isArray(row.flowIds)&&row.flowIds.every(nonempty)&&
    ['BLOCKED','VIABLE','UNCERTAIN'].includes(row.result)&&
    roles.has(row.role),
    'additional attackPaths need flow IDs, result and actor role');
 }
}
function machineAnswerDirectoryV1(u,template,routing){
 const fields=[],id=(a,b,c)=>JSON.stringify([a,b,c]);
 const push=(collection,subject,field,type,choices)=>{
  fields.push({bindingId:id(collection,subject,field),field,source:'AI_TYPED_LITERAL',
    expectedJsonType:type,controllerBoundIdentity:subject,
    ...(choices?{allowedValues:choices}:{})});
 };
 if(['SHARD','BATCH'].includes(u.kind)){
  for(const entry of routing.entries){
   if(entry.valueKind!=='OBJECT')
    push('entries',entry.entryKey,'$value',
     routing.scalarAnswer?.elementJsonType==='string'
      ?(entry.valueKind==='ARRAY'?'string-array':'string')
      :(routing.scalarAnswer?.requiredArray?'array':'ISSUED_FIELD_TYPE'),
     routing.scalarAnswer?.allowedValues??null);
   else for(const b of entry.bindings){
    if(['AI_SECURITY_ANSWER','AI_EXACT_ENUM','AI_EXACT_SOURCE_BOUND_REFERENCES',
      'BIND_EXISTING_CONTROLLER_SUBJECT'].includes(b.source))
     push('entries',entry.entryKey,b.field,b.allowedValues?.length?'string':
      machineAnswerExpectedTypeV1(b.field,entry.valueKind,b.answerMode),b.allowedValues??null);
   }
  }
 }else if(['FLOW','ATTACK'].includes(u.kind)){
  const conditional={rows:['candidate','candidates','decidingTest'],
   integrationAnswers:['candidate'],contractChecks:['candidate'],attackPaths:['candidate']};
  for(const [collection,records] of Object.entries(template)){
   if(!['rows','flowNotes','integrationAnswers','contractChecks','attackPaths'].includes(collection)||
      !Array.isArray(records))continue;
   for(const row of records){
    const subject=subjectOf(collection,row);
    if(!subject)continue;
    for(const field of new Set([...Object.keys(row),...(conditional[collection]??[])])){
     if(['contextId','flowId','obligationId','contract','classId','pathId'].includes(field))continue;
     const choices=field==='verdict'?['CORRECT','DEFECT','UNRESOLVED']:
      field==='result'?['BLOCKED','VIABLE','UNCERTAIN']:
      field==='assessment'?['SUPPORTED','CONCERN','UNRESOLVED','NOT_APPLICABLE']:
      field==='applicability'?['APPLICABLE','NOT_APPLICABLE']:
      field==='role'?['UNPRIVILEGED','UNPRIVILEGED_CALLER','OTHER_ROLE','DIFFERENT_ROLE',
       'MALICIOUS_TOKEN','MALICIOUS_ADAPTER','MALICIOUS_TOKEN_OR_ADAPTER',
       'MALICIOUS_CALLBACK','MEV','MEV_SEARCHER','CARELESS_ADMIN','ADMIN',
       'PRIVILEGED','PRIVILEGED_ROLE']:null;
     push(collection,subject,field,choices?'string':
       machineAnswerExpectedTypeV1(field,Array.isArray(row[field])?'ARRAY':
        row[field]&&typeof row[field]==='object'?'OBJECT':'SCALAR',
        'SCHEMA_DECLARED'),choices);
    }
   }
  }
 }
 return {schemaVersion:'curveyield-machine-bound-answer-transport-v1',
  responseSchemaVersion:MACHINE_BOUND_ANSWERS_V1,unitId:u.unitId,fields,
  appendFormat:u.kind==='APPEND'?'appendRecords: EXACT_TYPED_OBJECT_ARRAY':null,
  extraCollections:u.kind==='FLOW'?['trivialReviews','groupChecks','candidates']:
   u.kind==='ATTACK'?['attackPaths']:[],
  immutableControllerFields:true,neverInferFromProse:true,noActionsPerQuestion:true};
}

// Only exact keys present in controller-bound predecessor data or ACCEPTED
// same-phase records qualify as references to existing audit subjects.
function controllerAcceptedSubjectIdsV1(c){
 const out=new Set(),paths=new Set(),phase=Number(c.directory.currentAssignment.phaseSequence);
 for(let n=1;n<phase;n++){
  const nn=String(n).padStart(2,'0');
  paths.add(path.posix.join(c.campaignPath,'derived/phase-'+n,'PHASE_'+nn+'_CANONICAL_DATA_v1.json'));
 }
 if(phase>=4)
  paths.add(path.posix.join(c.campaignPath,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json'));
 for(const rel of (c.directory.currentAssignment.derivedInputPaths??[]))
  if(typeof rel==='string'&&rel.startsWith(c.campaignPath+'/'))paths.add(rel);
 if([4,5,6].includes(phase)){
  const current=unitPlan(c);
  for(const record of Object.values(current.queue.units??{}))
   if(record?.status==='ACCEPTED'&&typeof record.acceptedPath==='string'&&
      record.acceptedPath.startsWith(c.campaignPath+'/'))paths.add(record.acceptedPath);
 }
 const keyNames=new Set(['tempKey','candidateKey','canonicalId','findingKey',
  'obligationId','subjectKey','recordKey','groupKey','requirementKey','id',
  'nodeId','candidateTempKeyOrNone']);
 let visited=0;
 for(const rel of paths){
  let data;
  try{if(!fs.existsSync(relative(rel)))continue;data=read(rel);}
  catch{continue;}
  const pending=[data];
  while(pending.length&&visited++<150000){
   const item=pending.pop();
   if(!item||typeof item!=='object')continue;
   if(Array.isArray(item)){for(const v of item)if(v&&typeof v==='object')pending.push(v);continue;}
   for(const [k,v] of Object.entries(item)){
    if(keyNames.has(k)&&typeof v==='string'&&v.trim()&&
       !v.startsWith('<')&&!EXPLICIT_NEGATIVES.has(v)&&!/^NO_/.test(v))
     out.add(v);
    else if(v&&typeof v==='object')pending.push(v);
   }
  }
 }
 return out;
}
function bindExistingSubjectV1(ids,field,value){
 if(value===undefined||value===null||isPendingAnswerValue(value))return false;
 strict(typeof value==='string'&&ids.has(value),
  'new '+field+' must resolve to exact accepted controller subject identity');
 return true;
}

function assembleBoundAnswersV1(c,u,submitted){
 strict(submitted?.schemaVersion===MACHINE_BOUND_ANSWERS_V1&&submitted.unitId===u.unitId,
  'bound answer packet does not match the issued unit');
 const phase=Number(c.directory.currentAssignment.phaseSequence);
 const schema=loadPhaseSchema(ROOT,AUTH,phase).schema;
 const meta=buildUnitMeta(c,u,schema),route=meta.answerRouting;
 const answers=new Map(),issued=new Map(meta.answerTransport.fields.map(f=>[f.bindingId,f]));
 strict(submitted.answers===undefined||Array.isArray(submitted.answers),
  'bound answers must be an array of exact issued field values');
 for(const a of (submitted.answers??[])){
  strict(a&&typeof a.bindingId==='string'&&Object.hasOwn(a,'value')&&
   !answers.has(a.bindingId),'malformed or duplicate field answer');
  const spec=issued.get(a.bindingId);
  checkMachineAnswerLiteralV1(spec,a.value);
  answers.set(a.bindingId,a.value);
 }
 const get=(collection,subject,field)=>{
  const id=answerBindingId(collection,subject,field);
  return answers.has(id)?{found:true,value:answers.get(id)}:{found:false};
 };
 const result=structuredClone(meta.inputTemplate);
 const knownSubjectIds=controllerAcceptedSubjectIdsV1(c);
 let candidateOrdinal=0;
 const candidateWithId=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const candidate=structuredClone(value);
  candidate.tempKey=allocatedRecordId(phase,u.unitId,'candidate',++candidateOrdinal);
  return candidate;
 };
 if(u.kind==='SHARD'||u.kind==='BATCH'){
  for(const [i,entry] of route.entries.entries()){
   const target=result.entries[i];
   strict(target?.key===entry.entryKey,'original controller record key changed');
   if(entry.valueKind==='OBJECT'){
    for(const spec of entry.bindings){
     const field=spec.field;
     if(['CONTROLLER_VERIFIED_EXECUTION','CONTROLLER_COLLECT_AFTER_EXECUTION'].includes(spec.source))
      continue;
     if(spec.source==='PRESERVE_ISSUED_VALUE')continue;
     if(spec.source==='BIND_EXISTING_CONTROLLER_SUBJECT'){
      const a=get('entries',entry.entryKey,field);
      if(a.found){
       if(target.value?.[field]!==undefined&&!isPendingAnswerValue(target.value[field]))
        strict(target.value[field]===a.value,'issued subject identity is immutable');
       else{
        bindExistingSubjectV1(knownSubjectIds,field,a.value);
        target.value=target.value??{};target.value[field]=a.value;
       }
      }
      continue;
     }
     if(spec.source==='ALLOCATE_MECHANICALLY_IF_NEW'){
      if(isPendingAnswerValue(target.value[field])||target.value[field]===undefined)
       target.value[field]=allocatedRecordId(phase,u.unitId,field,i+1);
     }else{
      const a=get('entries',entry.entryKey,field);
      if(a.found)target.value[field]=structuredClone(a.value);
     }
    }
    // Resolve proof fields only after AI-authored subject bindings have been applied.
    for(const spec of entry.bindings){
     if(!['CONTROLLER_VERIFIED_EXECUTION','CONTROLLER_COLLECT_AFTER_EXECUTION'].includes(spec.source))continue;
     const field=spec.field,verified=machineVerifiedValueV1(c,target.value,field);
     target.value[field]=verified&&Object.hasOwn(verified,'value')?
      structuredClone(verified.value):unresolvedMachineFieldV1(field,target.value[field]);
    }
   }else{
    const a=get('entries',entry.entryKey,'$value');
    if(a.found&&!route.controllerOwnedOutput&&entry.issuedNegativeSentinel===undefined&&
       entry.issuedEmptyArray!==true)
     target.value=structuredClone(a.value);
   }
  }
 }else if(u.kind==='APPEND'){
  strict(Object.hasOwn(submitted,'appendRecords')&&Array.isArray(submitted.appendRecords),
   'APPEND must explicitly supply typed appendRecords, including [] when no records exist');
  const rows=submitted.appendRecords;
  strict(rows.length<=route.appendMaximumRecords,'append exceeds existing controller capacity');
  const fieldDef=schema.actions[route.step]?.fields?.find(x=>x.name===route.field);
  const keyRoot=JSON.stringify(u.path)+':APPEND-';
  result.entries=rows.map((input,i)=>{
   const key=keyRoot+String(i+1).padStart(4,'0');
   // Original REQUIRED_LIST append slots contain literal scalars; record-list
   // append slots contain fully typed objects, including optional audit fields.
   if(fieldDef?.type==='REQUIRED_LIST'){
    strict(typeof input==='string','REQUIRED_LIST APPEND item must be a literal string');
    return {key,value:input};
   }
   strict(input&&typeof input==='object'&&!Array.isArray(input),'append record is not a typed object');
   const value=structuredClone(input);
   // APPEND applies the same field ownership policy as fixed issued records.
   // Unissued controller/machine fields cannot be smuggled in as optional data.
   const policies=new Map(route.recordFieldTemplate.map(spec=>[spec.field,spec]));
   const reserved=new Set([...MECHANICAL_ID_FIELDS,...MACHINE_EXECUTION_FIELDS.keys(),
    ...route.controllerCollectedBindings.map(spec=>spec.field),
    ...(fieldDef?.controllerCollectedFields??[]),
    ...(schema.actions[route.step]?.controllerCollectedFields??[])]);
   for(const field of Object.keys(value))
    if(reserved.has(field)&&!policies.has(field))delete value[field];
   for(const ref of ['subjectKey','candidateKey','obligationId','findingKey']){
    if(Object.hasOwn(value,ref)){
     const policy=route.recordFieldTemplate.find(x=>x.field===ref);
     if(policy?.source==='BIND_EXISTING_CONTROLLER_SUBJECT')
      bindExistingSubjectV1(knownSubjectIds,ref,value[ref]);
    }
   }
   for(const spec of route.recordFieldTemplate){
    if(spec.source==='AI_EXACT_ENUM'&&Object.hasOwn(value,spec.field))
     strict(typeof value[spec.field]==='string'&&
       spec.allowedValues.includes(value[spec.field]),
       'APPEND enum must be an exact AI-authored permitted token: '+spec.field);
    if(spec.source==='ALLOCATE_MECHANICALLY_IF_NEW')
     value[spec.field]=allocatedRecordId(phase,u.unitId,spec.field,i+1);
    if(spec.source==='PRESERVE_ISSUED_VALUE'){
     if(spec.value!==undefined)value[spec.field]=structuredClone(spec.value);
     else if(MECHANICAL_ID_FIELDS.has(spec.field))
      value[spec.field]=allocatedRecordId(phase,u.unitId,spec.field,i+1);
     else delete value[spec.field];
    }
    if(spec.source==='BIND_EXISTING_CONTROLLER_SUBJECT')
     strict(bindExistingSubjectV1(knownSubjectIds,spec.field,value[spec.field]),
      'APPEND field requires accepted subject identity: '+spec.field);
    if(['CONTROLLER_COLLECT_AFTER_EXECUTION','CONTROLLER_VERIFIED_EXECUTION'].includes(spec.source)){
     const verified=machineVerifiedValueV1(c,value,spec.field);
     value[spec.field]=verified&&Object.hasOwn(verified,'value')?
      structuredClone(verified.value):unresolvedMachineFieldV1(spec.field,undefined);
    }
   }
   // Mandatory field presence is a transport/schema property, not a security verdict.
   for(const field of (fieldDef?.itemRequiredFields??[])){
    const item=value[field];
    strict(Object.hasOwn(value,field)&&item!==null&&item!==undefined&&
      !(typeof item==='string'&&isPendingAnswerValue(item)),
      'APPEND required field absent: '+route.field+'.'+field);
   }
   return {key,value};
  });
 }else if(['FLOW','ATTACK'].includes(u.kind)){
  const lists=u.kind==='FLOW'?['rows','flowNotes','integrationAnswers','contractChecks']:
   ['attackPaths','integrationAnswers'];
  for(const field of lists)for(const row of (result[field]??[])){
   const id=subjectOf(field,row);
   if(!id)continue;
   const original=structuredClone(row);
   const extraFields=field==='rows'?['candidate','candidates','decidingTest']:
    ['integrationAnswers','contractChecks','attackPaths'].includes(field)?['candidate']:[];
   for(const key of new Set([...Object.keys(row),...extraFields])){
    if(['contextId','flowId','obligationId','contract','classId','pathId'].includes(key))continue;
    const a=get(field,id,key);
    if(!a.found)continue;
    row[key]=field==='rows'&&['documentedRules','siblingComparisons'].includes(key)
     ?preserveDiscoveryKeys(original[key],a.value,key):
      key==='candidate'?candidateWithId(a.value):
      key==='candidates'&&Array.isArray(a.value)?a.value.map(candidateWithId):
      structuredClone(a.value);
   }
  }
  strict(submitted.extraRecords===undefined||
   (submitted.extraRecords!==null&&typeof submitted.extraRecords==='object'&&
    !Array.isArray(submitted.extraRecords)),
   'extraRecords must be a typed object');
  const extras=submitted.extraRecords??{};
  for(const field of (u.kind==='FLOW'?['trivialReviews','groupChecks','candidates']:
   ['attackPaths'])){
   const additional=extras[field]===undefined?[]:extras[field];
   checkExtraDiscoveryRecordsV1(field,additional,route);
   if(field==='attackPaths'){
    const allowed=new Set(route.fixedRecordKeys[0].records.flatMap(x=>x.key));
    for(const row of additional){
     if(!row||!Array.isArray(row.flowIds)||row.flowIds.some(id=>!allowed.has(id)))continue;
     result.attackPaths.push({...structuredClone(row),
      ...(row.candidate?{candidate:candidateWithId(row.candidate)}:{}),
      pathId:'PATH-'+String(result.attackPaths.length+1).padStart(3,'0')});
    }
   }else if(field==='candidates'){
    for(const row of additional){
     if(!row||typeof row!=='object'||Array.isArray(row))continue;
     result.candidates.push(candidateWithId(row));
    }
   }else result[field]=additional.map(row=>structuredClone(row));
  }
  if(u.kind==='FLOW'){
   const eligible=new Set(route.optionalRecords.find(x=>x.field==='trivialReviews')?.eligibleContextIds??[]);
   strict(submitted.trivialContextIds===undefined||Array.isArray(submitted.trivialContextIds),
    'trivialContextIds must be an explicit typed list when supplied');
   const chosen=submitted.trivialContextIds===undefined?eligible:
    new Set(submitted.trivialContextIds);
   strict([...chosen].every(id=>eligible.has(id)),
    'trivial row substitution can name only controller-eligible literal contexts');
   const packet=readUnitPacketV1({root:ROOT,packetPath:safePath(u.packetPath)});
   const inventory=read(safePath(packet.payload.sourceInventoryPath));
   const contexts=new Map((inventory.payload?.contexts??[])
    .map(x=>[x.contextId,x]));
   // Use the identical source-bound V13 qualifier as the validator and
   // summary, so a missing or unanchored claim never silently omits a row.
   result.rows=result.rows.filter(row=>!chosen.has(row.contextId)||
    !(result.trivialReviews??[]).some(review=>
      qualifiesLiteralTrivialReviewV13({
       review,context:contexts.get(row.contextId),inventory
      })));
  }
 }else throw Error('unsupported issued unit kind');
 return result;
}
async function materializeBoundSubmissionV1(c,u,selected){
 const raw=read(selected.rel);
 let completed=raw?.schemaVersion===MACHINE_BOUND_ANSWERS_V1?
  assembleBoundAnswersV1(c,u,raw):raw;
 // Create genuine Phase-5 requests before resolving their controller bindings.
 await materializePhase5Request(c,u,completed);
 if(raw?.schemaVersion!==MACHINE_BOUND_ANSWERS_V1)return selected;
 completed=assembleBoundAnswersV1(c,u,raw);
 const relativePath=path.posix.join(path.posix.dirname(selected.rel),
  'controller-compiled',path.posix.basename(selected.rel));
 const compiledPath=relative(relativePath),content=bytes(completed);
 if(fs.existsSync(compiledPath)){
  strict(sha(fs.readFileSync(compiledPath))===sha(content),
   'compiled artifact differs from immutable source-bound attempt');
 }else{
  fs.mkdirSync(path.dirname(compiledPath),{recursive:true});
  fs.writeFileSync(compiledPath,content);
 }
 return {...selected,rel:relativePath,filename:compiledPath};
}
async function unitValidateSingle(c,item,{publish=true,notify=true}={}){
 const phase=Number(need('phase')),step=Number(need('step')),stage=String(need('stage'));
 const id=safeId(item.unit_id),sourceCommit=item.source_commit||need('source_commit');
 // Refresh queue on every iteration rather than restoring a prior wave snapshot.
 const current=unitPlan(c),u=current.units.find(x=>x.unitId===id);
 if(!u)return;
 const state=current.queue.units[id];
 if(state?.status==='ACCEPTED'){
  if(!stageAcceptedV1(current,u))return;
  if(Number.isSafeInteger(item.attempt)&&Number.isSafeInteger(state.sourceAttempt)&&
     item.attempt!==state.sourceAttempt)return;
  if(!notify)return {status:'ACCEPTED',acceptedPath:state.acceptedPath};
  return callback('/fork/unit-verified',{status:'ACCEPTED',
   campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
   phase,step,stage,unitId:id,attempt:state.sourceAttempt??item.attempt??state.attempts,
   submissionSha256:state.acceptedSha256,sourceCommit,
   phaseEpoch:current.plan.phaseEpoch,authorityDigest:c.directory.authorityDigest,
   deficiencies:[],acceptedPath:state.acceptedPath,validationDelegatedTo:'CLOUDFLARE_WORKER'});
 }
 const selected=await materializeBoundSubmissionV1(c,u,submittedUnitFile(c,phase,u,item));
 strict(selected.epoch>=Number(state?.claimEpoch??0),
  'stale Worker claim epoch does not match active unit');
 const actualSha=sha(fs.readFileSync(selected.filename));
 state.status='CLAIMED';state.workerId=selected.workerId;
 state.claimEpoch=selected.epoch;state.claimToken=randomUUID();
 writeJson(relative(current.queueRel),current.queue);
 const request={schemaVersion:'curveyield-lite-solo-unit-batch-request-v1',
  requestId:'mi-unit-'+randomUUID(),operation:'SUBMIT',campaignId:c.directory.campaignId,
  campaignGenerationId:c.directory.campaignGenerationId,phaseSequence:phase,lane:'AUTO',
  workerId:selected.workerId,sourceSha256:c.directory.sourceSha256,
  authorityDigest:c.directory.authorityDigest,phaseEpoch:current.plan.phaseEpoch,
  auditControllerRef:MACHINE_REF,items:[{unitId:id,claimEpoch:state.claimEpoch,
   claimToken:state.claimToken,packetSha256:u.packetSha256||
    sha(fs.readFileSync(relative(u.packetPath||u.shardPath))),
   submissionPath:selected.rel,submissionSha256:actualSha,
   unitSpecRevision:u.unitSpecRevision}]};
 const result=processUnitRequestV1({root:ROOT,campaignPath:c.campaignPath,
  directory:c.directory,request,automationRoot:process.cwd()});
 writeJson(relative(c.directoryPath),c.directory);
 const updated=unitPlan(c),record=updated.queue.units[id];
 if(record?.status==='ACCEPTED'){
  record.sourceAttempt=selected.attempt;
  record.sourceWorkerId=selected.workerId;
  writeJson(relative(updated.queueRel),updated.queue);
 }
 if(publish)publishCanonical(c);
 if(!stageAcceptedV1(unitPlan(c),u))return {status:'PENDING',result};
 if(!notify)return {status:'ACCEPTED',acceptedPath:record.acceptedPath};
 return callback('/fork/unit-verified',{status:'ACCEPTED',
  campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
  phase,step,stage,unitId:id,attempt:selected.attempt,submissionSha256:actualSha,
  sourceCommit,phaseEpoch:current.plan.phaseEpoch,
  authorityDigest:c.directory.authorityDigest,deficiencies:[],
  acceptedPath:record.acceptedPath,validationDelegatedTo:'CLOUDFLARE_WORKER'});
}
/** Only durable accepted snapshots can finish a GitHub stage. */
async function unitAdvanceAcceptedStage(c){
 const phase=Number(need('phase')),step=Number(need('step')),stage=String(need('stage'));
 const current=unitPlan(c),stages=orderedMachineStagesV1(phase);
 const index=stages.findIndex(x=>x.step===step&&x.stage===stage);
 strict(index>=0,'unknown Machine Intelligence stage');
 const pending=stageUnitsV1(c,current,phase,step,stage)
  .filter(u=>!stageAcceptedV1(current,u));
 strict(!pending.length,
  'STAGE_NOT_DURABLY_ACCEPTED: '+pending.map(u=>u.unitId).join(','));
 // Skip genuinely empty stages, but never treat blocked/claimed units as done.
 let next=null;
 for(const candidate of stages.slice(index+1)){
  if(stageUnitsV1(c,current,phase,candidate.step,candidate.stage).length){
   next=candidate;break;
  }
 }
 const done=next===null;
 const nextStep=next?.step??null,nextStage=next?.stage??null;
 const planSha256=sha(fs.readFileSync(relative(current.planRel)));
 const queueSha256=sha(fs.readFileSync(relative(current.queueRel)));
 const nextRosterDigest=done?null:stageDigest(c,current,phase,nextStep,nextStage);
 return callback('/fork/step-verified',{status:'PASS',
  campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
  phase,step,stage,sourceCommit:need('source_commit'),planSha256,
  queueSha256,rosterDigest:payload.roster_digest||'',
  phaseEpoch:current.plan.phaseEpoch,authorityDigest:c.directory.authorityDigest,
  validator:payload.validator,deficiencies:[],stepComplete:done||nextStep!==step,
  completePhase:done,nextStep,nextStage,nextRosterDigest,
  nextQueueSha256:done?null:queueSha256,githubContentValidationPerformed:false});
}
async function unitValidateWave(c){
 if(payload.incremental===true)return unitAdvanceAcceptedStage(c);
 const phase=Number(need('phase')),step=Number(need('step')),stage=String(need('stage'));
 const sourceCommit=need('source_commit'),current=unitPlan(c);
 // Reuse the single-unit ownership/identity path, reloading queue each time.
 const units=stageUnitsV1(c,current,phase,step,stage)
  .filter(u=>!stageAcceptedV1(current,u))
  .filter(u=>fs.existsSync(relative(c.campaignPath+'/work/phase-'+
   phaseNo(phase)+'/units/'+u.unitId+'/submissions')));
 for(const u of units)
  await unitValidateSingle(c,{unit_id:u.unitId,source_commit:sourceCommit},
   {publish:false,notify:false});
 writeJson(relative(c.directoryPath),c.directory);
 publishCanonical(c);
 return unitAdvanceAcceptedStage(c);
}
async function main(){
  if(OP==='PHASE_0_INITIALIZE'){
    strict(typeof payload.authority_release==='string','intake authority label missing');
    strict(payload.request_id===payload.audit_id,'intake request identity differs from audit ID');
    strict((typeof payload.source_url==='string'&&payload.source_url.length>0)!==Boolean(payload.scan_urls?.length),'exactly one source intake mode required');
    strict(!payload.scan_urls||Array.isArray(payload.scan_urls),'malformed explorer scan URL array'); // Worker owns scan count and host policy.
    strict(process.env.AUDIT_CONTROLLER_TOKEN&&process.env.CONTRACT_AUTOMATION_TOKEN,'repository credentials missing');
    const initEnv={...process.env,REQUEST_ID:payload.request_id,SOURCE_URL:payload.source_url||'',
      SCAN_URLS:JSON.stringify(payload.scan_urls||[]),FORK_EXPECTED_SOURCE_SHA:payload.source_sha256||'',
      DELIVERY_TRANSPORT:'DIRECT',LITE_SOLO_AI_AUTONOMOUS:'1',
      PUBLISH_FILES_JSON:JSON.stringify(Object.fromEntries(['report_pdf','audited_source','scope_summary','findings_remediation','methodology_analysis','properties_hypotheses','execution_results','architecture_dependencies','residual_risks','evidence_index'].map(k=>[k,false])))};
    cmd('bash',['scripts/lite-solo-source-initialization/run-cloudflare-fork-v1.sh'],{env:initEnv,timeout:20*60*1000});
    return;
  }
  const c=checkout();
  if(OP==='PHASE_NEXT_STEP'){
    strict([4,5,6].includes(Number(payload.phase)),'SEMANTIC_INTERMEDIATE_WORKFLOWS_DISABLED: original phase boundary handles non-unit steps');
    await unitNextStep(c);
  }else if(OP==='PHASE_VALIDATE_UNIT'){
    const items=Array.isArray(payload.items)?payload.items:[payload];
    strict(items.length>=1,'controller packet must contain at least one unit');
    strict(new Set(items.map(x=>safeId(x.unit_id))).size===items.length,'duplicate unit in pending controller packet');
    for(const item of items)await unitValidateSingle(c,item);
  }else if(OP==='PHASE_VALIDATE_STEP'){
    strict([4,5,6].includes(Number(payload.phase)),'SEMANTIC_INTERMEDIATE_WORKFLOWS_DISABLED: original phase boundary handles non-unit validation');
    await unitValidateWave(c);
  }else if(OP==='PHASE_FINALIZE')await phaseFinalize(c);
}
main().catch(e=>{process.stderr.write('Cloudflare fork blocked: '+String(e.stack||e)+'\n');process.exitCode=1;});
