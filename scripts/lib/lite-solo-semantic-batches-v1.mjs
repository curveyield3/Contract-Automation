// Controller-side semantic unit batching for Lite-Solo v4 Phase 4-6.
// This module only constructs proposed assignments. Existing queue/accepted state
// MUST NOT be rewritten without an explicit claim-safe migration transaction.
const MAX_BYTES=64*1024;
export const SEMANTIC_BATCH_POLICY_V1=Object.freeze({
  minGroups:10,maxGroups:20,targetBytes:48*1024,maxBytes:MAX_BYTES
});
const eligibleFields=Object.freeze({
  4:new Set(['discoveryReconciliationRecords','specialistReviewRecords']),
  5:new Set(['economicReviewRecords','reconciliationRecords']),
  6:new Set(['deploymentAssessments','targetDispositions'])
});
const key=x=>String(x??'').trim();
const sourceFamily=anchor=>key(anchor).replace(/:L[0-9]+(?:-L?[0-9]+)?$/, '');
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const primaryContext=u=>Array.isArray(u.initialValue?.contextIds)&&u.initialValue.contextIds.length
  ?u.initialValue.contextIds.map(key).filter(Boolean).sort().join('|'):null;
function groupingKey(unit,phase){
  const v=unit.initialValue;
  if(phase===4&&unit.field==='discoveryReconciliationRecords')
    return primaryContext(unit)||sourceFamily(v?.sourceAnchor)||unit.unitId;
  if(phase===4&&unit.field==='specialistReviewRecords')
    return key(v?.method)+'|'+key(v?.domainOrPrivilege).split(':')[0]+'|'+sourceFamily(v?.sourceAnchor);
  if(phase===5&&unit.field==='reconciliationRecords')
    return key(v?.subjectKey)||key(v?.sourceAnchor)||unit.unitId;
  if(phase===5&&unit.field==='economicReviewRecords')
    return sourceFamily(v?.sourceAnchor)||key(v?.valueFlowOrFormula)||unit.unitId;
  if(phase===6&&unit.field==='deploymentAssessments')
    return key(v?.componentOrAction)||unit.unitId;
  if(phase===6&&unit.field==='targetDispositions')
    return key(v?.candidateKey)||unit.unitId;
  return unit.unitId;
}
function splitOversizedGroup(group,limit){
  const out=[];let chunk=[];
  for(const unit of group.units){
    if(bytes(unit)>limit)throw Error('semantic source record exceeds bounded batch payload: '+unit.unitId);
    const next=[...chunk,unit];
    if(chunk.length&&bytes(next)>limit){out.push({...group,units:chunk});chunk=[];}
    chunk.push(unit);
  }
  if(chunk.length)out.push({...group,units:chunk});
  return out;
}
// No mutation: returns deterministic batches of ORIGINAL record-bearing unit specs.
// Append slots, baseline test executions, proof jobs and global conclusions never enter.
export function planSemanticBatchesV1(units,phase,policy=SEMANTIC_BATCH_POLICY_V1){
  if(![4,5,6].includes(phase))throw Error('semantic batching is Phase 4-6 only');
  if(!Array.isArray(units))throw Error('expected unit plan array');
  const {minGroups,maxGroups,targetBytes,maxBytes}=policy;
  if(!Number.isInteger(minGroups)||!Number.isInteger(maxGroups)||minGroups<1||maxGroups<minGroups
    ||!Number.isInteger(targetBytes)||targetBytes<1024||targetBytes>maxBytes
    ||!Number.isInteger(maxBytes)||maxBytes>MAX_BYTES)throw Error('invalid semantic batch policy');
  const byField=new Map();
  for(const unit of units){
    if(unit.kind!=='SHARD'||!eligibleFields[phase].has(unit.field))continue;
    if(!Array.isArray(unit.recordKeys)||unit.recordKeys.length!==1||
       !Number.isInteger(unit.recordIndex)||!Array.isArray(unit.path)||
       typeof unit.unitId!=='string'||unit.initialValue===undefined)
      throw Error('invalid semantic batch member: '+unit.unitId);
    const fieldMap=byField.get(unit.field)??new Map();
    const gkey=groupingKey(unit,phase),group=fieldMap.get(gkey)??{field:unit.field,groupKey:gkey,units:[]};
    group.units.push(structuredClone(unit));fieldMap.set(gkey,group);byField.set(unit.field,fieldMap);
  }
  const result=[],owned=new Set();
  for(const [field,map] of byField){
    const groups=[...map.values()].flatMap(g=>splitOversizedGroup(g,maxBytes-4096));
    let pending=[],groupCount=0;
    const flush=()=>{
      if(!pending.length)return;
      const members=pending.flatMap(g=>g.units);
      const ids=members.map(u=>u.unitId);
      if(ids.some(id=>owned.has(id)))throw Error('duplicate batched record owner');
      ids.forEach(id=>owned.add(id));
      result.push({phase,field,groupKeys:pending.map(g=>g.groupKey),
        memberUnitIds:ids,recordCount:members.length,members});
      pending=[];groupCount=0;
    };
    for(const group of groups){
      const next=[...pending,group],weight=bytes(next);
      if(pending.length&&(groupCount>=maxGroups||weight>maxBytes||
         (groupCount>=minGroups&&weight>targetBytes)))flush();
      pending.push(group);groupCount++;
      if(bytes(pending)>maxBytes)throw Error('semantic group cannot fit bounded packet: '+group.groupKey);
    }
    flush();
  }
  const eligible=units.filter(u=>u.kind==='SHARD'&&eligibleFields[phase].has(u.field));
  if(owned.size!==eligible.length||eligible.some(u=>!owned.has(u.unitId)))
    throw Error('semantic batch coverage mismatch');
  return {batches:result,batchedUnitIds:[...owned],unbatchedUnitIds:units.filter(u=>!owned.has(u.unitId)).map(u=>u.unitId),
    originalRecordCount:eligible.length,batchCount:result.length};
}
