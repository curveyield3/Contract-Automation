// Reversible index of existing native observations. Never a security verdict.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createCanonicalAnchorIndex} from '../packages/github-native-sim/src/phase0-ast-anchors-v1.mjs';
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
  ['solhint','SOLHINT_v1.json','/detectors'],
  ['compiler-bugs','SOLIDITY_COMPILER_BUGS_v1.json','/detectors'],
  ['openzeppelin-upgrades','OPENZEPPELIN_UPGRADES_v1.json','/detectors']
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
  const archiveRoot=path.join(dir,'work','archive'), projectPath=build?.discovery?.projectPath, rawCache=new Map();
  function sourceBytes(p){
    if(rawCache.has(p))return rawCache.get(p);
    let bytes=null;
    try{
      if(!same(projectPath,source?.sourceIdentity?.projectPath)||!same(projectPath,exec?.source?.projectPath))throw Error('PROJECT_ROOT_UNVERIFIED');
      const admittedRoot=fs.realpathSync(archiveRoot),realRoot=fs.realpathSync(path.resolve(admittedRoot,projectPath));
      if(realRoot!==admittedRoot&&!realRoot.startsWith(admittedRoot+path.sep))throw Error('PROJECT_ROOT_OUTSIDE_ARCHIVE');
      const real=fs.realpathSync(path.resolve(realRoot,p));
      if(real.startsWith(realRoot+path.sep)&&fs.statSync(real).isFile()){
        const candidate=fs.readFileSync(real);
        if(sha(candidate)===byPath.get(p)?.sha256)bytes=candidate;
      }
    }catch{}
    rawCache.set(p,bytes);return bytes;
  }
  // Solhint 6.2.5 reports one-based lines and columns. A point is not a complete AST span.
  const lineCache=new Map();
  function lintPoint(row,version){
    const p=row?.sourceName,bytes=sourceBytes(p);
    const unresolved=reason=>anchor(p,null,null,'primary',null,{coordinateKind:'SOLHINT_POINT',line:row?.line??null,column:row?.column??null,locationStatus:reason});
    if(version!=='6.2.5')return unresolved('UNQUALIFIED_COORDINATE_VERSION');
    if(!bytes||sha(bytes)!==row?.sourceSha256)return unresolved('SOURCE_BYTES_UNAVAILABLE_OR_MISMATCH');
    if(!Number.isSafeInteger(row.line)||row.line<1||!Number.isSafeInteger(row.column)||row.column<1)return unresolved('INVALID_LINE_COLUMN');
    if(!lineCache.has(p)){
      const text=bytes.toString('utf8');
      if(!Buffer.from(text,'utf8').equals(bytes)||text.startsWith('\uFEFF')||/\r(?!\n)/.test(text))lineCache.set(p,null);
      else{
        let start=0;
        lineCache.set(p,text.split('\n').map(raw=>{
          const entry={start,text:raw.endsWith('\r')?raw.slice(0,-1):raw};
          start+=Buffer.byteLength(raw,'utf8')+1;
          return entry;
        }));
      }
    }
    const line=lineCache.get(p)?.[row.line-1];
    if(!line)return unresolved('UNSUPPORTED_OR_OUT_OF_RANGE_LINE');
    const index=row.column-1,points=Array.from(line.text);
    // Accept a column only when Unicode code-point and UTF-16 interpretations agree.
    if(index>=points.length||points.slice(0,index).join('').length!==index)return unresolved('AMBIGUOUS_OR_OUT_OF_RANGE_COLUMN');
    const start=line.start+Buffer.byteLength(points.slice(0,index).join(''),'utf8');
    return anchor(p,start,start+Buffer.byteLength(points[index],'utf8'),'primary',null,{coordinateKind:'SOLHINT_POINT',line:row.line,column:row.column,locationStatus:'SOURCE_POINT'});
  }
  // Compiler AST callsite src triples give a partial, unit-specific file-ID table.
  // Only exact, unambiguous AST-derived mappings can supply source context.
  const fileIds=new Map(),pathIds=new Map();
  const put=(m,k,v)=>{if(!m.has(k))m.set(k,new Set());m.get(k).add(v);};
  for(const edge of arr(source?.callGraph)){
    const site=edge.sourceCallsite,span=/^(\d+):(\d+):(\d+)$/.exec(site?.astSourceSpan??'');
    if(!span||!Number.isSafeInteger(site.astNodeId)||!unitIdsFor(site.sourcePath).includes(site.compilationUnitId))continue;
    const id=Number(span[3]);if(!Number.isSafeInteger(id))continue;
    put(fileIds,JSON.stringify([site.compilationUnitId,id]),site.sourcePath);
    put(pathIds,JSON.stringify([site.compilationUnitId,site.sourcePath]),id);
  }
  const runtimeCache=new Map();
  function runtimeContext(artifact,pc,version){
    const empty=(locationStatus,extra={})=>({anchors:[],locationStatus,...extra});
    if(version!=='0.24.8')return empty('UNQUALIFIED_RUNTIME_COORDINATE_VERSION');
    if(!artifact)return empty('AMBIGUOUS_OR_UNBOUND_RUNTIME');
    const key=artifact.deployedBytecodeDigestSha256+'|'+artifact.compilationUnitId+'|'+artifact.qualifiedName;
    if(!runtimeCache.has(key)){
      const hex=artifact.deployedBytecode;
      const bytes=typeof hex==='string'&&/^0x(?:[0-9a-f]{2})+$/i.test(hex)?Buffer.from(hex.slice(2),'hex'):null;
      if(!bytes||sha(bytes)!==artifact.deployedBytecodeDigestSha256)runtimeCache.set(key,null);
      else{
        const indices=new Map();
        for(let i=0,n=0;i<bytes.length;n++){
          const op=bytes[i],width=op>=0x60&&op<=0x7f?op-0x5f:0;
          if(i+width>=bytes.length)break;
          indices.set(i,n);i+=1+width;
        }
        const map=typeof artifact.deployedBytecodeSourceMap==='string'&&artifact.deployedBytecodeSourceMap.length?artifact.deployedBytecodeSourceMap.split(';'):null;
        runtimeCache.set(key,{indices,map});
      }
    }
    const runtime=runtimeCache.get(key);
    if(!runtime)return empty('BYTECODE_DIGEST_MISMATCH');
    const index=runtime.indices.get(pc);
    if(!Number.isSafeInteger(index))return empty('NOT_AN_INSTRUCTION_BOUNDARY',{bytecodeVerified:true});
    const extra={bytecodeVerified:true,instructionIndex:index};
    if(!runtime.map||index>=runtime.map.length)return empty('RUNTIME_SOURCE_MAP_UNAVAILABLE',extra);
    // Solidity compressed source maps inherit omitted fields from the prior entry.
    const previous=['-1','-1','-1','',''];
    for(let i=0;i<=index;i++){
      const fields=runtime.map[i].split(':');
      if(fields.length>5)return empty('MALFORMED_RUNTIME_SOURCE_MAP',extra);
      for(let j=0;j<fields.length;j++)if(fields[j]!=='')previous[j]=fields[j];
    }
    if(!previous.slice(0,3).every(x=>/^-?\d+$/.test(x)))return empty('MALFORMED_RUNTIME_SOURCE_MAP',extra);
    const [start,length,id]=previous.slice(0,3).map(Number);
    if(![start,length,id].every(Number.isSafeInteger)||start<0||length<=0||id<0)return empty('NO_CONCRETE_SOURCE_SPAN',extra);
    const paths=fileIds.get(JSON.stringify([artifact.compilationUnitId,id]));
    if(paths?.size!==1)return empty('FILE_ID_UNRESOLVED',extra);
    const p=[...paths][0],ids=pathIds.get(JSON.stringify([artifact.compilationUnitId,p]));
    const bytes=sourceBytes(p);
    if(ids?.size!==1||!ids.has(id)||!bytes||start+length>bytes.length)return empty('SOURCE_CONTEXT_UNVERIFIED',extra);
    // An optimized/inlined instruction can refer to a broad or secondary span.
    // Keep it as compiler context, never an equality or primary issue anchor.
    const a=anchor(p,start,start+length,'context',artifact.compilationUnitId,{coordinateKind:'COMPILER_RUNTIME_CONTEXT',sourceFileId:id});
    if(a.binding!=='RESOLVED')return empty('SOURCE_CONTEXT_UNVERIFIED',extra);
    return {anchors:[a],locationStatus:'COMPILER_MAP_CONTEXT_ONLY',...extra};
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
    claims.push({id:id+':0',observationId:id,scope:'WHOLE_NATIVE_RECORD',home:id});
    return o;
  }
  for(const [engine,file,prefix] of engineSpecs){
    const loaded=load(path.join(dir,file),parsed[engine]),d=loaded.data;
    // Correlation uses the verified collection scope; native reports need not repeat source identity metadata.
    const identity=baseVerified&&loaded.state==='READABLE';
    const rows=engine==='semgrep'?d?.nativeReport?.results:d?.detectors;
    const status=statusOf(d);
    const count=Array.isArray(rows)?rows.length:null;
    const reported=d?.findingCount;
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
        const artifact=matches.length===1?matches[0]:null,pc=row?.address;
        const mapped=baseVerified?runtimeContext(artifact,pc,input.version):{anchors:[],locationStatus:'COLLECTION_SCOPE_UNVERIFIED'};
        observation(input,pointer,row,mapped.anchors,{ruleId:row?.['swc-id']??row?.title,severity:row?.severity,claim:row?.title??null,runtime:{qualifiedName:row?.qualifiedName??null,sha256:row?.runtimeBytecodeSha256??null,pc:pc??null,unitId:mapped.bytecodeVerified?artifact.compilationUnitId:null,bytecodeVerified:mapped.bytecodeVerified===true,instructionIndex:mapped.instructionIndex??null,locationStatus:mapped.locationStatus,sourceBinding:mapped.anchors.length?'CONTEXT_ONLY':'UNRESOLVED'}});
      }else if(engine==='solhint'){
        observation(input,pointer,row,[lintPoint(row,input.version)],{ruleId:row?.ruleId??null,severity:row?.severity??null,claim:row?.message??null,claimKind:'LINT_OBSERVATION',metadata:{sourceName:row?.sourceName??null,sourceSha256:row?.sourceSha256??null,line:row?.line??null,column:row?.column??null}});
      }else if(engine==='compiler-bugs'){
        observation(input,pointer,row,[],{ruleId:row?.advisory??null,severity:row?.severity??null,claim:row?.summary??row?.advisory??null,claimKind:'COMPILER_VERSION_ADVISORY',metadata:{unitId:row?.unitId??null,compilerVersion:row?.compilerVersion??null,uid:row?.uid??null,assessment:row?.assessment??'VERSION_MATCH_ONLY_REVIEW_APPLICABILITY',metadataStatus:row?.metadataStatus??null,conditions:row?.conditions??null,officialCheckTypes:row?.officialCheckTypes??null}});
      }else if(engine==='openzeppelin-upgrades'){
        observation(input,pointer,row,[],{ruleId:row?.kind??null,claim:row?.message??null,claimKind:'UPGRADE_COMPATIBILITY_REPORT',metadata:{unitId:row?.unitId??null,failedContractCount:row?.failedContractCount??null}});
      }
    });
  }
  // Optional AST annotations are an additive report-review view. Failure here
  // must not affect native record reconciliation or the existing equality rule.
  let canonicalAst={status:'UNAVAILABLE',indexedNodes:0,resolvedAnchors:0,unresolvedAnchors:0,candidates:[]};
  try{
    const index=createCanonicalAnchorIndex(baseVerified?source?.canonicalAstIndex:null,{units,files,readSource:sourceBytes});
    const roles={variable:['VariableDeclaration'],function:['FunctionDefinition','ModifierDefinition'],contract:['ContractDefinition']};
    const buckets=new Map();
    for(const o of observations){
      // Only the existing rule's detector mapping is known here. Other semantic
      // category mappings are deliberately deferred to rule qualification.
      const known=o.engine==='slither'&&o.version==='0.11.6'&&o.ruleId==='unused-return'||o.engine==='wake'&&o.version==='4.21.0'&&o.ruleId==='unchecked-return-value';
      o.canonicalAnchors=[];
      for(const [anchorIndex,a] of o.anchors.entries()){
        const issueRole=a.role!=='context'&&(o.engine==='slither'&&a.role==='node'||o.engine==='wake'&&a.role==='primary');
        const types=known&&issueRole?['FunctionCall']:roles[a.role]??[];
        const result=index.resolve(a,{expectedTypes:types});
        o.canonicalAnchors.push({anchorIndex,role:a.role,...result});
        if(result.status==='RESOLVED'){
          canonicalAst.resolvedAnchors++;
          if(known&&issueRole&&result.node.nodeType==='FunctionCall'){
            const k=JSON.stringify(['DISCARDED_RETURN',result.node.key]);
            if(!buckets.has(k))buckets.set(k,new Map());
            buckets.get(k).set(o.id,o.engine);
          }
        }else canonicalAst.unresolvedAnchors++;
      }
    }
    canonicalAst.candidates=[...buckets].filter(([,members])=>new Set(members.values()).size>1)
      .map(([identity,members])=>({identity,observationIds:[...members.keys()].sort(),disposition:'REVIEW_CANDIDATE_ONLY'}))
      .sort((a,b)=>a.identity.localeCompare(b.identity));
    canonicalAst={...canonicalAst,...index.stats,status:index.stats.indexedNodes?source.canonicalAstIndex.status:'UNAVAILABLE'};
  }catch(e){
    for(const o of observations)delete o.canonicalAnchors;
    canonicalAst={status:'UNAVAILABLE',indexedNodes:0,resolvedAnchors:0,unresolvedAnchors:observations.reduce((n,o)=>n+o.anchors.length,0),candidates:[],diagnostic:String(e?.message??e)};
  }
  // Grouping is an additive shadow view until the planned independent qualification.
  const decisions=[],groups=[],relatedLinks=[],byAnchor=new Map(),pairs=new Map();
  for(const o of observations){
    // Newly normalized engines are inventory-only until their rules are qualified.
    if(o.provenance!=='VERIFIED')continue;
    for(const a of o.anchors){
      if(a.binding!=='RESOLVED'||a.role==='context'||a.coordinateKind==='SOLHINT_POINT')continue;
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
    const report=reports.get(input.engine),native=input.engine==='semgrep'?report?.nativeReport?.results:report?.detectors;
    const prefix=engineSpecs.find(x=>x[0]===input.engine)[2];
    const expected=new Set();
    if(Array.isArray(native))native.forEach((row,i)=>{
      expected.add(prefix+'/'+i);
    });
    const actual=observations.filter(o=>o.engine===input.engine).map(o=>o.reference.pointer);
    if(actual.length!==expected.size||new Set(actual).size!==actual.length||actual.some(p=>!expected.has(p)))throw Error('NATIVE_POINTER_SET_MISMATCH:'+input.engine);
  }
  const grouped=new Set(groups.flatMap(g=>g.members));
  const result={schemaVersion:'curveyield-phase0-finding-correlation-v1',scope,notSecurityVerdict:true,mode:'SHADOW',inputs,observations,claims,groups,relatedLinks,decisions,coverage,diagnostics,canonicalAst,counts:{nativeObservations:observations.length,diagnostics:diagnostics.length,shadowGroups:groups.length,shadowGroupedObservations:grouped.size,confirmedGroups:0,singletons:observations.length,relatedLinks:relatedLinks.length,abstentions:decisions.filter(d=>d.disposition==='ABSTAIN').length}};
  const target=path.join(dir,output),temp=target+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(result,null,2)+'\n');fs.renameSync(temp,target);
  return result.counts;
}
