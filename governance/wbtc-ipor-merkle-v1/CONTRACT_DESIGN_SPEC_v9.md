# WBTC IPOR DAO — Native Aragon Two-Plugin Governance Specification v9

**Status:** revised architecture and source-confirmed implementation instructions. **Not yet implemented as v9 Solidity, compiled, deployed, audited or fork-tested.** Supersedes v8. The current v2 custom voting source remains an oversized experimental draft and **must not be deployed**.

## 1. The architectural correction: use two established Aragon plugins

User explicitly authorizes the Aragon-native **two-plugin** arrangement:

- **Aragon DAOFactory** (existing verified mainnet deployment at `0x246503df057A9a85E0144b6867a828c99676128B`) generates a standard Aragon OSx DAO.
- **Governance plugin A — official Aragon StagedProposalProcessor (SPP):** responsible for the parent proposal, optional seven-day Safe review, sequential advancement, and *only* final DAO execution. Derive only narrow necessary policy/categorical changes from the pinned original at `aragon/staged-proposal-processor-plugin/src/StagedProposalProcessor.sol`, commit `a1d84e0542cf2db0a542f0159878457dbb7e3515`. The exact upstream source is already preserved as `contracts/reference/StagedProposalProcessor_OSx_v1.sol`.
- **Governance plugin B — official Aragon TokenVoting v1.4 with minimal vault-specific adaptation:** handles Yes/No/Abstain, source-authenticated vault-share voting weights, 25%/33% quorum, 67%/75% approval, 14-/30-day ballots, activation/inactivity, bonded proposals, spam classification, and Guardian removal vote eligibility. Based on deployed Ethereum TokenVoting implementation `0xbbc277951d93e866700471f71616b2c9d304e6f6`, pinned source `aragon/token-voting-plugin` commit `e726c28061486114d601c547e4da1180ed5ab6da`. Reuse `MajorityVotingBase` and existing `IVotes` machinery. Do not create another proposal/tally engine.
- **One non-governance custom ZK validity-verification contract**, which delegates cryptographic receipt checks to the already deployed RISC Zero router `0x8EaB2D97Dfce405A1692a21b3ff3A172d593D319`. The actual source-authenticating guest/host is still incomplete.

There are **two governance plugin instances**, not two independent DAO execution authorities. SPP alone receives `DAO.EXECUTE_PERMISSION`; TokenVoting is an SPP voting body and must not independently execute arbitrary DAO actions. Ordinary external token/market/IPOR vault contracts are not governance plugins. SPP may require normal Aragon setup/proxy/permission-condition infrastructure; reuse its official installation mechanisms and do not write a replacement deployment framework.

## 2. Exactly what existing Aragon source already supports

### Official SPP (do not reimplement)

The pinned SPP already supplies:
- `Proposal`, `Stage`, `Body`, `currentStage`, `stageConfigIndex`, `lastStageTransition`, metadata/action storage and `ProposalAdvanced` event.
- `Stage.minAdvance`, `maxAdvance`, `voteDuration`, `approvalThreshold`, `vetoThreshold`, `cancelable`, `editable`.
- Manual Safe bodies (`Body.isManual=true`), automatically created external token-voting body proposals (`isManual=false`), result reporting via `reportProposalResult(...,_tryAdvance)`, permissioned `advanceProposal`, `state()`, `canProposalAdvance`, `getProposalTally`, and final `execute()`.
- Per-proposal immutable `stageConfigIndex`: changes to later stage configuration do not silently replace a proposal's original stage plan.

### Official TokenVoting (do not reimplement)

TokenVoting already supplies proposal ID/metadata, snapshot timepoint, `VoteOption` Yes/No/Abstain, `Tally`, `vote`, `_vote`, `_canVote`, `hasSucceeded`, `isSupportThresholdReached`, `isMinParticipationReached`, `getProposal`, and `getVoteOption`. Its `ProposalParameters` already store a per-proposal support threshold, minimum voting weight, dates and voting mode; our two ballot categories require narrow differences to these fields, not another core vote processing engine.

**The user-described early-passage setting exists:** Aragon TokenVoting's `VotingMode.EarlyExecution` allows *early success/execution when (a) turnout, support and minimum approval are satisfied and (b) Yes still wins even if every remaining eligible vote becomes No*. Source `MajorityVotingBase.sol` lines 417–427 and 603–655. This is **stronger than merely current quorum plus approval**. With a one-voter Safe-only election, an affirmative Safe vote counts all eligible power, so its early result is conclusive. Community Stage 2 stays `VotingMode.Standard` to preserve the entire 14- or 30-day ballot.

**SPP early advancement is a different mechanism:** `Body.tryAdvance` and `reportProposalResult(...,true)` advance a stage only when `state()==Advanceable` and sender holds the needed advance permission. SPP's own `state()` (lines 636–640) **blocks a stage with veto bodies until `voteDuration` has expired**, even if an approval was reported. Thus a stock SPP "optimistic veto" configuration alone does NOT meet the requested immediate-advance-on-Safe-Yes rule; it requires a minimal adapted SPP check, or a deliberately equivalent setup that genuinely reaches `Advanceable` early. Do not misrepresent `tryAdvance` as overriding `state()`.

## 3. Standard parent proposal: precisely two real stages

**Stage 0 — Safe optimistic security review** (SPP's native stage mechanism):
- The sole authorized review body is the designated Guardian Safe, as a **manual body**. The Safe may approve early, veto, or not respond.
- **Maximum effective veto window: seven days** after the parent proposal becomes reviewable. If Safe vetoes within that window, it blocks/rejects the Standard proposal. If Safe explicitly approves before the deadline, the next stage becomes advanceable **immediately**; when the proposal meets all relevant stage requirements, `tryAdvance=true` can move it within that transaction if the Safe has `ADVANCE_PERMISSION`. If no veto is reported, the stage passes optimistically **when the full seven days elapse** and any permitted address can advance it.
- Normal configuration pattern: `approvalThreshold=0`, `vetoThreshold=1`, `minAdvance=0`, `voteDuration=7 days`, `maxAdvance > 7 days` (must allow advancement after timeout; never equal to the veto period), `cancelable=false`, `editable=false`. The stock manual-body source limits a body to one configured result type. To support the Safe's **both Yes and Veto** actions, minimally adapt the single-Safe review result authorization and SPP state logic to recognize a Safe Yes as early success and a Safe No as veto, without introducing another plugin or ballot engine. The adaptation must reject any veto after the seven-day window, even if nobody has called `advanceProposal` yet.
- The EVM does not execute a stage-transition transaction automatically at a timestamp. **Ready to advance at seven days** is distinct from **the actual on-chain transition**. SPP's native `advanceProposal` can be callable by anyone, including a keeper, or the next user interaction. The user's "passes unless downvoted" means no further Safe consent is required.

**Stage 1 — community token voting**:
- SPP uses its **automatic TokenVoting body**: `_createBodyProposals` creates an ordinary Aragon token-voting subproposal when Stage 1 opens; SPP's `_getProposalTally` reads TokenVoting's ordinary `hasSucceeded(subproposalId)` to determine stage approval.
- SPP retains the only original vault-management action array and final DAO execution authority. TokenVoting's subproposal is a signal/approval body, not a separate executor of vault transactions.
- Community round: **14 complete days** from stage activation; `VotingMode.Standard`, **25% of active eligible voting weight** as quorum, **at least 67% Yes/(Yes+No)** approval, Abstain participation counts only toward quorum. **No early execution of community proposals**.
- Proposal creator needs **>=10%** of the eligible community power, escrow **0.001 underlying vault shares**, refund except a valid separate spam/attack majority classification with quorum. Keep creator/bond accounting tied to the **SPP parent proposal ID** to avoid double bonds for the automatically created TokenVoting body subproposal.

**SPP state caveat:** A Stage 1 that relies only on TokenVoting `hasSucceeded` during the open voting period could advance early if TokenVoting computes early mathematical success. Explicitly prohibit advancement/execution of Stage 1 until its full **14 days** have elapsed, regardless of the body's `VotingMode`. This narrow guard belongs at the SPP stage boundary; don't reimplement token votes.

## 4. Remove DAO Guardian: bypass Safe review, retain the same TokenVoting body

Guardian removal is a **different SPP parent proposal category**, not a community proposal that the Safe can intercept:

- **Skip Stage 0 altogether**; the SPP parent immediately creates an automatic TokenVoting body with category `RemoveGuardian`. Standard parent proposals use the two-stage configuration; removal parents use a one-stage/token-ballot configuration. SPP currently selects `currentConfigIndex` globally at creation (source lines 373–398), not a caller-supplied category, so a **minimal source-bound category configuration selector** is needed; do not switch global active configuration for one special proposal and accidentally change everyone else's prospective rules.
- **30 days** of `VotingMode.Standard` voting, not subject to Safe security review, with **33% quorum calculated over the complete unactivated/undelegated/inactive economic vault-share supply**, **at least 75% Yes/(Yes+No)** and 0.005-vault-share bond.
- Eligible voters must be **continuously activated at least three calendar months at snapshot**; minimum proposer stake **10% of that qualified voting electorate**; no Safe bonus counts as voting power or in quorum.
- Only one parent executable action is allowed: a zero-ETH call to the TokenVoting plugin's **one-way `permanentlyRemoveDaoGuardian()`**. SPP checks the exact target, selector, calldata, action count and disallows `allowFailureMap` and delegatecall. The underlying plugin must allow this action only when executed via the DAO by SPP after a genuinely approved removal proposal; no direct guardian or proposer authority.

## 5. Already-created proposals are never invalidated

**Hard user requirement:** after successfully removing the Guardian, do NOT invalidate, cancel, recreate, reset, resnapshot, rescore, restart, or change the original denominators of any existing proposal.

- Original SPP parent IDs, original stage/body subproposal IDs, frozen voting weights, submitted votes, vote tallies, quorum denominators, actions, bonds and already-open community vote deadlines survive unchanged.
- Guardian Safe loses any **future** 15% bonus vote or privileged review/approval/veto immediately, including in already-created parent proposals. Historic bonus-weighted votes stay counted as historical facts; they are not reallocated.
- An already-created Standard proposal in **unvetoed Safe review** becomes eligible to advance directly to community voting immediately after Guardian removal; its 14-day community window begins upon the stage's actual activation, and no new Safe approval is required. A Safe veto finalized before removal stays a previously finalized rejection; removal does not reopen it.
- A Standard proposal with an **already active** community subproposal completes the **same** community ballot, tally and deadline. A proof-pending subproposal cannot start voting before genuine proof acceptance; after acceptance it receives the entire required community voting period, without Safe review.
- Concurrent removal proposals remain recorded even if another removal passes first. The final removal state is one-way and **idempotent**, so a second approved removal action does not revert or revoke any other proposal.
- The proposed SPP adaptation must check an authoritative `guardianRemoved` read from TokenVoting when evaluating Safe manual results and stage advanceability. Stock SPP stage configurations are pinned to parent proposals, so a general `updateStages` alone does **not** release pending older review stages. Do not install a process-wide epoch invalidation or loop through all parent proposals.

## 6. Voter identity, market weight, spam and ZK data

These **remain narrow enhancements to TokenVoting's power source and eligibility hooks**, not alternative voting/processing engines:

- One transaction self-delegates IPOR vault shares and activates; existing IPOR `PlasmaVaultVotesPlugin` is reused. No new governance token. Do not equate `getPastVotes` (delegated) with raw wallet-held economic shares without source confirmation.
- Direct underlying vault shares count **100%**, approved exact-vault-share-token Morpho Blue or CurveLend positions **50%**. CurveLend amounts reflect LLAMMA collateral remaining under soft liquidation; no custody double counting. `addVotingMarket` is authorized only by a successful **Standard SPP parent proposal** and source identity must be authenticated.
- Safe Guardian receives exactly **15% of total eligible Standard power**; allocate community shares scaled 85 and Safe bonus scaled 15. Removal proposals exclude the bonus from voter weights and entire quorum denominator. After Guardian removal, new community ballots no longer allocate that bonus.
- Inactivity requires both **at least two missed eligible completed community votes** and **three calendar months since the first such miss**. Voting resets misses; reactivation after expiry restarts 3-month removal-qualification clock. Never expire voters merely because no proposals occurred. Preserve correct history across ZK and atomic modes without unbounded all-history iterations.
- `Atomic` is the preferred Standard voter-power snapshot when a complete bounded onchain census fits gas. `VerifiedMerkle` is an alternative Standard route and required for Guardian removal's supply-wide unregistered economic denominator. The single custom verifier must authenticate exact historical chain state, the complete eligible roster, configured lending markets and total economic vault shares, correct activity, snapshot anchor, canonical Merkle tree, the approved RISC Zero guest image and proof receipts. Membership proofs alone are insufficient.
- Spam/attack flags and refundable proposal bonds must follow the **SPP parent ID** and never charge twice due to the automatic TokenVoting subproposal. Quorum and spam majority must come from the final accepted TokenVoting voting distribution.

## 7. Permissions and deployment — use official Aragon setup

- Let official DAOFactory and Aragon's existing plugin setup processor install/configure SPP and the adapted TokenVoting plugin using their normal permission mechanisms when compatible. Do not reinvent DAOFactory, DAO, TokenVoting, SPP or contract-installation orchestration.
- **DAO.EXECUTE_PERMISSION only to SPP**, not TokenVoting, the Safe, EOAs, prover or ZK verifier. Only SPP can execute vault-management and guardian-removal actions via approved parent proposals.
- TokenVoting may provide `IProposal` and `hasSucceeded` to SPP as an automatic voting body. Grant SPP only the TokenVoting `CREATE_PROPOSAL_PERMISSION` required to create its body subproposals. The automatically generated body's action `reportProposalResult` should not confer DAO execution power to TokenVoting.
- SPP `ADVANCE_PERMISSION` can be public, with the Safe able to use `tryAdvance=true` after an affirmative early response, subject to actual eligibility. Do **not** grant arbitrary `UPDATE_STAGES`, `SET_TARGET_CONFIG`, `UPGRADE_PLUGIN` or DAO `ROOT` roles to Safe/EOAs/untrusted contracts.
- Standard SPP parent action list must be restricted at both creation and execution to exact reviewed vault/configuration functions; Guardian-removal parent action must be exact sole permanent-disabling call. Stock SPP permits generic arbitrary action arrays, so secure scoping is a **genuine minimal source/permission extension** that cannot be dropped.
- As part of Guardian removal permanently revoke the Safe's security/bonus authority; preserve already-approved proposals and prevent any alternative permitted upgrade, plugin swap or DAO action from restoring Guardian privilege. Audit actual permission graph before deployment.

## 8. Source-specific minimal-change map — avoid duplicating what Aragon provides

| Original | Keep | Required limited adaptation |
|---|---|---|
| `StagedProposalProcessor.Stage`, `Body`, `Proposal`, `advanceProposal`, `_getProposalTally`, `_advanceProposal`, `_executeProposal` | Keep source and native stage engine | Safe Yes-and-Veto authorization for the same manual body; immediate Yes and optimistic expiry; hard seven-day veto cutoff; kind-specific initial stage/config; Guardian-removal bypass for pending review; 14-/30-day full-stage completion; enforce action allowlist |
| `StagedProposalProcessor.updateStages` / versioned configuration | Keep | Future-only changes; do not mutate existing proposal snapshots or reassign existing stage config |
| `TokenVoting.createProposal`, `ProposalParameters`, `Tally`, `vote`, `hasSucceeded` | Keep | SPP-only subproposal creation, parent-link/id validation, per-proposal category settings, vault-share source and qualification; original tally/economic threshold math |
| `TokenVoting.VotingMode.EarlyExecution` | Keep | Use **only where an early-stage voter result is mathematically irreversible**. Do not enable for the 14-/30-day community voting stage. It does not itself override SPP's `state()` veto duration |
| Existing IPOR votes plugin | Keep | One-call authenticated self-delegation and activation of existing shares, with verified direct/lending holdings |
| One ZK verifier | Keep | Genuine RISC Zero guest + authenticated historical state and verifier-bound root/membership; no independent governance authority |

**Bytecode goals:** each deployed implementation under 24,576 runtime bytes (target ≤22,000 bytes for the adapted token plugin), measured with pinned compiler. The earlier 33,300-byte mono-plugin draft is deliberately retired for this architecture; no v9 bytecode has been compiled. SPP already exists as official code; source modifications must be checked for size and Aragon Setup compatibility rather than treating it as a new implementation.

**No tests or deployment executed by this specification update.** The existing Ethereum authenticated fork procedure remains mandatory before any mainnet deployment. Live fork must show both installed plugins, actual permission graph, Safe veto/early approval/silence, Stage 2 full 14 days, Guardian-removal Stage 1 bypass, complete removal economic quorum with verified RISC Zero proof, lack of existing-proposal invalidation and nonrestorability, and actual gas costs.
