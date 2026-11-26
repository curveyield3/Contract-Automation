// Exact deployed Guardian v64 planning and encoding methods; isolated fork adapter only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Interface, AbiCoder, keccak256, toUtf8Bytes, hexlify, toBeHex, JsonRpcProvider} from 'ethers';
const parseAbi=a=>a, coder=AbiCoder.defaultAbiCoder();
const param=p=>p.type==='tuple[]'?'tuple('+p.components.map(x=>x.type+' '+x.name).join(',')+')[]':p.type;
const encodeAbiParameters=(p,v)=>coder.encode(p.map(param),v);
const decodeAbiParameters=(p,v)=>coder.decode(p.map(param),v);
const encodeFunctionData=({abi,functionName,args=[]})=>new Interface(abi).encodeFunctionData(functionName,args);
const toHex=(v,o)=>typeof v==='string'?hexlify(toUtf8Bytes(v)):toBeHex(v,o?.size);
const errMsg=(e,n)=>String(e?.shortMessage||e?.message||e).slice(0,n);
var GUARDIAN_V23_MODULE="0xb0832aFff2387eDb89D799b967b49f910eFC343D",GUARDIAN_V23_ABI=parseAbi(["function SAFE() view returns(address)","function SWAPPER() view returns(address)","function MERKL_DISTRIBUTOR() view returns(address)","function LOOP_MARKET() view returns(bytes32)","function targetLtv() view returns(uint256)","function MAX_LTV() view returns(uint256)","function maxFlashKat() view returns(uint256)","function ltvOf() view returns(uint256)","function isExecutor(address) view returns(bool)","function ranges(uint256) view returns(address,address,address,address,uint24,uint256,uint32,uint16,uint64,uint64,uint16,bool)","function vaults(address) view returns(uint8,address,address,bool)","function topOffExecutorGas() returns(uint256)","function claimKat(uint256,bytes32[])","function executeApprovedSwaps((address,address,uint256)[])","function addRangeLiquidity(uint256,uint256,uint256,uint256,uint256,uint256,(address,address,uint256)[])","function withdrawRange(uint256,uint128,uint256,uint256,bool)","function rebalanceRange(uint256,uint256,uint256,(address,address,uint256)[],(int24,int24,uint256,uint256,uint256,uint256,uint256)) returns(uint256)","function createRangeLiquidity(uint256,(int24,int24,uint256,uint256,uint256,uint256,uint256),(address,address,uint256)[]) returns(uint256)","function depositVault(address,uint256,uint256,uint256,uint256,uint256,(address,address,uint256)[])","function withdrawVault(address,uint256,uint256,uint256)","function deleverageWithSafeKat(uint256) returns(uint256)","function atomicLoopUp(((uint256,uint128,uint256,uint256,bool)[],(address,uint256,uint256,uint256)[],(address,address,uint256)[]),(uint256,uint256,uint256,uint256,uint256))","function atomicDeleverage(((uint256,uint128,uint256,uint256,bool)[],(address,uint256,uint256,uint256)[],(address,address,uint256)[]),(uint256,uint256,uint256,uint256,uint256,uint256,uint256))"]),GUARDIAN_V23_SAFE_ABI=parseAbi(["function isModuleEnabled(address) view returns(bool)"]);
const MORPHO="0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc",NPM="0x2659C6085D26144117D904C46B48B6d180393d27",FACTORY="0x203e8740894c8955cB8950759876d7E7E45E04c1",KAT="0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d",AVKAT="0x7231dbaCdFc968E07656D12389AB20De82FbfCeB",WETH="0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62",USDC="0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36";
const ABI=parseAbi(['function getPool(address,address,uint24) view returns(address)']);
const SAFE='0xF39087af2107EaDBf81f10a64051740A76B6291D',BOT='0xe7355a4fca376883fb775466ac8736c72ca19118',SOURCE='0x0a8f3fd0965bfa6e94339cca629bec6ddac99f697ac74d808aa2d9f2c46b5f68',DEST='0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9',POOL='0x8640e1867bd563b2ab865160e77cb7b875243b13',ROUTER='0x01f9894f92ea9224fecc8c35482e20a05de13582',ORACLE='0xc5d4f6f7b1f5dec7ec191d3612388f95f5f7f47c';
const rpc=new JsonRpcProvider('http://127.0.0.1:8545',747474,{staticNetwork:true});
const req=(m,p=[])=>rpc.send(m,p),tag=b=>b==null?'latest':'0x'+BigInt(b).toString(16);
const serial=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v));
const report={version:'Guardian v64 / Cloudflare 152',scenario:'21% fee-adjusted discount via fork-only destination oracle fixture; pool, liquidity and positions unmodified',status:'STARTED'};
const output=()=>{fs.writeFileSync('guardian-21pct-fork-v1-report.json',JSON.stringify(serial(report),null,2));console.log(JSON.stringify(serial(report),null,2));};
let migrationCall;
const normalize=x=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x)?x.toLowerCase():Array.isArray(x)?Array.from(x,normalize):x;
const callArgs=({address,to,data,account})=>({to:(address||to).toLowerCase(),data,...account?{from:account.toLowerCase()}:{}});
const pub={
 async getBlock(){const b=await req('eth_getBlockByNumber',['latest',false]);return {number:BigInt(b.number),timestamp:BigInt(b.timestamp),hash:b.hash,baseFeePerGas:BigInt(b.baseFeePerGas)}},
 async readContract({address,abi,functionName,args=[],blockNumber}){const I=new Interface(abi),data=I.encodeFunctionData(functionName,normalize(args));const ret=await req('eth_call',[{to:address.toLowerCase(),data},tag(blockNumber)]);const out=I.decodeFunctionResult(functionName,ret);return out.length===1?out[0]:out},
 async simulateContract(o){return{result:await this.readContract(o)}},
 async getStorageAt({address,slot,blockNumber}){return req('eth_getStorageAt',[address.toLowerCase(),slot,tag(blockNumber)])},
 async call(o){migrationCall=callArgs(o);return req('eth_call',[migrationCall,tag(o.blockNumber)])},
 async estimateGas(o){return BigInt(await req('eth_estimateGas',[callArgs(o)]))}
};
class Planner{constructor(){this.pub=pub;this.env={SAFE};this.account={address:BOT}}
async buildMorphoBundleV13(plan,router,blockNumber){
const bundler="0xA8C5e23C9C0DF2b6fF716486c6bBEBB6661548C8",adapter="0x916Aa175C36E845db45fF6DDB886AE437d403B61",zero="0x"+"00".repeat(32),max=(1n<<256n)-1n;
const component=[{name:"to",type:"address"},{name:"data",type:"bytes"},{name:"value",type:"uint256"},{name:"skipRevert",type:"bool"},{name:"callbackHash",type:"bytes32"}],tuple={type:"tuple[]",components:component};
const swapAbi=parseAbi(["function swapExactInput(address,address,uint256,uint256,address,uint256)"]),erc=parseAbi(["function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)"]),flashAbi=parseAbi(["function morphoFlashLoan(address,uint256,bytes)"]),bundleAbi=parseAbi(["function multicall((address to,bytes data,uint256 value,bool skipRevert,bytes32 callbackHash)[] bundle) payable"]),wrapperAbi=parseAbi(["function execute(bytes32 market,bytes data,uint256 deadline)"]);
const swapSelector=keccak256(toHex("swapExactInput(address,address,uint256,uint256,address,uint256)")).slice(0,10),allowances=new Map,normal=x=>({to:x.to,data:x.data,value:0n,skipRevert:false,callbackHash:zero});
const calls=async list=>{const result=[];for(const entry of list||[]){const c=normal(entry);if(c.to.toLowerCase()===router.toLowerCase()&&c.data.slice(0,10).toLowerCase()===swapSelector.toLowerCase()){
const [token,,amount]=decodeAbiParameters([{type:"address"},{type:"address"},{type:"uint256"},{type:"uint256"},{type:"address"},{type:"uint256"}],"0x"+c.data.slice(10)),key=token.toLowerCase();let allowance=allowances.get(key);
if(allowance===undefined)allowance=await this.pub.readContract({address:token,abi:erc,functionName:"allowance",args:[bundler,router],...blockNumber===undefined?{}:{blockNumber}});
if(allowance<amount){result.push(normal({to:token,data:encodeFunctionData({abi:erc,functionName:"approve",args:[router,max]})}));allowance=max}
allowances.set(key,allowance===max?max:allowance-amount)
}result.push(c)}return result};
const before=await calls(plan.before),during=await calls(plan.during),after=await calls(plan.after),callback=encodeAbiParameters([tuple],[during]),flash={to:adapter,data:encodeFunctionData({abi:flashAbi,functionName:"morphoFlashLoan",args:[plan.flashToken,BigInt(plan.flashAmount),callback]}),value:0n,skipRevert:false,callbackHash:keccak256(callback)},bundleData=encodeFunctionData({abi:bundleAbi,functionName:"multicall",args:[[...before,...(BigInt(plan.flashAmount)>0n?[flash]:[]),...after]]}),wrapperData=encodeFunctionData({abi:wrapperAbi,functionName:"execute",args:[plan.market,bundleData,BigInt(plan.deadline)]});
return{bundler,adapter,bundleData,wrapperData,callbackHash:flash.callbackHash};
}
// Encoding only: the operation planner supplies settled source bundles and the existing primary loop-up calldata.
encodeMorphoMigrationV13(sources,loopUpData,deadline){
const abi=parseAbi(["function migrate((bytes32 market,bytes data)[] sources,bytes loopUpData,uint256 deadline)"]);
return encodeFunctionData({abi,functionName:"migrate",args:[sources.map(x=>({market:x.market,data:x.bundleData})),loopUpData,BigInt(deadline)]})
}
async spCheck(cfg,s){
const mode="weeth-avkat-planning",tierRules=[{discountBps:2000,allocationBps:5000},{discountBps:2200,allocationBps:10000}],id="0x0a8f3fd0965bfa6e94339cca629bec6ddac99f697ac74d808aa2d9f2c46b5f68",we="0x9893989433e7a383cb313953e4c2365107dc19a7",us="0x2dca96907fde857dd3d816880a0df407eeb2d2f2",safe=this.env.SAFE,W=10n**18n,B=10000n,Q=10n**36n;
const min=(...x)=>x.reduce((a,b)=>a<b?a:b),ceil=(a,b)=>(a+b-1n)/b,serial=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==="bigint"?v.toString():v));
try{
const block=await this.pub.getBlock(),bn=block.number,read=(address,abi,functionName,args=[])=>this.pub.readContract({address,abi,functionName,args,blockNumber:bn});
const migrationModule="0x53877cd4111b4c041abea77cc501ed68c22630bd",migrationAbi=parseAbi(["function SAFE() view returns(address)","function PRIMARY() view returns(address)","function isExecutor(address) view returns(bool)","function marketAllowed(bytes32) view returns(bool)"]),gasPolicy={maxBaseFeeWei:"80000000",defaultPriorityFeeWei:"20000000",maxFeePerGasWei:"100000000",baseFeeWei:String(block.baseFeePerGas??0n),baseFeeEligible:block.baseFeePerGas!=null&&block.baseFeePerGas<=80000000n};
const [installed,authorized,allowed,moduleSafe,primary]=await Promise.all([read(safe,GUARDIAN_V23_SAFE_ABI,"isModuleEnabled",[migrationModule]),read(migrationModule,migrationAbi,"isExecutor",[this.account?.address||"0xE7355a4fcA376883fb775466AC8736C72ca19118"]),read(migrationModule,migrationAbi,"marketAllowed",[id]),read(migrationModule,migrationAbi,"SAFE"),read(migrationModule,migrationAbi,"PRIMARY")]);const migrationReady=installed&&authorized&&allowed&&moduleSafe.toLowerCase()===safe.toLowerCase()&&primary.toLowerCase()===GUARDIAN_V23_MODULE.toLowerCase();
const mor=parseAbi(["function idToMarketParams(bytes32) view returns(address,address,address,address,uint256)","function market(bytes32) view returns(uint128,uint128,uint128,uint128,uint128,uint128)","function position(bytes32,address) view returns(uint256,uint128,uint128)"]),erc=parseAbi(["function balanceOf(address) view returns(uint256)"]),oabi=parseAbi(["function price() view returns(uint256)"]),irm=parseAbi(["function borrowRateView((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)) view returns(uint256)"]),ra=parseAbi(["function routeFor(address,address) view returns(bytes)","function twapMinimumOut(address,address,uint256) view returns(uint256)"]),qa=parseAbi(["function quoteExactInput(bytes,uint256) returns(uint256,uint160[],uint32[],uint256)"]),pa=parseAbi(["function token0() view returns(address)","function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)"]);
const [avId,router,target,policyFlash,sourcePos,sourceMarket,sourceParams]=await Promise.all([read(GUARDIAN_V23_MODULE,GUARDIAN_V23_ABI,"LOOP_MARKET"),read(GUARDIAN_V23_MODULE,GUARDIAN_V23_ABI,"SWAPPER"),read(GUARDIAN_V23_MODULE,GUARDIAN_V23_ABI,"targetLtv"),read(GUARDIAN_V23_MODULE,GUARDIAN_V23_ABI,"maxFlashKat"),read(MORPHO,mor,"position",[id,safe]),read(MORPHO,mor,"market",[id]),read(MORPHO,mor,"idToMarketParams",[id])]);
if(sourceParams[0].toLowerCase()!==us||sourceParams[1].toLowerCase()!==we)throw Error("weETH market identity mismatch");
const [avPos,avMarket,avParams,katLiquidity,looseKat,looseAv]=await Promise.all([read(MORPHO,mor,"position",[avId,safe]),read(MORPHO,mor,"market",[avId]),read(MORPHO,mor,"idToMarketParams",[avId]),read(KAT,erc,"balanceOf",[MORPHO]),read(KAT,erc,"balanceOf",[safe]),read(AVKAT,erc,"balanceOf",[safe])]);
if(avParams[0].toLowerCase()!==KAT.toLowerCase()||avParams[1].toLowerCase()!==AVKAT.toLowerCase())throw Error("avKAT market identity mismatch");
const accrued=async(mp,m,at=block.timestamp)=>{const elapsed=at-BigInt(m[4]);if(elapsed<=0n||!m[2])return m[2];const rate=await read(mp[3],irm,"borrowRateView",[mp,m]);const x=rate*elapsed,y=x*x/(2n*W),z=y*x/(3n*W);return m[2]+m[2]*(x+y+z)/W};
const [sourceBorrow,avBorrow,intrinsic,sourceOracle]=await Promise.all([accrued(sourceParams,sourceMarket),accrued(avParams,avMarket),read(avParams[2],oabi,"price"),read(sourceParams[2],oabi,"price")]);if(!intrinsic||!sourceOracle)throw Error("Zero market oracle");
const debt=(shares,assets,totalShares)=>ceil(shares*(assets+1n),totalShares+1000000n),sourceDebt=debt(sourcePos[1],sourceBorrow,sourceMarket[3]),avDebt=debt(avPos[1],avBorrow,avMarket[3]),avValue=avPos[2]*intrinsic/Q;
const feeSlot=await this.pub.getStorageAt({address:router,slot:toHex(1n,{size:32}),blockNumber:bn}),globalFee=Number((BigInt(feeSlot||"0x0")>>160n)&65535n),cache=new Map;
const route=async(a,b)=>{const key=a.toLowerCase()+":"+b.toLowerCase();if(cache.has(key))return cache.get(key);const path=await read(router,ra,"routeFor",[a,b]);if(path==="0x")throw Error("Missing configured OmniSwapper route "+key);const k=keccak256(encodeAbiParameters([{type:"address"},{type:"address"}],[a,b])),slot=n=>keccak256(encodeAbiParameters([{type:"bytes32"},{type:"uint256"}],[k,BigInt(n)])),[flag,f]=await Promise.all([this.pub.getStorageAt({address:router,slot:slot(4),blockNumber:bn}),this.pub.getStorageAt({address:router,slot:slot(3),blockNumber:bn})]);const fee=BigInt(flag||"0x0")!==0n?Number(BigInt(f||"0x0")&65535n):globalFee;if(fee>2000)throw Error("Unexpected router fee layout");const result={path,fee};cache.set(key,result);return result};
const quote=async(a,b,amt)=>{if(!amt)return{net:0n,sqrt:0n};const rt=await route(a,b),{result}=await this.pub.simulateContract({address:"0x92dea23ED1C683940fF1a2f8fE23FE98C5d3041c",abi:qa,functionName:"quoteExactInput",args:[rt.path,amt],blockNumber:bn});return{net:result[0]-result[0]*BigInt(rt.fee)/B,sqrt:result[1][result[1].length-1]}};
const deadline=block.timestamp+180n,deadlineBorrow=await accrued(sourceParams,sourceMarket,deadline);
const sourceLeg=async(a,b,amt)=>{if(!amt)return{net:0n,floor:0n};const [q,floor]=await Promise.all([quote(a,b,amt),read(router,ra,"twapMinimumOut",[a,b,amt])]);if(!floor||q.net<floor)throw Error("Source quote below configured TWAP floor");return{net:q.net,floor}};
const toSeed=async(c)=>{if(!c)return{collateral:0n,shares:0n,debt:0n,kat:0n,minKat:0n};const shares=c===sourcePos[2]?sourcePos[1]:ceil(sourcePos[1]*c,sourcePos[2]),repay=debt(shares,sourceBorrow,sourceMarket[3]),maxDebt=shares?debt(shares,deadlineBorrow,sourceMarket[3])+1n:0n;const w=await sourceLeg(we,WETH,c),uc=await sourceLeg(WETH,USDC,w.floor),usd=await sourceLeg(USDC,us,uc.floor);const convertUs=usd.floor>maxDebt?usd.floor-maxDebt:0n,kat=await sourceLeg(us,KAT,convertUs);return{collateral:c,shares,debt:repay,maxDebt,usd:usd.floor,convertUs,kat:kat.net,minKat:kat.floor}};
const ar=await route(KAT,AVKAT);if(ar.path.length!==88)throw Error("Current KAT-avKAT route is not one hop; marginal price requires new route assessment");
const poolFee=BigInt("0x"+ar.path.slice(42,48)),pool=await read(FACTORY,ABI,"getPool",[KAT,AVKAT,Number(poolFee)]);if(poolFee!==10000n||pool.toLowerCase()!=="0x8640e1867bd563b2ab865160e77cb7b875243b13")throw Error("Configured KAT-avKAT route is not the required 1% pool");const [token0,slot]=await Promise.all([read(pool,pa,"token0"),read(pool,pa,"slot0")]),q192=2n**192n,priceParts=sqrt=>token0.toLowerCase()===AVKAT.toLowerCase()?[sqrt*sqrt,q192]:[q192,sqrt*sqrt],supports=(sqrt,d)=>{const[n,den]=priceParts(sqrt);return n*Q*1000000n*B*B<=den*intrinsic*(1000000n-poolFee)*(B-BigInt(ar.fee))*(B-BigInt(d))},[n,den]=priceParts(slot[0]),marginal=Number(n)/Number(den)*1e6/(1e6-Number(poolFee))*10000/(10000-ar.fee),discountBps=Math.floor((1-marginal/(Number(intrinsic)/1e36))*1e4);
const tier=[...tierRules].reverse().find(t=>supports(slot[0],t.discountBps)),full=await toSeed(sourcePos[2]),baseline=s.weethMigration?.baseline||{block:String(bn),collateral:String(sourcePos[2]),borrowShares:String(sourcePos[1])},baseCol=BigInt(baseline.collateral),consumed=baseCol>sourcePos[2]?baseCol-sourcePos[2]:0n;
const snapshot={mode,block:String(bn),blockHash:block.hash,tierRules,discountBps,gasPolicy,migrationModule,migrationReady,migrationChecks:{installed,authorized,allowed,moduleSafe,primary},route:ar.path,pool,poolFee:Number(poolFee),routerFeeBps:ar.fee,source:{market:id,collateral:String(sourcePos[2]),borrowShares:String(sourcePos[1]),debt:String(sourceDebt),oraclePrice:String(sourceOracle),netEquityKatWei:String(full.kat)},destination:{market:avId,collateral:String(avPos[2]),debt:String(avDebt),targetLtv:String(target),moduleFlashCap:String(policyFlash)},baseline,observedSourceCollateralReduction:String(consumed),looseKat:String(looseKat),looseAvkat:String(looseAv),allocationBps:tier?.allocationBps||0,execution:"v13 module tracked; settlement simulation not yet performed; no transaction submitted",bundleEncoder:"buildMorphoBundleV13",migrationEncoder:"encodeMorphoMigrationV13",sourceQuoteNote:"Pinned-block sequential quotes; actual atomic execution and accrued-share repayment must be verified; collateral reduction is provisional until migration receipts can be reconciled"};
s.weethMigration=snapshot;
if(cfg.paused||!tier||!sourcePos[2]||!full.kat||!migrationReady)return{...snapshot,idle:cfg.paused?"paused":!migrationReady?"migration module authorization or identity mismatch":!tier?"discount below 20%":"no positive source equity"};
if(sourcePos[2]>baseCol)return{...snapshot,idle:"source position increased since baseline; allocation accounting needs reconciliation"};
const capCol=baseCol*BigInt(tier.allocationBps)/B,availableCol=capCol>consumed?min(sourcePos[2],capCol-consumed):0n;if(!availableCol)return{...snapshot,idle:"cumulative allocation reached"};
let seed=await toSeed(availableCol);if(!seed.kat)return{...snapshot,idle:"allocated unwind has no positive KAT proceeds"};
const interest=avBorrow-avMarket[2],supply=avMarket[0]+interest,liquid=supply>avBorrow?supply-avBorrow:0n,flashCapacity=min(katLiquidity/2n,liquid,policyFlash),floorRate=ceil(10n**54n*B,intrinsic*(B-BigInt(tier.discountBps)));
// Size from the actual source-conversion proceeds; keep the original primary module.
const fullCapital=seed.kat+looseKat,fullMinCapital=(seed.minKat??seed.kat)+looseKat;
const twap=async(total)=>total?read(router,ra,"twapMinimumOut",[KAT,AVKAT,total]):0n;
const canFlash=async(flash,capital)=>{const total=capital+flash;if(!total)return false;const out=await twap(total);return out>0n&&avDebt+flash<=(avValue+(out+looseAv)*intrinsic/Q)*target/W};
const maxFlashFor=async(capital,cap)=>{let l=0n,h=cap;for(let i=0;i<36&&l<h;i++){const m=l+(h-l+1n)/2n;if(await canFlash(m,capital).catch(()=>false))l=m;else h=m-1n}return l};
const fullFlash=await maxFlashFor(fullMinCapital,flashCapacity),fundedTotal=fullCapital+fullFlash;
const depth=async(total)=>{if(!total)return{ok:true,out:0n,floor:0n};const q=await quote(KAT,AVKAT,total),floor=await twap(total);return{ok:!!q.net&&!!floor&&q.net>=floor&&q.net*W>=total*floorRate&&supports(q.sqrt,tier.discountBps),out:q.net,floor,sqrt:q.sqrt}};
let lo=0n,hi=fundedTotal;
const fullDepth=await depth(hi).catch(()=>({ok:false}));if(fullDepth.ok)lo=hi;
else for(let i=0;i<28&&lo<hi;i++){const mid=lo+(hi-lo+1n)/2n;const q=await depth(mid).catch(()=>({ok:false}));if(q.ok)lo=mid;else hi=mid-1n}
const poolCapacity=lo;if(poolCapacity<=looseKat)return{...snapshot,idle:"no additional pool depth at required discount"};
// Preserve the planned funding/leverage mix when pool depth, rather than capital, binds.
const scaledCapital=ceil(poolCapacity*fullCapital,fundedTotal),sourceSeedNeeded=scaledCapital>looseKat?scaledCapital-looseKat:0n;
if(!sourceSeedNeeded)return{...snapshot,idle:"existing Safe KAT fills the source-funding portion of the available depth"};
if(sourceSeedNeeded<seed.kat){let cl=0n,ch=availableCol;for(let i=0;i<24&&cl<ch;i++){const mid=cl+(ch-cl+1n)/2n;let x;try{x=await toSeed(mid)}catch(e){x=null}if(x&&x.kat<=sourceSeedNeeded)cl=mid;else ch=mid-1n}seed=await toSeed(cl)}
const capital=seed.kat+looseKat,minCapital=(seed.minKat??seed.kat)+looseKat;
if(!seed.kat||capital>=poolCapacity)return{...snapshot,idle:"no positive flash-sized migration fits quoted depth"};
const flash=await maxFlashFor(minCapital,min(flashCapacity,poolCapacity-capital));if(!flash)return{...snapshot,idle:"no positive flash at existing target LTV"};
lo=capital+flash;const q=await depth(lo);if(!q.ok)return{...snapshot,idle:"joint allocation and DEX bound requires a fresh quote"};
const result={...q,flash};
const plan=serial({thresholdDiscountBps:tier.discountBps,allocationBps:tier.allocationBps,allocatedCollateralCap:availableCol,unwindCollateral:seed.collateral,repayBorrowShares:seed.shares,estimatedVbUsdtDebt:seed.debt,estimatedSeedKat:seed.kat,minSeedKat:seed.minKat??seed.kat,existingSafeKat:looseKat,availableFundingKat:fullCapital,fullAllocationLeveragedKat:fundedTotal,quotedPoolCapacityKat:poolCapacity,requiredSourceSeedKat:sourceSeedNeeded,remainingSourceCollateral:sourcePos[2]-seed.collateral,maxTotalKatIn:lo,estimatedFlashKat:result.flash,estimatedAvkat:result.out,minAvkatPerKatWad:floorRate,marketFlashCapacity:flashCapacity,configuredFlashCap:policyFlash,requiresPolicyChange:result.flash>policyFlash,targetLtv:target,depthSearchRounds:28});
s.weethMigration={...snapshot,plan};
try{
const adapter="0x916Aa175C36E845db45fF6DDB886AE437d403B61",bundler="0xA8C5e23C9C0DF2b6fF716486c6bBEBB6661548C8",max=(1n<<256n)-1n;
const aa=parseAbi(["function morphoRepay((address,address,address,address,uint256),uint256,uint256,uint256,address,bytes)","function morphoWithdrawCollateral((address,address,address,address,uint256),uint256,address)","function erc20Transfer(address,address,uint256)"]),sa=parseAbi(["function swapExactInput(address,address,uint256,uint256,address,uint256)"]);
const balances=await Promise.all([WETH,USDC,us].map(t=>read(t,erc,"balanceOf",[adapter])));
if(balances.some(x=>x!==0n))throw Error("Shared adapter holds tokens; exact residual settlement would change its original balance");
const maxDebt=seed.maxDebt;
const steps=[],after=[],a=(fn,args)=>({to:adapter,data:encodeFunctionData({abi:aa,functionName:fn,args})});
const swap=async(from,to,amount,receiver)=>{const q=await quote(from,to,amount),floor=await read(router,ra,"twapMinimumOut",[from,to,amount]);if(!floor||q.net<floor)throw Error("Source route does not satisfy configured TWAP minimum");steps.push({to:router,data:encodeFunctionData({abi:sa,functionName:"swapExactInput",args:[from,to,amount,floor,receiver,deadline]})});return floor};
if(seed.shares)steps.push(a("morphoRepay",[sourceParams,0n,seed.shares,ceil(maxDebt*10n**27n,seed.shares),safe,"0x"]));
steps.push(a("morphoWithdrawCollateral",[sourceParams,seed.collateral,bundler]));
const minW=await swap(we,WETH,seed.collateral,adapter);steps.push(a("erc20Transfer",[WETH,bundler,minW]));
const minUc=await swap(WETH,USDC,minW,adapter);steps.push(a("erc20Transfer",[USDC,bundler,minUc]));
const minUs=await swap(USDC,us,minUc,adapter);if(minUs<=maxDebt)throw Error("Conservative source proceeds do not cover accrued debt");
const convertUs=minUs-maxDebt;if(convertUs!==seed.convertUs)throw Error("Source conversion amount changed within pinned-block plan");steps.push(a("erc20Transfer",[us,bundler,convertUs]));const minKat=await swap(us,KAT,convertUs,safe);
for(const token of [WETH,USDC,us])after.push(a("erc20Transfer",[token,safe,max]));
const bundle=await this.buildMorphoBundleV13({market:id,deadline,flashToken:us,flashAmount:maxDebt,before:maxDebt?[]:steps,during:maxDebt?steps:[],after},router,bn);
if(!result.flash)throw Error("Primary module requires positive flash amount");
const loopData=encodeFunctionData({abi:GUARDIAN_V23_ABI,functionName:"atomicLoopUp",args:[[[],[],[]],[result.flash,1n,floorRate,target,deadline]]});
const data=this.encodeMorphoMigrationV13([{market:id,bundleData:bundle.bundleData}],loopData,deadline);
if(!this.account)throw Error("Worker executor unavailable for simulation");
await this.pub.call({account:this.account.address,to:migrationModule,data,blockNumber:bn});
const est=await this.pub.estimateGas({account:this.account.address,to:migrationModule,data});
s.weethMigration={...s.weethMigration,execution:"Atomic source settlement and destination migration simulated; no transaction submitted",simulation:serial({status:"passed",gasEstimate:est,sourceFlash:maxDebt,convertUs,minKat,deadline,calldataHash:keccak256(data)})};
}catch(e){s.weethMigration={...s.weethMigration,execution:"Atomic migration simulation not accepted; no transaction submitted",simulation:{status:"rejected",error:errMsg(e,350)}}}
return s.weethMigration
}catch(e){return{mode,tierRules,idle:"planning read or quote failed",error:errMsg(e,300),execution:"no transaction submitted"}}
}
}
const pos=async(id)=>Array.from(await pub.readContract({address:MORPHO,abi:['function position(bytes32,address) view returns(uint256,uint128,uint128)'],functionName:'position',args:[id,SAFE]}));
const balances=async()=>Object.fromEntries(await Promise.all([KAT,AVKAT,WETH,USDC,'0x2dca96907fde857dd3d816880a0df407eeb2d2f2'].map(async token=>[token,await pub.readContract({address:token,abi:['function balanceOf(address) view returns(uint256)'],functionName:'balanceOf',args:[SAFE]})])));
try{
 assert.equal(await req('eth_chainId'),'0xb67d2'); // corrected by decimal check below if chain id display differs
}catch(e){if(BigInt(await req('eth_chainId'))!==747474n)throw e}
try{
 report.fork=await pub.getBlock();
 const read=(address,abi,functionName,args=[])=>pub.readContract({address,abi,functionName,args});
 const [t0,slot,realOracle,globalSlot]=await Promise.all([read(POOL,['function token0() view returns(address)'],'token0'),read(POOL,['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)'],'slot0'),read(ORACLE,['function price() view returns(uint256)'],'price'),pub.getStorageAt({address:ROUTER,slot:toBeHex(1,32)})]);
 const key=keccak256(coder.encode(['address','address'],[KAT.toLowerCase(),AVKAT.toLowerCase()])),mapSlot=n=>keccak256(coder.encode(['bytes32','uint256'],[key,n]));
 const [flag,fslt]=await Promise.all([pub.getStorageAt({address:ROUTER,slot:mapSlot(4)}),pub.getStorageAt({address:ROUTER,slot:mapSlot(3)})]);
 const fee=BigInt(flag)!==0n?BigInt(fslt)&65535n:(BigInt(globalSlot)>>160n)&65535n;
 const sq=slot[0]*slot[0],q192=2n**192n,[n,d]=t0.toLowerCase()===AVKAT.toLowerCase()?[sq,q192]:[q192,sq];
 const num=n*10n**36n*1000000n*10000n*10000n,den=d*990000n*(10000n-fee)*7900n;
 const price=(num+den-1n)/den;
 report.fixture={realOracle,modeledOracle:price,routerFeeBps:fee,sqrtPriceX96:slot[0]};
 await req('anvil_setCode',[ORACLE,'0x7f'+toBeHex(price,32).slice(2)+'60005260206000f3']);
 await req('evm_mine');
 assert.equal(await read(ORACLE,['function price() view returns(uint256)'],'price'),price);
 report.before={source:await pos(SOURCE),destination:await pos(DEST),safeBalances:await balances()};
 const state={};const planner=new Planner();
 report.response=await planner.spCheck({paused:false},state);
 const res=report.response;report.status='PLANNER_IDLE_OR_REJECTED';
 if(res.allocationBps!==5000)throw Error('Expected 50% tier; response: '+JSON.stringify(res).slice(0,500));
 if(res.plan){assert(BigInt(res.plan.unwindCollateral)<=report.before.source[2]/2n);assert(BigInt(res.plan.maxTotalKatIn)<=BigInt(res.plan.quotedPoolCapacityKat));}
 if(res.simulation?.status==='passed'){
  assert(migrationCall);report.status='ATOMIC_CALL_PASSED';
  await req('anvil_impersonateAccount',[BOT]);await req('anvil_setBalance',[BOT,'0xde0b6b3a7640000']);
  const hash=await req('eth_sendTransaction',[{...migrationCall,gas:tag(BigInt(res.simulation.gasEstimate)*120n/100n)}]);let receipt;for(let j=0;j<60&&!receipt;j++){receipt=await req('eth_getTransactionReceipt',[hash]);if(!receipt)await new Promise(r=>setTimeout(r,500))}
  assert(receipt);report.receipt={hash,status:receipt.status,gasUsed:BigInt(receipt.gasUsed),blockNumber:BigInt(receipt.blockNumber)};
  report.after={source:await pos(SOURCE),destination:await pos(DEST),safeBalances:await balances()};
  assert.equal(receipt.status,'0x1');assert.equal(report.before.source[2]-report.after.source[2],BigInt(res.plan.unwindCollateral));assert.equal(report.before.source[1]-report.after.source[1],BigInt(res.plan.repayBorrowShares));assert(report.after.destination[2]>report.before.destination[2]);assert(report.after.destination[1]>report.before.destination[1]);report.status='ATOMIC_FORK_TRANSACTION_PASSED';
 }
 else {report.after={source:await pos(SOURCE),destination:await pos(DEST),safeBalances:await balances()};assert.deepEqual(report.before,report.after);}
}catch(e){report.error=String(e.stack||e);report.status='ERROR';process.exitCode=1}finally{output()}
