import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {detectionPolicyForAuthorityV1} from '../../packages/github-native-sim/src/adr-policy-v1.mjs';
import {classifyDeploymentExecutionV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {boundReviewerForPhaseV1 as originalReviewerForPhaseV1} from './lite-authority-lineup-v1.mjs';
const boundReviewerForPhaseV1=({authorityRoot,...params})=>[ 'Audit Skill - Lite-Solo Authority/lite-solo', 'Audit Skill - Lite-Solo Authority/lite-solo-v2', 'Audit Skill - Lite-Solo Authority/lite-solo-v3', 'Audit Skill - Lite-Solo Authority/lite-solo-v4', 'Audit Skill - Lite-Solo Authority/lite-solo-v5', 'Audit Skill - Lite-Solo Authority/lite-solo-v6' ].includes(authorityRoot)?'lite-solo-agent':originalReviewerForPhaseV1({authorityRoot,...params});

function repoFile(root,rel){return path.join(root,...String(rel).split('/'));}
function readJsonIf(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
function walk(dir,out=[]){if(!fs.existsSync(dir))return out;for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isDirectory())walk(p,out);else if(ent.isFile())out.push(p);}return out;}
function explicit(value){return value===undefined||value===null||value===''?'<REQUIRED>':value;}
function uniq(values){return [...new Set(values.filter(v=>v!==undefined&&v!==null&&String(v).length>0))];}
function text(v){return typeof v==='string'?v:JSON.stringify(v);}
function matchesAny(value,patterns){const s=String(value??'').toLowerCase();return patterns.some(p=>s.includes(p));}
function safeSegment(value,fallback='item'){const s=String(value??'').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'');return s||fallback;}

function findSourceIntelligence(root,campaignPath){
  const dir=repoFile(root,path.posix.join(campaignPath,'evidence/source-intelligence'));
  const candidates=walk(dir).filter(f=>f.endsWith('.json'));
  const parsed=[];
  for(const file of candidates){
    const j=readJsonIf(file);
    if(j?.artifactType==='CANONICAL_SOURCE_INTELLIGENCE') parsed.push({file,j});
  }
  parsed.sort((a,b)=>a.file.localeCompare(b.file));
  return parsed.at(-1)??null;
}


function getByPath(obj,dot){let cur=obj;for(const part of String(dot).split('.')){if(cur==null)return undefined;cur=cur[part];}return cur;}
function controllerOwnedProjection(form){
  const rows=[];
  for(const [stepKey,action] of Object.entries(form?.actions??{})){
    for(const [fieldName,value] of Object.entries(action?.outputs??{})){
      if(!Array.isArray(value))continue;
      value.forEach((item,index)=>{
        if(!item||typeof item!=='object'||Array.isArray(item)||!Array.isArray(item.automationOwnedFields))return;
        const owned={};
        for(const k of item.automationOwnedFields)owned[k]=item[k];
        rows.push({path:`actions.${stepKey}.outputs.${fieldName}[${index}]`,owned});
      });
    }
  }
  for(const p of form?.automationInputs?.controllerOwnedOutputPaths??[]) rows.push({path:p,value:getByPath(form,p)});
  for(const k of form?.automationInputs?.controllerOwnedAutomationInputs??[]) rows.push({path:`automationInputs.${k}`,value:form?.automationInputs?.[k]});
  return rows;
}
function controllerOwnedDigest(form){return createHash('sha256').update(JSON.stringify(controllerOwnedProjection(form))).digest('hex');}
export function refreshControllerPrefillDigest(form){form.automationInputs??={};form.automationInputs.controllerPrefillDigestSha256=controllerOwnedDigest(form);return form.automationInputs.controllerPrefillDigestSha256;}

function sourceAnchorFor(si,symbolId,fallback){
  const a=(si?.sourceAnchors??[]).find(x=>x.symbolId===symbolId);
  return a?.anchorId??a?.sourceLocation??fallback??'SOURCE_INTELLIGENCE';
}

function structuralInputs(si){
  const privileges=(si?.privilegeCandidates??[]).map(x=>({
    candidateId:x.candidateId,functionId:x.functionId,candidateKind:x.candidateKind,
    authorityExpression:x.authorityExpression,modifierOrGuard:x.modifierOrGuard,sourceLocation:x.sourceLocation
  }));
  const funcs=si?.functions??[];
  const calls=si?.callGraph??[];
  const external=si?.externalInterfaces??[];
  const topology=si?.protocolTopology??{};
  const upgradePaths=[
    ...(topology.upgradeabilityEdges??[]),
    ...funcs.filter(f=>matchesAny(f.signature,['upgrade','initialize','reinitialize','changeadmin','beacon','facet'])).map(f=>({functionId:f.functionId,signature:f.signature,sourceLocation:f.sourceLocation})),
    ...calls.filter(c=>matchesAny(c.callKind,['delegatecall','callcode'])).map(c=>({callerFunctionId:c.callerFunctionId,callKind:c.callKind,target:c.target,sourceLocation:c.sourceLocation}))
  ];
  const callbackSurfaces=[
    ...external.filter(e=>matchesAny([e.interactionKind,e.selectorOrSignature,e.dependencyOrInterface].join(' '),['callback','hook','receiver','fallback'])),
    ...funcs.filter(f=>matchesAny(f.signature,['callback','hook','onerc','tokensreceived','fallback','receive('])).map(f=>({functionId:f.functionId,signature:f.signature,sourceLocation:f.sourceLocation}))
  ];
  return {privilegeCandidates:privileges,authorityTransitions:privileges,upgradePaths,callbackSurfaces};
}

function domainClassificationCorpus(si,matrix){
  const sources=matrix?.machineClassification?.corpusSources??[];
  return sources.map(source=>JSON.stringify(getByPath(si,source)??null)).join('\n').toLowerCase();
}
function evaluateDomainMatcher(si,corpus,matcher){
  if(!matcher||typeof matcher!=='object') return {supported:false,matched:false,facts:[]};
  if(matcher.kind==='arrayNonEmpty'){
    const value=getByPath(si,matcher.path);
    return {
      supported:typeof matcher.path==='string'&&matcher.path.length>0,
      matched:Array.isArray(value)&&value.length>0,
      facts:Array.isArray(value)&&value.length>0?['arrayNonEmpty:'+matcher.path]:[]
    };
  }
  if(matcher.kind==='textContainsAny'){
    const terms=Array.isArray(matcher.terms)?matcher.terms.filter(x=>typeof x==='string'&&x.trim()):[];
    const matched=terms.filter(term=>corpus.includes(term.toLowerCase()));
    return {
      supported:terms.length>0,
      matched:matched.length>0,
      facts:matched.map(term=>'textContains:'+term)
    };
  }
  return {supported:false,matched:false,facts:[]};
}

function classifyDomains(si,matrix){
  const corpus=domainClassificationCorpus(si,matrix);
  const complete=si?.completion?.status==='PASS'||si?.completion?.status==='COMPLETE'||si?.completion?.noFillSentinelsRemaining===true;
  const limitations=(si?.limitations??[]).filter(x=>x&&x.reason&&!matchesAny(x.reason,['none','not applicable']));
  return (matrix?.domains??[]).map(d=>{
    const matchers=Array.isArray(d.machineMatchers)?d.machineMatchers:[];
    const results=matchers.map(m=>evaluateDomainMatcher(si,corpus,m));
    const triggered=results.some(r=>r.matched);
    const matcherCoverageComplete=matchers.length>0&&results.every(r=>r.supported);
    const uncertain=!complete||limitations.length>0||!matcherCoverageComplete;
    const classification=triggered?'TRIGGERED':(uncertain?'UNCERTAIN_INCLUDE':'NOT_TRIGGERED');
    const matchedFacts=results.flatMap(r=>r.facts);
    const triggerFacts=triggered
      ? matchedFacts
      : classification==='UNCERTAIN_INCLUDE'
        ? [
            ...(!complete?['SOURCE_INTELLIGENCE_INCOMPLETE']:[]),
            ...(limitations.length?['SOURCE_INTELLIGENCE_LIMITATIONS_PRESENT']:[]),
            ...(!matcherCoverageComplete?['MACHINE_MATCHER_COVERAGE_INCOMPLETE']:[])
          ]
        : ['COMPLETE_SOURCE_INTELLIGENCE_AND_MATRIX_MATCHERS_FOUND_NO_POSITIVE_TRIGGER'];
    return {
      domainId:d.domainId,
      triggerFacts,
      classification,
      rationale:triggered
        ? 'Deterministic machine matcher(s) from DOMAIN_APPLICABILITY_MATRIX matched accepted Source Intelligence.'
        : classification==='UNCERTAIN_INCLUDE'
          ? 'No positive matrix matcher matched, but exact negative exclusion is not machine-complete; fail-closed specialist coverage remains active.'
          : 'Complete accepted Source Intelligence and complete matrix machine matchers found no positive trigger.',
      requiredPhase4Method:(d.methodResources??[])[0]??'DOMAIN_METHOD_RESOURCE'
    };
  });
}
function domainObligations(matrix,assessments,{originPhase=3}={}){
  const byId=new Map((matrix?.domains??[]).map(d=>[d.domainId,d]));
  const out=[];
  let n=1;
  for(const a of assessments){
    if(!['TRIGGERED','UNCERTAIN_INCLUDE'].includes(a.classification)) continue;
    const d=byId.get(a.domainId);
    for(const phase of d?.requiredExecutionPhases??[]){
      // Current-phase domain modeling is performed directly by the active
      // Phase-3 action. Only future-phase work becomes a carried obligation.
      if(Number(phase)<=Number(originPhase)) continue;
      out.push({
        tempKey:'AUTO-DOM-'+String(n++).padStart(3,'0'),
        originFactKeys:[a.domainId],
        requiredPhase:String(phase),
        requiredAction:`Apply ${a.domainId} specialist method at Phase ${phase}`,
        completionCondition:`Accepted Phase-${phase} evidence addresses ${a.domainId}`,
        priority:a.classification==='TRIGGERED'?'REQUIRED':'REQUIRED_UNCERTAIN_INCLUDE',
        automationGenerated:true
      });
    }
  }
  return out.length?out:['NONE_IDENTIFIED'];
}

function loadDerived(root,paths){
  const out=[];
  for(const rel of paths??[]){const j=readJsonIf(repoFile(root,rel));if(j)out.push(j);}
  return out;
}
function findAutomationInput(derived,key){
  for(const d of derived){
    const v=d?.data?.automationInputs?.[key]??d?.automationInputs?.[key];
    if(v!==undefined)return v;
  }
  return undefined;
}

function sourceReviewScaffold(si){
  const contracts=new Map((si?.contracts??[]).map(c=>[c.contractId,c]));
  const rows=(si?.functions??[]).map((f,i)=>{
    const c=contracts.get(f.contractId);
    return {
      recordKey:'AUTO-SRC-'+String(i+1).padStart(4,'0'),
      sourceAnchor:sourceAnchorFor(si,f.functionId,f.sourceLocation),
      contractOrModule:c?.qualifiedName??f.contractId,
      functionOrSurface:f.signature??f.functionId,
      observedBehavior:'<REQUIRED>',
      securityInterpretation:'<REQUIRED>',
      relatedRequirementKeys:'<REQUIRED>',
      relatedHypothesisKeys:'<REQUIRED>',
      disposition:'<REQUIRED>',
      candidateTempKeyOrNone:'<REQUIRED>',
      limitations:'<REQUIRED>',
      automationOwnedFields:['recordKey','sourceAnchor','contractOrModule','functionOrSurface']
    };
  });
  let n=rows.length+1;
  for(const s of si?.securitySurfaces??[]){
    if(Array.isArray(s.functionIds)&&s.functionIds.length) continue;
    rows.push({
      recordKey:'AUTO-SRC-'+String(n++).padStart(4,'0'),
      sourceAnchor:(s.sourceAnchorIds??[])[0]??s.surfaceId??'SOURCE_INTELLIGENCE',
      contractOrModule:(s.contractIds??[]).map(id=>contracts.get(id)?.qualifiedName??id).join(', ')||'CROSS_CONTRACT_SURFACE',
      functionOrSurface:[s.surfaceId,s.surfaceClass].filter(Boolean).join(' / ')||'SECURITY_SURFACE',
      observedBehavior:'<REQUIRED>',
      securityInterpretation:'<REQUIRED>',
      relatedRequirementKeys:'<REQUIRED>',
      relatedHypothesisKeys:'<REQUIRED>',
      disposition:'<REQUIRED>',
      candidateTempKeyOrNone:'<REQUIRED>',
      limitations:'<REQUIRED>',
      automationOwnedFields:['recordKey','sourceAnchor','contractOrModule','functionOrSurface']
    });
  }
  return rows.length?rows:['NONE_IDENTIFIED'];
}

function specialistScaffold(si,domainAssessments){
  const rows=[];let n=1;
  for(const d of domainAssessments??[]){
    if(!['TRIGGERED','UNCERTAIN_INCLUDE'].includes(d.classification)) continue;
    rows.push({
      recordKey:'AUTO-SPEC-'+String(n++).padStart(4,'0'),
      domainOrPrivilege:d.domainId,
      sourceAnchor:'AUTOMATED_DOMAIN_CLASSIFICATION',
      method:d.requiredPhase4Method,
      observation:'<REQUIRED>',
      securityInterpretation:'<REQUIRED>',
      disposition:'<REQUIRED>',
      candidateTempKeyOrNone:'<REQUIRED>',
      automationOwnedFields:['recordKey','domainOrPrivilege','sourceAnchor','method']
    });
  }
  for(const p of si?.privilegeCandidates??[]){
    rows.push({
      recordKey:'AUTO-SPEC-'+String(n++).padStart(4,'0'),
      domainOrPrivilege:'PRIVILEGE:'+String(p.candidateId??p.candidateKind??'UNRESOLVED'),
      sourceAnchor:sourceAnchorFor(si,p.functionId,p.sourceLocation),
      method:'PRIVILEGE_REVIEW',
      observation:'<REQUIRED>',
      securityInterpretation:'<REQUIRED>',
      disposition:'<REQUIRED>',
      candidateTempKeyOrNone:'<REQUIRED>',
      automationOwnedFields:['recordKey','domainOrPrivilege','sourceAnchor','method']
    });
  }
  return rows.length?rows:['NONE_IDENTIFIED'];
}

function economicScaffold(si,current){
  const flows=si?.valueFlowCandidates??[];
  if(!flows.length)return current;
  return flows.map((f,i)=>({
    recordKey:f.flowId??'AUTO-ECO-'+String(i+1).padStart(4,'0'),
    sourceAnchor:sourceAnchorFor(si,f.sourceFunctionId,f.sourceLocation),
    valueFlowOrFormula:[f.assetOrValueExpression,f.direction,f.mechanism,f.counterpartyExpression].filter(Boolean).join(' | ')||'STRUCTURED_VALUE_FLOW',
    unitsAndBounds:'<REQUIRED>',
    boundaryCases:'<REQUIRED>',
    roundingPrecision:'<REQUIRED>',
    incentiveExtractionAnalysis:'<REQUIRED>',
    solvencyOrConservationAnalysis:'<REQUIRED>',
    conclusion:'<REQUIRED>',
    relatedCandidateKeys:'<REQUIRED>',
    automationOwnedFields:['recordKey','sourceAnchor','valueFlowOrFormula']
  }));
}

function deployAssessmentScaffold(root,campaignPath){
  const ev=readJsonIf(repoFile(root,path.posix.join(campaignPath,'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json')))??{};
  const classification=classifyDeploymentExecutionV1({execution:ev});
  const rows=[];let n=1;
  if(classification.mode==='LIVE_DEPLOYED_FORK'){
    for(const target of classification.targets){
      rows.push({
        componentOrAction:'EXISTING_LIVE_FORK_TARGET '+(target.qualifiedName??'contract')+' '+target.address,
        executionEvidenceRef:classification.evidenceRef,
        observedState:classification.status+'; historic block '+classification.blockNumber+'; source-bound mutable Anvil execution still required',
        securityInterpretation:'<REQUIRED>',
        contradictionOrNone:'<REQUIRED>',
        limitationOrNone:'<REQUIRED>',
        automationOwnedFields:['componentOrAction','executionEvidenceRef','observedState']
      }); n++;
    }
    if(!rows.length){
      rows.push({
        componentOrAction:'LIVE_FORK_TARGET_ATTESTATION_REQUIRED',
        executionEvidenceRef:classification.evidenceRef,
        observedState:classification.status,
        securityInterpretation:'<REQUIRED>',
        contradictionOrNone:'<REQUIRED>',
        limitationOrNone:'<REQUIRED>',
        automationOwnedFields:['componentOrAction','executionEvidenceRef','observedState']
      }); n++;
    }
  }
  for(const a of ev.attempts??[]){
    rows.push({
      componentOrAction:a.script??a.action??'PHASE0_DEPLOY_CONFIG_ACTION_'+n,
      executionEvidenceRef:a.evidenceRef??'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',
      observedState:a.resultSummary??a.status??'MACHINE_RESULT_RECORDED',
      securityInterpretation:'<REQUIRED>',
      contradictionOrNone:'<REQUIRED>',
      limitationOrNone:'<REQUIRED>',
      automationOwnedFields:['componentOrAction','executionEvidenceRef','observedState']
    }); n++;
  }
  for(const g of ev.gaps??[]){
    rows.push({
      componentOrAction:g.id??'PHASE0_DEPLOY_CONFIG_GAP_'+n,
      executionEvidenceRef:'evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json',
      observedState:g.value??g.reason??g.disposition??'TYPED_GAP',
      securityInterpretation:'<REQUIRED>',
      contradictionOrNone:'<REQUIRED>',
      limitationOrNone:'<REQUIRED>',
      automationOwnedFields:['componentOrAction','executionEvidenceRef','observedState']
    }); n++;
  }
  return rows.length?rows:['NONE_IDENTIFIED'];
}

function targetDispositionScaffold(targetDesigns,results){
  const rows=[];
  for(const t of targetDesigns??[]){
    const key=t?.candidateKey;if(!key)continue;
    const r=results?.[key]??{};
    const raw=r.rawResult??{};
    rows.push({
      candidateKey:key,
      executionEvidenceRefs:r.evidenceRef?[r.evidenceRef]:['NO_MACHINE_EVIDENCE'],
      oracleOutcome:raw?.reproduction?.status??raw?.disposition??r.status??'UNRESOLVED',
      reproductionStatus:r.status??raw?.status??'UNRESOLVED',
      requestBindingStatus:r.requestBindingStatus??t.requestBindingStatus??'UNVERIFIED',
      requestBindingEvidenceRef:r.requestBindingEvidenceRef??t.requestBindingEvidenceRef??'NO_BINDING_EVIDENCE',
      semanticHarnessBindingAssessment:'<REQUIRED>',
      securityInterpretation:'<REQUIRED>',
      limitations:'<REQUIRED>',
      recommendedPhase8Disposition:'<REQUIRED>',
      automationOwnedFields:[
        'candidateKey','executionEvidenceRefs','oracleOutcome','reproductionStatus',
        'requestBindingStatus','requestBindingEvidenceRef'
      ]
    });
  }
  return rows.length?rows:['NONE_IDENTIFIED'];
}

function machineLimitations(deployRows,targetRows){
  const out=[];
  for(const row of deployRows??[]){
    if(typeof row==='string')continue;
    if(matchesAny(row.observedState,['blocked','failed','gap','unavailable','inconclusive'])) out.push(`${row.componentOrAction}: ${row.observedState}`);
  }
  for(const row of targetRows??[]){
    if(typeof row==='string')continue;
    if(!['PASS','SUPPORTED','DISPROVED','COMPLETED'].some(x=>String(row.reproductionStatus).toUpperCase().includes(x))) out.push(`${row.candidateKey}: ${row.reproductionStatus}`);
  }
  return out.length?uniq(out):['NONE_IDENTIFIED'];
}
function reviewerForRequiredPhase(phase,root=null,authorityRoot=null){
 const n=Number(phase);
 // Keep later full-audit obligations visible, not executable, in terminal previews.
 if(authorityRoot==='Audit Skill - Audit Preview/audit-preview-v1'&&n>4)
   return 'OUT_OF_SCOPE_PREVIEW_TERMINAL';
 if(root&&authorityRoot)return boundReviewerForPhaseV1({root,authorityRoot,phase:n});
 if(n===7)return 'phase7-automation';
 if(n>=1&&n<=10)return 'lite-solo-agent';
 return 'UNRESOLVED_REVIEWER';
}
function evidenceList(value){
  if(Array.isArray(value)) return value.filter(x=>typeof x==='string'&&x&&!x.startsWith('<')&&x!=='NONE_IDENTIFIED');
  if(typeof value==='string'&&value&&!value.startsWith('<')&&value!=='NONE_IDENTIFIED') return [value];
  return [];
}
function obligationIdFor(item,originPhase,index){
  const raw=String(item?.obligationId??item?.tempKey??('AUTO-'+String(index+1).padStart(3,'0'))).trim();
  if(raw.startsWith('OBL-')) return raw;
  return 'OBL-P'+String(originPhase)+'-'+safeSegment(raw,'AUTO-'+String(index+1).padStart(3,'0'));
}
export function normalizeFormalObligationsIntoLedger({ledger,items=[],originPhase,canonicalRel,now,root=null,authorityRoot=null}){
  ledger.obligations??=[];
  const byId=new Map(ledger.obligations.map((o,i)=>[String(o?.obligationId??''),i]).filter(([id])=>id));
  let created=0;
  (Array.isArray(items)?items:[items]).forEach((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return;
    if(item.requiredPhase===undefined||!item.requiredAction||!item.completionCondition)return;
    let requiredPhase=String(item.requiredPhase);
    if(requiredPhase==='7') requiredPhase='6';
    const obligationId=obligationIdFor(item,originPhase,index);
    const existingIndex=byId.get(obligationId);
    if(existingIndex!==undefined){
      const existing=ledger.obligations[existingIndex];
      existing.originatingFactIds=uniq([...(existing.originatingFactIds??[]),...(item.originFactKeys??item.originatingFactIds??[])]);
      existing.originatingEvidenceRefs=uniq([...(existing.originatingEvidenceRefs??[]),canonicalRel,...(item.originatingEvidenceRefs??[])]);
      existing.requiredPhase=existing.requiredPhase??requiredPhase;
      existing.requiredReviewer=existing.requiredReviewer??reviewerForRequiredPhase(existing.requiredPhase,root,authorityRoot);
      existing.requiredAction=existing.requiredAction??item.requiredAction;
      existing.completionCondition=existing.completionCondition??item.completionCondition;
      existing.updatedAt=now;
      return;
    }
    ledger.obligations.push({
      obligationId,
      originPhase:String(originPhase),
      originatingFactIds:uniq([...(item.originFactKeys??item.originatingFactIds??[])]),
      originatingEvidenceRefs:uniq([canonicalRel,...(item.originatingEvidenceRefs??[])]),
      requiredPhase,
      requiredReviewer:reviewerForRequiredPhase(requiredPhase,root,authorityRoot),
      requiredAction:item.requiredAction,
      completionCondition:item.completionCondition,
      mandatory:item.mandatory!==false,
      status:'OPEN',
      statusReason:null,
      closureEvidenceRefs:[],
      supersedesOrReplaces:[],
      createdAt:now,
      updatedAt:now
    });
    byId.set(obligationId,ledger.obligations.length-1);
    created++;
  });
  return created;
}
export function applyObligationDispositionsToLedger({ledger,canonical,sequence,canonicalRel,now,root=null,authorityRoot=null}){
  ledger.obligations??=[];
  const byId=new Map(ledger.obligations.map(o=>[String(o?.obligationId??''),o]).filter(([id])=>id));
  const rows=[];
  for(const action of Object.values(canonical?.actions??{})){
    const value=action?.outputs?.obligationDispositions;
    if(Array.isArray(value)) rows.push(...value.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)));
  }
  for(const row of rows){
    const id=String(row.obligationId??'').trim();
    const obligation=byId.get(id);
    if(!obligation) throw new Error('Obligation disposition references unknown obligation '+id);
    const disposition=String(row.disposition??'').toUpperCase();
    const carry=String(row.carryForwardPhaseOrNone??'NONE_IDENTIFIED');
    const refs=uniq([canonicalRel,...evidenceList(row.evidenceRefs)]);
    obligation.statusReason=String(row.rationale??'');
    obligation.updatedAt=now;
    if(disposition==='SATISFIED'){
      obligation.status='SATISFIED';
      obligation.closureEvidenceRefs=refs;
    }else if(disposition==='NOT_APPLICABLE'){
      obligation.status='NOT_APPLICABLE';
      obligation.closureEvidenceRefs=refs;
    }else if(disposition==='CARRY_FORWARD'){
      obligation.status='OPEN';
      obligation.requiredPhase=carry;
      obligation.requiredReviewer=reviewerForRequiredPhase(carry,root,authorityRoot);
      obligation.closureEvidenceRefs=[];
    }else if(disposition==='BLOCKED_CARRIED'){
      obligation.status='BLOCKED_CARRIED';
      obligation.requiredPhase=carry;
      obligation.requiredReviewer=reviewerForRequiredPhase(carry,root,authorityRoot);
      obligation.closureEvidenceRefs=refs;
    }else{
      throw new Error('Unsupported obligation disposition '+disposition+' for '+id);
    }
  }
  ledger.phaseCheckpoints??=[];
  const checkpoint={
    phaseId:'phase-'+sequence,
    status:'DISPOSITIONS_APPLIED',
    dispositionCount:rows.length,
    openOrBlockedAfterPhase:(ledger.obligations??[]).filter(o=>['OPEN','IN_PROGRESS','BLOCKED_CARRIED'].includes(String(o.status??'OPEN').toUpperCase())).length,
    recordedAt:now
  };
  const i=ledger.phaseCheckpoints.findIndex(x=>x?.phaseId===checkpoint.phaseId);
  if(i>=0)ledger.phaseCheckpoints[i]=checkpoint;else ledger.phaseCheckpoints.push(checkpoint);
  return rows.length;
}
export function dueObligationScaffold({root,campaignPath,sequence}){
  const ledger=readJsonIf(repoFile(root,path.posix.join(campaignPath,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json')))??{};
  const active=new Set(['OPEN','IN_PROGRESS','BLOCKED_CARRIED']);
  const due=(ledger.obligations??[]).filter(o=>active.has(String(o?.status??'OPEN').toUpperCase())&&String(o?.requiredPhase??'')===String(sequence));
  due.sort((a,b)=>String(a.obligationId??'').localeCompare(String(b.obligationId??'')));
  for(const o of due){
    if(!o?.obligationId||!o?.requiredAction||!o?.completionCondition) throw new Error('Malformed due obligation at phase '+sequence);
  }
  const rows=due.map(o=>({
    obligationId:o.obligationId,
    requiredAction:o.requiredAction,
    completionCondition:o.completionCondition,
    disposition:'<REQUIRED>',
    rationale:'<REQUIRED>',
    evidenceRefs:'<REQUIRED>',
    carryForwardPhaseOrNone:'<REQUIRED>',
    automationOwnedFields:['obligationId','requiredAction','completionCondition']
  }));
  return {rows:rows.length?rows:['NONE_IDENTIFIED'],expectedIds:due.map(o=>o.obligationId)};
}

export function applyPhaseBoundaryPrefill({root,campaignPath,authorityRoot,sequence,form,derivedInputPaths=[],predecessorReceiptPath,prefillContext={}}){
  form.automationInputs={
    ...(form.automationInputs??{}),
    predecessorReceiptPath,
    derivedInputPaths:[...derivedInputPaths],
    controllerOwnedAutomationInputs:uniq([
      ...((form.automationInputs??{}).controllerOwnedAutomationInputs??[]),
      'predecessorReceiptPath',
      'derivedInputPaths'
    ])
  };
  const siEntry=findSourceIntelligence(root,campaignPath);
  const si=siEntry?.j??null;
  const derived=loadDerived(root,derivedInputPaths);

  if(sequence===1&&si){
    form.automationInputs.structuralInventory={
      securitySurfaces:si.securitySurfaces??[],
      privilegeCandidates:si.privilegeCandidates??[],
      externalInterfaces:si.externalInterfaces??[],
      sourceAnchors:si.sourceAnchors??[],
      valueFlowCandidates:si.valueFlowCandidates??[]
    };
    form.automationInputs.controllerOwnedAutomationInputs=uniq([
      ...(form.automationInputs.controllerOwnedAutomationInputs??[]),
      'structuralInventory'
    ]);
    const deps=new Map();
    for(const e of si.externalInterfaces??[]){
      const key=e.dependencyOrInterface??e.interfaceId;
      if(!key||deps.has(key))continue;
      deps.set(key,{
        dependencyKey:e.interfaceId??key,
        identity:key,
        trustAssumptions:'<REQUIRED>',
        failureModes:'<REQUIRED>',
        authorityImplications:'<REQUIRED>',
        securitySignificance:'<REQUIRED>',
        laterEvidenceNeeds:'<REQUIRED>',
        automationOwnedFields:['dependencyKey','identity']
      });
    }
    if(deps.size)form.actions['step-3'].outputs.dependencyAssessments=[...deps.values()];
  }

  if(sequence===2){
    const predecessor=readJsonIf(repoFile(root,predecessorReceiptPath))??{};
    const build=readJsonIf(repoFile(root,path.posix.join(campaignPath,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json')))??{};
    const prior=predecessor.sourceSha256??predecessor.source?.sha256??null;
    const current=build.source?.archiveSha256Observed??build.source?.archiveSha256??prior;
    form.automationInputs.identityComparison={
      predecessorSourceSha256:prior,
      currentSourceSha256:current,
      status:prior&&current&&prior!==current?'IDENTITY_CHANGE_DETECTED':'NO_IDENTITY_CHANGE_DETECTED_AT_PHASE_BOUNDARY'
    };
    form.automationInputs.controllerOwnedAutomationInputs=[...(form.automationInputs.controllerOwnedAutomationInputs??[]),'identityComparison'];
  }

  if(sequence===3){
    const matrixRel=path.posix.join(authorityRoot,'shared/controller/DOMAIN_APPLICABILITY_MATRIX.json');
    const matrix=readJsonIf(repoFile(root,matrixRel))??{};
    const domains=classifyDomains(si??{},matrix);
    const obligations=domainObligations(matrix,domains);
    const registryRel=path.posix.join(campaignPath,'controller/DOMAIN_APPLICABILITY_REGISTRY_v1.json');
    writeJson(repoFile(root,registryRel),{
      schemaVersion:'audit-v7-domain-applicability-registry-v1',
      artifactId:'DOMAIN_APPLICABILITY_REGISTRY',
      sourceIntelligencePath:siEntry?path.relative(repoFile(root,campaignPath),siEntry.file).split(path.sep).join('/'):'UNRESOLVED',
      matrixPath:matrixRel,
      sourceIdentity:si?.identity?.sourceIdentity??si?.identity?.sourceDigestSha256??'UNRESOLVED',
      decisions:domains,
      generatedObligations:obligations,
      owner:'CONTROLLER_AUTOMATION_AT_PHASE_2_BOUNDARY'
    });
    form.automationInputs.sourceIntelligencePath=siEntry?path.relative(repoFile(root,campaignPath),siEntry.file).split(path.sep).join('/'):'UNRESOLVED';
    form.automationInputs.domainRegistryPath=path.posix.relative(campaignPath,registryRel);
    form.automationInputs.controllerOwnedAutomationInputs=[...(form.automationInputs.controllerOwnedAutomationInputs??[]),'sourceIntelligencePath','domainRegistryPath'];
  }

  if(sequence===4 && Object.hasOwn(form?.actions?.['step-1']?.outputs??{},'discoveryReconciliationRecords')){
    const policy=detectionPolicyForAuthorityV1({repoRoot:root,authorityRoot,
      readJsonIfExists:(rel)=>readJsonIf(repoFile(root,rel))});
    if(policy){
      const summary=readJsonIf(repoFile(root,path.posix.join(campaignPath,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json')));
      const items=summary?.payload?.reconciliationItems??null;
      const controllerFields=['recordKey','contextIds','sourceAnchor','origin','reviewerFinding','attackerFinding'];
      const records=items===null?['<PENDING_DISCOVERY>']:items.length?items.map(item=>({
        ...Object.fromEntries(controllerFields.map(k=>[k,item[k]])),
        reconciliation:'<REQUIRED>',disposition:'<REQUIRED>',candidateTempKeyOrNone:'<REQUIRED>',rationale:'<REQUIRED>',
        automationOwnedFields:controllerFields
      })):['NONE_IDENTIFIED'];
      form.actions['step-1'].outputs.discoveryReconciliationRecords=records;
      form.automationInputs.expectedDiscoveryRecordKeys=items?.map(x=>x.recordKey)??[];
      form.automationInputs.controllerOwnedAutomationInputs=uniq([
       ...form.automationInputs.controllerOwnedAutomationInputs,'expectedDiscoveryRecordKeys']);
    }
  }
  if(sequence===4){
    const registryRel=path.posix.join(campaignPath,'controller/DOMAIN_APPLICABILITY_REGISTRY_v1.json');
    const registry=readJsonIf(repoFile(root,registryRel))??{};
    const domains=registry.decisions??[];
    if(!Object.hasOwn(form.actions['step-1'].outputs,'discoveryReconciliationRecords'))form.actions['step-1'].outputs.sourceReviewRecords=sourceReviewScaffold(si??{});
    form.actions['step-2'].outputs.specialistReviewRecords=specialistScaffold(si??{},domains);
    if(!Object.hasOwn(form.actions['step-1'].outputs,'discoveryReconciliationRecords'))form.automationInputs.expectedSourceReviewKeys=(form.actions['step-1'].outputs.sourceReviewRecords??[]).filter(x=>typeof x==='object').map(x=>x.recordKey);
    form.automationInputs.expectedSpecialistReviewKeys=(form.actions['step-2'].outputs.specialistReviewRecords??[]).filter(x=>typeof x==='object').map(x=>x.recordKey);
    form.automationInputs.controllerOwnedAutomationInputs=uniq([
      ...(form.automationInputs.controllerOwnedAutomationInputs??[]),
      'expectedSourceReviewKeys',
      'expectedSpecialistReviewKeys'
    ]);
  }

  if(sequence===5){
    form.actions['step-1'].outputs.economicReviewRecords=economicScaffold(si??{},form.actions['step-1'].outputs.economicReviewRecords);
    // Prepopulate the same existing reconciliation list from accepted Phase-4
    // sources. Agents must supply substantive interpretations, but no longer
    // hand-transcribe hundreds of subject keys, anchors or prior conclusions.
    const p4=readJsonIf(repoFile(root,path.posix.join(campaignPath,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json')));
    const priorCandidates=p4?.actions?.['step-3']?.outputs?.candidateRecords??[];
    const priorRows=Array.isArray(form.actions?.['step-2']?.outputs?.reconciliationRecords)
      ?form.actions['step-2'].outputs.reconciliationRecords.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)):[];
    const already=new Set(priorRows.map(x=>String(x.subjectKey??'')));
    for(const item of priorCandidates){
      if(!item||typeof item!=='object'||Array.isArray(item))continue;
      const subjectKey=item.tempKey??item.canonicalId??item.candidateKey;
      if(!subjectKey||already.has(String(subjectKey)))continue;
      already.add(String(subjectKey));
      priorRows.push({
        subjectKey,subjectType:'PHASE4_SOURCE_CANDIDATE',
        priorConclusion:item.description??item.securityRationale??'PRIOR_CANDIDATE',
        sourceAnchor:item.sourceAnchor??item.anchors?.[0]??'NONE_IDENTIFIED',
        phase5Observation:'<REQUIRED>',disposition:'<REQUIRED>',
        rationale:'<REQUIRED>',downstreamValidationNeed:'<REQUIRED>',
        automationOwnedFields:['subjectKey','subjectType','priorConclusion','sourceAnchor']
      });
    }
    if(priorRows.length)form.actions['step-2'].outputs.reconciliationRecords=priorRows;
    // v4: freeze candidate-specific target record ownership before any worker claim.
    // Reconciliation retains original candidate key; later new candidates use authorized append slots.
    if(['Audit Skill - Lite-Solo Authority/lite-solo-v4','Audit Skill - Lite-Solo Authority/lite-solo-v5'].includes(authorityRoot)){
      const templates=form.actions?.['step-3']?.outputs?.targetDesigns??[];
      const model=templates.find(x=>x&&typeof x==='object'&&!Array.isArray(x));
      const keys=[...new Set(priorCandidates.filter(x=>x&&typeof x==='object'&&!Array.isArray(x))
       .map(x=>x.tempKey??x.canonicalId??x.candidateKey)
       .filter(x=>typeof x==='string'&&x.trim()&&!x.startsWith('<')&&!['NONE_IDENTIFIED','NO_CANDIDATE'].includes(x)))];
      form.actions['step-3'].outputs.targetDesigns=keys.length
       ?keys.map(candidateKey=>({...structuredClone(model),candidateKey}))
       :['NONE_IDENTIFIED'];
      form.automationInputs.expectedPhase5TargetKeys=keys;
      form.automationInputs.controllerOwnedAutomationInputs=uniq([
       ...(form.automationInputs.controllerOwnedAutomationInputs??[]),'expectedPhase5TargetKeys']);
    }
    // Phase 5 designs its own candidate-specific simulations from reviewed source evidence.
    // No Phase-0 randomized simulation, telemetry, or Medusa baseline is required.
    delete form.automationInputs.phase0BaselineSimulation;
    form.automationInputs.controllerOwnedAutomationInputs=(form.automationInputs.controllerOwnedAutomationInputs??[]).filter(x=>x!=='phase0BaselineSimulation');
  }

  if(sequence===6){
    const deployRows=deployAssessmentScaffold(root,campaignPath);
    const phase5Rows=targetDispositionScaffold(prefillContext.targetDesigns??[],prefillContext.phase5ExecutionResults??{});
    const targetRows=Array.isArray(phase5Rows)?phase5Rows.filter(x=>typeof x==='object'):[];
    form.actions['step-1'].outputs.deploymentAssessments=deployRows;
    form.actions['step-2'].outputs.targetDispositions=targetRows.length?targetRows:['NONE_IDENTIFIED'];
    delete form.automationInputs.phase0SimulationRunIndexRef;
    form.automationInputs.controllerOwnedAutomationInputs=(form.automationInputs.controllerOwnedAutomationInputs??[]).filter(x=>x!=='phase0SimulationRunIndexRef');
    if(form.actions['step-3']){
      form.actions['step-3'].outputs.typedExecutionLimitations=uniq(machineLimitations(deployRows,targetRows));
      const schema=readJsonIf(repoFile(root,path.posix.join(authorityRoot,'phases/phase-6/PHASE_06_SCHEMA_v1.json')))??{};
      form.actions['step-3'].outputs.fullOnlyOmissions=schema.controllerOwnedDefaults?.fullOnlyOmissions??['NONE_IDENTIFIED'];
      form.automationInputs.controllerOwnedOutputPaths=[
        'actions.step-3.outputs.typedExecutionLimitations',
        'actions.step-3.outputs.fullOnlyOmissions'
      ];
    }
  }

  if(sequence===6&&form.actions?.['step-4']&&form.actions?.['step-5']&&
     detectionPolicyForAuthorityV1({repoRoot:root,authorityRoot,readJsonIfExists:(rel)=>readJsonIf(repoFile(root,rel))})){
    const b=readJsonIf(repoFile(root,path.posix.join(campaignPath,'work/phase-06/BASELINE_OBLIGATIONS_v1.json')))?.payload??{};
    const groups=b.testGroups??[],obligations=b.obligations??[];
    form.actions['step-4'].outputs.baselineTestRecords=groups.length?groups.map(g=>({
      testGroupId:g.testGroupId,contract:g.contract,obligationIds:g.obligationIds,
      obligationsDetail:obligations.filter(o=>g.obligationIds.includes(o.obligationId)),
      requestDirectory:'controller/phase6-tests/'+g.testGroupId+'/',
      harnessDesign:'<REQUIRED>',dispatchRounds:'<REQUIRED>',requestPaths:'<REQUIRED>',
      obligationOutcomes:'<REQUIRED>',limitations:'<REQUIRED>',
      automationOwnedFields:['testGroupId','contract','obligationIds','obligationsDetail','requestDirectory']
    })):['NONE_IDENTIFIED'];
    const p4=readJsonIf(repoFile(root,path.posix.join(campaignPath,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json')));
    const p5=readJsonIf(repoFile(root,path.posix.join(campaignPath,'derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json')));
    const sources=[...(p4?.actions?.['step-3']?.outputs?.candidateRecords??[]),
      ...(p5?.actions?.['step-2']?.outputs?.newCandidateRecords??[])].filter(x=>x&&typeof x==='object');
    // This policy-specific Phase-6 branch has a separate lexical scope from
    // the ordinary Phase-6 prefill above; read the persisted output instead.
    const candidateTargets=(form.actions?.['step-2']?.outputs?.targetDispositions??[])
      .filter(x=>x&&typeof x==='object'&&!Array.isArray(x));
    const status=new Map(candidateTargets.map(x=>[x.candidateKey,x.reproductionStatus]));
    // Phase 4 assigns discovery keys (X001-*), whereas Phase 5 often assigns
    // controller target keys (CAND-*). Never interpret an unmatched ID as a
    // candidate-wide evidence failure. Bind only through a unique exact source
    // anchor in the recorded Phase-5 reconciliation, not array position.
    const p5Reconciliation=p5?.actions?.['step-2']?.outputs?.reconciliationRecords??[];
    const anchorTargets=new Map(),duplicateAnchors=new Set();
    for(const row of p5Reconciliation){
      if(!row||typeof row!=='object'||!row.sourceAnchor||!row.subjectKey||!status.has(row.subjectKey))continue;
      if(anchorTargets.has(row.sourceAnchor))duplicateAnchors.add(row.sourceAnchor);
      else anchorTargets.set(row.sourceAnchor,row.subjectKey);
    }
    for(const anchor of duplicateAnchors)anchorTargets.delete(anchor);
    const candidateRows=new Map();
    for(const item of sources){
      const key=item.tempKey??item.candidateKey;
      if(!key||candidateRows.has(key))continue;
      candidateRows.set(key,{
        candidateKey:key,sourceAnchor:item.sourceAnchor??item.anchors?.[0]??'NONE_IDENTIFIED',
        phase5Result:status.get(key)??status.get(anchorTargets.get(item.sourceAnchor??item.anchors?.[0]))??'NOT_EXECUTED',
        requestDirectory:'controller/phase6-tests/CP-'+String(key).replace(/[^A-Za-z0-9._-]/g,'_')+'/',
        verdict:'<REQUIRED>',harnessDesign:'<REQUIRED>',dispatchRounds:'<REQUIRED>',
        requestPaths:'<REQUIRED>',ledgerRef:'<REQUIRED>',
        attackAssertionNames:'<REQUIRED>',controlAssertionNames:'<REQUIRED>',reasoning:'<REQUIRED>',
        automationOwnedFields:['candidateKey','sourceAnchor','phase5Result','requestDirectory']
      });
    }
    form.actions['step-5'].outputs.candidateProofRecords=candidateRows.size?[...candidateRows.values()]:['NONE_IDENTIFIED'];
    form.actions['step-5'].outputs.newCandidateRecords=['NONE_IDENTIFIED'];
  }
  if(sequence===9&&Array.isArray(prefillContext.remediationDeltaRows)){
    const rows=prefillContext.remediationDeltaRows;
    if(rows.length){
      form.actions['step-1'].outputs.changedSurfaceAssessments=rows.map(r=>({
        findingKey:r.findingId??'UNRESOLVED',
        changedSurface:r.changedFilesAndSymbols??'UNRESOLVED',
        affectedCallersOrState:r.affectedSurfaces??'UNRESOLVED',
        securitySignificance:'<REQUIRED>',
        requiredRegressionScope:'<REQUIRED>',
        newRiskOrNone:'<REQUIRED>',
        automationOwnedFields:['findingKey','changedSurface','affectedCallersOrState']
      }));
      form.actions['step-2'].outputs.remediationDispositions=rows.map(r=>{
        const findingKey=r.findingId??'UNRESOLVED';
        return {
          findingKey,
          rerunRequestDirectory:path.posix.join('controller/phase9-reruns',safeSegment(findingKey))+'/',
          rerunEvidenceRefs:['<CONTROLLER_AUTO_COLLECT_AFTER_RERUNS>'],
          rootCauseFixed:'<REQUIRED>',
          regressionAssessment:'<REQUIRED>',
          disposition:'<REQUIRED>',
          rationale:'<REQUIRED>',
          newCandidateOrNone:'<REQUIRED>',
          automationOwnedFields:['findingKey','rerunRequestDirectory']
        };
      });
    }
  }

  // Any phase exposing obligationDispositions consumes the canonical due-obligation set.
  for(const action of Object.values(form.actions??{})){
    if(!action?.outputs||!Object.prototype.hasOwnProperty.call(action.outputs,'obligationDispositions')) continue;
    const due=dueObligationScaffold({root,campaignPath,sequence});
    action.outputs.obligationDispositions=due.rows;
    form.automationInputs.expectedDueObligationIds=due.expectedIds;
    form.automationInputs.controllerOwnedAutomationInputs=uniq([
      ...(form.automationInputs.controllerOwnedAutomationInputs??[]),
      'expectedDueObligationIds'
    ]);
    break;
  }

  refreshControllerPrefillDigest(form);
  return form;
}

export function populatePhase9RerunEvidenceRefs({root,campaignPath,form}){
  const deficiencies=[];
  const rows=form?.actions?.['step-2']?.outputs?.remediationDispositions??[];
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)) continue;
    const findingKey=String(row.findingKey??'').trim();
    if(!findingKey){deficiencies.push('Phase 9 remediation disposition is missing findingKey.');continue;}
    const requestDirRel=typeof row.rerunRequestDirectory==='string'&&row.rerunRequestDirectory
      ? row.rerunRequestDirectory.replace(/\/+$/,'')
      : path.posix.join('controller/phase9-reruns',safeSegment(findingKey));
    const requestDirAbs=repoFile(root,path.posix.join(campaignPath,requestDirRel));
    const requestFiles=walk(requestDirAbs).filter(file=>file.toLowerCase().endsWith('.json'));
    const refs=[];
    let discoveredRequests=0;
    let incompleteRequests=0;
    for(const requestFile of requestFiles){
      const request=readJsonIf(requestFile);
      const requestId=typeof request?.requestId==='string'?request.requestId.trim():'';
      if(!requestId) continue;
      discoveredRequests++;
      const safeRequest=safeSegment(requestId,'request');
      const baseRel=path.posix.join('controller/automation',safeRequest);
      const evidenceRel=path.posix.join(baseRel,'EXECUTION_EVIDENCE_v1.json');
      const observerRel=path.posix.join(baseRel,'EXECUTION_OBSERVER_RECEIPT_v1.json');
      const ingestionRel=path.posix.join(baseRel,'ingestion/EXECUTION_EVIDENCE_INGESTION_RECEIPT_v1.json');
      const evidenceAbs=repoFile(root,path.posix.join(campaignPath,evidenceRel));
      const ingestionAbs=repoFile(root,path.posix.join(campaignPath,ingestionRel));
      const observerAbs=repoFile(root,path.posix.join(campaignPath,observerRel));
      const ingestion=readJsonIf(ingestionAbs);
      const machine=readJsonIf(evidenceAbs);
      const observer=readJsonIf(observerAbs);
      const source=request?.source??{};
      const snapshotRoot=path.posix.join(campaignPath,'remediation/source-snapshots')+'/';
      const snapshotPath=String(source.archivePath??'');
      const archiveName=snapshotPath.startsWith(snapshotRoot)?snapshotPath.slice(snapshotRoot.length):'';
      const sourcePathValid=source.repository==='curveyield3/Audit-Controller'&&
        /^[0-9a-f]{40}$/.test(String(source.commit??''))&&
        /^[a-f0-9]{64}$/.test(String(source.archiveSha256??''))&&
        /^[A-Za-z0-9_.-]+\.zip$/.test(archiveName)&&!archiveName.includes('/');
      let observedSha=null;
      if(sourcePathValid){
        const archiveAbs=repoFile(root,snapshotPath);
        if(fs.existsSync(archiveAbs)&&fs.statSync(archiveAbs).isFile())
          observedSha=createHash('sha256').update(fs.readFileSync(archiveAbs)).digest('hex');
      }
      const sourceVerified=sourcePathValid&&observedSha===source.archiveSha256&&
        observer?.requestId===requestId&&observer?.requestDigest===request.requestDigest&&
        observer?.sourceVerification?.status==='PASS'&&observer.sourceVerification.preExecution===true&&
        observer.sourceVerification.archiveSha256===observedSha&&
        observer.sourceVerification.archivePath===snapshotPath&&
        observer.sourceVerification.sourceCommit===source.commit&&
        machine?.source?.repository===source.repository&&
        machine?.source?.commit===source.commit&&
        machine?.source?.archivePath===snapshotPath&&
        machine?.source?.archiveSha256===observedSha;
      if(!sourceVerified){
        incompleteRequests++;
        deficiencies.push('Phase 9 finding '+findingKey+' rerun '+requestId+
          ' lacks matching source-bound Phase-9 remediation ZIP SHA-256, independently verified pre-execution observer proof, or executed-source identity; do not accept or re-use this test evidence.');
        continue;
      }
      const valid=ingestion?.schemaVersion==='audit-execution-evidence-ingestion-receipt-v1'
        && ingestion.requestId===requestId
        && machine?.requestId===requestId
        && machine?.requestDigest===request.requestDigest
        && machine?.blocking===false
        && ['PASS','FINDINGS'].includes(machine.disposition)
        && (machine?.failedStepCount??0)===0
        && (machine?.analysisComponentFailureCount??0)===0
        && (machine?.failedSteps?.length??0)===0
        && (!machine?.preflight||machine.preflight.status==='PASS');
      if(!valid){
        incompleteRequests++;
        deficiencies.push('Phase 9 finding '+findingKey+' rerun '+requestId+' lacks successful, request-bound, ingested machine execution; a failed or partial rerun is not remediation proof.');
        continue;
      }
      refs.push(evidenceRel,ingestionRel);
      if(fs.existsSync(observerAbs)) refs.push(observerRel);
    }
    if(!discoveredRequests){
      deficiencies.push('Phase 9 finding '+findingKey+' has no rerun execution request under '+requestDirRel+'. Run the required remediation sub-phase tests before validation.');
      continue;
    }
    const uniqueRefs=uniq(refs);
    if(!uniqueRefs.length||incompleteRequests>0){
      if(!uniqueRefs.length)deficiencies.push('Phase 9 finding '+findingKey+' has no complete, successfully ingested rerun evidence. Repair and rerun required machine work before validation.');
      continue;
    }
    row.rerunEvidenceRefs=uniqueRefs;
    row.automationOwnedFields=uniq([...(row.automationOwnedFields??[]),'findingKey','rerunRequestDirectory','rerunEvidenceRefs']);
  }
  form.automationInputs??={};
  refreshControllerPrefillDigest(form);
  return deficiencies;
}

export function phase4CoverageFromForm(form){
  const expectedSource=new Set(form?.automationInputs?.expectedSourceReviewKeys??[]);
  const expectedSpec=new Set(form?.automationInputs?.expectedSpecialistReviewKeys??[]);
  const actualSource=new Set((form?.actions?.['step-1']?.outputs?.sourceReviewRecords??[]).filter(x=>typeof x==='object').map(x=>x.recordKey));
  const actualSpec=new Set((form?.actions?.['step-2']?.outputs?.specialistReviewRecords??[]).filter(x=>typeof x==='object').map(x=>x.recordKey));
  const missing=[
    ...[...expectedSource].filter(x=>!actualSource.has(x)),
    ...[...expectedSpec].filter(x=>!actualSpec.has(x))
  ];
  return {
    coverageSummary:`Required source rows: ${expectedSource.size}; completed/present: ${actualSource.size}. Required specialist rows: ${expectedSpec.size}; completed/present: ${actualSpec.size}.`,
    unreviewedRequiredSurfaces:missing.length?missing:['NONE_IDENTIFIED']
  };
}

export function phase4DiscoveryCoverageV1({summary}){
  const coverage=summary?.payload?.coverage??{};
  const contexts=new Set((coverage.rows??[]).map(x=>x.contextId));
  const records=summary?.payload??{};
  const contradicted=(coverage.rows??[]).filter(x=>x.reviewStatus==='CONTRADICTED').length;
  const accepted=(coverage.rows??[]).filter(x=>x.reviewStatus==='ACCEPTED').length;
  const na=(records.notApplicableClaims??[]).length;
  const gaps=(records.gaps??[]).length;
  const gapIds=[...new Set((records.gaps??[]).flatMap(x=>[x.contextId,...(x.contextIds??[])].filter(Boolean)))].sort();
  return {coverageSummary:'Required contexts: '+contexts.size+'; accepted: '+accepted+
   '; contradicted by attacker: '+contradicted+'; not-applicable claims: '+na+
   '; gaps: '+gaps+'; label: '+(coverage.label??'PARTIAL_COVERAGE')+'.',
    unreviewedRequiredSurfaces:gapIds.length?gapIds:['NONE_IDENTIFIED']};
}

export function materializeValidatedFindings(candidateValidations=[]){
  const out=[];let n=1;
  for(const v of candidateValidations??[]){
    if(v?.findingPromotion!=='PROMOTE_FINDING')continue;
    out.push({
      findingTempKey:'AUTO-FIND-'+String(n++).padStart(3,'0'),
      candidateKey:v.candidateKey,
      title:v.findingTitleOrNone,
      rootCause:v.rootCauseOrNone,
      impact:v.impact,
      severity:v.severity,
      proofEvidenceRefs:v.evidenceRefs,
      controllerMaterialized:true
    });
  }
  return out.length?out:['NONE_IDENTIFIED'];
}

function valuesByName(form,re){
  const out=[];
  for(const action of Object.values(form?.actions??{})){
    for(const [k,v] of Object.entries(action?.outputs??{})) if(re.test(k)) out.push({key:k,value:v});
  }
  return out;
}
function compact(v){
  if(Array.isArray(v))return v.length===1&&typeof v[0]==='string'?v[0]:`${v.length} record(s)`;
  if(v&&typeof v==='object')return JSON.stringify(v);
  return String(v??'NONE_IDENTIFIED');
}
// Separate a finding's retained prior evidence from the execution state of
// the CURRENT phase. A missing new harness cannot negate an older proof.
export function buildCandidateEvidenceContinuityV1({phase5,phase6}){
  const prior=phase5?.actions?.['step-2']?.outputs?.reconciliationRecords??[];
  const runs=phase6?.actions?.['step-2']?.outputs?.targetDispositions??[];
  const proofs=phase6?.actions?.['step-5']?.outputs?.candidateProofRecords??[];
  const byKey=new Map(runs.filter(x=>x&&typeof x==='object'&&x.candidateKey).map(x=>[String(x.candidateKey),x]));
  const priorCounts=new Map(),proofCounts=new Map();
  for(const x of prior)if(x&&typeof x==='object'&&x.sourceAnchor)
    priorCounts.set(x.sourceAnchor,(priorCounts.get(x.sourceAnchor)??0)+1);
  for(const x of proofs)if(x&&typeof x==='object'&&x.sourceAnchor)
    proofCounts.set(x.sourceAnchor,(proofCounts.get(x.sourceAnchor)??0)+1);
  return prior.filter(x=>x&&typeof x==='object'&&x.subjectKey).map(x=>{
    const execution=byKey.get(String(x.subjectKey));
    const proof=priorCounts.get(x.sourceAnchor)===1&&proofCounts.get(x.sourceAnchor)===1
      ?proofs.find(y=>y&&typeof y==='object'&&y.sourceAnchor===x.sourceAnchor):null;
    return {
      candidateKey:String(x.subjectKey),
      sourceAnchor:x.sourceAnchor??'UNBOUND_SOURCE_ANCHOR',
      priorEvidenceInterpretation:x.priorConclusion??'NOT_RECORDED',
      priorEvidenceDisposition:x.disposition??'NOT_RECORDED',
      priorEvidenceBasis:'REVIEWER_INTERPRETATION_NOT_AUTOMATICALLY_REVALIDATED',
      currentPhaseExecutionStatus:execution?.reproductionStatus??'NO_PHASE6_EXECUTION_STATUS',
      currentPhaseOracleOutcome:execution?.oracleOutcome??'NO_PHASE6_ORACLE',
      phase6ProofVerdict:proof?.verdict??'NOT_LINKED_OR_UNRESOLVED',
      phase6ProofCandidateKey:proof?.candidateKey??null,
      phase6ExecutionRounds:proof?.dispatchRounds??null,
      residualLimitation:execution?.limitations??x.downstreamValidationNeed??'SEE_ACCEPTED_SOURCE_EVIDENCE'
    };
  });
}
function nestedUnresolvedEvidenceV1(sourceActions,controllerOutputs){
  const rows=[];
  for(const r of sourceActions?.['step-2']?.outputs?.targetDispositions??[]){
    if(!r||typeof r!=='object'||Array.isArray(r))continue;
    if(['DEFERRED_UNVERIFIED','INCONCLUSIVE','UNRESOLVED','NOT_EXECUTED'].includes(String(r.reproductionStatus??''))||
       ['DEFERRED_UNVERIFIED','INCONCLUSIVE','UNRESOLVED'].includes(String(r.oracleOutcome??'')))
      rows.push('Candidate '+r.candidateKey+': current-phase machine status '+r.reproductionStatus+'; earlier evidence remains separately evaluated');
  }
  for(const r of sourceActions?.['step-5']?.outputs?.candidateProofRecords??[]){
    if(!r||typeof r!=='object'||Array.isArray(r))continue;
    if(['INCONCLUSIVE','NOT_EXECUTED','DEFERRED_UNVERIFIED'].includes(String(r.verdict??''))||
       ['NOT_EXECUTED','DEFERRED_UNVERIFIED'].includes(String(r.phase5Result??'')))
      rows.push('Candidate '+r.candidateKey+': current-phase proof '+r.verdict+'; prior finding not automatically disproved');
  }
  for(const r of sourceActions?.['step-3']?.outputs?.obligationDispositions??[]){
    if(r&&typeof r==='object'&&!Array.isArray(r)&&r.disposition==='BLOCKED_CARRIED')
      rows.push('Open security obligation '+r.obligationId+' (BLOCKED_CARRIED to Phase '+r.carryForwardPhaseOrNone+')');
  }
  const gate=controllerOutputs.find(x=>x.key==='phase5MachineExecutionGate')?.value;
  if(gate?.status==='DEFERRED_UNVERIFIED')rows.push('Phase-5 machine evidence DEFERRED_UNVERIFIED; controller phase PASS is not a machine/security PASS');
  return [...new Set(rows)];
}
export function renderControllerPhaseReport({schema,form,canonical}){
  const phase=schema.phase;
  const sourceActions=canonical?.actions??form?.actions??{};
  const outputs=Object.entries(sourceActions).flatMap(([step,a])=>Object.entries(a?.outputs??{}).map(([key,value])=>({step,key,value})));
  const controllerOutputs=Object.entries(canonical?.automationOutputs??{}).map(([key,value])=>({step:'controller',key,value}));
  const allOutputs=[...outputs,...controllerOutputs];
  const preferred=['liteVerdict','verdictRationale','clientFacingSummary','mergedExecutionConclusions','riskRationale','architectureTrustModel','findingDispositionSynthesis','residualRiskAssessment'];
  const executive=preferred.map(k=>allOutputs.find(x=>x.key===k)?.value).find(v=>v!==undefined)??`Phase ${phase} structured substantive work completed and accepted for controller validation.`;
  const material=allOutputs.filter(x=>!/(limitation|unresolved|ambigu|uncert)/i.test(x.key)).map(x=>`- ${x.step} / ${x.key}: ${compact(x.value)}`).join('\n')||'- NONE_IDENTIFIED';
  const limitationRows=[
    ...valuesByName({actions:sourceActions},/(limitation|ambigu|uncert)/i),
    ...controllerOutputs.filter(x=>/(limitation|ambigu|uncert)/i.test(x.key))
  ];
  const unresolvedRows=[
    ...valuesByName({actions:sourceActions},/unresolved/i),
    ...controllerOutputs.filter(x=>/unresolved/i.test(x.key))
  ];
  const limitations=limitationRows.map(x=>`- ${x.key}: ${compact(x.value)}`).join('\n')||'- NONE_IDENTIFIED';
  const nestedUnresolved=nestedUnresolvedEvidenceV1(sourceActions,controllerOutputs);
  const unresolved=[...unresolvedRows.map(x=>'- '+x.key+': '+compact(x.value)),
    ...nestedUnresolved.map(x=>'- '+x)].join('\n')||'- NONE_IDENTIFIED';
  const continuity=canonical?.automationOutputs?.candidateEvidenceContinuity??[];
  const reconcile=sourceActions?.['step-2']?.outputs?.reconciliationRecords??[];
  const lines=Array.isArray(continuity)&&continuity.length
    ?continuity.map(x=>'- '+x.candidateKey+': PRIOR EVIDENCE — '+x.priorEvidenceInterpretation+
        ' | CURRENT PHASE — '+x.currentPhaseExecutionStatus+
        ' | PHASE-6 PROOF — '+x.phase6ProofVerdict+' | LIMITATION — '+x.residualLimitation)
    :reconcile.filter(x=>x&&typeof x==='object'&&x.subjectKey)
      .map(x=>'- '+x.subjectKey+': PRIOR EVIDENCE — '+String(x.priorConclusion??'NOT_RECORDED')+
        ' | CURRENT-PHASE DISPOSITION — '+String(x.disposition??'NOT_RECORDED'));
  const continuitySection=lines.length?'\n## Prior Evidence vs New Execution\n\n'+lines.join('\n')+'\n':'';
  return `# Phase ${phase} Final Report

> **CONTROLLER-GENERATED:** Deterministically rendered from the accepted schema-governed work form and controller-owned outputs. No hashes, handoff bookkeeping, or predecessor restatement is authored by the reviewer.

## Executive Conclusion

${text(executive)}

## Material Results

${material}
${continuitySection}
## Limitations

${limitations}

## Unresolved Substantive Questions

${unresolved}
`;
}

export function buildControllerPacket({directory,assignment,existing,now}){
  return {
    schemaVersion:'curveyield-lite-phase-work-packet-v1',
    campaignId:directory.campaignId,
    phaseSequence:assignment.phaseSequence,
    status:'SUBMITTED',
    workFormPath:assignment.workFormPath,
    finalReportPath:assignment.finalReportPath??null,
    submissionAttempt:Math.max(0,Number(existing?.submissionAttempt??0))+1,
    submittedAt:now,
    controllerGenerated:true
  };
}

export function validatePhaseScaffold(sequence,form,assignmentExpectedDigest=null){
  const deficiencies=[];
  const formDigest=form?.automationInputs?.controllerPrefillDigestSha256??null;
  const expectedDigest=assignmentExpectedDigest??formDigest;
  const ownedProjection=controllerOwnedProjection(form);
  if(form?.automationInputs&&!expectedDigest) deficiencies.push('Controller prefill integrity digest is missing.');
  else if(ownedProjection.length&&!expectedDigest) deficiencies.push('Controller prefill integrity digest is missing.');
  if(assignmentExpectedDigest&&formDigest!==assignmentExpectedDigest) deficiencies.push('Reviewer work form controller-prefill digest does not match the controller-owned assignment digest.');
  if(expectedDigest&&controllerOwnedDigest(form)!==expectedDigest) deficiencies.push('Controller-prefilled/read-only fields were modified; restore the generated values before validation.');
  if(sequence===4 && Object.hasOwn(form?.automationInputs??{},'expectedDiscoveryRecordKeys')){
    const expected=form.automationInputs.expectedDiscoveryRecordKeys??[];
    const rows=form?.actions?.['step-1']?.outputs?.discoveryReconciliationRecords??[];
    if(rows.some(x=>x==='<PENDING_DISCOVERY>'))deficiencies.push('Phase 4 discovery summary is still pending.');
    const actual=rows.filter(x=>x&&typeof x==='object').map(x=>x.recordKey);
    if(JSON.stringify([...actual].sort())!==JSON.stringify([...expected].sort())||new Set(actual).size!==actual.length)
      deficiencies.push('Phase 4 discovery reconciliation keys must exactly match controller-prefilled keys.');
    const candidates=new Set((form?.actions?.['step-3']?.outputs?.candidateRecords??[]).filter(x=>x&&typeof x==='object').map(x=>x.tempKey));
    for(const row of rows.filter(x=>x&&typeof x==='object')){
      if(!['CANDIDATE_CREATED','RESOLVED_NO_ISSUE','COVERAGE_GAP_ACCEPTED'].includes(row.disposition))
        deficiencies.push('Discovery '+row.recordKey+' requires a valid disposition.');
      if(row.disposition==='CANDIDATE_CREATED'&&!candidates.has(row.candidateTempKeyOrNone))
        deficiencies.push('Discovery '+row.recordKey+' candidate must be present in Step 3.');
      if(row.disposition==='RESOLVED_NO_ISSUE'&&!/\.(sol|vy):L\d+/.test([row.rationale,row.reconciliation].filter(x=>typeof x==='string').join(' ')))
        deficiencies.push('Discovery '+row.recordKey+' resolution requires a source anchor.');
      if(row.disposition==='RESOLVED_NO_ISSUE'&&['ATTACK_FINDING','ATTACK_CONTRADICTS_REVIEW'].includes(row.origin)&&
        !/block|guard|revert|check|restrict|prevent/i.test(row.rationale??''))
        deficiencies.push('Discovery '+row.recordKey+' must name the blocking control.');
      if(row.disposition==='COVERAGE_GAP_ACCEPTED'&&row.origin!=='COVERAGE_GAP')
        deficiencies.push('Discovery '+row.recordKey+' cannot accept a non-gap as a coverage gap.');
    }
  }
  if(sequence===4 && !Object.hasOwn(form?.automationInputs??{},'expectedDiscoveryRecordKeys')){
    const c=phase4CoverageFromForm(form);
    if(!(c.unreviewedRequiredSurfaces.length===1&&c.unreviewedRequiredSurfaces[0]==='NONE_IDENTIFIED')) deficiencies.push('Phase 4 required review scaffolds were removed or omitted: '+c.unreviewedRequiredSurfaces.join(', '));
  }
  if(sequence===5){
    const targets=form?.actions?.['step-3']?.outputs?.targetDesigns??[];
    for(const target of targets){
      if(!target||typeof target!=='object'||Array.isArray(target)) continue;
      const key=String(target.candidateKey??'UNRESOLVED');
      const method=String(target.executionMethod??'').toUpperCase();
      const type=String(target.reproductionType??'').toUpperCase();
      const observation=target.expectedMachineObservation;
      if(method==='NOT_APPLICABLE'){
        if(type!=='NOT_APPLICABLE') deficiencies.push('Phase 5 target '+key+' executionMethod NOT_APPLICABLE requires reproductionType NOT_APPLICABLE.');
        if(observation!=='NOT_APPLICABLE') deficiencies.push('Phase 5 target '+key+' executionMethod NOT_APPLICABLE requires expectedMachineObservation=NOT_APPLICABLE.');
      }else if(method==='V7_REQUEST'){
        if(type==='NOT_APPLICABLE'||!['FOUNDRY_TEST','MEDUSA_PROPERTY','ANVIL_WORKFLOW'].includes(type)) deficiencies.push('Phase 5 target '+key+' V7_REQUEST requires an executable reproductionType.');
        if(!observation||typeof observation!=='object'||Array.isArray(observation)) deficiencies.push('Phase 5 target '+key+' V7_REQUEST requires expectedMachineObservation as a structured object.');
      }
    }
  }
  if(Array.isArray(form?.automationInputs?.expectedDueObligationIds)){
    const expected=[...form.automationInputs.expectedDueObligationIds].sort();
    const actual=[];
    for(const action of Object.values(form?.actions??{})){
      const rows=action?.outputs?.obligationDispositions;
      if(!Array.isArray(rows))continue;
      for(const row of rows) if(row&&typeof row==='object'&&!Array.isArray(row)&&row.obligationId) actual.push(String(row.obligationId));
    }
    actual.sort();
    if(JSON.stringify(actual)!==JSON.stringify(expected)) deficiencies.push('Due-obligation disposition rows do not exactly match controller-prefilled obligations. Expected '+expected.join(', ')+'; got '+actual.join(', ')+'.');
    for(const action of Object.values(form?.actions??{})){
      for(const row of action?.outputs?.obligationDispositions??[]){
        if(!row||typeof row!=='object'||Array.isArray(row))continue;
        const d=String(row.disposition??'');
        const carry=String(row.carryForwardPhaseOrNone??'');
        if(['CARRY_FORWARD','BLOCKED_CARRIED'].includes(d)&&(!carry||carry==='NONE_IDENTIFIED'||Number(carry)<=Number(sequence))) deficiencies.push('Obligation '+String(row.obligationId??'UNRESOLVED')+' requires a later carryForwardPhaseOrNone for disposition '+d+'.');
        if(['SATISFIED','NOT_APPLICABLE'].includes(d)&&carry!=='NONE_IDENTIFIED') deficiencies.push('Obligation '+String(row.obligationId??'UNRESOLVED')+' must use carryForwardPhaseOrNone=NONE_IDENTIFIED for terminal disposition '+d+'.');
      }
    }
  }
  return deficiencies;
}

export function resolveTargetExecutionRequestRef({root,campaignPath,target}){
  if(String(target?.executionMethod??'').toUpperCase()==='NOT_APPLICABLE')return null;
  const rawExplicit=typeof target?.executionRequestRef==='string'&&!target.executionRequestRef.startsWith('<')
    ? target.executionRequestRef
    : null;
  const explicitRef=rawExplicit
    ? (rawExplicit.startsWith(campaignPath+'/')?rawExplicit:path.posix.join(campaignPath,rawExplicit))
    : null;
  const safe=String(target?.candidateKey??'target').replace(/[^A-Za-z0-9._-]+/g,'_');
  const candidates=[
    explicitRef,
    path.posix.join(campaignPath,'work/phase-05/execution-requests',safe+'.json'),
    path.posix.join(campaignPath,'evidence/phase5-target-requests',safe+'.json')
  ].filter(Boolean);
  for(const repoRel of candidates){
    if(repoRel.startsWith('/')||repoRel.split('/').includes('..')) continue;
    if(fs.existsSync(repoFile(root,repoRel))) return path.posix.relative(campaignPath,repoRel);
  }
  return null;
}
