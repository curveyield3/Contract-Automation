import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildCompilerInput, contractArtifactMap, loadSolcVersion } from './compiler.mjs';
import { materializeFrozenVendorRootAdapter } from './native-build.mjs';
import { runProcess } from '../../github-native-sim/src/execution.mjs';

const CURVEYIELD_ARCHIVE_SHA256 = '526a729ce73d493f2ccbb568378a18dd1eec0788d0165e02dc5ceb773b9953ed';
const PACKAGE_PREFIXES = Object.freeze([
  ['@balancer-labs/', ['node_modules', '@balancer-labs']],
  ['@openzeppelin/', ['node_modules', '@openzeppelin']],
  ['@uniswap/', ['node_modules', '@uniswap']],
  ['permit2/', ['node_modules', 'permit2']]
]);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'artifacts', 'cache', 'out', 'dist', 'build', '.audit-hermetic-build']);
const IMPORT_PATTERN = /\bimport\s+(?:(?:[^"'\x60;]*?)\s+from\s+)?["']([^"']+)["']\s*;/g;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function posixName(value) {
  return value.split(path.sep).join('/');
}

async function directoryExists(directory, fsApi = fs) {
  try { return (await fsApi.stat(directory)).isDirectory(); } catch { return false; }
}

async function fileExists(file, fsApi = fs) {
  try { return (await fsApi.stat(file)).isFile(); } catch { return false; }
}

async function collectSeedContracts(projectRoot, fsApi = fs) {
  const contractsRoot = path.join(projectRoot, 'contracts');
  if (!await directoryExists(contractsRoot, fsApi)) throw new Error('Hermetic standard-JSON build requires contracts/');
  const seeds = [];
  async function walk(directory) {
    const entries = await fsApi.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.sol')) {
        seeds.push({ sourceName: posixName(path.relative(projectRoot, absolute)), absolute });
      }
    }
  }
  await walk(contractsRoot);
  if (seeds.length === 0) throw new Error('Hermetic standard-JSON build found no contract sources');
  return seeds;
}

function importedPaths(content) {
  const imports = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) imports.push(match[1]);
  return imports;
}

async function resolveImport({ importer, importPath, projectRoot, fsApi }) {
  if (importPath.startsWith('.')) {
    return {
      sourceName: path.posix.normalize(path.posix.join(path.posix.dirname(importer.sourceName), importPath)),
      absolute: path.resolve(path.dirname(importer.absolute), importPath)
    };
  }
  for (const [prefix, rootParts] of PACKAGE_PREFIXES) {
    if (!importPath.startsWith(prefix)) continue;
    return {
      sourceName: path.posix.normalize(importPath),
      absolute: path.join(projectRoot, ...rootParts, importPath.slice(prefix.length))
    };
  }
  const local = path.join(projectRoot, importPath);
  if (await fileExists(local, fsApi)) return { sourceName: path.posix.normalize(importPath), absolute: local };
  throw new Error(`Hermetic import is not allowlisted: ${importPath} from ${importer.sourceName}`);
}

async function withinAnyAllowedRoot(absolute, allowedRoots, fsApi) {
  const real = await fsApi.realpath(absolute);
  for (const root of allowedRoots) {
    const realRoot = await fsApi.realpath(root);
    if (real === realRoot || real.startsWith(`${realRoot}${path.sep}`)) return real;
  }
  throw new Error(`Hermetic import escaped exact-source/package roots: ${absolute}`);
}

async function collectHermeticSources(projectRoot, vendorRootAdapter, fsApi = fs) {
  const workspaceRoot = path.resolve(projectRoot, vendorRootAdapter.workspaceRelativeToProject ?? '.');
  const allowedRoots = [projectRoot, workspaceRoot];
  const queue = await collectSeedContracts(projectRoot, fsApi);
  const records = new Map();

  while (queue.length > 0) {
    const next = queue.shift();
    const absolute = await withinAnyAllowedRoot(next.absolute, allowedRoots, fsApi);
    const bytes = await fsApi.readFile(absolute);
    const content = bytes.toString('utf8');
    const digest = sha256(bytes);
    const existing = records.get(next.sourceName);
    if (existing) {
      if (existing.sha256 !== digest) throw new Error(`Hermetic source-name collision: ${next.sourceName}`);
      continue;
    }
    const record = {
      sourceName: next.sourceName,
      absolute,
      sha256: digest,
      byteLength: bytes.length,
      content
    };
    records.set(next.sourceName, record);
    for (const importPath of importedPaths(content)) {
      queue.push(await resolveImport({ importer: record, importPath, projectRoot, fsApi }));
    }
  }

  const ordered = [...records.values()].sort((left, right) => left.sourceName.localeCompare(right.sourceName));
  return {
    sources: Object.fromEntries(ordered.map((item) => [item.sourceName, item.content])),
    manifest: ordered.map((item) => ({
      sourceName: item.sourceName,
      sha256: item.sha256,
      byteLength: item.byteLength,
      origin: item.absolute.startsWith(projectRoot + path.sep) ? 'PROJECT_OR_LOCKED_PACKAGE' : 'FROZEN_VENDOR_ROOT'
    }))
  };
}


async function collectHermeticSourcesFromNamedSeeds(projectRoot, vendorRootAdapter, sourceNames, fsApi = fs) {
  const workspaceRoot = path.resolve(projectRoot, vendorRootAdapter.workspaceRelativeToProject ?? '.');
  const allowedRoots = [projectRoot, workspaceRoot];
  const queue = [...new Set(sourceNames)].map((sourceName) => {
    if (typeof sourceName !== 'string' || sourceName.length === 0 || path.isAbsolute(sourceName) || sourceName.includes('\\\\')) {
      throw new Error(`Invalid hermetic deployment source entry: ${sourceName}`);
    }
    const normalized = path.posix.normalize(sourceName);
    return { sourceName: normalized, absolute: path.resolve(projectRoot, ...normalized.split('/')) };
  });
  const records = new Map();

  while (queue.length > 0) {
    const next = queue.shift();
    const absolute = await withinAnyAllowedRoot(next.absolute, allowedRoots, fsApi);
    const bytes = await fsApi.readFile(absolute);
    const content = bytes.toString('utf8');
    const digest = sha256(bytes);
    const existing = records.get(next.sourceName);
    if (existing) {
      if (existing.sha256 !== digest) throw new Error(`Hermetic source-name collision: ${next.sourceName}`);
      continue;
    }
    const record = {
      sourceName: next.sourceName,
      absolute,
      sha256: digest,
      byteLength: bytes.length,
      content
    };
    records.set(next.sourceName, record);
    for (const importPath of importedPaths(content)) {
      queue.push(await resolveImport({ importer: record, importPath, projectRoot, fsApi }));
    }
  }

  const ordered = [...records.values()].sort((left, right) => left.sourceName.localeCompare(right.sourceName));
  return {
    sources: Object.fromEntries(ordered.map((item) => [item.sourceName, item.content])),
    manifest: ordered.map((item) => ({
      sourceName: item.sourceName,
      sha256: item.sha256,
      byteLength: item.byteLength,
      origin: item.absolute.startsWith(projectRoot + path.sep) ? 'PROJECT_OR_LOCKED_PACKAGE' : 'FROZEN_VENDOR_ROOT'
    }))
  };
}

export async function compileHermeticDeploymentEntriesV1({
  projectRoot,
  request,
  groups,
  fsApi = fs,
  materializeVendorAdapter = materializeFrozenVendorRootAdapter
}) {
  if (!shouldUseHermeticStandardJson(request)) throw new Error('Archive is not admitted for hermetic deployment-entry compilation');
  if (!Array.isArray(groups) || groups.length === 0) {
    return {
      schemaVersion: 'runner-owned-hermetic-deployment-entry-compilation-v1',
      status: 'NO_DECLARED_DEPLOYMENT_COMPILE_GROUPS',
      artifacts: [],
      selectedTargets: [],
      missingTargets: [],
      diagnostics: []
    };
  }
  const normalizedGroups = groups.map((group, groupIndex) => ({
    groupIndex,
    entryFiles: [...new Set((group?.entryFiles ?? []).map((x) => path.posix.normalize(String(x))))],
    contractNames: [...new Set((group?.contractNames ?? []).map(String))]
  })).filter((group) => group.entryFiles.length && group.contractNames.length);
  if (!normalizedGroups.length) throw new Error('Deployment compile groups contain no usable entries');

  const vendorRootAdapter = await materializeVendorAdapter(projectRoot, { fsApi });
  if (vendorRootAdapter.status !== 'materialized') throw new Error('Frozen vendor-root adapter is required for deployment-entry compilation');
  const sourceNames = [...new Set(normalizedGroups.flatMap((group) => group.entryFiles))];
  const collected = await collectHermeticSourcesFromNamedSeeds(projectRoot, vendorRootAdapter, sourceNames, fsApi);
  const compiler = request.configuration.compilers.find((item) => item?.language === 'solidity');
  if (!compiler?.version) throw new Error('Exact Solidity compiler version is required for deployment-entry compilation');
  const input = buildCompilerInput(collected.sources, {
    optimizer: request.configuration.optimizer,
    evmVersion: request.configuration.evmVersion,
    viaIR: request.configuration.viaIR
  });
  const solc = await loadSolcVersion(compiler.version);
  const outputText = solc.compile(JSON.stringify(input));
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
    const error = new Error('Hermetic deployment-entry Solidity compilation failed');
    error.code = 'hermetic_deployment_entry_compilation_failed';
    error.result = { diagnostics };
    throw error;
  }

  const allArtifacts = contractArtifactMap(output).all;
  const selectedTargets = [];
  const selectedArtifacts = [];
  const selectedKeys = new Set();
  const missingTargets = [];
  for (const group of normalizedGroups) {
    for (const contractName of group.contractNames) {
      const direct = allArtifacts.filter((artifact) =>
        artifact.contractName === contractName && group.entryFiles.includes(artifact.sourceName)
      );
      let artifact = direct.length === 1 ? direct[0] : null;
      if (!artifact && direct.length === 0) {
        const byName = allArtifacts.filter((candidate) => candidate.contractName === contractName);
        if (byName.length === 1) artifact = byName[0];
      }
      if (!artifact) {
        missingTargets.push({
          groupIndex: group.groupIndex,
          contractName,
          entryFiles: group.entryFiles,
          reason: direct.length > 1 ? 'MULTIPLE_DIRECT_ENTRY_ARTIFACTS' : 'NO_UNIQUE_DEPLOYMENT_ARTIFACT'
        });
        continue;
      }
      const key = `${artifact.sourceName}:${artifact.contractName}`;
      selectedTargets.push({ groupIndex: group.groupIndex, contractName, sourceName: artifact.sourceName, qualifiedName: key });
      if (!selectedKeys.has(key)) {
        selectedKeys.add(key);
        selectedArtifacts.push(artifact);
      }
    }
  }
  return {
    schemaVersion: 'runner-owned-hermetic-deployment-entry-compilation-v1',
    status: missingTargets.length ? 'COMPLETE_WITH_MISSING_TARGETS' : 'PASS',
    compilerVersion: compiler.version,
    sourceEntryCount: sourceNames.length,
    collectedSourceCount: collected.manifest.length,
    artifactCount: selectedArtifacts.length,
    artifacts: selectedArtifacts,
    selectedTargets,
    missingTargets,
    diagnostics
  };
}

async function dependencySbom(projectRoot, fsApi = fs) {
  const lockfile = path.join(projectRoot, 'package-lock.json');
  const bytes = await fsApi.readFile(lockfile);
  const lock = JSON.parse(bytes.toString('utf8'));
  const packages = Object.entries(lock.packages ?? {})
    .filter(([packagePath]) => packagePath !== '')
    .map(([packagePath, item]) => ({
      path: packagePath,
      name: item.name ?? packagePath.split('node_modules/').at(-1),
      version: item.version ?? null,
      resolved: item.resolved ?? null,
      integrity: item.integrity ?? null
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 'runner-owned-exact-dependency-sbom-v1',
    packageLockSha256: sha256(bytes),
    packageCount: packages.length,
    packagesSha256: sha256(stableJson(packages)),
    packages
  };
}

export function shouldUseHermeticStandardJson(request) {
  return request?.source?.archiveSha256 === CURVEYIELD_ARCHIVE_SHA256;
}

export async function compileRepoHermeticStandardJson({
  projectRoot,
  request,
  runCommand = runProcess,
  fsApi = fs,
  materializeVendorAdapter = materializeFrozenVendorRootAdapter
}) {
  if (!shouldUseHermeticStandardJson(request)) throw new Error('Archive is not admitted for hermetic standard-JSON compilation');

  const install = await runCommand({
    command: 'npm',
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    cwd: projectRoot
  });
  if (!install || install.exitCode !== 0) {
    const error = new Error('Hermetic standard-JSON locked dependency installation failed');
    error.code = 'hermetic_dependency_install_failed';
    error.result = {
      exitCode: Number.isInteger(install?.exitCode) ? install.exitCode : -1,
      stdout: String(install?.stdout ?? ''),
      stderr: String(install?.stderr ?? '')
    };
    throw error;
  }

  const vendorRootAdapter = await materializeVendorAdapter(projectRoot, { fsApi });
  if (vendorRootAdapter.status !== 'materialized') throw new Error('Frozen vendor-root adapter is required for the admitted hermetic build');

  const collected = await collectHermeticSources(projectRoot, vendorRootAdapter, fsApi);
  const compiler = request.configuration.compilers.find((item) => item?.language === 'solidity');
  const input = buildCompilerInput(collected.sources, {
    optimizer: request.configuration.optimizer,
    evmVersion: request.configuration.evmVersion,
    viaIR: request.configuration.viaIR
  });
  const solc = await loadSolcVersion(compiler.version);
  const outputText = solc.compile(JSON.stringify(input));
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
    const error = new Error('Hermetic Solidity standard-JSON compilation failed');
    error.code = 'hermetic_standard_json_failed';
    error.result = { exitCode: 1, stdout: '', stderr: diagnostics.map((item) => item.formattedMessage ?? item.message).join('\n') };
    throw error;
  }

  const evidenceDirectory = path.join(projectRoot, '.audit-hermetic-build');
  await fsApi.mkdir(evidenceDirectory, { recursive: true });
  const standardJsonPath = path.join(evidenceDirectory, 'solc-input.json');
  await fsApi.writeFile(standardJsonPath, `${JSON.stringify(input)}\n`);
  const stagingManifest = {
    schemaVersion: 'runner-owned-hermetic-solidity-staging-manifest-v1',
    archiveSha256: request.source.archiveSha256,
    projectPath: request.source.projectPath,
    compiler: compiler.version,
    optimizer: request.configuration.optimizer,
    evmVersion: request.configuration.evmVersion ?? null,
    viaIR: request.configuration.viaIR ?? false,
    sources: collected.manifest
  };
  const sbom = await dependencySbom(projectRoot, fsApi);
  const artifacts = contractArtifactMap(output).all;
  const sourceAsts = Object.fromEntries(
    Object.entries(output.sources ?? {})
      .filter(([, value]) => value?.ast)
      .map(([sourceName, value]) => [sourceName, value.ast])
      .sort(([left], [right]) => left.localeCompare(right))
  );

  return {
    status: 'completed',
    system: 'solc-standard-json-hermetic-v1',
    evidenceEquivalence: {
      replaces: 'repository-native-hardhat',
      reason: 'Hardhat HH11 package metadata invariant is bypassed without changing source bytes or compiler settings',
      sourceBytesPreserved: true,
      completeCompilerInputPreserved: true,
      completeCompilerOutputHashed: true
    },
    compilerVersion: compiler.version,
    compilerDiagnostics: diagnostics,
    compilerInputSha256: sha256(JSON.stringify(input)),
    compilerOutputSha256: sha256(outputText),
    compilationUnits:[{
      unitId:'hermetic-standard-json-1',
      profile:'hermetic',
      compilerVersion:compiler.version,
      compilerPackage:'solc',
      settings:input.settings,
      compilerInputSha256:sha256(JSON.stringify(input)),
      compilerOutputSha256:sha256(outputText),
      sourceContents:collected.sources,
      sourceAsts,
      artifacts
    }],
    stagingManifest,
    stagingManifestSha256: sha256(stableJson(stagingManifest)),
    sourceInventory: collected.manifest.map((item) => item.sourceName),
    sourceInventoryFiles: collected.manifest.length,
    artifacts,
    artifactCount: artifacts.length,
    sourceAsts,
    slitherStandardJsonPath: posixName(path.relative(projectRoot, standardJsonPath)),
    vendorRootAdapter,
    sbom
  };
}
