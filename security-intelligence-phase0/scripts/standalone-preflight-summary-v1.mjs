#!/usr/bin/env node
// Standalone CurveYield Security Intelligence Phase 0 reader-facing summary.
// Full compiler, source-review and Slither evidence remain separate raw artifacts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const output=process.argv[2]||'/output';
const requestFile=process.argv[3]||'/input/request.json';
const read=name=>{try{return JSON.parse(fs.readFileSync(path.join(output,name),'utf8'));}catch{return null;}};
const safeRead=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const request=safeRead(requestFile);
const build=read('BUILD_AND_SOURCE_IDENTITY_v1.json');
const si=read('SOURCE_INTELLIGENCE_AUTOMATED_v1.json');
const inventory=read('REVIEW_INVENTORY_v1.json');
const slither=read('SLITHER_v1.json');
const readiness=read('PROJECT_READINESS_AUTOMATED_v1.json');
const sbom=read('SBOM_v1.json');
const admission=read('SOURCE_ADMISSION_INVENTORY_v1.json');
const source=request?.source??{};
const expected=source.archiveSha256??null;
const observed=build?.source?.archiveSha256Observed??null;
const sourceMatched=!!expected&&!!observed&&expected===observed;
const outputNames=fs.existsSync(output)?fs.readdirSync(output).filter(x=>x.endsWith('.json')&&x!=='PREFLIGHT_MANIFEST_v1.json').sort():[];
const evidence=outputNames.map(name=>{const bytes=fs.readFileSync(path.join(output,name));return {name,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};});
const allContracts=si?.contracts??[];
const allFunctions=si?.functions??[];
const stage2=si?.stage2Coverage??null;
const effectiveEntrypoints=si?.effectiveEntrypoints??[];
const materialEntrypoints=effectiveEntrypoints.filter(x=>x.stateChanging===true);
const entrypointById=new Map(effectiveEntrypoints.map(x=>[x.entrypointId,x]));
const triage=si?.staticRecon?.slither?.prioritization??null;
const slitherIndex=si?.staticRecon?.slither?.candidateIndex??[];
const byContract=triage?.byContract??[];
const priorityCounts=triage?.priorityCounts??{};
const mappingCounts=triage?.mappingCounts??{};
const significantContractIds=new Set(stage2?.inScopeDeployableContractIds??[]);
const significantContracts=allContracts.filter(x=>significantContractIds.has(x.contractId)&&x.contractKind==='contract');
const entrypointGroups=new Map();
for(const entry of materialEntrypoints){
  const key=entry.qualifiedContract??entry.contractId;
  const group=entrypointGroups.get(key)??{count:0,inherited:0,unresolved:0,vyper:0};
  group.count++;
  if(entry.implementationOrigin==='INHERITED_IMPLEMENTATION')group.inherited++;
  if(entry.implementationOrigin==='ABI_ONLY_DECLARATION_UNRESOLVED'||entry.implementationOrigin==='AMBIGUOUS_DECLARATIONS')group.unresolved++;
  if(entry.language==='VYPER')group.vyper++;
  entrypointGroups.set(key,group);
}
const sourceUnits=inventory?.payload?.sourceUnits??[];
const inScope=sourceUnits.filter(x=>x.scopeTier==='IN_SCOPE');
const inventoryLimitations=inventory?.payload?.limitations??[];
const languageFallbacks=inScope.filter(x=>x.astStatus==='UNSUPPORTED_LANGUAGE'&&String(x.path??'').endsWith('.vy')&&
  inventoryLimitations.some(l=>l.code==='UNSUPPORTED_LANGUAGE_FILE_FALLBACK'&&l.path===x.path));
const vyperAstStructuralOnly=inScope.filter(x=>x.astStatus==='AVAILABLE_VYPER_AST'&&String(x.path??'').endsWith('.vy')&&
  inventoryLimitations.some(l=>l.code==='VYPER_AST_STRUCTURAL_STATIC_ONLY'&&l.path===x.path));
const unsupportedCoverage=inScope.filter(x=>x.astStatus!=='AVAILABLE'&&!languageFallbacks.includes(x)&&!vyperAstStructuralOnly.includes(x));
const typedInScopeComplete=!!inventory&&inScope.length>0&&unsupportedCoverage.length===0;
const fullySourceSupported=typedInScopeComplete&&inventory?.payload?.complete===true&&
  languageFallbacks.length===0&&vyperAstStructuralOnly.length===0;
const slitherComplete=slither?.componentStatus==='COMPLETED';
const slitherIndexComplete=!!triage&&triage.mappingCounts?.detectorCount===((slither?.detectors??[]).length)&&
  slitherIndex.length===((slither?.detectors??[]).length);
const sourceOnly=sourceMatched&&admission?.sourceArchiveSha256===expected&&
  admission?.status==='SOURCE_FILES_INVENTORIED_NOT_A_COMPILATION'&&
  admission?.sourceCount>0&&build?.build?.status==='UNAVAILABLE'&&
  si?.status==='SOURCE_ONLY_UNCOMPILED';
const multiProjectGap=(admission?.additionalRootsNotYetCompiled??[]).length>0;
const unitRecoveryGap=build?.build?.unitCoverageComplete===false;
const sourceAdmissionVerified=admission?.sourceArchiveSha256===expected&&admission?.sourceCount>0;
const manifestStatus=!sourceMatched||!sourceAdmissionVerified?'INCOMPLETE':
  sourceOnly?'PARTIAL':!si||!typedInScopeComplete?'INCOMPLETE':
  !slitherComplete||!slitherIndexComplete||!fullySourceSupported||multiProjectGap||unitRecoveryGap?'PARTIAL':'COLLECTED';
const slitherEvidence=evidence.find(x=>x.name==='SLITHER_v1.json');
const priorityOrder=['P1_FLOW_LINKED_HIGH_IMPACT','P2_FLOW_OR_HIGH_IMPACT','P3_IN_SCOPE_CONTEXT','P4_DEPENDENCY_OR_UNMAPPED'];
const priorityLines=priorityOrder.map(key=>'- '+key+': '+(priorityCounts[key]??0));
const topObservations=slitherIndex.slice(0,12).map(row=>{
  const anchor=row.sourceAnchors?.find(x=>(x.connectedStateChangingEntrypointIds??[]).length>0) ??
    row.sourceAnchors?.find(x=>x.sourceTier==='IN_SCOPE') ?? row.sourceAnchors?.[0] ?? null;
  const connected=(anchor?.connectedStateChangingEntrypointIds??[]).map(id=>entrypointById.get(id)?.canonicalSignature).filter(Boolean);
  const location=anchor?.findingLocation??anchor?.functionLocation??anchor?.sourcePath??'SOURCE_UNRESOLVED';
  const subject=anchor?.qualifiedContract??anchor?.sourcePath??'CONTRACT_UNRESOLVED';
  const fn=anchor?.functionSignature??'contract-level or unresolved function';
  const routes=connected.length?connected.slice(0,3).join(', ')+(connected.length>3?' ...':''):'no state-changing entrypoint path resolved for this anchor';
  return '- '+(row.stableCandidateId??row.candidateId)+' ['+row.candidateId+'] '+row.priority+' — '+row.check+' ('+(row.impact??'impact unknown')+'/'+(row.confidence??'confidence unknown')+') — '+subject+' :: '+fn+' — '+location+' — entrypoints: '+routes;
});
const contractTriageLines=byContract.slice(0,15).map(group=>{
  const counts=priorityOrder.map((key,index)=>'P'+(index+1)+'='+(group.priorityCounts?.[key]??0)).join(', ');
  const routes=(group.connectedStateChangingEntrypointIds??[]).map(id=>entrypointById.get(id)?.canonicalSignature).filter(Boolean);
  return '- '+group.qualifiedContract+' — '+group.observationCount+' observations ('+counts+'); connected state-changing ABI entrypoints: '+(routes.slice(0,8).join(', ')||'none resolved')+(routes.length>8?' ...':'');
});
const contractLines=significantContracts.map(contract=>{
  const q=contract.qualifiedName;
  const group=entrypointGroups.get(q)??{count:0,inherited:0,unresolved:0,vyper:0};
  return '- '+q+' — '+group.count+' state-changing ABI entries; '+group.inherited+' inherited; '+group.unresolved+' unresolved implementation origins';
});
const entrypointCoverageLines=[
  '- Effective callable ABI entries: '+(stage2?.effectiveAbiCallableCount??'UNAVAILABLE'),
  '- Effective state-changing ABI entries to reconcile: '+(stage2?.stateChangingEffectiveEntrypointCount??'UNAVAILABLE'),
  '- Inherited effective ABI entries: '+(stage2?.inheritedEntrypointCount??'UNAVAILABLE'),
  '- Unresolved state-changing implementation origins: '+(stage2?.unresolvedStateChangingEntrypoints??'UNAVAILABLE'),
  '- Full signatures and implementation locations: SOURCE_INTELLIGENCE_AUTOMATED_v1.json effectiveEntrypoints'
];
const lines=[
  '# CurveYield Security Intelligence — Automated Phase 0 Discovery',
  '',
  '**Evidence status:** '+(manifestStatus==='COLLECTED'?'COLLECTED — source-identified, not security-approved':manifestStatus==='PARTIAL'?'PARTIAL — source-only or analysis limitations explicitly retained':'INCOMPLETE — source identity or evidence coverage insufficient'),
  '**Source repository:** '+(source.repository??'UNKNOWN'),
  '**Source commit:** '+(source.commit??'UNKNOWN'),
  '**Archive path:** '+(source.archivePath??'UNKNOWN'),
  '**Source ZIP SHA-256:** '+(expected??'UNKNOWN'),
  '**Exact source/build match:** '+(sourceMatched?'YES':'NOT ESTABLISHED'),
  '**Audit interpretation:** NONE — machine evidence only; no security verdict',
  '',
  '## Build and source coverage',
  '',
  '- Admitted Solidity/Vyper source files: '+(admission?.sourceCount??'UNAVAILABLE'),
  '- Discovered project roots: '+(admission?.projects?.length??'UNAVAILABLE'),
  '- Additional roots not compiled: '+((admission?.additionalRootsNotYetCompiled??[]).join(', ')||'none'),
  '- Compilation selection: '+(build?.build?.compilationSelection??'UNAVAILABLE'),
  '- Whole-project native compilation: '+(build?.build?.wholeProjectCompileSucceeded===true?'YES':build?.build?.wholeProjectCompileSucceeded===false?'NO — independent units only':'NOT ESTABLISHED'),
  '- Build status: '+(build?.build?.status??'UNAVAILABLE'),
  '- Compilers actually used: '+(build?.build?.compilerVersions?.length?build.build.compilerVersions.join(', '):(build?.build?.compilerVersion??'UNAVAILABLE')),
  '- Compiler artifacts: '+(build?.build?.artifactCount??'UNAVAILABLE'),
  '- Source Intelligence contract records: '+allContracts.length,
  '- Source Intelligence function records: '+allFunctions.length,
  '- Source call relationships: '+(si?.callGraph?.length??'UNAVAILABLE'),
  '- In-scope admitted source units: '+inScope.length,
  '- Review inventory: '+(inventory?.payload?.complete===true?'COMPLETE':'INCOMPLETE'),
  '',
  '## Significant contracts and entrypoint coverage',
  '',
  ...contractLines,
  '',
  ...entrypointCoverageLines,
  '',
  '- Source state declarations: '+(si?.stateDeclarations?.length??stage2?.sourceStateDeclarationCount??'UNAVAILABLE'),
  '- Direct state-effect contexts: '+(si?.stateEffects?.length??stage2?.localStateEffectContextCount??'UNAVAILABLE'),
  '- Compiler-emitted storage-layout declarations: '+(stage2?.compilerLayoutStateDeclarationCount??'UNAVAILABLE'),
  '- Vyper ABI entrypoints: '+(stage2?.vyperEntrypointCount??'UNAVAILABLE'),
  '- Vyper source-only/internal functions: '+(stage2?.vyperSourceOnlyFunctionRecords??'UNAVAILABLE'),
  '',
  '## Slither observations — prioritized by contract and source call path',
  '',
  '- Analyzer status/version: '+(slither?.componentStatus??slither?.status??'UNAVAILABLE')+' / '+(slither?.version??'UNKNOWN'),
  '- Raw detector count: '+(slither?.detectors?.length??'UNAVAILABLE'),
  '- Prioritized index: '+(slitherIndexComplete?'PRESENT — detector count reconciled':'MISSING OR INCOMPLETE'),
  '- Source-anchored detectors: '+(mappingCounts.sourceAnchoredDetectorCount??'UNAVAILABLE'),
  '- Contract-mapped detectors: '+(mappingCounts.contractMappedDetectorCount??'UNAVAILABLE'),
  '- Function-mapped detectors: '+(mappingCounts.functionMappedDetectorCount??'UNAVAILABLE'),
  '- Stable content candidate IDs: '+(mappingCounts.stableCandidateIdCount??'UNAVAILABLE'),
  '- Connected to state-changing ABI entrypoint path candidates: '+(mappingCounts.stateChangingFlowConnectedDetectorCount??'UNAVAILABLE'),
  '- Unmapped source detectors: '+(mappingCounts.sourceUnmappedDetectorCount??'UNAVAILABLE'),
  '- Unresolved contract mappings: '+(mappingCounts.contractUnmappedDetectorCount??'UNAVAILABLE'),
  '- Raw SLITHER_v1.json is preserved unchanged; SHA-256: '+(slitherEvidence?.sha256??'UNAVAILABLE'),
  '- Index digest: '+(triage?.indexDigestSha256??'UNAVAILABLE'),
  '',
  '### Priority counts',
  '',
  ...priorityLines,
  '',
  'Priority is a review-navigation order only. High/Critical are Slither labels, not independently adjudicated severity; static call paths are candidates, not runtime reachability proof.',
  '',
  '### Highest-priority observations',
  '',
  ...(topObservations.length?topObservations:['- No Slither observations or no usable prioritized index']),
  '',
  '### Observations by contract',
  '',
  'Per-contract counts use each source anchor’s own priority; one detector spanning multiple contracts can appear in more than one contract group.',
  '',
  ...(contractTriageLines.length?contractTriageLines:['- No contract-grouped Slither observations']),
  '',
  '## Vyper and other evidence limitations',
  '',
  '- Vyper file-level fallback(s): '+(languageFallbacks.map(x=>x.path).join(', ')||'none'),
  '- Vyper compiler-AST structural-only files (no semantic Slither detectors): '+(vyperAstStructuralOnly.map(x=>x.path).join(', ')||'none'),
  '- Unsupported in-scope records without an authorized fallback: '+(unsupportedCoverage.map(x=>x.path).join(', ')||'none'),
  '- Dependency manifest: '+(sbom?'PRESENT':'UNAVAILABLE'),
  '- Deployment/configuration readiness: '+(readiness?'DISCOVERED, NOT EXECUTED':'UNAVAILABLE'),
  '',
  '## How the eleven-round skill must use this evidence',
  '',
  '1. Round 1: reconcile exact source identity, admitted contracts, intended scope and missing build/deployed-state evidence.',
  '2. Round 2: consume effectiveEntrypoints and the full review inventory; assign every material state-changing entrypoint to a semantic F# flow or explicit grounded exclusion.',
  '3. Rounds 3–10: use state declarations/effects, call paths, value/privilege candidates and prioritized Slither observations as leads, never automatic findings.',
  '4. Round 11: independently reconcile the compiler ABI denominator against the actual source-traced entrypoint-to-flow record.',
  '',
  '## Evidence boundaries',
  '',
  '- Slither observations are hypotheses, not confirmed defects; no finding promotion or security verdict is performed.',
  '- Entrypoint links are compiler/source inventory facts; source call paths are structural candidates, not proof of live deployment or runtime reachability.',
  '- No unit tests, fuzzers, exploit reproduction, transaction replay, fork deployment or source-defined deployment scripts were executed.',
  '- Vyper compiler AST provides structural function/state-write/call evidence, not complete Solidity-equivalent read coverage or semantic Slither detectors.',
  '- Unread source, unsupported compilers, unresolved mappings and uncompiled project roots remain explicit limitations.',
  '- Exact live runtime bytecode and deployed configuration are not established by this preflight.',
  '',
  '## Evidence index',
  '',
  ...evidence.map(x=>'- '+x.name+' — SHA-256 '+x.sha256+' ('+x.bytes+' bytes)'),
  ''
];
fs.writeFileSync(path.join(output,'DISCOVERY_SUMMARY_v1.md'),lines.join('\n'));
const manifest={
  schemaVersion:'curveyield-security-preflight-v1',
  status:manifestStatus,
  notSecurityVerdict:true,
  typedInScopeComplete,
  typedVyperFallbackPaths:languageFallbacks.map(x=>x.path),
  typedVyperAstStructuralOnlyPaths:vyperAstStructuralOnly.map(x=>x.path),
  unresolvedSourceCoveragePaths:unsupportedCoverage.map(x=>x.path),
  source:{repository:source.repository??null,commit:source.commit??null,archivePath:source.archivePath??null,expectedSha256:expected,observedSha256:observed},
  buildStatus:build?.build?.status??null,
  slitherStatus:slither?.componentStatus??slither?.status??null,
  reviewInventoryComplete:inventory?.payload?.complete===true,
  stage2Coverage:stage2?{...stage2,limitations:undefined}:null,
  stage3SlitherPrioritization:triage?{
    schemaVersion:triage.schemaVersion,status:triage.status,detectorCount:triage.mappingCounts?.detectorCount??0,
    priorityCounts:triage.priorityCounts,mappingCounts:triage.mappingCounts,
    indexDigestSha256:triage.indexDigestSha256,rawEvidenceRef:'SLITHER_v1.json'
  }:null,
  sourceAdmissionVerified,
  sourceOnly,
  admittedSourceCount:admission?.sourceCount??0,
  additionalProjectRootsNotCompiled:admission?.additionalRootsNotYetCompiled??[],
  unitRecoveryGap,
  files:evidence
};
fs.writeFileSync(path.join(output,'PREFLIGHT_MANIFEST_v1.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({
  status:manifest.status,
  files:evidence.length,
  contracts:allContracts.length,
  functions:allFunctions.length,
  slitherDetectors:slither?.detectors?.length??0,
  slitherIndexComplete
}));
