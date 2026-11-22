#!/usr/bin/env node
// Standalone CurveYield Security Intelligence Phase 0 presentation only.
// The compiler and Slither evidence remain separate, unmodified artifacts.
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
const sourceMatched=expected&&observed&&expected===observed;
const outputNames=fs.existsSync(output)?fs.readdirSync(output).filter(x=>x.endsWith('.json')&&x!=='PREFLIGHT_MANIFEST_v1.json').sort():[];
const evidence=outputNames.map(name=>{const b=fs.readFileSync(path.join(output,name));return {name,sha256:crypto.createHash('sha256').update(b).digest('hex'),bytes:b.length}});
const allContracts=si?.contracts??[];
const allFunctions=si?.functions??[];
const significant=allFunctions.filter(f=>!['view','pure'].includes(f.stateMutability)&&['public','external','PUBLIC_OR_EXTERNAL_ABI'].includes(f.visibility));
const stage2=si?.stage2Coverage??null;
const effectiveEntrypoints=si?.effectiveEntrypoints??[];
const materialEntrypoints=effectiveEntrypoints.filter(e=>e.stateChanging);
const effectiveContracts=[...new Set(materialEntrypoints.map(e=>e.qualifiedContract))].sort();
const effectiveEntrypointLines=effectiveContracts.flatMap(contract=>{
  const rows=materialEntrypoints.filter(e=>e.qualifiedContract===contract);
  return ['### '+contract,'',
    ...rows.map(e=>'- `'+e.canonicalSignature+'` — '+e.implementationOrigin+
      '; source '+(e.sourceLocation??'UNRESOLVED')+
      (e.language==='VYPER'?'; Vyper structural AST only':'')+
      '; ABI compiler unit '+e.compilationUnitId),''];
});

const inScope=(inventory?.payload?.sourceUnits??[]).filter(x=>x.scopeTier==='IN_SCOPE');
const languageFallbacks=inScope.filter(x=>x.astStatus==='UNSUPPORTED_LANGUAGE'&&String(x.path??'').endsWith('.vy')&&
  (inventory?.payload?.limitations??[]).some(l=>l.code==='UNSUPPORTED_LANGUAGE_FILE_FALLBACK'&&l.path===x.path));
const vyperAstStructuralOnly=inScope.filter(x=>x.astStatus==='AVAILABLE_VYPER_AST'&&String(x.path??'').endsWith('.vy')&&
  (inventory?.payload?.limitations??[]).some(l=>l.code==='VYPER_AST_STRUCTURAL_STATIC_ONLY'&&l.path===x.path));
const unsupportedCoverage=inScope.filter(x=>x.astStatus!=='AVAILABLE'&&!languageFallbacks.includes(x)&&!vyperAstStructuralOnly.includes(x));
const typedInScopeComplete=!!inventory&&inScope.length>0&&unsupportedCoverage.length===0;
const fullySourceSupported=typedInScopeComplete&&inventory?.payload?.complete===true&&
  languageFallbacks.length===0&&vyperAstStructuralOnly.length===0;
const slitherComplete=slither?.componentStatus==='COMPLETED';
const sourceOnly=sourceMatched&&admission?.sourceArchiveSha256===expected&&
  admission?.status==='SOURCE_FILES_INVENTORIED_NOT_A_COMPILATION'&&
  admission?.sourceCount>0&&build?.build?.status==='UNAVAILABLE'&&
  si?.status==='SOURCE_ONLY_UNCOMPILED';
const multiProjectGap=(admission?.additionalRootsNotYetCompiled??[]).length>0;
const unitRecoveryGap=build?.build?.unitCoverageComplete===false;
const sourceAdmissionVerified=admission?.sourceArchiveSha256===expected&&admission?.sourceCount>0;
const manifestStatus=!sourceMatched||!sourceAdmissionVerified?'INCOMPLETE':
  sourceOnly?'PARTIAL':!si||!typedInScopeComplete?'INCOMPLETE':
  !slitherComplete||!fullySourceSupported||multiProjectGap||unitRecoveryGap?'PARTIAL':'COLLECTED';
const lines=[
  '# CurveYield Security Intelligence — Automated Phase 0 Discovery',
  '',
  '**Evidence status:** '+(manifestStatus==='COLLECTED'?'COLLECTED — source-identified, not security-approved':manifestStatus==='PARTIAL'?'PARTIAL — source-only or compilation/analysis limitations explicitly retained':'INCOMPLETE — source identity or evidence coverage insufficient'),
  '**Source repository:** '+(source.repository??'UNKNOWN'),
  '**Source commit:** '+(source.commit??'UNKNOWN'),
  '**Archive path:** '+(source.archivePath??'UNKNOWN'),
  '**Source ZIP SHA-256:** '+(expected??'UNKNOWN'),
  '**Exact source/build match:** '+(sourceMatched?'YES':'NOT ESTABLISHED'),
  '**Audit interpretation:** NONE — this is non-semantic machine evidence, not a security verdict',
  '',
  '## Verified build and discovery surface',
  '',
  '- Source admission inventory: '+(sourceAdmissionVerified?'PRESENT AND SOURCE-BOUND':'UNAVAILABLE OR UNMATCHED'),
  '- All admitted Solidity/Vyper source files: '+(admission?.sourceCount??'UNAVAILABLE'),
  '- Discovered potential project roots: '+(admission?.projects?.length??'UNAVAILABLE'),
  '- Additional projects not compiled: '+((admission?.additionalRootsNotYetCompiled??[]).join(', ')||'none'),
  '- Compilation selection: '+(build?.build?.compilationSelection??'UNAVAILABLE'),
  '- Full project native compilation: '+(build?.build?.wholeProjectCompileSucceeded===true?'YES':build?.build?.wholeProjectCompileSucceeded===false?'NO — independent compiler units only':'NOT ESTABLISHED'),
  '- Build status: '+(build?.build?.status??'UNAVAILABLE'),
  '- Compilers actually used: '+(build?.build?.compilerVersions?.length?build.build.compilerVersions.join(', '):(build?.build?.compilerVersion??'UNAVAILABLE')),
  '- Compiler selection basis: '+(build?.configurationDetection?.foundryAutoDetectSolc?'Foundry per-compilation-unit auto-detection':'Project compiler configuration; see exact build identity'),
  '- Compiler artifacts: '+(build?.build?.artifactCount??'UNAVAILABLE'),
  '- Source Intelligence contracts: '+(si?.contracts?.length??'UNAVAILABLE'),
  '- Source Intelligence function records (ABI and internal source functions/modifiers): '+(si?.functions?.length??'UNAVAILABLE'),
  '- Broad public/external state-changing function records (includes dependencies/abstracts): '+(significant.length),
  '- Effective first-party deployable callable ABI entries: '+(stage2?.effectiveAbiCallableCount??'UNAVAILABLE'),
  '- Effective first-party state-changing ABI entries to reconcile: '+(stage2?.stateChangingEffectiveEntrypointCount??'UNAVAILABLE'),
  '- Inherited effective ABI functions: '+(stage2?.inheritedEntrypointCount??'UNAVAILABLE'),
  '- Unresolved state-changing implementation origins: '+(stage2?.unresolvedStateChangingEntrypoints??'UNAVAILABLE'),
  '- Vyper structural call candidates: '+(stage2?.vyperStructuralCallCandidates??'UNAVAILABLE'),
  '- Vyper source-only/internal function records: '+(stage2?.vyperSourceOnlyFunctionRecords??'UNAVAILABLE'),
  '- Vyper compiler-AST module-level state declarations (no inferred slots): '+(stage2?.vyperSourceStateDeclarationCount??'UNAVAILABLE'),
  '- AST-backed state declarations (slots separate): '+(stage2?.sourceStateDeclarationCount??'UNAVAILABLE'),
  '- Compiler-emitted state slots: '+(stage2?.compilerLayoutStateDeclarationCount??'UNAVAILABLE'),
  '- Direct state-read/write contexts: '+(stage2?.localStateEffectContextCount??'UNAVAILABLE'),
  '- Source call relationships: '+(si?.callGraph?.length??'UNAVAILABLE'),
  '- Privilege candidates: '+(si?.privilegeCandidates?.length??'UNAVAILABLE'),
  '- Value-flow candidates: '+(si?.valueFlowCandidates?.length??'UNAVAILABLE'),
  '- External interface candidates: '+(si?.externalInterfaces?.length??'UNAVAILABLE'),
  '- Storage variables: '+(si?.storageLayout?.length??'UNAVAILABLE'),
  '- Slither: '+(slither?.componentStatus??slither?.status??'UNAVAILABLE'),
  '- Review-inventory completeness: '+(inventory?.payload?.complete===true?'COMPLETE':'INCOMPLETE — see typed fallbacks below'),
  '- In-scope Solidity AST and typed fallback coverage: '+(typedInScopeComplete?'RECONCILED':'MISSING SOURCE COVERAGE'),
  '- In-scope source records: '+inScope.length,
  '- Vyper file-level fallback(s): '+(languageFallbacks.map(x=>x.path).join(', ')||'none'),
  '- Vyper compiler AST structural-only coverage (no semantic Slither detectors): '+(vyperAstStructuralOnly.map(x=>x.path).join(', ')||'none'),
  '- Unsupported in-scope records without authorized fallback: '+(unsupportedCoverage.map(x=>x.path).join(', ')||'none'),
  '- Dependency manifest: '+(sbom?'PRESENT':'UNAVAILABLE'),
  '- Deployment/configuration readiness: '+(readiness?'DISCOVERED (not executed)':'UNAVAILABLE'),
  '',
  '## Contracts discovered (structural, not semantic)',
  '',
  ...(allContracts.length?allContracts.slice(0,100).map(c=>'- '+String(c.qualifiedName??c.contractId??'UNKNOWN')+' — '+String(c.contractKind??'unknown')+'; '+String(c.sourceLocation??'source location unavailable')):['- No reliable compiler-grounded contract inventory was generated']),
  '',
  '## Source-anchored effective state-changing ABI entrypoints',
  '',
  'This is the **compiler ABI for in-scope, deployable contracts**, not a direct-declaration count or proof of live reachability. Inheritance and generated getters remain separate from the direct source inventory.',
  '',
  ...(effectiveEntrypointLines.length?effectiveEntrypointLines:['- No compiler-grounded effective entrypoint map available; do not claim Round 2 or Round 11 coverage.','']),
  '## State and storage evidence',
  '',
  '- `stateDeclarations` comes from AST-backed source declarations. `storageLayout` stays compiler-emitted only.',
  '- `stateEffects` provides direct, source-context reads/writes, not transitive or proven reachable economic effects.',
  '- Solidity and Vyper observations have different evidence classes; Vyper state-read completeness is not assumed.',
  '',
    '## How the eleven-round skill must use this evidence',
  '',
  '1. Round 1: Reconcile source digest, admitted contracts, intended scope and missing build or deployed-state evidence.',
  '2. Round 2: Read the full SOURCE_INTELLIGENCE_AUTOMATED_v1.json and REVIEW_INVENTORY_v1.json; trace actual cross-contract flows from source. A call-graph edge is not proof of reachable behavior.',
  '3. Rounds 3–10: Reuse storage, candidate relationships, authority interfaces and Slither observations as leads, never accepted findings.',
  '4. Round 11: Compare the complete compiler ABI/declaration inventory with the actual entrypoint-to-flow coverage in the Security Intelligence Record. Disclose unmapped functions.',
  '',
  '## Evidence limitations',
  '',
  '- No isolated fork deployment or source-defined deployment scripts were executed.',
  '- No fuzz testing, unit tests, exploit reproduction, transaction replay or security verdict was performed.',
  '- The external interface and value-flow indexes are structural candidates; interpretation belongs to the agent.',
  '- Slither limitations: '+(slither?.limitations?.map(x=>typeof x==='string'?x:(x.type??JSON.stringify(x))).join('; ')||'none recorded'),
  '- Vyper compiler AST supplies structural function lines and sensitive-call candidates, not full semantic Slither detectors or complete state-read coverage.',
  '- Unread source, unsupported compiler configurations and incomplete Slither results remain explicit audit limitations.',
  '- Source-only mode may contain source import syntax without ABI, AST, or compiled execution evidence.',
  '- Additional project roots and compilation-unit failures are not claimed to be compiler-reviewed.',
  '- The exact runtime bytecode at live deployment addresses is not established by this preflight.',
  '',
  '## Evidence index',
  '',
  ...evidence.map(e=>'- '+e.name+' — SHA-256 '+e.sha256),
  ''
];
fs.writeFileSync(path.join(output,'DISCOVERY_SUMMARY_v1.md'),lines.join('\n'));
const manifest={schemaVersion:'curveyield-security-preflight-v1',status:manifestStatus,notSecurityVerdict:true,typedInScopeComplete,typedVyperFallbackPaths:languageFallbacks.map(x=>x.path),typedVyperAstStructuralOnlyPaths:vyperAstStructuralOnly.map(x=>x.path),unresolvedSourceCoveragePaths:unsupportedCoverage.map(x=>x.path),source:{repository:source.repository??null,commit:source.commit??null,archivePath:source.archivePath??null,expectedSha256:expected,observedSha256:observed},buildStatus:build?.build?.status??null,slitherStatus:slither?.componentStatus??slither?.status??null,reviewInventoryComplete:inventory?.payload?.complete===true,stage2Coverage:stage2?{...stage2,limitations:undefined}:null,sourceAdmissionVerified,sourceOnly,admittedSourceCount:admission?.sourceCount??0,additionalProjectRootsNotCompiled:admission?.additionalRootsNotYetCompiled??[],unitRecoveryGap,files:evidence};
fs.writeFileSync(path.join(output,'PREFLIGHT_MANIFEST_v1.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:manifest.status,files:evidence.length,contracts:allContracts.length,functions:allFunctions.length}));
