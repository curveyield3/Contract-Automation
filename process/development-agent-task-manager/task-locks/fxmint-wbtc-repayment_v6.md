# fxMint WBTC repayment task v6

State: SIMULATION_PASSED_AWAITING_OWNER_LIVE_DISPATCH.

Latest request: 100 fxUSD repayment, maxFeePerGas 0.155 gwei, priority 0.0001 gwei, reuse helper 0x69B658189d63C39126F7BD017D883A872487713e without deployment. Owner 0xFF90b414D84F7Ec4FAEADBD8Da86Ad515F930654; position #887.

Read-only collection run 37864289687 observed updated debt 100.070130433123808237 fxUSD at Ethereum block 26151226. Existing helper constants support this requested amount; NFT approval is required again.

Simulation run 37864470615 at commit 35c877efb5a7f29237cba4d79cd3ab60eab5a31d PASSED. Simulation job 113607793435 succeeded; live job 113607920590 was skipped. Exact debt decrease 100 fxUSD; after debt 0.070130433123808237. Flash loan principal and fee repaid, NFT returned and helper retained zero tokens. Approval gas 55948; repayment gas 1348716. Total simulated ETH cost 0.000148658961633420; same measured gas at cap costs at most 0.000217722920000000 ETH. No redeployment even on fork; no mainnet broadcast.

Current active files: collector workflow v5, repayment workflow/runner v10, helper source v3, collector source v3, README/task lock v6. Superseded files preserved exactly in curveyield3/archive and removed from active repository. Workflow v10 cannot deploy and does not accept push events for live execution. Live requires manual workflow_dispatch, production environment fxmint-production, existing DEPLOYER_FX signer, mode live-broadcast, confirmation LIVE 100 FXUSD. Live debt is bound to 100070130433123808237 and current base fee plus priority must fit the cap.

Next action: owner manually launches live workflow if desired. The assistant did not initiate live financial execution. Do not interpret a simulation transaction hash as a mainnet receipt or repeat the already-completed first repayment intent.
