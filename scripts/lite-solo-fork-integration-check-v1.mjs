import fs from 'node:fs';
import path from 'node:path';
const required=[
 'scripts/lite-solo-phase-controller-v1.mjs',
 'scripts/lib/lite-solo-phase-work-v1.mjs',
 'scripts/lib/lite-solo-phase-prefill-v1.mjs',
 'scripts/lib/lite-solo-lineup-v1.mjs',
 'scripts/lib/lite-solo-final-candidates-v1.mjs',
 'scripts/lite-solo-phase0-finalize-v1.mjs',
 'scripts/lite-solo-source-initialization/run-v1.sh',
 'scripts/lite-solo-source-initialization/write-phase0-receipt-v1.py',
 'packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs',
 'packages/github-native-sim/src/lite-solo-phase0-intelligence-v1.mjs',
 ...['source-initialization','phase0-bootstrap','phase0-intelligence','phase-controller','phase5-authorization'].map(s=>'.github/workflows/lite-solo-'+s+'-v1.yml')
];
for(const p of required)if(!fs.statSync(p,{throwIfNoEntry:false})?.isFile())throw Error('missing lite-solo component: '+p);
const controller=fs.readFileSync(required[0],'utf8');
const discovery=fs.readFileSync('packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs','utf8');
const authority='Audit Skill - Lite-Solo Authority/lite-solo';
if(!controller.includes("const gatedMasterReview=false")||
 controller.includes('stageMasterReview({root,campaignPath')||
 controller.includes("if(reviewKind==='master'){")||
 controller.includes("incomingReviewer:'master-reviewer'")||
 !controller.includes('nextSequence=8')||
 !controller.includes("directory.campaignStatus=masterAmendmentRefreshSha?'MASTER_AMENDMENT_REFRESH':'COMPLETE'"))
 throw Error('controller master path or deterministic terminal behavior mismatch');
if(!discovery.includes('sequentialSingleReviewer:')||!discovery.includes('lite-solo-phase-boundary/'))
 throw Error('discovery is not sequenced in a single chat');
if(!fs.readFileSync('scripts/lib/lite-solo-phase-work-v1.mjs','utf8').includes("authorityRoot==='"+authority+"'"))
 throw Error('solo work forms are not using secure sharding');
if(!fs.readFileSync('scripts/lite-solo-phase0-finalize-v1.mjs','utf8').includes("mode:'LITE_SOLO'"))
 throw Error('solo source finalization does not bind campaign mode');
const sourceWorkflow=fs.readFileSync('.github/workflows/lite-solo-source-initialization-v1.yml','utf8');
const sourceScript=fs.readFileSync('scripts/lite-solo-source-initialization/run-v1.sh','utf8');
const phase0Workflow=fs.readFileSync('.github/workflows/lite-solo-phase0-bootstrap-v1.yml','utf8');
const phaseControllerWorkflow=fs.readFileSync('.github/workflows/lite-solo-phase-controller-v1.yml','utf8');
if(!sourceWorkflow.includes('workflow_dispatch:')||
   sourceWorkflow.includes('  push:')||
   sourceWorkflow.includes('process/lite-solo-source-initialization/requests/')||
   /agent_chat_url|agentChatUrl|wake_message_b64|SOLO_CHAT_URL/.test(sourceWorkflow))
 throw Error('Lite-Solo launch must require only a direct workflow dispatch, never chat or request-file delivery');
if(/SOLO_CHAT_URL|process\/browser-agent-wake\/registrations|lite-work-relay-v1\.yml|WAKE_ACK/.test(sourceScript))
 throw Error('Lite-Solo initialization still attempts a browser registration, chat binding or message delivery');
if(!discovery.includes('sequentialSingleReviewer:true')||
   /discoveryWakeMessageV1|discoveryWindowWakeMessageV1|wakeFor\(|wakeId:|messageB64:/.test(discovery))
 throw Error('Lite-Solo discovery must use separate sequential flow/attack windows without wake generation');
if(/discoveryWake|SUCCESSOR_DELIVERY_HOLD/.test(controller)||
   /lite-work-relay-v1\.yml|wake_message_b64|gh workflow run browser-agent-wake/.test(phase0Workflow+phaseControllerWorkflow))
 throw Error('Lite-Solo controller or Phase0 still carries a chat wake/delivery system');
if(!fs.readFileSync('scripts/lite-solo-phase0-finalize-v1.mjs','utf8').includes("directory.deliveryTransport!=='DIRECT'"))
 throw Error('Lite-Solo Phase0 does not fail closed on a non-direct campaign');
console.log('PASS: static fork inventory, controller routing, source sharding and zero chat or message delivery');

