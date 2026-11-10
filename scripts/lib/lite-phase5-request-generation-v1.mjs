import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {V2_AUTOMATION_RELEASE,V2_RUNNER_RELEASE} from '../../packages/github-native-sim/src/schema.mjs';
import {validateDeepAssuranceRequestWithV26V1} from '../../packages/github-native-sim/src/schema-v26.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const PLACEHOLDER=/<\s*(?:REQUIRED(?:_[A-Z0-9]+)*|PENDING(?:_[A-Z0-9]+)*|CONTROLLER(?:_[A-Z0-9]+)*|TODO|TBD|PLACEHOLDER(?:_[A-Z0-9]+)*|INSERT(?:_[A-Z0-9]+)*)\s*>|\b(?:TODO|TBD)\b/i;
const nonempty=x=>typeof x==='string'&&x.trim()&&!PLACEHOLDER.test(x);
const complete=x=>Array.isArray(x)?x.length>0&&x.every(complete):nonempty(x);
const noPlaceholders=x=>{
 if(typeof x==='string')return !PLACEHOLDER.test(x);
 if(Array.isArray(x))return x.every(noPlaceholders);
 if(x&&typeof x==='object')return Object.values(x).every(noPlaceholders);
 return true;
};
const okPath=x=>nonempty(x)&&!x.startsWith('/')&&!x.split('/').some(y=>!y||y==='.'||y==='..');
const validType=new Set(['ANVIL_WORKFLOW','FOUNDRY_TEST','MEDUSA_PROPERTY']);

export function generateV7ExecutionRequestV1({campaignId,campaignGenerationId,sourceSha256,phase0Source,target,automationRoot}={}){
 const missing=[],key=String(target?.candidateKey??'').trim(),type=target?.reproductionType;
 const need=(field,valid,reason='required')=>{if(!valid)missing.push({field,reason});};
 need('candidateKey',nonempty(key));
 need('reproductionType',validType.has(type),'must be ANVIL_WORKFLOW, FOUNDRY_TEST or MEDUSA_PROPERTY');
 need('setup',nonempty(target?.setup));
 need('prerequisites',complete(target?.prerequisites));
 need('transactionSequence',complete(target?.transactionSequence));
 need('oracle',nonempty(target?.oracle));
 need('fuzzVariablesAndBounds',complete(target?.fuzzVariablesAndBounds));
 need('snapshotReuseSafety',nonempty(target?.snapshotReuseSafety));
 need('expectedSecurityProperty',nonempty(target?.expectedSecurityProperty));
 need('expectedMachineObservation',target?.expectedMachineObservation&&
   typeof target.expectedMachineObservation==='object'&&!Array.isArray(target.expectedMachineObservation)&&noPlaceholders(target.expectedMachineObservation));
 const observation=target?.expectedMachineObservation;
 if(observation&&Object.prototype.hasOwnProperty.call(observation,'candidateId'))
  need('expectedMachineObservation.candidateId',observation.candidateId===key,
    'must match the candidateKey; candidate identity is carried by the reproduction metadata');
 const blueprint=target?.executionBlueprint;
 let resolvedGenerationHarnessId=null;
 let resolvedNativeFuzzMatchTest=null;
 need('executionBlueprint',blueprint&&typeof blueprint==='object'&&!Array.isArray(blueprint),
   'provide concrete trusted runner configuration: exact source root, compiler, harness/simulation');
 if(blueprint){
  need('executionBlueprint.projectPath',okPath(blueprint.projectPath));
  need('executionBlueprint.configuration',blueprint.configuration&&typeof blueprint.configuration==='object'&&!Array.isArray(blueprint.configuration));
  need('executionBlueprint.configuration.compilers',Array.isArray(blueprint.configuration?.compilers)&&blueprint.configuration.compilers.length>0);
  need('executionBlueprint.configuration',noPlaceholders(blueprint.configuration),'placeholder values are forbidden');
  // No arbitrary native-fuzz budget is required for source-bound Anvil
  // reproductions. Require a concrete analysis adapter only when the reviewer
  // explicitly selects that method; V7 schema validates opt-in fuzz budgets.
  if(type==='FOUNDRY_TEST'){
    need('executionBlueprint.configuration.analysis.nativeFuzz.enabled',
      blueprint.configuration?.analysis?.nativeFuzz?.enabled===true,
      'FOUNDRY_TEST must explicitly enable the Foundry execution adapter');

  }
  if(type==='MEDUSA_PROPERTY'){
    need('executionBlueprint.configuration.analysis.medusa',
      blueprint.configuration?.analysis?.medusa!==undefined&&blueprint.configuration?.analysis?.medusa!==false,
      'MEDUSA_PROPERTY must explicitly enable the Medusa execution adapter');
    need('executionBlueprint.configuration.analysis.medusa.targetProperty',
      /^(?:property_|invariant_|echidna_)[A-Za-z0-9_]+$/.test(blueprint.configuration?.analysis?.medusa?.targetProperty??''),
      'an agent-selected property and exclusive Medusa test prefix are required');
  }
  if(type==='ANVIL_WORKFLOW'){
    need('executionBlueprint.configuration.simulation',!!blueprint.configuration?.simulation);
    need('executionBlueprint.configuration.deploymentGas',!!blueprint.configuration?.deploymentGas);
  }else {
    need('executionBlueprint.configuration.harness',!!blueprint.configuration?.harness,
      'exact runner-owned harness/recipe required; prose test designs are not executable');
    need('executionBlueprint.configuration.harness.bundleId',
      nonempty(blueprint.configuration?.harness?.bundleId),
      'require an existing audited harness bundle ID, not a placeholder');
    if(automationRoot&&nonempty(blueprint.configuration?.harness?.bundleId)){
      const id=blueprint.configuration.harness.bundleId;
      const base=/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)
        ?path.resolve(automationRoot,'packages/github-native-sim/audit-harnesses',id):null;
      const ready=base&&fs.existsSync(base)&&fs.statSync(base).isDirectory()&&
        ['medusa.json','foundry.toml'].every(name=>fs.existsSync(path.join(base,name)));
      need('executionBlueprint.configuration.harness.bundleId',ready,
        'bundle must exist in the trusted runner overlay registry with medusa.json and foundry.toml');
      if(ready){
        try{
          const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));
          if(Boolean(campaignGenerationId) &&
             manifest.campaignId===campaignId &&
             manifest.campaignGenerationId===campaignGenerationId){
            resolvedGenerationHarnessId=id;
          }else{
            // Never automatically reuse historical test bytes. A previous,
            // source-bound harness is eligible only when an operator has
            // installed a separate, byte-identical fork explicitly stamped
            // for THIS campaign generation; the old bundle stays untouched.
            const forkId=id+'-g'+hash(campaignGenerationId??'').slice(0,16);
            const forkBase=path.resolve(automationRoot,'packages/github-native-sim/audit-harnesses',forkId);
            let verified=false;
            try{
              if(campaignGenerationId && fs.statSync(forkBase).isDirectory()){
                const fork=JSON.parse(fs.readFileSync(path.join(forkBase,'manifest.json'),'utf8'));
                const origin=manifest.sourceBinding??{};
                const binding=fork.sourceBinding??{};
                const files=manifest.files??[];
                const safeFile=f=>typeof f?.source==='string'&&
                  !f.source.startsWith('/')&&
                  !f.source.split('/').some(part=>!part||part==='.'||part==='..');
                verified=fork.bundleId===forkId &&
                  fork.derivedFromBundleId===id &&
                  fork.campaignId===campaignId &&
                  fork.campaignGenerationId===campaignGenerationId &&
                  origin.archiveSha256===sourceSha256 &&
                  origin.repository===phase0Source?.archiveRepository &&
                  origin.commit===phase0Source?.archiveCommit &&
                  JSON.stringify(binding)===JSON.stringify(origin) &&
                  Array.isArray(files)&&files.length>0 &&
                  JSON.stringify(fork.files)===JSON.stringify(files) &&
                  files.every(f=>safeFile(f)&&
                    fs.readFileSync(path.join(base,f.source))
                      .equals(fs.readFileSync(path.join(forkBase,f.source))));
              }
            }catch{verified=false;}
            need('executionBlueprint.configuration.harness.campaignGenerationId',verified,
              'harness requires an independently copied, source-verified, exact-generation bundle; legacy bundles cannot run directly');
            if(verified)resolvedGenerationHarnessId=forkId;
          }
        }catch(error){
          need('executionBlueprint.configuration.harness.manifest',false,
            'generation-bound harness manifest unavailable: '+String(error.message||error));
        }
      }
    }
  }
  // A generation-specific audited harness may explicitly select existing named
  // source test methods when an older accepted target did not store matchTest.
  // Selection is a pure copy from a source-verified bound manifest, never a
  // discovery of tests from a previous campaign or execution of arbitrary fuzz.
  if(type==='FOUNDRY_TEST'&&resolvedGenerationHarnessId&&
     !blueprint.configuration?.analysis?.nativeFuzz?.matchTest){
    try{
      const dir=path.resolve(automationRoot,'packages/github-native-sim/audit-harnesses',resolvedGenerationHarnessId);
      const bound=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
      const selected=bound.testSelections?.[key];
      const name=selected?.matchTest,sourceFile=selected?.sourceFile;
      if(bound.campaignId===campaignId&&bound.campaignGenerationId===campaignGenerationId&&
         bound.sourceBinding?.archiveSha256===sourceSha256&&
         /^[A-Za-z_][A-Za-z0-9_]*$/.test(name??'')&&
         typeof sourceFile==='string'&&!sourceFile.startsWith('/')&&
         !sourceFile.split('/').some(x=>!x||x==='.'||x==='..')&&
         bound.files?.some(f=>f.source===sourceFile)&&Array.isArray(selected.matchedTestNames)){
        const text=fs.readFileSync(path.join(dir,sourceFile),'utf8');
        const names=[...text.matchAll(/\\bfunction\\s+(test[A-Za-z0-9_]+)\\s*\\(/g)]
          .map(x=>x[1]).filter(x=>x.startsWith(name)).sort();
        const expected=[...selected.matchedTestNames].sort();
        if(names.length>0&&JSON.stringify(names)===JSON.stringify(expected))
          resolvedNativeFuzzMatchTest=name;
      }
    }catch{}
  }
  if(type==='FOUNDRY_TEST'){
    const match=blueprint.configuration?.analysis?.nativeFuzz?.matchTest??resolvedNativeFuzzMatchTest;
    need('executionBlueprint.configuration.analysis.nativeFuzz.matchTest',
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(match??''),
      'an exact generation-bound, agent-selected existing test name is required; automatic fuzz/invariant runs are disabled');
  }
 }
 need('phase0Source.archiveRepository',nonempty(phase0Source?.archiveRepository));
 need('phase0Source.archiveCommit',/^[0-9a-f]{40}$/.test(phase0Source?.archiveCommit??''));
 need('phase0Source.archivePath',okPath(phase0Source?.archivePath));
 need('sourceSha256',/^[0-9a-f]{64}$/.test(sourceSha256??''));
 need('phase0Source.sha256',phase0Source?.sha256===sourceSha256,'must match the exact frozen source digest');
 if(blueprint?.usePhase0ForkState===true){
   need('executionBlueprint.usePhase0ForkState',type==='ANVIL_WORKFLOW',
     'Phase-0 state reuse is only supported for Anvil workflows');
   const reuse=phase0Source?.reusableForkState;
   need('executionBlueprint.configuration.harness.recipeId',
     blueprint.configuration?.harness?.recipeId==='phase0-snapshot-targeted-v1',
     'verified Phase-0 state requires the dedicated non-redeployment targeted-test recipe');
   need('executionBlueprint.configuration.evmVersion',
     String(blueprint.configuration?.evmVersion??'').toLowerCase()===String(reuse?.hardfork??'').toLowerCase(),
     'must equal retained Anvil state hardfork');
   need('executionBlueprint.configuration.simulation.block',
     Number.isSafeInteger(blueprint.configuration?.simulation?.block)&&
     blueprint.configuration.simulation.block===reuse?.finalBlock,
     'must equal the exact retained post-deployment state block');
   need('phase0Source.reusableForkState',reuse?.status==='CAPTURED'&&
     reuse?.sourceSha256===sourceSha256&&reuse?.campaignId===campaignId,
     'no exact source/campaign bound reusable Phase-0 state is available');
 }

 if(blueprint?.projectPath&&phase0Source?.extractedContentPath)
   need('executionBlueprint.projectPath',
     blueprint.projectPath===phase0Source.extractedContentPath||
     blueprint.projectPath.startsWith(phase0Source.extractedContentPath+'/'),
     'must be under exact Phase-0 extracted source tree');
 if(missing.length)return {status:'REWORK_REQUIRED',candidateKey:key,missing};
 const phaseId=type==='ANVIL_WORKFLOW'?'fork-simulation-lifecycle':'build-and-test';
 const source={repository:phase0Source.archiveRepository,commit:phase0Source.archiveCommit,
   archivePath:phase0Source.archivePath,archiveSha256:sourceSha256,
   projectPath:blueprint.projectPath};
 const machineObservation=structuredClone(target.expectedMachineObservation);
 // Candidate identity belongs in metadata; the machine observation schema is
 // type-specific and correctly excludes redundant candidateId.
 delete machineObservation.candidateId;
 const configuration=structuredClone(blueprint.configuration);
 if(resolvedGenerationHarnessId && configuration.harness)
   configuration.harness.bundleId=resolvedGenerationHarnessId;
 if(resolvedNativeFuzzMatchTest&&configuration.analysis?.nativeFuzz)
   configuration.analysis.nativeFuzz.matchTest=resolvedNativeFuzzMatchTest;
 // Preserve test intent in a non-executable, controller-owned sidecar emitted
 // with the machine request; the V7 configuration schema forbids arbitrary fields.
 const designEvidence={setup:target.setup,prerequisites:target.prerequisites,
   transactionSequence:target.transactionSequence,oracle:target.oracle,
   fuzzVariablesAndBounds:target.fuzzVariablesAndBounds,
   snapshotReuseSafety:target.snapshotReuseSafety,
   expectedSecurityProperty:target.expectedSecurityProperty};
 if(configuration.v26?.phase0ForkState)delete configuration.v26.phase0ForkState;
 configuration.v26={...(configuration.v26??{}),reproduction:{
   candidateId:key,reproductionType:type,expectedObservation:machineObservation
 }};
 if(blueprint.usePhase0ForkState===true){
   const reuse=phase0Source.reusableForkState;
   configuration.v26.phase0ForkState={
     manifestRef:reuse.manifestRef,sha256:reuse.sha256,
     sourceSha256:reuse.sourceSha256,campaignId:reuse.campaignId,
     chainId:reuse.chainId,finalBlock:reuse.finalBlock,hardfork:reuse.hardfork
   };
 }
 // Bind machine identity to the exact campaign generation, independently of
 // an earlier campaign's source, request or harness bundle.
 const generationKey=campaignGenerationId ? hash(campaignGenerationId).slice(0,24) : null;
 const candidateKeyHash=hash(key).slice(0,24);
 const basis={campaignId,campaignGenerationId:campaignGenerationId??null,candidateKey:key,source,configuration,phaseId};
 const id=hash(basis);
 const request={schemaVersion:'deep-assurance-github-request-v2',
   processId:'audit-v7-independent-review',
   contractAutomationRelease:V2_AUTOMATION_RELEASE,runnerRelease:V2_RUNNER_RELEASE,
   campaignId,assignmentId:generationKey
     ? `phase-05-g${generationKey}-c${candidateKeyHash}` : 'phase5-target-'+key,
   phaseId,gateId:'phase5-target-execution',
   profileId:'github-native-simulate-v2',source,configuration,
   requestId:'dar-'+id.slice(0,32),requestDigest:id};
 try{validateDeepAssuranceRequestWithV26V1(request);}
 catch(error){
   const detail=String(error?.message??error),attribute=detail.match(/configuration\\.[a-zA-Z0-9_.\\[\\]]+/)?.[0];
   return {status:'REWORK_REQUIRED',candidateKey:key,
     missing:[{field:attribute?('executionBlueprint.'+attribute):'executionBlueprint.configuration',reason:detail}]};
 }
 return {status:'GENERATED',candidateKey:key,request,designEvidence};
}
