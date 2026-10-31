#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {renderDeployConfigMatrixV1,renderTargetedTestMatrixV1} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';

function args(argv){const o={};for(let i=2;i<argv.length;i+=2){const k=argv[i],v=argv[i+1];if(!k?.startsWith('--')||v===undefined)throw new Error('arguments must be --key value');o[k.slice(2)]=v;}return o;}
async function readJson(f){return JSON.parse(await fs.readFile(f,'utf8'));}
async function writeJson(f,v){await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(v,null,2)+'\n');}
const a=args(process.argv);
for(const k of ['controller-root','campaign-path','simulation-output'])if(!a[k])throw new Error('missing --'+k);
const root=path.resolve(a['controller-root']),campaignPath=a['campaign-path'],campaignRoot=path.join(root,...campaignPath.split('/')),src=path.resolve(a['simulation-output']);
const summary=await readJson(path.join(src,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json'));
const runIndex=await readJson(path.join(src,'PHASE0_SIMULATION_RUN_INDEX_v1.json'));
const deployPath=path.join(src,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json');
const deploy=await readJson(deployPath).catch(()=>({schemaVersion:'curveyield-lite-phase0-deploy-config-execution-v2',status:'BLOCKED',gaps:[{type:'NO_DEPLOYMENT_EVIDENCE'}],attempts:[],deployedContracts:[]}));

const phase0Evidence=path.join(campaignRoot,'evidence/phase0');
const simEvidence=path.join(phase0Evidence,'simulations');
await fs.mkdir(simEvidence,{recursive:true});
await fs.copyFile(path.join(src,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json'),path.join(phase0Evidence,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json'));
await fs.copyFile(path.join(src,'PHASE0_SIMULATION_RUN_INDEX_v1.json'),path.join(simEvidence,'PHASE0_SIMULATION_RUN_INDEX_v1.json'));
// Retain the workflow-level telemetry analysis alongside the raw ABI evidence for subsequent reviewers.
for(const name of ['PHASE0_TELEMETRY_ANALYSIS_v1.json','PHASE0_TELEMETRY_ANALYSIS_v1.md']){
  await fs.copyFile(path.join(src,name),path.join(simEvidence,name));
}
const campaignDeployPath=path.join(phase0Evidence,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json');
try{
  await fs.copyFile(deployPath,campaignDeployPath);
}catch{
  await writeJson(campaignDeployPath,deploy);
}
await fs.rm(path.join(simEvidence,'runs'),{recursive:true,force:true});
await fs.cp(path.join(src,'runs'),path.join(simEvidence,'runs'),{recursive:true}).catch(()=>{});
if(summary.executionMode==='REUSED_COMPLETED_STAGES'){
  await fs.rm(path.join(simEvidence,'retained-attempts'),{recursive:true,force:true});
  await fs.cp(path.join(src,'retained-attempts'),path.join(simEvidence,'retained-attempts'),{recursive:true});
}

const summaryRef='evidence/phase0/PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json';
const runIndexRef='evidence/phase0/simulations/PHASE0_SIMULATION_RUN_INDEX_v1.json';
const deployRef='evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json';
const telemetryRows=summary.telemetry??[];
const observedAccountingShare=telemetryRows.length?Math.round(((telemetryRows[0]?.accountingActionShare??0)*1000))/10:null;
const baselineRows=[
  {
    targetId:'PHASE0-BASELINE-MEDUSA',candidateKey:'PHASE0-BASELINE-MEDUSA',
    candidateOrProperty:'Broad randomized stateful ABI execution from the deployment-prepared Anvil state',
    setup:'Canonical Ethereum Anvil execution baseline after supported source deployment-script simulation and deterministic fallback deployment; original target EVM chain IDs remain provenance metadata',
    transactionSequence:'Medusa internal randomized sequence; configured call limit '+String(summary.medusa?.configuredCallLimit??'UNRESOLVED')+'; observed '+String(summary.medusa?.observedCalls??0),
    expectedSecureOutcome:'INVESTIGATIVE_BASELINE_NO_PREDECIDED_SECURITY_CONCLUSION',
    oracle:'Separate execution volume, property applicability/results, reachability, observation quality, and typed oracle gaps; later-reviewer interpretation',
    requestBindingStatus:'PHASE0_CONTROLLER_GENERATED',simulationResult:summary.medusa?.status??'UNRESOLVED',
    fuzzVariablesAndBounds:'ABI-valid generated arguments; underlying source-contract calls routed through generated Medusa ABI wrappers; no raw random calldata',
    result:summary.medusa?.status??'UNRESOLVED',
    executionStatus:summary.medusa?.executionStatus??'UNKNOWN',checkStatus:summary.medusa?.checkStatus??'UNKNOWN',reachabilityStatus:summary.medusa?.reachabilityStatus??'UNKNOWN',observationStatus:summary.medusa?.observationStatus??'UNKNOWN',mode:summary.medusa?.mode??'UNKNOWN',propertyRegistry:summary.medusa?.propertyRegistry??[],
    evidenceRefs:[summary.medusa?.rawOutputRef?('evidence/phase0/simulations/'+summary.medusa.rawOutputRef):summaryRef,summaryRef]
  },
  {
    targetId:'PHASE0-BASELINE-ABI-TELEMETRY',candidateKey:'PHASE0-BASELINE-ABI-TELEMETRY',
    candidateOrProperty:'Telemetry-rich randomized source-contract interaction baseline',
    setup:summary.executionMode==='REUSED_COMPLETED_STAGES'?'Separate retained Ethereum Anvil telemetry attempt; shards reset to that attempt baseline. Medusa keeps its own original fork and deployment addresses.':'Same canonical Ethereum Anvil execution baseline; independent stateful shards reset to the common baseline',
    transactionSequence:'Randomized cross-contract bursts that repeatedly revisit contracts rather than exhausting one contract at a time',
    expectedSecureOutcome:'INVESTIGATIVE_BASELINE_NO_PREDECIDED_SECURITY_CONCLUSION',
    oracle:'Per-call ARG_GEN/PREFLIGHT/SUBMISSION/RECEIPT/OBSERVATION lifecycle, typed terminal outcomes, comparable deltas, receipts/logs, and reachability witnesses',
    requestBindingStatus:'PHASE0_CONTROLLER_GENERATED',
    simulationResult:telemetryRows.length?(telemetryRows.every(x=>x.status==='PASS')?'PASS':'INCOMPLETE'):'NOT_EXECUTED',
    fuzzVariablesAndBounds:observedAccountingShare===null?'No telemetry run executed':'Real ABI functions only; observed accounting/state-changing share '+String(observedAccountingShare)+'%; configured policy 80%',
    result:telemetryRows.length?'INVESTIGATIVE_TELEMETRY_GENERATED':'NOT_EXECUTED',
    executionStatus:telemetryRows.length?'COMPLETED':'NOT_EXECUTED',checkStatus:'NOT_APPLICABLE',reachabilityStatus:telemetryRows.some(x=>x.reachabilityStatus==='REACHABLE')?'REACHABLE':'REACHABILITY_GAP',observationStatus:telemetryRows.every(x=>x.observationStatus==='COMPLETE')?'COMPLETE':(telemetryRows.some(x=>x.observationStatus==='PARTIAL')?'PARTIAL':'UNAVAILABLE'),
    evidenceRefs:[runIndexRef,...telemetryRows.map(x=>'evidence/phase0/simulations/'+x.rawTranscriptRef)]
  }
];

const phase5={schemaVersion:'curveyield-lite-phase0-phase5-simulation-baseline-input-v1',data:{automationInputs:{phase0BaselineSimulation:{
  purpose:'USE_PHASE0_RANDOMIZED_EVIDENCE_TO_DESIGN_HIGHER_VALUE_PHASE5_TARGETED_TESTS',summaryRef,runIndexRef,deployEvidenceRef:deployRef,
  medusa:{status:summary.medusa?.status??'UNRESOLVED',mode:summary.medusa?.mode??null,executionStatus:summary.medusa?.executionStatus??null,coverageStatus:summary.medusa?.coverageStatus??null,checkStatus:summary.medusa?.checkStatus??null,reachabilityStatus:summary.medusa?.reachabilityStatus??null,observationStatus:summary.medusa?.observationStatus??null,configuredCallLimit:summary.medusa?.configuredCallLimit??null,observedCalls:summary.medusa?.observedCalls??0,minimumRequiredCalls:summary.medusa?.minimumRequiredCalls??100001,callerSemantics:summary.medusa?.callerSemantics??null,propertyRegistry:summary.medusa?.propertyRegistry??[],achievedDispatchWeight:summary.medusa?.achievedDispatchWeight??null,variety:summary.medusa?.variety??null,achievedWeightBasis:summary.medusa?.achievedWeightBasis??null,corpusIndexRef:summary.medusa?.corpusIndexRef?('evidence/phase0/simulations/'+summary.medusa.corpusIndexRef):null},
  telemetry:(summary.telemetry??[]).map(x=>({runId:x.runId,calls:x.calls,plannedActions:x.plannedActions,terminalActions:x.terminalActions,submittedActions:x.submittedActions,accountingActionShare:x.accountingActionShare,accountingFunctionCount:x.accountingFunctionCount,otherFunctionCount:x.otherFunctionCount,weightingLimitation:x.weightingLimitation,minedSuccess:x.minedSuccess,minedRevert:x.minedRevert,simulatedRejection:x.simulatedRejection,simulationInfrastructureError:x.simulationInfrastructureError,submissionInfrastructureError:x.submissionInfrastructureError,submittedOutcomeUnknown:x.submittedOutcomeUnknown,notExecutedEncodingOrPlanning:x.notExecutedEncodingOrPlanning,positiveTransitions:x.positiveTransitions,positiveEconomicTransitions:x.positiveEconomicTransitions,lifecycleFamilies:x.lifecycleFamilies??[],executionStatus:x.executionStatus,coverageStatus:x.coverageStatus,reachabilityStatus:x.reachabilityStatus,observationStatus:x.observationStatus,feedbackStatus:x.feedbackStatus,feedbackUpdates:x.feedbackUpdates,feedbackSelections:x.feedbackSelections,contextAdaptations:x.contextAdaptations??[],resetEvidence:x.resetEvidence??null,actionSequenceDigestSha256:x.actionSequenceDigestSha256??null,outcomeSequenceDigestSha256:x.outcomeSequenceDigestSha256??null,reconciliation:x.reconciliation??null,rawTranscriptRef:'evidence/phase0/simulations/'+x.rawTranscriptRef,rawTranscriptSha256:x.rawTranscriptSha256??null,rawTranscriptBytes:x.rawTranscriptBytes??null,burstSchedule:x.burstSchedule})),
  limitations:summary.limitations??[],
  reviewerUse:'Investigate patterns/anomalies and use them to design Phase-5 candidate-specific simulations. Raw transcripts are investigative telemetry, not a manual reverification obligation.'
}}}};
const phase6Rows=(summary.baselineTargetDispositions??[]).map(r=>({...r,
  executionEvidenceRefs:(r.executionEvidenceRefs??[]).map(ref=>ref==='NO_MEDUSA_OUTPUT'||ref==='NO_CONFIG'?ref:(ref.startsWith('evidence/')?ref:'evidence/phase0/simulations/'+ref)),
  requestBindingEvidenceRef:(()=>{const ref=r.requestBindingEvidenceRef??'NO_BINDING_EVIDENCE';return ref==='NO_CONFIG'||ref==='NO_BINDING_EVIDENCE'||ref.startsWith('evidence/')?ref:'evidence/phase0/simulations/'+ref;})(),
  semanticHarnessBindingAssessment:'<REQUIRED>',
  securityInterpretation:'<REQUIRED>',
  limitations:'<REQUIRED>',
  recommendedPhase8Disposition:'<REQUIRED>',
  automationOwnedFields:['candidateKey','executionEvidenceRefs','oracleOutcome','reproductionStatus','requestBindingStatus','requestBindingEvidenceRef']
}));
const phase6={schemaVersion:'curveyield-lite-phase0-phase6-simulation-baseline-input-v1',data:{automationInputs:{phase0BaselineTargetDispositions:phase6Rows,phase0SimulationLimitations:summary.limitations??[],phase0SimulationRunIndexRef:runIndexRef}},baselineMatrixRows:baselineRows};
await writeJson(path.join(campaignRoot,'derived/phase-0/PHASE5_SIMULATION_BASELINE_INPUT_v1.json'),phase5);
await writeJson(path.join(campaignRoot,'derived/phase-0/PHASE6_SIMULATION_BASELINE_INPUT_v1.json'),phase6);

const readiness=await readJson(path.join(campaignRoot,'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'));
await fs.mkdir(path.join(campaignRoot,'work/phase-06'),{recursive:true});
await fs.writeFile(path.join(campaignRoot,'work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md'),renderDeployConfigMatrixV1({readiness,execution:deploy}));
await fs.writeFile(path.join(campaignRoot,'work/phase-06/LITE_TARGETED_TEST_MATRIX.md'),renderTargetedTestMatrixV1({baselineRows}));

process.stdout.write(JSON.stringify({status:'PASS',summaryRef,runIndexRef,phase5Input:'derived/phase-0/PHASE5_SIMULATION_BASELINE_INPUT_v1.json',phase6Input:'derived/phase-0/PHASE6_SIMULATION_BASELINE_INPUT_v1.json',baselineRows:baselineRows.length},null,2)+'\n');
