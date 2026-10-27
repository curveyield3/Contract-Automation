# Lite-Solo v4 parallel-unit implementation — Step 00 baseline and ordered change inventory

**Document version:** v1. **Status:** Step 0 source-inspection inventory. **Source specification:** `Lite_Solo_Phases_4_5_6_Parallel_Unit_Implementation_Plan_v3.md` §C Step 0. **Testing:** None created, modified or executed by this step.

## Scope and precedence

- Target repos: `curveyield3/Audit-Controller` (bound security authority and campaign state) and `curveyield3/Contract-Automation` (trusted controller, request ingress, and Actions). Applicable phases are 4, 5 and 6; phases 0–3 and 7–10 must retain their substantive security and sealed-receipt rules.
- User's later explicit instruction **supersedes the spec's preserve-legacy-operational-routes directive**: no campaigns are currently active per user; make v4 the sole *new-campaign operational* Lite-Solo release, retire obsolete ingress/dispatch and confusing worker paths, **without deleting historical source/receipt evidence or modifying v3 authority bytes**. Do not silently rebind historical generations.
- This inventory was created *after* provisional v4 code had already been committed. Existing files listed here are not counted as completed implementation steps merely because they exist. Each succeeding numbered step requires a substantive source-level completion check before proceeding.

## 0.1 — Immutable authority and controller data path baseline

| Owner | Exact admitted path / binding | Purpose and preservation rule |
| --- | --- | --- |
| Audit-Controller | `Audit Skill - Lite-Solo Authority/lite-solo-v3/MANIFEST.json` | Read-only manifest with **147 entries**; SHA-256 of exact manifest content **`4afcc366488f504ea07b9418509a8074a9306d2411a8ca4a25013a99c4b2d580`**; Git blob SHA-1 **`b9c632a094028d20415ed93844384932422e182f`**. |
| Audit-Controller | `Audit Skill - Lite-Solo Authority/lite-solo-v3/SKILL.md` | Read-only skill root; Git blob `b9e36c284e1cec0de0a11166652be999f54583f8`. |
| Audit-Controller | `Audit Skill - Lite-Solo Authority/lite-solo-v3/phases/phase-{4,5,6}/{START_HERE.md,PHASE_CONTRACT.json,PHASE_0X_SCHEMA_v1.json}` | Source-inspected; all nine files immutable. Specific 04/05/06 schemas define required authoritative semantic records. |
| Audit-Controller | `Audit Skill - Lite-Solo Authority/lite-solo-v4/MANIFEST.json`, `/SKILL.md`, `/phases/phase-{4,5,6}/START_HERE.md` | Provisional v4 implementation is already present; review it and its hashes/linkage at Step 16, not as part of Step 0. |
| Audit-Controller | `campaigns/<campaign-name>/receipts/PHASE_00_RECEIPT_v1.json` | Source archive SHA-256, immutable generation and authority identity initially captured on admission. Later receipts carry the predecessor chain. |
| Audit-Controller | `Audit Campaign Directory/campaigns/<campaign-slug>.json` | Canonical campaign generation, bound `sourceSha256`, `authorityDigest`, `authorityRelease`, `currentAssignment`, and prior sealed receipt path. |
| Audit-Controller | `directory.currentAssignment.{phaseSequence,reviewer,workSchemaPath,workShardIndexPath,workFormPath,packetPath,predecessorReceiptPath,derivedInputPaths,controllerPrefillDigestSha256}` | Current phase contract/transport. v4 also exposes `unitQueueIndexPath` and `unitQueueStatePath`; sole reviewer is a logical role, not a single worker. |
| Audit-Controller | `campaigns/<campaign-name>/work/phase-04/discovery/DISCOVERY_STATE_v1.json` | Historical discovery state path, including F/R/X state. Existing single-chat windows must not control v4 ownership. |
| Audit-Controller | `campaigns/<campaign-name>/work/phase-04/discovery/<unitId>/ASSIGNMENT_PACKET_v1.json` | Source-bound flow and attacker packet; retained per-unit validators and source context; v4 packets are paginated. |
| Audit-Controller | `campaigns/<campaign-name>/work/phase-04/discovery/DISCOVERY_SUMMARY_v1.json` | Controller-produced aggregate discovery evidence after correctness and attacker acceptance, not every individual approval. |
| Audit-Controller | `campaigns/<campaign-name>/work/phase-0N/shards/...`, `currentAssignment.workShardIndexPath` | Existing semantic shard pages and index; owner-key fidelity and 64-KiB shard limits must remain. Only controller assembles v4 accepted units. |
| Audit-Controller | `campaigns/<campaign-name>/work/phase-0N/units/{UNIT_PLAN_INDEX_v1.json,UNIT_QUEUE_STATE_v1.json,...}` | Provisional v4 immutable unit plan, queue, claim packets, worker submissions, controller accept/rework results. |
| Audit-Controller | `campaigns/<campaign-name>/controller/results/<sha-prefix>/INDEX_v1.json` | Paged, digest-bound controller results from `scripts/lib/lite-boundary-result-v1.mjs`; never overwrite with a worker response. |
| Contract-Automation | `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json` | Provisional v4 immutable per-worker request ingress; must outlive dropped/replaced GitHub Actions runs. |

Source receipt verifier: `scripts/lib/lite-solo-phase-work-v1.mjs:validateBoundAuthorityV1` enforces SHA-256 of the manifest, Git blob SHA-1, manifest-listed file lengths and individual SHA-256s, homepage SHA-256 and release/revision. Admission writes authority commit/blob/digest and source archive identity through `scripts/lite-solo-source-initialization/run-v1.sh` and `write-phase0-receipt-v1.py`. The controller resolves the sealed predecessor receipt before permitting phase actions. **Do not modify, rehash, or update old receipt/authority content in place.**

## 0.2 — Runtime hard-coded and restrictive assumption inventory

| Search target | Exact relevant source | Observed assumption and change requirement |
| --- | --- | --- |
| `ONE_PERSISTENT_AGENT` | `scripts/lite-solo-source-initialization/write-phase0-receipt-v1.py`; `scripts/lite-solo-phase0-finalize-v1.mjs`; `scripts/lite-solo-phase-controller-v1.mjs`; `.github/workflows/lite-solo-phase-controller-v1.yml` | Legacy actor model coexists with `PARALLEL_WORKER_UNITS`; ensure new v4 admission exclusively uses parallel model without changing historical generations. |
| `sequentialSingleReviewer` | `packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs` (~167, 304) | Historical single-owner discovery scheduling; replace as v4 operational gate, preserve actual source/semantic validators. |
| `SOLO_WINDOW_MAX_UNITS` | `packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs` (~20, 175, 176, 445, 499, 528) | Legacy **8** window limit and old `SOLO_WINDOW_MAX_WORK_ITEMS=150`/combined packet size budget must not throttle ten-unit v4 claims. |
| `readyUnitIds` | `packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs`; `scripts/lite-solo-phase-controller-v1.mjs`; `.github/workflows/lite-solo-phase-controller-v1.yml` (~51–56, 150–151) | Legacy <=8 multi-unit boundary request; new v4 uses explicit immutable 1–5-unit `SUBMIT`. |
| Release allowlists | `scripts/lib/lite-solo-lineup-v1.mjs`; `scripts/lite-solo-phase-controller-v1.mjs` (~126–130, 775–778, 845); `scripts/lite-solo-phase0-finalize-v1.mjs` (~179, 224); `packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs` (~301); `.github/workflows/lite-solo-phase-controller-v1.yml` (~118); `scripts/lite-solo-source-initialization/run-v1.sh` (~74) | v1/v2/v3/v4/v5/v6 allowlists and root constants must be reduced/normalized **only for operational v4 routing**, while historical bound authority verification continues to resolve original release snapshots. |
| Current authority initialization | `scripts/lite-solo-source-initialization/run-v1.sh` (~74) | Explicit v4 folder selection already provisionally exists; verify v4 MANIFEST integrity and admission behavior in later steps. |
| Legacy workflow concurrency | `.github/workflows/lite-solo-phase-controller-v1.yml` (~10–12) | Campaign-global `lite-solo-phase-boundary-controller` group; should not be relied upon for v4 Phases 4–6. User requests retiring superseded ingress after v4 is safe. |
| v4 workflow concurrency | `.github/workflows/lite-solo-unit-controller-v1.yml` (~53–55) | Existing per-campaign `lite-solo-unit-${{ matrix.campaign }}` group and no cancel-in-progress. A durable backlog and recompute-on-conflict still require verification. |
| V7 Phase-5 preflight | `scripts/lite-phase5-preflight-v1.mjs`; `scripts/lib/lite-solo-phase-prefill-v1.mjs` (~1027); `scripts/lite-solo-phase-controller-v1.mjs`; `.github/workflows/lite-solo-unit-controller-v1.yml` (~102–110); `.github/workflows/lite-solo-phase-controller-v1.yml` (~124–132) | Source-bound executable request/harness binding and Anvil archive-fork evidence remain mandatory at final seal; do not start redundant machine execution per unit submission. |
| V7 dispatch | `.github/workflows/lite-v7-execution-dispatch-v1.yml`; `packages/github-native-sim/src/v7-cli.mjs` | Existing machine execution lane, identity and execution evidence; avoid introducing a duplicate test runner. |
| Phase-6 execution budgets | `Audit-Controller/.../lite-solo-v3/phases/phase-6/START_HERE.md` (~35, 39); `shared/execution/AGENT_GUIDED_TESTING.md` in bound authority; `packages/github-native-sim/src/phase6-execution-preflight-v1.mjs` | Explicit existing three-round maximum for baseline and candidate testing, shared by obligation/target rather than reset per worker. |
| Singular aggregate path | `scripts/lib/lite-solo-phase-work-v1.mjs:preparePhaseWork`; `scripts/lib/lite-solo-work-shards-v1.mjs`; `scripts/lite-solo-phase-controller-v1.mjs` | Preserve final aggregate semantic gate, but stop worker edits of shared phase shards in v4. |
| Current v4 provisional files | `scripts/lib/lite-solo-unit-queue-v1.mjs`, `scripts/lite-solo-unit-request-drain-v1.mjs`, `.github/workflows/lite-solo-unit-controller-v1.yml` | Present but not validated; audit per sequential steps for owner collisions, append slots, machine dependencies, request retries, and exact once seal. |

## 0.3 — Final dispatch rule (updated explicit user instruction)

1. New Lite-Solo campaigns may bind only to the **valid committed v4 manifest** when Step 21's activation prerequisites are complete; the v4 controller accepts only campaign-bound generation/source/authority.
2. v4 Phases 4–6: immutable `process/agent-upload/lite-solo-unit-requests/...` -> per-campaign drainer -> controller unit validation -> final aggregate seal after accepted dependencies. Other phases retain the necessary receipt controller; no worker may submit v4 phases 4–6 via old shared phase boundary.
3. Historical v3 campaign source, authority and accepted evidence are **read-only**. No in-place rebind or migration. No active migration work is required, per user's explicit statement of zero active campaigns.
4. Remove/disable obsolete *operational* v3 discovery, one-chat instructions, and legacy Phase 4–6 request routes where safe; do not delete historical receipts, recorded evidence, or the v3 authority package merely to eliminate an old route. Never leave two active worker instructions for the same new campaign.

## 0.4 — Ordered repository edit/create manifest

This list is an *ordered work plan*, not evidence that an existing implementation is correct. Before each numbered step, inspect the latest version of the named file because another commit may have intervened. If a listed file is already present, review or correct it instead of duplicating it.

| Step | Repository | Files planned (create/edit/review as appropriate) |
| --- | --- | --- |
| 0 | Contract-Automation | `docs/lite-solo/Lite_Solo_Parallel_Implementation_Step_00_Inventory_v1.md` (this source-only inventory) |
| 1–3 | Contract-Automation | `scripts/lib/lite-solo-unit-queue-v1.mjs`; `packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs`; relevant unit policy/schema and packet index source; avoid competing constants. |
| 4–5 | Contract-Automation | `packages/github-native-sim/src/adr-lite-solo-discovery-v1.mjs`; `packages/github-native-sim/src/adr-discovery-validators-v1.mjs` (reuse, not weaken); `scripts/lib/lite-solo-phase-prefill-v1.mjs`; `scripts/lib/lite-solo-work-shards-v1.mjs`; `scripts/lib/lite-solo-unit-queue-v1.mjs`. |
| 6–8 | Contract-Automation | `scripts/lib/lite-solo-unit-queue-v1.mjs`; `scripts/lib/lite-solo-phase-prefill-v1.mjs`; `scripts/lib/lite-solo-work-shards-v1.mjs`; `scripts/lite-phase5-preflight-v1.mjs`; `packages/github-native-sim/src/phase6-execution-preflight-v1.mjs`; existing V7 dispatch/qualification integration. |
| 9–11 | Contract-Automation | `scripts/lib/lite-solo-unit-queue-v1.mjs`; `scripts/lite-solo-phase-controller-v1.mjs`; `scripts/lib/lite-solo-phase-work-v1.mjs`; `scripts/lib/lite-solo-work-shards-v1.mjs`; `scripts/lib/lite-boundary-result-v1.mjs` (reuse). |
| 12–15 | Contract-Automation | `process/agent-upload/lite-solo-unit-requests/` (immutable request files at runtime); `scripts/lite-solo-unit-request-drain-v1.mjs`; `.github/workflows/lite-solo-unit-controller-v1.yml`; `scripts/lib/lite-solo-unit-queue-v1.mjs`; `.github/workflows/lite-solo-phase-controller-v1.yml` as needed to retire obsolete operational route. |
| 16 | Audit-Controller | `Audit Skill - Lite-Solo Authority/lite-solo-v4/SKILL.md`, `phases/phase-{4,5,6}/START_HERE.md`, all referenced `discovery/*` and `shared/controller/*` guides requiring correction; necessary `PHASE_CONTRACT.json`/schema references; `MANIFEST.json`; `PACKAGE_PROVENANCE.md` and package links. **Never edit any v3 path.** |
| 17 | Contract-Automation | `scripts/lite-solo-source-initialization/run-v1.sh`; `scripts/lite-solo-source-initialization/write-phase0-receipt-v1.py`; `scripts/lite-solo-phase0-finalize-v1.mjs`; `scripts/lib/lite-solo-lineup-v1.mjs`; `scripts/lite-solo-phase-controller-v1.mjs`; `scripts/lib/lite-solo-unit-queue-v1.mjs`. |
| 18 | Both | No active campaign migration authorized or needed; retain frozen legacy evidence and do not add an unused migration route. |
| 19 | Audit-Controller + Contract-Automation | v4 worker guides, submission protocol, packet `readingGuide` and controller status envelope; retire obsolete worker routing only after binding/receipt safety is checked. |
| 20 | Both | Source-only review against 30 scenario contracts; **no acceptance-test creation, edits, or execution**. |
| 21 | Both | Final operational v4 activation check, manifests/admission, final implementation report and precise commit/provenance references. |

## Step-00 close-out / unchanged-file rule

- Inspected v3 `SKILL.md`, all nine Phase-4/5/6 guides/contracts/schemas, the v3 manifest, the discovery scheduler, phase controller, prefill, shard implementation, existing workflows and admission/receipt source.
- Recorded the immutable v3 manifest SHA-256, Git blob and manifest file count; historical v3 paths are expressly **READ-ONLY**.
- Identified the known hard-coded single-worker assumptions, legacy eight-unit discovery paths, workflow concurrency, authority release registries, currentAssignment/shard/discovery/result paths, V7 preflight and Phase-6 round constraints.
- Chosen and documented a *single v4 operational route* subject to later-step validation, with no historical campaign mutation.
- **No tests were created, changed or executed. No code modules or bound authority packages were modified by this step.**
