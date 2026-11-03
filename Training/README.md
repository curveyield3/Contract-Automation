# MiMo Smart Contract Auditor — Training corpus (v12)

**Source aggregation staged; not training-ready.** Exclusive coverage: DeFi and other on-chain smart contracts (EVM, Solidity, cross-contract economic security). General software and network cybersecurity are excluded.

- `datasets/forge-curated/findings/`: **47 structured audit finding documents**, **1030 extracted findings**; associated code and audit-commit references in `finding-index.jsonl`.
- `datasets/code4rena/`: **157 final-report adjudicated H/M findings** from 10 audits, metadata and original URLs only.
- `datasets/smartbugs-curated/`: **143 annotated vulnerable Solidity contracts** (annotations and pinned source URLs only).
- `datasets/defihacklabs/`: **204 historical DeFi exploit-reproduction source pointers**; replay code not mirrored.
- `sources/`: source catalogue, commit and hash provenance, license notices. `curation/`: inclusion policy and independent evaluation reserves.

Source-extracted audit labels are not proof of exploitability and include some quality/informational findings. Nothing here has been independently replayed or audited. Do not train until rights, audited code context, source-grounded labels, deduplication and protocol-family holdouts are resolved. No tests, workflows or production logic have changed.
