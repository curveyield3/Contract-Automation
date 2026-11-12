'use strict';
// Fork-only integration campaign for the production CurveYield Omni Router v11.
// All writes below target a local ephemeral Anvil fork, NEVER Ethereum mainnet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEPS = process.env.OMNI_DEPS;
const {ethers} = require(path.join(DEPS,'node_modules/ethers'));
const solc = require(path.join(DEPS,'node_modules/solc'));
const provider = new ethers.JsonRpcProvider(process.env.FORK_RPC || 'http://127.0.0.1:8545');
const artifactDir = path.join(process.cwd(),'omni-router-fork-output-v1');
fs.mkdirSync(artifactDir,{recursive:true});
const ZERO = ethers.ZeroAddress, ZERO32 = ethers.ZeroHash;
const SRC_SHA = 'c4b93d9bd2265ccd08d3194fb535d54db8c6ea2dd5cdbcad6b9ad499e29878fb';
const ADDR = {
 WETH:'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
 USDC:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
 USDT:'0xdAC17F958D2ee523a2206206994597C13D831ec7',
 DAI:'0x6B175474E89094C44Da98b954EedeAC495271d0F',
 WBTC:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
 crvUSD:'0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E',
 BAL:'0xba100000625a3754423978a60c9317c58a424e3D',
 wstETH:'0x7f39C581F595B53c5cb19bD0b3f8da6c935E2Ca0',
 USDG:'0xe343167631d89B6Ffc58B88d6b7fB0228795491D'
};
const P={
 v2USDCWETH:'0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
 v2WETHDAI:'0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11',
 v3USDCWETH:'0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
 curve2:'0x6e5492f8ea2370844ee098a56dd88e1717e4a9c2',
 tri:'0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B',
 old:'0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
 ng:'0x07558dc7df9a162c0a74db6aae4e110d8eb7fa2f',
 balWeighted:'0x5c6Ee304399DBdB9C8Ef030aB642B10820DB8F56',
 balStable:'0x32296969Ef14EB0c6d29669C550D4a0449130230',
 balVault:'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
 v4:'0x000000000004444c5dc75cB358380D2e3dE08A90',
 v4View:'0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
 aave:'0xA50ba011c48153De246E5192C8f9258A2ba79Ca9'
};
const V4HOOK='0x0000113dCf4ADd69999Fad8F20F2b63F979bfcC0';
const V4IDL='0x2b21c65d9a7dc6926ee330a1c6e5a8037fd81774f3dc066536f800128e39f634';
const V4USDGID='0xeda62d2906d0edf26d40c793d581609552a44a87f618a98ff76ebe8dde4b7edb';
const BAL_WEIGHTED_ID='0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014';
const BAL_STABLE_ID='0x32296969ef14eb0c6d29669c550d4a0449130230000200000000000000000080';
const abi = ethers.AbiCoder.defaultAbiCoder();
const tokenAbi=['function balanceOf(address) view returns(uint256)','function decimals() view returns(uint8)','function approve(address,uint256) returns(bool)','function transfer(address,uint256) returns(bool)'];
const reader = {
 v2:['function getReserves() view returns(uint112,uint112,uint32)'],
 v3:['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)'],
 vault:['function getPoolTokens(bytes32) view returns(address[],uint256[],uint256)'],
 v4:['function getLiquidity(bytes32) view returns(uint128)'],
 curve:['function price_oracle() view returns(uint256)']
};
const marketSource = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
interface IForkERC20 {
 function transferFrom(address,address,uint256) external returns(bool);
}
interface IForkV2Pool {
 function token0() external view returns(address);
 function getReserves() external view returns(uint112,uint112,uint32);
 function swap(uint256,uint256,address,bytes calldata) external;
}
contract ForkOnlyMainnetRatioOracle {
 mapping(address=>uint256) public pricesInEth;
 function setPrice(address token,uint256 price) external {require(price>0); pricesInEth[token]=price;}
 function rate(address input,address output) external view returns(uint256) {
   uint256 a=pricesInEth[input]; uint256 b=pricesInEth[output];
   require(a>0 && b>0,"NO_MAINNET_REFERENCE");
   return a*1e18/b;
 }
}
contract ForkOnlyV2Adapter {
 function executeHop(address pool,address tokenIn,address,uint256 amountIn,uint256,bytes32,bytes calldata)
   external returns(uint256 output) {
   IForkV2Pool pair=IForkV2Pool(pool);
   (uint112 r0,uint112 r1,)=pair.getReserves();
   bool z=pair.token0()==tokenIn;
   uint256 ri=z?r0:r1; uint256 ro=z?r1:r0;
   require(ri>0&&ro>0,"NO_LIQUIDITY");
   uint256 n=amountIn*9970;
   output=n*ro/(ri*10000+n);
   require(output>0,"DUST");
   require(IForkERC20(tokenIn).transferFrom(msg.sender,pool,amountIn),"TRANSFER_FAILED");
   pair.swap(z?0:output,z?output:0,msg.sender,"");
 }
}`;
const summary={
 version:'v11',network:'ethereum',mode:'ephemeral-anvil-live-mainnet-fork',
 routerCommit:'3ce77dbc7fe427f05ba760c96b22bd7397ca62c3',
 expectedSourceSha256Trimmed:SRC_SHA,
 reportTime:new Date().toISOString(),poolTypes:{1:'Uniswap V2',2:'Uniswap V3',3:'Uniswap V4',4:'Curve CryptoSwap',5:'Curve TriCrypto',6:'Curve StableSwap',7:'Curve StableSwap NG',8:'Balancer V2 Weighted',9:'Balancer V2 Stable',1000:'External V2 adapter'},
 funding:[],oracleReferences:[],routes:[],errors:[]
};
const json = (x)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2);
const write=()=>fs.writeFileSync(path.join(artifactDir,'summary.json'),json(summary)+'
');
const err=(e)=>String(e?.shortMessage||e?.reason||e?.message||e).slice(0,750);
const c=(addr,abi,signer)=>new ethers.Contract(addr,abi,signer||provider);
async function readState(h,routerAddr,tokenIn){
 const data={type:h.poolType,pool:h.swapContract,poolId:h.poolId};
 try {
   const ercOut=c(h.tokenOut,tokenAbi);
   data.outputPoolBalance=(await ercOut.balanceOf(h.swapContract)).toString();
   data.routerOutputBalance=(await ercOut.balanceOf(routerAddr)).toString();
   if(h.poolType===1){
     const x=await c(h.swapContract,reader.v2).getReserves();
     data.reserves=x.slice(0,2).map(String);
   }else if(h.poolType===2){
     const x=await c(h.swapContract,reader.v3).slot0();
     data.sqrtPriceX96=x[0].toString();data.tick=x[1].toString();
   }else if(h.poolType===3){
     data.liquidity=(await c(P.v4View,reader.v4).getLiquidity(h.poolId)).toString();
   }else if(h.poolType===8||h.poolType===9){
     const x=await c(P.balVault,reader.vault).getPoolTokens(h.poolId);
     data.vaultTokens=x[0];data.vaultBalances=x[1].map(String);
   }else if(h.poolType===4){
     data.poolEMA=(await c(h.swapContract,reader.curve).price_oracle()).toString();
   }
 } catch(e){data.error=err(e);}
 return data;
}
function compile(){
 const src=fs.readFileSync(process.env.ROUTER_SOURCE,'utf8');
 const hash=crypto.createHash('sha256').update(src.trimEnd()).digest('hex');
 if(hash!==SRC_SHA)throw Error('SOURCE_MISMATCH '+hash);
 const sources={
  'routers/ethereum-fraxtal/CurveYieldOmniRouter.sol':{content:src},
  'ForkOnlyOracle.sol':{content:marketSource}
 };
 const input={language:'Solidity',sources,settings:{optimizer:{enabled:true,runs:1},viaIR:true,outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
 function findImports(name){
  const loc=path.join(DEPS,'node_modules',name);
  if(fs.existsSync(loc))return {contents:fs.readFileSync(loc,'utf8')};
  return {error:'Unavailable import '+name};
 }
 const parsed=JSON.parse(solc.compile(JSON.stringify(input),{import:findImports}));
 const errors=(parsed.errors||[]).filter(x=>x.severity==='error');
 if(errors.length)throw Error(errors.map(x=>x.formattedMessage).join('
'));
 const router=parsed.contracts['routers/ethereum-fraxtal/CurveYieldOmniRouter.sol'].CurveYieldOmniRouter;
 const test=parsed.contracts['ForkOnlyOracle.sol'];
 const bytes=router.evm.deployedBytecode.object.length/2;
 if(bytes>24576)throw Error('OVERSIZE_RUNTIME '+bytes);
 summary.compilation={solc:solc.version(),sha256:hash,runtimeBytes:bytes};
 return {router,oracle:test.ForkOnlyMainnetRatioOracle,adapter:test.ForkOnlyV2Adapter};
}
async function main(){
 const net=await provider.getNetwork();
 if(net.chainId!==1n)throw Error('FORK_CHAIN_ID_NOT_1');
 const actor=await provider.getSigner(0),recipient=await provider.getSigner(1);
 const owner=await actor.getAddress(),feeRecipient=await recipient.getAddress();
 const block=await provider.getBlock('latest');
 summary.chainId=Number(net.chainId);summary.forkBlock=block.number;summary.forkBlockHash=block.hash;
 summary.actor=owner;summary.feeRecipient=feeRecipient;
 const built=compile();
 async function deploy(comp,args=[]){
  const contract=await new ethers.ContractFactory(comp.abi,'0x'+comp.evm.bytecode.object,actor).deploy(...args,{gasLimit:15000000n});
  await contract.waitForDeployment();
  return contract;
 }
 const router=await deploy(built.router,[owner,feeRecipient]);
 const oracle=await deploy(built.oracle);
 const adapter=await deploy(built.adapter);
 summary.router=await router.getAddress();summary.forkOracle=await oracle.getAddress();summary.forkAdapter=await adapter.getAddress();
 summary.deployRuntimeSize=ethers.getBytes(await provider.getCode(summary.router)).length;
 summary.defaultSlippageBps=Number(await router.defaultSlippageGuardBps());
 summary.defaultV3Window=300;summary.minimumV3Window=60;
 await(await router.setExternalAdapter(1000,summary.forkAdapter)).wait();
 const ERC={};
 for(const [symbol,addr] of Object.entries(ADDR)){
  ERC[symbol]=c(addr,tokenAbi,actor);
 }
 // Fund fork-only actor by impersonating existing holders. Never call Ethereum RPC with writes.
 await (await actor.sendTransaction({to:ADDR.WETH,data:'0xd0e30db0',value:ethers.parseEther('6')})).wait();
 const holders={
  USDC:P.old,USDT:P.old,DAI:P.old,WBTC:P.tri,
  crvUSD:P.curve2,BAL:P.balVault,wstETH:P.balVault,USDG:P.v4
 };
 const funding={USDC:'700',USDT:'700',DAI:'700',WBTC:'0.025',crvUSD:'500',BAL:'50',wstETH:'0.10',USDG:'100'};
 const decimals={WETH:18};
 for(const [symbol,token] of Object.entries(ERC)){
  try{decimals[symbol]=Number(await token.decimals());}catch(e){summary.errors.push('DECIMALS '+symbol+':'+err(e));}
 }
 for(const [sym,holder] of Object.entries(holders)){
  const entry={symbol:sym,holder,requested:funding[sym]};
  try{
   const amt=ethers.parseUnits(funding[sym],decimals[sym]);
   entry.available=(await ERC[sym].balanceOf(holder)).toString();
   if(BigInt(entry.available)<amt)throw Error('INSUFFICIENT_REAL_HOLDER_BALANCE');
   await provider.send('anvil_setBalance',[holder,ethers.toBeHex(ethers.parseEther('6'))]);
   await provider.send('anvil_impersonateAccount',[holder]);
   try{
    const whale=await provider.getSigner(holder);
    const tk=c(ADDR[sym],tokenAbi,whale);
    await (await tk.transfer(owner,amt,{gasLimit:700000n})).wait();
   }finally{
    await provider.send('anvil_stopImpersonatingAccount',[holder]);
   }
   entry.received=(await ERC[sym].balanceOf(owner)).toString();
   entry.status='funded';
  }catch(e){entry.status='unavailable';entry.error=err(e);}
  summary.funding.push(entry);write();
 }
 const aave=c(P.aave,['function getAssetPrice(address) view returns(uint256)']);
 const prices={WETH:1000000000000000000n};
 for(const sym of ['USDC','USDT','DAI','WBTC','BAL','wstETH']){
  try{
   const v=await aave.getAssetPrice(ADDR[sym]);
   if(v>0n)prices[sym]=v;
  }catch{}
 }
 const curveEMA=await c(P.curve2,['function price_oracle() view returns(uint256)']).price_oracle();
 prices.crvUSD=10n**36n/curveEMA;
 if(!prices.wstETH){
  const w=c(ADDR.wstETH,['function getStETHByWstETH(uint256) view returns(uint256)']);
  prices.wstETH=await w.getStETHByWstETH(10n**18n);
 }
 if(!prices.BAL)prices.BAL=200000000000000n; // fork-only fallback, not production oracle
 prices.USDG=prices.USDC;
 for(const [sym,price] of Object.entries(prices)){
  await(await oracle.setPrice(ADDR[sym],price)).wait();
  summary.oracleReferences.push({token:sym,weiEthPerUnit:String(price),source:
   sym==='crvUSD'?'Live Curve Crypto EMA':
   sym==='WETH'?'WETH/ETH denomination':
   sym==='wstETH'?'Aave if supported; otherwise Lido convert':
   sym==='BAL'?'Fork-only fallback if unlisted':
   sym==='USDG'?'Fork-only parity to USDC':
   'Live Aave V2 ETH-denominated asset price'});
 }
 const ercOracle=(input,output)=>({
  oracleAddress:summary.forkOracle,
  readFunctionID:oracle.interface.getFunction('rate').selector,
  requiredInputs:abi.encode(['address','address'],[ADDR[input],ADDR[output]]),
  invert:false,rateDecimals:18
 });
 function buildHop(spec){
  const t=spec.t,inSym=spec.inSym,outSym=spec.outSym;
  let poolId=ZERO32,poolData='0x',contract=spec.pool;
  let o=ercOracle(inSym,outSym);
  if(t===1){poolData=abi.encode(['uint16'],[30]);}
  if(t===2){poolData=abi.encode(['uint32'],[300]);o={oracleAddress:ZERO,readFunctionID:'0x00000000',requiredInputs:'0x',invert:false,rateDecimals:18};}
  if(t===3){
   const tokens=[ADDR[inSym],ADDR[outSym]].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()));
   const key=[tokens[0],tokens[1],8388608,1,V4HOOK];
   poolId=ethers.keccak256(abi.encode(['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'],[key]));
   const expected=(inSym==='USDG'||outSym==='USDG')?V4USDGID:V4IDL;
   if(poolId.toLowerCase()!==expected.toLowerCase())throw Error('V4_POOL_KEY_MISMATCH '+poolId);
   poolData=abi.encode(['tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)','bytes'],[key,'0x']);
  }
  if(t>=4&&t<=7){
   poolData=abi.encode(['uint8','uint8'],[spec.i,spec.j]);
   if(t===4){o={oracleAddress:contract,readFunctionID:ethers.id('price_oracle()').slice(0,10),requiredInputs:'0x',invert:inSym==='crvUSD',rateDecimals:18};}
   if(t===5){o={oracleAddress:contract,readFunctionID:ethers.id('price_oracle(uint256)').slice(0,10),requiredInputs:abi.encode(['uint256'],[0]),invert:inSym==='USDC',rateDecimals:18};}
   if(t===7){o={oracleAddress:contract,readFunctionID:ethers.id('price_oracle(uint256)').slice(0,10),requiredInputs:abi.encode(['uint256'],[0]),invert:inSym==='USDC',rateDecimals:18};}
  }
  if(t===8)poolId=BAL_WEIGHTED_ID;
  if(t===9)poolId=BAL_STABLE_ID;
  if(t===1000)poolData=abi.encode(['uint16'],[30]); // For future V2-based adapter.
  return {poolType:t,tokenOut:ADDR[outSym],swapContract:contract,poolId,poolData,oracle:o};
 }
 const mk=(t,input,output,pool,i,j)=>({t,inSym:input,outSym:output,pool:pool||(t===3?P.v4:t===8||t===9?P.balVault:null),i,j});
 const specs={
  v2UW:mk(1,'USDC','WETH',P.v2USDCWETH),
  v2WD:mk(1,'WETH','DAI',P.v2WETHDAI),
  v2DW:mk(1,'DAI','WETH',P.v2WETHDAI),
  v3UW:mk(2,'USDC','WETH',P.v3USDCWETH),
  v3WU:mk(2,'WETH','USDC',P.v3USDCWETH),
  v4UT:mk(3,'USDC','USDT',P.v4),
  v4TU:mk(3,'USDT','USDC',P.v4),
  v4UG:mk(3,'USDC','USDG',P.v4),
  v4GU:mk(3,'USDG','USDC',P.v4),
  c2CW:mk(4,'crvUSD','WETH',P.curve2,0,1),
  c2WC:mk(4,'WETH','crvUSD',P.curve2,1,0),
  triBU:mk(5,'WBTC','USDC',P.tri,1,0),
  triUB:mk(5,'USDC','WBTC',P.tri,0,1),
  oldDU:mk(6,'DAI','USDC',P.old,0,1),
  oldUT:mk(6,'USDC','USDT',P.old,1,2),
  oldTD:mk(6,'USDT','DAI',P.old,2,0),
  ngCU:mk(7,'crvUSD','USDC',P.ng,0,1),
  ngUC:mk(7,'USDC','crvUSD',P.ng,1,0),
  bwWB:mk(8,'WETH','BAL',P.balVault),
  bwBW:mk(8,'BAL','WETH',P.balVault),
  bsWW:mk(9,'WETH','wstETH',P.balVault),
  bsWWr:mk(9,'wstETH','WETH',P.balVault),
  adUW:mk(1000,'USDC','WETH',P.v2USDCWETH),
  adWU:mk(1000,'WETH','USDC',P.v2USDCWETH)
 };
 const list=[
 ['V2-USDC-WETH',['v2UW']],['V2-WETH-DAI',['v2WD']],
 ['V3-USDC-WETH',['v3UW']],['V3-WETH-USDC',['v3WU']],
 ['V4-USDC-USDT',['v4UT']],['V4-USDT-USDC',['v4TU']],['V4-USDC-USDG',['v4UG']],['V4-USDG-USDC',['v4GU']],
 ['Curve2-crvUSD-WETH',['c2CW']],['Curve2-WETH-crvUSD',['c2WC']],
 ['Tri-WBTC-USDC',['triBU']],['Tri-USDC-WBTC',['triUB']],
 ['Old-DAI-USDC',['oldDU']],['Old-USDC-USDT',['oldUT']],['Old-USDT-DAI',['oldTD']],
 ['NG-crvUSD-USDC',['ngCU']],['NG-USDC-crvUSD',['ngUC']],
 ['BalWeighted-WETH-BAL',['bwWB']],['BalWeighted-BAL-WETH',['bwBW']],
 ['BalStable-WETH-wstETH',['bsWW']],['BalStable-wstETH-WETH',['bsWWr']],
 ['Adapter-USDC-WETH',['adUW']],['Adapter-WETH-USDC',['adWU']],
 ['2-hop-USDT-USDC-WETH',['v4TU','v2UW']],
 ['3-hop-WETH-crvUSD-USDC-USDT',['c2WC','ngCU','v4UT']],
 ['4-hop-WBTC-USDC-USDT-DAI-WETH',['triBU','v4UT','oldTD','v2DW']],
 ['5-hop-WBTC-USDC-USDT-DAI-WETH-crvUSD',['triBU','v4UT','oldTD','v2DW','c2WC']]
 ];
 const amt={USDC:'1',USDT:'1',USDG:'1',DAI:'1',WBTC:'0.00003',WETH:'0.0005',crvUSD:'1',BAL:'0.7',wstETH:'0.0004'};
 const covered={};const attempted={};
 for(const [name,names] of list){
  const route={name,hopCount:names.length,steps:names,plannedPoolTypes:names.map(x=>specs[x].t)};
  const parts=names.map(x=>specs[x]);const input=parts[0].inSym;const output=parts.at(-1).outSym;
  route.input=input;route.output=output;
  for(let i=0;i<parts.length;i++){
   if(i>0&&parts[i].inSym!==parts[i-1].outSym)throw Error('BROKEN_ROUTE '+name);
   attempted[parts[i].t]=(attempted[parts[i].t]||0)+1;
  }
  summary.routes.push(route);
  try {
   if(!decimals[input])throw Error('NO_INPUT_DECIMALS '+input);
   const amount=ethers.parseUnits(amt[input],decimals[input]);route.amountIn=amount.toString();
   const hs=parts.map(buildHop);
   route.hops=hs.map(h=>({poolType:h.poolType,pool:h.swapContract,poolId:h.poolId,oracleAddress:h.oracle.oracleAddress,oracleSelector:h.oracle.readFunctionID}));
   const tx=await router.setRoute(ADDR[input],ADDR[output],hs,{gasLimit:13000000n});
   const receipt=await tx.wait();route.configured={status:receipt.status,gasUsed:receipt.gasUsed.toString(),transactionHash:receipt.hash};
   if(receipt.status!==1)throw Error('ROUTE_CONFIG_REVERTED');
   route.storedHops=[];
   for(let i=0;i<hs.length;i++){
    const st=await router.routeHop(ADDR[input],ADDR[output],i);
    route.storedHops.push({index:i,poolId:st.poolId,poolType:st.poolType.toString()});
   }
   route.preState=await Promise.all(hs.map(h=>readState(h,summary.router,ADDR[input])));
   const balInBefore=await ERC[input].balanceOf(owner),balOutBefore=await ERC[output].balanceOf(owner);
   const feeBefore=await ERC[output].balanceOf(feeRecipient);
   route.balanceBefore={input:balInBefore.toString(),output:balOutBefore.toString(),feeRecipient:feeBefore.toString()};
   if(balInBefore<amount)throw Error('INSUFFICIENT_FORK_TEST_TOKEN');
   route.rawPrice=(await router.price_oracle(ADDR[input],ADDR[output])).toString();
   route.estimate=(await router.estimate_exact_output(ADDR[input],ADDR[output],amount)).toString();
   route.guardedMinOut=(await router.guardedMinOut(ADDR[input],ADDR[output],amount)).toString();
   await(await ERC[input].approve(summary.router,amount,{gasLimit:300000n})).wait();
   const deadline=(await provider.getBlock('latest')).timestamp+900;
   const callArgs=[ADDR[input],ADDR[output],amount,0n,owner,deadline];
   try{route.ethCallPreview=(await router.swapExactInput.staticCall(...callArgs)).toString();}
   catch(e){route.ethCallPreviewError=err(e);}
   const rawTx=await router.swapExactInput(...callArgs,{gasLimit:11000000n});
   try{
    const result=await rawTx.wait();
    route.swap={status:result.status,hash:result.hash,blockNumber:result.blockNumber,gasUsed:result.gasUsed.toString()};
    for(const log of result.logs){
      try{const parsed=router.interface.parseLog(log);if(parsed&&parsed.name==='SwapExecuted'){route.swap.event={sender:parsed.args[0],amountIn:parsed.args[3].toString(),amountOut:parsed.args[4].toString()};}}
      catch{}
    }
   }catch(e){
    route.swap={status:0,hash:rawTx.hash,error:err(e)};
   }
   const balInAfter=await ERC[input].balanceOf(owner),balOutAfter=await ERC[output].balanceOf(owner),feeAfter=await ERC[output].balanceOf(feeRecipient);
   const remainAllowance=await c(ADDR[input,['function allowance(address,address) view returns(uint256)']).allowance(owner,summary.router);
   route.balanceAfter={input:balInAfter.toString(),output:balOutAfter.toString(),feeRecipient:feeAfter.toString(),remainingInputAllowance:remainAllowance.toString()};
   route.realizedOutput=(balOutAfter-balOutBefore).toString();
   route.feePaid=(feeAfter-feeBefore).toString();
   route.postState=await Promise.all(hs.map(h=>readState(h,summary.router,ADDR[input])));
   if(route.swap.status===1&&balOutAfter>balOutBefore){
    route.status='PASS';
    for(const h of parts)covered[h.t]=(covered[h.t]||0)+1;
   }else{route.status='FAIL_SWAP';}
  }catch(e){
   route.status=route.configured?'FAIL_ROUTE_OR_ORACLE_OR_SWAP':'FAIL_CONFIG';
   route.error=err(e);
   try{route.postState=await Promise.all(parts.map(h=>readState(buildHop(h),summary.router,ADDR[input])));}catch{}
  }
  write();console.log('FORK_ROUTE_RESULT '+JSON.stringify({name:route.name,status:route.status,hopCount:route.hopCount,poolTypes:route.plannedPoolTypes,hash:route.swap?.hash,error:route.error||route.swap?.error||route.ethCallPreviewError||null}));
 }
 summary.coverage={attempted,successful:covered};
 summary.tokenKinds=Object.keys(ADDR);
 summary.counts={total:list.length,pass:summary.routes.filter(x=>x.status==='PASS').length,fail:summary.routes.filter(x=>x.status!=='PASS').length};
 summary.complete=true;
 write();
 console.log('FORK_FINAL_SUMMARY '+JSON.stringify({counts:summary.counts,coverage:summary.coverage,tokenKinds:summary.tokenKinds,router:summary.router,block:summary.forkBlock}));
 if(summary.counts.fail>0||Object.keys(summary.poolTypes).some(k=>(covered[k]||0)<2))process.exitCode=1;
}
main().catch(e=>{summary.fatalError=err(e);write();console.error('FORK_FATAL',e);process.exitCode=1;});