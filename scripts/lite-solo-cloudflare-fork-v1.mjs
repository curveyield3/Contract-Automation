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
import {materializeSemanticWorkFormV13, semanticShardFailureIndexV13} from './lib/lite-solo-work-shards-v1.mjs';
import {readJson, writeJson, repoFile, loadPhaseSchema, validateWorkForm, validateBoundAuthorityV1} from './lib/lite-solo-phase-work-v1.mjs';
import {validatePhaseScaffold} from './lib/lite-solo-phase-prefill-v1.mjs';
import {processUnitRequestV1,finalizeReadinessV1,assembleAcceptedUnitShardsV1} from './lib/lite-solo-unit-queue-v1.mjs';
import {restoreControllerResultV1} from './lib/lite-boundary-result-v1.mjs';

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
strict(typeof process.env.CLOUDFLARE_WORKER_URL==='string'&&process.env.CLOUDFLARE_WORKER_URL.startsWith('https://'),'fixed CLOUDFLARE_WORKER_URL is required');
{
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
  if(!cmd('git',['-C',ROOT,'diff','--cached','--name-only']).trim())return;
  cmd('git',['-C',ROOT,'commit','-m','audit(lite-solo): seal '+c.directory.campaignId+' via isolated Cloudflare fork']);
  // A different campaign may commit concurrently. Rebase only when its changes
  // do not touch this campaign/directory; never replay stale controller decisions.
  for(let attempt=0;attempt<4;attempt++){
    try{cmd('git',['-C',ROOT,'push','origin','HEAD:main']);return;}
    catch(error){
      cmd('git',['-C',ROOT,'fetch','origin','main']);
      const upstream=cmd('git',['-C',ROOT,'rev-parse','origin/main']).trim();
      const base=cmd('git',['-C',ROOT,'merge-base','HEAD','origin/main']).trim();
      if(upstream===base)throw error; // Not a concurrent update: do not blindly retry.
      const touched=cmd('git',['-C',ROOT,'diff','--name-only',base,'origin/main','--',c.campaignPath,c.directoryPath]).trim();
      strict(!touched,'CONTROLLER_CAMPAIGN_CHANGED_REVALIDATION_REQUIRED: '+touched);
      cmd('git',['-C',ROOT,'rebase','origin/main']);
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
  fs.appendFileSync(process.env.GITHUB_OUTPUT,'phase10_sealed=true\\nphase10_receipt='+receiptPath+'\\n');
}
function phaseFinalize(c){
  const phase=Number(need('phase')),a=c.directory.currentAssignment;
  // Delivery-only retry after an already sealed Phase 10: do not re-run the
  // controller or mutate its immutable receipt to repair publication.
  if(phase===10&&c.directory.campaignStatus==='COMPLETE'){
    markPhase10Delivery(c,c.directory.lastSealedReceiptPath);
    return;
  }
  assertAssigned(c,phase);
  const commit=need('source_commit');
  if([4,5,6].includes(phase)){
    strict(/^[0-9a-f]{40}$/.test(commit),'phase unit source commit malformed');
    const compare=readGitHubJson('compare/'+commit+'...main');
    strict(compare.status==='ahead'||compare.status==='identical','Worker wave commit is not an ancestor of canonical accepted controller state');
  }else{
    strict(cmd('git',['-C',ROOT,'rev-parse','HEAD']).trim()===commit,'phase submission commit is not canonical head');
  }
  if([4,5,6].includes(phase)){
    const gate=finalizeReadinessV1({root:ROOT,campaignPath:c.campaignPath,directory:c.directory,phase});
    strict(gate.ready,'canonical unit finalization not ready: '+String(gate.reason||'units incomplete'));
    if(phase===5){
      // Phase-5 preflight consumes the deterministic assembly of accepted units.
      // This preserves the fork's Worker packet transport and its reduced checks.
      assembleAcceptedUnitShardsV1({root:ROOT,campaignPath:c.campaignPath,directory:c.directory,phase:5});
      const pre=cmd('node',['scripts/lite-phase5-preflight-v1.mjs',ROOT,c.campaignPath,
        c.directory.campaignId,c.directory.sourceSha256]);
      const result=JSON.parse(pre.trim().split('\n').at(-1));
      const file=c.campaignPath+'/controller/preflight/PHASE5_REQUEST_PREFLIGHT_v1.json';
      writeJson(relative(file),result);
      strict(result.runnable===true,'Phase 5 executable preflight not qualified; controller must not seal');
    }
    const requestDir=fs.mkdtempSync('/tmp/lite-solo-cloudflare-empty-');
    try{
      const output=cmd('node',['scripts/lite-solo-unit-request-drain-v1.mjs',
        '--root',ROOT,'--campaign-id',c.directory.campaignId,
        '--requests-root',requestDir,'--mode','finalize'],{maxBuffer:16*1024*1024});
      const result=JSON.parse(output.trim().split('\n').at(-1));
      if(result.seal?.status==='SEALED'){
        publishCanonical(c);
        return callback('/fork/phase-sealed',{status:'PASS',campaignId:c.directory.campaignId,
          generationId:c.directory.campaignGenerationId,phase,sourceCommit:commit,
          canonicalReceipt:result.seal.receiptPath});
      }
      if(result.seal?.status==='REWORK_REQUIRED'&&result.seal.rework?.reopenedUnits?.length){
        const units=new Set(result.seal.rework.reopenedUnits);
        const plan=unitPlan(c);
        const member=plan.units.filter(u=>units.has(u.unitId));
        strict(member.length===units.size,'controller rework cannot be mapped to original unit plan');
        const first=member[0],num=Number(first.path?.[1]?.replace('step-','')||0);
        const stage=num===0?(first.kind==='ATTACK'?'ATTACK_REVIEW':'FLOW_REVIEW'):'STEP_'+num;
        strict(member.every(u=>Number(u.path?.[1]?.replace('step-','')||0)===num),'multi-stage rework requires exact controller mapping');
        publishCanonical(c);
        return callback('/fork/phase-rework',{status:'REWORK_REQUIRED',
          campaignId:c.directory.campaignId,generationId:c.directory.campaignGenerationId,
          phase,step:num,stage,sourceCommit:commit,unitIds:[...units],
          deficiencies:result.seal.rework.deficiencies||[result.seal.error||'Controller identified unit-specific rework']});
      }
      publishCanonical(c);
      throw Error('CONTROLLER_NOT_SEALED: '+JSON.stringify(result.seal||result.state||{}).slice(0,1800));
    }finally{fs.rmSync(requestDir,{recursive:true,force:true});}
  }
  const env={...process.env};
  const args=['scripts/lite-solo-phase-controller-v1.mjs','--controller-root',ROOT,'--campaign-id',c.directory.campaignId,
    '--campaign-path',c.campaignPath,'--campaign-directory-path',c.directoryPath,'--phase-sequence',String(phase),
    '--review-kind','phase','--audit-controller-ref','main'];
  const text=cmd('node',args,{env});
  const lines=text.trim().split('\n');
  const envelope=JSON.parse(lines.at(-1));
  const result=restoreControllerResultV1({root:ROOT,campaignPath:c.campaignPath,envelope});
  if(result.status!=='PASS'||result.controllerPassToken!=='CONTROLLER_PHASE_PASS'){
    const deficiencies=result.deficiencies||[result.feedbackText||result.status||'Controller phase gate failed'];
    // The controller owns named deficiencies; never replace its FAIL with PASS.
    return callback('/fork/phase-rework',{status:'REWORK_REQUIRED',campaignId:c.directory.campaignId,
      generationId:c.directory.campaignGenerationId,phase,step:phase===1?6:Number(payload.completed_step)-1,
      sourceCommit:commit,deficiencies,unitFiles:result.controllerValidation?.shardRework?.shards?.map(x=>path.posix.basename(x.path))||[]});
  }
  publishCanonical(c);
  if(phase===10){
    markPhase10Delivery(c,result.receiptPath);
    return; // Report delivery and Worker callback occur in the owning workflow.
  }
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


function unitRelevant(u,phase,step,stage,schema){
  if(step===0)return phase===4&&u.kind===(stage==='ATTACK_REVIEW'?'ATTACK':'FLOW');
  if(u.kind==='BATCH')return (schema.actions['step-'+step]?.fields||[]).some(f=>f.name===u.field);
  return u.path?.[1]==='step-'+step;
}
function eligibleStage(c,source,phase,step,stage){
  const schema=loadPhaseSchema(ROOT,AUTH,phase).schema;
  return source.units.filter(u=>unitRelevant(u,phase,step,stage,schema)&&
    ['AVAILABLE','RELEASED','REWORK_REQUIRED'].includes(source.queue.units?.[u.unitId]?.status)&&
    (u.dependencies||[]).every(dep=>source.queue.units?.[dep]?.status==='ACCEPTED'));
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
async function unitValidateWave(c){
  const phase=Number(need('phase')),step=Number(need('step')),stage=String(need('stage'));
  assertAssigned(c,phase);
  strict([4,5,6].includes(phase),'wrong wave phase');
  strict(/^STEP_[1-5]$|^FLOW_REVIEW$|^ATTACK_REVIEW$/.test(stage),'invalid wave stage');
  const sourceCommit=need('source_commit');
  strict(cmd('git',['-C',ROOT,'rev-parse','HEAD']).trim()===sourceCommit,'Worker wave commit is not the canonical controller head');
  strict(payload.validator==='EXISTING_LITE_SOLO_PHASE_VALIDATORS','invalid existing-controller validation identity');
  const current=unitPlan(c);
  const planDigest=sha(fs.readFileSync(relative(current.planRel))),queueDigest=sha(fs.readFileSync(relative(current.queueRel)));
  strict(planDigest===payload.plan_sha256&&queueDigest===payload.queue_sha256,'canonical unit plan or pre-wave queue changed');
  strict(current.plan.phaseEpoch===payload.phase_epoch,'unit phase epoch mismatch');
  const eligible=eligibleStage(c,current,phase,step,stage);
  const digest=stageDigest(c,current,phase,step,stage);
  strict(eligible.length===payload.unit_count&&digest===payload.roster_digest,'submitted wave is not the entire eligible roster');
  const originals=new Map(eligible.map(u=>[u.unitId,u]));
  const uploads=eligible.map(u=>({u,source:submittedUnitFile(c,phase,u)}));
  // The Worker alone authenticates agents. The pre-existing in-process unit
  // controller receives a transient, fork-owned same-wave lease for validation.
  // No CLAIM or SUBMIT files are written to the legacy GitHub ingress.
  for(const {u,source} of uploads){
    const state=current.queue.units[u.unitId];
    strict(state&&['AVAILABLE','RELEASED','REWORK_REQUIRED'].includes(state.status),'unit became ineligible '+u.unitId);
    state.status='CLAIMED';state.workerId=source.workerId;state.claimEpoch=source.epoch;state.claimToken=randomUUID();
  }
  writeJson(relative(current.queueRel),current.queue);
  const byWorker=new Map();
  for(const {u,source} of uploads){
    const state=current.queue.units[u.unitId],raw=fs.readFileSync(source.filename);
    const item={unitId:u.unitId,claimEpoch:state.claimEpoch,claimToken:state.claimToken,
      packetSha256:u.packetSha256||sha(fs.readFileSync(relative(u.packetPath||u.shardPath))),
      submissionPath:source.rel,submissionSha256:sha(raw),unitSpecRevision:u.unitSpecRevision};
    const arr=byWorker.get(source.workerId)||[];arr.push(item);byWorker.set(source.workerId,arr);
  }
  const errors=[];
  for(const [workerId,items] of byWorker)for(let i=0;i<items.length;i+=5){
    const batch=items.slice(i,i+5),request={schemaVersion:'curveyield-lite-solo-unit-batch-request-v1',
      requestId:'cf-wave-'+randomUUID(),operation:'SUBMIT',campaignId:c.directory.campaignId,
      campaignGenerationId:c.directory.campaignGenerationId,phaseSequence:phase,lane:'AUTO',
      workerId,sourceSha256:c.directory.sourceSha256,authorityDigest:c.directory.authorityDigest,
      phaseEpoch:current.plan.phaseEpoch,auditControllerRef:'main',items:batch};
    const result=processUnitRequestV1({root:ROOT,campaignPath:c.campaignPath,directory:c.directory,request,automationRoot:process.cwd()});
    errors.push(...(result.reworkUnits||[]));
    errors.push(...(result.staleUnits||[]).map(x=>({...x,errors:['stale controller unit identity']})));
    errors.push(...(result.waitingUnits||[]).map(x=>({...x,errors:['submission missing from canonical commit']})));
  }
  writeJson(relative(c.directoryPath),c.directory);
  const after=unitPlan(c);
  if(errors.length){
    publishCanonical(c);
    const unitIds=[...new Set(errors.map(x=>x.unitId))],deficiencies=errors.flatMap(x=>(x.errors||[]).map(e=>({unitId:x.unitId,reason:typeof e==='string'?e:e.message||JSON.stringify(e)})));
    return callback('/fork/step-verified',{status:'REWORK_REQUIRED',campaignId:c.directory.campaignId,
      generationId:c.directory.campaignGenerationId,phase,step,stage,sourceCommit,planSha256:planDigest,
      queueSha256:queueDigest,rosterDigest:digest,phaseEpoch:current.plan.phaseEpoch,
      authorityDigest:c.directory.authorityDigest,validator:payload.validator,unitIds,deficiencies});
  }
  // Fail closed if any submitted unit is not durably controller accepted.
  for(const u of eligible)strict(after.queue.units[u.unitId]?.status==='ACCEPTED','missing canonical acceptance for '+u.unitId);
  publishCanonical(c);
  const updated=unitPlan(c);
  let nextStep=step,nextStage=stage,nextRoster=[];
  if(step===0&&stage==='FLOW_REVIEW'){nextStep=0;nextStage='ATTACK_REVIEW';}
  else{
    nextRoster=eligibleStage(c,updated,phase,step,stage);
    if(!nextRoster.length){
      const pending=updated.units.filter(u=>unitRelevant(u,phase,step,stage,loadPhaseSchema(ROOT,AUTH,phase).schema)&&updated.queue.units[u.unitId]?.status!=='ACCEPTED');
      strict(!pending.length,'CONTROLLER_DEPENDENCY_BLOCKED: incomplete current-step units remain; do not reorder steps or invent acceptance: '+pending.slice(0,20).map(x=>x.unitId).join(','));
      nextStep=step===0?1:step+1;
      nextStage='STEP_'+nextStep;
    }
  }
  const done=step===({4:3,5:3,6:5}[phase])&&nextStep>step;
  let nextRosterDigest=null,nextQueueSha256=null;
  if(!done){
    nextRoster=eligibleStage(c,updated,phase,nextStep,nextStage);
    strict(nextRoster.length>0,'no next eligible unit roster; controller must report an exact blocker');
    nextRosterDigest=stageDigest(c,updated,phase,nextStep,nextStage);
    nextQueueSha256=sha(fs.readFileSync(relative(updated.queueRel)));
  }
  return callback('/fork/step-verified',{status:'PASS',campaignId:c.directory.campaignId,
    generationId:c.directory.campaignGenerationId,phase,step,stage,sourceCommit,planSha256:planDigest,
    queueSha256:queueDigest,rosterDigest:digest,phaseEpoch:current.plan.phaseEpoch,
    authorityDigest:c.directory.authorityDigest,validator:payload.validator,deficiencies:[],
    stepComplete:nextStep!==step,completePhase:done,nextStep:done?null:nextStep,
    nextStage:done?null:nextStage,nextRosterDigest,nextQueueSha256});
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
    if([4,5,6].includes(Number(payload.phase)))await unitValidateWave(c);
    else await validateSemanticStep(c);
  }else if(OP==='PHASE_FINALIZE')await phaseFinalize(c);
}
main().catch(e=>{process.stderr.write('Cloudflare fork blocked: '+String(e.stack||e)+'\n');process.exitCode=1;});
