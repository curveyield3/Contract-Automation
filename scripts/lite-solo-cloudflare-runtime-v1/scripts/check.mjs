import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRunnerManifestV2 } from '../packages/github-native-sim/src/runner-manifest-v2.mjs';
import { V7_POLICY } from '../packages/github-native-sim/src/v7-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['node_modules', '.git', 'dist']);
const legacyAgentUpload = path.join(root, '.agent-upload');
const canonicalAgentUpload = path.join(root, 'process', 'agent-upload');
try {
  await fs.access(legacyAgentUpload);
  throw new Error('legacy root .agent-upload inbox must remain retired; use process/agent-upload');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
try { await fs.access(canonicalAgentUpload); }
catch { throw new Error('missing canonical process/agent-upload inbox'); }
const retiredPreflightSimPaths = [
  'apps/web',
  'apps/api',
  '.github/workflows/deploy.yml',
  '.github/workflows/simulate.yml',
  '.github/workflows/github-bridge.yml',
  '.github/ISSUE_TEMPLATE/preflightsim-job.md',
  'scripts/build.mjs',
  'scripts/release.test.mjs',
  'packages/github-bridge',
  'docs/setup.md',
  'docs/plans/preflightsim-lite-plan.md',
  'docs/specs/preflightsim-lite-spec.md',
];
for (const relative of retiredPreflightSimPaths) {
  try {
    await fs.access(path.join(root, relative));
    throw new Error(`retired PreflightSim web/API path must remain absent: ${relative}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
const files = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(absolute);
  }
}
await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`Syntax check failed: ${path.relative(root, file)}`);
  }
}

function moduleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

const fileSet = new Set(files);
function resolveRelativeModule(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

const v7SourceRoot = path.join(root, 'packages', 'github-native-sim', 'src');
const v7Roots = files.filter((file) => file.startsWith(`${v7SourceRoot}${path.sep}`));
const authoritativeV7Graph = new Set();
const pendingV7Modules = [...v7Roots];
while (pendingV7Modules.length > 0) {
  const file = pendingV7Modules.pop();
  if (authoritativeV7Graph.has(file)) continue;
  authoritativeV7Graph.add(file);
  const source = await fs.readFile(file, 'utf8');
  const specifiers = moduleSpecifiers(source);
  if (specifiers.includes('ganache') || /\brequire\(\s*['"]ganache['"]\s*\)/.test(source)) {
    throw new Error(`Authoritative V7 dependency graph may not import Ganache: ${path.relative(root, file)}`);
  }
  for (const specifier of specifiers) {
    const dependency = resolveRelativeModule(file, specifier);
    if (dependency && !authoritativeV7Graph.has(dependency)) pendingV7Modules.push(dependency);
  }
}

const requiredV7RunnerModules = [
  path.join(root, 'packages', 'runner', 'src', 'anvil-engine.mjs'),
  path.join(root, 'packages', 'runner', 'src', 'workflow-runtime.mjs'),
  path.join(root, 'packages', 'runner', 'src', 'rpc-identity-proxy-v1.mjs'),
];
for (const required of requiredV7RunnerModules) {
  if (!authoritativeV7Graph.has(required)) {
    throw new Error(`Canonical V7 dependency graph does not reach required runner module: ${path.relative(root, required)}`);
  }
}

const workflowRoot = path.join(root, '.github', 'workflows');
const workflowNames = await fs.readdir(workflowRoot);
const forbiddenVersionedWorkflows = workflowNames.filter((name) =>
  /^audit-controller-execution-v\d+\.yml$/.test(name)
  || /^v7-(?:recovery|v8-conformance).*\.yml$/.test(name)
);
if (forbiddenVersionedWorkflows.length > 0) {
  throw new Error(`Superseded/versioned V7 workflow entrypoints belong in CurveYield2/archive, not this repository: ${forbiddenVersionedWorkflows.join(', ')}`);
}
const canonicalWorkflows = ['audit-controller-execution.yml'];
for (const required of canonicalWorkflows) {
  if (!workflowNames.includes(required)) throw new Error(`Missing canonical V7 workflow: ${required}`);
  const source = await fs.readFile(path.join(workflowRoot, required), 'utf8');
  if (!source.includes('uses: ./.github/actions/setup-v7-toolchain')) {
    throw new Error(`Canonical V7 workflow must use shared toolchain setup action: ${required}`);
  }
}

const setupAction = path.join(root, V7_POLICY.workflows.toolchainSetup);
try { await fs.access(setupAction); }
catch { throw new Error(`Missing canonical V7 toolchain setup action: ${V7_POLICY.workflows.toolchainSetup}`); }

const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.dependencies?.['@foundry-rs/anvil'] !== V7_POLICY.tools.anvilPackage) {
  throw new Error(`@foundry-rs/anvil must equal V7 policy pin ${V7_POLICY.tools.anvilPackage}`);
}
if (packageJson.dependencies?.['@foundry-rs/forge'] !== V7_POLICY.tools.forge) {
  throw new Error(`@foundry-rs/forge must equal V7 policy pin ${V7_POLICY.tools.forge}`);
}
try { await fs.access(path.join(root, 'package-lock.json')); }
catch { throw new Error('package-lock.json is mandatory for reproducible V7 GitHub execution'); }

const processNames = await fs.readdir(path.join(root, 'process'));
const staleManifests = processNames.filter((name) => /^RUNNER_MANIFEST_v\d+\.json$/.test(name) || /^V7_BRIDGE_SMOKE_RECEIPT_v\d+\.json$/.test(name));
if (staleManifests.length > 0) throw new Error(`Superseded process artifacts belong in CurveYield2/archive: ${staleManifests.join(', ')}`);

const skeletonParent = path.join(root, 'packages', 'github-native-sim');
const skeletonEntries = await fs.readdir(skeletonParent, { withFileTypes: true });
const canonicalSkeletonDir = path.basename(V7_POLICY.phase6.skeletonRoot);
const staleSkeletonKits = skeletonEntries
  .filter((entry) => entry.isDirectory() && /^harness-skeletons-v\d+$/.test(entry.name) && entry.name !== canonicalSkeletonDir)
  .map((entry) => entry.name);
if (staleSkeletonKits.length > 0) {
  throw new Error(`Superseded Phase 6 skeleton kits belong in CurveYield2/archive: ${staleSkeletonKits.join(', ')}`);
}

const manifestCheck = await checkRunnerManifestV2({ runnerRoot: root });
if (manifestCheck.status !== 'PASS') throw new Error(`Canonical runner manifest drift: ${manifestCheck.reason ?? 'unknown'}`);

console.log(`Syntax valid: ${files.length} JavaScript modules; V7 canonical/Archive/Anvil/toolchain/lock policy guards valid`);
