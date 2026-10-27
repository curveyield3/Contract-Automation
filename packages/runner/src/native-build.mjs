import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../../github-native-sim/src/execution.mjs';

const HARDHAT_CONFIGS = [
  'hardhat.config.js',
  'hardhat.config.cjs',
  'hardhat.config.mjs',
  'hardhat.config.ts'
];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

const FROZEN_BALANCER_VENDOR_PACKAGES = Object.freeze([
  ['v3-interfaces', ['vendor', 'balancer-v3-upstream', 'pkg', 'interfaces']],
  ['v3-vault', ['vendor', 'balancer-v3-upstream', 'pkg', 'vault']],
  ['v3-pool-utils', ['vendor', 'balancer-v3-upstream', 'pkg', 'pool-utils']],
  ['v3-solidity-utils', ['vendor', 'balancer-v3-upstream', 'pkg', 'solidity-utils']],
  ['v3-pool-weighted', ['vendor', 'balancer-v3-upstream', 'pkg', 'pool-weighted']],
  ['v3-pool-stable', ['vendor', 'balancer-v3-upstream', 'pkg', 'pool-stable']],
  ['v3-pool-hooks', ['vendor', 'balancer-v3-upstream', 'pkg', 'pool-hooks']],
  ['v3-pool-reclamm', ['vendor', 'balancer-reclamm-upstream']],
  ['v3-standalone-utils', ['vendor', 'balancer-v3-upstream', 'pkg', 'standalone-utils']]
]);

async function directoryExists(directory, fsApi = fs) {
  try {
    return (await fsApi.stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function findFrozenVendorWorkspaceRoot(projectRoot, fsApi = fs) {
  let candidate = path.resolve(projectRoot);
  for (let depth = 0; depth < 7; depth += 1) {
    const interfaces = path.join(candidate, 'vendor', 'balancer-v3-upstream', 'pkg', 'interfaces');
    const reclamm = path.join(candidate, 'vendor', 'balancer-reclamm-upstream');
    if (await directoryExists(interfaces, fsApi) && await directoryExists(reclamm, fsApi)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
}

async function ensureDirectorySymlink(destination, target, fsApi = fs) {
  try {
    const existing = await fsApi.lstat(destination);
    if (!existing.isSymbolicLink()) throw new Error(`Frozen vendor adapter destination already exists and is not a symlink: ${destination}`);
    const [actual, expected] = await Promise.all([fsApi.realpath(destination), fsApi.realpath(target)]);
    if (actual !== expected) throw new Error(`Frozen vendor adapter destination points to the wrong target: ${destination}`);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fsApi.symlink(target, destination, 'dir');
}

export async function materializeFrozenVendorRootAdapter(projectRoot, { fsApi = fs } = {}) {
  const workspaceRoot = await findFrozenVendorWorkspaceRoot(projectRoot, fsApi);
  if (!workspaceRoot) return { status: 'not-applicable', adapterVersion: 'balancer-frozen-vendor-root-v1' };

  const nodeModulesRoot = path.join(projectRoot, 'node_modules');
  if (!await directoryExists(nodeModulesRoot, fsApi)) {
    throw new Error('Frozen vendor adapter requires the admitted locked dependency installation');
  }
  const balancerModulesRoot = path.join(nodeModulesRoot, '@balancer-labs');
  await fsApi.mkdir(balancerModulesRoot, { recursive: true });

  const packages = [];
  for (const [packageName, targetParts] of FROZEN_BALANCER_VENDOR_PACKAGES) {
    const target = path.join(workspaceRoot, ...targetParts);
    if (!await directoryExists(target, fsApi)) throw new Error(`Frozen vendor package is missing: ${packageName}`);
    await ensureDirectorySymlink(path.join(balancerModulesRoot, packageName), target, fsApi);
    packages.push(`@balancer-labs/${packageName}`);
  }

  const permit2Target = path.join(nodeModulesRoot, '@uniswap', 'permit2');
  if (!await directoryExists(permit2Target, fsApi)) throw new Error('Frozen vendor adapter requires installed @uniswap/permit2');
  await ensureDirectorySymlink(path.join(nodeModulesRoot, 'permit2'), permit2Target, fsApi);

  return {
    status: 'materialized',
    adapterVersion: 'balancer-frozen-vendor-root-v1',
    workspaceRelativeToProject: path.relative(projectRoot, workspaceRoot).split(path.sep).join('/') || '.',
    packages: [...packages, 'permit2'].sort()
  };
}

async function exists(file, fsApi = fs) {
  try {
    const stat = await fsApi.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function sha256File(file, fsApi = fs) {
  const bytes = await fsApi.readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function detectNativeBuild(projectRoot, { fsApi = fs } = {}) {
  const config = await firstPresent(projectRoot, HARDHAT_CONFIGS, fsApi);
  if (!config) return { system: 'solc-standard-json' };

  if (!await exists(path.join(projectRoot, 'package.json'), fsApi)) {
    throw new Error('Hardhat exact build requires package.json');
  }
  const lockfile = await firstPresent(projectRoot, LOCKFILES, fsApi);
  if (!lockfile) throw new Error('Hardhat exact build requires a committed npm lockfile');
  return { system: 'hardhat-native', config, lockfile };
}

async function firstPresent(root, names, fsApi) {
  for (const name of names) {
    if (await exists(path.join(root, name), fsApi)) return name;
  }
  return null;
}

async function buildInfoFiles(projectRoot, fsApi = fs, { includeFoundry = false } = {}) {
  const rootEntries = await fsApi.readdir(projectRoot, { withFileTypes: true });
  let artifactDirs = rootEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('artifacts'))
    .map((entry) => entry.name)
    .sort();
  if (includeFoundry) {
    // Follow the admitted Foundry default profile's out path; a package may
    // compile into a nested directory instead of Forge's default "out".
    const config = await fsApi.readFile(path.join(projectRoot, 'foundry.toml'), 'utf8');
    const defaultProfile = config.split(/^\s*\[profile\.default\]\s*$/m)[1]?.split(/^\s*\[[^\]]+\]\s*$/m)[0] ?? '';
    const configuredOut = defaultProfile.match(/^\s*out\s*=\s*["']([^"']+)["']/m)?.[1] ?? 'out';
    const absoluteOut = path.resolve(projectRoot, configuredOut);
    if (!configuredOut || !absoluteOut.startsWith(path.resolve(projectRoot) + path.sep))
      throw new Error('Unsafe Foundry output directory');
    artifactDirs = [configuredOut];
  }
  const files = [];
  for (const artifactDir of artifactDirs) {
    const buildInfoDir = path.join(projectRoot, artifactDir, 'build-info');
    let entries;
    try {
      entries = await fsApi.readdir(buildInfoDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
      files.push(path.join(buildInfoDir, entry.name));
    }
  }
  return files;
}

async function listBuildInfo(projectRoot, fsApi = fs) {
  const output = [];
  for (const absolute of await buildInfoFiles(projectRoot, fsApi)) {
    let optimizerRuns = null;
    let solcVersion = null;
    let compilerInputSha256 = null;
    let compilerOutputSha256 = null;
    let sourceNames = [];
    let artifactQualifiedNames = [];
    try {
      const parsed = JSON.parse(await fsApi.readFile(absolute, 'utf8'));
      optimizerRuns = parsed?.input?.settings?.optimizer?.runs ?? null;
      solcVersion = parsed?.solcVersion ?? parsed?.solcLongVersion ?? null;
      compilerInputSha256 = parsed?.input ? createHash('sha256').update(JSON.stringify(parsed.input)).digest('hex') : null;
      compilerOutputSha256 = parsed?.output ? createHash('sha256').update(JSON.stringify(parsed.output)).digest('hex') : null;
      sourceNames = Object.keys(parsed?.input?.sources ?? {}).sort();
      artifactQualifiedNames = Object.entries(parsed?.output?.contracts ?? {}).flatMap(([sourceName,contracts]) =>
        Object.keys(contracts ?? {}).map(contractName=>`${sourceName}:${contractName}`)
      ).sort();
    } catch {
      // Raw build-info bytes remain evidence even if metadata parsing is unavailable.
    }
    output.push({
      path: path.relative(projectRoot, absolute).split(path.sep).join('/'),
      sha256: await sha256File(absolute, fsApi),
      optimizerRuns,
      solcVersion,
      compilerInputSha256,
      compilerOutputSha256,
      sourceNames,
      artifactQualifiedNames
    });
  }
  return output;
}

export async function collectNativeContractArtifacts(projectRoot, fsApi = fs) {
  const byQualifiedName = new Map();
  const files = await buildInfoFiles(projectRoot, fsApi);
  for (const [fileIndex, absolute] of files.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(await fsApi.readFile(absolute, 'utf8'));
    } catch {
      continue;
    }
    // Same file order and numbering as listBuildInfo/compilationUnits, so a
    // contract compiled in several build-info units keeps its exact unit.
    const compilationUnitId = `hardhat-build-info-${fileIndex + 1}`;
    for (const [sourceName, contracts] of Object.entries(parsed?.output?.contracts ?? {})) {
      for (const [contractName, raw] of Object.entries(contracts ?? {})) {
        const key = `${sourceName}:${contractName}`;
        const bytecodeObject = raw?.evm?.bytecode?.object ?? '';
        const deployedObject = raw?.evm?.deployedBytecode?.object ?? '';
        const candidate = {
          sourceName,
          contractName,
          abi: raw?.abi ?? [],
          metadata: raw?.metadata ?? null,
          storageLayout: raw?.storageLayout ?? null,
          devdoc: raw?.devdoc ?? {},
          userdoc: raw?.userdoc ?? {},
          methodIdentifiers: raw?.evm?.methodIdentifiers ?? {},
          bytecode: bytecodeObject ? `0x${String(bytecodeObject).replace(/^0x/, '')}` : '0x',
          deployedBytecode: deployedObject ? `0x${String(deployedObject).replace(/^0x/, '')}` : '0x',
          bytecodeSourceMap: raw?.evm?.bytecode?.sourceMap ?? '',
          deployedBytecodeSourceMap: raw?.evm?.deployedBytecode?.sourceMap ?? '',
          gasEstimates: raw?.evm?.gasEstimates ?? null,
          compilationUnitId,
        };
        const existing = byQualifiedName.get(key);
        if (!existing || (existing.gasEstimates === null && candidate.gasEstimates !== null)) byQualifiedName.set(key, candidate);
      }
    }
  }
  return [...byQualifiedName.values()].sort((a, b) => `${a.sourceName}:${a.contractName}`.localeCompare(`${b.sourceName}:${b.contractName}`));
}

export async function collectNativeSourceAsts(projectRoot, fsApi = fs) {
  const bySource = new Map();
  for (const absolute of await buildInfoFiles(projectRoot, fsApi)) {
    let parsed;
    try {
      parsed = JSON.parse(await fsApi.readFile(absolute, 'utf8'));
    } catch {
      continue;
    }
    for (const [sourceName, source] of Object.entries(parsed?.output?.sources ?? {})) {
      if (!source?.ast) continue;
      const serialized = JSON.stringify(source.ast);
      const existing = bySource.get(sourceName);
      if (existing && existing.serialized !== serialized) {
        throw new Error(`Hardhat build-info AST mismatch for ${sourceName}`);
      }
      if (!existing) bySource.set(sourceName, { ast: source.ast, serialized });
    }
  }
  return Object.fromEntries(
    [...bySource.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceName, entry]) => [sourceName, entry.ast])
  );
}

async function solidityInventory(projectRoot, fsApi = fs) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsApi.readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'cache', 'dist', 'build', 'out'].includes(entry.name) || entry.name.startsWith('artifacts')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.sol')) files.push(path.relative(projectRoot, absolute).split(path.sep).join('/'));
    }
  }
  await walk(projectRoot);
  files.sort();
  return files;
}

function commandFailure(message, result) {
  const error = new Error(message);
  error.code = 'native_build_failed';
  error.result = {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : -1,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? '')
  };
  return error;
}

export async function compileRepoNativeHardhat({
  projectRoot,
  runCommand = runProcess,
  fsApi = fs,
  materializeVendorAdapter = materializeFrozenVendorRootAdapter
}) {
  const detected = await detectNativeBuild(projectRoot, { fsApi });
  if (detected.system !== 'hardhat-native') throw new Error('Repository is not an admitted Hardhat native build');

  const install = await runCommand({
    command: 'npm',
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    cwd: projectRoot
  });
  if (!install || install.exitCode !== 0) throw commandFailure('Hardhat locked dependency installation failed', install);

  // A source-authored Hardhat audit wrapper may compile Solidity from upgrade/src
  // while its Foundry remappings resolve vetted npm packages under
  // ipor-fusion/node_modules. Install those source-declared dependencies before
  // loading the Hardhat config; otherwise its vendored-package links fail.
  const nestedFoundry=path.join(projectRoot,'upgrade');
  const foundryDependencyInstall=await exists(path.join(nestedFoundry,'foundry.toml'),fsApi)
    ? await installNativeFoundryDependencies({projectRoot:nestedFoundry,runCommand,fsApi})
    : [];

  const vendorRootAdapter = await materializeVendorAdapter(projectRoot, { fsApi });

  const compile = await runCommand({
    command: 'npx',
    args: ['--no-install', 'hardhat', 'compile'],
    cwd: projectRoot
  });
  if (!compile || compile.exitCode !== 0) throw commandFailure('Repository-native Hardhat compilation failed', compile);

  const buildInfo = await listBuildInfo(projectRoot, fsApi);
  const artifacts = await collectNativeContractArtifacts(projectRoot, fsApi);
  const sourceAsts = await collectNativeSourceAsts(projectRoot, fsApi);
  const sources = await solidityInventory(projectRoot, fsApi);
  return {
    status: 'completed',
    system: 'hardhat-native',
    config: detected.config,
    lockfile: detected.lockfile,
    compileOutput: {
      exitCode: compile.exitCode,
      stdout: String(compile.stdout ?? ''),
      stderr: String(compile.stderr ?? '')
    },
    buildInfo,
    buildInfoCount: buildInfo.length,
    compilationUnits:buildInfo.map((info,index)=>({
      unitId:`hardhat-build-info-${index+1}`,
      profile:'hardhat-native',
      compilerVersion:info.solcVersion,
      compilerPackage:'hardhat-build-info',
      settings:{optimizer:{runs:info.optimizerRuns}},
      compilerInputSha256:info.compilerInputSha256,
      compilerOutputSha256:info.compilerOutputSha256,
      sourceContents:Object.fromEntries((info.sourceNames??[]).map(name=>[name,null])),
      // Each unit carries the ASTs of its own sources so exact-build consumers (Slither export)
      // work without recompiling; build-info ASTs are identical across units for a shared source.
      sourceAsts:Object.fromEntries((info.sourceNames??[]).filter(name=>sourceAsts[name]).map(name=>[name,sourceAsts[name]])),
      artifacts:artifacts.filter(a=>(info.artifactQualifiedNames??[]).includes(`${a.sourceName}:${a.contractName}`))
    })),
    artifacts,
    sourceAsts,
    sourceInventory: sources,
    sourceInventoryFiles: sources.length,
    vendorRootAdapter,
    foundryDependencyInstall
  };
}


// Native Foundry projects are compiled using the package's foundry.toml. A
// generic solc compilation of the script/ directory is not equivalent: Forge
// remappings, external libraries, and script-only cheatcodes need native
// resolution. Build production src/ only; retain scripts for the separate,
// explicitly authorized fork deployment lane.
const FOUNDRY_NPM_PINS = Object.freeze({
  '@openzeppelin/contracts': '5.4.0',
  '@openzeppelin/contracts-upgradeable': '5.4.0',
  '@morpho-org/morpho-blue': '1.0.0',
  '@uniswap/v3-core': '1.0.1'
});
const FOUNDRY_NPM_SCOPES = Object.freeze({
  '@openzeppelin/': ['@openzeppelin/contracts', '@openzeppelin/contracts-upgradeable'],
  '@morpho-org/morpho-blue/': ['@morpho-org/morpho-blue'],
  '@uniswap/v3-core/': ['@uniswap/v3-core']
});

export async function detectNativeFoundry(projectRoot, {fsApi=fs}={}) {
  if (!await exists(path.join(projectRoot,'foundry.toml'),fsApi)) return {system:null};
  const text=await fsApi.readFile(path.join(projectRoot,'foundry.toml'),'utf8');
  const root=text.match(/^\s*\[profile\.default\]\s*$/m);
  if (!root) throw new Error('Foundry exact build requires a [profile.default] section');
  const src=text.match(/^\s*src\s*=\s*["']([^"']+)["']/m)?.[1]??'src';
  if (src.startsWith('/')||src.split('/').includes('..')) throw new Error('Unsafe Foundry source root');
  if (!await directoryExists(path.join(projectRoot,src),fsApi)) throw new Error('Foundry source directory missing: '+src);
  return {system:'foundry-native',src,config:'foundry.toml'};
}

function foundryNpmDependencyRoots(projectRoot,toml){
  const locations=new Map();
  for(const match of toml.matchAll(/["'](@[A-Za-z0-9_-]+\/[^"']*?)=([^"']+)["']/g)){
    const prefix=match[1],target=match[2].replaceAll('\\','/');
    if(!target.includes('/node_modules/'))continue;
    const packages=FOUNDRY_NPM_SCOPES[prefix]??[];
    if(!packages.length)continue;
    const root=path.resolve(projectRoot,target.slice(0,target.indexOf('/node_modules/')));
    // Only the extracted package's project root and siblings are permitted.
    const packageParent=path.dirname(path.resolve(projectRoot));
    if(root!==projectRoot&&root!==packageParent&&!root.startsWith(packageParent+path.sep))
      throw new Error('Foundry npm dependency root escapes the frozen source package: '+target);
    for(const name of packages)locations.set(name,root);
  }
  return locations;
}

export async function installNativeFoundryDependencies({projectRoot,runCommand=runProcess,fsApi=fs}){
  const config=await fsApi.readFile(path.join(projectRoot,'foundry.toml'),'utf8');
  const roots=foundryNpmDependencyRoots(projectRoot,config);
  const groups=new Map();
  for(const [name,root] of roots){
    if(!groups.has(root))groups.set(root,[]);
    groups.get(root).push(name);
  }
  const installs=[];
  for(const [root,names] of groups){
    const absent=[];
    for(const name of names){
      if(!await exists(path.join(root,'node_modules',...name.split('/'),'package.json'),fsApi))absent.push(name);
    }
    if(!absent.length)continue;
    // Honor the source lock, when provided, before using explicit bounded
    // runner pins. Never run dependency lifecycle scripts.
    const lock=path.join(root,'package-lock.json');
    const hasLock=await exists(lock,fsApi);
    const command=hasLock
      ? ['300s','npm','ci','--ignore-scripts','--no-audit','--no-fund','--prefix',root]
      : ['300s','npm','install','--ignore-scripts','--no-audit','--no-fund','--no-save','--package-lock=false','--prefix',root,...names.map(name=>name+'@'+FOUNDRY_NPM_PINS[name])];
    const result=await runCommand({command:'timeout',args:command,cwd:projectRoot});
    if(result?.exitCode!==0){
      const error=new Error('Foundry dependency installation failed: '+String(result?.stderr??result?.stdout??'').slice(-2000));
      error.code='FOUNDRY_DEPENDENCY_INSTALL_FAILED';throw error;
    }
    for(const name of absent){
      const packagePath=path.join(root,'node_modules',...name.split('/'),'package.json');
      if(!await exists(packagePath,fsApi))throw new Error('Foundry dependency is still missing after installation: '+name);
      const content=await fsApi.readFile(packagePath);
      const meta=JSON.parse(content.toString('utf8'));
      if(meta.name!==name)throw new Error('Foundry dependency name mismatch: '+name);
      if(!hasLock && meta.version!==FOUNDRY_NPM_PINS[name])
        throw new Error('Foundry dependency pin mismatch: '+name);
      installs.push({package:name,version:meta.version,packageManifestSha256:createHash('sha256').update(content).digest('hex'),
        sourceLockfile:hasLock?path.relative(projectRoot,lock).split(path.sep).join('/'):null,
        resolution:hasLock?'SOURCE_NPM_LOCK':'RUNNER_EXPLICIT_PIN',isolatedRunnerOnly:true});
    }
  }
  return installs.sort((a,b)=>a.package.localeCompare(b.package));
}

export async function compileRepoNativeFoundry({projectRoot,runCommand=runProcess,fsApi=fs}){
  const detected=await detectNativeFoundry(projectRoot,{fsApi});
  if(detected.system!=='foundry-native')throw new Error('Not an admitted native Foundry project');
  const dependencyInstall=await installNativeFoundryDependencies({projectRoot,runCommand,fsApi});
  // Forge compiles .vy alongside Solidity, but requires the corresponding Vyper
  // binary to be installed. Bind that version to the source's exact pragma.
  const vyperPragmas=new Set();
  async function scanVyperPragmas(directory){
    for(const entry of await fsApi.readdir(directory,{withFileTypes:true})){
      const absolute=path.join(directory,entry.name);
      if(entry.isDirectory())await scanVyperPragmas(absolute);
      else if(entry.isFile()&&entry.name.endsWith('.vy')){
        const source=await fsApi.readFile(absolute,'utf8');
        const pragma=source.match(/^\\s*#\\s*pragma\\s+version\\s+(\\d+\\.\\d+\\.\\d+)\\s*$/m)?.[1];
        if(!pragma)throw new Error('Foundry Vyper source lacks an exact version pragma: '+path.relative(projectRoot,absolute));
        vyperPragmas.add(pragma);
      }
    }
  }
  await scanVyperPragmas(path.join(projectRoot,detected.src));
  if(vyperPragmas.size>1)throw new Error('Conflicting exact Vyper compiler versions in Foundry source tree');
  if(vyperPragmas.size===1){
    const version=[...vyperPragmas][0];
    const install=await runCommand({command:'python3',args:['-m','pip','install','--disable-pip-version-check','--no-input',`vyper==${version}`],cwd:projectRoot});
    if(install?.exitCode!==0)throw new Error('Exact source-bound Vyper installation failed: '+String(install?.stderr??install?.stdout??'').slice(-2000));
    const probe=await runCommand({command:'vyper',args:['--version'],cwd:projectRoot});
    if(probe?.exitCode!==0||!String(probe?.stdout??'').trim().startsWith(version))
      throw new Error('Installed Vyper version does not match source pragma '+version);
    dependencyInstall.push({package:'vyper',version,resolution:'SOURCE_PRAGMA',isolatedRunnerOnly:true});
  }
  // Keep script/ and test/ in the frozen source and readiness inventory, but
  // do not feed executable scripts/cheatcodes to the production-contract build.
  const result=await runCommand({command:'timeout',args:['1500s','forge','build','--force','--build-info','--skip','script','--skip','test'],cwd:projectRoot});
  if(result?.exitCode!==0){
    const error=new Error('Foundry native production compilation failed: '+String(result?.stderr??result?.stdout??'').slice(-4000));
    error.code='FOUNDRY_NATIVE_COMPILATION_FAILED';throw error;
  }
  const paths=await buildInfoFiles(projectRoot,fsApi,{includeFoundry:true});
  if (!paths.length) {
    const configured = await fsApi.readFile(path.join(projectRoot, 'foundry.toml'), 'utf8');
    const profile = configured.split(/^\s*\[profile\.default\]\s*$/m)[1]?.split(/^\s*\[[^\]]+\]\s*$/m)[0] ?? '';
    const outPath = profile.match(/^\s*out\s*=\s*["']([^"']+)["']/m)?.[1] ?? 'out';
    const buildInfoParent = path.join(projectRoot, outPath);
    const visibleEntries = await fsApi.readdir(buildInfoParent).catch(() => []);
    throw new Error('Foundry native build produced no compiler build-info: ' + JSON.stringify({
      configuredOut: outPath,
      artifactEntries: visibleEntries.slice(0, 30),
      forgeStdout: String(result?.stdout ?? '').slice(-1800),
      forgeStderr: String(result?.stderr ?? '').slice(-1800)
    }));
  }
  const units=[],artifacts=[],sourceAsts={},inventory=new Set(),diagnostics=[];
  for(const [index,file] of paths.entries()){
    const data=JSON.parse(await fsApi.readFile(file,'utf8'));
    if(!data.input?.sources||!data.output?.contracts||!data.output?.sources)
      throw new Error('Foundry build-info is missing exact compiler input, output, or AST: '+file);
    const sourceContents={};
    for(const [name,entry] of Object.entries(data.input.sources)){
      if(typeof entry?.content!=='string')throw new Error('Foundry compiler source contents absent: '+name);
      sourceContents[name]=entry.content;inventory.add(name);
    }
    const asts=Object.fromEntries(Object.entries(data.output.sources).filter(([,v])=>v?.ast).map(([name,value])=>[name,value.ast]));
    Object.assign(sourceAsts,asts);
    const unitId='foundry-build-info-'+(index+1);
    const these=Object.entries(data.output.contracts).flatMap(([name,contracts])=>
      Object.entries(contracts??{}).map(([contractName,raw])=>({
        sourceName:name,contractName,abi:raw.abi??[],metadata:raw.metadata??null,storageLayout:raw.storageLayout??null,
        devdoc:raw.devdoc??{},userdoc:raw.userdoc??{},methodIdentifiers:raw.evm?.methodIdentifiers??{},
        gasEstimates:raw.evm?.gasEstimates??null,bytecode:raw.evm?.bytecode?.object?'0x'+raw.evm.bytecode.object:'0x',
        deployedBytecode:raw.evm?.deployedBytecode?.object?'0x'+raw.evm.deployedBytecode.object:'0x',
        bytecodeSourceMap:raw.evm?.bytecode?.sourceMap??'',deployedBytecodeSourceMap:raw.evm?.deployedBytecode?.sourceMap??'',
        linkReferences:raw.evm?.bytecode?.linkReferences??{},deployedLinkReferences:raw.evm?.deployedBytecode?.linkReferences??{},
        compilationUnitId:unitId
      }))
    );
    artifacts.push(...these);
    const diagnosticRows=Array.isArray(data.output.errors)?data.output.errors:[];
    if(diagnosticRows.some(item=>item.severity==='error'))throw new Error('Foundry compiler build-info includes errors');
    diagnostics.push(...diagnosticRows);
    const inputText=JSON.stringify(data.input),outputText=JSON.stringify(data.output);
    units.push({unitId,profile:'foundry-native',compilerVersion:data.solcVersion??data.solcLongVersion?.split('+')[0],
      compilerPackage:'foundry-solc',settings:data.input.settings??{},sourceContents,sourceAsts:asts,
      compilerInputSha256:createHash('sha256').update(inputText).digest('hex'),
      compilerOutputSha256:createHash('sha256').update(outputText).digest('hex'),artifacts:these});
  }
  if(!artifacts.length||!units.every(unit=>unit.compilerVersion))
    throw new Error('Foundry build lacks usable contract artifacts or exact compiler versions');
  const qualified=new Set();
  for(const a of artifacts){
    const key=a.sourceName+':'+a.contractName;
    if(qualified.has(key))throw new Error('Ambiguous duplicate Foundry compiler artifact: '+key);
    qualified.add(key);
  }
  const compilerVersions=[...new Set(units.map(unit=>unit.compilerVersion))].sort();
  return {status:'completed',system:'foundry-native',compilerVersion:compilerVersions.length===1?compilerVersions[0]:'multi-profile',
    compilerVersions,compilerProfiles:units.map(unit=>({name:unit.unitId,compilerVersion:unit.compilerVersion,settings:unit.settings})),
    compilerDiagnostics:diagnostics,sourceAsts,sourceInventory:[...inventory].sort(),sourceInventoryFiles:inventory.size,
    artifacts,compilationUnits:units,foundryDependencyInstall:dependencyInstall,
    foundryProductionOnly:true,sourceScriptsRetained:true};
}
