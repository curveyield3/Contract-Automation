# CurveYield Protected Morpho Vault V2 — v2

**Compile:** Solidity 0.8.28; optimizer 200; `viaIR = true`; Cancun EVM.  
**Network:** Fraxtal (chain ID 252). **Deployed Morpho Vault V2 factory:** `0x711bCE12269a3a496eFaABB8B9AD5A4485E08A24`.

## No custom vault factory

Deploy a dedicated `CurveYieldProtectedVaultController(operator, protocolTreasury)`, then have the **operator** call `controller.createVault(asset, operatorRecipient, operatorFeeWad, name, symbol, salt)`. The controller calls the **existing Morpho Vault V2 factory**, creates its immutable vault-share fee splitter, installs name/symbol/curator and performance-fee configuration, and irreversibly abdicates the `setPerformanceFeeRecipient` selector — all **in the same creation transaction**. It permits only one vault per controller.

Two custom contracts: `CurveYieldProtectedVaultController` and `CurveYieldProtectedFeeSplitter`. Morpho Vault V2 remains unchanged.

## Protected fees

Let O be operator percentage of Morpho-recognized positive vault yield:

- CurveYield = **0.2% + (2% × O)**.
- Operator = **O**.
- Actual Morpho vault performance fee = **0.2% + 1.02 × O**, bounded by Morpho's 50% maximum.
- For O = 10%, CurveYield earns 0.4%, operator earns 10%, total = 10.4%.

The splitter receives all minted Morpho performance-fee **shares** and distributes them to the protocol and operator recipients. The operator may change their fee via `setOperatorPerformanceFee`; old fees are distributed before the new fee takes effect.

## Ownership and deployment notes

- Controller is permanent vault **owner and curator**; operator is a rotatable wallet/Safe role that cannot transfer the vault, change its curator, redirect its performance-fee recipient, or alter share gates.
- Protocol treasury address is immutable in the controller and two-step rotatable only in the splitter by the current treasury.
- Controller deployment and `createVault` are **two wallet transactions**. The second transaction atomically creates and configures the vault and splitter. If any setup call reverts, none of it is deployed.
- Read back `vault.owner()`, `vault.curator()`, `vault.performanceFeeRecipient()`, `vault.performanceFee()`, and `vault.abdicated(setPerformanceFeeRecipient.selector)`.
- Then complete Morpho's permanent dead deposit, adapter setup, allocation caps, timelocks, and production checks **before public deposits**.
- Only **new vaults** are supported; do not transfer existing vaults with unknown pending curator actions into the controller.
- The fee is charged on yield Morpho actually recognizes; preventing yield recognition with allocation/rate choices remains a separate economic risk.
- No tests are added or run by the GitHub compile-only workflow. Successful compilation does not establish economic security or production readiness.

## Verified source references
- [Morpho Vault V2 repository](https://github.com/morpho-org/vault-v2)
- [Official deployment checklist](https://docs.morpho.org/curate/tutorials-v2/checklist/)

**Package version:** v2 (replaces v1).