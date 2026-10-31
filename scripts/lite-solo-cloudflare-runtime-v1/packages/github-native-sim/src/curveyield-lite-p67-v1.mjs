import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProcess } from './execution.mjs';

const EXACT = Object.freeze({
  campaignId: 'curveyield-dex-fresh-audit-r1',
  phaseId: 'lite-p67',
  sourceRepository: 'curveyield3/Audit-Controller',
  sourceCommit: 'c41958422daf46c3b929182f90e53b872cedada6',
  archiveSha256: '526a729ce73d493f2ccbb568378a18dd1eec0788d0165e02dc5ceb773b9953ed',
  actionKind: 'curveyield-lite-p67-v1',
  executionSet: 'retained-lite-v1',
});
const RUNNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEV_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sanitizeFailureText(value) {
  const redacted = String(value ?? '')
    .replaceAll(DEV_PRIVATE_KEY, '[REDACTED_DEV_PRIVATE_KEY]')
    .replace(/https?:\/\/[^\s"']+/gi, '[REDACTED_URL]');
  return redacted.slice(-12000);
}


export async function resolveCurveYieldLiteP67Anvil() {
  const candidate = path.join(RUNNER_ROOT, 'node_modules', '@foundry-rs', 'anvil', 'bin.mjs');
  await fs.access(candidate);
  await fs.chmod(candidate, 0o755);
  return candidate;
}

async function waitForRpc(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Local Anvil exited before readiness with code ${child.exitCode}`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      const payload = await response.json();
      if (payload?.result === '0x2105') return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Local Anvil did not become ready for retained Lite deployment simulation');
}

async function rpcRequest(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`Local RPC ${method} failed: ${payload.error.message}`);
  return payload.result;
}

async function executeSequentialSimulation(upstreamUrl, params) {
  const blockStateCalls = params?.[0]?.blockStateCalls ?? [];
  const blocks = [];
  for (const entry of blockStateCalls) {
    const sourceCall = entry?.calls?.[0];
    if (!sourceCall) throw new Error('Sequential simulation received an empty blockStateCall');
    const transaction = { ...sourceCall, gas: '0x1dcd6500' };
    const hash = await rpcRequest(upstreamUrl, 'eth_sendTransaction', [transaction]);
    const receipt = await rpcRequest(upstreamUrl, 'eth_getTransactionReceipt', [hash]);
    const block = await rpcRequest(upstreamUrl, 'eth_getBlockByNumber', [receipt.blockNumber, false]);
    blocks.push({
      baseFeePerGas: block?.baseFeePerGas ?? '0x0',
      gasUsed: receipt.gasUsed,
      calls: [{
        status: receipt.status,
        gasUsed: receipt.gasUsed,
        returnData: '0x',
        logs: receipt.logs ?? [],
      }],
    });
  }
  return blocks;
}

async function startSequentialSimulationBridge(upstreamUrl, port) {
  const server = createServer(async (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) body += chunk;
    try {
      const payload = JSON.parse(body);
      const result = payload.method === 'eth_simulateV1'
        ? await executeSequentialSimulation(upstreamUrl, payload.params)
        : await rpcRequest(upstreamUrl, payload.method, payload.params);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: error.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function exactAction(request) {
  const action = request?.configuration?.actions;
  return request?.campaignId === EXACT.campaignId
    && request?.phaseId === EXACT.phaseId
    && request?.source?.repository === EXACT.sourceRepository
    && request?.source?.commit === EXACT.sourceCommit
    && request?.source?.archiveSha256 === EXACT.archiveSha256
    && action?.kind === EXACT.actionKind
    && action?.executionSet === EXACT.executionSet;
}

export function isCurveYieldLiteP67Request(request) {
  return exactAction(request);
}

function commandEvidence(result) {
  return {
    exitCode: result?.exitCode ?? -1,
    stdoutSha256: sha256(String(result?.stdout ?? '')),
    stderrSha256: sha256(String(result?.stderr ?? '')),
  };
}

function vitestSummary(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/);
  return {
    testFiles: lines.find((line) => /Test Files/.test(line))?.trim() ?? null,
    tests: lines.find((line) => /^\s*Tests\s/.test(line))?.trim() ?? null,
    duration: lines.find((line) => /^\s*Duration\s/.test(line))?.trim() ?? null,
  };
}

async function reportInventory(projectRoot) {
  const directory = path.join(projectRoot, 'deployment-artifacts');
  try {
    const entries = await fs.readdir(directory);
    return new Set(entries.filter((name) => name.startsWith('curveyield-dex-fresh-live-simulation-') && name.endsWith('.json')));
  } catch {
    return new Set();
  }
}

async function readNewSimulationReport(projectRoot, before) {
  const directory = path.join(projectRoot, 'deployment-artifacts');
  const entries = (await fs.readdir(directory))
    .filter((name) => name.startsWith('curveyield-dex-fresh-live-simulation-') && name.endsWith('.json') && !before.has(name))
    .sort();
  if (entries.length !== 1) throw new Error(`Expected exactly one new deployment simulation report, observed ${entries.length}`);
  const bytes = await fs.readFile(path.join(directory, entries[0]));
  const report = JSON.parse(bytes.toString('utf8'));
  const sanitized = structuredClone(report);
  sanitized.rpcUrl = '[REDACTED_PUBLIC_ENDPOINT]';
  return {
    file: entries[0],
    sha256: sha256(bytes),
    report: sanitized,
  };
}

export async function runCurveYieldLiteP67({ request, projectRoot, environment = process.env, runCommand = runProcess }) {
  if (!exactAction(request)) throw new Error('CurveYield Lite P6-7 action is not admitted for this exact campaign/source/action identity');

  const anvilPath = await resolveCurveYieldLiteP67Anvil();
  const targetedTests = [
    'tooling/test/curveYieldDexAuditRuntime.test.mjs',
    'tooling/test/curveYieldDexPermanentLiquidityRuntime.test.mjs',
    'tooling/test/curveYieldDexSettlementRuntime.test.mjs',
    'tooling/test/curveYieldObservationRuntime.test.mjs',
    'tooling/test/curveYieldVolumeAdaptiveFeeRuntime.test.mjs',
    'tooling/test/curveYieldObservationModel.test.mjs',
    'tooling/test/curveYieldVolumeAdaptiveFee.test.mjs',
    'tooling/test/curveYieldDexAuditModels.test.mjs',
    'tooling/test/curveYieldCompositeHookInterfaces.test.mjs',
    'tooling/test/poolFeePolicySource.test.mjs',
  ];
  const testResult = await runCommand({
    command: 'node',
    args: ['node_modules/vitest/vitest.mjs', 'run', ...targetedTests],
    cwd: projectRoot,
    env: { ...environment, ANVIL_PATH: anvilPath },
  });

  const before = await reportInventory(projectRoot);
  const upstreamRpcUrl = 'http://127.0.0.1:8640';
  const simulationRpcUrl = 'http://127.0.0.1:8641';
  const anvil = spawn(anvilPath, [
    '--port', '8640', '--silent', '--chain-id', '8453', '--gas-limit', '1000000000', '--disable-code-size-limit',
  ], { cwd: projectRoot, env: environment, stdio: 'ignore' });
  let bridge = null;
  let simulationResult;
  try {
    await waitForRpc(upstreamRpcUrl, anvil);
    bridge = await startSequentialSimulationBridge(upstreamRpcUrl, 8641);
    simulationResult = await runCommand({
      command: 'node',
      args: ['tooling/scripts/simulateCurveYieldDexFresh.mjs'],
      cwd: projectRoot,
      env: {
        ...environment,
        DEPLOYER_PRIVATE_KEY: DEV_PRIVATE_KEY,
        SIMULATION_BASE_RPC_URL: simulationRpcUrl,
        MAX_FEE_PER_GAS_WEI: '10000000000',
      },
    });
  } finally {
    await stopServer(bridge);
    await stopProcess(anvil);
  }
  let deploymentConfigurationSimulation = null;
  try {
    deploymentConfigurationSimulation = await readNewSimulationReport(projectRoot, before);
  } catch (error) {
    deploymentConfigurationSimulation = { reportReadError: error.message };
  }

  const testEvidence = {
    status: testResult.exitCode === 0 ? 'PASS' : 'FAIL',
    command: `node node_modules/vitest/vitest.mjs run ${targetedTests.join(' ')}`,
    ...commandEvidence(testResult),
    summary: vitestSummary(testResult.stdout),
    ...(testResult.exitCode === 0 ? {} : { failureOutput: { stdoutTail: sanitizeFailureText(testResult.stdout), stderrTail: sanitizeFailureText(testResult.stderr) } }),
    retainedCoverage: [
      'candidate-specific-deterministic-simulation',
      'basic-targeted-fuzzing',
    ],
  };
  const simulationEvidence = {
    status: simulationResult.exitCode === 0 && deploymentConfigurationSimulation?.report?.simulation?.success === true ? 'PASS' : 'FAIL',
    command: 'node tooling/scripts/simulateCurveYieldDexFresh.mjs via runner-owned-sequential-local-anvil-v1',
    ...commandEvidence(simulationResult),
    evidence: deploymentConfigurationSimulation,
    ...(simulationResult.exitCode === 0 ? {} : { failureOutput: { stdoutTail: sanitizeFailureText(simulationResult.stdout), stderrTail: sanitizeFailureText(simulationResult.stderr) } }),
    method: 'runner-owned-sequential-local-anvil-v1',
    retainedCoverage: ['complete-deployment-configuration-simulation'],
  };
  const status = testEvidence.status === 'PASS' && simulationEvidence.status === 'PASS' ? 'completed' : 'failed';
  const logSummary = {
    status,
    sourceToolingTests: {
      status: testEvidence.status,
      exitCode: testEvidence.exitCode,
      summary: testEvidence.summary,
      ...(testEvidence.failureOutput ? { failureOutput: testEvidence.failureOutput } : {}),
    },
    deploymentConfigurationSimulation: {
      status: simulationEvidence.status,
      exitCode: simulationEvidence.exitCode,
      reportFile: deploymentConfigurationSimulation?.file ?? null,
      reportSha256: deploymentConfigurationSimulation?.sha256 ?? null,
      simulation: deploymentConfigurationSimulation?.report?.simulation ?? null,
      reportReadError: deploymentConfigurationSimulation?.reportReadError ?? null,
      ...(simulationEvidence.failureOutput ? { failureOutput: simulationEvidence.failureOutput } : {}),
    },
  };

  return {
    schemaVersion: 'audit-v7-lite-p67-execution-v1',
    status,
    exactIdentity: { ...EXACT },
    excludedFullMethods: [
      'medusa',
      'broad-random-discovery',
      'stateful-randomized',
      'chaos',
      'mutation',
      'differential-reference',
      'corpus-deep',
      'exhaustive-known-attack',
      'coverage-guided-reruns',
    ],
    sourceToolingTests: testEvidence,
    deploymentConfigurationSimulation: simulationEvidence,
    logSummary,
  };
}
