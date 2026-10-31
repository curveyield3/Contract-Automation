#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startAnvilEngine } from '../../../runner/src/anvil-engine.mjs';

const FACTORY = '0xc29b8D591d6a3f109Ca7ba384F2e00162866D37B';
const ROUTER = '0x01F9894f92ea9224fECc8C35482E20a05De13582';
const SAFE = '0x47623C62f281807D615eeb4A2CEee9d97F9D3C49';
const VB_USDC = '0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36';
const KAT = '0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d';
const USD_PRICE_FEED = '0x64518f821Cd07A9471711Eba5D8fEF9c75063B01';
const KAT_PRICE_SOURCE = '0xc62782910529ee50eFDa9a0273B20d8bD1C1e4b2';
const MORPHO_SUPPLY_FUSE = '0x1f657229ec2D261be7dCD63ca82abed334d1f28b';
const MORPHO_BALANCE_FUSE = '0x70Ed27aEE2dD509bC6BB067d8e2C61A1FE96eCa4';
const ERC20_BALANCE_FUSE = '0xb81C00eb71a3D629E6f7Ba66a26218c418D438b8';
const MERKL_CLAIM_FUSE = '0xF4278e62a6B5A45E378e6692C7Aa9C7291E7ce36';

const AVKAT_MARKET = '0xbd48214a2f12e951da20ad0b8fd83b611c693b5bbaa280b68ba4075678f2a138';
const SIUSD_MARKET = '0xf7fc5cc82200ddf8f23188ddbd6727eda2c8bc41863e91fb767bbc6e4f71890e';
const WEETH_MARKET = '0x76e311d4b0e2e6ae88ad9bab18063452a6d39837d7104c430ff62457b91cb2cb';

const EXPECTED_ROUTE = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d0001f4203a662b0bd271a6ed5a60edfbd04bfce608fd36';
const DEV_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[++i];
  }
  return out;
}

function lower(x) {
  return String(x).toLowerCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(command, args, { cwd, env = {} } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function safeExec({ safe, router, owner, data, ethers }) {
  const ownerInt = BigInt(owner);
  const signature = ethers.solidityPacked(
    ['uint256', 'uint256', 'uint8'],
    [ownerInt, 0n, 1]
  );
  const tx = await safe.execTransaction(
    await router.getAddress(),
    0n,
    data,
    0,
    0n,
    0n,
    0n,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    signature,
    { gasLimit: 5_000_000n }
  );
  const receipt = await tx.wait();
  assert(receipt.status === 1, 'Safe route configuration transaction failed');
}

async function ensureForkRoute({ provider, ethers }) {
  const routerAbi = [
    'function routeFor(address,address) view returns (bytes)',
    'function routeTwapGuard(address,address) view returns (uint32,uint16,bool)',
    'function setRoute(address,address,bytes)',
    'function setRouteFeeBps(address,address,uint16)',
    'function setRouteTwapGuard(address,address,uint32,uint16)'
  ];
  const safeAbi = [
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
    'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)'
  ];

  const routerRead = new ethers.Contract(ROUTER, routerAbi, provider);
  const current = await routerRead.routeFor(KAT, VB_USDC);
  if (current !== '0x') {
    assert(lower(current) === lower(EXPECTED_ROUTE), 'Existing fork route differs from expected direct KAT/vbUSDC path');
    return { installedBySimulation: false, route: current };
  }

  const safeRead = new ethers.Contract(SAFE, safeAbi, provider);
  const owners = await safeRead.getOwners();
  const threshold = await safeRead.getThreshold();
  assert(threshold === 1n, 'CurveYield Safe threshold is not 1 on fork');
  assert(owners.length > 0, 'CurveYield Safe has no owners');

  const owner = owners[0];
  await provider.send('anvil_impersonateAccount', [owner]);
  await provider.send('anvil_setBalance', [owner, '0x56BC75E2D63100000']);

  const signer = await provider.getSigner(owner);
  const safe = new ethers.Contract(SAFE, safeAbi, signer);
  const router = new ethers.Contract(ROUTER, routerAbi, signer);

  await safeExec({
    safe,
    router,
    owner,
    data: router.interface.encodeFunctionData('setRoute', [KAT, VB_USDC, EXPECTED_ROUTE]),
    ethers,
  });
  await safeExec({
    safe,
    router,
    owner,
    data: router.interface.encodeFunctionData('setRouteFeeBps', [KAT, VB_USDC, 0]),
    ethers,
  });
  await safeExec({
    safe,
    router,
    owner,
    data: router.interface.encodeFunctionData('setRouteTwapGuard', [KAT, VB_USDC, 900, 200]),
    ethers,
  });

  const installed = await routerRead.routeFor(KAT, VB_USDC);
  const guard = await routerRead.routeTwapGuard(KAT, VB_USDC);
  assert(lower(installed) === lower(EXPECTED_ROUTE), 'Fork route installation did not persist');
  assert(Number(guard[0]) === 900 && Number(guard[1]) === 200 && guard[2] === true, 'Fork route TWAP guard mismatch');

  return { installedBySimulation: true, owner, route: installed, guard: [Number(guard[0]), Number(guard[1]), guard[2]] };
}

async function writeEphemeralFoundryConfig(root) {
  const config = [
    '[profile.default]',
    'solc = "0.8.30"',
    'src = "cyvbUSDC/contracts"',
    'script = "cyvbUSDC/script"',
    'test = "cyvbUSDC/test"',
    'out = "out"',
    'libs = ["lib"]',
    'optimizer = true',
    'optimizer_runs = 10000000',
    'evm_version = "cancun"',
    ''
  ].join('\n');
  await fs.writeFile(path.join(root, 'foundry.toml'), config);
}

async function main() {
  const args = parseArgs(process.argv);
  const smartRoot = path.resolve(args['smart-contracts-root'] ?? '.smart-contracts');
  const outputRoot = path.resolve(args.output ?? '.cyvbusdc-deployment-simulation-output');
  const forkUrl = args['fork-url'];
  assert(forkUrl, '--fork-url is required');

  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });

  const ethers = await import('ethers');
  const engine = await startAnvilEngine({
    artifacts: [],
    workflow: { steps: [] },
    chainId: 747474,
    forkUrl,
    evmVersion: 'cancun',
    cwd: process.cwd(),
    quiet: true,
  });

  const summary = {
    schemaVersion: 'curveyield-cyvbusdc-deployment-simulation-v1',
    status: 'RUNNING',
    fork: { engine: engine.engine, chainId: 747474, upstreamRpcExposed: false },
    routePrerequisite: null,
    deployment: null,
    verification: {},
    failures: [],
  };

  try {
    const provider = engine.provider;
    const chainId = await provider.send('eth_chainId', []);
    assert(BigInt(chainId) === 747474n, 'Anvil fork chain id mismatch');

    const factoryCode = await provider.getCode(FACTORY);
    assert(factoryCode !== '0x', 'Official IPOR factory missing on fork');

    summary.routePrerequisite = await ensureForkRoute({ provider, ethers });

    await writeEphemeralFoundryConfig(smartRoot);

    const devWallet = new ethers.Wallet(DEV_PRIVATE_KEY);
    const account0 = engine.aliases.account0;
    assert(lower(devWallet.address) === lower(account0), 'Anvil account0 does not match canonical dev private key');

    const beforeBlock = Number(await provider.getBlockNumber());

    const deployment = await run(
      'forge',
      [
        'script',
        'cyvbUSDC/script/DeployCyvbUSDC_v3.s.sol:DeployCyvbUSDC_v3',
        '--rpc-url',
        engine.url,
        '--broadcast',
        '--skip-simulation',
        '--private-key',
        DEV_PRIVATE_KEY,
        '-vvvv'
      ],
      {
        cwd: smartRoot,
        env: {
          PRIVATE_KEY: DEV_PRIVATE_KEY,
          KEEPER: account0,
          FINAL_OWNER: account0,
        },
      }
    );

    summary.deployment = {
      exitCode: deployment.code,
      stdoutTail: deployment.stdout.slice(-12000),
      stderrTail: deployment.stderr.slice(-12000),
    };
    assert(deployment.code === 0, 'DeployCyvbUSDC_v3.s.sol reverted or failed');

    const afterBlock = Number(await provider.getBlockNumber());

    const factoryIface = new ethers.Interface([
      'event FusionInstanceCreated(uint256 index,uint256 version,string assetName,string assetSymbol,uint8 assetDecimals,address underlyingToken,string underlyingTokenSymbol,uint8 underlyingTokenDecimals,address initialOwner,address plasmaVault,address plasmaVaultBase,address feeManager)'
    ]);
    const eventTopic = factoryIface.getEvent('FusionInstanceCreated').topicHash;
    const logs = await provider.getLogs({
      address: FACTORY,
      fromBlock: beforeBlock + 1,
      toBlock: afterBlock,
      topics: [eventTopic],
    });
    const created = logs
      .map((log) => factoryIface.parseLog(log))
      .find((row) => row?.args?.assetSymbol === 'cyvbUSDC');
    assert(created, 'cyvbUSDC FusionInstanceCreated event not found');

    const plasmaVault = created.args.plasmaVault;
    const feeManagerAddress = created.args.feeManager;

    const vaultAbi = [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function asset() view returns (address)',
      'function getAccessManagerAddress() view returns (address)',
      'function getRewardsClaimManagerAddress() view returns (address)',
      'function getPriceOracleMiddleware() view returns (address)',
      'function getFuses() view returns (address[])',
      'function getInstantWithdrawalFuses() view returns (address[])',
      'function getMarketSubstrates(uint256) view returns (bytes32[])',
      'function getManagementFeeData() view returns ((address feeAccount,uint16 feeInPercentage,uint32 lastUpdateTimestamp))',
      'function getPerformanceFeeData() view returns ((address feeAccount,uint16 feeInPercentage))'
    ];
    const vault = new ethers.Contract(plasmaVault, vaultAbi, provider);

    const [
      name,
      symbol,
      asset,
      accessManager,
      rewardsManager,
      priceManager,
      fuses,
      instant,
      market41,
      market7,
      management,
      performance,
    ] = await Promise.all([
      vault.name(),
      vault.symbol(),
      vault.asset(),
      vault.getAccessManagerAddress(),
      vault.getRewardsClaimManagerAddress(),
      vault.getPriceOracleMiddleware(),
      vault.getFuses(),
      vault.getInstantWithdrawalFuses(),
      vault.getMarketSubstrates(41),
      vault.getMarketSubstrates(7),
      vault.getManagementFeeData(),
      vault.getPerformanceFeeData(),
    ]);

    assert(name === 'CurveYield USDC', 'vault name mismatch');
    assert(symbol === 'cyvbUSDC', 'vault symbol mismatch');
    assert(lower(asset) === lower(VB_USDC), 'vault asset mismatch');
    assert(fuses.map(lower).includes(lower(MORPHO_SUPPLY_FUSE)), 'Morpho supply fuse missing');
    assert(instant.length === 3 && instant.every((x) => lower(x) === lower(MORPHO_SUPPLY_FUSE)), 'instant withdrawal fuse configuration mismatch');

    const expectedMarkets = [AVKAT_MARKET, SIUSD_MARKET, WEETH_MARKET].map(lower);
    assert(market41.length === 3 && market41.map(lower).every((x) => expectedMarkets.includes(x)), 'market 41 substrates mismatch');
    assert(market7.length === 1 && lower(market7[0]) === lower(ethers.zeroPadValue(KAT, 32)), 'market 7 residual KAT substrate mismatch');

    assert(Number(management.feeInPercentage) === 80, 'management fee total mismatch');
    assert(Number(performance.feeInPercentage) === 1000, 'performance fee total mismatch');

    const feeManager = new ethers.Contract(feeManagerAddress, [
      'function getTotalManagementFee() view returns (uint256)',
      'function getTotalPerformanceFee() view returns (uint256)',
      'function getManagementFeeRecipients() view returns ((address recipient,uint256 feeValue)[])',
      'function getPerformanceFeeRecipients() view returns ((address recipient,uint256 feeValue)[])'
    ], provider);
    const [totalManagement, totalPerformance, managementRecipients, performanceRecipients] = await Promise.all([
      feeManager.getTotalManagementFee(),
      feeManager.getTotalPerformanceFee(),
      feeManager.getManagementFeeRecipients(),
      feeManager.getPerformanceFeeRecipients(),
    ]);
    assert(totalManagement === 80n, 'FeeManager management total mismatch');
    assert(totalPerformance === 1000n, 'FeeManager performance total mismatch');
    assert(managementRecipients.length === 1 && lower(managementRecipients[0].recipient) === lower(SAFE) && managementRecipients[0].feeValue === 50n, 'CurveYield management recipient mismatch');
    assert(performanceRecipients.length === 1 && lower(performanceRecipients[0].recipient) === lower(SAFE) && performanceRecipients[0].feeValue === 800n, 'CurveYield performance recipient mismatch');

    const price = new ethers.Contract(priceManager, [
      'function getSourceOfAssetPrice(address) view returns (address)'
    ], provider);
    assert(lower(await price.getSourceOfAssetPrice(VB_USDC)) === lower(USD_PRICE_FEED), 'vbUSDC price feed mismatch');
    assert(lower(await price.getSourceOfAssetPrice(KAT)) === lower(KAT_PRICE_SOURCE), 'KAT price feed mismatch');

    const rewards = new ethers.Contract(rewardsManager, [
      'function getRewardsFuses() view returns (address[])',
      'function getVestingData() view returns ((uint32 vestingTime,uint32 updateBalanceTimestamp,uint128 transferredTokens,uint128 lastUpdateBalance))'
    ], provider);
    const [rewardFuses, vesting] = await Promise.all([rewards.getRewardsFuses(), rewards.getVestingData()]);
    assert(rewardFuses.map(lower).includes(lower(MERKL_CLAIM_FUSE)), 'Merkl reward fuse missing');
    assert(Number(vesting.vestingTime) === 15 * 24 * 60 * 60, 'reward vesting time mismatch');

    const customRewardFuse = rewardFuses.find((x) => lower(x) !== lower(MERKL_CLAIM_FUSE));
    assert(customRewardFuse, 'custom KAT reward fuse missing');
    assert((await provider.getCode(customRewardFuse)) !== '0x', 'custom reward fuse has no code');

    const customFuse = new ethers.Contract(customRewardFuse, [
      'function VAULT() view returns (address)',
      'function MANAGER() view returns (address)',
      'function ROUTER() view returns (address)'
    ], provider);
    assert(lower(await customFuse.VAULT()) === lower(plasmaVault), 'custom reward fuse vault binding mismatch');
    assert(lower(await customFuse.MANAGER()) === lower(rewardsManager), 'custom reward fuse manager binding mismatch');
    assert(lower(await customFuse.ROUTER()) === lower(ROUTER), 'custom reward fuse router binding mismatch');

    const access = new ethers.Contract(accessManager, [
      'function hasRole(uint64,address) view returns (bool,uint32)'
    ], provider);
    const [alpha, claimer, vaultUpdater] = await Promise.all([
      access.hasRole(200, account0),
      access.hasRole(600, account0),
      access.hasRole(1100, plasmaVault),
    ]);
    assert(alpha[0] === true && Number(alpha[1]) === 0, 'keeper ALPHA role mismatch');
    assert(claimer[0] === true && Number(claimer[1]) === 0, 'keeper CLAIM_REWARDS role mismatch');
    assert(vaultUpdater[0] === true && Number(vaultUpdater[1]) === 0, 'vault UPDATE_REWARDS_BALANCE role mismatch');

    summary.verification = {
      plasmaVault,
      feeManager: feeManagerAddress,
      accessManager,
      rewardsManager,
      priceManager,
      customRewardFuse,
      name,
      symbol,
      asset,
      fuses,
      instantWithdrawalFuses: instant,
      market41,
      market7,
      managementFeeBps: Number(totalManagement),
      performanceFeeBps: Number(totalPerformance),
      rewardVestingSeconds: Number(vesting.vestingTime),
      roles: {
        alpha: alpha[0],
        claimRewards: claimer[0],
        vaultUpdateRewardsBalance: vaultUpdater[0],
      },
      blockRange: { beforeBlock, afterBlock },
    };

    summary.status = 'PASS';
  } catch (error) {
    summary.status = 'FAIL';
    summary.failures.push({
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? '').slice(0, 12000),
    });
    throw error;
  } finally {
    await fs.writeFile(
      path.join(outputRoot, 'CYVBUSDC_DEPLOYMENT_SIMULATION_SUMMARY_v1.json'),
      JSON.stringify(summary, null, 2) + '\n'
    );
    await engine.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});