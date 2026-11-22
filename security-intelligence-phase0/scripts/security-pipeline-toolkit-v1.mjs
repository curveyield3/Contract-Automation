#!/usr/bin/env node
// CurveYield Security Pipeline v1: component-specific cache identities and verification.
// Trusted current-checkout pins only; no arbitrary installer, URL or command input.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {sha256HexV1,digestCanonicalV1} from '../packages/github-native-sim/src/canonical-json-v1.mjs';

const COMPONENTS=['foundry-node','source-compilers','slither-storage','medusa',
 'wake','mythril','certora-prover','autoprover','mimo-runtime','mimo-weights'];
const OPERATIONS=['plan','inspect','provision','verify-tree','finalize','restore-consumer'];
const CONSUMERS=['toolkit_prepare','toolkit_qualify','mimo_configure','fork_setup',
 'storage_inspect','medusa_analyze','wake_analyze','mythril_analyze',
 'prover_qualify','mimo_provider_qualify','autoprover_run'];
const SHA=/^[a-f0-9]{64}$/;
const ROOT=path.resolve(process.env.GITHUB_WORKSPACE??process.cwd());
const TEMP=path.resolve(process.env.RUNNER_TEMP??path.join(ROOT,'.toolkit-temporary'));

function parseArgs(argv){
 const valid=new Set(['operation','component','profile','run-identity','toolkit-root',
  'output-root','cache-hit','restore-outcome','consumer-job','github-output']);
 const a={};
 for(let i=0;i<argv.length;i++){
  const k=argv[i].startsWith('--')?argv[i].slice(2):'';
  if(!valid.has(k)||Object.hasOwn(a,k)||!argv[i+1]||argv[i+1].startsWith('--'))
   throw Error('TOOLKIT_OPTION_INVALID:'+argv[i]);
  a[k]=argv[++i];
 }
 for(const k of ['operation','component','profile','run-identity','toolkit-root','output-root']){
  if(!a[k])throw Error('TOOLKIT_REQUIRED_ARGUMENT_MISSING:'+k);
 }
 if(!OPERATIONS.includes(a.operation)||!COMPONENTS.includes(a.component))
  throw Error('TOOLKIT_OPERATION_OR_COMPONENT_UNKNOWN');
 if(a['consumer-job']&&!CONSUMERS.includes(a['consumer-job']))
  throw Error('TOOLKIT_CONSUMER_NOT_RECOGNIZED');
 if(a['cache-hit']&&!['true','false'].includes(a['cache-hit']))
  throw Error('TOOLKIT_CACHE_HIT_VALUE_INVALID');
 if(a['restore-outcome']&&!['success','failure','skipped'].includes(a['restore-outcome']))
  throw Error('TOOLKIT_RESTORE_OUTCOME_INVALID');
 const expected=path.join(TEMP,'security-pipeline','toolkit',a.component,'payload');
 if(path.resolve(a['toolkit-root'])!==expected)
  throw Error('TOOLKIT_ROOT_NOT_FIXED_RUNNER_COMPONENT_PATH');
 return a;
}
function checkedBytes(f,max=16*1024*1024){
 const rp=path.resolve(f);
 if(fs.lstatSync(rp).isSymbolicLink())throw Error('TOOLKIT_SYMLINK_INPUT:'+f);
 const stat=fs.statSync(rp);
 if(!stat.isFile()||stat.size>max)throw Error('TOOLKIT_INPUT_INVALID:'+f);
 return fs.readFileSync(rp);
}
function readJson(p){const bytes=checkedBytes(p);return {value:JSON.parse(bytes.toString('utf8')),sha256:sha256HexV1(bytes)};}
function writeJson(root,name,obj){
 fs.mkdirSync(root,{recursive:true});
 const file=path.join(root,name),temp=file+'.tmp';
 fs.writeFileSync(temp,JSON.stringify(obj,null,2)+'\n',{mode:0o600});
 fs.renameSync(temp,file);
 return sha256HexV1(fs.readFileSync(file));
}
function context(a){
 const {value:x,sha256}=readJson(a['run-identity']);
 if(!/^\d+$/.test(String(x.runId??''))||!/^\d+$/.test(String(x.runAttempt??'')))
  throw Error('TOOLKIT_RUN_CONTEXT_INVALID');
 if(process.env.GITHUB_RUN_ID&&String(x.runId)!==process.env.GITHUB_RUN_ID)
  throw Error('TOOLKIT_RUN_ID_MISMATCH');
 if(process.env.GITHUB_RUN_ATTEMPT&&String(x.runAttempt)!==process.env.GITHUB_RUN_ATTEMPT)
  throw Error('TOOLKIT_RUN_ATTEMPT_MISMATCH');
 if(process.env.GITHUB_SHA&&x.workflowHeadSha!==process.env.GITHUB_SHA)
  throw Error('TOOLKIT_WORKFLOW_HEAD_MISMATCH');
 return {runId:String(x.runId),runAttempt:Number(x.runAttempt),
  workflowHeadSha:x.workflowHeadSha??null,contextDigestSha256:sha256};
}
function repoFile(rel){
 const resolved=path.resolve(ROOT,rel);
 if(!resolved.startsWith(ROOT+path.sep))throw Error('TOOLKIT_TRUSTED_PATH_INVALID');
 return checkedBytes(resolved);
}
function observedPins(component){
 const packageLock=repoFile('security-intelligence-phase0/package-lock.json');
 const packageMeta=repoFile('security-intelligence-phase0/package.json');
 const source={
  packageLockSha256:null,
  packageJsonSha256:null,
  workflowPinsSha256:null,
  nativeToolchainPinsSha256:null
 };
 if(['foundry-node','source-compilers'].includes(component)){
  source.packageLockSha256=sha256HexV1(packageLock);
  source.packageJsonSha256=sha256HexV1(packageMeta);
 }
 const workflowText=repoFile('.github/workflows/lite-solo-ai-inference-v1.yml').toString('utf8');
 const dockerBytes=repoFile('security-intelligence-phase0/Dockerfile');
 if(['slither-storage','source-compilers'].includes(component))
  source.nativeToolchainPinsSha256=sha256HexV1(dockerBytes);
 // Hash only the component's actual pin tuple, not unrelated workflow source.
 // Populated after reading the current trusted workflow's exact pin fields.
 const val=(key,pattern)=>{
  const matches=[...workflowText.matchAll(pattern)];
  return matches.length===1?matches[0][1]:null;
 };
 const modelSha=val('MODEL_SHA256',/^\s*MODEL_SHA256:\s*([a-f0-9]{64})\s*$/gm);
 const modelRev=val('MODEL_REVISION',/^\s*MODEL_REVISION:\s*([a-f0-9]{40})\s*$/gm);
 const modelFile=val('MODEL_FILE',/^\s*MODEL_FILE:\s*([A-Za-z0-9._-]+)\s*$/gm);
 const llamaSha=val('LLAMA_SHA',/^\s*LLAMA_SHA:\s*([a-f0-9]{40})\s*$/gm);
 if(component==='mimo-weights')
  source.workflowPinsSha256=digestCanonicalV1([modelSha,modelRev,modelFile]);
 if(component==='mimo-runtime')
  source.workflowPinsSha256=digestCanonicalV1([llamaSha,'cpu','GGML_NATIVE_OFF']);
 const pkg=JSON.parse(packageLock.toString('utf8'));
 const rootDeps=pkg.packages?.['']?.dependencies??{};
 return {observedTrustedSourceDigests:source,
  knownModelSha256:modelSha,modelRevision:modelRev,modelFile,
  llamaCppRevision:llamaSha,foundryVersion:
   rootDeps['@foundry-rs/anvil']==='1.7.1'&&
   rootDeps['@foundry-rs/forge']==='1.7.1'?
    '1.7.1':rootDeps['@foundry-rs/anvil']??null};
}
function approvedComponent(a){
 const {value:profile,sha256}=readJson(a.profile);
 if(profile.schemaVersion!=='curveyield-toolkit-profile-v1'||
   !Array.isArray(profile.components))throw Error('TOOLKIT_PROFILE_SCHEMA_MISMATCH');
 const row=profile.components.find(x=>x.componentId===a.component);
 if(!row||profile.components.filter(x=>x.componentId===a.component).length!==1)
  throw Error('TOOLKIT_PROFILE_COMPONENT_MISSING_OR_DUPLICATED');
 const trusted=observedPins(a.component);
 const expected=typeof row.expectedBinarySha256==='string'?row.expectedBinarySha256:null;
 // An input profile cannot approve itself. The only independently existing
 // byte digest qualified here is the current checked-out MiMo GGUF pin.
 const sameTrustedModel=a.component==='mimo-weights'&&SHA.test(String(trusted.knownModelSha256))&&
  expected===trusted.knownModelSha256&&row.approvedSourceRevision===trusted.modelRevision;
 const pinQualified=sameTrustedModel;
 const required=row.required===true;
 const keyParts={
  schemaVersion:'curveyield-toolkit-component-identity-v1',
  namespace:'cy-security-pipeline-toolkit-v1',
  componentId:a.component,os:process.platform,arch:process.arch,
  nativeABI:'node'+process.versions.modules,
  approvedSourceRevision:pinQualified?trusted.modelRevision:null,
  dependencyLockSha256:a.component==='foundry-node'||a.component==='source-compilers'?
   trusted.observedTrustedSourceDigests.packageLockSha256:null,
  installRecipeSha256:digestCanonicalV1([a.component,'trusted-recipe-v1',trusted.observedTrustedSourceDigests]),
  compilerIdentitySha256:null,buildFlagsSha256:null,
  approvedPayloadProfileSha256:pinQualified?digestCanonicalV1([
   trusted.modelFile,trusted.knownModelSha256]):null
 };
 const digest=digestCanonicalV1(keyParts);
 const key='cy-security-pipeline-toolkit-v1-'+a.component+'-'+process.platform+'-'+
  process.arch+'-node'+process.versions.modules+'-'+digest;
 const warnings=[];
 if(row.required!==true&&row.required!==false)
  warnings.push({code:'TOOLKIT.COMPONENT_REQUIREMENT_UNRESOLVED',
   fieldPath:'TOOLKIT_PROFILE_v1.json.components['+a.component+'].required',
   expected:'boolean derived from original G2 compatibility',
   observed:row.required??null,
   correction:'Bind required/NOT_REQUIRED to the original source-bound target plan'});
 if(required&&!pinQualified)warnings.push({code:'TOOLKIT.COMPONENT_PIN_UNRESOLVED',
  fieldPath:'TOOLKIT_PROFILE_v1.json.components['+a.component+'].expectedBinarySha256',
  expected:'independently qualified binary digest from trusted current checkout',
  observed:expected,'correction':'Qualify exact native bytes and immutable source revision; do not trust profile self-approval'});
 return {profileDigestSha256:sha256,component:row,trusted,expectedBinarySha256:pinQualified?expected:null,
  pinQualified,required,identity:keyParts,cacheKey:key,componentIdentitySha256:digest,warnings};
}
function safeFile(root,filename){
 const target=path.resolve(root,filename),base=path.resolve(root);
 if(target!==base&&!target.startsWith(base+path.sep))throw Error('TOOLKIT_INVALID_RELATIVE_BINARY_PATH');
 if(fs.lstatSync(base).isSymbolicLink())throw Error('TOOLKIT_PAYLOAD_ROOT_SYMLINK');
 if(fs.lstatSync(target).isSymbolicLink())throw Error('TOOLKIT_EXECUTABLE_IS_SYMLINK');
 if(!fs.statSync(target).isFile())throw Error('TOOLKIT_EXPECTED_BINARY_NOT_FILE');
 return target;
}
function digestLargeFile(file){
 const hasher=crypto.createHash('sha256'),fd=fs.openSync(file,'r');
 const chunk=Buffer.allocUnsafe(1024*1024);
 try{
  for(;;){
   const bytes=fs.readSync(fd,chunk,0,chunk.length,null);
   if(!bytes)break;
   hasher.update(chunk.subarray(0,bytes));
  }
 }finally{fs.closeSync(fd);}
 return hasher.digest('hex');
}
function inspect(a,profile,ctx){
 const root=a['toolkit-root'];
 if(!profile.pinQualified)return {verified:false,reason:'INDEPENDENT_NATIVE_PIN_NOT_QUALIFIED',sha256:null};
 const name=profile.trusted.modelFile;
 if(a.component!=='mimo-weights'||!name)
  return {verified:false,reason:'NO_APPROVED_NATIVE_BINARY_MANIFEST',sha256:null};
 const start=Date.now();
 try{
  const manifestFile=safeFile(root,'TOOLKIT_CACHE_COMPONENT_MANIFEST_v1.json');
  const original=readJson(manifestFile).value;
  if(original.schemaVersion!=='curveyield-toolkit-component-manifest-v1'||
    original.componentId!==a.component||
    original.componentIdentitySha256!==profile.componentIdentitySha256||
    original.cacheKey!==profile.cacheKey||
    original.binaryName!==name||
    original.originalExpectedBinarySha256!==profile.expectedBinarySha256||
    original.sourceRevision!==profile.trusted.modelRevision)
   throw Error('CACHE_MANIFEST_ORIGIN_IDENTITY_MISMATCH');
  const binary=safeFile(root,name);
  const stat=fs.statSync(binary);
  if(!Number.isSafeInteger(stat.size)||stat.size<=0||stat.size!==original.binaryBytes)
   throw Error('CACHE_BINARY_BYTE_LENGTH_MISMATCH');
  const real=digestLargeFile(binary);
  if(real!==profile.expectedBinarySha256||real!==original.originalObservedBinarySha256)
   throw Error('ORIGINAL_TRUSTED_BINARY_DIGEST_MISMATCH');
  const warm=a['cache-hit']==='true'&&
    String(original.originRunId)!==ctx.runId;
  return {verified:true,reason:warm?'ORIGINAL_BYTES_WARM_REUSE_VERIFIED':
    'MATCHES_TRUSTED_WORKFLOW_PIN',sha256:real,
    relativeBinaryPath:name,verifyMs:Date.now()-start,
    bytes:stat.size,warmReuseDemonstrated:warm,
    coldInstallMs:original.nativeInstallMs??null,originRunId:original.originRunId};
 }catch(e){
  return {verified:false,reason:'CACHE_MANIFEST_OR_BINARY_INVALID:'+e.message,
   sha256:null,verifyMs:Date.now()-start};
 }
}
async function provisionApprovedComponent(a,profile,ctx){
 if(a.component!=='mimo-weights'||!profile.pinQualified||!profile.required)
  throw Error('NO_INDEPENDENTLY_PINNED_INSTALL_RECIPE_FOR_COMPONENT');
 const root=a['toolkit-root'];
 const filename=profile.trusted.modelFile;
 const revision=profile.trusted.modelRevision;
 const original=profile.expectedBinarySha256;
 if(!/^[a-f0-9]{40}$/.test(String(revision))||
    !/^[A-Za-z0-9._-]+$/.test(String(filename))||
    !SHA.test(String(original)))throw Error('TRUSTED_MIMO_INSTALL_PIN_INVALID');
 fs.mkdirSync(root,{recursive:true,mode:0o700});
 const target=path.join(root,filename),tmp=target+'.partial-'+ctx.runId;
 if(fs.existsSync(target)||fs.existsSync(tmp))
  throw Error('INSTALL_DESTINATION_ALREADY_EXISTS_REQUIRES_INSPECTION');
 const started=Date.now();
 const CAP=8*1024*1024*1024;
 const available=fs.statfsSync(root);
 const free=available.bavail*available.bsize;
 if(free<CAP/2)throw Error('INSUFFICIENT_DISK_FOR_PINNED_GGUF_DOWNLOAD:availableBytes='+free);
 const trustedURL='https://huggingface.co/bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF/resolve/'+
    revision+'/'+filename;
 const response=await fetch(trustedURL,{signal:AbortSignal.timeout(20*60*1000),
  redirect:'follow'});
 if(!response.ok||!response.body)throw Error('TRUSTED_MODEL_DOWNLOAD_HTTP_'+response.status);
 const declared=Number(response.headers.get('content-length')??0);
 if(declared>CAP)throw Error('TRUSTED_MODEL_DOWNLOAD_EXCEEDS_BYTE_CAP');
 const hash=crypto.createHash('sha256');
 const handle=await fs.promises.open(tmp,'wx',0o600);
 let bytes=0,successful=false;
 try{
  const reader=response.body.getReader();
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   bytes+=value.byteLength;
   if(bytes>CAP)throw Error('GGUF_STREAM_BYTE_CAP_EXCEEDED');
   hash.update(value);
   await handle.writeFile(value);
  }
  if(declared&&declared!==bytes)throw Error('GGUF_DECLARED_LENGTH_MISMATCH');
  const observed=hash.digest('hex');
  if(observed!==original)throw Error('GGUF_TRUSTED_ORIGINAL_SHA256_MISMATCH');
  await handle.sync();
  successful=true;
 }finally{
  await handle.close();
  if(!successful)await fs.promises.rm(tmp,{force:true});
 }
 await fs.promises.rename(tmp,target);
 const completed=Date.now();
 const binaryHash=digestLargeFile(target);
 if(binaryHash!==original){
  await fs.promises.rm(target,{force:true});
  throw Error('GGUF_POST_RENAME_SHA256_MISMATCH');
 }
 const record={schemaVersion:'curveyield-toolkit-component-manifest-v1',
  componentId:a.component,componentIdentitySha256:profile.componentIdentitySha256,
  cacheKey:profile.cacheKey,binaryName:filename,binaryBytes:bytes,
  originalExpectedBinarySha256:original,originalObservedBinarySha256:binaryHash,
  sourceRevision:revision,originRunId:ctx.runId,originRunAttempt:ctx.runAttempt,
  nativeInstallMs:completed-started,origin:'TRUSTED_PINNED_GGUF_SOURCE',
  exactTrustedModelAlias:'lite-solo-mimo-v1',controllerAccepted:false};
 writeJson(root,'TOOLKIT_CACHE_COMPONENT_MANIFEST_v1.json',record);
 return {bytes,elapsedMs:Date.now()-started,verified:true,sha256:binaryHash};
}

function outputs(file,values){
 if(!file)return;
 const lines=Object.entries(values).map(([k,v])=>k+'='+String(v).replace(/[\r\n]/g,'')).join('\n')+'\n';
 fs.appendFileSync(file,lines);
}
async function main(){
 const a=parseArgs(process.argv.slice(2)),ctx=context(a),profile=approvedComponent(a);
 const root=a['output-root'],started=Date.now();
 const provisionable=profile.required&&profile.pinQualified;
 let status='PIN_UNRESOLVED',verification=null,installed=null,nativeError=null;
 if(!profile.required&&profile.component.required===false)status='NOT_REQUIRED';
 else if(!profile.required)status='REQUIREMENT_UNRESOLVED';
 else if(provisionable)status='READY_FOR_VERIFIED_RESTORE_OR_INSTALL';
 if(a.operation==='provision'){
  try{
   installed=await provisionApprovedComponent(a,profile,ctx);
   verification=inspect(a,profile,ctx);
   status=verification.verified?'INSTALLED_VERIFIED':'UNVERIFIED';
  }catch(error){
   nativeError=error.message;
   status='NOT_EXECUTED';
   profile.warnings.push({code:'TOOLKIT.PINNED_INSTALL_UNAVAILABLE',
    fieldPath:'toolkitComponents['+a.component+'].originalByteInstallation',
    expected:'trusted pinned original-byte source and exact independent SHA256',
    observed:nativeError,correction:'Repair exact trusted download/byte verification; never execute unverified cache'});
  }
 }
 if(['inspect','verify-tree','restore-consumer','finalize'].includes(a.operation)){
  verification=inspect(a,profile,ctx);
  if(verification.verified)
   status=verification.warmReuseDemonstrated?'RESTORED_VERIFIED':
     verification.originRunId===ctx.runId?'INSTALLED_VERIFIED':'RESTORED_VERIFIED';
  else status=a['cache-hit']==='true'?'CACHE_CORRUPT':'UNVERIFIED';
 }
 const metrics={schemaVersion:'curveyield-toolkit-component-metrics-v1',pipelineVersion:'v1',
  componentId:a.component,operation:a.operation,
  componentIdentitySha256:profile.componentIdentitySha256,cacheKey:profile.cacheKey,
  runId:ctx.runId,runAttempt:ctx.runAttempt,workflowHeadSha:ctx.workflowHeadSha,
  status,usableForExecution:verification?.verified===true,
  expectedBinarySha256:profile.expectedBinarySha256,
  observedBinarySha256:verification?.sha256??null,
  cacheHit:a['cache-hit']??null,restoreOutcome:a['restore-outcome']??null,
  componentRequired:profile.component.required??null,pinQualified:profile.pinQualified,
  profileSha256:profile.profileDigestSha256,
  sourcePins:profile.trusted.observedTrustedSourceDigests,
  warnings:profile.warnings,actualInstallerExecuted:installed!==null,
  nativeReadiness:verification?.reason??nativeError??status,
  elapsedMilliseconds:Date.now()-started,
  bytesDownloaded:installed?.bytes??0,
  cacheBytes:verification?.bytes??null,
  installMs:installed?.elapsedMs??verification?.coldInstallMs??null,
  verifyMs:verification?.verifyMs??null,
  warmReuseDemonstrated:verification?.warmReuseDemonstrated??false,
  peakRssBytes:process.memoryUsage().rss};
 writeJson(root,'TOOLKIT_CACHE_COMPONENT_IDENTITY_v1.json',{
  schemaVersion:'curveyield-toolkit-component-identity-v1',...profile.identity,
  digestSha256:profile.componentIdentitySha256,cacheKey:profile.cacheKey,
  expectedBinarySha256:profile.expectedBinarySha256});
 writeJson(root,'TOOLKIT_CACHE_COMPONENT_METRICS_v1.json',metrics);
 if(a.operation==='plan')
  outputs(a['github-output'],{cache_key:profile.cacheKey,
   cache_path:a['toolkit-root'],provisionable:String(provisionable),
   component_required:String(profile.required)});
 if(['verify-tree','restore-consumer','provision'].includes(a.operation))
  outputs(a['github-output'],{usableForExecution:String(verification?.verified===true)});
 console.log(JSON.stringify({componentId:a.component,operation:a.operation,status,
  warningCount:profile.warnings.length,usableForExecution:metrics.usableForExecution,
  actualInstallerExecuted:metrics.actualInstallerExecuted,bytesDownloaded:metrics.bytesDownloaded}));
}
main().catch(e=>{
 console.error('TOOLKIT_ADAPTER_UNAVAILABLE:'+e.constructor.name+':'+e.message);
 process.exitCode=2;
});
