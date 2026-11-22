#!/usr/bin/env node
// Trusted build-time preparation. Takes a bounded manifest derived by admission.
// Never executes source-authored scripts, build hooks, or project executables.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';

const planDir=process.argv[2]||'/opt/preflight/toolchain-plan';
const installRoot=process.argv[3]||'/opt/preflight/prepared-packages';
const plan=JSON.parse(fs.readFileSync(path.join(planDir,'toolchain-plan.json'),'utf8'));
if(plan.schemaVersion!=='curveyield-standalone-toolchain-plan-v1')throw Error('INVALID_TOOLCHAIN_PLAN_SCHEMA');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const isExact=v=>/^\d+\.\d+\.\d+$/.test(v);
const statuses={solidity:[],vyper:[],packages:[],sourcePlanSha256:sha(fs.readFileSync(path.join(planDir,'toolchain-plan.json')))};
const command=(bin,args,cwd)=>spawnSync(bin,args,{cwd,env:{...process.env,CI:'true',npm_config_ignore_scripts:'true'},encoding:'utf8',timeout:300000,maxBuffer:1024*1024});

for(const [index,p] of (plan.packages??[]).entries()){
  if(!/^packages\/\d+$/.test(p.preparedPath)||p.preparedPath!=='packages/'+index)throw Error('INVALID_PREPARED_PACKAGE_PATH');
  const source=path.join(planDir,p.preparedPath);
  const manifest=fs.readFileSync(path.join(source,'package.json'));
  if(sha(manifest)!==p.manifestSha256)throw Error('PREPARED_NPM_MANIFEST_MISMATCH');
  if(p.lockSha256&&sha(fs.readFileSync(path.join(source,'package-lock.json')))!==p.lockSha256)throw Error('PREPARED_NPM_LOCK_MISMATCH');
  const dst=path.join(installRoot,String(index));
  fs.mkdirSync(dst,{recursive:true});
  fs.copyFileSync(path.join(source,'package.json'),path.join(dst,'package.json'));
  if(p.lockSha256)fs.copyFileSync(path.join(source,'package-lock.json'),path.join(dst,'package-lock.json'));
  const args=p.lockSha256?['ci','--ignore-scripts','--no-audit','--no-fund']:
    ['install','--ignore-scripts','--no-audit','--no-fund','--package-lock=false'];
  // The admitted ZIP remains immutable. Repair only this known corrupted integrity
  // entry in the pre-admission build cache, after verifying the canonical npm
  // registry metadata for the same pinned package/version. Report divergence.
  let correctedLockIntegrity=null;
  if(p.lockSha256){
    const lockPath=path.join(dst,'package-lock.json');
    const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
    const entry=lock.packages?.['node_modules/ansi-regex'];
    const bad='sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv38qOOb9pdJlMUEKFQ==';
    const actual='sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==';
    if(entry?.version==='5.0.1'&&entry.integrity===bad
      &&entry.resolved==='https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz'){
      const registry=command('npm',['view','ansi-regex@5.0.1','dist.integrity','--json','--registry=https://registry.npmjs.org/'],dst);
      if(registry.status!==0)throw Error('TRUSTED_NPM_INTEGRITY_LOOKUP_FAILED: '+String(registry.stderr||registry.error));
      const reported=JSON.parse(registry.stdout.trim());
      if(reported!==actual)throw Error('TRUSTED_NPM_INTEGRITY_NOT_EXPECTED: '+String(reported));
      entry.integrity=reported;
      fs.writeFileSync(lockPath,JSON.stringify(lock,null,2)+'\n');
      correctedLockIntegrity={name:'ansi-regex',version:'5.0.1',sourceIntegrity:bad,registryIntegrity:reported,
        sourceArchiveUnmodified:true,preparedLockModified:true};
      console.error('SOURCE_LOCK_INTEGRITY_MISMATCH_CORRECTED_IN_TRUSTED_CACHE_ONLY ansi-regex@5.0.1');
    }
  }
  const result=command('npm',args,dst);
  const status=result.status===0&&fs.existsSync(path.join(dst,'node_modules'))?'PREPARED':'UNAVAILABLE';
  statuses.packages.push({root:p.root,index,status,lockSha256:p.lockSha256??null,correctedLockIntegrity,
    detail:status==='UNAVAILABLE'?String(result.stderr||result.error||'').slice(-550):null});
}
for(const version of (plan.solidityCompilerCandidates??[])){
  if(!isExact(version))throw Error('UNSAFE_SOLIDITY_COMPILER_VERSION');
  const probe=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-solc-'));
  fs.mkdirSync(path.join(probe,'src'));
  fs.writeFileSync(path.join(probe,'src','Probe.sol'),'pragma solidity '+version+'; contract PreflightCompilerProbe {}');
  const result=command('forge',['build','--root',probe,'--force'],probe);
  statuses.solidity.push({version,status:result.status===0?'PREPARED':'UNAVAILABLE',
    detail:result.status===0?null:String(result.stderr||result.error||'').slice(-550)});
  fs.rmSync(probe,{force:true,recursive:true});
}
for(const version of (plan.vyperCompilerVersions??[])){
  if(!isExact(version))throw Error('UNSAFE_VYPER_COMPILER_VERSION');
  const root=path.join('/opt/preflight/vyper-envs',version);
  const created=command('python3',['-m','venv',root],'/opt/preflight');
  const installed=created.status===0
    ?command(path.join(root,'bin','pip'),['install','--disable-pip-version-check','--no-input','--no-cache-dir','vyper=='+version],'/opt/preflight')
    :created;
  statuses.vyper.push({version,status:installed.status===0?'PREPARED':'UNAVAILABLE',
    detail:installed.status===0?null:String(installed.stderr||installed.error||'').slice(-550)});
}
fs.writeFileSync('/opt/preflight/toolchain-status.json',JSON.stringify(statuses,null,2)+'\n');
const failures=[...statuses.solidity,...statuses.vyper,...statuses.packages].filter(x=>x.status==='UNAVAILABLE');
console.log(JSON.stringify({toolchainPlanSha256:statuses.sourcePlanSha256,
  solidity:statuses.solidity.length,vyper:statuses.vyper.length,packageRoots:statuses.packages.length,
  unsupportedOrUnavailable:failures.length}));
// An unsupported compiler is a documented limitation, not a reason to suppress
// the source-only inventory. Do not interpret this as a compilation success.
