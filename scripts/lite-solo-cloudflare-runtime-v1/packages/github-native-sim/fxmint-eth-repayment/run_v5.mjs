// Runner implementation v7; canonical path retained for the existing workflow.
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ethers,C,R,quote,read,collect,json,save,safeError} from './data_v3.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const PROVEN_ROUTE_ONLY=process.env.FXMINT_MODE==='live-broadcast'||process.env.FXMINT_ROUTE_MODE==='proven-only';
const artifactPath=resolve(root,'out/FxMintEthRepayer_v1.sol/FxMintEthRepayer_v1.json');
const TARGET=ethers.parseUnits(process.env.FXMINT_REPAYMENT_FXUSD||'10',18);
const TOTAL_FEE_CAP=ethers.parseUnits(process.env.FXMINT_MAX_FEE_GWEI||'1',9);
const MAX_BASE_FEE=ethers.parseUnits(process.env.FXMINT_MAX_BASE_GWEI||'0.09',9);
const PRIORITY=10000n; // Fixed 0.00001 gwei; no environment or per-run override.
const MAX_FEE=TOTAL_FEE_CAP<MAX_BASE_FEE+PRIORITY?TOTAL_FEE_CAP:MAX_BASE_FEE+PRIORITY;
const feeOverrides={type:2,maxFeePerGas:MAX_FEE,maxPriorityFeePerGas:PRIORITY};
const rpcFees={type:'0x2',maxFeePerGas:ethers.toQuantity(MAX_FEE),maxPriorityFeePerGas:ethers.toQuantity(PRIORITY)};
const assert=(v,m)=>{if(!v)throw Error(m);};
const ceil=(x,y)=>(x+y-1n)/y;
const nftAbi=['function approve(address,uint256)','function getApproved(uint256) view returns(address)','function ownerOf(uint256) view returns(address)','function getPosition(uint256) view returns(uint256,uint256)'];
const balance=(p,t,a)=>read(p,t,'balanceOf(address) view returns(uint256)',[a]);
function validateBaseFee(base,label){
 assert(base<=MAX_BASE_FEE,label+' base fee exceeds max_base_gwei');
 assert(base+PRIORITY<=MAX_FEE,label+' base fee plus fixed priority exceeds total fee cap');
 return base;
}
async function checkCurrentBaseFee(p,label){
 const header=await p.send('eth_getBlockByNumber',['latest',false]);
 return validateBaseFee(BigInt(header.baseFeePerGas),label);
}
async function waitForLiveHelper(p,helper,runtimeHash,minBlock=0,attempts=30){
 const address=await helper.getAddress();
 for(let i=0;i<attempts;i++){
  const block=await p.send('eth_blockNumber',[]);
  if(BigInt(block)>=BigInt(minBlock)){
   const code=await p.send('eth_getCode',[address,block]);
   if(code!=='0x'){
    assert(ethers.keccak256(code)===runtimeHash,'Live helper runtime mismatch');
    const raw=await p.send('eth_call',[{to:address,data:helper.interface.encodeFunctionData('owner')},block]);
    if(raw!=='0x'){
     const owner=helper.interface.decodeFunctionResult('owner',raw)[0].toLowerCase();
     assert(owner===C.owner,'Live helper owner mismatch');
     return {address,block,runtimeHash,owner};
    }
   }
  }
  if(i+1<attempts)await new Promise(r=>setTimeout(r,1000));
 }
 throw Error('Live helper not readable after bounded RPC synchronization; reuse '+address+' instead of redeploying');
}
async function mine(p,tx,label){
 await checkCurrentBaseFee(p,label);
 const hash=await p.send('eth_sendTransaction',[{...tx,...rpcFees}]);
 for(let i=0;i<120;i++){const r=await p.send('eth_getTransactionReceipt',[hash]);if(r){assert(BigInt(r.status)===1n,label+' reverted');return {...r,hash,status:1,gasUsed:BigInt(r.gasUsed),blockNumber:Number(BigInt(r.blockNumber)),gasPrice:BigInt(r.effectiveGasPrice)};}await new Promise(r=>setTimeout(r,250));}
 throw Error(label+' receipt unavailable');
}
async function negative(label,fn,signature){
 try{await fn();}catch(e){const d=e.data||e.info?.error?.data;assert(typeof d==='string'&&d.slice(0,10)===ethers.id(signature).slice(0,10),'Wrong revert: '+label);console.log('PASS negative: '+label);return;}
 throw Error('Expected revert: '+label);
}
function compile(){
  writeFileSync(resolve(root,'foundry.toml'),`[profile.default]\nsrc="contracts"\nout="out"\nlibs=[]\nsolc_version="0.8.28"\nevm_version="cancun"\noptimizer=true\noptimizer_runs=200\nvia_ir=true\nremappings=["@openzeppelin/=${process.env.FXMINT_DEPS}/node_modules/@openzeppelin/"]\n`);
  const r=spawnSync('forge',['build','--root',root],{encoding:'utf8',timeout:180000});
  console.log(safeError({message:r.stdout}));if(r.status!==0)throw Error('GitHub compilation failed: '+safeError({message:r.stderr}));
  return JSON.parse(readFileSync(artifactPath,'utf8'));
}

async function choosePosition(data){
 const specified=process.env.FXMINT_POSITION_ID;
 const matches=data.positions.filter(x=>BigInt(x.rawDebt)>=TARGET&&(!specified||String(x.id)===specified));
 assert(matches.length===1,'Specify a unique indebted owner position with enough debt');return matches[0];
}
async function smallest(quoteFn,target,guess,maximum,precision=1n){
 let hi=guess>0n?guess:1n;assert(hi<maximum,'Insufficient available balance');
 while(await quoteFn(hi)<target){hi*=2n;assert(hi<maximum,'Insufficient available balance');}
 let lo=0n;
 while(hi-lo>precision){const mid=(hi+lo)/2n;if(await quoteFn(mid)>=target)hi=mid;else lo=mid;}
 return hi;
}
async function plans(p,data,position,target){
 const [,,,repayFee]=data.fees;const withdrawFee=BigInt(data.fees[1]);
 const spend=ceil(target*(1000000000n+BigInt(repayFee)),1000000000n);
 const firstPlans=[],failures=[];
 for(const first of data.candidates.first){
  try{
   const flash=await smallest(x=>quote(p,x,first.routes),ceil(spend*10000n,9990n),ceil(spend,1000000000000n)+1000000n,BigInt(data.balancerUsdc));
   const q=await quote(p,flash,first.routes),firstMinimum=q*9990n/10000n;
   assert(firstMinimum>=spend,'First swap does not cover repayment fee');
   firstPlans.push({first,flash,q,firstMinimum,spend});
  }catch(e){failures.push({first:first.name,error:safeError(e)});}
 }
 assert(firstPlans.length,'No feasible USDC/fxUSD quote');
 const out=[];
 for(const f of firstPlans)for(const sale of data.candidates.sale){
  try{
   const fee=ceil(f.flash*BigInt(data.flashFeePercentage),1000000000000000000n),due=f.flash+fee;
   const net=x=>x-x*withdrawFee/1000000000n;
   const sample=10000000000000000n,unit=await quote(p,net(sample),sale.routes);
   assert(unit>0n,'No output liquidity');
   const desired=ceil(due*10000n,9975n);
   const guess=ceil(desired*sample,unit)*101n/100n+1n;
   // 1e9 wei wstETH precision is below one microcent at current prices.
   const amount=await smallest(x=>quote(p,net(x),sale.routes),desired,guess,BigInt(position.rawCollateral)*1000000000000000000n/BigInt(data.collateralScalingFactor),1000000000n);
   const q=await quote(p,net(amount),sale.routes),secondMinimum=q*9975n/10000n;
   assert(secondMinimum>=due,'Sale floor fails flash repayment');
   const header=await p.send('eth_getBlockByNumber',['latest',false]);
   out.push({name:f.first.name+' / '+sale.name,firstName:f.first.name,saleName:sale.name,firstQuote:f.q,saleQuote:q,fee,spend:f.spend,
    plan:{positionId:position.id,debtRepayment:target,flashUsdc:f.flash,withdrawCollateral:amount,firstMinimum:f.firstMinimum,secondMinimum,deadline:Number(BigInt(header.timestamp))+1800,firstRoutes:f.first.routes,collateralRoutes:sale.routes}});
  }catch(e){failures.push({first:f.first.name,sale:sale.name,error:safeError(e)});}
 }
 save('QUOTES_v5.json',{target,plans:out,failures});assert(out.length,'No feasible collateral sale');return {plans:out,failures};
}
async function verify(p,helper,plan,receipt,before,vaultBefore,ownerBefore){
 const address=await helper.getAddress(),nft=new ethers.Contract(C.pool,nftAbi,p);
 const after=Array.from(await nft.getPosition(plan.positionId));
 const delta=before[1]-after[1];
 assert(delta>0n&&(delta>plan.debtRepayment?delta-plan.debtRepayment:plan.debtRepayment-delta)<=1000000000000n,'Exact requested debt repayment mismatch');
 assert(after[0]<before[0],'No collateral withdrawal');
 const events=receipt.logs.filter(l=>l.address.toLowerCase()===address.toLowerCase()).map(l=>helper.interface.parseLog(l)).filter(Boolean).map(e=>({name:e.name,args:Array.from(e.args)}));
 const swaps=events.filter(x=>x.name==='Swap'),flash=events.find(x=>x.name==='FlashLoanRepaid');
 assert(swaps.length===2&&flash,'Incomplete flash repayment events');
 assert(swaps[0].args[2]===plan.flashUsdc&&swaps[0].args[3]>=plan.firstMinimum&&swaps[1].args[3]>=plan.secondMinimum,'Swap bound mismatch');
 const vaultAfter=await balance(p,C.usdc,C.balancer);assert(vaultAfter-vaultBefore===flash.args[1],'Balancer principal/fee not repaid');
 assert((await nft.ownerOf(plan.positionId)).toLowerCase()===C.owner,'Owner NFT not returned');
 for(const t of [C.usdc,C.fxusd,C.collateral])assert(await balance(p,t,address)===0n,'Helper retained tokens');
 const ownerAfter={usdc:await balance(p,C.usdc,C.owner),fxusd:await balance(p,C.fxusd,C.owner)};
 const refund={usdc:ownerAfter.usdc-ownerBefore.usdc,fxusd:ownerAfter.fxusd-ownerBefore.fxusd};
 assert(refund.usdc>=0n&&refund.fxusd>=0n,'Repayment used existing owner tokens');
 return {status:'PASS',helper:address,plan,before,after,debtDecrease:delta,collateralDecrease:before[0]-after[0],flashFee:flash.args[1],events,refund,gasUsed:receipt.gasUsed,hash:receipt.hash,block:receipt.blockNumber,gasPrice:receipt.gasPrice};
}
async function executeFork(p,helper,plan){
 const nft=new ethers.Contract(C.pool,nftAbi,p),before=Array.from(await nft.getPosition(plan.positionId));
 const vaultBefore=await balance(p,C.usdc,C.balancer);
 const ownerBefore={usdc:await balance(p,C.usdc,C.owner),fxusd:await balance(p,C.fxusd,C.owner)};
 const gas=await helper.execute.estimateGas(plan);
 const receipt=await mine(p,{from:C.owner,to:await helper.getAddress(),data:helper.interface.encodeFunctionData('execute',[plan]),gas:ethers.toQuantity(gas*130n/100n)},'atomic repayment');
 return verify(p,helper,plan,receipt,before,vaultBefore,ownerBefore);
}

let anvil;const providers=[];
try{
 assert(TARGET>0n,'Repayment must be positive');assert(MAX_BASE_FEE>0n&&TOTAL_FEE_CAP>=PRIORITY,'Invalid gas fee settings');
 const remote=new ethers.JsonRpcProvider(process.env.ETH_RPC_URL,1,{staticNetwork:true,batchMaxCount:1,cacheTimeout:0});providers.push(remote);
 if(!process.env.FXMINT_OWNER_ADDRESS){
  const trackedPosition=process.env.FXMINT_POSITION_ID||'1920';
  C.owner=(await read(remote,C.pool,'ownerOf(uint256) view returns(address)',[trackedPosition])).toLowerCase();
 }
 const data=await collect(remote,PROVEN_ROUTE_ONLY);
 if(process.env.FXMINT_MODE==='collect-only'){save('COLLECTION_v5.json',{status:'PASS',positions:data.positions,target:TARGET});}
 else{const position=await choosePosition(data);
 const artifact=compile();mkdirSync('fxmint-output',{recursive:true});
 anvil=spawn('anvil',['--fork-url',process.env.ETH_RPC_URL,'--fork-block-number',String(data.block),'--port','8545','--host','127.0.0.1','--chain-id','1','--silent'],{stdio:['ignore','pipe','pipe']});
 let anvilLog='';for(const stream of [anvil.stdout,anvil.stderr])stream.on('data',x=>{anvilLog+=safeError({message:x.toString()});});
 const request=new ethers.FetchRequest('http://127.0.0.1:8545');request.timeout=20000;
 const p=new ethers.JsonRpcProvider(request,1,{staticNetwork:true,batchMaxCount:1,cacheTimeout:0});providers.push(p);
 let ready=false;for(let i=0;i<90;i++){try{assert(await p.send('eth_chainId',[])==='0x1','Wrong fork chain');ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
 assert(ready,'Anvil startup failed '+anvilLog);
 const header=await p.send('eth_getBlockByNumber',[ethers.toQuantity(data.block),false]);assert(header.hash===data.blockHash,'Wrong pinned fork block');
 const baseFee=validateBaseFee(BigInt(header.baseFeePerGas),'Pinned fork');
 const rankingGasPrice=baseFee+PRIORITY;
 await p.send('anvil_impersonateAccount',[C.owner]);const ownerEth=BigInt(await p.send('eth_getBalance',[C.owner,'latest']));
 if(ownerEth<ethers.parseEther('1'))await p.send('anvil_setBalance',[C.owner,ethers.toQuantity(ethers.parseEther('1'))]);
 save('FORK_v5.json',{block:data.block,blockHash:data.blockHash,baseFee,rankingGasPrice,maxBaseFee:MAX_BASE_FEE,totalFeeCap:TOTAL_FEE_CAP,maxFee:MAX_FEE,priority:PRIORITY,gasBalanceOverride:ownerEth<ethers.parseEther('1'),noTokenOrProtocolStorageOverrides:true});
 const signer=await p.getSigner(C.owner),outsider=await p.getSigner(0);
 let helper,deploymentReceipt=null;
 if(process.env.FXMINT_HELPER_ADDRESS){
  helper=new ethers.Contract(process.env.FXMINT_HELPER_ADDRESS,artifact.abi,signer);
  assert((await helper.owner()).toLowerCase()===C.owner,'Existing helper owner mismatch');
  // Exact compiled runtime verification is performed against an ephemeral reference deployment.
  const ref=await new ethers.ContractFactory(artifact.abi,artifact.bytecode.object,signer).deploy(C.owner,feeOverrides);
  await ref.waitForDeployment();assert(ethers.keccak256(await p.getCode(await helper.getAddress()))===ethers.keccak256(await p.getCode(await ref.getAddress())),'Existing helper runtime mismatch');
 }else{
  const factory=new ethers.ContractFactory(artifact.abi,artifact.bytecode.object,signer),tx=await factory.getDeployTransaction(C.owner);
  deploymentReceipt=await mine(p,{from:C.owner,data:tx.data,gas:'0x989680'},'helper deployment');
  helper=new ethers.Contract(deploymentReceipt.contractAddress,artifact.abi,signer);
 }
 const nft=new ethers.Contract(C.pool,nftAbi,signer),helperAddress=await helper.getAddress();
 let approvalReceipt=null;
 if((await nft.getApproved(position.id)).toLowerCase()!==helperAddress.toLowerCase())approvalReceipt=await mine(p,{from:C.owner,to:C.pool,data:nft.interface.encodeFunctionData('approve',[helperAddress,position.id]),gas:'0x7a120'},'position approval');
 const candidates=await plans(p,data,position,TARGET);
 let best;
 if(PROVEN_ROUTE_ONLY){
  assert(candidates.plans.length===1,'Proven route must produce exactly one feasible plan');
  best=candidates.plans[0];
  save('ROUTE_SELECTION_v6.json',{version:6,target:TARGET,block:data.block,selected:best.name,scope:'Previously verified gas-inclusive winner only; no route comparison or fallback',evidenceRuns:[38017714742,38018612642]});
  console.log('Proven route only: '+best.name);
 }else{
 // Use one common reference mark for assets and one common gas price for every candidate.
 const marks=[];
 for(const route of data.candidates.wethSale){try{marks.push({name:route.name,quote:await quote(p,10000000000000000n,route.routes)});}catch{}}
 assert(marks.length,'No ETH/USDC gas valuation quote');marks.sort((a,b)=>a.quote>b.quote?-1:1);
 const ethUsdcPerEth=marks[0].quote*100n;
 const wstMarks=[];
 for(const route of data.candidates.sale){try{const q=await quote(p,10000000000000000n,route.routes);if(q>0n)wstMarks.push({name:route.name,quote:q});}catch{}}
 assert(wstMarks.length,'No market wstETH/USDC reference');wstMarks.sort((a,b)=>a.quote>b.quote?-1:1);
 const wstUsdcPerToken=wstMarks[0].quote*100n;
 const collateralScalingFactor=BigInt(data.collateralScalingFactor);
 const fxUsdcPerToken=await quote(p,1000000000000000000n,R.fxUsdc);
 const results=[],failures=[...candidates.failures];
 for(const c of candidates.plans){
  const snap=await p.send('evm_snapshot',[]);
  try{
   const result=await executeFork(p,helper,c.plan);
   const grossCollateralTokens=ceil(result.collateralDecrease*1000000000000000000n,collateralScalingFactor);
   const grossValueUsdc18=grossCollateralTokens*wstUsdcPerToken/1000000n;
   const refundsUsdc18=result.refund.usdc*1000000000000n+result.refund.fxusd*fxUsdcPerToken/1000000n;
   const gasCostUsdc18=result.gasUsed*rankingGasPrice*ethUsdcPerEth/1000000n;
   const score=grossValueUsdc18-refundsUsdc18+gasCostUsdc18;
   results.push({...c,...result,grossCollateralTokens,grossValueUsdc18,refundsUsdc18,gasCostUsdc18,totalCostUsdc18:score});
   console.log(json({route:c.name,status:'PASS',gas:result.gasUsed,collateral:result.collateralDecrease,totalCostUsdc:ethers.formatUnits(score,18)}));
  }catch(e){failures.push({route:c.name,error:safeError(e),data:e.data||e.info?.error?.data});console.log('Route failed: '+c.name+' '+safeError(e));}
  finally{assert(await p.send('evm_revert',[snap]),'Failed route snapshot rollback');}
 }
 assert(results.length,'No route completed full atomic repayment');
 results.sort((a,b)=>a.totalCostUsdc18<b.totalCostUsdc18?-1:a.totalCostUsdc18>b.totalCostUsdc18?1:a.gasUsed<b.gasUsed?-1:1);
 best=results[0];
 save('ROUTE_COMPARISON_v5.json',{status:'PASS',target:TARGET,block:data.block,rankingGasPrice,ethUsdcPerEth,wstUsdcPerToken,fxUsdcPerToken,collateralScalingFactor,marks,wstMarks,results,failures,selected:best.name,scope:'Available Uniswap v3 fee tiers 100/500/3000/10000, official Curve/Lido routes, Curve factory stETH pool, Tricrypto, Balancer V2 and SDK round-trip reference; no global-optimum claim for all aggregators'});
 }
 await negative('owner only',()=>helper.connect(outsider).execute.staticCall(best.plan),'Unauthorized()');
 await negative('authenticated callback',()=>helper.connect(outsider).receiveFlashLoan.staticCall([C.usdc],[best.plan.flashUsdc],[0],'0x'),'CallbackOnly()');
 await negative('zero repayment',()=>helper.execute.staticCall({...best.plan,debtRepayment:0}),'InvalidPlan()');
 await negative('over repayment',()=>helper.execute.staticCall({...best.plan,debtRepayment:BigInt(position.rawDebt)+1n}),'InvalidPlan()');
 await negative('expired plan',()=>helper.execute.staticCall({...best.plan,deadline:1}),'InvalidPlan()');
 const unchanged=Array.from(await nft.getPosition(position.id));
 await negative('impossible minimum',()=>helper.execute.staticCall({...best.plan,secondMinimum:2n**200n}),'InsufficientOutput()');
 assert(json(Array.from(await nft.getPosition(position.id)))===json(unchanged),'Reverted operation changed debt/collateral');
 assert((await nft.ownerOf(position.id)).toLowerCase()===C.owner,'Reverted operation changed NFT owner');
 // Prove variable amounts work on the SAME deployed helper before the main acceptance.
 const alternate=TARGET/2n;
 if(!PROVEN_ROUTE_ONLY&&alternate>0n){
  const snap=await p.send('evm_snapshot',[]);
  try{const one={...data,candidates:{...data.candidates,first:data.candidates.first.filter(x=>x.name===best.firstName),sale:data.candidates.sale.filter(x=>x.name===best.saleName)}};
   const alternatePlans=await plans(p,one,position,alternate);
   const check=await executeFork(p,helper,alternatePlans.plans[0].plan);save('CONFIGURABLE_AMOUNT_CHECK_v5.json',check);console.log('PASS configurable amount on same helper: '+ethers.formatUnits(alternate,18));
  }finally{assert(await p.send('evm_revert',[snap]),'Alternate test rollback failed');}
 }
 const final=await executeFork(p,helper,best.plan);
 const commonGas=(deploymentReceipt?.gasUsed||0n)+(approvalReceipt?.gasUsed||0n);
 const totalGas=final.gasUsed+commonGas,totalCost=final.gasUsed*final.gasPrice+(deploymentReceipt?deploymentReceipt.gasUsed*deploymentReceipt.gasPrice:0n)+(approvalReceipt?approvalReceipt.gasUsed*approvalReceipt.gasPrice:0n);
 const runtimeHash=ethers.keccak256(await p.getCode(helperAddress));
 if(process.env.FXMINT_HELPER_ADDRESS)save('LIVE_HELPER_v7.json',await waitForLiveHelper(remote,helper,runtimeHash));
 const report={version:5,status:'PASS',mode:'simulate-only',owner:C.owner,target:TARGET,positionId:position.id,route:best.name,firstRoute:best.firstName,saleRoute:best.saleName,forkBlock:data.block,forkHash:data.blockHash,runtimeHash,maxBaseFee:MAX_BASE_FEE,totalFeeCap:TOTAL_FEE_CAP,maxFee:MAX_FEE,priority:PRIORITY,repaymentGas:final.gasUsed,deploymentGas:deploymentReceipt?.gasUsed||0n,approvalGas:approvalReceipt?.gasUsed||0n,totalGas,totalEthCost:ethers.formatEther(totalCost),maxEthCost:ethers.formatEther(totalGas*MAX_FEE),result:final};
 save('SIMULATION_v5.json',report);console.log(json(report));
 p.destroy();anvil.kill('SIGTERM');anvil=undefined;
 if(process.env.FXMINT_MODE==='live-broadcast'){
  assert(process.env.FXMINT_CONFIRMATION==='LIVE '+ethers.formatUnits(TARGET,18).replace(/\.0$/,'')+' FXUSD','Live amount confirmation mismatch');
  assert(process.env.FXMINT_PRIVATE_KEY,'Protected production signing secret missing');
  const wallet=new ethers.Wallet(process.env.FXMINT_PRIVATE_KEY,remote);assert(wallet.address.toLowerCase()===C.owner,'Signing secret is not the position owner');
  await checkCurrentBaseFee(remote,'Live preflight');
  const liveData=await collect(remote,true),livePosition=liveData.positions.find(x=>x.id===position.id);
  assert(livePosition&&String(livePosition.rawDebt)===String(position.rawDebt)&&String(livePosition.rawCollateral)===String(position.rawCollateral),'Position changed after accepted simulation');
  const refreshed=await plans(remote,{...liveData,candidates:{...liveData.candidates,first:liveData.candidates.first.filter(x=>x.name===best.firstName),sale:liveData.candidates.sale.filter(x=>x.name===best.saleName)}},livePosition,TARGET);
  assert(refreshed.plans.length===1,'Selected live route unavailable');const livePlan=refreshed.plans[0].plan;
  assert(livePlan.withdrawCollateral<=best.plan.withdrawCollateral,'Live route needs more collateral than the accepted simulation');
  const factory=new ethers.ContractFactory(artifact.abi,artifact.bytecode.object,wallet);
  let liveHelper,minHelperBlock=0;
  if(process.env.FXMINT_HELPER_ADDRESS)liveHelper=new ethers.Contract(process.env.FXMINT_HELPER_ADDRESS,artifact.abi,wallet);
  else{
   await checkCurrentBaseFee(remote,'Helper deployment');
   liveHelper=await factory.deploy(C.owner,feeOverrides);save('DEPLOYMENT_PENDING_v5.json',{hash:liveHelper.deploymentTransaction().hash,helper:await liveHelper.getAddress()});
   const receipt=await liveHelper.deploymentTransaction().wait(1,600000);
   assert(receipt.status===1,'Live helper deployment failed');
   assert(receipt.contractAddress?.toLowerCase()===(await liveHelper.getAddress()).toLowerCase(),'Deployment receipt helper address mismatch');
   minHelperBlock=receipt.blockNumber;
   save('DEPLOYMENT_v5.json',{hash:receipt.hash,helper:receipt.contractAddress,block:receipt.blockNumber,status:receipt.status,gasUsed:receipt.gasUsed,gasPrice:receipt.gasPrice});
  }
  const readiness=await waitForLiveHelper(remote,liveHelper,runtimeHash,minHelperBlock);
  save('LIVE_HELPER_v7.json',readiness);
  const liveAddress=readiness.address;
  const liveNft=new ethers.Contract(C.pool,nftAbi,wallet);
  if((await liveNft.getApproved(position.id)).toLowerCase()!==liveAddress.toLowerCase()){
   await checkCurrentBaseFee(remote,'NFT approval');
   const tx=await liveNft.approve(liveAddress,position.id,feeOverrides);save('APPROVAL_PENDING_v5.json',{hash:tx.hash});await tx.wait(1,600000);
  }
  const before=Array.from(await liveNft.getPosition(position.id)),vaultBefore=await balance(remote,C.usdc,C.balancer);
  assert(json(before)===json([BigInt(livePosition.rawCollateral),BigInt(livePosition.rawDebt)]),'Position changed before broadcast');
  const ownerBefore={usdc:await balance(remote,C.usdc,C.owner),fxusd:await balance(remote,C.fxusd,C.owner)};
  const gas=await liveHelper.execute.estimateGas(livePlan);
  await checkCurrentBaseFee(remote,'Atomic repayment');
  const tx=await liveHelper.execute(livePlan,{...feeOverrides,gasLimit:gas*130n/100n});
  save('REPAYMENT_PENDING_v5.json',{hash:tx.hash,helper:liveAddress,plan:livePlan});
  const receipt=await tx.wait(1,600000);assert(receipt.status===1,'Live transaction failed');
  const result=await verify(remote,liveHelper,livePlan,receipt,before,vaultBefore,ownerBefore);
  save('BROADCAST_v5.json',{version:5,mode:'live-broadcast',...result});console.log(json({mode:'live-broadcast',...result}));
 }
 }
}catch(e){save('ERROR_v5.json',{status:'FAIL',error:safeError(e),data:e.data||e.info?.error?.data});console.error(safeError(e));process.exitCode=1;}
finally{for(const p of providers)p.destroy();if(anvil)anvil.kill('SIGTERM');}

