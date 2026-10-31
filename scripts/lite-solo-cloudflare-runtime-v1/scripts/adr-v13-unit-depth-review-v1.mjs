#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const DEPTH_SPOTCHECK_V1='work/master-review/DEPTH_SPOTCHECK_RESULTS_v1.json';

function getGitCommitWindowV1(root,rel){
 try{
  const log=execFileSync('git',['-C',root,'log','-1','--format=%ct:%H','--',rel],
   {encoding:'utf8',timeout:30000}).trim().split('\n')[0];
  const match=/^([0-9]{8,}):([0-9a-f]{40})$/.exec(log);
  return match?{epoch:Number(match[1]),commit:match[2]}:null;
 }catch{return null;}
}
export function reviewUnitCommitIntervalsV1({root,campaignPath,minimumSeconds=90,clock=getGitCommitWindowV1}={}){
 if(!root||!campaignPath?.startsWith('campaigns/'))throw Error('canonical campaign root required');
 const folder=path.join(root,...campaignPath.split('/'),'work/phase-04/discovery');
 if(!fs.existsSync(folder))throw Error('discovery unit directory missing');
 const units=[];
 for(const ent of fs.readdirSync(folder,{withFileTypes:true}).filter(x=>x.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){
  const prefix=path.posix.join(campaignPath,'work/phase-04/discovery',ent.name);
  const packet=path.posix.join(prefix,'ASSIGNMENT_PACKET_v1.json');
  const accepted=path.posix.join(prefix,'ACCEPTED_SUBMISSION_v1.json');
  if(!fs.existsSync(path.join(root,...accepted.split('/'))))continue;
  const opened=clock(root,packet),submitted=clock(root,accepted);
  const elapsed=opened&&submitted?submitted.epoch-opened.epoch:null;
  units.push({unitId:ent.name,packetCommit:opened?.commit??null,submissionCommit:submitted?.commit??null,
    elapsedSeconds:elapsed,
    status:elapsed===null||elapsed<0?'PROVENANCE_MISSING_OR_INVALID':
      elapsed<minimumSeconds?'DEPTH_SPOTCHECK_REQUIRED':'DURATION_RECORDED',
    reviewDecision:'PENDING_INDEPENDENT_MASTER'});
 }
 return {schemaVersion:'curveyield-v13-depth-spotcheck-v1',campaignPath,
  timerSource:'INDIVIDUAL_GIT_COMMIT_TIMESTAMPS_NOT_DISCOVERY_WINDOW',
  minimumSeconds,unitCount:units.length,units,
  masterReviewRequired:units.some(x=>x.status!=='DURATION_RECORDED'),
  qualification:'UNQUALIFIED'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const [root,campaign]=process.argv.slice(2);
 const report=reviewUnitCommitIntervalsV1({root:path.resolve(root),campaignPath:campaign});
 const dest=path.join(root,...campaign.split('/'),...DEPTH_SPOTCHECK_V1.split('/'));
 fs.mkdirSync(path.dirname(dest),{recursive:true});
 fs.writeFileSync(dest,JSON.stringify(report,null,2)+'\n');
 process.stdout.write(JSON.stringify({path:path.posix.join(campaign,DEPTH_SPOTCHECK_V1),
  units:report.unitCount,spotchecks:report.units.filter(x=>x.status!=='DURATION_RECORDED').length})+'\n');
}
