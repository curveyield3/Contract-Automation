import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMedusaAnalysis } from './analysis.mjs';

const SOURCE_COMMIT = '0'.repeat(40);

export function buildMedusaSmokeConfigV1({ contractName, targetFunctions, stopOnNoTests = true }) {
  return {
    fuzzing: {
      workers: 1,
      testLimit: 32,
      shrinkLimit: 128,
      callSequenceLength: 4,
      coverageEnabled: true,
      revertReporterEnabled: true,
      targetContracts: [contractName],
      senderAddresses: ['0x10000'],
      testing: {
        stopOnFailedTest: false,
        stopOnNoTests,
        testAllContracts: false,
        testViewMethods: true,
        assertionTesting: { enabled: false },
        propertyTesting: { enabled: true, testPrefixes: ['property_'] },
        optimizationTesting: { enabled: false, testPrefixes: ['optimize_'] },
        targetFunctionSignatures: targetFunctions,
        excludeFunctionSignatures: []
      },
      chainConfig: {
        cheatCodes: { cheatCodesEnabled: true, enableFFI: false },
        forkConfig: {
          forkModeEnabled: true,
          rpcUrl: 'PHASE6_RUNTIME_INJECTION_REQUIRED',
          rpcBlock: 1,
          poolSize: 1
        }
      }
    },
    compilation: {
      platform: 'crytic-compile',
      platformConfig: { target: '.', args: ['--foundry-compile-all'] }
    },
    slither: { useSlither: false },
    logging: { level: 'info', logDirectory: '', noColor: true }
  };
}

const FIXTURES = {
  pass: {
    contractName: 'MedusaSmokePassV1',
    targetFunctions: ['MedusaSmokePassV1.actionNoop(uint256)'],
    source: `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.28;\ncontract MedusaSmokePassV1 {\n    uint256 public calls;\n    function actionNoop(uint256 value) external { calls ^= value; }\n    function property_pass() external pure returns (bool) { return true; }\n}\n`
  },
  falsification: {
    contractName: 'MedusaSmokeFailV1',
    targetFunctions: ['MedusaSmokeFailV1.actionBreak()'],
    source: `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.28;\ncontract MedusaSmokeFailV1 {\n    bool public broken;\n    function actionBreak() external { broken = true; }\n    function property_never_broken() external view returns (bool) { return !broken; }\n}\n`
  },
  noTests: {
    contractName: 'MedusaSmokeNoTestsV1',
    targetFunctions: ['MedusaSmokeNoTestsV1.actionNoop(uint256)'],
    source: `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.28;\ncontract MedusaSmokeNoTestsV1 {\n    uint256 public calls;\n    function actionNoop(uint256 value) external { calls ^= value; }\n}\n`
  },
  mixedLanguagePass: {
    contractName: 'MedusaSmokeMixedPassV1',
    targetFunctions: ['MedusaSmokeMixedPassV1.actionNoop(uint256)'],
    source: `// SPDX-License-Identifier: UNLICENSED\npragma solidity 0.8.28;\ncontract MedusaSmokeMixedPassV1 {\n    uint256 public calls;\n    function actionNoop(uint256 value) external { calls ^= value; }\n    function property_mixed_language_pass() external pure returns (bool) { return true; }\n}\n`,
    vyperFile: 'src/UnusedVyperFixture_v1.vy',
    vyperSource: `# @version 0.3.10\n\n@external\n@view\ndef unused() -> uint256:\n    return 1\n`,
    foundrySkip: ['src/UnusedVyperFixture_v1.vy']
  }
};

function foundryConfigForFixture(fixture) {
  const skipEntries = Array.isArray(fixture.foundrySkip) ? fixture.foundrySkip : [];
  const skipLine = skipEntries.length > 0 ? `skip = ${JSON.stringify(skipEntries)}\n` : '';
  return `[profile.default]\nsrc = "src"\nout = "out"\nlibs = []\nsolc_version = "0.8.28"\nevm_version = "cancun"\noptimizer = true\noptimizer_runs = 200\n${skipLine}`;
}

async function writeFixture(root, name, fixture) {
  const projectRoot = path.join(root, name);
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'src', `${fixture.contractName}.sol`), fixture.source);
  if (fixture.vyperFile && fixture.vyperSource) {
    const vyperPath = path.join(projectRoot, fixture.vyperFile);
    await fs.mkdir(path.dirname(vyperPath), { recursive: true });
    await fs.writeFile(vyperPath, fixture.vyperSource);
  }
  await fs.writeFile(path.join(projectRoot, 'foundry.toml'), foundryConfigForFixture(fixture));
  await fs.writeFile(path.join(projectRoot, 'medusa.json'), `${JSON.stringify(buildMedusaSmokeConfigV1({ contractName: fixture.contractName, targetFunctions: fixture.targetFunctions }), null, 2)}\n`);
  return projectRoot;
}

function rawPresent(result) {
  return result?.rawOutput
    && typeof result.rawOutput.stdout === 'string'
    && typeof result.rawOutput.stderr === 'string'
    && Number.isInteger(result.rawOutput.exitCode);
}

function secretAbsent(result, values) {
  const serialized = JSON.stringify(result);
  return values.filter(Boolean).every((value) => !serialized.includes(value));
}

export async function runMedusaEndToEndSmokeV1({
  rpcUrl,
  rpcBlock,
  rpcBlockHash = null,
  rpcProfile = null,
  evidenceDir,
  sourceCommit = SOURCE_COMMIT
}) {
  if (!rpcUrl || !Number.isSafeInteger(rpcBlock)) throw new Error('Medusa smoke requires the active normalized Phase-6 RPC runtime');
  if (!evidenceDir) throw new Error('Medusa smoke evidenceDir is required');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v7-medusa-e2e-smoke-'));
  await fs.mkdir(evidenceDir, { recursive: true });
  const results = {};

  try {
    for (const [name, fixture] of Object.entries(FIXTURES)) {
      const projectRoot = await writeFixture(root, name, fixture);
      const result = await runMedusaAnalysis({
        projectRoot,
        version: '1.5.1',
        sourceCommit,
        rawArtifactRef: `github-actions://curveyield3/Contract-Automation/qualification/medusa-smoke/${name}/raw.txt`,
        rpcUrl,
        rpcBlock,
        rpcBlockHash,
        rpcProfile
      });
      results[name] = result;
      await fs.writeFile(path.join(evidenceDir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }

    const passProperty = results.pass?.campaign?.properties?.find((property) => property.status === 'passed');
    const mixedLanguageProperty = results.mixedLanguagePass?.campaign?.properties?.find((property) => property.status === 'passed');
    const failedProperty = results.falsification?.campaign?.properties?.find((property) => property.status === 'failed');
    const checks = {
      medusaSmokePass: results.pass?.status === 'completed' && Boolean(passProperty),
      medusaSmokeFalsification: results.falsification?.failureKind === 'PROPERTY_FALSIFICATION'
        && Array.isArray(failedProperty?.counterexample)
        && failedProperty.counterexample.length > 0,
      medusaSmokeNoTests: results.noTests?.failureKind === 'NO_TESTS_DISCOVERED'
        && results.noTests?.campaign?.status === 'no_tests',
      medusaSmokeMixedLanguagePass: results.mixedLanguagePass?.status === 'completed' && Boolean(mixedLanguageProperty),
      rawEvidencePreserved: Object.values(results).every(rawPresent),
      rpcSecretNotExposed: Object.values(results).every((result) => secretAbsent(result, [rpcUrl]))
    };
    const summary = {
      schemaVersion: 'curveyield-v7-medusa-e2e-smoke-v1',
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      rpc: { profile: rpcProfile, blockNumber: rpcBlock, blockHash: rpcBlockHash, urlExposed: false },
      checks,
      outcomes: {
        pass: { status: results.pass?.status ?? null, failureKind: results.pass?.failureKind ?? null },
        falsification: { status: results.falsification?.status ?? null, failureKind: results.falsification?.failureKind ?? null },
        noTests: { status: results.noTests?.status ?? null, failureKind: results.noTests?.failureKind ?? null },
        mixedLanguagePass: { status: results.mixedLanguagePass?.status ?? null, failureKind: results.mixedLanguagePass?.failureKind ?? null }
      }
    };
    await fs.writeFile(path.join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
