# MiMo Smart Contract Auditor — Training corpus (v9)

**Source aggregation staged; not training-ready.** Strictly smart-contract/on-chain auditing with EVM/DeFi priority. No ordinary software, network or OS cybersecurity data.

- `datasets/forge-curated/findings/`: **39 original audit finding JSON documents**, **920 source-extracted finding records**, plus `finding-index.jsonl` with audited code/commit links.
- `datasets/code4rena/`: **94 adjudicated High/Medium issue references** from 5 final public audit reports; no third-party report bodies copied.
- `datasets/smartbugs-curated/`: **143 Solidity vulnerability annotation records** with upstream source links.
- `datasets/defihacklabs/`: **159 pinned exploit-reproduction source pointers**, without redistributed Solidity code.
- `sources/`: registry, provenance, licenses; `curation/`: scope and evaluation-only holdouts.

FORGE findings include non-exploitable quality suggestions. Neither source-extracted labels nor published final reports have been independently verified by this import. All records remain restricted from training pending original-code scope, rights and correctness review, deduplication and family-level holdouts. No new workflows, tests, production changes or training jobs.
