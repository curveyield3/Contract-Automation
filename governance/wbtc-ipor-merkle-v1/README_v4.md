# WBTC IPOR DAO — Aragon-native design v4

**Active design authority: [CONTRACT_DESIGN_SPEC_v8.md](CONTRACT_DESIGN_SPEC_v8.md)**. The v8 design supersedes v7 and incorporates the correction that **Guardian removal never invalidates existing proposals**.

The system uses the existing Aragon DAOFactory-generated DAO plus exactly one TokenVoting-derived custom governance plugin and one ZK proof-verifier contract. We retain the existing Aragon TokenVoting proposal/tally/quorum/DAO execution machinery and adapt **Aragon's official StagedProposalProcessor stage patterns** inside the same plugin; we do not deploy a second stage plugin or separate token-voting sub-proposal.

Existing Standard proposals retain their snapshots, voting tallies, bonds, parameters, execution eligibility and original ballots. After Guardian removal, the Safe cannot veto, approve or cast new 15%-bonus-weighted votes. Pending unvetoed review stages proceed directly to a complete 14-day community voting window; earlier weighted votes remain historical; already completed vetoes remain completed.

**Source status:** `contracts/src/WbtcIporTokenVoting_v2.sol` remains the oversized, superseded experimental contract (33,300 bytes last measured), not an implementation of v8. The current `WbtcIporZkProofVerifier_v1.sol` is only a draft receipt adapter. No Solidity implementation change, compilation, proof generation, test run or live fork is claimed by this documentation correction.
