#!/usr/bin/env node
// Audit Preview v1: Phase-0 fail-closed contract permit for the source and deployed populations.
import fs from 'node:fs';
import path from 'node:path';
const args={};
for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1])throw Error('invalid arguments');args[process.argv[i].slice(2)]=process.argv[i+1];}
const root=path.resolve(args['controller-root']??'.audit-controller');
const campaign=args['campaign-path'];
if(!campaign?.startsWith('campaigns/')||campaign.split('/').some(x=>x==='..'||x===''))throw Error('unsafe campaign path');
const workspace=path.resolve(root,campaign);
const receiptFile=path.join(workspace,'receipts/PHASE_00_RECEIPT_v1.json');
const get=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n')};
const receipt=get(receiptFile);
const permit=receipt.auditPreview?.permittedContracts;
if(receipt.authority?.liteRelease!=='audit-preview-v1'||receipt.authority?.homepagePath!=='Audit Skill - Audit Preview/audit-preview-v1/SKILL.md'||!Number.isSafeInteger(permit)||permit<1||receipt.auditPreview?.terminalPhase!==4)throw Error('AUDIT_PREVIEW_INVALID_PERMIT_OR_AUTHORITY');
const dir=path.join(root,'Audit Campaign Directory/campaigns',receipt.campaign.campaignId.replace(/-r[0-9]+$/,'')+'.json');
const directory=get(dir);
if(directory.campaignId!==receipt.campaign.campaignId||directory.auditPreview?.permittedContracts!==permit||directory.authorityRelease!=='audit-preview-v1')throw Error('AUDIT_PREVIEW_PERMIT_BINDING_MISMATCH');
const address=v=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v)?v.toLowerCase():null;
const uniq=(rows,label)=>{if(!Array.isArray(rows))throw Error(label+' must be an array');const addresses=rows.map(r=>address(typeof r==='string'?r:r?.address));if(addresses.some(x=>!x))throw Error(label+' has malformed or missing contract address');return [...new Set(addresses)].sort()};
const stage=args.stage,live=receipt.source?.inputMode==='LIVE_SCAN';
const result={schemaVersion:'curveyield-audit-preview-contract-count-v1',campaignId:receipt.campaign.campaignId,sourceSha256:receipt.source.sha256,permittedContracts:permit,stage,inputMode:live?'LIVE_SCAN':'ZIP',status:'PENDING',count:null,addresses:[],errorCode:null,message:null};
const fail=(code,message)=>{result.status='FAIL';result.errorCode=code;result.message=message;
 receipt.phase.status='FAILED';receipt.updatedAt=new Date().toISOString();receipt.validation={status:'FAIL',validatedAt:receipt.updatedAt,failures:[{code,message}]};
 directory.campaignStatus='PREVIEW_REJECTED';directory.currentAssignment=null;directory.updatedAt=receipt.updatedAt;
 write(receiptFile,receipt);write(dir,directory);
 console.error('::error title='+code+'::'+message);
 process.exitCode=1;};
try{
 if(!['source','deployment'].includes(stage))throw Error('unrecognized gate stage');
 if(live){
  const relative=receipt.source.scanManifestPath;
  if(typeof relative!=='string'||!relative.startsWith(campaign+'/source/')||relative.includes('..'))throw Error('missing or unsafe frozen source manifest');
  const manifest=get(path.resolve(root,relative));
  if(manifest.schemaVersion!=='curveyield-scan-source-manifest-v1'||manifest.inputMode!=='LIVE_SCAN')throw Error('frozen source manifest invalid');
  const addresses=uniq(manifest.resolvedTargets,'resolvedTargets');
  if(manifest.resolvedTargets.length!==addresses.length)throw Error('duplicate resolved targets');
  if(!Array.isArray(manifest.requestedTargets)||manifest.requestedTargets.length===0)throw Error('requestedTargets unavailable');
  result.addresses=addresses;result.count=addresses.length;
  if(stage==='deployment'){
   const deploy=get(path.resolve(args['deployment-evidence']??'.phase0-deploy-output/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'));
   const witness=uniq(deploy.liveDeployment?.contracts,'liveDeployment.contracts');
   if(JSON.stringify(witness)!==JSON.stringify(addresses))throw Error('live deployment witness and frozen source target count disagree');
  }
 } else if(stage==='deployment'){
  const deploy=get(path.resolve(args['deployment-evidence']??'.phase0-deploy-output/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'));
  if(deploy.campaignId!==receipt.campaign.campaignId||deploy.sourceSha256!==receipt.source.sha256)throw Error('fork witness has wrong campaign/source identity');
  const trace=deploy.auditPreviewCreationTrace;
  if(trace?.status!=='COMPLETE'||trace.chainId!==deploy.fork?.chainId||trace.firstBlock!==deploy.fork.initialBlock+1||trace.lastBlock!==deploy.fork.finalBlock)throw Error('contract deployment call tracing incomplete');
  const traced=uniq(trace.createdAddresses,'trace.createdAddresses');
  const observed=uniq(deploy.deployedContracts??[],'deployedContracts');
  result.addresses=[...new Set([...traced,...observed])].sort();
  result.count=result.addresses.length;
 }else {
  result.status='PENDING_DEPLOYMENT';
 }
 if(result.count!==null){
  if(result.count>permit)fail('AUDIT_PREVIEW_ECONTRACT_LIMIT','Number of contracts exceeds permit');
  else result.status='PASS';
 }
}catch(e){
 fail('AUDIT_PREVIEW_CONTRACT_COUNT_UNVERIFIABLE','Contract count cannot be verified: '+String(e.message??e).slice(0,300));
}
const evidence=path.join(workspace,'evidence/phase0/AUDIT_PREVIEW_CONTRACT_COUNT_v1.json');
write(evidence,result);
console.log(JSON.stringify({stage,status:result.status,count:result.count,permittedContracts:permit,errorCode:result.errorCode}));
