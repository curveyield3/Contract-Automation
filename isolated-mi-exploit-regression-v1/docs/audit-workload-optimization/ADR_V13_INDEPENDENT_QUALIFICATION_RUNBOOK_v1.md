# ADR v13 — independent detection qualification (v1)

## Live activation vs. independent detection qualification

On October 15, 2026 the owner authorized activation of the v13 audit process so real testing could begin. **The 41-defect qualification is still NOT completed or claimed.** Activation and independently proven detection effectiveness are separate states. New v13-bound campaigns may execute the `correctness-verdict-v13` Phase-0/Phase-4 workflow before a private seeded campaign scores. The v12 authority remains frozen for previously bound campaigns.

**Measured qualification** still requires at least 30 confirmed detections of 41 hidden defects (baseline 14), ZERO flagged decoys and ZERO Critical/High false positives on clean controls, independently adjudicated and human-reviewed. A successful local unit fixture or an owner-approved launch is not qualification evidence.

The optional, fail-closed **qualification-certificate verifier** is `packages/github-native-sim/src/adr-v13-release-gate-v1.mjs`. It checks genuine `QUALIFICATION_SCORE_v1.json` and `QUALIFICATION_PASS_v1.json` before anyone claims `QUALIFIED`; it is no longer used to block audit/benchmark execution in Phase 0 or Phase 4. **Do not fabricate these files to enable audits.**

## Private run inputs — never commit

Use a sealed truth manifest stored **outside the repository, campaign, artifact uploads, project chats, reviewer packets and workflow logs**. Provide its absolute path via `PRIVATE_SEEDED_TRUTH_FILE`. JSON schema:

```json
{
  "schemaVersion": "curveyield-private-seeded-truth-v1",
  "expectedDefects": 41,
  "baselineCaught": 14,
  "minCaught": 30,
  "cases": [
    {
      "caseId": "PRIVATE-CASE-ID",
      "kind": "defect",
      "severity": "HIGH",
      "classId": "ACCESS_CONTROL",
      "contract": "NamedContract"
    }
  ]
}
```

The actual manifest also includes separate `kind: "decoy"` and `kind: "clean_control"` cases. The example above is a shape example only, **not** a seeded campaign. Every `caseId` must be unique.

Independently audited agents work with the real frozen source, technical evidence, and the v13 review procedure **without access to the answer key**. A separate adjudicator, also not acting as a discovery reviewer, matches observed findings to private truth. Collect:

- `findings.json`: an array of objects with distinct `findingId`, `caseRefs` (array of private case IDs) and `severity`. Findings without source-supported adjudication do not count.
- `adjudications.json`: an array of `{ "caseId", "findingId", "match": "MATCH" | "NO_MATCH" }`; any `severityReadjudicated: true` requires a substantive `reason`.
- Optional `partial.json`: array of distinct private case IDs that were partially identified but not caught.
- Optional `leak-stages.json`: object mapping missed case IDs to pipeline stage labels for private diagnosis.

Do **not** publish findings containing answer-key case IDs or any partial/private diagnostic files. False-positive and catch counts are the only public qualification observations.

## Reproducible scoring, private environment only

Run from a trusted clone in an isolated CI environment whose filesystem can access the private manifest. Do not echo the manifest filename into public logs. No protocol deployment or Solidity compile is needed to run this scorer.

```bash
export PRIVATE_SEEDED_TRUTH_FILE=/private/secure/sealed-truth.json
node packages/github-native-sim/src/adr-seeded-score-cli-v1.mjs \
  /private/review/findings.json \
  /private/review/adjudications.json \
  /private/review/partial.json \
  /private/review/leak-stages.json \
  > /private/review/PRIVATE_SEEDED_SCORE_v1.json
```

Exit status **0** means the aggregate gate passed, **2** means a correctly evaluated but failed threshold, and **3** means an invalid input or another scorer failure. The scorer emits no raw private cases, source code, manifest path, private per-case IDs, or private case-level leak-stage references. It does emit totals by severity/class/contract, an aggregate critical/high miss count, and aggregate counts by leak stage.

A separate human review must verify the frozen source identity, complete/unchanged campaign, independent adjudication, actual score, decoys, clean controls, and materiality before signing off. **Do not create a qualification receipt just because a fixture test passes.**

**Never commit the private scorer's full output.** It contains aggregated *contract names, taxonomy class names and leak-stage labels* that could reveal clues about hidden seeded cases. Convert it to a release-safe, count-only JSON artifact:

```bash
node scripts/adr-v13-public-score-v1.mjs \
  /private/review/PRIVATE_SEEDED_SCORE_v1.json \
  /private/review/QUALIFICATION_SCORE_v1.json
```

The exporter refuses failed qualifications and strips the private breakdowns. Inspect its small public output before publishing. Keep the rich private score and underlying truth/adjudications in the sealed evaluation environment only.

## Minimal public production artifacts — only after success

Publish only two current live files in `process/qualification/adr-v13/`:

1. `QUALIFICATION_SCORE_v1.json`: exact unmodified UTF-8 bytes produced by the **public count-only exporter** (not the private scorer), with `schemaVersion: "curveyield-seeded-detection-score-v1"`, 41 defects, at least 30 caught, `decoysFlagged: 0`, `cleanControlCriticalHighFalsePositiveCount: 0`, and `gate.passed: true`.
2. `QUALIFICATION_PASS_v1.json`: a human-reviewed decision using this exact schema, with `scoreSha256` equal to the SHA-256 of the **whole score file bytes** (including newline):

```json
{
  "schemaVersion": "curveyield-adr-v13-qualification-pass-v1",
  "status": "QUALIFIED",
  "seededDefects": 41,
  "baselineCaught": 14,
  "caught": 30,
  "decoysFlagged": 0,
  "cleanControlCriticalHighFalsePositives": 0,
  "independentRunId": "REAL-INDEPENDENT-RUN-ID",
  "reviewedBy": "REAL-HUMAN-REVIEWER",
  "scoreSha256": "64_lowercase_hex_characters"
}
```

The numbers shown are the minimum qualifying example, **not** evidence that v13 passed. Do not publish placeholder receipts. The gate verifies both the receipt and score file, recomputes the score hash, verifies their counters match, and fails closed on missing, mismatched, malformed, fractional, or subthreshold values. The score file is an evidence artifact; it does not become another reviewer work form. The public score must not include the private `byContract`, `byClassId`, `byLeakStage`, case IDs, or stage-name breakdowns.

## Verification before enabling v13

From the exact release checkout run the following in GitHub CI (not on the local workstation):

```bash
node --input-type=module -e 'import {verifyV13ReleaseV1} from "./packages/github-native-sim/src/adr-v13-release-gate-v1.mjs"; console.log(verifyV13ReleaseV1({repoRoot:process.cwd()}))'
node --test packages/github-native-sim/test/adr-v13-release-gate-v1.test.mjs
```

Only a genuine passing external 41-defect run may create the two qualification artifacts. The owner has separately approved running v13 audits while this qualification remains pending. A v13 audit must still separately pass the ordinary inventory, review, deployment, evidence, targeted-test, and final controller gates. This qualification does **not** replace them.

## Rollback / safety

If v13 underperforms, is unqualified, or emits unsupported findings, withhold both public qualification artifacts and report the result honestly. Owner-authorized v13 execution remains available for testing; previously frozen v12 campaigns continue unchanged unless explicitly rebound. Never misrepresent an unqualified run as qualified, mutate sealed v12 campaign receipts, or commit the private answer key.
