# Lite-Solo MiMo AI Auditor — Autonomous Beta Operations (v4)

**Revision:** v4  
**Installed November 2, 2026**  
**Repository:** curveyield3/Contract-Automation  
**AI-only frozen authority:** curveyield3/Audit-Controller, `Audit Skill - Lite-Solo Authority/lite-solo-v6/`  
**Legacy authority:** lite-solo-v5 — **untouched**, including its original human gates  
**Workflow:** `.github/workflows/lite-solo-ai-inference-v1.yml` (existing, extended)  
**Cloudflare Worker:** `lite-solo-api` (new AI-v6 routing, OIDC authentication and controller-eligible continuation)

## One-time startup

1. Open https://github.com/curveyield3/Contract-Automation/actions/workflows/lite-solo-ai-inference-v1.yml
2. Choose **Run workflow**, branch **main**, `mode=autonomous_start`.
3. Provide `source_url` as an existing HTTPS *ZIP* source package compatible with the established Lite-Solo source initializer. Do not provide a Solidity text-file URL or pretend a repository branch URL is a source ZIP.
4. Leave `ai_hop=0`; the workflow mints GitHub-signed, short-lived OIDC identity and calls the established Worker start endpoint with `aiAutonomous=true`.
5. The Worker admits a new campaign explicitly bound to Lite-Solo **v6**, dispatches the existing Phase0 initialization/verification and waits for the **actual sealed PASS** receipt.
6. After the Worker verifies an ACTIVE controller-issued next step or eligible packet wave, it dispatches the **same** AI workflow in `autonomous` mode, with exact campaign, phase and step. No subsequent human approval prompt is introduced in v6.

**Do not run `autonomous` manually for a v5 campaign:** GitHub OIDC and the Worker reject a v5 identity in that mode. Existing v5 `campaign` mode retains its previous step-level human gate.

## AI v6 gates removed

The AI-v6 `SKILL.md` and all numbered-step `START_HERE.md` guides were cloned from the full v5 authority and updated to remove human step-end stop/continue instructions while preserving substantive analysis. No human instruction-verification questions, first-round review question form or per-packet repair-checkbox gates are imposed on an AI-v6 session.

The AI **still** self-reviews for maximum source-grounded depth, records full substantive results in existing campaign artifacts, and resolves actual controller-required rework.

## Safety and authoritative boundaries preserved

- The controller, never MiMo, owns source admission, frozen authority and manifest, assignment eligibility, exclusive unit leases, schema validation, independent machine evidence checks, accepted packet snapshots, sealed receipts and final PASS.
- Controller `SUBMITTED` or Worker-local `UNIT_ACCEPTED_LOCALLY` are not a controller PASS.
- No tests or exploit evidence may be fabricated; all required execution is in the existing qualified workflow and only when the exact campaign authorizes it.
- Existing v5 campaigns and their saved review acknowledgements remain unchanged; AI-v6 is opt-in for **new** admitted campaigns.
- GitHub-hosted OIDC JWT is scoped to exact organization, repository ID, branch, manual dispatch and job. No administrator, fork callback or long-lived agent secret is given to model inference.
- Private source/evidence never goes to public GitHub Actions artifacts.
- Same GitHub workflow/model/runtime is reused; no extra AI controller or duplicate model orchestration repository.
- The workflow uses the existing `actions:write` permission only for bounded continuation dispatches. It is single-flight per campaign, does not trigger from commits and caps direct chained continuation at 120 hops.

## Current free-beta limitations

- This is **not fine-tuned MiMo**; it has not demonstrated senior-auditor quality.
- 16 GB CPU, no GPU; 100-minute per-job budget, Q4 MiMo 9B, 8K context. Loading and generating dozens of investigations may exceed the time budget.
- Full raw source coverage is capped at 32 line-overlapping chunks, 256 Solidity/Vyper files and 256 KiB per source file; if coverage cannot fit, the adapter stops **before claiming** instead of inventing a full audit.
- Each invocation currently generates at most one complete controller unit; an eligible successor is dispatched as a separate GitHub job. This is a beta mechanism, not guaranteed full-campaign throughput.
- If there is missing machine-execution evidence, unresolved structural rework, no approved source snapshot, timeout, or the model cannot satisfy the exact current form and instructions, the agent must report the real blocked state and **must not** claim phase completion.
- Newly admitted autonomous campaigns are not verified by a live end-to-end Actions run yet. Do not assume that a workflow installed or dispatched equals controller acceptance.

## Evidence to inspect

- Exact Actions jobs, logs and SHA: https://github.com/curveyield3/Contract-Automation/actions/workflows/lite-solo-ai-inference-v1.yml
- AI adapter: https://github.com/curveyield3/Contract-Automation/blob/main/scripts/lite-solo-ai/campaign-v1.mjs
- AI authority: https://github.com/curveyield3/Audit-Controller/tree/main/Audit%20Skill%20-%20Lite-Solo%20Authority/lite-solo-v6
- Current campaign Controller directory and Phase0/phase receipts: use the private original controller, not workflow-success status.
- The previous public-only and v5-manual modes remain available through the same existing workflow.
