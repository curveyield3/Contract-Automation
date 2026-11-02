# Lite-Solo MiMo AI Agent — GitHub Actions Operations (v3)

**Revision:** v3 | **Installed:** November 2, 2026
**Repository:** curveyield3/Contract-Automation
**Worker:** lite-solo-api deployed v10.55; controller remains authoritative
**Workflow:** .github/workflows/lite-solo-ai-inference-v1.yml

## Manual operation

The existing workflow supports two manual modes. In **public**, select a committed public Solidity/Vyper path; the read-only inference draft is downloadable. In **campaign**, enter the exact campaign_id with -rN, expected_phase and expected_step; set operator_authorized_step=true only when the human has approved that numbered step. Select submission_mode=draft (no Worker submission) or submit (first-round, independent five-question review, required repair acknowledgment, then Worker controller processing). The max_chunks input is 1–32 (default 12).

GitHub Actions signs a short-lived OIDC identity using audience urn:curveyield:lite-solo:github-actions-ai:v1; the adapter refreshes it for each Worker call. The Worker validates GitHub RS256 signature, issuer, audience, repository/owner numeric IDs, exact workflow path on main, hosted-runner status, workflow_dispatch trigger, subject and expiry. This role cannot call admin, fork, or recovery endpoints.

Campaign mode chooses only the current assigned step, verifies Worker source and authority identities against the campaign directory and sealed Phase 0 receipt using the established private controller sparse checkout, collects source-bound Solidity/Vyper files, and refuses to claim work when full evidence exceeds its bounded context. It uses only the existing /api/step/current and /api/step/process claim/submit/release APIs plus current instruction and review interaction forms. Unused packet siblings are released. No next numbered step begins automatically.

Private campaign source and output are NEVER uploaded as public GitHub artifacts. The workflow reuses established private controller credential selection. No new controller, lease registry, phase transition, or machine-execution lane was created.

## Current capability boundaries

The adapter refuses to submit when it cannot supply the complete bound instruction, source, input template or review material within its bounded model context. GPU fine-tuning and full-project-scale context/retrieval remain separate tasks.

- The MiMo Q4 9B checkpoint is **not yet fine-tuned** for Lite-Solo and has not been demonstrated to match a senior security auditor.
- The unmeasured 8,192-token inference context on a 16 GB CPU runner may be inadequate for large step authorities or entire projects. Insufficient evidence must block submission, not permit fabricated coverage.
- Exact authority/skill step-ending human authorization rules remain in force; explicit per-step operator consent is required.
- The Worker may require an immutable first round and independent Q1–Q5 review plus repair checklist. A real repair blocks automatic final submission; unresolved multi-run review recovery is not fully automated.
- A green GitHub Action or Worker-local unit status is never proof of controller acceptance or phase sealing.
- No testing, simulated exploit, benchmark, or source-bound machine verification was executed while installing this integration.
- No campaign was claimed, modified, submitted, or advanced as part of installation.

## To operate

1. Open https://github.com/curveyield3/Contract-Automation/actions/workflows/lite-solo-ai-inference-v1.yml
2. Run the workflow on main, select campaign, and fill exact current campaign ID, phase, step, and explicit operator authorization. Start in draft mode for evaluation of the interface.
3. The model is downloaded outside Git history and verified against Q4_K_M SHA-256: 4bca6f18c73f72270c7a20c2ea2bea581de8246e318714277120369d34048c81.
4. Follow the actual Worker status and private controller acceptance; do not rely on a green Actions run.
5. Resolve any source, claim, approval, review, machine-evidence or controller deficiencies by the existing diagnose-repair-retry-verify-continue process without modifying accepted records.

## Existing implementation

- AI public-source runner: scripts/lite-solo-ai/review-v1.mjs
- AI authenticated campaign adapter: scripts/lite-solo-ai/campaign-v1.mjs
- Manually dispatched workflow: .github/workflows/lite-solo-ai-inference-v1.yml
- Current campaign-bound authority: private Audit-Controller / Audit Skill - Lite-Solo Authority / lite-solo-v5 / SKILL.md (only for campaigns actually bound to v5)

**Status:** OIDC Worker deployed and GitHub code committed. No live Actions run or campaign audit executed. An actual end-to-end run remains unverified without separately authorized execution.
