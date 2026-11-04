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
import {readJson, writeJson, repoFile, loadPhaseSchema, validateBoundAuthorityV1} from './lib/lite-solo-phase-work-v1.mjs';
import {processUnitRequestV1} from './lib/lite-solo-unit-queue-v1.mjs';
import {generateV7ExecutionRequestV1} from './lib/lite-phase5-request-generation-v1.mjs';
import {verifyPhase0ForkStateV1} from '../packages/github-native-sim/src/phase0-fork-state-reuse-v1.mjs';

const OP = process.env.FORK_OPERATION;
const payload = JSON.parse(process.env.FORK_PAYLOAD_JSON || '{}');
const correlationId = process.env.FORK_CORRELATION_ID || '';
const secret = process.env.FORK_CALLBACK_TOKEN;
const ROOT = path.resolve('.audit-controller');
let AUTH = 'Audit Skill - Lite-Solo Authority/lite-solo-v5';
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
  strict(directory.mode==='LITE_SOLO'&&['lite-solo-v5','lite-solo-v6'].includes(directory.authorityRelease),'not a supported Lite-Solo campaign');
  AUTH='Audit Skill - Lite-Solo Authority/'+directory.authorityRelease;
  strict(directory.authorityDigest===payload.authority_digest,'bound authority digest mismatch');
  safePath(directory.workspacePath);
  cmd('bash',['scripts/lite-solo-checkout-bound-controller-v1.sh','.audit-controller',MACHINE_REF,directory.workspacePath]);
  const local=read(target);
  strict(local.campaignId===id&&local.campaignGenerationId===payload.generation_id,'checkout selected a different campaign');
  strict(local.workspacePath===directory.workspacePath,'campaign workspace path changed');
  const p0=read(local.workspacePath+'/receipts/PHASE_00_RECEIPT_v1.json');
  strict(p0.phase?.status==='SEALED'&&p0.validation?.status==='PASS','Phase-0 prerequisite is not SEALED PASS');
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
  strict(read(receiptPath).validation?.status==='PASS','Phase-10 terminal receipt was not accepted');
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
function buildUnitMeta(c,u,schema){
  const index=u.packetIndexPath?read(safePath(u.packetIndexPath)):null;
  let initial,inputSchema;
  if(u.kind==='FLOW'){
    const ids=index?.primaryContextIds||[];
    initial={schemaVersion:'curveyield-flow-review-submission-v1',unitId:u.unitId,
      rows:ids.map(contextId=>({contextId,verdict:'<REQUIRED_CORRECT_DEFECT_OR_UNRESOLVED>',
        intent:'<REQUIRED>',reason:'<REQUIRED>',anchors:[],
        specInspection:{status:'<REQUIRED>',docsAndCommentsChecked:'<REQUIRED>',namedConstantsChecked:'<REQUIRED>'},
        documentedRules:[],siblingComparisons:[]})),
      flowNotes:(index?.flowIds||[]).map(flowId=>({flowId,note:'<REQUIRED>',anchors:[]})),
      integrationAnswers:(index?.integrationQuestionIds||[]).map(obligationId=>({obligationId,assessment:'<REQUIRED>',reasoning:'<REQUIRED>',anchors:[]})),
      contractChecks:[],candidates:[]};
    inputSchema={type:'object',required:['schemaVersion','unitId','rows'],
      properties:{schemaVersion:{type:'string',enum:['curveyield-flow-review-submission-v1']},
        unitId:{type:'string',enum:[u.unitId]},rows:{type:'array',minItems:ids.length},
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
        unitId:{type:'string',enum:[u.unitId]},attackPaths:{type:'array',minItems:1},integrationAnswers:{type:'array'}}};
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
  return {unitId:u.unitId,kind:u.kind,step:0,stage:'',unitSpecRevision:u.unitSpecRevision,
    packetPath,packetSha256,packetIndexPath:u.packetIndexPath||null,recordKeys:u.recordKeys||[],
    dependencies:u.dependencies||[],path:u.path,members:u.members,field:u.field,
    inputTemplate:initial,validationSchema:inputSchema,
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
// Fork-only issue order: Step 3 synthesizes accepted Step 4 and 5 proof.
// The canonical controller owns its dependencies; primary workflows remain unchanged.
function forkUnitOrder(phase){return phase===6?[1,2,4,5,3]:Array.from({length:({4:3,5:3})[phase]},(_,i)=>i+1);}
function forkNextUnitStep(c,source,phase,step){
 const order=forkUnitOrder(phase),at=order.indexOf(step);
 strict(at>=0,'unknown Cloudflare fork stage');
 if(at===order.length-1)return {done:true,step:null,stage:null};
 const nextStep=order[at+1],nextStage='STEP_'+nextStep;
 strict(eligibleStage(c,source,phase,nextStep,nextStage).length>0,
   'CONTROLLER_DEPENDENCY_BLOCKED: successor '+nextStage+' has no eligible accepted-prerequisite units');
 return {done:false,step:nextStep,stage:nextStage};
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
function submittedUnitFile(c,phase,u){
  const unitRoot=relative(c.campaignPath+'/work/phase-'+phaseNo(phase)+'/units/'+u.unitId+'/submissions');
  strict(fs.existsSync(unitRoot),'missing Worker-filed submission for '+u.unitId);
  const options=[];
  for(const worker of fs.readdirSync(unitRoot)){
    strict(/^cfw-[A-Za-z0-9_.-]{1,135}$/.test(worker),'unrecognized Worker submission owner');
    const epochs=path.join(unitRoot,worker);
    for(const entry of fs.readdirSync(epochs)){
      if(!/^epoch-1$/.test(entry))continue;
      const dir=path.join(epochs,entry);
      for(const filename of fs.readdirSync(dir)){
        if(!/^SUBMISSION_ATTEMPT_[0-9]{3,6}_v1\.json$/.test(filename))continue;
        const full=path.join(dir,filename);
        const attempt=Number(filename.match(/[0-9]{3,6}/)[0]);
        options.push({workerId:worker,epoch:1,attempt,filename:full,rel:path.posix.relative(ROOT,full)});
      }
    }
  }
  options.sort((a,b)=>b.attempt-a.attempt);
  strict(options.length&&(!options[1]||options[0].attempt!==options[1].attempt),'missing or ambiguous latest submission: '+u.unitId);
  return options[0];
}

/**
 * Validate one Worker-published unit against the SAME canonical controller
 * validator used by the original wave. No other unit is claimed or modified.
 * Worker leases remain independent, so the agent can claim its next packet.
 */
async function materializePhase5Request(c,u,selected){
 if(Number(c.directory.currentAssignment.phaseSequence)!==5||u.field!=='targetDesigns')return;
 const submitted=JSON.parse(fs.readFileSync(selected.filename,'utf8'));
 const candidates=Array.isArray(submitted.entries)?submitted.entries:[];
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
async function unitValidateSingle(c,item){
 const phase=Number(need('phase')),step=Number(need('step')),stage=String(need('stage'));
 const id=safeId(item.unit_id),sourceCommit=item.source_commit||need('source_commit');
 const current=unitPlan(c),u=current.units.find(x=>x.unitId===id);
 if(!u)return; // No fabricated unit or GitHub-side rejection.
 const selected=submittedUnitFile(c,phase,u),actualSha=sha(fs.readFileSync(selected.filename));
 const state=current.queue.units[id];
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
 processUnitRequestV1({root:ROOT,campaignPath:c.campaignPath,directory:c.directory,
  request,automationRoot:process.cwd()});
 writeJson(relative(c.directoryPath),c.directory);
 const updated=unitPlan(c),record=updated.queue.units[id];
 publishCanonical(c);
 if(record?.status!=='ACCEPTED')return; // Await file transport; never reject findings.
 return callback('/fork/unit-verified',{status:'ACCEPTED',
  campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
  phase,step,stage,unitId:id,attempt:selected.attempt,submissionSha256:actualSha,
  sourceCommit,phaseEpoch:current.plan.phaseEpoch,
  authorityDigest:c.directory.authorityDigest,deficiencies:[],
  acceptedPath:record.acceptedPath,validationDelegatedTo:'CLOUDFLARE_WORKER'});
}
/** Once each unit has its own controller ACCEPTED record, advance the original stage. */
async function unitAdvanceAcceptedStage(c){
 const phase=Number(need('phase')),step=Number(need('step')),stage=String(need('stage'));
 const current=unitPlan(c),schema=loadPhaseSchema(ROOT,AUTH,phase).schema;
 const active=eligibleStage(c,current,phase,step,stage);
 let nextStep=step,nextStage=stage;
 if(!active.length){
  if(step===0&&stage==='FLOW_REVIEW'){nextStep=0;nextStage='ATTACK_REVIEW';}
  else if(phase===6){
   const next=forkNextUnitStep(c,current,phase,step);
   if(next.done){nextStep=null;nextStage=null;}
   else{nextStep=next.step;nextStage=next.stage;}
  }else{nextStep=step===0?1:step+1;nextStage='STEP_'+nextStep;}
 }
 const done=phase===6?nextStep===null:step===({4:3,5:3}[phase])&&nextStep>step;
 const planSha256=sha(fs.readFileSync(relative(current.planRel)));
 const queueSha256=sha(fs.readFileSync(relative(current.queueRel)));
 const nextRosterDigest=done?null:stageDigest(c,current,phase,nextStep,nextStage);
 return callback('/fork/step-verified',{status:'PASS',
  campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
  phase,step,stage,sourceCommit:need('source_commit'),planSha256,
  queueSha256:payload.queue_sha256||queueSha256,rosterDigest:payload.roster_digest||'',
  phaseEpoch:current.plan.phaseEpoch,authorityDigest:c.directory.authorityDigest,
  validator:payload.validator,deficiencies:[],stepComplete:nextStep!==step,
  completePhase:done,nextStep:done?null:nextStep,nextStage:done?null:nextStage,
  nextRosterDigest,nextQueueSha256:done?null:queueSha256,
  githubContentValidationPerformed:false});
}
async function unitValidateWave(c){
 if(payload.incremental===true)return unitAdvanceAcceptedStage(c);
 const phase=Number(need('phase')),step=Number(need('step')),stage=String(need('stage'));
 const sourceCommit=need('source_commit'),current=unitPlan(c);
 const units=eligibleStage(c,current,phase,step,stage);
 const planSha256=sha(fs.readFileSync(relative(current.planRel)));
 const queueSha256=sha(fs.readFileSync(relative(current.queueRel)));
 const rosterDigest=stageDigest(c,current,phase,step,stage);
 for(const u of units){
  const selected=submittedUnitFile(c,phase,u),raw=fs.readFileSync(selected.filename);
  const state=current.queue.units[u.unitId];
  state.status='CLAIMED';state.workerId=selected.workerId;
  state.claimEpoch=selected.epoch;state.claimToken=randomUUID();
  writeJson(relative(current.queueRel),current.queue);
  const request={schemaVersion:'curveyield-lite-solo-unit-batch-request-v1',
   requestId:'mi-wave-'+randomUUID(),operation:'SUBMIT',
   campaignId:c.directory.campaignId,campaignGenerationId:c.directory.campaignGenerationId,
   phaseSequence:phase,lane:'AUTO',workerId:selected.workerId,
   sourceSha256:c.directory.sourceSha256,authorityDigest:c.directory.authorityDigest,
   phaseEpoch:current.plan.phaseEpoch,auditControllerRef:MACHINE_REF,
   items:[{unitId:u.unitId,claimEpoch:state.claimEpoch,claimToken:state.claimToken,
    packetSha256:u.packetSha256||sha(fs.readFileSync(relative(u.packetPath||u.shardPath))),
    submissionPath:selected.rel,submissionSha256:sha(raw),unitSpecRevision:u.unitSpecRevision}]};
  processUnitRequestV1({root:ROOT,campaignPath:c.campaignPath,directory:c.directory,
   request,automationRoot:process.cwd()});
 }
 writeJson(relative(c.directoryPath),c.directory);
 publishCanonical(c);
 return unitAdvanceAcceptedStage(c);
}
async function main(){
  if(OP==='PHASE_0_INITIALIZE'){
    strict(['lite-solo-v5','lite-solo-v6'].includes(payload.authority_release),'unsupported source initialization authority');
    strict(payload.request_id===payload.audit_id,'intake request identity differs from audit ID');
    strict((typeof payload.source_url==='string'&&payload.source_url.length>0)!==Boolean(payload.scan_urls?.length),'exactly one source intake mode required');
    strict(!payload.scan_urls||Array.isArray(payload.scan_urls)&&payload.scan_urls.length<=20,'malformed explorer scan URL set');
    strict(process.env.AUDIT_CONTROLLER_TOKEN&&process.env.CONTRACT_AUTOMATION_TOKEN,'repository credentials missing');
    const initEnv={...process.env,REQUEST_ID:payload.request_id,SOURCE_URL:payload.source_url||'',
      SCAN_URLS:JSON.stringify(payload.scan_urls||[]),FORK_EXPECTED_SOURCE_SHA:payload.source_sha256||'',
      DELIVERY_TRANSPORT:'DIRECT',LITE_SOLO_AI_AUTONOMOUS:payload.authority_release==='lite-solo-v6'?'1':'0',
      ...(payload.authority_release==='lite-solo-v6'?{PUBLISH_FILES_JSON:JSON.stringify(Object.fromEntries(['report_pdf','audited_source','scope_summary','findings_remediation','methodology_analysis','properties_hypotheses','execution_results','architecture_dependencies','residual_risks','evidence_index'].map(k=>[k,false])))}:{})};
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
