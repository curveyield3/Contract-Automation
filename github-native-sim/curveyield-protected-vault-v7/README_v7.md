# CurveYield Morpho V2 Protected Fee Controller v7

Supersedes v6. Fraxtal chain 252. The protocol uses the existing standard Morpho Vault V2 factory, with one immutable controller per vault and two minimal instances of the SAME non-discretionary share-custody contract. A distinct receiver for performance fees and management fees is required because Morpho mints the two kinds of shares separately, potentially on ordinary vault transactions.

| CurveYield component | Launch rate | Immutable cap |
|---|---:|---:|
| Flat performance fee on recognized vault yield | 0.20% | 2.00% |
| Share of operator performance fee | 2.00% | 10.00% |
| Flat annual management fee on vault TVL | 0.05% | 0.25% |
| Share of operator annual management fee | 2.00% | 10.00% |

Operator sets its own performance fee via `setOperatorPerformanceFee(WAD)` and annualized TVL management fee via `setOperatorManagementFee(annualWAD)`. Both operator fees are paid to the operator's configured recipient. Combined native Morpho performance fees are capped at 50% of recognized yield and combined native management fees at 5% of TVL annually. The latter is converted to Morpho's on-chain per-second WAD rate by integer division by `365 days`.

CurveYield fee governance can schedule a four-component proposal via `scheduleProtocolFeeRates(flatPerformanceWad, performanceSurchargeBps, flatManagementAnnualWad, managementSurchargeBps)`. The fixed **90-day delay** applies to all four. No pending proposal can be overwritten. `cancelProtocolFeeRates()` can cancel even after maturity; `executeProtocolFeeRates()` is permissionless after expiry and fully settles old fees before changing both native Morpho fee settings. No tests were created or executed.

Fee governance can rotate its fee recipient and change its fee-only governance address, but cannot upgrade code, migrate Morpho owner/curator, change asset permissions, or move user TVL. The operator's allowed curator actions are maintained; direct operator setting of Morpho management fee or recipient through generic curator forwarding is NOT allowed, preventing fee bypass.

Deployment: constructor `(operator, protocolTreasury)`, followed by `createVault(asset, operatorRecipient, initialOperatorPerformanceFeeWad, name, symbol, salt)`. Morpho factory on Fraxtal: `0x711bCE12269a3a496eFaABB8B9AD5A4485E08A24`. Both custody receivers and all fee routing are initialized atomically. Code compiled with Solidity 0.8.28, Cancun, viaIR, optimizer 200. Compile-only is not an audit. No deployment performed.
