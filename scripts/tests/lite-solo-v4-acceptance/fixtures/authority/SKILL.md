---
name: lite-solo
description: Single-auditor Lite EVM security audit, retaining the v13.2 schema-governed evidence, source-first analysis, fork execution and controller validation without master review or reviewer handoffs.
---

# lite-solo — Single-Auditor Lite Pathway

Release: `lite-solo-v4`. Campaign mode: `LITE_SOLO`. Logical audit role: `lite-solo-agent`; Phases 4–6 support unbounded parallel workers.

This is a fork of Audit_Litemode_v13 v13.2. It preserves the substantive security and evidentiary requirements of the retained Lite phases. It **removes independent reviewer assurance** and must never be described as equivalent to an independent multi-agent or Full audit. It does not modify the original multi-agent authority.

## Parallel-unit execution model (mandatory for Phases 4–6)

Release `lite-solo-v4`; execution model `PARALLEL_WORKER_UNITS`. `lite-solo-agent` is the single logical audit role, not a single browser session or exclusive worker. Any number of independently identified `workerId` agents may claim disjoint units. Default CLAIM allocates exactly min(10, all independently eligible AVAILABLE units); SUBMIT names 1–5 completed units and never waits for a fifth. Required Phase 4 correctness and residual units must be ACCEPTED before ATTACK; all ATTACK units must be ACCEPTED before reconciliation; only a final controller PASS permits Phase 5 or 6. Preserve the complete existing Lite security and evidence obligations.

**NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK.

Example: CLAIM 10 available units, commit three completed snapshots, SUBMIT those three, then immediately work on the remaining owned units. On the next ordinary CLAIM refresh, read asynchronous `REWORK_REQUIRED` feedback and repair only that unit; never substitute SUBMITTED for ACCEPTED.

Use the controller-owned `UNIT_PLAN_INDEX_v1.json` and `UNIT_QUEUE_STATE_v1.json` surfaced as `currentAssignment.unitQueueIndexPath` or `unitQueueIndexPath` in the campaign directory. The request ingress is `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json`. Only a worker's own `units/<unitId>/submissions/<workerId>/epoch-<claimEpoch>/SUBMISSION_ATTEMPT_NNN_v1.json` may be authored; never edit queue state, accepted snapshots, reports, receipts or another worker's evidence. A claim response includes the ownership token, exact packet digest, and paged index; request exact controller-bound campaign generation, source hash and authority digest. See [submission protocol](shared/controller/PHASE_SUBMISSION_RESULT_HANDLING.md).

## Mandatory startup and scope

1. Open this skill and the controller-owned current campaign directory for the exact campaign, generation, source archive hash and bound authority digest.
2. Confirm `mode=LITE_SOLO`, `currentAssignment.reviewer=lite-solo-agent` and this exact bound release. Never act on a legacy `LITE` campaign.
3. Open **only** the assigned `phases/phase-N/START_HERE.md` and its linked working resources. Phase 4 also uses the authority-root `discovery/` guides.
4. For Phases 4–6 read `currentAssignment.unitQueueIndexPath` and edit only immutable worker/claim-epoch/attempt unit submissions. For Phases 1–3 and 8–10 retain the existing `currentAssignment.workShardIndexPath` semantic record protocol. Never edit controller-owned queues, shared index identities, receipts, authority bindings or sealed evidence.
5. In Phases 4–6 submit independent immutable unit snapshots in batches of 1–5 via the parallel unit ingress, immediately continue work and consume feedback during the next natural claim refresh. Other agent phases continue through the canonical phase boundary controller.
6. Execute required source-bound testing through the existing qualified tooling; missing mandatory evidence blocks security conclusions. Archive-backed Anvil/Phase-5 machine evidence remains mandatory when required; absent evidence blocks the security conclusion, never constitutes PASS.

## Sole actor and phase ownership

| Phase | Owner | Required disposition |
|---|---|---|
| 0 | GitHub Actions, automatic | Source/build/deployment identity, static analysis, source intelligence, archival machine evidence; seal before Phase 1 |
| 1–3 | `lite-solo-agent` | Scope, specifications and threat modeling; logical Lite-Solo role with preserved reasoning evidence |
| 4 | `lite-solo-agent` | Separate sequential correctness/flow window, adversarial/attack window and reconciliation, multiple worker instances in one logical Lite-Solo review; retain primary-context verdicts and decisive uncertainty tracking |
| 5–6 | `lite-solo-agent` | Execution design, economic/security verification and evidence-backed interpretation |
| 7 | GitHub Actions, automatic | Create Phase-7 marker immediately from sealed Phase-6 evidence; no agent and no master gate |
| 8 | `lite-solo-agent` | Candidate and finding validation |
| 9 | `lite-solo-agent` when remediation exists | Else controller seals an explicit SKIPPED marker |
| 10 | `lite-solo-agent` | Final traceability, limitations, unresolved candidates and report; after decisive PASS, controller sets COMPLETE |

There are **no** master reviewer steps, segment gates, human-style reviewer handoffs, substitute attacker reviewer, separate test reviewer or backup chat. No fake master decision or independent attestation may be recorded. A reviewer field required by historical phase schemas is a compatibility field and must contain `lite-solo-agent`.

## Non-negotiable evidence and reasoning

- Reuse the exact sealed source intelligence and accepted provenance; do not rediscover sealed facts, change source identity, invent observations, mask uncertainty, or confuse process blockage with vulnerability risk.
- Every retained Lite phase uses its full local `PHASE_CONTRACT.json`, `PHASE_XX_SCHEMA_v1.json`, work-form templates, and required supporting resources. Explicit negative outcomes require justification. All domain applicability, flow coverage, trust-boundary, attack-tree, threat, standard conformance and traceability obligations are retained.
- Phase 4 uses `correctness-verdict-v13`. Compare implementation against NatSpec, source comments, documentation, constants and sibling/pair behavior, then execute a *separate* adversarial reasoning pass in the multiple worker instances in one logical Lite-Solo review. Cite both passes in reconciliation; do not claim independent second-pass review.
- Phase 5 execution requests require genuine ABI-driven archive-fork evidence, not mocked or current-state-only substitutes. The pinned dRPC archive upstream `RPC_ETHEREUM` is used through localhost Anvil via `ETHEREUM_FORK_RPC_URL` by existing authorized machine tooling.
- Phase 10 is not COMPLETE while material candidates, missing mandatory execution evidence, unresolved source-identity issues or unclosed obligations remain. Record residual Lite-scope limitations.
- Use the GitHub connector for all repository operations; never bypass it with raw URL requests. Diagnose and repair controller and connector failures before claiming blocked.

## Controller and recovery

Consult [Solo controller contract](shared/controller/AI_Auditor_Controller.md), [phase schema policy](shared/controller/LITE_PHASE_SCHEMA_POLICY.md), [phase receipts](shared/controller/LITE_PHASE_RECEIPT_PROTOCOL.md), [result handling](shared/controller/PHASE_SUBMISSION_RESULT_HANDLING.md), and [recovery router](shared/controller/RECOVERY_ROUTER.md). The controller alone validates, seals, materializes derived records, advances, skips Phase 9, creates Phase 7, and completes Phase 10. The agent reads controller results and subsequent assignments directly from the Campaign Directory and phase controller result pages; no chat delivery is involved.

**Evidence boundary:** a controller PASS is necessary to advance; a submitted request, saved chat message, or green GitHub Actions run is not itself PASS. No master acceptance step follows it.

## Continuous work, shard ownership and execution authoring

- All Phase-4 F/R units must reach persisted ACCEPTED before X ATTACK becomes eligible. All X units must reach ACCEPTED before Phase-4 reconciliation becomes eligible. Distinct agents may review disjoint F/R, X and reconciliation units, but there is only one logical Lite-Solo reviewer and no independent assurance claim. **NEVER WAIT FOR CONTROLLER APPROVAL.** After durably committing 1–5 completed unit snapshots and an immutable SUBMIT request, immediately work on the next independently eligible claimed unit. Claim another ten when the current independent work is exhausted; never inspect or poll a GitHub Actions run for prior approvals. SUBMITTED is not ACCEPTED: dependent units require persisted ACCEPTED and later phases require a controller-sealed PASS. If none is independently eligible, yield NO_ELIGIBLE_WORK.
- For Phases 1–3 and 8–10, use the existing phase-wide controller-owned semantic shard index and submit once the complete phase is ready. For Phases 4–6, do not edit shared semantic shards: inspect per-unit source-bound packet pages and submit your worker/epoch-specific immutable record snapshot. The controller alone deterministically assembles accepted records and performs the aggregate phase validation and seal.
- During Phase 4 reconcile each required observation row to an anchored resolution, an already existing matching candidate or a genuinely distinct candidate. Multiple `CANDIDATE_CREATED` rows may reference the same `candidateTempKeyOrNone`. Keep every original observation and all distinct security properties; compare actual failure mechanisms and prerequisites, not mere text similarities.
- Each Phase-5/6 worker authors only its assigned semantic unit, including any required candidate-specific executable harness/blueprint/request. Existing qualified source-bound tooling performs mandatory execution and publishes raw evidence. An initializer skeleton is not a completed executable target. Use only admitted adapters and registered bundles; no separate human approval is a prerequisite for required campaign execution. Do not create or execute a second test infrastructure.
- If Phase-0 baseline simulation telemetry is not provided, use available deployment/source evidence and record genuine limitations; never invent telemetry or waive later required execution. Preserve the `PHASE5_DECISIVE` evidence option and distinct Phase-6 baseline proof obligations. Do not infer disproof from `NOT_REPRODUCED`.

## Phase entrypoints

- Phase 0: [START_HERE](phases/phase-0/START_HERE.md)
- Phase 1: [START_HERE](phases/phase-1/START_HERE.md)
- Phase 2: [START_HERE](phases/phase-2/START_HERE.md)
- Phase 3: [START_HERE](phases/phase-3/START_HERE.md)
- Phase 4: [START_HERE](phases/phase-4/START_HERE.md)
- Phase 5: [START_HERE](phases/phase-5/START_HERE.md)
- Phase 6: [START_HERE](phases/phase-6/START_HERE.md)
- Phase 7: [START_HERE](phases/phase-7/START_HERE.md)
- Phase 8: [START_HERE](phases/phase-8/START_HERE.md)
- Phase 9: [START_HERE](phases/phase-9/START_HERE.md)
- Phase 10: [START_HERE](phases/phase-10/START_HERE.md)

## Authority note

Some retained, byte-identical v13.2 source resources describe the **legacy** multi-reviewer topology. Any instruction that appoints reviewer-1/2/3/4, demands a master gate, hands off to a different chat, or requires a separately delegated test reviewer is **not applicable in lite-solo**. Security/evidence obligations are not waived by this routing override; specific fork-local phase instructions prevail over legacy role prose. The controller must fail closed on missing evidence rather than stage a legacy gate.

## No browser or chat delivery

The initializer needs only the source ZIP URL or explorer scan URLs; Phase-0 machine work proceeds automatically through the existing isolated execution route. **Do not request, store or require any chat URL.** This mode does not register a browser session, maintain a delivery command, run a wake/watchdog, create an Agent Delivery request, or post any messages. After Phase-0 sealing, read the bound campaign directory, claim work by immutable unit requests and proceed immediately without waiting for approval. The agent never polls Actions. Controller-owned receipts alone authorize phase transition; campaign generation, authority and source hashes—not chat identity—govern access.
