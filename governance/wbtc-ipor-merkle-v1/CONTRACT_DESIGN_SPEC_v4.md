# WBTC IPOR Vault Aragon OSx Governance — source-bound contract design specification v4

**Status:** exact upstream/source baselines collected; contract adaptation is **NOT COMPLETE** and nothing here is deployable. This is the first contract-development deliverable, not a claim that the DAO has been coded, compiled, audited, or fork-tested.

## Authority and aim

Implement the user's latest governance requirements in **one Aragon OSx governance plugin with two proposal kinds**, using existing protocol source with the smallest safe modifications. Do not create an unrelated governance token, do not move to Aragon v1, and do not replace the IPOR vault ERC-20. Existing fork/proof preparation workflow remains at `.github/workflows/wbtc-ipor-merkle-proof-v1.yml` on main; this branch changes no workflow and creates or runs no tests.

## Source inventory — pinned identities

| Exact source | Commit | Role | Actual source status |
|---|---|---|---|
| `aragon/token-voting-plugin/src/TokenVoting.sol` | `e726c28061486114d601c547e4da1180ed5ab6da` | **Executable Aragon OSx governance foundation** | Original copied unchanged to `contracts/reference/TokenVoting_OSx_v1.4.sol`, SPDX AGPL-3.0-or-later |
| `aragon/token-voting-plugin/src/base/MajorityVotingBase.sol` | same | Preserve core proposal tally/execute framework | External pinned upstream dependency, not duplicated |
| `aragon/staged-proposal-processor-plugin/src/StagedProposalProcessor.sol` | `a1d84e0542cf2db0a542f0159878457dbb7e3515` | Reuse stage transition/veto semantics; **do not install as separate plugin** | Original copied unchanged to `contracts/reference/StagedProposalProcessor_OSx_v1.sol`, AGPL-3.0-or-later |
| `TurmericLabs/voting-aggregator-app/contracts/VotingAggregator.sol` (`@aragonone/apps-voting-aggregator@1.0.1`) | `bec6f0aa472f03e04b5276ca7092c3320095d1cd` | **Original Gardens weighted-source design**: source list, source weights, checkpoints, aggregation | Original copied unchanged to `contracts/reference/VotingAggregator_Aragon1_legacy_v1.sol`, package license `GPL-3.0-or-later OR AGPL-3.0-or-later` |
| `curveyield3/ipor-fusion/contracts/vaults/plugins/PlasmaVaultVotesPlugin.sol` | `632350d6a31afbe7a306f0e6458bb4794c18c624` | Existing vault delegation, checkpoints, signature delegation | Reuse from pinned existing IPOR repository; **BUSL-1.1** license; not copied/modified here |
| `curveyield3/ipor-fusion/contracts/interfaces/IPlasmaVaultVotesPlugin.sol` | same | Signature/IVotes interface | Reuse by dependency |

**Compatibility fact:** the original Vote Aggregator is Solidity `0.4.24`, imports AragonOS v1 `AragonApp`, MiniMe-style `balanceOfAt`, and ERC900 source calls. Aragon's current TokenVoting is Solidity `^0.8.8` and uses Aragon OSx `IVotes`. The original aggregator may **not** be treated as a deployable OSx plugin. Preserve its `PowerSource` / enabled-weight checkpoint / `_aggregateAt()` concepts while adapting only the source interfaces needed for this vault.

## Final contract boundary, minimal-change strategy

**Existing base:** fork `TokenVoting.sol` into the canonical contract implementation only when modifying it. Preserve Aragon's inherited `MajorityVotingBase` and OSx permission/execute internals wherever possible, pin its dependency versions, and retain the original AGPL attribution. Use the original `StagedProposalProcessor` state-machine behavior *inside* this single modified voting plugin rather than installing a second governance plugin. The market aggregation approach is adapted from the pinned original Gardens aggregator, not reinvented as a transferrable governance token.

**Supporting pieces only where essential:** IPOR's existing `PlasmaVaultVotesPlugin`, view-only Morpho/CurveLend position adapters, user activation registry/state, immutable guardian constitution guard, and the RISC Zero verifier interface. They are auxiliaries of **one governance plugin**, not independent proposal/voting plugins. The same source-derived accounting specification must run in atomic and ZK-Merkle modes.

Do **not** copy the IPOR BUSL-1.1 implementation into AGPL files without confirming compatible licensing. Keep IPOR as a separately imported dependency and review licenses before distributing a derivative binary.

## Exact Aragon source modification map

| Base member | Necessary change | Keep unchanged |
|---|---|---|
| `TokenVoting.initialize(...)` | Initialize immutable/pinned vault/share token, Safe, proposal-kind settings, snapshot verification references; preserve OSx initialize/DAO binding | inherited OSx plugin initialization |
| `TokenVoting.createProposal(...)` | Accept **proposal kind**, collect bond **after** snapshot, check proposer threshold, pin metadata/actions and kind-specific settings, enter Safe-review or guardian-removal ballot | `Proposal` storage/event/DAO ID and existing action hashing wherever valid |
| `TokenVoting.totalVotingPower(timepoint)` | Replace raw `getPastTotalSupply` denominator with **proposal-kind-specific, filtered** power; no unactivated supply for standard proposals | existing support/quorum math functions when parameterized correctly |
| `TokenVoting._vote(...)` | Get **frozen proposal-specific** weight; mark successful participation; count Yes/No/Abstain; keep separate spam flag tally; reject guardian bonus in removal kind | tally updates and VoteCast event convention |
| `TokenVoting._canVote(...)` | Check frozen eligibility and weight, single counted vote; 3-month continuous activation for removal | voting-period bounds and no None vote |
| `MajorityVotingBase._hasSucceeded / _canExecute / execute` | Bind duration/quorum/support to kind-specific proposal snapshot and enforce stage progression/guardian action restrictions at execution | DAO permissioned action execution mechanics; do not weaken these checks |
| `StagedProposalProcessor` transitions | Adapt Safe-only optimistic veto stage with max 7 days; Yes advances immediately, No permanently rejects, silence advances at deadline | stage state/event and replay prevention patterns; **do not deploy a second plugin** |
| `VotingAggregator._aggregateAt()` | Adapt weighted source registry to vault-wallet, Morpho vault-share collateral, CurveLend attributable collateral; apply 1x direct, 0.5x market; snapshot market allowlist/weights | source enable/disable/history and aggregation invariants |

The original `TokenVoting` `createProposal`, `_vote`, `_canVote` and `totalVotingPower` overrides are **not all marked virtual**. Do not claim this is a simple subclass override. Forking the maintained Aragon source and minimally changing its internal implementations is required. TokenVoting's `MajorityVotingBase` permission and execution gates must remain authoritative.

## Active voter mechanics and checkpoint rules

- `activateVotingPower(...signedDelegation)` executes **one transaction**. Read signer `msg.sender`, call IPOR vault `delegateBySig(msg.sender,...)` against an EIP-712 signature, confirm `delegates(msg.sender)==msg.sender`, add/update voter registration and continuous-active-since epoch, reset missed-proposal streak. If already self-delegated, permit activation without requiring a new signature, with explicit authorizer check. Never allow an arbitrary caller to activate somebody else using an unbound signature.
- A contract wallet lacking EIP-1271 delegation support cannot be silently treated as self-delegated. Preserve a separately authorized activation path only if supported by the actual vault integration; the Guardian Safe uses its special address path.
- No registry registration => zero standard power, even if tokens are delegated by a separate transaction. An expiry => zero new-proposal power.
- The first **closed proposal on which an eligible voter did not vote** starts the missed-proposal clock, **not** activation. It expires after **both** 3 calendar months and >=2 eligible closed missed proposals. A vote resets both. No proposals => no new misses. A zero-weight/non-eligible proposal does not count as a miss. Reactivation restarts the special three-month continuous-active qualification. Existing frozen proposal eligibility never changes retroactively.
- Standard ERC20Votes `getPastVotes` is **delegated power**, not necessarily raw share balance. Self-delegation on activation does **not** guarantee an address will never delegate away later; the vault plugin does not expose checkpointed raw `balanceOfAt`. Direct-share accounting therefore needs either (a) a minimal **raw-balance checkpoints extension** to IPOR's existing votes transfer hook for the new vault, or (b) genuine on-chain atomic current-block `balanceOf` snapshots and authenticated historical balance proofs in ZK mode. Do **not** count arbitrary delegated votes as independently owned vault shares or mix current balances with a historical clock point.

## Voting-power formulas

For registered active community voter i at a single canonical snapshot:
`B_i = directVaultShares_i + floor(morphoAttributedShares_i/2) + floor(curveAttributedShares_i/2)`.

For standard proposals: exclude the Guardian Safe from community `B`; sum community base `C = sum B_i`. Store per-community weight `W_i=85*B_i` and Safe bonus `W_safe=15*C`. Total `W=100*C`, exactly 15% Safe, no division rounding and no Safe additional direct-share weight for **standard** voting. If `C==0` no standard quorum/proposal can open. Exclude users who have not activated or whose inactivity conditions have elapsed.

For **Remove DAO Guardian**: **no Safe bonus** at all. Use unscaled base voting units, and permit the Safe's *real* vault-share holdings only if it independently meets the same holder qualification; the Safe's previous bonus never counts. Registered voter qualification is continuously active >=3 calendar months at snapshot. Quorum denominator counts **all vault-share economic weight** (including undelegated/unactivated/inactive), with market collateral discounted 50%, and must not double count custody balances. It **must not** use `getPastTotalSupply` as voting power without the custody reclassification: direct/raw supply plus discounted market positions are different quantities. Proving global market totals and supporting historical snapshots is mandatory. If qualified voters have <33% of the resulting denominator, the removal vote is mathematically unable to meet quorum; do not silently shrink the denominator.

**Morpho:** only configured Morpho Blue market IDs where this exact IPOR share token is collateral; read `position(id,user).collateral`; **do not** treat `supplyShares` in an unrelated lending asset as vault-share collateral. For the special whole-supply denominator, use correctly authenticated source-wide collateral totals, not the sum over registered voters. Addresses custody at Morpho must not also be counted as direct ownership.

**CurveLend:** accept only the approved controller/AMM and vault-share collateral asset. Include actual user's attributable token collateral after soft-liquidation conversions rather than pre-liquidation deposits; use official controller/AMM interfaces and their exact token-scale conversion. For whole-supply aggregation, prove the full aggregate share custody and ownership accounting. Do not count both AMM vault-share balance and borrowers' attributable shares. Unsupported lender vault-share assets, intermediate wrappers, and rehypothecated claims are excluded until separate explicit DAO-governed adapters are specified.

An approved market gets **50%** base weight; wallet-held vault shares **100%**. All changing source weights and market additions apply to future proposal snapshots only. Market addition is a STANDARD proposal executing an allowlisted `addVotingMarket` function, validated against real Morpho/CurveLend market token identities. Snapshot source rules/contract code hash must match the ZK program.

## Standard proposals — stage and governance rules

- **Stage 1:** only the designated Safe may report its security assessment. `Yes` immediately moves to Stage 2; `No` vetoes permanently; no action before 7 days => **anyone may advance** with a transaction after deadline, without Safe participation. "Automatic" means no veto is required; state-dependent transactions still require an executor/keeper or the next user interaction. Do not assume the EVM executes timers autonomously.
- **Stage 2:** 14 days; 25% quorum of activated+nonexpired proposal snapshot weight; 67% Yes/(Yes+No) approval. Abstain counts for quorum but not support. No early final execution within this period.
- Proposer needs >=10% of total activated standard weight; bond 0.001 **vault-share token units after its decimals conversion** (do not hardcode `1e15` without checking decimals); lock after snapshot; refund after settlement except successful spam designation per explicit majority of participating weight, with stage-relevant quorum met. A Guardian veto alone is *not* a spam designation.
- All governance configuration, quorum, period, market changes, weighting, spam thresholds and bonds are modified only via **approved permitted standard proposal execution**, not by direct owner calls. Snapshot settings frozen per proposal. Guardian cannot unilaterally update parameters.
- Safeguard the category: no `delegatecall`, wildcard target, arbitrary ERC20 approval, or generic multicall route may circumvent the allowlisted function selector/target/value policy for Guardian removal.

## Remove DAO Guardian — protected proposal kind

- Explicit `ProposalKind.REMOVE_GUARDIAN`; no Safe veto stage, no Safe bonus or Safe role voting; 30-day ballot; 33% quorum **including unactivated/undelegated/inactive weighted economic vault supply**; 75% Yes/(Yes+No) support; proposer 10% of *eligible three-month-active power* (the prior specification carried this threshold forward); bond **0.005 vault shares**; successful spam declaration uses this kind's own quorum.
- Only executable action is the *sole* zero-value call to `permanentlyRemoveDaoGuardian()` at the designated **non-upgradeable** Guardian constitution contract. Check selector, target, action length=1, allowFailureMap=0 and operation type=CALL at **both creation and execution**; freeze action hash. No extra actions.
- Removal is irreversible: Guardian bonus = 0 for all future standard votes, Safe-only Stage 1 disabled permanently, and Safe cannot act as proposal guardian. The Safe may still possess real vault shares with their ordinary holder rights.
- **Critical upgrade boundary:** an ordinary upgradeable Aragon plugin storage bool cannot guarantee permanence. The constitution / root DAO permission setup must prevent an upgrade, permission change, alternate executor or arbitrary DAO action from restoring or bypassing guardian power. Mark these permissions **NOT DEPLOYABLE** until the actual OSx DAO permission topology and immutable enforcement have been audited on the production bytecode. Do not make a misleading irreversibility claim based solely on storage.

## Proposal snapshots and ZK verification

- Default atomic: snapshot all eligible registered addresses/positions in one EVM transaction at one consistent state, with explicit bounded gas cost. Proposal acceptance cannot depend on partial multi-transaction live balance collection.
- Optional ZK Merkle: create pending proposal with a **canonical anchor** (chainId, DAO, plugin, proposal nonce, snapshot block hash and authenticated state commitment, source allowlist/configuration hash, code/rules IDs). Historical chain state authentication includes the complete registered-voter set, all relevant Morpho/CurveLend balances and global special-proposal supply. Generate tree, RISC Zero receipt, journal and proof offchain. Never accept a bare Merkle root.
- Onchain custom plugin verifies the approved RISC Zero verifier `verify(seal, approvedImageId, journalDigest)` and checks all journal public inputs to a locked pending proposal. Only then stores the immutable root/aggregate eligible total/denominator and opens 14-day or 30-day voting. Each voter submits the correct weighted Merkle inclusion proof; no double-voting, no stale source/anchor reuse.
- A ZK proof generated using dummy/dev mode, unpinned image ID, unauthenticated RPC assertions, omitted eligible voters, or omitted global market supply for Guardian removal is **NOT valid** for acceptance.
- The existing GitHub workflow and authenticated Anvil fork runner are available for integrating source-bound simulation once the contract, prover and setup are implemented; they do not currently constitute proof of correctness.

## Ordered source adaptation, with no unnecessary replacements

1. **Baseline (this commit):** pin exact Gardens aggregator, Aragon TokenVoting and staged processor code; pin existing IPOR Votes plugin external dependency; document method-by-method changes and unresolved security constraints.
2. Adapt Aragon's `TokenVoting` *in place within a source fork* to store proposal kind, frozen category settings, execution allowlists and bonds, preserving inherited Aragon OSx permissions/events. Do not rewrite `MajorityVotingBase` unless a specific blocker demands it.
3. Adapt Gardens weighted `_aggregateAt` source-pattern to IPOR raw share balance plus validated Morpho/CurveLend market adapters and 50% weights, with separate standard and special supply denominators.
4. Integrate one-tx registration/self-delegation and missed-proposal accounting; reconcile direct-share history at a single snapshot anchor.
5. Adapt staged-state logic from Aragon's existing StagedProposalProcessor into the *same* custom plugin. Hardwire special proposal bypass and independently enforce one-way guardian termination.
6. Implement RISC Zero Steel guest/host and onchain receipt verifier binding to identical source accounting; stage and verify a complete Merkle root before accepting votes.
7. Source-bind the existing GitHub fork-full runner to the actual contracts and verifier; exercise the user-authorized Ethereum live-fork rehearsal, record real receipts and gas, and fix observed failures before ever considering mainnet.

**No mainnet deployment, no claim of compile success, and no testing has occurred in this baseline step.** This spec states explicit implementation requirements, not implemented behaviors.
