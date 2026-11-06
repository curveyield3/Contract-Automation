#!/usr/bin/env node
// Lite-Solo MiMo / Worker transport bridge v35.
// Model-facing duplicate transport fields are removed; frozen instructions,
// original controller-issued files, evidence gates and responses remain unchanged.
// The Worker remains the sole owner of instructions, claims and acceptance.
import http from 'node:http';
import {createHash} from 'node:crypto';

const campaignId=process.env.AUDIT_AI_CAMPAIGN_ID;
const workerBase=process.env.MACHINE_INTELLIGENCE_WORKER_URL;
if(typeof workerBase!=='string'||!workerBase.startsWith('https://'))throw Error('Machine Intelligence Worker URL is not configured');
const endpoint=workerBase.replace(/\/$/,'')+'/api/ai/bridge';
const audience='urn:curveyield:lite-solo:github-actions-ai:v1';
const identityEndpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const identityBearer=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if(!/^[A-Za-z0-9_.-]+-r[0-9]+$/.test(campaignId||'')||
   !identityEndpoint||!identityBearer||
   process.env.GITHUB_REPOSITORY!=='curveyield3/Contract-Automation'||
   process.env.GITHUB_REF!=='refs/heads/machine-intelligence-audit-controller-v1'||
   process.env.GITHUB_EVENT_NAME!=='workflow_dispatch')
 throw Error('Missing exact authorized campaign or signed GitHub Actions identity');

const sha=text=>createHash('sha256').update(text).digest('hex');

async function identity(){
 const url=identityEndpoint+(identityEndpoint.includes('?')?'&':'?')+
   'audience='+encodeURIComponent(audience);
 const res=await fetch(url,{headers:{authorization:'bearer '+identityBearer},
  signal:AbortSignal.timeout(20000)});
 if(!res.ok)throw Error('GitHub Actions OIDC identity request HTTP '+res.status);
 const token=(await res.json()).value;
 if(typeof token!=='string'||token.split('.').length!==3)
  throw Error('GitHub Actions OIDC identity payload invalid');
 return token;
}


// Every MiMo prompt/reply and Worker request/response is archived through the
// existing OIDC-authenticated Worker into PRIVATE R2 before archiving to Audit-Controller Markdown when the workflow finishes, never public Actions logs.
// One sequence is scoped to the GitHub run ID from the verified OIDC claim.
let transcriptEvent=0;
let firstTranscriptScope=null,lastTranscriptScope=null;
function updateTranscriptScope(reply,envelope){
 const phase=Number(reply?.phase??envelope?.governingDocuments?.phase);
 const step=Number(reply?.currentStep??reply?.step??envelope?.governingDocuments?.step);
 if(Number.isInteger(phase)&&phase>=0&&phase<=99&&
    Number.isInteger(step)&&step>=0&&step<=99){
  if(!firstTranscriptScope)firstTranscriptScope={phase,step};
  lastTranscriptScope={phase,step};
 }
}
async function recordPrivateCommunication(direction,content){
 if(typeof content!=='string')throw Error('MiMo transcript content must be text');
 const eventId=String(++transcriptEvent).padStart(8,'0'),parts=[];
 for(let i=0;i<content.length;){
  let end=Math.min(i+110000,content.length);
  if(end<content.length&&/[\uD800-\uDBFF]/.test(content[end-1]))end--;
  if(end<=i)throw Error('MiMo transcript part must preserve Unicode');
  parts.push(content.slice(i,end));i=end;
 }
 if(!parts.length)parts.push('');
 for(let index=0;index<parts.length;index++){
  const res=await fetch(endpoint,{
   method:'POST',headers:{authorization:'Bearer '+await identity(),'content-type':'application/json'},
   body:JSON.stringify({campaignId,operation:'record',eventId,direction,part:index,
    totalParts:parts.length,content:parts[index],
    startPhase:firstTranscriptScope?.phase??null,startStep:firstTranscriptScope?.step??null,
    endPhase:lastTranscriptScope?.phase??null,endStep:lastTranscriptScope?.step??null}),
   signal:AbortSignal.timeout(150000)
  });
  const receipt=await res.json().catch(()=>null);
  if(!res.ok||receipt?.status!=='MIMO_COMMUNICATION_RECORDED')
   throw Error('MiMo private transcript '+eventId+' part '+(index+1)+' not recorded: HTTP '+res.status);
 }
 console.log(JSON.stringify({status:'MIMO_PRIVATE_COMMUNICATION_RECORDED',
  time:new Date().toISOString(),workflowRunId:process.env.GITHUB_RUN_ID||null,
  direction,eventId,parts:parts.length,bytes:Buffer.byteLength(content),
  sha256:sha(content),visibility:'PRIVATE_CLOUDFLARE_R2'}));
}

async function workerCall(payload){
 await recordPrivateCommunication('worker_request',JSON.stringify({campaignId,...payload}));
 const res=await fetch(endpoint,{
  method:'POST',
  headers:{authorization:'Bearer '+await identity(),'content-type':'application/json'},
  body:JSON.stringify({campaignId,...payload}),
  signal:AbortSignal.timeout(150000)
 });
 // Preserve the exact Worker response body including rejected API requests.
 const raw=await res.text();
 if(!raw)throw Error('Worker bridge returned an empty response HTTP '+res.status);
 let envelope=null;
 try{envelope=JSON.parse(raw);}catch{}
 const result=envelope?.workerResponse||{};
 updateTranscriptScope(result,envelope);
 const issueCount=Array.isArray(result.fieldErrors)?result.fieldErrors.length:0;
 console.log(JSON.stringify({status:'MIMO_WORKER_DISPOSITION',
  time:new Date().toISOString(),httpStatus:res.status,
  bridgeStatus:envelope?.status||'UNPARSEABLE_WORKER_REPLY',
  workerStatus:result.status||null,workerHttpStatus:envelope?.workerHttpStatus??null,
  phase:result.phase??null,step:result.currentStep??result.step??null,
  unitId:result.unitId??null,canonicalPath:result.canonicalPath??null,
  claimedUnits:Array.isArray(result.items)?result.items.length:null,
  issuedReviewQuestions:Array.isArray(result.questions)?result.questions.length:null,
  repairItems:Array.isArray(result.repairChecklist)?result.repairChecklist.length:null,
  fieldErrorCount:issueCount,
  unitCounts:result.unitCounts||result.counts||null,
  workerReportedControllerAccepted:result.controllerAccepted===true,
  privateOutputKey:envelope?.rawR2Key||null,
  privateOutputSha256:envelope?.rawSha256||null,
  responseSha256:sha(raw),responseBytes:Buffer.byteLength(raw)}));
 await recordPrivateCommunication('worker_response',raw);
 return raw;
}

// Observe llama.cpp's live per-slot token counters without reading or logging
// prompt/generated text. The output, Worker protocol, and controller gates are
// unchanged. A genuine model token of either kind resets inactivity.
async function readInferenceCounters(){
 const res=await fetch('http://127.0.0.1:8080/slots',{
  signal:AbortSignal.timeout(8000)
 });
 if(!res.ok)throw Error('llama.cpp slot counter HTTP '+res.status);
 const slots=await res.json();
 if(!Array.isArray(slots))throw Error('llama.cpp slots response is not an array');
 const active=slots.find(x=>x?.is_processing===true);
 if(!active)return null;
 const processed=active.n_prompt_tokens_processed;
 const next=Array.isArray(active.next_token)?active.next_token[0]:active.next_token;
 const decoded=next?.n_decoded;
 if(!Number.isSafeInteger(processed)||processed<0||
    !Number.isSafeInteger(decoded)||decoded<0)
  throw Error('llama.cpp active slot lacks verifiable token counters');
 return {taskId:active.id_task??null,processed,decoded};
}


// A controller/Worker handoff is not an inference stall. These statuses are
// issued by the authoritative Worker when no model-authored work is eligible.
// Poll only the existing read-only AI bridge start/current route; never invent
// a model response, submit a form, bypass a receipt, or alter a lease.
const EXTERNAL_WAIT_STATUSES=new Set([
 'WAITING_ORIGINAL_CONTROLLER',
 'WAITING_PHASE_SEAL',
 'WAITING_PHASE7_SEAL',
 'STEP_VALIDATION_PENDING',
 'VERIFYING_CONTROLLER_ACCEPTANCE',
 'REWORK_PREPARING',
 'WAITING_ROSTER',
 'FILING_PHASE',
 'FILING_STEP',
 'SUBSTEP_WORK_SUBMISSION_QUEUED',
 'SUBSTEP_SUBMISSION_PENDING'
]);
function ownerOfWorkerReply(raw){
 let envelope;
 try{envelope=JSON.parse(raw);}
 catch{return {owner:'MIMO',status:'UNPARSEABLE_WORKER_REPLY'};}
 const answer=envelope?.workerResponse||{};
 const state=answer.status||envelope?.status||'UNKNOWN';
 if(envelope?.status==='AI_BRIDGE_MODEL_REQUESTED_FINISH')
  return {owner:'COMPLETE',status:state,phase:answer.phase??null,step:answer.step??null};
 // Never silently poll a failed Worker request, unknown status, or a recovery
 // blocker. MiMo sees the exact original reply for diagnosis.
 const healthy=envelope?.status==='AI_BRIDGE_WORKER_RESPONSE'&&
   (envelope.workerHttpStatus===undefined||
    envelope.workerHttpStatus>=200&&envelope.workerHttpStatus<300);
 const owned=healthy&&(
   answer.phase===0&&answer.phase0AutomationOwned===true||
   EXTERNAL_WAIT_STATUSES.has(state));
 return {owner:owned?'WORKER_CONTROLLER':'MIMO',status:state,
  phase:answer.phase??null,step:answer.currentStep??answer.step??null,
  stage:answer.stage??null};
}

async function modelCall(messages){
 const request=JSON.stringify({
  model:'lite-solo-mimo-v1',
  messages,
  temperature:0.1,
  stream:false,
  max_tokens:32768,
  response_format:{type:'json_object'}
 });
 const start=Date.now();
 await recordPrivateCommunication('mimo_input',request);
 console.log(JSON.stringify({status:'AI_BRIDGE_MODEL_REQUEST',
  conversationMessages:messages.length,promptBytes:Buffer.byteLength(request)}));
 const reply=await new Promise((resolve,reject)=>{
  const started=Date.now();
  let lastProgress=started,lastSample=null,observedTokens=false;
  let finished=false,polling=false,monitorErrors=0,lastReport=started;
  let watchdog;
  const stopMonitoring=()=>{finished=true;clearInterval(watchdog);};
  const req=http.request('http://127.0.0.1:8080/v1/chat/completions',{
   method:'POST',
   headers:{'content-type':'application/json','content-length':Buffer.byteLength(request)},
   signal:AbortSignal.timeout(120*60*1000)
  },res=>{
   const chunks=[];let length=0;
   res.on('data',part=>{
    length+=part.length;
    if(length>8*1024*1024){
     req.destroy(Error('MiMo HTTP output exceeds 8 MiB; raw response was not altered'));
     return;
    }
    chunks.push(part);
   });
   res.on('error',err=>{stopMonitoring();reject(err);});
   res.on('end',()=>{
    stopMonitoring();
    if(res.statusCode!==200){
     reject(Error('MiMo HTTP '+res.statusCode+': '+Buffer.concat(chunks).toString('utf8').slice(0,600)));
     return;
    }
    try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
    catch{reject(Error('MiMo HTTP envelope was not JSON'));}
   });
  });
  req.on('error',err=>{stopMonitoring();reject(err);});
  // Five minutes without prompt or generation token progress means recovery.
  // Before the first measurable token, allow ten minutes for tokenization,
  // model scheduling and large-prompt startup. Preserve the 120-minute hard cap.
  watchdog=setInterval(async()=>{
   if(finished||polling)return;
   polling=true;
   try{
    const sample=await readInferenceCounters();
    if(finished)return;
    const now=Date.now();
    if(sample){
     monitorErrors=0;
     const changedTask=lastSample&&sample.taskId!==lastSample.taskId;
     const advanced=!lastSample?
       sample.processed>0||sample.decoded>0:
       sample.processed>lastSample.processed||sample.decoded>lastSample.decoded;
     if(changedTask||advanced){
      observedTokens=true;lastProgress=now;
     }
     lastSample=sample;
     if(now-lastReport>=120000){
      console.log(JSON.stringify({status:'MIMO_INFERENCE_PROGRESS',
       promptTokensProcessed:sample.processed,generatedTokens:sample.decoded,
       secondsSinceProgress:Math.round((now-lastProgress)/1000)}));
      lastReport=now;
     }
     const idleMs=now-lastProgress;
     const limitMs=observedTokens?5*60*1000:10*60*1000;
     if(idleMs>=limitMs){
      console.error(JSON.stringify({status:'MIMO_INFERENCE_STALLED',
       promptTokensProcessed:sample.processed,generatedTokens:sample.decoded,
       secondsSinceProgress:Math.round(idleMs/1000),graceSeconds:limitMs/1000,
       action:'FAIL_CURRENT_RUN_AND_PRESERVE_ACCEPTED_WORK'}));
      req.destroy(Error('MiMo token progress stalled for '+Math.round(idleMs/1000)+' seconds'));
     }
    }else if(now-started>=10*60*1000&&!observedTokens){
     console.error(JSON.stringify({status:'MIMO_INFERENCE_STALLED',
      reason:'No active inference slot or measurable token progress after startup grace',
      secondsSinceStart:Math.round((now-started)/1000)}));
     req.destroy(Error('MiMo inference produced no measurable token activity after 10 minutes'));
    }
   }catch(err){
    monitorErrors++;
    if(monitorErrors===3)
     console.warn(JSON.stringify({status:'MIMO_PROGRESS_MONITOR_UNAVAILABLE',
      reason:String(err.message||err).slice(0,160),
      action:'Preserve existing 120-minute request timeout; do not infer stalled tokens'}));
   }finally{polling=false;}
  },30000);
  req.end(request);
 });
 const raw=reply.choices?.[0]?.message?.content;
 if(typeof raw!=='string')throw Error('MiMo did not return a text message; no fabricated Worker action');
 await recordPrivateCommunication('mimo_output',raw);
 // Observe the submitted action without editing or filtering the actual text.
 // This repository is PUBLIC: full source-bound findings belong in Worker R2,
 // not public Actions logs. All metadata comes from the unmodified reply.
 let action=null;
 try{action=JSON.parse(raw);}catch{}
 const input=action?.request||{};
 const file=input.shard??input.submission??null;
 console.log(JSON.stringify({status:'MIMO_ACTUAL_OUTPUT_SUBMITTED',
  time:new Date().toISOString(),route:action?.route||null,
  action:input.action||null,unitId:input.unitId||null,
  submittedFileKind:file?.kind??null,
  submittedEntries:Array.isArray(file?.entries)?file.entries.length:null,
  submittedFileBytes:file?Buffer.byteLength(JSON.stringify(file)):null,
  fields:Array.isArray(file?.entries)?
   file.entries.map(e=>e?.key).filter(x=>typeof x==='string').slice(0,30):null,
  responseSha256:sha(raw),responseBytes:Buffer.byteLength(raw),
  finishReason:reply.choices?.[0]?.finish_reason||null,
  promptTokens:reply.usage?.prompt_tokens||null,
  completionTokens:reply.usage?.completion_tokens||null,
  elapsedSeconds:Math.round((Date.now()-start)/1000),
  substantiveText:'PRIVATE_WORKER_R2_ONLY'}));
 return raw;
}

// The Worker includes complete policy copies both in the original current/claim
// response and in governingDocuments. Only MiMo's display copy is compacted;
// the original transport is retained intact for Worker state and source binding.
// Never invent a claim, gate answer, accepted result, or reconstructed file.
const alreadyProvidedStepInstructions=new Set();
// Keep the original bridge response for state/lease validation. Only the
// model-facing view is narrowed to the actual current step and work packet.
function modelFacingResponse(original){
 let envelope;
 try{envelope=JSON.parse(original);}catch{return original;}
 if(envelope?.status!=='AI_BRIDGE_WORKER_RESPONSE')return original;
 const native=envelope.workerResponse;
 const docs=envelope.governingDocuments;
 if(!native||typeof native!=='object'||Array.isArray(native))return original;
 if(!docs?.repositoryAgentPolicy?.content||
    !docs.currentPhaseStartHere?.content)return original;
 const instructionOnly=native.engagement?.stage==='INSTRUCTIONS';
 const withheldWorkFile=f=>/PHASE_[0-9]+_SCHEMA_v[0-9]+\.json$|WORK_FORM_TEMPLATE|WORK_FORM_v[0-9]+\.json|\/work\/phase-[0-9]+\/(?:shards|units)\//i.test(f?.path||'');
 const phase=Number(docs.phase??native.phase),step=Number(docs.step??native.step);
 if(!Number.isInteger(phase)||!Number.isInteger(step))
  throw Error('Current controller phase and step missing from original source-bound instructions');
 const currentFile=(f)=>{
  if(!f||typeof f.content!=='string'||!Number.isInteger(step)||step<1)return f;
  const p=f.path||'';
  const schema=/\/PHASE_[0-9]+_SCHEMA_v[0-9]+\.json$/i.test(p);
  const form=/\/PHASE_[0-9]+_WORK_FORM_TEMPLATE_v[0-9]+\.json$/i.test(p);
  const contract=/\/PHASE_CONTRACT\.json$/i.test(p);
  if(!schema&&!form&&!contract)return f; // retain other mandatory resources verbatim
  let doc;
  try{doc=JSON.parse(f.content);}catch{throw Error('Bound reference JSON cannot be read: '+p);}
  const key='step-'+step;
  if((schema||form)&&doc.actions&&Object.hasOwn(doc.actions,key)){
   const {actions,...rest}=doc;
   return {...f,scope:'original global fields and selected current action',
    content:JSON.stringify({...rest,actions:{[key]:actions[key]}})};
  }
  if(contract&&Array.isArray(doc.steps)&&doc.steps.some(x=>x.step===step)){
   const {steps,...rest}=doc;
   return {...f,scope:'original global fields and selected current step',
    content:JSON.stringify({...rest,steps:steps.filter(x=>x.step===step)})};
  }
  return f; // preserve required original if schema has a different stage shape
 };
 const baseKey=[campaignId,docs.authorityCommit,phase,step,
  native.stage||'',sha(docs.repositoryAgentPolicy.content),
  sha(docs.currentPhaseStartHere.content)].join(':');
 const prior=alreadyProvidedStepInstructions.has(baseKey);
 if(prior){
  // Same step, same model conversation: retain new packet and any newly
  // necessary predecessor evidence, but not repeated AGENTS/guide/schema.
  envelope.governingDocuments={
   authorityPreviouslyProvided:true,
   instructionIdentitySha256:sha(baseKey),
   prerequisiteEvidenceFiles:docs.prerequisiteEvidenceFiles||[]
  };
 }else{
  envelope.governingDocuments={
   ...docs,
   requiredControllerFiles:(docs.requiredControllerFiles||[]).filter(f=>!instructionOnly||!withheldWorkFile(f)).map(currentFile)
  };
  alreadyProvidedStepInstructions.add(baseKey);
 }
 const work=native.inputFileTemplate?1:
  Array.isArray(native.items)?native.items.length:0;
 console.log(JSON.stringify({status:'MIMO_SOURCE_BOUND_PROMPT_PREPARED',
  phase,step,stage:native.stage||null,assignedWorkFiles:work,
  includesExactControllerTemplate:work>0,
  originalTransportBytes:Buffer.byteLength(original),
  repeatStepInstructionsSkipped:prior,
  modelFacingBytes:Buffer.byteLength(JSON.stringify(envelope)),
  originalPolicySha256:docs.repositoryAgentPolicy.sha256||sha(docs.repositoryAgentPolicy.content),
  originalGuideSha256:docs.currentPhaseStartHere.sha256||null,
  sourceText:'PRIVATE_MODEL_INPUT_ONLY'}));
 // Model caching requires the immutable step instructions to be the first
 // (stable) prefix, before the changing Worker lease/work packets and receipts.
 // Reorder the transport envelope without changing any controller data.
 return JSON.stringify({governingDocuments:envelope.governingDocuments,...envelope});
}

// Private GitHub-side evidence delivery for the current frozen Machine
// Intelligence campaign. The Worker response, controller form, lease and
// submission protocol are NEVER changed. The already authorized private
// Audit-Controller credential reads committed source-bound checkpoints.
// No new Cloudflare endpoint, Durable Object write or Actions workflow.
const historyBranch='machine-intelligence-audit-controller-v1';
const historyRepo='curveyield3/Audit-Controller';
const historyFileCache=new Map();
let historySnapshotCommit=null;
async function historyGitMetadataV1(endpoint){
 const token=process.env.AUDIT_CONTROLLER_GITHUB_TOKEN;
 if(!token)return null;
 const res=await fetch('https://api.github.com/repos/'+historyRepo+'/'+endpoint,{
  headers:{authorization:'Bearer '+token,
   accept:'application/vnd.github+json','x-github-api-version':'2022-11-28'},
  signal:AbortSignal.timeout(30000)});
 if(!res.ok)throw Error('Private controller Git tree read HTTP '+res.status);
 return res.json();
}
// Discover exact existing QUESTION_INDEX paths from a pinned commit tree.
// Unlike probing every issued unit, this lookup remains efficient even when
// most accepted units have not published question checkpoints.
async function historyIndexPathsForPhaseV1(workspace,phase){
 const commit=await historyGitMetadataV1('git/commits/'+historySnapshotCommit);
 let treeSha=commit?.tree?.sha;
 if(!/^[0-9a-f]{40}$/.test(String(treeSha??'')))return null;
 const prefix=workspace+'/work/phase-'+String(phase).padStart(2,'0')+'/units';
 for(const segment of prefix.split('/')){
  const tree=await historyGitMetadataV1('git/trees/'+treeSha);
  const child=tree?.tree?.find(x=>x.path===segment&&x.type==='tree');
  if(!child)return new Set();
  treeSha=child.sha;
 }
 const listing=await historyGitMetadataV1('git/trees/'+treeSha+'?recursive=1');
 // Never treat a truncated Git tree as a complete absence of indexes.
 if(!Array.isArray(listing?.tree)||listing.truncated)return null;
 return new Set(listing.tree.filter(x=>x.type==='blob'&&
  /^[A-Za-z0-9._-]+\/questions\/QUESTION_INDEX_v1\.json$/.test(x.path))
  .map(x=>prefix+'/'+x.path));
}
async function historyGithubFileV1(rel){
 if(typeof rel!=='string'||!rel.startsWith('campaigns/')||
    rel.includes('\\')||rel.split('/').some(s=>!s||s==='.'||s==='..'))
  return null;
 // Never fall back to a moving branch or reuse cache entries across snapshots.
 if(!/^[0-9a-f]{40}$/.test(String(historySnapshotCommit??'')))return null;
 const cacheKey=historySnapshotCommit+':'+rel;
 if(historyFileCache.has(cacheKey))return historyFileCache.get(cacheKey);
 const token=process.env.AUDIT_CONTROLLER_GITHUB_TOKEN;
 if(!token)return null;
 const suffix=rel.split('/').map(encodeURIComponent).join('/');
 const url='https://api.github.com/repos/'+historyRepo+'/contents/'+suffix+
  '?ref='+encodeURIComponent(historySnapshotCommit);
 const res=await fetch(url,{headers:{
  authorization:'Bearer '+token,accept:'application/vnd.github+json',
  'x-github-api-version':'2022-11-28'
 },signal:AbortSignal.timeout(30000)});
 if(res.status===404){
  historyFileCache.set(cacheKey,null);
  return null;
 }
 if(!res.ok)throw Error('Private controller history read HTTP '+res.status);
 const data=await res.json();
 if(data?.type!=='file'||typeof data.sha!=='string')return null;
 let bytes;
 if(data.encoding==='base64'&&typeof data.content==='string')
  bytes=Buffer.from(data.content.replace(/\s/g,''),'base64');
 else{
  const blob=await fetch('https://api.github.com/repos/'+historyRepo+
   '/git/blobs/'+encodeURIComponent(data.sha),{headers:{
    authorization:'Bearer '+token,accept:'application/vnd.github+json',
    'x-github-api-version':'2022-11-28'
   },signal:AbortSignal.timeout(30000)});
  if(!blob.ok)throw Error('Private controller history blob HTTP '+blob.status);
  const payload=await blob.json();
  if(payload.encoding!=='base64'||typeof payload.content!=='string')return null;
  bytes=Buffer.from(payload.content.replace(/\s/g,''),'base64');
 }
 // Verify the returned bytes against Git's committed blob identity as well
 // as the SHA-256 used by original canonical and question receipts.
 const gitBlobSha=createHash('sha1').update(Buffer.concat([
  Buffer.from('blob '+bytes.length),Buffer.from([0]),bytes])).digest('hex');
 if(gitBlobSha!==data.sha)
  throw Error('Pinned controller Git blob digest mismatch: '+rel);
 const file={path:rel,sha256:sha(bytes),gitBlobSha,text:bytes.toString('utf8'),
  snapshotCommit:historySnapshotCommit};
 historyFileCache.set(cacheKey,file);
 return file;
}
async function historyJsonV1(rel){
 const file=await historyGithubFileV1(rel);
 if(!file)return null;
 return {file,data:JSON.parse(file.text)};
}
async function sourceBoundQuestionHistoryV1(raw){
 let envelope;
 try{envelope=JSON.parse(raw);}catch{return null;}
 const live=envelope?.workerResponse??{};
 if(!['LEASED_PACKET','LEASED_SHARD'].includes(live.status))return null;
 // Pin every question-index and checkpoint read to one immutable GitHub tree.
 // The next claim gets a fresh HEAD and thus sees late-published records.
 historyFileCache.clear();
 historyArchivedTreeCacheV1.clear();
 historySnapshotCommit=null;
 const phase=Number(live.phase);
 try{
  const head=await historyGitMetadataV1('git/ref/heads/'+historyBranch);
  historySnapshotCommit=head?.object?.sha??null;
 }catch{
  return {schemaVersion:'curveyield-ai-question-evidence-delivery-v1',
   campaignId,histories:[],unavailable:[{status:'GITHUB_BRANCH_UNAVAILABLE'}]};
 }
 if(!/^[0-9a-f]{40}$/.test(String(historySnapshotCommit??'')))return null;
 if(!Number.isInteger(phase)||phase<4)return null;
 // The same pinned, authenticated directory is used for canonical evidence.
 const directory=await historyDirectoryV1();
 if(!directory||directory.campaignId!==campaignId||
    !validHistoryWorkspacePathV1(directory.workspacePath))
  return {schemaVersion:'curveyield-ai-question-evidence-delivery-v1',
   campaignId,histories:[],unavailable:[{status:'CONTROLLER_DIRECTORY_UNAVAILABLE'}]};
 const workspace=directory.workspacePath,selected=new Map(),unavailable=[];
 const indexedPaths=new Map();
 for(const p of [4,5,6]){
  if(p>phase)continue;
  const name=String(p).padStart(2,'0'),base=workspace+'/work/phase-'+name+'/units';
  indexedPaths.set(p,await historyIndexPathsForPhaseV1(workspace,p).catch(()=>null));
  const canon=workspace+'/derived/phase-'+p+'/PHASE_'+name+'_CANONICAL_DATA_v1.json';
  const canonical=await historyJsonV1(canon).catch(()=>null);
  for(const ref of canonical?.data?.automationOutputs?.questionHistoryRoster?.histories??[]){
   if(ref?.unitId&&typeof ref.unitId==='string')
    selected.set(p+':'+ref.unitId,{phaseSequence:p,unitId:ref.unitId,ref});
  }
  const queue=await historyJsonV1(base+'/UNIT_QUEUE_STATE_v1.json').catch(()=>null);
  if(queue?.data?.campaignId!==campaignId||
     queue?.data?.campaignGenerationId!==directory.campaignGenerationId||
     queue?.data?.sourceSha256!==directory.sourceSha256||
     queue?.data?.authorityDigest!==directory.authorityDigest||
     queue?.data?.phaseSequence!==p)continue;
  for(const [unitId,state] of Object.entries(queue.data.units??{}))
   if(state?.status==='ACCEPTED'&&/^[A-Za-z0-9._-]+$/.test(unitId))
    selected.set(p+':'+unitId,{phaseSequence:p,unitId,
     ref:selected.get(p+':'+unitId)?.ref??null});
 }
 const records=[];
 for(const item of [...selected.values()].sort((a,b)=>
    a.phaseSequence-b.phaseSequence||a.unitId.localeCompare(b.unitId))){
  const prefix=workspace+'/work/phase-'+String(item.phaseSequence).padStart(2,'0')+
   '/units/'+item.unitId+'/questions';
  const indexPath=prefix+'/QUESTION_INDEX_v1.json';
  const existingIndexes=indexedPaths.get(item.phaseSequence);
  if(existingIndexes&&!existingIndexes.has(indexPath)){
   unavailable.push({phaseSequence:item.phaseSequence,unitId:item.unitId,
    indexPath,status:'NOT_PUBLISHED'});continue;
  }
  const ix=await historyJsonV1(indexPath).catch(()=>null);
  if(!ix){
   unavailable.push({phaseSequence:item.phaseSequence,unitId:item.unitId,
    indexPath,status:'NOT_PUBLISHED_OR_UNREADABLE'});continue;
  }
  const index=ix.data;
  if(index.schemaVersion!=='curveyield-ai-question-index-v1'||
     index.campaignId!==campaignId||
     index.campaignGenerationId!==directory.campaignGenerationId||
     index.sourceSha256!==directory.sourceSha256||
     index.authorityDigest!==directory.authorityDigest||
     index.phaseSequence!==item.phaseSequence||
     index.unitId!==item.unitId||
     (item.ref?.packetSha256&&index.packetSha256!==item.ref.packetSha256)||
     (item.ref?.phaseEpoch&&index.phaseEpoch!==item.ref.phaseEpoch)||
     !Array.isArray(index.checkpoints)){
   unavailable.push({phaseSequence:item.phaseSequence,unitId:item.unitId,
    indexPath,status:'IDENTITY_MISMATCH'});continue;
  }
  const checkpoints=[];
  for(const ref of index.checkpoints){
   if(typeof ref?.path!=='string'||!ref.path.startsWith(prefix+'/checkpoints/')||
      !/^[a-f0-9]{64}$/.test(String(ref.sha256??''))){
    unavailable.push({phaseSequence:item.phaseSequence,unitId:item.unitId,
     indexPath,status:'INVALID_CHECKPOINT_REFERENCE'});continue;
   }
   const cp=await historyJsonV1(ref.path).catch(()=>null);
   if(!cp||cp.file.sha256!==ref.sha256||
      cp.data.campaignId!==campaignId||
      cp.data.campaignGenerationId!==directory.campaignGenerationId||
      cp.data.sourceSha256!==directory.sourceSha256||
      cp.data.authorityDigest!==directory.authorityDigest||
      cp.data.phaseSequence!==item.phaseSequence||
      cp.data.unitId!==item.unitId||
      cp.data.phaseEpoch!==index.phaseEpoch||
      cp.data.packetSha256!==index.packetSha256||
      (ref.revision!==undefined&&cp.data.revision!==ref.revision)||
      (ref.requestId!==undefined&&cp.data.requestId!==ref.requestId)||
      (ref.requestDigest!==undefined&&cp.data.requestDigest!==ref.requestDigest)){
    unavailable.push({phaseSequence:item.phaseSequence,unitId:item.unitId,
     indexPath,checkpointPath:ref.path,status:'CHECKPOINT_NOT_AVAILABLE'});
    continue;
   }
   // Deliver each exact immutable checkpoint, including PLAN, ANSWERS,
   // EXPAND and REVISE history; never summarize or overwrite prior revisions.
   checkpoints.push({path:ref.path,sha256:cp.file.sha256,checkpoint:cp.data});
  }
  records.push({phaseSequence:item.phaseSequence,unitId:item.unitId,
   indexPath,indexSha256:ix.file.sha256,indexRevision:index.revision,
   questionRoster:index.questions,checkpoints});
 }
 return records.length||unavailable.length?{
  schemaVersion:'curveyield-ai-question-evidence-delivery-v1',
  campaignId,sourceSha256:directory.sourceSha256,
  sourceRepo:historyRepo,sourceBranch:historyBranch,
  snapshotCommit:historySnapshotCommit,
  description:'Exact committed source-bound investigative question and answer records; not inferred formal audit conclusions.',
  histories:records,unavailable
 }:null;
}
// Existing campaign folders may contain spaces; GitHub contents calls encode
// each segment. Reject unsafe navigation, not legitimate source-owned names.
function validHistoryWorkspacePathV1(workspace){
 return typeof workspace==='string'&&workspace.startsWith('campaigns/')&&
  !workspace.includes('\\')&&workspace.split('/').every(s=>
   s!==''&&s!=='.'&&s!=='..'&&!/[\u0000-\u001f]/.test(s));
}
// Read from the same immutable private controller commit as question history.
async function historyDirectoryV1(){
 if(!historySnapshotCommit)return null;
 const rel='Audit Campaign Directory/campaigns/'+
  campaignId.replace(/-r[0-9]+$/,'')+'.json';
 const token=process.env.AUDIT_CONTROLLER_GITHUB_TOKEN;
 if(!token)return null;
 const url='https://api.github.com/repos/'+historyRepo+'/contents/'+
  rel.split('/').map(encodeURIComponent).join('/')+
  '?ref='+encodeURIComponent(historySnapshotCommit);
 const res=await fetch(url,{headers:{
  authorization:'Bearer '+token,accept:'application/vnd.github+json',
  'x-github-api-version':'2022-11-28'
 },signal:AbortSignal.timeout(30000)});
 if(!res.ok)return null;
 const file=await res.json();
 if(file.encoding!=='base64'||typeof file.content!=='string')return null;
 return JSON.parse(Buffer.from(file.content.replace(/\s/g,''),'base64').toString('utf8'));
}
// One receipt-tree inventory serves all accepted substantive phases.
// Read at exactly the Git commit already pinned for this new assignment.
async function historyPhaseReceiptPathsV1(workspace){
 if(!validHistoryWorkspacePathV1(workspace)||
    !/^[0-9a-f]{40}$/.test(String(historySnapshotCommit??'')))return null;
 const commit=await historyGitMetadataV1('git/commits/'+historySnapshotCommit);
 let treeSha=commit?.tree?.sha;
 if(!/^[0-9a-f]{40}$/.test(String(treeSha??'')))return null;
 for(const segment of (workspace+'/receipts').split('/')){
  const tree=await historyGitMetadataV1('git/trees/'+treeSha);
  if(!Array.isArray(tree?.tree)||tree.truncated)return null;
  const child=tree.tree.find(x=>x.path===segment&&x.type==='tree');
  if(!child)return [];
  treeSha=child.sha;
 }
 const listing=await historyGitMetadataV1('git/trees/'+treeSha);
 if(!Array.isArray(listing?.tree)||listing.truncated)return null;
 return listing.tree.filter(x=>x.type==='blob'&&
    /^PHASE_(?:0[1-9]|10)_RECEIPT_v[0-9]+\.json$/.test(x.path))
  .map(x=>workspace+'/receipts/'+x.path)
  .sort((a,b)=>{
   const ax=a.match(/PHASE_([0-9]+)_RECEIPT_v([0-9]+)\.json$/);
   const bx=b.match(/PHASE_([0-9]+)_RECEIPT_v([0-9]+)\.json$/);
   return Number(ax[1])-Number(bx[1])||Number(ax[2])-Number(bx[2]);
  });
}
async function historyPhase1ReceiptPathsV1(workspace){
 const paths=await historyPhaseReceiptPathsV1(workspace);
 return paths?.filter(p=>/\/PHASE_01_RECEIPT_v[0-9]+\.json$/.test(p))
   .sort((a,b)=>Number(b.match(/_v([0-9]+)\.json$/)[1])-
     Number(a.match(/_v([0-9]+)\.json$/)[1]))??null;
}

// Source records are never summarized or selected for security significance here.
// Small canonical JSON is delivered complete. Large JSON is available through
// exact source pages and selector-based record fragments in the SAME local
// inference dialogue; neither request is submitted to the Worker.
function phase1EvidencePageV1(text,start,width=6000){
 const end=Math.min(text.length,start+width);
 const safeEnd=end<text.length&&end>start&&
  text.charCodeAt(end-1)>=0xD800&&text.charCodeAt(end-1)<=0xDBFF?end-1:end;
 return {start,end:safeEnd,text:text.slice(start,safeEnd)};
}
// Find original canonical files archived by existing master amendment replay.
// No new ledger or storage is created. The archive is read at the same pinned
// commit as its accepted receipt and is indexed only when a direct path fails.
const historyArchivedTreeCacheV1=new Map();
async function historyArchivedCanonicalPathsV1(workspace,originalRelativePath){
 const key=historySnapshotCommit+':'+workspace;
 let index=historyArchivedTreeCacheV1.get(key);
 if(!index){
  const commit=await historyGitMetadataV1('git/commits/'+historySnapshotCommit);
  let treeSha=commit?.tree?.sha,missing=false,unavailable=false;
  if(!/^[0-9a-f]{40}$/.test(String(treeSha??'')))unavailable=true;
  if(!unavailable){
   for(const segment of (workspace+'/superseded').split('/')){
    const tree=await historyGitMetadataV1('git/trees/'+treeSha);
    if(!Array.isArray(tree?.tree)||tree.truncated){unavailable=true;break;}
    const child=tree.tree.find(t=>t.path===segment&&t.type==='tree');
    if(!child){missing=true;break;}
    treeSha=child.sha;
   }
  }
  if(unavailable)index={availability:'ARCHIVE_TREE_UNAVAILABLE',paths:[]};
  else if(missing)index={availability:'NO_EXISTING_SUPERSEDED_ARCHIVE',paths:[]};
  else{
   const listing=await historyGitMetadataV1('git/trees/'+treeSha+'?recursive=1');
   index=!Array.isArray(listing?.tree)||listing.truncated
    ?{availability:'ARCHIVE_TREE_TRUNCATED_OR_UNAVAILABLE',paths:[]}
    :{availability:'AVAILABLE',
      paths:listing.tree.filter(t=>t.type==='blob')
       .map(t=>workspace+'/superseded/'+t.path)};
  }
  historyArchivedTreeCacheV1.set(key,index);
 }
 return {availability:index.availability,
  paths:index.paths.filter(p=>p.endsWith('/'+originalRelativePath))};
}

// The original canonical file, NOT any promoted-finding index, defines which
// source values exist. Every value and original array position is indexed.
function historyCanonicalSelectorsV1(canonical){
 const records=[],missingRoots=[];
 const escaped=k=>String(k).replace(/~/g,'~0').replace(/\//g,'~1');
 for(const family of ['actions','automationInputs','automationOutputs']){
  if(!Object.hasOwn(canonical,family)){missingRoots.push('/'+family);continue;}
  const stack=[{value:canonical[family],selector:'/'+family,position:null}];
  while(stack.length){
   const node=stack.pop(),value=node.value;
   const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
   const row={selector:node.selector,kind};
   if(node.position!==null)row.originalArrayPosition=node.position;
   if(value&&typeof value==='object'&&!Array.isArray(value)){
    const identities=Object.entries(value).filter(([k,v])=>
     /(?:id|key)$/i.test(k)&&(typeof v==='string'||typeof v==='number'));
    if(identities.length)row.originalIdentityFields=Object.fromEntries(identities);
   }
   records.push(row);
   if(Array.isArray(value)){
    for(let i=value.length-1;i>=0;i--)stack.push({
     value:value[i],selector:node.selector+'/'+i,position:i});
   }else if(value&&typeof value==='object'){
    const keys=Object.keys(value);
    for(let i=keys.length-1;i>=0;i--)stack.push({
     value:value[keys[i]],selector:node.selector+'/'+escaped(keys[i]),position:null});
   }
  }
 }
 return {records,missingRoots};
}
function historyCanonicalTextPagesV1(text){
 const pages=[];
 for(let start=0;start<text.length;){
  const fragment=phase1EvidencePageV1(text,start);
  if(fragment.end<=start)throw Error('Canonical original paging made no progress');
  pages.push({page:pages.length+1,start,end:fragment.end,sha256:sha(fragment.text)});
  start=fragment.end;
 }
 return pages;
}

// Canonical history is its own evidence family. It is never substituted by
// the Phase-4/5/6 question-index checkpoints. All original accepted phase
// revisions and selector positions stay distinct even when conclusions differ.
async function sourceBoundCanonicalHistoryV1(raw){
 let envelope;
 try{envelope=JSON.parse(raw);}catch{return null;}
 const live=envelope?.workerResponse??{};
 if(!['LEASED_PACKET','LEASED_SHARD'].includes(live.status))return null;
 const activePhase=Number(live.phase);
 if(!Number.isInteger(activePhase)||activePhase<2||activePhase>10)return null;
 const base={
  schemaVersion:'curveyield-mi-original-canonical-history-v1',
  campaignId,activePhase,sourceRepo:historyRepo,sourceBranch:historyBranch,
  snapshotCommit:historySnapshotCommit,
  referenceScheme:'RFC6901_JSON_POINTER',
  provenance:'ORIGINAL_ACCEPTED_CANONICAL_JSON',
  interpretationOwner:'MIMO',
  separateQuestionCheckpointFamily:true
 };
 const unavailable=[],rosters=[],sources=new Map();
 const failed=(availability,details={})=>({
  manifest:{...base,availability,rosters,unavailable:[...unavailable,details]},
  sources
 });
 if(!/^[0-9a-f]{40}$/.test(String(historySnapshotCommit??'')))
  return failed('PINNED_CONTROLLER_COMMIT_UNAVAILABLE',{
   availability:'PINNED_CONTROLLER_COMMIT_UNAVAILABLE'});
 const directory=await historyDirectoryV1();
 if(!directory||directory.campaignId!==campaignId||
    !/^[a-f0-9]{64}$/.test(String(directory.sourceSha256??''))||
    typeof directory.campaignGenerationId!=='string'||
    !directory.campaignGenerationId||
    !validHistoryWorkspacePathV1(directory.workspacePath))
  return failed('CAMPAIGN_DIRECTORY_IDENTITY_UNAVAILABLE',{
   availability:'CAMPAIGN_DIRECTORY_IDENTITY_UNAVAILABLE'});
 if(live.campaignGenerationId&&
    live.campaignGenerationId!==directory.campaignGenerationId)
  return failed('WORKER_GENERATION_MISMATCH',{
   availability:'WORKER_GENERATION_MISMATCH'});
 if(live.sourceSha256&&live.sourceSha256!==directory.sourceSha256)
  return failed('WORKER_AUDITED_SOURCE_MISMATCH',{
   availability:'WORKER_AUDITED_SOURCE_MISMATCH'});
 base.campaignGenerationId=directory.campaignGenerationId;
 base.auditedSourceSha256=directory.sourceSha256;
 base.workspacePath=directory.workspacePath;
 base.currentAssignmentPhaseAtSnapshot=
  Number(directory.currentAssignment?.phaseSequence)||null;
 const receiptPaths=await historyPhaseReceiptPathsV1(directory.workspacePath)
  .catch(error=>{
   unavailable.push({availability:'RECEIPT_TREE_UNREADABLE',
    expectedPath:directory.workspacePath+'/receipts',
    detail:String(error?.message??error)});
   return null;
  });
 if(receiptPaths===null)return failed('RECEIPT_TREE_UNAVAILABLE',{
  availability:'RECEIPT_TREE_UNAVAILABLE',
  expectedPath:directory.workspacePath+'/receipts'});
 const phases=[1,2,3,4,5,6,8,9].filter(p=>p<activePhase);
 for(const phase of phases){
  const tag=String(phase).padStart(2,'0');
  const originalRelativePath='derived/phase-'+phase+
   '/PHASE_'+tag+'_CANONICAL_DATA_v1.json';
  const originalCanonicalPath=directory.workspacePath+'/'+originalRelativePath;
  const acceptedReceipts=receiptPaths.filter(p=>
   p.startsWith(directory.workspacePath+'/receipts/PHASE_'+tag+'_RECEIPT_v'));
  if(!acceptedReceipts.length){
   unavailable.push({phaseSequence:phase,originalCanonicalPath,
    expectedReceiptDirectory:directory.workspacePath+'/receipts',
    availability:phase===9?'OPTIONAL_PHASE9_RECEIPT_NOT_PUBLISHED':
     'ACCEPTED_PHASE_RECEIPT_NOT_PUBLISHED'});
   continue;
  }
  for(const receiptPath of acceptedReceipts){
   const revisionName=receiptPath.match(/_v([0-9]+)\.json$/);
   const receiptRevision=revisionName?Number(revisionName[1]):null;
   const basis={phaseSequence:phase,acceptedRevision:receiptRevision,
    originalCanonicalPath,receiptPath,
    campaignId, campaignGenerationId:directory.campaignGenerationId,
    auditedSourceSha256:directory.sourceSha256,
    snapshotCommit:historySnapshotCommit};
   let receipt;
   try{receipt=await historyJsonV1(receiptPath);}
   catch(error){
    unavailable.push({...basis,availability:'RECEIPT_UNREADABLE',
     detail:String(error?.message??error)});continue;
   }
   const rd=receipt?.data;
   if(!rd){unavailable.push({...basis,availability:'RECEIPT_UNAVAILABLE'});continue;}
   const identityBound=rd.schemaVersion==='curveyield-lite-phase-receipt-v1'&&
    rd.campaign?.campaignId===campaignId&&
    rd.campaign?.campaignGenerationId===directory.campaignGenerationId&&
    rd.campaign?.workspacePath===directory.workspacePath&&
    rd.phase?.sequence===phase&&rd.phase?.revision===receiptRevision&&
    rd.source?.sha256===directory.sourceSha256;
   if(!identityBound){
    unavailable.push({...basis,receiptSha256:receipt.file.sha256,
     availability:'RECEIPT_CAMPAIGN_GENERATION_SOURCE_OR_REVISION_MISMATCH'});
    continue;
   }
   if(rd.phase.status==='SKIPPED'&&phase===9){
    unavailable.push({...basis,receiptSha256:receipt.file.sha256,
     availability:'PHASE9_SKIPPED_NO_ACCEPTED_CANONICAL'});
    continue;
   }
   if(!['SEALED','COMPLETE'].includes(rd.phase.status)){
    unavailable.push({...basis,receiptSha256:receipt.file.sha256,
     availability:'RECEIPT_NOT_ACCEPTED',receiptStatus:rd.phase.status});
    continue;
   }
   const refs=[...(rd.evidence??[]),...(rd.outputs??[])]
    .filter(ref=>ref?.role==='PHASE_CANONICAL_DATA'&&
     ref?.path===originalRelativePath&&
     /^[a-f0-9]{64}$/.test(String(ref.sha256??'')));
   const expectedShas=[...new Set(refs.map(ref=>ref.sha256))];
   if(expectedShas.length!==1){
    unavailable.push({...basis,receiptSha256:receipt.file.sha256,
     availability:expectedShas.length?'CONFLICTING_ACCEPTED_CANONICAL_HASHES':
      'ACCEPTED_CANONICAL_REFERENCE_MISSING',
     expectedOriginalReference:originalRelativePath});
    continue;
   }
   const expectedSha=expectedShas[0],attempts=[],candidates=[
    originalCanonicalPath,
    directory.workspacePath+'/superseded/'+originalRelativePath,
    directory.workspacePath+'/superseded/reviewer-4-followup-v1/'+originalRelativePath
   ];
   let selected=null,archiveAvailability='NOT_NEEDED';
   const findCommitted=async paths=>{
    for(const candidate of paths){
     if(attempts.some(a=>a.path===candidate))continue;
     try{
      const file=await historyGithubFileV1(candidate);
      if(!file){attempts.push({path:candidate,availability:'NOT_PUBLISHED'});continue;}
      attempts.push({path:candidate,sha256:file.sha256,
       availability:file.sha256===expectedSha?'HASH_MATCH':'SHA256_MISMATCH'});
      if(file.sha256===expectedSha){selected=file;return;}
     }catch(error){
      attempts.push({path:candidate,availability:'READ_UNAVAILABLE',
       detail:String(error?.message??error)});
     }
    }
   };
   await findCommitted(candidates);
   if(!selected){
    try{
     const archive=await historyArchivedCanonicalPathsV1(
      directory.workspacePath,originalRelativePath);
     archiveAvailability=archive.availability;
     await findCommitted(archive.paths);
    }catch(error){
     archiveAvailability='ARCHIVE_INDEX_UNAVAILABLE';
     attempts.push({path:directory.workspacePath+'/superseded',
      availability:archiveAvailability,detail:String(error?.message??error)});
    }
   }
   if(!selected){
    unavailable.push({...basis,receiptSha256:receipt.file.sha256,
     expectedCanonicalSha256:expectedSha,
     availability:attempts.some(a=>a.sha256&&a.sha256!==expectedSha)
      ?'ACCEPTED_CANONICAL_SHA256_MISMATCH':'ACCEPTED_CANONICAL_NOT_RETRIEVABLE',
     archiveAvailability,attempts});
    continue;
   }
   let canonical;
   try{canonical=JSON.parse(selected.text);}
   catch(error){
    unavailable.push({...basis,receiptSha256:receipt.file.sha256,
     expectedCanonicalSha256:expectedSha,committedPath:selected.path,
     availability:'CANONICAL_JSON_UNREADABLE',detail:String(error?.message??error)});
    continue;
   }
   if(canonical?.schemaVersion!=='curveyield-lite-phase-canonical-data-v1'||
      canonical.phase!==phase||canonical.campaignId!==campaignId){
    unavailable.push({...basis,receiptSha256:receipt.file.sha256,
     expectedCanonicalSha256:expectedSha,committedPath:selected.path,
     availability:'CANONICAL_PHASE_OR_CAMPAIGN_IDENTITY_MISMATCH'});
    continue;
   }
   const source=historyCanonicalSelectorsV1(canonical);
   const pages=historyCanonicalTextPagesV1(selected.text);
   const key=phase+':'+receiptRevision+':'+expectedSha;
   const entry={...basis,receiptSha256:receipt.file.sha256,
    acceptedEpoch:rd.sealedAt??rd.updatedAt??null,
    originalCanonicalRelativePath:originalRelativePath,
    committedCanonicalPath:selected.path,
    expectedCanonicalSha256:expectedSha,
    actualCanonicalSha256:selected.sha256,
    committedGitBlobSha:selected.gitBlobSha,
    availability:'AVAILABLE',referenceKey:key,
    selectorCount:source.records.length,
    missingOriginalFamilies:source.missingRoots,
    pageCount:pages.length,
    originalCanonicalBytes:Buffer.byteLength(selected.text)};
   rosters.push(entry);
   sources.set(key,{...entry,canonical,originalText:selected.text,
    originalSelectors:source.records,pages});
  }
 }
 return {manifest:{...base,availability:'COLLECTED_NONBLOCKING',
  acceptedCanonicalCount:rosters.length,
  rosters,unavailable},sources};
}

// Lossless read interface for original canonical evidence. This uses the
// existing Phase-1 character-safe paging convention and exact RFC 6901
// selectors. Every bounded response has an explicit continuation cursor;
// arbitrary field names, zero/negative findings and historical revisions are
// never filtered or deduplicated.
function canonicalHistoryEvidenceReadV1(history,request){
 const manifest=history?.manifest??{};
 const req=request&&typeof request==='object'&&!Array.isArray(request)?request:{};
 const base={schemaVersion:'curveyield-mi-original-canonical-read-v1',
  campaignId:manifest.campaignId??campaignId,
  campaignGenerationId:manifest.campaignGenerationId??null,
  auditedSourceSha256:manifest.auditedSourceSha256??null,
  snapshotCommit:manifest.snapshotCommit??null,
  referenceScheme:'RFC6901_JSON_POINTER'};
 if(!history?.sources)
  return {...base,availability:manifest.availability??'ORIGINAL_HISTORY_NOT_RETRIEVED',
   unavailable:manifest.unavailable??[]};
 const offsetFor=(n)=>Number.isSafeInteger(n)&&n>=0?n:0;
 const sliceList=(list,start)=>{
  const rows=list.slice(start,start+25);
  return {start,total:list.length,entries:rows,
   nextStart:start+rows.length<list.length?start+rows.length:null};
 };
 if(req.kind==='ROSTER_INDEX'){
  const result=sliceList(manifest.rosters??[],offsetFor(req.start));
  return {...base,availability:'AVAILABLE',kind:req.kind,...result};
 }
 if(req.kind==='UNAVAILABLE_INDEX'){
  const result=sliceList(manifest.unavailable??[],offsetFor(req.start));
  return {...base,availability:'AVAILABLE',kind:req.kind,...result};
 }
 const ref=typeof req.referenceKey==='string'?req.referenceKey:null;
 const source=history.sources.get(ref);
 if(!source)return {...base,availability:'SOURCE_REFERENCE_NOT_AVAILABLE',
  referenceKey:ref,availableReferenceCount:history.sources.size,
  sourceAvailability:manifest.availability??'UNKNOWN'};
 const identity={referenceKey:source.referenceKey,
  phaseSequence:source.phaseSequence,acceptedRevision:source.acceptedRevision,
  receiptPath:source.receiptPath,receiptSha256:source.receiptSha256,
  originalCanonicalPath:source.originalCanonicalPath,
  committedCanonicalPath:source.committedCanonicalPath,
  originalCanonicalSha256:source.actualCanonicalSha256};
 if(req.kind==='SELECTOR_INDEX'){
  const result=sliceList(source.originalSelectors,offsetFor(req.start));
  return {...base,...identity,availability:'AVAILABLE',kind:req.kind,...result};
 }
 if(req.kind==='PAGE_INDEX'){
  const result=sliceList(source.pages,offsetFor(req.start));
  return {...base,...identity,availability:'AVAILABLE',kind:req.kind,...result};
 }
 if(req.kind==='CANONICAL_PAGE'){
  const page=Number(req.page),spec=source.pages[page-1];
  if(!Number.isSafeInteger(page)||!spec)
   return {...base,...identity,availability:'CANONICAL_PAGE_NOT_FOUND',page:req.page};
  const fragment=source.originalText.slice(spec.start,spec.end);
  return {...base,...identity,availability:'AVAILABLE',kind:req.kind,
   page,pageCount:source.pages.length,start:spec.start,end:spec.end,
   contentSha256:spec.sha256,originalJsonFragment:fragment};
 }
 if(req.kind==='RECORD'){
  // Membership in the full, unfiltered original selector roster prevents
  // reinterpretation of a selector as a different object or historical record.
  const pointer=typeof req.selector==='string'?req.selector:null;
  const located=source.originalSelectors.find(r=>r.selector===pointer);
  if(!located)return {...base,...identity,availability:'SOURCE_SELECTOR_NOT_FOUND',
   selector:pointer};
  let value=source.canonical;
  for(const component of pointer.slice(1).split('/')){
   const token=component.replace(/~1/g,'/').replace(/~0/g,'~');
   if(value===null||typeof value!=='object'||!Object.hasOwn(value,token))
    return {...base,...identity,availability:'SOURCE_SELECTOR_UNREADABLE',
     selector:pointer};
   value=value[token];
  }
  const originalJson=JSON.stringify(value),offset=offsetFor(req.offset);
  if(offset>originalJson.length)return {...base,...identity,
   availability:'RECORD_OFFSET_OUT_OF_RANGE',selector:pointer,offset};
  if(offset>0&&offset<originalJson.length&&
     originalJson.charCodeAt(offset)>=0xDC00&&
     originalJson.charCodeAt(offset)<=0xDFFF)
   return {...base,...identity,
    availability:'RECORD_OFFSET_SPLITS_UNICODE_CHARACTER',
    selector:pointer,nearestValidOffset:offset-1};
  const fragment=phase1EvidencePageV1(originalJson,offset);
  return {...base,...identity,availability:'AVAILABLE',kind:req.kind,
   selector:pointer,originalArrayPosition:located.originalArrayPosition??null,
   originalIdentityFields:located.originalIdentityFields??null,
   originalRecordJsonSha256:sha(originalJson),
   start:fragment.start,end:fragment.end,totalCharacters:originalJson.length,
   hasMore:fragment.end<originalJson.length,
   nextOffset:fragment.end<originalJson.length?fragment.end:null,
   exactOriginalRecordJsonFragment:fragment.text};
 }
 return {...base,...identity,availability:'UNRECOGNIZED_CANONICAL_SOURCE_READ',
  supportedKinds:['ROSTER_INDEX','UNAVAILABLE_INDEX','SELECTOR_INDEX',
   'PAGE_INDEX','CANONICAL_PAGE','RECORD']};
}

async function sourceBoundPhase1EvidenceV1(raw){
 let envelope;
 try{envelope=JSON.parse(raw);}catch{return null;}
 const live=envelope?.workerResponse??{};
 const phase=Number(live.phase),leased=['LEASED_PACKET','LEASED_SHARD'].includes(live.status);
 if(!leased||!Number.isInteger(phase)||phase<2||phase>6)return null;
 const base={schemaVersion:'curveyield-mi-phase1-model-evidence-v1',
  campaignId,phase,sourceRepo:historyRepo,sourceBranch:historyBranch,
  snapshotCommit:historySnapshotCommit,securityInterpretationOwner:'MIMO'};
 if(!/^[0-9a-f]{40}$/.test(String(historySnapshotCommit??'')))
  return {manifest:{...base,availability:'PINNED_CONTROLLER_COMMIT_UNAVAILABLE'},source:null};
 const directory=await historyDirectoryV1();
 if(directory?.campaignId!==campaignId||
    !validHistoryWorkspacePathV1(directory.workspacePath))
  return {manifest:{...base,availability:'CONTROLLER_DIRECTORY_UNAVAILABLE'},source:null};
 if(directory.authorityRelease!=='machine-intelligence-v8'||
    Number(directory.currentAssignment?.phaseSequence)!==phase)
  return {manifest:{...base,availability:'BOUND_V8_ASSIGNMENT_UNAVAILABLE'},source:null};
 const canonicalPath=directory.workspacePath+'/derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json';
 const canonical=await historyJsonV1(canonicalPath).catch(()=>null);
 if(!canonical||canonical.data?.campaignId!==campaignId||
    canonical.data?.phase!==1||!canonical.data?.actions||
    typeof canonical.data.actions!=='object')
  return {manifest:{...base,canonicalPath,availability:'ORIGINAL_CANONICAL_UNAVAILABLE'},source:null};
 const receipts=await historyPhase1ReceiptPathsV1(directory.workspacePath).catch(()=>null);
 if(!receipts)
  return {manifest:{...base,canonicalPath,canonicalSha256:canonical.file.sha256,
   availability:'PHASE1_RECEIPT_INDEX_UNAVAILABLE'},source:null};
 let acceptedReceiptPath=null;
 for(const path of receipts){
  const receipt=await historyJsonV1(path).catch(()=>null);
  const data=receipt?.data;
  if(data?.campaign?.campaignId!==campaignId||
     data?.campaign?.campaignGenerationId!==directory.campaignGenerationId||
     data?.phase?.sequence!==1||
     !['SEALED','COMPLETE'].includes(data?.phase?.status)||
     data?.source?.sha256!==directory.sourceSha256)continue;
  if([...(data.evidence??[]),...(data.outputs??[])].some(ref=>
      ref?.role==='PHASE_CANONICAL_DATA'&&
      ref.path==='derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json'&&
      ref.sha256===canonical.file.sha256)){
   acceptedReceiptPath=path;break;
  }
 }
 if(!acceptedReceiptPath)
  return {manifest:{...base,canonicalPath,canonicalSha256:canonical.file.sha256,
   availability:'CANONICAL_NOT_BOUND_TO_ACCEPTED_PHASE1_RECEIPT'},source:null};
 const definitions=[
  {discoveryPass:'D4',step:'step-4',field:'standardsAssessments',key:'standardKey'},
  {discoveryPass:'D6',step:'step-5',field:'riskDrivers',key:'driverKey'},
  {discoveryPass:'D7',step:'step-6',field:'phase1Limitations',key:null}
 ];
 const records=[],collections=[];
 for(const def of definitions){
  const values=canonical.data.actions?.[def.step]?.outputs?.[def.field];
  collections.push({discoveryPass:def.discoveryPass,
   sourceSelector:'actions.'+def.step+'.outputs.'+def.field,
   recordCount:Array.isArray(values)?values.length:null,
   availability:Array.isArray(values)?'AVAILABLE':'SOURCE_COLLECTION_UNAVAILABLE'});
  if(!Array.isArray(values))continue;
  values.forEach((value,index)=>{
   const selector='actions.'+def.step+'.outputs.'+def.field+'['+index+']';
   const key=def.key&&value&&typeof value==='object'&&!Array.isArray(value)?
    value[def.key]??null:null;
   records.push({discoveryPass:def.discoveryPass,selector,sourceIndex:index,
    recordKey:key,recordJsonSha256:sha(JSON.stringify(value))});
  });
 }
 const allOutputSelectors=Object.entries(canonical.data.actions).flatMap(([step,action])=>
  Object.keys(action?.outputs??{}).map(field=>'actions.'+step+'.outputs.'+field));
 const originalText=canonical.file.text;
 const pageOffsets=[];
 for(let start=0;start<originalText.length;){
  const fragment=phase1EvidencePageV1(originalText,start);
  pageOffsets.push({page:pageOffsets.length+1,start,end:fragment.end,
   sha256:sha(fragment.text)});
  start=fragment.end;
 }
 const manifest={...base,availability:'AVAILABLE',canonicalPath,
  canonicalSha256:canonical.file.sha256,sourceSha256:directory.sourceSha256,
  acceptedReceiptPath,canonicalBytes:Buffer.byteLength(originalText),
  allOutputSelectors,leadCollections:collections,
  leadIndex:{recordCount:records.length,initialRefs:records.slice(0,16),
   initialRefsAreComplete:records.length<=16,
   nextIndexStart:records.length>16?16:null,
   retrieveAll:'{"sourceEvidenceRequest":{"kind":"INDEX","start":0}}'},
  canonicalPages:{count:pageOffsets.length,firstPageRefs:pageOffsets.slice(0,16),
   firstPageRefsAreComplete:pageOffsets.length<=16,
   nextPageIndexStart:pageOffsets.length>16?16:null,
   exactOriginalBytes:true},
  ...(pageOffsets.length===1?{completeCanonicalText:originalText}:{}),
  retrievalInstructions:{
   index:'{"sourceEvidenceRequest":{"kind":"INDEX","start":0}}',
   originalPageIndex:'{"sourceEvidenceRequest":{"kind":"PAGE_INDEX","start":0}}',
   record:'{"sourceEvidenceRequest":{"kind":"RECORD","selector":"actions.step-5.outputs.riskDrivers[0]","offset":0}}',
   originalPage:'{"sourceEvidenceRequest":{"kind":"CANONICAL_PAGE","page":1}}',
   note:'These are local evidence reads, not Worker submissions. Fetch all original records needed for this investigation. Return the normal Worker-required route/request JSON after reading. No source excerpt is an audit conclusion.'
  }};
 return {manifest,source:{canonical:canonical.data,originalText,pageOffsets,records,canonicalPath,
  canonicalSha256:canonical.file.sha256}};
}
function sourceEvidenceRequestV1(raw,evidence){
 let answer;
 try{answer=JSON.parse(raw);}catch{return null;}
 if(!answer||typeof answer!=='object'||Array.isArray(answer)||
    answer.route!==undefined||!answer.sourceEvidenceRequest)return null;
 const req=answer.sourceEvidenceRequest,source=evidence?.source;
 const base={schemaVersion:'curveyield-mi-phase1-evidence-read-v1',
  availability:source?'AVAILABLE':'SOURCE_UNAVAILABLE',
  canonicalPath:evidence?.manifest?.canonicalPath??null,
  canonicalSha256:evidence?.manifest?.canonicalSha256??null};
 if(!source)return {...base,reason:evidence?.manifest?.availability??'NOT_ISSUED'};
 if(req.kind==='INDEX'){
  const start=Number.isSafeInteger(req.start)&&req.start>=0?req.start:0;
  const refs=source.records.slice(start,start+25);
  return {...base,kind:'INDEX',start,total:source.records.length,
   originalRefs:refs,nextStart:start+refs.length<source.records.length?start+refs.length:null};
 }
 if(req.kind==='PAGE_INDEX'){
  const start=Number.isSafeInteger(req.start)&&req.start>=0?req.start:0;
  const pages=source.pageOffsets.slice(start,start+25);
  return {...base,kind:'PAGE_INDEX',start,total:source.pageOffsets.length,
   originalPageRefs:pages,nextStart:start+pages.length<source.pageOffsets.length?start+pages.length:null};
 }
 if(req.kind==='CANONICAL_PAGE'){
  const page=Number(req.page),spec=source.pageOffsets[page-1];
  if(!Number.isInteger(page)||!spec)return {...base,availability:'PAGE_NOT_FOUND',page};
  const fragment=source.originalText.slice(spec.start,spec.end);
  return {...base,kind:'CANONICAL_PAGE',page,pageCount:source.pageOffsets.length,
   start:spec.start,end:spec.end,contentSha256:spec.sha256,originalJsonFragment:fragment};
 }
 if(req.kind==='RECORD'){
  const match=typeof req.selector==='string'?
   req.selector.match(/^actions\.(step-[1-9]\d*)\.outputs\.([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/):null;
  if(!match)return {...base,availability:'SELECTOR_NOT_FOUND'};
  const selected=source.canonical.actions?.[match[1]]?.outputs?.[match[2]];
  const value=match[3]!==undefined&&Array.isArray(selected)?
   selected[Number(match[3])]:match[3]===undefined?selected:undefined;
  if(value===undefined)return {...base,availability:'SELECTOR_NOT_FOUND',selector:req.selector};
  const complete=JSON.stringify(value),start=Number.isSafeInteger(req.offset)&&req.offset>=0?req.offset:0;
  if(start>complete.length)return {...base,availability:'OFFSET_OUT_OF_RANGE',selector:req.selector};
  if(start>0&&start<complete.length&&
     complete.charCodeAt(start)>=0xDC00&&complete.charCodeAt(start)<=0xDFFF)
   return {...base,availability:'OFFSET_SPLITS_UNICODE_CHARACTER',
    selector:req.selector,nearestValidOffset:start-1};
  const fragment=phase1EvidencePageV1(complete,start);
  return {...base,kind:'RECORD',selector:req.selector,recordJsonSha256:sha(complete),
   start:fragment.start,end:fragment.end,totalCharacters:complete.length,
   hasMore:fragment.end<complete.length,nextOffset:fragment.end<complete.length?fragment.end:null,
   exactRecordJsonFragment:fragment.text};
 }
 return {...base,availability:'UNRECOGNIZED_SOURCE_READ',
  supportedKinds:['INDEX','PAGE_INDEX','RECORD','CANONICAL_PAGE']};
}
// Generic recovery for EVERY phase, numbered step and interaction substep.
// Reissue the most recently provided original instructions and exact source-bound
// forms; never maintain hand-written per-phase instructions in this adapter.
function adapterRecovery(reason,rejectedRaw,lastStepRaw,lastAuthorityRaw,lastClaimRaw){
 const parse=raw=>{try{const v=JSON.parse(raw);return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}};
 const prior=parse(lastStepRaw),rejected=parse(rejectedRaw),claim=parse(lastClaimRaw);
 const state=prior.workerResponse||{},err=rejected.workerResponse||{},issued=claim.workerResponse||{};
 const generic=!err.status||new Set(['MODEL_RESPONSE_NOT_JSON','INVALID_WORKER_ACTION',
  'INVALID_SOURCE_ACTION','WORKER_RESPONSE_NOT_JSON','ERROR']).has(err.status);
 const status=generic?(state.status||err.status||'UNKNOWN'):err.status;
 const engagement=err.engagement||state.engagement||issued.engagement||{};
 const stage=engagement.stage||null;
 const instruction=err.instructionCompletionForm||engagement.instructionCompletionForm||state.instructionCompletionForm||null;
 const review=err.reviewForm||engagement.reviewForm||state.reviewForm||null;
 const remediation=err.remediationForm||engagement.remediationForm||state.remediationForm||null;
 const units=issued.status==='LEASED_SHARD'?[issued]:issued.status==='LEASED_PACKET'?(issued.items||[]):[];
 const unit=units[0]||null;
 const route='/api/process';let request={campaignId},guidance='Call Process for the next source-bound action.';
 if(status==='INSTRUCTION_SUBSTEP_FORM_REQUIRED'||stage==='INSTRUCTIONS'){
  if(instruction){
   request={campaignId,form:instruction};
   guidance='Study and understand all instruction documents FIRST. Then replace the three ANSWER placeholders with substantive answers to the exact issued QUESTION A/B/C. Keep the STOP warning, prefilled questions and four identity fields unchanged. Return the COMPLETE Instruction Sub-Step Completion Form using Process. No work files may be requested before completion.';
  }else guidance='Call Process with campaignId only to recover the original Instruction Sub-Step Completion Form; do not invent questions.';
 }else if(status==='REVIEW_SUBSTEP_READY'||status==='REVIEW_SUBSTEP_REQUIRED'||stage==='REVIEW'){
  if(review){
   request={campaignId,form:review};
   guidance='Complete all five original review question answers and AT LEAST THREE distinct issues requiring repairs or deeper analysis in CHECKLIST BUILDING. Keep the issued questions and identity fields unchanged. Return the single completed Review Sub-Step Completion Form using Process.';
  }else guidance='Call Process with campaignId only to recover the original Review Sub-Step Completion Form.';
 }else if(status==='REMEDIATION_SUBSTEP_READY'||status==='REMEDIATION_SUBSTEP_FORM_REQUIRED'||stage==='REMEDIATION'){
  if(remediation){
   request={campaignId,form:remediation};
   guidance='Perform actual source-bound repairs or deeper analysis, submit genuinely revised work, describe the correction and reference the exact changed or added work for EVERY repair item. Fill all closing question answers, then submit the single complete Remediation Sub-Step Completion Form through Process. Never fabricate work or references.';
  }else guidance='Call Process with campaignId only to recover the original Remediation Sub-Step Completion Form.';
 }else if(unit){
  request={campaignId,action:'submit',unitId:unit.unitId,lease:unit.lease,
   ...(unit.inputFileTemplate?{shard:unit.inputFileTemplate}:{})};
  guidance='Fill the original source-bound work file with genuine analysis and preserve all protected identifiers. Submit the entire completed file through Process, not a blank template.';
 }else if(stage==='WORK'){
  request={campaignId,action:'claim'};
  guidance='Use Process to invoke the existing authorized claim action; do not invent lease or unit identifiers.';
 }
 return {type:'MIMO_ADAPTER_ACTION_RECOVERY',reason,campaignId,
  phase:state.phase??issued.phase??prior.governingDocuments?.phase??null,
  step:state.currentStep??state.step??issued.step??prior.governingDocuments?.step??null,
  stage,rejectedWorkerStatus:status,requiredNextCommand:{route,request},
  lastControllerInstructions:lastAuthorityRaw||lastStepRaw,
  lastIssuedStepResponse:lastStepRaw,
  originalRequiredForms:{instructionCompletionForm:instruction,reviewForm:review,remediationForm:remediation,
   issuedWorkForms:units.map(u=>({unitId:u.unitId,lease:u.lease,
    canonicalPath:u.canonicalPath||u.descriptor?.path||null,
    inputFileTemplate:u.inputFileTemplate||null,validationSchema:u.validationSchema||null}))},
  originalWorkerRejection:rejected,
  instruction:guidance+' Preserve original controller evidence and acceptance requirements. Return ONLY one complete JSON object with route and request.'};
}
function incompatibleWorkerReply(raw){
 let e;try{e=JSON.parse(raw);}catch{return true;}
 if(['AI_BRIDGE_MODEL_FORMAT_REJECTED','AI_BRIDGE_MODEL_ACTION_REJECTED'].includes(e?.status))
  return true;
 if(['MODEL_RESPONSE_NOT_JSON','INVALID_WORKER_ACTION','INVALID_SOURCE_ACTION',
     'FINISH_REJECTED_ACTIVE_CONTROLLER_ASSIGNMENT'].includes(e?.workerResponse?.status))
  return true;
 return e?.status==='AI_BRIDGE_WORKER_RESPONSE'&&
  Number(e.workerHttpStatus)>=400;
}

function assignmentScope(response){
 let outer;
 try{outer=JSON.parse(response);}catch{return null;}
 const w=outer?.workerResponse;
 if(!w||typeof w!=='object')return null;
 const p=Number(w.phase??outer.governingDocuments?.phase);
 const s=Number(w.currentStep??w.step??outer.governingDocuments?.step);
 if(!Number.isInteger(p)||!Number.isInteger(s))return null;
 const unit=w.status==='LEASED_SHARD'?
  w.unitId+':'+w.lease:w.status==='LEASED_PACKET'?
  (w.items||[]).map(x=>x.unitId+':'+x.lease).join(','):null;
 return {step:[p,s,w.stage||''].join(':'),unit};
}

let workerResponse=await workerCall({operation:'start'});
// Keep every MiMo-produced command and every Worker response presented to MiMo
// unchanged. Poll-only controller wait states do not become model prompts.
const dialogue=[];
let lastOwner=null,waitingSince=0,lastWaitReport=0;
let lastStepScope=null,lastUnitScope=null;
let lastAuthorityRaw=null,lastClaimRaw=null,lastIssuedResponseRaw=null,pendingRecovery=null;
let activePhase1Evidence=null;
let activeCanonicalHistory=null;
let consecutiveRejections=0,lastRejectedFingerprint=null;
while(true){
 // Acquire the exact controller-issued work form before model analysis whenever
 // engagement has reached WORK. This does not synthesize model-authored work.
 let envelope=null;
 try{envelope=JSON.parse(workerResponse);}catch{}
 const current=envelope?.workerResponse||{};
 if(envelope?.status==='AI_BRIDGE_WORKER_RESPONSE'&&
    current.status==='ACTIVE'&&current.engagement?.stage==='WORK'&&
    current.availableProcessActions?.includes('claim')&&
    (current.unitCounts?.available>0||current.unitCounts?.leased>0)){
   // Authoritative Worker owns abandoned-lease recovery; sampled GitHub-side
   // ownership counts must not prevent an attempted authenticated claim.
   const issued=await workerCall({operation:'claim'});
   let data=null;
   try{data=JSON.parse(issued)?.workerResponse;}catch{}
   if(!['LEASED_SHARD','LEASED_PACKET'].includes(data?.status)){
     if(['AI_LEASE_RECOVERY_BLOCKED','AI_LEASE_HELD_BY_ACTIVE_RUN',
         'NO_AVAILABLE_SHARD','NO_UNREVISED_WORK_UNITS'].includes(data?.status)){
       console.log(JSON.stringify({status:'MIMO_WORKER_LEASE_WAIT',
         workerStatus:data.status,phase:data.phase??null,step:data.step??null,
         reason:data.reason??data.nextAction??'Awaiting authoritative Worker lease availability',
         noGithubSideLeaseVeto:true}));
       await new Promise(resolve=>setTimeout(resolve,60000));
       workerResponse=await workerCall({operation:'start'});
       continue;
     }
     throw Error('MIMO_CLAIM_RECOVERY_REQUIRED: '+String(data?.status||'UNPARSEABLE')+
       '; inspect exact Worker response; no fabricated submission');
   }
   console.log(JSON.stringify({status:'MIMO_CONTROLLER_CLAIM_ACQUIRED',
     unitId:data.unitId??null,packetItems:data.items?.length??null,
     phase:data.phase,step:data.step,preservedNativeForm:true,
     modelAuthoredAction:false}));
   workerResponse=issued;
 }
 const ownership=ownerOfWorkerReply(workerResponse);
 if(ownership.owner!==lastOwner){
  console.log(JSON.stringify({status:'MIMO_EXECUTION_OWNER',
   owner:ownership.owner,workerStatus:ownership.status,
   phase:ownership.phase,step:ownership.step,stage:ownership.stage,
   tokenWatchdogActive:ownership.owner==='MIMO'}));
  lastOwner=ownership.owner;
 }
 if(ownership.owner==='COMPLETE'){
  console.log(JSON.stringify({status:'AI_BRIDGE_MODEL_FINISHED',
   campaignId,controllerAccepted:false,
   instruction:'Verify controller acceptance independently; model completion alone is not a seal.'}));
  break;
 }
 if(ownership.owner==='WORKER_CONTROLLER'){
  if(!waitingSince)waitingSince=Date.now();
  if(!lastWaitReport||Date.now()-lastWaitReport>=5*60*1000){
   console.log(JSON.stringify({status:'MIMO_EXTERNAL_WORK_WAIT',
    workerStatus:ownership.status,phase:ownership.phase,step:ownership.step,
    waitSeconds:Math.round((Date.now()-waitingSince)/1000),
    tokenWatchdogActive:false,
    nextAction:'Read exact Worker controller state; no model inference while awaiting accepted dependency'}));
   lastWaitReport=Date.now();
  }
  // Hour-long controller executions are valid. The inference inactivity
  // threshold is not running during these authoritative external waits.
  await new Promise(resolve=>setTimeout(resolve,60000));
  workerResponse=await workerCall({operation:'start'});
  continue;
 }
 waitingSince=0;lastWaitReport=0;
 // Scope MiMo's active conversation to the live controller step and
 // currently issued original packet. Old packets/replies remain immutable
 // in Worker storage, not repeatedly reprocessed in every later prompt.
 const scope=assignmentScope(workerResponse);
 if(!pendingRecovery&&scope&&(scope.step!==lastStepScope||
    scope.unit!==null&&scope.unit!==lastUnitScope)){
  dialogue.length=0;
  alreadyProvidedStepInstructions.clear();
  lastAuthorityRaw=null;lastClaimRaw=null;lastIssuedResponseRaw=null;pendingRecovery=null;
  activePhase1Evidence=null;
  activeCanonicalHistory=null;
  consecutiveRejections=0;lastRejectedFingerprint=null;
 }
 if(scope){lastStepScope=scope.step;if(scope.unit!==null)lastUnitScope=scope.unit;}
 if(pendingRecovery){
  // The Worker rejected the prior reply: replay original issued instructions,
  // form and the exact next action rather than send another generic status.
  dialogue.push({role:'user',content:JSON.stringify(pendingRecovery)});
  pendingRecovery=null;
 }else{
  const modelInstructions=modelFacingResponse(workerResponse);
  // Keep the last real Worker-issued step response even after any number of
  // incompatible model turns. A rejected model action is NOT a new instruction.
  lastIssuedResponseRaw=workerResponse;
  dialogue.push({role:'user',content:modelInstructions});
  // Load the original immutable question checkpoints ONLY for a newly issued
  // claim, not on every follow-up response. This does not modify the Worker
  // response or the controller-issued submission form.
  const priorEvidence=await sourceBoundQuestionHistoryV1(workerResponse)
   .catch(error=>({schemaVersion:'curveyield-ai-question-evidence-delivery-v1',
    campaignId,histories:[],unavailable:[{status:'GITHUB_READ_UNAVAILABLE',
     detail:String(error?.message??error).slice(0,160)}]}));
  if(priorEvidence){
   dialogue.push({role:'user',content:JSON.stringify(priorEvidence)});
   console.log(JSON.stringify({status:'MIMO_SOURCE_QUESTION_HISTORY_DELIVERED',
    phase:priorEvidence.histories?.at(-1)?.phaseSequence??null,
    histories:priorEvidence.histories?.length??0,
    checkpoints:priorEvidence.histories?.reduce((n,h)=>n+h.checkpoints.length,0)??0,
    unavailable:priorEvidence.unavailable?.length??0,
    originalTextPreserved:true,privateContent:'MODEL_INPUT_ONLY'}));
  }
  // Independently retrieve ORIGINAL accepted canonical records at the same
  // committed snapshot as the checkpoint family. Step 4 will reconstruct
  // model-facing delivery; these verified records stay private to this bridge.
  activeCanonicalHistory=await sourceBoundCanonicalHistoryV1(workerResponse)
   .catch(error=>({manifest:{
    schemaVersion:'curveyield-mi-original-canonical-history-v1',
    campaignId,snapshotCommit:historySnapshotCommit,
    availability:'GITHUB_ORIGINAL_CANONICAL_READ_UNAVAILABLE',
    rosters:[],unavailable:[{availability:'GITHUB_ORIGINAL_CANONICAL_READ_UNAVAILABLE',
     detail:String(error?.message??error)}]},sources:new Map()}));
  if(activeCanonicalHistory){
   console.log(JSON.stringify({status:'MIMO_ACCEPTED_CANONICAL_HISTORY_RETRIEVED',
    activePhase:activeCanonicalHistory.manifest.activePhase??null,
    pinnedCommit:activeCanonicalHistory.manifest.snapshotCommit??null,
    sourceIdentity:activeCanonicalHistory.manifest.auditedSourceSha256??null,
    availability:activeCanonicalHistory.manifest.availability,
    originalRevisions:activeCanonicalHistory.manifest.rosters?.length??0,
    originalValues:[...(activeCanonicalHistory.sources?.values()??[])]
     .reduce((n,x)=>n+x.originalSelectors.length,0),
    unavailable:activeCanonicalHistory.manifest.unavailable?.length??0,
    noGithubSecurityDisposition:true,
    modelFacingDelivery:'DEFERRED_TO_STEP_4',
    privateContent:'LOCAL_GITHUB_HISTORY_ONLY'}));
  }
  // A mere canonical filename in derivedInputPaths is not model access.
  // Fetch the accepted original source privately at the pinned controller commit.
  activePhase1Evidence=await sourceBoundPhase1EvidenceV1(workerResponse)
   .catch(error=>({manifest:{schemaVersion:'curveyield-mi-phase1-model-evidence-v1',
    campaignId,availability:'GITHUB_EVIDENCE_READ_UNAVAILABLE',
    detail:String(error?.message??error).slice(0,160)},source:null}));
  if(activePhase1Evidence){
   dialogue.push({role:'user',content:JSON.stringify(activePhase1Evidence.manifest)});
   console.log(JSON.stringify({status:'MIMO_PHASE1_EVIDENCE_MODEL_CONTEXT',
    phase:Number(JSON.parse(workerResponse)?.workerResponse?.phase),
    availability:activePhase1Evidence.manifest.availability,
    canonicalSha256:activePhase1Evidence.manifest.canonicalSha256??null,
    sourcePages:activePhase1Evidence.source?.pageOffsets.length??0,
    leadRefs:activePhase1Evidence.source?.records.length??0,
    modelFacingOriginalText:typeof activePhase1Evidence.manifest.completeCanonicalText==='string',
    privateContent:'MODEL_INPUT_ONLY'}));
  }
  let issued=null;
  try{issued=JSON.parse(workerResponse);}catch{}
  const native=issued?.workerResponse||{};
  if(issued?.governingDocuments?.repositoryAgentPolicy?.content&&
     issued?.governingDocuments?.currentPhaseStartHere?.content)
   lastAuthorityRaw=modelInstructions;
  if(['LEASED_SHARD','LEASED_PACKET'].includes(native.status))
   lastClaimRaw=workerResponse;
 }
 let raw=await modelCall(dialogue);
 // Evidence read requests are local to MiMo's private GitHub inference bridge.
 // Only the eventual original route/request answer is sent to the Worker.
 // Retain two recent exact reads in the bounded model context. Older reads stay
 // intact in the private transcript and can be re-requested by exact selector.
 const evidenceReadPairs=[];
 for(let read=sourceEvidenceRequestV1(raw,activePhase1Evidence);read;
     read=sourceEvidenceRequestV1(raw,activePhase1Evidence)){
  if(evidenceReadPairs.length===2){
   const at=evidenceReadPairs.shift();
   dialogue.splice(at,2);
   for(let i=0;i<evidenceReadPairs.length;i++)evidenceReadPairs[i]-=2;
  }
  evidenceReadPairs.push(dialogue.length);
  dialogue.push({role:'assistant',content:raw});
  dialogue.push({role:'user',content:JSON.stringify(read)});
  console.log(JSON.stringify({status:'MIMO_PHASE1_EVIDENCE_PAGE_DELIVERED',
   kind:read.kind??null,availability:read.availability,
   sourceSha256:read.canonicalSha256??null,
   selector:read.selector??null,page:read.page??null,
   noWorkerSubmission:true,privateContent:'MODEL_INPUT_ONLY'}));
  raw=await modelCall(dialogue);
 }
 dialogue.push({role:'assistant',content:raw});
 const previouslyIssued=workerResponse;
 workerResponse=await workerCall({operation:'reply',modelOutput:raw});
 if(incompatibleWorkerReply(workerResponse)){
  const fingerprint=sha(raw);
  consecutiveRejections++;
  if(lastRejectedFingerprint===fingerprint||consecutiveRejections>4)
   throw Error('MIMO_REPEATED_INCOMPATIBLE_ACTION: exact Worker rejection '+
    'persists after correction; preserve controller records and diagnose '+
    'before retrying. Last model output SHA256 '+fingerprint);
  lastRejectedFingerprint=fingerprint;
  // A 4xx rejection can still issue a real review/repair form. Preserve that
  // authoritative stage form for subsequent corrective turns.
  let errorState=null;
  try{errorState=JSON.parse(workerResponse)?.workerResponse;}catch{}
  if(errorState&&(errorState.reviewQuestionsForm||errorState.repairCheckboxForm))
   lastIssuedResponseRaw=workerResponse;
  pendingRecovery=adapterRecovery('Worker rejected incompatible model reply',
   workerResponse,lastIssuedResponseRaw||previouslyIssued,lastAuthorityRaw,lastClaimRaw);
  console.log(JSON.stringify({status:'MIMO_INCOMPATIBLE_REPLY_RECOVERY_ISSUED',
   campaignId,phase:pendingRecovery.phase,step:pendingRecovery.step,
   stage:pendingRecovery.stage,
   nextRoute:pendingRecovery.requiredNextCommand.route,
   nextAction:pendingRecovery.requiredNextCommand.request.action||null,
   originalInstructionsReplayed:true,
   issuedOriginalForms:pendingRecovery.originalRequiredForms.issuedWorkForms.length,
   rejectionCount:consecutiveRejections,privateContent:'MODEL_ONLY'}));
 }else{
  consecutiveRejections=0;lastRejectedFingerprint=null;
 }
}
