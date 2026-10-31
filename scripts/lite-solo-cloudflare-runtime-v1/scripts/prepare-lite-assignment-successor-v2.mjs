#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {repoFile,requiredFile,readJson,validateBoundAuthorityV1} from './lib/lite-phase-work-v1.mjs';
import {authorityLinkPathV1} from '../packages/github-native-sim/src/adr-frozen-authority-v1.mjs';

function parse(argv){const o={};for(let i=2;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined) throw new Error('args must be --key value');o[argv[i].slice(2)]=argv[i+1];}return o;}
const a=parse(process.argv);
for(const k of ['controller-root','campaign-directory-path','audit-controller-ref']) if(!a[k]) throw new Error('missing --'+k);
const root=path.resolve(a['controller-root']);
const directory=readJson(requiredFile(root,a['campaign-directory-path'],'campaign directory entry'));
if(directory.schemaVersion!=='curveyield-audit-campaign-directory-entry-v2') throw new Error('assignment successor requires Audit Campaign Directory v2');
if(directory.campaignStatus!=='WAITING_FOR_SUCCESSOR_AGENT') throw new Error('campaign is not waiting for successor');
const assignment=directory.currentAssignment;
if(!assignment||assignment.status!=='WAITING_FOR_SUCCESSOR_AGENT') throw new Error('current assignment is not waiting for successor');
requiredFile(root,assignment.workSchemaPath,'incoming phase schema');
if(assignment.workShardIndexPath) requiredFile(root,assignment.workShardIndexPath,'incoming phase shard index');
else requiredFile(root,assignment.workFormPath,'incoming phase work form');
if(assignment.finalReportPath){
  const expectedPrefix=directory.workspacePath.replace(/\/+$/,'')+'/work/phase-'+String(assignment.phaseSequence).padStart(2,'0')+'/';
  if(!assignment.finalReportPath.startsWith(expectedPrefix)) throw new Error('incoming phase final report path is outside the assigned phase work directory');
  if(fs.existsSync(repoFile(root,assignment.finalReportPath))) throw new Error('incoming phase final report must not exist before reviewer semantic work; controller owns report generation at validation time');
}
const predecessor=readJson(requiredFile(root,assignment.predecessorReceiptPath,'sealed predecessor receipt'));
const effectiveAuthorityRoot=validateBoundAuthorityV1({root,receipt:predecessor});
if(!['SEALED','SKIPPED'].includes(predecessor.phase?.status)) throw new Error('predecessor receipt is not sealed/skipped');
const controllerRef=a['audit-controller-ref'];
const encodeRepoPath=p=>String(p).split('/').map(encodeURIComponent).join('/');
const controllerTreeUrl=p=>'https://github.com/curveyield3/Audit-Controller/tree/'+encodeURIComponent(controllerRef)+'/'+encodeRepoPath(p);
const controllerBlobUrl=p=>'https://github.com/curveyield3/Audit-Controller/blob/'+encodeURIComponent(controllerRef)+'/'+encodeRepoPath(p);
const logicalAuthorityHome=predecessor.authority?.homepagePath??assignment.workSchemaPath.replace(/\/phases\/phase-[^/]+\/[^/]+$/,'/SKILL.md');
const authorityLinkPath=p=>authorityLinkPathV1(root,p);
const linkedAuthorityHome=authorityLinkPath(path.posix.join(effectiveAuthorityRoot,'SKILL.md'));
if(predecessor.authority?.homepagePath)requiredFile(root,logicalAuthorityHome,'bound successor authority homepage');
const campaignUrl=controllerTreeUrl(directory.workspacePath);
const authorityUrl=controllerBlobUrl(linkedAuthorityHome);
const lines=[
  'LITE audit: '+directory.campaignName,
  'Reviewer: '+assignment.reviewer,
  'Current phase: '+assignment.phaseId,
  'Campaign: '+campaignUrl,
  'Current Audit Skill Authority: '+authorityUrl,
  '',
  'LIVE REPOSITORY ROUTING: For this campaign use ONLY curveyield3/Audit-Controller for campaign/skill/source records and curveyield3/Contract-Automation for boundary requests and GitHub Actions. Any legacy-organization repository names or URLs embedded in the frozen authority are historical/stale; resolve the same relative paths against curveyield3. Never edit the frozen bound authority to correct those historical links.',
  'Do not create, modify, or execute tests without explicit audit-owner authorization; preserve all completed evidence and use existing mechanisms.',
  '',
  'The Audit Skill Authority above is the ultimate authority for this audit. Follow every instruction it gives, in order, precisely, with no deviation. Use the GitHub connector app exactly as required by that authority.',
  '',
  'Start '+assignment.phaseId+' now. Use the sealed predecessor evidence and controller-derived inputs already present in the campaign. Do not redo sealed earlier phases.',
  ...(assignment.workShardIndexPath?[
  'Sharded work assignment. Start with the INDEX only: '+controllerBlobUrl(assignment.workShardIndexPath),
  'Read BASE_v1.json and every shard listed in the index. Edit each shard and save it separately, in index order. Complete every shard without waiting for a controller response; submit exactly ONE phase boundary request after the final shard. The controller reconstructs the canonical form and validates every record and digest. Do not edit the generated full form directly.'
]:[]),
  'Submit the boundary validation request using schema curveyield-lite-phase-boundary-request-v1 under process/agent-upload/lite-phase-boundary/ for the exact campaign and phase; do not bookkeep receipts yourself.'
];
const wakeMessage=lines.join('\n');
process.stdout.write(JSON.stringify({status:'PASS',campaignId:directory.campaignId,campaignName:directory.campaignName,directoryPath:a['campaign-directory-path'],incomingPhaseId:assignment.phaseId,incomingPhaseSequence:assignment.phaseSequence,incomingReviewer:assignment.reviewer,wakeMessage,wakeMessageB64:Buffer.from(wakeMessage).toString('base64')})+'\n');
