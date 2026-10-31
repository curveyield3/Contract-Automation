import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ethers,C,R,quote,read,collect,json,save,safeError} from '../src/fxmint-wbtc-repayment-data-v3.mjs';
const MAX_FEE=155000000n;
const PRIORITY_FEE=100000n;
const feeOverrides={type:2,maxFeePerGas:MAX_FEE,maxPriorityFeePerGas:PRIORITY_FEE};
const rpcFees={type:'0x2',maxFeePerGas:ethers.toQuantity(MAX_FEE),maxPriorityFeePerGas:ethers.toQuantity(PRIORITY_FEE)};
const TARGET_DEBT=100000000000000000000n;
const gasReceipts=[];
function recordGas(receipt,label){
  const gasUsed=BigInt(receipt.gasUsed);
  const price=BigInt(receipt.effectiveGasPrice??receipt.gasPrice);
  assert(price<=MAX_FEE,'Receipt exceeded 0.155 gwei cap');
  const costWei=gasUsed*price;
  gasReceipts.push({label,hash:receipt.transactionHash??receipt.hash,gasUsed,gasPriceWei:price,costWei,costEth:ethers.formatEther(costWei)});
  const totalWei=gasReceipts.reduce((sum,x)=>sum+x.costWei,0n);
  save('GAS_COST_v10.json',{maxFeeGwei:'0.155',priorityFeeGwei:'0.0001',transactions:gasReceipts,totalWei,totalEth:ethers.formatEther(totalWei)});
}
const root=dirname(fileURLToPath(import.meta.url));
const artifactPath=resolve(root,'out/FxMintWbtcRepayer_v3.sol/FxMintWbtcRepayer_v3.json');
const nftAbi=['function approve(address,uint256)','function getApproved(uint256) view returns(address)','function ownerOf(uint256) view returns(address)','function getPosition(uint256) view returns(uint256,uint256)'];
const balance=(p,t,a)=>read(p,t,'balanceOf(address) view returns(uint256)',[a]);
const assert=(condition,message)=>{if(!condition)throw Error(message);};
async function expectRevert(label,fn,signature){try{await fn();}catch(e){const data=e.data||e.info?.error?.data;assert(typeof data==='string'&&data.slice(0,10)===ethers.id(signature).slice(0,10),`Wrong revert for ${label}: ${safeError(e)}`);console.log(`PASS negative check: ${label} (${signature})`);return;}throw Error(`Negative check did not revert: ${label}`);}
function compile(){
  writeFileSync(resolve(root,'foundry.toml'),`[profile.default]\nsrc="contracts"\nout="out"\nlibs=[]\nsolc_version="0.8.28"\nevm_version="cancun"\noptimizer=true\noptimizer_runs=200\nvia_ir=true\nremappings=["@openzeppelin/=${process.env.FXMINT_DEPS}/node_modules/@openzeppelin/"]\n`);
  const r=spawnSync('forge',['build','--root',root],{encoding:'utf8',timeout:180000});
  console.log(safeError({message:r.stdout}));if(r.status!==0)throw Error('GitHub compilation failed: '+safeError({message:r.stderr}));
  return JSON.parse(readFileSync(artifactPath,'utf8'));
}
async function choosePosition(data){
  const candidates=data.positions.filter(x=>BigInt(x.rawDebt)>0n);
  const specified=process.env.FXMINT_POSITION_ID;
  if(specified){const p=candidates.find(x=>String(x.id)===specified);assert(p,'Requested position is not an indebted owner WBTC position');return p;}
  assert(candidates.length===1,'Specify position ID when owner has multiple indebted WBTC positions');return candidates[0];
}
async function makePlan(p,id){
  const fees=await read(p,C.configuration,'getPoolFeeRatio(address,address) view returns(uint256,uint256,uint256,uint256)',[C.pool,C.router]);
  const firstQuote=await quote(p,100400000n,R.usdcFx);const firstMinimum=firstQuote*999n/1000n>100200000000000000000n?firstQuote*999n/1000n:100200000000000000000n;
  const repaymentSpend=(TARGET_DEBT*(1000000000n+fees[3])+999999999n)/1000000000n;
  assert(firstMinimum>=repaymentSpend,'First swap minimum does not cover exact 100 fxUSD repayment plus protocol fee');
  assert(firstQuote>=firstMinimum,'USDC->fxUSD quote fails required floor');
  const target=100900000000000000000n;
  const requiredQuote=(target*10000n+9974n)/9975n;
  const [rawColl]=await read(p,C.pool,'getPosition(uint256) view returns(uint256,uint256)',[id]);
  const net=gross=>gross-gross*fees[1]/1000000000n;
  const solutions=[];
  for(let route=0;route<R.wbtcFx.length;route++){
    try{
      let hi=1000000n;
      while(await quote(p,net(hi),R.wbtcFx[route])<requiredQuote){hi*=2n;assert(hi*10000000000n<rawColl,'Insufficient position collateral for quote');}
      let lo=0n;while(hi-lo>1n){const mid=(lo+hi)/2n;if(await quote(p,net(mid),R.wbtcFx[route])>=requiredQuote)hi=mid;else lo=mid;}
      const q=await quote(p,net(hi),R.wbtcFx[route]);solutions.push({route,withdrawWbtc:hi,netWbtc:net(hi),quote:q,secondMinimum:q*9975n/10000n});
    }catch(e){console.log(`Route ${route} unavailable: ${safeError(e)}`);}
  }
  assert(solutions.length>0,'No WBTC route can reach 100.9 fxUSD with 0.25% slippage');
  solutions.sort((a,b)=>a.withdrawWbtc<b.withdrawWbtc?-1:1);const best=solutions[0];
  const block=await p.send('eth_getBlockByNumber',['latest',false]);
  const plan={positionId:id,withdrawWbtc:best.withdrawWbtc,firstMinimum,secondMinimum:best.secondMinimum,deadline:Number(BigInt(block.timestamp))+300,route:best.route};
  save('PLAN_v10.json',{plan,firstQuote,repayFee:fees[3],withdrawFee:fees[1],solutions});return plan;
}
async function forkSend(p,tx,label){
  console.log('STAGE: '+label+' send');
  const hash=await p.send('eth_sendTransaction',[{...tx,...rpcFees}]);
  for(let i=0;i<120;i++){
    const receipt=await p.send('eth_getTransactionReceipt',[hash]);
    if(receipt){assert(BigInt(receipt.status)===1n,label+' reverted');recordGas(receipt,label);console.log('STAGE: '+label+' mined '+hash);return receipt;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error(label+' receipt missing after 60 seconds');
}
async function executeAndVerify(p,signer,helper,plan,simulation){
  const nft=new ethers.Contract(C.pool,nftAbi,signer);const helperAddress=await helper.getAddress();
  const before=Array.from(await nft.getPosition(plan.positionId));
  const vaultBefore=await balance(p,C.usdc,C.balancer);
  const initial={usdc:await balance(p,C.usdc,helperAddress),fxusd:await balance(p,C.fxusd,helperAddress),wbtc:await balance(p,C.wbtc,helperAddress)};
  assert(Object.values(initial).every(x=>x===0n),'Executor must begin with zero tokens to prove self-funded repayment');
  const previousApproval=await nft.getApproved(plan.positionId);
  if(simulation){
    await forkSend(p,{from:C.owner,to:C.pool,data:nft.interface.encodeFunctionData('approve',[helperAddress,plan.positionId]),gas:'0x7a120'},'position approval');
  }else{console.log('STAGE: position approval');const approval=await nft.approve(helperAddress,plan.positionId,{...feeOverrides});console.log('STAGE: live approval sent '+approval.hash);save('APPROVAL_PENDING_v10.json',{hash:approval.hash,helper:helperAddress,positionId:plan.positionId});const approvalReceipt=await approval.wait(1,600000);recordGas(approvalReceipt,'position approval');console.log('STAGE: position approval mined');}
  try{
    if(simulation){
      await expectRevert('100.2 fxUSD absolute floor',()=>helper.execute.staticCall({...plan,firstMinimum:100199999999999999999n}),'InvalidPlan()');
      await expectRevert('100.9 fxUSD absolute floor',()=>helper.execute.staticCall({...plan,secondMinimum:100899999999999999999n}),'InvalidPlan()');
      await expectRevert('expired deadline',()=>helper.execute.staticCall({...plan,deadline:1}),'InvalidPlan()');
      await expectRevert('unachievable output rolls back all state',()=>helper.execute.staticCall({...plan,secondMinimum:1000000000000000000000000n}),'InsufficientOutput()');
      const unchanged=Array.from(await nft.getPosition(plan.positionId));assert(json(unchanged)===json(before),'Failed call changed position');
      assert((await nft.ownerOf(plan.positionId)).toLowerCase()===C.owner,'Failed call did not restore NFT');
    }
    console.log('STAGE: estimate atomic repayment');const gas=await helper.execute.estimateGas(plan);console.log('STAGE: repayment estimate passed '+gas);
    let receipt;
    if(simulation){
      const hash=await p.send('eth_sendTransaction',[{from:C.owner,to:helperAddress,data:helper.interface.encodeFunctionData('execute',[plan]),gas:ethers.toQuantity(gas*130n/100n),...rpcFees}]);
      console.log('STAGE: fork repayment sent '+hash);
      for(let i=0;i<120;i++){const raw=await p.send('eth_getTransactionReceipt',[hash]);if(raw){receipt={...raw,hash:raw.transactionHash,status:Number(BigInt(raw.status)),gasUsed:BigInt(raw.gasUsed),blockNumber:Number(BigInt(raw.blockNumber))};break;}await new Promise(r=>setTimeout(r,500));}
      assert(receipt,'Fork repayment receipt missing after 60 seconds');
    }else{const tx=await helper.execute(plan,{gasLimit:gas*130n/100n,...feeOverrides});console.log('STAGE: live repayment sent '+tx.hash);save('REPAYMENT_PENDING_v10.json',{hash:tx.hash,helper:helperAddress,plan});receipt=await tx.wait(1,600000);}
    console.log('STAGE: repayment mined; verify balances');assert(receipt.status===1,'Repayment receipt status failed');recordGas(receipt,'atomic repayment');
    const after=Array.from(await nft.getPosition(plan.positionId));
    const events=receipt.logs.filter(l=>l.address.toLowerCase()===helperAddress.toLowerCase()).map(l=>helper.interface.parseLog(l)).filter(Boolean).map(e=>({name:e.name,args:Array.from(e.args)}));
    const swaps=events.filter(e=>e.name==='Swap');const flash=events.find(e=>e.name==='FlashLoanRepaid');const debt=events.find(e=>e.name==='DebtRepaid');
    assert(swaps.length===3&&flash&&debt,'Required complete flash-loan/swap/debt events missing');
    assert(BigInt(swaps[0].args[2])===100400000n,'Flash principal swap mismatch');
    assert(BigInt(swaps[0].args[3])>=plan.firstMinimum,'First swap floor violated');
    assert(BigInt(swaps[1].args[3])>=plan.secondMinimum,'WBTC proceeds floor violated');
    assert(BigInt(flash.args[0])===100400000n,'Flash principal mismatch');
    const fee=BigInt(flash.args[1]);const vaultAfter=await balance(p,C.usdc,C.balancer);
    assert(vaultAfter-vaultBefore===fee,'Balancer did not receive principal plus exact fee');
    assert(after[1]<before[1]&&after[0]<before[0],'Debt/collateral did not decrease');
    const debtDelta=before[1]-after[1];
    assert(debtDelta>=TARGET_DEBT-1000000000000n&&debtDelta<=TARGET_DEBT+1000000000000n,'Debt reduction is not 100 fxUSD within protocol rounding');
    assert((await nft.ownerOf(plan.positionId)).toLowerCase()===C.owner,'NFT ownership was not restored');
    for(const token of [C.usdc,C.fxusd,C.wbtc])assert(await balance(p,token,helperAddress)===0n,'Executor retained tokens');
    const result={version:10,status:'PASS',mode:simulation?'simulate-only':'live-broadcast',chainId:1,helper:helperAddress,transactionHash:receipt.hash,blockNumber:receipt.blockNumber,gasUsed:receipt.gasUsed,maxFeeWei:MAX_FEE,priorityFeeWei:PRIORITY_FEE,effectiveGasPriceWei:BigInt(receipt.effectiveGasPrice??receipt.gasPrice),repaymentGasCostEth:ethers.formatEther(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice??receipt.gasPrice)),gasCosts:gasReceipts,positionId:plan.positionId,before,after,debtDecrease:before[1]-after[1],rawCollateralDecrease:before[0]-after[0],vaultBefore,vaultAfter,flashFee:fee,initialExecutorBalances:initial,events,plan};
    save(simulation?'SIMULATION_v10.json':'BROADCAST_v10.json',result);console.log(json(result));return result;
  }catch(e){
    if(simulation){
      const names=['Unauthorized()','InvalidPlan()','InsufficientOutput()','CallbackOnly()','ErrorInsufficientOutput()','ErrorNotPositionOwner()','ErrorNoSupplyAndNoBorrow()','ErrorDebtRatioTooSmall()','ErrorDebtRatioTooLarge()','ErrorTopLevelCall()','ErrorTargetNotApproved()','ErrorPositionInLiquidationMode()'];
      console.log(json({errorSelectors:Object.fromEntries(names.map(name=>[ethers.id(name).slice(0,10),name])),revertData:e.data||e.info?.error?.data}));
      try{
        const trace=await p.send('debug_traceCall',[{from:C.owner,to:helperAddress,data:helper.interface.encodeFunctionData('execute',[plan]),gas:'0x989680'},'latest',{tracer:'callTracer'}]);
        save('TRACE_v10.json',trace);
        const failures=[];function walk(node,depth=0){if(node.error)failures.push({depth,to:node.to,input:node.input?.slice(0,10),output:node.output,error:node.error});for(const child of node.calls||[])walk(child,depth+1);}walk(trace);console.log(json({traceFailures:failures}));
      }catch(traceError){console.error('Trace unavailable: '+safeError(traceError));}
    }else{console.error('Live failure: inspect submitted transaction receipts before retrying; existing NFT approval may require owner cleanup');}
    throw e;
  }
}
let anvil;const providers=[];
try{
  assert(process.env.ETH_RPC_URL,'Repository Ethereum RPC secret is missing');
  const remote=new ethers.JsonRpcProvider(process.env.ETH_RPC_URL,1,{staticNetwork:true});providers.push(remote);
  const data=await collect(remote);const position=await choosePosition(data);const artifact=compile();
  mkdirSync('fxmint-output',{recursive:true});
  anvil=spawn('anvil',['--fork-url',process.env.ETH_RPC_URL,'--fork-block-number',String(data.block),'--port','8545','--host','127.0.0.1','--chain-id','1','--silent'],{stdio:['ignore','pipe','pipe']});
  let anvilLog='';for(const stream of [anvil.stdout,anvil.stderr])stream.on('data',chunk=>{anvilLog+=safeError({message:chunk.toString()});});
  const forkRequest=new ethers.FetchRequest('http://127.0.0.1:8545');forkRequest.timeout=20000;
  const p=new ethers.JsonRpcProvider(forkRequest,1,{staticNetwork:true,batchMaxCount:1,cacheTimeout:0});providers.push(p);
  let ready=false;for(let attempt=0;attempt<90;attempt++){try{assert(await p.send('eth_chainId',[])==='0x1','Fork chain mismatch');ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
  assert(ready,'Anvil startup failed: '+anvilLog);
  assert((await p.send('eth_getBlockByNumber',[ethers.toQuantity(data.block),false])).hash===data.blockHash,'Fork block/hash mismatch');
  const feeBlock=await p.send('eth_getBlockByNumber',['latest',false]);
  const upstreamBaseFee=BigInt(feeBlock.baseFeePerGas);
  assert(upstreamBaseFee+PRIORITY_FEE<=MAX_FEE,'Current Ethereum base fee plus priority exceeds 0.155 gwei cap');
  const feeScenarioOverride=false;
  await p.send('anvil_impersonateAccount',[C.owner]);
  // Gas only: no token balances, collateral, debt, ownership or contract storage is fabricated.
  const ownerEth=BigInt(await p.send('eth_getBalance',[C.owner,'latest']));
  if(ownerEth<ethers.parseEther('1'))await p.send('anvil_setBalance',[C.owner,ethers.toQuantity(ethers.parseEther('1'))]);
  save('FORK_v10.json',{maxFeeWei:MAX_FEE,priorityFeeWei:PRIORITY_FEE,upstreamBaseFeeWei:upstreamBaseFee,feeScenarioOverride,chainId:1,block:data.block,blockHash:data.blockHash,gasBalanceOverride:ownerEth<ethers.parseEther('1'),noTokenOrProtocolStorageOverrides:true});
  console.log('STAGE: fork ready; obtain signers');
  const signer=await p.getSigner(C.owner);const outsider=await p.getSigner(0);
  const existingHelper='0x69B658189d63C39126F7BD017D883A872487713e';
  assert(!process.env.FXMINT_HELPER_ADDRESS||process.env.FXMINT_HELPER_ADDRESS.toLowerCase()===existingHelper.toLowerCase(),'Only the previously deployed helper is authorized');
  const trustedRuntimeHash='0x37d8093efb88c9da3d4d3c6113fb75424d2a8519f97f470a25560c1fc58168e0';
  assert(ethers.keccak256(await p.getCode(existingHelper))===trustedRuntimeHash,'Existing fork helper runtime mismatch');
  const helper=new ethers.Contract(existingHelper,artifact.abi,outsider);
  assert((await helper.owner()).toLowerCase()===C.owner,'Existing fork helper owner mismatch');
  console.log('STAGE: calculate repayment plan');
  const plan=await makePlan(p,position.id);
  await expectRevert('only owner executes',()=>helper.connect(outsider).execute.staticCall(plan),'Unauthorized()');
  await expectRevert('only active Balancer callback',()=>helper.connect(outsider).receiveFlashLoan.staticCall([C.usdc],[100400000n],[0n],'0x'),'CallbackOnly()');
  await executeAndVerify(p,signer,helper.connect(signer),plan,true);
  const expectedRuntimeHash=ethers.keccak256(await p.getCode(await helper.getAddress()));
  p.destroy();anvil.kill('SIGTERM');anvil=undefined;
  if(process.env.FXMINT_MODE==='live-broadcast'){
    assert(process.env.FXMINT_CONFIRMATION==='LIVE 100 FXUSD','Live confirmation mismatch');
    if(process.env.FXMINT_AUTHORIZATION_EXPIRES)assert(Date.now()<Date.parse(process.env.FXMINT_AUTHORIZATION_EXPIRES),'Live authorization expired; no broadcast attempted');
    assert(process.env.FXMINT_PRIVATE_KEY,'Configure DEPLOYER_FX in the protected production environment');
    const wallet=new ethers.Wallet(process.env.FXMINT_PRIVATE_KEY,remote);assert(wallet.address.toLowerCase()===C.owner,'Live signer is not the position owner');
    gasReceipts.length=0;
    const liveData=await collect(remote);await choosePosition(liveData);
    const liveFeeBlock=await remote.send('eth_getBlockByNumber',['latest',false]);assert(BigInt(liveFeeBlock.baseFeePerGas)+PRIORITY_FEE<=MAX_FEE,'Live Ethereum base fee plus priority exceeds 0.155 gwei cap; no broadcast attempted');
    const livePosition=liveData.positions.find(x=>x.id===887);assert(livePosition&&String(livePosition.rawDebt)==='100070130433123808237','Live position debt changed since authorized simulation; no broadcast attempted');
    const liveHelper=new ethers.Contract(existingHelper,artifact.abi,wallet);
    assert((await liveHelper.owner()).toLowerCase()===C.owner,'Live helper owner mismatch');
    assert(ethers.keccak256(await remote.getCode(await liveHelper.getAddress()))===expectedRuntimeHash,'Live helper runtime differs from fork-tested code');
    const livePlan=await makePlan(remote,position.id);await executeAndVerify(remote,wallet,liveHelper,livePlan,false);
  }
}catch(e){save('ERROR_v10.json',{status:'FAIL',error:safeError(e),revertData:e.data||e.info?.error?.data});console.error(safeError(e));process.exitCode=1;}
finally{for(const provider of providers)provider.destroy();if(anvil)anvil.kill('SIGTERM');}
