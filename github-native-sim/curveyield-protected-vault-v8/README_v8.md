# CurveYield Fraxtal Morpho V2 Protected Fee Controller v8

Supersedes v7; exact CurveYield extended header v48 immediately follows SPDX.

## Vault creation fee
The native Fraxtal FRAX creation fee (NOT WFRAX) is bounded by constructor immutable `maxVaultCreationFeeWei`. Constructor arguments: (operator, protocolTreasury, maxVaultCreationFeeWei). Deploy max=1000000000000000000, one FRAX. Initial `vaultCreationFeeWei` equals the max and may be reduced or increased only within that immutable bound by fee-only CurveYield governance via `setVaultCreationFeeWei`. Operator calls payable `createVault` with exact `msg.value`; native FRAX is forwarded to current `protocolRecipient` after configuration, atomically. If forwarding fails all state changes revert.

## Security and fees
Morpho V2 factory and implementation unchanged. Controller remains owner/curator permanently; fee-only governance cannot migrate controller, move TVL or arbitrary-call vault, only change fee schedules/recipients/governance, and this bounded creation fee. Operator controls its own fees and authorized curator settings.
CurveYield flat performance default 0.2% (cap 2%); share operator performance default 2% (cap 10%). Flat annual management default 0.05% TVL (cap 0.25%); share operator management default 2% (cap 10%). CurveYield changes to these four fee rates take an immutable 90-day wait. Morpho native totals capped at performance 50% and management 5% annualized. Two tiny instances of the same custody contract separate management/performance fee shares.

## Deployment
Fraxtal ID 252. Prior configured deployer/operator: 0x064256591313eeb86a84a5cbcc4c6460791b96dd. CurveYield fee treasury/governance: 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49.
Solidity 0.8.28, viaIR true, optimizer 200, EVM Cancun. Compile-only, not audited. Creating a new vault is a separate payable operator action requiring its asset, initial operator fee, name, symbol and salt.
