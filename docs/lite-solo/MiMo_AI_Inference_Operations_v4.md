# Lite-Solo MiMo AI Auditor — Autonomous Beta Operations (v10)

**Revision:** v10 (canonical v4 file path retained for existing references)  
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

The existing AI workflow is unchanged in identity/path but its autonomous GitHub-hosted job timeout is now 355 minutes (GitHub's hosted runner hard ceiling is six hours). The job records startup time before checkout. The MiMo adapter counts 345 minutes from that startup; it reserves 45 minutes around each instruction/source inference (each CPU request has a 30-minute timeout) and 120 minutes before claiming a new controller unit so a continuation can be dispatched before the hard stop. The run may therefore hand off before 5h45 if a new long operation is not safe to begin. The controller remains the only accepted/sealed audit authority.

After each completed source-analysis chunk, the adapter persists a bounded JSON checkpoint in the existing Cloudflare SOURCE_ZIPS R2 bucket through the new authenticated `/api/ai/checkpoint` API. Only signed GitHub AI identities for an autonomous campaign can read/save it. The Worker verifies the exact campaign generation, active phase/step, frozen source SHA-256 and authority digest. Every source-file SHA and line interval must match the new runner's fresh receipt-bound checkout before the saved summaries can be reused. Checkpoint writes may append findings but never silently alter earlier source analyses.

When the current source review approaches its time budget **before any unit lease is taken**, the adapter requests a new run of `lite-solo-ai-inference-v1.yml` using the existing `autonomous` mode, the **same campaign ID**, expected phase/step, and incremented finite hop counter. GitHub's existing campaign-keyed concurrency serializes this handoff. The next runner retrieves the private checkpoint and continues at the next unreviewed source chunk before claiming the next controller-issued unit. The Worker preserves acknowledged instructions, completed controller units, immutable first-round evidence, accepted filings and actual receipts separately from these preparatory checkpoint drafts.

This is a **cooperative safe-boundary** rollover, not a promise to suspend a model mid-token, transfer an active controller lease, or bypass review/repair acknowledgments. If GitHub unexpectedly terminates a job after a claim but before controller processing finishes, its already-persisted controller/engagement state remains authoritative; any open lease or incomplete interaction must be recovered through the existing authorized Worker process. The source chunk checkpoint does not itself imply controller acceptance and never overrides an actual lease.

New changes apply to new runs checking out updated `main`; already executing GitHub jobs retain their original startup SHA, timeouts, and code. The pre-upgrade `cyvbusdcv28-r3` runner #41473538131 stopped before its first instruction acknowledgement because the old four-minute local model request timed out. Version v3 of the canonical adapter increases the request limit to 20 minutes; that failed old-SHA run does not recover automatically merely from deploying these updates.

## Instruction-stage checkpoint and long-running CPU inference (v8)

The existing private R2 checkpoint now records finished authoritative instruction-reading segments as well as source-analysis chunks. Each instruction segment is bound to its original source digest, and the next GitHub runner must independently verify that its original instructions have not changed before reusing any saved notes. This works before Q1–Q3 are acknowledged and does not acknowledge, claim, submit, or seal any controller work by itself.

An autonomous runner now permits up to 30 minutes for each local MiMo inference request instead of the old four- or 20-minute limit. It checks the handoff budget before each costly instruction/source inference, with 45 minutes of reserve, and reserves two hours before claiming controller work. It can end and dispatch the exact same campaign/step early when needed; it does not stop a controller submission mid-lease. The existing six-hour GitHub limit remains a **per-run** cap; the campaign's total lifetime is not capped by one run.

No new test suites or alternative controller workflow were added. The actual end-to-end checkpoint/rollover has not yet been verified on a live runner; the controller's persisted state remains authoritative.

## Per-run source scope and chunk checkpoints (v9)

The source ZIP in `cyvbusdcv28-r3` expands to 52 Solidity/Vyper files, including nondeployable forge-std test harnesses. The prior adapter incorrectly treated `max_chunks=32` as a whole-package ceiling. The canonical adapter v6 now treats it as a **per-run** limit and persists completed raw runtime-source analyses separately as immutable, source-bound R2 chunk objects. Each successor runner reads these exact objects, verifies the original file hash and line anchors, and resumes at the next unfinished source chunk. The existing 4096-chunk protective maximum and per-file limits are separate resource safety bounds, not a controller PASS.

The original complete ZIP remains frozen in the controller. Vendored `dependencies_v6/forge-std/` testing and cheatcode files are excluded only from the model's runtime-code analysis; primary Solidity/Vyper contracts, the Yearn vault, routers, deployment scripts and runtime libraries remain candidates. Every included source chunk analysis is saved privately. Since MiMo has an 8K context window, a later controller unit receives an explicitly incomplete, source-cited contextual evidence index, not a misleading claim that the model has all earlier raw analyses in its current context. The Worker and controller must still reject inadequate evidence.

Version v9 does not change the existing 355-minute autonomous job cap, the 345-minute handoff target, the 30-minute per-request inference timeout, or the original controller approval and verification rules. Existing in-flight jobs keep their starting commit; only newer runs use the updated source-stage behavior.

## MiMo structured JSON recovery (v10)

The first completed retry run returned a non-JSON response during its initial instruction-reading segment, after the original four-minute inference cap had already been repaired. Adapter v7 therefore now accepts only fully parseable JSON objects but can extract such an object from an otherwise extraneous reasoning block or Markdown fence. If the model truly returned malformed or truncated output, it makes one bounded additional attempt with a changed JSON-only prompt and more output tokens; it never treats an incomplete answer as valid or invents missing properties. Instruction segment calls now allow 2200 output tokens before the bounded correction attempt.

The controller was still ACTIVE at Phase 1 Step 1 with all 11 units unleased and unaccepted after this failure. Resumption stays on campaign `cyvbusdcv28-r3` and retains the originally frozen source/authority. A workflow success still does not indicate controller acceptance.

## Current free-beta limitations

- This is **not fine-tuned MiMo**; it has not demonstrated senior-auditor quality.
- 16 GB CPU, no GPU; 355-minute autonomous job limit (100-minute public/v5 limit), Q4 MiMo 9B, 8K context. Cooperative checkpointing preserves completed source chunks but does not snapshot MiMo's in-flight token generation or controller leases. Loading and generating dozens of investigations may exceed the time budget.
- Each autonomous run analyzes at most 32 new source chunks and resumes from immutable per-chunk R2 evidence; the whole campaign can exceed 32 chunks. Build-only forge-std test utilities are not treated as deployed audit targets. Runtime file size (256 KiB) and full source index (4096 chunks) remain resource bounds.
- Each invocation currently generates at most one complete controller unit; an eligible successor is dispatched as a separate GitHub job. This is a beta mechanism, not guaranteed full-campaign throughput.
- If there is missing machine-execution evidence, unresolved structural rework, no approved source snapshot, timeout, or the model cannot satisfy the exact current form and instructions, the agent must report the real blocked state and **must not** claim phase completion.
- AI-v6 Phase 0 has been observed sealed for `cyvbusdcv28-r3`; the complete MiMo audit and its new time-bound handoff path are not yet end-to-end verified. Do not assume that workflow dispatch or an R2 checkpoint equals controller acceptance.

## Evidence to inspect

- Exact Actions jobs, logs and SHA: https://github.com/curveyield3/Contract-Automation/actions/workflows/lite-solo-ai-inference-v1.yml
- AI adapter: https://github.com/curveyield3/Contract-Automation/blob/main/scripts/lite-solo-ai/campaign-v1.mjs
- AI authority: https://github.com/curveyield3/Audit-Controller/tree/main/Audit%20Skill%20-%20Lite-Solo%20Authority/lite-solo-v6
- Current campaign Controller directory and Phase0/phase receipts: use the private original controller, not workflow-success status.
- The previous public-only and v5-manual modes remain available through the same existing workflow.

## Eight-runner distributed CPU training (v1, opt-in; not enabled for audits)

The existing `.github/workflows/lite-solo-ai-inference-v1.yml` now exposes manual `mode=train`.
It starts eight independent public-repository Ubuntu CPU jobs with `matrix.rank=0..7`,
each loading four contiguous Qwen3.5 decoder layers of the **original**
`XiaomiMiMo/MiMo-V2.6-Distill-Qwen-9B` safetensors checkpoint. It does not
use the original inference-only Q4 GGUF for gradient calculation. The source
checkpoint is pinned to a full immutable Hugging Face commit per run, and the
existing source-bound model inference setup is not modified.

### Runtime prerequisites and how to start

1. Obtain the required Tailscale OIDC configuration for **tag:ai-training**:
   the repository's existing `TS_OAUTH_CLIENT_ID` secret must authorize this
   dedicated tag, and tailnet ACLs must permit **only** same-tag training peers
   to reach the coordinator's TCP port 29631. The existing
   `scripts/browser-agent-tailnet-oidc.sh` is reused; do not grant training
   peers browser-session access as an alternative.
2. Use a **public**, rights-cleared, source-grounded dataset checked into the
   Contract-Automation repository with `.jsonl` extension. Every nonempty line
   is a JSON object with nonempty `prompt` and `completion` strings.
   Do not place private campaigns, secret credentials, internal controller
   evidence, or unpublished Audit-Controller source into this public dataset.
   No dataset was invented or uploaded as part of the workflow implementation.
3. Open the existing workflow and select **Run workflow** / **train**.
   Supply `train_dataset_path` (repo-relative JSONL file).
   `train_model_revision` may be empty to resolve and pin the current
   official original-checkpoint SHA at rank zero. The default
   `train_steps=1`, `train_sequence_length=128`,
   `train_minutes=65`; adjust only after observed performance.
   `train_resume_run` is optional and must reference a run with all
   eight unexpired rank checkpoint artifacts.
4. All ranks rendezvous inside the private Tailscale network. Model source
   and dataset digests and any resumed checkpoint steps must match across
   all ranks. Each rank runs sequential cross-host forward/backward
   activation and gradient exchange, owning its four model layers plus
   boundary embedding or output projection as appropriate.
   The base is frozen and projection LoRA rank=8, alpha=16 is trained.
   This is conservative synchronous pipeline training; it prioritizes
   correct memory partitioning over high GPU-like throughput.
5. Successful training uploads eight rank-specific checkpoints.
   A final job verifies identical training identities and steps, validates
   rank ownership, and uploads the combined
   `mimo-cpu-training-package-v1` containing
   `mimo_cpu_lora_stages.safetensors` and `manifest.json`.
   Artifacts have finite retention and do not constitute durable model registry.

### Strict separation from existing audits

- `train` **never** uses the Cloudflare Lite-Solo controller, changes source
  authority, claims packets, executes an audit test, or dispatches successors.
- Existing `public`, `campaign`, `autonomous_start`, `autonomous` modes
  and the legacy v5 human gates are unmodified.
- Training completion **is not** adapter deployment. Conversion of raw stage
  LoRA tensor names to a compatible PEFT / GGUF adapter, inference
  compatibility validation and effectiveness evaluation remain separate
  authorized operations. The installed Q4 inference model remains active.
- A training input without approved/public training data or a tailnet policy
  allowing `tag:ai-training` stops before model training.
- GitHub Actions is subject to disproportionate usage restrictions even for
  public projects. Training jobs should not be repeatedly dispatched or
  used as an ongoing free compute service without confirmed acceptable use.
- No new training tests were created or executed as part of this deployment.
