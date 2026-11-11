import { createHash } from 'node:crypto';
import { digestCanonicalV1 } from './canonical-json-v1.mjs';
import { buildCallableInventoryV2 } from './phase0-execution-contract-v2.mjs';

const SHA256=/^[0-9a-f]{64}$/i;
const clone=(v)=>v===undefined?undefined:structuredClone(v);
const sha256Bytes=(value)=>{
  const text=String(value??'');
  const hex=text.replace(/^0x/,'');
  const bytes=hex && /^[0-9a-fA-F]+$/.test(hex) && hex.length%2===0 ? Buffer.from(hex,'hex') : Buffer.from(text);
  return createHash('sha256').update(bytes).digest('hex');
};

function normalizedArtifact(a={}){
  const abi=clone(a.abi??[]);
  const row={
    qualifiedName:`${a.sourceName}:${a.contractName}`,
    sourceName:a.sourceName,
    contractName:a.contractName,
    language:a.language??null,
    profile:a.profile??null,
    compilerVersion:a.compilerVersion??null,
    compilationUnitId:a.compilationUnitId??null,
    abi,
    metadata:a.metadata??null,
    storageLayout:clone(a.storageLayout??null),
    devdoc:clone(a.devdoc??{}),
    userdoc:clone(a.userdoc??{}),
    methodIdentifiers:clone(a.methodIdentifiers??{}),
    gasEstimates:clone(a.gasEstimates??null),
    bytecode:a.bytecode??'0x',
    deployedBytecode:a.deployedBytecode??'0x',
    bytecodeSourceMap:a.bytecodeSourceMap??'',
    deployedBytecodeSourceMap:a.deployedBytecodeSourceMap??'',
    linkReferences:clone(a.linkReferences??{}),
    deployedLinkReferences:clone(a.deployedLinkReferences??{}),
    immutableReferences:clone(a.immutableReferences??null),
    creationGeneratedSources:clone(a.creationGeneratedSources??null),
    deployedGeneratedSources:clone(a.deployedGeneratedSources??null)
  };
  return {
    ...row,
    abiDigestSha256:digestCanonicalV1(row.abi),
    creationBytecodeDigestSha256:sha256Bytes(row.bytecode),
    deployedBytecodeDigestSha256:sha256Bytes(row.deployedBytecode)
  };
}

function compactCompilationUnits(units=[]){
  return units.map((u)=>({
    unitId:u.unitId??null,
    profile:u.profile??null,
    compilerVersion:u.compilerVersion??null,
    compilerPackage:u.compilerPackage??null,
    settings:clone(u.settings??null),
    compilerInputSha256:u.compilerInputSha256??null,
    compilerOutputSha256:u.compilerOutputSha256??null,
    sourceNames:Object.keys(u.sourceContents??u.sourceAsts??{}).sort(),
    artifactQualifiedNames:(u.artifacts??[]).map(a=>`${a.sourceName}:${a.contractName}`).sort()
  })).sort((a,b)=>String(a.unitId).localeCompare(String(b.unitId)));
}

export function buildExecutionArtifactBundleV2({request,build}={}){
  if(!request?.source?.archiveSha256||!SHA256.test(request.source.archiveSha256))throw new Error('execution artifact export requires exact source SHA-256');
  if(!request?.campaignId||!request?.campaignGenerationId)throw new Error('execution artifact export requires campaign and generation identity');
  if(!request?.requestDigest||!SHA256.test(String(request.requestDigest)))throw new Error('execution artifact export requires exact request digest');
  if(!build||build.status!=='completed')throw new Error('execution artifact export requires the accepted completed Phase-0 build');
  const compilationUnits=compactCompilationUnits(build.compilationUnits??[]);
  if(!compilationUnits.length)throw new Error('execution artifact export requires exact compiler-unit identity');
  for(const unit of compilationUnits){
    if(!unit.unitId||!SHA256.test(String(unit.compilerInputSha256??''))||!SHA256.test(String(unit.compilerOutputSha256??''))){
      throw new Error(`execution artifact export cannot promote compiler unit ${unit.unitId??'UNKNOWN'} to exactness with null input/output identity`);
    }
  }
  // A shared source (e.g. a dependency interface) is legitimately compiled in
  // several units; the artifact's own exact unit tag decides which one it is.
  const unitsByArtifact=new Map();
  for(const unit of compilationUnits)for(const qualifiedName of unit.artifactQualifiedNames??[]){
    if(!unitsByArtifact.has(qualifiedName))unitsByArtifact.set(qualifiedName,[]);
    unitsByArtifact.get(qualifiedName).push(unit);
  }
  const artifacts=(build.artifacts??[]).map(raw=>{
    const qualifiedName=`${raw.sourceName}:${raw.contractName}`,candidates=unitsByArtifact.get(qualifiedName)??[];
    let unit=null;
    if(raw.compilationUnitId){
      unit=candidates.find(u=>u.unitId===raw.compilationUnitId)??null;
      if(candidates.length&&!unit)throw new Error(`compiler artifact ${qualifiedName} names unit ${raw.compilationUnitId}, which does not contain it`);
    }else if(candidates.length>1){
      throw new Error(`compiler artifact appears in multiple exact units without an exact unit tag: ${qualifiedName}`);
    }else unit=candidates[0]??null;
    return normalizedArtifact({
      ...raw,
      compilationUnitId:raw.compilationUnitId??unit?.unitId??null,
      profile:raw.profile??unit?.profile??null,
      compilerVersion:raw.compilerVersion??unit?.compilerVersion??build.compilerVersion??null
    });
  }).sort((a,b)=>`${a.compilationUnitId}:${a.qualifiedName}`.localeCompare(`${b.compilationUnitId}:${b.qualifiedName}`));
  if(!artifacts.length)throw new Error('execution artifact export requires at least one compiler artifact');
  for(const artifact of artifacts)if(!artifact.compilationUnitId)throw new Error(`compiler artifact lacks exact compilation-unit identity: ${artifact.qualifiedName}`);
  const identityRows=artifacts.map(a=>({
    qualifiedName:a.qualifiedName,
    abiDigestSha256:a.abiDigestSha256,
    creationBytecodeDigestSha256:a.creationBytecodeDigestSha256,
    deployedBytecodeDigestSha256:a.deployedBytecodeDigestSha256,
    compilationUnitId:a.compilationUnitId,
    profile:a.profile,
    compilerVersion:a.compilerVersion
  }));
  const buildConfigurationIdentity={
    system:build.system??null,
    compilerVersion:build.compilerVersion??null,
    compilerVersions:clone(build.compilerVersions??[]),
    compilerProfiles:clone(build.compilerProfiles??[]),
    compilationUnits
  };
  const buildConfigurationDigestSha256=digestCanonicalV1(buildConfigurationIdentity);
  return {
    schemaVersion:'curveyield-phase0-execution-build-artifacts-v2',
    artifactType:'PHASE0_EXECUTION_BUILD_ARTIFACTS',
    source:{
      repository:request.source.repository??null,
      commit:request.source.commit??null,
      projectPath:request.source.projectPath??null,
      archivePath:request.source.archivePath??null,
      archiveSha256:request.source.archiveSha256
    },
    requestIdentity:{
      requestId:request.requestId??null,
      requestDigest:request.requestDigest??null,
      campaignId:request.campaignId??null,
      campaignGenerationId:request.campaignGenerationId??null
    },
    buildIdentity:{
      system:build.system??null,
      compilerVersion:build.compilerVersion??null,
      compilerVersions:clone(build.compilerVersions??[]),
      compilerProfiles:clone(build.compilerProfiles??[]),
      sourceInventory:clone(build.sourceInventory??[]),
      deploymentOrder:clone(build.deploymentOrder??[]),
      compileGroups:clone(build.compileGroups??[]),
      embeddedBuildContract:clone(build.embeddedBuildContract??null),
      compilationUnits,
      buildConfigurationDigestSha256
    },
    artifacts,
    artifactSetDigestSha256:digestCanonicalV1(identityRows),
    buildConfigurationDigestSha256,
    reuseContract:{
      secondBuildRequired:false,
      exactCompilerArtifactsExported:true,
      intendedConsumers:['PHASE0_RANDOMIZED_SIMULATION','PHASE0_MEDUSA','PHASE0_ABI_TELEMETRY'],
      fallbackPolicy:'FAIL_CLOSED_OR_EXPLICIT_TYPED_LEGACY_LIMITATION'
    }
  };
}

function firstString(...values){
  for(const v of values)if(typeof v==='string'&&v.length)return v;
  return null;
}
function sourceShaFrom(value={}){
  return firstString(
    value?.source?.sha256,
    value?.source?.archiveSha256,
    value?.source?.archiveSha256Observed,
    value?.sourceIdentity?.archiveSha256,
    value?.sourceIdentity?.sourceDigestSha256,
    value?.identity?.sourceDigestSha256,
    value?.requestIdentity?.sourceSha256,
    value?.requestIdentity?.archiveSha256,
    value?.data?.source?.archiveSha256,
    value?.data?.sourceIdentity?.archiveSha256
  );
}
function siCompilerArtifacts(si={}){
  return si.compilerArtifacts??si?.technical?.compilerArtifacts??si?.data?.compilerArtifacts??si?.data?.technical?.compilerArtifacts??[];
}
function siFunctions(si={}){
  return si.functions??si?.technical?.functions??si?.data?.functions??si?.data?.technical?.functions??[];
}
function requireSameSource(label,value,expected,{optional=false}={}){
  const observed=sourceShaFrom(value);
  if(!observed&&optional)return null;
  if(!observed)throw new Error(`source identity missing for ${label}`);
  if(observed!==expected)throw new Error(`source identity mismatch for ${label}: expected ${expected}, observed ${observed}`);
  return observed;
}
function compareCompilerInventory(artifactBundle,sourceIntelligence){
  const exported=new Map((artifactBundle.artifacts??[]).map(a=>[a.qualifiedName,a]));
  const siRows=siCompilerArtifacts(sourceIntelligence);
  if(!siRows.length)throw new Error('Source Intelligence compiler artifact inventory is missing');
  for(const row of siRows){
    const a=exported.get(row.qualifiedName);
    if(!a)throw new Error(`compiler artifact mismatch: Source Intelligence references missing exported artifact ${row.qualifiedName}`);
    for(const key of ['abiDigestSha256','creationBytecodeDigestSha256','deployedBytecodeDigestSha256']){
      if(row[key]&&a[key]!==row[key])throw new Error(`compiler artifact mismatch for ${row.qualifiedName} ${key}`);
    }
  }
  const siNames=new Set(siRows.map(x=>x.qualifiedName));
  const unexplained=[...exported.keys()].filter(x=>!siNames.has(x));
  if(unexplained.length)throw new Error(`compiler artifact mismatch: exported artifacts absent from Source Intelligence: ${unexplained.join(', ')}`);
}
function callableInventory(artifactBundle,sourceIntelligence){
  const functions=siFunctions(sourceIntelligence);
  const bySignature=new Map(functions.map(f=>[`${f.contractId??''}|${f.signature}`,f]));
  const rows=[];
  const contracts=sourceIntelligence.contracts??sourceIntelligence?.technical?.contracts??sourceIntelligence?.data?.contracts??[];
  const contractByQualified=new Map(contracts.map(c=>[c.qualifiedName,c]));
  for(const artifact of artifactBundle.artifacts??[]){
    const c=contractByQualified.get(artifact.qualifiedName);
    const inv=buildCallableInventoryV2({
      contractId:c?.contractId??artifact.qualifiedName,
      qualifiedName:artifact.qualifiedName,
      abi:artifact.abi,
      instantiated:false
    });
    for(const row of inv){
      const sourceFn=functions.find(f=>f.signature===row.signature&&(c?.contractId?f.contractId===c.contractId:true));
      rows.push({...row,functionId:sourceFn?.functionId??null,sourceIntelligenceBasis:sourceFn?sourceFn.basis??'SOURCE_INTELLIGENCE_FUNCTION_INDEX':'COMPILER_ABI_ONLY'});
    }
  }
  return rows;
}

export function validateExecutionInputJoinV2({receipt,buildIdentity,artifactBundle,sourceIntelligence,slither,readiness}={}){
  const canonical=sourceShaFrom(receipt);
  const campaignId=receipt?.campaign?.campaignId;
  const campaignGenerationId=receipt?.campaign?.campaignGenerationId;
  if(!campaignId||!campaignGenerationId)throw new Error('canonical receipt campaign/generation identity is missing');
  if(!canonical||!SHA256.test(canonical))throw new Error('canonical receipt source SHA-256 is missing');
  requireSameSource('build identity',buildIdentity,canonical);
  requireSameSource('execution artifact bundle',artifactBundle,canonical);
  requireSameSource('Source Intelligence',sourceIntelligence,canonical);
  // Some legacy Slither/readiness projections predate archive SHA fields. They are still joined as
  // upstream evidence, but any source identity they do carry must match the canonical source.
  if(sourceShaFrom(slither))requireSameSource('Slither',slither,canonical);
  if(sourceShaFrom(readiness))requireSameSource('readiness',readiness,canonical);

  if(artifactBundle?.schemaVersion!=='curveyield-phase0-execution-build-artifacts-v2')throw new Error('unsupported execution artifact bundle schema');
  if(artifactBundle?.requestIdentity?.campaignId!==campaignId)throw new Error('campaign identity mismatch for execution artifact bundle');
  if(artifactBundle?.requestIdentity?.campaignGenerationId!==campaignGenerationId)throw new Error('campaign generation mismatch for execution artifact bundle');
  if(buildIdentity?.campaignId!==campaignId)throw new Error('campaign identity mismatch for build identity');
  if(buildIdentity?.campaignGenerationId!==campaignGenerationId)throw new Error('campaign generation mismatch for build identity');
  if(!SHA256.test(String(artifactBundle?.requestIdentity?.requestDigest??'')))throw new Error('execution artifact bundle request digest is not exact');
  const units=artifactBundle?.buildIdentity?.compilationUnits??[];
  if(!units.length)throw new Error('execution artifact bundle has no exact compiler units');
  for(const unit of units){
    if(!unit.unitId||!SHA256.test(String(unit.compilerInputSha256??''))||!SHA256.test(String(unit.compilerOutputSha256??''))){
      throw new Error('null compiler input/output identity cannot be promoted to exactness');
    }
  }
  if(!SHA256.test(String(artifactBundle?.buildConfigurationDigestSha256??'')))throw new Error('execution artifact build configuration digest is missing');
  if(buildIdentity?.build?.buildConfigurationDigestSha256!==artifactBundle.buildConfigurationDigestSha256)throw new Error('build/profile identity mismatch between build evidence and execution artifacts');
  if(artifactBundle?.reuseContract?.secondBuildRequired!==false)throw new Error('execution artifact bundle does not authorize build reuse');
  compareCompilerInventory(artifactBundle,sourceIntelligence);

  const artifacts=clone(artifactBundle.artifacts??[]);
  const callableFunctions=callableInventory(artifactBundle,sourceIntelligence);
  return {
    schemaVersion:'curveyield-phase0-shared-execution-inputs-v2',
    status:'PASS',
    sourceSha256:canonical,
    campaignId,
    campaignGenerationId,
    artifactSetDigestSha256:artifactBundle.artifactSetDigestSha256,
    artifacts,
    callableFunctions,
    sourceIntelligenceFunctions:clone(siFunctions(sourceIntelligence)),
    slither:clone(slither??null),
    readiness:clone(readiness??null),
    upstreamInputs:[
      {role:'BUILD_IDENTITY',status:'BOUND',sourceSha256:sourceShaFrom(buildIdentity)},
      {role:'EXECUTION_BUILD_ARTIFACTS',status:'BOUND',sourceSha256:sourceShaFrom(artifactBundle),digest:artifactBundle.artifactSetDigestSha256},
      {role:'SOURCE_INTELLIGENCE',status:'BOUND',sourceSha256:sourceShaFrom(sourceIntelligence)},
      {role:'SLITHER',status:slither?'BOUND':'MISSING',sourceSha256:sourceShaFrom(slither)},
      {role:'READINESS',status:readiness?'BOUND':'MISSING',sourceSha256:sourceShaFrom(readiness)}
    ],
    executionPreparation:{
      joinedOnce:true,
      secondBuildPerformed:false,
      secondAbiIndexPerformed:false,
      compilerArtifactCount:artifacts.length,
      callableSurfaceCount:callableFunctions.length
    }
  };
}


/**
 * Derive the Phase-0 fork's unit-qualified identity census from exactly the
 * compilation results already accepted by buildExecutionArtifactBundleV2.
 * This is a mechanical compiler inventory, never an assertion about deployed
 * code, contract safety, runtime ownership, or ABI compatibility.
 */
export function buildContractIdentityIndexV1({request,build,artifactBundle,buildArtifactBundleSha256}={}){
  if(!SHA256.test(String(buildArtifactBundleSha256??'')))throw new Error('PHASE0_IDENTITY_BUNDLE_BYTE_DIGEST_REQUIRED');
  if(artifactBundle?.schemaVersion!=='curveyield-phase0-execution-build-artifacts-v2' ||
     artifactBundle?.requestIdentity?.campaignId!==request?.campaignId ||
     artifactBundle?.requestIdentity?.campaignGenerationId!==request?.campaignGenerationId ||
     artifactBundle?.source?.archiveSha256!==request?.source?.archiveSha256)
    throw new Error('PHASE0_IDENTITY_SOURCE_GENERATION_BUNDLE_MISMATCH');

  const digest=value=>createHash('sha256').update(value).digest('hex');
  const stable=x=>Array.isArray(x)?'['+x.map(stable).join(',')+']':
    x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':
    JSON.stringify(x);
  const abiType=param=>{
    const type=String(param?.type??'');
    return type.startsWith('tuple')
      ? '('+(param.components??[]).map(abiType).join(',')+')'+type.slice(5)
      :type;
  };
  const units=new Map((build?.compilationUnits??[]).map(unit=>[unit.unitId,unit]));
  const artifactUnits=new Map((artifactBundle?.buildIdentity?.compilationUnits??[]).map(unit=>[unit.unitId,unit]));
  const sourceFiles=[],sourceKeyMap=new Map(),sourceKinds=new Map(),sourceSymbols=[];
  const inheritanceEdges=[],libraryLinkEdges=[],abiSelectors=[],contractIdentities=[],identityLimitations=[];
  const sortedEntries=obj=>Object.entries(obj??{}).sort(([a],[b])=>a.localeCompare(b));
  const nodeKey=(unitId,sourceName,contractName)=>[unitId,sourceName,contractName].join(':');

  for(const [unitId,unit] of [...units].sort(([a],[b])=>a.localeCompare(b))){
    const declared=artifactUnits.get(unitId);
    if(!declared)identityLimitations.push({type:'COMPILATION_UNIT_NOT_IN_ACCEPTED_BUNDLE',unitId});
    const astById=new Map();
    for(const [sourceName,ast] of sortedEntries(unit.sourceAsts??{})){
      for(const node of ast?.nodes??[]){
        if(node?.nodeType!=='ContractDefinition')continue;
        astById.set(node.id,{sourceName,contractName:node.name,node});
        const kind=node.abstract===true?'ABSTRACT':String(node.contractKind??'UNKNOWN').toUpperCase();
        sourceKinds.set(nodeKey(unitId,sourceName,node.name),kind);
        sourceSymbols.push({symbolType:'CONTRACT_DECLARATION',compilationUnitId:unitId,
          sourceName,contractName:node.name,compilerAstId:node.id??null,sourceSpan:node.src??null,
          sourceKind:kind});
        for(const child of node.nodes??[]){
          if(!['FunctionDefinition','VariableDeclaration','ModifierDefinition','EventDefinition','ErrorDefinition'].includes(child?.nodeType))continue;
          sourceSymbols.push({symbolType:child.nodeType,compilationUnitId:unitId,
            sourceName,contractName:node.name,compilerAstId:child.id??null,
            symbolName:child.name??null,sourceSpan:child.src??null,
            stateVisibility:child.visibility??null});
        }
      }
    }
    for(const [name,content] of sortedEntries(unit.sourceContents??{})){
      const bytes=Buffer.from(String(content),'utf8');
      const sourceContentSha256=digest(bytes);
      const key=unitId+':'+name;
      sourceKeyMap.set(key,sourceContentSha256);
      const ast=unit.sourceAsts?.[name]??null;
      const sourceId=ast?.src?String(ast.src).split(':').at(-1):null;
      sourceFiles.push({compilationUnitId:unitId,sourcePath:name,
        sourceContentSha256,sourceByteLength:bytes.length,
        compilerFileId:sourceId!==null&&/^[0-9]+$/.test(sourceId)?Number(sourceId):null,
        astNodeId:ast?.id??null,astAvailability:ast?'COMPILER_AST_PRESENT':'AST_NOT_EMITTED'});
    }
    for(const [sourceName,ast] of sortedEntries(unit.sourceAsts??{})){
      for(const node of ast?.nodes??[]){
        if(node?.nodeType!=='ContractDefinition')continue;
        for(const [i,base] of (node.baseContracts??[]).entries()){
          const referenced=base?.baseName?.referencedDeclaration;
          const parent=astById.get(referenced);
          inheritanceEdges.push({
            fromCompilationUnitId:unitId,fromSourceName:sourceName,fromContractName:node.name,
            parentCompilationUnitId:parent?unitId:null,parentSourceName:parent?.sourceName??null,
            parentContractName:parent?.contractName??base?.baseName?.name??null,
            parentAstId:referenced??null,baseOrdinal:i,
            resolutionStatus:parent?'COMPILER_AST_REFERENCE':'UNRESOLVED_AST_REFERENCE',
            sourceSpan:base?.src??null
          });
        }
      }
    }
  }
  const pathDigests=new Map();
  for(const source of sourceFiles){
    const seen=pathDigests.get(source.sourcePath);
    if(seen&&seen!==source.sourceContentSha256)
      identityLimitations.push({type:'SAME_PATH_DIFFERENT_BYTES',sourcePath:source.sourcePath,
        compilationUnitId:source.compilationUnitId,sourceContentSha256:source.sourceContentSha256,
        previousSourceContentSha256:seen});
    pathDigests.set(source.sourcePath,source.sourceContentSha256);
  }
  for(const artifact of artifactBundle.artifacts??[]){
    const unit=artifactUnits.get(artifact.compilationUnitId);
    const qualified=artifact.qualifiedName??artifact.sourceName+':'+artifact.contractName;
    const sourceContentSha256=sourceKeyMap.get(artifact.compilationUnitId+':'+artifact.sourceName)??null;
    const contractIdentityId='CONTRACT-'+digest(stable([
      artifact.compilationUnitId,artifact.sourceName,artifact.contractName,
      unit?.compilerInputSha256??null,artifact.creationBytecodeDigestSha256
    ])).slice(0,40);
    const sourceKind=sourceKinds.get(nodeKey(artifact.compilationUnitId,artifact.sourceName,artifact.contractName))??'UNKNOWN';
    const linkRefs=artifact.linkReferences??{},immutable=artifact.immutableReferences;
    const needsLinks=Object.values(linkRefs).some(libraries=>Object.values(libraries??{}).some(refs=>Array.isArray(refs)&&refs.length>0));
    const creation=String(artifact.bytecode??'');
    const deployabilityClass=sourceKind==='ABSTRACT'||sourceKind==='INTERFACE'
      ?sourceKind
      :creation==='0x'?'NO_CREATION_BYTECODE'
      :needsLinks?'DEPLOYABLE_AFTER_LIBRARY_LINK':'DEPLOYABLE';
    const abiDeclarations=[];
    for(const [index,entry] of (artifact.abi??[]).entries()){
      if(!['constructor','function','event','error','fallback','receive'].includes(entry?.type))continue;
      const sig=entry.type==='function'||entry.type==='event'||entry.type==='error'
        ?String(entry.name??'')+'('+(entry.inputs??[]).map(abiType).join(',')+')'
        :entry.type==='constructor'?'constructor('+(entry.inputs??[]).map(abiType).join(',')+')':entry.type;
      const selectorRaw=entry.type==='function'?(artifact.methodIdentifiers?.[sig]??null):null;
      const selector=/^(?:0x)?[a-fA-F0-9]{8}$/.test(String(selectorRaw??''))
        ?'0x'+String(selectorRaw).replace(/^0x/i,'').toLowerCase():null;
      const record={contractIdentityId,compilationUnitId:artifact.compilationUnitId,
        abiIndex:index,sourceName:artifact.sourceName,contractName:artifact.contractName,
        declarationType:entry.type,canonicalSignature:sig,selector,
        selectorStatus:selector?'COMPILER_METHOD_ID':'NOT_EXPORTED_AS_METHOD_ID',
        stateMutability:entry.stateMutability??null,
        inputTypes:(entry.inputs??[]).map(abiType),outputTypes:(entry.outputs??[]).map(abiType)};
      abiDeclarations.push(record);
      if(entry.type==='function'||entry.type==='event'||entry.type==='error')abiSelectors.push(record);
    }
    for(const [linkFile,libraries] of sortedEntries(linkRefs)){
      for(const [libraryName,offsets] of sortedEntries(libraries)){
        libraryLinkEdges.push({compilationUnitId:artifact.compilationUnitId,
          requestingContractIdentityId:contractIdentityId,
          linkedLibrarySourceName:linkFile,linkedLibraryName:libraryName,
          creationBytecodeOffsets:(offsets??[]).map(offset=>({
            start:offset.start??null,length:offset.length??null
          })),resolutionStatus:'COMPILER_LINK_REFERENCE_NOT_RUNTIME_CALL'});
      }
    }
    if(!sourceContentSha256)identityLimitations.push({
      type:'ARTIFACT_SOURCE_CONTENT_NOT_IN_EXACT_UNIT',
      compilationUnitId:artifact.compilationUnitId,sourceName:artifact.sourceName,contractName:artifact.contractName});
    if(sourceKind==='UNKNOWN')identityLimitations.push({
      type:'SOURCE_DECLARATION_KIND_NOT_IN_EXACT_AST',
      contractIdentityId,sourceName:artifact.sourceName});
    const storageLayoutAvailable=artifact.storageLayout!==null;
    contractIdentities.push({
      contractIdentityId,compilationUnitId:artifact.compilationUnitId,
      qualifiedName:qualified,sourceName:artifact.sourceName,contractName:artifact.contractName,
      sourceKind,deployabilityClass,language:artifact.language??'solidity',
      compilerVersion:artifact.compilerVersion,compilerProfile:artifact.profile,
      compilerInputSha256:unit?.compilerInputSha256??null,
      compilerOutputSha256:unit?.compilerOutputSha256??null,
      sourceContentSha256,abiDigestSha256:artifact.abiDigestSha256,
      creationBytecodeDigestSha256:artifact.creationBytecodeDigestSha256,
      deployedRuntimeDigestSha256:artifact.deployedBytecodeDigestSha256,
      constructorParameterTypes:abiDeclarations.find(x=>x.declarationType==='constructor')?.inputTypes??[],
      abiDeclarations,creationBytecodeSourceMap:artifact.bytecodeSourceMap??null,
      deployedBytecodeSourceMap:artifact.deployedBytecodeSourceMap??null,
      linkReferences:clone(linkRefs),deployedLinkReferences:clone(artifact.deployedLinkReferences??{}),
      immutableReferences:clone(immutable??null),
      generatedSources:clone({creation:artifact.creationGeneratedSources??null,
        deployed:artifact.deployedGeneratedSources??null}),
      storageLayout:clone(artifact.storageLayout??null),
      storageLayoutStatus:storageLayoutAvailable?'COMPILER_EMITTED':'LAYOUT_NOT_EMITTED',
      gasEstimates:clone(artifact.gasEstimates??null),
      gasEstimateStatus:'PRELIMINARY_COMPILER_ESTIMATE_NOT_RUNTIME',
      evidenceProvenance:{artifactBundleSha256:buildArtifactBundleSha256,
        compilationUnitId:artifact.compilationUnitId,sourceContentSha256,
        compilerInputSha256:unit?.compilerInputSha256??null}
    });
  }
  const sort=arr=>arr.sort((a,b)=>stable(a).localeCompare(stable(b)));
  for(const arr of [sourceFiles,sourceSymbols,inheritanceEdges,libraryLinkEdges,
    abiSelectors,contractIdentities,identityLimitations])sort(arr);
  const seenId=new Set();
  for(const row of contractIdentities){
    if(seenId.has(row.contractIdentityId))identityLimitations.push({
      type:'DUPLICATED_CONTRACT_IDENTITY',contractIdentityId:row.contractIdentityId});
    seenId.add(row.contractIdentityId);
  }
  return{
    schemaVersion:'mi-phase0-contract-identity-index-v1',
    artifactType:'CONTRACT_IDENTITY_INDEX',
    campaignId:request.campaignId,campaignGenerationId:request.campaignGenerationId,
    sourceArchiveSha256:request.source.archiveSha256,
    buildArtifactBundleSha256,compilationUnits:clone(artifactBundle.buildIdentity.compilationUnits),
    sourceFiles,contractIdentities,abiSelectors,sourceSymbols,inheritanceEdges,libraryLinkEdges,
    deploymentMatches:[],identityLimitations,
    internalCreateTraceStatus:'NOT_CAPTURED_STEP_2',
    scriptExecutionStatus:'NOT_EXECUTED_IN_COMPILER_STAGE',
    identityCoverageStatus:identityLimitations.length?'PARTIAL_WITH_GAPS':'COMPILER_ONLY_COMPLETE',
    coverage:{compiledArtifactCount:artifactBundle.artifacts.length,
      indexedArtifactCount:contractIdentities.length,
      storageLayoutPresent:contractIdentities.filter(x=>x.storageLayoutStatus==='COMPILER_EMITTED').length,
      storageLayoutUnavailable:contractIdentities.filter(x=>x.storageLayoutStatus!=='COMPILER_EMITTED').length,
      observedCreationCount:0,matchedCreationCount:0,ambiguousCreationCount:0,unmappedCreationCount:0}
  };
}


/**
 * Compare observed on-fork runtime bytes with the exact retained compiler
 * artifacts. A unique *masked* template match is a candidate, not an exact
 * code/source identity: constructor immutables and linked addresses have
 * values that must remain visible and independently attributed.
 */
export function findSourceRuntimeTemplateMatchesV1({observedBytecode,artifacts=[]}={}){
  const observed=String(observedBytecode??'').toLowerCase();
  if(!/^0x(?:[0-9a-f]{2})+$/.test(observed))return [];
  const code=observed.slice(2),size=code.length/2;
  const matches=[];
  for(const artifact of artifacts){
    const compiled=String(artifact.deployedBytecode??'').replace(/^0x/i,'').toLowerCase();
    if(compiled.length!==code.length||!compiled.length)continue;
    const masked=new Uint8Array(size),ranges=[];
    let invalid=false;
    const pushRange=(start,length,kind,origin)=>{
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||
         start<0||length<1||start+length>size){invalid=true;return;}
      for(let i=start;i<start+length;i++)masked[i]=1;
      ranges.push({kind,origin,start,length,
        observedHex:'0x'+code.slice(start*2,(start+length)*2)});
    };
    for(const [immutableId,locations] of Object.entries(artifact.immutableReferences??{})){
      if(!Array.isArray(locations)){invalid=true;continue;}
      for(const ref of locations)pushRange(ref?.start,ref?.length,'CONSTRUCTOR_IMMUTABLE',immutableId);
    }
    for(const [sourceName,libraries] of Object.entries(artifact.deployedLinkReferences??{})){
      if(!libraries||typeof libraries!=='object'){invalid=true;continue;}
      for(const [libraryName,locations] of Object.entries(libraries)){
        if(!Array.isArray(locations)){invalid=true;continue;}
        for(const ref of locations)
          pushRange(ref?.start,ref?.length,'LINKED_LIBRARY',
            sourceName+':'+libraryName);
      }
    }
    if(invalid)continue;
    let unmaskedCount=0,allUnmaskedEqual=true;
    for(let byte=0;byte<size;byte++){
      if(masked[byte])continue;
      unmaskedCount++;
      const expected=compiled.slice(byte*2,byte*2+2);
      if(!/^[a-f0-9]{2}$/.test(expected)||expected!==code.slice(byte*2,byte*2+2)){
        allUnmaskedEqual=false;break;
      }
    }
    if(!allUnmaskedEqual||unmaskedCount===0)continue;
    const fullyExact=compiled===code;
    matches.push({
      compilationUnitId:artifact.compilationUnitId??null,
      sourceName:artifact.sourceName,contractName:artifact.contractName,
      matchClass:fullyExact?'EXACT_FULL_RUNTIME_BYTECODE':
        'MASKED_IMMUTABLE_OR_LIBRARY_TEMPLATE_CANDIDATE',
      bytecodeLength:size,unmaskedMatchedBytes:unmaskedCount,
      maskedBytes:size-unmaskedCount,observedReferenceRanges:ranges,
      sourceCodeTemplateSha256:artifact.deployedBytecodeDigestSha256??null,
      evidenceStatus:fullyExact?'EXACT_COMPILER_BYTE_EQUALITY':
        'COMPILER_TEMPLATE_CANDIDATE_ONLY_NOT_SOURCE_RUNTIME_PROOF'
    });
  }
  return matches.sort((a,b)=>[
    a.matchClass,a.compilationUnitId,a.sourceName,a.contractName
  ].join(':').localeCompare([
    b.matchClass,b.compilationUnitId,b.sourceName,b.contractName
  ].join(':')));
}
