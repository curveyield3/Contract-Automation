import fs from 'node:fs/promises';
import path from 'node:path';
import {verifyPhase0ForkStateV1} from '../packages/github-native-sim/src/phase0-fork-state-reuse-v1.mjs';
import {renderDeployConfigMatrixV1,renderTargetedTestMatrixV1} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {detectionPolicyForAuthorityV1,authorityRootFromHomepageV1} from '../packages/github-native-sim/src/adr-policy-v1.mjs';
const a={};for(let i=2;i<process.argv.length;i++){if(process.argv[i].startsWith('--'))a[process.argv[i].slice(2)]=process.argv[++i];}
for(const k of ['controller-root','campaign-path','simulation-output'])if(!a[k])throw new Error('missing --'+k);
const campaignRoot=path.join(path.resolve(a['controller-root']),...a['campaign-path'].split('/'));
const src=path.resolve(a['simulation-output']);
const raw=await fs.readFile(path.join(src,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'),'utf8');
const deploy=JSON.parse(raw);
const {assertDeployGateEvidenceV2,digestV2}=await import('./lib/phase0-deploy-gate-v2.mjs');
assertDeployGateEvidenceV2(deploy);
const rawPath=path.join(src,'PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json');
if(deploy.reconciliation){
  const original=await fs.readFile(rawPath);
  if(digestV2(original)!==deploy.reconciliation.originalEvidenceSha256)throw new Error('Original deployment evidence digest mismatch');
}
if(deploy.schemaVersion!=='curveyield-lite-phase0-deploy-config-execution-v3'||!['PASS','PASS_LIVE_DEPLOYMENT','NOT_APPLICABLE_NO_DEPLOYMENT_SCRIPT'].includes(deploy.status))throw new Error('Deployment evidence does not satisfy Phase-0 deploy/config-only gate');
const destination=path.join(campaignRoot,'evidence/phase0');
await fs.mkdir(destination,{recursive:true});
await fs.writeFile(path.join(destination,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'),raw);
// An opt-in reused fork state is admitted only with exact source/campaign/chain
// and digest proof. Otherwise the historical deployment-only gate is unchanged.
if(deploy.reusableForkState?.status==='CAPTURED'){
  const manifestFile=path.join(src,'PHASE0_FORK_STATE_MANIFEST_v1.json');
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(manifest.campaignId!==deploy.campaignId||
    manifest.sourceSha256!==deploy.sourceSha256||
    manifest.chainId!==deploy.fork?.chainId||
    manifest.finalBlock!==deploy.fork?.finalBlock||
    manifest.sha256!==deploy.reusableForkState.sha256)
    throw new Error('Reusable fork-state identity differs from Phase-0 deployment proof');
  await verifyPhase0ForkStateV1({root:src,manifest});
  await fs.copyFile(manifestFile,path.join(destination,'PHASE0_FORK_STATE_MANIFEST_v1.json'));
  await fs.copyFile(path.join(src,manifest.stateFile),path.join(destination,manifest.stateFile));
}
try {
  const receipt=JSON.parse(await fs.readFile(path.join(campaignRoot,'receipts/PHASE_00_RECEIPT_v1.json'),'utf8'));
  const controllerRoot=path.resolve(a['controller-root']);
  const policy=await detectionPolicyForAuthorityV1({
    repoRoot:controllerRoot,
    authorityRoot:authorityRootFromHomepageV1(receipt.authority.homepagePath),
    readJsonIfExists:async(rel)=>{
      try {return JSON.parse(await fs.readFile(path.join(controllerRoot,...rel.split('/')),'utf8'));}
      catch(error){if(error?.code==='ENOENT')return null;throw error;}
    }
  });
  const snapshotFile=path.join(src,'DEPLOYED_STATE_SNAPSHOT_v1.json');
  if(policy&&await fs.stat(snapshotFile).then(()=>true,()=>false)) {
    const target=path.join(campaignRoot,'evidence/review-inventory');
    await fs.mkdir(target,{recursive:true});
    await fs.copyFile(snapshotFile,path.join(target,'DEPLOYED_STATE_SNAPSHOT_v1.json'));
  }
} catch { /* Snapshot must never block the existing Phase-0 deployment writer. */ }
if(deploy.reconciliation)await fs.copyFile(rawPath,path.join(destination,'PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json'));
const readiness=JSON.parse(await fs.readFile(path.join(campaignRoot,'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'),'utf8'));
const work=path.join(campaignRoot,'work/phase-06');await fs.mkdir(work,{recursive:true});
await fs.writeFile(path.join(work,'LITE_DEPLOY_CONFIG_MATRIX.md'),renderDeployConfigMatrixV1({readiness,execution:deploy}));
await fs.writeFile(path.join(work,'LITE_TARGETED_TEST_MATRIX.md'),renderTargetedTestMatrixV1({targetDesigns:[],executionResults:{},baselineRows:[]}));
for(const old of [
  'evidence/phase0/PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json',
  'evidence/phase0/PHASE0_TELEMETRY_ANALYSIS_v1.json',
  'evidence/phase0/PHASE0_TELEMETRY_ANALYSIS_v1.md',
  'evidence/phase0/simulations/PHASE0_SIMULATION_RUN_INDEX_v1.json',
  'derived/phase-0/PHASE5_SIMULATION_BASELINE_INPUT_v1.json',
  'derived/phase-0/PHASE6_SIMULATION_BASELINE_INPUT_v1.json'
])await fs.rm(path.join(campaignRoot,...old.split('/')),{force:true});
process.stdout.write(JSON.stringify({status:'PASS',deployment:'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',baselineSimulationRequired:false})+'\n');
