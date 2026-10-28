import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {secureShardWorkFormV13} from './lite-solo-work-shards-v1.mjs';
import {applyPhaseBoundaryPrefill} from './lite-solo-phase-prefill-v1.mjs';
import {resolveFrozenAuthorityFileV1} from '../../packages/github-native-sim/src/adr-frozen-authority-v1.mjs';

export const EXPLICIT_NEGATIVES=new Set(['NONE_IDENTIFIED','NOT_APPLICABLE','NOT_TRIGGERED','NO_CANDIDATE','NO_REMEDIATION','INSUFFICIENT_EVIDENCE','UNRESOLVED','NO_ADDITIONAL_OBLIGATION','NO_CONTRADICTION']);

export function readJson(file){return JSON.parse(fs.readFileSync(file,'utf8'));}
export function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
export function writeText(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
export function safeRel(rel,label='path'){if(typeof rel!=='string'||!rel||rel.startsWith('/')||rel.split('/').includes('..')) throw new Error('unsafe '+label+': '+rel);return rel;}
export function repoFile(root,rel){return path.join(root,...safeRel(rel).split('/'));}
export function requiredFile(root,rel,label='file'){
  const f=repoFile(root,rel);
  if(fs.existsSync(f)&&fs.statSync(f).isFile())return f;
  const frozen=resolveFrozenAuthorityFileV1(root,rel);
  if(frozen&&fs.existsSync(frozen)&&fs.statSync(frozen).isFile())return frozen;
  throw new Error('missing '+label+': '+rel);
}
export function authorityRootFromReceipt(receipt){
 const authority=receipt?.authority,home=authority?.homepagePath;
 if(typeof home!=='string'||!home.endsWith('/SKILL.md'))throw new Error('receipt authority.homepagePath missing');
 const logical=path.posix.dirname(home);
 if(logical==='Audit Skill - Current Authority/Audit_Litemode_v13'){
   const originalSha='31555f32434fc6d568e9c63eb1f04a4f071b06fb81e559ea849ec9c8c233b50f';
   const receiptBoundV13_2Sha='8c94a27e6a2bf534576aff2e5e792402c837024511976a92e0179e8114a6639e';
   if(authority.liteSkillSha256===originalSha)
     return 'audit-process/v7/frozen-authorities/Audit_Litemode_v13';
   // The DAI r2 Phase-0 receipt binds immutable v13.2 bytes from historical
   // commit f48bb763..., while the live logical root now points at CurveYield3
   // links. Select the exact archived historical tree; never rebind its digest.
   if(authority.liteSkillSha256===receiptBoundV13_2Sha)
     return 'audit-process/v7/frozen-authorities/Audit_Litemode_v13_v13_2';
   if(authority.packageRevision==='v13')
     throw new Error('frozen v13 campaign authority digest does not match the admitted immutable original; refuse silent topology rebind');
 }
 return logical;
}
// New Phase-0 receipts bind the entire authority package, not just SKILL.md.
// Old receipts keep their admitted legacy resolver; they are never silently
// upgraded to a different manifest or rewritten in-place.
export function validateBoundAuthorityV1({root,receipt}={}){
 const authority=receipt?.authority,authorityRoot=authorityRootFromReceipt(receipt);
 if(authority?.manifestSha256===undefined)return authorityRoot;
 const hex64=/^[a-f0-9]{64}$/,hex40=/^[a-f0-9]{40}$/;
 if(!hex64.test(String(authority.manifestSha256))||
    !hex64.test(String(authority.liteSkillSha256))||
    !hex40.test(String(authority.manifestGitBlobSha))||
    !hex40.test(String(authority.authorityCommitSha)))
   throw new Error('bound authority manifest/commit identity is invalid');
 const manifestFile=requiredFile(root,path.posix.join(authorityRoot,'MANIFEST.json'),'bound authority manifest');
 const manifestBytes=fs.readFileSync(manifestFile);
 if(createHash('sha256').update(manifestBytes).digest('hex')!==authority.manifestSha256)
   throw new Error('bound authority manifest changed; original campaign authority must be restored, not rebound');
 const blobBytes=Buffer.concat([Buffer.from('blob '+manifestBytes.length),Buffer.from([0]),manifestBytes]);
 if(createHash('sha1').update(blobBytes).digest('hex')!==authority.manifestGitBlobSha)
   throw new Error('bound authority manifest Git blob identity changed');
 const manifest=JSON.parse(manifestBytes.toString('utf8'));
 if(manifest.release!==authority.liteRelease||manifest.packageRevision!==authority.packageRevision||
    manifest.entrypoint!=='SKILL.md'||!Array.isArray(manifest.files)||manifest.files.length===0)
   throw new Error('bound authority manifest release/entrypoint identity mismatch');
 const seen=new Set();
 for(const entry of manifest.files){
   const rel=safeRel(entry?.path,'authority manifest path');
   if(seen.has(rel)||!hex64.test(String(entry.sha256))||!Number.isInteger(entry.bytes)||entry.bytes<0)
     throw new Error('invalid or duplicate bound authority manifest entry '+rel);
   seen.add(rel);
   const target=requiredFile(root,path.posix.join(authorityRoot,rel),'bound authority package file');
   const bytes=fs.readFileSync(target);
   if(bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)
     throw new Error('bound authority package content changed: '+rel);
 }
 if(!seen.has('SKILL.md'))throw new Error('bound authority manifest omits SKILL.md');
 const home=requiredFile(root,path.posix.join(authorityRoot,'SKILL.md'),'bound authority homepage');
 if(createHash('sha256').update(fs.readFileSync(home)).digest('hex')!==authority.liteSkillSha256)
   throw new Error('bound authority homepage digest changed');
 return authorityRoot;
}
export function phaseSchemaRepoPath(authorityRoot,sequence){return path.posix.join(authorityRoot,'phases/phase-'+sequence,'PHASE_'+String(sequence).padStart(2,'0')+'_SCHEMA_v1.json');}
export function loadPhaseSchema(root,authorityRoot,sequence){const rel=phaseSchemaRepoPath(authorityRoot,sequence);const schema=readJson(requiredFile(root,rel,'phase schema'));if(schema.schemaVersion!=='curveyield-lite-phase-work-schema-v1'||schema.phase!==sequence) throw new Error('phase schema identity mismatch: '+rel);return {schema,rel};}
export function fullCampaignPath(campaignPath,rel){return path.posix.join(campaignPath,safeRel(rel));}
export function isPlaceholder(v){return typeof v==='string'&&(/^\s*$/.test(v)||/^<REQUIRED/.test(v)||v==='<fill>'||v==='TODO');}
function validateScalar(v,pathName,def){
  if(isPlaceholder(v)||v===null||v===undefined) return [pathName+' is missing'];
  if(def.type==='REQUIRED_ENUM'&&!def.allowed?.includes(String(v))) return [pathName+' must be one of: '+(def.allowed??[]).join(', ')];
  return [];
}

// Shared deterministic Phase 4-6 work-unit and aggregate field rules.
// A primitive type is enforced only if the bound schema, immutable assigned
// prefill, or established typed packet contract actually declares it.
const V4_ARRAY_MEMBERS=new Set([
 'contextIds','evidenceRefs','relatedRequirementKeys','relatedHypothesisKeys',
 'obligationIds','obligationsDetail','obligationOutcomes','requestPaths',
 'attackAssertionNames','controlAssertionNames','executionEvidenceRefs','anchors'
]);
const V4_INTEGER_MEMBERS=new Set(['dispatchRounds']);
const V4_TEXT_MEMBERS=new Set([
 'recordKey','sourceAnchor','origin','reviewerFinding','attackerFinding',
 'reconciliation','disposition','candidateTempKeyOrNone','rationale',
 'domainOrPrivilege','method','observation','securityInterpretation',
 'tempKey','description','securityRationale','recommendedValidationMethod',
 'materialityBasis','obligationId','requiredAction','completionCondition',
 'carryForwardPhaseOrNone','valueFlowOrFormula','unitsAndBounds',
 'boundaryCases','roundingPrecision','incentiveExtractionAnalysis',
 'solvencyOrConservationAnalysis','conclusion','subjectKey','subjectType',
 'priorConclusion','phase5Observation','downstreamValidationNeed','candidateKey',
 'setup','oracle','snapshotReuseSafety','expectedSecurityProperty',
 'executionMethod','reproductionType','componentOrAction','executionEvidenceRef',
 'observedState','contradictionOrNone','limitationOrNone','oracleOutcome',
 'reproductionStatus','recommendedPhase8Disposition','semanticHarnessBindingAssessment',
 'harnessDesign','testGroupId','contract','requestDirectory','phase5Result',
 'verdict','reasoning','title','classId','requestBindingStatus',
 'requestBindingEvidenceRef'
]);
const V4_NEGATIVE_SLOTS=new Set(['NONE_IDENTIFIED','NO_CANDIDATE','NOT_APPLICABLE','NO_ADDITIONAL_OBLIGATION']);
function schemaMissingV4(value){
 if(value===undefined||value===null)return true;
 if(typeof value==='string')return !value.trim()||/^<(?:REQUIRED|CONTROLLER_PREFILL|fill|REQUIRED_OR_)/i.test(value.trim())||
  value.trim()==='TODO';
 if(Array.isArray(value))return value.length===0;
 if(value&&typeof value==='object')return !Object.keys(value).length;
 return false;
}
function nestedPresentV4(value,p,errors,depth=0){
 if(depth>12){errors.push(p+': NESTING_LIMIT_EXCEEDED');return;}
 if(schemaMissingV4(value)){errors.push(p+': REQUIRED_NONBLANK');return;}
 if(Array.isArray(value)){
  // Required collection elements must exist, but arbitrary properties of a
  // provided object are not implicitly required unless the bound schema says
  // so. Do not infer unknown nested field requirements from its presence.
  for(let i=0;i<value.length;i++)nestedPresentV4(value[i],p+'['+i+']',errors,depth+1);
 }
}
export function validateSchemaRecordValueV1(field,value,p,{originalValue,allowNegative=false,authorityRelease=null}={}){
 const errors=[];
 const negative=typeof value==='string'&&V4_NEGATIVE_SLOTS.has(value);
 if(field.type==='REQUIRED_ANALYSIS'){
  if(typeof value!=='string')errors.push(p+': STRING_REQUIRED');
  else if(schemaMissingV4(value))errors.push(p+': REQUIRED_NONBLANK');
  return errors;
 }
 if(field.type==='REQUIRED_ENUM'){
  if(typeof value!==typeof field.allowed?.[0]||!field.allowed?.includes(value))
   errors.push(p+': INVALID_ENUM');
  return errors;
 }
 if(field.type==='REQUIRED_LIST'){
  if(!Array.isArray(value)||!value.length)errors.push(p+': NONEMPTY_LIST_REQUIRED');
  else for(let i=0;i<value.length;i++)nestedPresentV4(value[i],p+'['+i+']',errors);
  return errors;
 }
 if(field.type!=='REQUIRED_RECORD_LIST')return errors;
 if(negative&&allowNegative)return errors;
 if(!value||typeof value!=='object'||Array.isArray(value)){
  errors.push(p+': RECORD_OBJECT_REQUIRED');return errors;
 }
 for(const name of field.itemRequiredFields??[]){
  const member=value[name],mp=p+'.'+name;
  if(schemaMissingV4(member)){errors.push(mp+': REQUIRED_NONBLANK');continue;}
  const allowed=field.itemFieldAllowedValues?.[name];
  if(allowed&&(!allowed.length||typeof member!==typeof allowed[0]||!allowed.includes(member)))
   errors.push(mp+': INVALID_ENUM');
  const prior=originalValue&&typeof originalValue==='object'&&!Array.isArray(originalValue)?originalValue[name]:undefined;
  if(prior!==undefined&&!schemaMissingV4(prior)&&
     (Array.isArray(prior)!==Array.isArray(member)||
      (Array.isArray(prior)===false&&typeof prior==='object'&&prior!==null&&
       (!member||typeof member!=='object'||Array.isArray(member)))||
      (prior!==null&&typeof prior!=='object'&&typeof member!==typeof prior)))
   errors.push(mp+': PREFILLED_FIELD_TYPE_MISMATCH');
  if(V4_ARRAY_MEMBERS.has(name)&&!Array.isArray(member))errors.push(mp+': ARRAY_REQUIRED');
  if(V4_TEXT_MEMBERS.has(name)&&typeof member!=='string')errors.push(mp+': STRING_REQUIRED');
  if(V4_INTEGER_MEMBERS.has(name)&&(!Number.isInteger(member)||member<0))
   errors.push(mp+': NONNEGATIVE_INTEGER_REQUIRED');
  const min=field.itemFieldMinItems?.[name];
  if(Number.isInteger(min)&&(!Array.isArray(member)||member.length<min))
   errors.push(mp+': MIN_ITEMS_'+min);
  if(Array.isArray(member)||member&&typeof member==='object')nestedPresentV4(member,mp,errors);
 }
 // v4 Step-1 contract is receipt-bound and expressly restricts this
 // cross-field disposition. v5 removes that rule through an approved,
 // separately hashed authority; do not back-port v5 policy into frozen v4.
 if(authorityRelease==='lite-solo-v4'&&field.name==='discoveryReconciliationRecords'&&
    value.disposition==='COVERAGE_GAP_ACCEPTED'&&value.origin!=='COVERAGE_GAP')
  errors.push(p+'.disposition: FROZEN_V4_ORIGIN_RESTRICTION');
 for(const [name,allowed] of Object.entries(field.itemFieldAllowedValues??{}))
  if(!Object.hasOwn(value,name)&&!field.itemRequiredFields?.includes(name))
   continue;
  else if(value[name]!==undefined&&
   (!allowed.length||typeof value[name]!==typeof allowed[0]||!allowed.includes(value[name])))
   if(!errors.includes(p+'.'+name+': INVALID_ENUM'))errors.push(p+'.'+name+': INVALID_ENUM');
 return errors;
}

export function validateWorkForm(schema,form,{structuralOnly=false,authorityRelease=null}={}){
  const deficiencies=[];
  const missingRequired=value=>value===undefined||value===null||
   isPlaceholder(value)||(structuralOnly&&typeof value==='object'&&!Array.isArray(value)&&
    (Object.keys(value).length===0));
  const incompleteNested=(value,fieldPath)=>{
   if(!structuralOnly)return;
   if(Array.isArray(value)){
    for(let n=0;n<value.length;n++)
     if(missingRequired(value[n]))deficiencies.push(fieldPath+'['+n+']: REQUIRED_NONBLANK');
   }
  };
  if(form?.schemaVersion!=='curveyield-lite-phase-work-form-v1') deficiencies.push('work form schemaVersion mismatch');
  if(form?.phase!==schema.phase) deficiencies.push('work form phase mismatch');
  for(const [stepKey,action] of Object.entries(schema.actions??{})){
    const row=form?.actions?.[stepKey];
    if(!row){deficiencies.push('actions.'+stepKey+' section is missing');continue;}
    if(row.section!==action.section) deficiencies.push('actions.'+stepKey+'.section must equal "'+action.section+'"');
    for(const field of action.fields??[]){
      const p='actions.'+stepKey+'.outputs.'+field.name;
      const v=row?.outputs?.[field.name];
      if(structuralOnly){
        if(field.type==='REQUIRED_RECORD_LIST'){
          if(!Array.isArray(v)||v.length===0){
            deficiencies.push(p+': NONEMPTY_RECORD_LIST_REQUIRED');continue;
          }
          for(let i=0;i<v.length;i++){
            const item=v[i];
            const negative=typeof item==='string'&&V4_NEGATIVE_SLOTS.has(item)&&
             (v.length===1||i===0&&[4,5,6].includes(schema.phase)&&
              v.length>1&&v.slice(1).every(x=>x&&typeof x==='object'&&!Array.isArray(x)));
            deficiencies.push(...validateSchemaRecordValueV1(field,item,p+'['+i+']',{allowNegative:negative,authorityRelease}));
          }
        }else deficiencies.push(...validateSchemaRecordValueV1(field,v,p));
        continue;
      }
      if(field.type==='REQUIRED_LIST'){
        if(!Array.isArray(v)||v.length===0) deficiencies.push(p+' must be a non-empty list');
        else for(let i=0;i<v.length;i++){
          if(missingRequired(v[i]))deficiencies.push(p+'['+i+']: REQUIRED_NONBLANK');
          incompleteNested(v[i],p+'['+i+']');
        }
      }else if(field.type==='REQUIRED_RECORD_LIST'){
        if(!Array.isArray(v)||v.length===0) deficiencies.push(p+' must be a non-empty record list or explicit negative sentinel');
        else if(v.length===1&&typeof v[0]==='string'&&EXPLICIT_NEGATIVES.has(v[0])){}
        else for(let i=0;i<v.length;i++){
          const item=v[i];
          // A v13 indexed work-form may have an immutable first-slot negative
          // sentinel while the reviewer appends actual records. The sentinel
          // remains identity-bound in the original shard; real records still
          // undergo every required-field and allowed-value check below.
          if(schema.phase===3&&stepKey==='step-2'&&field.name==='customValidationObligations'&&
             i===0&&v.length>1&&item==='NONE_IDENTIFIED'&&
             v.slice(1).every(x=>x&&typeof x==='object'&&!Array.isArray(x)))continue;
          // Phase 4–6 append units preserve a controller-prefilled negative
          // original slot, while separate immutable APPEND entries add records.
          // The unit owner validates the sentinel against its exact frozen slot.
          if(structuralOnly&&[4,5,6].includes(schema.phase)&&i===0&&v.length>1&&
             typeof item==='string'&&EXPLICIT_NEGATIVES.has(item)&&
             v.slice(1).every(x=>x&&typeof x==='object'&&!Array.isArray(x)))continue;
          if(!item||typeof item!=='object'||Array.isArray(item)){deficiencies.push(p+'['+i+'] must be an object or explicit negative sentinel');continue;}
          for(const k of field.itemRequiredFields??[]){
            const member=item[k],fp=p+'['+i+'].'+k;
            if(missingRequired(member))deficiencies.push(fp+': REQUIRED_NONBLANK');
            incompleteNested(member,fp);
            const min=field.itemFieldMinItems?.[k];
            if(Number.isInteger(min)&&Array.isArray(member)&&member.length<min)
              deficiencies.push(fp+': MIN_ITEMS_'+min);
          }
          for(const [k,allowed] of Object.entries(field.itemFieldAllowedValues??{})){
            if(item[k]!==undefined&&!(structuralOnly?
             typeof item[k]===typeof allowed[0]&&allowed.includes(item[k]):
             allowed.includes(String(item[k])))) deficiencies.push(p+'['+i+'].'+k+' must be one of: '+allowed.join(', '));
          }
        }
      }else{
        deficiencies.push(...validateScalar(v,p,field));
        if(structuralOnly&&field.type==='REQUIRED_ANALYSIS'&&typeof v!=='string')
          deficiencies.push(p+': STRING_REQUIRED');
      }
    }
  }
  return deficiencies;
}
export function validateFinalReport(schema,text){
  const deficiencies=[];const report=schema.finalReport;if(!report) return deficiencies;
  const lines=String(text??'').split(/\r?\n/);
  const headings=[];
  for(let i=0;i<lines.length;i++) if(lines[i].startsWith('## ')) headings.push({name:lines[i].slice(3).trim(),line:i});
  for(const heading of report.requiredSections??[]){
    const idx=headings.findIndex(x=>x.name===heading);
    if(idx<0){deficiencies.push('finalReport section missing: '+heading);continue;}
    const start=headings[idx].line+1;
    const end=idx+1<headings.length?headings[idx+1].line:lines.length;
    const body=lines.slice(start,end).join('\n').trim();
    if(!body||/^<REQUIRED/.test(body)) deficiencies.push('finalReport section incomplete: '+heading);
  }
  return deficiencies;
}
export function getByPath(obj,dot){let cur=obj;for(const part of String(dot).split('.')){if(cur==null) return undefined;cur=cur[part];}return cur;}
export function setByPath(obj,dot,value){const parts=String(dot).split('.');let cur=obj;for(let i=0;i<parts.length-1;i++){cur[parts[i]]??={};cur=cur[parts[i]];}cur[parts.at(-1)]=value;}
export function buildDerivedOutputs({root,campaignPath,schema,canonicalData,canonicalRel,now}){
  const out=[];
  for(const spec of schema.derivedOutputs??[]){
    const data={};
    for(const selector of spec.selectors??[]) setByPath(data,selector,getByPath(canonicalData,selector));
    const rel=fullCampaignPath(campaignPath,spec.path);
    writeJson(repoFile(root,rel),{schemaVersion:'curveyield-lite-derived-phase-data-v1',phase:schema.phase,sourceCanonicalData:canonicalRel,generatedAt:now,data});
    out.push(rel);
  }
  return out;
}
export function preparePhaseWork({root,campaignPath,authorityRoot,sequence,reviewer,predecessorReceiptPath,derivedInputPaths=[],status='ACTIVE',prefillContext={}}){
  const loaded=loadPhaseSchema(root,authorityRoot,sequence);const schema=loaded.schema;const schemaRel=loaded.rel;
  const formRel=fullCampaignPath(campaignPath,schema.workForm.campaignPath);
  const formTemplateRel=path.posix.join(authorityRoot,schema.workForm.template);
  let form=readJson(requiredFile(root,formTemplateRel,'work-form template'));
  form=applyPhaseBoundaryPrefill({root,campaignPath,authorityRoot,sequence,form,derivedInputPaths,predecessorReceiptPath,prefillContext});
  writeJson(repoFile(root,formRel),form);
  const shards=secureShardWorkFormV13({root,formRel,phase:sequence,retireFull:true});
  const reportRel=schema.finalReport?fullCampaignPath(campaignPath,schema.finalReport.campaignPath):null;
  return {phaseSequence:sequence,phaseId:'phase-'+sequence,reviewer,status,workSchemaPath:schemaRel,workFormPath:formRel,...(shards?{workShardIndexPath:shards.indexRel}:{}),finalReportPath:reportRel,packetPath:fullCampaignPath(campaignPath,schema.submission.packetPath),predecessorReceiptPath,derivedInputPaths:[...derivedInputPaths],controllerPrefillDigestSha256:form?.automationInputs?.controllerPrefillDigestSha256??null};
}
export function ensurePacketShape({packet,directory,assignment}){
  const deficiencies=[];
  if(packet?.schemaVersion!=='curveyield-lite-phase-work-packet-v1') deficiencies.push('packet.schemaVersion must be curveyield-lite-phase-work-packet-v1');
  if(packet?.campaignId!==directory.campaignId) deficiencies.push('packet.campaignId mismatch');
  if(packet?.phaseSequence!==assignment.phaseSequence) deficiencies.push('packet.phaseSequence mismatch');
  if(packet?.status!=='SUBMITTED') deficiencies.push('packet.status must be SUBMITTED');
  if(packet?.workFormPath!==assignment.workFormPath) deficiencies.push('packet.workFormPath mismatch');
  if(packet?.finalReportPath!==(assignment.finalReportPath??null)) deficiencies.push('packet.finalReportPath mismatch');
  if(!Number.isInteger(packet?.submissionAttempt)||packet.submissionAttempt<1) deficiencies.push('packet.submissionAttempt must be integer >=1');
  if(typeof packet?.submittedAt!=='string'||!packet.submittedAt) deficiencies.push('packet.submittedAt required');
  return deficiencies;
}
