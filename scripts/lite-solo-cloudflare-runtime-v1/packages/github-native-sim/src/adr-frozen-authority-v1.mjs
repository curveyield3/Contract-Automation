import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const registryPath='audit-process/v7/frozen-authorities/FROZEN_AUTHORITY_REGISTRY_v1.json';
const defaultEntry=Object.freeze({
  release:'Audit_Litemode_v10.3',
  logicalRoot:'Audit Skill - Current Authority/Audit_Litemode_v10.3',
  frozenRoot:'audit-process/v7/frozen-authorities/Audit_Litemode_v10.3',
  skillSha256:'bdb90107ea50580e67be91440ce47087de570c4f54b8474c5a3eb852af95ea27',
  manifestSha256:'846be5f90d6e00757b817b1218dfabeb2aa4dff6c92b8e9ff47335d2db83703a'
});

function safeRel(rel){
  if(typeof rel!=='string'||!rel||rel.startsWith('/')||rel.split('/').includes('..')||rel.split('/').includes('.'))
    throw new Error('unsafe frozen authority path: '+rel);
  return rel;
}
function absolute(root,rel){return path.join(root,...safeRel(rel).split('/'));}
function sha(file){return createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function label(entry){return 'frozen '+entry.release.replace('Audit_Litemode_v','')+' authority';}
function matching(entry,rel){return rel===entry.logicalRoot||rel.startsWith(entry.logicalRoot+'/');}

export function loadFrozenAuthorityRegistryV1(root){
  const file=absolute(root,registryPath);
  if(!fs.existsSync(file))return {schemaVersion:'curveyield-frozen-authority-registry-v1',entries:[{...defaultEntry}]};
  const registry=JSON.parse(fs.readFileSync(file,'utf8'));
  if(registry.schemaVersion!=='curveyield-frozen-authority-registry-v1'||!Array.isArray(registry.entries)||!registry.entries.length)
    throw new Error('frozen authority registry is malformed');
  const roots=new Set();
  const frozenRoots=new Set();
  for(const entry of registry.entries){
    if(!entry||typeof entry.release!=='string'||!/^Audit_Litemode_v[0-9]+(?:\.[0-9]+)?$/.test(entry.release)
      ||typeof entry.logicalRoot!=='string'||typeof entry.frozenRoot!=='string'
      ||!/^([0-9a-f]{64})$/.test(entry.skillSha256)||!/^([0-9a-f]{64})$/.test(entry.manifestSha256))
      throw new Error('frozen authority registry entry is malformed');
    safeRel(entry.logicalRoot);safeRel(entry.frozenRoot);
    // Multiple immutable revisions may share one historical logical root;
    // discriminate by exact receipt-bound SKILL hash, never by release label.
    const identity=entry.logicalRoot+'#'+entry.skillSha256;
    if(roots.has(identity)||frozenRoots.has(entry.frozenRoot))throw new Error('duplicate frozen authority identity/root: '+identity);
    roots.add(identity);frozenRoots.add(entry.frozenRoot);
  }
  return registry;
}

export function inspectFrozenAuthorityV1(root,entry){
  const frozenRoot=absolute(root,entry.frozenRoot), tag=label(entry);
  const skill=path.join(frozenRoot,'SKILL.md');
  if(!fs.existsSync(skill)||sha(skill)!==entry.skillSha256)throw new Error(tag+' root hash mismatch');
  const manifestFile=path.join(frozenRoot,'MANIFEST.json');
  if(!fs.existsSync(manifestFile)||sha(manifestFile)!==entry.manifestSha256)throw new Error(tag+' manifest digest mismatch');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(manifest.release!==entry.release||manifest.entrypoint!=='SKILL.md')throw new Error(tag+' manifest identity mismatch');
  const entries=manifest.files??[];
  if(!Array.isArray(entries)||entries.length===0)throw new Error(tag+' manifest files are missing');
  const seen=new Set();
  for(const item of entries){
    const itemPath=safeRel(item?.path);
    if(seen.has(itemPath))throw new Error(tag+' manifest has duplicate path: '+itemPath);
    seen.add(itemPath);
    if(!Number.isInteger(item?.bytes)||item.bytes<0||!/^([0-9a-f]{64})$/.test(String(item?.sha256??'')))
      throw new Error(tag+' manifest entry is malformed: '+itemPath);
    const target=path.join(frozenRoot,...itemPath.split('/'));
    if(!fs.existsSync(target)||!fs.statSync(target).isFile()||fs.statSync(target).size!==item.bytes||sha(target)!==item.sha256)
      throw new Error(tag+' file digest mismatch: '+itemPath);
  }
  return {frozenRoot,manifest,seen,skillSha256:sha(skill),manifestSha256:sha(manifestFile)};
}

export function resolveFrozenAuthorityFileV1(root,rel){
  safeRel(rel);
  const logical=absolute(root,rel);
  if(fs.existsSync(logical))return null;
  const matches=loadFrozenAuthorityRegistryV1(root).entries.filter(e=>matching(e,rel));
  if(matches.length>1)throw new Error('ambiguous frozen authority logical root; resolve from receipt digest first: '+rel);
  const entry=matches[0];
  if(!entry)return null;
  const {frozenRoot,seen}=inspectFrozenAuthorityV1(root,entry);
  const suffix=rel.slice(entry.logicalRoot.length).replace(/^\//,'');
  if(suffix&&suffix!=='MANIFEST.json'&&!seen.has(suffix))
    throw new Error(label(entry)+' manifest does not admit '+suffix);
  return suffix?path.join(frozenRoot,...suffix.split('/')):frozenRoot;
}

export function authorityLinkPathV1(root,rel){
  if(typeof rel!=='string')return rel;
  if(fs.existsSync(absolute(root,rel)))return rel;
  const matches=loadFrozenAuthorityRegistryV1(root).entries.filter(e=>matching(e,rel));
  if(matches.length>1)throw new Error('ambiguous authority link; select exact frozen root from receipt identity: '+rel);
  const entry=matches[0];
  if(!entry)return rel;
  // Fail closed on corrupt frozen copies before exposing a reviewer authority link.
  resolveFrozenAuthorityFileV1(root,rel);
  return entry.frozenRoot+rel.slice(entry.logicalRoot.length);
}
