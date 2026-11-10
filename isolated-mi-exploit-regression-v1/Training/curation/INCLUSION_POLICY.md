# MiMo smart-contract-only inclusion policy (v1)

Include smart-contract audit findings, Solidity/EVM code, DeFi attacks, vault and share accounting, AMMs, lending markets, liquidations, oracles, bridges, staking, signatures, governance, upgradeability, contract invariants, and cross-contract exploit chains. Exclude general cybersecurity unrelated to smart contracts.

Distinguish upstream extracted findings from human judge-adjudicated findings, independently reproduced exploits, and proven negatives. Preserve original report/commit/source and avoid labels without evidence. Original report and contract licenses must be checked separately from any dataset license. Do not mix benchmarks into the training split; deduplicate by protocol/commit/root cause and keep blind protocol-family holdouts.

This file defines corpus scope only, not new infrastructure, workflows or testing authorizations.
