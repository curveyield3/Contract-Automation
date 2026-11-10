function abiRowsV1(abi){
  if(Array.isArray(abi))return abi;
  if(Array.isArray(abi?.abi))return abi.abi;
  if(abi&&typeof abi==='object')return Object.values(abi).filter(x=>x&&typeof x==='object'&&typeof x.type==='string');
  return[];
}

function revertDataV1(error){
  for(const value of [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.stages?.RECEIPT?.error?.data,
    error?.stages?.PREFLIGHT?.error?.data,
    error?.stages?.PREFLIGHT?.callProbe?.error?.data
  ]){
    const candidate=typeof value==='string'?value:(typeof value?.data==='string'?value.data:null);
    if(candidate&&/^0x[0-9a-fA-F]{8}/.test(candidate))return candidate;
  }
  return null;
}

export function buildCompiledArtifactErrorSelectorIndexV1({ethers,artifacts=[]}){
  const bySelector=new Map();
  for(const artifact of artifacts){
    let iface;
    try{iface=new ethers.Interface(abiRowsV1(artifact?.abi));}catch{continue;}
    for(const fragment of iface.fragments.filter(x=>x?.type==='error')){
      let signature;
      try{signature=fragment.format('sighash');}catch{continue;}
      const selector=ethers.id(signature).slice(0,10).toLowerCase();
      const rows=bySelector.get(selector)??[];
      if(!rows.some(x=>x.signature===signature)){
        rows.push({
          name:fragment.name,
          signature,
          qualifiedName:artifact?.sourceName&&artifact?.contractName?artifact.sourceName+':'+artifact.contractName:(artifact?.contractName??null)
        });
        bySelector.set(selector,rows);
      }
    }
  }
  return bySelector;
}

export function decodeTelemetryRevertReasonV1({ethers,error,selectorIndex}){
  const data=revertDataV1(error);
  const selector=typeof data==='string'?data.slice(0,10).toLowerCase():null;
  if(selector&&selectorIndex?.has(selector)){
    const matches=selectorIndex.get(selector);
    return{kind:'CUSTOM_ERROR',selector,reason:matches.map(x=>x.signature).join(' | ')};
  }
  if(selector==='0x08c379a0'){
    try{
      const [reason]=ethers.AbiCoder.defaultAbiCoder().decode(['string'],'0x'+data.slice(10));
      return{kind:'STRING_REVERT',selector,reason:String(reason)};
    }catch{}
  }
  if(selector==='0x4e487b71'){
    try{
      const [code]=ethers.AbiCoder.defaultAbiCoder().decode(['uint256'],'0x'+data.slice(10));
      return{kind:'PANIC',selector,reason:`Panic(0x${BigInt(code).toString(16)})`};
    }catch{}
  }
  if(error?.decodedCustomError?.signature){
    return{kind:'CUSTOM_ERROR',selector,reason:String(error.decodedCustomError.signature)};
  }
  if(typeof error?.reason==='string'&&error.reason.trim()){
    return{kind:'STRING_REVERT',selector,reason:error.reason};
  }
  const short=String(error?.shortMessage??'');
  const quoted=short.match(/execution reverted:\s*["']([^"']+)["']/i);
  if(quoted)return{kind:'STRING_REVERT',selector,reason:quoted[1]};
  return{kind:'UNKNOWN_REVERT',selector,reason:selector??'UNKNOWN_REVERT'};
}

export function topDecodedTelemetryRevertsV1({ethers,artifacts=[],rows=[],limit=15}){
  const selectorIndex=buildCompiledArtifactErrorSelectorIndexV1({ethers,artifacts});
  const counts=new Map();
  for(const row of rows){
    if(!['SIMULATED_REJECTION','MINED_REVERT'].includes(row?.executionOutcome))continue;
    const candidates=[
      row?.error,
      row?.stages?.RECEIPT?.error,
      row?.stages?.PREFLIGHT?.error,
      row?.stages?.PREFLIGHT?.callProbe?.error
    ].filter(Boolean);
    let decoded=decodeTelemetryRevertReasonV1({ethers,error:candidates[0]??null,selectorIndex});
    for(const candidate of candidates.slice(1)){
      if(decoded.kind!=='UNKNOWN_REVERT')break;
      decoded=decodeTelemetryRevertReasonV1({ethers,error:candidate,selectorIndex});
    }
    const key=JSON.stringify([decoded.kind,decoded.selector,decoded.reason]);
    const current=counts.get(key)??{...decoded,count:0};
    current.count++;
    counts.set(key,current);
  }
  return[...counts.values()].sort((a,b)=>b.count-a.count||String(a.reason).localeCompare(String(b.reason))).slice(0,limit);
}


export const PHASE0_CANONICAL_MAINNET_TOKENS_V1=Object.freeze([
  {symbol:'WETH',address:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'},
  {symbol:'USDC',address:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'},
  {symbol:'USDT',address:'0xdac17f958d2ee523a2206206994597c13d831ec7'},
  {symbol:'DAI',address:'0x6b175474e89094c44da98b954eedeac495271d0f'},
  {symbol:'WBTC',address:'0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'},
  {symbol:'wstETH',address:'0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'}
]);
export const PHASE0_PERMIT2_ADDRESS_V1='0x000000000022d473030f116ddee9f6b43ac78ba3';
// Stage 5 fixture-health control: prove that funded fork tokens can execute real
// before/after accounting changes. Never count this as an audited-project transition.
export async function executeForkTokenAccountingWitnessV1({provider,ethers,valuePool={},actors=[]}={}){
  const evidence={
    schemaVersion:'curveyield-phase0-fork-token-accounting-witness-v1',
    scope:'FORK_TOKEN_FIXTURE_ONLY',
    policy:'ISOLATED_EVM_SNAPSHOT_REAL_ERC20_TRANSFER_AND_READBACK',
    countsAsProjectEconomicTransition:false,
    status:'NO_VERIFIED_FIXTURE_TRANSITION',
    checkedTokens:0,
    attempts:[],
    verifiedTransitions:0
  };
  if(actors.length<2||String(actors[0]).toLowerCase()===String(actors[1]).toLowerCase()){
    evidence.status='UNAVAILABLE_NO_DISTINCT_ACTORS';
    return evidence;
  }
  const sender=ethers.getAddress(actors[0]),receiver=ethers.getAddress(actors[1]);
  const abi=['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)'];
  const tokens=(valuePool.tokens??[]).filter(token=>/^0x[0-9a-fA-F]{40}$/.test(String(token?.address??token))).slice(0,6);
  for(const tokenInfo of tokens){
    const address=ethers.getAddress(String(tokenInfo.address??tokenInfo));
    const item={token:address,sender,receiver,amount:'1',status:'NOT_ATTEMPTED'};
    evidence.attempts.push(item);evidence.checkedTokens++;
    let snapshotId=null;
    try{
      const code=await provider.getCode(address);
      if(!code||code==='0x'){item.status='NO_TOKEN_CODE';continue;}
      const token=new ethers.Contract(address,abi,provider);
      const beforeSender=BigInt(await token.balanceOf(sender));
      const beforeReceiver=BigInt(await token.balanceOf(receiver));
      item.before={sender:beforeSender.toString(),receiver:beforeReceiver.toString()};
      if(beforeSender<1n){item.status='UNFUNDED_SENDER';continue;}
      snapshotId=await provider.send('evm_snapshot',[]);
      const signer=await provider.getSigner(sender);
      const tx=await token.connect(signer).transfer(receiver,1n);
      const receipt=await tx.wait();
      item.transactionHash=receipt?.hash??tx.hash;
      item.receiptStatus=receipt?.status??null;
      const afterSender=BigInt(await token.balanceOf(sender));
      const afterReceiver=BigInt(await token.balanceOf(receiver));
      item.after={sender:afterSender.toString(),receiver:afterReceiver.toString()};
      item.delta={sender:(afterSender-beforeSender).toString(),receiver:(afterReceiver-beforeReceiver).toString()};
      item.status=receipt?.status===1&&(afterSender!==beforeSender||afterReceiver!==beforeReceiver)?'VERIFIED_ACCOUNTING_DELTA':'NO_VERIFIED_ACCOUNTING_DELTA';
      if(item.status==='VERIFIED_ACCOUNTING_DELTA')evidence.verifiedTransitions++;
    }catch(error){
      item.status='TRANSFER_OR_READ_FAILED';
      item.error=String(error?.shortMessage??error?.message??error).slice(0,800);
    }finally{
      if(snapshotId!==null){
        const reverted=await provider.send('evm_revert',[snapshotId]);
        if(reverted!==true){
          const error=new Error('Accounting witness failed to restore isolated fixture snapshot');
          error.code='PHASE0_ACCOUNTING_WITNESS_RESET_FAILED';
          throw error;
        }
        item.snapshotRestored=true;
      }
    }
    if(evidence.verifiedTransitions>0)break;
  }
  if(evidence.verifiedTransitions>0)evidence.status='VERIFIED_FIXTURE_ACCOUNTING_TRANSITION';
  else if(evidence.checkedTokens===0)evidence.status='UNAVAILABLE_NO_FORK_TOKENS';
  return evidence;
}

export const PHASE0_MEDUSA_SENDERS_V1=Object.freeze([
  '0x0000000000000000000000000000000000010000',
  '0x0000000000000000000000000000000000020000',
  '0x0000000000000000000000000000000000030000',
  '0x0000000000000000000000000000000000040000'
]);

const ERC20_VIEW_ABI_V1=[
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];
const ERC20_APPROVE_ABI_V1=[
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)'
];
const PERMIT2_APPROVE_ABI_V1=[
  'function approve(address token,address spender,uint160 amount,uint48 expiration)'
];
const PRIVILEGED_VIEW_TERMS_V1=['owner','admin','governance','authority','authorizer','pendingowner','guardian','manager'];

function normalizedAddressV1(ethers,value){
  try{return ethers.getAddress(String(value));}catch{return null;}
}
function outputContainsAddressV1(param){
  if(!param)return false;
  if(param.baseType==='array')return outputContainsAddressV1(param.arrayChildren);
  if(param.baseType==='tuple')return (param.components??[]).some(outputContainsAddressV1);
  return String(param.type??'')==='address';
}
function collectAddressesV1(ethers,value,out=new Set()){
  if(typeof value==='string'){
    const address=normalizedAddressV1(ethers,value);
    if(address)out.add(address);
    return out;
  }
  if(Array.isArray(value)){
    for(const child of value)collectAddressesV1(ethers,child,out);
    return out;
  }
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))collectAddressesV1(ethers,child,out);
  }
  return out;
}
function isPrivilegedViewNameV1(name){
  const n=String(name??'').toLowerCase().replace(/[^a-z0-9]/g,'');
  return PRIVILEGED_VIEW_TERMS_V1.some(term=>n===term||n.startsWith(term)||n.endsWith(term));
}
async function callNoArgV1(contract,fragment){
  return contract.getFunction(fragment.format('sighash')).staticCall();
}
async function probeErc20ShapeV1({provider,ethers,address,probeHolder}){
  const c=new ethers.Contract(address,ERC20_VIEW_ABI_V1,provider);
  const [decimals,totalSupply,balance]=await Promise.all([
    c.getFunction('decimals()').staticCall(),
    c.getFunction('totalSupply()').staticCall(),
    c.getFunction('balanceOf(address)').staticCall(probeHolder)
  ]);
  const d=Number(decimals);
  if(!Number.isInteger(d)||d<0||d>255)throw new Error('ERC20 decimals() returned an invalid value');
  return{decimals:d,totalSupply:BigInt(totalSupply).toString(),probeBalance:BigInt(balance).toString()};
}

export async function discoverValuePoolV1({provider,ethers,targets=[],actors=[]}){
  const addressSet=new Set(),tokens=[],tokenByAddress=new Map(),associations={},privileged=new Set(),receipts=[],gaps=[];
  for(const actor of actors){
    const address=normalizedAddressV1(ethers,actor);
    if(address)addressSet.add(address);
  }
  const deployer=normalizedAddressV1(ethers,actors[0]);
  if(deployer)privileged.add(deployer);
  let discoveredTargets=0;
  await mapLimitV1(targets,6,async target=>{
    const targetAddress=normalizedAddressV1(ethers,target?.address);
    if(!targetAddress)return;
    addressSet.add(targetAddress);
    const related=associations[targetAddress]??new Set();
    associations[targetAddress]=related;
    let iface,contract;
    try{
      iface=new ethers.Interface(abiRowsV1(target?.artifact?.abi));
      contract=new ethers.Contract(targetAddress,abiRowsV1(target?.artifact?.abi),provider);
    }catch(error){
      gaps.push({type:'ASSOCIATION_ABI_UNAVAILABLE',target:targetAddress,message:String(error?.message??error).slice(0,800)});
      return;
    }
    for(const fragment of iface.fragments.filter(x=>x?.type==='function'&&['view','pure'].includes(x.stateMutability)&&x.inputs.length===0&&(x.outputs??[]).some(outputContainsAddressV1))){
      try{
        const value=await callNoArgV1(contract,fragment);
        const found=collectAddressesV1(ethers,value);
        for(const address of found){related.add(address);addressSet.add(address);}
        if(isPrivilegedViewNameV1(fragment.name))for(const address of found)privileged.add(address);
        receipts.push({kind:'ASSOCIATION_VIEW',target:targetAddress,function:fragment.format('sighash'),addresses:[...found],status:'PASS'});
      }catch(error){
        gaps.push({type:'ASSOCIATION_VIEW_REVERTED',target:targetAddress,function:fragment.format('sighash'),message:String(error?.shortMessage??error?.message??error).slice(0,800)});
      }
    }
    discoveredTargets++;
    if(discoveredTargets%5===0||discoveredTargets===targets.length)console.log(`[phase0-fixture] association discovery ${discoveredTargets}/${targets.length} targets`);
  });
  console.log('[phase0-fixture] association discovery complete; canonical token probes started');
  for(const row of PHASE0_CANONICAL_MAINNET_TOKENS_V1){
    const address=ethers.getAddress(row.address);
    let code='0x';
    try{code=await provider.getCode(address);}catch(error){
      gaps.push({type:'CANONICAL_TOKEN_CODE_READ_FAILED',symbol:row.symbol,address,message:String(error?.message??error).slice(0,800)});
      continue;
    }
    receipts.push({kind:'CANONICAL_TOKEN_CODE_PROBE',symbol:row.symbol,address,codePresent:Boolean(code&&code!=='0x'),status:'PASS'});
    if(!code||code==='0x')continue;
    let shape=null;
    try{shape=await probeErc20ShapeV1({provider,ethers,address,probeHolder:deployer??ethers.ZeroAddress});receipts.push({kind:'CANONICAL_TOKEN_ERC20_PROBE',symbol:row.symbol,address,decimals:shape.decimals,totalSupply:shape.totalSupply,status:'PASS'});}
    catch(error){gaps.push({type:'CANONICAL_TOKEN_METADATA_READ_FAILED',symbol:row.symbol,address,message:String(error?.shortMessage??error?.message??error).slice(0,800)});}
    const token={symbol:row.symbol,address,source:'CANONICAL_MAINNET',decimals:shape?.decimals??null,totalSupply:shape?.totalSupply??null};
    tokens.push(token);tokenByAddress.set(address.toLowerCase(),token);addressSet.add(address);
  }
  console.log('[phase0-fixture] canonical token probes complete; deployed target token probes started');
  await mapLimitV1(targets,6,async target=>{
    const address=normalizedAddressV1(ethers,target?.address);
    if(!address||tokenByAddress.has(address.toLowerCase()))return;
    try{
      const shape=await probeErc20ShapeV1({provider,ethers,address,probeHolder:deployer??ethers.ZeroAddress});
      const token={symbol:null,address,source:'DISCOVERED_ERC20_SHAPE',qualifiedName:target?.qualifiedName??null,decimals:shape.decimals,totalSupply:shape.totalSupply};
      tokens.push(token);tokenByAddress.set(address.toLowerCase(),token);addressSet.add(address);
      receipts.push({kind:'TARGET_ERC20_SHAPE_PROBE',address,qualifiedName:target?.qualifiedName??null,decimals:shape.decimals,totalSupply:shape.totalSupply,status:'PASS'});
    }catch{}
  });
  console.log(`[phase0-fixture] token discovery complete; discovered=${tokens.length}; gaps=${gaps.length}`);
  for(const address of privileged)addressSet.add(address);
  return{
    addresses:[...addressSet],
    tokens,
    associations,
    privileged:[...privileged],
    created:[],
    receipts,
    gaps
  };
}

function storageKeyV1(ethers,holder,slot,layout){
  const holderWord=ethers.zeroPadValue(holder,32);
  const slotWord=ethers.toBeHex(BigInt(slot),32);
  return ethers.keccak256(layout==='VYPER'?ethers.concat([slotWord,holderWord]):ethers.concat([holderWord,slotWord]));
}
async function storageAtV1(provider,address,key){
  return provider.send('eth_getStorageAt',[address,key,'latest']);
}
function ethersWordV1(value){
  const v=BigInt(value);
  if(v<0n||v>((1n<<256n)-1n))throw new Error('storage value outside uint256');
  return '0x'+v.toString(16).padStart(64,'0');
}
async function balanceOfV1({provider,ethers,token,holder}){
  const c=new ethers.Contract(token,ERC20_VIEW_ABI_V1,provider);
  return BigInt(await c.getFunction('balanceOf(address)').staticCall(holder));
}
async function findBalanceSlotV1({provider,ethers,token,holder}){
  let before;
  try{before=await balanceOfV1({provider,ethers,token,holder});}
  catch(error){return{status:'NOT_FOUND',reason:'BALANCE_OF_UNREADABLE',message:String(error?.shortMessage??error?.message??error).slice(0,800)};}
  const probe=before===0x13579bdf2468acen?0x2468ace13579bdfn:0x13579bdf2468acen;
  for(let slot=0;slot<=50;slot++){
    for(const layout of ['SOLIDITY','VYPER']){
      const key=storageKeyV1(ethers,holder,slot,layout);
      let original;
      try{
        original=await storageAtV1(provider,token,key);
        await provider.send('anvil_setStorageAt',[token,key,ethersWordV1(probe)]);
        const observed=await balanceOfV1({provider,ethers,token,holder});
        await provider.send('anvil_setStorageAt',[token,key,original]);
        if(observed===probe)return{status:'FOUND',slot,layout,key};
      }catch(error){
        if(original!==undefined)await provider.send('anvil_setStorageAt',[token,key,original]).catch(()=>{});
      }
    }
  }
  return{status:'NOT_FOUND'};
}
function uniqueAddressesV1(ethers,values=[]){
  const out=[],seen=new Set();
  for(const value of values){
    const address=normalizedAddressV1(ethers,value);
    if(!address)continue;
    const key=address.toLowerCase();if(seen.has(key))continue;seen.add(key);out.push(address);
  }
  return out;
}
function receiptRowV1(kind,receipt,extra={}){
  return{kind,...extra,transactionHash:receipt?.hash??null,blockNumber:receipt?.blockNumber??null,status:Number(receipt?.status??0),gasUsed:receipt?.gasUsed?.toString?.()??null};
}
async function sendEncodedV1({provider,ethers,from,to,iface,signature,args,gasLimit=300000n}){
  const hash=await provider.send('eth_sendTransaction',[{
    from,to,
    data:iface.encodeFunctionData(signature,args),
    gas:ethers.toQuantity(gasLimit)
  }]);
  const receipt=await provider.waitForTransaction(hash);
  if(Number(receipt?.status)!==1)throw new Error('transaction receipt status is not successful');
  return receipt;
}
async function mapLimitV1(items,limit,worker){
  const out=new Array(items.length);let next=0;
  async function lane(){
    while(true){
      const i=next++;if(i>=items.length)return;
      out[i]=await worker(items[i],i);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},lane));
  return out;
}

const PERMIT2_ALLOWANCE_VIEW_ABI_V1=['function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)'];
const MAX_UINT160_V1=(1n<<160n)-1n,MAX_UINT48_V1=(1n<<48n)-1n;
function nestedMappingKeyV1(ethers,keys,slot,layout){
  return keys.reduce((current,key)=>storageKeyV1(ethers,key,BigInt(current),layout),slot);
}
// Anvil-only fast path: prove the exact allowance mapping through its real getter, restore the
// probe word even on failed reads, and use ordinary approve transactions if verification fails.
async function probeVerifiedAllowanceMappingV1({provider,ethers,address,keys,read,probeWord,matches}){
  for(let slot=0;slot<=50;slot++)for(const layout of ['SOLIDITY','VYPER']){
    const key=nestedMappingKeyV1(ethers,keys,slot,layout);
    let original,match=false;
    try{
      original=await storageAtV1(provider,address,key);
      await provider.send('anvil_setStorageAt',[address,key,ethersWordV1(probeWord)]);
      match=matches(await read());
    }catch{}
    finally{
      if(original!==undefined)await provider.send('anvil_setStorageAt',[address,key,original]);
    }
    if(match)return{slot,layout};
  }
  return null;
}
async function writeVerifiedAllowanceV1({provider,ethers,address,keys,slot,read,matches,makeWord}){
  const key=nestedMappingKeyV1(ethers,keys,slot.slot,slot.layout);
  const original=await storageAtV1(provider,address,key);
  const desired=ethersWordV1(makeWord(BigInt(original)));
  let verified=false;
  try{
    if(BigInt(original)!==BigInt(desired))await provider.send('anvil_setStorageAt',[address,key,desired]);
    verified=matches(await read());
  }catch{}
  if(!verified)await provider.send('anvil_setStorageAt',[address,key,original]);
  return verified;
}

export async function fundActorsV1({provider,ethers,tokens=[],holders=[],spenders=[]}){
  const holderAddresses=uniqueAddressesV1(ethers,holders),spenderAddresses=uniqueAddressesV1(ethers,spenders);
  const gaps=[],rpcMutations=[],transactionReceipts=[],slotResults=[];
  const ethBalance=10n**24n,erc20Iface=new ethers.Interface(ERC20_APPROVE_ABI_V1),permit2Iface=new ethers.Interface(PERMIT2_APPROVE_ABI_V1);
  console.log(`[phase0-fixture] funding start; holders=${holderAddresses.length}; tokens=${tokens.length}; spenders=${spenderAddresses.length}`);
  for(const holder of holderAddresses){
    try{
      await provider.send('anvil_setBalance',[holder,ethers.toQuantity(ethBalance)]);
      rpcMutations.push({kind:'ETH_BALANCE_SET',holder,amountWei:ethBalance.toString(),status:'PASS'});
    }catch(error){gaps.push({type:'ETH_BALANCE_FUNDING_FAILED',holder,message:String(error?.message??error).slice(0,800)});}
  }
  for(const tokenRecord of tokens){
    const token=normalizedAddressV1(ethers,tokenRecord?.address??tokenRecord);
    if(!token)continue;
    let decimals=Number(tokenRecord?.decimals);
    if(!Number.isInteger(decimals)||decimals<0||decimals>70){
      try{decimals=(await probeErc20ShapeV1({provider,ethers,address:token,probeHolder:holderAddresses[0]??ethers.ZeroAddress})).decimals;}
      catch(error){
        const gap={type:'TOKEN_METADATA_UNAVAILABLE',token,message:String(error?.shortMessage??error?.message??error).slice(0,800)};
        gaps.push(gap);slotResults.push({token,status:'TOKEN_BALANCE_SLOT_NOT_FOUND',reason:gap.type});continue;
      }
    }
    const amount=1000000n*(10n**BigInt(decimals));
    const probeHolder=holderAddresses[0]??ethers.ZeroAddress;
    const slot=await findBalanceSlotV1({provider,ethers,token,holder:probeHolder});
    if(slot.status!=='FOUND'){
      const gap={type:'TOKEN_BALANCE_SLOT_NOT_FOUND',token,attemptedSlots:'0-50',layouts:['SOLIDITY','VYPER']};
      gaps.push(gap);slotResults.push({token,status:'TOKEN_BALANCE_SLOT_NOT_FOUND',decimals});continue;
    }
    let writes=0,verified=0;
    for(const holder of holderAddresses){
      const key=storageKeyV1(ethers,holder,slot.slot,slot.layout);
      try{
        await provider.send('anvil_setStorageAt',[token,key,ethersWordV1(amount)]);writes++;
        const observed=await balanceOfV1({provider,ethers,token,holder});
        if(observed!==amount)throw new Error(`balanceOf verification mismatch: expected ${amount} observed ${observed}`);
        verified++;
        rpcMutations.push({kind:'TOKEN_BALANCE_SET',token,holder,slot:slot.slot,layout:slot.layout,storageKey:key,amount:amount.toString(),status:'PASS'});
      }catch(error){gaps.push({type:'TOKEN_BALANCE_WRITE_VERIFICATION_FAILED',token,holder,slot:slot.slot,layout:slot.layout,message:String(error?.message??error).slice(0,800)});}
    }
    if(tokenRecord&&typeof tokenRecord==='object'){
      tokenRecord.decimals=decimals;
      tokenRecord.fundedAmount=verified===holderAddresses.length?amount.toString():null;
      tokenRecord.balanceSlot=slot.slot;tokenRecord.balanceLayout=slot.layout;
    }
    slotResults.push({token,status:'FOUND',slot:slot.slot,layout:slot.layout,decimals,fundedAmount:verified===holderAddresses.length?amount.toString():null,plannedFundedAmount:amount.toString(),holdersWritten:writes,holdersVerified:verified});
  }

  const allowanceSlots=new Map();
  for(const row of tokens){
    const token=normalizedAddressV1(ethers,row?.address??row);
    if(!token||!holderAddresses.length||!spenderAddresses.length)continue;
    const owner=holderAddresses[0],spender=spenderAddresses[0];
    const view=new ethers.Contract(token,ERC20_APPROVE_ABI_V1,provider);
    const probe=0x13579bdf2468acen;
    try{
      const slot=await probeVerifiedAllowanceMappingV1({
        provider,ethers,address:token,keys:[owner,spender],probeWord:probe,
        read:()=>view.getFunction('allowance(address,address)').staticCall(owner,spender),
        matches:value=>BigInt(value)===probe
      });
      if(slot)allowanceSlots.set(token.toLowerCase(),slot);
    }catch(error){gaps.push({type:'ERC20_ALLOWANCE_SLOT_PROBE_FAILED',token,message:String(error?.message??error).slice(0,800)});}
  }
  console.log(`[phase0-fixture] balances ready; allowance slots verified=${allowanceSlots.size}/${tokens.length}`);
  await mapLimitV1(holderAddresses,6,async holder=>{
    for(const row of tokens){
      const token=normalizedAddressV1(ethers,row?.address??row);if(!token)continue;
      const view=new ethers.Contract(token,ERC20_APPROVE_ABI_V1,provider);
      for(const spender of spenderAddresses){
        try{
          const slot=allowanceSlots.get(token.toLowerCase());
          const direct=slot&&await writeVerifiedAllowanceV1({
            provider,ethers,address:token,keys:[holder,spender],slot,makeWord:()=>ethers.MaxUint256,
            read:()=>view.getFunction('allowance(address,address)').staticCall(holder,spender),
            matches:value=>BigInt(value)===ethers.MaxUint256
          });
          if(direct){
            rpcMutations.push({kind:'ERC20_APPROVAL_STORAGE',token,holder,spender,slot:slot.slot,layout:slot.layout,status:'PASS'});
            continue;
          }
          const receipt=await sendEncodedV1({provider,ethers,from:holder,to:token,iface:erc20Iface,signature:'approve(address,uint256)',args:[spender,ethers.MaxUint256]});
          transactionReceipts.push(receiptRowV1('ERC20_APPROVAL',receipt,{token,holder,spender,amount:ethers.MaxUint256.toString()}));
        }catch(error){gaps.push({type:'ERC20_APPROVAL_FAILED',token,holder,spender,message:String(error?.shortMessage??error?.message??error).slice(0,1000)});}
      }
    }
  });
  console.log(`[phase0-fixture] direct approvals done; storage=${rpcMutations.filter(x=>x.kind==='ERC20_APPROVAL_STORAGE').length}; transactions=${transactionReceipts.filter(x=>x.kind==='ERC20_APPROVAL').length}`);

  let permit2={address:ethers.getAddress(PHASE0_PERMIT2_ADDRESS_V1),codePresent:false,status:'SKIPPED_NO_CODE'};
  try{
    const code=await provider.getCode(permit2.address);
    permit2.codePresent=Boolean(code&&code!=='0x');
    if(permit2.codePresent){
      permit2.status='PASS';
      const permit2View=new ethers.Contract(permit2.address,PERMIT2_ALLOWANCE_VIEW_ABI_V1,provider);
      let permit2Slot=null;
      if(holderAddresses.length&&tokens.length&&spenderAddresses.length){
        const holder=holderAddresses[0],token=normalizedAddressV1(ethers,tokens[0]?.address??tokens[0]),spender=spenderAddresses[0];
        if(token)try{
          const existing=await permit2View.getFunction('allowance(address,address,address)').staticCall(holder,token,spender);
          const probeAmount=0x13579bdf2468acen,probeExpiration=MAX_UINT48_V1;
          permit2Slot=await probeVerifiedAllowanceMappingV1({
            provider,ethers,address:permit2.address,keys:[holder,token,spender],
            probeWord:(BigInt(existing[2])<<208n)|(probeExpiration<<160n)|probeAmount,
            read:()=>permit2View.getFunction('allowance(address,address,address)').staticCall(holder,token,spender),
            matches:value=>BigInt(value[0])===probeAmount&&BigInt(value[1])===probeExpiration&&BigInt(value[2])===BigInt(existing[2])
          });
        }catch(error){gaps.push({type:'PERMIT2_ALLOWANCE_SLOT_PROBE_FAILED',message:String(error?.message??error).slice(0,800)});}
      }
      console.log(`[phase0-fixture] Permit2 allowance slot ${permit2Slot?'verified':'unavailable (using transactions)'}`);
      await mapLimitV1(holderAddresses,6,async holder=>{
        for(const row of tokens){
          const token=normalizedAddressV1(ethers,row?.address??row);if(!token)continue;
          try{
            const view=new ethers.Contract(token,ERC20_APPROVE_ABI_V1,provider);
            const slot=allowanceSlots.get(token.toLowerCase());
            const direct=slot&&await writeVerifiedAllowanceV1({
              provider,ethers,address:token,keys:[holder,permit2.address],slot,
              makeWord:()=>ethers.MaxUint256,
              read:()=>view.getFunction('allowance(address,address)').staticCall(holder,permit2.address),
              matches:value=>BigInt(value)===ethers.MaxUint256
            });
            if(direct)rpcMutations.push({kind:'ERC20_APPROVAL_TO_PERMIT2_STORAGE',token,holder,spender:permit2.address,slot:slot.slot,layout:slot.layout,status:'PASS'});
            else{
              const receipt=await sendEncodedV1({provider,ethers,from:holder,to:token,iface:erc20Iface,signature:'approve(address,uint256)',args:[permit2.address,ethers.MaxUint256]});
              transactionReceipts.push(receiptRowV1('ERC20_APPROVAL_TO_PERMIT2',receipt,{token,holder,spender:permit2.address,amount:ethers.MaxUint256.toString()}));
            }
          }catch(error){
            gaps.push({type:'PERMIT2_TOKEN_APPROVAL_FAILED',token,holder,spender:permit2.address,message:String(error?.shortMessage??error?.message??error).slice(0,1000)});continue;
          }
          for(const spender of spenderAddresses){
            try{
              const direct=permit2Slot&&await writeVerifiedAllowanceV1({
                provider,ethers,address:permit2.address,keys:[holder,token,spender],slot:permit2Slot,
                makeWord:previous=>(previous&~((1n<<208n)-1n))|(MAX_UINT48_V1<<160n)|MAX_UINT160_V1,
                read:()=>permit2View.getFunction('allowance(address,address,address)').staticCall(holder,token,spender),
                matches:value=>BigInt(value[0])===MAX_UINT160_V1&&BigInt(value[1])===MAX_UINT48_V1
              });
              if(direct){
                rpcMutations.push({kind:'PERMIT2_ALLOWANCE_STORAGE',token,holder,spender,slot:permit2Slot.slot,layout:permit2Slot.layout,status:'PASS'});
                continue;
              }
              const receipt=await sendEncodedV1({provider,ethers,from:holder,to:permit2.address,iface:permit2Iface,signature:'approve(address,address,uint160,uint48)',args:[token,spender,MAX_UINT160_V1,MAX_UINT48_V1]});
              transactionReceipts.push(receiptRowV1('PERMIT2_ALLOWANCE',receipt,{token,holder,spender,amount:MAX_UINT160_V1.toString(),expiration:MAX_UINT48_V1.toString()}));
            }catch(error){gaps.push({type:'PERMIT2_ALLOWANCE_FAILED',token,holder,spender,message:String(error?.shortMessage??error?.message??error).slice(0,1000)});}
          }
        }
      });
    }
  }catch(error){permit2={...permit2,status:'CODE_READ_FAILED'};gaps.push({type:'PERMIT2_CODE_READ_FAILED',address:permit2.address,message:String(error?.message??error).slice(0,800)});}
  console.log(`[phase0-fixture] Permit2 approvals complete; storage mutations=${rpcMutations.filter(x=>x.kind.includes('APPROVAL')||x.kind==='PERMIT2_ALLOWANCE_STORAGE').length}; mined receipts=${transactionReceipts.length}`);

  // Approval transactions consume native gas; restore the specified fixture ETH balance as the final actor state.
  for(const holder of holderAddresses){
    try{
      await provider.send('anvil_setBalance',[holder,ethers.toQuantity(ethBalance)]);
      rpcMutations.push({kind:'ETH_BALANCE_RESET_AFTER_APPROVALS',holder,amountWei:ethBalance.toString(),status:'PASS'});
    }catch(error){gaps.push({type:'ETH_BALANCE_FINAL_RESET_FAILED',holder,message:String(error?.message??error).slice(0,800)});}
  }
  transactionReceipts.sort((a,b)=>(a.blockNumber??0)-(b.blockNumber??0)||String(a.transactionHash).localeCompare(String(b.transactionHash)));
  const receiptCounts={
    ethBalanceWrites:rpcMutations.filter(x=>x.kind==='ETH_BALANCE_SET'||x.kind==='ETH_BALANCE_RESET_AFTER_APPROVALS').length,
    tokenBalanceWrites:rpcMutations.filter(x=>x.kind==='TOKEN_BALANCE_SET').length,
    erc20Approvals:transactionReceipts.filter(x=>x.kind==='ERC20_APPROVAL').length,
    erc20StorageApprovals:rpcMutations.filter(x=>x.kind==='ERC20_APPROVAL_STORAGE').length,
    permit2TokenApprovals:transactionReceipts.filter(x=>x.kind==='ERC20_APPROVAL_TO_PERMIT2').length,
    permit2TokenStorageApprovals:rpcMutations.filter(x=>x.kind==='ERC20_APPROVAL_TO_PERMIT2_STORAGE').length,
    permit2Allowances:transactionReceipts.filter(x=>x.kind==='PERMIT2_ALLOWANCE').length,
    permit2StorageAllowances:rpcMutations.filter(x=>x.kind==='PERMIT2_ALLOWANCE_STORAGE').length,
    transactionReceipts:transactionReceipts.length,
    gaps:gaps.length
  };
  return{holders:holderAddresses,spenders:spenderAddresses,slotResults,rpcMutations,transactionReceipts,receiptCounts,permit2,gaps};
}

function associationValuesV1(valuePool,address){
  const needle=String(address).toLowerCase(),out=[];
  for(const [key,value] of Object.entries(valuePool?.associations??{})){
    const rows=value instanceof Set?[...value]:Array.isArray(value)?value:[];
    if(key.toLowerCase()===needle)out.push(...rows);
    if(rows.some(x=>String(x).toLowerCase()===needle))out.push(key);
  }
  return uniqueStringsV1(out);
}
function bucketFillV1(out,values,weight){
  if(!values.length)return;
  for(let i=0;i<weight;i++)out.push(values[i%values.length]);
}
export function weightedFixtureAddressSeedV1({valuePool={},actors=[],targets=[],chosenAddresses=[]}={}){
  const created=uniqueStringsV1(valuePool.created??[]);
  const tokens=uniqueStringsV1((valuePool.tokens??[]).map(x=>x?.address??x));
  const associated=uniqueStringsV1(chosenAddresses.flatMap(address=>associationValuesV1(valuePool,address)));
  const targetRows=uniqueStringsV1(targets);
  const actorPrivileged=uniqueStringsV1([...(actors??[]),...(valuePool.privileged??[])]);
  const out=[];
  bucketFillV1(out,created,35);
  bucketFillV1(out,tokens,25);
  bucketFillV1(out,associated,15);
  bucketFillV1(out,targetRows,15);
  bucketFillV1(out,actorPrivileged,10);
  return out.length?out:uniqueStringsV1([...(valuePool.addresses??[]),...targetRows,...actorPrivileged]);
}
function uniqueStringsV1(values=[]){
  const out=[],seen=new Set();
  for(const value of values){
    if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value))continue;
    const key=value.toLowerCase();if(seen.has(key))continue;seen.add(key);out.push(value);
  }
  return out;
}
export function chooseFixtureAddressV1({rng=Math.random,valuePool={},actors=[],targets=[],chosenAddresses=[]}={}){
  const weighted=weightedFixtureAddressSeedV1({valuePool,actors,targets,chosenAddresses});
  if(!weighted.length)return null;
  return weighted[Math.min(weighted.length-1,Math.floor(rng()*weighted.length))];
}
// Only quantity-like params get funded-amount candidates; indices, ids, deadlines and fees keep generic values.
const AMOUNT_LIKE_PARAM_RE_V1=/(?:amount|amt|value|assets?|shares?|qty|quantity|liquidity|balance|deposit|withdraw|supply|wad|max|min|limit|in$|out$)/i;
export function isAmountLikeParamV1(param){
  const name=String(param?.name??'');
  return name?AMOUNT_LIKE_PARAM_RE_V1.test(name):true;
}
export function chooseFixtureAmountV1({rng=Math.random,param,valuePool={},chosenAddresses=[]}={}){
  const m=String(param?.type??'').match(/^uint(\d+)?$/);
  if(!m||!isAmountLikeParamV1(param))return null;
  const bits=Number(m[1]??256);if(bits<64)return null;
  const tokens=(valuePool.tokens??[]).filter(x=>Number.isInteger(Number(x?.decimals))&&x?.fundedAmount!=null&&BigInt(x.fundedAmount)>0n);
  if(!tokens.length)return null;
  const chosenToken=tokens.find(token=>chosenAddresses.some(address=>String(address).toLowerCase()===String(token.address).toLowerCase()))??tokens[Math.min(tokens.length-1,Math.floor(rng()*tokens.length))];
  const decimals=Number(chosenToken.decimals),funded=BigInt(chosenToken.fundedAmount),max=(1n<<BigInt(bits))-1n;
  const cap=v=>v>funded?funded:(v>max?max:v);
  const candidates=[1n,10n**BigInt(decimals),10n**BigInt(decimals+3)].map(cap).filter(x=>x>=0n);
  const unique=[...new Set(candidates.map(String))].map(BigInt);
  return unique[Math.min(unique.length-1,Math.floor(rng()*unique.length))].toString();
}
export function recordChosenAddressesV1(value,chosenAddresses=[]){
  if(typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)){chosenAddresses.push(value);return chosenAddresses;}
  if(Array.isArray(value))for(const child of value)recordChosenAddressesV1(child,chosenAddresses);
  return chosenAddresses;
}
export function serializeValuePoolV1(valuePool={}){
  const associations={};
  for(const [address,values] of Object.entries(valuePool.associations??{}))associations[address]=[...(values instanceof Set?values:values??[])];
  return{
    addresses:[...(valuePool.addresses??[])],
    tokens:(valuePool.tokens??[]).map(x=>({...x})),
    associations,
    privileged:[...(valuePool.privileged??[])],
    created:[...(valuePool.created??[])],
    receipts:[...(valuePool.receipts??[])],
    gaps:[...(valuePool.gaps??[])]
  };
}


const CREATOR_NAME_RE_V1=/^(?:create|deploy|new|clone|launch|make|build)/i; // register/add change configuration; they are not evidence of deployed child contracts
const AUTHORIZATION_RE_V1=/(?:owner|auth|admin|allowed|permission|role|sender|caller|only)/i;
const CALLBACK_NAME_RE_V1=/(?:^on[A-Z]|Hook|Callback)/;

function paramContainsAddressV1(param){
  if(!param)return false;
  if(param.baseType==='array')return paramContainsAddressV1(param.arrayChildren);
  if(param.baseType==='tuple')return (param.components??[]).some(paramContainsAddressV1);
  return String(param.type??'')==='address';
}
function paramIsAddressArrayV1(param){
  return param?.baseType==='array'&&param?.arrayChildren?.baseType==='address';
}
function paramIsTupleArrayWithLeadingAddressV1(param){
  if(param?.baseType!=='array'||param?.arrayChildren?.baseType!=='tuple')return false;
  return (param.arrayChildren.components??[]).some(component=>component?.baseType==='address');
}
function paramIsUintArrayV1(param){
  return param?.baseType==='array'&&/^uint(?:\d+)?$/.test(String(param?.arrayChildren?.type??''));
}
function functionKeyV1(target,selected){
  return `${String(target?.address??'').toLowerCase()}|${target?.logicalQualifiedName??target?.qualifiedName??'UNKNOWN'}|${selected?.signature??selected?.fragment?.format?.('sighash')??'UNKNOWN'}`;
}
export function discoverCreatorCandidatesV1({targets=[]}={}){
  const rows=[];
  for(const target of targets){
    for(const selected of target?.functions??[]){
      const fragment=selected?.fragment;
      if(!fragment||['view','pure'].includes(fragment.stateMutability))continue;
      const returnsAddress=(fragment.outputs??[]).some(outputContainsAddressV1);
      const namedCreator=CREATOR_NAME_RE_V1.test(String(fragment.name??''))&&(fragment.inputs??[]).some(paramContainsAddressV1);
      if(!returnsAddress&&!namedCreator)continue;
      const q=String(target.logicalQualifiedName??target.qualifiedName??'');
      // Balancer Routers and BatchRouters return TokenAmount tuples containing
      // address fields, but these are NOT factory creators. Never infer
      // contract creation solely from an address nested in a swap result.
      if(/(?:^|\/)(?:Router|BatchRouter|CompositeLiquidityRouter)\.sol:(?:Router|BatchRouter|CompositeLiquidityRouter)$/.test(q))continue;
      // CurveYield factories explicitly restrict create() to the deployed
      // PoolFactoryWrapper. Users cannot invoke them directly, irrespective
      // of allowances, impersonated owners, or random parameter retries.
      if(/contracts\/factories\/CurveYield\w+PoolFactory\.sol:/.test(q)&&fragment.name==='create')continue;
      // Gyro E-CLP requires correlated parameter bounds and ReCLAMM has an
      // explicitly unsupported BPT settlement path in this deployment.
      // The generic ABI generator cannot configure either correctly.
      if(/CurveYieldPoolFactoryWrapper\.sol:/.test(q)&&
        ['createGyroECLPPool','createReClammPool'].includes(fragment.name))continue;
      rows.push({target,selected,key:functionKeyV1(target,selected),basis:returnsAddress?'RETURNS_ADDRESS':'CREATOR_NAME_WITH_ADDRESS_INPUT'});
    }
  }
  // A wrapper is the intended public entrypoint for pool creation; attempt
  // it before generic vendor/administrative creator candidates.
  return rows.sort((a,b)=>{
    const preferred=x=>/CurveYieldPoolFactoryWrapper\.sol:/.test(String(x.target?.qualifiedName??''))&&/^create(?:Weighted|Stable|StableSurge)Pool$/.test(x.selected?.fragment?.name??'')?0:1;
    return preferred(a)-preferred(b)||a.key.localeCompare(b.key);
  });
}
function fundedTokensV1(valuePool={}){
  return (valuePool.tokens??[])
    .filter(token=>/^0x[0-9a-fA-F]{40}$/.test(String(token?.address??token))&&token?.fundedAmount!=null&&BigInt(token.fundedAmount)>0n)
    .map(token=>({...token,address:String(token.address)}))
    .sort((a,b)=>String(a.address).toLowerCase().localeCompare(String(b.address).toLowerCase()));
}
function deterministicIndexV1(ethers,seed,n){
  if(!n)return 0;
  const digest=ethers.id(String(seed));
  return Number(BigInt(digest)%BigInt(n));
}
function tokenSetForAttemptV1({ethers,tokens,attempt}){
  if(tokens.length<2)return[];
  const requested=attempt%2===0?2:3,size=Math.min(requested,tokens.length);
  const start=deterministicIndexV1(ethers,`token-set:${attempt}`,tokens.length);
  const picked=[];
  for(let i=0;i<tokens.length&&picked.length<size;i++)picked.push(tokens[(start+i)%tokens.length]);
  return picked.sort((a,b)=>String(a.address).toLowerCase().localeCompare(String(b.address).toLowerCase()));
}
function callbackTargetAddressesV1({ethers,targets=[]}){
  const out=[];
  for(const target of targets){
    let iface;
    try{iface=new ethers.Interface(abiRowsV1(target?.artifact?.abi));}catch{continue;}
    if(iface.fragments.some(fragment=>fragment?.type==='function'&&CALLBACK_NAME_RE_V1.test(String(fragment.name??''))))out.push(target.address);
  }
  return uniqueAddressesV1(ethers,out);
}
function uintBitsV1(param){return Number(String(param?.type??'').match(/\d+/)?.[0]??256);}
function capUintV1(value,bits){
  const max=(1n<<BigInt(bits))-1n;
  const v=BigInt(value);
  return v>max?max:v;
}
function tupleValueForCreatorV1({ethers,param,attempt,actor,tokenSet,valuePool,targets,callbacks,context}){
  const components=param?.components??[];
  const firstAddressIndex=components.findIndex(component=>component?.baseType==='address');
  return components.map((component,index)=>{
    if(component?.baseType==='address'){
      const mode=attempt%3;
      if(index===firstAddressIndex&&mode===0&&tokenSet.length)return ethers.getAddress(tokenSet[index%tokenSet.length].address);
      if(mode===1)return ethers.ZeroAddress;
      return actor;
    }
    if(component?.baseType==='tuple')return tupleValueForCreatorV1({ethers,param:component,attempt,actor,tokenSet,valuePool,targets,callbacks,context});
    if(component?.baseType==='array')return creatorArrayValueV1({ethers,param:component,attempt,actor,tokenSet,valuePool,targets,callbacks,context});
    if(String(component?.type??'')==='bool')return false;
    if(/^uint8$/.test(String(component?.type??'')))return 0;
    if(/^u?int(?:\d+)?$/.test(String(component?.type??'')))return 0;
    if(String(component?.type??'')==='string')return attempt%2===0?'P0':'P0T';
    if(String(component?.type??'')==='bytes')return '0x';
    if(String(component?.type??'')==='bytes32')return ethers.id(`p0-stage2-tuple:${attempt}:${index}`);
    return 0;
  });
}
function creatorArrayValueV1({ethers,param,attempt,actor,tokenSet,valuePool,targets,callbacks,context}){
  let length=Number.isInteger(param.arrayLength)&&param.arrayLength>=0?param.arrayLength:null;
  if(paramIsAddressArrayV1(param)||paramIsTupleArrayWithLeadingAddressV1(param))length=length??tokenSet.length;
  else if(paramIsUintArrayV1(param))length=length??(context.tokenArrayLength??tokenSet.length);
  else length=length??Math.max(1,Math.min(3,tokenSet.length||2));
  length=Math.max(0,Math.min(length,8));
  if(paramIsAddressArrayV1(param)){
    const rows=tokenSet.slice(0,length).map(token=>ethers.getAddress(token.address));
    while(rows.length<length)rows.push(actor);
    context.tokenArrayLength=rows.length;context.tokenSet=tokenSet.slice(0,rows.length);
    return rows;
  }
  if(paramIsTupleArrayWithLeadingAddressV1(param)){
    const rows=[];
    for(let i=0;i<length;i++){
      const token=tokenSet[i%Math.max(1,tokenSet.length)];
      rows.push(tupleValueForCreatorV1({ethers,param:param.arrayChildren,attempt:attempt+i,actor,tokenSet:token?[token]:tokenSet,valuePool,targets,callbacks,context}));
    }
    context.tokenArrayLength=rows.length;context.tokenSet=tokenSet.slice(0,rows.length);
    return rows;
  }
  if(paramIsUintArrayV1(param)){
    const n=Math.max(1,length),mode=Math.floor(attempt/2)%3,bits=uintBitsV1(param.arrayChildren);
    if(mode===0){
      const base=10n**18n/BigInt(n),rows=Array.from({length:n},()=>base);
      rows[n-1]+=10n**18n-base*BigInt(n);
      return rows.map(x=>capUintV1(x,bits));
    }
    if(mode===1)return Array.from({length:n},()=>capUintV1(10n**18n,bits));
    const selected=(context.tokenSet?.length?context.tokenSet:tokenSet);
    return Array.from({length:n},(_,i)=>{
      const funded=selected[i%Math.max(1,selected.length)]?.fundedAmount??'1';
      return capUintV1(BigInt(funded),bits);
    });
  }
  return Array.from({length},(_,i)=>creatorParamValueV1({ethers,param:param.arrayChildren,attempt:attempt+i,actor,tokenSet,valuePool,targets,callbacks,context}));
}
function creatorParamValueV1({ethers,param,attempt,actor,tokenSet,valuePool,targets,callbacks,context}){
  if(param?.baseType==='array')return creatorArrayValueV1({ethers,param,attempt,actor,tokenSet,valuePool,targets,callbacks,context});
  if(param?.baseType==='tuple')return tupleValueForCreatorV1({ethers,param,attempt,actor,tokenSet,valuePool,targets,callbacks,context});
  const type=String(param?.type??'');
  if(type==='address'){
    const name=String(param?.name??'');
    const choices=[ethers.ZeroAddress,actor];
    if(/(?:hook|callback|rateProvider)/i.test(name))choices.push(...callbacks);
    choices.push(...targets.map(target=>target.address).filter(Boolean));
    const unique=uniqueAddressesV1(ethers,choices);
    return unique[attempt%Math.max(1,unique.length)]??actor;
  }
  if(type==='bool')return false;
  if(type==='string')return attempt%2===0?'P0':'P0T';
  if(type==='bytes32')return ethers.id(`p0-stage2:${context.candidateKey}:${attempt}:${param?.name??''}`);
  if(type==='bytes')return '0x';
  if(/^uint8$/.test(type))return 0;
  if(/^uint(?:\d+)?$/.test(type)){
    const bits=uintBitsV1(param),name=String(param?.name??'');
    if(/(?:fee|rate|bps|percent)/i.test(name)){
      const ladder=[0n,10n**12n,10n**14n,10n**15n,3n*10n**15n,10n**16n,10n**17n];
      return capUintV1(ladder[attempt%ladder.length],bits);
    }
    const chosen=chooseFixtureAmountV1({rng:()=>((attempt%24)+0.5)/24,param,valuePool,chosenAddresses:(context.chosenAddresses??[])});
    return chosen===null?0n:capUintV1(BigInt(chosen),bits);
  }
  if(/^int(?:\d+)?$/.test(type))return 0;
  if(/^bytes\d+$/.test(type))return ethers.zeroPadValue('0x',Number(type.slice(5)));
  return 0;
}
// CurveYield DEX v16: all Balancer factories are allowlisted for the
// CurveYieldPoolFactoryWrapper, not direct EOAs. The wrapper requires a
// predicted address and exact payable fee, so call its actual view functions.
export async function buildCurveYieldWrapperCreationV1({provider,ethers,candidate,attempt=0,actor,valuePool={}}={}){
  const source=String(candidate?.target?.logicalQualifiedName??candidate?.target?.qualifiedName??'');
  const name=candidate?.selected?.fragment?.name??'';
  if(!/CurveYieldPoolFactoryWrapper\.sol:CurveYieldPoolFactoryWrapper$/.test(source)||
     !['createWeightedPool','createStablePool','createStableSurgePool'].includes(name))return null;
  const tokens=fundedTokensV1(valuePool).filter(row=>Number(row.decimals)>=0&&Number(row.decimals)<=18);
  if(tokens.length<2)return{status:'NOT_READY',reason:'NEED_TWO_FUNDED_ERC20_TOKENS'};
  const i=attempt%Math.max(1,tokens.length-1);
  const selected=tokens.slice(i,i+2).sort((a,b)=>String(a.address).toLowerCase().localeCompare(String(b.address).toLowerCase()));
  const tokenConfigs=selected.map(row=>[ethers.getAddress(row.address),0,ethers.ZeroAddress,false]);
  const salt=ethers.id('phase0-curveyield-pool-v1:'+name+':'+attempt+':'+candidate.target.address);
  const inputName='Phase0 CurveYield Pool '+String(attempt+1),symbol='P0BPT';
  const managers=[actor,actor],fee=10000000000000000n;
  const input=name==='createWeightedPool'
    ? [inputName,symbol,tokenConfigs,[500000000000000000n,500000000000000000n],managers,fee,ethers.ZeroAddress,false,false,salt]
    :name==='createStablePool'
      ? [inputName,symbol,tokenConfigs,200n,managers,fee,ethers.ZeroAddress,false,false,salt]
      :[inputName,symbol,tokenConfigs,200n,managers,fee,false,salt];
  const factoryWrapper=new ethers.Contract(candidate.target.address,abiRowsV1(candidate.target.artifact.abi),provider);
  const predict=name==='createWeightedPool'?'computeWeightedPoolAddress':name==='createStablePool'?'computeStablePoolAddress':'computeStableSurgePoolAddress';
  let expectedPool,poolCreationFeeWei;
  try{
    [expectedPool,poolCreationFeeWei]=await Promise.all([
      factoryWrapper.getFunction(predict).staticCall(input),
      factoryWrapper.getFunction('poolCreationFeeWei()').staticCall()
    ]);
  }catch(error){
    return{status:'NOT_READY',reason:'WRAPPER_POOL_ADDRESS_PREDICTION_FAILED',error:String(error?.shortMessage??error?.message??error).slice(0,450)};
  }
  if(!/^0x[0-9a-fA-F]{40}$/.test(String(expectedPool))||expectedPool===ethers.ZeroAddress){
    return{status:'NOT_READY',reason:'PREDICTED_POOL_ADDRESS_INVALID'};
  }
  const policy=[
    actor,                    // creatorController
    actor,                    // creatorPayoutReceiver
    ethers.getAddress(selected[0].address), // creatorPayoutToken: registered constituent token
    ethers.ZeroAddress,       // creatorPartnerRevenueReceiver (no partner revenue)
    expectedPool,             // required exact predicted pool address
    ethers.id('phase0-curveyield-splitter-v1:'+name+':'+attempt+':'+candidate.target.address),
    [0,0,0]                  // zero creator fees are valid and omit dependency on liquidity lots
  ];
  // The constructor's supplied fixed ABI, not a hand-generated signature,
  // encodes the two nested tuple arguments.
  try{new ethers.Interface(abiRowsV1(candidate.target.artifact.abi)).encodeFunctionData(candidate.selected.signature,[input,policy]);}
  catch(error){return{status:'NOT_READY',reason:'WRAPPER_TUPLE_ABI_MISMATCH',error:String(error?.message??error).slice(0,400)};}
  return{status:'READY',args:[input,policy],value:BigInt(poolCreationFeeWei),tokenSet:selected.map(x=>x.address),
    basis:'CURVEYIELD_WRAPPER_ALLOWLIST_EXACT_POOL_PREDICTION_FEE_AND_TOKEN_CONFIG',expectedPool,predictor:predict};
}
// Balancer v3 factories require sorted TokenConfig tuples and exact pool math
// parameters. Generic address/uint generation cannot produce valid pools.
export function buildBalancerV3CreatorArgumentsV1({ethers,candidate,attempt=0,actor,valuePool={}}={}){
  const targetName=String(candidate?.target?.logicalQualifiedName??candidate?.target?.qualifiedName??'');
  const fragment=candidate?.selected?.fragment;
  if(!/@balancer-labs\/v3-/.test(targetName)||!/Pool.*Factory|WeightedPool8020Factory/.test(targetName)||fragment?.name!=='create')return null;
  const tokens=fundedTokensV1(valuePool);
  if(tokens.length<2)return null;
  const picked=tokens.slice((attempt%Math.max(1,tokens.length-1)),(attempt%Math.max(1,tokens.length-1))+2);
  if(picked.length!==2)return null;
  const rows=picked.sort((a,b)=>String(a.address).toLowerCase().localeCompare(String(b.address).toLowerCase()));
  const tokenConfigs=rows.map(token=>[ethers.getAddress(token.address),0,ethers.ZeroAddress,false]);
  let tokenConfigIndex=0;
  const amounts=[500000000000000000n,500000000000000000n];
  const fill=(param)=>{
    const name=String(param?.name??'').toLowerCase(),type=String(param?.type??'');
    if(param?.baseType==='array'&&param.arrayChildren?.baseType==='tuple'&&(param.arrayChildren.components??[]).some(c=>/token/i.test(String(c.name??''))))return tokenConfigs;
    if(param?.baseType==='array'&&/^uint/.test(String(param.arrayChildren?.type??''))&&/weight/.test(name))return amounts;
    if(param?.baseType==='tuple'&&/role|account/i.test(name))return (param.components??[]).map(component=>component.type==='address'?ethers.ZeroAddress:0n);
    if(param?.baseType==='tuple'&&/tokenconfig/i.test(name))return tokenConfigs[Math.min(tokenConfigIndex++,tokenConfigs.length-1)];
    if(type==='string')return /symbol/i.test(name)?'P0BPT':'Phase0 Pool';
    if(type==='address')return /hook/i.test(name)?ethers.ZeroAddress:actor;
    if(type==='bytes32')return ethers.id('phase0-balancer-v3:'+targetName+':'+attempt);
    if(type==='bytes')return '0x';
    if(type==='bool')return false;
    if(/^uint/.test(type))return /(?:swapfee|feepercentage)/i.test(name)?10000000000000000n:/amplification/i.test(name)?100n:0n;
    return null;
  };
  const args=(fragment.inputs??[]).map(fill);
  if(args.some(arg=>arg===null))return null;
  // Every dynamic array has protocol-specific dimensions, never random lengths.
  return{args,basis:'BALANCER_V3_FACTORY_SORTED_TOKEN_CONFIG_AND_VALID_WEIGHTS',tokens:rows.map(row=>row.address)};
}
export function buildCreatorArgumentsV1({ethers,candidate,attempt=0,actor,valuePool={},targets=[]}){
  const balancer=buildBalancerV3CreatorArgumentsV1({ethers,candidate,attempt,actor,valuePool});
  if(balancer)return{...balancer,chosenAddresses:[]};
  const tokens=fundedTokensV1(valuePool),tokenSet=tokenSetForAttemptV1({ethers,tokens,attempt});
  const callbacks=callbackTargetAddressesV1({ethers,targets});
  const context={candidateKey:candidate?.key??functionKeyV1(candidate?.target,candidate?.selected),tokenArrayLength:null,tokenSet,chosenAddresses:[]};
  const args=(candidate?.selected?.fragment?.inputs??[]).map(param=>{
    const value=creatorParamValueV1({ethers,param,attempt,actor,tokenSet,valuePool,targets,callbacks,context});
    recordChosenAddressesV1(value,context.chosenAddresses);
    return value;
  });
  return{args,tokenSet:tokenSet.map(x=>x.address),chosenAddresses:context.chosenAddresses};
}
// Creator inputs are untrusted ABI-shaped values. Keep evidence traversal bounded:
// ethers Result objects, deeply nested tuples or cyclic objects must never block
// the entire randomized campaign after successful on-chain pool creation.
export function normalizeEvidenceValueV1(value){
  const active=new WeakSet();
  let nodes=0;
  function convert(v,depth){
    if(++nodes>100000||depth>32)throw Object.assign(new Error('creator evidence exceeds bounded serializer limits'),{code:'CREATOR_EVIDENCE_TOO_COMPLEX'});
    if(typeof v==='bigint')return v.toString();
    if(v===null||typeof v!=='object')return v;
    if(active.has(v))throw Object.assign(new Error('cyclic creator evidence argument'),{code:'CREATOR_EVIDENCE_CYCLE'});
    active.add(v);
    try{
      if(Array.isArray(v))return v.map(child=>convert(child,depth+1));
      if(typeof v.toArray==='function'){
        const row=v.toArray();
        if(Array.isArray(row))return row.map(child=>convert(child,depth+1));
      }
      return Object.fromEntries(Object.entries(v).filter(([key])=>!/^\d+$/.test(key)).map(([key,child])=>[key,convert(child,depth+1)]));
    }finally{active.delete(v);}
  }
  return convert(value,0);
}
function knownAddressSetV1({valuePool={},targets=[]}){
  return new Set([
    ...(valuePool.addresses??[]),
    ...(valuePool.created??[]),
    ...(valuePool.tokens??[]).map(x=>x?.address??x),
    ...targets.map(x=>x?.address)
  ].filter(Boolean).map(x=>String(x).toLowerCase()));
}
function topicAddressV1(ethers,topic){
  const text=String(topic??'');
  if(!/^0x[0-9a-fA-F]{64}$/.test(text)||!/^0x0{24}/i.test(text))return null;
  return normalizedAddressV1(ethers,'0x'+text.slice(-40));
}
async function receiptAddressCandidatesV1({provider,ethers,receipt,artifacts=[],returnedValue,known}){
  const out=new Set();
  collectAddressesV1(ethers,returnedValue,out);
  const interfaces=[];
  for(const artifact of artifacts){
    try{interfaces.push(new ethers.Interface(abiRowsV1(artifact?.abi)));}catch{}
  }
  for(const log of receipt?.logs??[]){
    for(const topic of log.topics??[]){
      const address=topicAddressV1(ethers,topic);
      if(address)out.add(address);
    }
    for(const iface of interfaces){
      try{
        const parsed=iface.parseLog({topics:log.topics,data:log.data});
        if(parsed)collectAddressesV1(ethers,parsed.args,out);
      }catch{}
    }
  }
  const rows=[];
  for(const address of out){
    if(known.has(address.toLowerCase()))continue;
    let code='0x';try{code=await provider.getCode(address);}catch{}
    if(code&&code!=='0x')rows.push(address);
  }
  return rows;
}
function stripMetadataV1(hex){
  const clean=String(hex??'').replace(/^0x/,'').toLowerCase();
  if(!/^[0-9a-f]*$/.test(clean)||clean.length<4)return clean;
  const metadataBytes=parseInt(clean.slice(-4),16);
  const trimChars=(metadataBytes+2)*2;
  return trimChars>0&&trimChars<clean.length?clean.slice(0,-trimChars):clean;
}
function linkReferenceRangesV1(artifact){
  const ranges=[];
  for(const source of Object.values(artifact?.deployedLinkReferences??{})){
    for(const entries of Object.values(source??{}))for(const row of entries??[])ranges.push({start:Number(row.start),length:Number(row.length)});
  }
  return ranges;
}
function runtimeWildcardRangesV1(expectedHex,artifact){
  const ranges=linkReferenceRangesV1(artifact),expected=String(expectedHex??'');
  // Solc emits zero placeholders for immutable PUSH32 values in normalized deployed bytecode.
  // Treat only those 32-byte immediates as deployment-specific while keeping opcode bytes exact.
  for(let byte=0;byte+33<=expected.length/2;byte++){
    if(expected.slice(byte*2,byte*2+2)!=='7f')continue;
    const immediate=expected.slice((byte+1)*2,(byte+33)*2);
    if(/^0{64}$/.test(immediate))ranges.push({start:byte+1,length:32});
  }
  return ranges;
}
function artifactRuntimeMatchesV1(actualHex,artifact){
  const actual=stripMetadataV1(actualHex),expected=stripMetadataV1(artifact?.deployedBytecode??'');
  if(!actual||!expected||actual.length!==expected.length)return false;
  const ranges=runtimeWildcardRangesV1(expected,artifact);
  for(let byte=0;byte<actual.length/2;byte++){
    if(ranges.some(range=>byte>=range.start&&byte<range.start+range.length))continue;
    const e=expected.slice(byte*2,byte*2+2),a=actual.slice(byte*2,byte*2+2);
    if(!/^[0-9a-f]{2}$/.test(e))continue;
    if(a!==e)return false;
  }
  return true;
}
function eip1167ImplementationV1(ethers,code){
  const clean=String(code??'').replace(/^0x/,'').toLowerCase();
  const match=clean.match(/363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  return match?normalizedAddressV1(ethers,'0x'+match[1]):null;
}
const EIP1967_IMPLEMENTATION_SLOT_V1='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
async function eip1967ImplementationV1({provider,ethers,address}){
  try{
    const word=await provider.send('eth_getStorageAt',[address,EIP1967_IMPLEMENTATION_SLOT_V1,'latest']);
    if(!/^0x[0-9a-fA-F]{64}$/.test(String(word??'')))return null;
    const candidate=normalizedAddressV1(ethers,'0x'+String(word).slice(-40));
    if(!candidate||candidate===ethers.ZeroAddress)return null;
    const code=await provider.getCode(candidate);
    return code&&code!=='0x'?candidate:null;
  }catch{return null;}
}
function matchedRuntimeArtifactV1({code,artifacts=[]}){
  const matches=artifacts.filter(artifact=>artifactRuntimeMatchesV1(code,artifact));
  return matches.length===1?matches[0]:null;
}
function syntheticErc20ArtifactV1(address){
  return{
    sourceName:'PHASE0_FIXTURE_SYNTHESIS',
    contractName:`ERC20Shape_${String(address).replace(/^0x/,'').slice(0,10)}`,
    abi:[
      'function decimals() view returns (uint8)',
      'function totalSupply() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address,address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)',
      'function transfer(address,uint256) returns (bool)',
      'function transferFrom(address,address,uint256) returns (bool)'
    ],
    bytecode:'0x',deployedBytecode:'0x',linkReferences:{},deployedLinkReferences:{}
  };
}
export async function bindCreatedContractV1({provider,ethers,address,artifacts=[],probeHolder=ethers.ZeroAddress}){
  const createdAddress=normalizedAddressV1(ethers,address);
  if(!createdAddress)return{address,status:'INVALID_ADDRESS',deployment:null,artifact:null,syntheticArtifact:null,token:null};
  const code=await provider.getCode(createdAddress);
  if(!code||code==='0x')return{address:createdAddress,status:'NO_CODE',deployment:null,artifact:null,syntheticArtifact:null,token:null};
  const eip1167Implementation=eip1167ImplementationV1(ethers,code);
  const eip1967Implementation=eip1167Implementation?null:await eip1967ImplementationV1({provider,ethers,address:createdAddress});
  let implementationAddress=eip1167Implementation??eip1967Implementation;
  let mappingStatus='MATCHED_RUNTIME_BYTECODE',artifact=null;
  if(implementationAddress){
    const implementationCode=await provider.getCode(implementationAddress);
    artifact=matchedRuntimeArtifactV1({code:implementationCode,artifacts});
    if(artifact)mappingStatus=eip1167Implementation?'EIP1167_IMPLEMENTATION_RUNTIME_MATCH':'EIP1967_IMPLEMENTATION_RUNTIME_MATCH';
  }
  if(!artifact)artifact=matchedRuntimeArtifactV1({code,artifacts});
  let syntheticArtifact=null,token=null;
  if(!artifact){
    try{
      const shape=await probeErc20ShapeV1({provider,ethers,address:createdAddress,probeHolder});
      syntheticArtifact=syntheticErc20ArtifactV1(createdAddress);artifact=syntheticArtifact;mappingStatus='ERC20_SHAPE_FALLBACK';
      token={symbol:null,address:createdAddress,source:'CREATED_ERC20_SHAPE',qualifiedName:`${artifact.sourceName}:${artifact.contractName}`,decimals:shape.decimals,totalSupply:shape.totalSupply};
    }catch{}
  }else{
    try{
      const shape=await probeErc20ShapeV1({provider,ethers,address:createdAddress,probeHolder});
      token={symbol:null,address:createdAddress,source:'CREATED_ERC20_SHAPE',qualifiedName:`${artifact.sourceName}:${artifact.contractName}`,decimals:shape.decimals,totalSupply:shape.totalSupply};
    }catch{}
  }
  if(!artifact)return{address:createdAddress,status:'UNMAPPED_RUNTIME_BYTECODE',implementationAddress,deployment:null,artifact:null,syntheticArtifact:null,token:null};
  const qualifiedName=`${artifact.sourceName}:${artifact.contractName}`;
  return{
    address:createdAddress,status:mappingStatus,implementationAddress,artifact,syntheticArtifact,token,
    deployment:{address:createdAddress,transactionHash:null,blockNumber:null,qualifiedName,contractName:artifact.contractName,sourceName:artifact.sourceName,mappingStatus,implementationAddress}
  };
}
function authorizationLookingV1(decoded){
  return AUTHORIZATION_RE_V1.test(String(decoded?.reason??''));
}
function decodedFailureV1({ethers,error,selectorIndex}){
  const decoded=decodeTelemetryRevertReasonV1({ethers,error,selectorIndex});
  return{kind:decoded.kind,selector:decoded.selector,reason:decoded.reason};
}
async function attemptCreatorCallV1({provider,ethers,candidate,sender,args,selectorIndex,value=0n}){
  const snapshot=await provider.send('evm_snapshot',[]);
  const iface=new ethers.Interface(abiRowsV1(candidate.target.artifact.abi));
  const signature=candidate.selected.signature,data=iface.encodeFunctionData(signature,args);
  let returnedValue=null;
  try{
    const raw=await provider.call({from:sender,to:candidate.target.address,data,value});
    try{returnedValue=iface.decodeFunctionResult(signature,raw);}catch{}
    const gas=await provider.estimateGas({from:sender,to:candidate.target.address,data,value});
    const signer=await provider.getSigner(sender);
    const tx=await signer.sendTransaction({to:candidate.target.address,data,value,gasLimit:gas+(gas/2n)+100000n});
    const receipt=await tx.wait();
    if(Number(receipt?.status)!==1)throw Object.assign(new Error('creator transaction reverted'),{receipt});
    return{status:'PASS',snapshot,receipt,returnedValue,transactionHash:tx.hash};
  }catch(error){
    await provider.send('evm_revert',[snapshot]).catch(()=>{});
    return{status:'REVERTED',decoded:decodedFailureV1({ethers,error,selectorIndex}),error:String(error?.shortMessage??error?.message??error).slice(0,1600)};
  }
}
function topCreationRevertsV1(attempts,limit=10){
  const counts=new Map();
  for(const attempt of attempts.filter(x=>x.status==='REVERTED')){
    const reason=attempt.decoded?.reason??'UNKNOWN_REVERT',key=`${attempt.decoded?.kind??'UNKNOWN'}|${attempt.decoded?.selector??''}|${reason}`;
    const row=counts.get(key)??{kind:attempt.decoded?.kind??'UNKNOWN_REVERT',selector:attempt.decoded?.selector??null,reason,count:0};
    row.count++;counts.set(key,row);
  }
  return[...counts.values()].sort((a,b)=>b.count-a.count||String(a.reason).localeCompare(String(b.reason))).slice(0,limit);
}
// PoolFactoryWrapper's own compute*PoolAddress and _finishPoolCreated
// provide stronger provenance than parsing unrelated Balancer log ABIs.
export async function verifiedPredictedCurveYieldPoolV1({provider,ethers,expectedPool}={}){
  if(!/^0x[0-9a-fA-F]{40}$/.test(String(expectedPool??'')))return[];
  const address=ethers.getAddress(expectedPool);
  return await provider.getCode(address)!=='0x'?[address]:[];
}
// Only actual protocol pool-creation recipes produce Balancer BPT. A
// function selected because it RETURNS_ADDRESS is not by itself a pool.
export function balancerCreatedPoolAddressesV1(creations=[]){
  return new Set(creations
    .filter(row=>/CURVEYIELD_WRAPPER_ALLOWLIST|BALANCER_V3_FACTORY/.test(String(row.recipeBasis??'')) ||
      /CurveYieldPoolFactoryWrapper\.sol:CurveYieldPoolFactoryWrapper$/.test(String(row.target??'')))
    .flatMap(row=>row.createdAddresses??[])
    .map(x=>String(x).toLowerCase()));
}
export function creatorAttemptBudgetV1({isCurveYieldWrapper=false,maxAttemptsPerCandidate=24}={}){
  return isCurveYieldWrapper?Math.min(maxAttemptsPerCandidate,2):maxAttemptsPerCandidate;
}
export async function executeCreatorSynthesisV1({provider,ethers,targets=[],actors=[],valuePool={},artifacts=[],maxAttemptsPerCandidate=24,maxSuccessesPerCandidate=3,maxCreatedContracts=20}){
  const selectorIndex=buildCompiledArtifactErrorSelectorIndexV1({ethers,artifacts}),candidates=discoverCreatorCandidatesV1({targets});
  const known=knownAddressSetV1({valuePool,targets}),creations=[],creationGaps=[],createdDeployments=[],syntheticArtifacts=[],createdTokens=[];
  const privileged=uniqueAddressesV1(ethers,valuePool.privileged??[]),actorRows=uniqueAddressesV1(ethers,actors);
  let createdCount=0;
  for(const [candidateIndex,candidate] of candidates.entries()){
    if(createdCount>=maxCreatedContracts)break;
    const attempts=[];let successes=0;
    const isCurveYieldWrapper=/CurveYieldPoolFactoryWrapper\.sol:/.test(String(candidate.target.logicalQualifiedName??candidate.target.qualifiedName??''))
      &&/^create(?:Weighted|Stable|StableSurge)Pool$/.test(String(candidate.selected.fragment?.name??''));
    // Pool inputs cycle through the available adjacent funded token pairs.
    // Trying 24 different salts against the same invalid pair is not useful.
    // One verified wrapper recipe per adjacent token pair. Replaying the same
    // pair under six salts does not fix a failed Balancer permission or config.
    // Bound candidate work so Stage 2 cannot consume the telemetry smoke budget.
    const attemptBudget=creatorAttemptBudgetV1({isCurveYieldWrapper,maxAttemptsPerCandidate});
    const successBudget=isCurveYieldWrapper?1:maxSuccessesPerCandidate;
    console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length}: ${candidate.selected.signature}; maxAttempts=${attemptBudget}`);
    for(let strategy=0;strategy<attemptBudget&&attempts.length<attemptBudget&&successes<successBudget&&createdCount<maxCreatedContracts;strategy++){
      const actor=actorRows[deterministicIndexV1(ethers,`${candidate.key}:${strategy}`,actorRows.length)]??privileged[0]??ethers.ZeroAddress;
      const wrapper=await buildCurveYieldWrapperCreationV1({provider,ethers,candidate,attempt:strategy,actor,valuePool});
      const built=wrapper===null?buildCreatorArgumentsV1({ethers,candidate,attempt:strategy,actor,valuePool,targets}):wrapper;
      if(built.status==='NOT_READY'){
        console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length} strategy=${strategy} INPUTS_UNAVAILABLE ${built.reason}: ${String(built.error??'').slice(0,200)}`);
        attempts.push({attempt:attempts.length+1,strategy,sender:actor,status:'PROTOCOL_INPUTS_UNAVAILABLE',reason:built.reason,error:built.error??null});
        // Don't spend all 24 attempts on a structural missing dependency.
        if(/PREDICTION_FAILED|NEED_TWO|TUPLE_ABI_MISMATCH/.test(built.reason))break;
        continue;
      }
      console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length} strategy=${strategy} PROTOCOL_PREFLIGHT ${built.basis??'GENERIC_ABI'}`);
      const startAttempt=Date.now();
      const base=await attemptCreatorCallV1({provider,ethers,candidate,sender:actor,args:built.args,selectorIndex,value:built.value??0n});
      console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length} strategy=${strategy} ${base.status} elapsedMs=${Date.now()-startAttempt} reason=${base.decoded?.reason??'none'}`);
      attempts.push({attempt:attempts.length+1,strategy,sender:actor,args:normalizeEvidenceValueV1(built.args),tokenSet:built.tokenSet,status:base.status,decoded:base.decoded??null,error:base.error??null});
      let result=base,sender=actor;
      if(base.status!=='PASS'&&authorizationLookingV1(base.decoded)){
        for(const privilegedSender of privileged){
          if(attempts.length>=attemptBudget)break;
          if(privilegedSender.toLowerCase()===actor.toLowerCase())continue;
          const retry=await attemptCreatorCallV1({provider,ethers,candidate,sender:privilegedSender,args:built.args,selectorIndex,value:built.value??0n});
          attempts.push({attempt:attempts.length+1,strategy,sender:privilegedSender,args:normalizeEvidenceValueV1(built.args),tokenSet:built.tokenSet,status:retry.status,decoded:retry.decoded??null,error:retry.error??null,authorizationRetry:true});
          if(retry.status==='PASS'){result=retry;sender=privilegedSender;break;}
        }
      }
      if(result.status!=='PASS')continue;
      successes++;
      // The CurveYield wrapper computes its pool address on-chain *before*
      // creation, and enforces expectedPool in _finishPoolCreated. Resolve
      // that actual deployed child directly rather than rebuilding every
      // vendor ABI and trying to parse every log (very slow with Balancer
      // enums and a full compiled-artifact inventory).
      let newAddresses;
      if(isCurveYieldWrapper&&built.expectedPool){
        newAddresses=await verifiedPredictedCurveYieldPoolV1({provider,ethers,expectedPool:built.expectedPool});
        console.log(`[phase0-fixture] Stage2 wrapper verified predictedPool=${built.expectedPool} deployed=${newAddresses.length===1}`);
      }else{
        newAddresses=await receiptAddressCandidatesV1({provider,ethers,receipt:result.receipt,artifacts,returnedValue:result.returnedValue,known});
      }
      const bound=[];
      for(const address of newAddresses){
        if(createdCount>=maxCreatedContracts)break;
        console.log(`[phase0-fixture] Stage2 binding created child ${address}`);
        const binding=await bindCreatedContractV1({provider,ethers,address,artifacts:[...artifacts,...syntheticArtifacts],probeHolder:sender});
        console.log(`[phase0-fixture] Stage2 binding complete ${address} status=${binding.status}`);
        known.add(address.toLowerCase());
        if(!valuePool.created) valuePool.created=[];
        if(!valuePool.addresses) valuePool.addresses=[];
        if(!valuePool.created.some(x=>String(x).toLowerCase()===address.toLowerCase()))valuePool.created.push(address);
        if(!valuePool.addresses.some(x=>String(x).toLowerCase()===address.toLowerCase()))valuePool.addresses.push(address);
        createdCount++;
        if(binding.syntheticArtifact&&!syntheticArtifacts.some(x=>`${x.sourceName}:${x.contractName}`===`${binding.syntheticArtifact.sourceName}:${binding.syntheticArtifact.contractName}`))syntheticArtifacts.push(binding.syntheticArtifact);
        if(binding.deployment){
          binding.deployment.transactionHash=result.transactionHash;binding.deployment.blockNumber=result.receipt?.blockNumber??null;
          createdDeployments.push(binding.deployment);
        }
        if(binding.token&&!createdTokens.some(x=>String(x.address).toLowerCase()===address.toLowerCase())){
          createdTokens.push(binding.token);
          if(!valuePool.tokens.some(x=>String(x?.address??x).toLowerCase()===address.toLowerCase()))valuePool.tokens.push(binding.token);
        }
        bound.push({address,status:binding.status,qualifiedName:binding.deployment?.qualifiedName??null,implementationAddress:binding.implementationAddress??null});
      }
      console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length} CHECKPOINT bound_children=${bound.length} prior_to_evidence_serialization`);
      const serializedCreatorArgs=normalizeEvidenceValueV1(built.args);
      console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length} CHECKPOINT creator_evidence_serialized`);
      creations.push({
        functionKey:candidate.key,target:candidate.target.qualifiedName,address:candidate.target.address,
        function:candidate.selected.signature,basis:candidate.basis,recipeBasis:built.basis??null,strategy,sender,
        argsSummary:serializedCreatorArgs,valueWei:String(built.value??0n),
        receipt:{transactionHash:result.transactionHash,blockNumber:result.receipt?.blockNumber??null,status:Number(result.receipt?.status??0),gasUsed:result.receipt?.gasUsed?.toString?.()??null},
        createdAddresses:newAddresses,boundArtifacts:bound
      });
      console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length} CHECKPOINT creation_recorded`);
    }
    console.log(`[phase0-fixture] Stage2 creator ${candidateIndex+1}/${candidates.length} complete successes=${successes} calls=${attempts.length}`);
    const failedAttempts=attempts.filter(x=>x.status!=='PASS');
    if(failedAttempts.length||successes<maxSuccessesPerCandidate){
      creationGaps.push({
        functionKey:candidate.key,target:candidate.target.qualifiedName,address:candidate.target.address,function:candidate.selected.signature,
        attemptCount:attempts.length,attempts,successes,status:successes===0?'NO_SUCCESS':(successes<maxSuccessesPerCandidate?'PARTIAL_SUCCESS':'PASS_WITH_RETRIES'),
        topDecodedRevertReasons:topCreationRevertsV1(attempts)
      });
    }
  }
  return{candidates:candidates.length,creations,creationGaps,createdDeployments,syntheticArtifacts,createdTokens,createdContracts:createdCount};
}
export async function approveFixtureSpendersV1({provider,ethers,tokens=[],holders=[],spenders=[]}){
  const holderAddresses=uniqueAddressesV1(ethers,holders),spenderAddresses=uniqueAddressesV1(ethers,spenders);
  const gaps=[],transactionReceipts=[],erc20Iface=new ethers.Interface(ERC20_APPROVE_ABI_V1),permit2Iface=new ethers.Interface(PERMIT2_APPROVE_ABI_V1);
  let permit2Code=false;
  try{const code=await provider.getCode(ethers.getAddress(PHASE0_PERMIT2_ADDRESS_V1));permit2Code=Boolean(code&&code!=='0x');}catch{}
  await mapLimitV1(holderAddresses,6,async holder=>{
    for(const tokenRecord of tokens){
      const token=normalizedAddressV1(ethers,tokenRecord?.address??tokenRecord);if(!token)continue;
      for(const spender of spenderAddresses){
        try{
          const receipt=await sendEncodedV1({provider,ethers,from:holder,to:token,iface:erc20Iface,signature:'approve(address,uint256)',args:[spender,ethers.MaxUint256]});
          transactionReceipts.push(receiptRowV1('ERC20_APPROVAL_STAGE2_CREATED_SPENDER',receipt,{token,holder,spender,amount:ethers.MaxUint256.toString()}));
        }catch(error){gaps.push({type:'STAGE2_CREATED_SPENDER_APPROVAL_FAILED',token,holder,spender,message:String(error?.shortMessage??error?.message??error).slice(0,1000)});}
        if(permit2Code){
          try{
            const receipt=await sendEncodedV1({provider,ethers,from:holder,to:ethers.getAddress(PHASE0_PERMIT2_ADDRESS_V1),iface:permit2Iface,signature:'approve(address,address,uint160,uint48)',args:[token,spender,(1n<<160n)-1n,(1n<<48n)-1n]});
            transactionReceipts.push(receiptRowV1('PERMIT2_ALLOWANCE_STAGE2_CREATED_SPENDER',receipt,{token,holder,spender}));
          }catch(error){gaps.push({type:'STAGE2_CREATED_SPENDER_PERMIT2_FAILED',token,holder,spender,message:String(error?.shortMessage??error?.message??error).slice(0,1000)});}
        }
      }
    }
  });
  transactionReceipts.sort((a,b)=>(a.blockNumber??0)-(b.blockNumber??0));
  return{
    holders:holderAddresses,spenders:spenderAddresses,transactionReceipts,gaps,
    receiptCounts:{
      erc20Approvals:transactionReceipts.filter(x=>x.kind==='ERC20_APPROVAL_STAGE2_CREATED_SPENDER').length,
      permit2Allowances:transactionReceipts.filter(x=>x.kind==='PERMIT2_ALLOWANCE_STAGE2_CREATED_SPENDER').length,
      gaps:gaps.length
    }
  };
}


const ACTIVATION_NAME_RE_V1=/^(?:initialize|init|activate|start|seed|enable|open|setup)/i;
const INITIALIZATION_DEPENDENCY_RE_V1=/(?:NotInitialized|NotRegistered|NotFound|DoesNotExist)/i;

function addressLeafCountV1(param){
  if(!param)return 0;
  if(param.baseType==='array')return 0;
  if(param.baseType==='tuple')return (param.components??[]).reduce((n,component)=>n+addressLeafCountV1(component),0);
  return String(param.type??'')==='address'?1:0;
}
function associationRowsForV1(valuePool,address){
  const needle=String(address??'').toLowerCase();
  for(const [key,value] of Object.entries(valuePool?.associations??{})){
    if(String(key).toLowerCase()!==needle)continue;
    return uniqueStringsV1(value instanceof Set?[...value]:(Array.isArray(value)?value:[]));
  }
  return[];
}
function tokenByAddressV1(valuePool={}){
  const out=new Map();
  for(const token of valuePool.tokens??[]){
    const address=String(token?.address??token);
    if(/^0x[0-9a-fA-F]{40}$/.test(address))out.set(address.toLowerCase(),token);
  }
  return out;
}
function associatedTokensV1(valuePool,address){
  const byAddress=tokenByAddressV1(valuePool);
  return associationRowsForV1(valuePool,address)
    .map(row=>byAddress.get(String(row).toLowerCase()))
    .filter(token=>token&&token.fundedAmount!=null&&BigInt(token.fundedAmount)>0n);
}
function activationCandidateKeyV1(target,selected,createdAddress){
  return functionKeyV1(target,selected)+'|created:'+String(createdAddress).toLowerCase();
}
export function discoverActivationCandidatesV1({targets=[],createdAddress}={}){
  const created=String(createdAddress??'').toLowerCase(),rows=[];
  for(const target of targets){
    for(const selected of target?.functions??[]){
      const fragment=selected?.fragment;
      if(!fragment||['view','pure'].includes(fragment.stateMutability))continue;
      const local=String(target?.address??'').toLowerCase()===created;
      const namedLocal=local&&ACTIVATION_NAME_RE_V1.test(String(fragment.name??''));
      const addressLeaves=(fragment.inputs??[]).reduce((n,param)=>n+addressLeafCountV1(param),0);
      if(!namedLocal&&addressLeaves===0)continue;
      rows.push({
        target,selected,createdAddress,
        key:activationCandidateKeyV1(target,selected,createdAddress),
        namedLocal,addressLeaves,
        priority:namedLocal?0:1,
        basis:namedLocal?'LOCAL_INITIALIZER_NAME':'CREATED_ADDRESS_INPUT'
      });
    }
  }
  return rows.sort((a,b)=>a.priority-b.priority||String(a.key).localeCompare(String(b.key)));
}
function activationAmountUnitV1(token){
  const decimals=Number(token?.decimals);
  if(!Number.isInteger(decimals)||decimals<0||decimals>70)return 1n;
  return 10n**BigInt(decimals);
}
function fixedOrDynamicLengthV1(param,dynamicLength){
  if(Number.isInteger(param?.arrayLength)&&param.arrayLength>=0)return Math.min(8,param.arrayLength);
  return Math.min(8,Math.max(0,dynamicLength));
}
function activationValueV1({ethers,param,ctx}){
  if(param?.baseType==='array'){
    if(param.arrayChildren?.baseType==='address'){
      const source=(ctx.tokens.length?ctx.tokens.map(x=>x.address):ctx.associations);
      const length=fixedOrDynamicLengthV1(param,source.length);
      if(!source.length)return[];
      return Array.from({length},(_,i)=>ethers.getAddress(source[i%source.length]));
    }
    if(/^uint(?:\d+)?$/.test(String(param.arrayChildren?.type??''))){
      const length=fixedOrDynamicLengthV1(param,ctx.tokens.length),bits=uintBitsV1(param.arrayChildren);
      if(!ctx.tokens.length)return[];
      return Array.from({length},(_,i)=>capUintV1(activationAmountUnitV1(ctx.tokens[i%ctx.tokens.length]),bits));
    }
    const length=fixedOrDynamicLengthV1(param,ctx.associations.length);
    return Array.from({length},()=>activationValueV1({ethers,param:param.arrayChildren,ctx}));
  }
  if(param?.baseType==='tuple')return (param.components??[]).map(component=>activationValueV1({ethers,param:component,ctx}));
  const type=String(param?.type??'');
  if(type==='address'){
    const index=ctx.addressCounter++;
    if(ctx.mustPlaceCreated&&index===ctx.createdSlot){ctx.placedCreated=true;return ctx.createdAddress;}
    const source=ctx.associations.length?ctx.associations:[ctx.actor,ethers.ZeroAddress];
    return ethers.getAddress(source[(index+ctx.attempt)%source.length]??ctx.actor);
  }
  if(type==='bool')return false;
  if(type==='bytes')return '0x';
  if(type==='string')return 'P0';
  if(type==='bytes32')return ethers.ZeroHash;
  if(/^bytes\d+$/.test(type))return ethers.zeroPadValue('0x',Number(type.slice(5)));
  if(/^uint(?:\d+)?$/.test(type)){
    const bits=uintBitsV1(param),name=String(param?.name??'').toLowerCase();
    if(/deadline|expiry|expiration|validuntil|timestamp/.test(name))return capUintV1((1n<<256n)-1n,bits);
    if(/min|minout|minimum|amountoutmin|limit/.test(name))return 0n;
    if(/amount|liquidity|value|assets|shares/.test(name))return capUintV1(activationAmountUnitV1(ctx.tokens[0]),bits);
    return 0n;
  }
  if(/^int(?:\d+)?$/.test(type))return 0;
  return 0;
}
export function buildActivationArgumentsV1({ethers,candidate,attempt=0,actor,valuePool={}}){
  const associations=associationRowsForV1(valuePool,candidate.createdAddress),tokens=associatedTokensV1(valuePool,candidate.createdAddress);
  const addressLeaves=(candidate.selected?.fragment?.inputs??[]).reduce((n,param)=>n+addressLeafCountV1(param),0);
  const ctx={
    actor,attempt,associations,tokens,createdAddress:ethers.getAddress(candidate.createdAddress),
    mustPlaceCreated:!candidate.namedLocal&&addressLeaves>0,createdSlot:addressLeaves?attempt%addressLeaves:0,addressCounter:0,placedCreated:false
  };
  const args=(candidate.selected?.fragment?.inputs??[]).map(param=>activationValueV1({ethers,param,ctx}));
  return{args,associations,tokens:tokens.map(token=>token.address),createdPlaced:ctx.placedCreated,createdSlot:ctx.createdSlot};
}
function parseCustomErrorAddressesV1({ethers,error,artifacts=[]}){
  const data=revertDataV1(error);
  if(!data)return{name:null,signature:null,addresses:[]};
  for(const artifact of artifacts){
    let iface;try{iface=new ethers.Interface(abiRowsV1(artifact?.abi));}catch{continue;}
    try{
      const parsed=iface.parseError(data);
      if(!parsed)continue;
      return{name:parsed.name,signature:parsed.signature,addresses:[...collectAddressesV1(ethers,parsed.args)]};
    }catch{}
  }
  return{name:null,signature:null,addresses:[]};
}
function activationDependencyHintV1({ethers,error,artifacts=[]}){
  const decoded=decodedFailureV1({ethers,error,selectorIndex:buildCompiledArtifactErrorSelectorIndexV1({ethers,artifacts})});
  const parsed=parseCustomErrorAddressesV1({ethers,error,artifacts});
  const reason=parsed.signature??decoded.reason??'';
  return{
    dependency:INITIALIZATION_DEPENDENCY_RE_V1.test(String(reason)),
    addresses:parsed.addresses,
    decoded:{...decoded,errorName:parsed.name,errorSignature:parsed.signature}
  };
}
async function attemptActivationCallV1({provider,ethers,candidate,sender,args,artifacts=[]}){
  const snapshot=await provider.send('evm_snapshot',[]);
  const iface=new ethers.Interface(abiRowsV1(candidate.target.artifact.abi));
  const signature=candidate.selected.signature,data=iface.encodeFunctionData(signature,args),value=0n;
  try{
    await provider.call({from:sender,to:candidate.target.address,data,value});
    const gas=await provider.estimateGas({from:sender,to:candidate.target.address,data,value});
    const signer=await provider.getSigner(sender);
    const tx=await signer.sendTransaction({to:candidate.target.address,data,value,gasLimit:gas+(gas/2n)+100000n});
    const receipt=await tx.wait();
    if(Number(receipt?.status)!==1)throw Object.assign(new Error('activation transaction reverted'),{receipt});
    return{status:'PASS',snapshot,receipt,transactionHash:tx.hash};
  }catch(error){
    await provider.send('evm_revert',[snapshot]).catch(()=>{});
    const hint=activationDependencyHintV1({ethers,error,artifacts});
    return{status:'REVERTED',decoded:hint.decoded,dependency:hint.dependency,dependencyAddresses:hint.addresses,error:String(error?.shortMessage??error?.message??error).slice(0,1600)};
  }
}
async function harvestTargetAssociationsV1({provider,ethers,address,abis=[]}){
  const found=new Set(),receipts=[],gaps=[];
  for(const abi of abis){
    let iface,contract;
    try{iface=new ethers.Interface(abiRowsV1(abi));contract=new ethers.Contract(address,abiRowsV1(abi),provider);}catch{continue;}
    for(const fragment of iface.fragments.filter(x=>x?.type==='function'&&['view','pure'].includes(x.stateMutability)&&x.inputs.length===0&&(x.outputs??[]).some(outputContainsAddressV1))){
      try{
        const value=await callNoArgV1(contract,fragment),addresses=collectAddressesV1(ethers,value);
        for(const row of addresses)found.add(row);
        receipts.push({kind:'CREATED_ASSOCIATION_VIEW',target:address,function:fragment.format('sighash'),addresses:[...addresses],status:'PASS'});
      }catch(error){
        gaps.push({type:'CREATED_ASSOCIATION_VIEW_REVERTED',target:address,function:fragment.format('sighash'),message:String(error?.shortMessage??error?.message??error).slice(0,800)});
      }
    }
  }
  return{addresses:[...found],receipts,gaps};
}
export async function refreshCreatedAssociationsV1({provider,ethers,createdAddresses=[],targets=[],bindings=[],artifacts=[],valuePool={}}){
  const receipts=[],gaps=[],newTokens=[];
  const byQualified=new Map(artifacts.map(artifact=>[String(artifact.sourceName)+':'+String(artifact.contractName),artifact]));
  for(const raw of uniqueAddressesV1(ethers,createdAddresses)){
    const address=ethers.getAddress(raw),targetAbis=targets.filter(target=>String(target.address).toLowerCase()===address.toLowerCase()).map(target=>target.artifact?.abi).filter(Boolean);
    for(const binding of bindings.filter(row=>String(row?.address??'').toLowerCase()===address.toLowerCase())){
      const artifact=byQualified.get(binding.qualifiedName);
      if(artifact)targetAbis.push(artifact.abi);
    }
    if(!targetAbis.length){gaps.push({type:'CREATED_ASSOCIATION_ABI_UNAVAILABLE',target:address});continue;}
    const harvested=await harvestTargetAssociationsV1({provider,ethers,address,abis:targetAbis});
    receipts.push(...harvested.receipts);gaps.push(...harvested.gaps);
    const existing=valuePool.associations?.[address]??new Set();
    const set=existing instanceof Set?existing:new Set(existing??[]);
    valuePool.associations=valuePool.associations??{};
    valuePool.associations[address]=set;
    for(const associated of harvested.addresses){
      set.add(associated);
      if(!valuePool.addresses.some(x=>String(x).toLowerCase()===associated.toLowerCase()))valuePool.addresses.push(associated);
      if((valuePool.tokens??[]).some(token=>String(token?.address??token).toLowerCase()===associated.toLowerCase()))continue;
      try{
        const shape=await probeErc20ShapeV1({provider,ethers,address:associated,probeHolder:address});
        const token={symbol:null,address:associated,source:'CREATED_ASSOCIATION_ERC20_SHAPE',decimals:shape.decimals,totalSupply:shape.totalSupply};
        valuePool.tokens.push(token);newTokens.push(token);
        receipts.push({kind:'CREATED_ASSOCIATION_ERC20_PROBE',target:address,address:associated,decimals:shape.decimals,totalSupply:shape.totalSupply,status:'PASS'});
      }catch{}
    }
  }
  return{receipts,gaps,newTokens};
}
function topActivationRevertsV1(attempts,limit=10){
  const counts=new Map();
  for(const attempt of attempts.filter(row=>row.status==='REVERTED')){
    const reason=attempt.decoded?.reason??'UNKNOWN_REVERT',key=String(attempt.decoded?.kind??'UNKNOWN')+'|'+String(attempt.decoded?.selector??'')+'|'+String(reason);
    const current=counts.get(key)??{kind:attempt.decoded?.kind??'UNKNOWN_REVERT',selector:attempt.decoded?.selector??null,reason,count:0};
    current.count++;counts.set(key,current);
  }
  return[...counts.values()].sort((a,b)=>b.count-a.count||String(a.reason).localeCompare(String(b.reason))).slice(0,limit);
}
export async function executeActivationSynthesisV1({provider,ethers,targets=[],actors=[],valuePool={},artifacts=[],createdAddresses=[],maxAttemptsPerCreated=30}){
  const activations=[],activationGaps=[],actorRows=uniqueAddressesV1(ethers,actors),privileged=uniqueAddressesV1(ethers,valuePool.privileged??[]);
  const created=uniqueAddressesV1(ethers,createdAddresses),createdSet=new Set(created.map(x=>x.toLowerCase())),queue=[...created],states=new Map(),completed=new Set();
  const stateFor=createdAddress=>{
    const key=createdAddress.toLowerCase();
    if(states.has(key))return states.get(key);
    const candidates=discoverActivationCandidatesV1({targets,createdAddress});
    const state={createdAddress,candidates,successful:new Set(),attemptsByFunction:new Map(),dependencyPriorities:new Set(),totalAttempts:0,finalized:false};
    states.set(key,state);return state;
  };
  const prioritizeCreated=address=>{
    const normalized=ethers.getAddress(address),key=normalized.toLowerCase();
    if(!createdSet.has(key)||completed.has(key))return;
    for(let i=queue.length-1;i>=0;i--)if(String(queue[i]).toLowerCase()===key)queue.splice(i,1);
    queue.unshift(normalized);
  };
  while(queue.length){
    const createdAddress=ethers.getAddress(queue.shift()),createdKey=createdAddress.toLowerCase();
    if(completed.has(createdKey))continue;
    const state=stateFor(createdAddress);
    let deferred=false;
    while(state.totalAttempts<maxAttemptsPerCreated&&state.successful.size<state.candidates.length&&state.candidates.length){
      const remaining=state.candidates.filter(candidate=>!state.successful.has(candidate.key));
      const priorityRows=remaining.filter(candidate=>state.dependencyPriorities.has(candidate.key));
      const selectionPool=priorityRows.length?priorityRows:remaining;
      selectionPool.sort((a,b)=>{
        const ac=(state.attemptsByFunction.get(a.key)??[]).length,bc=(state.attemptsByFunction.get(b.key)??[]).length;
        return ac-bc||a.priority-b.priority||String(a.key).localeCompare(String(b.key));
      });
      const candidate=selectionPool[0],prior=state.attemptsByFunction.get(candidate.key)??[],attemptIndex=prior.length;
      const actor=actorRows[deterministicIndexV1(ethers,candidate.key+':'+attemptIndex,actorRows.length)]??privileged[0]??ethers.ZeroAddress;
      const built=buildActivationArgumentsV1({ethers,candidate,attempt:attemptIndex,actor,valuePool});
      let result=await attemptActivationCallV1({provider,ethers,candidate,sender:actor,args:built.args,artifacts}),sender=actor;
      const record=row=>({
        attempt:++state.totalAttempts,sender:row.sender,argsSummary:normalizeEvidenceValueV1(built.args),status:row.result.status,
        decoded:row.result.decoded??null,dependency:row.result.dependency??false,dependencyAddresses:row.result.dependencyAddresses??[],error:row.result.error??null,
        authorizationRetry:row.authorizationRetry===true
      });
      prior.push(record({sender,result,authorizationRetry:false}));state.attemptsByFunction.set(candidate.key,prior);
      if(result.status!=='PASS'&&authorizationLookingV1(result.decoded)){
        for(const privilegedSender of privileged){
          if(state.totalAttempts>=maxAttemptsPerCreated)break;
          if(privilegedSender.toLowerCase()===actor.toLowerCase())continue;
          const retry=await attemptActivationCallV1({provider,ethers,candidate,sender:privilegedSender,args:built.args,artifacts});
          prior.push(record({sender:privilegedSender,result:retry,authorizationRetry:true}));
          if(retry.status==='PASS'){result=retry;sender=privilegedSender;break;}
        }
      }
      if(result.status==='PASS'){
        state.successful.add(candidate.key);state.dependencyPriorities.delete(candidate.key);
        activations.push({
          createdAddress,functionKey:candidate.key,target:candidate.target.qualifiedName,address:candidate.target.address,
          function:candidate.selected.signature,basis:candidate.basis,sender,argsSummary:normalizeEvidenceValueV1(built.args),
          receipt:{transactionHash:result.transactionHash,blockNumber:result.receipt?.blockNumber??null,status:Number(result.receipt?.status??0),gasUsed:result.receipt?.gasUsed?.toString?.()??null}
        });
        continue;
      }
      if(result.dependency){
        const hints=uniqueAddressesV1(ethers,result.dependencyAddresses??[]).filter(address=>createdSet.has(address.toLowerCase()));
        const externalHints=hints.filter(address=>address.toLowerCase()!==createdKey&&!completed.has(address.toLowerCase()));
        if(externalHints.length){
          for(let i=externalHints.length-1;i>=0;i--)prioritizeCreated(externalHints[i]);
          for(let i=queue.length-1;i>=0;i--)if(String(queue[i]).toLowerCase()===createdKey)queue.splice(i,1);
          queue.splice(externalHints.length,0,createdAddress);
          deferred=true;break;
        }
        for(const local of state.candidates.filter(row=>row.namedLocal))state.dependencyPriorities.add(local.key);
      }
    }
    if(deferred)continue;
    if(!state.finalized){
      for(const candidate of state.candidates){
        if(state.successful.has(candidate.key))continue;
        const attempts=state.attemptsByFunction.get(candidate.key)??[];
        activationGaps.push({
          createdAddress,functionKey:candidate.key,target:candidate.target.qualifiedName,address:candidate.target.address,function:candidate.selected.signature,
          status:attempts.length?'NO_SUCCESS':'UNEXERCISED_ATTEMPT_BUDGET',attemptCount:attempts.length,attempts,
          topDecodedRevertReasons:topActivationRevertsV1(attempts)
        });
      }
      if(!state.candidates.length)activationGaps.push({createdAddress,status:'NO_ACTIVATION_CANDIDATES',attemptCount:0,attempts:[],topDecodedRevertReasons:[]});
      state.finalized=true;
    }
    completed.add(createdKey);
  }
  return{activations,activationGaps,createdContracts:created.length};
}
