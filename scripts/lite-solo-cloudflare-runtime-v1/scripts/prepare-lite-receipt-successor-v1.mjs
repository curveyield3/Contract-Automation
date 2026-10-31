#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parse(argv){const o={};for(let i=2;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw new Error('args must be --key value');o[argv[i].slice(2)]=argv[i+1];}return o;}
function read(f){return JSON.parse(fs.readFileSync(f,'utf8'));}
function write(f,v){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n');}
const a=parse(process.argv);
for(const k of ['controller-root','campaign-directory-path']) if(!a[k]) throw new Error('missing --'+k);
const root=path.resolve(a['controller-root']);
const dirFile=path.join(root,...a['campaign-directory-path'].split('/'));
const directory=read(dirFile);
if(directory.schemaVersion!=='curveyield-audit-campaign-directory-entry-v1') throw new Error('invalid campaign directory entry');
const outgoingPath=directory.currentReceiptPath;
const outgoingFile=path.join(root,...outgoingPath.split('/'));
const outgoing=read(outgoingFile);
const libUrl=pathToFileURL(path.join(root,'packages/controller-core/src/lite-phase-receipt-v1.mjs')).href;
const {createLitePhaseReceiptV1,validateLitePhaseReceiptV1,buildWakeMessageFromReceiptsV1}=await import(libUrl);
validateLitePhaseReceiptV1(outgoing);
if(outgoing.phase.status!=='SEALED'||outgoing.validation.status!=='PASS') throw new Error('outgoing receipt is not sealed');
if(!outgoing.handoff.required||!['SUCCESSOR_PENDING','SUCCESSOR_DISPATCHED'].includes(outgoing.handoff.status)) throw new Error('fresh successor is not pending');
const nextSeq=outgoing.handoff.nextPhaseSequence;
const incomingPath=outgoing.handoff.incomingReceiptPath;
if(!Number.isInteger(nextSeq)||!incomingPath) throw new Error('incoming phase receipt identity missing');
const incomingFile=path.join(root,...incomingPath.split('/'));
let incoming;
if(fs.existsSync(incomingFile)){
  incoming=read(incomingFile);
  validateLitePhaseReceiptV1(incoming);
}else{
  incoming=createLitePhaseReceiptV1({
    campaignId:outgoing.campaign.campaignId,campaignGenerationId:outgoing.campaign.campaignGenerationId,campaignName:outgoing.campaign.campaignName,
    workspacePath:outgoing.campaign.workspacePath,campaignDirectoryEntryPath:outgoing.campaign.campaignDirectoryEntryPath,
    sequence:nextSeq,executorType:'AI_REVIEWER',executorLineage:outgoing.handoff.incomingReviewer,
    authority:outgoing.authority,sourceSha256:outgoing.source.sha256,source:outgoing.source,status:'INITIALIZED',
    globalControls:outgoing.globalControls,
    obligations:{due:[...(outgoing.obligations.carriedForward??[]),...(outgoing.obligations.due??[])],created:[],closed:[],carriedForward:[]},
    inputs:[{role:'PREDECESSOR_RECEIPT',path:outgoingPath}],
    handoff:{required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:null,sameReviewer:false,status:'NOT_READY'}
  });
  write(incomingFile,incoming);
}
outgoing.handoff.status='SUCCESSOR_DISPATCHED';outgoing.updatedAt=new Date().toISOString();write(outgoingFile,outgoing);
const wakeMessage=buildWakeMessageFromReceiptsV1({outgoingReceipt:outgoing,incomingReceipt:incoming});
process.stdout.write(JSON.stringify({
  status:'PASS',campaignId:directory.campaignId,campaignName:directory.campaignName,directoryPath:a['campaign-directory-path'],
  outgoingReceiptPath:outgoingPath,incomingReceiptPath:incomingPath,incomingReviewer:incoming.executor.lineage,
  incomingPhaseId:incoming.phase.id,incomingPhaseSequence:incoming.phase.sequence,boundary:outgoing.handoff.boundary,
  assignedWork:outgoing.handoff.assignedWork,wakeMessage,wakeMessageB64:Buffer.from(wakeMessage).toString('base64')
})+'\n');
