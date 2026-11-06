import fs from 'node:fs/promises';
import path from 'node:path';

// Optional source-package file naming the in-scope source paths for Phase-0 static analysis.
// Absent: the historical default applies (only `contracts/` is in scope; everything else is a
// dependency). Present but invalid: fail closed rather than silently analyzing the wrong scope.
export const AUDIT_SCOPE_FILE='audit-scope.json';
export const AUDIT_SCOPE_SCHEMA='curveyield-audit-scope-v1';
export const DEFAULT_IN_SCOPE_PATHS=Object.freeze(['contracts/']);

function normalizePrefix(value){
  if(typeof value!=='string'||!value.trim())throw new Error(`${AUDIT_SCOPE_FILE}: inScopePaths entries must be non-empty strings`);
  const normalized=value.trim().replaceAll('\\','/').replace(/^\.\//,'');
  if(normalized.startsWith('/')||normalized.split('/').some(part=>part==='..'))throw new Error(`${AUDIT_SCOPE_FILE}: unsafe in-scope path ${value}`);
  return /\.(?:sol|vy|js|mjs|cjs|ts|mts|cts|sh|json|ya?ml)$/i.test(normalized)||normalized.endsWith('/')?normalized:`${normalized}/`;
}

export function parseAuditScope(text){
  let parsed;
  try{parsed=JSON.parse(text);}catch(error){throw new Error(`${AUDIT_SCOPE_FILE}: invalid JSON (${error.message})`);}
  if(parsed?.schemaVersion!==AUDIT_SCOPE_SCHEMA)throw new Error(`${AUDIT_SCOPE_FILE}: schemaVersion must be ${AUDIT_SCOPE_SCHEMA}`);
  if(!Array.isArray(parsed.inScopePaths)||!parsed.inScopePaths.length)throw new Error(`${AUDIT_SCOPE_FILE}: inScopePaths must be a non-empty array`);
  return{source:AUDIT_SCOPE_FILE,inScopePaths:[...new Set(parsed.inScopePaths.map(normalizePrefix))].sort(),
    excludedPaths:Array.isArray(parsed.excludedPaths)?[...new Set(parsed.excludedPaths.map(normalizePrefix))].sort():[]};
}

export async function loadAuditScope(projectRoot){
  let text;
  try{text=await fs.readFile(path.join(projectRoot,AUDIT_SCOPE_FILE),'utf8');}
  catch(error){
    if(error?.code==='ENOENT'){
      // Foundry packages put production contracts in src/. The absence of
      // audit-scope.json must not silently classify all audited src/ files
      // as external dependencies just because this is not a Hardhat layout.
      try{
        const toml=await fs.readFile(path.join(projectRoot,'foundry.toml'),'utf8');
        const src=toml.match(/^\s*src\s*=\s*["']([^"']+)["']/m)?.[1]??'src';
        const normalized=normalizePrefix(src);
        if(!normalized.endsWith('/'))throw new Error('Foundry source root is not a directory');
        return{source:'foundry.toml',inScopePaths:[normalized],excludedPaths:[]};
      }catch(foundryError){
        if(foundryError?.code!=='ENOENT')throw foundryError;
      }
      return{source:'default',inScopePaths:[...DEFAULT_IN_SCOPE_PATHS],excludedPaths:[]};
    }
    throw error;
  }
  return parseAuditScope(text);
}

export function sourceIsInScope(sourceName,scope){
  const name=String(sourceName).replaceAll('\\','/');
  const matches=prefixes=>prefixes.some(prefix=>prefix.endsWith('/')?name.startsWith(prefix):name===prefix);
  return !matches(scope?.excludedPaths??[])&&matches(scope?.inScopePaths??DEFAULT_IN_SCOPE_PATHS);
}

export function sourceExplicitlyExcludedV1(sourceName,scope){
  const name=String(sourceName).replaceAll('\\','/');
  return (scope?.excludedPaths??[]).some(prefix=>
    prefix.endsWith('/')?name.startsWith(prefix):name===prefix);
}
