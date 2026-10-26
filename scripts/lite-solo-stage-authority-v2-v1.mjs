#!/usr/bin/env node
// Stage a NEW unbound authority release. Existing v1 and receipts untouched.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const controllerRoot=process.argv[2];
if(!controllerRoot||!fs.statSync(controllerRoot,{throwIfNoEntry:false})?.isDirectory())
 throw Error('Usage: node scripts/lite-solo-stage-authority-v2-v1.mjs AUDIT_CONTROLLER_ROOT');
const source=path.join(controllerRoot,'Audit Skill - Lite-Solo Authority','lite-solo');
const destination=path.join(controllerRoot,'Audit Skill - Lite-Solo Authority','lite-solo-v2');
if(fs.existsSync(destination))throw Error('Existing v2 cannot be overwritten');
const digest=data=>createHash('sha256').update(data).digest('hex');
const manifest=JSON.parse(fs.readFileSync(path.join(source,'MANIFEST.json'),'utf8'));
if(manifest.release!=='lite-solo-v1'||manifest.mode!=='LITE_SOLO'||!Array.isArray(manifest.files)||manifest.files.length<145)
 throw Error('unexpected v1 authority');
for(const entry of manifest.files){
 if(!entry.path||entry.path.startsWith('/')||entry.path.split('/').some(x=>x==='.'||x==='..'))
  throw Error('unsafe manifest file');
 const data=fs.readFileSync(path.join(source,entry.path));
 if(data.length!==entry.bytes||digest(data)!==entry.sha256)
  throw Error('v1 authority digest mismatch: '+entry.path);
}
fs.cpSync(source,destination,{recursive:true,force:false,errorOnExist:true});
const override=[
 '# Lite-Solo v2: controller integration and security precedence',
 '',
 'This is a new authority release, not the bound v1 of any existing campaign.',
 'Use curveyield3/Contract-Automation .github/workflows/lite-solo-phase-controller-v1.yml.',
 'Phase 5/6 candidate review uses validation-only batches of at most 16 candidates',
 'with <=256 KiB of selected record bytes; checkpoints never imply a phase PASS.',
 'A separate test executor or browser wake is neither required nor authorized.',
 'An arbitrary 100,000-call fuzz budget is not mandatory in the targeted controller.',
 'Only exact source-bound human-approved V7 execution may be dispatched.',
 'Phase-0 fuzz results are not Phase-5 targeted machine execution evidence.',
 'Source-only RESOLVED_NON_MATERIAL is unsupported without independent verification.',
 'New mandatory security obligations are due for evidence-backed closure in Phase 6.',
 'Phases 8/9/10 have no bound obligation-disposition closure field in this release.',
 'Do not silently carry mandatory obligations to unsupported later phases.',
 'Process COMPLETE is distinct from evidence-backed security assurance.',
 '',
 '---',
 ''
].join('\n');
for(const rel of ['SKILL.md','phases/phase-5/START_HERE.md','phases/phase-6/START_HERE.md']){
 const p=path.join(destination,rel);
 fs.writeFileSync(p,override+fs.readFileSync(p,'utf8'));
}
const schemaPath=path.join(destination,'phases/phase-6/PHASE_06_SCHEMA_v1.json');
const schema=JSON.parse(fs.readFileSync(schemaPath,'utf8'));
const matches=[];
for(const action of Object.values(schema.actions??{}))
 for(const field of action.fields??[])
  if(field.name==='obligationDispositions')matches.push(field);
if(matches.length!==1)throw Error('Phase-6 schema obligation field unexpected');
matches[0].itemFieldAllowedValues.disposition=['SATISFIED','NOT_APPLICABLE'];
matches[0].itemFieldAllowedValues.carryForwardPhaseOrNone=['NONE_IDENTIFIED'];
fs.writeFileSync(schemaPath,JSON.stringify(schema,null,2)+'\n');
const v2={...manifest,release:'lite-solo-v2',packageRevision:'v2',
 stagedFromRelease:'lite-solo-v1',
 activationPolicy:'NEW_CAMPAIGN_OR_EXPLICIT_RECEIPT_PRESERVING_REBIND_ONLY',
 files:manifest.files.map(row=>{
  const data=fs.readFileSync(path.join(destination,row.path));
  return {path:row.path,bytes:data.length,sha256:digest(data)};
 })};
fs.writeFileSync(path.join(destination,'MANIFEST.json'),JSON.stringify(v2,null,2)+'\n');
for(const row of v2.files){
 const data=fs.readFileSync(path.join(destination,row.path));
 if(data.length!==row.bytes||digest(data)!==row.sha256)
  throw Error('v2 manifest failed: '+row.path);
}
console.log(JSON.stringify({status:'STAGED_ONLY',release:v2.release,
 files:v2.files.length,manifestSha256:digest(fs.readFileSync(path.join(destination,'MANIFEST.json'))),
 note:'Existing v1 remains bound. Activation is not performed.'}));
