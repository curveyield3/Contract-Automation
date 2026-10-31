import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(`${process.env.FXMINT_DEPS}/package.json`);
export const ethers = require('ethers');
export const C = Object.fromEntries(Object.entries({
  owner:'0xFF90b414D84F7Ec4FAEADBD8Da86Ad515F930654',
  pool:'0xAB709e26Fa6B0A30c119D8c55B887DeD24952473',
  manager:'0x250893CA4Ba5d05626C785e8da758026928FCD24',
  router:'0xB753366082466c4B5984312f0c4Bb97554be067E',
  configuration:'0x16b334f2644cc00b85DB1A1efF0C2C395e00C28d',
  converter:'0x12AF4529129303D7FbD2563E242C4a2890525912',
  usdc:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  fxusd:'0x085780639CC2cACd35E474e71f4d000e2405d8f6',
  wbtc:'0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  balancer:'0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  multicall:'0xcA11bde05977b3631167028862bE2a173976CA11'
}).map(([k,v])=>[k,v.toLowerCase()]));
// AladdinDAO/fx-sdk src/configs/routers.ts: canonical FX Route and FX Route V3.
export const R = {
  usdcFx:['0x01054062fa20b733978fcbcec244eb8825ae6cfed87c0c'],
  fxUsdc:['0x254062fa20b733978fcbcec244eb8825ae6cfed87c0c'],
  wbtcFx:[
    ['0x040007d269dc8063ef5dff34b49595f97151eebfcff5f45801','0x01054062fa20b733978fcbcec244eb8825ae6cfed87c0c'],
    ['0x04002ee266b2329c21fe928a87ed8d5c9a659688052af0d401','0x01054062fa20b733978fcbcec244eb8825ae6cfed87c0c']
  ]
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
export async function collect(provider){
  const chain=await provider.send('eth_chainId',[]);if(chain!=='0x1')throw Error('Ethereum chain ID 1 required');
  const block=await provider.send('eth_blockNumber',[]);
  const header=await provider.send('eth_getBlockByNumber',[block,false]);
  const result={version:3,chainId:1,block:Number(BigInt(block)),blockHash:header.hash,timestamp:Number(BigInt(header.timestamp)),addresses:C,routes:R};
  for(const [name,address] of Object.entries(C)){if(name==='owner')continue;const code=await provider.send('eth_getCode',[address,block]);if(code==='0x')throw Error(`No deployed code: ${name}`);result.codeHashes??={};result.codeHashes[name]=ethers.keccak256(code);}
  result.decimals={};for(const name of ['usdc','fxusd','wbtc'])result.decimals[name]=Number(await read(provider,C[name],'decimals() view returns(uint8)',[],block));
  if(json(result.decimals)!==json({usdc:6,fxusd:18,wbtc:8}))throw Error('Unexpected token decimals');
  result.poolCollateral=await read(provider,C.pool,'collateralToken() view returns(address)',[],block);
  if(result.poolCollateral.toLowerCase()!==C.wbtc)throw Error('Pool does not hold WBTC');
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
  result.firstQuote=await quote(provider,100400000n,R.usdcFx,block);
  result.firstMinOut=result.firstQuote*999n/1000n;
  if(result.firstMinOut<100200000000000000000n)result.firstMinOut=100200000000000000000n;
  result.returnQuote=await quote(provider,100900000000000000000n,R.fxUsdc,block);
  result.wbtcQuotes=[];for(const routes of R.wbtcFx){try{result.wbtcQuotes.push({routes,input:1000000n,out:await quote(provider,1000000n,routes,block)});}catch(e){result.wbtcQuotes.push({routes,error:safeError(e)});}}
  save('DATA_v3.json',result);console.log(json(result));
  if(!result.positions.some(x=>x.rawDebt>0n))throw Error('Owner has no indebted WBTC position');
  if(result.firstQuote<result.firstMinOut)throw Error('100.4 USDC quote fails 100.2 fxUSD repayment floor');
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.ETH_RPC_URL)throw Error('Repository Ethereum RPC secret is missing');
  collect(new ethers.JsonRpcProvider(process.env.ETH_RPC_URL,1,{staticNetwork:true})).catch(e=>{save('ERROR_v3.json',{error:safeError(e)});console.error(safeError(e));process.exitCode=1;});
}
