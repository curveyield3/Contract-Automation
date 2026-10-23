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
import { buildExecutionArtifactBundleV2 } from './phase0-execution-input-v2.mjs';
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
  const candidates=new Set();
  for(const f of files){
    if(/(^|\/)package\.json$/.test(f)||/(^|\/)package-lock\.json$/.test(f)||/(^|\/)hardhat\.config\.(?:js|cjs|mjs|ts)$/.test(f)){
      candidates.add(path.posix.dirname(f));
    }
    const m=f.match(/^(?:(.*?)\/)?(?:contracts|src)\/.+\.sol$/);
    if(m)candidates.add(m[1]||'.');
  }
  const scored=[];
  for(const rel0 of candidates){
    const rel=rel0==='.'?'':rel0;
    if(rel.toUpperCase().includes('ARCHIVE DO NOT USE'))continue;
    const prefix=rel?rel+'/':'';
    const child=files.filter(f=>f.startsWith(prefix));
    const sol=child.filter(f=>f.endsWith('.sol')).length;
    if(sol===0)continue;
    const names=new Set(child.filter(f=>!f.slice(prefix.length).includes('/')).map(f=>f.slice(prefix.length)));
    const hasPkg=names.has('package.json');
    const hasLock=names.has('package-lock.json');
    const hasHardhat=[...names].some(n=>/^hardhat\.config\.(js|cjs|mjs|ts)$/.test(n));
    const hasContracts=child.some(f=>f.startsWith(prefix+'contracts/'));
    const hasTooling=child.some(f=>f.startsWith(prefix+'tooling/'));
    const hasVendor=child.some(f=>f.startsWith(prefix+'vendor/'));
    const depth=rel?rel.split('/').length:0;
    const score=(hasPkg?120:0)+(hasLock?110:0)+(hasContracts?100:0)+(hasHardhat?70:0)+(hasTooling?60:0)+(hasVendor?40:0)+Math.min(sol,80)-depth;
    scored.push({relativePath:rel||'.',score,solidityFiles:sol,hasPkg,hasLock,hasHardhat,hasContracts,hasTooling,hasVendor});
  }
  scored.sort((a,b)=>b.score-a.score||b.solidityFiles-a.solidityFiles||a.relativePath.localeCompare(b.relativePath));
  if(!scored.length)throw new Error('unable to detect Solidity project root from archive');
  const winner=scored[0];
  if(scored[1]&&winner.score===scored[1].score&&winner.solidityFiles===scored[1].solidityFiles)throw new Error(`ambiguous project root: ${winner.relativePath} vs ${scored[1].relativePath}`);
  const absolute=winner.relativePath==='.'?extractRoot:path.join(extractRoot,...winner.relativePath.split('/'));
  return{absolute,relativePath:winner.relativePath,candidates:scored.slice(0,10)};
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
  candidates.sort((a,b)=>b.priority-a.priority||a.basis.localeCompare(b.basis));
  if(!candidates.length)throw new Error('unable to detect exact Solidity compiler version from source package');
  const topPriority=candidates[0].priority;
  const topVersions=[...new Set(candidates.filter(x=>x.priority===topPriority).map(x=>x.version))];
  if(topVersions.length>1)throw new Error(`conflicting explicit Solidity compiler versions: ${topVersions.join(', ')}`);
  const compiler=candidates[0];
  const allText=texts.map(x=>x.text).join('\n');
  const opt=allText.match(/optimizer\s*:\s*\{[\s\S]{0,240}?enabled\s*:\s*(true|false)[\s\S]{0,240}?runs\s*:\s*(\d+)/);
  const runs=opt?Number(opt[2]):Number(foundryDefault.match(/^\s*optimizer_runs\s*=\s*(\d+)/m)?.[1]??200); const enabled=opt?opt[1]==='true':!foundryText||foundryDefault.match(/^\s*optimizer\s*=\s*(true|false)/m)?.[1]==='true';
  const via=allText.match(/viaIR\s*:\s*(true|false)/);
  const evm=allText.match(/evmVersion\s*:\s*['"]([^'"]+)['"]/);
  return{compilerVersion:compiler.version,compilerCandidates:candidates,optimizer:{enabled,runs},viaIR:via?via[1]==='true':foundryDefault.match(/^\s*via_ir\s*=\s*(true|false)/m)?.[1]==='true',evmVersion:evm?.[1]??foundryDefault.match(/^\s*evm_version\s*=\s*['"]([^'"]+)['"]/m)?.[1]??null,evidence};
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
        compiler:'solc',
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
async function runSlitherExport({projectRoot,build,sourceCommit}){
  const compilationUnits=Array.isArray(build?.compilationUnits)?build.compilationUnits.filter(Boolean):[];
  if(compilationUnits.length<=1){
    const exportInfo=await writeCryticCompileExport({projectRoot,build,outDir:path.join(projectRoot,'.audit-slither-export')});
    const raw=await runProcess({command:'slither',args:[exportInfo.exportPath,'--json','-','--exclude-dependencies','--fail-none'],cwd:projectRoot});
    const parsed=parseSlitherJson(raw.stdout);
    return{exportInfo,raw,parsed,success:parsed?.success===true};
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
    const exportInfo=await writeCryticCompileExport({
      projectRoot,
      build:unitBuild,
      outDir:path.join(projectRoot,'.audit-slither-export',unitId)
    });
    totalSourceUnits+=exportInfo.sourceUnitCount??0;
    totalContracts+=exportInfo.contractCount??0;
    const raw=await runProcess({command:'slither',args:[exportInfo.exportPath,'--json','-','--exclude-dependencies','--fail-none'],cwd:projectRoot});
    const parsed=parseSlitherJson(raw.stdout);
    unitResults.push({
      unitId,
      compilerVersion:unit.compilerVersion??null,
      exportInfo,
      exitCode:raw.exitCode,
      signal:raw.signal??null,
      stdout:cleanText(raw.stdout),
      stderr:cleanText(raw.stderr),
      parsedSuccess:parsed?.success??false,
      findingCount:parsed?.detectors?.length??0
    });
    if(parsed?.success!==true){
      return{
        exportInfo:{mode:'PER_COMPILATION_UNIT',compilationUnitCount:compilationUnits.length,sourceUnitCount:totalSourceUnits,contractCount:totalContracts,unitResults},
        raw:{exitCode:raw.exitCode,signal:raw.signal??null,stdout:raw.stdout,stderr:raw.stderr},
        parsed,
        success:false,
        unitResults
      };
    }
    for(const detector of parsed.detectors??[]){
      const key=JSON.stringify(detector);
      if(detectorSeen.has(key))continue;
      detectorSeen.add(key);
      detectors.push(detector);
    }
  }
  return{
    exportInfo:{mode:'PER_COMPILATION_UNIT',compilationUnitCount:compilationUnits.length,sourceUnitCount:totalSourceUnits,contractCount:totalContracts,unitResults},
    raw:{exitCode:0,signal:null,stdout:'',stderr:''},
    parsed:{success:true,detectors},
    success:true,
    unitResults
  };
}

function slitherSucceeded(r){return r&&['completed','completed_with_findings'].includes(r.status)&&r.componentStatus==='COMPLETED';}
function parseSlitherJson(text){
  try{const p=JSON.parse(String(text??''));const d=Array.isArray(p?.results?.detectors)?p.results.detectors:[];return{success:p?.success===true,detectors:d};}catch{return null;}
}
async function slitherRepair({projectRoot,build,sourceCommit}){
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
        inputMode:'EXACT_BUILD_CRYTIC_COMPILE_EXPORT'
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
    ? [literal(campaignPath)+'/','/Audit Skill - Current Authority/*/']
    : null;
  const checkout=await withProgressStage('exact-source-checkout',()=>checkoutExactSource({repository:request.source.repository,commit:request.source.commit,destination:checkoutRoot,sparsePatterns},{environment:process.env}));
  const archiveAbs=path.join(checkoutRoot,...request.source.archivePath.split('/'));
  const archiveBytes=await fs.readFile(archiveAbs); const observed=sha256(archiveBytes);
  if(observed!==request.source.archiveSha256)throw new Error(`source archive SHA mismatch expected ${request.source.archiveSha256} observed ${observed}`);
  const extractionRoot=path.join(work,'archive'); const extraction=await withProgressStage('extract-verified-archive',()=>extractArchive(archiveAbs,extractionRoot));
  const detected=await withProgressStage('detect-project-root',()=>detectProjectRoot(extractionRoot)); const cfg=await withProgressStage('detect-build-config',()=>detectBuildConfig(detected.absolute));
  const auditScope=await loadAuditScope(detected.absolute);

  const pseudo={
    requestId:request.requestId,requestDigest:request.requestDigest??sha256(Buffer.from(JSON.stringify(request))),
    campaignId:request.campaignId,campaignGenerationId:request.campaignGenerationId,assignmentId:'phase0-intelligence',phaseId:'phase-0',profileId:'github-native-compile-v2',
    source:{repository:request.source.repository,commit:request.source.commit,projectPath:detected.relativePath,archivePath:request.source.archivePath,archiveSha256:request.source.archiveSha256},
    configuration:{compilers:[{language:'solidity',version:cfg.compilerVersion}],analysis:{slither:{version:'0.11.6'}},optimizer:cfg.optimizer,evmVersion:cfg.evmVersion,viaIR:cfg.viaIR}
  };

  const build=await withProgressStage('compile-exact-build',()=>compileWithPrivateCacheV1({request,pseudo,projectRoot:detected.absolute,compile:()=>buildProject({projectRoot:detected.absolute,request:pseudo})}));
  const executionBuildArtifacts=buildExecutionArtifactBundleV2({request:pseudo,build});
  const effectiveCfg={...cfg,buildSystem:build.system,compilerVersions:build.compilerVersions??[build.compilerVersion].filter(Boolean),compilerProfiles:build.compilerProfiles??[]};
  const slither=await withProgressStage('slither-static-analysis',()=>slitherRepair({projectRoot:detected.absolute,build,sourceCommit:request.source.commit}));
  const sbom=await withProgressStage('generate-sbom',()=>generateBuildSbomV1({projectRoot:detected.absolute,request:pseudo,build}));
  const sourceIntelligence=await withProgressStage('generate-source-intelligence',()=>generateSourceIntelligenceTechnicalBundleV1({projectRoot:detected.absolute,request:pseudo,build,analysis:{slither}}));
  await writeReviewInventoryOutputsV1({outputDir:out,projectRoot:detected.absolute,build,request,policy:process.env.ADR_DETECTION_POLICY||null,reviewPolicy:process.env.ADR_DETECTION_REVIEW_POLICY||null});
  const projectReadiness=await withProgressStage('scan-project-readiness',()=>scanProjectReadiness({projectRoot:detected.absolute,build,cfg:effectiveCfg}));
  const deployConfigExecution=await withProgressStage('execute-local-deployment-inventory',()=>executeSourceKnownLocalSetup({projectRoot:detected.absolute,projectReadiness}));

  if(!slitherSucceeded(slither))throw new Error('Slither terminal result is not successful');
  if(sourceIntelligence?.completion?.semanticReviewRequired!==true)throw new Error('Source Intelligence completion contract mismatch');

  const buildIdentity={
    schemaVersion:'curveyield-lite-phase0-build-source-identity-v1',
    requestId:request.requestId,campaignId:request.campaignId,campaignGenerationId:request.campaignGenerationId,
    source:{...request.source,checkoutCommit:checkout.commit,archiveSha256Observed:observed},
    discovery:{projectPath:detected.relativePath,topCandidates:detected.candidates,archiveEntryCount:extraction.entryCount,archiveExtractedBytes:extraction.extractedBytes},
    configurationDetection:effectiveCfg,
    auditScope,
    build:{status:build.status,system:build.system,compilerVersion:build.compilerVersion,compilerVersions:build.compilerVersions??[build.compilerVersion].filter(Boolean),compilerProfiles:build.compilerProfiles??[],compilationUnitCount:build.compilationUnits?.length??0,compilationUnits:executionBuildArtifacts.buildIdentity.compilationUnits,buildConfigurationDigestSha256:executionBuildArtifacts.buildConfigurationDigestSha256,embeddedBuildContract:build.embeddedBuildContract??null,sourceInventoryFiles:build.sourceInventoryFiles??0,artifactCount:build.artifacts?.length??0,compilerInputSha256:build.compilerInputSha256??null,compilerOutputSha256:build.compilerOutputSha256??null,stagingManifestSha256:build.stagingManifestSha256??null,diagnosticCount:build.compilerDiagnostics?.length??0,slitherStandardJsonPath:build.slitherStandardJsonPath??null,vendorRootAdapter:build.vendorRootAdapter??null},
    status:'PASS'
  };

  const files=[
    ['BUILD_AND_SOURCE_IDENTITY_v1.json',buildIdentity],
    ['PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json',executionBuildArtifacts],
    ['SBOM_v1.json',sbom],
    ['SLITHER_v1.json',slither],
    ['SOURCE_INTELLIGENCE_AUTOMATED_v1.json',sourceIntelligence],
    ['PROJECT_READINESS_AUTOMATED_v1.json',projectReadiness],
    ['PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',deployConfigExecution]
  ];
  await withProgressStage('write-machine-evidence',async()=>{for(const [name,obj] of files)await fs.writeFile(path.join(out,name),JSON.stringify(obj,null,2)+'\n');});
  process.stdout.write(JSON.stringify({status:'PASS',projectPath:detected.relativePath,compiler:cfg,build:{system:build.system,sourceFiles:build.sourceInventoryFiles,artifacts:build.artifacts?.length??0},slither:{status:slither.status,findings:slither.findingCount??0,repairs:slither.repairAttempts?.length??0},sourceIntelligence:{contracts:sourceIntelligence.contracts?.length??0,functions:sourceIntelligence.functions?.length??0,storage:sourceIntelligence.storageLayout?.length??0,callGraph:sourceIntelligence.callGraph?.length??0,externalInterfaces:sourceIntelligence.externalInterfaces?.length??0,valueFlows:sourceIntelligence.valueFlowCandidates?.length??0,dependencyEdges:sourceIntelligence.protocolTopology?.dependencyEdges?.length??0},projectReadiness:{deploymentFiles:projectReadiness.deploymentAndConfiguration.deploymentFiles.length,testFiles:projectReadiness.testingAndToolingReadiness.testFiles.length,harnessFiles:projectReadiness.testingAndToolingReadiness.harnessFiles.length,deployabilityRisks:projectReadiness.bytecodeAndGasEvidence.deployabilityRisks.length},deployConfigExecution:{status:deployConfigExecution.status,attempts:deployConfigExecution.attempts.length,gaps:deployConfigExecution.gaps.length},outputs:files.map(([name])=>name)},null,2)+'\n');
}

main().catch(error=>{console.error(JSON.stringify({status:'FAIL',message:error?.message??String(error),code:error?.code??null,attempts:error?.attempts??null},null,2));process.exitCode=1;});
