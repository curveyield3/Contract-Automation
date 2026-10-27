import fs from 'node:fs';
import {isReassignedV13AuthorityV1 as originalV13SingleV1} from '../../../scripts/lib/lite-authority-lineup-v1.mjs';
const isReassignedV13AuthorityV1=({authorityRoot,...params})=>authorityRoot==='Audit Skill - Lite-Solo Authority/lite-solo'||originalV13SingleV1({authorityRoot,...params});
import path from 'node:path';
import {createHash} from 'node:crypto';
import {classesForTriggersV1,loadTaxonomyV1} from './adr-taxonomy-v1.mjs';
import {buildCoverageMatrixV1} from './adr-coverage-matrix-v1.mjs';
import {deriveBaselineObligationsV1} from './adr-baseline-obligations-v1.mjs';
import {validateFlowReviewSubmissionV1,validateAttackSubmissionV1,feedbackTextV1,parseAnchorV1,TRIVIAL_KINDS_V1,isLiteralConstantV13} from './adr-discovery-validators-v1.mjs';
import {repoFile,readJson,writeJson} from '../../../scripts/lib/lite-solo-phase-work-v1.mjs';
import {reviewInventoryRelV1} from './adr-review-inventory-v1.mjs';
import {independentSpecItemsV13} from './adr-lite-solo-independent-spec-v1.mjs';
// V13 qualification status is assessed independently after real blinded audit runs.

const pathJoin=(campaign,relative)=>path.posix.join(campaign,'work/phase-04/discovery',relative);
const asset=(root,campaign,name)=>reviewInventoryRelV1(root,campaign,name);
const known=(root,rel)=>{const file=repoFile(root,rel);return fs.existsSync(file)?readJson(file):null;};
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const arr=x=>Array.isArray(x)?x:[];
const SOLO_WINDOW_MAX_UNITS=8;
// A round is bounded by the harder of source-context bytes and substantive
// analysis effort, not an arbitrary tiny unit count.
const SOLO_WINDOW_MAX_WORK_ITEMS=150;
const SOLO_WINDOW_MAX_PACKET_BYTES=256*1024;
const SOLO_PACKET_PAGE_MAX_BYTES=24*1024;
const sort=(a,b)=>String(a).localeCompare(String(b));
const head=(directory,now,schemaVersion,payload)=>({schemaVersion,campaignId:directory.campaignId,
 campaignGenerationId:directory.campaignGenerationId,sourceSha256:directory.sourceSha256,
 taxonomyVersion:'curveyield-defect-taxonomy-v1',detectionPolicy:'audit-detection-rebuild-v1',generatedAt:now,payload});
const unitSort=(a,b)=>'FRX'.indexOf(a.unitId[0])-'FRX'.indexOf(b.unitId[0])||sort(a.unitId,b.unitId);
function getInputs({root,campaignPath,automationRoot}){
 return {inventory:known(root,asset(root,campaignPath,'REVIEW_INVENTORY_v1.json')),
  plan:known(root,asset(root,campaignPath,'FLOW_PLAN_v1.json')),
  facts:known(root,asset(root,campaignPath,'SYSTEM_FACTS_v1.json')),
  taxonomy:loadTaxonomyV1(automationRoot)};
}
const unitList=(plan)=>[...arr(plan?.payload?.reviewUnits),...arr(plan?.payload?.attackUnits)].sort(unitSort);
const resolveUnit=(plan,unitId)=>unitList(plan).find(x=>x.unitId===unitId);
const contextAnchor=(c)=>c?c.path+':L'+c.lineStart+'-L'+c.lineEnd:'NO_SOURCE_ANCHOR';
function contextFor(inventory,id){return arr(inventory?.payload?.contexts).find(c=>c.contextId===id);}
function normalizeAccepted(state){return state?.payload??state;}
const packetRel=(campaign,unit)=>pathJoin(campaign,unit+'/ASSIGNMENT_PACKET_v1.json');
const submissionRel=(campaign,unit)=>pathJoin(campaign,unit+'/SUBMISSION_v1.json');
const stateRel=(campaign)=>pathJoin(campaign,'DISCOVERY_STATE_v1.json');
const stubObligations=(directory,now)=>head(directory,now,'curveyield-baseline-obligations-v1',{obligations:[],testGroups:[]});

export function buildUnitPacketV1({root,campaignPath,directory,authorityRoot,automationRoot,unitId,state,now,sharedInputs=null,persist=true}){
 const {inventory,plan,facts,taxonomy}=sharedInputs??getInputs({root,campaignPath,automationRoot}),unit=resolveUnit(plan,unitId);
 if(!unit)throw new Error('unknown discovery unit '+unitId);
 const role=unit.role==='ATTACK'?'ATTACK':'FLOW_REVIEW',primary=arr(unit.primaryContextIds);
 const contextIds=role==='ATTACK'?arr(inventory?.payload?.contexts).filter(c=>unit.contracts?.some(n=>c.qualifiedContainer===n||c.effectiveIn?.includes(n))).map(c=>c.contextId):primary;
 // Upgrade/storage is a contract property. A context whose only upgrade trigger is inheriting an
 // upgradeable base (PROXY_PATTERN) is covered by its contract's single contractCheck instead.
 const upgradeSpecific=new Set(['DELEGATECALL','INITIALIZER','STORAGE_GAP']);
 const triggersOf=id=>inventory?.payload?.triggers?.[id]??[];
 // Each upgradeable contract's contract-level check belongs to the first review unit holding it.
 const ownerUnit=new Map();
 for(const u of arr(plan?.payload?.reviewUnits))for(const id of arr(u.primaryContextIds)){
  const c=contextFor(inventory,id);
  if(c&&triggersOf(id).includes('PROXY_PATTERN')&&!ownerUnit.has(c.qualifiedContainer))ownerUnit.set(c.qualifiedContainer,u.unitId);
 }
 // The owner answers it unless its packet was issued before contract checks existed; then every
 // function keeps the class so nothing goes unanswered.
 const ownerAnswers=contract=>{
  const owner=ownerUnit.get(contract);
  if(!owner||owner===unitId)return Boolean(owner);
  const issued=known(root,packetRel(campaignPath,owner));
  return !issued||arr(issued.payload?.contractChecks).some(x=>x.contract===contract);
 };
 const contractLevelUpgrade=id=>{
  const t=triggersOf(id),c=contextFor(inventory,id);
  return role!=='ATTACK'&&t.includes('PROXY_PATTERN')&&!t.some(x=>upgradeSpecific.has(x))&&c?.kind!=='CONSTRUCTOR'&&ownerAnswers(c?.qualifiedContainer);
 };
 const requiredClasses=Object.fromEntries(contextIds.sort().map(id=>[id,classesForTriggersV1(taxonomy,
  contractLevelUpgrade(id)?triggersOf(id).filter(x=>x!=='PROXY_PATTERN'):triggersOf(id))]));
 const upgradeClass=arr(taxonomy?.classes).find(x=>x.classId==='UPGRADE_INIT_STORAGE');
 const contractChecks=role==='ATTACK'?[]:[...new Set(primary.map(id=>contextFor(inventory,id)?.qualifiedContainer).filter(Boolean))]
  .filter(name=>ownerUnit.get(name)===unitId).sort()
  .map(contract=>({contract,classId:'UPGRADE_INIT_STORAGE',reviewChecks:arr(upgradeClass?.reviewChecks)}));
 const verdictV13=/(?:Audit_Litemode_v13|lite-solo(?:-v[23456])?)(?:\/|$)/.test(authorityRoot);
 const trivialContextIds=role==='ATTACK'?[]:primary.filter(id=>verdictV13?
   isLiteralConstantV13(contextFor(inventory,id)):TRIVIAL_KINDS_V1.has(contextFor(inventory,id)?.kind));
 const instructionsPath=path.posix.join(authorityRoot,'discovery',role==='ATTACK'?'ATTACKER_START_HERE.md':'FLOW_REVIEW_START_HERE.md');
 const flows=arr(plan?.payload?.flows).filter(f=>arr(unit.flowIds).includes(f.flowId));
 const questions=arr(plan?.payload?.integrationQuestions).filter(q=>arr(unit.integrationQuestionIds).includes(q.obligationId));
 const siblingChecks=verdictV13&&role!=='ATTACK'?arr(facts?.payload?.siblingGroups)
  .filter(g=>arr(g.members).some(m=>primary.includes(m.contextId)))
  .map(g=>({signature:g.signature,pattern:g.pattern??'shared modifier or pattern',
    asymmetric:g.asymmetric,differences:g.differences??[],
    members:arr(g.members).map(m=>({contract:m.contract,contextId:m.contextId,
      function:m.function??g.signature,sourceAnchor:m.sourceAnchor,
      hasGuard:m.hasGuard,modifiers:m.modifiers??[]}))})):[];
 const independentItems=verdictV13&&role!=='ATTACK'?primary.flatMap(id=>{
  const c=contextFor(inventory,id);
  return c?[{contextId:id,...independentSpecItemsV13({root,campaignPath,context:c,
    otherContexts:inventory.payload.contexts})}]:[];
 }):[];
 const documentationItems=independentItems.flatMap(x=>[
   ...(typeof contextFor(inventory,x.contextId)?.natSpec==='string'&&
    contextFor(inventory,x.contextId).natSpec.trim()?[{
      contextId:x.contextId,ruleId:'NATSPEC:'+x.contextId,
      sourceAnchor:contextAnchor(contextFor(inventory,x.contextId)),
      rule:contextFor(inventory,x.contextId).natSpec.slice(0,1200),type:'NATSPEC'}]:[]),
   ...x.documentationItems.map(rule=>({contextId:x.contextId,...rule}))
 ]);
 const specContext=independentItems.map(({contextId,referenceConstants,checkedDocCount,sourceCommentsChecked,missingSource})=>({
  contextId,referenceConstants,checkedDocCount,sourceCommentsChecked,missingSource,
  requirement:'Code initializers and getters are observations, not independent specifications'
 }));
 const packet=head(directory,now,'curveyield-discovery-assignment-packet-v1',{
  unitId,role,chatKey:role==='ATTACK'?(isReassignedV13AuthorityV1({root,authorityRoot})?'lite-solo-agent':verdictV13?'lite-solo-agent':'lite-solo-agent'):'lite-solo-agent',instructionsPath,
  submissionPath:authorityRoot.endsWith('/lite-solo-v4')?path.posix.join(campaignPath,'work/phase-04/units',unitId,'submissions/<workerId>/epoch-<claimEpoch>/SUBMISSION_ATTEMPT_001_v1.json'):submissionRel(campaignPath,unitId),boundaryRequestPath:authorityRoot.endsWith('/lite-solo-v4')?'process/agent-upload/lite-solo-unit-requests/':'process/agent-upload/lite-solo-phase-boundary/',
  sourceRoot:campaignPath+'/source',sourceInventoryPath:asset(root,campaignPath,'REVIEW_INVENTORY_v1.json'),
  flowPlanPath:asset(root,campaignPath,'FLOW_PLAN_v1.json'),
  systemFactsPath:asset(root,campaignPath,'SYSTEM_FACTS_v1.json'),
  primaryContexts:role==='ATTACK'?[]:primary.map(id=>contextFor(inventory,id)).filter(Boolean).map(c=>({...c,requiredClasses:requiredClasses[c.contextId]})),
  primaryContextIds:primary,readContextIds:role==='ATTACK'?contextIds:arr(unit.readContextIds),
  requiredClasses,flows,flowIds:arr(unit.flowIds),integrationQuestions:questions,
  integrationQuestionIds:arr(unit.integrationQuestionIds),
  ...(verdictV13&&role!=='ATTACK'?{
    reviewPolicy:'correctness-verdict-v13',
    siblingChecks,documentationItems,specContext,
    specificationReview:{sourcePaths:[...new Set(primary.map(id=>contextFor(inventory,id)?.path).filter(Boolean))],
      inspect:['NatSpec','inline comments','README and docs','named constants','paired parameters'],
      requirement:'For each documentationItems ruleId, report a MATCH/MISMATCH/UNRESOLVED comparison. Also explicitly inspect comments and README/docs from sourceRoot. If none are applicable, state NO_DOCUMENTED_RULES; the absence of entries alone is not proof.'},
    submissionGuide:[
      'V13 rows[] shape: {contextId,verdict:CORRECT|DEFECT|UNRESOLVED,intent,reason,anchors:[file.sol:Lx-Ly],specInspection:{status:MATCH|MISMATCH|UNRESOLVED|NO_DOCUMENTED_RULES,docsAndCommentsChecked,namedConstantsChecked},documentedRules:[{ruleId,rule,comparison,reason}],siblingComparisons:[{siblingContextId,signature,comparison}]}. Full source-backed fields are required, not guessed placeholders.',
      'CORRECT example: {contextId:CTX,verdict:CORRECT,intent:Only the owner can set cap,reason:Owner check precedes the state update,anchors:[file.sol:L20-L25],specInspection:{status:MATCH,docsAndCommentsChecked:README inspected,namedConstantsChecked:CAP inspected},documentedRules:[],siblingComparisons:[]}; use actual packet anchors and rules.',
      'DEFECT example: same core fields plus verdict:DEFECT and candidate:{tempKey:C1,classId:ACCESS_CONTROL,severity:HIGH,title:Uncapped update,description:Bypass of configured cap,anchors:[file.sol:L30-L35]}; also accepted: row.candidates[] or top-level candidates[] with candidateTempKey.',
      'UNRESOLVED example: same core fields plus verdict:UNRESOLVED and decidingTest:{name:multi-actor transaction sequence,expectedObservation:the exact machine result that confirms or disproves exploitability}.',
      'Check every packet documentationItems ruleId in documentedRules, and siblingChecks for actual members; never assert NO_DOCUMENTED_RULES if packet includes documentationItems.',
      'For each assigned flowId supply one end-to-end flowNotes[] {flowId,note,anchors}. For each integrationQuestionId supply one integrationAnswers[] {obligationId,assessment,reasoning,anchors}; CONCERN also needs a candidate.',
      'Complete each assigned contractChecks[] obligation, including contract, classId, assessment, applicability, evidence and anchors. UPGRADE_INIT_STORAGE remains required at contract level even when omitted from inherited per-function prompts.',
      'All V13 candidates require classId and severity, including contract-level and integration concerns.',
      'Class checks are prompts only: no per-class response is graded. The correctness verdict cannot be inferred from checklist completion.',
      'Compare implementation with NatSpec, comments, README/docs and named constants. Report every mismatch as a candidate.',
      'Compare sibling functions and paired parameters, documenting asymmetry. Storage initializers and locks never qualify for trivialReviews.',
      'For v4, commit immutable worker/epoch attempts, submit 1–5 completed units per request and continue immediately with independent assigned work, without approval polling.'
    ]
  }:{}),
  ...(role==='ATTACK'?{}:{trivialContextIds,contractChecks,...(verdictV13?{}:{submissionGuide:[
   'Each primaryContexts entry already lists its modifiers, state reads and writes, external and internal calls and sender checks: use them instead of re-deriving facts.',
   'trivialReviews (optional): [{contract,assessment,evidence,anchors}] - one confirmation per contract covers all of its trivialContextIds in this unit (values, bounds, who reads them); those contexts then need no row.',
   'groupChecks (optional): [{contextIds,classId,assessment,applicability,evidence,anchors}] - one check for two or more contexts that share a modifier; omit that class from their rows.',
   'contractChecks (required when listed): [{contract,classId,assessment,applicability,evidence,anchors}] - answer each listed contract-level class once, covering every function of that contract.'
  ]})}),
  ...(role==='ATTACK'?{contracts:unit.contracts}:{}),
  ...(role==='ATTACK'?{systemFacts:{
   guardTable:arr(facts?.payload?.guardTable).filter(x=>unit.contracts?.includes(x.contract)),
   siblingGroups:arr(facts?.payload?.siblingGroups).filter(x=>x.members?.some(m=>unit.contracts?.includes(m.contract))),
   crossContractEdges:arr(facts?.payload?.crossContractEdges).filter(x=>unit.contracts?.includes(x.fromContract)),
   valueFlows:arr(facts?.payload?.valueFlows).filter(x=>unit.contracts?.includes(x.contract))
  }}:{})
 });
 if(persist)writeJson(repoFile(root,packetRel(campaignPath,unitId)),packet);
 return packet;
}

// Discovery units are grouped by logical solo actor, not by browser or chat delivery.
// Flow/correctness must be sealed before a separate adversarial window opens.
const activeIdsOf=(state,chatKey=null)=>state.payload.order.filter(id=>state.payload.units[id]?.status==='ACTIVE'&&(!chatKey||state.payload.units[id].chatKey===chatKey));
const pendingIdsOf=(state,chatKey)=>state.payload.order.filter(id=>state.payload.units[id]?.status==='PENDING'&&state.payload.units[id].chatKey===chatKey);
const chatKeysOf=(state)=>[...new Set(state.payload.order.map(id=>state.payload.units[id]?.chatKey).filter(Boolean))];
function openWindowV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now,chatKey}){
 const pending=pendingIdsOf(state,chatKey);
 const correctnessPending=pending.some(id=>state.payload.units[id].role!=='ATTACK');
 const eligible=state.payload.sequentialSingleReviewer
   ?pending.filter(id=>correctnessPending
     ?state.payload.units[id].role!=='ATTACK'
     :state.payload.units[id].role==='ATTACK')
   :pending;
 const ids=[];
 let packetBytes=0,workItems=0;
 const sharedInputs=getInputs({root,campaignPath,automationRoot});
 for(const id of eligible.slice(0,SOLO_WINDOW_MAX_UNITS*3)){
  if(ids.length>=SOLO_WINDOW_MAX_UNITS)break;
  const packet=buildUnitPacketV1({root,campaignPath,directory,authorityRoot,automationRoot,unitId:id,state,now,sharedInputs,persist:false});
  const size=Buffer.byteLength(JSON.stringify(packet)),p=packet.payload??{};
  // Estimate actual reviewer effort as well as input size. Small units can
  // share a round, while an unusually large unit can always advance alone.
  const effort=2*arr(p.primaryContexts).length+3*arr(p.flows).length+
    2*arr(p.integrationQuestions).length+Math.ceil(arr(p.documentationItems).length/3)+
    2*arr(p.contractChecks).length+Math.max(1,arr(p.specContext).length);
  // Skip an oversized next unit rather than stopping and wasting the space
  // remaining in this round. The skipped unit stays pending in original order.
  if(ids.length&&(packetBytes+size>SOLO_WINDOW_MAX_PACKET_BYTES||
     workItems+effort>SOLO_WINDOW_MAX_WORK_ITEMS))continue;
  packetBytes+=size;workItems+=effort;
  writeJson(repoFile(root,packetRel(campaignPath,id)),packet);
  state.payload.units[id].status='ACTIVE';
  state.payload.units[id].openedAt??=now;
  ids.push(id);
 }
 return ids;
}
// Prepare active solo windows directly in the campaign; never queue messages or wake-ups.
export function openIdleSoloWindowsV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now,except=null}){
 const windows=[];
 for(const actorKey of chatKeysOf(state)){
  if(actorKey===except||activeIdsOf(state,actorKey).length||!pendingIdsOf(state,actorKey).length)continue;
  const ids=openWindowV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now,chatKey:actorKey});
  if(ids.length)windows.push(recordWindowV1({root,ids,state,campaignPath,authorityRoot}));
 }
 return windows;
}
// Extend the existing discovery index with bounded, lossless views of large
// assignment packets. The canonical packet remains unchanged for validation.
export function writeUnitPacketIndexV1({root,campaignPath,unitId,role}){
 const packetPath=packetRel(campaignPath,unitId);
 const packet=known(root,packetPath);
 if(!packet?.payload)throw new Error('missing issued discovery packet for '+unitId);
 const payload=packet.payload;
 const dir=pathJoin(campaignPath,'index/'+(role==='ATTACK'?'attacker':'flow-review'));
 const pages=[];
 let pageNumber=0;
 const writeSection=(section,items)=>{
  if(!items.length)return;
  let chunk=[],offset=0;
  const emit=()=>{
   if(!chunk.length)return;
   const file='UNIT_'+unitId+'_PAGE_'+String(++pageNumber).padStart(4,'0')+'_v1.json';
   const rel=path.posix.join(dir,file);
   const body={schemaVersion:'curveyield-discovery-packet-page-v1',unitId,sourcePacketPath:packetPath,
    section,offset,items:chunk};
   const bytes=Buffer.byteLength(JSON.stringify(body));
   writeJson(repoFile(root,rel),body);
   pages.push({path:rel,section,offset,count:chunk.length,bytes,
    ...(bytes>SOLO_PACKET_PAGE_MAX_BYTES?{oversizedSingleItem:true}:{})});
   offset+=chunk.length;chunk=[];
  };
  for(const [itemIndex,item] of items.entries()){
   const bytes=Buffer.from(JSON.stringify(item),'utf8');
   if(bytes.length>SOLO_PACKET_PAGE_MAX_BYTES-1500){
    emit();
    const pieces=[];
    for(let start=0;start<bytes.length;start+=12*1024)pieces.push(bytes.subarray(start,start+12*1024));
    for(const [n,piece] of pieces.entries()){
     chunk=[{kind:'JSON_FRAGMENT_BASE64',itemIndex,part:n+1,total:pieces.length,sha256:hex(bytes),base64:piece.toString('base64')}];
     emit();
    }
    continue;
   }
   const trial={schemaVersion:'curveyield-discovery-packet-page-v1',unitId,sourcePacketPath:packetPath,
    section,offset,items:[...chunk,item]};
   if(chunk.length&&Buffer.byteLength(JSON.stringify(trial))>SOLO_PACKET_PAGE_MAX_BYTES)emit();
   chunk.push(item);
  }
  emit();
 };
 for(const field of ['primaryContexts','documentationItems','siblingChecks','flows','integrationQuestions',
  'contractChecks','specContext'])writeSection(field,arr(payload[field]));
 if(payload.requiredClasses&&typeof payload.requiredClasses==='object')
  writeSection('requiredClasses',Object.entries(payload.requiredClasses).map(([contextId,classes])=>({contextId,classes})));
 for(const [field,items] of Object.entries(payload.systemFacts??{}))
  if(Array.isArray(items))writeSection('systemFacts.'+field,items);
 const indexRel=path.posix.join(dir,'UNIT_'+unitId+'_INDEX_v1.json');
 const index={schemaVersion:'curveyield-discovery-packet-section-index-v1',unitId,role,
  packetPath,submissionPath:payload.submissionPath??submissionRel(campaignPath,unitId),
  readingGuide:'Read assigned section pages and reconstruct any JSON_FRAGMENT_BASE64 item by joining ordered decoded pieces and verifying the serialized SHA-256. Preserve all original source context and rules. Save immutable worker/claim-epoch attempts, submit 1–5 completed units and immediately continue independent work without approval polling. Dependent units require persisted ACCEPTED.',
  primaryContextIds:arr(payload.primaryContextIds),
  flowIds:arr(payload.flowIds),integrationQuestionIds:arr(payload.integrationQuestionIds),
  trivialContextIds:arr(payload.trivialContextIds),
  sectionPages:pages};
 writeJson(repoFile(root,indexRel),index);
 return indexRel;
}
function writeDiscoveryWindowIndexV1({root,campaignPath,ids,role}){
 const dir=pathJoin(campaignPath,'index/'+(role==='ATTACK'?'attacker':'flow-review'));
 const pages=[];
 for(let i=0;i<ids.length;i+=25){
  const chunk=ids.slice(i,i+25);
  const file='PART_'+String(pages.length+1).padStart(4,'0')+'_v1.json';
  const rel=path.posix.join(dir,file);
  const payload={schemaVersion:'curveyield-discovery-unit-index-page-v1',
   unitIds:chunk,units:chunk.map(unitId=>({unitId,
    packetPath:packetRel(campaignPath,unitId),
    packetIndexPath:writeUnitPacketIndexV1({root,campaignPath,unitId,role}),
    submissionPath:submissionRel(campaignPath,unitId)}))};
  if(Buffer.byteLength(JSON.stringify(payload))>32*1024)throw new Error('discovery window page exceeds 32 KiB');
  writeJson(repoFile(root,rel),payload);
  pages.push({path:rel,unitCount:chunk.length});
 }
 const indexRel=path.posix.join(dir,'INDEX_v1.json');
 const index={schemaVersion:'curveyield-discovery-unit-index-v1',role,unitCount:ids.length,pages,
  readingGuide:'Read each unit index and only its needed section pages; save complete substantive submissions as work proceeds. Issue ONE existing boundary request with readyUnitIds listing completed active units (up to 8), not one workflow per unit. If a unit is blocked, preserve its unresolved facts in its existing fields and finish independent active units. Keep unfinished submissions as drafts; on DISCOVERY_NEXT immediately continue the next window in the same agent session. Rework only named failures; accepted work persists. All non-ATTACK correctness work, including RESIDUAL_REVIEW, precedes ATTACK.'};
 if(Buffer.byteLength(JSON.stringify(index))>32*1024)throw new Error('discovery window index exceeds 32 KiB');
 writeJson(repoFile(root,indexRel),index);
 return indexRel;
}
function recordWindowV1({root,ids,state,campaignPath,authorityRoot}){
 const role=state.payload.units[ids[0]].role==='ATTACK'?'ATTACK':'FLOW_REVIEW';
 const indexPath=writeDiscoveryWindowIndexV1({root,campaignPath,ids,role});
 return {role,unitIds:ids,indexPath};
}
export function startDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot,now,auditControllerRef='main'}){
 const plan=known(root,asset(root,campaignPath,'FLOW_PLAN_v1.json'));
 const units=unitList(plan),order=units.map(x=>x.unitId);
 const missing=!plan||!units.length;
 if(missing || (/\/lite-solo-v[3456]$/.test(authorityRoot) && (plan?.payload?.gaps??[]).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code))))
   throw new Error('LITE_SOLO_DISCOVERY_UNAVAILABLE: empty or incomplete required review plan is not complete coverage');
 if(directory.mode!=='LITE_SOLO'||![ 'Audit Skill - Lite-Solo Authority/lite-solo', 'Audit Skill - Lite-Solo Authority/lite-solo-v2', 'Audit Skill - Lite-Solo Authority/lite-solo-v3', 'Audit Skill - Lite-Solo Authority/lite-solo-v4', 'Audit Skill - Lite-Solo Authority/lite-solo-v5', 'Audit Skill - Lite-Solo Authority/lite-solo-v6' ].includes(authorityRoot))throw new Error('lite-solo discovery authority mismatch');
 const state=head(directory,now,'curveyield-discovery-state-v1',{
  status:'RUNNING',order,activeUnitId:order[0],
   sequentialSingleReviewer:true,
  ...( /(?:Audit_Litemode_v13|lite-solo(?:-v[23456])?)(?:\/|$)/.test(authorityRoot)?{reviewPolicy:'correctness-verdict-v13'}:{}),
  units:Object.fromEntries(units.map(x=>[x.unitId,{role:x.role,chatKey:x.role==='ATTACK'?(isReassignedV13AuthorityV1({root,authorityRoot})?'lite-solo-agent':/(?:Audit_Litemode_v13|lite-solo(?:-v[23456])?)(?:\/|$)/.test(authorityRoot)?'lite-solo-agent':'lite-solo-agent'):'lite-solo-agent',
   status:'PENDING',attempts:0,lastValidatedSubmissionSha:null,lastErrors:[],acceptedSubmissionSha:null}])),
  gaps:missing?[{code:'INVENTORY_INCOMPLETE',detail:'No flow plan'}]:structuredClone(arr(plan.payload.gaps))
 });
 writeJson(repoFile(root,stateRel(campaignPath)),state);
 const windows=openIdleSoloWindowsV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now});
 state.payload.activeUnitId=activeIdsOf(state)[0]??null;
 writeJson(repoFile(root,stateRel(campaignPath)),state);
 return {completeImmediately:false,state,statePath:stateRel(campaignPath),currentWindow:windows[0]??null,windows};
}
export function buildDiscoverySummaryV1({state,inventory,plan,acceptedSubmissions,taxonomy,now}){
 const rows=arr(acceptedSubmissions),checks=new Map(),candidates=[],paths=[],answers=[],na=[],contractLevel=[];
 for(const {unitId,submission} of rows){
  const isAttacker=unitId.startsWith('X-');
  if(isAttacker){paths.push(...arr(submission?.attackPaths));answers.push(...arr(submission?.integrationAnswers));continue;}
  candidates.push(...arr(submission?.candidates));
  for(const row of arr(submission?.rows)){
   const classMap=checks.get(row.contextId)??{};
   if(state?.payload?.reviewPolicy==='correctness-verdict-v13'){
     // The v13 security review is function-wide, not individual checklist rows.
     // Every triggered class is tracked under the explicit source-anchored verdict.
     const assessment={CORRECT:'SUPPORTED',DEFECT:'CONCERN',UNRESOLVED:'UNRESOLVED'}[row.verdict];
     if(!assessment)throw new Error('accepted v13 discovery row has no correctness verdict');
     for(const classId of classesForTriggersV1(taxonomy,inventory?.payload?.triggers?.[row.contextId]??[]))
       classMap[classId]=assessment;
     for(const c of arr(row.candidates))
       candidates.push({...c,contextIds:[...new Set([...(c.contextIds??[]),row.contextId])]});
     if(row.candidate&&typeof row.candidate==='object')
       candidates.push({...row.candidate,contextIds:[...new Set([...(row.candidate.contextIds??[]),row.contextId])]});
   }
   for(const check of arr(row?.checks)){
    classMap[check.classId]=check.assessment;
    if(check.assessment==='NOT_APPLICABLE')na.push({contextId:row.contextId,classId:check.classId,evidence:check.evidence,anchors:check.anchors});
    if(check.candidate)candidates.push({...check.candidate,contextIds:[row.contextId],classId:check.classId});
   }
   checks.set(row.contextId,classMap);
  }
  // Compact forms expand to the same per-context, per-class records the coverage matrix reads.
  const set=(id,classId,check)=>{
   const classMap=checks.get(id)??{};classMap[classId]=check.assessment;checks.set(id,classMap);
   if(check.assessment==='NOT_APPLICABLE')na.push({contextId:id,classId,evidence:check.evidence,anchors:check.anchors});
   if(check.candidate)candidates.push({...check.candidate,contextIds:[id],classId});
  };
  for(const group of arr(submission?.groupChecks))for(const id of arr(group?.contextIds))set(id,group.classId,group);
  const unit=resolveUnit(plan,unitId);
  for(const review of arr(submission?.trivialReviews))
   for(const id of arr(unit?.primaryContextIds)){
    const c=contextFor(inventory,id);
    if(c?.qualifiedContainer!==review?.contract||!TRIVIAL_KINDS_V1.has(c.kind))continue;
    for(const classId of classesForTriggersV1(taxonomy,inventory?.payload?.triggers?.[id]??[]))
      set(id,classId,state?.payload?.reviewPolicy==='correctness-verdict-v13'
        ?{...review,assessment:'SUPPORTED'}:review);
    if(!checks.has(id))checks.set(id,{});
   }
  contractLevel.push(...arr(submission?.contractChecks));
 }
 for(const check of contractLevel)
  for(const c of arr(inventory?.payload?.contexts).filter(x=>x.qualifiedContainer===check?.contract)){
   if(!classesForTriggersV1(taxonomy,inventory?.payload?.triggers?.[c.contextId]??[]).includes(check.classId))continue;
   if(checks.get(c.contextId)?.[check.classId]===undefined){
    const classMap=checks.get(c.contextId)??{};classMap[check.classId]=check.assessment;checks.set(c.contextId,classMap);
   }
  }
 const items=[],contradictions=[];
 const add=(origin,contextIds,anchor,reviewerFinding,attackerFinding)=>{
  const first=contextFor(inventory,contextIds?.[0]);
  items.push({recordKey:'DISC-'+String(items.length+1).padStart(4,'0'),origin,contextIds:[...new Set(contextIds??[])].sort(),
   sourceAnchor:anchor??contextAnchor(first),
   reviewerFinding:String(reviewerFinding??'NO_SUBMISSION').slice(0,600),
   attackerFinding:String(attackerFinding??'NO_SUBMISSION').slice(0,600)});
 };
 for(const candidate of candidates)add('REVIEWER_CANDIDATE',arr(candidate?.contextIds),candidate?.anchors?.[0]??candidate?.sourceAnchor,
  candidate?.description??candidate?.title,'NO_SUBMISSION');
 for(const [id,found] of [...checks.entries()].sort(([a],[b])=>sort(a,b)))
  for(const [classId,status] of Object.entries(found).sort(([a],[b])=>sort(a,b)))if(status==='UNRESOLVED')
   add('REVIEWER_UNRESOLVED',[id],null,'Unresolved '+classId,'NO_SUBMISSION');
 const relevant=paths.filter(p=>['VIABLE','UNCERTAIN'].includes(p?.result));
 for(const attack of relevant)add('ATTACK_FINDING',arr(attack.contextIds),attack?.anchors?.[0],'NO_SUBMISSION',attack?.candidate?.description??attack?.goal);
 for(const attack of relevant){
  const classId=attack?.candidate?.classId??attack?.classId;
  for(const anchor of arr(attack?.anchors)){
   const where=arr(inventory?.payload?.contexts).filter(c=>{
    const parsed=parseAnchorV1(anchor,inventory);
    return parsed&&c.path===parsed.path&&parsed.lineStart<=c.lineEnd&&parsed.lineEnd>=c.lineStart;
   });
   for(const c of where)if(checks.get(c.contextId)?.[classId]==='SUPPORTED'){
    contradictions.push({contextId:c.contextId,classId});
    add('ATTACK_CONTRADICTS_REVIEW',[c.contextId],anchor,'SUPPORTED '+classId,attack?.candidate?.description??attack?.goal);
   }
  }
 }
 for(const answer of answers.filter(a=>['CONCERN','UNRESOLVED'].includes(a?.assessment)))
  add('INTEGRATION_CONCERN',arr(answer.contextIds),answer?.anchors?.[0],'NO_SUBMISSION',answer?.reasoning);
 const gaps=structuredClone(arr(normalizeAccepted(state)?.gaps));
 for(const gap of gaps)add('COVERAGE_GAP',gap.contextId?[gap.contextId]:arr(gap.contextIds),null,'Gap '+gap.code,'NO_SUBMISSION');
 const discoveryState={reviewChecks:Object.fromEntries([...checks.entries()]),gaps,attackContradictions:contradictions};
 const coverage=buildCoverageMatrixV1({inventory,taxonomy,discoveryState});
 return head(state,now??state.generatedAt,'curveyield-discovery-summary-v1',{
  reconciliationItems:items,notApplicableClaims:na.sort((a,b)=>sort(a.contextId,b.contextId)||sort(a.classId,b.classId)),
  attackPaths:paths,perContext:Object.fromEntries([...checks.entries()].sort(([a],[b])=>sort(a,b))),
  gaps,coverage,discoveryState});
}
export function completeDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now}){
 state??=known(root,stateRel(campaignPath));
 // A missing-plan initialization has an empty unit order intentionally. In
 // populated plans, unaccepted units must never be sealed, even by a direct caller.
 const incomplete=state.payload.order.filter(id=>state.payload.units[id]?.status!=='ACCEPTED');
 if(incomplete.length)throw new Error('discovery cannot complete with required units outstanding: '+incomplete.join(', '));
 state.payload.status='COMPLETE';state.payload.activeUnitId=null;
 writeJson(repoFile(root,stateRel(campaignPath)),state);
 const inputs=getInputs({root,campaignPath,automationRoot});
 const inventory=inputs.inventory??head(directory,now,'curveyield-review-inventory-v1',{contexts:[],triggers:{},limitations:[],complete:false});
 const acceptedSubmissions=[];
 for(const id of state.payload.order){
  const row=known(root,pathJoin(campaignPath,id+'/ACCEPTED_SUBMISSION_v1.json'));
  if(row)acceptedSubmissions.push({unitId:id,submission:row});
 }
 const summary=buildDiscoverySummaryV1({state,inventory,plan:inputs.plan,acceptedSubmissions,taxonomy:inputs.taxonomy,now});
 writeJson(repoFile(root,pathJoin(campaignPath,'DISCOVERY_SUMMARY_v1.json')),summary);
 const obligations=deriveBaselineObligationsV1({inventory,taxonomy:inputs.taxonomy,summary});
 writeJson(repoFile(root,path.posix.join(campaignPath,'work/phase-06/BASELINE_OBLIGATIONS_v1.json')),obligations);
 const message='CONTROLLER: Phase 4 discovery is complete. Phase 4 is now ACTIVE for lite-solo-agent. Follow currentAssignment.workShardIndexPath and process the indexed editable shards; reconcile every prefilled discovery row using original source evidence when needed. The full DISCOVERY_SUMMARY is a controller input, not a required context dump. Finish Steps 1–3 in one session before one phase boundary request.';
 return {status:'DISCOVERY_COMPLETE',feedbackText:message,summary};
}
export function advanceDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot,unitId,readyUnitIds=[unitId],now,auditControllerRef='main'}){
 const state=known(root,stateRel(campaignPath));
 if(!state)throw new Error('discovery state missing');
 const unitState=state.payload.units[unitId];
 const chatKey=unitState?.chatKey;
 const active=chatKey?activeIdsOf(state,chatKey):[];
 // Older controller versions exhausted three validation attempts into a coverage
 // gap. An explicitly named, corrected unit may recover through real validation.
 const legacyGapRecovery=state.payload.reviewPolicy==='correctness-verdict-v13'&&
  unitState?.status==='GAP_RECORDED'&&
  arr(state.payload.gaps).some(x=>x.unitId===unitId&&x.code==='VALIDATION_ATTEMPTS_EXHAUSTED');
 if(!active.includes(unitId)&&!legacyGapRecovery)return {status:'DISCOVERY_STALE_REQUEST',
  feedbackText:'Unit '+unitId+' is not active. Current active unit: '+(active[0]??'none')+'; '+active.length+' unit(s) active. No action taken.'};
 // Only explicitly submitted ready IDs are validated. An existing submission file
 // alone never implies readiness. Bounds prevent one expensive unbounded review.
 if(!Array.isArray(readyUnitIds)||readyUnitIds.length<1||readyUnitIds.length>SOLO_WINDOW_MAX_UNITS||
   readyUnitIds[0]!==unitId||new Set(readyUnitIds).size!==readyUnitIds.length||
   readyUnitIds.some(id=>!active.includes(id)&&id!==unitId))
  throw new Error('invalid explicit ready discovery unit batch');
 const requestedUnits=readyUnitIds;
 const inventory=getInputs({root,campaignPath,automationRoot}).inventory;
 const accepted=[],rework=[],waiting=[],unchanged=[],feedback=[];
 for(const id of requestedUnits){
  const info=state.payload.units[id],relative=submissionRel(campaignPath,id),file=repoFile(root,relative);
  if(!fs.existsSync(file)){waiting.push(id);continue;}
  const bytes=fs.readFileSync(file),sha=hex(bytes);
  if(sha===info.lastValidatedSubmissionSha&&!legacyGapRecovery){
   unchanged.push(feedbackTextV1({errors:info.lastErrors},{attempt:info.attempts,maxAttempts:state.payload.reviewPolicy==='correctness-verdict-v13'?'until valid':3,submissionPath:relative,unitId:id}));
   continue;
  }
  const packet=known(root,packetRel(campaignPath,id));
  let result;
  try {
   const submission=JSON.parse(bytes.toString('utf8'));
   result=info.role==='ATTACK'?validateAttackSubmissionV1({packet:packet.payload,submission,inventory}):
    validateFlowReviewSubmissionV1({packet:packet.payload,submission,inventory});
  }catch(error){result={ok:false,errors:[{code:'SUBMISSION_SCHEMA',path:'$',message:String(error.message).slice(0,1000)}],value:null};}
  info.lastValidatedSubmissionSha=sha;info.lastErrors=result.errors;
  if(result.ok){
   fs.mkdirSync(path.dirname(repoFile(root,pathJoin(campaignPath,id+'/ACCEPTED_SUBMISSION_v1.json'))),{recursive:true});
   fs.writeFileSync(repoFile(root,pathJoin(campaignPath,id+'/ACCEPTED_SUBMISSION_v1.json')),bytes);
   info.status='ACCEPTED';info.acceptedSubmissionSha=sha;
   // Close a historical validation gap only on successful semantic validation,
   // whether it was explicitly retried or reopened by the controller.
   if(state.payload.reviewPolicy==='correctness-verdict-v13')
    state.payload.gaps=arr(state.payload.gaps)
     .filter(g=>!(g.unitId===id&&g.code==='VALIDATION_ATTEMPTS_EXHAUSTED'));
   if(packet.payload?.reviewPolicy==='correctness-verdict-v13')info.acceptedAt=now;
   accepted.push(id);
   continue;
  }
  info.attempts++;
  // An invalid submission remains reviewer-owned rework for as many distinct
  // corrections as necessary; never degrade missing verification into coverage.
  rework.push(id);
  feedback.push(feedbackTextV1(result,{attempt:info.attempts,
   maxAttempts:'until valid',submissionPath:relative,unitId:id}));
 }
 // Nothing new to validate: report and leave state untouched.
 if(!accepted.length&&!rework.length)return {status:'DISCOVERY_REWORK',
  feedbackText:unchanged.length?unchanged.join('\n\n'):'No submission found for selected unit '+unitId+'. No other draft was inspected or penalized.'};
 const summary=[accepted.length?'Accepted: '+accepted.join(', '):'',
  waiting.length?'Requested unit has no submission: '+waiting.join(', '):''].filter(Boolean).join('\n');
 const others=openIdleSoloWindowsV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now,except:chatKey});
 const finish=(status,feedbackText,currentWindow=null)=>{
  const stillActive=activeIdsOf(state,chatKey);
  // Legacy solo campaigns already opened 85+ units at once. Preserve their
  // accepted/draft state, but expose only two current units in the paged index.
  if(!currentWindow&&stillActive.length)
   currentWindow=recordWindowV1({root,ids:stillActive.slice(0,SOLO_WINDOW_MAX_UNITS),state,campaignPath,authorityRoot});
  state.payload.activeUnitId=activeIdsOf(state)[0]??null;
  writeJson(repoFile(root,stateRel(campaignPath)),state);
  const windows=[...(currentWindow?[currentWindow]:[]),...others];
  return {status,feedbackText,currentWindow:windows[0]??null,windows};
 };
 const remaining=activeIdsOf(state,chatKey);
 if(remaining.length){
  if(rework.length){
   const text=[summary,...feedback,...unchanged].filter(Boolean).join('\n\n');
   // Detailed rework feedback is durable in the discovery folder; no delivery message is generated.
   const feedbackRel=pathJoin(campaignPath,'DISCOVERY_FEEDBACK_v1.md');
   fs.writeFileSync(repoFile(root,feedbackRel),text+'\n');
   return finish('DISCOVERY_REWORK',text,recordWindowV1({root,ids:rework,state,campaignPath,authorityRoot}));
  }
  // Some units still unsubmitted and nothing failed: the solo actor is mid-window.
  return finish('DISCOVERY_PARTIAL',summary,null);
 }
 const ids=openWindowV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now,chatKey});
 if(ids.length){
   const next=recordWindowV1({root,ids,state,campaignPath,authorityRoot});
   const detail='\nDISCOVERY_NEXT: lite-solo-agent must complete the '+next.role+' window before advancing. Active unit IDs: '+ids.join(', ')+(next.indexPath?' (index: '+next.indexPath+')':'')+'.';
   return finish('DISCOVERY_NEXT',summary+detail,next);
 }
 // Historical three-attempt gaps cannot silently finish correctness coverage.
 // Reopen only those formerly failed units; do not redo accepted work.
 const legacyGaps=state.payload.reviewPolicy==='correctness-verdict-v13'
  ?state.payload.order.filter(id=>state.payload.units[id]?.status==='GAP_RECORDED'): [];
 if(legacyGaps.length){
  const reopen=legacyGaps.slice(0,SOLO_WINDOW_MAX_UNITS);
  for(const id of reopen)state.payload.units[id].status='ACTIVE';
  const next=recordWindowV1({root,ids:reopen,state,campaignPath,authorityRoot});
  return finish('DISCOVERY_NEXT',summary+'\nPreviously exhausted correctness units require actual revalidation: '+reopen.join(', ')+'. No other work was discarded.',next);
 }
 // An empty eligible window is not proof that all required work is accepted.
 if(activeIdsOf(state).length)return finish('DISCOVERY_PARTIAL',summary+'\nSome solo discovery units are still active.',null);
 const incomplete=state.payload.order.filter(id=>state.payload.units[id]?.status!=='ACCEPTED');
 if(incomplete.length)return finish('DISCOVERY_REWORK',summary+
  '\nRequired discovery units remain unaccepted or unschedulable: '+incomplete.join(', ')+
  '. Correct the scheduling/state conflict; no work was sealed or discarded.',null);
 return completeDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot,state,now});
}
