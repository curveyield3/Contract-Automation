import fs from 'node:fs';
import path from 'node:path';
import {readV7RawResultV1} from './v7-compact-result-v1.mjs';
import {inspectForgeTestEvidenceV1} from './native-fuzz.mjs';

function md(value){
  if(value===null||value===undefined||value==='') return '—';
  const s=typeof value==='string'?value:JSON.stringify(value);
  return s.replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
}
function arr(v){return Array.isArray(v)?v:[];}
function safePart(v){return String(v??'target').replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,120)||'target';}
function safeRel(v){
  if(typeof v!=='string'||!v||v.startsWith('/')||v.includes('\\')||v.split('/').some(p=>!p||p==='.'||p==='..')) return null;
  return v;
}
function stableJson(value){
  if(Array.isArray(value)) return '['+value.map(stableJson).join(',')+']';
  if(value&&typeof value==='object'){
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJson(value[k])).join(',')+'}';
  }
  return JSON.stringify(value);
}

// Narrow owner-directed disposition for this frozen DAI campaign. This does
// not assert, simulate, or waive a security finding. Every skipped machine
// reproduction is carried forward with explicit UNVERIFIED evidence status.
export function inspectPhase5OwnerEvidenceDeferralV1({
  controllerRoot,campaignPath,campaignId,sourceSha256,targetDesigns=null
}={}){
  const rel=path.posix.join(campaignPath,'controller/PHASE5_OWNER_EVIDENCE_DEFERRAL_v1.json');
  const file=path.join(controllerRoot,...rel.split('/'));
  if(!fs.existsSync(file))return null;
  const d=JSON.parse(fs.readFileSync(file,'utf8'));
  const requiredCampaign='live-ethereum-dai-6b175474-r2';
  const requiredSource='457b6121c4a613730251f2f81ae17d27c9c08674696b73d1f5828c623e705ee5';
  const expectedKeys=['CAND-001','CAND-002','CAND-003'];
  const reject=x=>{throw new Error('PHASE5_OWNER_DEFERRAL_INVALID: '+x);};
  if(campaignId!==requiredCampaign||d.campaignId!==requiredCampaign||
     sourceSha256!==requiredSource||d.sourceSha256!==requiredSource||
     campaignPath!=='campaigns/live-ethereum-Dai-6b175474 r2')
    reject('scope/source mismatch');
  if(d.schemaVersion!=='curveyield-phase5-owner-evidence-deferral-v1'||
     d.decision!=='CARRY_UNVERIFIED_WITHOUT_ADDITIONAL_TESTS'||
     d.phase!==5||d.failedPacketAttempt!==6||
     d.machineExecutionStatus!=='NOT_EXECUTED_DEFERRED'||
     d.securityConclusion!=='UNVERIFIED'||
     d.authorizationBasis!=='AUDIT_OWNER_CHAT_DIRECTIVES_2026_10_24')
    reject('missing typed owner-direction and limitations');
  if(JSON.stringify(d.candidateKeys)!==JSON.stringify(expectedKeys))reject('candidate list mismatch');
  if(targetDesigns!==null){
    const observed=arr(targetDesigns).map(x=>x?.candidateKey);
    if(JSON.stringify(observed)!==JSON.stringify(expectedKeys))reject('active target designs mismatch');
  }
  const receiptPath=path.join(controllerRoot,...campaignPath.split('/'),'receipts/PHASE_00_RECEIPT_v1.json');
  const phase0=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
  if(phase0.source?.sha256!==requiredSource||phase0.authority?.packageRevision!=='v13.2')
    reject('original receipt identity mismatch');
  for(const key of expectedKeys){
    const relative='work/phase-05/execution-requests/'+key+'.json';
    const req=JSON.parse(fs.readFileSync(path.join(controllerRoot,...campaignPath.split('/'),relative),'utf8'));
    if(req.campaignId!==requiredCampaign||req.source?.archiveSha256!==requiredSource||
       req.configuration?.v26?.reproduction?.candidateId!==key||
       req.configuration?.v26?.reproduction?.reproductionType!=='ANVIL_WORKFLOW'||
       req.configuration?.analysis?.nativeFuzz?.enabled===true||
       req.configuration?.analysis?.medusa||
       req.requestDigest!==d.requestDigests?.[key]||
       req.requestId!=='dar-'+req.requestDigest.slice(0,32))
      reject('candidate request identity or optional-fuzz policy mismatch: '+key);
  }
  return {path:rel,candidateKeys:expectedKeys,requestDigests:d.requestDigests,
    status:'DEFERRED_UNVERIFIED',securityConclusion:'UNVERIFIED'};
}

export function validateTargetExecutionRequestBindingV1({controllerRoot,campaignPath,target,expectedCampaignId=null,expectedSourceSha256=null}={}){
  const key=String(target?.candidateKey??'').trim();
  const method=String(target?.executionMethod??'').toUpperCase();
  if(method==='NOT_APPLICABLE'){
    const ok=String(target?.reproductionType??'').toUpperCase()==='NOT_APPLICABLE';
    return {
      status:ok?'NOT_APPLICABLE':'FAIL_TARGET_NOT_APPLICABLE_MISMATCH',
      requestRef:'NOT_APPLICABLE',
      reasons:ok?[]:['executionMethod NOT_APPLICABLE requires reproductionType NOT_APPLICABLE']
    };
  }
  const rel=safeRel(target?.executionRequestRef);
  if(!rel) return {status:'FAIL_INVALID_EXECUTION_REQUEST_REF',requestRef:null,reasons:['executionRequestRef is missing or unsafe']};
  const requestAbs=path.join(controllerRoot,...campaignPath.split('/'),...rel.split('/'));
  if(!fs.existsSync(requestAbs)) return {status:'FAIL_MISSING_EXECUTION_REQUEST',requestRef:rel,reasons:['execution request file does not exist']};
  let request;
  try{request=JSON.parse(fs.readFileSync(requestAbs,'utf8'));}catch(error){
    return {status:'FAIL_INVALID_EXECUTION_REQUEST_JSON',requestRef:rel,reasons:[String(error?.message??error)]};
  }
  const reasons=[];
  if(expectedCampaignId&&request.campaignId!==expectedCampaignId) reasons.push('campaignId mismatch');
  if(expectedSourceSha256){
    if(!request?.source?.archiveSha256) reasons.push('request source.archiveSha256 missing');
    else if(request.source.archiveSha256!==expectedSourceSha256) reasons.push('source archive SHA-256 mismatch');
  }
  const reproduction=request?.configuration?.v26?.reproduction;
  if(!reproduction) reasons.push('configuration.v26.reproduction missing');
  else{
    if(reproduction.candidateId!==key) reasons.push('reproduction candidateId mismatch');
    if(String(reproduction.reproductionType??'')!==String(target?.reproductionType??'')) reasons.push('reproductionType mismatch');
    // Generator places the optional, validated candidateId in reproduction metadata,
    // not inside the type-specific expectedObservation payload. Apply the same
    // canonicalization during binding instead of rejecting our own request.
    const expectedObservation=structuredClone(target?.expectedMachineObservation);
    if(expectedObservation?.candidateId===key)delete expectedObservation.candidateId;
    if(stableJson(reproduction.expectedObservation)!==stableJson(expectedObservation))
      reasons.push('expected machine observation mismatch');
    const type=String(reproduction.reproductionType??'');
    if(['FOUNDRY_TEST','MEDUSA_PROPERTY'].includes(type)&&request.phaseId!=='build-and-test') reasons.push('Foundry/Medusa reproduction must use build-and-test');
    if(type==='ANVIL_WORKFLOW'&&request.phaseId!=='fork-simulation-lifecycle') reasons.push('Anvil reproduction must use fork-simulation-lifecycle');
  }
  const harness=request?.configuration?.harness;
  return {
    status:reasons.length?'FAIL_STRUCTURAL_REQUEST_TARGET_BINDING':'PASS_STRUCTURAL_BINDING_REQUIRES_PHASE6_SEMANTIC_HARNESS_REVIEW',
    requestRef:rel,
    reasons,
    candidateId:reproduction?.candidateId??null,
    reproductionType:reproduction?.reproductionType??null,
    harnessBundleId:harness?.bundleId??null,
    harnessRecipeId:harness?.recipeId??null
  };
}
function statusText(r){
  if(!r) return 'BLOCKED_NO_MACHINE_RESULT';
  if(r.status) return String(r.status);
  if(r.rawResult?.reproduction?.status) return String(r.rawResult.reproduction.status);
  if(r.rawResult?.disposition) return String(r.rawResult.disposition);
  return 'COMPLETED_UNCLASSIFIED';
}
function deterministicSummary(r){
  const x=r?.rawResult??{};
  if(x.reproduction) return x.reproduction.status??'REPRODUCTION_RECORDED';
  if(x.simulation?.steps) return `${x.simulation.steps.length} simulation step(s)`;
  if(x.status) return x.status;
  return r?.status??'NO_DETERMINISTIC_RESULT';
}
function fuzzSummary(r){
  const x=r?.rawResult??{};
  const native=x.analysis?.nativeFuzz;
  if(native) return native.componentStatus??native.status??'RECORDED';
  const medusa=x.analysis?.medusa;
  if(medusa) return medusa.componentStatus??medusa.status??'RECORDED';
  return 'NOT_EXECUTED_OR_NOT_APPLICABLE';
}

// Phase-0 LIVE_SCAN is a deployed-address audit, not a request to replay deployment scripts.
// Distinguish a verified pinned fork source from proof that mutable tests have run.
export function classifyDeploymentExecutionV1({execution={}}={}){
  const live=execution?.deploymentProfile?.mode==='LIVE'
    ||execution?.scanSourceSnapshot?.inputMode==='LIVE_SCAN'
    ||execution?.liveDeployment?.status==='VERIFIED';
  if(live){
    const targets=arr(execution?.liveDeployment?.contracts).filter(c=>/^0x[0-9a-fA-F]{40}$/.test(String(c?.address??'')));
    const declared=arr(execution?.deploymentProfile?.contracts);
    const verified=execution?.status==='PASS_LIVE_DEPLOYMENT'
      &&execution?.liveDeployment?.status==='VERIFIED'
      &&execution?.fork?.engine==='anvil'
      &&execution?.fork?.verifiedHistoricalFork===true
      &&execution?.fork?.chainId===1
      &&Number.isSafeInteger(execution?.fork?.initialBlock)
      &&/^0x[0-9a-fA-F]{64}$/.test(String(execution?.fork?.pinnedHistoricalHash??''))
      &&targets.length>0
      &&targets.length===declared.length
      &&targets.every(c=>declared.some(d=>d.address?.toLowerCase()===c.address?.toLowerCase()
        &&d.qualifiedName===c.qualifiedName));
    return {mode:'LIVE_DEPLOYED_FORK',status:verified?'LIVE_FORK_SOURCE_VERIFIED':'LIVE_FORK_ATTESTATION_REQUIRED',
      targets,blockNumber:execution?.fork?.initialBlock??null,blockHash:execution?.fork?.pinnedHistoricalHash??null,
      evidenceRef:'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',
      mutableTestExecutionProven:false};
  }
  const attempts=arr(execution?.attempts);
  return {mode:'SOURCE_LOCAL_DEPLOY',status:attempts.some(a=>a.status==='PASS'||a.exitCode===0)
    ?'SOURCE_SETUP_EXECUTED':'SOURCE_SETUP_NOT_EXECUTED',targets:[],
    evidenceRef:'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',
    mutableTestExecutionProven:false};
}

export function renderDeployConfigMatrixV1({readiness={},execution={}}={}){
  const dep=readiness.deploymentAndConfiguration??{};
  const attempts=arr(execution.attempts);
  const classification=classifyDeploymentExecutionV1({execution});
  const rows=[];
  let order=1;
  if(classification.mode==='LIVE_DEPLOYED_FORK'){
    for(const target of classification.targets){
      rows.push(`| ${order++} | Existing live deployment: ${md(target.qualifiedName??'deployed contract')} | NOT_REDEPLOYED | ${md(target.address)} at Ethereum block ${md(classification.blockNumber)} | Inspect deployed wards and governance on fork | Inspect deployed storage and configuration on fork | Live runtime verified; mutable state tests still required | ${md(classification.evidenceRef)} | ${md(classification.status)} |`);
    }
    if(!rows.length) rows.push(`| ${order++} | Live deployment identity unresolved | NOT_REDEPLOYED | SEE_LIVE_DEPLOYMENT | SEE_SOURCE | SEE_SOURCE | Reconcile runtime and historical fork before any testing | ${md(classification.evidenceRef)} | LIVE_FORK_ATTESTATION_REQUIRED |`);
  }
  for(const a of attempts){
    rows.push(`| ${order++} | ${md(a.script??a.action??'source-known setup')} | ${md(a.constructorOrInitializer??'SOURCE_DEFINED')} | ${md(a.dependenciesOrAddresses??'SEE_SOURCE_SETUP')} | ${md(a.rolesOrGovernance??'SEE_SOURCE_SETUP')} | ${md(a.approvalsOrConfiguration??'SEE_SOURCE_SETUP')} | ${md(a.postStateAssertion??a.resultSummary??'SEE_MACHINE_EVIDENCE')} | ${md(a.evidenceRef)} | ${md(a.status??(a.exitCode===0?'PASS':'BLOCKED'))} |`);
  }
  if(!rows.length){
    for(const file of arr(dep.deploymentFiles)){
      rows.push(`| ${order++} | Source-known deployment/configuration surface: ${md(file)} | SOURCE_DEFINED | SEE_SOURCE | SEE_SOURCE | SEE_SOURCE | No admitted deterministic local execution path was machine-resolvable | evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json | BLOCKED_NO_ADMITTED_LOCAL_EXECUTION |`);
    }
  }
  if(!rows.length) rows.push('| 1 | No source-known deployment/configuration action discovered | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | No deployment/configuration surface discovered by Phase-0 automation | evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json | NOT_APPLICABLE |');

  const usability=classification.mode==='LIVE_DEPLOYED_FORK'
    ? `| P0-U-001 | Attach and mutate existing deployed contract on local Anvil fork | Pinned Ethereum state: block ${md(classification.blockNumber)} | Attach at deployed address without redeploying; run V7 harness with mutable fork | Verified live identity followed by passing mutable-fork preflight and executed assertions | ${md(classification.status)}; mutable-fork tests not yet demonstrated | ${md(classification.evidenceRef)} | ${classification.status==='LIVE_FORK_SOURCE_VERIFIED'?'MUTABLE_FORK_PREFLIGHT_REQUIRED':'LIVE_FORK_ATTESTATION_REQUIRED'} |`
    : attempts.length
      ? attempts.map((a,i)=>`| P0-U-${String(i+1).padStart(3,'0')} | ${md(a.usabilityCheck??a.script??'source-known local setup')} | clean Phase-0 machine environment | ${md(a.script??a.action)} | exit 0 / source-defined assertions pass | ${md(a.resultSummary??`exit ${a.exitCode??'unknown'}`)} | ${md(a.evidenceRef)} | ${md(a.status??(a.exitCode===0?'PASS':'BLOCKED'))} |`).join('\n')
      :'| P0-U-001 | Source-known local deployment/configuration usability | clean Phase-0 machine environment | No admitted deterministic local command discovered | Machine-executable setup present | No executable setup available | evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json | BLOCKED |';

  const gaps=[];
  for(const f of arr(execution.gaps)) gaps.push(`| ${md(f.id??`P0-GAP-${gaps.length+1}`)} | ${md(f.value??f.reason)} | ${md(f.recoveryAttempt??'AUTOMATED_DISCOVERY_COMPLETE')} | ${md(f.securityEffect??'REQUIRES_PHASE6_INTERPRETATION')} | ${md(f.candidateOrObligation??'PENDING_PHASE6_INTERPRETATION')} | ${md(f.disposition??'BLOCKED')} |`);
  if(!gaps.length && attempts.some(a=>(a.status??'')!=='PASS')) gaps.push('| P0-GAP-001 | One or more source-known setup attempts did not pass | Phase-0 automation attempted every admitted local setup command | REQUIRES_PHASE6_INTERPRETATION | PENDING_PHASE6_INTERPRETATION | BLOCKED |');
  if(!gaps.length) gaps.push('| NONE | NONE_IDENTIFIED | NOT_APPLICABLE | NONE_IDENTIFIED | NONE_IDENTIFIED | PASS |');

  return `# Lite Deployment and Configuration Matrix

> **CONTROLLER-POPULATED:** Generated from Phase-0 boundary machine execution. The Phase-6 reviewer consumes this evidence and records only semantic security interpretation in the Phase-6 work form. Do not duplicate campaign or controller metadata here.

## Required sequence

| Order | Component/action | Constructor or initializer | Dependencies/addresses | Roles/ownership/governance | Approvals/configuration | Post-state assertion | Evidence | Status |
|---:|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Usability checks

| Check ID | Required normal operation | Starting state | Transaction sequence | Expected result | Actual result | Evidence | Status |
|---|---|---|---|---|---|---|---|
${usability}

## Configuration gaps and limitations

| Gap ID | Missing/uncertain value | Recovery attempted | Security effect | Related candidate / security question | Disposition |
|---|---|---|---|---|---|
${gaps.join('\n')}

Completion requires every material deploy/config action to be present or explicitly blocked with evidence.
`;
}

export function renderTargetedTestMatrixV1({targetDesigns=[],executionResults={},baselineRows=[]}={}){
  const rows=[];
  for(const b of arr(baselineRows)){
    if(!b||typeof b!=='object') continue;
    rows.push(`| ${md(b.targetId??b.candidateKey??'PHASE0-BASELINE')} | ${md(b.candidateOrProperty??b.description??'Phase-0 randomized baseline')} | ${md(b.setup??'Phase-0 Anvil baseline')} | ${md(b.transactionSequence??'SEE_PHASE0_RUN_INDEX')} | ${md(b.expectedSecureOutcome??'INVESTIGATIVE_BASELINE_NO_SECURITY_CONCLUSION')} | ${md(b.oracle??'MECHANICAL_EXECUTION_AND_ACCOUNTING_TELEMETRY')} | ${md(b.requestBindingStatus??'PHASE0_CONTROLLER_GENERATED')} | ${md(b.simulationResult??b.reproductionStatus??'UNRESOLVED')} | ${md(b.fuzzVariablesAndBounds??'SEE_PHASE0_SIMULATION_POLICY')} | ${md(b.result??b.oracleOutcome??b.reproductionStatus??'UNRESOLVED')} | ${md(b.evidenceRefs??b.executionEvidenceRefs??'NO_MACHINE_EVIDENCE')} |`);
  }
  for(const [i,t] of arr(targetDesigns).entries()){
    if(!t||typeof t!=='object') continue;
    const key=t.candidateKey??`TARGET-${i+1}`;
    const r=executionResults[key]??null;
    rows.push(`| ${md(key)} | ${md([key,t.expectedSecurityProperty].filter(Boolean).join(' — '))} | ${md([t.setup,t.prerequisites].filter(Boolean).join(' / '))} | ${md(t.transactionSequence)} | ${md(t.expectedSecurityProperty)} | ${md(t.oracle)} | ${md(r?.requestBindingStatus??t.requestBindingStatus??'UNVERIFIED')} | ${md(deterministicSummary(r))} | ${md(t.fuzzVariablesAndBounds)} | ${md(`deterministic=${deterministicSummary(r)}; targetedFuzz=${fuzzSummary(r)}; status=${statusText(r)}`)} | ${md(r?.evidenceRef??'NO_MACHINE_EVIDENCE')} |`);
  }
  if(!rows.length) rows.push('| NO_TARGET | NO_CANDIDATE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NO_CANDIDATE | NO_MACHINE_EVIDENCE |');
  return `# Lite Candidate Target Matrix

> **CONTROLLER-POPULATED:** Seeded from accepted Phase-2–5 candidate-specific target designs and finalized from Phase-5 boundary machine execution. Phase 0 supplies forked deploy/configuration evidence, not randomized simulation or telemetry. The Phase-6 reviewer consumes the completed matrix and records only semantic interpretation/disposition in the Phase-6 work form. Phase-0 baseline rows are investigative context, not pre-decided findings. Do not duplicate campaign identity or controller bookkeeping here.

| Target ID | Candidate / property / hypothesis | Exact setup and attacker/actor | AI-guided attacker/exploit sequence | Expected secure outcome | Exploit/failure oracle | Request/target structural binding | Attacker/exploit simulation result | AI-guided targeted fuzz variables/bounds | Result | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

Rules:

- Include every material candidate and every due retained execution obligation from accepted Phase-2–5 canonical data.
- AI-guided targeted fuzzing varies only reviewer-selected candidate-relevant inputs and boundaries.
- A target cannot be closed merely because one happy-path case passed.
`;
}

// Completion of every material Phase-5 target is a mandatory seal precondition.
// A structurally valid request is not machine evidence, and "no target" cannot
// discharge a retained material candidate.
// Only exact, machine-verifiable equivalence can waive a duplicate test.
// No static-proof or out-of-scope assertion is accepted merely as prose:
// those require a separate independently verifiable proof mechanism.
const PHASE5_EQUIVALENCE_FIELDS=[
  'setup','prerequisites','transactionSequence','oracle',
  'fuzzVariablesAndBounds','snapshotReuseSafety','expectedSecurityProperty'
];
function verifiedNotApplicableDesignV1(target,targets,candidateSourceAnchors={}){
  const key=String(target?.candidateKey??'');
  const disposition=target?.notApplicableDisposition;
  if(target?.executionMethod!=='NOT_APPLICABLE')
    return ['Candidate '+key+' is not a NOT_APPLICABLE design'];
  if(target?.reproductionType!=='NOT_APPLICABLE')
    return ['Phase 5 '+key+' NOT_APPLICABLE method requires reproductionType NOT_APPLICABLE'];
  if(!disposition||disposition.reasonCode!=='COVERED_BY_EXECUTED_TARGET')
    return ['Phase 5 '+key+' has no supported, verifiable NOT_APPLICABLE disposition (only COVERED_BY_EXECUTED_TARGET)'];
  if(typeof disposition.technicalReason!=='string'||disposition.technicalReason.trim().length<20)
    return ['Phase 5 '+key+' NOT_APPLICABLE requires a substantive technicalReason'];
  const coveredKey=disposition.coveredByCandidateKey;
  if(typeof coveredKey!=='string'||!coveredKey||coveredKey===key)
    return ['Phase 5 '+key+' NOT_APPLICABLE coveredByCandidateKey must identify a different executed candidate'];
  const covered=targets.find(x=>x&&typeof x==='object'&&x.candidateKey===coveredKey);
  if(!covered||covered.executionMethod!=='V7_REQUEST')
    return ['Phase 5 '+key+' NOT_APPLICABLE has no executable covering candidate '+String(coveredKey)];
  const sourceAnchor=candidateSourceAnchors[key],coveredAnchor=candidateSourceAnchors[coveredKey];
  if(!sourceAnchor||!coveredAnchor||sourceAnchor!==coveredAnchor)
    return ['Phase 5 '+key+' NOT_APPLICABLE candidate source anchor must exactly match the executed '+coveredKey];
  for(const field of PHASE5_EQUIVALENCE_FIELDS){
    if(target[field]===undefined||covered[field]===undefined||
       stableJson(target[field])!==stableJson(covered[field])){
      return ['Phase 5 '+key+' NOT_APPLICABLE does not have exactly equivalent '+field+' to executed '+coveredKey];
    }
  }
  return [];
}
export function validatePhase5TargetCoverageV1({targetDesigns=[],materialCandidateKeys=[],candidateSourceAnchors={}}={}){
  const failures=[];
  const required=[...new Set(arr(materialCandidateKeys).filter(x=>typeof x==='string'&&x&&x!=='NONE_IDENTIFIED'))];
  const seen=new Set();
  const targets=arr(targetDesigns);
  for(const [i,target] of targets.entries()){
    if(target==='NONE_IDENTIFIED'){
      if(required.length||targets.length!==1) failures.push('Phase 5 NONE_IDENTIFIED is invalid while material candidates exist or other targets are listed');
      continue;
    }
    if(!target||typeof target!=='object'||Array.isArray(target)){
      failures.push('Phase 5 target index '+i+' has no executable design');
      continue;
    }
    const key=String(target.candidateKey??'').trim();
    if(!key||key==='NONE_IDENTIFIED'){failures.push('Phase 5 target index '+i+' has no material candidateKey');continue;}
    if(seen.has(key))failures.push('Phase 5 duplicate candidate target '+key);
    seen.add(key);
    if(target.executionMethod==='NOT_APPLICABLE') failures.push(...verifiedNotApplicableDesignV1(target,targets,candidateSourceAnchors));
  }
  for(const key of required)if(!seen.has(key))failures.push('Phase 5 mandatory material candidate '+key+' has no targeted machine execution');
  if(!targets.length) failures.push('Phase 5 targetDesigns missing; explicit NONE_IDENTIFIED is allowed only when no material candidates exist');
  return failures;
}

// This single evidence verifier is shared by direct targets and target aliases.
function validateExecutedPhase5TargetV1({controllerRoot,campaignPath,target,result,expectedSourceSha256=null}={}){
  const failures=[];
  const key=String(target?.candidateKey??'');
    if(!result||result.status!=='PASS'||result.exitCode!==0){
      failures.push('Phase 5 mandatory '+key+' machine execution did not PASS (status='+String(result?.status??'MISSING')+', exitCode='+String(result?.exitCode??'MISSING')+'); blocked, inconclusive and missing simulations prohibit seal');
      return failures;
    }
    if(!String(result.requestBindingStatus??'').startsWith('PASS_')){
      failures.push('Phase 5 mandatory '+key+' request binding did not PASS');
      return failures;
    }
    const raw=result.rawResult;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)){
      failures.push('Phase 5 mandatory '+key+' missing parsed raw machine result');
      return failures;
    }
    const rel=result.evidenceRef;
    const expectedPrefix=path.posix.join(campaignPath,'evidence/phase5-boundary',safePart(key))+'/';
    const rawFile=typeof rel==='string'&&safeRel(rel)&&controllerRoot?
      path.join(controllerRoot,...rel.split('/')):null;
    if(!rawFile||!rel.startsWith(expectedPrefix)||!rel.endsWith('/raw-result.json')||
       !fs.existsSync(rawFile)){
      failures.push('Phase 5 mandatory '+key+' missing exact persisted raw-result.json evidence');
    }else{
      try{
        const persisted=readV7RawResultV1(rawFile);
        if(stableJson(persisted)!==stableJson(raw)){
          failures.push('Phase 5 mandatory '+key+' raw machine result does not match persisted artifact');
        }
      }catch(e){failures.push('Phase 5 mandatory '+key+' raw evidence is unreadable: '+String(e.message||e));}
    }
    const requestId=typeof rel==='string'?rel.split('/').at(-2):'';
    if(!/^dar-[0-9a-f]{32}$/.test(requestId)||raw.requestId!==requestId){
      failures.push('Phase 5 mandatory '+key+' raw request identity differs from bound execution');
    }
    if(raw.status!=='completed'||raw.blocking===true||raw.preflight?.status!=='PASS'){
      failures.push('Phase 5 mandatory '+key+' did not complete a successful V7 preflight and execution');
    }
    if(expectedSourceSha256&&raw.source?.archiveSha256!==expectedSourceSha256){
      failures.push('Phase 5 mandatory '+key+' raw execution source identity differs from campaign source');
    }
    if(!raw.build||typeof raw.build!=='object')failures.push('Phase 5 mandatory '+key+' has no successful source-build evidence');
    if((raw.failedStepCount??0)>0||(raw.failedSteps?.length??0)>0)
      failures.push('Phase 5 mandatory '+key+' contains failed execution steps');
    const boundRequest=validateTargetExecutionRequestBindingV1({
      controllerRoot,campaignPath,target,expectedSourceSha256
    });
    if(!String(boundRequest.status).startsWith('PASS_')){
      failures.push('Phase 5 mandatory '+key+' request/source binding failed on evidence replay');
    }else{
      try{
        const req=JSON.parse(fs.readFileSync(path.join(controllerRoot,...campaignPath.split('/'),...boundRequest.requestRef.split('/')),'utf8'));
        if(raw.requestId!==req.requestId||raw.requestDigest!==req.requestDigest||
           raw.source?.commit!==req.source?.commit||
           raw.source?.archiveSha256!==req.source?.archiveSha256)
          failures.push('Phase 5 mandatory '+key+' persisted evidence does not match the exact request digest and source commit');
      }catch(e){failures.push('Phase 5 mandatory '+key+' bound request cannot be re-read: '+String(e.message||e));}
    }
    const reproduction=raw.reproduction;
    const terminalOutcome=reproduction?.status==='REPRODUCED'&&reproduction?.observedPredicate?.matched===true||
      reproduction?.status==='NOT_REPRODUCED'&&reproduction?.observedPredicate?.matched===false;
    if(!reproduction||reproduction.candidateId!==key||!terminalOutcome||
       reproduction.observedPredicate?.observed==null){
      failures.push('Phase 5 mandatory '+key+' lacks a completed, observed reproduction or non-reproduction outcome');
    }
    const type=String(target.reproductionType??'');
    const component=type==='FOUNDRY_TEST'?raw.analysis?.nativeFuzz:
                    type==='MEDUSA_PROPERTY'?raw.analysis?.medusa:null;
    if(type==='FOUNDRY_TEST'||type==='MEDUSA_PROPERTY'){
      if(!component||component.toolInvoked===false||
         component.componentStatus!=='COMPLETED'){
        failures.push('Phase 5 mandatory '+key+' required '+type+' component never completed its execution');
      }
      if(type==='FOUNDRY_TEST'){
        const forgeEvidence=inspectForgeTestEvidenceV1('forge',component?.rawOutput);
        if(!forgeEvidence.successful){
          failures.push('Phase 5 mandatory '+key+' forge log does not prove at least one passing test suite with zero failures and no compiler errors (observed passed='+forgeEvidence.passed+', failed='+forgeEvidence.failed+', compilerFailure='+forgeEvidence.compilerFailure+'). Process exit 0 and componentStatus COMPLETED are insufficient.');
        }
      }
      if(raw.analysis?.slither?.componentStatus==='COMPLETED_WITH_FAILURES'&&
         raw.analysis?.slither?.rawOutput?.exitCode!==0){
        failures.push('Phase 5 mandatory '+key+' Slither component reported an untriaged process failure (exit='+String(raw.analysis.slither.rawOutput.exitCode)+'); reconcile failed profile before conclusive PASS.');
      }
    }else if(type==='ANVIL_WORKFLOW'){
      if(!Array.isArray(raw.simulation?.steps)||raw.simulation.steps.length===0){
        failures.push('Phase 5 mandatory '+key+' has no executed Anvil simulation steps');
      }
      // A successful oracle on a synthetic standalone chain must never seal a
      // campaign: verify the machine's own historical preflight and fork proof,
      // not just a source-bound request and a list of completed calls.
      const fork=raw.simulation,pre=raw.preflight,checks=pre?.checks??{};
      if(fork?.engine!=='anvil'||fork?.pinnedFork!==true||
         !Number.isSafeInteger(fork?.block)||fork.block<1||
         pre?.pinnedBlock!==fork.block||
         checks.anvilLauncher?.status!=='PASS'||
         checks.chainIdentity?.status!=='PASS'||
         checks.pinnedBlockState?.status!=='PASS'||
         !['PASS','UNAVAILABLE'].includes(checks.targetCode?.status)){
        failures.push('Phase 5 mandatory '+key+' lacks verified local Anvil chain, historical block/hash or deployed-code preflight; standalone/synthetic simulation evidence is not admissible');
      }
      if(fork?.chain==='ethereum'&&fork?.chainId!==1){
        failures.push('Phase 5 mandatory '+key+' Ethereum simulation did not execute with verified chain ID 1');
      }
    }else failures.push('Phase 5 mandatory '+key+' has unsupported reproductionType');

  return failures;
}

export function validatePhase5TargetExecutionGateV1({controllerRoot,campaignPath,targetDesigns=[],executionResults={},materialCandidateKeys=[],candidateSourceAnchors={},expectedSourceSha256=null}={}){
  const failures=validatePhase5TargetCoverageV1({targetDesigns,materialCandidateKeys,candidateSourceAnchors});
  for(const target of arr(targetDesigns)){
    if(!target||typeof target!=='object'||Array.isArray(target))continue;
    const key=String(target.candidateKey??'').trim();
    if(!key||key==='NONE_IDENTIFIED')continue;
    if(target.executionMethod==='NOT_APPLICABLE'){
      const disposition=target.notApplicableDisposition;
      const coveredKey=disposition?.coveredByCandidateKey;
      const coveringDesign=arr(targetDesigns).find(x=>x&&typeof x==='object'&&x.candidateKey===coveredKey);
      const coveredResult=executionResults?.[coveredKey];
      if(coveringDesign?.executionMethod==='V7_REQUEST'&&coveredKey!==key){
        const evidenceFailures=validateExecutedPhase5TargetV1({
          controllerRoot,campaignPath,target:coveringDesign,result:coveredResult,expectedSourceSha256
        });
        for(const error of evidenceFailures)failures.push('Phase 5 '+key+' NOT_APPLICABLE covering evidence: '+error);
      }else failures.push('Phase 5 '+key+' NOT_APPLICABLE has no verified covering execution');
      continue;
    }
    failures.push(...validateExecutedPhase5TargetV1({
      controllerRoot,campaignPath,target,result:executionResults?.[key],expectedSourceSha256
    }));
  }
  return failures;
}

// Recheck sealed machine evidence at Phase-6 admission and every downstream
// master review. No reviewer-supplied PASS status or receipt can substitute for
// re-reading the exact source-bound V7 request and nested execution artifact.
export function validateRecordedPhase5MachineEvidenceV1({controllerRoot,campaignPath,targetDesigns=[],expectedCampaignId=null,expectedSourceSha256=null,requireCompletedMatrix=false}={}){
  const failures=[];
  const campaignRoot=path.join(controllerRoot,...campaignPath.split('/'));
  const readJsonRel=rel=>JSON.parse(fs.readFileSync(path.join(controllerRoot,...rel.split('/')),'utf8'));
  let materialCandidateKeys=[];
  try{
    const p4=readJsonRel(path.posix.join(campaignPath,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json'));
    const p5=readJsonRel(path.posix.join(campaignPath,'derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json'));
    materialCandidateKeys=[
      ...(p4.actions?.['step-3']?.outputs?.candidateRecords??[]),
      ...(p5.actions?.['step-2']?.outputs?.newCandidateRecords??[])
    ].filter(x=>x&&typeof x==='object').map(x=>String(x.tempKey??'').trim()).filter(Boolean);
  }catch(e){failures.push('Cannot derive required candidate coverage from sealed Phase 4/5 canonical artifacts: '+String(e.message||e));}
  const executionResults={};
  for(const target of arr(targetDesigns)){
    if(!target||typeof target!=='object'||Array.isArray(target))continue;
    const key=String(target.candidateKey??'').trim();
    if(!key||target.executionMethod==='NOT_APPLICABLE')continue;
    const binding=validateTargetExecutionRequestBindingV1({controllerRoot,campaignPath,target,expectedCampaignId,expectedSourceSha256});
    if(!String(binding.status).startsWith('PASS_')){
      failures.push(key+': sealed execution request failed binding validation: '+String(binding.status));
      continue;
    }
    let req=null;
    try{req=readJsonRel(path.posix.join(campaignPath,binding.requestRef));}catch(e){failures.push(key+': bound request cannot be read: '+String(e.message||e));continue;}
    if(!/^dar-[0-9a-f]{32}$/.test(String(req.requestId??''))){failures.push(key+': invalid bound request ID');continue;}
    const rel=path.posix.join(campaignPath,'evidence/phase5-boundary',safePart(key),req.requestId,'raw-result.json');
    let raw=null;
    try{raw=readV7RawResultV1(path.join(controllerRoot,...rel.split('/')));}catch(e){failures.push(key+': required V7 raw result is missing: '+rel);continue;}
    executionResults[key]={
      status:raw.status==='completed'&&raw.blocking!==true?'PASS':'BLOCKED',
      exitCode:raw.status==='completed'&&raw.blocking!==true?0:1,
      evidenceRef:rel,requestBindingStatus:binding.status,rawResult:raw
    };
  }
  failures.push(...validatePhase5TargetExecutionGateV1({
    controllerRoot,campaignPath,targetDesigns,executionResults,materialCandidateKeys,expectedSourceSha256
  }));
  if(requireCompletedMatrix){
    const matrixPath=path.join(campaignRoot,'work/phase-06/LITE_TARGETED_TEST_MATRIX.md');
    let matrix=null;
    try{matrix=fs.readFileSync(matrixPath,'utf8');if(!matrix.trim())failures.push('Sealed Phase-6 target matrix is empty');}
    catch{failures.push('Sealed Phase-6 target matrix is missing');}
    if(matrix)for(const [key,result] of Object.entries(executionResults)){
      const row=matrix.split(/\r?\n/).find(line=>line.startsWith('| '+key+' |'));
      const cells=row?.split('|').map(v=>v.trim())??[];
      if(!row||!cells[10]?.includes('status=PASS')||cells[11]!==result.evidenceRef)
        failures.push(key+': sealed target matrix does not bind a completed result to its exact raw evidence path');
    }
  }
  return failures;
}

// A master refresh may reuse a completed run only when both the exact test
// design and its source-anchored candidate identity survived the amendments.
// Comparing all reviewer-owned test fields is deliberately conservative:
// uncertainty costs an execution, never an unsupported PASS.
const PHASE5_MACHINE_PREFILL_FIELDS_V1=new Set([
  'automationOwnedFields','automationResolvedExecutionRequest',
  'requestBindingStatus','requestBindingEvidenceRef'
]);
function executionSensitiveTargetV1(target){
  if(!target||typeof target!=='object'||Array.isArray(target))return null;
  return Object.fromEntries(Object.entries(target).filter(([key])=>!PHASE5_MACHINE_PREFILL_FIELDS_V1.has(key)));
}
function candidateByKeyV1(rows){
  const result=new Map();
  for(const row of arr(rows)){
    if(!row||typeof row!=='object'||Array.isArray(row))continue;
    const key=String(row.tempKey??'').trim();
    if(!key||result.has(key))return null;
    result.set(key,row);
  }
  return result;
}
export function selectReusablePhase5TargetsV1({
  priorTargetDesigns=[],targetDesigns=[],
  priorCandidateRecords=[],candidateRecords=[]
}={}){
  const oldCandidates=candidateByKeyV1(priorCandidateRecords);
  const newCandidates=candidateByKeyV1(candidateRecords);
  if(!oldCandidates||!newCandidates)return [];
  const oldTargets=new Map(arr(priorTargetDesigns)
    .filter(t=>t&&typeof t==='object'&&!Array.isArray(t)&&t.candidateKey)
    .map(t=>[String(t.candidateKey),t]));
  const selected=[];
  for(const target of arr(targetDesigns)){
    if(target?.executionMethod!=='V7_REQUEST')continue;
    const key=String(target.candidateKey??'').trim();
    const prior=oldTargets.get(key);
    const before=oldCandidates.get(key),after=newCandidates.get(key);
    if(!key||!prior||!before||!after)continue;
    const oldAnchor=String(before.sourceAnchor??'').trim();
    const newAnchor=String(after.sourceAnchor??'').trim();
    if(!oldAnchor||oldAnchor!==newAnchor)continue;
    if(stableJson(executionSensitiveTargetV1(prior))!==stableJson(executionSensitiveTargetV1(target)))continue;
    selected.push(key);
  }
  return selected;
}

// Reading raw-result.json never counts as evidence unless the SAME strict
// machine-evidence verifier used by the phase gate accepts it.
export function verifiedReusablePhase5ResultV1({
  controllerRoot,campaignPath,target,expectedCampaignId,expectedSourceSha256
}={}){
  if(!controllerRoot||!campaignPath||target?.executionMethod!=='V7_REQUEST')return null;
  const key=String(target.candidateKey??'').trim();
  const binding=validateTargetExecutionRequestBindingV1({
    controllerRoot,campaignPath,target,expectedCampaignId,expectedSourceSha256
  });
  if(!String(binding.status).startsWith('PASS_'))return null;
  try{
    const request=JSON.parse(fs.readFileSync(path.join(controllerRoot,...campaignPath.split('/'),...binding.requestRef.split('/')),'utf8'));
    if(!/^dar-[0-9a-f]{32}$/.test(String(request.requestId??'')))return null;
    const evidenceRef=path.posix.join(campaignPath,'evidence/phase5-boundary',safePart(key),request.requestId,'raw-result.json');
    const rawResult=readV7RawResultV1(path.join(controllerRoot,...evidenceRef.split('/')));
    const result={
      status:'PASS',exitCode:0,evidenceRef,rawResult,
      requestBindingStatus:binding.status,
      requestBindingEvidenceRef:binding.requestRef,
      requestBindingReasons:binding.reasons,
      reusedRecordedEvidence:true
    };
    return validateExecutedPhase5TargetV1({
      controllerRoot,campaignPath,target,result,expectedSourceSha256
    }).length===0?result:null;
  }catch{return null;}
}

export async function executePhase5TargetsV1({
  controllerRoot,campaignPath,targetDesigns=[],
  expectedCampaignId=null,expectedSourceSha256=null,
  reuseCandidateKeys=[],runProcessFn=null
}={}){
  const campaignRoot=path.join(controllerRoot,...campaignPath.split('/'));
  const executionResults={};
  let runProcessV1=null;
  for(const t of arr(targetDesigns)){
    const key=String(t?.candidateKey??'').trim();
    if(!key) continue;
    const method=String(t.executionMethod??'').toUpperCase();
    if(method==='NOT_APPLICABLE'){
      executionResults[key]={status:'NOT_APPLICABLE',
        notApplicableDisposition:t.notApplicableDisposition??null,
        evidenceRef:'VERIFIED_COVERING_TARGET_REQUIRED'};
      continue;
    }
    if(method!=='V7_REQUEST'){
      executionResults[key]={status:'BLOCKED_UNSUPPORTED_EXECUTION_METHOD',evidenceRef:'NO_MACHINE_EVIDENCE'};
      continue;
    }
    if(reuseCandidateKeys.includes(key)){
      const reused=verifiedReusablePhase5ResultV1({
        controllerRoot,campaignPath,target:t,expectedCampaignId,expectedSourceSha256
      });
      if(reused){process.stderr.write(`[phase5-sim] REUSE ${key}: verified exact completed machine evidence\n`);executionResults[key]=reused;continue;}
    }
    const binding=validateTargetExecutionRequestBindingV1({
      controllerRoot,campaignPath,target:t,expectedCampaignId,expectedSourceSha256
    });
    if(!String(binding.status).startsWith('PASS_')){
      process.stderr.write(`[phase5-sim] BLOCKED ${key}: request binding ${binding.status}\n`);
      executionResults[key]={
        status:'BLOCKED_REQUEST_TARGET_BINDING_MISMATCH',
        requestBindingStatus:binding.status,
        requestBindingReasons:binding.reasons,
        requestBindingEvidenceRef:binding.requestRef??'NO_REQUEST',
        evidenceRef:binding.requestRef??'NO_MACHINE_EVIDENCE'
      };
      continue;
    }
    const rel=binding.requestRef;
    const requestAbs=path.join(campaignRoot,...rel.split('/'));
    const evRel=path.posix.join(campaignPath,'evidence/phase5-boundary',safePart(key));
    const evAbs=path.join(controllerRoot,...evRel.split('/'));
    const workspace=path.join(process.cwd(),'.audit-work','phase5-boundary',safePart(key));
    if(!runProcessV1){
      if(runProcessFn)runProcessV1=runProcessFn;
      else ({runProcess:runProcessV1}=await import('./execution.mjs'));
    }
    // Each candidate is independently observable and time-bounded. The
    // stdout evidence channel stays structured; progress goes only to stderr.
    const startedAt=Date.now();
    const candidateTimeoutMs=40*60*1000;
    process.stderr.write(`[phase5-sim] START ${key} V7 execution (max 40 minutes)\n`);
    const heartbeat=setInterval(()=>{
      const elapsed=Math.floor((Date.now()-startedAt)/60000);
      process.stderr.write(`[phase5-sim] RUNNING ${key} elapsed=${elapsed}m; awaiting runner result\n`);
    },60_000);
    let result;
    let markerBuffer='';
    const relayProgress=(chunk)=>{
      markerBuffer+=chunk;
      let index;
      while((index=markerBuffer.indexOf('\n'))!==-1){
        const line=markerBuffer.slice(0,index).trimEnd();
        markerBuffer=markerBuffer.slice(index+1);
        // Machine stderr can contain RPC URLs; relay only our fixed markers.
        if(line.startsWith('[phase5-v7]'))process.stderr.write(line+'\n');
      }
      if(markerBuffer.length>8192)markerBuffer=markerBuffer.slice(-8192);
    };
    try {
      result=await runProcessV1({
        command:process.execPath,
        args:['scripts/lite-solo-cloudflare-runtime-v1/packages/github-native-sim/src/v7-cli.mjs','execute','--request',requestAbs,'--evidence-dir',evAbs,'--workspace',workspace,'--compact-raw-result'],
        cwd:process.cwd(),
        env:{...process.env,PHASE5_BOUNDARY_PROGRESS:'true',PHASE5_CONTROLLER_ROOT:path.resolve(controllerRoot)},
        timeoutMs:candidateTimeoutMs,
        // Phase-5 retains the canonical raw-result.json as evidence. The
        // child stdout/stderr are diagnostics only; cap both at 128 KiB.
        maxStdoutBytes:128*1024,
        maxStderrBytes:128*1024,
        onStderr:relayProgress
      });
    } finally {
      clearInterval(heartbeat);
    }
    process.stderr.write(`[phase5-sim] END ${key} exitCode=${result?.exitCode??'UNKNOWN'} signal=${result?.signal??'NONE'} elapsed=${Math.floor((Date.now()-startedAt)/1000)}s${result?.timedOut?' TIMED_OUT':''} stdoutBytes=${result?.stdoutBytes??'UNKNOWN'} stderrBytes=${result?.stderrBytes??'UNKNOWN'} stdoutTruncated=${Boolean(result?.stdoutTruncated)} stderrTruncated=${Boolean(result?.stderrTruncated)}\n`);
    // V7 CLI nests evidence under the request ID; the parent directory has no
    // raw-result.json. Never issue PASS for a missing or unparsable raw result.
    const request=JSON.parse(fs.readFileSync(requestAbs,'utf8'));
    const requestId=request.requestId;
    const validId=typeof requestId==='string'&&/^dar-[0-9a-f]{32}$/.test(requestId);
    const rawPath=validId?path.join(evAbs,requestId,'raw-result.json'):null;
    let rawResult=null;
    try{if(rawPath)rawResult=readV7RawResultV1(rawPath);}catch{}
    executionResults[key]={
      status:result.exitCode===0&&rawResult?'PASS':(rawResult?.blocking?'BLOCKED':'INCONCLUSIVE'),
      exitCode:result.exitCode,
      evidenceRef:validId?path.posix.join(evRel,requestId,'raw-result.json'):'NO_MACHINE_EVIDENCE',
      requestBindingStatus:binding.status,
      requestBindingEvidenceRef:binding.requestRef,
      requestBindingReasons:binding.reasons,
      rawResult,
      stdout:String(result.stdout??'').slice(-12000),
      stderr:String(result.stderr??'').slice(-12000),
      signal:result.signal??null,
      timedOut:Boolean(result.timedOut),
      stdoutBytes:result.stdoutBytes??null,
      stderrBytes:result.stderrBytes??null,
      stdoutTruncated:Boolean(result.stdoutTruncated),
      stderrTruncated:Boolean(result.stderrTruncated)
    };
    // V7's candidate workspace is scratch only. Persisted machine evidence
    // lives under the distinct controller evidence path (evAbs). Removing
    // scratch before the next candidate prevents seven Foundry/Anvil build
    // trees from accumulating on the same GitHub-hosted runner.
    fs.rmSync(workspace,{recursive:true,force:true});
  }
  // All covering runs are finished before an omitted duplicate receives
  // an inherited evidence reference. The gate separately verifies identity.
  for(const target of arr(targetDesigns)){
    if(target?.executionMethod!=='NOT_APPLICABLE')continue;
    const key=String(target.candidateKey??'').trim();
    const coveredKey=target.notApplicableDisposition?.coveredByCandidateKey;
    if(executionResults[key]&&executionResults[coveredKey]?.evidenceRef){
      executionResults[key].evidenceRef=executionResults[coveredKey].evidenceRef;
    }
  }
  return executionResults;
}

export function renderRemediationDeltaLedgerV1({validatedFindings=[],deltaRows=[],noRemediation=false}={}){
  const rows=[];
  for(const d of arr(deltaRows)){
    rows.push(`| ${md(d.findingId)} | ${md(d.oldIdentityRef)} | ${md(d.remediationIdentityRef)} | ${md(d.changedFilesAndSymbols)} | ${md(d.rootCauseFix??'PENDING_PHASE9_INTERPRETATION')} | ${md(d.staleEvidenceInvalidated)} | ${md(d.decisiveProofRerun??'PENDING_PHASE9')} | ${md(d.affectedSurfaces)} | ${md(d.newEvidenceRefs)} | ${md(d.residualRisk??'PENDING_PHASE9_INTERPRETATION')} | ${md(d.finalDisposition??'PENDING_PHASE9_INTERPRETATION')} |`);
  }
  if(!rows.length&&!noRemediation){
    for(const f of arr(validatedFindings)){
      rows.push(`| ${md(f.findingTempKey??f.canonicalId??f.candidateKey)} | SEE_CANONICAL_PRE_REMEDIATION_IDENTITY | REMEDIATION_ARTIFACT_PRESENT_DELTA_UNRESOLVED | MACHINE_DELTA_UNAVAILABLE | PENDING_PHASE9_INTERPRETATION | INSUFFICIENT_EVIDENCE | PENDING_PHASE9 | UNRESOLVED | NO_NEW_EVIDENCE | UNRESOLVED | UNRESOLVED |`);
    }
  }
  if(!rows.length) rows.push('| NONE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE | NOT_APPLICABLE |');

  return `# Phase 9 Remediation Delta Ledger

> **CONTROLLER-POPULATED:** Generated at the Phase-8 boundary when remediation artifacts exist, using exact machine-derived pre/post-remediation comparison and accepted Phase-8 findings. The Phase-9 reviewer consumes this ledger and records semantic remediation assessment in the Phase-9 work form.

| Finding ID | Old identity | Remediation identity | Changed files/symbols | Root-cause fix | Stale evidence invalidated | Decisive proof rerun | Directly affected surfaces reviewed | New evidence identities | Residual risk | Final disposition |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## No-remediation path
- \`SKIPPED_NO_REMEDIATION\`: ${noRemediation?'YES':'NO'}
- Evidence-bound reason: ${noRemediation?'No remediation artifacts exist in canonical campaign state.':'Remediation artifacts detected; see rows above.'}
- Findings still open and their dispositions: ${noRemediation?md(arr(validatedFindings).map(f=>f.findingTempKey??f.canonicalId??f.candidateKey)):'SEE_PHASE8_ACCEPTED_FINDINGS'}

## Release-delta reconciliation
- Unrelated changes detected: PENDING_MACHINE_DELTA_OR_NONE
- Source-bound evidence requiring broader invalidation/re-execution: SEE_CONTROLLER_EVIDENCE_INVALIDATION_STATE
- New candidate issues introduced by remediation: PENDING_PHASE9_INTERPRETATION
`;
}

export function renderFinalEvidenceIndexV1({identity={},milestones=[],findings=[],obligations=[],limitations=[],omissions=[]}={}){
  const milestoneRows=arr(milestones).map(m=>`| ${md(m.milestone)} | ${md(m.requiredEvidence)} | ${md(m.reference)} | ${md(m.sourceIdentity)} | ${md(m.status)} | ${md(m.limitation)} |`);
  const findingRows=[
    ...arr(findings).map(f=>`| ${md(f.id)} | ${md(f.disposition)} | ${md(f.severityOrStatus)} | ${md(f.evidence)} | ${md(f.remediationStatus)} | ${md(f.residualLimitation)} |`),
    ...arr(obligations).map(o=>`| ${md(o.id)} | ${md(o.disposition)} | ${md(o.severityOrStatus)} | ${md(o.evidence)} | ${md(o.remediationStatus)} | ${md(o.residualLimitation)} |`)
  ];
  if(!milestoneRows.length) milestoneRows.push('| NONE | NONE_IDENTIFIED | NONE_IDENTIFIED | NONE_IDENTIFIED | UNRESOLVED | NONE_IDENTIFIED |');
  if(!findingRows.length) findingRows.push('| NONE | NONE_IDENTIFIED | NONE_IDENTIFIED | NONE_IDENTIFIED | NOT_APPLICABLE | NONE_IDENTIFIED |');
  const limitationText=arr(limitations).length?arr(limitations).map(x=>`- ${md(x)}`).join('\n'):'- NONE_IDENTIFIED';
  const omissionText=arr(omissions).length?arr(omissions).map(x=>`- ${md(x)}`).join('\n'):'- NONE_IDENTIFIED';

  return `# Lite Final Evidence Index

> **CONTROLLER-GENERATED FINAL SUMMARY:** This file is the intentional summary exception to the no-duplication rule. The controller populates it from canonical campaign state, accepted phase data and machine evidence before Phase 10 begins. The Phase-10 reviewer consumes it as the final evidence/navigation view and does not repeat predecessor bookkeeping.

## Exact identities

- Campaign/generation: ${md(identity.campaignGeneration)}
- Lite skill ZIP identity/digest: ${md(identity.skill)}
- Source ZIP/repository/commit/digest: ${md(identity.source)}
- Dependency lock/toolchain/build artifact identity: ${md(identity.build)}
- Deployment/configuration simulation identity: ${md(identity.deployment)}
- Remediation identity or \`SKIPPED_NO_REMEDIATION\`: ${md(identity.remediation??'SKIPPED_NO_REMEDIATION')}

## Milestone evidence

| Milestone | Required evidence | Exact reference/digest | Source identity | Status | Limitation |
|---|---|---|---|---|---|
${milestoneRows.join('\n')}

## Findings and obligations

| ID | Final disposition | Severity/status | Decisive evidence | Remediation status | Residual limitation |
|---|---|---|---|---|---|
${findingRows.join('\n')}

## Carried limitations and unresolved questions

${limitationText}

## Full-only omitted work

${omissionText}

Omission is never evidence of safety.
`;
}
