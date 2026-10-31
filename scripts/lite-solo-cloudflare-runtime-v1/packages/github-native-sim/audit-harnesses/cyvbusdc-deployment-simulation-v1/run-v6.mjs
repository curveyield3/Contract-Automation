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
const ERC20_BALANCE_FUSE = '0xb81C00eb71a3D629E6f7Ba66a26218c418D438b8';
const MORPHO_BALANCE_FUSE = '0x70Ed27aEE2dD509bC6BB067d8e2C61A1FE96eCa4';
const MORPHO_SUPPLY_FUSE = '0x1f657229ec2D261be7dCD63ca82abed334d1f28b';
const MERKL_CLAIM_FUSE = '0xF4278e62a6B5A45E378e6692C7Aa9C7291E7ce36';

const AVKAT_MARKET = '0xbd48214a2f12e951da20ad0b8fd83b611c693b5bbaa280b68ba4075678f2a138';
const SIUSD_MARKET = '0xf7fc5cc82200ddf8f23188ddbd6727eda2c8bc41863e91fb767bbc6e4f71890e';
const WEETH_MARKET = '0x76e311d4b0e2e6ae88ad9bab18063452a6d39837d7104c430ff62457b91cb2cb';
const EXPECTED_ROUTE = '0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d0001f4203a662b0bd271a6ed5a60edfbd04bfce608fd36';

const EXPECTED_SCRIPT_PATH = 'cyvbUSDC/script/DeployCyvbUSDC_v3.s.sol';
const EXPECTED_REWARD_ARTIFACT = 'out/KatRewardSwapAndSplitFuse_v3.sol/KatRewardSwapAndSplitFuse_v3.json';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error('missing value for ' + argv[i]);
    out[argv[i].slice(2)] = value;
    i++;
  }
  return out;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function lower(value) {
  return String(value).toLowerCase();
}

function bytes32Address(ethers, address) {
  return ethers.zeroPadValue(address, 32);
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

async function waitTx(tx, label, evidence) {
  const receipt = await tx.wait();
  assert(receipt && receipt.status === 1, label + ' transaction failed');
  evidence.push({
    label,
    hash: receipt.hash,
    blockNumber: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
  });
  return receipt;
}

async function writeFoundryConfig(root) {
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

async function verifyPinnedSource(root) {
  const script = await fs.readFile(path.join(root, EXPECTED_SCRIPT_PATH), 'utf8');
  const checks = [
    'contract DeployCyvbUSDC_v3 is Script',
    'FACTORY.clone(',
    '"CurveYield USDC"',
    '"cyvbUSDC"',
    'MIDDLE_WAY_PACKAGE_INDEX = 1',
    'CURVEYIELD_MANAGEMENT_BPS = 50',
    'CURVEYIELD_PERFORMANCE_BPS = 800',
    'REWARD_VESTING_TIME = 15 days',
    'MORPHO_LIQUIDITY_SUPPLY_FUSE = 0x1f657229ec2D261be7dCD63ca82abed334d1f28b',
    'MERKL_CLAIM_FUSE = 0xF4278e62a6B5A45E378e6692C7Aa9C7291E7ce36',
    'new KatRewardSwapAndSplitFuse_v3(',
    'vault.convertToPublicVault();',
    'vault.enableTransferShares();'
  ];
  for (const needle of checks) assert(script.includes(needle), 'Pinned deployment source drift: missing ' + needle);
  return { path: EXPECTED_SCRIPT_PATH, checks };
}

async function startKatanaFork({ forkUrl }) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await startAnvilEngine({
        artifacts: [],
        workflow: { steps: [] },
        chainId: 747474,
        forkUrl,
        evmVersion: 'cancun',
        cwd: process.cwd(),
        quiet: true,
      });
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
  throw lastError ?? new Error('Katana Anvil fork failed to start');
}

async function safeExec({ safe, router, owner, data, ethers, evidence }) {
  const signature = ethers.solidityPacked(
    ['uint256', 'uint256', 'uint8'],
    [BigInt(owner), 0n, 1]
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
    { gasLimit: 7_000_000n }
  );
  return await waitTx(tx, 'fork-only Safe router configuration', evidence);
}

async function ensureForkRoute({ provider, ethers, txEvidence }) {
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

  const localReadSigner = await provider.getSigner(0);
  const routerRead = new ethers.Contract(ROUTER, routerAbi, localReadSigner);
  const current = await routerRead.routeFor(KAT, VB_USDC);
  if (current !== '0x') {
    assert(lower(current) === lower(EXPECTED_ROUTE), 'Existing route differs from expected direct KAT/vbUSDC path');
    const guard = await routerRead.routeTwapGuard(KAT, VB_USDC);
    return {
      installedBySimulation: false,
      route: current,
      guard: [Number(guard[0]), Number(guard[1]), guard[2]],
    };
  }

  const safeRead = new ethers.Contract(SAFE, safeAbi, localReadSigner);
  const owners = await safeRead.getOwners();
  const threshold = await safeRead.getThreshold();
  assert(threshold === 1n, 'CurveYield Safe threshold is not 1');
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
    evidence: txEvidence,
  });
  await safeExec({
    safe,
    router,
    owner,
    data: router.interface.encodeFunctionData('setRouteFeeBps', [KAT, VB_USDC, 0]),
    ethers,
    evidence: txEvidence,
  });
  await safeExec({
    safe,
    router,
    owner,
    data: router.interface.encodeFunctionData('setRouteTwapGuard', [KAT, VB_USDC, 900, 200]),
    ethers,
    evidence: txEvidence,
  });

  const installed = await routerRead.routeFor(KAT, VB_USDC);
  const guard = await routerRead.routeTwapGuard(KAT, VB_USDC);
  assert(lower(installed) === lower(EXPECTED_ROUTE), 'Fork route installation mismatch');
  assert(Number(guard[0]) === 900 && Number(guard[1]) === 200 && guard[2] === true, 'Fork TWAP guard mismatch');

  return {
    installedBySimulation: true,
    owner,
    route: installed,
    guard: [Number(guard[0]), Number(guard[1]), guard[2]],
  };
}

async function compileRewardFuse({ smartRoot }) {
  await writeFoundryConfig(smartRoot);
  const build = await run('forge', ['build', '--sizes'], { cwd: smartRoot });
  assert(build.code === 0, 'Smart-Contracts forge build failed');

  const artifactPath = path.join(smartRoot, EXPECTED_REWARD_ARTIFACT);
  const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
  const bytecode = artifact?.bytecode?.object;
  assert(typeof bytecode === 'string' && bytecode.length > 4, 'KatRewardSwapAndSplitFuse_v3 bytecode missing');
  assert(Array.isArray(artifact.abi), 'KatRewardSwapAndSplitFuse_v3 ABI missing');

  return {
    artifactPath: EXPECTED_REWARD_ARTIFACT,
    abi: artifact.abi,
    bytecode,
  };
}

async function executeDeploymentPlan({ provider, ethers, rewardArtifact, txEvidence }) {
  const signer = await provider.getSigner(0);
  const deployer = await signer.getAddress();

  for (const address of [
    FACTORY, VB_USDC, KAT, USD_PRICE_FEED, KAT_PRICE_SOURCE,
    ERC20_BALANCE_FUSE, MORPHO_BALANCE_FUSE, MORPHO_SUPPLY_FUSE,
    MERKL_CLAIM_FUSE, ROUTER
  ]) {
    assert((await provider.getCode(address)) !== '0x', 'External dependency code missing at ' + address);
  }

  const factoryAbi = [
    'function getDaoFeePackages() view returns ((uint256 managementFee,uint256 performanceFee,address feeRecipient)[])',
    'function clone(string,string,address,uint256,address,uint256)',
    'event FusionInstanceCreated(uint256 index,uint256 version,string assetName,string assetSymbol,uint8 assetDecimals,address underlyingToken,string underlyingTokenSymbol,uint8 underlyingTokenDecimals,address initialOwner,address plasmaVault,address plasmaVaultBase,address feeManager)'
  ];
  const factory = new ethers.Contract(FACTORY, factoryAbi, signer);

  const packages = await factory.getDaoFeePackages();
  assert(packages.length > 1, 'Middle Way package missing');
  assert(packages[1].managementFee === 30n, 'Middle Way management fee changed');
  assert(packages[1].performanceFee === 200n, 'Middle Way performance fee changed');
  assert(packages[1].feeRecipient !== ethers.ZeroAddress, 'Middle Way IPOR recipient is zero');

  const router = new ethers.Contract(ROUTER, ['function routeFor(address,address) view returns (bytes)'], signer);
  assert((await router.routeFor(KAT, VB_USDC)) !== '0x', 'KAT->vbUSDC route prerequisite missing');

  const cloneReceipt = await waitTx(
    await factory.clone('CurveYield USDC', 'cyvbUSDC', VB_USDC, 0n, deployer, 1n, { gasLimit: 30_000_000n }),
    'FACTORY.clone',
    txEvidence
  );

  const topic = factory.interface.getEvent('FusionInstanceCreated').topicHash;
  const eventLog = cloneReceipt.logs.find((log) => lower(log.address) === lower(FACTORY) && log.topics[0] === topic);
  assert(eventLog, 'FusionInstanceCreated event missing');
  const created = factory.interface.parseLog(eventLog);
  assert(created, 'FusionInstanceCreated could not be decoded');
  assert(created.args.assetName === 'CurveYield USDC', 'factory event vault name mismatch');
  assert(created.args.assetSymbol === 'cyvbUSDC', 'factory event vault symbol mismatch');
  assert(lower(created.args.underlyingToken) === lower(VB_USDC), 'factory event underlying mismatch');

  const plasmaVault = created.args.plasmaVault;
  const feeManagerAddress = created.args.feeManager;

  const vaultAbi = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function asset() view returns (address)',
    'function getAccessManagerAddress() view returns (address)',
    'function getRewardsClaimManagerAddress() view returns (address)',
    'function getPriceOracleMiddleware() view returns (address)',
    'function addFuses(address[])',
    'function addBalanceFuse(uint256,address)',
    'function grantMarketSubstrates(uint256,bytes32[])',
    'function configureInstantWithdrawalFuses((address fuse,bytes32[] params)[])',
    'function convertToPublicVault()',
    'function enableTransferShares()',
    'function getFuses() view returns (address[])',
    'function getInstantWithdrawalFuses() view returns (address[])',
    'function getMarketSubstrates(uint256) view returns (bytes32[])',
    'function getManagementFeeData() view returns ((address feeAccount,uint16 feeInPercentage,uint32 lastUpdateTimestamp))',
    'function getPerformanceFeeData() view returns ((address feeAccount,uint16 feeInPercentage))'
  ];
  const vault = new ethers.Contract(plasmaVault, vaultAbi, signer);
  const [accessManager, rewardsManager, priceManager] = await Promise.all([
    vault.getAccessManagerAddress(),
    vault.getRewardsClaimManagerAddress(),
    vault.getPriceOracleMiddleware(),
  ]);

  const access = new ethers.Contract(accessManager, [
    'function grantRole(uint64,address,uint32)',
    'function hasRole(uint64,address) view returns (bool,uint32)'
  ], signer);

  for (const [role, account, label] of [
    [100, deployer, 'grant ATOMIST'],
    [300, deployer, 'grant FUSE_MANAGER'],
    [900, deployer, 'grant CONFIG_INSTANT_WITHDRAWAL_FUSES'],
    [1200, deployer, 'grant PRICE_ORACLE_MIDDLEWARE_MANAGER'],
    [200, deployer, 'grant ALPHA'],
    [600, deployer, 'grant CLAIM_REWARDS'],
    [1000, deployer, 'grant UPDATE_MARKETS_BALANCES'],
    [1100, plasmaVault, 'grant vault UPDATE_REWARDS_BALANCE']
  ]) {
    await waitTx(await access.grantRole(role, account, 0, { gasLimit: 2_000_000n }), label, txEvidence);
  }

  const price = new ethers.Contract(priceManager, [
    'function setAssetsPriceSources(address[],address[])',
    'function getSourceOfAssetPrice(address) view returns (address)'
  ], signer);
  await waitTx(
    await price.setAssetsPriceSources(
      [VB_USDC, KAT],
      [USD_PRICE_FEED, KAT_PRICE_SOURCE],
      { gasLimit: 3_000_000n }
    ),
    'set vbUSDC/KAT price sources',
    txEvidence
  );

  await waitTx(await vault.addFuses([MORPHO_SUPPLY_FUSE], { gasLimit: 3_000_000n }), 'add Morpho supply fuse', txEvidence);
  await waitTx(await vault.addBalanceFuse(41, MORPHO_BALANCE_FUSE, { gasLimit: 2_000_000n }), 'add market41 balance fuse', txEvidence);
  await waitTx(await vault.addBalanceFuse(7, ERC20_BALANCE_FUSE, { gasLimit: 2_000_000n }), 'add market7 balance fuse', txEvidence);

  await waitTx(
    await vault.grantMarketSubstrates(41, [AVKAT_MARKET, SIUSD_MARKET, WEETH_MARKET], { gasLimit: 3_000_000n }),
    'grant Morpho market substrates',
    txEvidence
  );
  await waitTx(
    await vault.grantMarketSubstrates(7, [bytes32Address(ethers, KAT)], { gasLimit: 2_000_000n }),
    'grant residual KAT substrate',
    txEvidence
  );

  const zero = ethers.ZeroHash;
  const instant = [
    { fuse: MORPHO_SUPPLY_FUSE, params: [zero, AVKAT_MARKET] },
    { fuse: MORPHO_SUPPLY_FUSE, params: [zero, SIUSD_MARKET] },
    { fuse: MORPHO_SUPPLY_FUSE, params: [zero, WEETH_MARKET] },
  ];
  await waitTx(
    await vault.configureInstantWithdrawalFuses(instant, { gasLimit: 4_000_000n }),
    'configure three instant withdrawal fuses',
    txEvidence
  );

  const feeManager = new ethers.Contract(feeManagerAddress, [
    'function updateManagementFee((address recipient,uint256 feeValue)[])',
    'function updatePerformanceFee((address recipient,uint256 feeValue)[])',
    'function getTotalManagementFee() view returns (uint256)',
    'function getTotalPerformanceFee() view returns (uint256)',
    'function getManagementFeeRecipients() view returns ((address recipient,uint256 feeValue)[])',
    'function getPerformanceFeeRecipients() view returns ((address recipient,uint256 feeValue)[])'
  ], signer);
  await waitTx(
    await feeManager.updateManagementFee([{ recipient: SAFE, feeValue: 50n }], { gasLimit: 4_000_000n }),
    'configure CurveYield management fee',
    txEvidence
  );
  await waitTx(
    await feeManager.updatePerformanceFee([{ recipient: SAFE, feeValue: 800n }], { gasLimit: 4_000_000n }),
    'configure CurveYield performance fee',
    txEvidence
  );

  const rewards = new ethers.Contract(rewardsManager, [
    'function setupVestingTime(uint256)',
    'function addRewardFuses(address[])',
    'function getRewardsFuses() view returns (address[])',
    'function isRewardFuseSupported(address) view returns (bool)',
    'function getVestingData() view returns ((uint32 vestingTime,uint32 updateBalanceTimestamp,uint128 transferredTokens,uint128 lastUpdateBalance))'
  ], signer);
  await waitTx(await rewards.setupVestingTime(15n * 24n * 60n * 60n, { gasLimit: 2_000_000n }), 'set 15-day reward vesting', txEvidence);

  const rewardFactory = new ethers.ContractFactory(rewardArtifact.abi, rewardArtifact.bytecode, signer);
  const rewardFuse = await rewardFactory.deploy(plasmaVault, rewardsManager, ROUTER, { gasLimit: 9_000_000n });
  const rewardDeployTx = rewardFuse.deploymentTransaction();
  assert(rewardDeployTx, 'custom reward fuse deployment transaction missing');
  await waitTx(rewardDeployTx, 'deploy KatRewardSwapAndSplitFuse_v3', txEvidence);
  const rewardFuseAddress = await rewardFuse.getAddress();

  await waitTx(
    await rewards.addRewardFuses([MERKL_CLAIM_FUSE, rewardFuseAddress], { gasLimit: 3_000_000n }),
    'install Merkl and KAT reward fuses',
    txEvidence
  );

  await waitTx(await vault.convertToPublicVault({ gasLimit: 2_000_000n }), 'convert to public vault', txEvidence);
  await waitTx(await vault.enableTransferShares({ gasLimit: 2_000_000n }), 'enable share transfers', txEvidence);

  return {
    deployer,
    plasmaVault,
    feeManagerAddress,
    accessManager,
    rewardsManager,
    priceManager,
    rewardFuseAddress,
    signer,
    vault,
    access,
    price,
    feeManager,
    rewards,
  };
}

async function verifyDeployment({ context, provider, ethers }) {
  const {
    deployer, plasmaVault, feeManagerAddress, accessManager, rewardsManager,
    priceManager, rewardFuseAddress, signer, vault, access, price, feeManager, rewards
  } = context;

  const [
    name,
    symbol,
    asset,
    fuses,
    instant,
    market41,
    market7,
    management,
    performance,
    totalManagement,
    totalPerformance,
    managementRecipients,
    performanceRecipients,
    rewardFuses,
    vesting,
    alpha,
    claimer,
    marketUpdater,
    vaultUpdater,
  ] = await Promise.all([
    vault.name(),
    vault.symbol(),
    vault.asset(),
    vault.getFuses(),
    vault.getInstantWithdrawalFuses(),
    vault.getMarketSubstrates(41),
    vault.getMarketSubstrates(7),
    vault.getManagementFeeData(),
    vault.getPerformanceFeeData(),
    feeManager.getTotalManagementFee(),
    feeManager.getTotalPerformanceFee(),
    feeManager.getManagementFeeRecipients(),
    feeManager.getPerformanceFeeRecipients(),
    rewards.getRewardsFuses(),
    rewards.getVestingData(),
    access.hasRole(200, deployer),
    access.hasRole(600, deployer),
    access.hasRole(1000, deployer),
    access.hasRole(1100, plasmaVault),
  ]);

  assert(name === 'CurveYield USDC', 'deployed name mismatch');
  assert(symbol === 'cyvbUSDC', 'deployed symbol mismatch');
  assert(lower(asset) === lower(VB_USDC), 'deployed asset mismatch');

  assert(fuses.map(lower).includes(lower(MORPHO_SUPPLY_FUSE)), 'Morpho supply fuse missing');
  assert(instant.length === 3 && instant.every((x) => lower(x) === lower(MORPHO_SUPPLY_FUSE)), 'instant withdrawal fuse list mismatch');

  assert(market41.length === 3, 'market41 substrate count mismatch');
  assert(lower(market41[0]) === lower(AVKAT_MARKET), 'avKAT market order mismatch');
  assert(lower(market41[1]) === lower(SIUSD_MARKET), 'siUSD market order mismatch');
  assert(lower(market41[2]) === lower(WEETH_MARKET), 'weETH market order mismatch');
  assert(market7.length === 1 && lower(market7[0]) === lower(bytes32Address(ethers, KAT)), 'residual KAT substrate mismatch');

  assert(Number(management.feeInPercentage) === 80, 'vault management fee mismatch');
  assert(Number(performance.feeInPercentage) === 1000, 'vault performance fee mismatch');
  assert(totalManagement === 80n, 'FeeManager total management mismatch');
  assert(totalPerformance === 1000n, 'FeeManager total performance mismatch');
  assert(managementRecipients.length === 1, 'management recipient count mismatch');
  assert(lower(managementRecipients[0].recipient) === lower(SAFE) && managementRecipients[0].feeValue === 50n, 'management recipient/value mismatch');
  assert(performanceRecipients.length === 1, 'performance recipient count mismatch');
  assert(lower(performanceRecipients[0].recipient) === lower(SAFE) && performanceRecipients[0].feeValue === 800n, 'performance recipient/value mismatch');

  assert(lower(await price.getSourceOfAssetPrice(VB_USDC)) === lower(USD_PRICE_FEED), 'vbUSDC price source mismatch');
  assert(lower(await price.getSourceOfAssetPrice(KAT)) === lower(KAT_PRICE_SOURCE), 'KAT price source mismatch');

  assert(rewardFuses.map(lower).includes(lower(MERKL_CLAIM_FUSE)), 'Merkl reward fuse missing');
  assert(rewardFuses.map(lower).includes(lower(rewardFuseAddress)), 'custom reward fuse missing');
  assert(Number(vesting.vestingTime) === 15 * 24 * 60 * 60, 'reward vesting mismatch');

  assert(alpha[0] === true && Number(alpha[1]) === 0, 'ALPHA role mismatch');
  assert(claimer[0] === true && Number(claimer[1]) === 0, 'CLAIM_REWARDS role mismatch');
  assert(marketUpdater[0] === true && Number(marketUpdater[1]) === 0, 'UPDATE_MARKETS_BALANCES role mismatch');
  assert(vaultUpdater[0] === true && Number(vaultUpdater[1]) === 0, 'vault UPDATE_REWARDS_BALANCE role mismatch');

  const reward = new ethers.Contract(rewardFuseAddress, [
    'function VAULT() view returns (address)',
    'function MANAGER() view returns (address)',
    'function ROUTER() view returns (address)',
    'function ADMIN_FEE_RECEIVER() view returns (address)',
    'function KAT() view returns (address)',
    'function VB_USDC() view returns (address)'
  ], signer);
  assert(lower(await reward.VAULT()) === lower(plasmaVault), 'reward fuse VAULT binding mismatch');
  assert(lower(await reward.MANAGER()) === lower(rewardsManager), 'reward fuse MANAGER binding mismatch');
  assert(lower(await reward.ROUTER()) === lower(ROUTER), 'reward fuse ROUTER binding mismatch');
  assert(lower(await reward.ADMIN_FEE_RECEIVER()) === lower(SAFE), 'reward fuse admin receiver mismatch');
  assert(lower(await reward.KAT()) === lower(KAT), 'reward fuse KAT mismatch');
  assert(lower(await reward.VB_USDC()) === lower(VB_USDC), 'reward fuse vbUSDC mismatch');

  return {
    plasmaVault,
    feeManager: feeManagerAddress,
    accessManager,
    rewardsManager,
    priceManager,
    rewardFuse: rewardFuseAddress,
    name,
    symbol,
    asset,
    installedFuses: fuses,
    instantWithdrawalFuses: instant,
    market41Substrates: market41,
    market7Substrates: market7,
    managementFeeBps: Number(totalManagement),
    performanceFeeBps: Number(totalPerformance),
    managementRecipients: managementRecipients.map((x) => ({ recipient: x.recipient, feeValue: x.feeValue.toString() })),
    performanceRecipients: performanceRecipients.map((x) => ({ recipient: x.recipient, feeValue: x.feeValue.toString() })),
    rewardFuses,
    rewardVestingSeconds: Number(vesting.vestingTime),
    roles: {
      alpha: alpha[0],
      claimRewards: claimer[0],
      updateMarketsBalances: marketUpdater[0],
      vaultUpdateRewardsBalance: vaultUpdater[0],
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const smartRoot = path.resolve(args['smart-contracts-root'] ?? '.smart-contracts');
  const outputRoot = path.resolve(args.output ?? 'cyvbusdc-deployment-simulation-output-v4');
  const forkUrl = args['fork-url'];
  assert(forkUrl, '--fork-url is required');

  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });

  const summary = {
    schemaVersion: 'curveyield-cyvbusdc-deployment-simulation-v2',
    status: 'RUNNING',
    simulationMethod: 'CONTRACT_AUTOMATION_ANVIL_EXACT_DEPLOYMENT_SEQUENCE_ADAPTER',
    pinnedSmartContractsCommit: 'fd0a01ab0e4a066a4e4ef8d28a6987a194ab5f45',
    pinnedDeploymentScript: EXPECTED_SCRIPT_PATH,
    fork: { engine: 'anvil', chainId: 747474, upstreamRpcExposed: false },
    sourceBinding: null,
    routePrerequisite: null,
    compilation: null,
    transactions: [],
    verification: null,
    limitations: [
      'Forge 1.8.4 direct script execution on Katana is blocked by its OP-stack hardfork classifier (Cancun reported for optimism); this adapter executes the exact pinned deployment transaction sequence against the same Anvil fork instead.'
    ],
    failures: [],
  };

  let engine;
  try {
    const ethers = await import('ethers');

    summary.sourceBinding = await verifyPinnedSource(smartRoot);
    const rewardArtifact = await compileRewardFuse({ smartRoot });
    summary.compilation = {
      status: 'PASS',
      rewardArtifact: rewardArtifact.artifactPath,
    };

    engine = await startKatanaFork({ forkUrl });
    const provider = engine.provider;
    assert(BigInt(await provider.send('eth_chainId', [])) === 747474n, 'Anvil chain id mismatch');

    summary.routePrerequisite = await ensureForkRoute({
      provider,
      ethers,
      txEvidence: summary.transactions,
    });

    const context = await executeDeploymentPlan({
      provider,
      ethers,
      rewardArtifact,
      txEvidence: summary.transactions,
    });

    summary.verification = await verifyDeployment({ context, provider, ethers });
    summary.status = 'PASS';
  } catch (error) {
    summary.status = 'FAIL';
    summary.failures.push({
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? '').slice(0, 14000),
    });
    throw error;
  } finally {
    await fs.writeFile(
      path.join(outputRoot, 'CYVBUSDC_DEPLOYMENT_SIMULATION_SUMMARY_v2.json'),
      JSON.stringify(summary, null, 2) + '\n'
    );
    if (engine) await engine.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});