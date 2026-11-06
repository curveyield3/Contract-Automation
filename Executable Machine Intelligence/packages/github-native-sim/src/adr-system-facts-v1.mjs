const sortRows=(rows,keys)=>rows.sort((a,b)=>{
  for(const k of keys){const left=String(a[k]??''),right=String(b[k]??'');const d=left.localeCompare(right);if(d)return d;}
  return 0;
});
const uniq=(values)=>[...new Set(values)].sort();
const PRIV=/only|auth|restricted|whenNot|whenPaused|initializer|nonReentrant/i;
const TRANSFER=new Set(['transfer','transferFrom','safeTransfer','safeTransferFrom']);
const APPROVE=new Set(['approve','safeApprove','forceApprove','increaseAllowance','decreaseAllowance','safeIncreaseAllowance','permit']);
function contractName(context) {
  return context.effectiveIn?.[0]??context.qualifiedContainer??context.path;
}
function artifact(inventory,payload){
  return {schemaVersion:'curveyield-system-facts-v1',campaignId:inventory.campaignId,
    campaignGenerationId:inventory.campaignGenerationId,sourceSha256:inventory.sourceSha256,
    taxonomyVersion:inventory.taxonomyVersion,detectionPolicy:inventory.detectionPolicy,
    generatedAt:inventory.generatedAt,payload};
}
export function buildSystemFactsV1({inventory}) {
  const contexts=inventory?.payload?.contexts??[],triggers=inventory?.payload?.triggers??{};
  const guardTable=[],valueFlows=[],crossContractEdges=[],dependencyEdges=[];
  const contractNames=new Set(contexts.filter(c=>c.scopeTier==='IN_SCOPE')
    .flatMap(c=>c.effectiveIn?.length?c.effectiveIn:[c.qualifiedContainer]));
  const depNames=new Set((inventory?.payload?.sourceUnits??[]).filter(s=>s.scopeTier==='DEPENDENCY').map(s=>s.path));
  const guardById=new Map();
  for(const c of contexts) {
    const contract=contractName(c),classes=triggers[c.contextId]??[];
    if(['IN_SCOPE','INHERITED_DEPENDENCY'].includes(c.scopeTier)&&['external','public'].includes(c.visibility)&&
      classes.includes('STATE_WRITE_EXTERNAL')) {
      const senderCheckLines=uniq((c.senderCheckLines??[]).map(Number)),txOriginLines=uniq((c.txOriginLines??[]).map(Number));
      const hasGuard=(c.modifiers??[]).some(x=>PRIV.test(x))||senderCheckLines.length>0;
      const row={contextId:c.contextId,contract,function:c.canonicalSignature,modifiers:uniq(c.modifiers??[]),senderCheckLines,txOriginLines,hasGuard};
      guardTable.push(row);guardById.set(c.contextId,row);
    }
    for(const e of c.externalCalls??[]) {
      if(TRANSFER.has(e.memberName)||APPROVE.has(e.memberName))
        valueFlows.push({contextId:c.contextId,contract,memberName:e.memberName,line:e.line});
      const match=/^contract\s+([A-Za-z0-9_$]+)/.exec(e.targetType??'');
      if(!match)continue;
      const name=match[1];
      const toType=[...contractNames].find(x=>x.split(':').at(-1)===name) ??
        contexts.find(x=>x.scopeTier==='IN_SCOPE'&&(x.implementedInterfaces??[]).some(i=>i.split(':').at(-1)===name))?.effectiveIn?.[0];
      const dest=toType?'cross':'dependency';
      if(dest==='cross')crossContractEdges.push({fromContextId:c.contextId,fromContract:contract,toType,memberName:e.memberName,line:e.line});
      else if([...depNames].some(x=>x.includes(name))||
        (inventory?.payload?.declarations??[]).some(d=>d.name===name&&depNames.has(d.path)))
        dependencyEdges.push({fromContextId:c.contextId,fromContract:contract,toType:name,memberName:e.memberName,line:e.line});
    }
  }
  const contracts=new Map();
  for(const c of contexts.filter(c=>c.scopeTier==='IN_SCOPE'&&c.contractKind==='contract'&&!c.contractAbstract)) {
    for(const q of c.effectiveIn?.length?c.effectiveIn:[c.qualifiedContainer]) {
      if(!contracts.has(q))contracts.set(q,{contract:q,bases:uniq(c.directBases??[]),interfaces:uniq(c.implementedInterfaces??[])});
    }
  }
  const bySig=new Map();
  for(const [q,info] of contracts) {
    const funcs=contexts.filter(c=>c.scopeTier==='IN_SCOPE'&&(c.qualifiedContainer===q||(c.effectiveIn??[]).includes(q))&&
      ['FUNCTION','INHERITED_DEPENDENCY'].includes(c.kind)&&['public','external'].includes(c.visibility));
    for(const c of funcs) {
      const members=bySig.get(c.canonicalSignature)??[];
      if(!members.some(x=>x.contract===q))members.push({contract:q,contextId:c.contextId,function:c.canonicalSignature,
        sourceAnchor:c.path+':L'+c.lineStart+'-L'+c.lineEnd,modifiers:uniq(c.modifiers??[]),
        hasGuard:guardById.get(c.contextId)?.hasGuard??((c.modifiers??[]).some(x=>PRIV.test(x))||
          (c.senderCheckLines??[]).length>0)});
      bySig.set(c.canonicalSignature,members);
    }
  }
  const siblingGroups=[];
  for(const [signature,members0] of bySig) {
    const members=members0.sort((a,b)=>a.contract.localeCompare(b.contract));
    if(members.length<2)continue;
    // An eligible group shares the same direct bases or an implemented interface.
    const related=new Set();
    for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++){
      const a=contracts.get(members[i].contract),b=contracts.get(members[j].contract);
      if(!a||!b)continue;
      if((a.bases.length>0&&JSON.stringify(a.bases)===JSON.stringify(b.bases))||
        a.interfaces.some(x=>b.interfaces.includes(x))) {related.add(members[i].contract);related.add(members[j].contract);}
    }
    const matched=members.filter(x=>related.has(x.contract));
    if(matched.length<2)continue;
    const asymmetric=matched.some(x=>x.hasGuard!==matched[0].hasGuard||
      JSON.stringify(x.modifiers)!==JSON.stringify(matched[0].modifiers));
    siblingGroups.push({signature,pattern:'same function signature in related inherited/interface contracts',
      members:matched,asymmetric,
      differences:asymmetric?matched.map(m=>({contract:m.contract,contextId:m.contextId,
        guard:m.hasGuard,modifiers:m.modifiers})):[]});
  }
  sortRows(guardTable,['contract','function','contextId']);
  sortRows(siblingGroups,['signature']);
  sortRows(valueFlows,['contract','contextId','line','memberName']);
  sortRows(crossContractEdges,['fromContract','fromContextId','toType','memberName','line']);
  sortRows(dependencyEdges,['fromContract','fromContextId','toType','memberName','line']);
  return artifact(inventory,{guardTable,siblingGroups,valueFlows,crossContractEdges,dependencyEdges});
}
