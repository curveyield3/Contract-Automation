# Lite-Solo v4 — Semantic Batch Protocol v1

This document specifies the controller-generated Phase 4–6 multi-record packet interface for **new, unpublished plans only**. It supplements each claimed packet's controller-owned reading guide; it never overrides a campaign's frozen Lite-Solo authority, source hash, receipt, or authority digest.

## Eligibility

Only controller-generated, new-plan semantic rows are eligible:

| Phase | Batched fields | Retained independent |
| --- | --- | --- |
| 4 | `discoveryReconciliationRecords`, `specialistReviewRecords` | F/R source reviews, X attacker reviews, candidates, limitations, obligations, append slots |
| 5 | `economicReviewRecords`, `reconciliationRecords` | executable target designs and append slots |
| 6 | `deploymentAssessments`, `targetDispositions` | baseline executions, candidate proofs, global conclusions and obligation disposition |

The grouping policy prefers 10–20 coherent context or candidate groups and 48 KiB
of original record content, with a 64 KiB absolute upper bound on the serialized logical assignment payload
(including member prefills and packet metadata). Single eligible records retain
legacy SHARD representations when no consolidation is beneficial or their
serialized packet would be oversized; oversized singleton records do not block
issuance of the other phase units.

## Claims

Each consolidated unit has an ID such as `P4-RC-B0001`, a controller-owned
`ASSIGNMENT_PACKET_v1.json` prefill manifest, and fixed original member
IDs/record keys. Claim identity, source digest, authority digest and unit
specification revision are unchanged. The manifest identifies 12 KiB
digest-bound `prefill-pages`; reconstruct its `value` payload before work.

The original member record identity—not the batch unit ID—is used for
`entries[].key`. Submit one `curveyield-lite-solo-unit-submission-v1`
snapshot under the claimed **batch** ID with one or more original keyed entries.
A batch member has no independent claim token. Keep the existing claim epoch,
worker identity, unit specification revision, source hash, authority digest and
packet SHA-256 for the outer claim. Commit to the existing worker/epoch immutable
submission path and enqueue the normal `SUBMIT` request (1–5 claimed units).
For multi-record submissions, validate each member's bound source and controller
prefills individually. Never change controller prefills, omit genuine coverage
obligations, or invent evidence.

## Acceptance and corrections

The controller checks each supplied record's original-record prerequisites and
validates each record against the existing bound phase field schema. Valid records receive immutable
`records/<originalUnitId>/ACCEPTED_ATTEMPT_NNN_v1.json` evidence inside the
batch. Accepted siblings remain immutable even when another member fails.
Subsequent submissions may contain only outstanding/reworked entries. The
outer batch is `ACCEPTED` only when every required member is individually
accepted.

Candidate and target dependencies on original member IDs unlock only when
that specific record is accepted. Submission state alone never unlocks
dependent work. Each newly accepted record and complete batch also captures
an immutable fingerprint of the prerequisite acceptance evidence. If a source
record is reopened, accepted dependents (including only affected siblings in
other batches) are invalidated transitively; reacceptance and phase finalization
must recheck current prerequisite evidence. The controller restores accepted original entries to their
existing source-bound semantic shards and applies unchanged aggregate
phase validation and sealing.

## Safety and rollout boundary

This interface is **not** an instruction to migrate running campaigns.
The queue planner never reconstructs an already published unit plan.
Migration of a live campaign must be a separate, controller-authorized
operation that first resolves in-flight claims, preserves immutable
acceptance records and writes a complete original-record-to-batch mapping.

No source-review or attacker-review semantics, source identity, proof requirement,
test-round budget, or independent execution ownership changes. The existing
controller-owned batch claim index and assignment packet provide the operational
multi-record reading instructions; worker behavior must remain consistent with
the receipt-bound frozen SKILL. The frozen authority package is not edited or
rebound by this change. Production qualification remains a separate required
release action; no passing qualification is claimed by this protocol.
