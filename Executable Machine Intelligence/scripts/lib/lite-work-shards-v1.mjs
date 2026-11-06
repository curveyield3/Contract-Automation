import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MAX_SHARD=64*1024, MAX_INDEX=32*1024, TARGET_SHARD=58*1024;
const bytes=x=>Buffer.byteLength(JSON.stringify(x,null,2)+'\n');
const digest=x=>createHash('sha256').update(x).digest('hex');
const pretty=x=>JSON.stringify(x,null,2)+'\n';
const relfile=(root,rel)=> {
 if(typeof rel!=='string'||!rel||rel.startsWith('/')||rel.split('/').some(x=>x==='..'||x==='.'||!x))
   throw new Error('unsafe shard path');
 return path.join(root,...rel.split('/'));
};
const recordKey=(pathTokens,value,i)=>{
 const field=['contextId','candidateKey','tempKey','canonicalId','obligationId','findingTempKey','id','key']
   .find(k=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value[k]==='string'&&value[k].trim());
 return JSON.stringify(pathTokens)+':'+(field?field+'='+value[field]:String(i));
};
const clone=x=>structuredClone(x);

// Group large arrays into no more than 25 records and no more than 64 KiB per shard.
// Small editable arrays and scalar fields remain in the BASE shard.
export function shardWorkFormV1({root,formRel,phase,retireFull=true,force=false}){
 const full=relfile(root,formRel);
 const input=fs.readFileSync(full,'utf8');
 if(secureShardIndexExistsV13({root,formRel}))return secureShardWorkFormV13({root,formRel,phase,retireFull});
 if(!force&&Buffer.byteLength(input)<=MAX_SHARD)return null;
 const original=JSON.parse(input),base=clone(original),arrays=[];
 const visit=(node,tokens)=>{
  if(Array.isArray(node)){
   if(node.length>25||bytes(node)>TARGET_SHARD){
    arrays.push({tokens,items:node});
    return [];
   }
   return node.map((v,i)=>visit(v,[...tokens,i]));
  }
  if(!node||typeof node!=='object')return node;
  return Object.fromEntries(Object.entries(node).map(([k,v])=>[k,visit(v,[...tokens,k])]));
 };
 const structure=visit(original,[]);
 const baseRel=path.posix.join(path.posix.dirname(formRel),'shards','BASE_v1.json');
 if(bytes(structure)>MAX_SHARD)throw new Error('work-form base shard exceeds 64 KiB; a large unshardable scalar/object is present');
 const dir=path.dirname(relfile(root,baseRel));
 fs.mkdirSync(dir,{recursive:true});
 const baseText=pretty(structure);
 fs.writeFileSync(relfile(root,baseRel),baseText);
 const shards=[],globalKeys=new Set();
 for(const {tokens,items} of arrays){
   let next=0;
   while(next<items.length){
     const start=next,entries=[];
     for(;next<items.length&&entries.length<25;next++){
       const key=recordKey(tokens,items[next],next);
       if(globalKeys.has(key))throw new Error('duplicate work-form record key '+key);
       const proposed={schemaVersion:'curveyield-work-shard-v1',arrayPath:tokens,startIndex:start,entries:[...entries,{key,value:items[next]}]};
       if(bytes(proposed)>MAX_SHARD){
         if(!entries.length)throw new Error('single work-form record exceeds 64 KiB: '+key);
         break;
       }
       entries.push({key,value:items[next]});globalKeys.add(key);
     }
     const shard={schemaVersion:'curveyield-work-shard-v1',arrayPath:tokens,startIndex:start,entries};
     const file='shard-'+String(shards.length+1).padStart(4,'0')+'_v1.json';
     const rel=path.posix.join(path.posix.dirname(baseRel),file),content=pretty(shard);
     if(Buffer.byteLength(content)>MAX_SHARD)throw new Error('oversized work shard');
     fs.writeFileSync(relfile(root,rel),content);
     // The array path already occurs once in the descriptor. Repeating it in
     // every record key made a 323-row form exceed the entire 32-KiB index.
     // Store only the identity suffix; preserve the full canonical key in the
     // record shard, with independent content SHA-256 on both sides.
     const prefix=JSON.stringify(tokens)+':';
     shards.push({file,path:tokens,startIndex:start,
       recordKeys:entries.map(x=> {
         if(!x.key.startsWith(prefix))throw new Error('record key array-path mismatch');
         return x.key.slice(prefix.length);
       }),sha256:digest(content),bytes:Buffer.byteLength(content)});
   }
 }
 const index={schemaVersion:'curveyield-work-shard-index-v1',phase,formRel,
   baseFile:'BASE_v1.json',baseSha256:digest(baseText),baseBytes:bytes(structure),
   originalSha256:digest(input),originalBytes:Buffer.byteLength(input),shards};
 const indexRel=path.posix.join(path.posix.dirname(baseRel),'INDEX_v1.json');
 if(bytes(index)>MAX_INDEX)throw new Error('work shard index exceeds 32 KiB');
 fs.writeFileSync(relfile(root,indexRel),pretty(index));
 if(retireFull)fs.unlinkSync(full);
 return {indexRel,shards:shards.length,recordCount:globalKeys.size};
}

export function restoreWorkShardsV1({root,indexRel,refreshDigests=false}){
 if(secureShardIndexExistsV13({root,formRel:path.posix.join(path.posix.dirname(path.posix.dirname(indexRel)),path.posix.basename(JSON.parse(fs.readFileSync(relfile(root,indexRel),'utf8')).formRel))}))return secureRestoreWorkFormV13({root,indexRel});
 const indexFile=relfile(root,indexRel),index=JSON.parse(fs.readFileSync(indexFile,'utf8'));
 if(index.schemaVersion!=='curveyield-work-shard-index-v1')throw new Error('wrong work shard index schema');
 if(bytes(index)>MAX_INDEX)throw new Error('oversized work shard index');
 const parent=path.posix.dirname(indexRel);
 const baseRel=path.posix.join(parent,index.baseFile);
 const baseText=fs.readFileSync(relfile(root,baseRel),'utf8');
 if(Buffer.byteLength(baseText)>MAX_SHARD||digest(baseText)!==index.baseSha256)
   throw new Error('work shard base integrity mismatch');
 const full=JSON.parse(baseText),keys=new Set(),ranges=new Map();
 for(const spec of index.shards){
  if(!/^shard-[0-9]{4}_v1\.json$/.test(spec.file))throw new Error('unsafe shard filename');
  const body=fs.readFileSync(relfile(root,path.posix.join(parent,spec.file)),'utf8');
  if(Buffer.byteLength(body)>MAX_SHARD)throw new Error('work shard exceeds 64 KiB');
  const hash=digest(body);
  if(!refreshDigests&&hash!==spec.sha256)throw new Error('work shard digest mismatch: '+spec.file);
  const shard=JSON.parse(body);
  if(shard.schemaVersion!=='curveyield-work-shard-v1'||
    JSON.stringify(shard.arrayPath)!==JSON.stringify(spec.path)||
    shard.startIndex!==spec.startIndex||!Array.isArray(shard.entries)||
    shard.entries.length!==spec.recordKeys.length||shard.entries.length>25)
    throw new Error('work shard structure mismatch: '+spec.file);
  const arrayId=JSON.stringify(spec.path);
  let target=full;
  for(const token of spec.path){if(target===undefined||target===null)throw new Error('missing shard array');target=target[token];}
  if(!Array.isArray(target))throw new Error('shard target is not an array');
  const occupied=ranges.get(arrayId)??new Set();
  for(const [j,item] of shard.entries.entries()){
   const i=spec.startIndex+j,key=recordKey(spec.path,item.value,i);
   const stored=spec.recordKeys[j],fullIndexKey=stored.startsWith('[')?
     stored:JSON.stringify(spec.path)+':'+stored;
   if(key!==item.key||key!==fullIndexKey||keys.has(key)||occupied.has(i))
     throw new Error('missing, duplicated or changed work record key: '+key);
   keys.add(key);occupied.add(i);target[i]=item.value;
  }
  ranges.set(arrayId,occupied);
  if(refreshDigests){spec.sha256=hash;spec.bytes=Buffer.byteLength(body);}
 }
 for(const [p,occupied] of ranges){
  let target=full;for(const token of JSON.parse(p))target=target[token];
  if(target.length!==occupied.size||[...target.keys()].some(i=>!occupied.has(i)))
    throw new Error('shard array missing or has duplicate record index '+p);
 }
 const result=pretty(full);
 if(!refreshDigests&&index.originalSha256!==digest(result))
   throw new Error('shard round-trip changed original form bytes');
 if(refreshDigests){
  index.originalSha256=digest(result);index.originalBytes=Buffer.byteLength(result);
  if(bytes(index)>MAX_INDEX)throw new Error('updated work shard index exceeds 32 KiB');
  fs.writeFileSync(indexFile,pretty(index));
 }
 return {formRel:index.formRel,content:result,recordCount:keys.size};
}

export function materializeShardedWorkFormV1({root,formRel,refreshDigests=true}){
 const indexRel=path.posix.join(path.posix.dirname(formRel),'shards','INDEX_v1.json');
 if(!fs.existsSync(relfile(root,indexRel)))return false;
 const {content}=restoreWorkShardsV1({root,indexRel,refreshDigests});
 fs.writeFileSync(relfile(root,formRel),content);
 return true;
}

export function shardFailureIndexV1({root,indexRel,deficiencies=[]}={}){
 if(!indexRel)return {shards:[],unmapped:deficiencies};
 const index=JSON.parse(fs.readFileSync(relfile(root,indexRel),'utf8'));
 const matches=new Map(),unmapped=[];
 const descriptors=index.schemaVersion==='curveyield-work-shard-index-v13'
   ?index.pages.flatMap(p=>secureReadV13(root,path.posix.join(path.posix.dirname(indexRel),p.file)).shards)
   :index.shards;
 for(const description of deficiencies){
  const message=String(description);
  const ref=message.match(/(step-[0-9]+)\.outputs\.([A-Za-z][A-Za-z0-9_]*)\[([0-9]+)\]/);
  const loose=message.match(/targetDesigns\[([0-9]+)\]/);
  const indexInArray=ref?Number(ref[3]):loose?Number(loose[1]):null;
  const step=ref?.[1]??'step-3',field=ref?.[2]??'targetDesigns';
  if(indexInArray===null){unmapped.push(message);continue;}
  const shard=descriptors.find(s=>s.path.includes(step)&&s.path.includes(field)&&
    indexInArray>=s.startIndex&&indexInArray<s.startIndex+s.recordKeys.length);
  if(!shard){unmapped.push(message);continue;}
  const rel=path.posix.join(path.posix.dirname(indexRel),shard.file);
  const item=matches.get(rel)??{path:rel,recordKeys:[],defects:[]};
  const key=shard.recordKeys[indexInArray-shard.startIndex];
  if(!item.recordKeys.includes(key))item.recordKeys.push(key);
  item.defects.push(message);matches.set(rel,item);
 }
 return {shards:[...matches.values()].sort((a,b)=>a.path.localeCompare(b.path)),unmapped};
}


// v13 only: editable outputs live in work shards; the controller's expected
// structure is stored separately from every reviewer-facing index and shard.
// Frozen v12 paths retain the original sharding and validation contract above.
const secureLocationV13=(formRel,phase)=>{
 const campaign=formRel.split('/work/phase-')[0];
 return path.posix.join(campaign,'controller/shards/phase-'+String(phase).padStart(2,'0'));
};
const securePrettyV13=x=>JSON.stringify(x,null,2)+'\n';
const secureHashV13=x=>digest(securePrettyV13(x));
const secureShardIndexExistsV13=({root,formRel})=>{
 const phase=Number(formRel.match(/\/work\/phase-([0-9]+)/)?.[1]??-1);
 return phase>=0&&fs.existsSync(relfile(root,path.posix.join(secureLocationV13(formRel,phase),'INDEX_v1.json')));
};
const secureReadV13=(root,rel)=>JSON.parse(fs.readFileSync(relfile(root,rel),'utf8'));
const secureWriteV13=(root,rel,value)=>{
 const f=relfile(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,securePrettyV13(value));
};
const secureSameV13=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

// Build a bounded, paged index of immutable expected filenames and record
// identities. Existing records are not deletable; append slots can grow
// without rewriting a controller-owned index.
export function secureShardWorkFormV13({root,formRel,phase,retireFull=true}){
 const original=secureReadV13(root,formRel),base=clone(original);
 const workDir=path.posix.join(path.posix.dirname(formRel),'shards');
 const controllerDir=secureLocationV13(formRel,phase);
 const descriptions=[];
 let serial=0;
 for(const [stepName,action] of Object.entries(base.actions??{})){
   const outputs=original.actions?.[stepName]?.outputs;
   if(!outputs||typeof outputs!=='object'||Array.isArray(outputs))continue;
   base.actions[stepName].outputs={};
   for(const [field,value] of Object.entries(outputs)){
     const tokens=['actions',stepName,'outputs',field];
     const prefix=JSON.stringify(tokens)+':';
     const add=(kind,startIndex,entries,append=false)=>{
       const file='shard-'+String(++serial).padStart(4,'0')+'_v1.json';
       const body={schemaVersion:'curveyield-work-shard-v13',kind,path:tokens,startIndex,entries};
       if(bytes(body)>MAX_SHARD)throw new Error('v13 work shard exceeds 64 KiB: '+file);
       secureWriteV13(root,path.posix.join(workDir,file),body);
       descriptions.push({file,kind,path:tokens,startIndex,append,
         recordKeys:append?[]:entries.map(x=>x.key.slice(prefix.length))});
     };
     if(!Array.isArray(value)){
       add('scalar',0,[{key:prefix+'value',value}]);
       continue;
     }
     let i=0;
     while(i<value.length){
       const start=i,entries=[];
       while(i<value.length&&entries.length<20){
         const key=recordKey(tokens,value[i],i);
         const proposed={schemaVersion:'curveyield-work-shard-v13',kind:'array',path:tokens,startIndex:start,
           entries:[...entries,{key,value:value[i]}]};
         if(bytes(proposed)>MAX_SHARD){
           if(!entries.length)throw new Error('v13 record larger than 64 KiB: '+key);
           break;
         }
         entries.push({key,value:value[i]});i++;
       }
       add('array',start,entries);
     }
     // Controller-assigned append positions, never agent-created shard names.
     add('array',value.length,[],true);
   }
 }
 if(bytes(base)>MAX_SHARD)throw new Error('v13 locked base exceeds 64 KiB');
 secureWriteV13(root,path.posix.join(workDir,'BASE_v1.json'),base);
 const pages=[];
 let batch=[],count=0;
 const flush=()=>{
   if(!batch.length)return;
   const file='INDEX_PAGE_'+String(pages.length+1).padStart(4,'0')+'_v1.json';
   const page={schemaVersion:'curveyield-work-shard-index-page-v13',shards:batch};
   if(bytes(page)>MAX_INDEX)throw new Error('v13 index page exceeds 32 KiB');
   secureWriteV13(root,path.posix.join(workDir,file),page);
   secureWriteV13(root,path.posix.join(controllerDir,file),page);
   pages.push({file,sha256:secureHashV13(page),shardCount:batch.length});
   batch=[];count=0;
 };
 for(const entry of descriptions){
   const recordCount=entry.recordKeys.length;
   if(batch.length&&(batch.length>=12||count+recordCount>128))flush();
   batch.push(entry);count+=recordCount;
 }
 flush();
 const index={schemaVersion:'curveyield-work-shard-index-v13',phase,formRel,
   baseFile:'BASE_v1.json',baseSha256:secureHashV13(base),pages};
 if(bytes(index)>MAX_INDEX)throw new Error('v13 root index exceeds 32 KiB');
 secureWriteV13(root,path.posix.join(workDir,'INDEX_v1.json'),index);
 secureWriteV13(root,path.posix.join(controllerDir,'INDEX_v1.json'),index);
 // Prevent stranded shards after re-sharding. Only indexed filenames remain.
 const allowed=new Set(['INDEX_v1.json','BASE_v1.json',...pages.map(p=>p.file),...descriptions.map(s=>s.file)]);
 for(const name of fs.readdirSync(relfile(root,workDir))){
   if(/^(?:shard-[0-9]+_v1|INDEX_PAGE_[0-9]+_v1)\.json$/.test(name)&&!allowed.has(name))
     fs.unlinkSync(relfile(root,path.posix.join(workDir,name)));
 }
 if(retireFull)fs.unlinkSync(relfile(root,formRel));
 return {indexRel:path.posix.join(workDir,'INDEX_v1.json'),shards:descriptions.length,
   recordCount:descriptions.reduce((n,s)=>n+s.recordKeys.length,0)};
}

export function secureRestoreWorkFormV13({root,indexRel}){
 const working=secureReadV13(root,indexRel),phase=working.phase;
 const trustedDir=secureLocationV13(working.formRel,phase),workDir=path.posix.dirname(indexRel);
 const trusted=secureReadV13(root,path.posix.join(trustedDir,'INDEX_v1.json'));
 if(!secureSameV13(working,trusted))throw new Error('v13 work shard index differs from controller-owned expected index');
 if(bytes(working)>MAX_INDEX)throw new Error('v13 root index exceeds 32 KiB');
 const baseText=fs.readFileSync(relfile(root,path.posix.join(workDir,working.baseFile)),'utf8');
 if(Buffer.byteLength(baseText)>MAX_SHARD||digest(baseText)!==trusted.baseSha256)
   throw new Error('v13 immutable work base changed');
 const full=JSON.parse(baseText),seenFiles=new Set(),arrays=new Map(),identities=new Map();
 const load=(desc)=>{
   if(seenFiles.has(desc.file))throw new Error('duplicate v13 shard filename: '+desc.file);
   seenFiles.add(desc.file);
   if(!/^shard-[0-9]{4}_v1\.json$/.test(desc.file))throw new Error('invalid v13 shard filename');
   const rel=path.posix.join(workDir,desc.file);
   const raw=fs.readFileSync(relfile(root,rel),'utf8');
   if(Buffer.byteLength(raw)>MAX_SHARD)throw new Error('v13 shard exceeds 64 KiB: '+desc.file);
   const item=JSON.parse(raw);
   if(item.schemaVersion!=='curveyield-work-shard-v13'||item.kind!==desc.kind||
     !secureSameV13(item.path,desc.path)||item.startIndex!==desc.startIndex||
     !Array.isArray(item.entries)||item.entries.length>25)
     throw new Error('v13 shard structure mismatch: '+desc.file);
   const prefix=JSON.stringify(desc.path)+':';
   let cursor=full;
   for(const token of desc.path.slice(0,-1)){if(cursor==null)throw new Error('invalid v13 output path');cursor=cursor[token];}
   if(!cursor||typeof cursor!=='object')throw new Error('invalid v13 output container');
   const field=desc.path.at(-1),id=JSON.stringify(desc.path);
   if(desc.kind==='scalar'){
     if(item.entries.length!==1||item.entries[0].key!==prefix+'value'||desc.recordKeys.length!==1)
       throw new Error('v13 scalar record changed: '+desc.file);
     cursor[field]=item.entries[0].value;
     return;
   }
   if(!Array.isArray(cursor[field]))cursor[field]=[];
   const positions=arrays.get(id)??new Set();
   if(!desc.append&&item.entries.length!==desc.recordKeys.length)
     throw new Error('v13 mandatory work records dropped: '+desc.file);
   for(const [j,entry] of item.entries.entries()){
     const pos=desc.startIndex+j;
     const expected=desc.append?prefix+'APPEND-'+String(j+1).padStart(4,'0'):prefix+desc.recordKeys[j];
     const templateIdentity=!desc.append&&/^(tempKey|findingTempKey|candidateKey)=<REQUIRED(?:_OR_EXPLICIT_NEGATIVE)?>$/.test(desc.recordKeys[j]);
     const completedTemplateIdentity=templateIdentity&&recordKey(desc.path,entry.value,pos).startsWith(prefix+desc.recordKeys[j].split('=')[0]+'=');
     // Placeholder-keyed optional record slots may be completed with a
     // schema-approved negative sentinel rather than a fabricated finding.
     const completedTemplateNegative=templateIdentity&&['NONE_IDENTIFIED','NO_CANDIDATE'].includes(entry.value);
     if(entry.key!==expected||(!desc.append&&!completedTemplateIdentity&&!completedTemplateNegative&&recordKey(desc.path,entry.value,pos)!==expected))
       throw new Error('v13 mandatory work record key changed: '+desc.file);
     if(positions.has(pos))throw new Error('v13 duplicate work record: '+desc.file);
     const identity=recordKey(desc.path,entry.value,pos);
     const knownIdentities=identities.get(id)??new Set();
     if(knownIdentities.has(identity))throw new Error('v13 duplicate candidate or work record identity: '+desc.file);
     knownIdentities.add(identity);identities.set(id,knownIdentities);
     positions.add(pos);cursor[field][pos]=entry.value;
   }
   arrays.set(id,positions);
 };
 let pageNames=new Set();
 for(const item of trusted.pages){
   if(pageNames.has(item.file)||!/^INDEX_PAGE_[0-9]{4}_v1\.json$/.test(item.file))
     throw new Error('invalid v13 index page');
   pageNames.add(item.file);
   const agentPage=secureReadV13(root,path.posix.join(workDir,item.file));
   const controllerPage=secureReadV13(root,path.posix.join(trustedDir,item.file));
   if(!secureSameV13(agentPage,controllerPage)||secureHashV13(agentPage)!==item.sha256||
      bytes(agentPage)>MAX_INDEX)
     throw new Error('v13 index page differs from controller-owned expected page: '+item.file);
   for(const desc of agentPage.shards??[])load(desc);
 }
 for(const [id,positions] of arrays){
   let value=full;for(const k of JSON.parse(id))value=value[k];
   if(value.length!==positions.size||[...value.keys()].some(i=>!positions.has(i)))
     throw new Error('v13 missing or duplicate indexed work record: '+id);
 }
 const allowed=new Set(['BASE_v1.json','INDEX_v1.json',...pageNames,...seenFiles]);
 for(const name of fs.readdirSync(relfile(root,workDir)))
   if(/^(?:shard-[0-9]+_v1|INDEX_PAGE_[0-9]+_v1)\.json$/.test(name)&&!allowed.has(name))
     throw new Error('v13 unknown agent shard or index page: '+name);
 return {formRel:working.formRel,content:securePrettyV13(full),
   recordCount:[...arrays.values()].reduce((n,s)=>n+s.size,0)};
}
