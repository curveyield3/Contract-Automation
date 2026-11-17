# CurveYield Fraxtal Protected Vault Controller v10 — Shared Fee Policy

## Live Fraxtal master fee policy — deployed and verified

- Master contract: `0xd9a75f28a92d929853872c606097e7050890f35a`
- Official Fraxscan source: https://fraxscan.com/address/0xd9a75f28a92d929853872c606097e7050890f35a#code
- Deployment transaction: `0xe2b0c7155d9dc036f5dc63f1e0904968ef9bd96ac8e983fc20843b5e783c1ccb` (status 1, included)
- Governance: `0x47623C62f281807D615eeb4A2CEee9d97F9D3C49`
- Current policy version: `1` as initially deployed.
- Current master rates: 0.20% flat performance, 2% share of operator performance; 0.05% annual flat management, 2% share of operator management.
- Master rate change delay: 7,776,000 seconds / 90 days.
- Exact runtime bytecode matched GitHub-compiled simulation: 1,911 bytes; source verification result: **Pass - Verified**, including the CurveYield extended header.
- GitHub Actions compile (v10 controller + policy + custody): https://github.com/curveyield3/Contract-Automation/actions/runs/44007556298
- Compiled runtime: controller 15,053 bytes, policy 1,911 bytes, custody 578 bytes.
- Cloudflare Markets Worker **v42** deployed; vault creator at https://markets.curveyield.org/vaults/create.
- New controllers are deployed by the creator's wallet using the GitHub-compiled v10 bytecode and constructor `(operator,treasury,1e18,masterPolicyAddress)`. The first user-created v10 vault and its custody instances have **not** been deployed by this change.
- The previously verified v8 reference `0x33d0fc6db3f50a4f0133817a59cedea639d0c942` is an obsolete standalone controller, **not the master policy**, and remains unchanged.


**Core:** The official Morpho Vault V2 factory creates each vault; that vault's immutable v10 controller is owner and curator. There is no additional vault-owner factory, arbitrary forwarder, registry, upgrade mechanism, or redundant custody accounting. Every vault has its own v10 controller and two minimal v9-equivalent custody instances.

**Master:** The new, separately deployed `CurveYieldVaultMasterFeePolicy` exposes the live four protocol rates and monotonically increasing `policyVersion`. Global CurveYield governance may schedule/cancel changes, and anyone may execute after an immutable **90 days**. It has no vault asset, curator, or fee-transfer privileges. Deploy it first with CurveYield Safe governance `0x47623C62f281807D615eeb4A2CEee9d97F9D3C49`. The existing reference v8 deployment is not a master policy.

**Vault controllers:** v10 constructor `(operator, protocolTreasury, maxVaultCreationFeeWei, masterFeePolicyAddress)`, with Fraxtal max creation fee **1 native FRAX**. It loads master rates at deployment and once more when creating its single official Morpho vault. It caches the *applied* rates for correct accounting of unsynchronized Morpho fee shares. `liveProtocolFeeRates()` always reads the master; `policySyncRequired()` exposes version drift.

**Permissionless:** `syncProtocolFees()` re-reads the master, accrues and distributes accrued shares under the previous applied rates, then updates Morpho's native performance/management fee settings, applies new splits, and updates the cached version. Both `setOperatorPerformanceFee` and `setOperatorManagementFee` automatically do the same sync in one settlement, applying the new operator fee without an intermediate invalid Morpho setting. Operator or CurveYield recipient changes also synchronize before distributing at their previous addresses.

**Fee limits:** Global flat performance 0.20% default (2% max of yield), share of operator performance fee 2% default (10% max); flat management 0.05% default (0.25% max TVL/year), share operator management fee 2% default (10% max). Native Morpho performance and management totals are capped 50% and 5% annualized. To guarantee sync after any legal master rate change, v10 reserves worst-case headroom with a fixed operator performance limit of 43.6363636363636363% of yield and annual operator management limit of 4.3181818181818181% TVL, below Morpho maximums.

**Fee streams:** Morpho mints shares independently to the performance and management custody instances, whose only external action is an authorized transfer by their associated controller. Neither custody contract reads rates or takes governance directions. Global policy never moves vault assets or custody shares.

**Migration:** Existing v8 contracts and v9 source are **not retroactively editable** and cannot be attached to this master. New v10 vaults use the master; previously deployed single-vault contracts keep their original immutable code. New controllers must be compiled and explorer-verified. No tests were created/executed, and compilation alone is not a protocol security audit.
