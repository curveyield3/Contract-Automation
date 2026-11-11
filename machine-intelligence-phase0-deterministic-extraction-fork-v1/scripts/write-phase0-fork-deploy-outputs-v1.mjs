import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

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
  ['SBOM_v1.json','evidence/build/SBOM_v1.json'],
  ['SLITHER_v1.json','evidence/static-analysis/SLITHER_v1.json'],
  ['SLITHER_RELATIONAL_FACTS_v1.json','evidence/static-analysis/SLITHER_RELATIONAL_FACTS_v1.json'],
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
  const limitations=[];
  const deploy=await optional('evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','DEPLOYMENT');
  const staticFacts=await optional('evidence/static-analysis/SLITHER_RELATIONAL_FACTS_v1.json','SLITHER');
  const methods=await optional('evidence/phase0/ACTIVE_USE_METHOD_INVENTORY_v1.json','ACTIVE_USE');
  for(const x of [deploy,staticFacts,methods])if(x.limitation)limitations.push(x.limitation);
  const source={
    campaignId:receipt.campaign.campaignId,
    campaignGenerationId:receipt.campaign.campaignGenerationId,
    sourceArchiveSha256:receipt.source.sha256
  };
  const pinned={chainId:deploy.value?.fork?.chainId??null,
    pinnedForkBlockNumber:deploy.value?.fork?.pinnedHistoricalBlock??null,
    pinnedForkBlockHash:deploy.value?.fork?.pinnedHistoricalHash??null};
  const mkid=(prefix,...ids)=>prefix+sha256(Buffer.from(JSON.stringify([source,...ids]),'utf8')).slice(0,40);
  const nodes=[],edges=[],unknowns=[],candidates=[],slitherJoins=[];
  const seenNode=new Set();
  const addNode=x=>{if(!seenNode.has(x.nodeId)){seenNode.add(x.nodeId);nodes.push(x)}return x.nodeId};
  const addUnknown=(kind,ref,details)=>unknowns.push({
    unknownId:mkid('UNKNOWN-',kind,ref,details),kind,sourceRef:ref,details,
    status:'UNRESOLVED',needsSourceInspection:true});
  const scenario=deploy.value?.deploymentTraceIndex?.scenarioId??null;
  const byRuntime=new Map();
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
  if(rawIndex.limitation)limitations.push(rawIndex.limitation);
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
      const observed=await optional(pathToTrace.path,'CALL_TRACE_FILE');
      if(observed.limitation||observed.ref?.sha256!==expected){
        limitations.push({type:'CALL_TRACE_SHA_MISSING_OR_MISMATCH',txHash:row.transactionHash,
          expectedSha256:expected,actualSha256:observed.ref?.sha256??null});
        continue;
      }
      const txid=addNode({nodeId:mkid('NODE-TX-',scenario,row.transactionHash),
        kind:'MINED_TRANSACTION',scenarioId:scenario,transactionHash:row.transactionHash,
        blockNumber:row.blockNumber,evidenceRefs:[rawIndex.ref,pathToTrace].filter(Boolean)});
      // A receipt event is an observed emitted log, not a source-level ABI match.
      const receiptPointer=row.evidence?.find(x=>x.kind==='MINED_RECEIPT');
      const receiptEvidence=receiptPointer?await optional(receiptPointer.path,'MINED_RECEIPT'):null;
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
            dataSha256:sha256(Buffer.from(String(log.data??''),'utf8')),
            eventSourceIdentity:null,eventDecodeStatus:'ABI_EVENT_JOIN_NOT_PROVEN',
            evidenceRefs:[receiptEvidence.ref]});
          edges.push({edgeId:mkid('EDGE-OBSERVED-EMISSION-',scenario,row.transactionHash,eventOrdinal),
            kind:'OBSERVED_TRANSACTION_EMITTED_LOG',from:txid,to:eventId,
            observation:'OBSERVED_LOCAL_FORK',evidenceRefs:[receiptEvidence.ref]});
        }
      }
      const statePointer=row.evidence?.find(x=>x.kind==='PRESTATE_DIFF');
      const stateEvidence=statePointer?await optional(statePointer.path,'PRESTATE_DIFF'):null;
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
      for(const frame of row.mechanicalCallFrames??[]){
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
    const ref={path:relative,sha256:sha256(bytes)};
    files.push({path:relative,sha256:ref.sha256,bytes:bytes.length});
    return ref;
  };
  const graph={schemaVersion:'mi-phase0-intercontract-relationship-graph-index-v1',
    graphStatus:limitations.length||unknowns.length?'INCOMPLETE_WITH_TYPED_UNKNOWNS':'SOURCE_BOUND_PARTIAL_COVERAGE',
    controllerAcceptance:false,...source,pinnedSource:pinned,
    sourceRefs:[deploy.ref,rawIndex.ref,staticFacts.ref,methods.ref].filter(Boolean),
    counts:{nodes:nodes.length,edges:edges.length,unknowns:unknowns.length,
      observedRuntimeEdges:edges.filter(x=>x.observation==='OBSERVED_LOCAL_FORK').length,
      staticRelationships:edges.filter(x=>x.observation==='SOURCE_STATIC_NOT_RUNTIME').length},
    nodes,edges,unknowns,limitations,
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
  const candidateRef=await writeOutput('evidence/phase0/GRAPH_INVESTIGATION_CANDIDATES_v1.json',{
    schemaVersion:'mi-phase0-graph-investigation-candidates-v1',...source,sourceGraphIndexRef:graphRef,
    candidateCount:candidates.length,candidates,
    disposition:'MECHANICAL_CANDIDATES_ONLY_NOT_ACCEPTED'});
  const eligible=candidates.map(c=>({
    eligibilityId:mkid('TEST-ELIG-',c.candidateId),sourceGraphCandidateIds:[c.candidateId],
    testFamilyKey:c.patternType==='DELEGATECALL_STORAGE_CONTEXT'?'DELEGATECALL_CONTEXT':
      c.patternType==='CONTRACT_CREATION'?'FACTORY_CREATION':'CROSS_CONTRACT_ACCOUNTING',
    registeredLibraryTestId:null,selectionStatus:'POSSIBLY_ELIGIBLE',
    configurationStatus:'REQUIRES_LIBRARY_REGISTRY',executionStatus:'NOT_EXECUTED_BY_PHASE0_LIBRARY',
    callPathGraphEdgeIds:c.sourceGraphEdgeIds,missingPrerequisites:c.decidingEvidenceNeeded,
    typedLimitations:['LIBRARY_API_NOT_AVAILABLE']}));
  const eligibilityRef=await writeOutput('evidence/phase0/GRAPH_SIMULATION_ELIGIBILITY_v1.json',{
    schemaVersion:'mi-phase0-graph-simulation-eligibility-v1',...source,sourceGraphIndexRef:graphRef,
    libraryRegistry:{status:'NOT_PROVIDED',version:null,sha256:null},
    eligibilityRecords:eligible,unmatchedGraphCandidateIds:[],
    census:{candidateCount:candidates.length,testEligibilityRecordCount:eligible.length,
      configurableNowCount:0,requiresMimoCount:0,unmatchedCount:0}});
  const censusRef=await writeOutput('evidence/phase0/GRAPH_TO_AUDIT_SUBJECT_CENSUS_v1.json',{
    schemaVersion:'mi-phase0-graph-to-audit-subject-census-v1',...source,
    graphIndexRef:graphRef,candidateIndexRef:candidateRef,
    ORIGINAL_GRAPH_SUBJECT_COUNT:edges.length,
    AUTOMATIC_CANDIDATE_OCCURRENCE_COUNT:candidates.length,
    AUTOMATIC_CANDIDATE_GROUP_COUNT:candidates.length,
    FLOW_PLAN_QUESTION_COUNT:0,ASSIGNED_PACKET_QUESTION_COUNT:0,
    MIMO_PHASE1_QUESTION_COUNT:0,MIMO_PHASE1_ANSWERED_COUNT:0,
    MIMO_NOVEL_CANDIDATE_COUNT:0,TEST_ELIGIBILITY_RECORD_COUNT:eligible.length,
    TEST_CONFIG_EXECUTABLE_COUNT:0,TEST_CONFIG_UNRESOLVED_COUNT:eligible.length,
    UNRESOLVED_GRAPH_SUBJECT_COUNT:unknowns.length,
    UNMAPPED_STATIC_SOURCE_COUNT:units.filter(x=>x.analysisStatus!=='SLITHER_RELATIONAL_FACTS_AVAILABLE').length,
    limitations:['Graph is a source-only, unaccepted fork preview. No question issued.']});
  const preview=await writeOutput('previews/phase-01/GRAPH_DISCOVERY_QUESTION_ROSTER_v1.json',{
    schemaVersion:'mi-phase1-full-graph-discovery-roster-v1',graphIndexRef:graphRef,
    allGraphPagesIndexed:false,subjects:edges.map(edge=>({
      subjectId:mkid('GRAPH-SUBJECT-',edge.edgeId),subjectGraphOccurrenceIds:[edge.edgeId],
      scenarioRefs:edge.scenarioId?[edge.scenarioId]:[],exactSourceRefs:edge.evidenceRefs??[],
      runtimeTraceRefs:edge.observation==='OBSERVED_LOCAL_FORK'?edge.evidenceRefs??[]:[],
      configurationAndStateRefs:[],autoGraphCandidateIds:candidates.filter(c=>c.sourceGraphEdgeIds?.includes(edge.edgeId)).map(c=>c.candidateId),
      questionId:null,questionText:null,questionStatus:'PENDING_SOURCE_BOUND_MIMO_ADAPTER'
    })),coverage:{allGraphSubjectsAccountedFor:false,occurrenceCount:edges.length,
      assignedCount:edges.length,explicitUnknownCount:unknowns.length},
    status:'UNACCEPTED_PREVIEW_NOT_MIMO_QUESTION_INPUT'});
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
    previewFormRefs,previewBindingRefs,
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
