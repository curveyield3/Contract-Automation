import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const OUTPUT_SELECTION = [
  'abi',
  'metadata',
  'storageLayout',
  'devdoc',
  'userdoc',
  'evm.bytecode.object',
  'evm.bytecode.sourceMap',
  'evm.bytecode.linkReferences',
  'evm.deployedBytecode.object',
  'evm.deployedBytecode.sourceMap',
  'evm.deployedBytecode.linkReferences',
  'evm.methodIdentifiers',
  'evm.gasEstimates'
];

export function safeProjectPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe project path: ${relativePath}`);
  }
  return resolved;
}

export async function collectSoliditySources(root, fsApi = fs) {
  const output = {};

  async function walk(directory) {
    const entries = await fsApi.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'artifacts', 'cache', 'out', 'dist', 'build'].includes(entry.name)) continue;
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.sol')) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        output[relative] = await fsApi.readFile(absolute, 'utf8');
      }
    }
  }

  await walk(root);
  if (Object.keys(output).length === 0) throw new Error('No Solidity source files found');
  return output;
}

export function buildCompilerInput(sources, settings = {}) {
  const normalizedSources = Object.fromEntries(
    Object.entries(sources).map(([name, content]) => [name, { content }])
  );
  const compilerSettings = {
    optimizer: settings.optimizer ?? { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': OUTPUT_SELECTION, '': ['ast'] } }
  };
  if (settings.viaIR === true) compilerSettings.viaIR = true;
  if (settings.evmVersion) compilerSettings.evmVersion = settings.evmVersion;
  return {
    language: 'Solidity',
    sources: normalizedSources,
    settings: compilerSettings
  };
}

function normalizeArtifact(sourceName, contractName, artifact) {
  const bytecodeObject = artifact?.evm?.bytecode?.object ?? '';
  const deployedObject = artifact?.evm?.deployedBytecode?.object ?? '';
  return {
    sourceName,
    contractName,
    abi: artifact.abi ?? [],
    metadata: artifact.metadata ?? null,
    storageLayout: artifact.storageLayout ?? null,
    devdoc: artifact.devdoc ?? {},
    userdoc: artifact.userdoc ?? {},
    methodIdentifiers: artifact?.evm?.methodIdentifiers ?? {},
    gasEstimates: artifact?.evm?.gasEstimates ?? null,
    bytecode: bytecodeObject ? `0x${bytecodeObject.replace(/^0x/, '')}` : '0x',
    deployedBytecode: deployedObject ? `0x${deployedObject.replace(/^0x/, '')}` : '0x',
    bytecodeSourceMap: artifact?.evm?.bytecode?.sourceMap ?? '',
    linkReferences: artifact?.evm?.bytecode?.linkReferences ?? {},
    deployedBytecodeSourceMap: artifact?.evm?.deployedBytecode?.sourceMap ?? '',
    deployedLinkReferences: artifact?.evm?.deployedBytecode?.linkReferences ?? {}
  };
}

export function contractArtifactMap(output) {
  const byQualifiedName = new Map();
  const byName = new Map();
  for (const [sourceName, contracts] of Object.entries(output.contracts ?? {})) {
    for (const [contractName, rawArtifact] of Object.entries(contracts)) {
      const artifact = normalizeArtifact(sourceName, contractName, rawArtifact);
      byQualifiedName.set(`${sourceName}:${contractName}`, artifact);
      const existing = byName.get(contractName) ?? [];
      existing.push(artifact);
      byName.set(contractName, existing);
    }
  }
  return {
    all: [...byQualifiedName.values()],
    get(contractName, sourceName = undefined) {
      if (sourceName) {
        const artifact = byQualifiedName.get(`${sourceName}:${contractName}`);
        if (!artifact) throw new Error(`Contract not found: ${sourceName}:${contractName}`);
        return artifact;
      }
      const matches = byName.get(contractName) ?? [];
      if (matches.length === 0) throw new Error(`Contract not found: ${contractName}`);
      if (matches.length > 1) throw new Error(`Ambiguous contract name ${contractName}; specify source`);
      return matches[0];
    }
  };
}

export async function loadSolcVersion(version) {
  const solcModule = await import('solc');
  const solc = solcModule.default ?? solcModule;
  const localVersion = String(solc.version()).match(/^\d+\.\d+\.\d+/)?.[0];
  if (localVersion === version) return solc;

  const manifestResponse = await fetch('https://binaries.soliditylang.org/bin/list.json');
  if (!manifestResponse.ok) throw new Error(`Unable to fetch Solidity compiler manifest (${manifestResponse.status})`);
  const manifest = await manifestResponse.json();
  const releasePath = manifest.releases?.[version];
  if (!releasePath) throw new Error(`Official Solidity compiler ${version} was not found`);
  const longVersion = releasePath.replace(/^soljson-/, '').replace(/\.js$/, '');
  return new Promise((resolve, reject) => {
    solc.loadRemoteVersion(longVersion, (error, compiler) => error ? reject(error) : resolve(compiler));
  });
}

export async function compileProject({ sources, compilerVersion, settings, openZeppelinRoot }) {
  const compiler = await loadSolcVersion(compilerVersion);
  const input = buildCompilerInput(sources, settings);
  const sourceLookup = new Map(Object.entries(sources));

  function findImports(importPath) {
    const normalized = importPath.replaceAll('\\', '/');
    if (sourceLookup.has(normalized)) return { contents: sourceLookup.get(normalized) };
    if (normalized.startsWith('@openzeppelin/contracts/')) {
      if (!openZeppelinRoot) return { error: 'OpenZeppelin import requested without openZeppelinVersion' };
      const relative = normalized.slice('@openzeppelin/contracts/'.length);
      try {
        const file = safeProjectPath(openZeppelinRoot, relative);
        return { contents: readFileSync(file, 'utf8') };
      } catch (cause) {
        return { error: `OpenZeppelin import failed: ${cause.message}` };
      }
    }
    return { error: `Import not found or not allowlisted: ${importPath}` };
  }

  const inputText = JSON.stringify(input);
  const outputText = compiler.compile(inputText, { import: findImports });
  const output = JSON.parse(outputText);
  const diagnostics = (output.errors ?? []).map((item) => ({
    severity: item.severity,
    type: item.type,
    component: item.component,
    errorCode: item.errorCode,
    message: item.message,
    formattedMessage: item.formattedMessage,
    sourceLocation: item.sourceLocation
  }));
  if (diagnostics.some((item) => item.severity === 'error')) {
    const failure = new Error('Solidity compilation failed: '+diagnostics.filter(item=>item.severity==='error').map(item=>item.formattedMessage??item.message).join('\n').slice(0,6000));
    failure.compilerDiagnostics = diagnostics;
    throw failure;
  }
  const sourceAsts = Object.fromEntries(
    Object.entries(output.sources ?? {})
      .filter(([, value]) => value?.ast)
      .map(([sourceName, value]) => [sourceName, value.ast])
      .sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    output, diagnostics, artifacts: contractArtifactMap(output), input, sourceAsts,
    compilerInputSha256:createHash('sha256').update(inputText).digest('hex'),
    compilerOutputSha256:createHash('sha256').update(outputText).digest('hex')
  };
}