# Audit Detection Rebuild v2 — T0–T3: Verification Lane, Taxonomy, Phase 0 Inventory and Flow Plan

> **For the implementing agent:** `00_BUILD_CONTRACT_v2.md` applies in full. Do tasks in order. One task = one branch = one PR (T0 also has one small Audit-Controller PR). Every new test file name starts with `adr-` so the T0 workflow runs it automatically.

Supersedes `01_BASELINE_AND_INVENTORY_v1.md` (removed; Git history keeps it). The v1 benchmark-attribution task is deleted: no past campaign is used (D9).

---

## T0 — Verification workflow and retirement of the abandoned campaign

**Goal:** one GitHub Actions workflow runs every test this program adds, plus the existing controller regression tests, on every relevant PR. Also stop the abandoned v17 campaign so it consumes no further runs.

**Read first:** root `AGENTS.md`, `.github/AGENTS.md`, `.github/workflows/lite-phase5-reuse-regression-v1.yml` (style reference), `.github/workflows/lite-phase-work-packet-controller-v1.yml` (search `npm ci --force --ignore-scripts`).

### T0.1 Create `.github/workflows/audit-detection-rebuild-verify-v1.yml`

Use exactly this content:

```yaml
name: Audit Detection Rebuild Verify v1

on:
  pull_request:
    branches: [main]
    paths:
      - 'scripts/**'
      - 'packages/github-native-sim/**'
      - 'protocol/**'
      - 'process/adr-verify/**'
      - '.github/workflows/audit-detection-rebuild-verify-v1.yml'
      - '.github/workflows/lite-phase-work-packet-controller-v1.yml'
      - '.github/workflows/lite-v7-execution-dispatch-v1.yml'
      - '.github/workflows/audit-source-initialization-v1.yml'
      - '.github/workflows/audit-controller-execution.yml'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: adr-verify-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  unit-and-regression:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
          fetch-depth: 1
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install locked dependencies without scripts
        run: timeout -k 10s 360s npm ci --force --ignore-scripts --no-audit --no-fund
      - name: Program tests (adr-*)
        shell: bash
        run: |
          set -euo pipefail
          shopt -s nullglob
          files=(scripts/tests/adr-*.test.mjs packages/github-native-sim/test/adr-*.test.mjs)
          if [ "${#files[@]}" -eq 0 ]; then echo "No adr tests yet"; exit 0; fi
          timeout -k 10s 900s node --test "${files[@]}"
      - name: Existing controller regression tests
        shell: bash
        run: |
          set -euo pipefail
          timeout -k 10s 900s node --test \
            packages/github-native-sim/test/lite-phase-packet-controller-integration-v1.test.mjs \
            packages/github-native-sim/test/lite-assignment-successor-v1.test.mjs \
            packages/github-native-sim/test/lite-phase5-execution-gate-v1.test.mjs \
            packages/github-native-sim/test/lite-phase-schema-policy-v1.test.mjs \
            packages/github-native-sim/test/source-intelligence-technical-v1.test.mjs \
            scripts/tests/lite-master-targeted-tests-v1.test.mjs
```

Append a second job to the same file:

```yaml
  audit-controller-checks:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
          fetch-depth: 1
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Select Audit-Controller credential
        env:
          AUDIT_CONTROLLER_PRIMARY_TOKEN: ${{ secrets.AUDIT_CONTROLLER_GITHUB_TOKEN }}
          PREFLIGHTSIM_FALLBACK_TOKEN: ${{ secrets.PREFLIGHTSIM_GITHUB_TOKEN }}
          AUDIT_CONTROLLER_TOKEN_REQUIRED: 'true'
        run: bash scripts/select-audit-controller-token.sh
      - name: Audit-Controller checks (no new failures versus main)
        env:
          GH_TOKEN: ${{ env.AUDIT_CONTROLLER_GITHUB_TOKEN }}
        run: bash scripts/adr-audit-controller-checks-v1.sh
```

Also create these two files:

1. `process/adr-verify/AUDIT_CONTROLLER_REF_v1.txt` containing the single line `main`. Later tasks change this line to an Audit-Controller branch name inside their CA PR, so the job tests that branch, and set it back to `main` before merging.
2. `scripts/adr-audit-controller-checks-v1.sh` (bash, `set -euo pipefail`). It:
   1. Reads the ref from `process/adr-verify/AUDIT_CONTROLLER_REF_v1.txt` with whitespace stripped. The ref must match `^[A-Za-z0-9._/-]+$`.
   2. Runs `gh auth setup-git`, then clones `curveyield3/Audit-Controller` twice with `gh repo clone curveyield3/Audit-Controller <dir> -- --filter=blob:none --no-checkout` into `.ac-main` and `.ac-target`. In each clone it:
      1. runs `git sparse-checkout init --no-cone`;
      2. writes the three lines `/*`, `!/campaigns/` and `!/Phase0 Build Cache/` to `.git/info/sparse-checkout`;
      3. runs `git fetch origin "<ref>"` and then `git checkout --detach FETCH_HEAD`, where `<ref>` is `main` for `.ac-main` and the target ref for `.ac-target`.
   3. In each checkout it runs `node --test --test-reporter=tap packages/*/test/*.test.mjs test/*.test.mjs > tap.txt || true` and `node scripts/check.mjs > check.txt 2>&1; echo $? > check.code`.
   4. Extracts the failing test names (lines starting with `not ok`, with the number removed) into sorted files and prints both lists.
   5. Exits 1 if the target has a failing test name that main does not have, or if the target's `check.code` is non-zero while main's is zero. Otherwise exits 0, so pre-existing failures never block this program.
   6. Later tasks append steps to this script at the marker line `# ADR-EXTRA-CHECKS` (T8, T9). Put that marker as a comment just before the final exit.

Rules:
- Do not add `push` triggers.
- Do not let this workflow write to the repository.
- Do not create another workflow.

### T0.2 Retire `curveyield-dex-v17-source-r1` (owner decision 2026-10-12: abandoned, not to be repaired or reused)

1. **Audit-Controller PR**, branch `upgrade/adr-T0-retire-v17`. Edit `Audit Campaign Directory/campaigns/curveyield-dex-v17-source.json`:
   - set `"campaignStatus": "STOPPED_BY_HUMAN"` (a value already allowed by the directory schema);
   - set `"updatedAt"` to the current UTC time.
   - Do not add keys, change any other key or delete files.
   - Put the reason in the PR description: "Owner retired this campaign on 2026-10-12; it must not be repaired, resumed or used as a benchmark."
2. **In the T0 Contract-Automation PR**, edit `process/browser-agent-wake/registrations/curveyield-dex-v17-source-r1.json`:
   - set `watchdog.enabled` to `false`;
   - add `"retiredAt": "2026-10-12"`.
   - Do not change any other key.

### T0.3 Tests

There are no new tests in T0. The workflow must run green on the T0 PR: the program-tests step prints `No adr tests yet` and the regression step passes.

**Done when:**
- The workflow file is merged and its run on the T0 PR is green.
- The AC PR is merged.
- The registration change is merged.

**Do not:**
- Touch any other campaign.
- Add schedules.
- Add `continue-on-error`.

### T0.4 Archive the discontinued no-telemetry Phase 0 fork (run after T7 is merged and before T8)

Owner decision, 2026-10-12: the no-telemetry Phase 0 fork is discontinued and self-contained. Nothing in the live campaign flow uses it; initialization starts only `lite-phase0-bootstrap-v1.yml`. Never edit the fork, only archive it.

This task is one Contract-Automation PR, `upgrade/adr-T0-archive-no-telemetry`. It is explicitly authorized to touch the workflows named here (exception to N7).

1. **Archive.** Copy each file below byte-for-byte to `curveyield3/archive` at `Contract-Automation/<original path>`. Use one archive PR or commit. Then delete each one from Contract-Automation.
   - `.github/workflows/lite-phase0-bootstrap-no-telemetry-v1.yml`
   - `.github/workflows/lite-phase0-bootstrap-recovery-dispatch-no-telemetry-v1.yml`
   - `.github/workflows/lite-phase0-intelligence-no-telemetry-v1.yml`
   - `.github/workflows/lite-phase0-randomized-simulation-no-telemetry-v1.yml`
   - `.github/workflows/v7-execution-infrastructure-qualification-no-telemetry-v1.yml`
   - `.github/workflows/lite-phase0-evidence-gate-resume-v1.yml`: this is the fork's recovery path and calls the fork's finalizer.
   - `packages/github-native-sim/src/lite-phase0-intelligence-no-telemetry-v1.mjs`
   - `packages/github-native-sim/src/phase0-randomized-simulation-no-telemetry-v1.mjs`
   - `packages/github-native-sim/test/phase0-no-telemetry-active-watchdog-v1.test.mjs`
   - `scripts/lite-phase0-finalize-no-telemetry-v1.mjs`
   - `scripts/phase0-no-telemetry-watchdog-v1.mjs`
   - `scripts/run-phase0-randomized-simulation-no-telemetry-v1.mjs`
   - `scripts/write-phase0-simulation-outputs-no-telemetry-v1.mjs`
   - the four files in `process/agent-upload/lite-phase0-bootstrap-no-telemetry/`
2. **Keep** `.github/actions/setup-no-telemetry-node-cache/` and `.github/actions/setup-no-telemetry-v7-toolchain/` for now. They are listed in `process/RUNNER_MANIFEST.json` and `packages/github-native-sim/src/v7-policy.mjs`. Removing them would break the V7 manifest check (`npm run v7:manifest -- --check`) that `audit-controller-execution.yml` runs. Do not rename or edit them in this task.
3. **Fix the remaining references in the same PR:**
   - `.github/workflows/phase0-deploy-only-regression-v1.yml`: delete the line `node --check scripts/lite-phase0-finalize-no-telemetry-v1.mjs` and the line naming `phase0-no-telemetry-active-watchdog-v1.test.mjs`.
   - `.github/workflows/lite-master-targeted-tests-regression-v1.yml`: delete the two path-filter lines naming `lite-phase0-randomized-simulation-no-telemetry-v1.yml`.
   - `scripts/phase0-compile-watchdog-v1.mjs`: remove the `no-telemetry` mode. Accept only `primary`, always use the primary module path, and keep only the `phase0-intelligence-primary` log pattern.
   - Tests that mention archived files: `phase0-optimization4-v1`, `phase0-compiler-watchdog-30m-v1`, `phase0-private-build-cache-v1`, `v7-unified-test-qualification-v1`, `lite-phase0-automation-v2`, `phase0-stage2-balancer-stall-repair-v1` and `phase0-v2-consumers` (all `.test.mjs` under `packages/github-native-sim/test/`).
     - Delete only the cases or assertions that reference an archived file.
     - If a test file only covers archived files, archive it too.
     - Add each remaining file to the "Existing controller regression tests" list in `audit-detection-rebuild-verify-v1.yml`, so the PR proves they still pass.
4. **Done when:**
   - `git grep -n no-telemetry` on the branch matches only the two kept action folders, the files that reference them (`RUNNER_MANIFEST.json`, `v7-policy.mjs` and their tests) and `docs/`;
   - the T0 workflow is green;
   - the archive copy is merged.

---

## T1 — Defect taxonomy and coverage-matrix library

**Goal:**
- One versioned taxonomy of defect classes, each with its machine triggers, required review checks and test method.
- A library that builds the per-campaign coverage matrix.

**Read first:**
- `protocol/AGENTS.md`
- `packages/AGENTS.md`
- `packages/github-native-sim/src/canonical-json-v1.mjs`

### T1.1 Create `protocol/taxonomy/curveyield-defect-taxonomy-v1.json`

Top-level shape:

```json
{
  "schemaVersion": "curveyield-defect-taxonomy-v1",
  "triggerKeys": ["<every trigger key used below, sorted>"],
  "classes": [
    {
      "classId": "ACCESS_CONTROL",
      "title": "Access control and privilege",
      "triggers": ["STATE_WRITE_EXTERNAL", "PRIVILEGED_GUARD", "TX_ORIGIN", "PAYABLE"],
      "reviewChecks": ["..."],
      "testMethod": "FOUNDRY_PERMISSION_MATRIX",
      "testRequired": true
    }
  ]
}
```

Include exactly these 18 classes, in this order, with these triggers and test methods. Copy each `reviewChecks` list exactly as written.

| classId | triggers | testMethod | testRequired | reviewChecks |
|---|---|---|---|---|
| ACCESS_CONTROL | STATE_WRITE_EXTERNAL, PRIVILEGED_GUARD, TX_ORIGIN, PAYABLE | FOUNDRY_PERMISSION_MATRIX | true | "Cite the exact guard expression or guard call that protects the effect"; "List every actor or role that can reach the effect, including roles other than the intended one"; "Check every entry path including inherited, fallback and receive"; "Flag any use of tx.origin for authorization" |
| ROLE_LIFECYCLE | OWNERSHIP_OR_ROLE_WRITE, PENDING_STATE, INITIALIZER | FOUNDRY_PROPERTY | true | "Check transfer, accept, renounce and revoke paths and who may call each"; "Check pending or temporary state is cleared after use"; "Check initializers run exactly once" |
| ACCOUNTING_MATH | ARITHMETIC_ON_STATE, DIVISION, BPS_OR_SCALE_CONSTANT, PAYABLE | FOUNDRY_INVARIANT | true | "State the unit of every term and every scale constant"; "State the rounding direction and who benefits"; "Compare every cap and bound, including inclusive versus exclusive, with the documented or required value"; "State the conservation relation (parts never exceed the whole)" |
| STATE_MACHINE | STATUS_FLAG_WRITE, MAPPING_STRUCT_WRITE | FOUNDRY_PROPERTY | true | "List valid transitions and check invalid ones revert"; "Check an executed, claimed or cancelled item cannot be used again"; "Check ordering assumptions between steps" |
| REENTRANCY_CALLBACK | EXTERNAL_CALL_BEFORE_STATE_WRITE, ARBITRARY_TARGET_CALL, TOKEN_TRANSFER | FOUNDRY_PROPERTY | true | "Check state is final before external calls or a reentrancy guard covers the path"; "Check cross-function, cross-contract and read-only reentrancy"; "Check callbacks and hooks into user-supplied contracts" |
| EXTERNAL_CALL_TRUST | EXTERNAL_CALL, LOW_LEVEL_CALL, RETURN_VALUE_USED | FOUNDRY_PROPERTY | true | "Check the call target is validated"; "Check code existence for low-level calls"; "Check returned values against actual balance changes"; "Check what local state results when the call fails" |
| TOKEN_INTEGRATION | TOKEN_TRANSFER, TOKEN_BALANCE_READ | FOUNDRY_PROPERTY | true | "Check behaviour with fee-on-transfer, rebasing, no-return-value, reverting and hook-calling tokens"; "Check the amount actually received is used"; "Check token decimals assumptions" |
| APPROVAL_ALLOWANCE | APPROVE_OR_PERMIT | FOUNDRY_PROPERTY | true | "Check spender and amount scope"; "Check allowances are reset after use"; "Check permit replay and deadline" |
| ORACLE_PRICE | ORACLE_READ, SPOT_PRICE_READ | FOUNDRY_PROPERTY | true | "Check manipulation resistance (spot versus time-weighted)"; "Check staleness and decimals"; "Check behaviour when the price is zero, stale or invalid (must fail closed)" |
| SLIPPAGE_MEV | SWAP_OR_TRADE, MIN_OUT_PARAM, DEADLINE_PARAM | FOUNDRY_PROPERTY | true | "Check the minimum output is enforced on the balance actually received"; "Check a zero minimum is rejected where value is at risk"; "Check deadlines"; "Check sandwich exposure" |
| SIGNATURE_REPLAY | SIGNATURE_VERIFY, NONCE_USE, EIP712 | FOUNDRY_PROPERTY | true | "Check domain binding (chain id, contract address)"; "Check nonce consumption and deadline"; "Check signature malleability and ERC-1271 paths" |
| IDENTITY_KEYING | KEY_DERIVATION, ORDER_SENSITIVE_PAIR | FOUNDRY_PROPERTY | true | "Check that distinct intended identities produce distinct keys"; "Check direction or order sensitivity"; "Check abi.encodePacked collisions" |
| UPGRADE_INIT_STORAGE | DELEGATECALL, PROXY_PATTERN, INITIALIZER, STORAGE_GAP | REVIEW_ONLY | false | "Check initializer protection"; "Check storage layout compatibility"; "Check upgrade authorization"; "Check delegatecall targets" |
| DOS_GAS | LOOP_OVER_DYNAMIC, EXTERNAL_CALL_IN_LOOP, PUSH_TO_UNBOUNDED_ARRAY | FOUNDRY_PROPERTY | true | "Check loops over user-growable data"; "Check a single failing item cannot block everyone"; "Check griefing via dust or many small entries" |
| ECONOMIC_INCENTIVE | VALUE_FLOW_CROSS_USER, SHARE_MINT_BURN, FEE_DISTRIBUTION, PAYABLE | FOUNDRY_INVARIANT | true | "Check flash-loan and donation manipulation"; "Check share price and first-depositor manipulation"; "Check value extraction across users"; "Check solvency" |
| CONFIG_DEPLOYMENT | CONSTANT, CONSTRUCTOR_OR_INITIALIZER_PARAM, DEPLOY_ROLE_STATE | ANVIL_STATE_CHECK | true | "Check every constant against documented values"; "Check deployed owners, roles and allowlists match the intended configuration"; "Check parameters stay within bounds" |
| TIME_BLOCK | BLOCK_TIMESTAMP, BLOCK_NUMBER | REVIEW_ONLY | false | "Check tolerance to timestamp manipulation and boundary times" |
| CROSS_CHAIN | CROSS_CHAIN_MESSAGE | REVIEW_ONLY | false | "Check message source authentication"; "Check replay and ordering" |

### T1.2 Create `packages/github-native-sim/src/adr-taxonomy-v1.mjs`

It exports exactly:
- `loadTaxonomyV1(repoRoot)`: reads `protocol/taxonomy/curveyield-defect-taxonomy-v1.json` and returns the parsed object.
- `validateTaxonomyV1(taxonomy)`: validator result (00 §7.2). It checks:
  - schemaVersion is exact;
  - 18 classes, unique `classId`;
  - every trigger listed in `triggerKeys` and every key in `triggerKeys` used at least once;
  - `testMethod` is one of `FOUNDRY_PERMISSION_MATRIX`, `FOUNDRY_PROPERTY`, `FOUNDRY_INVARIANT`, `MEDUSA_PROPERTY`, `ANVIL_STATE_CHECK`, `REVIEW_ONLY`;
  - `testRequired` is false only when `testMethod` is `REVIEW_ONLY`;
  - every `reviewChecks` list is non-empty.
  - Error codes: `TAXONOMY_SCHEMA`, `TAXONOMY_DUPLICATE_CLASS`, `TAXONOMY_UNKNOWN_TRIGGER`, `TAXONOMY_UNUSED_TRIGGER`, `TAXONOMY_BAD_TEST_METHOD`.
- `classesForTriggersV1(taxonomy, triggerKeys)`: returns the sorted unique `classId`s whose `triggers` intersect `triggerKeys`.
  - Additionally, it always includes `ACCESS_CONTROL` and `STATE_MACHINE` when `triggerKeys` contains `STATE_WRITE` or `STATE_WRITE_EXTERNAL`.
  - It always includes `ACCOUNTING_MATH` when `triggerKeys` contains `ARITHMETIC_ON_STATE`.

### T1.3 Create `packages/github-native-sim/src/adr-coverage-matrix-v1.mjs`

It exports:
- `buildCoverageMatrixV1({inventory, taxonomy, discoveryState = null, phase6Results = null})`. It returns `{rows, byContract, byClass, gapCount, label}`.
  - `rows` has one row per (contextId, classId) where the class is required for the context (via `classesForTriggersV1(taxonomy, inventory.payload.triggers[contextId])`).
  - Each row is `{contextId, contract, classId, reviewStatus, testStatus}`.
  - `discoveryState` is `{reviewChecks: {<contextId>: {<classId>: assessment}}, attackContradictions: [{contextId, classId}], gaps: [contextId]}`. T5 builds it from the accepted reviewer-2 submissions and the attacker's paths.
  - `reviewStatus` is one of `ACCEPTED`, `CONTRADICTED`, `NOT_APPLICABLE_CLAIMED`, `GAP`, `PENDING`:
    - `PENDING` when `discoveryState` is null.
    - `GAP` when the context is in `gaps`.
    - `CONTRADICTED` when the (contextId, classId) pair is in `attackContradictions`.
    - `NOT_APPLICABLE_CLAIMED` when reviewer-2's assessment is `NOT_APPLICABLE`.
    - `ACCEPTED` otherwise, meaning the check is `SUPPORTED`, `CONCERN` or `UNRESOLVED`. Candidates and unresolved items are carried by reconciliation, not by this matrix.
  - `testStatus` is one of `PASSED`, `PROPERTY_FAILED`, `NOT_APPLICABLE_CONFIRMED`, `INCONCLUSIVE`, `NOT_ACHIEVED`, `NOT_REQUIRED`, `PENDING`:
    - `NOT_REQUIRED` when the class has `testRequired:false`.
    - `PENDING` when `phase6Results` is null.
    - Otherwise it is taken from `phase6Results[obligationId]` for the matching baseline obligation.
  - `label` is `PARTIAL_COVERAGE` if any row has `reviewStatus` in {`GAP`, `CONTRADICTED`, `PENDING`}, or `testStatus` in {`NOT_ACHIEVED`, `INCONCLUSIVE`, `PENDING`}. Otherwise it is `FULL_COVERAGE`.
  - The Phase 10 matrix is built after reconciliation and testing. A `CONTRADICTED` row stays `CONTRADICTED` only when the related Phase 6 obligation was not `PASSED`; T7 passes that information in `phase6Results`.
- `renderCoverageMarkdownV1(matrix)`: a deterministic markdown table per contract, with columns class, contexts, accepted, contradicted, not-applicable claims, gaps, tests passed, property failures, not achieved. The `label` follows the table.

### T1.4 Tests

`packages/github-native-sim/test/adr-taxonomy-v1.test.mjs`:
1. The real taxonomy file validates with `ok:true`.
2. A copy with a duplicate class fails with `TAXONOMY_DUPLICATE_CLASS`.
3. A copy with an unknown trigger fails with `TAXONOMY_UNKNOWN_TRIGGER`.
4. `classesForTriggersV1` with `['STATE_WRITE']` returns at least `ACCESS_CONTROL` and `STATE_MACHINE`.
5. Two calls with the same input in different order return identical output.

`packages/github-native-sim/test/adr-coverage-matrix-v1.test.mjs`:
1. With no discovery state, every row is `PENDING` and the label is `PARTIAL_COVERAGE`.
2. With all contexts accepted and all tests passed, the label is `FULL_COVERAGE`.
3. One gap context makes the label `PARTIAL_COVERAGE` and the gap appears in `byContract`.
4. `REVIEW_ONLY` classes always get `NOT_REQUIRED`.
5. An attacker contradiction whose obligation later `PASSED` does not make the label partial. Without that pass, it does.
6. Shuffled input arrays produce the same `digestCanonicalV1(matrix)`.

**Done when:** both test files are green in the T0 workflow and the existing regression step is green.

---

## T2 — Phase 0 review inventory, system facts and deployed-state snapshot

**Goal:** Phase 0 deterministically records every reviewable declaration in in-scope code, the machine trigger keys per context, a guard table, sibling differences, value-flow and cross-contract edges, and the owner/role state after the project's own deploy scripts ran. It does no fuzzing and needs no judgment.

**Read first:**
- `packages/github-native-sim/src/source-intelligence-technical-v1.mjs`, especially `function sources(`, `function astIndex(`, `function loc(` and the loop starting `for (const abi of a.abi??[])`;
- `packages/github-native-sim/src/lite-phase0-intelligence-v1.mjs`, search `generateSourceIntelligenceTechnicalBundleV1(` and `SOURCE_INTELLIGENCE_AUTOMATED_v1.json`;
- `.github/workflows/lite-phase0-intelligence-v1.yml`, search `receipt_path="$CAMPAIGN_PATH/receipts/PHASE_00_RECEIPT_v1.json"` and `Write only useful outputs to Audit-Controller campaign`;
- `packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs`, search `if(deploymentOnly){` (first occurrence) and `return{deployEvidence:witness};`;
- `scripts/write-phase0-fork-deploy-outputs-v1.mjs`.

### T2.1 Policy helper: create `packages/github-native-sim/src/adr-policy-v1.mjs`

```js
// Returns 'audit-detection-rebuild-v1' when the bound authority opts in, else null.
export function detectionPolicyForAuthorityV1({repoRoot, authorityRoot, readJsonIfExists}) { ... }
export function authorityRootFromHomepageV1(homepagePath) { ... } // dirname of '.../SKILL.md'; throws if not ending in /SKILL.md
```

- `detectionPolicyForAuthorityV1` reads `<authorityRoot>/MANIFEST.json` through the caller-supplied `readJsonIfExists(relPath)` and returns `manifest.detectionPolicy === 'audit-detection-rebuild-v1' ? that string : null`.
- It returns `null` when the manifest is missing.
- It never throws for a missing file.
- The caller supplies the reader so frozen-authority resolution (T9) applies automatically.

Test file `packages/github-native-sim/test/adr-policy-v1.test.mjs`: a manifest with the field returns the policy; without the field returns null; a missing manifest returns null.

### T2.2 Export the existing source lister

In `source-intelligence-technical-v1.mjs`, add `export const listAdmittedSourcesV1 = sources;` directly after the `async function sources(` function ends. Change nothing else in that file.

### T2.3 Create `packages/github-native-sim/src/adr-review-inventory-v1.mjs`

Export `buildReviewInventoryV1({projectRoot, build, campaign})`. It returns an artifact with header (00 §7.1) and `schemaVersion: "curveyield-review-inventory-v1"`. The payload is:

```
{
  sourceUnits: [{sourceId, path, sha256, scopeTier, astStatus}],
  declarations: [{symbolId, path, qualifiedContainer, containerKind, kind, name, canonicalSignature, visibility, stateMutability, lineStart, lineEnd, hasBody}],
  contexts: [{contextId, symbolId, path, qualifiedContainer, kind, canonicalSignature, visibility, lineStart, lineEnd, effectiveIn: [qualifiedContractName], scopeTier, dependencySymbolIds: [], stateReads: [], stateWrites: [], internalCalls: [], modifiers: [], externalCalls: [{memberName, targetType, line}]}],
  triggers: { "<contextId>": ["<TRIGGER_KEY>", ...] },
  limitations: [{code, path, detail}],
  complete: true|false,
  counts: {sourceUnits, inScopeUnits, declarations, contexts, byKind: {}}
}
```

Build it with these exact rules:
1. **Source list:** `await listAdmittedSourcesV1(projectRoot)`. For each file, read the bytes again with `fs.readFile` and keep the `Buffer` for line computation.
2. **`scopeTier`, decided from the relative path:**
   - `TEST_OR_MOCK` if the path contains `/test/`, `/tests/`, `/mock/` or `/mocks/`, starts with `test/` or `tests/`, or ends with `.t.sol`.
   - `DEPENDENCY` if the path starts with `vendor/`, `lib/`, `node_modules/` or `@`.
   - Otherwise `IN_SCOPE`.
   - Add one limitation `{code:'DEPENDENCY_TIER_BY_PATH', path:'*', detail:'Dependency tier assigned by path prefix; modified vendored code must be moved out of vendor/ to be reviewed as in-scope.'}`.
3. **AST source:**
   - Use `build.compilationUnits[*].sourceAsts` when present, otherwise `build.sourceAsts`, the same way `astIndex` does.
   - An `IN_SCOPE` Solidity file with no AST gets `astStatus:'MISSING'`, one context of kind `FILE_FALLBACK` covering the whole file, and a limitation `INVENTORY_INCOMPLETE`; set `complete:false`.
   - A `.vy` file gets `astStatus:'UNSUPPORTED_LANGUAGE'`, one `FILE_FALLBACK` context and the limitation `UNSUPPORTED_LANGUAGE_FILE_FALLBACK` (this does not make `complete` false).
4. **Declarations:** walk every AST node.
   - `ContractDefinition` → `containerKind` from `contractKind` (`contract`, `library`, `interface`), plus `abstract:true` for abstract contracts.
   - `FunctionDefinition` → `kind` from the node's `kind` field: `function` → `FUNCTION`, `constructor` → `CONSTRUCTOR`, `fallback` → `FALLBACK`, `receive` → `RECEIVE`. A function outside any contract is `FREE_FUNCTION`.
   - `ModifierDefinition` → `MODIFIER`.
   - A `VariableDeclaration` with `stateVariable:true`:
     - `CONSTANT` if `constant`;
     - `IMMUTABLE` if `mutability === 'immutable'`;
     - otherwise `STATE_VARIABLE`.
     - Each state variable with `visibility === 'public'` additionally gets a declaration of kind `GENERATED_GETTER`.
     - A non-constant state variable with an initial `value` additionally gets a declaration of kind `STATE_INITIALIZER`.
5. **`canonicalSignature`:** `name(type1,type2,...)`, using each parameter's `typeDescriptions.typeString` with `storage`/`memory`/`calldata` words removed and spaces removed. A constructor uses the literal name `constructor`.
6. **Line ranges:**
   - Parse `src` as `start:length:fileIndex` (byte offsets).
   - `lineStart` = 1 + the number of `0x0a` bytes in `buffer.subarray(0, start)`.
   - `lineEnd` = 1 + the number of `0x0a` bytes in `buffer.subarray(0, start + length)`.
   - Never use JavaScript string indexes for this.
7. **Contexts:** create one context for every declaration of kind `FUNCTION` with a body, `CONSTRUCTOR`, `FALLBACK`, `RECEIVE`, `FREE_FUNCTION`, `MODIFIER`, `STATE_INITIALIZER`, `CONSTANT`, `IMMUTABLE` or `GENERATED_GETTER` whose `scopeTier` is `IN_SCOPE`. Also:
   - Add one context of kind `INHERITED_DEPENDENCY` for every `DEPENDENCY` external or public function that is inherited by an `IN_SCOPE` concrete contract and is not overridden there.
   - Interface functions without a body get no context.
8. **`effectiveIn`:** for every `IN_SCOPE` concrete (non-abstract, non-interface, non-library) contract `C`, walk `C.linearizedBaseContracts`. For each executable declaration of those bases, find the most-derived declaration with the same `canonicalSignature`. Add `C`'s qualified name (`path:Name`) to that context's `effectiveIn`.
   - A library function's `effectiveIn` is `[library qualified name]`.
   - A context with an empty `effectiveIn` keeps it empty and gets `orphan:true` (still reviewed).
9. **Edges per context**, using `referencedDeclaration` ids mapped to symbols through a map built from all units first:
   - `internalCalls`: `FunctionCall` nodes whose expression resolves to a `FunctionDefinition`;
   - `modifiers`: `ModifierInvocation` names;
   - `stateReads` and `stateWrites`: identifiers resolving to state variables; a write is the left side of an `Assignment`, the operand of `++`/`--`/`delete`, or the base of `.push`/`.pop`;
   - `externalCalls`: a `FunctionCall` whose expression is a `MemberAccess` with a base `typeDescriptions.typeString` starting with `contract ` or `address`, excluding `balance`, `code` and `codehash`.
   - `dependencySymbolIds`: the transitive closure of `internalCalls` plus modifier definitions, depth limit 3, sorted.
10. **Trigger keys per context.** Apply every rule; over-triggering is correct, so if unsure, add the key:
    - `STATE_WRITE`: `stateWrites` is non-empty.
    - `STATE_WRITE_EXTERNAL`: the context is external or public (or is reachable from one through `internalCalls`, depth 3) and either it or a callee has `STATE_WRITE` or `externalCalls`.
    - `PRIVILEGED_GUARD`: there is a modifier whose name matches `/only|auth|restricted|whenNot|whenPaused|initializer|nonReentrant/i`, or a `require`/`if` condition containing `msg.sender`, or a call named `hasRole|_checkRole|canPerform|_authenticateCaller|getActionId|_checkOwner`.
    - `TX_ORIGIN`: any `MemberAccess` `tx.origin`.
    - `PAYABLE`: `stateMutability === 'payable'` or any `msg.value`.
    - `OWNERSHIP_OR_ROLE_WRITE`: a write to a state variable whose name matches `/owner|admin|role|controller|guardian|authority|operator|keeper/i`, or a call named `grantRole|revokeRole|_grantRole|_revokeRole|_transferOwnership|transferOwnership`.
    - `PENDING_STATE`: a read or write of a state variable whose name starts with `pending` (case-insensitive).
    - `INITIALIZER`: a modifier `initializer|reinitializer|onlyInitializing`, or a function name starting with `initialize`.
    - `ARITHMETIC_ON_STATE`: a `BinaryOperation` with operator in `+ - * / % **` whose operand or assignment target is a state variable.
    - `DIVISION`: operator `/`, or a call named `mulDiv|mulDivDown|mulDivUp|divUp|divDown|divWadDown|divWadUp`.
    - `BPS_OR_SCALE_CONSTANT`: a numeric literal `10000`, `1e4`, `1000`, `1e6`, `1e18` or `1e27`, or an identifier matching `/BPS|BASIS|WAD|RAY|SCALE|PRECISION|DENOMINATOR/`.
    - `STATUS_FLAG_WRITE`: a write to a bool state variable or struct member whose name matches `/executed|cancel|approved|claimed|status|state|active|paused|used/i`.
    - `MAPPING_STRUCT_WRITE`: a write through `IndexAccess` or to a struct member in storage.
    - `EXTERNAL_CALL`: `externalCalls` is non-empty.
    - `LOW_LEVEL_CALL`: a member `call|delegatecall|staticcall|send|transfer` on an `address` type.
    - `DELEGATECALL`: a member `delegatecall`.
    - `RETURN_VALUE_USED`: an external call whose result is assigned, returned or used in a condition.
    - `EXTERNAL_CALL_BEFORE_STATE_WRITE`: in the same body, an external call whose byte start is before the byte start of a state write.
    - `ARBITRARY_TARGET_CALL`: an external call whose base expression references a function parameter.
    - `TOKEN_TRANSFER`: a member call named `transfer|transferFrom|safeTransfer|safeTransferFrom`.
    - `TOKEN_BALANCE_READ`: a member call `balanceOf`.
    - `APPROVE_OR_PERMIT`: a call named `approve|safeApprove|forceApprove|increaseAllowance|decreaseAllowance|safeIncreaseAllowance|permit`.
    - `ORACLE_READ`: a call named `latestRoundData|latestAnswer|getPrice|getRate|consult|observe|getQuote|twap|quote`.
    - `SPOT_PRICE_READ`: a call named `getReserves|slot0|getCurrentLiveBalances|getPoolTokenInfo|getPoolTokens`.
    - `SWAP_OR_TRADE`: a call or function name matching `/^swap|exactInput|exactOutput|exchange|trade/i`.
    - `MIN_OUT_PARAM`: a parameter name matching `/min(Amount)?Out|minReturn|amountOutMin|limit/i`.
    - `DEADLINE_PARAM`: a parameter name matching `/deadline/i`.
    - `SIGNATURE_VERIFY`: a call named `ecrecover|recover|tryRecover|isValidSignatureNow|isValidSignature`.
    - `NONCE_USE`: a state variable whose name matches `/nonce/i` is read or written.
    - `EIP712`: an identifier containing `DOMAIN_SEPARATOR|_hashTypedDataV4|EIP712`.
    - `KEY_DERIVATION`: `keccak256` applied to `abi.encode` or `abi.encodePacked`.
    - `ORDER_SENSITIVE_PAIR`: two address parameters whose names match `/tokenIn|tokenOut|tokenA|tokenB|from|to|base|quote/i`, or a `<`/`>` comparison between two addresses.
    - `PROXY_PATTERN`: a base contract name matching `/Upgradeable|Initializable|UUPS|ERC1967|Proxy/`.
    - `STORAGE_GAP`: a state variable named `__gap`.
    - `LOOP_OVER_DYNAMIC`: a `ForStatement` or `WhileStatement` whose condition uses `.length` of a state or parameter array.
    - `EXTERNAL_CALL_IN_LOOP`: an external call inside a loop body.
    - `PUSH_TO_UNBOUNDED_ARRAY`: `.push` on a state array in a context with `STATE_WRITE_EXTERNAL`.
    - `VALUE_FLOW_CROSS_USER`: `TOKEN_TRANSFER` whose recipient argument is not the identifier `msg.sender`.
    - `SHARE_MINT_BURN`: a call or definition named `_mint|_burn|mint|burn`, or a write to `totalSupply`.
    - `FEE_DISTRIBUTION`: an identifier matching `/fee|bps|split|distribut|reward/i` used in arithmetic.
    - `BLOCK_TIMESTAMP`: `block.timestamp`.
    - `BLOCK_NUMBER`: `block.number`.
    - `CROSS_CHAIN_MESSAGE`: an identifier matching `/lzReceive|ccipReceive|_nonblockingLzReceive|receiveWormhole|messenger|bridge/i`.
    - `CONSTANT`: the context kind is `CONSTANT` or `IMMUTABLE`.
    - `CONSTRUCTOR_OR_INITIALIZER_PARAM`: a constructor, or a function with `INITIALIZER`, that has parameters and writes state.
    - `FILE_FALLBACK` contexts get every trigger key whose class has `testRequired:true`.
    - `DEPLOY_ROLE_STATE` is added in T3 (it needs the snapshot), not here.
11. Sort every array (contexts by `path`, then `lineStart`, then `contextId`). Two runs on the same input must produce byte-identical `canonicalJsonV1` output.

### T2.4 Create `packages/github-native-sim/src/adr-system-facts-v1.mjs`

Export `buildSystemFactsV1({inventory})`. It returns an artifact with `schemaVersion: "curveyield-system-facts-v1"` and a payload of:

- `guardTable`: one row per `IN_SCOPE` or `INHERITED_DEPENDENCY` context that is external or public and has `STATE_WRITE_EXTERNAL`:
  `{contextId, contract, function: canonicalSignature, modifiers, senderCheckLines: [line numbers of require/if containing msg.sender or role-check calls], txOriginLines: [], hasGuard: boolean}`.
  `hasGuard` is true when there are modifiers matching the `PRIVILEGED_GUARD` regex, or `senderCheckLines` is non-empty.
- `siblingGroups`: group the `IN_SCOPE` concrete contracts that share the same direct base contract set (sorted names) or the same implemented interface. For each `canonicalSignature` present in two or more members, list `{signature, members: [{contract, modifiers, hasGuard}]}`. Set `asymmetric: true` when the `hasGuard` values or modifier sets differ.
- `valueFlows`: every external call whose `memberName` is a `TOKEN_TRANSFER` or `APPROVE_OR_PERMIT` name: `{contextId, contract, memberName, line}`.
- `crossContractEdges`: every external call whose base type is `contract <Name>`, where `<Name>` is an `IN_SCOPE` contract or interface implemented by one: `{fromContextId, fromContract, toType, memberName, line}`.
- `dependencyEdges`: the same, where the target is a `DEPENDENCY`-tier type.

Sort all arrays deterministically.

### T2.5 Wire inventory and facts into Phase 0 (intelligence module + intelligence workflow)

**How Phase 0 intelligence actually publishes (verified 2026-10-12):**
- The module `lite-phase0-intelligence-v1.mjs` only writes files into their temporary `--output` directory (`.phase0-intelligence-output`). It never reads the Phase 0 receipt and never touch Audit-Controller.
- The workflow `.github/workflows/lite-phase0-intelligence-v1.yml` handles the rest:
  - fetch the receipt into `/tmp/phase0-receipt.json` in the step guarded by `if: inputs.campaign_id != ''`;
  - run the module;
  - in the step "Write only useful outputs to Audit-Controller campaign", copy a fixed list of output files into the campaign;
  - commit with `git add "$campaign_path/evidence" …`.

**This task is authorized to edit that workflow,** exactly as described below (exception to N7). Make no other change to it. **Never edit any `*no-telemetry*` file**: that fork is discontinued and is archived by T0.4.

1. **Policy for the run.** In the step that writes `/tmp/phase0-receipt.json` (search `receipt_path="$CAMPAIGN_PATH/receipts/PHASE_00_RECEIPT_v1.json"`), append these lines at the end of its `run:` block:

```bash
homepage="$(jq -r '.authority.homepagePath // empty' /tmp/phase0-receipt.json)"
adr_policy=""
if [ -n "$homepage" ]; then
  manifest_path="$(dirname "$homepage")/MANIFEST.json"
  encoded="$(jq -rn --arg p "$manifest_path" '$p|split("/")|map(@uri)|join("/")')"
  if gh api "repos/curveyield3/Audit-Controller/contents/$encoded?ref=$AUDIT_CONTROLLER_REF" --jq '.content' > /tmp/adr-manifest.b64 2>/dev/null; then
    adr_policy="$(base64 -d /tmp/adr-manifest.b64 2>/dev/null | jq -r '.detectionPolicy // empty' 2>/dev/null || true)"
  fi
fi
[ "$adr_policy" = "audit-detection-rebuild-v1" ] || adr_policy=""
echo "ADR_DETECTION_POLICY=$adr_policy" >> "$GITHUB_ENV"
```

   - When that step is skipped (no `campaign_id`) or the manifest is not found, the variable is empty and nothing new happens.
   - The receipt is the campaign's `receipts/PHASE_00_RECEIPT_v1.json` at `inputs.audit_controller_ref`. It is already fetched by this step; do not fetch it anywhere else.

2. **Module change.** Find the statement containing `generateSourceIntelligenceTechnicalBundleV1({projectRoot:detected.absolute`. Directly after it, add:

```js
await writeReviewInventoryOutputsV1({outputDir: <the module's --output directory variable>, projectRoot: detected.absolute, build, request, policy: process.env.ADR_DETECTION_POLICY || null});
```

   Use the same variable the module passes to `fs.writeFile` for `SOURCE_INTELLIGENCE_AUTOMATED_v1.json`.

3. **The function `writeReviewInventoryOutputsV1`.** Add and export it in `packages/github-native-sim/src/adr-review-inventory-v1.mjs`:
   - If `policy !== 'audit-detection-rebuild-v1'`, return without writing anything. The outputs of old campaigns stay byte-identical.
   - Otherwise build the inventory (T2.3) and the facts (T2.4), with header values `campaignId = request.campaignId`, `campaignGenerationId = request.campaignGenerationId` and `sourceSha256 = request.source.archiveSha256`.
   - Write `REVIEW_INVENTORY_v1.json` and `SYSTEM_FACTS_v1.json` into `outputDir` with `fs.writeFile(…, JSON.stringify(x,null,2)+'\n')`.
   - Wrap everything in `try/catch`. On error, write `REVIEW_INVENTORY_v1.json` with `payload.complete:false`, empty arrays and `limitations:[{code:'INVENTORY_BUILD_ERROR', path:'*', detail:<message, max 2000 chars>}]`, do not write `SYSTEM_FACTS_v1.json`, and return normally.
   - Never throw.

4. **Copy into the campaign.** In the step "Write only useful outputs to Audit-Controller campaign", directly after the line that copies `PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json`, add:

```bash
if [ -f ../.phase0-intelligence-output/REVIEW_INVENTORY_v1.json ]; then
  mkdir -p "$campaign_path/evidence/review-inventory"
  cp ../.phase0-intelligence-output/REVIEW_INVENTORY_v1.json "$campaign_path/evidence/review-inventory/REVIEW_INVENTORY_v1.json"
  if [ -f ../.phase0-intelligence-output/SYSTEM_FACTS_v1.json ]; then
    cp ../.phase0-intelligence-output/SYSTEM_FACTS_v1.json "$campaign_path/evidence/review-inventory/SYSTEM_FACTS_v1.json"
  fi
fi
```

   The existing `git add "$campaign_path/evidence" …` line already commits these files. Do not change it.

### T2.6 Deployed-state snapshot (read-only, in the existing deploy-only branch)

1. Create `packages/github-native-sim/src/adr-deployed-state-snapshot-v1.mjs` exporting `async captureDeployedStateSnapshotV1({provider, deployedContracts, artifactByQualified, maxCallsPerContract = 50})`.
   - For each row of `deployedContracts` that has a `qualifiedName` found in `artifactByQualified`, call every ABI function with zero inputs and `stateMutability` `view` or `pure` whose outputs are all `address`, `bool`, `bytes32` or `uint*`/`int*`. Stop at `maxCallsPerContract` per contract.
   - Use `new ethers.Contract(address, [fragment], provider)`, with a 5-second timeout per call via `Promise.race`.
   - Record `{contract: qualifiedName, address, function: name, result: <string> | null, status: 'OK' | 'REVERTED' | 'TIMEOUT' | 'ERROR'}`.
   - Return `{schemaVersion:'curveyield-deployed-state-snapshot-v1', status, rows}`, where `status` is `'CAPTURED'`, `'NO_DEPLOYMENT_ADDRESSES'` or `'ERROR'`. It never throws.
2. In `phase0-randomized-simulation-v1.mjs`, inside the first `if(deploymentOnly){` block, directly before the line `await provider.destroy();` that precedes `return{deployEvidence:witness};`, insert:

```js
let deployedStateSnapshot;
try { deployedStateSnapshot = await captureDeployedStateSnapshotV1({provider, deployedContracts: witness.deployedContracts ?? [], artifactByQualified}); }
catch (e) { deployedStateSnapshot = {schemaVersion:'curveyield-deployed-state-snapshot-v1', status:'ERROR', rows:[], error:String(e?.message ?? e).slice(0,2000)}; }
await fs.writeFile(path.join(outputRoot,'DEPLOYED_STATE_SNAPSHOT_v1.json'), JSON.stringify(deployedStateSnapshot,null,2)+'\n');
```

   Add the import at the top of the file. Make no other change to this file.
3. In `scripts/write-phase0-fork-deploy-outputs-v1.mjs`, after the line that writes `PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json` into `destination`, add a block that runs only when the campaign opts in:
   1. Read the receipt `<campaignRoot>/receipts/PHASE_00_RECEIPT_v1.json`. This script writes directly into the Audit-Controller checkout given by `--controller-root`, and the calling workflows already commit with `git add -A -- "$CAMPAIGN_PATH"`, so no workflow change is needed for this step.
   2. Compute `policy = detectionPolicyForAuthorityV1({repoRoot: controllerRoot, authorityRoot: authorityRootFromHomepageV1(receipt.authority.homepagePath), readJsonIfExists})`, where `readJsonIfExists(rel)` reads `path.join(controllerRoot, rel)` and returns `null` if it is missing.
   3. If `policy` is non-null and `path.join(src,'DEPLOYED_STATE_SNAPSHOT_v1.json')` exists, copy it to `<campaignRoot>/evidence/review-inventory/DEPLOYED_STATE_SNAPSHOT_v1.json` (create the directory).
   4. Wrap the whole block in `try/catch` and ignore errors. Never fail the writer because of it.

### T2.7 Tests

`packages/github-native-sim/test/adr-review-inventory-v1.test.mjs`:
- Put the fixture Solidity sources under `packages/github-native-sim/test/fixtures/adr-inventory/` (as `.sol` files) and compile them **inside the test** with the `solc` npm package already listed in the root `package.json`. Use standard-JSON input with `outputSelection: {'*': {'*': ['abi'], '': ['ast']}}` and build the `build` object `{sourceAsts: {<path>: <ast>}, artifacts: []}` from the output. The test runs in the T0 workflow on GitHub. Do not commit generated AST JSON, and do not compile anything on your own machine.
- The fixture contracts are:
  - a contract with a public function, an internal helper, a private helper, a constructor, a modifier, `fallback`, `receive`, a public state variable, a constant, an immutable and a state variable with an initializer;
  - a library with an internal function;
  - an abstract base with a function inherited by two concrete contracts;
  - an overloaded function;
  - an interface;
  - a file under `vendor/` with a public function inherited by an in-scope contract;
  - a file with a UTF-8 multibyte character in a comment before a function.
- Assertions:
  1. Every expected kind appears.
  2. The interface has no context.
  3. The inherited base function has one context whose `effectiveIn` lists both concrete contracts.
  4. The vendor function appears once as `INHERITED_DEPENDENCY`.
  5. Line numbers after the multibyte character are correct.
  6. The library internal function is a context.
  7. Overloads get distinct ids.
  8. A missing AST for an in-scope file gives `FILE_FALLBACK`, `complete:false` and `INVENTORY_INCOMPLETE`.
  9. Reversing every input array gives identical `canonicalJsonV1`.
  10. A state write after an external call yields `EXTERNAL_CALL_BEFORE_STATE_WRITE`.
  11. `tx.origin` yields `TX_ORIGIN`.
  12. `writeReviewInventoryOutputsV1` into a temporary directory:
      - with `policy: null` it writes no files;
      - with the policy set it writes both files;
      - with a `build` that makes the builder throw, it writes only `REVIEW_INVENTORY_v1.json` with `INVENTORY_BUILD_ERROR` and does not throw.

`packages/github-native-sim/test/adr-phase0-wiring-v1.test.mjs` (text test):
- `lite-phase0-intelligence-v1.yml` contains `ADR_DETECTION_POLICY=` and the guarded `evidence/review-inventory` copy block.
- `lite-phase0-intelligence-v1.mjs` contains `writeReviewInventoryOutputsV1(`.
- `scripts/write-phase0-fork-deploy-outputs-v1.mjs` contains `DEPLOYED_STATE_SNAPSHOT_v1.json` inside a `detectionPolicyForAuthorityV1` guard.

`packages/github-native-sim/test/adr-system-facts-v1.test.mjs`:
- Two sibling contracts where one public function lacks the modifier the other has gives `asymmetric:true`.
- A guarded function gets `hasGuard:true`.
- A transfer call appears in `valueFlows`.

`packages/github-native-sim/test/adr-deployed-state-snapshot-v1.test.mjs`:
- With a stub provider object whose `call` returns encoded values or throws, the statuses are `OK`, `REVERTED` and `ERROR`, and nothing throws.
- An empty `deployedContracts` gives `NO_DEPLOYMENT_ADDRESSES`.

**Old-path regression:** the existing regression step must stay green. Do not change `generateSourceIntelligenceTechnicalBundleV1` output.

**Done when:** all four test files are green in the T0 workflow and the regression step is green.

---

## T3 — Phase 0 flow plan: flows, review units, attack units and integration questions

**Goal:** before any reviewer starts, Phase 0 computes:
- every end-to-end **flow** through the system;
- reviewer-2's **review units** (built from flows, so cross-contract paths stay together);
- the attacker's **attack units** (one per connected group of contracts);
- the cross-contract **integration questions** the attacker must answer.

Nothing here limits what a reviewer may read or cite (00 D11). Units only bound how many rows one submission must fill.

**Read first:**
- `scripts/lite-phase0-finalize-v1.mjs`: search `const required=` or `required(`, and the place the receipt is sealed.

### T3.1 Create `packages/github-native-sim/src/adr-flow-plan-v1.mjs`

Export `buildFlowPlanV1({inventory, facts, snapshot = null, limits = DEFAULT_LIMITS})`, where:

```js
export const DEFAULT_LIMITS = Object.freeze({maxPrimaryContextsPerUnit: 40, maxFlowDepth: 8, maxIntegrationQuestionsPerAttackUnit: 15});
```

It returns an artifact with `schemaVersion: "curveyield-flow-plan-v1"` and a payload of `{limits, flows, clusters, reviewUnits, attackUnits, integrationQuestions, gaps, capacity}`. The rules are below.

#### 1. Reviewable contexts

Contexts with `scopeTier` `IN_SCOPE` or `INHERITED_DEPENDENCY`.

#### 2. Entry points

Every reviewable context that meets all of these:
- kind `FUNCTION`, `FALLBACK`, `RECEIVE` or `INHERITED_DEPENDENCY`;
- visibility `external` or `public`;
- has trigger `STATE_WRITE_EXTERNAL`, `PAYABLE` or `EXTERNAL_CALL`.

Sort them by `path`, then `lineStart`.

#### 3. Flows

For each entry point, build the **flow**:
- Start at the entry point.
- Follow `internalCalls` (and modifier definitions).
- Follow every `crossContractEdges` row from a context in the flow: add every context of the target contract whose `canonicalSignature` matches the called `memberName` (any overload). An interface-typed target resolves to every `IN_SCOPE` contract implementing that interface.
- Stop at `maxFlowDepth` hops.
- Record `{flowId: "FLOW-<4 digits>", entryContextId, contexts: [contextIds in first-visit order], contracts: [sorted qualified names], crossContract: <contracts.length > 1>, depthLimited: boolean}`.

A flow that reaches the depth limit is still valid; it records `depthLimited:true` and the attacker sees it.

#### 4. Clusters

Contracts connected by any `crossContractEdges` (treated as undirected), any `valueFlows` between them, or shared inheritance of an `IN_SCOPE` base form one **cluster**, computed as connected components. Each cluster is `{clusterId: "CL-<3 digits>", contracts, flowIds}`. Sort clusters by their first contract path.

#### 5. Review units for reviewer-2 (F units)

- Go through clusters in order. Inside a cluster, go through its flows in order.
- A context is **primary** in the first flow that reaches it. Later flows list it as context only.
- Add flows to the current unit until adding the next flow's new primary contexts would exceed `maxPrimaryContextsPerUnit`. Then start a new unit.
- **Never split a flow across units.** A single flow with more new primary contexts than the limit gets its own unit with `oversize:true`.
- **Never put two clusters into one unit.**
- Each unit is `{unitId: "F-<3 digits>", role: "FLOW_REVIEW", clusterId, flowIds, primaryContextIds, readContextIds: <all contexts of its flows>, oversize}`.

#### 6. Residual units (R units)

Reviewable contexts that are primary in no flow, such as unused helpers, view functions, constants and getters, are grouped by `qualifiedContainer` into units `{unitId: "R-<3 digits>", role: "RESIDUAL_REVIEW", primaryContextIds, readContextIds: <all contexts of the same contracts>}` of at most `maxPrimaryContextsPerUnit`.

#### 7. Integration questions

One `IOB-<4 digits>` per item below, in this order:
1. each unordered pair of in-scope contracts joined by `crossContractEdges`;
2. each in-scope contract with `dependencyEdges` (one per contract and dependency type);
3. each `siblingGroups` entry with `asymmetric:true`;
4. each in-scope contract with `valueFlows` to more than one distinct contract;
5. each guard-table row with `hasGuard:false`;
6. each flow with `crossContract:true` that also contains `EXTERNAL_CALL_BEFORE_STATE_WRITE` or `ARBITRARY_TARGET_CALL` anywhere;
7. if the snapshot `status` is `CAPTURED`, one question "Reconcile deployed owners, roles and allowlists with the intended configuration". In that case also add trigger `DEPLOY_ROLE_STATE` to the `CONSTRUCTOR` contexts of deployed contracts.

Each question is `{obligationId, kind, clusterId, contracts, contextIds, evidence, question}`. Use these question templates, by item number:
1. "Do the calls between {A} and {B} preserve each contract's invariants and authorization assumptions in every order, re-entry and failure case?"
2. "Are {A}'s assumptions about {Dep} (return values, callbacks, rounding, access control) correct?"
3. "Is the guard difference on {signature} across {members} intended, and is the unguarded variant exploitable?"
4. "Is value conserved across all outgoing value flows of {A}?"
5. "Who can call {signature} on {A}, and what can they achieve with it?"
6. "Can an attacker re-enter or redirect {flowId} across {contracts} to break state or steal value?"
7. "Do the deployed owners, roles and allowlists match the intended configuration?"

#### 8. Attack units for the attacker reviewer (X units)

- There is one unit per cluster: `{unitId: "X-<3 digits>", role: "ATTACK", clusterId, flowIds: <all flows of the cluster>, contracts, integrationQuestionIds: <the cluster's IOBs>}`.
- If a cluster has more than `maxIntegrationQuestionsPerAttackUnit` questions, split it into consecutive X units for the same cluster, each listing all flows but only its slice of questions.
- Questions without a cluster (pure dependency questions) join the unit of the contract's cluster.

#### 9. Gaps

Every `FILE_FALLBACK` context and every `INVENTORY_INCOMPLETE` limitation goes into `gaps` with `code: 'INVENTORY_INCOMPLETE'`. Fallback contexts also become R units, so they are still reviewed.

#### 10. Capacity and determinism

- `capacity = {flows, crossContractFlows, clusters, flowReviewUnits, residualUnits, attackUnits, reviewableContexts, integrationQuestions}`.
- Reversed inputs must produce identical output.

### T3.2 Wire into the Phase 0 finalizer

In `scripts/lite-phase0-finalize-v1.mjs`, just before the receipt is sealed (search for where `validation.status` is set to `PASS`):

1. Compute the policy exactly as in T2.6 step 2. The finalizer writes directly into the `--controller-root` checkout, and the bootstrap workflows commit with `git add -- "$CAMPAIGN_PATH" …`, so no workflow change is needed.
   - Read the receipt from `<controller-root>/<campaign-path>/receipts/PHASE_00_RECEIPT_v1.json`.
   - Read the authority manifest from the same checkout.
2. If the policy is non-null:
   - read `evidence/review-inventory/REVIEW_INVENTORY_v1.json`, `SYSTEM_FACTS_v1.json` and, optionally, `DEPLOYED_STATE_SNAPSHOT_v1.json`;
   - build the plan;
   - write `evidence/review-inventory/FLOW_PLAN_v1.json`;
   - add `{role:'ADR_REVIEW_INVENTORY', path, sha256}` references for all present review-inventory files to the receipt's evidence list, using the same structure the finalizer uses for its other evidence references.
3. If the inventory file is missing or has `complete:false`, still write the plan (its `gaps` record the problem) and still seal.
4. If plan building throws, write a plan with empty units and one gap `{code:'PLAN_BUILD_ERROR', detail}`, and still seal.

Phase 0 must never be blocked by T2 or T3 artifacts.

### T3.3 Tests

`packages/github-native-sim/test/adr-flow-plan-v1.test.mjs`, using synthetic inventories built in the test:

1. Contracts A → B → C chained by external calls give one flow from A's entry point containing contexts of A, B and C, with `crossContract:true` and a single cluster. **The flow is never split across units.**
2. 30 connected contracts: every reviewable context is primary in exactly one F or R unit, and no unit mixes clusters.
3. One flow with 60 new primary contexts gets its own unit with `oversize:true`.
4. An unused private helper becomes an R unit.
5. Two unconnected groups give two clusters and two X units.
6. Sibling asymmetry, an unguarded state-changing function and a cross-contract re-entry flow each produce an integration question in the right cluster's X unit.
7. 40 questions in one cluster give 3 X units, each listing all of the cluster's flows.
8. Reversed inputs give an identical digest.
9. A `FILE_FALLBACK` context appears in `gaps` and in an R unit.

**Done when:** the test file is green in the T0 workflow and the regression step is green.
