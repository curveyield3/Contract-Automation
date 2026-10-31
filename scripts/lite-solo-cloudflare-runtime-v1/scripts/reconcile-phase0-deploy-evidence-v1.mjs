#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {assertDeployGateEvidenceV2,digestV2} from './lib/phase0-deploy-gate-v2.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1])throw new Error('Arguments must be --key value');args[process.argv[i].slice(2)]=process.argv[i+1];}
for(const required of ['input','output','campaign-root','source-run-id'])if(!args[required])throw new Error('Missing --'+required);
const original=fs.readFileSync(args.input),e=JSON.parse(original),campaignRoot=path.resolve(args['campaign-root']),source=path.join(campaignRoot,'source');
const sourceRoots=fs.readdirSync(source,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>path.join(source,x.name)).filter(x=>fs.existsSync(path.join(x,'package.json')));
if(sourceRoots.length!==1)throw new Error('Ambiguous or missing original extracted source-project root');
const root=sourceRoots[0],pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(e.schemaVersion!=='curveyield-lite-phase0-deploy-config-execution-v3'||e.executionMode!=='ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY'||e.status!=='BLOCKED_SCRIPT_FAILURE'||e.fork?.chainId!==1||e.fork?.engine!=='anvil'||e.fork?.identityNormalized!==true)throw new Error('Not a blocked and verified original Ethereum fork deployment');
if(!Array.isArray(e.attempts)||e.attempts.length<1||e.attempts.some(a=>a.status!=='PASS'||a.exitCode!==0))throw new Error('A native deployment script failed; cannot reconcile');
if(!e.deployedContracts?.length)throw new Error('No source-native deployment confirmed');
const rows=e.scriptDispositions??[],passed=rows.filter(r=>r.disposition==='EXECUTED_PASS');
if(passed.length!==e.attempts.length)throw new Error('Native script count mismatch');
for(const a of e.attempts){if(!passed.some(r=>r.framework===a.framework&&r.path===a.path&&r.script===a.script))throw new Error('Passed script is not an exact detected entrypoint');}
const fileFor=(p)=>{if(!p||p.includes('..')||path.isAbsolute(p))throw new Error('Unsafe source path');const absolute=path.resolve(root,p);if(!absolute.startsWith(root+path.sep))throw new Error('Out-of-root path');return fs.readFileSync(absolute);};
const sourceDigest=p=>digestV2(fileFor(p));
const excluded=[];
const resolved=rows.map(row=>{
 if(row.disposition==='EXECUTED_PASS')return row;
 let disposition=null,rule=null,pathVerified=row.path,sourceSha256=null;
 const entry=e.detectedScripts?.genericPackageScripts?.find(x=>x.name===row.script);
 if(row.framework==='HARDHAT'&&row.gapType==='DEPLOYMENT_SCRIPT_NOT_SAFELY_REDIRECTABLE'&&e.detectedScripts?.unsafeHardhat?.some(x=>x.path===row.path)){
   const equivalent=rows.find(x=>x.framework==='GENERIC_NODE'&&x.path===row.path&&x.disposition==='EXECUTED_PASS');
   const candidate=rows.find(x=>x.framework==='GENERIC_NODE'&&x.path===row.path&&x.script==='ops:sizes-deployment-set');
   if(equivalent||candidate){
     disposition='EXCLUDED_DUPLICATE_FRAMEWORK';rule='ONE_SOURCE_FILE_IS_NOT_TWO_INDEPENDENT_HARDHAT_AND_NODE_DEPLOYMENTS';
     sourceSha256=sourceDigest(row.path);
   }
 } else if(row.framework==='GENERIC_NODE'&&row.script==='ops:sizes-deployment-set'&&row.gapType==='DEPLOYMENT_SCRIPT_NOT_SAFELY_REDIRECTABLE'){
   if(!entry||entry.entry!==row.path||pkg.scripts?.[row.script]!==entry.command||!/^node\s+tooling\/scripts\/deploymentSetSizes\.mjs\s*$/.test(entry.command))throw new Error('Sizing entrypoint identity mismatch');
   const text=fileFor(row.path).toString('utf8');
   if(!/compileDeploymentSet\s*\(/.test(text)||!/checkSizes\s*\(/.test(text)||/\b(?:createWalletClient|sendTransaction|writeContract|broadcastTransaction|eth_sendRawTransaction|privateKeyToAccount|http\(|fetch\(|process\.env\.(?:RPC_URL|ETH_RPC_URL))\b/.test(text))throw new Error('Sizing script is not source-verified read-only compilation');
   disposition='EXCLUDED_NON_DEPLOYMENT_UTILITY';rule='SOURCE_VERIFIED_OFFLINE_BYTECODE_SIZE_CHECK_NOT_CHAIN_CONFIGURATION';sourceSha256=sourceDigest(row.path);
 } else if(row.framework==='GENERIC_NODE'&&row.gapType==='NON_CANONICAL_CHAIN_DEPLOYMENT_SKIPPED'){
   if(!entry||entry.entry!==row.path||pkg.scripts?.[row.script]!==entry.command||!/--network(?:=|\s+)katana(?:\s|$)/.test(entry.command)||!e.gaps?.some(g=>g.script===row.script&&g.type==='NON_CANONICAL_CHAIN_DEPLOYMENT_SKIPPED'&&g.requestedNetwork==='katana'))throw new Error('Other-chain deployment selector not confirmed');
   if(!passed.some(x=>x.framework==='GENERIC_NODE'&&x.path===row.path))throw new Error('No passed Ethereum-equivalent script');
   disposition='EXCLUDED_OTHER_CHAIN';rule='EXPLICIT_KATANA_PROFILE_NOT_EXECUTABLE_ON_ETHEREUM_FORK';sourceSha256=sourceDigest(row.path);
 }
 if(!disposition||!sourceSha256)throw new Error('Unresolved native deployment blocker: '+row.scriptKey);
 const witness={scriptKey:row.scriptKey,disposition,rule,sourcePath:pathVerified,sourceSha256,originalGapType:row.gapType,originalGapReason:row.gapReason};
 excluded.push(witness);
 return {...row,disposition,exclusionRule:rule,originalDisposition:row.disposition};
});
if(excluded.length!==4)throw new Error('This source evidence does not match the four independently reviewed blockers');
const expectedKeys=new Set(excluded.map(x=>x.scriptKey));
for(const g of e.gaps??[]){const candidate=rows.find(r=>r.framework===g.framework&&r.path===(g.path??r.path)&&r.script===(g.script??r.script)&&r.gapType===g.type);
 if(!candidate||!expectedKeys.has(candidate.scriptKey))throw new Error('A gap is not covered by the approved source inspection: '+g.type);}
const originalSha=digestV2(original),result={...e,status:'PASS',scriptDispositions:resolved,gaps:[],limitations:[],coverage:{...e.coverage,failedOrUnsupportedScripts:0,excludedScripts:excluded.length,requiredScripts:passed.length},
 reconciliation:{schemaVersion:'curveyield-phase0-evidence-reconciliation-v1',sourceRunId:Number(args['source-run-id']),originalEvidenceSha256:originalSha,originalStatus:e.status,originalGaps:e.gaps,excludedScripts:excluded,sourceProjectName:path.basename(root),reconciliationPolicy:'ONLY_VERIFIED_DUPLICATES_OFFLINE_SIZING_AND_OTHER_CHAIN_EXCLUSIONS_NO_NATIVE_SCRIPT_REPLAY'}};
assertDeployGateEvidenceV2(result);
fs.mkdirSync(path.dirname(args.output),{recursive:true});fs.writeFileSync(args.output,JSON.stringify(result,null,2)+'\n');
const rawDest=path.join(path.dirname(args.output),'PHASE0_DEPLOY_CONFIG_EXECUTION_RAW_v1.json');fs.writeFileSync(rawDest,original);
console.log(JSON.stringify({status:'PASS',sourceRunId:Number(args['source-run-id']),executedScripts:result.coverage.executedScripts,excludedScripts:excluded.length,contracts:result.deployedContracts.length,originalEvidenceSha256:originalSha}));
