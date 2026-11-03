# MiMo Smart Contract Auditor — Training corpus (v7)

**Staged source-linked smart-contract security data, not training-ready.** Strictly EVM/DeFi audits and contract exploitability, excluding unrelated software cybersecurity.

- `datasets/forge-curated/findings/`: 23 full extracted audit JSON documents and 430 source-labelled findings.
- `datasets/code4rena/`: 94 judged H/M findings from 5 reports; source links only.
- `datasets/smartbugs-curated/`: 143 Solidity vulnerability annotations and code pointers.
- `datasets/defihacklabs/`: 159 exact-commit historical exploit-reproduction source pointers, including 150 newly indexed 2025 Jan–Aug cases.
- `sources/`: source registry, exact Git provenance, upstream license notices.
- `curation/`: inclusion criteria, external rights cautions and evaluation holdouts.

No findings in this directory have been newly replayed, independently adjudicated, or approved as training ground truth. Before training, obtain appropriate code rights, reconstruct audited contract context, deduplicate issues, verify labels and reserve whole protocol families. No tests, workflows or model training jobs were created or run.
