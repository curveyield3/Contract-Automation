// cyvlSDT vault PPS mainnet-fork experiment v3
// REAL deployed mainnet contracts on isolated Anvil fork. No mock vault.
// Since live cyvlSDT and vault supplies are zero, mint fork-only cyvlSDT
// through impersonation of the actual authorized locker; this isolates
// share-price and redemption accounting, not SDT collateral backing.
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
const RPC=process.env.LOCAL_FORK_RPC||'http://127.0.0.1:8545';
const A={token:'0x4B4aA34e805d87458a64d8d745cF7B18e24AeACe',locker:'0x4DC535b6aD9eb381A91e472aa3f24F1FDC6Cb21b',vault:'0x65847aD0eeF247D212c815aF5f80477a57Fb0AB9',strategy:'0x09139f04227a4E413869aBC2Ef1E31D9A82606fd',staking:'0x98d2e6a894ebf04B4009543aa6cCEb6417404E6F'};
const p=new ethers.JsonRpcProvider(RPC,1,{staticNetwork:true});
const token=new ethers.Contract(A.token,['function locker() view returns(address)','function mint(address,uint256)','function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)'],p);
const vault=new ethers.Contract(A.vault,['function want() view returns(address)','function strategy() view returns(address)','function feeReceiver() view returns(address)','function deposit(uint256) returns(uint256)','function withdraw(uint256) returns(uint256)','function withdrawWithOptions(uint256,bool,bool) returns(uint256)','function getPricePerFullShare() view returns(uint256)','function getRealizedPricePerFullShare() view returns(uint256)','function totalSupply() view returns(uint256)','function balance() view returns(uint256)','function economicBalance() view returns(uint256)','function balanceOf(address) view returns(uint256)'],p);
const strategy=new ethers.Contract(A.strategy,['function withdrawalFeeBps() view returns(uint16)','function balanceOf() view returns(uint256)'],p);
const staking=new ethers.Contract(A.staking,['function immediateWithdrawFeePpm() view returns(uint32)'],p);
const stringify=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const f18=x=>ethers.formatUnits(x,18);
const signed=x=>(x<0n?'-':'')+ethers.formatUnits(x<0n?-x:x,18);
const addrEq=(a,b,label)=>assert.equal(a.toLowerCase(),b.toLowerCase(),label);
async function transact(promise,label){try{const tx=await promise;const rc=await tx.wait();assert.equal(rc.status,1,label+' receipt reverted');return rc}catch(e){throw new Error(label+': '+(e.shortMessage||e.reason||e.message),{cause:e})}}
async function fund(a){await p.send('anvil_setBalance',[a,ethers.toBeHex(ethers.parseEther('30'))])}
async function point(seeder,tester,fee){
 const [pps,realized,totalShares,assets,economicAssets,seederShares,testerShares,testerTokens,feeTokens,strategyAssets]=await Promise.all([vault.getPricePerFullShare(),vault.getRealizedPricePerFullShare(),vault.totalSupply(),vault.balance(),vault.economicBalance(),vault.balanceOf(seeder.address),vault.balanceOf(tester.address),token.balanceOf(tester.address),token.balanceOf(fee),strategy.balanceOf()]);
 return {pps,realized,totalShares,assets,economicAssets,seederShares,testerShares,testerTokens,feeTokens,strategyAssets};
}
function delta(a,b){const d=a-b;return {raw:d.toString(),amount:signed(d),direction:d<0n?'DOWN':d>0n?'UP':'UNCHANGED',relativePpm:b?String(d*1000000n/b):null}}
async function main(){
 const net=await p.getNetwork();assert.equal(net.chainId,1n,'Require mainnet chainId');
 const block=await p.getBlock('latest');assert(block&&block.number>20000000,'Require recent real fork state');
 for(const [n,a] of Object.entries(A))assert((await p.getCode(a)).length>2,'No deployed code at '+n);
 addrEq(await token.locker(),A.locker,'Actual mint authority');
 addrEq(await vault.want(),A.token,'Actual want');
 addrEq(await vault.strategy(),A.strategy,'Actual strategy');
 const liveTokenSupply=await token.totalSupply(),liveVaultShares=await vault.totalSupply();
 const strategyFeeBps=await strategy.withdrawalFeeBps(),stakingFeePpm=await staking.immediateWithdrawFeePpm();
 const fee=await vault.feeReceiver();
 const seeder=ethers.Wallet.createRandom().connect(p),tester=ethers.Wallet.createRandom().connect(p);
 await fund(seeder.address);await fund(tester.address);await fund(A.locker);
 await p.send('anvil_impersonateAccount',[A.locker]);
 const signer=await p.getSigner(A.locker),seedAmount=ethers.parseEther('1000'),depositAmount=ethers.parseEther('100');
 await transact(token.connect(signer).mint(seeder.address,seedAmount,{gasLimit:1500000}),'Seed user from real locker on fork');
 await transact(token.connect(signer).mint(tester.address,depositAmount*2n,{gasLimit:1500000}),'Fund test user from real locker on fork');
 await transact(token.connect(seeder).approve(A.vault,seedAmount,{gasLimit:1500000}),'Approve seeder');
 await transact(token.connect(tester).approve(A.vault,depositAmount*2n,{gasLimit:1500000}),'Approve tester');
 await transact(vault.connect(seeder).deposit(seedAmount,{gasLimit:9500000}),'Seed live vault');
 const seeded=await point(seeder,tester,fee);assert(seeded.seederShares>0n,'Seeded position missing');
 const run=async(method)=>{
   const before=await point(seeder,tester,fee);
   await transact(vault.connect(tester).deposit(depositAmount,{gasLimit:9500000}),'Second user deposit');
   const deposited=await point(seeder,tester,fee),shares=deposited.testerShares;
   assert(shares>0n,'No new vault shares minted');
   if(method==='withdraw(uint256)')await transact(vault.connect(tester).withdraw(shares,{gasLimit:9500000}),'Standard instant withdrawal');
   else await transact(vault.connect(tester).withdrawWithOptions(shares,false,false,{gasLimit:9500000}),'Explicit instant withdrawal');
   const withdrawn=await point(seeder,tester,fee);
   assert.equal(withdrawn.testerShares,0n,'Withdrawing user still owns shares');
   assert(withdrawn.seederShares>0n,'Independent original shareholder disappeared');
   const returnedTokens=withdrawn.testerTokens-deposited.testerTokens;
   return {method,before,deposited,withdrawn,ppsChangeDeposit:delta(deposited.pps,before.pps),ppsChangeWithdrawal:delta(withdrawn.pps,deposited.pps),ppsChangeRoundtrip:delta(withdrawn.pps,before.pps),realizedPpsChangeRoundtrip:delta(withdrawn.realized,before.realized),testUserNetReceived:f18(returnedTokens),withdrawnUserTotalLoss:f18(depositAmount-returnedTokens),feeReceiverDelta:f18(withdrawn.feeTokens-before.feeTokens)};
 };
 console.log('FORK_STAGE_V3=seeded_vault_ready');
 const normal=await run('withdraw(uint256)');
 console.log('FORK_STAGE_V3=standard_instant_withdraw_complete');
 // Execute the second route sequentially without evm_revert: avoids stale wallet nonces.
 // A separate seeded shareholder remains in place for both rounds.
 const explicit=await run('withdrawWithOptions(uint256,false,false)');
 console.log('FORK_STAGE_V3=explicit_instant_withdraw_complete');
 const out={version:'v3',forkBlock:block.number,forkHash:block.hash,addresses:A,initialSupply:{cyvlSDT:liveTokenSupply,vaultShares:liveVaultShares},setup:{mode:'Actual deployed contracts, fork-only authorized locker mint',seederDeposit:f18(seedAmount),userDeposit:f18(depositAmount),seededPps:seeded.pps},fees:{strategyWithdrawalBps:strategyFeeBps,stakingImmediatePpm:stakingFeePpm,feeReceiver:fee},scenarios:[normal,explicit],result:{ppsDropsAfterStandardWithdrawal:normal.withdrawn.pps<normal.deposited.pps,ppsDropsAfterExplicitWithdrawal:explicit.withdrawn.pps<explicit.deposited.pps,ppsDropsAcrossStandardRoundtrip:normal.withdrawn.pps<normal.before.pps,ppsDropsAcrossExplicitRoundtrip:explicit.withdrawn.pps<explicit.before.pps},limits:'Empty live vault; actual mainnet contracts run on isolated fork with token balances seeded through true authorized locker impersonation. Does not simulate SDT backing or future yield.'};
 await new Promise(resolve=>process.stdout.write('FORK_PPS_RESULT_V3='+stringify(out)+'\n',resolve));
}
main().then(()=>{p.destroy();process.exit(0)}).catch(e=>{console.error('FORK_PPS_ERROR_V3='+stringify({message:e.message,cause:e.cause?.shortMessage||e.cause?.message||null}));p.destroy();process.exit(1)});
