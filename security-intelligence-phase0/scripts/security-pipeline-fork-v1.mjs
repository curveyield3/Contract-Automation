#!/usr/bin/env node
// U08 standalone-v1 fork adapter. Uses original Phase-0 deploy-only primitives.
// NEVER uses the private MI controller receipt or invents an execution lease.
// Native execution is exclusively on an independently approved localhost Anvil.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SHA=/^[a-f0-9]{64}$/;
const HEAD=/^[a-f0-9]{40}$/;
const ADDR=/^0x[0-9a-fA-F]{40}$/;
const BLOCK=/^0x[a-f0-9]{64}$/i;
const CAP=16*1024*1024;
const PARAMETERS=new Set(['operation','plan','authority','source-manifest','build-evidence',
  'source-zip','toolkit-profile','toolkit-root','run-identity','private-root','output-root']);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const scrub=x=>String(x??'').replace(/(bearer|token|secret|password|private.?key|rpc.?url)\s*[:=]\s*[^,\s]+/gi,'$1=[REDACTED]')
  .replace(/https?:\/\/[^\s"']+/gi,'[REDACTED_URL]').slice(0,300);
function argsOf(argv){
 const a={};
 for(let i=0;i<argv.length;i++){
  const key=argv[i]?.startsWith('--')?argv[i].slice(2):'';
  if(!PARAMETERS.has(key)||Object.hasOwn(a,key)||!argv[i+1]||String(argv[i+1]).startsWith('--'))
   throw Error('FORK_OPTION_NOT_ALLOWED:'+String(argv[i]));
  a[key]=argv[++i];
 }
 for(const key of ['operation','plan','authority','source-manifest','run-identity','output-root'])
  if(!a[key])throw Error('FORK_REQUIRED_INPUT_MISSING:'+key);
 if(!['inspect','execute'].includes(a.operation))throw Error('FORK_OPERATION_UNKNOWN');
 return a;
}
async function json(file){
 const p=path.resolve(file),s=await fs.lstat(p);
 if(!s.isFile()||s.isSymbolicLink()||s.size>CAP||s.size<2)
  throw Error('FORK_INPUT_NOT_REGULAR_BOUNDED_FILE:'+path.basename(p));
 const bytes=await fs.readFile(p);
 return {value:JSON.parse(bytes.toString('utf8')),sha256:sha(bytes)};
}
async function emit(root,name,payload){
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const file=path.join(root,name),tmp=file+'.tmp';
 await fs.writeFile(tmp,JSON.stringify(payload,null,2)+'\n',{mode:0o600});
 await fs.rename(tmp,file);
 return {name,sha256:sha(await fs.readFile(file))};
}
function problem(code,field,expected,observed,correction){
 return {code,configurationField:field,expected,observed:scrub(observed),
  impact:'G2B affected native operation NOT_EXECUTED, independent source analysis remains eligible',
  correction};
}
function sameRun(ctx,disposition,plan){
 if(!/^\d+$/.test(String(ctx.runId))||!Number.isInteger(ctx.runAttempt)||
   !HEAD.test(ctx.workflowHeadSha??'')||
   String(ctx.runId)!==process.env.GITHUB_RUN_ID||
   String(ctx.runAttempt)!==process.env.GITHUB_RUN_ATTEMPT||
   ctx.workflowHeadSha!==process.env.GITHUB_SHA)
  throw Error('FORK_IMMUTABLE_RUN_BINDING_MISMATCH');
 for(const [name,x] of [['disposition',disposition],['plan',plan.runIdentity]]){
  if(String(x?.runId)!==String(ctx.runId)||x?.runAttempt!==ctx.runAttempt||
    x?.workflowHeadSha!==ctx.workflowHeadSha)
   throw Error('FORK_'+name.toUpperCase()+'_RUN_BINDING_MISMATCH');
 }
}
async function rpc(url,method,params=[]){
 const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
  signal:AbortSignal.timeout(method==='anvil_dumpState'?120000:25000)});
 if(!res.ok)throw Error('FORK_LOCAL_RPC_HTTP_'+res.status);
 const body=await res.json();
 if(body.error)throw Error('FORK_LOCAL_RPC_'+method+'_NATIVE_ERROR');
 return body.result;
}
async function main(){
 const args=argsOf(process.argv.slice(2));
 const ctx=(await json(args['run-identity'])).value;
 const plan=(await json(args.plan)).value;
 const authority=(await json(args.authority)).value;
 const original=(await json(args['source-manifest'])).value;
 const warnings=[],out=args['output-root'];
 const required=(field,test,expected,correction)=>{
  const observed=plan[field];
  if(!test(observed))warnings.push(problem('G2B.REQUIRED_ORIGINAL_FACT_MISSING',
   'FORK_EXECUTION_PLAN_v1.json.'+field,expected,observed,correction));
 };
 try{sameRun(ctx,authority,plan);}
 catch(e){warnings.push(problem('G2B.SAME_RUN_IDENTITY', 'runIdentity',
  'same immutable repository/run/attempt/GITHUB_SHA',e.message,
  'Recover the exact currently admitted source and run-specific authority'));}
 const source=original.source??{},sourceSha=source.expectedSha256;
 if(original.sourceAdmissionVerified!==true||!SHA.test(sourceSha??'')||
   source.observedSha256!==sourceSha||
   plan.originalSourceArchiveSha256!==sourceSha||plan.sourceBound!==true)
  warnings.push(problem('G2B.ORIGINAL_SOURCE_ADMISSION',
   'PREFLIGHT_MANIFEST_v1.json.sourceArchiveSha256',
   'identical independently admitted original ZIP SHA-256',sourceSha,
   'Restore exact source ZIP and same-run source-identity evidence'));
 if(authority.schemaVersion!=='curveyield-security-pipeline-extended-disposition-v1'||
    authority.approved!==true||!SHA.test(authority.authorizationRefSha256??'')||
    authority.sourceArchiveSha256!==sourceSha||
    !Array.isArray(authority.authorizedCapabilities)||
    !authority.authorizedCapabilities.includes('fork_setup'))
  warnings.push(problem('G2B.INDEPENDENT_FORK_AUTHORITY',
   'EXTENDED_MODE_DISPOSITION_v1.json.authorizedCapabilities',
   'independently accepted exact run/source-bound fork_setup capability',
   {approved:authority.approved,capabilities:authority.authorizedCapabilities},
   'Use a truly accepted authority issuer and source scope, not a request-provided hash'));
 required('approvedForkChainId',x=>Number.isInteger(x)&&[1,747474].includes(x),
  'approved 1/747474 original chain identity','Obtain the exact approved chain scope');
 required('approvedUpstreamBlockNumber',x=>Number.isSafeInteger(x)&&x>0,
  'original independently approved positive upstream block number','Approve a frozen upstream block');
 required('approvedUpstreamBlockHash',x=>BLOCK.test(x??''),
  'original frozen 32-byte upstream block hash','Approve and independently read upstream block hash');
 required('approvedExecutionScopeSha256',x=>SHA.test(x??''),
  'separate independently signed executable scope digest','Bind approved source-defined scripts and budget');
 required('sourceDeploymentScriptSha256',x=>SHA.test(x??''),
  'original authorized script byte SHA-256','Verify actual source ZIP script against independent approval');
 required('sourceConfigurationScriptSha256',x=>SHA.test(x??''),
  'original authorized configuration script SHA-256','Bind original source-defined config commands');
 required('sourceFundingScriptSha256',x=>SHA.test(x??''),
  'original authorized funding script SHA-256','Bind source-defined funding phase and actor balances');
 required('approvedForkHardfork',x=>typeof x==='string'&&/^(london|paris|shanghai|cancun|prague)$/.test(x),
  'source-approved Anvil hardfork','Select only an independently approved hardfork');
 if(args.operation==='execute'){
  for(const x of ['source-zip','toolkit-profile','toolkit-root','build-evidence','private-root'])
   if(!args[x])warnings.push(problem('G2B.RESTRICTED_INPUT_NOT_AVAILABLE','--'+x,
    'original SHA-bound approved '+x, 'argument not provided',
    'Restore original restricted same-run source/software/receipt transport'));
 }
 const facts={schemaVersion:'curveyield-security-pipeline-fork-native-v1',
  pipelineVersion:'v1',stage:'G2B',runId:String(ctx.runId),
  runAttempt:ctx.runAttempt,headSha:ctx.workflowHeadSha,
  sourceArchiveSha256:SHA.test(sourceSha??'')?sourceSha:null,
  originalSourceManifestSha256:sha(Buffer.from(JSON.stringify(original))),
  independentAuthorityAccepted:authority.approved===true&&warnings.length===0,
  claimedControllerAcceptance:false,executionMode:args.operation,
  nativeAttempted:false,status:'NOT_EXECUTED',
  c0:null,c1:null,c2:null,originalNativeReceiptCount:0,originalNativeReceiptSha256:null,
  forkStateManifestSha256:null,warnings,restrictedEvidence:null};
 if(args.operation==='execute'&&warnings.length===0){
  let anvil=null;
  try{
   // Original admitted source ZIP is checked BEFORE any extracted source,
   // deployment profile or package scripts are used.
   const zipPath=path.resolve(args['source-zip']);
   const stat=await fs.lstat(zipPath);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024*1024)
    throw Error('ORIGINAL_SOURCE_ZIP_NOT_SAFE_REGULAR_FILE');
   const zipHash=sha(await fs.readFile(zipPath));
   if(zipHash!==sourceSha)throw Error('ORIGINAL_SOURCE_ZIP_SHA256_MISMATCH');
   const executable=await json(args['toolkit-profile']);
   if(executable.value?.schemaVersion!=='curveyield-toolkit-profile-v1'||
      executable.value.sourceBound!==true||
      executable.value.sourceArchiveSha256!==sourceSha)
     throw Error('EXECUTION_TOOLKIT_PROFILE_SOURCE_IDENTITY_MISMATCH');
   for(const component of ['foundry-node','source-compilers']){
    const row=executable.value.components?.find(x=>x.componentId===component);
    if(row?.required!==true||!SHA.test(row.expectedBinarySha256??''))
     throw Error('EXECUTION_REQUIRED_COMPONENT_BINARY_NOT_PINNED:'+component);
    const receiptFile=path.join(args['toolkit-root'],component,'TOOLKIT_CACHE_COMPONENT_VERIFICATION_v1.json');
    const receipt=(await json(receiptFile)).value;
    if(receipt.componentId!==component||receipt.usableForExecution!==true||
      receipt.observedBinarySha256!==row.expectedBinarySha256||
      String(receipt.runId)!==String(ctx.runId)||receipt.runAttempt!==ctx.runAttempt)
     throw Error('EXECUTION_COMPONENT_NOT_INDEPENDENTLY_VERIFIED:'+component);
   }
   const build=await json(args['build-evidence']);
   if(build.value?.schemaVersion!=='curveyield-lite-phase0-project-readiness-v1' &&
      build.value?.schemaVersion!=='curveyield-lite-phase0-build-identity-v1')
    throw Error('ORIGINAL_SOURCE_BUILD_IDENTITY_NOT_ADMITTED');
   const projectPath=plan.approvedProjectRelativePath;
   if(typeof projectPath!=='string'||!projectPath||projectPath.includes('..')||projectPath.startsWith('/'))
    throw Error('APPROVED_ORIGINAL_PROJECT_RELATIVE_PATH_MISSING');
   const {stageExactArchiveSource}=await import('../packages/github-native-sim/src/execution.mjs');
   const staged=await stageExactArchiveSource({checkoutRoot:path.dirname(zipPath),
    archivePath:path.basename(zipPath),archiveSha256:sourceSha,
    workspaceRoot:path.join(args['private-root'],'staging'),projectPath});
   const {loadDeploymentProfile,phase0ForkChainForProfile}=await import(
     '../packages/github-native-sim/src/phase0-deployment-profile-v1.mjs');
   const profile=await loadDeploymentProfile(staged.projectRoot);
   if(!profile||profile.mode==='LIVE'||profile.chainId!==plan.approvedForkChainId)
    throw Error('NATIVE_DEPLOYMENT_PROFILE_MISSING_OR_CHAIN_MISMATCH');
   if(profile.mode!=='FOUNDRY')
    throw Error('NATIVE_PROFILE_NOT_APPROVED_FOUNDRY_SOURCE_SCRIPT');
   if(profile.scripts.length<1)throw Error('NO_DECLARED_DEPLOYMENT_SCRIPTS');
   const exactSourceShaSet=profile.scripts.map(x=>x.sha256);
   const authorizedSet=new Set([plan.sourceDeploymentScriptSha256,
     plan.sourceConfigurationScriptSha256,plan.sourceFundingScriptSha256]);
   if(exactSourceShaSet.some(x=>!authorizedSet.has(x))||
     [...authorizedSet].some(x=>!exactSourceShaSet.includes(x)))
    throw Error('SOURCE_DEPLOY_CONFIG_FUNDING_SCRIPT_SET_NOT_APPROVED');
   const approvalReceiptHash=sha(Buffer.from(JSON.stringify({
    sourceSha,chainId:plan.approvedForkChainId,
    upstreamBlock:plan.approvedUpstreamBlockNumber,
    upstreamHash:plan.approvedUpstreamBlockHash,
    allowedScripts:exactSourceShaSet})));
   if(approvalReceiptHash!==plan.approvedExecutionScopeSha256)
    throw Error('APPROVED_SOURCE_SCRIPT_SCOPE_DIGEST_MISMATCH');
   const upstreamEnv=profile.chainId===1?'MI_FORK_ETHEREUM_RPC_URL':'KATANA_FORK_RPC_URL';
   const forkUrl=process.env[upstreamEnv];
   if(typeof forkUrl!=='string'||!forkUrl.startsWith('https://'))
    throw Error('TRUSTED_UPSTREAM_RPC_SECRET_NOT_PRESENT:'+upstreamEnv);
   // Ensure original private upstream credentials never reach a source script
   // or the Anvil spawn environment. The trusted identity proxy owns URL in memory.
   for(const key of Object.keys(process.env))
    if(/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|MNEMONIC|RPC_URL|GITHUB_TOKEN|GH_TOKEN/i.test(key))
     delete process.env[key];
   const {startAnvil,executeDeploymentProfileV1}=await import(
     '../packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs');
   const chain=phase0ForkChainForProfile(profile);
   anvil=await startAnvil({forkUrl,projectRoot:staged.projectRoot,
     chainId:chain.chainId,evmVersion:plan.approvedForkHardfork,
     requireUpstreamChainId:true,forkBlockNumber:plan.approvedUpstreamBlockNumber});
   if(anvil.pinnedBlockHash.toLowerCase()!==plan.approvedUpstreamBlockHash.toLowerCase())
    throw Error('FORK_APPROVED_UPSTREAM_BLOCK_HASH_MISMATCH');
   const result=await executeDeploymentProfileV1({
    projectRoot:staged.projectRoot,anvilUrl:anvil.url,profile,chain});
   const last=Number(BigInt(await rpc(anvil.url,'eth_blockNumber')));
   facts.nativeAttempted=true;
   facts.originalNativeReceiptCount=(result.attempts??[]).length;
   const raw=Buffer.from(JSON.stringify(result));
   const privateDir=path.join(args['private-root'],'evidence');
   await fs.mkdir(privateDir,{recursive:true,mode:0o700});
   const evidenceFile=await emit(privateDir,'FORK_SETUP_TRANSACTIONS_v1.json',result);
   facts.originalNativeReceiptSha256=evidenceFile.sha256;
   facts.c0={chainId:chain.chainId,blockNumber:anvil.pinnedBlockNumber,
     blockHash:anvil.pinnedBlockHash};
   facts.c1={chainId:chain.chainId,blockNumber:last,
     status:result.status,originalReceiptSha256:evidenceFile.sha256};
   const fundingExecuted=(result.attempts??[]).some(x=>
     x.scriptSha256===plan.sourceFundingScriptSha256&&x.status==='PASS');
   if(result.status!=='PASS'||!fundingExecuted)
    throw Error('VERIFIED_DEPLOYMENT_AND_FUNDING_REQUIRED_BEFORE_C2');
   const block=await rpc(anvil.url,'eth_getBlockByNumber',
     ['0x'+last.toString(16),false]);
   if(!BLOCK.test(block?.hash??''))
    throw Error('LOCAL_C2_BLOCK_HASH_NOT_OBSERVED');
   facts.c2={chainId:chain.chainId,blockNumber:last,
     blockHash:block.hash,sourceFundingScriptSha256:plan.sourceFundingScriptSha256};
   const {capturePhase0ForkStateV1,verifyPhase0ForkStateV1}=await import(
     '../packages/github-native-sim/src/phase0-fork-state-reuse-v1.mjs');
   const stateRoot=path.join(args['private-root'],'fork-state');
   const state=await capturePhase0ForkStateV1({rpc:(method,p)=>rpc(anvil.url,method,p),
    outputDir:stateRoot,campaignId:'standalone-v1-'+ctx.runId+'-'+ctx.runAttempt,
    sourceSha256:sourceSha,chainId:chain.chainId,
    hardfork:plan.approvedForkHardfork,finalBlock:last});
   if(state.status!=='CAPTURED')throw Error('FORK_C2_STATE_NOT_CAPTURED:'+state.status);
   await verifyPhase0ForkStateV1({root:stateRoot,manifest:state});
   facts.forkStateManifestSha256=sha(await fs.readFile(
     path.join(stateRoot,'PHASE0_FORK_STATE_MANIFEST_v1.json')));
   facts.restrictedEvidence={scope:'CURRENT_JOB_ONLY_NO_PUBLIC_C2_TRANSPORT',
    nativeTransactionsSha256:evidenceFile.sha256,
    c2ManifestSha256:facts.forkStateManifestSha256};
   facts.status='PARTIAL';
   warnings.push(problem('G2B.C2_CROSS_JOB_HANDOFF_UNAVAILABLE',
    'FORK_C2_RESTRICTED_TRANSPORT_v1', 'independently qualified private state transport',
    'no accepted destination/consumer transport', 'Use an authorized restricted checkpoint carrier; do not upload C2 to public artifacts'));
  }catch(e){
   warnings.push(problem('G2B.NATIVE_FORK_EXECUTION_UNAVAILABLE',
     'fork_setup.nativeExecution', 'actual authorized source-defined local fork deployment',
     e.message,'Inspect actual restricted source/script/chain/funding/Anvil native evidence'));
   facts.status='PARTIAL';
  }finally{
   if(anvil)await anvil.close().catch(()=>{});
  }
 }
 facts.warnings=warnings;
 facts.independentAuthorityAccepted=authority.approved===true&&warnings.every(w=>
   w.code!=='G2B.INDEPENDENT_FORK_AUTHORITY');
 await emit(out,'FORK_NATIVE_STATE_v1.json',facts);
 await emit(out,'FORK_NATIVE_WARNINGS_v1.json',{schemaVersion:'curveyield-fork-warning-part-v1',
  runId:String(ctx.runId),runAttempt:ctx.runAttempt,
  workflowHeadSha:ctx.workflowHeadSha,warnings});
 for(const item of warnings){
  const title=item.code.replace(/[^\w.-]/g,'_');
  const msg=String(item.configurationField+' expected '+scrub(item.expected)+
    ' observed '+scrub(item.observed)+' correction '+scrub(item.correction))
    .replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A');
  console.log('::warning title='+title+'::'+msg);
 }
 console.log(JSON.stringify({stage:'G2B',status:facts.status,
   nativeAttempted:facts.nativeAttempted,warningCount:warnings.length,
   sourceArchiveSha256:facts.sourceArchiveSha256}));
}
main().catch(e=>{
 console.error('FORK_ADAPTER_UNAVAILABLE:'+e.constructor.name+':'+scrub(e.message));
 process.exitCode=2;
});
