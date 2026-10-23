import {createHash} from 'node:crypto';
import {keccak256} from 'ethers';
import {assertPhase0ForkIdentity,compareLiveRuntimeV1} from '../../packages/github-native-sim/src/phase0-deployment-profile-v1.mjs';
export const EXCLUSIONS_V2=new Set(['EXCLUDED_DUPLICATE_FRAMEWORK','EXCLUDED_NON_DEPLOYMENT_UTILITY','EXCLUDED_OTHER_CHAIN']);
export const digestV2=value=>createHash('sha256').update(value).digest('hex');
export function assertDeployGateEvidenceV2(e){
  if(e?.schemaVersion!=='curveyield-lite-phase0-deploy-config-execution-v3'||e.executionMode!=='ANVIL_FORK_PACKAGE_DEPLOY_CONFIG_ONLY')throw new Error('Invalid Phase 0 deploy evidence schema/mode');
  assertPhase0ForkIdentity(e);
  if(e.status==='PASS_LIVE_DEPLOYMENT'){
    const live=e.liveDeployment,rows=e.deployedContracts;
    if(e.deploymentProfile?.mode!=='LIVE'||live?.status!=='VERIFIED'||!Number.isSafeInteger(live.blockNumber)||!/^0x[0-9a-f]{64}$/i.test(live.blockHash??''))throw new Error('Missing pinned LIVE deployment identity');
    if(!/^[0-9a-f]{64}$/.test(e.sourceSha256??'')||!Array.isArray(rows)||!rows.length||rows.length!==e.deploymentProfile.contracts?.length||rows.length!==live.contracts?.length)throw new Error('Incomplete source-bound LIVE inventory');
    if(!Array.isArray(e.attempts)||e.attempts.length||!Array.isArray(e.scriptDispositions)||e.scriptDispositions.length)throw new Error('LIVE path must not execute deployment scripts');
    for(const row of rows){
      const exact=row.sourceBinding==='EXACT_COMPILED_RUNTIME'&&row.runtimeCodeHash===row.compiledRuntimeCodeHash;
      let metadataOnly=false;
      if(e.scanSourceSnapshot&&row.sourceBinding==='EXECUTABLE_RUNTIME_MATCH_METADATA_HASH_ONLY'&&row.runtimeComparison){
        const match=compareLiveRuntimeV1(row.runtimeComparison.observed,row.runtimeComparison.compiled,{allowScanMetadata:true});
        metadataOnly=match.sourceBinding===row.sourceBinding&&match.executableRuntimeSha256===row.executableRuntimeSha256&&
          JSON.stringify(match.metadataDifference)===JSON.stringify(row.metadataDifference)&&
          keccak256(row.runtimeComparison.observed)===row.runtimeCodeHash&&keccak256(row.runtimeComparison.compiled)===row.compiledRuntimeCodeHash&&
          digestV2(Buffer.from(row.runtimeComparison.observed.slice(2),'hex'))===row.runtimeSha256&&Boolean(row.sourceBindingLimitation);
      }
      if((!exact&&!metadataOnly)||!/^0x[0-9a-f]{64}$/i.test(row.runtimeCodeHash??'')||!e.deploymentProfile.contracts.some(x=>x.address.toLowerCase()===row.address?.toLowerCase()&&x.qualifiedName===row.qualifiedName))throw new Error('LIVE target runtime/source mismatch');
    }
    if(e.scanSourceSnapshot){
      const snapshot=e.scanSourceSnapshot,targets=snapshot.resolvedTargets??[];
      if(!/^0x[0-9a-f]{64}$/i.test(snapshot.frozenBlock?.hash??'')||snapshot.frozenBlock.number!==live.blockNumber||
        snapshot.frozenBlock.hash.toLowerCase()!==live.blockHash.toLowerCase()||snapshot.chainId!==e.fork.chainId||
        !/^[0-9a-f]{64}$/.test(snapshot.manifestDigestSha256??'')||
        !Array.isArray(targets)||targets.length!==rows.length||
        !Array.isArray(snapshot.requestedTargets)||!snapshot.requestedTargets.length)
        throw new Error('SCAN_SOURCE_SNAPSHOT_FORK_IDENTITY_MISMATCH');
      for(const target of targets){
        const observed=rows.find(row=>row.address?.toLowerCase()===target.address);
        if(!observed||observed.runtimeSha256!==target.runtimeSha256||
          observed.qualifiedName!==target.qualifiedName||observed.compilationUnitId!==target.compilationUnitId)
          throw new Error('SCAN_SOURCE_SNAPSHOT_TARGET_MISMATCH: '+target.address);
      }
      for(const address of snapshot.requestedTargets){
        if(!targets.some(target=>target.address===address&&target.role==='REQUESTED'))throw new Error('SCAN_REQUESTED_TARGET_MISSING: '+address);
      }
    }
    return true;
  }
  if(e.status==='NOT_APPLICABLE_NO_DEPLOYMENT_SCRIPT'){
    // No deployment script is a machine-discovered negative, never an agent
    // choice that can hide failed or unexecuted source-native deployment.
    if(!e.detectedScripts||!['foundry','hardhat','unsafeHardhat','genericPackageScripts'].every(key=>Array.isArray(e.detectedScripts[key])&&e.detectedScripts[key].length===0)
      ||!Array.isArray(e.scriptDispositions)||e.scriptDispositions.length
      ||!Array.isArray(e.attempts)||e.attempts.length
      ||!Array.isArray(e.deployedContracts)||e.deployedContracts.length
      ||e.coverage?.detectedScripts!==0||e.coverage?.requiredScripts!==0
      ||e.coverage?.executedScripts!==0||e.coverage?.failedOrUnsupportedScripts!==0)
      throw new Error('No-deployment-script waiver lacks complete zero-script machine inventory and coverage');
    if(!/^[0-9a-f]{64}$/.test(String(e.sourceSha256??'')))
      throw new Error('No-deployment-script waiver is not bound to an exact source');
    return true;
  }
  if(e.status!=='PASS'||!Array.isArray(e.attempts)||e.attempts.length<1||e.attempts.some(a=>a.status!=='PASS'||a.exitCode!==0))throw new Error('Source-native deployment attempt did not pass');
  const rows=e.scriptDispositions??[];
  if(!Array.isArray(rows)||!rows.length||new Set(rows.map(x=>x.scriptKey)).size!==rows.length)throw new Error('Missing or repeated script dispositions');
  const successes=rows.filter(x=>x.disposition==='EXECUTED_PASS');
  if(successes.length!==e.attempts.length)throw new Error('Source-native execution accounting mismatch');
  for(const a of e.attempts)if(!successes.some(x=>x.scriptKey===((a.framework==='GENERIC_NODE'?'GENERIC_NODE:'+a.script:a.framework+':'+a.path))))throw new Error('Unmatched passing native attempt');
  const skips=rows.filter(x=>x.disposition!=='EXECUTED_PASS');
  if(skips.some(x=>!EXCLUSIONS_V2.has(x.disposition)))throw new Error('Unsupported or failed required deployment scripts remain');
  const exclusions=e.reconciliation?.excludedScripts??[];
  if(skips.length!==exclusions.length)throw new Error('Excluded-script count mismatch');
  for(const s of skips){
    const matching=exclusions.filter(x=>x.scriptKey===s.scriptKey&&x.disposition===s.disposition&&typeof x.sourceSha256==='string'&&/^[0-9a-f]{64}$/.test(x.sourceSha256));
    if(matching.length!==1||s.exclusionRule!==matching[0].rule)throw new Error('Excluded script has no verified source witness: '+s.scriptKey);
  }
  if((e.gaps??[]).length||(e.limitations??[]).length)throw new Error('Unresolved deployment gaps remain');
  if(!Array.isArray(e.deployedContracts)||e.deployedContracts.length===0)throw new Error('No deployed-contract evidence');
  if(e.coverage?.failedOrUnsupportedScripts!==0||e.coverage?.executedScripts!==e.attempts.length||e.coverage?.excludedScripts!==skips.length||e.coverage?.detectedScripts!==rows.length)throw new Error('Incorrect deployment coverage');
  if(skips.length&&!/^[0-9a-f]{64}$/.test(e.reconciliation?.originalEvidenceSha256??''))throw new Error('No original-evidence digest');
  return true;
}
