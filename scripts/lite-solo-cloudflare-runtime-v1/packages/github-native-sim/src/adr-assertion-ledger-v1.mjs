import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const base=()=>({schemaVersion:'curveyield-assertion-ledger-v1',parseStatus:'UNPARSEABLE',
 tool:null,toolInvoked:null,executedCalls:null,tests:[]});
const asBool=x=>typeof x==='boolean'?x:null;
const components=e=>{
 const sources=[e?.analysis,e?.result?.analysis,e?.rawResult?.analysis,e?.execution?.analysis,e?.phase6CampaignEvidence?.analysis];
 return sources.filter(x=>x&&typeof x==='object').flatMap(x=>Object.entries(x).map(([key,value])=>({key,value})));
};
export function buildAssertionLedgerV1({evidence}={}){
 try{
  const named=[],tools=new Set(),flags=[],counts=[];
  for(const {key,value} of components(evidence)){
   const comp=value??{};
   if(key==='nativeFuzz'||key==='native-fuzz'){
    for(const row of comp.testResults?.tests??[]){
     if(!row||!['PASS','FAIL','SKIPPED'].includes(row.status)||!row.name)continue;
     named.push({name:row.suite?row.suite+'::'+row.name:row.name,status:row.status,
      reason:row.reason??null});tools.add('forge');
     flags.push(asBool(comp.toolInvoked));
    }
   }
   if(key==='medusa'){
    for(const row of comp.campaign?.properties??comp.properties??[]){
     if(!row?.name)continue;
     const status=row.status==='failed'?'FAIL':
       ['passed','completed','unfalsified'].includes(row.status)?'PASS':null;
     if(!status)continue;
     named.push({name:row.name,status,reason:null});tools.add('medusa');
     flags.push(asBool(comp.toolInvoked));
    }
    const calls=comp.campaign?.statistics?.executedCalls??comp.campaign?.statistics?.calls;
    if(Number.isSafeInteger(calls)&&calls>=0)counts.push(calls);
   }
  }
  const tool=tools.size===1?[...tools][0]:tools.size>1?'MULTIPLE':evidence?.reproduction?.engine??null;
  const flagsKnown=flags.filter(x=>x!==null);
  const toolInvoked=flags.length===0||flagsKnown.length!==flags.length?null:flagsKnown.every(Boolean);
  return {...base(),parseStatus:named.length?'PARSED':'UNPARSEABLE',tool,toolInvoked,
   executedCalls:counts.length?counts.reduce((a,b)=>a+b,0):null,tests:named};
 }catch{return base();}
}
function runCli(){
 const arg=name=>{const i=process.argv.indexOf('--'+name);return i>=0?process.argv[i+1]:null;};
 const output=arg('out');
 if(!output)return;
 let result;
 try{result=buildAssertionLedgerV1({evidence:JSON.parse(fs.readFileSync(arg('evidence'),'utf8'))});}
 catch(error){result={...base(),error:String(error?.message??error).slice(0,2000)};}
 try{fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');}
 catch(error){process.stderr.write('Cannot write assertion ledger: '+String(error?.message??error)+'\n');}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){runCli();process.exitCode=0;}
