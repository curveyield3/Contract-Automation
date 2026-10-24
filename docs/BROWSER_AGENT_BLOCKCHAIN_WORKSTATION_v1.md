# Browser Agent Blockchain Workstation — START HERE

Version: v1

This file is the browser-agent entrypoint for blockchain development, testing, simulation, and Audit V7 work in the CurveYield2 GitHub organization.

## Audit-process authority and progressive disclosure

For an audit campaign, the **exact skill packet supplied/admitted for that campaign is the audit-navigation and methodology authority**. This workstation guide is only an infrastructure/navigation aid for operating GitHub and Contract-Automation; it must never replace, broaden, reorder, or preload the audit skill.

When an audit is active:

1. Start from the exact campaign skill homepage (`SKILL.md`) only.
2. Resolve exact campaign generation, source identity, current phase/revision, and reviewer lineage from durable controller state.
3. Open only the current phase `START_HERE.md`, its `PHASE_CONTRACT.json`, and resources explicitly linked/triggered by the active step.
4. Preserve the skill's planned sequential reviewer boundaries and fresh-reviewer handoffs.
5. Do not introduce concurrent semantic audit reviewers or parallel agent ownership unless the exact active skill/mode explicitly authorizes it.
6. Automation may perform mechanical routing, validation, evidence collection, artifact normalization, checkpointing, and filing, but it must not invent security judgment, silently waive mandatory work, or convert tool output into a finding without the authorized reviewer.

## Repository roles

### CurveYield2/Audit-Controller
Control plane only.

Use it for:
- audit methodology and phase authority;
- campaign state;
- admitted source identities;
- Source Intelligence references;
- candidate/finding ledgers;
- evidence identities;
- reports;
- reviewer handoffs.

Do not move generic compilation, fuzzing, Foundry/Medusa, Anvil, fork simulation, or reusable technical workloads into Audit-Controller.

### CurveYield2/Contract-Automation
Execution plane.

Use it for:
- compilation;
- Solidity/Vyper technical execution;
- Slither;
- Foundry/Forge;
- Medusa;
- fuzzing and invariant testing;
- Anvil fork simulation;
- deployment/lifecycle simulation;
- live read-only chain probing;
- reusable technical audit workloads;
- workflow evidence/artifacts.

## Mandatory first reads

Before changing or running anything:

1. Read `AGENTS.md` in the repository you are operating in.
2. For GitHub Actions operation, read:
   `docs/CHATGPT_GITHUB_ACTIONS_VIA_GITHUB_APP.md`
3. For Audit V7 execution, inspect:
   `process/V7_QUALIFICATION_STATUS.json`
4. For Audit V7 CLI operations, use the canonical commands documented in `AGENTS.md`.

Do not create duplicate workflows, duplicate runners, alternate RPC systems, or replacement V7 entrypoints merely because the existing trigger is not obvious.

## Private Actions budget rule — mandatory

`CurveYield2/Audit-Controller` is a private control/evidence plane and its limited private GitHub Actions allotment must be preserved.

- Put new generic, reusable, compute-heavy, recurring, technical, audit, testing, orchestration, packet-generation, validation, reconciliation, and recovery workloads in public `CurveYield2/Contract-Automation` whenever technically possible.
- Use the existing Audit-Controller → Contract-Automation bridge/request/event pattern so Audit-Controller supplies authority/state and Contract-Automation supplies execution.
- Audit-Controller may contain deterministic controller/library code and durable campaign state that Contract-Automation checks out and executes on the public runner.
- Do not add a new Audit-Controller workflow merely because it is convenient.
- A private Audit-Controller Action is permitted only when the work is literally not safely/technically executable through the existing public execution plane (for example the explicitly allowlisted private audit-PDF subsystem).
- Before adding any private workflow, prove why the existing Contract-Automation bridge cannot perform the task.

## Browser-agent GitHub Actions rule

The ChatGPT GitHub app does not need a direct Run Workflow button.

For an existing workflow:

`READ WORKFLOW -> IDENTIFY on: EVENT -> CREATE THAT EVENT -> VERIFY RUN -> INSPECT JOBS/LOGS/ARTIFACTS`

The full trigger guide is:
`docs/CHATGPT_GITHUB_ACTIONS_VIA_GITHUB_APP.md`

## Audit workload-reduction operator

Deterministic audit navigation/bookkeeping operations use the **same canonical V7 atomic request bridge** as technical execution:

`.github/workflows/audit-controller-execution.yml`

Do not create or use a parallel audit-operator workflow.

The private operation request lives in Audit-Controller at:

`.deep-assurance/operator/requests/<request-id>.json`

The public atomic pointer is a single request file in this repository under:

`github-native-sim/requests/<request-id>/request.json`

with schema `audit-controller-operation-pointer-v1`. It binds only:
- the exact private Audit-Controller commit;
- the exact private operation-request path;
- whether that exact controller commit must run its full verification suite before the operation.

Submit the pointer through the existing byte-safe command:

`npm run v7:submit -- --request <pointer.json>`

That existing submitter creates the trace-only request branch/PR, and the existing canonical workflow executes the operation. Controller-only requests skip the heavyweight Foundry/Medusa/toolchain setup.

Supported private operation types are:
- `PROJECT_CURRENT_STATE`
- `BUILD_EXECUTION_REQUEST`
- `INGEST_EXECUTION_EVIDENCE`
- `BUILD_SUCCESSOR_HANDOFF`

Generated private audit outputs are not uploaded as public artifacts. The canonical workflow writes them only to the private Audit-Controller branch specified by the private request after exact-head verification.

## Fast readiness check for Audit V7

First inspect:

`process/V7_QUALIFICATION_STATUS.json`

If the current status is `PASS`, use the admitted qualified runner identity recorded there. Do not assume a newer raw `main` commit is qualified.

If a fresh qualification is required, a browser agent can trigger the existing qualification bridge by creating a GitHub issue in `CurveYield2/Contract-Automation` with this exact title:

`[agent] run-v7-qualification`

The existing `.github/workflows/v7-agent-qualification-bridge.yml` workflow dispatches and observes the canonical V7 qualification and records the latest attempt.

Do not create a second qualification workflow.

## Canonical Audit V7 operations

Use the existing CLI rather than reconstructing Git/RPC/file operations manually:

```bash
npm run v7:execute -- --request <request.json>
npm run v7:submit -- --request <request.json>
npm run v7:harness:init -- --request <request.json> [--campaign discovery|property|targeted]
npm run v7:harness:validate -- --bundle <bundle-id> --request <request.json>
npm run v7:manifest -- --check
```

Respect the terminal disposition returned by the runner. If it supplies `nextAction`, `retryFrom`, or `recoveryCommand`, consume those fields directly before inventing another repair path.

## Audit execution flow

For an Audit V7 campaign:

1. Read the current Audit-Controller campaign state and applicable audit authority.
2. Preserve exact source/build/campaign identities.
3. Reuse accepted Source Intelligence when source/build identity matches.
4. Submit technical work to Contract-Automation through the canonical V7 execution path.
5. Observe the resulting GitHub Actions run.
6. Retrieve logs/artifacts/evidence.
7. Interpret the evidence in the Audit-Controller campaign.
8. Preserve evidence identities and phase obligations.
9. Continue from the current phase. Never restart sealed phases.
10. At required reviewer boundaries, use the canonical successor handoff protocol.

## Phase 6 harness rule

Before authoring or repairing a Phase-6 harness, open:

`packages/github-native-sim/harness-skeletons-v2/README_v2.md`

Then use:

```bash
npm run v7:harness:init -- --request <request.json> [--campaign discovery|property|targeted]
npm run v7:harness:validate -- --bundle <bundle-id> --request <request.json>
```

Missing harness support is not permission to modify production source or bypass required testing.

## Anvil/RPC rule

Authoritative Audit V7 full simulation uses Anvil only.

The approved Ethereum archive credential is the existing **GitHub Actions secret `RPC_ETHEREUM`** (the provided dRPC archival endpoint). The trusted `audit-controller-execution.yml` job maps it to **`ETHEREUM_FORK_RPC_URL`**, the environment profile consumed by the existing Anvil-based V7/Phase-6 engine.

**Required simulation behavior:** launch the existing local ephemeral Anvil fork with that upstream credential and a pinned historical Ethereum block; verify chain ID, pinned block number/hash, deployed address/code, and required archive state; run actual ABI actions on the isolated Anvil fork. Anvil's local writable fork and dRPC's upstream historical state are complementary, not alternatives. No transactions may be broadcast to mainnet.

If a reviewer claims an archival endpoint is missing, check the existing `RPC_ETHEREUM` → `ETHEREUM_FORK_RPC_URL` workflow mapping, workflow run ID, pinned-block access and Anvil readiness **before** declaring the tests impossible. Do not create a synthetic substitute, custom unauthenticated RPC URL, or another per-campaign workflow.

**Historical log-query recovery (observed DAI r2 failure):** the configured dRPC endpoint can service historic `eth_call`, `eth_getCode`, and block queries while rejecting `eth_getLogs` ranges of more than 10,000 blocks (`RPC code 35`, `ranges over 10000 blocks are not supported on free plan`). This means the archive endpoint IS available. For a requested historical role/event reconstruction, partition the full inclusive requested block interval into bounded contiguous chunks of at most 9,000 blocks, retry only failed chunks, verify that every interval is covered and each event has the actual receipt, deduplicate strictly by chain + transaction hash + log index, and reconcile against contract mapping getters on the pinned Anvil fork. The trusted runner may also use an authenticated established explorer/indexed log route with complete range coverage when the RPC restricts log requests; record provider and any missing ranges. Never classify a provider `eth_getLogs` range-limit response as `NO_ARCHIVE_RPC`, silently treat missing logs as zero events, or drop the historical completeness requirement. Archive-state access and historical log-index retrieval are separate capabilities.

**Phase-5 fork-lifecycle + fuzz adapter (DAI r2 failure repair):** A Phase-5 V7 execution request with `phaseId: "fork-simulation-lifecycle"`, `simulation.chain: "ethereum"`, a pinned historical `simulation.block`, and `analysis.nativeFuzz.enabled: true` is NOT an archive-RPC-unavailable case. The controller workflow already injects `secrets.RPC_ETHEREUM` as `ETHEREUM_FORK_RPC_URL`. The trusted V7 runner must first pass its historical dRPC/Anvil preflight, then create a separate short-lived **local Anvil RPC session using the same approved dRPC upstream and exactly the preflight-verified historical block/hash**, pass the local URL to Foundry and to Medusa only when explicitly requested, run source-bound tests, close the local session, and preserve actual machine results. The deterministic lifecycle simulator independently uses the same approved historical dRPC upstream and pinned block. A missing `phase6MutableRpc` adapter in an otherwise authenticated/available run is **runner wiring failure `MUTABLE_RPC_CONFIGURATION_FAILURE`**, not evidence of an unavailable dRPC archive secret. Never mark that as `NOT_APPLICABLE`, alter audit findings, or replace historical state with latest-state or source-only mocks. Material fuzz targets still require genuine harness code and nonzero executed assertions; runner wiring alone is not test evidence.

**Phase-boundary rework and repaired-run freshness (DAI r2 stoppage):** A green GitHub Actions job means the controller workflow executed, **not** that the audit phase passed. Read the active Audit Campaign Directory entry, the last SEALED receipt, and the exact latest Phase work packet `controllerValidation.status` and deficiencies. Compare the failed controller run's `head_sha` and completed-at time with the current `curveyield3/Contract-Automation` `main` history before repeating any root-cause claim. If the required runner repair landed *after* the last controller attempt, the old `MUTABLE_RPC_CONFIGURATION_FAILURE` is historical failure evidence, not evidence that the new runner is broken; mark execution against the repaired code as **not yet verified**. A reviewer must not sit idle after `REWORK_REQUIRED`: preserve accepted shards, diagnose the current failure, and use the existing controller submission path only when its machine execution is explicitly authorized. The active browser watchdog reads the rejection packet and sends the exact diagnostic on its next sweep, tracks reviewer-authored shards rather than controller-generated submissions, and escalates idle recovery without creating a parallel workflow. Lack of permission to run tests is a genuine execution hold, not permission to invent results, auto-run the old boundary, or misreport completion.

Never serialize its URL into requests, configs, logs, artifacts, or reports.

Do not substitute an arbitrary RPC when the V7 policy requires the approved profile.

For general non-V7 development/fork tooling, use the repository's already-configured RPC infrastructure and existing workflows. Do not invent new secret names or providers until you have inspected the current setup.

## General blockchain development/testing

Before creating a new workflow, inspect:
- existing `.github/workflows/`;
- `docs/setup.md`;
- package scripts in `package.json`;
- existing reusable actions;
- project-specific deployment/test scripts.

Prefer existing infrastructure.

For ordinary development, the desired loop is:

`SOURCE -> COMPILE -> STATIC ANALYSIS -> UNIT TEST -> FUZZ/INVARIANT -> ANVIL FORK -> DEPLOYMENT/LIFECYCLE SIMULATION -> EVIDENCE`

For testnet or production broadcasting, use only an existing approved signing/deployment path. Never place a private key, mnemonic, signed transaction, or secret RPC URL in:
- request JSON;
- source;
- workflow YAML;
- issue bodies;
- PR bodies;
- logs;
- committed configuration.

## Important workflow distinction

`.github/workflows/deploy.yml` currently deploys the CurveYield Preflight web/Worker service infrastructure.

It is not, by itself, a generic smart-contract production broadcast workflow.

Do not confuse application deployment with on-chain contract broadcasting.

For on-chain deployment, first locate and inspect the applicable project-specific deployment/broadcast workflow or script and its environment protections.

## Evidence is the browser agent's persistent workspace

Do not rely on temporary terminal state.

For important technical runs, preserve and consume:
- workflow run ID;
- commit SHA;
- request ID/digest;
- source/archive digest;
- fork block/hash;
- compiler/EVM profile;
- logs;
- uploaded artifacts;
- terminal disposition;
- deployment/simulation receipts where applicable.

A fresh agent must be able to resume from GitHub evidence without requiring another agent's local machine.

## Safe operating rings

### Ring 1 — Audit/fork simulation
Permitted through approved execution paths:
- compile;
- static analysis;
- fuzzing;
- invariant testing;
- Anvil;
- fork-state mutation;
- impersonation;
- exploit reproduction;
- deployment/lifecycle simulation.

### Ring 2 — Live-chain read
Use approved read-only infrastructure for:
- calls;
- storage;
- logs;
- bytecode;
- balances;
- historical state;
- traces where supported.

### Ring 3 — Testnet write
Use only the repository's configured testnet signing/deployment path and secrets.

### Ring 4 — Mainnet write
Use only the repository's approved protected production signing/deployment path. Respect any human approval gate. Never weaken or bypass it.

## If something fails

Use:

`DIAGNOSE -> REPAIR -> RETRY -> VERIFY -> CONTINUE`

Before creating new infrastructure, check:
1. whether the capability already exists;
2. whether an existing workflow has a different trigger;
3. whether the V7 terminal disposition provides recovery instructions;
4. whether the failure is source-specific, request-specific, RPC-specific, or runner-specific;
5. whether a runner repair requires qualification/rebind.

Do not silently change audited source to compensate for runner infrastructure failures.

## Final browser-agent rule

Use GitHub as the durable workstation.

Do not ask the human to manually perform work that the GitHub connector and existing Actions infrastructure can perform.

Do not invent parallel tooling when the repository already has a canonical implementation.

Operate from current repository authority, preserve exact identities, execute through existing trusted lanes, and leave durable evidence that the next browser agent can resume.
