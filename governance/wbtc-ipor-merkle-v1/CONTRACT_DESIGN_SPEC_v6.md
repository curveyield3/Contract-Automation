# WBTC IPOR DAO — Lean Aragon Plugin Redesign v6
## Source-confirmed bloat diagnosis and replacement implementation authority

**Design status: APPROVED USER REQUIREMENTS PRESERVED; IMPLEMENTATION REDESIGN SPEC ONLY.** This file supersedes `CONTRACT_DESIGN_SPEC_v5.md` as the active design authority. The v5 contract sources are retained as a *diagnostic baseline only* and are **not deployable**. Do not relabel the existing v2 voting plugin as a corrected slim plugin. No tests are created or executed by this design step.

### 1. Exact measured sizes, not assumptions

| Artifact | Runtime bytes | Source / conditions |
|---|---:|---|
| Live Aragon `TokenVoting` v1.4 implementation | **19,149** | Verified Ethereum mainnet at `0xbbc277951d93e866700471f71616b2c9d304e6f6`; Solidity 0.8.28, optimizer runs 200; exact verified bytecode size. |
| First custom voting plugin build | **34,733** | Contract-Automation GitHub Actions run [42947135369](https://github.com/curveyield3/Contract-Automation/actions/runs/42947135369), Solidity 0.8.28, via-IR, optimizer runs 200. Compiled but EIP-170 deploy-size gate failed. |
| Smallest measured custom voting plugin | **33,300** | GitHub Actions run [42947343709](https://github.com/curveyield3/Contract-Automation/actions/runs/42947343709), Solidity 0.8.28, via-IR, optimizer runs 1. Compiled but EIP-170 gate failed. |
| Existing custom RISC Zero verifier adapter | **899** | Same small-size run; within limit. |
| Ethereum EIP-170 max runtime | **24,576** | Applies **individually** to every deployed contract implementation, even when created by Aragon DAOFactory. |

The custom plugin is **8,724 bytes over** Ethereum's limit using the best measured settings. Relative to the 19,149-byte live Aragon implementation it adds about **14,151 bytes**. This difference is a **directional comparison, NOT a controlled compiler-identical feature attribution**, because the live verified build may not use the same via-IR configuration.

The Aragon factory deploys the **DAO** and installs configurable plugins, but does not compress, merge, or exempt plugin implementations from EIP-170. A proxy does not avoid the implementation-contract bytecode limit.

### 2. Forensic root causes found in exact v2 source

**Inherited general-purpose Aragon base:** `contracts/src/base/MajorityVotingBase.sol` is approximately 765 source lines and includes **three** voting modes (including early execution and vote replacement), multiple settings and minimum-approval management, generic proposal-date validation, dynamic action arrays and target configuration, ERC165 and metadata framework extensions, permissioned setters, legacy compatibility entrypoints and multiple public query methods. The deployed original TokenVoting is already 19,149 bytes: there is only **5,427 bytes of headroom** if the complete base is retained unmodified. Most of those inherited interfaces are unnecessary for the requested fixed-stage protocol. Preserve the reviewed tally/DAO execution logic, but specialize/remove functions that are genuinely unused; do not change permissions or make them public to achieve smaller bytecode.

**Added parallel full protocol:** `WbtcIporTokenVoting_v2.sol` is approximately **963 lines / 47.6 KB of source** in addition to the inherited base, with **31 explicitly implemented public/external methods** (excluding 10 imported local interface declarations), before adding inherited Aragon functions and compiler-generated public state getters. It builds a second governance engine inside TokenVoting rather than minimally changing TokenVoting.

**Duplicated paths:** Standard atomic and optional ZK mode have different proposal constructors, metadata lifecycle, voting entrypoints, snapshot types and tally hooks. The v2 source includes two `createProposal` overloads, `createGuardianRemovalProposal`, `createMerkleStandardProposal`, `_createWeightedProposal`, `_createPendingMerkle`, `_vote`, `voteWithSpamFlag`, `voteWithMerkleProof`, and `_castWeightedVote`. Several duplicate ABI encoders, array copies and external wrappers are compiled for these paths.

**Proof machinery placed in voting plugin:** `SnapshotJournal` ABI decoding, domain/context checks, `MerkleProof.verify`, proposed root preparation and pending-proof bookkeeping are compiled into the voting contract even though **one dedicated proof-verification contract is already allowed**. The 899-byte verifier merely forwards the receipt to an existing RISC Zero router, wasting the available second contract's size budget.

**Excess generated getters / state:** At least **33 individually public state declarations** generate accessor bytecode, in addition to four market/voter getters and inherited getter APIs. There are many parallel `mapping(uint256=>...)` values for one proposal and several redundant standard/merkle flags and state histories. Storage declarations and loops are not large bytecode solely because of array length, but public getters, ABI decoding, branching, packed/unpacked reads and repeated validation all accumulate runtime code.

**Gas-unbounded enumerations:** `_freezeAtomic` loops all activated voters; `_rawSources` loops markets; `_active` calls `_misses`, which loops all prior proposals, yielding worst-case work proportional to **voters × (prior proposals + markets)**. This is an operational bug even if code size were fixed, and optimizing bytes alone would not make proposal creation reliable at large membership.

**Not the primary causes:** The 13 KB **source text** of `BokkyPooBahsDateTimeLibrary` is not necessarily embedded entirely: Solidity only emits referenced compiled functions. The Merkle hash primitive itself, error/event strings, and raw number of storage mappings are not by themselves an 8.7 KB explanation. No bytecode-level function-by-function ablation measurement has been completed; do not invent precise byte savings for individual features.

### 3. Revised deployment: exactly three governance entities total

1. **Already deployed Aragon DAOFactory** `0x246503df057A9a85E0144b6867a828c99676128B` creates one ordinary OSx **DAO**. The DAO retains its own treasury and permission manager; do not copy that code into the voting plugin.
2. **ONE newly deployed custom voting plugin** derived from the already deployed, source-pinned Aragon `TokenVoting` v1.4. DAOFactory-generated DAO is bound directly through the Aragon `Plugin` base; DAO authorizes plugin through its existing scoped `EXECUTE_PERMISSION`. No new PluginSetup, extra voting tokens, custom DAO, Guardian contract, market registry contract, action-policy contract, voter-registry contract or proxy implementation pair.
3. **ONE newly deployed ZK verification contract** calling the **already deployed RISC Zero** verification router `0x8EaB2D97Dfce405A1692a21b3ff3A172d593D319`. It is *only* a deterministic validation/read function, without the ability to create/execute/cancel/veto governance proposals or grant DAO permissions.

Existing IPOR vault-share token (and its already existing voting support), Morpho Blue and approved CurveLend contracts are read/called; they are **not additional governance deployments**.

### 4. Lean plugin architecture: one state machine, no duplicate framework

**Retain exactly one proposal-state transition core** with `ProposalKind` = Standard or RemoveGuardian, `SnapshotMode` = Atomic or VerifiedMerkle, and `Stage` = PendingProof / GuardianReview / Voting / Completed / Vetoed / Expired. Mode changes *how the immutable voting distribution is established*, NOT how votes, quorum, approval or execution are counted.

**One proposal constructor path**, `createProposal(kind, mode, metadata, actions)`, with:
- Standard default `Atomic` and available explicit `VerifiedMerkle`.
- Guardian removal forced to **VerifiedMerkle** until there is a mathematically complete onchain economic-supply source; one exact authorized action to `permanentlyRemoveDaoGuardian()`, encoded by plugin, zero ETH, no extra actions.
- Only one immutable per-proposal configuration snapshot (quorum numerator/denominator, approval ratio, duration, stage deadline, voting-source root or stored atomic weights, proposer, escrow bond, decision flags).
- 10% eligible active proposer threshold, checked against **the exact snapshot**, not stale delegated total supply. At creation, a Merkle-backed proposal is pending until the proof proves both creator qualification and full distribution; no voting is possible before successful receipt verification.

**One voting implementation**, `_countVote(id,voter,choice,weight,markSpam)`, with two very small authorization/data-acquisition wrappers (existing Aragon compatibility function for onchain frozen weight; verified membership proof for Merkle). The same tally/participation/spam accounting and single-vote protection must run for either. Stop maintaining independent per-mode voter/tally implementations.

**Move proof-specific logic into verifier:** Put the canonical journal ABI decode, approved guest image check, chain/DAO/plugin/nonce/anchor/config binding, authentic source/result checks, proposer inclusion proof, and *Merkle voter leaf verification* into the **single existing ZK contract**. It returns only authenticated typed snapshot outputs, bound to a pending proposal provided by our plugin. The plugin still checks its own immutable proposal ID, mode, allowed transition, and threshold before recording output. This preserves the security boundary while reducing plugin runtime bytecode; the verifier cannot decide a vote or execute an action.

**One compact market adapter calculation in plugin** for the **standard default atomic path**: direct unwrapped vault shares 100%, source-confirmed Morpho Blue collateral and CurveLend LLAMMA attributable shares 50%, approved markets only. Avoid compiling per-market registration code multiple times. Config-changing functions (market, voting limits, spam and inactivity settings) are callable only through normal, executed DAO votes with exact target/selector/value permissions.

**Compact voter registry and missed-vote logic:** Registration and signed self-delegation in one transaction; snapshot only active and eligible voters. Maintain a bounded/efficient *eligibility-aware* missed-proposal accounting model; no unbounded scan across every historical proposal on each new snapshot. If constant-cost exact missed-history accounting is impossible without authenticated offchain help, require a proof or explicit bounded settlement; do **not** guess that all users were eligible or let old registered addresses silently expire without two eligible missed proposals. The first missed completed eligible proposal starts the 3-calendar-month clock; activity resets the missed streak. A dormant DAO with no proposals must not expire everyone.

**Remove unnecessary inherited features** only after source-level interface reconciliation: no vote replacement, no ordinary early execution, no generic min-approval setter, no arbitrary execution-target change, no UUPS/plugin upgrade surface, no extra alternate proposal ABI entries. Preserve the official Aragon `Proposal` tally and `DAO.execute` semantics, the needed Aragon app-compatible functions, and all authentication. Do not remove an interface needed by the intended Aragon GUI without documenting the UI compatibility effect.

**Private state by default:** Replace dozens of public mappings with one compact internal per-proposal struct and only a few required read-only public status/query functions. This is a bytecode optimization; it must not remove the ability for voters and the GitHub prover to determine snapshot/eligibility data. Preserve immutable proposal commitments and sufficient events for offchain completeness proofs.

### 5. Exact voting policy — NO behavioral simplification

| Requirement | Standard | Remove DAO Guardian |
|---|---|---|
| First stage | Safe-only optimistic review for up to 7 days; Safe Yes immediately opens stage 2, Safe No permanently vetoes, silence advances after deadline | **No Guardian review or veto** |
| Voting period | 14 days after security review | 30 days |
| Quorum | 25% of snapshot **activated, nonexpired** voting power; unactivated shares contribute zero | 33% of whole vault economic voting power **including** inactive, undelegated and unactivated holdings, with approved lending collateral at 50%; no Safe bonus |
| Approval | >=67% Yes/(Yes+No); abstentions count for quorum | >=75% Yes/(Yes+No); abstentions count for quorum |
| Voter requirement | Activated, nonexpired | Continuously active >=3 calendar months at snapshot |
| Proposal threshold | >=10% of active total, including Safe bonus only where permitted | >=10% of *eligible qualified voting power*, without Safe bonus |
| Bond | 0.001 vault shares | 0.005 vault shares |
| Bond return | Refund unless majority of participating voting power flags attack/spam and relevant quorum met; normal No/veto alone is not spam | Same spam rule |
| Approved execution | Exact scoped vault/configuration calls via Aragon DAO permissions | Exactly one call to permanent Guardian removal function; irreversible |
| Voting power | Direct shares 100%, approved Morpho/CurveLend 50%, Guardian Safe gets fixed **15% of active total** (not 15% of community) | Same source 100%/50%, **no Safe bonus**; Safe's actual owned shares qualify only by the ordinary strict eligibility rule |

For standard votes with Guardian in force: community weight `85*base`, Safe bonus `15*sum(communityBase)`, total `100*sum(communityBase)` (integer-exact). Do not double-count Safe's ordinary wallet holdings in its bonus power. Guardian removal permanently disables Stage 1 and all future bonus allocations. It cannot be restored through any mutable setter, privileged alternate executor, plugin swap or upgrade.

Other required settings: 3-calendar-month inactivity with at least 2 **eligible missed** proposals; configurable through a successful standard DAO proposal. Market registration is likewise DAO-governed and only accepts validated Morpho Blue and CurveLend collateral sources for the exact vault-share token.

### 6. Code size/gas acceptance budgets and implementation order

**Target (not yet achieved):** runtime plugin <= **22,000 bytes** under the final production compiler, optimizer and EVM target, leaving 2,576-byte margin below EIP-170; verifier separately <=24,576 bytes. Actual measured build must be below the limit, not just source line count. Gas must be measured for atomic snapshots at realistic voter/market/proposal counts before declaring that default mode operational.

Work in place on the development branch, preserving unmodified upstream Aragon references and using new explicit version filenames:

1. Recompile the unchanged deployed-source-derived Aragon voting baseline with the exact same compiler, optimizer, via-IR and EVM settings as the custom build. Record **controlled** baseline differences and actual function/code-size ablations where useful. Do not add tests to do so; compilation/bytecode inspection is separate from testing.
2. Specialize the existing copied `MajorityVotingBase`: eliminate unreachable generic early voting, replacement, min-approvals, and metadata/target admin only when not needed by requested Aragon interoperability. Preserve Aragon DAO execution and tallies. Measure new runtime after each necessary source reduction.
3. Replace v2's multiple proposal code paths with one stage machine and one compact proposal record. Reuse existing standard Aragon proposal ABI only where it does not enable bypass. Measure runtime and gas.
4. Transfer proof journal/leaf validation from the plugin into the **same single ZK verifier**. It must still enforce actual RISC Zero guest authenticity; do not use mock proofs or fall back to unverified Merkle commitments.
5. Simplify the source market list and voter status mechanism while preserving exact inactive/quorum and Guardian-removal requirements. Source-wide removal census must be complete and cryptographically authenticated.
6. Ensure factory deployment, plugin DAO bindings, restricted permission topology and unchangeable removal logic. Do not create redundant setup contracts just to wire existing permissions.
7. Compile exact two contract builds, measure runtime, resolve every compiler/sizing issue. The real authenticated ZK guest and source-bound fork rehearsal are **still necessary** before a mainnet deployment. **No tests are authorized by this design-only update.**

### 7. Current known blockers

- Current v2 plugin compiles but is not EIP-170 deployable; proof adapter compiles and is small.
- The existing verifier adapter is not a real authenticated ZK guest/host program; it only verifies externally supplied RISC Zero receipts against a pinned image ID.
- The complete global unactivated/undelegated market-adjusted removal denominator is not proven.
- Exact source-authenticated Curve market allowlist / potential rehypothecation double counting unresolved.
- Exact no-keeper missed-proposal continuity across arbitrary Merkle and atomic snapshots unresolved.
- Aragon factory DAO permissions and eventual app indexing must be verified with the real deployed contracts.
- No full mainnet-fork rehearsal or security audit has passed.

**Do not present this design document as an implemented or verified v6 contract.** The next artifact after code refactor should be a versioned v3 plugin source paired with the retained v1 proof contract until that contract is itself revised to v2. Do not introduce extra governance contracts.
