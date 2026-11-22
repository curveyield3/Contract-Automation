import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digestCanonicalV1 } from './canonical-json-v1.mjs';
import { generateBuildSbomV1 } from './sbom-v1.mjs';

const SKIP = new Set(['.git','node_modules','artifacts','cache','out','dist','build','.audit-hermetic-build','.audit-slither-export','.deep-assurance-work','.deep-assurance-work-v2']);
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const clone = (v) => v === undefined ? undefined : structuredClone(v);
const pad = (n,w=3) => String(n).padStart(w,'0');

function abiType(input) {
  const type = String(input?.type ?? '');
  if (!type.startsWith('tuple')) return type;
  return `(${(input?.components ?? []).map(abiType).join(',')})${type.slice(5)}`;
}
function signature(entry) { return `${entry.name}(${(entry.inputs ?? []).map(abiType).join(',')})`; }
function language(pathName, artifact = {}) {
  if (artifact.language) return String(artifact.language).toUpperCase();
  return String(pathName).toLowerCase().endsWith('.vy') ? 'VYPER' : 'SOLIDITY';
}
function bytecodeDigest(value) {
  const hex = String(value ?? '').replace(/^0x/,'');
  return sha256(hex && /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0 ? Buffer.from(hex,'hex') : Buffer.from(String(value ?? '')));
}
function loc(source, src) {
  if (!source || typeof src !== 'string') return null;
  const [a,b] = src.split(':').map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return null;
  const bytes = Buffer.from(source.content,'utf8');
  const start = Math.min(a,bytes.length), end = Math.min(a+b,bytes.length);
  const startLine = bytes.subarray(0,start).toString('utf8').split('\n').length;
  const endLine = bytes.subarray(0,end).toString('utf8').split('\n').length;
  return {label:`${source.path}:${startLine}-${endLine}`,startLine,endLine};
}
function walk(value, visit, ctx={}) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) walk(item,visit,ctx); return; }
  let next = ctx;
  if (value.nodeType) {
    next = {...ctx};
    if (value.nodeType === 'ContractDefinition') next.contract = value;
    if (value.nodeType === 'FunctionDefinition' || value.nodeType === 'ModifierDefinition' ||
        (value.nodeType === 'VariableDeclaration' && value.stateVariable===true &&
         value.value && containsAstCallExpression(value.value)))
      next.fn = value;
    visit(value,next);
  }
  for (const [key,child] of Object.entries(value)) {
    if (['scope','referencedDeclaration','linearizedBaseContracts'].includes(key)) continue;
    if (child && typeof child === 'object') walk(child,visit,next);
  }
}
// Treat a deployment-time state initializer as a caller only when its AST
// actually contains a call/creation expression. Literal initializers are not
// fabricated function-like security subjects.
function containsAstCallExpression(value){
  let found=false;
  walk(value,node=>{if(node.nodeType==='FunctionCall'||node.nodeType==='NewExpression')found=true;});
  return found;
}
async function sources(projectRoot) {
  const out=[];
  async function scan(dir) {
    for (const e of await fs.readdir(dir,{withFileTypes:true})) {
      if (SKIP.has(e.name) || e.name.startsWith('artifacts')) continue;
      const full=path.join(dir,e.name);
      if (e.isDirectory()) await scan(full);
      else if (e.isFile() && (e.name.endsWith('.sol') || e.name.endsWith('.vy'))) {
        const bytes=await fs.readFile(full);
        out.push({path:path.relative(projectRoot,full).split(path.sep).join('/'),language:e.name.endsWith('.vy')?'VYPER':'SOLIDITY',sha256:sha256(bytes),bytes:bytes.length,content:bytes.toString('utf8')});
      }
    }
  }
  await scan(projectRoot);
  out.sort((a,b)=>a.path.localeCompare(b.path));
  return out.map((x,i)=>({...x,sourceId:`SRC-${pad(i+1)}`}));
}
export const listAdmittedSourcesV1 = sources;
function astIndex(sourceAsts, byPath, compilationUnits=[]) {
  const nodes=new Map(), contracts=new Map(), functions=new Map();
  const units=(Array.isArray(compilationUnits)&&compilationUnits.length)
    ? compilationUnits.map((unit,index)=>({unitId:unit.unitId??`unit-${index+1}`,sourceAsts:unit.sourceAsts??{}}))
    : [{unitId:'default',sourceAsts:sourceAsts??{}}];
  for(const unit of units){
    for (const [sourceName,ast] of Object.entries(unit.sourceAsts ?? {}).sort(([a],[b])=>a.localeCompare(b))) {
      const source=byPath.get(sourceName);
      walk(ast,(node,ctx)=>{
        if (Number.isInteger(node.id)) nodes.set(`${unit.unitId}:${node.id}`,{node,sourceName,source,unitId:unit.unitId});
        if (node.nodeType==='ContractDefinition') {
          const qualifiedName=`${sourceName}:${node.name}`;
          contracts.set(`${unit.unitId}|${qualifiedName}`,{node,sourceName,source,unitId:unit.unitId,qualifiedName});
          if(unit.unitId==='default')contracts.set(qualifiedName,{node,sourceName,source,unitId:unit.unitId,qualifiedName});
        }
        if ((node.nodeType==='FunctionDefinition'||node.nodeType==='ModifierDefinition'||
             (node.nodeType==='VariableDeclaration'&&node.stateVariable===true&&
              node.value&&containsAstCallExpression(node.value))) && ctx.contract) {
          const qualifiedName=`${sourceName}:${ctx.contract.name}`;
          const key=`${unit.unitId}|${qualifiedName}`;
          const list=functions.get(key)??[]; list.push({node,sourceName,source,unitId:unit.unitId}); functions.set(key,list);
          if(unit.unitId==='default'){
            const legacy=functions.get(qualifiedName)??[];legacy.push({node,sourceName,source,unitId:unit.unitId});functions.set(qualifiedName,legacy);
          }
        }
      });
    }
  }
  return {nodes,contracts,functions,units};
}
function modifierName(m) { return m?.modifierName?.name ?? m?.modifierName?.namePath ?? m?.modifierName?.memberName ?? 'UNKNOWN_MODIFIER'; }

export async function generateSourceIntelligenceTechnicalBundleV1({projectRoot,request,build,analysis={}}={}) {
  if (!projectRoot || !request?.source || !request?.configuration) throw new TypeError('projectRoot and request are required');
  if (!build || build.status !== 'completed') throw new Error('accepted completed build is required');

  const raw=await sources(projectRoot);
  if (!raw.length) throw new Error('no admitted Solidity/Vyper source files found');
  const byPath=new Map(raw.map(x=>[x.path,x]));
  const sourceFiles=raw.map(({content,...x})=>({...x,scopeStatus:'IN_SCOPE_ADMITTED_SOURCE',basis:'EXACT_ADMITTED_CHECKOUT_OR_ARCHIVE'}));
  const ast=astIndex(build.sourceAsts ?? {},byPath,build.compilationUnits??[]);
  const artifacts=[...(build.artifacts??[])].sort((a,b)=>`${a.sourceName}:${a.contractName}`.localeCompare(`${b.sourceName}:${b.contractName}`));

  const compilerArtifacts=[],contracts=[],functions=[],storageLayout=[],inheritanceGraph=[],privilegeCandidates=[],eventsAndErrors=[],sourceAnchors=[];
  const contractByAstId=new Map(), contractByQualified=new Map(), contractByQualifiedUnit=new Map(), functionByAstId=new Map(), functionMetaById=new Map();

  for (const [i,a] of artifacts.entries()) {
    const qualifiedName=`${a.sourceName}:${a.contractName}`, artifactId=`ART-${pad(i+1)}`;
    const source=byPath.get(a.sourceName), sourceId=source?.sourceId??null, lang=language(a.sourceName,a);
    compilerArtifacts.push({
      artifactId,qualifiedName,compilationUnitId:a.compilationUnitId??'default',sourcePath:a.sourceName,sourceId,language:lang,abiDigestSha256:digestCanonicalV1(a.abi??[]),
      creationBytecodeDigestSha256:bytecodeDigest(a.bytecode),deployedBytecodeDigestSha256:bytecodeDigest(a.deployedBytecode),
      storageLayoutAvailable:a.storageLayout?'YES':'NO',metadataAvailable:a.metadata!=null,methodIdentifiers:clone(a.methodIdentifiers??{}),
      creationBytecodeBytes:Math.floor(String(a.bytecode??'0x').replace(/^0x/,'').length/2),
      deployedBytecodeBytes:Math.floor(String(a.deployedBytecode??'0x').replace(/^0x/,'').length/2),
      preliminaryDeploymentGasEstimate:{acceptanceClass:'PRELIMINARY_NOT_PHASE7_ACCEPTED',estimate:a.gasEstimates?.creation?.totalCost??null},
      basis:'ADMITTED_COMPILER_OUTPUT'
    });
    const unitId=a.compilationUnitId??'default';
    const astContract=ast.contracts.get(`${unitId}|${qualifiedName}`)??ast.contracts.get(qualifiedName), contractId=`CONTRACT-${pad(i+1)}`;
    contractByQualified.set(qualifiedName,contractId);
    contractByQualifiedUnit.set(`${unitId}|${qualifiedName}`,contractId);
    if (Number.isInteger(astContract?.node?.id)) contractByAstId.set(`${unitId}:${astContract.node.id}`,contractId);
    const cLoc=loc(source,astContract?.node?.src);
    contracts.push({contractId,qualifiedName,compilationUnitId:unitId,sourcePath:a.sourceName,sourceId,language:lang,contractKind:astContract?.node?.contractKind??(lang==='VYPER'?'contract':'UNKNOWN'),
      deployability:(astContract?.node?.abstract===true||['interface','library'].includes(astContract?.node?.contractKind))?'NOT_DIRECTLY_DEPLOYABLE':(String(a.bytecode??'0x')==='0x'?'NO_CREATION_BYTECODE':'DEPLOYABLE'),
      artifactId,sourceLocation:cLoc?.label??'UNSUPPORTED_AST_SOURCE_LOCATION',confidenceClass:'COMPILER_FACT',basis:cLoc?'SOLIDITY_AST_AND_COMPILER_ARTIFACT':'COMPILER_ARTIFACT'});
    if (cLoc) sourceAnchors.push({anchorId:`ANCHOR-${pad(sourceAnchors.length+1,4)}`,sourceId,symbolId:contractId,startLine:cLoc.startLine,endLine:cLoc.endLine,sourceDigestSha256:source.sha256,basis:'SOLIDITY_AST_SRC'});

    const astFns=ast.functions.get(`${unitId}|${qualifiedName}`)??ast.functions.get(qualifiedName)??[];
    for (const abi of a.abi??[]) {
      if (abi.type==='function') {
        const sig=signature(abi), selector=a.methodIdentifiers?.[sig]??null;
        const fn=astFns.find(x=>selector&&x.node?.functionSelector===selector) ?? astFns.find(x=>x.node?.name===abi.name&&(x.node?.parameters?.parameters?.length??-1)===(abi.inputs??[]).length);
        const id=`FUNC-${pad(functions.length+1,4)}`, fLoc=loc(source,fn?.node?.src);
        const modifiers=(fn?.node?.modifiers??[]).map(modifierName);
        functions.push({functionId:id,contractId,signature:sig,selector:selector?`0x${selector.replace(/^0x/,'')}`:null,visibility:fn?.node?.visibility??'PUBLIC_OR_EXTERNAL_ABI',
          stateMutability:abi.stateMutability??fn?.node?.stateMutability??null,payable:(abi.stateMutability??fn?.node?.stateMutability)==='payable',modifiers,
          sourceLocation:fLoc?.label??'UNSUPPORTED_AST_SOURCE_LOCATION',confidenceClass:'COMPILER_FACT',basis:fLoc?'ABI_METHOD_IDENTIFIERS_AND_SOLIDITY_AST':'ABI_AND_METHOD_IDENTIFIERS'});
        functionMetaById.set(id,{functionId:id,contractId,signature:sig,qualifiedContract:qualifiedName,sourceName:a.sourceName,contractName:a.contractName});
        if(Number.isInteger(fn?.node?.id)) functionByAstId.set(`${unitId}:${fn.node.id}`,{functionId:id,contractId,signature:sig,qualifiedContract:qualifiedName,sourceName:a.sourceName,contractName:a.contractName,unitId});
        if (fLoc) sourceAnchors.push({anchorId:`ANCHOR-${pad(sourceAnchors.length+1,4)}`,sourceId,symbolId:id,startLine:fLoc.startLine,endLine:fLoc.endLine,sourceDigestSha256:source.sha256,basis:'SOLIDITY_AST_SRC'});
        for (const m of fn?.node?.modifiers??[]) privilegeCandidates.push({candidateId:`PRIV-${pad(privilegeCandidates.length+1,4)}`,contractId,functionId:id,candidateKind:'MODIFIER_INVOCATION',
          modifierOrGuard:modifierName(m),authorityExpression:modifierName(m),sourceLocation:loc(source,m.src)?.label??fLoc?.label??'UNSUPPORTED_AST_SOURCE_LOCATION',
          status:'CANDIDATE',confidenceClass:'SOURCE_SYNTAX_FACT',basis:'SOLIDITY_AST_MODIFIER_INVOCATION',securityInterpretation:'DEFER_TO_PHASE_3_AND_4'});
      } else if (abi.type==='event' || abi.type==='error') {
        eventsAndErrors.push({itemId:`EVERR-${pad(eventsAndErrors.length+1,4)}`,contractId,kind:abi.type.toUpperCase(),signatureOrName:signature(abi),
          sourceLocation:'ABI_ONLY_SOURCE_LOCATION_UNAVAILABLE',confidenceClass:'COMPILER_FACT',basis:'COMPILER_ABI'});
      }
    }
    for (const item of a.storageLayout?.storage??[]) {
      const node=Number.isInteger(item.astId)?ast.nodes.get(`${unitId}:${item.astId}`):null, sLoc=loc(byPath.get(node?.sourceName??a.sourceName),node?.node?.src);
      storageLayout.push({storageId:`STORE-${pad(storageLayout.length+1,4)}`,contractId,label:item.label??null,slot:String(item.slot??''),offset:String(item.offset??''),
        type:a.storageLayout?.types?.[item.type]?.label??item.type??null,sourceLocation:sLoc?.label??'UNSUPPORTED_AST_SOURCE_LOCATION',status:'CURRENT',confidenceClass:'COMPILER_FACT',basis:'COMPILER_STORAGE_LAYOUT'});
    }
  }

  // ABI method identifiers cover only externally exposed functions. Scan all
  // remaining AST-declared function/modifier bodies too: otherwise the walk
  // drops every external call nested inside internal/private functions or
  // modifier implementations before callsite deduplication can see it.
  // Append after every ABI method so existing ABI function IDs remain stable.
  for(const a of artifacts){
    const unitId=a.compilationUnitId??'default';
    const qualifiedName=`${a.sourceName}:${a.contractName}`;
    const contractId=contractByQualifiedUnit.get(`${unitId}|${qualifiedName}`)??contractByQualified.get(qualifiedName);
    if(!contractId)continue;
    const declarations=ast.functions.get(`${unitId}|${qualifiedName}`)??ast.functions.get(qualifiedName)??[];
    for(const declaration of declarations){
      const node=declaration.node;
      if(!Number.isInteger(node?.id)||functionByAstId.has(`${unitId}:${node.id}`))continue;
      const modifier=node.nodeType==='ModifierDefinition';
      const initializer=node.nodeType==='VariableDeclaration'&&node.stateVariable===true;
      const name=initializer?'state initializer '+(node.name??'UNNAMED_VARIABLE'):
        modifier?'modifier '+(node.name??'UNNAMED_MODIFIER'):(node.name||node.kind||'UNNAMED_FUNCTION');
      const parameters=(node.parameters?.parameters??[]).map(param=>
        param?.typeDescriptions?.typeString??param?.typeName?.name??'UNRESOLVED_TYPE');
      const sig=name+'('+parameters.join(',')+')';
      const id=`FUNC-${pad(functions.length+1,4)}`;
      const source=byPath.get(declaration.sourceName);
      const fLoc=loc(source,node.src);
      const guards=(node.modifiers??[]).map(modifierName);
      functions.push({
        functionId:id,contractId,signature:sig,selector:null,
        visibility:initializer?'STATE_INITIALIZER':modifier?'MODIFIER':node.visibility??'SOURCE_DECLARED',
        stateMutability:node.stateMutability??null,payable:node.stateMutability==='payable',
        modifiers:guards,sourceLocation:fLoc?.label??'UNSUPPORTED_AST_SOURCE_LOCATION',
        confidenceClass:'SOURCE_SYNTAX_FACT',basis:initializer?'SOLIDITY_AST_STATE_INITIALIZER':
          modifier?'SOLIDITY_AST_MODIFIER_DEFINITION':'SOLIDITY_AST_FUNCTION_DEFINITION'
      });
      functionMetaById.set(id,{functionId:id,contractId,signature:sig,qualifiedContract:qualifiedName,
        sourceName:a.sourceName,contractName:a.contractName});
      functionByAstId.set(`${unitId}:${node.id}`,{functionId:id,contractId,signature:sig,
        qualifiedContract:qualifiedName,sourceName:a.sourceName,contractName:a.contractName,unitId});
      if(fLoc)sourceAnchors.push({anchorId:`ANCHOR-${pad(sourceAnchors.length+1,4)}`,sourceId:source?.sourceId??null,
        symbolId:id,startLine:fLoc.startLine,endLine:fLoc.endLine,sourceDigestSha256:source.sha256,basis:'SOLIDITY_AST_SRC'});
      for(const guard of node.modifiers??[])privilegeCandidates.push({
        candidateId:`PRIV-${pad(privilegeCandidates.length+1,4)}`,contractId,functionId:id,candidateKind:'MODIFIER_INVOCATION',
        modifierOrGuard:modifierName(guard),authorityExpression:modifierName(guard),
        sourceLocation:loc(source,guard.src)?.label??fLoc?.label??'UNSUPPORTED_AST_SOURCE_LOCATION',
        status:'CANDIDATE',confidenceClass:'SOURCE_SYNTAX_FACT',basis:'SOLIDITY_AST_MODIFIER_INVOCATION',
        securityInterpretation:'DEFER_TO_PHASE_3_AND_4'
      });
    }
  }

  const inheritanceSeen=new Set();
  for (const entry of ast.contracts.values()) {
    const entryKey=`${entry.unitId}|${entry.qualifiedName}`;
    if(inheritanceSeen.has(entryKey))continue;inheritanceSeen.add(entryKey);
    const derived=contractByQualifiedUnit.get(entryKey)??contractByQualified.get(entry.qualifiedName); if (!derived) continue;
    for (const base of entry.node?.baseContracts??[]) {
      const baseId=base?.baseName?.referencedDeclaration, baseContractId=contractByAstId.get(`${entry.unitId}:${baseId}`); if (!baseContractId) continue;
      inheritanceGraph.push({edgeId:`INHERIT-${pad(inheritanceGraph.length+1,4)}`,derivedContractId:derived,baseContractId,
        linearizedOrder:(entry.node.linearizedBaseContracts??[]).indexOf(baseId),sourceLocation:loc(entry.source,base.src)?.label??'UNSUPPORTED_AST_SOURCE_LOCATION',
        confidenceClass:'COMPILER_FACT',basis:'SOLIDITY_AST_BASE_CONTRACT'});
    }
  }


  const callGraph=[],externalInterfaces=[],valueFlowCandidates=[];
  const callDedup=new Set(), externalDedup=new Set(), valueDedup=new Set();
  function unwrapExpression(expr){
    let cur=expr;
    while(cur?.nodeType==='FunctionCallOptions') cur=cur.expression;
    return cur;
  }
  function expressionRef(expr){
    const cur=unwrapExpression(expr);
    return Number.isInteger(cur?.referencedDeclaration)?cur.referencedDeclaration:null;
  }
  function expressionMember(expr){
    const cur=unwrapExpression(expr);
    return cur?.memberName??cur?.name??cur?.nodeType??'UNKNOWN_CALL';
  }
  function expressionType(expr){
    const cur=unwrapExpression(expr);
    return cur?.expression?.typeDescriptions?.typeString??cur?.typeDescriptions?.typeString??null;
  }
  function pushCall(edge){
    const origin=edge.sourceCallsite;
    const key=typeof origin?.astSourceSpan==='string'&&/^\d+:\d+:\d+$/.test(origin.astSourceSpan)
      ? JSON.stringify(['AST_CALL',origin.compilationUnitId,origin.sourcePath,origin.astSourceSpan])
      : [edge.callerFunctionId,edge.targetFunctionId??'',edge.memberOrName??'',edge.sourceLocation??''].join('|');
    if(callDedup.has(key))return; callDedup.add(key); callGraph.push({...edge,callEdgeId:`CALL-${pad(callGraph.length+1,4)}`});
  }
  function pushExternal(item){
    // Repeat visits to the same AST call collapse; distinct spans must survive.
    const origin=item.sourceCallsite;
    const span=typeof origin?.astSourceSpan==='string'&&/^\d+:\d+:\d+$/.test(origin.astSourceSpan)?origin.astSourceSpan:null;
    const key=span!==null
      ? JSON.stringify(['AST_SPAN',origin.compilationUnitId,origin.sourcePath,span])
      : Number.isInteger(origin?.astNodeId)
        ? JSON.stringify(['AST_NODE_FALLBACK',origin?.compilationUnitId,origin?.sourcePath,origin.astNodeId])
        : null;
    // If no AST origin is available, preserve the observation instead of guessing identity.
    if(key&&externalDedup.has(key))return;
    if(key)externalDedup.add(key);
    externalInterfaces.push({...item,externalInterfaceId:`EXT-${pad(externalInterfaces.length+1,4)}`});
  }
  function pushValue(item){
    const origin=item.sourceCallsite;
    const key=typeof origin?.astSourceSpan==='string'&&/^\d+:\d+:\d+$/.test(origin.astSourceSpan)
      ? JSON.stringify(['AST_VALUE',origin.compilationUnitId,origin.sourcePath,origin.astSourceSpan,item.flowKind])
      : [item.callerFunctionId,item.flowKind,item.memberOrName??'',item.sourceLocation??''].join('|');
    if(valueDedup.has(key))return; valueDedup.add(key); valueFlowCandidates.push({...item,valueFlowCandidateId:`VALUE-${pad(valueFlowCandidates.length+1,4)}`});
  }

  const traversalUnits=(Array.isArray(build.compilationUnits)&&build.compilationUnits.length)
    ? build.compilationUnits.map((unit,index)=>({unitId:unit.unitId??`unit-${index+1}`,sourceAsts:unit.sourceAsts??{}}))
    : [{unitId:'default',sourceAsts:build.sourceAsts??{}}];
  for(const unit of traversalUnits){
    for (const [sourceName,rootAst] of Object.entries(unit.sourceAsts??{}).sort(([a],[b])=>a.localeCompare(b))) {
      const source=byPath.get(sourceName);
      walk(rootAst,(node,ctx)=>{
        if(!ctx?.fn||!ctx?.contract)return;
        const callerContractId=contractByAstId.get(`${unit.unitId}:${ctx.contract.id}`)??contractByQualifiedUnit.get(`${unit.unitId}|${sourceName}:${ctx.contract.name}`)??contractByQualified.get(`${sourceName}:${ctx.contract.name}`)??null;
        const caller=functionByAstId.get(`${unit.unitId}:${ctx.fn.id}`)??null;
        if(!callerContractId||!caller)return;
        const callLoc=loc(source,node.src)?.label??'UNSUPPORTED_AST_SOURCE_LOCATION';

        if(node.nodeType==='FunctionCall'){
          const expr=unwrapExpression(node.expression);
          const ref=expressionRef(node.expression);
          const target=Number.isInteger(ref)?(functionByAstId.get(`${unit.unitId}:${ref}`)??null):null;
          const member=expressionMember(node.expression);
          const interfaceType=expressionType(node.expression);
          // Compiler provenance supplements (never replaces) the existing EXT record ID.
          const sourceCallsite={
            compilationUnitId:unit.unitId,
            sourcePath:sourceName,
            sourceDigestSha256:source?.sha256??null,
            astSourceSpan:typeof node.src==='string'?node.src:null,
            astNodeId:Number.isInteger(node.id)?node.id:null
          };
          const isMember=expr?.nodeType==='MemberAccess';
          const receiver=expr?.expression;
          const explicitThis=isMember&&receiver?.nodeType==='Identifier'&&receiver.name==='this';
          const inheritedSuper=isMember&&receiver?.nodeType==='Identifier'&&receiver.name==='super';
          const sameContract=target?.contractId===callerContractId;
          const lowLevelMember=['call','delegatecall','staticcall'].includes(member);
          // Solidity this.f() crosses the external ABI even when the resolved
          // function belongs to this contract; super.f() is inherited dispatch.
          const externalMemberCall=isMember&&!inheritedSuper&&(!target||!sameContract||explicitThis);
          const callClass=explicitThis?'EXTERNAL_SELF_ABI_CALL':inheritedSuper?'INHERITED_INTERNAL_DISPATCH':
            target?(sameContract?'INTERNAL_OR_SELF':'CROSS_CONTRACT_OR_INHERITED'):
            (isMember?'UNRESOLVED_MEMBER_CALL':'UNRESOLVED_CALL');
          pushCall({
            callerContractId,callerFunctionId:caller.functionId,targetContractId:target?.contractId??null,targetFunctionId:target?.functionId??null,
            memberOrName:member,callClass,interfaceOrType:interfaceType,sourceLocation:callLoc,confidenceClass:target?'SOLIDITY_AST_REFERENCED_DECLARATION':'SOLIDITY_AST_CALL_SYNTAX',
            basis:target?'FUNCTION_CALL_REFERENCED_DECLARATION':'FUNCTION_CALL_EXPRESSION',sourceCallsite
          });
          if(externalMemberCall){
            pushExternal({callerContractId,callerFunctionId:caller.functionId,targetContractId:target?.contractId??null,targetFunctionId:target?.functionId??null,
              interfaceOrType:interfaceType,memberOrName:member,sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',
              basis:lowLevelMember?'LOW_LEVEL_CALL':'MEMBER_ACCESS_FUNCTION_CALL',securityInterpretation:'DEFER_TO_REVIEWER',sourceCallsite});
          }
          if(['transfer','transferFrom','safeTransfer','safeTransferFrom','send'].includes(member)){
            pushValue({callerContractId,callerFunctionId:caller.functionId,flowKind:'TOKEN_OR_NATIVE_TRANSFER_CALL',memberOrName:member,interfaceOrType:interfaceType,
              sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'TRANSFER_LIKE_MEMBER_CALL',securityInterpretation:'DEFER_TO_REVIEWER',sourceCallsite});
          }
          if(member==='approve'||member==='safeApprove'||member==='forceApprove'){
            pushValue({callerContractId,callerFunctionId:caller.functionId,flowKind:'TOKEN_APPROVAL_CALL',memberOrName:member,interfaceOrType:interfaceType,
              sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'APPROVAL_LIKE_MEMBER_CALL',securityInterpretation:'DEFER_TO_REVIEWER',sourceCallsite});
          }
          if(lowLevelMember){
            // When this is already an external member call, it is the same AST expression.
            // Preserve the low-level basis on that one record rather than submitting it twice.
            if(!externalMemberCall){
              pushExternal({callerContractId,callerFunctionId:caller.functionId,targetContractId:null,targetFunctionId:null,interfaceOrType:interfaceType,
                memberOrName:member,sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'LOW_LEVEL_CALL',securityInterpretation:'DEFER_TO_REVIEWER',sourceCallsite});
            }
            if(member==='call'){
              pushValue({callerContractId,callerFunctionId:caller.functionId,flowKind:'LOW_LEVEL_CALL_POTENTIAL_VALUE_TRANSFER',memberOrName:member,interfaceOrType:interfaceType,
                sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'LOW_LEVEL_CALL',securityInterpretation:'DEFER_TO_REVIEWER',sourceCallsite});
            }
          }
        } else if(node.nodeType==='NewExpression'){
          const ref=Number.isInteger(node?.typeName?.referencedDeclaration)?node.typeName.referencedDeclaration:null;
          const targetContractId=Number.isInteger(ref)?(contractByAstId.get(`${unit.unitId}:${ref}`)??null):null;
          pushCall({callerContractId,callerFunctionId:caller.functionId,targetContractId,targetFunctionId:null,memberOrName:'new',
            callClass:'CONTRACT_CREATION',interfaceOrType:node?.typeDescriptions?.typeString??null,sourceLocation:callLoc,confidenceClass:'SOLIDITY_AST_CREATION_SYNTAX',basis:'NEW_EXPRESSION',
            sourceCallsite:{compilationUnitId:unit.unitId,sourcePath:sourceName,sourceDigestSha256:source?.sha256??null,
              astSourceSpan:typeof node.src==='string'?node.src:null,astNodeId:Number.isInteger(node.id)?node.id:null}});
        }
      });
    }
  }

  const dependencyEdges=[];
  const depSeen=new Set();
  for(const edge of callGraph){
    if(!edge.targetContractId||edge.targetContractId===edge.callerContractId)continue;
    const key=`${edge.callerContractId}->${edge.targetContractId}`; if(depSeen.has(key))continue; depSeen.add(key);
    dependencyEdges.push({edgeId:`DEP-${pad(dependencyEdges.length+1,4)}`,fromContractId:edge.callerContractId,toContractId:edge.targetContractId,
      relationship:'AST_RESOLVED_CALL_DEPENDENCY',status:'STRUCTURAL',basis:'NORMALIZED_CALL_GRAPH'});
  }
  const upgradeabilityEdges=[];
  for(const edge of callGraph.filter(x=>x.memberOrName==='delegatecall')){
    upgradeabilityEdges.push({edgeId:`UPGRADE-${pad(upgradeabilityEdges.length+1,4)}`,fromContractId:edge.callerContractId,toContractId:edge.targetContractId??null,
      relationship:'DELEGATECALL_CANDIDATE',status:'CANDIDATE',sourceLocation:edge.sourceLocation,basis:'LOW_LEVEL_DELEGATECALL_SYNTAX'});
  }

  const sourceIdentity={repository:request.source.repository,commit:request.source.commit,projectPath:request.source.projectPath,archivePath:request.source.archivePath??null,archiveSha256:request.source.archiveSha256??null,
    sourceTreeDigestSha256:digestCanonicalV1(sourceFiles.map(({path,language,sha256})=>({path,language,sha256})))};
  const buildCore={system:build.system??null,compilers:build.compilerProfiles?.length?clone(build.compilerProfiles):clone(request.configuration.compilers??[]),optimizer:clone(request.configuration.optimizer??null),evmVersion:request.configuration.evmVersion??null,
    viaIR:request.configuration.viaIR===true,compilationUnitCount:build.compilationUnits?.length??1,sourceFiles:sourceFiles.map(({path,language,sha256})=>({path,language,sha256})),
    artifacts:compilerArtifacts.map(({qualifiedName,abiDigestSha256,creationBytecodeDigestSha256,deployedBytecodeDigestSha256})=>({qualifiedName,abiDigestSha256,creationBytecodeDigestSha256,deployedBytecodeDigestSha256}))};
  const sbom=await generateBuildSbomV1({projectRoot,request,build:{compilerDescriptors:clone(request.configuration.compilers??[]),optimizer:clone(request.configuration.optimizer??null),evmVersion:request.configuration.evmVersion??null,viaIR:request.configuration.viaIR===true,sourceCommit:request.source.commit,artifacts:clone(build.artifacts??[])}});
  const slither=analysis.slither??null, detectors=Array.isArray(slither?.detectors)?slither.detectors:[];
  const limitations=[];
  const hasSolidityAsts=Object.keys(build.sourceAsts??{}).length>0||(build.compilationUnits??[]).some(unit=>Object.keys(unit.sourceAsts??{}).length>0);
  if (sourceFiles.some(x=>x.language==='SOLIDITY') && !hasSolidityAsts) limitations.push({limitationId:'SI-TECH-LIM-001',category:'SOLIDITY_AST_UNAVAILABLE',
    affectedSections:['inheritanceGraph','sourceAnchors','privilegeCandidates'],reason:'The admitted Solidity build did not expose source ASTs.',downstreamRequiredAction:'Carry the limitation; do not fabricate AST-derived facts.'});
  if (sourceFiles.some(x=>x.language==='VYPER')) limitations.push({limitationId:`SI-TECH-LIM-${pad(limitations.length+1)}`,category:'VYPER_AST_STRUCTURAL_LIMITATION',
    affectedSections:['inheritanceGraph','callGraph','privilegeCandidates','externalInterfaces','valueFlowCandidates','sourceAnchors','storageLayout'],reason:'Pinned Vyper build exposes ABI/bytecode but not equivalent AST/storage layout.',
    downstreamRequiredAction:'Preserve Vyper compiler facts and require semantic raw-source review.'});
  limitations.push({limitationId:`SI-TECH-LIM-${pad(limitations.length+1)}`,category:'SEMANTIC_CALL_AND_VALUE_FLOW_REVIEW_REQUIRED',
    affectedSections:['callGraph','externalInterfaces','valueFlowCandidates','protocolTopology'],reason:'AST-derived structural call/interface/value-flow candidates are generated, but business meaning, dynamic-dispatch resolution, trust implications and economic interpretation remain reviewer-owned.',
    downstreamRequiredAction:'Reviewer must verify and contextualize the generated structural edges without rebuilding the mechanical inventory.'});
  if (!slither || !['completed','completed_with_findings'].includes(slither.status)) limitations.push({limitationId:`SI-TECH-LIM-${pad(limitations.length+1)}`,category:'STATIC_RECON_LIMITATION',
    affectedSections:['staticRecon.slither'],reason:`Slither terminal status was ${slither?.status??'UNAVAILABLE'}.`,downstreamRequiredAction:'Carry exact analyzer limitation and raw evidence.'});

  const bundle={
    schemaVersion:'curveyield-v7-source-intelligence-technical-bundle-v1',artifactType:'SOURCE_INTELLIGENCE_TECHNICAL_BUNDLE',
    neutrality:{securityDisposition:'REVIEWER_REQUIRED',findingPromotion:'FORBIDDEN_BY_GENERATOR',statement:'Compiler/source/static facts and neutral candidates only; no finding, severity, exploitability, or trust conclusion.'},
    requestIdentity:{requestId:request.requestId,requestDigest:request.requestDigest,campaignId:request.campaignId,assignmentId:request.assignmentId,phaseId:request.phaseId,profileId:request.profileId},
    sourceIdentity,buildIdentity:{...buildCore,digestSha256:digestCanonicalV1(buildCore)},sourceFiles,compilerArtifacts,contracts,functions,storageLayout,inheritanceGraph,
    callGraph,privilegeCandidates,externalInterfaces,valueFlowCandidates,eventsAndErrors,sourceAnchors,
    securitySurfaces:[
      {surfaceId:'SURFACE-CALLABLE',surfaceClass:'CALLABLE_SURFACE',sourceIds:sourceFiles.map(x=>x.sourceId),contractIds:contracts.map(x=>x.contractId),functionIds:functions.filter(x=>x.visibility!=='STATE_INITIALIZER').map(x=>x.functionId),
        storageIds:storageLayout.map(x=>x.storageId),externalInterfaceIds:externalInterfaces.map(x=>x.externalInterfaceId),privilegeCandidateIds:privilegeCandidates.map(x=>x.candidateId),valueFlowCandidateIds:valueFlowCandidates.map(x=>x.valueFlowCandidateId),sourceAnchorIds:sourceAnchors.map(x=>x.anchorId),
        phase1Ownership:'STRUCTURAL_INVENTORY',laterPhaseTreatment:'REUSE_VERIFY_EXTEND_SEMANTICALLY',status:'CURRENT',basis:'ADMITTED_COMPILER_AND_AST_FACTS'},
      {surfaceId:'SURFACE-PRIVILEGE',surfaceClass:'PRIVILEGE_AND_ACCESS_CANDIDATES',sourceIds:sourceFiles.map(x=>x.sourceId),contractIds:[...new Set(privilegeCandidates.map(x=>x.contractId))],functionIds:[...new Set(privilegeCandidates.map(x=>x.functionId).filter(Boolean))],
        storageIds:[],externalInterfaceIds:[],privilegeCandidateIds:privilegeCandidates.map(x=>x.candidateId),valueFlowCandidateIds:[],sourceAnchorIds:[],phase1Ownership:'STRUCTURAL_INVENTORY',laterPhaseTreatment:'REVIEW_AUTHORITY_SEMANTICS',status:'CURRENT',basis:'AST_MODIFIER_CANDIDATES'},
      {surfaceId:'SURFACE-VALUE',surfaceClass:'VALUE_FLOW_CANDIDATES',sourceIds:sourceFiles.map(x=>x.sourceId),contractIds:[...new Set(valueFlowCandidates.map(x=>x.callerContractId))],functionIds:[...new Set(valueFlowCandidates.map(x=>x.callerFunctionId))],
        storageIds:[],externalInterfaceIds:externalInterfaces.map(x=>x.externalInterfaceId),privilegeCandidateIds:[],valueFlowCandidateIds:valueFlowCandidates.map(x=>x.valueFlowCandidateId),sourceAnchorIds:[],phase1Ownership:'STRUCTURAL_INVENTORY',laterPhaseTreatment:'REVIEW_VALUE_SEMANTICS',status:'CURRENT',basis:'AST_TRANSFER_APPROVAL_LOW_LEVEL_CALL_CANDIDATES'}
    ],
    protocolTopology:{upgradeabilityEdges,dependencyEdges,crossChainEdges:[],offchainAutomationEdges:[],topologyLimitations:['OFFCHAIN_AUTOMATION_AND_CROSS_CHAIN_RELATIONSHIPS_REQUIRE_PROJECT_FILE_REVIEW','DYNAMIC_DISPATCH_AND_BUSINESS_RELATIONSHIPS_REQUIRE_REVIEWER_CONTEXT']},
    staticRecon:{slither:{status:slither?.status??'UNAVAILABLE',version:slither?.version??null,rawEvidenceRef:slither?.rawArtifactRef??null,candidateCount:detectors.length,
      candidateIndex:detectors.map((d,i)=>({candidateId:`SLITHER-${pad(i+1,4)}`,check:d?.check??d?.description??d?.impact??'UNNAMED_DETECTOR',confidence:d?.confidence??null,impact:d?.impact??null,status:'NEUTRAL_ANALYZER_CANDIDATE'})),
      limitation:slither&&['completed','completed_with_findings'].includes(slither.status)?null:`SLITHER_${String(slither?.status??'UNAVAILABLE').toUpperCase()}`},
      sbom:{status:'COMPLETED',digestSha256:sbom.sbomDigest,sourceFileCount:sbom.sourceFiles?.length??0,dependencyFileCount:sbom.dependencyFiles?.length??0,artifactCount:sbom.artifacts?.length??0}},
    limitations,completion:{status:'TECHNICAL_BUNDLE_COMPLETE_WITH_TYPED_LIMITATIONS',exactSourceBound:true,exactBuildBound:true,staticReconAttached:slither!==null,secondSourceCheckoutPerformed:false,secondBuildPerformed:false,
      canonicalSourceIntelligenceProjectionOwner:'AUDIT_CONTROLLER',semanticReviewRequired:true}
  };
  return {...bundle,technicalBundleDigest:digestCanonicalV1(bundle)};
}



/**
 * Standalone v5 Phase-0 handoff enrichment. Reconcile already generated
 * compiler ABIs against the existing Source Review Inventory without inventing
 * inheritance resolution, write transitivity, Vyper semantic detectors or slots.
 *
 * Round 2 consumes effectiveEntrypoints; Rounds 3–5 consume stateDeclarations
 * and stateEffects; Round 11 reconciles the compiler ABI denominator.
 */
export function enrichSourceIntelligenceWithReviewInventoryV1({sourceIntelligence,reviewInventory,build,analysis={}}={}){
  const si=sourceIntelligence, review=reviewInventory?.payload;
  if(!si||!review||!build||build.status!=='completed')
    throw new Error('COMPILER_AND_SOURCE_REVIEW_EVIDENCE_REQUIRED_FOR_STAGE2');
  const sourceUnits=review.sourceUnits??[],decls=review.declarations??[],contexts=review.contexts??[];
  const tierByPath=new Map(sourceUnits.map(x=>[x.path,x.scopeTier]));
  const unitByPath=new Map(sourceUnits.map(x=>[x.path,x]));
  const abiByUnitQualified=new Map((build.artifacts??[]).map(a=>[
    (a.compilationUnitId??'default')+'|'+a.sourceName+':'+a.contractName,a
  ]));
  const normalSig=e=>e?.type==='function'?signature(e):
    e?.type==='receive'?'receive()':e?.type==='fallback'?'fallback()':String(e?.type??'UNRESOLVED_ABI_ITEM');
  const anchors=(ctx)=>ctx?.path&&Number.isInteger(ctx?.lineStart)&&ctx.lineStart>0
    ?ctx.path+':'+ctx.lineStart+'-'+(Number.isInteger(ctx.lineEnd)?ctx.lineEnd:ctx.lineStart):null;
  const publicState=(entry)=>entry?.stateMutability==='nonpayable'||entry?.stateMutability==='payable';
  const VYPER_CODES=new Set(['AVAILABLE_VYPER_AST','AVAILABLE_IDENTICAL_VYPER_AST_ALIAS']);
  const units=(Array.isArray(build.compilationUnits)&&build.compilationUnits.length)
    ?build.compilationUnits:[{unitId:'default',sourceAsts:build.sourceAsts??{}}];
  const sourceTier=(file)=>tierByPath.get(file)??'SOURCE_TIER_UNRESOLVED';
  // Source-review signatures sometimes contain Solidity contract/struct types
  // rather than canonical ABI tuple/address types. Match by name and arity
  // only if exactly one source implementation is possible, and preserve the
  // ABI selector as the dispatch identity.
  const methodName=(sig)=>String(sig??'').slice(0,String(sig??'').indexOf('('));
  const parameterCount=(sig)=>{
    const value=String(sig??''); const inner=value.slice(value.indexOf('(')+1,value.lastIndexOf(')'));
    if(!inner)return 0;
    let count=1,depth=0;
    for(const ch of inner){if(ch==='('||ch==='[')depth++;else if(ch===')'||ch===']')depth--;else if(ch===','&&depth===0)count++;}
    return count;
  };
  // Exact compiler AST permits a source-bound inherited implementation even
  // where the ZIP itself does not contain the dependency's source file.
  const compilerAstIndexByUnit=new Map();
  for(const unit of units){
    const byId=new Map(),byName=new Map();
    for(const [src,ast] of Object.entries(unit.sourceAsts??{})){
      function visit(node){
        if(!node||typeof node!=='object')return;
        if(node.nodeType==='ContractDefinition'){
          const item={node,path:src};
          if(Number.isInteger(node.id))byId.set(node.id,item);
          byName.set(src+':'+node.name,item);
        }
        for(const child of node.nodes??[])visit(child);
      }
      visit(ast);
    }
    compilerAstIndexByUnit.set(unit.unitId??'default',{byId,byName,unit});
  }
  const compiledImplementation=(artifact,entry)=>{
    if(!artifact||!artifact.sourceName?.endsWith('.sol')||entry.type!=='function')return null;
    const index=compilerAstIndexByUnit.get(artifact.compilationUnitId??'default');
    if(!index)return null;
    const root=index.byName.get(artifact.sourceName+':'+artifact.contractName);
    if(!root)return null;
    const selector=String(artifact.methodIdentifiers?.[signature(entry)]??'').replace(/^0x/,'').toLowerCase();
    const members=[];
    for(const id of root.node.linearizedBaseContracts??[root.node.id]){
      const b=index.byId.get(id);
      if(!b)continue;
      for(const f of b.node.nodes??[]){
        if(f.nodeType!=='FunctionDefinition'||!f.body||!['external','public'].includes(f.visibility))continue;
        const bySelector=selector&&String(f.functionSelector??'').replace(/^0x/,'').toLowerCase()===selector;
        const byNameArity=f.name===entry.name&&(f.parameters?.parameters??[]).length===(entry.inputs??[]).length;
        if(bySelector||byNameArity)members.push({f,b,bySelector});
      }
    }
    const strict=members.filter(m=>m.bySelector);
    let chosen=null;
    if(strict.length)chosen=strict[0];
    else if(members.length===1)chosen=members[0];
    else if(members.length>1){
      // Only the first linearized implementation is dispatchable if every
      // candidate has the same method identity and the compiler AST provides
      // the derivation order. Do not choose from ambiguous equal-arity overloads.
      const exactNames=new Set(members.map(m=>m.f.name));
      const sameArity=members.every(m=>(m.f.parameters?.parameters??[]).length===(entry.inputs??[]).length);
      if(exactNames.size===1&&sameArity)chosen=members[0];
    }
    if(!chosen)return null;
    const content=index.unit.sourceContents?.[chosen.b.path];
    if(typeof content!=='string')return null;
    const span=loc({path:chosen.b.path,content},chosen.f.src);
    if(!span)return null;
    return {kind:'COMPILER_AST_INHERITED_IMPLEMENTATION',path:chosen.b.path,
      sourceLocation:span.label,qualifiedContainer:chosen.b.path+':'+chosen.b.node.name,
      symbolId:'COMPILER-AST-'+sha256(Buffer.from([index.unit.unitId,chosen.b.path,
        String(chosen.f.id??''),signature(entry)].join('|'))).slice(0,20),
      lineStart:span.startLine,lineEnd:span.endLine,
      evidenceClass:'SOURCE_BOUND_COMPILER_AST_INHERITANCE_METHOD_SELECTOR_OR_UNIQUE_ARITY'};
  };

  const stateKinds=new Set(['STATE_VARIABLE','IMMUTABLE','CONSTANT']);
  const effects=contexts.filter(c=>Array.isArray(c.stateReads)&&Array.isArray(c.stateWrites))
    .filter(c=>c.stateReads.length||c.stateWrites.length)
    .map(c=>({
      contextId:c.contextId,symbolId:c.symbolId,sourcePath:c.path,
      qualifiedContainer:c.qualifiedContainer,signature:c.canonicalSignature,
      kind:c.kind,sourceTier:c.scopeTier,sourceLocation:anchors(c),
      effectiveIn:(c.effectiveIn??[]).slice().sort(),
      directlyObservedStateReads:c.stateReads.slice().sort(),
      directlyObservedStateWrites:c.stateWrites.slice().sort(),
      readEvidenceStatus:VYPER_CODES.has(unitByPath.get(c.path)?.astStatus)?
        'VYPER_AST_REFERENCES_INCLUDE_ASSIGNMENT_TARGETS':'SOLIDITY_AST_STRUCTURAL',
      writeEvidenceStatus:VYPER_CODES.has(unitByPath.get(c.path)?.astStatus)?
        'VYPER_COMPILER_AST_STRUCTURAL_ONLY':'SOLIDITY_AST_STRUCTURAL',
      transitiveInternalEffects:'NOT_EXPANDED',
      interpretation:'LOCAL_FUNCTION_SYNTAX_ONLY_NOT_PROOF_OF_REACHABLE_MUTATION'
    }))
    .sort((a,b)=>a.sourcePath.localeCompare(b.sourcePath)||String(a.sourceLocation).localeCompare(String(b.sourceLocation))||
      a.signature.localeCompare(b.signature));

  const declarations=decls.filter(d=>stateKinds.has(d.kind)).map(d=>({
    symbolId:d.symbolId,sourcePath:d.path,qualifiedContainer:d.qualifiedContainer,
    name:d.name,kind:d.kind,visibility:d.visibility,
    sourceTier:sourceTier(d.path),sourceLocation:anchors(d),
    compilerType:null,slot:null,offset:null,
    compilerLayoutStatus:d.kind==='STATE_VARIABLE'?'NOT_EMITTED_OR_UNRESOLVED':'NOT_APPLICABLE_NON_STORAGE',
    evidenceClass:'SOURCE_REVIEW_SOLIDITY_AST_DECLARATION_NOT_SLOT_DATA'
  }));
  const vyperAnalyses=(analysis.slither?.analyzerCoverage??[])
    .map(x=>x.vyperAnalysis).filter(Boolean);
  for(const vyper of vyperAnalyses){
    const exactSource=si.sourceFiles?.find(x=>x.path===vyper.sourceName);
    if(!exactSource||exactSource.sha256!==vyper.sourceSha256)
      throw new Error('STAGE2_VYPER_AST_ADMITTED_SOURCE_HASH_MISMATCH: '+vyper.sourceName);
    for(const d of vyper.stateDeclarations??[]){
      if(!d.name||!Number.isInteger(d.line)||d.line<1)continue;
      declarations.push({
        symbolId:'VYPER-DECL-'+sha256(Buffer.from(vyper.sourceName+'|'+d.name+'|'+d.line)).slice(0,20),
        sourcePath:vyper.sourceName,qualifiedContainer:vyper.sourceName+':'+path.posix.basename(vyper.sourceName,'.vy'),
        name:d.name,kind:d.kind,visibility:d.visibility,sourceTier:sourceTier(vyper.sourceName),
        sourceLocation:vyper.sourceName+':'+d.line+'-'+d.line,
        compilerType:null,typeAnnotationSyntax:d.annotationSyntax??null,
        slot:null,offset:null,
        compilerLayoutStatus:d.kind==='STATE_VARIABLE'?'NOT_EMITTED_OR_UNRESOLVED':'NOT_APPLICABLE_NON_STORAGE',
        evidenceClass:'VYPER_COMPILER_AST_MODULE_DECLARATION_SOURCE_TEXT_NOT_LAYOUT'
      });
    }
  }
  // Project exact Vyper 0.4.x compiler-produced layout, not guessed storage
  // indices. The raw compiler layout is retained in the build artifact.
  for(const artifact of build.artifacts??[]){
    const raw=artifact.vyperCompilerLayout?.storage_layout;
    if(!raw||!artifact.sourceName?.endsWith('.vy'))continue;
    const contract=si.contracts?.find(c=>c.sourcePath===artifact.sourceName&&
      c.qualifiedName===artifact.sourceName+':'+artifact.contractName&&
      c.compilationUnitId===(artifact.compilationUnitId??'default'));
    if(!contract)continue;
    for(const [name,item] of Object.entries(raw)){
      if(!item||typeof item!=='object'||item.slot===undefined||item.slot===null)continue;
      const state=declarations.find(d=>d.sourcePath===artifact.sourceName&&
        d.name===name&&d.kind==='STATE_VARIABLE');
      if(state){
        state.slot=String(item.slot);state.offset='0';
        state.compilerType=typeof item.type==='string'?item.type:state.typeAnnotationSyntax??null;
        state.compilerLayoutStatus='COMPILER_EMITTED';
        state.evidenceClass='VYPER_0_4_3_COMPILER_LAYOUT_PLUS_SOURCE_DECLARATION';
      }
      si.storageLayout??=[];
      si.storageLayout.push({
        storageId:'STORE-'+pad(si.storageLayout.length+1,4),
        contractId:contract.contractId,label:name,slot:String(item.slot),offset:'0',
        type:typeof item.type==='string'?item.type:null,
        nSlots:Number.isInteger(item.n_slots)?item.n_slots:null,
        sourceLocation:state?.sourceLocation??'VYPER_LAYOUT_DECLARATION_NOT_SOURCE_MATCHED',
        status:'CURRENT',confidenceClass:'COMPILER_FACT',basis:'VYPER_EXACT_COMPILER_STORAGE_LAYOUT'
      });
    }
  }
  const declarationsByKey=new Map();
  for(const d of declarations){
    const key=[d.sourcePath,d.qualifiedContainer,d.name].join('|');
    const items=declarationsByKey.get(key)??[];items.push(d);declarationsByKey.set(key,items);
  }

  const seenTypes=new Set();
  for(const unit of units){
    for(const [sourcePath,ast] of Object.entries(unit.sourceAsts??{})){
      function inspect(node,container=null){
        if(!node||typeof node!=='object')return;
        if(Array.isArray(node)){for(const n of node)inspect(n,container);return;}
        const active=node.nodeType==='ContractDefinition'?sourcePath+':'+node.name:container;
        if(node.nodeType==='VariableDeclaration'&&node.stateVariable===true&&active){
          const key=[sourcePath,active,node.name].join('|');
          const candidates=declarationsByKey.get(key)??[];
          const type=node.typeDescriptions?.typeString??node.typeName?.typeDescriptions?.typeString??null;
          const tag=key+'|'+type;
          if(!seenTypes.has(tag)){
            for(const d of candidates){if(type)d.compilerType=type;}
            seenTypes.add(tag);
          }
        }
        if(node.nodeType==='SourceUnit'||node.nodeType==='ContractDefinition'){
          for(const child of node.nodes??[])inspect(child,active);
        }
      }
      inspect(ast);
    }
  }
  for(const a of build.artifacts??[]){
    for(const state of a.storageLayout?.storage??[]){
      const key=[a.sourceName,a.sourceName+':'+a.contractName,state.label].join('|');
      for(const d of declarationsByKey.get(key)??[]){
        if(d.kind!=='STATE_VARIABLE')continue;
        d.slot=String(state.slot??'');d.offset=String(state.offset??'');
        d.compilerType=a.storageLayout?.types?.[state.type]?.label??d.compilerType??state.type??null;
        d.compilerLayoutStatus='COMPILER_EMITTED';
        d.evidenceClass='COMPILER_STORAGE_LAYOUT_PLUS_SOURCE_DECLARATION';
      }
    }
  }
  const effectiveEntrypoints=[];
  const inScopeContracts=[];
  for(const c of si.contracts??[]){
    const sourcePath=c.sourcePath??String(c.qualifiedName).split(':')[0];
    c.sourceTier=sourceTier(sourcePath);
    if(c.deployability!=='DEPLOYABLE'||c.sourceTier!=='IN_SCOPE')continue;
    inScopeContracts.push(c.contractId);
    const key=(c.compilationUnitId??'default')+'|'+c.qualifiedName;
    const a=abiByUnitQualified.get(key);
    if(!a)throw new Error('STAGE2_COMPILER_ARTIFACT_IDENTITY_MISMATCH: '+key);
    const candidateContexts=contexts.filter(x=>Array.isArray(x.effectiveIn)&&x.effectiveIn.includes(c.qualifiedName));
    for(const entry of (a.abi??[]).filter(x=>['function','fallback','receive'].includes(x?.type))){
      const canonical=normalSig(entry);
      const fn=(si.functions??[]).find(x=>x.contractId===c.contractId&&x.signature===canonical);
      const allowedKinds=new Set(['FUNCTION','GENERATED_GETTER','INHERITED_DEPENDENCY','FALLBACK','RECEIVE']);
      const exact=candidateContexts.filter(x=>x.canonicalSignature===canonical&&allowedKinds.has(x.kind));
      const preferred=exact.filter(x=>x.qualifiedContainer===c.qualifiedName);
      let matches=preferred.length?preferred:exact;
      let matchBasis='EXACT_CANONICAL_SIGNATURE';
      if(!matches.length&&entry.type==='function'){
        const sameName=candidateContexts.filter(x=>allowedKinds.has(x.kind)&&
          methodName(x.canonicalSignature)===entry.name);
        const arityMatches=sameName.filter(x=>parameterCount(x.canonicalSignature)===(entry.inputs??[]).length);
        const primary=arityMatches.filter(x=>x.qualifiedContainer===c.qualifiedName);
        matches=primary.length?primary:arityMatches;
        if(matches.length===1)matchBasis='SOURCE_NAME_AND_ARITY_UNIQUE';
        else if(!matches.length&&c.language==='VYPER'){
          // Vyper @external functions may expose shorter compiler ABI variants
          // for defaulted trailing parameters, all backed by one FunctionDef.
          const vyperDefault=sameName.filter(x=>x.qualifiedContainer===c.qualifiedName&&
            parameterCount(x.canonicalSignature)>=(entry.inputs??[]).length);
          if(vyperDefault.length===1){
            matches=vyperDefault;
            matchBasis='VYPER_DEFAULT_ARGUMENT_ABI_VARIANT';
          }
        }
      }
      let unique=new Map(matches.map(x=>[x.symbolId??x.contextId,x]));
      let selected=unique.size===1?[...unique.values()][0]:null;
      if(!selected&&unique.size===0&&entry.type==='function'){
        // Public mappings/arrays generate parameterized ABI getters; their
        // declaration is the source implementation, not a no-arg getter body.
        const getters=c.language==='VYPER'?si.stateDeclarations:decls;
        const getterCandidates=(getters??[]).filter(d=>d.kind==='STATE_VARIABLE'&&d.visibility==='public'&&
          d.name===entry.name&&d.qualifiedContainer===c.qualifiedName);
        if(getterCandidates.length===1){
          const d=getterCandidates[0];
          selected={...d,path:d.path,kind:'GENERATED_GETTER',
            contextId:null,sourceLocation:anchors(d)};
          matchBasis='PUBLIC_STATE_COMPILER_ABI_GETTER';
        }
      }
      let compilerInherited=null;
      if(!selected&&unique.size===0&&c.language==='SOLIDITY'&&entry.type==='function'){
        compilerInherited=compiledImplementation(a,entry);
        if(compilerInherited){selected=compilerInherited;matchBasis='EXACT_BUILD_COMPILER_AST_INHERITANCE';}
      }
      const origin=selected?(selected.kind==='GENERATED_GETTER'?'GENERATED_GETTER':
        selected.kind==='COMPILER_AST_INHERITED_IMPLEMENTATION'?'INHERITED_IMPLEMENTATION':
        selected.qualifiedContainer===c.qualifiedName?'DIRECT_IMPLEMENTATION':'INHERITED_IMPLEMENTATION'):
        unique.size>1?'AMBIGUOUS_DECLARATIONS':'ABI_ONLY_DECLARATION_UNRESOLVED';
      const sourceLocation=anchors(selected)??selected?.sourceLocation??
        (fn?.sourceLocation!=='UNSUPPORTED_AST_SOURCE_LOCATION'?fn?.sourceLocation:null)??null;
      const evidenceClass=selected?.evidenceClass??(selected?.path?.endsWith('.vy')?
        'VYPER_COMPILER_AST_STRUCTURAL_ONLY':
        selected?'SOLIDITY_SOURCE_REVIEW_AST_WITH_COMPILER_ABI':'COMPILER_ABI_ONLY');
      const methodSignature=entry.type==='function'?canonical:null;
      const rawSelector=methodSignature?a.methodIdentifiers?.[methodSignature]:null;
      const selector=typeof rawSelector==='string'&&/^(?:0x)?[0-9a-fA-F]{8}$/.test(rawSelector)
        ?'0x'+rawSelector.replace(/^0x/,'').toLowerCase():fn?.selector??null;
      if(fn&&c.language==='VYPER'&&selected&&fn.sourceLocation==='UNSUPPORTED_AST_SOURCE_LOCATION'){
        fn.sourceLocation=sourceLocation;
        fn.basis='COMPILER_ABI_AND_VYPER_COMPILER_AST_STRUCTURAL';
        fn.sourceLocationEvidenceClass='VYPER_COMPILER_AST_STRUCTURAL_ONLY';
        const file=si.sourceFiles?.find(f=>f.path===selected.path);
        if(file&&Number.isInteger(selected.lineStart)){
          si.sourceAnchors??=[];
          si.sourceAnchors.push({
            anchorId:'ANCHOR-'+pad(si.sourceAnchors.length+1,4),sourceId:file.sourceId,
            symbolId:fn.functionId,startLine:selected.lineStart,endLine:selected.lineEnd??selected.lineStart,
            sourceDigestSha256:file.sha256,basis:'VYPER_COMPILER_AST_STRUCTURAL_ONLY'});
        }
      }
      effectiveEntrypoints.push({
        entrypointId:'ENTRY-'+pad(effectiveEntrypoints.length+1,5),
        contractId:c.contractId,artifactId:c.artifactId,
        compilationUnitId:c.compilationUnitId,qualifiedContract:c.qualifiedName,contractSourcePath:sourcePath,
        sourceTier:c.sourceTier,language:c.language,abiType:entry.type,
        canonicalSignature:canonical,selector,selectorStatus:selector?'COMPILER_PROVIDED':'UNAVAILABLE',
        stateMutability:entry.stateMutability??null,stateChanging:publicState(entry),
        implementationOrigin:origin,implementationSymbolId:selected?.symbolId??null,
        implementationContextId:selected?.contextId??null,
        implementationContract:selected?.qualifiedContainer??null,
        implementationPath:selected?.path??null,sourceLocation,
        evidenceClass,implementationMatchBasis:matchBasis,
        implementationCandidateCount:unique.size || (selected?1:0),
        auditFlowAssignment:'REQUIRED_FOR_STATE_CHANGING_ENTRIES',
        caveat:'ABI is an exposed interface, not proof of live deployment/reachability or security'
      });
    }
  }
  // ABI records are not the entire function-body inventory. Retain Vyper
  // compiler-AST source functions (especially internal helpers) that do not
  // appear as independently callable ABI entries, with unresolved parameter
  // signatures explicitly labeled. No selector or ABI reachability is invented.
  let vyperSourceOnlyFunctionRecords=0;
  for(const ctx of contexts.filter(c=>c.analyzer==='VYPER_0_4_3_SOURCE_BOUND_COMPILER_AST'&&
      c.kind==='FUNCTION')){
    const contract=si.contracts?.find(c=>c.language==='VYPER'&&c.qualifiedName===ctx.qualifiedContainer);
    if(!contract)continue;
    if(si.functions.some(f=>f.contractId===contract.contractId&&f.signature===ctx.canonicalSignature))
      continue;
    const id='FUNC-'+pad(si.functions.length+1,4);
    const source=si.sourceFiles.find(x=>x.path===ctx.path);
    si.functions.push({
      functionId:id,contractId:contract.contractId,signature:ctx.canonicalSignature,
      selector:null,visibility:ctx.visibility,
      stateMutability:ctx.stateMutability,payable:ctx.stateMutability==='payable',
      modifiers:ctx.modifiers??[],sourceLocation:anchors(ctx),
      signatureStatus:'VYPER_SOURCE_ONLY_NAME_PARAMETERS_NOT_ABI_VERIFIED',
      confidenceClass:'VYPER_COMPILER_AST_STRUCTURAL_ONLY',
      basis:'VYPER_AST_FUNCTION_DEFINITION_NOT_AN_ABI_ENTRYPOINT'
    });
    if(source&&Number.isInteger(ctx.lineStart)){
      si.sourceAnchors.push({
        anchorId:'ANCHOR-'+pad(si.sourceAnchors.length+1,4),sourceId:source.sourceId,
        symbolId:id,startLine:ctx.lineStart,endLine:ctx.lineEnd??ctx.lineStart,
        sourceDigestSha256:source.sha256,basis:'VYPER_COMPILER_AST_STRUCTURAL_ONLY'
      });
    }
    vyperSourceOnlyFunctionRecords++;
  }
  const effectsBySymbol=new Map(effects.map(e=>[e.symbolId,e]));
  for(const e of effectiveEntrypoints){
    const effect=effectsBySymbol.get(e.implementationSymbolId);
    e.localStateReadCount=effect?.directlyObservedStateReads.length??0;
    e.localStateWriteCount=effect?.directlyObservedStateWrites.length??0;
    e.stateEffectEvidenceStatus=effect?effect.writeEvidenceStatus:'NO_MATCHED_IMPLEMENTATION_CONTEXT';
  }
  // Vyper's compiler AST is available through the existing review-inventory
  // provenance. Surface explicitly categorized call candidates beside Solidity's
  // call graph without claiming an inferred target or a semantic value transfer.
  const vyperContextCandidates=contexts.filter(c=>c.path?.endsWith('.vy')&&
    Array.isArray(c.externalCalls)&&c.externalCalls.length>0);
  const vyperDedup=new Set();
  for(const ctx of vyperContextCandidates){
    const contract=si.contracts?.find(c=>c.qualifiedName===ctx.qualifiedContainer&&c.language==='VYPER');
    const fn=si.functions?.find(f=>f.contractId===contract?.contractId&&f.signature===ctx.canonicalSignature);
    if(!contract||!fn)continue;
    for(const call of ctx.externalCalls){
      const member=String(call.memberName??'UNKNOWN_VYPER_OPERATION');
      const line=Number.isInteger(call.line)?call.line:ctx.lineStart;
      const key=[fn.functionId,line,member].join('|');
      if(vyperDedup.has(key))continue;vyperDedup.add(key);
      const sourceLocation=ctx.path+':'+line+'-'+line;
      const externalMessageCall=['VYPER_EXTCALL','VYPER_STATICCALL','VYPER_BUILTIN_EXTERNAL_CALL']
        .includes(call.callKind)||member==='raw_call'||member==='send'||member==='delegatecall'||
        member==='extcall'||member==='staticcall'||member.startsWith('extcall.')||member.startsWith('staticcall.');
      si.callGraph.push({
        callEdgeId:'CALL-'+pad(si.callGraph.length+1,4),
        callerContractId:contract.contractId,callerFunctionId:fn.functionId,
        targetContractId:null,targetFunctionId:null,memberOrName:member,
        callClass:externalMessageCall?'VYPER_AST_EXTERNAL_OPERATION_UNRESOLVED':'VYPER_AST_BUILTIN_OR_SENSITIVE_OPERATION',
        vyperCallKind:call.callKind??null,
        interfaceOrType:call.targetType??null,sourceLocation,
        confidenceClass:'VYPER_COMPILER_AST_STRUCTURAL_ONLY',
        basis:'VYPER_AST_SENSITIVE_CALL_CONTEXT',
        sourceCallsite:{sourcePath:ctx.path,sourceDigestSha256:si.sourceFiles?.find(x=>x.path===ctx.path)?.sha256??null,
          compilerLanguage:'VYPER',sourceLine:line}
      });
      if(externalMessageCall)si.externalInterfaces.push({
        externalInterfaceId:'EXT-'+pad(si.externalInterfaces.length+1,4),
        callerContractId:contract.contractId,callerFunctionId:fn.functionId,
        targetContractId:null,targetFunctionId:null,memberOrName:member,
        interfaceOrType:call.targetType??null,sourceLocation,status:'CANDIDATE',
        vyperCallKind:call.callKind??null,
        confidenceClass:'VYPER_COMPILER_AST_STRUCTURAL_ONLY',
        basis:'VYPER_AST_SENSITIVE_CALL_CONTEXT',securityInterpretation:'DEFER_TO_REVIEWER',
        sourceCallsite:{sourcePath:ctx.path,sourceLine:line}
      });
    }
  }
  const mutating=effectiveEntrypoints.filter(e=>e.stateChanging);
  const sourceOnly=effectiveEntrypoints.filter(e=>e.implementationOrigin==='ABI_ONLY_DECLARATION_UNRESOLVED'||
    e.implementationOrigin==='AMBIGUOUS_DECLARATIONS');
  const unitQualifiedGroups=new Map();
  for(const c of si.contracts??[]){
    const list=unitQualifiedGroups.get(c.qualifiedName)??[];
    list.push(c.compilationUnitId);unitQualifiedGroups.set(c.qualifiedName,list);
  }
  si.effectiveEntrypoints=effectiveEntrypoints;
  si.stateDeclarations=declarations.sort((a,b)=>a.sourcePath.localeCompare(b.sourcePath)||
    String(a.sourceLocation).localeCompare(String(b.sourceLocation))||a.name.localeCompare(b.name));
  si.stateEffects=effects;
  si.stage2Coverage={
    schemaVersion:'curveyield-stage2-structural-coverage-v1',
    inputReviewInventory:'REVIEW_INVENTORY_v1.json',
    sourceSha256:reviewInventory.sourceSha256,
    inScopeDeployableContractIds:inScopeContracts,
    inScopeDeployableContracts:inScopeContracts.length,
    effectiveAbiCallableCount:effectiveEntrypoints.length,
    stateChangingEffectiveEntrypointCount:mutating.length,
    inheritedEntrypointCount:effectiveEntrypoints.filter(e=>e.implementationOrigin==='INHERITED_IMPLEMENTATION').length,
    vyperEntrypointCount:effectiveEntrypoints.filter(e=>e.language==='VYPER').length,
    vyperStructuralCallCandidates:vyperDedup.size,
    vyperSourceOnlyFunctionRecords,
    vyperSourceStateDeclarationCount:declarations.filter(d=>d.evidenceClass?.startsWith('VYPER_COMPILER_AST_MODULE_DECLARATION')).length,
    unresolvedImplementationEntrypoints:sourceOnly.length,
    unresolvedStateChangingEntrypoints:mutating.filter(e=>sourceOnly.includes(e)).length,
    compilerLayoutStateDeclarationCount:declarations.filter(d=>d.compilerLayoutStatus==='COMPILER_EMITTED').length,
    sourceStateDeclarationCount:declarations.length,
    localStateEffectContextCount:effects.length,
    duplicateQualifiedContractsAcrossCompilationUnits:[...unitQualifiedGroups.entries()]
      .filter(([,arr])=>new Set(arr).size>1).map(([name,arr])=>({name,units:[...new Set(arr)].sort()})),
    limitations:[
      'Effective ABI inventory is a coverage denominator, not proof of deployed code or invocation reachability.',
      'State effects are direct AST/source-context observations, not transitive inter-contract effects.',
      'No storage slot is claimed when the exact compiler does not emit storage layout.',
      'Vyper compiler AST references are not proven reads (assignment targets included), and Slither semantic detector coverage remains unavailable.',
      'Unresolved declaration matches must be traced directly by the auditor.',
      'Scope is based on review-inventory tiers and deployability, not inferred from names or fee relationships.'
    ]
  };
  si.limitations??=[];
  si.limitations.push({category:'STAGE2_NORMALIZED_EVIDENCE_SEMANTICS',
    affectedSections:['effectiveEntrypoints','stateDeclarations','stateEffects'],
    reason:'Compiler-ABI and source-context join is structural only. Missing and ambiguous origins are recorded.',
    downstreamRequiredAction:'Reviewer assigns actual flows and assesses real value/state/security semantics.'});
  const {technicalBundleDigest,...withoutDigest}=si;
  si.technicalBundleDigest=digestCanonicalV1(withoutDigest);
  return si;
}

function slitherParentChainV1(element) {
  const chain = [];
  let current = element;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    chain.push(current);
    current = current.type_specific_fields?.parent ?? null;
  }
  return chain;
}
function slitherSourceLinesV1(element) {
  const lines = element?.source_mapping?.lines;
  return Array.isArray(lines) ? lines.filter(x => Number.isInteger(x) && x > 0) : [];
}
function parseInventoryLocationV1(location) {
  const match = String(location ?? '').match(/^(.+):(\d+)-(\d+)$/);
  return match ? { path: match[1], start: Number(match[2]), end: Number(match[3]) } : null;
}
function slitherImpactRankV1(value) {
  return ({ Critical: 4, High: 3, Medium: 2, Low: 1, Informational: 0 })[value] ?? -1;
}
function slitherConfidenceRankV1(value) {
  return ({ High: 3, Medium: 2, Low: 1 })[value] ?? 0;
}

function stableSlitherCandidateIdV1(detector) {
  const elements = (detector?.elements ?? []).map(element => {
    const chain = slitherParentChainV1(element);
    const functionElement = chain.find(x => x.type === 'function') ?? null;
    const contractElement = chain.find(x => x.type === 'contract') ?? null;
    return {
      type: element?.type ?? null,
      name: element?.name ?? null,
      sourcePath: element?.source_mapping?.filename_relative ?? null,
      lines: slitherSourceLinesV1(element),
      functionSignature: functionElement?.type_specific_fields?.signature ?? null,
      contractName: contractElement?.name ?? null
    };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const fingerprint = {
    check: detector?.check ?? null,
    impact: detector?.impact ?? null,
    confidence: detector?.confidence ?? null,
    description: String(detector?.description ?? '').replace(/\s+/g, ' ').trim(),
    elements
  };
  return 'SLITHER-' + digestCanonicalV1(fingerprint).slice(0, 16);
}

/**
 * Stage 3: project raw Slither detectors onto the existing source inventory,
 * effective ABI entrypoints and AST call graph. Navigation/triage only; no
 * analyzer observation is promoted to a security finding and no F# is assigned.
 */
export function buildSlitherFlowPrioritizationV1({ sourceIntelligence, reviewInventory, slither } = {}) {
  const si = sourceIntelligence;
  const review = reviewInventory?.payload;
  if (!si || !review || !Array.isArray(review.sourceUnits)) {
    throw new Error('STAGE3_SOURCE_REVIEW_INVENTORY_REQUIRED');
  }

  const detectors = Array.isArray(slither?.detectors) ? slither.detectors : [];
  const contracts = si.contracts ?? [];
  const functions = si.functions ?? [];
  const contexts = review.contexts ?? [];
  const effectiveEntrypoints = si.effectiveEntrypoints ?? [];
  const sourceTierByPath = new Map(review.sourceUnits.map(x => [x.path, x.scopeTier]));
  const contractByQualifiedName = new Map(contracts.map(x => [x.qualifiedName, x]));
  const contractById = new Map(contracts.map(x => [x.contractId, x]));
  const contractByPathAndName = new Map();
  const contractByPath = new Map();

  for (const contract of contracts) {
    const name = String(contract.qualifiedName ?? '').split(':').pop();
    const key = String(contract.sourcePath ?? '') + '|' + name;
    const named = contractByPathAndName.get(key) ?? [];
    named.push(contract);
    contractByPathAndName.set(key, named);
    const samePath = contractByPath.get(contract.sourcePath) ?? [];
    samePath.push(contract);
    contractByPath.set(contract.sourcePath, samePath);
  }

  const functionsByContractSignature = new Map();
  for (const fn of functions) {
    const key = String(fn.contractId ?? '') + '|' + String(fn.signature ?? '');
    const matches = functionsByContractSignature.get(key) ?? [];
    matches.push(fn);
    functionsByContractSignature.set(key, matches);
  }

  const contextById = new Map(contexts.map(x => [x.contextId, x]));
  const stateEffects = si.stateEffects ?? [];
  const privilegeCandidates = si.privilegeCandidates ?? [];
  const valueFlowCandidates = si.valueFlowCandidates ?? [];
  const incomingEdges = new Map();

  for (const edge of si.callGraph ?? []) {
    if (!edge?.targetFunctionId || !edge?.callerFunctionId) continue;
    const rows = incomingEdges.get(edge.targetFunctionId) ?? [];
    rows.push(edge);
    incomingEdges.set(edge.targetFunctionId, rows);
  }
  for (const rows of incomingEdges.values()) {
    rows.sort((a, b) => String(a.callEdgeId ?? '').localeCompare(String(b.callEdgeId ?? '')));
  }

  const entrypointsByFunctionId = new Map();
  const entrypointsByContractSignature = new Map();
  const addEntrypoint = (map, key, entrypoint) => {
    const rows = map.get(key) ?? [];
    if (!rows.some(x => x.entrypointId === entrypoint.entrypointId)) rows.push(entrypoint);
    map.set(key, rows);
  };

  for (const entrypoint of effectiveEntrypoints) {
    const implementationContract = contractByQualifiedName.get(entrypoint.implementationContract ?? entrypoint.qualifiedContract);
    const implementationContractId = implementationContract?.contractId ?? entrypoint.contractId;
    const signature = entrypoint.canonicalSignature;
    addEntrypoint(entrypointsByContractSignature, String(entrypoint.contractId) + '|' + signature, entrypoint);
    addEntrypoint(entrypointsByContractSignature, String(implementationContractId) + '|' + signature, entrypoint);

    const candidates = functionsByContractSignature.get(String(implementationContractId) + '|' + signature) ??
      functionsByContractSignature.get(String(entrypoint.contractId) + '|' + signature) ?? [];
    if (candidates.length === 1) {
      addEntrypoint(entrypointsByFunctionId, candidates[0].functionId, entrypoint);
      continue;
    }

    const context = contextById.get(entrypoint.implementationContextId);
    if (context?.canonicalSignature) {
      const contextContract = contracts.find(x => x.qualifiedName === context.qualifiedContainer);
      const contextFunctions = functionsByContractSignature.get(String(contextContract?.contractId ?? implementationContractId) + '|' + context.canonicalSignature) ?? [];
      if (contextFunctions.length === 1) addEntrypoint(entrypointsByFunctionId, contextFunctions[0].functionId, entrypoint);
    }
  }

  function traceEntrypointsFromFunction(functionId) {
    if (!functionId) return { paths: [], truncated: false, expanded: 0, attempted: false };
    const queue = [{ functionId, reverseEdges: [], depth: 0 }];
    const visited = new Set([functionId]);
    const found = new Map();
    let expanded = 0;
    let truncated = false;

    while (queue.length && expanded < 10000) {
      const current = queue.shift();
      expanded++;
      for (const entrypoint of entrypointsByFunctionId.get(current.functionId) ?? []) {
        if (!found.has(entrypoint.entrypointId)) {
          const orderedEdges = current.reverseEdges.slice().reverse();
          found.set(entrypoint.entrypointId, {
            entrypointId: entrypoint.entrypointId,
            canonicalSignature: entrypoint.canonicalSignature,
            qualifiedContract: entrypoint.qualifiedContract,
            stateChanging: entrypoint.stateChanging === true,
            implementationOrigin: entrypoint.implementationOrigin,
            connectionType: orderedEdges.length ? 'SOURCE_CALL_GRAPH_PATH_CANDIDATE' : 'DIRECT_FUNCTION_MATCH',
            callPath: orderedEdges.map(edge => ({
              callEdgeId: edge.callEdgeId ?? null,
              callerFunctionId: edge.callerFunctionId,
              targetFunctionId: edge.targetFunctionId,
              memberOrName: edge.memberOrName ?? null,
              callClass: edge.callClass ?? null,
              sourceLocation: edge.sourceLocation ?? null,
              confidenceClass: edge.confidenceClass ?? null
            }))
          });
        }
      }

      const inbound = incomingEdges.get(current.functionId) ?? [];
      if (current.depth >= 12) {
        if (inbound.length) truncated = true;
        continue;
      }
      for (const edge of inbound) {
        const callerId = edge.callerFunctionId;
        if (!callerId || visited.has(callerId)) continue;
        visited.add(callerId);
        queue.push({
          functionId: callerId,
          reverseEdges: [...current.reverseEdges, edge],
          depth: current.depth + 1
        });
      }
    }
    if (queue.length) truncated = true;
    return {
      paths: [...found.values()].sort((a, b) => a.entrypointId.localeCompare(b.entrypointId)),
      truncated,
      expanded,
      attempted: true
    };
  }

  function resolveContract(sourcePath, contractName, functionRecord) {
    if (functionRecord?.contractId && contractById.has(functionRecord.contractId)) {
      return contractById.get(functionRecord.contractId);
    }
    if (contractName) {
      const matches = contractByPathAndName.get(String(sourcePath) + '|' + String(contractName)) ?? [];
      if (matches.length === 1) return matches[0];
    }
    const samePath = contractByPath.get(sourcePath) ?? [];
    return samePath.length === 1 ? samePath[0] : null;
  }

  function resolveFunction(sourcePath, contract, signature, functionName, lineStart, lineEnd) {
    if (contract?.contractId && signature) {
      const exact = functionsByContractSignature.get(String(contract.contractId) + '|' + signature) ?? [];
      if (exact.length === 1) return exact[0];
    }
    if (signature) {
      const matches = functions.filter(fn => {
        if (fn.signature !== signature) return false;
        const location = parseInventoryLocationV1(fn.sourceLocation);
        return location?.path === sourcePath &&
          (!lineStart || (location.start <= lineEnd && location.end >= lineStart));
      });
      if (matches.length === 1) return matches[0];
    }
    if (functionName && lineStart) {
      const matches = functions.filter(fn => {
        if (!String(fn.signature ?? '').startsWith(functionName + '(')) return false;
        const location = parseInventoryLocationV1(fn.sourceLocation);
        return location?.path === sourcePath &&
          location.start <= lineEnd && location.end >= lineStart;
      });
      if (matches.length === 1) return matches[0];
    }
    return null;
  }

  const priorityRank = {
    P1_FLOW_LINKED_HIGH_IMPACT: 1,
    P2_FLOW_OR_HIGH_IMPACT: 2,
    P3_IN_SCOPE_CONTEXT: 3,
    P4_DEPENDENCY_OR_UNMAPPED: 4
  };

  const stableCandidateOccurrences = new Map();
  const observations = detectors.map((detector, rawDetectorIndex) => {
    const stableBase = stableSlitherCandidateIdV1(detector);
    const stableOccurrence = stableCandidateOccurrences.get(stableBase) ?? 0;
    stableCandidateOccurrences.set(stableBase, stableOccurrence + 1);
    const stableCandidateId = stableBase + (stableOccurrence ? '-' + String(stableOccurrence + 1).padStart(2, '0') : '');
    const groupedAnchors = new Map();
    for (const element of detector?.elements ?? []) {
      const chain = slitherParentChainV1(element);
      const functionElement = chain.find(x => x.type === 'function') ?? null;
      const contractElement = chain.find(x => x.type === 'contract') ?? null;
      const pathCandidates = [
        functionElement?.source_mapping?.filename_relative,
        element?.source_mapping?.filename_relative,
        contractElement?.source_mapping?.filename_relative,
        functionElement?.source_mapping?.filename_short,
        element?.source_mapping?.filename_short
      ];
      const sourcePath = pathCandidates.find(x => typeof x === 'string' && x.length && !x.startsWith('/')) ?? null;
      if (!sourcePath) continue;

      const signature = functionElement?.type_specific_fields?.signature ?? null;
      const functionName = functionElement?.name ?? null;
      const contractName = contractElement?.name ?? null;
      const elementLines = slitherSourceLinesV1(element);
      const functionLines = slitherSourceLinesV1(functionElement);
      const key = [sourcePath, contractName ?? '', signature ?? functionName ?? 'CONTRACT'].join('|');
      const anchor = groupedAnchors.get(key) ?? {
        sourcePath,
        contractName,
        functionSignature: signature,
        functionName,
        findingLines: new Set(),
        functionLines: new Set(),
        elementTypes: new Set(),
        dependencyFlag: false
      };

      for (const line of elementLines) anchor.findingLines.add(line);
      for (const line of functionLines) anchor.functionLines.add(line);
      if (element?.type) anchor.elementTypes.add(element.type);
      if (element?.source_mapping?.is_dependency === true ||
          functionElement?.source_mapping?.is_dependency === true ||
          contractElement?.source_mapping?.is_dependency === true) {
        anchor.dependencyFlag = true;
      }
      groupedAnchors.set(key, anchor);
    }

    if (!groupedAnchors.size) {
      const fallback = String(detector?.first_markdown_element ?? '').match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/);
      if (fallback) {
        const sourcePath = fallback[1];
        const line = Number(fallback[2]);
        const end = Number(fallback[3] ?? fallback[2]);
        groupedAnchors.set(sourcePath + '||MARKDOWN_FALLBACK', {
          sourcePath, contractName: null, functionSignature: null, functionName: null,
          findingLines: new Set(Array.from({ length: Math.max(1, end - line + 1) }, (_, i) => line + i)),
          functionLines: new Set(), elementTypes: new Set(['MARKDOWN_SOURCE_ANCHOR']), dependencyFlag: false
        });
      }
    }

    const anchors = [...groupedAnchors.values()].map(rawAnchor => {
      const findingLines = [...rawAnchor.findingLines].sort((a, b) => a - b);
      const functionLines = [...rawAnchor.functionLines].sort((a, b) => a - b);
      const lineStart = findingLines[0] ?? functionLines[0] ?? null;
      const lineEnd = findingLines.at(-1) ?? functionLines.at(-1) ?? lineStart;
      const contract = resolveContract(rawAnchor.sourcePath, rawAnchor.contractName, null);
      const fn = resolveFunction(
        rawAnchor.sourcePath, contract, rawAnchor.functionSignature,
        rawAnchor.functionName, lineStart, lineEnd
      );
      const resolvedContract = resolveContract(rawAnchor.sourcePath, rawAnchor.contractName, fn);
      const sourceTier = sourceTierByPath.get(rawAnchor.sourcePath) ??
        (rawAnchor.dependencyFlag ? 'DEPENDENCY' : 'SOURCE_TIER_UNRESOLVED');
      const qualifiedContract = resolvedContract?.qualifiedName ??
        (rawAnchor.contractName ? rawAnchor.sourcePath + ':' + rawAnchor.contractName : null);
      const reviewContext = contexts.find(x =>
        x.path === rawAnchor.sourcePath &&
        x.canonicalSignature === (fn?.signature ?? rawAnchor.functionSignature) &&
        (!resolvedContract || x.qualifiedContainer === resolvedContract.qualifiedName)
      ) ?? null;
      const stateEffect = stateEffects.find(x =>
        x.sourcePath === rawAnchor.sourcePath &&
        x.signature === (fn?.signature ?? rawAnchor.functionSignature) &&
        (!resolvedContract || x.qualifiedContainer === resolvedContract.qualifiedName)
      ) ?? null;
      const trace = traceEntrypointsFromFunction(fn?.functionId);
      const directSignatureEntrypoints = resolvedContract && (fn?.signature ?? rawAnchor.functionSignature)
        ? (entrypointsByContractSignature.get(String(resolvedContract.contractId) + '|' + (fn?.signature ?? rawAnchor.functionSignature)) ?? [])
        : [];
      const pathMap = new Map(trace.paths.map(x => [x.entrypointId, x]));
      for (const entrypoint of directSignatureEntrypoints) {
        if (!pathMap.has(entrypoint.entrypointId)) {
          pathMap.set(entrypoint.entrypointId, {
            entrypointId: entrypoint.entrypointId,
            canonicalSignature: entrypoint.canonicalSignature,
            qualifiedContract: entrypoint.qualifiedContract,
            stateChanging: entrypoint.stateChanging === true,
            implementationOrigin: entrypoint.implementationOrigin,
            connectionType: 'DIRECT_ABI_SIGNATURE_MATCH_WITHOUT_FUNCTION_ID',
            callPath: []
          });
        }
      }
      const entrypointPaths = [...pathMap.values()].sort((a, b) => a.entrypointId.localeCompare(b.entrypointId));
      const connectedEntrypointIds = entrypointPaths.map(x => x.entrypointId);
      const connectedStateChangingEntrypointIds = entrypointPaths.filter(x => x.stateChanging).map(x => x.entrypointId);
      const privilegeIds = fn?.functionId
        ? privilegeCandidates.filter(x => x.functionId === fn.functionId).map(x => x.candidateId)
        : [];
      const valueFlowIds = fn?.functionId
        ? valueFlowCandidates.filter(x => x.callerFunctionId === fn.functionId).map(x => x.valueFlowCandidateId)
        : [];
      const functionLocation = functionLines.length
        ? rawAnchor.sourcePath + ':' + functionLines[0] + '-' + functionLines.at(-1)
        : null;
      const findingLocation = lineStart
        ? rawAnchor.sourcePath + ':' + lineStart + '-' + lineEnd
        : functionLocation;
      const anchorInScope = sourceTier === 'IN_SCOPE';
      const anchorHasStateChangingPath = connectedStateChangingEntrypointIds.length > 0;
      const anchorHighImpact = ['Critical', 'High'].includes(detector?.impact);
      let reviewPriority;
      if (anchorHasStateChangingPath && anchorHighImpact) reviewPriority = 'P1_FLOW_LINKED_HIGH_IMPACT';
      else if (anchorHasStateChangingPath || (anchorInScope && anchorHighImpact)) reviewPriority = 'P2_FLOW_OR_HIGH_IMPACT';
      else if (anchorInScope) reviewPriority = 'P3_IN_SCOPE_CONTEXT';
      else reviewPriority = 'P4_DEPENDENCY_OR_UNMAPPED';
      const anchorPriorityReasons = [];
      if (anchorInScope) anchorPriorityReasons.push('IN_SCOPE_SOURCE_MAPPING');
      if (anchorHasStateChangingPath) anchorPriorityReasons.push('STATE_CHANGING_ENTRYPOINT_PATH_CANDIDATE');
      if (anchorHighImpact) anchorPriorityReasons.push('SLITHER_HIGH_OR_CRITICAL_IMPACT_LABEL');
      if (!anchorHasStateChangingPath && anchorInScope && anchorHighImpact) anchorPriorityReasons.push('NO_STATE_CHANGING_ENTRYPOINT_PATH_ESTABLISHED');
      if (sourceTier === 'DEPENDENCY') anchorPriorityReasons.push('DEPENDENCY_SOURCE_ANCHOR');
      if (!fn) anchorPriorityReasons.push('FUNCTION_MAPPING_UNRESOLVED');

      return {
        reviewPriority,
        priorityReasonCodes: anchorPriorityReasons,
        contractId: resolvedContract?.contractId ?? null,
        qualifiedContract,
        contractKind: resolvedContract?.contractKind ?? null,
        sourcePath: rawAnchor.sourcePath,
        sourceTier,
        functionId: fn?.functionId ?? null,
        functionSignature: fn?.signature ?? rawAnchor.functionSignature ?? null,
        functionName: fn?.signature ? String(fn.signature).split('(')[0] : rawAnchor.functionName,
        functionMappingStatus: fn ? 'SOURCE_PATH_SIGNATURE_AND_CONTRACT_MATCH' :
          rawAnchor.functionSignature ? 'FUNCTION_SIGNATURE_NOT_RESOLVED' :
          rawAnchor.contractName ? 'CONTRACT_ONLY_NO_FUNCTION_MAPPING' : 'SOURCE_ANCHOR_ONLY',
        findingLines,
        functionLocation,
        findingLocation,
        reviewContextId: reviewContext?.contextId ?? null,
        localStateReads: stateEffect?.directlyObservedStateReads ?? reviewContext?.stateReads ?? [],
        localStateWrites: stateEffect?.directlyObservedStateWrites ?? reviewContext?.stateWrites ?? [],
        stateEffectEvidenceStatus: stateEffect?.writeEvidenceStatus ?? 'NO_MATCHED_LOCAL_STATE_EFFECT_CONTEXT',
        modifiers: reviewContext?.modifiers ?? [],
        privilegeCandidateIds: privilegeIds,
        valueFlowCandidateIds: valueFlowIds,
        connectedEntrypointIds,
        connectedStateChangingEntrypointIds,
        entrypointPaths,
        pathSearchStatus: trace.attempted
          ? (trace.truncated ? 'SOURCE_CALL_GRAPH_SEARCH_TRUNCATED' : 'SOURCE_CALL_GRAPH_SEARCH_COMPLETE')
          : 'NOT_ATTEMPTED_NO_FUNCTION_ID',
        sourceAnchorEvidence: rawAnchor.elementTypes.has('MARKDOWN_SOURCE_ANCHOR')
          ? 'SLITHER_FIRST_MARKDOWN_ELEMENT'
          : 'SLITHER_ELEMENT_SOURCE_MAPPING'
      };
    });

    const contractIds = [...new Set(anchors.map(x => x.contractId).filter(Boolean))].sort();
    const functionIds = [...new Set(anchors.map(x => x.functionId).filter(Boolean))].sort();
    const connectedStateChangingEntrypointIds = [...new Set(anchors.flatMap(x => x.connectedStateChangingEntrypointIds))].sort();
    const connectedEntrypointIds = [...new Set(anchors.flatMap(x => x.connectedEntrypointIds))].sort();
    const inScope = anchors.some(x => x.sourceTier === 'IN_SCOPE');
    const hasStateChangingPath = connectedStateChangingEntrypointIds.length > 0;
    const priority = anchors.length
      ? anchors.reduce((best, anchor) =>
          priorityRank[anchor.reviewPriority] < priorityRank[best] ? anchor.reviewPriority : best,
        'P4_DEPENDENCY_OR_UNMAPPED')
      : 'P4_DEPENDENCY_OR_UNMAPPED';
    const priorityReasonCodes = [...new Set(anchors.flatMap(x => x.priorityReasonCodes))];
    if (!anchors.length) priorityReasonCodes.push('NO_SOURCE_ANCHOR');
    const sourceScope = inScope ? 'IN_SCOPE' :
      anchors.length && anchors.every(x => x.sourceTier === 'DEPENDENCY') ? 'DEPENDENCY' : 'UNRESOLVED';

    return {
      candidateId: 'SLITHER-' + String(rawDetectorIndex + 1).padStart(4, '0'),
      stableCandidateId,
      findingId: detector?.id ?? null,
      rawDetectorIndex,
      rawEvidenceRef: 'SLITHER_v1.json#detectors[' + rawDetectorIndex + ']',
      check: detector?.check ?? 'UNNAMED_DETECTOR',
      impact: detector?.impact ?? null,
      confidence: detector?.confidence ?? null,
      priority,
      priorityReasonCodes,
      sourceScope,
      contractIds,
      functionIds,
      connectedEntrypointIds,
      connectedStateChangingEntrypointIds,
      sourceAnchors: anchors,
      descriptionExcerpt: String(detector?.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 280),
      status: 'NEUTRAL_ANALYZER_CANDIDATE'
    };
  });

  observations.sort((a, b) =>
    priorityRank[a.priority] - priorityRank[b.priority] ||
    slitherImpactRankV1(b.impact) - slitherImpactRankV1(a.impact) ||
    slitherConfidenceRankV1(b.confidence) - slitherConfidenceRankV1(a.confidence) ||
    String(a.sourceAnchors[0]?.sourcePath ?? '').localeCompare(String(b.sourceAnchors[0]?.sourcePath ?? '')) ||
    Number(a.sourceAnchors[0]?.findingLines?.[0] ?? 0) - Number(b.sourceAnchors[0]?.findingLines?.[0] ?? 0) ||
    String(a.stableCandidateId).localeCompare(String(b.stableCandidateId)) ||
    a.rawDetectorIndex - b.rawDetectorIndex
  );

  const priorityCounts = Object.fromEntries(Object.keys(priorityRank).map(key => [key, 0]));
  const byContractMap = new Map();
  const unmappedCandidateIds = [];
  const contractUnmappedCandidateIds = [];

  for (const observation of observations) {
    priorityCounts[observation.priority] = (priorityCounts[observation.priority] ?? 0) + 1;
    if (!observation.sourceAnchors.length) unmappedCandidateIds.push(observation.candidateId);
    if (!observation.contractIds.length) contractUnmappedCandidateIds.push(observation.candidateId);

    for (const anchor of observation.sourceAnchors) {
      const groupKey = anchor.contractId ?? ('SOURCE:' + anchor.sourcePath);
      const group = byContractMap.get(groupKey) ?? {
        contractId: anchor.contractId,
        qualifiedContract: anchor.qualifiedContract ?? ('SOURCE FILE: ' + anchor.sourcePath),
        sourcePath: anchor.sourcePath,
        sourceTier: anchor.sourceTier,
        candidateIds: new Set(),
        stableCandidateIds: new Set(),
        candidatePriorities: new Map(),
        connectedEntrypointIds: new Set(),
        priorityCounts: Object.fromEntries(Object.keys(priorityRank).map(key => [key, 0]))
      };
      const existingAnchorPriority = group.candidatePriorities.get(observation.candidateId);
      if (existingAnchorPriority === undefined) {
        group.candidateIds.add(observation.candidateId);
        group.candidatePriorities.set(observation.candidateId, anchor.reviewPriority);
        group.priorityCounts[anchor.reviewPriority] = (group.priorityCounts[anchor.reviewPriority] ?? 0) + 1;
      } else if (priorityRank[anchor.reviewPriority] < priorityRank[existingAnchorPriority]) {
        group.priorityCounts[existingAnchorPriority] = Math.max(0, group.priorityCounts[existingAnchorPriority] - 1);
        group.priorityCounts[anchor.reviewPriority] = (group.priorityCounts[anchor.reviewPriority] ?? 0) + 1;
        group.candidatePriorities.set(observation.candidateId, anchor.reviewPriority);
      }
      group.stableCandidateIds.add(observation.stableCandidateId);
      for (const id of anchor.connectedStateChangingEntrypointIds) group.connectedEntrypointIds.add(id);
      if (anchor.sourceTier === 'IN_SCOPE') group.sourceTier = 'IN_SCOPE';
      byContractMap.set(groupKey, group);
    }
  }

  const byContract = [...byContractMap.values()].map(group => ({
    contractId: group.contractId,
    qualifiedContract: group.qualifiedContract,
    sourcePath: group.sourcePath,
    sourceTier: group.sourceTier,
    observationCount: group.candidateIds.size,
    priorityCounts: group.priorityCounts,
    candidateIds: [...group.candidateIds].sort((a, b) =>
      priorityRank[group.candidatePriorities.get(a)] - priorityRank[group.candidatePriorities.get(b)] || a.localeCompare(b)
    ),
    stableCandidateIds: [...group.stableCandidateIds].sort(),
    connectedStateChangingEntrypointIds: [...group.connectedEntrypointIds].sort()
  })).sort((a, b) =>
    (b.priorityCounts.P1_FLOW_LINKED_HIGH_IMPACT ?? 0) - (a.priorityCounts.P1_FLOW_LINKED_HIGH_IMPACT ?? 0) ||
    b.observationCount - a.observationCount ||
    String(a.qualifiedContract).localeCompare(String(b.qualifiedContract))
  );

  const mappingCounts = {
    detectorCount: observations.length,
    sourceAnchoredDetectorCount: observations.filter(x => x.sourceAnchors.length > 0).length,
    contractMappedDetectorCount: observations.filter(x => x.contractIds.length > 0).length,
    functionMappedDetectorCount: observations.filter(x => x.functionIds.length > 0).length,
    stateChangingFlowConnectedDetectorCount: observations.filter(x => x.connectedStateChangingEntrypointIds.length > 0).length,
    anyEntrypointConnectedDetectorCount: observations.filter(x => x.connectedEntrypointIds.length > 0).length,
    sourceUnmappedDetectorCount: unmappedCandidateIds.length,
    contractUnmappedDetectorCount: contractUnmappedCandidateIds.length,
    stableCandidateIdCount: new Set(observations.map(x => x.stableCandidateId)).size
  };

  const index = {
    schemaVersion: 'curveyield-slither-flow-prioritization-v1',
    status: unmappedCandidateIds.length || contractUnmappedCandidateIds.length
      ? 'INDEXED_WITH_EXPLICIT_UNRESOLVED_MAPPINGS' : 'INDEXED',
    sourceSha256: reviewInventory.sourceSha256 ?? si.sourceIdentity?.archiveSha256 ?? null,
    notSecurityVerdict: true,
    rawEvidence: {
      file: 'SLITHER_v1.json',
      rawArtifactRef: slither?.rawArtifactRef ?? null,
      sourceCommit: slither?.sourceCommit ?? si.sourceIdentity?.commit ?? null,
      version: slither?.version ?? null,
      analyzerStatus: slither?.componentStatus ?? slither?.status ?? 'UNAVAILABLE',
      detectorCount: detectors.length
    },
    prioritizationPolicy: {
      P1_FLOW_LINKED_HIGH_IMPACT: 'High/Critical Slither impact label plus a source call-graph path candidate to at least one state-changing effective ABI entrypoint.',
      P2_FLOW_OR_HIGH_IMPACT: 'A state-changing effective ABI entrypoint path candidate, or a High/Critical observation in an in-scope source unit without a resolved state-changing path.',
      P3_IN_SCOPE_CONTEXT: 'Other source-mapped observations in an in-scope source unit.',
      P4_DEPENDENCY_OR_UNMAPPED: 'Dependency-only, source-unmapped or contract-unmapped observations without an in-scope priority basis.',
      tieBreak: 'Impact descending, confidence descending, source path, source line, stable content ID, then original detector order.',
      interpretation: 'Priority is a review-navigation order, not a security severity or finding verdict.'
    },
    priorityCounts,
    mappingCounts,
    byContract,
    unmappedCandidateIds,
    contractUnmappedCandidateIds,
    limitations: [
      'Slither observations remain neutral analyzer candidates; this index does not promote them to confirmed security findings.',
      'Contract and function mappings use Slither source mappings reconciled against the admitted compiler/source inventory; unresolved mappings remain explicit.',
      'Entrypoint paths are static source call-graph candidates, not proof of runtime reachability, dynamic dispatch, or deployed behavior.',
      'The index links compiler-effective ABI entrypoints; the auditor still assigns semantic F# flows during Round 2.',
      'Vyper 0.4.3 structural AST observations do not provide Slither semantic detector coverage.'
    ],
    observations
  };
  index.indexDigestSha256 = digestCanonicalV1(index);

  si.staticRecon ??= {};
  si.staticRecon.slither ??= {};
  si.staticRecon.slither.candidateCount = detectors.length;
  si.staticRecon.slither.candidateIndex = observations;
  const { observations: omittedObservations, ...indexSummary } = index;
  si.staticRecon.slither.prioritization = indexSummary;

  review.slitherTriage = {
    schemaVersion: index.schemaVersion,
    status: index.status,
    sourceSha256: index.sourceSha256,
    rawEvidenceRef: 'SLITHER_v1.json',
    notSecurityVerdict: true,
    detectorCount: detectors.length,
    stableCandidateIdCount: mappingCounts.stableCandidateIdCount,
    priorityCounts,
    mappingCounts,
    byContract,
    unmappedCandidateIds,
    contractUnmappedCandidateIds,
    indexDigestSha256: index.indexDigestSha256,
    limitations: index.limitations
  };

  const { technicalBundleDigest, ...sourceIntelligenceWithoutDigest } = si;
  si.technicalBundleDigest = digestCanonicalV1(sourceIntelligenceWithoutDigest);
  return index;
}
