import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDeployGateEvidenceV2} from '../scripts/lib/phase0-deploy-gate-v2.mjs';
function fixture(){
 const skips=[
  ['HARDHAT:a.mjs','EXCLUDED_DUPLICATE_FRAMEWORK','ONE_SOURCE_FILE_IS_NOT_TWO_INDEPENDENT_HARDHAT_AND_NODE_DEPLOYMENTS'],
  ['HARDHAT:deploymentSetSizes.mjs','EXCLUDED_DUPLICATE_FRAMEWORK','ONE_SOURCE_FILE_IS_NOT_TWO_INDEPENDENT_HARDHAT_AND_NODE_DEPLOYMENTS'],
  ['GENERIC_NODE:sizes','EXCLUDED_NON_DEPLOYMENT_UTILITY','SOURCE_VERIFIED_OFFLINE_BYTECODE_SIZE_CHECK_NOT_CHAIN_CONFIGURATION'],
  ['GENERIC_NODE:katana','EXCLUDED_OTHER_CHAIN','EXPLICIT_KATANA_PROFILE_NOT_EXECUTABLE_ON_ETHEREUM_FORK']
 ];
 return {schemaVersion:'curveyield-lite-phase0-deploy-config-execution-v3',
 executionMode:'ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY',fork:{engine:'anvil',chainId:1,identityNormalized:true},
 status:'PASS',attempts:[{framework:'GENERIC_NODE',script:'deploy',status:'PASS',exitCode:0}],
 deployedContracts:[{address:'0x1111111111111111111111111111111111111111'}],
 scriptDispositions:[{scriptKey:'GENERIC_NODE:deploy',disposition:'EXECUTED_PASS'},...skips.map(([scriptKey,disposition,exclusionRule])=>({scriptKey,disposition,exclusionRule}))],
 reconciliation:{originalEvidenceSha256:'a'.repeat(64),excludedScripts:skips.map(([scriptKey,disposition,rule])=>({scriptKey,disposition,rule,sourceSha256:'b'.repeat(64)}))},
 gaps:[],limitations:[],coverage:{detectedScripts:5,executedScripts:1,passedScripts:1,excludedScripts:4,requiredScripts:1,failedOrUnsupportedScripts:0}};
}
test('gate accepts precisely source-verified duplicate/offline/foreign-chain exclusions',()=>assert.equal(assertDeployGateEvidenceV2(fixture()),true));
test('gate rejects an unsupported native deployment',()=>{const x=fixture();x.scriptDispositions[2].disposition='UNSUPPORTED_WITH_TYPED_GAP';assert.throws(()=>assertDeployGateEvidenceV2(x));});
test('gate rejects a failed executed script',()=>{const x=fixture();x.attempts[0].exitCode=1;assert.throws(()=>assertDeployGateEvidenceV2(x));});
test('gate rejects lost source witness or unresolved gaps',()=>{const x=fixture();delete x.reconciliation.excludedScripts[0].sourceSha256;assert.throws(()=>assertDeployGateEvidenceV2(x));const y=fixture();y.gaps.push({type:'UNSAFE'});assert.throws(()=>assertDeployGateEvidenceV2(y));});
test('gate rejects a skipped native script hidden outside exclusions',()=>{const x=fixture();x.scriptDispositions.push({scriptKey:'FOUNDRY:new',disposition:'EXCLUDED_OTHER_CHAIN'});x.coverage.detectedScripts++;assert.throws(()=>assertDeployGateEvidenceV2(x));});

test('no-deployment-script waiver requires exact zero-script inventory and source binding',()=>{
  const x=fixture();x.status='NOT_APPLICABLE_NO_DEPLOYMENT_SCRIPT';
  x.sourceSha256='f'.repeat(64);x.detectedScripts={foundry:[],hardhat:[],unsafeHardhat:[],genericPackageScripts:[]};x.scriptDispositions=[];x.attempts=[];x.deployedContracts=[];
  x.coverage={detectedScripts:0,requiredScripts:0,executedScripts:0,failedOrUnsupportedScripts:0};
  assert.equal(assertDeployGateEvidenceV2(x),true);
  x.coverage.detectedScripts=1;assert.throws(()=>assertDeployGateEvidenceV2(x),/zero-script/);
  x.coverage.detectedScripts=0;x.detectedScripts.foundry=[{path:'deploy.s.sol'}];assert.throws(()=>assertDeployGateEvidenceV2(x),/zero-script/);
});
