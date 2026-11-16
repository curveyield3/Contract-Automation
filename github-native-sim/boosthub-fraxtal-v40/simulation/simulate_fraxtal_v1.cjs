/*
 * Production-src-bound Fraxtal FORK-ONLY accounting simulation. Absolutely no live chain broadcast.
 * Fork-only extras: mock valuation for unconfigured USD oracle routes, impersonation to provision live tokens.
 * All production contracts: exact committed BoostHub v40 + pinned unchanged morpho-org/morpho-blue + v3 overlay.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const ethers = require(path.resolve(__dirname, '../dependencies/node_modules/ethers'));
const rpc = new ethers.JsonRpcProvider(process.env.FORK_RPC || 'http://127.0.0.1:8545',252,{staticNetwork:true});
const here=path.resolve(__dirname,'..');
const report={version:'v1',kind:'Fraxtal stateful fork simulation',chainId:252,forkOnly:true,productionDeployments:false,simulatedOnly:true,steps:[],snapshots:[],contracts:{},markets:{},errors:[],checks:[]};
const a={
HUB:'0x40f7085841034f752F17592875703EB5032f2B42',
ROUTER:'0xB730db2de60877961dd90D1FbF37830F64616DF4',
SDFXS:'0x1AEe2382e05Dc68BDfC472F1E46d570feCca5814',
WFRAX:'0xFc00000000000000000000000000000000000002',
FRXUSD:'0xfc00000000000000000000000000000000000001',
SFRXUSD:'0xfc00000000000000000000000000000000000008',
DEPLOYER:'0x064256591313eEb86a84A5CbCc4C6460791B96DD',
ADMIN:'0x47623C62f281807D615eeb4A2CEee9d97F9D3C49',
SDFXS_WHALE:'0x9f2B20A772246960810045905B7daccf960eE288',
FRXUSD_WHALE:'0x2aa2839520272fdcd7681d53f0523f65416440bb',
SFRXUSD_WHALE:'0xbfc4d34db83553725ec6c768da71d2d9c1456b55',
BORROWER:'0x000000000000000000000000000000000000b0b1',
LENDER:'0x0000000000000000000000000000000000001ead',
BURN:'0x000000000000000000000000000000000000dEaD'
};
const ERC20_ABI=['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns(bool)','function approve(address,uint256) returns(bool)','function decimals() view returns(uint8)','function symbol() view returns(string)'];
const WFRAX_ABI=[...ERC20_ABI,'function deposit() payable'];
const HUB_ABI=['function owner() view returns(address)','function isApprovedDepositor(uint256,address) view returns(bool)','function setApprovedDepositors(uint256,address[],bool[],bool)'];
const ROUTER_ABI=['function price_oracle(address,address) view returns(uint256)'];
function forgeArtifact(fname,root=path.join(here,'build/forge')) { const p=path.join(root,fname);let x=JSON.parse(fs.readFileSync(p));return {abi:x.abi,bytecode:x.bytecode.object}; }
function artifact(name) {return forgeArtifact(`${name}.sol/${name}.json`);}
function morphoArtifact(name) { return forgeArtifact(`${name}.sol/${name}.json`,path.join(here,'.upstream-morpho/out')); }
function jot(action,details={}){report.steps.push({action,details});console.log('STEP', action, JSON.stringify(details,(k,v)=>typeof v==='bigint'?v.toString():v));}
function chk(label,cond,details={}){report.checks.push({label,pass:!!cond,details});if(!cond)throw new Error('ACCOUNTING_CHECK_FAILED '+label+' '+JSON.stringify(details));}
async function tx(m,label){console.log('TX_START',label);const sent=await m;console.log('TX_SENT',label,sent.hash);const receipt=await sent.wait();chk('transaction_success_'+label,receipt.status===1);jot(label,{tx:receipt.hash,gasUsed:receipt.gasUsed.toString()});return receipt;}
function fmt(x){return ethers.formatUnits(x,18)}
async function impersonate(address,gasFra=300n*10n**18n){ await rpc.send('anvil_impersonateAccount',[address]);await rpc.send('anvil_setBalance',[address,ethers.toBeHex(gasFra)]);return rpc.getSigner(address); }
async function jump(seconds,label){await rpc.send('evm_increaseTime',[seconds]);await rpc.send('evm_mine',[]);jot('time_jump_'+label,{seconds,block:await rpc.getBlockNumber()});}
async function deploy(name,abi,bytecode,signer,...args){console.log('DEPLOY_START',name);const f=new ethers.ContractFactory(abi,bytecode,signer);const contract=await f.deploy(...args,{gasLimit:12500000});console.log('DEPLOY_SENT',name,contract.deploymentTransaction()?.hash);await contract.waitForDeployment();jot('deployed_'+name,{address:await contract.getAddress(),tx:contract.deploymentTransaction()?.hash});return contract;}
async function state(tag,morpho,markets,loanTokens,vault,strategy,irm){console.log('STATE_START',tag);const s={tag,block:await rpc.getBlockNumber(),vaultPps:(await vault.getPricePerFullShare()).toString(),vaultApr:(await vault.getAPR()).toString(),vaultShares:(await vault.totalSupply()).toString(),lockedProfit:(await strategy.lockedProfit()).toString(),markets:{}};
 for(const key of Object.keys(markets)) {const p=markets[key], id=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['tuple(address,address,address,address,uint256)'],[p]));const m=await morpho.market(id);const pos=await morpho.position(id,a.ADMIN);const liquid=await loanTokens[key].balanceOf(await morpho.getAddress());const supply=BigInt(m.totalSupplyAssets),borrow=BigInt(m.totalBorrowAssets);const delta=supply-borrow;chk('liquidity_matches_'+key+'_'+tag, (delta>liquid?delta-liquid:liquid-delta) <= 3n,{delta:delta.toString(),liquid:liquid.toString()});s.markets[key]={id,loan:p[0],supplyAssets:supply.toString(),borrowAssets:borrow.toString(),cash:liquid.toString(),utilWad:supply===0n?'0':(borrow*10n**18n/supply).toString(),feeShares:BigInt(pos.supplyShares).toString(),loanFee:BigInt(m.fee).toString(),annualBorrowAprWad:(BigInt(await irm.borrowRateView(p,Array.from(m)))*BigInt(365*24*60*60)).toString()};}
 report.snapshots.push(s); console.log('ACCOUNTING_STATE',JSON.stringify(s));return s; }
(async()=>{
 await rpc.getBlockNumber(); const chain=(await rpc.getNetwork()).chainId;chk('chain_252',chain===252n);
 const deployer=await impersonate(a.DEPLOYER), admin=await impersonate(a.ADMIN), user=await impersonate(a.BORROWER), lender=await impersonate(a.LENDER);
 const hub=new ethers.Contract(a.HUB,HUB_ABI,deployer);
 chk('hub_owner_matches', (await hub.owner()).toLowerCase()===a.DEPLOYER.toLowerCase());
 const stakingSrc=JSON.parse(fs.readFileSync(path.join(here,'artifacts/staking.json')));
 const rewards=[a.WFRAX,...Array(7).fill(ethers.ZeroAddress)];
 const staking=await deploy('staking',stakingSrc.abi,stakingSrc.bytecode,deployer,a.SDFXS,a.HUB,0,a.ADMIN,rewards,a.ADMIN,150);
 const stakeAddr=await staking.getAddress(); report.contracts.staking=stakeAddr;
 await tx(hub.setApprovedDepositors(0,[stakeAddr],[true],false),'hub_approve_new_staking');
 chk('new_depositor_approved',await hub.isApprovedDepositor(0,stakeAddr));
 chk('existing_depositor_preserved',await hub.isApprovedDepositor(0,'0xfe786bef58ce39fb4e6154c7c38275a4a71bf922'));
 chk('staking_admin', (await staking.admin()).toLowerCase()===a.ADMIN.toLowerCase());
 chk('staking_fee_receiver', (await staking.fee_receiver()).toLowerCase()===a.ADMIN.toLowerCase());
 chk('staking_smoothing', (await staking.reward_smoothing_units())===150n);
 const stratArt=artifact('StrategyConvexBoostHubStakingV5'),vaultArt=artifact('BeefyVaultV7FixedV2');
 const n=await rpc.getTransactionCount(a.DEPLOYER,'pending');const predictedVault=ethers.getCreateAddress({from:a.DEPLOYER,nonce:n+1});
 const strategy=await deploy('strategy',stratArt.abi,stratArt.bytecode,deployer,stakeAddr,[a.SDFXS,predictedVault,a.ROUTER,a.ADMIN],[300,300,9700],86400,0);
 const vault=await deploy('vault',vaultArt.abi,vaultArt.bytecode,deployer,await strategy.getAddress(),'CurveYield sdFXS','cysdFXS',30,a.ADMIN);
 const vaultAddr=await vault.getAddress();report.contracts.vault=vaultAddr;report.contracts.strategy=await strategy.getAddress();
 chk('nonce_predicted_vault',vaultAddr.toLowerCase()===predictedVault.toLowerCase());
 chk('strategy_vault_bound',(await strategy.vault()).toLowerCase()===vaultAddr.toLowerCase());
 chk('vault_staking_bound',(await strategy.staking()).toLowerCase()===stakeAddr.toLowerCase());
 chk('performance_fee_3pct',await strategy.totalPerformanceFeeBps()===300n);
 chk('caller_share_3pct',await strategy.callShareBps()===300n);
 chk('withdrawal_tax_0p3pct',await vault.withdrawalFeeBps()===30n);
 chk('profit_unlock_24h',await strategy.lockDuration()===86400n);
 await tx(vault.connect(deployer).transferOwnership(a.ADMIN),'vault_ownership_to_admin');
 chk('vault_owner',(await vault.owner()).toLowerCase()===a.ADMIN.toLowerCase());
 const sdFXS=new ethers.Contract(a.SDFXS,ERC20_ABI,await impersonate(a.SDFXS_WHALE));
 const wfrax=new ethers.Contract(a.WFRAX,WFRAX_ABI,lender);
 const frxUsd=new ethers.Contract(a.FRXUSD,ERC20_ABI,await impersonate(a.FRXUSD_WHALE));
 const sfrxUsd=new ethers.Contract(a.SFRXUSD,ERC20_ABI,await impersonate(a.SFRXUSD_WHALE));
 await tx(sdFXS.transfer(a.BORROWER,ethers.parseEther('40')),'fork_fund_sdFXS_from_live_holder');
 await tx(frxUsd.transfer(a.LENDER,ethers.parseEther('8')),'fork_fund_frxUSD_from_live_holder');
 await tx(sfrxUsd.transfer(a.LENDER,ethers.parseEther('8')),'fork_fund_sfrxUSD_from_live_holder');
 await tx(wfrax.deposit({value:ethers.parseEther('8')}),'wrap_WFRAX_live_contract');
 const sdUser=sdFXS.connect(user);
 await tx(sdUser.approve(vaultAddr,ethers.MaxUint256),'approve_sdFXS_vault');
 await tx(vault.connect(user).deposit(ethers.parseEther('0.01')),'vault_deposit_initial_burn');
 await tx(vault.connect(user).transfer(a.BURN,ethers.parseEther('0.01')),'burned_shares_lock');
 await tx(vault.connect(user).deposit(ethers.parseEther('35')),'vault_deposit_main');
 const vaultOwned=await vault.balanceOf(a.BORROWER);chk('vault_shares_at_least_30',vaultOwned>=ethers.parseEther('30'));
 await tx(vault.connect(user).checkpointAPR(),'apr_checkpoint_initial');
 const morphoA=morphoArtifact('Morpho'),irmA=morphoArtifact('CollateralYieldIRM'),oracleA=morphoArtifact('OmniRouterBeefyShareOracle'),mockA=artifact('ForkOnlyFixedOracle');
 const morpho=await deploy('MorphoBlue',morphoA.abi,morphoA.bytecode,deployer,a.DEPLOYER);report.contracts.morpho=await morpho.getAddress();
 const irm=await deploy('CollateralYieldIRM',irmA.abi,irmA.bytecode,deployer,await morpho.getAddress(),a.DEPLOYER,vaultAddr,ethers.parseEther('0.12'),ethers.parseEther('1'),ethers.parseEther('2'));report.contracts.irm=await irm.getAddress();
 const oracleW=await deploy('WFRAX_real_router_oracle',oracleA.abi,oracleA.bytecode,deployer,vaultAddr,a.ROUTER,a.WFRAX);
 const oracleF=await deploy('frxUSD_real_router_adapter',oracleA.abi,oracleA.bytecode,deployer,vaultAddr,a.ROUTER,a.FRXUSD);
 const oracleS=await deploy('sfrxUSD_real_router_adapter',oracleA.abi,oracleA.bytecode,deployer,vaultAddr,a.ROUTER,a.SFRXUSD);
 const realWPrice=await oracleW.price();chk('real_WFRAX_oracle_nonzero',realWPrice>0n);
 for(const [name,contract] of [['frxUSD',oracleF],['sfrxUSD',oracleS]]) {let priceOk=false;try{priceOk=(await contract.price())>0n}catch(e){}chk('real_'+name+'_route_missing',!priceOk);}
 report.productionRouteStatus={WFRAX:'LIVE_REAL_ORACLE_READY',frxUSD:'MISSING_ROUTE_FIXTURE_ONLY',sfrxUSD:'MISSING_ROUTE_FIXTURE_ONLY'};
 const mockF=await deploy('fork_only_frxUSD_oracle',mockA.abi,mockA.bytecode,deployer,realWPrice);
 const mockS=await deploy('fork_only_sfrxUSD_oracle',mockA.abi,mockA.bytecode,deployer,realWPrice);
 report.contracts.oracles={WFRAX:await oracleW.getAddress(),frxUSD:await mockF.getAddress(),sfrxUSD:await mockS.getAddress()};
 const lltv=ethers.parseEther('0.8');const marketList=[['WFRAX',a.WFRAX,await oracleW.getAddress(),[ethers.parseEther('0.3'),ethers.parseEther('0.5'),ethers.parseEther('1.1'),ethers.parseEther('0.9'),0n]],['frxUSD',a.FRXUSD,await mockF.getAddress(),[ethers.parseEther('0.2'),ethers.parseEther('0.4'),ethers.parseEther('1.2'),ethers.parseEther('0.88'),0n]],['sfrxUSD',a.SFRXUSD,await mockS.getAddress(),[ethers.parseEther('0.2'),ethers.parseEther('0.4'),ethers.parseEther('1.2'),ethers.parseEther('0.88'),ethers.parseEther('0.04')]]];
 const markets={};
 await tx(morpho.enableIrm(await irm.getAddress()),'morpho_enable_irm');
 await tx(morpho.enableLltv(lltv),'morpho_enable_simulation_lltv_80pct');
 await tx(morpho.setFeeRecipient(a.ADMIN),'morpho_fee_recipient');
 for(const [label,loan,oracle,curve] of marketList){const mp=[loan,vaultAddr,oracle,await irm.getAddress(),lltv];markets[label]=mp;
   await tx(irm.setCurve(mp,curve),'configure_'+label+'_market_curve');
   await tx(morpho.createMarket(mp),'create_'+label+'_morpho_market');
   await tx(morpho.setFee(mp,ethers.parseEther('0.15')),'set_15pct_'+label+'_fee');
   const id=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['tuple(address,address,address,address,uint256)'],[mp]));
   const m=await morpho.market(id);chk(label+'_fee_is_15pct',m.fee===ethers.parseEther('0.15'));
   const c=await irm.curves(id);chk(label+'_curve_matches',c.minimumMultiplier===curve[0]&&c.targetMultiplier===curve[1]&&c.maximumMultiplier===curve[2]&&c.targetUtilization===curve[3]&&c.aprRebate===curve[4]);
   report.markets[label]={id,mp,curve:curve.map(x=>x.toString()),forkOnlyPriceFeed:label!=='WFRAX'};
 }
 await tx(irm.transferOwnership(a.ADMIN),'irm_final_owner');
 await tx(morpho.setOwner(a.ADMIN),'morpho_final_owner');
 chk('irm_owner',(await irm.owner()).toLowerCase()===a.ADMIN.toLowerCase());
 chk('morpho_owner',(await morpho.owner()).toLowerCase()===a.ADMIN.toLowerCase());
 chk('morpho_fee_recipient',(await morpho.feeRecipient()).toLowerCase()===a.ADMIN.toLowerCase());
 const loanTokens={WFRAX:wfrax,frxUSD:frxUsd.connect(lender),sfrxUSD:sfrxUsd.connect(lender)};
 for(const label of Object.keys(markets)){
   const token=loanTokens[label],p=markets[label];
   await tx(token.approve(await morpho.getAddress(),ethers.MaxUint256),'loan_approve_'+label);
   await tx(morpho.connect(lender).supply(p,ethers.parseEther('4'),0,a.LENDER,'0x'),'loan_supply_'+label);
 }
 await tx(vault.connect(user).approve(await morpho.getAddress(),ethers.MaxUint256),'collateral_approval');
 for(const label of Object.keys(markets)) await tx(morpho.connect(user).supplyCollateral(markets[label],ethers.parseEther('10'),a.BORROWER,'0x'),'supplyCollateral_'+label);
 await state('supplied_before_borrow',morpho,markets,loanTokens,vault,strategy,irm);
 for(const label of Object.keys(markets)){
   const p=markets[label];
   const borrowAmount=label==='WFRAX'?ethers.parseEther('3.6'):ethers.parseEther('3.52');
   await tx(morpho.connect(user).borrow(p,borrowAmount,0,a.BORROWER,a.BORROWER),'borrow_'+label);
 }
 const postBorrow=await state('borrowed_near_targets',morpho,markets,loanTokens,vault,strategy,irm);
 for(const label of Object.keys(markets)){const u=BigInt(postBorrow.markets[label].utilWad);chk('utilization_near_'+label+'_target', u>=ethers.parseEther('0.84')&&u<=ethers.parseEther('0.94'));}
 await jump(4*3600,'apr_4hours');await tx(vault.connect(user).checkpointAPR(),'checkpoint_after_4h');
 await jump(4*3600,'apr_8hours');await tx(vault.connect(user).checkpointAPR(),'checkpoint_after_8h');
 await jump(4*3600,'apr_12hours');await tx(vault.connect(user).checkpointAPR(),'checkpoint_after_12h');
 await jump(4*3600,'apr_16hours');await tx(vault.connect(user).checkpointAPR(),'checkpoint_after_16h');
 await tx(strategy.connect(user).harvest(),'harvest_after_16h');
 await tx(vault.connect(user).withdraw(ethers.parseEther('1')),'vault_withdraw_tax_0p3pct');
 const lockedNow=await strategy.lockedProfit();chk('withdrawal_tax_profit_locked',lockedNow>0n,{locked:lockedNow.toString()});
 await jump(24*3600,'day_after_harvest');
 for(const label of Object.keys(markets))await tx(morpho.accrueInterest(markets[label]),'interest_accrue_'+label+'_day1');
 const day1=await state('after_day1_interest_and_harvest',morpho,markets,loanTokens,vault,strategy,irm);
 for(const label of Object.keys(markets))chk('borrow_interest_positive_'+label,BigInt(day1.markets[label].borrowAssets)> (label==='WFRAX'?ethers.parseEther('3.6'):ethers.parseEther('3.52')));
 for(const label of Object.keys(markets))chk('morpho_15pct_fee_shares_minted_'+label, BigInt(day1.markets[label].feeShares)>0n);
 await jump(7*24*3600,'week_after_harvest');
 await tx(strategy.connect(user).harvest(),'harvest_after_week');
 for(const label of Object.keys(markets)) await tx(morpho.accrueInterest(markets[label]),'interest_accrue_week_'+label);
 await state('after_week_interest_and_harvest',morpho,markets,loanTokens,vault,strategy,irm);
 for(const label of Object.keys(markets)){
   const p=markets[label];
   await tx(loanTokens[label].connect(user).approve(await morpho.getAddress(),ethers.MaxUint256),'repay_approval_'+label);
   await tx(morpho.connect(user).repay(p,ethers.parseEther('0.5'),0,a.BORROWER,'0x'),'partial_repay_'+label);
   await tx(morpho.connect(lender).withdraw(p,ethers.parseEther('0.1'),0,a.LENDER,a.LENDER),'lender_withdraw_'+label);
   await tx(morpho.connect(user).withdrawCollateral(p,ethers.parseEther('0.5'),a.BORROWER,a.BORROWER),'collateral_withdraw_'+label);
 }
 await state('final_after_repay_lender_withdraw_collateral_withdraw',morpho,markets,loanTokens,vault,strategy,irm);
 jot('SIMULATION_COMPLETE',{totalChecks:report.checks.length,totalSnapshots:report.snapshots.length,transactions:report.steps.filter(x=>x.details?.tx).length});
})().catch(e=>{report.errors.push({message:e.message,stack:e.stack});console.error('FAIL',e.stack??e);process.exitCode=1}).finally(()=>{try{const out=path.join(here,'sim-results','accounting_v1.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,(key,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');console.log('REPORT',out)}catch(e){console.error(e)}});
