export const DEFAULT_LIMITS=Object.freeze({maxPrimaryContextsPerUnit:40,maxFlowDepth:8,maxIntegrationQuestionsPerAttackUnit:15});
const uniq=a=>[...new Set((a??[]).filter(x=>x!==null&&x!==undefined))].sort();
const pad=(n,l)=>String(n).padStart(l,'0');
const cmp=(a,b)=>String(a).localeCompare(String(b));
const bySource=(a,b)=>cmp(a.path,b.path)||Number(a.lineStart??0)-Number(b.lineStart??0)||cmp(a.contextId,b.contextId);
const owners=c=>uniq(c?.effectiveIn?.length?c.effectiveIn:[c?.qualifiedContainer].filter(Boolean));
const artifact=(inventory,payload)=>({schemaVersion:'curveyield-flow-plan-v1',campaignId:inventory.campaignId,
 campaignGenerationId:inventory.campaignGenerationId,sourceSha256:inventory.sourceSha256,
 taxonomyVersion:inventory.taxonomyVersion,detectionPolicy:inventory.detectionPolicy,generatedAt:inventory.generatedAt,payload});
function components(names){
 const parents=new Map(names.map(x=>[x,x]));
 const find=x=>{if(!parents.has(x))parents.set(x,x);if(parents.get(x)!==x)parents.set(x,find(parents.get(x)));return parents.get(x);};
 return {join(a,b){if(!a||!b)return;const x=find(a),y=find(b);if(x!==y)parents.set(cmp(x,y)<0?y:x,cmp(x,y)<0?x:y);},
  groups(){const sets=new Map();for(const k of parents.keys()){const id=find(k),v=sets.get(id)??[];v.push(k);sets.set(id,v);}
  return [...sets.values()].map(uniq).sort((a,b)=>cmp(a[0],b[0]));}};
}
export function buildFlowPlanV1({inventory,facts,snapshot=null,limits=DEFAULT_LIMITS}) {
 if(!inventory||!facts)throw new TypeError('inventory and facts are required');
 const cfg={...DEFAULT_LIMITS,...limits};
 for(const k of Object.keys(DEFAULT_LIMITS))if(!Number.isInteger(cfg[k])||cfg[k]<1)throw new TypeError('invalid '+k);
 const ctxs=[...(inventory.payload?.contexts??[])].filter(c=>['IN_SCOPE','INHERITED_DEPENDENCY'].includes(c.scopeTier)).sort(bySource);
 const byId=new Map(ctxs.map(c=>[c.contextId,c])),bySymbol=new Map(ctxs.map(c=>[c.symbolId,c]));
 const triggers=inventory.payload?.triggers??{},data=facts.payload??{};
 const edges=[...(data.crossContractEdges??[])].sort((a,b)=>cmp(a.fromContextId,b.fromContextId)||cmp(a.toType,b.toType)||cmp(a.memberName,b.memberName));
 const contracts=uniq(ctxs.flatMap(owners)),graph=components(contracts);
 const targetContexts=(e)=>ctxs.filter(c=>owners(c).includes(e.toType)||c.qualifiedContainer===e.toType||
   (c.implementedInterfaces??[]).some(n=>n===e.toType||n.split(':').at(-1)===String(e.toType).split(':').at(-1)));
 for(const edge of edges) {
  const from=owners(byId.get(edge.fromContextId)??{qualifiedContainer:edge.fromContract});
  const targets=targetContexts(edge);
  for(const c of targets)for(const a of from)for(const b of owners(c))graph.join(a,b);
  if(contracts.includes(edge.toType))graph.join(edge.fromContract,edge.toType);
 }
 const sharedBase=new Map();
 for(const c of ctxs)for(const base of c.directBases??[]){
  const list=sharedBase.get(base)??new Set();for(const owner of owners(c))list.add(owner);sharedBase.set(base,list);
 }
 for(const list of sharedBase.values()){const values=uniq([...list]);for(const b of values.slice(1))graph.join(values[0],b);}
 for(const e of data.valueFlows??[])if(e.toContract)graph.join(e.contract,e.toContract);
 const entryKinds=new Set(['FUNCTION','FALLBACK','RECEIVE','INHERITED_DEPENDENCY']);
 const entries=ctxs.filter(c=>entryKinds.has(c.kind)&&['public','external'].includes(c.visibility)&&
  (triggers[c.contextId]??[]).some(x=>['STATE_WRITE_EXTERNAL','PAYABLE','EXTERNAL_CALL'].includes(x)));
 const flows=[];
 for(const entry of entries){
  const seen=new Set(),queue=[{id:entry.contextId,depth:0}];let depthLimited=false;
  while(queue.length){
   const {id,depth}=queue.shift();if(seen.has(id)||!byId.has(id))continue;
   seen.add(id);
   const c=byId.get(id),to=new Set();
   for(const sym of [...(c.internalCalls??[]),...(c.dependencySymbolIds??[])])if(bySymbol.has(sym))to.add(bySymbol.get(sym).contextId);
   for(const m of c.modifiers??[])for(const n of ctxs)if(n.kind==='MODIFIER'&&n.canonicalSignature.startsWith(m+'(')&&
      (n.qualifiedContainer===c.qualifiedContainer||owners(n).some(x=>owners(c).includes(x))))to.add(n.contextId);
   for(const e of edges.filter(x=>x.fromContextId===id))for(const target of targetContexts(e))
    for(const n of ctxs)if(owners(n).some(x=>owners(target).includes(x))&&n.canonicalSignature.split('(')[0]===e.memberName)
      to.add(n.contextId);
   const fresh=uniq([...to]).filter(x=>!seen.has(x));
   if(depth>=cfg.maxFlowDepth){if(fresh.length)depthLimited=true;continue;}
   for(const next of fresh)queue.push({id:next,depth:depth+1});
  }
  const found=[...seen],names=uniq(found.flatMap(id=>owners(byId.get(id))));
  flows.push({flowId:'FLOW-'+pad(flows.length+1,4),entryContextId:entry.contextId,contexts:found,contracts:names,
   crossContract:names.length>1,depthLimited});
 }
 for(const c of ctxs)if(c.effectiveIn?.length>1)for(const other of c.effectiveIn.slice(1))graph.join(c.effectiveIn[0],other);
 for(const flow of flows)for(const n of flow.contracts.slice(1))graph.join(flow.contracts[0],n);
 const clusters=graph.groups().map((names,i)=>({clusterId:'CL-'+pad(i+1,3),contracts:names,
  flowIds:flows.filter(f=>f.contracts.some(x=>names.includes(x))).map(f=>f.flowId)}));
 const clusterIds=new Map(clusters.flatMap(c=>c.contracts.map(x=>[x,c.clusterId])));
 const clusterOf=c=>clusterIds.get(c)??null;
 const reviewUnits=[],primary=new Set();let fIndex=0,rIndex=0;
 for(const cluster of clusters){
  let unit=null;
  const flush=()=>{if(unit){unit.readContextIds=uniq(unit.readContextIds);reviewUnits.push(unit);unit=null;}};
  for(const f of flows.filter(x=>cluster.flowIds.includes(x.flowId))){
   const newly=f.contexts.filter(x=>!primary.has(x));
   if(unit&&unit.primaryContextIds.length+newly.length>cfg.maxPrimaryContextsPerUnit)flush();
   if(!unit)unit={unitId:'F-'+pad(++fIndex,3),role:'FLOW_REVIEW',clusterId:cluster.clusterId,
     flowIds:[],primaryContextIds:[],readContextIds:[],oversize:false};
   unit.flowIds.push(f.flowId);unit.primaryContextIds.push(...newly);unit.readContextIds.push(...f.contexts);
   for(const id of newly)primary.add(id);
   if(unit.primaryContextIds.length>cfg.maxPrimaryContextsPerUnit){unit.oversize=true;flush();}
  }
  flush();
 }
 const unused=new Map();
 for(const c of ctxs.filter(x=>!primary.has(x.contextId))){
   const group=unused.get(c.qualifiedContainer)??[];group.push(c);unused.set(c.qualifiedContainer,group);
 }
 for(const contract of [...unused.keys()].sort()){
  const list=unused.get(contract);
  for(let i=0;i<list.length;i+=cfg.maxPrimaryContextsPerUnit){
   const current=list.slice(i,i+cfg.maxPrimaryContextsPerUnit);
   const related=ctxs.filter(c=>c.qualifiedContainer===contract||owners(c).some(x=>current.some(y=>owners(y).includes(x))));
   reviewUnits.push({unitId:'R-'+pad(++rIndex,3),role:'RESIDUAL_REVIEW',
    primaryContextIds:current.map(x=>x.contextId),readContextIds:uniq(related.map(x=>x.contextId))});
   for(const c of current)primary.add(c.contextId);
  }
 }
 const questions=[];
 const ask=(kind,names,contexts,evidence,question)=>{
   const namesSorted=uniq(names);
   questions.push({obligationId:'IOB-'+pad(questions.length+1,4),kind,
    clusterId:namesSorted.map(clusterOf).find(Boolean)??null,contracts:namesSorted,
    contextIds:uniq(contexts),evidence:uniq(evidence),question});
 };
 const pairEdges=new Map();
 for(const e of edges)for(const target of targetContexts(e))
  for(const a of owners(byId.get(e.fromContextId)??{qualifiedContainer:e.fromContract}))
   for(const b of owners(target))if(a!==b){
    const key=uniq([a,b]).join('|'),arr=pairEdges.get(key)??[];arr.push(e);pairEdges.set(key,arr);
   }
 for(const key of [...pairEdges.keys()].sort()){
  const [a,b]=key.split('|'),list=pairEdges.get(key);
  ask('CROSS_CONTRACT_CALL',[a,b],list.map(x=>x.fromContextId),list.map(x=>x.fromContextId+':L'+x.line),
    'Do the calls between '+a+' and '+b+" preserve each contract's invariants and authorization assumptions in every order, re-entry and failure case?");
 }
 const dependencies=new Map();
 for(const e of data.dependencyEdges??[]){
  const key=e.fromContract+'|'+e.toType,arr=dependencies.get(key)??[];arr.push(e);dependencies.set(key,arr);
 }
 for(const key of [...dependencies.keys()].sort()){
  const [a,dep]=key.split('|'),list=dependencies.get(key);
  ask('DEPENDENCY_ASSUMPTION',[a],list.map(x=>x.fromContextId),list.map(x=>x.fromContextId+':L'+x.line),
    "Are "+a+"'s assumptions about "+dep+" (return values, callbacks, rounding, access control) correct?");
 }
 for(const group of [...(data.siblingGroups??[])].filter(x=>x.asymmetric).sort((a,b)=>cmp(a.signature,b.signature))){
  const names=uniq(group.members.map(x=>x.contract));
  ask('SIBLING_GUARD_ASYMMETRY',names,ctxs.filter(c=>names.includes(c.qualifiedContainer)&&c.canonicalSignature===group.signature).map(c=>c.contextId),
    group.members.map(m=>m.contract+':'+group.signature),
    'Is the guard difference on '+group.signature+' across '+names.join(', ')+' intended, and is the unguarded variant exploitable?');
 }
 const outgoing=new Map();
 for(const e of data.valueFlows??[])if(e.toContract){const set=outgoing.get(e.contract)??new Set();set.add(e.toContract);outgoing.set(e.contract,set);}
 for(const a of [...outgoing.keys()].sort())if(outgoing.get(a).size>1){
  const list=(data.valueFlows??[]).filter(e=>e.contract===a);
  ask('VALUE_FLOW_CONSERVATION',[a,...outgoing.get(a)],list.map(x=>x.contextId),list.map(x=>x.contextId+':L'+x.line),
   'Is value conserved across all outgoing value flows of '+a+'?');
 }
 for(const row of [...(data.guardTable??[])].filter(x=>!x.hasGuard).sort((a,b)=>cmp(a.contract,b.contract)||cmp(a.contextId,b.contextId))){
  ask('UNGUARDED_EXTERNAL_STATE_WRITE',[row.contract],[row.contextId],(row.txOriginLines??[]).map(x=>row.contextId+':L'+x),
   'Who can call '+row.function+' on '+row.contract+', and what can they achieve with it?');
 }
 for(const flow of flows)if(flow.crossContract&&flow.contexts.some(id=>(triggers[id]??[]).some(x=>
    ['EXTERNAL_CALL_BEFORE_STATE_WRITE','ARBITRARY_TARGET_CALL'].includes(x)))){
  ask('CROSS_CONTRACT_REENTRY',flow.contracts,flow.contexts,[flow.flowId],
   'Can an attacker re-enter or redirect '+flow.flowId+' across '+flow.contracts.join(', ')+' to break state or steal value?');
 }
 if(snapshot?.status==='CAPTURED'){
  const deployed=uniq((snapshot.rows??[]).map(x=>x.contract));
  ask('DEPLOYED_CONFIGURATION',deployed,ctxs.filter(c=>c.kind==='CONSTRUCTOR'&&deployed.some(n=>owners(c).includes(n))).map(c=>c.contextId),
    ['DEPLOYED_STATE_SNAPSHOT_v1.json'],'Do the deployed owners, roles and allowlists match the intended configuration?');
  for(const c of ctxs.filter(c=>c.kind==='CONSTRUCTOR'&&deployed.some(n=>owners(c).includes(n))))
    triggers[c.contextId]=uniq([...(triggers[c.contextId]??[]),'DEPLOY_ROLE_STATE']);
 }
 const attackUnits=[];let xi=0;
 for(const cluster of clusters){
  const qs=questions.filter(q=>q.clusterId===cluster.clusterId);
  for(let i=0;i<Math.max(1,Math.ceil(qs.length/cfg.maxIntegrationQuestionsPerAttackUnit));i++)
   // A cluster's flows are attacked once, in its first unit; follow-on units (split only by the
   // integration-question cap) carry their questions alone instead of re-attacking every flow.
   attackUnits.push({unitId:'X-'+pad(++xi,3),role:'ATTACK',clusterId:cluster.clusterId,
    flowIds:i===0?cluster.flowIds:[],contracts:cluster.contracts,
    integrationQuestionIds:qs.slice(i*cfg.maxIntegrationQuestionsPerAttackUnit,(i+1)*cfg.maxIntegrationQuestionsPerAttackUnit).map(q=>q.obligationId)});
 }
 const gaps=[];
 for(const c of ctxs.filter(x=>x.kind==='FILE_FALLBACK'))gaps.push({code:'INVENTORY_INCOMPLETE',contextId:c.contextId,path:c.path});
 for(const x of inventory.payload?.limitations??[])if(x.code==='INVENTORY_INCOMPLETE')
   gaps.push({code:'INVENTORY_INCOMPLETE',path:x.path,detail:x.detail});
 gaps.sort((a,b)=>cmp(a.path,b.path)||cmp(a.contextId,b.contextId));
 const capacity={flows:flows.length,crossContractFlows:flows.filter(x=>x.crossContract).length,
  clusters:clusters.length,flowReviewUnits:fIndex,residualUnits:rIndex,attackUnits:attackUnits.length,
  reviewableContexts:ctxs.length,integrationQuestions:questions.length};
 return artifact(inventory,{limits:cfg,flows,clusters,reviewUnits,attackUnits,integrationQuestions:questions,gaps,capacity});
}
