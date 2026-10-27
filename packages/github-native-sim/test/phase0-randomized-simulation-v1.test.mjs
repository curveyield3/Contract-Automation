import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildBurstSchedule,medusaWrappers,phase0DiscoveredTargetChainIdsV1,PHASE0_ACCOUNTING_ACTION_WEIGHT_V1,canonicalEthereumExecutionOverrides,snapshot,pickFn,executionSecretValuesV2,redactExecutionSecretsV2} from '../src/phase0-randomized-simulation-v1.mjs';
import {extractSourceKnownDeployPlanV1,extractSourceKnownBindingsV1,extractSourceKnownCompileGroupsV1} from '../src/source-known-deployment-plan-v1.mjs';

function rngSeq(values){let i=0;return()=>values[(i++)%values.length];}
function fn(accounting,name='f'){
  return {accounting,fragment:{inputs:[],format(){return name;}},signature:name};
}

test('Phase-0 burst schedule assigns exactly 80 percent accounting actions when both classes exist',()=>{
  const targets=[
    {qualifiedName:'A',functions:[fn(true,'deposit()'),fn(false,'pause()')]},
    {qualifiedName:'B',functions:[fn(true,'withdraw()'),fn(false,'setFee()')]},
    {qualifiedName:'C',functions:[fn(true,'stake()'),fn(false,'setAdmin()')]}
  ];
  const schedule=buildBurstSchedule(targets,1000,rngSeq([0.11,0.83,0.27,0.66,0.42,0.94,0.31]));
  const accounting=schedule.filter(x=>x.actionClass==='ACCOUNTING_STATE_CHANGE').reduce((n,x)=>n+x.count,0);
  const other=schedule.filter(x=>x.actionClass==='OTHER_STATE_CHANGE').reduce((n,x)=>n+x.count,0);
  assert.equal(accounting,Math.round(1000*PHASE0_ACCOUNTING_ACTION_WEIGHT_V1));
  assert.equal(other,1000-accounting);
  assert.equal(accounting+other,1000);
});

test('Phase-0 burst schedule revisits contracts instead of exhausting one contract at a time',()=>{
  const targets=[
    {qualifiedName:'A',functions:[fn(true,'deposit()'),fn(false,'pause()')]},
    {qualifiedName:'B',functions:[fn(true,'withdraw()'),fn(false,'setFee()')]},
    {qualifiedName:'C',functions:[fn(true,'stake()'),fn(false,'setAdmin()')]}
  ];
  const schedule=buildBurstSchedule(targets,1200,rngSeq([0.02,0.74,0.38,0.91,0.16,0.55,0.81,0.24]));
  assert.ok(schedule.length>3);
  for(let i=1;i<schedule.length;i++) assert.notEqual(schedule[i].targetIndex,schedule[i-1].targetIndex);
  const seen=new Map();
  schedule.forEach((x,i)=>{const list=seen.get(x.targetIndex)??[];list.push(i);seen.set(x.targetIndex,list);});
  assert.ok([...seen.values()].some(xs=>xs.length>1),'at least one contract should be revisited in a later burst');
});

test('Phase-0 burst schedule terminates and uses available mutable actions when no accounting mutator exists',()=>{
  const targets=[
    {qualifiedName:'A',functions:[fn(false,'pause()')]},
    {qualifiedName:'B',functions:[fn(false,'setFee()')]}
  ];
  const schedule=buildBurstSchedule(targets,250,rngSeq([0.1,0.7,0.3,0.9]));
  const total=schedule.reduce((n,x)=>n+x.count,0);
  assert.equal(total,250);
  assert.ok(schedule.every(x=>x.actionClass==='OTHER_STATE_CHANGE'));
});

test('Medusa wrapper population carries stochastic headroom above the 80 percent achieved-dispatch floor',()=>{
  const fakeEthers={};
  const targets=[
    {qualifiedName:'A',address:'0x0000000000000000000000000000000000000001',functions:[fn(true,'deposit()'),fn(false,'pause()')]},
    {qualifiedName:'B',address:'0x0000000000000000000000000000000000000002',functions:[fn(true,'withdraw()'),fn(false,'setFee()')]},
    {qualifiedName:'C',address:'0x0000000000000000000000000000000000000003',functions:[fn(true,'stake()'),fn(false,'setAdmin()')]}
  ];
  const plan=medusaWrappers(fakeEthers,targets);
  assert.ok(plan.rows.length>0);
  assert.ok(plan.accountingWrapperShare>=0.85);
});


test('Phase-0 chain admission reads discovered target chain IDs from readiness',()=>{
  const readiness={deploymentAndConfiguration:{discoveredChainIds:[
    {chainId:8453,path:'deploy.mjs',line:1},
    {chainId:8453,path:'hardhat.config.cjs',line:2}
  ]}};
  assert.deepEqual(phase0DiscoveredTargetChainIdsV1(readiness),[8453]);
  assert.deepEqual(phase0DiscoveredTargetChainIdsV1({}),[]);
});


test('Phase-0 canonical Ethereum baseline uses the qualified RPC identity proxy instead of rejecting virtualized upstream chain IDs',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  assert.match(source,/startRpcIdentityProxy/);
  // The Ethereum lane defaults to chain 1 and normalizes virtualized upstreams; only an
  // audit-deployment.json chain profile requires the real upstream chain to match.
  assert.match(source,/function startAnvil\(\{forkUrl,projectRoot,evmVersion='cancun',chainId=1,requireUpstreamChainId=false,forkBlockNumber=null\}\)/);
  assert.match(source,/upstreamUrl:forkUrl,chainId\}/);
  assert.match(source,/--fork-url',identityProxy\.url/);
  assert.doesNotMatch(source,/if\(upstreamChainId!==1\)/);
  assert.match(source,/if\(requireUpstreamChainId&&upstreamChainId!==chainId\)/);
  assert.match(source,/requireUpstreamChainId:Boolean\(deploymentProfile\)/);
  assert.match(source,/identityNormalized:anvil\.identityNormalized===true/);
});


test('Phase-0 artifact ABI normalization accepts array, nested abi array, and numeric-key object forms',async()=>{
  const sourcePath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/phase0-randomized-simulation-v1.mjs');
  const source=fs.readFileSync(sourcePath,'utf8');
  assert.match(source,/function normalizedAbi\(abi\)/);
  assert.match(source,/Array\.isArray\(abi\)/);
  assert.match(source,/Array\.isArray\(abi\?\.abi\)/);
  assert.match(source,/Object\.values\(abi\)/);
  assert.doesNotMatch(source,/new ethers\.Interface\(a\.abi\?\?\[\]\)/);
});


test('Phase-0 source-known adapter extracts constructor-bearing deployment order without executing the source script',()=>{
  const source=[
    'const DAO = envAddress("DAO", "0x1111111111111111111111111111111111111111");',
    'const PAUSE = Number(envBigInt("PAUSE", 365n * 24n * 60n * 60n));',
    'const first = await deploy("First", [account.address]);',
    'const second = await deploy("Second", [first, DAO, PAUSE, "Phase0"]);',
    'await deploy("QueryLibrary", [], { library: true });'
  ].join('\n');
  const plan=extractSourceKnownDeployPlanV1(source);
  assert.equal(plan.length,3);
  assert.deepEqual(plan.map(x=>[x.binding,x.contractName,x.library]),[
    ['first','First',false],
    ['second','Second',false],
    [null,'QueryLibrary',true]
  ]);
  assert.deepEqual(plan[1].argExpressions,['first','DAO','PAUSE','"Phase0"']);
  const bindings=extractSourceKnownBindingsV1(source);
  assert.equal(bindings.get('DAO'),'0x1111111111111111111111111111111111111111');
  assert.equal(bindings.get('PAUSE'),31536000n);
});

test('Phase-0 fallback consumes source-known deployment plans and no longer caps zero-arg coverage at eight contracts',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  assert.match(source,/deploySourceKnownPlanV1/);
  assert.match(source,/sourcePlanUnresolved/);
  assert.doesNotMatch(source,/slice\(0,max\)/);
  assert.doesNotMatch(source,/max=8/);
});

test('compiler artifacts preserve library link references required by constructor graph fallback',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../../runner/src/compiler.mjs'),'utf8');
  assert.match(source,/evm\.bytecode\.linkReferences/);
  assert.match(source,/linkReferences:\s*artifact\?\.evm\?\.bytecode\?\.linkReferences/);
});


test('Phase-0 source-known compile groups preserve deployment entries separately from requested contract names',()=>{
  const source=`
    const coreEntries = [
      "contracts/Foo.sol",
      "../../vendor/pkg/contracts/Vault.sol",
      "contracts/UnusedButRequiredSource.sol",
    ];
    const hooksEntries = ["contracts/Hook.sol"];
    function compileAll() {
      const groups = [
        [coreEntries, ["Foo", "Vault"]],
        [hooksEntries, ["Hook"]],
      ];
      return groups;
    }
  `;
  const groups=extractSourceKnownCompileGroupsV1(source);
  assert.equal(groups.length,2);
  assert.deepEqual(groups[0].entryFiles,[
    'contracts/Foo.sol',
    '../../vendor/pkg/contracts/Vault.sol',
    'contracts/UnusedButRequiredSource.sol'
  ]);
  assert.deepEqual(groups[0].contractNames,['Foo','Vault']);
  assert.deepEqual(groups[1].entryFiles,['contracts/Hook.sol']);
  assert.deepEqual(groups[1].contractNames,['Hook']);
});

test('Phase-0 randomized simulation binds exported accepted build artifacts before starting Anvil without a second compile',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  const bindAt=source.indexOf('validateExecutionInputJoinV2');
  const anvilAt=source.indexOf('anvil=await startAnvil');
  assert.ok(bindAt>=0);
  assert.ok(anvilAt>bindAt);
  assert.match(source,/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2\.json/);
  assert.match(source,/EXACT_ACCEPTED_PHASE0_EXECUTION_BUILD_ARTIFACTS_V2/);
  assert.doesNotMatch(source,/await buildProject\(/);
});


test('Phase-0 canonicalizes enum ABI parameters before ethers Interface parsing',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  assert.match(source,/internalBase\.startsWith\('enum '\)/);
  assert.match(source,/next\.type=\`uint8\$\{arraySuffix\}\`/);
  assert.match(source,/rows\.map\(canonicalAbiFragment\)/);
});

test('Phase-0 Medusa execution emits a heartbeat every thirty seconds',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  assert.match(source,/progress heartbeat every 30s/);
  assert.match(source,/setInterval\([\s\S]*?,30000\)/);
  assert.match(source,/\[phase0-medusa\] heartbeat:/);
  assert.match(source,/clearInterval\(heartbeat\)/);
});


test('Phase-0 telemetry emits thirty-second progress heartbeats with live call counters',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  assert.match(source,/\[phase0-telemetry\].*heartbeat every 30s/);
  assert.match(source,/\[phase0-telemetry\] heartbeat: run=/);
  assert.match(source,/calls=\$\{stats\.calls\}\/\$\{callsPerRun\}/);
  assert.match(source,/clearInterval\(telemetryHeartbeat\)/);
});


test('Phase-0 source-known bindings parse multiline envAddress defaults with trailing commas',()=>{
  const source=`
    const DAO = envAddress(
      "CURVEYIELD_DAO",
      "0x7142b1Cc5F91A736A62e77581F406338328F05bC",
    );
  `;
  const bindings=extractSourceKnownBindingsV1(source);
  assert.equal(bindings.get('DAO'),'0x7142b1Cc5F91A736A62e77581F406338328F05bC');
});

test('Phase-0 incomplete deployment is preserved and blocks randomized execution',()=>{
  const source=fs.readFileSync(new URL('../src/phase0-randomized-simulation-v1.mjs',import.meta.url),'utf8');
  const start=source.indexOf('// Persist deployment diagnostics before');
  const end=source.indexOf('medusa=await runMedusa');
  assert.ok(start>0&&end>start);
  assert.match(source.slice(start,end),/PHASE0_DEPLOYMENT_INCOMPLETE/);
  assert.match(source.slice(start,end),/throw error/);
});

test('legacy Phase-0 randomized rebind is disabled after deployment-only migration',()=>{
  const workflow=fs.readFileSync(new URL('../../../.github/workflows/lite-phase0-simulation-rebind-v1.yml',import.meta.url),'utf8');
  assert.match(workflow,/Retired Phase 0 Randomized Simulation Rebind v2/);
  assert.doesNotMatch(workflow,/run-phase0-randomized-simulation-v1\.mjs|phase0-simulation-rebind\/\*\.json/);
});


test('Phase-0 randomized simulation reuses exact accepted multi-profile artifacts instead of flattening or rebuilding',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  assert.match(source,/executionBuildArtifacts\.buildIdentity\?\.compilerProfiles/);
  assert.match(source,/EXACT_ACCEPTED_PHASE0_EXECUTION_BUILD_ARTIFACTS_V2/);
  assert.match(source,/artifacts:sharedExecutionInputs\.artifacts/);
  assert.doesNotMatch(source,/await buildProject\(/);
});

test('gas overrides bind to consumed environment keys, including WEI suffix',()=>{
  const result=canonicalEthereumExecutionOverrides('const MAX_FEE_PER_GAS=envBigInt("MAX_FEE_PER_GAS_WEI",1); const MAX_PRIORITY_FEE_PER_GAS=envBigInt("MAX_PRIORITY_FEE_PER_GAS_WEI",2);');
  assert.deepEqual(result.env,{MAX_FEE_PER_GAS_WEI:'1000000000000',MAX_PRIORITY_FEE_PER_GAS_WEI:'1000000000'});
  assert.deepEqual(result.adaptations.map(x=>x.env),Object.keys(result.env));
  const legacy=canonicalEthereumExecutionOverrides('const fee=process.env.MAX_FEE_PER_GAS; const tip=envBigInt("MAX_PRIORITY_FEE_PER_GAS",2);');
  assert.deepEqual(legacy.env,{MAX_FEE_PER_GAS:'1000000000000',MAX_PRIORITY_FEE_PER_GAS:'1000000000'});
  assert.deepEqual(canonicalEthereumExecutionOverrides('const MAX_FEE_PER_GAS=1;').env,{});
});

test('summary telemetry projection preserves terminal status used by completeness gate',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  const prefix='telemetry:telemetry.map(x=>(';
  const start=source.indexOf(prefix)+prefix.length;
  const end=source.indexOf(')),deployment:',start);
  const project=new Function('x','return ('+source.slice(start,end)+')');
  assert.equal(project({runId:'shard',status:'PASS',calls:1200}).status,'PASS');
  assert.equal(project({runId:'shard',status:'FAILED',calls:1200}).status,'FAILED');
});

test('package deployment report wins over bytecode discovery at the same address',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const source=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  const merge=source.match(/for\(const row of \[\.\.\.[^\]]+\]\)deploymentRowsByAddress\.set\(String\(row\.address\)\.toLowerCase\(\),row\);/)[0];
  const reported={rows:[{address:'0xabc',contractName:'LinkedLibrary',mappingStatus:'PACKAGE_DEPLOYMENT_REPORT'}]};
  const discoveredScriptDeployments=[{address:'0xabc',contractName:null,mappingStatus:'UNMAPPED_CREATION'},{address:'0xdef',contractName:'Extra'}];
  const deploymentRowsByAddress=new Map();
  new Function('reported','discoveredScriptDeployments','deploymentRowsByAddress',merge)(reported,discoveredScriptDeployments,deploymentRowsByAddress);
  assert.equal(deploymentRowsByAddress.get('0xabc').contractName,'LinkedLibrary');
  assert.equal(deploymentRowsByAddress.get('0xdef').contractName,'Extra');
});

test('incomplete deployment persists evidence before stopping',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const s=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  const start=s.indexOf('// Persist deployment diagnostics before');
  const end=s.indexOf('medusa=await runMedusa');
  assert.ok(start>0&&end>start);
  assert.match(s.slice(start,end),/PHASE0_DEPLOYMENT_INCOMPLETE/);
  assert.match(s.slice(start,end),/throw error/);
});
test('Medusa compiles its standalone router without invoking production framework',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const s=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  const run=s.slice(s.indexOf('async function runMedusa('),s.indexOf('function baselineTargetRows'));
  assert.match(run,/router-project/);
  assert.match(run,/foundry.toml/);
  assert.match(run,/cwd:medusaProject/);
  assert.doesNotMatch(run,/cwd:projectRoot/);
});
test('batched baseline accounting preserves local observations without sweeping unrelated deployed contracts',async()=>{
  class FakeContract {
    getFunction(signature){return{staticCall:async(...args)=>signature+args.join(',')};}
  }
  const balanceReads=[];
  const result=await snapshot({
    provider:{getBalance:async a=>{balanceReads.push(a);return BigInt(a);}},
    ethers:{Contract:FakeContract},
    target:{address:'2',artifact:{abi:[]}},
    sender:'1',
    plan:{zero:[{format:()=> 'totalSupply()'}],address:[{format:()=> 'balanceOf(address)'}],addressPair:[]},
    systemTargets:[{address:'2'},{address:'3'}]
  });
  assert.deepEqual(result.native,{sender:'1',target:'2'});
  assert.deepEqual(result.systemNative,{});
  assert.deepEqual(balanceReads.sort(),['1','2']);
  assert.equal(Object.keys(result.views).length,3);
});

test('native deployment budget includes production compilation and broadcasts with bounded heartbeats',()=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  const s=fs.readFileSync(path.resolve(here,'../src/phase0-randomized-simulation-v1.mjs'),'utf8');
  const run=s.slice(s.indexOf('async function executeDeploymentScripts'),s.indexOf('async function reportedPackageDeployments'));
  assert.equal((run.match(/900s/g)??[]).length,3);
  assert.doesNotMatch(run,/240s/);
  assert.ok(s.includes('native ${stream} activity; elapsed='),'native output-driven progress must be logged');
  assert.ok(s.includes("onStdout:(text,child)=>{noteActivity('stdout',text)"));
  assert.ok(s.includes("onStderr:(text,child)=>{noteActivity('stderr',text)"));
  assert.ok(s.includes('inactivity limit=300s; progress requires native stdout/stderr'));
  assert.match(s,/clearInterval\(heartbeat\)/);
});

test('A23 blocked wrong-context selection yields null so caller can reroute instead of resurrecting blocked function',()=>{
  const fn={signature:'setObserved(uint256)',accounting:false};
  const target={address:'0x0000000000000000000000000000000000000001',qualifiedName:'Heldout.sol:Logic',logicalQualifiedName:'Heldout.sol:Logic',functions:[fn]};
  const key='0x0000000000000000000000000000000000000001|Heldout.sol:Logic|setObserved(uint256)';
  assert.equal(pickFn(target,()=>0.5,'OTHER_STATE_CHANGE',new Map(),new Set([key])),null);
  assert.equal(pickFn(target,()=>0.5,'OTHER_STATE_CHANGE',new Map(),new Set()).selected.signature,'setObserved(uint256)');
});

test('A19/A23 telemetry schedule reserves at least one attempt for every admitted target/context class',()=>{
  const targets=[
    {functions:[{accounting:true},{accounting:false}]},
    {functions:[{accounting:false}]},
    {functions:[{accounting:true}]},
    {functions:[{accounting:false}]}
  ];
  const schedule=buildBurstSchedule(targets,100,()=>0.5);
  const accountingSeen=new Set(schedule.filter(x=>x.actionClass==='ACCOUNTING_STATE_CHANGE').map(x=>x.targetIndex));
  const otherSeen=new Set(schedule.filter(x=>x.actionClass==='OTHER_STATE_CHANGE').map(x=>x.targetIndex));
  assert.deepEqual([...accountingSeen].sort((a,b)=>a-b),[0,2]);
  assert.deepEqual([...otherSeen].sort((a,b)=>a-b),[0,1,3]);
  assert.equal(schedule.reduce((n,x)=>n+x.count,0),100);
  assert.ok(schedule.filter(x=>x.calibration===true).length>=5);
});

test('Phase-0 script output redaction keeps paths and only removes secret values',()=>{
  const key='0x'+'ab'.repeat(32);
  const env={HOME:'/home/runner',PATH:'/usr/bin:/bin',RPC_URL:'http://127.0.0.1:8545',PRIVATE_KEY:key,DEPLOYER_PRIVATE_KEY:key};
  const out=redactExecutionSecretsV2(`Report: /home/runner/work/x/deployments/fresh.json\nkey=${key}`,executionSecretValuesV2(env,[key]));
  assert.match(out,/Report: \/home\/runner\/work\/x\/deployments\/fresh\.json/);
  assert.ok(!out.includes(key));
});
