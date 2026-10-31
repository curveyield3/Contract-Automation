#!/usr/bin/env node
// Private scorer-side projection of actual campaign submissions, not reviewer
// supplied truth IDs. It never reads any seeded answer-key manifest.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const arr=x=>Array.isArray(x)?x:[];
const safe=x=>typeof x==='string'&&x.length>0;
export function extractCampaignFindingsV13({controllerRoot,campaignPath}={}){
 if(!path.isAbsolute(controllerRoot??'')||!/^campaigns\/[^/]+$/.test(campaignPath??''))
  throw Error('exact controller checkout and campaign path required');
 const cdir=path.join(controllerRoot,...campaignPath.split('/'));
 const dir=path.join(cdir,'work/phase-04/discovery');
 const inventoryFile=['evidence/review-inventory/scope-corrected/REVIEW_INVENTORY_v1.json',
  'evidence/review-inventory/REVIEW_INVENTORY_v1.json'].map(x=>path.join(cdir,...x.split('/')))
  .find(fs.existsSync);
 if(!inventoryFile||!fs.existsSync(dir))throw Error('campaign inventory/discovery submissions absent');
 const inventory=JSON.parse(fs.readFileSync(inventoryFile,'utf8')),contexts=inventory.payload?.contexts??[];
 const findings=[],seen=new Set();
 function add(c,contextIds,unitId,origin){
  const anchors=arr(c?.anchors).length?c.anchors:safe(c?.sourceAnchor)?[c.sourceAnchor]:[];
  const ctx=contexts.find(x=>contextIds.includes(x.contextId));
  const classId=c?.classId;
  if(!anchors.length||!safe(classId)||!ctx)return;
  const basis={unitId,origin,anchors,classId,contract:ctx.qualifiedContainer,
   description:c?.description??c?.title??''};
  const id='QUAL-F-'+createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0,20);
  if(seen.has(id))return;seen.add(id);
  findings.push({findingId:id,classId,contract:ctx.qualifiedContainer,anchors,
   severity:c.severity??c.recommendedSeverity??'MEDIUM',caseRefs:[]});
 }
 for(const entry of fs.readdirSync(dir,{withFileTypes:true}).filter(x=>x.isDirectory())){
  const filename=path.join(dir,entry.name,'ACCEPTED_SUBMISSION_v1.json');
  if(!fs.existsSync(filename))continue;
  const submission=JSON.parse(fs.readFileSync(filename,'utf8'));
  for(const c of arr(submission.candidates)){
   const linked=arr(submission.rows).filter(row=>[row.candidateTempKey,row.candidateId].some(
     key=>key&&[c.tempKey,c.candidateId,c.id].includes(key))).map(row=>row.contextId);
   add(c,[...new Set([...arr(c.contextIds),...linked])],entry.name,'top');
  }
  for(const row of arr(submission.rows)){
   for(const c of arr(row.candidates))add(c,[row.contextId],entry.name,'row');
   if(row.candidate)add(row.candidate,[row.contextId],entry.name,'inline');
   for(const check of arr(row.checks))if(check.candidate)
    add({...check.candidate,classId:check.candidate.classId??check.classId},[row.contextId],entry.name,'class');
  }
  for(const attack of arr(submission.attackPaths))if(attack.candidate)
   add({...attack.candidate,classId:attack.candidate.classId??attack.classId},
    arr(attack.contextIds),entry.name,'attack');
 }
 return {campaignId:inventory.campaignId,sourceSha256:inventory.sourceSha256,
  findings:findings.sort((a,b)=>a.findingId.localeCompare(b.findingId))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const [controllerRoot,campaignPath,outFile]=process.argv.slice(2);
 if(!outFile||!path.isAbsolute(outFile))throw Error('absolute private output required');
 const extracted=extractCampaignFindingsV13({controllerRoot,campaignPath});
 fs.writeFileSync(outFile,JSON.stringify(extracted.findings,null,2)+'\n',{mode:0o600});
 process.stdout.write('QUALIFICATION_SOURCE_FINDINGS_READY total='+extracted.findings.length+'\n');
}
