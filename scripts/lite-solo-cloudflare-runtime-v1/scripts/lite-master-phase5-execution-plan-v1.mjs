#!/usr/bin/env node
// Install the Phase-5 toolchain only if exact accepted machine evidence cannot
// be reused for the source-anchored, unchanged candidate and test design.
import fs from 'node:fs';
import path from 'node:path';
import {selectReusablePhase5TargetsV1,verifiedReusablePhase5ResultV1} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
const [root,campaignPath,campaignId,sourceSha256]=process.argv.slice(2);
if(!root||!campaignPath||!campaignId||!sourceSha256)throw new Error('phase5 execution plan requires controller root, campaign path/id and source hash');
const read=(rel)=>JSON.parse(fs.readFileSync(path.join(root,campaignPath,rel),'utf8'));
const canonical4=read('derived/phase-4/PHASE_04_CANONICAL_DATA_v1.json');
const canonical5=read('derived/phase-5/PHASE_05_CANONICAL_DATA_v1.json');
const current4=read('work/phase-04/PHASE_04_WORK_FORM_v1.json');
const current5=read('work/phase-05/PHASE_05_WORK_FORM_v1.json');
const output=(record,step)=>record?.actions?.[step]?.outputs??{};
const targetDesigns=output(current5,'step-3').targetDesigns??[];
const reusable=new Set(selectReusablePhase5TargetsV1({
  priorTargetDesigns:output(canonical5,'step-3').targetDesigns??[],targetDesigns,
  priorCandidateRecords:[...(output(canonical4,'step-3').candidateRecords??[]),...(output(canonical5,'step-2').newCandidateRecords??[])],
  candidateRecords:[...(output(current4,'step-3').candidateRecords??[]),...(output(current5,'step-2').newCandidateRecords??[])]
}));
const unverified=[];
for(const target of targetDesigns){
  if(target?.executionMethod!=='V7_REQUEST')continue;
  const key=String(target.candidateKey??'').trim();
  if(!key||!reusable.has(key)||!verifiedReusablePhase5ResultV1({
    controllerRoot:root,campaignPath,target,expectedCampaignId:campaignId,expectedSourceSha256:sourceSha256
  }))unverified.push(key||'MISSING_CANDIDATE_KEY');
}
process.stdout.write(JSON.stringify({requiresExecution:unverified.length>0,reuseCount:reusable.size,unverified})+'\n');
