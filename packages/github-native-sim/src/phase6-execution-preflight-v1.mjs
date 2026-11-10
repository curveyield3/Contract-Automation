import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './execution.mjs';
import { probePhase6MutableRpc } from './phase6-mutable-rpc-v1.mjs';
import { V7_TOOLCHAIN, toolOutputMatchesVersion } from './v7-toolchain-v1.mjs';

const SUPPORTED_COMPILER_LANGUAGES = new Set(['solidity', 'vyper']);

async function walk(root, dir = root, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, absolute, out);
    else if (entry.isFile()) out.push(path.relative(root, absolute).split(path.sep).join('/'));
  }
  return out;
}

async function containsPropertyFunction(projectRoot, file) {
  if (!file.endsWith('.sol')) return false;
  const source = await fs.readFile(path.join(projectRoot, file), 'utf8');
  return /\b(property_|echidna_|invariant_)[A-Za-z0-9_]*\s*\(/.test(source);
}

async function toolVersion(name, { cwd, runCommand }) {
  const spec = V7_TOOLCHAIN[name];
  if (!spec) throw new Error(`Unknown V7 toolchain component ${name}`);
  let result;
  try {
    result = await runCommand({ command: spec.command, args: ['--version'], cwd });
  } catch (error) {
    return {
      available: false,
      exactVersion: false,
      expectedVersion: spec.version,
      exitCode: -1,
      stdout: '',
      stderr: error?.message ?? String(error),
      failureKind: 'TOOL_UNAVAILABLE',
    };
  }
  const stdout = String(result?.stdout ?? '');
  const stderr = String(result?.stderr ?? '');
  const available = Boolean(result && result.exitCode === 0);
  const exactVersion = available && toolOutputMatchesVersion(`${stdout}\n${stderr}`, spec.version);
  return {
    available,
    exactVersion,
    expectedVersion: spec.version,
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : -1,
    stdout,
    stderr,
    failureKind: !available ? 'TOOL_UNAVAILABLE' : exactVersion ? null : 'TOOL_VERSION_MISMATCH',
  };
}

function requested(component) {
  return component !== false && component !== undefined;
}

export async function runPhase6ExecutionPreflightV1({
  request,
  projectRoot,
  runnerCommit,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  runCommand = runProcess,
  mutableRpcEvidence = null,
}) {
  if (!request || request.phaseId !== 'build-and-test') throw new Error('Phase 6 preflight requires a build-and-test request');
  if (request.profileId !== 'github-native-simulate-v2') throw new Error('Phase 6 preflight requires github-native-simulate-v2');
  if (!projectRoot || typeof projectRoot !== 'string') throw new Error('Phase 6 preflight requires projectRoot');

  const files = await walk(projectRoot);
  const soliditySources = files.filter((file) => file.endsWith('.sol') && !/\.t\.sol$/i.test(file));
  const vyperSources = files.filter((file) => file.endsWith('.vy'));
  const medusaConfigs = files.filter((file) => /(^|\/)medusa[^/]*\.json$/i.test(file));
  const foundryConfigs = files.filter((file) => /(^|\/)foundry\.toml$/i.test(file));
  const solidityTests = files.filter((file) => /\.t\.sol$/i.test(file));
  const propertySources = [];
  for (const file of files.filter((item) => item.endsWith('.sol'))) {
    if (await containsPropertyFunction(projectRoot, file)) propertySources.push(file);
  }

  const medusaRequested = requested(request.configuration?.analysis?.medusa);
  const nativeFuzzRequested = request.configuration?.analysis?.nativeFuzz?.enabled === true;

  const medusaHarnessPresent = medusaConfigs.length > 0 || propertySources.length > 0;
  const nativeFuzzHarnessPresent = foundryConfigs.length > 0 && solidityTests.length > 0;
  // Never schedule blanket fuzz/invariant runs. Optional agent-selected targets
  // must match a restricted harness before launch; otherwise skip them.
  const selectedProperty = request.configuration?.analysis?.medusa?.targetProperty;
  let medusaTargetGuided = false;
  if (/^(?:property_|invariant_|echidna_)[A-Za-z0-9_]+$/.test(selectedProperty ?? '')) {
    try {
      const config = JSON.parse(await fs.readFile(path.join(projectRoot, 'medusa.json'), 'utf8'));
      const testing = config?.fuzzing?.testing;
      medusaTargetGuided = JSON.stringify(testing?.propertyTesting?.testPrefixes) === JSON.stringify([selectedProperty])
        && testing?.assertionTesting?.enabled === false
        && testing?.optimizationTesting?.enabled === false;
    } catch { medusaTargetGuided = false; }
  }
  const selectedTest = request.configuration?.analysis?.nativeFuzz?.matchTest;
  // The accepted BoostHub V9 P5-T007 request explicitly selects the candidate
  // test prefix, which the existing harness implements in several proof/control
  // functions. Restrict this compatibility behavior to its bound source bundle.
  const boosthubP5 = [
    'boosthub-v9-r1-phase5-candidate-targets-v1',
    'boosthub-v9-r1-phase5-candidate-targets-v1-g7adcb74caefeeef3'
  ].includes(request.configuration?.harness?.bundleId)
    && request.source?.archiveSha256 === '876bae622270c99a48fa7cf5e984ee0b46f74b02d38e32a2be394bbc69aeb5b3';
  let nativeTestGuided = false;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(selectedTest ?? '')) {
    const selectedDeclaration = boosthubP5 && selectedTest === 'testFuzz_P5T007_'
      ? 'testFuzz_P5T007_[A-Za-z0-9_]+' : selectedTest;
    const declaration = new RegExp('\\bfunction\\s+' + selectedDeclaration + '\\s*\\(');
    for (const file of solidityTests) {
      if (declaration.test(await fs.readFile(path.join(projectRoot, file), 'utf8'))) {
        nativeTestGuided = true;
        break;
      }
    }
  }
  // Unselected or mismatched fuzz/invariant configurations are not mandatory audit work.
  // Only a complete, source-matching agent selection may launch a fuzzing backend.
  const mutableRpcRequired = (medusaRequested && medusaTargetGuided)
    || (nativeFuzzRequested && nativeTestGuided);
  const mutableRpc = mutableRpcRequired
    ? (mutableRpcEvidence ?? await probePhase6MutableRpc({ environment, fetchImpl }))
    : { status: 'NOT_REQUIRED', profile: null, backendPolicy: 'EXISTING_CURVEYIELD_MUTABLE_ANVIL_RPC_ONLY' };

  const medusaTechnicallyApplicable = medusaRequested && soliditySources.length > 0;
  const nativeFuzzTechnicallyApplicable = nativeFuzzRequested && (soliditySources.length > 0 || vyperSources.length > 0);

  const compilerAcceptance = request.configuration?.compilers?.length > 0
    && request.configuration.compilers.every((compiler) => SUPPORTED_COMPILER_LANGUAGES.has(compiler.language) && typeof compiler.version === 'string' && compiler.version.length > 0);

  let medusa;
  if (!medusaRequested) {
    medusa = { status: 'NOT_REQUESTED', technicallyApplicable: null, harnessPresent: null, toolInvoked: false };
  } else if (!medusaTargetGuided) {
    medusa = { status: 'SKIPPED_UNGUIDED', technicallyApplicable: null, harnessPresent: medusaHarnessPresent,
      toolInvoked: false, reason: 'NO_MATCHING_AGENT_GUIDED_MEDUSA_PROPERTY_CONFIGURATION' };
  } else if (!medusaTechnicallyApplicable) {
    medusa = { status: 'NOT_APPLICABLE', technicallyApplicable: false, harnessPresent: false, toolInvoked: false, reason: 'NO_SOLIDITY_TARGET_FOR_MEDUSA' };
  } else if (!medusaHarnessPresent) {
    medusa = { status: 'HARNESS_REQUIRED', technicallyApplicable: true, harnessPresent: false, toolInvoked: false, reason: 'SELECTED_MEDUSA_HARNESS_MISSING' };
  } else {
    medusa = { status: 'PENDING_TOOL_CHECK', technicallyApplicable: true, harnessPresent: true, toolInvoked: true, tool: await toolVersion('medusa', { cwd: projectRoot, runCommand }) };
    medusa.status = medusa.tool.available && medusa.tool.exactVersion ? 'READY' : 'BLOCKED_INFRASTRUCTURE';
  }

  let nativeFuzz;
  if (!nativeFuzzRequested) {
    nativeFuzz = { status: 'NOT_REQUESTED', technicallyApplicable: null, harnessPresent: null, toolInvoked: false };
  } else if (!nativeTestGuided) {
    nativeFuzz = { status: 'SKIPPED_UNGUIDED', technicallyApplicable: null, harnessPresent: nativeFuzzHarnessPresent,
      toolInvoked: false, reason: 'NO_MATCHING_AGENT_GUIDED_FOUNDRY_TEST_CONFIGURATION' };
  } else if (!nativeFuzzTechnicallyApplicable) {
    nativeFuzz = { status: 'NOT_APPLICABLE', technicallyApplicable: false, harnessPresent: false, toolInvoked: false, reason: 'NO_SUPPORTED_TARGET_FOR_NATIVE_FUZZ' };
  } else if (!nativeFuzzHarnessPresent) {
    nativeFuzz = { status: 'HARNESS_REQUIRED', technicallyApplicable: true, harnessPresent: false, toolInvoked: false, reason: 'SELECTED_FOUNDRY_HARNESS_MISSING' };
  } else {
    nativeFuzz = { status: 'PENDING_TOOL_CHECK', technicallyApplicable: true, harnessPresent: true, toolInvoked: true, tool: await toolVersion('forge', { cwd: projectRoot, runCommand }) };
    nativeFuzz.status = nativeFuzz.tool.available && nativeFuzz.tool.exactVersion ? 'READY' : 'BLOCKED_INFRASTRUCTURE';
  }

  const harnessRequired = [medusa, nativeFuzz].some((component) => component.status === 'HARNESS_REQUIRED');
  const toolInfrastructureBlocked = [medusa, nativeFuzz].some((component) => component.status === 'BLOCKED_INFRASTRUCTURE');
  const mutableRpcBlocked = mutableRpcRequired && mutableRpc.status !== 'PASS';
  const infrastructureBlocked = toolInfrastructureBlocked || mutableRpcBlocked;
  const status = compilerAcceptance && !harnessRequired && !infrastructureBlocked ? 'PASS' : 'BLOCKED';
  const nextState = harnessRequired
    ? 'PHASE6_HARNESS_AUTHORING'
    : infrastructureBlocked
      ? 'RUNNER_REPAIR_REBIND'
      : status === 'PASS'
        ? 'ACTIVE'
        : 'PHASE6_EXECUTION_PREFLIGHT';

  return {
    schemaVersion: 'audit-v7-phase6-execution-preflight-v5',
    status,
    failureKind: mutableRpcBlocked
      ? (mutableRpc.failureKind ?? 'MUTABLE_RPC_UNAVAILABLE')
      : toolInfrastructureBlocked
        ? 'PHASE6_TOOLCHAIN_UNAVAILABLE_OR_MISMATCHED'
        : null,
    phaseId: request.phaseId,
    profileId: request.profileId,
    requestId: request.requestId,
    sourceCommit: request.source.commit,
    runnerCommit,
    contractAutomationRelease: request.contractAutomationRelease,
    runnerRelease: request.runnerRelease,
    compilerAcceptance: {
      status: compilerAcceptance ? 'PASS' : 'FAIL',
      requested: request.configuration.compilers,
    },
    mutableRpcPolicy: {
      rule: 'ALL_PHASE6_MUTABLE_OR_FORK_RPC_ACCESS_USES_ONE_IDENTITY_NORMALIZED_EXISTING_CURVEYIELD_MUTABLE_ANVIL_RPC_SESSION',
      requesterSuppliedRpcAllowed: false,
      alternateMutableRpcAllowed: false,
      medusaForkModeRequired: medusaRequested,
      foundryForkModeRequired: nativeFuzzRequested,
      sameNormalizedSessionRequiredForPreflightMedusaAndFoundry: mutableRpcRequired,
      runtimeSecretMustNotAppearInEvidence: true,
    },
    mutableRpc,
    harnessPolicy: {
      rule: 'ONLY_OPTIONAL_AGENT_SELECTED_HARNESSES_MAY_EXECUTE_WITHOUT_MODIFYING_FROZEN_PRODUCTION_SOURCE',
      missingHarnessIsNotNotApplicable: true,
      unselectedOrUnmatchedHarnessesSkipWithoutBlocking: true,
      notApplicableRequiresTechnicalInapplicability: true,
      modelBasedTestingMaySupplementButNeverReplaceRequiredExecutableHarnesses: true,
      phaseCannotPassWhileHarnessRequired: true,
    },
    harnessInventory: {
      fileCount: files.length,
      soliditySources,
      vyperSources,
      medusaConfigs,
      propertySources,
      foundryConfigs,
      solidityTests,
    },
    medusa,
    nativeFuzz,
    nextState,
  };
}
