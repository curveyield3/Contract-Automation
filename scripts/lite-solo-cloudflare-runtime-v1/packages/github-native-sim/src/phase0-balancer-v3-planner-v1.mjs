// Protocol-aware Phase 0 actions for Balancer v3. No Uniswap-style pair assumptions.
import {buildBalancerV3CreatorArgumentsV1} from './phase0-fixture-synthesis-v1.mjs';
// All addresses and token orders are validated against the deployed Vault.
const ADDRESS_RE=/^0x[0-9a-fA-F]{40}$/;
const BALANCER_RE=/@balancer-labs\/v3-|balancer\/v3|balancer-v3|CurveYieldPoolFactoryWrapper\.sol:|PermanentLiquidityVaultV2\.sol:|FeeSettlementRouter\.sol:|contracts\/factories\/CurveYield\w+PoolFactory\.sol:/i;
const VIEW_ABI=[
  'function isPoolRegistered(address) view returns (bool)',
  'function isPoolInitialized(address) view returns (bool)',
  'function getPoolTokens(address) view returns (address[])',
  'function getVaultExtension() view returns (address)'
];
function nameOf(target){return String(target?.logicalQualifiedName??target?.qualifiedName??'');}
function lower(x){return String(x??'').toLowerCase();}
function addresses(ethers,rows){
  const out=new Map();
  for(const row of rows){try{const a=ethers.getAddress(String(row));out.set(a.toLowerCase(),a);}catch{}}
  return [...out.values()];
}
export function isBalancerV3TargetV1(target){
  return BALANCER_RE.test(nameOf(target));
}
export function balancerV3ActionRequirementsV1(target,selected){
  if(!isBalancerV3TargetV1(target))return{kind:'GENERIC'};
  const name=nameOf(target),signature=String(selected?.signature??'');
  if(/CurveYieldPoolFactoryWrapper\.sol:/.test(name)&&/^create(?:Weighted|Stable|StableSurge|GyroECLP|ReClamm)Pool\(/.test(signature)){
    // Creator synthesis handles the payable, predicted-address and policy
    // constraints. ABI-random telemetry cannot invoke these entrypoints.
    return{kind:'UNROUTABLE',reason:'CURVEYIELD_WRAPPER_CREATION_REQUIRES_STAGE2_PREDICTION_AND_PAYABLE_FEE'};
  }
  if(/PermanentLiquidityVaultV2\.sol:/.test(name)&&/^(?:recordPermanentLiquidity|executeCreatorMigration|migrateAdminLot|requestCreatorMigration|approveCreatorMigration)\(/.test(signature)){
    return{kind:'UNROUTABLE',reason:'CURVEYIELD_PERMANENT_LIQUIDITY_REQUIRES_EXISTING_POOL_AND_SETTLEMENT_LOT'};
  }
  if(/FeeSettlementRouter\.sol:/.test(name)&&/^(?:settle|collect|distribute|execute|process|swap)\w*\(/.test(signature)){
    return{kind:'UNROUTABLE',reason:'CURVEYIELD_SETTLEMENT_REQUIRES_INITIALIZED_POOL_AND_ROUTE_REGISTRATION'};
  }
  if(/contracts\/factories\/CurveYield\w+PoolFactory\.sol:/.test(name)&&/^create\(/.test(signature)){
    return{kind:'UNROUTABLE',reason:'CURVEYIELD_FACTORY_CALLER_MUST_BE_ALLOWLISTED_WRAPPER'};
  }
  if(/(?:RouterHooks|CompositeLiquidityRouterHooks|BufferRouterHooks)\.sol:/.test(name)||/^(?:[A-Za-z0-9_]*Hook|query[A-Z][^(]*)\(/.test(signature)){
    return{kind:'UNROUTABLE',reason:'BALANCER_V3_HOOK_REQUIRES_VAULT_UNLOCK_CALLBACK'};
  }
  if(/ProtocolFeeController\.sol:/.test(name)&&/^registerPool\(/.test(signature)){
    return{kind:'UNROUTABLE',reason:'BALANCER_V3_REGISTER_POOL_MUST_BE_CALLED_BY_VAULT'};
  }
  if(/Pool.*Factory|WeightedPool8020Factory/.test(name)&&/^create\(/.test(signature)){
    return{kind:'FACTORY_CREATE'};
  }
  if(/(?:VaultExtension|VaultAdmin)\.sol:/.test(name)&&(target.contextType??'DIRECT')==='DIRECT'){
    return{kind:'UNROUTABLE',reason:'BALANCER_V3_REQUIRES_REAL_VAULT_DELEGATE_CONTEXT'};
  }
  if(/\/Vault\.sol:Vault$/.test(name)&&/^(?:addLiquidity|removeLiquidity|swap|initialize|registerPool)\(/.test(signature)){
    return{kind:'UNROUTABLE',reason:'BALANCER_V3_VAULT_INTERNAL_REQUIRES_ROUTER_OR_FACTORY'};
  }
  if(/(?:Router|LiquidityRouter)(?:\.sol:|$)/.test(name)&&/^(?:initialize|addLiquidity|removeLiquidity|swap)/.test(signature)){
    return{kind:'ROUTER_POOL_STATE_REQUIRED'};
  }
  return{kind:'GENERIC'};
}

export async function discoverBalancerV3PoolsV1({provider,ethers,targets=[],valuePool={},actors=[]}={}){
  const systemTargets=targets.filter(isBalancerV3TargetV1);
  const evidence={
    schemaVersion:'curveyield-phase0-balancer-v3-call-context-v1',
    protocol:'BALANCER_V3_VAULT_UNLOCK_ROUTER_EXECUTION',
    active:systemTargets.length>0,
    status:'NOT_APPLICABLE',vaults:[],pools:[],
    limitations:[],
    candidateCount:0,hasCurveYieldWrapper:systemTargets.some(x=>/CurveYieldPoolFactoryWrapper\.sol:/.test(nameOf(x)))
  };
  if(!systemTargets.length)return evidence;
  // Only the main Vault owns registration state. A standalone VaultExtension or
  // ProtocolFeeController is never a substitute for it.
  const vaults=systemTargets.filter(t=>/\/Vault\.sol:Vault$/.test(nameOf(t))&&(t.contextType??'DIRECT')==='DIRECT');
  const factoryPools=[],factoryKinds=new Map();
  const factories=systemTargets.filter(t=>
    /Factory/.test(nameOf(t))&&
    (t.contextType??'DIRECT')==='DIRECT'&&
    (t.artifact?.abi??[]).some(f=>f?.name==='getPools'&&f?.type==='function')
  );
  for(const factory of factories.slice(0,8)){
    try{
      const c=new ethers.Contract(factory.address,['function getPools() view returns (address[])'],provider);
      const poolList=await c.getPools();
      if(Array.isArray(poolList)){
        const kind=/StableSurge/i.test(nameOf(factory))?'STABLE_SURGE':/Weighted/i.test(nameOf(factory))?'WEIGHTED':/Stable/i.test(nameOf(factory))?'STABLE':'UNKNOWN';
        for(const pool of poolList.slice(0,50)){factoryPools.push(pool);factoryKinds.set(lower(pool),kind);}
      }
    }catch(error){
      evidence.limitations.push({type:'FACTORY_POOL_ENUMERATION_FAILED',factory:factory.address,message:String(error?.shortMessage??error?.message??error).slice(0,300)});
    }
  }
  const registeredCandidates=addresses(ethers,[
    ...factoryPools,
    ...(valuePool.created??[]),
    ...targets.filter(t=>/Pool(?:\.sol:|$)/.test(nameOf(t))&&!/Factory|Router|Controller|Vault/.test(nameOf(t))).map(t=>t.address),
    ...(valuePool.pools??[]),
    ...Object.keys(valuePool.associations??{})
  ]).slice(0,120);
  evidence.candidateCount=registeredCandidates.length;
  for(const vault of vaults.slice(0,3)){
    const entry={address:vault.address,verified:false,extension:null};
    evidence.vaults.push(entry);
    try{
      const contract=new ethers.Contract(vault.address,VIEW_ABI,provider);
      entry.extension=await contract.getVaultExtension();
      if(!ADDRESS_RE.test(String(entry.extension))||await provider.getCode(entry.extension)==='0x')throw Error('unlinked VaultExtension');
      entry.verified=true;
      for(const pool of registeredCandidates){
        let registered=false;
        try{registered=await contract.isPoolRegistered(pool);}catch{}
        if(!registered)continue;
        const initialized=await contract.isPoolInitialized(pool).catch(()=>false);
        const tokens=addresses(ethers,await contract.getPoolTokens(pool).catch(()=>[]));
        if(tokens.length<2){evidence.limitations.push({type:'REGISTERED_POOL_TOKENS_UNAVAILABLE',vault:vault.address,pool});continue;}
        const bptHolders=[];
        if(initialized){
          const bpt=new ethers.Contract(pool,['function balanceOf(address) view returns (uint256)'],provider);
          for(const actor of actors.slice(0,8)){
            const amount=await bpt.balanceOf(actor).catch(()=>0n);
            if(BigInt(amount)>0n)bptHolders.push({actor,amount:BigInt(amount).toString()});
          }
        }
        evidence.pools.push({address:pool,poolType:factoryKinds.get(lower(pool))??'UNKNOWN',vault:vault.address,registered:true,initialized,tokens,tokenOrder:'VAULT_GET_POOL_TOKENS',bptHolders});
      }
    }catch(error){
      entry.error=String(error?.shortMessage??error?.message??error).slice(0,500);
      evidence.limitations.push({type:'VAULT_CONTEXT_NOT_VERIFIED',vault:vault.address,message:entry.error});
    }
  }
  evidence.status=!evidence.vaults.some(v=>v.verified)?'NO_VERIFIED_VAULT':!evidence.pools.length?'NO_REGISTERED_POOLS':evidence.pools.some(p=>p.initialized)?'INITIALIZED_POOL_AVAILABLE':'REGISTERED_POOLS_REQUIRE_INITIALIZATION';
  return evidence;
}
// Stage 3 protocol lifecycle: initialize registered Balancer pools before
// sampling random economic actions. Calling Router.initialize is the real
// external entrypoint; Vault.unlock and pool hooks cannot be called directly.
export async function bootstrapBalancerV3PoolsV1({provider,ethers,targets=[],valuePool={},actors=[]}={}){
  const discovery=await discoverBalancerV3PoolsV1({provider,ethers,targets,valuePool,actors});
  const report={schemaVersion:'curveyield-phase0-balancer-v3-bootstrap-v1',protocol:'BALANCER_V3',discoveryStatus:discovery.status,attempts:[],initializedPoolCount:0,verifiedInitializedPools:discovery.pools.filter(p=>p.initialized).length,limitations:[]};
  if(!discovery.active){report.status='NOT_APPLICABLE';return report;}
  const router=targets.find(t=>/\/Router\.sol:Router$/.test(nameOf(t))&&(t.contextType??'DIRECT')==='DIRECT');
  if(!router){report.status='NO_ROUTER_DEPLOYMENT';return report;}
  const selected=router.functions?.find(f=>f.signature==='initialize(address,address[],uint256[],uint256,bool,bytes)');
  if(!selected){report.status='ROUTER_INITIALIZE_ABI_UNAVAILABLE';return report;}
  const contract=new ethers.Contract(router.address,['function initialize(address,address[],uint256[],uint256,bool,bytes) payable returns (uint256)'],provider);
  const vaultRead=['function isPoolInitialized(address) view returns (bool)','function getPoolTokens(address) view returns (address[])'];
  for(const pool of discovery.pools.filter(p=>p.registered&&!p.initialized).slice(0,6)){
    const plan=buildBalancerV3ActionV1({ethers,target:router,selected,discovery:{...discovery,pools:[pool]},valuePool,actors});
    const row={pool:pool.address,vault:pool.vault,status:'NOT_EXECUTED',tokens:pool.tokens};
    report.attempts.push(row);
    if(plan.kind!=='READY'){row.status='PROTOCOL_INPUTS_UNAVAILABLE';row.reason=plan.reason;continue;}
    const iface=new ethers.Interface(contract.interface.fragments),data=iface.encodeFunctionData(selected.signature,plan.args);
    try{
      const from=plan.sender,txArgs={from,to:router.address,data,value:0n};
      await provider.call(txArgs);
      const gas=await provider.estimateGas(txArgs);
      const transaction=await (await provider.getSigner(from)).sendTransaction({to:router.address,data,value:0n,gasLimit:gas+gas/2n+100000n});
      const receipt=await transaction.wait();
      const vault=new ethers.Contract(pool.vault,vaultRead,provider);
      const onChain=await vault.isPoolInitialized(pool.address);
      row.transactionHash=transaction.hash;row.blockNumber=receipt.blockNumber;row.receiptStatus=receipt.status;
      row.status=Number(receipt.status)===1&&onChain===true?'INITIALIZED_ONCHAIN':'INITIALIZATION_NOT_CONFIRMED';
      if(row.status==='INITIALIZED_ONCHAIN')report.initializedPoolCount++;
    }catch(error){
      row.status='ROUTER_INITIALIZATION_REVERTED';
      row.error=String(error?.shortMessage??error?.message??error).slice(0,900);
    }
  }
  // Balancer v3 Router burns the BPT held by the liquidity provider on exit.
  // Its spender is the Router (NOT a pool contract, and not Permit2).
  // Bootstrap approvals on the actual freshly minted BPT using standard ERC20
  // transactions, then read back allowance to prove they took effect.
  report.bptRouterApprovals=[];
  const bptAbi=[
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)'
  ];
  for(const pool of discovery.pools.slice(0,6)){
    const vault=new ethers.Contract(pool.vault,['function isPoolInitialized(address) view returns (bool)'],provider);
    if(!(await vault.isPoolInitialized(pool.address).catch(()=>false)))continue;
    const bpt=new ethers.Contract(pool.address,bptAbi,provider);
    for(const actor of addresses(ethers,actors).slice(0,8)){
      const row={pool:pool.address,actor,spender:router.address,status:'NOT_REQUIRED'};
      let held=0n;
      try{held=BigInt(await bpt.balanceOf(actor));}
      catch(error){row.status='BPT_BALANCE_UNAVAILABLE';row.error=String(error?.shortMessage??error?.message??error).slice(0,300);report.bptRouterApprovals.push(row);continue;}
      if(held<=0n)continue;
      row.heldBpt=held.toString();
      report.bptRouterApprovals.push(row);
      try{
        const current=BigInt(await bpt.allowance(actor,router.address));
        if(current<held){
          const tx=await bpt.connect(await provider.getSigner(actor)).approve(router.address,ethersMaxUint256V1());
          const receipt=await tx.wait();
          row.transactionHash=tx.hash;
          row.blockNumber=receipt?.blockNumber??null;
          if(Number(receipt?.status)!==1)throw Error('BPT approval receipt status was not success');
        }
        const confirmed=BigInt(await bpt.allowance(actor,router.address));
        row.confirmedAllowance=confirmed.toString();
        row.status=confirmed>=held?'VERIFIED_ROUTER_ALLOWANCE':'BPT_ROUTER_ALLOWANCE_INSUFFICIENT';
      }catch(error){
        row.status='BPT_ROUTER_APPROVAL_FAILED';
        row.error=String(error?.shortMessage??error?.message??error).slice(0,600);
        report.limitations.push({type:row.status,pool:pool.address,actor,message:row.error});
      }
    }
  }
  console.log(`[phase0-balancer] Stage3 BPT Router allowances; required=${report.bptRouterApprovals.length} verified=${report.bptRouterApprovals.filter(x=>x.status==='VERIFIED_ROUTER_ALLOWANCE').length}`);
  report.verifiedInitializedPools+=report.initializedPoolCount;
  report.status=report.verifiedInitializedPools>0?'INITIALIZED_POOL_AVAILABLE':discovery.pools.length?'INITIALIZATION_FAILED':'NO_REGISTERED_POOLS';
  return report;
}
function ethersMaxUint256V1(){return(1n<<256n)-1n;}
function amountForTokenV1(token,valuePool){
  const row=(valuePool?.tokens??[]).find(t=>lower(t.address??t)===lower(token));
  const decimals=Number(row?.decimals??18),units=10n**BigInt(Number.isInteger(decimals)&&decimals>=0&&decimals<=24?decimals:18);
  const funded=BigInt(row?.fundedAmount??'0');
  if(funded<=0n)return null;
  return funded<units?funded:units;
}
export function choosePoolV1(pools,initialized,poolSelectionIndex=0){
  const eligible=pools.filter(p=>p.initialized===initialized&&Array.isArray(p.tokens)&&p.tokens.length>=2);
  if(!eligible.length)return null;
  const index=Number.isSafeInteger(poolSelectionIndex)?poolSelectionIndex:0;
  return eligible[((index%eligible.length)+eligible.length)%eligible.length];
}
// BPT exits must use actual initialized holder balances, not 1 wei of BPT.
export function bptWithdrawalAmountV1(holderBalance){
  const balance=BigInt(holderBalance??0);
  if(balance<=1n)return 0n;
  const proportional=balance/100n; // 1% of the current verified holding
  return proportional>0n?proportional:1n;
}
// BPT is an ERC20 with real holder balances, not a token with arbitrary
// sender/amount parameters. Preserve caller authorization on transferFrom.
export function balancerV3BptTransferRecipeV1({target,selected,discovery,actors=[]}={}){
  const signature=String(selected?.signature??'');
  const transfer=signature==='transfer(address,uint256)';
  const transferFrom=signature==='transferFrom(address,address,uint256)';
  if(!transfer&&!transferFrom)return null;
  const pool=(discovery?.pools??[]).find(p=>lower(p.address)===lower(target?.address)&&p.initialized);
  if(!pool)return null;
  const funded=(pool.bptHolders??[]).filter(h=>BigInt(h.amount??0)>1n);
  if(!funded.length)return{kind:'BLOCKED',reason:'BALANCER_BPT_REQUIRES_VERIFIED_FUNDED_HOLDER',pool:pool.address};
  const holder=funded[0],owner=holder.actor;
  const recipient=actors.find(a=>lower(a)!==lower(owner))??null;
  if(!recipient)return{kind:'BLOCKED',reason:'BALANCER_BPT_REQUIRES_DISTINCT_RECIPIENT',pool:pool.address};
  const amount=bptWithdrawalAmountV1(holder.amount);
  if(amount<=0n)return{kind:'BLOCKED',reason:'BALANCER_BPT_BALANCE_TOO_SMALL',pool:pool.address};
  const spender=transferFrom?(actors.find(a=>lower(a)!==lower(owner)&&lower(a)!==lower(recipient))??recipient):owner;
  return{
    kind:'READY',protocol:'BALANCER_V3',pool:pool.address,
    basis:'VERIFIED_POOL_BPT_HOLDER_TRANSFER_RECIPE',
    sender:spender,
    args:transferFrom?[owner,recipient,amount]:[recipient,amount],
    value:0n,transferFrom,owner,spender,recipient,amount:amount.toString(),
    holderBalance:holder.amount
  };
}
export function buildBalancerV3ActionV1({ethers,target,selected,discovery,valuePool={},actors=[],poolSelectionIndex=0}={}){
  const requirement=balancerV3ActionRequirementsV1(target,selected);
  if(requirement.kind==='GENERIC')return{kind:'GENERIC'};
  if(discovery?.hasCurveYieldWrapper&&/^create\(/.test(String(selected?.signature??''))&&/Factory/.test(nameOf(target))){
    return{kind:'BLOCKED',reason:'FACTORY_CREATE_REQUIRES_CURVEYIELD_ALLOWLISTED_WRAPPER'};
  }
  if(requirement.kind==='UNROUTABLE')return{kind:'BLOCKED',reason:requirement.reason};
  if(requirement.kind==='FACTORY_CREATE'){
    const built=buildBalancerV3CreatorArgumentsV1({ethers,candidate:{target,selected},attempt:0,actor:actors[0],valuePool});
    if(!built)return{kind:'BLOCKED',reason:'BALANCER_V3_FACTORY_NEEDS_FUNDED_SORTED_TOKENS_AND_KNOWN_ABI'};
    return{kind:'READY',sender:actors[0],args:built.args,value:0n,pool:null,protocol:'BALANCER_V3',basis:built.basis,createsPool:true};
  }
  const signature=String(selected.signature??'');
  const isInit=signature==='initialize(address,address[],uint256[],uint256,bool,bytes)';
  const isUnbalanced=signature==='addLiquidityUnbalanced(address,uint256[],uint256,bool,bytes)';
  const isProportional=signature==='addLiquidityProportional(address,uint256[],uint256,bool,bytes)';
  const isSwapIn=signature==='swapSingleTokenExactIn(address,address,address,uint256,uint256,uint256,bool,bytes)';
  const isSwapOut=signature==='swapSingleTokenExactOut(address,address,address,uint256,uint256,uint256,bool,bytes)';
  const isRemove=signature==='removeLiquidityProportional(address,uint256,uint256[],bool,bytes)';
  const isRemoveSingle=signature==='removeLiquiditySingleTokenExactIn(address,uint256,address,uint256,bool,bytes)';
  if(!isInit&&!isUnbalanced&&!isProportional&&!isSwapIn&&!isSwapOut&&!isRemove&&!isRemoveSingle){
    return{kind:'BLOCKED',reason:'BALANCER_V3_NEEDS_PROTOCOL_RECIPE_FOR_SIGNATURE',signature};
  }
  const pool=choosePoolV1(discovery?.pools??[],!isInit,poolSelectionIndex);
  if(!pool)return{kind:'BLOCKED',reason:isInit?'NO_REGISTERED_UNINITIALIZED_POOL':'NO_INITIALIZED_BALANCER_POOL'};
  const amounts=pool.tokens.map(token=>amountForTokenV1(token,valuePool));
  if(amounts.some(amount=>amount===null||amount===0n))return{kind:'BLOCKED',reason:'POOL_TOKEN_NOT_FUNDED',pool:pool.address};
  if(!actors.length)return{kind:'BLOCKED',reason:'NO_FUNDED_ACTORS'};
  const bpt=(pool.bptHolders??[]).find(row=>BigInt(row.amount??'0')>0n);
  if((isRemove||isRemoveSingle)&&!bpt)return{kind:'BLOCKED',reason:'NO_FUNDED_BALANCER_POOL_SHARE_HOLDER',pool:pool.address};
  const bptIn=(isRemove||isRemoveSingle)?bptWithdrawalAmountV1(bpt?.amount):0n;
  if((isRemove||isRemoveSingle)&&bptIn<=0n)return{kind:'BLOCKED',reason:'BPT_HOLDER_BALANCE_TOO_SMALL_FOR_EXIT',pool:pool.address};
  // Router unlocks Vault and settles internal transient token deltas atomically.
  // Amounts follow the Vault's registered token order.
  // Swapping the entire funded amount would exhaust the newly initialized
  // pool's reserves and revert; start with a bounded 0.1% of one token unit.
  const smallSwapIn=amounts[0]>1000n?amounts[0]/1000n:1n;
  const smallSwapOut=amounts[1]>1000n?amounts[1]/1000n:1n;
  const maxSwapIn=amounts[0]>100n?amounts[0]/100n:1n;
  const args=isInit?[pool.address,pool.tokens,amounts,0n,false,'0x']
    :isUnbalanced?[pool.address,amounts,0n,false,'0x']
    :isProportional?[pool.address,amounts,1n,false,'0x']
    :isSwapIn?[pool.address,pool.tokens[0],pool.tokens[1],smallSwapIn,1n,ethersMaxUint256V1(),false,'0x']
    :isSwapOut?[pool.address,pool.tokens[0],pool.tokens[1],smallSwapOut,maxSwapIn,ethersMaxUint256V1(),false,'0x']
    :isRemove?[pool.address,bptIn,pool.tokens.map(()=>0n),false,'0x']
    :[pool.address,bptIn,pool.tokens[0],1n,false,'0x'];
  return{kind:'READY',sender:(isRemove||isRemoveSingle)?bpt.actor:actors[0],args,value:0n,pool:pool.address,protocol:'BALANCER_V3',basis:'VERIFIED_VAULT_POOL_STATE_ROUTER_ARGUMENTS',poolInitialized:pool.initialized,...((isRemove||isRemoveSingle)?{verifiedBptBalance:bpt.amount,bptInput:bptIn.toString()}:{} )};
}
