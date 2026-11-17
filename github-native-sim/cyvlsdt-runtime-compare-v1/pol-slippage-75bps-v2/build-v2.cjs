'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const solc28=require('solc');
const solc30=require(process.env.SOLC30_PATH);
const {ethers}=require('ethers');
const DIR=__dirname;
const OUT=path.join(DIR,'outputs-v2');
fs.mkdirSync(OUT,{recursive:true});
const SAFE='0x47623C62f281807D615eeb4A2CEee9d97F9D3C49';
const LOCKER='0x4DC535b6aD9eb381A91e472aa3f24F1FDC6Cb21b';
const CRV='0xD533a949740bb3306d119CC777fa900bA034cd52';
const CYVL='0x4B4aA34e805d87458a64d8d745cF7B18e24AeACe';
const SDT='0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F';
const USDC='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const OMNI='0xa4a533025fef8d3446e7cb8a434824e1ee865b00';
const CREATE='0x9b35af71d77eaf8d7e40252370304687390a1a52';
const MULTISEND='0x40a2accbd92bca938b02010e17a5b8929b49130d';
const ZERO=ethers.ZeroAddress;
const write=(file,data)=>fs.writeFileSync(path.join(OUT,file),JSON.stringify(data,null,2)+'\n');
const read=(file)=>fs.readFileSync(path.join(DIR,file),'utf8');
const sha=(data)=>crypto.createHash('sha256').update(data).digest('hex');
function build(solc,sources){
 const input={language:'Solidity',sources:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,{content:v}])),
  settings:{optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:'cancun',
   outputSelection:{'*':{'*':['abi','metadata','evm.bytecode','evm.deployedBytecode','storageLayout']}}}};
 const output=JSON.parse(solc.compile(JSON.stringify(input)));
 for(const e of output.errors||[])console.log(e.formattedMessage);
 if((output.errors||[]).some(e=>e.severity==='error'))throw Error('Solc compile errors');
 return {input,output};
}
function artifact(compiled,file,contractName){
 const c=compiled.output.contracts[file]?.[contractName];if(!c)throw Error('Compiled contract missing: '+file+':'+contractName);
 const out={_format:'hh-sol-artifact-1',contractName,sourceName:file,abi:c.abi,
  bytecode:'0x'+c.evm.bytecode.object,deployedBytecode:'0x'+c.evm.deployedBytecode.object,
  linkReferences:c.evm.bytecode.linkReferences||{},deployedLinkReferences:c.evm.deployedBytecode.linkReferences||{}};
 if(!ethers.isHexString(out.bytecode)||!ethers.isHexString(out.deployedBytecode))throw Error('Unlinked bytecode');
 if(ethers.dataLength(out.deployedBytecode)>24576)throw Error('EIP170 cap exceeded: '+contractName);
 return out;
}
async function main(){
 if(!solc28.version().startsWith('0.8.28+commit.7893614a'))throw Error('wrong manager solc');
 if(!solc30.version().startsWith('0.8.30+commit.73712a01'))throw Error('wrong guard solc');
 const srcManager=read('PoL_Manager_Contract_v21.sol');
 const srcGuard=read('CurvePairOracleBounds_v7.sol');
 const srcTickMath=read('UniV3TickMath_v6.sol');
 const srcStress=read('StressSlippageHarness_v2.sol');
 const managerFile='contracts/PoL_Manager_Contract_v21.sol';
 const guardFile='contracts/CurvePairOracleBounds_v7.sol';
 const stressFile='contracts/StressSlippageHarness_v2.sol';
 const m=build(solc28,{[managerFile]:srcManager});
 const g=build(solc30,{[guardFile]:srcGuard,'contracts/UniV3TickMath_v6.sol':srcTickMath});
 const t=build(solc28,{[stressFile]:srcStress});
 const pol=artifact(m,managerFile,'PoLManager');
 const guard=artifact(g,guardFile,'CurvePairOracleBoundsV7');
 const mocks={};
 for(const name of ['StressERC20V2','StressThreeCoinNGV2','StressUniOraclePoolV2','StressUniFactoryV2','StressUniNFTV2','StressHistoricalRouterV2','Stress4626BasicV2']){
  mocks[name]=artifact(t,stressFile,name);
 }
 const cfg={owner:SAFE,yearnVaults:[ZERO,ZERO,ZERO],sdtYearnIndex:0,
  eulerVaults:[ZERO,ZERO],sdtEulerIndex:0,crv:CRV,cyvlSDT:CYVL,sdt:SDT,usdc:USDC,omniRouter:OMNI};
 const managerTx=await new ethers.ContractFactory(pol.abi,pol.bytecode).getDeployTransaction(cfg);
 const guardTx=await new ethers.ContractFactory(guard.abi,guard.bytecode).getDeployTransaction();
 const depInterface=new ethers.Interface(['function performCreate2(uint256 value,bytes deploymentData,bytes32 salt) returns(address)']);
 const mSalt=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','uint256','string'],[SAFE,21,'pol-morpho-v21-execution-75bps']));
 const gSalt=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','uint256','string'],[SAFE,7,'curve-bounds-v7-75bps']));
 const predictedManager=ethers.getCreate2Address(CREATE,mSalt,ethers.keccak256(managerTx.data));
 const predictedGuard=ethers.getCreate2Address(CREATE,gSalt,ethers.keccak256(guardTx.data));
 const polInterface=new ethers.Interface(pol.abi);
 const lockerInterface=new ethers.Interface(['function setPoLDepositShare(uint16 shareBps,address recipient)']);
 const txs=[
 {label:'Deploy CurvePairOracleBounds V7, 75 bps',to:CREATE,value:'0',operation:0,
  data:depInterface.encodeFunctionData('performCreate2',[0,guardTx.data,gSalt])},
 {label:'Deploy PoL Manager v21, Morpho V1, 75 bps',to:CREATE,value:'0',operation:0,
  data:depInterface.encodeFunctionData('performCreate2',[0,managerTx.data,mSalt])},
 {label:'Set new 75 bps guard on new PoL Manager',to:predictedManager,value:'0',operation:0,
  data:polInterface.encodeFunctionData('setLiquidityBounds',[predictedGuard])},
 {label:'Explicitly set Curve execution slippage maximum to 75 bps',to:predictedManager,value:'0',operation:0,
  data:polInterface.encodeFunctionData('setCurveSlippageBps',[75])},
 {label:'Set existing Locker as PoL profit recipient',to:predictedManager,value:'0',operation:0,
  data:polInterface.encodeFunctionData('setProfitRecipient',[LOCKER])},
 {label:'Redirect Locker to new PoL Manager, preserving 0 bps revenue share',to:LOCKER,value:'0',operation:0,
  data:lockerInterface.encodeFunctionData('setPoLDepositShare',[0,predictedManager])}
 ];
 const encoded=ethers.concat(txs.map(x=>ethers.solidityPacked(['uint8','address','uint256','uint256','bytes'],[0,x.to,0,ethers.dataLength(x.data),x.data])));
 const multi=new ethers.Interface(['function multiSend(bytes transactions)']).encodeFunctionData('multiSend',[encoded]);
 const builder={version:'1.0',chainId:'1',createdAt:0,
  meta:{name:'CurveYield PoL Morpho V1 v21 + Bounds V7 (0.75% max) add-on v2',
   description:'6 ordered Safe actions; SDT/USDC remains at 2% max in PoL Manager; requires OmniRouter route setup before swaps.',
   txBuilderVersion:'1.16.3',createdFromSafeAddress:SAFE,createdFromOwnerAddress:''},
  transactions:txs.map(x=>({to:x.to,value:x.value,data:x.data}))};
 write('PoLManager-v21-Artifact-v2.json',pol);
 write('CurvePairOracleBounds-v7-Artifact-v2.json',guard);
 write('Stress-Simulation-Mock-Artifacts-v2.json',mocks);
 write('PoLManager-v21-Solc-BuildInfo-v2.json',{solcVersion:'0.8.28',solcLongVersion:solc28.version(),...m});
 write('CurvePairOracleBounds-v7-Solc-BuildInfo-v2.json',{solcVersion:'0.8.30',solcLongVersion:solc30.version(),...g});
 write('Safe-Transaction-Builder-AddOn-v2.json',builder);
 write('Safe-MultiSend-6Calls-v2.json',{safe:SAFE,chainId:1,to:MULTISEND,operation:1,value:'0',
  data:multi,calldataBytes:ethers.dataLength(multi),transactions:txs});
 write('Predicted-Addresses-and-ConstructorArgs-v2.json',{
  manager:predictedManager,guard:predictedGuard,owner:SAFE,locker:LOCKER,createCall:CREATE,
  managerSalt:mSalt,guardSalt:gSalt,managerConstructorArgs:'0x'+managerTx.data.slice(pol.bytecode.length),
  guardConstructorArgs:'',managerInitCode:managerTx.data,guardInitCode:guardTx.data
 });
 const manifest={version:'v2',managerSourceSha256:sha(srcManager),guardSourceSha256:sha(srcGuard),
  dependencySourceSha256:sha(srcTickMath),compilerManager:solc28.version(),compilerGuard:solc30.version(),
  managerRuntimeBytes:ethers.dataLength(pol.deployedBytecode),guardRuntimeBytes:ethers.dataLength(guard.deployedBytecode),
  predictedManager,predictedGuard,safeActions:txs.length,multiSendBytes:ethers.dataLength(multi),
  deploymentAuthorized:false,
  risk:'Route availability currently unconfigured; 2% SDT/USDC limit is enforced as a maximum in PoL, not proof Router has routes set. Uniswap NFT must be configured separately after NFT/pool exist.'};
 write('Build-Manifest-v2.json',manifest);
 console.log('POL_V21_V7_BUILD_PASS',JSON.stringify(manifest));
}
main().catch(e=>{console.error('POL_V21_V7_BUILD_FAIL',e.stack||e);process.exitCode=1;});
