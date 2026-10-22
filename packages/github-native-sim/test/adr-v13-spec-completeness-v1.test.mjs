import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {independentSpecItemsV13} from '../src/adr-independent-spec-v1.mjs';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v13-spec-completeness-'));
 const source=path.join(root,'campaigns/demo/source');
 fs.mkdirSync(path.join(source,'contracts'),{recursive:true});
 fs.writeFileSync(path.join(source,'contracts/Vault.sol'),
  'pragma solidity ^0.8.20;\ncontract Vault {\n// deposit permissions are validated\nfunction invest(uint256 amount) public {}\n}\n');
 const context={contextId:'CTX-1',path:'contracts/Vault.sol',lineStart:4,
  canonicalSignature:'invest(uint256)',kind:'FUNCTION'};
 const opts={root,campaignPath:'campaigns/demo',context,otherContexts:[]};
 return {root,source,opts};
}
test('v13 reads relevant ninth documentation file beyond four folder levels',()=>{
 const x=fixture();
 try{
  for(let i=1;i<=9;i++){
   const dir=i===9?path.join(x.source,'docs/a/b/c/d/e'):path.join(x.source,'docs');
   fs.mkdirSync(dir,{recursive:true});
   fs.writeFileSync(path.join(dir,'doc'+i+'.md'),
    i===9?'The invest method must check the owner before transferring assets.\n':
      'General notes with no matching function reference.\n');
  }
  const result=independentSpecItemsV13(x.opts);
  assert.equal(result.checkedDocCount,9);
  assert.ok(result.documentationItems.some(v=>v.rule.includes('invest method must')));
 }finally{fs.rmSync(x.root,{recursive:true,force:true});}
});
test('v13 refuses to silently skip oversized specification documents',()=>{
 const x=fixture();
 try{
  fs.writeFileSync(path.join(x.source,'README.md'),'z'.repeat(2*1024*1024+1));
  assert.throws(()=>independentSpecItemsV13(x.opts),/V13_SPEC_DOCUMENT_LIMIT/);
 }finally{fs.rmSync(x.root,{recursive:true,force:true});}
});
test('v13 refuses to discard the 25th relevant documentary rule',()=>{
 const x=fixture();
 try{
  for(let i=0;i<25;i++)
   fs.writeFileSync(path.join(x.source,'doc'+i+'.md'),
    'The invest method must check the correct role for protocol safety.\n');
  assert.throws(()=>independentSpecItemsV13(x.opts),/V13_SPEC_RULE_LIMIT/);
 }finally{fs.rmSync(x.root,{recursive:true,force:true});}
});
