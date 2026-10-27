import fs from 'node:fs';
import path from 'node:path';
import {classifyDeploymentExecutionV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';

const sourceFile=(root,rel)=>path.join(root,...rel.split('/'));
const json=(root,rel)=>{try{return JSON.parse(fs.readFileSync(sourceFile(root,rel),'utf8'));}catch{return null;}};
const safeRel=p=>typeof p==='string'&&p.length>0&&!p.startsWith('/')&&!p.includes('\\')
  &&!p.split('/').some(x=>!x||x==='.'||x==='..')&&/^[A-Za-z0-9._/ -]+$/.test(p);
const localRel=(campaign,p)=>p.startsWith(campaign+'/')?p:path.posix.join(campaign,p);
const identitySafe=id=>String(id).replace(/[^A-Za-z0-9._-]/g,'_');
const code=x=>String(x??'').toUpperCase();
const executedNames=(ledger,id)=> {
  // Solidity assertion functions cannot contain a hyphen; baseline IDs are
  // emitted as BOB_0001 inside Foundry/Medusa harness names.
  const normalized=String(id).replaceAll('-','_');
  return (ledger?.tests??[]).filter(t=>t&&typeof t.name==='string'
    &&(t.name.includes(id)||t.name.includes(normalized))
    &&['PASS','FAIL'].includes(t.status));
};
const supportedSource=x=>x?.status==='LIVE_FORK_SOURCE_VERIFIED'&&x?.targets?.length>0;

/**
 * Phase-6 baseline acceptance gate for LIVE_SCAN targets only.
 * Validates real, ingested V7 machine evidence, not a reviewer's claim that
 * the source did not contain deployment scripts. Does not change frozen audits.
 */
export function validateLiveForkBaselineRecordV1({root,campaignPath,campaignId,sourceSha256,record,structuralOnly=false}={}){
  const evidence=json(root,path.posix.join(campaignPath,'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'));
  const profile=classifyDeploymentExecutionV1({execution:evidence??{}});
  if(profile.mode!=='LIVE_DEPLOYED_FORK')return [];
  const errors=[];
  if(!supportedSource(profile)){
    return ['Live deployed contract requires a verified historical Anvil fork attestation before Phase 6 baseline acceptance'];
  }
  if(!profile.targets.some(x=>x.qualifiedName===record?.contract)){
    return ['Baseline test contract is not bound to a Phase-0 verified live deployed target'];
  }
  const ids=Array.isArray(record?.obligationIds)?record.obligationIds:[];
  const outcomes=Array.isArray(record?.obligationOutcomes)?record.obligationOutcomes:[];
  const byId=new Map(outcomes.map(x=>[x?.obligationId,x]));
  const due=ids.filter(id=>byId.get(id)?.outcome!=='NOT_APPLICABLE_CONFIRMED');
  if(!due.length)return []; // Source-supported NOT_APPLICABLE is not an execution claim.
  if(!Number.isInteger(record?.dispatchRounds)||record.dispatchRounds<1||record.dispatchRounds>3)
    errors.push('Live-fork baseline obligations require 1–3 actual V7 execution rounds, not zero dispatches');
  const paths=Array.isArray(record?.requestPaths)?record.requestPaths.filter(x=>x!=='NONE_IDENTIFIED'):[];
  if(!paths.length)errors.push('Live-fork baseline obligations require committed V7 Phase-6 test request paths');
  const prefix=String(record?.requestDirectory??'').replace(/\/+$/,'')+'/';
  const ledgers=[];
  let observedAttempts=0,qualifiedExecutions=0,failedRuns=0;
  for(const requestPath of paths){
    if(!safeRel(requestPath)){errors.push('Unsafe V7 baseline request path');continue;}
    const local=requestPath.startsWith(campaignPath+'/')?requestPath.slice(campaignPath.length+1):requestPath;
    if(!local.startsWith(prefix)){errors.push('Baseline V7 request is not in its controller-prefilled group directory: '+requestPath);continue;}
    const full=localRel(campaignPath,local),request=json(root,full);
    if(!request?.requestId||!request?.requestDigest||request.campaignId!==campaignId
      ||(request?.source?.archiveSha256!==undefined&&request.source.archiveSha256!==sourceSha256)||request?.phaseId!=='build-and-test'){
      errors.push('V7 baseline request is missing or not bound to campaign/source/Phase 6: '+requestPath);continue;
    }
    const analysis=request.configuration?.analysis??{};
    if(!(analysis.nativeFuzz?.enabled===true||(analysis.medusa!==undefined&&analysis.medusa!==false&&analysis.medusa!==null))){
      errors.push('V7 baseline request does not enable Foundry or Medusa execution: '+requestPath);continue;
    }
    const base=path.posix.join(campaignPath,'controller/automation',identitySafe(request.requestId));
    const machine=json(root,path.posix.join(base,'EXECUTION_EVIDENCE_v1.json'));
    const ingestion=json(root,path.posix.join(base,'ingestion/EXECUTION_EVIDENCE_INGESTION_RECEIPT_v1.json'));
    const ledger=json(root,path.posix.join(base,'ASSERTION_LEDGER_v1.json'));
    if(!machine||!ingestion){errors.push('Missing durable V7 execution and ingestion evidence: '+request.requestId);continue;}
    if(machine.requestId!==request.requestId||machine.requestDigest!==request.requestDigest
      ||ingestion.requestId!==request.requestId){
      errors.push('V7 execution/ingestion does not match exact request: '+request.requestId);continue;
    }
    const fork=machine.preflight?.mutableRpc;
    if(machine.preflight?.status!=='PASS'||fork?.status!=='PASS'
      ||fork.identityNormalization?.status!=='PASS'
      ||fork.blockNumber!==profile.blockNumber
      ||fork.blockHash?.toLowerCase()!==profile.blockHash?.toLowerCase()){
      errors.push('V7 result lacks passing identical historical mutable Anvil fork preflight: '+request.requestId);continue;
    }
    observedAttempts++;
    if(ledger?.schemaVersion==='curveyield-assertion-ledger-v1'
      &&ledger.parseStatus==='PARSED'&&ledger.toolInvoked===true
      &&Array.isArray(ledger.tests)&&ledger.tests.length){
      qualifiedExecutions++;ledgers.push(ledger);
    }else if(machine.blocking===true||!['PASS','FINDINGS'].includes(machine.disposition))failedRuns++;
    else errors.push('V7 result claims completion without a parsed invoked assertion ledger: '+request.requestId);
  }
  if(observedAttempts===0)errors.push('No valid, bound, ingested live-fork V7 execution attempt found');
  for(const id of due){
    const outcome=byId.get(id);
    if(!outcome){errors.push('Missing live-fork baseline outcome: '+id);continue;}
    const assertions=ledgers.flatMap(ledger=>executedNames(ledger,id));
    if(structuralOnly){
      if(!assertions.length&&!(failedRuns>0&&code(outcome.outcome)==='NOT_ACHIEVED'&&outcome.reasonCode))
        errors.push('Unexecuted live-fork obligation lacks named invoked assertion or documented failed execution: '+id);
      continue;
    }
    if(code(outcome.reasonCode)==='NO_EXECUTABLE_SETUP'
      ||/NO_EXECUTABLE_SETUP|no executable setup|no admitted deterministic local execution/i.test(String(outcome.note??'')))
      errors.push('Verified live-fork target cannot use NO_EXECUTABLE_SETUP for '+id);

    if(['PASS','PASSED','ACHIEVED','SATISFIED'].includes(code(outcome.outcome))){
      if(!assertions.length||assertions.some(x=>x.status!=='PASS'))
        errors.push('Claimed passing live-fork obligation lacks passing named assertion: '+id);
    }else if(!assertions.length&&!(failedRuns>0&&code(outcome.outcome)==='NOT_ACHIEVED'
      &&outcome.reasonCode&&code(outcome.reasonCode)!=='NO_EXECUTABLE_SETUP')){
      errors.push('Unexecuted live-fork obligation requires named assertion evidence or a demonstrated failed V7 attempt: '+id);
    }
  }
  if(qualifiedExecutions===0&&failedRuns===0)errors.push('No invoked tests or documented failed V7 execution were ingested');
  return errors;
}
