# CurveYield Protected Morpho Vault V2 Controller v6

v6 supersedes v5. **There is now one contract per vault**: an immutable controller that is simultaneously Morpho vault owner, curator and performance fee-share recipient. The separate fee splitter and unrestricted governance migration were removed.

## Revenue model and permanent hard caps
- Initial flat fee on recognized yield: 0.20% (2e15 WAD)
- Maximum flat fee: **1.00% (1e16 WAD)**
- Initial CurveYield surcharge: 2% (200 basis points) of the operator's performance fee
- Maximum surcharge: **10% (1,000 basis points)** of the operator's performance fee
- Morpho Vault V2's total performance fee is the operator's performance fee plus CurveYield's flat + surcharge components, and is still capped at 50% overall.

Governance schedules fee changes via `scheduleProtocolFeeRates(flatFeeWad,surchargeBps)`. The controller enforces a **non-configurable 90-day delay** before permissionless `executeProtocolFeeRates()`. Governance can `cancelProtocolFeeRates()` at any time before execution, including after the delay expires. There is only one pending fee change. Fee shares from the old rate are accrued and distributed before switching rates. The operator controls only their own fee and recipient.

## Security boundary
CurveYield fee-only governance may schedule/cancel fee rates, change the CurveYield fee recipient, and transfer **fee-only** governance to another address. It cannot arbitrarily call Morpho, migrate Morpho owner/curator or replace the controller. The code is not upgradeable and user TVL cannot be taken by CurveYield through this controller's functions. Operator chooses allowlisted Morpho curator/risk options; users still face operator and underlying-asset/strategy risk.

The controller's `createVault(asset,operatorRecipient,initialOperatorFeeWad,name,symbol,salt)` calls the pre-existing official Fraxtal Morpho V2 factory `0x711bCE12269a3a496eFaABB8B9AD5A4485E08A24` to create one new vault. The Morpho implementation is not changed. Constructor args: `(operator,protocolTreasury)`.

## Compiler
Solidity 0.8.28, via IR, optimization 200, EVM Cancun. GitHub Action compile-only (no created/executed tests). Code remains unaudited by this build. No deployment is performed.
