# Stake DAO harvest bot — spec (DRAFT v2 for approval, 2026-10-01)

Harvests Stake DAO v2 Curve vaults on Ethereum for the CRV harvester fee, only when profitable.
- **GitHub Actions** = the monitor: scans every vault, learns each vault's CRV accrual rate, publishes a short
  priority list.
- **Cloudflare Worker** (free plan) = the executor: every minute checks only that list (10–40 vaults) and
  broadcasts.
- **Helper contract** on Ethereum = atomic harvest with per-vault skipping, CRV→ETH swap and payout in every transaction.

## 1. Facts (verified on-chain 2026-10-01)
- 333 v2 Curve vaults, one **Accountant** `0x93b4B9bd266fFA8AF68e39EDFa8cFe2A62011Ce0`:
  `harvest(address[] gauges, bytes[] harvestData, address receiver)` — permissionless; the batch's harvester fees
  are paid to `receiver` in CRV in one transfer; a reverting gauge reverts the whole call.
- Harvester fee = `getHarvestFeePercent()` (global; 0.025% now, was 0.1% days ago → always read live).
- Reward is **CRV only**. Per-vault fee = fee% × (`gauge.claimable_tokens(LOCKER)` + Σ sidecar
  `getPendingRewards()` from `allocator.getAllocationTargets(gauge)`) (the Accountant's `reservedHarvestFee` is already inside that claimable CRV — not added again).
  Gauge extra-reward reads are ignored (they produce the bogus top rows on the Stake DAO page).
  LOCKER `0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6`, allocator `0xA56B653CE86D1B84b0Ac67bD41F007898cfC14e4`.
- Gas: one gauge alone 646k–728k, batched ~437k each (eth_estimateGas).
- Chainlink CRV/ETH `0x8a12Be339B0cD1829b91Adc01977caa5E9ac121e`; swap on Curve tricrv
  `0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14` (CRV→WETH = `exchange(2,1,…)`).
- Profitable vaults get harvested by others within minutes.

## 2. Platform budgets — routine operation must stay inside them
| Cloudflare Workers free | Limit | This bot (routine) |
|---|---|---|
| Requests | 100,000/day | 1,440 cron + ≤ 300 list pushes ≈ 1,750 |
| CPU per invocation | 10 ms | target ≤ 5 ms (§5.3) |
| Subrequests per invocation | 50 | 2 typical, ≤ 6 when broadcasting |
| Cron triggers / account | 5 | 1 |
| Durable Object (SQLite) | 100k req · 5M rows read · 100k rows written /day | ≤ 2 rows written per run → ≤ 3,500/day |
| Workers KV | 1,000 writes/day | not used |

| GitHub Actions | Limit | Monitor |
|---|---|---|
| Schedule | ≥ 5 min, may run late at high load | see §4.1 |
| Private repo | 2,000 min/month (each job ≥ 1 min) | every 30 min ≈ 1,440 min/month |
| Public repo | free on standard runners; schedules disabled after 60 days of no activity | every 5 min; monthly keep-alive commit |

## 3. Components
1. Helper contract `StakeDaoHarvester` — owner + admin = fee Safe `0x47623C62f281807D615eeb4A2CEee9d97F9D3C49`.
2. GitHub repo `sd-harvester`: `monitor/` (Node script + workflow), `worker/` (Cloudflare Worker), `contracts/`.
3. Worker `sd-harvester` + Durable Object `BotState` (SQLite), cron `* * * * *`.

## 4. Monitor (GitHub Actions)
### 4.1 Schedule
Every 5 min (public repo) or every 30 min (private repo). Each run ≈ 30–60 s.
### 4.2 Each run
1. Vault list: Stake DAO API `strategies/v2/curve/1.json` (refreshed once a day, cached in the repo's Actions cache)
   → gauge, vault; sidecars read on-chain.
2. Read every vault's pending CRV in a few Multicall3 calls (dRPC private RPC; Etherscan logs for harvest history,
   not eth_getLogs).
3. Update the **ledger** (committed JSON in a `state` branch): per vault last pending + timestamp, accrual rate
   (EWMA of Δpending/Δt), last harvest seen (pending dropped), harvest frequency by others.
4. Compute each vault's **break-even gas price** — profitability is mostly waiting for gas to drop, not for CRV to
   accrue: `breakEven(v, t) = (fee_v(t) − minVaultProfit) / gasPerVault`, with `fee_v(t)` growing at the vault's
   accrual rate. Also track recent base-fee lows (EWMA of hourly minima) to know which break-evens are reachable.
5. **Priority list** = **every vault profitable at ≤ `hotGasGwei` (default 0.04 gwei)** — i.e. break-even ≥ 0.04 gwei
   at some point within the next `horizon` (2 × monitor interval + 10 min) — sorted by **harvester yield, highest
first** (same order as break-even gas, since gas per vault is roughly constant),
   capped at **40** (safety cap for the Worker's budget), each with: current fee estimate, accrual rate (fee/second), gas per vault. The Worker
   re-derives break-even every minute from these numbers without re-reading the chain, and only reads on-chain the
   vaults whose break-even is ≥ the current base fee (or within `nearMissPct`).
6. POST the list to the Worker `/priority` (HMAC-signed). One request, one DO row.
### 4.3 Also on GitHub (non-time-critical)
Daily vault-list refresh; weekly report from the Worker's `/stats` (harvests, profit, gas, misses to competitors).

## 5. Executor (Cloudflare Worker, every minute)
1. **Pending tx.** If one is in flight: receipt check; not mined after **90 s** → replace (same nonce, higher fee)
   only if profit stays ≥ minimum at the new fee; stop watching after **5 min**. Then end the run.
2. **Gas gate** (1st subrequest `eth_feeHistory`): baseFee > `maxBaseFeeGwei` (**0.12**) → `gasTooHighStreak++`,
   end run. Streak > `gasStreakOverride` (**50**) → continue anyway, reset.
3. **One Multicall3 eth_call** for the priority vaults (≤ 40): pending CRV parts, reservedHarvestFee, fee%, CRV/ETH,
   ETH/USD, bot ETH balance, nonce-independent. Results parsed by slicing hex words (no ABI library) → CPU ≤ 5 ms.
4. **Profit filter**: per vault fee − marginal gas cost ≥ **$0.02**; total over the passing set − tx overhead ≥
   **$0.12** (USD via Chainlink ETH/USD; gas model calibrated from the bot's own mined txs).
5. **No pre-send simulation** (speed): the contract's atomic checks are the safeguard — unprofitable vaults roll
   back, and the whole tx reverts unless ETH received − all gas ≥ the minimum. Gas limit = measured gas model + 20% (`gasLimitMarginPct`); the contract also stops harvesting more vaults when the remaining gas is only enough to settle (swap + payout), so a short limit harvests fewer vaults instead of reverting.
   Speed-up decisions use the same model. (A reverted tx still pays its gas up to the revert.)
6. **Broadcast** (EIP-1559): `maxFeePerGas = baseFee × 1.05`, priority = minimum to land in 1–2 blocks
   (feeHistory percentile, floor 0.001 gwei). **Near-miss**: the set's break-even gas is within **20%** below the
   current base fee → broadcast with `maxFeePerGas` = the set's break-even (profitable at that fee) and let it wait
   in the mempool for the base fee to fall; it is replaced if a better set appears and dropped after `monitorSec`.
7. **Every harvest tx settles itself** (contract §6): all CRV → ETH, the bot keeps `botReserve` (0.001 ETH, owner-configurable), everything above goes to the fee Safe.
8. Save state (1 row) — and the Worker's own per-vault observations, used to refine the list between monitor runs.
Signing (`@noble/secp256k1`) only runs when broadcasting.

## 6. Helper contract
`harvest(gauges[], minVaultProfitWei, minTotalProfitWei, intrinsicGas, slippageBps)` — bot only. In every tx:
1. Per gauge `try this.harvestOne(gauge)`: measures gasleft() around `accountant.harvest([gauge], [""], this)`,
   values the CRV received with Chainlink CRV/ETH, `profit = value − gasUsed × tx.gasprice`; **that vault is rolled
   back if profit < minVaultProfitWei** (Skipped event, loop continues).
2. **All CRV held → ETH** on Curve tricrv `0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14` (one pool, ETH paid out
   directly; min out = Chainlink − slippage, default 2.5%, max 5%). One-time max CRV approval in the constructor.
3. The ETH fills the bot up to **`botReserve`** (0.001 ETH, owner-configurable via `setBotReserve`); **everything
   above goes to the admin** (fee Safe).
4. **The whole tx reverts unless ETH received − all of its gas (harvests, swap, transfers, intrinsic) ≥
   minTotalProfitWei.**
Owner (fee Safe): `setBot`, `setAdmin`, `setBotReserve`, `rescue`, 2-step ownership. Not upgradeable.
Measured gas (fork): 1 vault + swap + payout ≈ 823k; 3 vaults ≈ 1.59M; swap + payout alone ≈ 196k.

## 7. Settings (DO, `/config`, HMAC-signed)
minTotalProfitUsd 0.12 · minVaultProfitUsd 0.02 · maxBaseFeeGwei 0.12 · gasStreakOverride 50 · maxFeeOverBasePct 5
· nearMissPct 20 · speedUpAfterSec 90 · monitorSec 300 · botReserveEth 0.001 (contract) · maxPriorityVaults 40 · hotGasGwei 0.04 (monitor) · swapSlippageBps 250.

## 8. Keys
New dedicated bot key (Worker secret only). dRPC key as Worker + GitHub secret. HMAC secret shared by both.
Never the deployer key; keys never printed or committed.

## 9. Decisions
- Monitor runs every **5 min** → **public** GitHub repo (free standard runners; secrets stay in GitHub/Cloudflare
  secrets, never in the code). A monthly keep-alive commit prevents GitHub from disabling the schedule.
- Every harvest tx swaps all CRV to ETH and pays everything above the bot's 0.001 ETH reserve to the fee Safe.

## Pre-launch review (2026-10-02)
- **Send endpoint: MEV Blocker `/noreverts`** (was `/fullprivacy`). Per docs.mevblocker.io, `/fullprivacy` has **no
  revert protection** — reverting harvests (and every near-miss tx) could be mined and cost the bot gas. `/noreverts`
  never includes a reverting tx and still blocks front-running/sandwiching (searchers can only backrun; backrun
  rebates go to the bot).
- Bot funding: hold ≈ `botReserve` (0.001 ETH). Each successful harvest refills the bot to ≥ `botReserve`; ETH above
  the reserve is spent on gas while harvest proceeds go to the fee Safe (not lost, but moved there over time).
- `gasStreakOverride` 50: after 50 straight minutes above `maxBaseFeeGwei` the gas cap is bypassed (the contract's
  profit check still applies). Set it very high via `/config` to make 0.12 gwei a hard cap.
- **Circuit breaker:** the first mined revert (any version of the tx, incl. abandoned ones that land later) sets
  `paused = 1` in the bot's config and records `halted` in `/stats`; nothing is sent until `/config {"paused":0}`.
  Worst case if MEV Blocker's revert protection ever fails = one reverted tx (≈ $0.5–2.6), not the bot's balance.

## Next version (v2) — planned after the current version is battle-tested (user, 2026-10-02)
Measured on a fork (2026-10-02, same gauges): ours 833k / 1.263M / 1.605M gas for 1 / 2 / 3 vaults vs one direct
Accountant call 614k / 995k / 1.289M. Gap = fixed ≈ 170k (CRV→ETH swap ≈ 141k + payout) + ≈ 48k per vault.
- **Swap only occasionally**, from a bot ETH budget: skip the swap while the bot holds enough ETH (CRV goes to the fee
  Safe), swap only to refill. Saves ≈ 150k per tx. Trade-off: the profit floor is then CRV at an oracle price, not
  ETH actually received — which is why v1 swaps every time.
- **One batched Accountant call** instead of one per vault: ≈ 48k per vault; one bad vault reverts the batch (free
  under /noreverts) → the bot retries without it.
- Needs a redeploy. Measurement test: `contracts/test/BatchGas.t.sol`.

## v1.1 — batched harvest + optional swap (DRAFT for approval, 2026-10-02)
New function next to the existing per-vault `harvest` (kept as fallback):
`harvestBatch(gauges, minTotalProfitWei, intrinsicGas, slippageBps, swap)` — bot only.
1. **One** `Accountant.harvest(gauges, data, this)` call for every vault (no per-vault rollback; the bot pre-filters
   with exact on-chain fee reads). One failing vault reverts the whole batch — free under `/noreverts`; the bot then
   falls back to the per-vault `harvest` for that set.
2. `swap = true` (v1 behaviour): all CRV → ETH on tricrv (min = Chainlink − slippage); bot refilled to `botReserve`,
   rest to `admin`; **profit = ETH received − all gas ≥ minTotalProfitWei** (real ETH floor).
3. `swap = false`: all CRV straight to `admin` (fee Safe); no bot refill; **profit = CRV × Chainlink ×
   (1 − slippageBps) − all gas ≥ minTotalProfitWei** (oracle floor with a haircut). Saves the ≈ 141k-gas swap.
- Bot (config): `swapMode` 0 = always swap (default — battle-test v1 behaviour), 1 = swap only while the bot's ETH
  is below `swapBelowEth` (an ETH budget), otherwise send CRV to the fee Safe.
- Needs a redeploy (measured 1,726,622 gas ≈ 0.00012 ETH at 0.07 gwei).
- **Prepared (2026-10-02), not live:** contract `harvestBatch` + 35 fork tests (incl. `test/BatchGas.t.sol`); bot path
  behind the Worker var `HARVESTER_V11` (= "0" now, so redeploying the Worker changes nothing); gas model 620k + 290k
  per extra vault (+190k swap / +30k without), within 5% of the fork measurements. Switch-over:
  `C:SERSSERDESKTOPCLAUDESTAKEDAO-UPGRADE-V11.PS1` (DEPLOY + VERIFY + WORKER `HARVESTER` + `HARVESTER_V11 = "1"`).

## Vault tracking inside the Worker — prediction, not polling (DRAFT for approval, 2026-10-03)
Why: GitHub runs scheduled workflows in curveyield3/Contract-Automation only every 3–6 h (the repo's own
`browser-agent-watchdog`, set to every 5 min, shows the same), so the hot list goes stale. And polling is pointless:
**a gauge's CRV accrues at a fixed rate within an epoch** (rates change only when gauge weights update, weekly,
Thursday 00:00 UTC). So each vault's fee is *predicted*, and read on-chain only when the prediction says it matters.
- **Rates, calculated (not measured):** for each gauge the locker's CRV per second =
  `CRV.rate()` × `GaugeController.gauge_relative_weight(gauge)` × `gauge.working_balances(locker)` ÷
  `gauge.working_supply()` (0 if `is_killed`); fee rate = that × the Accountant's harvest fee %. Sidecar CRV
  (Convex share) is calculated the same way from its own gauge position where possible, otherwise from two of its
  reads. One Multicall3 pass for all vaults computes every rate (+ a baseline fee read); recomputed **once per epoch**
  right after the Thursday 00:00 UTC weight update, and for a single vault whenever its exact read before sending
  disagrees with the prediction by more than a few % (e.g. a large deposit/withdrawal changed the working supply).
- **Predicted fee** = last read fee + rate × time since that read — only ever evaluated for ready vaults.
- **"Only cut the grass at 6 inches" — computed once, not every minute:** when a vault's rate or baseline is set,
  its **ready time** is computed once and stored: the earliest moment it could be worth harvesting at all — its fee
  covering its gas at the lowest gas price the bot would ever act at (`readyGasGwei`, e.g. 0.03) plus the per-vault
  minimum. Vaults sit in a queue sorted by ready time. The per-minute tick only looks at the **front of the queue**
  (ready time ≤ now) — every other vault is untouched: no RPC, no arithmetic. Ready vaults stay in a small "ready
  pool" that the tick plans with (exact read before sending, as today) until they are harvested.
- **Someone else harvested** shows up exactly when it matters: the exact read before sending comes back far below
  the prediction → that vault's baseline resets to the read value (rate kept), and it drops out until it re-accrues.
- New vaults (daily vault-list refresh) are read once to get a baseline, then follow the same rules.
- Storage: one ledger key (fee, read time, rate per vault), written only after a read pass or a candidate read.
- The GitHub workflow keeps only `workflow_dispatch` (manual backup; a signed `/priority` push is still accepted).
