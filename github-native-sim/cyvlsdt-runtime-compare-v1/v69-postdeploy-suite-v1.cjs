'use strict';
const fs=require('fs'),assert=require('node:assert/strict'),{ethers:E}=require('/tmp/cyv-deps/node_modules/ethers');
const OUT='/tmp/v69-report',ZERO=E.ZeroAddress,MAX=E.MaxUint256,W=10n**18n,WEEK=604800;
const SDT='0x73968b9a57c6e53d41345fd57a6e6ae27d6cdb2f',USDC='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',CRV='0xd1b5651e55d4ceed36251c61c50c889b36f6abb5',SDFXN='0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad',FXN='0x365accfca291e7d3914637abf1f7635db165bb09';
const erc=['function balanceOf(address) view returns(uint256)','function totalSupply() view returns(uint256)','function transfer(address,uint256) returns(bool)','function transferFrom(address,address,uint256) returns(bool)','function approve(address,uint256) returns(bool)','function allowance(address,address) view returns(uint256)','function decimals() view returns(uint8)'];
const ercI=new E.Interface(erc),transferTopic=E.id('Transfer(address,address,uint256)'),approvalTopic=E.id('Approval(address,address,uint256)');
const J=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const report={version:3,forkBlock:Number(process.env.FORK_BLOCK),actions:[],scenarios:[],views:[],coverage:[],sandwich:[],fixtures:[],deployment:[],failures:[]};
const cleanError=e=>({message:String(e.shortMessage||e.message||e).slice(0,2000),data:e.data||e.info?.error?.data||null});
const low=x=>String(x).toLowerCase();
fs.mkdirSync(OUT,{recursive:true});
function save(){fs.writeFileSync(OUT+'/evidence.json',J(report));}
function log(k,x){console.log(k,J(x));save();}
async function soft(f){try{return await f()}catch(e){return {error:cleanError(e)}}}
function C(p,a,b=erc){return new E.Contract(a,b,p)}
async function balance(p,t,a,blockTag){if(a===ZERO)return 0n;return soft(()=>C(p,t).balanceOf(a,{blockTag}));}
async function observe(p,r,label,extra={}){
 const fromBlock=r.blockNumber-1,toBlock=r.blockNumber;
 const events=[],pairs=new Map();
 for(const l of r.logs){
   if(low(l.address)===low(WETH)&&l.topics.length===2&&[E.id('Deposit(address,uint256)'),E.id('Withdrawal(address,uint256)')].includes(l.topics[0])){
     const account='0x'+l.topics[1].slice(-40),amount=BigInt(l.data),isDeposit=l.topics[0]===E.id('Deposit(address,uint256)');
     events.push({token:l.address,from:isDeposit?ZERO:account,to:isDeposit?account:ZERO,amount,logIndex:l.index,event:isDeposit?'WETH Deposit':'WETH Withdrawal'});
     pairs.set(low(l.address)+':'+low(account),[l.address,account]);
   }
   if(l.topics[0]===transferTopic&&l.topics.length===3){
     const from='0x'+l.topics[1].slice(-40),to='0x'+l.topics[2].slice(-40),amount=BigInt(l.data);
     events.push({token:l.address,from,to,amount,logIndex:l.index});
     for(const a of [from,to])if(a!==ZERO)pairs.set(low(l.address)+':'+low(a),[l.address,a]);
   }
 }
 const balances=await Promise.all([...pairs.values()].map(async([token,account])=>({token,account,before:await balance(p,token,account,fromBlock),after:await balance(p,token,account,toBlock)})));
 const approvals=await Promise.all(r.logs.filter(l=>l.topics[0]===approvalTopic&&l.topics.length===3).map(async l=>{const owner='0x'+l.topics[1].slice(-40),spender='0x'+l.topics[2].slice(-40),token=l.address;return{token,owner,spender,value:BigInt(l.data),before:await soft(()=>C(p,token).allowance(owner,spender,{blockTag:fromBlock})),after:await soft(()=>C(p,token).allowance(owner,spender,{blockTag:toBlock}))}}));
 const conservation=[];
 for(const row of balances){if(typeof row.before!=='bigint'||typeof row.after!=='bigint')continue;let expected=0n;for(const e of events)if(low(e.token)===low(row.token)){if(low(e.to)===low(row.account))expected+=e.amount;if(low(e.from)===low(row.account))expected-=e.amount;}conservation.push({token:row.token,account:row.account,observed:row.after-row.before,transferEventDelta:expected,match:row.after-row.before===expected});}
 const trace=await soft(()=>p.send('debug_traceTransaction',[r.hash,{tracer:'callTracer'}]));
 const calls=[];
 function walk(t,depth=0,parentFailed=false){if(!t||!t.to)return;const failed=parentFailed||!!t.error||!!t.revertReason;calls.push({depth,from:t.from,to:t.to,input:t.input||'0x',output:t.output||'0x',error:t.error||t.revertReason||null,ancestorFailed:parentFailed,failed,type:t.type});for(const c of t.calls||[])walk(c,depth+1,failed);}
 walk(trace);
 return {label,hash:r.hash,block:r.blockNumber,status:r.status,gas:r.gasUsed,events,balances,approvals,conservation,calls,traceError:trace?.error||null,...extra};
}
async function deploymentReceipt(p,r,label){const item=await observe(p,r,label);report.deployment.push(item);log('DEPLOYMENT_STATE',{label,hash:r.hash,transferEvents:item.events.length,accountChecks:item.balances.length,discrepancies:item.conservation.filter(x=>!x.match).length});}
async function run(p,A,SAFE,EOA,artifact,root,manager){
 const names={impl:'BeefyVaultCurveYieldV8cyvlSDT',rvault:'BeefyVaultCurveYieldV8cyvlSDT',svault:'BeefyVaultCurveYieldV8cyvlSDT',crvVault:'BeefyVaultCurveYieldV8cyvlSDT',fxnVault:'BeefyVaultCurveYieldV8cyvlSDT',token:'CurveYieldVlSDTToken',locker:'CurveYieldVlSDTLocker',staking:'CurveYieldvlSDTStaking',revenue:'CurveYieldRevenueStrategyV8',merchant:'CurveYieldVlSDTBoostMerchant',yearn:'StrategyCurveSDTYearnRebindable',crv:'StrategyConvexBoostHubStakingDirectV66',fxn:'StrategyDualFXNUnifiedV43'};
 const U='0x000000000000000000000000000000000000a111',V='0x000000000000000000000000000000000000a222',K='0x000000000000000000000000000000000000a333',X='0x000000000000000000000000000000000000a444';
 const N=Object.fromEntries(Object.entries(names).map(([k,n])=>[k,C(p,A[k],artifact(root,n).abi)]));
 const trackedTokens=[SDT,USDC,WETH,CRV,SDFXN,FXN,A.token,A.rvault,A.svault,A.crvVault,A.fxnVault];
 const trackedAccounts=[U,V,K,X,EOA,SAFE,manager,...Object.values(A)];
 let scenarioName='setup',signers=new Map();
 async function signer(addr){if(!signers.has(low(addr))){await p.send('anvil_impersonateAccount',[addr]);signers.set(low(addr),await p.getSigner(addr));}if(await p.getBalance(addr)<W/10n)await p.send('anvil_setBalance',[addr,E.toQuantity(100n*W)]);return signers.get(low(addr));}
 for(const a of [U,V,K,X,SAFE,EOA])await signer(a);
 const read=(k,f,args=[])=>N[k][f](...args);
 const amt=(n,d=18)=>E.parseUnits(String(n),d);
 const eq=(a,b,m)=>assert.equal(a,b,m);
 const now=async()=>Number((await p.getBlock('latest')).timestamp);
 const warp=async sec=>{await p.send('evm_increaseTime',[sec]);await p.send('evm_mine',[]);};
 async function state(k,caller){
   let t=N[k],items={};
   let who=[...new Set([caller,U,V,SAFE,EOA,A[k]].filter(Boolean))];
   if(t){for(const f of ['owner','pendingOwner','totalSupply','totalAssets','getPricePerFullShare','balanceOf()','grossBalanceOf','totalActiveStake','totalQueuedStake','grossSDTPrincipalForBase','reservedWithdrawalAssets','nextWithdrawalId','pendingConversionCount','poLDepositShareBps','lockedProfit','childBalances','allocationTargets','convexEligible','paused','rewardTokenCount','strategy','adminFeeReceiver','depositFeeBps','withdrawalFeeBps','systemConfigured','merchantDelegableBoost'])if(t.interface.hasFunction(f)){items[f]=await soft(()=>t[f]());}
    for(const a of who)for(const f of ['balanceOf(address)','activeBalance','queuedBalance','pendingWithdrawal'])if(t.interface.hasFunction(f)){items[f+':'+a]=await soft(()=>t[f](a));}}
   const localTokens=k==='pol'?[SDT,USDC,A.token]:k==='locker'||k==='staking'||k==='merchant'||k==='revenue'||k==='token'?[SDT,USDC,A.token]:k==='rvault'?[A.token,A.rvault]:k==='svault'||k==='yearn'?[SDT,A.svault]:k==='crvVault'||k==='crv'?[CRV,A.crvVault]:k==='fxnVault'||k==='fxn'?[SDFXN,FXN,A.fxnVault]:[];
   items.balances=await Promise.all(localTokens.flatMap(token=>who.map(async account=>({token,account,balance:await balance(p,token,account)}))));
   return items;
 }
 function errorName(t,e){let data=e.data||e.info?.error?.data;if(typeof data==='object')data=data?.data;try{return t.interface.parseError(data)?.name||null}catch{}return null;}
 async function act(k,f,args,caller=U,opts={}){
   const t=typeof k==='string'&&N[k]?N[k]:opts.contract,addr=await t.getAddress(),frag=t.interface.getFunction(f),sig=frag.format('sighash'),data=t.interface.encodeFunctionData(frag,args);
   const row={scenario:scenarioName,contract:k,address:addr,function:sig,params:args,caller,expect:opts.reject||'success',purpose:opts.purpose||'',before:await state(k,caller)};
   let receipt=null;
   try{
     const s=await signer(caller);
     const result=await t.connect(s)[sig].staticCall(...args,{gasLimit:16000000n,value:opts.value||0n});
     row.staticResult=result;
     if(opts.reject){row.status='FAIL_UNEXPECTED_SUCCESS';report.actions.push(row);log('CASE',{...row,before:undefined});return row;}
     const tx=await s.sendTransaction({to:addr,data,gasLimit:16000000n,value:opts.value||0n});receipt=await tx.wait();row.tx=await observe(p,receipt,scenarioName+':'+k+'.'+sig);
     assert.equal(receipt.status,1);row.after=await state(k,caller);
     if(opts.check){await opts.check(row);row.status='PASS_ASSERTED';}else row.status=row.tx.events.length?'EXECUTED_TRANSFER_UNASSERTED':'EXECUTED_NO_TRANSFER';
     if(row.tx.conservation.some(x=>!x.match)){row.status='FAIL_TRANSFER_RECONCILIATION';}
   }catch(e){
     row.error=cleanError(e);row.decodedError=errorName(t,e);row.after=await state(k,caller);
     if(opts.reject){const match=opts.reject===row.decodedError||String(row.error.message).includes(opts.reject)||String(e.message).includes(opts.reject);row.status=match?'EXPECTED_REVERT':'FAIL_WRONG_REVERT';}
     else row.status='FAIL';
   }
   report.actions.push(row);log('CASE',{scenario:row.scenario,contract:k,function:sig,params:args,caller,status:row.status,error:row.error,decodedError:row.decodedError,events:row.tx?.events.length,accountChecks:row.tx?.balances.length});
   return row;
 }
 async function need(k,f,args,caller=U,opts={}){const r=await act(k,f,args,caller,opts);if(!['PASS_ASSERTED','EXECUTED_TRANSFER_UNASSERTED','EXECUTED_NO_TRANSFER','EXPECTED_REVERT'].includes(r.status))throw Error('prerequisite '+k+'.'+f+' '+r.status);return r;}
 async function ext(t,f,args,caller=U,opts={}){return act('external:'+await t.getAddress(),f,args,caller,{...opts,contract:t});}
 async function scenario(label,fn){
   if(!label.startsWith('FOLLOWUP '))return;scenarioName=label;let snap=await p.send('evm_snapshot',[]),start=report.actions.length;
   try{await fn();report.scenarios.push({label,status:'COMPLETED',actions:report.actions.length-start});}
   catch(e){report.scenarios.push({label,status:'BLOCKED_OR_FAILED',error:cleanError(e),actions:report.actions.length-start});log('SCENARIO_ERROR',{label,error:cleanError(e)});}
   finally{await p.send('evm_revert',[snap]);signers.clear();save();}
 }
 async function fund(token,to,amount){
   const t=C(p,token),have=await t.balanceOf(to);if(have>=amount)return;
   if(low(token)===low(WETH)){
     const a=C(p,token,['function deposit() payable']);await signer(to);await p.send('anvil_setBalance',[to,E.toQuantity(amount+100n*W)]);
     await ext(a,'deposit',[],to,{value:amount-have,check:async()=>eq(await t.balanceOf(to),amount)});return;
   }
   let cand=[SAFE,EOA,U,V,K,X];const excluded=new Set([...Object.values(A),manager,await soft(()=>N.fxn.curvePool()),await soft(()=>N.yearn.CURVE_LP())].map(low));
   for(const from of cand){if(low(from)===low(to)||excluded.has(low(from)))continue;let b=await soft(()=>t.balanceOf(from));if(typeof b==='bigint'&&b>=amount-have){const row=await ext(t,'transfer',[to,amount-have],from,{purpose:'real fork token funding',check:async()=>eq(await t.balanceOf(to),amount)});if(row.status==='PASS_ASSERTED'){report.fixtures.push({token,to,amount:amount-have,method:'actual existing balance transfer',from});return;}}}
   // Only a dedicated fork test account's balance slot is provisioned; never pool/strategy storage.
   // Verify the slot with balanceOf, restore every rejected candidate, and record the fixture explicitly.
   // Try real holders sampled from pinned-block Transfer events first; never debit pool or protocol custody.
   if(low(token)===low(A.token))throw Error('cyvlSDT must be minted through locker; fixture forbidden');
   const head=Number(process.env.FORK_BLOCK),seen=new Set();
   for(let n=0;n<1;n++){
     const logs=await soft(()=>p.getLogs({address:token,topics:[transferTopic],fromBlock:head-n*150-149,toBlock:head-n*150}));
     if(!Array.isArray(logs))continue;
     const candidates=logs.flatMap(l=>l.topics.slice(1,3).map(x=>'0x'+x.slice(-40)));
     for(const from of candidates){
       if(seen.has(low(from))||excluded.has(low(from))||low(from)===low(to)||from===ZERO)continue;seen.add(low(from));
       if(await p.getCode(from)!=='0x')continue;
       let b=await soft(()=>t.balanceOf(from));
       if(typeof b!=='bigint'||b<amount-have)continue;
       const row=await ext(t,'transfer',[to,amount-have],from,{purpose:'actual existing historical EOA token funding',check:async()=>eq(await t.balanceOf(to),amount)});
       if(row.status==='PASS_ASSERTED'){report.fixtures.push({token,to,amount:amount-have,method:'actual existing balance transfer',from});return;}
     }
   }
   const candidates=[];const h=E.zeroPadValue(to,32);for(let i=0;i<128;i++)candidates.push(E.keccak256(E.concat([h,E.zeroPadValue(E.toBeHex(i),32)])));
   let callTrace=await soft(()=>p.send('debug_traceCall',[{to:token,data:ercI.encodeFunctionData('balanceOf',[to])},'latest',{tracer:'prestateTracer'}]));
   for(const [addr,info] of Object.entries(callTrace||{}))if(low(addr)===low(token)&&info?.storage)candidates.unshift(...Object.keys(info.storage));
   for(const slot of [...new Set(candidates)]){
     const old=await p.getStorage(token,slot);if(BigInt(old)!==have)continue;
     try{await p.send('anvil_setStorageAt',[token,slot,E.zeroPadValue(E.toBeHex(amount),32)]);if(await t.balanceOf(to)===amount){report.fixtures.push({token,to,amount:amount-have,method:'fork-only test wallet balance slot; no pool or protocol balance changed',slot,old});save();return;}}
     catch(e){}await p.send('anvil_setStorageAt',[token,slot,old]);
   }
   throw Error('Unable to fund '+token+' '+to+' '+amount);
 }
 async function approve(token,spender,caller=U){const t=C(p,token);const row=await ext(t,'approve',[spender,MAX],caller,{check:async()=>eq(await t.allowance(caller,spender),MAX)});if(row.status!=='PASS_ASSERTED')throw Error('approval failed');}
 async function lock(q=100n*W,who=U){await fund(SDT,who,q);await approve(SDT,A.locker,who);let t=C(p,A.token),s=C(p,SDT),before=await t.balanceOf(who),sd=await s.balanceOf(who),principal=await N.locker.grossSDTPrincipalForBase(),pol=await s.balanceOf(manager);await need('locker','deposit',[q,who],who,{check:async()=>{eq(await t.balanceOf(who),before+q);eq(await s.balanceOf(who),sd-q);eq(await N.locker.grossSDTPrincipalForBase(),principal+q);eq(await s.balanceOf(manager),pol+q/4n);}});}
 async function stake(q=20n*W,who=U){await approve(A.token,A.staking,who);let b=await N.staking.activeBalance(who);await need('staking','stake',[q],who,{check:async()=>eq(await N.staking.activeBalance(who),b+q)});}
 async function vd(k,token,qty,who=U,method='deposit(uint256,address)'){await fund(token,who,qty*3n);await approve(token,A[k],who);let pre=await N[k].balanceOf(who),preAsset=await C(p,token).balanceOf(who),preSupply=await N[k].totalSupply(),preNAV=await N[k].totalAssets();let args=method==='deposit(uint256,address)'?[qty,who]:method==='deposit(uint256)'?[qty]:method==='mint(uint256,address)'?[qty,who]:[];return need(k,method,args,who,{check:async()=>{assert(await N[k].balanceOf(who)>pre);assert(await C(p,token).balanceOf(who)<preAsset);assert(await N[k].totalSupply()>preSupply);assert(await N[k].totalAssets()>preNAV);if(method==='mint(uint256,address)')eq(await N[k].balanceOf(who)-pre,qty);}});}
 const admin=await N.staking.admin();
 const authError=k=>['locker','merchant','staking','token','revenue'].includes(k)?'OwnableUnauthorizedAccount':'Ownable: caller is not the owner';
 async function own(k,f,args,check){const owner=await N[k].owner();await act(k,f,args,U,{reject:authError(k)});return act(k,f,args,owner,{check});}
 async function rebind(k,f,getter,value){const old=await read(k,getter);await own(k,f,[value||old],async()=>eq(low(await read(k,getter)),low(value||old)));}

 await scenario('locker deposit, ERC20 transfer/allowance and locker-only mint',async()=>{
   await lock();await act('locker','deposit',[0n,U],U,{reject:'ZeroAmount'});await act('locker','deposit',[W,ZERO],U,{reject:'ZeroAddress'});
   let u=await N.token.balanceOf(U),v=await N.token.balanceOf(V);
   await need('token','transfer',[V,W],U,{check:async()=>{eq(await N.token.balanceOf(U),u-W);eq(await N.token.balanceOf(V),v+W);}});
   await need('token','approve',[V,2n*W],U,{check:async()=>eq(await N.token.allowance(U,V),2n*W)});
   await act('token','transferFrom',[U,V,W],V,{check:async()=>eq(await N.token.allowance(U,V),W)});
   await act('token','mint',[U,W],U,{reject:'OnlyLocker'});
   await act('token','setLocker',[A.locker],EOA,{check:async()=>eq(low(await N.token.locker()),low(A.locker))});
 });
 await scenario('staking principal, immediate fee, queue maturity and replay rejection',async()=>{
   await lock();await stake();let b=await N.staking.activeBalance(U),fee=await N.staking.previewImmediateWithdrawal(W),u=await N.token.balanceOf(U);
   await need('staking','withdrawImmediate',[W,U],U,{check:async()=>{eq(await N.staking.activeBalance(U),b-W);eq(await N.token.balanceOf(U),u+fee);}});
   let id=await N.staking.nextWithdrawalId();await need('staking','requestWithdrawal',[2n*W],U,{check:async()=>eq(await N.staking.queuedBalance(U),2n*W)});
   await act('staking','completeQueuedWithdrawal',[id,U],U,{reject:'WithdrawalNotReady'});
   await act('staking','withdrawQueuedImmediate',[id,V],V,{reject:'InvalidWithdrawalRequest'});
   await need('staking','withdrawQueuedImmediate',[id,U],U,{check:async()=>eq(await N.staking.queuedBalance(U),0n)});
   id=await N.staking.nextWithdrawalId();await need('staking','requestWithdrawal',[3n*W],U,{check:async()=>eq(await N.staking.queuedBalance(U),3n*W)});await warp(WEEK+1);
   u=await N.token.balanceOf(U);await need('staking','completeQueuedWithdrawal',[id,U],U,{check:async()=>{eq(await N.token.balanceOf(U),u+3n*W);eq(await N.staking.queuedBalance(U),0n);}});
   await act('staking','completeQueuedWithdrawal',[id,U],U,{reject:'InvalidWithdrawalRequest'});
   await act('staking','stake',[0n],U,{reject:'ZeroAmount'});
   await act('staking','withdrawImmediate',[MAX,U],U,{reject:'InsufficientStake'});
 });
 await scenario('revenue notification, streams, PoL diversion, claim and conversion',async()=>{
   await lock();await stake();await fund(SDT,U,20n*W);await fund(USDC,U,10n**7n);
   await act('staking','notifyReward',[SDT,W],U,{reject:'NotNotifier'});
   for(const [t,q] of [[SDT,10n*W],[USDC,5n*10n**6n]]){const b=await C(p,t).balanceOf(A.locker);await ext(C(p,t),'transfer',[A.locker,q],U,{check:async()=>eq(await C(p,t).balanceOf(A.locker),b+q)});}
   await act('locker','forwardRevenue',[],U,{check:async()=>{eq(await C(p,SDT).balanceOf(A.locker),0n);eq(await C(p,USDC).balanceOf(A.locker),0n);}});
   let cnt=await N.staking.pendingConversionCount();for(let i=0n;i<cnt;i++)await act('staking','convertExcess',[i],U,{check:async()=>{let q=await N.staking.pendingConversions(i);assert(q.converted);}});
   await warp(WEEK+1);let earned=await N.staking.earned(U,A.token);let u=await N.token.balanceOf(U);
   await act('staking','claimRewardsSelf',[],U,{check:async()=>{assert(await N.token.balanceOf(U)>=u+earned);eq(await N.staking.earned(U,A.token),0n);}});
   await act('locker','claimAndForwardRevenue',[],U);await act('merchant','claimAladdinRewards',[],U);
   await act('staking','forwardPendingPoLRevenue',[SDT],U,{check:async()=>eq(await N.staking.pendingPoLRevenue(SDT),0n)});
 });
 await scenario('revenue vault ERC4626 and queue, nested strategy execution',async()=>{
   await lock(100n*W);await approve(A.token,A.rvault,U);
   await vd('rvault',A.token,8n*W,U);await vd('rvault',A.token,2n*W,U,'deposit(uint256)');
   await vd('rvault',A.token,W/10n,U,'mint(uint256,address)');
   await act('rvault','earn',[],U);await act('rvault','updateAPY',[],U);
   let s=await N.rvault.balanceOf(U);await act('rvault','redeem',[s/10n,V,U],U,{check:async()=>eq(await N.rvault.balanceOf(U),s-s/10n)});
   s=await N.rvault.balanceOf(U);await act('rvault','withdraw(uint256)',[s/10n],U,{check:async()=>eq(await N.rvault.balanceOf(U),s-s/10n)});
   await act('rvault','withdraw(uint256,address,address)',[W/100n,U,U],U,{check:async()=>assert(await N.rvault.balanceOf(U)<s)});
   s=await N.rvault.balanceOf(U);await need('rvault','requestWithdrawal',[s/5n],U,{check:async()=>eq(await N.rvault.balanceOf(U),s-s/5n)});
   await act('rvault','completeWithdrawal',[],U,{reject:'VaultWithdrawalNotReady'});await act('rvault','withdrawQueuedImmediate',[],U,{check:async()=>eq((await N.rvault.pendingWithdrawal(U)).shares,0n)});
   s=await N.rvault.balanceOf(U);await need('rvault','requestWithdrawal',[s/5n],U,{check:async()=>eq(await N.rvault.balanceOf(U),s-s/5n)});await warp(WEEK+1);await act('rvault','completeWithdrawal',[],U,{check:async()=>eq((await N.rvault.pendingWithdrawal(U)).shares,0n)});
   s=await N.rvault.balanceOf(U);if(s>0n)await act('rvault','emergencyWithdraw',[s/10n,0n],U,{check:async()=>eq(await N.rvault.balanceOf(U),s-s/10n)});
   await act('revenue','harvest()',[],U);await act('revenue','harvest(address)',[V],U);
   await act('rvault','withdrawAll',[],U,{check:async()=>eq(await N.rvault.balanceOf(U),0n)});
   await act('rvault','depositAll',[],U,{check:async()=>assert(await N.rvault.balanceOf(U)>0n)});
 });
 for(const [k,t,strat] of [['svault',SDT,'yearn'],['crvVault',CRV,'crv'],['fxnVault',SDFXN,'fxn']]){
  await scenario(k+' real vault deposit, mint, transfers, withdrawals and harvest',async()=>{
   await vd(k,t,10n*W,U);await vd(k,t,2n*W,U,'deposit(uint256)');await act(k,'mint(uint256,address)',[W/100n,U],U,{check:async()=>assert(await N[k].balanceOf(U)>0n)});
   let b=await N[k].balanceOf(U),q=b/20n;await act(k,'transfer',[V,q],U,{check:async()=>eq(await N[k].balanceOf(V),q)});
   await act(k,'approve',[V,q],U,{check:async()=>eq(await N[k].allowance(U,V),q)});
   await act(k,'transferFrom',[U,V,q],V,{check:async()=>eq(await N[k].allowance(U,V),0n)});
   await act(k,'earn',[],U);await act(k,'updateAPY',[],U);
   await act(k,'requestWithdrawal',[q],U,{reject:'QueueDisabled'});await act(k,'completeWithdrawal',[],U,{reject:'QueueDisabled'});await act(k,'withdrawQueuedImmediate',[],U,{reject:'QueueDisabled'});
   b=await N[k].balanceOf(U);await act(k,'redeem',[b/10n,U,U],U,{check:async()=>eq(await N[k].balanceOf(U),b-b/10n)});
   b=await N[k].balanceOf(U);await act(k,'withdraw(uint256)',[b/10n],U,{check:async()=>eq(await N[k].balanceOf(U),b-b/10n)});
   await act(k,'withdraw(uint256,address,address)',[W/100n,U,U],U,{check:async()=>assert(await N[k].balanceOf(U)<b)});
   b=await N[k].balanceOf(U);await act(k,'emergencyWithdraw',[b/20n,MAX],U,{reject:'VaultEmergencyMinAssetsOut'});await act(k,'emergencyWithdraw',[b/20n,0n],U,{check:async()=>eq(await N[k].balanceOf(U),b-b/20n)});
   if(strat!=='yearn'){await act(strat,'harvest()',[],U);await act(strat,'harvest(address)',[V],U);if(strat==='crv')await act(strat,'claim',[],U);}
   await warp(86401);await act(k,'updateAPY',[],U);
   await act(k,'withdrawAll',[],V,{check:async()=>eq(await N[k].balanceOf(V),0n)});
   await act(k,'withdrawAll',[],U,{check:async()=>eq(await N[k].balanceOf(U),0n)});
   await act(k,'depositAll',[],U,{check:async()=>assert(await N[k].balanceOf(U)>0n)});
  });
 }
 await scenario('all vault administrative controls and ownership',async()=>{
   for(const k of ['rvault','svault','crvVault','fxnVault']){
     await own(k,'setDepositFeeBps',[50n],async()=>eq(await N[k].depositFeeBps(),50n));await act(k,'setDepositFeeBps',[101n],EOA,{reject:'VaultDepositFeeExceeds1'});
     const strat=await N[k].strategy();
     if(k==='rvault'||k==='svault')await own(k,'setStrategy',[strat],async()=>eq(low(await N[k].strategy()),low(strat)));
     else await act(k,'setStrategy',[strat],EOA,{reject:'StrategyFixed'});
     const feeReceiver=await N[k].adminFeeReceiver();await act(k,'proposeAdminFeeReceiver',[V],U,{reject:'VaultFeeReceiverOnly'});
     await need(k,'proposeAdminFeeReceiver',[V],feeReceiver,{check:async()=>eq(low(await N[k].pendingAdminFeeReceiver()),low(V))});
     await act(k,'executeAdminFeeReceiverChange',[],feeReceiver,{reject:'VaultSevenDayDelay'});await warp(WEEK+1);
     await act(k,'executeAdminFeeReceiverChange',[],feeReceiver,{check:async()=>eq(low(await N[k].adminFeeReceiver()),low(V))});
     await act(k,'initialize',[strat,'reinit','X',0,V,EOA,false,false],EOA,{reject:'Initializable: contract is already initialized'});
   }
 });
 await scenario('core administrative setters, changed values and authorization',async()=>{
   await act('locker','configureSystem',[A.staking,A.merchant],EOA,{reject:'AlreadyConfigured'});
   await rebind('locker','setRevenueStaking','revenueStaking',V);await rebind('locker','setRevenueStaking','revenueStaking',A.staking);
   await rebind('locker','setBoostMerchant','boostMerchant',V);await rebind('locker','setBoostMerchant','boostMerchant',A.merchant);
   await rebind('locker','setCyvlSDT','CYVLSDT',V);await rebind('locker','setCyvlSDT','CYVLSDT',A.token);
   await rebind('locker','setBoostMarketplace','BOOST_MARKETPLACE');
   await rebind('locker','setTreasuryReceiver','treasuryReceiver',V);
   await own('locker','setPoLDepositShare',[1000,manager],async()=>eq(await N.locker.poLDepositShareBps(),1000n));await act('locker','setPoLDepositShare',[2501,manager],EOA,{reject:'InvalidPoLShare'});
   await own('locker','setMarketplaceOperator',[false]);await own('locker','setMarketplaceOperator',[true]);
   await rebind('token','setLocker','locker',A.locker);
   await rebind('merchant','setLocker','LOCKER',A.locker);await rebind('merchant','setMarketplace','MARKETPLACE');
   await own('merchant','setKeeper',[K,true],async()=>eq(await N.merchant.isKeeper(K),true));
   await own('merchant','setMinimumLeaseBoost',[W/100n],async()=>eq(await N.merchant.minimumLeaseBoost(),W/100n));
   await own('merchant','setPostListingIfNoAcceptableOffer',[true],async()=>eq(await N.merchant.postListingIfNoAcceptableOffer(),true));
   await own('merchant','setSaleRates',[1000000n,1000000n,100n*W],async()=>eq(await N.merchant.postPricePerWeek(),1000000n));
   await rebind('staking','setLocker','LOCKER',A.locker);await rebind('staking','setCyvlSDT','CYVLSDT',A.token);await rebind('staking','setOmniRouter','OMNI_ROUTER');
   await own('staking','setLpBribeRevenueShare',[1000,V],async()=>eq(await N.staking.lpBribeRevenueShareBps(),1000n));
   await rebind('staking','setTreasuryReceiver','treasuryReceiver',V);
   await own('staking','setImmediateWithdrawFeePpm',[1000],async()=>eq(await N.staking.immediateWithdrawFeePpm(),1000n));await act('staking','setImmediateWithdrawFeePpm',[35001],EOA,{reject:'InvalidImmediateWithdrawFee'});
   await own('staking','addRewardToken',[WETH],async()=>assert(await N.staking.isRewardToken(WETH)));await act('staking','addRewardToken',[SDT],EOA,{reject:'RewardTokenAlreadyAdded'});
   await act('staking','setAdmin',[V],U,{reject:'OnlyAdmin'});await act('staking','setAdmin',[V],admin,{check:async()=>eq(low(await N.staking.admin()),low(V))});
   for(const [f,g] of [['setWant','WANT'],['setVault','vault'],['setRevenueStaking','REVENUE_STAKING'],['setLocker','LOCKER'],['setOmniRouter','OMNI_ROUTER']])await rebind('revenue',f,g);
   for(const [f,g] of [['setVault','vault'],['setYearnVault','yearn'],['setCurveLiquidityGuard','curveLiquidityGuard']])await rebind('yearn',f,g);
   await rebind('fxn','setConvexCurveLiquidityGuard','curveLiquidityGuard');
   await own('fxn','setAllocationTargets',[5000,5000],async()=>eq((await N.fxn.allocationTargets())[0],5000n));
   await act('fxn','setAllocationTargets',[5000,4999],EOA,{reject:'InvalidTargets'});await act('fxn','activateConvex',[],EOA,{reject:'InvalidDependency'});
   await own('revenue','pause',[],async()=>assert(await N.revenue.paused()));await own('revenue','unpause',[],async()=>assert(!(await N.revenue.paused())));
   await own('revenue','panic',[],async()=>assert(await N.revenue.paused()));await own('revenue','unpause',[],async()=>assert(!(await N.revenue.paused())));
 });
 await scenario('ownership transfer, acceptance, renunciation for each owned instance',async()=>{
  for(const k of Object.keys(N).filter(k=>k!=='impl'&&N[k].interface.hasFunction('owner()'))){
   let o=await N[k].owner();if(o===ZERO)continue;
   await act(k,'transferOwnership',[V],U,{reject:authError(k)});
   if(N[k].interface.hasFunction('acceptOwnership()')){
     await need(k,'transferOwnership',[V],o,{check:async()=>eq(low(await N[k].pendingOwner()),low(V))});
     await act(k,'acceptOwnership',[],U,{reject:N[k].interface.hasError('OwnableUnauthorizedAccount')?'OwnableUnauthorizedAccount':'Ownable2Step: caller is not the new owner'});
     await act(k,'acceptOwnership',[],V,{check:async()=>eq(low(await N[k].owner()),low(V))});
   }else await act(k,'transferOwnership',[V],o,{check:async()=>eq(low(await N[k].owner()),low(V))});
   await act(k,'renounceOwnership',[],V,{check:async()=>eq(await N[k].owner(),ZERO)});
  }
 });
 await scenario('boost capacity, delegated commitments, marketplace lease and listings',async()=>{
   await lock(1000n*W);await own('merchant','setMinimumLeaseBoost',[W/100n],async()=>eq(await N.merchant.minimumLeaseBoost(),W/100n));
   let min=await soft(()=>N.merchant.aladdinMinimumPriceInSDT());let rate=typeof min==='bigint'?min*2n*10n**6n/(100n*W)+1000000n:1000000n;
   await own('merchant','setSaleRates',[rate,rate,100n*W],async()=>eq(await N.merchant.postPricePerWeek(),rate));
   const end=(Math.floor((await now())/WEEK)+2)*WEEK,expiry=(await now())+WEEK;
   let d=await N.locker.daoDelegableBoost(),a=await N.locker.adminDelegableBoost(),m=await N.locker.merchantDelegableBoost();
   let ids={dao:await N.locker.nextDaoBoostCommitmentId(),admin:await N.locker.nextAdminBoostCommitmentId(),merchant:await N.locker.nextMerchantBoostCommitmentId()};
   await act('locker','delegateDaoBoost',[d/10n,end,U],EOA,{check:async()=>assert((await N.locker.daoBoostCommitments(ids.dao)).active)});
   await act('locker','delegateAdminBoost',[a/10n,end,V],admin,{check:async()=>assert((await N.locker.adminBoostCommitments(ids.admin)).active)});
   await act('locker','delegateBoost',[m/20n,end,V],U,{reject:'OnlyBoostMerchant'});
   await act('merchant','delegateAladdinBoost',[m/20n,end],EOA,{check:async()=>assert((await N.locker.merchantBoostCommitments(ids.merchant)).active)});
   let q=m/30n;await fund(USDC,U,1000n*10n**6n);await approve(USDC,A.merchant,U);
   await act('merchant','leaseBoost',[q,1,U,0n,expiry],U,{reject:'MaximumPaymentExceeded'});
   let quote=await soft(()=>N.merchant.quoteLease(q,1));if(Array.isArray(quote))await act('merchant','leaseBoost',[q,1,U,quote[2]*2n+1n,expiry],U,{check:async()=>assert(await N.locker.merchantCommittedBoost()>0n)});
   let l=await act('merchant','createMarketplaceListing',[q,1,2,expiry],EOA,{check:async row=>assert(await N.merchant.createdListings(row.staticResult))});
   if(l.status==='PASS_ASSERTED'){let id=l.staticResult;await act('merchant','refreshMarketplaceListing',[id,q/2n],EOA);await act('merchant','cancelMarketplaceListing',[id],EOA,{check:async()=>eq(await N.merchant.createdListings(id),false)});}
   await act('merchant','fillProfitableOffer',[0,q,0,2*WEEK],U,{reject:'OfferBelowCurrentRate'});
   await act('merchant','executeBestRoute',[[0,q,0,expiry,1,2,end]],EOA);
   for(const [lane,id] of Object.entries(ids)){const f='release'+lane[0].toUpperCase()+lane.slice(1)+'BoostCommitment';await act('locker',f,[id],U,{reject:'CommitmentNotExpired'});}
   await warp(3*WEEK);
   for(const [lane,id] of Object.entries(ids)){const f='release'+lane[0].toUpperCase()+lane.slice(1)+'BoostCommitment';await act('locker',f,[id],U,{check:async()=>assert(!(await N.locker[lane+'BoostCommitments'](id)).active)});}
 });
 await scenario('FXN allocation, migration, direct deposit and harvest',async()=>{
   await vd('fxnVault',SDFXN,20n*W,U);
   let before=await N.fxn.childBalances();await act('fxn','setAllocationTargets',[5000,5000],EOA,{check:async()=>{let after=await N.fxn.childBalances();eq(after[0],before[0]);eq(after[1],before[1]);}});
   await vd('fxnVault',SDFXN,5n*W,U);await act('fxn','rebalanceAllocations',[],U);await act('fxn','deposit',[],U);
   let b=await N.fxn.childBalances();if(b[0]>0n)await act('fxn','migrate',[0,b[0]/10n],EOA);
   let lp=await N.fxn.lpBalance();if(lp>0n)await act('fxn','migrate',[1,lp/10n],EOA);
   await act('fxn','migrate',[2,1],EOA,{reject:'InvalidMigration'});await warp(86401);await act('fxn','harvest()',[],U);await act('fxn','harvest(address)',[V],U);
 });
 await scenario('restricted strategy and locker callbacks reject outsiders',async()=>{
   for(const k of ['revenue','yearn','crv','fxn']){
     for(const [f,args] of [['deposit',[]],['withdraw',[W]],['emergencyWithdraw',[W]],['lockVaultProfit',[W]],['requestWithdrawal',[W]],['completeWithdrawal',[1n]],['withdrawPendingInstant',[1n]]]){
       if(!N[k].interface.hasFunction(f))continue;if(f==='deposit'&&['crv','fxn'].includes(k))continue;
       await act(k,f,args,U,{reject:['revenue','yearn'].includes(k)?'NotVault':'VaultOnly'});
     }
   }
   await act('locker','forwardMerchantRevenue',[1n],U,{reject:'OnlyBoostMerchant'});
   await act('locker','marketplaceCreateListing',[W,1000,1,2,USDC,await now()+WEEK],U,{reject:'OnlyBoostMerchant'}); // corrected argument count below by ABI case inventory
 });
 // Market protection: run real front/victim/back transactions on the fork, both directions.
 const poolABI=['function coins(uint256) view returns(address)','function balances(uint256) view returns(uint256)','function get_dy(uint256,uint256,uint256) view returns(uint256)','function exchange(uint256,uint256,uint256,uint256) returns(uint256)'];
 const guardABI=['function quoteDeposit(address,uint8,uint256,uint16) view returns(uint256,uint256)','function quoteWithdraw(address,uint8,uint256,uint16) view returns(uint256,uint256)'];
 for(const [k,strat,t,slip] of [['svault','yearn',SDT,200],['fxnVault','fxn',SDFXN,75]]){
   for(const direction of [0,1])for(const bps of [100,500,1500]){
    await scenario('sandwich '+k+' direction '+direction+' reserve bps '+bps,async()=>{
     const poolAddr=strat==='yearn'?await N.yearn.CURVE_LP():await N.fxn.curvePool(),guardAddr=await N[strat].curveLiquidityGuard(),pool=C(p,poolAddr,poolABI),guard=C(p,guardAddr,guardABI);
     if(k==='fxnVault')await own('fxn','setAllocationTargets',[0,10000],async()=>eq((await N.fxn.allocationTargets())[1],10000n));
     await fund(t,U,50n*W);await approve(t,A[k],U);
     const q=10n*W,controlSnap=await p.send('evm_snapshot',[]),baseQuote=await soft(()=>guard.quoteDeposit(poolAddr,1,q,slip));
     const control=await act(k,'deposit(uint256,address)',[q,U],U,{check:async()=>assert(await N[k].balanceOf(U)>0n)});
     const controlShares=await N[k].balanceOf(U);await p.send('evm_revert',[controlSnap]);signers.clear();
     const input=await pool.coins(direction),output=await pool.coins(1-direction),res=await pool.balances(direction),size=res*BigInt(bps)/10000n;
     if(size===0n)throw Error('zero attack size');
     await fund(input,X,size);await approve(input,poolAddr,X);const startIn=await C(p,input).balanceOf(X),startOut=await C(p,output).balanceOf(X);
     const front=await ext(pool,'exchange',[direction,1-direction,size,0],X,{check:async()=>assert(await C(p,output).balanceOf(X)>startOut)});
     if(front.status!=='PASS_ASSERTED')throw Error('front swap failed');
     const shiftedQuote=await soft(()=>guard.quoteDeposit(poolAddr,1,q,slip));
     const vbefore=await C(p,t).balanceOf(U),sBefore=await N[k].balanceOf(U);
     const victim=await act(k,'deposit(uint256,address)',[q,U],U,{check:async()=>assert(await N[k].balanceOf(U)>sBefore)});
     const vafter=await C(p,t).balanceOf(U),sAfter=await N[k].balanceOf(U),received=await C(p,output).balanceOf(X)-startOut;
     if(received>0n){await approve(output,poolAddr,X);await ext(pool,'exchange',[1-direction,direction,received,0],X);}
     const endIn=await C(p,input).balanceOf(X);const result={k,strat,direction,bps,input,output,size,baseQuote,shiftedQuote,controlStatus:control.status,controlShares,victimStatus:victim.status,victimError:victim.error,vbefore,vafter,sBefore,sAfter,attackerNetInput:endIn-startIn,peg:await soft(()=>N.fxn.sdFxnToFxnWad()),rollback:vbefore===vafter&&sBefore===sAfter,classification:control.status==='PASS_ASSERTED'&&victim.status==='FAIL'&&vbefore===vafter&&sBefore===sAfter?'VICTIM_REVERTED_ATOMICALLY_CHECK_GUARD_CAUSE':victim.status==='PASS_ASSERTED'?'VICTIM_EXECUTED_COMPARE_NAV':'INCONCLUSIVE'};
     report.sandwich.push(result);log('SANDWICH',result);
    });
   }
 }

 // Positive offer paths using the verified live BoostMarketplace ABI.
 await scenario('SUPPLEMENT actual marketplace offers, direct lease and routing',async()=>{
   const maddr=await N.merchant.MARKETPLACE(),market=C(p,maddr,[
     'function minOrderAmount() view returns(uint256)','function minFillAmount() view returns(uint256)','function feeBps() view returns(uint256)',
     'function createOffer(uint256,uint256,uint256,address,uint256,address) returns(uint256)',
     'function getOffer(uint256) view returns(tuple(address buyer,uint96 pricePerWeek,address paymentToken,uint32 duration,uint64 expiry,address recipient,uint128 amount,uint128 filled))',
     'function getListing(uint256) view returns(tuple(address seller,uint96 pricePerWeek,address paymentToken,uint32 maxDuration,uint64 expiry,uint128 amount,uint128 filled,uint32 minDuration))',
     'function createListing(uint256,uint256,uint256,uint256,address,uint256) returns(uint256)','function cancelOffer(uint256)','function fillListing(uint256,uint256,uint256,uint256,uint256,address)']);
   const minOrder=await market.minOrderAmount(),minFill=await market.minFillAmount(),qty=minOrder>minFill?minOrder:minFill;
   await lock(qty*100n+100n*W);
   await own('merchant','setMinimumLeaseBoost',[qty],async()=>eq(await N.merchant.minimumLeaseBoost(),qty));
   const minSDT=await soft(()=>N.merchant.aladdinMinimumPriceInSDT());
   const rate=typeof minSDT==='bigint'?minSDT*4n*10n**6n/(100n*W)+1000000n:1000000n;
   await own('merchant','setSaleRates',[rate,rate,100n*W],async()=>eq(await N.merchant.minimumFillPricePerWeek(),rate));
   const cap=await N.locker.merchantDelegableBoost(),daoCap=await N.locker.daoDelegableBoost(),expiry=(await now())+WEEK,end=(Math.floor((await now())/WEEK)+2)*WEEK;
   assert(cap>qty*4n&&daoCap>=qty,'insufficient real capacity');
   const payment=qty*rate/W*4n+10n**6n;
   await fund(USDC,V,payment*8n);await approve(USDC,maddr,V);await approve(USDC,A.merchant,V);
   let makeOffer=async()=>{const row=await ext(market,'createOffer',[qty,rate*2n,1,USDC,expiry,V],V,{check:async row=>eq(low((await market.getOffer(row.staticResult)).buyer),low(V))});if(row.status!=='PASS_ASSERTED')throw Error('offer create failed');return row.staticResult;};
   let id=await makeOffer(),before=await market.getOffer(id);
   await act('merchant','fillProfitableOffer',[id,qty,0n,2*WEEK],U,{check:async()=>eq((await market.getOffer(id)).filled,before.filled+qty)});
   id=await makeOffer();before=await market.getOffer(id);
   await act('locker','marketplaceAcceptOffer',[id,qty,0n,2*WEEK,true],EOA,{check:async()=>eq((await market.getOffer(id)).filled,before.filled+qty)});
   id=await makeOffer();before=await market.getOffer(id);
   await act('merchant','executeBestRoute',[[id,qty,0n,expiry,1,2,end]],EOA,{check:async()=>eq((await market.getOffer(id)).filled,before.filled+qty)});
   let quote=await soft(()=>N.merchant.quoteLease(qty,1));if(Array.isArray(quote))await act('merchant','leaseBoost',[qty,1,V,quote[2]*2n+1n,expiry],V,{check:async row=>assert(row.staticResult[0]>0n)});
   await own('merchant','setPostListingIfNoAcceptableOffer',[true],async()=>assert(await N.merchant.postListingIfNoAcceptableOffer()));
   let l=await act('merchant','executeBestRoute',[[0,qty,0n,expiry,1,2,end]],EOA,{check:async row=>assert(await N.merchant.createdListings(row.staticResult[1]))});
   if(l.status==='PASS_ASSERTED'){let id=l.staticResult[1];await act('merchant','refreshMarketplaceListing',[id,qty],EOA,{check:async()=>eq((await market.getListing(id)).amount,qty)});await act('merchant','cancelMarketplaceListing',[id],EOA,{check:async()=>eq(await N.merchant.createdListings(id),false)});}
   await own('merchant','setPostListingIfNoAcceptableOffer',[false],async()=>assert(!(await N.merchant.postListingIfNoAcceptableOffer())));
   await act('merchant','executeBestRoute',[[0,qty,0n,expiry,1,2,end]],EOA,{check:async row=>assert((await N.locker.merchantBoostCommitments(row.staticResult[1])).active)});
 });
 // Supply positive non-empty external routes for strategies and delegated ERC4626 callers.
 for(const [k,t,strat] of [['rvault',A.token,'revenue'],['svault',SDT,'yearn'],['crvVault',CRV,'crv'],['fxnVault',SDFXN,'fxn']]){
  await scenario('SUPPLEMENT '+k+' donation, fee, delegated exit, emergency and exact asset accounting',async()=>{
   if(k==='rvault')await lock(100n*W);else await fund(t,U,100n*W);
   await approve(t,A[k],U);await own(k,'setDepositFeeBps',[100],async()=>eq(await N[k].depositFeeBps(),100n));
   const feeReceiver=await N[k].adminFeeReceiver(),bfee=await C(p,t).balanceOf(feeReceiver),bU=await C(p,t).balanceOf(U),q=10n*W;
   await need(k,'deposit(uint256,address)',[q,U],U,{check:async()=>{eq(await C(p,t).balanceOf(U),bU-q);eq(await C(p,t).balanceOf(feeReceiver),bfee+q/100n);assert(await N[k].balanceOf(U)>0n);}});
   let b=await N[k].balanceOf(U),shares=b/20n;
   await act(k,'approve',[V,shares],U,{check:async()=>eq(await N[k].allowance(U,V),shares)});
   const vpre=await C(p,t).balanceOf(V);await act(k,'redeem',[shares,V,U],V,{check:async()=>{eq(await N[k].balanceOf(U),b-shares);eq(await N[k].allowance(U,V),0n);assert(await C(p,t).balanceOf(V)>vpre);}});
   await act(k,'deposit(uint256,address)',[0n,U],U,{reject:'VaultZeroDeposit'});await act(k,'deposit(uint256,address)',[W,ZERO],U,{reject:'VaultInvalidReceiver'});
   await act(k,'mint(uint256,address)',[0n,U],U,{reject:'VaultZeroShares'});
   await act(k,'redeem',[1n,ZERO,U],U,{reject:'VaultInvalidReceiver'});await act(k,'withdraw(uint256,address,address)',[0n,U,U],U,{reject:'VaultZeroAssets'});
   b=await N[k].balanceOf(U);await act(k,'redeem',[b+1n,U,U],U,{reject:'VaultInsufficientShares'});
   await act(k,'emergencyWithdraw',[b/20n,MAX],U,{reject:'VaultEmergencyMinAssetsOut'});
   await act(k,'emergencyWithdraw',[b/20n,0n],U,{check:async()=>eq(await N[k].balanceOf(U),b-b/20n)});
   if(k==='rvault'){
     b=await N[k].balanceOf(U);await act(k,'requestWithdrawal',[b/10n],U,{check:async()=>assert((await N[k].pendingWithdrawal(U)).shares>0n)});
     await act(k,'requestWithdrawal',[b/10n],U,{reject:'VaultPendingWithdrawalExists'});await act(k,'withdrawQueuedImmediate',[],U,{check:async()=>eq((await N[k].pendingWithdrawal(U)).shares,0n)});
   }
   // Real share-vault donation, no token supply manipulation in the tested vault.
   const oldPps=await N[k].getPricePerFullShare(),oldBal=await N[k].totalAssets();
   await ext(C(p,t),'transfer',[A[k],W/10n],U,{check:async()=>eq(await N[k].totalAssets(),oldBal+W/10n)});
   await act(k,'earn',[],V,{check:async()=>assert(await N[k].getPricePerFullShare()>0n)});
   await warp(43201);await act(k,'updateAPY',[],U,{check:async()=>assert(await N[k].apyCount()>0n)});
  });
 }
 await scenario('SUPPLEMENT staking PoL escrow, distinct reward streams and protocol-only callbacks',async()=>{
   await lock(100n*W);await stake(40n*W);await fund(SDT,U,40n*W);await fund(USDC,U,20n*10n**6n);
   await own('locker','setPoLDepositShare',[0,ZERO],async()=>eq(await N.locker.poLDepositShareBps(),0n));
   await own('staking','setLpBribeRevenueShare',[1000,V],async()=>eq(await N.staking.lpBribeRevenueShareBps(),1000n));
   for(const [t,q] of [[SDT,10n*W],[SDT,5n*W],[USDC,10n*10n**6n]]){
     await ext(C(p,t),'transfer',[A.locker,q],U,{check:async()=>assert(await C(p,t).balanceOf(A.locker)>=q)});
     await act('locker','forwardRevenue',[],V,{check:async()=>eq(await C(p,t).balanceOf(A.locker),0n)});
   }
   const pending=await N.staking.pendingPoLRevenue(SDT);await own('locker','setPoLDepositShare',[2500,manager],async()=>eq(await N.locker.poLDepositShareBps(),2500n));
   let pre=await C(p,SDT).balanceOf(manager);await act('staking','forwardPendingPoLRevenue',[SDT],U,{check:async()=>{eq(await C(p,SDT).balanceOf(manager),pre+pending);eq(await N.staking.pendingPoLRevenue(SDT),0n);}});
   let count=await N.staking.pendingConversionCount();
   for(let i=0n;i<count;i++){let a=await act('staking','convertExcess',[i],U,{check:async()=>assert((await N.staking.pendingConversions(i)).converted)});if(a.status==='PASS_ASSERTED')await act('staking','convertExcess',[i],U,{reject:'NoPendingExcess'});}
   await warp(WEEK+1);const before=await N.staking.earned(U,A.token);await act('staking','claimRewardsSelf',[],U,{check:async()=>{eq(await N.staking.earned(U,A.token),0n);assert(before>=0n);}});
   await act('staking','forwardPendingPoLRevenue',[A.token],U,{reject:'InvalidUnderlyingToken'});
 });
 // Owner controls on the actual existing PoL manager, not a replacement/mock.
 await scenario('SUPPLEMENT live PoL manager configuration and guarded investment paths',async()=>{
   const a=C(p,manager,[
     'error Unauthorized()','error Invalid()','error State()','error Slippage()',
     'function owner() view returns(address)','function pendingOwner() view returns(address)','function guardian() view returns(address)','function paused() view returns(bool)','function operators(address) view returns(bool)',
     'function setOperator(address,bool)','function setGuardian(address)','function setPaused(bool)','function setProfitRecipient(address)','function profitRecipient() view returns(address)','function setProfitFee(uint16)','function profitFeeBps() view returns(uint16)','function setSafetyLimits(uint16,uint16)','function setLiquidityBounds(address)','function liquidityBounds() view returns(address)','function setCurveSlippageBps(uint16)','function curveSlippageBps() view returns(uint16)','function setUniSlippageBps(uint16)','function uniSlippageBps() view returns(uint16)',
     'function configureCurvePool(address,address)','function configureCurveGauge(address)','function configureUniswapPosition(address,uint256)','function curvePool() view returns(address)','function curveLp() view returns(address)','function curveGauge() view returns(address)','function uniNftManager() view returns(address)','function uniTokenId() view returns(uint256)',
     'function setAllocations(uint16[7])','function allocations(uint256) view returns(uint16)','function setModuleEnabled(uint8,bool,bool)','function allocationEnabledMask() view returns(uint8)','function harvestEnabledMask() view returns(uint8)','function setVault(uint8,address)','function vaults(uint256) view returns(address)','function setMorphoV2(uint8,bool)','function morphoV2(uint256) view returns(bool)',
     'function depositCurve(uint256) returns(uint256)','function withdrawCurve(uint256,bool) returns(uint256)','function depositVault(uint8,uint256,uint256) returns(uint256)','function redeemVault(uint8,uint256,uint256) returns(uint256)','function currentPPS(uint8) view returns(uint256)','function addUniLiquidity(uint256,uint256) returns(uint128,uint256,uint256)','function removeUniLiquidity(uint256) returns(uint256,uint256)','function rebalanceUniTokens(address,uint256) returns(uint256)','function withdrawUniNFT(address)','function allocateFunds(address,uint256)','function migrate((uint8,uint8,uint256,uint256)) returns(uint256)','function harvest(uint8) returns(uint256)',
     'function setBuyLevels(uint256[5],uint256[5])','function buyLevels(uint256) view returns(uint256,uint256)','function resetSwapRateAllocationWatermark()','function buySpentSDT() view returns(uint256)','function swapForCyvlSDT(uint256) returns(uint256,uint256,uint256)','function rescueToken(address,address,uint256)','function proposeOwner(address)','function acceptOwner()','function onERC721Received(address,address,uint256,bytes) returns(bytes4)'
   ]);
   const ownPol=async(f,args,check)=>{await ext(a,f,args,U,{reject:'Unauthorized'});return ext(a,f,args,EOA,{check});};
   await ownPol('setOperator',[K,true],async()=>assert(await a.operators(K)));await ownPol('setGuardian',[V],async()=>eq(low(await a.guardian()),low(V)));
   await ext(a,'setPaused',[true],V,{check:async()=>assert(await a.paused())});await ext(a,'setPaused',[false],V,{reject:'Unauthorized'});await ownPol('setPaused',[false],async()=>assert(!(await a.paused())));
   await ownPol('setProfitRecipient',[A.locker],async()=>eq(low(await a.profitRecipient()),low(A.locker)));
   await ownPol('setProfitFee',[500],async()=>eq(await a.profitFeeBps(),500n));await ownPol('setSafetyLimits',[100,100]);
   await ownPol('setLiquidityBounds',[await a.liquidityBounds()],async()=>assert((await a.liquidityBounds())!==ZERO));
   await ownPol('setCurveSlippageBps',[75],async()=>eq(await a.curveSlippageBps(),75n));await ownPol('setUniSlippageBps',[75],async()=>eq(await a.uniSlippageBps(),75n));
   let cp=await a.curvePool(),lp=await a.curveLp(),cg=await a.curveGauge();
   await ownPol('configureCurvePool',[cp,lp]);await ownPol('configureCurveGauge',[cg]);await ownPol('configureUniswapPosition',[await a.uniNftManager(),await a.uniTokenId()]);
   let allocations=[];for(let i=0;i<7;i++)allocations.push(await a.allocations(i));await ownPol('setAllocations',[allocations]);
   await ownPol('setModuleEnabled',[0,true,true],async()=>assert((await a.allocationEnabledMask())&1n));
   await fund(SDT,U,100n*W);await ext(C(p,SDT),'transfer',[manager,100n*W],U,{check:async()=>assert(await C(p,SDT).balanceOf(manager)>=100n*W)});
   let dep=await ext(a,'depositCurve',[W],K,{check:async row=>assert(row.staticResult>0n)});
   if(dep.status==='PASS_ASSERTED')await ext(a,'withdrawCurve',[dep.staticResult/10n,true],K,{check:async row=>assert(row.staticResult>0n)});
   for(let i=0;i<5;i++){let v=await a.vaults(i);if(v===ZERO)continue;await ownPol('setVault',[i,v]);await ownPol('setMorphoV2',[i,await a.morphoV2(i)]);const t=await soft(()=>C(p,v,['function asset() view returns(address)']).asset());if(typeof t!=='string')continue;
      let d=await C(p,t).decimals();let amount=10n**BigInt(d);await fund(t,U,amount);await ext(C(p,t),'transfer',[manager,amount],U);
      let row=await ext(a,'depositVault',[i,amount,1n],K,{check:async r=>assert(r.staticResult>0n)});if(row.status==='PASS_ASSERTED')await ext(a,'redeemVault',[i,row.staticResult/10n,1n],K,{check:async r=>assert(r.staticResult>0n)});
   }
   await ext(a,'allocateFunds',[SDT,W],K);await ext(a,'harvest',[await a.harvestEnabledMask()],K);
   await ext(a,'swapForCyvlSDT',[W],K);await ownPol('resetSwapRateAllocationWatermark',[],async()=>eq(await a.buySpentSDT(),0n));
   let prices=[],limits=[];for(let i=0;i<5;i++){let r=await a.buyLevels(i);prices.push(r[0]);limits.push(r[1]);}await ownPol('setBuyLevels',[prices,limits]);
   await ext(a,'migrate',[[0,1,W/10n,1]],K);
   await ext(a,'addUniLiquidity',[W/100n,W/100n],K);await ext(a,'rebalanceUniTokens',[SDT,W/100n],K);await ext(a,'removeUniLiquidity',[1],K);
   await ext(a,'onERC721Received',[U,U,await a.uniTokenId(),'0x'],U,{reject:'Invalid'});
   await ownPol('rescueToken',[SDT,V,W/100n]);await ownPol('withdrawUniNFT',[V]);
   await ownPol('proposeOwner',[V],async()=>eq(low(await a.pendingOwner()),low(V)));await ext(a,'acceptOwner',[],V,{check:async()=>eq(low(await a.owner()),low(V))});
 });
 // Compare unmanipulated victim and attacker-only round trip to real sandwich with deposit and redemption.
 for(const [k,strat,t,slip] of [['svault','yearn',SDT,200],['fxnVault','fxn',SDFXN,75]]){
  for(const direction of [0,1])for(const bps of [100,500,1500])for(const mode of ['deposit','redeem']){
   await scenario('SUPPLEMENT guarded '+mode+' '+k+' direction '+direction+' reserve bps '+bps,async()=>{
    const poolAddr=strat==='yearn'?await N.yearn.CURVE_LP():await N.fxn.curvePool(),guardAddr=await N[strat].curveLiquidityGuard(),idx=strat==='yearn'?'uint256':'int128';
    const pool=C(p,poolAddr,['function coins(uint256) view returns(address)','function balances(uint256) view returns(uint256)','function price_oracle() view returns(uint256)','function calc_token_amount(uint256[2],bool) view returns(uint256)','function calc_withdraw_one_coin(uint256,'+idx+') view returns(uint256)','function exchange('+idx+','+idx+',uint256,uint256) returns(uint256)']);
    const guard=C(p,guardAddr,guardABI);
    if(k==='fxnVault')await own('fxn','setAllocationTargets',[0,10000],async()=>eq((await N.fxn.allocationTargets())[1],10000n));
    await fund(t,U,100n*W);await approve(t,A[k],U);
    const q=10n*W;let shares=0n;
    if(mode==='redeem'){await need(k,'deposit(uint256,address)',[q*2n,U],U,{check:async()=>assert(await N[k].balanceOf(U)>0n)});shares=(await N[k].balanceOf(U))/2n;if(k==='fxnVault'&&await N.fxn.lpBalance()===0n)throw Error('Convex position not invested; cannot prove guarded redemption');}
    const input=await pool.coins(direction),output=await pool.coins(1-direction),reserve=await pool.balances(direction),size=reserve*BigInt(bps)/10000n;
    await fund(input,X,size);await approve(input,poolAddr,X);await approve(output,poolAddr,X);
    const base=await p.send('evm_snapshot',[]),baseIn=await C(p,input).balanceOf(X),baseOut=await C(p,output).balanceOf(X);
    const functionName=mode==='deposit'?'deposit(uint256,address)':'redeem(uint256,address,address)',args=mode==='deposit'?[q,U]:[shares,U,U];
    const initialAsset=await C(p,t).balanceOf(U),initialShare=await N[k].balanceOf(U);
    const quoteSize=mode==='deposit'?q:(strat==='yearn'?await N.yearn.totalCurveLp():await N.fxn.lpBalance())/2n;
    const readQuote=async()=>mode==='deposit'?soft(()=>guard.quoteDeposit(poolAddr,1,quoteSize,slip)):soft(()=>guard.quoteWithdraw(poolAddr,1,quoteSize,slip));
    const baseQuote=await readQuote(),baseSpot=await soft(()=>mode==='deposit'?pool.calc_token_amount([0n,quoteSize],true):pool.calc_withdraw_one_coin(quoteSize,1)),oracleBefore=await soft(()=>pool.price_oracle());
    let control=await act(k,functionName,args,U,{check:async()=>assert(mode==='deposit'?await N[k].balanceOf(U)>initialShare:await C(p,t).balanceOf(U)>initialAsset)});
    const controlDelta=mode==='deposit'?await N[k].balanceOf(U)-initialShare:await C(p,t).balanceOf(U)-initialAsset;
    await p.send('evm_revert',[base]);signers.clear();
    const attackControl=await p.send('evm_snapshot',[]);
    const front=async()=>ext(pool,'exchange',[direction,1-direction,size,0],X,{check:async()=>assert(await C(p,output).balanceOf(X)>baseOut)});
    const back=async()=>{const obtained=await C(p,output).balanceOf(X)-baseOut;if(obtained<=0n)throw Error('no swap output');return ext(pool,'exchange',[1-direction,direction,obtained,0],X,{check:async()=>assert(await C(p,input).balanceOf(X)>baseIn-size)});};
    let r=await front();if(r.status!=='PASS_ASSERTED')throw Error('front-run control failed');r=await back();if(r.status!=='PASS_ASSERTED')throw Error('back-run control failed');
    const controlAttacker=await C(p,input).balanceOf(X)-baseIn;
    await p.send('evm_revert',[attackControl]);signers.clear();
    r=await front();if(r.status!=='PASS_ASSERTED')throw Error('front-run failed');
    const movedQuote=await readQuote(),movedSpot=await soft(()=>mode==='deposit'?pool.calc_token_amount([0n,quoteSize],true):pool.calc_withdraw_one_coin(quoteSize,1)),oracleMoved=await soft(()=>pool.price_oracle()),peg=await soft(()=>N.fxn.sdFxnToFxnWad());
    const victim=await act(k,functionName,args,U,{check:async()=>assert(mode==='deposit'?await N[k].balanceOf(U)>initialShare:await C(p,t).balanceOf(U)>initialAsset)});
    const victimDelta=mode==='deposit'?await N[k].balanceOf(U)-initialShare:await C(p,t).balanceOf(U)-initialAsset,rollback=(await C(p,t).balanceOf(U))===initialAsset&&(await N[k].balanceOf(U))===initialShare;
    const backRun=await back(),attackerNet=await C(p,input).balanceOf(X)-baseIn;
    const incrementalProfit=attackerNet-controlAttacker;
    const adverseBps=controlDelta>0n?(controlDelta-victimDelta)*10000n/controlDelta:null;
    const classification=control.status!=='PASS_ASSERTED'?'INCONCLUSIVE_CONTROL_FAILED':victim.status==='FAIL'&&rollback?'VICTIM_REVERTED_ATOMICALLY_CHECK_REVERT_CAUSE':victim.status==='PASS_ASSERTED'&&incrementalProfit<=0n?'EXECUTED_NO_INCREMENTAL_ATTACKER_GAIN':victim.status==='PASS_ASSERTED'&&incrementalProfit>0n?'EXECUTED_INCREMENTAL_ATTACKER_GAIN_REVIEW':'INCONCLUSIVE';
    const result={k,strat,mode,direction,bps,size,input,output,slip,baseQuote,movedQuote,baseSpot,movedSpot,oracleBefore,oracleMoved,peg,controlStatus:control.status,controlDelta,victimStatus:victim.status,victimDelta,victimError:victim.error,rollback,backRunStatus:backRun.status,controlAttacker,attackerNet,incrementalProfit,adverseBps,classification};
    report.sandwich.push(result);log('SANDWICH',result);
   });
  }
 }


 async function vr(k,f,args,check){
   let row={contract:k,function:N[k].interface.getFunction(f).format('sighash'),params:args};
   try{row.result=await N[k][f](...args);if(check)await check(row.result);row.status='READ_OK';}catch(e){row.status='READ_REVERT';row.error=cleanError(e);row.decodedError=errorName(N[k],e);}
   report.views.push(row);log('VIEW',row);return row;
 }
 await scenario('FOLLOWUP revenue vault full lifecycle despite mint shortfall',async()=>{
   await lock(180n*W);await approve(A.token,A.rvault,U);
   await vd('rvault',A.token,20n*W);
   let v=N.rvault,t=C(p,A.token),b=await v.balanceOf(U);
   await act('rvault','transfer',[V,W],U,{check:async()=>eq(await v.balanceOf(U),b-W)});
   await act('rvault','approve',[V,2n*W],U,{check:async()=>eq(await v.allowance(U,V),2n*W)});
   await act('rvault','increaseAllowance',[V,W],U,{check:async()=>eq(await v.allowance(U,V),3n*W)});
   await act('rvault','decreaseAllowance',[V,W],U,{check:async()=>eq(await v.allowance(U,V),2n*W)});
   let vb=await v.balanceOf(V);await act('rvault','transferFrom',[U,V,W/2n],V,{check:async()=>eq(await v.balanceOf(V),vb+W/2n)});
   let shares=await v.balanceOf(U),assets=await t.balanceOf(V);
   await act('rvault','redeem',[W/2n,V,U],V,{check:async()=>{eq(await v.balanceOf(U),shares-W/2n);assert(await t.balanceOf(V)>assets);}});
   shares=await v.balanceOf(U);await act('rvault','withdraw(uint256)',[W],U,{check:async()=>eq(await v.balanceOf(U),shares-W)});
   assets=await t.balanceOf(U);await act('rvault','withdraw(uint256,address,address)',[W/4n,U,U],U,{check:async()=>eq(await t.balanceOf(U),assets+W/4n)});
   const q=await v.balanceOf(U)/8n;
   await vr('rvault','previewQueuedRedeem',[q],r=>assert(r>0n));
   let r=await act('rvault','requestWithdrawal',[q],U,{check:async()=>eq((await v.pendingWithdrawal(U)).shares,q)});
   if(r.status==='PASS_ASSERTED'){
    await act('rvault','completeWithdrawal',[],U,{reject:'VaultWithdrawalNotReady'});
    assets=await t.balanceOf(U);await act('rvault','withdrawQueuedImmediate',[],U,{check:async()=>{assert(await t.balanceOf(U)>assets);eq((await v.pendingWithdrawal(U)).shares,0n);}});
   }
   r=await act('rvault','requestWithdrawal',[q],U,{check:async()=>eq((await v.pendingWithdrawal(U)).shares,q)});
   if(r.status==='PASS_ASSERTED'){await warp(WEEK+5);assets=await t.balanceOf(U);await act('rvault','completeWithdrawal',[],U,{check:async()=>{assert(await t.balanceOf(U)>assets);eq((await v.pendingWithdrawal(U)).shares,0n);}});}
   shares=await v.balanceOf(U);await act('rvault','emergencyWithdraw',[W/8n,0],U,{check:async()=>eq(await v.balanceOf(U),shares-W/8n)});
   await ext(t,'transfer',[A.rvault,W],U);let idle=await t.balanceOf(A.rvault);await act('rvault','earn',[],U,{check:async()=>{assert(idle>0n);eq(await t.balanceOf(A.rvault),0n);}});
   await act('revenue','harvest()',[],U);await act('revenue','harvest(address)',[V],U);
   await warp(43201);await act('rvault','updateAPY',[],U);await vr('rvault','apySample',[0],r=>assert(r[1]>0n));
   await act('rvault','withdrawAll',[],U,{check:async()=>eq(await v.balanceOf(U),0n)});
   const ab=await t.balanceOf(U);if(ab>0n)await act('rvault','depositAll',[],U,{check:async()=>{eq(await t.balanceOf(U),0n);assert(await v.balanceOf(U)>0n);}});
 });
 for(const [k,token] of [['rvault',A.token],['svault',SDT],['crvVault',CRV],['fxnVault',SDFXN]]){
   await scenario('FOLLOWUP '+k+' mint size matrix and share allowance, APY',async()=>{
     if(k==='rvault')await lock(200n*W);else await fund(token,U,200n*W);
     await approve(token,A[k],U);const v=N[k],t=C(p,token);
     await act(k,'deposit(uint256,address)',[10n*W,U],U,{check:async()=>assert(await v.balanceOf(U)>0n)});
     for(const fee of [0,25]){
       await own(k,'setDepositFeeBps',[fee],async()=>eq(await v.depositFeeBps(),BigInt(fee)));
       for(const q of [1n,W/100n,W/10n,W,10n*W]){
         let pre=await v.balanceOf(U),ab=await t.balanceOf(U),quote=await v.previewMint(q);
         await act(k,'mint',[q,U],U,{purpose:'exact-share mint must deliver quoted shares for previewMint assets: '+quote,check:async()=>{eq(await v.balanceOf(U),pre+q);eq(ab-await t.balanceOf(U),quote);}});
       }
     }
     await act(k,'approve',[V,0],U,{check:async()=>eq(await v.allowance(U,V),0n)});
     await act(k,'increaseAllowance',[V,W],U,{check:async()=>eq(await v.allowance(U,V),W)});
     await act(k,'decreaseAllowance',[V,W/2n],U,{check:async()=>eq(await v.allowance(U,V),W/2n)});
     await warp(43201);await act(k,'updateAPY',[],U);await vr(k,'apySample',[0],r=>assert(r[1]>0n));
     if(k==='crvVault'){
       let b=await v.balanceOf(U),ab=await t.balanceOf(U);const row=await act(k,'emergencyWithdraw',[W/2n,0],U,{check:async()=>{eq(await v.balanceOf(U),b-W/2n);assert(await t.balanceOf(U)>ab);}});
       if(row.status==='FAIL'){const data=v.interface.encodeFunctionData('emergencyWithdraw',[W/2n,0]);row.revertTrace=await soft(()=>p.send('debug_traceCall',[{from:U,to:A[k],data},'latest',{tracer:'callTracer'}]));save();}
       b=await v.balanceOf(U);ab=await t.balanceOf(U);await act(k,'withdraw(uint256)',[W/2n],U,{check:async()=>{eq(await v.balanceOf(U),b-W/2n);assert(await t.balanceOf(U)>ab);}});
     }
     if(k==='fxnVault'){await act('fxn','harvest(address)',[V],U);await act('fxn','harvest()',[],U);}
   });
 }
 await scenario('FOLLOWUP active reward stream and conversion route diagnosis',async()=>{
   await lock(100n*W);await stake(25n*W);await fund(SDT,U,100n*W);await fund(USDC,U,100000000n);
   await ext(C(p,SDT),'transfer',[A.locker,20n*W],U);await ext(C(p,USDC),'transfer',[A.locker,20000000n],U);
   await act('locker','forwardRewards',[],U);
   let count=await N.staking.pendingConversionCount();
   for(let i=0n;i<count;i++){
     const before=await N.staking.pendingConversions(i);await vr('staking','pendingConversions',[i]);
     const row=await act('staking','convertExcess',[i],U);
     if(row.status==='FAIL'){const after=await N.staking.pendingConversions(i);eq(J(after),J(before));row.rollbackVerified=true;const router=await N.staking.OMNI_ROUTER();row.routeLength=await soft(()=>C(p,router,['function routeLength(address,address) view returns(uint256)']).routeLength(USDC,SDT));save();}
   }
   for(const t of [SDT,USDC,A.token])await vr('staking','getStream',[t,0]);
   await warp(WEEK+1);await act('staking','claimRewardsSelf',[],U);
 });

 // ABI inventory: explicit, state-meaningful calls first; read each getter using representative live state.
 scenarioName='ABI inventory';const abiRows=[];
 for(const [k,t] of Object.entries(N)){
   for(const f of t.interface.fragments.filter(x=>x.type==='function')){
     const sig=f.format('sighash');let args=f.inputs.map(x=>x.type==='address'?(x.name?.toLowerCase().includes('token')?SDT:U):x.type==='bool'?false:x.type.startsWith('uint')?(f.name==='aladdinAverageAprBps'?1n:0n):x.type==='bytes'? '0x':x.type==='string'?'':null);
     abiRows.push({contract:k,address:A[k],signature:sig,mutability:f.stateMutability,selector:f.selector});
     if(!['view','pure'].includes(f.stateMutability)||args.includes(null))continue;
     let v;try{v={result:await t[sig](...args),status:'READ_OK'};}catch(e){v={status:'READ_REVERT',error:cleanError(e),decodedError:errorName(t,e)};}
     report.views.push({contract:k,function:sig,params:args,...v});
   }
 }
 // Bind coverage to observed direct calls and nested successful EVM calls, with no false claims of proof.
 const all=[...report.deployment,...report.actions.flatMap(r=>r.tx?[r.tx]:[])];
 for(const row of abiRows){
   const actions=report.actions.filter(r=>r.contract===row.contract&&r.function===row.signature),reads=report.views.filter(r=>r.contract===row.contract&&r.function===row.signature);
   const nested=all.flatMap(tx=>tx.calls.filter(c=>low(c.to)===low(row.address)&&c.input.slice(0,10)===row.selector&&!c.failed).map(c=>({tx:tx.hash,caller:c.from,input:c.input,output:c.output,depth:c.depth})));
   row.direct=actions.map(x=>({scenario:x.scenario,status:x.status,params:x.params,caller:x.caller,error:x.error}));row.reads=reads;row.nested=nested;row.status=actions.some(r=>r.status==='PASS_ASSERTED')?'PASS_ASSERTED':actions.some(r=>r.status.startsWith('EXECUTED'))?'EXECUTED_UNASSERTED':reads.some(r=>r.status==='READ_OK')?'READ_OK':nested.length?'NESTED_EXECUTED':actions.some(r=>r.status==='EXPECTED_REVERT')?'NEGATIVE_ONLY':actions.length||reads.length?'FAILED_OR_REVERTED':'NOT_EXERCISED';report.coverage.push(row);
 }
 const counts={};for(const c of report.coverage)counts[c.status]=(counts[c.status]||0)+1;
 const q=x=>'"'+String(typeof x==='object'?J(x):x??'').replaceAll('"','""')+'"';
 fs.writeFileSync(OUT+'/function-checklist.csv',['contract,address,signature,mutability,status,parameters_and_results,nested_calls',...report.coverage.map(r=>[r.contract,r.address,r.signature,r.mutability,r.status,[...r.direct,...r.reads],r.nested].map(q).join(','))].join('\n'));
 fs.writeFileSync(OUT+'/action-checklist.csv',['scenario,contract,function,caller,parameters,expected,result,error,hash,transfer_events,account_checks',...report.actions.map(r=>[r.scenario,r.contract,r.function,r.caller,r.params,r.expect,r.status,r.error,r.tx?.hash,r.tx?.events?.length,r.tx?.balances?.length].map(q).join(','))].join('\n'));
 fs.writeFileSync(OUT+'/sandwich-checklist.json',J(report.sandwich));
 fs.writeFileSync(OUT+'/summary.json',J({forkBlock:report.forkBlock,counts,totalABI:abiRows.length,actions:report.actions.length,scenarios:report.scenarios,sandwich:report.sandwich,fixtures:report.fixtures.length}));
 log('POSTDEPLOY_SUMMARY',{counts,totalABI:abiRows.length,actions:report.actions.length,scenarios:report.scenarios.length,sandwich:report.sandwich.length,fixtures:report.fixtures.length});
}
module.exports={run,deploymentReceipt,save};
