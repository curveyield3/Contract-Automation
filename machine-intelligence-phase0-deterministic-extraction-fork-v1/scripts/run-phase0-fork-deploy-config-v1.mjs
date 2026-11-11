import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

import {runPhase0RandomizedSimulationV1} from '../packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs';
const a={};for(let i=2;i<process.argv.length;i++){if(process.argv[i].startsWith('--'))a[process.argv[i].slice(2)]=process.argv[++i];}
for(const k of ['source-checkout-root','source-receipt','static-evidence-root','fork-run-root','output','fork-url-env'])
  if(!a[k])throw new Error('missing --'+k);
if(a['campaign-path'])throw new Error('FORK_RUNNER_CAMPAIGN_MUTATION_PATH_PROHIBITED');
const forkRunRoot=path.resolve(a['fork-run-root']);
if(path.resolve(a['source-receipt'])!==path.join(forkRunRoot,'inputs','READ_ONLY_INPUT_RECEIPT_COPY.json'))
  throw new Error('FORK_RUNNER_RECEIPT_COPY_PATH_INVALID');
const staticRoot=path.resolve(a['static-evidence-root']);
if(staticRoot!==forkRunRoot)throw new Error('FORK_STATIC_ROOT_MUST_MATCH_ISOLATED_RUN_ROOT');
const receipt=JSON.parse(await fs.readFile(a['source-receipt'],'utf8'));
const manifestPath=path.join(forkRunRoot,'inputs','FORK_STATIC_HANDOFF_MANIFEST_v1.json');
const handoff=JSON.parse(await fs.readFile(manifestPath,'utf8'));
const sha256=data=>createHash('sha256').update(data).digest('hex');
const expected=[
  ['BUILD_AND_SOURCE_IDENTITY_v1.json','evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'],
  ['PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json','evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json'],
  ['CONTRACT_IDENTITY_INDEX_v1.json','evidence/phase0/CONTRACT_IDENTITY_INDEX_v1.json'],
  ['SBOM_v1.json','evidence/build/SBOM_v1.json'],
  ['SLITHER_v1.json','evidence/static-analysis/SLITHER_v1.json'],
  ['SLITHER_RELATIONAL_FACTS_v1.json','evidence/static-analysis/SLITHER_RELATIONAL_FACTS_v1.json'],
  ['SOURCE_INTELLIGENCE_AUTOMATED_v1.json','evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json'],
  ['PROJECT_READINESS_AUTOMATED_v1.json','evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'],
  ['PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json','evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json']
];
const optionalExistingReview=[
  ['REVIEW_INVENTORY_v1.json','evidence/review-inventory/REVIEW_INVENTORY_v1.json'],
  ['SYSTEM_FACTS_v1.json','evidence/review-inventory/SYSTEM_FACTS_v1.json']
];
if(handoff.schemaVersion!=='mi-phase0-fork-static-handoff-v1'||
  handoff.campaignId!==receipt.campaign?.campaignId||
  handoff.campaignGenerationId!==receipt.campaign?.campaignGenerationId||
  handoff.sourceArchiveSha256!==receipt.source?.sha256||
  handoff.fileCount!==handoff.files?.length||
  handoff.fileCount<expected.length||handoff.fileCount>expected.length+optionalExistingReview.length)
  throw new Error('FORK_STATIC_HANDOFF_SOURCE_GENERATION_OR_CENSUS_MISMATCH');
const manifestByName=new Map();
for(const row of handoff.files){
  if(!row||manifestByName.has(row.sourceFile))throw new Error('FORK_STATIC_HANDOFF_DUPLICATE_OR_INVALID_FILE');
  manifestByName.set(row.sourceFile,row);
}
const optionalPresent=optionalExistingReview.filter(([filename])=>manifestByName.has(filename));
if(handoff.fileCount!==expected.length+optionalPresent.length)
  throw new Error('FORK_STATIC_HANDOFF_UNEXPECTED_ARTIFACTS');
const resolved=new Map();
for(const [filename,relative] of [...expected,...optionalPresent]){
  const row=manifestByName.get(filename);
  if(!row||row.destinationRelativePath!==relative||
    !/^[0-9a-f]{64}$/.test(String(row.sha256??''))||
    row.sourceArchiveSha256!==receipt.source.sha256)
      throw new Error('FORK_STATIC_HANDOFF_MISSING_OR_MISMATCHED_FILE: '+filename);
  const target=path.resolve(staticRoot,...relative.split('/'));
  if(!target.startsWith(staticRoot+path.sep))throw new Error('FORK_STATIC_HANDOFF_PATH_ESCAPE');
  const stat=await fs.lstat(target);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('FORK_STATIC_HANDOFF_NONREGULAR_FILE: '+filename);
  const bytes=await fs.readFile(target);
  if(bytes.length!==row.bytes||sha256(bytes)!==row.sha256)
    throw new Error('FORK_STATIC_HANDOFF_BYTES_DIFFER_FROM_IMMUTABLE_SOURCE: '+filename);
  const json=JSON.parse(bytes.toString('utf8'));
  if(row.schemaVersion!==json.schemaVersion)throw new Error('FORK_STATIC_HANDOFF_SCHEMA_MISMATCH: '+filename);
  resolved.set(filename,json);
}
const buildBundle=resolved.get('PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json');
const identity=resolved.get('CONTRACT_IDENTITY_INDEX_v1.json');
const slitherFacts=resolved.get('SLITHER_RELATIONAL_FACTS_v1.json');
const sourceSha=receipt.source.sha256,gen=receipt.campaign.campaignGenerationId;
if(buildBundle.source?.archiveSha256!==sourceSha||
  buildBundle.requestIdentity?.campaignGenerationId!==gen||
  identity.sourceArchiveSha256!==sourceSha||
  identity.campaignGenerationId!==gen||
  identity.buildArtifactBundleSha256!==handoff.buildArtifactBundleSha256||
  slitherFacts.sourceArchiveSha256!==sourceSha||
  slitherFacts.campaignGenerationId!==gen||
  slitherFacts.buildBundleSha256!==handoff.buildArtifactBundleSha256||
  handoff.buildArtifactBundleSha256!==manifestByName.get('PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json').sha256||
  identity.coverage?.compiledArtifactCount!==buildBundle.artifacts?.length||
  JSON.stringify(identity.compilationUnits)!==JSON.stringify(buildBundle.buildIdentity?.compilationUnits))
    throw new Error('FORK_STATIC_HANDOFF_COMPILER_OR_SLITHER_IDENTITY_MISMATCH');
process.stdout.write(JSON.stringify({handoff:'EXACT_COMPILER_BYTES_BOUND',files:handoff.fileCount,
  campaignId:receipt.campaign.campaignId,sourceSha256:sourceSha})+'\n');
const forkSecretVariable=String(a['fork-url-env']);
if(forkSecretVariable!=='MI_FORK_ETHEREUM_RPC_URL')
  throw new Error('FORK_UPSTREAM_SECRET_ENV_NAME_NOT_ALLOWED');
const forkUrl=process.env[forkSecretVariable];
const katanaForkUrl=process.env.KATANA_FORK_RPC_URL??null;
if(typeof forkUrl!=='string'||!forkUrl.startsWith('https://'))
  throw new Error('FORK_UPSTREAM_SECRET_MISSING_OR_NOT_TLS');
// Remove all upstream credentials before any source package process is invoked.
// Local Anvil retains the selected upstream URLs in this trusted process memory.
for(const name of ['AUDIT_CONTROLLER_GITHUB_TOKEN','PREFLIGHTSIM_GITHUB_TOKEN',
  'GITHUB_TOKEN','GH_TOKEN','MI_FORK_ETHEREUM_RPC_URL','KATANA_FORK_RPC_URL'])
  delete process.env[name];
const {deployEvidence}=await runPhase0RandomizedSimulationV1({
  sourceCheckoutRoot:path.resolve(a['source-checkout-root']),
  sourceReceiptPath:path.resolve(a['source-receipt']),
  staticEvidenceRoot:path.resolve(a['static-evidence-root']),
  outputRoot:path.resolve(a.output),forkUrl,
  forkUrls:{katana:katanaForkUrl??undefined},deploymentOnly:true});
process.stdout.write(JSON.stringify({status:deployEvidence?.status??'BLOCKED',executionMode:deployEvidence?.executionMode??null,attempts:deployEvidence?.attempts?.length??0})+'\n');
// Do not print source-script stdout/stderr into public workflow logs. Source
// scripts may intentionally output calldata, secrets, or unbounded data.
// Exact logs are retained only in fork-owned private evidence with source binding.
for(const gap of deployEvidence?.gaps??[])
  process.stderr.write('::warning::FORK_DEPLOY_LIMITATION '+String(gap.type??'UNKNOWN')+'\n');
for(const attempt of deployEvidence?.attempts??[]){
  if(attempt.status==='PASS')continue;
  process.stderr.write(JSON.stringify({status:'FORK_DEPLOY_ATTEMPT_INCOMPLETE',
    framework:attempt.framework??null,exitCode:attempt.exitCode??null})+'\n');
}
