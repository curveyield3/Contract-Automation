# fxMint ETH repayment fee configuration v9

State: COMPLETE_VERIFIED. No autonomous follow-up or unchanged rerun.

Governing user requests: configurable ETH long repayment and cheapest final outcome including gas; live signing via DEPLOYER_FX after NFT transfer; add max base gwei input and fixed 0.00001 gwei priority without a per-run input; repair the missing workflow page link.

Current implementation:
- .github/workflows/fxmint-eth-repayment-v7.yml
- packages/github-native-sim/fxmint-eth-repayment/data_v3.mjs
- packages/github-native-sim/fxmint-eth-repayment/run_v5.mjs
- packages/github-native-sim/fxmint-eth-repayment/contracts/FxMintEthRepayer_v1.sol
- packages/github-native-sim/fxmint-eth-repayment/README_v6.md
- this task lock v9

max_base_gwei defaults to 0.09. Priority is fixed at 10000 wei (0.00001 gwei) in the runner; no workflow input/environment override remains. The existing total max_fee_gwei cap remains, and encoded maxFeePerGas=min(total cap, base cap + priority). Pinned-fork and immediate pre-send checks reject an observed base above the input or base+priority above the effective total cap. Live checks occur before deployment, NFT approval and atomic repayment. No helper/collector modification was needed.

Live dispatch on main resolves only the public address from DEPLOYER_FX in the protected environment, then passes it to unkeyed simulation and live signer checks. Empty independent simulation owner follows on-chain ownerOf(position_id or tracked NFT1920). Run 38017559011 stopped before compilation because the user transferred the NFT away from the old owner; the recovery changed ownership resolution, not NFT state. Real current owner is 0xff90b414d84f7ec4faeadbd8da86ad515f930654. No ownership/token/protocol storage was fabricated.

Verified evidence:
- Passing run: https://github.com/curveyield3/Contract-Automation/actions/runs/38017714742
- Source commit: a30917c6b780b750b96c9f20ff9fddcc6fbf4bbd
- Registered workflow ID: 380205194; path .github/workflows/fxmint-eth-repayment-v7.yml.
- Simulation job 114111610193 SUCCESS; resolver 114111610962 SKIPPED; live 114112471875 SKIPPED.
- Pinned block 26159094, hash 0xf4cef74b1007783b681af7b351fd213e8ced5033592bda89138ba568c72657c5.
- 10 fxUSD and alternate 5 fxUSD passed on the same helper. Full flash principal/fee repaid, NFT returned, debt reduction/refunds/helper leftovers verified. Owner/callback/zero/overpay/deadline/minimum negative checks passed.
- Fee boundary checks: exact ceiling accepted, one wei above rejected, tighter total cap respected, latest base reread and fixed priority cannot be overridden.
- Base cap 90000000 wei, priority 10000 wei, effective total cap 90010000 wei.
- Selected route Curve USDC/fxUSD / Uniswap direct wstETH/USDC 500.
- Total gas 3325101, deployment 1913649, approval 55936, repayment 1355516. Fork cost 0.000242808734761631 ETH; max cost at configured cap 0.00029929234101 ETH. NFT transfer excluded.
- Only GitHub compiled/installed dependencies. Local verification was syntax/YAML/source-function boundary checks.
- Exact superseded files archived before deletion. Current workflow page is registered and its path stays v7 during documentation completion. No duplicate same-purpose implementation or assistant-started live run.
- No mainnet deployment/broadcast performed. User controls manual live dispatch after transferring NFT.

Terminal deliverable: current live workflow link, max base input and fixed priority configuration, passing transferred-position simulation, current gas evidence and current-only files. Further work requires a new user change or an evidenced failure.
