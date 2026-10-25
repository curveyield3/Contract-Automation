# Lite-Solo Phase 4/5/6 bounded controller workflow — operations guide

This is a **controller implementation guide**, not a replacement for the campaign-bound audit skill, not a new audit process, and not permission to run tests. It applies to the `curveyield3/Contract-Automation` `lite-solo-phase-controller-v1.yml` workflow. Never edit frozen campaign authority files or reinterpret a phase PASS.

## Phase 4
Continue using existing, sealed discovery unit windows, at most 2 units / 256 KiB; use paginated discovery pages (target 24 KiB) and the selective discovery-unit request. The controller owns state, IDs, source coverage, result receipts, and accepted-unit transitions.

## Phase 5 — bounded candidate dispositions

The controller recognizes a **validation-only** `reviewKind: "candidate-batch"` request. It verifies up to 16 unique, named candidates against the exact Phase-4 canonical source and the existing Phase-5 `reconciliationRecords` in integrity-checked shards. It never runs tests, grants authorization, completes a phase, or waives an unresolved security question. All required candidates must still pass the full phase seal gate. Checkpoint artifacts are stored under `controller/candidate-batches/`; edits invalidate prior row digests.

Example request, committed under `process/agent-upload/lite-solo-phase-boundary/<unique>.json`:

```json
{
  "schemaVersion": "curveyield-lite-solo-phase-boundary-request-v1",
  "reviewKind": "candidate-batch",
  "campaignId": "cyavkatv25b-r6",
  "auditControllerRef": "main",
  "phaseSequence": 5,
  "reviewSection": "step-2",
  "readyCandidateKeys": ["CAND-001", "CAND-002"],
  "attempt": 1
}
```

Use the actual campaign ID and source-bound, ready canonical keys; do not submit this example unchanged. Results are `CANDIDATE_BATCH_ACCEPTED` or `CANDIDATE_BATCH_REWORK`, both **non-terminal**. Read the checkpoint's `progress.nextCandidateKeys` to continue. A full phase request is still mandatory.

Required `phase5ExecutionDisposition` values:
- `EXECUTE`: exactly one controller-bound V7 target required. Run only with separately approved source-bound human authorization.
- `DUPLICATE_OF`: exact covering target with matching security property, source anchor, setup, oracle, fuzz variables, sequence and executable PASS.
- `RETAIN_OPEN_OBLIGATION` or `CONDITIONAL_PENDING_EVIDENCE`: keep evidence-bound mandatory uncertainty in the existing obligation ledger, due in Phase 6 under the bound lite-solo-v1 authority.
- `RESOLVED_NON_MATERIAL`: **currently fails closed**, because the bound authority does not provide independently verified source-disproof machinery; narrative/source anchors alone cannot discharge a concern. Do not use an agent-authored proof PASS flag.

The existing Phase-5 schema continues to define required fields. Additional disposition fields are source-linked extensions of existing reconciliation rows; the original `disposition` values and Phase 4 candidate obligations remain intact.

## Phase 5 — tests, batching and recovery
- No execution or toolchain installation before approved exact `machineExecutionAuthorization` matching campaign source SHA.
- Non-executing candidate validation and semantic preflight are allowed without test authorization.
- The controller uses exact source/request/target/raw-result SHA-256 binding manifests to resume completed runs without repeating them.
- Pending execution batches may continue through authorized `workflow_dispatch` under the existing `lite-solo-phase-controller-v1.yml` workflow. The dispatch carries the original request file path and exact SHA-256, and rechecks current campaign approval. It is bounded to 16 attempts, never an unbounded agent wake/poll.
- If 16 attempts are reached, progress remains durable; the agent must inspect pending targets and authorize further continuation through the ordinary process.
- A green GitHub Actions run only means the controller executed; `NEEDS_REWORK`, `PENDING_BATCH` and `PASS` are distinct.

## Phase 6 — bounded candidate proof review

Use the same validation-only `candidate-batch` request with `phaseSequence: 6` and `reviewSection: "step-2"` for target dispositions or `"step-5"` for candidate proof records. The checkpoint validates exact canonical candidate IDs, source linkage and the selected section's semantic completeness. The complete Phase 6 submission still requires all schema work and authentic evidence, including required baseline and attack/control testing. Never interpret a checkpoint as a test or a security finding.

## Identity, obligations and Phase 10 assurance

Phase-5 seal publishes `controller/CANDIDATE_IDENTITY_INDEX_v1.json` from the canonical source, with temp-key aliases only for lookup. Phase 6 and 8 consume its canonical identities.

Under the currently bound Lite-Solo authority, newly retained Phase-5 security obligations are due in Phase 6. Phase 8/9/10 do not currently provide a schema-governed direct closure field. The controller does not accept self-certified `RESOLVED_NON_MATERIAL`. Phase 10 publishes `securityAssurance.status` separately from `campaignStatus: COMPLETE`; open mandatory obligations are `INCOMPLETE_MANDATORY_OBLIGATIONS_OPEN` and never claimed as resolved.

## Read views and error handling

Derived-input pages are optional. The full source JSON, identified by SHA-256, remains authoritative. Oversized indivisible records are preserved untruncated with a warning. Hash-invalid pages fail validation; oversized optional indexes fall back to the canonical file with typed recovery guidance.

Controller errors are durably stored in the campaign's phase packet and paginated controller results. Short inline feedback intentionally shows the first 24 errors with the total count: read all `packet.controllerValidation.deficiencies`, plus the `shardRework` mapping, before correcting.

## Bound authority caveat

The existing `Audit Skill - Lite-Solo Authority/lite-solo/` is receipt-bound. Do **not** modify its frozen instruction/schema digests. The older Phase-5 instruction's arbitrary fuzz budget, separate test executor, and stale workflow names are known inconsistencies; the authoritative active controller and exact source-bound human-test authorization remain mandatory. A future skill-authority release/migration must be versioned, with receipt compatibility and explicit human signoff, not silently replaced mid-campaign.
