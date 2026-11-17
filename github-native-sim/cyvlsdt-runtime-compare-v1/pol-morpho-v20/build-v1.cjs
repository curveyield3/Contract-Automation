'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const solc=require('solc');
const {ethers}=require('ethers');

const SAFE='0x47623C62f281807D615eeb4A2CEee9d97F9D3C49';
const OLD_POL='0x54a71cA4F139e674fAd3B9F18cFc013d6175D677';
const LOCKER='0x4DC535b6aD9eb381A91e472aa3f24F1FDC6Cb21b';
const BOUNDS='0x840fa8496e3B5Ac306281d5Bb5224fA08b5865F8';
const CYVL='0x4B4aA34e805d87458a64d8d745cF7B18e24AeACe';
const SDT='0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F';
const USDC='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const CRV='0xD533a949740bb3306d119CC777fa900bA034cd52';
const OMNI='0xa4a533025fef8d3446e7cb8a434824e1ee865b00';
const CREATECALL='0x9b35af71d77eaf8d7e40252370304687390a1a52';
const MULTISEND='0x40a2accbd92bca938b02010e17a5b8929b49130d';
const ZERO=ethers.ZeroAddress;
const sourcePath=path.join(__dirname,'PoL_Manager_Contract_v20.sol');
const fileName='contracts/PoL_Manager_Contract_v20.sol';
const outDir=path.resolve(process.env.OUTPUT_DIR || path.join(__dirname,'outputs'));
fs.mkdirSync(outDir,{recursive:true});

async function main(){
 const source=fs.readFileSync(sourcePath,'utf8');
 const hash=crypto.createHash('sha256').update(source).digest('hex');
 if(hash!=='d598149e2837ab1acc0482ef420f166286657ea539c779e6975c4bd12f7e391f')
   throw Error('Exact source SHA-256 mismatch: '+hash);
 if(!solc.version().startsWith('0.8.28+commit.7893614a'))throw Error('Wrong Solidity compiler: '+solc.version());
 const input={
  language:'Solidity',
  sources:{[fileName]:{content:source}},
  settings:{
   optimizer:{enabled:true,runs:200},
   viaIR:true,evmVersion:'cancun',
   outputSelection:{'*':{'*':['abi','metadata','evm.bytecode','evm.deployedBytecode','storageLayout']}}
  }
 };
 const output=JSON.parse(solc.compile(JSON.stringify(input)));
 for(const e of output.errors||[])console.log(e.formattedMessage);
 if((output.errors||[]).some(e=>e.severity==='error'))throw Error('Solidity compiler errors');
 const contract=output.contracts?.[fileName]?.PoLManager;
 if(!contract)throw Error('PoLManager output missing');
 const abi=contract.abi,bytecode='0x'+contract.evm.bytecode.object;
 const deployedBytecode='0x'+contract.evm.deployedBytecode.object;
 if(!ethers.isHexString(bytecode)||ethers.dataLength(deployedBytecode)>24576)
   throw Error('Invalid bytecode or contract exceeds EIP-170 size');
 const artifact={
  _format:'hh-sol-artifact-1',contractName:'PoLManager',
  sourceName:fileName,abi,bytecode,deployedBytecode,
  linkReferences:contract.evm.bytecode.linkReferences||{},
  deployedLinkReferences:contract.evm.deployedBytecode.linkReferences||{}
 };
 const args={
  owner:SAFE,
  yearnVaults:[ZERO,ZERO,ZERO],
  sdtYearnIndex:0,
  eulerVaults:[ZERO,ZERO], // The legacy ABI field name now denotes Morpho V1 slots 3 and 4.
  sdtEulerIndex:0,
  crv:CRV,cyvlSDT:CYVL,sdt:SDT,usdc:USDC,omniRouter:OMNI
 };
 const factory=new ethers.ContractFactory(abi,bytecode);
 const create=await factory.getDeployTransaction(args);
 const initcode=create.data;
 const constructorArgs='0x'+initcode.slice(bytecode.length);
 const salt=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','uint256','string'],[SAFE,20,'poLManagerMorphoV1']));
 const predicted=ethers.getCreate2Address(CREATECALL,salt,ethers.keccak256(initcode));
 const createAbi=new ethers.Interface(['function performCreate2(uint256 value,bytes deploymentData,bytes32 salt) returns(address)']);
 const polAbi=new ethers.Interface(abi);
 const lockerAbi=new ethers.Interface(['function setPoLDepositShare(uint16 shareBps,address recipient)']);
 const txs=[
  {label:'1: Create PoL Manager v20 (Morpho V1)',to:CREATECALL,value:'0',operation:0,data:createAbi.encodeFunctionData('performCreate2',[0,initcode,salt])},
  {label:'2: Set existing Curve/Uni guard',to:predicted,value:'0',operation:0,data:polAbi.encodeFunctionData('setLiquidityBounds',[BOUNDS])},
  {label:'3: Profit recipient = existing Locker',to:predicted,value:'0',operation:0,data:polAbi.encodeFunctionData('setProfitRecipient',[LOCKER])},
  {label:'4: Redirect Locker PoL recipient (retain 0% allocation)',to:LOCKER,value:'0',operation:0,data:lockerAbi.encodeFunctionData('setPoLDepositShare',[0,predicted])}
 ];
 const multisendBytes=ethers.concat(txs.map(t=>ethers.solidityPacked(['uint8','address','uint256','uint256','bytes'],[0,t.to,0,ethers.dataLength(t.data),t.data])));
 const multisend=new ethers.Interface(['function multiSend(bytes transactions)']).encodeFunctionData('multiSend',[multisendBytes]);
 const builder={
  version:'1.0',chainId:'1',createdAt:0,
  meta:{name:'CurveYield PoL Manager Morpho V1 v20 - Safe add-on v1',
   description:'Append these 4 operations, IN ORDER, to the existing Ethereum Safe Transaction Builder batch. Vault addresses not yet supplied; zero deposit share preserved.',
   txBuilderVersion:'1.16.3',createdFromSafeAddress:SAFE,createdFromOwnerAddress:''},
  transactions:txs.map(t=>({to:t.to,value:t.value,data:t.data}))
 };
 const write=(name,obj)=>fs.writeFileSync(path.join(outDir,name),JSON.stringify(obj,null,2)+'\n');
 write('PoLManager-v20-Artifact-v1.json',artifact);
 write('PoLManager-v20-Solc-Standard-Input-v1.json',input);
 write('PoLManager-v20-Solc-BuildInfo-v1.json',{
  solcVersion:'0.8.28',solcLongVersion:solc.version(),input,output
 });
 write('Safe-Transaction-Builder-AddOn-v1.json',builder);
 write('Safe-CreateCall-Deploy-v1.json',{chainId:1,owner:SAFE,createCall:CREATECALL,version:'v20',salt,predictedAddress:predicted,constructorArgs,constructorConfig:args,deploymentInitcode: initcode,transaction:txs[0]});
 write('Safe-MultiSend-4Calls-v1.json',{chainId:1,safe:SAFE,to:MULTISEND,operation:1,value:'0',data:multisend,calldataBytes:ethers.dataLength(multisend),transactions:txs});
 write('Safe-4Calls-v1.json',{chainId:1,safe:SAFE,transactions:txs});
 write('Onchain-Config-Pins-v1.json',{chainId:1,originalPoL:OLD_POL,newPoL:predicted,locker:LOCKER,liquidityBounds:BOUNDS,depositShareBps:0,profitRecipient:LOCKER,curveSlippageBps:200,defaultLossLimitBps:{yearn:100,morpho:100},owner:SAFE,yearnVaultSlots:[0,1,2],morphoVaultSlots:[3,4],designatedSDTYearnSlot:0,designatedSDTMorphoSlot:3,otherContractsRedeployRequired:false});
 write('Build-Manifest-v1.json',{version:'v20-v1',sha256Source:hash,compilerVersion:solc.version(),evmVersion:'cancun',optimizerRuns:200,viaIR:true,contractName:'PoLManager',bytecodeBytes:ethers.dataLength(bytecode),deployedBytes:ethers.dataLength(deployedBytecode),predictedAddress:predicted,constructorArgsBytes:ethers.dataLength(constructorArgs),safeCalls:txs.length,totalMultiSendCalldataBytes:ethers.dataLength(multisend),notes:['Morpho V1 ONLY: V2 maxRedeem is always zero.','Yearn/Morpho vaults left unconfigured, owner may setVault later.','Existing Locker PoL deposit share retained at 0%; no new fund flow enabled.']});
 console.log('POL_V20_BUILD_SUCCESS',JSON.stringify({compiler:solc.version(),sourceSha256:hash,deployedBytes:ethers.dataLength(deployedBytecode),initcodeBytes:ethers.dataLength(initcode),predictedAddress:predicted,addOnCalls:txs.length,multiSendBytes:ethers.dataLength(multisend)}));
}
main().catch(e=>{console.error('POL_V20_BUILD_ERROR',e.stack||e);process.exitCode=1});
