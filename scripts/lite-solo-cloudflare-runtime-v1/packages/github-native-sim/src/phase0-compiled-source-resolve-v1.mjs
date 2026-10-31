// Locates a compiled source by its solc source name inside the staged project, including
// remapped imports served from a vendored package's own node_modules.
import fs from 'node:fs/promises';
import path from 'node:path';

async function isFile(file){try{return(await fs.stat(file)).isFile();}catch{return false;}}
const nestedNodeModulesCache=new Map();
async function nestedNodeModules(projectRoot,maxDepth=4){
  if(nestedNodeModulesCache.has(projectRoot))return nestedNodeModulesCache.get(projectRoot);
  const found=[];
  async function walk(dir,depth){
    let entries=[];try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
    for(const e of entries.sort((x,y)=>x.name.localeCompare(y.name))){
      if(!e.isDirectory()||e.name==='.git')continue;
      const full=path.join(dir,e.name);
      if(e.name==='node_modules'){found.push(full);continue;}
      if(depth<maxDepth)await walk(full,depth+1);
    }
  }
  await walk(projectRoot,0);
  nestedNodeModulesCache.set(projectRoot,found);
  return found;
}
export async function resolveCompiledSourceFile(projectRoot, sourceName){
  const candidates=[
    path.resolve(projectRoot, sourceName),
    path.resolve(projectRoot, 'node_modules', sourceName)
  ];
  for(const candidate of candidates){
    if(await isFile(candidate))return candidate;
  }
  // Vendored packages keep their own node_modules (e.g. dep/node_modules/@scope/pkg), which a build
  // config may only link into the root at compile time; a cached build never runs that config.
  for(const dir of await nestedNodeModules(projectRoot)){
    const candidate=path.resolve(dir,sourceName);
    if(candidate.startsWith(dir+path.sep)&&await isFile(candidate))return candidate;
  }
  throw new Error(`compiled source is missing from staged project: ${sourceName}`);
}
