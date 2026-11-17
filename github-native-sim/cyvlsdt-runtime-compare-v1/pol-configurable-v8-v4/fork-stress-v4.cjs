'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const hre=require('hardhat');
const {ethers,network}=hre;
const OUTPUT=path.join(__dirname,'outputs-v4');
const ART=(name)=>JSON.parse(fs.readFileSync(path.join(OUTPUT,name),'utf8'));
const managerArtifact=ART('PoLManager-v22-Artifact-v4.json');
const guardArtifact=ART('CurvePairOracleBounds-v8-Artifact-v4.json');
const mocks=ART('Stress-Simulation-Mock-Artifacts-v4.json');
const W=10n**18n, U=10n**6n;
const ALIVE_OLD_POL='0x54a71cA4F139e674fAd3B9F18cFc013d6175D677';
const ALIVE_OLD_GUARD='0x840fa8496e3B5Ac306281d5Bb5224fA08b5865F8';
const reports=[];
let assertions=0;
function check(cond,label){assert(cond,label);assertions++}
function eq(a,b,label){assert.equal(String(a),String(b),label);assertions++}
async function deploy(artifact,...args){
 const [owner]=await ethers.getSigners();
 const c=await new ethers.ContractFactory(artifact.abi,artifact.bytecode,owner).deploy(...args);
 await c.waitForDeployment();return c;
}
async function fixture(){
 const [owner,attacker]=await ethers.getSigners();
 const sdt=await deploy(mocks.StressERC20V2,'Mock SDT','SDT',18);
 const cyvl=await deploy(mocks.StressERC20V2,'Mock cyvlSDT','cyvlSDT',18);
 const usdc=await deploy(mocks.StressERC20V2,'Mock USDC','USDC',6);
 const crv=await deploy(mocks.StressERC20V2,'Mock CRV','CRV',18);
 const lp=await deploy(mocks.StressERC20V2,'Mock LP','LP',18);
 const router=await deploy(mocks.StressHistoricalRouterV2);
 const pool=await deploy(mocks.StressThreeCoinNGV2,sdt.target,cyvl.target,usdc.target,lp.target);
 const guard=await deploy(guardArtifact);
 const pol=await deploy(managerArtifact,{
  owner:owner.address,yearnVaults:[ethers.ZeroAddress,ethers.ZeroAddress,ethers.ZeroAddress],
  sdtYearnIndex:0,eulerVaults:[ethers.ZeroAddress,ethers.ZeroAddress],sdtEulerIndex:0,
  crv:crv.target,cyvlSDT:cyvl.target,sdt:sdt.target,usdc:usdc.target,omniRouter:router.target
 });
 await pol.setLiquidityBounds(guard.target);
 await pol.setCurveSlippageBps(75);
 await pol.configureCurvePool(pool.target,lp.target);
 await sdt.mint(pol.target,1000000n*W);
 await usdc.mint(pol.target,1000000n*U);
 await cyvl.mint(pol.target,1000000n*W);
 const oracle=await deploy(mocks.StressUniOraclePoolV2);
 const factory=await deploy(mocks.StressUniFactoryV2,oracle.target);
 const tokens=[sdt.target,cyvl.target].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
 const nft=await deploy(mocks.StressUniNFTV2,tokens[0],tokens[1],factory.target,owner.address);
 await pol.configureUniswapPosition(nft.target,7);
 await nft.safeTransferFrom(owner.address,pol.target,7);
 const token0=tokens[0].toLowerCase()===sdt.target.toLowerCase()?sdt:cyvl;
 const token1=tokens[1].toLowerCase()===sdt.target.toLowerCase()?sdt:cyvl;
 return {owner,attacker,sdt,cyvl,usdc,crv,lp,router,pool,guard,pol,oracle,factory,nft,token0,token1};
}
async function snap(){return network.provider.send('evm_snapshot')}
async function restore(s){const ok=await network.provider.send('evm_revert',[s]);check(ok,'snapshot restored')}
async function revertTx(p,label){
 let threw=false;
 try{const tx=await p;if(tx?.wait)await tx.wait()}catch(e){threw=true}
 check(threw,'Expected transaction revert: '+label);
}
async function sameBlockSpotMove(spotter,submit,expectedSuccess,label){
 let tx0,tx1,rc0,rc1;
 await network.provider.send('evm_setAutomine',[false]);
 try{
  tx0=await spotter({gasLimit:120000});
  tx1=await submit({gasLimit:5500000});
  await network.provider.send('evm_mine',[]);
  rc0=await ethers.provider.getTransactionReceipt(tx0.hash);
  rc1=await ethers.provider.getTransactionReceipt(tx1.hash);
 }finally{
  await network.provider.send('evm_setAutomine',[true]);
 }
 check(rc0!=null && rc1!=null,label+' receipts present');
 eq(rc0.blockNumber,rc1.blockNumber,label+' same block number');
 eq(rc0.status,1,label+' adverse price move mined');
 eq(rc1.status,expectedSuccess?1:0,label+' expected execution status');
 return {blockNumber:rc1.blockNumber,status:rc1.status,gasUsed:String(rc1.gasUsed)};
}
async function curveDepositTrial(f,bps){
 const checkpoint=await snap();
 const input=1000n*W;
 const quote=await f.guard.quoteDeposit(f.pool.target,0,input,75);
 const output=input*BigInt(bps)/10000n;
 const expectedLoss=(Number(quote[0]-output)/Number(quote[0]))*100;
 const pass=output>=quote[1];
 eq(quote[1],quote[0]*9925n/10000n,'Curve deposit minMint exactly 75bps below guard estimate');
 const beforeSdt=await f.sdt.balanceOf(f.pol.target);
 const beforeLP=await f.lp.balanceOf(f.pol.target);
 const r=await sameBlockSpotMove(
  opts=>f.pool.setSpotBps(bps,opts),
  opts=>f.pol.depositCurve(input,opts),pass,'Curve deposit '+bps);
 const afterSdt=await f.sdt.balanceOf(f.pol.target),afterLP=await f.lp.balanceOf(f.pol.target);
 if(!pass){eq(afterSdt,beforeSdt,'failed Curve deposit SDT unchanged');eq(afterLP,beforeLP,'failed Curve deposit LP unchanged')}
 else check(afterLP>beforeLP,'successful Curve deposit mints LP');
 reports.push({component:'Curve deposit',spotRateBps:bps,lossPercent:expectedLoss,pass,block:r.blockNumber,gas:r.gasUsed});
 await restore(checkpoint);
}
async function curveWithdrawTrial(f,bps){
 const checkpoint=await snap();
 await f.pol.depositCurve(2000n*W);
 const lp=1000n*W;
 const quote=await f.guard.quoteWithdraw(f.pool.target,0,lp,75);
 const actual=lp*BigInt(bps)/10000n;
 const loss=(Number(quote[0]-actual)/Number(quote[0]))*100;
 const pass=actual>=quote[1];
 eq(quote[1],quote[0]*9925n/10000n,'Curve withdrawal minReceived exactly 75bps below guard estimate');
 const beforeLP=await f.lp.balanceOf(f.pol.target),beforeSDT=await f.sdt.balanceOf(f.pol.target);
 const r=await sameBlockSpotMove(
  opts=>f.pool.setSpotBps(bps,opts),
  opts=>f.pol.withdrawCurve(lp,false,opts),pass,'Curve withdraw '+bps);
 if(!pass){eq(await f.lp.balanceOf(f.pol.target),beforeLP,'failed Curve redeem LP unchanged');eq(await f.sdt.balanceOf(f.pol.target),beforeSDT,'failed Curve redeem SDT unchanged')}
 else check((await f.sdt.balanceOf(f.pol.target))>beforeSDT,'successful Curve withdrawal pays SDT');
 reports.push({component:'Curve withdrawal',spotRateBps:bps,lossPercent:loss,pass,block:r.blockNumber,gas:r.gasUsed});
 await restore(checkpoint);
}
async function uniAddTrial(f,bps,pass){
 const checkpoint=await snap();
 const amount0=1000n*W,amount1=1000n*W;
 const q=await f.guard.quoteUniV3Deposit(f.nft.target,7,amount0,amount1,75);
 check(q[0]>0n&&q[1]>0n,'Uniswap guard liquidity quote valid');
 eq(q[4],q[2]*9925n/10000n,'guard 75bps minAmount0Used');
 eq(q[5],q[3]*9925n/10000n,'guard 75bps minAmount1Used');
 await f.nft.setDepositReference(q[0],q[2],q[3]);
 const before0=await f.token0.balanceOf(f.pol.target),before1=await f.token1.balanceOf(f.pol.target);
 const beforeLiquidity=(await f.nft.positions(7)).liquidity;
 const r=await sameBlockSpotMove(
  opts=>f.nft.setSpotBps(bps,opts),
  opts=>f.pol.addUniLiquidity(amount0,amount1,opts),pass,'NFT add '+bps);
 if(!pass){
  eq(await f.token0.balanceOf(f.pol.target),before0,'reverted NFT add token0 safe');
  eq(await f.token1.balanceOf(f.pol.target),before1,'reverted NFT add token1 safe');
  eq((await f.nft.positions(7)).liquidity,beforeLiquidity,'reverted NFT add liquidity unchanged');
 }else{
  eq(await f.nft.lastDepositDesired0(),amount0,'same amount0Desired provided to guard and NFT');
  eq(await f.nft.lastDepositDesired1(),amount1,'same amount1Desired provided to guard and NFT');
  eq(await f.nft.lastDepositMin0(),q[4],'actual NFT call amount0Min forwarded from guard');
  eq(await f.nft.lastDepositMin1(),q[5],'actual NFT call amount1Min forwarded from guard');
  check((await f.nft.positions(7)).liquidity>beforeLiquidity,'NFT new liquidity minted');
 }
 reports.push({component:'Uniswap NFT deposit',spotRateBps:bps,pass,block:r.blockNumber,gas:r.gasUsed,
  estimateLiquidity:String(q[0]),minLiquidity:String(q[1])});
 await restore(checkpoint);
}
async function uniRemoveTrial(f,bps,pass){
 const checkpoint=await snap();
 const q=await f.guard.quoteUniV3Withdraw(f.nft.target,7,2500,75);
 check(q[0]>0n&&q[1]>0n&&q[2]>0n,'Uniswap withdraw quote');
 eq(q[3],q[1]*9925n/10000n,'Uniswap withdraw token0 min 75 bps');
 eq(q[4],q[2]*9925n/10000n,'Uniswap withdraw token1 min 75 bps');
 await f.nft.setWithdrawalReference(q[1],q[2]);
 const liquidity=(await f.nft.positions(7)).liquidity;
 const before0=await f.token0.balanceOf(f.pol.target),before1=await f.token1.balanceOf(f.pol.target);
 const r=await sameBlockSpotMove(
  opts=>f.nft.setSpotBps(bps,opts),
  opts=>f.pol.removeUniLiquidity(2500,opts),pass,'NFT remove '+bps);
 if(!pass){
  eq((await f.nft.positions(7)).liquidity,liquidity,'failed NFT redeem liquidity unchanged');
  eq(await f.token0.balanceOf(f.pol.target),before0,'failed NFT redeem token0 unchanged');
  eq(await f.token1.balanceOf(f.pol.target),before1,'failed NFT redeem token1 unchanged');
 }else{
  eq(await f.nft.lastWithdrawalMin0(),q[3],'guard minAmount0 forwarded');
  eq(await f.nft.lastWithdrawalMin1(),q[4],'guard minAmount1 forwarded');
  check((await f.nft.positions(7)).liquidity<liquidity,'NFT redeemed liquidity');
 }
 reports.push({component:'Uniswap NFT withdrawal',spotRateBps:bps,pass,block:r.blockNumber,gas:r.gasUsed});
 await restore(checkpoint);
}
async function rebalanceTrial(f,bps,pass,lying=false){
 const checkpoint=await snap();
 const [a,b]=[f.token0,f.token1];const amount=1000n*W;
 await f.router.setSpotBps(a.target,b.target,bps);
 if(lying)await f.router.setReportedBps(a.target,b.target,10000);
 const beforeA=await a.balanceOf(f.pol.target),beforeB=await b.balanceOf(f.pol.target);
 if(pass){
  await f.pol.rebalanceUniTokens(a.target,amount);
  eq(await f.router.lastUserMin(),amount*9925n/10000n,'actual router call received 75 bps minNet');
  eq(await f.router.lastRecipient(),f.pol.target,'actual router recipient is PoL Manager');
  eq(beforeA-(await a.balanceOf(f.pol.target)),amount,'NFT balancing input conserved');
  eq((await b.balanceOf(f.pol.target))-beforeB,amount*BigInt(bps)/10000n,'NFT balancing output recorded');
 }else{
  await revertTx(f.pol.rebalanceUniTokens(a.target,amount),'NFT balancing 75 bps bps='+bps);
  eq(await a.balanceOf(f.pol.target),beforeA,'NFT rebalance failed input rolled back');
  eq(await b.balanceOf(f.pol.target),beforeB,'NFT rebalance failed output rolled back');
 }
 reports.push({component:lying?'Uniswap NFT swap dishonest router':'Uniswap NFT balancing swap',spotRateBps:bps,pass,lying});
 await restore(checkpoint);
}
async function sdtUsdcTrial(f,forward,bps,pass){
 const checkpoint=await snap();
 const input=forward?1000n*W:1000n*U;
 const a=forward?f.sdt:f.usdc,b=forward?f.usdc:f.sdt;
 await f.router.setSpotBps(a.target,b.target,bps);
 if(forward){
  const usdcVault=await deploy(mocks.Stress4626BasicV2,f.usdc.target);
  await f.pol.setVault(0,usdcVault.target);
  await f.pol.setAllocations([0,0,10000,0,0,0,0]);
 }else{
  await f.pol.setAllocations([10000,0,0,0,0,0,0]);
 }
 const balanceBefore=await a.balanceOf(f.pol.target);
 if(pass){
  await f.pol.allocateFunds(a.target,input);
  const quoted=input*(forward?U:W)/(forward?W:U);
  eq(await f.router.lastUserMin(),quoted*9800n/10000n,'SDT/USDC must preserve 200-bps minimum');
  check((await a.balanceOf(f.pol.target))<balanceBefore,'successful SDT/USDC spends source');
 }else{
  await revertTx(f.pol.allocateFunds(a.target,input),'SDT/USDC over 2%');
  eq(await a.balanceOf(f.pol.target),balanceBefore,'failed SDT/USDC rolled back');
 }
 reports.push({component:forward?'SDT to USDC':'USDC to SDT',spotRateBps:bps,pass});
 await restore(checkpoint);
}
// Create the transaction first, leave it pending, then advance the EXECUTION
// block by multiple days. A deadline captured when the user constructed or
// submitted the transaction would be stale and the mock would revert.
async function queuedWithDelayedExecution(label,submit,readObserved,delayDays){
 const snapshot=await snap();
 const before=await ethers.provider.getBlock('latest');
 let tx,receipt;
 const futureTimestamp=before.timestamp+delayDays*86400;
 await network.provider.send('evm_setAutomine',[false]);
 try{
  tx=await submit({gasLimit:5500000});
  check((await ethers.provider.getTransactionReceipt(tx.hash))===null,
    label+' genuinely pending before future block');
  await network.provider.send('evm_setNextBlockTimestamp',[futureTimestamp]);
  await network.provider.send('evm_mine',[]);
  receipt=await ethers.provider.getTransactionReceipt(tx.hash);
 }finally{
  await network.provider.send('evm_setAutomine',[true]);
 }
 check(receipt!==null,label+' mined receipt exists');
 eq(receipt.status,1,label+' execution succeeds despite delayed inclusion');
 const executionBlock=await ethers.provider.getBlock(receipt.blockNumber);
 eq(executionBlock.timestamp,futureTimestamp,label+' execution timestamp advanced by days');
 check(executionBlock.timestamp>before.timestamp+86400,label+' delay would invalidate any old deadline');
 const [deadline,insideTimestamp]=await readObserved();
 eq(deadline,BigInt(executionBlock.timestamp),label+' callee deadline derives from execution block');
 eq(insideTimestamp,BigInt(executionBlock.timestamp),label+' callee timestamp is same executing block');
 reports.push({component:label,delayDays,submissionBlock:before.number,executionBlock:receipt.blockNumber,
  submissionTimestamp:before.timestamp,executionTimestamp:executionBlock.timestamp,
  observedDeadline:String(deadline),pass:true});
 await restore(snapshot);
}
async function deadlineQueuedProof(f){
 const a0=1000n*W,a1=1000n*W;
 const addQuote=await f.guard.quoteUniV3Deposit(f.nft.target,7,a0,a1,75);
 await f.nft.setDepositReference(addQuote[0],addQuote[2],addQuote[3]);
 await queuedWithDelayedExecution('Pending Uniswap NFT deposit', 
   opts=>f.pol.addUniLiquidity(a0,a1,opts),
   async()=>[await f.nft.lastDepositDeadline(),await f.nft.lastDepositExecutionTimestamp()],2);
 const removeQuote=await f.guard.quoteUniV3Withdraw(f.nft.target,7,2500,75);
 await f.nft.setWithdrawalReference(removeQuote[1],removeQuote[2]);
 await queuedWithDelayedExecution('Pending Uniswap NFT withdrawal',
   opts=>f.pol.removeUniLiquidity(2500,opts),
   async()=>[await f.nft.lastWithdrawalDeadline(),await f.nft.lastWithdrawalExecutionTimestamp()],3);
 await queuedWithDelayedExecution('Pending NFT inventory balancing swap',
   opts=>f.pol.rebalanceUniTokens(f.token0.target,1000n*W,opts),
   async()=>[await f.router.lastSwapDeadline(),await f.router.lastSwapExecutionTimestamp()],5);
 // Harvest must actually convert earned non-SDT rewards using swapExactInput;
 // simply harvesting an empty position would not cover any deadline-bearing call.
 await f.pol.setProfitFee(1000);
 await f.pol.setModuleEnabled(1,false,true);
 const cyvlIs0=f.token0.target.toLowerCase()===f.cyvl.target.toLowerCase();
 await f.nft.setFeeOwed(cyvlIs0?100n*W:0n,cyvlIs0?0n:100n*W);
 await queuedWithDelayedExecution('Pending nonzero-fee Uniswap NFT harvest',
   opts=>f.pol.harvest(2,opts),
   async()=>[await f.router.lastSwapDeadline(),await f.router.lastSwapExecutionTimestamp()],7);
}

async function configurableSlippageProof(f){
 const checkpoint=await snap();
 const a0=1000n*W,a1=1000n*W;
 await f.pol.setCurveSlippageBps(125);
 await f.pol.setUniSlippageBps(100);
 eq(await f.pol.curveSlippageBps(),125,'Curve owner-set bps 125');
 eq(await f.pol.uniSlippageBps(),100,'NFT owner-set bps 100');
 const curveQuote=await f.guard.quoteDeposit(f.pool.target,0,1000n*W,125);
 eq(curveQuote[1],curveQuote[0]*9875n/10000n,'Curve guard quote dynamically uses 125 bps');
 await f.pool.setSpotBps(9900);
 await f.pol.depositCurve(1000n*W); // 1% deviation passes owner-selected 1.25% Curve
 check((await f.lp.balanceOf(f.pol.target))>0n,'Configured Curve bps honored by deposit');
 const q=await f.guard.quoteUniV3Deposit(f.nft.target,7,a0,a1,100);
 eq(q[4],q[2]*9900n/10000n,'Uni deposit guard configurable 100 bps on token0');
 eq(q[5],q[3]*9900n/10000n,'Uni deposit guard configurable 100 bps on token1');
 await f.nft.setDepositReference(q[0],q[2],q[3]);
 await f.nft.setSpotBps(9900);
 await f.pol.addUniLiquidity(a0,a1);
 eq(await f.nft.lastDepositMin0(),q[4],'100-bps NFT deposit token0 guard output forwarded');
 eq(await f.nft.lastDepositMin1(),q[5],'100-bps NFT deposit token1 guard output forwarded');
 eq(await f.nft.lastDepositDesired0(),a0,'same amount0Desired into guard & NFT');
 eq(await f.nft.lastDepositDesired1(),a1,'same amount1Desired into guard & NFT');
 const qWithdraw=await f.guard.quoteUniV3Withdraw(f.nft.target,7,2500,100);
 eq(qWithdraw[3],qWithdraw[1]*9900n/10000n,'Uni withdraw guard configurable 100 bps on token0');
 eq(qWithdraw[4],qWithdraw[2]*9900n/10000n,'Uni withdraw guard configurable 100 bps on token1');
 await f.nft.setWithdrawalReference(qWithdraw[1],qWithdraw[2]);
 await f.pol.removeUniLiquidity(2500);
 eq(await f.nft.lastWithdrawalMin0(),qWithdraw[3],'100-bps NFT withdraw token0 guard output forwarded');
 eq(await f.nft.lastWithdrawalMin1(),qWithdraw[4],'100-bps NFT withdraw token1 guard output forwarded');
 await f.pol.setUniSlippageBps(50);
 eq(await f.pol.uniSlippageBps(),50,'NFT owner-set slippage reduces to 50 bps');
 const qStrict=await f.guard.quoteUniV3Withdraw(f.nft.target,7,2500,50);
 eq(qStrict[3],qStrict[1]*9950n/10000n,'NFT min0 tightens dynamically to 50 bps');
 eq(qStrict[4],qStrict[2]*9950n/10000n,'NFT min1 tightens dynamically to 50 bps');
 await f.nft.setWithdrawalReference(qStrict[1],qStrict[2]);
 await f.nft.setSpotBps(9940);
 await revertTx(f.pol.removeUniLiquidity(2500),'50bps NFT limit rejects 60bps adverse execution');
 const position=await f.guard.quoteUniV3Position(f.nft.target,7,50);
 eq(position[5],position[3]*9950n/10000n,'Uni V8 position quote also accepts owner-supplied 50bps');
 eq(position[6],position[4]*9950n/10000n,'Uni V8 position quote token1 uses 50bps');
 await revertTx(f.pol.connect(f.attacker).setUniSlippageBps(100),'onlyOwner restricts NFT setting');
 await revertTx(f.pol.connect(f.attacker).setCurveSlippageBps(100),'onlyOwner restricts Curve setting');
 reports.push({component:'Independent owner-configurable Curve/NFT slippage and full guard forwarding',
   curveSelectedBps:125,uniSelectedBps:100,uniTightenedBps:50,pass:true});
 await restore(checkpoint);
}

async function main(){
 const net=await ethers.provider.getNetwork();
 eq(net.chainId,1n,'Ethereum fork network chain ID 1');
 const block=await ethers.provider.getBlock('latest');
 check(block.number>21000000,'forked current Ethereum block, not fresh local chain');
 check((await ethers.provider.getCode(ALIVE_OLD_POL)).length>2,'real existing v19 PoL Manager exists on fork');
 check((await ethers.provider.getCode(ALIVE_OLD_GUARD)).length>2,'real existing V6 guard exists on fork');
 console.log('MAINNET_FORK_BLOCK',JSON.stringify({number:block.number,hash:block.hash,chainId:String(net.chainId)}));
 const f=await fixture();
 eq(await f.pol.uniSlippageBps(),75,'new PoL Uniswap NFT default slippage 75 bps');
 eq(await f.pol.curveSlippageBps(),75,'Manager Curve default 75 bps');
 await revertTx(f.pol.setCurveSlippageBps(10000),'reject disabling Curve minout');
 await revertTx(f.pol.setUniSlippageBps(10000),'reject disabling Uniswap minout');
 eq(await f.pol.NFT_SWAP_SLIPPAGE_BPS(),75,'NFT router 75 bps constant');
 eq(await f.pol.SDT_USDC_SWAP_SLIPPAGE_BPS(),200,'SDT/USDC router 200 bps constant');
 await deadlineQueuedProof(f);
 await configurableSlippageProof(f);
 for(const bps of [10000,9926,9925,9924,9860,9700,9500,9000]){
  const pass=bps>=9925;
  await curveDepositTrial(f,bps);
  await curveWithdrawTrial(f,bps);
  await uniAddTrial(f,bps,pass);
  await uniRemoveTrial(f,bps,pass);
 }
 for(const bps of [10000,9926,9925,9924,9860,9700,9500,9000]){
  await rebalanceTrial(f,bps,bps>=9925);
 }
 await rebalanceTrial(f,9000,false,true); // lie about received, actual < min => revert
 for(const forward of [true,false]){
  for(const bps of [10000,9801,9800,9799,9860,9500]){
    await sdtUsdcTrial(f,forward,bps,bps>=9800);
  }
 }
 const counts={
  scenarioCount:reports.length,
  successful:reports.filter(x=>x.pass).length,
  expectedReverts:reports.filter(x=>!x.pass).length,
  assertions,mainnetForkBlock:block.number,
  policy:{curve:75,uniswapNFT:75,nftBalancingSwap:75,sdtUsdcBothDirections:200},
  realEthereumCodeChecked:[ALIVE_OLD_POL,ALIVE_OLD_GUARD],
  tests:reports,
  deadlineProofs:reports.filter(t=>t.component.startsWith('Pending ')),
  exactDeadlineEqualityVerified:true
 };
 const file=path.join(OUTPUT,'Fork-Stress-Results-v4.json');
 fs.writeFileSync(file,JSON.stringify(counts,null,2)+'\n');
 console.log('FULL_FORK_75_200_BPS_PASS',JSON.stringify({scenarios:counts.scenarioCount,successful:counts.successful,reverts:counts.expectedReverts,assertions,block:block.number}));
}
main().catch(e=>{console.error('FORK_75_200_BPS_FAILED',e.stack||e);process.exitCode=1;});
