# WBTC IPOR DAO — Aragon Factory + One Voting Plugin + One ZK Verifier
## Design and source implementation specification v5

**Authority:** Latest user instruction replaces the v4 helper-contract architecture. Do not deploy the v4 WbtcIporWeightedSources, WbtcIporGuardianConstitution, WbtcIporActionPolicy, TokenVotingSetup, separate governance token, or custom proxy. Their prior experimental implementations remain available in Git history but are superseded and removed from this branch's active source.

**Status:** Source-derived draft implementation; **NOT COMPILED, NOT AUDITED, NOT FORK-TESTED, NOT DEPLOYABLE**. The RISC Zero guest program and fully authenticated position/census calculation remain incomplete. Do not claim that a successful Merkle membership proof authenticates its contents.

### 1. Exact, independently confirmed deployed foundations

**Ethereum mainnet Aragon DAOFactory**: `0x246503df057A9a85E0144b6867a828c99676128B`. Confirmed verified deployed `DAOFactory` via onchain bytecode and source. Official source: `aragon/osx/src/framework/dao/DAOFactory.sol`. Direct calls to `DAOFactory.createDao(DAOSettings, PluginSettings[])` with an **empty plugin list** create a normal, registered Aragon DAO and grant temporary `EXECUTE_PERMISSION` to the creator, while the DAO contract itself retains its own `ROOT_PERMISSION`. Factory's DAO implementation on Ethereum: `0x58C1F7Bc62Bb63fb137bc8F6d8ea6321a0501d29`. Neither implementation is redeployed by this project.

**Most similar existing and deployed voting contract**: Aragon **TokenVoting v1.4**, from `aragon/token-voting-plugin/src/TokenVoting.sol`, pinned commit `e726c28061486114d601c547e4da1180ed5ab6da`. Its official mainnet PluginRepo `0xb7401cD221ceAFC54093168B814Cc3d42579287f` is a verified on-chain Aragon plugin repository. Retain its official Aragon majority-voting tally, proposal execution, proposal metadata, `IVotes`/self-delegation compatibility and OSx permission semantics. Original source is preserved in `contracts/reference/TokenVoting_OSx_v1.4.sol`, untouched. Its original `MajorityVotingBase` is adapted narrowly from `PluginUUPSUpgradeable` and `ProposalUpgradeable` to Aragon's existing `Plugin` and `Proposal` non-upgradeable base, in the existing `contracts/src/base/MajorityVotingBase.sol`.

**RISC Zero existing verified Ethereum verifier router**: `0x8EaB2D97Dfce405A1692a21b3ff3A172d593D319`. Our verifier delegates to its existing `verify(seal,imageId,sha256(journal))` interface; **no additional RISC Zero Groth16 verifier or router deployed by us**. A pinned, genuine guest `imageId` is required at verifier deployment. Its complete, authenticated guest is **not yet implemented**.

**Only project-specific deployed contracts**, in addition to the official factory-produced Aragon DAO:
1. `contracts/src/WbtcIporTokenVoting_v2.sol` — a directly deployed, non-upgradeable **single voting plugin** inheriting the audited Aragon framework; it contains all voter registration, market adapters, activity, two proposal kinds, Guardian security stage, 15% bonus, removal, action selection, and deposit escrow.
2. `contracts/src/WbtcIporZkProofVerifier_v1.sol` — one fixed-image, non-upgradeable proof adapter that invokes the **already deployed** RISC Zero router. It has no voting or execution power.

The abstract Aragon base, inherited compiler libraries and existing external ERC-20/Morpho/Curve contracts are **not separately deployed governance plugins**.

### 2. Exact deployment connection: factory, one plugin, one verifier

**No custom PluginSetup/PluginRepo deployment is required.** Use the official factory with `PluginSettings[]` empty. Result is a factory-generated, registered normal OSx DAO. It is not a factory-installed *listed plugin*, so the official Aragon app may not automatically show the custom plugin as an installed governance process, despite fully functional onchain DAO permissions.

Proceed in this exact order on the **authenticated Ethereum live fork first**, never mainnet without authorized final deployment:
1. Call official `DAOFactory.createDao` with no plugin settings and an optional available subdomain. Record the DAO address from the factory receipt, bytecode and registry event.
2. Deploy the **single** `WbtcIporTokenVoting` direct (no proxy) with that DAO, the actual new vault-share token implementing `IVotes`, the intended Guardian Safe and canonical Morpho Blue address. The deployment must verify the share-token ABI/decimals/delegation and real Safe identity.
3. Deploy the **single** `WbtcIporZkProofVerifier` with that DAO, deployed voting plugin address, existing RISC Zero router and independently pinned genuine guest image ID. This contract intentionally requires the plugin bytecode already to exist, avoiding a circular constructor dependency.
4. During the factory creator's temporary `EXECUTE_PERMISSION`, use `DAO.execute` to call `DAO.grant(dao, votingPlugin, DAO.EXECUTE_PERMISSION_ID)` (Aragon's own permission manager); call `plugin.bindProofVerifier(verifier)` via the same authorized DAO execution mechanism; and **revoke creator's `EXECUTE_PERMISSION` last**. No new transaction batching contract or infrastructure is necessary. The final transaction(s) and entire resulting DAO permission graph must be source- and receipt-verified.
5. Confirm the sole holder of DAO `EXECUTE_PERMISSION` for external callers is the one plugin, that no EOA or Guardian Safe has DAO `ROOT` or `EXECUTE` permission, and that DAO-level permission changes cannot be routed through the voting plugin's standard proposal action allowlist. The factory itself revokes its temporary ROOT. Avoid granting `SET_TARGET_CONFIG_PERMISSION` or any plugin-upgrade permission. The DAO itself retains standard Aragon self-ROOT permissions, which are inaccessible through the restricted voting plugin.
6. All vote-approved execution goes `VotingPlugin -> DAO.execute(Action[],allowFailureMap=0)`. The special removal action is an exact, sole zero-value action to `VotingPlugin.permanentlyRemoveDaoGuardian()` with `msg.sender == DAO`. Standard proposals cannot invoke that function, DAO permission management, DAO upgrades, or arbitrary actions. Once removed, the plugin's one-way bool cannot be restored by any function or upgrade at that immutable address.

### 3. Existing source reused with minimal necessary changes

- **Keep** Aragon's `IMajorityVoting`, proposal storage, tally, `VoteCast`/`ProposalCreated` and `MajorityVotingBase` support/quorum/execution mechanics.
- Change only the Aragon parent plugin type to **direct, non-upgradeable** `Plugin` and set its DAO binding in its constructor. Do not deploy a UUPS implementation + proxy pair.
- **Keep** Gardens/AragonOne `VotingAggregator` weighting pattern as a documented source reference: direct WBTC IPOR share token balances weight 100%, Morpho Blue collateral and CurveLend LLAMMA-owned underlying shares weight 50%; exclude custodial raw balances from the same owner's direct-share calculation. Registered markets are controlled by approved ordinary DAO proposals.
- Retain IPOR's existing `PlasmaVaultVotesPlugin` in its *own* vault (BUSL licensed), without copying it or deploying a second voting token.

### 4. Standard proposal logic

- **Atomic default:** freeze eligible users' complete wallet + approved-market positions in one transaction, record immutable per-proposal weights and active quorum denominator. Shares of unactivated/expired voters count **zero**. A voter activates once and self-delegates in that same transaction using the IPOR vault's `delegateBySig`. A signed activation must consume *that voter's own nonce*, not anyone else's.
- Market 50% weighting and Safe 15% are implemented using exact integer scaling: non-Safe voters get `85 * base`, Guardian gets `15 * sum(nonSafeBase)`; total `100 * sum(nonSafeBase)`. Once Guardian removed, its bonus is zero and ordinary eligible holders are weighted without the bonus.
- **Stage 1**: maximum seven days. Only the Guardian Safe can approve (immediately opens Stage 2), veto (permanently cancels), or remain silent (Stage 2 becomes open after seven days without another Safe vote). **Stage 2**: 14 days, quorum >=25%, Yes/(Yes+No) approval >=67%, Abstain counts for quorum. No early proposal execution.
- Only an address holding >=10% of the eligible proposal total may create an active proposal. Bond is 0.001 real vault shares (based on ERC-20 decimals); escrow after snapshot; returned after settled unless a majority of participating power marks it spam with quorum. Guardian veto alone does not forfeit the bond.
- Missed-vote expiry requires both **three calendar months since first closed eligible missed proposal** and **at least two eligible missed proposals**. No proposals -> no automatic missed count. Voting resets the streak. Changes to activity settings via an approved ordinary proposal affect future snapshots. A special Guardian-removal voter must additionally have been continuously activated for at least three calendar months.
- DAO-approved ordinary proposals may update voting thresholds/durations/bond, the reviewed vault-selector allowlist, the activity policy and a market registry entry. Only allowed targets and zero ETH values are executable. Review all actual vault function selectors before enabling; a selector whitelist alone is not comprehensive protection against arbitrary-call fuses.

### 5. Guardian removal proposal kind

- **No Safe Stage 1**, 30-day community vote, 33% of **whole economic vault-share weight** quorum, 75% Yes/(Yes+No) approval and 0.005 vault-share bond (five standard bonds). Only continuously active users for >=3 calendar months qualify to vote. Inactive/undelegated/unactivated holdings **cannot vote** but **do count in the quorum denominator**. The Guardian's 15% bonus counts in neither numerator nor denominator; the Safe's independently held real vault shares can qualify like any voter.
- Sole allowed action: `VotingPlugin.permanentlyRemoveDaoGuardian()`. Verify exact target/plugin selector/value, action count=1, `allowFailureMap=0`, and no delegatecall or extra calldata/actions. It permanently disables Guardian stage/veto and future bonus shares; nothing can reenable it at this immutable plugin.
- **Guardian removal is ZK-only until authenticated complete whole-supply onchain enumeration can be proven.** There is no safe way to infer all unregistered Morpho Blue and CurveLend borrower positions from the activated-voter registry alone. Do NOT pretend `getPastTotalSupply` or Morpho's combined singleton custody balance gives the 50%-discounted verified denominator for approved individual markets.
- The RISC Zero guest must prove the complete economic census of vault token owners and all approved positions, avoid custodial double counting, require the correct 3-month activity qualification, exclude the Safe bonus, and commit a deterministically complete Merkle root. Prover generation can happen using the existing offchain GitHub workflow after a pinned historical block.

### 6. Merkle proof mode and security boundary

- The proposal records its canonical anchor block hash and all source configuration; a verified proof includes chain ID, DAO, plugin, proposal ID, snapshot block/hash, source configuration, voter root, eligible total, whole quorum denominator, proposer and proposer weight, and proposal kind.
- The verifier checks `RISC Zero router.verify(seal, pinnedImageId, sha256(journal))`. The voting plugin **also** checks the decoded journal and verifies the proposer membership proof, 10% proposer threshold, and frozen quorum. Only then can the 14- or 30-day vote open. Individual ballots require Merkle membership proofs for the accepted immutable root.
- **No proof generation or actual authenticated guest exists yet**. The custom verifier contract is a *real receipt-checking adapter*, **not** a complete proof system. A random root, mock seal, wrong program image or manually composed "journal" must never pass.
- **Open design dependency:** If a Merkle snapshot does not store every unvoted member's prior proposal eligibility onchain, the atomic registry cannot later infer exactly how many Merkle proposals each voter missed. The current source therefore **fails closed when attempting to resume atomic snapshots after a verified Merkle snapshot**. A source-backed, ZK-authenticated continuity ledger must be implemented before unrestricted bidirectional mode switching is approved.
- **Open data dependency:** Morpho Blue `position(marketId,user).collateral` is a per-user position; arbitrary unactivated holders and unrelated collateral held by the same Morpho singleton cannot be enumerated with only this getter. A genuine historical authenticated event/custody enumeration strategy is necessary. CurveLend soft liquidation must use actual current collateral, not deposited-original shares.

### 7. Status and recovery priorities

**Committed sources so far:** custom direct voting plugin, non-upgradeable Aragon majority base adapted from pinned deployed version, one proof verification adapter, original voting aggregator/Aragon references, pinned Foundry dependency list, MIT calendar-time library. **No extra custom voting plugin, guardian, market, action-policy, DAO setup, or installation contracts in the active project.**

**Not complete or verified:** executable RISC Zero guest/host and prover; authenticated historical full economic census; approval of actual IPOR vault-selector safety; Curve market factory authentication; OSx bootstrap permission-grant calldata and receipt verification; importing/pinning all Aragon/OZ dependencies in a real compiler; EIP-170 deployed code size constraints; historical Merkle inactivity continuity; gas limits on atomic voter enumeration; complete integration with the old GitHub archive/runner. No Solidity tests were created or run.

**Next phase**: (1) compile exactly these two concrete contracts and the existing abstract Aragon dependencies; (2) eliminate compiler errors and inspect runtime size; (3) complete/correct the real ZK guest and prover; (4) prepare live Ethereum fork deployment using Aragon's deployed DAOFactory, deploy two new contracts and verify the post-bootstrap permission graph; (5) exercise the previously authorized full live-fork governance flow and original valid/invalid ZK proofs before any mainnet deployment.

**Source pin:** Contract-Automation working branch `feature/wbtc-ipor-aragon-governance-v1`; v5 supersedes `CONTRACT_DESIGN_SPEC_v4.md`. Git history preserves v4; no duplicate active design specification.
