// Katana cyvbUSDC Morpho venue configuration v2.
// Grant the specific Morpho Blue market as a *lending supply* venue.
// Preserves existing venues and withdrawal paths; appends target as final automatic withdrawal fallback.
// The PlasmaVault user withdraw/redeem is atomic; the two independent governance writes are not.
import { appendFile } from "node:fs/promises";
import {
  AbiCoder,
  Contract,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  getAddress,
  keccak256,
  ZeroHash,
} from "ethers";

const CHAIN_ID = 747474n;
const VAULT = getAddress("0xdf9cbcb8b57a031e91cae673a6a5786d85ce2ec5");
const VBUSDC = getAddress("0x203a662b0bd271a6ed5a60edfbd04bfce608fd36");
const MORPHO = getAddress("0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc");
const SUPPLY_FUSE = getAddress("0xc66c3f5cc5e1550a0ff960c06d630a2fbb80e19d");
const BALANCE_FUSE = getAddress("0x83790d83c23461cd22429276406c4f09db885a85");
const IPOR_MARKET_ID = 14n;
const BLUE_MARKET = "0xcfac40b9f06194a33d9526f73642f6849b908c2b6d8669ad9d2d4a3e7dcb017a";
const FUSE_MANAGER_ROLE = 300n;
const CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE = 900n;
const MODE = process.env.MODE || "inspect";
const CONFIRMATION = "ENABLE_VBUSDC_YVAUSD_INSTANT";

const vaultAbi = [
  "function asset() view returns (address)",
  "function getAccessManagerAddress() view returns (address)",
  "function isFuseSupported(address) view returns (bool)",
  "function isBalanceFuseSupported(uint256,address) view returns (bool)",
  "function getMarketSubstrates(uint256) view returns (bytes32[])",
  "function isMarketSubstrateGranted(uint256,bytes32) view returns (bool)",
  "function getInstantWithdrawalFuses() view returns (address[])",
  "function getInstantWithdrawalFusesParams(address,uint256) view returns (bytes32[])",
  "function configureInstantWithdrawalFuses((address fuse,bytes32[] params)[])",
  "function grantMarketSubstrates(uint256,bytes32[])",
];
const fuseAbi = [
  "function MARKET_ID() view returns (uint256)",
  "function MORPHO() view returns (address)",
];
const morphoAbi = [
  "function idToMarketParams(bytes32) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)",
];
const accessAbi = [
  "function getTargetFunctionRole(address,bytes4) view returns (uint64)",
  "function hasRole(uint64,address) view returns (bool,uint32)",
  "function canCall(address,address,bytes4) view returns (bool,uint32)",
];

function assert(ok, why) {
  if (!ok) throw new Error(why);
}
function same(a, b) {
  return getAddress(a) === getAddress(b);
}
function exactArray(a, b) {
  return a.length === b.length && a.every((value, index) => value.toLowerCase() === b[index].toLowerCase());
}
async function checkCode(provider, address, label) {
  assert((await provider.getCode(address)) !== "0x", `${label} has no contract code at ${address}`);
}
const summary = [];
function report(line) {
  console.log(line);
  summary.push(line);
}
async function main() {
  assert(["inspect", "apply"].includes(MODE), "MODE must be inspect or apply");
  const key = process.env.DEPLOYER_FX;
  assert(key && /^(0x)?[0-9a-fA-F]{64}$/.test(key), "DEPLOYER_FX must be a 32-byte hexadecimal private key");
  const provider = new JsonRpcProvider(process.env.KATANA_RPC_URL || "https://rpc.katana.network/", undefined, { staticNetwork: false });
  const network = await provider.getNetwork();
  assert(network.chainId === CHAIN_ID, `Wrong chain: expected ${CHAIN_ID}, got ${network.chainId}`);
  const signer = new Wallet(key.startsWith("0x") ? key : `0x${key}`, provider);
  const vault = new Contract(VAULT, vaultAbi, provider);

  await checkCode(provider, VAULT, "Vault");
  await checkCode(provider, MORPHO, "Morpho");
  await checkCode(provider, SUPPLY_FUSE, "Supply fuse");
  await checkCode(provider, BALANCE_FUSE, "Balance fuse");

  const underlying = await vault.asset();
  assert(same(underlying, VBUSDC), `Vault asset ${underlying} is not expected vbUSDC ${VBUSDC}`);

  const morpho = new Contract(MORPHO, morphoAbi, provider);
  const params = await morpho.idToMarketParams(BLUE_MARKET);
  assert(same(params.loanToken, VBUSDC), `Morpho market loanToken ${params.loanToken} is not vbUSDC`);
  assert(!same(params.collateralToken, "0x0000000000000000000000000000000000000000"), "Morpho collateral is zero");
  const recomputed = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "uint256"],
    [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
  ));
  assert(recomputed.toLowerCase() === BLUE_MARKET, "Morpho market ID differs from canonical market params");

  const fuse = new Contract(SUPPLY_FUSE, fuseAbi, provider);
  const balanceFuse = new Contract(BALANCE_FUSE, fuseAbi, provider);
  const [supplyMarketId, balanceMarketId, fuseMorpho, balanceMorpho, supplyInstalled, balanceInstalled] =
    await Promise.all([
      fuse.MARKET_ID(),
      balanceFuse.MARKET_ID(),
      fuse.MORPHO(),
      balanceFuse.MORPHO(),
      vault.isFuseSupported(SUPPLY_FUSE),
      vault.isBalanceFuseSupported(IPOR_MARKET_ID, BALANCE_FUSE),
    ]);
  assert(supplyMarketId === IPOR_MARKET_ID, "Supply fuse uses an unexpected IPOR market ID");
  assert(balanceMarketId === IPOR_MARKET_ID, "Balance fuse uses an unexpected IPOR market ID");
  assert(same(fuseMorpho, MORPHO) && same(balanceMorpho, MORPHO), "Installed Morpho fuses point to another protocol");
  assert(supplyInstalled, "Expected Morpho supply fuse is not installed on this vault");
  assert(balanceInstalled, "Expected Morpho balance fuse is not installed for IPOR market 14: NAV tracking would be unsafe");

  const managerAddress = await vault.getAccessManagerAddress();
  await checkCode(provider, managerAddress, "Vault access manager");
  const access = new Contract(managerAddress, accessAbi, provider);
  const selector = vault.interface.getFunction("grantMarketSubstrates").selector;
  const instantSelector = vault.interface.getFunction("configureInstantWithdrawalFuses").selector;
  const configuredRole = await access.getTargetFunctionRole(VAULT, selector);
  assert(configuredRole === FUSE_MANAGER_ROLE, `Unexpected role for grantMarketSubstrates: ${configuredRole}, expected 300`);
  const withdrawConfiguredRole = await access.getTargetFunctionRole(VAULT, instantSelector);
  assert(withdrawConfiguredRole === CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE,
    `Unexpected role for configureInstantWithdrawalFuses: ${withdrawConfiguredRole}, expected 900`);
  const [roleMember, permission] = await Promise.all([
    access.hasRole(FUSE_MANAGER_ROLE, signer.address),
    access.canCall(signer.address, VAULT, selector),
  ]);
  const [immediate, delay] = permission;
  const [withdrawMember, withdrawPermission] = await Promise.all([
    access.hasRole(CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE, signer.address),
    access.canCall(signer.address, VAULT, instantSelector),
  ]);
  const [withdrawImmediate, withdrawDelay] = withdrawPermission;
  const existing = [...await vault.getMarketSubstrates(IPOR_MARKET_ID)];
  const isAlreadyGranted = await vault.isMarketSubstrateGranted(IPOR_MARKET_ID, BLUE_MARKET);
  assert(existing.length === new Set(existing.map(x => x.toLowerCase())).size, "Existing substrate list has duplicates; abort to preserve exactly");
  assert(isAlreadyGranted === existing.some(x => x.toLowerCase() === BLUE_MARKET), "Substrate list and grant flag disagree");
  const next = isAlreadyGranted ? existing : [...existing, BLUE_MARKET];
  const withdrawFusesBefore = [...await vault.getInstantWithdrawalFuses()];
  const withdrawParamsBefore = await Promise.all(withdrawFusesBefore.map(
    (fuse, index) => vault.getInstantWithdrawalFusesParams(fuse, index).then(params => [...params]),
  ));
  assert(withdrawFusesBefore.length === withdrawParamsBefore.length, "Withdrawal configuration getter mismatch");
  for (const params of withdrawParamsBefore) assert(params.length >= 2, "Existing withdrawal path is missing the market ID");
  const matching = withdrawFusesBefore.map((fuse, index) =>
    same(fuse, SUPPLY_FUSE) && withdrawParamsBefore[index][1].toLowerCase() === BLUE_MARKET ? index : -1
  ).filter(index => index >= 0);
  assert(matching.length <= 1, "Target market has duplicate instant-withdraw paths");
  const isInstantConfigured = matching.length === 1;
  if (isInstantConfigured) {
    const index = matching[0];
    assert(withdrawParamsBefore[index].length === 2 && withdrawParamsBefore[index][0] === ZeroHash,
      "Existing target instant-withdraw path has unexpected params");
  }
  const withdrawNext = withdrawFusesBefore.map((fuse, index) => ({
    fuse, params: withdrawParamsBefore[index],
  }));
  if (!isInstantConfigured) withdrawNext.push({
    fuse: SUPPLY_FUSE, params: [ZeroHash, BLUE_MARKET],
  });
  async function readWithdrawConfig() {
    const fuses = [...await vault.getInstantWithdrawalFuses()];
    const params = await Promise.all(fuses.map((fuse, index) =>
      vault.getInstantWithdrawalFusesParams(fuse, index).then(row => [...row]),
    ));
    return fuses.map((fuse, index) => ({ fuse, params: params[index] }));
  }
  function exactConfig(a, b) {
    return a.length === b.length && a.every((entry, index) =>
      same(entry.fuse, b[index].fuse) && exactArray(entry.params, b[index].params),
    );
  }

  report("# cyvbUSDC Morpho lending venue + automatic instant withdrawal v2");
  report(`Mode: ${MODE}`);
  report(`Chain: ${network.chainId}; vault: ${VAULT}`);
  report(`DEPLOYER_FX signer address: ${signer.address}`);
  report(`Access manager: ${managerAddress}`);
  report(`Required role: FUSE_MANAGER_ROLE = ${FUSE_MANAGER_ROLE} (immediate authorization: ${immediate}; member active: ${roleMember[0]}; execution delay: ${delay}s)`);
  report(`Morpho market: ${BLUE_MARKET}`);
  report(`Morpho collateral token: ${params.collateralToken}; loan/supply token: ${params.loanToken}`);
  report(`Installed supply fuse: ${SUPPLY_FUSE}; balance fuse: ${BALANCE_FUSE}; IPOR market: ${IPOR_MARKET_ID}`);
  report(`Existing Morpho substrates: ${existing.length}; requested substrate already granted: ${isAlreadyGranted}`);
  report(`Required additional role: CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE = 900 (immediate authorization: ${withdrawImmediate}; member active: ${withdrawMember[0]}; execution delay: ${withdrawDelay}s)`);
  report(`Existing instant-withdraw entries: ${withdrawFusesBefore.length}; target fallback installed: ${isInstantConfigured}`);
  report(`Final instant-withdraw entries after apply: ${withdrawNext.length}; target is appended last when missing`);

  if (MODE === "inspect") {
    report("INSPECT_ONLY: no transactions sent and no chain configuration changed.");
    return;
  }

  assert(process.env.APPLY_CONFIRMATION === CONFIRMATION,
    `Apply requires confirmation value ${CONFIRMATION}`);
  if (isAlreadyGranted && isInstantConfigured) {
    report("NO_OP: market and automatic instant-withdraw entry already configured.");
    return;
  }
  if (!isAlreadyGranted) {
    assert(roleMember[0] && immediate && delay === 0n,
      "Signer needs immediately executable FUSE_MANAGER_ROLE (300)");
  }
  if (!isInstantConfigured) {
    assert(withdrawMember[0] && withdrawImmediate && withdrawDelay === 0n,
      "Signer needs immediately executable CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE (900)");
  }
  // Preflight BOTH operations before sending the first transaction to avoid
  // leaving a partially configured governance state on predictable errors.
  assert(exactArray([...await vault.getMarketSubstrates(IPOR_MARKET_ID)], existing),
    "Morpho allowlist changed before preflight");
  assert(exactConfig(await readWithdrawConfig(), withdrawFusesBefore.map((fuse,index)=>({
    fuse, params:withdrawParamsBefore[index],
  }))), "Instant-withdraw config changed before preflight");
  if (!isAlreadyGranted) {
    const data = vault.interface.encodeFunctionData("grantMarketSubstrates", [IPOR_MARKET_ID, next]);
    await provider.call({ from: signer.address, to: VAULT, data });
  }
  if (!isInstantConfigured) {
    const data = vault.interface.encodeFunctionData("configureInstantWithdrawalFuses", [withdrawNext]);
    await provider.call({ from: signer.address, to: VAULT, data });
  }
  const writeVault = vault.connect(new NonceManager(signer));
  if (!isAlreadyGranted) {
    assert(exactArray([...await vault.getMarketSubstrates(IPOR_MARKET_ID)], existing),
      "Market substrates changed before broadcast");
    const tx = await writeVault.grantMarketSubstrates(IPOR_MARKET_ID, next);
    report(`Transaction submitted (substrate grant): ${tx.hash}`);
    const receipt = await tx.wait(1);
    assert(receipt?.status === 1, `Substrate grant failed: ${tx.hash}`);
  }
  // The two governance calls are separate transactions; there is no native
  // vault multicall for an atomic pair. A failed second call must be retried.
  if (!isInstantConfigured) {
    assert(exactConfig(await readWithdrawConfig(), withdrawFusesBefore.map((fuse,index)=>({
      fuse,params:withdrawParamsBefore[index],
    }))), "Withdrawal order or params changed during configuration; aborting");
    const tx = await writeVault.configureInstantWithdrawalFuses(withdrawNext);
    report(`Transaction submitted (instant-withdraw fallback): ${tx.hash}`);
    const receipt = await tx.wait(1);
    assert(receipt?.status === 1, `Instant-withdraw configuration failed: ${tx.hash}`);
  }
  const finalSubstrates = [...await vault.getMarketSubstrates(IPOR_MARKET_ID)];
  assert(exactArray(finalSubstrates, next), "Substrate list differs from expected preserved list");
  assert(await vault.isMarketSubstrateGranted(IPOR_MARKET_ID, BLUE_MARKET),
    "Requested Morpho venue not active");
  assert(exactConfig(await readWithdrawConfig(),withdrawNext),
    "Automatic instant-withdraw fuse list or parameters differ after configuration");
  assert(await vault.isFuseSupported(SUPPLY_FUSE) &&
    await vault.isBalanceFuseSupported(IPOR_MARKET_ID, BALANCE_FUSE),
    "Supported Morpho supply/balance fuse binding changed");
  report(`SUCCESS: lending venue and automatic instant withdrawal enabled, preserving ${existing.length} existing substrates and ${withdrawFusesBefore.length} existing withdrawal paths.`);
  report("User withdraw/redeem executes the entire configured path atomically inside the vault transaction.");
  report("No vbUSDC was deposited, withdrawn, approved, or transferred by this governance workflow.");
}
try {
  await main();
} catch (error) {
  report(`FAIL: ${error.shortMessage || error.message || String(error)}`);
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary.join("\n\n") + "\n").catch(() => {});
  }
}
