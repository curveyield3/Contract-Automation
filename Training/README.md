# MiMo Smart Contract Auditor — Training corpus (v5)

**Staging corpus, not training-ready.** Exclusively EVM/DeFi and other on-chain smart-contract auditing; general cybersecurity is excluded.

- `sources/registry.json`: catalogued source collections, separately identifying evaluation-only material.
- `sources/provenance.json`: source paths, pinned commits and hashes.
- `sources/licenses/`: upstream license notices (not a relicensing of audited contracts or third-party reports).
- `datasets/forge-curated/findings/`: **23 original JSON audit documents**, **430 extracted findings**, and a code-linked `finding-index.jsonl`.
- `datasets/smartbugs-curated/`: **143 Solidity annotation records** with original code pointers.
- `datasets/defihacklabs/`: **9 pinned exploit-reproduction references**, without potentially unlicensed replay code.
- `curation/`: scope, verification policy and independent benchmark reserves.

Raw upstream extraction is not verified ground truth; some findings cover non-exploitable quality issues. No tests, workflows or model training jobs were created or run. All records require source/rights checks, adjudication, deduplication and holdout splits before training.
