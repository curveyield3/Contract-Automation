// v1: Exact queued Katana Safe proposal fork verification. Never broadcasts to public Katana.
// Replays each internal CALL individually, checks intermediate account state, resets,
// then executes the same queued MultiSendCallOnly bytes atomically through the real Safe.
import { writeFile } from "node:fs/promises";
import { JsonRpcProvider, Contract, Interface, formatUnits, getAddress } from "ethers";

const ck = getAddress;
const A = {
  safe:ck("0x47623C62f281807D615eeb4A2CEee9d97F9D3C49"),
  owner:ck("0x11b78837cadc8e894f1c6e13fa9f3a085a75fa35"),
  vault:ck("0xEd83daf48429cfb2C650Fd721b9241e180fd4548"),
  access:ck("0xd7f408f203c5c6a76c9c55c9f6b015929f151faa"),
  multiSend:ck("0x40a2accbd92bca938b02010e17a5b8929b49130d"),
  collateralFuse:ck("0xda9a20690a185daa3b0fd198c6232234835b6929"),
  swapFuse:ck("0x1fb8b83baf40c90f0b450a3fd7a8b2e97ab2a3ff"),
  kat:ck("0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d"),
  avkat:ck("0x7231dbacdfc968e07656d12389ab20de82fbfceb"),
  morpho:ck("0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc"),
  strategy:ck("0x79e88dd967ef9a31046455db94b1e487329ed705"),
  user:ck("0x9f2b20a772246960810045905b7daccf960ee288"),
  market:"0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9"
};
const expectedHash="0x1932f29151d5e36ef682c50958a79979510ca2deaf19f9df9b1f9a9c5f84a621";
const expectedNonce=56n;
const exactWithdraw=228n*10n**18n;
const exactKatSwap=250207268519493588807n;
const ZERO="0x0000000000000000000000000000000000000000";
const provider=new JsonRpcProvider("http://127.0.0.1:8545",747474,{staticNetwork:true});
const ifaceVault=new Interface([
 "function execute((address fuse,bytes data)[] calls_)",
 "function asset() view returns(address)",
 "function authority() view returns(address)",
 "function isFuseSupported(address) view returns(bool)",
 "function balanceOf(address) view returns(uint256)",
 "function maxWithdraw(address) view returns(uint256)",
 "function withdraw(uint256,address,address) returns(uint256)",
 "function totalAssets() view returns(uint256)"
]);
const ifaceCollateral=new Interface(["function exit((bytes32,uint256))"]);
const ifaceSwap=new Interface(["function enter((address,address,uint256,uint256))"]);
const ifaceAccess=new Interface([
 "function grantRole(uint64,address,uint32)",
 "function hasRole(uint64,address) view returns(bool,uint32)",
 "function canCall(address,address,bytes4) view returns(bool,uint32)",
 "function getRoleAdmin(uint64) view returns(uint64)"
]);
const ifaceSafe=new Interface([
 "function getOwners() view returns(address[])",
 "function getThreshold() view returns(uint256)",
 "function nonce() view returns(uint256)",
 "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)",
 "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns(bool)"
]);
const ifaceMulti=new Interface(["function multiSend(bytes transactions)"]);
const vault=new Contract(A.vault,ifaceVault,provider);
const morpho=new Contract(A.morpho,["function position(bytes32,address) view returns(uint256,uint128,uint128)"],provider);
const strategy=new Contract(A.strategy,[
 "function morphoSnapshot() view returns((uint256 collateralAvkat,uint256 debtKat,uint256 collateralValueKat,uint256 ltvBps,uint256 netEquityAvkat))"
],provider);
const kat=new Contract(A.kat,["function balanceOf(address) view returns(uint256)"],provider);
const avkat=new Contract(A.avkat,["function balanceOf(address) view returns(uint256)"],provider);
const access=new Contract(A.access,ifaceAccess,provider);
const safe=new Contract(A.safe,ifaceSafe,provider);
const swapFuse=new Contract(A.swapFuse,[
 "function quoteExactInputView(address,address,uint256) view returns(uint256,uint256)"
],provider);
const report={
 version:"v1",test:"queued-Katana-Safe-roles-collateral-withdraw-KAT-avKAT-swap",
 proposedSafeTxHash:expectedHash,
 mode:"KATANA_LOCAL_ANVIL_FORK_ONLY",status:"FAIL",
 pinnedBlock:null, addresses:A, input:{withdrawAvkatRaw:String(exactWithdraw),swapKatRaw:String(exactKatSwap),safeNonce:String(expectedNonce)},
 phases:[], reference:{}, sequential:{}, atomic:{}, withdrawability:{}, errors:[]
};
const num=x=>BigInt(x);
const dec=x=>formatUnits(x,18);
const check=(cond,message)=>{if(!cond)throw Error("ASSERTION: "+message);};
const phase=(name,values)=>{report.phases.push({name,...values});console.log("PHASE",name,JSON.stringify(values));};
async function state(){
 const [p,s,idleAvkat,idleKat,totalAssets,roles100,roles200]=await Promise.all([
  morpho.position(A.market,A.vault),strategy.morphoSnapshot(),
  avkat.balanceOf(A.vault),kat.balanceOf(A.vault),vault.totalAssets(),
  access.hasRole(100,A.safe),access.hasRole(200,A.safe)
 ]);
 return {
  collateralRaw:String(p[2]),borrowSharesRaw:String(p[1]),debtKatRaw:String(s.debtKat),
  collateralValueKatRaw:String(s.collateralValueKat),ltvBps:String(s.ltvBps),
  idleAvkatRaw:String(idleAvkat),idleKatRaw:String(idleKat),totalAssetsRaw:String(totalAssets),
  roles:{role100:roles100[0],role200:roles200[0]},
  human:{collateralAvkat:dec(p[2]),debtKat:dec(s.debtKat),idleAvkat:dec(idleAvkat),idleKat:dec(idleKat),ltvPercent:(Number(s.ltvBps)/100).toFixed(2)}
 };
}
function pack(target,data){return "00"+target.slice(2).toLowerCase()+"0".repeat(64)+
 ((data.length-2)/2).toString(16).padStart(64,"0")+data.slice(2);}
const calls=[
 {to:A.access,data:ifaceAccess.encodeFunctionData("grantRole",[100n,A.safe,0])},
 {to:A.access,data:ifaceAccess.encodeFunctionData("grantRole",[200n,A.safe,0])},
 {to:A.vault,data:ifaceVault.encodeFunctionData("execute",[[{
  fuse:A.collateralFuse,data:ifaceCollateral.encodeFunctionData("exit",[[A.market,exactWithdraw]])
 },{
  fuse:A.swapFuse,data:ifaceSwap.encodeFunctionData("enter",[[A.kat,A.avkat,exactKatSwap,0n]])
 }]])}
];
const expectedBatch=ifaceMulti.encodeFunctionData("multiSend",["0x"+calls.map(x=>pack(x.to,x.data)).join("")]);
async function sendAs(contract,method,args,asSigner){
 const tx=await contract.connect(asSigner)[method](...args,{gasLimit:10000000n});
 const receipt=await tx.wait();
 check(receipt.status===1,method+" reverted on fork");
 return {hash:tx.hash,gasUsed:String(receipt.gasUsed),blockNumber:receipt.blockNumber};
}
async function testWithdrawFromIdle(snapshotState,label){
 const candidates=[A.user,A.owner,A.safe];
 const balances=await Promise.all(candidates.map(async who=>({who,shares:await vault.balanceOf(who),maxWithdraw:await vault.maxWithdraw(who)})));
 const candidate=balances.find(x=>x.shares>0n&&x.maxWithdraw>=10n**17n);
 const result={label,candidates:balances.map(x=>({address:x.who,shares:String(x.shares),maxWithdrawRaw:String(x.maxWithdraw)})),
  success:false};
 if(!candidate){result.error="No sampled vault-share owner with 0.1 avKAT withdraw allowance";return result;}
 const borrowerBefore=await morpho.position(A.market,A.vault);
 const vaultBefore=await avkat.balanceOf(A.vault);
 const userBefore=await avkat.balanceOf(candidate.who);
 const limit=10n**17n; // 0.1 avKAT as a real user withdrawal proof
 await provider.send("anvil_impersonateAccount",[candidate.who]);
 await provider.send("anvil_setBalance",[candidate.who,"0x3635c9adc5dea00000"]);
 try{
  const signer=await provider.getSigner(candidate.who);
  const tx=await vault.connect(signer).withdraw(limit,candidate.who,candidate.who,{gasLimit:10000000n});
  const receipt=await tx.wait();
  check(receipt.status===1,"user ERC-4626 withdrawal failed");
  const borrowerAfter=await morpho.position(A.market,A.vault);
  const vaultAfter=await avkat.balanceOf(A.vault);
  const userAfter=await avkat.balanceOf(candidate.who);
  check(userAfter-userBefore===limit,"user did not receive exact 0.1 avKAT");
  check(vaultBefore-vaultAfter>=limit,"vault did not pay from own avKAT balance");
  check(borrowerAfter[2]===borrowerBefore[2]&&borrowerAfter[1]===borrowerBefore[1],
   "user withdrawal unexpectedly changed Morpho position");
  result.success=true;result.account=candidate.who;
  result.amountAvkat="0.1";result.userReceivedAvkat=dec(userAfter-userBefore);
  result.vaultIdleAvkatSpent=dec(vaultBefore-vaultAfter);
  result.morphoCollateralUnchanged=true;result.morphoBorrowSharesUnchanged=true;
  result.receipt={hash:tx.hash,gasUsed:String(receipt.gasUsed)};
 }catch(e){result.error=String(e.shortMessage||e.message||e);}
 finally{await provider.send("anvil_stopImpersonatingAccount",[candidate.who]);}
 return result;
}
try{
 const client=String(await provider.send("web3_clientVersion",[])).toLowerCase();
 check(client.includes("anvil"),"RPC must be localhost Anvil");
 check((await provider.getNetwork()).chainId===747474n,"Chain ID must be Katana 747474");
 const block=await provider.getBlock("latest");
 report.pinnedBlock={number:block.number,hash:block.hash,timestamp:block.timestamp};
 check((await vault.asset()).toLowerCase()===A.avkat.toLowerCase(),"vault asset mismatch");
 check((await vault.authority()).toLowerCase()===A.access.toLowerCase(),"access manager mismatch");
 for(const f of [A.collateralFuse,A.swapFuse]) check(await vault.isFuseSupported(f),"unsupported installed fuse "+f);
 const [nonce,owners,threshold,admin100,admin200,role1]=await Promise.all([
  safe.nonce(),safe.getOwners(),safe.getThreshold(),access.getRoleAdmin(100),access.getRoleAdmin(200),access.hasRole(1,A.safe)
 ]);
 check(nonce===expectedNonce,"queued proposal nonce stale: "+nonce);
 check(threshold===1n&&owners.some(x=>x.toLowerCase()===A.owner.toLowerCase()),"Safe owner/threshold mismatch");
 check(admin100===1n&&admin200===100n&&role1[0],"role bootstrap hierarchy invalid");
 const signedHash=await safe.getTransactionHash(A.multiSend,0n,expectedBatch,1,0n,0n,0n,ZERO,ZERO,nonce);
 check(signedHash.toLowerCase()===expectedHash.toLowerCase(),"generated calldata DOES NOT match actual queued Safe hash");
 const before=await state();report.reference.before=before;
 const quote=await swapFuse.quoteExactInputView(A.kat,A.avkat,exactKatSwap);
 report.reference.routerQuote={expectedAvkatRaw:String(quote[0]),minimumAvkatRaw:String(quote[1]),expectedAvkat:dec(quote[0]),minimumAvkat:dec(quote[1])};
 check(num(before.idleKatRaw)>=exactKatSwap,"vault KAT balance below fixed queued swap amount");
 check(num(before.collateralRaw)>exactWithdraw,"insufficient Morpho collateral");
 check(!before.roles.role100&&!before.roles.role200,"Safe roles already granted, stale queued transaction");
 const forkStart=await provider.send("evm_snapshot",[]);
 await provider.send("anvil_impersonateAccount",[A.safe]);
 await provider.send("anvil_setBalance",[A.safe,"0x3635c9adc5dea00000"]);
 const safeSigner=await provider.getSigner(A.safe);
 const grant100=await sendAs(access,"grantRole",[100n,A.safe,0],safeSigner);
 const after100=await state();
 check(after100.roles.role100&&!after100.roles.role200,"first role grant incorrect");
 check(after100.collateralRaw===before.collateralRaw&&after100.idleAvkatRaw===before.idleAvkatRaw&&after100.idleKatRaw===before.idleKatRaw,"assets changed during first grant");
 phase("01_GRANT_ADMIN_ROLE",{tx:grant100,state:after100});
 const grant200=await sendAs(access,"grantRole",[200n,A.safe,0],safeSigner);
 const after200=await state();
 check(after200.roles.role100&&after200.roles.role200,"second role grant incorrect");
 check(after200.collateralRaw===before.collateralRaw&&after200.idleAvkatRaw===before.idleAvkatRaw&&after200.idleKatRaw===before.idleKatRaw,"assets changed during second grant");
 phase("02_GRANT_ALPHA_ROLE",{tx:grant200,state:after200});
 const authz=await access.canCall(A.safe,A.vault,ifaceVault.getFunction("execute").selector);
 check(authz[0]&&authz[1]===0n,"Safe still not allowed to execute");
 const collateralTx=await sendAs(vault,"execute",[[{fuse:A.collateralFuse,data:ifaceCollateral.encodeFunctionData("exit",[[A.market,exactWithdraw]])}]],safeSigner);
 const afterExit=await state();
 check(num(before.collateralRaw)-num(afterExit.collateralRaw)===exactWithdraw,"exact 228 avKAT was not withdrawn from Morpho");
 check(num(afterExit.idleAvkatRaw)-num(before.idleAvkatRaw)===exactWithdraw,"exact 228 avKAT not credited idle to vault");
 check(afterExit.idleKatRaw===before.idleKatRaw,"KAT changed in withdrawal phase");
 phase("03_MORPHO_COLLATERAL_EXIT",{tx:collateralTx,state:afterExit,withdrawnAvkat:dec(exactWithdraw)});
 const swapTx=await sendAs(vault,"execute",[[{fuse:A.swapFuse,data:ifaceSwap.encodeFunctionData("enter",[[A.kat,A.avkat,exactKatSwap,0n]])}]],safeSigner);
 const afterSwap=await state();report.sequential.final=afterSwap;
 const swappedAvkat=num(afterSwap.idleAvkatRaw)-num(afterExit.idleAvkatRaw);
 check(num(afterExit.idleKatRaw)-num(afterSwap.idleKatRaw)===exactKatSwap,"exact queued KAT swap input not consumed");
 check(swappedAvkat>=quote[1],"avKAT received below configured router minimum");
 check(swappedAvkat>0n,"swap produced no avKAT");
 check(num(afterSwap.ltvBps)<7700n,"resulting LTV at/above Morpho liquidation threshold");
 check(num(afterSwap.ltvBps)>=7650n&&num(afterSwap.ltvBps)<=7670n,
  "LTV not near requested just-under-76.7%; actual "+afterSwap.ltvBps+" bps");
 check(num(afterSwap.idleAvkatRaw)===num(before.idleAvkatRaw)+exactWithdraw+swappedAvkat,
  "withdrawn + swapped avKAT does not reconcile to vault idle balance");
 report.sequential.swap={inputKat:dec(exactKatSwap),outputAvkat:dec(swappedAvkat),outputAvkatRaw:String(swappedAvkat)};
 phase("04_KAT_TO_AVKAT_SWAP",{tx:swapTx,state:afterSwap,swap:report.sequential.swap,
  resultingLtvBps:afterSwap.ltvBps,newlyIdleAvkat:dec(num(afterSwap.idleAvkatRaw)-num(before.idleAvkatRaw))});
 // The sampled ERC-4626 withdrawal is made on a disposable fork snapshot only.
 const withdrawSnap=await provider.send("evm_snapshot",[]);
 report.withdrawability.sequential=await testWithdrawFromIdle(afterSwap,"after_sequential_replay");
 phase("05_USER_WITHDRAW_IDLE",{...report.withdrawability.sequential});
 await provider.send("evm_revert",[withdrawSnap]);
 check(await provider.send("evm_revert",[forkStart]),"fork baseline revert failed");
 // Reproduce the exact Safe proposal in a single atomic on-fork execTransaction.
 await provider.send("anvil_setBalance",[A.owner,"0x3635c9adc5dea00000"]);
 await provider.send("anvil_impersonateAccount",[A.owner]);
 const ownerSigner=await provider.getSigner(A.owner);
 const sig="0x"+A.owner.slice(2).toLowerCase().padStart(64,"0")+"0".repeat(64)+"01";
 const args=[A.multiSend,0n,expectedBatch,1,0n,0n,0n,ZERO,ZERO,sig];
 const sim=await safe.connect(ownerSigner).execTransaction.staticCall(...args);
 check(sim===true,"atomic Safe execTransaction.staticCall not successful");
 const beforeAtomic=await state();
 const gas=await safe.connect(ownerSigner).execTransaction.estimateGas(...args);
 const safeTx=await safe.connect(ownerSigner).execTransaction(...args,{gasLimit:gas*12n/10n+100000n});
 const receipt=await safeTx.wait();
 check(receipt.status===1,"actual Safe fork execution reverted");
 const afterAtomic=await state();
 const hashAfter=await safe.nonce();
 check(hashAfter===expectedNonce+1n,"Safe nonce did not increment");
 check(afterAtomic.roles.role100&&afterAtomic.roles.role200,"expected Safe role grants not persisted");
 check(num(beforeAtomic.collateralRaw)-num(afterAtomic.collateralRaw)===exactWithdraw,"atomic collateral delta mismatch");
 check(num(beforeAtomic.idleKatRaw)-num(afterAtomic.idleKatRaw)===exactKatSwap,"atomic KAT consumed mismatch");
 const atomReceived=num(afterAtomic.idleAvkatRaw)-num(beforeAtomic.idleAvkatRaw)-exactWithdraw;
 check(atomReceived>=quote[1],"atomic avKAT swapped less than quote minimum");
 check(num(afterAtomic.ltvBps)>=7650n&&num(afterAtomic.ltvBps)<=7670n&&num(afterAtomic.ltvBps)<7700n,
  "atomic LTV not just below 76.7%");
 const drift=atomReceived>swappedAvkat?atomReceived-swappedAvkat:swappedAvkat-atomReceived;
 check(drift<=10n**16n,"sequential vs atomic router output differs by > 0.01 avKAT");
 report.atomic={receipt:{hash:safeTx.hash,gasUsed:String(receipt.gasUsed),status:receipt.status},
  originalSafeProposalHash:expectedHash,actualSafeNonceAfter:String(hashAfter),
  before:beforeAtomic,after:afterAtomic,
  swappedAvkatRaw:String(atomReceived),swappedAvkat:dec(atomReceived),
  idleRecoveredAvkat:dec(num(afterAtomic.idleAvkatRaw)-num(beforeAtomic.idleAvkatRaw)),
  resultingLtvBps:afterAtomic.ltvBps,
  matchesSequential:true};
 phase("06_EXACT_QUEUED_SAFE_MULTISEND_ATOMIC",{tx:report.atomic.receipt,after:afterAtomic,
  swapOutputAvkat:report.atomic.swappedAvkat,ltvBps:afterAtomic.ltvBps});
 const atomWithdrawSnap=await provider.send("evm_snapshot",[]);
 report.withdrawability.atomic=await testWithdrawFromIdle(afterAtomic,"after_exact_atomic_batch");
 phase("07_ATOMIC_IDLE_WITHDRAW_PROOF",report.withdrawability.atomic);
 await provider.send("evm_revert",[atomWithdrawSnap]);
 check(report.withdrawability.sequential.success&&report.withdrawability.atomic.success,
  "did not demonstrate a real successful user withdraw from idle vault avKAT");
 report.status="PASS";
}catch(e){
 report.errors.push({message:String(e.shortMessage||e.message||e),code:e.code||null,revert:e.data||e.info?.error?.data||null});
 console.error("FORK_VERIFICATION_ERROR",e);
}finally{
 try{await provider.send("anvil_stopImpersonatingAccount",[A.safe]);}catch{}
 try{await provider.send("anvil_stopImpersonatingAccount",[A.owner]);}catch{}
 await writeFile("cyavkat-safe-proposal-ltv-swap-v1-report.json",JSON.stringify(report,null,2));
 console.log("FINAL_REPORT",JSON.stringify({status:report.status,proposalHash:report.proposedSafeTxHash,
  after:report.atomic.after,swap:report.atomic.swappedAvkat,
  withdrawalProof:report.withdrawability.atomic,error:report.errors},null,2));
}
if(report.status!=="PASS")process.exitCode=1;
