import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Optional source-package file declaring how Phase 0 deploys/configures the package on a fork.
// Absent: the historical canonical-Ethereum adapters apply unchanged. Present: Phase 0 runs exactly
// the declared Foundry scripts, in order, on an isolated Anvil fork of the declared chain while
// impersonating the declared deployer. The package supplies data only; the runner owns every command,
// the RPC secret and the chain registry. Present but invalid: fail closed.
export const AUDIT_DEPLOYMENT_FILE='audit-deployment.json';
export const AUDIT_DEPLOYMENT_SCHEMA='curveyield-audit-deployment-v1';
export const PHASE0_DEPLOYMENT_PROFILE_FRAMEWORKS=Object.freeze({FOUNDRY:'FOUNDRY_PROFILE',HARDHAT:'HARDHAT_PROFILE'});

export const PHASE0_FORK_CHAINS=Object.freeze({
  ethereum:Object.freeze({chain:'ethereum',chainId:1,rpcSecret:'RPC_ETHEREUM',localRpcEnv:'ETH_RPC_URL'}),
  katana:Object.freeze({chain:'katana',chainId:747474,rpcSecret:'RPC_KATANA',localRpcEnv:'KATANA_RPC_URL'})
});
export const PHASE0_FORK_CHAIN_IDS=new Set(Object.values(PHASE0_FORK_CHAINS).map(x=>x.chainId));

const MAX_SCRIPTS=12;
const MAX_SCRIPT_TIMEOUT_SECONDS=900;
const MAX_TOTAL_SECONDS=2000;
// Script env is plain data for the package's own vm.env* reads. Anything that could redirect the
// RPC, the signer, tool behaviour or process loading is runner-owned and rejected.
const ENV_KEY_RE=/^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV_RE=/^(?:PATH|HOME|USER|SHELL|TMPDIR|LANG|LC_.*|CI|NODE_.*|NPM_.*|LD_.*|DYLD_.*|FOUNDRY_.*|DAPP_.*|ETH_.*|.*RPC.*|.*PRIVATE_KEY.*|.*MNEMONIC.*|.*SECRET.*|.*TOKEN.*|DEPLOYER|SENDER|PHASE0_.*|GITHUB_.*|RUNNER_.*)$/;

const sha256=value=>createHash('sha256').update(value).digest('hex');
function fail(message){throw new Error(`${AUDIT_DEPLOYMENT_FILE}: ${message}`);}

function safeRelative(value,label,{allowDot=false}={}){
  if(typeof value!=='string'||!value.trim())fail(`${label} must be a non-empty relative path`);
  const normalized=value.trim().replaceAll('\\','/').replace(/^\.\//,'').replace(/\/+$/,'')||'.';
  if(normalized==='.'&&allowDot)return '.';
  if(normalized.startsWith('/')||normalized.split('/').some(part=>part==='..'||part===''||part==='.'))fail(`unsafe ${label} ${value}`);
  return normalized;
}

function parseScript(item,index){
  const label=`scripts[${index}]`;
  const raw=typeof item==='string'?{entry:item}:item;
  if(!raw||typeof raw!=='object')fail(`${label} must be an entry string or object`);
  const match=String(raw.entry??'').match(/^(.+\.s\.sol):([A-Za-z_][A-Za-z0-9_]*)$/);
  if(!match)fail(`${label}.entry must be "<path>.s.sol:<Contract>"`);
  const scriptPath=safeRelative(match[1],`${label}.entry path`);
  const env={};
  for(const [key,value] of Object.entries(raw.env??{})){
    if(!ENV_KEY_RE.test(key)||RESERVED_ENV_RE.test(key))fail(`${label}.env key ${key} is not allowed`);
    if(typeof value!=='string'||value.length>512||/[\r\n\0]/.test(value))fail(`${label}.env.${key} must be a single-line string`);
    env[key]=value;
  }
  const timeoutSeconds=raw.timeoutSeconds??600;
  if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<30||timeoutSeconds>MAX_SCRIPT_TIMEOUT_SECONDS)fail(`${label}.timeoutSeconds must be an integer in [30, ${MAX_SCRIPT_TIMEOUT_SECONDS}]`);
  return{entry:`${scriptPath}:${match[2]}`,path:scriptPath,contract:match[2],env,timeoutSeconds};
}

// One package Hardhat entrypoint, run by the runner as `npx --no-install hardhat run --no-compile <script>
// --network <network>` from a locked install; the network must bind to the runner's local RPC env.
function parseHardhat(raw){
  if(!raw||typeof raw!=='object')fail('hardhat must be an object');
  const root=safeRelative(raw.root??'.','hardhat.root',{allowDot:true});
  const script=safeRelative(raw.script,'hardhat.script');
  if(!/\.(?:c?js|mjs|ts)$/.test(script))fail('hardhat.script must be a .js/.cjs/.mjs/.ts file');
  const network=raw.network??'localhost';
  if(typeof network!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(network))fail('hardhat.network must be a simple network name');
  const timeoutSeconds=raw.timeoutSeconds??1800;
  if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<60||timeoutSeconds>MAX_TOTAL_SECONDS)fail(`hardhat.timeoutSeconds must be an integer in [60, ${MAX_TOTAL_SECONDS}]`);
  return{root,script,network,timeoutSeconds};
}

export function parseDeploymentProfile(text){
  let parsed;
  try{parsed=JSON.parse(text);}catch(error){fail(`invalid JSON (${error.message})`);}
  if(parsed?.schemaVersion!==AUDIT_DEPLOYMENT_SCHEMA)fail(`schemaVersion must be ${AUDIT_DEPLOYMENT_SCHEMA}`);
  const chain=PHASE0_FORK_CHAINS[parsed.chain];
  if(!chain)fail(`unsupported chain ${JSON.stringify(parsed.chain)}; supported: ${Object.keys(PHASE0_FORK_CHAINS).join(', ')}`);
  if(parsed.mode==='LIVE'){
    if(parsed.scripts!==undefined||parsed.hardhat!==undefined||parsed.foundryRoot!==undefined)fail('LIVE mode does not accept deployment scripts');
    if(!Array.isArray(parsed.contracts)||parsed.contracts.length<1||parsed.contracts.length>64)fail('LIVE contracts must list 1-64 exact runtime targets');
    const contracts=parsed.contracts.map((row,index)=>{
      if(!row||!/^0x[0-9a-fA-F]{40}$/.test(row.address??'')||/^0x0{40}$/i.test(row.address))fail('invalid LIVE contract address at '+index);
      if(typeof row.qualifiedName!=='string'||!/^.+\.sol:[A-Za-z_][A-Za-z0-9_]*$/.test(row.qualifiedName))fail('LIVE qualifiedName must identify an admitted compiler artifact');
      return{address:row.address,qualifiedName:row.qualifiedName};
    });
    if(new Set(contracts.map(x=>x.address.toLowerCase())).size!==contracts.length)fail('duplicate LIVE address');
    return{chain:chain.chain,chainId:chain.chainId,mode:'LIVE',contracts};
  }
  if(typeof parsed.deployer!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(parsed.deployer))fail('deployer must be a 20-byte hex address');
  const base={chain:chain.chain,chainId:chain.chainId,deployer:parsed.deployer};
  if(parsed.hardhat!==undefined){
    if(parsed.scripts!==undefined||parsed.foundryRoot!==undefined)fail('declare either hardhat or scripts/foundryRoot, not both');
    return{...base,mode:'HARDHAT',hardhat:parseHardhat(parsed.hardhat)};
  }
  const foundryRoot=safeRelative(parsed.foundryRoot??'.','foundryRoot',{allowDot:true});
  if(!Array.isArray(parsed.scripts)||parsed.scripts.length<1||parsed.scripts.length>MAX_SCRIPTS)fail(`scripts must list 1-${MAX_SCRIPTS} Foundry script entries`);
  const scripts=parsed.scripts.map(parseScript);
  if(new Set(scripts.map(x=>x.entry)).size!==scripts.length)fail('scripts must not repeat an entry');
  if(scripts.reduce((n,x)=>n+x.timeoutSeconds,0)>MAX_TOTAL_SECONDS)fail(`total script timeout exceeds ${MAX_TOTAL_SECONDS}s`);
  return{...base,mode:'FOUNDRY',foundryRoot,scripts};
}

// forge 1.7.1 ignores FOUNDRY_FFI=false when foundry.toml enables ffi, so a package that could shell
// out (ffi) or read outside its own tree (fs_permissions) is refused rather than "overridden".
export function assertSafeFoundryConfig(text){
  const body=String(text).replace(/#[^\n]*/g,'');
  if(/^\s*ffi\s*=\s*true\b/m.test(body))fail('foundry.toml enables ffi; Phase-0 profile deployments require ffi disabled');
  for(const m of body.matchAll(/path\s*=\s*["']([^"']*)["']/g)){
    const p=m[1].replaceAll('\\','/');
    if(p.startsWith('/')||/^[A-Za-z]:/.test(p)||p.split('/').includes('..'))fail(`foundry.toml fs_permissions path ${m[1]} escapes the Foundry project`);
  }
  return true;
}

export async function loadDeploymentProfile(projectRoot){
  let bytes;
  try{bytes=await fs.readFile(path.join(projectRoot,AUDIT_DEPLOYMENT_FILE));}
  catch(error){if(error?.code==='ENOENT')return null;throw error;}
  const profile=parseDeploymentProfile(bytes.toString('utf8'));
  const fileSha256=sha256(bytes);
  if(profile.mode==='LIVE')return{...profile,file:AUDIT_DEPLOYMENT_FILE,fileSha256};
  if(profile.mode==='HARDHAT')return{...profile,hardhat:await loadHardhatEntry(projectRoot,profile.hardhat),file:AUDIT_DEPLOYMENT_FILE,fileSha256};
  const root=profile.foundryRoot==='.'?projectRoot:path.join(projectRoot,...profile.foundryRoot.split('/'));
  let foundryToml;
  try{foundryToml=await fs.readFile(path.join(root,'foundry.toml'),'utf8');}catch{fail(`foundryRoot ${profile.foundryRoot} has no foundry.toml`);}
  assertSafeFoundryConfig(foundryToml);
  const scripts=[];
  for(const script of profile.scripts){
    let scriptBytes;
    try{scriptBytes=await fs.readFile(path.join(root,...script.path.split('/')));}
    catch{fail(`script ${script.entry} is missing under ${profile.foundryRoot}`);}
    const text=scriptBytes.toString('utf8');
    if(!new RegExp(`contract\\s+${script.contract}\\b`).test(text))fail(`script ${script.path} does not declare contract ${script.contract}`);
    scripts.push({...script,sha256:sha256(scriptBytes)});
  }
  return{...profile,scripts,file:AUDIT_DEPLOYMENT_FILE,fileSha256};
}

async function loadHardhatEntry(projectRoot,hardhat){
  const root=hardhat.root==='.'?projectRoot:path.join(projectRoot,...hardhat.root.split('/'));
  const names=await fs.readdir(root).catch(()=>fail(`hardhat.root ${hardhat.root} does not exist`));
  const config=names.find(n=>/^hardhat\.config\.(?:c?js|mjs|ts)$/.test(n));
  if(!config)fail(`hardhat.root ${hardhat.root} has no hardhat.config`);
  if(!names.includes('package.json')||!names.includes('package-lock.json'))fail(`hardhat.root ${hardhat.root} needs package.json and package-lock.json`);
  // The entrypoint may drive Forge; the same Foundry safety rules apply to a co-located foundry.toml.
  if(names.includes('foundry.toml'))assertSafeFoundryConfig(await fs.readFile(path.join(root,'foundry.toml'),'utf8'));
  let scriptBytes;
  try{scriptBytes=await fs.readFile(path.join(root,...hardhat.script.split('/')));}catch{fail(`hardhat.script ${hardhat.script} is missing under ${hardhat.root}`);}
  const configBytes=await fs.readFile(path.join(root,config));
  return{...hardhat,config,scriptSha256:sha256(scriptBytes),configSha256:sha256(configBytes)};
}

export function phase0ForkChainForProfile(profile){
  return PHASE0_FORK_CHAINS[profile?.chain??'ethereum'];
}

export function resolvePhase0ForkUrl({profile,forkUrl,forkUrls={}}){
  const chain=phase0ForkChainForProfile(profile);
  const url=chain.chain==='ethereum'?forkUrl:forkUrls[chain.chain];
  if(typeof url!=='string'||!url){
    const error=new Error(`${chain.rpcSecret} secret is missing; ${AUDIT_DEPLOYMENT_FILE} requires a ${chain.chain} fork`);
    error.code='PHASE0_FORK_RPC_MISSING';throw error;
  }
  return url;
}

// Deploy evidence is valid on Ethereum (historical lane) or on a chain declared by a recorded profile.
export function assertPhase0ForkIdentity(e){
  const chainId=e?.fork?.chainId;
  if(e?.fork?.engine!=='anvil'||!PHASE0_FORK_CHAIN_IDS.has(chainId)||e?.fork?.identityNormalized!==true)throw new Error('Invalid Anvil fork identity');
  if(chainId!==1){
    const p=e.deploymentProfile;
    const inferred=e.foundryChainDetection;
    const profileMatches=p&&p.chainId===chainId&&PHASE0_FORK_CHAINS[p.chain]?.chainId===chainId&&e.fork.chain===p.chain;
    const inferredMatches=!p&&inferred?.mode==='SOURCE_FOUNDRY_ENDPOINT_UNIQUE'&&inferred.file==='foundry.toml'&&
      /^[0-9a-f]{64}$/.test(inferred.configSha256??'')&&inferred.chainId===chainId&&
      PHASE0_FORK_CHAINS[inferred.chain]?.chainId===chainId&&e.fork.chain===inferred.chain&&
      /^[0-9a-f]{64}$/.test(e.sourceSha256??'');
    if((!profileMatches&&!inferredMatches)||e.fork.upstreamChainId!==chainId)
      throw new Error('Non-Ethereum fork evidence lacks matching source-bound Foundry chain identity and upstream chain');
  }
  return true;
}

 // Flattened explorer sources may reconstruct the same executable runtime with a
 // different Swarm content hash. Admit only the proven legacy CBOR layout:
 // {bzzr1: bytes32, solc: bytes3}, with all other runtime bytes identical.
 export function compareLiveRuntimeV1(observed,compiled,{allowScanMetadata=false}={}){
   const normalize=value=>typeof value==='string'&&/^0x(?:[0-9a-f]{2})+$/i.test(value)?value.toLowerCase():null;
   const a=normalize(observed),b=normalize(compiled);
   if(!a||!b)return{sourceBinding:'MISMATCH'};
   if(a===b)return{sourceBinding:'EXACT_COMPILED_RUNTIME'};
   if(!allowScanMetadata||a.length!==b.length)return{sourceBinding:'MISMATCH'};
   const layout=/a265627a7a72315820([0-9a-f]{64})64736f6c6343([0-9a-f]{6})0032$/;
   const am=a.match(layout),bm=b.match(layout);
   if(!am||!bm||am[2]!==bm[2]||a.slice(0,-104)!==b.slice(0,-104))return{sourceBinding:'MISMATCH'};
   return{sourceBinding:'EXECUTABLE_RUNTIME_MATCH_METADATA_HASH_ONLY',
     metadataDifference:{format:'SOLC_LEGACY_CBOR_BZZR1_SOLC',compilerBytes:am[2],observedSwarmHash:am[1],compiledSwarmHash:bm[1]},
     executableRuntimeSha256:sha256(Buffer.from(a.slice(2,-104),'hex'))};
 }

// Inferred only when a source-authored Foundry config has a unique supported
// RPC endpoint. This does not synthesize a deployment profile or waive
// source-native execution; it selects the fork for a ZIP with no profile.
export async function inferPhase0FoundryChainV1(projectRoot,profile){
  if(profile)return null;
  const file=path.join(projectRoot,'foundry.toml');
  let bytes;try{bytes=await fs.readFile(file);}catch(e){if(e?.code==='ENOENT')return null;throw e;}
  let section='',endpoints=[];
  for(const raw of bytes.toString('utf8').split(/\r?\n/)){
    const line=raw.replace(/#.*$/,'').trim();
    const header=line.match(/^\[([^\]]+)\]$/);
    if(header){section=header[1];continue;}
    if(section==='rpc_endpoints'){
      const entry=line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=/);
      if(entry)endpoints.push(entry[1].toLowerCase());
    }
  }
  endpoints=[...new Set(endpoints)];
  if(!endpoints.length)return null;
  if(endpoints.length!==1||!PHASE0_FORK_CHAINS[endpoints[0]])
    throw new Error('Foundry source declares ambiguous or unsupported RPC endpoints; an explicit audit-deployment.json is required');
  const chain=PHASE0_FORK_CHAINS[endpoints[0]];
  return {mode:'SOURCE_FOUNDRY_ENDPOINT_UNIQUE',file:'foundry.toml',
    configSha256:sha256(bytes),chain:chain.chain,chainId:chain.chainId};
}
