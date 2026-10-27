import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {stageExactArchiveSource} from '../packages/github-native-sim/src/execution.mjs';
import {materializePhase6HarnessOverlayV1} from '../packages/github-native-sim/src/phase6-harness-overlay-v1.mjs';
import {createPhase6MutableRpcSession} from '../packages/github-native-sim/src/phase6-mutable-rpc-v1.mjs';

const source={
  repository:'curveyield3/Audit-Controller',
  commit:'b66ee2b336c949c3ecb0621307b9c188f8f81e89',
  archivePath:'campaigns/audit-preview-live-ethereum-Dai-6b175474 r1/source/live-ethereum-Dai-6b175474.zip',
  projectPath:'campaigns/audit-preview-live-ethereum-Dai-6b175474 r1/source/live-scan-project',
  archiveSha256:'1c384141058f50d53b9e58b89c0b83aa60bd1066406f017d177121de332705f2'
};
const pin={
  chainId:1,blockNumber:26283885,
  blockHash:'0xe9a7c98f604a48f1b8885578ec8f54e73ec33e9f34cc5161c049a59640b6eab5',
  address:'0x6b175474e89094c44da98b954eedeac495271d0f',
  qualifiedName:'Dai.sol:Dai',
  runtimeSha256:'5ce810033426a017721777f241665c27bdd4663ca8a1c27558b4b372a1731f4e'
};
const obligations=['BOB-0001','BOB-0002','BOB-0003','BOB-0004','BOB-0005','BOB-0007','BOB-0008'];
const output=path.resolve('.dai-direct-evidence');
await fs.mkdir(output,{recursive:true});
const evidence={
  schemaVersion:'dai-live-mutating-anvil-direct-security-evidence-v1',
  campaignId:'audit-preview-completion-live-ethereum-dai-6b175474-r1',
  kind:'DIRECT_SOURCE_BOUND_FOUNDRY_EVIDENCE',
  notV7Qualification:true,
  immutableSealedReceiptsChanged:false,
  source,pin,runnerCommit:process.env.GITHUB_SHA??null,
  githubRunId:process.env.GITHUB_RUN_ID??null,
  obligations:Object.fromEntries(obligations.map(x=>[x,{status:'NOT_EXECUTED'}])),
  status:'EXECUTION_NOT_STARTED',
  startedAt:new Date().toISOString()
};
let session=null;
async function runForge(cwd, url) {
  const args=['test','--root',cwd,'--match-contract','DAILiveForkSecurityV1','--fork-url',url,
    '--fork-block-number',String(pin.blockNumber),'--fuzz-runs','256','--json'];
  const cp=spawn('forge',args,{cwd,env:{...process.env,ETH_RPC_URL:url},
    stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  const cap=12*1024*1024;
  cp.stdout.on('data',x=>{stdout=(stdout+x.toString()).slice(-cap);});
  cp.stderr.on('data',x=>{stderr=(stderr+x.toString()).slice(-cap);});
  const exit=await new Promise((resolve,reject)=>{
    cp.once('error',reject);
    cp.once('close',(code,signal)=>resolve({code,signal}));
    setTimeout(()=>cp.kill('SIGKILL'),20*60*1000).unref();
  });
  await fs.writeFile(path.join(output,'forge-raw-stdout.txt'),stdout);
  await fs.writeFile(path.join(output,'forge-raw-stderr.txt'),stderr);
  return {...exit,stdout,stderr};
}
function decodeForgeReports(stdout) {
  const possibilities=[stdout.trim(),...stdout.split('\n').filter(x=>x.trim().startsWith('{'))];
  const reports=[];
  for(const part of possibilities){
    try{
      const json=JSON.parse(part);
      if(json&&typeof json==='object'){
        for(const suite of Object.values(json)){
          if(suite?.test_results&&typeof suite.test_results==='object')
            for(const [name,result] of Object.entries(suite.test_results))
              reports.push({name,status:result.status,reason:result.reason??null});
        }
        if(reports.length)break;
      }
    }catch{}
  }
  return reports;
}
try{
  if(!process.env.ETHEREUM_FORK_RPC_URL)
    throw Error('ARCHIVE_RPC_SECRET_NOT_CONFIGURED');
  const checkoutRoot=path.resolve('.audit-controller');
  const archive=await stageExactArchiveSource({
    checkoutRoot,workspaceRoot:path.resolve('.dai-direct-work'),...source
  });
  evidence.sourceVerified={archiveSha256:archive.archiveSha256,projectRootFound:true,
    entryCount:archive.entryCount};
  const overlay=await materializePhase6HarnessOverlayV1({
    projectRoot:archive.projectRoot,runnerRoot:process.cwd(),
    bundleId:'dai-live-mainnet-r1-phase8-v1',source
  });
  evidence.harness={bundleId:overlay.bundleId,overlayDigestSha256:overlay.overlayDigestSha256,
    files:overlay.files.map(x=>({destination:x.destination,sha256:x.sha256,
      reusedUnchangedSourceConfig:x.reusedUnchangedSourceConfig??false}))};
  session=await createPhase6MutableRpcSession({environment:process.env,
    frozenBlockNumber:pin.blockNumber,frozenBlockHash:pin.blockHash,
    attestedTargets:[{address:pin.address,qualifiedName:pin.qualifiedName,
      runtimeSha256:pin.runtimeSha256}]});
  const attest=session.evidence?.deployedTargetAttestation;
  if(session.evidence?.status!=='PASS'||!session.runtime?.url||attest?.status!=='PASS'
    ||attest?.mutableWriteObserved!==true||attest?.snapshotReverted!==true)
    throw Error('MUTABLE_FORK_PROOF_NOT_PASS: '+String(session.evidence?.failureKind??'missing fork proof'));
  if(session.runtime.blockNumber!==pin.blockNumber
    ||session.runtime.blockHash?.toLowerCase()!==pin.blockHash)
    throw Error('FORK_PIN_IDENTITY_MISMATCH');
  evidence.fork={status:'PASS',engine:'anvil',chainId:1,blockNumber:session.runtime.blockNumber,
    blockHash:session.runtime.blockHash,
    deployedRuntimeSha256:attest.targets[0].runtimeSha256,
    localMutationProved:attest.mutableWriteObserved,snapshotRollbackProved:attest.snapshotReverted,
    upstreamUrlExposed:false};
  const forge=await runForge(archive.projectRoot,session.runtime.url);
  evidence.forgeExitCode=forge.code;
  evidence.forgeSignal=forge.signal;
  const tests=decodeForgeReports(forge.stdout);
  evidence.discoveredTestCount=tests.length;
  evidence.discoveredTests=tests;
  for(const id of obligations){
    const matching=tests.filter(x=>x.name.includes(id.replace('-','_')));
    evidence.obligations[id]=matching.length===1
      ? {status:matching[0].status==='Success'?'PASS':'FAIL',testName:matching[0].name,
         reason:matching[0].reason}
      : {status:'MISSING_OR_DUPLICATE_TEST_EVIDENCE',matches:matching.length};
  }
  evidence.status=forge.code===0&&obligations.every(x=>evidence.obligations[x].status==='PASS')
    ? 'SEVEN_BASELINE_ASSERTIONS_PASSED':'EXECUTION_INCOMPLETE_OR_ASSERTION_FAILURE';
}catch(error){
  evidence.executionError={name:error?.name??'Error',message:String(error?.message??error).slice(0,1200)};
  if(evidence.status==='EXECUTION_NOT_STARTED')evidence.status='INFRASTRUCTURE_OR_HARNESS_BLOCKED';
}finally{
  if(session?.close)await session.close().catch(()=>{});
  evidence.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(output,'DAI_DIRECT_FORK_SECURITY_EVIDENCE_v1.json'),
    JSON.stringify(evidence,null,2)+'\n');
  console.log('DAI_DIRECT_EVIDENCE_RESULT='+evidence.status);
  console.log('DAI_DIRECT_EVIDENCE_OBLIGATIONS='+JSON.stringify(evidence.obligations));
  if(evidence.executionError)console.error('DAI_DIRECT_EVIDENCE_ERROR='+evidence.executionError.message);
  if(evidence.status!=='SEVEN_BASELINE_ASSERTIONS_PASSED')process.exitCode=1;
}
