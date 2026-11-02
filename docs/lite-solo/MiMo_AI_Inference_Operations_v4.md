# Lite-Solo MiMo AI Auditor — Autonomous Beta Operations (v6)

**Revision:** v6 (canonical v4 file path retained for existing references)  
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

## AI-v6 approval waits removed; educational review preserved

The AI-v6 `SKILL.md` and numbered-step `START_HERE.md` guides are separately bound to autonomous AI-only campaigns. Human stop/continue authorization is removed for that mode only. Legacy v5 operator approvals remain intact.

Worker v10.63 enables the established three-part engagement for GitHub OIDC AI sessions. For each eligible numbered step, the AI reads the complete source-bound instructions and answers the three exact instruction-verification questions before claiming work. Its initial work submission is retained as immutable first-round evidence, **not** controller acceptance. The Worker issues five original review questions, collects source-grounded answers and every material repair obligation, returns the canonical checkbox form, and requires each repair to be assessed with evidence-supported disposition before final revised work is submitted through the unchanged controller mechanism.

Revised JSON must preserve controller-assigned identities and include an edit/repair-coverage manifest when bytes change. Controller receipts remain the only source of accepted/sealed status. The MiMo 8K context can prevent completion of large steps; an unfinished review or model output is never a PASS. Autonomous jobs now have a 355-minute GitHub cap with a controller-safe source-analysis checkpoint and a 5h45 latest handoff target; v5/manual and public modes retain their 100-minute cap.

The actual inference/review loop uses the existing `scripts/lite-solo-ai/campaign-v1.mjs` adapter and `.github/workflows/lite-solo-ai-inference-v1.yml` workflow; no duplicate GitHub process is required.

## Safety and authoritative boundaries preserved

- The controller, never MiMo, owns source admission, frozen authority and manifest, assignment eligibility, exclusive unit leases, schema validation, independent machine evidence checks, accepted packet snapshots, sealed receipts and final PASS.
- Controller `SUBMITTED` or Worker-local `UNIT_ACCEPTED_LOCALLY` are not a controller PASS.
- No tests or exploit evidence may be fabricated; all required execution is in the existing qualified workflow and only when the exact campaign authorizes it.
- Existing v5 campaigns and their saved review acknowledgements remain unchanged; AI-v6 is opt-in for **new** admitted campaigns.
- GitHub-hosted OIDC JWT is scoped to exact organization, repository ID, branch, manual dispatch and job. No administrator, fork callback or long-lived agent secret is given to model inference.
- Private source/evidence never goes to public GitHub Actions artifacts.
- Same GitHub workflow/model/runtime is reused; no extra AI controller or duplicate model orchestration repository.
- The workflow uses the existing `actions:write` permission only for bounded continuation dispatches. It is single-flight per campaign, does not trigger from commits and caps direct chained continuation at 120 hops.

## Bounded 5h45 continuation and durable checkpoints (v6)

The existing AI workflow is unchanged in identity/path but its autonomous GitHub-hosted job timeout is now 355 minutes (GitHub's hosted runner hard ceiling is six hours). The job records startup time before checkout. The MiMo adapter counts 345 minutes from that startup; it reserves five minutes around raw source inference and 25 minutes before claiming a new controller unit so a continuation can be dispatched before the hard stop. The run may therefore hand off before 5h45 if a new long operation is not safe to begin. The controller remains the only accepted/sealed audit authority.

After each completed source-analysis chunk, the adapter persists a bounded JSON checkpoint in the existing Cloudflare SOURCE_ZIPS R2 bucket through the new authenticated `/api/ai/checkpoint` API. Only signed GitHub AI identities for an autonomous campaign can read/save it. The Worker verifies the exact campaign generation, active phase/step, frozen source SHA-256 and authority digest. Every source-file SHA and line interval must match the new runner's fresh receipt-bound checkout before the saved summaries can be reused. Checkpoint writes may append findings but never silently alter earlier source analyses.

When the current source review approaches its time budget **before any unit lease is taken**, the adapter requests a new run of `lite-solo-ai-inference-v1.yml` using the existing `autonomous` mode, the **same campaign ID**, expected phase/step, and incremented finite hop counter. GitHub's existing campaign-keyed concurrency serializes this handoff. The next runner retrieves the private checkpoint and continues at the next unreviewed source chunk before claiming the next controller-issued unit. The Worker preserves acknowledged instructions, completed controller units, immutable first-round evidence, accepted filings and actual receipts separately from these preparatory checkpoint drafts.

This is a **cooperative safe-boundary** rollover, not a promise to suspend a model mid-token, transfer an active controller lease, or bypass review/repair acknowledgments. If GitHub unexpectedly terminates a job after a claim but before controller processing finishes, its already-persisted controller/engagement state remains authoritative; any open lease or incomplete interaction must be recovered through the existing authorized Worker process. The source chunk checkpoint does not itself imply controller acceptance and never overrides an actual lease.

New changes apply to new runs checking out updated `main`; already executing GitHub jobs retain their original startup SHA, timeouts, and code.

## Current free-beta limitations

- This is **not fine-tuned MiMo**; it has not demonstrated senior-auditor quality.
- 16 GB CPU, no GPU; 355-minute autonomous job limit (100-minute public/v5 limit), Q4 MiMo 9B, 8K context. Cooperative checkpointing preserves completed source chunks but does not snapshot MiMo's in-flight token generation or controller leases. Loading and generating dozens of investigations may exceed the time budget.
- Full raw source coverage is capped at 32 line-overlapping chunks, 256 Solidity/Vyper files and 256 KiB per source file; if coverage cannot fit, the adapter stops **before claiming** instead of inventing a full audit.
- Each invocation currently generates at most one complete controller unit; an eligible successor is dispatched as a separate GitHub job. This is a beta mechanism, not guaranteed full-campaign throughput.
- If there is missing machine-execution evidence, unresolved structural rework, no approved source snapshot, timeout, or the model cannot satisfy the exact current form and instructions, the agent must report the real blocked state and **must not** claim phase completion.
- AI-v6 Phase 0 has been observed sealed for `cyvbusdcv28-r3`; the complete MiMo audit and its new time-bound handoff path are not yet end-to-end verified. Do not assume that workflow dispatch or an R2 checkpoint equals controller acceptance.

## Evidence to inspect

- Exact Actions jobs, logs and SHA: https://github.com/curveyield3/Contract-Automation/actions/workflows/lite-solo-ai-inference-v1.yml
- AI adapter: https://github.com/curveyield3/Contract-Automation/blob/main/scripts/lite-solo-ai/campaign-v1.mjs
- AI authority: https://github.com/curveyield3/Audit-Controller/tree/main/Audit%20Skill%20-%20Lite-Solo%20Authority/lite-solo-v6
- Current campaign Controller directory and Phase0/phase receipts: use the private original controller, not workflow-success status.
- The previous public-only and v5-manual modes remain available through the same existing workflow.
