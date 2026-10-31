#!/usr/bin/env node
// Post-run, read-only analysis of Phase-0 ABI telemetry; survives partial/failed simulations.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root=path.resolve(process.argv[2]??'.phase0-randomized-output');
const reportFile=path.join(root,'PHASE0_TELEMETRY_ANALYSIS_v1.json');
const markdownFile=path.join(root,'PHASE0_TELEMETRY_ANALYSIS_v1.md');
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const safe=value=>String(value??'UNKNOWN').replace(/https?:\/\/[^\s]+/gi,'[URL]').replace(/[|\r\n]/g,' ').slice(0,160);
const increment=(object,key)=>{object[key]=(object[key]??0)+1;};
const top=(object,limit=10)=>Object.entries(object).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([name,count])=>({name,count}));
await fs.mkdir(root,{recursive:true});
const parent=await readJson(path.join(root,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json')).catch(()=>null);
const runsRoot=path.join(root,'runs');
const entries=await fs.readdir(runsRoot,{withFileTypes:true}).catch(()=>[]);
const runIds=entries.filter(e=>e.isDirectory()&&e.name.startsWith('abi-telemetry-')).map(e=>e.name).sort();
const report={schemaVersion:'curveyield-phase0-telemetry-analysis-v1',phase0Status:parent?.status??'NO_FINAL_SUMMARY',expectedShards:4,shards:[],totals:{rawCalls:0,minedSuccess:0,minedRevert:0,simulatedRejection:0,infrastructureErrors:0,positiveTransitions:0,observationFailures:0,accountingActions:0,malformedLines:0},outcomes:{},topFunctions:[],topReverts:[],findings:[]};
const fnCounts={};
const revertCounts={};
for(const runId of runIds){
  const dir=path.join(runsRoot,runId);
  const metadata=await readJson(path.join(dir,'RUN_SUMMARY_v1.json')).catch(()=>null);
  const shard={runId,summaryStatus:metadata?.status??'NO_RUN_SUMMARY',declaredCalls:metadata?.calls??null,rawCalls:0,outcomes:{},positiveTransitions:0,accountingActions:0,observationFailures:metadata?.observationFailures??null,reachabilityStatus:metadata?.reachabilityStatus??'UNKNOWN',malformedLines:0,missingRaw:false};
  const raw=path.join(dir,'RAW_SIMULATION_TRANSCRIPT_v1.jsonl');
  try{
    await fs.access(raw);
    const lines=readline.createInterface({input:createReadStream(raw,{encoding:'utf8'}),crlfDelay:Infinity});
    for await(const line of lines){
      if(!line.trim())continue;
      let row;
      try{row=JSON.parse(line);}catch{shard.malformedLines++;continue;}
      shard.rawCalls++;
      const outcome=safe(row.executionOutcome??'UNKNOWN_OUTCOME');
      increment(shard.outcomes,outcome);
      increment(report.outcomes,outcome);
      if(row.positiveTransition===true)shard.positiveTransitions++;
      if(row.semanticFamily==='ECONOMIC')shard.accountingActions++;
      increment(fnCounts,safe((row.target?.qualifiedName??'UNKNOWN')+'::'+(row.functionSignature??'UNKNOWN')));
    }
  }catch(error){if(error?.code==='ENOENT'){shard.missingRaw=true;}else throw error;}
  report.totals.rawCalls+=shard.rawCalls;
  report.totals.positiveTransitions+=shard.positiveTransitions;
  report.totals.accountingActions+=shard.accountingActions;
  report.totals.malformedLines+=shard.malformedLines;
  report.totals.observationFailures+=Number(metadata?.observationFailures??0);
  if(shard.declaredCalls!==null&&shard.rawCalls!==shard.declaredCalls)report.findings.push({code:'RAW_CALL_COUNT_MISMATCH',shard:runId,declared:shard.declaredCalls,observed:shard.rawCalls});
  if(shard.missingRaw)report.findings.push({code:'MISSING_RAW_TRANSCRIPT',shard:runId});
  if(shard.malformedLines>0)report.findings.push({code:'MALFORMED_JSONL',shard:runId,count:shard.malformedLines});
  if(metadata?.reconciliation?.status&&metadata.reconciliation.status!=='PASS')report.findings.push({code:'COUNTER_RECONCILIATION_FAILURE',shard:runId});
  if(metadata?.resetEvidence?.sentinelMatch===false)report.findings.push({code:'BASELINE_RESET_MISMATCH',shard:runId});
  if(metadata?.status&&metadata.status!=='PASS')report.findings.push({code:'INCOMPLETE_SHARD',shard:runId,status:metadata.status});
  for(const reason of metadata?.decodedRevertReasons??[]){
    const key=safe((reason.kind??'UNKNOWN')+' / '+(reason.reason??reason.selector??'UNKNOWN'));
    revertCounts[key]=(revertCounts[key]??0)+Number(reason.count??0);
  }
  report.shards.push(shard);
}
report.totals.minedSuccess=report.outcomes.MINED_SUCCESS??0;
report.totals.minedRevert=report.outcomes.MINED_REVERT??0;
report.totals.simulatedRejection=report.outcomes.SIMULATED_REJECTION??0;
report.totals.infrastructureErrors=(report.outcomes.SIMULATION_INFRASTRUCTURE_ERROR??0)+(report.outcomes.SUBMISSION_INFRASTRUCTURE_ERROR??0)+(report.outcomes.SUBMITTED_OUTCOME_UNKNOWN??0);
report.topFunctions=top(fnCounts);
report.topReverts=top(revertCounts);
if(report.shards.length<report.expectedShards)report.findings.push({code:'MISSING_OR_UNSTARTED_SHARDS',expected:report.expectedShards,observed:report.shards.length});
if(report.totals.rawCalls===0)report.findings.push({code:'NO_RAW_ABI_TELEMETRY_YET'});
else{
  if(report.totals.minedSuccess===0)report.findings.push({code:'ZERO_MINED_SUCCESSFUL_ACTIONS'});
  if(report.totals.positiveTransitions===0)report.findings.push({code:'ZERO_OBSERVED_STATE_TRANSITIONS'});
  if(report.totals.infrastructureErrors>0)report.findings.push({code:'INFRASTRUCTURE_OR_UNKNOWN_SUBMISSION_OUTCOMES',count:report.totals.infrastructureErrors});
  if(report.totals.observationFailures>0)report.findings.push({code:'ACCOUNTING_OBSERVATION_FAILURES',count:report.totals.observationFailures});
}
const lines=[
  '## Phase-0 ABI telemetry analysis v1','',
  '- Phase-0 summary: '+safe(report.phase0Status),
  '- Completed/started ABI shards: '+report.shards.length+'/'+report.expectedShards,
  '- Raw calls: '+report.totals.rawCalls+'; mined successes: '+report.totals.minedSuccess+'; mined reverts: '+report.totals.minedRevert+'; simulated rejections: '+report.totals.simulatedRejection,
  '- Positive state transitions: '+report.totals.positiveTransitions+'; accounting actions: '+report.totals.accountingActions+'; infrastructure/unknown outcomes: '+report.totals.infrastructureErrors+'; observation failures: '+report.totals.observationFailures,
  '',
  '| Shard | Raw / declared calls | Mined success | Simulated rejection | Positive transitions | Reconciliation |',
  '|---|---:|---:|---:|---:|---|',
  ...report.shards.map(s=>'| '+safe(s.runId)+' | '+s.rawCalls+' / '+(s.declaredCalls??'?')+' | '+(s.outcomes.MINED_SUCCESS??0)+' | '+(s.outcomes.SIMULATED_REJECTION??0)+' | '+s.positiveTransitions+' | '+safe(s.summaryStatus)+' |'),
  '',
  '### Top decoded revert reasons','',
  ...(report.topReverts.length?report.topReverts.map(r=>'- '+safe(r.name)+': '+r.count):['- Not available (no completed shard summaries)']),
  '',
  '### Findings / gaps','',
  ...(report.findings.length?report.findings.map(f=>'- '+safe(f.code)+(f.shard?' ('+safe(f.shard)+')':'')+(f.count!==undefined?': '+f.count:'')):['- None detected in retained evidence']),
  '',
  'Evidence: PHASE0_TELEMETRY_ANALYSIS_v1.json, per-shard RUN_SUMMARY_v1.json, and RAW_SIMULATION_TRANSCRIPT_v1.jsonl.'
];
await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
await fs.writeFile(markdownFile,lines.join('\n')+'\n');
if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,lines.join('\n')+'\n');
console.log('[phase0-telemetry-analysis] shards='+report.shards.length+' calls='+report.totals.rawCalls+' findings='+report.findings.length);
for(const f of report.findings)console.log('[phase0-telemetry-analysis] '+safe(f.code)+(f.shard?' shard='+safe(f.shard):''));
