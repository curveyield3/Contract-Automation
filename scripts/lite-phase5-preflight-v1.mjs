#!/usr/bin/env node
// Dependency-free, read-only pre-toolchain Phase-5 execution gate. Creates only
// fully schema-valid V7 requests from complete, source-bound executable designs.
import fs from 'node:fs';
import path from 'node:path';
import {generateV7ExecutionRequestV1} from './lib/lite-phase5-request-generation-v1.mjs';
import {materializeSemanticWorkFormV13} from './lib/lite-solo-work-shards-v1.mjs';
import {validateTargetExecutionRequestBindingV1,inspectPhase5OwnerEvidenceDeferralV1} from '../packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs';
import {verifyPhase0ForkStateV1} from '../packages/github-native-sim/src/phase0-fork-state-reuse-v1.mjs';

const [root,campaignPath,campaignId,sourceSha256]=process.argv.slice(2);
if(!root||!/^campaigns\//.test(campaignPath??'')||!campaignId||!/^[a-f0-9]{64}$/i.test(sourceSha256??''))
  throw new Error('Usage: node scripts/lite-phase5-preflight-v1.mjs ROOT campaigns/PATH CAMPAIGN_ID SOURCE_SHA256');
const fullRel=path.posix.join(campaignPath,'work/phase-05/PHASE_05_WORK_FORM_v1.json');
const fullFile=path.join(root,...fullRel.split('/'));
const indexRel=path.posix.join(campaignPath,'work/phase-05/shards/INDEX_v1.json');
const indexFile=path.join(root,...indexRel.split('/'));
const sharded=fs.existsSync(indexFile);
if(sharded){
  try{materializeSemanticWorkFormV13({root,formRel:fullRel});}
  catch(error){
    process.stdout.write(JSON.stringify({schemaVersion:'curveyield-phase5-request-preflight-v1',campaignId,sourceSha256,
      status:'REWORK_REQUIRED',runnable:false,designCount:0,readyCount:0,generated:[],
      failures:[{path:indexRel,reason:'Work shard integrity: '+String(error?.message??error),shardPath:indexRel}]})+'\n');
    process.exit(2);
  }
}
const read=rel=>JSON.parse(fs.readFileSync(path.join(root,campaignPath,rel),'utf8'));
const phase0=read('receipts/PHASE_00_RECEIPT_v1.json');
const phase0Source={...phase0.source};
const stateManifestRef=path.posix.join(campaignPath,'evidence/phase0/PHASE0_FORK_STATE_MANIFEST_v1.json');
const stateRoot=path.join(root,...campaignPath.split('/'),'evidence','phase0');
if(fs.existsSync(path.join(root,...stateManifestRef.split('/')))){
  try{
    const manifest=JSON.parse(fs.readFileSync(path.join(root,...stateManifestRef.split('/')),'utf8'));
    await verifyPhase0ForkStateV1({root:stateRoot,manifest});
    if(manifest.sourceSha256!==sourceSha256||manifest.campaignId!==campaignId)
      throw new Error('Phase-0 state does not match current campaign/source');
    phase0Source.reusableForkState={...manifest,manifestRef:stateManifestRef};
  }catch(error){phase0Source.reusableForkState={status:'INVALID',reason:String(error?.message??error)};}
}

const form=read('work/phase-05/PHASE_05_WORK_FORM_v1.json');
const designs=form?.actions?.['step-3']?.outputs?.targetDesigns;
const failures=[],ready=[],generated=[];
const shardFor=(index,key)=>{
  const descriptors=index?.schemaVersion==='curveyield-work-shard-index-v13'
    ?index.pages.flatMap(p=>JSON.parse(fs.readFileSync(path.join(root,...path.posix.dirname(indexRel).split('/'),p.file),'utf8')).shards)
    :(index?.shards??[]);
  for(const s of descriptors)if(s.recordKeys.some(x=>x.includes('candidateKey='+key)))
    return path.posix.join(path.posix.dirname(indexRel),s.file);
  return null;
};
const index=sharded?JSON.parse(fs.readFileSync(indexFile,'utf8')):null;

if(!Array.isArray(designs)||!designs.length)
  failures.push({path:'actions.step-3.outputs.targetDesigns',reason:'Missing target designs'});
else for(const [i,target] of designs.entries()){
  const prefix='targetDesigns['+i+']';
  const key=String(target?.candidateKey??'').trim();
  const shardPath=shardFor(index,key);
  const fail=(path,reason,details=[])=>failures.push({path,candidateKey:key,shardPath,reason,details});
  if(!key){fail(prefix+'.candidateKey','Missing candidate');continue;}
  const method=String(target.executionMethod??'');
  if(method==='NOT_APPLICABLE')continue;
  if(method!=='V7_REQUEST'){fail(prefix+'.executionMethod','Unsupported method');continue;}
  if(!target.executionRequestRef||String(target.executionRequestRef).trim().startsWith('<')){
    const generatedRequest=generateV7ExecutionRequestV1({
      campaignId,sourceSha256,phase0Source,target,automationRoot:process.cwd()});
    if(generatedRequest.status!=='GENERATED'){
      for(const item of generatedRequest.missing)fail(prefix+'.'+item.field,item.reason);
      continue;
    }
    const safe=key.replace(/[^A-Za-z0-9._-]/g,'_');
    const rel='work/phase-05/execution-requests/'+safe+'.json';
    const out=path.join(root,campaignPath,rel);
    fs.mkdirSync(path.dirname(out),{recursive:true});
    const content=JSON.stringify(generatedRequest.request,null,2)+'\n';
    if(!fs.existsSync(out)||fs.readFileSync(out,'utf8')!==content)
      fs.writeFileSync(out,content);
    // Do not change reviewer work or its controller prefill digest in preflight.
    // The existing controller resolver owns the executionRequestRef mutation.
    generated.push({candidateKey:key,executionRequestRef:rel,shardPath});
    const evidenceRel='work/phase-05/execution-requests/'+safe+'.design-v1.json';
    const evidencePath=path.join(root,campaignPath,evidenceRel);
    fs.writeFileSync(evidencePath,JSON.stringify({schemaVersion:'curveyield-phase5-machine-design-v1',
      campaignId,sourceSha256,candidateKey:key,requestDigest:generatedRequest.request.requestDigest,
      ...generatedRequest.designEvidence},null,2)+'\n');
  }
  const candidateRef=(target.executionRequestRef&&!String(target.executionRequestRef).trim().startsWith('<')?target.executionRequestRef:null)||(generated.some(x=>x.candidateKey===key)?
    generated.find(x=>x.candidateKey===key).executionRequestRef:null);
  const binding=validateTargetExecutionRequestBindingV1({controllerRoot:root,campaignPath,
    target:{...target,executionRequestRef:candidateRef},expectedCampaignId:campaignId,
    expectedSourceSha256:sourceSha256});
  if(!binding.status.startsWith('PASS_'))
    fail(prefix+'.executionRequestRef',binding.status,binding.reasons);
  else ready.push(key);
}

// The read-only preflight must not regenerate controller-bound v13 shard indexes.
// When the exact audit owner has directed continuation with unverified
// candidate evidence, preflight still validates all requests but must NEVER
// permit toolchain installation or machine execution as an incidental effect.
const deferral=inspectPhase5OwnerEvidenceDeferralV1({
  controllerRoot:root,campaignPath,campaignId,sourceSha256,targetDesigns:designs
});
const report={schemaVersion:'curveyield-phase5-request-preflight-v1',campaignId,sourceSha256,
  status:failures.length?'REWORK_REQUIRED':'PREFLIGHT_PASS',runnable:failures.length===0&&ready.length>0&&!deferral,
  ...(deferral?{evidenceDisposition:'DEFERRED_UNVERIFIED',deferralPath:deferral.path}:{}),
  designCount:designs?.length??0,readyCount:ready.length,generated,failures,
  ...(sharded?{workShardIndexPath:indexRel}:{})};
process.stdout.write(JSON.stringify(report)+'\n');
if(failures.length)process.exitCode=2;
