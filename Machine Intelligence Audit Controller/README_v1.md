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
- Restored Phase-5 request resolution and downstream metadata after an incorrect early edit, then separated optional quality diagnostics from the essential packaging path.
- Removed remaining Phase-5 human-approval vetoes from the fork phase-boundary workflow; Phase-5 request materialization and prefill metadata remain intact.
- Retired legacy aggregate-unit rework mutations, dead shard/coverage/evidence validation routines, and unnecessary GitHub test-toolchain setup steps; quality findings remain the Worker's responsibility.
- Allowed Phase-4 unit plans with actual source-bound units to proceed even when the inventory contains quality-gap indicators; the Worker still needs to supply real units where none exist.
- Preserved exact source/archive and original-evidence SHA-256 binding checks as physical provenance protections, rather than allowing mismatched bytes to be sealed.

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
