// Lossless, source-bound V7 evidence packaging for GitHub's 100 MB blob limit.
// The envelope is never accepted as PASS without authenticating and inflating every part.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';

const SCHEMA='curveyield-v7-compressed-raw-result-v1';
const PART_BYTES=32*1024*1024;
const COMPACT_AT_BYTES=8*1024*1024;
const MAX_FULL_BYTES=1024*1024*1024;
const MAX_PARTS=64;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export function writeV7RawResultV1({evidenceRoot,result,compact=false}={}){
  if(!evidenceRoot||!result||typeof result!=='object')throw new Error('V7 raw result and evidenceRoot are required');
  const raw=Buffer.from(JSON.stringify(result,null,2)+'\n','utf8');
  const rawDigest=sha256(raw);
  const location=path.join(evidenceRoot,'raw-result.json');
  if(!compact||raw.length<COMPACT_AT_BYTES){
    fs.writeFileSync(location,raw);
    return {compact:false,artifactDigest:rawDigest,rawBytes:raw.length,rawRef:'raw-result.json'};
  }
  if(raw.length>MAX_FULL_BYTES)throw new Error('V7 raw result exceeds the safe 1 GiB evidence packaging limit');
  const compressed=gzipSync(raw,{level:6});
  const pieces=[];
  for(let offset=0;offset<compressed.length;offset+=PART_BYTES){
    const bytes=compressed.subarray(offset,Math.min(offset+PART_BYTES,compressed.length));
    const file='raw-result-full-v1.json.gz.part-'+String(pieces.length+1).padStart(3,'0');
    fs.writeFileSync(path.join(evidenceRoot,file),bytes);
    pieces.push({file,bytes:bytes.length,sha256:sha256(bytes)});
  }
  if(!pieces.length||pieces.length>MAX_PARTS)throw new Error('V7 compressed evidence has invalid part count');
  const envelope={
    schemaVersion:SCHEMA,encoding:'gzip',originalBytes:raw.length,
    originalSha256:rawDigest,compressedBytes:compressed.length,
    compressedSha256:sha256(compressed),parts:pieces,
    requestId:result.requestId??null,requestDigest:result.requestDigest??null,
    status:result.status??null,blocking:result.blocking??null
  };
  fs.writeFileSync(location,JSON.stringify(envelope,null,2)+'\n');
  return {compact:true,artifactDigest:rawDigest,rawBytes:raw.length,
    compressedBytes:compressed.length,partCount:pieces.length,rawRef:'raw-result.json'};
}

export function readV7RawResultV1(rawPath){
  const envelope=JSON.parse(fs.readFileSync(rawPath,'utf8'));
  if(envelope?.schemaVersion!==SCHEMA)return envelope;
  if(envelope.encoding!=='gzip'||!Array.isArray(envelope.parts)||
     envelope.parts.length<1||envelope.parts.length>MAX_PARTS||
     !Number.isSafeInteger(envelope.originalBytes)||envelope.originalBytes<1||
     envelope.originalBytes>MAX_FULL_BYTES)throw new Error('Invalid V7 compressed raw evidence envelope');
  const chunks=[];
  for(const [i,part] of envelope.parts.entries()){
    const required='raw-result-full-v1.json.gz.part-'+String(i+1).padStart(3,'0');
    if(part?.file!==required||!Number.isSafeInteger(part.bytes)||part.bytes<1||
       part.bytes>PART_BYTES||!(/^[a-f0-9]{64}$/).test(part.sha256))
      throw new Error('Invalid V7 evidence part descriptor '+i);
    const bytes=fs.readFileSync(path.join(path.dirname(rawPath),required));
    if(bytes.length!==part.bytes||sha256(bytes)!==part.sha256)
      throw new Error('V7 compressed evidence part failed integrity check: '+required);
    chunks.push(bytes);
  }
  const compressed=Buffer.concat(chunks);
  if(compressed.length!==envelope.compressedBytes||sha256(compressed)!==envelope.compressedSha256)
    throw new Error('V7 compressed evidence digest mismatch');
  const raw=gunzipSync(compressed,{maxOutputLength:MAX_FULL_BYTES});
  if(raw.length!==envelope.originalBytes||sha256(raw)!==envelope.originalSha256)
    throw new Error('V7 full raw evidence digest mismatch');
  const result=JSON.parse(raw.toString('utf8'));
  if(result?.requestId!==envelope.requestId||
     result?.requestDigest!==envelope.requestDigest||
     result?.status!==envelope.status||
     result?.blocking!==envelope.blocking)
    throw new Error('V7 evidence envelope does not match its decoded result');
  return result;
}
