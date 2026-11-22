#!/usr/bin/env node
// CurveYield Automated Security Pipeline v1. Safe metadata reporter; no source execution.
import fs from 'node:fs';
import path from 'node:path';
import {sha256HexV1,digestCanonicalV1} from '../packages/github-native-sim/src/canonical-json-v1.mjs';

const GATES=[['G0','prepare_targets'],['G1','prepare_targets'],['G2','prepare_targets'],
 ['G2T','toolkit_qualify'],['G2A','mimo_configure'],['G2B','fork_setup'],
 ['G2C','storage_inspect'],['G2D','medusa_analyze'],['G3','wake_analyze'],
 ['G4','mythril_analyze'],['G5','prover_qualify'],['G6','mimo_provider_qualify'],
 ['G7','autoprover_run'],['G8','reconcile'],['G9','qualify_release']];
const COMPONENTS=['foundry-node','source-compilers','slither-storage','medusa',
 'wake','mythril','certora-prover','autoprover','mimo-runtime','mimo-weights'];
const STATUSES=new Set(['COMPLETE','PARTIAL','WARNING','NOT_EXECUTED','NATIVE_FAILED',
 'UNSUPPORTED','NOT_REQUIRED','UNVERIFIED']);
function argsOf(argv){
 const keys=new Set(['operation','run-id','run-attempt','run-head-sha',
  'input-root','output-root','needs-json','artifacts-json','native-result']);
 const a={};
 for(let i=0;i<argv.length;i++){
  const k=argv[i].startsWith('--')?argv[i].slice(2):'';
  if(!keys.has(k)||Object.hasOwn(a,k)||!argv[i+1]||argv[i+1].startsWith('--'))
   throw Error('REPORT_INVALID_CLI_ARGUMENT:'+argv[i]);
  a[k]=argv[++i];
 }
 for(const k of ['operation','run-id','run-attempt','run-head-sha','input-root','output-root'])
  if(!a[k])throw Error('REPORT_MISSING_CLI_ARGUMENT:'+k);
 if(!['consolidate-warnings','reconcile-native','qualify-dossier'].includes(a.operation))
  throw Error('REPORT_UNSUPPORTED_OPERATION:'+a.operation);
 if(!/^\d+$/.test(a['run-id'])||!/^[1-9]\d*$/.test(a['run-attempt'])||
   !/^[a-f0-9]{40}$/.test(a['run-head-sha']))throw Error('REPORT_INVALID_RUN_IDENTITY');
 for(const [env,arg] of [['GITHUB_RUN_ID','run-id'],['GITHUB_RUN_ATTEMPT','run-attempt'],['GITHUB_SHA','run-head-sha']])
  if(process.env[env]&&process.env[env]!==a[arg])throw Error('REPORT_RUN_ENV_MISMATCH:'+env);
 return a;
}
function readBytes(f,root){
 const rp=path.resolve(f),base=path.resolve(root);
 if(rp!==base&&!rp.startsWith(base+path.sep))throw Error('REPORT_PATH_OUTSIDE_INPUT_ROOT:'+f);
 if(fs.lstatSync(rp).isSymbolicLink())throw Error('REPORT_INPUT_IS_SYMLINK:'+f);
 const st=fs.statSync(rp);
 if(!st.isFile()||st.size>8388608)throw Error('REPORT_INPUT_SIZE_OR_TYPE_INVALID:'+f);
 return fs.readFileSync(rp);
}
function readJson(f,root){return JSON.parse(readBytes(f,root).toString('utf8'));}
function writeFile(root,name,content){
 fs.mkdirSync(root,{recursive:true});
 const file=path.join(root,name),tmp=file+'.tmp';
 fs.writeFileSync(tmp,content,{mode:0o600});
 fs.renameSync(tmp,file);
 return {name,sha256:sha256HexV1(fs.readFileSync(file))};
}
function writeJson(root,name,x){return writeFile(root,name,JSON.stringify(x,null,2)+'\n');}
function safe(x,n=320){
 let s=typeof x==='string'?x:JSON.stringify(x??null);
 s=String(s).replace(/[\u0000-\u001f\u007f]/g,' ')
  .replace(/(Bearer|token|secret|password|private[_-]?key)\s*[:=]\s*[^ ,;]+/ig,'$1=[REDACTED]');
 return s.length>n?s.slice(0,n)+' [TRUNCATED]':s;
}
function markdown(x){return safe(x,420).replaceAll('|','\\|').replaceAll('<','&lt;').replaceAll('>','&gt;');}
function warning(a,code,stage,job,field,expected,observed,impact,correction,evidence=null){
 const id=digestCanonicalV1([a['run-id'],a['run-attempt'],stage,job,code,field,digestCanonicalV1(observed)]);
 return {schemaVersion:'curveyield-security-pipeline-warning-v1',warningId:id,code,stage,
  operation:job,componentId:null,targetId:null,checkId:code,configurationField:field,fieldPath:field,
  expected:{value:safe(expected),source:'trusted workflow observation'},
  observed:{value:safe(observed),source:evidence??'trusted workflow observation'},
  observationFailure:null,mismatch:field+': expected '+safe(expected,160)+'; observed '+safe(observed,160),
  impact,requiredCorrection:correction,correction,nativeEvidenceRefs:evidence?[evidence]:[],
  runIdentitySha256:null,runId:a['run-id'],runAttempt:Number(a['run-attempt']),
  workflowHeadSha:a['run-head-sha'],jobId:job,sourceArchiveSha256:null,
  status:'WARNING',affectedOperationStatus:'NOT_EXECUTED',operationDisposition:'NOT_EXECUTED',
  recordedAtUTC:new Date().toISOString(),severity:'CONFIGURATION',redactions:[],
  nativeExitCode:null,sourceArtifactName:evidence,privacyClass:'PUBLIC_SAFE'};
}
function isValidWarning(x,a,job){
 if(!x||typeof x!=='object'||Array.isArray(x))return 'not an object';
 for(const k of ['schemaVersion','warningId','code','stage','checkId','configurationField',
    'expected','observed','impact','requiredCorrection','nativeEvidenceRefs','redactions']){
  if(!Object.hasOwn(x,k))return 'missing field '+k;
 }
 if(x.schemaVersion!=='curveyield-security-pipeline-warning-v1'||
   !/^[a-f0-9]{64}$/.test(String(x.warningId)))return 'schema or warningId invalid';
 if(String(x.runId)!==a['run-id']||Number(x.runAttempt)!==Number(a['run-attempt'])||
   x.workflowHeadSha&&x.workflowHeadSha!==a['run-head-sha']||x.jobId&&x.jobId!==job)
   return 'foreign run, attempt, head, or job';
 if(!Object.hasOwn(x.expected??{},'value')||!Object.hasOwn(x.observed??{},'value'))
   return 'expected/observed value missing';
 if(!Array.isArray(x.nativeEvidenceRefs)||!Array.isArray(x.redactions))return 'invalid evidence list';
 return null;
}
function artifactInventory(a,errors){
 const f=a['artifacts-json'];
 if(!f)return [];
 try{
  const rows=[];
  for(const [i,line] of readBytes(f,a['input-root']).toString('utf8').split(/\r?\n/).entries()){
   if(!line.trim())continue;
   try{
    const v=JSON.parse(line);
    if(v.artifactInventoryUnavailable)throw Error('GitHub API artifact inventory unavailable');
    if(typeof v.name!=='string'||!Number.isInteger(v.id))throw Error('artifact name/id invalid');
    rows.push({name:v.name,id:v.id,size_in_bytes:v.size_in_bytes??null,expired:v.expired??null});
   }catch(e){errors.push({field:'artifactInventory.line '+(i+1),reason:e.message});}
  }
  return rows;
 }catch(e){errors.push({field:'artifactInventory',reason:String(e)});return [];}
}
function defaultStatus(a,gate,job,result,requested){
 return {schemaVersion:'curveyield-security-pipeline-stage-v1',stage:gate,jobId:job,
  status:!requested&&job!=='admit'&&job!=='collect'?'NOT_REQUIRED':'UNVERIFIED',
  observedJobResult:result??'unknown',attempted:0,completed:0,notExecuted:0,
  nativeFailed:0,unsupported:0,sourceBound:false,originalNativeExit:null,
  originalNativeEvidenceSha256:null,warnings:[],dependencyFacts:{stageArtifact:'MISSING'},
  sourceIdentity:null,jobRunId:a['run-id'],jobRunAttempt:Number(a['run-attempt']),
  workflowHeadSha:a['run-head-sha']};
}
function consolidate(a){
 const errors=[];
 let needs;
 try{needs=readJson(a['needs-json'],a['input-root']);
  if(!needs||Array.isArray(needs)||typeof needs!=='object')throw Error('NEEDS_NOT_OBJECT');
 }catch(e){needs={};errors.push({field:'needs.json',reason:String(e)});}
 const requested=needs.admit?.outputs?.extended_requested==='true';
 const approved=needs.admit?.outputs?.extended_approved==='true';
 const inventory=artifactInventory(a,errors);
 const suffix='-'+a['run-id']+'-'+a['run-attempt'];
 const stageRoot=path.join(a['input-root'],'parts','stages');
 const stageEntries={},parts=[],warnings=[],warningIds=new Set();
 function addWarning(w){if(!warningIds.has(w.warningId)){warnings.push(w);warningIds.add(w.warningId);}}
 for(const [job,entry] of Object.entries(needs)){
  const result=entry?.result??'unknown';
  const matrix=job==='toolkit_prepare';
  const names=matrix?COMPONENTS.map(c=>'security-pipeline-stage-'+job+'-'+c+suffix):
   ['security-pipeline-stage-'+job+suffix];
  for(const name of names){
   const dir=path.join(stageRoot,name);
   const observed=inventory.filter(x=>x.name===name);
   parts.push({name,job,result,inventoryCount:observed.length,
     downloaded:fs.existsSync(dir)});
   if(!fs.existsSync(dir)){
    if(requested||job==='admit'||job==='collect')
     addWarning(warning(a,'REPORT.STAGE_ARTIFACT_MISSING',job,job,'artifacts.'+name,
      'same-run stage warning artifact', 'missing, job='+result,
      'Stage completion cannot be established from absent evidence',
      'Recover this named job-owned same-run artifact and inspect its upload step',name));
    continue;
   }
   const partFile=path.join(dir,'SECURITY_PIPELINE_WARNINGS_v1.jsonl');
   if(fs.existsSync(partFile)){
    try{
     for(const [i,line] of readBytes(partFile,dir).toString('utf8').split(/\r?\n/).entries()){
      if(!line.trim())continue;
      try{
       const record=JSON.parse(line),reason=isValidWarning(record,a,job);
       if(reason)throw Error(reason);
       addWarning(record);
      }catch(e){addWarning(warning(a,'REPORT.WARNING_ARTIFACT_INVALID',job,job,
       name+'.warnings.line.'+(i+1),'source-bound typed warning',String(e),
       'Imported record excluded from verified warning claims',
       'Repair original stage serializer and regenerate the same-run evidence part',name));}
     }
    }catch(e){addWarning(warning(a,'REPORT.WARNING_PART_UNREADABLE',job,job,name,
     'bounded regular JSONL warning part',String(e),
     'Warnings for this job remain incomplete','Restore exact same-run warning part',name));}
   }
   for(const f of fs.readdirSync(dir).filter(x=>/^PIPELINE_STAGE_[A-Za-z0-9]+_v1\.json$/.test(x))){
    const gate=f.slice('PIPELINE_STAGE_'.length,-'_v1.json'.length);
    try{
     const x=readJson(path.join(dir,f),dir);
     if(x.stage!==gate||x.jobId!==job||!STATUSES.has(x.status)||
       String(x.jobRunId)!==a['run-id']||Number(x.jobRunAttempt)!==Number(a['run-attempt'])||
       x.workflowHeadSha&&x.workflowHeadSha!==a['run-head-sha']||
       Object.hasOwn(stageEntries,gate))
       throw Error('STAGE_DUPLICATE_OR_IDENTITY_MISMATCH');
     stageEntries[gate]={...x,observedJobResult:result,artifactName:name};
    }catch(e){addWarning(warning(a,'REPORT.STAGE_RECORD_INVALID',gate,job,name+'/'+f,
     'verified unique stage identity and status',String(e),
     'Stage is not treated as complete','Repair original stage receipt',name));}
   }
  }
 }
 for(const [job,entry] of Object.entries(needs)){
  if(entry?.result==='failure'||entry?.result==='cancelled')
   addWarning(warning(a,'REPORT.JOB_NOT_SUCCESS',job,job,'needs.'+job+'.result','success',
   entry.result,'Successful native execution cannot be inferred',
   'Inspect exact failing Actions job and repair its observed error'));
 }
 for(const e of errors)addWarning(warning(a,'REPORT.ARTIFACT_INVENTORY_UNAVAILABLE',
  'G9','publish_warnings',e.field,'valid full same-run inventory',e.reason,
  'Final evidence completeness cannot be established',
  'Restore the GitHub artifact inventory result'));
 const stages=[['ADMIT','admit'],['COLLECT','collect'],...GATES].map(([gate,job])=>
  stageEntries[gate]??defaultStatus(a,gate,job,needs[job]?.result,requested));
 const order=new Map(stages.map((x,i)=>[x.stage,i]));
 warnings.sort((x,y)=>(order.get(x.stage)??100)-(order.get(y.stage)??100)||
  String(x.jobId).localeCompare(String(y.jobId))||
  String(x.checkId).localeCompare(String(y.checkId))||x.warningId.localeCompare(y.warningId));
 const totals={attempted:stages.reduce((s,v)=>s+(v.attempted??0),0),
  completed:stages.reduce((s,v)=>s+(v.completed??0),0),
  notExecuted:stages.reduce((s,v)=>s+(v.notExecuted??0),0)};
 const report={schemaVersion:'curveyield-security-pipeline-warnings-v1',
  pipelineVersion:'v1',instructionVersion:'v14',
  runId:a['run-id'],runAttempt:Number(a['run-attempt']),headSha:a['run-head-sha'],
  extendedRequested:requested,extendedApproved:approved,
  warningCount:warnings.length,warnings,firstActionableWarning:warnings[0]??null,
  reportCompleteness:errors.length?'PARTIAL':'JOB_AND_ARTIFACT_METADATA_ONLY',
  sourceIdentity:null,artifactStatuses:parts,
  warningCountsByCode:Object.fromEntries([...new Set(warnings.map(w=>w.code))].sort()
   .map(k=>[k,warnings.filter(w=>w.code===k).length]))};
 const status={schemaVersion:'curveyield-security-pipeline-stage-status-v1',
  pipelineVersion:'v1',runId:a['run-id'],runAttempt:Number(a['run-attempt']),
  headSha:a['run-head-sha'],stages,jobs:needs,totals,
  toolkitComponents:COMPONENTS.map(componentId=>({componentId,status:'UNVERIFIED',
   reason:'NO_QUALIFIED_SAME_RUN_TOOLKIT_METADATA_CONSUMED'})),
  observedArtifacts:parts,controllerAcceptance:'NOT_ASSERTED'};
 const markdownLines=['# CurveYield Automated Security Pipeline v1 — after-workflow report','',
  'The implementation specification is v14; the pipeline is v1. Controller acceptance is not asserted.','',
  '- Run ID: '+a['run-id']+'; attempt: '+a['run-attempt'],
  '- Immutable workflow head: '+a['run-head-sha'],
  '- Extended requested: '+requested+'; independently approved: '+approved,
  '- Warning count: '+warnings.length,'','## Observed stages','',
  '| Gate | Job | Stage status | GitHub job result |','|---|---|---|---|'];
 for(const s of stages)markdownLines.push('| '+markdown(s.stage)+' | '+markdown(s.jobId)+' | '+
   markdown(s.status)+' | '+markdown(s.observedJobResult??'unknown')+' |');
 markdownLines.push('','## Detailed warnings','');
 if(!warnings.length)markdownLines.push('Zero verified warning entries; this does not establish full coverage.');
 for(const [i,w] of warnings.entries())
  markdownLines.push('', '### '+(i+1)+'. '+markdown(w.code),
   '- Stage/job: '+markdown(w.stage)+' / '+markdown(w.jobId),
   '- Field: '+markdown(w.configurationField),
   '- Expected: '+markdown(w.expected?.value),
   '- Observed: '+markdown(w.observed?.value),
   '- Evidence: '+markdown(w.nativeEvidenceRefs??[]),
   '- Impact: '+markdown(w.impact),
   '- Correction: '+markdown(w.requiredCorrection));
 markdownLines.push('','Private source files, secrets, fork state and raw transcripts were not reproduced in this public report.',
 'GitHub job completion alone does not establish native audit completion.','');
 const written=[writeJson(a['output-root'],'SECURITY_PIPELINE_WARNINGS_v1.json',report),
  writeJson(a['output-root'],'SECURITY_PIPELINE_STAGE_STATUS_v1.json',status),
  writeFile(a['output-root'],'SECURITY_PIPELINE_WARNINGS_v1.md',markdownLines.join('\n'))];
 if(process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
   '## Security Pipeline v1 — after-workflow report\nWarnings: '+warnings.length+
   '; requested: '+requested+'; approved: '+approved+'\n');
 for(const w of warnings){
  const title=safe(w.code,80).replaceAll('%','%25').replaceAll(':','%3A');
  const message=safe(w.mismatch+'; correction: '+w.requiredCorrection,500)
   .replaceAll('%','%25').replaceAll(':','%3A').replaceAll(',','%2C');
  console.log('::warning title='+title+'::'+message);
 }
 console.log(JSON.stringify({files:written,warningCount:warnings.length,stages:stages.length}));
}
function native(a){
 const issues=[];
 let result=null;
 try{
  if(!a['native-result'])throw Error('native result not provided');
  result=readJson(a['native-result'],a['input-root']);
  if(String(result.runId)!==a['run-id']||
    Number(result.runAttempt)!==Number(a['run-attempt'])||
    result.workflowHeadSha!==a['run-head-sha'])
   throw Error('native result belongs to different run or attempt');
  if(result.status!=='NATIVE_COMPLETED'||!/^[0-9a-f]{64}$/.test(
    String(result.originalNativeEvidenceSha256??'')))throw Error('native completion evidence unavailable');
 }catch(e){issues.push({field:'nativeResult',expected:'same-run native evidence and digest',
   observed:String(e),operationDisposition:'NOT_EXECUTED'});}
 const status=issues.length?'NOT_EXECUTED':'UNVERIFIED_PENDING_CONTROLLER_ACCEPTANCE';
 const out={schemaVersion:'curveyield-security-pipeline-native-reconciliation-v1',
  pipelineVersion:'v1',instructionVersion:'v14',operation:a.operation,
  runId:a['run-id'],runAttempt:Number(a['run-attempt']),headSha:a['run-head-sha'],
  status,issues,controllerAccepted:false};
 const fn=a.operation==='reconcile-native'?'SECURITY_NATIVE_RECONCILIATION_v1.json':
  'SECURITY_DOSSIER_QUALIFICATION_v1.json';
 console.log(JSON.stringify({file:writeJson(a['output-root'],fn,out),status}));
}
try{
 const a=argsOf(process.argv.slice(2));
 if(a.operation==='consolidate-warnings')consolidate(a);else native(a);
}catch(e){
 console.error('REPORT_WRITER_UNAVAILABLE:'+e.constructor.name+':'+e.message);
 process.exitCode=2;
}
