"use strict";
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const SAFE = "0x47623C62f281807D615eeb4A2CEee9d97F9D3C49";
const CREATE_CALL = "0x9b35AF71d77eaf8d7e40252370304687390A1A52";
const MULTISEND_CALL_ONLY = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D";
const ZERO = ethers.ZeroAddress;
const PROJECT = process.cwd();
const OUT = path.resolve(process.env.V50_OUTPUT || path.join(PROJECT, "v50-output"));
const CONFIG = JSON.parse(fs.readFileSync("config-safe-mainnet-v50.json","utf8"));
const NAME_BY_KEY = Object.fromEntries([
 ["cyvlSdt","CurveYieldVlSDTToken"],["locker","CurveYieldVlSDTLocker"],
 ["revenueStaking","CurveYieldvlSDTStaking"],["boostMerchant","CurveYieldVlSDTBoostMerchant"],
 ["revenueVault","CurveYieldVault"],["revenueStrategy","CurveYieldRevenueStrategyV7"],
 ["bribeAllocator","VoteMarketSingleGaugeBribeAllocator"],
 ["poLLiquidityBounds","CurvePairOracleBoundsV6"],["poLManager","PoLManager"]
]);
const ICREATE = new ethers.Interface(["function performCreate2(uint256 value,bytes deploymentData,bytes32 salt) returns(address)"]);
const IMULTI = new ethers.Interface(["function multiSend(bytes transactions)"]);
const ADDRS = {};
const BATCH = [];
const ZIP = x=>x || ZERO;

function requireBool(ok,msg){if(!ok)throw Error(msg);}
function addTx(label,to,data){BATCH.push({label,operation:0,to:ethers.getAddress(to),value:"0",data});}
async function deploy(key,args){
 const name = NAME_BY_KEY[key];
 const a=await hre.artifacts.readArtifact(name);
 const artifactFactory=new ethers.ContractFactory(a.abi,a.bytecode);
 const deployTx=await artifactFactory.getDeployTransaction(...args);
 const initcode=deployTx.data;
 requireBool(ethers.isHexString(initcode)&&ethers.dataLength(initcode)>100, "bad initcode "+name);
 const salt=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
  ["address","uint256","string"],[SAFE,50,key]));
 const addr=ethers.getCreate2Address(CREATE_CALL,salt,ethers.keccak256(initcode));
 ADDRS[key]=addr;
 addTx("deploy:"+key,CREATE_CALL,ICREATE.encodeFunctionData("performCreate2",[0,initcode,salt]));
 return addr;
}
async function call(key,method,args){
 const target=ADDRS[key];requireBool(!!target,"contract not deployed: "+key);
 const artifact=await hre.artifacts.readArtifact(NAME_BY_KEY[key]);
 const iface=new ethers.Interface(artifact.abi);
 addTx("configure:"+key+"."+method,target,iface.encodeFunctionData(method,args));
}
async function main(){
 requireBool(CONFIG.version===50 && CONFIG.chainId===1,"wrong chain/config");
 requireBool(CONFIG.finalOwner.toLowerCase()===SAFE.toLowerCase(),"Safe must be constructor owner");
 const c=CONFIG, s=c.stakeDao, p=c.poLManager, a=c.bribeAllocator;
 await deploy("cyvlSdt",[SAFE]);
 await deploy("locker",[SAFE,c.feeReceivers.treasury,s.sdt,s.vlSdt,s.vlBoost,s.router,s.vlSdtFeeDistributorUsdc,s.vlSdtFeeDistributorSdt,s.boostMarketplace,ADDRS.cyvlSdt]);
 await deploy("revenueStaking",[SAFE,c.finalAdmin,c.feeReceivers.treasury,ADDRS.cyvlSdt,s.sdt,c.usdc,ADDRS.locker,s.vlSdt,s.vlSdtFeeDistributorSdt,s.vlSdtFeeDistributorUsdc,c.omniRouter]);
 await deploy("boostMerchant",[SAFE,ADDRS.locker,s.boostMarketplace]);
 await deploy("revenueVault",[c.revenueVault.name,c.revenueVault.symbol,SAFE,c.feeReceivers.treasury,18]);
 await deploy("revenueStrategy",[SAFE,ADDRS.revenueVault,ADDRS.cyvlSdt,s.sdt,ADDRS.revenueStaking,ADDRS.locker,c.omniRouter,c.revenueVault.withdrawalFeeBps,c.revenueVault.performanceFeeBps,c.revenueVault.callFeeBps]);
 await deploy("bribeAllocator",[SAFE,c.omniRouter,a.voteMarket]);
 await deploy("poLLiquidityBounds",[]);
 await deploy("poLManager",[{
  owner:SAFE,yearnVaults:p.yearnVaults.map(ZIP),sdtYearnIndex:p.sdtYearnIndex,
  eulerVaults:p.eulerVaults.map(ZIP),sdtEulerIndex:p.sdtEulerIndex,
  crv:p.crv,cyvlSDT:ADDRS.cyvlSdt,sdt:s.sdt,usdc:c.usdc,omniRouter:c.omniRouter
 }]);
 await call("cyvlSdt","setLocker",[ADDRS.locker]);
 await call("locker","configureSystem",[ADDRS.revenueStaking,ADDRS.boostMerchant]);
 await call("revenueStaking","addRewardToken",[s.sdt]);
 await call("revenueStaking","addRewardToken",[c.usdc]);
 await call("revenueStaking","addRewardToken",[ADDRS.cyvlSdt]);
 await call("revenueStaking","setImmediateWithdrawFeePpm",[c.revenueStakingConfig.immediateWithdrawFeePpm]);
 await call("bribeAllocator","setMinimumReturnWad",[a.minimumReturnWad]);
 if(a.gauge) await call("bribeAllocator","setGauge",[a.gauge]);
 await call("revenueStaking","setLpBribeRevenueShare",[
  c.lockerRevenueDiversions.lpBribeRevenue.shareBps,ADDRS.bribeAllocator
 ]);
 await call("locker","setPoLDepositShare",[
  c.lockerRevenueDiversions.poLDeposit.shareBps,ADDRS.poLManager
 ]);
 await call("poLManager","setLiquidityBounds",[ADDRS.poLLiquidityBounds]);
 await call("poLManager","setCurveSlippageBps",[p.curveSlippageBps]);
 await call("poLManager","setProfitRecipient",[ADDRS.locker]);
 if(p.curvePool)await call("poLManager","configureCurvePool",[p.curvePool,p.curveLp]);
 if(p.curveGauge)await call("poLManager","configureCurveGauge",[p.curveGauge]);
 if(p.uniNftManager)await call("poLManager","configureUniswapPosition",[p.uniNftManager,p.uniTokenId]);
 if(a.gauge)await call("bribeAllocator","setGauge",[a.gauge]);
 if(c.boostEconomics.postListingIfNoAcceptableOffer){
  await call("boostMerchant","setPostListingIfNoAcceptableOffer",[true]);
 }
 const rates=c.boostEconomics.merchantSaleRates;
 if(rates.postPricePerWeek && rates.minimumFillPricePerWeek && rates.sdtWeiPerUsdc){
  await call("boostMerchant","setSaleRates",[rates.postPricePerWeek,rates.minimumFillPricePerWeek,rates.sdtWeiPerUsdc]);
 }
 await call("revenueVault","setStrategy",[ADDRS.revenueStrategy]);
 await call("locker","setMarketplaceOperator",[true]);
 const txBytes=ethers.concat(BATCH.map(t=>ethers.solidityPacked(
 ["uint8","address","uint256","uint256","bytes"],
 [0,t.to,0,ethers.dataLength(t.data),t.data]
 )));
 const multisendData=IMULTI.encodeFunctionData("multiSend",[txBytes]);
 const manifest={
   version:50,chainId:1,safeAddress:SAFE,operation:1,to:MULTISEND_CALL_ONLY,
   valueWei:"0",data:multisendData,derivedAddresses:ADDRS,
   createCall:CREATE_CALL,innerTransactions:BATCH,
   transactionCount:BATCH.length,deployCount:9,
   keccak256:ethers.keccak256(multisendData),
   totalCalldataBytes:ethers.dataLength(multisendData),
   intentionallyDeferred:{
    stableSwapPool:"not yet deployed",curvePool:p.curvePool,curveGauge:p.curveGauge,
    uniNftManager:p.uniNftManager,yearnVaults:p.yearnVaults,eulerVaults:p.eulerVaults,
    merchantSaleRates:rates,bribeGauge:a.gauge
   }
 };
 fs.mkdirSync(OUT,{recursive:true});
 fs.writeFileSync(path.join(OUT,"Safe-CREATE2-MultiSend-v50.json"),JSON.stringify(manifest,null,2)+"\n");
 fs.writeFileSync(path.join(OUT,"Deployment-Addresses-v50.json"),JSON.stringify(ADDRS,null,2)+"\n");
 fs.writeFileSync(path.join(OUT,"Batch-Overview-v50.json"),JSON.stringify({
  version:50,safe:SAFE,to:MULTISEND_CALL_ONLY,hash:manifest.keccak256,
  transactions:manifest.transactionCount,totalCalldataBytes:manifest.totalCalldataBytes,
  addresses:ADDRS,labels:BATCH.map(t=>t.label)
 },null,2)+"\n");
 console.log("V50_BATCH_BUILT",JSON.stringify({transactionCount:manifest.transactionCount,deployCount:9,byteLength:manifest.totalCalldataBytes,addresses:ADDRS,batchHash:manifest.keccak256}));
}
main().catch(e=>{console.error("V50_BATCH_BUILD_FAILED",e);process.exitCode=1;});
