#!/usr/bin/env node
/**
 * Isolated Cloudflare Lite-Solo fork adapter.
 * No old workflow dispatch, no legacy agent-upload ingress, no synthetic PASS.
 * The immutable campaign-bound controller remains the sole phase-sealing authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {materializeSemanticWorkFormV13, semanticShardFailureIndexV13} from './lib/lite-solo-work-shards-v1.mjs';
import {readJson, repoFile, loadPhaseSchema, validateWorkForm, validateBoundAuthorityV1} from './lib/lite-solo-phase-work-v1.mjs';
import {validatePhaseScaffold} from './lib/lite-solo-phase-prefill-v1.mjs';

const OP = process.env.FORK_OPERATION;
const payload = JSON.parse(process.env.FORK_PAYLOAD_JSON || '{}');
const correlationId = process.env.FORK_CORRELATION_ID || '';
const secret = process.env.FORK_CALLBACK_TOKEN;
const ROOT = path.resolve('.audit-controller');
const AUTH = 'Audit Skill - Lite-Solo Authority/lite-solo-v5';
const CONTROLLER = 'curveyield3/Audit-Controller';
const allowedOperations = new Set(['PHASE_0_INITIALIZE','PHASE_NEXT_STEP','PHASE_VALIDATE_STEP','PHASE_FINALIZE']);
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
if(process.env.CLOUDFLARE_WORKER_URL){
  const expected = new URL(process.env.CLOUDFLARE_WORKER_URL);
  const supplied = new URL(payload.callback_url);
  strict(expected.origin===supplied.origin && expected.pathname.replace(/\/$/,'')===supplied.pathname.replace(/\/$/,''),'worker callback origin is not configured origin');
}
strict(!new URL(payload.callback_url).username && !new URL(payload.callback_url).password,'callback credentials not allowed');
if(OP==='PHASE_VALIDATE_STEP'||OP==='PHASE_FINALIZE'){
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
  const meta=readGitHubJson('contents/'+encoded+'?ref=main');
  strict(meta.type==='file'&&meta.encoding==='base64','campaign directory missing');
  const directory=JSON.parse(Buffer.from(meta.content.replace(/\s/g,''),'base64').toString('utf8'));
  strict(directory.campaignId===id&&directory.campaignGenerationId===payload.generation_id,'campaign generation mismatch');
  strict(directory.mode==='LITE_SOLO'&&directory.authorityRelease==='lite-solo-v5','not a v5 Lite-Solo campaign');
  strict(directory.authorityDigest===payload.authority_digest,'bound authority digest mismatch');
  safePath(directory.workspacePath);
  cmd('bash',['scripts/lite-solo-checkout-bound-controller-v1.sh',ROOT,'main',directory.workspacePath]);
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
function indexPages(indexPath){
  const index=read(indexPath),dir=path.posix.dirname(indexPath),out=[];
  strict(index.schemaVersion==='curveyield-work-shard-index-v13','wrong semantic shard format');
  for(const page of index.pages||[]){
    strict(/^INDEX_PAGE_[0-9]{4}_v1\.json$/.test(page.file),'unexpected index page name');
    const rel=dir+'/'+page.file,raw=fs.readFileSync(relative(rel));
    strict(sha(raw)===page.sha256,'immutable index page digest mismatch');
    const body=JSON.parse(raw.toString('utf8'));
    strict(body.schemaVersion==='curveyield-work-shard-index-page-v13','invalid index page format');
    out.push(...body.shards);
  }
  return {index,descriptors:out};
}
function noUnitNextStep(c){
  const phase=Number(need('phase')),step=Number(need('step'));
  assertAssigned(c,phase);
  const a=c.directory.currentAssignment,indexPath=safePath(a.workShardIndexPath);
  const {index,descriptors}=indexPages(indexPath);
  strict(index.phase===phase&&index.formRel===a.workFormPath,'wrong phase index');
  const unitFiles=descriptors.filter(d=>d.path?.[0]==='actions'&&d.path[1]==='step-'+step&&d.path[2]==='outputs')
    .map(d=>d.file).sort();
  strict(unitFiles.length>0,'no canonical semantic shards for current step');
  if(payload.source_commit)strict(/^[0-9a-f]{40}$/.test(payload.source_commit),'invalid source commit');
  return callback('/fork/roster',{campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
    phase,step,sourceCommit:payload.source_commit||null,
    indexSha256:sha(fs.readFileSync(relative(indexPath))),unitFiles});
}
function validateSemanticStep(c){
  const phase=Number(need('phase')),step=Number(need('step')),a=c.directory.currentAssignment;
  assertAssigned(c,phase);
  strict(Number.isSafeInteger(step)&&step>=1&&step<=10,'invalid step');
  strict(payload.validator==='EXISTING_LITE_SOLO_PHASE_VALIDATORS','unknown step validator');
  const commit=need('source_commit');
  strict(/^[0-9a-f]{40}$/.test(commit),'missing immutable submitted commit');
  const branchHead=cmd('git',['-C',ROOT,'rev-parse','HEAD']).trim();
  strict(branchHead===commit,'submitted commit differs from checked out canonical controller head');
  strict(a.workShardIndexPath===payload.work_shard_index_path,'shard path does not match controller assignment');
  const indexRaw=fs.readFileSync(relative(a.workShardIndexPath));
  strict(sha(indexRaw)===payload.index_sha256,'step index digest mismatch');
  const {index,descriptors}=indexPages(a.workShardIndexPath);
  strict(index.phase===phase&&index.formRel===a.workFormPath,'bound semantic index mismatch');
  const active=descriptors.filter(d=>d.path?.[1]==='step-'+step).map(d=>d.file);
  strict(active.length>0,'no assigned current-step shards');
  const predecessor=read(a.predecessorReceiptPath);
  strict(validateBoundAuthorityV1({root:ROOT,receipt:predecessor})===AUTH,'frozen authority identity mismatch');
  const schema=loadPhaseSchema(ROOT,AUTH,phase).schema;
  strict(schema.actions['step-'+step],'step not in bound schema');
  materializeSemanticWorkFormV13({root:ROOT,formRel:a.workFormPath});
  const form=read(a.workFormPath);
  // Invoke the existing validator, filtered only to the authorized current step.
  // Whole-phase and machine-evidence validation remains mandatory at finalization.
  const stepKey='step-'+step;
  const filtered={...schema,actions:{[stepKey]:schema.actions[stepKey]}};
  const problems=validateWorkForm(filtered,form);
  const scaffold=validatePhaseScaffold(phase,form,a.controllerPrefillDigestSha256);
  problems.push(...scaffold.filter(x=>/digest|read-only|prefill|modified/i.test(x)));
  if(problems.length){
    const map=semanticShardFailureIndexV13({root:ROOT,indexRel:a.workShardIndexPath,deficiencies:problems});
    const paths=map.shards.map(x=>path.posix.basename(x.path)).filter(x=>active.includes(x));
    return callback('/fork/step-verified',{status:'REWORK_REQUIRED',campaignId:c.directory.campaignId,
      generationId:c.directory.campaignGenerationId,phase,step,sourceCommit:commit,indexSha256:payload.index_sha256,
      authorityDigest:c.directory.authorityDigest,validator:payload.validator,
      deficiencies:problems,unitFiles:paths.length?paths:active});
  }
  return callback('/fork/step-verified',{status:'PASS',campaignId:c.directory.campaignId,
    generationId:c.directory.campaignGenerationId,phase,step,sourceCommit:commit,indexSha256:payload.index_sha256,
    authorityDigest:c.directory.authorityDigest,validator:payload.validator,deficiencies:[]});
}
function publishCanonical(c){
  cmd('git',['-C',ROOT,'config','user.name','CurveYield Cloudflare Fork Controller']);
  cmd('git',['-C',ROOT,'config','user.email','lite-solo-cloudflare-fork@users.noreply.github.com']);
  cmd('git',['-C',ROOT,'add','--',c.campaignPath,c.directoryPath]);
  const changed=cmd('git',['-C',ROOT,'status','--porcelain']);
  if(changed.trim()){
    cmd('git',['-C',ROOT,'commit','-m','audit(lite-solo): seal '+c.directory.campaignId+' via isolated Cloudflare fork']);
    cmd('git',['-C',ROOT,'push','origin','HEAD:main']);
  }
}
function phaseFinalize(c){
  const phase=Number(need('phase')),a=c.directory.currentAssignment;
  assertAssigned(c,phase);
  const commit=need('source_commit');
  strict(cmd('git',['-C',ROOT,'rev-parse','HEAD']).trim()===commit,'phase submission commit is not canonical head');
  if([4,5,6].includes(phase))throw Error('FORK_UNIT_FINALIZATION_NOT_YET_CONNECTED: controller-accepted unit wave is required; no synthetic sealed PASS allowed');
  const env={...process.env};
  const args=['scripts/lite-solo-phase-controller-v1.mjs','--controller-root',ROOT,'--campaign-id',c.directory.campaignId,
    '--campaign-path',c.campaignPath,'--campaign-directory-path',c.directoryPath,'--phase-sequence',String(phase),
    '--review-kind','phase','--audit-controller-ref','main'];
  const text=cmd('node',args,{env});
  const lines=text.trim().split('\n');
  const result=JSON.parse(lines.at(-1));
  if(result.status!=='PASS'||result.controllerPassToken!=='CONTROLLER_PHASE_PASS'){
    const deficiencies=result.deficiencies||[result.feedbackText||result.status||'Controller phase gate failed'];
    // The controller owns named deficiencies; never replace its FAIL with PASS.
    return callback('/fork/phase-rework',{status:'REWORK_REQUIRED',campaignId:c.directory.campaignId,
      generationId:c.directory.campaignGenerationId,phase,step:phase===1?6:Number(payload.completed_step)-1,
      sourceCommit:commit,deficiencies,unitFiles:result.controllerValidation?.shardRework?.shards?.map(x=>path.posix.basename(x.path))||[]});
  }
  publishCanonical(c);
  return callback('/fork/phase-sealed',{status:'PASS',campaignId:c.directory.campaignId,
    generationId:c.directory.campaignGenerationId,phase,sourceCommit:commit,canonicalReceipt:result.receiptPath});
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
function buildUnitMeta(c,u,schema){
  const index=u.packetIndexPath?read(safePath(u.packetIndexPath)):null;
  const initial=u.kind==='FLOW'?{schemaVersion:'curveyield-flow-review-submission-v1',unitId:u.unitId,
      rows:(index?.primaryContextIds||[]).map(contextId=>({contextId,verdict:'<REQUIRED>',intent:'<REQUIRED>',reason:'<REQUIRED>',anchors:[]})),
      flowNotes:[],integrationAnswers:[],contractChecks:[],candidates:[]}:
    u.kind==='ATTACK'?{schemaVersion:'curveyield-attack-submission-v1',unitId:u.unitId,rows:[],findings:[]}:
    {schemaVersion:'curveyield-lite-solo-unit-submission-v1',
      entries:u.kind==='APPEND'?[]:(u.kind==='BATCH'?u.members:[u]).map(m=>({key:m.recordKeys?.[0],value:m.initialValue}))};
  const packetPath=u.packetPath||u.shardPath;
  strict(packetPath&&safePath(packetPath).startsWith(c.campaignPath+'/'),'unit packet path outside campaign');
  const packetSha256=u.packetSha256||sha(fs.readFileSync(relative(packetPath)));
  const inputSchema={type:'object',required:['schemaVersion','unitId','rows']};
  if(!['FLOW','ATTACK'].includes(u.kind)){inputSchema.required=['schemaVersion','entries'];}
  return {unitId:u.unitId,kind:u.kind,step:0,stage:'',unitSpecRevision:u.unitSpecRevision,
    packetPath,packetSha256,packetIndexPath:u.packetIndexPath||null,
    dependencies:u.dependencies||[],path:u.path,members:u.members,field:u.field,
    inputTemplate:initial,validationSchema:inputSchema,
    supportingFileRequirements:[],evidenceRefs:u.packetIndexPath?[u.packetIndexPath]:[]};
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
      (u.dependencies||[]).every(dep=>queue.units?.[dep]?.status==='ACCEPTED');
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

async function main(){
  if(OP==='PHASE_0_INITIALIZE'){
    strict(payload.authority_release==='lite-solo-v5','source initialization requires admitted v5 authority');
    strict(payload.request_id===payload.audit_id,'intake request identity differs from audit ID');
    strict((typeof payload.source_url==='string'&&payload.source_url.length>0)!==Boolean(payload.scan_urls?.length),'exactly one source intake mode required');
    strict(!payload.scan_urls||Array.isArray(payload.scan_urls)&&payload.scan_urls.length<=20,'malformed explorer scan URL set');
    strict(process.env.AUDIT_CONTROLLER_TOKEN&&process.env.CONTRACT_AUTOMATION_TOKEN,'repository credentials missing');
    const initEnv={...process.env,REQUEST_ID:payload.request_id,SOURCE_URL:payload.source_url||'',
      SCAN_URLS:JSON.stringify(payload.scan_urls||[]),FORK_EXPECTED_SOURCE_SHA:payload.source_sha256||'',
      DELIVERY_TRANSPORT:'DIRECT'};
    cmd('bash',['scripts/lite-solo-source-initialization/run-cloudflare-fork-v1.sh'],{env:initEnv,timeout:20*60*1000});
    return;
  }
  const c=checkout();
  if(OP==='PHASE_NEXT_STEP'){
    if([4,5,6].includes(Number(payload.phase)))await unitNextStep(c);
    else await noUnitNextStep(c);
  }else if(OP==='PHASE_VALIDATE_STEP'){
    if([4,5,6].includes(Number(payload.phase)))throw Error('FORK_UNIT_WAVE_VALIDATION_NOT_YET_CONNECTED: must invoke real unit controller before PASS');
    await validateSemanticStep(c);
  }else if(OP==='PHASE_FINALIZE')await phaseFinalize(c);
}
main().catch(e=>{process.stderr.write('Cloudflare fork blocked: '+String(e.stack||e)+'\n');process.exitCode=1;});
