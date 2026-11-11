import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {id as ethersTopicId} from 'ethers';

// Fork-only implementation of the existing Phase 0 output writer.
// Never writes to a campaign, a receipt, main, the private cache, or the Worker.
const a={};
for(let i=2;i<process.argv.length;i++)if(process.argv[i].startsWith('--'))a[process.argv[i].slice(2)]=process.argv[++i];
for(const key of ['controller-root','fork-run-root','source-receipt','simulation-output'])
  if(!a[key])throw new Error('FORK_WRITER_REQUIRED_'+key.replaceAll('-','_'));
if(a['campaign-path']||a['destination-campaign-path'])
  throw new Error('FORK_WRITER_CAMPAIGN_PATH_WRITE_PROHIBITED');
const controllerRoot=path.resolve(a['controller-root']);
const forkRunRoot=path.resolve(a['fork-run-root']);
const prefix='Machine Intelligence Phase0 Deterministic Extraction Fork v1/runs/';
const rel=path.relative(controllerRoot,forkRunRoot).split(path.sep).join('/');
if(!rel.startsWith(prefix)||rel.split('/').length!==4||rel.includes('..'))
  throw new Error('FORK_RUN_ROOT_OUTSIDE_AUTHORIZED_ISOLATED_NAMESPACE');
const receiptFile=path.resolve(a['source-receipt']);
if(receiptFile!==path.join(forkRunRoot,'inputs','READ_ONLY_INPUT_RECEIPT_COPY.json'))
  throw new Error('SOURCE_RECEIPT_COPY_MUST_STAY_IN_FORK_INPUTS');
const receiptBytes=await fs.readFile(receiptFile);
const receipt=JSON.parse(receiptBytes.toString('utf8'));
if(receipt?.campaign?.campaignId!==rel.split('/')[2]||
  !/^[a-f0-9]{64}$/i.test(String(receipt?.source?.sha256??'')))
  throw new Error('FORK_SOURCE_RECEIPT_OR_CAMPAIGN_IDENTITY_MISMATCH');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const simulationOutput=path.resolve(a['simulation-output']);
const staticOutput=a['static-output']?path.resolve(a['static-output']):null;
const files=[];
const writeVerified=async(source,targetRel)=>{
  const stat=await fs.lstat(source).catch(()=>null);
  if(!stat||!stat.isFile()||stat.isSymbolicLink())return false;
  const dst=path.resolve(forkRunRoot,...targetRel.split('/'));
  if(!dst.startsWith(forkRunRoot+path.sep))throw new Error('FORK_WRITER_OUTPUT_ESCAPE');
  await fs.mkdir(path.dirname(dst),{recursive:true});
  const bytes=await fs.readFile(source);
  try{await fs.writeFile(dst,bytes,{flag:'wx'});}
  catch(error){
    if(error?.code!=='EEXIST')throw error;
    const existing=await fs.readFile(dst);
    if(sha256(existing)!==sha256(bytes))throw new Error('FORK_WRITER_CONFLICTING_IMMUTABLE_EVIDENCE');
  }
  const observed=await fs.readFile(dst);
  if(sha256(observed)!==sha256(bytes))throw new Error('FORK_WRITER_READBACK_DIGEST_MISMATCH');
  files.push({path:targetRel,sha256:sha256(bytes),bytes:bytes.length});
  return true;
};
const staticMap=[
  ['BUILD_AND_SOURCE_IDENTITY_v1.json','evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'],
  ['PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json','evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json'],
  ['CONTRACT_IDENTITY_INDEX_v1.json','evidence/phase0/CONTRACT_IDENTITY_INDEX_v1.json'],
  ['SBOM_v1.json','evidence/build/SBOM_v1.json'],
  ['SLITHER_v1.json','evidence/static-analysis/SLITHER_v1.json'],
  ['SLITHER_RELATIONAL_FACTS_v1.json','evidence/static-analysis/SLITHER_RELATIONAL_FACTS_v1.json'],
  ['REVIEW_INVENTORY_v1.json','evidence/review-inventory/REVIEW_INVENTORY_v1.json'],
  ['SYSTEM_FACTS_v1.json','evidence/review-inventory/SYSTEM_FACTS_v1.json'],
  ['SOURCE_INTELLIGENCE_AUTOMATED_v1.json','evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json'],
  ['PROJECT_READINESS_AUTOMATED_v1.json','evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json']
];
if(staticOutput){
  for(const [name,destination] of staticMap){
    const ok=await writeVerified(path.join(staticOutput,name),destination);
    if(!ok)files.push({path:destination,status:'UNAVAILABLE'});
  }
}
const simMap=[
  ['PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'],
  ['DEPLOYED_STATE_SNAPSHOT_v1.json','evidence/phase0/DEPLOYED_STATE_SNAPSHOT_v1.json']
];
for(const [name,destination] of simMap){
  const ok=await writeVerified(path.join(simulationOutput,name),destination);
  if(!ok)files.push({path:destination,status:'UNAVAILABLE'});
}
// Only the copied extractor's own evidence/phase0 tree is eligible.
// This includes complete hash-bearing trace parts, never an original campaign path.
const simEvidence=path.join(simulationOutput,'evidence','phase0');
async function copyTree(from,relative=''){
  const stat=await fs.lstat(from).catch(()=>null);
  if(!stat)return;
  if(stat.isSymbolicLink())throw new Error('FORK_WRITER_SYMLINK_INPUT_FORBIDDEN');
  if(stat.isFile()){
    await writeVerified(from,path.posix.join('evidence/phase0',relative));
  }else if(stat.isDirectory()){
    for(const ent of await fs.readdir(from,{withFileTypes:true})){
      if(ent.name==='.'||ent.name==='..')throw new Error('FORK_WRITER_INVALID_FILE_NAME');
      await copyTree(path.join(from,ent.name),path.posix.join(relative,ent.name));
    }
  }
}
await copyTree(simEvidence);

// Mechanical graph projection from already-persisted source, Slither and trace bytes.
// Static callsites and ABI declarations are never upgraded to observed runtime facts.
async function buildForkRelationshipGraphV1(){
  const observedFiles=new Map();
  const readBound=async relative=>{
    const absolute=path.resolve(forkRunRoot,...relative.split('/'));
    if(!absolute.startsWith(forkRunRoot+path.sep))throw new Error('GRAPH_SOURCE_ESCAPE');
    const bytes=await fs.readFile(absolute);
    const digest=sha256(bytes);
    observedFiles.set(relative,digest);
    return{value:JSON.parse(bytes.toString('utf8')),ref:{path:relative,sha256:digest}};
  };
  const optional=async(relative,kind)=>{
    try{return await readBound(relative);}
    catch(error){return{value:null,ref:null,limitation:{kind,
      type:'MISSING_OR_INVALID_SOURCE',path:relative,reason:String(error?.message??error)}};}
  };
  // Read whole RPC evidence by its SHA-bound manifest, not an unverified
  // preview or guessed first part. Parts are byte slices, not independent JSON.
  const readCompleteCapturedRpcJsonV1=async(pointer,kind)=>{
    if(!pointer?.path||!/^[0-9a-f]{64}$/.test(String(pointer.sha256??'')))
      return{value:null,ref:null,limitation:{kind,type:'RAW_TRACE_POINTER_INVALID'}};
    const shell=await optional(pointer.path,kind+'_MANIFEST');
    if(shell.limitation)return shell;
    if(shell.ref.sha256!==pointer.sha256||
       shell.value?.schemaVersion!=='mi-phase0-raw-call-trace-manifest-v1'||
       shell.value?.kind!==kind||
       shell.value?.allPartsPresentAndVerified!==true||
       shell.value?.publicationStatus!=='COMPLETE_LOCAL_VERIFIED')
      return{value:null,ref:shell.ref,
        limitation:{kind,type:'RAW_TRACE_MANIFEST_IDENTITY_OR_COMPLETENESS_INVALID'}};
    const manifest=shell.value;
    const all=[];
    let nextByte=0;
    for(const [index,part] of (manifest.parts??[]).entries()){
      if(!part||part.ordinal!==index+1||part.startByte!==nextByte||
         !/^[a-f0-9]{64}$/.test(String(part.sha256??'')))
        return{value:null,ref:shell.ref,limitation:{kind,type:'RAW_TRACE_PART_ORDER_INVALID'}};
      const target=path.resolve(forkRunRoot,...String(part.path??'').split('/'));
      if(!target.startsWith(forkRunRoot+path.sep))
        return{value:null,ref:shell.ref,limitation:{kind,type:'RAW_TRACE_PART_PATH_ESCAPE'}};
      let data;
      try{
        const stat=await fs.lstat(target);
        if(!stat.isFile()||stat.isSymbolicLink())throw new Error('NOT_REGULAR_FILE');
        data=await fs.readFile(target);
      }catch(error){
        return{value:null,ref:shell.ref,
          limitation:{kind,type:'RAW_TRACE_PART_UNAVAILABLE',partOrdinal:index+1}};
      }
      if(data.length!==part.byteLength||sha256(data)!==part.sha256)
        return{value:null,ref:shell.ref,
          limitation:{kind,type:'RAW_TRACE_PART_BYTE_DIGEST_MISMATCH',partOrdinal:index+1}};
      all.push(data);
      nextByte+=data.length;
    }
    if(!all.length||nextByte!==manifest.totalRawBytes)
      return{value:null,ref:shell.ref,
        limitation:{kind,type:'RAW_TRACE_PART_BYTE_CENSUS_INCOMPLETE'}};
    const raw=Buffer.concat(all);
    if(sha256(raw)!==manifest.rawSha256||sha256(raw)!==pointer.rawSha256)
      return{value:null,ref:shell.ref,
        limitation:{kind,type:'RAW_TRACE_FULL_BYTE_DIGEST_MISMATCH'}};
    try{return{value:JSON.parse(raw.toString('utf8')),ref:shell.ref,
      rawSha256:manifest.rawSha256,manifest,partsVerified:all.length};}
    catch{return{value:null,ref:shell.ref,limitation:{kind,type:'RAW_TRACE_JSON_REASSEMBLY_FAILED'}};}
  };
  const limitations=[];
  const deploy=await optional('evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','DEPLOYMENT');
  const staticFacts=await optional('evidence/static-analysis/SLITHER_RELATIONAL_FACTS_v1.json','SLITHER');
  const compilerBundle=await optional('evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json','BUILD_BUNDLE');
  const contractIdentityIndex=await optional('evidence/phase0/CONTRACT_IDENTITY_INDEX_v1.json','CONTRACT_IDENTITIES');
  const runtimeIdentityIndex=await optional('evidence/phase0/RUNTIME_ADDRESS_IDENTITY_INDEX_v1.json','RUNTIME_IDENTITIES');
  const methods=await optional('evidence/phase0/ACTIVE_USE_METHOD_INVENTORY_v1.json','ACTIVE_USE');
  const sourceIntelligence=await optional('evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json','SOURCE_INTELLIGENCE');
  for(const x of [deploy,staticFacts,compilerBundle,contractIdentityIndex,runtimeIdentityIndex,methods,sourceIntelligence])if(x.limitation)limitations.push(x.limitation);
  const source={
    campaignId:receipt.campaign.campaignId,
    campaignGenerationId:receipt.campaign.campaignGenerationId,
    sourceArchiveSha256:receipt.source.sha256
  };
  const pinned={chainId:deploy.value?.fork?.chainId??null,
    pinnedForkBlockNumber:deploy.value?.fork?.pinnedHistoricalBlock??null,
    pinnedForkBlockHash:deploy.value?.fork?.pinnedHistoricalHash??null};
  const buildRef=compilerBundle.ref;
  const checkIdentity=(record,label,shaKey=null,shaValue=null)=>{
    if(!record)return;
    if(record.campaignId!==source.campaignId||
      record.campaignGenerationId!==source.campaignGenerationId||
      (record.sourceArchiveSha256??record.source?.archiveSha256)!==source.sourceArchiveSha256)
      throw new Error('GRAPH_'+label+'_FROZEN_SOURCE_GENERATION_MISMATCH');
    if(shaKey&&record[shaKey]!==shaValue)
      throw new Error('GRAPH_'+label+'_BUILD_ARTIFACT_SHA_MISMATCH');
  };
  if(compilerBundle.value){
    if(compilerBundle.value.requestIdentity?.campaignId!==source.campaignId||
       compilerBundle.value.requestIdentity?.campaignGenerationId!==source.campaignGenerationId||
       compilerBundle.value.source?.archiveSha256!==source.sourceArchiveSha256)
      throw new Error('GRAPH_BUILD_BUNDLE_CAMPAIGN_SOURCE_MISMATCH');
    checkIdentity(staticFacts.value,'SLITHER_RELATIONAL','buildBundleSha256',buildRef.sha256);
    checkIdentity(contractIdentityIndex.value,'CONTRACT_IDENTITIES','buildArtifactBundleSha256',buildRef.sha256);
  }
  checkIdentity(runtimeIdentityIndex.value,'RUNTIME_IDENTITIES');
  checkIdentity(methods.value,'METHOD_CENSUS');
  const mkid=(prefix,...ids)=>prefix+sha256(Buffer.from(JSON.stringify([source,...ids]),'utf8')).slice(0,40);
  const nodes=[],edges=[],unknowns=[],candidates=[],slitherJoins=[];
  const seenNode=new Set();
  const addNode=x=>{if(!seenNode.has(x.nodeId)){seenNode.add(x.nodeId);nodes.push(x)}return x.nodeId};
  const addUnknown=(kind,ref,details)=>unknowns.push({
    unknownId:mkid('UNKNOWN-',kind,ref,details),kind,sourceRef:ref,details,
    status:'UNRESOLVED',needsSourceInspection:true});
  const scenario=deploy.value?.deploymentTraceIndex?.scenarioId??null;
  const byRuntime=new Map();
  const compilerByIdentity=new Map((compilerBundle.value?.artifacts??[]).map(a=>[[a.compilationUnitId,a.sourceName,a.contractName].join('::'),a]));
  const compilerUnitSourceHashes=new Map((contractIdentityIndex.value?.sourceFiles??[]).map(row=>[row.compilationUnitId+'::'+row.sourcePath,row.sourceContentSha256]));
  const matched=(deploy.value?.deployedContracts??[]).filter(x=>/^0x[0-9a-f]{40}$/i.test(String(x?.address??'')));
  for(const item of matched){
    const address=item.address.toLowerCase();
    const identityVerified=['EXACT_SOURCE_AND_RUNTIME_MATCH','MATCHED_BUILD_RUNTIME','EXACT_RUNTIME_BYTECODE_MATCH'].includes(item.sourceBinding)&&
      Boolean(item.compilationUnitId&&item.sourceName&&item.contractName);
    if(identityVerified)byRuntime.set(address,item);
    else addUnknown('UNRESOLVED_RUNTIME_SOURCE_IDENTITY',deploy.ref?.path??null,
      {address,declaredSourceBinding:item.sourceBinding??null});
    addNode({nodeId:mkid('NODE-RUNTIME-',scenario,address),kind:'RUNTIME_ADDRESS',
      scenarioId:scenario,address,sourceIdentity:identityVerified?{
        compilationUnitId:item.compilationUnitId,sourceName:item.sourceName,contractName:item.contractName}:null,
      bindingStatus:identityVerified?'EXACT_RUNTIME_AND_COMPILATION_MATCH':'UNRESOLVED',
      evidenceRefs:deploy.ref?[deploy.ref]:[]});
  }
  const indexRef=deploy.value?.deploymentTraceIndex?.manifestRef;
  const rawIndex=indexRef?await optional(indexRef,'TRACE_INDEX'):{value:null,ref:null};
  if(rawIndex.value&&rawIndex.ref?.sha256!==deploy.value?.deploymentTraceIndex?.manifestSha256)
    throw new Error('GRAPH_TRANSACTION_TRACE_INDEX_SHA_MISMATCH');
  if(rawIndex.limitation)limitations.push(rawIndex.limitation);
  const normalizeVerifiedCallFrames=({callTrace,traceIdentity,txHash})=>{
    const normalized=[],validAddress=x=>/^0x[0-9a-f]{40}$/.test(String(x??'').toLowerCase());
    const visit=(raw,framePath,parentFrameId,parentStorageAddress=null,ancestorReverted=false)=>{
      if(!raw||typeof raw!=='object'){
        throw new Error('GRAPH_RAW_CALL_TRACER_FRAME_NOT_OBJECT');
      }
      const frameId='FRAME-'+sha256(Buffer.from(JSON.stringify({
        scenarioIdentity:traceIdentity,transactionHash:txHash,framePath
      }),'utf8')).slice(0,40);
      const kind=String(raw.type??'UNKNOWN').toUpperCase(),
        from=String(raw.from??'').toLowerCase(),to=String(raw.to??'').toLowerCase(),
        isDelegate=kind==='DELEGATECALL'||kind==='CALLCODE';
      const storageContextAddress=isDelegate?
        (validAddress(parentStorageAddress)?parentStorageAddress:null):
        (validAddress(to)?to:null);
      const input=typeof raw.input==='string'?raw.input:null;
      const ownReverted=Boolean(raw.error);
      normalized.push({frameId,parentFrameId,framePath,callType:kind,
        from:validAddress(from)?from:null,to:validAddress(to)?to:null,
        runtimeCodeAddress:validAddress(to)?to:null,storageContextAddress,
        inputSelector:input&&/^0x[0-9a-fA-F]{8}/.test(input)?input.slice(0,10).toLowerCase():null,
        inputSha256:input?sha256(Buffer.from(input,'utf8')):null,
        error:raw.error??null,reverted:ownReverted,revertedInAncestor:ancestorReverted,
        effectiveReverted:ownReverted||ancestorReverted});
      if(raw.calls!==undefined&&!Array.isArray(raw.calls))
        throw new Error('GRAPH_RAW_CALL_TRACER_CHILD_ARRAY_INVALID');
      for(const [idx,child] of (raw.calls??[]).entries())
        visit(child,framePath+'/'+idx,frameId,storageContextAddress,
          ancestorReverted||ownReverted);
    };
    visit(callTrace,'0',null);
    return normalized;
  };
  const actualTrace=rawIndex.value;
  if(actualTrace){
    if(actualTrace.sourceIdentity?.sourceArchiveSha256!==source.sourceArchiveSha256||
      actualTrace.sourceIdentity?.campaignGenerationId!==source.campaignGenerationId)
      throw new Error('GRAPH_TRACE_SOURCE_GENERATION_JOIN_MISMATCH');
    if(actualTrace.scenarioId!==scenario)throw new Error('GRAPH_SCENARIO_ID_MISMATCH');
    for(const row of actualTrace.rows??[]){
      const pathToTrace=row.evidence?.find(x=>x.kind==='CALL_TRACE');
      if(!pathToTrace){addUnknown('CALL_TRACE_MISSING',rawIndex.ref?.path??null,{txHash:row.transactionHash});continue}
      const expected=pathToTrace.sha256;
      const observed=await readCompleteCapturedRpcJsonV1(pathToTrace,'CALL_TRACE');
      if(observed.limitation||observed.ref?.sha256!==expected){
        limitations.push({type:'CALL_TRACE_SHA_MISSING_OR_MISMATCH',txHash:row.transactionHash,
          expectedSha256:expected,actualSha256:observed.ref?.sha256??null});
        continue;
      }
      const rawFrames=normalizeVerifiedCallFrames({
        callTrace:observed.value,traceIdentity:actualTrace.sourceIdentity,
        txHash:row.transactionHash
      });
      const recordedFrames=row.mechanicalCallFrames??[];
      const fields=['frameId','parentFrameId','framePath','callType','from','to',
        'runtimeCodeAddress','storageContextAddress','inputSelector',
        'inputSha256','reverted','revertedInAncestor','effectiveReverted'];
      const frameMismatch=rawFrames.length!==recordedFrames.length||
        rawFrames.some((frame,index)=>fields.some(field=>
          (frame[field]??null)!==(recordedFrames[index]?.[field]??null)));
      if(frameMismatch){
        limitations.push({type:'NORMALIZED_FRAMES_DIVERGE_FROM_VERIFIED_RAW_TRACE',
          transactionHash:row.transactionHash,
          rawFrameCount:rawFrames.length,indexFrameCount:recordedFrames.length});
      }
      const verifiedFrames=rawFrames; // the authoritative raw trace, never the unverified derivative
      const txid=addNode({nodeId:mkid('NODE-TX-',scenario,row.transactionHash),
        kind:'MINED_TRANSACTION',scenarioId:scenario,transactionHash:row.transactionHash,
        blockNumber:row.blockNumber,evidenceRefs:[rawIndex.ref,pathToTrace].filter(Boolean)});
      // A receipt event is an observed emitted log, not a source-level ABI match.
      const receiptPointer=row.evidence?.find(x=>x.kind==='MINED_RECEIPT');
      const receiptEvidence=receiptPointer?await readCompleteCapturedRpcJsonV1(receiptPointer,'MINED_RECEIPT'):null;
      const receiptChecked=receiptEvidence?.ref?.sha256===receiptPointer?.sha256;
      if(receiptPointer&&!receiptChecked)limitations.push({type:'RECEIPT_CONTENT_DIGEST_UNVERIFIED',
        transactionHash:row.transactionHash,sourceRef:receiptPointer.path});
      const receiptStatus=receiptChecked?receiptEvidence.value?.status:null;
      const transactionSucceeded=receiptStatus===1||receiptStatus==='0x1'||receiptStatus==='0x01';
      if(receiptChecked){
        for(const [eventOrdinal,log] of (receiptEvidence.value.logs??[]).entries()){
          const emitter=String(log.address??'').toLowerCase();
          const eventId=addNode({nodeId:mkid('NODE-OBSERVED-EVENT-',scenario,row.transactionHash,eventOrdinal),
            kind:'OBSERVED_EVENT_LOG',scenarioId:scenario,transactionHash:row.transactionHash,
            logOrdinal:eventOrdinal,emitterAddress:emitter,
            topic0:log.topics?.[0]??null,
            observedTopics:(log.topics??[]).filter(topic=>/^0x[a-f0-9]{64}$/i.test(String(topic))),
            dataSha256:sha256(Buffer.from(String(log.data??''),'utf8')),
            eventSourceIdentity:null,eventDecodeStatus:'ABI_EVENT_JOIN_NOT_PROVEN',
            evidenceRefs:[receiptEvidence.ref]});
          edges.push({edgeId:mkid('EDGE-OBSERVED-EMISSION-',scenario,row.transactionHash,eventOrdinal),
            kind:'OBSERVED_TRANSACTION_EMITTED_LOG',from:txid,to:eventId,
            observation:'OBSERVED_LOCAL_FORK',evidenceRefs:[receiptEvidence.ref]});
        }
      }
      const statePointer=row.evidence?.find(x=>x.kind==='PRESTATE_DIFF');
      const stateEvidence=statePointer?await readCompleteCapturedRpcJsonV1(statePointer,'PRESTATE_DIFF'):null;
      if(statePointer&&stateEvidence?.ref?.sha256!==statePointer.sha256){
        limitations.push({type:'PRESTATE_DIFF_CONTENT_DIGEST_UNVERIFIED',
          transactionHash:row.transactionHash,sourceRef:statePointer.path});
      }else if(stateEvidence?.value&&transactionSucceeded){
        const beforeState=stateEvidence.value.pre??{};
        const afterState=stateEvidence.value.post??{};
        for(const address of [...new Set([...Object.keys(beforeState),...Object.keys(afterState)])].sort()){
          const pre=beforeState[address]??{},post=afterState[address]??{};
          const oldStorage=pre.storage??{},newStorage=post.storage??{};
          for(const slot of [...new Set([...Object.keys(oldStorage),...Object.keys(newStorage)])].sort()){
            const before=oldStorage[slot]??null,after=newStorage[slot]??null;
            if(before===after)continue;
            const slotId=addNode({nodeId:mkid('NODE-SLOT-',scenario,address,slot),
              kind:'OBSERVED_STORAGE_SLOT',scenarioId:scenario,address:address.toLowerCase(),slot,
              sourceVariableIdentity:null,bindingStatus:'STORAGE_SLOT_SOURCE_UNKNOWN',
              evidenceRefs:[stateEvidence.ref]});
            edges.push({edgeId:mkid('EDGE-STORAGE-MUTATION-',scenario,row.transactionHash,address,slot),
              kind:'OBSERVED_SUCCESSFUL_TX_STORAGE_CHANGE',from:txid,to:slotId,
              oldValueSha256:before===null?null:sha256(Buffer.from(String(before))),
              newValueSha256:after===null?null:sha256(Buffer.from(String(after))),
              stateDisposition:'TRANSACTION_RECEIPT_SUCCESS',
              observation:'OBSERVED_LOCAL_FORK',evidenceRefs:[stateEvidence.ref,receiptEvidence.ref]});
          }
        }
      }
      for(const frame of verifiedFrames){
        const frameid=addNode({nodeId:frame.frameId,kind:'EVM_CALL_FRAME',
          scenarioId:scenario,transactionHash:row.transactionHash,
          callType:frame.callType,framePath:frame.framePath,reverted:Boolean(frame.error),
          inputSelector:frame.inputSelector,evidenceRefs:[pathToTrace]});
        const from=frame.from?.toLowerCase()??null,to=frame.to?.toLowerCase()??null;
        edges.push({edgeId:mkid('EDGE-TX-FRAME-',row.transactionHash,frame.frameId),
          kind:'TRANSACTION_CONTAINS_FRAME',from:txid,to:frameid,
          observation:'OBSERVED_LOCAL_FORK',evidenceRefs:[pathToTrace]});
        if(frame.parentFrameId)edges.push({edgeId:mkid('EDGE-FRAME-PARENT-',frame.frameId),
          kind:'FRAME_CHILD_OF',from:frame.parentFrameId,to:frameid,
          observation:'OBSERVED_LOCAL_FORK',evidenceRefs:[pathToTrace]});
        for(const address of [from,to]){
          if(!address||!/^0x[0-9a-f]{40}$/.test(address))continue;
          addNode({nodeId:mkid('NODE-RUNTIME-',scenario,address),kind:'RUNTIME_ADDRESS',
            scenarioId:scenario,address,sourceIdentity:byRuntime.get(address)??null,
            bindingStatus:byRuntime.has(address)?'EXACT_RUNTIME_AND_COMPILATION_MATCH':'UNRESOLVED',
            evidenceRefs:[pathToTrace]});
        }
        if(from&&to){
          const kind=String(frame.callType??'CALL').toUpperCase();
          const edgeId=mkid('EDGE-OBSERVED-',row.transactionHash,frame.framePath,kind,from,to);
          edges.push({edgeId,kind:'OBSERVED_'+kind,scenarioId:scenario,
            from:mkid('NODE-RUNTIME-',scenario,from),to:mkid('NODE-RUNTIME-',scenario,to),
            originatingFrameId:frame.frameId,transactionHash:row.transactionHash,
            reverted:Boolean(frame.error),inputSelector:frame.inputSelector,
            storageContextResolution:kind==='DELEGATECALL'?'CALLER_STORAGE_CONTEXT_UNVERIFIED':'NOT_APPLICABLE',
            runtimeCodeIdentityStatus:byRuntime.has(to)?'VERIFIED_COMPILED_MATCH':'UNKNOWN',
            observation:'OBSERVED_LOCAL_FORK',evidenceRefs:[pathToTrace]});
          const policyType=kind==='DELEGATECALL'?'DELEGATECALL_STORAGE_CONTEXT':
            kind==='CALL'&&from!==to?'CROSS_CONTRACT_CALL':
            kind==='CREATE'||kind==='CREATE2'?'CONTRACT_CREATION':
            null;
          if(policyType){
            candidates.push({candidateId:mkid('GRAPH-CAND-',edgeId,policyType),
              patternType:policyType,sourceGraphEdgeIds:[edgeId],scenarioId:scenario,
              chainId:pinned.chainId,pinnedForkBlockHash:pinned.pinnedForkBlockHash,
              sourceArchiveSha256:source.sourceArchiveSha256,
              evidenceStatus:'OBSERVED',securityVerdict:null,
              decidingEvidenceNeeded:byRuntime.has(to)?[]:['EXACT_TARGET_SOURCE_IDENTITY'],
              status:'POSSIBLE_INVESTIGATION_NOT_CONFIRMED',evidenceRefs:[pathToTrace]});
          }
          if(!byRuntime.has(to))addUnknown('CALL_TARGET_SOURCE_UNBOUND',pathToTrace.path,
            {frameId:frame.frameId,address:to,selector:frame.inputSelector});
        }
      }
    }
  }else addUnknown('TRACE_INDEX_UNAVAILABLE',deploy.ref?.path??null,{scenarioId:scenario});
  const units=staticFacts.value?.sourceUnitRecords??[];
  for(const unit of units){
    for(const contract of unit.contracts??[]){
      for(const f of contract.functions??[]){
        const functionId=addNode({nodeId:mkid('NODE-FUNCTION-',unit.unitId,contract.contractName,f.soliditySignature??f.name),
          kind:'SOURCE_FUNCTION',compilationUnitId:unit.unitId,contractName:contract.contractName,
          signature:f.soliditySignature??f.name,sourceSpan:f.sourceSpan,
          evidenceRefs:staticFacts.ref?[staticFacts.ref]:[]});
        const sourceFile=String(f.sourceSpan?.file??'').replaceAll('\\','/');
        const verifiedMethodBindings=(methods.value?.methodCandidates??[]).filter(method=>
          method.compilationUnitId===unit.unitId&&
          method.contractName===contract.contractName&&
          method.signature===(f.soliditySignature??f.name)&&
          method.runtimeAddress&&
          byRuntime.get(method.runtimeAddress.toLowerCase())?.compilationUnitId===unit.unitId&&
          byRuntime.get(method.runtimeAddress.toLowerCase())?.sourceName===method.sourceName&&
          (sourceFile===method.sourceName||sourceFile.endsWith('/'+method.sourceName)));
        for(const binding of verifiedMethodBindings){
          const address=binding.runtimeAddress.toLowerCase();
          const targetId=mkid('NODE-RUNTIME-',scenario,address);
          const refSet=[staticFacts.ref,methods.ref,deploy.ref].filter(Boolean);
          const joinId=mkid('SLIT-JOIN-',functionId,address,binding.signature);
          slitherJoins.push({joinId,sourceFunctionId:functionId,runtimeAddress:address,
            compilationUnitId:unit.unitId,sourceName:binding.sourceName,
            canonicalSignature:binding.signature,selector:binding.selector,
            status:'COMPILER_SOURCE_AND_BYTE_EXACT_RUNTIME_BOUND',
            observationClass:'STATIC_SOURCE_FUNCTION_JOIN_NOT_A_CALL_OBSERVATION',evidenceRefs:refSet});
          edges.push({edgeId:mkid('EDGE-SOURCE-TO-RUNTIME-',joinId),
            kind:'SOURCE_FUNCTION_BOUND_TO_RUNTIME_CODE',from:functionId,to:targetId,
            observation:'EXACT_COMPILATION_AND_RUNTIME_IDENTITY_NOT_CALL_EXECUTION',
            evidenceRefs:refSet});
        }
        for(const [direction,variables] of [['READ',f.readStorageIds],['WRITE',f.writtenStorageIds]]){
          for(const [n,v] of (variables??[]).entries()){
            const varId=addNode({nodeId:mkid('NODE-STATE-VAR-',unit.unitId,contract.contractName,v.name),
              kind:'STATIC_STORAGE_VARIABLE',compilationUnitId:unit.unitId,contractName:contract.contractName,
              variableName:v.name,sourceSpan:v.sourceSpan,evidenceRefs:staticFacts.ref?[staticFacts.ref]:[]});
            edges.push({edgeId:mkid('EDGE-SLITHER-VAR-',functionId,varId,direction,n),
              kind:'SLITHER_FUNCTION_'+direction+'S_VARIABLE',from:functionId,to:varId,
              observation:'SOURCE_STATIC_NOT_RUNTIME',evidenceRefs:staticFacts.ref?[staticFacts.ref]:[]});
          }
        }
        for(const [n,call] of (f.callSites??[]).entries()){
          edges.push({edgeId:mkid('EDGE-SLITHER-CALL-',functionId,n,call.ir),
            kind:'SLITHER_STATIC_CALLSITE',from:functionId,to:null,
            callKind:call.kind,calleeSignature:call.calleeSignature??null,
            sourceSpan:call.sourceSpan,observation:'SOURCE_STATIC_NOT_RUNTIME',
            evidenceRefs:staticFacts.ref?[staticFacts.ref]:[]});
        }
        for(const [n,dep] of (f.variableDependencies??[]).entries()){
          edges.push({edgeId:mkid('EDGE-SLITHER-DATA-',functionId,n,dep.written?.name,dep.dependsOn?.name),
            kind:'SLITHER_STATIC_DATA_DEPENDENCY',from:functionId,to:null,
            written:dep.written,dependsOn:dep.dependsOn,observation:'SOURCE_STATIC_NOT_RUNTIME',
            evidenceRefs:staticFacts.ref?[staticFacts.ref]:[]});
        }
        if((f.limitations??[]).length)addUnknown('SLITHER_FUNCTION_LIMITATIONS',staticFacts.ref?.path??null,
          {functionId,limitations:f.limitations});
      }
    }
  }
  if(!units.length)addUnknown('SLITHER_RELATIONSHIP_ANALYSIS_NOT_PROVEN',
    staticFacts.ref?.path??null,{reason:'NO_AVAILABLE_PER_UNIT_SLITHER_RECORDS'});
  const sorted=arr=>arr.sort((a,b)=>String(a.edgeId??a.nodeId??a.unknownId??a.candidateId)
    .localeCompare(String(b.edgeId??b.nodeId??b.unknownId??b.candidateId)));
  for(const a of [nodes,edges,unknowns,candidates])sorted(a);
  const writeOutput=async(relative,value)=>{
    const target=path.join(forkRunRoot,...relative.split('/'));
    await fs.mkdir(path.dirname(target),{recursive:true});
    const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
    await fs.writeFile(target,bytes,{flag:'wx'});
    const observed=await fs.readFile(target);
    if(observed.length!==bytes.length||sha256(observed)!==sha256(bytes))
      throw new Error('FORK_GRAPH_WRITER_IMMUTABLE_READBACK_SHA_MISMATCH: '+relative);
    const ref={path:relative,sha256:sha256(bytes)};
    files.push({path:relative,sha256:ref.sha256,bytes:bytes.length});
    return ref;
  };
  // Graph evidence pages are emitted before the immutable root index that
  // references them. No page can point back to the future root hash.
  const writePagedRecordsV1=async({collection,records,rootDir})=>{
    const pageRefs=[],targetBytes=720*1024;
    let current=[],size=0,startOrdinal=0;
    const flush=async()=>{
      if(!current.length)return;
      const ordinal=pageRefs.length;
      const rel=path.posix.join(rootDir,collection+'-'+String(ordinal+1).padStart(6,'0')+'.json');
      const payload={schemaVersion:'mi-phase0-evidence-page-v1',
        ...source,collection,pageOrdinal:ordinal,
        firstRecordOrdinal:startOrdinal,recordCount:current.length,
        records:current};
      const ref=await writeOutput(rel,payload);
      pageRefs.push({...ref,collection,pageOrdinal:ordinal,
        firstRecordOrdinal:startOrdinal,recordCount:current.length});
      startOrdinal+=current.length;
      current=[];size=0;
    };
    for(const row of records){
      const bytes=Buffer.byteLength(JSON.stringify(row),'utf8');
      // Never drop an oversized original record to fit a target page size.
      if(current.length&&size+bytes>targetBytes)await flush();
      current.push(row);size+=bytes;
    }
    await flush();
    if(startOrdinal!==records.length)
      throw new Error('FORK_PAGED_EVIDENCE_ORIGINAL_RECORD_CENSUS_INCOMPLETE');
    return{collection,totalRecords:startOrdinal,pageCount:pageRefs.length,
      pages:pageRefs,complete:true,
      oversizedRecordPolicy:'PRESERVE_FULL_RECORD_IN_OWN_PAGE'};
  };
  const graphPages={
    nodes:await writePagedRecordsV1({collection:'nodes',records:nodes,
      rootDir:'evidence/phase0/graph-pages'}),
    edges:await writePagedRecordsV1({collection:'edges',records:edges,
      rootDir:'evidence/phase0/graph-pages'}),
    unknowns:await writePagedRecordsV1({collection:'unknowns',records:unknowns,
      rootDir:'evidence/phase0/graph-pages'})
  };
  const graph={schemaVersion:'mi-phase0-intercontract-relationship-graph-index-v1',
    graphStatus:limitations.length||unknowns.length?'INCOMPLETE_WITH_TYPED_UNKNOWNS':'SOURCE_BOUND_PARTIAL_COVERAGE',
    controllerAcceptance:false,...source,pinnedSource:pinned,
    sourceRefs:[deploy.ref,rawIndex.ref,compilerBundle.ref,contractIdentityIndex.ref,
      runtimeIdentityIndex.ref,staticFacts.ref,methods.ref,sourceIntelligence.ref].filter(Boolean),
    counts:{nodes:nodes.length,edges:edges.length,unknowns:unknowns.length,
      observedRuntimeEdges:edges.filter(x=>x.observation==='OBSERVED_LOCAL_FORK').length,
      staticRelationships:edges.filter(x=>x.observation==='SOURCE_STATIC_NOT_RUNTIME').length},
    nodes:[],edges:[],unknowns:[],
    pageCatalog:graphPages,
    recordStorageMode:'COMPLETE_SHA_VERIFIED_PAGES',
    limitations,
    coverageLimitations:['NO_VERIFIED_STORAGE_SLOT_TO_SOURCE_VARIABLE_OR_EVENT_ABI_JOIN','NO_PHASE1_ACCEPTANCE',
      'NO_PHASE6_PREFILL','NO_COMPLETE_SCENARIO_CENSUS',
      'ACTIVE_USE_METHOD_EXECUTION_NOT_IMPLEMENTED']};
  const graphRef=await writeOutput('evidence/phase0/INTERCONTRACT_RELATIONSHIP_GRAPH_INDEX_v1.json',graph);
  const slitherRef=await writeOutput('evidence/phase0/GRAPH_SLITHER_RELATIONSHIP_ANALYSIS_v1.json',{
    schemaVersion:'mi-phase0-graph-slither-relationship-analysis-v1',
    ...source,sourceGraphIndexRef:graphRef,slitherInputRef:staticFacts.ref,staticUnitCount:units.length,
    staticEdgeCount:edges.filter(x=>x.observation==='SOURCE_STATIC_NOT_RUNTIME').length,
    runtimeJoinStatus:slitherJoins.length?'PARTIALLY_SOURCE_RUNTIME_BOUND':'NOT_PROVEN',runtimeJoinRecords:slitherJoins,
    limitations:staticFacts.value?.unavailableUnitRecords??[]});
  // Step 8: evaluate every graph occurrence, never an arbitrary top-N excerpt.
  // These are source-bound investigation prompts, not vulnerability verdicts.
  const candidatePatternsV1={
    CROSS_CONTRACT_REENTRY_PATH:{
      question:'Could an intermediate external callback violate a state invariant or bypass an established guard?',
      families:['REENTRY_CALLBACK_SEQUENCE','STATE_ORDER_SENSITIVITY']},
    SHARED_ACCOUNTING_BOUNDARY:{
      question:'Can assets, liabilities, shares, fees, or rounding diverge across these accounting participants?',
      families:['CROSS_CONTRACT_ACCOUNTING','ROUNDING_AMPLIFICATION']},
    ACTUAL_ALLOWANCE_OR_PRIVILEGE_EDGE:{
      question:'Could the witnessed authority or allowance cross its expected asset or role boundary?',
      families:['ALLOWANCE_BOUNDARY','ROLE_ESCALATION_SEQUENCE']},
    PROXY_CODE_STORAGE_SPLIT:{
      question:'Do initializer, upgrade authority, and storage-layout assumptions hold across code and execution contexts?',
      families:['PROXY_INITIALIZATION','UPGRADE_STORAGE_INTERACTION']},
    RUNTIME_CALLEE_NOT_STATIC_MATCH:{
      question:'What exact runtime code and trust boundary did this call invoke?',
      families:['DYNAMIC_EXTERNAL_TARGET']},
    ORACLE_TO_VALUE_ACTION:{
      question:'Could source-confirmed price dependence alter the value transition through staleness, rounding or manipulation?',
      families:['ORACLE_DEPENDENCY','PRICE_BOUNDARY']},
    ORDER_DEPENDENT_MULTICONTRACT_STATE:{
      question:'Could ordering these witnessed storage changes leave an exploitable intermediate state?',
      families:['SEQUENCE_PERMUTATION','INTERMEDIATE_STATE_INVARIANT']},
    UNEXPECTED_REVERT_OR_FAILURE_PROPAGATION:{
      question:'Does the witnessed failure propagate or leave inconsistent state in the source-defined flow?',
      families:['FAILURE_PROPAGATION']},
    DYNAMIC_FACTORY_CHILD:{
      question:'Does this witnessed child creation inherit correct initialization, access controls and asset ownership?',
      families:['FACTORY_CHILD_INITIALIZATION']},
    EXTERNAL_HOOK_OR_CALLBACK:{
      question:'Are callback caller authorization, reentry and failure assumptions satisfied at this interface?',
      families:['HOOK_AUTHORIZATION','CALLBACK_SEQUENCE']},
    TIME_OR_STATE_GATE:{
      question:'Do source-proven time or threshold conditions create unexpected asset-transition states?',
      families:['TIME_BOUNDARY','STATE_THRESHOLD']},
    CROSS_CHAIN_OR_AUTOMATION_DEPENDENCY:{
      question:'Which assumptions about a remote endpoint, keeper, bridge or asynchronous message remain unverified?',
      families:['EXTERNAL_MESSAGE_ASSUME','KEEPER_BOUNDARY']}
  };
  const patternRulesSha256=sha256(Buffer.from(JSON.stringify({
    implementation:'MI_PHASE0_GRAPH_PATTERN_RULES_V1',
    rules:Object.entries(candidatePatternsV1).sort(([a],[b])=>a.localeCompare(b))
  }), 'utf8'));
  const patternImplementationSha256=sha256(await fs.readFile(fileURLToPath(import.meta.url)));
  // Existing deploy-candidate observations are retired in favor of graph-root
  // occurrence IDs; the graph root is written before any addendum candidate.
  candidates.length=0;
  const subjectDisposition=[];
  const candidateLookup=new Map();
  const addGraphCandidate=(patternFamily,edge,{evidenceClass,prerequisites=[],sourceFunctionIds=[],runtimeInstanceIds=[]}={})=>{
    if(!candidatePatternsV1[patternFamily])throw new Error('GRAPH_PATTERN_UNREGISTERED');
    const graphOccurrenceIds=[edge.edgeId];
    const base=[source.campaignGenerationId,source.sourceArchiveSha256,pinned.chainId,
      pinned.pinnedForkBlockNumber,pinned.pinnedForkBlockHash,
      edge.scenarioId??null,edge.transactionHash??null,edge.originatingFrameId??null,
      edge.edgeId,patternFamily,'v1',edge.inputSelector??null,
      ...sourceFunctionIds,...runtimeInstanceIds];
    const graphCandidateId='GRAPH-CAND-'+sha256(Buffer.from(JSON.stringify(base))).slice(0,40);
    const candidate={
      graphCandidateId,candidateId:graphCandidateId,patternFamily,patternType:patternFamily,
      patternVersion:'v1',
      candidateEvidenceClass:evidenceClass??'UNRESOLVED',
      exactGraphOccurrenceIds:graphOccurrenceIds,
      sourceGraphEdgeIds:graphOccurrenceIds,
      sourceFunctionIds,participatingRuntimeInstanceIds:runtimeInstanceIds,
      sourceEvidenceRefs:edge.evidenceRefs??[],
      investigationQuestion:candidatePatternsV1[patternFamily].question,
      suggestedTestFamilies:candidatePatternsV1[patternFamily].families,
      taxonomyClassId:null,classificationStatus:'NEEDS_MIMO_CLASSIFICATION',
      unresolvedPrerequisites:[...new Set(prerequisites)].sort(),
      duplicateGroupId:null,
      scenarioId:edge.scenarioId??null,chainId:pinned.chainId,
      pinnedForkBlockHash:pinned.pinnedForkBlockHash,
      sourceArchiveSha256:source.sourceArchiveSha256,
      status:'POSSIBLE_INVESTIGATION_NOT_CONFIRMED',
      decidingEvidenceNeeded:prerequisites,securityVerdict:null,
      evidenceRefs:edge.evidenceRefs??[],
      evidenceStatus:evidenceClass??'UNRESOLVED'
    };
    candidates.push(candidate);
    const found=candidateLookup.get(edge.edgeId)??[];
    found.push(graphCandidateId);
    candidateLookup.set(edge.edgeId,found);
  };
  const runtimeCall=k=>/^OBSERVED_(?:CALL|STATICCALL|DELEGATECALL|CALLCODE)$/.test(String(k??''));
  const graphByTx=new Map();
  for(const edge of edges){
    if(!edge.transactionHash)continue;
    const rows=graphByTx.get(edge.transactionHash)??[];
    rows.push(edge);graphByTx.set(edge.transactionHash,rows);
  }
  for(const edge of edges){
    const kind=String(edge.kind??'');
    const isRuntime=edge.observation==='OBSERVED_LOCAL_FORK';
    const evidenceClass=kind==='OBSERVED_SUCCESSFUL_TX_STORAGE_CHANGE'?'STATE_EFFECT_WITNESSED':
      isRuntime?'RUNTIME_WITNESSED':
      edge.observation==='SOURCE_STATIC_NOT_RUNTIME'?'STATIC_POSSIBILITY':'UNRESOLVED';
    const runtimeParticipants=[edge.from,edge.to].filter(Boolean);
    const sourceFunctionIds=kind.startsWith('SLITHER_')?[edge.from].filter(Boolean):[];
    const options={evidenceClass,sourceFunctionIds,runtimeInstanceIds:runtimeParticipants};
    if(runtimeCall(kind)&&edge.from!==edge.to){
      addGraphCandidate('CROSS_CONTRACT_REENTRY_PATH',edge,{
        ...options,prerequisites:['CONFIRM_CALLBACK_REACHABILITY','CONFIRM_SOURCE_STATE_WRITE_ORDER']});
    }
    if(kind==='OBSERVED_DELEGATECALL'||kind==='OBSERVED_CALLCODE'){
      addGraphCandidate('PROXY_CODE_STORAGE_SPLIT',edge,{
        ...options,prerequisites:['CONFIRM_PROXY_STORAGE_ADDRESS','VERIFY_INITIALIZATION_AND_ADMIN_SOURCE']});
    }
    if(runtimeCall(kind)&&edge.runtimeCodeIdentityStatus!=='VERIFIED_COMPILED_MATCH'){
      addGraphCandidate('RUNTIME_CALLEE_NOT_STATIC_MATCH',edge,{
        ...options,evidenceClass:'UNRESOLVED',
        prerequisites:['EXACT_CALL_TARGET_RUNTIME_CODE_AND_COMPILER_UNIT']});
    }
    if(runtimeCall(kind)&&edge.reverted===true){
      addGraphCandidate('UNEXPECTED_REVERT_OR_FAILURE_PROPAGATION',edge,{
        ...options,prerequisites:['SOURCE_DEFINED_EXPECTED_FAILURE_HANDLING']});
    }
    if(kind==='OBSERVED_CREATE'||kind==='OBSERVED_CREATE2'){
      addGraphCandidate('DYNAMIC_FACTORY_CHILD',edge,{
        ...options,prerequisites:['VERIFY_CHILD_RUNTIME_BYTECODE','VERIFY_INIT_ARGUMENTS_AND_AUTHORITY']});
    }
    if(kind==='OBSERVED_TRANSACTION_EMITTED_LOG'){
      const eventNode=nodes.find(node=>node.nodeId===edge.to&&node.kind==='OBSERVED_EVENT_LOG');
      const topics=eventNode?.observedTopics??[];
      const isApproval=String(eventNode?.topic0??'').toLowerCase()===
        ethersTopicId('Approval(address,address,uint256)').toLowerCase();
      const ownerValid=/^0x[0-9a-f]{64}$/i.test(String(topics[1]??''));
      const spenderValid=/^0x[0-9a-f]{64}$/i.test(String(topics[2]??''));
      const txCalls=graphByTx.get(eventNode?.transactionHash)??[];
      const witnessedAssetMovement=txCalls.some(call=>
        runtimeCall(call.kind)&&['0x23b872dd','0xa9059cbb'].includes(
          String(call.inputSelector??'').toLowerCase()));
      // An Approval event has an actual indexed owner/spender; pairing it with
      // a witnessed asset-moving call permits an investigation lead, not a
      // conclusion that the spender exploited this approval.
      if(isApproval&&ownerValid&&spenderValid&&witnessedAssetMovement){
        addGraphCandidate('ACTUAL_ALLOWANCE_OR_PRIVILEGE_EDGE',edge,{
          evidenceClass:'RUNTIME_WITNESSED',runtimeInstanceIds:[edge.to],
          prerequisites:['VERIFY_APPROVAL_EMITTER_TOKEN_IDENTITY',
            'VERIFY_INDEXED_SPENDER_EXECUTION_AUTHORITY','VERIFY_ASSET_FLOW_CONNECTION']});
      }
    }
    if(kind==='OBSERVED_SUCCESSFUL_TX_STORAGE_CHANGE'){
      const siblingWrites=(graphByTx.get(edge.transactionHash)??[])
        .filter(x=>x.kind==='OBSERVED_SUCCESSFUL_TX_STORAGE_CHANGE');
      const addresses=new Set(siblingWrites.map(x=>nodes.find(n=>n.nodeId===x.to)?.address).filter(Boolean));
      if(addresses.size>1)addGraphCandidate('ORDER_DEPENDENT_MULTICONTRACT_STATE',edge,{
        ...options,prerequisites:['CONFIRM_ASSET_ACTION_PATH','IDENTIFY_RELEVANT_INTERMEDIATE_STATE']});
    }
    if(kind==='SLITHER_STATIC_CALLSITE'){
      const callee=String(edge.calleeSignature??'');
      const functionNode=nodes.find(node=>node.nodeId===edge.from&&node.kind==='SOURCE_FUNCTION');
      const callingSignature=String(functionNode?.signature??'');
      const financialAction=/(?:mint|redeem|withdraw|deposit|borrow|repay|liquidat|swap|settle)/i.test(callingSignature);
      if(/(?:^|[^A-Za-z])(on(?:Token|FlashLoan|Swap|Deposit|Withdraw)|fallback|receive|callback|hook)\b/i.test(callee)){
        addGraphCandidate('EXTERNAL_HOOK_OR_CALLBACK',edge,{
          ...options,prerequisites:['VERIFY_CALLER_RESTRICTIONS','REPRODUCE_AUTHORIZED_CALLBACK_CONTEXT']});
      }
      if(financialAction&&/(?:oracle|latestRoundData|latestAnswer|getPrice|peekPrice|quotePrice|priceFeed)/i.test(callee)){
        addGraphCandidate('ORACLE_TO_VALUE_ACTION',edge,{
          ...options,prerequisites:['PROVE_SOURCE_PRICE_DEPENDENCY_PATH','IDENTIFY_ORACLE_TRUST_AND_STALENESS_POLICY']});
      }
      if(financialAction&&/(?:cooldown|timelock|unlock|deadline|maturity|timestamp|blockTime)/i.test(callee)){
        addGraphCandidate('TIME_OR_STATE_GATE',edge,{
          ...options,prerequisites:['VERIFY_EXACT_TIME_COMPARISON_FROM_SOURCE',
            'VERIFY_SOURCE_DEFINED_BOUNDARY_STATE']});
      }
      if(/(?:bridge|sendMessage|messenger|xDomain|crossChain|remoteOracle|receiveMessage|keeper)/i.test(callee)){
        addGraphCandidate('CROSS_CHAIN_OR_AUTOMATION_DEPENDENCY',edge,{
          ...options,prerequisites:['VERIFY_REMOTE_ENDPOINT_IDENTITY',
            'VERIFY_MESSAGE_AUTHORITY_AND_REPLAY_POLICY']});
      }
    }
    // Storage-variable names are only source-static leads, never evidence that
    // a multi-contract accounting invariant was actually violated.
    if(kind==='SLITHER_FUNCTION_WRITES_VARIABLE'||kind==='SLITHER_FUNCTION_READS_VARIABLE'){
      const targetNode=nodes.find(n=>n.nodeId===edge.to);
      if(targetNode&&/(?:assets?|shares?|liabilit|debts?|balances?|fees?|reserves?)/i.test(String(targetNode.variableName??''))){
        addGraphCandidate('SHARED_ACCOUNTING_BOUNDARY',edge,{
          ...options,prerequisites:['VERIFY_EXTERNAL_ACCOUNTING_PARTICIPANTS',
            'EXACT_VALUE_FLOW_AND_UNIT_SEMANTICS']});
      }
    }
    const linked=candidateLookup.get(edge.edgeId)??[];
    subjectDisposition.push({graphOccurrenceId:edge.edgeId,
      disposition:linked.length?'TRIGGERED_CANDIDATE':
        isRuntime&&edge.runtimeCodeIdentityStatus==='UNKNOWN'?'UNRESOLVED_NEEDS_MIMO':
        'STRUCTURAL_FACT_WITH_NO_CURRENT_PATTERN',
      graphCandidateIds:linked,sourceEvidenceRefs:edge.evidenceRefs??[]});
  }
  candidates.sort((a,b)=>a.graphCandidateId.localeCompare(b.graphCandidateId));
  // Every original graph subject is accounted for, including those that
  // matched no known pattern. This census never deletes or deduplicates an
  // original evidence occurrence based on a shared contract or selector.
  const originalSubjectDispositions=[
    ...subjectDisposition,
    ...nodes.map(node=>({
      graphOccurrenceId:node.nodeId,recordKind:'GRAPH_NODE',
      disposition:'STRUCTURAL_FACT_WITH_NO_CURRENT_PATTERN',
      graphCandidateIds:[],sourceEvidenceRefs:node.evidenceRefs??[]})),
    ...unknowns.map(unknown=>({
      graphOccurrenceId:unknown.unknownId,recordKind:'GRAPH_UNKNOWN',
      disposition:'UNRESOLVED_NEEDS_MIMO',graphCandidateIds:[],
      sourceEvidenceRefs:unknown.sourceRef?[{path:unknown.sourceRef}]:[]})),
    ...(methods.value?.methodCandidates??[]).map((method,index)=>({
      graphOccurrenceId:method.methodCandidateId??mkid('METHOD-STATIC-',index,method.signature),
      recordKind:'ACTIVE_USE_METHOD_CENSUS',
      disposition:method.executionStatus==='NOT_EXECUTED'?
        'UNRESOLVED_NEEDS_MIMO':'STRUCTURAL_FACT_WITH_NO_CURRENT_PATTERN',
      graphCandidateIds:[],sourceEvidenceRefs:methods.ref?[methods.ref]:[]}))
  ];
  const staticOnlyUnmatchedSourceSubjects=subjectDisposition
    .filter(row=>row.disposition==='STRUCTURAL_FACT_WITH_NO_CURRENT_PATTERN')
    .map(row=>({graphOccurrenceId:row.graphOccurrenceId,evidenceRefs:row.sourceEvidenceRefs}));
  const unknownRelationshipRefs=unknowns.map(unknown=>unknown.unknownId);
  const candidateRef=await writeOutput('evidence/phase0/GRAPH_INVESTIGATION_CANDIDATES_v1.json',{
    schemaVersion:'mi-phase0-graph-investigation-candidates-v1',...source,sourceGraphIndexRef:graphRef,
    patternImplementationSha256,patternRulesSha256,graphIndexRef:graphRef,
    candidateCount:candidates.length,candidates,
    subjectDisposition:originalSubjectDispositions,
    staticOnlyUnmatchedSourceSubjects,unknownRelationshipRefs,
    candidateCensus:{inputSubjects:edges.length,generatedOccurrences:candidates.length,
      groupedCandidates:candidates.length,explicitUnknowns:unknowns.length},
    patternCoverage:Object.keys(candidatePatternsV1).sort().map(patternFamily=>({
      patternFamily,producedOccurrences:candidates.filter(c=>c.patternFamily===patternFamily).length,
      implementationStatus:[
        'NO_SOURCE_EVIDENCE_MATCHER_UNIMPLEMENTED'
      ].includes(patternFamily)?'SOURCE_JOIN_NOT_IMPLEMENTED':
      'EXACT_GRAPH_OCCURRENCE_MECHANICAL_RULE',
      negativeSecurityConclusion:false})),
    disposition:'MECHANICAL_CANDIDATES_ONLY_NOT_ACCEPTED'});
  // Family keys are proposals taken from registered pattern definitions;
  // they are never represented as resolved exploit-immunity library test IDs.
  const eligible=candidates.map(c=>({
    eligibilityId:mkid('TEST-ELIG-',c.graphCandidateId),
    sourceGraphCandidateIds:[c.graphCandidateId],
    suggestedTestFamilies:c.suggestedTestFamilies,
    testFamilyKey:c.suggestedTestFamilies?.[0]??null,
    registeredLibraryTestId:null,
    selectionStatus:'POSSIBLY_ELIGIBLE',
    configurationStatus:'REQUIRES_LIBRARY_REGISTRY',
    executionStatus:'NOT_EXECUTED_BY_PHASE0_LIBRARY',
    callPathGraphEdgeIds:c.exactGraphOccurrenceIds,
    missingPrerequisites:c.unresolvedPrerequisites,
    evidenceClass:c.candidateEvidenceClass,
    sourceGraphIndexRef:graphRef,
    candidateIndexRef:candidateRef,
    typedLimitations:['LIBRARY_REGISTRY_NOT_INSPECTED',
      'TEST_CONFIGURATION_NOT_SOURCE_VERIFIED',
      'NO_IMMUNITY_OR_SAFE_VERDICT']}));
  const eligibilityRef=await writeOutput('evidence/phase0/GRAPH_SIMULATION_ELIGIBILITY_v1.json',{
    schemaVersion:'mi-phase0-graph-simulation-eligibility-v1',...source,sourceGraphIndexRef:graphRef,
    libraryRegistry:{status:'NOT_PROVIDED',version:null,sha256:null},
    eligibilityRecords:eligible,unmatchedGraphCandidateIds:[],
    census:{candidateCount:candidates.length,testEligibilityRecordCount:eligible.length,
      configurableNowCount:0,requiresMimoCount:eligible.length,unmatchedCount:0}});
  // Step 8 original Flow Plan bridge: source review, not runtime-name inference.
  // Only an exact source file SHA, unique compilation unit, exact signature
  // and source span may become a prefilled caller context.
  // Configuration handoff reuses the existing library's future selection path.
  // No registry API or executable target recipe is assumed to exist.
  const testConfigurationHandoffRef=await writeOutput(
    'previews/simulation-library/GRAPH_TEST_CONFIGURATION_HANDOFF_v1.json',{
    schemaVersion:'mi-phase0-graph-test-configuration-handoff-v1',
    ...source,graphIndexRef:graphRef,candidateIndexRef:candidateRef,
    eligibilityIndexRef:eligibilityRef,
    registryStatus:'LIBRARY_API_NOT_SOURCE_VERIFIED',
    sourceBoundProposals:eligible.map(record=>({
      eligibilityId:record.eligibilityId,
      candidateIds:record.sourceGraphCandidateIds,
      suggestedTestFamilyKeys:record.suggestedTestFamilies,
      testFamilyKey:record.testFamilyKey,
      registeredLibraryTestId:null,
      sourceGraphEvidenceRefs:[graphRef,candidateRef,eligibilityRef],
      sourceCallPathOccurrenceIds:record.callPathGraphEdgeIds,
      actorConfig:null,assetsConfig:null,amountConfig:null,oracleConfig:null,
      runtimeScenarioConfig:null,sourceConfigurationStatus:'NEEDS_SOURCE_DEFINED_PREREQUISITES',
      selectionStatus:'POSSIBLY_ELIGIBLE',
      executionStatus:'NOT_EXECUTED_BY_PHASE0_LIBRARY',
      immunityClaim:false,securityVerdict:null,
      missingPrerequisites:[
        ...record.missingPrerequisites,
        'VERIFY_REAL_LIBRARY_REGISTRY_AND_TEST_IMPLEMENTATION',
        'IDENTIFY_SOURCE_DEFINED_ACTORS_AND_AMOUNTS',
        'VERIFY_PINNED_RUNTIME_AND_STATE'
      ]
    })),
    proposalCount:eligible.length,configuredCount:0,executedCount:0,
    status:'FORK_PREVIEW_CONFIGURATION_UNRESOLVED_NO_TEST_EXECUTION'
  });
  const reviewInventory=await optional('evidence/review-inventory/REVIEW_INVENTORY_v1.json','REVIEW_INVENTORY');
  const originalFacts=await optional('evidence/review-inventory/SYSTEM_FACTS_v1.json','SYSTEM_FACTS');
  const contractIdentities=await optional('evidence/phase0/CONTRACT_IDENTITY_INDEX_v1.json','CONTRACT_IDENTITIES');
  const graphInvestigationInputs=[],unresolvedFlowPlanSourceJoins=[];
  const reviewReady=reviewInventory.value?.schemaVersion==='curveyield-review-inventory-v1'&&
    originalFacts.value?.schemaVersion==='curveyield-system-facts-v1'&&
    contractIdentities.value?.schemaVersion==='mi-phase0-contract-identity-index-v1'&&
    reviewInventory.value?.payload?.complete===true&&
    Array.isArray(reviewInventory.value?.payload?.contexts)&&
    reviewInventory.value.campaignId===source.campaignId&&
    originalFacts.value.campaignId===source.campaignId&&
    reviewInventory.value.campaignGenerationId===source.campaignGenerationId&&
    originalFacts.value.campaignGenerationId===source.campaignGenerationId&&
    contractIdentities.value.campaignGenerationId===source.campaignGenerationId&&
    reviewInventory.value.sourceSha256===source.sourceArchiveSha256&&
    originalFacts.value.sourceSha256===source.sourceArchiveSha256&&
    contractIdentities.value.sourceArchiveSha256===source.sourceArchiveSha256;
  const graphNodeById=new Map(nodes.map(node=>[node.nodeId,node]));
  const graphEdgeById=new Map(edges.map(edge=>[edge.edgeId,edge]));
  if(reviewReady){
    for(const c of candidates){
      const candidatesSourceFunctions=c.exactGraphOccurrenceIds.flatMap(edgeId=>{
        const edge=graphEdgeById.get(edgeId);
        const node=graphNodeById.get(edge?.from);
        return node?.kind==='SOURCE_FUNCTION'?[node]:[];
      });
      const exactMatches=[];
      for(const node of candidatesSourceFunctions){
        const span=node.sourceSpan??{},sourcePath=String(span.file??'').replaceAll('\\','/');
        const originLine=span.lines?.[0]??null;
        if(!sourcePath||!Number.isInteger(originLine))continue;
        const confirmed=(contractIdentities.value.sourceFiles??[]).filter(file=>
          file.compilationUnitId===node.compilationUnitId&&
          file.sourcePath===sourcePath&&/^[a-f0-9]{64}$/.test(String(file.sourceContentSha256??'')));
        const accepted=(reviewInventory.value.payload.sourceUnits??[]).filter(file=>
          file.path===sourcePath&&confirmed.some(row=>row.sourceContentSha256===file.sha256));
        if(confirmed.length!==1||accepted.length!==1)continue;
        const matchedContexts=reviewInventory.value.payload.contexts.filter(ctx=>
          ['FUNCTION','INHERITED_DEPENDENCY'].includes(ctx.kind)&&
          ['IN_SCOPE','INHERITED_DEPENDENCY'].includes(ctx.scopeTier)&&
          ctx.path===sourcePath&&
          ctx.qualifiedContainer===sourcePath+':'+node.contractName&&
          ctx.canonicalSignature===node.signature&&
          Number.isInteger(ctx.lineStart)&&Number.isInteger(ctx.lineEnd)&&
          originLine>=ctx.lineStart&&originLine<=ctx.lineEnd);
        if(matchedContexts.length===1)exactMatches.push(matchedContexts[0]);
      }
      const bound=[...new Map(exactMatches.map(x=>[x.contextId,x])).values()];
      if(bound.length===1){
        graphInvestigationInputs.push({
          graphCandidateId:c.graphCandidateId,patternFamily:c.patternFamily,
          sourceContextId:bound[0].contextId,
          investigationQuestion:c.investigationQuestion,
          evidenceRefs:[graphRef,...(c.sourceEvidenceRefs??[])].filter(ref=>
            ref?.path&&/^[a-f0-9]{64}$/.test(String(ref.sha256??''))),
          compilerContextProof:{sourcePath:bound[0].path,
            canonicalSignature:bound[0].canonicalSignature,
            originalSourceContextId:bound[0].contextId,
            reviewInventoryRef:reviewInventory.ref,
            contractIdentityIndexRef:contractIdentities.ref}
        });
      }else unresolvedFlowPlanSourceJoins.push({
        graphCandidateId:c.graphCandidateId,disposition:bound.length?
          'MULTIPLE_POTENTIAL_ORIGIN_CONTEXTS':'NO_UNIQUE_EXACT_SOURCE_CONTEXT',
        evidenceRefs:[graphRef,...(c.sourceEvidenceRefs??[])].filter(Boolean)});
    }
  }else{
    unresolvedFlowPlanSourceJoins.push({
      graphCandidateId:null,disposition:'ORIGINAL_SOURCE_REVIEW_INPUTS_MISSING_INCOMPLETE_OR_WRONG_IDENTITY',
      evidenceRefs:[reviewInventory.ref,originalFacts.ref,contractIdentities.ref].filter(Boolean)});
  }
  let graphFlowPlanBridgeV1={status:'UNAVAILABLE_INCOMPLETE_REVIEW_CONTEXTS',
    originalPlanRef:null,bindings:[],unresolved:unresolvedFlowPlanSourceJoins,
    flowPlanQuestionCount:0,assignedAttackUnitQuestions:0,packetIssuedCount:0};
  if(reviewReady){
    const {buildFlowPlanV1}=await import('../packages/github-native-sim/src/adr-flow-plan-v1.mjs');
    const snapshot=await optional('evidence/phase0/DEPLOYED_STATE_SNAPSHOT_v1.json','DEPLOYED_STATE_SNAPSHOT');
    const plan=buildFlowPlanV1({
      inventory:reviewInventory.value,facts:originalFacts.value,
      snapshot:snapshot.value??null,graphInvestigations:graphInvestigationInputs
    });
    const originalPlanRef=await writeOutput('previews/phase-04/FLOW_PLAN_GRAPH_FORK_PREVIEW_v1.json',plan);
    const assigned=new Map((plan.payload?.attackUnits??[]).flatMap(unit=>
      (unit.integrationQuestionIds??[]).map(questionId=>[questionId,unit.unitId])));
    const boundIds=new Set((plan.payload?.graphQuestionBindings??[]).map(x=>x.graphCandidateId));
    for(const item of graphInvestigationInputs){
      if(boundIds.has(item.graphCandidateId))continue;
      unresolvedFlowPlanSourceJoins.push({
        graphCandidateId:item.graphCandidateId,
        disposition:'NO_VALID_EXISTING_FLOW_PLAN_CLUSTER_ASSIGNMENT',
        evidenceRefs:item.evidenceRefs});
    }
    const bindings=(plan.payload?.graphQuestionBindings??[]).map(row=>({
      graphCandidateId:row.graphCandidateId,
      flowPlanQuestionId:row.flowPlanQuestionId,
      sourceContextIds:row.sourceContextIds,
      sourceGraphEvidenceRefs:row.sourceGraphEvidenceRefs,
      assignedAttackUnitId:assigned.get(row.flowPlanQuestionId)??null,
      issuedUnitId:null,packetPath:null,packetSha256:null,
      availabilityStatus:assigned.has(row.flowPlanQuestionId)?
        'FLOW_PLAN_QUESTION_ASSIGNED_NOT_ISSUED':'FLOW_PLAN_QUESTION_NOT_ASSIGNED',
      originalPlanRef
    }));
    graphFlowPlanBridgeV1={
      status:'SOURCE_BOUND_FORK_PREVIEW_NO_PACKET_ISSUED',
      originalPlanRef,bindings,
      unresolved:[...unresolvedFlowPlanSourceJoins,...(plan.payload?.unresolvedGraphInvestigations??[])],
      flowPlanQuestionCount:plan.payload?.integrationQuestions?.length??0,
      graphQuestionCount:bindings.length,assignedAttackUnitQuestions:bindings.filter(x=>x.assignedAttackUnitId).length,
      packetIssuedCount:0
    };
  }
  const flowPlanBridgeRef=await writeOutput('previews/phase-04/GRAPH_DISCOVERY_PACKET_BRIDGE_v1.json',{
    schemaVersion:'mi-phase0-graph-discovery-packet-bridge-v1',
    ...source,graphIndexRef:graphRef,candidateIndexRef:candidateRef,
    evidenceStatus:graphFlowPlanBridgeV1.status,
    originalPlanRef:graphFlowPlanBridgeV1.originalPlanRef,
    bindingRecords:graphFlowPlanBridgeV1.bindings,
    unresolvedSourceJoins:graphFlowPlanBridgeV1.unresolved,
    flowPlanQuestionCount:graphFlowPlanBridgeV1.flowPlanQuestionCount,
    graphQuestionCount:graphFlowPlanBridgeV1.graphQuestionCount??0,
    assignedPacketQuestionCount:0,issuedPacketQuestionCount:0,
    status:'READ_ONLY_FORK_PREVIEW_NOT_ORIGINAL_PACKET_ISSUED'
  });
  const censusRef=await writeOutput('evidence/phase0/GRAPH_TO_AUDIT_SUBJECT_CENSUS_v1.json',{
    schemaVersion:'mi-phase0-graph-to-audit-subject-census-v1',...source,
    graphIndexRef:graphRef,candidateIndexRef:candidateRef,
    ORIGINAL_GRAPH_SUBJECT_COUNT:originalSubjectDispositions.length,
    originalSubjectCensus:{
      graphNodes:nodes.length,graphEdges:edges.length,graphUnknowns:unknowns.length,
      activeUseMethods:methods.value?.methodCandidates?.length??0,
      candidateProposalsSeparate:candidates.length
    },
    sourceGraphSubjectDispositions:originalSubjectDispositions,
    sourceGraphSubjectCensus:{
      total:originalSubjectDispositions.length,
      triggered:originalSubjectDispositions.filter(x=>x.disposition==='TRIGGERED_CANDIDATE').length,
      unresolved:originalSubjectDispositions.filter(x=>x.disposition==='UNRESOLVED_NEEDS_MIMO').length,
      unmatched:originalSubjectDispositions.filter(x=>
        x.disposition==='STRUCTURAL_FACT_WITH_NO_CURRENT_PATTERN').length
    },
    AUTOMATIC_CANDIDATE_OCCURRENCE_COUNT:candidates.length,
    AUTOMATIC_CANDIDATE_GROUP_COUNT:candidates.length,
    FLOW_PLAN_QUESTION_COUNT:graphFlowPlanBridgeV1.flowPlanQuestionCount,
    GRAPH_FLOW_PLAN_QUESTION_COUNT:graphFlowPlanBridgeV1.graphQuestionCount??0,
    ASSIGNED_PACKET_QUESTION_COUNT:0,
    MIMO_PHASE1_QUESTION_COUNT:0,MIMO_PHASE1_ANSWERED_COUNT:0,
    MIMO_NOVEL_CANDIDATE_COUNT:0,TEST_ELIGIBILITY_RECORD_COUNT:eligible.length,
    TEST_CONFIG_EXECUTABLE_COUNT:0,TEST_CONFIG_UNRESOLVED_COUNT:eligible.length,
    UNRESOLVED_GRAPH_SUBJECT_COUNT:originalSubjectDispositions.filter(x=>x.disposition==='UNRESOLVED_NEEDS_MIMO').length,
    UNMAPPED_STATIC_SOURCE_COUNT:units.filter(x=>x.analysisStatus!=='SLITHER_RELATIONAL_FACTS_AVAILABLE').length,
    limitations:['Graph is a source-only, unaccepted fork preview. No question issued.']});
  // Enumerate the complete immutable graph source roster; no "top" sampling.
  // A roster is not a pending MiMo question, nor a new question scheduler.
  const phase1OriginalSubjects=[
    ...nodes.map(row=>({
      recordKind:'GRAPH_NODE',recordId:row.nodeId,
      evidenceRefs:row.evidenceRefs??[],graphSelector:'nodes/'+row.nodeId,
      scenarioId:row.scenarioId??null})),
    ...edges.map(row=>({
      recordKind:'GRAPH_EDGE',recordId:row.edgeId,
      evidenceRefs:row.evidenceRefs??[],graphSelector:'edges/'+row.edgeId,
      scenarioId:row.scenarioId??null})),
    ...unknowns.map(row=>({
      recordKind:'GRAPH_UNKNOWN',recordId:row.unknownId,
      evidenceRefs:row.sourceRef?[{path:row.sourceRef}]:[],
      graphSelector:'unknowns/'+row.unknownId,scenarioId:scenario})),
    ...candidates.map(row=>({
      recordKind:'GRAPH_AUTO_CANDIDATE',recordId:row.graphCandidateId,
      evidenceRefs:row.sourceEvidenceRefs??[],
      graphSelector:'graph-candidates/'+row.graphCandidateId,
      scenarioId:row.scenarioId??null})),
    ...(methods.value?.methodCandidates??[]).map((row,index)=>({
      recordKind:'ACTIVE_USE_METHOD_CENSUS',
      recordId:row.methodCandidateId??mkid('METHOD-STATIC-',index,row.signature),
      evidenceRefs:methods.ref?[methods.ref]:[],
      graphSelector:'active-use-methods/'+index,
      scenarioId:scenario}))
  ];
  const phase1Subjects=phase1OriginalSubjects.map(record=>({
    subjectId:mkid('GRAPH-SUBJECT-',record.recordKind,record.recordId),
    recordKind:record.recordKind,
    subjectGraphOccurrenceIds:[record.recordId],
    sourceGraphIndexRef:graphRef,
    originalSourceSelector:record.graphSelector,
    scenarioRefs:record.scenarioId?[record.scenarioId]:[],
    exactSourceRefs:record.evidenceRefs,
    runtimeTraceRefs:record.recordKind==='GRAPH_EDGE'?
      record.evidenceRefs.filter(ref=>ref?.path?.includes('/scenarios/')):[],
    configurationAndStateRefs:record.recordKind==='ACTIVE_USE_METHOD_CENSUS'?
      [methods.ref].filter(Boolean):[],
    autoGraphCandidateIds:record.recordKind==='GRAPH_EDGE'?
      candidateLookup.get(record.recordId)??[]:
      record.recordKind==='GRAPH_AUTO_CANDIDATE'?[record.recordId]:[],
    questionId:null,questionText:null,
    questionStatus:'PENDING_EXISTING_MIMO_ADAPTER_NOT_ISSUED',
    acceptedResponse:null
  }));
  const rosterPages=await writePagedRecordsV1({collection:'phase1-subjects',
    records:phase1Subjects,rootDir:'previews/phase-01/pages'});
  const preview=await writeOutput('previews/phase-01/GRAPH_DISCOVERY_QUESTION_ROSTER_v1.json',{
    schemaVersion:'mi-phase1-full-graph-discovery-roster-v1',
    ...source,graphIndexRef:graphRef,candidateIndexRef:candidateRef,
    methodInventoryRef:methods.ref,allGraphPagesIndexed:true,
    allCurrentRootGraphRecordsIndexed:true,
    subjectPageCatalog:rosterPages,
    subjects:[],
    coverage:{
      allGraphSubjectsAccountedFor:true,
      occurrenceCount:phase1Subjects.length,assignedCount:phase1Subjects.length,
      nodeCount:nodes.length,edgeCount:edges.length,
      unknownCount:unknowns.length,candidateCount:candidates.length,
      methodCount:methods.value?.methodCandidates?.length??0,
      explicitUnknownCount:unknowns.length,
      pageManifestStatus:'ALL_SOURCE_RECORD_PAGES_EMITTED_AND_LOCAL_READBACK_VERIFIED'
    },
    status:'UNACCEPTED_PREVIEW_NOT_MIMO_QUESTION_INPUT',
    limitations:['Existing MiMo single-question transport and graph paging are not yet source-bound and qualified.',
      'No original question was issued and no MiMo-authored disposition exists.']
  });
  // Exercise the actual copied form prefill consumer only against fork-owned
  // authority templates and source-bound read-back graph evidence.
  const {applyPhaseBoundaryPrefill}=await import('./lib/lite-solo-phase-prefill-v1.mjs');
  const authorityRoot='Machine Intelligence Phase0 Deterministic Extraction Fork v1/authority';
  const previewFormRefs={};
  const previewBindingRefs={};
  for(const [sequence,phase] of [[1,'01'],[6,'06']]){
    const relativeTemplate=path.posix.join(authorityRoot,'phases','phase-'+String(sequence),
      'resources','PHASE_'+phase+'_WORK_FORM_TEMPLATE_v1.json');
    const template=JSON.parse(await fs.readFile(
      path.join(controllerRoot,...relativeTemplate.split('/')),'utf8'));
    const form=applyPhaseBoundaryPrefill({
      root:controllerRoot,campaignPath:rel,authorityRoot,sequence,form:template,
      prefillContext:{isolatedPhase0DeterministicFork:true,forkRunRoot,graphIndexRef:graphRef}
    });
    const formRel='previews/phase-'+phase+'/PHASE_'+phase+'_WORK_FORM_FORK_PREVIEW_v1.json';
    previewFormRefs['phase'+phase]=await writeOutput(formRel,form);
    const records=sequence===1?
      (form.actions?.['step-3']?.outputs?.dependencyAssessments??[]).filter(x=>x&&typeof x==='object')
      :(form.actions?.['step-1']?.outputs?.deploymentAssessments??[]).filter(x=>x&&typeof x==='object');
    const bindingRecords=records.map((item,index)=>({
      key:sequence===1?item.dependencyKey:item.componentOrAction,
      formJsonPointer:sequence===1?
        '/actions/step-3/outputs/dependencyAssessments/'+index
        :'/actions/step-1/outputs/deploymentAssessments/'+index,
      graphIndexRef:graphRef,
      evidenceRef:sequence===1?
        (String(item.dependencyKey??'').startsWith('FORK_GRAPH_UNKNOWN:')
          ?graphRef
          :{path:'evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json',
             sha256:observedFiles.get('evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json')??null})
        :{path:item.executionEvidenceRef,sourceGraphIndexSha256:graphRef.sha256},
      disposition:'MACHINE_PREFILL_SUBJECT_ONLY_SEMANTIC_FIELDS_UNANSWERED'
    }));
    const bindings={schemaVersion:'mi-phase0-fork-prefill-bindings-v1',...source,
      graphIndexRef:graphRef,formRef:previewFormRefs['phase'+phase],
      phase:sequence,recordCount:bindingRecords.length,
      records:bindingRecords,sourceHashLimitations:bindingRecords
        .filter(item=>!item.evidenceRef?.sha256&&sequence===1&&!String(item.key).startsWith('FORK_GRAPH_UNKNOWN:'))
        .map(item=>({type:'STATIC_SOURCE_RECORD_SHA_UNAVAILABLE',key:item.key}))};
    const bindsRel='previews/phase-'+phase+'/FORK_PREFILL_'+
      (sequence===1?'RELATIONSHIP':'CONFIGURATION')+'_BINDINGS_v1.json';
    previewBindingRefs['phase'+phase]=await writeOutput(bindsRel,bindings);
  }
  const extensionRef=await writeOutput('evidence/phase0/GRAPH_INTELLIGENCE_EXTENSION_INDEX_v1.json',{
    schemaVersion:'mi-phase0-graph-intelligence-extension-index-v1',
    ...source,graphIndexRef:graphRef,slitherAnalysisRef:slitherRef,
    candidatesRef:candidateRef,simulationEligibilityRef:eligibilityRef,
    censusRef,phase1ReadOnlyPreviewRef:preview,
    previewFormRefs,previewBindingRefs,flowPlanBridgeRef,testConfigurationHandoffRef,
    status:'FORK_ONLY_NOT_CONTROLLER_ACCEPTED',
    limitations:['This extension index is not referenced by the immutable graph base or its addenda.']});
  return{graphRef,extensionRef,censusRef,preview,previewFormRefs,previewBindingRefs,counts:graph.counts};
}
const relationshipGraph=await buildForkRelationshipGraphV1();

const manifest={schemaVersion:'mi-phase0-fork-only-writer-v1',
  status:'FORK_ONLY_NOT_CONTROLLER_ACCEPTED',
  campaignId:receipt.campaign.campaignId,
  campaignGenerationId:receipt.campaign.campaignGenerationId,
  sourceArchiveSha256:receipt.source.sha256,
  originalReceiptSha256:sha256(receiptBytes),
  sourceReceiptRef:path.posix.join('inputs','READ_ONLY_INPUT_RECEIPT_COPY.json'),
  outputRootRelative:rel,
  relationshipGraph,
  files:files.sort((a,b)=>a.path.localeCompare(b.path)),
  publicationLimitations:['No controller core/bundle receipt, phase finalization or Worker acceptance is claimed.']};
const dst=path.join(forkRunRoot,'evidence','FORK_WRITER_READBACK_v1.json');
await fs.mkdir(path.dirname(dst),{recursive:true});
await fs.writeFile(dst,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({status:manifest.status,campaignId:manifest.campaignId,
  fileCount:manifest.files.filter(x=>x.sha256).length,
  unavailable:manifest.files.filter(x=>x.status==='UNAVAILABLE').length})+'\n');
