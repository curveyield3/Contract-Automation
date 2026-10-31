#!/usr/bin/env node
// Strictly private CI step. Do not echo truth IDs, fragments, paths or labels.
import fs from 'node:fs';
import path from 'node:path';
const skip=new Set(['.git','node_modules','vendor','lib','out','dist','artifacts','.audit-hermetic-build']);
const extensions=/\.(?:json|md|mjs|js|ts|sh|txt|yml|yaml)$/i;
export function scanV13AnswerKeyLeakV1({manifest,roots=[]}={}){
 if(manifest?.schemaVersion!=='curveyield-private-seeded-truth-v1'||!Array.isArray(manifest.cases))
  throw Error('strict private manifest required for leakage check');
 const marks=new Set();
 for(const row of manifest.cases){
  for(const value of [row.caseId,row.secretMarker,row.privateLabel,row.answerMarker,
   ...(Array.isArray(row.hiddenMarkers)?row.hiddenMarkers:[])]){
   if(typeof value==='string'&&value.trim().length>=7)marks.add(value.trim());
  }
 }
 if(!marks.size)throw Error('private manifest supplies no unique leak markers');
 let filesScanned=0,hits=0;
 function scan(dir){
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
   if(skip.has(item.name))continue;
   const file=path.join(dir,item.name);
   if(item.isDirectory()){scan(file);continue;}
   if(!item.isFile()||!extensions.test(item.name)||fs.statSync(file).size>2*1024*1024)continue;
   filesScanned++;
   const contents=fs.readFileSync(file,'utf8');
   for(const mark of marks)if(contents.includes(mark)){hits++;break;}
  }
 }
 for(const root of roots){if(!path.isAbsolute(root)||!fs.existsSync(root))
   throw Error('explicit existing absolute agent-readable root required');
  scan(root);
 }
 return {schemaVersion:'curveyield-private-answer-leak-sweep-v1',status:hits?'FAIL':'PASS',
  filesScanned,leakingFileCount:hits,hiddenMarkersCount:marks.size,
  // No secret strings, case IDs or matching paths leave the private job.
  safeToPublish:hits===0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 try{
  const secret=process.env.PRIVATE_SEEDED_TRUTH_FILE;
  if(!path.isAbsolute(secret??'')||!fs.existsSync(secret))throw Error('PRIVATE_SEEDED_TRUTH_FILE absent');
  const result=scanV13AnswerKeyLeakV1({
   manifest:JSON.parse(fs.readFileSync(secret,'utf8')),roots:process.argv.slice(2)});
  process.stdout.write(JSON.stringify(result)+'\n');
  if(!result.safeToPublish)process.exitCode=2;
 }catch{process.stderr.write('PRIVATE_ANSWER_KEY_LEAK_SWEEP_BLOCKED\n');process.exitCode=3;}
}
