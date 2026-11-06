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
let historyCacheScope=null;
async function historyGithubFileV1(rel){
 if(typeof rel!=='string'||!rel.startsWith('campaigns/')||
    rel.includes('\\')||rel.split('/').some(s=>!s||s==='.'||s==='..'))
  return null;
 if(historyFileCache.has(rel))return historyFileCache.get(rel);
 const token=process.env.AUDIT_CONTROLLER_GITHUB_TOKEN;
 if(!token)return null;
 const suffix=rel.split('/').map(encodeURIComponent).join('/');
 const url='https://api.github.com/repos/'+historyRepo+'/contents/'+suffix+
  '?ref='+encodeURIComponent(historyBranch);
 const res=await fetch(url,{headers:{
  authorization:'Bearer '+token,accept:'application/vnd.github+json',
  'x-github-api-version':'2022-11-28'
 },signal:AbortSignal.timeout(30000)});
 if(res.status===404){
  historyFileCache.set(rel,null);
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
 const file={path:rel,sha256:sha(bytes),text:bytes.toString('utf8')};
 historyFileCache.set(rel,file);
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
 // Keep immutable records and negative probes within one issued step, but
 // refresh at each stage transition. Exact newly referenced dependencies are
 // refreshed separately, so late checkpoints are not hidden by an older 404.
 const phase=Number(live.phase);
 const scope=[phase,live.step??live.currentStep??'',live.stage??''].join(':');
 if(scope!==historyCacheScope){
  historyCacheScope=scope;historyFileCache.clear();
 }
 if(!Number.isInteger(phase)||phase<4)return null;
 const directoryRel='Audit Campaign Directory/campaigns/'+
  campaignId.replace(/-r[0-9]+$/,'')+'.json';
 // The directory is outside campaigns/: only this exact source-owned name
 // is permitted, without making its bytes accessible to public logs.
 const getDirectory=async()=>{
  const token=process.env.AUDIT_CONTROLLER_GITHUB_TOKEN;
  if(!token)return null;
  const url='https://api.github.com/repos/'+historyRepo+'/contents/'+
   directoryRel.split('/').map(encodeURIComponent).join('/')+
   '?ref='+encodeURIComponent(historyBranch);
  const result=await fetch(url,{headers:{
   authorization:'Bearer '+token,accept:'application/vnd.github+json',
   'x-github-api-version':'2022-11-28'
  },signal:AbortSignal.timeout(30000)});
  if(!result.ok)return null;
  const body=await result.json();
  if(body.encoding!=='base64'||typeof body.content!=='string')return null;
  return JSON.parse(Buffer.from(body.content.replace(/\s/g,''),'base64').toString('utf8'));
 };
 const directory=await getDirectory();
 if(!directory||directory.campaignId!==campaignId||
    !/^campaigns\/[A-Za-z0-9._/-]+$/.test(directory.workspacePath??'')||
    (directory.workspacePath??'').split('/').some(s=>!s||s==='.'||s==='..'))
  return {schemaVersion:'curveyield-ai-question-evidence-delivery-v1',
   campaignId,histories:[],unavailable:[{status:'CONTROLLER_DIRECTORY_UNAVAILABLE'}]};
 const workspace=directory.workspacePath,selected=new Map(),unavailable=[];
 const dependencies=new Set((live.status==='LEASED_PACKET'?
  (live.items??[]).flatMap(unit=>unit.canonicalPacket?.dependencies??[]):
  live.canonicalPacket?.dependencies??[]).filter(id=>
  typeof id==='string'&&/^[A-Za-z0-9._-]+$/.test(id)));
 for(const unitId of dependencies)
  historyFileCache.delete(workspace+'/work/phase-'+String(phase).padStart(2,'0')+
   '/units/'+unitId+'/questions/QUESTION_INDEX_v1.json');
 for(const p of [4,5,6]){
  if(p>phase)continue;
  const name=String(p).padStart(2,'0'),base=workspace+'/work/phase-'+name+'/units';
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
  description:'Exact committed source-bound investigative question and answer records; not inferred formal audit conclusions.',
  histories:records,unavailable
 }:null;
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
  let issued=null;
  try{issued=JSON.parse(workerResponse);}catch{}
  const native=issued?.workerResponse||{};
  if(issued?.governingDocuments?.repositoryAgentPolicy?.content&&
     issued?.governingDocuments?.currentPhaseStartHere?.content)
   lastAuthorityRaw=modelInstructions;
  if(['LEASED_SHARD','LEASED_PACKET'].includes(native.status))
   lastClaimRaw=workerResponse;
 }
 const raw=await modelCall(dialogue);
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
