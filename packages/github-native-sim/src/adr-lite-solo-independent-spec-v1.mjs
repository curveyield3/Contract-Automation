import fs from 'node:fs';
import path from 'node:path';
const normative=/\b(?:must|shall|should|require|only|never|always|ensure|at least|maximum|minimum|invariant|expected|forbidden|cannot)\b/i;
const docsRe=/^(?:README(?:[._-].+)?|[^/]+\.(?:md|mdx|rst|txt))$/i;
const escapeReg=x=>x.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&');
function locate(sourceRoot,rel){
 const direct=path.join(sourceRoot,...rel.split('/'));
 if(fs.existsSync(direct)&&fs.statSync(direct).isFile())return direct;
 for(const ent of fs.existsSync(sourceRoot)?fs.readdirSync(sourceRoot,{withFileTypes:true}):[]){
  if(!ent.isDirectory()||ent.name.startsWith('.'))continue;
  const file=path.join(sourceRoot,ent.name,...rel.split('/'));
  if(fs.existsSync(file)&&fs.statSync(file).isFile())return file;
 }
 return null;
}

// Fork-only: preserve every matching specification rule while using a larger explicit fail-closed packet bound.
const MAX_SOLO_MATCHED_SPEC_RULES=512;
const documentationCache=new Map();
function scanSourceDocumentationV13(sourceRoot){
 if(documentationCache.has(sourceRoot))return documentationCache.get(sourceRoot);
 const MAX_DOCS=2000,MAX_DEPTH=20,MAX_DOC_BYTES=2*1024*1024,MAX_TOTAL_BYTES=128*1024*1024;
 const files=[];let totalBytes=0;
 const excluded=new Set(['.git','node_modules','out','build','artifacts']);
 function walk(dir,depth){
   if(depth>MAX_DEPTH)throw new Error('V13_SPEC_DEPTH_LIMIT: documentation under '+dir+' exceeds '+MAX_DEPTH+' levels; cannot certify complete specification search');
   for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
     if(ent.isDirectory()){
       if(!excluded.has(ent.name))walk(path.join(dir,ent.name),depth+1);
       continue;
     }
     if(!ent.isFile()||!docsRe.test(ent.name))continue;
     const candidate=path.join(dir,ent.name),bytes=fs.statSync(candidate).size;
     if(bytes>MAX_DOC_BYTES)throw new Error('V13_SPEC_DOCUMENT_LIMIT: '+candidate+' exceeds 2 MiB and cannot be silently skipped');
     totalBytes+=bytes;
     if(files.length+1>MAX_DOCS||totalBytes>MAX_TOTAL_BYTES)
       throw new Error('V13_SPEC_SEARCH_LIMIT: documentation set exceeds 2000 files or 128 MiB; fail closed rather than miss requirements');
     files.push(candidate);
   }
 }
 if(fs.existsSync(sourceRoot))walk(sourceRoot,0);
 documentationCache.set(sourceRoot,files);
 return files;
}
export function independentSpecItemsV13({root,campaignPath,context,otherContexts=[]}={}){
 const sourceRoot=path.join(root,...campaignPath.split('/'),'source'),rules=[],referenceConstants=[];
 const file=locate(sourceRoot,context.path);
 if(file){
  const lines=fs.readFileSync(file,'utf8').split('\n');
  for(let i=Math.max(0,context.lineStart-16);i<Math.min(lines.length,context.lineStart+3);i++){
   if(/^\s*(?:\/\/|\/\*|\*|\*\/)/.test(lines[i])&&normative.test(lines[i])){
    const txt=lines[i].replace(/^\s*(?:\/\/\/?|\/\*+|\*|\/)\s*/,'').trim();
    rules.push({type:'SOURCE_COMMENT',ruleId:'COMMENT:'+context.contextId+':'+(i+1),
     sourceAnchor:context.path+':L'+(i+1),rule:txt.slice(0,2048)});
   }
  }
 }
 const name=String(context.canonicalSignature??'').split('(')[0];
 // Traverse the source documentation tree once; the previous 8-file/four-level
 // cap silently dropped relevant specifications. Safety limits fail closed.
 const visits=scanSourceDocumentationV13(sourceRoot);
 const docCount=visits.length;
 const match=name.length>2?new RegExp('\\b'+escapeReg(name)+'\\b','i'):null;
 for(const doc of visits){
  const lines=fs.readFileSync(doc,'utf8').split('\n');
  for(let i=0;i<lines.length;i++){
   if(normative.test(lines[i])&&match?.test(lines.slice(Math.max(0,i-2),Math.min(i+3,lines.length)).join(' '))){
    const rel=path.relative(sourceRoot,doc).split(path.sep).join('/');
    rules.push({type:'README_OR_DOC',ruleId:'DOC:'+context.contextId+':'+rel+':'+(i+1),
     sourceAnchor:'source/'+rel+':L'+(i+1),rule:lines[i].trim().slice(0,2048)});
    if(rules.length>MAX_SOLO_MATCHED_SPEC_RULES)throw new Error('SOLO_SPEC_RULE_LIMIT: more than '+MAX_SOLO_MATCHED_SPEC_RULES+' rules match '+context.contextId+'; do not silently truncate');
   }
  }
 }
 for(const c of otherContexts.filter(x=>x.contextId!==context.contextId&&x.kind==='CONSTANT'&&
  typeof x.declaredValue==='string'&&x.declaredValue!=='UNINITIALIZED').slice(0,24)){
  if(c.qualifiedContainer!==context.qualifiedContainer)referenceConstants.push({
   sourceAnchor:c.path+':L'+c.lineStart,constant:c.canonicalSignature,
   observedValue:c.declaredValue,sourceContract:c.qualifiedContainer,
   note:'Observed code value only; not an independent specification'});
 }
 if(rules.length>MAX_SOLO_MATCHED_SPEC_RULES)throw new Error('V13_SPEC_RULE_LIMIT: '+rules.length+
  ' documented rules match '+context.contextId+'; split the review or explicitly raise the bounded packet limit');
 return {documentationItems:rules,referenceConstants,checkedDocCount:docCount,
  sourceCommentsChecked:Boolean(file),missingSource:!file};
}
