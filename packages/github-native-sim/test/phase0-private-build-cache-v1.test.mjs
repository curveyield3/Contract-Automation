import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {privateBuildCacheIdentityV1,compileWithPrivateCacheV1,splitPrivateCompilationCacheV1} from '../src/phase0-private-build-cache-v1.mjs';

const sourceSha='a'.repeat(64),sourceCommit='b'.repeat(40),toolIdentity='c'.repeat(64);
const request={
  source:{repository:'curveyield3/Audit-Controller',commit:sourceCommit,archivePath:'campaigns/example/source/source.zip',archiveSha256:sourceSha},
  destination:{repository:'curveyield3/Audit-Controller',ref:'main',campaignPath:'campaigns/example'},
  campaignId:'example',campaignGenerationId:'generation-1'
};
const pseudo={source:{projectPath:'contracts',archiveSha256:sourceSha},
  configuration:{compilers:[{language:'solidity',version:'0.8.28'}],optimizer:{enabled:true,runs:200},evmVersion:'cancun',viaIR:false}};

test('private build cache key pins exact source, profile and compiler tools but not runner-specific absolute paths',()=>{
  const a=privateBuildCacheIdentityV1({request,pseudo,projectRoot:'/runner/source',toolIdentity});
  const same=privateBuildCacheIdentityV1({request,pseudo,projectRoot:'/runner/source',toolIdentity});
  assert.equal(a.key,same.key);
  assert.equal(a.key.length,64);
  assert.notEqual(a.key,privateBuildCacheIdentityV1({request:{...request,source:{...request.source,archiveSha256:'d'.repeat(64)}},pseudo,projectRoot:'/runner/source',toolIdentity}).key);
  assert.notEqual(a.key,privateBuildCacheIdentityV1({request,pseudo:{...pseudo,configuration:{...pseudo.configuration,viaIR:true}},projectRoot:'/runner/source',toolIdentity}).key);
  assert.notEqual(a.key,privateBuildCacheIdentityV1({request,pseudo,projectRoot:'/runner/source',toolIdentity:'d'.repeat(64)}).key);
  assert.equal(a.key,privateBuildCacheIdentityV1({request,pseudo,projectRoot:'/other/runner',toolIdentity}).key);
});

test('refuses missing exact source or build tool identity',()=>{
  assert.throws(()=>privateBuildCacheIdentityV1({request:{...request,source:{...request.source,archiveSha256:'unknown'}},pseudo,projectRoot:'/runner',toolIdentity}),/verified source digest/);
  assert.throws(()=>privateBuildCacheIdentityV1({request,pseudo,projectRoot:'/runner',toolIdentity:'unknown'}),/pinned compiler tool identity/);
});

test('untrusted or credential-less requests always execute the original compiler',async()=>{
  let builds=0;
  const compile=async()=>{builds++;return{status:'completed',artifacts:[]};};
  await compileWithPrivateCacheV1({request,pseudo,projectRoot:'/runner',enabled:false,token:'dummy',compile});
  await compileWithPrivateCacheV1({request,pseudo,projectRoot:'/runner',enabled:true,token:'',compile});
  assert.equal(builds,2);
});

test('primary only use private cache through exact intelligence stage',()=>{
  for(const name of ['lite-phase0-intelligence-v1.mjs']){
    const engine=fs.readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
    assert.match(engine,/compileWithPrivateCacheV1\(/);
  }
  for(const name of ['lite-phase0-intelligence-v1.yml']){
    const workflow=fs.readFileSync(new URL('../../../.github/workflows/'+name,import.meta.url),'utf8');
    assert.match(workflow,/PHASE0_PRIVATE_BUILD_CACHE_ENABLED/);
    assert.doesNotMatch(workflow,/actions\/cache.*PHASE0_VERIFIED_COMPILATION/);
  }
});

test('compilation outputs live only in an isolated folder on private Audit-Controller main',()=>{
  const source=fs.readFileSync(new URL('../src/phase0-private-build-cache-v1.mjs',import.meta.url),'utf8');
  assert.match(source,/PRIVATE_CACHE_ROOT = 'Phase0 Build Cache'/);
  assert.match(source,/PRIVATE_CACHE_REF = 'main'/);
  assert.match(source,/ref:PRIVATE_CACHE_REF/);
  assert.match(source,/PRIVATE_CACHE_ROOT/);
  assert.match(source,/const REPO='curveyield3\/Audit-Controller'/);
  assert.match(source,/git\/trees/);
  assert.match(source,/git\/blobs/);
  assert.match(source,/git\/refs\/heads/);
  assert.match(source,/force:false/);
  assert.match(source,/gzipSha256/);
  assert.match(source,/jsonSha256/);
  assert.doesNotMatch(source,/compressed compilation exceeds private cache size cap; skip storing/);
  assert.doesNotMatch(source,/phase0-verified-build-cache/);
  assert.doesNotMatch(source,/actions\/cache@/);
});

test('private cache shards arbitrarily large gzip bytes without losing payload',()=>{
  const original=Buffer.from('0123456789abcdef'.repeat(29));
  const pieces=splitPrivateCompilationCacheV1(original,37);
  assert.ok(pieces.length>3);
  assert.ok(pieces.every(x=>x.length<=37));
  assert.deepEqual(Buffer.concat(pieces),original);
});
test('compiler identity fingerprints hermetic compiler and exact runtime but not unrelated telemetry source trees',()=>{
  const code=fs.readFileSync(new URL('../src/phase0-private-build-cache-v1.mjs',import.meta.url),'utf8');
  assert.match(code,/HEAD:packages\/runner\/src\/hermetic-standard-json\.mjs/);
  assert.match(code,/HEAD:packages\/github-native-sim\/src\/execution\.mjs/);
  assert.doesNotMatch(code,/HEAD:packages\/runner\/src',/);
  assert.match(code,/COMPILATION_START/);
  assert.match(code,/COMPILATION_DONE/);
});
