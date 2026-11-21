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
const source=request?.source??{};
const expected=source.archiveSha256??null;
const observed=build?.source?.archiveSha256Observed??null;
const sourceMatched=expected&&observed&&expected===observed;
const outputNames=fs.existsSync(output)?fs.readdirSync(output).filter(x=>x.endsWith('.json')&&x!=='PREFLIGHT_MANIFEST_v1.json').sort():[];
const evidence=outputNames.map(name=>{const b=fs.readFileSync(path.join(output,name));return {name,sha256:crypto.createHash('sha256').update(b).digest('hex'),bytes:b.length}});
const allContracts=si?.contracts??[];
const allFunctions=si?.functions??[];
const significant=allFunctions.filter(f=>!['view','pure'].includes(f.stateMutability)&&['public','external','PUBLIC_OR_EXTERNAL_ABI'].includes(f.visibility));
const inScope=(inventory?.payload?.sourceUnits??[]).filter(x=>x.scopeTier==='IN_SCOPE');
const languageFallbacks=inScope.filter(x=>x.astStatus==='UNSUPPORTED_LANGUAGE'&&String(x.path??'').endsWith('.vy')&&
  (inventory?.payload?.limitations??[]).some(l=>l.code==='UNSUPPORTED_LANGUAGE_FILE_FALLBACK'&&l.path===x.path));
const unsupportedCoverage=inScope.filter(x=>x.astStatus!=='AVAILABLE'&&!languageFallbacks.includes(x));
const typedInScopeComplete=!!inventory&&inScope.length>0&&unsupportedCoverage.length===0;
const fullySourceSupported=typedInScopeComplete&&inventory?.payload?.complete===true;
const slitherComplete=slither?.componentStatus==='COMPLETED';
const manifestStatus=!sourceMatched||!si||!typedInScopeComplete?'INCOMPLETE':!slitherComplete||!fullySourceSupported?'PARTIAL':'COLLECTED';
const lines=[
  '# CurveYield Security Intelligence — Automated Phase 0 Discovery',
  '',
  '**Evidence status:** '+(manifestStatus==='COLLECTED'?'COLLECTED — source-identified, not security-approved':manifestStatus==='PARTIAL'?'PARTIAL — typed language fallback or static analysis limitations':'INCOMPLETE — source identity or coverage is insufficient'),
  '**Source repository:** '+(source.repository??'UNKNOWN'),
  '**Source commit:** '+(source.commit??'UNKNOWN'),
  '**Archive path:** '+(source.archivePath??'UNKNOWN'),
  '**Source ZIP SHA-256:** '+(expected??'UNKNOWN'),
  '**Exact source/build match:** '+(sourceMatched?'YES':'NOT ESTABLISHED'),
  '**Audit interpretation:** NONE — this is non-semantic machine evidence, not a security verdict',
  '',
  '## Verified build and discovery surface',
  '',
  '- Build status: '+(build?.build?.status??'UNAVAILABLE'),
  '- Compiler: '+(build?.configurationDetection?.compilerVersion??build?.build?.compilerVersion??'UNAVAILABLE'),
  '- Compiler artifacts: '+(build?.build?.artifactCount??'UNAVAILABLE'),
  '- Source Intelligence contracts: '+(si?.contracts?.length??'UNAVAILABLE'),
  '- Compiled ABI functions: '+(si?.functions?.length??'UNAVAILABLE'),
  '- ABI state-changing entrypoints in compiler evidence: '+(significant.length),
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
  '- Unsupported in-scope records without authorized fallback: '+(unsupportedCoverage.map(x=>x.path).join(', ')||'none'),
  '- Dependency manifest: '+(sbom?'PRESENT':'UNAVAILABLE'),
  '- Deployment/configuration readiness: '+(readiness?'DISCOVERED (not executed)':'UNAVAILABLE'),
  '',
  '## Contracts discovered (structural, not semantic)',
  '',
  ...(allContracts.length?allContracts.slice(0,100).map(c=>'- '+String(c.qualifiedName??c.contractId??'UNKNOWN')+' — '+String(c.contractKind??'unknown')+'; '+String(c.sourceLocation??'source location unavailable')):['- No reliable compiler-grounded contract inventory was generated']),
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
  '- The Vyper language fallback preserves source provenance but does not establish Vyper function-level AST coverage.',
  '- Unread source, unsupported compiler configurations and incomplete Slither results remain explicit audit limitations.',
  '- The exact runtime bytecode at live deployment addresses is not established by this preflight.',
  '',
  '## Evidence index',
  '',
  ...evidence.map(e=>'- '+e.name+' — SHA-256 '+e.sha256),
  ''
];
fs.writeFileSync(path.join(output,'DISCOVERY_SUMMARY_v1.md'),lines.join('\n'));
const manifest={schemaVersion:'curveyield-security-preflight-v1',status:manifestStatus,notSecurityVerdict:true,typedInScopeComplete,typedVyperFallbackPaths:languageFallbacks.map(x=>x.path),unresolvedSourceCoveragePaths:unsupportedCoverage.map(x=>x.path),source:{repository:source.repository??null,commit:source.commit??null,archivePath:source.archivePath??null,expectedSha256:expected,observedSha256:observed},buildStatus:build?.build?.status??null,slitherStatus:slither?.componentStatus??slither?.status??null,reviewInventoryComplete:inventory?.payload?.complete===true,files:evidence};
fs.writeFileSync(path.join(output,'PREFLIGHT_MANIFEST_v1.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({status:manifest.status,files:evidence.length,contracts:allContracts.length,functions:allFunctions.length}));
