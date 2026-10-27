import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {independentSpecItemsV13} from '../packages/github-native-sim/src/adr-lite-solo-independent-spec-v1.mjs';
import {secureShardWorkFormV13,secureRestoreWorkFormV13} from './lib/lite-solo-work-shards-v1.mjs';
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
const authority='Audit Skill - Lite-Solo Authority/lite-solo-v4';
if(!controller.includes("const gatedMasterReview=false")||
 controller.includes('stageMasterReview({root,campaignPath')||
 controller.includes("if(reviewKind==='master'){")||
 controller.includes("incomingReviewer:'master-reviewer'")||
 !controller.includes('nextSequence=8')||
 !controller.includes("directory.campaignStatus=masterAmendmentRefreshSha?'MASTER_AMENDMENT_REFRESH':'COMPLETE'"))
 throw Error('controller master path or deterministic terminal behavior mismatch');
if(!discovery.includes('sequentialSingleReviewer:')||!discovery.includes('lite-solo-phase-boundary/'))
 throw Error('discovery is not sequenced in a single chat');
const phaseWork=fs.readFileSync('scripts/lib/lite-solo-phase-work-v1.mjs','utf8');
const unitQueue=fs.readFileSync('scripts/lib/lite-solo-unit-queue-v1.mjs','utf8');
if(!phaseWork.includes('validateBoundAuthorityV1')||
   !phaseWork.includes('secureShardWorkFormV13')||
   !unitQueue.includes("const AUTHORITY='"+authority+"'")||
   !unitQueue.includes('secureShardWorkFormV13({root')||
   !unitQueue.includes('retireFull:true'))
 throw Error('solo work forms are not using receipt-bound secure sharding');
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

const workRoot=fs.mkdtempSync(path.join(os.tmpdir(),'lite-solo-locked-base-'));
try {
 const formRel='campaigns/solo-fixture/work/phase-01/PHASE_01_WORK_FORM_v1.json';
 const file=path.join(workRoot,...formRel.split('/'));
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const original={schemaVersion:'solo-work-form-fixture',automationInputs:{lockedFacts:'contract-and-source-bound-context:'.repeat(9500)},
   actions:{'step-1':{section:'scope',outputs:{records:[{id:'REC-001',note:'evidence'},{id:'REC-002',note:'evidence'}]}}}};
 fs.writeFileSync(file,JSON.stringify(original,null,2)+'\n');
 const generated=secureShardWorkFormV13({root:workRoot,formRel,phase:1,retireFull:true});
 if(!generated||!fs.existsSync(path.join(workRoot,...generated.indexRel.split('/'))) || fs.existsSync(file))
   throw Error('solo protected sharding failed to retire full work form');
 const shardDir=path.dirname(path.join(workRoot,...generated.indexRel.split('/')));
 const desc=JSON.parse(fs.readFileSync(path.join(shardDir,'BASE_v1.json'),'utf8'));
 if(desc.schemaVersion!=='curveyield-lite-solo-locked-base-v1'||desc.pages.length<2)
   throw Error('large controller-owned base was not paginated');
 for(const page of desc.pages){
   if(fs.statSync(path.join(shardDir,page.file)).size>64*1024)
     throw Error('solo locked-base fragment exceeded 64 KiB');
 }
 const restored=secureRestoreWorkFormV13({root:workRoot,indexRel:generated.indexRel});
 if(JSON.stringify(JSON.parse(restored.content))!==JSON.stringify(original))
   throw Error('solo immutable base and editable shards lost source-bound content');
 const part=path.join(shardDir,desc.pages[0].file);
 const saved=fs.readFileSync(part,'utf8');
 const mutated=JSON.parse(saved);mutated.contentBase64='AAAA'+mutated.contentBase64.slice(4);
 fs.writeFileSync(part,JSON.stringify(mutated,null,2)+'\n');
 let rejected=false;
 try { secureRestoreWorkFormV13({root:workRoot,indexRel:generated.indexRel}); }
 catch { rejected=true; }
 if(!rejected)throw Error('tampered lite-solo locked base fragment was accepted');
} finally {fs.rmSync(workRoot,{recursive:true,force:true});}
console.log('PASS: 64KiB-bounded large immutable solo BASE sharding, full round trip, and tamper rejection');


const specFixture=fs.mkdtempSync(path.join(os.tmpdir(),'lite-solo-spec-all-rules-'));
try{
 const sourceRoot=path.join(specFixture,'campaigns','fixture','source');
 fs.mkdirSync(sourceRoot,{recursive:true});
 fs.writeFileSync(path.join(sourceRoot,'README.md'),Array.from({length:30},(_,i)=>'The settle operation must validate independent policy rule '+(i+1)).join('\n'));
 const result=independentSpecItemsV13({root:specFixture,campaignPath:'campaigns/fixture',
  context:{contextId:'CTX-SOLO-FIXTURE',path:'src/Mock.sol',lineStart:1,canonicalSignature:'settle(uint256)'},otherContexts:[]});
 if(result.documentationItems.length!==30)throw Error('solo independent-spec reader lost matching documentation rules');
}finally{fs.rmSync(specFixture,{recursive:true,force:true});}
console.log('PASS: solo independent-spec reader retains all 30 documented rules without truncation');

console.log('PASS: static fork inventory, controller routing, source sharding and zero chat or message delivery');

