import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// The controller's stdout is a small, synchronous envelope. Full diagnostics
// are retained losslessly in bounded private campaign files and never truncated.
const PAGE_BYTES=32*1024;
const ENVELOPE_BYTES=8*1024;
const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
export function storeControllerResultV1({root,campaignPath,response}){
  if(!response||typeof response!=='object'||typeof response.status!=='string'||!response.status)
    throw new Error('controller result requires status');
  const bytes=Buffer.from(JSON.stringify(response)+'\n');
  const sha256=digest(bytes);
  const dir=path.join(root,...campaignPath.split('/'),'controller','results',sha256.slice(0,20));
  fs.mkdirSync(dir,{recursive:true});
  const pages=[];
  for(let i=0,offset=0;offset<bytes.length;i++,offset+=PAGE_BYTES){
    const chunk=bytes.subarray(offset,Math.min(offset+PAGE_BYTES,bytes.length));
    const file='page-'+String(i+1).padStart(4,'0')+'_v1.bin';
    fs.writeFileSync(path.join(dir,file),chunk);
    pages.push({file,bytes:chunk.length,sha256:digest(chunk)});
  }
  const resultDir=path.posix.join('controller/results',sha256.slice(0,20));
  const manifest={schemaVersion:'curveyield-lite-controller-result-pages-v1',
    status:response.status,campaignId:response.campaignId??null,
    resultSha256:sha256,resultBytes:bytes.length,pages};
  fs.writeFileSync(path.join(dir,'INDEX_v1.json'),JSON.stringify(manifest,null,2)+'\n');
  const envelope={schemaVersion:'curveyield-lite-controller-envelope-v1',
    status:response.status,campaignId:response.campaignId??null,
    counts:{resultBytes:bytes.length,pageCount:pages.length},
    detailRef:path.posix.join(resultDir,'INDEX_v1.json'),sha256};
  if(Buffer.byteLength(JSON.stringify(envelope)+'\n')>ENVELOPE_BYTES)
    throw new Error('controller envelope exceeds 8 KiB');
  return envelope;
}

export function restoreControllerResultV1({root,campaignPath,envelope}){
  if(envelope?.schemaVersion!=='curveyield-lite-controller-envelope-v1')
    throw new Error('unrecognized controller envelope');
  const prefix=path.posix.join('controller/results');
  if(typeof envelope.detailRef!=='string'||!envelope.detailRef.startsWith(prefix+'/')||
    envelope.detailRef.split('/').some(x=>x==='..'))
    throw new Error('unsafe result detail reference');
  const indexPath=path.join(root,...campaignPath.split('/'),...envelope.detailRef.split('/'));
  const index=JSON.parse(fs.readFileSync(indexPath,'utf8'));
  if(!Array.isArray(index.pages)||index.pages.length!==envelope.counts.pageCount)
    throw new Error('controller result page count mismatch');
  const parts=index.pages.map(p=>{
    if(!/^page-[0-9]{4}_v1\.bin$/.test(p.file)||p.bytes>PAGE_BYTES||p.bytes<1)
      throw new Error('invalid page descriptor');
    const b=fs.readFileSync(path.join(path.dirname(indexPath),p.file));
    if(b.length!==p.bytes||digest(b)!==p.sha256)throw new Error('page integrity failure');
    return b;
  });
  const bytes=Buffer.concat(parts);
  if(bytes.length!==index.resultBytes||digest(bytes)!==index.resultSha256||
    index.resultSha256!==envelope.sha256)throw new Error('controller result digest mismatch');
  const response=JSON.parse(bytes.toString('utf8'));
  if(response.status!==envelope.status||(response.campaignId??null)!==(envelope.campaignId??null))
    throw new Error('controller result identity mismatch');
  return response;
}
