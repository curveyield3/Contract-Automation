import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Fork-only implementation of the existing Phase 0 output writer.
// Never writes to a campaign, a receipt, main, the private cache, or the Worker.
const a={};
for(let i=2;i<process.argv.length;i++)if(process.argv[i].startsWith('--'))a[process.argv[i].slice(2)]=process.argv[++i];
for(const key of ['controller-root','fork-run-root','source-receipt','simulation-output'])
  if(!a[key])throw new Error('FORK_WRITER_REQUIRED_'+key.replaceAll('-','_'));
if(a['campaign-path']||a['destination-campaign-path'])
  throw new Error('FORK_WRITER_CAMPAIGN_PATH_WRITE_PROHIBITED');
const controllerRoot=path.resolve(a['controller-root']);
const forkRunRoot=path.resolve(a['fork-run-root']);
const prefix='Machine Intelligence Phase0 Deterministic Extraction Fork v1/runs/';
const rel=path.relative(controllerRoot,forkRunRoot).split(path.sep).join('/');
if(!rel.startsWith(prefix)||rel.split('/').length!==4||rel.includes('..'))
  throw new Error('FORK_RUN_ROOT_OUTSIDE_AUTHORIZED_ISOLATED_NAMESPACE');
const receiptFile=path.resolve(a['source-receipt']);
if(receiptFile!==path.join(forkRunRoot,'inputs','READ_ONLY_INPUT_RECEIPT_COPY.json'))
  throw new Error('SOURCE_RECEIPT_COPY_MUST_STAY_IN_FORK_INPUTS');
const receiptBytes=await fs.readFile(receiptFile);
const receipt=JSON.parse(receiptBytes.toString('utf8'));
if(receipt?.campaign?.campaignId!==rel.split('/')[2]||
  !/^[a-f0-9]{64}$/i.test(String(receipt?.source?.sha256??'')))
  throw new Error('FORK_SOURCE_RECEIPT_OR_CAMPAIGN_IDENTITY_MISMATCH');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const simulationOutput=path.resolve(a['simulation-output']);
const staticOutput=a['static-output']?path.resolve(a['static-output']):null;
const files=[];
const writeVerified=async(source,targetRel)=>{
  const stat=await fs.lstat(source).catch(()=>null);
  if(!stat||!stat.isFile()||stat.isSymbolicLink())return false;
  const dst=path.resolve(forkRunRoot,...targetRel.split('/'));
  if(!dst.startsWith(forkRunRoot+path.sep))throw new Error('FORK_WRITER_OUTPUT_ESCAPE');
  await fs.mkdir(path.dirname(dst),{recursive:true});
  const bytes=await fs.readFile(source);
  try{await fs.writeFile(dst,bytes,{flag:'wx'});}
  catch(error){
    if(error?.code!=='EEXIST')throw error;
    const existing=await fs.readFile(dst);
    if(sha256(existing)!==sha256(bytes))throw new Error('FORK_WRITER_CONFLICTING_IMMUTABLE_EVIDENCE');
  }
  const observed=await fs.readFile(dst);
  if(sha256(observed)!==sha256(bytes))throw new Error('FORK_WRITER_READBACK_DIGEST_MISMATCH');
  files.push({path:targetRel,sha256:sha256(bytes),bytes:bytes.length});
  return true;
};
const staticMap=[
  ['BUILD_AND_SOURCE_IDENTITY_v1.json','evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'],
  ['PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json','evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json'],
  ['SBOM_v1.json','evidence/build/SBOM_v1.json'],
  ['SLITHER_v1.json','evidence/static-analysis/SLITHER_v1.json'],
  ['SLITHER_RELATIONAL_FACTS_v1.json','evidence/static-analysis/SLITHER_RELATIONAL_FACTS_v1.json'],
  ['SOURCE_INTELLIGENCE_AUTOMATED_v1.json','evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json'],
  ['PROJECT_READINESS_AUTOMATED_v1.json','evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json']
];
if(staticOutput){
  for(const [name,destination] of staticMap){
    const ok=await writeVerified(path.join(staticOutput,name),destination);
    if(!ok)files.push({path:destination,status:'UNAVAILABLE'});
  }
}
const simMap=[
  ['PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json'],
  ['DEPLOYED_STATE_SNAPSHOT_v1.json','evidence/phase0/DEPLOYED_STATE_SNAPSHOT_v1.json']
];
for(const [name,destination] of simMap){
  const ok=await writeVerified(path.join(simulationOutput,name),destination);
  if(!ok)files.push({path:destination,status:'UNAVAILABLE'});
}
// Only the copied extractor's own evidence/phase0 tree is eligible.
// This includes complete hash-bearing trace parts, never an original campaign path.
const simEvidence=path.join(simulationOutput,'evidence','phase0');
async function copyTree(from,relative=''){
  const stat=await fs.lstat(from).catch(()=>null);
  if(!stat)return;
  if(stat.isSymbolicLink())throw new Error('FORK_WRITER_SYMLINK_INPUT_FORBIDDEN');
  if(stat.isFile()){
    await writeVerified(from,path.posix.join('evidence/phase0',relative));
  }else if(stat.isDirectory()){
    for(const ent of await fs.readdir(from,{withFileTypes:true})){
      if(ent.name==='.'||ent.name==='..')throw new Error('FORK_WRITER_INVALID_FILE_NAME');
      await copyTree(path.join(from,ent.name),path.posix.join(relative,ent.name));
    }
  }
}
await copyTree(simEvidence);
const manifest={schemaVersion:'mi-phase0-fork-only-writer-v1',
  status:'FORK_ONLY_NOT_CONTROLLER_ACCEPTED',
  campaignId:receipt.campaign.campaignId,
  campaignGenerationId:receipt.campaign.campaignGenerationId,
  sourceArchiveSha256:receipt.source.sha256,
  originalReceiptSha256:sha256(receiptBytes),
  sourceReceiptRef:path.posix.join('inputs','READ_ONLY_INPUT_RECEIPT_COPY.json'),
  outputRootRelative:rel,
  files:files.sort((a,b)=>a.path.localeCompare(b.path)),
  publicationLimitations:['No controller core/bundle receipt, phase finalization or Worker acceptance is claimed.']};
const dst=path.join(forkRunRoot,'evidence','FORK_WRITER_READBACK_v1.json');
await fs.mkdir(path.dirname(dst),{recursive:true});
await fs.writeFile(dst,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({status:manifest.status,campaignId:manifest.campaignId,
  fileCount:manifest.files.filter(x=>x.sha256).length,
  unavailable:manifest.files.filter(x=>x.status==='UNAVAILABLE').length})+'\n');
