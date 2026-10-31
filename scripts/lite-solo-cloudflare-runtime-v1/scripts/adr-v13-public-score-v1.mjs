#!/usr/bin/env node
// Produce the only public qualification evidence allowed in Contract-Automation.
// The rich private case analysis remains off-repo and is never echoed to CI.
import fs from 'node:fs';
import path from 'node:path';
import {publicV13QualificationScoreV1} from '../packages/github-native-sim/src/adr-v13-release-gate-v1.mjs';

export function preparePublicV13ScoreV1(privateReportFile,outFile){
 if(!path.isAbsolute(privateReportFile??'')||!path.isAbsolute(outFile??'')||
   privateReportFile===outFile)
   throw new Error('private input and distinct public output must be absolute paths');
 const report=JSON.parse(fs.readFileSync(privateReportFile,'utf8'));
 const release=publicV13QualificationScoreV1(report);
 fs.mkdirSync(path.dirname(outFile),{recursive:true});
 const text=JSON.stringify(release,null,2)+'\n';
 fs.writeFileSync(outFile,text,{mode:0o600});
 return release;
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 try{
  const output=preparePublicV13ScoreV1(process.argv[2],process.argv[3]);
  process.stdout.write('QUALIFICATION_PUBLIC_SCORE_READY caught='+output.caught+' of 41; no private case data published\n');
 }catch(error){
  process.stderr.write('PUBLIC_SCORE_REFUSED: private qualification incomplete or invalid\n');
  process.exitCode=1;
 }
}
