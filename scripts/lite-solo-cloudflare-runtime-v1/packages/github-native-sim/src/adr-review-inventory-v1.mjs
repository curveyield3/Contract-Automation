import fs from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {listAdmittedSourcesV1} from './source-intelligence-technical-v1.mjs';
import {digestCanonicalV1} from './canonical-json-v1.mjs';
import {buildSystemFactsV1} from './adr-system-facts-v1.mjs';
import {loadTaxonomyV1} from './adr-taxonomy-v1.mjs';
import {loadAuditScope,sourceIsInScope,sourceExplicitlyExcludedV1,AUDIT_SCOPE_FILE} from './phase0-audit-scope-v1.mjs';

const POLICY='audit-detection-rebuild-v1';
const REVIEW_KINDS=new Set(['FUNCTION','CONSTRUCTOR','FALLBACK','RECEIVE','FREE_FUNCTION','MODIFIER','STATE_INITIALIZER','CONSTANT','IMMUTABLE','GENERATED_GETTER']);
const GUARD=/only|auth|restricted|whenNot|whenPaused|initializer|nonReentrant/i;
const ROLE=/owner|admin|role|controller|guardian|authority|operator|keeper/i;
const TOKEN=/^(transfer|transferFrom|safeTransfer|safeTransferFrom)$/;
const APPROVE=/^(approve|safeApprove|forceApprove|increaseAllowance|decreaseAllowance|safeIncreaseAllowance|permit)$/;
const SORT=(a,b)=>String(a).localeCompare(String(b));
const distinct=(values)=>[...new Set(values.filter(x=>x!==undefined&&x!==null))].sort(SORT);
const byPosition=(a,b)=>a.path.localeCompare(b.path)||a.lineStart-b.lineStart||a.contextId.localeCompare(b.contextId);
const nodeStart=(n)=>Number(String(n?.src??'0:0').split(':')[0])||0;
const children=(n)=>Object.entries(n??{}).filter(([key,value])=>!['scope','referencedDeclaration','linearizedBaseContracts'].includes(key)&&value&&typeof value==='object').flatMap(([,value])=>Array.isArray(value)?value:[value]);
function walk(n,fn,parent=null) {
  if(!n||typeof n!=='object')return;
  if(Array.isArray(n)){for(const v of n)walk(v,fn,parent);return;}
  if(n.nodeType)fn(n,parent);
  for(const item of children(n))walk(item,fn,n);
}
// A package's audit-scope.json is authoritative: only its inScopePaths are reviewed, every other
// compiled source is a dependency (reviewed only where in-scope contracts inherit it). Without the
// file, path conventions apply at any depth (e.g. ipor-fusion/lib/forge-std is a dependency).
export function sourceTierV1(p,scope=null,{includeScripts=false}={}) {
  if(/(^|\/)(test|tests|mock|mocks)\//.test(p)||p.endsWith('.t.sol'))return 'TEST_OR_MOCK';
  // Never promote vendored/dependency paths into FIRST-PARTY v13 script scope.
  // Preserve historical v12 path rules (including ipor-fusion without scope).
  if(includeScripts&&(/(^|\/)(vendor|lib|node_modules|ipor-fusion)\//.test(p)||p.startsWith('@')))
    return 'DEPENDENCY';
  const scriptPath=p.endsWith('.s.sol')||/(^|\/)(script|scripts|deploy|deployment|deployments|config|configure|handover)\//.test(p);
  if(includeScripts&&scriptPath)return !sourceExplicitlyExcludedV1(p,scope)?'IN_SCOPE':'SCRIPT';
  // Config/deploy Solidity sources remain normal executable code under v12.
  if(p.endsWith('.s.sol')||/(^|\/)(script|scripts)\//.test(p))return 'SCRIPT';
  if(scope?.source===AUDIT_SCOPE_FILE)return sourceIsInScope(p,scope)?'IN_SCOPE':'DEPENDENCY';
  if(/(^|\/)(vendor|lib|node_modules)\//.test(p)||p.startsWith('@'))return 'DEPENDENCY';
  return 'IN_SCOPE';
}
function lines(bytes,src) {
  const [start,length]=String(src??'0:0').split(':').map(Number);
  const a=Math.min(Math.max(0,start||0),bytes.length),b=Math.min(Math.max(0,(start||0)+(length||0)),bytes.length);
  const count=(end)=>{let n=1;for(let i=0;i<end;i++)if(bytes[i]===10)n++;return n;};
  return {lineStart:count(a),lineEnd:count(b)};
}
function sourceText(bytes,src) {
  const [start,len]=String(src??'0:0').split(':').map(Number);
  return bytes.subarray(start||0,(start||0)+(len||0)).toString('utf8');
}
function sig(node,name) {
  const pars=node.parameters?.parameters??[];
  return name+'('+pars.map(p=>String(p.typeDescriptions?.typeString??p.typeName?.name??'unknown').replace(/\b(storage|memory|calldata)\b/g,'').replace(/\s+/g,'')).join(',')+')';
}
function kindOf(node,outside) {
  if(node.nodeType==='FunctionDefinition')return outside?'FREE_FUNCTION':({function:'FUNCTION',constructor:'CONSTRUCTOR',fallback:'FALLBACK',receive:'RECEIVE'}[node.kind]??'FUNCTION');
  if(node.nodeType==='ModifierDefinition')return 'MODIFIER';
  if(node.nodeType==='VariableDeclaration'&&node.stateVariable)return node.constant?'CONSTANT':node.mutability==='immutable'?'IMMUTABLE':'STATE_VARIABLE';
  return null;
}
function emptyArtifact(campaign,payload,schemaVersion='curveyield-review-inventory-v1') {
  return {schemaVersion,campaignId:campaign.campaignId??'',campaignGenerationId:campaign.campaignGenerationId??'',
    sourceSha256:campaign.sourceSha256??campaign.archiveSha256??'',taxonomyVersion:'curveyield-defect-taxonomy-v1',
    detectionPolicy:POLICY,generatedAt:campaign.generatedAt??'1970-01-01T00:00:00.000Z',payload};
}
const blankPayload=()=>({sourceUnits:[],declarations:[],contexts:[],triggers:{},limitations:[],complete:false,counts:{sourceUnits:0,inScopeUnits:0,declarations:0,contexts:0,byKind:{}}});

// An import-only Solidity wrapper has no declarations of its own. Its exact
// admitted source is covered only if every directive is a pragma or import
// and every relative import points to an admitted, AST-backed source.
function sourceVerifiedImportOnlyV1(source,bySource,asts,identicalSourceAliases){
  const body=source.bytes.toString('utf8').replace(/^\uFEFF/,'')
    .replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'').trim();
  if(!body.endsWith(';'))return false;
  const statements=body.split(';').map(s=>s.trim()).filter(Boolean);
  if(!statements.length)return false;
  let importCount=0;
  for(const statement of statements){
    if(/^pragma\s+solidity\s+[0-9.^~<>=\s]+$/.test(statement)||
       /^pragma\s+abicoder\s+v[12]$/.test(statement))continue;
    const importMatch=statement.match(/^import\s+(?:(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{\s*[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?)*\s*\})\s+from\s+)?["']([^"'\r\n]+)["']$/);
    if(!importMatch)return false;
    const imported=importMatch[1];
    if(!imported.startsWith('./')&&!imported.startsWith('../'))return false;
    const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(source.path),imported));
    if(!bySource.has(resolved)||(!asts.has(resolved)&&!identicalSourceAliases.has(resolved)))return false;
    importCount++;
  }
  return importCount>0;
}

export async function buildReviewInventoryV1({projectRoot,build,campaign,slither=null}) {
  if(!projectRoot||!build||!campaign)throw new TypeError('projectRoot, build, campaign required');
  const sources=await listAdmittedSourcesV1(projectRoot), bySource=new Map();
  const scope=await loadAuditScope(projectRoot);
  const includeScripts=campaign?.detectionReviewPolicy==='correctness-verdict-v13';
  for(const s of sources) {
    const bytes=await fs.readFile(path.join(projectRoot,...s.path.split('/')));
    bySource.set(s.path,{...s,bytes,tier:sourceTierV1(s.path,scope,{includeScripts})});
  }
  const asts=new Map();
  const units=(build.compilationUnits??[]).filter(u=>u.sourceAsts&&Object.keys(u.sourceAsts).length);
  for(const unit of (units.length?units:[{sourceAsts:build.sourceAsts??{}}]))
    for(const [name,ast] of Object.entries(unit.sourceAsts??{}).sort(([a],[b])=>a.localeCompare(b)))
      if(bySource.has(name)&&!asts.has(name))asts.set(name,ast);

  // A source ZIP can contain byte-identical copies of the same first-party
  // contract. Its existing admitted AST already covers the precise bytes of
  // each alias; do not compile with a drifting solc or invent a second AST.
  // Canonical source retains the review contexts. Every alias gets an explicit
  // identity mapping and is only accepted after a byte-for-byte equality check.
  // The admitted, pinned Vyper 0.4.3 compiler produced per-function AST
  // evidence. Bind every analyzer result to the exact ZIP source bytes before
  // converting it into review contexts. Never treat a text-only Vyper fallback
  // as a complete source-context inventory.
  const vyperAstBySource=new Map();
  for(const row of slither?.analyzerCoverage??[]){
    const analysis=row.vyperAnalysis;
    if(!analysis)continue;
    const file=analysis.sourceName,entry=bySource.get(file);
    if(!entry||!file.endsWith('.vy'))throw new Error('Unadmitted Vyper AST source: '+file);
    const digest=createHash('sha256').update(entry.bytes).digest('hex');
    if(digest!==analysis.sourceSha256)throw new Error('Vyper AST source hash mismatch: '+file);
    if(analysis.compilerVersion!=='0.4.3'||analysis.slitherCompatible!==false||
       !Array.isArray(analysis.functions)||analysis.functions.length===0||
       !/^[0-9a-f]{64}$/.test(String(analysis.astSha256??'')))
       throw new Error('Incomplete source-bound Vyper 0.4.3 AST evidence: '+file);
    if(vyperAstBySource.has(file))throw new Error('Duplicate Vyper AST analysis: '+file);
    vyperAstBySource.set(file,analysis);
  }
  const identicalVyperAliases=new Map();
  for(const entry of sources){
    if(!entry.path.endsWith('.vy')||vyperAstBySource.has(entry.path)||bySource.get(entry.path).tier!=='IN_SCOPE')continue;
    const canonical=[...vyperAstBySource.keys()].find(p=>p!==entry.path&&
      bySource.get(p).bytes.equals(bySource.get(entry.path).bytes));
    if(canonical)identicalVyperAliases.set(entry.path,canonical);
  }
  const identicalSourceAliases=new Map();
  const compiledAstSources=[...asts.keys()].filter(p=>p.endsWith('.sol')&&bySource.has(p));
  for(const entry of sources){
    if(!entry.path.endsWith('.sol')||asts.has(entry.path)||bySource.get(entry.path).tier!=='IN_SCOPE')continue;
    const same=compiledAstSources.find(p=>p!==entry.path&&bySource.get(p).bytes.equals(bySource.get(entry.path).bytes));
    if(same)identicalSourceAliases.set(entry.path,same);
  }
  // Some embedded deployment sets omit standalone first-party interfaces from their
  // deployment compilation units. Recover real Solidity ASTs for remaining exact
  // sources without changing deployment artifacts, source bytes, or audit scope.
  const auxiliaryAstPaths=new Map(), auxiliaryAstFailures=new Map();
  const missingFirstParty=sources.filter(s=>s.path.endsWith('.sol')&&bySource.get(s.path).tier==='IN_SCOPE'&&!asts.has(s.path)&&!identicalSourceAliases.has(s.path));
  if(missingFirstParty.length){
    let solc=null;
    try {solc=createRequire(path.join(projectRoot,'package.json'))('solc');}
    catch(error){for(const s of missingFirstParty)auxiliaryAstFailures.set(s.path,'Pinned project solc unavailable: '+String(error.message??error));}
    if(solc){
      const resolveImport=(importPath)=>{
        const rel=String(importPath??'').replaceAll('\\','/');
        const candidates=[path.resolve(projectRoot,rel),path.resolve(projectRoot,'contracts',rel),path.resolve(projectRoot,'node_modules',rel)];
        for(const candidate of candidates){
          if(!candidate.startsWith(projectRoot+path.sep)||!existsSync(candidate))continue;
          try{return{contents:readFileSync(candidate,'utf8')};}catch{}
        }
        return{error:'Source import cannot be resolved: '+rel};
      };
      for(const source of missingFirstParty){
        try{
          const input={language:'Solidity',sources:{[source.path]:{content:bySource.get(source.path).bytes.toString('utf8')}},
            settings:{outputSelection:{'*':{'':['ast']}}}};
          const output=JSON.parse(solc.compile(JSON.stringify(input),{import:resolveImport}));
          const fatal=(output.errors??[]).filter(e=>e.severity==='error');
          if(fatal.length)throw new Error(fatal.map(e=>e.formattedMessage??e.message).join(' | ').slice(0,1200));
          const ast=output.sources?.[source.path]?.ast;
          if(!ast)throw new Error('Solidity compiler returned no source AST');
          asts.set(source.path,ast);
          auxiliaryAstPaths.set(source.path,String(solc.version()));
        }catch(error){auxiliaryAstFailures.set(source.path,String(error.message??error).slice(0,1500));}
      }
    }
  }

  // Preserve source-anchored review for declaration-free import wrappers
  // without using a different compiler or depending on a campaign identity.
  const verifiedImportOnlySources=new Set(missingFirstParty
    .filter(s=>!asts.has(s.path)&&sourceVerifiedImportOnlyV1(bySource.get(s.path),bySource,asts,identicalSourceAliases))
    .map(s=>s.path));
  const sourceUnits=sources.map(s=>({sourceId:s.sourceId,path:s.path,sha256:s.sha256,scopeTier:bySource.get(s.path).tier,
    lineCount:bySource.get(s.path).bytes.reduce((n,byte)=>n+(byte===10?1:0),1),
    astStatus:s.path.endsWith('.vy')?(vyperAstBySource.has(s.path)?'AVAILABLE_VYPER_AST':identicalVyperAliases.has(s.path)?'AVAILABLE_IDENTICAL_VYPER_AST_ALIAS':'UNSUPPORTED_LANGUAGE'):
      identicalSourceAliases.has(s.path)?'AVAILABLE_IDENTICAL_SOURCE_ALIAS':auxiliaryAstPaths.has(s.path)?'AVAILABLE_AUXILIARY':asts.has(s.path)?'AVAILABLE':
      verifiedImportOnlySources.has(s.path)?'SOURCE_VERIFIED_IMPORT_ONLY':'MISSING',
    ...(identicalSourceAliases.has(s.path)?{canonicalAstSource:identicalSourceAliases.get(s.path)}:{}),
    ...(identicalVyperAliases.has(s.path)?{canonicalAstSource:identicalVyperAliases.get(s.path)}:{})}));
  const limitations=[scope.source===AUDIT_SCOPE_FILE
    ?{code:'SCOPE_FROM_AUDIT_SCOPE_FILE',path:AUDIT_SCOPE_FILE,detail:'In scope: '+scope.inScopePaths.join(', ')+'. Every other compiled source is a dependency, reviewed only where in-scope contracts inherit it.'}
    :{code:'DEPENDENCY_TIER_BY_PATH',path:'*',detail:'Dependency tier assigned by path convention (vendor/, lib/, node_modules/ at any depth); modified vendored code must be moved out of those folders to be reviewed as in-scope.'}];
  for(const [alias,canonical] of identicalVyperAliases)limitations.push({
    code:'BYTE_IDENTICAL_VYPER_AST_ALIAS',path:alias,
    detail:'Source bytes exactly equal admitted '+canonical+'; source-bound Vyper 0.4.3 function AST contexts cover both source paths.'
  });
  for(const [file] of vyperAstBySource)limitations.push({
    code:'VYPER_AST_STRUCTURAL_STATIC_ONLY',path:file,
    detail:'Exact Vyper 0.4.3 compiler AST provides line-anchored function, state-write and external-call contexts; Slither Vyper semantic detectors are unsupported and must be replaced by substantive Phase 4–6 manual/property review.'
  });
  for(const [alias,canonical] of identicalSourceAliases)limitations.push({
    code:'BYTE_IDENTICAL_SOURCE_AST_ALIAS',path:alias,
    detail:'Source bytes exactly equal compiled admitted '+canonical+'; canonical AST contexts cover both source paths. No deployment bytecode or source was changed.'
  });
  for(const [file,version] of auxiliaryAstPaths)limitations.push({code:'SUPPLEMENTAL_COMPILER_AST',path:file,detail:'Complete in-scope AST obtained from unchanged source with pinned project solc '+version+'; no deployment artifact was changed.'});
  for(const [file,detail] of auxiliaryAstFailures)limitations.push({code:'SUPPLEMENTAL_COMPILER_AST_FAILED',path:file,detail});
  const declarations=[],contexts=[],triggers={},nodeById=new Map(),contractById=new Map(),metadata=new Map(),contextBySymbol=new Map(),usedIds=new Map();
  // Include full per-function Vyper review contexts rather than a single
  // 939-line FILE_FALLBACK whose gap would prevent Phase 0 sealing.
  for(const [file,analysis] of [...vyperAstBySource.entries()].sort(([a],[b])=>a.localeCompare(b))){
    const source=bySource.get(file),sourceLines=source.bytes.toString('utf8').split(/\r?\n/);
    const qualifiedContainer=file+':'+path.posix.basename(file,'.vy');
    const matchingArtifact=(build.artifacts??[]).find(a=>a.sourceName===file&&a.contractName===path.posix.basename(file,'.vy'));
    const abi=matchingArtifact?.abi??[];
    const defs=[...analysis.functions].sort((a,b)=>a.line-b.line||a.name.localeCompare(b.name));
    for(let i=0;i<defs.length;i++){
      const def=defs[i];
      if(!Number.isInteger(def.line)||def.line<1||def.line>sourceLines.length)
        throw new Error('Vyper function source line outside admitted file: '+file+':'+def.name);
      const end=Math.max(def.line,Math.min(sourceLines.length,(defs[i+1]?.line??sourceLines.length+1)-1));
      const abiMatch=abi.filter(a=>a.type==='function'&&a.name===def.name).sort((a,b)=>(b.inputs??[]).length-(a.inputs??[]).length)[0];
      const signature=def.name+'('+(abiMatch?.inputs??[]).map(x=>x.type).join(',')+')';
      const symbolId='SYM-'+digestCanonicalV1({path:file,qualifiedContainer,kind:'FUNCTION',canonicalSignature:signature}).slice(0,16);
      const contextId=symbolId.replace(/^SYM-/,'CTX-');
      const calls=(analysis.sensitiveCalls??[]).filter(x=>x.function===def.name);
      const writes=(analysis.stateWrites??[]).filter(x=>x.function===def.name);
      const decorators=def.decorators??[];
      const mutability=decorators.includes('view')?'view':decorators.includes('pure')?'pure':decorators.includes('payable')?'payable':'nonpayable';
      const visibility=def.external?'external':'internal';
      const ctx={contextId,symbolId,path:file,qualifiedContainer,kind:'FUNCTION',canonicalSignature:signature,
        visibility,stateMutability:mutability,lineStart:def.line,lineEnd:end,effectiveIn:[qualifiedContainer],
        scopeTier:source.tier,dependencySymbolIds:[],stateReads:[],stateWrites:distinct(writes.map(x=>x.target)),
        internalCalls:[],modifiers:def.nonreentrant?['nonreentrant']:[],
        externalCalls:calls.map(x=>({memberName:x.call,targetType:'VYPER_COMPILER_AST_SENSITIVE_OPERATION',line:x.line})),
        natSpec:'',directBases:[],implementedInterfaces:[],contractKind:'contract',contractAbstract:false,
        senderCheckLines:sourceLines.slice(def.line-1,end).flatMap((line,index)=>line.includes('msg.sender')?[def.line+index]:[]),
        txOriginLines:sourceLines.slice(def.line-1,end).flatMap((line,index)=>line.includes('tx.origin')?[def.line+index]:[]),
        analyzer:'VYPER_0_4_3_SOURCE_BOUND_COMPILER_AST'};
      const signals=[];
      if(writes.length)signals.push('STATE_WRITE');
      if(calls.length)signals.push('EXTERNAL_CALL');
      if(def.external&&writes.length)signals.push('STATE_WRITE_EXTERNAL');
      if(calls.some(call=>writes.some(write=>call.line<write.line)))
        signals.push('EXTERNAL_CALL_BEFORE_STATE_WRITE');
      if(decorators.includes('payable'))signals.push('PAYABLE');
      contexts.push(ctx);
      declarations.push({symbolId,path:file,qualifiedContainer,containerKind:'contract',kind:'FUNCTION',
        name:def.name,canonicalSignature:signature,visibility,stateMutability:mutability,
        lineStart:def.line,lineEnd:end,hasBody:true});
      triggers[contextId]=new Set(signals);
    }
  }
  for(const [file,ast] of asts) {
    const source=bySource.get(file);
    let current=null;
    // First pass registers every contract and declaration. References are resolved only after all files are indexed.
    function descend(node,contract=null) {
      if(!node||typeof node!=='object')return;
      if(Array.isArray(node)){for(const entry of node)descend(entry,contract);return;}
      if(node.nodeType==='ContractDefinition') {
        contract={id:node.id,path:file,qualified:file+':'+node.name,node,tier:source.tier,
          directBases:(node.baseContracts??[]).map(b=>b.baseName?.namePath??b.baseName?.name??'').filter(Boolean),
          implementedInterfaces:[],containerKind:node.contractKind??'contract',abstract:!!node.abstract};
        contractById.set(node.id,contract);
      }
      if(Number.isInteger(node.id))nodeById.set(node.id,{node,path:file,contract});
      if(node.nodeType==='FunctionDefinition'||node.nodeType==='ModifierDefinition'||(node.nodeType==='VariableDeclaration'&&node.stateVariable)) {
        const type=kindOf(node,!contract);
        if(type) {
          const name=node.kind==='constructor'?'constructor':node.kind==='fallback'?'fallback':node.kind==='receive'?'receive':node.name??'';
          const qualifiedContainer=contract?.qualified??file;
          const base={path:file,qualifiedContainer,containerKind:contract?.containerKind??'file',kind:type,name,
            canonicalSignature:node.nodeType==='VariableDeclaration'?name: sig(node,name),visibility:node.visibility??'internal',
            stateMutability:node.stateMutability??'nonpayable',...lines(source.bytes,node.src),hasBody:!!node.body,
            ...(contract?.abstract?{abstract:true}:{})};
          const kinds=[base];
          if(node.nodeType==='VariableDeclaration') {
            if(node.visibility==='public')kinds.push({...base,kind:'GENERATED_GETTER',canonicalSignature:name+'()',
              visibility:'public',hasBody:true});
            if(node.value&&!node.constant)kinds.push({...base,kind:'STATE_INITIALIZER',canonicalSignature:name+'<initializer>()',hasBody:true});
          }
          for(const declaration of kinds) {
            const identity={path:file,qualifiedContainer,kind:declaration.kind,canonicalSignature:declaration.canonicalSignature};
            const core=digestCanonicalV1(identity).slice(0,16),num=(usedIds.get(core)??0)+1;usedIds.set(core,num);
            const suffix=num===1?'':'-'+num, symbolId='SYM-'+core+suffix;
            const d={symbolId,...declaration};
            declarations.push(d);
            metadata.set(symbolId,{node,path:file,contract,tier:source.tier});
            if(declaration.kind===type&&Number.isInteger(node.id))nodeById.set(node.id,{node,path:file,contract,symbolId});
            if(source.tier==='IN_SCOPE'&&REVIEW_KINDS.has(declaration.kind)&&(declaration.kind!=='FUNCTION'||!!node.body)&&
              (contract?.containerKind!=='interface'||!!node.body)) {
              const c={contextId:'CTX-'+core+suffix,symbolId,path:file,qualifiedContainer,kind:d.kind,
                canonicalSignature:d.canonicalSignature,visibility:d.visibility,stateMutability:d.stateMutability,
                lineStart:d.lineStart,lineEnd:d.lineEnd,effectiveIn:[],scopeTier:'IN_SCOPE',
                dependencySymbolIds:[],stateReads:[],stateWrites:[],internalCalls:[],modifiers:[],externalCalls:[],
                ...(includeScripts?{
                  natSpec:typeof node.documentation==='string'?node.documentation.slice(0,2500):
                    typeof node.documentation?.text==='string'?node.documentation.text.slice(0,2500):'',
                  ...(['CONSTANT','IMMUTABLE','STATE_INITIALIZER'].includes(d.kind)?{
                    declaredValue:node.value?sourceText(source.bytes,node.value.src).slice(0,300):'UNINITIALIZED'
                  }:{})
                }:{})};
              contexts.push(c);contextBySymbol.set(symbolId,c);
            }
          }
        }
      }
      // Top-level declaration search only. Do not regard local variable declarations as state declarations.
      if(node.nodeType==='SourceUnit'||node.nodeType==='ContractDefinition') for(const ch of node.nodes??[])descend(ch,contract);
    }
    descend(ast);
  }
  const byId=new Map(contexts.map(c=>[c.contextId,c]));
  const contractInfo=[...contractById.values()];
  for(const c of contractInfo) {
    c.baseIds=(c.node.linearizedBaseContracts??[]).filter(id=>id!==c.id);
    c.implementedInterfaces=c.baseIds.map(id=>contractById.get(id)).filter(b=>b?.containerKind==='interface').map(x=>x.qualified);
  }
  for(const c of contractInfo.filter(c=>c.tier==='IN_SCOPE'&&c.containerKind==='contract'&&!c.abstract)) {
    const bases=(c.node.linearizedBaseContracts??[c.id]).map(id=>contractById.get(id)).filter(Boolean);
    const seen=new Set();
    for(const b of bases) {
      for(const d of declarations.filter(d=>d.qualifiedContainer===b.qualified&&['FUNCTION','FALLBACK','RECEIVE','GENERATED_GETTER','MODIFIER'].includes(d.kind))) {
        if(seen.has(d.canonicalSignature))continue;
        seen.add(d.canonicalSignature);
        let ctx=contextBySymbol.get(d.symbolId);
        if(!ctx&&b.tier==='DEPENDENCY'&&['FUNCTION','GENERATED_GETTER'].includes(d.kind)&&
          ['public','external'].includes(d.visibility)&&d.hasBody) {
          ctx={contextId:d.symbolId.replace(/^SYM-/,'CTX-'),symbolId:d.symbolId,
            path:d.path,qualifiedContainer:d.qualifiedContainer,kind:'INHERITED_DEPENDENCY',
            canonicalSignature:d.canonicalSignature,visibility:d.visibility,stateMutability:d.stateMutability,
            lineStart:d.lineStart,lineEnd:d.lineEnd,effectiveIn:[],scopeTier:'INHERITED_DEPENDENCY',
            dependencySymbolIds:[],stateReads:[],stateWrites:[],internalCalls:[],modifiers:[],externalCalls:[]};
          contexts.push(ctx);contextBySymbol.set(d.symbolId,ctx);byId.set(ctx.contextId,ctx);
        }
        if(ctx)ctx.effectiveIn.push(c.qualified);
      }
    }
    for(const d of declarations.filter(d=>d.qualifiedContainer===c.qualified&&d.kind==='CONSTRUCTOR')) {
      const ctx=contextBySymbol.get(d.symbolId);if(ctx)ctx.effectiveIn.push(c.qualified);
    }
  }
  for(const ctx of contexts) {
    const meta=metadata.get(ctx.symbolId);
    if(meta?.contract?.containerKind==='library')ctx.effectiveIn.push(meta.contract.qualified);
    ctx.effectiveIn=distinct(ctx.effectiveIn);
    if(!ctx.effectiveIn.length)ctx.orphan=true;
  }
  // Temporary context analysis structures are never serialized into inventory JSON.
  const temp=new Map();
  for(const ctx of contexts) {
    const meta=metadata.get(ctx.symbolId),source=bySource.get(ctx.path),n=meta?.node;
    const examined=ctx.kind==='STATE_INITIALIZER'?n?.value:ctx.kind==='GENERATED_GETTER'?null:n;
    const nodes=[],calls=[],writes=[],reads=[],members=[],external=[],modifiers=[];
    walk(examined,(v,parent)=>{nodes.push({v,parent});
      if(v.nodeType==='ModifierInvocation')modifiers.push(v.modifierName?.name??v.modifierName?.namePath??'');
      if(v.nodeType==='FunctionCall')calls.push({v,parent});
      if(v.nodeType==='MemberAccess')members.push({v,parent});
      if(v.nodeType==='Identifier'&&Number.isInteger(v.referencedDeclaration)){
        const ref=nodeById.get(v.referencedDeclaration);
        if(ref?.node?.stateVariable)reads.push({v,name:ref.node.name,node:ref.node,parent});
      }
    });
    const writeIds=new Set();
    function markTarget(root) {
      walk(root,v=>{if(v.nodeType==='Identifier'&&Number.isInteger(v.referencedDeclaration)&&nodeById.get(v.referencedDeclaration)?.node?.stateVariable)
        writeIds.add(nodeById.get(v.referencedDeclaration).node.name);
      });
    }
    for(const {v} of nodes) {
      if(v.nodeType==='Assignment')markTarget(v.leftHandSide);
      if(v.nodeType==='UnaryOperation'&&['++','--','delete'].includes(v.operator))markTarget(v.subExpression);
      if(v.nodeType==='FunctionCall'&&['push','pop'].includes(v.expression?.memberName))markTarget(v.expression?.expression);
    }
    for(const r of reads)if(writeIds.has(r.name))writes.push(r);
    ctx.stateReads=distinct(reads.map(r=>r.name));
    ctx.stateWrites=distinct([...writeIds]);
    ctx.modifiers=distinct(modifiers);
    for(const {v,parent} of calls) {
      const exp=v.expression,member=exp?.memberName??'',id=exp?.referencedDeclaration;
      const ref=nodeById.get(id);
      if(ref?.node?.nodeType==='FunctionDefinition'&&ref.symbolId)ctx.internalCalls.push(ref.symbolId);
      if(exp?.nodeType==='Identifier'&&exp.referencedDeclaration&&nodeById.get(exp.referencedDeclaration)?.node?.nodeType==='FunctionDefinition'){
        const link=nodeById.get(exp.referencedDeclaration).symbolId;if(link)ctx.internalCalls.push(link);
      }
      if(exp?.nodeType==='MemberAccess') {
        const type=exp.expression?.typeDescriptions?.typeString??'';
        if(/^(contract |address\b)/.test(type)&&!['balance','code','codehash'].includes(member))
          external.push({memberName:member,targetType:type,line:lines(source.bytes,v.src).lineStart,start:nodeStart(v),
            base:exp.expression,call:v,parent});
      }
    }
    ctx.internalCalls=distinct(ctx.internalCalls);
    ctx.externalCalls=external.map(({memberName,targetType,line})=>({memberName,targetType,line}))
      .sort((a,b)=>a.line-b.line||a.memberName.localeCompare(b.memberName)||a.targetType.localeCompare(b.targetType));
    temp.set(ctx.contextId,{nodes,calls,writes,reads,members,external,source,meta});
  }
  const lookup=new Map(contexts.map(x=>[x.symbolId,x]));
  for(const ctx of contexts) {
    const t=temp.get(ctx.contextId),n=t?.meta?.node,text=n?sourceText(t.source.bytes,n.src):'';
    const rules=new Set(),has=(re)=>re.test(text),nodes=t?.nodes.map(x=>x.v)??[],calls=t?.calls??[],members=t?.members.map(x=>x.v)??[];
    const callNames=calls.map(x=>x.v.expression?.memberName??x.v.expression?.name??'');
    const hasCall=(regex)=>callNames.some(x=>regex.test(x));
    const hasMember=(object,prop)=>members.some(m=>m.memberName===prop&&m.expression?.name===object);
    const params=n?.parameters?.parameters??[];
    if(ctx.stateWrites.length)rules.add('STATE_WRITE');
    if(ctx.modifiers.some(x=>GUARD.test(x))||hasCall(/^(hasRole|_checkRole|canPerform|_authenticateCaller|getActionId|_checkOwner)$/)||
      /(?:require|if)\s*\([^;]*msg\.sender/.test(text))rules.add('PRIVILEGED_GUARD');
    if(hasMember('tx','origin'))rules.add('TX_ORIGIN');
    if(ctx.stateMutability==='payable'||hasMember('msg','value'))rules.add('PAYABLE');
    if(ctx.stateWrites.some(x=>ROLE.test(x))||hasCall(/^(grantRole|revokeRole|_grantRole|_revokeRole|_transferOwnership|transferOwnership)$/))rules.add('OWNERSHIP_OR_ROLE_WRITE');
    if([...ctx.stateReads,...ctx.stateWrites].some(x=>/^pending/i.test(x)))rules.add('PENDING_STATE');
    if(ctx.modifiers.some(x=>/^(initializer|reinitializer|onlyInitializing)$/.test(x))||/^initialize/i.test(n?.name??''))rules.add('INITIALIZER');
    if(nodes.some(x=>x.nodeType==='BinaryOperation'&&/^(?:\+|-|\*|\/|%|\*\*)$/.test(x.operator))&&
      (ctx.stateReads.length||ctx.stateWrites.length))rules.add('ARITHMETIC_ON_STATE');
    if(nodes.some(x=>x.nodeType==='BinaryOperation'&&x.operator==='/')||hasCall(/^(mulDiv|mulDivDown|mulDivUp|divUp|divDown|divWadDown|divWadUp)$/))rules.add('DIVISION');
    if(nodes.some(x=>x.nodeType==='Literal'&&/^(10000|1000|1e4|1e6|1e18|1e27)$/i.test(String(x.value)))||
      has(/\b(BPS|BASIS|WAD|RAY|SCALE|PRECISION|DENOMINATOR)\b/i))rules.add('BPS_OR_SCALE_CONSTANT');
    if(ctx.stateWrites.some(x=>/executed|cancel|approved|claimed|status|state|active|paused|used/i.test(x)))rules.add('STATUS_FLAG_WRITE');
    if(ctx.stateWrites.length&&nodes.some(x=>x.nodeType==='IndexAccess'||x.nodeType==='MemberAccess'))rules.add('MAPPING_STRUCT_WRITE');
    if(t.external.length)rules.add('EXTERNAL_CALL');
    if(members.some(x=>/^(call|delegatecall|staticcall|send|transfer)$/.test(x.memberName)&&
      /^address\b/.test(x.expression?.typeDescriptions?.typeString??'')))rules.add('LOW_LEVEL_CALL');
    if(members.some(x=>x.memberName==='delegatecall'))rules.add('DELEGATECALL');
    if(t.external.some(x=>x.parent?.nodeType==='Assignment'||x.parent?.nodeType==='Return'||x.parent?.nodeType==='IfStatement'||
      x.parent?.nodeType==='VariableDeclarationStatement'))rules.add('RETURN_VALUE_USED');
    if(t.external.length&&t.writes.length&&t.external.some(x=>t.writes.some(y=>nodeStart(x.call)<nodeStart(y.v))))rules.add('EXTERNAL_CALL_BEFORE_STATE_WRITE');
    if(t.external.some(x=>params.some(p=>sourceText(t.source.bytes,x.base?.src??'').includes(p.name)&&p.name)))rules.add('ARBITRARY_TARGET_CALL');
    if(hasCall(TOKEN))rules.add('TOKEN_TRANSFER');
    if(hasCall(/^balanceOf$/))rules.add('TOKEN_BALANCE_READ');
    if(hasCall(APPROVE))rules.add('APPROVE_OR_PERMIT');
    if(hasCall(/^(latestRoundData|latestAnswer|getPrice|getRate|consult|observe|getQuote|twap|quote)$/))rules.add('ORACLE_READ');
    if(hasCall(/^(getReserves|slot0|getCurrentLiveBalances|getPoolTokenInfo|getPoolTokens)$/))rules.add('SPOT_PRICE_READ');
    if(/^swap|exactInput|exactOutput|exchange|trade/i.test(n?.name??'')||hasCall(/^(swap|exactInput|exactOutput|exchange|trade)/i))rules.add('SWAP_OR_TRADE');
    if(params.some(p=>/min(Amount)?Out|minReturn|amountOutMin|limit/i.test(p.name)))rules.add('MIN_OUT_PARAM');
    if(params.some(p=>/deadline/i.test(p.name)))rules.add('DEADLINE_PARAM');
    if(hasCall(/^(ecrecover|recover|tryRecover|isValidSignatureNow|isValidSignature)$/))rules.add('SIGNATURE_VERIFY');
    if([...ctx.stateReads,...ctx.stateWrites].some(x=>/nonce/i.test(x)))rules.add('NONCE_USE');
    if(has(/DOMAIN_SEPARATOR|_hashTypedDataV4|EIP712/))rules.add('EIP712');
    if(has(/keccak256\s*\(\s*abi\.encode(Packed)?\s*\(/))rules.add('KEY_DERIVATION');
    if(params.filter(p=>/tokenIn|tokenOut|tokenA|tokenB|from|to|base|quote/i.test(p.name)&&
      /address/.test(p.typeDescriptions?.typeString??'')).length>=2)rules.add('ORDER_SENSITIVE_PAIR');
    if(t.meta?.contract?.directBases.some(x=>/Upgradeable|Initializable|UUPS|ERC1967|Proxy/.test(x)))rules.add('PROXY_PATTERN');
    if([...ctx.stateReads,...ctx.stateWrites].includes('__gap'))rules.add('STORAGE_GAP');
    if(nodes.some(x=>['ForStatement','WhileStatement'].includes(x.nodeType)&&/\.\s*length/.test(sourceText(t.source.bytes,x.condition?.src??''))))rules.add('LOOP_OVER_DYNAMIC');
    if(t.external.some(x=>nodes.some(v=>['ForStatement','WhileStatement'].includes(v.nodeType)&&nodeStart(x.call)>=nodeStart(v)&&
      nodeStart(x.call)<=nodeStart(v)+Number(String(v.src).split(':')[1]))))rules.add('EXTERNAL_CALL_IN_LOOP');
    if(hasCall(/^push$/)&&ctx.stateWrites.length)rules.add('PUSH_TO_UNBOUNDED_ARRAY');
    if(hasCall(TOKEN)&&!has(/transfer(?:From)?\s*\(\s*msg\.sender/))rules.add('VALUE_FLOW_CROSS_USER');
    if(/^(?:_mint|_burn|mint|burn)$/.test(n?.name??'')||hasCall(/^(?:_mint|_burn|mint|burn)$/)||ctx.stateWrites.includes('totalSupply'))rules.add('SHARE_MINT_BURN');
    if(has(/fee|bps|split|distribut|reward/i)&&nodes.some(x=>x.nodeType==='BinaryOperation'))rules.add('FEE_DISTRIBUTION');
    if(hasMember('block','timestamp'))rules.add('BLOCK_TIMESTAMP');
    if(hasMember('block','number'))rules.add('BLOCK_NUMBER');
    if(has(/lzReceive|ccipReceive|_nonblockingLzReceive|receiveWormhole|messenger|bridge/i))rules.add('CROSS_CHAIN_MESSAGE');
    if(ctx.kind==='CONSTANT'||ctx.kind==='IMMUTABLE')rules.add('CONSTANT');
    if((ctx.kind==='CONSTRUCTOR'||rules.has('INITIALIZER'))&&params.length&&ctx.stateWrites.length)rules.add('CONSTRUCTOR_OR_INITIALIZER_PARAM');
    triggers[ctx.contextId]=rules;
  }
  // A reachable callee contributes writes/external calls to its public/external entry and vice versa.
  const reverse=new Map();
  for(const c of contexts)for(const id of c.internalCalls) {
    const parent=lookup.get(id);if(!parent)continue;
    const arr=reverse.get(parent.contextId)??[];arr.push(c.contextId);reverse.set(parent.contextId,arr);
  }
  for(const c of contexts) {
    const seen=new Set([c.contextId]),queue=[[c.contextId,0]];
    while(queue.length) {
      const [id,depth]=queue.shift();if(depth>=3)continue;
      for(const linked of lookup.get(byId.get(id)?.symbolId)?.internalCalls??[]) {
        const to=lookup.get(linked);if(to&&!seen.has(to.contextId)){seen.add(to.contextId);queue.push([to.contextId,depth+1]);}
      }
    }
    c.dependencySymbolIds=distinct([...seen].filter(x=>x!==c.contextId).map(x=>byId.get(x)?.symbolId));
    if(['public','external'].includes(c.visibility)&&[...seen].some(id=>triggers[id]?.has('STATE_WRITE')||triggers[id]?.has('EXTERNAL_CALL')))triggers[c.contextId].add('STATE_WRITE_EXTERNAL');
    for(const parentId of reverse.get(c.contextId)??[]) {
      const parent=byId.get(parentId);
      if(parent&&['public','external'].includes(parent.visibility)&&[...seen].some(id=>triggers[id]?.has('STATE_WRITE')||triggers[id]?.has('EXTERNAL_CALL')))
        triggers[c.contextId].add('STATE_WRITE_EXTERNAL');
    }
    if(triggers[c.contextId].has('PUSH_TO_UNBOUNDED_ARRAY')&&!triggers[c.contextId].has('STATE_WRITE_EXTERNAL'))
      triggers[c.contextId].delete('PUSH_TO_UNBOUNDED_ARRAY');
  }
  let complete=true;
  for(const s of sourceUnits) {
    if(['AVAILABLE','AVAILABLE_AUXILIARY','AVAILABLE_IDENTICAL_SOURCE_ALIAS','AVAILABLE_VYPER_AST','AVAILABLE_IDENTICAL_VYPER_AST_ALIAS'].includes(s.astStatus)||s.scopeTier!=='IN_SCOPE'&&s.astStatus!=='UNSUPPORTED_LANGUAGE')continue;
    const scriptWithoutAst=s.astStatus==='SCRIPT_TEXT_REVIEW'||(includeScripts&&s.astStatus==='MISSING'&&
      (/(^|\/)(script|scripts|deploy|deployment|deployments|configure|config|handover)\//i.test(s.path)||s.path.endsWith('.s.sol')));
    const importOnlyShim=s.astStatus==='SOURCE_VERIFIED_IMPORT_ONLY';
    if(s.astStatus==='MISSING'&&s.scopeTier==='IN_SCOPE'&&!scriptWithoutAst)complete=false;
    if(s.astStatus==='UNSUPPORTED_LANGUAGE'&&s.scopeTier==='IN_SCOPE')complete=false;
    const source=bySource.get(s.path),n=source.bytes,kind=scriptWithoutAst?'SCRIPT_FILE':importOnlyShim?'IMPORT_ONLY_FILE':'FILE_FALLBACK';
    const symbolId='SYM-'+digestCanonicalV1({path:s.path,qualifiedContainer:s.path,kind,canonicalSignature:'file()'}).slice(0,16);
    const ctx={contextId:symbolId.replace(/^SYM-/,'CTX-'),symbolId,path:s.path,qualifiedContainer:s.path,kind,
      canonicalSignature:'file()',visibility:'internal',lineStart:1,lineEnd:lines(n,'0:'+n.length).lineEnd,
      effectiveIn:(scriptWithoutAst||importOnlyShim)?[s.path]:[],
      scopeTier:s.scopeTier,dependencySymbolIds:[],stateReads:[],stateWrites:[],internalCalls:[],modifiers:[],externalCalls:[],
      ...(!(scriptWithoutAst||importOnlyShim)?{orphan:true}:{})};
    contexts.push(ctx);
    declarations.push({symbolId,path:s.path,qualifiedContainer:s.path,containerKind:'file',kind,name:s.path,
      canonicalSignature:'file()',visibility:'internal',stateMutability:'nonpayable',lineStart:1,lineEnd:ctx.lineEnd,hasBody:false});
    if(scriptWithoutAst)limitations.push({code:'SCRIPT_TEXT_REVIEW_NO_AST',path:s.path,
      detail:'No admitted production AST; exact source-bound deployment script must receive full source-file correctness review.'});
    else if(importOnlyShim)limitations.push({code:'SOURCE_VERIFIED_IMPORT_ONLY',path:s.path,
      detail:'Verified admitted Solidity source contains only pragma/import directives, with no declarations or executable code; all relative imports have admitted ASTs or exact-byte AST aliases.'});
    else if(s.astStatus==='MISSING')limitations.push({code:'INVENTORY_INCOMPLETE',path:s.path,detail:'In-scope Solidity source has no admitted AST'});
    else limitations.push({code:'UNSUPPORTED_LANGUAGE_FILE_FALLBACK',path:s.path,detail:'Vyper requires file-level review'});
    const needed=scriptWithoutAst?['SCRIPT_EXECUTION']:importOnlyShim?[]:
      loadTaxonomyV1(new URL('../../../../../',import.meta.url).pathname).classes.filter(x=>x.testRequired).flatMap(x=>x.triggers);
    triggers[ctx.contextId]=distinct(needed);
  }
  // Script/config/handover text surfaces are review units in v13 even when
  // Solidity compilation cannot produce an AST (JS, shell, YAML, JSON).
  // Older frozen authorities retain their historical compiled-only inventory.
  if(includeScripts){
    const skip=new Set(['.git','node_modules','vendor','lib','ipor-fusion','out','dist','build','artifacts','cache','.audit-hermetic-build']);
    const textExt=/\.(?:mjs|cjs|js|ts|py|sh|json|ya?ml)$/i;
    const scriptDirectory=/(^|\/)(?:script|scripts|deploy|deployment|deployments|configure|config|handover|internal)\//i;
    let n=0;
    async function addTextScripts(dir){
      for(const entry of await fs.readdir(dir,{withFileTypes:true})){
        if(skip.has(entry.name))continue;
        const abs=path.join(dir,entry.name);
        if(entry.isDirectory()){await addTextScripts(abs);continue;}
        if(!entry.isFile())continue;
        const rel=path.relative(projectRoot,abs).split(path.sep).join('/');
        if(!scriptDirectory.test(rel)||!textExt.test(rel)||sourceExplicitlyExcludedV1(rel,scope))continue;
        if(++n>1000)throw new Error('v13 deployment script review inventory exceeds 1000 files; explicitly narrow excludedPaths');
        const content=await fs.readFile(abs);
        const hash=createHash('sha256').update(content).digest('hex');
        const symbolId='SYM-'+digestCanonicalV1({path:rel,kind:'SCRIPT_FILE'}).slice(0,16);
        const ctx={contextId:symbolId.replace('SYM-','CTX-'),symbolId,path:rel,qualifiedContainer:rel,
          kind:'SCRIPT_FILE',canonicalSignature:'script-file()',visibility:'internal',
          lineStart:1,lineEnd:content.toString('utf8').split('\n').length,effectiveIn:[rel],
          scopeTier:'IN_SCOPE',dependencySymbolIds:[],stateReads:[],stateWrites:[],
          internalCalls:[],modifiers:[],externalCalls:[]};
        sourceUnits.push({sourceId:'SRC-SCRIPT-'+String(n).padStart(3,'0'),path:rel,sha256:hash,
          scopeTier:'IN_SCOPE',lineCount:ctx.lineEnd,astStatus:'SCRIPT_TEXT_REVIEW'});
        declarations.push({...ctx,name:rel,containerKind:'file',hasBody:true});
        contexts.push(ctx);triggers[ctx.contextId]=new Set(['SCRIPT_EXECUTION']);
      }
    }
    await addTextScripts(projectRoot);
  }
  for (const ctx of contexts) {
    const t=temp.get(ctx.contextId), contract=t?.meta?.contract;
    if(contract) {
      ctx.directBases=distinct(contract.directBases??[]);
      ctx.implementedInterfaces=distinct(contract.implementedInterfaces??[]);
      ctx.contractKind=contract.containerKind;
      ctx.contractAbstract=contract.abstract;
    }
    if(t?.meta?.node) {
      const source=t.source.bytes, sourceSlice=sourceText(source,t.meta.node.src);
      const firstLine=ctx.lineStart;
      ctx.senderCheckLines=distinct(sourceSlice.split('\n').flatMap((line,i)=>
        /(?:require|if)\s*\([^;]*msg\.sender|(?:hasRole|_checkRole|canPerform|_authenticateCaller|getActionId|_checkOwner)\s*\(/.test(line)?[firstLine+i]:[])).map(Number);
      ctx.txOriginLines=distinct(sourceSlice.split('\n').flatMap((line,i)=>/tx\.origin/.test(line)?[firstLine+i]:[])).map(Number);
    }
  }
  sourceUnits.sort((a,b)=>a.path.localeCompare(b.path));
  const triggerObj={};for(const c of [...contexts].sort(byPosition))triggerObj[c.contextId]=distinct([...(triggers[c.contextId]??[])]);
  contexts.sort(byPosition);declarations.sort((a,b)=>a.path.localeCompare(b.path)||a.lineStart-b.lineStart||a.symbolId.localeCompare(b.symbolId));
  limitations.sort((a,b)=>a.path.localeCompare(b.path)||a.code.localeCompare(b.code));
  const byKind={};for(const c of contexts)byKind[c.kind]=(byKind[c.kind]??0)+1;
  return emptyArtifact(campaign,{sourceUnits,declarations,contexts,triggers:triggerObj,limitations,complete,
    counts:{sourceUnits:sourceUnits.length,inScopeUnits:sourceUnits.filter(x=>x.scopeTier==='IN_SCOPE').length,
      declarations:declarations.length,contexts:contexts.length,byKind:Object.fromEntries(Object.entries(byKind).sort(([a],[b])=>a.localeCompare(b))) }});
}

export async function writeReviewInventoryOutputsV1({outputDir,projectRoot,build,request,policy,reviewPolicy=null,slither=null}) {
  if(policy!==POLICY)return;
  const campaign={campaignId:request?.campaignId,campaignGenerationId:request?.campaignGenerationId,
    sourceSha256:request?.source?.archiveSha256,generatedAt:request?.generatedAt??new Date().toISOString(),
    ...(reviewPolicy==='correctness-verdict-v13'?{detectionReviewPolicy:reviewPolicy}:{})};
  try {
    const inventory=await buildReviewInventoryV1({projectRoot,build,campaign,slither});
    const facts=buildSystemFactsV1({inventory});
    console.log('[phase0-inventory-summary]',JSON.stringify({complete:inventory.payload.complete,sourceUnits:inventory.payload.sourceUnits.length,contexts:inventory.payload.contexts.length,missing:inventory.payload.sourceUnits.filter(s=>s.scopeTier==='IN_SCOPE'&&s.astStatus==='MISSING').slice(0,12).map(s=>s.path)}));
    await fs.mkdir(outputDir,{recursive:true});
    await fs.writeFile(path.join(outputDir,'REVIEW_INVENTORY_v1.json'),JSON.stringify(inventory,null,2)+'\n');
    await fs.writeFile(path.join(outputDir,'SYSTEM_FACTS_v1.json'),JSON.stringify(facts,null,2)+'\n');
  } catch(e) {
    const payload=blankPayload();
    payload.limitations=[{code:'INVENTORY_BUILD_ERROR',path:'*',detail:String(e?.message??e).slice(0,2000)}];
    try {
      await fs.mkdir(outputDir,{recursive:true});
      await fs.writeFile(path.join(outputDir,'REVIEW_INVENTORY_v1.json'),
        JSON.stringify(emptyArtifact(campaign,payload),null,2)+'\n');
    } catch { /* Phase 0 must continue even when inventory cannot be persisted. */ }
  }
}

// Re-applies a package's audit scope to an inventory that was built without it (campaigns whose
// Phase 0 predates scope support). Keeps in-scope contexts, keeps dependency functions that
// in-scope contracts inherit and expose as INHERITED_DEPENDENCY contexts, and drops the rest.
export function applyAuditScopeToInventoryV1({inventory,scope,generatedAt,includeScripts=false}) {
  if(scope?.source!==AUDIT_SCOPE_FILE)throw new Error('applyAuditScopeToInventoryV1 requires an '+AUDIT_SCOPE_FILE+' scope');
  const payload=structuredClone(inventory.payload);
  const tierOf=(p)=>sourceTierV1(p,scope,{includeScripts});
  const inScopeContainers=new Set(payload.contexts.filter(c=>tierOf(c.path)==='IN_SCOPE').map(c=>c.qualifiedContainer));
  const contexts=[];
  for(const c of payload.contexts) {
    const tier=tierOf(c.path);
    if(tier==='IN_SCOPE'){contexts.push({...c,scopeTier:'IN_SCOPE'});continue;}
    if(tier==='DEPENDENCY'&&['FUNCTION','GENERATED_GETTER'].includes(c.kind)&&['public','external'].includes(c.visibility)&&
      (c.effectiveIn??[]).some(q=>inScopeContainers.has(q)))
      contexts.push({...c,kind:'INHERITED_DEPENDENCY',scopeTier:'INHERITED_DEPENDENCY'});
  }
  const kept=new Set(contexts.map(c=>c.contextId));
  payload.contexts=contexts;
  payload.triggers=Object.fromEntries(Object.entries(payload.triggers??{}).filter(([id])=>kept.has(id)));
  payload.sourceUnits=(payload.sourceUnits??[]).map(u=>({...u,scopeTier:tierOf(u.path)}));
  payload.limitations=[{code:'SCOPE_FROM_AUDIT_SCOPE_FILE',path:AUDIT_SCOPE_FILE,
    detail:'Re-scoped after Phase 0. In scope: '+scope.inScopePaths.join(', ')+'. Every other compiled source is a dependency, reviewed only where in-scope contracts inherit it.'},
    ...(payload.limitations??[]).filter(l=>l.code!=='DEPENDENCY_TIER_BY_PATH'&&!(l.code==='INVENTORY_INCOMPLETE'&&tierOf(l.path)!=='IN_SCOPE'))];
  payload.complete=!payload.sourceUnits.some(u=>u.scopeTier==='IN_SCOPE'&&
    (u.astStatus==='UNSUPPORTED_LANGUAGE'||(u.astStatus==='MISSING'&&
    !(includeScripts&&payload.contexts.some(c=>c.kind==='SCRIPT_FILE'&&c.path===u.path)))));
  const byKind={};for(const c of contexts)byKind[c.kind]=(byKind[c.kind]??0)+1;
  payload.counts={...(payload.counts??{}),sourceUnits:payload.sourceUnits.length,
    inScopeUnits:payload.sourceUnits.filter(u=>u.scopeTier==='IN_SCOPE').length,contexts:contexts.length,byKind};
  return {...inventory,generatedAt:generatedAt??inventory.generatedAt,payload};
}

// Sealed Phase 0 inventory files stay byte-exact (receipts bind their digests). A scope correction
// is written beside them under scope-corrected/ and every reader prefers it when present.
export const SCOPE_CORRECTED_DIR_V1='evidence/review-inventory/scope-corrected';
export function reviewInventoryRelV1(root,campaignPath,name) {
  const corrected=path.posix.join(campaignPath,SCOPE_CORRECTED_DIR_V1,name);
  return existsSync(path.join(root,...corrected.split('/')))?corrected:path.posix.join(campaignPath,'evidence/review-inventory',name);
}
