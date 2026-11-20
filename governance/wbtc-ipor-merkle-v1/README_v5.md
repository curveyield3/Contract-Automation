# WBTC IPOR DAO — Aragon-native development status v5

**Active design:** [CONTRACT_DESIGN_SPEC_v9.md](CONTRACT_DESIGN_SPEC_v9.md). This supersedes v8 after explicit authorization for **two governance plugins** using Aragon's original staged architecture.

1. Official Aragon **StagedProposalProcessor** handles parent proposals, seven-day Safe optimistic review, native stage progression, final execution and action restrictions.
2. Aragon **TokenVoting** (vault-specific adaptations) is the automatic token-weighted community voting body. It handles the 14-/30-day ballots, snapshot sources, participation, 25%/33% quorum, 67%/75% approval, activation, bonds, 15% Safe allocation and Guardian-removal qualification.
3. **One custom RISC Zero proof verifier** authenticates Merkle/historical-state calculations, bound to the existing RISC Zero router. The official DAOFactory deploys the parent DAO; existing DAO and plugin-setup infrastructure is reused.

**Early progression distinction:** Aragon TokenVoting has `VotingMode.EarlyExecution` for mathematically irreversible outcomes. SPP has `reportProposalResult(...,tryAdvance)` but stock optimistic SPP `state()` still holds until `voteDuration` when veto is enabled. The seven-day Safe stage requires only a narrow SPP specialization (Safe approve/veto choice and early-approve transition), rather than a new round engine. No-veto default advances after the window once an authorized transaction calls native `advanceProposal`.

**Existing proposals are never invalidated by Guardian removal.** The historic voting data remains frozen; pending unvetoed review stages become advanceable, and the Safe loses future Guardian permissions and bonus ballots.

**Reality:** No v9 Solidity implementations have been created or compiled. The existing `WbtcIporTokenVoting_v2.sol` is the superseded oversized prototype (33,300 bytes), and `WbtcIporZkProofVerifier_v1.sol` is an incomplete validity receipt adapter. Official unmodified SPP source is already preserved in `contracts/reference/StagedProposalProcessor_OSx_v1.sol`. Do not deploy prototypes. No tests or fork deployment were done in this documentation update.
