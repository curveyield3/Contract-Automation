import { createHash } from 'node:crypto';
import { Interface } from 'ethers';
import { digestCanonicalV1 } from './canonical-json-v1.mjs';

const EIP1967={
  implementation:'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin:'0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon:'0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
};
function shaCode(code){ return createHash('sha256').update(Buffer.from(String(code).replace(/^0x/,''),'hex')).digest('hex'); }
function addrFromWord(word){ const hex=String(word??'').replace(/^0x/,'').padStart(64,'0'); return '0x'+hex.slice(-40).toLowerCase(); }
function normAddr(a){ return typeof a==='string'?a.toLowerCase():a; }
function eq(a,b){ return String(a).toLowerCase()===String(b).toLowerCase(); }
function blockTag(n){ return '0x'+Number(n).toString(16); }
function decodeValue(fn,raw){ const iface=new Interface([`function ${fn}`]); const fragment=iface.fragments[0]; const decoded=iface.decodeFunctionResult(fragment,raw); const value=decoded.length===1?decoded[0]:[...decoded]; if(typeof value==='bigint')return value.toString(); return value; }
function encodeCall(fn,args){ const iface=new Interface([`function ${fn}`]); const fragment=iface.fragments[0]; return {data:iface.encodeFunctionData(fragment,args??[]),fragment,iface}; }

async function readSlot(transport,address,slot,blockNumber){ return transport('eth_getStorageAt',[address,slot,blockTag(blockNumber)]); }
async function attestOne(dep,ctx){
  const evidence={label:dep.label,address:dep.address,runtimeCodeSha256:null,proxyEvidence:{kind:dep.proxy?.kind??'NONE',checks:[]},criticalReadEvidence:[],status:'ATTESTED',limitations:[]};
  let code;
  try{ code=await ctx.transport('eth_getCode',[dep.address,blockTag(ctx.blockNumber)]); }catch(error){ evidence.status='UNATTESTABLE'; evidence.limitations.push(`runtime code read failed: ${error.message}`); return evidence; }
  if(!code||code==='0x'){ evidence.status='MISMATCH'; evidence.limitations.push('no runtime code at deployed address'); return evidence; }
  evidence.runtimeCodeSha256=shaCode(code);
  if(dep.expectedRuntimeBytecodeSha256){ if(evidence.runtimeCodeSha256!==dep.expectedRuntimeBytecodeSha256.toLowerCase()){ evidence.status='MISMATCH'; evidence.limitations.push('runtime bytecode hash mismatch'); } }
  else { evidence.status='UNATTESTABLE'; evidence.limitations.push('expected runtime bytecode hash not supplied'); }

  const proxy=dep.proxy??{kind:'NONE'};
  if(proxy.kind!=='NONE'){
    try{
      let impl=null,admin=null,beacon=null;
      if(proxy.kind==='EIP1967'){
        const implSlot=proxy.implementationSlot??EIP1967.implementation; const adminSlot=proxy.adminSlot??EIP1967.admin;
        impl=addrFromWord(await readSlot(ctx.transport,dep.address,implSlot,ctx.blockNumber));
        if(proxy.expectedAdmin) admin=addrFromWord(await readSlot(ctx.transport,dep.address,adminSlot,ctx.blockNumber));
      } else if(proxy.kind==='BEACON'){
        const beaconSlot=proxy.beaconSlot??EIP1967.beacon; beacon=addrFromWord(await readSlot(ctx.transport,dep.address,beaconSlot,ctx.blockNumber));
      } else if(proxy.kind==='CUSTOM_DECLARED'){
        if(proxy.implementationSlot) impl=addrFromWord(await readSlot(ctx.transport,dep.address,proxy.implementationSlot,ctx.blockNumber));
        if(proxy.adminSlot) admin=addrFromWord(await readSlot(ctx.transport,dep.address,proxy.adminSlot,ctx.blockNumber));
        if(proxy.beaconSlot) beacon=addrFromWord(await readSlot(ctx.transport,dep.address,proxy.beaconSlot,ctx.blockNumber));
        if(!proxy.implementationSlot&&!proxy.adminSlot&&!proxy.beaconSlot) throw new Error('custom proxy slots were not declared');
      } else throw new Error(`unsupported proxy kind ${proxy.kind}`);
      evidence.proxyEvidence={kind:proxy.kind,implementation:impl,admin,beacon,checks:[]};
      if(proxy.expectedImplementation&&normAddr(impl)!==normAddr(proxy.expectedImplementation)){ evidence.status='MISMATCH'; evidence.proxyEvidence.checks.push({field:'implementation',status:'MISMATCH',expected:proxy.expectedImplementation,observed:impl}); }
      if(proxy.expectedAdmin&&normAddr(admin)!==normAddr(proxy.expectedAdmin)){ evidence.status='MISMATCH'; evidence.proxyEvidence.checks.push({field:'admin',status:'MISMATCH',expected:proxy.expectedAdmin,observed:admin}); }
      if(impl&&impl!=='0x'+'0'.repeat(40)){
        const implCode=await ctx.transport('eth_getCode',[impl,blockTag(ctx.blockNumber)]); if(!implCode||implCode==='0x'){ evidence.status='MISMATCH'; evidence.proxyEvidence.checks.push({field:'implementationCode',status:'MISMATCH'}); }
      }
    }catch(error){ if(evidence.status!=='MISMATCH') evidence.status='UNATTESTABLE'; evidence.limitations.push(`proxy attestation failed: ${error.message}`); }
  }

  for(const read of dep.criticalReads??[]){
    try{
      const {data}=encodeCall(read.function,read.args??[]); const raw=await ctx.transport('eth_call',[{to:dep.address,data},blockTag(ctx.blockNumber)]); const observed=decodeValue(read.function,raw);
      let pass=false; if(read.comparison==='NONZERO') pass=String(observed)!=='0'&&observed!==false&&observed!==null; else if(read.comparison==='ADDRESS_EQUALS') pass=eq(observed,read.expected); else pass=String(observed)===String(read.expected);
      evidence.criticalReadEvidence.push({function:read.function,args:read.args??[],comparison:read.comparison,expected:read.expected,observed,status:pass?'MATCH':'MISMATCH'});
      if(!pass) evidence.status='MISMATCH';
    }catch(error){ evidence.criticalReadEvidence.push({function:read.function,status:'UNATTESTABLE',error:error.message}); if(evidence.status!=='MISMATCH') evidence.status='UNATTESTABLE'; }
  }
  return evidence;
}

export async function attestLiveDeploymentV1(input,{transport}={}){
  if(typeof transport!=='function') throw new Error('JSON-RPC transport is required');
  let chainId,block;
  try{ chainId=Number(BigInt(await transport('eth_chainId',[]))); block=await transport('eth_getBlockByNumber',[blockTag(input.blockNumber),false]); }
  catch(error){ return {schemaVersion:'audit-v7-live-deployment-attestation-v1',status:'UNATTESTABLE',chain:input.chain,chainId:null,blockNumber:input.blockNumber,blockHash:input.blockHash,deployments:[],mismatchCount:0,unattestableCount:(input.deployments??[]).length,error:{message:error.message}}; }
  if(chainId!==input.expectedChainId||Number(BigInt(block?.number??'0x0'))!==input.blockNumber||!eq(block?.hash,input.blockHash)) return {schemaVersion:'audit-v7-live-deployment-attestation-v1',status:'MISMATCH',chain:input.chain,chainId,blockNumber:input.blockNumber,blockHash:block?.hash??null,deployments:[],mismatchCount:1,unattestableCount:0};
  const deployments=[]; for(const dep of input.deployments??[]) deployments.push(await attestOne(dep,{transport,blockNumber:input.blockNumber}));
  const mismatchCount=deployments.filter(x=>x.status==='MISMATCH').length, unattestableCount=deployments.filter(x=>x.status==='UNATTESTABLE').length;
  const status=mismatchCount?'MISMATCH':unattestableCount?'UNATTESTABLE':'ATTESTED';
  const result={schemaVersion:'audit-v7-live-deployment-attestation-v1',status,chain:input.chain,chainId,blockNumber:input.blockNumber,blockHash:input.blockHash,deployments,mismatchCount,unattestableCount}; result.attestationDigest=digestCanonicalV1(result); return result;
}
