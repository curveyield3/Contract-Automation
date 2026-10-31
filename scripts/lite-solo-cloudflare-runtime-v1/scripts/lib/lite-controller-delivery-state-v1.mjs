import fs from 'node:fs';
import path from 'node:path';
import {restoreControllerResultV1} from './lite-boundary-result-v1.mjs';

export const DELIVERY_STATE_FILE_V1='controller/delivery/DELIVERY_LEDGER_v1.json';
const goodDigest=s=>/^[0-9a-f]{64}$/.test(s??'');
const directoryFile=(root,campaignPath)=>path.join(root,...campaignPath.split('/'),...DELIVERY_STATE_FILE_V1.split('/'));
const laneId=({reviewKind,phaseSequence,reviewer,segmentId})=>
 [reviewKind||'phase',phaseSequence??segmentId??'none',reviewer??'none'].join(':');
export function publishedDeliveryStateV1({root,campaignPath,envelope,requestId,reviewKind,phaseSequence,reviewer,now}={}){
 if(!goodDigest(envelope?.sha256)||!requestId||!now)
  throw new Error('delivery state requires exact result digest, request ID and timestamp');
 const response=restoreControllerResultV1({root,campaignPath,envelope});
 const filename=directoryFile(root,campaignPath);
 const ledger=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{
  schemaVersion:'curveyield-lite-controller-delivery-ledger-v1',campaignId:response.campaignId,
  latestByLane:{},results:{}};
 if(ledger.schemaVersion!=='curveyield-lite-controller-delivery-ledger-v1'||
    ledger.campaignId!==response.campaignId)throw new Error('wrong delivery ledger identity');
 const phase=phaseSequence??response.phaseSequence??response.nextAssignment?.phaseSequence??null;
 const role=reviewer??response.reviewer??response.nextAssignment?.reviewer??null;
 const lane=laneId({reviewKind,phaseSequence:phase,reviewer:role,segmentId:response.segmentId});
 const prior=ledger.results[envelope.sha256];
 if(prior&&prior.requestId!==requestId)throw new Error('same result digest received under conflicting request IDs');
 if(!prior){
  ledger.results[envelope.sha256]={
   resultSha256:envelope.sha256,detailRef:envelope.detailRef,
   requestId,reviewKind,phaseSequence:phase,reviewer:role,segmentId:response.segmentId??null,
   status:response.status,lane,wakeId:response.campaignId+'-delivery-'+envelope.sha256.slice(0,20),
   state:'PUBLISHED',transitions:[{state:'COMPUTED',at:now},{state:'PUBLISHED',at:now}],
   replayClaim:null};
 }
 // New computed results supersede older rework for the same reviewer/phase.
 ledger.latestByLane[lane]=envelope.sha256;
 fs.mkdirSync(path.dirname(filename),{recursive:true});
 fs.writeFileSync(filename,JSON.stringify(ledger,null,2)+'\n');
 return {ledgerRel:path.posix.join(campaignPath,DELIVERY_STATE_FILE_V1),
  ...ledger.results[envelope.sha256]};
}
export function validatePublishedDeliveryV1({root,campaignPath,resultSha256,now}={}){
 const filename=directoryFile(root,campaignPath);
 if(!fs.existsSync(filename))return null; // Frozen v12 campaigns never acquire this ledger.
 const ledger=JSON.parse(fs.readFileSync(filename,'utf8'));
 const result=ledger.results?.[resultSha256];
 if(!result||result.resultSha256!==resultSha256||ledger.latestByLane?.[result.lane]!==resultSha256)
  throw new Error('stale or unregistered controller delivery result');
 if(result.state==='DELIVERED')throw new Error('controller delivery already acknowledged');
 if(result.state!=='PUBLISHED')throw new Error('controller delivery not published');
 if(result.replayClaim){
  const last=Date.parse(result.replayClaim.at);
  if(!Number.isFinite(last)||Date.parse(now)-last<15*60*1000)
   throw new Error('duplicate controller delivery replay already claimed');
 }
 return result;
}
export function advanceDeliveryStateV1({ledger,resultSha256,wakeId,to,now,claimId}={}){
 if(ledger?.schemaVersion!=='curveyield-lite-controller-delivery-ledger-v1'||
    !goodDigest(resultSha256)||!now||!['CLAIM','DELIVERED'].includes(to))
  throw new Error('invalid delivery transition');
 const next=structuredClone(ledger),entry=next.results?.[resultSha256];
 if(!entry||entry.wakeId!==wakeId||next.latestByLane?.[entry.lane]!==resultSha256)
  throw new Error('delivery identity superseded or mismatched');
 if(to==='CLAIM'){
  if(!claimId)throw new Error('replay claim ID required');
  if(entry.state!=='PUBLISHED')throw new Error('cannot replay delivered controller message');
  const previous=entry.replayClaim?.at?Date.parse(entry.replayClaim.at):0;
  if(previous&&Date.parse(now)-previous<15*60*1000)
   throw new Error('controller replay already claimed');
  entry.replayClaim={id:claimId,at:now};
 }else{
  if(entry.state==='DELIVERED')return next;
  if(entry.state!=='PUBLISHED')throw new Error('cannot deliver unpublished message');
  entry.state='DELIVERED';entry.deliveredAt=now;
  entry.transitions.push({state:'DELIVERED',at:now});
  entry.replayClaim=null;
 }
 return next;
}
