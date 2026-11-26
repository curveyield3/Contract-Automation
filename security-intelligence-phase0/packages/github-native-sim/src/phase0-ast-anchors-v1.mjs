// Structural source coordinates for report review. No issue classification or promotion.
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const arr=x=>Array.isArray(x)?x:[];
const int=x=>Number.isSafeInteger(x)&&x>=0;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const key=(...x)=>JSON.stringify(x);
const declarations=new Set(['ContractDefinition','FunctionDefinition','ModifierDefinition','VariableDeclaration','StructDefinition','EnumDefinition','EnumValue','EventDefinition','ErrorDefinition','UserDefinedValueTypeDefinition']);
const isStatement=t=>t==='Block'||t==='UncheckedBlock'||t?.endsWith('Statement');
const isExpression=t=>['Identifier','IdentifierPath','Literal','MemberAccess','IndexAccess','IndexRangeAccess','FunctionCall','FunctionCallOptions','Assignment','BinaryOperation','UnaryOperation','Conditional','TupleExpression','NewExpression','ElementaryTypeNameExpression'].includes(t);
function span(src){
  const m=/^(\d+):(\d+):(\d+)$/.exec(src??'');
  if(!m)return null;
  const [start,length,fileId]=m.slice(1).map(Number),end=start+length;
  return [start,length,fileId,end].every(int)&&length>0?{start,end,fileId}:null;
}
function contentHash(unit,p){
  const raw=unit.sourceContents?.[p];
  const content=typeof raw==='string'?raw:typeof raw?.content==='string'?raw.content:null;
  return content===null?unit.sourceAstContentSha256?.[p]??null:sha(Buffer.from(content,'utf8'));
}
export function collectCanonicalAstIndex(build,sourceFiles){
  const files=new Map(arr(sourceFiles).map(f=>[f.path,f]));
  const nodes=[],coverage=[];
  const units=arr(build?.compilationUnits);
  const unitCounts=new Map();
  for(const u of units)unitCounts.set(u.unitId,(unitCounts.get(u.unitId)??0)+1);
  for(const unit of units){
    if(typeof unit.unitId!=='string'||unitCounts.get(unit.unitId)!==1)continue;
    const sourcePaths=[...new Set([...Object.keys(unit.sourceAsts??{}),...Object.keys(unit.sourceContents??{}),...Object.keys(unit.sourceAstContentSha256??{})])].filter(p=>p.endsWith('.sol')).sort();
    for(const p of sourcePaths){
      const root=unit.sourceAsts[p],f=files.get(p),rootSpan=span(root?.src);
      const item={unitId:unit.unitId,path:p,sourceSha256:f?.sha256??null,status:'UNAVAILABLE',nodeCount:0};
      coverage.push(item);
      if(!root){item.status='AST_UNAVAILABLE';continue;}
      if(!f||!digest(f.sha256)||!int(f.bytes)||contentHash(unit,p)!==f.sha256){item.status='SOURCE_INPUT_UNVERIFIED';continue;}
      if(root?.nodeType!=='SourceUnit'||!rootSpan||rootSpan.end>f.bytes){item.status='INVALID_SOURCE_UNIT';continue;}
      const before=nodes.length;
      function visit(x,context,role){
        if(!x||typeof x!=='object')return;
        if(Array.isArray(x)){x.forEach((v,i)=>visit(v,context,role+'['+i+']'));return;}
        let next=context;
        if(typeof x.nodeType==='string'&&int(x.id)){
          const s=span(x.src),contractId=x.nodeType==='ContractDefinition'?x.id:context.contractId;
          const functionId=x.nodeType==='ContractDefinition'?null:
            ['FunctionDefinition','ModifierDefinition'].includes(x.nodeType)?x.id:context.functionId;
          next={parentId:x.id,contractId,functionId};
          if(s&&s.fileId===rootSpan.fileId&&s.end<=f.bytes){
            const types=arr(x.parameters?.parameters).map(v=>v?.typeDescriptions?.typeString??null);
            const signature=typeof x.name==='string'&&x.parameters&&types.every(t=>typeof t==='string')?x.name+'('+types.join(',')+')':null;
            nodes.push({unitId:unit.unitId,path:p,sourceSha256:f.sha256,sourceFileId:s.fileId,nodeId:x.id,nodeType:x.nodeType,start:s.start,end:s.end,
              parentId:context.parentId,role,contractId,functionId,name:typeof x.name==='string'?x.name:null,
              contractKind:x.contractKind??null,signatureHint:signature,selector:x.functionSelector??null,
              referencedDeclaration:int(x.referencedDeclaration)?x.referencedDeclaration:null,
              linearizedBases:arr(x.linearizedBaseContracts).filter(int)});
          }
        }
        for(const [k,v] of Object.entries(x))if(v&&typeof v==='object')visit(v,next,k);
      }
      visit(root,{parentId:null,contractId:null,functionId:null},'root');
      item.nodeCount=nodes.length-before;
      item.status=item.nodeCount?'INDEXED':'NO_VALID_NODES';
    }
  }
  nodes.sort((a,b)=>a.unitId.localeCompare(b.unitId)||a.path.localeCompare(b.path)||a.start-b.start||a.end-b.end||a.nodeId-b.nodeId);
  coverage.sort((a,b)=>a.unitId.localeCompare(b.unitId)||a.path.localeCompare(b.path));
  return {schemaVersion:'curveyield-canonical-ast-index-v1',status:nodes.length?(coverage.every(x=>x.status==='INDEXED')?'AVAILABLE':'PARTIAL'):'UNAVAILABLE',nodes,coverage};
}
export function createCanonicalAnchorIndex(evidence,{units,files,readSource}){
  const paths=new Map(arr(files).map(f=>[f.path,f]));
  const unitPaths=new Map(),unitCounts=new Map(),verifiedPaths=new Map();
  for(const u of arr(units)){unitCounts.set(u.unitId,(unitCounts.get(u.unitId)??0)+1);unitPaths.set(u.unitId,new Set(arr(u.sourceNames)));}
  const byId=new Map(),buckets=new Map(),conflicts=new Set();
  const rows=evidence?.schemaVersion==='curveyield-canonical-ast-index-v1'?arr(evidence.nodes):[];
  for(const n of rows){
    const f=paths.get(n?.path);
    if(!f||!digest(f.sha256)||f.sha256!==n.sourceSha256||unitCounts.get(n.unitId)!==1||!unitPaths.get(n.unitId)?.has(n.path)||
      ![n.nodeId,n.sourceFileId,n.start,n.end].every(int)||n.end<=n.start||!int(f.bytes)||n.end>f.bytes||typeof n.nodeType!=='string')continue;
    if(!verifiedPaths.has(n.path)){
      const bytes=readSource(n.path);
      verifiedPaths.set(n.path,Buffer.isBuffer(bytes)&&sha(bytes)===f.sha256);
    }
    if(!verifiedPaths.get(n.path))continue;
    const id=key(n.unitId,n.nodeId);
    if(byId.has(id)){conflicts.add(id);continue;}
    byId.set(id,{...n,key:key(n.unitId,n.path,n.sourceSha256,n.sourceFileId,n.nodeType,n.nodeId)});
  }
  for(const id of conflicts)byId.delete(id);
  const sourceIds=new Map(),sourcePaths=new Map();
  for(const n of byId.values()){
    const k=key(n.unitId,n.sourceFileId),p=key(n.unitId,n.path);
    if(!sourceIds.has(k))sourceIds.set(k,new Set());
    if(!sourcePaths.has(p))sourcePaths.set(p,new Set());
    sourceIds.get(k).add(n.path);sourcePaths.get(p).add(n.sourceFileId);
  }
  for(const [id,n] of byId)if(sourceIds.get(key(n.unitId,n.sourceFileId)).size!==1||sourcePaths.get(key(n.unitId,n.path)).size!==1)byId.delete(id);
  for(const n of byId.values()){
    const ref=byId.get(key(n.unitId,n.referencedDeclaration));
    n.referenceKey=ref&&declarations.has(ref.nodeType)?ref.key:null;
    const k=key(n.unitId,n.path,n.sourceSha256);
    if(!buckets.has(k))buckets.set(k,[]);
    buckets.get(k).push(n);
  }
  function resolve(a,{expectedTypes=[],contractId=null,functionId=null,effectiveContractId=null}={}){
    const unresolved=reason=>({status:'UNRESOLVED',reason});
    if(a?.binding!=='RESOLVED'||!int(a.start)||!int(a.end)||a.end<=a.start)return unresolved('NATIVE_LOCATION_UNRESOLVED');
    const rows=buckets.get(key(a.unitId,a.path,a.sourceSha256));
    if(!rows?.length)return unresolved('CANONICAL_AST_UNAVAILABLE');
    const point=a.coordinateKind==='SOLHINT_POINT';
    const types=new Set(expectedTypes);
    if(point&&!types.size)return unresolved('POINT_REQUIRES_EXPECTED_NODE_TYPE');
    const candidates=rows.filter(n=>(!types.size||types.has(n.nodeType))&&(contractId===null||n.contractId===contractId)&&(functionId===null||n.functionId===functionId));
    function resolved(n,basis){
      const effective=effectiveContractId===null?null:byId.get(key(n.unitId,effectiveContractId));
      if(effectiveContractId!==null&&(!effective||effective.nodeType!=='ContractDefinition'||!(n.contractId===effective.nodeId||arr(effective.linearizedBases).includes(n.contractId))))return unresolved('INCOMPATIBLE_EFFECTIVE_CONTEXT');
      return {status:'RESOLVED',basis,node:n,effectiveContextKey:effective?.key??null};
    }
    const exact=point?[]:candidates.filter(n=>n.start===a.start&&n.end===a.end);
    if(exact.length===1)return resolved(exact[0],'EXACT_AST_SPAN');
    if(exact.length>1)return unresolved('AMBIGUOUS_EXACT_NODES');
    if(!types.size)return unresolved('EXPECTED_NODE_TYPE_REQUIRED');
    const overlapping=candidates.filter(n=>n.start<a.end&&a.start<n.end);
    if(overlapping.length!==1)return unresolved(overlapping.length?'AMBIGUOUS_EXPECTED_NODES':'NO_EXPECTED_NODE');
    const n=overlapping[0];
    if(!(n.start<=a.start&&a.end<=n.end)&&!(a.start<=n.start&&n.end<=a.end&&!point))return unresolved('PARTIAL_SPAN_OVERLAP');
    return resolved(n,'UNIQUE_TYPED_CONTAINMENT');
  }
  return {resolve,stats:{indexedNodes:byId.size,conflictingNodeIds:conflicts.size,sourceBuckets:buckets.size}};
}
// These primitives compare structural references only, not the meaning or validity of a report.
function nodeOf(x){return x?.status==='RESOLVED'&&typeof x.node?.key==='string'?x.node:null;}
function structuralKey(kind,x){
  const n=nodeOf(x);
  if(kind==='declaration')return n&&declarations.has(n.nodeType)?key(kind,n.key):null;
  if(kind==='expression')return n&&isExpression(n.nodeType)?key(kind,n.key,x.effectiveContextKey??null):null;
  if(kind==='statement')return n&&isStatement(n.nodeType)?key(kind,n.key,x.effectiveContextKey??null):null;
  if(kind==='relationship'){
    const a=nodeOf(x?.from),b=nodeOf(x?.to);
    if(!a||!b||a.unitId!==b.unitId)return null;
    const proven=x.relation==='REFERENCES_DECLARATION'&&a.referenceKey===b.key||
      x.relation==='INHERITS_DECLARATION'&&a.nodeType==='ContractDefinition'&&b.nodeType==='ContractDefinition'&&a.key!==b.key&&arr(a.linearizedBases).includes(b.nodeId);
    return proven?key(kind,x.relation,a.key,b.key,x.from.effectiveContextKey??null,x.to.effectiveContextKey??null):null;
  }
  if(kind==='interface'){
    const i=nodeOf(x?.interface),m=nodeOf(x?.member),s=nodeOf(x?.subject);
    if(!i||!m||!s||i.contractKind!=='interface'||i.unitId!==m.unitId||i.unitId!==s.unitId||
      m.nodeType!=='FunctionDefinition'||!m.signatureHint||!(m.contractId===i.nodeId||arr(i.linearizedBases).includes(m.contractId))||
      typeof x.discrepancy!=='string'||!x.discrepancy)return null;
    return key(kind,i.key,m.key,m.signatureHint,s.key,x.discrepancy);
  }
  if(kind==='compound'){
    if(!Array.isArray(x)||!x.length)return null;
    const parts=x.map(e=>{
      if(typeof e?.role!=='string'||!e.role||e.kind==='compound')return null;
      const k=structuralKey(e.kind,e.evidence);
      return k===null?null:key(e.role,k);
    });
    return parts.some(p=>p===null)?null:key(kind,parts.sort());
  }
  return null;
}
export function compareCanonicalEvidence(kind,left,right){
  const a=structuralKey(kind,left),b=structuralKey(kind,right);
  return a===null||b===null?'UNRESOLVED':a===b?'SAME_STRUCTURE':'DISTINCT';
}
