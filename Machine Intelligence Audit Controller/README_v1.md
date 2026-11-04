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

## Isolation

- This fork is **not** the production automation branch. Original `main` workflows remain intact and continue to own active campaigns.
- Do not run `workflow_dispatch`, modify `main` trigger workfiles, or call the live Cloudflare Worker from this development branch.
- This fork has *source code*, not a new GitHub repository, new GitHub secret set, independent R2 storage, Durable Object state, or a deployed Cloudflare script.
- A future isolated runtime must rebind the fork's repository names, Worker URL, GitHub permissions, encrypted credentials, durable state and default-branch triggers before any execution.
- No tests have been added or executed.

**Status: SOURCE FORK ONLY (v1); no production behavior changed.**
