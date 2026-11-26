// Independent maintenance checks over the admitted build; not a security verdict.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runProcess} from './execution.mjs';
import {sourceIsInScope} from './phase0-audit-scope-v1.mjs';
import {resolveCompiledSourceFile} from './phase0-compiled-source-resolve-v1.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const jsonDigest=v=>sha(JSON.stringify(v));
const toolsRoot='/opt/phase0-maintenance';
const arr=x=>Array.isArray(x)?x:[];
const ver=s=>String(s??'').match(/^(\d+\.\d+\.\d+)(?:\+|$)/)?.[1]??null;
function safeRel(s){return typeof s==='string'&&s.length>0&&!path.isAbsolute(s)&&!s.includes('\\')&&s.split('/').every(x=>x&&x!=='.'&&x!=='..');}
const limits={solhintWallMs:120000,upgradeWallMs:120000};
const pin={compilerDatabase:'v0.8.39',solhint:'6.2.5',upgradesCore:'1.46.0'};
function baseReport(engine,version,request,bundle){return {schemaVersion:'curveyield-phase0-maintenance-'+engine+'-v1',engine,version,source:request.source,reviewSourceIdentity:{repository:request.source.repository,commit:request.source.commit,requestId:request.requestId,archiveSha256Observed:request.source.archiveSha256,buildConfigurationDigestSha256:bundle.buildConfigurationDigestSha256},authoritativeFinding:false,componentStatus:'FAILED',findingCount:null,detectors:[],limitations:[]};}
async function reportFile(out,name,report){const temp=path.join(out,name+'.tmp');await fs.writeFile(temp,JSON.stringify(report,null,2)+'\n');await fs.rename(temp,path.join(out,name));}
async function checkCompilerDatabase(report,bundle){
  const [raw,metadataRaw,revision]=await Promise.all([
    fs.readFile(toolsRoot+'/bugs_by_version.json'),
    fs.readFile(toolsRoot+'/bugs.json'),
    fs.readFile(toolsRoot+'/solidity-database-revision.txt','utf8')
  ]);
  const data=JSON.parse(raw),metadata=JSON.parse(metadataRaw);
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Invalid official compiler-version catalogue');
  if(!Array.isArray(metadata))throw Error('Invalid official advisory metadata catalogue');
  report.database={release:pin.compilerDatabase,revision:revision.trim(),sha256:sha(raw),source:'https://github.com/argotorg/solidity/tree/'+pin.compilerDatabase+'/docs',
    files:{'bugs_by_version.json':{sha256:sha(raw),versionCount:Object.keys(data).length},'bugs.json':{sha256:sha(metadataRaw),advisoryCount:metadata.length}}};
  // Version-index entries identify advisory names, not UIDs. Several distinct
  // official advisory records share a UID, so never join or deduplicate by UID.
  const byName=new Map();
  for(const advisory of metadata){
    if(typeof advisory?.name!=='string'||typeof advisory?.uid!=='string'||typeof advisory?.severity!=='string'||byName.has(advisory.name))
      throw Error('Invalid or ambiguous official advisory metadata identity');
    byName.set(advisory.name,advisory);
  }
  const units=arr(bundle.buildIdentity?.compilationUnits).filter(u=>arr(u.sourceNames).some(s=>s.endsWith('.sol')));
  report.units=units.map(u=>{
    const version=ver(u.compilerVersion),entry=version?data[version]:null;
    const known=Array.isArray(entry?.bugs);
    const names=known?entry.bugs.filter(x=>typeof x==='string'):null;
    if(known&&names.length!==entry.bugs.length)throw Error('Invalid official catalogue entry '+version);
    return {unitId:u.unitId,compilerVersion:u.compilerVersion,lookupVersion:version,compilerReleased:entry?.released??null,
      coverage:known?'KNOWN_VERSION':'VERSION_NOT_IN_CATALOGUE',advisoryCount:known?names.length:null,settings:u.settings??null,advisories:names};
  });
  const missing=new Set(),distinct=new Map();
  report.detectors=report.units.flatMap(u=>arr(u.advisories).map(name=>{
    const m=byName.get(name);
    if(!m)missing.add(name);
    const record={unitId:u.unitId,compilerVersion:u.lookupVersion,advisory:name,
      metadataStatus:m?'AVAILABLE':'MISSING',
      uid:m?.uid??null,severity:m?.severity??null,summary:m?.summary??null,
      introduced:m?.introduced??null,fixed:m?.fixed??null,link:m?.link??null,
      conditions:m?.conditions??null,officialCheckTypes:Object.keys(m?.check??{}).sort(),
      assessment:'VERSION_MATCH_ONLY_REVIEW_APPLICABILITY'};
    if(!distinct.has(name))distinct.set(name,record);
    return record;
  }));
  function severityCounts(records){
    const counts={};
    for(const row of records){const key=row.severity??'unknown';counts[key]=(counts[key]??0)+1;}
    return Object.fromEntries(Object.entries(counts).sort(([a],[b])=>a.localeCompare(b)));
  }
  report.findingCount=report.detectors.length;
  report.distinctAdvisoryCount=distinct.size;
  report.distinctUidCount=new Set(report.detectors.map(x=>x.uid).filter(Boolean)).size;
  report.metadataCoverage={matched:report.detectors.filter(x=>x.metadataStatus==='AVAILABLE').length,
    missing:report.detectors.filter(x=>x.metadataStatus==='MISSING').length,missingAdvisoryNames:[...missing].sort()};
  report.severityCounts={versionMatches:severityCounts(report.detectors),distinctAdvisories:severityCounts(distinct.values())};
  report.componentStatus=!units.length?'NOT_APPLICABLE':report.units.every(u=>u.coverage==='KNOWN_VERSION')&&!missing.size?'COMPLETED':'PARTIAL';
  report.limitations.push('Version membership is advisory information, not proof that source or compiler settings trigger a bug.');
  report.limitations.push('Official conditions and check types are retained as metadata only; source-dependent applicability is not evaluated.');
  if(missing.size)report.limitations.push('Some official version-index entries lack corresponding advisory metadata; all version matches are retained.');
}
async function checkSolhint(report,{build,projectRoot,auditScope,out}){
  const stage=path.join(out,'work','maintenance-solhint');
  await fs.mkdir(stage,{recursive:true});
  const selected=new Map();
  for(const unit of arr(build.compilationUnits)){
    const names=new Set([...Object.keys(unit.sourceContents??{}),...Object.keys(unit.sourceAsts??{})]);
    for(const name of names){
      if(!name.endsWith('.sol')||!sourceIsInScope(name,auditScope))continue;
      if(!safeRel(name))throw Error('Unsupported source path');
      const bytes=typeof unit.sourceContents?.[name]==='string'?Buffer.from(unit.sourceContents[name]):await fs.readFile(await resolveCompiledSourceFile(projectRoot,name));
      const digest=sha(bytes);
      if(selected.has(name)){if(selected.get(name)!==digest)throw Error('Conflicting source bytes');continue;}
      selected.set(name,digest);
      const target=path.join(stage,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
    }
  }
  report.sourceDigests=[...selected].sort(([a],[b])=>a.localeCompare(b)).map(([sourceName,sha256])=>({sourceName,sha256}));
  if(!selected.size){report.componentStatus='NOT_APPLICABLE';report.findingCount=0;return;}
  // Invoke the documented CLI with a trusted recommended config. One
  // invocation per admitted file records successful zero-message files too:
  // Solhint's JSON formatter itself only emits messages, not file coverage.
  const config=path.join(stage,'.solhint.json');
  await fs.writeFile(config,JSON.stringify({extends:'solhint:recommended'})+'\n');
  const cli=toolsRoot+'/node_modules/.bin/solhint';
  const env={...process.env,CI:'true',HOME:'/tmp'};
  const probe=await runProcess({command:cli,args:['--version'],cwd:stage,timeoutMs:10000,env});
  report.observedVersion=String(probe.stdout??'').trim();
  report.expectedSourceCount=selected.size;
  if(probe.exitCode!==0||report.observedVersion!==pin.solhint)throw Error('Solhint version verification failed: '+report.observedVersion);
  const deadline=Date.now()+limits.solhintWallMs;
  const covered=new Set();
  report.nativeReport=[];
  report.fileResults=[];
  for(const rel of [...selected.keys()].sort()){
    const row={filePath:rel,status:'FAILED',exitCode:null};
    report.fileResults.push(row);
    const remaining=deadline-Date.now();
    if(remaining<=0){row.status='TIME_BUDGET_EXHAUSTED';continue;}
    // The CLI accepts glob patterns. Refuse ambiguous glob syntax instead
    // of accidentally attributing another file's lint report to this file.
    if(/[\\*?[\]{}()!+@]/.test(rel)){row.status='UNSUPPORTED_GLOB_PATH';continue;}
    const raw=await runProcess({command:cli,args:['--config',config,'--formatter','json','--disc','--noPoster','--','./'+rel],cwd:stage,timeoutMs:remaining,env});
    row.exitCode=raw.exitCode;
    row.timedOut=raw.timedOut===true;
    row.stderr=String(raw.stderr??'').slice(-4000);
    try{
      const native=JSON.parse(raw.stdout);
      if(!Array.isArray(native))throw Error('Expected native JSON message array');
      report.nativeReport.push({filePath:rel,messages:native});
      if(row.timedOut||![0,1].includes(raw.exitCode))throw Error('CLI execution incomplete');
      const messages=native.filter(m=>typeof m?.conclusion!=='string');
      if(messages.some(m=>typeof m?.filePath!=='string'||path.relative(stage,path.resolve(stage,m.filePath)).split(path.sep).join('/')!==rel||typeof m.message!=='string'))throw Error('Unexpected CLI message/file identity');
      const parseError=messages.some(m=>!m.ruleId&&String(m.message).startsWith('Parse error:'));
      for(const m of messages)report.detectors.push({sourceName:rel,sourceSha256:selected.get(rel),ruleId:m.ruleId??null,severity:m.severity??null,line:m.line??null,column:m.column??null,message:m.message});
      row.messageCount=messages.length;
      if(parseError){row.status='PARSE_ERROR';continue;}
      if(raw.exitCode===1&&!messages.length)throw Error('Nonzero lint exit without findings');
      row.status='COMPLETED';covered.add(rel);
    }catch(e){row.error=String(e?.message??e).slice(0,2000);}
  }
  report.scannedSourceCount=covered.size;
  report.findingCount=covered.size?report.detectors.length:null;
  report.componentStatus=covered.size===selected.size?'COMPLETED':'PARTIAL';
  if(covered.size!==selected.size)report.limitations.push('Not every source was successfully linted; inspect fileResults.');
}
async function checkUpgrades(report,{build,projectRoot,auditScope,out,bundle}){
  const root=await fs.realpath(projectRoot);
  const stage=path.join(out,'work','maintenance-upgrades');
  await fs.mkdir(stage,{recursive:true});
  const units=arr(bundle.buildIdentity?.compilationUnits).filter(u=>arr(u.sourceNames).some(s=>s.endsWith('.sol')));
  report.units=[];
  if(!units.length){report.componentStatus='NOT_APPLICABLE';report.findingCount=0;return;}
  const pairs=new Map(units.map(u=>[u.compilerInputSha256+':'+u.compilerOutputSha256,u]));
  const matched=new Map();
  const visit=async (dir,depth=0)=>{
    if(depth>10)return;
    for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
      if(e.isSymbolicLink()||['node_modules','.git','vendor','lib'].includes(e.name))continue;
      const target=path.join(dir,e.name);
      if(e.isDirectory()){await visit(target,depth+1);continue;}
      if(!e.isFile()||!e.name.endsWith('.json')||!/(?:build-info|\.phase0-isolated-build-info-v1)(?:\/|$)/.test(target))continue;
      try{
        const real=await fs.realpath(target);if(!real.startsWith(root+path.sep))continue;
        if((await fs.stat(real)).size>150*1024*1024)continue;
        const bytes=await fs.readFile(real),d=JSON.parse(bytes);
        if(d?.input?.language!=='Solidity'||!d?.output?.contracts||!d?.output?.sources)continue;
        const key=jsonDigest(d.input)+':'+jsonDigest(d.output);
        const unit=pairs.get(key);if(!unit||matched.has(unit.unitId))continue;
        matched.set(unit.unitId,{bytes,sha256:sha(bytes)});
      }catch{}
    }
  };
  await visit(root);
  const deadline=Date.now()+limits.upgradeWallMs;
  for(const [i,u] of units.entries()){
    const row={unitId:u.unitId,compilerVersion:u.compilerVersion,status:'MISSING_EXACT_BUILD_INFO',storageComparison:'REFERENCE_DEPENDENT_SEE_NATIVE_REPORT',numTotal:null,numPassed:null};
    report.units.push(row);
    const match=matched.get(u.unitId);if(!match)continue;
    row.buildInfoSha256=match.sha256;
    const d=JSON.parse(match.bytes);
    const names=Object.entries(d.output.contracts).flatMap(([s,c])=>Object.keys(c??{}).map(n=>({s,n,raw:c[n]})));
    row.missingStorageLayoutCount=names.filter(x=>!x.raw.storageLayout).length;
    row.missingAstCount=names.filter(x=>!d.output.sources[x.s]?.ast).length;
    if(row.missingStorageLayoutCount||row.missingAstCount){row.status='MISSING_STORAGE_LAYOUT_OR_AST';continue;}
    const targetDir=path.join(stage,'unit-'+i);await fs.mkdir(targetDir,{recursive:true});
    await fs.writeFile(path.join(targetDir,'build-info.json'),match.bytes);
    try{
      // The official API consumes only exact retained compiler build info; do not rebuild,
      // invoke project scripts, guess references or bypass storage checks.
      const excluded=[...new Set(names.filter(x=>!sourceIsInScope(x.s,auditScope)).map(x=>x.s))];
      const remaining=deadline-Date.now();
      if(remaining<=0){row.status='TIME_BUDGET_EXHAUSTED';continue;}
      const program="const fs=require('node:fs');const core=require('/opt/phase0-maintenance/node_modules/@openzeppelin/upgrades-core');const [dir,excluded,file]=process.argv.slice(1);core.validateUpgradeSafety(dir,undefined,undefined,{},undefined,JSON.parse(excluded)).then(r=>fs.writeFileSync(file,JSON.stringify({ok:r.ok,numTotal:r.numTotal,numPassed:r.numPassed,report:r.explain(false)}))).catch(e=>{console.error(String(e.message||e));process.exitCode=1;});";
      const resultFile=path.join(stage,'result-'+i+'.json');
      const raw=await runProcess({command:process.execPath,args:['-e',program,targetDir,JSON.stringify(excluded),resultFile],cwd:stage,timeoutMs:remaining,env:{...process.env,CI:'true',HOME:'/tmp'}});
      if(raw.timedOut||raw.exitCode!==0)throw Error(raw.timedOut?'Upgrade check exceeded time budget':String(raw.stderr??'').slice(-2000));
      const r=JSON.parse(await fs.readFile(resultFile,'utf8'));
      if(typeof r.ok!=='boolean'||!Number.isSafeInteger(r.numTotal)||!Number.isSafeInteger(r.numPassed)||r.numPassed<0||r.numTotal<r.numPassed)throw Error('Unexpected upgrade report format');
      row.numTotal=r.numTotal;row.numPassed=r.numPassed;
      row.report=r.report;
      row.status=r.numTotal===0?'NO_UPGRADEABLE_CONTRACTS_DETECTED':'COMPLETED';
      if(r.ok===false)report.detectors.push({unitId:u.unitId,kind:'UPGRADE_VALIDATION_REPORT',message:row.report,failedContractCount:r.numTotal-r.numPassed});
    }catch(e){row.status='VALIDATION_UNAVAILABLE';row.error=String(e?.message??e).slice(0,2000);}
  }
  report.findingCount=report.detectors.length;
  report.componentStatus=report.units.every(u=>u.status==='NO_UPGRADEABLE_CONTRACTS_DETECTED')?'NOT_APPLICABLE':report.units.every(u=>['COMPLETED','NO_UPGRADEABLE_CONTRACTS_DETECTED'].includes(u.status))?'COMPLETED':'PARTIAL';
  report.limitations.push('Only explicitly supported upgradeable contracts are validated. A missing prior implementation/reference never establishes storage compatibility. Native exact build info is required; unavailable units remain visible.');
}
export async function collectMaintenanceChecks({request,build,bundle,projectRoot,auditScope,out}){
  const context={request,build,bundle,projectRoot,auditScope,out};
  const entries=[
    ['SOLIDITY_COMPILER_BUGS_v1.json','compiler-bugs',pin.compilerDatabase,r=>checkCompilerDatabase(r,bundle)],
    ['SOLHINT_v1.json','solhint',pin.solhint,r=>checkSolhint(r,context)],
    ['OPENZEPPELIN_UPGRADES_v1.json','openzeppelin-upgrades',pin.upgradesCore,r=>checkUpgrades(r,context)]
  ];
  for(const [file,engine,version,run] of entries){
    const report=baseReport(engine,version,request,bundle);
    try{await run(report);}catch(e){report.componentStatus='PARTIAL';report.limitations.push(String(e?.message??e).slice(0,2000));}
    await reportFile(out,file,report);
    console.error('[phase0-maintenance] '+engine+' '+report.componentStatus);
  }
}
