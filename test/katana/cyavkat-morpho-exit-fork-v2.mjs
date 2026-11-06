// CurveYield avKAT / Morpho full-position unwind on an EPHEMERAL Katana Anvil fork.
// This file intentionally refuses any RPC except localhost Anvil. No production writes.
import { writeFile } from "node:fs/promises";
import { JsonRpcProvider, Contract, Interface, AbiCoder, ContractFactory, formatUnits, getAddress } from "ethers";
import solc from "solc";

const ADDR = (v) => getAddress(v);
const A = {
  vault: ADDR("0xEd83daf48429cfb2C650Fd721b9241e180fd4548"),
  avkat: ADDR("0x7231dbacdfc968e07656d12389ab20de82fbfceb"),
  kat: ADDR("0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d"),
  morpho: ADDR("0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc"),
  access: ADDR("0xd7f408f203c5c6a76c9c55c9f6b015929f151faa"),
  owner: ADDR("0x11b78837cadc8e894f1c6e13fa9f3a085a75fa35"),
  strategy: ADDR("0x79e88dd967ef9a31046455db94b1e487329ed705"),
  flash: ADDR("0x84927bff2a35a543ed94a7d96d5ccd162a167947"),
  borrow: ADDR("0x08095aef82a5b33b5b478d254052618a5366cd78"),
  collateral: ADDR("0xda9a20690a185daa3b0fd198c6232234835b6929"),
  swap: ADDR("0x1fb8b83baf40c90f0b450a3fd7a8b2e97ab2a3ff"),
  market: "0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9",
};
const OUT = "cyavkat-morpho-exit-fork-v2.json";
const report = {version:"v2", mode:"EPHEMERAL_KATANA_ANVIL_FORK_ONLY", status:"FAIL",
  addresses:A, steps:[], before:{}, after:{}, quotes:{}, tx:null, errors:[]};
const step = (label, info) => { report.steps.push({label, ...info}); console.log(label,JSON.stringify(info)); };
const ok = (condition, message) => { if(!condition) throw new Error(message); };
const as = (n) => n.toString();
const u = (n) => formatUnits(n,18);
const provider = new JsonRpcProvider("http://127.0.0.1:8545",747474,{staticNetwork:true});
const vaultAbi = ["function execute((address fuse,bytes data)[] calls_)",
  "function isFuseSupported(address) view returns(bool)","function asset() view returns(address)",
  "function authority() view returns(address)","function totalAssets() view returns(uint256)",
  "function updateCallbackHandler(address,address,bytes4)"];
const positionAbi = ["function position(bytes32,address) view returns(uint256 supplyShares,uint128 borrowShares,uint128 collateral)"];
const strategyAbi = ["function morphoSnapshot() view returns((uint256 collateralAvkat,uint256 debtKat,uint256 collateralValueKat,uint256 ltvBps,uint256 netEquityAvkat))"];
const routerAbi = ["function requiredInputView(address,address,uint256,uint256) view returns(uint256)"];
const tokenAbi = ["function balanceOf(address) view returns(uint256)"];
const accessAbi = ["function canCall(address,address,bytes4) view returns(bool,uint32)"];
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
  const p = await morpho.position(A.market,A.vault);
  const s = await strategy.morphoSnapshot();
  ok(p.borrowShares>0n && p.collateral>0n && s.debtKat>0n,"no active borrowed position");
  // Borrow enough for accrued interest and repay exactly ALL Morpho debt shares.
  // The flash principal, not just the expected debt, must be returned to Morpho.
  const loan = s.debtKat + s.debtKat/1000n + 10n**18n;
  const exactInput = await router.requiredInputView(A.avkat,A.kat,loan,p.collateral);
  const swapInput = exactInput + exactInput/1000n + 1n;
  ok(exactInput>0n && swapInput < p.collateral,"swap requires unavailable collateral");
  report.quotes = {flashBorrowKat:as(loan),flashBorrowHuman:u(loan),
    requiredAvkat:as(exactInput),proposedSwapInputAvkat:as(swapInput),
    proposedSwapHuman:u(swapInput),collateralRemainingEstimatedAvkat:u(p.collateral-swapInput),
    maxSwapOutputMinimumKat:as(loan),repayFullBorrowShares:as(p.borrowShares)};
  step("PREFLIGHT",{status:"PASS",forkBlock:report.forkBlock,
    existingOwnerAlphaPermission:true,morphoBorrowShares:as(p.borrowShares)});
  const nested = [
    {fuse:A.borrow,data:ifaceBorrow.encodeFunctionData("exit",[[A.market,0n,p.borrowShares]])},
    {fuse:A.collateral,data:ifaceCollateral.encodeFunctionData("exit",[[A.market,p.collateral]])},
    {fuse:A.swap,data:ifaceSwap.encodeFunctionData("enter",[[A.avkat,A.kat,swapInput,loan]])},
  ];
  const payload = AbiCoder.defaultAbiCoder().encode(["tuple(address fuse,bytes data)[]"],[nested]);
  const actions = [{fuse:A.flash,data:ifaceFlash.encodeFunctionData("enter",[[A.kat,loan,payload]])}];
  report.path = [
    "PlasmaVault.execute(FuseAction[]) from preauthorized owner/ALPHA",
    "MorphoFlashLoanFuse.enter((KAT,flashPrincipal,callback))",
    "MorphoBorrowFuse.exit((marketId,0,ALL borrowShares))",
    "MorphoCollateralFuse.exit((marketId,ALL collateral))",
    "RouterSwapFuse.enter((avKAT,KAT,quotedInput,minOut=flashPrincipal))",
    "Morpho flash-loan repayment in callback completion"
  ];
  await provider.send("anvil_setBalance",[A.owner,"0x3635c9adc5dea00000"]);
  await provider.send("anvil_impersonateAccount",[A.owner]);
  const signedVault = vault.connect(await provider.getSigner(A.owner));

  // Production snapshot preflight: a missing handler blocks the existing live configuration.
  // The fork-only recovery below reproduces exactly the IPOR governance setup flow.
  let baselineRevert=null;
  try {
    await signedVault.execute.staticCall(actions);
    step("EXISTING_CALLBACK_CONFIGURATION",{status:"PASS",note:"No registration required"});
  }catch(error){
    baselineRevert = error.data || error.info?.error?.data || "";
    report.liveConfigurationBlocker = {observedRevert:baselineRevert,meaning:"Morpho callback handler missing; live vault execution blocked"};
    step("EXISTING_CALLBACK_CONFIGURATION",{status:"BLOCKED",revert:baselineRevert});
    // The v1 run conclusively identified HandlerNotFound() == 0x4bf4de4e.
    ok(baselineRevert.startsWith("0x4bf4de4e"),"Unexpected baseline revert, refusing unrelated governance changes: "+baselineRevert);
    const updateSelector = vault.interface.getFunction("updateCallbackHandler").selector;
    const permission = await (new Contract(A.access,accessAbi,provider)).canCall(A.owner,A.vault,updateSelector);
    report.governanceAuthorization={selector:updateSelector,immediate:permission[0],delay:as(permission[1])};
    ok(permission[0]&&permission[1]===0n,"Owner cannot register a Morpho callback handler directly");
    // Deploy exact minimal equivalent to upstream CallbackHandlerMorpho on the *ephemeral fork*.
    // No deployed handler/permission is changed on live Katana.
    const handlerSource = 'pragma solidity 0.8.30; contract CallbackHandlerMorpho { struct CallbackData {address asset;address addressToApprove;uint256 amountToApprove;bytes actionData;} function onMorphoFlashLoan(uint256,bytes calldata data) external pure returns (CallbackData memory) {return abi.decode(data,(CallbackData));}}';
    const compiled = JSON.parse(solc.compile(JSON.stringify({
      language:"Solidity",sources:{"CallbackHandlerMorpho.sol":{content:handlerSource}},
      settings:{optimizer:{enabled:true,runs:200},outputSelection:{"*":{"*":["abi","evm.bytecode.object"]}}}
    })));
    const errors=(compiled.errors||[]).filter(x=>x.severity==="error");
    ok(!errors.length,"Morpho handler fork compilation failed: "+JSON.stringify(errors));
    const spec=compiled.contracts["CallbackHandlerMorpho.sol"].CallbackHandlerMorpho;
    const factory=new ContractFactory(spec.abi,"0x"+spec.evm.bytecode.object,await provider.getSigner(A.owner));
    const deployed=await factory.deploy();
    const deployment=await deployed.deploymentTransaction().wait();
    const handlerAddress=await deployed.getAddress();
    const sig=new Interface(["function onMorphoFlashLoan(uint256,bytes)"]).getFunction("onMorphoFlashLoan").selector;
    const registration=await signedVault.updateCallbackHandler(handlerAddress,A.morpho,sig);
    const receipt=await registration.wait();
    ok(receipt.status===1,"Fork-only callback registration reverted");
    report.forkOnlyCallbackRecovery={status:"PASS",handlerAddress,deploymentTx:deployment.hash,
      handlerImplementation:"Upstream CallbackHandlerMorpho function-compatible local deployment",
      sender:A.morpho,selector:sig,registerTx:receipt.hash,
      productionRequired:"A real compatible handler must be deployed/identified and registered via governance; NOT performed on public Katana"};
    step("FORK_ONLY_CALLBACK_REGISTRATION",{status:"PASS",handlerAddress,selector:sig});
    await signedVault.execute.staticCall(actions);
    step("CALL_STATIC_FULL_UNWIND",{status:"PASS",note:"After fork-only callback registration"});
  }
  if(!baselineRevert)step("CALL_STATIC_FULL_UNWIND",{status:"PASS"});

  const estimate = await signedVault.execute.estimateGas(actions);
  const gasLimit = (estimate*120n)/100n+100000n;
  report.gas = {estimated:as(estimate),submittedLimit:as(gasLimit)};
  const tx = await signedVault.execute(actions,{gasLimit});
  report.tx = {hash:tx.hash};
  const receipt = await tx.wait();
  report.tx.gasUsed = as(receipt.gasUsed);
  report.tx.receiptStatus = receipt.status;
  ok(receipt.status===1,"fork unwind transaction reverted");
  report.after = await state();
  ok(BigInt(report.after.borrowShares)===0n,"Morpho borrower shares remain after unwind");
  ok(BigInt(report.after.collateralAvkat)===0n,"Morpho collateral remains after unwind");
  ok(BigInt(report.after.idleAvkat)>BigInt(report.before.idleAvkat),"no collateral recovered to vault");
  step("FULL_MORPHO_EXIT",{status:"PASS",transactionHash:tx.hash,remainingBorrowShares:"0",remainingCollateral:"0"});
  report.status="PASS";
}catch(error){
  report.errors.push({message:String(error.shortMessage||error.message||error),
    code:error.code||null,revertData:error.data||error.info?.error?.data||null});
  console.error(error);
}finally{
  try{await provider.send("anvil_stopImpersonatingAccount",[A.owner]);}catch{}
  await writeFile(OUT,JSON.stringify(report,null,2));
  console.log("Evidence:",OUT,"finalStatus:",report.status);
}
if(report.status!=="PASS")process.exitCode=1;
