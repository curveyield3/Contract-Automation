#!/usr/bin/env node
// Fork-only Lite-Solo supervisor; original Phase-0 watchdog remains byte-identical.
// Independent worker for Phase 0 intelligence: a synchronous WASM solc compile
// blocks Node timers, so this supervisor uses Linux /proc CPU counters.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PHASE0_COMPILE_WATCHDOG_V1=Object.freeze({
  pollMs:30000,reportMs:60000,
  compileWallMs:30*60*1000,compileIdleMs:8*60*1000
});
export function phase0CompileStallReasonV1({now,compileStartedAt,lastCpuProgressAt,compileActive},
  settings=PHASE0_COMPILE_WATCHDOG_V1){
  if(!compileActive)return null;
  if(now-compileStartedAt>=settings.compileWallMs)return 'COMPILATION_30_MINUTE_LIMIT';
  if(now-lastCpuProgressAt>=settings.compileIdleMs)return 'COMPILATION_CPU_STALLED';
  return null;
}
function taskTreeCpu(rootPid,lastTicks){
  const tasks=[];
  for(const p of fs.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p))){
    try{
      const s=fs.readFileSync('/proc/'+p+'/stat','utf8'),i=s.lastIndexOf(')');
      if(i<0)continue;
      const a=s.slice(i+2).trim().split(/\s+/),pid=Number(p);
      tasks.push({pid,ppid:Number(a[1]),ticks:Number(a[11])+Number(a[12]),rssPages:Number(a[21])});
    }catch{}
  }
  const byParent=new Map();
  for(const p of tasks){if(!byParent.has(p.ppid))byParent.set(p.ppid,[]);byParent.get(p.ppid).push(p);}
  const queue=[rootPid],seen=new Set(),members=[];
  for(let i=0;i<queue.length;i++){
    const pid=queue[i];if(seen.has(pid))continue;seen.add(pid);
    const own=tasks.find(p=>p.pid===pid);if(own)members.push(own);
    for(const child of byParent.get(pid)??[])queue.push(child.pid);
  }
  let delta=0,mem=0;
  for(const p of members){
    const prior=lastTicks.get(p.pid);
    if(prior!==undefined && p.ticks>prior)delta+=p.ticks-prior;
    lastTicks.set(p.pid,p.ticks);
    mem+=p.rssPages;
  }
  for(const pid of lastTicks.keys())if(!seen.has(pid))lastTicks.delete(pid);
  return{cpuTicksAdvanced:delta,processes:members.length,rssMiB:Math.round(mem*4096/1048576)};
}
export async function runCompileWatchdogV1(args=process.argv.slice(2)){
  const marker=args.indexOf('--'),mode=args[0];
  const engines=new Set(['packages/github-native-sim/src/lite-solo-phase0-intelligence-v1.mjs',
    'packages/github-native-sim/src/audit-preview-phase0-intelligence-v1.mjs']);
  if(mode!=='primary' || marker!==1 ||
    args[marker+1]!=='node' || !engines.has(args[marker+2]))throw new Error('invalid canonical Phase 0 intelligence supervisor invocation');
  const child=spawn(process.execPath,args.slice(marker+2),{
    cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe'],detached:true
  });
  const ticks=new Map();
  let phase='setup',compileActive=false,compileStartedAt=0,lastCpuProgressAt=0;
  let lastReportAt=0,exiting=false,finished=false,exitCode=0;
  const log=message=>process.stderr.write('[phase0-compile-watchdog] '+message+'\n');
  function terminate(reason,code=124){
    if(exiting||finished)return;
    exiting=true;exitCode=code;
    log('FAILED reason='+reason+' phase='+phase+' compile_elapsed_seconds='+
      (compileActive?Math.floor((Date.now()-compileStartedAt)/1000):0));
    try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}
    const t=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);t.unref?.();
  }
  function onLine(line){
    const m=line.match(/\[(?:phase0-intelligence-primary)\] START ([a-z0-9-]+)/);
    if(m){phase=m[1];if(phase==='compile-exact-build'){lastCpuProgressAt=Date.now();}
      log('stage='+phase+' starting');}
    if(line.includes('[phase0-build-cache] COMPILATION_START')){
      compileActive=true;compileStartedAt=Date.now();lastCpuProgressAt=Date.now();
      log('active Solidity compilation started; wall_limit_seconds=1800 cpu_idle_limit_seconds=480');
    }
    if(line.includes('[phase0-build-cache] COMPILATION_DONE')){
      compileActive=false;log('Solidity compiler finished; private cache publication follows');
    }
    if(line.includes('[phase0-build-cache] verified private cache HIT')){
      compileActive=false;log('exact verified private compiler cache HIT');
    }
    const e=line.match(/\[(?:phase0-intelligence-primary)\] (?:DONE|FAILED) ([a-z0-9-]+)/);
    if(e?.[1]==='compile-exact-build')compileActive=false;
  }
  for(const [src,dest] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]){
    let buffer='';
    src.on('data',data=>{
      dest.write(data);buffer+=data.toString('utf8');
      const lines=buffer.split('\n');buffer=lines.pop()??'';
      if(buffer.length>16384)buffer=buffer.slice(-2048);
      for(const line of lines)onLine(line);
    });
  }
  const timer=setInterval(()=>{
    if(finished||exiting)return;
    const now=Date.now();
    try{
      const cpu=taskTreeCpu(child.pid,ticks);
      if(compileActive&&cpu.cpuTicksAdvanced>0)lastCpuProgressAt=now;
      const reason=phase0CompileStallReasonV1({now,compileStartedAt,lastCpuProgressAt,compileActive});
      if(reason){terminate(reason);return;}
      if(now-lastReportAt>=PHASE0_COMPILE_WATCHDOG_V1.reportMs){
        lastReportAt=now;
        log('HEALTH stage='+phase+' compile_seconds='+
          (compileActive?Math.floor((now-compileStartedAt)/1000):0)+
          ' cpu_advanced_ticks='+cpu.cpuTicksAdvanced+
          ' idle_seconds='+(compileActive?Math.floor((now-lastCpuProgressAt)/1000):0)+
          ' processes='+cpu.processes+' rss_mib='+cpu.rssMiB);
      }
    }catch(error){terminate('COMPILATION_PROCESS_MONITOR_FAILURE');log(String(error.message).slice(0,250));}
  },PHASE0_COMPILE_WATCHDOG_V1.pollMs);
  const sig=s=>terminate('SUPERVISOR_'+s,124);
  process.on('SIGTERM',()=>sig('TERM'));process.on('SIGINT',()=>sig('INT'));
  log('started mode='+mode+' compilation hard limit=1800s; CPU idle limit=480s');
  try{
    const result=await new Promise((resolve,reject)=>{
      child.once('close',(code,signal)=>resolve({code,signal}));
      child.once('error',reject);
    });
    finished=true;
    return exitCode||result.code|| (result.signal?1:0);
  }finally{finished=true;clearInterval(timer);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runCompileWatchdogV1().then(code=>{process.exitCode=code;}).catch(error=>{
    process.stderr.write('[phase0-compile-watchdog] FAILED '+String(error.message)+'\n');
    process.exitCode=1;
  });
}
