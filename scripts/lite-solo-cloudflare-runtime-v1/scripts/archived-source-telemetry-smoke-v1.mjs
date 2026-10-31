#!/usr/bin/env node
// Archived-campaign adapter for the production Phase-0 ABI telemetry engine.
// Operates only on source archives extracted and compiled in this workflow; no campaign writeback.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import * as ethers from 'ethers';
import {targetObjects,prepareQualifiedRuntimeV2,runTelemetry} from '../packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs';

function args(argv) {
  const r={}; for(let i=2;i<argv.length;i++){if(!argv[i].startsWith('--'))continue;r[argv[i].slice(2)]=argv[++i];}
  return r;
}
const a=args(process.argv);
for(const k of ['project','artifacts','archive','output','fork-url','label'])if(!a[k])throw Error('Missing --'+k);
const output=path.resolve(a.output);await fs.mkdir(output,{recursive:true});
const archivesha=createHash('sha256').update(await fs.readFile(a.archive)).digest('hex');
const root=path.resolve(a.artifacts);
async function walk(dir) {
  const rows=[];for(const x of await fs.readdir(dir,{withFileTypes:true})){
    const p=path.join(dir,x.name);
    if(x.isDirectory())rows.push(...await walk(p));
    else if(x.isFile()&&x.name.endsWith('.json')&&!x.name.endsWith('.dbg.json'))rows.push(p);
  }return rows;
}
const artifacts=[];
for(const f of await walk(root)){
  let j;try{j=JSON.parse(await fs.readFile(f,'utf8'));}catch{continue;}
  if(!Array.isArray(j.abi)||!j.bytecode||j.bytecode==='0x'||!/^0x[0-9a-fA-F]+$/.test(j.bytecode))continue;
  artifacts.push({contractName:j.contractName,sourceName:j.sourceName,abi:j.abi,bytecode:j.bytecode,deployedBytecode:j.deployedBytecode});
}
if(!artifacts.length)throw Error('No deployable source artifacts found');
const port=8577,url='http://127.0.0.1:'+port;
const anvilBin=path.resolve('node_modules/@foundry-rs/anvil/bin.mjs');
const child=spawn(process.execPath,[anvilBin,'--host','127.0.0.1','--port',String(port),'--chain-id','1','--fork-url',a['fork-url'],'--accounts','20','--auto-impersonate','--no-rate-limit','--silent'],{cwd:process.cwd(),env:process.env,stdio:['ignore','ignore','pipe']});
let stderr='';child.stderr.on('data',d=>stderr=(stderr+String(d)).slice(-2500));
const deployment=[],failures=[];
function typed(p,actor,addresses,strategy){
  const t=p.type||'';
  if(t.endsWith(']'))return[];
  if(t.startsWith('tuple'))return(p.components||[]).map(c=>typed(c,actor,addresses,strategy));
  if(t==='address')return strategy===0?actor:(addresses[0]||actor);
  if(t==='bool')return false;
  if(t==='string')return '';
  if(t==='bytes')return '0x';
  if(/^bytes\d+$/.test(t))return '0x'+'00'.repeat(Number(t.slice(5)));
  if(/^u?int/.test(t))return strategy===0?0n:1n;
  return 0;
}
let provider;
try{
  for(let i=0;i<120;i++){
    if(child.exitCode!==null)throw Error('Anvil terminated: '+stderr);
    try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(800)});if((await r.json()).result==='0x1')break;}catch{}
    if(i===119)throw Error('Anvil did not start: '+stderr);
    await sleep(250);
  }
  provider=new ethers.JsonRpcProvider(url,1,{staticNetwork:true,cacheTimeout:-1});
  const actors=(await provider.send('eth_accounts',[])).slice(0,4);
  const signer=await provider.getSigner(0);
  const ranked=artifacts.map(artifact=>({
    artifact,ctor:artifact.abi.find(x=>x.type==='constructor')?.inputs||[],
    mutable:artifact.abi.filter(x=>x.type==='function'&&!['view','pure'].includes(x.stateMutability)).length
  })).filter(x=>x.mutable>0&&x.ctor.length<=5)
    .sort((x,y)=>x.ctor.length-y.ctor.length||y.mutable-x.mutable);
  for(const item of ranked){
    if(deployment.length>=18)break;
    let error='';
    for(const strategy of [0,1]){
      const addresses=deployment.map(d=>d.address);
      const values=item.ctor.map(p=>typed(p,actors[0],addresses,strategy));
      try{
        const factory=new ethers.ContractFactory(item.artifact.abi,item.artifact.bytecode,signer);
        const contract=await factory.deploy(...values,{gasLimit:8000000});
        const rc=await contract.deploymentTransaction().wait();
        if(rc.status!==1)throw Error('constructor reverted');
        const address=await contract.getAddress();
        deployment.push({address,contractName:item.artifact.contractName,sourceName:item.artifact.sourceName,qualifiedName:item.artifact.sourceName+':'+item.artifact.contractName,transactionHash:rc.hash,mappingStatus:'ARCHIVED_SOURCE_SMOKE_DEPLOYMENT',constructorStrategy:strategy});
        error='';break;
      }catch(e){error=String(e?.shortMessage||e?.message||e).slice(0,350);}
    }
    if(error)failures.push({qualifiedName:item.artifact.sourceName+':'+item.artifact.contractName,error});
  }
  const targets=targetObjects(ethers,artifacts,deployment,{});
  const report={schemaVersion:'archived-source-telemetry-smoke-v1',family:a.label,archive:a.archive,archiveSha256:archivesha,compiledArtifacts:artifacts.length,deployments:deployment,constructorFailures:failures,callBudget:Number(a.calls||300),targetContracts:targets.length,sourceFidelity:'ARCHIVED_SOURCE_FALLBACK_DEPLOYMENTS_UNCONFIGURED'};
  await fs.writeFile(path.join(output,'SOURCE_TELEMETRY_IDENTITY_v1.json'),JSON.stringify(report,null,2)+'\n');
  if(!targets.length)throw Error('No mutable deployed source-contract targets; telemetry cannot run');
  const prepared=await prepareQualifiedRuntimeV2({provider,ethers,targets,actors});
  const active=prepared.targets||targets;
  const baselineSnapshot=await provider.send('evm_snapshot',[]);
  const result=await runTelemetry({provider,ethers,targets:active,actors,outRoot:output,baselineSnapshot,artifacts,telemetryRuns:1,callsPerRun:report.callBudget,seedSalt:archivesha,runPrefix:'archived-source-abi'});
  const row=result[0];
  const summary={...report,telemetry:row,sourceSetupReceipts:prepared.setupReceipts||[],
    status:row?.calls===report.callBudget&&row?.status==='PASS'?'PASS':'FAIL'};
  await fs.writeFile(path.join(output,'SOURCE_TELEMETRY_SUMMARY_v1.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({status:summary.status,family:a.label,compiledArtifacts:report.compiledArtifacts,deployed:deployment.length,targetContracts:active.length,calls:row.calls,minedSuccess:row.minedSuccess,minedRevert:row.minedRevert,simulatedRejection:row.simulatedRejection,positiveTransitions:row.positiveTransitions,positiveEconomicTransitions:row.positiveEconomicTransitions,observationReads:row.observationReads,rawTranscriptRef:row.rawTranscriptRef},null,2));
  if(summary.status!=='PASS')process.exitCode=1;
}catch(e){
  await fs.writeFile(path.join(output,'SOURCE_TELEMETRY_FAILURE_v1.json'),JSON.stringify({family:a.label,message:String(e?.stack||e),compiledArtifacts:artifacts.length,deployments:deployment,failures},null,2)+'\n');
  console.error(e);process.exitCode=1;
}finally{
  child.kill('SIGTERM');
  await sleep(300).catch(()=>{});
  if(child.exitCode===null)child.kill('SIGKILL');
  provider?.destroy?.();
}
