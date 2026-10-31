import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {migrateLegacyCapabilityV2,CAPABILITY_CONTRACT_VERSION_V2} from './phase0-execution-contract-v2.mjs';

const POLICY='ALL_EVM_PACKAGES_USE_CANONICAL_ETHEREUM_ANVIL_BASELINE';
const WORKFLOWS=new Set(['.github/workflows/lite-phase0-randomized-simulation-v1.yml']);
function requireThat(value,message){if(!value)throw new Error('PHASE0_COMPLETED_STAGE_REJECTED: '+message);}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
function safeRef(root,ref){
  requireThat(typeof ref==='string'&&!path.isAbsolute(ref)&&!ref.split(/[\\/]/).includes('..'),'unsafe evidence reference');
  const file=path.resolve(root,ref);requireThat(file.startsWith(path.resolve(root)+path.sep),'reference escapes evidence root');return file;
}
export function validateCompletedPhase0StageV1({stage,source,run,expected,summary,index}){
  requireThat(['MEDUSA','TELEMETRY'].includes(stage),'unknown stage');
  requireThat(run.status==='completed'&&run.conclusion==='success','workflow did not succeed');
  requireThat(Number(run.id)===Number(expected.runId)&&run.head_sha===expected.headSha,'workflow identity mismatch');
  requireThat(WORKFLOWS.has(run.path),'unadmitted workflow');
  requireThat(summary.status==='PASS'&&summary.campaignId===source.campaignId,'summary identity/status mismatch');
  requireThat(index.sourceIdentity?.campaignId===source.campaignId&&index.sourceIdentity?.sourceSha256===source.sourceSha256,'source mismatch');
  requireThat(index.executionNormalization?.policy===POLICY,'normalization mismatch');
  requireThat(index.policy?.realAbiCallsOnly===true&&index.policy.rawRandomBytes===false&&index.policy.crossContractBursts===true&&Number(index.policy.accountingActionWeight)>=0.8,'policy mismatch');
  const fork=index.fork;
  requireThat(fork?.engine==='anvil'&&Number(fork.chainId)===1&&Number.isSafeInteger(fork.baselineBlock)&&/^0x[0-9a-fA-F]{64}$/.test(fork.baselineBlockHash??''),'unbound Anvil fork');
  const deployment=summary.deployment;
  requireThat(deployment?.status==='PASS'&&Number(deployment.coverage?.sourcePlanUnresolved)===0&&Number(deployment.coverage?.sourceKnownMissingTargets)===0,'incomplete deployment');
  const contracts=deployment.deployedContracts??[];
  requireThat(contracts.length>0&&Number(deployment.coverage.mutableTargets)>0,'no deployed mutable targets');
  const admitted=new Set(source.qualifiedNames);
  for(const target of contracts)requireThat(admitted.has(target.qualifiedName)&&/^0x[0-9a-fA-F]{40}$/.test(target.address??''),'unknown compiled target');
  if(stage==='MEDUSA'){
    const m=summary.medusa;
    requireThat(m?.status==='PASS'&&m.exitCode===0&&Number(m.observedCalls)>=100001&&m.rawRandomBytes===false,'Medusa incomplete');
    requireThat(Number(m.accountingWrapperShare)>=0.8,'Medusa accounting weight');
    requireThat((m.targetContracts??[]).length>0,'Medusa targets absent');
    for(const target of m.targetContracts)requireThat(contracts.some(c=>c.qualifiedName===target.qualifiedName&&c.address.toLowerCase()===target.address.toLowerCase()),'Medusa target not deployed');
  }else{
    requireThat(summary.telemetry?.length===4,'telemetry requires four shards');
    const ids=new Set();
    for(const t of summary.telemetry){
      requireThat(!ids.has(t.runId),'duplicate telemetry shard');ids.add(t.runId);
      requireThat(t.status==='PASS'&&Number(t.calls)===1200&&Number(t.errors)===0,'telemetry incomplete');
      requireThat(Number(t.accountingFunctionCount)>0?Number(t.accountingActionShare)>=0.8:t.weightingLimitation==='NO_ACCOUNTING_STATE_CHANGE_FUNCTIONS_DETECTED','telemetry accounting weight');
    }
  }
  return {stage,workflowRunId:Number(run.id),headSha:run.head_sha,workflow:run.path,fork:structuredClone(fork),deployment:structuredClone(deployment)};
}

async function api(repository,endpoint,token){
  const response=await fetch('https://api.github.com/repos/'+repository+'/'+endpoint,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
  requireThat(response.ok,'GitHub metadata HTTP '+response.status);
  return response.json();
}
async function download(repository,artifactId,token){
  const first=await fetch('https://api.github.com/repos/'+repository+'/actions/artifacts/'+artifactId+'/zip',{headers:{Authorization:'Bearer '+token},redirect:'manual'});
  let response=first;
  if(first.status===302){
    const location=first.headers.get('location');requireThat(location?.startsWith('https://'),'artifact redirect');
    response=await fetch(location);
  }
  requireThat(response.ok,'artifact download HTTP '+response.status);
  return Buffer.from(await response.arrayBuffer());
}
function extract(zip,destination){
  execFileSync('python3',['-c',[
    'import zipfile,sys,pathlib,stat',
    'z=zipfile.ZipFile(sys.argv[1]); entries=z.infolist()',
    'assert len(entries)<50000 and sum(i.file_size for i in entries)<268435456',
    'names=set()',
    'for i in entries:',
    ' p=pathlib.PurePosixPath(i.filename)',
    ' assert not p.is_absolute() and ".." not in p.parts and "\\\\" not in i.filename',
    ' assert i.filename not in names; names.add(i.filename)',
    ' assert not stat.S_ISLNK(i.external_attr>>16)',
    'z.extractall(sys.argv[2])'
  ].join('\n'),zip,destination],{stdio:'pipe'});
}
export async function importCompletedPhase0StagesV1({controllerRoot,campaignPath,manifestPath,outputRoot,repository,githubToken}){
  requireThat(githubToken&&/^[\w.-]+\/[\w.-]+$/.test(repository??''),'GitHub credentials/repository missing');
  requireThat(campaignPath.startsWith('campaigns/')&&!campaignPath.split('/').includes('..'),'campaign path');
  const root=safeRef(controllerRoot,campaignPath);
  const receipt=await json(path.join(root,'receipts/PHASE_00_RECEIPT_v1.json'));
  const manifest=await json(safeRef(root,manifestPath));
  requireThat(manifest.schemaVersion==='curveyield-phase0-completed-stages-v1','manifest schema');
  requireThat(manifest.campaignId===receipt.campaign.campaignId&&manifest.campaignGenerationId===receipt.campaign.campaignGenerationId&&manifest.sourceSha256===receipt.source.sha256,'manifest campaign/source fence');
  requireThat(digest(await fs.readFile(safeRef(controllerRoot,receipt.source.archivePath)))===receipt.source.sha256,'archive changed');
  const buildBytes=await fs.readFile(path.join(root,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'));
  const build=JSON.parse(buildBytes);
  requireThat(build.status==='PASS'&&build.source.archiveSha256Observed===receipt.source.sha256,'build/source mismatch');
  const bundle=await json(path.join(root,'evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json'));
  requireThat(bundle.identity.sourceDigestSha256===receipt.source.sha256,'bundle/source mismatch');
  const siBytes=await fs.readFile(safeRef(root,bundle.core.latestAcceptedRevision));
  requireThat(bundle.core.status==='ACCEPTED'&&digest(siBytes)===bundle.core.acceptedSha256,'accepted source intelligence changed');
  requireThat(digest(buildBytes)===bundle.identity.buildDigestSha256,'accepted build identity changed');
  const si=JSON.parse(siBytes);
  const source={campaignId:receipt.campaign.campaignId,sourceSha256:receipt.source.sha256,qualifiedNames:(si.compilerArtifacts??[]).map(x=>x.qualifiedName)};
  requireThat(source.qualifiedNames.length>0,'compiled target inventory absent');
  requireThat(manifest.stages?.length===2&&new Set(manifest.stages.map(s=>s.stage)).size===2,'requires distinct Medusa and telemetry stages');
  await fs.rm(outputRoot,{recursive:true,force:true});await fs.mkdir(path.join(outputRoot,'runs'),{recursive:true});
  const accepted=[];
  for(const entry of manifest.stages){
    requireThat(Number.isSafeInteger(entry.runId)&&Number.isSafeInteger(entry.artifactId)&&/^[a-f0-9]{40}$/.test(entry.headSha??'')&&/^[a-f0-9]{64}$/.test(entry.zipSha256??''),'stage metadata');
    const run=await api(repository,'actions/runs/'+entry.runId,githubToken);
    const artifact=await api(repository,'actions/artifacts/'+entry.artifactId,githubToken);
    requireThat(!artifact.expired&&Number(artifact.workflow_run?.id)===entry.runId&&artifact.workflow_run?.head_sha===entry.headSha,'artifact belongs to another run');
    requireThat(artifact.digest==='sha256:'+entry.zipSha256,'GitHub artifact digest mismatch');
    const bytes=await download(repository,entry.artifactId,githubToken);
    requireThat(digest(bytes)===entry.zipSha256,'download digest mismatch');
    const attemptRoot=path.join(outputRoot,'retained-attempts',entry.stage.toLowerCase());
    await fs.mkdir(attemptRoot,{recursive:true});
    const zipPath=path.join(attemptRoot,'ORIGINAL_STAGE_ARTIFACT_v1.zip');
    await fs.writeFile(zipPath,bytes);
    const extracted=path.join(attemptRoot,'original');extract(zipPath,extracted);
    const summary=await json(path.join(extracted,'PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json'));
    const index=await json(path.join(extracted,'PHASE0_SIMULATION_RUN_INDEX_v1.json'));
    const provenance=validateCompletedPhase0StageV1({stage:entry.stage,source,run,expected:entry,summary,index});
    requireThat(Number(summary.deployment.sourceKnownCompilation?.compiledArtifacts)===Number(build.build.artifactCount),'compiled inventory count mismatch');
    const deploy=await json(path.join(extracted,'PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'));
    requireThat(JSON.stringify(deploy.deployedContracts)===JSON.stringify(summary.deployment.deployedContracts),'deployment evidence mismatch');
    const binding={...provenance,artifactId:entry.artifactId,zipSha256:entry.zipSha256,sourceSha256:source.sourceSha256,buildIdentitySha256:digest(buildBytes),acceptedCompilerInventorySha256:digest(JSON.stringify(si.compilerArtifacts)),originalArtifactRef:'retained-attempts/'+entry.stage.toLowerCase()+'/ORIGINAL_STAGE_ARTIFACT_v1.zip'};
    await fs.writeFile(path.join(attemptRoot,'STAGE_PROVENANCE_v1.json'),JSON.stringify(binding,null,2)+'\n');
    if(entry.stage==='MEDUSA'){
      const m=summary.medusa,raw=await fs.readFile(safeRef(extracted,m.rawOutputRef),'utf8');
      const values=[...raw.replace(/\x1b\[[0-9;]*m/g,'').matchAll(/(?:calls|call count)\s*[:=]\s*([\d,]+)/ig)].map(x=>Number(x[1].replaceAll(',','')));
      // Retained Medusa console output reports "calls: N" at completion.
      requireThat(values.some(n=>n===Number(m.observedCalls)),'observed Medusa calls not backed by raw output');
      await fs.cp(path.join(extracted,'runs',m.runId),path.join(outputRoot,'runs',m.runId),{recursive:true});
    }else{
      const deployed=new Map(deploy.deployedContracts.map(d=>[d.address.toLowerCase(),d.qualifiedName]));
      for(const t of summary.telemetry){
        const raw=await fs.readFile(safeRef(extracted,t.rawTranscriptRef),'utf8');
        const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
        requireThat(rows.length===Number(t.calls),'transcript count mismatch');
        let accounting=0,successes=0,reverts=0,errors=0;
        for(let i=0;i<rows.length;i++){
          const r=rows[i];
          requireThat(r.runId===t.runId&&r.callIndex===i+1&&r.abiGenerated===true&&r.rawRandomBytes===false&&r.beforeAccounting&&r.afterAccounting&&r.accountingDeltas,'invalid raw ABI telemetry row');
          requireThat(deployed.get(r.target?.address?.toLowerCase())===r.target?.qualifiedName,'transcript target not deployed');
          if(r.actionClass==='ACCOUNTING_STATE_CHANGE')accounting++;
          if(r.error){if(r.error.code==='CALL_EXCEPTION'||/revert/i.test(String(r.error.shortMessage??r.error.message??'')))reverts++;else errors++;}
          else if(r.transaction?.status===1||r.transaction?.status==='1')successes++;
        }
        requireThat(accounting===Number(t.accountingActions),'raw accounting count mismatch');
        requireThat(successes===Number(t.successes)&&reverts===Number(t.reverts)&&errors===Number(t.errors),'raw terminal counters mismatch');
        const runSummary=await json(safeRef(extracted,'runs/'+t.runId+'/RUN_SUMMARY_v1.json'));
        requireThat(digest(Buffer.from(raw))===runSummary.rawTranscriptSha256,'raw transcript digest mismatch');
        for(const key of ['calls','accountingActions','successes','reverts','errors','status'])requireThat(runSummary[key]===t[key],'shard summary mismatch '+key);
        await fs.cp(path.join(extracted,'runs',t.runId),path.join(outputRoot,'runs',t.runId),{recursive:true});
      }
    }
    accepted.push({summary,index,deploy,binding});
  }
  const m=accepted.find(x=>x.binding.stage==='MEDUSA'),t=accepted.find(x=>x.binding.stage==='TELEMETRY');
  requireThat(m&&t,'missing stage');
  const names=x=>x.deploy.deployedContracts.map(d=>d.qualifiedName).sort().join('\n');
  requireThat(names(m)===names(t),'stages executed different contract inventories');
  const stageRef=x=>({workflowRunId:x.binding.workflowRunId,artifactId:x.binding.artifactId,provenanceRef:'retained-attempts/'+x.binding.stage.toLowerCase()+'/STAGE_PROVENANCE_v1.json',fork:x.binding.fork});
  const medusa={...m.summary.medusa,executionProvenance:stageRef(m)};
  const telemetry=t.summary.telemetry.map(x=>({...x,executionProvenance:stageRef(t)}));
  const index={...t.index,fork:null,executionMode:'REUSED_COMPLETED_STAGES',forkSemantics:'INDEPENDENT_STAGE_ATTEMPTS_NO_SHARED_EPHEMERAL_STATE',stageExecutions:accepted.map(x=>x.binding),runs:[...m.index.runs.map(x=>({...x,executionProvenance:stageRef(m)})),...t.index.runs.map(x=>({...x,executionProvenance:stageRef(t)}))]};
  const legacyCapability=migrateLegacyCapabilityV2({...t.summary,medusa,telemetry});
  const summary={...t.summary,...legacyCapability,capabilityContractVersion:CAPABILITY_CONTRACT_VERSION_V2,status:'LEGACY_LIMITED',executionMode:'REUSED_COMPLETED_STAGES',sourceIdentity:index.sourceIdentity,medusa:{...medusa,legacyDisposition:'LEGACY_LIMITED',checkStatus:'NO_PROPERTY_ASSURANCE'},telemetry:telemetry.map(x=>({...x,legacyDisposition:'LEGACY_LIMITED',observationStatus:'LEGACY_INADEQUATE'})),stageExecutions:accepted.map(x=>x.binding),baselineTargetDispositions:[...m.summary.baselineTargetDispositions.filter(x=>x.candidateKey==='PHASE0-BASELINE-MEDUSA'),...t.summary.baselineTargetDispositions.filter(x=>x.candidateKey==='PHASE0-BASELINE-ABI-TELEMETRY')],limitations:[...(m.summary.limitations??[]),...(t.summary.limitations??[]),{type:'INDEPENDENT_STAGE_FORKS',detail:'Medusa and telemetry preserve their original forks and addresses; no stage was rerun.',stageExecutions:accepted.map(x=>stageRef(x))},{type:'LEGACY_STAGE_TARGET_BYTECODE_DIGESTS_NOT_RECORDED',detail:'Stage acceptance binds exact source, accepted build/compiler inventory, successful workflow commit, deployment mapping and original raw artifact. Per-target runtime bytecode digests were not recorded in these original attempts.'},{type:'LEGACY_V1_CAPABILITY_LIMITATION',detail:'Retained quantity-only Medusa/telemetry evidence is preserved but cannot satisfy v2 property, lifecycle, reachability, or observation gates.'}]};
  const deploy={...t.deploy,stageExecutions:accepted.map(x=>x.binding)};
  for(const [name,value] of [['PHASE0_RANDOMIZED_SIMULATION_SUMMARY_v1.json',summary],['PHASE0_SIMULATION_RUN_INDEX_v1.json',index],['PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',deploy]])await fs.writeFile(path.join(outputRoot,name),JSON.stringify(value,null,2)+'\n');
  return {summary,runIndex:index,deployEvidence:deploy};
}
