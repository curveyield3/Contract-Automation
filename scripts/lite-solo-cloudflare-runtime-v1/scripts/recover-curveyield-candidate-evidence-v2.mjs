#!/usr/bin/env node
// v2: strictly selective, source- and digest-checked recovery; no simulation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readV7RawResultV1} from '../packages/github-native-sim/src/v7-compact-result-v1.mjs';

const root=process.argv[2];if(!root)throw Error('Audit-Controller checkout required');
const workspace='campaigns/CurveYield DEX v16 Source r4';
const source='201a70f61f14e1919d111a972d090b07cf13e5fc06fee10738785adfb6760f4e';
const entries=[
 ['P4-CAND-001','dar-e90e25268ed35e78ec790c3e7ea1ced2','e90e25268ed35e78ec790c3e7ea1ced2a2beb1fd46031b9de41aab983f291100'],
 ['P4-CAND-002','dar-6789618073ed4c65d3e5f8ce7708f9e3','6789618073ed4c65d3e5f8ce7708f9e310aacf71975bb84e0ed4ea19d1355e0a']
];
const sha=b=>createHash('sha256').update(b).digest('hex');
const relevant=/(test|fuzz|slither|stdout|stderr|error|failure|profile|reproduc|trace|assert|seed|case|component|invok|coverage|execution|analys|toolResult|summary|status|observ)/i;
const skip=/(^|\/)(build|artifacts|sourceAsts|standardJson|compilerOutput|metadata|sources|bytecode|abi|ast|devdoc|userdoc)(\/|$)/i;
for(const [candidate,id,digest] of entries){
  const folder=path.join(root,workspace,'evidence/phase5-boundary',candidate,id);
  const old=path.join(folder,'readable-extraction-v1');
  if(fs.existsSync(old))fs.rmSync(old,{recursive:true,force:true});
  const envelope=JSON.parse(fs.readFileSync(path.join(folder,'raw-result.json'),'utf8'));
  const request=JSON.parse(fs.readFileSync(path.join(root,workspace,'work/phase-05/execution-requests',candidate+'.json'),'utf8'));
  if(envelope.requestId!==id||envelope.requestDigest!==digest||request.requestId!==id||request.requestDigest!==digest||request.source.archiveSha256!==source)throw Error(candidate+' identity mismatch');
  const result=readV7RawResultV1(path.join(folder,'raw-result.json'));
  if(result.requestId!==id||result.requestDigest!==digest)throw Error(candidate+' decoded result mismatch');
  if(result.source?.archiveSha256&&result.source.archiveSha256!==source)throw Error(candidate+' decoded source mismatch');
  const output=path.join(folder,'readable-extraction-v2');
  fs.mkdirSync(output,{recursive:true});
  const index={schemaVersion:'curveyield-candidate-evidence-extraction-v2',candidateId:candidate,sourceSha256:source,requestId:id,requestDigest:digest,parentOriginalSha256:envelope.originalSha256,parentCompressedSha256:envelope.compressedSha256,extractionMethod:'readV7RawResultV1 authenticated gzip; lossless exact selected JSON-pointer subtrees',topLevelKeys:Object.keys(result),observedKeys:[],extracted:[],unselected:[],maxTotalBytes:4500000};
  let total=0,count=0;
  const data={};
  const observed=new Set();
  function keep(pointer,val){
    const raw=JSON.stringify(val);
    if(raw===undefined)return;
    const bytes=Buffer.byteLength(raw,'utf8');
    if(bytes>1600000||total+bytes>4500000||count>=100){index.unselected.push({pointer,bytes,reason:'OVERSIZED_OR_BUDGET'});return;}
    const key='selected-'+String(++count).padStart(3,'0')+'.json';
    const bytesAll=Buffer.from(JSON.stringify({jsonPointer:pointer,exactValue:val})+'\n','utf8');
    fs.writeFileSync(path.join(output,key),bytesAll);
    index.extracted.push({path:key,jsonPointer:pointer,sha256:sha(bytesAll),bytes:bytesAll.length});
    total+=bytesAll.length;
  }
  function visit(obj,pointer,depth){
    if(depth>7||obj===null||typeof obj!=='object')return;
    const arr=Array.isArray(obj);
    const keys=Object.keys(obj);
    if(observed.size<140)observed.add(pointer+' : '+(arr?'array ':'object ')+keys.length+' : '+keys.slice(0,8).join(','));
    // Don't dive into compiler/source artifacts, even if ABI members are named 'errors'.
    if(skip.test(pointer))return;
    for(const key of keys){
      if(key==='build'||key==='source'||key==='sourceAsts'||key==='compilerOutput')continue;
      const child=obj[key],p=pointer+'/'+key.replaceAll('~','~0').replaceAll('/','~1');
      if(skip.test(p))continue;
      const isMatch=relevant.test(key);
      if(isMatch && (child===null||typeof child!=='object')){keep(p,child);continue;}
      if(isMatch&&child&&typeof child==='object'){
        const byteLen=Buffer.byteLength(JSON.stringify(child),'utf8');
        if(byteLen<700000){keep(p,child);continue;}
      }
      if(child&&typeof child==='object')visit(child,p,depth+1);
    }
  }
  visit(result,'',0);
  index.observedKeys=[...observed];
  index.records=index.extracted.length;index.extractedBytes=total;
  index.note='Only listed JSON pointers extracted. All unrelated data remain in original digest-checked compressed evidence. Completion of a component is not candidate proof.';
  fs.writeFileSync(path.join(output,'INDEX_v2.json'),JSON.stringify(index,null,2)+'\n');
  console.log(JSON.stringify({candidate,topLevelKeys:index.topLevelKeys,observed:index.observedKeys.slice(0,40),files:index.records,bytes:total,unselected:index.unselected.length}));
}
