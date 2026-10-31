#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {renderTargetedTestMatrixV1} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';

function args(argv){const o={};for(let i=2;i<argv.length;i+=2){const k=argv[i],v=argv[i+1];if(!k?.startsWith('--')||v===undefined)throw new Error('arguments must be --key value');o[k.slice(2)]=v;}return o;}
async function readJson(f){return JSON.parse(await fs.readFile(f,'utf8'));}
async function writeJson(f,v){await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(v,null,2)+'\n');}
async function shaFile(f){return createHash('sha256').update(await fs.readFile(f)).digest('hex');}

const a=args(process.argv);
for(const k of ['controller-root','campaign-path','simulation-output','contract-automation-sha'])if(!a[k])throw new Error('missing --'+k);

const root=path.resolve(a['controller-root']);
const campaignPath=a['campaign-path'];
const campaignRoot=path.join(root,...campaignPath.split('/'));
const src=path.resolve(a['simulation-output']);
const summary=await readJson(path.join(src,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json'));
const runIndex=await readJson(path.join(src,'PHASE0_SIMULATION_RUN_INDEX_v1.json'));
const deploy=await readJson(path.join(src,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json')).catch(()=>null);
const receiptPath=path.join(campaignRoot,'receipts/PHASE_00_RECEIPT_v1.json');
const receipt=await readJson(receiptPath);

if(receipt.phase?.status!=='SEALED'||receipt.validation?.status!=='PASS')throw new Error('Phase-0 rebind requires an already sealed PASS receipt');
if(summary.campaignId!==receipt.campaign?.campaignId)throw new Error('simulation campaignId does not match sealed Phase-0 receipt');
if(runIndex.sourceIdentity?.sourceSha256!==receipt.source?.sha256)throw new Error('simulation source SHA does not match sealed Phase-0 source');

const rebindBaseRel='evidence/phase0/rebinds/randomized-simulation-v1';
const rebindBase=path.join(campaignRoot,...rebindBaseRel.split('/'));
const rebindSimRel=rebindBaseRel+'/simulations';
const rebindSim=path.join(campaignRoot,...rebindSimRel.split('/'));
await fs.rm(rebindBase,{recursive:true,force:true});
await fs.mkdir(rebindSim,{recursive:true});
await fs.copyFile(path.join(src,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json'),path.join(rebindBase,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json'));
await fs.copyFile(path.join(src,'PHASE0_SIMULATION_RUN_INDEX_v1.json'),path.join(rebindSim,'PHASE0_SIMULATION_RUN_INDEX_v1.json'));
if(deploy)await fs.copyFile(path.join(src,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'),path.join(rebindBase,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'));
await fs.cp(path.join(src,'runs'),path.join(rebindSim,'runs'),{recursive:true}).catch(()=>{});

const summaryRef=rebindBaseRel+'/PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json';
const runIndexRef=rebindSimRel+'/PHASE0_SIMULATION_RUN_INDEX_v1.json';
const deployRef=deploy?rebindBaseRel+'/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json':'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json';
const telemetry=summary.telemetry??[];
const observedAccountingShare=telemetry.length?Math.round(((telemetry[0]?.accountingActionShare??0)*1000))/10:null;
const baselineRows=[
  {
    targetId:'PHASE0-BASELINE-MEDUSA-REBIND',candidateKey:'PHASE0-BASELINE-MEDUSA-REBIND',
    candidateOrProperty:'Rebound broad randomized stateful ABI execution after Phase-0 runner repair',
    setup:'Canonical Ethereum Anvil execution baseline for the EVM package; target chain IDs retained as provenance metadata: '+JSON.stringify(summary.targetEvmChainIds??[]),
    transactionSequence:'Medusa internal randomized sequence; configured call limit '+String(summary.medusa?.configuredCallLimit??'UNRESOLVED')+'; observed '+String(summary.medusa?.observedCalls??0),
    expectedSecureOutcome:'INVESTIGATIVE_BASELINE_NO_PREDECIDED_SECURITY_CONCLUSION',
    oracle:'Mechanical completion, coverage/revert telemetry, later-reviewer investigation',
    requestBindingStatus:'PHASE0_CONTROLLER_REBIND_GENERATED',
    simulationResult:summary.medusa?.status??'UNRESOLVED',
    fuzzVariablesAndBounds:'ABI-valid generated arguments; no raw random calldata; canonical Ethereum Anvil execution normalization',
    result:summary.medusa?.status??'UNRESOLVED',
    evidenceRefs:[summary.medusa?.rawOutputRef?(rebindSimRel+'/'+summary.medusa.rawOutputRef):summaryRef,summaryRef]
  },
  {
    targetId:'PHASE0-BASELINE-ABI-TELEMETRY-REBIND',candidateKey:'PHASE0-BASELINE-ABI-TELEMETRY-REBIND',
    candidateOrProperty:'Rebound telemetry-rich randomized source-contract interaction baseline',
    setup:'Same canonical Ethereum Anvil execution baseline; independent stateful shards reset to the common baseline',
    transactionSequence:'Randomized cross-contract bursts that repeatedly revisit contracts rather than exhausting one contract at a time',
    expectedSecureOutcome:'INVESTIGATIVE_BASELINE_NO_PREDECIDED_SECURITY_CONCLUSION',
    oracle:'Per-call pre/post accounting state, deltas, receipts/logs, success/revert/error telemetry',
    requestBindingStatus:'PHASE0_CONTROLLER_REBIND_GENERATED',
    simulationResult:telemetry.length?(telemetry.every(x=>x.status==='PASS')?'PASS':'INCOMPLETE'):'NOT_EXECUTED',
    fuzzVariablesAndBounds:observedAccountingShare===null?'No telemetry run executed':'Real ABI functions only; observed accounting/state-changing share '+String(observedAccountingShare)+'%; configured policy 80%',
    result:telemetry.length?'INVESTIGATIVE_TELEMETRY_GENERATED':'NOT_EXECUTED',
    evidenceRefs:[runIndexRef,...telemetry.map(x=>rebindSimRel+'/'+x.rawTranscriptRef)]
  }
];

const phase5={schemaVersion:'curveyield-lite-phase0-phase5-simulation-baseline-input-v1',rebind:{kind:'TRUSTED_RUNNER_REPAIR',supersedes:'derived/phase-0/PHASE5_SIMULATION_BASELINE_INPUT_v1.json'},data:{automationInputs:{phase0BaselineSimulation:{
  purpose:'USE_REBOUND_PHASE0_RANDOMIZED_EVIDENCE_TO_DESIGN_HIGHER_VALUE_PHASE5_TARGETED_TESTS',
  summaryRef,runIndexRef,deployEvidenceRef:deployRef,
  targetEvmChainIds:summary.targetEvmChainIds??[],
  executionNormalization:summary.executionNormalization??null,
  medusa:{status:summary.medusa?.status??'UNRESOLVED',configuredCallLimit:summary.medusa?.configuredCallLimit??null,observedCalls:summary.medusa?.observedCalls??0,minimumRequiredCalls:summary.medusa?.minimumRequiredCalls??100001},
  telemetry:telemetry.map(x=>({runId:x.runId,calls:x.calls,accountingActionShare:x.accountingActionShare,accountingFunctionCount:x.accountingFunctionCount,otherFunctionCount:x.otherFunctionCount,weightingLimitation:x.weightingLimitation,successes:x.successes,reverts:x.reverts,errors:x.errors,rawTranscriptRef:rebindSimRel+'/'+x.rawTranscriptRef,burstSchedule:x.burstSchedule})),
  limitations:summary.limitations??[],
  reviewerUse:'Investigate patterns/anomalies and use them to design Phase-5 candidate-specific simulations. This replacement evidence supersedes only the prior skipped randomized-simulation baseline; all other sealed Phase-0 evidence remains valid.'
}}}};

const phase6Rows=(summary.baselineTargetDispositions??[]).map(r=>({
  ...r,
  candidateKey:String(r.candidateKey??'PHASE0-BASELINE')+'-REBIND',
  executionEvidenceRefs:(r.executionEvidenceRefs??[]).map(ref=>ref==='NO_MEDUSA_OUTPUT'||ref==='NO_CONFIG'?ref:(ref.startsWith('evidence/')?ref:rebindSimRel+'/'+ref)),
  requestBindingEvidenceRef:(()=>{const ref=r.requestBindingEvidenceRef??'NO_BINDING_EVIDENCE';return ref==='NO_CONFIG'||ref==='NO_BINDING_EVIDENCE'?ref:(ref.startsWith('evidence/')?ref:rebindSimRel+'/'+ref);})(),
  semanticHarnessBindingAssessment:'<REQUIRED>',
  securityInterpretation:'<REQUIRED>',
  limitations:'<REQUIRED>',
  recommendedPhase8Disposition:'<REQUIRED>',
  automationOwnedFields:['candidateKey','executionEvidenceRefs','oracleOutcome','reproductionStatus','requestBindingStatus','requestBindingEvidenceRef']
}));
const phase6={schemaVersion:'curveyield-lite-phase0-phase6-simulation-baseline-input-v1',rebind:{kind:'TRUSTED_RUNNER_REPAIR',supersedes:'derived/phase-0/PHASE6_SIMULATION_BASELINE_INPUT_v1.json'},data:{automationInputs:{
  phase0BaselineTargetDispositions:phase6Rows,
  phase0SimulationLimitations:summary.limitations??[],
  phase0SimulationRunIndexRef:runIndexRef
}},baselineMatrixRows:baselineRows};

const derivedDir=path.join(campaignRoot,'derived/phase-0-rebind');
await writeJson(path.join(derivedDir,'PHASE5_SIMULATION_BASELINE_INPUT_v1.json'),phase5);
await writeJson(path.join(derivedDir,'PHASE6_SIMULATION_BASELINE_INPUT_v1.json'),phase6);

const supplementalMatrixRel='work/phase-06/LITE_TARGETED_TEST_MATRIX_PHASE0_REBIND_v1.md';
await fs.writeFile(path.join(campaignRoot,...supplementalMatrixRel.split('/')),renderTargetedTestMatrixV1({baselineRows}));

const oldSummary='evidence/phase0/PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json';
const oldRunIndex='evidence/phase0/simulations/PHASE0_SIMULATION_RUN_INDEX_v1.json';
const rebindReceipt={
  schemaVersion:'curveyield-phase0-simulation-rebind-v1',
  campaignId:receipt.campaign.campaignId,
  campaignGenerationId:receipt.campaign.campaignGenerationId,
  sourceSha256:receipt.source.sha256,
  reason:'TRUSTED_RUNNER_OR_TOOLCHAIN_CHANGED',
  repair:'REMOVE_NON_ETHEREUM_EVM_CHAIN_GATE_AND_EXECUTE_CANONICAL_ETHEREUM_ANVIL_BASELINE',
  preservesSealedPhase0Receipt:true,
  sealedPhase0ReceiptPath:'receipts/PHASE_00_RECEIPT_v1.json',
  sealedPhase0ReceiptSha256:await shaFile(receiptPath),
  contractAutomationCommit:a['contract-automation-sha'],
  targetEvmChainIds:summary.targetEvmChainIds??[],
  executionNormalization:summary.executionNormalization??null,
  historicalEvidence:[oldSummary,oldRunIndex,'derived/phase-0/PHASE5_SIMULATION_BASELINE_INPUT_v1.json','derived/phase-0/PHASE6_SIMULATION_BASELINE_INPUT_v1.json'],
  replacementEvidence:[summaryRef,runIndexRef,'derived/phase-0-rebind/PHASE5_SIMULATION_BASELINE_INPUT_v1.json','derived/phase-0-rebind/PHASE6_SIMULATION_BASELINE_INPUT_v1.json',supplementalMatrixRel],
  validation:{
    medusaStatus:summary.medusa?.status??null,
    medusaObservedCalls:summary.medusa?.observedCalls??0,
    telemetryRuns:telemetry.length,
    realAbiCallsOnly:runIndex.policy?.realAbiCallsOnly===true,
    crossContractBursts:runIndex.policy?.crossContractBursts===true,
    accountingActionWeight:runIndex.policy?.accountingActionWeight??null
  },
  createdAt:new Date().toISOString()
};
await writeJson(path.join(campaignRoot,'controller/PHASE0_SIMULATION_REBIND_v1.json'),rebindReceipt);

process.stdout.write(JSON.stringify({status:'PASS',summaryRef,runIndexRef,phase5Input:'derived/phase-0-rebind/PHASE5_SIMULATION_BASELINE_INPUT_v1.json',phase6Input:'derived/phase-0-rebind/PHASE6_SIMULATION_BASELINE_INPUT_v1.json',supplementalMatrixRel},null,2)+'\n');
