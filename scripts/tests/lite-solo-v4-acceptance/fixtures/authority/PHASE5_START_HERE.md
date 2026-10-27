> **LITE-SOLO v4:** This phase uses parallel, independently claimed source-bound units (CLAIM 10, SUBMIT 1–5, unlimited workers) and the immutable request ingress `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json`. There is one logical `lite-solo-agent` review, no independent second auditor. **NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK. Phase 7 is controller-only.

## Required work system

- Single phase schema: [`PHASE_05_SCHEMA_v1.json`](PHASE_05_SCHEMA_v1.json)
- Work-form template: [`PHASE_05_WORK_FORM_TEMPLATE_v1.json`](resources/PHASE_05_WORK_FORM_TEMPLATE_v1.json)
- Final report is controller-generated from the accepted work form; reviewers do not author it.

Every agent action below produces substantive output data. Fill the named Step X Input section while performing that action. Do not defer documentation until phase end and do not perform controller bookkeeping.

## Step 1 — Complete economic and mathematical review

Use the controller-prefilled economic rows. Preserve the machine-owned `recordKey`, `sourceAnchor`, and `valueFlowOrFormula`; analyze units/bounds, boundary cases, precision/rounding, incentives/extraction, solvency/conservation, conclusions and candidate relationships.

Write each Step-1 economic row to the worker/epoch-owned P5-E unit snapshot `entries[].value` identified by `currentAssignment.unitQueueIndexPath`. Preserve every required record and controller-owned key.

## Step 2 — Perform bounded contradiction and candidate reconciliation

Reconcile Phase-5 conclusions against prior properties, hypotheses and candidates without broad retracing.

Write Step-2 reconciliation results only into their worker-owned immutable P5-R unit snapshots. Use sealed prior evidence, not a full-form context dump or a repeat of already accepted review.

## Step 3 — Design AI-guided targeted fuzzing and attacker/exploit simulations

Use the controller-provided Phase-0 build, source, deployment and any actually available execution evidence to select target sequences, oracles and boundaries. Current prefill does not supply `automationInputs.phase0BaselineSimulation`; do not require or invent it. Missing telemetry is not proof of safety and never waives mandatory authorized execution.

Attack paths marked VIABLE or UNCERTAIN in the accepted discovery evidence receive material target designs here. The same lite-solo-agent interprets them in Phase 6; no separate attacker reviewer exists.

For every material candidate due for retained Lite execution, design the semantic security test plan for **both** AI-guided targeted fuzzing and targeted attacker/exploit simulation. Define the attacker/actor model, prerequisites, exact attack transaction/action sequence, expected secure outcome, exploit/failure oracle, candidate-relevant fuzz variables and bounds, safe snapshot/environment reuse assumptions, execution method, machine `reproductionType`, and exact structured `expectedMachineObservation`. Materialize or identify the exact trusted V7 request/harness that implements that target. The controller automatically resolves a request already present at the conventional campaign request paths; otherwise controller rework asks only for the exact campaign-relative `executionRequestRef`. The controller must verify campaign/source/candidate/reproduction/expected-observation binding before Phase 5 can seal. The prose design is never silently converted into executable code.

The Phase-5 `reproductionType` is the literal adapter selector, not a taxonomy of every testing style. `FOUNDRY_TEST` is the current Foundry adapter and can execute target-specific Foundry tests/fuzzing, including authored stateful invariant, multi-actor, boundary/dictionary, differential/reference and ghost/reference harnesses. `MEDUSA_PROPERTY` is the current candidate-bound Medusa reproduction adapter. `ANVIL_WORKFLOW` is the current deterministic fork-lifecycle adapter. Broader techniques may be expressed inside an exact bound V7 request/harness when the underlying supported adapter actually implements them. Keep `reproductionType` limited to the literal adapter that will actually execute the request; represent the testing style inside the bound request/harness.

**Phase-5 `NOT_APPLICABLE` contract (controller-verifiable):** A material candidate can omit a redundant *execution method*, never the material security question. Currently the sole admitted method waiver is `COVERED_BY_EXECUTED_TARGET`: set `executionMethod` and `reproductionType` to `NOT_APPLICABLE`, and supply `notApplicableDisposition: {"reasonCode":"COVERED_BY_EXECUTED_TARGET","coveredByCandidateKey":"<exact other candidate key>","technicalReason":"<substantive reason>"}` on that target design. The cited covering candidate must execute through `V7_REQUEST`, have the same sealed candidate `sourceAnchor`, and have exactly matching setup, prerequisites, transaction sequence, oracle, fuzz bounds, snapshot safety, and expected security property. The controller verifies the covering source-bound, persisted, completed machine evidence before it seals. A malformed waiver, missing/incomplete covering execution, or differing source/claim returns `NEEDS_REWORK`. Unsupported static-only, unreachable-code, superseded, deployment-scope or governance assertions are **not** independently validated by this waiver; never label these `NOT_APPLICABLE` to bypass required execution. They require an independently verifiable proof mechanism and explicit controller support before qualification. RPC failures, missing harnesses, timeouts, reverts or failures to generate useful economic transitions are `BLOCKED` / `INCOMPLETE`, never `NOT_APPLICABLE`.

**Completed negative machine result:** A fully executed, source-bound, oracle-observed test may conclude `NOT_REPRODUCED` instead of `REPRODUCED`. This satisfies the *execution-completeness* gate when the requested Foundry/Medusa/Anvil component actually completed, preflight passed, and raw evidence is persisted; the underlying candidate remains unconfirmed until separate proof or disproof is obtained.

`INCONCLUSIVE`, `EXECUTION_FAILED`, missing observations or failed test components do not satisfy the gate.

Write exact Step-3 designs into immutable P5-T unit snapshots and authorized append capacity, not shared editable shards. Each target family has one authoritative unit/request owner. Automation executes and publishes evidence; do not create, modify or run tests outside the existing source-bound execution route.

## V13 exact executable design and single authoritative unit ownership

For each `targetDesigns[]` entry with `executionMethod:"V7_REQUEST"`, the logical `lite-solo-agent` must specify the exact `executionBlueprint` and, when **source-bound**, author the real target-specific request/harness using the **existing** V7 request generator, `npm run v7:harness:init -- --request <request.json>` and registered audit-overlay bundle lifecycle. Read `packages/github-native-sim/harness-skeletons-v2/README_v2.md` before harness-specific work. Use supported `FOUNDRY_TEST`, `MEDUSA_PROPERTY`, or `ANVIL_WORKFLOW` as the actual selected adapter; preserve exact compiler, source identity, trusted bundle, actor roles, ABI methods, chain/block/fork context, prerequisites, oracle, expected observation and meaningful bounds.

A generated skeleton, prose transaction plan, missing target-specific code or an unverified bundle is **not executable**; `CREATED_REQUIRES_TARGET_AUTHORING` means authoring remains. `analysis.nativeFuzz.fuzzRuns` must meet the selected adapter's applicable, authorized policy; there is **no blanket >=100000 nativeFuzz requirement** for every blueprint. Do not change adapters/budgets solely to bypass evidence obligations. The machine executor and raw publication remain automation-owned; there is no `test-executor` person, chat, delegation or handoff.

Finish one coherent target family through substantive design and concrete **source-bound** request/bundle before multiplying unexecutable prose across families; continue through as many families as feasible in the same session. If blocked on execution prerequisites, preserve exact missing prerequisites in existing fields and finish independent permitted work. Preserve all-target Phase-5 acceptance and existing evidence validity. Unsupported, blocked or incomplete execution is not PASS; do not turn a missing test into a waiver.

## Paged v4 unit procedure

Read each assigned unit's pages and immutable record keys; never open or replace a shared full-phase editable form. Preserve append permissions, candidate identity, 64-KiB semantic shard bounds and 32-KiB paged index limits. The controller reassembles the canonical schema only after every required record is independently accepted. Execution request/harness authoring must remain exact and source-bound and machine evidence remains mandatory before Phase-5 PASS.

## Immutable unit submission and immediate continuation

Each unit's controller-issued packet/index specifies required source context and exactly owned record keys. Commit a unique immutable `units/<unitId>/submissions/<workerId>/epoch-<claimEpoch>/SUBMISSION_ATTEMPT_NNN_v1.json` to Audit-Controller with `schemaVersion:curveyield-lite-solo-unit-submission-v1` and `entries:[{key,value}]` for semantic shard units (discovery flow/attack units retain their exact source-bound submission schema). Obtain the committed SHA-256 bytes hash and then commit `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json` with exact generation/source/authority/packet ownership identity. A valid SUBMIT names 1–5 completed units; do not accumulate an artificial five-unit barrier. One accepted sibling does not require re-review because another sibling needs corrections.

**NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK.

Phase 5 is sealed **only** after every mandatory unit is accepted and every existing aggregate semantic, coverage, source-binding and machine-evidence requirement is satisfied by the controller. Its next phase begins only on canonical PASS; a queued request, green Actions run or unit acceptance is never phase PASS.
