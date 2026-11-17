# CurveYield cyvlSDT v51 — Safe deployment layout v3 (3 / 3 / 3)

Safe: `0x47623C62f281807D615eeb4A2CEee9d97F9D3C49` on Ethereum mainnet. Verified live nonce **21**; 1-of-3 threshold.

| Safe nonce | Deployment content | GitHub fork gas | Safe transaction hash | Verified Safe service state |
| --- | --- | ---: | --- | --- |
| 21 | Token, Locker, Staking (3 deployments) | **8,191,396** | `0xdd0c4219bab3b48dc8559952e22de782121895377b1300f5c5ba04a96be544ed` | Queued, 0 confirmations, unexecuted |
| 22 | Boost Merchant, Revenue Vault, Revenue Strategy (3 deployments) | **7,614,969** | `0xc9ba8fc2e94a59b9a33a778f9778b698db51034ac72d1c9630a22dc5bbfbcf14` | Queued, 0 confirmations, unexecuted |
| 23 | Bribe Allocator, liquidity guard, PoL Manager (3 deployments), plus 14 configuration calls | **9,761,772** | `0xb803d892b3abcf8b7dcc65ebc8484e89f5450150f24e7fb0e3e7be76d97f08a5` | Queued, 0 confirmations, unexecuted |

All **three** stages passed exact-contract GitHub mainnet-fork Safe execution, including final owner/locker/strategy/PoL/reward configuration checks.

- Source is unchanged from v51. Source SHA256: `99bb114aeefbb86014ce652958a6287bc7d3f1c281ad4deac2c8561a4c20c529`.
- CREATE2 salts and nine deterministic deployment addresses are identical to prior v51 layouts; see `Deployment-Addresses-v51.json`.
- Compiler artifacts retained in `CurveYield-v51-compiler-artifacts.tar.gz`.
- `Safe-Transaction-Builder-v51-stage3.json` was updated for the **17-call** final stage and must not be confused with the superseded 16-call stage3 file from the 3/4/2 branch.
- GitHub run: https://github.com/curveyield3/Contract-Automation/actions/runs/43987128595

## Important overlapping nonce warning

Older v50 and v51 proposals remain in the Safe queue for the **same nonces**. In particular, old v50 nonce 21 `0xe65460b74ccab7948da79d4593c77a7a5311e4ab8ce395a2d3878433633e5df6` remains **unexecuted with 1 owner confirmation**, sufficient for the current Safe threshold. Competing proposals are not automatically removed or invalidated by submitting new ones. Execute **only the exact v51 layout-v3 hashes in the table, in order**.

No on-chain Ethereum transactions have been broadcast by this work. Fork gas measurements do not guarantee sponsored execution eligibility.
