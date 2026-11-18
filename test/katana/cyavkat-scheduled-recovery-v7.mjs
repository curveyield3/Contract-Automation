// Katana cyavKAT scheduled-withdrawal rescue v7: no public chain writes.
// Executes queued fee-free request in block N on local Anvil, mines block N+1,
// replays an independently verified Safe rescue across state checkpoints,
// then executes the exact rescue Safe MultiSend atomically on a restored fork.
import {writeFile,readFile} from "node:fs/promises";
import {JsonRpcProvider,Contract,ContractFactory,Interface,AbiCoder,MaxUint256,getCreate2Address,keccak256,toUtf8Bytes,formatUnits,parseUnits} from "ethers";
const A={safe:"0x47623C62f281807D615eeb4A2CEee9d97F9D3C49",owner:"0x11b78837cadc8e894f1c6e13fa9f3a085a75fa35",vault:"0xed83daf48429cfb2c650fd721b9241e180fd4548",manager:"0x59b340eab30afe0cecd51c609d3190e8c75c40ae",template:"0x7a0928c0e99e50b2d51c8db7dc400123982687cf",access:"0xd7f408f203c5c6a76c9c55c9f6b015929f151faa",controller:"0xbfdf2d2653859b66a8a15e1c85f6d6cdee89698f",swap:"0x1fb8b83baf40c90f0b450a3fd7a8b2e97ab2a3ff",flash:"0x84927bff2a35a543ed94a7d96d5ccd162a167947",borrow:"0x08095aef82a5b33b5b478d254052618a5366cd78",collateral:"0xda9a20690a185daa3b0fd198c6232234835b6929",morpho:"0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc",strategy:"0x79e88dd967ef9a31046455db94b1e487329ed705",rewardsManager:"0xa77470b748a8fb50056ca3c07375dc76aa3a72cb",avkat:"0x7231dbacdfc968e07656d12389ab20de82fbfceb",kat:"0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d",oldBurn:"0x44d368e85f419c59ac01b7270d234d8bf19df36e",feeShares:"0x70a2f848e21c912d660fe2263e5be538268a41ec",handler:"0xc1113f752d60af4f49840cac1c7bd30736dbb20e",createCall:"0x9b35Af71d77eaf8d7e40252370304687390A1A52",ms:"0x40a2accbd92bca938b02010e17a5b8929b49130d",market:"0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9"};
const provider=new JsonRpcProvider("http://127.0.0.1:8545",747474,{staticNetwork:true});
const interfaces={
 access:new Interface(["function grantRole(uint64,address,uint32)","function revokeRole(uint64,address)","function hasRole(uint64,address) view returns(bool,uint32)","function getTargetFunctionRole(address,bytes4) view returns(uint64)","function getRoleAdmin(uint64) view returns(uint64)","function getRoleGrantDelay(uint64) view returns(uint32)"]),
 manager:new Interface(["function getRequestFee() view returns(uint256)","function updateRequestFee(uint256)","function requestShares(uint256)","function requestInfo(address) view returns((uint256 shares,uint256 endWithdrawWindowTimestamp,bool canWithdraw,uint256 withdrawWindowInSeconds,uint256 refundableFeeShares))","function earnedFeeShares() view returns(uint256)","function pruneExpiredRequests(uint256) returns(uint256,bool)","function setDependencies(address,address,address,address)","function getWithdrawFee() view returns(uint256)","function reservedSharesOf(address) view returns(uint256)","function getSharesToRelease() view returns(uint256)"]),
 vault:new Interface(["function balanceOf(address) view returns(uint256)","function totalAssets() view returns(uint256)","function totalSupply() view returns(uint256)","function isFuseSupported(address) view returns(bool)","function addFuses(address[])","function updateCallbackHandler(address,address,bytes4)","function execute((address fuse,bytes data)[])","function redeemFromRequest(uint256,address,address) returns(uint256)","function previewRedeem(uint256) view returns(uint256)"]),
 safe:new Interface(["function nonce() view returns(uint256)","function getOwners() view returns(address[])","function getThreshold() view returns(uint256)","function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)","function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)"]),
 flash:new Interface(["function enter((address token,uint256 amount,bytes callbackData))"]),
 borrow:new Interface(["function exit((bytes32 id,uint256 assets,uint256 shares))"]),
 collateral:new Interface(["function exit((bytes32 id,uint256 amount))"]),
 swap:new Interface(["function enter((address tokenIn,address tokenOut,uint256 input,uint256 minOutput))"]),
 controller:new Interface(["function fulfillFor(address,uint256,uint256)"]),
 create:new Interface(["function performCreate2(uint256,bytes,bytes32) returns(address)"]),
 multisend:new Interface(["function multiSend(bytes)"])
};
const con=(addr,abi)=>new Contract(addr,abi,provider);
const ac=con(A.access,interfaces.access),mg=con(A.manager,interfaces.manager),v=con(A.vault,interfaces.vault),safe=con(A.safe,interfaces.safe);
const av=con(A.avkat,["function balanceOf(address) view returns(uint256)"]),kat=con(A.kat,["function balanceOf(address) view returns(uint256)"]);
const st=con(A.strategy,["function morphoSnapshot() view returns((uint256 collateralAvkat,uint256 debtKat,uint256 collateralValueKat,uint256 ltvBps,uint256 netEquityAvkat))"]);
const mor=con(A.morpho,["function position(bytes32,address) view returns(uint256,uint128,uint128)"]);
const router=con(A.swap,["function requiredInputView(address,address,uint256,uint256) view returns(uint256)"]);
const oracle=con("0xc5d4f6f7b1f5dec7ec191d3612388f95f5f7f47c",["function price() view returns(uint256)"]);
const f=n=>formatUnits(n,18),fs=n=>formatUnits(n,20),ensure=(x,s)=>{if(!x)throw Error("ASSERTION: "+s);};
const report={version:"v7",status:"FAIL",chainId:747474,mode:"PINNED_LOCAL_KATANA_ANVIL_ONLY",proposalHash1:"0xcf3361b9dd99fefcaf1d1a8ba67f7056c6446bfceb23234d5705268ee0ad25b3",snapshots:[],steps:[],errors:[],proposal2:null};
const step=(n,x)=>{report.steps.push({n,...x});console.log("CHECKPOINT",n,JSON.stringify(x));};
const pack=(to,data)=>"00"+to.slice(2).toLowerCase()+"0".repeat(64)+BigInt((data.length-2)/2).toString(16).padStart(64,"0")+data.slice(2);
const msdata=calls=>interfaces.multisend.encodeFunctionData("multiSend",["0x"+calls.map(c=>pack(c.to,c.data)).join("")]);
const encode=(to,sig,args)=>({to,data:interfaces[sig[0]].encodeFunctionData(sig[1],args)});
const ZERO="0x0000000000000000000000000000000000000000";
async function state(){
 const [position,snapshot,idle,katIdle,supply,assets,shares,mshares,earned,fee,request,safeAsset,nonce,released,reserved]=await Promise.all([
 mor.position(A.market,A.vault),st.morphoSnapshot(),av.balanceOf(A.vault),kat.balanceOf(A.vault),
 v.totalSupply(),v.totalAssets(),v.balanceOf(A.safe),v.balanceOf(A.manager),mg.earnedFeeShares(),mg.getRequestFee(),
 mg.requestInfo(A.safe),av.balanceOf(A.safe),safe.nonce(),mg.getSharesToRelease(),mg.reservedSharesOf(A.safe)
 ]);
 return {collateral:String(position[2]),borrowShares:String(position[1]),debt:String(snapshot.debtKat),ltvBps:String(snapshot.ltvBps),
  netEquity:String(snapshot.netEquityAvkat),idleAvkat:String(idle),idleKat:String(katIdle),supply:String(supply),assets:String(assets),
  safeShares:String(shares),managerShares:String(mshares),managerEarned:String(earned),requestFee:String(fee),
  requestShares:String(request.shares),requestRefundableFee:String(request.refundableFeeShares),requestCanWithdraw:request.canWithdraw,
  safeAsset:String(safeAsset),nonce:String(nonce),sharesToRelease:String(released),reserved:String(reserved),
  human:{morphoCollateral:f(position[2]),morphoDebt:f(snapshot.debtKat),morphoEquity:f(snapshot.netEquityAvkat),
   ltvPercent:Number(snapshot.ltvBps)/100,idleAvkat:f(idle),safeAvkat:f(safeAsset),
   vaultAssets:f(assets),safeShares:fs(shares),managerEarnedShares:fs(earned)}};
}
async function txAs(signer,call){
 const tx=await signer.sendTransaction({to:call.to,data:call.data,gasLimit:20000000n});
 const receipt=await tx.wait();
 ensure(receipt.status===1,"reverted "+call.name);
 return {hash:tx.hash,gas:String(receipt.gasUsed)};
}
async function execSafe(calls,nonce,ownerSigner){
 const data=msdata(calls);
 const hash=await safe.getTransactionHash(A.ms,0n,data,1,0n,0n,0n,ZERO,ZERO,nonce);
 const sig="0x"+A.owner.slice(2).toLowerCase().padStart(64,"0")+"0".repeat(64)+"01";
 const args=[A.ms,0n,data,1,0n,0n,0n,ZERO,ZERO,sig];
 const signed=safe.connect(ownerSigner);
 ensure(await signed.execTransaction.staticCall(...args),"Safe prevalidated EIP712 call failure");
 const gas=await signed.execTransaction.estimateGas(...args);
 const transaction=await signed.execTransaction(...args,{gasLimit:gas*13n/10n+250000n});
 const receipt=await transaction.wait();
 ensure(receipt.status===1,"Safe execTransaction reverted");
 return {hash,txHash:transaction.hash,gasUsed:String(receipt.gasUsed)};
}
try{
 ensure(String(await provider.send("web3_clientVersion",[])).toLowerCase().includes("anvil"),"Not local Anvil");
 ensure((await provider.getNetwork()).chainId===747474n,"Wrong chain");
 const block=await provider.getBlock("latest");report.fork={blockNumber:block.number,hash:block.hash,timestamp:block.timestamp};
 const before=await state();report.before=before;
 await provider.send("anvil_impersonateAccount",[A.owner]);
 await provider.send("anvil_setBalance",[A.owner,"0x3635c9adc5dea00000"]);
 const ownerSigner=await provider.getSigner(A.owner);
 const safeShares=BigInt(before.safeShares),nonce=BigInt(before.nonce);
 ensure(safeShares>0n,"No Safe shares");
 ensure((await safe.getThreshold())===1n,"Unexpected owner threshold");
 ensure((await safe.getOwners()).some(a=>a.toLowerCase()===A.owner.toLowerCase()),"Owner missing");
 if(BigInt(before.requestShares)===0n){
   ensure(nonce===57n,"Pending Safe request nonce mismatch");
   ensure((await ac.hasRole(100n,A.safe))[0],"role100 absent");
   const first=[
     {to:A.access,data:interfaces.access.encodeFunctionData("grantRole",[901n,A.safe,0])},
     {to:A.manager,data:interfaces.manager.encodeFunctionData("updateRequestFee",[0n])},
     {to:A.manager,data:interfaces.manager.encodeFunctionData("requestShares",[safeShares])},
     {to:A.access,data:interfaces.access.encodeFunctionData("revokeRole",[901n,A.safe])}
   ];
   const receipt=await execSafe(first,nonce,ownerSigner);
   ensure(receipt.hash.toLowerCase()===report.proposalHash1,"Request batch hash mismatch");
   step("01_FIRST_QUEUED_SAFE_REQUEST_FORK_EXECUTION",{receipt,safeShares:fs(safeShares)});
 }else{
   ensure(BigInt(before.requestShares)===safeShares,"Existing request differs from Safe shares");
   ensure(BigInt(before.requestFee)===0n,"Existing request fee not zero");
   step("01_FIRST_SAFE_REQUEST_ALREADY_ON_CHAIN",{nonce:String(nonce),safeShares:fs(safeShares)});
 }
 await provider.send("evm_increaseTime",[120]);await provider.send("evm_mine",[]);
 const requested=await state();
 ensure(BigInt(requested.requestShares)===safeShares&&requested.requestRefundableFee==="0","Fee-free request not created correctly");
 ensure(BigInt(requested.requestFee)===0n,"Scheduled request fee not disabled");
 step("02_SEPARATE_BLOCK_RELEASE_ELIGIBILITY",{requestShares:fs(BigInt(requested.requestShares)),feeBps:"0",at:await provider.getBlockNumber()});
 const updateSelector=interfaces.manager.getFunction("setDependencies").selector;
 const {id}=await import("ethers");
 const permissionSelector=id("updatePlasmaVaultAddress(address)").slice(0,10);
 const configRole=await ac.getTargetFunctionRole(A.template,permissionSelector);
 const callbackRole=await ac.getTargetFunctionRole(A.vault,interfaces.vault.getFunction("updateCallbackHandler").selector);
 const fuseRole=await ac.getTargetFunctionRole(A.vault,interfaces.vault.getFunction("addFuses").selector);
 ensure(callbackRole===300n&&fuseRole===300n,"Governor access changed");
 const configExisting=(await ac.hasRole(configRole,A.safe))[0];
 const configAdmin=await ac.getRoleAdmin(configRole);
 step("03_CONFIG_ROLE_PREFLIGHT",{role:String(configRole),selector:permissionSelector,admin:String(configAdmin),safeAlreadyAuthorized:configExisting});
 ensure(configExisting||configAdmin===100n,"Manager config role inaccessible from Safe");
 ensure((await ac.getRoleAdmin(300n))===100n,"Governor role admin changed");
 ensure(!(await ac.hasRole(300n,A.safe))[0],"Governor role already held; refuse accidental revoke");
 const artifact=JSON.parse(await readFile(".smart-contracts/cyavKAT Ipor Vault/next-phase/out/BurnRequestFeeFuse.sol/BurnRequestFeeFuse.json","utf8"));
 const bytecode=(await new ContractFactory(artifact.abi,artifact.bytecode.object).getDeployTransaction(MaxUint256)).data;
 const salt=keccak256(toUtf8Bytes("CurveYield cyavKAT scheduled fee repair 2026-11-18 v7"));
 const fixedBurn=getCreate2Address(A.createCall,salt,keccak256(bytecode));
 ensure((await provider.getCode(fixedBurn))==="0x","Fixed fuse already deployed");
 const C=BigInt(requested.collateral),D=BigInt(requested.debt),price=await oracle.price();
 const targetNet=4n*10n**18n,ltv=7665n;
 const remainColl=targetNet*10000n/(10000n-ltv);
 const targetDebt=remainColl*price/10n**36n*ltv/10000n;
 const repay=D-targetDebt,exit=C-remainColl;
 ensure(repay>0n&&exit>0n&&remainColl>0n&&targetDebt>0n,"Bad residual loop plan");
 const quoted=await router.requiredInputView(A.avkat,A.kat,repay,exit);
 const toSell=quoted+quoted/1000n+1n;
 ensure(toSell<exit,"Insufficient collateral to cover flash swap");
 report.plan={targetNetEquityAvkat:"4",targetLtvBps:7665,collateralLeft:f(remainColl),debtLeftKat:f(targetDebt),
  repayKat:f(repay),collateralExitAvkat:f(exit),swapAvkat:f(toSell),predictedRecoveredAvkat:f(exit-toSell),fixedBurn,configRole:String(configRole)};
 const retainSafeShares=33n*10n**19n; // 3.3 cyavKAT shares, leaving room for existing released request and free 1 avKAT
 const claimShares=safeShares-retainSafeShares;
 ensure(claimShares>0n,"No Safe shares available for claim");
 const firstChunk=safeShares-50n*10n**20n;
 const tranches=[firstChunk,42n*10n**20n,25n*10n**19n,12n*10n**19n,1n*10n**20n];
 ensure(tranches.reduce((x,y)=>x+y,0n)===claimShares,"Tranche total mismatches requested shares");
 report.plan.claimShares=fs(claimShares);report.plan.retainedSafeShares=fs(retainSafeShares);
 report.plan.redeemTranches=tranches.map(fs);
 const callback=[{fuse:A.borrow,data:interfaces.borrow.encodeFunctionData("exit",[[A.market,repay,0n]])},
  {fuse:A.collateral,data:interfaces.collateral.encodeFunctionData("exit",[[A.market,exit]])},
  {fuse:A.swap,data:interfaces.swap.encodeFunctionData("enter",[[A.avkat,A.kat,toSell,repay]])}];
 const payload=AbiCoder.defaultAbiCoder().encode(["tuple(address fuse,bytes data)[]"],[callback]);
 const flashData=interfaces.vault.encodeFunctionData("execute",[[{fuse:A.flash,data:interfaces.flash.encodeFunctionData("enter",[[A.kat,repay,payload]])}]]);
 const second=[
  {name:"deploy_corrected_IPOR_fee_burn",to:A.createCall,data:interfaces.create.encodeFunctionData("performCreate2",[0n,bytecode,salt])},
  {name:"grant_governor",to:A.access,data:interfaces.access.encodeFunctionData("grantRole",[300n,A.safe,0])},
  ...(!configExisting?[{name:"grant_manager_config",to:A.access,data:interfaces.access.encodeFunctionData("grantRole",[configRole,A.safe,0])}]:[]),
  {name:"register_corrected_fee_fuse",to:A.vault,data:interfaces.vault.encodeFunctionData("addFuses",[[fixedBurn]])},
  {name:"switch_manager_to_corrected_fee_burn",to:A.manager,data:interfaces.manager.encodeFunctionData("setDependencies",[A.controller,fixedBurn,A.feeShares,ZERO])},
  {name:"register_Morpho_flash_callback",to:A.vault,data:interfaces.vault.encodeFunctionData("updateCallbackHandler",[A.handler,A.morpho,"0x31f57072"])},
  {name:"flash_deleverage_to_4_equity_76_65_LTV",to:A.vault,data:flashData},
  {name:"burn_existing_mature_earned_fee_shares",to:A.manager,data:interfaces.manager.encodeFunctionData("pruneExpiredRequests",[500n])},
  {name:"recover_fully_vested_reward_manager_avkat",to:A.rewardsManager,data:new Interface(["function transferVestedTokensToVault()"] ).encodeFunctionData("transferVestedTokensToVault",[])},
  ...tranches.flatMap((shares,i)=>[
    {name:"fulfill_Safe_scheduled_"+i,to:A.controller,data:interfaces.controller.encodeFunctionData("fulfillFor",[A.safe,shares,0n])},
    {name:"claim_Safe_scheduled_"+i,to:A.vault,data:interfaces.vault.encodeFunctionData("redeemFromRequest",[shares,A.safe,A.safe])}
  ]),
  ...(!configExisting?[{name:"revoke_manager_config_role",to:A.access,data:interfaces.access.encodeFunctionData("revokeRole",[configRole,A.safe])}]:[]),
  {name:"revoke_governor_role",to:A.access,data:interfaces.access.encodeFunctionData("revokeRole",[300n,A.safe])}
 ];
 const batch=msdata(second),nextNonce=await safe.nonce(),hash=await safe.getTransactionHash(A.ms,0n,batch,1,0n,0n,0n,ZERO,ZERO,nextNonce);
 report.proposal2={hash,nonce:String(nextNonce),safe:A.safe,to:A.ms,data:batch,operation:1,valueWei:"0",
  calls:second.map(x=>({name:x.name,to:x.to,bytes:(x.data.length-2)/2}))};
 step("03_PREPARE_FINAL_SAFE",{plan:report.plan,safeTxHash:hash,nonce:String(nextNonce),calls:second.length});
 const snap=await provider.send("evm_snapshot",[]);
 await provider.send("anvil_impersonateAccount",[A.safe]);
 await provider.send("anvil_setBalance",[A.safe,"0x3635c9adc5dea00000"]);
 const signer=await provider.getSigner(A.safe);
 for(const [i,x] of second.entries()){
  if(x.name.startsWith("fulfill_Safe_scheduled_")){
    const live=await state();
    const chunk=tranches[Number(x.name.split("_").at(-1))];
    const toRelease=BigInt(live.sharesToRelease);
    const [totalRequested,recipientPreview,unwindQuote]=await Promise.all([
      v.previewRedeem(chunk+toRelease),v.previewRedeem(chunk),
      st.quoteUnwindForShares ? st.quoteUnwindForShares(chunk).catch(e=>"error:"+String(e.shortMessage||e.message)) : Promise.resolve("unsupported")
    ]);
    const diag={idleAvkat:f(BigInt(live.idleAvkat)),grossRequestedAvkat:f(totalRequested),
      recipientPreviewAvkat:f(recipientPreview),sharesToRelease:fs(toRelease),
      vaultAssets:f(BigInt(live.assets)),totalSupply:fs(BigInt(live.supply)),
      managerShares:fs(BigInt(live.managerShares)),safeShares:fs(safeShares),
      extraIdleNeededAvkat:totalRequested>BigInt(live.idleAvkat)?f(totalRequested-BigInt(live.idleAvkat)):"0",
      unwindQuote:String(unwindQuote)};
    step("04_08_FULFILL_PREFLIGHT",diag);
    ensure(totalRequested+parseUnits("0.1",18)<=BigInt(live.idleAvkat),"Pre-fulfill vault idle does not cover tranche + existing reserve");
  }
  if(x.name.startsWith("claim_Safe_scheduled_")){
    const q=await state(),chunk=tranches[Number(x.name.split("_").at(-1))];
    const remainingReserve=BigInt(q.sharesToRelease)-chunk;
    ensure(remainingReserve>=0n,"Released shares less than current tranche");
    const preview=await v.previewRedeem(chunk),reserved=await v.previewRedeem(remainingReserve);
    const slippageGuard=preview*102n/100n+reserved;
    step("04_CLAIM_2_PERCENT_LIQUIDITY_GUARD",{tranche:fs(chunk),vaultIdle:f(BigInt(q.idleAvkat)),
      redemption:f(preview),remainingReservedAssets:f(reserved),minimumIdleWithBuffer:f(slippageGuard)});
    ensure(slippageGuard+parseUnits("0.05",18)<=BigInt(q.idleAvkat),"IPOR 2 percent slippage guard would trigger extra market withdraw");
  }
  const tx=await txAs(signer,x),q=await state();
  step("04_"+String(i+1).padStart(2,"0")+"_"+x.name,{
   tx,ltvBps:q.ltvBps,collateral:f(BigInt(q.collateral)),debtKat:f(BigInt(q.debt)),
   idleAvkat:f(BigInt(q.idleAvkat)),safeAvkat:f(BigInt(q.safeAsset)),
   safeShares:fs(BigInt(q.safeShares)),managerEarnedShares:fs(BigInt(q.managerEarned)),
   managerShares:fs(BigInt(q.managerShares)),requestCanWithdraw:q.requestCanWithdraw});
  if(x.name==="flash_deleverage_to_4_equity_76_65_LTV"){
   ensure(BigInt(q.netEquity)>=parseUnits("3.8",18)&&BigInt(q.netEquity)<=parseUnits("4.2",18),"Morpho equity not 4 avKAT");
   ensure(BigInt(q.ltvBps)>=7650n&&BigInt(q.ltvBps)<7700n,"Morpho LTV not 76.5-77%");
  }
  if(x.name==="burn_existing_mature_earned_fee_shares"){
   ensure(BigInt(q.managerEarned)<BigInt(requested.managerEarned)/20n,"Mature fee shares not burned");
  }
  if(x.name==="recover_fully_vested_reward_manager_avkat"){
    ensure(BigInt(q.idleAvkat)>=parseUnits("1790",18),"Vested rewards not credited as avKAT into vault");
  }
  if(x.name.startsWith("fulfill_Safe_scheduled_"))ensure(q.requestCanWithdraw,"Safe's scheduled request not fulfilled");
  if(x.name.startsWith("claim_Safe_scheduled_")){
    const idx=Number(x.name.split("_").at(-1));
    const expected=safeShares-tranches.slice(0,idx+1).reduce((x,y)=>x+y,0n);
    ensure(BigInt(q.safeShares)===expected,"Safe claim shares mismatch tranche "+idx);
  }
 }
 report.sequential=await state();
 await provider.send("anvil_stopImpersonatingAccount",[A.safe]);
 ensure(await provider.send("evm_revert",[snap]),"Fork reset failed");
 const exact=await execSafe(second,nextNonce,ownerSigner);
 const end=await state();report.atomic={receipt:exact,final:end};
 ensure(end.safeShares===report.sequential.safeShares,"Atomic Safe shares mismatch");
 ensure(end.managerEarned===report.sequential.managerEarned,"Atomic burned shares mismatch");
 ensure(end.collateral===report.sequential.collateral,"Atomic Morpho collateral mismatch");
 const diff=(a,b)=>a>=b?a-b:b-a;
 ensure(diff(BigInt(end.idleAvkat),BigInt(report.sequential.idleAvkat))<=parseUnits("0.02",18),"Atomic vault idle discrepancy exceeds 0.02 avKAT");
 ensure(diff(BigInt(end.safeAsset),BigInt(report.sequential.safeAsset))<=parseUnits("0.02",18),"Atomic Safe avKAT discrepancy exceeds 0.02 avKAT");
 ensure(BigInt(end.idleAvkat)>=parseUnits("1",18),"Vault idle avKAT below 1");
 ensure(BigInt(end.netEquity)>=parseUnits("3.8",18)&&BigInt(end.netEquity)<=parseUnits("4.2",18),"Net equity not 4");
 report.status="PASS";
 step("99_ATOMIC_VERIFIED",{receipt:exact,safeAvkat:f(BigInt(end.safeAsset)-BigInt(before.safeAsset)),end:end.human});
}catch(e){report.errors.push({message:String(e.shortMessage||e.message||e),code:e.code||"",data:e.data||e.info?.error?.data||null});console.error("FAILED",e);}
finally{
 for(const who of [A.safe,A.owner]){try{await provider.send("anvil_stopImpersonatingAccount",[who]);}catch{}}
 await writeFile("cyavkat-scheduled-recovery-v7-report.json",JSON.stringify(report,null,2));
 if(report.status==="PASS")await writeFile("cyavkat-scheduled-recovery-v7-proposal.json",JSON.stringify(report.proposal2,null,2));
 console.log("SUMMARY",JSON.stringify({status:report.status,plan:report.plan,atomic:report.atomic,errors:report.errors,hash:report.proposal2?.hash}).slice(0,14000));
}
if(report.status!=="PASS")process.exitCode=1;
