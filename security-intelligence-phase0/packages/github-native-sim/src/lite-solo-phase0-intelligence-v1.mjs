#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import unzipper from 'unzipper';
import { checkoutExactSource, runProcess } from './execution.mjs';
import { buildProject } from '../../runner/src/build-dispatch.mjs';
import { runSlitherAnalysis } from './analysis.mjs';
import { resolveCompiledSourceFile } from './phase0-compiled-source-resolve-v1.mjs';
import { generateBuildSbomV1 } from './sbom-v1.mjs';
import { generateSourceIntelligenceTechnicalBundleV1 } from './source-intelligence-technical-v1.mjs';
import { writeReviewInventoryOutputsV1 } from './adr-review-inventory-v1.mjs';
import { buildExecutionArtifactBundleV2, buildContractIdentityIndexV1 } from './phase0-execution-input-v2.mjs';
import { compileWithPrivateCacheV1 } from './phase0-private-build-cache-v1.mjs';
import { loadAuditScope, sourceIsInScope } from './phase0-audit-scope-v1.mjs';

// The outer workflow owns the hard wall-clock timeout. This helper reports
// per-stage progress without changing compilation or evidence semantics.
const PHASE0_LOG_PREFIX='[phase0-intelligence-primary]';
async function withProgressStage(name,operation){
  const started=Date.now();
  console.error(`${PHASE0_LOG_PREFIX} START ${name}`);
  const heartbeat=setInterval(()=>console.error(`${PHASE0_LOG_PREFIX} ACTIVE ${name} elapsed_seconds=${Math.floor((Date.now()-started)/1000)}`),20000);
  heartbeat.unref?.();
  try{
    const result=await operation();
    console.error(`${PHASE0_LOG_PREFIX} DONE ${name} elapsed_seconds=${Math.floor((Date.now()-started)/1000)}`);
    return result;
  }catch(error){
    console.error(`${PHASE0_LOG_PREFIX} FAILED ${name} elapsed_seconds=${Math.floor((Date.now()-started)/1000)} reason=${String(error?.message??error).slice(0,220)}`);
    throw error;
  }finally{clearInterval(heartbeat);}
}

function parseArgs(argv){const o={};for(let i=0;i<argv.length;i++){const t=argv[i];if(!t.startsWith('--'))continue;const k=t.slice(2);const n=argv[i+1];if(n!==undefined&&!n.startsWith('--')){o[k]=n;i++;}else o[k]=true;}return o;}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function safeRel(v,label){if(typeof v!=='string'||!v||v.startsWith('/')||v.includes('\\')||v.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error(`${label} must be a safe repository-relative path`);return v;}
function cleanText(v){return String(v??'').replace(/\u001b\[[0-9;]*m/g,'');}
function slitherCompilerVersion(v){const m=String(v??'').match(/^(\d+\.\d+\.\d+)/);return m?m[1]:String(v??'');}
async function exists(file){try{return(await fs.stat(file)).isFile();}catch{return false;}}
async function isDir(file){try{return(await fs.stat(file)).isDirectory();}catch{return false;}}
function archiveEntryIsSymlink(entry){const attrs=Number(entry?.vars?.externalFileAttributes??0);const unix=(attrs>>>16)&0xffff;return(unix&0o170000)===0o120000;}
function archiveRel(p){const n=String(p??'').replaceAll('\\','/');const dir=n.endsWith('/');const t=dir?n.slice(0,-1):n;if(!t||t.startsWith('/')||/^[A-Za-z]:\//.test(t))throw new Error(`unsafe archive entry ${p}`);const parts=t.split('/');if(parts.some(x=>!x||x==='.'||x==='..'))throw new Error(`unsafe archive entry ${p}`);return{relative:parts.join('/'),dir};}

async function extractArchive(zipPath, out){
  const opened=await unzipper.Open.file(zipPath);
  await fs.rm(out,{recursive:true,force:true});
  await fs.mkdir(out,{recursive:true});
  let bytes=0;
  for(const entry of opened.files){
    if(archiveEntryIsSymlink(entry))throw new Error(`symlink archive entry forbidden: ${entry.path}`);
    const p=archiveRel(entry.path); const dest=path.join(out,...p.relative.split('/'));
    if(p.dir||entry.type==='Directory'){await fs.mkdir(dest,{recursive:true});continue;}
    const data=await entry.buffer(); bytes+=data.length;
    if(bytes>250*1024*1024)throw new Error('archive extracted bytes exceed safety cap');
    await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.writeFile(dest,data);
  }
  return{entryCount:opened.files.length,extractedBytes:bytes};
}

async function walk(root){
  const files=[];
  async function rec(dir){
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      if(['node_modules','.git','artifacts','cache','out','dist','build'].includes(e.name))continue;
      const abs=path.join(dir,e.name);
      const rel=path.relative(root,abs).split(path.sep).join('/');
      if(rel.split('/').some(x=>x.toUpperCase()==='ARCHIVE DO NOT USE'))continue;
      if(e.isDirectory())await rec(abs); else if(e.isFile())files.push(rel);
    }
  }
  await rec(root); return files.sort();
}

async function detectProjectRoot(extractRoot){
  const files=await walk(extractRoot);
  const sourceFiles=files.filter(f=>/\.(?:sol|vy)$/i.test(f));
  if(!sourceFiles.length)throw new Error('no Solidity or Vyper source in admitted archive');
  const candidates=new Set();
  const config=/^(?:foundry\.toml|package\.json|package-lock\.json|npm-shrinkwrap\.json|scan-source-manifest\.json|hardhat\.config\.(?:js|cjs|mjs|ts))$/;
  for(const f of files){
    const base=path.posix.basename(f);
    if(config.test(base))candidates.add(path.posix.dirname(f));
    const m=f.match(/^(?:(.*?)\/)?(?:contracts|src)\/.+\.(?:sol|vy)$/i);
    if(m)candidates.add(m[1]||'.');
  }
  // A Vyper-only or source-only archive has no build configuration and is still
  // admissible for source inspection. Nested projects stay independently listed.
  if(!candidates.size)candidates.add('.');
  const scored=[];
  for(const rel0 of candidates){
    const rel=rel0==='.'?'':rel0;
    if(rel.toUpperCase().includes('ARCHIVE DO NOT USE'))continue;
    const prefix=rel?rel+'/':'';
    const child=sourceFiles.filter(f=>f.startsWith(prefix));
    if(!child.length)continue;
    const sol=child.filter(f=>f.endsWith('.sol')).length;
    const vyper=child.filter(f=>f.endsWith('.vy')).length;
    const names=new Set(files.filter(f=>f.startsWith(prefix)&&!f.slice(prefix.length).includes('/')).map(f=>f.slice(prefix.length)));
    const hasFoundry=names.has('foundry.toml');
    const hasPkg=names.has('package.json');
    const hasLock=names.has('package-lock.json')||names.has('npm-shrinkwrap.json');
    const hasHardhat=[...names].some(n=>/^hardhat\.config\.(js|cjs|mjs|ts)$/.test(n));
    const hasContracts=child.some(f=>f.startsWith(prefix+'contracts/'));
    const hasTooling=files.some(f=>f.startsWith(prefix+'tooling/'));
    const hasVendor=files.some(f=>f.startsWith(prefix+'vendor/'));
    const hasScanManifest=names.has('scan-source-manifest.json');
    const depth=rel?rel.split('/').length:0;
    const dependencyLikely=rel.split('/').some(x=>['vendor','lib','node_modules'].includes(x));
    const score=(hasFoundry?240:0)+(hasScanManifest?235:0)+(hasPkg?120:0)+(hasLock?110:0)+(hasContracts?100:0)+(hasHardhat?70:0)+(hasTooling?60:0)+(hasVendor?40:0)+Math.min(sol+vyper,80)-depth-(dependencyLikely?150:0);
    scored.push({relativePath:rel||'.',score,solidityFiles:sol,vyperFiles:vyper,hasFoundry,hasPkg,hasLock,hasHardhat,hasContracts,hasTooling,hasVendor,hasScanManifest,dependencyLikely,
      hasDeploymentProfile:hasHardhat&&hasPkg&&hasLock&&files.includes(prefix+'audit-deployment.json')});
  }
  scored.sort((a,b)=>Number(b.hasDeploymentProfile)-Number(a.hasDeploymentProfile)||
    b.score-a.score||(b.solidityFiles+b.vyperFiles)-(a.solidityFiles+a.vyperFiles)||
    a.relativePath.localeCompare(b.relativePath));
  if(!scored.length)throw new Error('no supported project root in admitted archive');
  const winner=scored[0];
  const absolute=winner.relativePath==='.'?extractRoot:path.join(extractRoot,...winner.relativePath.split('/'));
  // No silent best-root-only claim: all candidates are returned, including
  // additional independently configured roots that need distinct compilation.
  const separate=scored.filter(x=>x.relativePath!==winner.relativePath&&
    (x.hasFoundry||x.hasHardhat||x.hasScanManifest||
      !(x.relativePath.startsWith(winner.relativePath+'/')||winner.relativePath==='.')));
  return{absolute,relativePath:winner.relativePath,candidates:scored,projects:scored,
    additionalProjectRoots:separate.map(x=>x.relativePath),multipleProjects:separate.length>0,
    selectionBasis:'DETERMINISTIC_HIGHEST_CONFIDENCE_ROOT_NOT_PROOF_OTHER_ROOTS_BUILT'};
}

async function readMaybe(file){try{return await fs.readFile(file,'utf8');}catch{return'';}}
function exactSemver(v){const m=String(v??'').match(/(?:^|[^0-9])(\d+\.\d+\.\d+)(?:[^0-9]|$)/);return m?.[1]??null;}
async function detectBuildConfig(projectRoot){
  const evidence=[];
  let pkg={},lock={};
  const pkgPath=path.join(projectRoot,'package.json'), lockPath=path.join(projectRoot,'package-lock.json');
  if(await exists(pkgPath)){pkg=JSON.parse(await fs.readFile(pkgPath,'utf8'));evidence.push('package.json');}
  if(await exists(lockPath)){lock=JSON.parse(await fs.readFile(lockPath,'utf8'));evidence.push('package-lock.json');}
  const configNames=(await fs.readdir(projectRoot)).filter(n=>/^hardhat\.config\.(js|cjs|mjs|ts)$/.test(n));
  const texts=[];
  for(const n of configNames){texts.push({path:n,text:await readMaybe(path.join(projectRoot,n))});evidence.push(n);}
  for(const rel of ['tooling/lib/compileSolc.mjs','tooling/lib/compileSolc.js','tooling/scripts/curveYieldDexBytecodeSize.mjs']){
    const abs=path.join(projectRoot,...rel.split('/')); if(await exists(abs)){texts.push({path:rel,text:await readMaybe(abs)});evidence.push(rel);}
  }
  const candidates=[];
  const foundryText=await readMaybe(path.join(projectRoot,'foundry.toml'));
  const foundryDefault=foundryText.match(/^\[profile\.default\][^\S\r\n]*(?:\r?\n|$)([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1]??'';
  const foundryVersion=foundryDefault.match(/^\s*solc(?:_version)?\s*=\s*['"](\d+\.\d+\.\d+)['"]\s*(?:#.*)?$/m)?.[1];
  if(foundryVersion){candidates.push({version:foundryVersion,basis:'foundry.toml profile.default',label:'explicit Foundry compiler',priority:120});evidence.push('foundry.toml');}
  for(const t of texts){
    for(const [re,priority,label] of [
      [/solidity\s*:\s*['"](\d+\.\d+\.\d+)['"]/g,120,'explicit solidity version'],
      [/SOLC_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/g,120,'explicit SOLC_VERSION'],
      [/version\s*:\s*['"](\d+\.\d+\.\d+)['"]/g,100,'version field']
    ]){
      for(const m of t.text.matchAll(re))candidates.push({version:m[1],basis:t.path,label,priority});
    }
  }
  const pkgSolc=pkg?.devDependencies?.solc??pkg?.dependencies?.solc;
  if(exactSemver(pkgSolc))candidates.push({version:exactSemver(pkgSolc),basis:'package.json solc',label:'declared solc dependency',priority:80});
  const lockSolc=lock?.packages?.['node_modules/solc']?.version;
  if(exactSemver(lockSolc))candidates.push({version:exactSemver(lockSolc),basis:'package-lock node_modules/solc',label:'locked solc package',priority:60});
  // With Foundry auto_detect_solc=true, compiler versions are selected per
  // Solidity compilation unit. The provisional envelope compiler below is
  // not an assertion that all Solidity sources use the same compiler.
  const foundryAutoDetect=/^\s*auto_detect_solc\s*=\s*true(?:\s*(?:#.*)?)?$/m.test(foundryDefault);
  const detectedPragmaVersions=[];
  if(!candidates.length && foundryAutoDetect){
    const srcRoot=foundryDefault.match(/^\s*src\s*=\s*["']([^"']+)["']/m)?.[1]??'src';
    if(srcRoot.startsWith('/')||srcRoot.split('/').includes('..'))throw new Error('unsafe Foundry source root');
    for(const rel of (await walk(projectRoot)).filter(rel=>rel.startsWith(srcRoot+'/')&&rel.endsWith('.sol'))){
      const raw=await readMaybe(path.join(projectRoot,...rel.split('/')));
      for(const match of raw.matchAll(/\bpragma\s+solidity\s+([^;]+);/g)){
        const version=exactSemver(match[1]);
        if(version)detectedPragmaVersions.push({version,path:rel,pragma:match[1].trim()});
      }
    }
    if(!detectedPragmaVersions.length)throw new Error('Foundry auto_detect_solc has no source-bound compiler pragmas');
    const byVersion=[...new Set(detectedPragmaVersions.map(x=>x.version))].sort((left,right)=>{
      const A=left.split('.').map(Number),B=right.split('.').map(Number);
      return (B[0]-A[0])||(B[1]-A[1])||(B[2]-A[2]);
    });
    candidates.push({version:byVersion[0],basis:'foundry.toml auto_detect_solc and admitted source pragmas',
      label:'Provisional request compiler; actual versions are compiler-unit-specific',priority:40});
    evidence.push('foundry.toml auto_detect_solc','admitted Solidity pragmas ('+detectedPragmaVersions.length+')');
  }
  candidates.sort((a,b)=>b.priority-a.priority||a.basis.localeCompare(b.basis));
  if(!candidates.length){
    const vyperOnly=(await walk(projectRoot)).some(rel=>rel.endsWith('.vy')) &&
      !(await walk(projectRoot)).some(rel=>rel.endsWith('.sol'));
    if(vyperOnly)return{compilerVersion:null,compilerCandidates:[],foundryAutoDetectSolc:false,
      admittedSolidityPragmas:[],vyperOnly:true,optimizer:{enabled:false,runs:0},
      viaIR:false,evmVersion:null,evidence:['SOURCE_ONLY_VYPER_COMPILER_REQUIRED']};
    throw new Error('unable to detect exact Solidity compiler version from source package');
  }
  const topPriority=candidates[0].priority;
  const topVersions=[...new Set(candidates.filter(x=>x.priority===topPriority).map(x=>x.version))];
  if(topVersions.length>1)throw new Error(`conflicting explicit Solidity compiler versions: ${topVersions.join(', ')}`);
  const compiler=candidates[0];
  const allText=texts.map(x=>x.text).join('\n');
  const opt=allText.match(/optimizer\s*:\s*\{[\s\S]{0,240}?enabled\s*:\s*(true|false)[\s\S]{0,240}?runs\s*:\s*(\d+)/);
  const runs=opt?Number(opt[2]):Number(foundryDefault.match(/^\s*optimizer_runs\s*=\s*(\d+)/m)?.[1]??200); const enabled=opt?opt[1]==='true':!foundryText||foundryDefault.match(/^\s*optimizer\s*=\s*(true|false)/m)?.[1]==='true';
  const via=allText.match(/viaIR\s*:\s*(true|false)/);
  const evm=allText.match(/evmVersion\s*:\s*['"]([^'"]+)['"]/);
  return{compilerVersion:compiler.version,compilerCandidates:candidates,foundryAutoDetectSolc:foundryAutoDetect,admittedSolidityPragmas:detectedPragmaVersions,optimizer:{enabled,runs},viaIR:via?via[1]==='true':foundryDefault.match(/^\s*via_ir\s*=\s*(true|false)/m)?.[1]==='true',evmVersion:evm?.[1]??foundryDefault.match(/^\s*evm_version\s*=\s*['"]([^'"]+)['"]/m)?.[1]??null,evidence};
}


function sourceIsDependency(sourceName,scope){
  return !sourceIsInScope(sourceName,scope);
}
async function writeCryticCompileExport({projectRoot,build,outDir}){
  const scope=await loadAuditScope(projectRoot);
  const buildUnits=(Array.isArray(build?.compilationUnits)&&build.compilationUnits.length)
    ? build.compilationUnits.map((unit,index)=>({
        unitId:unit.unitId??`unit-${index+1}`,
        compilerVersion:unit.compilerVersion??build.compilerVersion??'',
        settings:unit.settings??{},
        // Older/native builds may keep ASTs only at build level: use those for this unit's sources.
        sourceAsts:Object.keys(unit.sourceAsts??{}).length?unit.sourceAsts:Object.fromEntries(Object.entries(build?.sourceAsts??{}).filter(([name])=>
          Object.prototype.hasOwnProperty.call(unit.sourceContents??{},name)||(unit.artifacts??[]).some(a=>a?.sourceName===name)||(build.compilationUnits.length===1))),
        sourceContents:unit.sourceContents??{},
        artifacts:Array.isArray(unit.artifacts)?unit.artifacts:[]
      }))
    : [{
        unitId:'phase0',
        compilerVersion:build?.compilerVersion??'',
        settings:{optimizer:{enabled:true}},
        sourceAsts:build?.sourceAsts??{},
        sourceContents:{},
        artifacts:Array.isArray(build?.artifacts)?build.artifacts:[]
      }];
  if(!buildUnits.some(unit=>Object.keys(unit.sourceAsts).length))throw new Error('Slither exact-build export requires compiler ASTs');
  if(!buildUnits.some(unit=>unit.artifacts.length))throw new Error('Slither exact-build export requires compiler artifacts');

  await fs.rm(outDir,{recursive:true,force:true});
  await fs.mkdir(outDir,{recursive:true});
  const compilation_units={};
  let sourceUnitCount=0,contractCount=0;

  for(const buildUnit of buildUnits){
    const bySource=new Map();
    const sourceNames=[...new Set([
      ...Object.keys(buildUnit.sourceAsts??{}),
      ...Object.keys(buildUnit.sourceContents??{}),
      ...buildUnit.artifacts.map(artifact=>artifact.sourceName).filter(Boolean)
    ])].sort();
    for(const sourceName of sourceNames){
      let absolute;
      // Only materialize real embedded contents; null placeholders resolve from the staged project.
      if(typeof buildUnit.sourceContents?.[sourceName]==='string'){
        const safeName=sourceName.split('/').map(part=>part==='..'?'__parent__':part.replace(/[^A-Za-z0-9._@+-]/g,'_')).join('/');
        absolute=path.join(outDir,'materialized',buildUnit.unitId,...safeName.split('/'));
        await fs.mkdir(path.dirname(absolute),{recursive:true});
        await fs.writeFile(absolute,String(buildUnit.sourceContents[sourceName]));
      }else{
        absolute=await resolveCompiledSourceFile(projectRoot,sourceName);
      }
      const filename={absolute,relative:sourceName,short:sourceName,used:sourceName};
      bySource.set(sourceName,{ast:buildUnit.sourceAsts?.[sourceName]??null,contracts:{},filename});
    }

    for(const artifact of buildUnit.artifacts){
      const sourceName=artifact.sourceName;
      if(!bySource.has(sourceName)){
        const absolute=await resolveCompiledSourceFile(projectRoot,sourceName);
        bySource.set(sourceName,{ast:null,contracts:{},filename:{absolute,relative:sourceName,short:sourceName,used:sourceName}});
      }
      const sourceUnit=bySource.get(sourceName);
      sourceUnit.contracts[artifact.contractName]={
        abi:artifact.abi??[],
        bin:String(artifact.bytecode??'0x').replace(/^0x/,''),
        'bin-runtime':String(artifact.deployedBytecode??'0x').replace(/^0x/,''),
        srcmap:artifact.bytecodeSourceMap??'',
        'srcmap-runtime':artifact.deployedBytecodeSourceMap??'',
        filenames:sourceUnit.filename,
        libraries:{},
        is_dependency:sourceIsDependency(sourceName,scope),
        userdoc:artifact.userdoc??{},
        devdoc:artifact.devdoc??{}
      };
      contractCount++;
    }

    const source_units={};
    const filenames=[];
    for(const [sourceName,sourceUnit] of [...bySource.entries()].sort(([a],[b])=>a.localeCompare(b))){
      source_units[sourceName]={ast:sourceUnit.ast,contracts:sourceUnit.contracts};
      filenames.push(sourceUnit.filename);
      sourceUnitCount++;
    }
    compilation_units[buildUnit.unitId]={
      compiler:{
        compiler:sourceNames.some(name=>name.endsWith('.vy'))?'vyper':'solc',
        version:slitherCompilerVersion(buildUnit.compilerVersion),
        optimized:buildUnit.settings?.optimizer?.enabled!==false
      },
      source_units,
      filenames
    };
  }

  const payload={
    compilation_units,
    package:null,
    working_dir:projectRoot,
    type:10,
    unit_tests:[],
    crytic_version:'0.0.2'
  };
  const exportPath=path.join(outDir,'phase0_export.json');
  await fs.writeFile(exportPath,JSON.stringify(payload));
  return{exportPath,sourceUnitCount,contractCount,compilationUnitCount:Object.keys(compilation_units).length};
}
// Slither 0.11.6/crytic-compile 0.4.x cannot parse Vyper 0.4.3
// sourceMap (dictionary instead of string), and the 0.4 AST node schema.
// Analyze the exact admitted Vyper AST with its own compiler instead of
// misreporting Vyper as Slither-covered. Record limitations for later phases.
async function runExactVyperAstStaticV1({projectRoot,unit,sourceName}){
  const source=await resolveCompiledSourceFile(projectRoot,sourceName);
  const admitted=unit.sourceContents?.[sourceName];
  if(typeof admitted!=='string')throw new Error('Vyper static analysis requires admitted exact source contents: '+sourceName);
  const observed=await fs.readFile(source,'utf8');
  if(observed!==admitted)throw new Error('Vyper AST source differs from admitted build: '+sourceName);
  const version=String(unit.compilerVersion??'');
  if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Vyper AST lacks exact compiler version');
  const probe=await runProcess({command:'vyper',args:['--version'],cwd:projectRoot,timeoutMs:30000});
  if(probe.exitCode!==0||!String(probe.stdout??'').trim().startsWith(version))
    throw new Error('Vyper AST compiler version mismatch: expected '+version);
  const compiled=await runProcess({command:'vyper',args:['-f','ast',sourceName],cwd:projectRoot,timeoutMs:120000});
  if(compiled.exitCode!==0)throw new Error('Vyper AST source analysis compiler failed: '+String(compiled.stderr??'').slice(-1500));
  let parsed;
  try{parsed=JSON.parse(compiled.stdout)}catch{throw new Error('Vyper AST output is not valid JSON: '+sourceName)}
  const root=parsed?.ast;
  if(!root||root.ast_type!=='Module'||!Array.isArray(root.body))throw new Error('Vyper AST root invalid: '+sourceName);
  const functions=[],sensitiveCalls=[],externalEntryPoints=[],stateWrites=[];
  let nodeCount=0;
  const sensitive=new Set(['raw_call','send','selfdestruct','delegatecall','create_forwarder_to','create_minimal_proxy_to','create_copy_of','create_from_blueprint','unsafe_add','unsafe_sub','unsafe_mul','unsafe_div','convert','staticcall','extcall','raw_log']);
  const seenObjects=new Set();
  function callableName(node){
    if(!node||typeof node!=='object')return '';
    if(node.ast_type==='Name')return String(node.id??'');
    if(node.ast_type==='Attribute')return callableName(node.value)+'.'+String(node.attr??'');
    return '';
  }
  function visit(node,context){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const n of node)visit(n,context);return}
    if(seenObjects.has(node))return;seenObjects.add(node);
    const type=node.ast_type;
    if(typeof type==='string')nodeCount++;
    let nextContext=context;
    if(type==='FunctionDef'){
      const decorators=Array.isArray(node.decorator_list)?node.decorator_list.map(callableName):[];
      const item={name:String(node.name??''),line:Number(node.lineno??0),decorators,
        external:decorators.includes('external'),nonreentrant:decorators.some(x=>x.includes('nonreentrant'))};
      if(!item.name||item.line<1)throw new Error('Vyper AST function lacks source anchor');
      functions.push(item);
      if(item.external)externalEntryPoints.push(item);
      nextContext=item;
    }
    if(type==='Call'){
      const name=callableName(node.func);
      if(sensitive.has(name)||name.startsWith('extcall')||name.startsWith('staticcall')){
        sensitiveCalls.push({function:nextContext?.name??'<module>',call:name,line:Number(node.lineno??nextContext?.line??0)});
      }
    }
    if(['Assign','AugAssign','AnnAssign'].includes(type)){
      const target=node.target;
      const name=callableName(target);
      if(name.startsWith('self.'))stateWrites.push({function:nextContext?.name??'<module>',target:name,line:Number(node.lineno??0)});
    }
    for(const [key,value] of Object.entries(node)){
      if(['node_id','src','node_source_code','folded_value','type','_metadata'].includes(key))continue;
      if(value&&typeof value==='object')visit(value,nextContext);
    }
  }
  visit(root,null);
  if(!nodeCount||!functions.length||!externalEntryPoints.length)
    throw new Error('Vyper AST structural inventory incomplete: '+sourceName);
  for(const call of sensitiveCalls)if(call.line<1)throw new Error('Unanchored Vyper sensitive call: '+call.call);
  return{
    analyzer:'vyper-0.4.3-compiler-ast-inventory-v1',
    engine:'vyper-cli',
    slitherCompatible:false,
    sourceName,compilerVersion:version,
    sourceSha256:sha256(Buffer.from(admitted,'utf8')),
    astSha256:sha256(Buffer.from(JSON.stringify(root),'utf8')),
    nodeCount,functions,externalEntryPoints,sensitiveCalls,stateWrites,
    reviewRequired:true,
    limitations:['Slither 0.11.6 Vyper 0.4.3 semantic detectors are unavailable; source-anchored AST structural surfaces are retained for required Phase 4–6 semantic review.']
  };
}

const SLITHER_RELATIONAL_API_V1=String.raw`
import json,sys
from slither.slither import Slither
from slither.analyses.data_dependency.data_dependency import get_dependencies

def safe_text(v):
    if v is None: return None
    try: return str(v)
    except Exception: return None

def source_span(obj):
    span=getattr(obj,"source_mapping",None)
    if span is None: return None
    fn=getattr(span,"filename",None)
    return {"file":safe_text(getattr(fn,"relative",None) or getattr(fn,"short",None) or getattr(fn,"absolute",None)),
            "start":getattr(span,"start",None),"length":getattr(span,"length",None),
            "lines":list(getattr(span,"lines",[]) or [])}

def variable_ref(v):
    if v is None: return None
    return {"name":safe_text(getattr(v,"name",None) or v),"type":type(v).__name__,
            "sourceSpan":source_span(v)}

def as_list(v):
    if v is None: return []
    try: return list(v)
    except Exception: return []

unit=sys.argv[2]
result={"schemaVersion":"mi-phase0-slither-relational-unit-v1",
        "unitId":unit,"analyzer":"slither-0.11.6-python-api",
        "contracts":[],"limitations":[],"functionCount":0,"callsiteCount":0,"ssaEdgeCount":0}
analysis=Slither(sys.argv[1],compile_force_framework="standard")
call_kinds={"HighLevelCall","LowLevelCall","LibraryCall","InternalCall","InternalDynamicCall",
            "SolidityCall","Transfer","Send","NewContract","EventCall"}

for contract in analysis.contracts:
    origin=source_span(contract)
    c={"contractName":contract.name,"sourceName":origin["file"] if origin else None,
       "sourceSpan":origin,"functions":[],"limitations":[]}
    for function in as_list(getattr(contract,"functions_and_modifiers_declared",[])):
        fspan=source_span(function)
        f={"name":function.name,"fullName":safe_text(getattr(function,"full_name",None)),
           "soliditySignature":safe_text(getattr(function,"solidity_signature",None)),
           "sourceSpan":fspan,"sourceName":fspan["file"] if fspan else None,
           "visibility":safe_text(getattr(function,"visibility",None)),
           "isConstructor":bool(getattr(function,"is_constructor",False)),
           "isModifier":bool(getattr(function,"is_modifier",False)),
           "parameters":[variable_ref(v) for v in as_list(getattr(function,"parameters",[]))],
           "returnVariables":[variable_ref(v) for v in as_list(getattr(function,"returns",[]))],
           "readStorageIds":[variable_ref(v) for v in as_list(getattr(function,"state_variables_read",[]))],
           "writtenStorageIds":[variable_ref(v) for v in as_list(getattr(function,"state_variables_written",[]))],
           "callSites":[],"directIrSsaDependencies":[],"variableDependencies":[],
           "sourceNodeCount":0,"limitations":[]}
        for node in as_list(getattr(function,"nodes",[])):
            nspan=source_span(node)
            f["sourceNodeCount"]+=1
            for opOrdinal,ir in enumerate(as_list(getattr(node,"irs",[]))):
                kind=type(ir).__name__
                if kind not in call_kinds: continue
                callee=getattr(ir,"function",None)
                f["callSites"].append({
                    "kind":kind,"operationOrdinal":opOrdinal,"sourceNodeId":getattr(node,"node_id",None),
                    "ir":safe_text(ir),
                    "calleeSignature":safe_text(getattr(callee,"solidity_signature",None)),
                    "calleeName":safe_text(callee),
                    "calleeDeclarationSpan":source_span(callee),
                    "calleeDeclaringContractName":safe_text(
                        getattr(getattr(callee,"contract",None),"name",None)),
                    "calleeReferenceStatus":"SLITHER_FUNCTION_OBJECT" if callee is not None
                        else "DYNAMIC_CALLEE_UNRESOLVED",
                    "destination":variable_ref(getattr(ir,"destination",None)),
                    "callValue":variable_ref(getattr(ir,"call_value",None)),
                    "arguments":[variable_ref(v) for v in as_list(getattr(ir,"arguments",[]))],
                    "returnedInto":variable_ref(getattr(ir,"lvalue",None)),
                    "sourceSpan":nspan,"evidenceClass":"SLITHER_IR_CALL_OPERATION"})
                result["callsiteCount"]+=1
            for ssaOrdinal,ir in enumerate(as_list(getattr(node,"irs_ssa",[]))):
                written=getattr(ir,"lvalue",None)
                if written is None: continue
                for readOrdinal,read in enumerate(as_list(getattr(ir,"read",[]))):
                    f["directIrSsaDependencies"].append({
                        "sourceNodeId":getattr(node,"node_id",None),
                        "operationOrdinal":ssaOrdinal,"operandOrdinal":readOrdinal,
                        "operatorType":type(ir).__name__,
                        "written":variable_ref(written),"read":variable_ref(read),
                        "sourceSpan":nspan,"evidenceClass":"DIRECT_SLITHIR_SSA_OPERATION"})
                    result["ssaEdgeCount"]+=1
        for variable in as_list(getattr(function,"variables_written",[])):
            try:
                deps=get_dependencies(variable,function)
                for dep in sorted(deps,key=lambda v:(safe_text(v) or "")):
                    f["variableDependencies"].append({
                        "written":variable_ref(variable),"dependsOn":variable_ref(dep),
                        "context":"DECLARING_FUNCTION",
                        "evidenceClass":"SLITHER_DATA_DEPENDENCY_API"})
            except Exception as ex:
                f["limitations"].append({
                    "type":"DATA_DEPENDENCY_API_UNAVAILABLE",
                    "variable":safe_text(variable),"exceptionClass":type(ex).__name__})
        f["readStorageIds"].sort(key=lambda v:(v["name"] or ""))
        f["writtenStorageIds"].sort(key=lambda v:(v["name"] or ""))
        f["variableDependencies"].sort(key=lambda r:((r["written"] or {}).get("name") or "",
                                                        (r["dependsOn"] or {}).get("name") or ""))
        c["functions"].append(f)
        result["functionCount"]+=1
    c["functions"].sort(key=lambda f:(f["sourceName"] or "",f["soliditySignature"] or "",
                                       ((f["sourceSpan"] or {}).get("start") or 0)))
    result["contracts"].append(c)
result["contracts"].sort(key=lambda c:(c["sourceName"] or "",c["contractName"]))
print(json.dumps(result,separators=(",",":"),sort_keys=True))
`;
async function collectSlitherRelationalFactsV1({projectRoot,target,unit,unitId}){
  const sourceUnitRecords=Object.entries(unit?.sourceContents??{}).sort(([a],[b])=>a.localeCompare(b))
    .map(([sourceName,bytes])=>({sourceName,sourceSha256:sha256(Buffer.from(String(bytes),'utf8'))}));
  const call=await runProcess({command:'python3',
    args:['-c',SLITHER_RELATIONAL_API_V1,target,unitId],cwd:projectRoot,
    timeoutMs:180000});
  if(call.exitCode!==0){
    return{unitId,analysisStatus:'ANALYZER_FACT_UNAVAILABLE',sourceUnitRecords,contracts:[],
      limitations:[{reason:'PYTHON_SLITHER_API_FAILED',exitCode:call.exitCode,
        diagnostic:cleanText(String(call.stderr??call.stdout??''))}]};
  }
  try{
    const parsed=JSON.parse(String(call.stdout??''));
    if(parsed.schemaVersion!=='mi-phase0-slither-relational-unit-v1'||parsed.unitId!==unitId||!Array.isArray(parsed.contracts))
      throw new Error('RELATIONAL_API_SCHEMA_OR_IDENTITY_INVALID');
    const sourceByName=new Map(sourceUnitRecords.map(row=>[row.sourceName,row]));
    const exactArtifacts=(unit?.artifacts??[]).map(a=>({
      sourceName:a.sourceName,contractName:a.contractName,
      compilationUnitId:a.compilationUnitId??unitId
    }));
    const unresolvedSourceReferences=[];
    for(const contract of parsed.contracts){
      const sourceName=String(contract.sourceName??'').replaceAll('\\','/');
      const exact=exactArtifacts.filter(a=>a.contractName===contract.contractName&&
        (a.sourceName===sourceName||sourceName.endsWith('/'+a.sourceName)));
      if(exact.length===1){
        contract.compilationUnitId=unitId;
        contract.sourceName=exact[0].sourceName;
        contract.sourceContentSha256=sourceByName.get(exact[0].sourceName)?.sourceSha256??null;
      }else{
        contract.sourceResolutionStatus='UNRESOLVED_OR_AMBIGUOUS_COMPILER_AST_SOURCE';
        unresolvedSourceReferences.push({contractName:contract.contractName,
          slitherSourceName:sourceName,compilerMatches:exact.length});
      }
      for(const fn of contract.functions??[]){
        fn.compilationUnitId=unitId;
        fn.declaringSourceName=fn.sourceName;
        fn.sourceResolutionStatus=contract.sourceContentSha256?
          'SOURCE_UNIT_SHA_BOUND':'UNRESOLVED_SLITHER_SOURCE';
      }
    }
    return{...parsed,analysisStatus:'SLITHER_RELATIONAL_FACTS_AVAILABLE',
      sourceUnitRecords,unresolvedSourceReferences,
      compilerArtifactCount:exactArtifacts.length,
      exposedContractCount:parsed.contracts.length};
  }catch(error){
    return{unitId,analysisStatus:'ANALYZER_FACT_UNAVAILABLE',sourceUnitRecords,contracts:[],
      limitations:[{reason:'RELATIONAL_API_OUTPUT_INVALID',detail:String(error?.message??error)}]};
  }
}

async function runSlitherExport({projectRoot,build,sourceCommit}){
  const compilationUnits=Array.isArray(build?.compilationUnits)?build.compilationUnits.filter(Boolean):[];
  if(compilationUnits.length<=1){
    const exportInfo=await writeCryticCompileExport({projectRoot,build,outDir:path.join(projectRoot,'.audit-slither-export')});
    const raw=await runProcess({command:'slither',args:[exportInfo.exportPath,'--compile-force-framework','standard','--json','-','--exclude-dependencies','--fail-none'],cwd:projectRoot});
    const parsed=parseSlitherJson(raw.stdout);
    const singleUnit=compilationUnits[0]??{sourceContents:{}};
    const unitId=String(singleUnit.unitId??'single-compilation-unit');
    const relational=await collectSlitherRelationalFactsV1({projectRoot,target:exportInfo.exportPath,unit:singleUnit,unitId});
    return{exportInfo,raw,parsed,success:parsed?.success===true,relationalUnitResults:[relational]};
  }

  const unitResults=[];
  const detectors=[];
  const detectorSeen=new Set();
  let totalSourceUnits=0,totalContracts=0;
  for(const [index,unit] of compilationUnits.entries()){
    const unitId=String(unit.unitId??`unit-${index+1}`).replace(/[^A-Za-z0-9._-]+/g,'_');
    const unitBuild={
      ...build,
      compilationUnits:[unit],
      sourceAsts:unit.sourceAsts??{},
      artifacts:Array.isArray(unit.artifacts)?unit.artifacts:[],
      compilerVersion:unit.compilerVersion??build.compilerVersion
    };
    const vyperSources=Object.keys(unit.sourceContents??{}).filter(name=>name.endsWith('.vy')).sort();
    if(vyperSources.length>1)throw new Error('Multiple Vyper sources require separately attributable Slither static-analysis results');
    const exportInfo=vyperSources.length===1
      ? {mode:'EXACT_SOURCE_VYPER',sourcePath:await resolveCompiledSourceFile(projectRoot,vyperSources[0]),sourceUnitCount:1,contractCount:unitBuild.artifacts.length,compilationUnitCount:1}
      : await writeCryticCompileExport({
        projectRoot,
        build:unitBuild,
        outDir:path.join(projectRoot,'.audit-slither-export',unitId)
      });
    totalSourceUnits+=exportInfo.sourceUnitCount??0;
    totalContracts+=exportInfo.contractCount??0;
    const target=vyperSources.length===1?exportInfo.sourcePath:exportInfo.exportPath;
    // Do not feed Vyper 0.4.3 AST to the unsupported Slither Vyper parser.
    // A Vyper AST result is source-bound structural evidence, not Slither
    // semantic detector coverage; preserve that distinction in SLITHER_v1.
    const vyperAnalysis=vyperSources.length===1
      ? await runExactVyperAstStaticV1({projectRoot,unit,sourceName:vyperSources[0]}) : null;
    const slitherArgs=vyperAnalysis?null:[target,'--compile-force-framework','standard','--json','-','--exclude-dependencies','--fail-none'];
    const raw=vyperAnalysis
      ? {exitCode:0,signal:null,stdout:JSON.stringify({success:true,results:{detectors:[]}}),stderr:''}
      : await runProcess({command:'slither',args:slitherArgs,cwd:projectRoot});
    const parsed=parseSlitherJson(raw.stdout);
    const relational=vyperAnalysis
      ? {unitId,analysisStatus:'VYPER_AST_ONLY',sourceUnitRecords:[{sourceName:vyperSources[0]}],contracts:[],limitations:vyperAnalysis.limitations}
      : await collectSlitherRelationalFactsV1({projectRoot,target,unit,unitId});
    if(parsed?.success!==true && !String(raw.stdout??'').trim() && !String(raw.stderr??'').trim()){
      // Slither JSON mode may exit silently on an invalid crytic export.
      // Capture its ordinary CLI diagnostics without weakening the required
      // static-analysis completion gate or treating the diagnostic as a PASS.
      const diagnostic=await runProcess({command:'slither',args:[target,'--debug','--exclude-dependencies'],cwd:projectRoot});
      raw.stderr+='\nSLITHER_SILENT_FAILURE_DIAGNOSTIC_EXIT_'+diagnostic.exitCode+'\n'+String(diagnostic.stderr??'')+'\n'+String(diagnostic.stdout??'');
    }
    if(vyperSources.length===1&&parsed?.success!==true){
      // Slither may swallow a Python/Vyper compatibility exception in JSON mode.
      // Preserve the diagnostic from the same source in ordinary CLI mode.
      const diagnostic=await runProcess({command:'slither',args:[target,'--compile-force-framework','vyper','--exclude-dependencies'],cwd:projectRoot});
      raw.stderr+='\nVYPER_CLI_DIAGNOSTIC_EXIT_'+diagnostic.exitCode+'\n'+String(diagnostic.stderr??'')+'\n'+String(diagnostic.stdout??'');
    }
    unitResults.push({
      unitId,
      compilerVersion:unit.compilerVersion??null,
      exportInfo,
      exitCode:raw.exitCode,
      signal:raw.signal??null,
      stdout:cleanText(raw.stdout),
      stderr:cleanText(raw.stderr),
      parsedSuccess:parsed?.success??false,
      findingCount:parsed?.detectors?.length??0,
      relational,
      analyzer:vyperAnalysis?.analyzer??'slither',
      ...(vyperAnalysis?{vyperAnalysis,staticLimitations:vyperAnalysis.limitations}: {})
    });
    // Preserve later compiler units even if an earlier unit cannot be analyzed.
    // Detector failure does not erase SlithIR facts already extracted from
    // other exact units; no project-wide fallback is labeled unit-exact.
    if(parsed?.success!==true)unitResults[unitResults.length-1].staticLimitations=[
      ...(unitResults[unitResults.length-1].staticLimitations??[]),
      {type:'SLITHER_DETECTOR_UNAVAILABLE',unitId,exitCode:raw.exitCode}
    ];
    for(const detector of parsed?.detectors??[]){
      const key=JSON.stringify(detector);
      if(detectorSeen.has(key))continue;
      detectorSeen.add(key);
      detectors.push(detector);
    }
  }
  return{
    exportInfo:{mode:'PER_COMPILATION_UNIT',compilationUnitCount:compilationUnits.length,sourceUnitCount:totalSourceUnits,contractCount:totalContracts,unitResults},
    raw:{exitCode:0,signal:null,stdout:'',stderr:''},
    parsed:{success:unitResults.every(u=>u.parsedSuccess),detectors},
    success:unitResults.every(u=>u.parsedSuccess),
    unitResults,relationalUnitResults:unitResults.map(x=>x.relational)
  };
}

function slitherSucceeded(r){return r&&['completed','completed_with_findings'].includes(r.status)&&r.componentStatus==='COMPLETED';}
function parseSlitherJson(text){
  try{const p=JSON.parse(String(text??''));const d=Array.isArray(p?.results?.detectors)?p.results.detectors:[];return{success:p?.success===true,detectors:d};}catch{return null;}
}
async function slitherRepair({projectRoot,build,sourceCommit}){
  // A verified private build-cache HIT skips the native build's Vyper CLI
  // installation. Slither's Vyper backend still needs that exact binary.
  // Resolve the version from retained source-bound compilation units, never
  // from a guessed package default, and preserve the Slither completion gate.
  const vyperVersions=new Set((build.compilationUnits??[])
    .filter(unit=>(unit.artifacts??[]).some(a=>a.sourceName?.endsWith('.vy')))
    .map(unit=>unit.compilerVersion));
  if(vyperVersions.size>1)throw new Error('Conflicting Vyper compiler versions in accepted build units');
  if(vyperVersions.size===1){
    const version=[...vyperVersions][0];
    if(!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Invalid exact Vyper version in compiler evidence');
    let probe=await runProcess({command:'vyper',args:['--version'],cwd:projectRoot});
    if(probe.exitCode!==0||!String(probe.stdout??'').trim().startsWith(version)){
      const install=await runProcess({command:'python3',args:['-m','pip','install','--disable-pip-version-check','--no-input',`vyper==${version}`],cwd:projectRoot});
      if(install.exitCode!==0)throw new Error('Source-bound Slither Vyper CLI installation failed: '+String(install.stderr??install.stdout??'').slice(-2000));
      probe=await runProcess({command:'vyper',args:['--version'],cwd:projectRoot});
      if(probe.exitCode!==0||!String(probe.stdout??'').trim().startsWith(version))
        throw new Error('Slither Vyper CLI version does not match source-bound compiler '+version);
    }
  }
  const attempts=[];

  try{
    const exact=await runSlitherExport({projectRoot,build,sourceCommit});
    attempts.push({
      strategy:'exact-build-crytic-export',
      exportInfo:exact.exportInfo,
      exitCode:exact.raw.exitCode,
      stdout:cleanText(exact.raw.stdout),
      stderr:cleanText(exact.raw.stderr),
      parsedSuccess:exact.parsed?.success??false,
      findingCount:exact.parsed?.detectors?.length??0
    });
    if(exact.success){
      return{
        backend:'slither',
        version:'0.11.6',
        sourceCommit,
        rawArtifactRef:'github-actions://lite-phase0/slither',
        status:(exact.parsed.detectors.length?'completed_with_findings':'completed'),
        terminal:true,
        componentStatus:'COMPLETED',
        continuationDisposition:'COMPLETE_EVIDENCE',
        authoritativeFinding:false,
        findingCount:exact.parsed.detectors.length,
        detectors:exact.parsed.detectors,
        repairAttempts:attempts,
        inputMode:'EXACT_BUILD_CRYTIC_COMPILE_EXPORT',
        analyzerCoverage:exact.unitResults?.map(u=>({unitId:u.unitId,analyzer:u.analyzer??'slither',staticLimitations:u.staticLimitations??[],vyperAnalysis:u.vyperAnalysis??null}))??[],
        relationalUnitResults:exact.relationalUnitResults??[],
        limitations:exact.unitResults?.flatMap(u=>u.staticLimitations??[])??[],
        requiredSemanticReview:exact.unitResults?.some(u=>Boolean(u.vyperAnalysis))??false
      };
    }
    if((exact.relationalUnitResults??[]).length){
      return{
        backend:'slither',version:'0.11.6',sourceCommit,
        rawArtifactRef:'github-actions://lite-phase0/slither',
        status:'partial',terminal:true,componentStatus:'PARTIAL',
        continuationDisposition:'UNIT_SPECIFIC_ANALYZER_LIMITATIONS',
        authoritativeFinding:false,
        findingCount:exact.parsed?.detectors?.length??0,
        detectors:exact.parsed?.detectors??[],
        repairAttempts:attempts,
        inputMode:'EXACT_BUILD_CRYTIC_COMPILE_EXPORT',
        analyzerCoverage:exact.unitResults?.map(u=>({
          unitId:u.unitId,analyzer:u.analyzer,
          staticLimitations:u.staticLimitations??[]
        }))??[],
        relationalUnitResults:exact.relationalUnitResults,
        limitations:exact.unitResults?.flatMap(u=>u.staticLimitations??[])??[],
        requiredSemanticReview:true
      };
    }
  }catch(error){
    attempts.push({strategy:'exact-build-crytic-export',error:{message:error?.message??String(error)}});
  }

  const hardhat=await isDir(path.join(projectRoot,'node_modules'))&&((await fs.readdir(projectRoot)).some(n=>/^hardhat\.config\./.test(n)));
  const commands=[];
  if(hardhat)commands.push({strategy:'hardhat-project',args:['.','--compile-force-framework','hardhat','--json','-','--exclude-dependencies']});
  commands.push({strategy:'project-auto',args:['.','--json','-','--exclude-dependencies']});

  for(const item of commands){
    const raw=await runProcess({command:'slither',args:item.args,cwd:projectRoot});
    const parsed=parseSlitherJson(raw.stdout);
    const success=parsed?.success===true;
    const result={
      strategy:item.strategy,
      exitCode:raw.exitCode,
      stdout:cleanText(raw.stdout),
      stderr:cleanText(raw.stderr),
      parsedSuccess:parsed?.success??false,
      findingCount:parsed?.detectors?.length??0
    };
    attempts.push(result);
    if(success){
      return{
        backend:'slither',
        version:'0.11.6',
        sourceCommit,
        rawArtifactRef:'github-actions://lite-phase0/slither',
        status:(parsed.detectors.length?'completed_with_findings':'completed'),
        terminal:true,
        componentStatus:'COMPLETED',
        continuationDisposition:'COMPLETE_EVIDENCE',
        authoritativeFinding:false,
        findingCount:parsed.detectors.length,
        detectors:parsed.detectors,
        repairAttempts:attempts,
        inputMode:item.strategy
      };
    }
  }
  const error=new Error('Slither failed after all admitted repair strategies');
  error.code='slither_unrepaired';
  error.attempts=attempts;
  throw error;
}

async function readSmallText(file,maxBytes=1024*1024){
  try{
    const stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>maxBytes)return null;
    return await fs.readFile(file,'utf8');
  }catch{return null;}
}
function lineNumberAt(text,index){return text.slice(0,index).split('\n').length;}
function relativePosix(root,abs){return path.relative(root,abs).split(path.sep).join('/');}
async function scanProjectReadiness({projectRoot,build,cfg}){
  const all=await walk(projectRoot);
  const interesting=all.filter(p=>/deploy|deployment|script|config|hardhat|foundry|medusa|test|spec|harness|simulation|simulate|oracle|network|chain|address|proxy|admin|timelock|role|keeper/i.test(p));
  const deploymentFiles=interesting.filter(p=>/deploy|deployment|simulate|network|address|proxy|admin|timelock|oracle|chain/i.test(p));
  const testFiles=all.filter(p=>/(^|\/)(test|tests|spec|specs)(\/|$)|\.t\.sol$|\.spec\.[cm]?[jt]s$|\.test\.[cm]?[jt]s$/i.test(p));
  const harnessFiles=all.filter(p=>/harness|mock/i.test(p));
  const configFiles=all.filter(p=>/(hardhat\.config|foundry\.toml|medusa|package\.json|package-lock\.json|\.env\.example|config)/i.test(p));
  const scriptFiles=all.filter(p=>/(^|\/)(scripts?|tooling\/scripts)\//i.test(p));
  const documentationFiles=all.filter(p=>/(^|\/)(readme|docs?|specs?|documentation)(\/|\.|$)|\.md$/i.test(p));
  const addresses=[],chainIds=[],roleMentions=[],oracleMentions=[],proxyMentions=[];
  const claimedStandards=[],explicitExclusions=[],declaredFacts=[];
  const addrSeen=new Set(), chainSeen=new Set();
  for(const rel of deploymentFiles.concat(configFiles).slice(0,300)){
    const text=await readSmallText(path.join(projectRoot,...rel.split('/')));
    if(text==null)continue;
    for(const m of text.matchAll(/0x[a-fA-F0-9]{40}/g)){
      const key=`${m[0].toLowerCase()}|${rel}`; if(addrSeen.has(key))continue; addrSeen.add(key);
      addresses.push({address:m[0],path:rel,line:lineNumberAt(text,m.index??0)});
    }
    for(const m of text.matchAll(/(?:chainId|chain_id|CHAIN_ID)\s*[:=]\s*['"]?(\d{1,12})/gi)){
      const key=`${m[1]}|${rel}`; if(chainSeen.has(key))continue; chainSeen.add(key);
      chainIds.push({chainId:Number(m[1]),path:rel,line:lineNumberAt(text,m.index??0)});
    }
    for(const m of text.matchAll(/\b(owner|admin|governance|governor|timelock|authorizer|keeper|registrar|operator|controller)\b/gi)){
      if(roleMentions.length<500)roleMentions.push({term:m[1],path:rel,line:lineNumberAt(text,m.index??0)});
    }
    for(const m of text.matchAll(/\b(oracle|twap|price feed|pricefeed)\b/gi)){
      if(oracleMentions.length<250)oracleMentions.push({term:m[1],path:rel,line:lineNumberAt(text,m.index??0)});
    }
    for(const m of text.matchAll(/\b(proxy|implementation|delegatecall|upgrade|upgradeable)\b/gi)){
      if(proxyMentions.length<250)proxyMentions.push({term:m[1],path:rel,line:lineNumberAt(text,m.index??0)});
    }
  }
  for(const rel of documentationFiles.slice(0,300)){
    const text=await readSmallText(path.join(projectRoot,...rel.split('/')));
    if(text==null) continue;
    const lines=text.split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      const line=lines[i].trim();
      if(!line) continue;
      for(const m of line.matchAll(/\b(?:ERC[- ]?\d+|EIP[- ]?\d+|IERC\d+|ERC20|ERC4626|ERC721|ERC1155|EIP712)\b/gi)){
        if(claimedStandards.length<500) claimedStandards.push({claim:m[0],path:rel,line:i+1,text:line.slice(0,500)});
      }
      if(/\b(out[- ]of[- ]scope|not in scope|excluded?|unsupported|does not support)\b/i.test(line) && explicitExclusions.length<300){
        explicitExclusions.push({path:rel,line:i+1,text:line.slice(0,500)});
      }
      if(/\b(must|shall|intended|purpose|responsible|role|owner|admin|governance|governor|keeper|operator|controller|oracle|deposit|withdraw|redeem|mint|burn)\b/i.test(line) && declaredFacts.length<1000){
        declaredFacts.push({path:rel,line:i+1,text:line.slice(0,500)});
      }
    }
  }
  let packageJson=null;
  const packageText=await readSmallText(path.join(projectRoot,'package.json'));
  if(packageText){try{packageJson=JSON.parse(packageText);}catch{}}
  const contractMeta=new Map();
  function visitContractMeta(node,sourceName){
    if(!node||typeof node!=='object')return;
    if(node.nodeType==='ContractDefinition')contractMeta.set(`${sourceName}:${node.name}`,{contractKind:node.contractKind??'UNKNOWN',abstract:node.abstract===true});
    for(const value of Object.values(node)){
      if(Array.isArray(value))for(const child of value)visitContractMeta(child,sourceName);
      else if(value&&typeof value==='object')visitContractMeta(value,sourceName);
    }
  }
  for(const [sourceName,ast] of Object.entries(build.sourceAsts??{}))visitContractMeta(ast,sourceName);

  function normalizedArtifactAbi(abi){
    if(Array.isArray(abi))return abi;
    if(Array.isArray(abi?.abi))return abi.abi;
    if(abi&&typeof abi==='object'){
      const values=Object.values(abi);
      if(values.length&&values.every(x=>x&&typeof x==='object'&&typeof x.type==='string'))return values;
    }
    return [];
  }
  function flattenLinkReferences(refs={}){
    const out=[];
    for(const [sourceName,libs] of Object.entries(refs??{})){
      for(const [libraryName,positions] of Object.entries(libs??{})){
        out.push({sourceName,libraryName,positions:(positions??[]).map(x=>({start:Number(x.start),length:Number(x.length)}))});
      }
    }
    return out;
  }

  const contractDeploymentInventory=(build.artifacts??[]).map(a=>{
    const qualifiedName=`${a.sourceName}:${a.contractName}`;
    const meta=contractMeta.get(qualifiedName)??{};
    const abi=normalizedArtifactAbi(a.abi);
    const constructorInputs=(abi.find(x=>x?.type==='constructor')?.inputs??[]).map(x=>({
      name:x.name??'',type:x.type??null,internalType:x.internalType??null,components:x.components??null
    }));
    const mutableFunctions=abi.filter(x=>x?.type==='function'&&!['view','pure'].includes(x.stateMutability));
    const accountingMutableFunctions=mutableFunctions.filter(x=>/^(?:deposit|mint|stake|supply|lend|borrow|repay|withdraw|redeem|unstake|unsupply|transfer|transferFrom|burn|swap|addLiquidity|removeLiquidity|join|exit|claim|harvest|collect|distribute|accrue|settle|liquidate|donate|sync|skim)/i.test(String(x.name??'')));
    const creationBytecodeBytes=Math.floor(String(a.bytecode??'0x').replace(/^0x/,'').length/2);
    const deployedBytecodeBytes=Math.floor(String(a.deployedBytecode??'0x').replace(/^0x/,'').length/2);
    const linkReferences=flattenLinkReferences(a.linkReferences??{});
    let deployabilityStatus='DEPLOYABLE';
    if(meta.abstract===true)deployabilityStatus='NOT_DIRECTLY_DEPLOYABLE_ABSTRACT';
    else if(meta.contractKind==='interface')deployabilityStatus='NOT_DIRECTLY_DEPLOYABLE_INTERFACE';
    else if((a.bytecode??'0x')==='0x'||creationBytecodeBytes===0)deployabilityStatus='NO_CREATION_BYTECODE';
    else if(meta.contractKind==='library')deployabilityStatus='DEPLOYABLE_LIBRARY';
    else if(linkReferences.length)deployabilityStatus='DEPLOYABLE_AFTER_LIBRARY_LINK';
    else if(constructorInputs.length===0)deployabilityStatus='DEPLOYABLE_ZERO_ARG';
    else deployabilityStatus='DEPLOYABLE_WITH_CONSTRUCTOR_ARGS';
    return{
      qualifiedName,sourceName:a.sourceName,contractName:a.contractName,
      sourceClass:(String(a.sourceName).startsWith('@')||String(a.sourceName).includes('/vendor/'))?'DEPENDENCY_OR_VENDOR':'PROJECT_OR_ADMITTED_SOURCE',
      contractKind:meta.contractKind??'UNKNOWN',abstract:meta.abstract===true,
      deployabilityStatus,constructorInputs,linkReferences,
      mutableFunctionCount:mutableFunctions.length,
      accountingMutableFunctionCount:accountingMutableFunctions.length,
      creationBytecodeBytes,deployedBytecodeBytes,
      preliminaryDeploymentGasEstimate:a.gasEstimates?.creation?.totalCost??null
    };
  }).sort((a,b)=>a.qualifiedName.localeCompare(b.qualifiedName));

  const artifactSizes=contractDeploymentInventory.map(x=>({
    qualifiedName:x.qualifiedName,
    creationBytecodeBytes:x.creationBytecodeBytes,
    deployedBytecodeBytes:x.deployedBytecodeBytes,
    preliminaryDeploymentGasEstimate:x.preliminaryDeploymentGasEstimate
  })).sort((a,b)=>b.deployedBytecodeBytes-a.deployedBytecodeBytes||a.qualifiedName.localeCompare(b.qualifiedName));
  const deployabilityRisks=artifactSizes.filter(x=>x.deployedBytecodeBytes>24576).map(x=>({...x,limitBytes:24576,status:'EIP170_RUNTIME_LIMIT_EXCEEDED'}));
  return{
    schemaVersion:'curveyield-lite-phase0-project-readiness-v1',
    deploymentAndConfiguration:{
      deploymentFiles,configFiles,scriptFiles,
      discoveredAddresses:addresses,
      discoveredChainIds:chainIds,
      roleMentions,
      oracleMentions,
      proxyAndUpgradeabilityMentions:proxyMentions,
      contractDeploymentInventory,
      deployableContractCount:contractDeploymentInventory.filter(x=>x.deployabilityStatus.startsWith('DEPLOYABLE')).length,
      mutableDeployableContractCount:contractDeploymentInventory.filter(x=>x.deployabilityStatus.startsWith('DEPLOYABLE')&&x.mutableFunctionCount>0).length,
      status:'MECHANICAL_INVENTORY_COMPLETE'
    },
    documentationInventory:{
      documentationFiles,
      claimedStandards,
      explicitExclusions,
      declaredFacts,
      status:'NEUTRAL_MECHANICAL_EXTRACTION'
    },
    testingAndToolingReadiness:{
      testFiles,harnessFiles,scriptFiles,configFiles,
      packageScripts:packageJson?.scripts??{},
      detectedTooling:{
        hardhat:configFiles.some(x=>/^hardhat\.config\./i.test(path.basename(x))),
        foundry:configFiles.some(x=>path.basename(x)==='foundry.toml'),
        medusa:configFiles.some(x=>/medusa/i.test(path.basename(x))),
        slitherVersion:'0.11.6',
        compilerVersion:cfg.compilerVersion
      },
      status:'MECHANICAL_INVENTORY_COMPLETE'
    },
    bytecodeAndGasEvidence:{
      artifactCount:artifactSizes.length,
      artifacts:artifactSizes,
      deployabilityRisks,
      eip170RuntimeLimitBytes:24576
    }
  };
}
function sanitizedMachineEnv(environment=process.env){
  const out={};
  for(const key of ['PATH','HOME','USER','SHELL','TMPDIR','LANG','LC_ALL','NODE_OPTIONS','npm_config_cache']){
    if(environment[key]!==undefined) out[key]=environment[key];
  }
  out.CI='true';
  out.NODE_ENV='test';
  return out;
}

async function executeSourceKnownLocalSetup({projectRoot,projectReadiness}){
  const scripts=projectReadiness?.testingAndToolingReadiness?.packageScripts??{};
  const discovered=Object.entries(scripts)
    .filter(([name,cmd])=>/(deploy|deployment|simulate|simulation|integration)/i.test(name+' '+String(cmd)))
    .map(([name,command])=>({script:name,command:String(command),status:'DEFERRED_TO_ANVIL_FRAMEWORK_ADAPTER'}));
  return {
    schemaVersion:'curveyield-lite-phase0-deploy-config-execution-v2',
    policy:'DISCOVERY_ONLY_UNTIL_PHASE0_ANVIL_SIMULATION_WORKFLOW',
    attempts:[],
    discoveredDeploymentOrSimulationScripts:discovered,
    gaps:[],
    status:'PENDING_ANVIL_SIMULATION',
    note:'Phase-0 intelligence does not execute arbitrary npm deployment scripts. The dedicated randomized-simulation workflow binds supported Foundry/Hardhat deployment entrypoints to the local Anvil RPC without source mutation, then overwrites this provisional evidence with actual execution results.'
  };
}
async function buildContextReviewPacket({projectRoot,sourceIntelligence,projectReadiness,slither}){
  const sourceEntries=[];
  for(const item of sourceIntelligence.sourceFiles??[]){
    const rel=item.path;
    const abs=path.join(projectRoot,...rel.split('/'));
    const text=await readSmallText(abs,2*1024*1024);
    if(text==null)continue;
    sourceEntries.push({path:rel,sha256:item.sha256,content:text});
  }
  return{
    schemaVersion:'curveyield-lite-phase0-context-review-input-v1',
    purpose:'TEMPORARY_AGENT_REVIEW_INPUT_NOT_A_PHASE0_DELIVERABLE',
    sourceEntries,
    mechanicalIndexes:{
      contracts:sourceIntelligence.contracts??[],
      functions:sourceIntelligence.functions??[],
      storageLayout:sourceIntelligence.storageLayout??[],
      inheritanceGraph:sourceIntelligence.inheritanceGraph??[],
      callGraph:sourceIntelligence.callGraph??[],
      privilegeCandidates:sourceIntelligence.privilegeCandidates??[],
      externalInterfaces:sourceIntelligence.externalInterfaces??[],
      valueFlowCandidates:sourceIntelligence.valueFlowCandidates??[],
      securitySurfaces:sourceIntelligence.securitySurfaces??[],
      protocolTopology:sourceIntelligence.protocolTopology??{}
    },
    projectReadiness,
    slitherSummary:{status:slither.status,findingCount:slither.findingCount??0,detectors:slither.detectors??[]}
  };
}

// The network-disabled collector may only use dependencies that were fetched
// during trusted image construction, before the untrusted source ZIP arrived.
// This is a read-only source-manifest comparison, not source-defined install code.
async function preparePinnedOfflineDependencies(extractionRoot,expectedSourceSha256){
  const planLocation='/toolchain-plan/toolchain-plan.json';
  if(!await exists(planLocation))return{status:'NO_ADMITTED_TOOLCHAIN_PLAN',packages:[]};
  const plan=JSON.parse(await fs.readFile(planLocation,'utf8'));
  if(plan.schemaVersion!=='curveyield-standalone-toolchain-plan-v1'||plan.sourceZipSha256!==expectedSourceSha256)
    throw new Error('SOURCE_BOUND_TOOLCHAIN_PLAN_IDENTITY_MISMATCH');
  let toolchainStatus={};
  try{toolchainStatus=JSON.parse(await fs.readFile('/opt/preflight/toolchain-status.json','utf8'));}catch{}
  const staged=[];
  for(const [index,item] of (plan.packages??[]).entries()){
    if(item.preparedPath!=='packages/'+index||typeof item.root!=='string')
      throw new Error('SOURCE_TOOLCHAIN_PACKAGE_IDENTITY_INVALID');
    const relative=item.root==='.'?'':item.root;
    if(relative&&(!/^[A-Za-z0-9_./ -]+$/.test(relative)||relative.startsWith('/')||relative.split('/').some(x=>!x||x==='..'||x==='.')))
      throw new Error('SOURCE_TOOLCHAIN_PACKAGE_PATH_INVALID');
    const root=relative?path.join(extractionRoot,...relative.split('/')):extractionRoot;
    const original=path.join(root,'package.json');
    if(!await exists(original))throw new Error('ADMITTED_PACKAGE_MANIFEST_MISSING: '+item.root);
    if(sha256(await fs.readFile(original))!==item.manifestSha256)
      throw new Error('SOURCE_BOUND_NPM_MANIFEST_HASH_MISMATCH: '+item.root);
    if(item.lockSha256){
      const lockName=item.lockOriginalName??'package-lock.json';
      if(!['package-lock.json','npm-shrinkwrap.json'].includes(lockName))
        throw new Error('UNSAFE_SOURCE_LOCKFILE_NAME');
      const lock=path.join(root,lockName);
      if(!await exists(lock)||sha256(await fs.readFile(lock))!==item.lockSha256)
        throw new Error('SOURCE_BOUND_NPM_LOCK_HASH_MISMATCH: '+item.root);
    }
    const preinstalled=path.join('/opt/preflight/prepared-packages',String(index),'node_modules');
    const target=path.join(root,'node_modules');
    if(await isDir(target)){
      staged.push({root:item.root,status:'SOURCE_ALREADY_CONTAINS_DEPENDENCIES'});continue;
    }
    if(!await isDir(preinstalled)){
      staged.push({root:item.root,status:'TOOLCHAIN_PACKAGE_NOT_AVAILABLE'});continue;
    }
    await fs.cp(preinstalled,target,{recursive:true,force:false,errorOnExist:true});
    staged.push({root:item.root,status:'PREPARED_FROM_SOURCE_BOUND_INERT_MANIFEST',
      manifestSha256:item.manifestSha256,lockSha256:item.lockSha256??null});
  }
  return{status:'SOURCE_BOUND_TOOLCHAIN_PLAN_CONSUMED',packages:staged,
    solidityCompilers:toolchainStatus.solidity??[],vyperCompilers:toolchainStatus.vyper??[],
    unsupportedSourceRequirements:plan.unsupported??[]};
}

async function writeSourceAdmissionInventory(extractionRoot,out,request,detected,observed){
  const sourceNames=(await walk(extractionRoot)).filter(f=>/\.(?:sol|vy)$/i.test(f));
  if(!sourceNames.length)throw new Error('NO_ADMITTED_SOURCE_FILES');
  const files=[];
  for(const rel of sourceNames){
    const buf=await fs.readFile(path.join(extractionRoot,...rel.split('/')));
    const body=buf.toString('utf8');
    const imports=rel.endsWith('.sol')
      ?[...body.matchAll(/\bimport\s+(?:(?:[^;"']+\s+from\s+)?["']([^"']+)["'])/g)].map(x=>x[1])
      :[...body.matchAll(/^\s*(?:from\s+([a-zA-Z0-9_.]+)\s+import|import\s+([a-zA-Z0-9_.]+))/gm)].map(x=>x[1]??x[2]);
    files.push({path:rel,language:rel.endsWith('.vy')?'VYPER':'SOLIDITY',
      sha256:sha256(buf),bytes:buf.length,lines:body.split(/\r?\n/).length,
      importSpecifiers:[...new Set(imports)].sort(),
      evidenceClass:'ADMITTED_SOURCE_TEXT_ONLY_NOT_COMPILER_SEMANTICS'});
  }
  const inventory={schemaVersion:'curveyield-security-source-admission-inventory-v1',
    sourceArchiveSha256:observed,sourceRepository:request.source.repository,sourceCommit:request.source.commit,
    status:'SOURCE_FILES_INVENTORIED_NOT_A_COMPILATION',
    projects:detected.projects??[],primaryProjectRoot:detected.relativePath,
    additionalRootsNotYetCompiled:detected.additionalProjectRoots??[],
    sourceCount:files.length,files};
  await fs.writeFile(path.join(out,'SOURCE_ADMISSION_INVENTORY_v1.json'),JSON.stringify(inventory,null,2)+'\n');
  return inventory;
}

async function writeCompilationUnavailable({out,request,observed,detected,admission,error}){
  const reason=String(error?.message??error).slice(0,2500);
  const identity={
    schemaVersion:'curveyield-lite-phase0-build-source-identity-v1',
    source:{...request.source,checkoutCommit:request.source.commit,archiveSha256Observed:observed},
    discovery:{projectPath:detected.relativePath,topCandidates:detected.candidates,projects:detected.projects,
      admittedSourceFiles:admission.sourceCount},
    build:{status:'UNAVAILABLE',compilerVersion:null,artifactCount:0,reason},
    status:'PARTIAL_SOURCE_ONLY',
    limitations:['NO_COMPILER_AST_ABI_OR_BYTECODE_PROVENANCE','NO_COMPILATION_BASED_SECURITY_CONCLUSIONS']};
  const sourceIntelligence={
    schemaVersion:'curveyield-source-intelligence-technical-v1',
    status:'SOURCE_ONLY_UNCOMPILED',sourceFiles:admission.files,contracts:[],functions:[],
    callGraph:[],externalInterfaces:[],privilegeCandidates:[],storageLayout:[],valueFlowCandidates:[],
    admittedProjects:admission.projects,buildLimitation:reason,
    completion:{semanticReviewRequired:true,compilerEvidenceAvailable:false},
    note:'Text-level source identities and import syntax only; no callable entrypoint or AST coverage claimed.'};
  await fs.writeFile(path.join(out,'BUILD_AND_SOURCE_IDENTITY_v1.json'),JSON.stringify(identity,null,2)+'\n');
  await fs.writeFile(path.join(out,'SOURCE_INTELLIGENCE_AUTOMATED_v1.json'),JSON.stringify(sourceIntelligence,null,2)+'\n');
  console.error('SOURCE_ONLY_PREFLIGHT: '+reason);
  process.stdout.write(JSON.stringify({status:'PARTIAL_SOURCE_ONLY',reason,sourceCount:admission.sourceCount,
    projects:admission.projects.length,buildStatus:'UNAVAILABLE'})+'\n');
}

async function main(){
  const args=parseArgs(process.argv.slice(2));
  if(!args.request||!args.output)throw new Error('usage: --request <request.json> --output <dir>');
  const request=JSON.parse(await fs.readFile(path.resolve(args.request),'utf8'));
  if(request.schemaVersion!=='curveyield-lite-phase0-intelligence-request-v1')throw new Error('request schema mismatch');
  safeRel(request.source.archivePath,'source.archivePath'); safeRel(request.destination.campaignPath,'destination.campaignPath');
  if(!/^[0-9a-f]{40}$/.test(request.source.commit))throw new Error('source.commit must be 40 hex');
  if(!/^[0-9a-f]{64}$/.test(request.source.archiveSha256))throw new Error('archive SHA-256 invalid');
  if(!/^[A-Za-z0-9._/-]+$/.test(request.destination.ref))throw new Error('destination ref invalid');

  const out=path.resolve(args.output), work=path.join(out,'work'); await fs.rm(out,{recursive:true,force:true}); await fs.mkdir(work,{recursive:true});
  const checkoutRoot=path.join(work,'source-repo');
  // Phase 0 reads only its campaign (which holds the source archive) and, at write-back, the current
  // authority package. Materialize just those paths instead of the whole controller repository.
  const literal=p=>'/'+p.replace(/[[\]*?!#\\]/g,'\\$&');
  const campaignPath=request.destination.campaignPath.replace(/\/+$/,'');
  const sparsePatterns=request.source.repository===request.destination.repository&&request.source.archivePath.startsWith(campaignPath+'/')
    ? [literal(campaignPath)+'/','/Machine Intelligence Audit Controller/Audit Skill v7/','/Machine Intelligence Audit Controller/Audit Skill v8/']
    : null;
  // Standalone security-preflight route: the trusted admission job fetches and
  // verifies the exact ZIP. The sandboxed compiler job NEVER receives a GitHub
  // token, performs a GitHub checkout, or executes a deploy/configuration step.
  const localArchive=process.env.SECURITY_PREFLIGHT_LOCAL_ARCHIVE;
  if(!localArchive)throw new Error('STANDALONE_PREFLIGHT_REQUIRES_VERIFIED_LOCAL_ARCHIVE');
  const checkout={commit:request.source.commit};
  const archiveAbs=path.resolve(localArchive);
  const archiveBytes=await fs.readFile(archiveAbs); const observed=sha256(archiveBytes);
  if(observed!==request.source.archiveSha256)throw new Error(`source archive SHA mismatch expected ${request.source.archiveSha256} observed ${observed}`);
  // The immutable archive is already checked out and hash-verified. Compilation,
  // Slither and source-native scripts must not inherit GitHub credentials.
  for(const name of ['AUDIT_CONTROLLER_GITHUB_TOKEN','PREFLIGHTSIM_GITHUB_TOKEN',
    'GITHUB_TOKEN','GH_TOKEN','GIT_CONFIG_VALUE_0','GIT_CONFIG_KEY_0','GIT_CONFIG_COUNT'])
    delete process.env[name];
  const extractionRoot=path.join(work,'archive'); const extraction=await withProgressStage('extract-verified-archive',()=>extractArchive(archiveAbs,extractionRoot));
  const detected=await withProgressStage('detect-project-root',()=>detectProjectRoot(extractionRoot));
  const sourceAdmission=await withProgressStage('source-admission-inventory',()=>
    writeSourceAdmissionInventory(extractionRoot,out,request,detected,observed));
  let cfg,preparedDependencies,vyperVersion,requestedCompilers,auditScope,pseudo,build;
  try{
    cfg=await withProgressStage('detect-build-config',()=>detectBuildConfig(detected.absolute));
  preparedDependencies=await withProgressStage('prepare-pinned-offline-dependencies',()=>preparePinnedOfflineDependencies(extractionRoot,observed));
  // Foundry's pinned source pragma is authoritative for the Vyper compiler.
  // Request it explicitly so the mixed-language build and retained artifacts
  // include staking bytecode; never infer from unrelated archive copies.
  const vyperVersions=new Set();
  for(const rel of await walk(detected.absolute)){
    if(!/\.(?:vy)$/.test(rel))continue;
    const source=await fs.readFile(path.join(detected.absolute,...rel.split('/')),'utf8');
    const version=source.match(/^\s*#\s*pragma\s+version\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
    if(!version)throw new Error('Vyper source lacks an exact compiler version pragma: '+rel);
    vyperVersions.add(version);
  }
  if(vyperVersions.size>1)throw new Error('Mixed incompatible Vyper compiler pragmas in contracts/');
  vyperVersion=[...vyperVersions][0]??null;
  if(vyperVersion)process.env.SECURITY_PREFLIGHT_VYPER_VERSION=vyperVersion;
  requestedCompilers=[...(cfg.compilerVersion?[{language:'solidity',version:cfg.compilerVersion}]:[]),
    ...(vyperVersion?[{language:'vyper',version:vyperVersion}]:[])];
  auditScope=await loadAuditScope(detected.absolute);

  pseudo={
    requestId:request.requestId,requestDigest:request.requestDigest??sha256(Buffer.from(JSON.stringify(request))),
    campaignId:request.campaignId,campaignGenerationId:request.campaignGenerationId,assignmentId:'phase0-intelligence',phaseId:'phase-0',profileId:'github-native-compile-v2',
    source:{repository:request.source.repository,commit:request.source.commit,projectPath:detected.relativePath,archivePath:request.source.archivePath,archiveSha256:request.source.archiveSha256},
    configuration:{compilers:requestedCompilers,analysis:{slither:{version:'0.11.6'}},optimizer:cfg.optimizer,evmVersion:cfg.evmVersion,viaIR:cfg.viaIR}
  };

  build=await withProgressStage('compile-exact-build',()=>compileWithPrivateCacheV1({request,pseudo,projectRoot:detected.absolute,compile:()=>buildProject({projectRoot:detected.absolute,request:pseudo})}));
  }catch(error){
    await writeCompilationUnavailable({out,request,observed,detected,admission:sourceAdmission,error});
    return;
  }
  const executionBuildArtifacts=buildExecutionArtifactBundleV2({request:pseudo,build});
  const buildArtifactBundleBytes=Buffer.from(JSON.stringify(executionBuildArtifacts,null,2)+'\n','utf8');
  const buildArtifactBundleSha256=sha256(buildArtifactBundleBytes);
  const contractIdentityIndex=buildContractIdentityIndexV1({
    request:pseudo,build,artifactBundle:executionBuildArtifacts,buildArtifactBundleSha256
  });
  const effectiveCfg={...cfg,offlineDependencyPreparation:preparedDependencies,buildSystem:build.system,compilerVersions:build.compilerVersions??[build.compilerVersion].filter(Boolean),compilerProfiles:build.compilerProfiles??[]};
  let slither;
  try {
    slither=await withProgressStage('slither-static-analysis',()=>slitherRepair({projectRoot:detected.absolute,build,sourceCommit:request.source.commit}));
  }catch(error){
    // Preserve the actual failure and proceed with source-bound artifact assembly.
    // Audit-quality disposition is owned by the independent Cloudflare Worker.
    const detail=String(error?.message??error);
    console.error('Worker review required: Slither analysis incomplete: '+detail);
    slither={backend:'slither',version:'0.11.6',sourceCommit:request.source.commit,
      rawArtifactRef:'github-actions://lite-phase0/slither',
      status:'failed',terminal:true,componentStatus:'FAILED',
      continuationDisposition:'DELEGATED_TO_CLOUDFLARE_WORKER',
      authoritativeFinding:false,findingCount:0,detectors:[],
      repairAttempts:error?.attempts??[{strategy:'unhandled-failure',error:{message:detail}}],
      inputMode:'UNRESOLVED_STATIC_ANALYSIS',
      limitations:[detail],requiredSemanticReview:true};
  }
  const sbom=await withProgressStage('generate-sbom',()=>generateBuildSbomV1({projectRoot:detected.absolute,request:pseudo,build}));
  const sourceIntelligence=await withProgressStage('generate-source-intelligence',()=>generateSourceIntelligenceTechnicalBundleV1({projectRoot:detected.absolute,request:pseudo,build,analysis:{slither}}));
  sourceIntelligence.admissionInventoryRef='SOURCE_ADMISSION_INVENTORY_v1.json';
  sourceIntelligence.additionalProjectRootsNotCompiled=sourceAdmission.additionalRootsNotYetCompiled;
  sourceIntelligence.sourceAdmissionCount=sourceAdmission.sourceCount;
  // Fork-owned Phase 0 graph/Flow Plan source subjects need exactly the
  // preexisting source-AST inventory and SYSTEM_FACTS builder, regardless of
  // whether a legacy accepted campaign's optional review policy enabled it.
  // This fork writes evidence only; no controller acceptance verdict is issued.
  await withProgressStage('source-review-inventory-and-existing-facts',
    ()=>writeReviewInventoryOutputsV1({outputDir:out,projectRoot:detected.absolute,
      build,request,slither,policy:'audit-detection-rebuild-v1',
      reviewPolicy:process.env.ADR_DETECTION_REVIEW_POLICY||null}));
  const projectReadiness=await withProgressStage('scan-project-readiness',()=>scanProjectReadiness({projectRoot:detected.absolute,build,cfg:effectiveCfg}));
  const deployConfigExecution=await withProgressStage('execute-local-deployment-inventory',()=>executeSourceKnownLocalSetup({projectRoot:detected.absolute,projectReadiness}));

  // Retain real failure evidence without turning GitHub into the audit judge.
  if(!slitherSucceeded(slither))console.error('Slither incomplete; quality review delegated to Cloudflare Worker');
  if(sourceIntelligence?.completion?.semanticReviewRequired!==true)console.error('Source Intelligence completion assessment delegated to Cloudflare Worker');

  const buildIdentity={
    schemaVersion:'curveyield-lite-phase0-build-source-identity-v1',
    requestId:request.requestId,campaignId:request.campaignId,campaignGenerationId:request.campaignGenerationId,
    source:{...request.source,checkoutCommit:checkout.commit,archiveSha256Observed:observed},
    discovery:{projectPath:detected.relativePath,topCandidates:detected.candidates,projects:detected.projects,additionalProjectRootsNotCompiled:detected.additionalProjectRoots,sourceAdmissionInventoryFile:'SOURCE_ADMISSION_INVENTORY_v1.json',archiveEntryCount:extraction.entryCount,archiveExtractedBytes:extraction.extractedBytes},
    configurationDetection:effectiveCfg,
    auditScope,
    build:{status:build.status,system:build.system,wholeProjectCompileSucceeded:build.wholeProjectCompileSucceeded??null,compilationSelection:build.compilationSelection??null,isolatedUnitRoots:build.isolatedUnitRoots??[],isolatedUnitFailures:build.isolatedUnitFailures??[],excludedImportOnlySources:build.excludedImportOnlySources??[],unitCoverageComplete:build.unitCoverageComplete??null,compilerVersion:build.compilerVersion,compilerVersions:build.compilerVersions??[build.compilerVersion].filter(Boolean),compilerProfiles:build.compilerProfiles??[],compilationUnitCount:build.compilationUnits?.length??0,compilationUnits:executionBuildArtifacts.buildIdentity.compilationUnits,buildConfigurationDigestSha256:executionBuildArtifacts.buildConfigurationDigestSha256,embeddedBuildContract:build.embeddedBuildContract??null,foundryDependencyInstall:build.foundryDependencyInstall??[],sourceInventoryFiles:build.sourceInventoryFiles??0,artifactCount:build.artifacts?.length??0,compilerInputSha256:build.compilerInputSha256??null,compilerOutputSha256:build.compilerOutputSha256??null,stagingManifestSha256:build.stagingManifestSha256??null,diagnosticCount:build.compilerDiagnostics?.length??0,slitherStandardJsonPath:build.slitherStandardJsonPath??null,vendorRootAdapter:build.vendorRootAdapter??null},
    status:(detected.multipleProjects||build.unitCoverageComplete===false)?'PARTIAL_UNCOMPILED_PROJECT_ROOTS_OR_UNITS':'PASS'
  };

  // Every admitted compiled public/external ABI operation is preserved independently.
  // Names suggest possible protocol usage, not that a call is safe or supported.
  const canonicalAbiType=param=>String(param?.type??'').startsWith('tuple')
    ? '('+(param.components??[]).map(canonicalAbiType).join(',')+')'+String(param.type).slice(5)
    : String(param?.type??'');
  const familySignals=/^(deposit|depositFor|mint|withdraw|redeem|stake|unstake|supply|borrow|repay|claim|harvest|swap|exactInput|exactOutput|addLiquidity|removeLiquidity|joinPool|exitPool|open|close|settle|wrap|unwrap|liquidate)$/i;
  const compiledMethodCandidates=(build.artifacts??[]).flatMap(artifact=>
    (artifact.abi??[]).filter(entry=>['function','fallback','receive'].includes(entry?.type)).map(entry=>{
      const signature=entry.type==='function'?String(entry.name)+'('+(entry.inputs??[]).map(canonicalAbiType).join(',')+')':entry.type;
      const rawSelector=artifact.methodIdentifiers?.[signature]??null;
      const selector=/^(?:0x)?[0-9a-fA-F]{8}$/.test(String(rawSelector??''))
        ? '0x'+String(rawSelector).replace(/^0x/i,'').toLowerCase():null;
      return {
        compilationUnitId:artifact.compilationUnitId??null,
        sourceName:artifact.sourceName,contractName:artifact.contractName,
        canonicalSignature:signature,selector,
        abiType:entry.type,stateMutability:entry.stateMutability??null,
        payable:entry.stateMutability==='payable',
        inputTypes:(entry.inputs??[]).map(canonicalAbiType),
        outputTypes:(entry.outputs??[]).map(canonicalAbiType),
        familyMatchEvidence:familySignals.test(String(entry.name??''))?'ABI_SIGNATURE':'ELIGIBILITY_UNKNOWN_INVENTORIED',
        operationFamilyCandidate:familySignals.test(String(entry.name??''))?entry.name:null,
        eligibility:'UNKNOWN_PREDEPLOYMENT',
        // Static ABI evidence alone never authorizes an account or privileged call.
        executionAuthorized:false
      };
    })
  ).sort((a,b)=>[
    a.compilationUnitId,a.sourceName,a.contractName,a.canonicalSignature
  ].join(':').localeCompare([
    b.compilationUnitId,b.sourceName,b.contractName,b.canonicalSignature
  ].join(':')));
  const relationalFacts={
    schemaVersion:'mi-phase0-slither-relational-facts-v1',
    campaignId:request.campaignId,
    campaignGenerationId:request.campaignGenerationId,
    sourceArchiveSha256:request.source.archiveSha256,
    buildBundleSha256:buildArtifactBundleSha256, // Digest of the actual UTF-8 build artifact bundle written below.
    slitherVersion:'0.11.6',
    sourceUnitRecords:(slither.relationalUnitResults??[]).filter(x=>x?.analysisStatus==='SLITHER_RELATIONAL_FACTS_AVAILABLE'),
    compiledMethodCandidates,
    unavailableUnitRecords:(slither.relationalUnitResults??[]).filter(x=>x?.analysisStatus!=='SLITHER_RELATIONAL_FACTS_AVAILABLE'),
    limitations:slither.relationalUnitResults?.length?[]:['NO_EXACT_PER_UNIT_SLITHER_RELATIONAL_OUTPUT']
  };
  const files=[
    ['BUILD_AND_SOURCE_IDENTITY_v1.json',buildIdentity],
    ['PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json',executionBuildArtifacts],
    ['CONTRACT_IDENTITY_INDEX_v1.json',contractIdentityIndex],
    ['SBOM_v1.json',sbom],
    ['SLITHER_v1.json',slither],
    ['SLITHER_RELATIONAL_FACTS_v1.json',relationalFacts],
    ['SOURCE_INTELLIGENCE_AUTOMATED_v1.json',sourceIntelligence],
    ['PROJECT_READINESS_AUTOMATED_v1.json',projectReadiness],
    ['PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',deployConfigExecution]
  ];

  // Single immutable exact-byte handoff from this copied compiler job to the
  // copied deploy job. The latter may not fall back to campaign evidence.
  const destinationByName={
    'BUILD_AND_SOURCE_IDENTITY_v1.json':'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json',
    'PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json':'evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json',
    'CONTRACT_IDENTITY_INDEX_v1.json':'evidence/phase0/CONTRACT_IDENTITY_INDEX_v1.json',
    'SBOM_v1.json':'evidence/build/SBOM_v1.json',
    'SLITHER_v1.json':'evidence/static-analysis/SLITHER_v1.json',
    'SLITHER_RELATIONAL_FACTS_v1.json':'evidence/static-analysis/SLITHER_RELATIONAL_FACTS_v1.json',
    'SOURCE_INTELLIGENCE_AUTOMATED_v1.json':'evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json',
    'PROJECT_READINESS_AUTOMATED_v1.json':'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json',
    'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json':'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'
  };
  // The existing review-inventory builder writes these only on actual source-
  // backed success. Missing or incomplete records are explicit, never empty
  // facts silently treated as comprehensive audit coverage.
  for(const [name,destination] of [
    ['REVIEW_INVENTORY_v1.json','evidence/review-inventory/REVIEW_INVENTORY_v1.json'],
    ['SYSTEM_FACTS_v1.json','evidence/review-inventory/SYSTEM_FACTS_v1.json']
  ]){
    const file=path.join(out,name);
    const exists=await fs.stat(file).then(x=>x.isFile()).catch(()=>false);
    if(exists){
      const parsed=JSON.parse(await fs.readFile(file,'utf8'));
      if(parsed?.campaignId!==request.campaignId||
         parsed?.campaignGenerationId!==request.campaignGenerationId||
         parsed?.sourceSha256!==request.source.archiveSha256)
        throw new Error('FORK_OPTIONAL_REVIEW_EVIDENCE_SOURCE_GENERATION_INVALID: '+name);
      destinationByName[name]=destination;
    }
  }
  const staticHandoffRecords=[];
  await withProgressStage('write-machine-evidence',async()=>{
    for(const [name,dest] of Object.entries(destinationByName)){
      if(files.some(([existing])=>existing===name))continue;
      const raw=await fs.readFile(path.join(out,name));
      const parsed=JSON.parse(raw.toString('utf8'));
      staticHandoffRecords.push({sourceFile:name,destinationRelativePath:dest,
        sha256:sha256(raw),bytes:raw.length,schemaVersion:parsed.schemaVersion??null,
        sourceArchiveSha256:request.source.archiveSha256});
    }
    for(const [name,obj] of files){
      const raw=Buffer.from(JSON.stringify(obj,null,2)+'\n','utf8');
      await fs.writeFile(path.join(out,name),raw,{flag:'wx'});
      const confirmed=await fs.readFile(path.join(out,name));
      const exact=sha256(confirmed);
      if(confirmed.length!==raw.length||exact!==sha256(raw))
        throw new Error('FORK_STATIC_SOURCE_WRITE_READBACK_MISMATCH: '+name);
      const destination=destinationByName[name];
      if(!destination)throw new Error('FORK_STATIC_OUTPUT_DESTINATION_UNDECLARED: '+name);
      staticHandoffRecords.push({sourceFile:name,destinationRelativePath:destination,
        sha256:exact,bytes:raw.length,schemaVersion:obj?.schemaVersion??null,
        sourceArchiveSha256:request.source.archiveSha256});
    }
    const manifest={schemaVersion:'mi-phase0-fork-static-handoff-v1',
      campaignId:request.campaignId,campaignGenerationId:request.campaignGenerationId,
      sourceArchiveSha256:request.source.archiveSha256,
      buildArtifactBundleSha256,
      fileCount:staticHandoffRecords.length,
      files:staticHandoffRecords.sort((a,b)=>a.destinationRelativePath.localeCompare(b.destinationRelativePath)),
      status:'FORK_ONLY_BYTES_READY_NOT_CONTROLLER_ACCEPTED'};
    await fs.writeFile(path.join(out,'FORK_STATIC_HANDOFF_MANIFEST_v1.json'),
      JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  });

  process.stdout.write(JSON.stringify({status:'PASS',projectPath:detected.relativePath,compiler:cfg,build:{system:build.system,sourceFiles:build.sourceInventoryFiles,artifacts:build.artifacts?.length??0},slither:{status:slither.status,findings:slither.findingCount??0,repairs:slither.repairAttempts?.length??0},sourceIntelligence:{contracts:sourceIntelligence.contracts?.length??0,functions:sourceIntelligence.functions?.length??0,storage:sourceIntelligence.storageLayout?.length??0,callGraph:sourceIntelligence.callGraph?.length??0,externalInterfaces:sourceIntelligence.externalInterfaces?.length??0,valueFlows:sourceIntelligence.valueFlowCandidates?.length??0,dependencyEdges:sourceIntelligence.protocolTopology?.dependencyEdges?.length??0},projectReadiness:{deploymentFiles:projectReadiness.deploymentAndConfiguration.deploymentFiles.length,testFiles:projectReadiness.testingAndToolingReadiness.testFiles.length,harnessFiles:projectReadiness.testingAndToolingReadiness.harnessFiles.length,deployabilityRisks:projectReadiness.bytecodeAndGasEvidence.deployabilityRisks.length},deployConfigExecution:{status:deployConfigExecution.status,attempts:deployConfigExecution.attempts.length,gaps:deployConfigExecution.gaps.length},outputs:files.map(([name])=>name)},null,2)+'\n');
}

main().catch(error=>{console.error(JSON.stringify({status:'FAIL',message:error?.message??String(error),code:error?.code??null,attempts:error?.attempts??null},null,2));process.exitCode=1;});
