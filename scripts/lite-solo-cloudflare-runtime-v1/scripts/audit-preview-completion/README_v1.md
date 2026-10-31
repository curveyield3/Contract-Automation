# Audit Preview Completion v1

## Why this fork exists

The ordinary Lite-Solo source initializer begins at Phase 0 and the existing controller rejects Preview-authority receipts. Audit Preview Completion is an isolated PREPARE/LAUNCH continuation that imports controller-sealed Preview evidence, allows optional Phase-4 substantive corrections on a separate editable fork, and proceeds to Phase 5 under the full Lite-Solo v4 security requirements. It never mutates an original Preview or Lite-Solo workflow, authority file, or accepted receipt.

## Forked process set

- .github/workflows/audit-preview-completion-v1.yml — PREPARE/LAUNCH
- .github/workflows/audit-preview-completion-unit-controller-v1.yml — Phase 5–6 immutable units
- .github/workflows/audit-preview-completion-phase-controller-v1.yml — Phases 8–10
- .github/workflows/audit-preview-completion-phase5-authorization-v1.yml — explicit execution authorization, with no tests run by this authorization workflow
- scripts/audit-preview-completion/transition-v1.mjs — validated immutable evidence import, optional edits, successor assignment
- scripts/audit-preview-completion/verify-readonly-v1.mjs — frozen-chain historical eth_call and runtime verification, never transactions or tests
- scripts/audit-preview-completion-unit-request-drain-v1.mjs — forked namespace isolated unit controller

All created files include v1. Shared, unmodified Lite-Solo v4 schemas and helper libraries are reused. No second methodology or security-audit authority is introduced.

## Requests

Add a unique JSON file under process/audit-preview-completion/requests/ on Contract-Automation main:

{
  "schemaVersion": "curveyield-audit-preview-completion-request-v1",
  "requestId": "dai-preview-completion-prepare-v1",
  "operation": "PREPARE",
  "previewCampaignId": "audit-preview-live-ethereum-dai-6b175474-r1"
}

PREPARE validates sealed Preview receipts 0–4, copies original evidence into a distinct audit-preview-completion campaign, and writes an editable PRELAUNCH_PHASE_04_WORK_FORM_v1.json inside the continuation. The original sealed Preview is never edited. The new campaign remains STAGED_PRELAUNCH.

**Optional Phase-4 editing before actual LAUNCH:** Edit only the continuation's work/phase-04/PRELAUNCH_PHASE_04_WORK_FORM_v1.json. Preserve controller-owned fields, all record identities, source anchors, and non-optional audit observations. The default proposal precisely distinguishes successfully verified live-chain state from ward-roster and external-governance questions that were not independently resolved.

Create a second unique request using operation LAUNCH and the same previewCampaignId. Optional wardCandidates is an array of additional addresses to read at the campaign's frozen block. LAUNCH recomputes historical read-only evidence, checks runtime, chain and block hashes, requires matching source and unchanged accepted Preview snapshots, validates the edited Phase-4 form, imports prior receipts with explicit original-provenance hashes, seals the *continuation* Phase 4, and prepares full Lite-Solo Phase-5 parallel units.

## Continuation worker transport

Phase-5/6 immutable unit requests:
process/agent-upload/audit-preview-completion-unit-requests/<campaignId>/<workerId>-<requestId>.json

Phase-8/9/10 boundary requests:
process/agent-upload/audit-preview-completion-phase-boundary/<requestId>.json

Workers bind to the new campaign's ID, generation, source SHA-256, authority digest, queue index and claim token. Original Lite-Solo and Audit Preview request prefixes are not used for continuation requests.

## Security and test policy

PREPARE and LAUNCH do not execute tests, deploy transactions or attacks. The Phase-5 finalizer blocks source-bound test execution until the dedicated Audit Preview Completion authorization workflow records a current matching APPROVED authorization in the continuation's directory. No such approval is inherited from Preview. Do not run tests until separately authorized.

A read of wards(address) for one or more candidates is not an exhaustive historical ward census. Establishing a complete roster requires reconstructed creation/anonymous LogNote events and corresponding block-pinned reads. Beneficial key custody, governance controls outside DAI, backing and redemption are separate risks. Do not assert they were proven from the token's on-chain state.
