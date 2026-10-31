# fxMint ETH long repayment v8

Active workflow: [fxMint ETH Repayment v9](https://github.com/curveyield3/Contract-Automation/actions/workflows/fxmint-eth-repayment-v7.yml).

Original position owner: `0x9f2B20A772246960810045905B7daccf960eE288`. Live mode derives the current public owner address from `DEPLOYER_FX` before simulation; transfer the NFT to that address before running live.
Pool: `0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8` (WstETHLongPool).
Discovery found NFT #1920 with approximately 21.045126289 fxUSD debt and NFT #1925 with zero debt/collateral. Every run rediscovers ownership, debt, rates, fees, liquidity and contract hashes; these historical balances are not execution inputs.

## Inputs

| Input | Meaning |
|---|---|
| mode | `simulate-only` (default), `collect-only`, or manually dispatched `live-broadcast` |
| repayment_fxusd | Net fxUSD debt reduction, default 10; positive decimal with up to 18 decimals |
| owner_address | Optional owner for simulate-only / collect-only; empty follows position_id or NFT #1920 at its current owner. Live derives DEPLOYER_FX automatically |
| position_id | Empty discovers the unique eligible owned NFT; enter an ID if multiple are eligible |
| helper_address | Defaults to verified deployed helper `0x4Af01712F88aa23eE696501928c8e57cf0214d38`; reuse it with different amounts. Clear deliberately only to deploy another helper |
| max_fee_gwei | EIP-1559 total fee cap, default 1 gwei |
| max_base_gwei | Maximum observed base fee permitted before transaction submission, default 0.09 gwei |
| confirmation | Manual live only: `LIVE <normalized repayment amount> FXUSD`, for example `LIVE 10 FXUSD` |

Priority fee is fixed in the runner at **0.00001 gwei (10,000 wei)**. There is no per-run input or environment override. Before deployment, NFT approval and atomic repayment, the runner rereads the current base fee and rejects a value above `max_base_gwei`; it also checks base plus fixed priority against the total cap. Submitted EIP-1559 `maxFeePerGas` is the smaller of `max_fee_gwei` and `max_base_gwei + 0.00001`, and `maxPriorityFeePerGas` is fixed at 0.00001. The input is a submission-time base-fee gate; the signed transaction bounds total price, since EIP-1559 does not encode a separate base-fee field.

The target cannot exceed available position debt or collateral, and must pass the complete transaction. A 100 fxUSD target was rejected because this NFT held only approximately 21.045 fxUSD debt. Both the amount and fees must reflect the current state.

User preference: use whichever ETH collateral form produces the best estimated final outcome, **including gas**. Explicit `simulate-only` mode compares complete routes by total cost. `live-broadcast` uses the previously verified winner only: Curve USDC/fxUSD, followed by direct UniV3 wstETH/USDC at fee tier 500 (0.05%).

## Method and routes

The transaction borrows the calculated USDC principal from Balancer V2, converts USDC to fxUSD with the official MultiPathConverter, repays the requested net fxUSD debt including the current protocol repayment fee, and withdraws collateral through `FxMintRouter.repayToLong` in one manager operation. It sells only the calculated collateral amount for USDC, repays the flash principal plus its current fee, returns the NFT, and refunds remaining tokens. Nothing requires the historical WBTC helper.

The first conversion enforces 0.1% quote slippage and enough fxUSD for net repayment plus protocol fee. The collateral sale enforces 0.25% quote slippage and at least the complete flash loan obligation. All steps are atomic; an unmet floor reverts the transaction.

### Native ETH withdrawal

Wallet withdrawals can deliver native ETH. The official SDK selects `repayToLongAndZapOut` when the requested output differs from the collateral token. For ETH it converts wstETH -> stETH -> WETH, then the router unwraps WETH and sends ETH. The underlying pool's `collateralToken()` is wstETH, and plain `repayToLong` delivered wstETH in the fork.

This workflow compares the collateral sale before the optional wallet-output conversion. It includes Lido unwrap -> Curve stETH/ETH -> WETH/USDC routes alongside a direct wstETH/USDC sale. It can therefore avoid unwrapping to ETH and immediately wrapping back to WETH when that extra conversion is more expensive. ETH is never treated as an ERC20. Position raw collateral is rate-scaled stETH-equivalent; the collector reads the manager scalar/rate and converts it to wstETH units for withdrawal limits and cost accounting.

Primary implementation references:
- [Official SDK repayAndWithdraw](https://github.com/AladdinDAO/fx-sdk/blob/main/src/core/position.ts)
- [Official SDK token routes](https://github.com/AladdinDAO/fx-sdk/blob/main/src/configs/routers.ts)
- [PositionOperateFacet](https://github.com/AladdinDAO/fx-protocol-contracts/blob/main/contracts/periphery/facets/PositionOperateFacet.sol)
- [LibRouter ETH transfer](https://github.com/AladdinDAO/fx-protocol-contracts/blob/main/contracts/periphery/libraries/LibRouter.sol)
- [Manager normalization](https://github.com/AladdinDAO/fx-protocol-contracts/blob/main/contracts/core/PoolManager.sol)

### Cost comparison

In explicit `simulate-only` mode, at a pinned Ethereum block, the collector discovers available UniV3 fee tiers 100/500/3000/10000 and the official Lido/Curve routes, the second Curve stETH/ETH pool, Curve Tricrypto and the Balancer V2 wstETH/WETH pool. It also compares the former collateral -> fxUSD -> USDC round trip as a reference.

For each feasible route it solves the required collateral amount, executes the entire flash repayment from the same fork snapshot, verifies the transaction, and reverts before the next candidate. The score is market value of collateral consumed minus USDC/fxUSD refunds plus measured repayment gas valued in USDC, using common market marks and a common upstream base fee plus priority. Deployment and NFT approval are common setup costs, reported separately. This is the lowest estimated total cost among the tested paths, not a guarantee across every aggregator or future block. Comparison runs recalculate the ranking. Live broadcast never runs that comparison, including in its prerequisite simulation job. Each live acceptance checks only Curve USDC/fxUSD and the direct UniV3 wstETH/USDC 500 pool `0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863`. It recalculates amounts and slippage floors from fresh state, executes one complete repayment on the fork, and fails if that route is unavailable. Live skips alternative route discovery, cost-ranking quotes and the alternate-amount test; ownership, runtime, gas caps, rollback checks and repayment verification remain.

## Verified result

[Simulation run 38016120617](https://github.com/curveyield3/Contract-Automation/actions/runs/38016120617), code commit `9f6aceb6517b4a8935dce8dfc1306dab3dfe690e`, passed at pinned Ethereum block **26158964** (`0xe0d138068483fb70e58ef37d85d1c95bfe555e11eeaddefd146c21411c4a1735`). The live job was skipped. Artifact: `fxmint-eth-simulation-v3`.

Selected route:
1. Balancer V2 flash loan **10.030947 USDC** (observed flash fee zero).
2. Curve USDC/fxUSD pool `0x5018be882dcce5e3f2f3b0913ae2096b9b3fb61f` through the official MultiPathConverter.
3. Pay **10.02 fxUSD** including 0.2% protocol repayment fee to reduce NFT #1920 debt by **10 fxUSD** (plus one wei of rounding).
4. Withdraw and sell **0.003237471345617651 wstETH** directly through UniV3 wstETH/USDC pool `0x4622df6fb2d9bee0dcdacf545acdb6a2b2f4f863`, **500 = 0.05% fee tier**.
5. Receive **10.056089 USDC**, return principal to Balancer, return the NFT and refund **0.025142 USDC + 0.010030287888468813 fxUSD**.

Debt changed from **21.045126289000959443** to **11.045126289000959442 fxUSD**. The **5 fxUSD** alternate check passed using the same fork helper. This helper was deployed only on the fork.

The comparison evaluated 28 collateral sale candidates: **22 completed**; five Balancer paths were infeasible at planning under available balance bounds and direct UniV3 3000 failed full transaction acceptance. Failed routes are excluded and retained in the artifact, not described as executable.

| Collateral sale | Complete repayment gas | Estimated total cost, USDC |
|---|---:|---:|
| Direct UniV3 wstETH/USDC 500, selected | 1,337,716 | 10.286116 |
| UniV3 wstETH/WETH 100 -> WETH/USDC 100 | 1,472,939 | 10.313635 |
| Lido unwrap -> Curve SDK stETH/ETH -> WETH/USDC 100 | 1,491,148 | 10.317268 |
| UniV3 wstETH/WETH 100 -> WETH/USDC 500 | 1,485,621 | 10.321166 |
| Lido unwrap -> Curve factory stETH/ETH -> WETH/USDC 100 | 1,529,181 | 10.324793 |
| Reference through fxUSD then back to USDC | 1,658,668 | 10.357566 |

Selected route saved **153,432 gas** versus the displayed ETH/WETH conversion path and **320,952 gas (19.35%)** versus the fxUSD round trip. These estimated costs include collateral, refunds and gas at the common ranking fee **0.0796553 gwei**, with **2493.3874 USDC/ETH** and **3105.9543 USDC/wstETH** market marks.

Observed fork repayment gas cost: **0.000086687165266920 ETH** at **0.064802370 gwei**. Deployment (1,913,637 gas), approval (55,948 gas) and repayment totaled **0.000251237034313170 ETH** in this fork. With the current default base cap 0.09 gwei and fixed priority 0.00001 gwei, the effective total cap is **0.09001 gwei** (subject to the separate total cap). These gas counts imply at most **0.00029769016301 ETH** including deployment/approval or **0.00012040781716 ETH** for repayment alone. Live costs and gas consumption can change.

## Verification and operation

Only owner gas ETH may be topped up on the fork. No token balances, NFT ownership or protocol storage are fabricated. Acceptance checks exact requested debt reduction within a small rounding tolerance, flash principal/fee returned, NFT ownership restored, collateral reduction, token refunds and zero helper leftovers. Owner-only execution, authenticated callback, zero/excess repayment, deadline and impossible minimum checks are exercised with rollback. Explicit comparison mode also tests a second amount on the same helper. Live acceptance executes only the requested amount through the proven swap routes.

The workflow uses `SD_ETH_RPC_URL`, falling back to `SIM_ARCHIVE_PRIMARY_ETHEREUM_01`, without printing RPC credentials. Installation and Solidity compilation occur only in GitHub Actions. Artifacts contain pinned data, quotes, candidate outcomes, cost comparison, configurable-amount evidence and simulation report; retention is 30 days.

Pushes trigger an unkeyed simulation of the same proven routes, without broadcasting. Manually selected `simulate-only` retains full route comparison. Live mode requires manual workflow_dispatch, successful fresh fork acceptance and the `fxmint-production` environment. A protected preparation job derives only the public address from `DEPLOYER_FX` without signing. The simulation then discovers the NFT in that account and binds the helper to that owner. The live job uses the same secret and requires its address to match the accepted simulation. Until the NFT is transferred there, live selection fails before deployment or broadcast. Existing helper input must match this ETH helper's compiled runtime/owner/pool. Reuse that ETH helper to change repayment amounts without redeployment. A mainnet ETH helper was subsequently deployed at `0x4Af01712F88aa23eE696501928c8e57cf0214d38`; the workflow now defaults to reusing it.


## Run live after the NFT transfer

Open [the workflow page](https://github.com/curveyield3/Contract-Automation/actions/workflows/fxmint-eth-repayment-v7.yml), click **Run workflow**, select branch **main**, mode **live-broadcast**, enter the desired fxUSD amount and gas caps, and enter the exact confirmation (for example `LIVE 10 FXUSD`). Owner is derived automatically from `DEPLOYER_FX`; `owner_address` is only for independent simulate/collect runs. Enter `1920` for this NFT or leave auto-discovery empty. Keep the default `helper_address` `0x4Af01712F88aa23eE696501928c8e57cf0214d38` to reuse the already deployed helper. Clear that field only if another deployment is intended. This accepts the ETH helper only, not the existing WBTC helper.

At **0.09 gwei**, the measured **3,307,301 gas** for deployment + NFT approval + atomic repayment is **0.00029765709 ETH**. Repayment alone is **0.00012039444 ETH**. NFT transfer into the signing account is separate and is not included. These are estimates based on the verified 10 fxUSD sequence; future state/amount/route may change gas.


Signer derivation is restricted to main/manual live dispatch and uses the protected fxmint-production environment. Only the public address is passed to the unkeyed simulation; the live job requires that same address and DEPLOYER_FX. Push verification does not derive a private signer or broadcast.


After the user transferred NFT #1920, the fee-update push check (run 38017559011) correctly stopped because the original account no longer held an indebted position. The current simulation default reads `ownerOf(position_id || 1920)` from Ethereum before collecting positions; it follows real transfers and fabricates no NFT ownership. A provided owner input is still honored, and live mode always uses the DEPLOYER_FX-derived address.


## Current fee-setting verification

[Run 38017714742](https://github.com/curveyield3/Contract-Automation/actions/runs/38017714742) passed at Ethereum block **26159094**, code commit `a30917c6b780b750b96c9f20ff9fddcc6fbf4bbd`, with NFT #1920 now owned by `0xff90b414d84f7ec4faeadbd8da86ad515f930654`. Both 10 and 5 fxUSD repayments passed using the same helper. Owner/callback/zero/overpay/deadline/minimum negative checks also passed. Separate fee checks exercised the exact base ceiling, above-ceiling rejection, a tighter total cap and rereading a changed latest fee. Resolver and live jobs were skipped; no live deployment or transaction occurred.

The report confirms base ceiling **0.09 gwei**, fixed priority **0.00001 gwei**, effective total cap **0.09001 gwei**, and selected Curve USDC/fxUSD -> direct UniV3 wstETH/USDC 500 route. This receiving account's sequence measured **3325101 gas** (deployment 1913649, approval 55936, repayment 1355516). Its measured fork cost was **0.000242808734761631 ETH**; those gas counts at the configured total cap imply at most **0.00029929234101 ETH**, excluding NFT transfer. At a total gas price of exactly 0.09 gwei, the same counts imply **0.00029925909 ETH**. Prior estimates above refer to the earlier account/state and should not be substituted for this current report.


## Deployment-read recovery v9

Live run 38019612709 passed the requested 21.03 fxUSD fork repayment, deployed the helper successfully in transaction `0x73c475bd91d8261e6458637930a1789448786b31fe5ad0166d63d676ec25a96a`, then stopped on an empty owner result before NFT approval or debt repayment. Read-only diagnostic run 38019896487 verified successful receipt/address identity, 8596-byte runtime with hash `0xad3cad3f5398f9fe4f2563228edcfa87a319dbeb1284e0f4e0566269af61421f`, and owner `0xff90b414d84f7ec4faeadbd8da86ad515f930654` at both latest and the deployment block.

The runner disables provider caching/batching and verifies code and owner at one explicit block after the deployment receipt. It retries only missing code or empty owner data for a bounded interval and rejects incorrect runtime/owner immediately. Existing-helper fork acceptance also performs the same unkeyed remote identity check. Deployment evidence now records successful status, receipt contract address and mined block. Default helper reuse avoids another deployment when retrying this repayment. Both swaps remain restricted to the single previously selected routes.

[Recovery verification run 38020099900](https://github.com/curveyield3/Contract-Automation/actions/runs/38020099900) passed the exact **21.03 fxUSD** repayment using this deployed helper at pinned block **26159294**, with **zero deployment gas**, **1460295 total gas** including fork NFT approval, and all six negative checks. This was an unkeyed fork simulation; live signing/broadcast was skipped.
