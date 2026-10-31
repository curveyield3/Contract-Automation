import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getContract,
  http,
  keccak256,
  maxUint160,
  maxUint256,
  parseAbi,
  parseEther,
  stringToHex,
  zeroAddress,
} from 'viem';
import { compileContracts } from '../lib/compileSolc.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i]?.startsWith('--') || process.argv[i + 1] === undefined) {
    throw new Error('Arguments must be --key value pairs');
  }
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}

const deploymentReportPath = path.resolve(args.report || '');
const statePath = path.resolve(args.state || '');
const outputPath = path.resolve(args.output || 'MASTER_TARGETED_INTEGRATION_RESULT_v1.json');
const forkUrl = args['fork-url'] || 'https://katana.drpc.org/';
const anvilPath = process.env.ANVIL_PATH || 'anvil';
const port = Number(args.port || 8655);
if (!fs.existsSync(deploymentReportPath)) throw new Error('Missing deployment report');
if (!fs.existsSync(statePath)) throw new Error('Missing handed-off Anvil state');

const report = JSON.parse(fs.readFileSync(deploymentReportPath, 'utf8'));
const deployments = Object.fromEntries(
  Object.entries(report.deployments || {}).map(([name, row]) => [name, typeof row === 'string' ? row : row.address]),
);
const rpcUrl = `http://127.0.0.1:${port}`;
const chain = defineChain({
  id: 747474,
  name: 'Katana master-targeted fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const transport = http(rpcUrl, { timeout: 120_000 });
const publicClient = createPublicClient({ chain, transport });
const testClient = createTestClient({ chain, mode: 'anvil', transport });

const actor = {
  deployer: report.deployer,
  creatorA: '0x1000000000000000000000000000000000000001',
  receiverX: '0x1000000000000000000000000000000000000002',
  controllerB: '0x1000000000000000000000000000000000000003',
  receiverY: '0x1000000000000000000000000000000000000004',
  outsider: '0x1000000000000000000000000000000000000005',
};
const wallets = {};

const result = {
  schemaVersion: 'curveyield-dex-master-targeted-integration-v1',
  sourceArchiveSha256: '201a70f61f14e1919d111a972d090b07cf13e5fc06fee10738785adfb6760f4e',
  sourceCommit: '68490f0ec79ff761ed9361af8afe180fd44f612d',
  fork: { chain: 'katana', chainId: 747474, upstream: forkUrl },
  deploymentReport: deploymentReportPath,
  handedOffState: statePath,
  startedAt: new Date().toISOString(),
  actors: actor,
  addresses: {
    dao: report.dao,
    adminPlugin: report.aragon?.adminPlugin,
    deployments,
  },
  calls: [],
  assertions: [],
  candidates: {
    'P4-CAND-001': { executedCalls: 0 },
    'P4-CAND-002': { executedCalls: 0 },
    'OBL-P3-P3-OBL-005': { executedCalls: 0 },
  },
};

const erc20Abi = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const permit2Abi = parseAbi([
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  'function allowance(address user,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
]);
const routerAbi = parseAbi([
  'function initialize(address pool,address[] tokens,uint256[] exactAmountsIn,uint256 minBptAmountOut,bool wethIsEth,bytes userData) payable returns (uint256)',
  'function swapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,uint256 minAmountOut,uint256 deadline,bool wethIsEth,bytes userData) payable returns (uint256)',
]);
const keeperAbi = parseAbi([
  'function collect(address pool)',
  'function collectPartnerPoL(address pool)',
]);
const settlementAbi = parseAbi([
  'function collect(address pool)',
  'function setProtectedBptSettlementHook(address hook,bool approved)',
  'function setKeeper(address keeper,bool approved)',
  'function feeConverterStorage() view returns (address)',
  'function poolDust(address pool,address token) view returns (uint256)',
  'function totalAccountedDust(address token) view returns (uint256)',
]);
const feeControllerAbi = parseAbi([
  'function getProtocolFeeAmounts(address pool) view returns (uint256[])',
  'function getPoolCreatorFeeAmounts(address pool) view returns (uint256[])',
]);
const registryAbi = parseAbi([
  'function requestCreatorControllerTransfer(address pool,address newController)',
  'function acceptCreatorControllerTransfer(address pool)',
  'function setCreatorPayoutReceiver(address pool,address newReceiver)',
  'function creatorControllerOf(address pool) view returns (address)',
  'function creatorPayoutReceiverOf(address pool) view returns (address)',
  'function creatorControllerEpochOf(address pool) view returns (uint64)',
]);
const permanentVaultAbi = parseAbi([
  'function nextLotId() view returns (uint256)',
  'function nextCreatorMigrationRequestId() view returns (uint256)',
  'function totalBpt(address) view returns (uint256)',
  'function liquidityLots(uint256) view returns (address sourcePool,address targetPool,address bpt,uint256 remainingBpt,uint8 origin,address creatorController,address creatorPayoutReceiver)',
  'function approveMigrationTarget(address pool,bool approved)',
  'function requestCreatorMigration((uint256 lotId,address targetPool,uint256 sourceBptAmount,bytes32 sourceTokenSetHash,bytes32 targetTokenSetHash,uint256[] minSourceAmountsOut,(address tokenIn,address tokenOut,address adapter,uint256 amountIn,uint256 minAmountOut,bytes32 routeDataHash)[] swaps,uint256 minTargetBptOut,uint256 expiry) plan) returns (uint256)',
  'function approveCreatorMigration(uint256 requestId)',
  'function cancelCreatorMigration(uint256 requestId)',
  'function executeCreatorMigration(uint256 requestId,(uint256 lotId,address targetPool,uint256 sourceBptAmount,bytes32 sourceTokenSetHash,bytes32 targetTokenSetHash,uint256[] minSourceAmountsOut,(address tokenIn,address tokenOut,address adapter,uint256 amountIn,uint256 minAmountOut,bytes32 routeDataHash)[] swaps,uint256 minTargetBptOut,uint256 expiry) plan,bytes[] routeData) returns (uint256)',
]);
const authorizerAbi = parseAbi([
  'function isRoot(address) view returns (bool)',
  'function getPendingRoot() view returns (address)',
]);
const ownableAbi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
]);
const adminPluginAbi = parseAbi([
  'struct Action { address to; uint256 value; bytes data; }',
  'function executeProposal(bytes metadata,Action[] actions,uint256 allowFailureMap) returns (uint256)',
]);
const ownerTokenAbi = parseAbi([
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
]);

const asJson = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

function assertion(candidateId, label, ok, detail = null) {
  result.assertions.push({ candidateId, label, ok, detail: asJson(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${candidateId}] ${label}${detail === null ? '' : ' :: ' + JSON.stringify(asJson(detail))}`);
}

async function impersonateAll() {
  for (const [name, address] of Object.entries(actor)) {
    await testClient.impersonateAccount({ address });
    await testClient.setBalance({ address, value: parseEther('1000') });
    wallets[name] = createWalletClient({ account: address, chain, transport });
  }
}

async function waitForRpc() {
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    try {
      await publicClient.getChainId();
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for Anvil');
}

async function send(candidateId, wallet, address, abi, functionName, callArgs = [], value = 0n) {
  const hash = await wallet.writeContract({
    address,
    abi,
    functionName,
    args: callArgs,
    value,
    chain,
    account: wallet.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  result.calls.push({
    candidateId,
    kind: 'transaction',
    from: wallet.account,
    to: address,
    functionName,
    args: asJson(callArgs),
    value: value.toString(),
    hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    blockNumber: receipt.blockNumber.toString(),
  });
  result.candidates[candidateId].executedCalls += 1;
  if (receipt.status !== 'success') throw new Error(`${functionName} transaction failed`);
  return receipt;
}

async function deploy(candidateId, wallet, artifact, callArgs = []) {
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: callArgs,
    chain,
    account: wallet.account,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  result.calls.push({
    candidateId,
    kind: 'deployment',
    from: wallet.account,
    functionName: 'deploy',
    args: asJson(callArgs),
    hash,
    status: receipt.status,
    contractAddress: receipt.contractAddress,
    gasUsed: receipt.gasUsed.toString(),
  });
  result.candidates[candidateId].executedCalls += 1;
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment failed');
  return getContract({ address: receipt.contractAddress, abi: artifact.abi, client: { public: publicClient } });
}

async function expectRevert(candidateId, label, wallet, address, abi, functionName, callArgs = []) {
  try {
    await publicClient.simulateContract({
      address,
      abi,
      functionName,
      args: callArgs,
      account: wallet.account,
    });
    result.calls.push({
      candidateId,
      kind: 'negative-control',
      from: wallet.account,
      to: address,
      functionName,
      args: asJson(callArgs),
      outcome: 'UNEXPECTED_SUCCESS',
    });
    result.candidates[candidateId].executedCalls += 1;
    assertion(candidateId, label, false, 'unexpected success');
    return false;
  } catch (error) {
    const reason = String(error?.shortMessage || error?.message || error).slice(0, 1600);
    result.calls.push({
      candidateId,
      kind: 'negative-control',
      from: wallet.account,
      to: address,
      functionName,
      args: asJson(callArgs),
      outcome: 'REVERT',
      reason,
    });
    result.candidates[candidateId].executedCalls += 1;
    assertion(candidateId, label, true, reason);
    return true;
  }
}

async function daoCall(candidateId, label, to, abi, functionName, callArgs = []) {
  const data = encodeFunctionData({ abi, functionName, args: callArgs });
  return send(
    candidateId,
    wallets.deployer,
    report.aragon.adminPlugin,
    adminPluginAbi,
    'executeProposal',
    [stringToHex(label), [{ to, value: 0n, data }], 0n],
  );
}

function tokenSetHash(tokens) {
  return keccak256(encodeAbiParameters([{ type: 'address[]' }], [tokens]));
}

async function reload(state) {
  await testClient.loadState({ state });
  await impersonateAll();
}

async function findCreatorLots(startId, endId, sourcePool) {
  const rows = [];
  for (let id = startId; id < endId; id += 1n) {
    const lot = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'liquidityLots',
      args: [id],
    });
    if (
      lot[0].toLowerCase() === sourcePool.toLowerCase() &&
      Number(lot[4]) === 0 &&
      lot[3] > 0n
    ) {
      rows.push({ id, lot });
    }
  }
  return rows;
}

async function main() {
  const anvil = spawn(
    anvilPath,
    [
      '--fork-url', forkUrl,
      '--port', String(port),
      '--retries', '20',
      '--fork-retry-backoff', '1500',
      '--compute-units-per-second', '25',
      '--silent',
    ],
    { stdio: 'ignore' },
  );

  try {
    await waitForRpc();
    await testClient.loadState({ state: fs.readFileSync(statePath, 'utf8').trim() });
    await impersonateAll();
    const observedChainId = await publicClient.getChainId();
    if (observedChainId !== 747474) throw new Error(`Expected Katana chain 747474, got ${observedChainId}`);

    // OBL-P3-P3-OBL-005: source-native Katana governance acceptance.
    const daoCode = await publicClient.getCode({ address: report.dao });
    assertion('OBL-P3-P3-OBL-005', 'CurveYield DAO has runtime code', Boolean(daoCode && daoCode !== '0x'), report.dao);

    const [daoRoot, deployerRoot] = await Promise.all([
      publicClient.readContract({ address: deployments.TimelockAuthorizer, abi: authorizerAbi, functionName: 'isRoot', args: [report.dao] }),
      publicClient.readContract({ address: deployments.TimelockAuthorizer, abi: authorizerAbi, functionName: 'isRoot', args: [actor.deployer] }),
    ]);
    assertion('OBL-P3-P3-OBL-005', 'DAO is active TimelockAuthorizer root', daoRoot);
    assertion('OBL-P3-P3-OBL-005', 'former deployer is not authorizer root', !deployerRoot);

    const ownerNames = [
      'PoolFeePolicyRegistry',
      'RouteRegistry',
      'PermanentLiquidityVaultV2',
      'FeeSettlementRouter',
      'BalancerV3SwapAdapter',
      'CurveYieldWeightedPoolFactory',
      'CurveYieldStablePoolFactory',
      'CurveYieldStableSurgePoolFactory',
      'CurveYieldReClammPoolFactory',
      'CurveYieldGyroECLPPoolFactory',
      'CurveYieldPoolFactoryWrapper',
    ];
    result.governanceOwners = [];
    for (const name of ownerNames) {
      const address = deployments[name];
      const [owner, pendingOwner] = await Promise.all([
        publicClient.readContract({ address, abi: ownableAbi, functionName: 'owner' }),
        publicClient.readContract({ address, abi: ownableAbi, functionName: 'pendingOwner' }),
      ]);
      result.governanceOwners.push({ name, address, owner, pendingOwner });
      assertion(
        'OBL-P3-P3-OBL-005',
        `${name} has accepted DAO ownership and no pending owner`,
        owner.toLowerCase() === report.dao.toLowerCase() && pendingOwner === zeroAddress,
        { owner, pendingOwner },
      );
    }

    const crvOwner = await publicClient.readContract({
      address: deployments.crvYIELD,
      abi: ownerTokenAbi,
      functionName: 'owner',
    });
    assertion(
      'OBL-P3-P3-OBL-005',
      'crvYIELD mint/owner authority is the DAO',
      crvOwner.toLowerCase() === report.dao.toLowerCase(),
      crvOwner,
    );

    await expectRevert(
      'OBL-P3-P3-OBL-005',
      'retired deployer cannot directly mutate DAO-owned settlement configuration',
      wallets.deployer,
      deployments.FeeSettlementRouter,
      settlementAbi,
      'setProtectedBptSettlementHook',
      [deployments.CurveYieldMevVolumeHookV14, false],
    );
    await daoCall(
      'OBL-P3-P3-OBL-005',
      'targeted-test disable protected hook',
      deployments.FeeSettlementRouter,
      settlementAbi,
      'setProtectedBptSettlementHook',
      [deployments.CurveYieldMevVolumeHookV14, false],
    );
    await daoCall(
      'OBL-P3-P3-OBL-005',
      'targeted-test restore protected hook',
      deployments.FeeSettlementRouter,
      settlementAbi,
      'setProtectedBptSettlementHook',
      [deployments.CurveYieldMevVolumeHookV14, true],
    );
    assertion('OBL-P3-P3-OBL-005', 'Admin plugin executes representative DAO-owned action and restore', true);

    // Create real Balancer pools using exact source wrapper and simple exact-source test ERC20s.
    const { compiled } = compileContracts(
      ['tooling/test/contracts/CurveYieldDexAuditMocks.sol', 'contracts/CurveYieldPoolFactoryWrapper.sol'],
      ['MockDexERC20', 'CurveYieldPoolFactoryWrapper'],
    );
    const tokenA = await deploy('P4-CAND-001', wallets.deployer, compiled.MockDexERC20, ['Master Test A', 'MTA']);
    const tokenB = await deploy('P4-CAND-001', wallets.deployer, compiled.MockDexERC20, ['Master Test B', 'MTB']);
    const poolTokens = [tokenA.address, tokenB.address].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    result.addresses.tokens = poolTokens;

    for (const token of poolTokens) {
      await send('P4-CAND-001', wallets.deployer, token, erc20Abi, 'mint', [actor.creatorA, parseEther('1000000')]);
      await send('P4-CAND-001', wallets.creatorA, token, erc20Abi, 'approve', [report.permit2, maxUint256]);
      await send('P4-CAND-001', wallets.creatorA, report.permit2, permit2Abi, 'approve', [token, deployments.Router, maxUint160, 2n ** 48n - 1n]);
    }

    const wrapper = getContract({
      address: deployments.CurveYieldPoolFactoryWrapper,
      abi: compiled.CurveYieldPoolFactoryWrapper.abi,
      client: { public: publicClient },
    });
    const creationFee = await wrapper.read.poolCreationFeeWei();
    const tokenConfig = poolTokens.map((token) => ({ token, tokenType: 0, rateProvider: zeroAddress, paysYieldFees: false }));
    const roleManagers = { pauseManager: zeroAddress, swapFeeManager: zeroAddress };

    async function createWeighted(label, saltByte, creatorPermanentLiquidityBps) {
      const input = {
        tokens: tokenConfig,
        roleManagers,
        name: label,
        symbol: label.slice(0, 8),
        normalizedWeights: [parseEther('0.5'), parseEther('0.5')],
        swapFeePercentage: parseEther('0.003'),
        poolHooksContract: deployments.CurveYieldMevVolumeHookV14,
        disableUnbalancedLiquidity: false,
        salt: `0x${saltByte.repeat(32)}`,
      };
      const expectedPool = await wrapper.read.computeWeightedPoolAddress([input]);
      const policy = {
        creatorController: actor.creatorA,
        creatorPayoutReceiver: actor.receiverX,
        creatorPayoutToken: poolTokens[0],
        creatorPartnerRevenueReceiver: zeroAddress,
        expectedPool,
        splitterSalt: keccak256(stringToHex(label)),
        creatorFeeConfig: {
          creatorPersonalBps: 2_000,
          creatorPermanentLiquidityBps,
          creatorPartnerRevenueBps: 0,
        },
      };
      await send(
        'P4-CAND-001',
        wallets.creatorA,
        wrapper.address,
        wrapper.abi,
        'createWeightedPool',
        [input, policy],
        creationFee,
      );
      const code = await publicClient.getCode({ address: expectedPool });
      assertion('P4-CAND-001', `${label} real weighted pool created`, Boolean(code && code !== '0x'), expectedPool);
      return expectedPool;
    }

    const sourcePool = await createWeighted('Master Source', '91', 5_000);
    const targetPool = await createWeighted('Master Target', '92', 0);
    result.addresses.sourcePool = sourcePool;
    result.addresses.targetPool = targetPool;

    for (const pool of [sourcePool, targetPool]) {
      await send(
        'P4-CAND-001',
        wallets.creatorA,
        deployments.Router,
        routerAbi,
        'initialize',
        [pool, poolTokens, [parseEther('10000'), parseEther('10000')], 0n, false, '0x'],
      );
    }

    // Build observation history and accrue genuine protocol/creator fees.
    for (let i = 0; i < 4; i++) {
      await testClient.increaseTime({ seconds: 600 });
      await testClient.mine({ blocks: 1 });
      const [tokenIn, tokenOut] = i % 2 === 0 ? [poolTokens[0], poolTokens[1]] : [poolTokens[1], poolTokens[0]];
      await send(
        'P4-CAND-001',
        wallets.creatorA,
        deployments.Router,
        routerAbi,
        'swapSingleTokenExactIn',
        [sourcePool, tokenIn, tokenOut, parseEther('10'), 0n, 2n ** 64n, false, '0x'],
      );
    }
    await testClient.increaseTime({ seconds: 1200 });
    await testClient.mine({ blocks: 1 });
    for (let i = 0; i < 8; i++) {
      const [tokenIn, tokenOut] = i % 2 === 0 ? [poolTokens[0], poolTokens[1]] : [poolTokens[1], poolTokens[0]];
      await send(
        'P4-CAND-001',
        wallets.creatorA,
        deployments.Router,
        routerAbi,
        'swapSingleTokenExactIn',
        [sourcePool, tokenIn, tokenOut, parseEther('100'), 0n, 2n ** 64n, false, '0x'],
      );
    }

    const [protocolAccrued, creatorAccrued] = await Promise.all([
      publicClient.readContract({ address: deployments.ProtocolFeeController, abi: feeControllerAbi, functionName: 'getProtocolFeeAmounts', args: [sourcePool] }),
      publicClient.readContract({ address: deployments.ProtocolFeeController, abi: feeControllerAbi, functionName: 'getPoolCreatorFeeAmounts', args: [sourcePool] }),
    ]);
    assertion(
      'P4-CAND-001',
      'real swaps accrued protocol fees',
      protocolAccrued.some((x) => x > 0n),
      protocolAccrued,
    );
    assertion(
      'P4-CAND-001',
      'real swaps accrued creator fees needed for creator permanent-liquidity branch',
      creatorAccrued.some((x) => x > 0n),
      creatorAccrued,
    );

    const preSettlementState = await testClient.dumpState();

    // Healthy positive control.
    const receiverBefore = await Promise.all(
      poolTokens.map((token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [actor.receiverX] })),
    );
    const bptBefore = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'totalBpt',
      args: [sourcePool],
    });
    await send('P4-CAND-001', wallets.outsider, deployments.FeeSettlementKeeper, keeperAbi, 'collect', [sourcePool]);
    const receiverAfter = await Promise.all(
      poolTokens.map((token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [actor.receiverX] })),
    );
    const bptAfter = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'totalBpt',
      args: [sourcePool],
    });
    assertion('P4-CAND-001', 'healthy real settlement creates permanent-liquidity BPT', bptAfter > bptBefore, { bptBefore, bptAfter });
    assertion(
      'P4-CAND-001',
      'healthy real settlement pays creator receiver',
      receiverAfter.some((x, i) => x > receiverBefore[i]),
      { receiverBefore, receiverAfter },
    );
    for (const token of poolTokens) {
      const erc20Allowance = await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [deployments.FeeSettlementRouter, report.permit2],
      });
      const permitAllowance = await publicClient.readContract({
        address: report.permit2,
        abi: permit2Abi,
        functionName: 'allowance',
        args: [deployments.FeeSettlementRouter, token, deployments.Router],
      });
      assertion(
        'P4-CAND-001',
        `healthy settlement clears ERC20 and Permit2 allowance for ${token}`,
        erc20Allowance === 0n && permitAllowance[0] === 0n,
        { erc20Allowance, permit2Allowance: permitAllowance[0] },
      );
    }

    // Non-strict fallback under an actual protected-join dependency fault.
    await reload(preSettlementState);
    await daoCall(
      'P4-CAND-001',
      'disable protected hook for non-strict fallback',
      deployments.FeeSettlementRouter,
      settlementAbi,
      'setProtectedBptSettlementHook',
      [deployments.CurveYieldMevVolumeHookV14, false],
    );
    const storage = await publicClient.readContract({
      address: deployments.FeeSettlementRouter,
      abi: settlementAbi,
      functionName: 'feeConverterStorage',
    });
    const storageBefore = await Promise.all(
      poolTokens.map((token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [storage] })),
    );
    const fallbackBptBefore = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'totalBpt',
      args: [sourcePool],
    });
    await send('P4-CAND-001', wallets.outsider, deployments.FeeSettlementKeeper, keeperAbi, 'collect', [sourcePool]);
    const storageAfter = await Promise.all(
      poolTokens.map((token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [storage] })),
    );
    const fallbackBptAfter = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'totalBpt',
      args: [sourcePool],
    });
    assertion(
      'P4-CAND-001',
      'non-strict real dependency failure moves creator-PL tokens to feeConverterStorage',
      storageAfter.some((x, i) => x > storageBefore[i]),
      { storage, storageBefore, storageAfter },
    );
    assertion(
      'P4-CAND-001',
      'non-strict fallback does not falsely record creator permanent-liquidity BPT',
      fallbackBptAfter === fallbackBptBefore,
      { fallbackBptBefore, fallbackBptAfter },
    );

    // Strict rollback, disabled-keeper and arbitrary-router negative controls from the same accrued-fee state.
    await reload(preSettlementState);
    await daoCall(
      'P4-CAND-001',
      'disable protected hook for strict rollback',
      deployments.FeeSettlementRouter,
      settlementAbi,
      'setProtectedBptSettlementHook',
      [deployments.CurveYieldMevVolumeHookV14, false],
    );
    const strictBefore = await Promise.all(
      poolTokens.map((token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [actor.receiverX] })),
    );
    await expectRevert(
      'P4-CAND-001',
      'strict collection reverts when creator permanent-liquidity protected join is unavailable',
      wallets.outsider,
      deployments.FeeSettlementKeeper,
      keeperAbi,
      'collectPartnerPoL',
      [sourcePool],
    );
    const strictAfter = await Promise.all(
      poolTokens.map((token) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [actor.receiverX] })),
    );
    assertion(
      'P4-CAND-001',
      'strict failure rolls back creator payout',
      strictAfter.every((x, i) => x === strictBefore[i]),
      { strictBefore, strictAfter },
    );
    await expectRevert(
      'P4-CAND-001',
      'arbitrary public caller cannot call FeeSettlementRouter directly',
      wallets.outsider,
      deployments.FeeSettlementRouter,
      settlementAbi,
      'collect',
      [sourcePool],
    );
    await daoCall(
      'P4-CAND-001',
      'disable FeeSettlementKeeper authorization',
      deployments.FeeSettlementRouter,
      settlementAbi,
      'setKeeper',
      [deployments.FeeSettlementKeeper, false],
    );
    await expectRevert(
      'P4-CAND-001',
      'public keeper trigger fails while keeper contract is disabled',
      wallets.outsider,
      deployments.FeeSettlementKeeper,
      keeperAbi,
      'collect',
      [sourcePool],
    );

    // P4-CAND-002: authentic creator lots, actual registry rotation, real Balancer migrations.
    await reload(preSettlementState);
    const lotsBeforeFirst = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextLotId',
    });
    await send('P4-CAND-002', wallets.outsider, deployments.FeeSettlementKeeper, keeperAbi, 'collect', [sourcePool]);
    const lotsAfterFirst = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextLotId',
    });
    const firstCreatorLots = await findCreatorLots(lotsBeforeFirst, lotsAfterFirst, sourcePool);
    if (firstCreatorLots.length !== 1) throw new Error(`Expected one creator lot from first settlement, found ${firstCreatorLots.length}`);
    const lot1 = firstCreatorLots[0];
    assertion(
      'P4-CAND-002',
      'authentic pre-rotation creator lot snapshots A/X',
      lot1.lot[5].toLowerCase() === actor.creatorA.toLowerCase() && lot1.lot[6].toLowerCase() === actor.receiverX.toLowerCase(),
      { lotId: lot1.id, controller: lot1.lot[5], receiver: lot1.lot[6], remainingBpt: lot1.lot[3] },
    );

    for (let i = 0; i < 4; i++) {
      const [tokenIn, tokenOut] = i % 2 === 0 ? [poolTokens[0], poolTokens[1]] : [poolTokens[1], poolTokens[0]];
      await send(
        'P4-CAND-002',
        wallets.creatorA,
        deployments.Router,
        routerAbi,
        'swapSingleTokenExactIn',
        [sourcePool, tokenIn, tokenOut, parseEther('100'), 0n, 2n ** 64n, false, '0x'],
      );
    }
    const lotsBeforeSecond = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextLotId',
    });
    await send('P4-CAND-002', wallets.outsider, deployments.FeeSettlementKeeper, keeperAbi, 'collect', [sourcePool]);
    const lotsAfterSecond = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextLotId',
    });
    const secondCreatorLots = await findCreatorLots(lotsBeforeSecond, lotsAfterSecond, sourcePool);
    if (secondCreatorLots.length !== 1) throw new Error(`Expected one creator lot from second settlement, found ${secondCreatorLots.length}`);
    const lot2 = secondCreatorLots[0];

    await daoCall(
      'P4-CAND-002',
      'approve real target pool',
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'approveMigrationTarget',
      [targetPool, true],
    );

    const currentBlock = await publicClient.getBlock();
    const planFor = (lotId, sourceBptAmount) => ({
      lotId,
      targetPool,
      sourceBptAmount,
      sourceTokenSetHash: tokenSetHash(poolTokens),
      targetTokenSetHash: tokenSetHash(poolTokens),
      minSourceAmountsOut: [1n, 1n],
      swaps: [],
      minTargetBptOut: 1n,
      expiry: currentBlock.timestamp + 7200n,
    });

    // Request first migration before registry rotation, then rotate before approval/execution.
    const plan1 = planFor(lot1.id, lot1.lot[3]);
    const request1 = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextCreatorMigrationRequestId',
    });
    await send('P4-CAND-002', wallets.creatorA, deployments.PermanentLiquidityVaultV2, permanentVaultAbi, 'requestCreatorMigration', [plan1]);

    await daoCall(
      'P4-CAND-002',
      'rotate creator controller A to B',
      deployments.PoolFeePolicyRegistry,
      registryAbi,
      'requestCreatorControllerTransfer',
      [sourcePool, actor.controllerB],
    );
    await send('P4-CAND-002', wallets.controllerB, deployments.PoolFeePolicyRegistry, registryAbi, 'acceptCreatorControllerTransfer', [sourcePool]);
    await send('P4-CAND-002', wallets.controllerB, deployments.PoolFeePolicyRegistry, registryAbi, 'setCreatorPayoutReceiver', [sourcePool, actor.receiverY]);

    const [currentController, currentReceiver, currentEpoch] = await Promise.all([
      publicClient.readContract({ address: deployments.PoolFeePolicyRegistry, abi: registryAbi, functionName: 'creatorControllerOf', args: [sourcePool] }),
      publicClient.readContract({ address: deployments.PoolFeePolicyRegistry, abi: registryAbi, functionName: 'creatorPayoutReceiverOf', args: [sourcePool] }),
      publicClient.readContract({ address: deployments.PoolFeePolicyRegistry, abi: registryAbi, functionName: 'creatorControllerEpochOf', args: [sourcePool] }),
    ]);
    assertion(
      'P4-CAND-002',
      'actual registry rotation changes current controller and payout receiver',
      currentController.toLowerCase() === actor.controllerB.toLowerCase() &&
        currentReceiver.toLowerCase() === actor.receiverY.toLowerCase() &&
        currentEpoch > 0n,
      { currentController, currentReceiver, currentEpoch },
    );

    await daoCall(
      'P4-CAND-002',
      'approve request created before rotation',
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'approveCreatorMigration',
      [request1],
    );
    await expectRevert(
      'P4-CAND-002',
      'approved migration rejects modified plan hash',
      wallets.outsider,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'executeCreatorMigration',
      [request1, { ...plan1, minTargetBptOut: 2n }, []],
    );
    await send(
      'P4-CAND-002',
      wallets.outsider,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'executeCreatorMigration',
      [request1, plan1, []],
    );
    const lot1After = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'liquidityLots',
      args: [lot1.id],
    });
    const targetTotalAfterFull = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'totalBpt',
      args: [targetPool],
    });
    assertion(
      'P4-CAND-002',
      'full owner-approved real migration succeeds after registry rotation',
      lot1After[3] === 0n && targetTotalAfterFull > 0n,
      { sourceRemaining: lot1After[3], targetTotalAfterFull },
    );

    // Historical lot rights after rotation: current B/Y are not the stored A/X; stored A and X remain requesters.
    const plan2Amount = lot2.lot[3] / 2n;
    if (plan2Amount === 0n) throw new Error('Second creator lot too small for partial migration');
    const plan2 = planFor(lot2.id, plan2Amount);
    await expectRevert(
      'P4-CAND-002',
      'current registry controller B cannot request migration of historical A/X lot',
      wallets.controllerB,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'requestCreatorMigration',
      [plan2],
    );
    await expectRevert(
      'P4-CAND-002',
      'current registry receiver Y cannot request migration of historical A/X lot',
      wallets.receiverY,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'requestCreatorMigration',
      [plan2],
    );
    const request2 = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextCreatorMigrationRequestId',
    });
    await send('P4-CAND-002', wallets.receiverX, deployments.PermanentLiquidityVaultV2, permanentVaultAbi, 'requestCreatorMigration', [plan2]);
    await daoCall(
      'P4-CAND-002',
      'approve historical X-requested partial migration',
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'approveCreatorMigration',
      [request2],
    );
    await send(
      'P4-CAND-002',
      wallets.outsider,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'executeCreatorMigration',
      [request2, plan2, []],
    );
    const lot2After = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'liquidityLots',
      args: [lot2.id],
    });
    assertion(
      'P4-CAND-002',
      'partial migration preserves exact historical lot remainder',
      lot2After[3] === lot2.lot[3] - plan2Amount,
      { before: lot2.lot[3], migrated: plan2Amount, after: lot2After[3] },
    );

    const cancelPlan = planFor(lot2.id, lot2After[3]);
    const request3 = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextCreatorMigrationRequestId',
    });
    await send('P4-CAND-002', wallets.creatorA, deployments.PermanentLiquidityVaultV2, permanentVaultAbi, 'requestCreatorMigration', [cancelPlan]);
    await send('P4-CAND-002', wallets.creatorA, deployments.PermanentLiquidityVaultV2, permanentVaultAbi, 'cancelCreatorMigration', [request3]);
    await expectRevert(
      'P4-CAND-002',
      'cancelled creator migration cannot execute',
      wallets.outsider,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'executeCreatorMigration',
      [request3, cancelPlan, []],
    );
    await expectRevert(
      'P4-CAND-002',
      'expired creator migration plan is rejected',
      wallets.creatorA,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'requestCreatorMigration',
      [{ ...cancelPlan, expiry: currentBlock.timestamp - 1n }],
    );

    // Accrue and settle after rotation; new lot must snapshot B/Y.
    for (let i = 0; i < 4; i++) {
      const [tokenIn, tokenOut] = i % 2 === 0 ? [poolTokens[0], poolTokens[1]] : [poolTokens[1], poolTokens[0]];
      await send(
        'P4-CAND-002',
        wallets.creatorA,
        deployments.Router,
        routerAbi,
        'swapSingleTokenExactIn',
        [sourcePool, tokenIn, tokenOut, parseEther('100'), 0n, 2n ** 64n, false, '0x'],
      );
    }
    const newLotStart = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextLotId',
    });
    await send('P4-CAND-002', wallets.outsider, deployments.FeeSettlementKeeper, keeperAbi, 'collect', [sourcePool]);
    const newLotEnd = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextLotId',
    });
    const newCreatorLots = await findCreatorLots(newLotStart, newLotEnd, sourcePool);
    if (newCreatorLots.length !== 1) throw new Error(`Expected one post-rotation creator lot, found ${newCreatorLots.length}`);
    const lot3 = newCreatorLots[0];
    assertion(
      'P4-CAND-002',
      'new post-rotation creator lot snapshots B/Y',
      lot3.lot[5].toLowerCase() === actor.controllerB.toLowerCase() &&
        lot3.lot[6].toLowerCase() === actor.receiverY.toLowerCase(),
      { lotId: lot3.id, controller: lot3.lot[5], receiver: lot3.lot[6], remainingBpt: lot3.lot[3] },
    );

    const plan3 = planFor(lot3.id, lot3.lot[3]);
    await expectRevert(
      'P4-CAND-002',
      'old controller A cannot request migration of new B/Y lot',
      wallets.creatorA,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'requestCreatorMigration',
      [plan3],
    );
    const request4 = await publicClient.readContract({
      address: deployments.PermanentLiquidityVaultV2,
      abi: permanentVaultAbi,
      functionName: 'nextCreatorMigrationRequestId',
    });
    await send('P4-CAND-002', wallets.controllerB, deployments.PermanentLiquidityVaultV2, permanentVaultAbi, 'requestCreatorMigration', [plan3]);
    await daoCall(
      'P4-CAND-002',
      'approve post-rotation B-requested migration',
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'approveCreatorMigration',
      [request4],
    );
    await daoCall(
      'P4-CAND-002',
      'revoke target before approved plan executes',
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'approveMigrationTarget',
      [targetPool, false],
    );
    await expectRevert(
      'P4-CAND-002',
      'approved migration rejects route/target policy drift before execution',
      wallets.outsider,
      deployments.PermanentLiquidityVaultV2,
      permanentVaultAbi,
      'executeCreatorMigration',
      [request4, plan3, []],
    );

    result.completedAt = new Date().toISOString();
    result.summary = {
      assertions: result.assertions.length,
      failedAssertions: result.assertions.filter((row) => !row.ok).length,
      executedCalls: Object.fromEntries(Object.entries(result.candidates).map(([id, row]) => [id, row.executedCalls])),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(asJson(result), null, 2) + '\n');
    if (result.summary.failedAssertions > 0) process.exitCode = 2;
  } finally {
    anvil.kill();
  }
}

main().catch((error) => {
  result.completedAt = new Date().toISOString();
  result.fatalError = String(error?.stack || error);
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(asJson(result), null, 2) + '\n');
  } catch {}
  console.error(error);
  process.exitCode = 1;
});
