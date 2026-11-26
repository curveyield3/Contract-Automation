// Reversible index of existing native observations. Never a security verdict.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const arr=x=>Array.isArray(x)?x:[];
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const same=(a,b)=>a!=null&&a===b;
const clean=s=>String(s??'').replace(/\s+/g,'').replace(/;$/,'');
const rule='ignored-return-single-call-v1';
const output='PHASE0_FINDING_CORRELATION_v1.json';
const engineSpecs=[
  ['slither','SLITHER_v1.json','/detectors'],
  ['wake','WAKE_v1.json','/detectors'],
  ['mythril','MYTHRIL_v1.json','/detectors'],
  ['semgrep','../semgrep-review/SEMGREP_v1.json','/nativeReport/results'],
  ['smtchecker','SMTCHECKER_v1.json','/units']
];
function load(file,parsed){
  try{const bytes=fs.readFileSync(file);return {data:parsed??JSON.parse(bytes),sha256:sha(bytes),state:'READABLE'};}
  catch(e){return {data:null,sha256:null,state:e.code==='ENOENT'?'MISSING':'MALFORMED'};}
}
function statusOf(d){return d?.componentStatus??d?.status??null;}
function statementPrefix(prefix){
  if(/^\s*$/.test(prefix))return 'STANDALONE';
  // A bare conditional body also discards the complete result.
  const p=prefix.trim();
  if(!/^if\s*\(/.test(p)||!p.endsWith(')')||/['"\x60;{}]|\/[/*]/.test(p))return null;
  let depth=0;
  const start=p.indexOf('(');
  for(let i=start;i<p.length;i++){
    if(p[i]==='(')depth++;
    else if(p[i]===')'){if(--depth<0||depth===0&&i!==p.length-1)return null;}
  }
  return depth===0?'CONDITIONAL_BODY':null;
}
export function publishFindingCorrelation(dir,request,build,source,parsed={}){
  const exec=load(path.join(dir,'PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json')).data;
  const scope={requestId:request?.requestId??null,repository:request?.source?.repository??null,commit:request?.source?.commit??null,archiveSha256:request?.source?.archiveSha256??null,buildConfigurationDigestSha256:build?.build?.buildConfigurationDigestSha256??null,runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null};
  const baseVerified=digest(scope.archiveSha256)&&digest(scope.buildConfigurationDigestSha256)&&same(scope.archiveSha256,build?.source?.archiveSha256Observed)&&same(scope.commit,build?.source?.commit)&&same(scope.repository,build?.source?.repository)&&same(scope.requestId,build?.requestId)&&same(scope.buildConfigurationDigestSha256,exec?.buildConfigurationDigestSha256)&&same(scope.archiveSha256,source?.sourceIdentity?.archiveSha256)&&same(scope.commit,source?.sourceIdentity?.commit)&&same(scope.repository,source?.sourceIdentity?.repository)&&same(scope.archiveSha256,exec?.source?.archiveSha256)&&same(scope.commit,exec?.source?.commit)&&same(scope.repository,exec?.source?.repository)&&same(scope.requestId,exec?.requestIdentity?.requestId)&&same(scope.requestId,source?.requestIdentity?.requestId)&&same(source?.requestIdentity?.requestDigest,exec?.requestIdentity?.requestDigest);
  const units=arr(build?.build?.compilationUnits),files=arr(source?.sourceFiles);
  const byPath=new Map(files.map(f=>[f.path,f]));
  const functionsById=new Map(arr(source?.functions).map(f=>[f.functionId,f]));
  const contractsById=new Map(arr(source?.contracts).map(x=>[x.contractId,x]));
  const callsBySpan=new Map();
  for(const edge of arr(source?.callGraph)){
    const site=edge.sourceCallsite;
    const span=/^(\d+):(\d+):(-?\d+)$/.exec(site?.astSourceSpan??'');
    if(!span||edge.confidenceClass!=='SOLIDITY_AST_REFERENCED_DECLARATION')continue;
    const key=JSON.stringify([site.sourcePath,site.compilationUnitId,site.sourceDigestSha256,Number(span[1]),Number(span[1])+Number(span[2])]);
    if(!callsBySpan.has(key))callsBySpan.set(key,[]);
    callsBySpan.get(key).push(edge);
  }
  function resolvedCall(a){
    const edges=callsBySpan.get(JSON.stringify([a.path,a.unitId,a.sourceSha256,a.start,a.end]))??[];
    if(edges.length!==1)return null;
    const edge=edges[0],target=functionsById.get(edge.targetFunctionId),contract=contractsById.get(edge.targetContractId);
    if(!target||!contract||target.contractId!==contract.contractId)return null;
    const artifacts=arr(exec?.artifacts).filter(x=>x.qualifiedName===contract.qualifiedName&&x.compilationUnitId===a.unitId);
    if(artifacts.length!==1)return null;
    const abi=arr(artifacts[0].abi).filter(f=>f.type==='function'&&f.name+'('+arr(f.inputs).map(x=>x.type).join(',')+')'===target.signature);
    if(abi.length!==1||!Array.isArray(abi[0].outputs))return null;
    return {callEdgeId:edge.callEdgeId,astNodeId:edge.sourceCallsite.astNodeId,qualifiedName:contract.qualifiedName,signature:target.signature,outputCount:abi[0].outputs.length};
  }
  const unitIdsFor=p=>units.filter(u=>arr(u.sourceNames).includes(p)).map(u=>u.unitId);
  const root=path.join(dir,'work','archive'), rawCache=new Map();
  function sourceBytes(p){
    if(rawCache.has(p))return rawCache.get(p);
    let bytes=null;
    try{
      const realRoot=fs.realpathSync(root),real=fs.realpathSync(path.resolve(root,p));
      if(real.startsWith(realRoot+path.sep)&&fs.statSync(real).isFile()){
        const candidate=fs.readFileSync(real);
        if(sha(candidate)===byPath.get(p)?.sha256)bytes=candidate;
      }
    }catch{}
    rawCache.set(p,bytes);return bytes;
  }
  const inputs=[],observations=[],claims=[],diagnostics=[],coverage={},reports=new Map();
  function anchor(p,start,end,role,unitHint=null,extra={}){
    const file=byPath.get(p),ids=unitIdsFor(p),unit=unitHint?(ids.includes(unitHint)?unitHint:null):(ids.length===1?ids[0]:null);
    const valid=typeof p==='string'&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&(!Number.isSafeInteger(file?.bytes)||end<=file.bytes);
    return {path:p??null,start:valid?start:null,end:valid?end:null,role,unitId:unit,possibleUnits:ids,sourceSha256:file?.sha256??null,binding:valid&&unit&&digest(file?.sha256)?'RESOLVED':'UNRESOLVED',...extra};
  }
  function observation(input,pointer,row,anchors,fields={}){
    const reference={runId:scope.runId,runAttempt:scope.runAttempt,artifact:input.artifact,reportSha256:input.sha256,pointer};
    const id=sha(JSON.stringify(reference));
    const o={id,engine:input.engine,reference,ruleId:fields.ruleId??null,version:fields.version??input.version,severity:fields.severity??null,claim:fields.claim??null,suppressed:fields.suppressed??null,anchors,provenance:input.provenance,...fields};
    observations.push(o);
    if(input.engine==='smtchecker')diagnostics.push(id);
    claims.push({id:id+':0',observationId:id,scope:'WHOLE_NATIVE_RECORD',home:id});
    return o;
  }
  for(const [engine,file,prefix] of engineSpecs){
    const loaded=load(path.join(dir,file),parsed[engine]),d=loaded.data,r=d?.reviewSourceIdentity;
    const identity=baseVerified&&same(r?.repository,scope.repository)&&same(r?.commit,scope.commit)&&same(r?.requestId,scope.requestId)&&same(r?.archiveSha256Observed,scope.archiveSha256)&&same(r?.buildConfigurationDigestSha256,scope.buildConfigurationDigestSha256);
    const rows=engine==='semgrep'?d?.nativeReport?.results:engine==='smtchecker'?d?.units:d?.detectors;
    const status=statusOf(d);
    const count=Array.isArray(rows)?(engine==='smtchecker'?rows.reduce((n,u)=>n+arr(u.diagnostics).length,0):rows.length):null;
    const reported=engine==='smtchecker'?d?.diagnosticCount:d?.findingCount;
    const countMatches=reported==null?null:reported===count;
    const state=loaded.state!=='READABLE'?loaded.state:!Array.isArray(rows)?'UNSUPPORTED_LAYOUT':status==='NOT_APPLICABLE'?'NOT_APPLICABLE':String(status).includes('UNSUPPORTED')?'UNSUPPORTED':status!=='COMPLETED'||countMatches===false?'PARTIAL':count===0?'EMPTY':'COMPLETE';
    const input={engine,artifact:file,sha256:loaded.sha256,version:d?.version??null,status,state,count,reportedCount:reported??null,countMatches,provenance:identity?'VERIFIED':'UNVERIFIED',rulesRevision:d?.rulesRevision??null};
    inputs.push(input);coverage[engine]={state,count,provenance:input.provenance,reportedCount:input.reportedCount,countMatches};
    reports.set(engine,d);
    if(!Array.isArray(rows))continue;
    rows.forEach((row,i)=>{
      const pointer=prefix+'/'+i;
      if(engine==='slither'){
        const elements=arr(row?.elements);
        const anchors=elements.map(e=>{const m=e?.source_mapping??{};return anchor(m.filename_relative??m.filename_short,m.start,m.start+m.length,e.type==='function'||e.type==='contract'?'context':e.type??'unknown',null,{label:e.name??null,signature:e.type_specific_fields?.signature??e.type_specific_fields?.parent?.type_specific_fields?.signature??null});});
        observation(input,pointer,row,anchors,{ruleId:row?.check,severity:row?.impact,claim:row?.description??null,confidence:row?.confidence??null});
      }else if(engine==='wake'){
        const anchors=[];
        function visit(d,role){if(!d)return;const l=d.location??{};anchors.push(anchor(l.source_unit_name??l.relative_path,l.start_offset,l.end_offset,role,row.unitId,{label:d.message??null,contract:l.contract??null}));for(const child of arr(d.subdetections))visit(child,'secondary');}
        visit(row?.detection,'primary');
        observation(input,pointer,row,anchors,{ruleId:row?.detector_name,severity:row?.impact,claim:row?.detection?.message,confidence:row?.confidence,suppressed:row?.suppressed??null});
      }else if(engine==='semgrep'){
        const a=anchor(row?.path,row?.start?.offset,row?.end?.offset,'primary');
        const sd=arr(d.sourceDigests).filter(x=>x.sourceName===a.path);
        if(sd.length!==1||sd[0].sha256!==a.sourceSha256)a.binding='UNRESOLVED';
        observation(input,pointer,row,[a],{ruleId:row?.check_id,severity:row?.extra?.severity,claim:row?.extra?.message??null});
      }else if(engine==='mythril'){
        const matches=arr(exec?.artifacts).filter(a=>a.qualifiedName===row?.qualifiedName&&a.deployedBytecodeDigestSha256===row?.runtimeBytecodeSha256&&(!row?.compilationUnitId||a.compilationUnitId===row.compilationUnitId));
        observation(input,pointer,row,[],{ruleId:row?.['swc-id']??row?.title,severity:row?.severity,claim:row?.title??null,runtime:{qualifiedName:row?.qualifiedName??null,sha256:row?.runtimeBytecodeSha256??null,pc:row?.address??null,unitId:matches.length===1?matches[0].compilationUnitId:null,locationStatus:matches.length===1?'FILE_ID_TABLE_NOT_RETAINED':'AMBIGUOUS_OR_UNBOUND_RUNTIME'}});
      }else{
        arr(row?.diagnostics).forEach((diag,j)=>{
          const l=diag?.sourceLocation??{},a=anchor(l.file,l.start,l.end,'diagnostic',row.unitId);
          const code=diag?.errorCode??diag?.code??null;
          observation(input,pointer+'/diagnostics/'+j,diag,[a],{ruleId:code,version:row?.compilerVersion,severity:diag?.severity,claim:String(diag?.message??diag?.formattedMessage??'').split('\n')[0],unitStatus:row?.status??null,diagnosticClassification:diag?.severity==='error'?'ERROR':'UNCLASSIFIED_DIAGNOSTIC'});
        });
      }
    });
  }
  // Grouping is an additive shadow view until the planned independent qualification.
  const decisions=[],groups=[],relatedLinks=[],byAnchor=new Map(),pairs=new Map();
  for(const o of observations){
    if(o.provenance!=='VERIFIED'||o.engine==='smtchecker')continue;
    for(const a of o.anchors){
      if(a.binding!=='RESOLVED'||a.role==='context')continue;
      const key=JSON.stringify([a.path,a.unitId,a.sourceSha256]);
      if(!byAnchor.has(key))byAnchor.set(key,[]);
      byAnchor.get(key).push({o,a});
    }
  }
  for(const bucket of byAnchor.values()){
    bucket.sort((x,y)=>x.a.start-y.a.start||x.a.end-y.a.end||x.o.id.localeCompare(y.o.id));
    for(let i=0;i<bucket.length;i++)for(let j=i+1;j<bucket.length&&bucket[j].a.start<bucket[i].a.end;j++){
      const x=bucket[i],y=bucket[j];if(x.o.engine===y.o.engine)continue;
      const [left,right]=x.o.id<y.o.id?[x,y]:[y,x];
      const id=sha(left.o.id+'|'+right.o.id);
      if(!pairs.has(id))pairs.set(id,{id,left:left.o,right:right.o,evidence:[]});
      pairs.get(id).evidence.push({left:left.a,right:right.a,reason:left.a.start===right.a.start&&left.a.end===right.a.end?'EXACT_INTERVAL':'OVERLAPPING_INTERVAL'});
    }
  }
  const possible=[];
  for(const p of [...pairs.values()].sort((a,b)=>a.id.localeCompare(b.id))){
    const {left,right,evidence}=p;
    const s=left.engine==='slither'?left:right.engine==='slither'?right:null;
    const w=left.engine==='wake'?left:right.engine==='wake'?right:null;
    const sn=s?.anchors.filter(a=>a.role==='node')??[],wa=w?.anchors??[];
    const exact=evidence.find(e=>e.reason==='EXACT_INTERVAL'&&[e.left.role,e.right.role].includes('node')&&[e.left.role,e.right.role].includes('primary'));
    let reason='NO_QUALIFIED_EQUALITY_RULE',eligible=false,proof=null;
    if(s?.ruleId==='unused-return'&&w?.ruleId==='unchecked-return-value'){
      reason='RULE_EVIDENCE_INCOMPLETE';
      if(s.version!=='0.11.6'||w.version!=='4.21.0')reason='UNQUALIFIED_RULE_VERSION';
      else if(!exact||sn.length!==1||wa.length!==1||s.anchors.some(a=>!['node','context'].includes(a.role)))reason='NOT_ONE_EXACT_SINGLE_CLAIM';
      else{
        const a=sn[0],bytes=sourceBytes(a.path),wakeReport=reports.get('wake');
        const wr=arr(wakeReport?.unitResults).filter(u=>u.unitId===a.unitId&&u.status==='COMPLETED');
        const wd=wr.length===1?arr(wr[0].sourceDigests).filter(f=>f.sourceName===a.path):[];
        const sc=arr(reports.get('slither')?.analyzerCoverage).filter(u=>u.unitId===a.unitId&&u.analyzer==='slither');
        if(!bytes||wd.length!==1||wd[0].sha256!==a.sourceSha256||sc.length!==1)reason='SOURCE_OR_UNIT_PROVENANCE_MISSING';
        else{
          const expression=clean(bytes.subarray(a.start,a.end).toString('utf8'));
          const native=clean(a.label),call=resolvedCall(a);
          const after=bytes.subarray(a.end,a.end+64).toString('utf8');
          const before=bytes.subarray(Math.max(0,a.start-512),a.start).toString('utf8');
          const prefix=before.slice(before.lastIndexOf('\n')+1);
          const statement=statementPrefix(prefix);
          const terminated=/;\s*$/.test(bytes.subarray(a.start,a.end).toString('utf8'))||/^\s*;/.test(after);
          if(!statement||!terminated||expression!==native||w.claim!=='Unchecked return value')reason='SINGLE_DISCARDED_CALL_NOT_ESTABLISHED';
          else if(!call||call.outputCount!==1)reason='SINGLE_RESOLVED_RETURN_NOT_ESTABLISHED';
          else{eligible=true;reason='SAME_BOUND_SINGLE_DISCARDED_CALL';proof={...call,statement,path:a.path,start:a.start,end:a.end,unitId:a.unitId,sourceSha256:a.sourceSha256};}
        }
      }
    }
    const d={id:p.id,members:[left.id,right.id],references:[left.reference,right.reference],ruleVersion:eligible?rule:null,disposition:eligible?'SHADOW_EQUAL':'RELATED',reason,evidence,proof};
    decisions.push(d);
    if(eligible)possible.push(d);else relatedLinks.push({pairId:d.id,members:d.members,reason,anchors:evidence});
  }
  const degree=new Map();
  for(const d of possible)for(const id of d.members)degree.set(id,(degree.get(id)??0)+1);
  for(const d of possible){
    if(d.members.some(id=>degree.get(id)!==1)){d.disposition='ABSTAIN';d.reason='NON_UNIQUE_PAIR';continue;}
    const id='group-'+d.id;
    groups.push({id,ruleVersion:rule,state:'SHADOW',members:d.members,references:d.references,decisionId:d.id});
  }
  // All observations remain individually visible in shadow. No native report is edited.
  const ids=new Set(observations.map(o=>o.id));
  if(ids.size!==observations.length||claims.length!==observations.length)throw Error('OBSERVATION_RECONCILIATION_FAILED');
  for(const input of inputs){
    const report=reports.get(input.engine),native=input.engine==='semgrep'?report?.nativeReport?.results:input.engine==='smtchecker'?report?.units:report?.detectors;
    const prefix=engineSpecs.find(x=>x[0]===input.engine)[2];
    const expected=new Set();
    if(Array.isArray(native))native.forEach((row,i)=>{
      if(input.engine==='smtchecker')arr(row?.diagnostics).forEach((_,j)=>expected.add(prefix+'/'+i+'/diagnostics/'+j));
      else expected.add(prefix+'/'+i);
    });
    const actual=observations.filter(o=>o.engine===input.engine).map(o=>o.reference.pointer);
    if(actual.length!==expected.size||new Set(actual).size!==actual.length||actual.some(p=>!expected.has(p)))throw Error('NATIVE_POINTER_SET_MISMATCH:'+input.engine);
  }
  const grouped=new Set(groups.flatMap(g=>g.members));
  const result={schemaVersion:'curveyield-phase0-finding-correlation-v1',scope,notSecurityVerdict:true,mode:'SHADOW',inputs,observations,claims,groups,relatedLinks,decisions,coverage,diagnostics,counts:{nativeObservations:observations.length-diagnostics.length,diagnostics:diagnostics.length,shadowGroups:groups.length,shadowGroupedObservations:grouped.size,confirmedGroups:0,singletons:observations.length,relatedLinks:relatedLinks.length,abstentions:decisions.filter(d=>d.disposition==='ABSTAIN').length}};
  const target=path.join(dir,output),temp=target+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(result,null,2)+'\n');fs.renameSync(temp,target);
  return result.counts;
}
