#!/usr/bin/env node
import path from 'node:path';
import {importCompletedPhase0StagesV1} from '../packages/github-native-sim/src/phase0-completed-stages-v1.mjs';
import {runPhase0RandomizedSimulationV1} from '../packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs';

function args(argv){
  const out={};
  for(let i=2;i<argv.length;i++){
    const k=argv[i];if(!k.startsWith('--'))continue;
    const v=argv[i+1];if(v===undefined||v.startsWith('--'))throw new Error('missing value for '+k);
    out[k.slice(2)]=v;i++;
  }
  return out;
}
const a=args(process.argv);
throw new Error('RETIRED_PHASE0_RANDOMIZED_CLI: use trusted Phase-0 forked deployment/config workflow. Unverified network-free state cannot be reported as historical proof.');
for(const k of ['controller-root','campaign-path','output'])if(!a[k])throw new Error('missing --'+k);
if(!a['completed-stages-manifest']&&!a['fork-url'])throw new Error('missing --fork-url');
const result=a['completed-stages-manifest'] ? await importCompletedPhase0StagesV1({controllerRoot:path.resolve(a['controller-root']),campaignPath:a['campaign-path'],manifestPath:a['completed-stages-manifest'],outputRoot:path.resolve(a.output),repository:process.env.GITHUB_REPOSITORY,githubToken:process.env.GH_TOKEN}) : await runPhase0RandomizedSimulationV1({
  controllerRoot:path.resolve(a['controller-root']),
  campaignPath:a['campaign-path'],
  outputRoot:path.resolve(a.output),
  forkUrl:a['fork-url'],
  medusaSmokeCalls:a['medusa-smoke-calls']?Number(a['medusa-smoke-calls']):null,
  telemetrySmokeCalls:a['telemetry-smoke-calls']?Number(a['telemetry-smoke-calls']):null
});
process.stdout.write(JSON.stringify({
  status:result.summary?.status??'UNKNOWN',
  medusaStatus:result.summary?.medusa?.status??null,
  medusaObservedCalls:result.summary?.medusa?.observedCalls??0,
  telemetryRuns:result.summary?.telemetry?.length??0,
  deploymentStatus:result.deployEvidence?.status??null,
  code:result.summary?.code??null,
  message:result.summary?.message??null,
  targetEvmChainIds:result.summary?.targetEvmChainIds??result.runIndex?.targetEvmChainIds??[]
},null,2)+'\n');
