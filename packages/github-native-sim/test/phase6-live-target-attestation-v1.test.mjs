import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPhase6MutableRpcSession,PHASE6_MUTABLE_RPC_ENV} from '../src/phase6-mutable-rpc-v1.mjs';

const upstream='https://archive.example/rpc',local='http://127.0.0.1:18545';
const address='0x6b175474e89094c44da98b954eedeac495271d0f';
const code='0x6001600055',expected=createHash('sha256').update(Buffer.from(code.slice(2),'hex')).digest('hex');
const pin='0x'+'d'.repeat(64),probe='0x000000000000000000000000000000000000bEEF';
function makeFetch({actualCode=code}={}){
  let balance=0n,snapshot=null;
  return async(url,options)=>{
    const body=JSON.parse(options.body);
    let result;
    switch(body.method){
      case 'eth_chainId':result='0x1';break;
      case 'eth_blockNumber':result='0x10';break;
      case 'eth_getBlockByNumber':result={number:body.params[0],hash:pin};break;
      case 'eth_getCode':result=url===local&&body.params[0]===address?actualCode:'0x';break;
      case 'eth_getBalance':result='0x'+balance.toString(16);break;
      case 'evm_snapshot':snapshot=balance;result='0x1';break;
      case 'anvil_setBalance':assert.equal(url,local);assert.equal(body.params[0],probe);balance=BigInt(body.params[1]);result=null;break;
      case 'evm_revert':balance=snapshot;result=true;break;
      default:throw Error('Unexpected RPC '+body.method);
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{status:200});
  };
}
const engine=async()=>({url:local,async close(){}});
const options=(fetchImpl)=>({environment:{[PHASE6_MUTABLE_RPC_ENV]:upstream},fetchImpl,startEngine:engine,
  frozenBlockNumber:16,frozenBlockHash:pin,
  attestedTargets:[{address,runtimeSha256:expected,qualifiedName:'Dai.sol:Dai'}]});

test('live deployed target attestation proves address bytecode, writable fork and state rollback',async()=>{
  const session=await createPhase6MutableRpcSession(options(makeFetch()));
  try{
    assert.equal(session.evidence.status,'PASS');
    assert.equal(session.evidence.deployedTargetAttestation.targets[0].address,address);
    assert.equal(session.evidence.deployedTargetAttestation.targets[0].runtimeSha256,expected);
    assert.equal(session.evidence.deployedTargetAttestation.mutableWriteObserved,true);
    assert.equal(session.evidence.deployedTargetAttestation.snapshotReverted,true);
  }finally{await session.close();}
});

test('live deployed target mismatched runtime code fails closed before tests',async()=>{
  const session=await createPhase6MutableRpcSession(options(makeFetch({actualCode:'0x6000'})));
  assert.equal(session.evidence.status,'FAIL');
  assert.equal(session.evidence.failureKind,'LIVE_FORK_DEPLOYED_CODE_MISMATCH');
});
