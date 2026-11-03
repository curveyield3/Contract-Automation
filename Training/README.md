# MiMo Smart Contract Auditor — Training corpus (v18)

**Data staging only; not yet fit for training.** Smart contracts, EVM, Solidity, on-chain economic security and DeFi exclusively; general cybersecurity excluded.

- `datasets/forge-curated/findings/`: **55 full audit-finding JSON documents**, **1177 extracted findings**, with exact original code/report revisions in the finding index.
- `datasets/code4rena/`: **208 judged H/M finding references** from 15 public smart-contract audits.
- `datasets/smartbugs-curated/`: **143 annotated Solidity contracts**, original code pointers rather than redistributed sources.
- `datasets/defihacklabs/`: **698 historical exploit replay references**, pinned Git source paths and hashes.
- `sources/`: registry, source/hash provenance and license notices; `curation/`: strict inclusion and evaluation-only benchmark reserve.

All findings and PoC links are original-source claims, not independently replayed or automatically accepted as validated exploits. Requires legal/contract-code review, duplicated-issue detection, human/source-grounded validation and protocol-family holdout before training. No tests, workflows or production models changed.
