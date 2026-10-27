# Lite-Solo v4 — Semantic Batch Protocol v1 (Draft)

This document describes the **proposed** Phase 4–6 multi-record packet interface on the
`feat/lite-solo-v4-batched-semantic-units-v1` branch. It is not an authority
release and does not authorize changing a frozen campaign's authority digest.

## Eligibility

Only controller-generated, new-plan semantic rows are eligible:

| Phase | Batched fields | Retained independent |
| --- | --- | --- |
| 4 | `discoveryReconciliationRecords`, `specialistReviewRecords` | F/R source reviews, X attacker reviews, candidates, limitations, obligations, append slots |
| 5 | `economicReviewRecords`, `reconciliationRecords` | executable target designs and append slots |
| 6 | `deploymentAssessments`, `targetDispositions` | baseline executions, candidate proofs, global conclusions and obligation disposition |

The grouping policy prefers 10–20 coherent context or candidate groups and 48 KiB
of original record content, with a 64 KiB absolute upper bound on a logical
batch. Single eligible records retain legacy unit representations when no
consolidation is beneficial.

## Claims

Each consolidated unit has an ID such as `P4-RC-B0001`, a controller-owned
`ASSIGNMENT_PACKET_v1.json` prefill manifest, and fixed original member
IDs/record keys. Claim identity, source digest, authority digest and unit
specification revision are unchanged. The manifest identifies 12 KiB
digest-bound `prefill-pages`; reconstruct its `value` payload before work.

The original member record identity—not the batch unit ID—is used for
`entries[].key`. Submit one `curveyield-lite-solo-unit-submission-v1`
snapshot with one or more original keyed entries. Never change controller
prefills, omit genuine coverage obligations, or invent evidence.

## Acceptance and corrections

The controller validates each supplied record using the existing bound
phase field schema. Valid records receive immutable
`records/<originalUnitId>/ACCEPTED_ATTEMPT_NNN_v1.json` evidence inside the
batch. Accepted siblings remain immutable even when another member fails.
Subsequent submissions may contain only outstanding/reworked entries. The
outer batch is `ACCEPTED` only when every required member is individually
accepted.

Candidate and target dependencies on original member IDs unlock only when
that specific record is accepted. Submission state alone never unlocks
dependent work. The controller restores accepted original entries to their
existing source-bound semantic shards and applies unchanged aggregate
phase validation and sealing.

## Safety and rollout boundary

This interface is **not** an instruction to migrate running campaigns.
The queue planner never reconstructs an already published unit plan.
Migration of a live campaign must be a separate, controller-authorized
operation that first resolves in-flight claims, preserves immutable
acceptance records and writes a complete original-record-to-batch mapping.

No source-review or attacker-review semantics, source identity, proof
requirement, test-round budget, or independent execution ownership changes.
Do not merge or deploy until the authority-compatible worker instructions,
targeted qualification and migration safeguards are complete.
