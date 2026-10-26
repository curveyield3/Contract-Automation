import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest=x=>createHash('sha256').update(x).digest('hex');
const srcKey=x=>String(x?.canonicalId??x?.tempKey??x?.candidateKey??'').trim();
const aliases=x=>[x?.canonicalId,x?.tempKey,x?.candidateKey].filter(x=>typeof x==='string'&&x.trim());
const read=(root,rel)=>fs.readFileSync(path.join(root,...rel.split('/')));
const output=(canonical,phase)=>phase===4?canonical.actions?.['step-3']?.outputs?.candidateRecords:
 canonical.actions?.['step-2']?.outputs?.newCandidateRecords;
const json=x=>JSON.stringify(x,null,2)+'\n';
export function verifySealedCanonicalSourceV1({root,campaignPath,phase}={}){
 if(![4,5].includes(phase))throw new Error('unsupported sealed canonical phase');
 const rel=path.posix.join(campaignPath,'derived/phase-'+phase+'/PHASE_0'+phase+'_CANONICAL_DATA_v1.json');
 const receipt=JSON.parse(read(root,path.posix.join(campaignPath,'receipts/PHASE_0'+phase+'_RECEIPT_v1.json')).toString('utf8'));
 const expected=path.posix.relative(campaignPath,rel);
 const entries=(receipt.evidence??[]).filter(x=>x?.role==='PHASE_CANONICAL_DATA'&&x.path===expected);
 if(entries.length!==1||!entries[0].sha256||!receipt.source?.sha256||!receipt.campaign?.campaignId)
  throw new Error('sealed Phase-'+phase+' canonical digest is missing or ambiguous');
 const observed=digest(read(root,rel));
 if(observed!==entries[0].sha256)
  throw new Error('sealed Phase-'+phase+' canonical source bytes differ from receipt digest');
 return {rel,sha256:observed,archiveSha256:receipt.source.sha256,campaignId:receipt.campaign.campaignId};
}
// Controller-created read acceleration only; source canonical and receipt
// remain the security authority. Never accept candidate pages without exact
// hash/source binding, and never use this index for final phase sealing.
export function readCandidateSourceSubsetV1({root,campaignPath,phase=5,keys=[]}={}){
 if(![5,6].includes(phase)||!Array.isArray(keys)||keys.length<1||keys.length>16)
  throw new Error('candidate-source subset requires Phase 5/6 and 1–16 keys');
 const sourceRefs=[path.posix.join(campaignPath,'derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json')];
 if(phase===6)sourceRefs.push(path.posix.join(campaignPath,'derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json'));
 for(const sourcePhase of phase===6?[4,5]:[4])
  verifySealedCanonicalSourceV1({root,campaignPath,phase:sourcePhase});
 const sourceDigests=sourceRefs.map(rel=>({rel,sha256:digest(read(root,rel))}));
 const prefix=path.posix.join(campaignPath,'controller/candidate-source-pages');
 const indexRel=path.posix.join(prefix,'PHASE_'+String(phase).padStart(2,'0')+'_INDEX_v1.json');
 let manifest=null;
 try{
  manifest=JSON.parse(read(root,indexRel).toString('utf8'));
  if(manifest.schemaVersion!=='curveyield-lite-candidate-source-page-index-v1'||
     JSON.stringify(manifest.sources)!==JSON.stringify(sourceDigests)||
     !Array.isArray(manifest.records)||!Array.isArray(manifest.pages))manifest=null;
 }catch{}
 if(!manifest){
  const items=[];
  for(const src of sourceRefs){
   const p=JSON.parse(read(root,src).toString('utf8'));
   const phaseId=src.includes('/phase-4/')?4:5;
   for(const record of output(p,phaseId)??[]){
    if(record&&typeof record==='object'&&!Array.isArray(record)&&srcKey(record))
     items.push(record);
   }
  }
  const ids=new Set(),allAliases=new Map(),records=[],pages=[];
  for(const [i,record] of items.entries()){
   const key=srcKey(record);
   if(ids.has(key))throw new Error('duplicate canonical source candidate '+key);
   ids.add(key);
   for(const alias of aliases(record)){
    if(allAliases.has(alias)&&allAliases.get(alias)!==key)
     throw new Error('ambiguous immutable source candidate alias '+alias);
    allAliases.set(alias,key);
   }
   records.push({canonicalKey:key,aliases:aliases(record),page:Math.floor(i/16),sha256:digest(json(record))});
  }
  fs.mkdirSync(path.join(root,...prefix.split('/')),{recursive:true});
  for(let i=0;i<items.length;i+=16){
   const id=Math.floor(i/16),file='PAGE_'+String(id+1).padStart(4,'0')+'_v1.json';
   const rel=path.posix.join(prefix,file);
   const body={schemaVersion:'curveyield-lite-candidate-source-page-v1',sources:sourceDigests,page:id,items:items.slice(i,i+16)};
   const bytes=Buffer.from(json(body));
   fs.writeFileSync(path.join(root,...rel.split('/')),bytes);
   pages.push({rel,bytes:bytes.length,sha256:digest(bytes)});
  }
  manifest={schemaVersion:'curveyield-lite-candidate-source-page-index-v1',
   sources:sourceDigests,recordCount:records.length,records,pages};
  fs.writeFileSync(path.join(root,...indexRel.split('/')),json(manifest));
 }
 const selected=[];
 const pageCache=new Map();
 for(const key of keys){
  const matching=manifest.records.filter(x=>x.aliases.includes(key)||x.canonicalKey===key);
  if(matching.length>1)throw new Error('ambiguous source candidate '+key);
  if(!matching.length)continue;
  const entry=matching[0],desc=manifest.pages[entry.page];
  if(!desc||desc.rel!==path.posix.join(prefix,'PAGE_'+String(entry.page+1).padStart(4,'0')+'_v1.json'))
   throw new Error('candidate source page path/index mismatch');
  if(!pageCache.has(entry.page)){
   const bytes=read(root,desc.rel);
   if(bytes.length!==desc.bytes||digest(bytes)!==desc.sha256)throw new Error('candidate source page digest mismatch');
   const page=JSON.parse(bytes.toString('utf8'));
   if(page.page!==entry.page||JSON.stringify(page.sources)!==JSON.stringify(sourceDigests)||!Array.isArray(page.items))
    throw new Error('candidate source page identity mismatch');
   pageCache.set(entry.page,page.items);
  }
  const found=pageCache.get(entry.page).filter(x=>srcKey(x)===entry.canonicalKey);
  if(found.length!==1||digest(json(found[0]))!==entry.sha256)
   throw new Error('candidate source record digest mismatch for '+key);
  selected.push(found[0]);
 }
 return {records:selected,missing:keys.filter(key=>!selected.some(x=>aliases(x).includes(key)||srcKey(x)===key)),
  total:manifest.recordCount,keys:manifest.records.map(x=>x.canonicalKey),indexRel,sourceDigests};
}
