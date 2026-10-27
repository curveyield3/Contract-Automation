> **LITE-SOLO v4:** This phase uses parallel, independently claimed source-bound units (CLAIM 10, SUBMIT 1–5, unlimited workers) and the immutable request ingress `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json`. There is one logical `lite-solo-agent` review, no independent second auditor. **NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK. Phase 7 is controller-only.

## Required work system

- Single phase schema: [`PHASE_06_SCHEMA_v1.json`](PHASE_06_SCHEMA_v1.json)
- Work-form template: [`PHASE_06_WORK_FORM_TEMPLATE_v1.json`](resources/PHASE_06_WORK_FORM_TEMPLATE_v1.json)
- Final report is controller-generated from the accepted work form; reviewers do not author it.
- Controller-populated deployment evidence: campaign `work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md`
- Controller-populated target execution evidence: campaign `work/phase-06/LITE_TARGETED_TEST_MATRIX.md`

You are an independently identified worker in one logical `lite-solo-agent` review. Reuse controller-accepted Phase-4 correctness and attack evidence; never claim a separate independent reviewer. In Phase 6 you interpret Phase 0 deploy/config evidence and Phase 5 candidate runs (Steps 1–3), run baseline property tests (Step 4), and prove or disprove candidates and record new findings (Step 5). Own only assigned Phase-6 semantic units and their necessary candidate-specific concrete executable requests/harnesses; existing qualified automation executes and records machine results. Target-specific test creation and execution use the existing source-bound tooling.

Every agent action below produces substantive output data. Fill the named Step X Input section while performing that action. Do not defer documentation until phase end and do not perform controller bookkeeping.

Phase-6 logical unit types: P6-D deployment assessments, P6-T target dispositions, P6-B baseline groups, P6-P candidate proofs/new findings, and P6-C conclusions/obligation dispositions. Only the controller assembles the final aggregate.

## Step 1 — Interpret exact deployment and configuration execution

Use the controller-prefilled deployment rows. Preserve `componentOrAction`, `executionEvidenceRef`, and `observedState`; supply only semantic security interpretation, contradiction significance and limitations.

Write the completed Step-1 substantive `entries[].value` records into the controller-assigned Phase-6 unit snapshots using `currentAssignment.unitQueueIndexPath`. Preserve controller-owned fields and keys; do not edit or open the retired full aggregate as a prerequisite.

## Step 2 — Interpret precomputed deterministic simulation and targeted-fuzz results

Use the controller-prefilled candidate-specific Phase 5 target rows. Preserve `candidateKey`, `executionEvidenceRefs`, `oracleOutcome`, and `reproductionStatus`; supply only security interpretation, limitations and recommended Phase-8 disposition.

Write the completed Step-2 substantive `entries[].value` records into the controller-assigned Phase-6 unit snapshots using `currentAssignment.unitQueueIndexPath`. Preserve controller-owned fields and keys; do not edit or open the retired full aggregate as a prerequisite.

## Step 3 — State merged Lite 6-7 conclusions and omissions

Supply the merged execution conclusion and each assigned evidence-backed obligation disposition (P6-C). `typedExecutionLimitations` and `fullOnlyOmissions` are controller-prefilled read-only fields derived from machine evidence and Lite policy; do not claim or edit them.

Write the completed Step-3 substantive `entries[].value` records into the controller-assigned Phase-6 unit snapshots using `currentAssignment.unitQueueIndexPath`. Preserve controller-owned fields and keys; do not edit or open the retired full aggregate as a prerequisite.

## Step 4 — Agent-guided baseline testing

Follow ../../shared/execution/AGENT_GUIDED_TESTING.md. For each prefilled group, write a harnessDesign specifying roles, starting state, assertions and fuzz bounds. Author the concrete harness/request through the existing qualified execution tooling through the existing v7:harness:init and v7:harness:validate process, dispatch using the existing execution lane and interpret the recorded ASSERTION_LEDGER_v1.json. Use existing source-bound execution tools for required target-specific test code and requests; absence of required evidence remains blocked, not PASSED. Use at most the existing three execution rounds. Each obligation needs PASSED, PROPERTY_FAILED, NOT_APPLICABLE_CONFIRMED with anchors, INCONCLUSIVE, or NOT_ACHIEVED with a typed reason. PASSED requires a parsed ledger naming the passing assertion; every PROPERTY_FAILED creates Phase 8 key P6-PROP-<testGroupId>-<obligationId>.

## Step 5 — Prove or disprove candidates; record new findings

A Phase 5 REPRODUCED candidate may use the existing PHASE5_DECISIVE path where the exact prior evidence permits; do not retest already decisive properties without a distinct outstanding obligation. Otherwise, during required execution, test attack and healthy-path control together, at most three rounds. Preserve independently due baseline proof obligations. CONFIRMED requires an attack property failure with healthy controls passing. DISPROVEN requires blocking assertions and healthy controls passing, plus the exact anchored blocking control. INCONCLUSIVE requires explanation of missing evidence. Phase 5 NOT_REPRODUCED alone never disproves a concern. Record new findings as P6-NEW-<n> in newCandidateRecords.

## Immutable unit submission and immediate continuation

Each unit's controller-issued packet/index specifies required source context and exactly owned record keys. Commit a unique immutable `units/<unitId>/submissions/<workerId>/epoch-<claimEpoch>/SUBMISSION_ATTEMPT_NNN_v1.json` to Audit-Controller with `schemaVersion:curveyield-lite-solo-unit-submission-v1` and `entries:[{key,value}]` for semantic shard units (discovery flow/attack units retain their exact source-bound submission schema). Obtain the committed SHA-256 bytes hash and then commit `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json` with exact generation/source/authority/packet ownership identity. A valid SUBMIT names 1–5 completed units; do not accumulate an artificial five-unit barrier. One accepted sibling does not require re-review because another sibling needs corrections.

**NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK.

Phase 6 is sealed **only** after every mandatory unit is accepted and every existing aggregate semantic, coverage, source-binding and machine-evidence requirement is satisfied by the controller. Its next phase begins only on canonical PASS; a queued request, green Actions run or unit acceptance is never phase PASS.
