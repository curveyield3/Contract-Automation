import { V7ExecutionError, runProcess } from './execution.mjs';
import { V7_POLICY } from './v7-policy.mjs';

const EXACT_SLITHER_VERSION = V7_POLICY.tools.slither;
const EXACT_MEDUSA_VERSION = V7_POLICY.tools.medusa;
const COMMIT = /^[0-9a-f]{40}$/;
const MEDUSA_NO_TESTS_MESSAGE = 'no assertion, property, optimization, or custom tests were found to fuzz';

function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.replaceAll(secret, '<redacted-mutable-anvil-rpc>');
  }
  return text;
}

function raw(result = {}, secrets = []) {
  return {
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : -1,
    stdout: redact(result.stdout, secrets),
    stderr: redact(result.stderr, secrets),
    ...(result.signal ? { signal: result.signal } : {})
  };
}

function validateCommon(input, expectedVersion) {
  if (!input || typeof input !== 'object') throw new V7ExecutionError('ANALYSIS_CONFIGURATION_FAILURE', 'analysis input is required');
  if (input.version !== expectedVersion) {
    throw new V7ExecutionError('TOOLCHAIN_INTEGRITY_FAILURE', `requested tool version must equal ${expectedVersion}`, {
      expectedVersion,
      requestedVersion: input.version ?? null
    });
  }
  if (!COMMIT.test(input.sourceCommit ?? '')) throw new V7ExecutionError('SOURCE_INTEGRITY_FAILURE', 'sourceCommit must be a 40-hex commit');
  if (typeof input.projectRoot !== 'string' || input.projectRoot.length === 0) throw new V7ExecutionError('ANALYSIS_CONFIGURATION_FAILURE', 'projectRoot is required');
  if (typeof input.rawArtifactRef !== 'string' || !input.rawArtifactRef.startsWith('github-actions://')) {
    throw new V7ExecutionError('ANALYSIS_CONFIGURATION_FAILURE', 'rawArtifactRef must be a github-actions:// reference');
  }
}

function validateMedusaFork(input) {
  if (typeof input.rpcUrl !== 'string' || input.rpcUrl.length === 0) throw new V7ExecutionError('MUTABLE_RPC_CONFIGURATION_FAILURE', 'Medusa Phase 6 requires the existing mutable Anvil RPC URL');
  if (!Number.isSafeInteger(input.rpcBlock) || input.rpcBlock < 0) throw new V7ExecutionError('MUTABLE_RPC_CONFIGURATION_FAILURE', 'Medusa Phase 6 requires the preflight-frozen mutable RPC block');
}

function versionMatches(output, expected) {
  const text = `${output?.stdout ?? ''}\n${output?.stderr ?? ''}`;
  const escaped = expected.replaceAll('.', '\\.');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(text.trim());
}

function slitherResult(input, fields) {
  return { backend: 'slither', version: EXACT_SLITHER_VERSION, sourceCommit: input.sourceCommit, rawArtifactRef: input.rawArtifactRef, ...fields };
}
function medusaResult(input, fields) {
  return { backend: 'medusa', version: EXACT_MEDUSA_VERSION, sourceCommit: input.sourceCommit, rawArtifactRef: input.rawArtifactRef, ...fields };
}
function objectOrEmpty(value) { return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {}; }
function metricState(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 ? 'PRESENT' : 'UNAVAILABLE_FROM_OUTPUT_MODE'; }
function metricAvailability(corpus, coverage, statistics) {
  return { corpus: metricState(corpus), coverage: metricState(coverage), statistics: metricState(statistics) };
}
function parseSlitherOutput(output) {
  try {
    const parsed = JSON.parse(String(output ?? ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const detectors = Array.isArray(parsed?.results?.detectors) ? structuredClone(parsed.results.detectors) : [];
    return { success: parsed.success === true, detectors, findingCount: detectors.length };
  } catch { return null; }
}

function normalizeMedusaCliLine(line) {
  return String(line ?? '').trim().replace(/^⇾\s*/, '');
}

function parseMedusaCliOutput(output) {
  const plainText = String(output ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  const unavailable = { corpus: 'UNAVAILABLE_FROM_OUTPUT_MODE', coverage: 'UNAVAILABLE_FROM_OUTPUT_MODE', statistics: 'UNAVAILABLE_FROM_OUTPUT_MODE' };
  if (plainText.includes(MEDUSA_NO_TESTS_MESSAGE)) {
    return {
      status: 'no_tests',
      properties: [],
      falsifiedProperties: 0,
      corpus: {},
      coverage: {},
      statistics: {},
      metricAvailability: unavailable
    };
  }

  const lines = plainText.split(/\r?\n/);
  const resultHeader = /^\[(PASSED|FAILED)\]\s+Property Test:\s+(.+?)\s*$/;
  const properties = [];

  for (let index = 0; index < lines.length; index++) {
    const match = normalizeMedusaCliLine(lines[index]).match(resultHeader);
    if (!match) continue;

    const failed = match[1] === 'FAILED';
    const property = { name: match[2], status: failed ? 'failed' : 'passed' };
    if (failed) {
      const counterexample = [];
      let inCallSequence = false;
      for (let cursor = index + 1; cursor < lines.length; cursor++) {
        const candidate = normalizeMedusaCliLine(lines[cursor]);
        if (resultHeader.test(candidate)) break;
        if (candidate === '[Call Sequence]') {
          inCallSequence = true;
          continue;
        }
        if (inCallSequence && /^\d+\)\s+/.test(candidate)) counterexample.push(candidate);
      }
      if (counterexample.length > 0) property.counterexample = counterexample;
    }
    properties.push(property);
  }

  if (properties.length === 0) return null;
  const falsifiedProperties = properties.filter((property) => property.status === 'failed').length;
  return {
    status: falsifiedProperties > 0 ? 'falsified' : 'completed',
    properties,
    falsifiedProperties,
    corpus: {},
    coverage: {},
    statistics: {},
    metricAvailability: unavailable
  };
}

export function parseMedusaOutput(output) {
  let parsed;
  try { parsed = JSON.parse(String(output ?? '')); }
  catch (error) {
    const cliCampaign = parseMedusaCliOutput(output);
    if (cliCampaign) return cliCampaign;
    throw new V7ExecutionError('EVIDENCE_PARSE_FAILURE', 'Medusa terminal output is neither valid JSON nor recognized Medusa 1.5.1 CLI evidence', { cause: error.message });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new V7ExecutionError('EVIDENCE_PARSE_FAILURE', 'Medusa terminal output must be a JSON object');
  const properties = Array.isArray(parsed.properties) ? structuredClone(parsed.properties) : [];
  const falsifiedProperties = properties.filter((property) => property && property.status === 'failed').length;
  const corpus = objectOrEmpty(parsed.corpus);
  const coverage = objectOrEmpty(parsed.coverage);
  const statistics = objectOrEmpty(parsed.statistics);
  return {
    status: typeof parsed.status === 'string' ? parsed.status : (falsifiedProperties > 0 ? 'falsified' : 'completed'),
    properties,
    falsifiedProperties,
    corpus,
    coverage,
    statistics,
    metricAvailability: metricAvailability(corpus, coverage, statistics)
  };
}

export async function runSlitherAnalysis(input, { runCommand = runProcess } = {}) {
  validateCommon(input, EXACT_SLITHER_VERSION);
  const versionResult = await runCommand({ command: 'slither', args: ['--version'], cwd: input.projectRoot });
  if (!versionResult || versionResult.exitCode !== 0) return slitherResult(input, { status:'failed', terminal:true, failureKind:'TOOL_FAILURE', componentStatus:'FAILED', continuationDisposition:'CONTINUE_WITH_LIMITATION', rawOutput:raw(versionResult) });
  if (!versionMatches(versionResult, EXACT_SLITHER_VERSION)) throw new V7ExecutionError('TOOLCHAIN_INTEGRITY_FAILURE', 'Slither version does not match the V7 policy pin', { expectedVersion:EXACT_SLITHER_VERSION, stdout:String(versionResult.stdout ?? ''), stderr:String(versionResult.stderr ?? '') });
  const slitherArgs = input.standardJsonPath
    ? [input.standardJsonPath, '--solc-standard-json', '--json', '-']
    : ['.', '--json', '-'];
  const analysisResult = await runCommand({ command: 'slither', args: slitherArgs, cwd: input.projectRoot });
  if (!analysisResult || analysisResult.exitCode < 0) return slitherResult(input, { status:'failed', terminal:true, failureKind:'TOOL_FAILURE', componentStatus:'FAILED', continuationDisposition:'CONTINUE_WITH_LIMITATION', rawOutput:raw(analysisResult) });
  const parsed = parseSlitherOutput(analysisResult.stdout);
  if (parsed?.success === true) return slitherResult(input, { status:parsed.findingCount > 0 ? 'completed_with_findings' : 'completed', terminal:true, componentStatus:'COMPLETED', continuationDisposition:'COMPLETE_EVIDENCE', authoritativeFinding:false, findingCount:parsed.findingCount, detectors:parsed.detectors, rawOutput:raw(analysisResult) });
  if (analysisResult.exitCode !== 0 || parsed?.success === false) return slitherResult(input, { status:'completed_with_failures', terminal:true, failureKind:'ANALYSIS_COMPONENT_FAILURE', componentStatus:'COMPLETED_WITH_FAILURES', continuationDisposition:'CONTINUE_WITH_LIMITATION', rawOutput:raw(analysisResult) });
  return slitherResult(input, { status:'completed', terminal:true, componentStatus:'COMPLETED', continuationDisposition:'COMPLETE_EVIDENCE', rawOutput:raw(analysisResult) });
}

export async function runMedusaAnalysis(input, { runCommand = runProcess } = {}) {
  validateCommon(input, EXACT_MEDUSA_VERSION);
  validateMedusaFork(input);
  const secrets = [input.rpcUrl];
  const forkEvidence = {
    mode: 'mandatory-fork',
    backendPolicy: V7_POLICY.mutableRpc.backendPolicy,
    rpcProfile: input.rpcProfile ?? null,
    blockNumber: input.rpcBlock,
    blockHash: input.rpcBlockHash ?? null,
    rpcUrlExposed: false,
  };
  const versionResult = await runCommand({ command: 'medusa', args: ['--version'], cwd: input.projectRoot });
  if (!versionResult || versionResult.exitCode !== 0) return medusaResult(input, { status:'failed', terminal:true, failureKind:'TOOL_FAILURE', componentStatus:'FAILED', continuationDisposition:'CONTINUE_WITH_LIMITATION', fork:forkEvidence, rawOutput:raw(versionResult, secrets) });
  if (!versionMatches(versionResult, EXACT_MEDUSA_VERSION)) throw new V7ExecutionError('TOOLCHAIN_INTEGRITY_FAILURE', 'Medusa version does not match the V7 policy pin', { expectedVersion:EXACT_MEDUSA_VERSION, stdout:redact(versionResult.stdout, secrets), stderr:redact(versionResult.stderr, secrets) });

  const campaignResult = await runCommand({
    command: 'medusa',
    args: ['fuzz', '--rpc-url', input.rpcUrl, '--rpc-block', String(input.rpcBlock)],
    cwd: input.projectRoot,
  });
  if (!campaignResult || campaignResult.exitCode < 0) return medusaResult(input, { status:'failed', terminal:true, failureKind:'TOOL_FAILURE', componentStatus:'FAILED', continuationDisposition:'CONTINUE_WITH_LIMITATION', fork:forkEvidence, rawOutput:raw(campaignResult, secrets) });

  const rawOutput = raw(campaignResult, secrets);
  let campaign;
  try {
    campaign = parseMedusaOutput(campaignResult.stdout);
  } catch (error) {
    if (error instanceof V7ExecutionError && error.kind === 'EVIDENCE_PARSE_FAILURE') {
      return medusaResult(input, {
        status:'failed', terminal:true, failureKind:'EVIDENCE_PARSE_FAILURE', componentStatus:'FAILED',
        continuationDisposition:'CONTINUE_WITH_LIMITATION', fork:forkEvidence, rawOutput,
        error:{ name:error.name, message:error.message }
      });
    }
    throw error;
  }

  if (campaign.status === 'no_tests') {
    return medusaResult(input, {
      status:'completed_with_failures', terminal:true, failureKind:'NO_TESTS_DISCOVERED', componentStatus:'COMPLETED_WITH_FAILURES',
      continuationDisposition:'CONTINUE_WITH_LIMITATION', fork:forkEvidence, campaign, rawOutput
    });
  }

  const falsified = campaign.falsifiedProperties > 0 || campaign.status === 'falsified';
  if (falsified || campaignResult.exitCode !== 0) return medusaResult(input, { status:'completed_with_failures', terminal:true, failureKind:falsified ? 'PROPERTY_FALSIFICATION' : 'ANALYSIS_COMPONENT_FAILURE', componentStatus:'COMPLETED_WITH_FAILURES', continuationDisposition:'CONTINUE_WITH_LIMITATION', fork:forkEvidence, campaign, rawOutput });
  return medusaResult(input, { status:'completed', terminal:true, componentStatus:'COMPLETED', continuationDisposition:'COMPLETE_EVIDENCE', fork:forkEvidence, campaign, rawOutput });
}
