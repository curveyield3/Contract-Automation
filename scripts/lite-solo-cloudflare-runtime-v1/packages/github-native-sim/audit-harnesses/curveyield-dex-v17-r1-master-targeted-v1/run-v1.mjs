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
// Capture the *exact JSON-RPC method* rejected by Anvil or its fork upstream.
 // No request parameters, private keys or token-bearing upstream URL are logged.
const transport = (options) => {
  const native = http(rpcUrl, { timeout: 120_000 })(options);
  return {
    ...native,
    async request(...args) {
      const method = args[0]?.method || 'unknown';
      try {
        return await native.request(...args);
      } catch (error) {
        console.error('TARGETED_RPC_REJECTION', JSON.stringify({
          method,
          code: error?.code ?? null,
          name: error?.name ?? 'Error',
          message: String(error?.shortMessage || error?.message || error).slice(0, 1800),
        }));
        throw error;
      }
    },
  };
};
const publicClient = createPublicClient({ chain, transport });
const testClient = createTestClient({ chain, mode: 'anvil', transport });

const actor = {
  deployer: report.deployer,
  creatorA: '0x1000000000000000000000000000000000000001',
  receiverX: '0x1000000000000000000000000000000000000002',
  controllerB: '0x1000000000000000000000000000000000000003',
  receiverY: '0x1000000000000000000000000000000000000004',
  outsider: '0x1000000000000000000000000000000000000005',
  creatorPartner: '0x1000000000000000000000000000000000000006',
  adminPartner: '0x1000000000000000000000000000000000000007',
};
const wallets = {};

const result = {
  schemaVersion: 'curveyield-dex-master-targeted-integration-v1',
  sourceArchiveSha256: 'bd0fc0a955c585ea0357feecb3d16caf9f48dd9ca5073a6a18948eab7c0f5e55',
  sourceCommit: 'a8f2ed830d1e318a04e7cecd6baebc1762a12142',
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
  rawReceipts: [],
  scenarioMeasurements: [],
  sourcePlanPath: 'campaigns/CurveYield DEX v17 Source r1/work/master-review/reviewer-1-phase-01/TARGETED_TEST_REQUEST_v1.json',
  requestId: '44e89fe5127c82a185b56dce4c86a78ee8cc06c0029d1223feec9ced4db4c26f',
  assertions: [],
  candidates: {
    'P1-FEE-CREATOR-PARTNER-001': { executedCalls: 0 },
    'P1-FEE-ADMIN-PARTNER-002': { executedCalls: 0 },
    'P1-SWAP-MINOUT-003': { executedCalls: 0 },
    'P1-MIGRATION-CANCELLATION-004': { executedCalls: 0 },
    'P1-MIGRATION-APPROVAL-REPLAY-005': { executedCalls: 0 },
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
  'function creatorFeeSplitterOf(address pool) view returns(address)',
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
  'function updateCreatorFeeConfig(address pool,(uint16 creatorPersonalBps,uint16 creatorPermanentLiquidityBps,uint16 creatorPartnerRevenueBps))',
  'function updateAdminFeeConfig(address pool,(uint16 adminCreatorPermanentLiquidityBps,uint16 adminExtraPermanentPoLBps,uint16 adminPartnerRevenueBps))',
  'function adminSetCreatorPartnerRevenueReceiver(address pool,address receiver)',
  'function adminSetAdminPartnerRevenueReceiver(address pool,address receiver)',
  'function requestCreatorControllerTransfer(address pool,address newController)',
  'function acceptCreatorControllerTransfer(address pool)',
  'function setCreatorPayoutReceiver(address pool,address newReceiver)',
  'function creatorControllerOf(address pool) view returns (address)',
  'function creatorPayoutReceiverOf(address pool) view returns (address)',
  'function creatorControllerEpochOf(address pool) view returns (uint64)',
]);
const permanentVaultAbi = parseAbi([
  'function creatorMigrationRequests(uint256) view returns(uint256 lotId,address requester,bytes32 planHash,bool approved,bool executed,bool cancelled)',
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
const creatorSplitterAbi=parseAbi(['function quoteCreatorAllocation(uint256[] feeAmounts) view returns(uint256[] creatorPayout,uint256[] adminCut,uint256[] permanentLiquidity,uint256[] partnerPayout,uint256[] partnerAdminCut)']);
const adminSplitterAbi=parseAbi(['function quoteAdminAllocation(address pool,uint256[] protocolFeeAmounts) view returns(uint256[] adminCreatorPermanentLiquidity,uint256[] adminExtraPermanentPoL,uint256[] partnerRevenue,uint256[] treasury)']);
const adapterAbi=parseAbi(['function quote(address tokenIn,address tokenOut,uint256 amountIn,bytes routeData) returns(uint256 amountOut)','function swap(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,bytes routeData) returns(uint256 amountOut)','function setAuthorizedCaller(address,bool)','function isAuthorizedCaller(address) view returns(bool)']);
const ownerTokenAbi = parseAbi([
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
]);

const asJson = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

function assertion(candidateId, label, ok, detail = null, classification = 'control') {
  result.assertions.push({ candidateId, label, ok, detail: asJson(detail), classification });
  console.log(`${classification === 'candidate-observation' ? 'OBSERVED' : (ok ? 'PASS' : 'FAIL')} [${candidateId}] ${label}${detail === null ? '' : ' :: ' + JSON.stringify(asJson(detail))}`);
}

// Candidate observations are confirmed/disproven by the master, not health-check failures.
const candidateObservation = (id, label, observed, detail = null) => assertion(id, label, observed, detail, 'candidate-observation');

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
  result.rawReceipts.push({candidateId,transaction:asJson(await publicClient.getTransaction({hash})),receipt:asJson(receipt)});
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


async function observedTx(candidateId,label,wallet,address,abi,functionName,callArgs=[],expectSuccess=true,isCandidateObservation=false){
  try{
    const hash=await wallet.writeContract({address,abi,functionName,args:callArgs,gas:8_000_000n,chain,account:wallet.account});
    const receipt=await publicClient.waitForTransactionReceipt({hash});
    const tx=await publicClient.getTransaction({hash});
    const row={candidateId,label,from:wallet.account,to:address,functionName,args:asJson(callArgs),hash,status:receipt.status,gasUsed:String(receipt.gasUsed),calldata:tx.input,blockNumber:String(receipt.blockNumber)};
    result.calls.push(row);result.rawReceipts.push({candidateId,label,transaction:asJson(tx),receipt:asJson(receipt)});
    result.candidates[candidateId].executedCalls++;
    (isCandidateObservation ? candidateObservation : assertion)(candidateId,label,expectSuccess?receipt.status==='success':receipt.status==='reverted',row);
    return row;
  } catch(e) {
    const error=String(e?.stack||e);
    result.calls.push({candidateId,label,kind:'submission-error',from:wallet.account,to:address,functionName,args:asJson(callArgs),error});
    assertion(candidateId,label+' transaction-submission',false,error.slice(0,1200));
    return {status:'SUBMISSION_ERROR',error};
  }
}
const readAt=(address,abi,functionName,args=[])=>publicClient.readContract({address,abi,functionName,args});
const balances=async(tokens,addresses)=>{
 const out={};for(const [label,address] of Object.entries(addresses)){out[label]={};for(const token of tokens)out[label][token]=String(await readAt(token,erc20Abi,'balanceOf',[address]));}
 return out;
};
async function daoObserved(candidateId,label,to,abi,functionName,callArgs=[],expectSuccess=false,isCandidateObservation=false){
 const data=encodeFunctionData({abi,functionName,args:callArgs});
 return observedTx(candidateId,label,wallets.deployer,report.aragon.adminPlugin,adminPluginAbi,
 'executeProposal',[stringToHex(label),[{to,value:0n,data}],0n],expectSuccess,isCandidateObservation);
}
async function main() {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const anvilLogPath = path.join(path.dirname(outputPath), 'TARGETED_ANVIL_v1.log');
  const anvilLogHandle = fs.openSync(anvilLogPath, 'a');
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
    { stdio: ['ignore', anvilLogHandle, anvilLogHandle] },
  );
  fs.closeSync(anvilLogHandle);

  try {
    await waitForRpc();
    const rawState = fs.readFileSync(statePath, 'utf8').trim();
    if (!/^0x(?:[a-f0-9]{2})+$/i.test(rawState)) throw new Error('Handed-off Anvil state is not valid even-length hex data');
    console.log('TARGETED_STATE_RESTORE_BEGIN', JSON.stringify({ hexLength: rawState.length }));
    await testClient.loadState({ state: rawState });
    console.log('TARGETED_STATE_RESTORE_COMPLETE');
    await impersonateAll();
    const observedChainId = await publicClient.getChainId();
    if (observedChainId !== 747474) throw new Error(`Expected Katana chain 747474, got ${observedChainId}`);

    // Create real Balancer pools using exact source wrapper and simple exact-source test ERC20s.
    const { compiled } = compileContracts(
      ['tooling/test/contracts/CurveYieldDexAuditMocks.sol', 'contracts/CurveYieldPoolFactoryWrapper.sol'],
      ['MockDexERC20', 'CurveYieldPoolFactoryWrapper'],
    );
    const tokenA = await deploy('P1-FEE-CREATOR-PARTNER-001', wallets.deployer, compiled.MockDexERC20, ['Master Test A', 'MTA']);
    const tokenB = await deploy('P1-FEE-CREATOR-PARTNER-001', wallets.deployer, compiled.MockDexERC20, ['Master Test B', 'MTB']);
    const poolTokens = [tokenA.address, tokenB.address].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    result.addresses.tokens = poolTokens;

    for (const token of poolTokens) {
      await send('P1-FEE-CREATOR-PARTNER-001', wallets.deployer, token, erc20Abi, 'mint', [actor.creatorA, parseEther('1000000')]);
      await send('P1-FEE-CREATOR-PARTNER-001', wallets.creatorA, token, erc20Abi, 'approve', [report.permit2, maxUint256]);
      await send('P1-FEE-CREATOR-PARTNER-001', wallets.creatorA, report.permit2, permit2Abi, 'approve', [token, deployments.Router, maxUint160, 2n ** 48n - 1n]);
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
        'P1-FEE-CREATOR-PARTNER-001',
        wallets.creatorA,
        wrapper.address,
        wrapper.abi,
        'createWeightedPool',
        [input, policy],
        creationFee,
      );
      const code = await publicClient.getCode({ address: expectedPool });
      assertion('P1-FEE-CREATOR-PARTNER-001', `${label} real weighted pool created`, Boolean(code && code !== '0x'), expectedPool);
      return expectedPool;
    }

    const sourcePool = await createWeighted('Master Source', '91', 5_000);
    const targetPool = await createWeighted('Master Target', '92', 0);
    result.addresses.sourcePool = sourcePool;
    result.addresses.targetPool = targetPool;

    for (const pool of [sourcePool, targetPool]) {
      await send(
        'P1-FEE-CREATOR-PARTNER-001',
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
        'P1-FEE-CREATOR-PARTNER-001',
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
        'P1-FEE-CREATOR-PARTNER-001',
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
      'P1-FEE-CREATOR-PARTNER-001',
      'real swaps accrued protocol fees',
      protocolAccrued.some((x) => x > 0n),
      protocolAccrued,
    );
    assertion(
      'P1-FEE-CREATOR-PARTNER-001',
      'real swaps accrued creator fees needed for creator permanent-liquidity branch',
      creatorAccrued.some((x) => x > 0n),
      creatorAccrued,
    );

    const preSettlementState = await testClient.dumpState();
    const creatorId='P1-FEE-CREATOR-PARTNER-001',adminId='P1-FEE-ADMIN-PARTNER-002',swapId='P1-SWAP-MINOUT-003',cancelId='P1-MIGRATION-CANCELLATION-004',replayId='P1-MIGRATION-APPROVAL-REPLAY-005';
    const registry=deployments.PoolFeePolicyRegistry;
    const pv=deployments.PermanentLiquidityVaultV2;
    const splitter=await readAt(deployments.FeeSettlementRouter,settlementAbi,'creatorFeeSplitterOf',[sourcePool]);
    result.addresses.creatorSplitter=splitter;
    assertion(creatorId,'source-created authentic splitter',Boolean(await publicClient.getCode({address:splitter})),splitter);
    const accruedCreator=creatorAccrued.map(BigInt),accruedAdmin=protocolAccrued.map(BigInt);
    const creatorScenarios=[
      {label:'personal-only-no-partner',personal:2000,permanent:0,partner:0,receiver:zeroAddress,expected:'REVERT'},
      {label:'permanent-only-healthy',personal:0,permanent:7000,partner:0,receiver:zeroAddress,expected:'SUCCESS'},
      {label:'equal-personal-and-partner',personal:1000,permanent:0,partner:1000,receiver:actor.creatorPartner,expected:'SUCCESS'},
      {label:'partner-only',personal:0,permanent:0,partner:2000,receiver:actor.creatorPartner,expected:'SUCCESS'},
    ];
    for(const config of creatorScenarios){
      await reload(preSettlementState);
      if(config.receiver!==zeroAddress)await daoCall(creatorId,config.label+' set receiver',registry,registryAbi,'adminSetCreatorPartnerRevenueReceiver',[sourcePool,config.receiver]);
      await daoCall(creatorId,config.label+' update policy',registry,registryAbi,'updateCreatorFeeConfig',[sourcePool,{creatorPersonalBps:config.personal,creatorPermanentLiquidityBps:config.permanent,creatorPartnerRevenueBps:config.partner}]);
      const q=await readAt(splitter,creatorSplitterAbi,'quoteCreatorAllocation',[accruedCreator]);
      const rows=accruedCreator.map((fee,i)=>({token:poolTokens[i],fee:String(fee),personal:String(q[0][i]),adminCut:String(q[1][i]),permanent:String(q[2][i]),partner:String(q[3][i]),partnerAdminCut:String(q[4][i]),sum:String(q.reduce((s,col)=>s+col[i],0n))}));
      result.scenarioMeasurements.push({candidateId:creatorId,scenario:config.label,registryConfig:config,quotes:rows});
      if(config.label==='personal-only-no-partner'){
        candidateObservation(creatorId,'zero partner BPS quotes positive partner payout against real accrued creator fees',rows.some(x=>BigInt(x.partner)+BigInt(x.partnerAdminCut)>0n),rows);
        candidateObservation(creatorId,'personal-only quote breaches collected creator fees',rows.some(x=>BigInt(x.sum)>BigInt(x.fee)),rows);
      }else if(config.label==='partner-only'){
        candidateObservation(creatorId,'partner-only configured positive BPS returns zero partner fees (candidate)',rows.every(x=>BigInt(x.partner)+BigInt(x.partnerAdminCut)===0n),rows);
      }else{
        assertion(creatorId,config.label+' quoted splits do not exceed creator fees',rows.every(x=>BigInt(x.sum)<=BigInt(x.fee)),rows);
      }
      const pre=await balances(poolTokens,{creator:actor.receiverX,partner:actor.creatorPartner,treasury:report.treasuryReceiver||report.treasury||actor.deployer,router:deployments.FeeSettlementRouter,permanentVault:pv});
      const settled=await observedTx(creatorId,config.label+' actual fee collection',wallets.outsider,deployments.FeeSettlementKeeper,keeperAbi,'collect',[sourcePool],config.expected==='SUCCESS',config.label==='personal-only-no-partner');
      const post=await balances(poolTokens,{creator:actor.receiverX,partner:actor.creatorPartner,treasury:report.treasuryReceiver||report.treasury||actor.deployer,router:deployments.FeeSettlementRouter,permanentVault:pv});
      result.scenarioMeasurements.push({candidateId:creatorId,scenario:config.label,settled,balancesBefore:pre,balancesAfter:post});
    }

    // Admin quote and settlement with live protocol fees, creator permanent-only policy as non-interfering control.
    for(const cfg of [{label:'partner-zero-healthy',partner:0,expected:'SUCCESS'},{label:'partner-10pct-overallocated',partner:1000,expected:'REVERT'}]){
      await reload(preSettlementState);
      await daoCall(adminId,cfg.label+' creator policy control',registry,registryAbi,'updateCreatorFeeConfig',[sourcePool,{creatorPersonalBps:0,creatorPermanentLiquidityBps:7000,creatorPartnerRevenueBps:0}]);
      await daoCall(adminId,cfg.label+' receiver',registry,registryAbi,'adminSetAdminPartnerRevenueReceiver',[sourcePool,actor.adminPartner]);
      await daoCall(adminId,cfg.label+' config',registry,registryAbi,'updateAdminFeeConfig',[sourcePool,{adminCreatorPermanentLiquidityBps:0,adminExtraPermanentPoLBps:0,adminPartnerRevenueBps:cfg.partner}]);
      const q=await readAt(deployments.AdminFeeSplitter,adminSplitterAbi,'quoteAdminAllocation',[sourcePool,accruedAdmin]);
      const rows=accruedAdmin.map((fee,i)=>({token:poolTokens[i],fee:String(fee),creator:String(q[0][i]),extra:String(q[1][i]),partner:String(q[2][i]),treasury:String(q[3][i]),sum:String(q.reduce((s,col)=>s+col[i],0n))}));
      result.scenarioMeasurements.push({candidateId:adminId,scenario:cfg.label,quotes:rows});
      (cfg.partner>0 ? candidateObservation : assertion)(adminId,cfg.partner>0?'admin 10% partner plus 100% treasury exceeds real protocol fees':'zero-partner baseline is conserved',
        cfg.partner>0?rows.some(x=>BigInt(x.sum)>BigInt(x.fee)):rows.every(x=>BigInt(x.sum)<=BigInt(x.fee)),rows);
      const pre=await balances(poolTokens,{partner:actor.adminPartner,router:deployments.FeeSettlementRouter,permanentVault:pv});
      const settled=await observedTx(adminId,cfg.label+' authentic fee collection',wallets.outsider,deployments.FeeSettlementKeeper,keeperAbi,'collect',[sourcePool],cfg.expected==='SUCCESS',cfg.partner>0);
      const post=await balances(poolTokens,{partner:actor.adminPartner,router:deployments.FeeSettlementRouter,permanentVault:pv});
      result.scenarioMeasurements.push({candidateId:adminId,scenario:cfg.label,settled,balancesBefore:pre,balancesAfter:post});
    }

    // Direct adapter on a real initialized weighted Balancer pool, production default authorization and DAO modification.
    await reload(preSettlementState);
    const adapter=deployments.BalancerV3SwapAdapter;
    const amountIn=parseEther('5');
    const swapRoute=encodeAbiParameters([{type:'address'},{type:'bool'},{type:'bytes'}],[sourcePool,false,'0x']);
    await observedTx(swapId,'unauthorized outsider adapter swap rejected',wallets.outsider,adapter,adapterAbi,'swap',[poolTokens[0],poolTokens[1],amountIn,1n,swapRoute],false);
    const defaultVaultAuthorized=await readAt(adapter,adapterAbi,'isAuthorizedCaller',[pv]);
    const defaultOutsiderAuthorized=await readAt(adapter,adapterAbi,'isAuthorizedCaller',[actor.outsider]);
    assertion(swapId,'production vault authorized, ordinary actor not authorized',defaultVaultAuthorized&&!defaultOutsiderAuthorized,{defaultVaultAuthorized,defaultOutsiderAuthorized});
    await daoCall(swapId,'DAO grants explicit adapter authorization to controlled executor',adapter,adapterAbi,'setAuthorizedCaller',[actor.creatorA,true]);
    await send(swapId,wallets.deployer,poolTokens[0],erc20Abi,'mint',[adapter,amountIn]);
    try {
      const quote=await publicClient.simulateContract({address:adapter,abi:adapterAbi,functionName:'quote',args:[poolTokens[0],poolTokens[1],amountIn,swapRoute],account:actor.creatorA});
      const expected=BigInt(quote.result);
      const requestedMin=expected*12n/10n+1n;
      const receiverBefore=await readAt(poolTokens[1],erc20Abi,'balanceOf',[actor.creatorA]);
      const tx=await observedTx(swapId,'DAO-authorized adapter performs real under-minimum swap',wallets.creatorA,adapter,adapterAbi,'swap',[poolTokens[0],poolTokens[1],amountIn,requestedMin,swapRoute],true,true);
      const receiverAfter=await readAt(poolTokens[1],erc20Abi,'balanceOf',[actor.creatorA]);
      const actual=receiverAfter-receiverBefore;
      result.scenarioMeasurements.push({candidateId:swapId,scenario:'DAO-authorized-adapter',amountIn:String(amountIn),quote:String(expected),requestedMinimum:String(requestedMin),recipientActualOut:String(actual),tx});
      candidateObservation(swapId,'direct authorized adapter recipient received less than requested minimum (interface deviation)',tx.status==='success'&&actual<requestedMin&&actual>0n,{requestedMin,actual});
      const permitAllowance=await readAt(report.permit2,permit2Abi,'allowance',[adapter,poolTokens[0],deployments.Router]);
      assertion(swapId,'adapter clears Permit2 allowance after successful real swap',permitAllowance[0]===0n,{permitAllowance});
    } catch(e) {
      result.scenarioMeasurements.push({candidateId:swapId,scenario:'direct-real-Balancer-adapter',error:String(e?.stack||e)});
      assertion(swapId,'real direct adapter adverse swap completed',false,String(e).slice(0,800));
    }
    // Vault has an independent recipient balance-delta check, but the multi-pool adverse migration must execute for full semantic exclusion.
    result.scenarioMeasurements.push({candidateId:swapId,scenario:'outer-vault-post-swap-minimum',sourceOnlyObservation:'_executeSwap validates actualAmountOut >= swapPlan.minAmountOut at PermanentLiquidityVaultV2.sol lines 464-473; a real adverse migration trace is separately required to establish complete reachability coverage.'});

    // Authentically collected creator-origin BPT provides migration substrate; no direct mock lot recording.
    await reload(preSettlementState);
    await daoCall(cancelId,'enable creator permanent-only fee policy',registry,registryAbi,'updateCreatorFeeConfig',[sourcePool,{creatorPersonalBps:0,creatorPermanentLiquidityBps:7000,creatorPartnerRevenueBps:0}]);
    const lotStart=await readAt(pv,permanentVaultAbi,'nextLotId');
    await send(cancelId,wallets.outsider,deployments.FeeSettlementKeeper,keeperAbi,'collect',[sourcePool]);
    const lotEnd=await readAt(pv,permanentVaultAbi,'nextLotId');
    const lots=await findCreatorLots(lotStart,lotEnd,sourcePool);
    if(lots.length===0)throw new Error('Real fee settlement yielded no creator BPT lot: cannot infer migration behavior');
    const lot=lots[0];
    await daoCall(cancelId,'authorize real migration target',pv,permanentVaultAbi,'approveMigrationTarget',[targetPool,true]);
    const block=await publicClient.getBlock();
    const planFor=(lotId,q,expires=block.timestamp+10800n)=>({lotId,targetPool,sourceBptAmount:q,
      sourceTokenSetHash:tokenSetHash(poolTokens),targetTokenSetHash:tokenSetHash(poolTokens),
      minSourceAmountsOut:[1n,1n],swaps:[],minTargetBptOut:1n,expiry:expires});
    const qCancel=lot.lot[3]/5n;
    if(qCancel===0n)throw Error('Creator-origin BPT lot too small');
    const cancelPlan=planFor(lot.id,qCancel);
    const cancelRequest=await readAt(pv,permanentVaultAbi,'nextCreatorMigrationRequestId');
    await send(cancelId,wallets.creatorA,pv,permanentVaultAbi,'requestCreatorMigration',[cancelPlan]);
    await daoCall(cancelId,'DAO approves creator request once',pv,permanentVaultAbi,'approveCreatorMigration',[cancelRequest]);
    const requestBefore=await readAt(pv,permanentVaultAbi,'creatorMigrationRequests',[cancelRequest]);
    const creatorCancel=await observedTx(cancelId,'distinct original creator cancellation attempt reverts',wallets.creatorA,pv,permanentVaultAbi,'cancelCreatorMigration',[cancelRequest],false,true);
    const daoCancel=await daoObserved(cancelId,'distinct DAO owner cancellation attempt reverts',pv,permanentVaultAbi,'cancelCreatorMigration',[cancelRequest],false,true);
    const outsiderCancel=await observedTx(cancelId,'unrelated address cancellation rejected',wallets.outsider,pv,permanentVaultAbi,'cancelCreatorMigration',[cancelRequest],false);
    const requestAfter=await readAt(pv,permanentVaultAbi,'creatorMigrationRequests',[cancelRequest]);
    candidateObservation(cancelId,'failed creator and DAO cancellation leaves approved request uncancelled',!requestAfter[5]&&requestBefore[5]===requestAfter[5],{requestBefore,requestAfter,creatorCancel,daoCancel,outsiderCancel});
    const lotBeforeCancelExecution=await readAt(pv,permanentVaultAbi,'liquidityLots',[lot.id]);
    const executedAfterCancel=await observedTx(cancelId,'approved migration executes despite both failed cancellation attempts',wallets.outsider,pv,permanentVaultAbi,'executeCreatorMigration',[cancelRequest,cancelPlan,[]],true,true);
    const lotAfterCancelExecution=await readAt(pv,permanentVaultAbi,'liquidityLots',[lot.id]);
    candidateObservation(cancelId,'cancellation control failure causes real source BPT migration',executedAfterCancel.status==='success'&&lotAfterCancelExecution[3]===lotBeforeCancelExecution[3]-qCancel,{lotBeforeCancelExecution,lotAfterCancelExecution,qCancel});
    result.scenarioMeasurements.push({candidateId:cancelId,lotId:String(lot.id),requestId:String(cancelRequest),approvedAndCancelledState:asJson(requestAfter),qCancel:String(qCancel),owner:report.dao,requester:actor.creatorA,executeResult:executedAfterCancel});

    // Replay: fresh single DAO approval, remaining authentic BPT >= 3*q; execute same plan and requestId repeatedly.
    const remaining=lotAfterCancelExecution[3];
    const qReplay=remaining/4n;
    if(qReplay===0n)throw Error('Creator-origin BPT remainder insufficient for replay');
    const replayPlan=planFor(lot.id,qReplay);
    const replayRequest=await readAt(pv,permanentVaultAbi,'nextCreatorMigrationRequestId');
    await send(replayId,wallets.creatorA,pv,permanentVaultAbi,'requestCreatorMigration',[replayPlan]);
    await observedTx(replayId,'unapproved request cannot migrate',wallets.outsider,pv,permanentVaultAbi,'executeCreatorMigration',[replayRequest,replayPlan,[]],false);
    await daoCall(replayId,'single DAO authorization',pv,permanentVaultAbi,'approveCreatorMigration',[replayRequest]);
    await observedTx(replayId,'different plan hash rejected',wallets.outsider,pv,permanentVaultAbi,'executeCreatorMigration',[replayRequest,{...replayPlan,minTargetBptOut:2n},[]],false);
    const replaySnapshots=[];
    for(let n=1;n<=3;n++){
      const before=await readAt(pv,permanentVaultAbi,'liquidityLots',[lot.id]);
      const targetBefore=await readAt(pv,permanentVaultAbi,'totalBpt',[targetPool]);
      const r=await observedTx(replayId,'same approved request execution number '+n,wallets.outsider,pv,permanentVaultAbi,'executeCreatorMigration',[replayRequest,replayPlan,[]],true,n>1);
      const after=await readAt(pv,permanentVaultAbi,'liquidityLots',[lot.id]);
      const targetAfter=await readAt(pv,permanentVaultAbi,'totalBpt',[targetPool]);
      replaySnapshots.push({iteration:n,before:String(before[3]),after:String(after[3]),targetBefore:String(targetBefore),targetAfter:String(targetAfter),result:r});
      if(r.status!=='success')break;
    }
    const state=await readAt(pv,permanentVaultAbi,'creatorMigrationRequests',[replayRequest]);
    result.scenarioMeasurements.push({candidateId:replayId,requestId:String(replayRequest),sourceLot:String(lot.id),authorizedAmount:String(qReplay),executionCount:replaySnapshots.filter(x=>x.result.status==='success').length,snapshots:replaySnapshots,requestState:asJson(state)});
    candidateObservation(replayId,'single approved request replayed and source BPT spent at least twice',
      replaySnapshots.length>=2&&replaySnapshots[0].result.status==='success'&&replaySnapshots[1].result.status==='success'&&BigInt(replaySnapshots[1].before)-BigInt(replaySnapshots[1].after)===qReplay,{replaySnapshots,executedFlag:state[4]});
    // Expired-plan control is a raw on-chain rejection, not hypothetical property.
    await testClient.increaseTime({seconds:12000});await testClient.mine({blocks:1});
    await observedTx(replayId,'expired original migration plan cannot execute again',wallets.outsider,pv,permanentVaultAbi,'executeCreatorMigration',[replayRequest,replayPlan,[]],false);

    result.completedAt = new Date().toISOString();
    result.summary = {
      assertions: result.assertions.length,
      failedAssertions: result.assertions.filter((row) => !row.ok && row.classification !== 'candidate-observation').length,
      candidateObservations: result.assertions.filter((row) => row.classification === 'candidate-observation').length,
      measurementCount: result.scenarioMeasurements.length,
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
