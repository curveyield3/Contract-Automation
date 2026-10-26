import fs from 'node:fs';
import path from 'node:path';
import {repoFile,writeJson} from '../../../scripts/lib/lite-phase-work-v1.mjs';
import {buildCoverageMatrixV1,renderCoverageMarkdownV1} from './adr-coverage-matrix-v1.mjs';
import {loadTaxonomyV1} from './adr-taxonomy-v1.mjs';
import {reviewInventoryRelV1} from './adr-review-inventory-v1.mjs';
import {readVerifiedCandidateIdentityIndexV1} from '../../../scripts/lib/lite-solo-candidate-batch-v1.mjs';

const arr=x=>Array.isArray(x)?x:[];
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const blank=x=>typeof x!=='string'||!x.trim()||x.trim().startsWith('<');
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const output=(form,step,name)=>form?.actions?.['step-'+step]?.outputs?.[name];
const rootFile=(root,campaign,rel)=>repoFile(root,path.posix.join(campaign,rel));
const anchor=/\.(?:sol|vy):L[1-9]\d*(?:-L[1-9]\d*)?/;
function roundCheck({root,campaignPath,row,identifier,errors}){
 const prefix=identifier+': ';
 const rel=String(row?.requestDirectory??'');
 if(!/^controller\/phase6-tests\/(?:TG-\d{3}|CP-[A-Za-z0-9._-]+)\/$/.test(rel)){
  errors.push(prefix+'invalid requestDirectory');return;
 }
 const full=rootFile(root,campaignPath,rel),expected=[];
 try{if(fs.existsSync(full))for(const name of fs.readdirSync(full))if(name.endsWith('.json')&&fs.statSync(path.join(full,name)).isFile())
  expected.push(path.posix.join(rel,name));}catch{errors.push(prefix+'request directory inaccessible');}
 expected.sort();
 const actual=arr(row.requestPaths);
 if(!Number.isInteger(row.dispatchRounds)||row.dispatchRounds<0||row.dispatchRounds>3||row.dispatchRounds!==expected.length)
  errors.push(prefix+'dispatchRounds must equal request JSON count (0–3)');
 if(JSON.stringify(actual)!==JSON.stringify(expected.length?expected:['NONE_IDENTIFIED']))
  errors.push(prefix+'requestPaths must equal sorted request files');
 if(expected.length&&blank(row.harnessDesign))errors.push(prefix+'harnessDesign required when dispatched');
}
function ledger(root,campaign,ref,errors,identifier){
 if(blank(ref)||!/^controller\/automation\/[^/]+\/ASSERTION_LEDGER_v1\.json$/.test(ref)){
  errors.push(identifier+': ledgerRef must name controller/automation/<request>/ASSERTION_LEDGER_v1.json');return null;
 }
 const found=read(rootFile(root,campaign,ref));
 if(!found||found.parseStatus!=='PARSED'||found.toolInvoked!==true||!Array.isArray(found.tests)){
  errors.push(identifier+': ledger must exist, be PARSED with toolInvoked=true');return null;
 }
 return found;
}
function assertions(record,field,allowed,found,errors,prefix,{nonEmpty=true,requireAtLeastOneFail=false}={}){
 const names=record?.[field];
 if(!Array.isArray(names)|| (nonEmpty&&!names.length)||names.some(x=>blank(x))){
  errors.push(prefix+field+' needs named assertions');return;
 }
 if(!found)return;
 const states=names.map(n=>found.tests.find(t=>t.name===n)?.status??'MISSING');
 if(states.some(s=>!allowed.includes(s)))errors.push(prefix+field+' assertion result mismatch (required '+allowed.join('/')+')');
 if(requireAtLeastOneFail&&!states.includes('FAIL'))errors.push(prefix+field+' needs a failing security assertion');
}
export function validatePhase6AttackerWorkV1({root,campaignPath,form}={}){
 const errors=[];
 try{
  const identity=readVerifiedCandidateIdentityIndexV1({root,campaignPath});
  const dispositions=arr(output(form,2,'targetDispositions')).filter(obj);
  const proofRows=arr(output(form,5,'candidateProofRecords')).filter(obj);
  for(const [label,rows] of [['targetDispositions',dispositions],['candidateProofRecords',proofRows]]){
    const actual=rows.map(r=>String(r.candidateKey??''));
    const unique=new Set(actual);
    if(unique.size!==actual.length)errors.push('Phase 6 '+label+' contains duplicate candidate identities');
    for(const key of identity.canonicalKeys)if(!unique.has(key))
      errors.push('Phase 6 '+label+' omits source-bound candidate '+key);
    for(const key of actual)if(!identity.rows.has(key))
      errors.push('Phase 6 '+label+' uses unregistered predecessor identity '+key);
  }
  if(!form?.actions?.['step-4']||!form?.actions?.['step-5'])return errors;
  const groups=output(form,4,'baselineTestRecords');
  for(const row of arr(groups).filter(obj)){
   const id=row.testGroupId,p=id+': ';
   roundCheck({root,campaignPath,row,identifier:id,errors});
   const obligations=arr(row.obligationIds),records=arr(row.obligationOutcomes).filter(obj);
   const actual=records.map(x=>x.obligationId);
   if(new Set(actual).size!==actual.length||JSON.stringify([...actual].sort())!==JSON.stringify([...obligations].sort()))
    errors.push(p+'obligationOutcomes must cover exact obligationIds once');
   for(const v of records){
    const prefix=p+v.obligationId+': ';
    switch(v.outcome){
     case 'PASSED':{
      const l=ledger(root,campaignPath,v.ledgerRef,errors,prefix);
      assertions(v,'assertionNames',['PASS'],l,errors,prefix);break;
     }
     case 'PROPERTY_FAILED':{
      const l=ledger(root,campaignPath,v.ledgerRef,errors,prefix);
      assertions(v,'assertionNames',['PASS','FAIL'],l,errors,prefix,{requireAtLeastOneFail:true});break;
     }
     case 'NOT_APPLICABLE_CONFIRMED':
      if(blank(v.note)||!arr(v.anchors).some(a=>typeof a==='string'&&anchor.test(a)))errors.push(prefix+'NOT_APPLICABLE_CONFIRMED requires note and anchor');break;
     case 'INCONCLUSIVE':if(blank(v.note))errors.push(prefix+'INCONCLUSIVE requires note');break;
     case 'NOT_ACHIEVED':
      if(blank(v.note)||!['ROUNDS_EXHAUSTED','NO_EXECUTABLE_SETUP','TOOL_UNSUPPORTED'].includes(v.reasonCode)||
         (v.reasonCode==='ROUNDS_EXHAUSTED'&&row.dispatchRounds!==3))
        errors.push(prefix+'NOT_ACHIEVED reason/note/rounds invalid');break;
     default: errors.push(prefix+'unknown obligation outcome');
    }
   }
  }
  for(const row of arr(output(form,5,'candidateProofRecords')).filter(obj)){
   const id=row.candidateKey,p=id+': ';
   roundCheck({root,campaignPath,row,identifier:id,errors});
   if(row.verdict==='PHASE5_DECISIVE'){if(row.phase5Result!=='REPRODUCED'||blank(row.reasoning))
    errors.push(p+'PHASE5_DECISIVE requires reproduced Phase 5 and reasoning');continue;}
   if(row.verdict==='INCONCLUSIVE'){if(blank(row.reasoning))errors.push(p+'INCONCLUSIVE requires reasoning');continue;}
   if(!['CONFIRMED','DISPROVEN'].includes(row.verdict)){errors.push(p+'unknown candidate verdict');continue;}
   const l=ledger(root,campaignPath,row.ledgerRef,errors,p);
   assertions(row,'attackAssertionNames',row.verdict==='CONFIRMED'?['PASS','FAIL']:['PASS'],l,errors,p,
    {requireAtLeastOneFail:row.verdict==='CONFIRMED'});
   assertions(row,'controlAssertionNames',['PASS'],l,errors,p);
   if(row.verdict==='DISPROVEN'&&(!anchor.test(row.reasoning??'')||blank(row.reasoning)))
    errors.push(p+'DISPROVEN requires anchored blocking-control explanation');
  }
  for(const item of arr(output(form,5,'newCandidateRecords')).filter(x=>x!=='NONE_IDENTIFIED')){
   if(!obj(item)||!/^P6-NEW-\d{3}$/.test(item.tempKey??'')||['title','classId','description'].some(k=>blank(item[k]))||
      !arr(item.anchors).some(a=>typeof a==='string'&&anchor.test(a)))
    errors.push('Phase 6 new candidate malformed');
   else if(item.ledgerRef!=='NONE_IDENTIFIED')ledger(root,campaignPath,item.ledgerRef,errors,item.tempKey);
  }
 }catch(e){errors.push('Phase 6 validation error: '+String(e.message??e));}
 return errors;
}
export function validatePhase8LinkageV1({root,campaignPath,form}={}){
 try{
  const identity=readVerifiedCandidateIdentityIndexV1({root,campaignPath});
  const p6=read(rootFile(root,campaignPath,'derived/phase-6/PHASE_06_CANONICAL_DATA_v1.json'));
  if(!p6)return [];
  const expected=new Set();
  for(const row of arr(output(p6,4,'baselineTestRecords')).filter(obj))
   for(const o of arr(row.obligationOutcomes))if(o?.outcome==='PROPERTY_FAILED')
    expected.add('P6-PROP-'+row.testGroupId+'-'+o.obligationId);
  for(const row of arr(output(p6,5,'candidateProofRecords')).filter(obj))
   if(['CONFIRMED','INCONCLUSIVE'].includes(row.verdict))expected.add(row.candidateKey);
  for(const row of arr(output(p6,5,'newCandidateRecords')).filter(obj))expected.add(row.tempKey);
  // Every inherited Phase-4/5 candidate must resolve to the exact canonical
  // identity that Phase-5 sealed, not a temporary or source-anchor alias.
  for(const key of identity.canonicalKeys)expected.add(key);
  const recorded=arr(output(form,2,'candidateValidations')).filter(obj);
  const found=new Set(recorded.map(x=>x.candidateKey));
  const failures=[...expected].sort().filter(k=>!found.has(k)).map(k=>'Phase 8 missing Phase 6/5 candidate '+k);
  if(found.size!==recorded.length)failures.push('Phase 8 candidateValidations contains duplicate candidate identities');
  for(const row of recorded){
    const key=String(row.candidateKey??'');
    if(identity.aliasMap.has(key)&&identity.aliasMap.get(key)!==key)
      failures.push('Phase 8 uses noncanonical predecessor alias '+key+'; use '+identity.aliasMap.get(key));
  }
  return failures;
 }catch(e){return ['Phase 8 linkage validation error: '+String(e.message??e)];}
}
export function validatePhase10CoverageLabelV1({root,campaignPath,form}={}){
 try{
  const matrix=read(rootFile(root,campaignPath,'work/phase-10/COVERAGE_MATRIX_v1.json'));
  if(!matrix)return [];
  const reason=output(form,3,'verdictRationale');
  return typeof reason==='string'&&reason.includes(matrix.label)?[]:['Phase 10 verdictRationale must contain '+matrix.label];
 }catch(e){return ['Phase 10 coverage label validation error: '+String(e.message??e)];}
}
export function appendAdrCoverageSectionV1({root,campaignPath,automationRoot,text}={}){
 try{
  const discovery=read(rootFile(root,campaignPath,'work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json'));
  if(!discovery)return text;
  const inventory=read(repoFile(root,reviewInventoryRelV1(root,campaignPath,'REVIEW_INVENTORY_v1.json')));
  if(!inventory)return text;
  const p6=read(rootFile(root,campaignPath,'derived/phase-6/PHASE_06_CANONICAL_DATA_v1.json'));
  const baseline=read(rootFile(root,campaignPath,'work/phase-06/BASELINE_OBLIGATIONS_v1.json'));
  const phase6Results={baselineObligations:baseline?.payload?.obligations??[]};
  for(const row of arr(output(p6,4,'baselineTestRecords')).filter(obj))
   for(const outcome of arr(row.obligationOutcomes))if(outcome?.obligationId)phase6Results[outcome.obligationId]=outcome.outcome;
  const matrix=buildCoverageMatrixV1({inventory,taxonomy:loadTaxonomyV1(automationRoot),
   discoveryState:discovery.payload?.discoveryState??null,phase6Results});
  writeJson(rootFile(root,campaignPath,'work/phase-10/COVERAGE_MATRIX_v1.json'),matrix);
  const qualification=read(repoFile(automationRoot,'process/adr-qualification/QUALIFICATION_STATUS_v1.json'));
  const status=qualification?.status??'NOT_YET_QUALIFIED';
  return text+'\n## Coverage matrix\n'+renderCoverageMarkdownV1(matrix)+'\nDetection qualification status: '+status+'\n';
 }catch{return text;}
}
