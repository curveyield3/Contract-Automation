# Phase 0 Fixture Synthesis — Work Spec

## Problem

On r4 (CurveYield DEX v16), Phase-0 telemetry made 4,800 calls. Only 42 were mined successfully and none changed accounting state. The deployment script deploys the infrastructure (vault, routers, hooks, factories) but no pools. Almost every call reverts on a missing precondition:

| Revert | Count | Missing precondition |
|---|---|---|
| `PoolNotRegistered` / `PoolNotInitialized` | ~400 | no created or initialized pool |
| `SenderIsNotVault` / `NotVaultDelegateCall` | ~320 | callback or extension called directly |
| `UnauthorizedCaller` / `NotOwner` / `SenderNotAllowed` | ~210 | wrong sender |
| string reverts (`SENDER_IS_NOT…`, `CAN_ONLY_BE_…`) | ~150 | wrong sender or role |

Medusa has the same limitation: its call variety is mostly revert paths.

## Hard requirements

1. **Universal.** Nothing may name a protocol, contract, function or address specific to one project. The only fixed knowledge allowed is chain-standard infrastructure: canonical mainnet token addresses, Permit2, and the ERC20 and ERC4626 interfaces.
2. **Automatic.** Everything is discovered at runtime from the deployed state, the ABIs and observed reverts.
3. **Evidence-first.** Every setup action is recorded with a receipt or a typed gap: what was tried, why it failed, and the revert decoded where possible.
4. **No relaxed gates.** Existing telemetry and Medusa gates and evidence formats stay valid. Fixture data is additive.
5. **Shared state.** Fixtures run once, after deployment and before the baseline snapshot, so telemetry (live fork) and Medusa (network-free snapshot) both start from the bootstrapped state.

## Code locations

- Runner: `packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs`.
  - `runPhase0RandomizedSimulationV1`: deployment, then `baselineSnapshot`, then Medusa shards, then telemetry.
  - `prepareQualifiedRuntimeV2`, `qualifiedActionV2`, `randomValue` / `generateTypedValueV2`, `runTelemetry`.
  - `renderMedusaRouterV2`, `buildMedusaConfigV2` (Medusa senders are `0x10000`–`0x40000`).
- Put new code in **`packages/github-native-sim/src/phase0-fixture-synthesis-v1.mjs`**, with tests in `packages/github-native-sim/test/phase0-fixture-synthesis-v1.test.mjs`.
- Anvil runs with `--auto-impersonate`: any address can be a sender via `provider.getSigner(addr)`.

---

## Stage 0 — Telemetry smoke mode (do first; small)

**Goal:** check each later stage in about 10 minutes.

**Work:**
1. Extend `--medusa-smoke-calls` with a sibling CLI flag `--telemetry-smoke-calls N`. When it is set:
   - telemetry runs 1 run of N calls instead of 4 × 1200;
   - Medusa still runs if `--medusa-smoke-calls` is set, and is skipped if only telemetry smoke is set.
2. Add a `telemetry_calls` input to `.github/workflows/lite-phase0-simulation-testing-v1.yml`, default `0` meaning skipped. The report step prints:
   - the telemetry summary: `minedSuccess`, `minedRevert`, `simulatedRejection`, `positiveTransitions`, `positiveEconomicTransitions`, `accountingActionShare`, `observationReads`;
   - the **top 15 decoded revert reasons**: decode custom-error selectors against all compiled-artifact ABIs, and string reverts as-is;
   - the fixture evidence once it exists (Stage 1+).

**Done when:** a dispatch with `telemetry_calls=300, medusa_calls=0` on r4 finishes in under 12 minutes and prints the decoded revert table.

---

## Stage 1 — Value pool and actor funding

**Goal:** actors hold real tokens and approvals, and argument generation can see every useful address.

**Work** (`phase0-fixture-synthesis-v1.mjs`):

1. **`discoverValuePoolV1({provider, ethers, targets, actors})`** returns `{addresses, tokens, associations, privileged}`:
   - **tokens:** a canonical Ethereum list (WETH, USDC, USDT, DAI, WBTC, wstETH; addresses as constants) kept only if they have code on the fork. Also any target or created contract that answers `decimals()`, `totalSupply()` and `balanceOf(address)` like an ERC20.
   - **associations:** for every target, call every zero-argument `view`/`pure` function returning `address` or `address[]` (and tuples containing them). Record `associations[target] = Set(addresses)` and add the addresses to the pool.
   - **privileged:** addresses returned by zero-argument views named like `owner`, `getOwner`, `admin`, `getAdmin`, `governance`, `authority`, `getAuthorizer`, `pendingOwner`, `guardian`, `manager`, case-insensitive, prefix or suffix match. Also the deployer (`localSigner`).
2. **`fundActorsV1({provider, ethers, tokens, holders, spenders})`**:
   - **holders:** telemetry actors plus the four Medusa sender addresses.
   - **ETH:** `anvil_setBalance` to 1e24 wei.
   - **ERC20 balances:** find the `balanceOf` storage slot generically.
     - Try mapping base slots 0–50 with both Solidity (`keccak(holder . slot)`) and Vyper (`keccak(slot . holder)`) layouts.
     - Write a probe value with `anvil_setStorageAt`, confirm `balanceOf` reflects it, then set the real amount: 1e6 × 10^decimals.
     - Cache the slot per token.
     - If no slot is found, record the gap `TOKEN_BALANCE_SLOT_NOT_FOUND`.
   - **Approvals:** every holder approves every spender (all targets, and later all created contracts) for `MaxUint256`, sending each approval as the holder (impersonated).
   - **Permit2:** if code exists at `0x000000000022D473030F116dDEE9F6B43aC78BA3`, every holder approves Permit2 on each token, then calls `permit2.approve(token, spender, type(uint160).max, type(uint48).max)` for every spender.
3. Call both in `runPhase0RandomizedSimulationV1` after deployment and before `baselineSnapshot`. Write `runs/PHASE0_FIXTURE_SYNTHESIS_v1.json` with the pool, per-token slot result, receipt counts and gaps.
4. **Argument generation:** `randomValue` gets the pool. For `address` params, pick from these weighted buckets:
   - created contracts 35% (empty until Stage 2);
   - tokens 25%;
   - addresses associated with another address already chosen in the same call 15%;
   - targets 15%;
   - actors and privileged 10%.

   For amount-like `uint` params (any uint ≥ 64 bits), include candidates `1, 10^decimals, 10^(decimals+3)`, capped at funded balances.
5. **Medusa:** fund and approve the Medusa senders as above. Emit the pool's addresses as constants in the generated router so Medusa's AST value seeding picks them up. For example, add one unused `function p0_seed_addresses() external pure returns (address[N] memory)` listing the addresses, excluded from `targetFunctionSignatures`.

**Done when** the smoke run shows token slots found for WETH, USDC and DAI, approvals recorded, and no new evidence failures. Success counts may still be low before Stage 2.

---

## Stage 2 — Creator discovery and execution

**Goal:** create the objects the protocol operates on (pools, markets, vaults, positions) without knowing what they are.

**Work:**

1. **Candidates:** non-view functions on targets that either:
   - return `address` or a tuple containing one; or
   - are named `^(create|deploy|new|clone|launch|register|add|open|make|build)` (case-insensitive) and have at least one `address`, `address[]` or tuple-with-address param.
2. **Structured argument strategies.** Try them in order, up to **24 attempts per candidate**, each inside `evm_snapshot`/`evm_revert` and committed only on success:
   - **token arrays** (`address[]` or arrays of tuples whose first address field is a token): 2 and 3 distinct funded tokens, sorted ascending.
   - **parallel arrays** (`uint[]` the same length as the token array):
     - equal split summing to 1e18 (weights);
     - all equal to 1e18 (rates or scaling);
     - funded amounts.
   - **tuple fields:**
     - `address` fields: token, then `address(0)`, then actor;
     - `uint8` / `enum` fields: 0;
     - `bool` fields: false.
   - **fee-like uint scalars:** ladder `0, 1e12, 1e14, 1e15, 3e15, 1e16, 1e17`.
   - **other address scalars:**
     1. `address(0)`;
     2. the sender actor;
     3. each target whose ABI has functions named like callbacks/hooks (`^on[A-Z]`, `Hook`, `Callback`); try these when the param name contains `hook`, `callback` or `rateProvider`;
     4. every other target.
   - **strings:** `"P0"`, `"P0T"`.
   - **`bytes32`:** a random salt per attempt.
   - **`bytes`:** `0x`.
   - **senders:** a random actor first. On an authorization-looking revert, retry with each privileged address. Authorization-looking means a decoded error name or string matching `/(owner|auth|admin|allowed|permission|role|sender|caller|only)/i`.
3. **On success, detect new contracts:**
   - addresses in the return value;
   - addresses in emitted logs (topics and ABI-decoded data) that now have code and weren't known before.

   Bind each new contract to a compiled artifact by runtime bytecode match, the same method as `discoverDeployments`. If it's a minimal proxy or clone (EIP-1167 or EIP-1967), follow it to the implementation artifact. If nothing matches, use the ERC20 shape probe as a fallback ABI. Add each new contract as a target with full `targetObjects` treatment, and to `created` in the value pool and to approvals.
4. Stop after **3 successful creations per candidate function** and **20 created contracts total**.
5. **Evidence:** `fixtureSynthesis.creations[]` records the function, args summary, sender, receipt, created addresses and bound artifact. `fixtureSynthesis.creationGaps[]` records the function, attempts and the top decoded revert reasons.

**Done when** r4 smoke creates at least one pool through a factory or the factory wrapper, and the pool is bound to its artifact and appears as a telemetry target.

---

## Stage 3 — Initialization and activation

**Goal:** bring created objects into a usable state, for example initialized with liquidity.

**Work:**

1. For each created contract C, take candidate functions in **any** target or created contract (including C itself) that either:
   - take an `address` param where C can be placed; or
   - are named `^(initialize|init|activate|start|seed|enable|open|setup)` on C.
2. **Arguments:** C in the address slot. Other address slots and token arrays come from `associations[C]`, i.e. C's own zero-arg views such as a token list, re-harvested after creation. Amount arrays use funded amounts sized to the associated tokens (`10^decimals` each). Min-out style uints use 0, deadlines use `MaxUint256`, bools use false, bytes use `0x`. The sender strategy is the same as Stage 2.
3. Retry ordering by revert: if a call reverts with a decoded error naming `NotInitialized`, `NotRegistered`, `NotFound` or `DoesNotExist`, or carrying a string with the same words, prioritise initialization candidates for the address in that error's arguments.
4. Up to **30 attempts per created contract**. Stop on the first success per function.
5. **Evidence:** `fixtureSynthesis.activations[]` and `activationGaps[]`.

**Done when** r4 smoke shows at least one pool initialized with liquidity, and telemetry gets mined successful swap and add/remove-liquidity calls with nonzero accounting deltas (`positiveEconomicTransitions > 0`).

---

## Stage 4 — Context-correct callers

**Goal:** stop wasting calls on functions that can only succeed from a specific caller.

**Work:**

1. **Callback-only functions.** Learn them from reverts: a decoded error or string matching `/(SenderIsNot|NotVault|OnlyVault|CallerIsNot|NotDelegateCall|onlyVault|only[A-Z]\w+)/` with an address argument, or a known calling contract.
   - On first such revert, mark the function `CONTEXT_REQUIRED`.
   - Retry once impersonating the address named in the error, else each target that holds the callee in its `associations`.
   - If the impersonated call succeeds, keep that sender for the function. Otherwise down-weight the function to 10% of its selection weight. Don't exclude it, so coverage is still recorded.
2. **Delegate-call-only extensions** (e.g. errors containing `DelegateCall`):
   - Find the facade: a target that has `associations` pointing to the extension, or whose fallback forwards (EIP-1967, or calls succeed when the extension's selector is sent to the facade address).
   - Route the extension's functions to the facade address with the extension ABI. `augmentDelegateProxyContextsV2` already does this for `implementation()` getters; generalise it to "selector is answered by the facade".
3. **Auth-gated functions:** after one auth-looking revert, retry with each privileged address. Remember the first one that passes.
4. **Evidence:** per-function `callerResolution` (`DEFAULT`, `PRIVILEGED:<addr>`, `IMPERSONATED_CALLER:<addr>`, `FACADE:<addr>`, `UNRESOLVED`) in telemetry `byFunction`.

**Done when** r4 smoke shows the 4 largest revert categories from the table above each down by at least 80%, with `minedSuccess` over 25% of calls.

---

## Stage 5 — Accounting reads only around accounting changes

**Goal:** match your rule that state accounting is needed only before and after accounting-changing calls.

**Work:**

1. Telemetry takes before and after `snapshot()` reads **only** for calls that pass preflight (would be mined) **and** are classified `ECONOMIC` (or are on a created contract that is token-like or holds token associations).
2. For other calls, no snapshot. Record `observation: SKIPPED_NON_ACCOUNTING_OR_REJECTED`.
3. Keep the reconciliation and summary formats. `observationReads` will drop sharply, which is expected. Add `observationReadsPerAccountingCall` to the run summary.

**Done when** smoke `observationReads` is under 10% of the r4 baseline (~75k per 1,200 calls) and finalize still validates.

---

## Stage 6 — Full Phase 0 and finalize (I do this)

1. Rerun the r4 bootstrap.
2. I evaluate:
   - deployment;
   - fixtures created and initialized;
   - Medusa variety;
   - telemetry success and positive economic transitions;
   - reads only around accounting calls;
   - every contract and function exercised more than once;
   - repetition.
3. Finalize, then wake reviewer-1.

---

## Rules for every stage

- One PR per stage, branch `claude/loving-franklin-9ogk7x` (or any feature branch). Run `node --test 'packages/*/test/*.test.mjs'` and `npm run lint`. Don't merge: I review and amend, then merge.
- New tests are required for each stage, using local anvil (no fork) and small inline Solidity contracts compiled with the npm `solc` package. Examples: a factory that creates a pair; a pool requiring `initialize`; a callback-only function; an owner-gated function.
- No protocol-specific names, addresses or ABIs in code or tests, except chain-standard infrastructure (canonical tokens, Permit2).
- Don't change Medusa (the patched binary), gates or the call budgets.
- Everything new goes into the simulation summary under `fixtureSynthesis`, and into `PHASE0_FIXTURE_SYNTHESIS_v1.json`.
