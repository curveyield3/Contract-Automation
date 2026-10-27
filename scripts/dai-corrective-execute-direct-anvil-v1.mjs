import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Interface,Wallet,Signature,getAddress} from 'ethers';
import {createPhase6MutableRpcSession} from '../packages/github-native-sim/src/phase6-mutable-rpc-v1.mjs';

const BLOCK=26283885;
const BLOCK_HASH='0xe9a7c98f604a48f1b8885578ec8f54e73ec33e9f34cc5161c049a59640b6eab5';
const DAI=getAddress('0x6b175474e89094c44da98b954eedeac495271d0f');
const WARD=getAddress('0x9759a6ac90977b93b58547b4a71c78317f391a28');
const EXPECTED_RUNTIME='5ce810033426a017721777f241665c27bdd4663ca8a1c27558b4b372a1731f4e';
const DOMAIN='0xdbb8cf42e1ecb028be3f3dbc922e1d878b963f411dc388ced501601c60f7c6f7';
const PERMIT_TYPEHASH='0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb';
const SUPPLY=4536529357206555811266503939n;
const ALICE=getAddress('0x00000000000000000000000000000000000a11ce');
const BOB=getAddress('0x0000000000000000000000000000000000000b0b');
const CAROL=getAddress('0x00000000000000000000000000000000000ca401');
const ATTACKER=getAddress('0x000000000000000000000000000000000000beef');
const HOLDER=new Wallet('0x'+'0'.repeat(60)+'0101');
const WRONG_SIGNER=new Wallet('0x'+'0'.repeat(60)+'0202');
const P7='0x'+('0'.repeat(63))+'7';
const TARGETS=['BOB-0001','BOB-0002','BOB-0003','BOB-0004','BOB-0005','BOB-0007','BOB-0008','CP-DAI-PERMIT-001'];
const ABI=[
  'function wards(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function PERMIT_TYPEHASH() view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function nonces(address) view returns (uint256)',
  'function rely(address)','function deny(address)','function mint(address,uint256)',
  'function burn(address,uint256)','function transfer(address,uint256) returns (bool)',
  'function transferFrom(address,address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)'
];
const iface=new Interface(ABI);
const attempt=String(process.env.DAI_EVIDENCE_ATTEMPT||'4');
const folder=path.resolve('process/dai-corrective-evidence/attempt-'+attempt);
fs.mkdirSync(folder,{recursive:true});
const redact=s=>String(s??'').replaceAll(process.env.ETHEREUM_FORK_RPC_URL||'__NO_UPSTREAM__','<redacted-upstream-rpc>');
const evidence={schemaVersion:'dai-live-anvil-bob-assertion-ledger-v1',
  campaignId:'audit-preview-completion-live-ethereum-dai-6b175474-corrective-r1',
  securityAuthority:'ONCHAIN_MUTABLE_FORK_DIRECT_EXECUTION',
  source:{repository:'curveyield3/Audit-Controller',commit:'b66ee2b336c949c3ecb0621307b9c188f8f81e89',
    archiveSha256:'1c384141058f50d53b9e58b89c0b83aa60bd1066406f017d177121de332705f2'},
  target:{chainId:1,address:DAI,blockNumber:BLOCK,blockHash:BLOCK_HASH,runtimeSha256:EXPECTED_RUNTIME,
    redeployed:false,upstreamStateChanges:false},
  runner:{repository:'curveyield3/Contract-Automation',commit:process.env.GITHUB_SHA,
    workflowRunId:process.env.GITHUB_RUN_ID,qualificationInvoked:false},
  status:'NOT_EXECUTED',startedAt:new Date().toISOString(),fork:null,forkAttempts:[],
  obligations:[],failures:[],rawTranscriptSha256:null
};
let rpcUrl=null,session=null,active=null;const transcript=[];
const sha=s=>createHash('sha256').update(s).digest('hex');
const text=v=>typeof v==='bigint'?v.toString():v;
const clean=v=>JSON.parse(JSON.stringify(v,(k,x)=>typeof x==='bigint'?x.toString():x));
function save(){
  evidence.finishedAt=new Date().toISOString();
  const raw=JSON.stringify(transcript,null,2)+'\n';
  fs.writeFileSync(path.join(folder,'ANVIL_RAW_RPC_TRANSCRIPT_v1.json'),raw);
  evidence.rawTranscriptSha256=sha(raw);
  fs.writeFileSync(path.join(folder,'BOB_EXECUTION_EVIDENCE_v1.json'),JSON.stringify(evidence,null,2)+'\n');
}
class AssertionFailure extends Error{
  constructor(label,context={}){super(label);this.name='SecurityAssertionFailed';this.context=context;}
}
function check(label,actual,expected){
  const a=String(actual).toLowerCase(),e=String(expected).toLowerCase();
  const pass=a===e;
  active.steps.push({label,pass,actual:text(actual),expected:text(expected)});
  if(!pass)throw new AssertionFailure(label,{actual:text(actual),expected:text(expected)});
}
async function rpc(method,params=[],{timeout=50000}={}){
  const record={n:transcript.length+1,method,params:clean(params)};
  transcript.push(record);
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeout);
  try{
    const res=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:record.n,method,params:clean(params)}),signal:ctl.signal});
    const result=await res.json();
    if(result.error||!res.ok){
      const err=new Error('RPC_'+method+': '+redact(result.error?.message||'HTTP_'+res.status));
      err.rpcError=result.error||null;
      record.error=redact(result.error?.message||'HTTP_'+res.status);
      throw err;
    }
    record.result=clean(result.result);
    return result.result;
  }catch(error){
    record.error=record.error||redact(error?.message||error);
    throw error;
  }finally{clearTimeout(timer);}
}
async function read(name,args=[],from=ALICE){
  const encoded=iface.encodeFunctionData(name,args);
  const result=await rpc('eth_call',[{to:DAI,from,data:encoded},'latest']);
  return iface.decodeFunctionResult(name,result)[0];
}
async function actor(address){
  await rpc('anvil_impersonateAccount',[address]);
  await rpc('anvil_setBalance',[address,'0xde0b6b3a7640000']);
}
async function tx(from,name,args){
  const data=iface.encodeFunctionData(name,args);
  const hash=await rpc('eth_sendTransaction',[{from,to:DAI,data,gas:'0x1e8480'}]);
  let receipt=null;
  for(let i=0;i<12;i++){
    receipt=await rpc('eth_getTransactionReceipt',[hash]);
    if(receipt)break;
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  if(!receipt)throw Error('MINED_RECEIPT_MISSING_'+name);
  check('tx:'+name+' receipt success',receipt.status,'0x1');
  return {hash,receipt};
}
async function reject(from,name,args){
  let reverted=false,reason=null;
  try{await read(name,args,from);}
  catch(err){
    const message=String(err?.message||err);
    const data=err?.rpcError?.data;
    reverted=Boolean(err?.rpcError?.code===3||/execution reverted|revert|invalid opcode/i.test(message)
      ||typeof data==='string'&&data.startsWith('0x08c379a0'));
    reason=message.slice(0,240);
    if(!reverted)throw err;
  }
  check('negative:'+name+' rejected',reverted,true);
  if(reason)active.steps.at(-1).revertReason=reason;
}
const domain={name:'Dai Stablecoin',version:'1',chainId:1,verifyingContract:DAI};
const types={Permit:[
  {name:'holder',type:'address'},{name:'spender',type:'address'},
  {name:'nonce',type:'uint256'},{name:'expiry',type:'uint256'},{name:'allowed',type:'bool'}
]};
function permitArgs(holder,spender,nonce,expiry,allowed,signature){
  const sig=Signature.from(signature);
  return [holder,spender,nonce,expiry,allowed,sig.v,sig.r,sig.s];
}
async function permitSign(wallet,holder,spender,nonce,expiry,allowed,dom=domain){
  return wallet.signTypedData(dom,types,{holder,spender,nonce,expiry,allowed});
}
const groups={
  'BOB-0001':async()=>{
    check('historical ward',await read('wards',[WARD]),1n);
    await reject(ATTACKER,'mint',[ALICE,1]);
    await reject(ATTACKER,'rely',[ATTACKER]);
    await reject(ATTACKER,'deny',[WARD]);
    await tx(WARD,'rely',[ATTACKER]);
    check('new ward active',await read('wards',[ATTACKER]),1n);
    await tx(ATTACKER,'mint',[ALICE,1]);
    await tx(WARD,'deny',[ATTACKER]);
    check('revoked ward',await read('wards',[ATTACKER]),0n);
    await reject(ATTACKER,'mint',[ALICE,1]);
  },
  'BOB-0002':async()=>{
    const supply=await read('totalSupply'),a=await read('balanceOf',[ALICE]),b=await read('balanceOf',[BOB]);
    await tx(WARD,'mint',[ALICE,1000]);
    check('mint supply',await read('totalSupply'),supply+1000n);
    check('mint balance',await read('balanceOf',[ALICE]),a+1000n);
    await tx(ALICE,'transfer',[BOB,350]);
    check('transfer supply unchanged',await read('totalSupply'),supply+1000n);
    check('transfer balance src',await read('balanceOf',[ALICE]),a+650n);
    check('transfer balance dst',await read('balanceOf',[BOB]),b+350n);
    await tx(BOB,'burn',[BOB,100]);
    check('burn supply',await read('totalSupply'),supply+900n);
    check('burn balance',await read('balanceOf',[BOB]),b+250n);
    await reject(ATTACKER,'transferFrom',[ALICE,ATTACKER,999]);
  },
  'BOB-0003':async()=>{
    check('domain separator',await read('DOMAIN_SEPARATOR'),DOMAIN);
    check('permit type hash',await read('PERMIT_TYPEHASH'),PERMIT_TYPEHASH);
    check('decimals',await read('decimals'),18n);
    check('exact historical supply',await read('totalSupply'),SUPPLY);
    check('ward at block',await read('wards',[WARD]),1n);
  },
  'BOB-0004':async()=>{
    const supply=await read('totalSupply');
    await reject(ATTACKER,'mint',[ATTACKER,1]);
    check('unauthorized supply unchanged',await read('totalSupply'),supply);
    await tx(WARD,'mint',[ATTACKER,1]);
    check('authorized mint changes supply',await read('totalSupply'),supply+1n);
  },
  'BOB-0005':async()=>{
    const a=await read('nonces',[ALICE]),b=await read('nonces',[BOB]);
    await tx(ALICE,'approve',[BOB,7]);
    check('allowance owner/spender',await read('allowance',[ALICE,BOB]),7n);
    check('allowance different spender',await read('allowance',[ALICE,CAROL]),0n);
    check('allowance reverse key',await read('allowance',[BOB,ALICE]),0n);
    check('alice nonce unchanged',await read('nonces',[ALICE]),a);
    check('bob nonce unchanged',await read('nonces',[BOB]),b);
  },
  'BOB-0007':async()=>{
    const holder=HOLDER.address,spender=BOB;
    const nonce=await read('nonces',[holder]);
    const signature=await permitSign(HOLDER,holder,spender,nonce,0,true);
    await tx(CAROL,'permit',permitArgs(holder,spender,nonce,0,true,signature));
    check('valid nonce increment',await read('nonces',[holder]),nonce+1n);
    check('valid permit allowance',await read('allowance',[holder,spender]),(1n<<256n)-1n);
    await reject(CAROL,'permit',permitArgs(holder,spender,nonce,0,true,signature));
    const expired=await permitSign(HOLDER,holder,spender,nonce+1n,1,true);
    await reject(CAROL,'permit',permitArgs(holder,spender,nonce+1n,1,true,expired));
    const wrongDomain=await permitSign(HOLDER,holder,spender,nonce+1n,0,true,
      {...domain,chainId:31337});
    await reject(CAROL,'permit',permitArgs(holder,spender,nonce+1n,0,true,wrongDomain));
    const wrongSigner=await permitSign(WRONG_SIGNER,holder,spender,nonce+1n,0,true);
    await reject(CAROL,'permit',permitArgs(holder,spender,nonce+1n,0,true,wrongSigner));
    const unchanged=await permitSign(HOLDER,holder,spender,nonce+1n,0,true);
    await reject(CAROL,'permit',permitArgs(holder,CAROL,nonce+1n,0,true,unchanged));
    check('negative attempts nonce stays',await read('nonces',[holder]),nonce+1n);
  },
  'BOB-0008':async()=>{
    const supply=await read('totalSupply');
    await tx(WARD,'mint',[ALICE,30]);
    await tx(ALICE,'approve',[BOB,15]);
    await tx(BOB,'transferFrom',[ALICE,CAROL,7]);
    check('transfer allowance decrement',await read('allowance',[ALICE,BOB]),8n);
    await tx(BOB,'burn',[ALICE,8]);
    check('burn allowance consumed',await read('allowance',[ALICE,BOB]),0n);
    await reject(BOB,'transferFrom',[ALICE,CAROL,1]);
    check('sequence supply',await read('totalSupply'),supply+22n);
  },
  'CP-DAI-PERMIT-001':async()=>{
    const holder=HOLDER.address,spender=BOB,nonce=await read('nonces',[holder]);
    const original=await permitSign(HOLDER,holder,spender,nonce,0,true);
    const sig=Signature.from(original);
    const secp=BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const highS='0x'+(secp-BigInt(sig.s)).toString(16).padStart(64,'0');
    const highV=sig.v===27?28:27;
    const base=[holder,spender,nonce,0,true];
    const high=[...base,highV,sig.r,highS];
    const old=permitArgs(holder,spender,nonce,0,true,original);
    const before=await read('allowance',[holder,spender]);
    check('original nonce begins zero',nonce,0n);
    // EIP-2 transactions reject high-s, but ECRecover in contract code
    // can legitimately recover high-s. A variant cannot consume nonce twice.
    let validHigh=false;
    try{await read('permit',high,CAROL);validHigh=true;}
    catch(err){if(!/revert|execution reverted/i.test(String(err?.message)))throw err;}
    check('high-s pair has same signing r',high[7],sig.r);
    if(validHigh)await tx(CAROL,'permit',high);
    else await tx(CAROL,'permit',old);
    check('one of high/low signatures consumes only one nonce',await read('nonces',[holder]),nonce+1n);
    check('allowance authorized only to selected spender',await read('allowance',[holder,spender]),(1n<<256n)-1n);
    await reject(CAROL,'permit',old);
    await reject(CAROL,'permit',high);
    check('high-s / low-s replay does not consume again',await read('nonces',[holder]),nonce+1n);
    const currentPermit=[holder,spender,nonce+1n,0,true];
    await reject(CAROL,'permit',[...currentPermit,0,sig.r,sig.s]);
    await reject(CAROL,'permit',[...currentPermit,29,sig.r,sig.s]);
    await reject(CAROL,'permit',[...currentPermit,sig.v,'0x'+'0'.repeat(64),sig.s]);
    await reject(CAROL,'permit',[...currentPermit,sig.v,sig.r,'0x'+'0'.repeat(64)]);
    await reject(CAROL,'permit',[getAddress('0x'+'0'.repeat(40)),spender,nonce+1n,0,true,sig.v,sig.r,sig.s]);
    const wrongContract=await permitSign(HOLDER,holder,spender,nonce+1n,0,true,{...domain,verifyingContract:CAROL});
    await reject(CAROL,'permit',permitArgs(holder,spender,nonce+1n,0,true,wrongContract));
    const future=await permitSign(HOLDER,holder,spender,nonce+1n,1,true);
    await reject(CAROL,'permit',permitArgs(holder,spender,nonce+1n,1,true,future));
    const next=await permitSign(HOLDER,holder,spender,nonce+1n,0,false);
    await reject(CAROL,'permit',permitArgs(holder,spender,nonce+2n,0,false,next));
    check('adversarial negatives leave nonce unchanged',await read('nonces',[holder]),nonce+1n);
    check('adversarial negatives leave allowance unchanged',await read('allowance',[holder,spender]),(1n<<256n)-1n);
    check('different spender never authorized',await read('allowance',[holder,CAROL]),0n);
    await tx(CAROL,'permit',permitArgs(holder,spender,nonce+1n,0,false,next));
    check('authorized revocation clears unlimited allowance',await read('allowance',[holder,spender]),0n);
    check('revocation consumes next nonce',await read('nonces',[holder]),nonce+2n);
    check('permit cannot change totalSupply',await read('totalSupply'),SUPPLY);
  }
};
try{
  if(!process.env.ETHEREUM_FORK_RPC_URL)throw Error('ARCHIVE_RPC_NOT_CONFIGURED');
  const sourceFile=path.resolve('.dai-phase8-work/contracts/Dai.sol');
  const harnessFile=path.resolve('.dai-phase8-work/test/phase6/DAILiveForkSecurityV1.t.sol');
  const source=fs.readFileSync(sourceFile),harness=fs.readFileSync(harnessFile);
  if(!/contract\s+Dai\s+is\s+LibNote/.test(source.toString('utf8'))
    ||!harness.toString('utf8').toLowerCase().includes(DAI.toLowerCase()))
    throw Error('SOURCE_OR_EXISTING_HARNESS_IDENTITY_INVALID');
  evidence.source.soliditySha256=sha(source);
  evidence.runner.existingFoundryHarnessSha256=sha(harness);
  for(let n=1;n<=5;n++){
    session=await createPhase6MutableRpcSession({environment:process.env,
      frozenBlockNumber:BLOCK,frozenBlockHash:BLOCK_HASH,
      attestedTargets:[{address:DAI,qualifiedName:'Dai.sol:Dai',runtimeSha256:EXPECTED_RUNTIME}]});
    evidence.forkAttempts.push({attempt:n,status:session.evidence.status,
      failureKind:session.evidence.failureKind||null,reason:redact(session.evidence.reason)});
    if(session.evidence.status==='PASS')break;
    if(n===5||!/502|503|504|429|temporar|upstream|Transport|timeout/i.test(String(session.evidence.reason)))break;
    await session.close().catch(()=>{});session=null;
    await new Promise(r=>setTimeout(r,n*3000));
  }
  evidence.fork=session?.evidence||null;
  if(session?.evidence?.status!=='PASS'||session.evidence.deployedTargetAttestation?.status!=='PASS'
    ||session.evidence.deployedTargetAttestation.mutableWriteObserved!==true
    ||session.evidence.deployedTargetAttestation.snapshotReverted!==true
    ||session.runtime?.blockNumber!==BLOCK
    ||String(session.runtime.blockHash).toLowerCase()!==BLOCK_HASH)
    throw Error('HISTORICAL_MUTABLE_DAI_ATTESTATION_FAILED');
  rpcUrl=session.runtime.url;
  const upstreamChain=await rpc('eth_chainId');
  if(upstreamChain!=='0x1')throw Error('LOCAL_CHAIN_ID_MISMATCH');
  for(const address of [WARD,ALICE,BOB,CAROL,ATTACKER])await actor(address);
  for(const id of TARGETS){
    const snap=await rpc('evm_snapshot');
    active={obligationId:id,status:'RUNNING',toolInvoked:true,steps:[],beganAt:new Date().toISOString()};
    try{
      await groups[id]();
      active.status='PASS';
    }catch(error){
      active.status=error instanceof AssertionFailure?'FAIL':'ERROR';
      active.error=redact(error?.stack||String(error)).slice(0,2000);
      if(error?.context)active.failureContext=error.context;
    }finally{
      try{
        const reverted=await rpc('evm_revert',[snap]);
        if(reverted!==true){active.status='ERROR';active.error='SNAPSHOT_ROLLBACK_FAILED';}
      }catch(err){active.status='ERROR';active.error='SNAPSHOT_ROLLBACK_ERROR: '+redact(err);}
      active.finishedAt=new Date().toISOString();
      evidence.obligations.push(active);
      active=null;
    }
  }
  evidence.status=evidence.obligations.length===TARGETS.length&&evidence.obligations.every(x=>x.status==='PASS')
    ?'ALL_SEVEN_PASSED':evidence.obligations.some(x=>x.status==='FAIL')?'ASSERTION_FAILURES':'INCOMPLETE_EXECUTION';
}catch(error){
  evidence.failures.push(redact(error?.stack||String(error)).slice(0,2000));
  if(evidence.status==='NOT_EXECUTED')evidence.status='INFRASTRUCTURE_BLOCKED';
}finally{
  if(session)await session.close().catch(e=>evidence.failures.push('ANVIL_CLOSE: '+redact(e)));
  save();
  console.log('DAI_PHASE8_DIRECT_ANVIL_RESULTS '+JSON.stringify({status:evidence.status,
    tests:evidence.obligations.map(o=>({id:o.obligationId,status:o.status,assertions:o.steps.length})),
    run:process.env.GITHUB_RUN_ID||null}));
}
if(evidence.status!=='ALL_TARGETS_PASSED')process.exitCode=1;
