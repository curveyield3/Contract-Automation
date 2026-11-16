const assert=require("node:assert/strict");
const {ethers,network}=require("hardhat");
const WEEK=604800n;
const ADDR={
  vl:"0x94818A7baa7e9F5dC62ce4da1B52ef9a760b80B8",
  boost:"0xaB05ca46d1c78CAbB051efFE35099714Cad2AddA",
  market:"0xbc38D256E559FEd3fA95A6cdC633C667283fb6b8",
  aladdin:"0x322c76e1205de5ee4146e40644563b482b1cda43",
  dsdt:"0x6d57d34259f6dc31c9a241c199822861940d38f9",
  dusdc:"0xCa94395469a88E9cAC0D5E5e308910E298270d30",
  sdt:"0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F",
  usdc:"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  marketV1:"0x0000000895cB182E6f983eb4D8b4E0Aa0B31Ae4c",
  omni:"0xa4a533025fef8d3446e7cb8a434824e1ee865b00",
};
const registryAbi=[
 "function delegatedOut(address) view returns(uint256)",
 "function delegableBalance(address) view returns(uint256)",
 "function MAX_DURATION_WEEKS() view returns(uint256)",
 "function isOperator(address,address) view returns(bool)",
 "function setOperator(address,bool)",
 "event Boost(address indexed delegator,address indexed recipient,uint256 amount,uint256 expiry)"
];
const marketAbi=[
 "function feeBps() view returns(uint256)",
 "function minOrderAmount() view returns(uint256)",
 "function minFillAmount() view returns(uint256)",
 "function maxDurationWeeks() view returns(uint256)",
 "function nextOrderId() view returns(uint256)",
 "function committedBalance(address) view returns(uint256)",
 "function createListing(uint256,uint256,uint256,uint256,address,uint256) returns(uint256)",
 "function cancelListing(uint256)",
 "function getListing(uint256) view returns(tuple(address seller,uint96 pricePerWeek,address paymentToken,uint32 maxDuration,uint64 expiry,uint128 amount,uint128 filled,uint32 minDuration))"
];
const eq=(a,b,label)=>assert.equal(String(a),String(b),label);
const c=(key,abi)=>new ethers.Contract(ADDR[key],abi,ethers.provider);
async function snapshotStakeDao(){
 const vl=c("vl",[
 "function balanceOf(address) view returns(uint256)",
 "function totalSupplyAt(uint256) view returns(uint256)",
 "event Transfer(address indexed from,address indexed to,uint256 value)"
 ]);
 const boost=c("boost",registryAbi);
 const market=c("market",marketAbi);
 const dAbi=["function lastTokenTime() view returns(uint256)","function tokensPerEpoch(uint256) view returns(uint256)"];
 const dsdt=c("dsdt",dAbi),dusdc=c("dusdc",dAbi);
 const aladdin=c("aladdin",[
   "function lastSDTReward() view returns(uint128,uint128)",
   "function weeklyRewards(uint256) view returns(uint256)",
   "function historyBoosts(address,uint256) view returns(uint256)",
   "function boost(uint256,uint256,address)"
 ]);
 const vm=c("marketV1",["function getCurrentPeriod() view returns(uint256)","function fee() view returns(uint256)","function gaugeController() view returns(address)"]);
 return {vl,boost,market,dsdt,dusdc,aladdin,vm};
}
describe("cyvlSDT v49 live Ethereum fork: independent Stake DAO/Aladdin/VoteMarket state",function(){
 this.timeout(25*60*1000);
 it("verifies live external code, epoch reward units, marketplace configuration and VoteMarket period semantics",async()=>{
   const block=await ethers.provider.getBlock("latest");
   assert(block&&block.number>10000000,"real Ethereum fork required");
   eq((await ethers.provider.getNetwork()).chainId,1n,"Ethereum chain");
   for(const [name,addr] of Object.entries(ADDR)){
      const code=await ethers.provider.getCode(addr);
      assert(code.length>2,"verified live integration missing code: "+name);
   }
   const f=await snapshotStakeDao();
   const marketWeek=await f.market.maxDurationWeeks(),boostWeek=await f.boost.MAX_DURATION_WEEKS();
   assert(marketWeek>0n&&marketWeek<=boostWeek,"market week bound respects actual registry");
   assert((await f.market.minOrderAmount())>=await f.market.minFillAmount(),"market min order vs fill");
   assert((await f.market.feeBps())<10000n,"market cannot confiscate entire payment");
   eq(await f.vm.getCurrentPeriod(),BigInt(block.timestamp)/WEEK*WEEK,"live VoteMarket week rounding");
   assert((await f.vm.fee())<=10n**18n,"VoteMarket platform fee bounded");
   assert((await ethers.provider.getCode(await f.vm.gaugeController())).length>2,"real Curve gauge controller exists");
   const hist={};
   for (const [name,d] of [["SDT",f.dsdt],["USDC",f.dusdc]]){
     const last=await d.lastTokenTime();
     const checkpoint=last/WEEK*WEEK;
     const epoch=checkpoint>=WEEK?checkpoint-WEEK:0n;
     const supply=epoch===0n?0n:await f.vl.totalSupplyAt(epoch);
     const distributed=epoch===0n?0n:await d.tokensPerEpoch(epoch);
     hist[name]={checkpoint:String(checkpoint),sourceEpoch:String(epoch),supply:String(supply),distributed:String(distributed)};
     assert(distributed>=0n&&supply>=0n,"non-negative real distributor values");
   }
   const week=BigInt(block.timestamp)/WEEK*WEEK-WEEK;
   const aladdinStats=await f.aladdin.lastSDTReward();
   const power=await f.aladdin.historyBoosts(ethers.ZeroAddress,week);
   const reward=await f.aladdin.weeklyRewards(week);
   const viewRate=power===0n?0n:reward*(10n**18n)/power;
   console.log("LIVE_FORK_EXTERNAL",JSON.stringify({
     block:block.number,hash:block.hash,
     marketFeeBps:String(await f.market.feeBps()),
     marketplaceMinimum:String(await f.market.minOrderAmount()),
     marketplaceWeeks:String(marketWeek),vlboostWeeks:String(boostWeek),
     voteMarketFee:String(await f.vm.fee()),
     aladdinCheckpoint:String(aladdinStats[1]),aladdinWeek:String(week),
     aladdinPower:String(power),aladdinWeeklySDT:String(reward),aladdinSDTPerBoostWeek:String(viewRate),
     distributorHistory:hist
   }));
 });

 it("checks live registries against 50 fresh delegator/seller accounts and attempts a real marketplace listing plus Aladdin delegation on the fork",async()=>{
   const f=await snapshotStakeDao();
   const latest=await ethers.provider.getBlockNumber();
   let logs=[];
   const event=ethers.id("Boost(address,address,uint256,uint256)");
   for (let iteration=0;iteration<10;iteration++){
     const to=latest-iteration*20;
     const from=Math.max(0,to-19);
     try{logs=logs.concat(await ethers.provider.getLogs({address:ADDR.boost,topics:[event],fromBlock:from,toBlock:to}));}
     catch(err){console.log("LIVE_EVENT_SCAN_PARTIAL",String(err).slice(0,200));break;}
   }
   const zeroTopic=ethers.zeroPadValue(ethers.ZeroAddress,32);
   for (let i=0;i<2;i++){
     const to=latest-i*20;
     try{logs=logs.concat(await ethers.provider.getLogs({address:ADDR.vl,topics:[ethers.id("Transfer(address,address,uint256)"),zeroTopic],fromBlock:Math.max(0,to-19),toBlock:to}));}
     catch(err){console.log("LIVE_STAKER_SCAN_PARTIAL",String(err).slice(0,200));}
   }
   const seen=new Set(),candidate=[];
   for(const l of logs){
     const a=l.address.toLowerCase()===ADDR.boost.toLowerCase()?
       ethers.getAddress("0x"+l.topics[1].slice(-40)):ethers.getAddress("0x"+l.topics[2].slice(-40));
     if(!seen.has(a.toLowerCase())){seen.add(a.toLowerCase());candidate.push(a);}
   }

   // Historical log scanning can be provider-restricted. Reconstruct live seller
   // candidates from the marketplace's own current order IDs instead.
   let liveListings=0;
   const lastOrderId=await f.market.nextOrderId();
   for(let id=lastOrderId>60n?lastOrderId-60n:1n;id<lastOrderId;id++){
     const listing=await f.market.getListing(id);
     if(listing.seller===ethers.ZeroAddress)continue;
     liveListings++;
     const seller=listing.seller;
     if(!seen.has(seller.toLowerCase())){seen.add(seller.toLowerCase());candidate.push(seller);}
   }
   console.log("LIVE_MARKETPLACE_SELLERS",JSON.stringify({
     lastOrderId:String(lastOrderId),activeListings:liveListings,distinctCandidateAccounts:candidate.length
   }));
   let checked=0,eligible=null;const min=await f.market.minOrderAmount();
   for(const a of candidate.slice(0,50)){
     const [raw,delegated,free,committed]=await Promise.all([
       f.vl.balanceOf(a),f.boost.delegatedOut(a),f.boost.delegableBalance(a),f.market.committedBalance(a)
     ]);
     const required=raw>delegated?raw-delegated:0n;
     eq(free,required,"LIVE_ACCOUNT physical free voting power "+a);
     assert(committed>=0n,"market reserve nonnegative "+a);
     checked++;
     if(free>=min+committed && !eligible)eligible=a;
   }
   console.log("LIVE_ACCOUNT_RECONCILIATION",JSON.stringify({scanLogs:logs.length,distinctCandidates:candidate.length,checked,eligible,minimum:String(min)}));
   assert(checked>=1,"No actual Stake DAO accounts reconciled");
   assert(eligible,"No verified current seller with enough free vlSDT for real marketplace/Aladdin execution");
   if(eligible){
     await network.provider.send("hardhat_impersonateAccount",[eligible]);
     await network.provider.send("hardhat_setBalance",[eligible,"0x56bc75e2d63100000"]);
     const signer=await ethers.getSigner(eligible);
     const usedBefore=await f.boost.delegatedOut(eligible);
     const freeBefore=await f.boost.delegableBalance(eligible);
     const committedBefore=await f.market.committedBalance(eligible);
     const operatorBefore=await f.boost.isOperator(eligible,ADDR.market);
     await f.boost.connect(signer).setOperator(ADDR.market,true);
     const id=await f.market.nextOrderId();
     const now=(await ethers.provider.getBlock("latest")).timestamp;
     await f.market.connect(signer).createListing(min,100000,1,2,ADDR.usdc,now+7200);
     eq(await f.market.committedBalance(eligible),committedBefore+min,"real marketplace created reservation");
     eq((await f.market.getListing(id)).seller.toLowerCase(),eligible.toLowerCase(),"real listing owner");
     await f.market.connect(signer).cancelListing(id);
     eq(await f.market.committedBalance(eligible),committedBefore,"cancel restores real marketplace capacity");
     eq(await f.boost.delegableBalance(eligible),freeBefore,"listing cancellation leaves real boost unchanged");
     eq(await f.boost.delegatedOut(eligible),usedBefore,"no double delegation from listing/cancel");
     await f.boost.connect(signer).setOperator(ADDR.market,operatorBefore);
     const aladdinApproved=await f.boost.isOperator(eligible,ADDR.aladdin);
     await f.boost.connect(signer).setOperator(ADDR.aladdin,true);
     const boostAmount=10n**18n;
     if(await f.boost.delegableBalance(eligible)>=boostAmount){
       const current=await ethers.provider.getBlock("latest");
       const nowW=BigInt(current.timestamp)/WEEK*WEEK;
       const end=nowW+2n*WEEK;
       await f.aladdin.connect(signer).boost(boostAmount,end,eligible);
       eq(await f.boost.delegatedOut(eligible),usedBefore+boostAmount,"real Aladdin proxy boosts actual vlBoost balance");
       console.log("LIVE_ALADDIN_FORK_DELEGATION",JSON.stringify({seller:eligible,amount:String(boostAmount),end:String(end)}));
     }
     await f.boost.connect(signer).setOperator(ADDR.aladdin,aladdinApproved);
   }
 });
});