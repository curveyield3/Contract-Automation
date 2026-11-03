# MiMo Smart Contract Auditor — Training corpus (v14)

**Smart-contract-only evidence collection, staged not yet training-ready.** Covers on-chain EVM/DeFi audits; generic cybersecurity excluded.

- `datasets/forge-curated/findings/`: 47 audit JSON documents, 1030 extracted findings, with commit/code/report pointers.
- `datasets/code4rena/`: 208 adjudicated H/M finding references from 15 public final DeFi audit reports.
- `datasets/smartbugs-curated/`: 143 original vulnerable Solidity annotations plus source pointers.
- `datasets/defihacklabs/`: **340 historical exploit-reproduction code references**, pinned by source Git revision and blob, including 136 newly indexed 2024 cases.
- `sources/`: source registry, provenance, upstream dataset licenses; `curation/`: strict smart-contract scope and independent evaluation holdouts.

Finding classifications are source claims, not independently verified exploits. The replay code has not been copied or executed. Rights verification, validation, code-context reconstruction and cross-source deduplication must precede training. No tests, workflows or training runs executed.
