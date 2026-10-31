// Collector implementation v4; canonical path retained for the existing workflow.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(`${process.env.FXMINT_DEPS}/package.json`);
export const ethers = require('ethers');
export const C = Object.fromEntries(Object.entries({
 owner:ethers.getAddress(process.env.FXMINT_OWNER_ADDRESS||'0x9f2B20A772246960810045905B7daccf960eE288'),
 pool:'0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8',
 manager:'0x250893CA4Ba5d05626C785e8da758026928FCD24',
 router:'0xB753366082466c4B5984312f0c4Bb97554be067E',
 configuration:'0x16b334f2644cc00b85DB1A1efF0C2C395e00C28d',
 converter:'0x12AF4529129303D7FbD2563E242C4a2890525912',
 usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
 fxusd:'0x085780639CC2cACd35E474e71f4d000e2405d8f6',
 collateral:'0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
 weth:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
 balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
 multicall:'0xcA11bde05977b3631167028862bE2a173976CA11',
 factory:'0x1F98431c8aD98523631AE4a59f267346ea31F984'
}).map(([k,v])=>[k,v.toLowerCase()]));
if(C.owner===ethers.ZeroAddress)throw Error('Position owner cannot be zero');
// Official AladdinDAO/fx-sdk routes and aladdin-v3-contracts V3 hint encoding.
export const R={
 usdcFx:['0x01054062fa20b733978fcbcec244eb8825ae6cfed87c0c'],
 fxUsdc:['0x254062fa20b733978fcbcec244eb8825ae6cfed87c0c'],
 unwrap:['0x1fce71607d656d4f172c66f42cfe369b24d78b2820a'],
 stethWeth:['0x277090c5ae6b80a3c525f09d7ae464a8fa83d9c08804'],
 wethUsdc:['0x07d2239a830b7749bfbad93c0e68b104a5bf2cfd590001']
};
export const encoding = routes => 1048575n + (BigInt(routes.length)<<20n);
export const json = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2);
export function save(name,value){mkdirSync('fxmint-output',{recursive:true});writeFileSync(`fxmint-output/${name}`,json(value));}
export function safeError(e){let s=String(e.shortMessage||e.message||e);for(const key of ['ETH_RPC_URL','FXMINT_PRIVATE_KEY'])if(process.env[key])s=s.replaceAll(process.env[key],'[REDACTED]');return s.replace(/https?:\/\/[^\s"')]+/g,'[URL REDACTED]').slice(0,2000);}
export async function read(provider,to,fragment,args=[],block='latest'){
  const iface=new ethers.Interface([`function ${fragment}`]);
  const name=fragment.slice(0,fragment.indexOf('('));
  const data=iface.encodeFunctionData(name,args);
  const result=await provider.send('eth_call',[{to,data},block]);
  const out=iface.decodeFunctionResult(name,result);return out.length===1?out[0]:Array.from(out);
}
export const quote = (p,amount,routes,block='latest')=>read(p,C.converter,'queryConvert(uint256,uint256,uint256[]) returns(uint256)',[amount,encoding(routes),routes],block);
export async function collect(provider,provenRouteOnly=false){
  const chain=await provider.send('eth_chainId',[]);if(chain!=='0x1')throw Error('Ethereum chain ID 1 required');
  const block=await provider.send('eth_blockNumber',[]);
  const header=await provider.send('eth_getBlockByNumber',[block,false]);
  const result={version:2,chainId:1,block:Number(BigInt(block)),blockHash:header.hash,timestamp:Number(BigInt(header.timestamp)),addresses:C,routes:R};
  for(const [name,address] of Object.entries(C)){if(name==='owner')continue;const code=await provider.send('eth_getCode',[address,block]);if(code==='0x')throw Error(`No deployed code: ${name}`);result.codeHashes??={};result.codeHashes[name]=ethers.keccak256(code);}
  result.decimals={};for(const name of ['usdc','fxusd','collateral'])result.decimals[name]=Number(await read(provider,C[name],'decimals() view returns(uint8)',[],block));
  if(json(result.decimals)!==json({usdc:6,fxusd:18,collateral:18}))throw Error('Unexpected token decimals');
  result.poolCollateral=await read(provider,C.pool,'collateralToken() view returns(address)',[],block);
  if(result.poolCollateral.toLowerCase()!==C.collateral)throw Error('Pool does not hold wstETH');
  result.poolManager=await read(provider,C.pool,'poolManager() view returns(address)',[],block);
  if(result.poolManager.toLowerCase()!==C.manager)throw Error('Pool manager mismatch');
  result.nextPositionId=Number(await read(provider,C.pool,'getNextPositionId() view returns(uint32)',[],block));
  result.ownerPositionCount=Number(await read(provider,C.pool,'balanceOf(address) view returns(uint256)',[C.owner],block));
  console.log(json({block:result.block,nextPositionId:result.nextPositionId,ownerPositionCount:result.ownerPositionCount}));
  result.positions=[];
  const nft=new ethers.Interface(['function ownerOf(uint256) view returns(address)']);
  for(let start=1;start<result.nextPositionId&&result.positions.length<result.ownerPositionCount;start+=200){
    const ids=Array.from({length:Math.min(200,result.nextPositionId-start)},(_,i)=>start+i);
    const data=await read(provider,C.multicall,'aggregate3((address target,bool allowFailure,bytes callData)[]) payable returns((bool success,bytes returnData)[])',[ids.map(id=>[C.pool,true,nft.encodeFunctionData('ownerOf',[id])])],block);
    for(let i=0;i<data.length;i++){if(!data[i].success)continue;const owner=nft.decodeFunctionResult('ownerOf',data[i].returnData)[0];if(owner.toLowerCase()!==C.owner)continue;const id=ids[i];const [collateral,debt]=await read(provider,C.pool,'getPosition(uint256) view returns(uint256,uint256)',[id],block);result.positions.push({id,owner,rawCollateral:collateral,rawDebt:debt,approved:await read(provider,C.pool,'getApproved(uint256) view returns(address)',[id],block),debtRatio:await read(provider,C.pool,'getPositionDebtRatio(uint256) view returns(uint256)',[id],block)});}
  }
  if(result.positions.length!==result.ownerPositionCount)throw Error('Position enumeration incomplete');
  result.fees=await read(provider,C.configuration,'getPoolFeeRatio(address,address) view returns(uint256,uint256,uint256,uint256)',[C.pool,C.router],block);
  result.debtRatioRange=await read(provider,C.pool,'getDebtRatioRange() view returns(uint256,uint256)',[],block);
  result.balancerUsdc=await read(provider,C.usdc,'balanceOf(address) view returns(uint256)',[C.balancer],block);
  result.feeCollector=await read(provider,C.balancer,'getProtocolFeesCollector() view returns(address)',[],block);
  result.flashFeePercentage=await read(provider,result.feeCollector,'getFlashLoanFeePercentage() view returns(uint256)',[],block);
  const [scalar,rateProvider]=await read(provider,C.manager,'tokenRates(address) view returns(uint96,address)',[C.collateral],block);
  const rate=rateProvider===ethers.ZeroAddress?1000000000000000000n:await read(provider,rateProvider,'getRate() view returns(uint256)',[],block);
  result.collateralScalingFactor=BigInt(scalar)*rate;result.collateralRateProvider=rateProvider;
  result.candidates=await discover(provider,block,provenRouteOnly);
  save('DATA_v3.json',result);console.log(json({block:result.block,positions:result.positions,candidateCounts:Object.fromEntries(Object.entries(result.candidates).map(([k,v])=>[k,v.length]))}));
  if(!result.positions.some(x=>x.rawDebt>0n))throw Error('Owner has no indebted wstETH long position');
  return result;
}

export function hint(pool,type,extra=0n,action=0){return ethers.toBeHex((((BigInt(pool)|extra)<<2n)|BigInt(action))<<8n|BigInt(type));}
export async function discover(p,block='latest',provenRouteOnly=false){
 const first=[{name:'Curve USDC/fxUSD',routes:R.usdcFx}];
 const sale=[],wethSale=[],wstWeth=[];
 async function uni(from,to,fee){
   const pool=await read(p,C.factory,'getPool(address,address,uint24) view returns(address)',[from,to,fee],block);
   if(pool===ethers.ZeroAddress)return null;
   const liquidity=await read(p,pool,'liquidity() view returns(uint128)',[],block);if(liquidity===0n)return null;
   const token0=await read(p,pool,'token0() view returns(address)',[],block);
   const token1=await read(p,pool,'token1() view returns(address)',[],block);
   if(new Set([token0.toLowerCase(),token1.toLowerCase()]).size!==2||![token0,token1].some(x=>x.toLowerCase()===from))throw Error('Unexpected Uniswap pool tokens');
   return {pool,fee,routes:[hint(pool,1,(BigInt(fee)<<160n)|(BigInt(from<to?1:0)<<184n))]};
 }
 if(provenRouteOnly){
   // Lowest gas-inclusive cost in simulation runs 38017714742 and 38018612642.
   const direct=await uni(C.collateral,C.usdc,500);
   if(!direct)throw Error('Proven wstETH/USDC 500 route unavailable');
   if(direct.pool.toLowerCase()!=='0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863')throw Error('Proven wstETH/USDC pool mismatch');
   return {first,sale:[{name:'Uniswap direct wstETH/USDC 500',...direct}],wethSale};
 }
 for(const fee of [100,500,3000,10000]){
   const a=await uni(C.usdc,C.fxusd,fee);if(a)first.push({name:'Uniswap USDC/fxUSD '+fee,...a});
   const b=await uni(C.collateral,C.usdc,fee);if(b)sale.push({name:'Uniswap direct wstETH/USDC '+fee,...b});
   const c=await uni(C.collateral,C.weth,fee);if(c)wstWeth.push({name:'Uniswap wstETH/WETH '+fee,...c});
   const d=await uni(C.weth,C.usdc,fee);if(d)wethSale.push({name:'Uniswap WETH/USDC '+fee,...d});
 }
 wstWeth.push({name:'Lido unwrap + Curve stETH/ETH SDK',routes:[...R.unwrap,...R.stethWeth]});
 const ng='0x21e27a5e5513d6e65c4f830167390997aa84843a';
 wstWeth.push({name:'Lido unwrap + Curve stETH/ETH factory',routes:[...R.unwrap,hint(ng,4,1n<<160n|1n<<163n)]});
 const balPool='0x93d199263632a4ef4bb438f1feb99e57b4b5f0bd';
 try{
   const poolId=await read(p,balPool,'getPoolId() view returns(bytes32)',[],block);
   const [tokens]=await read(p,C.balancer,'getPoolTokens(bytes32) view returns(address[],uint256[],uint256)',[poolId],block);
   const i=tokens.findIndex(t=>t.toLowerCase()===C.collateral),j=tokens.findIndex(t=>t.toLowerCase()===C.weth);
   if(i>=0&&j>=0)wstWeth.push({name:'Balancer V2 wstETH/WETH',routes:[hint(balPool,3,BigInt(tokens.length-1)<<160n|BigInt(i)<<163n|BigInt(j)<<166n)]});
 }catch(e){console.log('Balancer route discovery unavailable: '+safeError(e));}
 wethSale.push({name:'Curve Tricrypto USDC/WBTC/WETH',routes:[hint('0x7f86bf177dd4f3494b841a37e810a34dd56c829b',8,2n<<160n|2n<<163n)]});
 for(const a of wstWeth)for(const b of wethSale)sale.push({name:a.name+' -> '+b.name,routes:[...a.routes,...b.routes]});
 // Reference prior approach includes the extra USDC->fxUSD->USDC round trip.
 sale.push({name:'SDK reference via fxUSD',routes:[...R.unwrap,...R.stethWeth,...R.wethUsdc,...R.usdcFx,...R.fxUsdc]});
 return {first,sale,wethSale};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const p=new ethers.JsonRpcProvider(process.env.ETH_RPC_URL,1,{staticNetwork:true});
 try{await collect(p);}catch(e){save('ERROR_v3.json',{error:safeError(e)});console.error(safeError(e));process.exitCode=1;}finally{p.destroy();}
}

