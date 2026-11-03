# MiMo Smart Contract Auditor — Training corpus (v16)

**Source aggregation only; not yet training-ready.** Exclusive scope: smart-contract security, Solidity/EVM and DeFi. General software/network cybersecurity excluded.

- `datasets/forge-curated/findings/`: 47 original audit JSON documents, 1030 extracted issue records with affected code/revision pointers.
- `datasets/code4rena/`: 208 judged final-report H/M issue references from 15 smart-contract contests.
- `datasets/smartbugs-curated/`: 143 Solidity annotation records with source URLs.
- `datasets/defihacklabs/`: 585 pinned source pointers for historical real-world exploit reproductions, without copying replay code.
- `sources/`: source registry, exact upstream commits/blobs and license notices; `curation/`: strict inclusion and evaluation holdout policies.

Source classifications are not independent validation. Some upstream source files declare restrictive SPDX. Records need source/rights review, reproduction where permitted, deduplication, and blind protocol-family splits prior to use as MiMo supervision. No tests, workflows, training jobs or production logic modified.
