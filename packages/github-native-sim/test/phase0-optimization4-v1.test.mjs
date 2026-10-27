import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { needsPackageRuntimeDependenciesV1 as primaryRequiresNode } from '../src/phase0-randomized-simulation-v1.mjs';

const root=process.cwd();
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

for(const [label,requiresNode] of [['primary',primaryRequiresNode]]){
  test(label+' only installs source-project runtime dependencies for admitted Node deployments',()=>{
    assert.equal(requiresNode({foundry:[{entry:'script/Deploy.s.sol'}],hardhat:[],genericPackageScripts:[]}),false);
    assert.equal(requiresNode({hardhat:[],unsafeHardhat:[{path:'scripts/unsafe.js'}],genericPackageScripts:[]}),false);
    assert.equal(requiresNode({hardhat:[],genericPackageScripts:[{name:'deploy',safe:false}]}),false);
    assert.equal(requiresNode({hardhat:[{path:'scripts/deploy.js'}],genericPackageScripts:[]}),true);
    assert.equal(requiresNode({hardhat:[],genericPackageScripts:[{name:'deploy',safe:true}]}),true);
    assert.equal(requiresNode({}),false);
  });
}

for(const [mode,file] of [
  ['primary','packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs'],
]){
  test(mode+' preserves exact archive, installation lock and retained evidence while skipping unneeded installs',()=>{
    const source=read(file);
    const detection='const detected=await detectDeploymentScripts(staged.projectRoot)';
    const installation='const packageDependencyInstall=await installPackageRuntimeDependenciesV1(staged.projectRoot,detected)';
    assert.ok(source.indexOf(detection)>0 && source.indexOf(detection)<source.indexOf(installation));
    assert.equal(source.split(detection).length-1,1,'deployment scripts should be detected once');
    assert.match(source,/stageExactArchiveSource\(\{checkoutRoot:controllerRoot/);
    assert.match(source,/PACKAGE_LOCK_REQUIRED_FOR_SIMULATION_TESTING/);
    assert.match(source,/NO_RUNNABLE_NODE_DEPLOYMENT_SCRIPTS/);
    assert.match(source,/args:\['240s','npm','ci','--ignore-scripts','--prefer-offline','--audit=false','--fund=false'\]/);
    assert.match(source,/SIMULATION_TESTING_PACKAGE_DEPENDENCY_INSTALL_FAILED/);
    assert.match(source,/packageDependencyInstall,foundryDependencyInstall,policy:/);
    assert.match(source,/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json/);
    assert.match(source,/executeDeploymentScripts/);
  });
}

test('one-ref private Git checkout helper is shallow, authenticated, and commit verified',()=>{
  const shell=read('scripts/checkout-audit-controller-once-v1.sh');
  assert.match(shell,/^#!/);
  assert.match(shell,/checkout --quiet --detach FETCH_HEAD/);
  assert.match(shell,/checkout --quiet -B "\$ref" FETCH_HEAD/);
  assert.match(shell,/git -C "\$destination" fetch --no-tags --depth=1 --filter=blob:none origin "\$ref"/);
  assert.match(shell,/test "\$\(git -C "\$destination" rev-parse HEAD\)" = "\$expected"/);
  assert.match(shell,/GH_TOKEN/);
  assert.doesNotMatch(shell,/gh repo clone/);
  assert.doesNotMatch(shell,/actions\/upload-artifact/);
});

for(const wf of [
  '.github/workflows/lite-phase0-randomized-simulation-v1.yml',
  '.github/workflows/lite-phase0-bootstrap-v1.yml',
]){
  test(wf+' uses one checked private repository fetch per job',()=>{
    const src=read(wf);
    assert.match(src,/bash scripts\/checkout-audit-controller-once-v1.sh/);
    assert.doesNotMatch(src,/gh repo clone curveyield3\/Audit-Controller/);
    assert.doesNotMatch(src,/git checkout -B "\$AUDIT_CONTROLLER_REF" "origin\/\$AUDIT_CONTROLLER_REF"/);
  });
}

for(const wf of [
  '.github/workflows/lite-phase0-intelligence-v1.yml',
]){
  test(wf+' reuses exact previously verified source checkout when publishing',()=>{
    const src=read(wf);
    assert.match(src,/verified_checkout=\.phase0-intelligence-output\/work\/source-repo/);
    assert.match(src,/test "\$\(git -C "\$verified_checkout" rev-parse HEAD\)" = "\$source_commit"/);
    assert.match(src,/mv "\$verified_checkout" \.audit-controller-output/);
    assert.match(src,/git -C \.audit-controller-output fetch --no-tags --depth=1 --filter=blob:none origin "\$destination_ref"/);
    assert.match(src,/test "\$\(git -C \.audit-controller-output rev-parse HEAD\)" = "\$expected_destination"/);
    assert.match(src,/git push origin "HEAD:\$destination_ref"/);
  });
}
