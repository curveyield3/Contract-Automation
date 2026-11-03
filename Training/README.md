# MiMo Smart Contract Auditor — Training corpus (v8)

**Source aggregation staged; not training-ready.** Only smart-contract and EVM/DeFi security data; general-purpose cybersecurity is excluded.

- `datasets/forge-curated/findings/`: 33 full structured audit-findings JSON documents and 691 extracted finding records, with audited code/revision pointers in `finding-index.jsonl`.
- `datasets/code4rena/`: 94 platform-judged H/M finding references from 5 final audit reports.
- `datasets/smartbugs-curated/`: 143 Solidity vulnerability annotations and original code links.
- `datasets/defihacklabs/`: 159 pinned DeFi exploit reproduction source references.
- `sources/`: catalogue, pinned provenance, original upstream dataset license notices.
- `curation/`: security-only inclusion and reserved independent evaluation sources.

All material is source-linked but not newly replayed or independently adjudicated. Extracted findings may include informational issues. Train only on separately rights-cleared and verified examples after deduplication and protocol-family holdout. No workflows, tests, or training jobs changed.
