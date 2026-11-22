#!/usr/bin/env node
// CurveYield Automated Security Pipeline v1: deterministic, inert configuration.
// This script never imports an admitted source package as executable code.
import fs from 'node:fs';
import path from 'node:path';
import {canonicalJsonV1,sha256HexV1,digestCanonicalV1} from '../packages/github-native-sim/src/canonical-json-v1.mjs';

const OPERATIONS=new Set(['enumerate-targets','toolkit-profile','mimo-objective',
  'validate-proposal','fork-plan','storage-plan','medusa-config']);
const COMPONENTS=['foundry-node','source-compilers','slither-storage','medusa',
  'wake','mythril','certora-prover','autoprover','mimo-runtime','mimo-weights'];
const ENGINES=['slither-storage','wake','mythril','medusa','certora-prover','autoprover'];
const HEX=/^[0-9a-f]{64}$/;
const MAX_JSON=64*1024*1024;

function argsOf(argv){
  const supported=new Set(['operation','input-root','output-root','run-identity',
    'profile','target-id','proposal','native-config']);
  const args={};
  for(let i=0;i<argv.length;i++){
    const key=argv[i]?.startsWith('--')?argv[i].slice(2):'';
    if(!supported.has(key)||Object.hasOwn(args,key)||!argv[i+1]||argv[i+1].startsWith('--'))
      throw Error('CONFIG_OPTION_INVALID:'+argv[i]);
    args[key]=argv[++i];
  }
  for(const key of ['operation','input-root','output-root','run-identity'])
    if(!args[key])throw Error('CONFIG_REQUIRED_ARGUMENT_MISSING:'+key);
  if(!OPERATIONS.has(args.operation))throw Error('CONFIG_OPERATION_UNKNOWN:'+args.operation);
  return args;
}
function readBytes(file,root=null){
  const resolved=path.resolve(file);
  if(root){
    const base=path.resolve(root);
    if(resolved!==base&&!resolved.startsWith(base+path.sep))
      throw Error('CONFIG_INPUT_OUTSIDE_ROOT:'+file);
  }
  if(fs.lstatSync(resolved).isSymbolicLink())throw Error('CONFIG_INPUT_SYMLINK:'+file);
  const st=fs.statSync(resolved);
  if(!st.isFile()||st.size>MAX_JSON)throw Error('CONFIG_INPUT_TYPE_OR_SIZE:'+file);
  return fs.readFileSync(resolved);
}
function readJson(file,root=null){
  const bytes=readBytes(file,root);
  return {value:JSON.parse(bytes.toString('utf8')),sha256:sha256HexV1(bytes),bytes:bytes.length};
}
function issue(code,fieldPath,expected,observed,correction){
  return {code,fieldPath,expected:expected??null,observed:observed??null,
    impact:'Affected configuration cannot be treated as verified native execution input',
    correction,operationDisposition:'NOT_EXECUTED'};
}
function output(dir,filename,value){
  fs.mkdirSync(dir,{recursive:true});
  const p=path.join(dir,filename),temp=p+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  fs.renameSync(temp,p);
  return {name:filename,sha256:sha256HexV1(fs.readFileSync(p))};
}
function runIdentity(file,issues){
  try{
    const {value:x,sha256}=readJson(file);
    if(!x||typeof x!=='object'||Array.isArray(x))throw Error('NOT_OBJECT');
    if(!/^\d+$/.test(String(x.runId??''))||!/^\d+$/.test(String(x.runAttempt??'')))
      throw Error('RUN_ID_OR_ATTEMPT_MISSING');
    if(process.env.GITHUB_RUN_ID&&String(x.runId)!==process.env.GITHUB_RUN_ID)
      throw Error('RUN_ID_MISMATCH');
    if(process.env.GITHUB_RUN_ATTEMPT&&String(x.runAttempt)!==process.env.GITHUB_RUN_ATTEMPT)
      throw Error('RUN_ATTEMPT_MISMATCH');
    if(process.env.GITHUB_SHA&&x.workflowHeadSha!==process.env.GITHUB_SHA)
      throw Error('GITHUB_SHA_MISMATCH');
    return {...x,runIdentityDigestSha256:sha256,verifiedForCurrentJob:true};
  }catch(e){
    issues.push(issue('CONFIG.RUN_IDENTITY_INVALID','--run-identity',
      'trusted same-run runId/runAttempt/workflowHeadSha',String(e),
      'Provide original trusted same-run identity from GitHub Actions context'));
    return {verifiedForCurrentJob:false};
  }
}
function evidence(root,manifest,name,issues){
  const record=manifest?.files?.find(x=>x.name===name)??null;
  if(!record)return null;
  try{
    const entry=readJson(path.join(root,name),root);
    if(!HEX.test(record.sha256??'')||record.sha256!==entry.sha256||
       record.bytes!==entry.bytes)throw Error('INDEXED_SHA_OR_LENGTH_MISMATCH');
    return {...entry,name};
  }catch(e){
    issues.push(issue('CONFIG.EVIDENCE_BYTES_MISMATCH','PREFLIGHT_MANIFEST_v1.json.files['+name+']',
      record,String(e),'Restore the exact indexed same-run preflight evidence file'));
    return null;
  }
}
function bound(doc,name,archiveSha,issues){
  if(!doc)return false;
  const data=doc.value;
  const actual=data?.sourceIdentity?.archiveSha256??data?.source?.archiveSha256??
    data?.source?.archiveSha256Observed??null;
  if(actual!==archiveSha){
    issues.push(issue('CONFIG.EVIDENCE_SOURCE_BINDING_UNKNOWN',
      name+'.source.archiveSha256',archiveSha,actual,
      'Use the original SHA-bound producer; never infer source identity from filename'));
    return false;
  }
  return true;
}
function classified(language,artifact,engine){
  if(!artifact)return {status:'UNCOMPILED',reason:'NO_COMPILER_ARTIFACT',eligible:false};
  if(engine==='wake'&&language!=='SOLIDITY')return {status:'UNSUPPORTED',reason:'WAKE_SOLIDITY_ONLY',eligible:false};
  if(engine==='mythril'&&!HEX.test(String(artifact.creationBytecodeDigestSha256??'')))
    return {status:'NOT_EXECUTED',reason:'EXACT_CREATION_BYTECODE_UNAVAILABLE',eligible:false};
  if(engine==='slither-storage'&&artifact.storageLayoutAvailable!=='YES')
    return {status:'NOT_EXECUTED',reason:'EXACT_COMPILER_STORAGE_LAYOUT_UNAVAILABLE',eligible:false};
  if(engine==='medusa')return {status:'NOT_EXECUTED',reason:'VERIFIED_FORK_C2_AND_EXISTING_PROPERTIES_REQUIRED',eligible:false};
  if(engine==='certora-prover')return {status:'NOT_EXECUTED',reason:'APPROVED_CVL_AND_LOCAL_PROVER_REQUIRED',eligible:false};
  if(engine==='autoprover')return {status:'NOT_EXECUTED',reason:'APPROVED_COMPOSER_AND_LOCAL_PROVER_REQUIRED',eligible:false};
  return {status:'POTENTIALLY_ELIGIBLE',reason:'VERIFIED_NATIVE_PIN_AND_AUTHORITY_STILL_REQUIRED',eligible:true};
}
function enumerate(args,identity,globalIssues){
  const root=args['input-root'],issues=[...globalIssues];
  let manDoc=null;
  try{manDoc=readJson(path.join(root,'PREFLIGHT_MANIFEST_v1.json'),root);}
  catch(e){issues.push(issue('CONFIG.PREFLIGHT_MANIFEST_MISSING','PREFLIGHT_MANIFEST_v1.json',
    'original source-indexed collector manifest',String(e),
    'Download the same-run security-preflight-evidence artifact'));}
  const manifest=manDoc?.value??{};
  const archiveSha=manifest?.source?.expectedSha256??null;
  const sourceBound=HEX.test(String(archiveSha))&&
    manifest?.source?.observedSha256===archiveSha&&
    manifest?.sourceAdmissionVerified===true&&identity.verifiedForCurrentJob;
  if(!sourceBound)issues.push(issue('CONFIG.SOURCE_ADMISSION_NOT_VERIFIED',
    'PREFLIGHT_MANIFEST_v1.json.source',
    'sourceAdmissionVerified true with matching archive SHA and same-run identity',
    {source:manifest.source??null,admitted:manifest.sourceAdmissionVerified??null,
      runIdentityValid:identity.verifiedForCurrentJob},
    'Recover original admitted same-run manifest and run context'));
  const names=['BUILD_AND_SOURCE_IDENTITY_v1.json','PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json',
    'CONTRACT_IDENTITY_INDEX_v1.json','SOURCE_INTELLIGENCE_AUTOMATED_v1.json',
    'REVIEW_INVENTORY_v1.json','SLITHER_v1.json'];
  const docs=Object.fromEntries(names.map(name=>[name,evidence(root,manifest,name,issues)]));
  const siDoc=docs['SOURCE_INTELLIGENCE_AUTOMATED_v1.json'];
  const invDoc=docs['REVIEW_INVENTORY_v1.json'];
  const buildDoc=docs['BUILD_AND_SOURCE_IDENTITY_v1.json'];
  const artifactDoc=docs['PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json'];
  const si=bound(siDoc,'SOURCE_INTELLIGENCE_AUTOMATED_v1.json',archiveSha,issues)?siDoc.value:null;
  const bundle=bound(artifactDoc,'PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json',archiveSha,issues)?artifactDoc.value:null;
  // The indexed inventory is contextual source metadata, never independent authority.
  const inv=invDoc?.value??{};
  const sources=new Map();
  for(const item of [...(Array.isArray(inv.payload?.sourceUnits)?inv.payload.sourceUnits:[]),
                     ...(Array.isArray(si?.sourceFiles)?si.sourceFiles:[])]){
    const sourcePath=item.sourcePath??item.path;
    if(typeof sourcePath!=='string'||!sourcePath||sourcePath.includes('..')||sourcePath.startsWith('/'))continue;
    const unit=item.compilationUnitId??null;
    const id=(unit??'UNIT_UNRESOLVED')+':'+sourcePath;
    const previous=sources.get(id);
    sources.set(id,{compilationUnitId:unit,sourcePath,
      language:item.language??previous?.language??(sourcePath.endsWith('.vy')?'VYPER':'SOLIDITY'),
      sourceDigestSha256:item.sha256??previous?.sourceDigestSha256??null,
      scopeTier:item.scopeTier??item.scopeStatus??previous?.scopeTier??null,
      astStatus:item.astStatus??previous?.astStatus??null});
  }
  const candidates=bundle?.artifacts??si?.compilerArtifacts??[];
  const targets=[],ownedPaths=new Set();
  for(const a of candidates){
    const sourcePath=a.sourcePath??a.sourceName,qn=a.qualifiedName??null;
    const unit=a.compilationUnitId??null;
    const abiSha=a.abiDigestSha256??null;
    if(!sourcePath||!qn||!unit||!HEX.test(String(abiSha))){
      issues.push(issue('CONFIG.ABI_IDENTITY_INCOMPLETE','compilerArtifacts[].identity',
        'sourcePath, qualifiedName, unitId and exact ABI SHA',
        {sourcePath,qualifiedName:qn,unit,abiSha},
        'Rebuild exact source-bound compiler artifact exporter'));
      continue;
    }
    const language=a.language??(sourcePath.endsWith('.vy')?'VYPER':'SOLIDITY');
    const artifact={creationBytecodeDigestSha256:a.creationBytecodeDigestSha256??null,
      deployedBytecodeDigestSha256:a.deployedBytecodeDigestSha256??null,
      storageLayoutAvailable:a.storageLayoutAvailable??'UNKNOWN'};
    const targetId='TARGET-'+digestCanonicalV1([archiveSha,unit,qn,abiSha]).slice(0,32);
    const target={targetId,compilationUnitId:unit,sourcePath,qualifiedName:qn,
      language,abiDigestSha256:abiSha,...artifact,
      artifactRef:bundle?'PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json':'SOURCE_INTELLIGENCE_AUTOMATED_v1.json',
      sourceBound,compilationStatus:'EXACT_COMPILER_ARTIFACT',
      programEligibility:Object.fromEntries(ENGINES.map(engine=>[engine,classified(language,artifact,engine)]))};
    targets.push(target);
    ownedPaths.add(sourcePath);
  }
  for(const x of sources.values()){
    if(ownedPaths.has(x.sourcePath))continue;
    const targetId='SOURCE-'+digestCanonicalV1([archiveSha,x.compilationUnitId,x.sourcePath]).slice(0,32);
    targets.push({...x,targetId,qualifiedName:null,sourceBound:false,
      compilationStatus:'SOURCE_ONLY_UNCOMPILED',
      programEligibility:Object.fromEntries(ENGINES.map(engine=>[engine,classified(x.language,null,engine)]))});
  }
  for(const rootPath of manifest.additionalProjectRootsNotCompiled??[])
    issues.push(issue('CONFIG.UNCOMPILED_PROJECT_ROOT',
      'PREFLIGHT_MANIFEST_v1.json.additionalProjectRootsNotCompiled', 'compiled root',rootPath,
      'Collect compiler artifacts for this explicitly named root before native analysis'));
  targets.sort((a,b)=>a.targetId.localeCompare(b.targetId));
  const possible=Object.fromEntries(ENGINES.map(engine=>[engine,targets.filter(t=>t.programEligibility[engine].eligible).length]));
  const census={discoveredSourceFiles:sources.size,compiledTargets:targets.filter(t=>t.compilationStatus==='EXACT_COMPILER_ARTIFACT').length,
    sourceOnlyTargets:targets.filter(t=>t.compilationStatus==='SOURCE_ONLY_UNCOMPILED').length,
    analyzerPotentialEligibility:possible,attempted:0,nativeCompleted:0};
  const basic={schemaVersion:'curveyield-security-pipeline-config-v1',runIdentity:identity,
    sourceArchiveSha256:archiveSha,sourceBound,provenance:manDoc?{
      manifestSha256:manDoc.sha256,
      indexedInputs:Object.fromEntries(Object.entries(docs).filter(([,d])=>d).map(([n,d])=>[n,d.sha256]))}:null,
    status:!sourceBound?'UNVERIFIED':!targets.length?'PARTIAL':issues.length?'PARTIAL':'SOURCE_BOUND',
    issues};
  const files=[
    output(args['output-root'],'SECURITY_TARGET_PLAN_v1.json',{...basic,census,targets}),
    output(args['output-root'],'SECURITY_BUILD_BINDING_v1.json',{...basic,
      buildEvidenceSha256:buildDoc?.sha256??null,
      originalBuildStatus:buildDoc?.value?.build?.status??null,
      buildIdentity:bundle?.buildIdentity??null,
      compilerArtifactCount:census.compiledTargets,
      buildSourceBound:bundle!==null&&sourceBound}),
    output(args['output-root'],'SECURITY_PROGRAM_COMPATIBILITY_v1.json',{...basic,census,engines:ENGINES,
      byTarget:targets.map(t=>({targetId:t.targetId,sourcePath:t.sourcePath,
        compilationUnitId:t.compilationUnitId,programEligibility:t.programEligibility}))})
  ];
  return {mode:'enumerate-targets',status:basic.status,files,issues,sourceBound};
}
function additional(args,identity,issues){
  const folder=args['output-root'], op=args.operation;
  let selected=null;
  if(op==='toolkit-profile'){
    const pins=args.profile?readJson(args.profile).value:null;
    const components=COMPONENTS.map(id=>{
      const observed=pins?.components?.[id]??null;
      const digest=observed?.expectedBinarySha256??null;
      const approved=observed?.approvedByTrustedSource===true&&HEX.test(String(digest));
      if(!approved)issues.push(issue('TOOLKIT.UNRESOLVED_PIN','toolkitComponents['+id+'].expectedBinarySha256',
        'independently qualified immutable tool pin',observed,
        'Qualify and record the component pin and binary SHA in trusted current-revision recipe'));
      return {componentId:id,required:null,notRequiredReason:'TARGET_PLAN_NOT_QUALIFIED',
        approvedVersion:approved?(observed.approvedVersion??null):null,
        approvedSourceRevision:approved?(observed.approvedSourceRevision??null):null,
        expectedBinarySha256:approved?digest:null,os:process.platform,arch:process.arch,
        abiProfile:observed?.abiProfile??null,lockDigest:observed?.lockDigest??null,
        recipeDigest:observed?.recipeDigest??null,expectedBytesOrQuota:observed?.expectedBytesOrQuota??null,
        nativeConsumerStages:observed?.nativeConsumerStages??[],
        nativeReadinessMode:approved?'PIN_DEFINED_NOT_INSTALLED':'UNRESOLVED_PIN'};
    });
    selected=['TOOLKIT_PROFILE_v1.json',{schemaVersion:'curveyield-toolkit-profile-v1',
      sourceBound:false,runIdentity:identity,status:'NOT_EXECUTED',components,issues}];
  }else if(op==='validate-proposal'){
    let proposal;
    try{proposal=readJson(args.proposal).value;}catch(e){issues.push(issue('MIMO.PROPOSAL_UNAVAILABLE','--proposal',
      'well-formed source-bound MIMO_PROPOSAL_v1',String(e),'Provide original typed model proposal artifact'));}
    const allowed=new Set(['schemaVersion','targetId','sourceArchiveSha256',
      'proposedChanges','evidenceRefs','objectiveDigestSha256']);
    for(const field of Object.keys(proposal??{})){
      if(!allowed.has(field))issues.push(issue('MIMO.PROPOSAL_UNKNOWN_FIELD','MIMO_PROPOSAL_v1.'+field,
        'one of '+[...allowed].join(','),field,'Remove unsupported model-directed field'));
    }
    if(proposal?.schemaVersion!=='curveyield-mimo-proposal-v1'||!Array.isArray(proposal?.proposedChanges))
      issues.push(issue('MIMO.PROPOSAL_SCHEMA','MIMO_PROPOSAL_v1',
        'typed schemaVersion and proposedChanges array',proposal??null,
        'Produce a valid data-only proposal from original source-bound objective'));
    selected=['MIMO_PROPOSAL_DISPOSITION_v1.json',{schemaVersion:'curveyield-mimo-proposal-disposition-v1',
      status:'NOT_EXECUTED',safeForNativeExecution:false,runIdentity:identity,
      proposalDigestSha256:args.proposal? (()=>{try{return readJson(args.proposal).sha256;}catch{return null;}})():null,
      issues}];
  }else{
    const key={
      'mimo-objective':'MIMO_STAGE_OBJECTIVE_v1.json',
      'fork-plan':'FORK_EXECUTION_PLAN_v1.json',
      'storage-plan':'FORK_STORAGE_QUERY_PLAN_v1.json',
      'medusa-config':'MEDUSA_ELIGIBILITY_v1.json'
    }[op];
    const requirement={
      'mimo-objective':'original verified ABI, approved objective and native feedback',
      'fork-plan':'approved source script SHA, verified chain/block identity and restricted execution authority',
      'storage-plan':'original same-run C2 fork checkpoint and exact compiler storage layout',
      'medusa-config':'native medusa init schema, verified C2 checkpoint and existing user-authored property signatures'
    }[op];
    issues.push(issue('CONFIG.NATIVE_PREREQUISITES_NOT_PROVEN',op+'.nativePrerequisites',
      requirement,'no verified native prerequisite supplied by this mode',
      'Provide exact independently verified same-run artifact and trusted tool pin'));
    selected=[key,{schemaVersion:'curveyield-security-pipeline-config-v1',operation:op,
      sourceBound:false,status:'NOT_EXECUTED',runIdentity:identity,issues,
      nativeExecutableCreated:false}];
  }
  return {mode:op,status:'NOT_EXECUTED',files:[output(folder,selected[0],selected[1])],issues,sourceBound:false};
}
function main(){
  const args=argsOf(process.argv.slice(2)),issues=[];
  const identity=runIdentity(args['run-identity'],issues);
  const result=args.operation==='enumerate-targets'?
    enumerate(args,identity,issues):additional(args,identity,issues);
  output(args['output-root'],'SECURITY_PIPELINE_CONFIG_RESULT_v1.json',{
    schemaVersion:'curveyield-security-pipeline-config-result-v1',...result,
    runId:identity.runId??null,runAttempt:identity.runAttempt??null});
  console.log(JSON.stringify({mode:result.mode,status:result.status,
    warningCount:result.issues.length,fileNames:result.files.map(f=>f.name)}));
}
try{main();}
catch(error){
  console.error('CONFIGURATION_WRITER_UNAVAILABLE:'+error.constructor.name+':'+error.message);
  process.exitCode=2;
}
