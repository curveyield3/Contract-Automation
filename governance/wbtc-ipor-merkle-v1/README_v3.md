# WBTC IPOR DAO — Aragon-native design and source status v3

The active design authority is **[CONTRACT_DESIGN_SPEC_v7.md](CONTRACT_DESIGN_SPEC_v7.md)**. This replaces the v6 redesign and maps every agreed voting and Guardian rule directly onto the existing Aragon TokenVoting v1.4 implementation, using its original majority-voting and permission machinery.

**Deployment architecture**: existing Aragon DAOFactory-created DAO + one non-upgradeable source-derived custom voting plugin + one RISC Zero verifier adapter. All other helpers are already removed.

**Current repository state**:
- `contracts/src/WbtcIporTokenVoting_v2.sol` is the **superseded and oversized experimental draft (33,300 runtime bytes)**. Its functionality is not a validated implementation of v7; **do not deploy**.
- `contracts/src/WbtcIporZkProofVerifier_v1.sol` is an existing source-derived proof-receipt adapter. The production RISC Zero guest, authenticated state proof and complete membership/census verification do not yet exist.
- `contracts/src/base/MajorityVotingBase.sol`, `contracts/src/base/IMajorityVoting.sol` and `contracts/reference/` retain source-bound Aragon implementation and review references.
- `contracts/src/lib/BokkyPooBahsDateTimeLibrary.sol` is an existing imported library for exact calendar-month inactivity.
- The main-branch GitHub workflow/fork lane is **not yet wired to a deployable v7 implementation**.

The user requested a design rework centered on existing functionality. This commit supplies the **complete v7 specification and exact limited source-diff map**, **not a claim of completed contract refactor**. No tests were created or executed, and no mainnet transaction was sent.

Follow v7's ordered modifications when implementing the next versioned plugin source. Keep the original proposal/tally/execution design from Aragon and avoid reintroducing the redundant governance contract modules.
