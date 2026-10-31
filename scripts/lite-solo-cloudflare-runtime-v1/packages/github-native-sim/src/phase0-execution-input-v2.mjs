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
    deployedLinkReferences:clone(a.deployedLinkReferences??{})
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
  }).sort((a,b)=>a.qualifiedName.localeCompare(b.qualifiedName));
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
