import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve('.');
const auditControllerRoot = process.env.AUDIT_CONTROLLER_ROOT ? path.resolve(process.env.AUDIT_CONTROLLER_ROOT) : null;
function resolveCurrentLiteSkillRoot() {
  if (!auditControllerRoot) return null;
  const authorityFolder = path.join(auditControllerRoot, 'Audit Skill - Current Authority');
  if (!fs.existsSync(authorityFolder)) return null;
  const candidates = fs.readdirSync(authorityFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(authorityFolder, entry.name, 'SKILL.md')))
    .map((entry) => path.join(authorityFolder, entry.name))
    .sort();
  assert.equal(candidates.length, 1, 'stable authority folder must contain exactly one unpacked package with root SKILL.md');
  return candidates[0];
}
const skillRoot = resolveCurrentLiteSkillRoot();
const authorityTest = skillRoot ? test : test.skip;
const script = path.join(repoRoot, 'packages/github-native-sim/src/lite-phase0-skill-outputs-v1.mjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

authorityTest('Lite Phase-0 automation emits the exact skill-required canonical outputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-p0-skill-outputs-'));
  const campaign = path.join(root, 'campaigns/Test Lite Audit');
  const sourceSha = '1'.repeat(64);
  writeJson(path.join(campaign, 'controller/CAMPAIGN_STATE_v1.json'), {
    schemaVersion: 'audit-v7-campaign-state-v1',
    campaignId: 'test-lite-r1',
    campaignGenerationId: 'test-lite-g1',
    source: {
      sha256: sourceSha,
      archiveRepository: 'curveyield3/Audit-Controller',
      archiveCommit: '2'.repeat(40),
      archivePath: 'campaigns/Test Lite Audit/source/source.zip'
    },
    phase: { id: 'phase-0', revision: 'v1' }
  });
  writeJson(path.join(campaign, 'evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json'), {
    campaignId: 'test-lite-r1',
    status: 'PASS',
    source: {
      repository: 'curveyield3/Audit-Controller',
      commit: '2'.repeat(40),
      archivePath: 'campaigns/Test Lite Audit/source/source.zip',
      archiveSha256Observed: sourceSha
    },
    configurationDetection: {
      compilerVersion: '0.8.28',
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
      evmVersion: null
    },
    build: {
      system: 'hardhat',
      status: 'PASS',
      compilerInputSha256: '3'.repeat(64)
    }
  });
  writeJson(path.join(campaign, 'evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json'), {
    sourceFiles: [{
      sourceId: 'SRC-001',
      path: 'contracts/Test.sol',
      language: 'SOLIDITY',
      sha256: '4'.repeat(64),
      scopeStatus: 'IN_SCOPE',
      basis: 'ADMITTED_SOURCE'
    }],
    compilerArtifacts: [],
    contracts: [],
    functions: [],
    storageLayout: [],
    inheritanceGraph: [],
    callGraph: [],
    privilegeCandidates: [],
    externalInterfaces: [],
    valueFlowCandidates: [],
    eventsAndErrors: [],
    sourceAnchors: [],
    securitySurfaces: [],
    protocolTopology: { upgradeabilityEdges: [], dependencyEdges: [], crossChainEdges: [], offchainAutomationEdges: [], topologyLimitations: [] },
    staticRecon: { slither: { status: 'completed', version: '0.11.6', candidateCount: 0, candidateIndex: [], limitation: null } },
    limitations: []
  });
  writeJson(path.join(campaign, 'evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json'), {
    deploymentAndConfiguration: { discoveredAddresses: [], discoveredChainIds: [], proxyAndUpgradeabilityMentions: [], roleMentions: [], oracleMentions: [], configFiles: [] },
    testingAndToolingReadiness: { detectedTooling: { hardhat: true, foundry: false, medusa: false, slitherVersion: '0.11.6', compilerVersion: '0.8.28' }, harnessFiles: [], configFiles: [], scriptFiles: [] }
  });
  writeJson(path.join(campaign, 'evidence/dependencies/SBOM_v1.json'), { dependencyFiles: [] });
  writeJson(path.join(campaign, 'evidence/static-analysis/SLITHER_v1.json'), { status: 'completed', version: '0.11.6', findingCount: 0 });

  let result = spawnSync(process.execPath, [script, '--campaign-root', campaign, '--skill-root', skillRoot, '--stage', 'core'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const requiredCorePaths = [
    'shared/source-intelligence/SOURCE_INTELLIGENCE_TEMPLATE.json',
    'shared/source-intelligence/RUNTIME_DEPLOYMENT_OVERLAY_TEMPLATE.json',
    'shared/source-intelligence/ASSURANCE_READINESS_OVERLAY_TEMPLATE.json',
    'shared/controller/SECURITY_TRACEABILITY_GRAPH.json',
    'shared/controller/CARRIED_FORWARD_OBLIGATION_LEDGER.json',
    'evidence/source-intelligence/SOURCE_INTELLIGENCE_v1.json',
    'evidence/source-intelligence/runtime-deployment-overlay_v1.json',
    'evidence/source-intelligence/assurance-readiness-overlay_v1.json'
  ];
  for (const relative of requiredCorePaths) {
    const file = path.join(campaign, relative);
    assert.ok(fs.existsSync(file), relative);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /__FILL_REQUIRED__/);
  }

  const core = JSON.parse(fs.readFileSync(path.join(campaign, 'shared/source-intelligence/SOURCE_INTELLIGENCE_TEMPLATE.json')));
  assert.equal(core.completion.status, 'COMPLETE');
  assert.equal(core.completion.noFillSentinelsRemaining, true);
  assert.equal(core.identity.sourceDigestSha256, sourceSha);

  const runtime = JSON.parse(fs.readFileSync(path.join(campaign, 'shared/source-intelligence/RUNTIME_DEPLOYMENT_OVERLAY_TEMPLATE.json')));
  assert.equal(runtime.deploymentIdentity.status, 'DISCOVERED_UNVERIFIED');
  assert.equal(runtime.gasAcceptance.status, 'PENDING_PHASE7_ACCEPTANCE');

  const readiness = JSON.parse(fs.readFileSync(path.join(campaign, 'shared/source-intelligence/ASSURANCE_READINESS_OVERLAY_TEMPLATE.json')));
  assert.equal(readiness.toolchainReadiness.phase1StructuralStatus, 'DISCOVERED');
  assert.equal(readiness.adequacyAssessment.status, 'PENDING_LITE_PHASE6_7_ASSESSMENT');

  result = spawnSync(process.execPath, [script, '--campaign-root', campaign, '--skill-root', skillRoot, '--stage', 'bundle', '--accepted-commit', '5'.repeat(40)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const bundlePath = path.join(campaign, 'shared/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_TEMPLATE.json');
  assert.ok(fs.existsSync(bundlePath));
  assert.doesNotMatch(fs.readFileSync(bundlePath, 'utf8'), /__FILL_REQUIRED__/);
  const bundle = JSON.parse(fs.readFileSync(bundlePath));
  assert.equal(bundle.core.acceptedCommitSha, '5'.repeat(40));
  assert.match(bundle.core.acceptedSha256, /^[0-9a-f]{64}$/);
  assert.equal(bundle.completion.allAcceptedDigestsVerified, true);
});
