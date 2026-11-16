const assert=require("node:assert/strict");
const {ethers,network}=require("hardhat");
const W=7*24*3600;
const U=10n**18n;
const amount=n=>BigInt(n)*U;
async function dep(name,...args){const f=await ethers.getContractFactory(name);const x=await f.deploy(...args);await x.waitForDeployment();return x;}
async function fail(p,label){let reverted=false;try{const x=await p;if(x&&x.wait)await x.wait();}catch(e){reverted=true;}assert(reverted,label);}
const eq=(a,b,label)=>assert.equal(String(a),String(b),label);
async function clock(seconds){await network.provider.send("evm_increaseTime",[Number(seconds)]);await network.provider.send("evm_mine");}
async function polFixture(){
  const [owner,operator,guardian,treasury,attacker,user]=await ethers.getSigners();
  const sdt=await dep("StressSDT"),usdc=await dep("StressUSDC"),crv=await dep("StressToken","CRV","CRV",18);
  const cyvl=await dep("StressToken","cyvlSDT","cyvl",18);
  const omni=await dep("StressOmniRouter");
  const yearn=await dep("Stress4626",sdt.target),euler=await dep("Stress4626",sdt.target);
  const lp=await dep("StressToken","LP","LP",18);
  const curve=await dep("StressCurvePrice",sdt.target,cyvl.target,usdc.target);
  const cfg={
    owner:owner.address,yearnVaults:[yearn.target,ethers.ZeroAddress,ethers.ZeroAddress],sdtYearnIndex:0,
    eulerVaults:[euler.target,ethers.ZeroAddress],sdtEulerIndex:0,crv:crv.target,cyvlSDT:cyvl.target,
    sdt:sdt.target,usdc:usdc.target,omniRouter:omni.target
  };
  const pol=await dep("PoLManager",cfg);
  await pol.setOperator(operator.address,true);
  await pol.setGuardian(guardian.address);
  await pol.configureCurvePool(curve.target,lp.target);
  await pol.setAllocations([0,0,5000,0,0,5000,0]);
  await omni.setRate(sdt.target,cyvl.target,12n*10n**17n);
  await cyvl.mint(omni.target,amount(1_000_000));
  await sdt.mint(pol.target,amount(50_000));
  return {owner,operator,guardian,treasury,attacker,user,sdt,usdc,crv,cyvl,omni,yearn,euler,lp,curve,pol};
}
async function invariants(f,label){
  const sy=await f.yearn.balanceOf(f.pol.target);
  const se=await f.euler.balanceOf(f.pol.target);
  const earnedY=await f.yearn.convertToAssets(sy);
  const earnedE=await f.euler.convertToAssets(se);
  const actualSdt=await f.sdt.balanceOf(f.pol.target);
  const cyvl=await f.cyvl.balanceOf(f.pol.target);
  assert(sy>=0n&&se>=0n&&actualSdt>=0n&&cyvl>=0n,label+" nonnegative positions");
  assert(earnedY<=await f.yearn.totalAssets(),label+" Yearn redeemable assets <= vault assets");
  assert(earnedE<=await f.euler.totalAssets(),label+" Euler redeemable assets <= vault assets");
  return {sy,se,earnedY,earnedE,actualSdt,cyvl,spent:await f.pol.buySpentSDT()};
}

describe("cyvlSDT v49 PoL, buyback, and Vault adversarial lifecycle qualification",function(){
  this.timeout(30*60*1000);
  it("PoL allocates exactly once to fixed Yearn/Euler positions, correctly migrates, and enforces operator and pause permissions",async()=>{
    const f=await polFixture();
    await fail(f.pol.connect(f.attacker).allocateFunds(f.sdt.target,amount(1000)),"attacker cannot allocate");
    await fail(f.pol.connect(f.attacker).setAllocations([0,0,0,0,0,10000,0]),"attacker cannot alter allocation");
    await f.pol.connect(f.operator).allocateFunds(f.sdt.target,amount(16000));
    let st=await invariants(f,"after allocation");
    eq(st.sy,amount(8000),"Yearn 50%");
    eq(st.se,amount(8000),"Euler 50%");
    eq(st.actualSdt,amount(34000),"idle funds conserved");
    const oldYearn=st.sy,oldEuler=st.se;
    await f.pol.connect(f.operator).migrate({source:2,destination:5,amount:amount(300),minDestinationShares:0});
    st=await invariants(f,"after strategy migration");
    eq(st.sy,oldYearn-amount(300),"Yearn moved exactly 300");
    eq(st.se,oldEuler+amount(300),"Euler received migrated 300");
    await f.pol.connect(f.guardian).setPaused(true);
    await fail(f.pol.connect(f.operator).allocateFunds(f.sdt.target,amount(100)),"pause prevents deposits");
    await f.pol.connect(f.operator).redeemVault(0,amount(150),amount(150));
    eq(await f.sdt.balanceOf(f.pol.target),amount(34150),"withdrawals allowed while paused");
    await fail(f.pol.connect(f.guardian).setPaused(false),"guardian cannot unpause");
    await f.pol.setPaused(false);
    await fail(f.pol.setVault(0,f.euler.target),"same vault cannot occupy two slots");
    await fail(f.pol.setAllocations([0,200,4900,0,0,4900,0]),"NFT allocation disabled");
  });

  it("PoL buybacks enforce price-max, Euler 97% liquidity, Yearn fallback, cumulative tier budget, and transaction rollback",async()=>{
    const f=await polFixture();
    await f.pol.allocateFunds(f.sdt.target,amount(16000));
    await f.euler.setBorrowed(amount(5000));
    await f.pol.setBuyLevels([98n*10n**16n,92n*10n**16n,0,0,0],[amount(5000),amount(10000),0,0,0]);
    await f.curve.setPrice(90n*10n**16n);
    const before=await invariants(f,"before slippage attack");
    await f.omni.setRate(f.sdt.target,f.cyvl.target,105n*10n**16n);
    await fail(f.pol.connect(f.attacker).swapForCyvlSDT(amount(9000)),"0.952 SDT/cyvl execution violates 0.92 SDT/cyvl tier");
    const reverted=await invariants(f,"after rollback");
    assert.deepEqual(reverted,before,"invalid execution cannot spend shares or consume budget");
    await f.omni.setRate(f.sdt.target,f.cyvl.target,12n*10n**17n);
    const sharesE=await f.euler.balanceOf(f.pol.target),sharesY=await f.yearn.balanceOf(f.pol.target);
    await f.pol.connect(f.attacker).swapForCyvlSDT(amount(9000));
    let current=await invariants(f,"after discounted buyback");
    eq(current.spent,amount(9000),"cumulative budget counts all spent SDT");
    assert(current.cyvl>=amount(10800),"minimum bought cyvlSDT protected");
    assert(current.se<sharesE && current.sy<sharesY,"Euler-first withdrawals plus Yearn fallback");
    const cash=await f.euler.cash(),borrows=await f.euler.totalBorrows();
    assert(cash*97n>=borrows*3n || cash===0n,"Euler postwithdraw liquidity at least 3/97 borrowed");
    await f.pol.swapForCyvlSDT(amount(3000));
    eq(await f.pol.buySpentSDT(),amount(10000),"remaining tier budget capped at 1k");
    await fail(f.pol.swapForCyvlSDT(amount(1)),"budget exhaustion prevents repeated purchases");
    await fail(f.pol.connect(f.attacker).resetSwapRateAllocationWatermark(),"only owner can reset spend cap");
    await f.pol.resetSwapRateAllocationWatermark();
    eq(await f.pol.buySpentSDT(),0n,"explicit owner reset works");
    await fail(f.pol.setBuyLevels([92n*10n**16n,98n*10n**16n,0,0,0],[amount(5000),amount(10000),0,0,0]),"must reject non-descending levels");
  });

  it("PoL accrues only high-watermark profits and cannot pay fees on principal or on repeated harvest",async()=>{
    const f=await polFixture();
    await f.pol.allocateFunds(f.sdt.target,amount(20000));
    await f.pol.setProfitRecipient(f.treasury.address);
    await f.pol.setProfitFee(1000);
    let balBefore=await f.sdt.balanceOf(f.treasury.address);
    await f.pol.harvest(0x7f);
    eq(await f.sdt.balanceOf(f.treasury.address),balBefore,"no profit before yield");
    await f.sdt.mint(f.yearn.target,amount(1000));
    await f.sdt.mint(f.euler.target,amount(2000));
    await f.pol.harvest(0x7f);
    let profit=(await f.sdt.balanceOf(f.treasury.address))-balBefore;
    assert(profit>0n && profit<=amount(300),"profit fee ≤ 10% of realized yield");
    await f.pol.harvest(0x7f);
    const afterRepeat=(await f.sdt.balanceOf(f.treasury.address))-balBefore;
    assert(afterRepeat>=profit && afterRepeat-profit<=10000n,"repeat harvest may transfer only wei-level rounding dust");
    await f.pol.setProfitFee(2000);
    await f.pol.harvest(0x7f);
    const afterFeeChange=(await f.sdt.balanceOf(f.treasury.address))-balBefore;
    assert(afterFeeChange>=afterRepeat && afterFeeChange-afterRepeat<=10000n,"changing rate cannot apply material fees retroactively");
    await invariants(f,"after fee accrual");
  });

  it("Vault retains exact share ownership under deposits, strategy yield, instant exits, and strict failure/recovery",async()=>{
    const [owner,treasury,alice,bob,attacker]=await ethers.getSigners();
    const token=await dep("StressSDT");
    const vault=await dep("CurveYieldVault","CurveYield Stress Vault","cyv",owner.address,treasury.address,18);
    const strat=await dep("StressVaultStrategy",vault.target,token.target);
    await fail(vault.connect(attacker).setStrategy(strat.target),"attacker cannot bind strategy");
    await vault.setStrategy(strat.target);
    eq(await vault.configurator(),ethers.ZeroAddress,"one-time permanent strategy authorization extinguished");
    await fail(vault.setStrategy(strat.target),"vault cannot change bound strategy");
    for(const u of [alice,bob]) {await token.mint(u.address,amount(100000));await token.connect(u).approve(vault.target,ethers.MaxUint256);}
    await vault.connect(alice).deposit(amount(5000));
    await vault.connect(bob).deposit(amount(5000));
    eq(await vault.totalSupply(),amount(10000),"shares cover deposits exactly");
    eq(await vault.balance(),amount(10000),"vault strategy assets equal deposits");
    await token.mint(strat.target,amount(1000));
    eq(await vault.balance(),amount(11000),"yield increases NAV without minting shares");
    eq(await vault.getPricePerFullShare(),11n*10n**17n,"share PPS becomes 1.1");
    let alicePrior=await token.balanceOf(alice.address);
    await vault.connect(alice).withdraw(amount(5000));
    eq((await token.balanceOf(alice.address))-alicePrior,amount(5500),"Alice's 50% of shares gets 50% of assets");
    eq(await vault.totalSupply(),amount(5000),"shares burnt exactly");
    await strat.setFailStrict(true);
    const pre=await token.balanceOf(bob.address);
    await fail(vault.connect(bob).depositWithStrictHarvest(amount(1000),0),"strict harvest fails close");
    eq(await token.balanceOf(bob.address),pre,"strict deposit failure restores user's principal");
    await vault.connect(bob).deposit(amount(1000));
    eq(await vault.totalSupply(),amount(5000)+amount(1000)*amount(5000)/amount(5500),"best effort deposit still permitted");
    await strat.setFailStrict(false);
    await strat.setFailInstant(true);
    const bobShares=await vault.balanceOf(bob.address);
    await fail(vault.connect(bob).withdraw(bobShares),"failed strategy principal return rolls back share burn");
    eq(await vault.balanceOf(bob.address),bobShares,"share balance safe after failed withdraw");
    await strat.setFailInstant(false);
    await vault.connect(bob).withdraw(bobShares);
    eq(await vault.balanceOf(bob.address),0n,"full withdrawal burns all shares");
    assert((await vault.totalSupply())===0n,"no phantom shares");
    await fail(vault.connect(attacker).proposeFeeReceiver(attacker.address),"fee recipient cannot be stolen");
    await vault.connect(treasury).proposeFeeReceiver(alice.address);
    await fail(vault.connect(bob).acceptFeeReceiver(),"only proposed new receiver can accept");
    await vault.connect(alice).acceptFeeReceiver();
    eq(await vault.feeReceiver(),alice.address,"two-stage fee receiver handover");
  });

  it("Vault timelock rights remain user-bound, cannot replay claims, and early exit only redeems matching request",async()=>{
    const [owner,treasury,alice,bob]=await ethers.getSigners();
    const token=await dep("StressSDT"),vault=await dep("CurveYieldVault","Queued Vault","qv",owner.address,treasury.address,18);
    const strat=await dep("StressVaultStrategy",vault.target,token.target);
    await vault.setStrategy(strat.target);
    for(const u of [alice,bob]){await token.mint(u.address,amount(20000));await token.connect(u).approve(vault.target,ethers.MaxUint256);}
    await vault.connect(alice).deposit(amount(5000));
    await vault.connect(bob).deposit(amount(5000));
    await vault.connect(alice).withdrawWithOptions(amount(2000),false,true);
    const p=await vault.pendingWithdrawal(alice.address);
    eq(p.shares,amount(2000),"queued shares recorded");
    eq(await vault.balanceOf(alice.address),amount(3000),"queued shares already burnt");
    await fail(vault.connect(alice).withdrawWithOptions(amount(2000),false,true),"cannot redeem before unlock");
    await fail(vault.connect(alice).withdrawWithOptions(amount(1000),false,true),"mismatched timelock amount rejected");
    await fail(vault.connect(bob).withdrawWithOptions(amount(9000),false,true),"cannot request greater than held shares");
    const aliceBefore=await token.balanceOf(alice.address);
    await clock(W+2);
    await vault.connect(alice).withdrawWithOptions(amount(2000),false,true);
    eq((await token.balanceOf(alice.address))-aliceBefore,amount(2000),"matured timelock returns exact underlying");
    eq((await vault.pendingWithdrawal(alice.address)).shares,0n,"pending claim deleted");
    const executed=await strat.requests(p.strategyRequestId);
    assert(executed.closed,"completed strategy withdrawal request cannot replay");
    eq(await vault.pendingWithdrawal(alice.address).then(x=>x.shares),0n,"no remaining claim entitlement");
    await vault.connect(bob).withdrawWithOptions(amount(1000),false,true);
    const bobPrior=await token.balanceOf(bob.address);
    await vault.connect(bob).withdrawWithOptions(amount(1000),false,false);
    eq((await token.balanceOf(bob.address))-bobPrior,amount(1000),"pending instant exit returns owed assets");
    eq((await vault.pendingWithdrawal(bob.address)).shares,0n,"pending instant exit cleared");
  });

  it("Vault seeded multiuser accounting traces 200 state transitions, keeping supply, balances and PPS coherent",async()=>{
    const [owner,treasury,alice,bob]=await ethers.getSigners();
    const token=await dep("StressSDT"),vault=await dep("CurveYieldVault","Model Vault","mv",owner.address,treasury.address,18);
    const strat=await dep("StressVaultStrategy",vault.target,token.target);
    await vault.setStrategy(strat.target);
    const actors=[alice,bob];
    for(const a of actors){await token.mint(a.address,amount(1_000_000));await token.connect(a).approve(vault.target,ethers.MaxUint256);}
    let seed=0x1a2b3c4d;
    const rand=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)%n;};
    for(let i=0;i<200;i++){
      const a=actors[rand(2)];
      const action=rand(4);
      if(action===0 || (await vault.balanceOf(a.address))===0n){
        await vault.connect(a).deposit(amount(1+rand(2000)));
      }else if(action===1){
        const held=await vault.balanceOf(a.address);
        await vault.connect(a).withdraw(held/2n||held);
      }else if(action===2){
        await token.mint(strat.target,amount(1+rand(200)));
      }else{
        await vault.connect(a).withdrawAll();
      }
      const stratAssets=await token.balanceOf(strat.target);
      const idle=await token.balanceOf(vault.target);
      const supply=await vault.totalSupply();
      eq(await vault.balance(),stratAssets+idle,"vault NAV conservation seq "+i);
      eq(supply,(await vault.balanceOf(alice.address))+(await vault.balanceOf(bob.address)),"share supply conservation seq "+i);
      assert((await vault.getPricePerFullShare())>0n,"PPS remains positive seq "+i);
      if(i%50===0)console.log("VAULT_STATE_CHECK",JSON.stringify({i,seed,shares:supply.toString(),assets:(stratAssets+idle).toString()}));
    }
    console.log("VAULT_RANDOM_MODEL_COMPLETED 200 actions");
  });
});