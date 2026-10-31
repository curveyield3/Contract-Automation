#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadFrozenAuthorityRegistryV1,inspectFrozenAuthorityV1} from '../packages/github-native-sim/src/adr-frozen-authority-v1.mjs';

function sha(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function listFiles(dir,prefix=''){
  const result=[];
  for(const dirent of fs.readdirSync(dir,{withFileTypes:true})){
    const rel=prefix?prefix+'/'+dirent.name:dirent.name;
    if(dirent.isDirectory())result.push(...listFiles(path.join(dir,dirent.name),rel));
    else if(dirent.isFile())result.push(rel);
    else throw new Error('non-file frozen authority entry: '+rel);
  }
  return result;
}
function run(){
  const i=process.argv.indexOf('--controller-root');
  if(i<0||!process.argv[i+1])throw new Error('usage: node scripts/adr-check-frozen-authorities-v1.mjs --controller-root <dir>');
  const root=path.resolve(process.argv[i+1]);
  const registry=loadFrozenAuthorityRegistryV1(root);
  const problems=[];
  for(const entry of registry.entries){
    const frozenRoot=path.join(root,...entry.frozenRoot.split('/'));
    const skill=path.join(frozenRoot,'SKILL.md'),manifest=path.join(frozenRoot,'MANIFEST.json');
    const actualSkill=fs.existsSync(skill)?sha(skill):'MISSING';
    const actualManifest=fs.existsSync(manifest)?sha(manifest):'MISSING';
    console.log(entry.release+' skillSha256='+actualSkill+' manifestSha256='+actualManifest);
    if(actualSkill!==entry.skillSha256)problems.push(entry.release+' SKILL.md expected='+entry.skillSha256+' actual='+actualSkill);
    if(actualManifest!==entry.manifestSha256)problems.push(entry.release+' MANIFEST.json expected='+entry.manifestSha256+' actual='+actualManifest);
    try{
      const {seen}=inspectFrozenAuthorityV1(root,entry);
      for(const file of listFiles(frozenRoot)){
        if(file!=='MANIFEST.json'&&!seen.has(file))problems.push(entry.release+' unlisted frozen file '+file);
      }
    }catch(error){problems.push(entry.release+' '+String(error.message??error));}
  }
  if(problems.length){for(const p of problems)console.error('::error::'+p);process.exitCode=1;}
  else console.log('All frozen authority entries verified: '+registry.entries.length);
}
run();
