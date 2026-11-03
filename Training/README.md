# MiMo Smart Contract Auditor — Training corpus (v17)

**Source aggregation staged; not training-ready.** Smart-contract and DeFi security only. No generic application, OS or network security dataset.

- `datasets/forge-curated/findings/`: 47 original report-derived audit JSON documents; 1030 extracted code-linked findings.
- `datasets/code4rena/`: 208 adjudicated High/Medium issue references from 15 public audit reports.
- `datasets/smartbugs-curated/`: 143 annotated Solidity vulnerability examples with original source URLs.
- `datasets/defihacklabs/`: 698 historical DeFi exploit reproduction file pointers, pinned Git commits/blobs, without copying code.
- `sources/`: original source registry, hashes and licenses; `curation/`: source-inclusion and independent evaluation policies.

Source-reported findings, Code4rena judgments and exploit replay pointers are distinct. None was independently reproduced here or automatically approved as training labels. Review source-code licensing, provenance, duplicate protocol families and exploit preconditions before training. No tests, new workflows, production changes or training jobs.
