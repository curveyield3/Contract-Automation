# Audit v13 independent qualification — v1

The v13 audit/review changes do **not** authorize a production release. The code and CI regressions are separate from independent blind defect qualification.

## Required private setup

Configure a protected GitHub Actions environment named `v13-independent-qualification`. Only the independent adjudicator should have access to its secrets:

- `V13_QUALIFICATION_PRIVATE_TOKEN`: read-only credential for an external, private answer-key repository.
- `V13_QUALIFICATION_PRIVATE_REPO`: that private repository as `owner/repo`.
- `V13_QUALIFICATION_PRIVATE_PATH`: manifest JSON path within that private repository.
- `V13_QUALIFICATION_PRIVATE_REF`: pinned immutable manifest revision.
- Existing `AUDIT_CONTROLLER_GITHUB_TOKEN` or the approved fallback must read Audit-Controller.

No answer-key content, private case IDs, per-contract classifications, underlying source ZIP, or full private score may be uploaded to this automation repository or exposed to reviewer chats.

## Independent real run

1. Independently create or identify a completed seeded campaign with exactly **41 actual defects** and a private manifest bound to both `campaignId` and `sourceSha256`. The 14-defect baseline is a comparison, not a replacement.
2. Complete the full v13 audit with independent reviewers **without** giving any reviewer the hidden manifest.
3. Dispatch `.github/workflows/adr-v13-independent-qualification-v1.yml` with the exact `campaign_id`, `campaign_path`, and **immutable 40-character Audit-Controller commit SHA**. Require the protected environment's independent approval.
4. The workflow verifies source and campaign binding, extracts **actual** accepted findings, checks source/class/contract overlap against the **private** truth, checks reviewer-readable answer-key leakage, and tests the threshold **caught >=30 of 41**, **zero decoys**, and **zero Critical/High clean-control false positives**. It publishes at most a count-only GitHub Actions summary.
5. The independent human adjudicator must review ambiguous source matches, missed severity classes, all depth spotchecks and the exact workflow result. Private source-matching ambiguity does **not** count as caught. If the qualification fails, **do not** claim a release pass.
6. Only after a genuine, separately reviewed successful run should the adjudicator publish the existing count-only `process/qualification/adr-v13/QUALIFICATION_SCORE_v1.json` and corresponding `QUALIFICATION_PASS_v1.json`, including its exact SHA-256 and run provenance. The existing `verifyV13ReleaseV1` must return `QUALIFIED`. No automation in this PR manufactures the PASS receipt.

## Failure and compatibility policy

The workflow fails closed on missing secrets, no private truth, mismatched campaign ID/source hash, non-completed campaign, leaked hidden identifiers, ambiguous matches that prevent threshold success, or fewer than 30 verified defects caught. Its absence means **NOT RELEASE-QUALIFIED**, even when all normal CI tests pass.

Frozen v12 campaigns retain their established review and delivery path. The new qualification process is scoped to v13, and GitHub Actions runs (including synthetic tests) are **not** evidence that the real 41-defect audit has occurred.
