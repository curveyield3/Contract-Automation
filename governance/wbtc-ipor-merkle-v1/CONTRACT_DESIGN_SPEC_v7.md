# WBTC IPOR DAO — Native Aragon TokenVoting Specification v7

**Status:** design rewrite completed; Solidity v3 replacement **not implemented, compiled, or fork-tested**. Existing `WbtcIporTokenVoting_v2.sol` is the superseded 33,300-byte experimental implementation, not the v7 design. This specification supersedes `CONTRACT_DESIGN_SPEC_v6.md`; Git history retains v6. Do not deploy v2 or claim v7 has passed checks.

## 1. Architecture and binding — unchanged scope

Exactly **one custom voting plugin and one custom ZK verifier**, both bound to one ordinary Aragon OSx DAO created by the *existing* Ethereum DAOFactory. No other project-specific governance contract, voting-token replacement, market registry, staging manager, guardian, action policy, or PluginSetup is authorized.

- Official DAOFactory mainnet: `0x246503df057A9a85E0144b6867a828c99676128B`.
- Most similar **deployed** plugin: official Aragon **TokenVoting v1.4** implementation `0xbbc277951d93e866700471f71616b2c9d304e6f6`, pinned source `aragon/token-voting-plugin` commit `e726c28061486114d601c547e4da1180ed5ab6da`.
- Official Aragon OSx base source: `TokenVoting.sol` + `MajorityVotingBase.sol` + the existing `Plugin` / `Proposal` / `MetadataExtension`. Do **not** reimplement the voting engine, tally mathematics, DAO permission mechanism, metadata events, or proposal execution.
- Existing RISC Zero router on Ethereum: `0x8EaB2D97Dfce405A1692a21b3ff3A172d593D319`. One custom proof-verifier contract may implement only necessary receipt, journal, historical-source, Merkle and membership verification. An actual source-authenticating RISC Zero guest/host is still required; the existing 899-byte proof adapter is insufficient for complete correctness.
- The WBTC IPOR vault share ERC-20 / its existing IPOR `PlasmaVaultVotesPlugin`, Morpho Blue and verified CurveLend contracts are **external existing protocol contracts**; never redeploy them as new governance modules.

The factory accepts an empty `PluginSettings[]`: create the DAO first, deploy the constructable non-upgradeable Aragon-derived voting plugin directly with the resulting DAO address, then deploy the verifier bound to plugin+DAO; the factory creator uses the temporary permission window to grant the plugin the DAO's `EXECUTE_PERMISSION`, bind the verifier and revoke all temporary external creator authority **last**. Because this is a direct permission installation, Aragon's factory/plugin-repository indexed UI may need a separate integration to display the custom governance process; do not claim factory-installed PluginRepo registration.

## 2. Preserve Aragon source first; only change actual incompatible behavior

Aragon already contains **proposal storage, proposal IDs, Yes/No/Abstain tally, per-proposal duration/support threshold/minimum participation, ordinary vote permissions, execution readiness, DAO execution, delegation-based token voting and metadata events**.

The lean plugin must be a source fork with minimal, documented edits to the *existing* code. All code that implements these original functions a second time must be removed. There must be **one** proposal record, **one** lifecycle and **one** vote-tally function.

| Original method / mechanism | Use unchanged wherever possible | Narrow change only if unavoidable |
|---|---|---|
| `Plugin(IDAO)`, `dao()`, `auth(bytes32)` | Bind to factory-created DAO and defer authorization to OSx | Use existing non-upgradeable `Plugin`; do not add our own owner/admin role |
| `Plugin._execute()` → `DAO.execute()` | Execute proposals through OSx only | Pin DAO as sole CALL target; do not allow target redirection, delegatecall or wildcard privileges |
| `Proposal._createProposalId()` | Source of unique proposal IDs | Add nonce salt only if existing contract uniqueness requires it; no separate ID engine |
| `ProposalCreated`, `ProposalExecuted`, `VoteCast` | Emit canonical Aragon events | Extra type/review/proof/activation events only where useful |
| `MajorityVotingBase.Proposal` / `ProposalParameters` / `Tally` | Canonical single proposal state | Add a **small companion per-proposal extension** (`kind`, `snapshotMode`, `reviewStatus`, `proofCommitment`, `bond`, `guardianEpoch`), not a parallel `Proposal` struct |
| `createProposal()` | Reuse source implementation of store actions/snapshot/tally parameters | Restricted entry wrapper computes source-specific frozen denominator, 10% creator check, deposit, kind and review stage. Use **one internal creation path** for both kinds and both snapshot modes |
| `vote()` → `_canVote()` → `_vote()` | Existing tally/event/single-voter machinery | Replace raw `getPastVotes` source with authenticated frozen direct/market weight; require activation/age for correct category; optional membership proof resolved by verifier before calling same tally |
| `getVoteOption()`, `getProposal()`, `canVote()`, `canExecute()`, `hasSucceeded()` | Keep for Aragon interoperability and block explorer | Continue to expose category/snapshot additional status separately without duplicating these views |
| `isMinParticipationReached()` | **Already checks** Yes + No + Abstain vs `parameters.minVotingPower` | Set `minVotingPower = ceil(categoryQuorumRatio * correctCategoryDenominator)` once when snapshot accepted. No alternate quorum engine |
| `isSupportThresholdReached()` | Already uses `parameters.supportThreshold` per proposal | The original uses strict `>`; user requires **inclusive >=67%/75%**. Make **one comparison adjustment** to exact inclusive acceptance, preserving overflow-safe ratio arithmetic |
| `_hasSucceeded()`, `_canExecute()`, `_isProposalOpen()` | Preserve normal end-of-ballot majority and non-reexecution checks | Standard: enforce Safe veto/review; removal: bypass Safe and require exact sole action. No early execution, no vote replacement |
| `_execute()` | Existing Aragon path marks executed and dispatches the full action array | Validate allowed targets/selectors and guardian epoch before calling `super._execute()`; do not build another dispatcher |
| `VotingSettings` / `updateVotingSettings()` | Existing DAO-permissioned governance configuration | Lock `VotingMode.Standard`; update only from DAO-executed approved Standard proposal; store category-specific settings compactly. **Do not create a second unrestricted settings API** |
| `Plugin.setTargetConfig()` | Existing DAO permission model | **Never grant** `SET_TARGET_CONFIG_PERMISSION_ID`; optionally specialize away the selector after exact compatibility review, but no custom target manager |
| `MajorityVotingBase.updateMinApprovals()` and legacy early-support helpers | Not part of required governance | Do not grant their setters; eliminate at compilation specialization only if reducing code and preserving required external interface. Always use 0 extra min-approval |
| `MetadataExtension` and `supportsInterface()` | Existing interface discovery and plugin metadata | Retain if needed by Aragon UI; do not duplicate metadata storage and events |
| `getVotingToken()`, `IVotes.delegateBySig()` and clock detection | Existing IPOR vault voting integration | Reuse existing vault token; ***do not*** equate third-party delegated `getPastVotes` with raw wallet shares, and never mint a separate vote token |

**Key fact:** Aragon `TokenVoting` supports one global set of default voting settings but already **stores support threshold, end date, snapshot timepoint and min-voting-power per proposal**. Thus two proposal *categories* require only small initialization/authorization differences, not a second vote lifecycle. Source: pinned `TokenVoting.sol` lines 155–222 and `MajorityVotingBase.sol` lines 178–214, 603–665.

## 3. Requirements implemented using existing core plus targeted extension

### Standard proposal
- Existing `createProposal` stores immutable actions/metadata and effective voting rules. Category is Standard.
- **Review stage** is a small per-proposal gate before the existing voting phase: the Safe may cast its one security review Yes (opens standard ballot immediately), No (vetoes irreversibly), or no vote (opens by timestamp after maximum seven days). Only `guardianSafe` can review. No additional "pre-vote" proposal/tally created.
- Once the community stage starts, existing `vote`, `canVote`, `_vote`, `hasSucceeded`, `execute` do the work; one existing `parameters.startDate/endDate` clock defines 14 days of voting. Quorum **25%** of activated, eligible voting power; approval **at least 67% Yes/(Yes+No)**; abstentions count toward quorum; no early execution or vote replacement.
- Creator needs **at least 10%** of frozen eligible power and transfers **0.001 vault-share token units** using the real token decimals. Bond returned after settlement except when **more than half of participating weight** explicitly flags spam/attack and required quorum is met. Losing, Guardian veto or proposal expiration alone does not cause forfeiture.
- Existing DAO action executor performs approved vault/configuration calls, not our own custom multicall. Zero native value and `allowFailureMap = 0`; validate exact allowed target/selector and reject every arbitrary execution, permission grant, upgrade or unsupported delegatecall route.

### Remove DAO Guardian
- Still a `Proposal` with its ordinary Aragon `Tally`; only `kind=RemoveGuardian` and exceptional per-proposal thresholds differ.
- **No Safe review/veto**. Active voting window **30 days**. **33%** quorum of *all economic vault-share weight*, including inactive, undelegated, unactivated holdings; approved lending collateral receives 50% credit as in ordinary voting. **At least 75% Yes/(Yes+No)**; abstain contributes only to quorum.
- A voter must have **continuously activated for at least three calendar months at snapshot**. 10% proposer threshold is based on the **qualified electorate** only, with no Safe bonus. Bond is **0.005 vault shares**, exactly 5× the standard bond.
- Safe 15% allocation is absent in both eligible power and denominator; any actual Safe-owned economic shares qualify only if independently eligible on the same basis as everyone else.
- The proposal's executable action array is **exactly one** zero-value call on the **one immutable voting plugin itself** to `permanentlyRemoveDaoGuardian()`, no user-controlled target/selector, no extra action, and no action failure allowance. Verify at creation **and** execution.
- One-way `guardianRemoved=true`; no reset, upgrade, mutable authority or alternative DAO executor may restore it. Once removed, future Standard proposals have no Safe review stage and no bonus. **All unexecuted proposals whose frozen weights contain the old Safe bonus are invalidated via a constant-time guardian epoch check**, not by looping past proposals. Their bonds must be refundable. Already-executed proposals are immutable history. This resolves the conflict between frozen historical votes and "Safe loses its bonus forever."

### Activation, voter inactivity and market weight
- Existing IPOR vault token's voting delegation is used. A **single activation transaction** self-delegates (`delegateBySig` or an already-self-delegated path) and records `activatedSince`; signatures must be bound to the actual holder, and explicit reactivation after expiry resets qualification.
- A user's Standard eligibility expires only after **both** >=3 calendar months from their **first closed eligible missed proposal** and **at least 2 closed eligible missed proposals**. Casting a qualifying vote resets the missed streak. If there are no eligible proposals, nobody accumulates missed votes. Inactivity configuration changes only via approved Standard DAO proposals and apply prospectively.
- Original Aragon `Proposal.voters[address]` already records whether a member voted. Reuse it. Do not add a duplicate ballot history or second tally. **The original does not count "eligible proposals this address missed"**; that accounting is genuinely new and needs either a bounded eligible-proposal checkpoint ledger or authenticated batch proof. A single global missed-proposal counter is incorrect when eligibility differs between voters; never misclassify all abstentions or non-eligible periods as "missed."
- Voting weight is `directRawVaultShares + floor(approvedMorphoAndCurveCollateralShares / 2)`. Direct raw vault shares 100%, approved market collateral 50%; Morpho uses the exact approved Blue `marketId` and user collateral, CurveLend uses its current LLAMMA collateral (after soft liquidation). Validate the *actual vault share token* and source code/factory identity; exclude custody double-counting.
- **15% Safe allocation** for Standard only: if qualified non-Safe base total is `B`, assign each community member `85*base_i` units and the Safe `15*B`, with total `100*B`. This yields exactly 15% with no integer division rounding. Once permanently removed, use unbonused qualifying positions.
- `addVotingMarket` / enable-disable registry is **one DAO-execution-only configuration extension** inside the plugin, not a second market-registry contract. Changes apply to future snapshot commitments, never rewrite historical voting weights.

## 4. One proposal snapshot mechanism, two data-acquisition modes

A proposal always has one canonical Aragon `Proposal` and a frozen `snapshotMode`. It is the **weight acquisition**, not the voting engine, that differs.

1. **Atomic (default for Standard):** in one bounded transaction, enumerate eligible activated holders and source positions, freeze per-voter weights and the eligible total, then store `parameters.minVotingPower` and `parameters.supportThreshold` using normal Aragon fields. Never fetch current balances during later voting. Disallow or switch to ZK mode when roster/markets exceed provable gas capacity; no silent partial census.
2. **Verified Merkle (optional Standard, required RemoveGuardian):** pending proposal anchors chainId/DAO/plugin/proposal ID, historical block hash, source configuration and category. Existing **single custom verifier** validates a genuine RISC Zero receipt against a **pinned, nonzero production image ID** and authoritative authenticated historical Ethereum state. The guest proves complete registered/activated census, per-voter market attribution, raw direct balances, no market/custody double counting and (for removal) all unactivated economic holdings. The verifier checks canonical journal/anchor/creator weight and Merkle membership. Only then may plugin commit the root/total/quorum and open the normal Aragon voting phase; voters submit membership proof to verifier to supply the weight that is passed into the **same inherited tally hook**.
3. **No fake validity claims:** a standard Merkle inclusion proof cannot establish a *complete or truthful* census. RISC Zero's receipt only authenticates execution of the pinned guest; the guest must actually authenticate chain state and completeness. No production guest exists yet.
4. **History continuity:** source-authorized eligibility, activation date and missed-vote status must remain correct across Atomic↔Merkle transitions. Until a complete authenticated continuity method exists, the mixed-mode path **must fail closed**, rather than treat unknown missed proposals as voted or never eligible.
5. No source accounts are sent to the prover merely for future reference; each question/round or snapshot needs only the exact source evidence required for that calculation. The pending root is immutable once authenticated.

## 5. What code changes are actually necessary

**We must not modify Aragon logic that already implements the requirement.** The minimally necessary customization surface is:

1. **DAO binding and unchangeable authority:** derive from Aragon's existing non-upgradeable `Plugin` class, use its constructor to bind factory-generated `IDAO`, permanently require CALL execution to that DAO and restrict permissions. No new setup/controller contract.
2. **One category flag + frozen settings:** alter the existing proposal creation path to write one immutable per-proposal `kind`, use the existing `ProposalParameters` to set the appropriate support/quorum/time values. Existing `_hasSucceeded` and quorum math remain; exact inclusive percentage comparison is the only needed math correction.
3. **One Safe review gate + permanent removal bit:** add `reviewProposal` (Safe-only) and the one-way `permanentlyRemoveDaoGuardian` method on the plugin, with the epoch-based stale-proposal lock.
4. **One voting-source function:** override `totalVotingPower` / `_vote` / `_canVote` at the existing Aragon hooks to use frozen authenticated market-adjusted weights and activation conditions. This **cannot** be accomplished with unmodified delegated `getPastVotes`; keep market registry/activity code in small private helpers of the plugin.
5. **One proposal bond and spam bit:** escrow on creation and settle on completion, using existing `Proposal.tally` for participation; do not create a second spam-proposal voting engine.
6. **Verifier interface:** only small plugin-facing `verifyAndExtractSnapshot` / `verifyVoterWeight` calls; journal decoding, ZK receipt verification and Merkle membership move into the **one** proof contract. A trusted verifier result must still be checked against pending plugin state. Do not issue unrestricted callbacks or use delegatecall.
7. **Source-confirmed current contract gaps:** optimize missed-eligible-proposal history and supply-wide removal denominator without extra contracts. These are mathematically nontrivial and must be proven, not approximated.
8. **Keep compatibility deliberately:** retain existing Aragon `createProposal` interface if safe by mapping old ABI into the sole proposal constructor, keep `getProposal`, `canVote`, `canExecute`, `execute`, `getVoteOption`, events, `supportsInterface`. Lock out `EarlyExecution`, `VoteReplacement`, `updateMinApprovals`, `setTargetConfig` and other undesired privileged actions by permission/configuration first; remove only unneeded compiled paths when compatible with intended front end.

**Do not** create a fresh governance framework, parallel proposal engine, parallel ledger of votes, separate market-discovery contract, guardian constitution contract, policy contract, plugin factory or UUPS proxy to implement these changes.

## 6. Exact Aragon permissions in factory deployment

- Factory deploys DAO. Creator initially has the limited temporary `EXECUTE_PERMISSION` given by factory; user must verify current factory's actual emitted permission changes on fork.
- Grant `DAO.EXECUTE_PERMISSION` **only** to the one voting plugin (and leave no alternate grant to external Safe, creator, owner or arbitrary role); all security-critical actions go through that plugin's ordinary approved execution.
- `CREATE_PROPOSAL_PERMISSION` may be public but the plugin must enforce the proposal-specific 10% threshold and bond.
- `EXECUTE_PROPOSAL_PERMISSION` may be public so that anyone can finalize an already-approved proposal; the plugin enforces timing, review state, exact actions and executed status.
- Settings changes through a normal DAO proposal call; use Aragon's permission manager instead of a separate owner role. `SET_TARGET_CONFIG_PERMISSION`, `ROOT_PERMISSION` to arbitrary addresses, `UPGRADE_PLUGIN_PERMISSION`, unchecked DAO permission/upgrade actions and any bypass routes **must not be granted**.
- Revoke the factory creator's temporary DAO execute grant only after binding both contracts and verifying their references. Confirm full onchain permissions and official proxy/DAO implementation.
- Unchangeable Guardian removal depends on this permissions graph. A one-way bit in the voting plugin alone does not prevent privileged DAO code from deploying or activating an alternative plugin.

## 7. Size, testing and release boundaries

Previous via-IR optimizer=1 build: **33,300 runtime bytes** for draft v2 plugin; existing verifier **899 bytes**; Ethereum EIP-170 limit **24,576 bytes**. Original official TokenVoting deployed runtime **19,149 bytes**. These builds are not compiler-identical, so the difference does not quantify individual features.

**v7 target:** plugin <=22,000 runtime bytes and verifier <24,576, measured using the *same* pinned production compiler and settings. Source complexity and function count are not bytecode measurements. Required savings cannot be guessed from file lengths. First compile the unmodified Aragon source with the same optimizer and compare, then consolidate duplicate code and measure again.

- The user's request here is a **specification redesign**, so v7 commits **no executable Solidity modifications**, no new workflows and no tests. Existing v2 Solidity is retained as a historic draft only.
- Source implementation is the next phase, and only source-confirmed edits to official Aragon TokenVoting and its existing base are authorized; no v4/v5 helper modules or unrelated infrastructure.
- The source must compile within EIP-170 before any deployment. No claims of production-ready validity without a real guest and historical state proof.
- The existing authenticated Ethereum Anvil fork lane must demonstrate the factory-created DAO, the plugin's actual permissions, every defined proposal behavior, market attribution and receipts, valid/invalid authenticated ZK proof acceptance, exact quorum economics, spam bond handling, Guardian removal irreversibility and gas scaling before mainnet. The current source has **not** passed that lane.
- No separate tests should be written or executed unless explicitly authorized. The already established fork audit process may be used when permitted; no new generic testing infrastructure is necessary.

## 8. Scope verification of all previously agreed design requirements

The redesign preserves: one plugin; one verifier; Aragon factory DAO; Standard (14d, 25%, 67%, 10%, 0.001 shares); Safe-only up to 7d first-stage veto/Yes/silence; Guardian bonus exact 15%; Guardian removal (30d, 33% whole economic supply incl inactive and undelegated, 75%, 3-calendar-month-qualified voters, no Safe bonus or veto, 0.005 bond, one permanent disable action); activation+self-delegation; 3-calendar-month plus 2 eligible missed proposals; DAO-configurable rules; spam/attack majority handling; approved Morpho and CurveLend markets at 50%; registration of new markets by standard proposal; atomic default and optional RISC Zero authenticated Merkle mode; no delegatecall or arbitrary actions; and full authenticated live-mainnet-fork rehearsal before deployment.

The fact that base Aragon already supplies **proposals, voting and execution** does **not** mean it already supplies complete raw vault-share multi-market census, inactivity or category-specific Guardian rules. Those are the necessary extensions described above, with their nontrivial proof/data dependencies explicitly retained.
