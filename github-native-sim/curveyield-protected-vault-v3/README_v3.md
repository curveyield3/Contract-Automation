# CurveYield Protected Morpho Vault V2 controller v3

**Supersedes v2, which irreversibly locked governance-controlled fee changes. v2 must not be deployed.**

Contracts in this source:
- `CurveYieldProtectedVaultController`: one-time new-vault creation via official Morpho Vault V2 factory on Fraxtal, operator and distinct governance permissions.
- `CurveYieldProtectedFeeSplitter`: permissionless accrued fee-share distributions to operator and protocol.

## Governance permissions (v3)
Initially `governance = protocolTreasury`, supplied in the constructor. Governance/Safe can change its privileges immediately via `transferGovernance(newGovernance)`, change its treasury share recipient via `setProtocolFeeRecipient(newRecipient)`, replace the splitter via `replaceFeeSplitter(newSplitter)`, and atomically migrate Morpho vault owner + curator to `newController` with a compatible `newSplitter` using `migrateVaultGovernance(newController,newSplitter)`. **No extra governance timelock** is imposed. The Morpho fee-recipient selector is **NOT abdicated** in v3. The underlying standard Morpho Vault V2 is not modified. Operators are NOT granted these powers.

A replacement splitter must implement the same getter/fee-distribution ABI, identify the same vault and expected controller and have valid recipients. An incoming governance contract must already implement compatible fee accounting and be prepared to administer the existing vault after ownership transfer; do not migrate to an unprepared address. Previously accrued fees are distributed before changing the splitter. Changing the recipient uses the default zero Morpho selector timelock; if governance has raised it, an instant change is intentionally blocked instead of falsely claiming it succeeded.

## Fee model
CurveYield earns `0.2% of recognized vault yield + 2% of operator performance fees`; operator performance fee is configurable and the combined fee cannot exceed Morpho's 50% cap. Fee RATE changes beyond this model require deploying updated governance/splitter contracts and migrating through authorized governance.

## Deployment, compilation and caution
Controller constructor: `(address operator, address protocolTreasury)`. Operator subsequently calls `createVault(asset,operatorRecipient,operatorFeeWad,name,symbol,salt)`; the Morpho vault and splitter are created/configured atomically by that call. Fraxtal chain 252. Morpho official V2 factory: `0x711bCE12269a3a496eFaABB8B9AD5A4485E08A24`.

Compilation: Solidity 0.8.28; optimizer 200 runs; Cancun; viaIR. No tests or simulations are created or executed. This build is not a security audit. No contracts have been deployed by this package.
