# MiMo Smart Contract Auditor — Training corpus (v19)

**Smart-contract-only staged data, not training-ready.** Includes only on-chain security sources, prioritizing Solidity/EVM, DeFi and protocol invariants; general cybersecurity and non-contract systems excluded.

- `datasets/forge-curated/findings/`: 55 complete source-extracted audit JSON documents, 1177 findings with original code/commit references.
- `datasets/code4rena/`: 208 published judged H/M issue references across 15 Solidity audit reports.
- `datasets/certora/`: **149 published EVM portfolio audit/formal-verification report references**, pinned to source repository commit; report PDFs linked, not mirrored.
- `datasets/smartbugs-curated/`: 143 annotated Solidity contract pointers.
- `datasets/defihacklabs/`: 698 pinned DeFi exploit-replay source pointers.
- `sources/`: registry, exact source provenance and upstream license notices; `curation/`: strict inclusion and independent evaluation reserve.

The dataset distinguishes adjudicated findings, extracted findings, exploit references and formal-verification publications. No newly verified vulnerabilities or executed exploit reproductions; source rights and audited code must be verified and cross-source duplicates removed before training. No tests, workflows, production code or model training jobs modified.
