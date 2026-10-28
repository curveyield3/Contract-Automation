# Contract-Automation Agent Execution Policy

Policy version: v13

## Nonstop audit execution and workflow-failure recovery — mandatory

Agents executing Lite-Solo or other authorized audit assignments MUST treat starting a workflow, a successful initialization, and a pending Phase 0 as intermediate work, not a finished assignment. **On a failed/timed-out/cancelled workflow or rejected controller submission: DIAGNOSE the actual failing job/step/logs and bound controller state → REPAIR the established owning mechanism → RESUBMIT the exact interrupted operation via its existing authorized lane and campaign generation → VERIFY the new persisted result → CONTINUE the audit immediately. DO NOT STOP WORKING merely to report a failure or ask the human to reply.** Preserve frozen source, skill, claims, sealed receipts and accepted work; never bypass evidence/validation gates, create an unnecessary campaign, invent approval requirements, or add tests/workflows/infrastructure without authorization. Check active runs before retrying and never repeat an identical uncorrected failure. When the only dependency is an active external workflow, follow the existing run at a reasonable cadence while the session permits instead of ending at “running”; if the session cannot remain active through its outcome, report the exact INCOMPLETE dependency and authorized next action without claiming background execution. An irrecoverable barrier is reportable only after exhausting the existing recovery path.

## Repository hygiene, anti-spam, and single-flight execution — mandatory

These rules govern all repository work unless a more specific local `AGENTS.md` adds stricter requirements.

### One live file per purpose

- Active repository paths MUST contain only the current live implementation for a given purpose.
- Before creating a file, search the repository for the same or substantially similar responsibility. Reuse or edit the existing canonical file whenever possible.
- Do not create retry/version trash such as `foo-v2`, `foo-v3`, `foo-fixed`, `foo-final`, `foo-new`, `foo-copy`, or equivalent siblings merely because an attempt failed.
- If a genuine version bump is required, the same change MUST remove or archive the superseded active version. Never leave a chain of old active siblings behind.
- Historical files belong in `curveyield3/archive` when preservation is required. Git history is sufficient when no separate historical copy is required.
- Temporary diagnostics, scratch output, screenshots, generated probes, and transient execution data MUST use temporary runtime storage or the existing artifact/results location. Do not commit them as new permanent top-level files unless they are required durable evidence.

### File placement is not optional

- Before creating a file, inspect the surrounding tree and the nearest local `AGENTS.md`.
- Put the file in the established owner directory for that responsibility. Do not dump files into repository root, `.github/workflows`, `process`, `scripts`, or another convenient directory merely because it is easy to reach.
- When a similar file already exists elsewhere, follow that location and naming pattern.
- If no clear owner exists, choose the narrowest existing subsystem directory that owns the behavior; do not invent a new top-level category without a human requirement.

### Single-flight browser and workflow execution

- Before starting any browser session, GitHub Actions workflow, simulation, deployment, or long-running test, inspect currently queued/in-progress runs and durable task state.
- If the same workflow, browser lane, target branch, campaign, request, or shared browser/login state is already active, DO NOT launch another copy in parallel.
- Reuse/observe the active run. If it is genuinely stale or hung, terminate or retire it first, then start exactly one replacement.
- Workflows sharing the same ChatGPT browser state, account session, Project, request queue, target branch, or mutable execution environment are strictly single-flight.
- Never start multiple same-kind workflows merely to see which one finishes first.
- A retry means repair the existing implementation and rerun one instance. It does not mean create another workflow file or another browser session.

### Repeated-failure and repeated-analysis stop rule

- Do not execute the same failed operation three times with materially identical code, inputs, and environment.
- After two materially identical failures, further execution is prohibited until the agent identifies a concrete new cause or changes a relevant input/code/configuration.
- Before re-analyzing a failure, inspect the current handoff, existing diagnosis, logs already read, and repository changes made since that analysis.
- Do not repeatedly summarize or re-investigate the same unchanged logs/source/state. Re-analysis is justified only by new evidence or a changed implementation/environment.
- Do not create a new diagnosis/report/status file for each retry. Update the existing canonical task state or report when one exists.

### No self-triggering execution loops

- A workflow that commits generated results MUST NOT watch those generated result paths with a `push` trigger.
- Do not use broad directory triggers that include both workflow inputs and workflow outputs.
- Test/diagnostic workflows MUST NOT run on every push to `main` unless repository-wide execution on every push is explicitly required.
- Request-triggered workflows should watch only their request/input paths and necessary implementation files.
- Before merging workflow changes, reason through whether the workflow's own commits can trigger itself or another cyclic workflow chain.

### Cleanup is part of completion

Before declaring repository work complete:

- remove superseded versions and temporary helper files;
- remove or archive obsolete one-off workflows;
- verify no duplicate same-purpose file family remains active;
- verify no unnecessary duplicate browser/workflow execution is still queued or running;
- verify generated files landed in their proper subsystem directory;
- leave one clear current implementation and one clear next state.

These rules are specifically intended to prevent runaway agents from generating thousands of useless files, runs, analyses, or retries.

## Bounded auxiliary work — anti-loop policy

Agent-authored queues, checklists, optimization sweeps, recovery notes, and follow-up issues are **subordinate work aids**. They MUST NOT become independent controlling specifications or recursively expand their own scope.

Mandatory rules:

- The active human-approved specification, campaign authority, and latest verified handoff outrank any agent-authored queue or issue.
- An auxiliary queue MUST state a finite scope, exact deliverables, and an explicit terminal exit condition before work begins.
- An auxiliary queue MUST NOT contain unbounded directives such as "continue continuously", "audit everything again", "keep finding improvements", or equivalent open-ended successor instructions.
- An agent MUST NOT create a successor task whose sole purpose is to repeat the same broad audit/sweep after the stated deliverables are complete.
- Before resuming an inherited queue, compare it against current `main`, the governing specification, and completed work. If the queue is stale, superseded, or broader than the governing specification, retire it rather than resume it.
- Tests and qualification are evidence for a defined change, not a source of new scope. A passing or failing test may justify repairing the evidenced defect, but MUST NOT automatically trigger another repository-wide sweep.
- After the bounded deliverables are complete, the agent MUST return to the next unfinished item in the governing specification or stop if the specification is complete.
- Any future handoff MUST name the governing specification and exact resume point. It MUST NOT direct a successor to an open-ended self-authored queue as the primary authority.

This rule exists to prevent self-perpetuating agent loops that consume time without advancing the approved objective.

## Browser-agent blockchain workstation — start here

For ChatGPT/web-agent blockchain development, testing, simulation, deployment orchestration, or Audit V7 work, read:

`docs/BROWSER_AGENT_BLOCKCHAIN_WORKSTATION_v1.md`

That guide is the browser-agent navigation layer. It does not replace this policy, the canonical V7 CLI, or runner manifest.

## Archive boundary — mandatory

`curveyield3/archive` is the only repository-level home for superseded, deprecated, obsolete, historical-only, backup, or replaced Contract-Automation files.

**Migration safety gate:** The `curveyield3/archive` repository has not been confirmed accessible (GitHub returned 404 on October 24, 2026). Before any archive migration, verify that the target repository exists and accepts writes. Until confirmed, do not delete, move, overwrite, or retire a uniquely valuable active file on the assumption that its archive copy exists. Report the missing archive destination rather than silently attempting archival.

- Active Contract-Automation paths contain only current operational files and current instructions.
- When an active file is superseded, preserve the old file in `curveyield3/archive/Contract-Automation/<original-path>` and remove it from this repository.
- Do not keep version chains such as active `foo-v1`, `foo-v2`, `foo-v3` siblings when only one version is current.
- Git history remains available, but do not use Git history as an excuse to leave obsolete files beside live files.
- Agents MUST NOT use Archive files as current execution instructions, current schemas, current workflows, current skeletons, or current policy unless a human explicitly requests historical recovery/comparison.
- If an Archive copy is needed, preserve the exact original bytes/digest before deleting the active-repo copy.

Static checks enforce this rule for V7 workflows, process artifacts, and Phase-6 skeleton-kit siblings.

## Branch lifecycle and cleanup — mandatory

Agents MUST NOT leave completed, abandoned, superseded, experimental, request, repair, or qualification branches sitting indefinitely without an explicit disposition.

Every branch created by an agent must end in exactly one of these states:

1. **MERGED_AND_DELETED** — completed reusable infrastructure work is merged into its intended base branch and the working branch is deleted;
2. **ACTIVE_WITH_OPEN_PR** — unfinished or review-pending work has an open pull request that states the owner/purpose, remaining work, intended base branch, and whether the branch is an execution/request branch that must not be merged; or
3. **CLOSED_WITH_RECORDED_DISPOSITION** — the branch is intentionally not being merged because it is obsolete, superseded, rejected, a completed trace/request branch, or preserved only for recovery/history. Before retiring it, preserve any uniquely valuable code/evidence in the appropriate active path or `curveyield3/archive` and record why it is not being merged.

Mandatory rules:

- Creating a branch creates an obligation to close its lifecycle before the task ends.
- Do not use branches as permanent storage or as a substitute for the archive repository, workflow artifacts, or canonical evidence storage.
- Atomic V7 request branches are intentionally non-mergeable into trusted `main`, but they are still temporary. After the execution/evidence identity is durably recorded and no retry requires the exact branch, close the trace PR and retire/delete the request branch.
- Do not leave a completed branch merely because work was cherry-picked, squash-merged, reproduced elsewhere, or superseded; compare it against current `main`, inspect every unique changed file, preserve anything useful, then retire it.
- Before declaring a branch disposable, inspect unique implementation, tests, fixtures, workflow changes, evidence, documentation, and recovery material. Do not assume old agent work was pointless.
- If a branch remains active at the end of an agent turn, it MUST have an open PR or an explicit handoff identifying branch, owner/purpose, exact current status, and next action.
- After a normal implementation PR is merged, delete the merged branch unless repository policy explicitly requires it to remain.
- Periodically audit non-main branches and clean up stale branches.

## Lite-Solo v4 controller transport and audit execution — mandatory

For admitted `mode=LITE_SOLO` / `lite-solo-v4` campaigns, the exact campaign-bound skill overrides generic V7 request-transport or human-approval prose. Use **only the existing Lite-Solo v4 controller lanes**: `process/agent-upload/lite-solo-unit-requests/<campaignId>/<workerId>-<requestId>.json` for Phase 4–6 CLAIM/SUBMIT/RELEASE; `process/agent-upload/lite-solo-phase-boundary/*.json` for Phases 1–3 and 8–10; and `process/agent-upload/lite-v7-execution/*.json` for authorized Phase-6/8/9 qualified test dispatch. These requests are committed to Contract-Automation `main` through the existing validated GitHub-connector process, **not** a V7 temporary request branch, trace-only PR or `v7:submit` request transport. Controller-only FINALIZE and phase receipt sealing are never reviewer submissions. Verify persisted acceptance and source/authority/claim identity.

Lite-Solo v4 Phase-0 execution is automatic on admitted source; all mandatory and source-bound Phase-5/6/8/9 execution required by its bound phase instructions proceeds without another human approval, registration, master gate or delegated test-executor. Only the existing qualified public Contract-Automation/Anvil lane runs tests. Explicit separate authorization remains necessary for tests **outside** the admitted campaign's prescribed execution, and no user authorization is inferred for unrelated testing or infrastructure. The sole logical auditor may have parallel independently owned Phase 4–6 units; shared mutable runner state and identical request identity remain single-flight.

## Canonical V7 control surface

For Audit V7 technical execution (not Lite-Solo v4 controller CLAIM/SUBMIT/phase-boundary transport), this repository has one canonical execution workflow, one runner manifest, and one operational CLI:

- execution workflow: `.github/workflows/audit-controller-execution.yml`
- runner manifest: `process/RUNNER_MANIFEST.json`
- CLI: `packages/github-native-sim/src/v7-cli.mjs`

Agents MUST NOT choose among historical workflow/manifests or recreate version-suffixed active entrypoints.

Normal operations are:

- execute: `npm run v7:execute -- --request <request.json>`
- submit an atomic request: `npm run v7:submit -- --request <request.json>`
- create a Phase-6 harness bundle: `npm run v7:harness:init -- --request <request.json> [--campaign discovery|property|targeted]`
- validate a Phase-6 harness bundle: `npm run v7:harness:validate -- --bundle <bundle-id> --request <request.json>`
- verify the generated runner manifest: `npm run v7:manifest -- --check`

If a deterministic operation exists in this CLI, agents MUST use it instead of manually reconstructing the underlying Git/RPC/file workflow.

## Terminal disposition is authoritative

Every V7 execution returns a top-level machine disposition plus `blocking`, `owner`, `nextAction`, `retryFrom`, and `recoveryCommand` where applicable.

Agents MUST consume these fields directly and MUST NOT re-derive a different next state from nested logs when the runner already supplied one. Current terminal dispositions include:

- `PASS`
- `FINDINGS`
- `HARNESS_AUTHORING_REQUIRED`
- `RUNNER_REPAIR_REBIND`
- `RECIPE_GAP`
- `INFRASTRUCTURE_BLOCKED`
- `EXECUTION_FAILED`

If the disposition contains a recovery command, use that command before inventing a manual repair path.

## Request submission — automated and byte-safe

For V7 atomic request submissions outside the Lite-Solo v4 controller lanes, do not manually perform the historical blob/tree/commit/ref playbook during normal audit work.

Use:

`npm run v7:submit -- --request <request.json>`

The trusted submission implementation performs schema validation, exact-byte SHA-256 capture, Git blob/tree/commit/ref creation, exact remote-byte verification, atomic-diff verification, and trace-PR creation. A request branch must differ from trusted `main` by exactly one request payload.

Requester-controlled execution fields remain forbidden, including `rpc`, `rpcUrl`, shell commands, private keys, signed transactions, mnemonics, and secrets.

## Phase 6 skeleton code — canonical location and mandatory discovery

The canonical entrypoint is:

`packages/github-native-sim/harness-skeletons-v2/README_v2.md`

The canonical directory is:

`packages/github-native-sim/harness-skeletons-v2/`

Before authoring or repairing a Phase-6 Medusa/Foundry harness, agents MUST open that README. If the path does not resolve on the first lookup, search this repository for `harness-skeletons-v2` or the exact skeleton filenames. While the repository is accessible, do not ask the human where the skeleton code is and do not recreate supplied skeletons from memory.

## Phase 6 harness authoring — deterministic bundle lifecycle

Missing usable harnesses are `HARNESS_AUTHORING_REQUIRED`, never `NOT_APPLICABLE` when the target is technically compatible.

Start with:

`npm run v7:harness:init -- --request <request.json> [--campaign discovery|property|targeted]`

Then adapt the generated audit-only files to the exact frozen target and run:

`npm run v7:harness:validate -- --bundle <bundle-id> --request <request.json>`

The validator checks source binding, duplicate destinations, file digests, required `medusa.json`/`foundry.toml`, mandatory Medusa fork mode, forbidden literal RPC URLs, Foundry RPC selection, and unresolved target-specific placeholders.

Harness/config/model files remain audit-only. Never modify frozen production source merely to make the harness compile or execute.

## Phase 6 source staging — single immutable snapshot

Phase 6 stages exact source, verifies any archive, and materializes the approved audit overlay **once**. That staged project is hashed and used for preflight. Execution receives a local copy of that same hashed snapshot.

Do not add a second network checkout, second archive extraction, or second harness-overlay materialization to the normal Phase-6 path. Snapshot digest mismatch is an integrity failure.

## Canonical archival Anvil execution — all Lite phases and technical review

The **only** Ethereum archive upstream for this audit process is the existing GitHub Actions secret `RPC_ETHEREUM` (authenticated dRPC), projected by the trusted GitHub Actions execution step to `ETHEREUM_FORK_RPC_URL`. It is NOT a direct mutable RPC and must never receive test writes. The runner's `packages/runner/src/anvil-engine.mjs` launches an ephemeral **127.0.0.1 Anvil fork**, pinned to the authenticated historical block, and only the localhost RPC receives transactions, impersonation, snapshot/revert and fuzz/Medusa/Forge actions.

The authoritative, stepwise agent launch/recovery policy is `docs/BROWSER_AGENT_BLOCKCHAIN_WORKSTATION_v1.md`, section **Anvil/RPC rule**. Read it before any technical test design or request. The frozen campaign-specific Audit_Litemode_v13 authority governs *which* obligations exist; this infrastructure guide governs *how* existing technical execution is launched. Never change a frozen skill or sealed receipt to fix an execution issue.

- Phase 0: Lite-Solo v4 uses `lite-solo-source-initialization-v1.yml` followed by `lite-solo-phase0-bootstrap-v1.yml`, its reusable intelligence subprocess, and the existing `scripts/run-phase0-fork-deploy-config-v1.mjs` fork-deploy job. It pins historical block/hash and, for LIVE_SCAN, proves deployed target runtime code. Other legacy Lite campaigns retain their frozen Phase-0 route; none supersedes v4. No fabricated off-fork replacement.
- Phases 1–4: Lite-Solo v4's one logical auditor reads accepted source evidence and performs only the current assigned semantic/discovery work; Phase-4 workers may claim disjoint units, with F/R accepted before X attack. No master-targeted-test role or approval gate exists. Required later source-bound testing uses the existing qualified V7/Anvil lane; synthetic, public-RPC or private local-chain substitutes do not qualify as historical fork evidence.
- Phase 5: Lite-Solo v4's one logical auditor authors source-bound runnable target designs. The existing `lite-solo-unit-controller-v1.yml` finalizes accepted unit work through `scripts/lite-solo-phase-controller-v1.mjs`, which runs mandatory qualified machine targets without additional human approval or test-executor handoff. The existing `lite-solo-phase-controller-v1.yml` serves non-unit legacy generations as bound; **never use `lite-phase-work-packet-controller-v1.yml` as the v4 controller**. Never submit a phase solely to probe runner health. Medusa/Forge use only the admitted local fork and only when selected by the bound execution request.
- Phase 6: for Lite-Solo v4, the logical auditor designs and authors required baseline/attacker requests and dispatches via the existing `process/agent-upload/lite-v7-execution/` and `audit-controller-execution.yml` qualified lanes without delegated test-executor or additional human authorization. Other campaign modes retain their frozen role rules. Full raw ledgers and bound receipts are required.
- Phase 7: automatic milestone/marker, no new simulation. Phases 8–10: source-bound remediation/retest when authorized uses the same runner, historical pin and receipt requirements; no private/public fork alternatives.
- Never invent `SIM_ARCHIVE_PRIMARY_ETHEREUM_01` or request a replacement mutable RPC credential; this is a deprecated misleading identifier, not the actual GitHub Actions secret. GitHub connector lacking `workflow_dispatch` does not mean Anvil/dRPC are missing. Use the existing documented push-triggered request and verify exact run and jobs.
- For each required archive action, record: upstream chain, pinned block and hash, Anvil PID/session identity, chain verification, deployed bytecode/address checks, isolated-fork write traces, real ABI/oracle observations, and raw evidence digest. Do not expose the secret/URL, private-key material or browser tokens.
- Fail closed on missing/unreachable/wrong-chain RPC, missing history/code, unsupported chain, hash mismatch, absent fork, synthetic fixture, stale snapshot or missing test permission. A local chain started without `--fork-url` is **not** archive-backed evidence. No fallback to Ganache, unauthenticated public RPC, latest unpinned chain, copied/static fixture or arbitrary local chain.
- Approval to **inspect, repair or document** alone is not test authorization. For Lite-Solo v4, **the admitted campaign-bound phase contract already authorizes its mandatory source-bound testing**: do not demand separate human approval or invent a new test gate. Outside those mandatory admitted operations, do not submit test-triggering requests, push test fixtures, rerun test workflows or create execution infrastructure without explicit audit-owner authorization.

## Full simulation backend — historical Anvil only

All authoritative simulation/attacker/deployment/lifecycle evidence requiring live state uses a locally writable Anvil **fork of verified historical chain state**. Standalone local simulation is permitted only for development/unit-test machinery and must be explicitly labeled `SYNTHETIC_NOT_AUDIT_EVIDENCE`; it cannot seal a Lite campaign or satisfy a candidate security claim.

## Dependency locking status

The repository currently has no recoverable `package-lock.json`. The canonical workflows therefore prefer `npm ci` when a lockfile exists but temporarily fall back to `npm install --no-package-lock` and record `V7_DEPENDENCY_LOCKED=false` when it does not.

Do not claim dependency resolution is locked until a valid lockfile is generated from the repository dependency graph and committed. Do not fabricate a lockfile.

## Audit execution boundary

Private audit/controller repositories are control planes. Technical/rate-limited execution belongs in this public Contract-Automation repository through the canonical bridge/workflow. Do not add competing workload-running audit workflows to private controller repositories.