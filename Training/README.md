# MiMo Smart Contract Auditor — Training corpus (v13)

**Source-linked staging corpus, not yet training-ready.** Exclusively smart-contract auditing, especially Solidity/EVM and DeFi economic mechanisms; no unrelated software/network security data.

- `datasets/forge-curated/findings/`: **47 audit documents / 1030 findings** — upstream extracted JSON plus exact code/revision references.
- `datasets/code4rena/`: **208 adjudicated H/M findings across 15 final contest reports**, with original issues and pinned reports.
- `datasets/smartbugs-curated/`: **143 annotated Solidity contracts**, metadata and code links.
- `datasets/defihacklabs/`: **204 incident replay source references**, pinned hashes without source mirroring.
- `sources/`: provider registry, provenance and license notices; `curation/`: inclusion and reserved independent evaluation.

Source-extracted labels, judged verdicts and exploit pointers remain distinct. No record is automatically certified exploitable or licensed for training. Complete code/rights verification, deduplication and protocol-family holdouts are required. No workflows, tests or production code changed.
