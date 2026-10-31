#!/usr/bin/env node
// Read-only historical on-chain witness, never a test, transaction or simulation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Interface} from 'ethers';

const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const root=path.resolve(process.env.AUDIT_CONTROLLER_ROOT??'.audit-controller');
const rpc=process.env.RPC_ETHEREUM;
if(!rpc)throw Error('APC_ARCHIVE_RPC_UNAVAILABLE');
if(!/^audit-preview-[a-z0-9.-]+-r[0-9]+$/.test(request.previewCampaignId??''))throw Error('APC_BAD_PREVIEW_ID');
const slug=request.previewCampaignId.replace(/-r[0-9]+$/,'');
const corrective=request.correctionOfCampaignId??null;
if(corrective!==null&&corrective!=='audit-preview-completion-live-ethereum-dai-6b175474-r1')
 throw Error('APC_CORRECTION_PARENT_NOT_AUTHORIZED');
const completionSlug='audit-preview-completion-'+slug.slice('audit-preview-'.length)+(corrective?'-corrective':'');

const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const entry=read('Audit Campaign Directory/campaigns/'+completionSlug+'.json');
const dest=entry.workspacePath;
if(typeof dest!=='string'||!dest.startsWith('campaigns/')||dest.split('/').includes('..'))throw Error('APC_DESTINATION_INVALID');
if(entry.campaignStatus==='ACTIVE'&&entry.previewCompletion?.status==='LAUNCHED'){
 console.log(JSON.stringify({status:'ALREADY_LAUNCHED',campaignId:entry.campaignId}));
 process.exit(0);
}
if(entry.campaignStatus!=='STAGED_PRELAUNCH'||entry.previewCompletion?.originalCampaignId!==request.previewCampaignId||String(entry.correctionOf?.campaignId??'')!==String(corrective??''))
 throw Error('APC_NOT_STAGED');
const original=entry.previewCompletion.originalWorkspacePath;
const source=read(original+'/source/live-scan-project/scan-source-manifest.json');
if(source.inputMode!=='LIVE_SCAN'||!source.frozenBlock?.hash||!Number.isInteger(source.frozenBlock.number)
 ||!Array.isArray(source.resolvedTargets)||!source.resolvedTargets.length)throw Error('APC_UNSUPPORTED_NONSCAN_SOURCE');
const block=source.frozenBlock.number,tag='0x'+block.toString(16);
const addressRe=/^0x[0-9a-fA-F]{40}$/;
const errors=[];
const evidence={schemaVersion:'audit-preview-completion-readonly-chain-v1',status:'INCOMPLETE',
  campaignId:entry.campaignId,sourcePreviewCampaignId:request.previewCampaignId,
  sourceSha256:entry.sourceSha256,chainId:source.chainId,blockNumber:block,blockHash:source.frozenBlock.hash,
  networkVerification:null,runtimeChecks:[],readOnlyChecks:[],wardReads:[],
  limitations:[],recordedAt:new Date().toISOString()};
let counter=0;
async function call(method,params){
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),20000);
 try {
  const reply=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:++counter,method,params}),signal:controller.signal});
  if(!reply.ok)throw Error('RPC_HTTP_'+reply.status);
  const json=await reply.json();
  if(json.error)throw Error('RPC_ERROR_'+json.error.code+':'+String(json.error.message).slice(0,160));
  if(json.result===undefined||json.result===null)throw Error('RPC_NULL_RESULT_'+method);
  return json.result;
 } finally {clearTimeout(timeout);}
}
const uintHex=v=>BigInt(v).toString();
const normalized=s=>String(s).toLowerCase();
const verifiedAbi=[
 'function decimals() view returns (uint8)',
 'function totalSupply() view returns (uint256)',
 'function DOMAIN_SEPARATOR() view returns (bytes32)',
 'function PERMIT_TYPEHASH() view returns (bytes32)',
 'function wards(address) view returns (uint256)'
];
const iface=new Interface(verifiedAbi);
try{
 const chainId=Number(BigInt(await call('eth_chainId',[])));
 const observedBlock=await call('eth_getBlockByNumber',[tag,false]);
 evidence.networkVerification={chainId,blockNumber:Number(BigInt(observedBlock.number)),blockHash:observedBlock.hash};
 if(chainId!==source.chainId||Number(BigInt(observedBlock.number))!==block||normalized(observedBlock.hash)!==normalized(source.frozenBlock.hash))
  throw Error('APC_FROZEN_CHAIN_IDENTITY_MISMATCH');
 for(const target of source.resolvedTargets){
  if(!addressRe.test(target.address))throw Error('APC_INVALID_TARGET_ADDRESS');
  const runtime=await call('eth_getCode',[target.address,tag]);
  const digest=createHash('sha256').update(Buffer.from(runtime.slice(2),'hex')).digest('hex');
  const match=runtime!=='0x'&&digest===target.runtimeSha256;
  evidence.runtimeChecks.push({address:target.address,expectedSha256:target.runtimeSha256,
    observedSha256:digest,exactMatch:match});
  if(!match)throw Error('APC_FROZEN_RUNTIME_MISMATCH_'+target.address);
 }
 // Reproduce recorded zero-argument Phase-0 live reads where the frozen snapshot
 // defines their value; do not claim other state was proven.
 const snapshot=read(original+'/evidence/review-inventory/DEPLOYED_STATE_SNAPSHOT_v1.json');
 for(const row of snapshot.rows??[]){
  if(!row?.address||row.status!=='OK'||!['decimals','totalSupply','DOMAIN_SEPARATOR','PERMIT_TYPEHASH'].includes(row.function))continue;
  const fn=iface.getFunction(row.function);
  const data=iface.encodeFunctionData(fn,[]);
  const result=await call('eth_call',[{to:row.address,data},tag]);
  const decoded=iface.decodeFunctionResult(fn,result)[0];
  const actual=typeof decoded==='bigint'?decoded.toString():String(decoded);
  const matched=normalized(actual)===normalized(row.result);
  evidence.readOnlyChecks.push({address:row.address,method:row.function,actual,expected:row.result,matched});
  if(!matched)throw Error('APC_HISTORICAL_SNAPSHOT_MISMATCH_'+row.function);
 }
 // DAI authorization is exposed by wards(address), a nonzero-argument getter
 // omitted by the generic Phase-0 snapshot. Check candidates, not an invented
 // complete roster. Callers may supply additional grounded candidates.
 const dai='0x6b175474e89094c44da98b954eedeac495271d0f';
 const candidates=[...new Set([
   ...(source.resolvedTargets.some(t=>normalized(t.address)===dai)
      ?['0x9759A6Ac90977b93B58547b4A71c78317f391A28']:[]),
   ...(Array.isArray(request.wardCandidates)?request.wardCandidates:[])
  ].map(a=>String(a).toLowerCase()))];
 if(candidates.length>100||candidates.some(a=>!addressRe.test(a)))throw Error('APC_WARD_CANDIDATE_INVALID');
 for(const address of candidates){
  if(!source.resolvedTargets.some(t=>normalized(t.address)===dai))break;
  const fn=iface.getFunction('wards');
  const data=iface.encodeFunctionData(fn,[address]);
  const result=await call('eth_call',[{to:dai,data},tag]);
  evidence.wardReads.push({address,wardValue:uintHex(iface.decodeFunctionResult(fn,result)[0]),blockNumber:block,status:'VERIFIED'});
 }
 if(!evidence.readOnlyChecks.length&&!evidence.wardReads.length)
  throw Error('APC_NO_READ_ONLY_STATE_CHECKS');
 evidence.status='VERIFIED_READ_ONLY';
 evidence.limitations.push('Ward candidates checked through wards(address) do not establish an exhaustive roster without authenticated creation/LogNote history.');
 evidence.limitations.push('Signer key custody, governance controllers, backing and redemption are external to the admitted token-only source.');
}catch(error){
 evidence.status='INCOMPLETE';errors.push(String(error?.message??error));
 evidence.errors=errors;
}
evidence.recordedAt=new Date().toISOString();
const out=path.join(root,dest,'work/phase-04/PHASE_04_ONCHAIN_READONLY_v1.json');
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({status:evidence.status,readOnlyChecks:evidence.readOnlyChecks.length,wardReads:evidence.wardReads.length,errors}));
