import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {detectionPolicyForAuthorityV1} from '../../packages/github-native-sim/src/adr-policy-v1.mjs';
import {classifyDeploymentExecutionV1} from '../../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {boundReviewerForPhaseV1 as originalReviewerForPhaseV1} from './lite-authority-lineup-v1.mjs';
const boundReviewerForPhaseV1=({authorityRoot,...params})=>['Machine Intelligence Audit Controller/Audit Skill v7','Machine Intelligence Audit Controller/Audit Skill v8'].includes(authorityRoot)?'lite-solo-agent':originalReviewerForPhaseV1({authorityRoot,...params});

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
  const evidenceRel='evidence/source-intelligence';
  const index=readJsonIf(repoFile(root,path.posix.join(campaignPath,
    evidenceRel,'SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json')));
  const accepted=index?.core;
  // When a bundle index exists, ONLY its accepted revision is admissible.
  // An arbitrary lexicographically last JSON may be an unaccepted/stale source.
  if(index){
    // The bundle must refer to this same admitted Phase-0 source, not merely
    // to a self-consistent file hash from an unrelated campaign/revision.
    const phase0=readJsonIf(repoFile(root,path.posix.join(campaignPath,
      'receipts/PHASE_00_RECEIPT_v1.json')));
    if(index?.identity?.campaignId!==phase0?.campaign?.campaignId||
       index?.identity?.campaignGenerationId!==phase0?.campaign?.campaignGenerationId||
       index?.identity?.sourceDigestSha256!==phase0?.source?.sha256)return null;
    const rel=accepted?.latestAcceptedRevision;
    if(accepted?.status!=='ACCEPTED'||
       typeof rel!=='string'||!/^evidence\/source-intelligence\/SOURCE_INTELLIGENCE_v\d+\.json$/.test(rel)||
       !/^[a-f0-9]{64}$/.test(String(accepted.acceptedSha256??'')))return null;
    const file=repoFile(root,path.posix.join(campaignPath,rel));
    try{
      const bytes=fs.readFileSync(file);
      if(createHash('sha256').update(bytes).digest('hex')!==accepted.acceptedSha256)return null;
      const j=JSON.parse(bytes.toString('utf8'));
      return j?.artifactType==='CANONICAL_SOURCE_INTELLIGENCE'?{file,j}:null;
    }catch{return null;}
  }
  // Historical campaigns without a published bundle retain their original
  // v1 path. Do not silently select another unverified revision.
  const file=repoFile(root,path.posix.join(campaignPath,evidenceRel,'SOURCE_INTELLIGENCE_v1.json'));
  const j=readJsonIf(file);
  return j?.artifactType==='CANONICAL_SOURCE_INTELLIGENCE'?{file,j}:null;
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

// Machine matches are discovery signals, not AI-authored exclusion verdicts.
// Keep all original Source Intelligence family inputs and their exact selectors;
// never infer that an absent substring establishes a source-specific negative.
function domainClassificationCorpus(si,matrix){
  const paths=matrix?.machineClassification?.corpusSources??[];
  const inputs=paths.map(source=>{
    const value=getByPath(si,source);
    const serialized=JSON.stringify(value??null);
    return {
      path:source,
      sourceSelector:'#/'+String(source).split('.')
        .map(part=>part.replace(/~/g,'~0').replace(/\//g,'~1')).join('/'),
      availability:value===undefined?'SOURCE_FIELD_UNAVAILABLE':'SOURCE_FIELD_PRESENT',
      inputKind:Array.isArray(value)?'array':value===null?'null':typeof value,
      serializedSha256:createHash('sha256').update(serialized).digest('hex'),
      serializedCharacters:serialized.length,
      serialized
    };
  });
  return {
    text:inputs.map(input=>input.serialized).join('\n').toLowerCase(),
    inputs,
    sourceRefs:inputs.map(({serialized,...ref})=>ref)
  };
}
function evaluateDomainMatcher(si,corpus,matcher){
  if(!matcher||typeof matcher!=='object'||Array.isArray(matcher))
    return {supported:false,matched:false,facts:[],exactMatches:[],
      inputRefs:[],unsupportedReason:'MATCHER_DEFINITION_UNAVAILABLE'};
  if(matcher.kind==='arrayNonEmpty'){
    const pathValid=typeof matcher.path==='string'&&matcher.path.length>0;
    const value=pathValid?getByPath(si,matcher.path):undefined;
    const items=Array.isArray(value)?value:[];
    const selector=pathValid?'#/'+matcher.path.split('.')
      .map(part=>part.replace(/~/g,'~0').replace(/\//g,'~1')).join('/'):null;
    return {
      supported:pathValid,matched:items.length>0,
      facts:items.length?['arrayNonEmpty:'+matcher.path]:[],
      inputRefs:pathValid?[{
        sourcePath:matcher.path,sourceSelector:selector,
        sourceAvailability:value===undefined?'SOURCE_FIELD_UNAVAILABLE':
          Array.isArray(value)?'ARRAY_PRESENT':'SOURCE_VALUE_NOT_ARRAY',
        observedArrayLength:Array.isArray(value)?value.length:null
      }]:[],
      exactMatches:items.map((item,index)=>({
        kind:'arrayNonEmpty',matcherPath:matcher.path,
        sourceSelector:selector+'/'+index,sourceIndex:index,
        observedValueSha256:createHash('sha256').update(JSON.stringify(item)).digest('hex'),
        exactObservedValue:item
      })),
      unsupportedReason:pathValid?null:'ARRAY_MATCHER_PATH_MISSING'
    };
  }
  if(matcher.kind==='textContainsAny'){
    const terms=Array.isArray(matcher.terms)?
      matcher.terms.filter(term=>typeof term==='string'&&term.trim()):[];
    // Preserve the original combined-corpus detection semantics, including
    // every matching term even when no individual positive position is cached.
    const positiveTerms=terms.filter(term=>corpus.text.includes(term.toLowerCase()));
    const exactMatches=[];
    for(const term of positiveTerms){
      const needle=term.toLowerCase();
      for(const input of corpus.inputs){
        const lowered=input.serialized.toLowerCase();
        for(let at=lowered.indexOf(needle);at!==-1;at=lowered.indexOf(needle,at+1)){
          exactMatches.push({
            kind:'textContainsAny',term,exactObservedSubstring:
              input.serialized.slice(at,at+needle.length),
            sourceSelector:input.sourceSelector,
            serializedOffset:at,
            serializedInputSha256:input.serializedSha256
          });
        }
      }
    }
    return {
      supported:terms.length>0,matched:positiveTerms.length>0,
      facts:positiveTerms.map(term=>'textContains:'+term),
      inputRefs:corpus.sourceRefs,
      exactMatches,unsupportedReason:terms.length?null:'TEXT_MATCHER_TERMS_MISSING',
      originalMatcherTerms:terms
    };
  }
  return {
    supported:false,matched:false,facts:[],exactMatches:[],inputRefs:[],
    unsupportedReason:'UNSUPPORTED_MATCHER_KIND:'+String(matcher.kind??'UNSPECIFIED')
  };
}

function classifyDomains(si,matrix,{
  sourceIntelligencePath='UNRESOLVED',sourceIntelligenceSha256=null,
  matrixPath='UNRESOLVED',matrixSha256=null
}={}){
  const corpus=domainClassificationCorpus(si,matrix);
  // Keep the existing deterministic machine-routing behavior exactly. No
  // unmatched domain is auto-promoted to UNCERTAIN_INCLUDE solely to manufacture
  // an AI verdict; later AI review is distinct from this machine signal.
  const complete=si?.completion?.status==='PASS'||si?.completion?.status==='COMPLETE'||
    si?.completion?.noFillSentinelsRemaining===true;
  const allLimitations=Array.isArray(si?.limitations)?si.limitations:[];
  const effectiveLimitations=allLimitations.filter(x=>x&&x.reason&&
    !matchesAny(x.reason,['none','not applicable']));
  return (matrix?.domains??[]).map(d=>{
    const matchers=Array.isArray(d.machineMatchers)?d.machineMatchers:[];
    const results=matchers.map(m=>evaluateDomainMatcher(si,corpus,m));
    const triggered=results.some(result=>result.matched);
    const matcherCoverageComplete=matchers.length>0&&results.every(result=>result.supported);
    const uncertain=!complete||effectiveLimitations.length>0||!matcherCoverageComplete;
    // Legacy classification controls only existing automated routing and
    // generated obligations. NOT_TRIGGERED cannot attest AI inapplicability.
    const classification=triggered?'TRIGGERED':(uncertain?'UNCERTAIN_INCLUDE':'NOT_TRIGGERED');
    const matchedFacts=results.flatMap(result=>result.facts);
    const triggerFacts=triggered?matchedFacts:
      classification==='UNCERTAIN_INCLUDE'?
        [
          ...(!complete?['SOURCE_INTELLIGENCE_INCOMPLETE']:[]),
          ...(effectiveLimitations.length?['SOURCE_INTELLIGENCE_LIMITATIONS_PRESENT']:[]),
          ...(!matcherCoverageComplete?['MACHINE_MATCHER_COVERAGE_INCOMPLETE']:[])
        ]:['COMPLETE_SOURCE_INTELLIGENCE_AND_MATRIX_MATCHERS_FOUND_NO_POSITIVE_TRIGGER'];
    const sourceInput={path:sourceIntelligencePath,sha256:sourceIntelligenceSha256,
      observedCompletion:si?.completion??null,
      originalLimitations:allLimitations.map((limitation,index)=>({
        sourceSelector:'#/limitations/'+index,exactSourceValue:limitation
      }))};
    const matcherEvaluations=results.map((result,index)=>({
      matcherIndex:index,originalMatcherDefinition:matchers[index],
      supported:result.supported,positiveMachineSignal:result.matched,
      exactPositiveFacts:result.facts,
      exactPositiveMatches:result.exactMatches,
      sourceInputReferences:result.inputRefs,
      unsupportedReason:result.unsupportedReason
    }));
    return {
      domainId:d.domainId,
      triggerFacts,
      classification,
      rationale:triggered?
        'Positive deterministic machine signal from accepted Source Intelligence; MiMo applicability has not been decided.':
        classification==='UNCERTAIN_INCLUDE'?
          'Machine signal coverage is incomplete or Source Intelligence has limitations; conservatively retain legacy specialist routing without asserting an AI verdict.':
          'No positive deterministic machine signal detected in the examined inputs; this does not establish source-specific negative evidence or AI inapplicability.',
      requiredPhase4Method:(d.methodResources??[])[0]??'DOMAIN_METHOD_RESOURCE',
      // Preserve the original methodology and source-specific standards
      // verbatim, independent of any current machine match.
      originalDomainMethodology:{
        ledger:d.ledger??null,
        methodResources:d.methodResources??[],
        positiveTriggers:d.positiveTriggers??[],
        negativeEvidenceRequired:d.negativeEvidenceRequired??[],
        requiredExecutionPhases:d.requiredExecutionPhases??[]
      },
      machineClassification:{
        status:triggered?'POSITIVE_MACHINE_SIGNAL':
          uncertain?'NO_POSITIVE_MACHINE_SIGNAL_INCOMPLETE_INPUT':
            'NO_POSITIVE_MACHINE_SIGNAL_DETECTED',
        scope:'DETERMINISTIC_DISCOVERY_AND_LEGACY_ROUTING_ONLY',
        legacyRoutingClassification:classification,
        legacyRoutingStatusMeansAIVerdict:false,
        inputProvenance:{
          sourceIntelligence:sourceInput,
          domainMatrix:{path:matrixPath,sha256:matrixSha256},
          corpusSources:corpus.sourceRefs
        },
        sourceIntelligenceMachineCompleteness:complete,
        machineMatcherCoverageComplete:matcherCoverageComplete,
        unsupportedMatcherCount:results.filter(result=>!result.supported).length,
        exactMatcherEvaluations:matcherEvaluations,
        exactPositiveMachineMatches:matcherEvaluations.flatMap(row=>row.exactPositiveMatches),
        sourceIntelligenceLimitations:sourceInput.observedCompletion===null?
          {availability:'COMPLETION_METADATA_UNAVAILABLE',records:allLimitations}:
          {availability:'SOURCE_LIMITATIONS_RECORDED',records:allLimitations},
        negativeEvidenceStandardSatisfiedByMachine:false
      },
      aiApplicabilityVerdict:null,
      aiApplicabilityStatus:'NOT_AUTHORED',
      aiApplicabilityEvidencePath:null
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

// These are route descriptions, not new specialist work items or an
// automated applicability decision. Existing AI fields and Phase-4 APPEND
// slots remain available even when the classifier saw no matching keyword.
function specialistDiscoveryRoutesV1({registry,phase}){
  const index=(registry?.decisions??[]).map((d,index)=>({
    domainId:d.domainId,
    decisionSourceSelector:'#/decisions/'+index,
    legacyRoutingClassification:d.classification??'UNAVAILABLE',
    machineSignalStatus:d.machineClassification?.status??'UNAVAILABLE',
    aiApplicabilityStatus:d.aiApplicabilityStatus??'NOT_AUTHORED',
    originalMethodologySelector:'#/decisions/'+index+'/originalDomainMethodology',
    exactMachineEvidenceSelector:'#/decisions/'+index+'/machineClassification',
    originalDomainMethodology:structuredClone(d.originalDomainMethodology??null),
    exactMachineTriggerFacts:structuredClone(d.triggerFacts??[]),
    machineEvidenceReference:{
      matrixPath:registry?.matrixPath??null,
      registrySourceSelector:'#/decisions/'+index+'/machineClassification'
    }
  }));
  return {
    artifactType:'MIMO_SPECIALIST_AI_AUTHORING_ROUTES',
    activePhase:phase,
    registrySource:{
      path:'controller/DOMAIN_APPLICABILITY_REGISTRY_v1.json',
      availability:index.length?'SOURCE_BOUND_DECISIONS_PRESENT':'SOURCE_UNAVAILABLE',
      sourceIntelligencePath:registry?.sourceIntelligencePath??null,
      sourceIntelligenceSha256:registry?.sourceIntelligenceSha256??null,
      domainMatrixPath:registry?.matrixPath??null,
      domainMatrixSha256:registry?.matrixSha256??null
    },
    domainSignalIndex:index,
    machineNegativeIsNotApplicabilityVerdict:true,
    noAutomaticSpecialistWorkForUnmatchedDomains:true,
    preserveMachinePositivePrefills:true,
    authoringContracts:{
      phase3:{
        architectureReasoning:'actions.step-1.outputs.architectureTrustModel',
        independentHypotheses:'actions.step-1.outputs.attackHypotheses',
        formalValidationObligations:'actions.step-2.outputs.customValidationObligations',
        method:'Direct original form fields: use source-bound reasoning and fully typed AI-authored records. Preserve each exact source anchor, verification method, requiredPhase and property in the authored record.'
      },
      phase4:{
        specialistReview:'actions.step-2.outputs.specialistReviewRecords',
        sourceBoundCandidates:'actions.step-3.outputs.candidateRecords',
        unresolvedLimitations:'actions.step-3.outputs.typedLimitations',
        method:'Existing semantic APPEND unit in each array accepts new typed AI-authored records even without a controller-prefilled specialist row. Preserve original sourceAnchor, method and observation; controller allocates mechanical recordKey. A free-text mention does not create a record.'
      }
    },
    downstreamSourceRecords:{
      phase5:'actions.step-2.outputs.reconciliationRecords / newCandidateRecords',
      phase6:'actions.step-5.outputs.candidateProofRecords / newCandidateRecords; actions.step-3.outputs.obligationDispositions',
      phase8:'actions.step-2.outputs.candidateValidations / validatedFindings',
      phase10:'actions.step-1.outputs.findingDispositionSynthesis / residualRiskAssessment'
    },
    interpretationRule:'MiMo evaluates source-specific applicability, source uncertainty and independent specialist mechanisms. Never treat a machine-negative matcher as an AI exclusion, invent a finding from text, or promote an unexecuted hypothesis into machine proof.'
  };
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
 if(root&&authorityRoot){
  try{return boundReviewerForPhaseV1({root,authorityRoot,phase:n});}
  catch{return 'UNRESOLVED_REVIEWER';} // Worker validates due-phase applicability.
 }
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
// Bind every imported obligation to its EXACT original submitted object,
// including optional AI source references, proposed validation method and
// property. Neither normalization nor deduplication is a security judgment.
export function normalizeFormalObligationsIntoLedger({
  ledger,items=[],originPhase,canonicalRel,now,root=null,authorityRoot=null,
  sourceCollectionPath=null,sourceKind=null,sourceDocumentPath=null,
  originalRecordOrigins=[]
}){
  ledger.obligations??=[];
  const byId=new Map(ledger.obligations.map((o,i)=>[
    String(o?.obligationId??''),i]).filter(([id])=>id));
  let created=0;
  (Array.isArray(items)?items:[items]).forEach((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))return;
    if(item.requiredPhase===undefined||!item.requiredAction||!item.completionCondition)return;
    const originalRequiredPhase=structuredClone(item.requiredPhase);
    const originalSubmission=structuredClone(item);
    const sourceSelector=typeof sourceCollectionPath==='string'&&sourceCollectionPath
      ?'#/'+sourceCollectionPath.split('.').map(k=>k.replace(/~/g,'~0')
        .replace(/\//g,'~1')).join('/')+'/'+index:null;
    const originalCanonicalRecordPath=
      typeof sourceCollectionPath==='string'?
       sourceCollectionPath+'['+index+']':null;
    const matchingSources=Array.isArray(originalRecordOrigins)?
      originalRecordOrigins.filter(ref=>ref?.canonicalRecordSelector===
       originalCanonicalRecordPath):[];
    const submittedSourceRef={canonicalPath:canonicalRel,
      originalDocumentPath:sourceDocumentPath??canonicalRel,
      originalSourceSelector:sourceSelector,
      sourceKind:sourceKind??(item.automationGenerated===true?
        'CONTROLLER_MACHINE_ROUTING':'AI_AUTHORED_PHASE_OUTPUT'),
      ...(matchingSources.length===1?
       {originalAcceptedRecordSource:structuredClone(matchingSources[0])}:
       matchingSources.length>1?
        {originalSourceAvailability:'MULTIPLE_SOURCE_RECORDS_FOR_CANONICAL_POSITION'}:{})
    };
    const submittedSourceRefs={
      originatingEvidenceRefs:structuredClone(item.originatingEvidenceRefs??null),
      evidenceRefs:structuredClone(item.evidenceRefs??null),
      sourceRefs:structuredClone(item.sourceRefs??null),
      sourceAnchor:structuredClone(item.sourceAnchor??null),
      originFactKeys:structuredClone(item.originFactKeys??null)
    };
    const normalizedRefs=uniq([
      canonicalRel,sourceDocumentPath,...evidenceList(item.originatingEvidenceRefs),
      ...evidenceList(item.evidenceRefs),...evidenceList(item.sourceRefs)
    ]);
    const requiredPhase=String(item.requiredPhase)==='7'?'6':String(item.requiredPhase);
    const obligationId=obligationIdFor(item,originPhase,index);
    const existingIndex=byId.get(obligationId);
    if(existingIndex!==undefined){
      const existing=ledger.obligations[existingIndex];
      // Accepted identifiers, original required phase, assigned reviewer,
      // disposition, closure and author-owned descriptions are not changed by
      // any later machine routing result or a duplicate import.
      existing.originatingFactIds=uniq([
        ...(existing.originatingFactIds??[]),
        ...(Array.isArray(item.originFactKeys)?item.originFactKeys:
          Array.isArray(item.originatingFactIds)?item.originatingFactIds:[])
      ]);
      existing.originatingEvidenceRefs=uniq([
        ...(existing.originatingEvidenceRefs??[]),...normalizedRefs
      ]);
      existing.requiredPhase=existing.requiredPhase??requiredPhase;
      existing.requiredReviewer=existing.requiredReviewer??
        reviewerForRequiredPhase(existing.requiredPhase,root,authorityRoot);
      existing.requiredAction=existing.requiredAction??item.requiredAction;
      existing.completionCondition=existing.completionCondition??item.completionCondition;
      // Add provenance only if historical ledger did not already preserve it.
      // If an identity is reused for different content, leave the accepted
      // record intact and expose the exact conflict as data, not as a veto.
      if(existing.originalSubmittedRecord===undefined){
        existing.originalSubmittedRecord=originalSubmission;
        existing.originalSubmittedSourceRef=submittedSourceRef;
        existing.authorSubmittedSourceRefs=submittedSourceRefs;
        existing.authorSubmittedRequiredPhase=originalRequiredPhase;
        existing.authorSubmittedValidationMethod=structuredClone(
          item.validationMethod??item.recommendedValidationMethod??null);
        existing.authorSubmittedProperty=structuredClone(
          item.property??item.propertyOrInvariant??item.propertyStatement??null);
      }else if(JSON.stringify(existing.originalSubmittedRecord)!==
                JSON.stringify(originalSubmission)){
        const collisions=existing.additionalSubmissionConflicts??(
          existing.additionalSubmissionConflicts=[]);
        if(!collisions.some(x=>x.sourceRef?.canonicalPath===canonicalRel&&
            x.sourceRef?.originalSourceSelector===sourceSelector&&
            JSON.stringify(x.submittedRecord)===JSON.stringify(originalSubmission)))
          collisions.push({sourceRef:submittedSourceRef,submittedRecord:originalSubmission,
            status:'DUPLICATE_ID_DIFFERENT_SOURCE_RECORD',
            dispositionOwner:'CLOUDFLARE_WORKER_OR_MIMO'});
      }
      // Different accepted records may legitimately repeat the same formal
      // obligation ID or even identical prose. The normalized ledger state
      // has one key, but the full original source history must not collapse.
      existing.additionalSubmittedSourceRecords??=[];
      const sourceUnique=JSON.stringify(submittedSourceRef);
      if(JSON.stringify(existing.originalSubmittedSourceRef)!==sourceUnique&&
         !existing.additionalSubmittedSourceRecords.some(entry=>
          JSON.stringify(entry.sourceRef)===sourceUnique))
       existing.additionalSubmittedSourceRecords.push({
        sourceRef:submittedSourceRef,
        submittedRecord:originalSubmission,
        authorSubmittedSourceRefs:submittedSourceRefs,
        authorSubmittedRequiredPhase:originalRequiredPhase
       });
      existing.updatedAt=now;
      return;
    }
    ledger.obligations.push({
      obligationId,
      originPhase:String(originPhase),
      originatingFactIds:uniq([
        ...(Array.isArray(item.originFactKeys)?item.originFactKeys:
          Array.isArray(item.originatingFactIds)?item.originatingFactIds:[])
      ]),
      originatingEvidenceRefs:normalizedRefs,
      requiredPhase,
      requiredReviewer:reviewerForRequiredPhase(requiredPhase,root,authorityRoot),
      requiredAction:item.requiredAction,
      completionCondition:item.completionCondition,
      mandatory:item.mandatory!==false,
      status:'OPEN',
      statusReason:null,
      closureEvidenceRefs:[],
      supersedesOrReplaces:[],
      // Original user/AI-authored source is preserved losslessly even when
      // the ledger's standard mechanics use normalized IDs/phase strings.
      originalSubmittedRecord:originalSubmission,
      originalSubmittedSourceRef:submittedSourceRef,
      additionalSubmittedSourceRecords:[],
      authorSubmittedSourceRefs:submittedSourceRefs,
      authorSubmittedRequiredPhase:originalRequiredPhase,
      authorSubmittedValidationMethod:structuredClone(
        item.validationMethod??item.recommendedValidationMethod??null),
      authorSubmittedProperty:structuredClone(
        item.property??item.propertyOrInvariant??item.propertyStatement??null),
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
  const rows=[],sourceRows=[
    ...(canonical.automationOutputs?.acceptedUnitRecordOrigins?.records??[]),
    ...(canonical.automationOutputs?.directPhaseRecordOrigins?.records??[])
  ];
  for(const [step,action] of Object.entries(canonical?.actions??{})){
    const value=action?.outputs?.obligationDispositions;
    if(!Array.isArray(value))continue;
    for(const [index,row] of value.entries()){
      if(!row||typeof row!=='object'||Array.isArray(row))continue;
      const selector='actions.'+step+'.outputs.obligationDispositions['+index+']';
      const matches=sourceRows.filter(x=>x?.canonicalRecordSelector===selector);
      rows.push({row,selector,
        originalAcceptedRecordSource:matches.length===1?matches[0]:null,
        sourceAvailability:matches.length===1?'SOURCE_BOUND':
         matches.length>1?'AMBIGUOUS_ORIGINAL_SOURCE':'ORIGINAL_SOURCE_UNAVAILABLE'});
    }
  }
  for(const {row,selector,originalAcceptedRecordSource,sourceAvailability} of rows){
    const id=String(row.obligationId??'').trim();
    const obligation=byId.get(id);
    if(!obligation){
      (ledger.githubDiagnostics??=[]).push({phase:sequence,
        code:'UNKNOWN_OBLIGATION_DISPOSITION',obligationId:id,
        originalSourceSelector:selector,
        originalAcceptedRecordSource:originalAcceptedRecordSource??
          {availability:sourceAvailability},
        originalSubmittedRecord:structuredClone(row),
        validationDelegatedTo:'CLOUDFLARE_WORKER'});
      continue;
    }
    obligation.acceptedDispositionSources??=[];
    const sourceId=canonicalRel+'#'+selector;
    if(!obligation.acceptedDispositionSources.some(x=>x.sourceId===sourceId))
      obligation.acceptedDispositionSources.push({sourceId,
        canonicalArtifactPath:canonicalRel,originalSourceSelector:selector,
        sourceAvailability,
        originalAcceptedRecordSource:originalAcceptedRecordSource?
          structuredClone(originalAcceptedRecordSource):null,
        submittedRecord:structuredClone(row)});
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
      (ledger.githubDiagnostics??=[]).push({phase:sequence,code:'UNSUPPORTED_OBLIGATION_DISPOSITION',obligationId:id,disposition,validationDelegatedTo:'CLOUDFLARE_WORKER'});
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
  // Preserve malformed carried obligations for Worker remediation instead of
  // preventing successor scaffold generation on GitHub.
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

// Preserve phase-4/5/6 histories across EVERY successor boundary, even when
// the immediate derived-input selector omits an older phase. Read the original
// sealed canonical rosters; NEVER summarize or infer their security meaning.
function inheritedQuestionHistoryRefsV1({root,campaignPath,sequence}){
 const refs=[],unavailable=[],seen=new Set();
 for(const phase of [4,5,6]){
  if(phase>=sequence)continue;
  const canonical=readJsonIf(repoFile(root,path.posix.join(campaignPath,
   'derived/phase-'+phase+'/PHASE_'+String(phase).padStart(2,'0')+'_CANONICAL_DATA_v1.json')));
  const roster=canonical?.automationOutputs?.questionHistoryRoster;
  if(!Array.isArray(roster?.histories))continue;
  for(const ref of roster.histories){
   if(!ref||typeof ref.unitId!=='string')continue;
   const identity=phase+':'+ref.unitId;
   if(seen.has(identity))continue;
   seen.add(identity);
   if(ref.availability==='AVAILABLE'||ref.previousCommittedIndex)
    refs.push(structuredClone(ref));
   else unavailable.push({phaseSequence:phase,unitId:ref.unitId,
    availability:ref.availability??'UNREADABLE',indexPath:ref.indexPath??null});
  }
 }
 return {refs,unavailable};
}
// Mechanical references into the original accepted Phase 1 canonical source.
// This roster is an index, not a promotion, summarization, or security finding.
function originalPhase1DiscoveryRosterV1({root,campaignPath}){
  const canonicalPath=path.posix.join(campaignPath,'derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json');
  const sourceFile=repoFile(root,canonicalPath);
  const exists=fs.existsSync(sourceFile);
  let canonical=null,canonicalSha256=null;
  if(exists){
    try{
      const bytes=fs.readFileSync(sourceFile);
      canonicalSha256=createHash('sha256').update(bytes).digest('hex');
      const value=JSON.parse(bytes.toString('utf8'));
      if(value&&typeof value==='object'&&!Array.isArray(value))canonical=value;
    }catch{/* Preserve an explicit availability diagnostic, not a fabricated empty finding. */}
  }
  // Bind provenance to the Phase 1 receipt that actually recorded this canonical
  // artifact's SHA-256, not to an unrelated later-phase predecessor receipt.
  const receiptsRel=path.posix.join(campaignPath,'receipts');
  const receiptsDir=repoFile(root,receiptsRel);
  let acceptedReceiptPath=null,acceptedSourceSha256=null;
  let receiptBinding='RECEIPT_UNAVAILABLE';
  let names=[];
  if(canonicalSha256&&fs.existsSync(receiptsDir)){
    try{
      names=fs.readdirSync(receiptsDir).filter(name=>/^PHASE_01_RECEIPT_v\d+\.json$/.test(name))
        .sort((a,b)=>Number(b.match(/_v(\d+)\.json$/)[1])-Number(a.match(/_v(\d+)\.json$/)[1]));
    }catch{receiptBinding='RECEIPT_DIRECTORY_UNREADABLE';}
  }
  if(names.length){
    receiptBinding='CANONICAL_DIGEST_NOT_IN_PHASE1_RECEIPTS';
    for(const name of names){
      const rel=path.posix.join(receiptsRel,name);
      const receipt=readJsonIf(repoFile(root,rel));
      const evidence=[...(receipt?.evidence??[]),...(receipt?.outputs??[])];
      const matching=receipt?.phase?.sequence===1&&
        ['SEALED','COMPLETE'].includes(receipt?.phase?.status)&&
        receipt?.campaign?.campaignId===canonical?.campaignId&&
        evidence.some(ref=>ref?.role==='PHASE_CANONICAL_DATA'&&
          ref.path==='derived/phase-1/PHASE_01_CANONICAL_DATA_v1.json'&&
          ref.sha256===canonicalSha256);
      if(!matching)continue;
      acceptedReceiptPath=rel;
      acceptedSourceSha256=receipt?.source?.sha256??null;
      receiptBinding='MATCHED_PHASE1_RECEIPT';
      break;
    }
  }
  const definitions=[
    {discoveryPass:'D4',step:'step-4',field:'standardsAssessments',recordKeyField:'standardKey'},
    {discoveryPass:'D6',step:'step-5',field:'riskDrivers',recordKeyField:'driverKey'},
    {discoveryPass:'D7',step:'step-6',field:'phase1Limitations',recordKeyField:null}
  ];
  const actions=canonical?.actions??{};
  const leadCollections=definitions.map(({discoveryPass,step,field,recordKeyField})=>{
    const records=actions?.[step]?.outputs?.[field];
    return {
      discoveryPass,
      sourceSelector:`actions.${step}.outputs.${field}`,
      recordKeyField,
      recordCount:Array.isArray(records)?records.length:null,
      availability:Array.isArray(records)?'AVAILABLE':'SOURCE_COLLECTION_UNAVAILABLE'
    };
  });
  const leadRefs=[];
  if(canonical){
    for(const {discoveryPass,step,field,recordKeyField} of definitions){
      const records=actions?.[step]?.outputs?.[field];
      if(!Array.isArray(records))continue;
      records.forEach((record,index)=>{
        const recordKey=recordKeyField&&record&&typeof record==='object'&&!Array.isArray(record)
          ?record[recordKeyField]??null:null;
        leadRefs.push({
          discoveryPass,
          sourceSelector:`actions.${step}.outputs.${field}[${index}]`,
          sourceIndex:index,
          recordKey,
          recordJsonSha256:createHash('sha256').update(JSON.stringify(record)).digest('hex')
        });
      });
    }
  }
  const allPhase1OutputSelectors=Object.entries(actions).flatMap(([step,action])=>
    Object.keys(action?.outputs??{}).map(field=>`actions.${step}.outputs.${field}`));
  return {
    schemaVersion:'curveyield-phase1-discovery-source-roster-v1',
    sourcePhaseSequence:1,
    canonicalPath,
    canonicalSha256,
    sourceIdentity:{
      campaignId:canonical?.campaignId??null,
      acceptedSourceSha256,
      originalCanonicalSha256:canonicalSha256,
      acceptedReceiptPath,
      receiptBinding
    },
    availability:canonical?(acceptedReceiptPath?'AVAILABLE':'ACCEPTANCE_UNVERIFIED'):
      exists?'SOURCE_UNREADABLE':'SOURCE_UNAVAILABLE',
    allPhase1SourceSelector:'actions',
    allPhase1OutputSelectors,
    leadCollections,
    leadRefs,
    securityDispositionOwner:'AI_REVIEWER'
  };
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
  // Re-index the immutable original Phase 1 canonical on each newly issued
  // Machine Intelligence successor assignment; never rewrite an accepted phase.
  if(sequence>=2&&authorityRoot==='Machine Intelligence Audit Controller/Audit Skill v8'){
    form.automationInputs.phase1DiscoverySourceRoster=originalPhase1DiscoveryRosterV1({
      root,campaignPath
    });
    form.automationInputs.controllerOwnedAutomationInputs=uniq([
      ...form.automationInputs.controllerOwnedAutomationInputs,
      'phase1DiscoverySourceRoster'
    ]);
  }
  if(sequence>4){
    // Phase 10 receives fresh controller-collected rosters when available;
    // all other successor stages inherit their sealed canonical references.
    // This is mechanical provenance copying, never security disposition.
    const source=sequence===10&&Array.isArray(prefillContext.questionHistoryRosters)
      ?prefillContext.questionHistoryRosters:null;
    const inherited=source
      ?{refs:source.flatMap(r=>r?.histories??[]).filter(r=>
          r?.availability==='AVAILABLE'||r?.previousCommittedIndex),
        unavailable:source.flatMap(r=>
          (r?.histories??[]).filter(x=>
            x?.availability!=='AVAILABLE'&&!x?.previousCommittedIndex)
          .map(x=>({phaseSequence:r.phaseSequence,unitId:x.unitId,
            indexPath:x.indexPath??null,availability:x.availability??'UNREADABLE'}))
        ).concat(source.filter(r=>r?.availability!=='COLLECTED_NONBLOCKING')
          .map(r=>({phaseSequence:r.phaseSequence,unitId:'UNAVAILABLE',
            indexPath:null,availability:r.availability??'UNREADABLE'})))}
      :inheritedQuestionHistoryRefsV1({root,campaignPath,sequence});
    if(inherited.refs.length||inherited.unavailable.length){
      form.automationInputs.questionHistoryRefs=inherited.refs;
      form.automationInputs.questionHistoryUnavailable=inherited.unavailable;
      form.automationInputs.controllerOwnedAutomationInputs=uniq([
        ...(form.automationInputs.controllerOwnedAutomationInputs??[]),
        'questionHistoryRefs','questionHistoryUnavailable'
      ]);
    }
  }
  // Continue exact accepted discovery evidence across the audit phases.
  // A missing summary remains a nonblocking availability diagnostic.
  if([4,5,6,8,10].includes(sequence)){
    const summaryRel=path.posix.join(campaignPath,
      'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json');
    const summaryFile=repoFile(root,summaryRel),summary=readJsonIf(summaryFile);
    let summarySha256=null;
    try{if(fs.existsSync(summaryFile))
      summarySha256=createHash('sha256').update(fs.readFileSync(summaryFile)).digest('hex');}
    catch{/* Report missing source; never reject other accepted work. */}
    const details=summary?.payload??{};
    form.automationInputs.discoveryEvidenceContinuity={
      schemaVersion:'curveyield-discovery-evidence-continuity-v1',
      sourcePhaseSequence:4,summaryPath:summaryRel,summarySha256,
      availability:summary?
       (summarySha256?'AVAILABLE':'SOURCE_HASH_UNAVAILABLE'):
       (summarySha256?'SUMMARY_UNREADABLE':
        sequence===4?'PENDING_DISCOVERY':'SOURCE_UNAVAILABLE'),
      sourceCollections:[
        'discoverySourceRefs','reconciliationEvidenceRefs',
        'candidateSourceRefIndexes','integrationAnswerRefs','flowNotes',
        'unmappedAttackPathRefs','unmappedAttackPathSources',
        'extraAttackPathRefs','functionVerdictObservations',
        'functionVerdicts','trivialReviewSubstitutions','contractLevelFindings',
        'discoveryState.scopedClassAssessments',
        'coverage.functionReviewSummary','coverage.classEvidenceSummary'
      ],
      counts:{
        reconciliationItems:Array.isArray(details.reconciliationItems)?details.reconciliationItems.length:null,
        discoverySourceRefs:Array.isArray(details.discoverySourceRefs)?details.discoverySourceRefs.length:null,
        candidateSourceRefIndexes:Array.isArray(details.candidateSourceRefIndexes)?details.candidateSourceRefIndexes.length:null,
        integrationAnswerRefs:Array.isArray(details.integrationAnswerRefs)?details.integrationAnswerRefs.length:null,
        flowNotes:Array.isArray(details.flowNotes)?details.flowNotes.length:null,
        unmappedAttackPathRefs:Array.isArray(details.unmappedAttackPathRefs)?details.unmappedAttackPathRefs.length:null,
        extraAttackPathRefs:Array.isArray(details.extraAttackPathRefs)?details.extraAttackPathRefs.length:null,
        functionVerdictObservations:Array.isArray(details.functionVerdictObservations)?details.functionVerdictObservations.length:null,
        functionVerdicts:details.functionVerdicts&&typeof details.functionVerdicts==='object'?
          Object.keys(details.functionVerdicts).length:null,
        trivialReviewSubstitutions:Array.isArray(details.trivialReviewSubstitutions)?
          details.trivialReviewSubstitutions.length:null,
        contractLevelFindings:Array.isArray(details.contractLevelFindings)?
          details.contractLevelFindings.length:null
      },
      evidenceDimensions:{
        functionReview:details.coverage?.functionReviewSummary??null,
        classAssessment:details.coverage?.classEvidenceSummary??null,
        executedProperty:'SEPARATE_QUALIFIED_MACHINE_EVIDENCE_ONLY'
      },
      reviewInstruction:'Follow the original accepted source selector and SHA-256, never a 600-character preview. An overall CORRECT function verdict does not establish all security classes as SUPPORTED. Keep function review, explicit class assessments and executed property proof separate. Inspect FLOW/ATTACK integration answers, notes, candidates, scoped checks and unmapped paths. The AI decides security significance.',
      securityDispositionOwner:'AI_REVIEWER',
      evidenceStatusPolicy:'SOURCE_UNAVAILABLE_IS_VISIBLE_NONBLOCKING'
    };
    if(summarySha256)
      form.automationInputs.derivedInputPaths=uniq([
        ...form.automationInputs.derivedInputPaths,summaryRel]);
    form.automationInputs.controllerOwnedAutomationInputs=uniq([
      ...form.automationInputs.controllerOwnedAutomationInputs,
      'discoveryEvidenceContinuity']);
  }
  const siEntry=findSourceIntelligence(root,campaignPath);
  const si=siEntry?.j??null;
  const derived=loadDerived(root,derivedInputPaths);

  if(sequence===1&&!si){
    // Missing or unverified Source Intelligence cannot silently become an empty
    // discovered dependency inventory. This is a diagnostic, never a blocker.
    const indexRel='evidence/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_INDEX_v1.json';
    const hasIndex=fs.existsSync(repoFile(root,path.posix.join(campaignPath,indexRel)));
    form.automationInputs.sourceIntelligenceAvailability={
      status:hasIndex?'ACCEPTED_SOURCE_INTELLIGENCE_NOT_VERIFIABLE':'SOURCE_INTELLIGENCE_v1_UNAVAILABLE',
      bundleIndexPath:hasIndex?indexRel:null,
      sourceIdentityVerification:'NOT_ESTABLISHED',
      implication:'Exact callsite coverage cannot be inferred from missing Source Intelligence.'
    };
    form.automationInputs.controllerOwnedAutomationInputs=uniq([
      ...form.automationInputs.controllerOwnedAutomationInputs,'sourceIntelligenceAvailability']);
  }
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
    // One assessment subject per original Source Intelligence callsite, not per dependency name.
    // Preserve the original interface ID when unique; for legacy missing/ambiguous IDs,
    // use the exact immutable Source Intelligence array selector as the source-bound key.
    const interfaces=Array.isArray(si.externalInterfaces)?si.externalInterfaces:[];
    const sourceRef=path.relative(repoFile(root,campaignPath),siEntry.file).split(path.sep).join('/');
    const idCounts=new Map();
    for(const e of interfaces){
      const id=typeof e?.interfaceId==='string'?e.interfaceId.trim():'';
      if(id)idCounts.set(id,(idCounts.get(id)??0)+1);
    }
    const deps=interfaces.map((e,index)=>{
      const id=typeof e?.interfaceId==='string'?e.interfaceId.trim():'';
      return {
        dependencyKey:id&&idCounts.get(id)===1?id:`SOURCE_INTELLIGENCE:${sourceRef}#externalInterfaces[${index}]`,
        identity:e?.dependencyOrInterface??e?.interfaceOrType??e?.targetContractId??'UNRESOLVED_INTERFACE',
        trustAssumptions:'<REQUIRED>',
        failureModes:'<REQUIRED>',
        authorityImplications:'<REQUIRED>',
        securitySignificance:'<REQUIRED>',
        laterEvidenceNeeds:'<REQUIRED>',
        automationOwnedFields:['dependencyKey','identity']
      };
    });
    if(deps.length)form.actions['step-3'].outputs.dependencyAssessments=deps;
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
    const matrixFile=repoFile(root,matrixRel);
    const matrix=readJsonIf(matrixFile)??{};
    const sourceIntelligencePath=siEntry?
      path.relative(repoFile(root,campaignPath),siEntry.file).split(path.sep).join('/'):
      'UNRESOLVED';
    const sourceIntelligenceSha256=siEntry?
      createHash('sha256').update(fs.readFileSync(siEntry.file)).digest('hex'):null;
    const matrixSha256=fs.existsSync(matrixFile)?
      createHash('sha256').update(fs.readFileSync(matrixFile)).digest('hex'):null;
    const domains=classifyDomains(si??{},matrix,{
      sourceIntelligencePath,sourceIntelligenceSha256,
      matrixPath:matrixRel,matrixSha256
    });
    // The legacy decision and obligation fields are deterministic routing
    // compatibility data. AI-specific applicability requires a separate
    // model-authored conclusion supported by the original negative standards.
    const obligations=domainObligations(matrix,domains);
    const registryRel=path.posix.join(campaignPath,'controller/DOMAIN_APPLICABILITY_REGISTRY_v1.json');
    writeJson(repoFile(root,registryRel),{
      schemaVersion:'audit-v7-domain-applicability-registry-v1',
      artifactId:'DOMAIN_APPLICABILITY_REGISTRY',
      sourceIntelligencePath,
      sourceIntelligenceSha256,
      matrixPath:matrixRel,matrixSha256,
      sourceIdentity:si?.identity?.sourceIdentity??si?.identity?.sourceDigestSha256??'UNRESOLVED',
      decisions:domains,
      decisionsScope:'LEGACY_DETERMINISTIC_MACHINE_ROUTING_ONLY',
      aiApplicabilityVerdict:null,
      aiApplicabilityStatus:'NOT_AUTHORED',
      machineNegativeInterpretation:'NOT_TRIGGERED means NO_POSITIVE_MACHINE_SIGNAL_DETECTED, not an AI-authored or source-negative specialist exclusion.',
      generatedObligations:obligations,
      owner:'CONTROLLER_AUTOMATION_AT_PHASE_2_BOUNDARY'
    });
    form.automationInputs.sourceIntelligencePath=siEntry?path.relative(repoFile(root,campaignPath),siEntry.file).split(path.sep).join('/'):'UNRESOLVED';
    form.automationInputs.domainRegistryPath=path.posix.relative(campaignPath,registryRel);
    form.automationInputs.controllerOwnedAutomationInputs=[...(form.automationInputs.controllerOwnedAutomationInputs??[]),'sourceIntelligencePath','domainRegistryPath'];
  }
  if([3,4,5,6,8,10].includes(sequence)){
    const registryRel=path.posix.join(campaignPath,'controller/DOMAIN_APPLICABILITY_REGISTRY_v1.json');
    const registry=readJsonIf(repoFile(root,registryRel));
    // If no accepted/issued registry exists, expose the absence; never
    // manufacture an AI verdict or auto-add unmatched specialist obligations.
    form.automationInputs.specialistDiscoveryRoutes=specialistDiscoveryRoutesV1({
      registry,phase:sequence
    });
    form.automationInputs.controllerOwnedAutomationInputs=uniq([
      ...(form.automationInputs.controllerOwnedAutomationInputs??[]),
      'specialistDiscoveryRoutes'
    ]);
  }

  if(sequence===4 && Object.hasOwn(form?.actions?.['step-1']?.outputs??{},'discoveryReconciliationRecords')){
    const policy=detectionPolicyForAuthorityV1({repoRoot:root,authorityRoot,
      readJsonIfExists:(rel)=>readJsonIf(repoFile(root,rel))});
    if(policy){
      const summary=readJsonIf(repoFile(root,path.posix.join(campaignPath,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json')));
      const items=summary?.payload?.reconciliationItems??null;
      const controllerFields=['recordKey','contextIds','sourceAnchor','origin','reviewerFinding','attackerFinding'];
      // Copy exact source identities; controller makes no security judgments.
      const unmappedSourceRef=item=>{
        if(item?.origin!=='ATTACK_UNMAPPED_FLOW')return null;
        const link=summary?.payload?.reconciliationEvidenceRefs?.[item.recordKey];
        if(link?.referenceCollection!=='unmappedAttackPathRefs')return null;
        const index=link.sourceRefIndexes?.[0];
        const ref=Number.isInteger(index)?summary?.payload?.unmappedAttackPathRefs?.[index]:null;
        return ref?{
          availability:link.availability??'SOURCE_UNAVAILABLE',
          phaseSequence:4,unitId:ref.unitId??null,
          originalWorkerAttempt:structuredClone(ref.originalWorkerAttempt??{availability:'NOT_RECORDED'}),
          sourceSelector:ref.sourceSelector??null,
          originalAnchorsSelector:ref.originalAnchorsSelector??null,
          originalCandidateSelector:ref.originalCandidateSelector??null,
          originalFlowIds:structuredClone(ref.originalFlowIds??null),
          originalPathId:ref.originalPathId??null,mappingStatus:ref.mappingStatus??null,
          acceptedPath:ref.acceptedPath??null,acceptedSha256:ref.acceptedSha256??null
        }:null;
      };
      const records=items===null?['<PENDING_DISCOVERY>']:items.length?items.map(item=>{
        const evidenceRef=unmappedSourceRef(item);
        const link=summary?.payload?.reconciliationEvidenceRefs?.[item.recordKey]??{};
        const sourceIndexes=Array.isArray(link.sourceRefIndexes)?link.sourceRefIndexes:[];
        const discoveryEvidenceRefs=link.referenceCollection==='discoverySourceRefs'
          ?sourceIndexes.map(index=>Number.isInteger(index)?
             summary?.payload?.discoverySourceRefs?.[index]:null).filter(Boolean)
             .map(ref=>structuredClone(ref)):[];
        const discoveryEvidenceLookup={
          summaryPath:form.automationInputs.discoveryEvidenceContinuity?.summaryPath??null,
          recordKey:item.recordKey,
          referenceCollection:link.referenceCollection??null,
          sourceRefIndexes:structuredClone(sourceIndexes),
          availability:link.availability??'SOURCE_UNAVAILABLE',
          controllerSourceSelector:link.controllerSourceSelector??null
        };
        return {
          ...Object.fromEntries(controllerFields.map(k=>[k,item[k]])),
          discoveryEvidenceLookup,discoveryEvidenceRefs,
          ...(item.origin==='ATTACK_UNMAPPED_FLOW'?{
            unmappedAttackEvidenceRef:evidenceRef??{availability:'SOURCE_UNAVAILABLE'},
            unmappedAttackReviewInstruction:
              'Read the complete original Worker ATTACK record at unmappedAttackEvidenceRef.originalWorkerAttempt.path '+
              'using unmappedAttackEvidenceRef.sourceSelector. Examine every step, anchor, optional candidate, and unknown '+
              'flow identity. Do not discard an observation merely because its flow ID is unissued.'
          }:{}),
          reconciliation:'<REQUIRED>',disposition:'<REQUIRED>',candidateTempKeyOrNone:'<REQUIRED>',rationale:'<REQUIRED>',
          automationOwnedFields:item.origin==='ATTACK_UNMAPPED_FLOW'?
            [...controllerFields,'discoveryEvidenceLookup','discoveryEvidenceRefs',
             'unmappedAttackEvidenceRef','unmappedAttackReviewInstruction']:
            [...controllerFields,'discoveryEvidenceLookup','discoveryEvidenceRefs']
        };
      }):['NONE_IDENTIFIED'];
      form.actions['step-1'].outputs.discoveryReconciliationRecords=records;
      form.automationInputs.expectedDiscoveryRecordKeys=items?.map(x=>x.recordKey)??[];
      form.automationInputs.unmappedAttackPathSources=
        structuredClone(summary?.payload?.unmappedAttackPathSources??[]);
      form.automationInputs.controllerOwnedAutomationInputs=uniq([
       ...form.automationInputs.controllerOwnedAutomationInputs,
       'expectedDiscoveryRecordKeys','unmappedAttackPathSources']);
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
    if(['Machine Intelligence Audit Controller/Audit Skill v7','Machine Intelligence Audit Controller/Audit Skill v8'].includes(authorityRoot)){
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
  if(coverage.functionReviewSummary&&coverage.classEvidenceSummary){
    const f=coverage.functionReviewSummary,c=coverage.classEvidenceSummary;
    return {
      coverageSummary:'Function reviews: '+f.verdictRecorded+' recorded verdicts; '+
        f.trivialSubstitutions+' qualified literal substitutions; '+f.notRecorded+
        ' not recorded of '+f.requiredContexts+' source contexts. '+
        'Explicit security-class assessments: '+c.supported+' SUPPORTED, '+
        c.concerns+' CONCERN, '+c.unresolved+' UNRESOLVED, '+
        c.notApplicable+' NOT_APPLICABLE, '+c.notEstablished+
        ' NOT_ESTABLISHED of '+c.requiredContextClassPairs+' triggered pairs. '+
        'Executed properties: NOT_REPORTED_BY_PHASE4_SOURCE_REVIEW. '+
        'Class-specific contradictions: '+contradicted+'; N/A claims: '+na+
        '; gaps: '+gaps+'; evidence coverage: '+(coverage.label??'PARTIAL_COVERAGE')+
        ' (not a security-assurance verdict).',
      functionReviewSummary:structuredClone(f),
      classEvidenceSummary:structuredClone(c),
      executedPropertyStatus:'NOT_REPORTED_BY_PHASE4_SOURCE_REVIEW',
      unreviewedRequiredSurfaces:gapIds.length?gapIds:['NONE_IDENTIFIED']
    };
  }
  return {coverageSummary:'HISTORICAL_CLASS_PROVENANCE_UNVERIFIED; Required contexts: '+
    contexts.size+'; accepted class statuses (may be synthesized): '+accepted+
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
 const provenanceRows=[
  ...(phase5?.automationOutputs?.acceptedUnitRecordOrigins?.records??[]),
  ...(phase6?.automationOutputs?.acceptedUnitRecordOrigins?.records??[])
 ];
 const sourceFor=selector=>{
  const originals=provenanceRows.filter(ref=>ref?.canonicalRecordSelector===selector);
  return {selector,
   ...(originals.length===1?{originalAcceptedRecordSource:structuredClone(originals[0])}:
    {sourceAvailability:originals.length>1?
      'MULTIPLE_ORIGINAL_SOURCES':'ORIGINAL_SOURCE_UNAVAILABLE'})};
 };
 const runRecords=Array.isArray(runs)?runs.map((row,index)=>({
  row,source:sourceFor('actions.step-2.outputs.targetDispositions['+index+']')
 })):[],proofRecords=Array.isArray(proofs)?proofs.map((row,index)=>({
  row,source:sourceFor('actions.step-5.outputs.candidateProofRecords['+index+']')
 })):[];
 const anchorCounts=new Map(),proofAnchorCounts=new Map();
 for(const x of prior)if(x&&typeof x==='object'&&x.sourceAnchor)
  anchorCounts.set(x.sourceAnchor,(anchorCounts.get(x.sourceAnchor)??0)+1);
 for(const {row} of proofRecords)if(row&&typeof row==='object'&&row.sourceAnchor)
  proofAnchorCounts.set(row.sourceAnchor,(proofAnchorCounts.get(row.sourceAnchor)??0)+1);
 return (Array.isArray(prior)?prior:[]).flatMap((x,index)=>{
  if(!x||typeof x!=='object'||Array.isArray(x)||!x.subjectKey)return [];
  const candidateKey=String(x.subjectKey);
  const matches=runRecords.filter(({row})=>row&&typeof row==='object'&&
   String(row.candidateKey??'')===candidateKey);
  const exactProofs=proofRecords.filter(({row})=>row&&typeof row==='object'&&
   String(row.candidateKey??'')===candidateKey);
  const anchored=exactProofs.length?[]:proofRecords.filter(({row})=>
   row&&typeof row==='object'&&x.sourceAnchor&&
   row.sourceAnchor===x.sourceAnchor&&
   anchorCounts.get(x.sourceAnchor)===1&&
   proofAnchorCounts.get(x.sourceAnchor)===1);
  const applicableProofs=exactProofs.length?exactProofs:anchored;
  // Never pick an arbitrary first/last proof among repeated accepted rows.
  // Preserve all records and make the concise presentation ambiguous.
  const execution=matches.length===1?matches[0].row:null;
  const proof=applicableProofs.length===1?applicableProofs[0].row:null;
  return [{
   candidateKey,sourceAnchor:x.sourceAnchor??'UNBOUND_SOURCE_ANCHOR',
   priorEvidenceInterpretation:x.priorConclusion??'NOT_RECORDED',
   priorEvidenceDisposition:x.disposition??'NOT_RECORDED',
   priorEvidenceBasis:'REVIEWER_INTERPRETATION_NOT_AUTOMATICALLY_REVALIDATED',
   currentPhaseExecutionStatus:execution?.reproductionStatus??
    (matches.length>1?'MULTIPLE_DISTINCT_EXECUTION_RECORDS':'NO_PHASE6_EXECUTION_STATUS'),
   currentPhaseOracleOutcome:execution?.oracleOutcome??
    (matches.length>1?'MULTIPLE_DISTINCT_ORACLE_RECORDS':'NO_PHASE6_ORACLE'),
   phase6ProofVerdict:proof?.verdict??
    (applicableProofs.length>1?'MULTIPLE_DISTINCT_PROOF_RECORDS':'NOT_LINKED_OR_UNRESOLVED'),
   phase6ProofCandidateKey:proof?.candidateKey??null,
   phase6ExecutionRounds:proof?.dispatchRounds??null,
   residualLimitation:execution?.limitations??
    x.downstreamValidationNeed??'SEE_ACCEPTED_SOURCE_EVIDENCE',
   originalPriorRecordSource:sourceFor(
    'actions.step-2.outputs.reconciliationRecords['+index+']'),
   exactPhase6ExecutionRecords:matches.map(({row,source})=>({
    ...source,originalSubmittedRecord:structuredClone(row)})),
   exactPhase6ProofRecords:applicableProofs.map(({row,source})=>({
    ...source,originalSubmittedRecord:structuredClone(row)})),
   evidenceLinkBasis:exactProofs.length?'EXACT_CANDIDATE_KEY':
    anchored.length?'UNIQUE_RECORDED_SOURCE_ANCHOR':'NO_EXACT_LINK',
   originalSubjectReferences:{
    phase5SubjectKey:x.subjectKey,
    phase6CandidateKey:proof?.candidateKey??null}
  }];
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
  const discoveryRef=form?.automationInputs?.discoveryEvidenceContinuity??null;
  const discoveryDims=discoveryRef?.evidenceDimensions??{};
  // Phase 10 reports three independent evidence categories without editing
  // the accepted AI findings or inferring a class or machine verdict.
  const evidenceSection=Number(phase)===10?'\n## Evidence Categories and Original Source\n\n'+
    '- Function review: '+(discoveryDims.functionReview?compact(discoveryDims.functionReview):
      'SOURCE_UNAVAILABLE_OR_HISTORICAL_PROVENANCE_UNVERIFIED')+'\n'+
    '- Explicit security-class assessments: '+(discoveryDims.classAssessment?
      compact(discoveryDims.classAssessment):'NOT_INDEPENDENTLY_ESTABLISHED_BY_THIS_REPORT')+'\n'+
    '- Executed properties: consult the separate context/class coverage matrix and '+
      'actual qualified machine assertions; bounded PASS never establishes universal safety.\n'+
    '- Original accepted discovery summary: '+String(discoveryRef?.summaryPath??'SOURCE_UNAVAILABLE')+
      '; SHA-256: '+String(discoveryRef?.summarySha256??'NOT_AVAILABLE')+'\n'+
    '- Overall CORRECT/DEFECT/UNRESOLVED verdicts are not class-specific assertions; '+
      'coverage labels are evidence bookkeeping, not security assurance.\n':'';
  return `# Phase ${phase} Final Report

> **CONTROLLER-GENERATED:** Deterministically rendered from the accepted schema-governed work form and controller-owned outputs. No hashes, handoff bookkeeping, or predecessor restatement is authored by the reviewer.

## Executive Conclusion

${text(executive)}

## Material Results

${material}
${continuitySection}
${evidenceSection}
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
