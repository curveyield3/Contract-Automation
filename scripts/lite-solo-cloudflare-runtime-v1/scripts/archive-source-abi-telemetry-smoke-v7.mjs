#!/usr/bin/env node
// Archived-source compatibility lane for source ZIPs created before Phase-0 v2
// evidence existed. Uses the SAME production ABI telemetry engine as Phase 0;
// it does not replace economic deployment validation or invent a receipt.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ethers} from 'ethers';
import {targetObjects,prepareQualifiedRuntimeV2,runTelemetry} from '../packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs';
import {fundActorsV1} from '../packages/github-native-sim/src/phase0-fixture-synthesis-v1.mjs';

function args(argv){
  const out={};
  for(let i=2;i<argv.length;i++){
    if(!argv[i].startsWith('--'))continue;
    out[argv[i].slice(2)]=argv[++i];
  }
  return out;
}
async function walk(dir){
  const out=[];
  for(const d of await fs.readdir(dir,{withFileTypes:true})){
    if(d.name==='build-info'||d.name==='node_modules')continue;
    const abs=path.join(dir,d.name);
    if(d.isDirectory())out.push(...await walk(abs));
    else if(d.name.endsWith('.json')&&!d.name.endsWith('.dbg.json'))out.push(abs);
  }
  return out;
}
async function artifactsFromHardhat(dir){
  const files=await walk(dir),rows=[],seen=new Set();
  for(const file of files){
    let a;try{a=JSON.parse(await fs.readFile(file,'utf8'));}catch{continue;}
    if(!a||!Array.isArray(a.abi)||!a.contractName||!a.sourceName||typeof a.bytecode!=='string'||a.bytecode.length<6||a.bytecode.includes('__$'))continue;
    const key=a.sourceName+':'+a.contractName;
    if(seen.has(key))continue;
    seen.add(key);
    rows.push({sourceName:a.sourceName,contractName:a.contractName,abi:a.abi,bytecode:a.bytecode});
  }
  return rows.sort((a,b)=>a.contractName.localeCompare(b.contractName));
}
function constructorArgument(input,actor,tokenAddress){
  const t=String(input.type);
  if(t==='address')return tokenAddress||actor;
  if(t==='bool')return false;
  if(t==='string')return 'ArchiveTelemetrySmoke';
  if(t==='bytes')return '0x';
  if(/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(t))return '0x'+'00'.repeat(Number(t.slice(5)));
  if(/^uint(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(t))return 1n;
  if(/^int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/.test(t))return 1n;
  if(t.endsWith('[]'))return [];
  if(t.startsWith('tuple'))return null;
  return null;
}
async function startAnvil(){
  throw new Error('RETIRED_SOURCE_ONLY_SIMULATION: standalone fixtures are not historical fork evidence. Use authorized V7 archive Anvil execution.');
  const bin=path.resolve('node_modules/@foundry-rs/anvil/bin.mjs');
  await fs.access(bin);
  const fork=process.env.ETHEREUM_FORK_RPC_URL;
  if(!fork)throw Error('RPC_ETHEREUM secret missing');
  const localArgs=[bin,'--host','127.0.0.1','--port','8549','--chain-id','1','--hardfork','cancun','--accounts','20','--auto-impersonate','--no-rate-limit','--silent'];
  const launch=async(forkMode,additionalArgs=[],fallbackReason=null)=>{
    const child=spawn(process.execPath,[...localArgs,...additionalArgs],{stdio:['ignore','ignore','pipe']});
    let stderr='';
    child.stderr.on('data',b=>stderr=(stderr+String(b)).slice(-3000));
    const provider=new ethers.JsonRpcProvider('http://127.0.0.1:8549',1,{staticNetwork:true,cacheTimeout:-1});
    const begun=Date.now();
    while(Date.now()-begun<45000){
      if(child.exitCode!==null){
        provider.destroy();
        throw Error('Anvil exited: '+stderr);
      }
      try{
        if((await provider.send('eth_chainId',[]))==='0x1')return{provider,child,forkMode,fallbackReason};
      }catch{}
      await new Promise(r=>setTimeout(r,350));
    }
    child.kill('SIGKILL');provider.destroy();
    throw Error('Anvil failed to initialize: '+stderr);
  };
  try{
    return await launch('ETHEREUM_MAINNET_ANVIL_FORK',['--fork-url',fork]);
  }catch(error){
    // These archived smoke fixtures exercise source-deployed contracts only.
    // A provider's explicit free-tier 408 is not a Solidity failure. Use a
    // transparent isolated local chain rather than reporting fake fork proof.
    const reason=String(error?.message??error);
    if(!/(?:HTTP error 408|Request timeout on the free plan|upgrade to paid plan|upstream.*rate.limit)/i.test(reason))throw error;
    console.log('[archive-telemetry] FORK_RPC_THROTTLED: '+reason.slice(0,260));
    const node=await launch('LOCAL_ANVIL_SOURCE_FIXTURE_FALLBACK',[],reason.slice(0,900));
    console.log('[archive-telemetry] FORK_BACKUP_ACTIVE: no upstream chain state or historical mainnet reads are available');
    return node;
  }
}
async function deploySourceArtifacts({provider,artifacts,actors}){
  const signer=await provider.getSigner(actors[0]),deployed=[],failures=[];
  const ranked=[...artifacts].sort((a,b)=>{
    const aa=a.abi.find(x=>x.type==='constructor')?.inputs?.length||0;
    const bb=b.abi.find(x=>x.type==='constructor')?.inputs?.length||0;
    return aa-bb||a.contractName.localeCompare(b.contractName);
  });
  for(const a of ranked){
    const inputs=a.abi.find(x=>x.type==='constructor')?.inputs??[];
    if(inputs.length>5){failures.push({contract:a.contractName,reason:'CONSTRUCTOR_TOO_COMPLEX_FOR_ARCHIVE_SMOKE'});continue;}
    const knownToken=deployed.find(x=>/token|erc20|mock/i.test(x.contractName))?.address??null;
    const values=inputs.map(input=>constructorArgument(input,actors[0],knownToken));
    if(values.some(x=>x===null)){failures.push({contract:a.contractName,reason:'UNSUPPORTED_CONSTRUCTOR_SIGNATURE'});continue;}
    try{
      const factory=new ethers.ContractFactory(a.abi,a.bytecode,signer);
      const c=await factory.deploy(...values);
      await c.waitForDeployment();
      const receipt=await c.deploymentTransaction().wait();
      if(receipt.status!==1)throw Error('deployment reverted');
      deployed.push({address:await c.getAddress(),contractName:a.contractName,sourceName:a.sourceName,qualifiedName:a.sourceName+':'+a.contractName,transactionHash:receipt.hash,blockNumber:receipt.blockNumber,mappingStatus:inputs.length?'SYNTHETIC_CONSTRUCTOR_FIXTURE':'ZERO_ARGUMENT_SOURCE_BYTECODE'});
      console.log('[archive-telemetry] deployed '+a.contractName+' args='+inputs.length);
    }catch(error){failures.push({contract:a.contractName,reason:String(error.shortMessage||error.message||error).slice(0,300)});}
  }
  return{deployed,failures};
}

async function prepareEconomicTokenFixtures({provider,targets,actors}){
  const holder=actors[0],spender=actors[1],receiver=actors[2];
  const receipts=[],candidates=[],funding=[];
  for(const target of targets){
    const fn=new Set(target.functions.map(x=>x.signature));
    const iface=new ethers.Interface(target.artifact.abi);
    const views=new Set(iface.fragments.filter(x=>x.type==='function').map(x=>x.format('sighash')));
    if(!fn.has('transfer(address,uint256)')||!views.has('balanceOf(address)')||!views.has('allowance(address,address)'))continue;
    const token=new ethers.Contract(target.address,target.artifact.abi,provider);
    // Look up the actual on-chain owner; synthetic constructor positions are not
    // reliable evidence that actor[0] controls the deployed contract.
    let adminSigner=await provider.getSigner(holder),resolvedOwner=holder;
    if(views.has('owner()')){
      try{
        const discovered=await token.getFunction('owner()').staticCall();
        if(ethers.isAddress(discovered)&&discovered!==ethers.ZeroAddress){
          resolvedOwner=discovered;
          if(!actors.some(x=>x.toLowerCase()===discovered.toLowerCase())){
            await provider.send('anvil_impersonateAccount',[discovered]);
            await provider.send('anvil_setBalance',[discovered,ethers.toQuantity(10n**21n)]);
          }
          adminSigner=await provider.getSigner(discovered);
        }
      }catch(error){receipts.push({target:target.qualifiedName,kind:'SOURCE_OWNER_LOOKUP',status:'BLOCKED',reason:String(error.shortMessage??error.message).slice(0,200)});}
    }
    receipts.push({target:target.qualifiedName,kind:'SOURCE_OWNER_DISCOVERED',owner:resolvedOwner,source:views.has('owner()')?'ONCHAIN_OWNER_GETTER':'ARCHIVED_FIXTURE_DEPLOYER'});
    // Only signer-controlled, source-ABI calls can enable sender permissions.
    // Never bypass access control in the audited contract code.
    if(fn.has('setMinter(address,bool)')){
      try{
        const tx=await token.connect(adminSigner).getFunction('setMinter(address,bool)').send(holder,true);
        const rc=await tx.wait();
        receipts.push({target:target.qualifiedName,kind:'GRANT_SOURCE_MINTER',hash:rc.hash,status:rc.status});
      }catch(error){receipts.push({target:target.qualifiedName,kind:'GRANT_SOURCE_MINTER',status:'BLOCKED',reason:String(error.shortMessage??error.message).slice(0,200)});}
    }
    if(fn.has('setTransferWhitelist(address,bool)')){
      for(const addr of actors){
        try{
          const tx=await token.connect(adminSigner).getFunction('setTransferWhitelist(address,bool)').send(addr,true);
          const rc=await tx.wait();
          receipts.push({target:target.qualifiedName,kind:'SOURCE_TRANSFER_ALLOWLIST',address:addr,hash:rc.hash,status:rc.status});
        }catch(error){receipts.push({target:target.qualifiedName,kind:'SOURCE_TRANSFER_ALLOWLIST',address:addr,status:'BLOCKED',reason:String(error.shortMessage??error.message).slice(0,200)});}
      }
    }
    if(fn.has('mint(address,uint256)')){
      try{
        const tx=await token.connect(await provider.getSigner(holder)).getFunction('mint(address,uint256)').send(holder,1000000000000000000000n);
        const rc=await tx.wait();
        receipts.push({target:target.qualifiedName,kind:'SOURCE_ABI_REAL_MINT',hash:rc.hash,status:rc.status});
      }catch(error){receipts.push({target:target.qualifiedName,kind:'SOURCE_ABI_REAL_MINT',status:'BLOCKED',reason:String(error.shortMessage??error.message).slice(0,200)});}
    }
    try{
      const balance=await token.getFunction('balanceOf(address)').staticCall(holder);
      const allowance=await token.getFunction('allowance(address,address)').staticCall(holder,spender);
      candidates.push({target,token,balance:balance.toString(),allowance:allowance.toString()});
    }catch(error){receipts.push({target:target.qualifiedName,kind:'TOKEN_STATE_PROBE',status:'BLOCKED',reason:String(error.shortMessage??error.message).slice(0,200)});}
  }
  // Fund only source-deployed, proven ERC20-like instances. State injection is
  // explicitly labeled as a smoke fixture, never a real protocol deposit/mint.
  const unfunded=candidates.filter(x=>BigInt(x.balance)===0n);
  if(unfunded.length){
    const tokens=unfunded.map(x=>({address:x.target.address,decimals:18}));
    const f=await fundActorsV1({provider,ethers,tokens,holders:actors.slice(0,3),spenders:actors.slice(0,3)});
    funding.push({kind:'FORK_ONLY_BALANCE_SLOT_FIXTURES',tokens:tokens.map(x=>({address:x.address,balanceSlot:x.balanceSlot??null,verifiedAmount:x.fundedAmount??null})),verified:f.slotResults.filter(x=>x.holdersVerified>0),gaps:f.gaps.slice(0,30)});
  }
  // Call real approve() with the exact owner/spender relationship. Treat
  // authorization failures as gaps instead of silently substituting callers.
  for(const x of candidates){
    try{
      const token=x.token.connect(await provider.getSigner(holder));
      let current=await token.getFunction('balanceOf(address)').staticCall(holder);
      if(current<100n)throw Error('unfunded token holder (verified balance < 100)');
      const tx=await token.getFunction('approve(address,uint256)').send(spender,ethers.MaxUint256);
      const rc=await tx.wait();
      const allowance=await x.token.getFunction('allowance(address,address)').staticCall(holder,spender);
      if(rc.status!==1||allowance<100n)throw Error('allowance not established');
      // Ensure an actual 1-unit transfer is executable in the source contract.
      await token.getFunction('transfer(address,uint256)').staticCall(receiver,1n);
      x.target.archiveTokenRuntime={funded:true,holder,spender,receiver,amount:'1',fundingBasis:BigInt(x.balance)>0n?'SOURCE_ABI_MINT_OR_EXISTING':'FORK_ONLY_VERIFIED_STORAGE'};
      receipts.push({target:x.target.qualifiedName,kind:'SOURCE_TOKEN_ALLOWANCE',hash:rc.hash,status:rc.status,holderBalance:current.toString(),allowance:allowance.toString(),verifiedTransferPreflight:true});
      console.log('[archive-telemetry] ECONOMIC_READY '+x.target.contractName+' balance='+current+' allowance='+allowance);
    }catch(error){
      receipts.push({target:x.target.qualifiedName,kind:'ECONOMIC_PREFLIGHT_FAILED',status:'BLOCKED',reason:String(error.shortMessage??error.message).slice(0,300)});
    }
  }
  return{receipts,funding,readyCount:targets.filter(x=>x.archiveTokenRuntime?.funded).length};
}


// Build dependency-correct source deployments for the two archived families.
// Every dependency is explicit and recorded; never silently substitute the
// previously deployed token as a constructor owner or governance address.
async function deployArchiveFamilyV4({provider,artifacts,actors}){
  const signer=await provider.getSigner(actors[0]),byName=new Map(artifacts.map(a=>[a.contractName,a]));
  const deployed=[],failures=[],deployedByName=new Map(),plans=[];
  const hasVlSdt=byName.has('CurveYieldVlSDTToken');
  const order=hasVlSdt?[
    'CurveYieldVlSDTToken','CurveYieldGovernanceToken','CurveYieldVault',
    'CurveYieldCyGovYieldStaking','CurveYieldVlSDTRevenueStaking',
    'CurveYieldVlSDTBoostStaking','CurveYieldRevenueConverter',
    'CurveYieldVlSDTBoostMerchant','CurveYieldRevenueStrategyV7'
  ]:['CurveYieldGovernanceToken','CurveYieldVault'];
  const address=name=>deployedByName.get(name)?.address??null;
  const deps=name=>{
    const actor=actors[0],cyvl=address('CurveYieldVlSDTToken'),gov=address('CurveYieldGovernanceToken');
    const vault=address('CurveYieldVault'),revenue=address('CurveYieldVlSDTRevenueStaking'),converter=address('CurveYieldRevenueConverter');
    switch(name){
      case 'CurveYieldVlSDTToken':return [actor];
      case 'CurveYieldGovernanceToken':return [actor,'Archive Governance','aGOV'];
      case 'CurveYieldVault':return ['Archive Vault','aVLT',actor,actor,18n];
      case 'CurveYieldCyGovYieldStaking':return [actor,cyvl,gov,actor];
      case 'CurveYieldVlSDTRevenueStaking':return [actor,actor,actor,cyvl,gov];
      case 'CurveYieldVlSDTBoostStaking':return [actor,cyvl,actor,gov]; // Locker not deployed: only staking/exit can be tested
      case 'CurveYieldRevenueConverter':return [actor,cyvl,cyvl,actor]; // explicitly non-production SDT/Locker stubs
      case 'CurveYieldVlSDTBoostMerchant':return [actor,actor,revenue,actor];
      case 'CurveYieldRevenueStrategyV7':return [actor,vault,cyvl,cyvl,gov,revenue,converter,0n,0n,0n];
      default:return null;
    }
  };
  const attempt=async(a,values,basis)=>{
    try{
      const factory=new ethers.ContractFactory(a.abi,a.bytecode,signer);
      const c=await factory.deploy(...values);
      await c.waitForDeployment();
      const receipt=await c.deploymentTransaction().wait();
      if(receipt.status!==1)throw Error('deployment reverted');
      const row={address:await c.getAddress(),contractName:a.contractName,sourceName:a.sourceName,
        qualifiedName:a.sourceName+':'+a.contractName,transactionHash:receipt.hash,blockNumber:receipt.blockNumber,mappingStatus:basis};
      deployed.push(row);deployedByName.set(a.contractName,row);
      plans.push({contract:a.contractName,constructorBasis:basis,constructorValues:values.map(v=>typeof v==='bigint'?v.toString():v),receiptHash:receipt.hash});
      console.log('[archive-telemetry] deployed '+a.contractName+' args='+values.length+' basis='+basis);
    }catch(error){
      failures.push({contract:a.contractName,reason:String(error.shortMessage??error.message??error).slice(0,500)});
    }
  };
  for(const name of order){
    const a=byName.get(name);if(!a)continue;
    const values=deps(name);
    if(values?.some(v=>v==null)){
      failures.push({contract:name,reason:'REQUIRED_SOURCE_DEPENDENCY_NOT_DEPLOYED'});
      continue;
    }
    await attempt(a,values,'SOURCE_DEPENDENCY_PLANNED_FIXTURE_V4');
  }
  for(const a of artifacts){
    if(deployedByName.has(a.contractName)||failures.some(x=>x.contract===a.contractName))continue;
    const inputs=a.abi.find(x=>x.type==='constructor')?.inputs??[];
    if(inputs.length>5){failures.push({contract:a.contractName,reason:'NO_VERIFIED_SOURCE_DEPENDENCY_PLAN'});continue;}
    const values=inputs.map(input=>constructorArgument(input,actors[0],null));
    if(values.some(x=>x===null)){failures.push({contract:a.contractName,reason:'UNSUPPORTED_CONSTRUCTOR_SIGNATURE'});continue;}
    await attempt(a,values,inputs.length?'LEGACY_UNVERIFIED_CONSTRUCTOR_FIXTURE':'ZERO_ARGUMENT_SOURCE_BYTECODE');
  }
  return{deployed,failures,plans};
}

async function prepareArchiveLifecyclesV4({provider,targets,actors}){
  const result={sourceRoleProbes:[],approvals:[],stakes:[],governanceSetup:[],gaps:[]};
  const holder=actors[0],receiver=actors[2],signer=await provider.getSigner(holder);
  const targetByName=new Map(targets.map(x=>[x.contractName,x]));
  const cyvl=targetByName.get('CurveYieldVlSDTToken');
  const gov=targetByName.get('CurveYieldGovernanceToken');
  const staking=targets.filter(x=>['CurveYieldCyGovYieldStaking','CurveYieldVlSDTBoostStaking','CurveYieldVlSDTRevenueStaking'].includes(x.contractName));
  const tokenAbi=['function approve(address,uint256) returns (bool)','function allowance(address,address) view returns (uint256)','function balanceOf(address) view returns (uint256)'];
  if(gov){
    const contract=new ethers.Contract(gov.address,gov.artifact.abi,signer);
    for(const stake of staking){
      try{
        const fn=contract.getFunction('setMinter(address,bool)');
        const tx=await fn.send(stake.address,true),rc=await tx.wait();
        result.governanceSetup.push({kind:'GOVERNANCE_STAKING_MINTER_GRANTED',staking:stake.contractName,hash:rc.hash,status:rc.status});
        // The source token's allowance is ZERO after setMinter. Without the
        // explicit source-governance allocation, funded reward minting will
        // deterministically reject even when the role grant succeeds.
        const allocation=await contract.getFunction('setMinterAllocation(address,uint256,uint256)').send(stake.address,100000n,0n);
        const allocationReceipt=await allocation.wait();
        result.governanceSetup.push({kind:'SOURCE_MINTER_ALLOCATION_GRANTED',staking:stake.contractName,hash:allocationReceipt.hash,status:allocationReceipt.status,initialCap:'100000',additionalBps:'0'});
      }catch(error){result.gaps.push({kind:'GOVERNANCE_MINTER_SETUP_FAILED',contract:stake.contractName,reason:String(error.shortMessage??error.message).slice(0,250)});}
    }
  }
  if(cyvl){
    const token=new ethers.Contract(cyvl.address,tokenAbi,signer);
    const balance=await token.balanceOf(holder);
    for(const stake of staking){
      try{
        if(balance<10000n)throw Error('verified holder funding below 10000');
        const tx=await token.approve(stake.address,ethers.MaxUint256),rc=await tx.wait();
        const allowance=await token.allowance(holder,stake.address);
        if(rc.status!==1||allowance<1000n)throw Error('spender allowance not verified');
        result.approvals.push({stake:stake.contractName,hash:rc.hash,allowance:allowance.toString()});
        const method=stake.functions.some(x=>x.signature==='stake(uint256)')?'stake(uint256)':
          stake.functions.some(x=>x.signature==='deposit(uint256)')?'deposit(uint256)':null;
        if(!method)throw Error('no supported staking method');
        const stakingContract=new ethers.Contract(stake.address,stake.artifact.abi,signer);
        const seed=10000n;
        const stakeTx=await stakingContract.getFunction(method).send(seed),stakeReceipt=await stakeTx.wait();
        if(stakeReceipt.status!==1)throw Error('stake reverted');
        const balanceGetter=stake.contractName==='CurveYieldCyGovYieldStaking'?'balanceOf(address)':
          stake.contractName==='CurveYieldVlSDTRevenueStaking'?'activeBalance(address)':'depositedBalance(address)';
        const staked=await stakingContract.getFunction(balanceGetter).staticCall(holder);
        if(staked<=0n)throw Error('stake receipt mined without positive position');
        stake.archiveStakeRuntime={ready:true,holder,receiver,seedTransaction:stakeReceipt.hash,staked:staked.toString()};
        result.stakes.push({contract:stake.contractName,hash:stakeReceipt.hash,status:stakeReceipt.status,staked:staked.toString(),balanceGetter});
        console.log('[archive-telemetry] STAKE_READY '+stake.contractName+' staked='+staked);
      }catch(error){result.gaps.push({kind:'SOURCE_STAKE_LIFECYCLE_SETUP_FAILED',contract:stake.contractName,reason:String(error.shortMessage??error.message).slice(0,500)});}
    }
  }
  // Bind only the source strategy whose constructor reports this vault and
  // the verified cyvlSDT asset. The source requires a registered Curve child
  // gauge to invest idle assets, so do NOT fabricate that gauge or claim full
  // vault deposit coverage from this one-time binding.
  const vaultTarget=targetByName.get('CurveYieldVault'),strategyTarget=targetByName.get('CurveYieldRevenueStrategyV7');
  if(vaultTarget&&strategyTarget&&cyvl){
    try{
      const strategy=new ethers.Contract(strategyTarget.address,strategyTarget.artifact.abi,provider);
      const [vaultAddress,wantAddress]=await Promise.all([strategy.getFunction('vault()').staticCall(),strategy.getFunction('want()').staticCall()]);
      if(String(vaultAddress).toLowerCase()!==vaultTarget.address.toLowerCase()||String(wantAddress).toLowerCase()!==cyvl.address.toLowerCase())throw Error('source strategy vault/want binding mismatch');
      const vault=new ethers.Contract(vaultTarget.address,vaultTarget.artifact.abi,signer);
      const tx=await vault.getFunction('setStrategy(address)').send(strategyTarget.address),rc=await tx.wait();
      const observed=await vault.getFunction('strategy()').staticCall();
      if(rc.status!==1||String(observed).toLowerCase()!==strategyTarget.address.toLowerCase())throw Error('setStrategy receipt or observed strategy mismatched');
      result.governanceSetup.push({kind:'SOURCE_VAULT_STRATEGY_BOUND',status:rc.status,hash:rc.hash,vault:vaultTarget.address,strategy:strategyTarget.address,want:cyvl.address,
        unverifiedPrerequisite:'CURVE_CHILD_GAUGE_MUST_BE_CONFIGURED_TO_EXECUTE_VAULT_DEPOSITS'});
    }catch(error){result.gaps.push({kind:'SOURCE_VAULT_STRATEGY_BINDING_FAILED',reason:String(error.shortMessage??error.message).slice(0,450)});}
  }
  // Read per-contract role getters; unrelated owners must never be treated as
  // global privileged callers. These reads are fork-local runtime evidence.
  for(const target of targets){
    const iface=new ethers.Interface(target.artifact.abi),getterSet=new Set(iface.fragments.filter(x=>x.type==='function').map(x=>x.format('sighash')));
    const roles={};
    for(const role of ['owner','configurator','feeReceiver','pendingFeeReceiver','admin','vault']){
      if(!getterSet.has(role+'()'))continue;
      try{
        const value=await new ethers.Contract(target.address,target.artifact.abi,provider).getFunction(role+'()').staticCall();
        if(ethers.isAddress(value)&&value!==ethers.ZeroAddress)roles[role]=value;
      }catch(error){result.gaps.push({kind:'SOURCE_ROLE_READ_FAILED',contract:target.contractName,role,reason:String(error.shortMessage??error.message).slice(0,160)});}
    }
    if(gov&&target.contractName==='CurveYieldGovernanceToken'){
      try{const is=await new ethers.Contract(gov.address,gov.artifact.abi,provider).getFunction('isMinter(address)').staticCall(holder);
        if(is)roles.verifiedMinter=holder;
      }catch{}
    }
    target.archiveRoleCallers=roles;
    result.sourceRoleProbes.push({contract:target.contractName,address:target.address,roles});
  }
  return result;
}

async function main(){
  const a=args(process.argv);
  for(const k of ['artifact-dir','output','archive-manifest'])if(!a[k])throw Error('missing --'+k);
  const n=Number(a.calls??300);
  if(!Number.isSafeInteger(n)||n<1||n>2000)throw Error('calls outside smoke budget');
  const artifacts=await artifactsFromHardhat(a['artifact-dir']);
  if(!artifacts.length)throw Error('No real compiled source bytecode artifacts');
  const manifest=JSON.parse(await fs.readFile(a['archive-manifest'],'utf8'));
  await fs.mkdir(a.output,{recursive:true});
  console.log('[archive-telemetry] source='+manifest.sourceArchive+' bytecodeArtifacts='+artifacts.length);
  let node;
  try{
    node=await startAnvil();
    const {provider}=node;
    console.log('[archive-telemetry] executionMode='+node.forkMode);
    const actors=(await provider.send('eth_accounts',[])).slice(0,4);
    const setup=await deployArchiveFamilyV4({provider,artifacts,actors});
    if(!setup.deployed.length)throw Error('No source contracts deployed; cannot perform ABI telemetry');
    // Owner-role and balance setup is performed exactly once below.
    let targets=targetObjects(ethers,artifacts,setup.deployed,{});
    if(!targets.length)throw Error('No executable source ABI mutation targets');
    const prepared=await prepareQualifiedRuntimeV2({provider,ethers,targets,actors});
    targets=prepared.targets;
    const economicFixtures=await prepareEconomicTokenFixtures({provider,targets,actors});
    const lifecycle=await prepareArchiveLifecyclesV4({provider,targets,actors});
    console.log('[archive-telemetry] lifecycleStakeReady='+lifecycle.stakes.length+' roleProbes='+lifecycle.sourceRoleProbes.length);
    console.log('[archive-telemetry] economicReady='+economicFixtures.readyCount+' sourceFixtures='+economicFixtures.receipts.length);
    console.log('[archive-telemetry] activeTargets='+targets.length+' actors='+actors.length+' sourceDeployments='+setup.deployed.length);
    const snap=await provider.send('evm_snapshot',[]);
    const summaries=await runTelemetry({provider,ethers,targets,actors,outRoot:a.output,baselineSnapshot:snap,artifacts,telemetryRuns:1,callsPerRun:n,seedSalt:manifest.sourceArchive,runPrefix:'archive-abi-telemetry'});
    const t=summaries[0];
    const report={
      schemaVersion:'archive-source-phase0-abi-telemetry-smoke-v7',
      mode:'ARCHIVED_SOURCE_TEST_FIXTURES_NOT_PRODUCTION_DEPLOYMENT',
      source:manifest,forkMode:node.forkMode,forkFallbackReason:node.fallbackReason,artifacts:artifacts.length,deployed:setup.deployed,notDeployed:setup.failures,
      setupReceipts:prepared.setupReceipts,economicFixtures,lifecycle,constructorPlans:setup.plans,targetCount:targets.length,
      calls:t?.calls??0,minedSuccess:t?.minedSuccess??0,minedRevert:t?.minedRevert??0,
      simulatedRejection:t?.simulatedRejection??0,positiveEconomicTransitions:t?.positiveEconomicTransitions??0,
      accountingObservationCalls:t?.accountingObservationCalls??0,observationReads:t?.observationReads??0,
      summary:t,passed:Boolean(t?.status==='PASS'&&t.calls===n&&t.minedSuccess>0&&t.positiveEconomicTransitions>0&&economicFixtures.readyCount>0)
    };
    await fs.writeFile(path.join(a.output,'ARCHIVE_TELEMETRY_SMOKE_v7.json'),JSON.stringify(report,null,2)+'\n');
    console.log('[archive-telemetry] RESULT '+JSON.stringify({passed:report.passed,calls:report.calls,minedSuccess:report.minedSuccess,minedRevert:report.minedRevert,simulatedRejection:report.simulatedRejection,positiveEconomicTransitions:report.positiveEconomicTransitions,observationReads:report.observationReads,accountingObservationCalls:report.accountingObservationCalls}));
    if(!report.passed)process.exitCode=1;
  }finally{
    if(node){
      node.child.kill('SIGTERM');
      await Promise.race([new Promise(r=>node.child.once('exit',r)),new Promise(r=>setTimeout(r,1500))]);
      if(node.child.exitCode===null)node.child.kill('SIGKILL');
      node.provider.destroy();
    }
  }
}
main().catch(e=>{console.error('[archive-telemetry] FATAL '+(e?.stack??String(e)));process.exitCode=1;});
