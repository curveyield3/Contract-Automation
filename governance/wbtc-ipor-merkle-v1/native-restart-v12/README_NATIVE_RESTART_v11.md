# WBTC IPOR native governance restart — v11

**Status:** local uncompiled design/source draft. No tests, compilation, fork simulations or deployments were performed.

## Narrow change from v10

Inactivity now affects **only the Standard proposal quorum denominator**. It does NOT undelegate IPOR vault shares, change any voting account's `getVotes`/`getPastVotes`, change `_ballotPower`, prevent or reduce actual ballots, slash or transfer tokens, or change existing parent proposals. Guardian removal retains its original **33% of full issued share supply** quorum, including all undelegated and inactive shares.

- Qualifying inactivity: at least **two completed eligible community ballots missed** since the last successful community vote and **three calendar months** since that vote. For a delegate who has never voted, the three calendar months begin at the end of their **first missed eligible completed ballot**. The underlying date calculation uses the already-existing MIT-licensed `BokkyPooBahsDateTimeLibrary` (copied from the preceding project's source; internal functions, not a newly deployed contract).
- Eligibility of a missed ballot is checked from its **original frozen historical ballot voting weight**; mere existence of a ballot never creates a missed vote. Guardian-removal and Standard community ballots both count for activity history. The optimistic Safe veto stage does not.
- When a Standard parent is initiated, calculate all directly registered and currently registered collateral delegate balances, identify inactive delegates, and store their **frozen subtotal** as `ParentContext.inactiveExcludedShares`. If the Safe bonus is allocated and the Safe delegate is inactive, exclude that bonus from quorum as well, without reducing its voting power.
- Standard 25% required quorum: `ceil(0.25 * (activeDelegatedDirectPower + registeredWeightedCollateralPower + SafeBonus - inactiveExcludedShares))`, subject to a minimum of **one raw voting unit** to prevent zero-vote passage. The **67% Yes support rule** is unchanged.
- Anyone can still cast a vote using their original full frozen weight. A successful vote resets the missing-ballot counter and last vote time for **future proposals only**. This does not modify the quorum denominator already frozen in any ongoing parent.
- The default automatic path allows up to 64 newly completed historical ballots to be scanned per delegate per creation. `checkpointDelegateActivity(delegatee, maximum)` is permissionless and advances work over separate transactions; `configureAutomaticInactivityChecks(maximum)` is DAO-governed. If a complete checkpoint cannot be calculated, the automatic path reverts instead of using a falsely reduced quorum. This is a bound on scans, **not** an inactivity timeout or hard voter limit.
- A pending proof ballot that no one could vote on is not counted as missed. Ballot history is retained; only completed ballots with positive eligible historic power and no recorded vote count.

## Proof mode

`ProofJournal` now includes `inactiveExcludedShares`. The full active and inactive subtotals must be proven for the original locked creation block by the RISC Zero **guest** before the verifier-backed Merkle route is usable. **The guest/host have not been updated in this round.** Do not treat the journal field as a trusted user-provided adjustment and do not deploy the proof path before complete source-bound proof authentication.

## Preserved unchanged

- Original upstream Aragon SPP, TokenVoting, `MajorityVotingBase`, and supporting interfaces.
- Original RISC Zero verifier contract.
- Standard and Guardian-removal SPP extensions, Safe early approval/spam veto, vote choice/slashing mechanics, bond size, Guardian 15% vote allocation, approved Morpho/Curve/Euler market registry and 50% collateral penalty.
- Source-only deployment plan and original IPOR native Votes module.

## Files modified in v11

- `src/extensions/WbtcCollateralTokenVoting_v3.sol` — previous `_v2.sol` replaced with v3.
- `src/lib/BokkyPooBahsDateTimeLibrary.sol` — copied unchanged MIT-licensed date library from prior development source; only internal code is linked into TokenVoting.
- `setup/IPOR_VAULT_VOTES_SETUP_v11.json` — replaces v10's live configuration reference.

The `v10` and earlier markdown/json files retained in this archive are **historical records**, not the active v11 specification. No other deployable Solidity contract was changed.

## Pending verification

No compilation or tests by instruction. Check size, Aragon proxy compatibility, gas upper bounds, historic ballot eligibility, Merkle census completeness and published guest image ID, and final deployment permissions before permitting deployment. The deployment bytecode target may be exceeded; v11 is not certified deployable.
