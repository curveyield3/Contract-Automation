# Lite-Solo Audit Correction v1

## Purpose

A separate corrective lineage for a **completed Lite-Solo v4** campaign. Unlike Audit Preview Completion, it has **no Preview source requirement** and never imports a Preview authority as Lite-Solo evidence. It uses the existing Lite-Solo v4 authority, phase schemas, parallel unit controller (Phases 4–6), and phase-boundary controller (Phases 8–10). It does not create duplicate work-unit controllers, permission mechanisms, tests, or a second security methodology.

The original campaign remains sealed and unchanged. The correction receives its own campaign ID, generation, directory, workspace, controller assignment, and explicit source-receipt digests. Acceptance of a GitHub Actions job is not acceptance of a security finding, unit, phase, or final report.

## Distinct workflow

- Entry: `.github/workflows/lite-solo-audit-correction-v1.yml`
- Transition: `scripts/lite-solo-audit-correction/transition-v1.mjs`
- Request ingress: `process/lite-solo-audit-correction/requests/*.json`
- Existing unit ingress: `process/agent-upload/lite-solo-unit-requests/<correctionCampaignId>/<workerId>-<requestId>.json`
- Existing phase ingress: `process/agent-upload/lite-solo-phase-boundary/<requestId>.json`

Only PREPARE and LAUNCH belong to the new workflow; all subsequent audit execution uses the existing v4 controller.

## Request contract

Submit an **immutable, uniquely named** JSON file to the request ingress on `main`, or invoke the workflow manually with a path to such a file already on `main`:

```json
{
  "schemaVersion": "curveyield-lite-solo-audit-correction-request-v1",
  "operation": "PREPARE",
  "requestId": "example-correction-prepare-1",
  "sourceCampaignId": "existing-completed-lite-solo-campaign-r1",
  "correctionKey": "security-assurance-review-1",
  "startPhase": 8,
  "reason": "Re-evaluate unresolved mandatory obligations and stale execution coverage",
  "obligationIds": [],
  "candidateIds": []
}
```

Required: schemaVersion, operation, requestId, sourceCampaignId, correctionKey, startPhase. startPhase must be one of 4, 5, 6, 8, 9, 10. Phase 7 is controller-automated and cannot be selected directly. sourceCampaignId must be an actually completed, source-bound, controller-sealed LITE_SOLO v4 campaign. For one correction, keep the sourceCampaignId, correctionKey and startPhase unchanged across PREPARE and LAUNCH. A second correction must use a new correctionKey.

PREPARE creates a **STAGED_PRELAUNCH** copy containing the original accepted source/evidence (unaltered), original historical audit context, and a distinct controller directory. The only stage form intended for editing is `controller/LITE_SOLO_CORRECTION_SCOPE_v1.json`, which captures the affected obligation IDs, candidate IDs, and reason. It does **not** edit or replace the original phase submissions. Source and evidence bytes are checked against the original again at LAUNCH.

LAUNCH uses the same JSON shape with `"operation": "LAUNCH"` and a **new** requestId. It requires identical source/terminal/predecessor receipt digests and unchanged imported source/evidence, imports predecessor receipts with exact original digests and provenance, retires later accepted phases **in the isolated fork only**, prepares the selected phase using the frozen Lite-Solo v4 schema, and—when entering 4–6—creates the existing immutable unit plan. Controller-owned state and original receipts are never directly edited.

## Correction semantics and safety

- No authority rebind, source replacement, or audit redeployment is permitted.
- The earlier accepted work is adopted with source-bound `importedFrom` provenance; original receipts stay in the original campaign.
- Later phase evidence can be cited as **historical** prior work; it is not automatically a new PASS in the correction. Any affected property, candidate, obligation, coverage row or final security conclusion requires fresh controller acceptance in the corrective lineage.
- Mandatory obligations requiring a revised disposition are reopened in the fork. Corrective assessments must not silently promote `PARTIAL_COVERAGE` to an unqualified PASS.
- The fork must resolve changed dependencies and any controller-prefill deficiencies under the existing frozen campaign authority. Phase 4–6 workers must use exclusive unit claims; Phase 8–10 use semantic shards and the ordinary phase-boundary mechanism.
- PREPARE and LAUNCH do **not** execute tests, dispatch transactions, deploy contracts or initiate blockchain simulations. Any subsequent test activity is separately governed by explicit authorization and the frozen audit process.
- No automatic migration or disruption of the already-active DAI Preview Completion corrective campaign occurs. Choosing that existing campaign as a source is a separate conscious request once it reaches COMPLETE.

## Terminal condition

A corrective campaign is complete only after controller-accepted work in all required successor phases and a new sealed Phase 10 terminal receipt. A successful PREPARE or LAUNCH means only **staged** or **active**, not repaired or accepted. Publish a superseding security conclusion only when controller evidence establishes its actual assurance.

This entry point exists because ordinary Audit Preview Completion accepts only sealed Preview input, whereas a correction starts from completed Lite-Solo work and must preserve a distinct revision lineage. All underlying phase and unit controllers remain shared.
