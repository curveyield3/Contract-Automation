const LEVEL=Object.freeze({CRITICAL:4,HIGH:3,MEDIUM:2,LOW:1,INFORMATIONAL:0,INFO:0});
const KINDS=new Set(['defect','decoy','clean_control']);
function key(value){return String(value??'').trim();}
function severity(value){
  const v=key(value).toUpperCase();
  if(!(v in LEVEL))throw new Error('unknown qualification severity: '+value);
  return v;
}
function fraction(hit,total){return total===0?'NOT_EVALUATED':{matched:hit,total};}
function readRows(rows,label){
  if(!Array.isArray(rows))throw new TypeError(label+' must be an array');
  return rows;
}
function unique(rows,get,label){
  const map=new Map();
  for(const x of rows){
    const id=key(get(x));
    if(!id||map.has(id))throw new Error(label+' has missing or duplicate identity: '+id);
    map.set(id,x);
  }
  return map;
}
const groups=(defects,name,predicate)=>Object.fromEntries(
  [...new Set(defects.map(x=>key(x[name])))]
    .sort().map(id=>[id,(()=>{
      const selected=defects.filter(x=>key(x[name])===id);
      return fraction(selected.filter(predicate).length,selected.length);
    })()])
);
export function scoreQualificationV1({truth,findings,adjudications}={}){
  const cases=unique(readRows(truth,'truth'),x=>x?.caseId,'truth');
  const reports=unique(readRows(findings,'findings'),x=>x?.findingId,'findings');
  const decisions=readRows(adjudications,'adjudications');
  const decisionsByPair=new Map();
  for(const [caseId,row] of cases){
    if(!KINDS.has(row?.kind))throw new Error('invalid case kind: '+caseId);
    if(row.kind==='defect')severity(row.severity);
    if(row.kind==='defect'&&(!key(row.classId)||!key(row.contract)))
      throw new Error('defect missing classId or contract: '+caseId);
  }
  for(const [findingId,row] of reports){
    severity(row.severity);
    if(!Array.isArray(row.caseRefs)||row.caseRefs.some(x=>!key(x)))
      throw new Error('finding caseRefs must be an array of identifiers: '+findingId);
  }
  for(const decision of decisions){
    const caseId=key(decision?.caseId),findingId=key(decision?.findingId),pair=caseId+'\0'+findingId;
    if(!cases.has(caseId)||!reports.has(findingId))throw new Error('unknown adjudication reference: '+pair);
    if(!reports.get(findingId).caseRefs.includes(caseId))throw new Error('adjudication not in finding.caseRefs: '+pair);
    if(!['MATCH','NO_MATCH'].includes(decision.match))throw new Error('invalid adjudication match for '+pair);
    if(decisionsByPair.has(pair))throw new Error('duplicate adjudication pair: '+pair);
    if(decision.severityReadjudicated===true&&!key(decision.reason))
      throw new Error('severity readjudication requires a nonblank reason: '+pair);
    decisionsByPair.set(pair,decision);
  }
  function matches(caseId){
    return [...reports.entries()].filter(([findingId,row])=>
      row.caseRefs.includes(caseId)&&decisionsByPair.get(caseId+'\0'+findingId)?.match==='MATCH')
      .map(([findingId,row])=>({...row,findingId,
        decision:decisionsByPair.get(caseId+'\0'+findingId)}));
  }
  const defects=[...cases.values()].filter(x=>x.kind==='defect');
  const found=new Set(defects.filter(x=>matches(x.caseId).length).map(x=>x.caseId));
  const truePositiveFindings=new Set();
  for(const row of defects)for(const hit of matches(row.caseId))truePositiveFindings.add(hit.findingId);
  const decoyHits=[...cases.values()].filter(x=>x.kind==='decoy'&&matches(x.caseId).length).map(x=>x.caseId).sort();
  const cleanControlCriticalHighFalsePositives=[];
  for(const row of cases.values())if(row.kind==='clean_control'){
    for(const hit of matches(row.caseId))
      if(LEVEL[severity(hit.severity)]>=LEVEL.HIGH)
        cleanControlCriticalHighFalsePositives.push({caseId:row.caseId,findingId:hit.findingId});
  }
  const criticalHighMisses=[];
  let agreed=0,compared=0;
  for(const row of defects){
    const hits=matches(row.caseId),actual=severity(row.severity);
    if(hits.length){
      compared++;
      if(hits.some(hit=>severity(hit.severity)===actual))agreed++;
    }
    if(LEVEL[actual]>=LEVEL.HIGH){
      const adequate=hits.some(hit=>LEVEL[severity(hit.severity)]>=LEVEL.HIGH||
        (hit.decision?.severityReadjudicated===true&&key(hit.decision.reason)));
      if(!adequate)criticalHighMisses.push({
        caseId:row.caseId,severity:actual,
        findingSeverities:hits.map(hit=>severity(hit.severity)),
        reason:hits.length?'UNDER_RATED':'NOT_FOUND'
      });
    }
  }
  return {
    recall:{
      overall:fraction(found.size,defects.length),
      bySeverity:groups(defects,'severity',x=>found.has(x.caseId)),
      byClassId:groups(defects,'classId',x=>found.has(x.caseId)),
      byContract:groups(defects,'contract',x=>found.has(x.caseId))
    },
    precision:fraction(truePositiveFindings.size,reports.size),
    decoyHits,
    cleanControlCriticalHighFalsePositives:cleanControlCriticalHighFalsePositives.sort((a,b)=>
      (a.caseId+'\0'+a.findingId).localeCompare(b.caseId+'\0'+b.findingId)),
    severityAgreement:fraction(agreed,compared),
    criticalHighMisses:criticalHighMisses.sort((a,b)=>a.caseId.localeCompare(b.caseId))
  };
}

/**
 * Private seeded-package release scoring. The answer-key manifest is an input,
 * never committed, copied into packets or written to the campaign workspace.
 * Partial identification is tracked but does not increase the caught count.
 */
export function scoreSeededCampaignV1({
  truth,findings,adjudications,partialCases=[],missStageByCase={},
  baselineCaught=14,minCaught=30,expectedDefects=41
}={}){
  const scored=scoreQualificationV1({truth,findings,adjudications});
  const defects=truth.filter(x=>x.kind==='defect');
  if(defects.length!==expectedDefects)throw new Error('seeded manifest defect count mismatch');
  const matched=scored.recall.overall.matched;
  const matchedIds=new Set();
  const decisions=new Set(adjudications.filter(x=>x.match==='MATCH').map(x=>x.caseId));
  for(const row of defects)if(decisions.has(row.caseId))matchedIds.add(row.caseId);
  if(matched!==matchedIds.size)throw new Error('seeded adjudication identity mismatch');
  const partial=new Set(partialCases);
  for(const id of partial){
    if(!defects.some(x=>x.caseId===id)||matchedIds.has(id))
      throw new Error('partial case unknown or already caught: '+id);
  }
  const missed=defects.filter(x=>!matchedIds.has(x.caseId)&&!partial.has(x.caseId));
  const bySeverity={},byClassId={},byContract={},byLeakStage={};
  for(const row of defects){
    const hit=matchedIds.has(row.caseId),part=partial.has(row.caseId);
    for(const [bucket,name] of [[bySeverity,row.severity],[byClassId,row.classId],[byContract,row.contract]]){
      const stats=bucket[name]??={caught:0,partial:0,missed:0,total:0};
      stats.total++;
      stats[hit?'caught':part?'partial':'missed']++;
    }
    if(!hit){
      const stage=String(missStageByCase[row.caseId]??'UNCLASSIFIED').trim();
      byLeakStage[stage]??=[];
      byLeakStage[stage].push(row.caseId);
    }
  }
  for(const ids of Object.values(byLeakStage))ids.sort();
  const decoys=scored.decoyHits;
  const passed=matched>=Math.max(minCaught,baselineCaught)&&decoys.length===0&&
    scored.cleanControlCriticalHighFalsePositives.length===0;
  return {
    schemaVersion:'curveyield-seeded-detection-score-v1',
    caught:matched,partial:partial.size,missed:missed.length,
    defectCount:defects.length,decoysFlagged:decoys.length,
    cleanControlCriticalHighFalsePositiveCount:scored.cleanControlCriticalHighFalsePositives.length,
    bySeverity,byClassId,byContract,byLeakStage,
    severityAgreement:scored.severityAgreement,
    criticalHighMisses:scored.criticalHighMisses,
    // Do not include full truth or leaked manifest paths in this report.
    gate:{passed,requiredCaught:Math.max(minCaught,baselineCaught),
      maxDecoys:0,activation:passed?'ELIGIBLE_FOR_HUMAN_QUALIFICATION_REVIEW':'BLOCKED'}
  };
}
