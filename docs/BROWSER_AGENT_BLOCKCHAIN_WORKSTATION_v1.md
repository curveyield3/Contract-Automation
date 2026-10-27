# Browser Agent Blockchain Workstation — START HERE

Version: v2

This file is the browser-agent entrypoint for blockchain development, testing, simulation, and Audit V7 work in the curveyield3 GitHub organization.

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

### curveyield3/Audit-Controller
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

### curveyield3/Contract-Automation
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
3. For Audit V7 CLI operations, use the canonical commands documented in `AGENTS.md`.

Do not create duplicate workflows, duplicate runners, alternate RPC systems, or replacement V7 entrypoints merely because the existing trigger is not obvious.

## Private Actions budget rule — mandatory

`curveyield3/Audit-Controller` is a private control/evidence plane and its limited private GitHub Actions allotment must be preserved.

- Put new generic, reusable, compute-heavy, recurring, technical, audit, testing, orchestration, packet-generation, validation, reconciliation, and recovery workloads in public `curveyield3/Contract-Automation` whenever technically possible.
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

### Before any archive-dependent audit execution (mandatory for every agent)

1. **Identify the owner and permission.** Read the live campaign directory and current bound Phase START_HERE; confirm your reviewer or test-executor assignment. Reviewer-1/2/3/4 or master can design/interpret technical security work, but only the assigned registered `test-executor` or already authorized controller execution may perform authorized tests. User instructions prohibiting tests override general auto-advance language. Do not trigger any Actions workflow that runs simulations merely to diagnose a defect without audit-owner authorization.
2. **Locate the existing runner, not a substitute.** Technical execution is in `curveyield3/Contract-Automation`, not in the private `curveyield3/Audit-Controller`. For Phase 0 use `lite-phase0-bootstrap-v1.yml` → `lite-phase0-randomized-simulation-v1.yml` → `scripts/run-phase0-fork-deploy-config-v1.mjs`. For Phase 5 use the existing `lite-phase-work-packet-controller-v1.yml` (its Phase-5 boundary request **does run tests**). For Phase 6/9 explicit V7 requests use `process/agent-upload/lite-v7-execution/` → `lite-v7-execution-dispatch-v1.yml` → `audit-controller-execution.yml`. For other authorized phases reuse the same trusted V7 runner and existing owner-specific request path; never invent a new GitHub Actions workflow.
3. **Find the authenticated secret mapping.** GitHub Actions must project the existing `secrets.RPC_ETHEREUM` to `ETHEREUM_FORK_RPC_URL`. This dRPC URL is the upstream for history **only**, not a wallet endpoint. RPC configuration lives on the GitHub Actions runner, not in ChatGPT's local shell. The absence of local Forge/Anvil or of a direct connector dispatch button is not a missing secret.
4. **Pin and prove history before mutation.** For Ethereum, expected chain ID is 1. Resolve the request's historical block and full block hash from the authenticated source. Live-scan uses its signed source-manifest frozen block; ZIP/script mode now freezes the fetched upstream block/hash before running anything. Start the existing local Anvil on `127.0.0.1` with `--fork-url` pointed at the approved upstream (or trusted identity proxy), `--chain-id 1`, `--fork-block-number` equal to the frozen block, and the source-compatible hardfork. Query the local Anvil block number/hash, chain ID, code at every actual deployed target, and ensure they match the pinned upstream/deployed contract. A chain-ID-only handshake is insufficient.
5. **Use only the proven localhost session for writes and fuzzers.** Real ABI transactions, `anvil_impersonateAccount`, `anvil_setBalance`, `evm_snapshot`, `evm_revert`, targeted exploit sequences, Foundry `--fork-url`, and Medusa fork mode target the verified localhost Anvil. Never send transaction/impersonation RPCs to dRPC, a public upstream, a frontend endpoint, a bare standalone Anvil or a synthetic Ganache. Use per-run isolated state; restore only checksum-verified Phase-0 snapshots with the original historical upstream attached to serve untouched account storage. Close the session after the run.
6. **Save and evaluate actual proof.** Preserve request/source/build digest, run ID + exact runner SHA, chain/block/hash, local fork identity, deployed address/code proof, ABI transactions and mined receipts, assertions/oracles, reverts, unexecuted actions, coverage and raw transcript references. A failed or missing fork is `BLOCKED_INFRASTRUCTURE`, not `NOT_APPLICABLE`, `PASS`, `SAFE` or a fabricated finding. A synthetically executed developer-unit test is never audit evidence.

### Phase-by-phase launch ownership and action (Lite v13)

| Phase or checkpoint | Who acts and what actually launches | Historical state and audit rule |
| --- | --- | --- |
| **0 — source/bootstrap** | Automatic existing Phase-0 initializer and deployment/config GitHub Actions; reviewer does not manually run a test | LIVE_SCAN pins scan manifest number/hash, chain and deployed runtime; ZIP pins observed upstream history. Anvil receives local writes; abort on missing archive source. Phase 0 alone is not proof of all properties |
| **1 — structural inventory** | Reviewer-1 reads sealed build/fork/source evidence; no new default execution | If missing Phase-0 artifact, report controller infrastructure hold; never substitute locally deployed mock |
| **2 — specification** | Reviewer-1 maps properties and source evidence; no default execution | If a question needs a live-fork experiment, record an exact test design and owner authorization requirement |
| **3 — threat model** | Reviewer-1 designs material attack invariants, then master gate | No rerunning a sealed phase or unapproved deployment; inherited Phase-0 provenance stays immutable |
| **4 — correctness/discovery/master** | Reviewer-2 analyzes and master may request targeted tests from distinct registered executor | For each authorized experiment, use the existing V7 archive Anvil; direct historical `eth_call` is read-only observation, not proof of simulated attack state. DAI X001-ROLE-VERIFY's HIGH uncertainty remains until an authenticated intended policy exists |
| **5 — economics/targets** | Reviewer-3 authors three-part semantic attacker/oracle plans, bound `ANVIL_WORKFLOW` / other selected V7 adapters; the existing phase-boundary controller may automatically execute | Verify execution authority **before** boundary submission. The runner preflights authenticated Ethereum history; Foundry/Medusa are optional only if truly selected and must share a verified local Anvil fork. No arbitrary 100,000 fuzz-call quota |
| **6 — machine interpretation and adversarial baseline** | Reviewer-3 reads raw Phase-0/5 evidence and designs baseline/candidate harnesses; authorized registered test-executor uses existing V7 dispatch | Match candidate and control assertions, receipt hash, source, local fork, exact historical block and test group. Never treat unavailable test evidence as a negative result |
| **7 — automated marker** | Controller only; no simulation or reviewer | Marks prior verified progression, never manufactures fork evidence |
| **8 — findings/remediation** | Reviewer-4 reviews findings and evidence; propose targeted retests if justified | Archive-backed execution via the same V7 path **only on authorization**; carry unresolved limitations |
| **9 — conditional remediation** | Reviewer-4 uses existing Phase-9 rerun request and V7 dispatcher only if remediation exists and owner authorized | Reproduce original historical starting state, test repaired code on isolated Anvil, record before/after and unchanged upstream reference |
| **10 — final conclusion/master** | Reviewer-4 and master reconcile all receipts and exceptions | Do not claim complete assurance where any historical RPC, oracle, configuration/governance policy or evidence obligation is inconclusive |

### Evidence provenance versus per-phase execution verdict — mandatory for Lite reviews

**Never turn a missing NEW simulation into a claim that earlier independently
supported behavior is disproven or wholly unverified.** Every material candidate
must retain two separate axes:

- **Evidence-backed security conclusion:** which behavior was reproduced or
  falsified, with exact source, EVM environment (synthetic fixture vs authenticated
  historical Anvil), actors, limits, and original raw evidence references.
  A previously proven *conditional* behavior remains a conditional behavior.
  Neither an isolated fixture nor a read-only historic role lookup proves live
  exploitation or governance authorization.
- **Current-phase execution result:** whether this particular Phase-5/6
  target/harness ran against the required pinned, archive-backed local Anvil,
  and its actually executed receipts, assertions, and runner identity.
  `DEFERRED_UNVERIFIED`, `NOT_EXECUTED` and `INCONCLUSIVE` remain correct for
  missing NEW execution, **without erasing the prior evidence**.

Controller-generated Phase-6/8/10 output carries
`automationOutputs.candidateEvidenceContinuity`, built from reviewer-recorded
Phase-5 reconciliations and separately recorded Phase-6 execution/proof status.
Do not map `X001-*` discovery IDs to `CAND-*` phase target IDs by positional
order; only use an exact unique source-anchor binding, otherwise mark unlinked.
This continuity output is not new machine proof, does not override a verdict,
and does not authorize a test.

Generated reports must derive unresolved questions from nested
`targetDispositions`, `candidateProofRecords` and `BLOCKED_CARRIED`
obligations, not solely fields literally named `unresolved`. Never print
`NONE_IDENTIFIED` when those nested records contain unresolved risks.

**DAI campaign r2 owner restriction:** no new candidate, fuzz, fork,
master-targeted, or baseline test requests or executions for the remainder of
`live-ethereum-dai-6b175474-r2`. The existing owner deferral remains binding.
Use only the admitted raw evidence and its verified provenance for downstream
review. Controller/master correction of an evidence classification must not
trigger a simulation or rewrite sealed historical proof. Unresolved historical
governance policy remains explicit and cannot be converted to a safe result or
silently erased to obtain a terminal COMPLETE.

### Exact GitHub-connector procedure for an authorized existing execution

Read the target workflow's `on:` path filter before modifying the corresponding **existing** request file. Identify the canonical `curveyield3/Audit-Controller` request and bound source SHA/receipt. If the audit owner authorized this specific test run, write/update only the expected `curveyield3/Contract-Automation` request, record its full commit SHA, then look up `https://api.github.com/repos/curveyield3/Contract-Automation/actions/runs?head_sha=<SHA>&event=push`; select only the exact expected workflow. Read its job steps/logs and published controller receipt. A green Actions run does not establish controller PASS. Missing local binaries are irrelevant; missing secret projection, frozen block/hash, local fork session, or mined assertions are genuine failures. Do not resubmit the same rejected request without a concrete correction and renewed permission.

### Historical-RPC failure triage order

Use the failed run ID, current runner commit, controller packet and the **specific** failing job step. Check secret-to-environment projection (presence only; never print credential), upstream `eth_chainId`, `eth_getBlockByNumber` at the exact pin, `eth_getCode` at the recorded deployed target, local Anvil launch/chain/hash, RPC proxy behavior, local writable methods, actual ABI receipts, executor ownership, and artifact ingestion. dRPC's `eth_getLogs` range limit is separate from archive-state availability; use complete bounded log ranges with receipt reconciliation when log evidence is required. If the runner repair postdates the failed job, the old error is **stale evidence**, not proof the repair failed; never self-trigger a new run when prohibited.


Authoritative Audit V7 full simulation uses Anvil only.

The approved Ethereum archive credential is the existing **GitHub Actions secret `RPC_ETHEREUM`** (the provided dRPC archival endpoint). The trusted `audit-controller-execution.yml` job maps it to **`ETHEREUM_FORK_RPC_URL`**, the environment profile consumed by the existing Anvil-based V7/Phase-6 engine.

**Required simulation behavior:** launch the existing local ephemeral Anvil fork with that upstream credential and a pinned historical Ethereum block; verify chain ID, pinned block number/hash, deployed address/code, and required archive state; run actual ABI actions on the isolated Anvil fork. Anvil's local writable fork and dRPC's upstream historical state are complementary, not alternatives. No transactions may be broadcast to mainnet.

If a reviewer claims an archival endpoint is missing, check the existing `RPC_ETHEREUM` → `ETHEREUM_FORK_RPC_URL` workflow mapping, workflow run ID, pinned-block access and Anvil readiness **before** declaring the tests impossible. Do not create a synthetic substitute, custom unauthenticated RPC URL, or another per-campaign workflow.

**Historical log-query recovery (observed DAI r2 failure):** the configured dRPC endpoint can service historic `eth_call`, `eth_getCode`, and block queries while rejecting `eth_getLogs` ranges of more than 10,000 blocks (`RPC code 35`, `ranges over 10000 blocks are not supported on free plan`). This means the archive endpoint IS available. For a requested historical role/event reconstruction, partition the full inclusive requested block interval into bounded contiguous chunks of at most 9,000 blocks, retry only failed chunks, verify that every interval is covered and each event has the actual receipt, deduplicate strictly by chain + transaction hash + log index, and reconcile against contract mapping getters on the pinned Anvil fork. The trusted runner may also use an authenticated established explorer/indexed log route with complete range coverage when the RPC restricts log requests; record provider and any missing ranges. Never classify a provider `eth_getLogs` range-limit response as `NO_ARCHIVE_RPC`, silently treat missing logs as zero events, or drop the historical completeness requirement. Archive-state access and historical log-index retrieval are separate capabilities.

**Phase-5 fork-lifecycle + fuzz adapter (DAI r2 failure repair):** A Phase-5 V7 execution request with `phaseId: "fork-simulation-lifecycle"`, `simulation.chain: "ethereum"`, a pinned historical `simulation.block`, and `analysis.nativeFuzz.enabled: true` is NOT an archive-RPC-unavailable case. The controller workflow already injects `secrets.RPC_ETHEREUM` as `ETHEREUM_FORK_RPC_URL`. The trusted V7 runner must first pass its historical dRPC/Anvil preflight, then create a separate short-lived **local Anvil RPC session using the same approved dRPC upstream and exactly the preflight-verified historical block/hash**, pass the local URL to Foundry and to Medusa only when explicitly requested, run source-bound tests, close the local session, and preserve actual machine results. The deterministic lifecycle simulator independently uses the same approved historical dRPC upstream and pinned block. A missing `phase6MutableRpc` adapter in an otherwise authenticated/available run is **runner wiring failure `MUTABLE_RPC_CONFIGURATION_FAILURE`**, not evidence of an unavailable dRPC archive secret. Never mark that as `NOT_APPLICABLE`, alter audit findings, or replace historical state with latest-state or source-only mocks. **Arbitrary/native fuzzing is not mandatory for Phase-5 candidate reproduction, and there is no 100000-run minimum.** A deterministic source-bound Anvil workflow with a candidate-specific exploit oracle can satisfy the selected ANVIL_WORKFLOW method without Foundry/Medusa fuzzing. If the reviewer explicitly selects Foundry/Medusa or candidate-guided fuzzing, it still requires a genuine bound harness, nonzero executed assertions and raw evidence; runner wiring alone is not test evidence. Existing frozen campaigns and already-materialized execution requests are not silently rewritten by this policy change.

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
5. whether the repaired runner is the one actually used by the failing execution.

Do not silently change audited source to compensate for runner infrastructure failures.

## Final browser-agent rule

Use GitHub as the durable workstation.

Do not ask the human to manually perform work that the GitHub connector and existing Actions infrastructure can perform.

Do not invent parallel tooling when the repository already has a canonical implementation.

Operate from current repository authority, preserve exact identities, execute through existing trusted lanes, and leave durable evidence that the next browser agent can resume.
