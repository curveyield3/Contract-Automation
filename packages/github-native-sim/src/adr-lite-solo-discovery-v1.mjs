import fs from 'node:fs';
import {isReassignedV13AuthorityV1 as originalV13SingleV1} from '../../../scripts/lib/lite-authority-lineup-v1.mjs';
const isReassignedV13AuthorityV1=({authorityRoot,...params})=>authorityRoot==='Audit Skill - Lite-Solo Authority/lite-solo'||originalV13SingleV1({authorityRoot,...params});
import path from 'node:path';
import {createHash} from 'node:crypto';
import {classesForTriggersV1,loadTaxonomyV1} from './adr-taxonomy-v1.mjs';
import {buildCoverageMatrixV1} from './adr-coverage-matrix-v1.mjs';
import {deriveBaselineObligationsV1} from './adr-baseline-obligations-v1.mjs';
import {validateFlowReviewSubmissionV1,validateAttackSubmissionV1,feedbackTextV1,parseAnchorV1,TRIVIAL_KINDS_V1,isLiteralConstantV13,qualifiesLiteralTrivialReviewV13} from './adr-discovery-validators-v1.mjs';
import {repoFile,readJson,writeJson} from '../../../scripts/lib/lite-solo-phase-work-v1.mjs';
import {reviewInventoryRelV1} from './adr-review-inventory-v1.mjs';
import {independentSpecItemsV13} from './adr-lite-solo-independent-spec-v1.mjs';
// V13 qualification status is assessed independently after real blinded audit runs.
const MACHINE_AUTHORITY_V7='Machine Intelligence Audit Controller/Audit Skill v7';

const pathJoin=(campaign,relative)=>path.posix.join(campaign,'work/phase-04/discovery',relative);
const asset=(root,campaign,name)=>reviewInventoryRelV1(root,campaign,name);
const known=(root,rel)=>{
 const file=repoFile(root,rel);
 if(!fs.existsSync(file))return null;
 const stored=readJson(file);
 return stored?.schemaVersion==='curveyield-discovery-assignment-packet-manifest-v1'
  ?readUnitPacketV1({root,packetPath:rel}):stored;
};
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const arr=x=>Array.isArray(x)?x:[];

// A source reference is an address into the persisted accepted artifact.
// acceptedSha256 is its exact file-byte digest; the queue's acceptedSha256
// separately identifies the submission/compiled attempt bytes.
export function discoverySourceReferenceV1({source,unitId,role,sourceSelector,
 sourceField=null,originalAnchorsSelector=null,recordIdentity={}}){
 const available=typeof source?.acceptedPath==='string'&&
  /^[a-f0-9]{64}$/.test(String(source?.acceptedSha256??''));
 return {availability:available?'AVAILABLE':'SOURCE_UNAVAILABLE',
  phaseSequence:source?.phaseSequence??4,unitId,role,
  acceptedPath:available?source.acceptedPath:null,
  acceptedSha256:available?source.acceptedSha256:null,
  submittedPath:source?.submittedPath??null,
  submittedSha256:source?.submittedSha256??null,
  submittedRepresentation:source?.submittedRepresentation??null,
  originalWorkerAttempt:source?.originalWorkerAttempt??{availability:'NOT_RECORDED'},
  sourceSelector:available?sourceSelector:null,
  sourceField,originalAnchorsSelector:available?originalAnchorsSelector:null,
  recordIdentity};
}

// Provenance-only address book: no vulnerability classification, merging,
// promotion or alteration to the issued reconciliation record fields.
export function discoveryObservationSourceRefsV1(acceptedSubmissions){
 const refs=[];
 const collections=[
  ['rows','FLOW_ROW',['reason','intent']],
  ['candidates','REVIEWER_CANDIDATE',['description','title']],
  ['groupChecks','GROUP_CHECK',['evidence','reason']],
  ['trivialReviews','TRIVIAL_REVIEW',['evidence','reason']],
  ['contractChecks','CONTRACT_CHECK',['evidence','reason']],
  ['attackPaths','ATTACK_PATH',['goal','description']],
  ['integrationAnswers','INTEGRATION_ANSWER',['reasoning','reason']],
  ['flowNotes','FLOW_NOTE',['note','text','reason']]
 ];
 for(const {unitId,submission,sourceReference} of arr(acceptedSubmissions)){
  const role=unitId?.startsWith('X-')?'ATTACK':'FLOW';
  const prefix=sourceReference?.sourceSelectorPrefix===''
   ?'':(sourceReference?.sourceSelectorPrefix??'submission')+'.';
  const add=(record,category,selector,preferred)=>{
   if(record===null||record===undefined)return;
   const isRecord=typeof record==='object'&&!Array.isArray(record);
   const identity={};
   for(const name of ['contextId','contextIds','flowId','flowIds','pathId','obligationId',
    'candidateId','tempKey','classId','contract','assessment','applicability',
    'ruleId','signature','siblingContextId'])
    if(isRecord&&Object.hasOwn(record,name))identity[name]=structuredClone(record[name]);
   const sourceField=isRecord?
    preferred.find(name=>Object.hasOwn(record,name))??null:null;
   const anchorField=isRecord?
    ['anchors','sourceAnchors','sourceAnchor'].find(name=>Object.hasOwn(record,name)):null;
   refs.push({sourceCategory:category,
    ...discoverySourceReferenceV1({source:sourceReference,unitId,role,
     sourceSelector:prefix+selector,sourceField,
     originalAnchorsSelector:anchorField?prefix+selector+'.'+anchorField:null,
     recordIdentity:identity})});
  };
  for(const [field,category,preferred] of collections)
   arr(submission?.[field]).forEach((record,index)=>{
    const selector=field+'['+index+']';
    add(record,category,selector,preferred);
    if(record?.candidate)add(record.candidate,category+'_CANDIDATE',
     selector+'.candidate',['description','title']);
    arr(record?.candidates).forEach((candidate,i)=>
     add(candidate,category+'_CANDIDATE',selector+'.candidates['+i+']',
      ['description','title']));
    if(field==='rows')arr(record?.checks).forEach((check,i)=>{
     const checkSelector=selector+'.checks['+i+']';
     add(check,'FLOW_CLASS_CHECK',checkSelector,['evidence','reason']);
     if(check?.candidate)add(check.candidate,'FLOW_CLASS_CHECK_CANDIDATE',
      checkSelector+'.candidate',['description','title']);
    });
   });
 }
 return refs;
}
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
const PACKET_PART_BYTES=12*1024;
const PACKET_PART_MAX=24*1024;
function packetPartPath(packetPath,i){
 return path.posix.join(path.posix.dirname(packetPath),'packet-pages',
  'CHUNK_'+String(i+1).padStart(6,'0')+'_v1.json');
}
function packetIndexPartPath(indexPath,i){
 return path.posix.join(path.posix.dirname(indexPath),
  path.posix.basename(indexPath,'.json')+'_PART_'+String(i+1).padStart(6,'0')+'_v1.json');
}
export function readUnitPacketIndexV1({root,indexPath}){
 const index=readJson(repoFile(root,indexPath));
 if(index.schemaVersion!=='curveyield-discovery-packet-section-index-manifest-v1')
  return index; // Small existing index or historical authority.
 if(!Number.isSafeInteger(index.pageCount)||index.pageCount<1||
    index.partBytes!==PACKET_PART_BYTES||!/^[a-f0-9]{64}$/.test(index.sha256))
  throw Error('invalid discovery index manifest');
 const pieces=[];
 for(let i=0;i<index.pageCount;i++){
  const part=readJson(repoFile(root,packetIndexPartPath(indexPath,i)));
  if(part.schemaVersion!=='curveyield-discovery-packet-index-chunk-v1'||
     part.index!==i+1||part.total!==index.pageCount||
     part.offset!==i*PACKET_PART_BYTES||part.encoding!=='base64')
   throw Error('discovery index page identity mismatch');
  const bytes=Buffer.from(part.data,'base64');
  if(bytes.length>PACKET_PART_BYTES||hex(bytes)!==part.sha256)
   throw Error('discovery index page checksum mismatch');
  pieces.push(bytes);
 }
 const joined=Buffer.concat(pieces);
 if(joined.length!==index.byteLength||hex(joined)!==index.sha256)
  throw Error('discovery index aggregate checksum mismatch');
 const full=JSON.parse(joined.toString('utf8'));
 if(full.schemaVersion!=='curveyield-discovery-packet-section-index-v1'||
    full.unitId!==index.unitId||full.role!==index.role||
    full.packetPath!==index.packetPath)
  throw Error('discovery index content identity mismatch');
 return full;
}
// v4 stores a bounded packet manifest and immutable small pages; only trusted
// validators reconstruct the complete source-bound packet in memory.
function writePagedPacketV1({root,packetPath,packet}){
 const raw=Buffer.from(JSON.stringify(packet,null,2)+'\n','utf8');
 const count=Math.ceil(raw.length/PACKET_PART_BYTES);
 for(let i=0;i<count;i++){
  const part=raw.subarray(i*PACKET_PART_BYTES,(i+1)*PACKET_PART_BYTES);
  const page={schemaVersion:'curveyield-discovery-packet-chunk-v1',
   index:i+1,total:count,offset:i*PACKET_PART_BYTES,
   sha256:hex(part),encoding:'base64',data:part.toString('base64')};
  if(Buffer.byteLength(JSON.stringify(page,null,2)+'\n')>PACKET_PART_MAX)
   throw Error('discovery source packet page exceeds 24 KiB: '+packetPath);
  writeJson(repoFile(root,packetPartPath(packetPath,i)),page);
 }
 const manifest={schemaVersion:'curveyield-discovery-assignment-packet-manifest-v1',
  unitId:packet.payload.unitId,campaignGenerationId:packet.campaignGenerationId,
  sourceSha256:packet.sourceSha256,sha256:hex(raw),byteLength:raw.length,
  partBytes:PACKET_PART_BYTES,pageCount:count,
  readingGuide:'Read the controller-issued paged unit section index. This manifest binds the exact complete source packet without storing a giant single JSON record.'};
 writeJson(repoFile(root,packetPath),manifest);
}
export function readUnitPacketV1({root,packetPath}){
 const manifest=readJson(repoFile(root,packetPath));
 if(manifest.schemaVersion!=='curveyield-discovery-assignment-packet-manifest-v1')
  return manifest; // Unchanged historical transport remains readable.
 if(!Number.isSafeInteger(manifest.pageCount)||manifest.pageCount<1||
    manifest.partBytes!==PACKET_PART_BYTES||!/^[a-f0-9]{64}$/.test(manifest.sha256))
  throw Error('invalid paged discovery packet manifest');
 const chunks=[];
 for(let i=0;i<manifest.pageCount;i++){
  const part=readJson(repoFile(root,packetPartPath(packetPath,i)));
  if(part.schemaVersion!=='curveyield-discovery-packet-chunk-v1'||
     part.index!==i+1||part.total!==manifest.pageCount||
     part.offset!==i*PACKET_PART_BYTES||part.encoding!=='base64')
   throw Error('discovery packet fragment index/offset mismatch');
  const chunk=Buffer.from(part.data,'base64');
  if(chunk.length>PACKET_PART_BYTES||hex(chunk)!==part.sha256)
   throw Error('discovery packet fragment sha256 mismatch');
  chunks.push(chunk);
 }
 const raw=Buffer.concat(chunks);
 if(raw.length!==manifest.byteLength||hex(raw)!==manifest.sha256)
  throw Error('discovery packet aggregate SHA-256 mismatch');
 const packet=JSON.parse(raw.toString('utf8'));
 if(packet.payload?.unitId!==manifest.unitId||
    packet.campaignGenerationId!==manifest.campaignGenerationId||
    packet.sourceSha256!==manifest.sourceSha256)
  throw Error('discovery packet identity mismatch');
 return packet;
}
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
 const verdictV13=authorityRoot===MACHINE_AUTHORITY_V7||authorityRoot==='Machine Intelligence Audit Controller/Audit Skill v8';
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
 // Preserve exact inherited concerns; the auditor, not transport, selects relevance.
 const phase1Path=path.posix.join(campaignPath,'derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json');
 const phase1=known(root,phase1Path);
 const packet=head(directory,now,'curveyield-discovery-assignment-packet-v1',{
  ...(authorityRoot==='Machine Intelligence Audit Controller/Audit Skill v8'?{phase1DiscoveryContext:{sourcePath:phase1Path,status:phase1?'AVAILABLE':'UNAVAILABLE',actions:phase1?.actions??null}}:{}),
  unitId,role,chatKey:role==='ATTACK'?(isReassignedV13AuthorityV1({root,authorityRoot})?'lite-solo-agent':verdictV13?'lite-solo-agent':'lite-solo-agent'):'lite-solo-agent',instructionsPath,
  submissionPath:path.posix.join(campaignPath,'work/phase-04/units',unitId,'submissions/<workerId>/epoch-<claimEpoch>/SUBMISSION_ATTEMPT_001_v1.json'),boundaryRequestPath:'process/agent-upload/lite-solo-unit-requests/',
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
 if(persist){
  const rel=packetRel(campaignPath,unitId);
  if(['/lite-solo-v4','/lite-solo-v5'].some(suffix=>authorityRoot.endsWith(suffix)))
   writePagedPacketV1({root,packetPath:rel,packet});
  else writeJson(repoFile(root,rel),packet);
 }
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
  const bodyFor=(content,at)=>({schemaVersion:'curveyield-discovery-packet-page-v1',
   unitId,sourcePacketPath:packetPath,section,offset:at,items:content});
  // Check the actual on-disk pretty JSON, including its trailing newline.
  const diskBytes=(content,at)=>Buffer.byteLength(JSON.stringify(bodyFor(content,at),null,2)+'\n');
  const emit=()=>{
   if(!chunk.length)return;
   const file='UNIT_'+unitId+'_PAGE_'+String(++pageNumber).padStart(4,'0')+'_v1.json';
   const rel=path.posix.join(dir,file);
   const body=bodyFor(chunk,offset),bytes=diskBytes(chunk,offset);
   if(bytes>SOLO_PACKET_PAGE_MAX_BYTES)
    throw Error('source packet section page exceeds 24 KiB; planner must split source item');
   writeJson(repoFile(root,rel),body);
   pages.push({path:rel,section,offset,count:chunk.length,bytes});
   chunk=[];
  };
  for(const [itemIndex,item] of items.entries()){
   // Single oversized semantic items are split into lossless JSON byte fragments
   // with the original itemIndex and whole-item SHA-256 preserved on every page.
   if(diskBytes([item],itemIndex)>SOLO_PACKET_PAGE_MAX_BYTES){
    emit();
    const raw=Buffer.from(JSON.stringify(item),'utf8');
    const parts=[];
    for(let start=0;start<raw.length;start+=12*1024)
     parts.push(raw.subarray(start,start+12*1024));
    for(const [n,part] of parts.entries()){
     offset=itemIndex;
     chunk=[{kind:'JSON_FRAGMENT_BASE64',itemIndex,part:n+1,total:parts.length,
      sha256:hex(raw),base64:part.toString('base64')}];
     emit();
    }
    offset=itemIndex+1;
    continue;
   }
   if(chunk.length&&diskBytes([...chunk,item],offset)>SOLO_PACKET_PAGE_MAX_BYTES)
    emit();
   if(!chunk.length)offset=itemIndex;
   chunk.push(item);
  }
  emit();
 };
 for(const field of ['primaryContexts','documentationItems','siblingChecks','flows','integrationQuestions',
  'contractChecks','specContext'])writeSection(field,arr(payload[field]));
 if(payload.phase1DiscoveryContext)writeSection('phase1DiscoveryContext',[payload.phase1DiscoveryContext]);
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
 // Keep each single unit-index file bounded even when a unit has many pages
 // or unusually many context/flow identifiers. Never truncate source links.
 const indexRaw=Buffer.from(JSON.stringify(index,null,2)+'\n','utf8');
 if(indexRaw.length<=32*1024){
  writeJson(repoFile(root,indexRel),index);
 }else{
  const n=Math.ceil(indexRaw.length/PACKET_PART_BYTES);
  for(let i=0;i<n;i++){
   const chunk=indexRaw.subarray(i*PACKET_PART_BYTES,(i+1)*PACKET_PART_BYTES);
   const page={schemaVersion:'curveyield-discovery-packet-index-chunk-v1',
    index:i+1,total:n,offset:i*PACKET_PART_BYTES,
    sha256:hex(chunk),encoding:'base64',data:chunk.toString('base64')};
   if(Buffer.byteLength(JSON.stringify(page,null,2)+'\n')>32*1024)
    throw Error('source packet index page exceeds 32 KiB');
   writeJson(repoFile(root,packetIndexPartPath(indexRel,i)),page);
  }
  writeJson(repoFile(root,indexRel),{
   schemaVersion:'curveyield-discovery-packet-section-index-manifest-v1',
   unitId,role,packetPath,
   byteLength:indexRaw.length,sha256:hex(indexRaw),
   partBytes:PACKET_PART_BYTES,pageCount:n,
   readingGuide:'The complete unit index is losslessly paged. Read UNIT_<unitId>_INDEX_PART_NNNNNN_v1.json in ascending order; verify each part SHA-256; concatenate its decoded base64 bytes and verify the full sha256 before interpreting sectionPages and source IDs. Work only this unit; never omit a section.',
  });
 }
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
export function startDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot,now,auditControllerRef='machine-intelligence-audit-controller-v1'}){
 const plan=known(root,asset(root,campaignPath,'FLOW_PLAN_v1.json'));
 const units=unitList(plan),order=units.map(x=>x.unitId);
 const missing=!plan||!units.length;
 if(missing || (/\/lite-solo-v[3456]$/.test(authorityRoot) && (plan?.payload?.gaps??[]).some(g=>['INVENTORY_INCOMPLETE','PLAN_BUILD_ERROR'].includes(g?.code))))
   throw new Error('LITE_SOLO_DISCOVERY_UNAVAILABLE: empty or incomplete required review plan is not complete coverage');
 if(directory.mode!=='LITE_SOLO'||authorityRoot!==MACHINE_AUTHORITY_V7)throw new Error('Machine Intelligence discovery authority mismatch');
 const state=head(directory,now,'curveyield-discovery-state-v1',{
  status:'RUNNING',order,activeUnitId:order[0],
   sequentialSingleReviewer:true,
  reviewPolicy:'correctness-verdict-v13',
  units:Object.fromEntries(units.map(x=>[x.unitId,{role:x.role,chatKey:x.role==='ATTACK'?('lite-solo-agent'):'lite-solo-agent',
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
 const discoverySourceRefs=discoveryObservationSourceRefsV1(rows);
 // Non-canonical ATTACK extras remain in their original immutable Worker
 // attempt, with exact selector and hash. They are not promoted into findings.
 const unmappedAttackPathRefs=[],unmappedAttackPathSources=[],extraAttackPathRefs=[];
 for(const {unitId,sourceReference} of rows){
  if(!unitId?.startsWith('X-'))continue;
  unmappedAttackPathSources.push({unitId,
   availability:sourceReference?.unmappedAttackPathExtractionStatus??
    'ORIGINAL_ATTEMPT_UNAVAILABLE'});
  for(const ref of arr(sourceReference?.unmappedAttackPathRefs))
   unmappedAttackPathRefs.push({...structuredClone(ref),unitId,
    acceptedPath:sourceReference?.acceptedPath??null,
    acceptedSha256:sourceReference?.acceptedSha256??null});
  // Every extra ATTACK path, including those successfully placed into the
  // issued-flow attackPaths array, keeps its ORIGINAL Worker selector and hash.
  for(const ref of arr(sourceReference?.extraAttackPathRefs))
   extraAttackPathRefs.push({...structuredClone(ref),unitId,
    acceptedPath:sourceReference?.acceptedPath??null,
    acceptedSha256:sourceReference?.acceptedSha256??null});
 }
 // Source selectors and array indices are taken from the original accepted
 // records. Never associate observations by similar prose or inferred IDs.
 const sourceIndexBySelector=new Map(discoverySourceRefs.map((ref,index)=>
  [JSON.stringify([ref.unitId,ref.sourceSelector]),index]));
 const sourcePrefixes=new Map(rows.map(({unitId,sourceReference})=>[unitId,
  sourceReference?.sourceSelectorPrefix===''?'':(sourceReference?.sourceSelectorPrefix??'submission')+'.']));
 const sourceIndex=(unitId,selector)=>sourceIndexBySelector.get(
  JSON.stringify([unitId,(sourcePrefixes.get(unitId)??'submission.')+selector]))??null;
 const uniqueIndexes=indexes=>[...new Set(indexes.filter(Number.isInteger))];
 const candidateEvidence=[],candidateOrigins=[],pathEvidence=[],answerEvidence=[],integrationAnswerRefs=[],flowNotes=[],checkEvidence=new Map();
 const functionVerdictObservations=[];
 const functionVerdicts=new Map(),trivialReviewSubstitutions=[],contractLevelFindings=[];
 const issuedFlows=arr(plan?.payload?.flows);
 const recordCandidate=(candidate,indexes,origin='REVIEWER_CANDIDATE')=>{
  if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return;
  candidates.push(candidate);
  candidateEvidence.push(uniqueIndexes(indexes));
  candidateOrigins.push(origin);
 };
 // Preserve accepted class-scoped candidates using the existing reconciliation
 // stream even when no group or contract verdict is projected onto functions.
 // The parent supplies only the identifiers explicitly written by the AI.
 const recordCheckCandidates=(check,unitId,selector,scope={})=>{
  const parentSource=sourceIndex(unitId,selector);
  const include=(candidate,candidateSelector)=>{
   if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))return;
   const scoped=structuredClone(candidate);
   if(scoped.classId===undefined&&scope.classId!==undefined)
    scoped.classId=scope.classId;
   if(scoped.contextIds===undefined&&scope.contextIds!==undefined)
    scoped.contextIds=structuredClone(scope.contextIds);
   recordCandidate(scoped,[sourceIndex(unitId,candidateSelector),parentSource]);
  };
  include(check?.candidate,selector+'.candidate');
  arr(check?.candidates).forEach((candidate,index)=>
   include(candidate,selector+'.candidates['+index+']'));
 };
 const recordCheck=(contextId,classId,index)=>checkEvidence.set(
  JSON.stringify([contextId,classId]),index);
 const checkSource=(contextId,classId)=>checkEvidence.get(
  JSON.stringify([contextId,classId]))??null;
 for(const {unitId,submission} of rows){
  const isAttacker=unitId.startsWith('X-');
  // FLOW and ATTACK answers are independent, even when their obligationIds
  // overlap or their assessments conflict. Never merge or classify them here.
  arr(submission?.integrationAnswers).forEach((answer,i)=>{
   const selector='integrationAnswers['+i+']';
   const sourceRefIndex=sourceIndex(unitId,selector);
   const sourceRef=Number.isInteger(sourceRefIndex)?
    discoverySourceRefs[sourceRefIndex]:null;
   const originalSelector=sourceRef?.sourceSelector??null;
   const candidateRefIndex=answer?.candidate?
    sourceIndex(unitId,selector+'.candidate'):null;
   answers.push(answer);answerEvidence.push(sourceRefIndex);
   // An explicitly supplied nested candidate deserves its own reconciliation
   // subject even if the integration answer is not classified CONCERN.
   if(answer?.candidate)recordCandidate(answer.candidate,
    [candidateRefIndex,sourceRefIndex],isAttacker?'ATTACK_INTEGRATION_CANDIDATE':
    'FLOW_INTEGRATION_CANDIDATE');
   integrationAnswerRefs.push({
    unitId,role:isAttacker?'ATTACK':'FLOW',originalIndex:i,
    obligationId:answer?.obligationId??null,assessment:answer?.assessment??null,
    // The accepted snapshot at discoverySourceRefs[sourceRefIndex] retains
    // verbatim reasoning, every anchor and the complete optional candidate.
    // Selectors avoid duplicating substantive evidence into another summary.
    sourceReference:{collection:'discoverySourceRefs',
     index:sourceRefIndex,availability:sourceRef?.availability??'SOURCE_UNAVAILABLE'},
    reasoningSelector:originalSelector&&Object.hasOwn(answer??{},'reasoning')?
     originalSelector+'.reasoning':null,
    anchorsSelector:sourceRef?.originalAnchorsSelector??null,
    candidateSelector:originalSelector&&Object.hasOwn(answer??{},'candidate')?
     originalSelector+'.candidate':null,
    candidateSourceRefIndex: candidateRefIndex,
   });
  });
  if(isAttacker){
   arr(submission?.attackPaths).forEach((attack,i)=>{
    const pathRef=sourceIndex(unitId,'attackPaths['+i+']');
    paths.push(attack);pathEvidence.push(pathRef);
    if(attack?.candidate)recordCandidate(attack.candidate,
     [sourceIndex(unitId,'attackPaths['+i+'].candidate'),pathRef],
     'ATTACK_CANDIDATE');
    arr(attack?.candidates).forEach((candidate,j)=>recordCandidate(candidate,
     [sourceIndex(unitId,'attackPaths['+i+'].candidates['+j+']'),pathRef],
     'ATTACK_CANDIDATE'));
   });
   continue;
  }
  // Preserve every FLOW note as original evidence, not as a candidate or a
  // reconciliation deficiency. The accepted record and its SHA-256 supply
  // immutable provenance; the issued plan supplies existing flow/context links.
  const issuedUnit=resolveUnit(plan,unitId);
  arr(submission?.flowNotes).forEach((note,index)=>{
   const sourceRefIndex=sourceIndex(unitId,'flowNotes['+index+']');
   const sourceRef=Number.isInteger(sourceRefIndex)?
    discoverySourceRefs[sourceRefIndex]:null;
   const flowId=note?.flowId??null;
   const planFlowIndex=issuedFlows.findIndex(flow=>flow?.flowId===flowId);
   const issuedFlow=planFlowIndex<0?null:issuedFlows[planFlowIndex];
   flowNotes.push({
    unitId,flowId,originalIndex:index,
    // This single snapshot preserves the exact AI-authored note and all
    // anchors, including any extra fields present in older issued schemas.
    originalNote:structuredClone(note),
    acceptedPath:sourceRef?.acceptedPath??null,
    acceptedSha256:sourceRef?.acceptedSha256??null,
    sourceReference:{collection:'discoverySourceRefs',index:sourceRefIndex,
     availability:sourceRef?.availability??'SOURCE_UNAVAILABLE',
     sourceSelector:sourceRef?.sourceSelector??null,
     originalAnchorsSelector:sourceRef?.originalAnchorsSelector??null},
    issuedFlowRelationship:{
     availability:issuedFlow?'ISSUED_FLOW':'NOT_IN_ISSUED_PLAN',
     flowPlanSelector:issuedFlow?'payload.flows['+planFlowIndex+']':null,
     entryContextId:issuedFlow?.entryContextId??null,
     contextIds:arr(issuedFlow?.contexts),
     contracts:arr(issuedFlow?.contracts),
     unitClusterId:issuedUnit?.clusterId??null,
     unitFlowIds:arr(issuedUnit?.flowIds),
     unitPrimaryContextIds:arr(issuedUnit?.primaryContextIds),
     unitReadContextIds:arr(issuedUnit?.readContextIds)
    }
   });
  });
  arr(submission?.candidates).forEach((candidate,i)=>
   recordCandidate(candidate,[sourceIndex(unitId,'candidates['+i+']')]));
  for(const [rowIndex,row] of arr(submission?.rows).entries()){
   // An unreadable/malformed authored value is still addressable in the
   // original accepted source roster. It must not abort summary packaging.
   if(!row||typeof row!=='object'||Array.isArray(row))continue;
   const rowSource=sourceIndex(unitId,'rows['+rowIndex+']');
   if(state?.payload?.reviewPolicy==='correctness-verdict-v13'){
     // Preserve the complete AI-authored function verdict independently from
     // class assessments. The verdict does not prove every triggered class.
     // The Worker owns completeness and verdict validity. GitHub packages
     // missing or contradictory answers without a semantic rejection.
     const acceptedRowSource=Number.isInteger(rowSource)?discoverySourceRefs[rowSource]:null;
     const verdictObservation={
       unitId,originalIndex:rowIndex,contextId:row?.contextId??null,
       originalRow:structuredClone(row),
       originalSourceRefIndex:rowSource
     };
     functionVerdictObservations.push(verdictObservation);
     // Keep the conventional per-context view for existing consumers. The
     // observation roster above retains distinct repeated/conflicting rows.
     functionVerdicts.set(row.contextId,{
       // Clone all original answer fields, including intent, reason, anchors,
       // candidate(s), decidingTest and any schema-specific review details.
       ...structuredClone(row),
       sourceReference:{
         collection:'discoverySourceRefs',index:rowSource,unitId,
         availability:acceptedRowSource?.availability??'SOURCE_UNAVAILABLE',
         sourceSelector:acceptedRowSource?.sourceSelector??null,
         originalAnchorsSelector:acceptedRowSource?.originalAnchorsSelector??null,
         acceptedPath:acceptedRowSource?.acceptedPath??null,
         acceptedSha256:acceptedRowSource?.acceptedSha256??null
       }
     });
     arr(row.candidates).forEach((c,i)=>{
      if(!c||typeof c!=='object'||Array.isArray(c))return;
      recordCandidate({...structuredClone(c),contextIds:[...new Set([...arr(c.contextIds),row.contextId])]},
       [sourceIndex(unitId,'rows['+rowIndex+'].candidates['+i+']'),rowSource]);
     });
     if(row.candidate&&typeof row.candidate==='object'&&!Array.isArray(row.candidate))
       recordCandidate({...structuredClone(row.candidate),
        contextIds:[...new Set([...arr(row.candidate.contextIds),row.contextId])]},
        [sourceIndex(unitId,'rows['+rowIndex+'].candidate'),rowSource]);
     // Nested row.checks can contain independently authored candidates even
     // when checks are informational prompts rather than class verdicts.
     arr(row?.checks).forEach((check,j)=>recordCheckCandidates(check,unitId,
      'rows['+rowIndex+'].checks['+j+']',{}));
   }
   // V13 row.checks are prompts, not accepted class assessments.
   // Preserve the independently authored per-class responses for legacy rows.
   if(state?.payload?.reviewPolicy!=='correctness-verdict-v13'){
    const classMap=checks.get(row.contextId)??{};
    for(const [checkIndex,check] of arr(row?.checks).entries()){
     const checkRef=sourceIndex(unitId,'rows['+rowIndex+'].checks['+checkIndex+']');
     classMap[check.classId]=check.assessment;
     recordCheck(row.contextId,check.classId,checkRef);
     if(check.assessment==='NOT_APPLICABLE')na.push({contextId:row.contextId,classId:check.classId,evidence:check.evidence,anchors:check.anchors});
     if(check.candidate)recordCandidate(
      {...check.candidate,contextIds:[row.contextId],classId:check.classId},
      [sourceIndex(unitId,'rows['+rowIndex+'].checks['+checkIndex+'].candidate'),checkRef,rowSource]);
    }
    checks.set(row.contextId,classMap);
   }
  }
  // Compact forms expand to the same per-context, per-class records the coverage matrix reads.
  const set=(id,classId,check,sourceRef,sourceParent,sourceCandidate)=>{
   const classMap=checks.get(id)??{};classMap[classId]=check.assessment;checks.set(id,classMap);
   recordCheck(id,classId,sourceRef);
   if(check.assessment==='NOT_APPLICABLE')na.push({contextId:id,classId,evidence:check.evidence,anchors:check.anchors});
   if(check.candidate)recordCandidate({...check.candidate,contextIds:[id],classId},
    [sourceCandidate,sourceRef,sourceParent]);
  };
  // Shared-modifier group claims remain scoped to the AI's named contexts.
  // In V13 only accepted candidates enter reconciliation, not a synthetic
  // SUPPORTED/CONCERN assessment for every grouped function.
  arr(submission?.groupChecks).forEach((group,index)=>{
   const selector='groupChecks['+index+']';
   if(state?.payload?.reviewPolicy==='correctness-verdict-v13')
    recordCheckCandidates(group,unitId,selector,{
     classId:group?.classId,contextIds:arr(group?.contextIds)
    });
   else for(const id of arr(group?.contextIds))
    set(id,group.classId,group,
     sourceIndex(unitId,selector),null,sourceIndex(unitId,selector+'.candidate'));
  });
  const unit=resolveUnit(plan,unitId);
  arr(submission?.trivialReviews).forEach((review,index)=>{
   const selector='trivialReviews['+index+']';
   if(state?.payload?.reviewPolicy==='correctness-verdict-v13'){
    // An eligible literal-constant review substitutes for its context row.
    // It is not a separate assessment of every triggered security class.
    const qualifiedContextIds=arr(unit?.primaryContextIds).filter(id=>
     qualifiesLiteralTrivialReviewV13({
      review,context:contextFor(inventory,id),inventory
     }));
    const refIndex=sourceIndex(unitId,selector);
    const sourceRef=Number.isInteger(refIndex)?discoverySourceRefs[refIndex]:null;
    trivialReviewSubstitutions.push({
     unitId,contract:review?.contract??null,
     qualifiedContextIds,acceptedSubstitution:qualifiedContextIds.length>0,
     assessment:review?.assessment??null,
     originalReview:structuredClone(review),
     sourceReference:{
      collection:'discoverySourceRefs',index:refIndex,
      availability:sourceRef?.availability??'SOURCE_UNAVAILABLE',
      sourceSelector:sourceRef?.sourceSelector??null,
      originalAnchorsSelector:sourceRef?.originalAnchorsSelector??null,
      acceptedPath:sourceRef?.acceptedPath??null,
      acceptedSha256:sourceRef?.acceptedSha256??null
     }
    });
    // Retain any AI-authored nested candidate without inventing class
    // identity or treating its review as contract-wide proof.
    recordCheckCandidates(review,unitId,selector);
    return;
   }
   // Preserve historical legacy class-check representation.
   for(const id of arr(unit?.primaryContextIds)){
    const c=contextFor(inventory,id);
    if(!qualifiesLiteralTrivialReviewV13({review,context:c,inventory}))continue;
    for(const classId of classesForTriggersV1(taxonomy,inventory?.payload?.triggers?.[id]??[]))
     set(id,classId,review,sourceIndex(unitId,selector),null,sourceIndex(unitId,selector+'.candidate'));
    if(!checks.has(id))checks.set(id,{});
   }
  });
  arr(submission?.contractChecks).forEach((check,index)=>{
   const selector='contractChecks['+index+']';
   const sourceRefIndex=sourceIndex(unitId,selector);
   const acceptedSource=Number.isInteger(sourceRefIndex)?
    discoverySourceRefs[sourceRefIndex]:null;
   contractLevel.push({check,sourceRef:sourceRefIndex});
   if(state?.payload?.reviewPolicy==='correctness-verdict-v13'){
    // Retain the accepted contract-wide assertion at its original scope.
    // A contract check is not a separate assessment of every function.
    contractLevelFindings.push({
     unitId,contract:check?.contract??null,classId:check?.classId??null,
     assessment:check?.assessment??null,
     originalCheck:structuredClone(check),
     sourceReference:{
      collection:'discoverySourceRefs',index:sourceRefIndex,
      availability:acceptedSource?.availability??'SOURCE_UNAVAILABLE',
      sourceSelector:acceptedSource?.sourceSelector??null,
      originalAnchorsSelector:acceptedSource?.originalAnchorsSelector??null,
      acceptedPath:acceptedSource?.acceptedPath??null,
      acceptedSha256:acceptedSource?.acceptedSha256??null
     }
    });
   }
   // Keep the candidate's authored class without assigning context IDs.
   recordCheckCandidates(check,unitId,selector,{classId:check?.classId});
  });

 }
 // Historical summaries retain their earlier representation. For V13,
 // contract-wide assertions never populate function-class coverage.
 if(state?.payload?.reviewPolicy!=='correctness-verdict-v13')
  for(const {check,sourceRef} of contractLevel)
  for(const c of arr(inventory?.payload?.contexts).filter(x=>x.qualifiedContainer===check?.contract)){
   if(!classesForTriggersV1(taxonomy,inventory?.payload?.triggers?.[c.contextId]??[]).includes(check.classId))continue;
   if(checks.get(c.contextId)?.[check.classId]===undefined){
    const classMap=checks.get(c.contextId)??{};classMap[check.classId]=check.assessment;checks.set(c.contextId,classMap);
    recordCheck(c.contextId,check.classId,sourceRef);
   }
  }
 const items=[],contradictions=[],reconciliationEvidenceRefs={};
 // Existing 600-character finding fields and first sourceAnchor remain
 // backward-compatible PREVIEWS. Complete evidence is the indexed original.
 const add=(origin,contextIds,anchor,reviewerFinding,attackerFinding,sourceIndexes=[],controllerSourceSelector=null)=>{
  const first=contextFor(inventory,contextIds?.[0]);
  const recordKey='DISC-'+String(items.length+1).padStart(4,'0');
  items.push({recordKey,origin,contextIds:[...new Set(contextIds??[])].sort(),
   sourceAnchor:anchor??contextAnchor(first),
   reviewerFinding:String(reviewerFinding??'NO_SUBMISSION').slice(0,600),
   attackerFinding:String(attackerFinding??'NO_SUBMISSION').slice(0,600)});
  const refIndexes=uniqueIndexes(sourceIndexes);
  reconciliationEvidenceRefs[recordKey]={
   referenceCollection:'discoverySourceRefs',sourceRefIndexes:refIndexes,
   availability:refIndexes.length===0?'SOURCE_UNAVAILABLE':
    refIndexes.every(i=>discoverySourceRefs[i]?.availability==='AVAILABLE')?'AVAILABLE':'SOURCE_UNAVAILABLE',
   ...(controllerSourceSelector?{controllerSourceSelector}:{}),
  };
 };
 candidates.forEach((candidate,index)=>add(candidateOrigins[index],arr(candidate?.contextIds),
  candidate?.anchors?.[0]??candidate?.sourceAnchor,
  candidate?.description??candidate?.title,'NO_SUBMISSION',candidateEvidence[index]));
 for(const [id,found] of [...checks.entries()].sort(([a],[b])=>sort(a,b)))
  for(const [classId,status] of Object.entries(found).sort(([a],[b])=>sort(a,b)))if(status==='UNRESOLVED')
   add('REVIEWER_UNRESOLVED',[id],null,'Unresolved '+classId,'NO_SUBMISSION',
    [checkSource(id,classId)]);
 // Explicit SUPPORTED group/contract assessments remain at their authored
 // scope. Their source identities can be paired with an attacker claim, but
 // cannot be promoted into independent per-function class conclusions.
 const scopedSupportedRefs=state?.payload?.reviewPolicy==='correctness-verdict-v13'
  ?discoverySourceRefs.flatMap((ref,index)=>
   ref.role==='FLOW'&&['GROUP_CHECK','CONTRACT_CHECK'].includes(ref.sourceCategory)&&
   ref.recordIdentity?.assessment==='SUPPORTED'?[{ref,index}]:[])
  :[];
 const relevant=paths.map((attack,index)=>({attack,sourceRef:pathEvidence[index]}))
  .filter(({attack})=>['VIABLE','UNCERTAIN'].includes(attack?.result));
 for(const {attack,sourceRef} of relevant)add('ATTACK_FINDING',
  arr(attack.contextIds),attack?.anchors?.[0],'NO_SUBMISSION',
  attack?.candidate?.description??attack?.goal,[sourceRef]);
 for(const {attack,sourceRef} of relevant){
  // Read the claimed class only from the accepted attacker observation.
  // Source-triggered classes and overall function verdicts are not claims.
  const classId=attack?.candidate?.classId??attack?.classId??null;
  const visitedContexts=new Set();
  for(const anchor of arr(attack?.anchors)){
   const parsed=parseAnchorV1(anchor,inventory);
   if(!parsed)continue;
   const where=arr(inventory?.payload?.contexts).filter(c=>
    c.path===parsed.path&&parsed.lineStart<=c.lineEnd&&parsed.lineEnd>=c.lineStart);
   for(const c of where){
    // Preserve all original anchors in the accepted attack path, but route
    // each attacker/context pair only once for reconciliation.
    if(visitedContexts.has(c.contextId))continue;
    visitedContexts.add(c.contextId);
    const functionReview=functionVerdicts.get(c.contextId);
    const functionRef=functionReview?.sourceReference?.index??null;
    const classAssessment=typeof classId==='string'&&classId.length?
     checks.get(c.contextId)?.[classId]:null;
    const scopedMatches=typeof classId==='string'&&classId.length?
     scopedSupportedRefs.filter(({ref})=>
      ref.recordIdentity?.classId===classId&&
      (ref.sourceCategory==='GROUP_CHECK'
       ?arr(ref.recordIdentity?.contextIds).includes(c.contextId)
       :ref.recordIdentity?.contract===c.qualifiedContainer)):[];
    if(classAssessment==='SUPPORTED'){
     // This is an actual class-specific reviewer assertion. Record the
     // conflicting AI observations; the controller does not adjudicate them.
     contradictions.push({contextId:c.contextId,classId});
     add('ATTACK_CONTRADICTS_REVIEW',[c.contextId],anchor,'SUPPORTED '+classId,
      attack?.candidate?.description??attack?.goal,
      [sourceRef,checkSource(c.contextId,classId),functionRef]);
    }else if(scopedMatches.length){
     // A same-class SUPPORTED claim exists, but only at the accepted GROUP
     // or CONTRACT scope. Route competing claims as source evidence instead
     // of fabricating a function-specific ATTACK_CONTRADICTS_REVIEW verdict.
     const originalScopes=scopedMatches.map(({ref})=>
      ref.sourceCategory==='GROUP_CHECK'
       ?'GROUP '+arr(ref.recordIdentity?.contextIds).join(',')
       :'CONTRACT '+String(ref.recordIdentity?.contract??''));
     add('ATTACK_SCOPED_CLASS_REVIEW_OVERLAP',[c.contextId],anchor,
      'Explicit '+classId+' SUPPORTED at original scope: '+originalScopes.join('; ')+
       '; this does not establish the class for each function',
      String(attack?.result??'')+' attack path: '+
       String(attack?.candidate?.description??attack?.goal??''),
      [sourceRef,...scopedMatches.map(x=>x.index),functionRef]);
     if(!Number.isInteger(sourceRef)||
      (functionReview?.verdict==='CORRECT'&&!Number.isInteger(functionRef)))
      reconciliationEvidenceRefs[items[items.length-1].recordKey].availability='SOURCE_UNAVAILABLE';
    }else if(state?.payload?.reviewPolicy==='correctness-verdict-v13'&&
     functionReview?.verdict==='CORRECT'){
     // Overlap with CORRECT is not a class-level contradiction. Send both
     // original source-bound AI observations to Phase 4 for reconciliation.
     add('ATTACK_FUNCTION_REVIEW_OVERLAP',[c.contextId],anchor,
      'Function verdict CORRECT (not class-level SUPPORTED): '+
       String(functionReview.reason??''),
      String(attack?.result??'')+' attack path: '+
       String(attack?.candidate?.description??attack?.goal??''),
      [sourceRef,functionRef]);
     const link=reconciliationEvidenceRefs[items[items.length-1].recordKey];
     // An available attacker source alone must never imply the reviewer
     // source was available too (and vice versa).
     if(!Number.isInteger(sourceRef)||!Number.isInteger(functionRef))
      link.availability='SOURCE_UNAVAILABLE';
    }
   }
  }
 }
 answers.forEach((answer,index)=>{
  if(['CONCERN','UNRESOLVED'].includes(answer?.assessment))
   add('INTEGRATION_CONCERN',arr(answer.contextIds),answer?.anchors?.[0],
    'NO_SUBMISSION',answer?.reasoning,[answerEvidence[index]]);
 });
 const gaps=structuredClone(arr(normalizeAccepted(state)?.gaps));
 gaps.forEach((gap,index)=>add('COVERAGE_GAP',
  gap.contextId?[gap.contextId]:arr(gap.contextIds),null,
  'Gap '+gap.code,'NO_SUBMISSION',[],'state.payload.gaps['+index+']'));
 // Supply every unmapped ATTACK extra record as an independent Phase 4
 // reconciliation subject. Identity and source are exact; disposition belongs
 // to the AI, and existing reconciliation records retain their old keys.
 unmappedAttackPathRefs.forEach((ref,index)=>{
  const identity=ref.originalPathId??ref.sourceSelector??'UNMAPPED_ATTACK_PATH';
  add('ATTACK_UNMAPPED_FLOW',[],null,'NO_SUBMISSION',
   'ATTACK extra path '+String(identity)+
   '; inspect its complete original Worker-authored evidence.',
   []);
  const recordKey=items[items.length-1].recordKey;
  reconciliationEvidenceRefs[recordKey]={
   referenceCollection:'unmappedAttackPathRefs',sourceRefIndexes:[index],
   availability:ref.originalWorkerAttempt?.availability==='AVAILABLE'?
    'AVAILABLE':'SOURCE_UNAVAILABLE',
   originalRecordSelector:ref.sourceSelector??null
  };
 });
 const verdictRecords=Object.fromEntries([...functionVerdicts.entries()].sort(([a],[b])=>sort(a,b)));
 const discoveryState={reviewChecks:Object.fromEntries([...checks.entries()]),gaps,attackContradictions:contradictions,
  ...(state?.payload?.reviewPolicy==='correctness-verdict-v13'?{
   reviewPolicy:'correctness-verdict-v13',
   // Carry only source-bound function review identity into the coverage ledger.
   // Complete AI evidence remains available as functionVerdicts in the summary.
   functionVerdicts:Object.fromEntries(Object.entries(verdictRecords).map(([id,record])=>
    [id,{verdict:record.verdict,sourceReference:record.sourceReference}])),
   trivialReviewSubstitutions:trivialReviewSubstitutions.map(review=>({
    unitId:review.unitId,qualifiedContextIds:review.qualifiedContextIds,
    acceptedSubstitution:review.acceptedSubstitution,sourceReference:review.sourceReference
   })),
   // Keep explicitly scoped group/contract claims visible as source-bound
   // observations, never as automatically established function-class claims.
   scopedClassAssessments:discoverySourceRefs.flatMap((ref,index)=>
    ref.role==='FLOW'&&['GROUP_CHECK','CONTRACT_CHECK'].includes(ref.sourceCategory)
     ?[{
      scope:ref.sourceCategory==='GROUP_CHECK'?'GROUP':'CONTRACT',
      contextIds:arr(ref.recordIdentity?.contextIds),
      contract:ref.recordIdentity?.contract??null,
      classId:ref.recordIdentity?.classId??null,
      assessment:ref.recordIdentity?.assessment??null,
      applicability:ref.recordIdentity?.applicability??null,
      sourceReference:{collection:'discoverySourceRefs',index,availability:ref.availability,
       sourceSelector:ref.sourceSelector,acceptedPath:ref.acceptedPath,
       acceptedSha256:ref.acceptedSha256}
     }]:[])
  }:{})};
 const coverage=buildCoverageMatrixV1({inventory,taxonomy,discoveryState});
 return head(state,now??state.generatedAt,'curveyield-discovery-summary-v1',{
  discoverySourceRefs,reconciliationEvidenceRefs,integrationAnswerRefs,flowNotes,
  functionVerdicts:verdictRecords,functionVerdictObservations,
  ...(state?.payload?.reviewPolicy==='correctness-verdict-v13'
   ?{trivialReviewSubstitutions,contractLevelFindings}:{}),
  unmappedAttackPathRefs,unmappedAttackPathSources,extraAttackPathRefs,
  // All candidate origins, including nested ATTACK/integration/check
  // candidates, remain accessible by exact accepted-source selector.
  candidateSourceRefIndexes:discoverySourceRefs.flatMap((ref,index)=>
   ref.sourceCategory==='REVIEWER_CANDIDATE'||ref.sourceCategory.endsWith('_CANDIDATE')?[index]:[]),
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
  const acceptedPath=pathJoin(campaignPath,id+'/ACCEPTED_SUBMISSION_v1.json');
  const row=known(root,acceptedPath);
  if(row)acceptedSubmissions.push({unitId:id,submission:row,
   sourceReference:{phaseSequence:4,unitId:id,acceptedPath,
    acceptedSha256:hex(fs.readFileSync(repoFile(root,acceptedPath))),
    sourceSelectorPrefix:'',submittedPath:null,submittedSha256:null,
    submittedRepresentation:'LEGACY_DIRECT_ACCEPTED_SUBMISSION',
    originalWorkerAttempt:{availability:'NOT_RECORDED'}}});
 }
 const summary=buildDiscoverySummaryV1({state,inventory,plan:inputs.plan,acceptedSubmissions,taxonomy:inputs.taxonomy,now});
 writeJson(repoFile(root,pathJoin(campaignPath,'DISCOVERY_SUMMARY_v1.json')),summary);
 const obligations=deriveBaselineObligationsV1({inventory,taxonomy:inputs.taxonomy,summary});
 writeJson(repoFile(root,path.posix.join(campaignPath,'work/phase-06/BASELINE_OBLIGATIONS_v1.json')),obligations);
 const message='CONTROLLER: Phase 4 discovery is complete. Phase 4 is now ACTIVE for lite-solo-agent. Follow currentAssignment.workShardIndexPath and process the indexed editable shards; reconcile every prefilled discovery row using original source evidence when needed. The full DISCOVERY_SUMMARY is a controller input, not a required context dump. Finish Steps 1–3 in one session before one phase boundary request.';
 return {status:'DISCOVERY_COMPLETE',feedbackText:message,summary};
}
export function advanceDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot,unitId,readyUnitIds=[unitId],now,auditControllerRef='machine-intelligence-audit-controller-v1'}){
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
