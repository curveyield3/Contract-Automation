// CurveYield avKAT / Morpho Safe MultiSend batch v6: temporary role grants, callback, ~6700 avKAT unwind, full 6113.75 avKAT request fulfillment, revoke roles. All fork only.
// This file intentionally refuses any RPC except localhost Anvil. No production writes.
import { writeFile } from "node:fs/promises";
import { JsonRpcProvider, Contract, Interface, AbiCoder, ContractFactory, formatUnits, getAddress } from "ethers";

const ADDR = (v) => getAddress(v);
const A = {
  vault: ADDR("0xEd83daf48429cfb2C650Fd721b9241e180fd4548"),
  avkat: ADDR("0x7231dbacdfc968e07656d12389ab20de82fbfceb"),
  kat: ADDR("0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d"),
  morpho: ADDR("0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc"),
  access: ADDR("0xd7f408f203c5c6a76c9c55c9f6b015929f151faa"),
  owner: ADDR("0x11b78837cadc8e894f1c6e13fa9f3a085a75fa35"),
  safe: ADDR("0x47623C62f281807D615eeb4A2CEee9d97F9D3C49"),
  controller: ADDR("0xbfdf2d2653859b66a8a15e1c85f6d6cdee89698f"),
  withdrawManager: ADDR("0x59b340eab30afe0cecd51c609d3190e8c75c40ae"),
  requester: ADDR("0x9f2B20A772246960810045905B7daccf960eE288"),
  handler: ADDR("0xc1113f752D60aF4f49840CAC1c7bD30736DBb20e"),
  multiSendCallOnly: ADDR("0x40A2aCCbd92BCA938b02010E17A5b8929b49130D"),
  strategy: ADDR("0x79e88dd967ef9a31046455db94b1e487329ed705"),
  flash: ADDR("0x84927bff2a35a543ed94a7d96d5ccd162a167947"),
  borrow: ADDR("0x08095aef82a5b33b5b478d254052618a5366cd78"),
  collateral: ADDR("0xda9a20690a185daa3b0fd198c6232234835b6929"),
  swap: ADDR("0x1fb8b83baf40c90f0b450a3fd7a8b2e97ab2a3ff"),
  market: "0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9",
};
const OUT = "cyavkat-morpho-fulfill-safe-batch-v6-report.json";
const BATCH_OUT = "cyavkat-morpho-fulfill-safe-batch-v6.json";
const EXPECTED_REQUEST_SHARES = 476742794650259199097252n;
const REQUEST_ASSETS_TARGET = 6113750000000000000000n;
let batchJson = null;
const TARGET_ADDITIONAL_IDLE_AVKAT = 6700n*10n**18n;
const IDLE_TOLERANCE_AVKAT = 5n*10n**18n;
const TARGET_LTV_BPS = 7660n;
const report = {version:"v6", mode:"EPHEMERAL_KATANA_ANVIL_FORK_ONLY", status:"FAIL",
  parameters:{targetAdditionalIdleAvkat:"6700",idleToleranceAvkat:"5",targetLtvBps:7660,
    liquidationLtvBps:7700,emergencyLtvBps:7600},
  addresses:A, steps:[], before:{}, after:{}, quotes:{}, tx:null, errors:[]};
const step = (label, info) => { report.steps.push({label, ...info}); console.log(label,JSON.stringify(info)); };
const ok = (condition, message) => { if(!condition) throw new Error(message); };
const as = (n) => n.toString();
const u = (n) => formatUnits(n,18);
const provider = new JsonRpcProvider("http://127.0.0.1:8545",747474,{staticNetwork:true});
const vaultAbi = ["function execute((address fuse,bytes data)[] calls_)",
  "function isFuseSupported(address) view returns(bool)","function asset() view returns(address)",
  "function authority() view returns(address)","function totalAssets() view returns(uint256)",
  "function convertToAssets(uint256) view returns(uint256)",
  "function previewRedeem(uint256) view returns(uint256)",
  "function updateCallbackHandler(address,address,bytes4)"];
const positionAbi = ["function position(bytes32,address) view returns(uint256 supplyShares,uint128 borrowShares,uint128 collateral)",
  "function idToMarketParams(bytes32) view returns(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)"];
const strategyAbi = ["function morphoSnapshot() view returns((uint256 collateralAvkat,uint256 debtKat,uint256 collateralValueKat,uint256 ltvBps,uint256 netEquityAvkat))"];
const routerAbi = ["function requiredInputView(address,address,uint256,uint256) view returns(uint256)"];
const tokenAbi = ["function balanceOf(address) view returns(uint256)"];
const accessAbi = ["function canCall(address,address,bytes4) view returns(bool,uint32)",
  "function getTargetFunctionRole(address,bytes4) view returns(uint64)",
  "function grantRole(uint64,address,uint32)",
  "function revokeRole(uint64,address)",
  "function hasRole(uint64,address) view returns(bool,uint32)",
  "function getRoleAdmin(uint64) view returns(uint64)"];
const safeAbi = ["function getThreshold() view returns(uint256)",
  "function getOwners() view returns(address[])", "function nonce() view returns(uint256)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)"];
const multiSendAbi = new Interface(["function multiSend(bytes transactions)"]);
const controllerAbi = ["function fulfillFor(address requester_,uint256 shares_,uint256 maxContributionAvkat_)"];
const managerAbi = ["function requestInfo(address) view returns((uint256 shares,uint256 endWithdrawWindowTimestamp,bool canWithdraw,uint256 withdrawWindowInSeconds,uint256 refundableFeeShares))",
  "function reservedSharesOf(address) view returns(uint256)",
  "function getSharesToRelease() view returns(uint256)",
  "function activeUnreleasedShares() view returns(uint256)"];
const ifaceBorrow = new Interface(["function exit((bytes32,uint256,uint256))"]);
const ifaceCollateral = new Interface(["function exit((bytes32,uint256))"]);
const ifaceSwap = new Interface(["function enter((address,address,uint256,uint256))"]);
const ifaceFlash = new Interface(["function enter((address,uint256,bytes))"]);
const vault = new Contract(A.vault,vaultAbi,provider);
const morpho = new Contract(A.morpho,positionAbi,provider);
const strategy = new Contract(A.strategy,strategyAbi,provider);
const router = new Contract(A.swap,routerAbi,provider);
const avkat = new Contract(A.avkat,tokenAbi,provider);
const kat = new Contract(A.kat,tokenAbi,provider);
const access = new Contract(A.access,accessAbi,provider);
const safe = new Contract(A.safe,safeAbi,provider);
const controller = new Contract(A.controller,controllerAbi,provider);
const manager = new Contract(A.withdrawManager,managerAbi,provider);
async function state(){
  const [p,s,idleAvkat,idleKat,total] = await Promise.all([
    morpho.position(A.market,A.vault),strategy.morphoSnapshot(),
    avkat.balanceOf(A.vault),kat.balanceOf(A.vault),vault.totalAssets()]);
  return {supplyShares:as(p.supplyShares),borrowShares:as(p.borrowShares),
    collateralAvkat:as(p.collateral),expectedDebtKat:as(s.debtKat),
    netEquityAvkat:as(s.netEquityAvkat),ltvBps:as(s.ltvBps),
    idleAvkat:as(idleAvkat),idleKat:as(idleKat),vaultTotalAssets:as(total),
    human:{collateral:u(p.collateral),expectedDebtKat:u(s.debtKat),equityAvkat:u(s.netEquityAvkat),idleAvkat:u(idleAvkat)}};
}
try {
  const client = String(await provider.send("web3_clientVersion",[])).toLowerCase();
  ok(client.includes("anvil"),"HARD STOP: RPC is not Anvil");
  ok((await provider.getNetwork()).chainId === 747474n,"HARD STOP: wrong chain");
  report.forkBlock = await provider.getBlockNumber();
  report.forkBlockHash = (await provider.getBlock(report.forkBlock)).hash;
  ok((await vault.asset()).toLowerCase() === A.avkat.toLowerCase(),"unexpected vault asset");
  ok((await vault.authority()).toLowerCase() === A.access.toLowerCase(),"unexpected access manager");
  for(const f of [A.flash,A.borrow,A.collateral,A.swap])
    ok(await vault.isFuseSupported(f),"required fuse unsupported: "+f);
  const execSelector = vault.interface.getFunction("execute").selector;
  const call = await (new Contract(A.access,accessAbi,provider)).canCall(A.owner,A.vault,execSelector);
  report.authorization = {caller:A.owner,executeSelector:execSelector,immediate:call[0],delay:as(call[1])};
  ok(call[0] && call[1]===0n,"owner cannot execute directly without delay");
  report.before = await state();
  const requestBefore=await manager.requestInfo(A.requester);
  const availableShares=requestBefore.shares-await manager.reservedSharesOf(A.requester);
  const requestedGrossAvkat=await vault.convertToAssets(availableShares);
  const requestedNetAvkat=await vault.previewRedeem(availableShares);
  const diff=(x)=>x>=REQUEST_ASSETS_TARGET?x-REQUEST_ASSETS_TARGET:REQUEST_ASSETS_TARGET-x;
  ok(availableShares===EXPECTED_REQUEST_SHARES,
    "the 6113.75 avKAT requester share balance changed; refusing stale batch");
  ok(diff(requestedGrossAvkat)<20n*10n**18n,
    "the requested avKAT value has changed materially");
  ok(availableShares>0n&&!(requestBefore.canWithdraw),
    "the targeted request is already fulfilled or is absent");
  const outstandingRequestedShares=await manager.activeUnreleasedShares();
  ok(outstandingRequestedShares===availableShares,
    "additional unrelated requests exist; refuse ambiguous targeted fulfillment");
  report.beforeRequest={requester:A.requester,
    shares:as(availableShares),grossAssetsAvkat:u(requestedGrossAvkat),
    netRedeemAvkat:u(requestedNetAvkat),
    endWithdrawWindowTimestamp:as(requestBefore.endWithdrawWindowTimestamp),
    reservedBefore:"0"};
  step("EXACT_PENDING_REQUEST_IDENTIFIED",{status:"PASS",...report.beforeRequest});
  const p = await morpho.position(A.market,A.vault);
  const s = await strategy.morphoSnapshot();
  ok(p.borrowShares>0n && p.collateral>0n && s.debtKat>0n,"no active borrowed position");
  // Solve backwards for the amount of collateral to remove to leave ~6700 NEW idle avKAT.
  // For each candidate, calculate the exact KAT debt reduction needed to retain 76.60% LTV
  // and obtain a fork-local router quote (including the existing 0.10% input buffer).
  const marketParams = await morpho.idToMarketParams(A.market);
  const liquidationLtv = (marketParams.lltv*10000n)/10n**18n;
  ok(liquidationLtv===7700n,"unexpected Morpho LLTV; inspect new market configuration");
  ok(TARGET_LTV_BPS<liquidationLtv,"requested LTV at or above Morpho liquidation threshold");

  const candidateQuotes=[];
  async function estimateAtExitBps(exitBps){
    const collateralExit=p.collateral*exitBps/10000n;
    const collateralRemain=p.collateral-collateralExit;
    const remainingValueKat=s.collateralValueKat*collateralRemain/p.collateral;
    const targetRemainingDebtKat=remainingValueKat*TARGET_LTV_BPS/10000n;
    const repayKat=s.debtKat-targetRemainingDebtKat;
    ok(repayKat>0n && repayKat<s.debtKat,"invalid partial repayment for exit fraction "+exitBps);
    const exactInput=await router.requiredInputView(A.avkat,A.kat,repayKat,collateralExit);
    const swapInput=exactInput+exactInput/1000n+1n;
    ok(exactInput>0n && swapInput<collateralExit,
      "insufficient collateral for requested swap at exitBps="+exitBps);
    const netIdleAvkat=collateralExit-swapInput;
    candidateQuotes.push({exitBps:as(exitBps),netIdleAvkat:u(netIdleAvkat),
      collateralWithdrawnAvkat:u(collateralExit),debtRepaymentKat:u(repayKat)});
    return {exitBps,collateralExit,collateralRemain,remainingValueKat,
      targetRemainingDebtKat,repayKat,exactInput,swapInput,netIdleAvkat};
  }
  // Integer-basis-point search (<=14 pricing calls) with independently verified endpoints.
  // Do not blindly assume a linear swap rate: quotes reflect route, liquidity and slippage.
  let lower=4000n, upper=9000n;
  let lowQuote=await estimateAtExitBps(lower);
  let highQuote=await estimateAtExitBps(upper);
  ok(lowQuote.netIdleAvkat<TARGET_ADDITIONAL_IDLE_AVKAT &&
    highQuote.netIdleAvkat>TARGET_ADDITIONAL_IDLE_AVKAT,
    "6700 avKAT target not bracketed by executable quotes");
  let best=lowQuote;
  const abs=(x)=>x<0n?-x:x;
  function consider(q){if(abs(q.netIdleAvkat-TARGET_ADDITIONAL_IDLE_AVKAT)<
      abs(best.netIdleAvkat-TARGET_ADDITIONAL_IDLE_AVKAT)) best=q;}
  consider(highQuote);
  let iterations=0;
  while(lower+1n<upper && iterations<16){
    const mid=(lower+upper)/2n;
    const q=await estimateAtExitBps(mid);
    consider(q);
    if(q.netIdleAvkat<TARGET_ADDITIONAL_IDLE_AVKAT)lower=mid;
    else upper=mid;
    iterations++;
  }
  const chosen=best;
  const {exitBps:COLLATERAL_EXIT_BPS,collateralExit,collateralRemain,remainingValueKat,
    targetRemainingDebtKat,repayKat,exactInput,swapInput}=chosen;
  const loan=repayKat;
  const predictedDifference=abs(chosen.netIdleAvkat-TARGET_ADDITIONAL_IDLE_AVKAT);
  ok(predictedDifference<=IDLE_TOLERANCE_AVKAT,
    "no quoted unwind delivers 6700 additional idle avKAT within tolerance");
  report.search={method:"bounded binary search over collateral exit bps using on-chain router.requiredInputView",
    iterations:iterations+2,chosenCollateralExitBps:as(COLLATERAL_EXIT_BPS),
    predictedNewIdleAvkat:u(chosen.netIdleAvkat),
    predictedTargetErrorAvkat:u(predictedDifference),candidateQuotes};
  report.parameters.collateralExitBps=Number(COLLATERAL_EXIT_BPS);
  report.plannedPosition={collateralExitAvkat:as(collateralExit),
    collateralExitHuman:u(collateralExit),collateralRemainAvkat:as(collateralRemain),
    collateralRemainHuman:u(collateralRemain),repayKat:as(repayKat),repayHuman:u(repayKat),
    targetRemainingDebtKat:as(targetRemainingDebtKat),targetRemainingDebtHuman:u(targetRemainingDebtKat),
    targetRemainingCollateralValueKat:as(remainingValueKat)};
  report.quotes={flashBorrowKat:as(loan),flashBorrowHuman:u(loan),
    requiredAvkat:as(exactInput),proposedSwapInputAvkat:as(swapInput),
    proposedSwapHuman:u(swapInput),grossCollateralExitAvkat:u(collateralExit),
    estimatedIdleAvkatRecovered:u(chosen.netIdleAvkat),requiredMinimumKat:as(loan)};
  step("PREFLIGHT",{status:"PASS",forkBlock:report.forkBlock,existingOwnerAlphaPermission:true,
    sourceLtvBps:as(s.ltvBps),targetLtvBps:as(TARGET_LTV_BPS),
    liquidationLtvBps:as(liquidationLtv),emergencyLtvBps:"7600",
    plannedCollateralExitAvkat:u(collateralExit),chosenCollateralExitBps:as(COLLATERAL_EXIT_BPS),
    estimatedNewIdleAvkat:u(chosen.netIdleAvkat),
    plannedDebtRepayKat:u(repayKat),morphoBorrowSharesBefore:as(p.borrowShares)});
  // MorphoBorrowFuse.exit repays assets when amount != 0, shares == 0.
  // A flash-loan callback repays the borrow BEFORE collateral is removed.
  const nested = [
    {fuse:A.borrow,data:ifaceBorrow.encodeFunctionData("exit",[[A.market,loan,0n]])},
    {fuse:A.collateral,data:ifaceCollateral.encodeFunctionData("exit",[[A.market,collateralExit]])},
    {fuse:A.swap,data:ifaceSwap.encodeFunctionData("enter",[[A.avkat,A.kat,swapInput,loan]])},
  ];
  const payload = AbiCoder.defaultAbiCoder().encode(["tuple(address fuse,bytes data)[]"],[nested]);
  const actions = [{fuse:A.flash,data:ifaceFlash.encodeFunctionData("enter",[[A.kat,loan,payload]])}];
  report.path = [
    "PlasmaVault.execute((address,bytes)[]) by authorized ALPHA account",
    "MorphoFlashLoanFuse.enter((KAT,calculatedPartialRepay,callback))",
    "MorphoBorrowFuse.exit((marketId,repayAssetsKat,shares=0))",
    "MorphoCollateralFuse.exit((marketId,optimized collateral fraction for +6700 idle avKAT))",
    "RouterSwapFuse.enter((avKAT,KAT,quotedInput,minOut=flashPrincipal))",
    "Complete Morpho flash-loan repayment and preserve all non-withdrawn collateral",
    "Verify ~6700 additional idle avKAT, outstanding borrowShares>0 and 76.60% LTV within 1bp"
  ];
  // Safe OWNER_ROLE=1 grants itself the ATOMIST admin role 100, then ALPHA=200
  // and FUSE_MANAGER=300, executes the requested vault operations, fulfills
  // the ONE existing 6113.75 avKAT request, and revokes all three roles
  // before the same atomic Safe MultiSend completes. No separate role Tx.
  const registerCalldata=vault.interface.encodeFunctionData("updateCallbackHandler",
    [A.handler,A.morpho,"0x31f57072"]);
  const executeCalldata=vault.interface.encodeFunctionData("execute",[actions]);
  const fulfillCalldata=controller.interface.encodeFunctionData("fulfillFor",
    [A.requester,availableShares,0n]); // EXACT pending shares, ZERO extra contribution.
  const grant100=access.interface.encodeFunctionData("grantRole",[100n,A.safe,0]);
  const grant200=access.interface.encodeFunctionData("grantRole",[200n,A.safe,0]);
  const grant300=access.interface.encodeFunctionData("grantRole",[300n,A.safe,0]);
  const revoke300=access.interface.encodeFunctionData("revokeRole",[300n,A.safe]);
  const revoke200=access.interface.encodeFunctionData("revokeRole",[200n,A.safe]);
  const revoke100=access.interface.encodeFunctionData("revokeRole",[100n,A.safe]);
  const calls=[
    {to:A.access,value:"0",data:grant100},
    {to:A.access,value:"0",data:grant200},
    {to:A.access,value:"0",data:grant300},
    {to:A.vault,value:"0",data:registerCalldata},
    {to:A.vault,value:"0",data:executeCalldata},
    {to:A.controller,value:"0",data:fulfillCalldata},
    {to:A.access,value:"0",data:revoke300},
    {to:A.access,value:"0",data:revoke200},
    {to:A.access,value:"0",data:revoke100},
  ];
  batchJson={version:"1.0",chainId:"747474",createdAt:Date.now(),
    meta:{name:"OWNER Safe: Morpho callback + 6700 avKAT unwind + 6113.75 avKAT request v6",
      description:"Atomic 9-CALL Safe MultiSendCallOnly: self-grant temporary roles 100/200/300, register verified Morpho callback, recover ~6700 avKAT with target 76.6% Morpho LTV, fulfill the EXISTING requester share balance (no additional contribution), revoke roles 300/200/100. No role privileges retained after execution. Values are fork-quoted and require refreshed preflight before live execution.",
      txBuilderVersion:"1.16.3",createdFromSafeAddress:A.safe},
    transactions:calls};
  report.batch={safe:A.safe,registeredHandler:A.handler,
    morphoCallbackSelector:"0x31f57072",multiSendCallOnly:A.multiSendCallOnly,
    controller:A.controller,withdrawManager:A.withdrawManager,
    requester:A.requester,requestShares:as(availableShares),
    requestedGrossAvkat:u(requestedGrossAvkat),requestedNetAvkat:u(requestedNetAvkat),
    orderedCalls:["grantRole(100,Safe)","grantRole(200,Safe)","grantRole(300,Safe)",
      "PlasmaVault.updateCallbackHandler(canonicalHandler,Morpho,0x31f57072)",
      "PlasmaVault.execute(atomic partial Morpho unwind ~6700 additional avKAT)",
      "CurveYieldKatanaVaultControllerV2.fulfillFor(requester, exactOutstandingShares, 0)",
      "revokeRole(300,Safe)","revokeRole(200,Safe)","revokeRole(100,Safe)"],
    localArtifact:BATCH_OUT,executionPrerequisites:
      "Safe currently OWNER_ROLE=1 and threshold 1. Role 100/200/300 are granted and revoked atomically IN THE SAME Safe transaction. Review fresh quotes, request shares and Safe nonce before proposal."};

  ok((await provider.getCode(A.handler)).length>2,"canonical Morpho callback handler not deployed");
  ok((await provider.getCode(A.multiSendCallOnly)).length>2,
    "Safe MultiSendCallOnly contract not deployed");
  const [threshold,owners,safeNonce]=await Promise.all([
    safe.getThreshold(),safe.getOwners(),safe.nonce()]);
  ok(threshold===1n,"Safe approval threshold changed; refusing prevalidated v=1 signer simulation");
  ok(owners.some(o=>o.toLowerCase()===A.owner.toLowerCase()),
    "selected EOA is not an owner of requested Safe");
  const callbackSelector=vault.interface.getFunction("updateCallbackHandler").selector;
  const [execRole,callbackRole,roleAdmin100,roleAdmin200,roleAdmin300,
    role1,role100,role200,role300]=await Promise.all([
      access.getTargetFunctionRole(A.vault,execSelector),
      access.getTargetFunctionRole(A.vault,callbackSelector),
      access.getRoleAdmin(100),access.getRoleAdmin(200),access.getRoleAdmin(300),
      access.hasRole(1,A.safe),access.hasRole(100,A.safe),
      access.hasRole(200,A.safe),access.hasRole(300,A.safe)]);
  ok(execRole===200n&&callbackRole===300n &&
    roleAdmin100===1n&&roleAdmin200===100n&&roleAdmin300===100n,
    "access-manager target-role mapping or role-admin hierarchy differs");
  ok(role1[0]&&!role100[0]&&!role200[0]&&!role300[0],
    "requested Safe missing OWNER or already has non-OWNER roles; do not revoke pre-existing grants");
  report.safeAuthorizationBefore={safeNonce:as(safeNonce),threshold:as(threshold),
    owner:A.owner,role1Owner:role1[0],
    roles100200300InitiallyAbsent:true,
    executeRole:as(execRole),registerHandlerRole:as(callbackRole),
    role100Admin:as(roleAdmin100),role200Admin:as(roleAdmin200),
    role300Admin:as(roleAdmin300)};
  step("SAFE_OWNER_PERMISSION_PREFLIGHT",{status:"PASS",...report.safeAuthorizationBefore});
  // Exactly nine CALLs, with a single Safe DELEGATECALL into MultiSendCallOnly.
  const byteLength=n=>BigInt((n.length-2)/2);
  const packCall=(target,calldata)=>
    "00"+target.slice(2).toLowerCase()+(0n).toString(16).padStart(64,"0")+
    byteLength(calldata).toString(16).padStart(64,"0")+calldata.slice(2);
  const packed="0x"+calls.map(c=>packCall(c.to,c.data)).join("");
  const multiSendData=multiSendAbi.encodeFunctionData("multiSend",[packed]);
  const ZERO="0x0000000000000000000000000000000000000000";
  const prevalidatedSignature="0x"+A.owner.slice(2).toLowerCase().padStart(64,"0")+
    (0n).toString(16).padStart(64,"0")+"01";
  const safeTxArgs=[A.multiSendCallOnly,0n,multiSendData,1,0n,0n,0n,ZERO,ZERO,prevalidatedSignature];
  await provider.send("anvil_setBalance",[A.owner,"0x3635c9adc5dea00000"]);
  await provider.send("anvil_impersonateAccount",[A.owner]);
  const ownerSigner=await provider.getSigner(A.owner);
  const safeByOwner=safe.connect(ownerSigner);
  ok(await safeByOwner.execTransaction.staticCall(...safeTxArgs),
    "Combined 9-step Safe MultiSend static simulation failed");
  step("CALL_STATIC_COMBINED_SAFE_MULTISEND",{status:"PASS",
    callOrder:report.batch.orderedCalls,safeNonce:as(safeNonce)});
  const estimate=await safeByOwner.execTransaction.estimateGas(...safeTxArgs);
  const gasLimit=estimate*120n/100n+100000n;
  report.gas={estimated:as(estimate),submittedLimit:as(gasLimit)};
  const tx=await safeByOwner.execTransaction(...safeTxArgs,{gasLimit});
  report.tx={hash:tx.hash,from:A.owner,viaSafe:A.safe,
    to:A.multiSendCallOnly,mode:"Safe.execTransaction(DelegateCall MultiSendCallOnly)",
    operation:1,safeNonce:as(safeNonce)};
  const receipt=await tx.wait();
  report.tx.gasUsed=as(receipt.gasUsed);
  report.tx.receiptStatus=receipt.status;
  ok(receipt.status===1,"combined Safe batch transaction reverted on fork");
  report.tx.safeNonceAfter=as(await safe.nonce());
  ok(BigInt(report.tx.safeNonceAfter)===safeNonce+1n,"Safe nonce did not increment");
  const [postRole1,postRole100,postRole200,postRole300,requestAfter,
    reservedAfter,activeUnreleasedAfter,sharesToReleaseAfter]=await Promise.all([
    access.hasRole(1,A.safe),access.hasRole(100,A.safe),
    access.hasRole(200,A.safe),access.hasRole(300,A.safe),
    manager.requestInfo(A.requester),manager.reservedSharesOf(A.requester),
    manager.activeUnreleasedShares(),manager.getSharesToRelease()]);
  ok(postRole1[0]&&!postRole100[0]&&!postRole200[0]&&!postRole300[0],
    "temporary role grants were not fully revoked by atomic batch");
  ok(requestAfter.canWithdraw===true,"targeted request was not made redeemable");
  ok(requestAfter.shares===availableShares &&
      reservedAfter===availableShares &&
      sharesToReleaseAfter===availableShares &&
      activeUnreleasedAfter===0n,
    "request fulfillment did not release exact requested shares into withdrawal window");
  report.fulfillment={requester:A.requester,requestShares:as(availableShares),
    beforeAvailableGrossAvkat:u(requestedGrossAvkat),
    redeemableAvkatEstimateBefore:u(requestedNetAvkat),
    reservedSharesAfter:as(reservedAfter),sharesToReleaseAfter:as(sharesToReleaseAfter),
    activeUnreleasedSharesAfter:as(activeUnreleasedAfter),
    canWithdrawAfter:requestAfter.canWithdraw,
    requestSharesAfter:as(requestAfter.shares),
    withdrawalDeadlineAfter:as(requestAfter.endWithdrawWindowTimestamp),
    note:"Request has been made redeemable, NOT redeemed or paid out to requester."};
  report.safeAuthorizationAfter={ownerRoleRetained:postRole1[0],
    role100Revoked:!postRole100[0],role200Revoked:!postRole200[0],
    role300Revoked:!postRole300[0]};
  step("ATOMIC_SAFE_BATCH_WITH_TARGETED_REQUEST_FULFILLMENT",{status:"PASS",
    hash:tx.hash,gasUsed:as(receipt.gasUsed),safeNonceAfter:report.tx.safeNonceAfter,
    requestShares:as(reservedAfter),canWithdraw:true,
    temporaryRolesRevoked:true});
  report.after = await state();
  const remainingShares=BigInt(report.after.borrowShares);
  const actualCollateral=BigInt(report.after.collateralAvkat);
  const actualDebt=BigInt(report.after.expectedDebtKat);
  const actualLtv=BigInt(report.after.ltvBps);
  ok(remainingShares>0n && remainingShares<p.borrowShares,
    "partial unwind incorrectly closed all debt or failed to repay");
  ok(actualCollateral===collateralRemain,
    "optimized collateral withdrawal does not match on-chain post-state");
  ok(actualDebt>0n && actualDebt<s.debtKat,
    "debt was fully repaid or did not decrease");
  ok(actualLtv>=TARGET_LTV_BPS-1n && actualLtv<=TARGET_LTV_BPS+1n,
    "resulting LTV differs from requested 76.6% beyond 1bp: "+actualLtv);
  ok(actualLtv<liquidationLtv,"post-transaction position is liquidatable at current Morpho oracle");
  const netAdditionalIdleAvkat=BigInt(report.after.idleAvkat)-BigInt(report.before.idleAvkat);
  ok(netAdditionalIdleAvkat>0n,"no net avKAT recovered to vault");
  ok(abs(netAdditionalIdleAvkat-TARGET_ADDITIONAL_IDLE_AVKAT)<=IDLE_TOLERANCE_AVKAT,
    "actual idle avKAT recovery misses the 6700 target by >5 avKAT");
  const finalSnapshot=await strategy.morphoSnapshot();
  // Independent oracle-valued economic P&L: Morpho equity + idle avKAT + residual KAT.
  // Both snapshots use the same pinned fork price feed.
  const baselineIdleKat=BigInt(report.before.idleKat);
  const finalIdleKat=BigInt(report.after.idleKat);
  const beforeOracleEquity=s.netEquityAvkat+BigInt(report.before.idleAvkat)+
    (baselineIdleKat*p.collateral/s.collateralValueKat);
  const afterOracleEquity=finalSnapshot.netEquityAvkat+BigInt(report.after.idleAvkat)+
    (finalIdleKat*actualCollateral/finalSnapshot.collateralValueKat);
  report.economics={beforeOracleEquityAvkat:u(beforeOracleEquity),
    afterOracleEquityAvkat:u(afterOracleEquity),
    oracleValueLossAvkat:u(beforeOracleEquity-afterOracleEquity),
    beforeVaultTotalAssetsAvkat:u(BigInt(report.before.vaultTotalAssets)),
    afterVaultTotalAssetsAvkat:u(BigInt(report.after.vaultTotalAssets)),
    accountingAssetChangeAvkat:u(BigInt(report.before.vaultTotalAssets)-BigInt(report.after.vaultTotalAssets)),
    note:"Oracle-marked economic P/L reconciles Morpho equity, idle avKAT and leftover KAT; vault.totalAssets reports an independent accounting measure."};
  report.verified={collateralWithdrawnAvkat:as(p.collateral-actualCollateral),
    collateralWithdrawnHuman:u(p.collateral-actualCollateral),
    collateralWithdrawnBps:as(((p.collateral-actualCollateral)*10000n)/p.collateral),
    remainingCollateralAvkat:as(actualCollateral),
    debtReducedKat:as(s.debtKat-actualDebt),debtReducedHuman:u(s.debtKat-actualDebt),
    remainingDebtKat:as(actualDebt),remainingDebtHuman:u(actualDebt),
    remainingLtvBps:as(actualLtv),remainingLtvPercent:(Number(actualLtv)/100).toFixed(2),
    liquidationHeadroomBps:as(liquidationLtv-actualLtv),
    returnedIdleAvkat:as(netAdditionalIdleAvkat),returnedIdleAvkatHuman:u(netAdditionalIdleAvkat),
    targetAdditionalIdleAvkat:"6700",targetDeviationAvkat:u(abs(netAdditionalIdleAvkat-TARGET_ADDITIONAL_IDLE_AVKAT)),
    warning:"Target exceeds strategy emergency threshold of 76%, with only ~0.4 percentage points liquidation headroom"};
  step("SAFE_BATCH_UNWIND_AND_FULFILL_REQUEST",{status:"PASS",transactionHash:tx.hash,
    remainingBorrowShares:as(remainingShares),remainingCollateral:as(actualCollateral),
    resultingLtvBps:as(actualLtv),collateralWithdrawnBps:report.verified.collateralWithdrawnBps,
    newlyIdleAvkat:u(netAdditionalIdleAvkat),lossAvkat:report.economics.oracleValueLossAvkat});
  report.status="PASS";
}catch(error){
  report.errors.push({message:String(error.shortMessage||error.message||error),
    code:error.code||null,revertData:error.data||error.info?.error?.data||null});
  console.error(error);
}finally{
  try{await provider.send("anvil_stopImpersonatingAccount",[A.owner]);}catch{}
  await writeFile(OUT,JSON.stringify(report,null,2));
  if(batchJson) await writeFile(BATCH_OUT,JSON.stringify(batchJson,null,2));
  console.log("Evidence:",OUT,"finalStatus:",report.status);
}
if(report.status!=="PASS")process.exitCode=1;
