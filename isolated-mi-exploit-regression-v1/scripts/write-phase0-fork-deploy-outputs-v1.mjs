import fs from 'node:fs/promises';
import path from 'node:path';
import {recordPhaseFinalizationVerificationWarningV1} from './lib/lite-solo-phase-work-v1.mjs';
import {verifyPhase0ForkStateV1} from '../packages/github-native-sim/src/phase0-fork-state-reuse-v1.mjs';
import {renderDeployConfigMatrixV1,renderTargetedTestMatrixV1} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {detectionPolicyForAuthorityV1,authorityRootFromHomepageV1} from '../packages/github-native-sim/src/adr-policy-v1.mjs';
const a={};for(let i=2;i<process.argv.length;i++){if(process.argv[i].startsWith('--'))a[process.argv[i].slice(2)]=process.argv[++i];}
for(const k of ['controller-root','campaign-path','simulation-output'])if(!a[k])throw new Error('missing --'+k);
const controllerRoot=path.resolve(a['controller-root']);
const campaignPath=a['campaign-path'];
const campaignRoot=path.join(controllerRoot,...campaignPath.split('/'));
const src=path.resolve(a['simulation-output']);
const destination=path.join(campaignRoot,'evidence/phase0');
const warn=(name,check,reason,expected=null,observed=null)=>{
 const affectedFile=path.posix.join(campaignPath,'evidence/phase0',name);
 recordPhaseFinalizationVerificationWarningV1({root:controllerRoot,campaignPath,
  phase:0,affectedFile,check,reason,expected,observed});
 console.warn('NONBLOCKING_PHASE0_VERIFICATION_WARNING: '+check+': '+reason);
};
let raw,deploy;
try{
 raw=await fs.readFile(path.join(src,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'),'utf8');
 deploy=JSON.parse(raw);
}catch(error){
 warn('PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','PHASE0_DEPLOY_EVIDENCE_UNAVAILABLE',
  'No readable deployment/configuration evidence file was produced: '+String(error?.message??error),
  'Original Phase-0 deployment/configuration JSON exists and parses',String(error?.code??'PARSE_FAILED'));
 process.stdout.write(JSON.stringify({status:'WARNING_SOURCE_EVIDENCE_UNAVAILABLE',
  deployment:'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',
  warningIssued:true})+'\n');
 process.exit(0);
}
const {assertDeployGateEvidenceV2,digestV2}=await import('./lib/phase0-deploy-gate-v2.mjs');
try{assertDeployGateEvidenceV2(deploy);}catch(error){warn('PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','PHASE0_DEPLOY_GATE_EVIDENCE_ASSESSMENT','Original deployment/configuration evidence verification failed: '+String(error?.message??error),'Verified deployment/configuration evidence',String(error?.message??error));}
const rawPath=path.join(src,'PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json');
let rawDeploymentEvidencePresent=false;
if(deploy.reconciliation){
 try{
  const original=await fs.readFile(rawPath);
  rawDeploymentEvidencePresent=true;
  if(digestV2(original)!==deploy.reconciliation.originalEvidenceSha256)
   warn('PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json','PHASE0_ORIGINAL_DEPLOY_EVIDENCE_SHA256',
    'Original deployment evidence bytes do not match the declared digest; exact bytes remain available',
    deploy.reconciliation.originalEvidenceSha256,digestV2(original));
 }catch(error){
  warn('PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json','PHASE0_ORIGINAL_DEPLOY_EVIDENCE_MISSING',
   'Original deployment evidence file cannot be read: '+String(error?.message??error),
   'Readable original deployment evidence file','MISSING_OR_UNREADABLE');
 }
}
if(deploy.schemaVersion!=='curveyield-lite-phase0-deploy-config-execution-v3'||!['PASS','PASS_LIVE_DEPLOYMENT','NOT_APPLICABLE_NO_DEPLOYMENT_SCRIPT'].includes(deploy.status))
 warn('PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','PHASE0_DEPLOY_EVIDENCE_SCHEMA_OR_STATUS','Deployment evidence does not match the expected schema and accepted status',{schemaVersion:'curveyield-lite-phase0-deploy-config-execution-v3',status:['PASS','PASS_LIVE_DEPLOYMENT','NOT_APPLICABLE_NO_DEPLOYMENT_SCRIPT']},{schemaVersion:deploy.schemaVersion??null,status:deploy.status??null});
await fs.mkdir(destination,{recursive:true});
await fs.writeFile(path.join(destination,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'),raw);
// An opt-in reused fork state is admitted only with exact source/campaign/chain
// and digest proof. Otherwise the historical deployment-only gate is unchanged.
if(deploy.reusableForkState?.status==='CAPTURED'){
  try{
  const manifestFile=path.join(src,'PHASE0_FORK_STATE_MANIFEST_v1.json');
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(manifest.campaignId!==deploy.campaignId||
    manifest.sourceSha256!==deploy.sourceSha256||
    manifest.chainId!==deploy.fork?.chainId||
    manifest.finalBlock!==deploy.fork?.finalBlock||
    manifest.sha256!==deploy.reusableForkState.sha256)
    throw new Error('Fork-state identity is untrusted; skip reuse');
  await verifyPhase0ForkStateV1({root:src,manifest});
  await fs.copyFile(manifestFile,path.join(destination,'PHASE0_FORK_STATE_MANIFEST_v1.json'));
  await fs.copyFile(path.join(src,manifest.stateFile),path.join(destination,manifest.stateFile));
  }catch(error){
   warn('PHASE0_FORK_STATE_MANIFEST_v1.json','PHASE0_REUSABLE_FORK_STATE_VERIFICATION','Reusable fork-state identity or evidence verification failed: '+String(error?.message??error),'Exact campaign/source/chain-bound reusable fork state',String(error?.message??error));
   try{await fs.copyFile(path.join(src,'PHASE0_FORK_STATE_MANIFEST_v1.json'),path.join(destination,'PHASE0_FORK_STATE_MANIFEST_v1.json'));}catch{}
  }
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
if(deploy.reconciliation&&rawDeploymentEvidencePresent)
 await fs.copyFile(rawPath,path.join(destination,'PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json'));
let readiness=null;
try{readiness=JSON.parse(await fs.readFile(path.join(campaignRoot,'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'),'utf8'));}catch(error){
 recordPhaseFinalizationVerificationWarningV1({root:controllerRoot,campaignPath,phase:0,
  affectedFile:path.posix.join(campaignPath,'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'),
  check:'PHASE0_READINESS_EVIDENCE_UNAVAILABLE',
  reason:'Cannot construct a source-grounded deployment matrix from missing or unreadable readiness evidence: '+String(error?.message??error),
  expected:'Readable project readiness evidence',observed:String(error?.code??'PARSE_FAILED')});
}
const work=path.join(campaignRoot,'work/phase-06');await fs.mkdir(work,{recursive:true});
if(readiness)await fs.writeFile(path.join(work,'LITE_DEPLOY_CONFIG_MATRIX.md'),renderDeployConfigMatrixV1({readiness,execution:deploy}));
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
