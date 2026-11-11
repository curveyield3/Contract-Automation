# Implementation status v11 — quorum-only inactivity

**Prepared locally, not compiled or tested.**

## Applied

1. Preserved native delegation, delegated share balances, past vote snapshots and actual ballot weights.
2. Added only the 2-missed-eligible-completed-ballots / 3-calendar-month rule for exclusion from the **Standard active-quorum denominator**.
3. Froze `inactiveExcludedShares` on each Standard parent so a later vote, registration, or market change cannot revise an old proposal's quorum.
4. Kept Guardian-removal quorum on the full issued vault-share supply, regardless of voter activity.
5. Preserved the Safe's 15% voting allocation. Its quorum contribution is excluded when it is inactive; it can still cast its allotted weight.
6. Tracked community child ballot history; permissionless incremental maintenance prevents unbounded all-history scans in the default path.
7. Updated optional authenticated Merkle journal structure; strict guest verification is REQUIRED and is still outstanding.

## Known limitations and ongoing required work

- The default path only includes registered direct and collateral delegates as in v10. Those automatic enrollment constraints are unchanged.
- When multiple ballots overlap, earlier unfinished ballots can temporarily delay checking newer completed ballots; this is conservative (it never reduces quorum on an unverified inactivity claim), but later reconciliation and bounded-gas operation need review.
- Proof guest not implemented; no proof-mode verification demonstrated.
- Proposer bond does not mathematically fix a live-collateral-vs-previous-block direct snapshot discrepancy; unchanged from v10.
- No compile, runtime size, tests or security validation performed. The implementation is draft source.

**Authoritative replacement:** `README_NATIVE_RESTART_v11.md` and `setup/IPOR_VAULT_VOTES_SETUP_v11.json`. All earlier descriptions of inactivity as pending are superseded only for the onchain automatic route; proof verification remains pending.
