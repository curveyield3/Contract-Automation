// Private exact-source compilation cache shared by primary and No Telemetry Phase 0.
// Never store ASTs or bytecode in the public Contract-Automation repository or Actions caches.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {buildExecutionArtifactBundleV2} from './phase0-execution-input-v2.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// Synchronous FD2 marker is visible to an independent watchdog even if native
// synchronous solc blocks the JavaScript event loop before stdout can flush.
const markCompilation=message=>fsSync.writeSync(2,'[phase0-build-cache] '+message+'\n');
const PRIVATE_CACHE_ROOT = 'Phase0 Build Cache';
const PRIVATE_CACHE_REF = 'main';
const REPO='curveyield3/Audit-Controller';
const MAX_BYTES=768*1024*1024;
const MAX_GZIP_BYTES=256*1024*1024;
const CHUNK_BYTES=4*1024*1024;
const MAX_CHUNKS=Math.ceil(MAX_GZIP_BYTES/CHUNK_BYTES);
const SHA=/^[0-9a-f]{64}$/;
const SHA40=/^[0-9a-f]{40}$/;
// Only compilation-affecting runner implementation and resolution/lock files.
// A change in unrelated telemetry, phase logic or workflow YAML must not invalidate solc.
const identityParts=[
  'HEAD:packages/runner/src/build-dispatch.mjs',
  'HEAD:packages/runner/src/compiler.mjs',
  'HEAD:packages/runner/src/hermetic-standard-json.mjs',
  'HEAD:packages/runner/src/embedded-profile-build-v1.mjs',
  'HEAD:packages/runner/src/native-build.mjs',
  'HEAD:packages/runner/src/vyper-build.mjs',
  'HEAD:packages/github-native-sim/src/execution.mjs',
  'HEAD:package-lock.json',
  'HEAD:package.json'
];

export function privateBuildCacheIdentityV1({request,pseudo,projectRoot,toolIdentity}){
  if(!SHA.test(request?.source?.archiveSha256??''))throw new Error('build cache requires verified source digest');
  if(!SHA40.test(request?.source?.commit??''))throw new Error('build cache requires pinned source commit');
  if(!SHA.test(toolIdentity??''))throw new Error('build cache requires pinned compiler tool identity');
  if(!pseudo?.source?.projectPath || !pseudo?.configuration?.compilers?.length)throw new Error('build cache requires detected compiler configuration');
  if(!projectRoot)throw new Error('build cache requires a verified project root');
  const exact={
    schemaVersion:'curveyield-private-verified-compilation-cache-v1',
    sourceSha256:request.source.archiveSha256,
    sourceCommit:request.source.commit,
    sourceRepository:request.source.repository,
    sourceArchivePath:request.source.archivePath,
    campaignId:request.campaignId,
    campaignGenerationId:request.campaignGenerationId,
    projectPath:pseudo.source.projectPath,
    // Never use the machine-specific absolute root: GitHub runner workspaces vary.
    compilationConfiguration:pseudo.configuration,
    toolIdentity,
    nodeMajor:process.versions.node.split('.')[0]
  };
  return{exact,key:digest(JSON.stringify(exact))};
}

export function currentBuildToolIdentityV1(){
  const parts=identityParts.map(ref=>execFileSync('git',['rev-parse',ref],{encoding:'utf8'}).trim());
  if(parts.some(part=>!SHA40.test(part)))throw new Error('unresolved build tool identity');
  return digest(JSON.stringify(parts));
}
function validateCache(cache,identity,pseudo){
  if(cache?.schemaVersion!=='curveyield-private-verified-compilation-cache-v1' ||
    cache.key!==identity.key || JSON.stringify(cache.exact)!==JSON.stringify(identity.exact) ||
    cache.build?.status!=='completed' || !SHA.test(cache.buildSha256??'') ||
    digest(JSON.stringify(cache.build))!==cache.buildSha256)return false;
  try{
    const bundle=buildExecutionArtifactBundleV2({request:pseudo,build:cache.build});
    return bundle.artifacts.length>0 && bundle.buildIdentity.compilationUnits.length>0;
  }catch{return false;}
}
function cacheBase({request,key}){
  const campaignPath=request?.destination?.campaignPath;
  if(!/^campaigns\/[A-Za-z0-9._ /-]+$/.test(campaignPath??'') ||
    campaignPath.includes('..'))throw new Error('build cache path must be within canonical private campaign');
  const id=String(request.campaignId??'');
  if(!/^[A-Za-z0-9._-]+$/.test(id)||id==='..')throw new Error('unsafe private build cache campaign ID');
  return PRIVATE_CACHE_ROOT+'/'+id+'/PHASE0_VERIFIED_COMPILATION_'+key;
}
function privateContentUrl({request,key}){
  return 'repos/'+REPO+'/contents/'+(cacheBase({request,key})+'/manifest.json').split('/').map(encodeURIComponent).join('/');
}
function ghEnv(token){return {...process.env,GH_TOKEN:token,GITHUB_TOKEN:token};}
function ghJson(endpoint,{token,method='GET',body=null,timeout=90000}={}){
  const argv=['api',endpoint];let tmp=null;
  if(body!==null){
    tmp=path.join(process.env.RUNNER_TEMP??os.tmpdir(),'phase0-cache-api-'+process.pid+'-'+Math.random().toString(16).slice(2)+'.json');
    requireWrite(tmp,JSON.stringify(body));
    argv.push('--method',method,'--input',tmp);
  }
  try{
    const bytes=execFileSync('gh',argv,{env:ghEnv(token),maxBuffer:Math.min(MAX_BYTES,64*1024*1024),timeout,stdio:['ignore','pipe','pipe']});
    return JSON.parse(bytes.toString('utf8'));
  }finally{if(tmp){try{(awaitlessUnlink)(tmp);}catch{}}}
}
// gh CLI has no streaming stdin API in execFileSync; temporary files are mode 0600.
import fss from 'node:fs';
function requireWrite(file,value){fss.writeFileSync(file,value,{mode:0o600});}
function awaitlessUnlink(file){fss.rmSync(file,{force:true});}
function gitBlob(token,bytes){
  return ghJson('repos/'+REPO+'/git/blobs',{token,method:'POST',body:{content:bytes.toString('base64'),encoding:'base64'},timeout:120000}).sha;
}
function getPrivateContents(token,url){
  const envelope=ghJson(url+'?ref='+encodeURIComponent(PRIVATE_CACHE_REF),{token,timeout:60000});
  if(envelope.encoding!=='base64'||!envelope.content)throw new Error('private cache manifest unavailable');
  return JSON.parse(Buffer.from(envelope.content,'base64').toString('utf8'));
}
export function splitPrivateCompilationCacheV1(bytes,chunkSize=CHUNK_BYTES){
  if(bytes.length>MAX_GZIP_BYTES)throw new Error('private compilation gzip exceeds 256MiB safety cap');
  const chunks=[];
  for(let start=0;start<bytes.length;start+=chunkSize)chunks.push(bytes.subarray(start,start+chunkSize));
  if(!chunks.length||chunks.length>MAX_CHUNKS)throw new Error('private compilation chunk count invalid');
  return chunks;
}
async function tryLoad({url,token,identity,pseudo}){
  const manifest=getPrivateContents(token,url);
  if(manifest.schemaVersion!=='curveyield-private-verified-compilation-chunks-v1' ||
    manifest.key!==identity.key || JSON.stringify(manifest.exact)!==JSON.stringify(identity.exact) ||
    !Array.isArray(manifest.chunks)||!manifest.chunks.length ||
    manifest.chunks.length>MAX_CHUNKS || !SHA.test(manifest.gzipSha256??''))throw new Error('private compilation cache manifest invalid');
  const chunks=[];
  for(const [i,row] of manifest.chunks.entries()){
    if(!SHA40.test(row.blobSha??'')||!SHA.test(row.sha256??'')||
      !Number.isInteger(row.bytes)||row.bytes<1||row.bytes>CHUNK_BYTES)
      throw new Error('invalid private compilation chunk metadata');
    const blob=ghJson('repos/'+REPO+'/git/blobs/'+row.blobSha,{token,timeout:90000});
    if(blob.encoding!=='base64'||!blob.content)throw new Error('private cache blob unavailable');
    const bytes=Buffer.from(blob.content.replace(/\s/g,''),'base64');
    if(bytes.length!==row.bytes||digest(bytes)!==row.sha256)throw new Error('private cache chunk hash mismatch '+i);
    chunks.push(bytes);
  }
  const gz=Buffer.concat(chunks);
  if(gz.length!==manifest.gzipBytes||digest(gz)!==manifest.gzipSha256)throw new Error('private cache compressed digest mismatch');
  const raw=gunzipSync(gz,{maxOutputLength:MAX_BYTES});
  if(raw.length!==manifest.jsonBytes||digest(raw)!==manifest.jsonSha256)throw new Error('private cache payload digest mismatch');
  const cache=JSON.parse(raw.toString('utf8'));
  if(!validateCache(cache,identity,pseudo))throw new Error('private compilation cache exact build identity failed');
  console.log('[phase0-build-cache] chunk verification PASS count='+chunks.length+' bytes='+gz.length);
  return cache.build;
}
async function tryPublish({url,token,identity,pseudo,build,request}){
  const payload={schemaVersion:'curveyield-private-verified-compilation-cache-v1',
    key:identity.key,exact:identity.exact,buildSha256:digest(JSON.stringify(build)),build};
  if(!validateCache(payload,identity,pseudo))throw new Error('compiled artifact cache validation failed');
  const raw=Buffer.from(JSON.stringify(payload));
  if(raw.length>MAX_BYTES)throw new Error('private compiled build exceeds 768MiB cap');
  const gz=gzipSync(raw,{level:6});
  const chunks=splitPrivateCompilationCacheV1(gz);
  const base=cacheBase({request,key:identity.key});
  console.log('[phase0-build-cache] publishing private compilation; raw_bytes='+raw.length+
    ' gzip_bytes='+gz.length+' parts='+chunks.length);
  const rows=[];
  for(let i=0;i<chunks.length;i++){
    const bytes=chunks[i],sha=gitBlob(token,bytes);
    if(!SHA40.test(sha??''))throw new Error('private build cache blob upload not verified');
    rows.push({path:'part-'+String(i).padStart(4,'0')+'.gzchunk',blobSha:sha,sha256:digest(bytes),bytes:bytes.length});
    console.log('[phase0-build-cache] uploaded private part '+(i+1)+'/'+chunks.length);
  }
  const manifest={
    schemaVersion:'curveyield-private-verified-compilation-chunks-v1',
    key:identity.key,exact:identity.exact,
    jsonBytes:raw.length,jsonSha256:digest(raw),gzipBytes:gz.length,gzipSha256:digest(gz),
    chunks:rows
  };
  const manifestSha=gitBlob(token,Buffer.from(JSON.stringify(manifest)+'\n'));
  // Publish the complete manifest and all parts in ONE fast-forward-only private
  // Audit-Controller/main commit. No partial cache can ever become visible.
  for(let attempt=0;attempt<4;attempt++){
    const ref=ghJson('repos/'+REPO+'/git/ref/heads/'+PRIVATE_CACHE_REF,{token});
    const head=ref.object?.sha;
    if(!SHA40.test(head??''))throw new Error('private main ref unavailable');
    const commit=ghJson('repos/'+REPO+'/git/commits/'+head,{token});
    const tree=[
      ...rows.map(row=>({path:base+'/'+row.path,mode:'100644',type:'blob',sha:row.blobSha})),
      {path:base+'/manifest.json',mode:'100644',type:'blob',sha:manifestSha}
    ];
    const newTree=ghJson('repos/'+REPO+'/git/trees',{token,method:'POST',body:{base_tree:commit.tree.sha,tree}});
    const next=ghJson('repos/'+REPO+'/git/commits',{token,method:'POST',body:{
      message:'cache(phase0): store verified private build '+identity.key.slice(0,16),
      tree:newTree.sha,parents:[head]}});
    try{
      ghJson('repos/'+REPO+'/git/refs/heads/'+PRIVATE_CACHE_REF,{token,method:'PATCH',body:{sha:next.sha,force:false}});
      console.log('[phase0-build-cache] published atomic private main cache key='+identity.key.slice(0,16)+' commit='+next.sha.slice(0,12));
      return;
    }catch(error){
      if(attempt===3)throw new Error('private main cache commit race: '+String(error.message).slice(0,220));
      console.log('[phase0-build-cache] concurrent controller main update; rebasing private cache commit attempt '+(attempt+2));
    }
  }
}
export async function compileWithPrivateCacheV1({request,pseudo,projectRoot,compile,
  token=process.env.AUDIT_CONTROLLER_GITHUB_TOKEN,
  enabled=process.env.PHASE0_PRIVATE_BUILD_CACHE_ENABLED==='true'}){
  if(!enabled||!token){
    console.log('[phase0-build-cache] disabled (untrusted request or missing private credential); compiling');
    markCompilation('COMPILATION_START cache_disabled=true');
    const start=Date.now();
    const build=await compile();
    markCompilation('COMPILATION_DONE elapsed_seconds='+Math.floor((Date.now()-start)/1000));
    return build;
  }
  let identity,url;
  try{
    identity=privateBuildCacheIdentityV1({request,pseudo,projectRoot,toolIdentity:currentBuildToolIdentityV1()});
    url=privateContentUrl({request,key:identity.key});
  }catch(error){
    console.log('[phase0-build-cache] cannot establish exact provenance; compiling: '+String(error.message).slice(0,200));
    markCompilation('COMPILATION_START identity_unavailable=true');
    const start=Date.now();
    const build=await compile();
    markCompilation('COMPILATION_DONE elapsed_seconds='+Math.floor((Date.now()-start)/1000));
    return build;
  }
  try{
    const build=await tryLoad({url,ref:PRIVATE_CACHE_REF,token,identity,pseudo});
    console.log('[phase0-build-cache] verified private cache HIT, key='+identity.key.slice(0,16)+'; skipping Solidity recompilation');
    return build;
  }catch(error){
    // Report the real reason. Distinguish not-yet-populated caches from invalid
    // manifests, missing chunks, corruption and authentication errors.
    console.log('[phase0-build-cache] MISS key='+identity.key.slice(0,16)+' reason='+
      String(error?.message??error).replace(/\s+/g,' ').slice(0,240));
  }
  markCompilation('COMPILATION_START key='+identity.key.slice(0,16));
  const started=Date.now();
  const build=await compile();
  markCompilation('COMPILATION_DONE elapsed_seconds='+Math.floor((Date.now()-started)/1000));
  try{await tryPublish({url,ref:PRIVATE_CACHE_REF,token,identity,pseudo,build,request});}
  catch(error){console.log('[phase0-build-cache] PUBLISH_FAILED reason='+String(error.message).replace(/\s+/g,' ').slice(0,300));}
  return build;
}
