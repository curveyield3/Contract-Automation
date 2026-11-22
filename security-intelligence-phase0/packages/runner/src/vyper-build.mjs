import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../../github-native-sim/src/execution.mjs';

async function collectVyperSourceFiles(projectRoot, fsApi = fs) {
  const files=[];
  async function visit(dir){
    let entries;
    try{entries=await fsApi.readdir(dir,{withFileTypes:true});}
    catch(e){if(e?.code==='ENOENT')return;throw e;}
    for(const entry of entries){
      if(['.git','node_modules','cache','build','out','dist','artifacts','vendor','lib','test','tests','script','scripts'].includes(entry.name))continue;
      const absolute=path.join(dir,entry.name);
      if(entry.isDirectory())await visit(absolute);
      else if(entry.isFile()&&entry.name.endsWith('.vy'))files.push(absolute);
    }
  }
  // Vyper projects commonly use src/, contracts/, or source files at root.
  for(const prefix of ['contracts','src'])await visit(path.join(projectRoot,prefix));
  const atRoot=await fsApi.readdir(projectRoot,{withFileTypes:true});
  for(const file of atRoot)if(file.isFile()&&file.name.endsWith('.vy'))files.push(path.join(projectRoot,file.name));
  return [...new Set(files)].sort((a,b)=>a.localeCompare(b));
}

function commandFailure(message, result) {
  const error = new Error(message);
  error.code = 'vyper_build_failed';
  error.result = {
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : -1,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? '')
  };
  return error;
}

async function requireSuccess(result, message) {
  if (!result || result.exitCode !== 0) throw commandFailure(message, result);
  return result;
}

async function compileFormat({ runCommand, projectRoot, sourceName, format, evmVersion }) {
  const args = [];
  if (evmVersion) args.push('--evm-version', evmVersion);
  args.push('-f', format, sourceName);
  const result = await runCommand({ command: 'vyper', args, cwd: projectRoot });
  await requireSuccess(result, `Vyper ${format} compilation failed for ${sourceName}`);
  return String(result.stdout ?? '').trim();
}

export async function compileVyperSources({
  projectRoot,
  compiler,
  evmVersion,
  runCommand = runProcess,
  fsApi = fs
}) {
  if (!compiler || compiler.language !== 'vyper' || typeof compiler.version !== 'string' || !compiler.version) {
    throw new Error('Exact Vyper compiler identity is required');
  }
  const sources = await collectVyperSourceFiles(projectRoot, fsApi);
  if (sources.length === 0) throw new Error('Exact Vyper compiler requested but no primary .vy sources were found under src/, contracts/, or the project root');

  if(process.env.SECURITY_PREFLIGHT_OFFLINE_COMPILERS!=='1'){
    const installArgs=['-m','pip','install','--disable-pip-version-check','--no-input','vyper=='+compiler.version];
    const install=await runCommand({command:'python3',args:installArgs,cwd:projectRoot});
    await requireSuccess(install,'Exact Vyper '+compiler.version+' installation failed');
  }
  // In standalone mode Vyper must already be installed in the trusted image.
  // Source-defined dependency resolution is never allowed to use runtime network.

  const versionResult = await runCommand({ command: 'vyper', args: ['--version'], cwd: projectRoot });
  await requireSuccess(versionResult, 'Vyper version probe failed');
  const compilerReportedVersion = String(versionResult.stdout ?? '').trim();
  if (!compilerReportedVersion.startsWith(compiler.version)) {
    throw new Error(`Vyper compiler drift: requested ${compiler.version}, got ${compilerReportedVersion || 'unknown'}`);
  }

  const artifacts = [];
  const sourceInventory = [];
  const sourceDigests = [];
  for (const absolute of sources) {
    const sourceName = path.relative(projectRoot, absolute).split(path.sep).join('/');
    const abiText = await compileFormat({ runCommand, projectRoot, sourceName, format: 'abi', evmVersion });
    const bytecode = await compileFormat({ runCommand, projectRoot, sourceName, format: 'bytecode', evmVersion });
    const deployedBytecode = await compileFormat({ runCommand, projectRoot, sourceName, format: 'bytecode_runtime', evmVersion });
    const compilerLayoutText = await compileFormat({ runCommand, projectRoot, sourceName, format: 'layout', evmVersion });
    let vyperCompilerLayout;
    try { vyperCompilerLayout = JSON.parse(compilerLayoutText); }
    catch (error) { throw new Error(`Vyper layout output invalid for ${sourceName}: ${error.message}`); }
    if (!vyperCompilerLayout || typeof vyperCompilerLayout !== 'object' ||
        !vyperCompilerLayout.storage_layout || typeof vyperCompilerLayout.storage_layout !== 'object')
      throw new Error(`Vyper compiler storage_layout missing for ${sourceName}`);
    let abi;
    try {
      abi = JSON.parse(abiText);
    } catch (error) {
      throw new Error(`Vyper ABI output is not valid JSON for ${sourceName}: ${error.message}`);
    }
    if (!/^0x[0-9a-fA-F]*$/.test(bytecode) || !/^0x[0-9a-fA-F]*$/.test(deployedBytecode)) {
      throw new Error(`Vyper bytecode output is malformed for ${sourceName}`);
    }
    const sourceBytes = await fsApi.readFile(absolute);
    sourceInventory.push(sourceName);
    sourceDigests.push({ sourceName, sha256: createHash('sha256').update(sourceBytes).digest('hex') });
    artifacts.push({
      sourceName,
      contractName: path.basename(sourceName, '.vy'),
      abi,
      bytecode,
      deployedBytecode,
      vyperCompilerLayout,
      gasEstimates: null,
      language: 'vyper'
    });
  }

  return {
    status: 'completed',
    system: 'vyper-cli',
    compilerVersion: compiler.version,
    compilerReportedVersion,
    evmVersion: evmVersion ?? null,
    artifacts,
    sourceInventory,
    sourceInventoryFiles: sourceInventory.length,
    sourceDigests
  };
}
