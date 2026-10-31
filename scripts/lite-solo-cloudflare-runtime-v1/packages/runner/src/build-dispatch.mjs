import { collectSoliditySources, compileProject, loadSolcVersion, contractArtifactMap } from './compiler.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compileRepoHermeticStandardJson, shouldUseHermeticStandardJson } from './hermetic-standard-json.mjs';
import { compileRepoNativeHardhat, detectNativeBuild, compileRepoNativeFoundry, detectNativeFoundry } from './native-build.mjs';
import { compileRepoEmbeddedProfiles, detectEmbeddedProfileBuild } from './embedded-profile-build-v1.mjs';
import { compileVyperSources as defaultCompileVyperSources } from './vyper-build.mjs';


const scanHash = x => createHash('sha256').update(x).digest('hex');

// Scan inputs are Etherscan-published Solidity Standard-JSON compiler units. Preserve
// original source names, compiler versions and settings; never rebuild them from a
// flattened combined project or accept artifact/name collisions.
async function compileVerifiedScanProject(projectRoot) {
  const manifest=JSON.parse(await fs.readFile(path.join(projectRoot,'scan-source-manifest.json'),'utf8'));
  if(manifest.schemaVersion!=='curveyield-scan-source-manifest-v1'||manifest.inputMode!=='LIVE_SCAN')throw new Error('INVALID_SCAN_SOURCE_MANIFEST');
  if(!Array.isArray(manifest.compilerUnits)||manifest.compilerUnits.length<1||manifest.compilerUnits.length>64)throw new Error('INVALID_SCAN_COMPILER_UNITS');
  const units=[],artifacts=[],seen=new Set(),sourceNames=new Set(),allAsts={},diagnostics=[];
  for(const info of manifest.compilerUnits){
    if(!/^scan-[0-9a-f]{16}$/.test(info.unitId)||info.file!==('scan-compiler-units/'+info.unitId+'.json'))throw new Error('INVALID_SCAN_COMPILER_UNIT_PATH');
    const unit=JSON.parse(await fs.readFile(path.join(projectRoot,info.file),'utf8'));
    if(unit.compilerVersion!==info.compilerVersion||unit.input?.language!=='Solidity')throw new Error('SCAN_COMPILER_INPUT_IDENTITY_MISMATCH');
    const standard=structuredClone(unit.input);
    if(!standard.sources||!Object.keys(standard.sources).length)throw new Error('SCAN_SOURCE_CONTENT_MISSING');
    // Hash comparison uses the exact canonical JSON algorithm used by the Etherscan resolver.
    const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}':JSON.stringify(x);
    if(scanHash(canonical(unit.input))!==info.originalInputSha256)throw new Error('SCAN_ORIGINAL_INPUT_DIGEST_MISMATCH');
    for(const [name,entry] of Object.entries(standard.sources)){
      if(typeof entry?.content!=='string')throw new Error('SCAN_COMPILER_SOURCE_UNRESOLVED: '+name);
      const file=path.resolve(projectRoot,name);
      if(!file.startsWith(path.resolve(projectRoot)+path.sep))throw new Error('SCAN_UNSAFE_SOURCE_PATH');
      if(scanHash(await fs.readFile(file))!==scanHash(Buffer.from(entry.content)))throw new Error('SCAN_SOURCE_FILE_BINDING_MISMATCH: '+name);
      sourceNames.add(name);
    }
    standard.settings??={};
    // Extra output selection does not change compiler creation/runtime bytecode or metadata.
    standard.settings.outputSelection={'*':{'*':['abi','metadata','storageLayout','devdoc','userdoc','evm.bytecode','evm.deployedBytecode','evm.methodIdentifiers','evm.gasEstimates'],'':['ast']}};
    const compiler=await loadSolcVersion(info.compilerVersion.split('+')[0]);
    if(!String(compiler.version()).startsWith(info.compilerVersion))throw new Error('SCAN_EXACT_COMPILER_BUILD_MISMATCH: '+info.compilerVersion);
    const inputText=JSON.stringify(standard);
    const outputText=typeof compiler.compileStandard==='function'
      ?compiler.compileStandard(inputText):compiler.compile(inputText);
    const output=JSON.parse(outputText);
    const unitDiagnostics=output.errors??[];
    if(unitDiagnostics.some(d=>d.severity==='error'))throw new Error('SCAN_STANDARD_JSON_COMPILATION_FAILED: '+unitDiagnostics.filter(d=>d.severity==='error').map(d=>d.formattedMessage??d.message).join('; ').slice(0,900));
    const unitArtifacts=contractArtifactMap(output).all.map(a=>({...a,compilationUnitId:info.unitId,compilerVersion:info.compilerVersion,profile:info.unitId}));
    for(const binding of info.targetBindings??[{qualifiedName:info.qualifiedName}]){
      if(!unitArtifacts.some(a=>a.sourceName+':'+a.contractName===binding.qualifiedName))throw new Error('SCAN_VERIFIED_TARGET_ARTIFACT_MISSING: '+binding.qualifiedName);
    }
    for(const a of unitArtifacts){
      const key=a.sourceName+':'+a.contractName;
      if(seen.has(key))throw new Error('AMBIGUOUS_COMPILATION_TARGET: '+key);
      seen.add(key);artifacts.push(a);
    }
    const sourceAsts=Object.fromEntries(Object.entries(output.sources??{}).filter(([,v])=>v?.ast).map(([n,v])=>[n,v.ast]));
    Object.assign(allAsts,sourceAsts);
    units.push({unitId:info.unitId,profile:info.unitId,compilerVersion:info.compilerVersion,compilerPackage:'solc',
      settings:standard.settings,compilerInputSha256:scanHash(inputText),compilerOutputSha256:scanHash(outputText),
      sourceAsts,sourceContents:Object.fromEntries(Object.entries(standard.sources).map(([n,v])=>[n,v.content])),
      artifacts:unitArtifacts,diagnostics:unitDiagnostics});
    diagnostics.push(...unitDiagnostics);
  }
  const names=new Set(units.flatMap(u=>u.artifacts.map(a=>a.sourceName+':'+a.contractName)));
  for(const target of manifest.resolvedTargets??[]){
    if(!names.has(target.qualifiedName)||!units.some(u=>u.unitId===target.compilationUnitId&&u.artifacts.some(a=>a.sourceName+':'+a.contractName===target.qualifiedName)))throw new Error('SCAN_TARGET_COMPILATION_BINDING_MISSING');
  }
  return{status:'completed',system:'etherscan-verified-standard-json',compilerVersion:units.length===1?units[0].compilerVersion:'multi-profile',
    compilerVersions:[...new Set(units.map(u=>u.compilerVersion))].sort(),
    compilerProfiles:units.map(u=>({name:u.unitId,compilerVersion:u.compilerVersion,settings:u.settings})),
    compilerDiagnostics:diagnostics,sourceAsts:allAsts,
    artifacts:artifacts.sort((a,b)=>(a.sourceName+':'+a.contractName).localeCompare(b.sourceName+':'+b.contractName)),
    compilationUnits:units,sourceInventory:[...sourceNames].sort(),sourceInventoryFiles:sourceNames.size};
}

export { compileVyperSources } from './vyper-build.mjs';

function requestedSolidityCompiler(request) {
  const compilers = request?.configuration?.compilers ?? [];
  const compiler = compilers.find((item) => item?.language === 'solidity');
  if (!compiler?.version) throw new Error('Exact Solidity compiler version is required');
  return compiler;
}

function requestedVyperCompiler(request) {
  const compilers = request?.configuration?.compilers ?? [];
  return compilers.find((item) => item?.language === 'vyper') ?? null;
}

function mergeArtifacts(solidityArtifacts, vyperArtifacts) {
  const merged = [];
  const seen = new Set();
  for (const artifact of [...(solidityArtifacts ?? []), ...(vyperArtifacts ?? [])]) {
    const key = `${artifact.sourceName}:${artifact.contractName}`;
    if (seen.has(key)) throw new Error(`Duplicate mixed-language compiler artifact: ${key}`);
    seen.add(key);
    merged.push(artifact);
  }
  return merged;
}

export async function buildProject({
  projectRoot,
  request,
  runCommand,
  fsApi,
  compileStandardJson = compileProject,
  collectSources = collectSoliditySources,
  compileVyper = defaultCompileVyperSources,
  compileHermetic = compileRepoHermeticStandardJson
}) {
  const compiler = requestedSolidityCompiler(request);
  const scanManifestPath=path.join(projectRoot,'scan-source-manifest.json');
  try { await fs.access(scanManifestPath); return await compileVerifiedScanProject(projectRoot); }
  catch(error){if(error?.code!=='ENOENT')throw error;}
  const detected = await detectNativeBuild(projectRoot, { ...(fsApi ? { fsApi } : {}) });
  const foundry = await detectNativeFoundry(projectRoot, { ...(fsApi ? { fsApi } : {}) });
  const embedded = await detectEmbeddedProfileBuild(projectRoot, { ...(fsApi ? { fsApi } : {}) });
  let solidityBuild;

  if (shouldUseHermeticStandardJson(request)) {
    solidityBuild = await compileHermetic({
      projectRoot,
      request,
      ...(runCommand ? { runCommand } : {}),
      ...(fsApi ? { fsApi } : {})
    });
  } else if (foundry.system === 'foundry-native') {
    solidityBuild = await compileRepoNativeFoundry({
      projectRoot,
      ...(runCommand ? { runCommand } : {}),
      ...(fsApi ? { fsApi } : {})
    });
  } else if (embedded.system === 'embedded-profile-native') {
    solidityBuild = await compileRepoEmbeddedProfiles({
      projectRoot,
      ...(runCommand ? { runCommand } : {}),
      ...(fsApi ? { fsApi } : {})
    });
  } else if (detected.system === 'hardhat-native') {
    const native = await compileRepoNativeHardhat({
      projectRoot,
      ...(runCommand ? { runCommand } : {}),
      ...(fsApi ? { fsApi } : {})
    });
    solidityBuild = {
      ...native,
      compilerVersion: compiler.version
    };
  } else {
    const sources = await collectSources(projectRoot);
    const compiled = await compileStandardJson({
      sources,
      compilerVersion: compiler.version,
      settings: {
        optimizer: request.configuration.optimizer,
        evmVersion: request.configuration.evmVersion,
        viaIR: request.configuration.viaIR
      }
    });
    solidityBuild = {
      status: 'completed',
      system: 'solc-standard-json',
      compilerVersion: compiler.version,
      compilerDiagnostics: compiled.diagnostics,
      compilerInput: compiled.input,
      compilerInputSha256: compiled.compilerInputSha256,
      compilerOutputSha256: compiled.compilerOutputSha256,
      sourceAsts: compiled.sourceAsts ?? {},
      artifacts: compiled.artifacts.all,
      sourceInventory: Object.keys(sources).sort(),
      sourceInventoryFiles: Object.keys(sources).length,
      compilationUnits:[{
        unitId:'standard-json-1',
        profile:'default',
        compilerVersion:compiler.version,
        compilerPackage:'solc',
        settings:compiled.input?.settings??null,
        compilerInputSha256:compiled.compilerInputSha256,
        compilerOutputSha256:compiled.compilerOutputSha256,
        sourceContents:sources,
        sourceAsts:compiled.sourceAsts??{},
        artifacts:compiled.artifacts.all
      }]
    };
  }

  const vyperCompiler = requestedVyperCompiler(request);
  if (!vyperCompiler) return solidityBuild;

  const vyperBuild = await compileVyper({
    projectRoot,
    compiler: vyperCompiler,
    evmVersion: request.configuration.evmVersion,
    ...(runCommand ? { runCommand } : {}),
    ...(fsApi ? { fsApi } : {})
  });
  // Treat every exact-source Vyper compilation as an independently identified
  // compiler unit, not a detached artifact. Phase 0 sealing and Slither consume
  // these identities to bind all deployed bytecode to the admitted source.
  const vyperUnits=[];
  for(const artifact of vyperBuild.artifacts ?? []){
    const sourceName=artifact.sourceName;
    const relative=path.posix.normalize(sourceName);
    if(relative.startsWith('../')||relative.startsWith('/')||!relative.startsWith('contracts/'))
      throw new Error('Vyper source must remain inside the admitted contracts/ tree: '+sourceName);
    const source=await fs.readFile(path.join(projectRoot,...relative.split('/')),'utf8');
    const sourceSha256=scanHash(source);
    const version=vyperCompiler.version;
    const unitId='vyper-'+scanHash(relative).slice(0,16);
    const fullArtifact={...artifact,language:'vyper',compilerVersion:version,
      compilationUnitId:unitId,profile:'source-vyper-'+version};
    const settings={language:'vyper',version,evmVersion:request.configuration.evmVersion??null};
    const compilerInputSha256=scanHash(JSON.stringify({sourceName:relative,sourceSha256,settings}));
    const compilerOutputSha256=scanHash(JSON.stringify({abi:artifact.abi,bytecode:artifact.bytecode,deployedBytecode:artifact.deployedBytecode}));
    vyperUnits.push({unitId,profile:'source-vyper-'+version,compilerVersion:version,
      compilerPackage:'vyper-cli',settings,sourceContents:{[relative]:source},sourceAsts:{},
      compilerInputSha256,compilerOutputSha256,artifacts:[fullArtifact]});
  }
  const vyperArtifacts=vyperUnits.flatMap(unit=>unit.artifacts);
  // Forge 1.7+ can emit a Vyper build-info unit while the source-bound
  // dedicated Vyper compiler above also emits its exact artifact. This is
  // duplicate compiler evidence, not two independently deployed contracts.
  // Retain the dedicated Vyper unit after verifying the native unit's source
  // and version; never silently discard a Solidity artifact or a mismatch.
  const nativeVyperUnits=solidityBuild.system==='foundry-native'
    ? (solidityBuild.compilationUnits??[]).filter(unit=>(unit.artifacts??[]).some(a=>a.sourceName.endsWith('.vy')))
    : [];
  for(const unit of nativeVyperUnits){
    if(unit.compilerVersion!==vyperCompiler.version)
      throw new Error('Foundry Vyper compiler version mismatch: '+unit.compilerVersion+' expected '+vyperCompiler.version);
    if((unit.artifacts??[]).some(a=>!a.sourceName.endsWith('.vy')))
      throw new Error('Foundry compiler unit unexpectedly mixes Solidity and Vyper artifacts: '+unit.unitId);
    for(const artifact of unit.artifacts){
      const relative=path.posix.normalize(artifact.sourceName);
      if(relative.startsWith('../')||relative.startsWith('/')||!relative.startsWith('contracts/'))
        throw new Error('Foundry Vyper source escapes admitted contracts tree: '+relative);
      const original=await fs.readFile(path.join(projectRoot,...relative.split('/')),'utf8');
      if(unit.sourceContents?.[relative]!==original)
        throw new Error('Foundry Vyper build-info source mismatch: '+relative);
      if(!vyperArtifacts.some(a=>a.sourceName===artifact.sourceName&&a.contractName===artifact.contractName))
        throw new Error('Dedicated Vyper compiler did not reproduce Foundry artifact identity: '+relative+':'+artifact.contractName);
    }
  }
  const skippedNativeUnitIds=new Set(nativeVyperUnits.map(unit=>unit.unitId));
  const retainedNativeUnits=(solidityBuild.compilationUnits??[]).filter(unit=>!skippedNativeUnitIds.has(unit.unitId));
  const retainedNativeArtifacts=(solidityBuild.artifacts??[]).filter(a=>!a.sourceName.endsWith('.vy'));
  const sourceInventory=[...new Set([...(solidityBuild.sourceInventory??[]),...(vyperBuild.sourceInventory??[])])].sort();
  const compilerVersions=[...new Set([...retainedNativeUnits.map(unit=>unit.compilerVersion),vyperCompiler.version])].sort();
  return {
    ...solidityBuild,
    compilerVersions,
    compilerProfiles:[...(solidityBuild.compilerProfiles??[]).filter(profile=>!skippedNativeUnitIds.has(profile.name)),...vyperUnits.map(unit=>({name:unit.unitId,compilerVersion:unit.compilerVersion,settings:unit.settings}))],
    compilationUnits:[...retainedNativeUnits,...vyperUnits],
    artifacts:mergeArtifacts(retainedNativeArtifacts,vyperArtifacts),
    sourceInventory,
    sourceInventoryFiles:sourceInventory.length,
    vyperBuild
  };
}
