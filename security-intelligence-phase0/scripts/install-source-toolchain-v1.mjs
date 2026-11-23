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
const statuses={solidity:[],wake:[],vyper:[],packages:[],sourcePlanSha256:sha(fs.readFileSync(path.join(planDir,'toolchain-plan.json')))};
const command=(bin,args,cwd,extraEnv={})=>spawnSync(bin,args,{cwd,env:{...process.env,CI:'true',npm_config_ignore_scripts:'true',...extraEnv},encoding:'utf8',timeout:300000,maxBuffer:1024*1024});

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
// Prepare Wake's own checksum-verified solc cache while networking is available
// in the trusted, source-blind image build. The collector has --network none.
for(const item of statuses.solidity){
  if(item.status!=='PREPARED'){
    statuses.wake.push({version:item.version,status:'UNAVAILABLE',detail:'Native compiler was not prepared'});
    continue;
  }
  const installed=command('wake',['svm','install',item.version],'/opt/preflight', {XDG_DATA_HOME:'/opt/preflight/.local/share'});
  statuses.wake.push({version:item.version,status:installed.status===0?'PREPARED':'UNAVAILABLE',
    detail:installed.status===0?null:String(installed.stderr||installed.stdout||installed.error||'').slice(-550)});
}
// Native solc is already prepared above from the admitted, pinned compiler
// candidates. Hardhat 2 needs a compiler-index cache as well: otherwise it
// attempts a network fetch inside the intentionally network-isolated collector.
// These entries are the official linux-amd64 solc-bin SHA256 records.
const hardhatKnownBuilds={
  '0.8.28':{path:'solc-linux-amd64-v0.8.28+commit.7893614a',version:'0.8.28',build:'commit.7893614a',
    longVersion:'0.8.28+commit.7893614a',
    keccak256:'0x0d387f5ca7d0f298e79243cec5af7ab42eeb0a414e42f15c66f855d701479c43',
    sha256:'0x9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25',urls:[]},
  '0.8.30':{path:'solc-linux-amd64-v0.8.30+commit.73712a01',version:'0.8.30',build:'commit.73712a01',
    longVersion:'0.8.30+commit.73712a01',
    keccak256:'0xc47307cc6d212f7d86af1ad07800f9ed4715454a1c327a7258e62d769ec8bdc1',
    sha256:'0xf3e987dc6ecebd4bd350c48edcbc320b46cf9e3109bd3fc3d88f1acaf4c428f7',urls:[]}
};
const hardhatCache='/opt/preflight/.cache/hardhat-nodejs/compilers-v2/linux-amd64';
const hardhatBuilds=[],hardhatReleases={};
for(const item of statuses.solidity){
  const build=hardhatKnownBuilds[item.version];
  if(item.status!=='PREPARED'||!build)continue;
  const native=path.join(os.homedir(),'.svm',item.version,'solc-'+item.version);
  if(!fs.existsSync(native)){
    console.error('HARDHAT_CACHE_NATIVE_SOLC_MISSING '+native);
    continue;
  }
  const actual=sha(fs.readFileSync(native));
  if(actual!==build.sha256.slice(2))throw Error('SOLC_NATIVE_OFFICIAL_SHA256_MISMATCH '+item.version);
  fs.mkdirSync(hardhatCache,{recursive:true});
  const cached=path.join(hardhatCache,build.path);
  fs.copyFileSync(native,cached);
  fs.chmodSync(cached,0o755);
  hardhatBuilds.push(build);
  hardhatReleases[build.version]=build.path;
}
if(hardhatBuilds.length){
  const last=hardhatBuilds[hardhatBuilds.length-1].version;
  fs.writeFileSync(path.join(hardhatCache,'list.json'),JSON.stringify({
    builds:hardhatBuilds,releases:hardhatReleases,latestRelease:last
  },null,2)+'\n');
  console.error('PREPARED_HARDHAT_OFFLINE_COMPILER_CACHE '+hardhatBuilds.map(x=>x.version).join(','));
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
const failures=[...statuses.solidity,...statuses.wake,...statuses.vyper,...statuses.packages].filter(x=>x.status==='UNAVAILABLE');
console.log(JSON.stringify({toolchainPlanSha256:statuses.sourcePlanSha256,
  solidity:statuses.solidity.length,wake:statuses.wake.length,vyper:statuses.vyper.length,packageRoots:statuses.packages.length,
  unsupportedOrUnavailable:failures.length}));
// An unsupported compiler is a documented limitation, not a reason to suppress
// the source-only inventory. Do not interpret this as a compilation success.
