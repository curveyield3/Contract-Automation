# MiMo Smart Contract Auditor — Training corpus (v6)

**Staging corpus; not training-ready.** Scope: smart-contract auditing, on-chain protocols, EVM and DeFi only. General software or network security is excluded.

- `datasets/forge-curated/findings/`: 23 real audit-derived JSON documents, 430 extracted findings with code and audited-commit references.
- `datasets/code4rena/`: **94 published, final-report judged High/Medium findings from 5 Solidity/DeFi audits**, with issue URLs, final report and revision. Metadata only; no full report copied.
- `datasets/smartbugs-curated/`: 143 original Solidity annotation records with code references.
- `datasets/defihacklabs/`: 9 pinned exploit-reproduction references, no redistributed replay code.
- `sources/`: providers, pinned revisions, provenance and original upstream dataset licenses.
- `curation/`: smart-contract-only scope and reserved independent evaluation sources.

Upstream judgments and extracted findings are distinct and are **not independently reverified**. All training records remain `training_eligible:false` until licenses, audited code, protocol overlap, validity and holdout split are addressed. No workflows/tests/training jobs changed.
