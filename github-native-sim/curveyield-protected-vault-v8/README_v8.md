# CurveYield Fraxtal Morpho V2 Protected Fee Controller v8

## Fraxtal mainnet — DEPLOYED AND SOURCE VERIFIED (2026-11-17)
- Controller: `0x33d0fc6db3f50a4f0133817a59cedea639d0c942`
- Deployment transaction: `0x204bd7255a3b02c8df02337fc1daed7664d8fa730fe404ed319255da0ea6275b`
- Chain ID: 252, Fraxtal native FRAX
- Fraxscan verified source: https://fraxscan.com/address/0x33d0fc6db3f50a4f0133817a59cedea639d0c942#code
- Source-verification receipt: `pft9qstsfbmbfjubaq2zsbcl5wpbjf16d83mi1yewig4rdmzdp`; Fraxscan status: **Pass - Verified**
- GitHub compiled source commit: `81f12ab9ee596587d04e87be76fc2acbc69076c6`; latest repeat compile: `c8482ae23a96e2a29ccff985521461801641e1de`
- GitHub Actions successful compile: https://github.com/curveyield3/Contract-Automation/actions/runs/44003701932
- Exact deployed runtime match to GitHub compiler deployment simulation: **YES**, 14,834 bytes
- Deployed constructor operator: `0x064256591313eeb86a84a5cbcc4c6460791b96dd`
- Governance and initial protocolRecipient: `0x47623C62f281807D615eeb4A2CEee9d97F9D3C49`
- Constructor immutable max creation fee: 1 FRAX; current creation charge: 1 FRAX
- 90-day delay immutable: 7,776,000 seconds
- Initialized: **false**. This is the controller only; no Morpho vault or fee custody contracts created yet.
- Source verification and bytecode matching are not security tests or a protocol audit.


Supersedes v7; exact CurveYield extended header v48 immediately follows SPDX.

## Vault creation fee
The native Fraxtal FRAX creation fee (NOT WFRAX) is bounded by constructor immutable `maxVaultCreationFeeWei`. Constructor arguments: (operator, protocolTreasury, maxVaultCreationFeeWei). Deploy max=1000000000000000000, one FRAX. Initial `vaultCreationFeeWei` equals the max and may be reduced or increased only within that immutable bound by fee-only CurveYield governance via `setVaultCreationFeeWei`. Operator calls payable `createVault` with exact `msg.value`; native FRAX is forwarded to current `protocolRecipient` after configuration, atomically. If forwarding fails all state changes revert.

## Security and fees
Morpho V2 factory and implementation unchanged. Controller remains owner/curator permanently; fee-only governance cannot migrate controller, move TVL or arbitrary-call vault, only change fee schedules/recipients/governance, and this bounded creation fee. Operator controls its own fees and authorized curator settings.
CurveYield flat performance default 0.2% (cap 2%); share operator performance default 2% (cap 10%). Flat annual management default 0.05% TVL (cap 0.25%); share operator management default 2% (cap 10%). CurveYield changes to these four fee rates take an immutable 90-day wait. Morpho native totals capped at performance 50% and management 5% annualized. Two tiny instances of the same custody contract separate management/performance fee shares.

## Deployment
Fraxtal ID 252. Prior configured deployer/operator: 0x064256591313eeb86a84a5cbcc4c6460791b96dd. CurveYield fee treasury/governance: 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49.
Solidity 0.8.28, viaIR true, optimizer 200, EVM Cancun. Compile-only, not audited. Creating a new vault is a separate payable operator action requiring its asset, initial operator fee, name, symbol and salt.
