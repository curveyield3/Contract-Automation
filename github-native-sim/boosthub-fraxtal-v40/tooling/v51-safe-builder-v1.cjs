'use strict';
const fs=require('fs'),path=require('path'),e=require('ethers');
const W=path.resolve(__dirname,'..'),O=path.join(W,'build','safe-mainnet-v51-v23-v1'),P=path.join(W,'build','pol-artifacts-v23');
const S='0x47623C62f281807D615eeb4A2CEee9d97F9D3C49',H='0x40f7085841034f752f17592875703eb5032f2b42',
 R='0xa4a533025fef8d3446e7cb8a434824e1ee865b00',C='0x9b35af71d77eaf8d7e40252370304687390a1a52',
 M='0x40a2accbd92bca938b02010e17a5b8929b49130d',G6='0x840fa8496e3B5Ac306281d5Bb5224fA08b5865F8',
 A='0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5',B='0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD',
 F='0x365AccFCa291e7D3914637ABf1F7635dB165Bb09',CP='0x28Ca243dc0aC075dD012fCf9375C25D18A844d96',
 BOOSTER='0xAffe966B27ba3E4Ebb8A0eC124C7b7019CC762f8';
const HUB_ABI=['function owner() view returns(address)','function poolInfo(uint256) view returns(tuple(address asset,address gauge,bool active,uint256 totalStaked,address[] rewardTokens,address depositor,bool depositorLocked,bytes4 checkpointSelector,uint16 platformFeeBps,address platformFeeRecipient,bool feeConfigSet,uint256[] accRewardPerShare))','function setApprovedDepositors(uint256,address[],bool[],bool)'];
const ROUTER_ABI=['function owner() view returns(address)','function routeLength(address,address) view returns(uint256)','function setRoute(address,address,tuple(uint16,address,address,bytes32,bytes,tuple(address,bytes4,bytes,bool,uint8))[])'];
const HI=new e.Interface(['function deploy(bytes,bool) returns(address)','function configure(address,bytes)']);
const CI=new e.Interface(['function performCreate2(uint256,bytes,bytes32) returns(address)']);
const XI=new e.Interface(['function multiSend(bytes)']);
const RI=new e.Interface(ROUTER_ABI),BI=new e.Interface(HUB_ABI);
const MI=new e.Interface(['function configureChildren(address,address)','function setConvexCurveLiquidityGuard(address)','function transferOwnership(address)']);
const coder=e.AbiCoder.defaultAbiCoder(),is=(a,b)=>a.toLowerCase()===b.toLowerCase();
const load=(p)=>JSON.parse(fs.readFileSync(p,'utf8'));
const artifact=(name)=>{const d=load(path.join(W,'build/forge',name+'.sol',name+'.json'));return{name,abi:d.abi,bytecode:d.bytecode.object,deployedBytecode:d.deployedBytecode.object}};
const code=async(a,args)=>(await new e.ContractFactory(a.abi,a.bytecode).getDeployTransaction(...args)).data;
const tx=(label,to,data,contract)=>({label,to:e.getAddress(to),data,value:'0',contract});
const viaHelper=(name,helper,code,handoff,contract)=>tx(name,helper,HI.encodeFunctionData('deploy',[code,handoff]),contract);
const viaCall=(name,helper,target,data)=>tx(name,helper,HI.encodeFunctionData('configure',[target,data]));
const encodeMulti=(ts)=>XI.encodeFunctionData('multiSend',[e.concat(ts.map(t=>e.solidityPacked(['uint8','address','uint256','uint256','bytes'],[0,t.to,0,e.getBytes(t.data).length,t.data])))]);
async function main(){
 const rpc=process.env.RPC_ETHEREUM;if(!rpc)throw Error('Missing RPC_ETHEREUM secret');
 const provider=new e.JsonRpcProvider(rpc,1,{staticNetwork:true});
 const hub=new e.Contract(H,HUB_ABI,provider),router=new e.Contract(R,ROUTER_ABI,provider);
 if(!is(await hub.owner(),S)||!is(await router.owner(),S))throw Error('Hub/router not Safe owned');
 const p0=await hub.poolInfo(0),p1=await hub.poolInfo(1);
 if(!is(p0.asset,A)||!is(p1.asset,B)||!p0.active||!p1.active||p0.depositorLocked||p1.depositorLocked)throw Error('Hub pool mismatch/locked');
 const curve=new e.Contract(CP,['function coins(uint256) view returns(address)','function price_oracle() view returns(uint256)'],provider);
 if(!is(await curve.coins(0),F)||!is(await curve.coins(1),B)||(await curve.price_oracle())===0n)throw Error('Curve pool historical oracle mismatch');
 const guard=new e.Contract(G6,['function quoteDeposit(address,uint8,uint256,uint16) view returns(uint256,uint256)'],provider);
 if((await guard.quoteDeposit(CP,1,e.parseEther('1'),100))[1]===0n)throw Error('Existing Convex V6 guard unavailable');
 if((await router.routeLength(B,F))!==0n||(await router.routeLength(F,B))!==0n)throw Error('Router routes have changed');
 const stakingRaw=load(path.join(W,'artifacts/staking.json'));
 const staking={name:'BoostHubStaking',abi:stakingRaw.abi,bytecode:stakingRaw.bytecode,deployedBytecode:stakingRaw.deployedBytecode};
 const sdcrv=artifact('StrategyConvexBoostHubStakingV5'),boost=artifact('StrategyBoostHubChildV42'),
 convex=artifact('StrategyConvexFXNPool8V42'),master=artifact('StrategyDualFXNMasterV42'),vault=artifact('BeefyVaultV7FixedV2');
 const helper={...load(path.join(P,'CurveYieldSafeDeployHelper-v1-Artifact.json')),name:'CurveYieldSafeDeployHelperV1'};
 const pol=load(path.join(P,'Safe-Transaction-Builder-AddOn-v5.json'));
 const polAddr=load(path.join(P,'Predicted-Addresses-and-ConstructorArgs-v5.json'));
 const polManifest=load(path.join(P,'Build-Manifest-v5.json'));
 if(pol.transactions.length!==7||!is(polAddr.owner,S)||polManifest.managerRuntimeBytes>24576)throw Error('Invalid PoL artifacts');
 const hcode=await code(helper,[S]),hsalt=e.id('CurveYieldSafeDeployHelperV1-ETHEREUM-MAINNET-SAFE-v1');
 const haddr=e.getCreate2Address(C,hsalt,e.keccak256(hcode));
 const createHelper=tx('Deploy 958-byte Safe-only deployment helper',C,CI.encodeFunctionData('performCreate2',[0,hcode,hsalt]),helper.name);
 async function newStaking(pid,asset,pool){
  const rewards=[...pool.rewardTokens].filter(x=>!is(x,asset));
  if(rewards.length>8)throw Error('Hub reward count exceeds 8 for PID '+pid);
  while(rewards.length<8)rewards.push(e.ZeroAddress);
  const init=await code(staking,[asset,H,pid,S,rewards,S,150]);
  const salt=e.id('CurveYield-BoostHub-v51-Ethereum-Staking-PID-'+pid+'-Safe-v1');
  const addr=e.getCreate2Address(C,salt,e.keccak256(init));
  return{addr,init,tx:tx('Deploy new staking PID'+pid,C,CI.encodeFunctionData('performCreate2',[0,init,salt]),staking.name)};
 }
 const s0=await newStaking(0,A,p0),s1=await newStaking(1,B,p1);
 const [addrStrat0,addrVault0,addrMaster,addrBoost,addrConvex,addrVault1]=[1,2,3,4,5,6].map(n=>e.getCreateAddress({from:haddr,nonce:n}));
 const struct0=[A,addrVault0,R,S],struct1=[B,addrMaster,R,S],fee0=[300,1000,9000],fee1=[1300,1000,9000];
 const initStrat0=await code(sdcrv,[s0.addr,struct0,fee0,86400,0]);
 const initVault0=await code(vault,[addrStrat0,'CurveYield sdCRV','cysdCRV',35,S]);
 const initMaster=await code(master,[addrVault1,B,F,R]);
 const initBoost=await code(boost,[s1.addr,struct1,fee0,86400,0]);
 const initConvex=await code(convex,[BOOSTER,CP,F,struct1,fee1,86400,0]);
 const initVault1=await code(vault,[addrMaster,'CurveYield sdFXN','cysdFXN',45,S]);
 const priceSelector=e.id('price_oracle()').slice(0,10);
 const hop=(dest,i,j,invert)=>[6,dest,CP,e.ZeroHash,coder.encode(['uint8','uint8'],[i,j]),[CP,priceSelector,'0x',invert,18]];
 const targets=[haddr,s0.addr,s1.addr,addrStrat0,addrVault0,addrMaster,addrBoost,addrConvex,addrVault1,polAddr.manager,polAddr.guard];
 for(const a of targets)if(await provider.getCode(a)!=='0x')throw Error('Predicted deployment already exists '+a);
 const b1=[createHelper,s0.tx,s1.tx,
  tx('Approve PID0 staking without revoking prior depositors',H,BI.encodeFunctionData('setApprovedDepositors',[0,[s0.addr],[true],false])),
  tx('Approve PID1 staking without revoking prior depositors',H,BI.encodeFunctionData('setApprovedDepositors',[1,[s1.addr],[true],false])),
  viaHelper('Deploy sdCRV strategy',haddr,initStrat0,false,sdcrv.name),
  viaHelper('Deploy sdCRV vault and transfer owner to Safe',haddr,initVault0,true,vault.name),
  tx('Deploy new V8 PoL guard only',pol.transactions[0].to,pol.transactions[0].data,'CurvePairOracleBoundsV8'),
  tx('Configure missing sdFXN-FXN Curve EMA route',R,RI.encodeFunctionData('setRoute',[B,F,[hop(F,1,0,true)]])),
  tx('Configure missing FXN-sdFXN Curve EMA route',R,RI.encodeFunctionData('setRoute',[F,B,[hop(B,0,1,false)]]))];
 const b2=[
  viaHelper('Deploy sdFXN dual-child master',haddr,initMaster,false,master.name),
  viaHelper('Deploy sdFXN BoostHub child',haddr,initBoost,false,boost.name),
  viaHelper('Deploy sdFXN Convex Pool8 child',haddr,initConvex,false,convex.name),
  viaCall('Initialize master children',haddr,addrMaster,MI.encodeFunctionData('configureChildren',[addrBoost,addrConvex])),
  viaCall('Use existing V6 Convex liquidity guard',haddr,addrMaster,MI.encodeFunctionData('setConvexCurveLiquidityGuard',[G6])),
  viaHelper('Deploy sdFXN vault, transfer owner to Safe',haddr,initVault1,true,vault.name),
  viaCall('Transfer master ownership to Safe',haddr,addrMaster,MI.encodeFunctionData('transferOwnership',[S])),
  ...pol.transactions.slice(1).map((t,i)=>tx('PoL v23 deployment/configuration step '+(i+2),t.to,t.data,i===0?'PoLManagerV23':null))];
 const guardCreate=CI.decodeFunctionData('performCreate2',pol.transactions[0].data)[1];
 const deployed=[
  [1,helper.name,hcode,helper.deployedBytecode],[1,staking.name,s0.init,staking.deployedBytecode],
  [1,staking.name,s1.init,staking.deployedBytecode],[1,sdcrv.name,initStrat0,sdcrv.deployedBytecode],
  [1,vault.name,initVault0,vault.deployedBytecode],[1,'CurvePairOracleBoundsV8',guardCreate,null],
  [2,master.name,initMaster,master.deployedBytecode],[2,boost.name,initBoost,boost.deployedBytecode],
  [2,convex.name,initConvex,convex.deployedBytecode],[2,vault.name,initVault1,vault.deployedBytecode],
  [2,'PoLManagerV23',polAddr.managerInitCode,null]];
 const metrics=[1,2].map((i)=>{
  const contracts=deployed.filter(d=>d[0]===i).map(d=>({name:d[1],creationBytes:e.getBytes(d[2]).length,
   runtimeBytes:d[3]?e.getBytes(d[3]).length:d[1]==='PoLManagerV23'?polManifest.managerRuntimeBytes:polManifest.guardRuntimeBytes}));
  const ts=i===1?b1:b2;
  return{batch:i,contracts,creationBytes:contracts.reduce((a,x)=>a+x.creationBytes,0),
   runtimeBytes:contracts.reduce((a,x)=>a+x.runtimeBytes,0),transactionCount:ts.length,
   innerCalldataBytes:ts.reduce((a,x)=>a+e.getBytes(x.data).length,0),multiSendCalldataBytes:e.getBytes(encodeMulti(ts)).length};
 });
 const creationDiff=Math.abs(metrics[0].creationBytes-metrics[1].creationBytes);
 const runtimeDiff=Math.abs(metrics[0].runtimeBytes-metrics[1].runtimeBytes);
 if(creationDiff/Math.max(metrics[0].creationBytes,metrics[1].creationBytes)>.06||
    runtimeDiff/Math.max(metrics[0].runtimeBytes,metrics[1].runtimeBytes)>.06)throw Error('Batches not balanced within 6%');
 const nonce=await new e.Contract(S,['function nonce() view returns(uint256)'],provider).nonce();
 fs.mkdirSync(O,{recursive:true});
 for(const [i,ts] of [[1,b1],[2,b2]]){
  const out={version:'v1',chainId:1,safe:S,nonce:(nonce+BigInt(i-1)).toString(),to:M,operation:1,value:'0',
   data:encodeMulti(ts),transactions:ts,metrics:metrics[i-1]};
  fs.writeFileSync(path.join(O,'Safe-Batch-'+i+'-v1.json'),JSON.stringify(out,null,2));
  fs.writeFileSync(path.join(O,'Safe-Transaction-Builder-Batch-'+i+'-v1.json'),JSON.stringify({
   version:'1.0',chainId:'1',createdAt:0,meta:{name:'CurveYield BoostHub v51 PoL v23 Batch '+i+'/2',
   txBuilderVersion:'1.16.3',createdFromSafeAddress:S},
   transactions:ts.map(t=>({to:t.to,value:t.value,data:t.data}))},null,2));
 }
 const manifest={version:'v1',chainId:1,safe:S,startNonce:nonce.toString(),deploymentHelper:haddr,
  sdCRV:{staking:s0.addr,strategy:addrStrat0,vault:addrVault0},
  sdFXN:{staking:s1.addr,master:addrMaster,boostChild:addrBoost,convexChild:addrConvex,vault:addrVault1},
  polManager:polAddr.manager,polGuard:polAddr.guard,reusedConvexGuard:G6,
  creationByteDifference:creationDiff,runtimeByteDifference:runtimeDiff,
  batches:metrics,source:'GitHub-compiled exact v51 Vyper/Solidity plus PoL v23',submissionState:'UNSUBMITTED'};
 fs.writeFileSync(path.join(O,'Balanced-Safe-Manifest-v1.json'),JSON.stringify(manifest,null,2));
 console.log('BALANCED_TWO_BATCHES_READY');console.log(JSON.stringify(manifest,null,2));
}
main().catch(x=>{console.error(x);process.exitCode=1});
