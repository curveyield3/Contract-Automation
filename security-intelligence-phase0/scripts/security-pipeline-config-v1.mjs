#!/usr/bin/env node
// CurveYield Automated Security Pipeline v1: deterministic, inert configuration.
// This script never imports an admitted source package as executable code.
import fs from 'node:fs';
import path from 'node:path';
import {canonicalJsonV1,sha256HexV1,digestCanonicalV1} from '../packages/github-native-sim/src/canonical-json-v1.mjs';

const OPERATIONS=new Set(['enumerate-targets','toolkit-profile','mimo-objective',
  'validate-proposal','fork-plan','storage-plan','medusa-config',
  'native-analyzer-eligibility']);
const COMPONENTS=['foundry-node','source-compilers','slither-storage','medusa',
  'wake','mythril','certora-prover','autoprover','mimo-runtime','mimo-weights'];
const ENGINES=['slither-storage','wake','mythril','medusa','certora-prover','autoprover'];
const HEX=/^[0-9a-f]{64}$/;
const MAX_JSON=64*1024*1024;

function argsOf(argv){
  const supported=new Set(['operation','input-root','output-root','run-identity',
    'profile','target-id','proposal','native-config','component','c2-state']);
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
  const record=(Array.isArray(manifest?.files)?manifest.files:[]).find(x=>x.name===name)??null;
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
function modelObjectiveV1(args,identity,issues){
  const input=args['input-root'];
  let archiveSha=null,sourceDoc=null,sourceIntelligence=null;
  try{
    const manifest=readJson(path.join(input,'PREFLIGHT_MANIFEST_v1.json'),input).value;
    archiveSha=manifest?.source?.expectedSha256??null;
    if(!HEX.test(String(archiveSha))||manifest.source?.observedSha256!==archiveSha||
       manifest.sourceAdmissionVerified!==true||!identity.verifiedForCurrentJob)
      throw Error('ADMITTED_SOURCE_OR_RUN_IDENTITY_UNVERIFIED');
    sourceDoc=evidence(input,manifest,'SOURCE_INTELLIGENCE_AUTOMATED_v1.json',issues);
    if(!sourceDoc||!bound(sourceDoc,'SOURCE_INTELLIGENCE_AUTOMATED_v1.json',archiveSha,issues))
      throw Error('SOURCE_INTELLIGENCE_NOT_BOUND_TO_ADMITTED_ARCHIVE');
    sourceIntelligence=sourceDoc.value;
  }catch(error){
    issues.push(issue('MIMO.ORIGINAL_SOURCE_UNAVAILABLE',
      'SOURCE_INTELLIGENCE_AUTOMATED_v1.json.sourceIdentity',
      'indexed SHA-verified same-run source intelligence',String(error),
      'Recover the original admitted preflight evidence artifact'));
  }
  const targetId=args['target-id']??null;
  const sourceArtifacts=Array.isArray(sourceIntelligence?.compilerArtifacts)?
    sourceIntelligence.compilerArtifacts:[];
  const candidates=sourceArtifacts.map(item=>{
    const unit=item.compilationUnitId,qualified=item.qualifiedName,abi=item.abiDigestSha256;
    if(!unit||!qualified||!HEX.test(String(abi)))return null;
    return {...item,targetId:'TARGET-'+digestCanonicalV1([archiveSha,unit,qualified,abi]).slice(0,32)};
  }).filter(Boolean);
  const selected=candidates.find(x=>x.targetId===targetId)??null;
  if(!selected)issues.push(issue('MIMO.TARGET_ID_UNRESOLVED','--target-id',
    'exact source-bound TARGET- identifier',targetId,
    'Choose the compiler-unit-qualified ID from SECURITY_TARGET_PLAN_v1.json'));
  const contract=(Array.isArray(sourceIntelligence?.contracts)?sourceIntelligence.contracts:[])
    .find(x=>x.qualifiedName===selected?.qualifiedName&&
      x.compilationUnitId===selected?.compilationUnitId)??null;
  const entrypoints=(Array.isArray(sourceIntelligence?.effectiveEntrypoints)?
    sourceIntelligence.effectiveEntrypoints:[])
    .filter(x=>contract&&x.contractId===contract.contractId&&
      (x.compilationUnitId===selected?.compilationUnitId||x.compilationUnitId==null))
    .map(x=>({entrypointId:x.entrypointId??null,
      signature:x.canonicalSignature??null,selector:x.selector??null,
      stateChanging:x.stateChanging??null,implementationOrigin:x.implementationOrigin??null}))
    .filter(x=>x.signature);
  if(selected&&!entrypoints.length)issues.push(issue('MIMO.ABI_ENTRYPOINTS_UNAVAILABLE',
    'SOURCE_INTELLIGENCE_AUTOMATED_v1.json.effectiveEntrypoints',
    'exact unit and contract matched ABI entrypoint facts',
    contract?.contractId??null,'Repair source-bound ABI identity mapping'));
  issues.push(issue('MIMO.AUTHORIZED_PARAMETERS_UNAVAILABLE',
    'MIMO_STAGE_OBJECTIVE_v1.json.allowedParameterDeltas',
    'independently accepted owner-authorized ABI parameters',null,
    'Qualify exact scope before permitting any model-proposed state change'));
  const objective={schemaVersion:'curveyield-mimo-stage-objective-v1',
    pipelineVersion:'v1',status:'PREPARED_NOT_AUTHORIZED',
    sourceArchiveSha256:archiveSha,sourceIntelligenceSha256:sourceDoc?.sha256??null,
    runIdentity:identity,targetId,target:selected?{
      qualifiedName:selected.qualifiedName,compilationUnitId:selected.compilationUnitId,
      sourcePath:selected.sourcePath??null,abiDigestSha256:selected.abiDigestSha256}:null,
    observedCompilerEntrypoints:entrypoints,allowedParameterDeltas:[],
    previousNativeFeedback:null,acceptedConfigurationSha256:null,
    nativeExecutionAuthorized:false,sourceCommentsHaveInstructionAuthority:false,
    issues};
  return {mode:'mimo-objective',status:'NOT_EXECUTED',
    files:[output(args['output-root'],'MIMO_STAGE_OBJECTIVE_v1.json',objective)],
    sourceBound:!!selected&&!!sourceIntelligence&&identity.verifiedForCurrentJob,issues};
}
function proposalValueTyped(type,value){
  if(type==='bool')return typeof value==='boolean';
  if(type==='address')return typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value);
  const match=/^(u?int)([0-9]{0,3})$/.exec(String(type));
  if(!match)return false;
  if(typeof value!=='string'||value.length>79||!/(^-?(0|[1-9][0-9]*)$)/.test(value))return false;
  const bits=Number(match[2]||256),signed=match[1]==='int';
  if(bits<8||bits>256||bits%8!==0)return false;
  const n=BigInt(value),limit=1n<<BigInt(signed?bits-1:bits);
  return signed?n>=-limit&&n<limit:n>=0n&&n<limit;
}
function modelProposalV1(args,identity,issues){
  let proposal=null,objective=null,proposalHash=null;
  try{const original=readJson(args.proposal);proposal=original.value;proposalHash=original.sha256;}
  catch(error){issues.push(issue('MIMO.PROPOSAL_UNAVAILABLE','--proposal',
    'original bounded proposal JSON',String(error),
    'Provide the actual model response as one JSON object'));}
  try{objective=readJson(path.join(args['input-root'],'MIMO_STAGE_OBJECTIVE_v1.json'),
      args['input-root']).value;}
  catch(error){issues.push(issue('MIMO.OBJECTIVE_UNAVAILABLE','MIMO_STAGE_OBJECTIVE_v1.json',
    'same-run source-bound model objective',String(error),
    'Produce the exact ABI objective from the original preflight source'));}
  const allowedRoot=new Set(['schemaVersion','targetId','sourceArchiveSha256',
    'proposedChanges','evidenceRefs','objectiveDigestSha256']);
  for(const key of Object.keys(proposal??{}))
    if(!allowedRoot.has(key))issues.push(issue('MIMO.UNSUPPORTED_ROOT_FIELD',
      'MIMO_PROPOSAL_v1.'+key,'one of the declared proposal fields',key,
      'Remove any command, URL, environment, script or unsupported field'));
  if(proposal?.schemaVersion!=='curveyield-mimo-proposal-v1'||
     !Array.isArray(proposal?.proposedChanges))
    issues.push(issue('MIMO.PROPOSAL_SCHEMA_INVALID','MIMO_PROPOSAL_v1',
      'recognized proposal schema and proposedChanges array',proposal?.schemaVersion??null,
      'Return one strict proposal schema object'));
  if(!objective||proposal?.sourceArchiveSha256!==objective.sourceArchiveSha256||
     proposal?.targetId!==objective.targetId||identity.verifiedForCurrentJob!==true||
     objective.nativeExecutionAuthorized!==true)
    issues.push(issue('MIMO.NO_ACCEPTED_SCOPE','MIMO_PROPOSAL_v1.target/source/permission',
      'same-run source/target and independently accepted exact owner permissions',
      {sourceMatches:proposal?.sourceArchiveSha256===objective?.sourceArchiveSha256,
       targetMatches:proposal?.targetId===objective?.targetId,
       approved:objective?.nativeExecutionAuthorized??false},
      'Obtain accepted owner permissions before using any proposed change'));
  const permitted=new Set(['targetId','selector','argumentIndex','solidityType','value','evidenceRef']);
  const changes=Array.isArray(proposal?.proposedChanges)?proposal.proposedChanges:[];
  for(const [index,item] of changes.entries()){
    const field='MIMO_PROPOSAL_v1.proposedChanges['+index+']';
    if(!item||typeof item!=='object'||Array.isArray(item)){
      issues.push(issue('MIMO.CHANGE_INVALID',field,'typed ABI change object',item,
        'Return an object with exact selector, argument index, ABI type and value'));
      continue;
    }
    for(const key of Object.keys(item))
      if(!permitted.has(key))issues.push(issue('MIMO.CHANGE_UNSUPPORTED_FIELD',
        field+'.'+key,'declared ABI change field',key,'Remove unsupported field'));
    const exact=(Array.isArray(objective?.allowedParameterDeltas)?
      objective.allowedParameterDeltas:[]).find(x=>
      x.targetId===item.targetId&&x.selector===item.selector&&
      x.argumentIndex===item.argumentIndex&&x.solidityType===item.solidityType);
    if(!exact||!proposalValueTyped(item.solidityType,item.value))
      issues.push(issue('MIMO.ABI_CHANGE_OUTSIDE_SCOPE',field,
        'approved exact selector/index/type and ABI-range-canonical value',
        {selector:item.selector??null,index:item.argumentIndex??null,
         type:item.solidityType??null,value:item.value??null},
        'Use a separately approved source-bound ABI parameter and valid value'));
  }
  const disposition={schemaVersion:'curveyield-mimo-proposal-disposition-v1',
    pipelineVersion:'v1',status:'NOT_EXECUTED',safeForNativeExecution:false,
    proposalDigestSha256:proposalHash,
    objectiveDigestSha256:objective?digestCanonicalV1(objective):null,
    runIdentity:identity,issueCount:issues.length,issues};
  return {mode:'validate-proposal',status:'NOT_EXECUTED',sourceBound:false,
    files:[output(args['output-root'],'MIMO_PROPOSAL_DISPOSITION_v1.json',disposition)],issues};
}
function planSourceFacts(args,identity,issues){
  let manifest=null,sha=null;
  try{
    manifest=readJson(path.join(args['input-root'],'PREFLIGHT_MANIFEST_v1.json'),args['input-root']).value;
    sha=manifest?.source?.expectedSha256??null;
    if(!HEX.test(String(sha))||sha!==manifest.source?.observedSha256||
       manifest.sourceAdmissionVerified!==true||identity.verifiedForCurrentJob!==true)
      throw Error('ORIGINAL_SOURCE_AND_RUN_NOT_VERIFIED');
  }catch(error){
    issues.push(issue('CONFIG.SOURCE_IDENTITY_UNAVAILABLE','PREFLIGHT_MANIFEST_v1.json.source',
      'exact same-run expected/observed admitted source SHA-256',
      String(error),'Restore immutable original preflight source identity'));
  }
  const load=(name)=>{
    if(!manifest)return null;
    const found=evidence(args['input-root'],manifest,name,issues);
    if(!found)return null;
    // Some original machine inventories are bound by the manifest's original
    // file-byte SHA and admission digest, not by an embedded sourceIdentity.
    const internal=found.value?.sourceIdentity?.archiveSha256??
      found.value?.source?.archiveSha256??
      found.value?.source?.archiveSha256Observed??null;
    if(internal!==null&&internal!==sha){
      issues.push(issue('CONFIG.INDEXED_FILE_SOURCE_MISMATCH',name+'.sourceIdentity.archiveSha256',
        sha,internal,'Restore original exact SHA-indexed preflight evidence file'));
      return null;
    }
    return found;
  };
  return {sourceSha256:sha,sourceBound:!!sha&&manifest?.sourceAdmissionVerified===true&&
    identity.verifiedForCurrentJob,manifest,load};
}
function deriveForkPlan(args,identity,issues){
  const evidence=planSourceFacts(args,identity,issues);
  const readinessDocument=evidence.load('PROJECT_READINESS_AUTOMATED_v1.json');
  const build=evidence.load('BUILD_AND_SOURCE_IDENTITY_v1.json');
  const readiness=readinessDocument?.value?.deploymentAndConfiguration??{};
  const scripts=(Array.isArray(readiness.scriptFiles)?readiness.scriptFiles:[]).map(x=>
    typeof x==='string'?x:typeof x?.path==='string'?x.path:null).filter(Boolean);
  const deploymentFiles=(Array.isArray(readiness.deploymentFiles)?readiness.deploymentFiles:[])
    .map(x=>typeof x==='string'?x:typeof x?.path==='string'?x.path:null).filter(Boolean);
  const candidates=(Array.isArray(readiness.contractDeploymentInventory)?
    readiness.contractDeploymentInventory:[])
    .map(x=>({qualifiedName:x.qualifiedName??null,
      deployabilityStatus:x.deployabilityStatus??'UNDETERMINED',
      constructorInputs:(Array.isArray(x.constructorInputs)?x.constructorInputs:[])
        .map(p=>({name:p.name??null,type:p.type??null})),
      requiresLibraryLinking:(x.linkReferences??[]).length>0,
      sourceClass:x.sourceClass??null}))
    .filter(x=>x.qualifiedName);
  const chainCandidates=(Array.isArray(readiness.discoveredChainIds)?readiness.discoveredChainIds:[])
    .map(x=>typeof x==='number'?x:x?.chainId??null).filter(Number.isInteger);
  const sourceBound=evidence.sourceBound&&!!readinessDocument&&!!build;
  const requires=['approvedForkChainId','approvedUpstreamBlockNumber',
    'approvedUpstreamBlockHash','approvedForkHardfork',
    'approvedProjectRelativePath','approvedDeploymentProfileSha256',
    'sourceDeploymentScriptSha256',
    'sourceConfigurationScriptSha256','sourceFundingScriptSha256',
    'restrictedLocalRpcIsolationProof','approvedExecutionScopeSha256',
    'originalSourceCheckoutReceipt','actualActorAndFundingConfiguration'];
  for(const field of requires)issues.push(issue('FORK.REQUIRED_NATIVE_FACT_MISSING',
    'FORK_EXECUTION_PLAN_v1.json.'+field,
    'independently accepted original immutable fact',null,
    'Supply exact approved source-bound execution receipt and observe real fork state'));
  const out={schemaVersion:'curveyield-fork-execution-plan-v1',pipelineVersion:'v1',
    status:sourceBound?'DISCOVERED_NATIVE_UNAUTHORIZED':'SOURCE_FACTS_UNVERIFIED',
    originalSourceArchiveSha256:evidence.sourceSha256,sourceBound,
    runIdentity:identity,
    trustedOriginalRunner:'security-intelligence-phase0/scripts/run-phase0-fork-deploy-config-v1.mjs',
    trustedOriginalStateHelper:'security-intelligence-phase0/packages/github-native-sim/src/phase0-fork-state-reuse-v1.mjs',
    privateControllerEnvelopeReused:false,executionMode:'DEPLOYMENT_ONLY_NOT_EXECUTED',
    sourceEvidence:{readinessSha256:readinessDocument?.sha256??null,
      buildSha256:build?.sha256??null},
    untrustedSourceScriptPaths:scripts,untrustedSourceDeploymentPaths:deploymentFiles,
    chainIdMentionsNotAuthorizations:chainCandidates,contractCandidates:candidates,
    approvedForkChainId:null,approvedUpstreamBlockNumber:null,
    approvedUpstreamBlockHash:null,approvedForkHardfork:null,
    approvedProjectRelativePath:null,approvedDeploymentProfileSha256:null,
    sourceDeploymentScriptSha256:null,sourceConfigurationScriptSha256:null,
    sourceFundingScriptSha256:null,
    approvedExecutionScopeSha256:null,localOnlyNetworkIsolationVerified:false,
    c0:null,c1:null,c2:null,controllerAccepted:false,
    nativeCommandsExecuted:0,sourcePackageScriptsExecuted:0,
    requiredOriginalFields:requires,issues};
  return {mode:'fork-plan',status:'NOT_EXECUTED',sourceBound,
    files:[output(args['output-root'],'FORK_EXECUTION_PLAN_v1.json',out)],issues};
}
function observedOriginalC2Disposition(args,identity,sourceSha,issues){
  let raw=null;
  try{
    if(!args['c2-state'])throw Error('EXACT_SAME_RUN_C2_DISPOSITION_ARTIFACT_PATH_MISSING');
    const doc=readJson(args['c2-state']);
    const data=doc.value;
    if(data?.schemaVersion!=='curveyield-security-pipeline-fork-native-v1'||
      data.stage!=='G2B'||String(data.runId)!==String(identity.runId)||
      data.runAttempt!==identity.runAttempt||
      data.headSha!==identity.workflowHeadSha||
      data.sourceArchiveSha256!==sourceSha)
      throw Error('C2_DISPOSITION_SOURCE_OR_RUN_IDENTITY_MISMATCH');
    raw={artifactSha256:doc.sha256,stageStatus:data.status??null,
      nativeAttempted:data.nativeAttempted===true,
      originalC2ManifestSha256:data.forkStateManifestSha256??null,
      capturedBlock:data.c2?.blockNumber??null,
      capturedBlockHash:data.c2?.blockHash??null,
      privateTransportStatus:data.restrictedEvidence?.scope??null,
      originalC2BytesAvailableInThisConsumer:false,
      sourceBoundMetadata:true};
  }catch(error){
    issues.push(issue('G2B.C2_HANDOFF_UNAVAILABLE',
      'FORK_NATIVE_STATE_v1.json.originalSha256/runId/sourceArchiveSha256',
      'exact current-run source-bound G2B disposition, separate from private C2 state',
      String(error),'Restore same-run digest-only disposition and independently accepted restricted C2 transport'));
    raw={artifactSha256:null,stageStatus:'NOT_EXECUTED',
      nativeAttempted:false,originalC2ManifestSha256:null,
      capturedBlock:null,capturedBlockHash:null,
      privateTransportStatus:null,originalC2BytesAvailableInThisConsumer:false,
      sourceBoundMetadata:false};
  }
  if(raw.sourceBoundMetadata&&!raw.originalC2BytesAvailableInThisConsumer)
    issues.push(issue('G2B.C2_PRIVATE_RESTORE_UNAVAILABLE',
      'FORK_C2_RESTRICTED_TRANSPORT_v1.actualRestorableState',
      'original independently verified restricted gzip C2 state and safe readback in this consumer',
      {originalDispositionSha256:raw.artifactSha256,
       nativeStageStatus:raw.stageStatus,
       originalManifestSha256:raw.originalC2ManifestSha256,
       crossJobSourceBytesAvailable:false},
      'Establish approved private transport or same-job verified C2 readback; never treat a digest as chain state'));
  return raw;
}
function deriveStoragePlan(args,identity,issues){
  const source=planSourceFacts(args,identity,issues);
  const intelligence=source.load('SOURCE_INTELLIGENCE_AUTOMATED_v1.json');
  const c2=observedOriginalC2Disposition(args,identity,source.sourceSha256,issues);
  const contracts=(Array.isArray(intelligence?.value?.contracts)?
    intelligence.value.contracts:[]);
  const byContractId=new Map(contracts.map(x=>[x.contractId,x]));
  const declarations=Array.isArray(intelligence?.value?.storageLayout)?
    intelligence.value.storageLayout:[];
  const perVariable=declarations.map(x=>{
    const contract=byContractId.get(x.contractId);
    const slot=typeof x.slot==='string'&&/^(0|[1-9][0-9]*)$/.test(x.slot)?
      x.slot:null;
    const compilerProven=!!contract&&slot!==null&&
      x.confidenceClass==='COMPILER_FACT'&&
      /COMPILER_STORAGE_LAYOUT/.test(x.basis??'');
    const unknownMapping=typeof x.type==='string'&&
      /(mapping\s*\(|HashMap\s*\[|DynArray\s*\[|dynamic|array\s*\[)/i.test(x.type);
    if(!compilerProven)issues.push(issue('STORAGE.COMPILER_SLOT_UNVERIFIED',
      'SOURCE_INTELLIGENCE_AUTOMATED_v1.json.storageLayout['+(x.storageId??'UNKNOWN')+']',
      'source-bound compiler layout slot and contractId',
      {storageId:x.storageId??null,slot:x.slot??null,contractId:x.contractId??null,
       confidenceClass:x.confidenceClass??null,basis:x.basis??null},
      'Repair original unit-qualified compiler layout join; never treat a lexical declaration as a storage slot'));
    return{
      storageId:x.storageId??null,contractId:x.contractId??null,
      compilationUnitId:contract?.compilationUnitId??null,
      sourcePath:contract?.sourcePath??null,
      qualifiedContract:contract?.qualifiedName??null,
      stateVariable:x.label??null,compilerProvenStorageSlot:compilerProven?slot:null,
      compilerProvenStorageOffset:compilerProven?x.offset??null:null,
      compilerType:x.type??null,originalStorageCompilerBasis:x.basis??null,
      compilerStorageEvidenceRef:intelligence?.sha256??null,
      slotSourceQualified:compilerProven,
      requiresKnownOriginalMappingKeys:unknownMapping,
      intendedStorageAddress:null,logicAddress:null,proxyStorageAddress:null,
      knownMappingKeys:[],originalReadbacks:[],
      actualC2CheckpointSha256:null,rpcObservationSha256:null,
      status:compilerProven?
        'NOT_EXECUTED_C2_STORAGE_ADDRESS_OR_KEYS_MISSING':
        'NOT_EXECUTED_ORIGINAL_COMPILER_SLOT_NOT_PROVEN'
    };
  });
  issues.push(issue('STORAGE.SECOND_SLITHER_NATIVE_ROUND_UNEXECUTED',
    'FORK_STORAGE_QUERY_PLAN_v1.json.secondSlitherRound',
    'source-bound exact compiler storage layouts, deployed C2 storage/proxy addresses and live original readbacks',
    {sourceBoundLayoutCount:perVariable.filter(x=>x.slotSourceQualified).length,
     liveRpcReads:0,verifiedOriginalC2:!!c2.originalC2BytesAvailableInThisConsumer},
    'Run the existing Slither read-storage CLI only after original C2 and unit-qualified target/proxy state are verified'));
  const items=['verifiedC2ForkStateManifestSha256',
    'verifiedC2ChainId','verifiedC2BlockNumber',
    'verifiedC2BlockHash','originalLogicAddress',
    'originalProxyStorageAddress','knownMappingKeysAndOriginalReadbacks'];
  for(const field of items)issues.push(issue('STORAGE.C2_OBSERVATION_MISSING',
    'FORK_STORAGE_QUERY_PLAN_v1.json.'+field,
    'original independent same-run C2/contract evidence',null,
    'Use original captured C2 manifest and source-bound on-chain storage readback'));
  const out={schemaVersion:'curveyield-fork-storage-query-plan-v1',pipelineVersion:'v1',
    sourceArchiveSha256:source.sourceSha256,
    sourceBound:source.sourceBound&&!!intelligence,
    status:'NOT_EXECUTED_C2_NOT_PROVEN',runIdentity:identity,
    originalSourceIntelligenceSha256:intelligence?.sha256??null,
    originalForkC2Disposition:c2,
    compilerLayoutSlotCount:perVariable.filter(x=>x.slotSourceQualified).length,
    compilerLayoutUnverifiedCount:perVariable.filter(x=>!x.slotSourceQualified).length,
    knownOriginalMappingKeysCount:0,
    records:perVariable,requiredC2Fields:items,actualNativeQueriesExecuted:0,issues};
  return {mode:'storage-plan',status:'NOT_EXECUTED',
    sourceBound:out.sourceBound,
    files:[output(args['output-root'],'FORK_STORAGE_QUERY_PLAN_v1.json',out)],issues};
}
function deriveMedusaEligibility(args,identity,issues){
  const source=planSourceFacts(args,identity,issues);
  const inventory=source.load('REVIEW_INVENTORY_v1.json');
  const c2=observedOriginalC2Disposition(args,identity,source.sourceSha256,issues);
  // Native eligibility plans belong to a new scratch root, never the
  // original downloaded preflight artifact directory.
  const targetPlanPath=args['native-config']??path.join(args['input-root'],'SECURITY_TARGET_PLAN_v1.json');
  let targetPlan=null;
  try{targetPlan=readJson(targetPlanPath).value;}
  catch(error){issues.push(issue('MEDUSA.TARGET_PLAN_MISSING','SECURITY_TARGET_PLAN_v1.json',
    'original source-bound exact ABI/bytecode target map',String(error),
    'Produce source-bound target map before native Medusa init'));}
  const sourceBound=source.sourceBound&&!!inventory&&
    targetPlan?.sourceArchiveSha256===source.sourceSha256&&targetPlan?.sourceBound===true;
  const candidates=(Array.isArray(targetPlan?.targets)?targetPlan.targets:[])
    .filter(x=>x.compilationStatus==='EXACT_COMPILER_ARTIFACT')
    .map(x=>({targetId:x.targetId,qualifiedName:x.qualifiedName,
      status:'NOT_EXECUTED_C2_OR_EXISTING_PROPERTIES_UNVERIFIED',
      existingPropertySignatures:[],nativeMedusaInitVerified:false,
      c2OriginalStateSha256:null,protectedActorCollisionCheck:null,
      executedCallCount:0,propertyPassedCount:0,propertyFailedCount:0}));
  const missing=['nativeMedusaBinaryAndVerifiedCliSchema','sourceBoundC2StateWrapperSha256',
    'originalC2ChainIdAndBlockHash','approvedSenderAndDeployerAddresses',
    'existingAuthorizedPropertySignatures','nonCollidingImportedAccountProof'];
  for(const field of missing)issues.push(issue('MEDUSA.PREREQUISITE_UNOBSERVED',
    'MEDUSA_ELIGIBILITY_v1.json.'+field,
    'real verified original C2/native property evidence',null,
    'Verify the installed Medusa CLI, captured state and existing permitted source properties'));
  const out={schemaVersion:'curveyield-medusa-eligibility-v1',pipelineVersion:'v1',
    status:'NOT_EXECUTED',runIdentity:identity,sourceArchiveSha256:source.sourceSha256,
    sourceBound,originalInventorySha256:inventory?.sha256??null,
    originalForkC2Disposition:c2,
    targetCount:candidates.length,targets:candidates,
    nativeMedusaCommandsExecuted:0,nativePropertiesExecuted:0,
    behaviorOnlyNeverClaimedPropertyPassed:true,
    requiredNativeFields:missing,issues};
  return {mode:'medusa-config',status:'NOT_EXECUTED',sourceBound,
    files:[output(args['output-root'],'MEDUSA_ELIGIBILITY_v1.json',out)],issues};
}
function deriveNativeAnalyzerEligibility(args,identity,issues){
  const engines={
    wake:{gate:'G3',tool:'wake',supports:['SOLIDITY'],
      requiredNative:['approvedWakeSourceRevision','approvedPythonAbiAndLockSha256',
        'approvedWakeBinarySha256','originalSourceRootSha256',
        'observedWakeNativeCliSchema']},
    mythril:{gate:'G4',tool:'mythril',supports:['SOLIDITY','VYPER'],
      requiredNative:['approvedMythrilSourceRevision','approvedPythonAbiAndSolverSha256',
        'approvedMythrilBinarySha256','originalFullyLinkedBytecodeHexSha256',
        'observedMythrilNativeCliSchema']},
    'certora-prover':{gate:'G5',tool:'certora-prover',supports:['SOLIDITY'],
      requiredNative:['approvedLocalProverSourceRevision','approvedLocalProverJarSha256',
        'approvedJavaRuntimeBinarySha256','approvedZ3OrCVC5BinarySha256',
        'originalPermittedSourceLinkedCvlSpecificationSha256']},
    'mimo-provider':{gate:'G6',tool:'autoprover',supports:['SOLIDITY'],
      requiredNative:['approvedAutoProverSourceRevision','approvedComposerPythonLockSha256',
        'verifiedProviderSpecAndModelProviderApi','verifiedLocalMiMoRuntimeSha256',
        'verifiedLocalMiMoWeightsSha256','verifiedComposerToolCallAndMemorySemantics']},
    autoprover:{gate:'G7',tool:'autoprover',supports:['SOLIDITY'],
      requiredNative:['approvedAutoProverSourceRevision','approvedComposerPythonLockSha256',
        'verifiedLocalCertoraProverAndSolvers','verifiedComposerMiMoProvider',
        'approvedSourceArchiveAndTarget','sourceBoundOriginalNativeProverOutput']}
  };
  const name=args.component;
  const selected=engines[name];
  if(!selected){
    issues.push(issue('NATIVE.ANALYZER_NOT_FIXED_ENUM','--component',
      Object.keys(engines),name,
      'Choose one of the fixed supported original native tool families'));
    return {mode:'native-analyzer-eligibility',status:'NOT_EXECUTED',sourceBound:false,
      files:[output(args['output-root'],'NATIVE_ANALYZER_ELIGIBILITY_v1.json',{
        schemaVersion:'curveyield-security-native-analyzer-eligibility-v1',
        analyzer:name??null,sourceBound:false,status:'UNSUPPORTED',issues})],issues};
  }
  const identityFacts=planSourceFacts(args,identity,issues);
  const original=identityFacts.load('PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json');
  const intelligence=identityFacts.load('SOURCE_INTELLIGENCE_AUTOMATED_v1.json');
  let plan=null,planDigest=null;
  try{
    const file=args['native-config']??path.join(args['input-root'],'SECURITY_TARGET_PLAN_v1.json');
    const data=readJson(file);
    plan=data.value;planDigest=data.sha256;
  }catch(error){
    issues.push(issue('NATIVE.SOURCE_BOUND_TARGET_PLAN_MISSING',
      '--native-config','original source-bound target plan file',
      String(error),'Recreate exact G2 source-bound target census in isolated derived output'));
  }
  const sourceBound=identityFacts.sourceBound&&plan?.sourceBound===true&&
    plan?.sourceArchiveSha256===identityFacts.sourceSha256&&!!intelligence;
  const compiled=Array.isArray(plan?.targets)?plan.targets:[];
  const bytecodeMap=new Map((Array.isArray(original?.value?.artifacts)?
    original.value.artifacts:[]).map(row=>
      [(row.compilationUnitId??'')+'|'+(row.qualifiedName??''),row]));
  const targets=[];
  const knownContexts=[];
  if(name==='mimo-provider'||name==='autoprover'){
    const providerPath=path.resolve(process.env.GITHUB_WORKSPACE??process.cwd(),
      'security-intelligence-phase0/autoprover-local-provider/curveyield_autoprover_mimo/__init__.py');
    const packagePath=path.resolve(process.env.GITHUB_WORKSPACE??process.cwd(),
      'security-intelligence-phase0/autoprover-local-provider/pyproject.toml');
    try{
      const pluginBytes=readBytes(providerPath),packageBytes=readBytes(packagePath);
      knownContexts.push({artifact:'curveyield_autoprover_mimo/__init__.py',
        originalCurrentCheckoutSha256:sha256HexV1(pluginBytes),
        entrypointPackageSha256:sha256HexV1(packageBytes),
        declaredUpstreamComposerInterfaceRevision:
          '81d9626c249a70c0a0f0648a89de175443c0344c',
        registrationImportNativeVerified:false,
        providerToolCallsNativeVerified:false,
        documentAndMemoryNativeVerified:false,
        compatibilityClass:'ORIGINAL_SOURCE_ADAPTER_PRESENT_UNQUALIFIED'});
    }catch(error){
      issues.push(issue('NATIVE.LOCAL_MIMO_PROVIDER_ADAPTER_MISSING',
        'security-intelligence-phase0/autoprover-local-provider/curveyield_autoprover_mimo/__init__.py',
        'original current-revision local Composer provider and entrypoint metadata',
        String(error),'Restore the existing out-of-tree provider source and original Composer runtime before qualification'));
    }
  }
  const originalReadiness=identityFacts.load('PROJECT_READINESS_AUTOMATED_v1.json');
  if(originalReadiness)knownContexts.push({
    artifact:'PROJECT_READINESS_AUTOMATED_v1.json',originalSha256:originalReadiness.sha256});
  for(const row of compiled){
    const sourceScope=row.sourceBound===true&&row.compilationStatus==='EXACT_COMPILER_ARTIFACT';
    const languageSupported=selected.supports.includes(row.language);
    const contract=row.compilationUnitId+'|'+row.qualifiedName;
    const candidate=bytecodeMap.get(contract)??null;
    const originalCreation=typeof candidate?.bytecode==='string'?candidate.bytecode:null;
    const originalBytecodeDigest=originalCreation&&/^(?:0x)?[0-9a-fA-F]*$/.test(originalCreation)?
      sha256HexV1(Buffer.from(originalCreation.replace(/^0x/,'').toLowerCase(),'hex')):null;
    const creationDigestMatch=!!originalBytecodeDigest&&
      originalBytecodeDigest===row.creationBytecodeDigestSha256;
    const needsLibraryLinking=!!candidate&&
      Object.values(candidate.linkReferences??{}).some(group=>
        Object.values(group??{}).some(positions=>Array.isArray(positions)&&positions.length>0));
    const unsupportedReason=!sourceScope?'SOURCE_COMPILER_TARGET_UNVERIFIED':
      !languageSupported?'SOURCE_LANGUAGE_UNSUPPORTED_BY_NATIVE_PROGRAM':
      name==='mythril'&&needsLibraryLinking?'UNLINKED_LIBRARY_REFERENCES':
      name==='mythril'&&!creationDigestMatch?'EXACT_CREATION_BYTECODE_SHA256_MISMATCH_OR_UNAVAILABLE':
      'APPROVED_NATIVE_TOOL_AND_SOURCE_EXECUTION_INPUT_MISSING';
    const sourceEligible=sourceScope&&languageSupported&&
      (name!=='mythril'||creationDigestMatch&&!needsLibraryLinking);
    if(!sourceEligible)issues.push(issue('NATIVE.TARGET_SCOPE_UNSUPPORTED',
      'nativeTarget['+(row.targetId??'UNRESOLVED')+'].sourceEligibility',
      'source-scoped compiler artifact, supported language'+
        (name==='mythril'?', original fully linked creation bytecode':''),{
          targetId:row.targetId??null,reasonCode:unsupportedReason,
          compilerUnit:row.compilationUnitId??null,
          originalLinkedBytecodeDigestMatches:creationDigestMatch,
          hasLibraryReferences:needsLibraryLinking},
      'Exclude this original target from the native command; never substitute a different source or bytecode'));
    targets.push({
      targetId:row.targetId??null,sourcePath:row.sourcePath??null,
      compilationUnitId:row.compilationUnitId??null,qualifiedName:row.qualifiedName??null,
      sourceLanguage:row.language??null,
      compilerAbiSha256:row.abiDigestSha256??null,
      creationBytecodeSha256:row.creationBytecodeDigestSha256??null,
      sourceBound:sourceScope,languageSupported,
      creationBytecodePresentInOriginalCompilerBundle:!!originalCreation,
      creationBytecodeDigestMatch:creationDigestMatch,
      needsLibraryLinking,
      eligibilityClass:sourceEligible?'POTENTIAL_AFTER_NATIVE_QUALIFICATION':'SOURCE_UNSUPPORTED',
      status:'NOT_EXECUTED',
      reasonCode:unsupportedReason,
      originalNativeEvidenceSha256:null,
      nativeAttempts:0,nativeFindingsObserved:null});
  }
  for(const field of selected.requiredNative)
    issues.push(issue('NATIVE.ORIGINAL_EXECUTION_PREREQUISITE_MISSING',
      'NATIVE_ANALYZER_ELIGIBILITY_v1.json.'+name+'.'+field,
      'original independently qualified native evidence for '+selected.gate,
      null,'Qualify exact source/lock/CLI/binary ABI and preserve original run output before enabling '+name));
  const report={
    schemaVersion:'curveyield-security-native-analyzer-eligibility-v1',
    pipelineVersion:'v1',implementationSpecVersion:'v14',gate:selected.gate,
    analyzer:name,requiredToolComponent:selected.tool,
    status:'NOT_EXECUTED',sourceBound,sourceArchiveSha256:identityFacts.sourceSha256,
    targetPlanSha256:planDigest,originalCompilerArtifactBundleSha256:original?.sha256??null,
    originalSourceIntelligenceSha256:intelligence?.sha256??null,
    runIdentity:identity,
    targetCount:targets.length,languageSupportedCount:targets.filter(x=>x.languageSupported).length,
    exactNativePotentialEligibleCount:targets.filter(x=>x.eligibilityClass==='POTENTIAL_AFTER_NATIVE_QUALIFICATION').length,
    sourceUnsupportedCount:targets.filter(x=>x.eligibilityClass==='SOURCE_UNSUPPORTED').length,
    originalCompilerBytecodeCount:targets.filter(x=>x.creationBytecodeDigestMatch).length,
    targetResults:targets,originalSourceFacts:knownContexts,
    nativeExecutionAuthorized:false,nativeCommandsExecuted:0,
    nativeOriginalRawBytesRetained:false,nativeToolVersion:null,
    originalNativeStdoutSha256:null,originalNativeStderrSha256:null,
    originalNativeExitCode:null,originalNativeFindings:[],
    originalNativeCounterexamples:[],
    requiredNativeFields:selected.requiredNative,issues
  };
  return {mode:'native-analyzer-eligibility',status:'NOT_EXECUTED',sourceBound,
    files:[output(args['output-root'],'NATIVE_ANALYZER_ELIGIBILITY_v1.json',report)],issues};
}
function additional(args,identity,issues){
  const folder=args['output-root'], op=args.operation;
  let selected=null;
  if(op==='toolkit-profile'){
    let targetDoc=null,plan={};
    try{
      targetDoc=readJson(path.join(args['input-root'],'SECURITY_TARGET_PLAN_v1.json'),args['input-root']);
      plan=targetDoc.value;
    }catch(error){
      issues.push(issue('TOOLKIT.SOURCE_TARGET_PLAN_MISSING','SECURITY_TARGET_PLAN_v1.json',
        'same-run source-bound target plan',String(error),
        'Restore exact original indexed target-plan bytes'));
    }
    const sourceBound=plan.sourceBound===true&&identity.verifiedForCurrentJob;
    const compiled=(Array.isArray(plan.targets)?plan.targets:[]).filter(x=>
      x.compilationStatus==='EXACT_COMPILER_ARTIFACT'&&x.sourceBound===true);
    const hasSolidity=compiled.some(x=>x.language==='SOLIDITY');
    const hasBytecode=compiled.some(x=>HEX.test(String(x.creationBytecodeDigestSha256??'')));
    const hasStorage=compiled.some(x=>x.programEligibility?.['slither-storage']?.eligible===true);
    const requirements={
      'foundry-node':compiled.length>0,
      'source-compilers':compiled.length>0,
      'slither-storage':hasStorage,'medusa':compiled.length>0,'wake':hasSolidity,
      'mythril':hasBytecode,'certora-prover':compiled.length>0,
      'autoprover':compiled.length>0,
      'mimo-runtime':compiled.length>0,'mimo-weights':compiled.length>0
    };
    const sourcePath=path.resolve(process.env.GITHUB_WORKSPACE??process.cwd(),
      '.github/workflows/lite-solo-ai-inference-v1.yml');
    let nativePins=null;
    try{
      const source=fs.readFileSync(sourcePath,'utf8');
      const unique=(key,predicate)=>{
        const found=[...source.matchAll(new RegExp('^\\s*'+key+':\\s*('+predicate+')\\s*$','gm'))];
        if(found.length!==1)throw Error('TRUSTED_MIMO_PIN_MISSING_OR_AMBIGUOUS:'+key);
        return found[0][1];
      };
      nativePins={
        modelSha256:unique('MODEL_SHA256','[a-f0-9]{64}'),
        modelRevision:unique('MODEL_REVISION','[a-f0-9]{40}'),
        modelFile:unique('MODEL_FILE','[A-Za-z0-9._-]+'),
        llamaCppRevision:unique('LLAMA_SHA','[a-f0-9]{40}')
      };
    }catch(error){
      issues.push(issue('TOOLKIT.CHECKED_OUT_MIMO_PIN_UNAVAILABLE',
        '.github/workflows/lite-solo-ai-inference-v1.yml.MiMoPins',
        'original pinned GGUF SHA, revision, filename and llama commit',String(error),
        'Reinspect the current trusted MiMo workflow and qualify its original source pins'));
    }
    // U06: inspect current source-controlled pin provenance per component.
    // Lockfile/package versions are recipes, NOT fabricated binary SHA-256.
    const qualifiedFile=(rel)=>{
      const absolute=path.resolve(process.env.GITHUB_WORKSPACE??process.cwd(),rel);
      const bytes=readBytes(absolute);
      return {content:bytes.toString('utf8'),digest:sha256HexV1(bytes)};
    };
    let lock=null,lockHash=null,originalDocker=null,dockerHash=null,nodeActionHash=null;
    try{
      const f=qualifiedFile('security-intelligence-phase0/package-lock.json');
      lock=JSON.parse(f.content);lockHash=f.digest;
      const d=qualifiedFile('security-intelligence-phase0/Dockerfile');
      originalDocker=d.content;dockerHash=d.digest;
      nodeActionHash=qualifiedFile('.github/actions/setup-phase0-node-cache/action.yml').digest;
    }catch(error){
      issues.push(issue('TOOLKIT.LOCAL_TRUSTED_RECIPE_UNAVAILABLE',
        'toolkitSourcePins.packageLock/Dockerfile/setupAction',
        'actual current checkout package lock, original Docker and cache action',
        String(error),'Restore original pinned local toolchain provenance before provisioning'));
    }
    const lockRoot=lock?.packages?.['']?.dependencies??{};
    const foundryNames=['anvil','cast','forge'];
    const foundryLocks=foundryNames.map(name=>({
      name,version:lock?.packages?.['node_modules/@foundry-rs/'+name]?.version??null,
      npmTarballIntegrity:lock?.packages?.['node_modules/@foundry-rs/'+name]?.integrity??null
    }));
    const foundryPinned=foundryLocks.every(x=>
      x.version==='1.7.1'&&typeof x.npmTarballIntegrity==='string'&&
      x.npmTarballIntegrity.startsWith('sha512-'))&&
      foundryNames.every(x=>lockRoot['@foundry-rs/'+x]==='1.7.1');
    const solcPinned=lockRoot.solc==='0.8.30'&&
      lock?.packages?.['node_modules/solc']?.version==='0.8.30'&&
      typeof lock?.packages?.['node_modules/solc']?.integrity==='string';
    // G2 exports exact source compiler units; the software cache binds only
    // their approved version/package set, never the confidential source ID.
    let compilerSubentries=[],compilerEvidenceSha256=null;
    try{
      const source=readJson(path.join(args['input-root'],'SECURITY_BUILD_BINDING_v1.json'),
        args['input-root']);
      const record=source.value;
      if(record.sourceBound!==true||record.buildSourceBound!==true||
         record.sourceArchiveSha256!==plan.sourceArchiveSha256)
        throw Error('SOURCE_COMPILER_BUILD_RECEIPT_NOT_ORIGINAL_SHA_BOUND');
      compilerEvidenceSha256=source.sha256;
      const units=record.buildIdentity?.compilationUnits??[];
      if(!Array.isArray(units))throw Error('SOURCE_COMPILER_UNITS_NOT_ARRAY');
      const versions=new Map();
      for(const unit of units){
        if(typeof unit?.compilerVersion!=='string'||
          !/^([0-9]+\.){2}[0-9]+(?:\+[A-Za-z0-9.-]+)?$/.test(unit.compilerVersion)){
          issues.push(issue('TOOLKIT.COMPILER_UNIT_VERSION_NOT_EXACT',
            'SECURITY_BUILD_BINDING_v1.json.buildIdentity.compilationUnits[].compilerVersion',
            'original exact normalized compiler semver',unit?.compilerVersion??null,
            'Retain this compilation unit as an unqualified subentry until compiler identity is recovered'));
          continue;
        }
        const pkg=typeof unit.compilerPackage==='string'&&
          /^[A-Za-z0-9._@/-]{1,100}$/.test(unit.compilerPackage)?
          unit.compilerPackage:null;
        const label=(pkg??'UNKNOWN_PACKAGE')+'@'+unit.compilerVersion;
        if(!versions.has(label))versions.set(label,{
          compilerPackage:pkg,compilerVersion:unit.compilerVersion,
          originalExecutionUnitCount:0,expectedBinarySha256:null,
          nativeReadinessMode:'COMPILER_BINARY_SHA_OR_PACKAGE_PIN_UNRESOLVED',
          originalPinOrigin:'SECURITY_BUILD_BINDING_v1.json.buildIdentity.compilationUnits'
        });
        versions.get(label).originalExecutionUnitCount++;
      }
      compilerSubentries=[...versions.values()].sort((a,b)=>
        String(a.compilerPackage).localeCompare(String(b.compilerPackage))||
        a.compilerVersion.localeCompare(b.compilerVersion));
    }catch(error){
      issues.push(issue('TOOLKIT.COMPILER_SOURCE_VERSION_SET_UNAVAILABLE',
        'SECURITY_BUILD_BINDING_v1.json.buildIdentity.compilationUnits',
        'same-run source-bound compiler unit/version list',String(error),
        'Restore exact G2 compiler build binding before native compiler cache planning'));
    }
    const slitherMatch=originalDocker?.match(/slither-analyzer==([0-9]+\.[0-9]+\.[0-9]+)/);
    const staticSources={
      'foundry-node':foundryPinned?{
        approvedVersion:'1.7.1',approvedSourceRevision:null,
        originalPinOrigin:'security-intelligence-phase0/package-lock.json',
        lockDigest:lockHash,recipeDigest:digestCanonicalV1({
          nodeMajor:22,packageLockSha256:lockHash,
          originalActionSha256:nodeActionHash,foundryLocks}),
        abiProfile:'node22-'+process.platform+'-'+process.arch,
        nativeConsumerStages:['fork_setup','storage_inspect','medusa_analyze']
      }:null,
      'source-compilers':solcPinned?{
        approvedVersion:'solc-0.8.30-plus-source-admitted-toolchains',
        approvedSourceRevision:null,
        originalPinOrigin:'security-intelligence-phase0/package-lock.json and Dockerfile',
        lockDigest:lockHash,recipeDigest:digestCanonicalV1({
          solcLock:lock?.packages?.['node_modules/solc']?.integrity,
          dockerSha256:dockerHash,
          // Compiler unit IDs and source archive digests NEVER enter software cache keys.
          compilerVersionSet:compilerSubentries.map(x=>[
            x.compilerPackage,x.compilerVersion])}),
        compilerSubentries,
        compilerVersionSetEvidenceSha256:compilerEvidenceSha256,
        nativeConsumerStages:['fork_setup','medusa_analyze','mythril_analyze']
      }:null,
      'slither-storage':slitherMatch?{
        approvedVersion:slitherMatch[1],approvedSourceRevision:null,
        originalPinOrigin:'security-intelligence-phase0/Dockerfile',
        lockDigest:dockerHash,recipeDigest:digestCanonicalV1({
          declaredDockerSha256:dockerHash,slitherVersion:slitherMatch[1]}),
        abiProfile:'python3-debian-bookworm',
        nativeConsumerStages:['storage_inspect']
      }:null,
      'mimo-runtime':nativePins?{
        approvedVersion:'pinned-llama.cpp-CPU',approvedSourceRevision:nativePins.llamaCppRevision,
        originalPinOrigin:'.github/workflows/lite-solo-ai-inference-v1.yml',
        lockDigest:null,recipeDigest:digestCanonicalV1({
          sourceCommit:nativePins.llamaCppRevision,
          cmakeBuildType:'Release',GGML_NATIVE:false,LLAMA_BUILD_TESTS:false,
          target:'llama-server',cpuOnly:true}),
        abiProfile:'cpu-'+process.platform+'-'+process.arch,
        nativeConsumerStages:['mimo_configure','mimo_provider_qualify','autoprover_run']
      }:null,
      'mimo-weights':nativePins?{
        approvedVersion:nativePins.modelFile,approvedSourceRevision:nativePins.modelRevision,
        originalPinOrigin:'.github/workflows/lite-solo-ai-inference-v1.yml',
        lockDigest:null,recipeDigest:digestCanonicalV1({
          modelSha256:nativePins.modelSha256,modelRevision:nativePins.modelRevision,
          file:nativePins.modelFile}),
        expectedBinarySha256:nativePins.modelSha256,
        abiProfile:'gguf-q4_k_m',
        nativeConsumerStages:['mimo_configure','mimo_provider_qualify','autoprover_run']
      }:null
    };
    const pinDeficits={
      'foundry-node':['original independent Forge/Anvil/Cast native executable SHA-256'],
      'source-compilers':['compiler-version-specific solc/Vyper original binary SHA-256 and source resolution ledger'],
      'slither-storage':['original slither-read-storage CLI/package-tree SHA-256 and Python lock'],
      'medusa':['approved immutable Go source revision','actual ELF SHA-256','Go build ABI'],
      'wake':['approved Python package lock/revision','Wake executable SHA-256'],
      'mythril':['approved Python package lock/revision','Mythril and SMT binary SHA-256'],
      'certora-prover':['approved local Prover artifact SHA-256','JVM and SMT binary digests'],
      'autoprover':['approved original Composer dependency lock','original installed entrypoint binary/package-tree SHA-256'],
      'mimo-runtime':['independent trusted native llama-server ELF SHA-256 or accepted source-build attestation'],
      'mimo-weights':[]
    };
    const components=COMPONENTS.map(id=>{
      const required=sourceBound?requirements[id]:null;
      const provenance=staticSources[id]??null;
      const originalBytePinned=id==='mimo-weights'&&provenance?.expectedBinarySha256===nativePins?.modelSha256;
      if(required===null)issues.push(issue('TOOLKIT.COMPONENT_REQUIRED_UNKNOWN',
        'toolkitComponents['+id+'].required',
        'boolean from admitted source-bound compatibility',null,
        'Restore exact original target-plan source binding'));
      if(required===true&&!originalBytePinned){
        const specific=pinDeficits[id]??['independent approved executable identity'];
        for(const field of specific)issues.push(issue('TOOLKIT.COMPONENT_NATIVE_PIN_UNRESOLVED',
          'toolkitComponents['+id+'].originalNativePin.'+field.replace(/[^a-zA-Z0-9]+/g,'_'),
          field,provenance?.originalPinOrigin??null,
          'Qualify this exact independent executable/ABI pin in the trusted current checkout'));
      }
      return {componentId:id,required,
        notRequiredReason:required===false?'NO_MATCHING_ADMITTED_TARGET':
          required===null?'SOURCE_TARGET_PLAN_NOT_VERIFIED':null,
        approvedVersion:provenance?.approvedVersion??null,
        approvedSourceRevision:provenance?.approvedSourceRevision??null,
        expectedBinarySha256:originalBytePinned?nativePins.modelSha256:null,
        os:process.platform,arch:process.arch,
        abiProfile:provenance?.abiProfile??null,
        lockDigest:provenance?.lockDigest??null,
        recipeDigest:provenance?.recipeDigest??null,
        expectedBytesOrQuota:null,
        originalPinOrigin:provenance?.originalPinOrigin??null,
        compilerSubentries:id==='source-compilers'?compilerSubentries:[],
        compilerVersionSetEvidenceSha256:id==='source-compilers'?compilerEvidenceSha256:null,
        originalPinEvidence:provenance?{
          packageLockSha256:lockHash,originalDockerSha256:dockerHash,
          nodeSetupActionSha256:nodeActionHash}:null,
        unresolvedNativePinFields:required===true&&!originalBytePinned?pinDeficits[id]:[],
        nativeConsumerStages:provenance?.nativeConsumerStages??[],
        nativeReadinessMode:originalBytePinned?'TRUSTED_ORIGINAL_PIN_NOT_YET_INSTALLED':
          provenance?'RECIPE_SOURCE_VERIFIED_BINARY_SHA_UNRESOLVED':'PIN_UNRESOLVED'};
    });
    selected=['TOOLKIT_PROFILE_v1.json',{
      schemaVersion:'curveyield-toolkit-profile-v1',
      sourceBound,runIdentity:identity,sourceArchiveSha256:plan.sourceArchiveSha256??null,
      targetPlanSha256:targetDoc?.sha256??null,
      sourcePinProvenance:nativePins?{originalWorkflow:
        '.github/workflows/lite-solo-ai-inference-v1.yml',...nativePins}:null,
      status:issues.length?'PARTIAL':'SOURCE_BOUND',components,issues}];
  }else if(op==='validate-proposal'){
    return modelProposalV1(args,identity,issues);
  }else if(op==='mimo-objective'){
    return modelObjectiveV1(args,identity,issues);
  }else if(op==='fork-plan'){
    return deriveForkPlan(args,identity,issues);
  }else if(op==='storage-plan'){
    return deriveStoragePlan(args,identity,issues);
  }else if(op==='medusa-config'){
    return deriveMedusaEligibility(args,identity,issues);
  }else if(op==='native-analyzer-eligibility'){
    return deriveNativeAnalyzerEligibility(args,identity,issues);
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
