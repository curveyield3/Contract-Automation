# MiMo Smart Contract Auditor — Training corpus (v1)

**Initial real-data aggregation; not training-ready.** Scope: Solidity/EVM and other on-chain smart contract audits. No generalized software, network, operating-system, web application or penetration-testing datasets.

## Structure

- `sources/registry.json`: master source catalogue; staged, pending and evaluation-only sources are distinguished.
- `sources/provenance.json`: exact upstream commits, paths, blob hashes, and imported file mapping.
- `datasets/forge-curated/findings/`: 8 original curated audit-finding JSON files, with 158 individual extracted findings.
- `datasets/forge-curated/finding-index.jsonl`: normalized finding descriptions, severity labels, audited revisions and source/code pointers.
- `datasets/smartbugs-curated/`: 143 Solidity vulnerability-annotation records and source URLs. No third-party contract code mirrored.
- `datasets/defihacklabs/`: 4 pinned real incident exploit replay source references; code not mirrored because file-level SPDX must be respected.
- `curation/`: inclusion, verification and held-out evaluation policy.

The raw records are **source claims, not independently adjudicated labels**. Some findings may be informational/quality suggestions, and code-linked metadata does not imply the complete source was imported. Do not train on this staging corpus without legal/source verification, deduplication, validation and held-out family splitting. No workflows, tests, or existing audit-system files have been changed.
