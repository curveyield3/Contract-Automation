import { runProcess } from './execution.mjs';
import { digestCanonicalV1 } from './canonical-json-v1.mjs';

function parseMetric(cell){
  const m=String(cell??'').match(/([0-9.]+)%\s*\((\d+)\/(\d+)\)/); if(!m) return {status:'UNAVAILABLE'};
  return {hit:Number(m[2]),total:Number(m[3]),percent:Number(m[1])};
}
function cleanCell(s){ return String(s??'').trim(); }
export function parseFoundryCoverageSummaryV1(output){
  const rows=[]; for(const line of String(output??'').split(/\r?\n/)){
    if(!line.includes('|')) continue; const cells=line.split('|').slice(1,-1).map(cleanCell); if(cells.length<5||cells[0]==='File'||/^[-: ]+$/.test(cells[0])) continue;
    rows.push({path:cells[0],lines:parseMetric(cells[1]),statements:parseMetric(cells[2]),branches:parseMetric(cells[3]),functions:parseMetric(cells[4])});
  }
  const total=rows.find(r=>r.path.toLowerCase()==='total'); const files=rows.filter(r=>r!==total).sort((a,b)=>a.path.localeCompare(b.path));
  if(!total) throw new Error('Foundry coverage summary missing Total row');
  return {totals:{lines:total.lines,statements:total.statements,branches:total.branches,functions:total.functions},files};
}

export function evaluateFoundryCoverageObligationsV1(metrics,obligations=[]){
  const failures=[]; for(const o of obligations){
    if(o.type==='FILE_PRESENT') { if(!(metrics.files??[]).some(f=>f.path===o.path)) failures.push({...o,reason:'file absent from coverage'}); }
    else if(o.type==='MINIMUM_METRIC') { const m=metrics.totals?.[o.metric]; if(!m||m.status==='UNAVAILABLE'||typeof m.percent!=='number'||m.percent<o.minimumPercent) failures.push({...o,observed:m?.percent??null}); }
    else if(o.type==='FUNCTION_COVERED') { const file=(metrics.files??[]).find(f=>f.path===o.source); if(!file||!Array.isArray(file.functionsCovered)||!file.functionsCovered.includes(o.function)) failures.push({...o,reason:'function-level coverage unavailable or not covered'}); }
    else failures.push({...o,reason:'unsupported coverage obligation'});
  }
  return {status:failures.length?'FAIL':'PASS',failures};
}

export async function runFoundryCoverageV1({projectRoot,sourceCommit,rpcUrl,blockNumber,blockHash=null,rpcProfile='SIM_ARCHIVE_PRIMARY_ETHEREUM_01',environment={},rawArtifactRef,runCommand=runProcess}){
  if(typeof runCommand!=='function') throw new Error('runCommand is required');
  if(typeof rpcUrl!=='string'||!rpcUrl) throw new Error('rpcUrl is required');
  const result=await runCommand({command:'forge',args:['coverage','--report','summary','--fork-url',rpcUrl,'--fork-block-number',String(blockNumber)],cwd:projectRoot,env:environment});
  const fork={blockNumber,blockHash,profile:rpcProfile,rpcUrlExposed:false};
  if(!result||result.exitCode!==0) return {schemaVersion:'audit-v7-foundry-coverage-v1',status:'COVERAGE_EXECUTION_FAILURE',sourceCommit,fork,totals:{},files:[],rawArtifactRef,rawOutput:{exitCode:result?.exitCode??-1,stdout:String(result?.stdout??'').replaceAll(rpcUrl,'<redacted-rpc>'),stderr:String(result?.stderr??'').replaceAll(rpcUrl,'<redacted-rpc>')}};
  try { const parsed=parseFoundryCoverageSummaryV1(result.stdout); return {schemaVersion:'audit-v7-foundry-coverage-v1',status:'PASS',sourceCommit,fork,...parsed,rawArtifactRef}; }
  catch(error){ return {schemaVersion:'audit-v7-foundry-coverage-v1',status:'COVERAGE_PARSE_FAILURE',sourceCommit,fork,totals:{},files:[],rawArtifactRef,error:{message:error.message}}; }
}

export function buildFoundryCampaignReceiptV1(input,{refinementRequired=true}={}){
  const receipt={schemaVersion:'audit-v7-foundry-campaign-receipt-v1',runId:input.runId,engine:'foundry',runType:input.runType,refinementOf:input.refinementOf??null,basisEvidenceIds:[...(input.basisEvidenceIds??[])],harnessBundleDigest:input.harnessBundleDigest,configurationDigest:input.configurationDigest,testResult:structuredClone(input.testResult),coverageResult:structuredClone(input.coverageResult),authoritativeFinding:false};
  receipt.refinementSatisfied=!refinementRequired||receipt.runType==='refinement'; receipt.receiptDigest=digestCanonicalV1(receipt); return receipt;
}
