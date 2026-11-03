# MiMo Smart Contract Auditor — Training corpus (v11)

**Smart-contract-only source aggregation; not yet training-ready.** General application/network/OS cybersecurity is excluded.

- `datasets/forge-curated/findings/`: 39 full original structured audit JSON documents, 920 extracted findings with pinned code/report references.
- `datasets/code4rena/`: 157 final-report judged H/M finding references from 10 competitive DeFi audits.
- `datasets/smartbugs-curated/`: 143 Solidity vulnerability annotations linked to original source contracts.
- `datasets/defihacklabs/`: 204 exact-commit historical DeFi exploit reproduction pointers, no replay source mirrored.
- `sources/`: registry, pinned commits/blob provenance, license notices; `curation/`: inclusion policy and evaluation-only benchmark reserves.

Raw FORGE extracted findings include informational labels. None of the source links or reported exploit losses is independently reproduced by this import. All records remain `training_eligible:false` until rights clearance, code context, deduplication, validation and protocol-family holdout. No audit workflows, tests or training jobs changed.
