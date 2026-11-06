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
export function validateWorkForm(schema,form){
  const deficiencies=[];
  if(form?.schemaVersion!=='curveyield-lite-phase-work-form-v1') deficiencies.push('work form schemaVersion mismatch');
  if(form?.phase!==schema.phase) deficiencies.push('work form phase mismatch');
  for(const [stepKey,action] of Object.entries(schema.actions??{})){
    const row=form?.actions?.[stepKey];
    if(!row){deficiencies.push('actions.'+stepKey+' section is missing');continue;}
    if(row.section!==action.section) deficiencies.push('actions.'+stepKey+'.section must equal "'+action.section+'"');
    for(const field of action.fields??[]){
      const p='actions.'+stepKey+'.outputs.'+field.name;
      const v=row?.outputs?.[field.name];
      if(field.type==='REQUIRED_LIST'){
        if(!Array.isArray(v)||v.length===0) deficiencies.push(p+' must be a non-empty list');
        else for(let i=0;i<v.length;i++) if(isPlaceholder(v[i])) deficiencies.push(p+'['+i+'] is missing');
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
          if(!item||typeof item!=='object'||Array.isArray(item)){deficiencies.push(p+'['+i+'] must be an object or explicit negative sentinel');continue;}
          for(const k of field.itemRequiredFields??[]) if(isPlaceholder(item[k])||item[k]===null||item[k]===undefined) deficiencies.push(p+'['+i+'].'+k+' is missing');
          for(const [k,allowed] of Object.entries(field.itemFieldAllowedValues??{})){
            if(item[k]!==undefined&&!allowed.includes(String(item[k]))) deficiencies.push(p+'['+i+'].'+k+' must be one of: '+allowed.join(', '));
          }
        }
      }else deficiencies.push(...validateScalar(v,p,field));
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

// Source-bound inventory of original accepted canonical data. This is reference
// metadata, not a security classification, summary, or replacement for the
// original canonical JSON. No fields, array members, or repeated observations
// are filtered, abbreviated, merged, or renumbered.
export function buildOriginalCanonicalEvidenceRosterV1({root,campaignPath,directory,phase,receipt,receiptRel}){
 const phaseNumber=String(phase).padStart(2,'0');
 const canonicalRel=path.posix.join(campaignPath,'derived/phase-'+phase,
   'PHASE_'+phaseNumber+'_CANONICAL_DATA_v1.json');
 const originalSelector=path.posix.relative(campaignPath,canonicalRel);
 const revision=receipt?.phase?.revision??null;
 const expectedSha=receipt?.evidence?.find(item=>
   item?.path===originalSelector&&item?.role==='PHASE_CANONICAL_DATA')?.sha256??null;
 const roster={
   schemaVersion:'curveyield-original-canonical-evidence-roster-v1',
   phase,canonicalArtifactPath:canonicalRel,actualArtifactPath:null,
   receiptPath:receiptRel??null,acceptedRevision:revision,
   acceptedEpoch:receipt?.sealedAt??receipt?.updatedAt??null,
   campaignId:directory.campaignId,
   campaignGenerationId:directory.campaignGenerationId,
   auditedSourceSha256:receipt?.source?.sha256??directory.sourceSha256??null,
   expectedCanonicalSha256:expectedSha,actualCanonicalSha256:null,
   availability:'UNVERIFIED',diagnostics:[],
   referenceScheme:'RFC6901_JSON_POINTER',
   sourceSelectors:['/actions','/automationInputs','/automationOutputs'],
   records:[]
 };
 const identityBound=receipt?.schemaVersion==='curveyield-lite-phase-receipt-v1'&&
   receipt?.campaign?.campaignId===directory.campaignId&&
   receipt?.campaign?.campaignGenerationId===directory.campaignGenerationId&&
   receipt?.campaign?.workspacePath===campaignPath&&
   receipt?.phase?.sequence===phase&&
   Number.isInteger(revision)&&
   ['SEALED','COMPLETE'].includes(receipt?.phase?.status)&&
   receipt?.source?.sha256===directory.sourceSha256;
 if(!identityBound){
   roster.availability='RECEIPT_IDENTITY_UNVERIFIED';
   roster.diagnostics.push('Accepted receipt campaign/generation/phase/source identity unavailable or mismatched');
   return roster;
 }
 if(!/^[a-f0-9]{64}$/.test(String(expectedSha??''))){
   roster.availability='CANONICAL_RECEIPT_REFERENCE_UNAVAILABLE';
   roster.diagnostics.push('Receipt has no exact PHASE_CANONICAL_DATA SHA-256 reference');
   return roster;
 }
 // Master amendments may preserve original accepted bytes under the existing
 // superseded/ archive. Never present a newer canonical as an older revision.
 const originalInCampaign=originalSelector;
 const candidates=[canonicalRel,
   path.posix.join(campaignPath,'superseded',originalInCampaign),
   path.posix.join(campaignPath,'superseded/reviewer-4-followup-v1',originalInCampaign)];
 let foundOtherHash=false;
 for(const candidate of candidates){
   const file=repoFile(root,candidate);
   let bytes;
   try{
     if(!fs.existsSync(file)||!fs.statSync(file).isFile())continue;
     bytes=fs.readFileSync(file);
   }catch(error){
     roster.diagnostics.push('Canonical bytes unreadable at '+candidate+': '+String(error?.message??error));
     continue;
   }
   const sha=createHash('sha256').update(bytes).digest('hex');
   if(candidate===canonicalRel)roster.actualCanonicalSha256=sha;
   if(sha!==expectedSha){foundOtherHash=true;continue;}
   roster.actualArtifactPath=candidate;
   roster.actualCanonicalSha256=sha;
   let canonical;
   try{canonical=JSON.parse(bytes.toString('utf8'));}
   catch{
     roster.availability='CANONICAL_UNREADABLE';
     roster.diagnostics.push('Exact-hash artifact cannot be parsed as canonical JSON');
     return roster;
   }
   if(canonical?.schemaVersion!=='curveyield-lite-phase-canonical-data-v1'||
      canonical.phase!==phase||canonical.campaignId!==directory.campaignId){
     roster.availability='CANONICAL_IDENTITY_MISMATCH';
     roster.diagnostics.push('Canonical payload does not match accepted phase/campaign');
     return roster;
   }
   roster.availability='AVAILABLE';
   // Every JSON value under the three original evidence families receives an
   // exact pointer. This includes empty collections, nulls, negative evidence,
   // original nested objects, arbitrary field names, and every array position.
   // Use an explicit traversal stack so even deep evidence trees stay lossless.
   const escapePointer=k=>String(k).replace(/~/g,'~0').replace(/\//g,'~1');
   for(const family of ['actions','automationInputs','automationOutputs']){
     if(!Object.hasOwn(canonical,family)){
       roster.diagnostics.push('Original canonical root absent: '+family);
       continue;
     }
     const stack=[{value:canonical[family],pointer:'/'+family,arrayPosition:null}];
     while(stack.length){
       const node=stack.pop();
       const value=node.value;
       const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
       const row={selector:node.pointer,kind};
       if(node.arrayPosition!==null)row.originalArrayPosition=node.arrayPosition;
       // Original authored IDs are metadata only; the canonical JSON, with all
       // original identity fields unchanged, remains the authoritative value.
       if(value&&typeof value==='object'&&!Array.isArray(value)){
         const ids=Object.entries(value).filter(([key,v])=>
           /(?:id|key)$/i.test(key)&&(typeof v==='string'||typeof v==='number'));
         if(ids.length)row.originalIdentityFields=Object.fromEntries(ids);
       }
       roster.records.push(row);
       if(Array.isArray(value)){
         for(let i=value.length-1;i>=0;i--)stack.push({
           value:value[i],pointer:node.pointer+'/'+i,arrayPosition:i});
       }else if(value&&typeof value==='object'){
         const keys=Object.keys(value);
         for(let i=keys.length-1;i>=0;i--)stack.push({
           value:value[keys[i]],pointer:node.pointer+'/'+escapePointer(keys[i]),arrayPosition:null});
       }
     }
   }
   return roster;
 }
 roster.availability=foundOtherHash?'CANONICAL_HASH_MISMATCH':
   roster.diagnostics.length?'CANONICAL_READ_UNAVAILABLE':'CANONICAL_MISSING';
 roster.diagnostics.push(foundOtherHash
   ?'No current or archived canonical bytes match the accepted receipt SHA-256'
   :'Accepted canonical artifact not found at its original or existing superseded paths');
 return roster;
}

// Read historical accepted receipts on demand. Existing receipts/canonical
// files are never rewritten; distinct accepted revisions remain distinct.
export function collectAcceptedOriginalCanonicalEvidenceV1({root,campaignPath,directory,maxPhase=10}){
 const receiptDir=repoFile(root,path.posix.join(campaignPath,'receipts'));
 const rosters=[];
 if(!fs.existsSync(receiptDir))return {rosters,availability:'RECEIPTS_UNAVAILABLE'};
 const names=fs.readdirSync(receiptDir).sort();
 for(const phase of [1,2,3,4,5,6,8,9,10]){
   if(phase>maxPhase)continue;
   const re=new RegExp('^PHASE_'+String(phase).padStart(2,'0')+'_RECEIPT_v([0-9]+)\\.json$');
   const matched=names.filter(name=>re.test(name));
   if(!matched.length){
     const canonical=path.posix.join(campaignPath,'derived/phase-'+phase,
       'PHASE_'+String(phase).padStart(2,'0')+'_CANONICAL_DATA_v1.json');
     rosters.push({
       phase,canonicalArtifactPath:canonical,
       availability:fs.existsSync(repoFile(root,canonical))
         ?'ACCEPTANCE_RECEIPT_MISSING':'NO_ACCEPTED_CANONICAL_PUBLISHED',
       campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,
       auditedSourceSha256:directory.sourceSha256,
       expectedCanonicalSha256:null,actualCanonicalSha256:null,records:[]});
     continue;
   }
   for(const name of matched){
     const rel=path.posix.join(campaignPath,'receipts',name);
     let receipt;
     try{receipt=readJson(repoFile(root,rel));}
     catch(error){
       rosters.push({phase,receiptPath:rel,availability:'RECEIPT_UNREADABLE',
         diagnostics:[String(error?.message??error)],records:[]});
       continue;
     }
     if(receipt?.phase?.status==='SKIPPED'){
       rosters.push({
         phase,receiptPath:rel,acceptedRevision:receipt?.phase?.revision??null,
         campaignId:receipt?.campaign?.campaignId??null,
         campaignGenerationId:receipt?.campaign?.campaignGenerationId??null,
         auditedSourceSha256:receipt?.source?.sha256??null,
         availability:'PHASE_SKIPPED_NO_CANONICAL',
         diagnostics:['Receipt marks this optional phase SKIPPED; no accepted AI canonical exists'],
         records:[]});
       continue;
     }
     rosters.push(buildOriginalCanonicalEvidenceRosterV1({
       root,campaignPath,directory,phase,receipt,receiptRel:rel}));
   }
 }
 return {schemaVersion:'curveyield-original-canonical-evidence-history-v1',
   campaignId:directory.campaignId,campaignGenerationId:directory.campaignGenerationId,
   auditedSourceSha256:directory.sourceSha256,rosters};
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
