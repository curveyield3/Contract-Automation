#!/usr/bin/env node
// Fresh standalone evidence summary; do not claim success from missing native evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [dir,requestFile]=process.argv.slice(2);
if(!dir||!requestFile)throw Error('usage: standalone-preflight-summary-v1.mjs evidence-dir request-json');
fs.mkdirSync(dir,{recursive:true});
const read=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
const request=read(requestFile),build=read(path.join(dir,'BUILD_AND_SOURCE_IDENTITY_v1.json'));
const source=read(path.join(dir,'SOURCE_INTELLIGENCE_AUTOMATED_v1.json'));
const slither=read(path.join(dir,'SLITHER_v1.json'));
const wake=read(path.join(dir,'WAKE_v1.json'));
const mythril=read(path.join(dir,'MYTHRIL_v1.json'));
const mythrilComplete=mythril?.componentStatus==='COMPLETED' && mythril?.eligibleCount>0 &&
  Array.isArray(mythril?.contractResults) && mythril.contractResults.filter(r=>r.status==='COMPLETED').length===mythril.eligibleCount &&
  mythril.failedCount===0;
const mythrilNotApplicable=mythril?.componentStatus==='NOT_APPLICABLE' && mythril?.eligibleCount===0 &&
  Array.isArray(mythril?.contractResults) && mythril.contractResults.length===mythril.sourceArtifactCount;
const wakeComplete=wake?.componentStatus==='COMPLETED' && wake?.solidityUnitCount>0 &&
  Array.isArray(wake?.unitResults) && wake.unitResults.length===wake.solidityUnitCount &&
  wake.unitResults.every(unit=>unit.status==='COMPLETED');
const wakeNotApplicable=wake?.componentStatus==='NOT_APPLICABLE' && wake?.solidityUnitCount===0;
const wakeUnsupported=wake?.componentStatus==='UNSUPPORTED_COMPILER' &&
  wake?.version==='4.21.0' && wake?.solidityUnitCount>0 &&
  Array.isArray(wake?.unitResults) && wake.unitResults.length===wake.solidityUnitCount &&
  wake.unitResults.every(unit=>unit.status==='UNSUPPORTED_COMPILER' &&
    unit.exitCode===1 && unit.supportedMinimum==='0.6.2' &&
    unit.unsupportedReason==='WAKE_HARD_MIN_SOLC_0.6.2' &&
    /Target configured version\s+\S+\s+is lower than minimum\s+supported version\s+0\.6\.2/.test(unit.stderr??''));
const expected=request?.source?.archiveSha256??null;
const actual=build?.source?.archiveSha256Observed??null;
const sourceMatches=typeof expected==='string'&&expected===actual;
const warnings=[];
const warn=(code,field,ex,obs,fix)=>warnings.push({code,configurationField:field,expected:ex,observed:obs,requiredCorrection:fix});
if(!request)warn('REQUEST_UNAVAILABLE','request.json','valid admitted request','missing or malformed','Restore original admitted request');
if(!build)warn('BUILD_IDENTITY_MISSING','BUILD_AND_SOURCE_IDENTITY_v1.json','original build identity','unavailable','Investigate collector and compiler availability');
if(build&&!sourceMatches)warn('SOURCE_IDENTITY_MISMATCH','build.source.archiveSha256Observed',expected,actual,'Admit same original ZIP SHA');
if(!source)warn('SOURCE_INTELLIGENCE_MISSING','SOURCE_INTELLIGENCE_AUTOMATED_v1.json','compiled source inventory','unavailable','Inspect original compilation or extractor failure');
if(!slither||slither.componentStatus!=='COMPLETED')warn('SLITHER_INCOMPLETE','SLITHER_v1.json.componentStatus','COMPLETED',slither?.componentStatus??'missing','Inspect Slither native evidence and compiler settings');
if(wakeUnsupported)warn('WAKE_UNSUPPORTED_COMPILER','WAKE_v1.json.componentStatus','No Wake coverage for compiler versions below 0.6.2',wake?.componentStatus,'Wake 4.21.0 cannot compile authenticated legacy source; retain explicit coverage limitation');
else if(!wakeComplete&&!wakeNotApplicable)warn('WAKE_INCOMPLETE','WAKE_v1.json.componentStatus','COMPLETED or legitimate zero-Solidity NOT_APPLICABLE',wake?.componentStatus??'missing','Inspect Wake native detections, compiler cache and source unit failures');
if(!mythrilComplete&&!mythrilNotApplicable)warn('MYTHRIL_INCOMPLETE','MYTHRIL_v1.json.componentStatus','COMPLETED or no executable in-scope runtime NOT_APPLICABLE',mythril?.componentStatus??'missing','Inspect Mythril contractResults, pinned bytecode and execution limits');
const nativeReady=sourceMatches&&source&&build?.build?.status==='completed'&&slither?.componentStatus==='COMPLETED'&&
  (wakeComplete||wakeNotApplicable||wakeUnsupported)&&(mythrilComplete||mythrilNotApplicable);
const status=!sourceMatches?'INCOMPLETE':!nativeReady?'PARTIAL':wakeUnsupported?'COLLECTED_WITH_ANALYZER_LIMITATION':'COLLECTED';
// Reviewer-only exact duplicate index. Never modify native findings, infer semantic
// equivalence from text/locations, or feed a reduced stream into automated reproduction.
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
};
const plainObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const nonempty=v=>typeof v==='string'&&v.length>0;
const sha256String=v=>typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v);
const sourceBound=sourceMatches&&sha256String(expected)&&nonempty(request?.requestId)&&
  nonempty(request?.source?.repository)&&nonempty(request?.source?.archivePath)&&
  nonempty(request?.source?.commit)&&build?.requestId===request.requestId&&
  build?.source?.repository===request.source.repository&&build?.source?.archivePath===request.source.archivePath&&
  build?.source?.commit===request.source.commit&&build?.source?.checkoutCommit===request.source.commit&&
  build?.source?.archiveSha256===expected&&build?.build?.status==='completed'&&
  sha256String(build?.build?.buildConfigurationDigestSha256);
const binding=sourceBound?{requestId:request.requestId,repository:request.source.repository,
  commit:request.source.commit,archivePath:request.source.archivePath,archiveSha256Observed:expected,
  buildConfigurationDigestSha256:build.build.buildConfigurationDigestSha256}:null;
const reportPaths={
  slither:path.join(dir,'SLITHER_v1.json'),wake:path.join(dir,'WAKE_v1.json'),
  mythril:path.join(dir,'MYTHRIL_v1.json'),
  semgrep:path.join(path.dirname(dir),'semgrep-review','SEMGREP_v1.json'),
  smtchecker:path.join(path.dirname(dir),'smtchecker-review','SMTCHECKER_v1.json')
};
function sourceReportMatches(report,engine){
  if(!sourceBound||!plainObject(report)||report.backend!==({smtchecker:'solidity-smtchecker'}[engine]??engine)||
    !plainObject(report.reviewSourceIdentity)||canonical(report.reviewSourceIdentity)!==canonical(binding))return false;
  if(engine==='semgrep'||engine==='smtchecker')return report.source?.repository===request.source.repository&&
    report.source?.commit===request.source.commit&&report.source?.archivePath===request.source.archivePath&&report.source?.archiveSha256===expected;
  return report.sourceCommit===request.source.commit;
}
function fullLocation(v){
  return plainObject(v)&&nonempty(v.filename_relative??v.filename_absolute??v.filename_short)&&
    Number.isSafeInteger(v.start)&&v.start>=0&&Number.isSafeInteger(v.length)&&v.length>0;
}
function identityComplete(engine,entry,report){
  if(!plainObject(entry))return false;
  if(engine==='slither')return build?.build?.compilationUnitCount===1&&nonempty(entry.check)&&
    nonempty(entry.id)&&Array.isArray(entry.elements)&&entry.elements.length>0&&
    entry.elements.every(e=>fullLocation(e?.source_mapping));
  if(engine==='wake')return nonempty(entry.detector_name)&&nonempty(entry.unitId)&&
    plainObject(entry.detection?.location)&&Object.keys(entry.detection.location).length>0&&
    Array.isArray(report.unitResults)&&report.unitResults.some(u=>u?.unitId===entry.unitId&&u?.status==='COMPLETED');
  if(engine==='mythril')return nonempty(entry.qualifiedName)&&nonempty(entry.sourceName)&&
    sha256String(entry.runtimeBytecodeSha256)&&nonempty(entry['swc-id']??entry.title)&&
    Number.isSafeInteger(entry.address)&&entry.address>=0&&Array.isArray(report.contractResults)&&
    report.contractResults.some(c=>c?.qualifiedName===entry.qualifiedName&&
      c?.bytecodeDigestSha256===entry.runtimeBytecodeSha256&&c?.status==='COMPLETED');
  if(engine==='semgrep'){
    const name=typeof entry.path==='string'?entry.path.replace(/^\.\//,''):'';
    return nonempty(entry.check_id)&&nonempty(name)&&Number.isSafeInteger(entry.start?.offset)&&
      entry.start.offset>=0&&Number.isSafeInteger(entry.end?.offset)&&entry.end.offset>entry.start.offset&&
      Array.isArray(report.sourceDigests)&&report.sourceDigests.some(x=>x?.sourceName===name&&sha256String(x?.sha256));
  }
  // SMTChecker diagnostics currently omit complete source identity. Equal error
  // codes, diagnostic types and solver names cannot prove equal findings.
  return false;
}
function nativeEntries(engine,report){
  if(engine==='smtchecker'){
    if(!Array.isArray(report?.units)||report.units.some(u=>!Array.isArray(u?.diagnostics)))return null;
    return report.units.flatMap((unit,u)=>unit.diagnostics.map((record,i)=>({
      record,ref:'/units/'+u+'/diagnostics/'+i})));
  }
  const root=engine==='semgrep'?report?.nativeReport?.results:report?.detectors;
  if(!Array.isArray(root)){
    // Semgrep may legitimately have no eligible input and no native results.
    if(engine==='semgrep'&&report?.status==='NOT_APPLICABLE'&&report.findingCount===0&&
      Array.isArray(report.sourceDigests)&&report.sourceDigests.length===0)return [];
    return null;
  }
  return root.map((record,i)=>({record,ref:(engine==='semgrep'?'/nativeReport/results/':'/detectors/')+i}));
}
const dedup={schemaVersion:'curveyield-phase0-review-duplicate-index-v1',
  purpose:'Defensive reviewer presentation only',sourceArchiveSha256:expected,
  sourceAdmissionVerified:sourceMatches,reviewSourceBindingVerified:sourceBound,
  reviewSourceIdentity:binding,notSecurityVerdict:true,
  policy:'SAME_ENGINE_CANONICAL_FULL_RECORD_EQUALITY_WITH_SOURCE_AND_CONTEXT',
  crossEngineAutomaticMerges:0,nativeReportsPreserved:true,engines:[]};
for(const [engine,file] of Object.entries(reportPaths)){
  let raw=null,report=null,readStatus='MISSING';
  try{raw=fs.readFileSync(file);readStatus='MALFORMED';report=JSON.parse(raw.toString('utf8'));
    if(plainObject(report))readStatus='READABLE';
  }catch(error){if(!raw&&error?.code!=='ENOENT')readStatus='READ_ERROR';}
  const items=nativeEntries(engine,report);
  const status=report?.componentStatus??report?.status??null;
  const bound=sourceReportMatches(report,engine);
  const valid=Array.isArray(items);
  const complete=bound&&valid&&status==='COMPLETED'&&
    (engine==='smtchecker'||report.findingCount===items.length);
  const stats={engine,reportFile:path.basename(file),
    reportPath:path.relative(path.dirname(dir),file).split(path.sep).join('/'),reportSha256:raw?digest(raw):null,
    reportReadStatus:readStatus,nativeStatus:status,sourceIdentityVerified:bound,
    nativeRecordCountVerified:complete,recordType:engine==='smtchecker'?'diagnostic':'finding',
    rawRecordCount:valid?items.length:null,reviewRecordCount:valid?items.length:null,
    duplicateCount:0,eligibleRecordCount:0,unmergedIncompleteIdentityCount:0,
    duplicateGroups:[],retainedRefs:valid?items.map(x=>x.ref):null,
    disposition:!valid?'UNAVAILABLE':bound&&status==='NOT_APPLICABLE'&&items.length===0?'NOT_APPLICABLE':
      !complete?'RETAIN_ALL_UNVERIFIED_OR_INCOMPLETE':
      engine==='smtchecker'?'RETAIN_ALL_ABBREVIATED_DIAGNOSTICS':'EXACT_DUPLICATE_REVIEW'};
  if(complete&&engine!=='smtchecker'){
    const seen=new Map();
    for(const {record,ref} of items){
      if(!identityComplete(engine,record,report)){stats.unmergedIncompleteIdentityCount++;continue;}
      stats.eligibleRecordCount++;
      const key=canonical([engine,binding,record]);
      // Use the entire canonical string for equivalence; the digest is only
      // the stable display identifier, not the sole basis for a merge.
      const prior=seen.get(key);
      if(prior){
        prior.duplicateRefs.push(ref);
        stats.duplicateCount++;
      }else seen.set(key,{fingerprint:digest(key),representativeRef:ref,duplicateRefs:[]});
    }
    stats.duplicateGroups=[...seen.values()].filter(g=>g.duplicateRefs.length);
    const mergedRefs=new Set(stats.duplicateGroups.flatMap(g=>g.duplicateRefs));
    stats.retainedRefs=stats.retainedRefs.filter(ref=>!mergedRefs.has(ref));
    stats.reviewRecordCount=stats.retainedRefs.length;
    // Reconcile every record before accepting the presentation reduction.
    if(stats.reviewRecordCount+stats.duplicateCount!==stats.rawRecordCount){
      stats.duplicateGroups=[];stats.duplicateCount=0;
      stats.retainedRefs=items.map(x=>x.ref);stats.reviewRecordCount=items.length;
      stats.disposition='RETAIN_ALL_RECONCILIATION_FAILED';
    }
  }
  dedup.engines.push(stats);
}
const available=dedup.engines.filter(x=>x.recordType==='finding'&&x.rawRecordCount!==null);
dedup.totals={availableFindingReports:available.length,expectedFindingReports:4,
  verifiedFindingReports:available.filter(x=>x.nativeRecordCountVerified).length,
  notApplicableFindingReports:available.filter(x=>x.disposition==='NOT_APPLICABLE').length,
  unverifiedFindingReports:available.filter(x=>!x.nativeRecordCountVerified&&x.disposition!=='NOT_APPLICABLE').length,
  missingFindingReports:4-available.length,
  rawFindingCount:available.reduce((n,x)=>n+x.rawRecordCount,0),
  reviewFindingCount:available.reduce((n,x)=>n+x.reviewRecordCount,0),
  exactDuplicateCount:available.reduce((n,x)=>n+x.duplicateCount,0),
  smtcheckerDiagnosticCount:dedup.engines.find(x=>x.engine==='smtchecker').rawRecordCount,
  smtcheckerDiagnosticsConsolidated:0};
fs.writeFileSync(path.join(dir,'REVIEW_DUPLICATE_INDEX_v1.json'),JSON.stringify(dedup,null,2)+'\n');
console.log('Phase 0 exact duplicate review: '+JSON.stringify(dedup.totals));
const names=fs.readdirSync(dir).filter(x=>x.endsWith('.json')&&x!=='PREFLIGHT_MANIFEST_v1.json').sort();
const files=names.map(name=>{const raw=fs.readFileSync(path.join(dir,name));return {name,bytes:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('hex')};});
const manifest={schemaVersion:'curveyield-security-clean-preflight-v1',status,notSecurityVerdict:true,sourceAdmissionVerified:sourceMatches,sourceOnly:build?.build?.status!=='completed',source:{repository:request?.source?.repository??null,commit:request?.source?.commit??null,archivePath:request?.source?.archivePath??null,expectedSha256:expected,observedSha256:actual},buildStatus:build?.build?.status??null,slitherStatus:slither?.componentStatus??slither?.status??null,wakeStatus:wake?.componentStatus??wake?.status??null,wakeSolidityUnitCount:wake?.solidityUnitCount??null,wakeFindingCount:wake?.findingCount??null,mythrilStatus:mythril?.componentStatus??mythril?.status??null,mythrilEligibleCount:mythril?.eligibleCount??null,mythrilCompletedCount:mythril?.completedCount??null,mythrilFindingCount:mythril?.findingCount??null,warnings,reviewDuplicateIndex:{file:'REVIEW_DUPLICATE_INDEX_v1.json',...dedup.totals},files};
fs.writeFileSync(path.join(dir,'PREFLIGHT_MANIFEST_v1.json'),JSON.stringify(manifest,null,2)+'\n');
const lines=['# Clean standalone Phase 0 evidence','','Status: **'+status+'**','',...warnings.map(x=>'- '+x.code+': '+x.configurationField+' | expected: '+JSON.stringify(x.expected)+' | observed: '+JSON.stringify(x.observed)+' | correction: '+x.requiredCorrection),'','Reviewer-only exact duplicate consolidation: '+dedup.totals.exactDuplicateCount+' duplicate records among '+dedup.totals.rawFindingCount+' available native finding records. Cross-engine semantic equivalence is not assumed. SMTChecker abbreviated diagnostics are retained separately.','','Not a deployed-fork proof or security verdict.'];
fs.writeFileSync(path.join(dir,'DISCOVERY_SUMMARY_v1.md'),lines.join('\n')+'\n');
for(const w of warnings)console.log('::warning title='+w.code+'::'+w.configurationField+' expected '+JSON.stringify(w.expected)+'; observed '+JSON.stringify(w.observed)+'; correction '+w.requiredCorrection);
console.log(JSON.stringify({status,sourceMatches,warnings:warnings.length,files:files.length}));
