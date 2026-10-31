#!/usr/bin/env node
// v1: recover and authenticate candidate raw evidence in GitHub Actions.
// No simulation, source mutation, or acceptance-state modification.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readV7RawResultV1} from '../packages/github-native-sim/src/v7-compact-result-v1.mjs';

const root=process.argv[2];
if(!root)throw Error('Audit-Controller checkout root required');
const workspace='campaigns/CurveYield DEX v16 Source r4';
const expectedSource='201a70f61f14e1919d111a972d090b07cf13e5fc06fee10738785adfb6760f4e';
const targets=[
  ['P4-CAND-001','dar-e90e25268ed35e78ec790c3e7ea1ced2','e90e25268ed35e78ec790c3e7ea1ced2a2beb1fd46031b9de41aab983f291100'],
  ['P4-CAND-002','dar-6789618073ed4c65d3e5f8ce7708f9e3','6789618073ed4c65d3e5f8ce7708f9e310aacf71975bb84e0ed4ea19d1355e0a']
];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const relevant=/(test|fuzz|slither|stdout|stderr|error|failure|profile|reproduc|trace|assert|case|seed|component|invok|coverage|result)/i;
const forbiddenWhole=/(^|\.)(solc|compileroutput|standardjson|contracts|sources|bytecode|assembly|metadata|ast|sbom)(\.|$)/i;
const MAX_DATA_BYTES=18*1024*1024,MAX_PART_BYTES=110000,MAX_ITEMS=300;
for(const [candidate,requestId,requestDigest] of targets){
  const evidence=path.join(root,workspace,'evidence/phase5-boundary',candidate,requestId);
  const descriptor=JSON.parse(fs.readFileSync(path.join(evidence,'raw-result.json'),'utf8'));
  if(descriptor.requestId!==requestId||descriptor.requestDigest!==requestDigest)throw Error(candidate+' descriptor request mismatch');
  const original=readV7RawResultV1(path.join(evidence,'raw-result.json'));
  if(original.requestId!==requestId||original.requestDigest!==requestDigest)throw Error(candidate+' decoded request mismatch');
  const request=JSON.parse(fs.readFileSync(path.join(root,workspace,'work/phase-05/execution-requests',candidate+'.json'),'utf8'));
  if(request.source.archiveSha256!==expectedSource||request.requestId!==requestId||request.requestDigest!==requestDigest)throw Error(candidate+' pinned source/request mismatch');
  if(original.source?.archiveSha256&&original.source.archiveSha256!==expectedSource)throw Error(candidate+' raw source mismatch');
  const out=path.join(evidence,'readable-extraction-v1');
  fs.mkdirSync(out,{recursive:true});
  const index={schemaVersion:'curveyield-candidate-evidence-extraction-v1',candidateId:candidate,sourceSha256:expectedSource,requestId,requestDigest,originalSha256:descriptor.originalSha256,originalBytes:descriptor.originalBytes,compressedSha256:descriptor.compressedSha256,extractionMethod:'readV7RawResultV1 + exact JSON subtree encoding + UTF-8-partition',topLevelKeys:Object.keys(original),records:[],omitted:[],limits:{maxExtractedBytes:MAX_DATA_BYTES,maxItems:MAX_ITEMS}};
  let spent=0;
  const save=(pointer,value)=>{
    const serialized=JSON.stringify({jsonPointer:pointer,value});
    const bytes=Buffer.from(serialized,'utf8');
    if(spent+bytes.length>MAX_DATA_BYTES||index.records.length>=MAX_ITEMS){index.omitted.push({jsonPointer:pointer,bytes:bytes.length,reason:'EXTRACTION_BUDGET'});return;}
    const stem='extracted-'+String(index.records.length+1).padStart(3,'0');
    const n=Math.ceil(bytes.length/MAX_PART_BYTES),parts=[];
    for(let j=0;j<n;j++){
      const chunk=bytes.subarray(j*MAX_PART_BYTES,(j+1)*MAX_PART_BYTES);
      const file=stem+'-'+String(j+1).padStart(3,'0')+'.part';
      fs.writeFileSync(path.join(out,file),chunk);
      parts.push({file,bytes:chunk.length,sha256:sha(chunk)});
    }
    index.records.push({jsonPointer:pointer,bytes:bytes.length,sha256:sha(bytes),parts});
    spent+=bytes.length;
  };
  const seen=new WeakSet();
  const topology=[];
  function traverse(value,pointer,depth){
    if(depth>16||topology.length>=12000)return;
    const type=Array.isArray(value)?'array':typeof value;
    if(value&&typeof value==='object'){
      if(seen.has(value))return;seen.add(value);
      const keys=Object.keys(value);
      if(depth<7)topology.push({pointer,type,size:keys.length,keys:depth<4?keys.slice(0,100):undefined});
      for(const key of keys){
        const child=value[key],p=pointer+'/'+key.replaceAll('~','~0').replaceAll('/','~1');
        const match=relevant.test(key),excluded=forbiddenWhole.test(p);
        if(match&&!excluded&&depth<=12){
          const size=Buffer.byteLength(JSON.stringify(child)??'null');
          if(size<=750000&&(!child||typeof child!=='object'||depth>1||size<100000)){
            save(p,child);continue;
          }
        }
        if(child&&typeof child==='object')traverse(child,p,depth+1);
        else if(match&&!excluded)save(p,child);
      }
    }else if(depth<2)topology.push({pointer,type});
  }
  traverse(original,'',0);
  index.topology=topology;
  index.extractedBytes=spent;
  index.totalRecords=index.records.length;
  index.exhaustive= index.omitted.length===0;
  index.note='Selected result subtrees only; unselected source/compiler payloads stay in authenticated original gzip. Not a substitute for unexecuted controls or candidate proof.';
  fs.writeFileSync(path.join(out,'INDEX_v1.json'),JSON.stringify(index,null,2)+'\n');
  process.stdout.write(JSON.stringify({candidate,records:index.records.length,bytes:spent,omitted:index.omitted.length,topology:topology.length,folder:out})+'\n');
}
