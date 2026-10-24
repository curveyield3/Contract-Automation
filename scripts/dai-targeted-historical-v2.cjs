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
const sourceUnit=JSON.parse(fs.readFileSync('process/dai-master-targeted-tests/source-compiler-unit_v1.json','utf8'));
const solc=require('solc');
const sourceInput=JSON.parse(JSON.stringify(sourceUnit.input));
sourceInput.settings.outputSelection={'*':{'*':['evm.deployedBytecode.object']}};
const sourceOutput=JSON.parse(solc.compile(JSON.stringify(sourceInput)));
if(sourceOutput.errors?.some(x=>x.severity==='error'))throw Error('DAI compiler error');
const sourceRuntime='0x'+sourceOutput.contracts['Dai.sol'].Dai.evm.deployedBytecode.object;
const sourceRuntimeSha=crypto.createHash('sha256').update(Buffer.from(sourceRuntime.slice(2),'hex')).digest('hex');
const sourceConstructorSeedsWard=sourceUnit.input.sources['Dai.sol'].content.includes('wards[msg.sender] = 1;');

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
    const sameSource=sourceRuntimeSha===expectedRuntimeSha256;
    const sameExecutable=sameSource&&code.length===sourceRuntime.length&&code.slice(0,-86).toLowerCase()===sourceRuntime.slice(0,-86).toLowerCase();
    output.sourceRuntimeReconciliation={provider:p.label,deployedSha256:got,compiledSha256:sourceRuntimeSha,bytes:(code.length-2)/2,
      metadataSuffixBytes:43,exactByteMatch:code.toLowerCase()===sourceRuntime.toLowerCase(),executablePrefixMatches:sameExecutable};
    assert(p.label+' compile reproduces accepted frozen runtime digest',sourceRuntimeSha,expectedRuntimeSha256);
    assert(p.label+' deployed executable matches accepted source aside from compiler metadata',sameExecutable,true);
    if(sameExecutable){readCodePeer=p;output.observed.runtime={provider:p.label,sha256:got,blockHash:block.hash,sourceExecutableMatch:true}};
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
 const factoryFromBlockscout=output.creationLookup?.fields?.creator_address_hash||null;
 const creationDetails=output.etherscanCreationLookup?.result?.[0]||{};
 const factoryFromEtherscan=creationDetails.contractFactory||null;
 const originEOA=creationDetails.contractCreator||null;
 const transactionHash=output.creationLookup?.fields?.creation_tx_hash||creationDetails.txHash||null;
 const factory=factoryFromBlockscout||factoryFromEtherscan||null;
 output.creation={factory,originEOA,transactionHash,authenticatedByReceipt:false,creationBlockAuthenticated:false,initialFactoryWardProven:false};
 if(factoryFromBlockscout&&factoryFromEtherscan)
  assert('independent factory identities agree',factoryFromBlockscout.toLowerCase(),factoryFromEtherscan.toLowerCase());
 if(transactionHash){
  try {
   const tx=await rpc(chainPeer,'eth_getTransactionByHash',[transactionHash]);
   const receipt=await rpc(chainPeer,'eth_getTransactionReceipt',[transactionHash]);
   output.creation.transaction=tx?{hash:tx.hash,from:tx.from,to:tx.to,input:tx.input,blockNumber:tx.blockNumber}:null;
   output.creation.receipt=receipt?{status:receipt.status,contractAddress:receipt.contractAddress,blockNumber:receipt.blockNumber,transactionIndex:receipt.transactionIndex}:null;
   if(tx&&receipt){
    assert('deployment parent transaction success',receipt.status,'0x1');
    if(originEOA)assert('parent transaction EOA matches Etherscan initiator',String(tx.from).toLowerCase(),String(originEOA).toLowerCase());
    // The DAI contract was created internally by a factory: a null receipt.contractAddress on the parent tx is normal.
    output.creation.parentReceiptVerified=receipt.status==='0x1'&&(!originEOA||String(tx.from).toLowerCase()===String(originEOA).toLowerCase());
    const blockNum=Number(BigInt(receipt.blockNumber));
    try{
     const before=await rpc(chainPeer,'eth_getCode',[target,'0x'+(blockNum-1).toString(16)]);
     const after=await rpc(chainPeer,'eth_getCode',[target,'0x'+blockNum.toString(16)]);
     output.creation.blockCodeTransition={blockNumber:blockNum,beforeSha256:sha256(Buffer.from(before.slice(2),'hex')),afterSha256:sha256(Buffer.from(after.slice(2),'hex')),emptyBefore:before==='0x',codeAfter:after!=='0x'};
     assert('DAI contract code appears at indexed creation block',before==='0x'&&after!=='0x',true);
     output.creation.creationBlockAuthenticated=before==='0x'&&after!=='0x'&&output.creation.parentReceiptVerified;
    }catch(e){output.creation.creationBlockError=asText(e)}
    if(factory){
     try{
      const data=iface.encodeFunctionData('wards',[factory]);
      const raw=await rpc(chainPeer,'eth_call',[{to:target,data},'0x'+blockNum.toString(16)]);
      const ward=BigInt(iface.decodeFunctionResult('wards',raw)[0]).toString();
      output.creation.initialFactoryWard={factory,data,raw,ward,blockNumber:blockNum};
      // Getter is post-transaction; a same-tx self-deny returns zero here.
      output.creation.creationBlockFactoryWard=ward;
     }catch(e){output.creation.initialWardError=asText(e)}
    }
   }
  }catch(e){output.creation.receiptLookupError=asText(e)}
  // Independent index of internal contract-creation traces, if supported; no blockchain writes.
  try{
   const url='https://eth.blockscout.com/api/v2/transactions/'+transactionHash+'/internal-transactions';
   const response=await timeoutFetch(url,{headers:{accept:'application/json'}},18000);
   const body=await response.json();
   const rows=Array.isArray(body.items)?body.items:[];
   const matching=rows.filter(x=>[x.created_contract?.hash,x.created_contract_addr_hash,x.to?.hash,x.to_address_hash].some(v=>String(v||'').toLowerCase()===target));
   output.creation.indexedInternalCreation={provider:'Blockscout v2',httpStatus:response.status,pages:(body.next_page_params?'>1':'1'),matching,returnedRows:rows.length,allPagesFetched:!body.next_page_params};
  }catch(e){output.creation.indexedInternalCreation={error:asText(e)}}
 }
 const scanPeer=archivePeer||readCodePeer||chainPeer;
 const firstBlock=output.creation.receipt&&output.creation.receipt.blockNumber?Number(BigInt(output.creation.receipt.blockNumber)):0;
 output.roleScan.scanProvider=process.env.ETHERSCAN_API_KEY?'Etherscan v2 indexed archival logs':scanPeer.label;
 output.roleScan.startBlock=firstBlock;output.roleScan.endBlock=frozen;
 const all=[];
 let ops=0;
 if(process.env.ETHERSCAN_API_KEY){
  const deadline=Date.now()+13*60*1000;
  for(const [operation,topic0] of Object.entries(topics)){
   let from=firstBlock,chunk=20000000;
   while(from<=frozen && ops<1200 && Date.now()<deadline){
    const to=Math.min(frozen,from+chunk-1),pages=[];
    let page=1,ok=true,tooMany=false,err=null;
    while(page<=25 && Date.now()<deadline){
     ops++;
     const request={chainid:'1',module:'logs',action:'getLogs',fromBlock:String(from),toBlock:String(to),address:target,topic0,page:String(page),offset:'1000',apikey:process.env.ETHERSCAN_API_KEY};
     const u=new URL('https://api.etherscan.io/v2/api');
     for(const [k,v] of Object.entries(request))u.searchParams.set(k,v);
     const rec={index:ops,provider:'Etherscan v2',method:'getLogs',operation,topic0,fromBlock:from,toBlock:to,page,offset:1000};
     try{
      const res=await timeoutFetch(u.toString(),{headers:{accept:'application/json'}},30000);
      rec.httpStatus=res.status;
      const body=await res.json();
      rec.status=body.status;rec.message=body.message;
      const noRecords=body.status==='0'&&String(body.result)===''||body.status==='0'&&/no records found/i.test(String(body.message));
      if(!res.ok || (body.status!=='1'&&!noRecords) || (body.status==='1'&&!Array.isArray(body.result))){
       throw Error('API response '+JSON.stringify({status:body.status,message:body.message,result:String(body.result).slice(0,250)}));
      }
      const rows=Array.isArray(body.result)?body.result:[];
      rec.count=rows.length;rec.results=rows;
      transcript.push(rec);output.successfulRPC++;output.successfulHistoricalCalls++;
      pages.push(...rows);
      if(rows.length<1000)break;
      page++;
      if(page>25){tooMany=true;break}
     }catch(e){
      rec.error=asText(e);transcript.push(rec);output.failedRPC++;ok=false;err=rec.error;break;
     }
    }
    if(ok&&!tooMany){
     output.roleScan.coveredRanges.push({from,to,count:pages.length,provider:'Etherscan v2',topic:operation});
     all.push(...pages);
     from=to+1;
    }else if(chunk>5000){
     chunk=Math.max(5000,Math.floor(chunk/2));
     output.roleScan.errors.push({operation,from,to,reason:'range reduced on indexed provider error',error:err});
    }else{
     output.roleScan.errors.push({operation,from,to,error:err||'max pagination reached'});
     break;
    }
   }
   if(from<=frozen)output.roleScan.missingRanges.push({operation,from,to:frozen,reason:'indexed provider limit, refusal or bounded scan budget'});
  }
  output.roleScan.indexedEvidenceProvider='Etherscan API v2, signed Ethereum mainnet chainid 1';
  output.roleScan.indexerCompletenessLimit='Availability of records from external indexer is independently checked by creation block state, receipts and final wards reads';
 }else{
  output.roleScan.errors.push({error:'ETHERSCAN_API_KEY missing; public RPC log fallback used'});
  let from=firstBlock,chunk=9500;
  const deadline=Date.now()+8*60*1000;
  while(from<=frozen&&ops<850&&Date.now()<deadline){
   const to=Math.min(frozen,from+chunk-1);
   ops++;
   try{
    const logs=await rpc(scanPeer,'eth_getLogs',[{address:target,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[[topics.rely,topics.deny]]}],18000);
    if(!Array.isArray(logs))throw Error('non-array role logs');
    output.roleScan.coveredRanges.push({from,to,count:logs.length,provider:scanPeer.label,topic:'OR'});
    all.push(...logs);from=to+1;
   }catch(e){output.roleScan.errors.push({from,to,error:asText(e)});break}
  }
  if(from<=frozen)output.roleScan.missingRanges.push({from,to:frozen,reason:'RPC limit or bounded historical scan budget'});
 }
 output.roleScan.rangeRequests=ops;
 output.roleScan.complete=output.roleScan.missingRanges.length===0 && output.roleScan.coveredRanges.length>0;
 if(all.length===0){output.roleScan.complete=false;output.roleScan.errors.push({reason:'zero historic role logs is implausible without independent source receipts confirming no role actions; do not accept completeness'});}
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
 if(output.creation.initialFactoryWardProven&&output.creation.factory)effective.set(ethers.getAddress(output.creation.factory).toLowerCase(),1);
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
 // The initial factory ward is authorized within the constructor, but the
 // factory grants a new ward and denies itself in the SAME creation transaction.
 // Source-grounded positive proof is the receipt-successful authenticated rely
 // by that factory before its self-deny, not a post-transaction getter of 1.
 const first=events[0]||null;
 const factoryLower=String(output.creation.factory||'').toLowerCase();
 const firstAuthenticated=Boolean(sourceConstructorSeedsWard&&output.creation.creationBlockAuthenticated&&
   first?.operation==='rely'&&first.caller.toLowerCase()===factoryLower&&
   first.transactionHash===output.creation.transactionHash&&
   output.roleScan.receiptChecks.some(r=>r.hash===first.transactionHash&&r.success));
 const ownDeny=events.some(e=>e.operation==='deny'&&e.guy.toLowerCase()===factoryLower&&
   e.caller.toLowerCase()===factoryLower&&e.transactionHash===output.creation.transactionHash&&
   e.logIndex>first?.logIndex);
 const postTransactionZero=output.creation.creationBlockFactoryWard==='0';
 output.creation.factoryAuthorizationSequence={constructorSeedsWard:sourceConstructorSeedsWard,
   firstSuccessfulAuthByFactory:firstAuthenticated,orderedFactorySelfDeny:ownDeny,
   postCreationBlockWardZero:postTransactionZero};
 output.creation.initialFactoryWardProven=firstAuthenticated&&ownDeny&&postTransactionZero&&output.roleScan.receiptsComplete;
 assert('constructor factory authorization and same-transaction self-deny established',output.creation.initialFactoryWardProven,true);

 if(archivePeer){
  const candidates=new Set([...effective.keys()]);
  if(output.creation.factory)candidates.add(output.creation.factory.toLowerCase());
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
 output.roleScan.rosterCompletenessProven=output.creation.initialFactoryWardProven&&output.roleScan.complete&&output.roleScan.receiptsComplete&&output.roleScan.reconciled.length>0&&output.roleScan.reconciled.every(r=>r.agrees);
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
