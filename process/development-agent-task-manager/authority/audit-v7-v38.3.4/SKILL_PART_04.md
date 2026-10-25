### Repository recovery/context-loss handoff folder

For fresh-reviewer or context-loss handoffs, use the exact **campaign-local successor handoff** referenced by the current campaign state / Phase Contract. Current repository-level agent guidance lives under `docs/agent-guides/` in `curveyield3/Audit-Controller`. Material under `archive/recovery/` is historical provenance only and MUST NOT be treated as active handoff authority.

## Something broke? — Recovery Router

| Problem | Immediate route |
|---|---|
| **GitHub connector app missing, unavailable, permission-denied, or repeatedly failing** | **Do not substitute another repository interface.** Use the [Operations & Recovery lens](shared/lenses/operations-recovery-lens.md) and [Audit Controller/GitHub Protocol](shared/controller/AUDIT_CONTROLLER_AND_GITHUB_PROTOCOL.md). Exhaust the connector recovery ladder, preserve the failure evidence, then send the mandatory GitHub connector outage report if still unavailable and continue unaffected work. |
| Controller, campaign state, evidence retrieval, report serialization, repository workflow, or other audit-system mechanics | [Operations & Recovery lens](shared/lenses/operations-recovery-lens.md) · [Process Integrity Ledger](shared/policy/PROCESS_INTEGRITY_LEDGER.md) · [Process Blocker Receipt](shared/reporting/PROCESS_BLOCKER_RECEIPT.json) |
| Compile/fuzz/simulation/runner/tool/RPC execution failure | [Execution Preflight & Repair Protocol](shared/execution/EXECUTION_PREFLIGHT_AND_REPAIR_PROTOCOL.md) · [Technical Execution Playbook](shared/execution/TECHNICAL_EXECUTION_REQUEST_PLAYBOOK.md) |
| Missing/corrupt successor handoff | Use the receiving phase's linked handoff reception checklist and recovery ladder; do not ask the human before exhausting it. |
| Source/release identity changed | Return to the current phase's evidence-invalidation obligations plus the [Process Integrity Ledger](shared/policy/PROCESS_INTEGRITY_LEDGER.md); invalidate/rebind source-bound evidence before reuse. |
| Required source absent from accessible GitHub | Exhaust controller/campaign/GitHub-connector recovery, then use the narrow source-upload human exception above. |

Routine repair activity is not a reason to stop or ask the human. Repair and continue.

## Campaign-global audit state

Three mechanical controls span the full audit without requiring agents to preload later phase methodology:

- **Current Phase Contract:** each phase begins with its local [`PHASE_CONTRACT.json`](phases/phase-0/PHASE_CONTRACT.json) pattern. Open only the contract inside the current phase folder. It defines what must happen before that phase can seal.
- **Security Traceability Graph:** [`shared/controller/SECURITY_TRACEABILITY_GRAPH.json`](shared/controller/SECURITY_TRACEABILITY_GRAPH.json) defines the canonical campaign-global graph linking security properties, threats, review/test evidence, candidates/findings, remediation and final claims. Every phase checkpoints it.
- **Carried-Forward Obligation Ledger:** [`shared/controller/CARRIED_FORWARD_OBLIGATION_LEDGER.json`](shared/controller/CARRIED_FORWARD_OBLIGATION_LEDGER.json) defines the canonical `OBL-*` ledger for later-phase work. At phase start, enumerate obligations due now; before sealing, reconcile all of them. A due `OPEN`/`IN_PROGRESS` obligation blocks sealing.

These are campaign-global state artifacts, not extra phases. Their current durable references/digests must be preserved across reviewer handoffs and recorded in every Phase Report.

## Universal phase boundary

Every ordinary phase follows:

`READY → ACTIVE/preflight as applicable → EVIDENCE_SEALED → PHASE_REPORT_SUBMITTED → AUTO_ADVANCE_READY → next authorized state`

There is **no per-phase human approval gate**. `AUTO_ADVANCE_READY` is authorized only when the current Phase Contract, due-obligation reconciliation, invalidation checks, structured filing, and Phase Report are complete. At same-reviewer boundaries the controller immediately enters the next phase `READY`/preflight state. At planned fresh-reviewer boundaries the outgoing reviewer immediately creates the sealed successor handoff + `WAKE_UP_MESSAGE.md`, enters `WAITING_FOR_SUCCESSOR_AGENT`, gives the human the normal report plus copy-ready wake-up block, and stops because the *new agent*, not human approval, is the remaining dependency.

Phase 6 is one audit phase with three mandatory fresh sub-reviewers: **Phase 6A design/admission → Phase 6B Medusa primary adversarial execution → Phase 6C independent Foundry/assurance closure**. These are internal successor boundaries, not new numbered audit phases.

At each phase end, use the phase-specific structured artifact plus the universal [Phase Report](shared/reporting/PHASE_REPORT.md). The report must include **Canonical outputs created**, **New canonical audit facts**, **Carried-forward obligations**, **Evidence invalidation triggers**, and the exact automatic next transition.

Rules and migration behavior are defined by [Automatic Phase Advancement Protocol](shared/controller/AUTOMATIC_PHASE_ADVANCEMENT_PROTOCOL.md).

### Deterministic domain applicability

Specialist-domain coverage is controlled by [`shared/controller/DOMAIN_APPLICABILITY_MATRIX.json`](shared/controller/DOMAIN_APPLICABILITY_MATRIX.json) and the campaign-local registry derived from [`shared/controller/DOMAIN_APPLICABILITY_REGISTRY.json`](shared/controller/DOMAIN_APPLICABILITY_REGISTRY.json). Phase 3 classifies, Phase 4 executes every activated domain, and Phases 6/7 consume/re-evaluate decisions for fuzz/simulation targeting. `UNCERTAIN_INCLUDE` is treated as triggered; ambiguity never authorizes a skip. Detailed rules remain in the active phase card.

## Canonical Source Intelligence

Phase 1 creates the audit-wide immutable structural core from [`SOURCE_INTELLIGENCE_TEMPLATE.json`](shared/source-intelligence/SOURCE_INTELLIGENCE_TEMPLATE.json), initializes the revisioned [runtime/deployment](shared/source-intelligence/RUNTIME_DEPLOYMENT_OVERLAY_TEMPLATE.json) and [assurance-readiness](shared/source-intelligence/ASSURANCE_READINESS_OVERLAY_TEMPLATE.json) overlays, and pins them through the [Bundle Index](shared/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_TEMPLATE.json). The exact generation, acceptance, reuse, ownership and invalidation rules are in [`SOURCE_INTELLIGENCE_REUSE_PROTOCOL.md`](shared/source-intelligence/SOURCE_INTELLIGENCE_REUSE_PROTOCOL.md).

## Phase map — open only the current phase

| Phase | Purpose | Go here |
|---:|---|---|
| 0 | Audit admission, source identity, capability preflight | [Phase 0 →](phases/phase-0/START_HERE.md) |
| 1 | Scope, provenance, build admission, neutral reconnaissance, security risk grade; handoff to reviewer-2 | [Phase 1 →](phases/phase-1/START_HERE.md) |
| 2 | Fresh-reviewer executable specification and canonical security properties | [Phase 2 →](phases/phase-2/START_HERE.md) |
| 3 | Architecture, privileges, dependencies and attack hypotheses | [Phase 3 →](phases/phase-3/START_HERE.md) |
| 4 | Manual implementation and integration review | [Phase 4 →](phases/phase-4/START_HERE.md) |
| 5 | Economic/math review, procedural retrace, handoff to reviewer-3 | [Phase 5 →](phases/phase-5/START_HERE.md) |
| 6 | Three-agent dynamic assurance: 6A design/admission → 6B Medusa attacks → 6C Foundry/coverage closure; then handoff to reviewer-4 | [Phase 6 →](phases/phase-6/START_HERE.md) |
