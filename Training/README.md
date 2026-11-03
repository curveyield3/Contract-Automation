# MiMo Smart Contract Auditor — Training corpus (v2)

**Staging corpus, NOT training-ready.** Focus: only smart-contract and on-chain audit skills, especially EVM/DeFi. General software and network cybersecurity data is excluded.

## Directory structure and actual records

- `sources/registry.json`: verified source catalogue (including evaluation-only repositories).
- `sources/provenance.json`: pinned upstream commits, exact source paths and blob hashes.
- `datasets/forge-curated/findings/`: **15 original JSON audit documents**, **220 extracted findings**, and normalized `finding-index.jsonl` including project revision, contract locations and report source.
- `datasets/smartbugs-curated/`: **143 annotated vulnerable Solidity contracts** indexed with original source URLs, no contract-code copies.
- `datasets/defihacklabs/`: **7 pinned exploit reproduction references**; file-level SPDX may prevent republication of raw replay code.
- `curation/`: scope and evaluation holdout restrictions.

Raw upstream labels are staged, not independently confirmed, and `training_eligible:false` is intentional. Original audit reports and Solidity source code may retain third-party licensing. Before training, verify rights, duplicate finding families, restore necessary code context, independently adjudicate security impact, and reserve unseen projects. No tests, workflows, production logic or model checkpoints have been changed.
