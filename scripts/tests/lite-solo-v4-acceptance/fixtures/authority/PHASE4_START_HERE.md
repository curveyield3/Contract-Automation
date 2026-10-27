> **LITE-SOLO v4:** This phase uses parallel, independently claimed source-bound units (CLAIM 10, SUBMIT 1–5, unlimited workers) and the immutable request ingress `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json`. There is one logical `lite-solo-agent` review, no independent second auditor. **NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK. Phase 7 is controller-only.

## Required work system

- Single phase schema: [`PHASE_04_SCHEMA_v1.json`](PHASE_04_SCHEMA_v1.json)
- Work-form template: [`PHASE_04_WORK_FORM_TEMPLATE_v1.json`](resources/PHASE_04_WORK_FORM_TEMPLATE_v1.json)
- Final report is controller-generated from the accepted work form; reviewers do not author it.

Every agent action below produces substantive output data. Fill the named Step X Input section while performing that action. Do not defer documentation until phase end and do not perform controller bookkeeping.

## Before Step 1 — Phase-4 correctness and attack units

The controller registers every F/R correctness/residual unit as AVAILABLE and every X ATTACK unit as BLOCKED_DEPENDENCY. Different worker IDs may claim and process any disjoint eligible F/R units in batches of ten. Preserve all primary-context verdicts, documentation/sibling comparisons, integration answers, candidate observations and exact anchors. Only after every mandatory F/R is ACCEPTED may X ATTACK units become available; they may run concurrently with each other but not ahead of the correctness barrier. After all X units are ACCEPTED, controller generates the full source-bound discovery summary, baseline obligations and exact reconciliation/specialist/candidate prefill keys, then assigns P4-RC/SP/OB/C units. Do not skip gaps, create artificial clean evidence or conflate a completed discovery pass with a sealed Phase-4 PASS.

## Step 1 — Reconcile both completed flow/correctness and ATTACK passes
Use `currentAssignment.unitQueueIndexPath` to open the controller-issued root index, relevant unit-index pages and assigned immutable unit snapshots. Reconcile **every** prefilled discovery row using its observation references and original source/attack evidence as needed; do not load the 1+ MB `DISCOVERY_SUMMARY_v1.json` or retired full form before the first substantive write. For each row choose an anchored `RESOLVED_NO_ISSUE`, `CANDIDATE_CREATED` linked to a matching Step-3 candidate, or `COVERAGE_GAP_ACCEPTED` only for a genuine coverage-gap row. Never discard an unresolved concern to reduce work. Multiple rows may reference one candidate when the failing mechanism, security property, prerequisites and actor authority match; preserve all distinct assertions and evidence refs. Different wording or anchors do not automatically mean a new defect. For attacker findings resolved as non-issues, cite the exact blocking control. Preserve disclosed gaps and original record identities for final coverage.

## Step 2 — Review material privileges and activated specialist domains

Review every controller-prefilled privilege/specialist row. Preserve `recordKey`, `domainOrPrivilege`, `sourceAnchor`, and `method`; supply only substantive observation, security interpretation, disposition and candidate decision. Do not reclassify specialist domains.

Submit the substantive Step-2 `entries[].value` record in the worker/epoch-owned P4-SP unit snapshot. Preserve exact prefilled keys and controller-owned fields; never edit the shared semantic shards.

## Step 3 — Create material candidate records and substantive limitations

Produce material candidate records and substantive typed limitations. The controller computes coverage counts and missing-required-surface reconciliation after validation; do not author coverage bookkeeping.

Submit source-supported Step-3 candidate/limitation/obligation results through the worker-owned P4-C/P4-L/P4-OB unit snapshots. Preserve controller-prefilled identities and all observation `evidenceRefs`. Submit 1–5 completed units then continue with independent assigned work.

## Immutable unit submission and immediate continuation

Each unit's controller-issued packet/index specifies required source context and exactly owned record keys. Commit a unique immutable `units/<unitId>/submissions/<workerId>/epoch-<claimEpoch>/SUBMISSION_ATTEMPT_NNN_v1.json` to Audit-Controller with `schemaVersion:curveyield-lite-solo-unit-submission-v1` and `entries:[{key,value}]` for semantic shard units (discovery flow/attack units retain their exact source-bound submission schema). Obtain the committed SHA-256 bytes hash and then commit `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json` with exact generation/source/authority/packet ownership identity. A valid SUBMIT names 1–5 completed units; do not accumulate an artificial five-unit barrier. One accepted sibling does not require re-review because another sibling needs corrections.

**NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK.

Phase 4 is sealed **only** after every mandatory unit is accepted and every existing aggregate semantic, coverage, source-binding and machine-evidence requirement is satisfied by the controller. Its next phase begins only on canonical PASS; a queued request, green Actions run or unit acceptance is never phase PASS.
