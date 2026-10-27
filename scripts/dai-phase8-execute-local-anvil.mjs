import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createPhase6MutableRpcSession} from '../packages/github-native-sim/src/phase6-mutable-rpc-v1.mjs';

const BLOCK = 26283885;
const BLOCK_HASH = '0xe9a7c98f604a48f1b8885578ec8f54e73ec33e9f34cc5161c049a59640b6eab5';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const RUNTIME_SHA256 = '5ce810033426a017721777f241665c27bdd4663ca8a1c27558b4b372a1731f4e';
const SOURCE_COMMIT = 'b66ee2b336c949c3ecb0621307b9c188f8f81e89';
const SOURCE_ARCHIVE_SHA256 = '1c384141058f50d53b9e58b89c0b83aa60bd1066406f017d177121de332705f2';
const OBLIGATIONS=['BOB-0001','BOB-0002','BOB-0003','BOB-0004','BOB-0005','BOB-0007','BOB-0008'];
const OUTPUT=path.resolve('process/dai-phase8-evidence/attempt-'+String(process.env.DAI_EVIDENCE_ATTEMPT||'2'));
const PROJECT=path.resolve('.dai-phase8-work');
fs.mkdirSync(OUTPUT,{recursive:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const redaction=text=>String(text??'').replaceAll(process.env.ETHEREUM_FORK_RPC_URL||'__UNSET_RPC__','<redacted-upstream-rpc>');
const now=()=>new Date().toISOString();
const evidence={
  schemaVersion:'dai-live-fork-baseline-execution-evidence-v1',
  campaignId:'audit-preview-completion-live-ethereum-dai-6b175474-r1',
  source:{repository:'curveyield3/Audit-Controller',commit:SOURCE_COMMIT,archiveSha256:SOURCE_ARCHIVE_SHA256},
  target:{chainId:1,address:DAI,blockNumber:BLOCK,blockHash:BLOCK_HASH,runtimeSha256:RUNTIME_SHA256,
    existingDeployedContract:true,redeploymentAllowed:false},
  runner:{repository:'curveyield3/Contract-Automation',commit:process.env.GITHUB_SHA||'LOCAL',
    workflowRunId:process.env.GITHUB_RUN_ID||null,qualificationInvoked:false},
  startedAt:now(),fork:null,forge:null,obligations:[],status:'NOT_EXECUTED',errors:[]
};
const evidencePath=path.join(OUTPUT,'BOB_EXECUTION_EVIDENCE_v1.json');
function save(){evidence.finishedAt=now();fs.writeFileSync(evidencePath,JSON.stringify(evidence,null,2)+'\n');}
function extractTestResults(text){
  let obj;
  try{obj=JSON.parse(text.trim());}
  catch{
    const at=text.indexOf('{'),end=text.lastIndexOf('}');
    if(at<0||end<=at)throw Error('FORGE_JSON_RESULT_UNPARSEABLE');
    obj=JSON.parse(text.slice(at,end+1));
  }
  const found=[];
  function scan(node,depth=0){
    if(depth>15||!node||typeof node!=='object')return;
    if(!Array.isArray(node)&&node.test_results&&typeof node.test_results==='object'){
      for(const [name,result] of Object.entries(node.test_results)){
        found.push({name,status:String(result?.status??'UNKNOWN'),reason:result?.reason??null,
          counterexample:result?.counterexample??null,gasUsed:result?.gas_used??null});
      }
    }
    for(const [key,v] of Object.entries(node)){
      if(key==='test_results')continue;
      if(v&&typeof v==='object')scan(v,depth+1);
    }
  }
  scan(obj);
  return found;
}
let session=null;
try{
  if(!process.env.ETHEREUM_FORK_RPC_URL)throw Error('ARCHIVE_RPC_NOT_CONFIGURED');
  const sourceFile=path.join(PROJECT,'contracts','Dai.sol');
  const harnessFile=path.join(PROJECT,'test','phase6','DAILiveForkSecurityV1.t.sol');
  if(!fs.existsSync(sourceFile)||!fs.existsSync(harnessFile)
    ||!fs.existsSync(path.join(PROJECT,'foundry.toml')))throw Error('PINNED_SOURCE_OR_HARNESS_NOT_STAGED');
  const source=fs.readFileSync(sourceFile),harness=fs.readFileSync(harnessFile);
  evidence.source.soliditySha256=digest(source);
  evidence.runner.harnessSha256=digest(harness);
  if(!/contract\s+Dai\s+is\s+LibNote/.test(source.toString('utf8'))
    ||!harness.toString('utf8').toLowerCase().includes(DAI.toLowerCase()))throw Error('SOURCE_OR_HARNESS_IDENTITY_INVALID');
  session=await createPhase6MutableRpcSession({
    environment:process.env,frozenBlockNumber:BLOCK,frozenBlockHash:BLOCK_HASH,
    attestedTargets:[{address:DAI,qualifiedName:'Dai.sol:Dai',runtimeSha256:RUNTIME_SHA256}]
  });
  evidence.fork=session.evidence;
  if(session.evidence?.status!=='PASS'||session.evidence.deployedTargetAttestation?.status!=='PASS'
    ||session.evidence.deployedTargetAttestation.mutableWriteObserved!==true
    ||session.evidence.deployedTargetAttestation.snapshotReverted!==true
    ||session.runtime?.blockNumber!==BLOCK
    ||String(session.runtime?.blockHash).toLowerCase()!==BLOCK_HASH)throw Error('PINNED_MUTABLE_FORK_ATTESTATION_FAILED');
  const bin=path.resolve('node_modules/@foundry-rs/forge/bin.mjs');
  const args=[bin,'test','--json','--fork-url',session.runtime.url,
    '--fork-block-number',String(BLOCK),'--fuzz-runs','256','--match-path',
    'test/phase6/DAILiveForkSecurityV1.t.sol'];
  const result=spawnSync(process.execPath,args,{cwd:PROJECT,env:{...process.env,ETH_RPC_URL:session.runtime.url},
    timeout:900000,maxBuffer:32*1024*1024,encoding:'utf8'});
  const stdout=redaction(result.stdout),stderr=redaction(result.stderr);
  fs.writeFileSync(path.join(OUTPUT,'FORGE_RAW_STDOUT.txt'),stdout||'');
  fs.writeFileSync(path.join(OUTPUT,'FORGE_RAW_STDERR.txt'),stderr||'');
  evidence.forge={exitCode:result.status,signal:result.signal??null,invoked:true,
    command:'forge test --json --fork-url LOCAL_ANVIL --fork-block-number '+BLOCK,
    stdoutSha256:digest(stdout),stderrSha256:digest(stderr),timeoutMs:900000};
  if(result.error)evidence.errors.push('FORGE_EXECUTION_ERROR: '+result.error.message);
  let tests=[];
  try{tests=extractTestResults(stdout);}
  catch(error){evidence.errors.push(String(error?.message??error));}
  evidence.forge.parsedTestCount=tests.length;
  evidence.forge.tests=tests;
  const normalize=s=>s==='Success'||s==='PASS'||s==='Passed'?'PASS':s==='Failure'||s==='FAIL'?'FAIL':'UNCLASSIFIED';
  for(const id of OBLIGATIONS){
    const key=id.replace('-','_');
    const hits=tests.filter(t=>t.name.includes('test_prop_'+key+'_'));
    const one=hits.length===1?hits[0]:null;
    const outcome=!one?'NOT_EXECUTED':normalize(one.status);
    evidence.obligations.push({obligationId:id,assertionName:one?.name??null,
      status:outcome,toolInvoked:!!one,rawStatus:one?.status??null,
      reason:one?.reason??null,counterexample:one?.counterexample??null});
  }
  const accounted=evidence.obligations.every(x=>x.toolInvoked&&x.status!=='UNCLASSIFIED');
  if(!accounted){evidence.status='INCOMPLETE_ASSERTION_LEDGER';evidence.errors.push('NOT_ALL_SEVEN_ASSERTIONS_OBSERVED');}
  else if(evidence.obligations.some(x=>x.status==='FAIL'))evidence.status='ASSERTION_FAILURES';
  else if(result.status===0)evidence.status='ALL_SEVEN_PASSED';
  else{evidence.status='EXECUTION_ERROR';evidence.errors.push('NONZERO_FORGE_EXIT_WITH_NO_CLASSIFIED_FAILURES');}
}catch(error){
  evidence.errors.push(redaction(error?.stack??error));
  if(evidence.status==='NOT_EXECUTED')evidence.status='INFRASTRUCTURE_BLOCKED';
}finally{
  if(session)await session.close().catch(e=>evidence.errors.push('ANVIL_SHUTDOWN: '+String(e)));
  save();
  console.log('DAI_PHASE8_EXECUTION_SUMMARY '+JSON.stringify({status:evidence.status,
    executed:evidence.obligations.filter(x=>x.toolInvoked).length,
    passed:evidence.obligations.filter(x=>x.status==='PASS').length,
    failed:evidence.obligations.filter(x=>x.status==='FAIL').length,
    evidencePath}));
}
if(evidence.status!=='ALL_SEVEN_PASSED')process.exitCode=1;
