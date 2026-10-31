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
    if (value.nodeType === 'FunctionDefinition') next.fn = value;
    visit(value,next);
  }
  for (const [key,child] of Object.entries(value)) {
    if (['scope','referencedDeclaration','linearizedBaseContracts'].includes(key)) continue;
    if (child && typeof child === 'object') walk(child,visit,next);
  }
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
        if (node.nodeType==='FunctionDefinition' && ctx.contract) {
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
      artifactId,qualifiedName,sourceId,language:lang,abiDigestSha256:digestCanonicalV1(a.abi??[]),
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
    contracts.push({contractId,qualifiedName,sourceId,language:lang,contractKind:astContract?.node?.contractKind??(lang==='VYPER'?'contract':'UNKNOWN'),
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
    const key=[edge.callerFunctionId,edge.targetFunctionId??'',edge.memberOrName??'',edge.sourceLocation??''].join('|');
    if(callDedup.has(key))return; callDedup.add(key); callGraph.push({...edge,callEdgeId:`CALL-${pad(callGraph.length+1,4)}`});
  }
  function pushExternal(item){
    const key=[item.callerFunctionId,item.interfaceOrType??'',item.memberOrName??''].join('|');
    if(externalDedup.has(key))return; externalDedup.add(key); externalInterfaces.push({...item,externalInterfaceId:`EXT-${pad(externalInterfaces.length+1,4)}`});
  }
  function pushValue(item){
    const key=[item.callerFunctionId,item.flowKind,item.memberOrName??'',item.sourceLocation??''].join('|');
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
          const isMember=expr?.nodeType==='MemberAccess';
          const sameContract=target?.contractId===callerContractId;
          const callClass=target ? (sameContract?'INTERNAL_OR_SELF':'CROSS_CONTRACT_OR_INHERITED') : (isMember?'UNRESOLVED_MEMBER_CALL':'UNRESOLVED_CALL');
          pushCall({
            callerContractId,callerFunctionId:caller.functionId,targetContractId:target?.contractId??null,targetFunctionId:target?.functionId??null,
            memberOrName:member,callClass,interfaceOrType:interfaceType,sourceLocation:callLoc,confidenceClass:target?'SOLIDITY_AST_REFERENCED_DECLARATION':'SOLIDITY_AST_CALL_SYNTAX',
            basis:target?'FUNCTION_CALL_REFERENCED_DECLARATION':'FUNCTION_CALL_EXPRESSION'
          });
          if(isMember && (!target || !sameContract)){
            pushExternal({callerContractId,callerFunctionId:caller.functionId,targetContractId:target?.contractId??null,targetFunctionId:target?.functionId??null,
              interfaceOrType:interfaceType,memberOrName:member,sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',
              basis:'MEMBER_ACCESS_FUNCTION_CALL',securityInterpretation:'DEFER_TO_REVIEWER'});
          }
          if(['transfer','transferFrom','safeTransfer','safeTransferFrom','send'].includes(member)){
            pushValue({callerContractId,callerFunctionId:caller.functionId,flowKind:'TOKEN_OR_NATIVE_TRANSFER_CALL',memberOrName:member,interfaceOrType:interfaceType,
              sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'TRANSFER_LIKE_MEMBER_CALL',securityInterpretation:'DEFER_TO_REVIEWER'});
          }
          if(member==='approve'||member==='safeApprove'||member==='forceApprove'){
            pushValue({callerContractId,callerFunctionId:caller.functionId,flowKind:'TOKEN_APPROVAL_CALL',memberOrName:member,interfaceOrType:interfaceType,
              sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'APPROVAL_LIKE_MEMBER_CALL',securityInterpretation:'DEFER_TO_REVIEWER'});
          }
          if(member==='call'||member==='delegatecall'||member==='staticcall'){
            pushExternal({callerContractId,callerFunctionId:caller.functionId,targetContractId:null,targetFunctionId:null,interfaceOrType:interfaceType,
              memberOrName:member,sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'LOW_LEVEL_CALL',securityInterpretation:'DEFER_TO_REVIEWER'});
            if(member==='call'){
              pushValue({callerContractId,callerFunctionId:caller.functionId,flowKind:'LOW_LEVEL_CALL_POTENTIAL_VALUE_TRANSFER',memberOrName:member,interfaceOrType:interfaceType,
                sourceLocation:callLoc,status:'CANDIDATE',confidenceClass:'SOLIDITY_AST_CALL_SYNTAX',basis:'LOW_LEVEL_CALL',securityInterpretation:'DEFER_TO_REVIEWER'});
            }
          }
        } else if(node.nodeType==='NewExpression'){
          const ref=Number.isInteger(node?.typeName?.referencedDeclaration)?node.typeName.referencedDeclaration:null;
          const targetContractId=Number.isInteger(ref)?(contractByAstId.get(`${unit.unitId}:${ref}`)??null):null;
          pushCall({callerContractId,callerFunctionId:caller.functionId,targetContractId,targetFunctionId:null,memberOrName:'new',
            callClass:'CONTRACT_CREATION',interfaceOrType:node?.typeDescriptions?.typeString??null,sourceLocation:callLoc,confidenceClass:'SOLIDITY_AST_CREATION_SYNTAX',basis:'NEW_EXPRESSION'});
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
      {surfaceId:'SURFACE-CALLABLE',surfaceClass:'CALLABLE_SURFACE',sourceIds:sourceFiles.map(x=>x.sourceId),contractIds:contracts.map(x=>x.contractId),functionIds:functions.map(x=>x.functionId),
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
