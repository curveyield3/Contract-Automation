#!/usr/bin/env node
// Lite-Solo MiMo / Worker transport bridge v26.
// No local audit policy, prompt rewriting, evidence filtering, form filling,
// semantic validation, corrective inference or controller state mutation.
// The Worker is the sole source of instructions, tool calls and acceptance.
import http from 'node:http';
import {createHash} from 'node:crypto';

const campaignId=process.env.AUDIT_AI_CAMPAIGN_ID;
const endpoint='https://lite-solo-api.jamesnexus9999.workers.dev/api/ai/bridge';
const audience='urn:curveyield:lite-solo:github-actions-ai:v1';
const identityEndpoint=process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const identityBearer=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
if(!/^[A-Za-z0-9_.-]+-r[0-9]+$/.test(campaignId||'')||
   !identityEndpoint||!identityBearer||
   process.env.GITHUB_REPOSITORY!=='curveyield3/Contract-Automation'||
   process.env.GITHUB_REF!=='refs/heads/main'||
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

async function workerCall(payload){
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
 'FILING_STEP'
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

let workerResponse=await workerCall({operation:'start'});
// Keep every MiMo-produced command and every Worker response presented to MiMo
// unchanged. Poll-only controller wait states do not become model prompts.
const dialogue=[];
let lastOwner=null,waitingSince=0,lastWaitReport=0;
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
   const readiness=current.leaseReadiness;
   if(current.unitCounts.available===0&&readiness?.foreignLeased>0&&
      readiness.ownLeased===0)
     throw Error('MIMO_FOREIGN_LEASE_BLOCKED: '+readiness.foreignUnitIds.join(', ')+
       ' is leased by another caller. Existing admin step_release required.');
   const issued=await workerCall({operation:'claim'});
   let data=null;
   try{data=JSON.parse(issued)?.workerResponse;}catch{}
   if(!['LEASED_SHARD','LEASED_PACKET'].includes(data?.status))
     throw Error('MIMO_CLAIM_RECOVERY_REQUIRED: '+String(data?.status||'UNPARSEABLE')+
       '; diagnose exact Worker's ownership/acceptance, no fabricated submission');
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
 // The existing Worker response is passed verbatim only when MiMo can act.
 dialogue.push({role:'user',content:workerResponse});
 const raw=await modelCall(dialogue);
 dialogue.push({role:'assistant',content:raw});
 workerResponse=await workerCall({operation:'reply',modelOutput:raw});
}
