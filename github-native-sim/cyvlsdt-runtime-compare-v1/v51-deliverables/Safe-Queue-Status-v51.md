# CurveYield cyvlSDT v51 — verified Safe queue status

Safe on Ethereum mainnet: `0x47623C62f281807D615eeb4A2CEee9d97F9D3C49`.

| Nonce | Stage | GitHub fork gas | Safe transaction hash | Actual Safe Transaction Service status |
| --- | --- | ---: | --- | --- |
| 21 | Four deployments | 10,632,587 | `0xeb7e07feff92c0b06f2549fb8f3f76ee0ce0c8b37ca43f3ef5b4887a99e15109` | **Queued**, 0 confirmations, unexecuted |
| 22 | Three deployments | 7,176,481 | `0x701a92012679ded24968eb48db98e0bf65627be84d668a60dcd1889ceb9b541c` | **Queued**, 0 confirmations, unexecuted |
| 23 | Two deployments, fourteen configuration calls | 7,768,735 | `0xf4cdaf7ccc07128c9ff9f35caed73b4b1028323d783b2bc76bbbf06a58575437` | **NOT queued**: submit and queue inspection returned Safe API HTTP 429, "Monthly quota exceeded" |

The nonce-23 transaction's calldata, prepared hash, and an importable Safe Transaction Builder file are retained in this folder:
`Safe-CREATE2-MultiSend-v51-stage3.json` and `Safe-Transaction-Builder-v51-stage3.json`.

**Warnings:**
- v50 proposals at nonces 21 and 22 still exist in the Safe queue; old nonce-21 proposal had 1 confirmation. These do not disappear when v51 proposals are made.
- Safe has a 1-of-3 threshold. The old nonce-21 transaction may be executable; **do not execute old v50 transactions**.
- On the Safe UI, select only the exact v51 hashes at nonces 21, then 22. For the last stage, import the 16-operation Transaction Builder payload and propose it at nonce 23. The UI-generated Safe hash may differ from the prepared raw MultiSend hash.
- Do not use an *on-chain rejection transaction* to clear old nonces; it would consume the nonce and invalidate new v51 replacements.
- None of the proposals has been executed on Ethereum mainnet. The successful three-stage deployment and configuration was a GitHub Hardhat mainnet-fork simulation only.
- Safe Pro sponsored execution eligibility was not confirmed; only fork gas usage was measured.

GitHub qualification: https://github.com/curveyield3/Contract-Automation/actions/runs/43985936388
