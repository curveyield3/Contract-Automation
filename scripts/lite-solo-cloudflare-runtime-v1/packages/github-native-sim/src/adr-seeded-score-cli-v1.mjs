#!/usr/bin/env node
// Private local/CI scoring. The sealed truth manifest is never copied into a
// campaign, packet, wake, shard, controller output or GitHub Actions artifact.
// Provide its absolute, externally mounted path via PRIVATE_SEEDED_TRUTH_FILE.
import fs from 'node:fs';
import path from 'node:path';
import {scoreSeededCampaignV1} from './adr-detection-qualification-v1.mjs';
import {sourceBoundAutoAdjudicationsV13} from './adr-private-source-match-v1.mjs';

export function scoreFilesV1({privateManifestPath,findingsPath,adjudicationsPath,partialPath=null,leakStagesPath=null}){
  if(!path.isAbsolute(privateManifestPath??''))
    throw new Error('PRIVATE_SEEDED_TRUTH_FILE must be an absolute private path');
  if(!fs.existsSync(privateManifestPath))throw new Error('private truth manifest unavailable');
  const parse=f=>JSON.parse(fs.readFileSync(f,'utf8'));
  const manifest=parse(privateManifestPath);
  if(manifest?.schemaVersion!=='curveyield-private-seeded-truth-v1')throw new Error('invalid private manifest schema');
  const truth=manifest.cases;
  if(!Array.isArray(truth))throw new Error('private manifest cases must be an array');
  const findings=parse(findingsPath);
  const auto=adjudicationsPath==='AUTO_PRIVATE_SOURCE_MATCH';
  const matched=auto?sourceBoundAutoAdjudicationsV13({truth,findings}):null;
  const adjudications=auto?matched.adjudications:parse(adjudicationsPath);
  const partialCases=partialPath?parse(partialPath):[];
  const missStageByCase=leakStagesPath?parse(leakStagesPath):
    Object.fromEntries(truth.filter(x=>x.kind==='defect').map(x=>[
      x.caseId,typeof x.leakStage==='string'&&x.leakStage.trim()?
        x.leakStage.trim():'UNCLASSIFIED'
    ]));
  const result=scoreSeededCampaignV1({truth,findings:auto?matched.findings:findings,
    adjudications,partialCases,missStageByCase,
    expectedDefects:manifest.expectedDefects??41,baselineCaught:manifest.baselineCaught??14,
    minCaught:manifest.minCaught??30});
  // No raw labels, literal truth, source paths, full findings, or manifest identity in output.
  return {
    schemaVersion:result.schemaVersion,defectCount:result.defectCount,
    caught:result.caught,partial:result.partial,missed:result.missed,
    decoysFlagged:result.decoysFlagged,
    cleanControlCriticalHighFalsePositiveCount:result.cleanControlCriticalHighFalsePositiveCount,
    bySeverity:result.bySeverity,byClassId:result.byClassId,byContract:result.byContract,
    leakStageCounts:Object.fromEntries(Object.entries(result.byLeakStage).map(([key,ids])=>[key,ids.length])),
    criticalHighMissCount:result.criticalHighMisses.length,
    ...(auto?{sourceMatchMode:'PRIVATE_SOURCE_BOUND_AUTO',ambiguousCount:matched.ambiguous.length}:{}),
    gate:result.gate
  };
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  try{
    const [findingsPath,adjudicationsPath,partialPath,leakStagesPath]=process.argv.slice(2);
    if(!findingsPath||!adjudicationsPath)
      throw new Error('usage: node adr-seeded-score-cli-v1.mjs FINDINGS_JSON AUTO_PRIVATE_SOURCE_MATCH [PARTIAL_JSON] [LEAK_STAGE_JSON]');
    const result=scoreFilesV1({privateManifestPath:process.env.PRIVATE_SEEDED_TRUTH_FILE,
      findingsPath,adjudicationsPath,partialPath,leakStagesPath});
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.gate.passed)process.exitCode=2;
  }catch(error){
    process.stderr.write('PRIVATE_SEEDED_QUALIFICATION_FAILED: '+String(error?.message??error).replaceAll(
      String(process.env.PRIVATE_SEEDED_TRUTH_FILE??'__never__'),'<private>')+'\n');
    process.exitCode=3;
  }
}
