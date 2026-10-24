#!/usr/bin/env node
import fs from 'node:fs';
const allowed=/^https:\/\/chatgpt\.com\/(?:c\/[A-Za-z0-9_-]+|g\/g-p-[A-Za-z0-9_-]+\/c\/[A-Za-z0-9_-]+)\/?$/;
const idOf=x=>String(x??'').trim();

export function planBackupChatFailoverV1({registration,directory,failedChatUrl,now}={}){
 const fail=(reason)=>({status:'NOT_ELIGIBLE',reason});
 if(!registration||!directory||directory.campaignId!==registration.campaignId)
  return fail('campaign binding mismatch');
 const assignment=directory.currentAssignment;
 const delegatedRole=registration.activeChat?.name;
 const privileged=['master-reviewer','test-executor'].includes(delegatedRole);
 if(!assignment||!['ACTIVE','WAITING_FOR_SUCCESSOR_AGENT','WAITING_FOR_MASTER_REVIEW'].includes(directory.campaignStatus)||
    (!privileged&&!['ACTIVE','WAITING_FOR_SUCCESSOR_AGENT','REWORK_REQUIRED'].includes(assignment.status)))
  return fail('no active reviewer assignment');
 const role=privileged?delegatedRole:assignment.reviewer;
 if(!/^(?:reviewer-[1-4](?:L)?|master-reviewer|test-executor)$/.test(String(role??'')))return fail('invalid reviewer role');
 const current=registration.agentChats?.[role];
 if(!allowed.test(idOf(current))||current!==failedChatUrl)
  return fail('failed chat no longer bound to current reviewer role');
 const backup=registration.backupChatUrl??registration.agentChats?.['backup']??null;
 if(!allowed.test(idOf(backup)))return fail('no registered valid standby chat');
 if(backup===failedChatUrl)return fail('standby cannot equal failed chat');
 if(Object.entries(registration.agentChats??{}).some(([key,url])=>key!==role&&key!=='backup'&&url===backup))
  return fail('standby already owned by another active role');
 if(registration.backupFailover?.status==='USED')return fail('standby already consumed');
 const index=assignment.workShardIndexPath;
 const isRework=assignment.status==='REWORK_REQUIRED';
 const nextWork=isRework
   ?('Current assignment is REWORK_REQUIRED. FIRST read the latest exact controller failure packet '+
     assignment.packetPath+' and the latest controller result, then identify which deficiencies belong to reviewer data and which are runner/machine-execution defects. Preserve already completed indexed shards and the last sealed receipt. Compare the failed runner commit and time to current main before calling a repaired defect still open. Resume every presently executable non-test repair; do not re-submit a machine-executing boundary or create, modify, or run any test without explicit audit-owner authorization. Record the precise remaining blocker.')
   :index?('Read shard INDEX '+index+
     ' and BASE_v1.json. Complete every indexed shard in order and submit ONE phase boundary request after the final shard, without waiting for controller between shards.')
   :('Use the exact assigned work form at '+assignment.workFormPath+' and submit its existing boundary request only after all work is complete.');
 const message=['CONTROLLER_BACKUP_CHAT_HANDOFF: the prior reviewer chat made no verified durable progress after the watchdog recovery threshold.',
  'Campaign '+directory.campaignId+', role '+role+', current phase '+assignment.phaseSequence+'.',
  'Read the bound authority from the Phase-0 receipt; preserve frozen authority and sealed earlier phases.',
  nextWork,
  role==='test-executor'
    ?'Execute only the authorized targeted-test plan, preserve raw evidence and submit results. Never change reviewer findings.'
    :role==='master-reviewer'
      ?'Perform the pending whole-segment master review. Never execute tests or duplicate earlier bookkeeping.'
      :'Do not author tests as the test executor; continue only this reviewer role. Do not repeat earlier bookkeeping.'].join('\n');
 const updated=structuredClone(registration);
 updated.retiredChats={...(registration.retiredChats??{}),[role]:failedChatUrl};
 updated.agentChats={...registration.agentChats,[role]:backup};
 if(updated.agentChats.backup===backup)delete updated.agentChats.backup;
 updated.activeChat={...(updated.activeChat??{}),name:role,url:backup};
 updated.activeAssignment={...(updated.activeAssignment??{}),phaseId:'phase-'+assignment.phaseSequence,
  milestoneId:'PHASE_'+assignment.phaseSequence+'_WORK_PACKET',reviewer:role,workerRole:role==='test-executor'?'test-executor':role==='master-reviewer'?'master-reviewer':'reviewer'};
 updated.backupFailover={status:'USED',role,failedChatUrl,backupChatUrl:backup,
  assignedPhaseSequence:assignment.phaseSequence,usedAt:now};
 updated.updatedAt=now;
 return {status:'ELIGIBLE',role,backupChatUrl:backup,message,registration:updated};
}

if(process.argv[1]?.endsWith('/browser-backup-failover-v1.mjs')){
 const [registrationPath,directoryPath,failedChatUrl]=process.argv.slice(2);
 if(!registrationPath||!directoryPath||!failedChatUrl)throw Error('Usage: browser-backup-failover-v1.mjs REGISTRATION_JSON DIRECTORY_JSON FAILED_CHAT_URL');
 const planned=planBackupChatFailoverV1({
  registration:JSON.parse(fs.readFileSync(registrationPath,'utf8')),
  directory:JSON.parse(fs.readFileSync(directoryPath,'utf8')),failedChatUrl,
  now:new Date().toISOString()
 });
 process.stdout.write(JSON.stringify(planned)+'\n');
}
