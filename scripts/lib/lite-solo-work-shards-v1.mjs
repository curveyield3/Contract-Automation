import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MAX_SHARD=64*1024, MAX_INDEX=32*1024;
// Fixed semantic work shards may grow as source-bound review entries are completed.
const MAX_V13_SHARD_BYTES=100*1024;
// The immutable index bounds fixed rows; its agent-owned append slots need capacity
// for large discovery reconciliation without changing the campaign-bound index.
const MAX_V13_APPEND_BYTES=1024*1024, MAX_V13_APPEND_RECORDS=1024;
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

// Reviewer-authored semantic shards are the sole Lite-Solo work transport.
 // Full-form materialization happens only at the phase controller boundary.
export function materializeSemanticWorkFormV13({root,formRel}){
 const indexRel=path.posix.join(path.posix.dirname(formRel),'shards','INDEX_v1.json');
 if(!fs.existsSync(relfile(root,indexRel)))throw new Error('missing required semantic work-shard index');
 const {content}=secureRestoreWorkFormV13({root,indexRel});
 fs.writeFileSync(relfile(root,formRel),content);
 return true;
}

export function semanticShardFailureIndexV13({root,indexRel,deficiencies=[]}={}){
 if(!indexRel)return {shards:[],unmapped:deficiencies};
 const index=JSON.parse(fs.readFileSync(relfile(root,indexRel),'utf8'));
 const matches=new Map(),unmapped=[];
 if(index.schemaVersion!=='curveyield-work-shard-index-v13')
   throw new Error('unsupported work-shard index: expected semantic v13');
 const descriptors=index.pages.flatMap(p=>secureReadV13(root,path.posix.join(path.posix.dirname(indexRel),p.file)).shards);
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
// No legacy size-based work-shard mode is generated or accepted.
const secureLocationV13=(formRel,phase)=>{
 const campaign=formRel.split('/work/phase-')[0];
 return path.posix.join(campaign,'controller/shards/phase-'+String(phase).padStart(2,'0'));
};
const securePrettyV13=x=>JSON.stringify(x,null,2)+'\n';
const secureHashV13=x=>digest(securePrettyV13(x));
const secureReadV13=(root,rel)=>JSON.parse(fs.readFileSync(relfile(root,rel),'utf8'));
const secureWriteV13=(root,rel,value)=>{
 const f=relfile(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,securePrettyV13(value));
};
const secureSameV13=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

 // Solo-only immutable BASE pagination. Controller-bound SHA256 digests preserve
 // the original 64-KiB per-file limit, without altering editable semantic sharding.
 const MAX_SOLO_BASE_BYTES=32*1024*1024;
 const SOLO_BASE_CHUNK_BYTES=40*1024;
 const SOLO_BASE_PAGE_RE=/^BASE_PART_[0-9]{4}_v1\.json$/;
 function writeSoloLockedBaseV1({root,workDir,base}){
   const original=Buffer.from(securePrettyV13(base));
   if(original.length<=MAX_SHARD){
     secureWriteV13(root,path.posix.join(workDir,'BASE_v1.json'),base);
     return [];
   }
   if(original.length>MAX_SOLO_BASE_BYTES)throw new Error('lite-solo locked base exceeds bounded 32-MiB total');
   const pages=[];
   for(let i=0,offset=0;offset<original.length;i++,offset+=SOLO_BASE_CHUNK_BYTES){
     if(i>=9999)throw new Error('lite-solo immutable base page count exceeded');
     const part=original.subarray(offset,offset+SOLO_BASE_CHUNK_BYTES);
     const file='BASE_PART_'+String(i+1).padStart(4,'0')+'_v1.json';
     const page={schemaVersion:'curveyield-lite-solo-locked-base-page-v1',index:i,contentBase64:part.toString('base64')};
     if(bytes(page)>MAX_SHARD)throw new Error('lite-solo immutable base fragment exceeds 64 KiB');
     secureWriteV13(root,path.posix.join(workDir,file),page);
     pages.push({file,sha256:secureHashV13(page),bytes:bytes(page),chunkBytes:part.length});
   }
   const descriptor={schemaVersion:'curveyield-lite-solo-locked-base-v1',encoding:'base64',
     originalBytes:original.length,originalSha256:digest(original),pages};
   if(bytes(descriptor)>MAX_SHARD)throw new Error('lite-solo locked base index exceeds 64 KiB');
   secureWriteV13(root,path.posix.join(workDir,'BASE_v1.json'),descriptor);
   return pages.map(x=>x.file);
 }
 function readSoloLockedBaseV1({root,workDir,baseText}){
   const payload=JSON.parse(baseText);
   if(payload?.schemaVersion!=='curveyield-lite-solo-locked-base-v1')
     return {full:payload,pages:[]};
   if(payload.encoding!=='base64'||!Array.isArray(payload.pages)||!payload.pages.length||
      !Number.isSafeInteger(payload.originalBytes)||payload.originalBytes<=MAX_SHARD||
      payload.originalBytes>MAX_SOLO_BASE_BYTES||!(/^[a-f0-9]{64}$/.test(payload.originalSha256)))
     throw new Error('invalid lite-solo immutable base descriptor');
   const fragments=[],seen=new Set();let length=0;
   for(const [i,spec] of payload.pages.entries()){
     if(!spec||!SOLO_BASE_PAGE_RE.test(spec.file)||seen.has(spec.file)||
        !(/^[a-f0-9]{64}$/.test(spec.sha256))||
        !Number.isInteger(spec.bytes)||spec.bytes<=0||spec.bytes>MAX_SHARD||
        !Number.isInteger(spec.chunkBytes)||spec.chunkBytes<1||spec.chunkBytes>SOLO_BASE_CHUNK_BYTES)
       throw new Error('invalid lite-solo immutable base page descriptor');
     seen.add(spec.file);
     const page=secureReadV13(root,path.posix.join(workDir,spec.file));
     if(page?.schemaVersion!=='curveyield-lite-solo-locked-base-page-v1'||
        page.index!==i||typeof page.contentBase64!=='string'||
        bytes(page)!==spec.bytes||secureHashV13(page)!==spec.sha256)
       throw new Error('lite-solo immutable base page integrity mismatch: '+spec.file);
     const fragment=Buffer.from(page.contentBase64,'base64');
     if(fragment.toString('base64')!==page.contentBase64||fragment.length!==spec.chunkBytes)
       throw new Error('lite-solo immutable base fragment encoding mismatch: '+spec.file);
     length+=fragment.length;
     if(length>MAX_SOLO_BASE_BYTES)throw new Error('lite-solo immutable base exceeds bounded total');
     fragments.push(fragment);
   }
   if(length!==payload.originalBytes)throw new Error('lite-solo immutable base fragment length mismatch');
   const restored=Buffer.concat(fragments);
   if(digest(restored)!==payload.originalSha256)throw new Error('lite-solo immutable base hash mismatch');
   return {full:JSON.parse(restored.toString('utf8')),pages:[...seen]};
 }


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
       if(bytes(body)>MAX_V13_SHARD_BYTES)throw new Error('v13 work shard exceeds 100 KiB: '+file);
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
       while(i<value.length&&entries.length<48){
         const key=recordKey(tokens,value[i],i);
         const proposed={schemaVersion:'curveyield-work-shard-v13',kind:'array',path:tokens,startIndex:start,
           entries:[...entries,{key,value:value[i]}]};
         if(bytes(proposed)>MAX_V13_SHARD_BYTES){
           if(!entries.length)throw new Error('v13 record larger than 100 KiB: '+key);
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
 const basePages=writeSoloLockedBaseV1({root,workDir,base});
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
   baseFile:'BASE_v1.json',baseSha256:secureHashV13(secureReadV13(root,path.posix.join(workDir,'BASE_v1.json'))),pages};
 if(bytes(index)>MAX_INDEX)throw new Error('v13 root index exceeds 32 KiB');
 secureWriteV13(root,path.posix.join(workDir,'INDEX_v1.json'),index);
 secureWriteV13(root,path.posix.join(controllerDir,'INDEX_v1.json'),index);
 // Prevent stranded shards after re-sharding. Only indexed filenames remain.
 const allowed=new Set(['INDEX_v1.json','BASE_v1.json',...basePages,...pages.map(p=>p.file),...descriptions.map(s=>s.file)]);
 for(const name of fs.readdirSync(relfile(root,workDir))){
   if(/^(?:shard-[0-9]+_v1|INDEX_PAGE_[0-9]+_v1|INDEX_PART_[0-9]+_v1|BASE_PART_[0-9]+_v1|input-[0-9]{4}-[0-9]{4}_v1)\.json$/.test(name)&&!allowed.has(name))
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
 const restored=readSoloLockedBaseV1({root,workDir,baseText});
 const full=restored.full,basePages=restored.pages,seenFiles=new Set(),arrays=new Map(),identities=new Map();
 const load=(desc)=>{
   if(seenFiles.has(desc.file))throw new Error('duplicate v13 shard filename: '+desc.file);
   seenFiles.add(desc.file);
   if(!/^shard-[0-9]{4}_v1\.json$/.test(desc.file))throw new Error('invalid v13 shard filename');
   const rel=path.posix.join(workDir,desc.file);
   const raw=fs.readFileSync(relfile(root,rel),'utf8');
   const maxBytes=desc.append?MAX_V13_APPEND_BYTES:MAX_V13_SHARD_BYTES;
   const maxRecords=desc.append?MAX_V13_APPEND_RECORDS:48;
   if(Buffer.byteLength(raw)>maxBytes)throw new Error('v13 shard exceeds authorized bound: '+desc.file);
   const item=JSON.parse(raw);
   if(item.schemaVersion!=='curveyield-work-shard-v13'||item.kind!==desc.kind||
     !secureSameV13(item.path,desc.path)||item.startIndex!==desc.startIndex||
     !Array.isArray(item.entries)||item.entries.length>maxRecords)
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
 const allowed=new Set(['BASE_v1.json','INDEX_v1.json',...basePages,...pageNames,...seenFiles]);
 for(const name of fs.readdirSync(relfile(root,workDir)))
   if(/^(?:shard-[0-9]+_v1|INDEX_PAGE_[0-9]+_v1|BASE_PART_[0-9]+_v1)\.json$/.test(name)&&!allowed.has(name))
     throw new Error('v13 unknown agent shard or index page: '+name);
 return {formRel:working.formRel,content:securePrettyV13(full),
   recordCount:[...arrays.values()].reduce((n,s)=>n+s.size,0)};
}
