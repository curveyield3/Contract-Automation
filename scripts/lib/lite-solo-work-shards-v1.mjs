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
// Direct-phase AI-owned arrays may expand; issued-subject arrays remain fixed.
// Queued Phase 4-6 APPEND ownership is handled by the unit queue.
const DIRECT_OPEN_ARRAYS_V13={
  1:{'step-1':['relevantStructuralSurfaces','phase0LimitationsRelevantToPhase1','unresolvedStructuralUncertainties','targetedVerificationNeeds'],
    'step-2':['protectedAssets','authorityActors','trustBoundaries','stateTransitions','prohibitedOutcomes','semanticRequirements','ambiguities'],
    'step-3':['dependencyAssessments'],'step-4':['standardsAssessments'],
    'step-5':['riskDrivers','credibleLossPaths','riskAssumptions'],'step-6':['promotionTriggers','phase1Limitations']},
  2:{'step-1':['relevantInheritedFacts','inheritedAssumptions','unresolvedPropertyQuestions'],
    'step-2':['requirements'],'step-3':['propertyDesigns']},
  3:{'step-1':['attackHypotheses'],'step-2':['customValidationObligations']},
  // Phase 4–6 queue unit families share the same issued v13 array shards.
  // Fixed subject rows remain in SHARD/BATCH; new discoveries, distinct
  // observations, and existing-subject additions use only permitted APPENDs.
  4:{'step-2':['specialistReviewRecords'],
     'step-3':['typedLimitations','candidateRecords']},
  5:{'step-1':['economicReviewRecords'],
     'step-2':['reconciliationRecords','newCandidateRecords'],
     'step-3':['targetDesigns']},
  6:{'step-1':['deploymentAssessments'],
     'step-5':['candidateProofRecords','newCandidateRecords']},
  8:{'step-1':['candidateGroups']},9:{},10:{'step-2':['assuranceClaims']}
};
const mayAppendDirectArrayV13=(phase,step,field)=>
  Boolean(DIRECT_OPEN_ARRAYS_V13[phase]?.[step]?.includes(field));
const recordKey=(pathTokens,value,i)=>{
 const field=['contextId','candidateKey','tempKey','canonicalId','obligationId',
    'findingTempKey','assetKey','actorKey','boundaryKey','transitionKey',
    'requirementKey','dependencyKey','standardKey','driverKey','groupKey',
    'recordKey','testGroupId','findingKey','subjectKey','id','key']
   .find(k=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value[k]==='string'&&value[k].trim());
 return JSON.stringify(pathTokens)+':'+(field?field+'='+value[field]:String(i));
};
const clone=x=>structuredClone(x);

const CONTINUATION_FILE_V13=/^shard-[0-9]{4}_CONT_([0-9]{4})_v1\.json$/;
const appendContinuationFileV13=(base,chunk)=>
 base.replace(/_v1\.json$/,'_CONT_'+String(chunk).padStart(4,'0')+'_v1.json');
const appendChunkKeyV13=(tokens,chunk,ordinal)=>
 JSON.stringify(tokens)+':APPEND-C'+String(chunk).padStart(4,'0')+'-'+
 String(ordinal+1).padStart(4,'0');

// Mechanically reconstruct adjacent bounded direct-form continuation pages.
// The original trusted index authorizes the parent APPEND collection; each
// continuation is a new agent-authored page, never a rewrite of that index.
// appendContinuation:true explicitly promises the next page, so an incomplete
// delivery cannot be silently mistaken for a completed collection.
function directAppendPagesV13({root,workDir,desc,primary}){
 if(!desc.append)return [];
 const names=fs.readdirSync(relfile(root,workDir));
 const prefix=desc.file.replace(/_v1\.json$/,'_CONT_');
 const suffix='_v1.json';
 const found=names.filter(name=>name.startsWith(prefix)&&name.endsWith(suffix));
 const numbered=found.map(file=>{
  const index=Number(file.slice(prefix.length,-suffix.length));
  if(!Number.isSafeInteger(index)||index<2||
     file!==appendContinuationFileV13(desc.file,index))
   throw new Error('APPEND_CONTINUATION_INVALID_FILENAME: '+file);
  return {file,index};
 }).sort((a,b)=>a.index-b.index);
 const out=[];
 let preceding=primary,ordinalStart=desc.startIndex+primary.entries.length;
 for(let i=0;i<numbered.length;i++){
  const {file,index}=numbered[i];
  if(index!==i+2)throw new Error('APPEND_CONTINUATION_MISSING_CHUNK: '+desc.file);
  if(preceding.appendContinuation!==true)
   throw new Error('APPEND_CONTINUATION_NOT_REQUESTED: '+file);
  const rel=path.posix.join(workDir,file);
  const raw=fs.readFileSync(relfile(root,rel));
  if(raw.length>MAX_V13_APPEND_BYTES)
   throw new Error('APPEND_CONTINUATION_TRANSPORT_LIMIT: '+file);
  const page=JSON.parse(raw.toString('utf8'));
  if(page.schemaVersion!=='curveyield-work-shard-v13'||
     page.kind!=='array'||!secureSameV13(page.path,desc.path)||
     page.startIndex!==ordinalStart||!Array.isArray(page.entries)||
     page.entries.length>MAX_V13_APPEND_RECORDS||
     page.entries.some((entry,j)=>entry?.key!==
      appendChunkKeyV13(desc.path,index,j)))
   throw new Error('APPEND_CONTINUATION_IDENTITY_MISMATCH: '+file);
  out.push({file,chunkNumber:index,...page});
  preceding=page;ordinalStart+=page.entries.length;
 }
 if(preceding.appendContinuation===true)
  throw new Error('APPEND_CONTINUATION_AWAITING_NEXT_CHUNK: '+desc.file);
 return out;
}
// Queue-owned continuation arrays are only supplied from the accepted unit
// roster, never inferred from editable shard files. Source-bound ordering is
// controlled by the issued continuation ordinal and not by commit order.
function queuedAppendPagesV13({desc,provided,primaryCount}){
 const selected=provided.filter(page=>secureSameV13(page.path,desc.path));
 const sorted=[...selected].sort((a,b)=>a.chunkNumber-b.chunkNumber);
 let expectedIndex=desc.startIndex+primaryCount;
 for(const [i,page] of sorted.entries()){
  if(page.chunkNumber!==i+2||page.startIndex!==expectedIndex||
     !Array.isArray(page.entries)||page.entries.length>MAX_V13_APPEND_RECORDS||
     page.entries.some((entry,j)=>entry?.key!==appendChunkKeyV13(desc.path,page.chunkNumber,j)))
   throw new Error('QUEUED_APPEND_CONTINUATION_IDENTITY_MISMATCH: '+desc.file);
  const slab={schemaVersion:'curveyield-work-shard-v13',kind:'array',
   path:desc.path,startIndex:page.startIndex,entries:page.entries};
  if(bytes(slab)>MAX_V13_APPEND_BYTES)
   throw new Error('QUEUED_APPEND_CONTINUATION_TRANSPORT_LIMIT: '+desc.file);
  expectedIndex+=page.entries.length;
 }
 return sorted;
}

// Reviewer-authored semantic shards are the sole Lite-Solo work transport.
 // Full-form materialization happens only at the phase controller boundary.
export function materializeSemanticWorkFormV13({root,formRel,acceptedContinuations=[]}){
 // Reconstruct from issued controller descriptors, never mutable index pages.
 // This is deterministic transport assembly, not a security quality gate.
 const indexRel=path.posix.join(path.posix.dirname(formRel),'shards','INDEX_v1.json');
 // Derive the issued phase from the controller-assigned form path, not from
 // mutable reviewer index metadata.
 const issuedPhase=Number(formRel.match(/(?:^|\/)work\/phase-(\d+)\//)?.[1]);
 if(!Number.isInteger(issuedPhase)||issuedPhase<1)throw new Error('invalid issued direct-phase work path');
 const controllerDir=secureLocationV13(formRel,issuedPhase);
 const index=secureReadV13(root,path.posix.join(controllerDir,'INDEX_v1.json'));
 const workDir=path.posix.dirname(indexRel);
 // New issuance retains a controller-owned base for immutable prefill fields.
 // Older issued campaigns retain their original transport representation.
 const issuedBase=path.posix.join(controllerDir,index.baseFile);
 const sourceDir=fs.existsSync(relfile(root,issuedBase))?controllerDir:workDir;
 const baseText=fs.readFileSync(relfile(root,path.posix.join(sourceDir,index.baseFile)),'utf8');
 const full=readSoloLockedBaseV1({root,workDir:sourceDir,baseText}).full;
 for(const pageRef of index.pages||[]){
  const page=secureReadV13(root,path.posix.join(controllerDir,pageRef.file));
  for(const desc of page.shards||[]){
   const shard=secureReadV13(root,path.posix.join(workDir,desc.file));
   const tokens=Array.isArray(desc.path)?desc.path:[];
   if(!tokens.length)continue;
   let target=full;
   for(const token of tokens.slice(0,-1)){
    if(target[token]===undefined||target[token]===null||typeof target[token]!=='object')target[token]={};
    target=target[token];
   }
   const field=tokens.at(-1),entries=Array.isArray(shard.entries)?shard.entries:[];
   if(desc.kind==='scalar'){
    if(entries.length)target[field]=entries[0].value;
   }else{
    const output=Array.isArray(target[field])?target[field]:[];
    // Fixed shards fill only issued slots; they cannot shift originals or
    // overwrite entries of separately allocated APPEND shards.
    const count=desc.append?entries.length:Math.min(entries.length,desc.recordKeys?.length??0);
    // Do not collapse continuation pages into an oversized APPEND shard.
    // Each page stays separately bounded and retains its own original key.
    const additional=desc.append?
     (acceptedContinuations.length?
       queuedAppendPagesV13({desc,provided:acceptedContinuations,primaryCount:entries.length}):
       [1,2,3,8,9,10].includes(issuedPhase)?
        directAppendPagesV13({root,workDir,desc,primary:shard}):[]):[];
    const records=[...entries.slice(0,count),...additional.flatMap(page=>page.entries)];
    for(let j=0;j<records.length;j++){
     let value=records[j].value;
     if(!desc.append&&value&&typeof value==='object'&&!Array.isArray(value)){
      const identity=String(desc.recordKeys[j]??'').match(/^([A-Za-z][A-Za-z0-9_]*)=(.*)$/);
      if(identity&&identity[2]&&!identity[2].startsWith('<')&&identity[2]!=='TODO'){
       // Preserve issued subject identity, not a rewrite of its stable key.
       value={...value,[identity[1]]:identity[2]};
      }
     }
     output[(Number(desc.startIndex)||0)+j]=value;
    }
    target[field]=output;
   }
  }
 }
 const output=relfile(root,formRel);
 fs.mkdirSync(path.dirname(output),{recursive:true});
 fs.writeFileSync(output,securePrettyV13(full));
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
     if(mayAppendDirectArrayV13(phase,stepName,field))add('array',value.length,[],true);
   }
 }
 const basePages=writeSoloLockedBaseV1({root,workDir,base});
 // Keep the exact original issued automation inputs, unchanged scalar output
 // containers, and base page hashes in the existing controller-owned shard
 // directory. Editable work base bytes cannot silently rewrite prefill.
 writeSoloLockedBaseV1({root,workDir:controllerDir,base});
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
     const templateIdentity=!desc.append&&/^(tempKey|findingTempKey|candidateKey|assetKey|actorKey|boundaryKey|transitionKey|requirementKey|dependencyKey|standardKey|driverKey|groupKey|recordKey|testGroupId)=<REQUIRED(?:_OR_EXPLICIT_NEGATIVE)?>$/.test(desc.recordKeys[j]);
     const completedTemplateIdentity=templateIdentity&&recordKey(desc.path,entry.value,pos).startsWith(prefix+desc.recordKeys[j].split('=')[0]+'=');
     // Placeholder-keyed optional record slots may be completed with a
     // schema-approved negative sentinel rather than a fabricated finding.
     const completedTemplateNegative=templateIdentity&&['NONE_IDENTIFIED','NO_CANDIDATE'].includes(entry.value);
     // Phase-3 Step-2 has one controller-issued NONE_IDENTIFIED starter at
     // index zero, keyed "0". When genuinely custom obligations exist, its
     // value becomes a complete named record while the shard key stays fixed.
     // Never relax identity for other prefilled or controller-owned records.
     const legacyPositionalIdentity=!desc.append&&desc.recordKeys[j]===String(pos);
     const completedCustomObligationStarter=!desc.append&&phase===3&&
       desc.path.join('.')==='actions.step-2.outputs.customValidationObligations'&&
       pos===0&&desc.recordKeys[j]==='0'&&
       entry.value&&typeof entry.value==='object'&&!Array.isArray(entry.value)&&
       typeof entry.value.tempKey==='string'&&entry.value.tempKey.trim().length>0&&
       Array.isArray(entry.value.originFactKeys)&&entry.value.originFactKeys.length>0&&
       entry.value.originFactKeys.every(x=>typeof x==='string'&&x.trim().length>0)&&
       ['4','6'].includes(entry.value.requiredPhase)&&
       typeof entry.value.requiredAction==='string'&&entry.value.requiredAction.trim().length>0&&
       typeof entry.value.completionCondition==='string'&&entry.value.completionCondition.trim().length>0&&
       typeof entry.value.priority==='string'&&entry.value.priority.trim().length>0;
     if(entry.key!==expected||(!desc.append&&!legacyPositionalIdentity&&!completedTemplateIdentity&&!completedTemplateNegative&&!completedCustomObligationStarter&&recordKey(desc.path,entry.value,pos)!==expected))
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
