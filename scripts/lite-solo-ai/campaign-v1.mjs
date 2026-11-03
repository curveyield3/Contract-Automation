#!/usr/bin/env node
// Lite-Solo MiMo / Worker transport bridge v23.
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
   res.on('error',reject);
   res.on('end',()=>{
    if(res.statusCode!==200){
     reject(Error('MiMo HTTP '+res.statusCode+': '+Buffer.concat(chunks).toString('utf8').slice(0,600)));
     return;
    }
    try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
    catch{reject(Error('MiMo HTTP envelope was not JSON'));}
   });
  });
  req.on('error',reject);
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

const initial=await workerCall({operation:'start'});
// Full, unmodified Worker response and full, unmodified MiMo replies.
// The adapter adds no prompt instructions, condensations or synthetic evidence.
const dialogue=[{role:'user',content:initial}];
while(true){
 const raw=await modelCall(dialogue);
 const workerResponse=await workerCall({operation:'reply',modelOutput:raw});
 dialogue.push({role:'assistant',content:raw},{role:'user',content:workerResponse});
 let status;
 try{status=JSON.parse(workerResponse)?.status;}
 catch{throw Error('Worker reply was not valid JSON; no response discarded');}
 if(status==='AI_BRIDGE_MODEL_REQUESTED_FINISH'){
  console.log(JSON.stringify({status:'AI_BRIDGE_MODEL_FINISHED',
   campaignId,controllerAccepted:false,
   instruction:'Verify controller acceptance independently; model completion alone is not a seal.'}));
  break;
 }
}
