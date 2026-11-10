# Audit Detection Rebuild v2 — T8–T10: Skill v12, Frozen v11, Activation and Qualification

> **For the implementing agent:** `00_BUILD_CONTRACT_v2.md` applies in full. T0–T7 must be merged before T8. Follow the release order in 00 §6 exactly; it is what prevents campaigns from pointing at missing files.

Supersedes `03_QUALIFICATION_AND_ROLLOUT_v1.md` (removed; Git history keeps it). The v1 rule "keep the new policy disabled until qualified" is replaced by D8. The v1 step "run the disclosed original benchmark" is deleted (D9).

---

## T8 — Author skill v12 in a staging folder

**Goal:** a complete `Audit_Litemode_v12` package that passes the authority/automation sync validator. It is placed outside `Audit Skill - Current Authority`, so nothing changes for live or new campaigns yet.

This task has two PRs: first Contract-Automation, then Audit-Controller.

### T8.1 Contract-Automation PR (`upgrade/adr-T8-validator`)

1. In `scripts/validate-lite-authority-automation-sync-v1.mjs`:
   1. Add an optional argument `--authority-root <repo-relative path>`. When it is given, validate that package directory instead of discovering the single package (search `need(packages.length===1`). When it is not given, keep today's behavior.
   2. Delete the check containing `PHASE0_MEDUSA_CALL_LIMIT_V1=125000`.
   3. Run the validator against current main through the T0 job (next step). If any other check fails only because it requires retired Phase 0 Medusa or telemetry text or artifacts, delete that check too and list each deleted check in the PR.
   4. In the `phase0Corpus` list (search `const phase0Corpus=[`), add `read(join(automationRoot,'scripts/write-phase0-fork-deploy-outputs-v1.mjs'))`. That script is where `evidence/review-inventory/DEPLOYED_STATE_SNAPSHOT_v1.json` is written, and the v12 Phase 0 contract lists it as a required output.
   5. Do not weaken any other check.
2. At the marker `# ADR-EXTRA-CHECKS` in `scripts/adr-audit-controller-checks-v1.sh`, add the following (keep the T0 "no new failures" rule: it fails only if target fails and main passes):
   1. Read the optional file `process/adr-verify/AUTHORITY_ROOT_v1.txt`. Create it in this PR containing an empty line.
   2. For both checkouts, run `node scripts/validate-lite-authority-automation-sync-v1.mjs --controller-root <checkout> --automation-root .`. For the target checkout only, append `--authority-root <value>` when the file is non-empty.
   3. Fail if the target fails while main passes.
3. Done when the T0 workflow is green with both ref files at their defaults (`main` and empty).

### T8.2 Audit-Controller PR (`upgrade/adr-T8-skill-v12`)

1. Copy the whole directory `Audit Skill - Current Authority/Audit_Litemode_v11/` to `audit-process/v7/staging-authority/Audit_Litemode_v12/`. Copy every file byte-for-byte first, then edit only as listed below.

   **How to copy whole package directories (T8.2, T9.2, T9.4).** These folders hold about 150 files each. Never recreate them one file at a time through the API. Use a local clone with line-ending conversion **disabled**, otherwise the frozen digests will not match:

```bash
git clone https://github.com/curveyield3/Audit-Controller.git ac && cd ac
git config core.autocrlf false && git config core.longpaths true
git checkout -b <task branch>
# copy:   cp -a "<source dir>/." "<destination dir>/"     (T8.2, T9.2)
# move:   git mv "<source dir>" "<destination dir>"        (T9.4)
git add -A && git commit -m "<message>" && git push -u origin <task branch>
```

   If your environment cannot run `git`, stop and give the owner these exact commands to run; do not attempt an API-based copy.
2. Apply **every** edit in Appendices A–E to the copy. Do not edit any file in `Audit Skill - Current Authority/`.
3. `MANIFEST.json` in the copy:
   - set `"schemaVersion": "audit-litemode-v12-manifest-v1"`, `"release": "Audit_Litemode_v12"` and `"packageRevision": "v12"`;
   - add `"detectionPolicy": "audit-detection-rebuild-v1"` and `"taxonomyVersion": "curveyield-defect-taxonomy-v1"`;
   - leave `files` as copied. The existing ZIP-sync workflow regenerates `files` after the swap in T9.
4. Verify:
   1. Open a Contract-Automation PR `upgrade/adr-T8-check` that only sets `process/adr-verify/AUDIT_CONTROLLER_REF_v1.txt` to `upgrade/adr-T8-skill-v12` and `process/adr-verify/AUTHORITY_ROOT_v1.txt` to `audit-process/v7/staging-authority/Audit_Litemode_v12`.
   2. The `audit-controller-checks` job must be green.
   3. Fix the AC branch until it is.
   4. Merge the AC PR.
   5. In the check PR, set the ref file back to `main` and keep the authority-root line. The job then validates the staging package on main. Merge the check PR once it is green.

**Done when:** the staging package is on AC `main`, the validator passes on it, and `Audit Skill - Current Authority` is unchanged.

---

## T9 — Frozen-authority registry, v11 freeze and the v12 swap

**Goal:**
- Campaigns bound to v10.3 or v11 keep resolving their authority files after v11 leaves `Audit Skill - Current Authority`.
- Then v12 becomes the current authority.

### T9.1 Contract-Automation PR (`upgrade/adr-T9-frozen-resolver`)

1. **Create `packages/github-native-sim/src/adr-frozen-authority-v1.mjs`.**
   - `loadFrozenAuthorityRegistryV1(root)` reads `audit-process/v7/frozen-authorities/FROZEN_AUTHORITY_REGISTRY_v1.json` from the Audit-Controller checkout `root`. If the file is missing, it returns the built-in default containing exactly the v10.3 entry, using the constants currently in `scripts/lib/lite-phase-work-v1.mjs` (search `LEGACY_V103_`).
   - `resolveFrozenAuthorityFileV1(root, rel)`:
     - for the registry entry whose `logicalRoot` equals `rel` or is a prefix of `rel + '/'`, and only when the logical file does not exist;
     - verify the frozen `SKILL.md` sha256, the frozen `MANIFEST.json` sha256, and the requested file's bytes and sha256 against the manifest `files` entry, with exactly the algorithm of the current `frozenV103File`;
     - return the absolute frozen path, or `null` when no entry matches;
     - throw the same error messages as today on any digest mismatch.
   - `authorityLinkPathV1(root, rel)` returns the frozen repository-relative path when the logical path does not exist and an entry matches; otherwise it returns `rel`.
2. **`scripts/lib/lite-phase-work-v1.mjs`:** in `requiredFile`, replace `frozenV103File(root,rel)` with `resolveFrozenAuthorityFileV1(root,rel)`. Delete `frozenV103File` and the `LEGACY_V103_*` constants, which now live in the default registry. `requiredFile` behavior for every existing path must be identical.
3. **`scripts/prepare-lite-assignment-successor-v2.mjs`:** replace the `authorityLinkPath` arrow function body with a call to `authorityLinkPathV1(root, p)`. Delete `legacyLogicalRoot` and `frozenAuthorityRoot`.
4. **`scripts/lib/lite-master-review-v1.mjs`:** replace `const isV11=/Audit_Litemode_v11(?:\/|$)/.test(String(authorityRoot??''));` with `const rev=Number((String(authorityRoot??'').match(/Audit_Litemode_v(\d+)(?:\.\d+)?(?:\/|$)/)||[])[1]??0); const isV11OrLater=rev>=11;` and use `isV11OrLater` in the next line. Do not change the sealed-rework v10.3 checks.
5. **`scripts/lib/lite-post-completion-followup-v1.mjs`:** replace the exact comparison with `'Audit Skill - Current Authority/Audit_Litemode_v11/SKILL.md'` by the regex test `/^Audit Skill - Current Authority\/Audit_Litemode_v(1[1-9]|[2-9][0-9])\/SKILL\.md$/`.
6. **`.github/workflows/lite-phase-work-packet-controller-v1.yml`:**
   - search `guide='Audit Skill - Current Authority/Audit_Litemode_v11/master-review/TARGETED_TEST_DIRECTIVE_v1.md'`;
   - make the controller print an extra output `authorityLinkRoot`, equal to `authorityLinkPathV1(root, authorityRoot)`, for every status;
   - read it in the controller step outputs as `authority_link_root`;
   - set `guide="${{ steps.controller.outputs.authority_link_root }}/master-review/TARGETED_TEST_DIRECTIVE_v1.md"`.
7. **`.github/workflows/browser-agent-reviewer-repair-v1.yml`.** This workflow has no Audit-Controller checkout; it reads files through `gh api`. Search for `legacy_root='Audit Skill - Current Authority/Audit_Litemode_v10.3'`. Directly **after** the existing `fi` that closes that `if` block, add the following (keep the v10.3 block as a fallback):

```bash
registry_json="$(gh api "repos/$gate_repo/contents/audit-process/v7/frozen-authorities/FROZEN_AUTHORITY_REGISTRY_v1.json?ref=$gate_ref" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || true)"
if [ -n "$registry_json" ] && ! gh api "repos/$gate_repo/contents/$(encode_path "$authority_home")?ref=$gate_ref" >/dev/null 2>&1; then
  mapped="$(printf '%s' "$registry_json" | jq -r --arg h "$authority_home" '.entries[] | . as $e | select($h | startswith($e.logicalRoot + "/")) | $e.frozenRoot + ($h | ltrimstr($e.logicalRoot))' | head -n1)"
  [ -z "$mapped" ] || authority_home="$mapped"
fi
```

   Make no other change to this workflow.
7a. **`.github/workflows/lite-post-completion-followup-regression-v1.yml`.** In its `git sparse-checkout set` list, directly after the line `'Audit Skill - Current Authority/Audit_Litemode_v11' `, add the line `'audit-process/v7/frozen-authorities' `. Keep the v11 line. After the swap the v11 path no longer exists, and the frozen copy is what resolves.
8. **Create `scripts/adr-check-frozen-authorities-v1.mjs`** (CLI `--controller-root <dir>`). For every registry entry it verifies:
   - the `SKILL.md` and `MANIFEST.json` digests;
   - every `files` entry exists with matching bytes and sha256;
   - every file in the frozen directory except `MANIFEST.json` is listed.
   - It prints, for every entry, `<release> skillSha256=<actual> manifestSha256=<actual>`, so the values for T9.2 can be copied from the job log.
   - It exits non-zero with a list of problems (expected and actual for each mismatch).
   - Add a call to it at the `# ADR-EXTRA-CHECKS` marker for the target checkout. It is skipped when the registry file is absent.
9. **Tests** — `packages/github-native-sim/test/adr-frozen-authority-v1.test.mjs`, using temporary directories:
   - a v10.3 logical path resolves through the built-in default;
   - a v11 logical path resolves through a registry entry;
   - a tampered frozen file throws;
   - an existing logical path is returned unchanged;
   - `authorityLinkPathV1` maps only missing logical paths;
   - `masterReviewRequired` returns true for v11 and v12 roots that have a valid `masterReview` and throws for them without one, exactly like v11 today.

### T9.2 Audit-Controller PR (`upgrade/adr-T9-freeze-v11`)

v11 stays in Current Authority in this PR.

1. Copy `Audit Skill - Current Authority/Audit_Litemode_v11/` byte-for-byte to `audit-process/v7/frozen-authorities/Audit_Litemode_v11/`, using the git procedure in T8.2.
2. Create `audit-process/v7/frozen-authorities/FROZEN_AUTHORITY_REGISTRY_v1.json`:

```json
{
  "schemaVersion": "curveyield-frozen-authority-registry-v1",
  "entries": [
    {"release": "Audit_Litemode_v10.3",
     "logicalRoot": "Audit Skill - Current Authority/Audit_Litemode_v10.3",
     "frozenRoot": "audit-process/v7/frozen-authorities/Audit_Litemode_v10.3",
     "skillSha256": "bdb90107ea50580e67be91440ce47087de570c4f54b8474c5a3eb852af95ea27",
     "manifestSha256": "846be5f90d6e00757b817b1218dfabeb2aa4dff6c92b8e9ff47335d2db83703a"},
    {"release": "Audit_Litemode_v11",
     "logicalRoot": "Audit Skill - Current Authority/Audit_Litemode_v11",
     "frozenRoot": "audit-process/v7/frozen-authorities/Audit_Litemode_v11",
     "skillSha256": "<sha256 of the copied SKILL.md>",
     "manifestSha256": "<sha256 of the copied MANIFEST.json>"}
  ]
}
```

   Get the two v11 digests from the T0 job log. The T9.1 checker prints `skillSha256=` and `manifestSha256=` for every entry. Run the check once with the placeholders, copy the two printed values for `Audit_Litemode_v11` into the registry, and run it again until it is green.
3. Verify with a Contract-Automation check PR setting the ref file to `upgrade/adr-T9-freeze-v11`. Both the frozen-authority checker and the "no new failures" checks must be green. Then merge the AC PR and set the ref back to `main` in the check PR.

### T9.3 Swap readiness test (Contract-Automation PR `upgrade/adr-T9-swap-check`)

1. Create `packages/github-native-sim/test/adr-real-authority-swap-v1.test.mjs`. It runs **only** when the environment variable `ADR_SWAPPED_CONTROLLER_ROOT` is set, and is skipped otherwise. It:
   1. asserts that `Audit Skill - Current Authority` contains exactly one directory with `SKILL.md`, that it is `Audit_Litemode_v12`, and that its `MANIFEST.json` has `detectionPolicy` (the same rule `run-v1.sh` uses);
   2. calls `loadPhaseSchema` for phases 1–10 on the v12 root;
   3. for every file in `Audit Campaign Directory/campaigns/*.json`, follows `lastSealedReceiptPath` → `authorityRootFromReceipt`, then calls `loadPhaseSchema` for the campaign's current or last phase and `requiredFile` on its `SKILL.md`, all of which must resolve. In this sparse checkout, read only the receipt files the directory names (fetch them with `git show <ref>:<path>`).
2. At the `# ADR-EXTRA-CHECKS` marker, add: if the target ref name ends with `-swap`:
   1. copy the target checkout to `.ac-swapped`;
   2. run `node --test packages/github-native-sim/test/adr-real-authority-swap-v1.test.mjs` with `ADR_SWAPPED_CONTROLLER_ROOT=.ac-swapped`;
   3. fail if the test fails.

### T9.4 Audit-Controller swap PR (`upgrade/adr-T9-swap`)

1. Using the git procedure in T8.2, run `git mv "audit-process/v7/staging-authority/Audit_Litemode_v12" "Audit Skill - Current Authority/Audit_Litemode_v12"`.
2. Run `git rm -r "Audit Skill - Current Authority/Audit_Litemode_v11"`. Leave `Audit_Litemode_v11.zip` in place; the sync deletes stale ZIPs.
3. In `test/lite-semantic-automation-policy.test.mjs`, search `assert.equal(manifest.release,'Audit_Litemode_v11')`. Replace the hard-coded release with: find the single package directory, then assert `manifest.release` equals its directory name.
4. In `README.md`, under "Primary Lite methodology authority", replace the sentence that claims the pointer binds a ZIP path and SHA-256 with: "The pointer names the stable authority folder; the single unpacked package inside it is resolved at runtime and its release, revision and digest are recorded in each campaign."
5. Verify with the Contract-Automation check PR, setting the ref file to `upgrade/adr-T9-swap` (the name ends with `-swap`, so T9.3 runs). Everything must be green.
6. Merge the AC swap PR. Then:
   1. set the ref file back to `main` in the check PR and wait for green;
   2. merge the check PR;
   3. run the `Sync Lite Authority ZIP v2` workflow with `workflow_dispatch`. If you cannot dispatch workflows, wait for its daily 06:23 UTC run;
   4. confirm the commit `chore(authority): sync current Lite authority package and zip` added `Audit_Litemode_v12.zip`, removed `Audit_Litemode_v11.zip` and filled `MANIFEST.json` `files`.
7. **Done when:**
   - the sync commit exists;
   - the T0 workflow on `main` is green;
   - the v16 r4 directory entry still resolves through T9.3's checks (it is bound to v11 and now resolves to the frozen copy).

Do not initialize any campaign before this point.

---

## T10 — Qualification scorer, runner-pin documentation, rejection matrix and close-out

### T10.1 Detection qualification scorer (non-blocking measurement tool)

1. **Create `packages/github-native-sim/src/adr-detection-qualification-v1.mjs`** exporting `scoreQualificationV1({truth, findings, adjudications})`.
   - `truth` rows are `{caseId, kind:"defect"|"decoy"|"clean_control", severity, classId, contract}`.
   - `findings` rows are `{findingId, caseRefs, severity}`.
   - `adjudications` rows are `{caseId, findingId, match:"MATCH"|"NO_MATCH", severityReadjudicated:boolean, reason}`.
   - It returns:
     - `recall` overall and by `severity`, `classId` and `contract`, each `{matched, total}`, or `NOT_EVALUATED` when `total` is 0;
     - `precision`;
     - `decoyHits`;
     - `cleanControlCriticalHighFalsePositives`;
     - `severityAgreement`;
     - `criticalHighMisses`.
   - **Severity rule:** a Critical or High defect matched by a finding rated below High counts in `criticalHighMisses`, unless the adjudication has `severityReadjudicated:true` with a non-blank reason.
   - Duplicate findings for one case count once.
   - A title match without an adjudication `MATCH` is not a match.
2. **Tests:** `packages/github-native-sim/test/adr-detection-qualification-v1.test.mjs`. Use synthetic data only; never data from a real campaign. Cover:
   - each rule above;
   - zero denominators give `NOT_EVALUATED`;
   - a decoy hit lowers precision.
3. **Qualification status** is a Contract-Automation file `process/adr-qualification/QUALIFICATION_STATUS_v1.json`, created in this task with `{"status":"NOT_YET_QUALIFIED","updatedAt":"<now>"}`.
   - In the T7.4 coverage block, the controller appends the line `Detection qualification status: <status>` to the Phase 10 evidence index. The file is read from the Contract-Automation checkout.
   - Only the owner changes this file, after running a qualification corpus.
   - Answer keys must never be stored in Contract-Automation (public logs and artifacts) or Audit-Controller (reviewers can read it). The owner keeps them in a separate private location and runs the scorer locally or in a private runner.
   - This task does not build a corpus.

### T10.2 Runner-pin documentation alignment

The full V7 infrastructure qualification was retired on 2026-10-11 (see `.github/workflows/README.md`), and `process/V7_QUALIFICATION_STATUS.json` is legacy. Align the documents with that fact. Change text only.

1. **Contract-Automation `AGENTS.md`, section "V7 qualification".** Replace the paragraph naming `.github/workflows/v7-execution-infrastructure-qualification.yml` with: "The repository-wide full V7 qualification workflow was retired on 2026-10-11 and preserved in curveyield3/archive. Lite execution evidence records the exact runner commit of each run in EXECUTION_EVIDENCE_v1.json; Lite campaigns do not require a qualification rebind. Do not restore the archived suite."
2. **Contract-Automation `AGENTS.md`, list "Canonical V7 control surface".** Remove the qualification workflow line.
3. **Audit-Controller `AGENTS.md`, section "V7 qualified runner rebind".** Add as its first sentence: "Applies only to Full V7 (v26) campaigns. Lite campaigns bind the exact runner commit recorded in each execution evidence file and need no rebind."
4. **Audit-Controller `docs/agent-guides/V7_RUNNER_REBIND_PROTOCOL_v1.md`.** Add the same sentence under "## Purpose".

### T10.3 Rejection-matrix test

Create `packages/github-native-sim/test/adr-rejection-matrix-v1.test.mjs`. It has one `test()` per row below. Each test calls the named module function with a minimal synthetic input and asserts the expected result.

| Row | Function | Expected |
|---|---|---|
| A → B → C contracts chained by external calls | `buildFlowPlanV1` | One flow spans all three; it is never split across units; one cluster; one X unit |
| 30 contracts; 2 units accepted, the rest invalid 3× | `advanceDiscoveryV1` loop | The rest are recorded as gaps; label `PARTIAL_COVERAGE`; campaign reaches Phase 4 (not stuck) |
| Internal/private helper exists | `buildReviewInventoryV1` | Helper is a context with triggers |
| Inherited base function in 2 contracts | `buildReviewInventoryV1` | One context; `effectiveIn` lists both |
| Anchor in a different contract than the reviewed context | `validateFlowReviewSubmissionV1` | Accepted |
| Anchor beyond the file's last line | `validateFlowReviewSubmissionV1` | `ANCHOR_INVALID` |
| Same boilerplate evidence in 4 contexts | `validateFlowReviewSubmissionV1` | `REPEATED_EVIDENCE` |
| CONCERN without a candidate | `validateFlowReviewSubmissionV1` | `CONCERN_WITHOUT_CANDIDATE` |
| Attack unit with one flow never attacked | `validateAttackSubmissionV1` | `FLOW_NOT_ATTACKED` |
| VIABLE path without a simulation idea | `validateAttackSubmissionV1` | `SIMULATION_IDEA_REQUIRED` |
| X unit packet | `buildUnitPacketV1` | No hypotheses path, no reviewer-2 submission paths |
| VIABLE attack inside a context reviewer-2 marked SUPPORTED | `buildDiscoverySummaryV1` | `ATTACK_CONTRADICTS_REVIEW` item |
| Stale unit request | `advanceDiscoveryV1` | `DISCOVERY_STALE_REQUEST`; no state change |
| Same submission bytes resubmitted | `advanceDiscoveryV1` | Attempts unchanged |
| Zero candidates; authorization and fee surfaces | `deriveBaselineObligationsV1` | `ACCESS_CONTROL` and `ACCOUNTING_MATH` obligations |
| Reviewer-2 claims NOT_APPLICABLE | `deriveBaselineObligationsV1` | Obligation kept |
| Gap context | `deriveBaselineObligationsV1` | Obligation kept, `HIGH` |
| PASSED with an unparseable ledger | `validatePhase6AttackerWorkV1` | Deficiency |
| PASSED with `toolInvoked:null` | `validatePhase6AttackerWorkV1` | Deficiency |
| DISPROVEN resting only on Phase 5 NOT_REPRODUCED | `validatePhase6AttackerWorkV1` | Deficiency |
| CONFIRMED with a failing control assertion | `validatePhase6AttackerWorkV1` | Deficiency |
| NOT_ACHIEVED/ROUNDS_EXHAUSTED with 2 rounds | `validatePhase6AttackerWorkV1` | Deficiency |
| PROPERTY_FAILED or P6-NEW absent from Phase 8 | `validatePhase8LinkageV1` | Deficiency |
| `verdictRationale` without the coverage label | `validatePhase10CoverageLabelV1` | Deficiency |
| v11-bound campaign at Phase 3 PASS | Controller | Same-reviewer Phase 4; no discovery files |
| Phase 0 inventory build throws | Phase 0 block | Inventory written with `complete:false`; Phase 0 not failed |
| Frozen v11 file tampered | `resolveFrozenAuthorityFileV1` | Throws |
| Critical defect found but rated Medium | `scoreQualificationV1` | Counted in `criticalHighMisses` |

### T10.4 Close-out

1. Confirm the 00 §9 done condition item by item in the T10 PR description, with links.
2. Delete `process/adr-verify/AUTHORITY_ROOT_v1.txt` and its use at the marker, since staging validation is no longer needed after the swap. Keep `AUDIT_CONTROLLER_REF_v1.txt` set to `main`.
3. Stop. Do not open follow-up tasks.

---

## Appendix A — Phase 4 (v12) files

**A1. `phases/phase-4/PHASE_04_SCHEMA_v1.json`.** Keep every key from v11 except the following:

1. Set `"title": "Lite Combined Phases 2-5 - Flow Review, Attack Reconciliation and Specialist Review"`.
2. Replace `actions.step-1` with:

```json
"step-1": {
  "title": "Reconcile flow review and attacker results",
  "formPath": "work/phase-04/PHASE_04_WORK_FORM_v1.json",
  "section": "Step 1 Input — Reconcile flow review and attacker results",
  "fields": [
    {
      "name": "discoveryReconciliationRecords",
      "type": "REQUIRED_RECORD_LIST",
      "consumers": ["phase-5", "phase-6", "phase-8"],
      "itemRequiredFields": ["recordKey", "contextIds", "sourceAnchor", "origin", "reviewerFinding", "attackerFinding", "reconciliation", "disposition", "candidateTempKeyOrNone", "rationale"],
      "itemFieldAllowedValues": {
        "origin": ["REVIEWER_CANDIDATE", "REVIEWER_UNRESOLVED", "ATTACK_FINDING", "ATTACK_CONTRADICTS_REVIEW", "INTEGRATION_CONCERN", "COVERAGE_GAP"],
        "disposition": ["CANDIDATE_CREATED", "RESOLVED_NO_ISSUE", "COVERAGE_GAP_ACCEPTED"]
      },
      "controllerPrefillFields": ["recordKey", "contextIds", "sourceAnchor", "origin", "reviewerFinding", "attackerFinding"]
    }
  ],
  "controllerPrefillFields": ["recordKey", "contextIds", "sourceAnchor", "origin", "reviewerFinding", "attackerFinding"]
}
```

3. In `derivedOutputs[0].selectors` and in `bookkeepingMappings.graphRecordPaths`, replace `actions.step-1.outputs.sourceReviewRecords` with `actions.step-1.outputs.discoveryReconciliationRecords`.
4. In `controllerAutomationInputs`, replace `expectedSourceReviewKeys` with `{"name": "expectedDiscoveryRecordKeys", "type": "CONTROLLER_PREFILLED_READ_ONLY_LIST", "consumers": ["phase-4-controller-validation"], "source": "controller discovery summary"}`.

**A2. `phases/phase-4/PHASE_CONTRACT.json`.**

1. Set `phase.title` to the A1 title.
2. Replace step 1 with:

```json
{"step": 1, "action": "Reconcile flow review and attacker results", "instruction": "Disposition every controller-prefilled reconciliation record: create a candidate, resolve it with source-anchored reasoning (for attacker findings, name the blocking control), or accept a coverage gap only for COVERAGE_GAP records. Do not redo accepted flow-review rows.", "condition": null, "outputDestination": {"document": "work/phase-04/PHASE_04_WORK_FORM_v1.json", "section": "Step 1 Input — Reconcile flow review and attacker results", "schema": "phases/phase-4/PHASE_04_SCHEMA_v1.json#actions.step-1", "requiredFields": ["discoveryReconciliationRecords"]}, "resources": ["./PHASE_04_SCHEMA_v1.json", "./resources/PHASE_04_WORK_FORM_TEMPLATE_v1.json", "../../discovery/RECONCILIATION_GUIDE.md"]}
```

3. In `inputs.required`, replace the source-review-rows item with "Controller-generated discovery summary (reviewer-2 flow review, attacker reviewer results, integration answers and gaps)".

**A3. `phases/phase-4/resources/PHASE_04_WORK_FORM_TEMPLATE_v1.json`.** Replace `actions.step-1` with one `discoveryReconciliationRecords` item that contains all ten A1 item fields, each set to `"<REQUIRED>"`, under the section `"Step 1 Input — Reconcile flow review and attacker results"`.

**A4. `phases/phase-4/START_HERE.md`.**

1. Insert this as a new section before Step 1:

> ## Before Step 1 — flow review units
> When Phase 3 passes, the controller sends you flow-review units one at a time in this chat. A unit is one or more end-to-end flows: an entry point traced through every contract it touches. Follow [`discovery/FLOW_REVIEW_START_HERE.md`](../../discovery/FLOW_REVIEW_START_HERE.md) for each unit. You may read and cite any source file. After your units, the attacker reviewer attacks the same system independently. You are then woken for Step 1.

2. Replace the "Step 1" section with:

> ## Step 1 — Reconcile flow review and attacker results
> Read `work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json`. The controller has prefilled one record for each of these: every candidate and unresolved check from your flow review; every attack the attacker reviewer found viable or uncertain; every attack that contradicts one of your SUPPORTED checks; every integration concern; and every coverage gap. For each record, read the cited source and decide. `CANDIDATE_CREATED` requires a matching Step 3 candidate. `RESOLVED_NO_ISSUE` requires source anchors (`path.sol:L<n>`), and for attacker records it must name the exact control that blocks the attack. `COVERAGE_GAP_ACCEPTED` is allowed only for `COVERAGE_GAP` records. Gaps stay visible in the final report. The master reviews your reconciliation and the attacker's findings.

3. Delete `phases/phase-4/resources/PHASE4_MANUAL_COVERAGE_CANDIDATE_REGISTRY.md`.

## Appendix B — Phase 6 (v12) files

**B1. `phases/phase-6/PHASE_06_SCHEMA_v1.json`.**

1. Set `"executor": "reviewer-3L"` (unchanged) and `"title": "Merged Lite Phases 6-7 - Attacker Testing and Execution Interpretation"`.
2. Add `actions.step-4`:

```json
"step-4": {
  "title": "Agent-guided baseline testing",
  "formPath": "work/phase-06/PHASE_06_WORK_FORM_v1.json",
  "section": "Step 4 Input — Agent-guided baseline testing",
  "fields": [
    {"name": "baselineTestRecords", "type": "REQUIRED_RECORD_LIST", "consumers": ["phase-8", "phase-10"],
     "itemRequiredFields": ["testGroupId", "contract", "obligationIds", "obligationsDetail", "requestDirectory", "harnessDesign", "dispatchRounds", "requestPaths", "obligationOutcomes", "limitations"],
     "controllerPrefillFields": ["testGroupId", "contract", "obligationIds", "obligationsDetail", "requestDirectory"]}
  ],
  "controllerPrefillFields": ["testGroupId", "contract", "obligationIds", "obligationsDetail", "requestDirectory"]
}
```

3. Add `actions.step-5`:

```json
"step-5": {
  "title": "Prove or disprove candidates and record new findings",
  "formPath": "work/phase-06/PHASE_06_WORK_FORM_v1.json",
  "section": "Step 5 Input — Prove or disprove candidates and record new findings",
  "fields": [
    {"name": "candidateProofRecords", "type": "REQUIRED_RECORD_LIST", "consumers": ["phase-8", "phase-10"],
     "itemRequiredFields": ["candidateKey", "sourceAnchor", "phase5Result", "requestDirectory", "verdict", "harnessDesign", "dispatchRounds", "requestPaths", "ledgerRef", "attackAssertionNames", "controlAssertionNames", "reasoning"],
     "itemFieldAllowedValues": {"verdict": ["CONFIRMED", "DISPROVEN", "INCONCLUSIVE", "PHASE5_DECISIVE"]},
     "controllerPrefillFields": ["candidateKey", "sourceAnchor", "phase5Result", "requestDirectory"]},
    {"name": "newCandidateRecords", "type": "REQUIRED_RECORD_LIST", "consumers": ["phase-8"],
     "itemRequiredFields": ["tempKey", "title", "classId", "description", "anchors", "ledgerRef"]}
  ],
  "controllerPrefillFields": ["candidateKey", "sourceAnchor", "phase5Result", "requestDirectory"]
}
```

4. Do **not** change `derivedOutputs`: its only selector is already `"actions"`, which includes the new steps. Add `"actions.step-4.outputs.baselineTestRecords"`, `"actions.step-5.outputs.candidateProofRecords"` and `"actions.step-5.outputs.newCandidateRecords"` to `bookkeepingMappings.graphRecordPaths` only.

**B2. `phases/phase-6/PHASE_CONTRACT.json`.** Add steps 4 and 5, matching B1. Each needs `action`, `instruction`, an `outputDestination` (section, schema pointer `#actions.step-4` or `#actions.step-5`, and requiredFields equal to the B1 field names), and resources `["./PHASE_06_SCHEMA_v1.json", "./resources/PHASE_06_WORK_FORM_TEMPLATE_v1.json", "../../shared/execution/AGENT_GUIDED_TESTING.md", "../../shared/execution/TECHNICAL_EXECUTION_REQUEST_PLAYBOOK.md"]`.

- Step 4 instruction: "For every prefilled test group, design and author harnesses for its obligations, dispatch them through the Phase-6 V7 lane (at most 3 rounds), triage every result from its assertion ledger, and record one outcome per obligation."
- Step 5 instruction: "For every material candidate whose Phase-5 result is not REPRODUCED, run an attack test with a healthy-path control (at most 3 rounds) and record CONFIRMED, DISPROVEN or INCONCLUSIVE; record any new vulnerability found while testing."

**B3. `phases/phase-6/resources/PHASE_06_WORK_FORM_TEMPLATE_v1.json`.** Add `actions.step-4` and `actions.step-5`, with one item per field and every field set to `"<REQUIRED>"`, using the B1 section names.

**B4. `phases/phase-6/START_HERE.md`.**

1. Change the title to "Phase 6 — Attacker Testing and Execution Interpretation".
2. Replace the paragraph starting "Phase 6 performs semantic security interpretation only." with:

   "You are the attacker reviewer. You already attacked this system in Phase 4. In Phase 6 you interpret the Phase 0 deploy/config evidence and the Phase 5 candidate runs (Steps 1–3), run the baseline property tests (Step 4), and prove or disprove candidates and record new findings (Step 5). You design every test; automation only executes and records it."
3. In Step 2, delete the sentences about `PHASE0-BASELINE-*` rows and raw transcripts.
4. Add after Step 3:

> ## Step 4 — Agent-guided baseline testing
> Follow [`shared/execution/AGENT_GUIDED_TESTING.md`](../../shared/execution/AGENT_GUIDED_TESTING.md). Work through the prefilled test groups in priority order. For each group:
> - Write a short `harnessDesign`: actors and roles, setup starting from the Phase 0 deployed state, properties and assertion names per obligation, and fuzz bounds.
> - Author the harness using the `v7:harness:init` / `v7:harness:validate` conventions.
> - Commit the V7 request JSON under the group's `requestDirectory`.
> - Push the dispatch request `process/agent-upload/lite-v7-execution/<campaignId>-<folder>-r<round>.json` with `phaseSequence: 6`.
> - After ingestion, read `controller/automation/<request>/ASSERTION_LEDGER_v1.json` and triage every failure.
>
> You have at most 3 rounds per group. Record one outcome per obligation: `PASSED`, `PROPERTY_FAILED`, `NOT_APPLICABLE_CONFIRMED` (with anchors), `INCONCLUSIVE`, or `NOT_ACHIEVED` (with reason `ROUNDS_EXHAUSTED`, `NO_EXECUTABLE_SETUP` or `TOOL_UNSUPPORTED`). Never record `PASSED` without a parsed ledger showing your named assertions passing. Every `PROPERTY_FAILED` becomes Phase 8 candidate `P6-PROP-<testGroupId>-<obligationId>`.
>
> ## Step 5 — Prove or disprove candidates; record new findings
> For every prefilled candidate:
> - If `phase5Result` is `REPRODUCED`, record `PHASE5_DECISIVE`.
> - Otherwise, write an attack test plus a healthy-path control under the candidate's `requestDirectory` (at most 3 rounds), then record one of these verdicts:
>   - `CONFIRMED`: an attack assertion fails because the property is violated, and the controls pass.
>   - `DISPROVEN`: the attack assertions pass because the attack is blocked, the controls pass, and you name the blocking control with an anchor.
>   - `INCONCLUSIVE`: state the missing proof.
>
> A Phase 5 `NOT_REPRODUCED` alone is never a disproof. Add any vulnerability you discover while testing to `newCandidateRecords` as `P6-NEW-<n>`.

## Appendix C — New skill files

Create these files in the v12 package with exactly this content.

**C1. `discovery/FLOW_REVIEW_START_HERE.md`** (reviewer-2)

> # Flow Review Units
> Each unit lists one or more flows. A flow is an entry point traced through every contract it touches. The unit also lists the primary contexts you must record, with their required defect classes and review checks. Read every context of every flow, across all contracts, before writing anything. You may read and cite any source file. For each flow, write a `flowNotes` entry describing how value and authority move through it, with anchors. For each primary context, write a `summary` and one check per required class: `applicability`, `assessment` (`SUPPORTED`, `CONCERN`, `UNRESOLVED` or `NOT_APPLICABLE`), source-specific `evidence`, and `anchors` (`path.sol:L<a>-L<b>`, any in-scope file). Every `CONCERN` needs a candidate. Residual units list contexts no flow reaches; review them the same way, with no flow notes. Write `SUBMISSION_v1.json` at the packet's `submissionPath`, then push the boundary request from your wake message. On failed validation, fix only the listed items and push again with `attempt` increased. You have 3 attempts per unit. Copy-pasted evidence across contexts is rejected. Use the GitHub connector app for all repository access.

**C2. `discovery/ATTACKER_START_HERE.md`** (attacker reviewer, `reviewer-3L` chat)

> # Attacker Reviewer — Attack Units
> You are the dedicated attacker. Each unit is one connected group of contracts, with all its flows, system facts (cross-contract calls, value flows, guard table rows without guards, sibling guard differences) and integration questions. Your goal is to take, freeze, misdirect or inflate the protected assets listed in the packet inputs, or to take control. Attack as:
> - an unprivileged caller;
> - a holder of a different role;
> - a malicious token, adapter or callback;
> - an MEV searcher;
> - a careless admin.
>
> Every flow must appear in at least one attack path. Record blocked attempts too, naming the exact control that stops them, with an anchor. A `VIABLE` or `UNCERTAIN` path needs a candidate and a `simulationIdea` (transaction sequence and oracle). You will turn it into a real test in Phase 6. Answer every integration question with an assessment, reasoning and anchors. You may read any source file. Do not open `work/phase-03/`, `work/phase-04/` work forms or other units' folders: your independence from reviewer-2 is part of the audit evidence. Submit and resubmit exactly as described in your wake message. You have 3 attempts per unit.

**C3. `discovery/RECONCILIATION_GUIDE.md`.** One paragraph repeating the A4 Step 1 rules.

**C4. `shared/execution/AGENT_GUIDED_TESTING.md`**

> # Agent-Guided Testing (Attacker Reviewer)
> Automation never designs tests. You design every harness from the obligations, the candidates and the Phase 0 deployed state. Automation only stages it, executes it, records the assertion ledger, and wakes you.
>
> Write one harness bundle per test group or candidate. Name every assertion so it can be matched in the ledger. For each obligation type:
> - Permission-matrix obligations: test every actor and role against every state-changing entry point, including callers that hold a different role.
> - Reentrancy obligations: use a malicious token or adapter.
> - Token obligations: cover fee-on-transfer, rebasing, no-return and reverting tokens.
> - Invariant obligations: state the conservation or bound being checked.
> - Candidate tests: always pair the attack with a healthy-path control.
>
> Naming, so results can be matched in the ledger: one assertion per test function or property; baseline tests `test_prop_<obligationId>_<short>`, candidate tests `test_attack_<n>_<short>` and `test_control_<n>_<short>`, Medusa properties `property_<obligationId>_<short>`. Cite Forge tests as `<suite>::<test name>` exactly as the ledger shows them.
>
> Use Medusa only through a `MEDUSA_PROPERTY` request you designed. Triage every failing assertion: a real violation is recorded as a failure or confirmation; a harness defect is fixed in the next round. Stop after 3 rounds per folder and record the honest outcome.

## Appendix D — Edits to existing skill files (in the v12 copy)

1. **`SKILL.md`.**
   - Set `Release identity: \`Audit_Litemode_v12\`` and `Package revision: \`v12\``. Keep the exact line format.
   - In the actor table:
     - rename the `reviewer-3L` row's role to "attacker reviewer";
     - set its scope to "independent Phase 4 attack units; Phase 6 attacker testing (baseline properties, candidate proof/disproof, new findings); master-directed targeted tests".
   - In the phase map, set the row for Phases 2–5 to add "Phase 4 starts with reviewer-2 flow-review units, then independent attacker units; reviewer-2 reconciles; the master challenges at segment review."
   - Add a section "## Coverage model" stating:
     - coverage = contexts × applicable taxonomy classes (`curveyield3/Contract-Automation/protocol/taxonomy/curveyield-defect-taxonomy-v1.json`) × detection method;
     - reviewers may read and cite any source file;
     - gaps are recorded, never relabelled;
     - the final verdict states `FULL_COVERAGE` or `PARTIAL_COVERAGE`.
   - Add the universal rule `[U-COVERAGE-001] Coverage is measured and gaps are disclosed`.
2. **`shared/policy/UNIVERSAL_RULE_REGISTRY.json`.** Add `{"id": "U-COVERAGE-001", "title": "Coverage is measured and gaps are disclosed", "homepageSection": "Coverage model", "scope": "ALL_PHASES"}`.
3. **`shared/controller/LITE_PHASE_SCHEMA_POLICY.md`.** Append to hard rule 3: "Discovery unit submissions under `work/phase-04/discovery/` are controller-validated assignment files defined by `discovery/*_START_HERE.md`; they are not phase schemas."
4. **`shared/controller/LITE_PHASE_RECEIPT_PROTOCOL.md`.** Append to "Prohibited bookkeeping sidecars": "Discovery state, unit packets, submissions and the discovery summary are controller-owned assignment records, not bookkeeping sidecars."
5. **`shared/controller/AI_Auditor_Controller.md`, `profiles/AUDIT_INDEPENDENT_REVIEW.md` and `docs/USER_GUIDE.md`.** Make the same `reviewer-3L` rename and scope change as item 1. Add "The master acts as challenger for the reviewer-2 segment and receives the discovery summary."
6. **`LITE_ORCHESTRATOR_MODE.md`.** Replace the section "Conditional final adversarial review" with: "## Mandatory attacker reviewer\nThe attacker reviewer (`reviewer-3L`) performs an independent attack pass in Phase 4 and owns Phase 6 testing. This replaces the former conditional final adversarial review." Apply the same rename in its topology table.
7. **`shared/lenses/SOLO_LENS_ISOLATION_PROTOCOL.md`.** Replace the body with: "Superseded in v12. Independence comes from the attacker reviewer: a separate chat that never sees reviewer-2's Phase 3–4 conclusions before its attack units are sealed. Same-model use is disclosed as a limitation."
8. **`shared/policy/ASSURANCE_PRECISION_CONTROLS.md`.** Replace "Security-surface reconciliation" with: "Phase 0 records every reviewable declaration and every end-to-end flow. Phase 4 flow review must accept every context or record it as a gap, and the attacker must attack every flow. Gaps are disclosed per contract and class and make the coverage label PARTIAL_COVERAGE."
9. **`shared/execution/CONTRACT_AUTOMATION_CAPABILITY_MAP.md`.**
   - Mark "Phase-0 broad Medusa randomized baseline" and "Phase-0 ABI accounting telemetry" as `RETIRED (2026-10-11)`.
   - Add the row "Attacker-guided Phase 6 testing | DIRECT | attacker reviewer designs; V7 lane executes; assertion ledger recorded | design record, request, ledger".
10. **`phases/phase-0/START_HERE.md` and `phases/phase-0/PHASE_CONTRACT.json`.**
    - Remove the Medusa, telemetry and simulation-baseline items.
    - Describe step 4 as "fork deploy/config using the package's own scripts, then a read-only deployed-state snapshot".
    - Add the review-inventory artifacts and `FLOW_PLAN_v1.json` (00 §7.5).
    - Remove "exceeds 100,000 observed calls".
    - Keep exactly nine contract steps.
11. **`phases/phase-5/PHASE_05_SCHEMA_v1.json` and `phases/phase-5/START_HERE.md`.**
    - Remove the `phase0BaselineSimulation` input and its paragraph.
    - Remove the literal `\n` artifacts in the Step 3 heading.
    - Add to Step 3: "Attack paths marked VIABLE or UNCERTAIN in the discovery summary should receive target designs here; the attacker reviewer follows up in Phase 6."
12. **`phases/phase-8/START_HERE.md`.** Add to Step 2: "Validate every Phase 6 `P6-PROP-*` and `P6-NEW-*` key and every Step 5 `CONFIRMED` or `INCONCLUSIVE` candidate like any other candidate."
13. **`phases/phase-10/START_HERE.md`.** Add to Step 3: "State the coverage label from `work/phase-10/COVERAGE_MATRIX_v1.json` and the detection-qualification status exactly as printed in the final evidence index."
14. **`master-review/START_HERE.md`.** Add a section "## Challenger duties (reviewer-2 segment)":

    "Review every item in the discovery summary: attacker findings and contradictions, unresolved checks, not-applicable claims and coverage gaps. Amend reviewer-2's reconciliation where it is wrong, order targeted tests (to the attacker reviewer, `reviewer-3L`) where proof is missing, and accept a gap only with a stated reason."
15. **`master-review/TARGETED_TEST_DIRECTIVE_v1.md`.** Change the sentence about `reviewer-3L` to: "`reviewer-3L` is the attacker reviewer and is the default executor of targeted tests, except for its own segment, where a different reviewer is required."
16. **`PACKAGE_PROVENANCE.md`.** Append a section "## v12 detection rebuild" listing:
    - complete Phase 0 review inventory and flow plan;
    - reviewer-2 flow review with system-wide citations;
    - the mandatory attacker reviewer (Phase 4 attack pass and Phase 6 testing), replacing the conditional final adversarial review that was removed during the Lite optimization;
    - the master as challenger;
    - candidate-independent baseline obligations;
    - the coverage matrix and label;
    - retirement of Phase 0 Medusa and telemetry.

## Appendix E — Self-check before opening the T8 AC PR

- `grep -r "Audit_Litemode_v11" audit-process/v7/staging-authority/Audit_Litemode_v12` returns only `PACKAGE_PROVENANCE.md` history lines.
- Every phase `PHASE_CONTRACT.json` step count equals its schema `actions` count.
- Every new `*.md` link resolves inside the package.
- `MANIFEST.json` has `detectionPolicy`.
