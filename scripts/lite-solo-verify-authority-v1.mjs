import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2];
if(!root||!fs.statSync(root,{throwIfNoEntry:false})?.isDirectory())throw Error('authority root missing');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'MANIFEST.json'),'utf8'));
if(![['lite-solo-v1','v1'],['lite-solo-v2','v2'],['lite-solo-v3','v3'],['lite-solo-v4','v4'],['lite-solo-v5','v5'],['lite-solo-v6','v6']].some(([release,rev])=>manifest.release===release&&manifest.packageRevision===rev)||manifest.mode!=='LITE_SOLO')throw Error('unexpected authority release');
if(manifest.masterReviewPolicy||manifest.reviewerLineup?.masterSegments?.length)throw Error('master review remains bound');
const seen=new Set();
for(const entry of manifest.files){
 if(!entry.path||entry.path.startsWith('/')||entry.path.split('/').some(p=>p==='..'||p==='.'))throw Error('unsafe manifest entry');
 if(seen.has(entry.path))throw Error('duplicate manifest entry');
 seen.add(entry.path);
 const content=fs.readFileSync(path.join(root,entry.path));
 if(content.length!==entry.bytes||createHash('sha256').update(content).digest('hex')!==entry.sha256)
  throw Error('authority content hash mismatch: '+entry.path);
}
if(manifest.files.length<145||!seen.has('SKILL.md')||!seen.has('phases/phase-10/PHASE_CONTRACT.json'))throw Error('fork manifest incomplete');
console.log('PASS: '+manifest.files.length+' exact SHA256 authority blobs match manifest');
