import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {processUnitRequestV1} from '../../../lib/lite-solo-unit-queue-v1.mjs';
import {get,put,git} from './context.mjs';

const [root,campaign,directoryPath,barrierDir,workerId]=process.argv.slice(2);
const requestId='A02-claim-'+workerId+'-1';
const dirname=path.basename(campaign);
const directory0=get(root,directoryPath);
const request={
 schemaVersion:'curveyield-lite-solo-unit-batch-request-v1',requestId,operation:'CLAIM',
 workerId,lane:'AUTO',campaignId:directory0.campaignId,
 campaignGenerationId:directory0.campaignGenerationId,phaseSequence:4,
 sourceSha256:directory0.sourceSha256,authorityDigest:directory0.authorityDigest,
 phaseEpoch:1,auditControllerRef:'main',desiredUnitCount:10
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let attempts=0,conflicts=0,result=null;
function attempt(){
 const directory=get(root,directoryPath);
 const r=processUnitRequestV1({root,campaignPath:campaign,directory,request});
 put(root,directoryPath,directory);
 git(root,'add','-A');
 git(root,'-c','user.name=Lite Acceptance','-c','user.email=accept@example.test',
  'commit','-m','acceptance A02 '+workerId+' attempt '+attempts);
 return r;
}
try{
 attempts++;
 result=attempt();
 fs.writeFileSync(path.join(barrierDir,'ready-'+workerId),JSON.stringify(result.claimedUnits.map(x=>x.unitId)));
 const deadline=Date.now()+40000;
 while(!fs.existsSync(path.join(barrierDir,'go'))){
  if(Date.now()>deadline)throw Error('barrier timeout');
  await sleep(30);
 }
 for(let i=0;i<16;i++){
  try{
   git(root,'push','origin','HEAD:main');break;
  }catch(e){
   conflicts++;
   git(root,'fetch','origin','main');
   git(root,'reset','--hard','origin/main');
   attempts++;
   result=attempt();
   if(i===15)throw Error('CAS retry exhaustion');
  }
 }
 fs.writeFileSync(path.join(barrierDir,'result-'+workerId+'.json'),JSON.stringify({
  workerId,requestId,attempts,conflicts,claimedUnits:result.claimedUnits.map(x=>x.unitId)}));
}catch(e){
 fs.writeFileSync(path.join(barrierDir,'error-'+workerId+'.txt'),String(e.stack??e));
 process.exitCode=1;
}
