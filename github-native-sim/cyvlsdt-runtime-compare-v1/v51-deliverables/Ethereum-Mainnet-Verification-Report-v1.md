# CurveYield cyvlSDT — Ethereum Mainnet Verification Report v1

**Result: 9/9 deployed contracts verified on Etherscan V2 and independently confirmed by public deployed-source inspection.** No source verification is pending.

## Deployment evidence

Ethereum Safe: `0x47623C62f281807D615eeb4A2CEee9d97F9D3C49`; live Safe nonce **24**, threshold **1 of 3**.

| Safe nonce | Mainnet transaction | State |
| --- | --- | --- |
| 21 | [0x4ca16d69...](https://etherscan.io/tx/0x4ca16d69c3dd4f2bb0d5bd2fd27484aafb45455861e981b4c2448be281a53e8c) | Receipt status 1; Safe executed |
| 22 | [0x36db755c...](https://etherscan.io/tx/0x36db755c29645487494e63d055110e54bead4697b859c9f9ec2bec41aa8cc26a) | Receipt status 1; Safe executed |
| 23 | [0x80b79214...](https://etherscan.io/tx/0x80b79214715f2fe23963ab84bf9cb47976f8a8859ff3c667a7aecac6ef30a4af) | Receipt status 1; Safe executed |

Each Safe transaction hash matched the **v51 3/3/3** deployment proposal, not a superseded v50/v51 competing nonce proposal.

## Published source and deployed bytecode

All entries below were independently read from Etherscan after submission: `verified=true`, `sourceCodeBytes>0`, correct declared contract/compiler, and deployed runtime bytecode present. Full Solidity Standard JSON input plus exact ABI-encoded constructor arguments came from the retained GitHub v51 build-info and CREATE2 deployment payloads.

| Contract | Etherscan verified source | Compiler | Runtime bytes | Code hash |
| --- | --- | --- | ---: | --- |
| cyvlSDT Token (`CurveYieldVlSDTToken`) | [0x4B4aA34e805d87458a64d8d745cF7B18e24AeACe](https://etherscan.io/address/0x4B4aA34e805d87458a64d8d745cF7B18e24AeACe#code) | 0.8.28 | 2633 | `0x8cf175d7047c2839bfc672ab1162f8fe231c7398e7995b2ce3d0f111bd0f8f21` |
| vlSDT Locker (`CurveYieldVlSDTLocker`) | [0x4DC535b6aD9eb381A91e472aa3f24F1FDC6Cb21b](https://etherscan.io/address/0x4DC535b6aD9eb381A91e472aa3f24F1FDC6Cb21b#code) | 0.8.28 | 18418 | `0x9ce8a9ee05b55c0b432efa77f1cb4d75b83883ae9a1ab3ec2fb92ef15b7e4d5a` |
| Staking (`CurveYieldvlSDTStaking`) | [0x98d2e6a894ebf04B4009543aa6cCEb6417404E6F](https://etherscan.io/address/0x98d2e6a894ebf04B4009543aa6cCEb6417404E6F#code) | 0.8.28 | 14002 | `0x4ca643444cdfd71566ebb2daa19b9e9f13839e91ee07b7f8e607d1ae482a6a3c` |
| Boost Merchant (`CurveYieldVlSDTBoostMerchant`) | [0x93dE71bEe573e764e8D462042888ff2598A10726](https://etherscan.io/address/0x93dE71bEe573e764e8D462042888ff2598A10726#code) | 0.8.28 | 10691 | `0x1553a22468be1d00209c5ae17caf5f1dc26f5159c7a29fa3f6571a4b6f955494` |
| Revenue Vault (`CurveYieldVault`) | [0x65847aD0eeF247D212c815aF5f80477a57Fb0AB9](https://etherscan.io/address/0x65847aD0eeF247D212c815aF5f80477a57Fb0AB9#code) | 0.8.28 | 9249 | `0x1ba4392f1a047b2f24b6aef7662fe3bbcffcd5284fa6ff6ea29b1e53a738fc27` |
| Revenue Strategy (`CurveYieldRevenueStrategyV7`) | [0x09139f04227a4E413869aBC2Ef1E31D9A82606fd](https://etherscan.io/address/0x09139f04227a4E413869aBC2Ef1E31D9A82606fd#code) | 0.8.28 | 13014 | `0xdf9603dfa25e493bc664c883f63d1f3628726968c8bb9f29ccf27307c3f85a2f` |
| Bribe Allocator (`VoteMarketSingleGaugeBribeAllocator`) | [0x70518b38ceF2118DE94BaC312A284889b1c16aa4](https://etherscan.io/address/0x70518b38ceF2118DE94BaC312A284889b1c16aa4#code) | 0.8.28 | 8626 | `0x1c605dab08d32ce91697ca3dd829d53369368308cf2b0cdbd6e626d42e6a651f` |
| Liquidity Guard (`CurvePairOracleBoundsV6`) | [0x840fa8496e3B5Ac306281d5Bb5224fA08b5865F8](https://etherscan.io/address/0x840fa8496e3B5Ac306281d5Bb5224fA08b5865F8#code) | 0.8.30 | 10683 | `0xf019325f4f0bb9a1e27ab5a57aea9ea10331313cce1e8cf9cb8b71990a4c427f` |
| PoL Manager (`PoLManager`) | [0x54a71cA4F139e674fAd3B9F18cFc013d6175D677](https://etherscan.io/address/0x54a71cA4F139e674fAd3B9F18cFc013d6175D677#code) | 0.8.28 | 20881 | `0x888783ec5e85124e071b19e769392cc70ed700c969fcf58943db0d050712517e` |

Build settings: `viaIR=true`, Solidity optimizer enabled with **200 runs**, EVM **cancun**. Eight contracts use compiler `v0.8.28+commit.7893614a`; the liquidity guard uses `v0.8.30+commit.73712a01`.

GitHub source identity SHA-256 (ordered full v51 source set): `99bb114aeefbb86014ce652958a6287bc7d3f1c281ad4deac2c8561a4c20c529`.

## Verified live configuration

- cyvlSDT Token: owner is requested Ethereum Safe; `locker()` is deployed Locker.
- Locker: owner is Safe; `systemConfigured()=true`; connected to deployed Staking and Merchant.
- Staking: owner is Safe, designated admin is `0x9f2B20A772246960810045905B7daccf960eE288`, `LOCKER()` matches Locker; SDT, USDC, and cyvlSDT are all registered reward tokens (`rewardTokenCount()=3`).
- Merchant: owner is Safe and `LOCKER()` matches Locker.
- Vault: `strategy()` is deployed Revenue Strategy; `feeReceiver()` is designated receiver; `configurator()` is permanently zero after binding.
- Revenue Strategy: owner is Safe; configured Vault and Locker addresses match deployment.
- VoteMarket Bribe Allocator: owner is Safe; `minimumReturnWad()=1.25e18`; gauge is intentionally unset.
- PoL Manager: owner is Safe; `liquidityBounds()` is deployed guard; `curveSlippageBps()=200`; `profitRecipient()` is Locker.
- Stake DAO vlBoost: `isOperator(Locker,Marketplace)=true`.
- Locker boost quota constants: DAO 1000 bps, admin 500 bps, Merchant remainder 8500 bps.
- Staking immediate-withdraw fee: `31250` parts per million.
- Locker PoL deposit share and Staking bribe revenue share currently **0 bps** as configured. PoL Curve pool, Uniswap NFT manager, and bribe gauge are intentionally unset; they are not independently functioning integrations yet.

## Limitations

Successful source verification proves deployed bytecode matches the declared sources and compiler configuration, **not** the correctness or security of all contract behaviors. Ethereum fork integration simulations were conducted in [GitHub run 43987128595](https://github.com/curveyield3/Contract-Automation/actions/runs/43987128595); live mainnet state checks above were read-only. No post-deployment value-transfer or adversarial execution was performed on mainnet during verification.

GitHub source build and per-contract exact verifier payloads are stored under `github-native-sim/cyvlsdt-runtime-compare-v1/v51-deliverables/verification/` on branch `cyvlsdt-v51-safe-3-3-3-v3`.
