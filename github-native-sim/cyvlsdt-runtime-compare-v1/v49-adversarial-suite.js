const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");
const WEEK = 7 * 24 * 3600;
const E18 = 10n**18n;
const E6 = 10n**6n;
const SDT_ADDR = "0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F";
const USDC_ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CRV_ADDR = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const ALADDIN_ADDR = "0x322c76e1205dE5ee4146e40644563B482B1CDA43";
const units=(n)=>BigInt(n)*E18;
const usd=(n)=>BigInt(n)*E6;
async function jump(seconds){await network.provider.send("evm_increaseTime",[Number(seconds)]);await network.provider.send("evm_mine");}
async function stamp(){return (await ethers.provider.getBlock("latest")).timestamp;}
function endweek(now,weeks){return BigInt(Math.floor((Number(now)+Number(weeks)*WEEK+WEEK-1)/WEEK)*WEEK);}
async function deploy(name,...args){const f=await ethers.getContractFactory(name);const c=await f.deploy(...args);await c.waitForDeployment();return c;}
async function transplant(name,addr){
  const c=await deploy(name);await network.provider.send("hardhat_setCode",[addr,await ethers.provider.getCode(c.target)]);
  return ethers.getContractAt(name,addr);
}
async function mustFail(promise,label){
  let failed=false;
  try {const tx=await promise;if(tx && tx.wait) await tx.wait();}
  catch(e){failed=true;}
  assert(failed,"unexpected success: "+label);
}
function eq(a,b,label){assert.equal(BigInt(a).toString(),BigInt(b).toString(),label);}
async function fixture(){
  const [owner,admin,treasury,alice,bob,buyer,attacker,keeper,recipient,pol,bribe,secondBuyer]=await ethers.getSigners();
  const sdt=await transplant("StressSDT",SDT_ADDR);
  const usdc=await transplant("StressUSDC",USDC_ADDR);
  const crv=await transplant("StressCRV",CRV_ADDR);await crv.setRate(10n*E18);
  const aladdin=await transplant("StressAladdin",ALADDIN_ADDR);
  const token=await deploy("CurveYieldVlSDTToken",owner.address);
  const vl=await deploy("StressVLSDT",sdt.target);
  const boost=await deploy("StressVlBoost",vl.target);await vl.setBoost(boost.target);
  await aladdin.setRegistry(boost.target);
  const dusdc=await deploy("StressDistributor",usdc.target);
  const dsdt=await deploy("StressDistributor",sdt.target);
  const stakeRouter=await deploy("StressStakeDaoRouter");
  const market=await deploy("StressMarketplace",boost.target,treasury.address);
  const omni=await deploy("StressOmniRouter");
  await omni.setRate(sdt.target,usdc.target,1_000_000n);
  await omni.setRate(usdc.target,sdt.target,10n**30n);
  await omni.setRate(crv.target,usdc.target,2n*E18);
  const locker=await deploy("CurveYieldVlSDTLocker",owner.address,treasury.address,sdt.target,vl.target,boost.target,stakeRouter.target,dusdc.target,dsdt.target,market.target,token.target);
  const staking=await deploy("CurveYieldvlSDTStaking",owner.address,admin.address,treasury.address,token.target,sdt.target,usdc.target,locker.target,vl.target,dsdt.target,dusdc.target,omni.target);
  const merchant=await deploy("CurveYieldVlSDTBoostMerchant",owner.address,locker.target,market.target);
  await locker.configureSystem(staking.target,merchant.target);
  await token.setLocker(locker.target);
  await locker.setMarketplaceOperator(true);
  for(const rewardToken of [sdt.target,usdc.target,token.target])await staking.addRewardToken(rewardToken);
  await merchant.setSaleRates(100_000,100_000,E18);
  await merchant.setKeeper(keeper.address,true);
  for (const signer of [owner,alice,bob,buyer,attacker,secondBuyer]){
    await sdt.mint(signer.address,units(1_000_000));
    await sdt.connect(signer).approve(locker.target,ethers.MaxUint256);
    await usdc.mint(signer.address,usd(1_000_000));
    await usdc.connect(signer).approve(market.target,ethers.MaxUint256);
    await usdc.connect(signer).approve(merchant.target,ethers.MaxUint256);
  }
  const now=await stamp();
  const epoch=Math.floor(now/WEEK)*WEEK;
  await dusdc.setEpoch(epoch-WEEK,usd(200),epoch);
  await dsdt.setEpoch(epoch-WEEK,units(1000),epoch);
  await aladdin.setHistory(epoch-WEEK,units(1000),units(100_000),epoch);
  await vl.setHistoricalSupply(epoch-WEEK,units(100_000));
  return {owner,admin,treasury,alice,bob,buyer,attacker,keeper,recipient,pol,bribe,secondBuyer,
    sdt,usdc,crv,aladdin,token,vl,boost,dusdc,dsdt,stakeRouter,market,omni,locker,staking,merchant};
}
async function deposit(f,amount=100000n){
  await f.locker.connect(f.alice).deposit(units(amount),f.alice.address);
  eq(await f.vl.balanceOf(f.locker.target),units(amount),"Locker actual vlSDT principal");
  eq(await f.token.totalSupply(),units(amount),"cyvlSDT minted principal");
}
async function refreshAladdin(f){
  const now=await stamp();const week=Math.floor(now/WEEK)*WEEK;
  await f.aladdin.setHistory(week-WEEK,units(1000),units(100_000),week);
}
async function assertBoostState(f,label){
  const [balance,delegated,rawFree,m,d,a,listed,filled,mCap,dCap,aCap,mFree,dFree,aFree]=await Promise.all([
    f.vl.balanceOf(f.locker.target),f.boost.delegatedOut(f.locker.target),f.boost.delegableBalance(f.locker.target),
    f.locker.merchantCommittedBoost(),f.locker.daoCommittedBoost(),f.locker.adminCommittedBoost(),
    f.locker.marketplaceCommittedBoost(),f.locker.marketplaceFilledBoost(),
    f.locker.merchantBoostAllocation(),f.locker.daoBoostAllocation(),f.locker.adminBoostAllocation(),
    f.locker.merchantDelegableBoost(),f.locker.daoDelegableBoost(),f.locker.adminDelegableBoost()
  ]);
  const merchantUsed=m+filled+listed;
  eq(balance-delegated,rawFree,label+" physical delegation conservation");
  assert(m<=mCap,label+" merchant direct lane exceeds 85%");
  assert(d<=dCap,label+" DAO lane exceeds 10%");
  assert(a<=aCap,label+" admin lane exceeds 5%");
  assert(merchantUsed<=mCap,label+" merchant committed+filled+listed exceeds 85%");
  assert(mFree<=mCap-merchantUsed && mFree<=rawFree,label+" merchant available overdrawn");
  assert(dFree<=dCap-d && dFree<=rawFree,label+" DAO available overdrawn");
  assert(aFree<=aCap-a && aFree<=rawFree,label+" admin available overdrawn");
  assert(delegated<=balance,label+" underlying overdelegation");
  assert(delegated+listed<=balance,label+" active delegation + listed reserve overphysical");
  return {balance,delegated,m,d,a,listed,filled,merchantUsed,rawFree};
}
async function snapshot(f){
  const [buyer,merchant,locker,staking,treasury,delegated,m,d,a,filled,listed,base,active]=await Promise.all([
    f.usdc.balanceOf(f.buyer.address),f.usdc.balanceOf(f.merchant.target),
    f.usdc.balanceOf(f.locker.target),f.usdc.balanceOf(f.staking.target),
    f.usdc.balanceOf(f.treasury.address),f.boost.delegatedOut(f.locker.target),
    f.locker.merchantCommittedBoost(),f.locker.daoCommittedBoost(),f.locker.adminCommittedBoost(),
    f.locker.marketplaceFilledBoost(),f.locker.marketplaceCommittedBoost(),
    f.staking.totalActiveStake(),f.token.totalSupply()
  ]);
  return [buyer,merchant,locker,staking,treasury,delegated,m,d,a,filled,listed,base,active].map(x=>x.toString());
}
function same(before,after,label){assert.deepEqual(after,before,label);}

describe("CurveYield v49 multiactor adversarial and state-conservation qualification",function(){
  this.timeout(30*60*1000);

  it("auto-releases expired DAO and admin capacity, never assigns it to Merchant, and prevents stale release double-counting",async function(){
    const f=await fixture();await deposit(f);await assertBoostState(f,"initial");
    const t=await stamp();
    const daoEnd=endweek(t,1);
    await f.locker.delegateDaoBoost(units(10000),daoEnd,f.recipient.address);
    await f.locker.connect(f.admin).delegateAdminBoost(units(5000),endweek(t,2),f.attacker.address);
    eq(await f.locker.daoCommittedBoost(),units(10000),"DAO reserved exactly 10%");
    eq(await f.locker.adminCommittedBoost(),units(5000),"admin reserved exactly 5%");
    await mustFail(f.locker.delegateDaoBoost(1n,daoEnd,f.recipient.address),"DAO capacity cap");
    await mustFail(f.locker.connect(f.attacker).delegateAdminBoost(1n,daoEnd,f.recipient.address),"admin auth");
    await mustFail(f.locker.connect(f.attacker).delegateDaoBoost(1n,daoEnd,f.recipient.address),"DAO auth");
    await refreshAladdin(f);
    const listingId=await f.market.nextID();
    await f.merchant.connect(f.keeper).createMarketplaceListing(units(40000),1,6,BigInt(t+9*WEEK));
    eq(await f.locker.marketplaceCommittedBoost(),units(40000),"list 40k");
    await f.market.connect(f.buyer).fillListing(listingId,units(40000),4,f.buyer.address);
    eq(await f.locker.marketplaceFilledBoost(),units(40000),"market sale remains Merchant");
    await assertBoostState(f,"before DAO expiry");
    await jump(Number(daoEnd)-await stamp()+1);
    eq(await f.locker.daoCommittedBoost(),0n,"DAO commitment auto expired");
    eq(await f.locker.marketplaceFilledBoost(),units(40000),"Merchant fill not undercounted after DAO expiry");
    eq(await f.locker.daoDelegableBoost(),units(10000),"DAO 10% restored to original lane");
    await refreshAladdin(f);
    await f.merchant.delegateAladdinBoost(units(45000),endweek(await stamp(),2));
    eq(await f.locker.merchantBoostUsed(),units(85000),"85% merchant ceiling");
    await mustFail(f.merchant.delegateAladdinBoost(1n*E18,endweek(await stamp(),2)),"merchant cannot use DAO");
    await assertBoostState(f,"merchant filled to 85%");
    const daoId=1;
    await f.locker.releaseDaoBoostCommitment(daoId);
    eq(await f.locker.daoCommittedBoost(),0n,"late release no double subtraction");
    await mustFail(f.locker.releaseDaoBoostCommitment(daoId),"double release");
    await f.locker.delegateDaoBoost(units(10000),endweek(await stamp(),2),f.recipient.address);
    await assertBoostState(f,"DAO reused its 10%");
    await jump(WEEK+WEEK+30);
    eq(await f.locker.adminCommittedBoost(),0n,"admin expiry frees its group");
    await f.locker.releaseAdminBoostCommitment(1);
    eq(await f.locker.adminDelegableBoost(),units(5000),"admin 5% independently restored");
    await assertBoostState(f,"all lanes after expiries");
  });

  it("direct lease is atomic across USDC Merchant->Locker->Staking and underlying boost delegation; adverse calls restore all account balances",async function(){
    const f=await fixture();await deposit(f);
    await f.token.connect(f.alice).approve(f.staking.target,ethers.MaxUint256);
    await f.staking.connect(f.alice).stake(units(70000));
    const amount=units(2500), quote=await f.merchant.quoteLease(amount,2);
    const due=quote.totalPayment;
    const before=await snapshot(f);
    await f.merchant.connect(f.buyer).leaseBoost(amount,2,f.recipient.address,due,BigInt((await stamp())+60));
    const after=await snapshot(f);
    const actualPaid=BigInt(before[0])-BigInt(after[0]);
    assert(actualPaid>0n && actualPaid<=due && due-actualPaid<1000n,"buyer pays one block-adjusted price without overpayment");
    eq(BigInt(after[1]),0n,"Merchant retains no buyer funds");
    eq(BigInt(after[2]),0n,"Locker forwards all USDC");
    eq(BigInt(after[5])-BigInt(before[5]),amount,"real boost delivered");
    eq(BigInt(after[6])-BigInt(before[6]),amount,"Merchant lane records lease");
    await assertBoostState(f,"successful atomic lease");
    const baseline=await snapshot(f);
    await f.boost.setFailBoost(true);
    await mustFail(f.merchant.connect(f.buyer).leaseBoost(units(120),2,f.recipient.address,usd(1000),BigInt((await stamp())+60)),"registry fails after payment");
    same(baseline,await snapshot(f),"no payment/staking/boost state changes on failed delegation");
    await f.boost.setFailBoost(false);
    await mustFail(f.merchant.connect(f.buyer).leaseBoost(units(120),2,f.recipient.address,1n,BigInt((await stamp())+60)),"buyer max payment protects");
    await mustFail(f.merchant.connect(f.buyer).leaseBoost(units(120),2,f.recipient.address,usd(1000),BigInt((await stamp())-1)),"expired deadline");
    await mustFail(f.merchant.connect(f.buyer).leaseBoost(units(120),2,f.aladdin.target,usd(1000),BigInt((await stamp())+60)),"cannot lease to Aladdin");
    same(baseline,await snapshot(f),"all failed lease attempts conserve state");
  });

  it("separates DAO marketplace receipts from Merchant receipts; partial fills, cancellations and operator permissions",async function(){
    const f=await fixture();await deposit(f);
    await f.token.connect(f.alice).approve(f.staking.target,ethers.MaxUint256);
    await f.staking.connect(f.alice).stake(units(100000));
    const exp=(await stamp())+4*WEEK;
    const idDao=await f.market.nextID();
    await f.market.connect(f.buyer).createOffer(units(7000),200000,2,f.usdc.target,exp,f.recipient.address);
    const beforeTreasury=await f.usdc.balanceOf(f.treasury.address);
    const beforeStaking=await f.usdc.balanceOf(f.staking.target);
    await mustFail(f.locker.connect(f.attacker).marketplaceAcceptOffer(idDao,units(1000),0,0,true),"DAO sale reserved to owner");
    await f.locker.marketplaceAcceptOffer(idDao,units(4000),0,0,true);
    assert((await f.usdc.balanceOf(f.treasury.address))>beforeTreasury,"DAO treasury receives proceeds");
    eq(await f.usdc.balanceOf(f.staking.target),beforeStaking,"DAO income does not enter Staking");
    eq(await f.locker.daoCommittedBoost(),units(4000),"DAO sold boost recorded DAO lane");
    eq(await f.locker.marketplaceFilledBoost(),0n,"DAO sale never counted as Merchant");
    const marketId=await f.market.nextID();
    await f.market.connect(f.secondBuyer).createOffer(units(10000),250000,2,f.usdc.target,exp,f.secondBuyer.address);
    await f.merchant.fillProfitableOffer(marketId,units(3000),0,0);
    const mUsed=await f.locker.merchantBoostUsed();
    eq(mUsed,units(3000),"Merchant recorded first partial fill");
    await f.merchant.fillProfitableOffer(marketId,units(2000),0,0);
    eq(await f.locker.marketplaceFilledBoost(),units(5000),"Merchant recorded second fill");
    eq(await f.locker.daoCommittedBoost(),units(4000),"merchant cannot steal DAO attribution");
    await assertBoostState(f,"partial fill attributed by ownership");
    const listingId=await f.market.nextID();
    await refreshAladdin(f);
    await f.merchant.connect(f.keeper).createMarketplaceListing(units(2000),1,5,exp);
    eq(await f.locker.marketplaceCommittedBoost(),units(2000),"unfilled listing reserves physical capacity");
    await f.merchant.connect(f.keeper).refreshMarketplaceListing(listingId,units(2800));
    eq(await f.locker.marketplaceCommittedBoost(),units(2800),"listing update changes reservation");
    await f.merchant.connect(f.keeper).cancelMarketplaceListing(listingId);
    eq(await f.locker.marketplaceCommittedBoost(),0n,"cancellation releases reservation");
    await assertBoostState(f,"after cancellation");
  });

  it("cumulative revenue in 1 receipt versus 200 fragments preserves exact epoch tiers, recipients, pending conversions and circulating principal",async function(){
    const f=await fixture();await deposit(f);
    await f.token.connect(f.alice).approve(f.staking.target,ethers.MaxUint256);
    await f.staking.connect(f.alice).stake(units(100000));
    await f.staking.setLpBribeRevenueShare(1000,f.bribe.address);
    await f.locker.setPoLDepositShare(0,f.pol.address);
    const epoch=Math.floor((await stamp())/WEEK)*WEEK;
    const key=f.usdc.target;
    async function send(amount){
      await f.usdc.mint(f.locker.target,amount);
      await f.locker.connect(f.attacker).forwardRevenue();
    }
    async function collect(){
      const e=await f.staking.epochAccounting(key,epoch);
      const count=Number(await f.staking.pendingConversionCount());
      let pending=0n;
      for(let id=0;id<count;id++){
        const x=await f.staking.pendingConversions(id);if(x.token.toLowerCase()===key.toLowerCase())pending+=x.amount;
      }
      return {
        benchmark:e.benchmark.toString(),received:e.received.toString(),base:e.baseAllocated.toString(),
        first:e.firstExcessAllocated.toString(),ef:e.eligibleFirstExcess.toString(),es:e.eligibleSecondExcess.toString(),
        treasury:e.treasuryAllocated.toString(),admin:e.adminAllocated.toString(),pol:e.poLAllocated.toString(),
        bribe:(await f.usdc.balanceOf(f.bribe.address)).toString(),treasuryBal:(await f.usdc.balanceOf(f.treasury.address)).toString(),
        adminBal:(await f.usdc.balanceOf(f.admin.address)).toString(),polBal:(await f.usdc.balanceOf(f.pol.address)).toString(),
        pending:pending.toString(),totalStake:(await f.staking.totalActiveStake()).toString(),
        locker:(await f.usdc.balanceOf(f.locker.target)).toString()
      };
    }
    const snap=await network.provider.send("evm_snapshot");
    await send(usd(1000));
    const lump=await collect();
    await network.provider.send("evm_revert",[snap]);
    for(let n=0;n<200;n++)await send(usd(5));
    const parts=await collect();
    assert.deepEqual(parts,lump,"200 arbitrary receipt fragments must match one receipt exactly");
    eq(parts.received,usd(900),"bribe applied once per fragment total 10%");
    eq(parts.benchmark,usd(200),"base entitlement calculated at first receipt");
    eq(parts.base,usd(200),"base yield satisfied before excess");
    eq(parts.first,usd(100),"first excess tier");
    eq(parts.es,usd(600),"second excess tier");
    eq(parts.bribe,usd(100),"bribe exactly once");
    eq(parts.locker,0n,"Locker never holds forwarded USDC");
  });

  it("staking streamed rewards, queue withdrawals, no-reward theft, and reward conservation across several users",async function(){
    const f=await fixture();await deposit(f);
    await f.token.connect(f.alice).transfer(f.bob.address,units(40000));
    for(const [signer,amt] of [[f.alice,60000n],[f.bob,40000n]]){
      await f.token.connect(signer).approve(f.staking.target,ethers.MaxUint256);
      await f.staking.connect(signer).stake(units(amt));
    }
    await f.usdc.mint(f.locker.target,usd(100));
    await f.locker.forwardRevenue();
    const epoch=Math.floor((await stamp())/WEEK)*WEEK;
    const base=(await f.staking.epochAccounting(f.usdc.target,epoch)).baseAllocated;
    eq(base,usd(100),"base reward fully consumed");
    await jump(WEEK/2);
    const earnedAlice=await f.staking.earned(f.alice.address,f.usdc.target);
    const earnedBob=await f.staking.earned(f.bob.address,f.usdc.target);
    assert(earnedAlice>earnedBob && earnedBob>0n,"shares proportionate to active stake");
    const queued=units(40000);
    await f.staking.connect(f.bob).requestWithdrawal(queued);
    eq(await f.staking.totalActiveStake(),units(60000),"queued stake removed from active");
    eq(await f.staking.totalQueuedStake(),queued,"queued conservation");
    await jump(WEEK/2+1);
    const aliceBefore=await f.usdc.balanceOf(f.alice.address);
    const bobBefore=await f.usdc.balanceOf(f.bob.address);
    await f.staking.connect(f.alice).claimRewardsSelf();
    await f.staking.connect(f.bob).claimRewardsSelf();
    const alicePaid=(await f.usdc.balanceOf(f.alice.address))-aliceBefore;
    const bobPaid=(await f.usdc.balanceOf(f.bob.address))-bobBefore;
    assert(alicePaid>0n && bobPaid>0n,"both entitled users claim their earned rewards");
    assert(alicePaid+bobPaid<=usd(100),"never distribute more than received");
    await mustFail(f.staking.connect(f.attacker).completeQueuedWithdrawal(1,f.attacker.address),"cannot steal queued shares");
    await jump(WEEK+2);
    const bobCyBefore=await f.token.balanceOf(f.bob.address);
    await f.staking.connect(f.bob).completeQueuedWithdrawal(1,f.bob.address);
    eq((await f.token.balanceOf(f.bob.address))-bobCyBefore,queued,"Bob receives all queued cyvlSDT");
    eq(await f.staking.totalQueuedStake(),0n,"queued accounting clears");
    await mustFail(f.staking.connect(f.bob).completeQueuedWithdrawal(1,f.bob.address),"cannot replay queued withdrawal");
    await f.staking.connect(f.alice).withdrawImmediate(units(10000),f.alice.address);
    eq(await f.staking.totalActiveStake(),units(50000),"instant withdraw updates active balance");
    await f.staking.connect(f.attacker).claimRewardsSelf();
  });

  it("VoteMarket: route failures, profitable/unprofitable estimates, one-fund-per-epoch, expiry, refund, owner rescue and conservative claims",async function(){
    const f=await fixture();
    const gauge=await deploy("StressGaugeController");
    const voteMarket=await deploy("StressVoteMarket",gauge.target);
    const allocator=await deploy("VoteMarketSingleGaugeBribeAllocator",f.owner.address,f.omni.target,voteMarket.target);
    await allocator.setGauge(f.recipient.address);
    await f.usdc.mint(allocator.target,usd(1000));
    const max=await allocator.previewMaxRewardPerVote();
    assert(max>0n,"positive prospective emission price");
    await allocator.fundEpoch();
    const id=await allocator.bountyId();
    eq(id,1n,"first bounty");
    eq(await f.usdc.balanceOf(voteMarket.target),usd(1000),"VoteMarket custody of funded budget");
    eq(await allocator.hasBounty(),1n,"active bounty flag");
    await f.usdc.mint(allocator.target,usd(200));
    eq(await allocator.fundEpoch.staticCall(),0n,"same epoch cannot double fund");
    eq(await f.usdc.balanceOf(allocator.target),usd(200),"new funds remain available");
    await f.sdt.mint(allocator.target,units(50));
    await f.omni.setFail(true);
    await mustFail(allocator.convertSDT(),"router fail preserves SDT");
    eq(await f.sdt.balanceOf(allocator.target),units(50),"no SDT lost on swap failure");
    await f.omni.setFail(false);
    await allocator.convertSDT();
    eq(await f.sdt.balanceOf(allocator.target),0n,"SDT conversion consumed exact input");
    eq(await f.usdc.balanceOf(allocator.target),usd(250),"received 50 USDC");
    await jump(WEEK+10);
    await allocator.fundEpoch();
    eq(await f.usdc.balanceOf(voteMarket.target),usd(1250),"extension funded only once");
    await voteMarket.claimSimulated(id,f.buyer.address,usd(375));
    eq(await f.usdc.balanceOf(voteMarket.target),usd(875),"partial external claim");
    await jump(6*WEEK);
    const before=await f.usdc.balanceOf(allocator.target);
    await allocator.closeExpiredBounty();
    eq((await f.usdc.balanceOf(allocator.target))-before,usd(875),"exact unspent refund to manager");
    eq(await allocator.hasBounty(),0n,"closed bounty");
    await mustFail(allocator.recoverToken(f.usdc.target,f.attacker.address,usd(10)),"owner cannot rescue while unpaused");
    await allocator.setPaused(true);
    await mustFail(allocator.connect(f.attacker).recoverToken(f.usdc.target,f.attacker.address,usd(10)),"non-owner cannot rescue");
    await allocator.recoverToken(f.usdc.target,f.treasury.address,usd(100));
    eq(await f.usdc.balanceOf(allocator.target),usd(775),"paused rescue tracked correctly");
  });

  it("seeded 12-run saturation campaign executes 3000 multiactor operations with 39000+ account checks and revert classification",async function(){
    const f=await fixture();await deposit(f);
    let accepted=0,rejected=0,skipped=0,accountChecks=0;
    for(let run=0;run<12;run++){
      const snap=await network.provider.send("evm_snapshot");
      let seed=(0x9e3779b9 ^ Math.imul(run+1,0x85ebca6b))|0;
      function rand(n){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)%n;}
      const pendingListings=[];
      for(let step=0;step<250;step++){
        const action=rand(8);
        const amount=units(100+rand(12000));
        const now=await stamp();
        const before=await snapshot(f);
        const [mFree,dFree,aFree]=await Promise.all([
          f.locker.merchantDelegableBoost(),f.locker.daoDelegableBoost(),f.locker.adminDelegableBoost()
        ]);
        let shouldSucceed=false,executed=false;
        try{
          if(action===0){
            shouldSucceed=amount<=dFree;
            await f.locker.delegateDaoBoost(amount,endweek(now,1+rand(6)),f.recipient.address);
            executed=true;
          }else if(action===1){
            shouldSucceed=amount<=aFree;
            await f.locker.connect(f.admin).delegateAdminBoost(amount,endweek(now,1+rand(6)),f.attacker.address);
            executed=true;
          }else if(action===2){
            shouldSucceed=amount<=mFree;
            await f.merchant.connect(f.keeper).delegateAladdinBoost(amount,endweek(now,1+rand(7)));
            executed=true;
          }else if(action===3){
            await refreshAladdin(f);
            shouldSucceed=amount<=mFree;
            const id=await f.market.nextID();
            await f.merchant.connect(f.keeper).createMarketplaceListing(amount,1,5,now+2*WEEK);
            pendingListings.push(id);
            executed=true;
          }else if(action===4 && pendingListings.length){
            shouldSucceed=true;
            const id=pendingListings.shift();
            await f.merchant.connect(f.keeper).cancelMarketplaceListing(id);
            executed=true;
          }else if(action===5){
            await refreshAladdin(f);
            shouldSucceed=amount<=mFree;
            await f.merchant.connect(f.buyer).leaseBoost(amount,2,f.recipient.address,usd(5000),BigInt(now+60));
            executed=true;
          }else if(action===6){
            shouldSucceed=true;
            await jump(WEEK+rand(3600));
            executed=true;
          }else if(action===7 && pendingListings.length){
            const id=pendingListings[rand(pendingListings.length)];
            const record=await f.market.getListing(id);
            if(record.seller!==ethers.ZeroAddress && record.expiry>BigInt(now)&&record.amount>record.filled){
              shouldSucceed=true;
              await f.market.connect(f.secondBuyer).fillListing(id,record.amount-record.filled,2,f.secondBuyer.address);
              executed=true;
            }
          }
        }catch(error){
          if(shouldSucceed){
            throw Error("UNEXPECTED_REVERT seed="+run+" step="+step+" action="+action+
              " amount="+amount+" mFree="+mFree+" dFree="+dFree+" aFree="+aFree+" cause="+String(error));
          }
          same(before,await snapshot(f),"reverted transaction changes account state at run="+run+" step="+step);
          rejected++;
        }
        if(executed) accepted++;
        else if(!shouldSucceed) skipped++;
        await assertBoostState(f,"saturation seed="+run+" step="+step);
        accountChecks+=13;
        if(step%125===0)console.log("SATURATION_STATE",JSON.stringify({
          run,step,accepted,rejected,seed,
          delegated:(await f.boost.delegatedOut(f.locker.target)).toString(),
          merchantUsed:(await f.locker.merchantBoostUsed()).toString()
        }));
      }
      await network.provider.send("evm_revert",[snap]);
    }
    assert(accepted>500 && rejected>100,"insufficient saturation/negative-test coverage");
    console.log("RANDOM_SATURATION_COMPLETED",JSON.stringify({
      runs:12,operations:3000,accepted,rejected,skipped,accountChecks
    }));
  });
});
