import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { canonicalJsonV1, digestCanonicalV1, sha256HexV1 } from './canonical-json-v1.mjs';

const SKIP=new Set(['.git','node_modules','.cache','cache','coverage']);
function posix(path){ return path.split(sep).join('/'); }
function language(path){ return path.endsWith('.sol')?'solidity':path.endsWith('.vy')?'vyper':'other'; }
function depKind(path){ const n=path.toLowerCase(); if(n.endsWith('package-lock.json'))return'package-lock'; if(n.endsWith('foundry.lock'))return'foundry-lock'; if(n.includes('requirements')&&n.endsWith('.txt'))return'requirements'; return'other'; }
function hexDigest(value){ if(typeof value!=='string'||!/^0x[0-9a-fA-F]*$/.test(value))return null; return sha256HexV1(Buffer.from(value.slice(2),'hex')); }
async function walk(root,dir=root,out=[]){ for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){ if(SKIP.has(entry.name))continue; const full=join(dir,entry.name); if(entry.isDirectory()) await walk(root,full,out); else if(entry.isFile()) out.push(full); } return out; }
function withoutDigest(sbom){ const {sbomDigest,...rest}=sbom; return rest; }

export function computeBuildSbomDigestV1(sbom){ return digestCanonicalV1(withoutDigest(sbom)); }

export async function generateBuildSbomV1({projectRoot,request,build}){
  if(typeof projectRoot!=='string'||!projectRoot) throw new TypeError('projectRoot is required');
  const files=await walk(projectRoot);
  const sourceFiles=[]; const dependencyFiles=[];
  for(const full of files){ const path=posix(relative(projectRoot,full)); const lower=path.toLowerCase();
    if(lower.endsWith('.sol')||lower.endsWith('.vy')){ const bytes=await readFile(full); sourceFiles.push({path,language:language(path),sha256:sha256HexV1(bytes),bytes:bytes.length}); }
    else if(lower.endsWith('package-lock.json')||lower.endsWith('foundry.lock')||(lower.includes('requirements')&&lower.endsWith('.txt'))){ const bytes=await readFile(full); dependencyFiles.push({path,sha256:sha256HexV1(bytes),kind:depKind(path)}); }
  }
  sourceFiles.sort((a,b)=>a.path.localeCompare(b.path)); dependencyFiles.sort((a,b)=>a.path.localeCompare(b.path));
  const artifacts=(build?.artifacts??[]).map((artifact)=>({
    sourceName:String(artifact.sourceName??''), contractName:String(artifact.contractName??''),
    artifactSha256:digestCanonicalV1(artifact), bytecodeSha256:hexDigest(artifact.bytecode), deployedBytecodeSha256:hexDigest(artifact.deployedBytecode)
  })).sort((a,b)=>`${a.sourceName}:${a.contractName}`.localeCompare(`${b.sourceName}:${b.contractName}`));
  const source=request?.source??{};
  const sbom={ schemaVersion:'audit-v7-build-sbom-v1', source:{ repository:source.repository??null, commit:source.commit??build?.sourceCommit??null, archivePath:source.archivePath??null, archiveSha256:source.archiveSha256??null, projectPath:source.projectPath??'.' }, buildIdentity:{ compilerDescriptors:structuredClone(build?.compilerDescriptors??[]), optimizer:structuredClone(build?.optimizer??null), evmVersion:build?.evmVersion??null, viaIR:build?.viaIR===true }, sourceFiles, dependencyFiles, artifacts };
  return {...sbom,sbomDigest:computeBuildSbomDigestV1(sbom)};
}

function mapBy(items,key){ return new Map((items??[]).map(x=>[key(x),x])); }
function changedKeys(prior,current,key){ const a=mapBy(prior,key), b=mapBy(current,key), out=[]; for(const k of [...new Set([...a.keys(),...b.keys()])].sort()){ if(a.has(k)&&b.has(k)&&canonicalJsonV1(a.get(k))!==canonicalJsonV1(b.get(k))) out.push(k); } return out; }
export function reconcileBuildSbomV1({prior,current}){
  const aSrc=mapBy(prior?.sourceFiles??[],x=>x.path), bSrc=mapBy(current?.sourceFiles??[],x=>x.path);
  const addedSourceFiles=[...bSrc.keys()].filter(k=>!aSrc.has(k)).sort();
  const removedSourceFiles=[...aSrc.keys()].filter(k=>!bSrc.has(k)).sort();
  const changedSourceFiles=changedKeys(prior?.sourceFiles??[],current?.sourceFiles??[],x=>x.path);
  const changedArtifacts=changedKeys(prior?.artifacts??[],current?.artifacts??[],x=>`${x.sourceName}:${x.contractName}`);
  const changedBuildIdentity=canonicalJsonV1(prior?.buildIdentity??null)!==canonicalJsonV1(current?.buildIdentity??null);
  const status=addedSourceFiles.length||removedSourceFiles.length||changedSourceFiles.length||changedArtifacts.length||changedBuildIdentity?'CHANGED':'IDENTICAL';
  return {status,addedSourceFiles,removedSourceFiles,changedSourceFiles,changedArtifacts,changedBuildIdentity};
}
