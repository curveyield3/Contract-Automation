# fxMint WBTC repayment v6

Current owner: `0xFF90b414D84F7Ec4FAEADBD8Da86Ad515F930654`. Position #887.

Current workflows: `.github/workflows/fxmint-wbtc-repayment-data-v5.yml` and `.github/workflows/fxmint-wbtc-repayment-v10.yml`. Sources: `contracts/FxMintWbtcRepayer_v3.sol` and `run_v10.mjs`.

## Completed mainnet execution

Authorized workflow [37860241544](https://github.com/curveyield3/Contract-Automation/actions/runs/37860241544) passed its independent simulation and live job at commit `a2227c9dfe483bc917bd69052c8e6226f21025b3`. The live job repeated fresh fork acceptance, verified the DEPLOYER_FX signer matches the actual NFT owner, and broadcast EIP-1559 transactions with maxFeePerGas 220000000 wei (0.22 gwei) and maxPriorityFeePerGas 100000 wei (0.0001 gwei). No base fee override was used for this live preflight or mainnet execution.

[Repayment transaction](https://etherscan.io/tx/0xf3df00e9b5f824a6270b9a78b034b1b1a8a16f59a378df97eba52986cfc02aa4) succeeded in Ethereum block 26151005. Debt decreased exactly 100 fxUSD from 194.470130433123808237 to 94.470130433123808237. Balancer's 100.4 USDC principal was fully repaid with actual fee zero. WBTC sold: 0.00123914. NFT ownership returned to the stated owner and the helper retained no USDC, fxUSD or WBTC.

Deployed helper: `0x69B658189d63C39126F7BD017D883A872487713e`. Broadcast artifact: `fxmint-wbtc-broadcast-v9` ID 11585373426; simulation artifact ID 11585338023. Artifacts include pinned state, plan, full operation events, receipt identities, gas and exact measured costs.

| Mainnet transaction | Gas used | Effective gas price (gwei) | ETH cost |
| --- | ---: | ---: | ---: |
| Helper deployment | 2,024,687 | 0.156494906 | 0.000316853201744422 |
| NFT approval | 55,948 | 0.168129367 | 0.000009406501824916 |
| Atomic repayment | 1,354,850 | 0.159816381 | 0.000216527223797850 |
| Total | 3,435,485 | varies by block | 0.000542786927367188 |

Deployment transaction: `0x7d1a7b7fa6fc7eaf0475c9d3498d574ebe68aacd0aa69018e03d35aee9663a89`. Approval transaction: `0x6af652141bbe7442fba936c4e327f1a93820b9793fa6486e99e5662566f8b637`.

## Flow and execution safeguards

The helper borrows 100.4 USDC from Balancer V2 and swaps it to fxUSD with 0.1% quote slippage. It pays the fee-adjusted amount for exactly 100 fxUSD debt reduction (100.2 fxUSD at the observed 0.2% protocol repayment fee). The official repayToLong operation applies debt repayment and WBTC withdrawal together; the protocol transient lock requires one manager operation per transaction. WBTC is selected for at least 100.9 fxUSD after 0.25% quote slippage; proceeds convert back to USDC at 0.25% slippage with a principal-plus-fee repayment floor. Remaining tokens and the NFT return to the owner.

Simulation tests owner-only execution, authenticated callback, output floors, expiry, atomic rollback, mined success, exact debt reduction, full flash repayment, owner NFT return and zero retained helper balances. Only owner gas ETH is increased on the fork; no token balances or protocol/NFT state are fabricated.

Manual mode remains simulate-only by default. Manual live mode on main requires confirmation `LIVE 100 FXUSD`, environment `fxmint-production`, and the existing `DEPLOYER_FX` signing secret. Preserve environment protections. EIP-1559 fee caps are applied to deployment, approval and repayment. Current mainnet base fee plus priority must fit under the cap before broadcasting. The existing helper must match the verified deployed runtime hash and owner. Version 10 supports only helper 0x69B658189d63C39126F7BD017D883A872487713e; it has no deployment path. Fork simulation also reuses that existing helper.

The completed single-use request was archived and removed. Version 10 code/config pushes run simulation only, and live broadcast requires human workflow_dispatch with mode live-broadcast and confirmation LIVE 100 FXUSD. The approved production environment and DEPLOYER_FX secret remain in use. No automatic live-push request is accepted. The new run binds live execution to refreshed debt 100.070130433123808237 fxUSD rather than the completed intent's prestate. Its maxFeePerGas is 155000000 wei (0.155 gwei), with maxPriorityFeePerGas 100000 wei (0.0001 gwei).

RPC uses existing secrets `SD_ETH_RPC_URL` or `SIM_ARCHIVE_PRIMARY_ETHEREUM_01` without printing URLs. Compilation and dependencies occur only in GitHub. Solidity 0.8.28, Cancun, optimizer 200, viaIR; ethers 6.15.0 and OpenZeppelin 5.4.0; official AladdinDAO routes and approved router integration.

## Requested 74 fxUSD reuse — blocked

Read-only RPC verification [37862379764](https://github.com/curveyield3/Contract-Automation/actions/runs/37862379764) at Ethereum block 26151117 confirmed the deployed helper's TARGET_DEBT_REPAYMENT is fixed at 100 fxUSD and FLASH_AMOUNT at 100.4 USDC. The contract source has no amount setter, repayment-amount argument, proxy or upgrade entrypoint. Current debt is 94.470130433123808237 fxUSD. A legitimate execute eth_call reverted with InvalidPlan() (0x21f24259); no transaction or deployment was broadcast.

The 74 fxUSD request cannot execute through this unchanged helper. This was an implementation design error: the requested repayment and associated amounts should have been parameterized for reuse. A corrected helper would require a new deployment, which the user explicitly prohibited for this request. Native FX router flash operations were inspected; they use collateral-token flash loans rather than the requested helper's USDC flow and are not a drop-in way to make this fixed helper repay 74. The no-redeployment instruction remains in force.

The current collector workflow v5 includes reusable deployed-helper amount and fee capability checks and records HELPER_CAPABILITY_v2.json in its artifact. Do not run the live workflow for the blocked 74 fxUSD request.

## Requested 100 fxUSD reuse at 0.155 gwei

Read-only collection [37864289687](https://github.com/curveyield3/Contract-Automation/actions/runs/37864289687) at Ethereum block 26151226 observed debt increased to 100.070130433123808237 fxUSD, enough for the helper's fixed 100 fxUSD repayment. Base fee was 0.126144887 gwei. The helper and NFT owner remained the authorized owner. The diagnostic eth_call reached the NFT transfer and reverted because helper approval was absent; the execution workflow performs that approval before repayment. No deployment or transaction occurred in collection.

Simulation run [37864470615](https://github.com/curveyield3/Contract-Automation/actions/runs/37864470615), commit 35c877efb5a7f29237cba4d79cd3ab60eab5a31d, reuses the exact deployed helper and fresh pinned Ethereum state with the requested cap. Simulation PASSED: exact debt reduction 100 fxUSD, debt before 100.070130433123808237 and after 0.070130433123808237. Complete Balancer repayment, owner NFT return, output floors, rollback checks and zero retained helper token balances all passed. No helper deployment occurred. Approval used 55,948 gas and repayment 1,348,716 gas. Simulated gas cost total 148658961633420 wei (0.000148658961633420 ETH); at the requested maximum 0.155 gwei the same measured gas totals 217722920000000 wei (0.000217722920000000 ETH). These are fork measurements, not live receipt costs. The live job was skipped; no new mainnet transaction was broadcast. Live mode is available only through manual workflow_dispatch with position_id 887, mode live-broadcast and confirmation LIVE 100 FXUSD; the helper input defaults to the deployed address. The workflow repeats fresh acceptance and verifies current fees and authorized debt before signing.
