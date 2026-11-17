# CurveYield Protected Morpho Vault Controller v9 — Fraxtal

v9 supersedes the deployed, verified **v8** controller. The v8 version contains a confirmed vault-creation mismatch: `v.submit(abi.encodeCall(v.setPerformanceFeeRecipient,(performanceFeeCustody)))` was immediately followed by `v.setPerformanceFeeRecipient(address(this))`, while Morpho's `timelocked()` requires exact matching calldata. Thus `createVault` reverts.

**The only functional Solidity change in v9** is `v.setPerformanceFeeRecipient(address(performanceFeeCustody))`. The source header, all fee rates and immutable caps, roles, 90-day timelock, management fee accounting, and custody contracts are unchanged.

No new central CurveYield factory and no factory command forwarder were introduced. The unchanged official Morpho Vault V2 factory deploys each Morpho vault directly owned and curated by that vault's dedicated immutable controller. The creator frontend deploys a new controller for each vault, then invokes `createVault` with the native FRAX fee. The pre-existing v8 reference deployment `0x33d0fc6db3f50a4f0133817a59cedea639d0c942` remains on-chain unchanged and MUST NOT be used for new vault creation.

Constructor: (operator, CurveYieldTreasury, maxVaultCreationFeeWei), with cap 1e18 native FRAX wei. Initial 1 FRAX charge. Verify deployment parameters and explorer publication for independently deployed v9 controller instances. Solidity 0.8.28, 200 optimizer runs, viaIR, Cancun. This package is compile-only and not a security audit. No tests are created or executed.
