import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../../github-native-sim/src/execution.mjs';
import { contractArtifactMap } from './compiler.mjs';

const EMBEDDED_PROFILE_FILES = Object.freeze([
  ['tooling','lib','compileSolc.mjs'],
  ['tooling','lib','deploymentSet.mjs'],
  ['package.json'],
  ['package-lock.json']
]);

const FULL_OUTPUT_SELECTION = Object.freeze([
  'abi',
  'metadata',
  'storageLayout',
  'devdoc',
  'userdoc',
  'evm.bytecode.object',
  'evm.bytecode.sourceMap',
  'evm.bytecode.linkReferences',
  'evm.deployedBytecode.object',
  'evm.deployedBytecode.sourceMap',
  'evm.deployedBytecode.linkReferences',
  'evm.methodIdentifiers',
  'evm.gasEstimates'
]);

function sha256(value){
  return createHash('sha256').update(value).digest('hex');
}

async function exists(file,fsApi=fs){
  try{return (await fsApi.stat(file)).isFile();}catch{return false;}
}

export async function detectEmbeddedProfileBuild(projectRoot,{fsApi=fs}={}){
  for(const parts of EMBEDDED_PROFILE_FILES){
    if(!await exists(path.join(projectRoot,...parts),fsApi))return{system:null};
  }
  return{
    system:'embedded-profile-native',
    compilerModule:'tooling/lib/compileSolc.mjs',
    deploymentSetModule:'tooling/lib/deploymentSet.mjs',
    lockfile:'package-lock.json'
  };
}

function diagnostics(output){
  return (output?.errors??[]).map(item=>({
    severity:item.severity,
    type:item.type,
    component:item.component,
    errorCode:item.errorCode,
    message:item.message,
    formattedMessage:item.formattedMessage,
    sourceLocation:item.sourceLocation
  }));
}

function normalizeSettings(settings){
  return JSON.parse(JSON.stringify(settings??{}));
}

function enrichedInput(standardInput){
  const input=JSON.parse(JSON.stringify(standardInput));
  input.settings??={};
  input.settings.outputSelection={'*':{'*':[...FULL_OUTPUT_SELECTION],'':['ast']}};
  return input;
}

function mergeFirstAsts(units){
  const out={};
  for(const unit of units){
    for(const [sourceName,ast] of Object.entries(unit.sourceAsts??{})){
      if(!(sourceName in out))out[sourceName]=ast;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));
}

function cleanProfileRecord(name,profile,compilerVersion){
  return{
    name,
    compilerPackage:profile?.solc??null,
    compilerVersion,
    openZeppelinPackage:profile?.openZeppelin??null,
    settings:normalizeSettings(profile?.settings??{}),
    sourceRoot:profile?.sourceRoot?String(profile.sourceRoot):null
  };
}

export async function compileRepoEmbeddedProfiles({
  projectRoot,
  runCommand=runProcess,
  fsApi=fs
}){
  const detected=await detectEmbeddedProfileBuild(projectRoot,{fsApi});
  if(detected.system!=='embedded-profile-native')throw new Error('Repository is not an admitted embedded-profile build');

  const install=await runCommand({
    command:'npm',
    args:['ci','--ignore-scripts','--no-audit','--no-fund'],
    cwd:projectRoot
  });
  if(!install||install.exitCode!==0){
    const error=new Error('Embedded-profile locked dependency installation failed');
    error.code='embedded_profile_dependency_install_failed';
    error.result={exitCode:Number.isInteger(install?.exitCode)?install.exitCode:-1,stdout:String(install?.stdout??''),stderr:String(install?.stderr??'')};
    throw error;
  }

  const deploymentUrl=pathToFileURL(path.join(projectRoot,...detected.deploymentSetModule.split('/'))).href;
  const compilerUrl=pathToFileURL(path.join(projectRoot,...detected.compilerModule.split('/'))).href;
  const deploymentModule=await import(deploymentUrl);
  const compilerModule=await import(compilerUrl);
  if(typeof deploymentModule.compileDeploymentSet!=='function'||!Array.isArray(deploymentModule.COMPILE_GROUPS)){
    throw new Error('Embedded deployment-set module does not expose compileDeploymentSet/COMPILE_GROUPS');
  }
  if(!compilerModule.COMPILER_PROFILES||typeof compilerModule.COMPILER_PROFILES!=='object'){
    throw new Error('Embedded compiler module does not expose COMPILER_PROFILES');
  }

  const native=deploymentModule.compileDeploymentSet({log:()=>{}});
  const baseArtifacts=native?.artifacts??{};
  const standardInputs=native?.standardInputs??{};
  const requireFromProject=createRequire(path.join(projectRoot,'package.json'));

  const unitByKey=new Map();
  const unitForContract=new Map();
  for(const [contractName,baseArtifact] of Object.entries(baseArtifacts)){
    const standardInput=standardInputs[contractName];
    if(!standardInput)throw new Error(`Embedded profile build missing standard input for ${contractName}`);
    const profileName=baseArtifact?.profile;
    const profile=compilerModule.COMPILER_PROFILES[profileName];
    if(!profile?.solc)throw new Error(`Embedded profile ${profileName} for ${contractName} has no compiler package`);
    const input=enrichedInput(standardInput);
    const inputBytes=Buffer.from(JSON.stringify(input));
    const key=`${profileName}:${sha256(inputBytes)}`;
    let unit=unitByKey.get(key);
    if(!unit){
      const solc=requireFromProject(profile.solc);
      const outputText=solc.compile(JSON.stringify(input));
      const output=JSON.parse(outputText);
      const unitDiagnostics=diagnostics(output);
      if(unitDiagnostics.some(item=>item.severity==='error')){
        const error=new Error(`Embedded profile Solidity compilation failed for ${profileName}`);
        error.code='embedded_profile_compilation_failed';
        error.result={profileName,diagnostics:unitDiagnostics};
        throw error;
      }
      const unitId=`profile-${profileName}-${sha256(inputBytes).slice(0,12)}`;
      const unitArtifacts=contractArtifactMap(output).all.map(artifact=>({
        ...artifact,
        profile:profileName,
        compilerVersion:String(solc.version()),
        compilationUnitId:unitId
      }));
      unit={
        unitId,
        profile:profileName,
        compilerVersion:String(solc.version()),
        compilerPackage:profile.solc,
        settings:normalizeSettings(input.settings),
        compilerInputSha256:sha256(inputBytes),
        compilerOutputSha256:sha256(Buffer.from(outputText)),
        diagnostics:unitDiagnostics,
        sourceAsts:Object.fromEntries(
          Object.entries(output.sources??{})
            .filter(([,value])=>value?.ast)
            .map(([sourceName,value])=>[sourceName,value.ast])
            .sort(([a],[b])=>a.localeCompare(b))
        ),
        sourceContents:Object.fromEntries(
          Object.entries(input.sources??{})
            .map(([sourceName,value])=>[sourceName,String(value?.content??'')])
            .sort(([a],[b])=>a.localeCompare(b))
        ),
        artifacts:unitArtifacts
      };
      unitByKey.set(key,unit);
    }
    unitForContract.set(contractName,unit);
  }

  const selectedArtifacts=[];
  for(const [contractName,baseArtifact] of Object.entries(baseArtifacts)){
    const unit=unitForContract.get(contractName);
    const matches=unit.artifacts.filter(a=>a.contractName===contractName&&a.sourceName===baseArtifact.sourceName);
    if(matches.length!==1)throw new Error(`Embedded compiled artifact resolution failed for ${baseArtifact.sourceName}:${contractName}`);
    selectedArtifacts.push(matches[0]);
  }
  selectedArtifacts.sort((a,b)=>`${a.sourceName}:${a.contractName}`.localeCompare(`${b.sourceName}:${b.contractName}`));

  const units=[...unitByKey.values()].sort((a,b)=>a.unitId.localeCompare(b.unitId));
  const compilerProfiles=[];
  for(const [name,profile] of Object.entries(compilerModule.COMPILER_PROFILES)){
    if(!selectedArtifacts.some(a=>a.profile===name))continue;
    const representative=units.find(unit=>unit.profile===name);
    compilerProfiles.push(cleanProfileRecord(name,profile,representative?.compilerVersion??null));
  }
  compilerProfiles.sort((a,b)=>a.name.localeCompare(b.name));

  const sourceInventory=[...new Set(units.flatMap(unit=>Object.keys(unit.sourceContents)))].sort();
  const allDiagnostics=units.flatMap(unit=>unit.diagnostics.map(item=>({...item,compilationUnitId:unit.unitId,profile:unit.profile})));
  return{
    status:'completed',
    system:'embedded-profile-native',
    compilerVersion:'multi-profile',
    compilerVersions:[...new Set(units.map(unit=>unit.compilerVersion))].sort(),
    compilerProfiles,
    compilerDiagnostics:allDiagnostics,
    deploymentOrder:Array.isArray(deploymentModule.DEPLOY_ORDER)?[...deploymentModule.DEPLOY_ORDER]:[],
    compileGroups:deploymentModule.COMPILE_GROUPS.map((group,index)=>({
      groupIndex:index,
      profile:group.profile,
      entries:[...(group.entries??[])],
      names:[...(group.names??[])]
    })),
    artifacts:selectedArtifacts,
    sourceAsts:mergeFirstAsts(units),
    sourceInventory,
    sourceInventoryFiles:sourceInventory.length,
    compilationUnits:units,
    embeddedBuildContract:{
      compilerModule:detected.compilerModule,
      deploymentSetModule:detected.deploymentSetModule,
      lockfile:detected.lockfile
    }
  };
}
