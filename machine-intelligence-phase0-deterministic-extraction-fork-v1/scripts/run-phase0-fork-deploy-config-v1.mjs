import path from 'node:path';
import {runPhase0RandomizedSimulationV1} from '../packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs';
const a={};for(let i=2;i<process.argv.length;i++){if(process.argv[i].startsWith('--'))a[process.argv[i].slice(2)]=process.argv[++i];}
for(const k of ['source-checkout-root','source-receipt','static-evidence-root','fork-run-root','output','fork-url'])
  if(!a[k])throw new Error('missing --'+k);
if(a['campaign-path'])throw new Error('FORK_RUNNER_CAMPAIGN_MUTATION_PATH_PROHIBITED');
const forkRunRoot=path.resolve(a['fork-run-root']);
if(path.resolve(a['source-receipt'])!==path.join(forkRunRoot,'inputs','READ_ONLY_INPUT_RECEIPT_COPY.json'))
  throw new Error('FORK_RUNNER_RECEIPT_COPY_PATH_INVALID');
const {deployEvidence}=await runPhase0RandomizedSimulationV1({
  sourceCheckoutRoot:path.resolve(a['source-checkout-root']),
  sourceReceiptPath:path.resolve(a['source-receipt']),
  staticEvidenceRoot:path.resolve(a['static-evidence-root']),
  outputRoot:path.resolve(a.output),forkUrl:a['fork-url'],
  forkUrls:{katana:process.env.KATANA_FORK_RPC_URL||undefined},deploymentOnly:true});
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
