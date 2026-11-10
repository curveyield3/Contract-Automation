# Machine Intelligence Audit Controller — Automation Source Fork v1

This branch is the **full, isolated Git-tree source fork** of `curveyield3/Contract-Automation` for the Machine Intelligence Audit Controller project. It preserves every tracked file at the immutable pre-fork commit `774bc6b6e5d80400578d21aac8cdd5f67e6a703c`, not merely a small selected workflow subset.

## Paired controller source

- Private controller fork: `curveyield3/Audit-Controller` branch `machine-intelligence-audit-controller-v1`.
- Original controller baseline commit: `d6164f1dd8fb0210310e0697c3395a63e811054a`.
- Frozen native Worker source and the overall fork instructions: private controller branch path `Machine Intelligence Audit Controller/worker/lite-solo-api-source-v1.mjs` and `Machine Intelligence Audit Controller/README_v1.md`.
- MiMo authority is original `Audit Skill - Lite-Solo Authority/lite-solo-v6/` (148 files) in the controller fork.

## What this automation fork contains

**Everything** at the source commit, including all `.github/workflows/` (**112 tracked YAML files**, of which 13 are specifically named `lite-solo-*`), all `.github/actions/` composite action contents (10 tracked files), `scripts/` (19 `lite-solo*` script files), all the nested `scripts/lite-solo-ai/` adapter files, phase 0 source intake, phase-boundary and unit controller code, fork machinery, correction process, receipt handling, `process/` workfile dispatch triggers, and related packages/docs/protocols.

Key live counterparts retained in the fork for development: `.github/workflows/lite-solo-ai-inference-v1.yml`, `scripts/lite-solo-ai/campaign-v1.mjs`, `.github/workflows/lite-solo-cloudflare-fork-v1.yml`, `.github/workflows/lite-solo-phase-controller-v1.yml`, `scripts/lite-solo-phase-controller-v1.mjs`, `.github/workflows/lite-solo-audit-correction-v1.yml`, `scripts/lite-solo-audit-correction/`, and `.github/actions/`.

## Development status and execution hold — implementation update

**NOT RUNNABLE / NOT READY TO DEPLOY.** This source-only fork retains all original phase packaging, report generation, source acquisition, and receipt creation. Selected GitHub-side semantic/coverage/deployment assessments now emit diagnostics rather than freeze campaign progress; physical source, record transport, and branch identity requirements remain. This is a development implementation, **not evidence that the independent Worker has validated an audit**.

Fork-only changes to active paths:
- Isolated the Phase-boundary, parallel-unit, source-initialization, Cloudflare Phase-0, and MiMo inference entrypoints from `main` so they read/write/dispatch the matching `machine-intelligence-audit-controller-v1` branches.
- Stopped aggregate semantic deficiencies from setting GitHub `NEEDS_REWORK` and stopped unit-finalization from persisting GitHub `BLOCKED`; accepted Worker-supplied unit evidence is retained for retry.
- Preserved actual deployment and Slither failures as diagnostics and limitations; incomplete evidence is **not** synthesized into a successful machine execution.
- Rebound Cloudflare fork callbacks and MiMo bridge to `MACHINE_INTELLIGENCE_WORKER_URL`, and fork callbacks to `MACHINE_INTELLIGENCE_FORK_TOKEN`. Production Worker routes must not be used.
- Restored the damaged Phase-5 source packaging and downstream metadata after an incorrect early edit. Obsolete V7 request-resolution and GitHub quality-verdict paths were subsequently retired; preserve raw Worker-submitted target descriptions.
- Removed remaining Phase-5 human-approval vetoes from the fork phase-boundary workflow; source-bound Phase-5 prefill identity and targeted-matrix packaging remain, but obsolete V7 execution-request generation is not an active prerequisite.
- Retired legacy aggregate-unit rework mutations, dead shard/coverage/evidence validation routines, and unnecessary GitHub test-toolchain setup steps; quality findings remain the Worker's responsibility.
- Allowed Phase-4 unit plans with actual source-bound units to proceed even when the inventory contains quality-gap indicators; the Worker still needs to supply real units where none exist.
- Preserved exact source/archive and original-evidence SHA-256 binding checks as physical provenance protections, rather than allowing mismatched bytes to be sealed.

Workflow/action deep-sweep findings (fork source only):
- Both `.github/actions/setup-phase0-node-cache/action.yml` and `.github/actions/setup-no-telemetry-node-cache/action.yml` retain required pinned Forge/Anvil checks, but secondary `npm ls` dependency-tree diagnostics no longer abort the audit.
- Both Lite-Solo Phase-0 intelligence workflows use the pinned Forge executable plus pinned Slither, **not** the obsolete V7/Medusa setup action. Analyzer installation/generation failures are retained for Worker assessment; only genuine source-bound artifacts can be published.
- Both Lite-Solo Phase-0 bootstrap workflows now allow failed native deployment attempts to reach evidence retention/Worker review, while retaining missing-file, source SHA, RPC chain, and authenticated publication guards.
- Dormant `lite-phase-*`, `audit-preview-*`, and V7 legacy workflows contain numerous additional GitHub validation and `main` routing checks; most use `main`-only triggers or explicit manual dispatch and are NOT part of the active MiMo fork pipeline. Do not route new fork execution into them unchanged.
- **Legacy V7 is deliberately out of scope.** The copied Worker source still references a nonexistent V7-dispatch workflow, and partial historical V7 fork edits do not establish a safe, operational execution lane. Do not invoke those routes or treat V7 as a Machine Intelligence prerequisite. No further V7 modernization is planned in this sweep.
- MiMo autonomous inference now asks the Worker to claim work directly rather than aborting from an independently sampled GitHub foreign-lease count; authoritative Worker lease responses still apply.
- The existing V7 qualification record is bound to runner commit `03bf8379525d3a94729347aa3224fe48bddc8921` (October 11, 2026). Comparing that legacy runner against this fork exceeds the GitHub compare endpoint's 300-file listing; a clean fork-specific V7 qualification cannot be assumed, and routing through its existing production dispatcher is unsafe.
- The unused Phase-5 preflight workflow steps and retry-time reruns were removed from both active phase/unit workflows; actual accepted unit files and receipts still govern physical packaging.
- The legacy GitHub human-checkbox check in MiMo `campaign` mode was removed; Worker authorization and source/phase/step binding remain mandatory.
- Source-initialization file triggers now admit either a ZIP or verified explorer scans, matching existing initializer support; never both.
- The Cloudflare fork adapter uses structural Phase-0/Phase-10 receipts rather than GitHub content-quality `PASS` as a sealing prerequisite, and the Phase-0 finalizer can recover a prior `BLOCKED` receipt when real evidence exists.
- The shared Lite-Solo checkout helper and phase-controller CLI reject controller refs other than `machine-intelligence-audit-controller-v1`.
- No new workflows, actions, or tests were created or executed.

Post-sweep repository repairs:
- The phase-boundary workflow now routes v4, v5, and v6 Phases 4–6 through the parallel-unit controller; old GitHub `BLOCKED` assignment states no longer veto Worker-resumed phases, while explicit `STOPPED_BY_HUMAN` remains enforceable.
- The phase-boundary workflow now treats failed PDF delivery as a failed delivery step, but records the already-sealed controller result independently; a receipt alone is not proof that a PDF was delivered.
- Both Phase-0 intelligence workflows retain only top-level JSON evidence on generation failure. They expressly exclude the working repository checkout and hidden Git metadata from Actions artifacts.
- Phase 4/6/8 derived-quality projections and optional final-report formatting can retain typed unresolved diagnostics rather than crash the controller after semantic validation was delegated. Canonical Worker-submitted files remain preserved.
- Source-bound Phase bookkeeping now rejects domain-registry paths escaping the campaign directory; this is a provenance safeguard, not an audit-quality veto.
- The parallel Cloudflare-fork workflow still contains an unreachable Phase-10 delivery helper and duplicate report/callback steps; actual Phase 10 delivery belongs to the semantic phase-boundary workflow. The attempted dead-code removal was blocked by the platform; no alternate path was created.
- Further attempted edits to the shared phase-report wording and some legacy input-projection handlers were blocked by tool safety checks. These changes are **not** claimed complete. Receipt compatibility `PASS` is still not Worker semantic acceptance.

Remaining execution hold:
- An independent, configured, deployed Machine Intelligence Worker (and GitHub credentials, Durable Object, R2 isolation) **does not yet exist in this fork**. Its source snapshot is in the companion Audit-Controller branch.
- Legacy fallback/controller-core paths and non-active general-purpose workflows have not been proven universally nonblocking. Physical missing-file, source identity, lease/claim, and safe-publication failures remain deliberately enforceable.
- No tests or audit campaigns were run as part of this work. No end-to-end functional acceptance or Worker receipt was obtained.
- Do not execute this fork or attach production credentials until the independent Worker path and actual evidence/report preservation are verified.

The originals are unchanged on their `main` branches.

## Isolation

- This fork is **not** the production automation branch. Original `main` workflows remain intact and continue to own active campaigns.
- Do not run `workflow_dispatch`, modify `main` trigger workfiles, or call the live Cloudflare Worker from this development branch.
- This fork has *source code*, not a new GitHub repository, new GitHub secret set, independent R2 storage, Durable Object state, or a deployed Cloudflare script.
- A future isolated runtime must rebind the fork's repository names, Worker URL, GitHub permissions, encrypted credentials, durable state and default-branch triggers before any execution.
- No tests have been added or executed.

**Status: SOURCE FORK ONLY (v1); no production behavior changed.**

## Final fork-isolation and post-sweep repair — 2026-11-04

This source-only Machine Intelligence fork was inspected and repaired without accessing, changing, dispatching, or deploying either repository's original `main` branch. Neither tests nor audit workflows were initiated in this repair round.

- Removed the unreachable duplicate Phase-10 PDF/callback block from the Cloudflare fork workflow; canonical Phase-10 publication remains with the semantic phase-boundary workflow.
- Allowed the MiMo inference runner to attempt the Worker's abandoned-lease recovery instead of halting on a sampled foreign-lease count. Active foreign claims still cannot be forcibly overwritten.
- Changed the fork-check source checkout to the matching Audit-Controller fork.
- Disabled the inherited browser/agent delivery, audit-preview, legacy receipt/phase controller, V7, original-branch authority sync, and other main-bound workflow job entrypoints in this fork. These are not the active Lite-Solo Machine Intelligence controller lanes.
- Added explicit fork-only transport guidance to each root `AGENTS.md`. The original v6 authority bytes and hash-bound receipts are deliberately unchanged; obsolete original-main routing text in frozen v6 SKILL is not authorized for this fork.
- Updated the Worker source to read the branch-current fork isolation policy while retaining the pinned source-bound skill and phase guide.
- Retired two references to a nonexistent V7 proof-execution workflow. Proof requests remain published and explicitly marked `MACHINE_EXECUTION_NOT_CONFIGURED`, not PASS; no fictitious execution rounds are consumed.

**Verification limit:** All repairs were source- and branch-scoped. The independently configured Machine Intelligence Worker and a fork-native machine-evidence executor have not been deployed or runtime-tested here, so fork runtime acceptance and production-readiness are **not certified**. Missing machine evidence must remain unresolved until a separately authorized fork-native execution facility exists. Retired V7 functionality was not modernized or restarted.
