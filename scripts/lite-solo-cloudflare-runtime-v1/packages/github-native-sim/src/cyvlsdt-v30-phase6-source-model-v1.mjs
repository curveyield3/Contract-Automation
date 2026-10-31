import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const BPS = 10_000n;
const BASE_PRODUCTION_BPS = 3_000n;
const MAX_TOTAL_BOOST = 30_000n;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function requireTrue(value, message) {
  if (!value) throw new Error(message);
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function randBigInt(next, maxExclusive) {
  requireTrue(maxExclusive > 0n, 'maxExclusive must be positive');
  const high = BigInt(next());
  const low = BigInt(next());
  return ((high << 32n) | low) % maxExclusive;
}

async function read(projectRoot, relative) {
  return fs.readFile(path.join(projectRoot, relative), 'utf8');
}

async function digest(projectRoot, relative) {
  return sha256(await read(projectRoot, relative));
}

function lineNumber(source, needle) {
  const index = source.indexOf(needle);
  if (index < 0) return null;
  return source.slice(0, index).split('\n').length;
}

function modelP2Candidate001(next, iterations) {
  let cases = 0;
  for (let i = 0; i < iterations; i += 1) {
    const realized = 1n + randBigInt(next, 10n ** 30n);
    const contribution = 1n + randBigInt(next, 10n ** 26n);
    const quote = randBigInt(next, 10n ** 28n);
    const supply = 1n + randBigInt(next, 10n ** 28n);

    const poolBefore = realized + quote;
    const economicAfter = realized + contribution + quote;
    const contributedAssets = economicAfter - poolBefore;
    requireTrue(contributedAssets === contribution, 'P2-CAND-001 static quote cancellation failed');

    const sharesFromObservedDelta = contributedAssets * supply / poolBefore;
    const sharesFromContribution = contribution * supply / poolBefore;
    requireTrue(sharesFromObservedDelta === sharesFromContribution, 'P2-CAND-001 share equivalence failed');
    cases += 1;
  }
  return {
    id: 'P2-CAND-001',
    status: 'NARROWING_REPRODUCED',
    iterations: cases,
    property: 'When Q1 == Q0 inside one atomic standard deposit, pending-reward quote value cancels exactly from contributedAssets.',
    counterexamples: 0,
    limitation: 'Does not resolve privileged/state-dependent adapters that can change quote state between the two samples.'
  };
}

function modelP2Candidate002(next, iterations) {
  let cases = 0;
  let fullEpochCaptures = 0;
  let recoveryBlocked = 0;
  for (let i = 0; i < iterations; i += 1) {
    const epoch = 259_200n + randBigInt(next, 28_771_201n); // 3 days through 48 weeks inclusive-ish
    const funded = 1n + randBigInt(next, 10n ** 28n);
    const rate = funded / epoch;
    if (rate === 0n) continue;
    const firstStakeDelay = 1n + randBigInt(next, epoch * 2n);
    const firstClaimDelay = 1n + randBigInt(next, epoch + 1n);
    const firstCheckpoint = firstStakeDelay + firstClaimDelay;
    const lastUpdate = firstCheckpoint < epoch ? firstCheckpoint : epoch;
    const durationAttributedAfterStake = lastUpdate; // zero-supply checkpoints do not advance last_update
    const captured = durationAttributedAfterStake * rate;
    requireTrue(captured <= funded, 'P2-CAND-002 modeled capture exceeds funded rewards');
    if (firstStakeDelay >= epoch) {
      requireTrue(captured === epoch * rate, 'P2-CAND-002 expected full rate-funded epoch capture after late first stake');
      fullEpochCaptures += 1;
      recoveryBlocked += 1;
    }
    cases += 1;
  }
  return {
    id: 'P2-CAND-002',
    status: 'ADVERSARIAL_MODEL_REPRODUCED',
    iterations: cases,
    fullEpochCaptureCases: fullEpochCaptures,
    endedZeroSupplyRecoveryBlockedCases: recoveryBlocked,
    propertyViolation: 'Reward time elapsed at working_supply == 0 is later attributed when the first nonzero working balance checkpoints because last_update remained stale.',
    sourceBoundExpectation: 'recover_remaining also remains blocked after period_finish while last_update < period_finish.'
  };
}

function workingBps(totalBoost) {
  return BASE_PRODUCTION_BPS + (BPS - BASE_PRODUCTION_BPS) * totalBoost / MAX_TOTAL_BOOST;
}

function modelP4Candidate002(next, iterations) {
  const inheritedBoostBefore = 10_000n / 2n;
  const inheritedBoostAfter = 0n;
  const staleBps = workingBps(inheritedBoostBefore);
  const correctBps = workingBps(inheritedBoostAfter);
  requireTrue(staleBps === 4_166n, `unexpected stale working bps ${staleBps}`);
  requireTrue(correctBps === 3_000n, `unexpected correct working bps ${correctBps}`);

  let cases = 0;
  let aggregateExcess = 0n;
  for (let i = 0; i < iterations; i += 1) {
    const balance = 1n + randBigInt(next, 10n ** 28n);
    const staleWeight = balance * staleBps / BPS;
    const correctWeight = balance * correctBps / BPS;
    requireTrue(staleWeight >= correctWeight, 'P4-CAND-002 stale weight must not be lower after full DAO boost removal');
    aggregateExcess += staleWeight - correctWeight;
    cases += 1;
  }

  return {
    id: 'P4-CAND-002',
    status: 'ADVERSARIAL_MODEL_REPRODUCED',
    iterations: cases,
    staleWorkingBps: Number(staleBps),
    correctWorkingBps: Number(correctBps),
    relativeOverstatementBpsOfCorrectWeight: Number((staleBps - correctBps) * 10_000n / correctBps),
    aggregateModeledExcessWeight: aggregateExcess.toString(),
    propertyViolation: 'A delegator can retain inherited DAO-boost working weight after the delegatee boost is reduced when only the delegatee is refreshed.'
  };
}

function modelP4Candidate001(next, iterations) {
  let cases = 0;
  let transferredPendingRewards = 0n;
  for (let i = 0; i < iterations; i += 1) {
    const realized = 1n + randBigInt(next, 10n ** 30n);
    const pendingRewards = 1n + randBigInt(next, 10n ** 26n);
    const nextDeposit = 1n + randBigInt(next, 10n ** 26n);

    // Final shareholder exits against realized balance after best-effort harvest failure.
    const valueLeftAtZeroSupply = pendingRewards;
    requireTrue(valueLeftAtZeroSupply > 0n, 'P4-CAND-001 residual reward must remain positive in modeled failed-harvest case');

    // At restart, zero supply mints the new depositor the complete new share supply.
    const restartSupply = nextDeposit;
    const restartedEconomicValueAfterLaterHarvest = nextDeposit + valueLeftAtZeroSupply;
    const laterDepositorClaim = restartedEconomicValueAfterLaterHarvest * restartSupply / restartSupply;
    const windfall = laterDepositorClaim - nextDeposit;
    requireTrue(windfall === pendingRewards, 'P4-CAND-001 residual-reward windfall attribution mismatch');
    requireTrue(realized > 0n, 'realized balance sanity');
    transferredPendingRewards += windfall;
    cases += 1;
  }
  return {
    id: 'P4-CAND-001',
    status: 'ADVERSARIAL_MODEL_REPRODUCED',
    iterations: cases,
    aggregateModeledTransferredPendingRewards: transferredPendingRewards.toString(),
    propertyViolation: 'If final-exit harvest fails and supply reaches zero while ordinary rewards remain, the next first depositor owns that prior-cycle reward value after harvest.'
  };
}

export async function inspectCyvlSdtV30MedusaHarness(projectRoot) {
  const inventory = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'artifacts-v20', 'cache-v20'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) inventory.push(path.relative(projectRoot, absolute).split(path.sep).join('/'));
    }
  }
  await walk(projectRoot);
  const medusaConfigs = inventory.filter((file) => /(^|\/)medusa[^/]*\.json$/i.test(file));
  const foundryConfigs = inventory.filter((file) => /(^|\/)foundry\.toml$/i.test(file));
  const solidityTests = inventory.filter((file) => /\.t\.sol$/i.test(file));
  const propertySources = [];
  for (const file of inventory.filter((item) => item.endsWith('.sol'))) {
    const source = await read(projectRoot, file);
    if (/\b(property_|echidna_|invariant_)[A-Za-z0-9_]*\s*\(/.test(source)) propertySources.push(file);
  }
  return {
    fileCount: inventory.length,
    medusaConfigs,
    foundryConfigs,
    solidityTests,
    propertySources,
    medusaPropertyHarnessAvailable: medusaConfigs.length > 0 || propertySources.length > 0,
    forgeFuzzHarnessAvailable: foundryConfigs.length > 0 && solidityTests.length > 0
  };
}

export async function runCyvlSdtV30SourceModelFuzz({ projectRoot, sourceCommit, iterations = 20_000 }) {
  const files = {
    governanceStaking: 'contracts/CurveYieldGovernanceStaking.vy',
    vault: 'contracts/CurveYieldVault.sol',
    strategy: 'contracts/CurveYieldRevenueStrategyV20.sol',
    locker: 'contracts/CurveYieldVlSDTLocker.sol',
    revenueStaking: 'contracts/CurveYieldVlSDTRevenueStaking.sol',
    revenueStakingInterface: 'contracts/interfaces/ICurveYield.sol',
    deploymentEngine: 'deployment-v20/deploy-configure-v20.js',
    postDeploy: 'deployment-v27/post-deploy-configure-cyvlsdt-v27-v1.js'
  };

  const sources = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, relative]) => [key, await read(projectRoot, relative)])));
  const fileDigests = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, relative]) => [key, { path: relative, sha256: await digest(projectRoot, relative) }])));

  // Exact-source structural predicates for the carried candidates.
  requireTrue(sources.governanceStaking.includes('if duration != 0 and working_supply != 0:'), 'P2-CAND-002 gating predicate missing');
  const rewardGatePos = sources.governanceStaking.indexOf('if duration != 0 and working_supply != 0:');
  const rewardLastUpdatePos = sources.governanceStaking.indexOf('self.reward_data[token].last_update = last_update', rewardGatePos);
  requireTrue(rewardLastUpdatePos > rewardGatePos, 'P2-CAND-002 last_update write is not inside/after the zero-supply gate');
  requireTrue(sources.governanceStaking.includes('assert self.reward_data[_reward_token].last_update >= period_finish'), 'P2-CAND-002 recover_remaining terminal guard missing');

  const daoBoostStart = sources.governanceStaking.indexOf('def set_dao_boost(_user: address, _value: uint256):');
  requireTrue(daoBoostStart >= 0, 'P4-CAND-002 set_dao_boost missing');
  const daoBoostEnd = sources.governanceStaking.indexOf('\n\n@external', daoBoostStart + 10);
  const daoBoostBody = sources.governanceStaking.slice(daoBoostStart, daoBoostEnd > daoBoostStart ? daoBoostEnd : undefined);
  requireTrue(daoBoostBody.includes('self._update_liquidity_limit(_user, self.balanceOf[_user])'), 'P4-CAND-002 delegatee refresh missing');
  requireTrue(!/delegator|delegatees|for\s+.*delegate/i.test(daoBoostBody), 'P4-CAND-002 unexpected delegator fanout found');
  requireTrue(sources.governanceStaking.includes('return self.dao_boost[delegatee] / 2'), 'P4-CAND-002 inherited half-DAO boost rule missing');

  requireTrue(sources.strategy.includes('try this.harvestBeforeWithdraw() {} catch {}'), 'P4-CAND-001 swallowed pre-withdraw harvest path missing');
  requireTrue(sources.vault.includes('uint256 requestedAssets = Math.mulDiv(balance(), shares, totalSupply());'), 'P4-CAND-001 final instant exit no longer prices realized balance');
  requireTrue(sources.vault.includes('uint256 pool = economicBalance();'), 'P2-CAND-001 standard deposit no longer samples economicBalance');

  requireTrue(sources.postDeploy.includes('deployAndConfigure({'), 'P3-CAND-001 active post-deploy path no longer reaches deployment-v20 engine');
  const staleReadPos = sources.deploymentEngine.indexOf('revenueStaking.recipientOperator(');
  const staleWritePos = sources.deploymentEngine.indexOf('"setRecipientOperator"');
  requireTrue(staleReadPos >= 0 && staleWritePos > staleReadPos, 'P3-CAND-001 stale recipient-operator calls missing from active engine');
  requireTrue(!sources.revenueStaking.includes('function recipientOperator('), 'P3-CAND-001 exact v30 RevenueStaking unexpectedly exposes recipientOperator');
  requireTrue(!sources.revenueStaking.includes('function setRecipientOperator('), 'P3-CAND-001 exact v30 RevenueStaking unexpectedly exposes setRecipientOperator');
  const firstWhitelistWrite = sources.deploymentEngine.indexOf('configure:governanceToken.transferWhitelist:');
  requireTrue(firstWhitelistWrite >= 0 && firstWhitelistWrite < staleReadPos, 'P3-CAND-001 no pre-failure whitelist write was located');

  requireTrue(sources.locker.includes('approvedSnapshotVoteHash[hash] = true;'), 'P2-CAND-003 exact-hash approval write missing');
  requireTrue(sources.locker.includes('return approvedSnapshotVoteHash[hash] ? ERC1271_MAGICVALUE : ERC1271_INVALID;'), 'P2-CAND-003 exact-hash ERC1271 read missing');
  requireTrue(/function isValidSignature\(bytes32 hash, bytes calldata\)/.test(sources.locker), 'P2-CAND-003 ERC1271 signature shape changed');

  const next = xorshift32(0xC7A13006);
  const results = [
    modelP2Candidate001(next, iterations),
    modelP2Candidate002(next, iterations),
    modelP4Candidate001(next, iterations),
    modelP4Candidate002(next, iterations)
  ];

  return {
    schemaVersion: 'audit-v7-cyvlsdt-v30-phase6-source-model-fuzz-v1',
    sourceCommit,
    engine: 'trusted-node-source-model-v1',
    deterministicSeed: '0xC7A13006',
    iterationsPerModeledCandidate: iterations,
    totalModelIterations: results.reduce((sum, item) => sum + item.iterations, 0),
    exactSourcePredicates: {
      P2_CAND_002_zeroSupplyGateLine: lineNumber(sources.governanceStaking, 'if duration != 0 and working_supply != 0:'),
      P2_CAND_002_lastUpdateLine: lineNumber(sources.governanceStaking, 'self.reward_data[token].last_update = last_update'),
      P4_CAND_002_setDaoBoostLine: lineNumber(sources.governanceStaking, 'def set_dao_boost(_user: address, _value: uint256):'),
      P4_CAND_001_swallowedHarvestLine: lineNumber(sources.strategy, 'try this.harvestBeforeWithdraw() {} catch {}'),
      P4_CAND_001_realizedExitPricingLine: lineNumber(sources.vault, 'uint256 requestedAssets = Math.mulDiv(balance(), shares, totalSupply());'),
      P2_CAND_001_economicDepositPricingLine: lineNumber(sources.vault, 'uint256 pool = economicBalance();'),
      P3_CAND_001_staleReadLine: lineNumber(sources.deploymentEngine, 'revenueStaking.recipientOperator('),
      P3_CAND_001_staleWriteLine: lineNumber(sources.deploymentEngine, '"setRecipientOperator"'),
      P2_CAND_003_erc1271Line: lineNumber(sources.locker, 'function isValidSignature(bytes32 hash, bytes calldata)')
    },
    candidateResults: [
      ...results,
      {
        id: 'P3-CAND-001',
        status: 'EXACT_SOURCE_REGRESSION_REPRODUCED',
        staleReadPresent: true,
        staleWritePresent: true,
        exactV30MethodsPresent: false,
        partialWriteBoundaryPresent: true,
        propertyViolation: 'The active configuration path can commit governance-token whitelist writes before reaching an ABI method removed from exact v30 RevenueStaking.'
      },
      {
        id: 'P2-CAND-003',
        status: 'LOCAL_PROPERTY_CONFIRMED_EXTERNAL_SEMANTICS_UNRESOLVED',
        exactHashAllowlist: true,
        signatureBytesIgnored: true,
        persistenceObserved: true,
        limitation: 'Snapshot Hub replay/update/submission semantics remain external and are Phase-7/8 obligations.'
      }
    ],
    fileDigests
  };
}
