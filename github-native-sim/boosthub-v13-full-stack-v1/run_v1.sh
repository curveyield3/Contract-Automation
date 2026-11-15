#!/usr/bin/env bash
set -euo pipefail
# Branch-scoped v34 Ethereum deployment + 5000-block post-action fork campaign.
if [[ "${GITHUB_REF_NAME:-}" == "boosthub-v34-ethereum-fork-sim" ]]; then
  ROOT="$GITHUB_WORKSPACE/.boosthub-v34-full"
  : "${RPC_ETHEREUM:?Missing Ethereum RPC secret}"
  test "$(timeout 25s cast chain-id --rpc-url "$RPC_ETHEREUM")" = 1
  mkdir -p "$ROOT/post-actions"
  anvil --fork-url "$RPC_ETHEREUM" --chain-id 1 --port 8545 \
    > boosthub-v34-anvil-ethereum-v1.log 2>&1 &
  ANVIL_PID=$!
  trap 'kill "$ANVIL_PID" 2>/dev/null || true' EXIT
  READY=0
  for i in $(seq 1 60); do
    if [ "$(timeout 4s cast chain-id --rpc-url http://127.0.0.1:8545 2>/dev/null || true)" = 1 ]; then READY=1; break; fi
    sleep 2
  done
  test "$READY" -eq 1
  FORK_RPC=http://127.0.0.1:8545
  SENDER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
  START_BLOCK="$(cast block-number --rpc-url "$FORK_RPC")"
  export BOOSTHUB_V34_FORK_RPC="$FORK_RPC" BOOSTHUB_V34_START_BLOCK="$START_BLOCK"
  export BOOSTHUB_V34_ROOT="$ROOT" BOOSTHUB_V34_TEST_ACCOUNT="$SENDER"
  export NODE_PATH="$RUNNER_TEMP/boosthub-v34-js/node_modules"
  echo "[v34] Starting Ethereum fork deployment at block $START_BLOCK"
  set +e
  (cd "$ROOT" && timeout -s TERM -k 10s 1200s forge script \
     script/DeployBoostHubStack.s.sol:DeployBoostHubStack \
     --root "$ROOT" --rpc-url "$FORK_RPC" --broadcast --unlocked \
     --sender "$SENDER" --slow -vvv) 2>&1 | tee boosthub-v34-full-deploy-v1.log
  DEPLOY_STATUS=${PIPESTATUS[0]}
  set -e
  if [ "$DEPLOY_STATUS" -ne 0 ]; then
    echo "[v34] Deployment failed, status=$DEPLOY_STATUS; post-action fork calls cannot run"
    exit "$DEPLOY_STATUS"
  fi

  cat > "$RUNNER_TEMP/boosthub-v34-js/post_action_v1.cjs" <<'JS'
'use strict';
const fs = require('fs'), path = require('path');
const { ethers } = require('ethers');
const ROOT=process.env.BOOSTHUB_V34_ROOT;
const rpc=process.env.BOOSTHUB_V34_FORK_RPC;
const base=Number(process.env.BOOSTHUB_V34_START_BLOCK);
const output=path.join(ROOT,'post-actions','ethereum-v34-summary.json');
const provider=new ethers.JsonRpcProvider(rpc,1,{staticNetwork:true});
const account=process.env.BOOSTHUB_V34_TEST_ACCOUNT;
const result={kind:'BoostHub-v34-Ethereum-full-live-fork',chain:1,sourceSha256:'4c371a44aab88dab46e899bb03c98f76517e67db685cf803df84e10e6b18fa00',startBlock:base,steps:[],snapshots:[],assertions:[],errors:[],rewards:'fork-only 0.2 WETH per staking wrapper added through registered external-reward API, separately from actual gauge claim results'};
const zero=ethers.ZeroAddress;
const toString=(v)=>typeof v==='bigint'?v.toString():v;
const slim=(obj)=>JSON.parse(JSON.stringify(obj,(key,value)=>typeof value==='bigint'?value.toString():value));
function recordCheck(label,ok,observed){result.assertions.push({label,ok,observed:slim(observed)});if(!ok)result.errors.push({label,kind:'invariant',observed:slim(observed)});}
async function revertInfo(hash,err){return {hash,errorData:err?.data||err?.error?.data||err?.info?.error?.data||null,trace:'skipped: no slow full-transaction trace; inspect targeted reward/oracle state'};}
async function act(label,fn,mandatory=true){let tx;
 try{tx=await fn();let rc=null;
  for(let attempt=0;attempt<60;attempt++){
    rc=await provider.send('eth_getTransactionReceipt',[tx.hash]);
    if(rc)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!rc)throw new Error('Mined receipt unavailable after 60 seconds: '+tx.hash);
  const receiptDir=path.join(ROOT,'post-actions','receipts');fs.mkdirSync(receiptDir,{recursive:true});
  fs.writeFileSync(path.join(receiptDir,tx.hash+'.json'),JSON.stringify({label,receipt:rc}));
  const info={label,ok:BigInt(rc.status)===1n,hash:tx.hash,gasUsed:BigInt(rc.gasUsed).toString(),blockNumber:Number(BigInt(rc.blockNumber)),logs:rc.logs.length};
  result.steps.push(info);
  console.log('[v34] '+label+' receipt='+tx.hash+' block='+info.blockNumber+' ok='+info.ok);
  if(!info.ok)throw new Error('Transaction status 0');
  return rc;}
 catch(e){const msg=String(e?.shortMessage||e?.reason||e?.message||e).slice(0,2200);const hash=tx?.hash||e?.transactionHash||e?.receipt?.hash||null;
  const diagnosis=await revertInfo(hash,e);result.steps.push({label,ok:false,error:msg,diagnosis});
  if(mandatory)result.errors.push({label,error:msg,diagnosis});return null;}
}
function artifact(contract){if(contract==='BoostHubStaking')return JSON.parse(fs.readFileSync(path.join(ROOT,'artifacts','staking.json'),'utf8'));const d=path.join(ROOT,'build','forge');if(!fs.existsSync(d))throw Error('Missing Forge outputs: '+d);for(const sub of fs.readdirSync(d)){const p=path.join(d,sub,contract+'.json');if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,'utf8'));}throw Error('Missing artifact '+contract);}
function bind(contract,address,actor){return new ethers.Contract(address,artifact(contract).abi,actor||provider);}
async function safeStatic(address,signature,args=[]){try{const c=new ethers.Contract(address,[`function ${signature}`],provider);return await c[signature.split('(')[0]](...args);}catch(e){return null;}}
async function findDeployment(){
 const end=await provider.getBlockNumber();result.deploymentEndBlock=end;
 const evPool=ethers.id('PoolAdded(uint256,address,address)');
 const evDeposit=ethers.id('PoolDepositorApproval(uint256,address,bool)');
 const evPartner=ethers.id('PartnerPairCreated(address,address,address)');
 const poolLogs=await provider.getLogs({fromBlock:base,toBlock:end,topics:[evPool]});
 if(poolLogs.length!==2)throw Error('Expected 2 Hub PoolAdded logs; saw '+poolLogs.length);
 const hubAddr=poolLogs[0].address;
 const stLogs=await provider.getLogs({address:hubAddr,fromBlock:base,toBlock:end,topics:[evDeposit]});
 const stash={};for(const log of stLogs){const p=Number(BigInt(log.topics[1]));const addr=ethers.getAddress('0x'+log.topics[2].slice(-40));if(BigInt(log.data)===1n)stash[p]=addr;}
 if(!stash[0]||!stash[1])throw Error('Missing approved staking depositors in Hub events: '+JSON.stringify(stash));
 const partnerLogs=await provider.getLogs({fromBlock:base,toBlock:end,topics:[evPartner]});
 if(partnerLogs.length!==2)throw Error('Expected 2 PartnerPairCreated logs; got '+partnerLogs.length);
 const partner={};for(const log of partnerLogs){const staking=ethers.getAddress('0x'+log.topics[3].slice(-40));const pid=Object.keys(stash).find(x=>stash[x].toLowerCase()===staking.toLowerCase());if(pid===undefined)throw Error('Unexpected partner staking: '+staking);partner[pid]={strategy:ethers.getAddress('0x'+log.topics[1].slice(-40)),vault:ethers.getAddress('0x'+log.topics[2].slice(-40)),staking};}
 const custom={};let topCreateCount=0;
 for(let bn=base+1;bn<=end;bn++){
   const b=await provider.send('eth_getBlockByNumber',[ethers.toQuantity(bn),true]);
   for(const tx of b.transactions||[]){if(tx.to)continue;topCreateCount++;
      const rc=await provider.getTransactionReceipt(tx.hash);const addr=rc.contractAddress;if(!addr)continue;
      let strategy=await safeStatic(addr,'strategy() view returns (address)');
      let want=await safeStatic(addr,'want() view returns (address)');
      if(!strategy||!want||strategy===zero)continue;
      for(const pid of [0,1]){
        const token=pid===0?'0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5':'0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD';
        if(want.toLowerCase()===token.toLowerCase())custom[pid]={vault:addr,strategy};
      }
   }
 }
 if(!custom[0]||!custom[1])throw Error('Could not identify both original custom vaults: '+JSON.stringify(custom));
 const entries=[];
 for(const pid of [0,1]){
   entries.push({pid,kind:'original',...custom[pid],staking:stash[pid]});
   entries.push({pid,kind:'beefy-partner',...partner[pid]});
 }
 result.deployments={hub:hubAddr,staking:stash,custom,partner,topLevelCreated:topCreateCount};
 return {entries,hubAddr,staking:stash};
}
async function snapshot(tag,ctx){
 const arr=[];const hubs=[];
 for(const pid of [0,1]){
  const hub=bind('BoostHub',ctx.hubAddr);
  const info=await hub.poolInfo(pid);
  const stake=bind('BoostHubStaking',ctx.staking[pid]);
  const total=await stake.total_staked();
  const h=await hub.positionInfo(pid,ctx.staking[pid]);
  hubs.push({pid,stakingTotal:total.toString(),hubPoolTotal:(info.totalStaked??info[3]??0n).toString(),hubStakingPosition:(h.principal??h[0]??0n).toString(),stakingRewardCount:(await stake.reward_count()).toString()});
 }
 for(const e of ctx.entries){
  const vault=bind(e.kind==='original'?'BeefyVaultV7FixedV2':'BeefyVaultV7',e.vault);
  const strat=bind(e.kind==='original'?'StrategyConvexBoostHubStakingV5':'StrategyConvexBoostHubPartnerV2',e.strategy);
  const stake=bind('BoostHubStaking',e.staking);
    const pool=await strat.balanceOfPool();
  const reward=await stake.claimable_reward(e.strategy,'0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2').catch(()=>0n);
  const data={pid:e.pid,kind:e.kind,vault:e.vault,strategy:e.strategy,
    vaultTotalSupply:(await vault.totalSupply()).toString(),vaultUserShares:(await vault.balanceOf(account)).toString(),
    vaultAssetBalance:(await vault.balance()).toString(),vaultPPS:(await vault.getPricePerFullShare()).toString(),
    strategyBalanceOfPool:pool.toString(),stakingStakedBalance:(await stake.balanceOf(e.strategy)).toString(),
    strategyBalanceOf:(await strat.balanceOf()).toString(),unclaimedWETH:reward.toString(),
    stakingTotalStaked:(await stake.total_staked()).toString()};
  arr.push(data);
 }
 const block=await provider.getBlock('latest');
 result.snapshots.push({tag,blockNumber:block.number,timestamp:block.timestamp,hubs,vaults:arr});
 return {hubs,vaults:arr};
}
async function main(){
 const {entries,hubAddr,staking}=await findDeployment();
 const ctx={entries,hubAddr,staking};
 const signer=await provider.getSigner(account);
 const WETH='0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
 const wants=['0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5','0xe19d1c837B8A1C83A56cD9165b2c0256D39653aD'];
 const sources=['0xCA0253A98D16e9C1e3614caFDA19318EE69772D0','0x28Ca243dc0aC075dD012fCf9375C25D18A844d96'];
 const amount=ethers.parseEther('100');
 const hub=bind('BoostHub',hubAddr,signer);
 recordCheck('two pools, two staking instances, four vault/strategies',entries.length===4&&Object.keys(staking).length===2,{entries:entries.map(e=>({pid:e.pid,kind:e.kind,vault:e.vault,strategy:e.strategy}))});
 for(const pid of [0,1]){
   const token=new ethers.Contract(wants[pid],['function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','function approve(address,uint256) returns(bool)'],provider);
   const from=sources[pid];const bal=await token.balanceOf(from);
   recordCheck('source token holder has enough '+pid,bal>=amount*3n,{holder:from,balance:bal.toString()});
   await provider.send('anvil_setBalance',[from,ethers.toQuantity(ethers.parseEther('5'))]);
   await provider.send('anvil_impersonateAccount',[from]);
   await act(`fork-only fund sd token pid=${pid}`,async()=>token.connect(await provider.getSigner(from)).transfer(account,amount*3n));
   await provider.send('anvil_stopImpersonatingAccount',[from]);
 }
 await snapshot('post-deployment-before-deposits',ctx);
 for(const e of entries){
   const want=new ethers.Contract(wants[e.pid],['function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'],signer);
   await act(`approve-${e.kind}-pid${e.pid}`,()=>want.approve(e.vault,amount));
   const v=bind(e.kind==='original'?'BeefyVaultV7FixedV2':'BeefyVaultV7',e.vault,signer);
   await act(`deposit-${e.kind}-pid${e.pid}`,()=>v.deposit(amount,{gasLimit:12000000}));
 }
 const deposits=await snapshot('post-four-deposits',ctx);
 for(const pid of [0,1]){
  const stake=bind('BoostHubStaking',staking[pid],signer);
  await act(`register-external-WETH-reward-pid${pid}`,()=>stake.add_external_reward(WETH));
 }
 const weth=new ethers.Contract(WETH,['function deposit() payable','function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'],signer);
 const rewardAmount=ethers.parseEther('0.2');
 await act('wrap-0.4ETH-into-WETH',()=>weth.deposit({value:rewardAmount*2n}));
 for(const pid of [0,1]){
  await act(`approve-WETH-reward-pid${pid}`,()=>weth.approve(staking[pid],rewardAmount));
  await act(`fund-staking-stream-WETH-pid${pid}`,()=>bind('BoostHubStaking',staking[pid],signer).deposit_reward_token(WETH,rewardAmount));
 }
 await snapshot('post-reward-stream-funding',ctx);
 const priorBlock=await provider.getBlockNumber();
 await provider.send('anvil_mine',['0x1388','0xc']);
 const afterBlock=await provider.getBlockNumber();
 recordCheck('5000-block jump',afterBlock-priorBlock===5000,{priorBlock,afterBlock});
 await act('boosthub-checkpoint-gauges',()=>hub.checkpoint([0,1],{gasLimit:15000000}));
 for(const pid of [0,1]){
   const stake=bind('BoostHubStaking',staking[pid],signer);
   await act(`staking-checkpoint-ramp-pid${pid}`,()=>stake.checkpoint_ramp(16,{gasLimit:12000000}));
   for(const e of entries.filter(z=>z.pid===pid)) await act(`staking-checkpoint-${e.kind}-pid${pid}`,()=>stake.checkpoint(e.strategy,{gasLimit:12000000}));
   await act(`boosthub-harvest-pid${pid}`,()=>hub.harvest(pid,{gasLimit:14000000}));
   await act(`staking-harvest-pid${pid}`,()=>stake.harvest({gasLimit:14000000}));
 }
 await snapshot('after-5000-blocks-and-hub-staking-harvests-before-strategy-harvest',ctx);
 for(const e of entries){
  const strategy=bind(e.kind==='original'?'StrategyConvexBoostHubStakingV5':'StrategyConvexBoostHubPartnerV2',e.strategy,signer);
  if(e.kind==='beefy-partner' && e.pid===0){
     const stake=bind('BoostHubStaking',e.staking),hub=bind('BoostHub',hubAddr);
     const tokens=['0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5','0xD533a949740bb3306d119CC777fa900bA034cd52','0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E','0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'];
     const probe={};for(const token of tokens){
       const erc=new ethers.Contract(token,['function balanceOf(address) view returns(uint256)'],provider);
       const vals={stakingTokenBalance:(await erc.balanceOf(e.staking)).toString(),strategyTokenBalance:(await erc.balanceOf(e.strategy)).toString()};
       try{vals.stakingClaimable=(await stake.claimable_reward(e.strategy,token)).toString();}catch(err){vals.claimError=String(err.shortMessage||err.message).slice(0,160)}
       probe[token]=vals;
     }
     const p=await hub.positionInfo(e.pid,e.staking);probe.hubPending={rewardTokens:p.rewardTokens,pendingRewards:p.pendingRewards.map(x=>x.toString())};
     result.steps.push({label:'pid0-beefy-preharvest-token-probe',ok:true,probe});
  }
  try{await strategy['harvest()'].staticCall({gasLimit:16000000});result.steps.push({label:`harvest-preflight-${e.kind}-pid${e.pid}`,ok:true});}
  catch(err){const data=err?.data||err?.error?.data||err?.info?.error?.data||null;
   let parsed=null;for(const name of ['CurveYieldOmniRouter','StrategyConvexBoostHubPartnerV2','BaseAllToNativeFactoryStrat']){
      try{const p=new ethers.Interface(artifact(name).abi).parseError(data);if(p){parsed={contract:name,error:p.name};break;}}catch(e){}
   }
   result.steps.push({label:`harvest-preflight-${e.kind}-pid${e.pid}`,ok:false,error:String(err?.shortMessage||err?.message||err).slice(0,1500),data,parsed});
  }
  if(e.kind==='beefy-partner' && e.pid===0){
    try{
      const wethClaimable=await bind('BoostHubStaking',e.staking).claimable_reward(e.strategy,WETH);
      const router=bind('CurveYieldOmniRouter',await strategy.swapper());
      const quote=await router.getAmountOut(WETH,wants[0],wethClaimable);
      result.steps.push({label:'pid0-beefy-native-route-historical-quote',ok:true,wethClaimable:wethClaimable.toString(),sdcrvQuote:quote.toString()});
    }catch(err){
      result.steps.push({label:'pid0-beefy-native-route-historical-quote',ok:false,error:String(err?.shortMessage||err?.message||err).slice(0,500),data:err?.data||null});
    }
  }
  await act(`strategy-harvest-${e.kind}-pid${e.pid}`,()=>strategy['harvest()']({gasLimit:16000000}));
 }
 await snapshot('after-strategy-harvests-and-compounding',ctx);
 for(const e of entries){
  const v=bind(e.kind==='original'?'BeefyVaultV7FixedV2':'BeefyVaultV7',e.vault,signer);
  const shares=await v.balanceOf(account);
  if(shares>0n){
    const wantToken=new ethers.Contract(wants[e.pid],['function balanceOf(address) view returns(uint256)'],provider);
    const before=await wantToken.balanceOf(account);
    const rc=await act(`withdraw-50%-shares-${e.kind}-pid${e.pid}`,()=>v.withdraw(shares/2n,{gasLimit:16000000}));
    const after=await wantToken.balanceOf(account);
    result.steps.push({label:`actual-withdrawal-payment-${e.kind}-pid${e.pid}`,ok:!!rc,userUnderlyingDelta:(after-before).toString(),burnedShares:(shares/2n).toString()});
  }
  else recordCheck(`nonzero vault shares for withdraw ${e.kind}-${e.pid}`,false,{shares:shares.toString()});
 }
 const final=await snapshot('post-all-withdrawals',ctx);
 for(const pid of [0,1]){
  const row=final.hubs.find(x=>x.pid===pid);
  const total=BigInt(row.stakingTotal),positions=final.vaults.filter(v=>v.pid===pid).reduce((a,v)=>a+BigInt(v.stakingStakedBalance),0n);
  recordCheck(`staking total equals custom+partner principal pid=${pid}`,total===positions,{total:total.toString(),sumPositions:positions.toString()});
  recordCheck(`Hub position equals staking principal pid=${pid}`,BigInt(row.hubStakingPosition)===total,{hubPosition:row.hubStakingPosition,stakingTotal:row.stakingTotal});
  for(const v of final.vaults.filter(v=>v.pid===pid)){
     recordCheck(`vault minted share accounting ${v.kind} pid=${pid}`,BigInt(v.vaultTotalSupply)===BigInt(v.vaultUserShares),{supply:v.vaultTotalSupply,userShares:v.vaultUserShares});
  }
 }
}
(async()=>{try{await main();}catch(e){const msg=String(e?.stack||e);result.errors.push({stage:'uncaught',error:msg.slice(0,5500)});console.error(msg);}finally{result.completedAt=new Date().toISOString();fs.writeFileSync(output,JSON.stringify(result,null,2));console.log('[v34] post-action evidence: '+output);console.log(JSON.stringify({deployment:result.deployments,steps:result.steps.length,snapshots:result.snapshots.map(x=>x.tag),assertions:result.assertions.length,errors:result.errors},null,2));if(result.errors.length)process.exitCode=1;}})();
JS
  echo '[v34] Running fork-only staking, checkpoint, fee, harvest and withdrawal campaign'
  timeout -s TERM -k 10s 1200s node "$RUNNER_TEMP/boosthub-v34-js/post_action_v1.cjs" \
    2>&1 | tee boosthub-v34-post-actions-v1.log
  exit "${PIPESTATUS[0]}"
fi
ROOT="$GITHUB_WORKSPACE/.boosthub-v13-full"
ETH_RPC="${RPC_ETHEREUM:?Missing configured RPC_ETHEREUM secret}"
FRA_RPC="${RPC_FRAXTAL:-https://rpc.frax.com}"
test "$(timeout 25s cast chain-id --rpc-url "$ETH_RPC")" = 1
test "$(timeout 25s cast chain-id --rpc-url "$FRA_RPC")" = 252
anvil --fork-url "$ETH_RPC" --chain-id 1 --block-time 1 --port 8545 > boosthub-v13-anvil-ethereum-v1.log 2>&1 &
echo $! > .boosthub-ethereum.pid
anvil --fork-url "$FRA_RPC" --chain-id 252 --block-time 1 --port 8546 > boosthub-v13-anvil-fraxtal-v1.log 2>&1 &
echo $! > .boosthub-fraxtal.pid
for i in $(seq 1 45); do
  eth="$(timeout 5s cast chain-id --rpc-url http://127.0.0.1:8545 2>/dev/null || true)"
  fra="$(timeout 5s cast chain-id --rpc-url http://127.0.0.1:8546 2>/dev/null || true)"
  if [ "$eth" = 1 ] && [ "$fra" = 252 ]; then break; fi
  sleep 2
done
test "${eth:-}" = 1
test "${fra:-}" = 252
echo "[full-v11] Both forks are ready; entering deployment"
# Only the temporary publicly documented Anvil development account is used.
export ANVIL_TEST_KEY="$(sed -n '/Private Keys/,$p' boosthub-v13-anvil-ethereum-v1.log | grep -Eo '0x[0-9a-fA-F]{64}' | head -n1)"
test -n "$ANVIL_TEST_KEY"
export ANVIL_TEST_ADDRESS="$(cast wallet address --private-key "$ANVIL_TEST_KEY")"
python3 - <<'PY'
import pathlib,json,os
root=pathlib.Path('.boosthub-v13-full')
config=json.loads((root/'deployment/deployment_config_v10.json').read_text())
signer=os.environ['ANVIL_TEST_ADDRESS']
config['deployer']=signer
for chain in config['chains'].values():
    chain['owner']=signer
    chain['converter']['owner']=signer
    chain['maxFeePerGasGwei']='200'
    chain['priorityFeePerGasGwei']='0.05'
    for p in chain['pools']: p['stakingAdmin']=signer
out=root/'simulation-v1/fork_only_config_v1.json'
out.parent.mkdir(parents=True,exist_ok=True)
out.write_text(json.dumps(config,indent=2)+'\n')
print('Fork-only deployer/admin substitutions:',signer,'all pool economic settings unchanged')
PY
export BOOSTHUB_EXECUTE=0
# Exact production runner module invoked directly with ephemeral fork-only signer.
cat > .boosthub-v13-run-v1.mjs <<'EOF'
import {main} from './.boosthub-v13-full/deployment/deploy_runner_v10.mjs';
import path from 'node:path';
const root=path.resolve('.boosthub-v13-full');
await main({
  mode: process.env.V11_MODE || 'Deploy',
  chain: 'Both', packageRoot:root,
  configPath:path.join(root,'simulation-v1/fork_only_config_v1.json'),
  stateDirectory:path.join(root,'simulation-v1/state'),
  privateKey:process.env.ANVIL_TEST_KEY,
  deployerAddress:process.env.ANVIL_TEST_ADDRESS,
  rpcUrls:{ethereum:'http://127.0.0.1:8545',fraxtal:'http://127.0.0.1:8546'}
});
EOF
set +e
timeout -s TERM -k 10s 720s node .boosthub-v13-run-v1.mjs 2>&1 | tee boosthub-v13-full-deploy-v1.log
status=${PIPESTATUS[0]}
set -e
if [ "$status" -ne 0 ] && grep -q 'Fee timelock is still active' boosthub-v13-full-deploy-v1.log; then
  echo 'Advancing fork clocks 10 days to pass the existing timelock (fork only)'
  for port in 8545 8546; do
    cast rpc anvil_increaseTime 864000 --rpc-url "http://127.0.0.1:$port" >/dev/null
    cast rpc anvil_mine 1 --rpc-url "http://127.0.0.1:$port" >/dev/null
  done
  timeout -s TERM -k 10s 720s node .boosthub-v13-run-v1.mjs 2>&1 | tee -a boosthub-v13-full-deploy-v1.log
else
  test "$status" -eq 0
fi
python3 github-native-sim/boosthub-v13-full-stack-v1/summarize_v1.py "$ROOT"
