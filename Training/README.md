# MiMo Smart Contract Auditor — Training corpus (v10)

**Source aggregation staged, not training-ready.** Exclusive scope: on-chain smart contract and EVM/DeFi auditing; excludes general software/network cybersecurity.

- `datasets/forge-curated/findings/`: 39 full audit extraction JSON documents, containing 920 source-derived findings.
- `datasets/code4rena/`: 157 platform-judged High/Medium issue references across 10 distinct final reports.
- `datasets/smartbugs-curated/`: 143 annotated Solidity contract records, referencing code URLs.
- `datasets/defihacklabs/`: 159 pinned historical DeFi exploit reproduction references.
- `sources/`: source registry, pinned origins/commits, licenses; `curation/`: inclusion rules and holdout benchmarks.

Code4rena final-report judgment differs from automatically extracted FORGE findings; neither has been independently validated here. Records require original-code rights, protocol/commit deduplication, exploitability review and blind holdouts before training. No tests, audit workflows, model weights or production code changed.
