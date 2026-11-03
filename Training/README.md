# MiMo Smart Contract Auditor — Training corpus (v15)

**Training staging area, not yet training-ready.** Specialization limited to Solidity/EVM and DeFi smart-contract security, not ordinary cybersecurity.

- `datasets/forge-curated/findings/`: 47 original JSON audit documents, 1030 extracted code-linked findings.
- `datasets/code4rena/`: 208 final judged H/M issue references from 15 smart-contract audits.
- `datasets/smartbugs-curated/`: 143 annotated Solidity contracts and original source pointers.
- `datasets/defihacklabs/`: **454 historical DeFi exploit Foundry reproduction pointers**, pinned to original Git commits and blob hashes; replay code linked, not mirrored.
- `sources/`: catalogue, source versions, legal notices; `curation/`: source qualification policy and evaluation holdouts.

These are original-source indexes, not independently replayed/verified exploit claims. Findings must be rights-cleared, checked for correct audited code, deduplicated across sources and split by unseen protocol families before becoming training records. No workflows, tests, production source or model weights changed.
