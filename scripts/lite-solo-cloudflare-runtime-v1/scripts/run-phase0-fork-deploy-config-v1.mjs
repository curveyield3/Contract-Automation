import path from 'node:path';
import {runPhase0RandomizedSimulationV1} from '../packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs';
const a={};for(let i=2;i<process.argv.length;i++){if(process.argv[i].startsWith('--'))a[process.argv[i].slice(2)]=process.argv[++i];}
for(const k of ['controller-root','campaign-path','output','fork-url'])if(!a[k])throw new Error('missing --'+k);
const {deployEvidence}=await runPhase0RandomizedSimulationV1({controllerRoot:path.resolve(a['controller-root']),campaignPath:a['campaign-path'],outputRoot:path.resolve(a.output),forkUrl:a['fork-url'],forkUrls:{katana:process.env.KATANA_FORK_RPC_URL||undefined},deploymentOnly:true});
process.stdout.write(JSON.stringify({status:deployEvidence?.status??'BLOCKED',executionMode:deployEvidence?.executionMode??null,attempts:deployEvidence?.attempts?.length??0})+'\n');
// The full attempt output lives in the uploaded artifact; also surface the tail of each failed
// attempt in the job log so a failed deployment is diagnosable from the run page. Fork RPC
// secrets are never passed to package scripts, but redact them defensively anyway.
const secrets=[a['fork-url'],process.env.KATANA_FORK_RPC_URL].filter(x=>typeof x==='string'&&x.length>8);
const redact=text=>secrets.reduce((t,s)=>t.split(s).join('[REDACTED_RPC]'),String(text??''));
for(const gap of deployEvidence?.gaps??[]){process.stderr.write('::error::'+redact(gap.message??gap.type)+'\n');}
for(const attempt of deployEvidence?.attempts??[]){
  if(attempt.status==='PASS')continue;
  const tail=text=>redact(text).split('\n').slice(-150).join('\n');
  process.stderr.write(`::group::Failed deployment attempt ${attempt.framework}:${attempt.path} (exit ${attempt.exitCode})\n--- stdout (tail) ---\n${tail(attempt.stdout)}\n--- stderr (tail) ---\n${tail(attempt.stderr)}\n::endgroup::\n`);
}
