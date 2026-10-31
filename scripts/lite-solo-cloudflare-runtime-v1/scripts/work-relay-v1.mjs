#!/usr/bin/env node
// Work relay control plane. Only the AGENT_DELIVERY delivery lane uses this file.
// It does not interact with ChatGPT, execute audit phases, or certify a phase PASS.
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';

const CONTROLLER='curveyield3/Audit-Controller';
const AUTOMATION='curveyield3/Contract-Automation';
const WORK='AGENT_DELIVERY';
const BROWSER='GITHUB_BROWSER';
const ctlToken=process.env.AUDIT_CONTROLLER_GITHUB_TOKEN || process.env.AUDIT_CONTROLLER_TOKEN;
const autoToken=process.env.CONTRACT_AUTOMATION_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if(!ctlToken || !autoToken) throw Error('Both Audit-Controller and Contract-Automation credentials are required');
const args={};
for(let i=2;i<process.argv.length;i+=2){
  if(!process.argv[i].startsWith('--')||process.argv[i+1]===undefined) throw Error('expected --key value');
  args[process.argv[i].slice(2)]=process.argv[i+1];
}
const op=args.operation || 'deliver';
const now=()=>new Date().toISOString();
const pathUrl=s=>s.split('/').map(encodeURIComponent).join('/');
function github(repo,token,parts){
  const out=execFileSync('gh',['api',...parts],{encoding:'utf8',env:{...process.env,GH_TOKEN:token},maxBuffer:10*1024*1024,stdio:['ignore','pipe','pipe']});
  return out?JSON.parse(out):{};
}
function fetch(repo,path,token,allow404=false){
  try{
    const obj=github(repo,token,['repos/'+repo+'/contents/'+pathUrl(path)+'?ref=main']);
    return {sha:obj.sha,content:Buffer.from(obj.content.replace(/\s/g,''),'base64').toString('utf8')};
  }catch(err){
    if(allow404 && /404|Not Found/.test(String(err.stderr||err.message))) return null;
    throw Error('GitHub read failed '+repo+'/'+path+': '+String(err.stderr||err.message).slice(0,350));
  }
}
function put(repo,path,token,content,sha,message){
  const parts=['--method','PUT','repos/'+repo+'/contents/'+pathUrl(path),
    '-f','message='+message,'-f','content='+Buffer.from(content).toString('base64'),'-f','branch=main'];
  if(sha) parts.push('-f','sha='+sha);
  return github(repo,token,parts);
}
function remove(repo,path,token,sha,message){
  return github(repo,token,['--method','DELETE','repos/'+repo+'/contents/'+pathUrl(path),
    '-f','message='+message,'-f','sha='+sha,'-f','branch=main']);
}
function mutate(repo,path,token,fn,allowCreate=false){
  for(let attempt=0;attempt<7;attempt++){
    const old=fetch(repo,path,token,allowCreate);
    const next=fn(old?old.content:null);
    if(next===null || (old && old.content===next)) return old;
    try{return put(repo,path,token,next,old?.sha,'chore(work-relay): update '+path.split('/').pop());}
    catch(e){if(attempt===6 || !/409|422|conflict|sha|already exists/i.test(String(e)))throw e;}
  }
  throw Error('CAS retries exhausted for '+path);
}
const safe=s=>s.replace(/[^A-Za-z0-9._-]/g,'_');
function registrationPath(campaign){return 'process/browser-agent-wake/registrations/'+safe(campaign)+'.json';}
function registration(campaign){
  const entry=fetch(AUTOMATION,registrationPath(campaign),autoToken);
  const data=JSON.parse(entry.content);
  if(data.campaignId!==campaign)throw Error('Wrong campaign registration');
  return {entry,data};
}
function directoryPath(campaign){
  const match=campaign.match(/^(.+)-r[0-9]+$/);
  if(!match)throw Error('Campaign ID requires -rN suffix');
  return 'Audit Campaign Directory/campaigns/'+match[1]+'.json';
}
function directory(campaign){
  const path=directoryPath(campaign),entry=fetch(CONTROLLER,path,ctlToken);
  const data=JSON.parse(entry.content);
  if(data.campaignId!==campaign || !/^campaigns\//.test(data.workspacePath))throw Error('Wrong campaign directory');
  return {entry,data,path};
}
function filePath(d){return d.workspacePath+'/work/browser/DELIVERY_COMMAND_v1.md';}
function emptyState(campaign,epoch){
  return {schemaVersion:'curveyield-work-delivery-command-v1',campaignId:campaign,
    deliveryTransport:WORK,transportEpoch:epoch,current:null,queue:[],
    lastPokedAt:null,lastProgressAt:null,lastProgressKey:null,
    noProgressPokes:0,transportTimeouts:0,updatedAt:now()};
}
function readState(content){
  if(!content)return null;
  const first=content.split('\n',1)[0];
  const marker='\n~~~json\n',start=content.lastIndexOf(marker);
  if(start<0)throw Error('Work relay file metadata missing');
  const end=content.indexOf('\n~~~',start+marker.length);
  if(end<0)throw Error('Work relay metadata terminator missing');
  const data=JSON.parse(content.slice(start+marker.length,end));
  if(data.schemaVersion!=='curveyield-work-delivery-command-v1')throw Error('Wrong Work relay schema');
  if(first!=='PENDING' && first!=='IDLE' && !(data.deliveryTransport===BROWSER && data.retiredAt)){
    const rest=content.slice(content.indexOf('\n'));
    const expected=view(data,'PENDING');
    if(rest!==expected.slice(expected.indexOf('\n')))
      throw Error('Receipt edit changed command body; only line one may be replaced');
  }
  return {first,data};
}
function view(state,first){
  const cur=state.current;
  let msg='No delivery command pending.';
  if(cur){
    const link='https://github.com/'+CONTROLLER+'/blob/main/'+pathUrl(filePath({workspacePath:cur.workspacePath}));
    msg='DO THIS FIRST NOW\n'+link+'\n'+cur.expectedCode+
      '\nEdit the linked file on main: replace its FIRST LINE with the exact code above, as the first text. Save without changing anything else.\n\n'+cur.message;
  }
  const actual=first||(cur?'PENDING':'IDLE');
  return actual+'\n\n## MESSAGE TO DELIVER\n\n'+msg+
    '\n\n## CONTROL — DO NOT EDIT\n~~~json\n'+JSON.stringify(state,null,2)+'\n~~~\n';
}
function settle(state,first){
  if(first==='IDLE' && !state.current)return false;
  if(!state.current)throw Error('Unexpected first line with no current command: '+first);
  if(first==='PENDING')return false;
  if(first!==state.current.expectedCode){
    const prior=(state.unconfirmedCommands||[]).find(x=>x.expectedCode===first);
    if(prior){
      state.lateReceipts=(state.lateReceipts||[]).slice(-9).concat([{
        commandId:prior.commandId,receivedAt:now(),disposition:'STALE_COMMAND_NOT_ACCEPTED'
      }]);
      state.updatedAt=now();
      return true;
    }
    state.invalidReceipts=(state.invalidReceipts||[]).slice(-9).concat([{
      attemptedCode:first.slice(0,100),receivedAt:now(),
      disposition:'INVALID_CODE_CURRENT_COMMAND_STILL_PENDING'
    }]);
    state.updatedAt=now();
    return true;
  }
  const old=state.current;
  state.lastReceipt={commandId:old.commandId,phaseId:old.phaseId,targetChatUrl:old.chatUrl,
    code:first,receivedAt:now(),transportEpoch:old.transportEpoch};
  state.current=state.queue.shift()||null;
  state.transportTimeouts=0;
  state.updatedAt=now();
  return true;
}
function assertMode(d,r,expected){
  if((d.deliveryTransport||BROWSER)!==expected || (r.deliveryTransport||BROWSER)!==expected)
    throw Error('Transport not '+expected+' in both canonical directory and registration');
  if(Number(d.transportEpoch||0)!==Number(r.transportEpoch||0))
    throw Error('Transport epoch mismatch between canonical directory and registration');
}
function assertChat(r,chat){
  if(!/^https:\/\/chatgpt\.com\/(c\/[A-Za-z0-9_-]+\/?|g\/g-p-[A-Za-z0-9_-]+\/c\/[A-Za-z0-9_-]+\/?)$/.test(chat))
    throw Error('Invalid ChatGPT chat URL');
  if(!Object.values(r.agentChats||{}).includes(chat))throw Error('Chat not bound to this campaign');
}
function enqueue(campaign,fields){
  const d=directory(campaign).data,r=registration(campaign).data;
  assertMode(d,r,WORK);assertChat(r,fields.chatUrl);
  const epoch=Number(d.transportEpoch||0);
  const path=filePath(d);
  const id=createHash('sha256').update([campaign,epoch,fields.wakeId,fields.chatUrl,fields.message].join('\0')).digest('hex').slice(0,26);
  let result='QUEUED';
  mutate(CONTROLLER,path,ctlToken,raw=>{
    const prior=readState(raw),s=prior?prior.data:emptyState(campaign,epoch);
    if(s.campaignId!==campaign || s.transportEpoch!==epoch)throw Error('Stale Work command epoch');
    let changed=prior?settle(s,prior.first):false;
    if(s.lastReceipt?.commandId===id || s.current?.commandId===id || s.queue.some(x=>x.commandId===id)){
      result='ALREADY_PRESENT';
      return changed?view(s):null;
    }
    const command={commandId:id,wakeId:fields.wakeId,phaseId:fields.phaseId,
      workerRole:fields.workerRole,chatUrl:fields.chatUrl,message:fields.message,
      workspacePath:d.workspacePath,transportEpoch:epoch,
      expectedCode:'COMPLETE-'+randomBytes(8).toString('hex').toUpperCase(),
      issuedAt:now()};
    if(!s.current)s.current=command;
    else {
      if(s.queue.length>=32)throw Error('Single-file Work queue full; retry without dropping message');
      s.queue.push(command);
    }
    s.updatedAt=now();return view(s);
  },true);
  // Keep the existing campaign registration current for a later optional switch
  // back to the untouched browser implementation.
  mutate(AUTOMATION,registrationPath(campaign),autoToken,raw=>{
    const data=JSON.parse(raw);
    if(data.campaignId!==campaign || data.deliveryTransport!==WORK || Number(data.transportEpoch||0)!==epoch)
      throw Error('Transport changed during Work handoff');
    const eligible=Object.entries(data.agentChats||{}).filter(([,url])=>url===fields.chatUrl).map(([role])=>role);
    const assigned=d.currentAssignment?.reviewer;
    const reviewer=eligible.includes(assigned)?assigned:eligible[0];
    if(!reviewer)throw Error('Cannot associate target chat with registered role');
    data.activeChat={name:reviewer,url:fields.chatUrl};
    data.activeAssignment={...(data.activeAssignment||{}),reviewer,
      phaseId:fields.phaseId,workerRole:fields.workerRole,
      milestoneId:fields.gateExpectedMilestoneId||fields.wakeId};
    data.watchdog=data.watchdog||{};
    data.watchdog.gate={...(data.watchdog.gate||{}),
      mode:'LITE',repository:CONTROLLER,ref:'main',
      statePath:fields.gateStatePath||directoryPath(campaign),
      expectedPhaseId:fields.phaseId,
      expectedMilestoneId:fields.gateExpectedMilestoneId||fields.wakeId};
    data.chatUrl=fields.chatUrl;
    data.wakeMessage=fields.message;
    data.updatedAt=now();
    return JSON.stringify(data,null,2)+'\n';
  });
  console.log(JSON.stringify({status:result,campaignId:campaign,commandId:id,path}));
}
function listActive(){
  try{
    return github(AUTOMATION,autoToken,['repos/'+AUTOMATION+'/contents/process/browser-agent-wake/registrations?ref=main'])
      .filter(x=>x.type==='file'&&x.name.endsWith('.json')).map(x=>x.path);
  }catch(e){
    if(/404|Not Found/.test(String(e.stderr||e.message)))return [];
    throw Error('Cannot list existing campaign registrations: '+String(e.stderr||e.message));
  }
}
function newestProgress(d,r){
  const ass=d.currentAssignment||{};
  const phase=Number(ass.phaseSequence||d.currentPhaseSequence||0);
  const dir=d.workspacePath+'/work/phase-'+String(phase).padStart(2,'0');
  if(!Number.isInteger(phase)||phase<1||phase>10)return null;
  let progressPath=ass.workShardIndexPath?
    ass.workShardIndexPath.replace(/\/INDEX[^/]*$/,''):
    (ass.workFormPath||dir);
  if(phase===4)progressPath=dir+'/discovery';
  const q='repos/'+CONTROLLER+'/commits?sha=main&per_page=1&path='+pathUrl(progressPath);
  try{
    const c=github(CONTROLLER,ctlToken,[q]);
    return c?.[0]?{key:c[0].sha,at:c[0].commit?.committer?.date||now()}:null;
  }catch{return null;}
}
function sweepOne(campaign){
  const d=directory(campaign).data,r=registration(campaign).data;
  if((d.deliveryTransport||BROWSER)!==WORK || (r.deliveryTransport||BROWSER)!==WORK)return;
  assertMode(d,r,WORK);
  const path=filePath(d),epoch=Number(d.transportEpoch||0);
  mutate(CONTROLLER,path,ctlToken,raw=>{
    const prev=readState(raw),s=prev?prev.data:emptyState(campaign,epoch);
    if(s.transportEpoch!==epoch)throw Error('Work watcher saw stale epoch');
    let changed=prev?settle(s,prev.first):true;
    if(d.campaignStatus==='COMPLETE'||d.campaignStatus==='STOPPED_BY_HUMAN'||d.status==='COMPLETE'){
      if(s.current||s.queue.length){s.current=null;s.queue=[];changed=true;}
      return changed?view(s):null;
    }
    const progress=newestProgress(d,r);
    if(progress && progress.key!==s.lastProgressKey){
      s.lastProgressKey=progress.key;s.lastProgressAt=progress.at;s.noProgressPokes=0;delete s.repairNoticeIssuedAt;changed=true;
    }
    const age=p=>p?(Date.now()-Date.parse(p))/60000:Infinity;
    if(s.current){
      if(age(s.current.issuedAt)>10 && s.transportTimeouts<3){
        const newValue=Math.max(s.transportTimeouts,Math.floor(age(s.current.issuedAt)/10));
        if(newValue!==s.transportTimeouts){s.transportTimeouts=Math.min(3,newValue);changed=true;}
      }
      if(s.transportTimeouts>=3){
        console.error('AGENT_DELIVERY_UNCONFIRMED: '+campaign+
          ' no first-line receipt for 30 minutes; archiving failed command and requesting repair');
        const stranded=s.current;
        // After the backup checks in, allow the canonical still-required wake to
        // be reconstructed. A timed-out send is never evidence of delivery.
        if(stranded.phaseId==='master-review')delete s.lastMasterIdentity;
        if(stranded.phaseId==='phase-4')delete s.lastDiscoveryIdentity;
        if(stranded.message.startsWith('CONTROLLER NEEDS_REWORK'))delete s.lastReworkIdentity;
        s.unconfirmedCommands=(s.unconfirmedCommands||[]).slice(-9).concat([{
          commandId:stranded.commandId,chatUrl:stranded.chatUrl,
          phaseId:stranded.phaseId,message:stranded.message,expectedCode:stranded.expectedCode,
          declaredUnconfirmedAt:now()}]);
        const backup=r.agentChats?.backup;
        if(backup && backup!==stranded.chatUrl){
          s.current={
            commandId:createHash('sha256').update(campaign+':repair:'+stranded.commandId).digest('hex').slice(0,26),
            wakeId:campaign+'-agent-delivery-repair-'+stranded.commandId,
            phaseId:stranded.phaseId,workerRole:'repair_child',
            chatUrl:backup,workspacePath:d.workspacePath,transportEpoch:epoch,
            message:'AGENT DELIVERY UNCONFIRMED: Original delivery '+stranded.commandId+
              ' to '+stranded.chatUrl+' has no first-line check-in after 30 minutes. '+
              'Read the authoritative campaign directory and the unconfirmedCommands entry in this same file. '+
              'Diagnose the previous recipient, check the assigned chat and resume the required work. '+
              'If Agent Delivery cannot deliver and browser transport is ready, switch this campaign to GITHUB_BROWSER via the existing lite-work-relay-v1.yml switch operation. '+
              'Do not run tests or seal a phase merely because a delivery was attempted.',
            expectedCode:'COMPLETE-'+randomBytes(8).toString('hex').toUpperCase(),issuedAt:now()
          };
          s.transportTimeouts=0;
          changed=true;
        }else{
          if(!s.lastTransportFailureAt){
            s.lastTransportFailureAt=now();
            changed=true;
          }
          process.exitCode=1;
        }
      }
    }else if(s.queue.length){s.current=s.queue.shift();changed=true;}
    else{
      // Recover missing dispatches directly from the canonical, already-published
      // controller state. The watchdog only sends instructions; it never advances
      // an audit boundary or creates a receipt.
      const assignment=d.currentAssignment||{};
      const expectedChat=r.agentChats?.[assignment.reviewer];
      const waiting=assignment.status==='WAITING_FOR_SUCCESSOR_AGENT' &&
        d.campaignStatus==='WAITING_FOR_SUCCESSOR_AGENT';
      const rework=assignment.status==='REWORK_REQUIRED';
      const missedSuccessor=waiting && expectedChat &&
        !(s.lastReceipt?.phaseId===assignment.phaseId &&
          s.lastReceipt?.targetChatUrl===expectedChat);
      const reworkIdentity=rework && assignment.packetPath?
        assignment.packetPath+':'+fetch(CONTROLLER,assignment.packetPath,ctlToken).sha:
        (assignment.workShardIndexPath||assignment.phaseId);
      const missedRework=rework && expectedChat && s.lastReworkIdentity!==reworkIdentity;
      const discoveryStatePath=d.discovery?.statePath||'';
      const discoveryIdentity=d.campaignStatus==='WAITING_FOR_DISCOVERY' && discoveryStatePath?
        discoveryStatePath+':'+fetch(CONTROLLER,discoveryStatePath,ctlToken).sha:'';
      const discoveryChat=r.agentChats?.['reviewer-2']||r.agentChats?.['reviewer-3L'];
      const missedDiscovery=Boolean(discoveryIdentity && discoveryChat &&
        s.lastDiscoveryIdentity!==discoveryIdentity);
      const masterChat=d.masterReview?.chatUrl||r.agentChats?.['master-reviewer'];
      const masterIdentity=[d.pendingMasterReview?.segmentId,
        d.pendingMasterReview?.recordPath,d.lastSealedReceiptPath].filter(Boolean).join('|')||'MASTER_REVIEW';
      const missedMaster=d.campaignStatus==='WAITING_FOR_MASTER_REVIEW'&&masterChat &&
        s.lastMasterIdentity!==masterIdentity;
      if(missedSuccessor||missedRework||missedMaster||missedDiscovery){
        const target=missedMaster?masterChat:missedDiscovery?discoveryChat:expectedChat;
        const phaseId=missedMaster?'master-review':missedDiscovery?'phase-4':assignment.phaseId;
        const identity=missedMaster?masterIdentity:missedDiscovery?discoveryIdentity:reworkIdentity;
        const kind=missedMaster?'master':missedDiscovery?'discovery':missedRework?'rework':'successor';
        const msg=missedDiscovery?
          'DISCOVERY PHASE 4 WAKE: '+campaign+'. Follow the bound audit skill discovery instructions for reviewer-2. Read the exact current '+discoveryStatePath+' on curveyield3/Audit-Controller main, complete the active flow and attacker windows in sequence, submit each required controller boundary and verify receipt. Preserve accepted discovery work. No tests without separate audit-owner authorization.':
          missedMaster?
          'MASTER REVIEW REQUIRED: '+campaign+'. Open the current Audit Campaign Directory and pendingMasterReview record in curveyield3/Audit-Controller. Complete the exact assigned segment following its bound audit skill authority, preserve all accepted evidence, and submit the master review through the existing controller pathway. Do not run tests without separate owner authorization.':
          missedRework?
          'CONTROLLER NEEDS_REWORK: '+campaign+' '+assignment.phaseId+'. Read the exact rejected packet '+assignment.packetPath+' in curveyield3/Audit-Controller and the authoritative current assignment. Repair the specific deficiencies while preserving accepted reviewer shards and sealed receipts; continue until controller PASS. Do not execute tests without separate owner authorization.':
          'LITE AUDIT SUCCESSOR: '+campaign+' reviewer '+assignment.reviewer+' '+assignment.phaseId+
          '. Canonical campaign: https://github.com/'+CONTROLLER+'/tree/main/'+pathUrl(d.workspacePath)+
          '. Read the Phase 0 receipt for the exact bound Audit Skill authority, and follow its current phase START_HERE. Complete your assigned work and submit to the existing controller; do not repeat sealed phases or run tests without separate owner authorization.';
        const id=createHash('sha256').update([campaign,epoch,kind,identity,target].join('\0')).digest('hex').slice(0,26);
        s.current={commandId:id,wakeId:campaign+'-'+kind+'-'+id,phaseId,
          workerRole:missedMaster?'master_reviewer':'reviewer',chatUrl:target,
          message:msg,workspacePath:d.workspacePath,transportEpoch:epoch,
          expectedCode:'COMPLETE-'+randomBytes(8).toString('hex').toUpperCase(),issuedAt:now()};
        if(missedRework)s.lastReworkIdentity=reworkIdentity;
        if(missedDiscovery)s.lastDiscoveryIdentity=discoveryIdentity;
        if(missedMaster)s.lastMasterIdentity=masterIdentity;
        s.updatedAt=now();
        return view(s);
      }
      const who=assignment.reviewer||d.currentReviewer;
      let chat=d.campaignStatus==='WAITING_FOR_DISCOVERY'?discoveryChat:r.agentChats?.[who];
      let phaseId=assignment.phaseId||'phase-'+(assignment.phaseSequence||d.currentPhaseSequence);
      const special=['WAITING_FOR_MASTER_REVIEW','WAITING_FOR_TARGETED_TESTS','MASTER_TESTS_REQUESTED'];
      if(special.includes(d.campaignStatus) && s.lastReceipt?.targetChatUrl &&
          Object.values(r.agentChats||{}).includes(s.lastReceipt.targetChatUrl)){
        chat=s.lastReceipt.targetChatUrl;
        phaseId=s.lastReceipt.phaseId||phaseId;
      }
      const relevant=assignment.status==='ACTIVE'||assignment.status==='REWORK_REQUIRED'||
        (assignment.status==='WAITING_FOR_SUCCESSOR_AGENT' && s.lastReceipt?.targetChatUrl===chat)||
        d.status==='ACTIVE'||d.campaignStatus==='WAITING_FOR_DISCOVERY'||special.includes(d.campaignStatus);
      const since=Math.max(Date.parse(s.lastProgressAt||0)||0,Date.parse(s.lastPokedAt||0)||0,Date.parse(s.lastReceipt?.receivedAt||0)||0);
      const elapsed=since?(Date.now()-since)/60000:Infinity;
      if(relevant&&chat&&elapsed>=20){
        const id=createHash('sha256').update([campaign,epoch,who,'POKE',Math.floor(Date.now()/1200000)].join('\0')).digest('hex').slice(0,26);
        const backup=r.agentChats?.backup;
        const escalate=s.noProgressPokes>=3 && backup && backup!==chat && !s.repairNoticeIssuedAt;
        const repairMessage='REPAIR REQUIRED: The campaign has had three acknowledged idle reminders with no reviewer-authored progress. Inspect the current Audit Campaign Directory, exact failed packet and accepted work. Resume the existing assignment; do not fabricate a PASS, repeat sealed phases, or run tests without explicit owner authorization. Diagnose the delivery transport; if this transport repeatedly fails and the other is ready, use the lite-work-relay-v1.yml switch operation to change the campaign mode.';
        s.current={commandId:id,wakeId:campaign+'-work-watchdog-'+id,phaseId:phaseId,
          workerRole:escalate?'repair_child':'reviewer',chatUrl:escalate?backup:chat,
          message:escalate?repairMessage:'GET BACK TO WORK',
          workspacePath:d.workspacePath,transportEpoch:epoch,
          expectedCode:'COMPLETE-'+randomBytes(8).toString('hex').toUpperCase(),issuedAt:now()};
        s.lastPokedAt=now();s.noProgressPokes++;if(escalate)s.repairNoticeIssuedAt=now();changed=true;
      }
    }
    if(!changed)return null;
    s.updatedAt=now();return view(s);
  },true);
  console.log('Work watchdog inspected '+campaign);
}
function switchMode(campaign,target){
  if(![WORK,BROWSER].includes(target))throw Error('Invalid delivery transport');
  const dir=directory(campaign),reg=registration(campaign);
  const before=dir.data.deliveryTransport||BROWSER;
  if(before===(reg.data.deliveryTransport||BROWSER) && before===target){
    const path=filePath(dir.data);
    const existing=readState(fetch(CONTROLLER,path,ctlToken,true)?.content||null);
    if(target===BROWSER && existing?.data.deliveryTransport===WORK){
      let pendingCommand=null;
      mutate(CONTROLLER,path,ctlToken,raw=>{
        const v=readState(raw);
        if(!v)return null;
        if(v.first!=='PENDING'&&v.first!=='IDLE')settle(v.data,v.first);
        const queued=[...(v.data.current?[v.data.current]:[]),...v.data.queue];
        pendingCommand=queued.length?queued[queued.length-1]:null;
        const updated={...v.data,deliveryTransport:BROWSER,current:null,queue:[],
          supersededByTransportSwitch:queued.map(c=>({commandId:c.commandId,
            chatUrl:c.chatUrl,phaseId:c.phaseId,message:c.message})),
          transportEpoch:Number(dir.data.transportEpoch||0),retiredAt:now(),updatedAt:now()};
        return view(updated,'IDLE');
      });
      console.log(JSON.stringify({status:'SWITCHED',campaignId:campaign,from:WORK,to:BROWSER,
        epoch:Number(dir.data.transportEpoch||0),pendingCommand}));
      return;
    }
    if(target===WORK && (!existing || existing.data.transportEpoch!==Number(dir.data.transportEpoch||0))){
      mutate(CONTROLLER,path,ctlToken,()=>view(emptyState(campaign,Number(dir.data.transportEpoch||0)),'IDLE'),true);
      console.log(JSON.stringify({status:'SWITCHED',campaignId:campaign,from:BROWSER,to:WORK,
        epoch:Number(dir.data.transportEpoch||0),pendingCommand:null}));
      return;
    }
    console.log(JSON.stringify({status:'ALREADY_SET',campaignId:campaign,transport:target}));return;
  }
  const regBefore=reg.data.deliveryTransport||BROWSER;
  const recovery=before!==regBefore && regBefore===target &&
    Number(reg.data.transportEpoch||0)===Number(dir.data.transportEpoch||0)+1;
  if(before!==regBefore && !recovery)throw Error('Mode divergence; manual reconcile before switching');
  if(target===WORK && before===BROWSER && !recovery){
    // Never block this campaign because a different campaign owns a browser runner.
    // A known in-progress wake *for this campaign* must finish before the switch.
    const runId=Number(reg.data.wakeDelivery?.runId||reg.data.wakeDelivery?.workflowRunId||0);
    if(Number.isSafeInteger(runId)&&runId>0){
      const run=github(AUTOMATION,autoToken,[
        'repos/'+AUTOMATION+'/actions/runs/'+runId]);
      if(run.status==='queued'||run.status==='in_progress'||run.status==='waiting')
        throw Error('This campaign has an active browser wake; retry transport switch after run '+runId+' completes');
    }
  }
  const epoch=recovery?Number(reg.data.transportEpoch):Number(dir.data.transportEpoch||0)+1;
  // Registration first; if the second write fails, retrying recovers its epoch.
  if(!recovery)mutate(AUTOMATION,registrationPath(campaign),autoToken,raw=>{
    const data=JSON.parse(raw);
    if(data.campaignId!==campaign)throw Error('Registration changed campaign');
    data.deliveryTransport=target;data.transportEpoch=epoch;data.updatedAt=now();
    return JSON.stringify(data,null,2)+'\n';
  });
  mutate(CONTROLLER,dir.path,ctlToken,raw=>{
    const data=JSON.parse(raw);
    if(data.campaignId!==campaign)throw Error('Directory changed campaign');
    data.deliveryTransport=target;data.transportEpoch=epoch;data.updatedAt=now();
    return JSON.stringify(data,null,2)+'\n';
  });
  const d=directory(campaign).data;
  if(target===WORK){
    mutate(CONTROLLER,filePath(d),ctlToken,raw=>{
      const old=readState(raw),s=emptyState(campaign,epoch);
      if(old?.data.current)s.previousTransportCommand=old.data.current.commandId;
      return view(s);
    },true);
    // Browser watchdog must not continue poking in the Work mode. Delete its active
    // registration before new Work commands can be enqueued.
    let active=[];
    try{active=github(AUTOMATION,autoToken,['repos/'+AUTOMATION+'/contents/process/browser-agent-watchdog/active?ref=main']);}
    catch(e){
      if(/404|Not Found/.test(String(e.stderr||e.message)))active=[];
      else throw Error('Cannot enumerate old browser watchdog state: '+String(e.stderr||e.message));
    }
    for(const f of active){
      if(f.type!=='file'||!f.name.endsWith('.json'))continue;
      const obj=fetch(AUTOMATION,f.path,autoToken);
      let state;try{state=JSON.parse(obj.content);}catch{continue;}
      if(state.campaignId===campaign)remove(AUTOMATION,f.path,autoToken,obj.sha,'chore(work-relay): retire old browser watcher '+campaign);
    }
  }
  let oldCommand=null;
  if(target===BROWSER){
    mutate(CONTROLLER,filePath(d),ctlToken,raw=>{
      const lastState=readState(raw);
      if(!lastState)return null;
      if(lastState.first!=='PENDING'&&lastState.first!=='IDLE')settle(lastState.data,lastState.first);
      const queued=[...(lastState.data.current?[lastState.data.current]:[]),...lastState.data.queue];
      oldCommand=queued.length?queued[queued.length-1]:null;
      const state={...lastState.data,deliveryTransport:BROWSER,
        transportEpoch:epoch,current:null,queue:[],
        supersededByTransportSwitch:queued.map(c=>({commandId:c.commandId,
          chatUrl:c.chatUrl,phaseId:c.phaseId,message:c.message})),
        retiredAt:now(),updatedAt:now()};
      return view(state,'IDLE');
    });
  }
  console.log(JSON.stringify({status:'SWITCHED',campaignId:campaign,from:before,to:target,epoch,
    pendingCommand:target===BROWSER?oldCommand:null}));
}
switch(op){
  case 'deliver':{
    const campaign=args['campaign-id'],wakeId=args['wake-id'],chat=args['chat-url'];
    const message=Buffer.from(args['wake-message-b64']||'','base64').toString('utf8');
    if(!campaign||!wakeId||!chat||!message)throw Error('Required delivery fields missing');
    enqueue(campaign,{wakeId,chatUrl:chat,message,phaseId:args['phase-id']||'',
      workerRole:args['worker-role']||'reviewer',
      gateStatePath:args['gate-state-path']||'',gateExpectedMilestoneId:args['gate-expected-milestone-id']||''});
    break;
  }
  case 'active-count':{
    let count=0;
    for(const path of listActive()){
      const v=fetch(AUTOMATION,path,autoToken);
      const r=JSON.parse(v.content);
      if(r.deliveryTransport!==WORK)continue;
      const d=directory(r.campaignId).data;
      if((d.deliveryTransport||BROWSER)!==WORK)continue;
      if(['COMPLETE','STOPPED_BY_HUMAN'].includes(d.campaignStatus||d.status))continue;
      count++;
    }
    console.log(count);
    break;
  }
  case 'sweep':{
    for(const path of listActive()){
      const v=fetch(AUTOMATION,path,autoToken),r=JSON.parse(v.content);
      if(r.deliveryTransport!==WORK)continue;
      try{sweepOne(r.campaignId);}catch(e){console.error('WORK_RELAY_WATCHDOG_FAILED '+r.campaignId+': '+e.message);process.exitCode=1;}
    }
    break;
  }
  case 'switch':{
    if(!args['campaign-id']||!args['target-mode'])throw Error('campaign-id and target-mode required');
    switchMode(args['campaign-id'],args['target-mode']);
    break;
  }
  default:throw Error('Unknown operation '+op);
}
