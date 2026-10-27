import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {repoFile,writeJson} from '../../../scripts/lib/lite-phase-work-v1.mjs';
import {buildCoverageMatrixV1,renderCoverageMarkdownV1} from './adr-coverage-matrix-v1.mjs';
import {loadTaxonomyV1} from './adr-taxonomy-v1.mjs';
import {reviewInventoryRelV1} from './adr-review-inventory-v1.mjs';

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
export function validatePhase6AttackerWorkV1({root,campaignPath,form,structuralOnly=false}={}){
 const errors=[];
 if(structuralOnly){
  // The v4 work-unit controller checks machine provenance, not whether
  // the auditor's PASS/FAIL interpretation or conclusion is persuasive.
  try{
   for(const row of arr(output(form,4,'baselineTestRecords')).filter(obj)){
    const id=String(row.testGroupId??'UNKNOWN'),prefix=id+': ';
    roundCheck({root,campaignPath,row,identifier:id,errors});
    const ids=arr(row.obligationIds),outcomes=arr(row.obligationOutcomes);
    const seen=outcomes.map(x=>x?.obligationId);
    if(new Set(seen).size!==seen.length||
       JSON.stringify([...seen].sort())!==JSON.stringify([...ids].sort()))
     errors.push(prefix+'obligationOutcomes identity coverage mismatch');
    for(const outcome of outcomes.filter(obj)){
     const ref=outcome.ledgerRef;
     if(ref&&ref!=='NONE_IDENTIFIED'){
      const found=ledger(root,campaignPath,ref,errors,prefix);
      if(found&&Array.isArray(outcome.assertionNames)&&
         outcome.assertionNames.some(n=>!found.tests.some(t=>t?.name===n)))
       errors.push(prefix+'named machine assertion missing');
     }
    }
   }
   for(const row of arr(output(form,5,'candidateProofRecords')).filter(obj)){
    const id=String(row.candidateKey??'UNKNOWN'),prefix=id+': ';
    roundCheck({root,campaignPath,row,identifier:id,errors});
    if(['CONFIRMED','DISPROVEN'].includes(row.verdict)){
     const found=ledger(root,campaignPath,row.ledgerRef,errors,prefix);
     if(found)for(const field of ['attackAssertionNames','controlAssertionNames']){
      const names=row[field];
      if(!Array.isArray(names)||!names.length||names.some(blank))
       errors.push(prefix+field+' requires named machine assertions');
      else if(names.some(n=>!found.tests.some(t=>t?.name===n)))
       errors.push(prefix+field+' references absent machine assertion');
     }
    }
   }
   for(const row of arr(output(form,5,'newCandidateRecords')).filter(obj))
    if(row.ledgerRef&&row.ledgerRef!=='NONE_IDENTIFIED')
     ledger(root,campaignPath,row.ledgerRef,errors,String(row.tempKey??'UNKNOWN'));
  }catch(e){errors.push('Phase 6 machine-integrity validation error: '+String(e.message??e));}
  return errors;
 }
 try{
  if(!form?.actions?.['step-4']||!form?.actions?.['step-5'])return [];
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
  const p6=read(rootFile(root,campaignPath,'derived/phase-6/PHASE_06_CANONICAL_DATA_v1.json'));
  if(!p6)return [];
  const expected=new Set();
  for(const row of arr(output(p6,4,'baselineTestRecords')).filter(obj))
   for(const o of arr(row.obligationOutcomes))if(o?.outcome==='PROPERTY_FAILED')
    expected.add('P6-PROP-'+row.testGroupId+'-'+o.obligationId);
  for(const row of arr(output(p6,5,'candidateProofRecords')).filter(obj))
   if(['CONFIRMED','INCONCLUSIVE'].includes(row.verdict))expected.add(row.candidateKey);
  for(const row of arr(output(p6,5,'newCandidateRecords')).filter(obj))expected.add(row.tempKey);
  const found=new Set(arr(output(form,2,'candidateValidations')).filter(obj).map(x=>x.candidateKey));
  return [...expected].sort().filter(k=>!found.has(k)).map(k=>'Phase 8 missing Phase 6 candidate '+k);
 }catch(e){return ['Phase 8 linkage validation error: '+String(e.message??e)];}
}
export function validatePhase10CoverageLabelV1({root,campaignPath,form,requireCoverageMatrix=false}={}){
 try{
  const matrix=read(rootFile(root,campaignPath,'work/phase-10/COVERAGE_MATRIX_v1.json'));
  if(!matrix)return requireCoverageMatrix?['Phase 10 coverage matrix is missing; required review coverage cannot be claimed complete']:[];
  const reason=output(form,3,'verdictRationale');
  return typeof reason==='string'&&reason.includes(matrix.label)?[]:['Phase 10 verdictRationale must contain '+matrix.label];
 }catch(e){return ['Phase 10 coverage label validation error: '+String(e.message??e)];}
}

// Preserve the distinction between controller-accepted bounded scenarios and
// the prior immutable per-context Phase-6 property outcomes. A bounded PASS is
// not an automatic PASS for every context bearing the same security class.
function controllerAcceptedPostSealTestsV1({root,campaignPath}){
 const dir=rootFile(root,campaignPath,'controller/phase8-revalidation');
 if(!fs.existsSync(dir))return null;
 const source=read(rootFile(root,campaignPath,'receipts/PHASE_06_RECEIPT_v1.json'))?.source?.sha256;
 const expectedCampaign=path.posix.basename(campaignPath);
 const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const accepted=new Map(),receipts=[];
 let assertions=0;
 for(const group of fs.readdirSync(dir,{withFileTypes:true})){
  if(!group.isDirectory()||!/^(?:TG-[0-9]{3}|CP-[A-Za-z0-9._-]+)$/.test(group.name))continue;
  const groupDir=path.join(dir,group.name);
  for(const filename of fs.readdirSync(groupDir)){
   if(!/^CONTROLLER_[A-Za-z0-9_-]*EVIDENCE_INGEST_RECEIPT_[A-Za-z0-9_-]+\.json$/.test(filename))continue;
   const receipt=read(path.join(groupDir,filename));
   if(!receipt||receipt.status!=='EVIDENCE_ACCEPTED_FOR_PHASE8_VALIDATION')continue;
   if(receipt.campaignId!==expectedCampaign||!source||receipt.sourceSha256!==source)
    throw Error('Post-seal receipt does not bind admitted campaign and source');
   const proofRel=String(receipt.evidencePath??'');
   if(!proofRel.startsWith(campaignPath+'/controller/phase8-revalidation/'+group.name+'/')
     ||proofRel.split('/').includes('..'))throw Error('Unsafe post-seal proof reference');
   const proofFile=repoFile(root,proofRel);
   if(sha(proofFile)!==receipt.evidenceSha256)throw Error('Post-seal proof SHA mismatch');
   const proof=read(proofFile);
   if(!proof||proof.status!=='ALL_SEVEN_PASSED'||
      proof.source?.archiveSha256!==source||!Array.isArray(proof.obligations))
     throw Error('Post-seal receipt does not bind an executed proof ledger');
   let groupAssertions=0;
   for(const obligation of proof.obligations){
    if(!obligation||obligation.status!=='PASS'||obligation.toolInvoked!==true||
       !Array.isArray(obligation.steps)||!obligation.steps.length||
       obligation.steps.some(step=>step.pass!==true)||
       !receipt.acceptedObligations?.includes(obligation.obligationId))
      throw Error('Post-seal machine test did not pass controller acceptance');
    const id=String(obligation.obligationId);
    if(accepted.has(id))throw Error('Post-seal duplicate obligation: '+id);
    accepted.set(id,obligation.steps.length);
    groupAssertions+=obligation.steps.length;
   }
   if(groupAssertions!==receipt.assertionCount)throw Error('Post-seal assertion count mismatch');
   assertions+=groupAssertions;
   receipts.push(path.posix.join(campaignPath,'controller/phase8-revalidation',group.name,filename));
  }
 }
 if(!receipts.length)return null;
 return {status:'CONTROLLER_ACCEPTED_BOUNDED_EXECUTION',
   acceptedObligationIds:[...accepted.keys()].sort(),
   acceptedAssertionCount:assertions,
   receiptCount:receipts.length,
   receiptPaths:receipts,
   scope:'SCENARIO_BOUNDED_NO_AUTOMATIC_CONTEXT_LEVEL_PASS'};
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
  matrix.postSealAcceptedEvidence=controllerAcceptedPostSealTestsV1({root,campaignPath});
  writeJson(rootFile(root,campaignPath,'work/phase-10/COVERAGE_MATRIX_v1.json'),matrix);
  const qualification=read(repoFile(automationRoot,'process/adr-qualification/QUALIFICATION_STATUS_v1.json'));
  const status=qualification?.status??'NOT_YET_QUALIFIED';
  const postSeal=matrix.postSealAcceptedEvidence;
  const supplement=postSeal
    ? '\n### Controller-accepted post-seal executable checks\n'
      +'- Accepted bounded baseline obligations: '+postSeal.acceptedObligationIds.join(', ')+'\n'
      +'- Passing scenario assertions: '+postSeal.acceptedAssertionCount+'\n'
      +'- Controller receipt references: '+postSeal.receiptPaths.join(', ')+'\n'
      +'- These scenario observations do not automatically establish context-level property PASS or external trust safety.\n'
    : '';
  return text+'\n## Coverage matrix\n'+renderCoverageMarkdownV1(matrix)+supplement+'\nDetection qualification status: '+status+'\n';
 }catch{return text;}
}
