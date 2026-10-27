#!/usr/bin/env node
import {writeAllSyncV1} from './lib/lite-sync-stdout-v1.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readV7RawResultV1} from '../packages/github-native-sim/src/v7-compact-result-v1.mjs';
import {pathToFileURL} from 'node:url';
import {storeControllerResultV1} from './lib/lite-boundary-result-v1.mjs';
import {materializeSemanticWorkFormV13,secureShardWorkFormV13,semanticShardFailureIndexV13} from './lib/lite-solo-work-shards-v1.mjs';
import {
  readJson,writeJson,writeText,repoFile,requiredFile,authorityRootFromReceipt,validateBoundAuthorityV1,loadPhaseSchema,
  validateWorkForm,validateFinalReport,ensurePacketShape,buildDerivedOutputs,preparePhaseWork,getByPath
} from './lib/lite-solo-phase-work-v1.mjs';
import {
  executePhase5TargetsV1,selectReusablePhase5TargetsV1,validatePhase5TargetCoverageV1,validatePhase5TargetExecutionGateV1,validateRecordedPhase5MachineEvidenceV1,renderTargetedTestMatrixV1,renderRemediationDeltaLedgerV1,renderFinalEvidenceIndexV1,
  validateTargetExecutionRequestBindingV1,inspectPhase5OwnerEvidenceDeferralV1
} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {
  buildControllerPacket,renderControllerPhaseReport,buildCandidateEvidenceContinuityV1,validatePhaseScaffold,
  phase4CoverageFromForm,phase4DiscoveryCoverageV1,materializeValidatedFindings,resolveTargetExecutionRequestRef,
  populatePhase9RerunEvidenceRefs,refreshControllerPrefillDigest,
  normalizeFormalObligationsIntoLedger,applyObligationDispositionsToLedger
} from './lib/lite-solo-phase-prefill-v1.mjs';
import {MASTER_REVIEW_SEGMENTS_V1,boundReviewerForPhaseV1,segmentsForAuthorityV1,isV13AuthorityV1,masterReviewRequired,stageMasterReview,processMasterReviewSubmission,masterWakeMessage,admitSealedPhaseRework,collectSegmentArtifacts,SUPERSEDED_DIRECTORY_V1} from './lib/lite-master-review-v1.mjs';
import {unresolvedFinalCandidateFailures} from './lib/lite-solo-final-candidates-v1.mjs';
import {admitPostCompletionFollowupV1} from './lib/lite-post-completion-followup-v1.mjs';
import {detectionPolicyForAuthorityV1} from '../packages/github-native-sim/src/adr-policy-v1.mjs';
import {resolveFrozenAuthorityFileV1,authorityLinkPathV1} from '../packages/github-native-sim/src/adr-frozen-authority-v1.mjs';
import {isReassignedV13AuthorityV1} from './lib/lite-authority-lineup-v1.mjs';
import {startDiscoveryV1,advanceDiscoveryV1,completeDiscoveryV1} from '../packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs';
import {createUnitPlanV1} from './lib/lite-solo-unit-queue-v1.mjs';
import {validatePhase6AttackerWorkV1,validatePhase8LinkageV1,validatePhase10CoverageLabelV1,appendAdrCoverageSectionV1} from '../packages/github-native-sim/src/adr-phase-validation-v1.mjs';

function parse(argv){const o={};for(let i=2;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined) throw new Error('args must be --key value');o[argv[i].slice(2)]=argv[i+1];}return o;}
function shaFile(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function phaseNum(n){return String(n).padStart(2,'0');}
function feedbackText(sequence,defs){return ['Phase '+sequence+' semantic validation failed.','Repair only the exact substantive items below and invoke controller validation again.','',...defs.map(x=>'- '+x),'','Do not advance, retire, update receipts, or perform controller bookkeeping.'].join('\n');}
function listFilesRecursive(dir){if(!fs.existsSync(dir)) return [];const out=[];for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,ent.name);if(ent.isDirectory()) out.push(...listFilesRecursive(p));else if(ent.isFile()) out.push(p);}return out;}
function hasRemediation(campaignRoot){return listFilesRecursive(path.join(campaignRoot,'remediation')).length>0;}
function canonicalFamilyForField(name){return ({propertyDesigns:'PROP',attackHypotheses:'HYP',candidateRecords:'CAND',newCandidateRecords:'CAND',validatedFindings:'FIND',remediationDispositions:'REM'})[name]??null;}
function nextId(graph,family){let max=0;for(const n of graph.nodes??[]){const m=String(n.nodeId??'').match(new RegExp('^'+family+'-(\\d+)$'));if(m) max=Math.max(max,Number(m[1]));}return family+'-'+String(max+1).padStart(3,'0');}
function assignCanonicalIds(canonical,graph,phase){
  graph.nodes??=[];
  for(const [stepKey,row] of Object.entries(canonical.actions??{})){
    for(const [fieldName,value] of Object.entries(row.outputs??{})){
      const family=canonicalFamilyForField(fieldName);
      if(!family||!Array.isArray(value)) continue;
      for(let i=0;i<value.length;i++){
        const item=value[i];if(!item||typeof item!=='object'||Array.isArray(item)) continue;
        const sourceRecordPath='actions.'+stepKey+'.outputs.'+fieldName+'['+i+']';
        const prior=(graph.nodes??[]).find(n=>n.originPhase===phase&&n.sourceRecordPath===sourceRecordPath&&n.nodeType===family);
        if(!item.canonicalId&&prior)item.canonicalId=prior.nodeId;
        if(!item.canonicalId) item.canonicalId=nextId(graph,family);
        if(!(graph.nodes??[]).some(n=>n.nodeId===item.canonicalId)) graph.nodes.push({nodeId:item.canonicalId,nodeType:family,originPhase:phase,sourceRecordPath});
      }
    }
  }
}
function importedRecords(canonical,paths){return (paths??[]).map(p=>({path:p,value:getByPath(canonical,p)}));}
function receiptObligationSummary({ledger,canonical,form,sequence,now}){
  const all=ledger?.obligations??[];
  const byId=new Map(all.map(o=>[String(o?.obligationId??''),o]).filter(([id])=>id));
  const dueIds=form?.automationInputs?.expectedDueObligationIds??[];
  const rows=[];
  for(const action of Object.values(canonical?.actions??{})){
    const value=action?.outputs?.obligationDispositions;
    if(Array.isArray(value)) rows.push(...value.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)));
  }
  const created=all.filter(o=>String(o.originPhase??'')===String(sequence)&&o.createdAt===now);
  const closed=rows.filter(r=>['SATISFIED','NOT_APPLICABLE'].includes(String(r.disposition??''))).map(r=>byId.get(String(r.obligationId))??r);
  const carriedForward=rows.filter(r=>['CARRY_FORWARD','BLOCKED_CARRIED'].includes(String(r.disposition??''))).map(r=>byId.get(String(r.obligationId))??r);
  const due=dueIds.map(id=>byId.get(String(id))??{obligationId:id,status:'UNRESOLVED_LEDGER_REFERENCE'});
  return {due,created,closed,carriedForward};
}
function syncControls({root,campaignPath,schema,canonical,canonicalRel,now,authorityRoot,replacePhase=false}){
  const controlDir=path.posix.join(campaignPath,'controller');
  const graphRel=path.posix.join(controlDir,'SECURITY_TRACEABILITY_GRAPH_v1.json');
  const ledgerRel=path.posix.join(controlDir,'CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json');
  const invalidRel=path.posix.join(controlDir,'EVIDENCE_INVALIDATION_MATRIX_v1.json');
  const graph=readJson(requiredFile(root,graphRel,'traceability graph'));
  const ledger=readJson(requiredFile(root,ledgerRel,'obligation ledger'));
  const invalid=readJson(requiredFile(root,invalidRel,'invalidation matrix'));
  assignCanonicalIds(canonical,graph,schema.phase);
  graph.controllerImports??=[]; ledger.controllerImports??=[]; invalid.controllerImports??=[];
  if(replacePhase){
    graph.controllerImports=graph.controllerImports.filter(x=>x?.phase!==schema.phase);
    ledger.controllerImports=ledger.controllerImports.filter(x=>x?.phase!==schema.phase);
    invalid.controllerImports=invalid.controllerImports.filter(x=>x?.phase!==schema.phase);
    ledger.obligations=(ledger.obligations??[]).filter(x=>Number(x?.originPhase)!==Number(schema.phase));
    ledger.phaseCheckpoints=(ledger.phaseCheckpoints??[]).filter(x=>x?.phaseId!=='phase-'+schema.phase);
  }
  const graphRecords=importedRecords(canonical,schema.bookkeepingMappings?.graphRecordPaths);
  const obligationRecords=importedRecords(canonical,schema.bookkeepingMappings?.obligationRecordPaths);
  const invalidationRecords=importedRecords(canonical,schema.bookkeepingMappings?.invalidationRecordPaths);
  graph.controllerImports.push({phase:schema.phase,canonicalDataPath:canonicalRel,records:graphRecords,importedAt:now});
  ledger.controllerImports.push({phase:schema.phase,canonicalDataPath:canonicalRel,records:obligationRecords,importedAt:now});
  invalid.controllerImports.push({phase:schema.phase,canonicalDataPath:canonicalRel,records:invalidationRecords,importedAt:now});

  for(const record of obligationRecords){
    normalizeFormalObligationsIntoLedger({ledger,items:record.value,originPhase:schema.phase,canonicalRel,now,root,authorityRoot});
  }

  const identityComparison=canonical?.automationInputs?.identityComparison;
  if(identityComparison){
    invalid.controllerImports.push({phase:schema.phase,canonicalDataPath:canonicalRel,records:[{path:'automationInputs.identityComparison',value:identityComparison}],importedAt:now,owner:'CONTROLLER_AUTOMATION'});
  }

  const domainRegistryPath=canonical?.automationInputs?.domainRegistryPath;
  if(domainRegistryPath){
    const domainRel=path.posix.join(campaignPath,domainRegistryPath);
    const registry=maybeJson(root,domainRel);
    if(registry){
      graph.controllerImports.push({phase:schema.phase,canonicalDataPath:canonicalRel,records:[{path:'controllerDomainRegistry',value:{path:domainRegistryPath,decisions:registry.decisions??[]}}],importedAt:now,owner:'CONTROLLER_AUTOMATION'});
      ledger.controllerImports.push({phase:schema.phase,canonicalDataPath:canonicalRel,records:[{path:'controllerDomainRegistry.generatedObligations',value:registry.generatedObligations??[]}],importedAt:now,owner:'CONTROLLER_AUTOMATION'});
      normalizeFormalObligationsIntoLedger({ledger,items:registry.generatedObligations??[],originPhase:schema.phase,canonicalRel,now,root,authorityRoot});
    }
  }

  applyObligationDispositionsToLedger({ledger,canonical,sequence:schema.phase,canonicalRel,now,root,authorityRoot});
  writeJson(repoFile(root,graphRel),graph);writeJson(repoFile(root,ledgerRel),ledger);writeJson(repoFile(root,invalidRel),invalid);
  return {graphRel,ledgerRel,invalidRel};
}
function receiptRef(root,campaignPath,rel,role){return {role,path:path.posix.relative(campaignPath,rel),sha256:shaFile(repoFile(root,rel))};}
function assignmentReviewer(sequence,authorityRoot=null,root=null){
 if(![ 'Audit Skill - Lite-Solo Authority/lite-solo', 'Audit Skill - Lite-Solo Authority/lite-solo-v2', 'Audit Skill - Lite-Solo Authority/lite-solo-v3', 'Audit Skill - Lite-Solo Authority/lite-solo-v4', 'Audit Skill - Lite-Solo Authority/lite-solo-v5', 'Audit Skill - Lite-Solo Authority/lite-solo-v6' ].includes(authorityRoot))throw new Error('lite-solo assignment authority mismatch');
 return 'lite-solo-agent';
}
function isFreshBoundary(next,authorityRoot=null,controllerRoot=null){
 if([ 'Audit Skill - Lite-Solo Authority/lite-solo', 'Audit Skill - Lite-Solo Authority/lite-solo-v2', 'Audit Skill - Lite-Solo Authority/lite-solo-v3', 'Audit Skill - Lite-Solo Authority/lite-solo-v4', 'Audit Skill - Lite-Solo Authority/lite-solo-v5', 'Audit Skill - Lite-Solo Authority/lite-solo-v6' ].includes(authorityRoot))return false;
 if(controllerRoot&&isReassignedV13AuthorityV1({root:controllerRoot,authorityRoot}))return [4,5,8].includes(next);
 return isV13AuthorityV1(authorityRoot)?[2,5,8].includes(next):[2,6,8].includes(next);
}
function maybeFile(root,rel){const f=repoFile(root,rel);return fs.existsSync(f)&&fs.statSync(f).isFile()?f:null;}
function maybeJson(root,rel){const f=maybeFile(root,rel);if(!f)return null;try{return readJson(f);}catch{return null;}}
function canonicalRelFor(campaignPath,phase){return path.posix.join(campaignPath,'derived/phase-'+phase,'PHASE_'+phaseNum(phase)+'_CANONICAL_DATA_v1.json');}
function canonicalFor(root,campaignPath,phase){return maybeJson(root,canonicalRelFor(campaignPath,phase));}
function uniqueExisting(root,rels){return [...new Set(rels.filter(Boolean))].filter(rel=>Boolean(maybeFile(root,rel)));}
function resolveInputsForTarget({root,campaignPath,target,immediate=[]}){
  const derived=(phase,name)=>path.posix.join(campaignPath,`derived/phase-${phase}/${name}`);
  const buildIdentity=path.posix.join(campaignPath,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json');
  const deploy=path.posix.join(campaignPath,'work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md');
  const targets=path.posix.join(campaignPath,'work/phase-06/LITE_TARGETED_TEST_MATRIX.md');
  const remediation=path.posix.join(campaignPath,'work/phase-09/PHASE9_REMEDIATION_DELTA_LEDGER.md');
  const finalIndex=path.posix.join(campaignPath,'work/phase-10/LITE_FINAL_EVIDENCE_INDEX.md');
  const p2=derived(2,'PHASE3_INPUT_v1.json');
  const p3=derived(3,'PHASE4_INPUT_v1.json');
  const p4=derived(4,'PHASE5_INPUT_v1.json');
  const p5=derived(5,'PHASE6_INPUT_v1.json');
  const p6=derived(6,'PHASE8_INPUT_v1.json');
  const p7=derived(7,'PHASE8_MARKER_INPUT_v1.json');
  const p8Remediation=derived(8,'PHASE9_REMEDIATION_INPUT_v1.json');
  const p8Final=derived(8,'PHASE10_INPUT_v1.json');
  const p9Final=derived(9,'PHASE10_REMEDIATION_INPUT_v1.json');
  if(target===4) return uniqueExisting(root,[p2,p3]);
  if(target===5) return uniqueExisting(root,[p2,p3,p4]);
  if(target===6) return uniqueExisting(root,[p2,p3,p4,p5,buildIdentity,deploy,targets]);
  if(target===8) return uniqueExisting(root,[p2,p3,p4,p5,p6,p7,buildIdentity,deploy,targets]);
  if(target===9) return uniqueExisting(root,[p8Remediation,remediation]);
  if(target===10) return uniqueExisting(root,[p8Final,p9Final,finalIndex]);
  return uniqueExisting(root,immediate);
}
function phaseOutput(canonical,step,field){return canonical?.actions?.[step]?.outputs?.[field];}
function remediationDeltaRows(campaignRoot,validatedFindings){
  const remediationRoot=path.join(campaignRoot,'remediation');
  const files=listFilesRecursive(remediationRoot);
  const changed=new Set(); const symbols=new Set(); const evidence=[];
  for(const file of files){
    const rel=path.relative(campaignRoot,file).split(path.sep).join('/'); evidence.push(rel);
    const ext=path.extname(file).toLowerCase();
    if(['.patch','.diff'].includes(ext)){
      const text=fs.readFileSync(file,'utf8');
      for(const line of text.split(/\r?\n/)){
        const m=line.match(/^\+\+\+\s+(?:b\/)?(.+)$/); if(m&&m[1]!=='/dev/null') changed.add(m[1]);
        if(/^[+-](?![+-])/.test(line)){
          const s=line.match(/\b(?:function|contract|library|interface|struct|modifier|event|error)\s+([A-Za-z_][A-Za-z0-9_]*)/);
          if(s) symbols.add(s[1]);
        }
      }
    }else changed.add(rel.replace(/^remediation\//,''));
  }
  const deltaText='files='+([...changed].join(', ')||'UNRESOLVED')+'; symbols='+([...symbols].join(', ')||'NOT_MACHINE_DERIVABLE_FROM_AVAILABLE_REMEDIATION_ARTIFACTS');
  const findingRows=(validatedFindings??[]).filter(f=>f&&typeof f==='object'&&!Array.isArray(f));
  return (findingRows.length?findingRows:[{findingTempKey:'REMEDIATION-DELTA'}]).map(f=>({
    findingId:f.findingTempKey??f.canonicalId??f.candidateKey??'REMEDIATION-DELTA',
    oldIdentityRef:'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json',
    remediationIdentityRef:evidence.join(', ')||'NO_REMEDIATION_ARTIFACT',
    changedFilesAndSymbols:deltaText,
    rootCauseFix:'PENDING_PHASE9_INTERPRETATION',
    staleEvidenceInvalidated:'SEE_CONTROLLER_EVIDENCE_INVALIDATION_STATE',
    decisiveProofRerun:'PENDING_PHASE9',
    affectedSurfaces:[...changed].join(', ')||'UNRESOLVED',
    newEvidenceRefs:evidence.join(', ')||'NONE',
    residualRisk:'PENDING_PHASE9_INTERPRETATION',
    finalDisposition:'PENDING_PHASE9_INTERPRETATION'
  }));
}
function finalizeRemediationDeltaRows(deltaRows,canonical9){
  const surfaceRows=phaseOutput(canonical9,'step-1','changedSurfaceAssessments')??[];
  const dispositions=phaseOutput(canonical9,'step-2','remediationDispositions')??[];
  const byFinding=(rows)=>new Map(rows.map(r=>[String(r.findingKey??r.findingId??''),r]).filter(([k])=>k));
  const surfaces=byFinding(surfaceRows), remediations=byFinding(dispositions);
  return deltaRows.map(row=>{
    const key=String(row.findingId??'');
    const surface=surfaces.get(key)??{};
    const remediation=remediations.get(key)??{};
    const reruns=Array.isArray(remediation.rerunEvidenceRefs)?remediation.rerunEvidenceRefs.join(', '):(remediation.rerunEvidenceRefs??row.decisiveProofRerun);
    return {
      ...row,
      rootCauseFix:remediation.rootCauseFixed===undefined
        ? row.rootCauseFix
        : String(remediation.rootCauseFixed)+' — '+String(remediation.rationale??'NO_ADDITIONAL_RATIONALE'),
      decisiveProofRerun:reruns??row.decisiveProofRerun,
      affectedSurfaces:[
        surface.changedSurface,
        surface.affectedCallersOrState
      ].filter(Boolean).join(' / ')||row.affectedSurfaces,
      newEvidenceRefs:reruns??row.newEvidenceRefs,
      residualRisk:[
        surface.newRiskOrNone,
        remediation.regressionAssessment
      ].filter(Boolean).join(' / ')||row.residualRisk,
      finalDisposition:remediation.disposition??row.finalDisposition
    };
  });
}
function explicitNegativeValue(v){
  return ['NONE_IDENTIFIED','NOT_APPLICABLE','NOT_TRIGGERED','NO_CANDIDATE','NO_REMEDIATION','NO_ADDITIONAL_OBLIGATION','NO_CONTRADICTION'].includes(String(v??''));
}
function collectCarriedLimitations({root,campaignPath,maxPhase=9}){
  const rows=[];
  for(let phase=1;phase<=maxPhase;phase++){
    if(phase===7) continue;
    const canonical=canonicalFor(root,campaignPath,phase);
    if(!canonical) continue;
    for(const [stepKey,action] of Object.entries(canonical.actions??{})){
      for(const [fieldName,value] of Object.entries(action?.outputs??{})){
        if(!/(limitation|ambigu|unresolved|uncert)/i.test(fieldName)) continue;
        const values=Array.isArray(value)?value:[value];
        for(const item of values){
          if(item===undefined||item===null||explicitNegativeValue(item)) continue;
          rows.push(`Phase ${phase} ${stepKey}.${fieldName}: ${typeof item==='string'?item:JSON.stringify(item)}`);
        }
      }
    }
    for(const [fieldName,value] of Object.entries(canonical.automationOutputs??{})){
      if(!/(limitation|ambigu|unresolved|uncert)/i.test(fieldName)) continue;
      const values=Array.isArray(value)?value:[value];
      for(const item of values){
        if(item===undefined||item===null||explicitNegativeValue(item)) continue;
        rows.push(`Phase ${phase} automationOutputs.${fieldName}: ${typeof item==='string'?item:JSON.stringify(item)}`);
      }
    }
  }
  return [...new Set(rows)];
}
function importedFormalObligations(ledger){
  const out=[];let fallback=1;
  for(const entry of ledger?.controllerImports??[]){
    for(const record of entry?.records??[]){
      const values=Array.isArray(record?.value)?record.value:[record?.value];
      for(const item of values){
        if(!item||typeof item!=='object'||Array.isArray(item)) continue;
        if(item.requiredPhase===undefined||!item.requiredAction||!item.completionCondition) continue;
        const rawId=item.obligationId??item.canonicalId??item.tempKey??`AUTO-${String(fallback++).padStart(3,'0')}`;
        const importedId=String(rawId).startsWith('OBL-')
          ? String(rawId)
          : 'OBL-P'+String(entry.phase??'X')+'-'+String(rawId).replace(/[^A-Za-z0-9._-]+/g,'_');
        out.push({
          obligationId:importedId,
          status:item.status??'OPEN_IMPORTED',
          originatingEvidenceRefs:item.originatingEvidenceRefs??[entry.canonicalDataPath].filter(Boolean),
          statusReason:item.statusReason??`${record.path} imported after Phase ${entry.phase}`,
          requiredPhase:String(item.requiredPhase),
          requiredAction:item.requiredAction,
          completionCondition:item.completionCondition
        });
      }
    }
  }
  return out;
}
function finalIndexObligations(ledger){
  const normalized=(ledger?.obligations??[]).filter(o=>!['CLOSED','SATISFIED','NOT_APPLICABLE','SUPERSEDED'].includes(String(o.status??'OPEN').toUpperCase()));
  const imported=importedFormalObligations(ledger);
  const byId=new Map();
  for(const o of [...normalized,...imported]){
    const id=String(o.obligationId??'').trim(); if(!id) continue;
    if(!byId.has(id)||String(byId.get(id)?.status??'').startsWith('OPEN_IMPORTED')) byId.set(id,o);
  }
  return [...byId.values()];
}

function buildFinalIndexInput({root,campaignPath,directory,predecessor}){
  const p6=canonicalFor(root,campaignPath,6); const p8=canonicalFor(root,campaignPath,8); const p9=canonicalFor(root,campaignPath,9);
  const build=maybeJson(root,path.posix.join(campaignPath,'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'))??{};
  const ledger=maybeJson(root,path.posix.join(campaignPath,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json'))??{};
  const remediations=phaseOutput(p9,'step-2','remediationDispositions')??[];
  const candidateRows=(phaseOutput(p8,'step-2','candidateValidations')??[]).filter(v=>v&&typeof v==='object'&&!Array.isArray(v)).map(v=>({
    id:v.candidateKey,
    disposition:v.finalDisposition??v.outcome??'UNRESOLVED',
    severityOrStatus:v.severity??'UNRESOLVED',
    evidence:Array.isArray(v.evidenceRefs)?v.evidenceRefs.join(', '):v.evidenceRefs,
    remediationStatus:'NOT_APPLICABLE',
    residualLimitation:v.rationale??'SEE_ACCEPTED_PHASE8_DATA'
  }));
  const findingRows=(phaseOutput(p8,'step-2','validatedFindings')??[]).filter(f=>f&&typeof f==='object'&&!Array.isArray(f)).map(f=>{
    const id=f.canonicalId??f.findingTempKey??f.candidateKey;
    const remediation=remediations.find(r=>r.findingKey===id||r.findingKey===f.findingTempKey||r.findingKey===f.candidateKey);
    return {
      id,
      disposition:'VALIDATED_FINDING',
      severityOrStatus:f.severity??'UNRESOLVED',
      evidence:Array.isArray(f.proofEvidenceRefs)?f.proofEvidenceRefs.join(', '):f.proofEvidenceRefs,
      remediationStatus:remediation?.disposition??(p9?'UNRESOLVED':'SKIPPED_NO_REMEDIATION'),
      residualLimitation:remediation?.regressionAssessment??'SEE_ACCEPTED_PHASE_DATA'
    };
  });
  const findings=[...candidateRows,...findingRows];
  const obligations=finalIndexObligations(ledger).map(o=>({
    id:o.obligationId,
    disposition:o.status??'OPEN',
    severityOrStatus:'OBLIGATION',
    evidence:(o.originatingEvidenceRefs??[]).join(', '),
    remediationStatus:'NOT_APPLICABLE',
    residualLimitation:[o.statusReason,o.requiredPhase?('requiredPhase='+o.requiredPhase):null,o.requiredAction].filter(Boolean).join(' | ')||'OPEN'
  }));
  const limitations=collectCarriedLimitations({root,campaignPath,maxPhase:9});
  const omissions=phaseOutput(p6,'step-3','fullOnlyOmissions')??phaseOutput(p6,'step-4','fullOnlyOmissions')??[];
  return {
    identity:{
      campaignGeneration:directory.campaignId+'/'+directory.campaignGenerationId,
      skill:predecessor.authority?.homepagePath??'UNRESOLVED_AUTHORITY',
      source:[predecessor.source?.repository,predecessor.source?.commit,directory.sourceSha256].filter(Boolean).join('@'),
      build:JSON.stringify({compiler:build.configurationDetection?.compilerVersion??build.build?.compilerVersion??null,compilerOutputSha256:build.build?.compilerOutputSha256??null}),
      deployment:'work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md',
      remediation:p9?'work/phase-09/PHASE9_REMEDIATION_DELTA_LEDGER.md':'SKIPPED_NO_REMEDIATION'
    },
    milestones:[
      {milestone:'Phase 0–1',requiredEvidence:'admission, source fence, risk grade, Source Intelligence',reference:'receipts/PHASE_00_RECEIPT_v1.json + accepted Phase-1 canonical data',sourceIdentity:directory.sourceSha256,status:'COMPLETE',limitation:'SEE_REFERENCED_EVIDENCE'},
      {milestone:'Combined Phase 2–5',requiredEvidence:'specification, threats/domains, manual review, economic/math, reconciliation',reference:'derived/phase-2..5 canonical data',sourceIdentity:directory.sourceSha256,status:'COMPLETE',limitation:'SEE_ACCEPTED_PHASE_DATA'},
      {milestone:'Merged Lite Phase 6–7',requiredEvidence:'deploy/config, deterministic candidate simulation, targeted fuzz, interpretation',reference:'work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md + work/phase-06/LITE_TARGETED_TEST_MATRIX.md + accepted Phase-6 canonical data',sourceIdentity:directory.sourceSha256,status:'COMPLETE',limitation:(phaseOutput(p6,'step-3','typedExecutionLimitations')??phaseOutput(p6,'step-4','typedExecutionLimitations')??[]).join('; ')||'NONE_IDENTIFIED'},
      {milestone:'Combined Phase 8–10',requiredEvidence:'validation, remediation/skip, final reconciliation',reference:p9?'accepted Phase-8 and Phase-9 canonical data':'accepted Phase-8 canonical data + Phase-9 skip receipt',sourceIdentity:directory.sourceSha256,status:'READY_FOR_PHASE10',limitation:'SEE_FINDINGS_AND_OBLIGATIONS'}
    ],
    findings,obligations,limitations,omissions
  };
}


function latestPhaseReceiptInfo(root,campaignPath,sequence){
  const dir=repoFile(root,path.posix.join(campaignPath,'receipts'));
  const rx=new RegExp('^PHASE_'+phaseNum(sequence)+'_RECEIPT_v([0-9]+)\\.json$');
  const rows=fs.readdirSync(dir).map(name=>({name,match:name.match(rx)})).filter(x=>x.match)
    .map(x=>({revision:Number(x.match[1]),rel:path.posix.join(campaignPath,'receipts',x.name)}))
    .sort((a,b)=>b.revision-a.revision);
  if(!rows.length)throw new Error('master repair refresh cannot find sealed Phase '+sequence+' receipt');
  return rows[0];
}
function revisionedArtifactPath(rel,revision){
  if(!rel)return null;
  if(/_v[0-9]+(?=\.[^.]+$)/.test(rel))return rel.replace(/_v[0-9]+(?=\.[^.]+$)/,'_v'+revision);
  return rel.replace(/(?=\.[^.]+$)/,'_v'+revision);
}
function reviewerForPhase(sequence,root,authorityRoot){
 return boundReviewerForPhaseV1({root,authorityRoot,phase:sequence});
}
function overlayReviewerOutputs(schema,fresh,saved){
  for(const [stepKey,action] of Object.entries(schema.actions??{})){
    for(const field of action.fields??[]){
      if(saved?.actions?.[stepKey]?.outputs&&Object.hasOwn(saved.actions[stepKey].outputs,field.name)){
        fresh.actions??={};fresh.actions[stepKey]??={};fresh.actions[stepKey].outputs??={};
        fresh.actions[stepKey].outputs[field.name]=structuredClone(saved.actions[stepKey].outputs[field.name]);
      }
    }
  }
  return fresh;
}
// Reuse sealed historical due IDs only if the deterministically regenerated
// precursor obligations agree. Upstream changes may alter obligations, but may
// never silently erase, invent or retain stale controller-prefilled requirements.
function retainSealedDueObligationPrefill(form,sealed,phase,trusted,schema,allowRequirementsUpdate=false){
  const sealedIds=sealed?.automationInputs?.expectedDueObligationIds;
  if(sealedIds===undefined)return form;
  const freshIds=trusted?.automationInputs?.expectedDueObligationIds;
  if(!Array.isArray(sealedIds)||!Array.isArray(freshIds))
    throw new Error('MASTER_DEPENDENCY_REWORK_REQUIRED: malformed Phase '+phase+' historical obligation prefills');
  const sorted=(ids)=>[...ids].map(String).sort();
  if(JSON.stringify(sorted(sealedIds))!==JSON.stringify(sorted(freshIds)))
    throw new Error('MASTER_DEPENDENCY_REWORK_REQUIRED: Phase '+phase+' due obligations changed after upstream amendment. Sealed: '+sorted(sealedIds).join(', ')+'; regenerated: '+sorted(freshIds).join(', ')+'. Regenerate trusted dependent prefills before accepting any disposition.');
  const actual=[];
  for(const action of Object.values(form?.actions??{})){
    for(const row of action?.outputs?.obligationDispositions??[]){
      if(row&&typeof row==='object'&&!Array.isArray(row)&&row.obligationId)actual.push(String(row.obligationId));
    }
  }
  if(JSON.stringify(sorted(sealedIds))!==JSON.stringify(sorted(actual)))
    throw new Error('MASTER_DEPENDENCY_REWORK_REQUIRED: Phase '+phase+' reviewer dispositions do not match the bound due-obligation set');
  if(new Set(sealedIds).size!==sealedIds.length)
    throw new Error('MASTER_DEPENDENCY_REWORK_REQUIRED: duplicate Phase '+phase+' due obligations');
  for(const [stepKey,action] of Object.entries(schema.actions??{})){
    const field=(action.fields??[]).find(x=>x.name==='obligationDispositions');
    if(!field)continue;
    const trustedRows=trusted?.actions?.[stepKey]?.outputs?.obligationDispositions??[];
    const bound=new Map(trustedRows.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)).map(x=>[String(x.obligationId),x]));
    for(const row of form?.actions?.[stepKey]?.outputs?.obligationDispositions??[]){
      if(!row||typeof row!=='object'||Array.isArray(row))continue;
      const expected=bound.get(String(row.obligationId??''));
      if(!expected)throw new Error('MASTER_DEPENDENCY_REWORK_REQUIRED: unbound Phase '+phase+' obligation '+String(row.obligationId));
      for(const key of field.controllerPrefillFields??[]){
        if(JSON.stringify(row[key])===JSON.stringify(expected[key]))continue;
        if(!allowRequirementsUpdate)
          throw new Error('MASTER_DEPENDENCY_REWORK_REQUIRED: Phase '+phase+' obligation '+row.obligationId+' changed its controller-owned '+key+'; master must correct dependent reviewer dispositions before refresh.');
        row[key]=structuredClone(expected[key]);
      }
    }
  }
  form.automationInputs.expectedDueObligationIds=structuredClone(freshIds);
  return form;
}
function copyAuthorityForShadow(root,shadowRoot,authorityRoot){
  const logical=repoFile(root,authorityRoot);
  if(fs.existsSync(logical)){
    fs.mkdirSync(path.dirname(repoFile(shadowRoot,authorityRoot)),{recursive:true});
    fs.cpSync(logical,repoFile(shadowRoot,authorityRoot),{recursive:true});
    return;
  }
  const frozen=resolveFrozenAuthorityFileV1(root,authorityRoot);
  if(!frozen||!fs.existsSync(frozen)||!fs.statSync(frozen).isDirectory())throw new Error('master repair refresh cannot materialize bound authority '+authorityRoot);
  const dest=repoFile(shadowRoot,authorityRoot);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.cpSync(frozen,dest,{recursive:true});
}
function isSupersedableRow(row){
  if(['SEALED_RECEIPT','SKIP_MARKER'].includes(row.kind)||row.kind.startsWith('GLOBAL_CONTROL_'))return false;
  return !/^(receipts|controller|superseded)\//.test(row.path);
}
// Reconstruct the ledger at the *historical* boundary, not from final-state
// obligations that later reviewers have already satisfied or carried. Existing
// sealed canonical outputs are the authority for all predecessor transitions.
// No new checkpoint/sidecar file is introduced.
function restoreLedgerBeforeMasterPhase({root,campaignPath,authorityRoot,earliest,now}){
  const rel=path.posix.join(campaignPath,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json');
  const old=readJson(requiredFile(root,rel,'current obligation ledger'));
  const firstSeen=new Map();
  for(let phase=1;phase<=10;phase++){
    const canonical=canonicalFor(root,campaignPath,phase);
    if(!canonical)continue;
    for(const action of Object.values(canonical.actions??{})){
      for(const row of action?.outputs?.obligationDispositions??[]){
        const id=String(row?.obligationId??'');
        if(id&&!firstSeen.has(id))firstSeen.set(id,phase);
      }
    }
  }
  const initial=(old.obligations??[]).filter(o=>Number(o?.originPhase)===0).map(o=>{
    const due=firstSeen.get(String(o.obligationId??''))??Number(o.requiredPhase);
    if(!Number.isInteger(due)||due<1||due>10)throw new Error('historical Phase-0 obligation has no valid first due phase: '+String(o.obligationId));
    return {...structuredClone(o),requiredPhase:String(due),requiredReviewer:reviewerForPhase(due,root,authorityRoot),
      status:'OPEN',statusReason:null,closureEvidenceRefs:[],updatedAt:o.createdAt??now};
  });
  const ledger={...old,obligations:initial,
    controllerImports:(old.controllerImports??[]).filter(x=>Number(x?.phase)===0),
    phaseCheckpoints:(old.phaseCheckpoints??[]).filter(x=>x?.phaseId==='phase-0')};
  for(let phase=1;phase<earliest;phase++){
    // Phase 7 is a marker only, not a second obligation-processing phase.
    if(phase===7)continue;
    const canonical=canonicalFor(root,campaignPath,phase);
    if(!canonical){
      // The controller itself emits Phase 7 and optional skipped Phase 9.
      if(phase===7||phase===9)continue;
      throw new Error('historical master ledger replay lacks sealed predecessor Phase '+phase);
    }
    const schema=loadPhaseSchema(root,authorityRoot,phase).schema;
    const canonicalRel=canonicalRelFor(campaignPath,phase);
    for(const dot of schema.bookkeepingMappings?.obligationRecordPaths??[]){
      normalizeFormalObligationsIntoLedger({ledger,items:getByPath(canonical,dot),originPhase:phase,canonicalRel,now,root,authorityRoot});
    }
    const domain=canonical.automationInputs?.domainRegistryPath;
    if(domain){
      const registry=maybeJson(root,path.posix.join(campaignPath,domain));
      if(!registry)throw new Error('historical domain registry missing at Phase '+phase);
      normalizeFormalObligationsIntoLedger({
        ledger,items:registry.generatedObligations??[],originPhase:phase,canonicalRel,now,root,authorityRoot
      });
    }
    applyObligationDispositionsToLedger({ledger,canonical,sequence:phase,canonicalRel,now,root,authorityRoot});
  }
  // Preserve immutable predecessor bookkeeping timestamps and imports. Only
  // the later phases under amendment are rebuilt and stamped with this replay.
  ledger.controllerImports=(old.controllerImports??[]).filter(x=>Number(x?.phase)<earliest);
  for(const checkpoint of old.phaseCheckpoints??[]){
    const phase=Number(String(checkpoint?.phaseId??'').replace('phase-',''));
    if(!(phase>=0&&phase<earliest))continue;
    const idx=(ledger.phaseCheckpoints??[]).findIndex(x=>x?.phaseId===checkpoint.phaseId);
    if(idx<0)continue;
    const observed=ledger.phaseCheckpoints[idx];
    if(observed.dispositionCount===checkpoint.dispositionCount &&
       observed.openOrBlockedAfterPhase===checkpoint.openOrBlockedAfterPhase)
      ledger.phaseCheckpoints[idx]=checkpoint;
  }
  // Preserve creation timestamps of accepted predecessors where IDs match.
  const oldById=new Map((old.obligations??[]).map(o=>[String(o.obligationId??''),o]));
  for(const item of ledger.obligations){
    const prior=oldById.get(String(item.obligationId??''));
    if(prior?.createdAt)item.createdAt=prior.createdAt;
  }
  writeJson(repoFile(root,rel),ledger);
}

function applyMasterAmendmentRefresh({root,campaignPath,directoryRel,authorityRoot,result,now}){
  // Reuse the exact segment already resolved and validated against the sealed
  // master record. Frozen authority revisions may have a versioned directory
  // suffix; never reject their bound lineup by re-guessing from a path string.
  const segment=result.segment?.segmentId===result.pending.segmentId
    ?result.segment
    :segmentsForAuthorityV1(authorityRoot,root).find(x=>x.segmentId===result.pending.segmentId);
  if(!segment)throw new Error('master amendment refresh segment is unsupported: '+
    String(result.pending.segmentId)+' @ '+String(authorityRoot));
  const affected=result.affectedPhases??[];
  if(!affected.length)throw new Error('master amendment refresh has no affected phases');
  const earliest=Math.min(...affected);
  const amendmentSha=result.amendmentSha256;
  const amendedForms=new Map((result.amendedForms??[]).map(x=>[x.path,x]));
  const originalForms=new Map();
  const phaseRows=new Map();
  for(const phase of segment.phases){
    const row=(result.record.reviewedArtifacts??[]).find(x=>x.phase===phase&&x.kind==='WORK_FORM');
    if(row){
      phaseRows.set(phase,row);
      originalForms.set(phase,readJson(requiredFile(root,path.posix.join(campaignPath,row.path),'Phase '+phase+' work form')));
    }
  }
  const refreshPhases=segment.phases.filter(phase=>phase>=earliest&&phase!==7&&phaseRows.has(phase));
  if(!refreshPhases.length)throw new Error('master amendment refresh has no reviewer-owned phase to regenerate');
  const shadowRoot=fs.mkdtempSync(path.join(os.tmpdir(),'lite-master-amendment-'));
  try{
    fs.mkdirSync(path.dirname(repoFile(shadowRoot,campaignPath)),{recursive:true});
    fs.cpSync(repoFile(root,campaignPath),repoFile(shadowRoot,campaignPath),{recursive:true});
    fs.mkdirSync(path.dirname(repoFile(shadowRoot,directoryRel)),{recursive:true});
    fs.copyFileSync(repoFile(root,directoryRel),repoFile(shadowRoot,directoryRel));
    copyAuthorityForShadow(root,shadowRoot,authorityRoot);
    const receiptLibRel='packages/controller-core/src/lite-phase-receipt-v1.mjs';
    fs.mkdirSync(path.dirname(repoFile(shadowRoot,receiptLibRel)),{recursive:true});
    fs.copyFileSync(requiredFile(root,receiptLibRel,'lite receipt library'),repoFile(shadowRoot,receiptLibRel));
    restoreLedgerBeforeMasterPhase({root:shadowRoot,campaignPath,authorityRoot,earliest,now});

    let shadowDirectory=readJson(repoFile(shadowRoot,directoryRel));
    shadowDirectory.pendingMasterReview={...shadowDirectory.pendingMasterReview,status:'MASTER_AMENDMENT_REFRESH',amendmentSha256:amendmentSha};
    for(let index=0;index<refreshPhases.length;index++){
      const phase=refreshPhases[index];
      process.stderr.write(`[lite-master] Revalidating Phase ${phase} of ${refreshPhases.join(', ')} in isolated master-amendment replay\n`);
      const loaded=loadPhaseSchema(shadowRoot,authorityRoot,phase);
      const schema=loaded.schema;
      const row=phaseRows.get(phase);
      const formRel=path.posix.join(campaignPath,row.path);
      let form;
      let predecessorReceiptPath;
      let derivedInputPaths;
      if(index===0){
        form=structuredClone(originalForms.get(phase));
        const oldReceipt=readJson(requiredFile(shadowRoot,latestPhaseReceiptInfo(shadowRoot,campaignPath,phase).rel,'sealed Phase '+phase+' receipt'));
        predecessorReceiptPath=(oldReceipt.inputs??[]).find(x=>x?.role==='PREDECESSOR_RECEIPT')?.path;
        derivedInputPaths=form.automationInputs?.derivedInputPaths??[];
      }else{
        const generated=shadowDirectory.currentAssignment;
        if(generated?.phaseSequence!==phase)throw new Error('master amendment refresh dependency chain did not prepare Phase '+phase);
        predecessorReceiptPath=generated.predecessorReceiptPath;
        derivedInputPaths=generated.derivedInputPaths??[];
        if(!generated.workShardIndexPath)throw new Error('refreshed phase missing semantic work-shard index');
        materializeSemanticWorkFormV13({root:shadowRoot,formRel:generated.workFormPath});
        const fresh=readJson(requiredFile(shadowRoot,generated.workFormPath,'refreshed Phase '+phase+' scaffold'));
        const trustedPrefill=structuredClone(fresh);
        const amendedDisposition=(amendedForms.get(row.path)?.changedFields??[]).some(x=>x.endsWith('.obligationDispositions'));
        form=retainSealedDueObligationPrefill(
          overlayReviewerOutputs(schema,fresh,originalForms.get(phase)),
          originalForms.get(phase),phase,trustedPrefill,schema,amendedDisposition
        );
      }
      if(!predecessorReceiptPath)throw new Error('master amendment refresh lacks predecessor receipt for Phase '+phase);
      form.automationInputs={...(form.automationInputs??{}),predecessorReceiptPath,derivedInputPaths:[...derivedInputPaths]};
      const prefillDigest=refreshControllerPrefillDigest(form);
      writeJson(repoFile(shadowRoot,formRel),form);
      const revision=latestPhaseReceiptInfo(shadowRoot,campaignPath,phase).revision+1;
      shadowDirectory.currentAssignment={
        phaseSequence:phase,
        phaseId:'phase-'+phase,
        phaseRevision:revision,
        reviewer:reviewerForPhase(phase,root,authorityRoot),
        status:'ACTIVE',
        workSchemaPath:loaded.rel,
        workFormPath:formRel,
        finalReportPath:schema.finalReport?revisionedArtifactPath(path.posix.join(campaignPath,schema.finalReport.campaignPath),revision):null,
        packetPath:revisionedArtifactPath(path.posix.join(campaignPath,schema.submission.packetPath),revision),
        predecessorReceiptPath,
        derivedInputPaths:[...derivedInputPaths],
        controllerPrefillDigestSha256:prefillDigest,
        masterAmendmentRefreshSha256:amendmentSha
      };
      shadowDirectory.campaignStatus='MASTER_AMENDMENT_REFRESH';
      shadowDirectory.updatedAt=now;
      writeJson(repoFile(shadowRoot,directoryRel),shadowDirectory);
      const childArgs=[
        process.argv[1],
        '--controller-root',shadowRoot,
        '--campaign-id',shadowDirectory.campaignId,
        '--campaign-path',campaignPath,
        '--campaign-directory-path',directoryRel,
        '--phase-sequence',String(phase),
        '--master-amendment-refresh-sha',amendmentSha
      ];
      if(phase===5){
        const oldPhase5=canonicalFor(root,campaignPath,5);
        const oldPhase4=canonicalFor(root,campaignPath,4);
        const newPhase4=canonicalFor(shadowRoot,campaignPath,4);
        // The original campaign remains immutable during shadow replay.
        // Only targets with identical reviewer test designs and source anchors
        // may even TRY to reuse a prior machine result; the gate revalidates
        // exact request, persisted raw result, source, and observed outcome.
        const reuseKeys=selectReusablePhase5TargetsV1({
          priorTargetDesigns:phaseOutput(oldPhase5,'step-3','targetDesigns')??[],
          targetDesigns:phaseOutput(form,'step-3','targetDesigns')??[],
          priorCandidateRecords:[
            ...(phaseOutput(oldPhase4,'step-3','candidateRecords')??[]),
            ...(phaseOutput(oldPhase5,'step-2','newCandidateRecords')??[])
          ],
          candidateRecords:[
            ...(phaseOutput(newPhase4,'step-3','candidateRecords')??[]),
            ...(phaseOutput(form,'step-2','newCandidateRecords')??[])
          ]
        });
        childArgs.push('--phase5-reuse-keys-b64',Buffer.from(JSON.stringify(reuseKeys)).toString('base64'));
      }
      // Preserve only genuine Phase-5 runner evidence on a failed shadow replay.
      // No work form, receipt, packet, control, or campaign assignment is copied
      // into the live campaign unless the entire master refresh subsequently PASSes.
      const preservePhase5AttemptEvidence=()=>{
        if(phase!==5)return;
        const rel=path.posix.join(campaignPath,'evidence/phase5-boundary');
        const from=repoFile(shadowRoot,rel);
        if(!fs.existsSync(from))return;
        const into=repoFile(root,rel);
        for(const candidate of fs.readdirSync(from,{withFileTypes:true})){
          if(!candidate.isDirectory()||!/^[A-Za-z0-9._-]+$/.test(candidate.name))continue;
          for(const requestDir of fs.readdirSync(path.join(from,candidate.name),{withFileTypes:true})){
            if(!requestDir.isDirectory()||!/^dar-[0-9a-f]{32}$/.test(requestDir.name))continue;
            const sourceDir=path.join(from,candidate.name,requestDir.name);
            const rawPath=path.join(sourceDir,'raw-result.json');
            if(!fs.existsSync(rawPath))continue;
            let raw,envelope;
            try{
              envelope=readJson(rawPath);
              raw=readV7RawResultV1(rawPath);
            }catch{continue;}
            if(raw?.requestId!==requestDir.name||raw?.source?.archiveSha256!==shadowDirectory.sourceSha256)continue;
            const destDir=path.join(into,candidate.name,requestDir.name);
            fs.mkdirSync(destDir,{recursive:true});
            const partFiles=Array.isArray(envelope?.parts)?envelope.parts.map(p=>p.file):[];
            for(const file of ['raw-result.json','controller-evidence.json','execution-summary.json',...partFiles]){
              const sourceFile=path.join(sourceDir,file);
              if(fs.existsSync(sourceFile)&&fs.statSync(sourceFile).isFile())
                fs.copyFileSync(sourceFile,path.join(destDir,file));
            }
          }
        }
      };
      let parsed;
      try{
        // Child writes exactly one JSON result on stdout. Relay only its stderr
        // so candidate start/heartbeat/end are visible during long Foundry work.
        const output=execFileSync(process.execPath,childArgs,{encoding:'utf8',stdio:['ignore','pipe','inherit']});
        parsed=JSON.parse(output.trim());
      }catch(error){
        preservePhase5AttemptEvidence();
        throw error;
      }
      if(parsed.status!=='PASS'||parsed.masterAmendmentRefresh!==true){
        preservePhase5AttemptEvidence();
        throw new Error('controller dependent refresh failed for Phase '+phase+': '+String(parsed.feedbackText??parsed.status));
      }
      process.stderr.write(`[lite-master] Phase ${phase} replay PASS\n`);
      shadowDirectory=readJson(repoFile(shadowRoot,directoryRel));
    }
    const refreshedDirectory=readJson(repoFile(shadowRoot,directoryRel));
    const expectedAuthority={homepagePath:result.record.bindings.authority.homepagePath,liteSkillSha256:result.record.bindings.authority.sha256};
    const postArtifacts=collectSegmentArtifacts({root:shadowRoot,campaignPath,segment,directory:refreshedDirectory,expectedAuthority});
    if(segment.boundaryPhase===10){
      const unresolved=unresolvedFinalCandidateFailures({root:shadowRoot,campaignPath,directory:refreshedDirectory});
      if(unresolved.length)throw new Error('MASTER_TARGETED_TESTS_REQUIRED: '+unresolved.join('; '));
    }
    const postByPath=new Map(postArtifacts.map(x=>[x.path,x]));

    // Every reviewer product that the amendment replaced or left unreferenced is
    // preserved byte-for-byte under superseded/ at its original campaign path.
    const superseded=[];const seen=new Set();
    for(const row of result.record.reviewedArtifacts??[]){
      if(seen.has(row.path)||row.phase<earliest||!isSupersedableRow(row))continue;
      seen.add(row.path);
      const amended=amendedForms.get(row.path);
      const post=postByPath.get(row.path);
      const shadowFile=repoFile(shadowRoot,path.posix.join(campaignPath,row.path));
      const postSha=post?.sha256??(fs.existsSync(shadowFile)?shaFile(shadowFile):null);
      if(!amended&&post&&postSha===row.sha256)continue;
      const originalBytes=amended?amended.originalBytes:fs.readFileSync(repoFile(root,path.posix.join(campaignPath,row.path)));
      if(createHash('sha256').update(originalBytes).digest('hex')!==row.sha256)throw new Error('superseded original digest mismatch: '+row.path);
      superseded.push({phase:row.phase,kind:row.kind,originalPath:row.path,supersededPath:path.posix.join(SUPERSEDED_DIRECTORY_V1,result.pending.segmentId==='reviewer-4-followup-v1'?'reviewer-4-followup-v1':'',row.path),sha256:row.sha256,replacedBySha256:post?postSha:null,originalBytes});
    }
    for(const item of superseded){
      const target=repoFile(root,path.posix.join(campaignPath,item.supersededPath));
      if(fs.existsSync(target))throw new Error('superseded destination already exists: '+item.supersededPath);
    }
    fs.cpSync(repoFile(shadowRoot,campaignPath),repoFile(root,campaignPath),{recursive:true,force:true});
    for(const item of superseded){
      const target=repoFile(root,path.posix.join(campaignPath,item.supersededPath));
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,item.originalBytes);
      if(item.replacedBySha256===null)fs.rmSync(repoFile(root,path.posix.join(campaignPath,item.originalPath)),{force:true});
    }
    return {
      refreshedPhases:refreshPhases,
      postArtifacts,
      postManifestSha256:createHash('sha256').update(JSON.stringify(postArtifacts)).digest('hex'),
      superseded:superseded.map(({originalBytes,...rest})=>rest),
      lastSealedReceiptPath:refreshedDirectory.lastSealedReceiptPath,
      nextAssignment:refreshedDirectory.currentAssignment??null,
      campaignStatus:refreshedDirectory.campaignStatus
    };
  }finally{
    fs.rmSync(shadowRoot,{recursive:true,force:true});
  }
}


const a=parse(process.argv);
const reviewKind=a['review-kind']??'phase';
const masterAmendmentRefreshSha=a['master-amendment-refresh-sha']??null;
const phase5ReuseCandidateKeys=masterAmendmentRefreshSha&&a['phase5-reuse-keys-b64']
  ?JSON.parse(Buffer.from(a['phase5-reuse-keys-b64'],'base64').toString('utf8')):[];
if(!Array.isArray(phase5ReuseCandidateKeys)||phase5ReuseCandidateKeys.some(x=>typeof x!=='string'))
  throw new Error('internal Phase 5 reused target IDs must be a string array');
if(a['phase5-reuse-keys-b64']&&!masterAmendmentRefreshSha)
  throw new Error('Phase 5 reuse IDs are only authorized in master amendment refresh');

if(masterAmendmentRefreshSha&&reviewKind!=='phase')throw new Error('master-amendment-refresh-sha is internal to phase refresh');
for(const k of ['controller-root','campaign-id','campaign-path','campaign-directory-path']) if(a[k]===undefined) throw new Error('missing --'+k);
if(['phase','sealed-rework','post-completion-followup'].includes(reviewKind)&&a['phase-sequence']===undefined) throw new Error('missing --phase-sequence');
if(reviewKind==='discovery'&&!a['unit-id'])throw new Error('missing --unit-id');
if(reviewKind==='master-test-result'&&!a['test-result-path'])throw new Error('missing --test-result-path');
if(reviewKind==='master'&&a['master-outcome']==='REQUEST_TARGETED_TESTS'&&!a['test-plan-path'])throw new Error('missing --test-plan-path');
if(['sealed-rework','post-completion-followup'].includes(reviewKind)&&!a['rework-request-path']) throw new Error('missing --rework-request-path');
if(!['phase','discovery'].includes(reviewKind)) throw new Error('unsupported review-kind');
const root=path.resolve(a['controller-root']);
const expectedCampaignId=a['campaign-id'];
const campaignPath=a['campaign-path']; const campaignRoot=repoFile(root,campaignPath);
// All externally visible exits write synchronously: process.exit() cannot drop
// buffered output. Nested transaction children retain their private full response.
const internalTransaction=a['master-transaction-child']==='true'||Boolean(masterAmendmentRefreshSha);
process.stdout.write=(chunk)=>{
  const line=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);
  const result=JSON.parse(line.trim());
  const displayed=internalTransaction?result:storeControllerResultV1({root,campaignPath,response:result});
  writeAllSyncV1(1,JSON.stringify(displayed)+'\n',{onRetry:()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)});
  return true;
};
const sequence=reviewKind==='discovery'?null:Number(a['phase-sequence']);
const directoryRel=a['campaign-directory-path']; const directoryFile=requiredFile(root,directoryRel,'campaign directory entry');
const directory=readJson(directoryFile);
const now=new Date().toISOString();
if(directory.schemaVersion!=='curveyield-audit-campaign-directory-entry-v2') throw new Error('packet controller requires Audit Campaign Directory v2');

if(directory.campaignId!==expectedCampaignId) throw new Error('campaign-id does not match Audit Campaign Directory');
if(directory.workspacePath!==campaignPath) throw new Error('campaign-path does not match Audit Campaign Directory workspacePath');
if(directory.mode!=='LITE_SOLO'||!['PARALLEL_WORKER_UNITS','ONE_PERSISTENT_AGENT'].includes(directory.agentModel)||directory.agent?.actorId!=='lite-solo-agent')
 throw new Error('not an admitted lite-solo single-actor campaign');
if(directory.pendingMasterReview||directory.masterReview||directory.lastAcceptedMasterReview||directory.testExecutor)throw new Error('legacy master/executor state in lite-solo campaign');
if(directory.skillAuthority?.current?.release && !['lite-solo-v1','lite-solo-v2','lite-solo-v3','lite-solo-v4','lite-solo-v5','lite-solo-v6'].includes(directory.skillAuthority.current.release))throw new Error('lite-solo bound release mismatch');
const phase5OwnerDeferral=!['Audit Skill - Lite-Solo Authority/lite-solo-v3/','Audit Skill - Lite-Solo Authority/lite-solo-v4/','Audit Skill - Lite-Solo Authority/lite-solo-v5/','Audit Skill - Lite-Solo Authority/lite-solo-v6/'].some(prefix=>directory.currentAssignment?.workSchemaPath?.startsWith(prefix)) && [5,6,8,10].includes(sequence)
  ?inspectPhase5OwnerEvidenceDeferralV1({controllerRoot:root,campaignPath,campaignId:directory.campaignId,sourceSha256:directory.sourceSha256})
  :null;
const authorityReceiptPath=directory.lastSealedReceiptPath??directory.currentAssignment?.predecessorReceiptPath;
const effectiveAuthorityRoot=authorityReceiptPath
  ?validateBoundAuthorityV1({root,receipt:readJson(requiredFile(root,authorityReceiptPath,'admitted authority receipt'))})
  :null;
const boundAuthorityHome=directory.lastSealedReceiptPath
  ?readJson(requiredFile(root,directory.lastSealedReceiptPath,'bound authority receipt'))?.authority?.homepagePath
  :directory.skillAuthority?.current?.homepagePath;
const boundAuthorityRoot=typeof boundAuthorityHome==='string'&&boundAuthorityHome.endsWith('/SKILL.md')
  ?boundAuthorityHome.slice(0,-'/SKILL.md'.length)
  :String(directory.currentAssignment?.workSchemaPath??'').split('/phases/')[0];
const authorityLinkRoot=effectiveAuthorityRoot
  ?authorityLinkPathV1(root,effectiveAuthorityRoot)
  :boundAuthorityRoot?authorityLinkPathV1(root,boundAuthorityRoot):'';
if(masterAmendmentRefreshSha)throw new Error('lite-solo forbids master amendment refresh');
function activeDetectionPolicyV1(receipt) {
  const authorityRoot=authorityRootFromReceipt(receipt);
  return detectionPolicyForAuthorityV1({repoRoot:root,authorityRoot,
    readJsonIfExists:(rel)=>fs.existsSync(repoFile(root,rel))?readJson(repoFile(root,rel)):null});
}
if(reviewKind==='discovery'){
  if(['STOPPED_BY_HUMAN','BLOCKED'].includes(directory.campaignStatus))
    throw new Error('campaign is held by explicit human status');
  if(!directory.discovery?.statePath)throw new Error('campaign has no discovery state');
  const sourceReceipt=readJson(requiredFile(root,path.posix.join(campaignPath,'receipts/PHASE_00_RECEIPT_v1.json'),'Phase 0 authority receipt'));
  if(!activeDetectionPolicyV1(sourceReceipt))throw new Error('discovery is not authorized for legacy campaign');
  const readyUnitIds=a['ready-unit-ids-b64']
    ?JSON.parse(Buffer.from(a['ready-unit-ids-b64'],'base64').toString('utf8')):[a['unit-id']];
  const result=advanceDiscoveryV1({root,campaignPath,directory,
    authorityRoot:authorityRootFromReceipt(sourceReceipt),automationRoot:process.cwd(),
    unitId:a['unit-id'],readyUnitIds,now,auditControllerRef:a['audit-controller-ref']??'main'});
  if(result.status==='DISCOVERY_STALE_REQUEST'){
    process.stdout.write(JSON.stringify({authorityLinkRoot,status:result.status,campaignId:directory.campaignId,campaignName:directory.campaignName})+'\n');
    process.exit(0);
  }
  directory.discovery.status=result.status==='DISCOVERY_COMPLETE'?'COMPLETE':'RUNNING';
  const discoveryState=readJson(repoFile(root,directory.discovery.statePath)).payload;
  directory.discovery.activeUnitId=discoveryState.activeUnitId;
  directory.discovery.activeUnitIds=discoveryState.order.filter(id=>discoveryState.units[id]?.status==='ACTIVE');
  if(result.status==='DISCOVERY_COMPLETE'){
    const successor=preparePhaseWork({root,campaignPath,
      authorityRoot:authorityRootFromReceipt(sourceReceipt),sequence:4,reviewer:'lite-solo-agent',
      predecessorReceiptPath:directory.lastSealedReceiptPath,status:'ACTIVE',
      derivedInputPaths:[...(directory.currentAssignment?.derivedInputPaths??[]),
        path.posix.join(campaignPath,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json')]});
    directory.currentAssignment=successor;directory.campaignStatus='ACTIVE';
  }
  directory.updatedAt=now;writeJson(directoryFile,directory);
  const feedback=result.feedbackText??result.status;
  process.stdout.write(JSON.stringify({authorityLinkRoot,status:result.status,campaignId:directory.campaignId,campaignName:directory.campaignName,
    feedbackText:feedback,feedbackB64:Buffer.from(feedback).toString('base64'),
    currentDiscoveryWindow:result.currentWindow??null,
    activeDiscoveryUnitIds:directory.discovery.activeUnitIds})+'\n');
  process.exit(0);
}
// The phase-wide path is the retained aggregate security validator for v4, never a worker ingress.
if(directory.authorityRelease==='lite-solo-v4'&&[4,5,6].includes(sequence)&&process.env.LITE_SOLO_V4_FINALIZE!=='1')
 throw new Error('v4 Phase 4–6 can only be finalized from accepted immutable units');
// Lite-Solo accepts phase/discovery only. No successor-delivery holds or master rework routes.
const sealedRework=null;
if(reviewKind==='phase'&&!masterAmendmentRefreshSha&&['STOPPED_BY_HUMAN','BLOCKED'].includes(String(directory.campaignStatus??'')))
 throw new Error('campaign is held by explicit human status '+directory.campaignStatus);
const assignment=directory.currentAssignment;
if(!assignment||assignment.phaseSequence!==sequence) throw new Error('current assignment does not match submitted phase');
const predecessor=readJson(requiredFile(root,assignment.predecessorReceiptPath,'predecessor sealed receipt'));
const authorityRoot=authorityRootFromReceipt(predecessor);
const loaded=loadPhaseSchema(root,authorityRoot,sequence); const schema=loaded.schema;
if(![ 'Audit Skill - Lite-Solo Authority/lite-solo', 'Audit Skill - Lite-Solo Authority/lite-solo-v2', 'Audit Skill - Lite-Solo Authority/lite-solo-v3', 'Audit Skill - Lite-Solo Authority/lite-solo-v4', 'Audit Skill - Lite-Solo Authority/lite-solo-v5', 'Audit Skill - Lite-Solo Authority/lite-solo-v6' ].includes(authorityRoot)||predecessor.authority?.liteRelease!==(authorityRoot==='Audit Skill - Lite-Solo Authority/lite-solo-v6'?'lite-solo-v6':authorityRoot==='Audit Skill - Lite-Solo Authority/lite-solo-v5'?'lite-solo-v5':authorityRoot==='Audit Skill - Lite-Solo Authority/lite-solo-v4'?'lite-solo-v4':authorityRoot==='Audit Skill - Lite-Solo Authority/lite-solo-v3'?'lite-solo-v3':authorityRoot==='Audit Skill - Lite-Solo Authority/lite-solo-v2'?'lite-solo-v2':'lite-solo-v1')||assignment.reviewer!=='lite-solo-agent')
 throw new Error('lite-solo predecessor or assignment authority mismatch');
if(assignment?.status==='WAITING_FOR_SUCCESSOR_AGENT')throw new Error('lite-solo cannot require reviewer handoff');
const gatedMasterReview=false; // lite-solo never stages master acceptance
if(assignment.workSchemaPath!==loaded.rel) throw new Error('assignment workSchemaPath mismatch');

const packetFile=repoFile(root,assignment.packetPath);
const existingPacket=fs.existsSync(packetFile)?readJson(packetFile):null;
const packet=buildControllerPacket({directory,assignment,existing:existingPacket,now});
let deficiencies=ensurePacketShape({packet,directory,assignment});
let form=null;
let workShardIntegrityFailed=false;
try{
  // Agent edits semantic shards; reconstruct once for full-phase machine validation.
  // Reject missing or legacy work transport rather than reading an aggregate form.
  if(!assignment.workShardIndexPath)throw new Error('required semantic work-shard index missing');
  materializeSemanticWorkFormV13({root,formRel:assignment.workFormPath});
  form=readJson(requiredFile(root,assignment.workFormPath,'phase work form'));

  // v10.3 stores the authoritative prefill digest outside the reviewer-editable
  // form. Older active assignments are migrated once from the pre-existing form
  // digest so in-flight v10.2 campaigns remain resumable.
  if(!assignment.controllerPrefillDigestSha256){
    const legacyDigest=form?.automationInputs?.controllerPrefillDigestSha256;
    if(typeof legacyDigest!=='string'||!/^[0-9a-f]{64}$/.test(legacyDigest)){
      deficiencies.push('Controller-owned assignment prefill digest is missing and no valid legacy form digest is available for one-time migration.');
    }else{
      assignment.controllerPrefillDigestSha256=legacyDigest;
      assignment.controllerPrefillDigestMigration='BOUND_FROM_LEGACY_FORM_DIGEST';
    }
  }

  deficiencies.push(...validateWorkForm(schema,form));
  deficiencies.push(...validatePhaseScaffold(sequence,form,assignment.controllerPrefillDigestSha256));
  if(sequence===5){
    const reportRel=path.posix.join(campaignPath,'controller/preflight/PHASE5_REQUEST_PREFLIGHT_v1.json');
    const preflight=maybeJson(root,reportRel);
    if(preflight){
      if(preflight.schemaVersion!=='curveyield-phase5-request-preflight-v1'||
        preflight.campaignId!==directory.campaignId||preflight.sourceSha256!==directory.sourceSha256)
        deficiencies.push('Phase 5 preflight identity mismatch: '+reportRel);
      else if(preflight.status==='REWORK_REQUIRED'){
        for(const f of preflight.failures??[])
          deficiencies.push('Phase 5 preflight candidate '+String(f.candidateKey??'UNKNOWN')+
            ', field '+String(f.path??'UNKNOWN')+', shard '+String(f.shardPath??'UNSHARDED')+
            ': '+String(f.reason??'missing executable test input'));
      }else if(preflight.status!=='PREFLIGHT_PASS')
        deficiencies.push('Phase 5 preflight unrecognized status: '+reportRel);
    }
  }
  if(activeDetectionPolicyV1(predecessor)){
    const fn=({6:validatePhase6AttackerWorkV1,8:validatePhase8LinkageV1,10:validatePhase10CoverageLabelV1})[sequence];
    if(fn)deficiencies.push(...fn({root,campaignPath,form,requireCoverageMatrix:sequence===10&&/\/lite-solo-v[345]$/.test(authorityRoot)}));
  }

  if(sequence===9&&deficiencies.length===0){
    const collectionDeficiencies=populatePhase9RerunEvidenceRefs({root,campaignPath,form});
    deficiencies.push(...collectionDeficiencies);
    if(collectionDeficiencies.length===0){
      assignment.controllerPrefillDigestSha256=form.automationInputs.controllerPrefillDigestSha256;
      writeJson(repoFile(root,assignment.workFormPath),form);
      deficiencies.push(...validateWorkForm(schema,form));
      deficiencies.push(...validatePhaseScaffold(sequence,form,assignment.controllerPrefillDigestSha256));
    }
  }
}catch(e){
  workShardIntegrityFailed=true;
  deficiencies.push(String(e.message||e));
}

function persistReviewerReworkShardsV1(){
  // A failed integrity check must never re-seal a stale or corrupt agent shard.
  if(workShardIntegrityFailed)return;
  if(!assignment.workShardIndexPath)return;
  const full=repoFile(root,assignment.workFormPath);
  if(fs.existsSync(full))
    secureShardWorkFormV13({root,formRel:assignment.workFormPath,phase:sequence,retireFull:true});
}
function annotateShardReworkV1(packet,errors){
 if(!assignment.workShardIndexPath)return '';
 let map;
 try{map=semanticShardFailureIndexV13({root,indexRel:assignment.workShardIndexPath,deficiencies:errors});}
 catch(error){
   // Never allow reviewer-tampered index pages to crash the boundary controller.
   packet.controllerValidation.shardRework={indexPath:assignment.workShardIndexPath,shards:[],unmappedCount:errors.length};
   return '\\nSHARD_REWORK: restore the controller-owned index and listed shard records. '+String(error?.message??error);
 }
 packet.controllerValidation.shardRework={indexPath:assignment.workShardIndexPath,
   shards:map.shards.map(s=>({path:s.path,recordKeys:s.recordKeys,defectCount:s.defects.length})),
   unmappedCount:map.unmapped.length};
 if(!map.shards.length)return '';
 return '\nSHARD_REWORK: edit the listed shard records only; original full diagnostics are in controller result pages.\n'+
  map.shards.map(s=>s.path+' : '+s.recordKeys.join(', ')).join('\n');
}
function materialPhase5Candidates({root,campaignPath,form}){
  const prior=canonicalFor(root,campaignPath,4);
  const phase4=phaseOutput(prior,'step-3','candidateRecords')??[];
  const newCandidates=form?.actions?.['step-2']?.outputs?.newCandidateRecords??[];
  const keys=[],sourceAnchors={};
  for(const record of [...phase4,...newCandidates]){
    if(record==='NONE_IDENTIFIED')continue;
    const key=String(record?.canonicalId??record?.tempKey??'').trim();
    if(!key)throw new Error('Phase 5 material candidate has no key');
    const anchor=String(record?.sourceAnchor??'').trim();
    if(sourceAnchors[key]!==undefined&&sourceAnchors[key]!==anchor)
      throw new Error('Phase 5 material candidate '+key+' has inconsistent source anchors');
    keys.push(key);sourceAnchors[key]=anchor;
  }
  return {keys:[...new Set(keys)],sourceAnchors};
}
if(sequence===5&&form&&deficiencies.length===0){
  const targets=form?.actions?.['step-3']?.outputs?.targetDesigns??[];
  for(const target of targets){
    if(!target||typeof target!=='object') continue;
    const method=String(target.executionMethod??'').toUpperCase();
    if(method==='NOT_APPLICABLE'){
      target.executionRequestRef='NOT_APPLICABLE';
      target.automationResolvedExecutionRequest=false;
      target.requestBindingStatus='NOT_APPLICABLE';
      target.requestBindingEvidenceRef='NOT_APPLICABLE';
      target.automationOwnedFields=[...new Set([
        ...(target.automationOwnedFields??[]),
        'executionRequestRef','automationResolvedExecutionRequest','requestBindingStatus','requestBindingEvidenceRef'
      ])];
      continue;
    }
    const explicitBeforeResolve=typeof target.executionRequestRef==='string'
      && !target.executionRequestRef.startsWith('<')
      && target.executionRequestRef!=='NOT_APPLICABLE';
    const resolved=resolveTargetExecutionRequestRef({root,campaignPath,target});
    if(!resolved){
      deficiencies.push('Phase 5 target '+String(target.candidateKey??'UNRESOLVED')+' has no deterministically resolvable execution request. Materialize the exact trusted V7 request at a conventional campaign request path or provide a campaign-relative executionRequestRef only for this target.');
      continue;
    }
    target.executionRequestRef=resolved;
    target.automationResolvedExecutionRequest=!explicitBeforeResolve;

    const binding=validateTargetExecutionRequestBindingV1({
      controllerRoot:root,
      campaignPath,
      target,
      expectedCampaignId:directory.campaignId,
      expectedSourceSha256:directory.sourceSha256
    });
    target.requestBindingStatus=binding.status;
    target.requestBindingEvidenceRef=binding.requestRef??resolved;
    target.automationOwnedFields=[...new Set([
      ...(target.automationOwnedFields??[]),
      'executionRequestRef','automationResolvedExecutionRequest','requestBindingStatus','requestBindingEvidenceRef'
    ])];
    if(!String(binding.status).startsWith('PASS_')){
      deficiencies.push(
        'Phase 5 target '+String(target.candidateKey??'UNRESOLVED')+
        ' execution request is not structurally bound to the accepted target/source: '+
        String(binding.status)+' — '+(binding.reasons??[]).join('; ')
      );
    }
  }
  if(!deficiencies.length){
    assignment.controllerPrefillDigestSha256=refreshControllerPrefillDigest(form);
    writeJson(repoFile(root,assignment.workFormPath),form);
    deficiencies.push(...validatePhaseScaffold(sequence,form,assignment.controllerPrefillDigestSha256));
  }
}

if(sequence===5&&form&&deficiencies.length===0){
  try{
    deficiencies.push(...validatePhase5TargetCoverageV1({
      targetDesigns:form.actions['step-3'].outputs.targetDesigns,
      materialCandidateKeys:materialPhase5Candidates({root,campaignPath,form}).keys,
      candidateSourceAnchors:materialPhase5Candidates({root,campaignPath,form}).sourceAnchors
    }));
  }catch(e){deficiencies.push('Phase 5 coverage validation failed: '+String(e.message||e));}
}
// Downstream gates must independently reconstruct the mandatory candidate set
// and read actual V7 machine artifacts. A prior phase PASS/receipt is not proof.
if([6,8].includes(sequence)&&deficiencies.length===0){
  try{
    const sealedP5=canonicalFor(root,campaignPath,5);
    const mandatory=materialPhase5Candidates({root,campaignPath,form:sealedP5}).keys;
    const rows=sequence===6?(form.actions?.['step-2']?.outputs?.targetDispositions??[])
      :(form.actions?.['step-2']?.outputs?.candidateValidations??[]);
    const actual=rows.filter(x=>x&&typeof x==='object').map(x=>String(x.candidateKey??'').trim()).filter(Boolean);
    if(actual.length!==new Set(actual).size)deficiencies.push('Phase '+sequence+' contains duplicate candidate dispositions');
    for(const key of mandatory)if(!actual.includes(key))
      deficiencies.push('Phase '+sequence+' skipped mandatory predecessor candidate '+key);
    if(sequence===6){
      if(phase5OwnerDeferral){
        if(sealedP5?.automationOutputs?.phase5MachineExecutionGate?.status!=='DEFERRED_UNVERIFIED'||
           sealedP5.automationOutputs.phase5MachineExecutionGate.ownerDirectivePath!==phase5OwnerDeferral.path)
          deficiencies.push('Phase 6 cannot carry unverified evidence without exact Phase-5 deferral record');
      }else deficiencies.push(...validateRecordedPhase5MachineEvidenceV1({
        controllerRoot:root,campaignPath,
        targetDesigns:phaseOutput(sealedP5,'step-3','targetDesigns')??[],
        expectedCampaignId:directory.campaignId,
        expectedSourceSha256:directory.sourceSha256,requireCompletedMatrix:true
      }));
    }
  }catch(e){deficiencies.push('Phase '+sequence+' mandatory predecessor/evidence gate failed: '+String(e.message||e));}
}

if(deficiencies.length){
  persistReviewerReworkShardsV1();
  packet.status='REWORK_REQUIRED';
  packet.controllerValidation={status:'FAIL',validatedAt:now,deficiencies};
  directory.currentAssignment.status='REWORK_REQUIRED';directory.campaignStatus='ACTIVE';directory.updatedAt=now;
  writeJson(packetFile,packet);writeJson(directoryFile,directory);
  const shardGuidance=annotateShardReworkV1(packet,deficiencies);
  writeJson(packetFile,packet);
  const feedback=feedbackText(sequence,deficiencies).replace('resubmit the same phase packet','repair the substantive fields and invoke controller validation again; the controller will rebuild the packet')+shardGuidance;
  process.stdout.write(JSON.stringify({authorityLinkRoot,status:'NEEDS_REWORK',campaignId:directory.campaignId,campaignName:directory.campaignName,phaseSequence:sequence,phaseId:'phase-'+sequence,reviewer:assignment.reviewer,feedbackText:feedback,feedbackB64:Buffer.from(feedback).toString('base64'),packetPath:assignment.packetPath,directoryPath:directoryRel})+'\n');
  process.exit(0);
}

// Historical v1/v2 campaigns retain their gate; v3–v6 proceed via source-bound execution without a separate approval.
if(sequence===5 && !['Audit Skill - Lite-Solo Authority/lite-solo-v3','Audit Skill - Lite-Solo Authority/lite-solo-v4','Audit Skill - Lite-Solo Authority/lite-solo-v5','Audit Skill - Lite-Solo Authority/lite-solo-v6'].includes(authorityRoot) && !(directory.machineExecutionAuthorization?.status==='APPROVED' &&
  directory.machineExecutionAuthorization?.sourceSha256===directory.sourceSha256 &&
  directory.machineExecutionAuthorization?.scope==='PHASE5_TARGET_EXECUTION'))
 throw new Error('LITE_SOLO_TEST_AUTHORIZATION_REQUIRED: Phase 5 machine execution has no exact human-approved source-bound authorization.');
// Execute mandatory Phase-5 candidate tests before any PASS, bookkeeping or seal.
let phase5MachineResults=null;
if(sequence===5){
  const targetDesigns=form.actions['step-3'].outputs.targetDesigns;
  const {keys:materialCandidateKeys,sourceAnchors:candidateSourceAnchors}=
    materialPhase5Candidates({root,campaignPath,form});
  try{
    if(phase5OwnerDeferral){
      if(JSON.stringify(materialCandidateKeys.slice().sort())!==JSON.stringify(phase5OwnerDeferral.candidateKeys.slice().sort()))
        throw new Error('Owner Phase-5 deferral does not cover exactly the mandatory candidate set');
      phase5MachineResults=Object.fromEntries(phase5OwnerDeferral.candidateKeys.map(key=>[key,{
        status:'DEFERRED_UNVERIFIED',exitCode:null,evidenceRef:'NO_MACHINE_EVIDENCE',
        requestBindingStatus:targetDesigns.find(x=>x.candidateKey===key)?.requestBindingStatus??'UNVERIFIED',
        requestBindingEvidenceRef:targetDesigns.find(x=>x.candidateKey===key)?.executionRequestRef??'NO_REQUEST',
        requestBindingReasons:['OWNER_DEFERRED_NOT_AN_EXECUTION_RESULT'],
        rawResult:null
      }]));
    }else{
      phase5MachineResults=await executePhase5TargetsV1({
        controllerRoot:root,campaignPath,targetDesigns,
        expectedCampaignId:directory.campaignId,expectedSourceSha256:directory.sourceSha256,
        reuseCandidateKeys:phase5ReuseCandidateKeys
      });
      deficiencies.push(...validatePhase5TargetExecutionGateV1({
        controllerRoot:root,campaignPath,targetDesigns,
        materialCandidateKeys,candidateSourceAnchors,executionResults:phase5MachineResults,
        expectedSourceSha256:directory.sourceSha256
      }));
    }
    // Report the actual runner cause, not merely BLOCKED. The shadow
    // campaign is discarded on failed master refresh, so these diagnostics
    // are essential to distinguish harness defects from RPC or build faults.
    for(const [key,machine] of Object.entries(phase5MachineResults??{})){
      if(machine?.status==='PASS'||machine?.status==='NOT_APPLICABLE'||machine?.status==='DEFERRED_UNVERIFIED')continue;
      let cli=null;
      try{cli=JSON.parse(String(machine?.stdout??''));}catch{}
      const failed=(machine?.rawResult?.failedSteps??[]).slice(0,3).map(x=>({
        component:x?.component??x?.name??x?.step??null,
        kind:x?.kind??x?.failureKind??null,
        error:String(x?.error??x?.message??'').slice(0,450)
      }));
      const cause={
        candidate:key,status:machine?.status,exitCode:machine?.exitCode,
        disposition:machine?.rawResult?.disposition??cli?.disposition??null,
        runnerError:machine?.rawResult?.error??cli?.error??null,
        preflight:machine?.rawResult?.preflight?.failureKind??null,
        build:machine?.rawResult?.build?.status??null,
        nativeFuzz:machine?.rawResult?.analysis?.nativeFuzz?{
          status:machine.rawResult.analysis.nativeFuzz.componentStatus,
          failureKind:machine.rawResult.analysis.nativeFuzz.failureKind??null,
          exitCode:machine.rawResult.analysis.nativeFuzz.rawOutput?.exitCode??null,
          outputTail:String(machine.rawResult.analysis.nativeFuzz.rawOutput?.stdout??'').slice(-3000),
          errorTail:String(machine.rawResult.analysis.nativeFuzz.rawOutput?.stderr??'').slice(-1800)
        }:null,
        failedSteps:failed,
        stderrTail:String(machine?.stderr??'').slice(-1500)
      };
      deficiencies.push('Phase 5 machine diagnostic: '+JSON.stringify(cause));
    }
  }catch(e){
    deficiencies.push('Phase 5 mandatory machine execution failed: '+String(e.message||e));
  }
  const matrixRel=path.posix.join(campaignPath,'work/phase-06/LITE_TARGETED_TEST_MATRIX.md');
  // No Phase-0 fuzz/telemetry is imported as target evidence.
  const baselineRows=[];
  fs.mkdirSync(path.dirname(repoFile(root,matrixRel)),{recursive:true});
  fs.writeFileSync(repoFile(root,matrixRel),renderTargetedTestMatrixV1({
    targetDesigns,executionResults:phase5MachineResults??{},baselineRows
  }));
  if(deficiencies.length){
    // Evidence and diagnostic matrix may persist; receipt and graph cannot.
    persistReviewerReworkShardsV1();
    packet.status='REWORK_REQUIRED';
    packet.controllerValidation={status:'FAIL',machineExecutionGate:'BLOCKED',validatedAt:now,deficiencies};
    directory.currentAssignment.status='REWORK_REQUIRED';directory.campaignStatus='ACTIVE';directory.updatedAt=now;
    writeJson(packetFile,packet);writeJson(directoryFile,directory);
    const shardGuidance=annotateShardReworkV1(packet,deficiencies);
    writeJson(packetFile,packet);
    const feedback=['Phase 5 execution gate BLOCKED: no receipt, PASS or handoff was issued.',
      'Repair the exact runner, harness or machine-evidence defect, then invoke the same phase controller again.',
      ...deficiencies.map(x=>'- '+x),
      'Machine failure is not a vulnerability finding.'].join('\n')+shardGuidance;
    process.stdout.write(JSON.stringify({authorityLinkRoot,status:'NEEDS_REWORK',campaignId:directory.campaignId,
      campaignName:directory.campaignName,phaseSequence:sequence,phaseId:'phase-5',
      reviewer:assignment.reviewer,feedbackText:feedback,
      feedbackB64:Buffer.from(feedback).toString('base64'),
      packetPath:assignment.packetPath,directoryPath:directoryRel})+'\n');
    process.exit(0);
  }
}
const canonicalRel=path.posix.join(campaignPath,'derived/phase-'+sequence,'PHASE_'+phaseNum(sequence)+'_CANONICAL_DATA_v1.json');
const canonical={
  schemaVersion:'curveyield-lite-phase-canonical-data-v1',
  phase:sequence,
  campaignId:directory.campaignId,
  workSchemaPath:assignment.workSchemaPath,
  workFormPath:assignment.workFormPath,
  finalReportPath:assignment.finalReportPath,
  actions:structuredClone(form.actions),
  automationInputs:structuredClone(form.automationInputs??{}),
  automationOutputs:{},
  generatedAt:now
};
if(sequence===4) canonical.automationOutputs.phase4Coverage=
  Object.hasOwn(form?.automationInputs??{},'expectedDiscoveryRecordKeys')
    ? phase4DiscoveryCoverageV1({summary:(()=>{const rel=path.posix.join(campaignPath,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json');return fs.existsSync(repoFile(root,rel))?readJson(repoFile(root,rel)):null;})()})
    : phase4CoverageFromForm(form);
if(sequence===5) canonical.automationOutputs.phase5MachineExecutionGate={
  status:phase5OwnerDeferral?'DEFERRED_UNVERIFIED':'PASS',
  targetKeys:Object.keys(phase5MachineResults??{}).sort(),
  evidenceRefs:Object.values(phase5MachineResults??{}).map(x=>x.evidenceRef).filter(x=>x&&x!=='NO_MACHINE_EVIDENCE'),
  ...(phase5OwnerDeferral?{ownerDirectivePath:phase5OwnerDeferral.path,
    securityConclusion:'UNVERIFIED',unresolvedCandidateKeys:phase5OwnerDeferral.candidateKeys}:{}),
};
// Explicit evidence continuity: previously supported conditional behaviors
// survive an owner-deferred Phase-5/6 execution without becoming machine PASS.
if(sequence===6){
  const sealedPhase5=canonicalFor(root,campaignPath,5);
  canonical.automationOutputs.candidateEvidenceContinuity=
    buildCandidateEvidenceContinuityV1({phase5:sealedPhase5,phase6:canonical});
}
if(sequence===8||sequence===10){
  const sealedPhase6=canonicalFor(root,campaignPath,6);
  const lineage=sealedPhase6?.automationOutputs?.candidateEvidenceContinuity;
  if(Array.isArray(lineage)&&lineage.length)
    canonical.automationOutputs.candidateEvidenceContinuity=structuredClone(lineage);
}
if(sequence===8){
  canonical.actions['step-2'].outputs.validatedFindings=materializeValidatedFindings(canonical.actions?.['step-2']?.outputs?.candidateValidations??[]);
  canonical.automationOutputs.validatedFindingsMaterialized=true;
}
if(sequence===10){
  const unresolved=unresolvedFinalCandidateFailures({root,campaignPath,directory});
  if(unresolved.length)throw new Error('Lite-Solo cannot COMPLETE with unresolved material candidates: '+unresolved.join('; '));
  const p6=canonicalFor(root,campaignPath,6);
  const ledger=maybeJson(root,path.posix.join(campaignPath,'controller/CARRIED_FORWARD_OBLIGATION_LEDGER_v1.json'))??{};
  const open=finalIndexObligations(ledger);
  const carriedLimitations=collectCarriedLimitations({root,campaignPath,maxPhase:9});
  const omissions=phaseOutput(p6,'step-3','fullOnlyOmissions')??[];
  canonical.automationOutputs.residualLimitations=[
    ...carriedLimitations,
    ...open.map(o=>[o.obligationId,o.statusReason,o.requiredAction].filter(Boolean).join(' | ')).filter(Boolean)
  ];
  if(!canonical.automationOutputs.residualLimitations.length) canonical.automationOutputs.residualLimitations=['NONE_IDENTIFIED'];
  canonical.automationOutputs.unresolvedSubstantiveQuestions=open.length?open.map(o=>o.obligationId??o.statusReason??'OPEN_OBLIGATION'):['NONE_IDENTIFIED'];
  canonical.automationOutputs.fullUpgradeRecommendations=omissions.length&&!(omissions.length===1&&omissions[0]==='NONE_IDENTIFIED')
    ? omissions.map(x=>'Execute Full-path delta for omitted Lite work: '+x)
    : ['NONE_IDENTIFIED'];
}

let reportText='';
if(schema.finalReport){
  reportText=renderControllerPhaseReport({schema,form,canonical});
  writeText(repoFile(root,assignment.finalReportPath),reportText);
  deficiencies.push(...validateFinalReport(schema,reportText));
}
if(deficiencies.length) throw new Error('controller-generated report validation failed: '+deficiencies.join('; '));

packet.controllerValidation={status:'PASS',validatedAt:now,deficiencies:[],controllerPassToken:'CONTROLLER_PHASE_PASS',
  ...(sequence===5?{
    machineExecutionGate:phase5OwnerDeferral?'DEFERRED_UNVERIFIED':'PASS',
    machineEvidenceRefs:Object.values(phase5MachineResults??{}).map(x=>x.evidenceRef).filter(x=>x&&x!=='NO_MACHINE_EVIDENCE'),
    ...(phase5OwnerDeferral?{ownerEvidenceDeferralPath:phase5OwnerDeferral.path,
      unresolvedCandidateKeys:phase5OwnerDeferral.candidateKeys,
      securityConclusion:'UNVERIFIED'}:{})
  }:{})
};
const controls=syncControls({root,campaignPath,schema,canonical,canonicalRel,now,authorityRoot,replacePhase:Boolean(masterAmendmentRefreshSha)});
if(sealedRework){
  const invalid=readJson(requiredFile(root,controls.invalidRel,'evidence invalidation matrix'));
  const events=invalid.events??(invalid.events=[]);
  if(events.some(x=>x?.eventId==='INV-P1-REWORK-002'||x?.id==='INV-P1-REWORK-002'))throw new Error('INV-P1-REWORK-002 already exists');
  events.push({eventId:'INV-P1-REWORK-002',ruleId:'EIM-013',status:'RESOLVED_BY_PHASE_1_REVISION_3',priorState:'SEALED_REVISION_2',fromRevision:2,toRevision:3,sourceSha256:directory.sourceSha256,scopeId:sealedRework.request.humanAuthorization.scopeId,authorizationRecordPath:sealedRework.request.humanAuthorization.recordPath,qualityReviewPath:sealedRework.request.qualityReview.path,resolutionReceiptPath:'PENDING_PHASE_1_REVISION_3_RECEIPT',resolvedAt:now});
  writeJson(repoFile(root,controls.invalidRel),invalid);
}
writeJson(repoFile(root,canonicalRel),canonical);
const derivedRels=buildDerivedOutputs({root,campaignPath,schema,canonicalData:canonical,canonicalRel,now});
const boundaryArtifactRels=[];
let successorPrefillContext={};
if(sequence===5){
  const targetDesigns=phaseOutput(canonical,'step-3','targetDesigns')??[];
  // Never embed the full V7 machine result (often >100 MB) inside the
  // directory entry or successor prefill. Phase 6 and master-review gates
  // independently reload and SHA-256 verify the complete persisted evidence.
  const compactMachineResults=Object.fromEntries(
    Object.entries(phase5MachineResults??{}).map(([key,result])=>[key,{
      status:result?.status??'MISSING',
      exitCode:result?.exitCode??null,
      evidenceRef:result?.evidenceRef??null,
      requestBindingStatus:result?.requestBindingStatus??null,
      requestBindingEvidenceRef:result?.requestBindingEvidenceRef??null,
      requestBindingReasons:result?.requestBindingReasons??[],
      rawResult:null,
      stdout:String(result?.stdout??'').slice(-900),
      stderr:String(result?.stderr??'').slice(-900)
    }])
  );
  successorPrefillContext={targetDesigns,phase5ExecutionResults:compactMachineResults};
  boundaryArtifactRels.push(path.posix.join(campaignPath,'work/phase-06/LITE_TARGETED_TEST_MATRIX.md'));
}
if(sequence===8&&hasRemediation(campaignRoot)){
  const validatedFindings=phaseOutput(canonical,'step-2','validatedFindings')??[];
  const deltaRows=remediationDeltaRows(campaignRoot,validatedFindings);
  successorPrefillContext={...successorPrefillContext,remediationDeltaRows:deltaRows};
  const ledgerRel=path.posix.join(campaignPath,'work/phase-09/PHASE9_REMEDIATION_DELTA_LEDGER.md');
  fs.mkdirSync(path.dirname(repoFile(root,ledgerRel)),{recursive:true});
  fs.writeFileSync(repoFile(root,ledgerRel),renderRemediationDeltaLedgerV1({validatedFindings,deltaRows,noRemediation:false}));
  boundaryArtifactRels.push(ledgerRel);
}
if(sequence===8&&!hasRemediation(campaignRoot)){
  const indexRel=path.posix.join(campaignPath,'work/phase-10/LITE_FINAL_EVIDENCE_INDEX.md');
  fs.mkdirSync(path.dirname(repoFile(root,indexRel)),{recursive:true});
  fs.writeFileSync(repoFile(root,indexRel),(activeDetectionPolicyV1(predecessor)?appendAdrCoverageSectionV1({root,campaignPath,automationRoot:process.cwd(),text:renderFinalEvidenceIndexV1(buildFinalIndexInput({root,campaignPath,directory,predecessor}))}):renderFinalEvidenceIndexV1(buildFinalIndexInput({root,campaignPath,directory,predecessor}))));
  boundaryArtifactRels.push(indexRel);
}
if(sequence===9){
  const p8=canonicalFor(root,campaignPath,8);
  const validatedFindings=phaseOutput(p8,'step-2','validatedFindings')??[];
  const ledgerRel=path.posix.join(campaignPath,'work/phase-09/PHASE9_REMEDIATION_DELTA_LEDGER.md');
  const finalizedRows=finalizeRemediationDeltaRows(remediationDeltaRows(campaignRoot,validatedFindings),canonical);
  fs.mkdirSync(path.dirname(repoFile(root,ledgerRel)),{recursive:true});
  fs.writeFileSync(repoFile(root,ledgerRel),renderRemediationDeltaLedgerV1({validatedFindings,deltaRows:finalizedRows,noRemediation:false}));
  boundaryArtifactRels.push(ledgerRel);

  const indexRel=path.posix.join(campaignPath,'work/phase-10/LITE_FINAL_EVIDENCE_INDEX.md');
  fs.mkdirSync(path.dirname(repoFile(root,indexRel)),{recursive:true});
  fs.writeFileSync(repoFile(root,indexRel),(activeDetectionPolicyV1(predecessor)?appendAdrCoverageSectionV1({root,campaignPath,automationRoot:process.cwd(),text:renderFinalEvidenceIndexV1(buildFinalIndexInput({root,campaignPath,directory,predecessor}))}):renderFinalEvidenceIndexV1(buildFinalIndexInput({root,campaignPath,directory,predecessor}))));
  boundaryArtifactRels.push(indexRel);
}

const receiptLibUrl=pathToFileURL(repoFile(root,'packages/controller-core/src/lite-phase-receipt-v1.mjs')).href;
const receiptLib=await import(receiptLibUrl);
const phaseRevision=Number(assignment.phaseRevision??1);
if(!Number.isInteger(phaseRevision)||phaseRevision<1) throw new Error('assignment.phaseRevision must be an integer >= 1 when present');
const receiptRel=receiptLib.phaseReceiptPath(campaignPath,sequence,phaseRevision);
const evidence=[receiptRef(root,campaignPath,assignment.workFormPath,'PHASE_WORK_FORM')];
if(sealedRework){
  evidence.push(receiptRef(root,campaignPath,sealedRework.request.priorReceipt.path,'PRIOR_PHASE_REVISION'));
  evidence.push(receiptRef(root,campaignPath,sealedRework.request.qualityReview.path,'HUMAN_QUALITY_REVIEW'));
  evidence.push(receiptRef(root,campaignPath,sealedRework.request.humanAuthorization.recordPath,'HUMAN_REWORK_AUTHORIZATION'));
}
if(assignment.finalReportPath) evidence.push(receiptRef(root,campaignPath,assignment.finalReportPath,'PHASE_FINAL_REPORT'));
evidence.push(receiptRef(root,campaignPath,canonicalRel,'PHASE_CANONICAL_DATA'));
for(const rel of derivedRels) evidence.push(receiptRef(root,campaignPath,rel,'DERIVED_DOWNSTREAM_DATA'));
for(const rel of boundaryArtifactRels) evidence.push(receiptRef(root,campaignPath,rel,'BOUNDARY_MACHINE_ARTIFACT'));
if(sequence===5){
  if(phase5OwnerDeferral)evidence.push(receiptRef(root,campaignPath,phase5OwnerDeferral.path,'OWNER_EVIDENCE_DEFERRAL_UNVERIFIED'));
  for(const result of Object.values(phase5MachineResults??{})){
    if(result.status==='PASS')evidence.push(receiptRef(root,campaignPath,result.evidenceRef,'PHASE5_BOUNDARY_RAW_RESULT'));
  }
}

let nextSequence=sequence===10?null:sequence+1;
let fresh=false;let nextAssignment=null;let nextDerivedInputs=[];
let discoveryStarted=false;
let handoff={required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:nextSequence,sameReviewer:true,status:'NOT_APPLICABLE'};
if(sequence===6)nextSequence=8;
if(sequence===8)nextSequence=hasRemediation(campaignRoot)?9:10;
if(sequence===9)nextSequence=10;
handoff={required:false,boundary:null,incomingReviewer:null,assignedWork:null,
  nextPhaseSequence:nextSequence,sameReviewer:nextSequence!==null,status:'NOT_APPLICABLE'};

if(nextSequence!==null) nextDerivedInputs=resolveInputsForTarget({root,campaignPath,target:nextSequence,immediate:[...derivedRels,...boundaryArtifactRels]});

const ledgerAfter=maybeJson(root,controls.ledgerRel)??{};
const receipt=receiptLib.createLitePhaseReceiptV1({
  campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,campaignName:directory.campaignName,
  workspacePath:campaignPath,campaignDirectoryEntryPath:directoryRel,sequence,revision:phaseRevision,executorType:'AI_REVIEWER',executorLineage:assignment.reviewer,
  authority:predecessor.authority,sourceSha256:directory.sourceSha256,source:predecessor.source,status:sequence===10&&!gatedMasterReview&&!masterAmendmentRefreshSha?'COMPLETE':'SEALED',
  inputs:[{role:'PREDECESSOR_RECEIPT',path:assignment.predecessorReceiptPath},{role:'CONTROLLER_GENERATED_PHASE_WORK_PACKET',path:assignment.packetPath}],
  evidence,outputs:evidence,
  globalControls:{securityTraceabilityGraph:path.posix.relative(campaignPath,controls.graphRel),carriedForwardObligationLedger:path.posix.relative(campaignPath,controls.ledgerRel),evidenceInvalidationMatrix:path.posix.relative(campaignPath,controls.invalidRel),sourceIntelligenceBundle:predecessor.globalControls?.sourceIntelligenceBundle??null},
  obligations:receiptObligationSummary({ledger:ledgerAfter,canonical,form,sequence,now}),
  validation:{status:'PASS',validatedAt:now,failures:[]},handoff,now
});
if(sequence===5&&phase5OwnerDeferral)receipt.machineExecutionDisclaimer={
  status:'DEFERRED_UNVERIFIED',securityConclusion:'UNVERIFIED',
  ownerDirectivePath:phase5OwnerDeferral.path,
  unresolvedCandidateKeys:phase5OwnerDeferral.candidateKeys,
  notAMachinePass:true,finalAuditSecurityAssurance:'INCOMPLETE'
};
receipt.sealedAt=now;receipt.updatedAt=now;
if(masterAmendmentRefreshSha)receipt.masterAmendment=masterAmendmentReceipt(phaseRevision-1);
if(sealedRework){
  receipt.rework={schemaVersion:'curveyield-lite-sealed-phase-rework-v1',fromRevision:2,toRevision:3,scopeId:sealedRework.request.humanAuthorization.scopeId,requestPath:a['rework-request-path'],qualityReviewPath:sealedRework.request.qualityReview.path,evidenceInvalidationEvent:'INV-P1-REWORK-002',evidenceInvalidationRule:'EIM-013',successorDeliveryHeld:true};
  const invalid=readJson(requiredFile(root,controls.invalidRel,'evidence invalidation matrix'));
  const events=invalid.events??invalid.invalidationEvents??[];
  const event=events.find(x=>x?.eventId==='INV-P1-REWORK-002'||x?.id==='INV-P1-REWORK-002');
  if(event)event.resolutionReceiptPath=receiptRel;
  writeJson(repoFile(root,controls.invalidRel),invalid);
}
writeJson(repoFile(root,receiptRel),receipt);
packet.status='ACCEPTED';packet.controllerValidation.receiptPath=receiptRel;packet.controllerValidation.canonicalDataPath=canonicalRel;packet.controllerValidation.derivedOutputPaths=derivedRels;packet.controllerValidation.boundaryMachineArtifactPaths=boundaryArtifactRels;
writeJson(packetFile,packet);

let sealedReceiptRel=receiptRel;
if(sequence===6&&!isReassignedV13AuthorityV1({root,authorityRoot})){
  const loaded7=loadPhaseSchema(root,authorityRoot,7);const schema7=loaded7.schema;
  const form7Rel=path.posix.join(campaignPath,schema7.workForm.campaignPath);const form7=readJson(requiredFile(root,path.posix.join(authorityRoot,schema7.workForm.template),'Phase-7 automation form template'));
  form7.actions['step-1'].outputs={predecessorPhase6Receipt:receiptRel,phase6DerivedInput:derivedRels[0]??'NONE_IDENTIFIED',markerDisposition:'SEALED_AUTOMATIC_MARKER',successorPhase:'8',successorReviewer:'lite-solo-agent'};
  form7.automationInputs={predecessorReceiptPath:receiptRel,derivedInputPaths:derivedRels};
  writeJson(repoFile(root,form7Rel),form7);
  const canonical7Rel=path.posix.join(campaignPath,'derived/phase-7/PHASE_07_CANONICAL_DATA_v1.json');
  const canonical7={schemaVersion:'curveyield-lite-phase-canonical-data-v1',phase:7,campaignId:directory.campaignId,workSchemaPath:loaded7.rel,workFormPath:form7Rel,finalReportPath:null,actions:form7.actions,generatedAt:now};
  writeJson(repoFile(root,canonical7Rel),canonical7);
  const derived7=buildDerivedOutputs({root,campaignPath,schema:schema7,canonicalData:canonical7,canonicalRel:canonical7Rel,now});
  const markerRevision=masterAmendmentRefreshSha?phaseRevision:1;
  const markerRel=receiptLib.phaseReceiptPath(campaignPath,7,markerRevision);
  const markerEvidence=[receiptRef(root,campaignPath,form7Rel,'AUTOMATIC_PHASE7_WORK_FORM'),receiptRef(root,campaignPath,canonical7Rel,'AUTOMATIC_PHASE7_CANONICAL_DATA'),...derived7.map(x=>receiptRef(root,campaignPath,x,'DERIVED_DOWNSTREAM_DATA'))];
  const markerHandoff={required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:8,sameReviewer:true,status:'NOT_APPLICABLE'};
  const marker=receiptLib.createLitePhaseReceiptV1({campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,campaignName:directory.campaignName,workspacePath:campaignPath,campaignDirectoryEntryPath:directoryRel,sequence:7,executorType:'GITHUB_ACTIONS',executorLineage:'phase7-automation',revision:markerRevision,authority:predecessor.authority,sourceSha256:directory.sourceSha256,source:predecessor.source,status:'SEALED',inputs:[{role:'PREDECESSOR_RECEIPT',path:receiptRel}],evidence:markerEvidence,outputs:markerEvidence,globalControls:receipt.globalControls,validation:{status:'PASS',validatedAt:now,failures:[]},handoff:markerHandoff,now});
  marker.sealedAt=now;writeJson(repoFile(root,markerRel),marker);sealedReceiptRel=markerRel;fresh=false;nextSequence=8;nextDerivedInputs=resolveInputsForTarget({root,campaignPath,target:8,immediate:[...derivedRels,...derived7,...boundaryArtifactRels]});
}
if(sequence===8&&nextSequence===10){
  const skippedRevision=masterAmendmentRefreshSha?phaseRevision:1;
  const skippedRel=receiptLib.phaseReceiptPath(campaignPath,9,skippedRevision);
  const skipped=receiptLib.createLitePhaseReceiptV1({campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,campaignName:directory.campaignName,workspacePath:campaignPath,campaignDirectoryEntryPath:directoryRel,sequence:9,revision:skippedRevision,executorType:'GITHUB_ACTIONS',executorLineage:'phase9-skip-automation',authority:predecessor.authority,sourceSha256:directory.sourceSha256,source:predecessor.source,status:'SKIPPED',inputs:[{role:'PREDECESSOR_RECEIPT',path:receiptRel}],outputs:[],automation:[{action:'SKIPPED_NO_REMEDIATION',status:'PASS',recordedAt:now}],globalControls:receipt.globalControls,validation:{status:'NOT_APPLICABLE',validatedAt:now,failures:[]},handoff:{required:false,boundary:null,incomingReviewer:null,assignedWork:null,nextPhaseSequence:10,sameReviewer:true,status:'NOT_APPLICABLE'},now});
  skipped.sealedAt=now;if(masterAmendmentRefreshSha)skipped.masterAmendment=masterAmendmentReceipt(skippedRevision-1);writeJson(repoFile(root,skippedRel),skipped);sealedReceiptRel=skippedRel;
}
directory.lastSealedReceiptPath=sealedReceiptRel;
if(sequence===10){
  directory.campaignStatus=masterAmendmentRefreshSha?'MASTER_AMENDMENT_REFRESH':'COMPLETE';
  directory.currentAssignment=null;directory.updatedAt=now;
}
else{
  const nextReviewer=assignmentReviewer(nextSequence,authorityRoot,root);
  const nextStatus='ACTIVE';
  // Master-amended Phase 3 must not pre-create Phase-4 work before the
  // accepted-master transaction initializes the single discovery assignment.
  const postMasterDiscovery=Boolean(sequence===3&&masterAmendmentRefreshSha&&
    isReassignedV13AuthorityV1({root,authorityRoot})&&activeDetectionPolicyV1(predecessor));
  nextAssignment=((sequence===6&&isReassignedV13AuthorityV1({root,authorityRoot})&&masterAmendmentRefreshSha)||postMasterDiscovery)
 ?null
 :preparePhaseWork({root,campaignPath,authorityRoot,sequence:nextSequence,reviewer:nextReviewer,predecessorReceiptPath:sealedReceiptRel,derivedInputPaths:nextDerivedInputs,status:nextStatus,prefillContext:successorPrefillContext});
  if(sequence===3&&authorityRoot!=='Audit Skill - Lite-Solo Authority/lite-solo-v4'&&!isReassignedV13AuthorityV1({root,authorityRoot})&&!masterAmendmentRefreshSha&&activeDetectionPolicyV1(predecessor)){
    const started=startDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot:process.cwd(),
      now,auditControllerRef:a['audit-controller-ref']??'main'});
    directory.discovery={statePath:started.statePath,status:started.completeImmediately?'COMPLETE':'RUNNING',
      activeUnitId:started.state.payload.activeUnitId,
      activeUnitIds:started.state.payload.order.filter(id=>started.state.payload.units[id]?.status==='ACTIVE')};
    discoveryStarted=true;
    if(started.completeImmediately){
      const finished=completeDiscoveryV1({root,campaignPath,directory,authorityRoot,automationRoot:process.cwd(),
        state:started.state,now});
      nextAssignment=preparePhaseWork({root,campaignPath,authorityRoot,sequence:4,reviewer:'lite-solo-agent',
        predecessorReceiptPath:sealedReceiptRel,derivedInputPaths:[
          ...nextDerivedInputs,path.posix.join(campaignPath,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json')],
        status:'ACTIVE'});
      directory.discovery.status='COMPLETE';directory.discovery.activeUnitId=null;directory.discovery.activeUnitIds=[];
    }else{
      nextAssignment.status='WAITING_FOR_DISCOVERY';
    }
  }
  directory.currentAssignment=nextAssignment;directory.campaignStatus=discoveryStarted?(directory.discovery.status==='COMPLETE'?'ACTIVE':'WAITING_FOR_DISCOVERY'):'ACTIVE';directory.updatedAt=now;
  // Enter each v4 parallel phase with a frozen, full deterministic unit plan.
  // No single initial worker or claim bottleneck; Phase 4 first exposes F/R only.
  if(directory.authorityRelease==='lite-solo-v4'&&nextAssignment&&[4,5,6].includes(nextAssignment.phaseSequence)){
    createUnitPlanV1({root,campaignPath,directory,phase:nextAssignment.phaseSequence,automationRoot:process.cwd()});
  }
}
writeJson(directoryFile,directory);
const feedback='CONTROLLER_PHASE_PASS: Phase '+sequence+' validated and sealed.'+(nextAssignment?' Next authorized assignment: Phase '+nextAssignment.phaseSequence+' / '+nextAssignment.reviewer+'.':' Campaign complete.');
process.stdout.write(JSON.stringify({authorityLinkRoot,status:'PASS',controllerPassToken:'CONTROLLER_PHASE_PASS',sealedRework:Boolean(sealedRework),masterAmendmentRefresh:Boolean(masterAmendmentRefreshSha),campaignId:directory.campaignId,campaignName:directory.campaignName,phaseSequence:sequence,receiptPath:receiptRel,lastSealedReceiptPath:directory.lastSealedReceiptPath,freshSuccessorRequired:false,sameReviewerAdvanced:!discoveryStarted&&Boolean(nextAssignment&&nextAssignment.status==='ACTIVE'),discoveryStarted,activeDiscoveryUnitIds:directory.discovery?.activeUnitIds??[],nextAssignment,feedbackText:feedback,feedbackB64:Buffer.from(feedback).toString('base64'),directoryPath:directoryRel})+'\n');
