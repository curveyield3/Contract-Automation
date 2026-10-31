#!/usr/bin/env node
// Applies the source package's audit-scope.json to a campaign whose Phase 0 review inventory was
// built without it, then restarts Phase 4 discovery on the corrected flow plan.
//
// The sealed Phase 0 files stay byte-exact (the Phase 0 receipt binds their digests). Corrected
// copies go to evidence/review-inventory/scope-corrected/, which every reader prefers. Superseded
// discovery work is moved aside, not deleted. Prints the discovery wake as JSON on stdout.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseAuditScope,AUDIT_SCOPE_FILE} from '../packages/github-native-sim/src/phase0-audit-scope-v1.mjs';
import {applyAuditScopeToInventoryV1,SCOPE_CORRECTED_DIR_V1} from '../packages/github-native-sim/src/adr-review-inventory-v1.mjs';
import {buildSystemFactsV1} from '../packages/github-native-sim/src/adr-system-facts-v1.mjs';
import {buildFlowPlanV1} from '../packages/github-native-sim/src/adr-flow-plan-v1.mjs';
import {startDiscoveryV1} from '../packages/github-native-sim/src/adr-discovery-v1.mjs';
import {authorityRootFromReceipt} from './lib/lite-phase-work-v1.mjs';

const args=Object.fromEntries(process.argv.slice(2).reduce((rows,item,i,all)=>item.startsWith('--')?[...rows,[item.slice(2),all[i+1]]]:rows,[]));
for(const k of ['controller-root','campaign-path','campaign-directory-path'])if(!args[k])throw new Error('missing --'+k);
const root=path.resolve(args['controller-root']),campaignPath=args['campaign-path'];
const now=args.now??new Date().toISOString();
const file=(rel)=>path.join(root,...rel.split('/'));
const readJson=(rel)=>JSON.parse(fs.readFileSync(file(rel),'utf8'));
const writeJson=(rel,value)=>{fs.mkdirSync(path.dirname(file(rel)),{recursive:true});fs.writeFileSync(file(rel),JSON.stringify(value,null,2)+'\n');};
const sha=(rel)=>createHash('sha256').update(fs.readFileSync(file(rel))).digest('hex');
const sealed=(name)=>path.posix.join(campaignPath,'evidence/review-inventory',name);
const corrected=(name)=>path.posix.join(campaignPath,SCOPE_CORRECTED_DIR_V1,name);

const directory=readJson(args['campaign-directory-path']);
if(directory.campaignStatus!=='WAITING_FOR_DISCOVERY'||directory.discovery?.status!=='RUNNING')
  throw new Error('rescope applies only while Phase 4 discovery is running; observed '+directory.campaignStatus+'/'+directory.discovery?.status);
const identity=readJson(path.posix.join(campaignPath,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'));
const scopeRel=path.posix.join(campaignPath,'source',identity.discovery?.projectPath??'',AUDIT_SCOPE_FILE);
if(!fs.existsSync(file(scopeRel)))throw new Error('no '+AUDIT_SCOPE_FILE+' in the campaign source: '+scopeRel);
const scope=parseAuditScope(fs.readFileSync(file(scopeRel),'utf8'));

const receipt=readJson(path.posix.join(campaignPath,'receipts/PHASE_00_RECEIPT_v1.json'));
const authorityRoot=authorityRootFromReceipt(receipt);
const includeScripts=/Audit_Litemode_v13(?:\/|$)/.test(authorityRoot);
const before=readJson(sealed('REVIEW_INVENTORY_v1.json'));
const inventory=applyAuditScopeToInventoryV1({inventory:before,scope,generatedAt:now,includeScripts});
const facts={...buildSystemFactsV1({inventory}),generatedAt:now};
const snapshotRel=sealed('DEPLOYED_STATE_SNAPSHOT_v1.json');
const snapshot=fs.existsSync(file(snapshotRel))?readJson(snapshotRel):null;
const plan={...buildFlowPlanV1({inventory,facts,snapshot}),generatedAt:now};
if(!inventory.payload.complete&&!plan.payload.gaps.some(g=>g.code==='INVENTORY_INCOMPLETE'))
  plan.payload.gaps.push({code:'INVENTORY_INCOMPLETE',path:'*',detail:'Incomplete in-scope review inventory'});
writeJson(corrected('REVIEW_INVENTORY_v1.json'),inventory);
writeJson(corrected('SYSTEM_FACTS_v1.json'),facts);
writeJson(corrected('FLOW_PLAN_v1.json'),plan);

const units=(p)=>({flowReviewUnits:p.payload.reviewUnits.filter(u=>u.unitId.startsWith('F-')).length,
  residualUnits:p.payload.reviewUnits.filter(u=>u.unitId.startsWith('R-')).length,attackUnits:p.payload.attackUnits.length});
const sealedPlan=readJson(sealed('FLOW_PLAN_v1.json'));
const discoveryDir=path.posix.join(campaignPath,'work/phase-04/discovery');
const supersededDir=path.posix.join(campaignPath,'work/phase-04/discovery-superseded-'+now.replace(/[:.]/g,'-'));
writeJson(corrected('SCOPE_CORRECTION_v1.json'),{schemaVersion:'curveyield-review-scope-correction-v1',
  campaignId:directory.campaignId,generatedAt:now,
  reason:'The Phase 0 review inventory ignored the package audit-scope.json and treated vendored dependencies, '+
    'test libraries and deploy scripts as in-scope. Discovery restarted on the corrected plan.',
  scope:{path:scopeRel,sha256:sha(scopeRel),inScopePaths:scope.inScopePaths},
  sealedInputs:['REVIEW_INVENTORY_v1.json','SYSTEM_FACTS_v1.json','FLOW_PLAN_v1.json','DEPLOYED_STATE_SNAPSHOT_v1.json']
    .filter(n=>fs.existsSync(file(sealed(n)))).map(n=>({path:sealed(n),sha256:sha(sealed(n))})),
  outputs:['REVIEW_INVENTORY_v1.json','SYSTEM_FACTS_v1.json','FLOW_PLAN_v1.json'].map(n=>({path:corrected(n),sha256:sha(corrected(n))})),
  before:{contexts:before.payload.contexts.length,...units(sealedPlan)},
  after:{contexts:inventory.payload.contexts.length,...units(plan)},
  supersededDiscoveryPath:fs.existsSync(file(discoveryDir))?supersededDir:null});

if(fs.existsSync(file(discoveryDir)))fs.renameSync(file(discoveryDir),file(supersededDir));
const started=startDiscoveryV1({root,campaignPath,directory,authorityRoot,
  automationRoot:process.cwd(),now,auditControllerRef:args['audit-controller-ref']??'main'});
const state=started.state.payload;
directory.discovery={statePath:started.statePath,status:started.completeImmediately?'COMPLETE':'RUNNING',
  activeUnitId:state.activeUnitId,activeUnitIds:state.order.filter(id=>state.units[id]?.status==='ACTIVE')};
directory.updatedAt=now;
writeJson(args['campaign-directory-path'],directory);
const notice='CONTROLLER: Phase 4 discovery has been restarted on a scope-corrected plan. Only '+scope.inScopePaths.join(', ')+
  ' is in scope (per the package '+AUDIT_SCOPE_FILE+'); vendored IPOR Fusion and forge-std stay excluded; '+
  (includeScripts?'first-party deployment scripts remain IN SCOPE under v13. ':'deployment scripts remain excluded under frozen v12. ')+
  'Your earlier units are superseded: stop any unit you are working on and start the units below.';
const message=notice+'\n\n'+Buffer.from(started.wake.messageB64,'base64').toString('utf8');
process.stdout.write(JSON.stringify({status:'RESCOPED',before:units(sealedPlan),after:units(plan),
  contextsBefore:before.payload.contexts.length,contextsAfter:inventory.payload.contexts.length,
  wake:{...started.wake,messageB64:Buffer.from(message).toString('base64')}})+'\n');
