'use strict';
// Scoped round-2 onchain DAI verification. READ-ONLY; never broadcasts transactions.
// Consumes only the existing GitHub Actions RPC and Etherscan secrets.
const fs=require('fs'),crypto=require('crypto');
const ethers=require('ethers');
const path='dai-historical-raw/';
fs.mkdirSync(path,{recursive:true});
const requestId='ee047e2d311043c6fe268f665f881376cc54f5d52daa51130a8273da720d4faa';
const target='0x6b175474e89094c44da98b954eedeac495271d0f';
const frozen=26253174,tag='0x'+frozen.toString(16);
const hash='0x2f25fb08063d74fbdc6eaf56d1482019b6055b07c72c6b14c46d48df1ab7f83f';
const expectedRuntimeSha256='5230b924dad23dab334727ba9d4b62c95a6cd4a48242932f8a2946cef264ab97';
const sourceSha256='457b6121c4a613730251f2f81ae17d27c9c08674696b73d1f5828c623e705ee5';
const round1Sha256='9088df2cab5bf6531ec0f10c1a65882f62dcb206c9dfaa5a18c553a2de93097b';
const runUrl='https://github.com/'+process.env.GITHUB_REPOSITORY+'/actions/runs/'+process.env.GITHUB_RUN_ID;
const sha256=x=>crypto.createHash('sha256').update(x).digest('hex');
const output={schemaVersion:'dai-mainnet-archival-evidence-v2',requestId,campaignId:'live-ethereum-dai-6b175474-r2',sourceSha256,
 previousFixtureRawSha256:round1Sha256,runUrl,runnerCommit:process.env.GITHUB_SHA,
 target,frozenBlock:frozen,expectedBlockHash:hash,expectedRuntimeSha256,
 credentialsPresent:{RPC_ETHEREUM:!!process.env.ETHEREUM_RPC,ETHERSCAN_API_KEY:!!process.env.ETHERSCAN_API_KEY},
 providerTrials:[],observed:{},assertions:[],readOnly:true,successfulRPC:0,failedRPC:0,successfulHistoricalCalls:0,
 roleScan:{complete:false,coveredRanges:[],missingRanges:[],events:[],reconciled:[],receiptChecks:[],errors:[]},errors:[]};
const transcript=[];
const assert=(name,actual,expected,context)=>output.assertions.push({name,pass:actual===expected,actual,expected,context:context||null});
const asText=e=>String(e&&e.message||e).slice(0,900).replaceAll(process.env.ETHEREUM_RPC||'\0','[REDACTED_RPC]').replaceAll(process.env.ETHERSCAN_API_KEY||'\0','[REDACTED_API_KEY]');
const timeoutFetch=async(url,opt={},timeout=14000)=>{const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),timeout);try{return await fetch(url,{...opt,signal:ctl.signal})}finally{clearTimeout(timer)}};
let seq=0;
async function rpc(p,method,params,timeout=14000){
 const record={n:++seq,provider:p.label,method,params,at:new Date().toISOString()};
 try {
  const response=await timeoutFetch(p.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:seq,method,params})},timeout);
  record.httpStatus=response.status;
  const body=await response.json();
  if(body.error)throw Error('JSON-RPC '+JSON.stringify(body.error));
  if(!response.ok)throw Error('HTTP '+response.status);
  if(!Object.prototype.hasOwnProperty.call(body,'result'))throw Error('missing result');
  record.result=body.result;
  transcript.push(record);output.successfulRPC++;
  if(params.some(x=>x===tag)||method==='eth_getLogs')output.successfulHistoricalCalls++;
  return body.result;
 }catch(err){record.error=asText(err);transcript.push(record);output.failedRPC++;throw err}
}
function prefixText(v){return JSON.stringify(v).slice(0,1600)}
const peers=[];
if(process.env.ETHEREUM_RPC)peers.push({label:'configured-RPC_ETHEREUM',url:process.env.ETHEREUM_RPC});
peers.push({label:'public-llamarpc',url:'https://eth.llamarpc.com'});
peers.push({label:'public-drpc',url:'https://eth.drpc.org'});
peers.push({label:'public-blastapi',url:'https://eth-mainnet.public.blastapi.io'});
peers.push({label:'public-cloudflare',url:'https://cloudflare-eth.com'});
const domain={name:'Dai Stablecoin',version:'1',chainId:1,verifyingContract:target};
const coder=ethers.AbiCoder.defaultAbiCoder();
const preimage=coder.encode(['bytes32','bytes32','bytes32','uint256','address'],
 [ethers.id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
 ethers.id('Dai Stablecoin'),ethers.id('1'),1,target]);
const expectedDomain=ethers.keccak256(preimage);
output.eip712={domain,abiEncodedPreimage:preimage,keccak256:expectedDomain,typedDataHash:ethers.TypedDataEncoder.hashDomain(domain)};
assert('independent EIP712 preimage and TypedDataEncoder agree',output.eip712.typedDataHash,expectedDomain);
const iface=new ethers.Interface([
 'function DOMAIN_SEPARATOR() view returns (bytes32)',
 'function wards(address) view returns (uint256)',
 'function totalSupply() view returns (uint256)',
 'function rely(address)', 'function deny(address)'
]);
const selector={rely:iface.getFunction('rely').selector,deny:iface.getFunction('deny').selector};
const topics=Object.fromEntries(Object.entries(selector).map(([k,v])=>[k,'0x'+v.slice(2).padEnd(64,'0')]));
output.roleScan.topics=topics;
async function tryExplorer(){
 const explorer={provider:'Blockscout Ethereum v2 public indexed address',path:'/api/v2/addresses/'+target,attempted:true};
 try{
  const url='https://eth.blockscout.com/api/v2/addresses/'+target;
  const res=await timeoutFetch(url,{headers:{accept:'application/json'}},18000);
  explorer.httpStatus=res.status;
  const j=await res.json();
  explorer.fields={creator_address_hash:j.creator_address_hash||j.creator_address?.hash||null,creation_tx_hash:j.creation_tx_hash||null,creation_block:j.creation_block||null,is_verified:j.is_verified||null};
  output.creationLookup=explorer;
 }catch(e){explorer.error=asText(e);output.creationLookup=explorer}
 if(process.env.ETHERSCAN_API_KEY){
  const r={provider:'Etherscan v2',action:'getcontractcreation',attempted:true};
  try{
   const u=new URL('https://api.etherscan.io/v2/api');
   for(const [key,val] of Object.entries({chainid:'1',module:'contract',action:'getcontractcreation',contractaddresses:target,apikey:process.env.ETHERSCAN_API_KEY}))u.searchParams.set(key,val);
   const res=await timeoutFetch(u.toString(),{},18000),j=await res.json();
   r.httpStatus=res.status;r.status=j.status;r.message=j.message;
   r.result=j.status==='1'?j.result:j.result;
   output.etherscanCreationLookup=r;
  }catch(e){r.error=asText(e);output.etherscanCreationLookup=r}
 }else output.etherscanCreationLookup={attempted:false,reason:'existing ETHERSCAN_API_KEY is absent; no new secret added'};
}
async function main(){
 await tryExplorer();
 let chainPeer=null,archivePeer=null,readCodePeer=null;
 for(const p of peers){
  const trial={provider:p.label,attempts:[],acceptedAsArchive:false};
  output.providerTrials.push(trial);
  try{
   const id=await rpc(p,'eth_chainId',[]);trial.attempts.push({method:'eth_chainId',result:id});
   assert(p.label+' chainId',id,'0x1');
   if(BigInt(id)!==1n)continue;
   const block=await rpc(p,'eth_getBlockByNumber',[tag,false]);
   trial.attempts.push({method:'eth_getBlockByNumber',resultHash:block&&block.hash||null});
   assert(p.label+' pinned block hash',block&&block.hash&&block.hash.toLowerCase(),hash);
   if(!block||block.hash.toLowerCase()!==hash)continue;
   chainPeer=chainPeer||p;
   try{
    const code=await rpc(p,'eth_getCode',[target,tag]);
    const got=sha256(Buffer.from((code||'0x').slice(2),'hex'));
    trial.codeSha256=got;
    assert(p.label+' deployed runtime matches accepted source',got,expectedRuntimeSha256);
    if(got===expectedRuntimeSha256){readCodePeer=p;output.observed.runtime={provider:p.label,sha256:got,blockHash:block.hash}};
   }catch(e){trial.codeError=asText(e)}
   try {
    const raw=await rpc(p,'eth_call',[{to:target,data:iface.encodeFunctionData('DOMAIN_SEPARATOR',[])},tag]);
    if(typeof raw!=='string'||!/^(0x)[0-9a-fA-F]{64}$/.test(raw))throw Error('historical DOMAIN_SEPARATOR returned non-32-byte response');
    const stored=iface.decodeFunctionResult('DOMAIN_SEPARATOR',raw)[0];
    output.observed.domain={provider:p.label,blockHash:block.hash,calldata:iface.encodeFunctionData('DOMAIN_SEPARATOR',[]),raw,stored,expected:expectedDomain,equal:stored.toLowerCase()===expectedDomain.toLowerCase()};
    assert(p.label+' deployed DOMAIN_SEPARATOR equals EIP712 chain 1',stored.toLowerCase(),expectedDomain.toLowerCase());
    trial.acceptedAsArchive=true;archivePeer=p;break;
   }catch(e){trial.historicalCallError=asText(e)}
  }catch(e){trial.error=asText(e)}
 }
 if(!chainPeer){output.errors.push('No endpoint independently confirmed chainId and exact block hash');return}
 if(!archivePeer){
  output.errors.push('None of the existing/public alternative endpoints supplied a valid historical DOMAIN_SEPARATOR eth_call');
 }else{
  try {
   const raw=await rpc(archivePeer,'eth_call',[{to:target,data:iface.encodeFunctionData('totalSupply',[])},tag]);
   const supply=iface.decodeFunctionResult('totalSupply',raw)[0];
   output.observed.supply={provider:archivePeer.label,blockTag:tag,raw,rawBaseUnits:supply.toString(),decimals:18,wholeDai:ethers.formatUnits(supply,18)};
   assert('historical totalSupply raw is nonnegative',supply>=0n,true);
  }catch(e){output.observed.supplyError=asText(e)}
 }
 const creatorA=output.creationLookup?.fields?.creator_address_hash;
 const creatorB=output.etherscanCreationLookup?.result?.[0]?.contractCreator;
 const transactionHash=output.creationLookup?.fields?.creation_tx_hash||output.etherscanCreationLookup?.result?.[0]?.txHash||null;
 const creator=creatorB||creatorA||null;
 output.creation={creator,transactionHash,authenticatedByReceipt:false,indexerOnly:!!creator};
 if(creatorA&&creatorB)assert('independent explorer creators agree',creatorA.toLowerCase(),creatorB.toLowerCase());
 if(transactionHash){
  try {
   const tx=await rpc(chainPeer,'eth_getTransactionByHash',[transactionHash]);
   const receipt=await rpc(chainPeer,'eth_getTransactionReceipt',[transactionHash]);
   output.creation.transaction=tx?{hash:tx.hash,from:tx.from,to:tx.to,input:tx.input,blockNumber:tx.blockNumber}:null;
   output.creation.receipt=receipt?{status:receipt.status,contractAddress:receipt.contractAddress,blockNumber:receipt.blockNumber,transactionIndex:receipt.transactionIndex}:null;
   if(tx&&receipt){
    assert('verified creation receipt status',receipt.status,'0x1');
    assert('verified creation contract address',String(receipt.contractAddress).toLowerCase(),target);
    assert('verified creation sender agrees with indexer',String(tx.from).toLowerCase(),String(creator).toLowerCase());
    output.creation.authenticatedByReceipt=receipt.status==='0x1'&&String(receipt.contractAddress).toLowerCase()===target&&String(tx.from).toLowerCase()===String(creator).toLowerCase();
   }
  }catch(e){output.creation.receiptLookupError=asText(e)}
 }
 const scanPeer=archivePeer||readCodePeer||chainPeer;
 const firstBlock=output.creation.receipt&&output.creation.receipt.blockNumber?Number(BigInt(output.creation.receipt.blockNumber)):0;
 output.roleScan.scanProvider=scanPeer.label;output.roleScan.startBlock=firstBlock;
 output.roleScan.endBlock=frozen;
 const end=Date.now()+12*60*1000;
 let from=firstBlock,chunk=30000,ops=0;
 const all=[];
 while(from<=frozen&&ops<850&&Date.now()<end){
  const to=Math.min(frozen,from+chunk-1),filter={address:target,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[[topics.rely,topics.deny]]};
  ops++;
  try{
   const logs=await rpc(scanPeer,'eth_getLogs',[filter],28000);
   if(!Array.isArray(logs))throw Error('non-array log response');
   output.roleScan.coveredRanges.push({from,to,count:logs.length,provider:scanPeer.label});
   for(const l of logs)all.push(l);
   from=to+1;
   if(chunk<70000&&logs.length<30)chunk=Math.min(70000,chunk+2500);
  }catch(e){
   if(chunk>2000){chunk=Math.max(2000,Math.floor(chunk/2));continue}
   output.roleScan.errors.push({from,to,error:asText(e)});
   break;
  }
 }
 output.roleScan.rangeRequests=ops;
 if(from<=frozen)output.roleScan.missingRanges.push({from,to:frozen,reason:'provider limit, RPC error or finite 12-minute scan budget'});
 output.roleScan.complete=from>frozen&&output.roleScan.missingRanges.length===0;
 const keyed=new Map();
 for(const l of all){
  const tt=l.topics||[];
  if(tt.length!==4)continue;
  const op=String(tt[0]).toLowerCase()===topics.rely.toLowerCase()?'rely':String(tt[0]).toLowerCase()===topics.deny.toLowerCase()?'deny':null;
  if(!op)continue;
  const guy=ethers.getAddress('0x'+String(tt[2]).slice(-40));
  const caller=ethers.getAddress('0x'+String(tt[1]).slice(-40));
  const row={operation:op,guy,caller,blockNumber:Number(BigInt(l.blockNumber)),transactionIndex:Number(BigInt(l.transactionIndex)),logIndex:Number(BigInt(l.logIndex)),transactionHash:l.transactionHash,topics:tt,data:l.data};
  keyed.set(String(l.transactionHash)+':'+String(l.logIndex),row);
 }
 const events=[...keyed.values()].sort((a,b)=>a.blockNumber-b.blockNumber||a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex);
 output.roleScan.events=events;
 const effective=new Map();
 if(output.creation.authenticatedByReceipt&&creator)effective.set(ethers.getAddress(creator).toLowerCase(),1);
 for(const e of events)effective.set(e.guy.toLowerCase(),e.operation==='rely'?1:0);
 output.roleScan.computedEffectiveWards=Object.fromEntries([...effective.entries()].sort());
 const receiptList=[...new Set(events.map(e=>e.transactionHash))].slice(0,150);
 for(const txh of receiptList){
  try{
   const rec=await rpc(scanPeer,'eth_getTransactionReceipt',[txh]);
   const ok=rec&&rec.status==='0x1';
   output.roleScan.receiptChecks.push({hash:txh,status:rec?.status||null,blockHash:rec?.blockHash||null,receiptAvailable:!!rec,success:ok});
  }catch(e){output.roleScan.receiptChecks.push({hash:txh,error:asText(e),success:false})}
 }
 output.roleScan.receiptsComplete=output.roleScan.receiptChecks.length===new Set(events.map(e=>e.transactionHash)).size&&output.roleScan.receiptChecks.every(r=>r.success);
 if(archivePeer){
  const candidates=new Set([...effective.keys()]);
  if(creator)candidates.add(creator.toLowerCase());
  for(const address of candidates){
   try{
    const data=iface.encodeFunctionData('wards',[address]);
    const res=await rpc(archivePeer,'eth_call',[{to:target,data},tag]);
    const actual=BigInt(iface.decodeFunctionResult('wards',res)[0]).toString();
    const predicted=effective.has(address)?String(effective.get(address)):null;
    output.roleScan.reconciled.push({address,calldata:data,raw:res,actual,predicted,agrees:predicted!==null&&actual===predicted});
    if(predicted!==null)assert('historical wards matches replay for '+address,actual,predicted);
   }catch(e){output.roleScan.reconciled.push({address,error:asText(e),agrees:false})}
  }
 }
 output.roleScan.rosterCompletenessProven=output.creation.authenticatedByReceipt&&output.roleScan.complete&&output.roleScan.receiptsComplete&&output.roleScan.reconciled.length>0&&output.roleScan.reconciled.every(r=>r.agrees);
 if(output.roleScan.rosterCompletenessProven)assert('authenticated effective ward reconciliation',true,true);
 output.expectedGovernancePolicy={status:'UNESTABLISHED',reason:'No independently authenticated historic allowed-ward governance roster provided or verified by approved test endpoints. Effective role authority does not itself prove intended operator policy.'};
 if(!output.observed.domain)output.errors.push('Missing pinned archival stored DOMAIN_SEPARATOR');
 if(!output.roleScan.rosterCompletenessProven)output.errors.push('Historical ward roster not proven complete, or creation/receipts/archival ward state lacks authenticated coverage');
 output.errors.push('Approved governance role policy has not been independently established; avoid calling deployment configuration safe');
}
function save(){
 fs.writeFileSync(path+'EXECUTION_v2.json',JSON.stringify(output,null,2)+'\n');
 fs.writeFileSync(path+'RPC_TRANSCRIPT_v2.json',JSON.stringify({schemaVersion:'dai-archival-rpc-transcript-v2',requestId,runUrl,records:transcript},null,2)+'\n');
 fs.writeFileSync(path+'EIP712_PREIMAGE_v2.json',JSON.stringify(output.eip712,null,2)+'\n');
 fs.writeFileSync(path+'SUMMARY_v2.json',JSON.stringify({requestId,runUrl,assertions:output.assertions.length,passed:output.assertions.filter(a=>a.pass).length,failed:output.assertions.filter(a=>!a.pass).length,successfulRPC:output.successfulRPC,failedRPC:output.failedRPC,successfulHistoricalCalls:output.successfulHistoricalCalls,domainMatch:output.observed.domain?.equal??null,rosterComplete:output.roleScan.rosterCompletenessProven??false,governancePolicyProven:false,errors:output.errors},null,2)+'\n');
}
main().catch(e=>{output.errors.push('runner fatal: '+asText(e));process.exitCode=1}).finally(()=>{save();console.log(JSON.stringify({completed:true,runUrl,successfulRPC:output.successfulRPC,failedRPC:output.failedRPC,historical:output.successfulHistoricalCalls,assertions:output.assertions.length,pass:output.assertions.filter(a=>a.pass).length,fail:output.assertions.filter(a=>!a.pass).length,domain:output.observed.domain?.equal??null,roster:output.roleScan.rosterCompletenessProven??false,errors:output.errors}))});
