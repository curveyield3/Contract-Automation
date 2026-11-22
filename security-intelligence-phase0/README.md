# CurveYield Security Intelligence — Standalone Phase 0 (fork v1)

**Owner:** Contract-Automation's isolated `machine-intelligence-audit-controller-v1` branch.
**Purpose:** a small non-semantic source intelligence preflight for the standalone 11-round v5 security skill, NOT Machine Intelligence's campaign controller.

## What was forked and why

The collection and original compiler metadata extractors are forked by immutable Git blob from
`machine-intelligence-phase0-deterministic-extraction-fork-v1/`, itself an isolated copy of the
Lite-Solo Phase 0 source collector. This directory holds its own `package.json`, lockfile,
`packages/`, and `scripts/` dependencies. No forked code imports original repository
runtime paths; all import-relative paths resolve within this fork.

The independent workflow is `.github/workflows/security-intelligence-phase0-v1.yml`.
It does not call the original bootstrap, Cloudflare Worker, controller receipts, phase
finalizer, Anvil deployment scripts, test runner, fuzzers, or campaign handoff.

The old isolated fork's executable admission is intentionally blocked pending qualification
for its OS execution policy; this standalone collector does **not** activate or bypass
that fork. Instead, it runs a **different, narrower non-deployment workload** inside a
Docker sandbox with network disabled, read-only root filesystem, dropped capabilities,
no privileges and no source-access credentials. Its image is prepared before the source
archive is downloaded. The source archive is admitted in a separate trusted job and
is mounted read-only into the unprivileged collection container.

## Input and trigger

Only a pinned GitHub repository ZIP is currently supported. The source ZIP must live in its
**own** repository, never Contract-Automation (which is not contract source storage).
Use the schema in `requests/REQUEST_TEMPLATE_v1.json`. The source `commit` must be an exact
40-character SHA and the archive SHA-256 must be computed from the exact ZIP bytes.

With GitHub permission, create or update the one triggering file
`security-intelligence-phase0/requests/active-request.json` on this isolated branch.
A push to that path starts the existing standalone workflow automatically.
Do not create `active-request.json` with placeholder fields or use `main`.

## Evidence delivered

An Actions artifact named `security-preflight-evidence-<runId>-<attempt>` contains:

- `DISCOVERY_SUMMARY_v1.md` — human-readable summary and unverified assumptions.
- `PREFLIGHT_MANIFEST_v1.json` — source digest, build, completeness and artifact hashes.
- `SOURCE_INTELLIGENCE_AUTOMATED_v1.json` — structural contract/function/call/storage data.
- `REVIEW_INVENTORY_v1.json` and `SYSTEM_FACTS_v1.json` — source-based coverage denominator.
- `BUILD_AND_SOURCE_IDENTITY_v1.json`, `PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json`,
  `CONTRACT_IDENTITY_INDEX_v1.json` — compiler provenance and ABI/bytecode identity.
- `SLITHER_v1.json`, `SLITHER_RELATIONAL_FACTS_v1.json` — neutral analyzer observations.
- `SBOM_v1.json`, `PROJECT_READINESS_AUTOMATED_v1.json` — dependencies and deployment inventory.
- `PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json` — **discovery-only placeholder**, not a deployed-fork proof.

No source ZIP is published as a preflight result and no source-code files are written into
Contract-Automation. CI artifacts are GitHub-hosted and expire per workflow retention rules.

A successful GitHub run is not a finding and not an audit pass. The skill must inspect the
manifest, source identity, review inventory, and limitations before using its results.
If compilation fails or analyzer tools are unavailable under offline isolation, publish
partial evidence and explicitly mark the unsupported analyses instead of inventing results.

## Source and build security

- Admission: separate job uses read credential for exact committed ZIP, compares SHA-256.
- Toolchain: prepared from trusted Git branch before receiving the user-supplied ZIP.
- Collection: Docker `--network none --read-only --cap-drop ALL --security-opt no-new-privileges`,
  unprivileged host UID, no GitHub token, no Docker socket, only input ZIP + output directory.
- Strict limits: ZIP <= 16 MiB, runtime memory 6 GiB, PID limit 256, CI job limits.
- Some source-defined compilers or dependency installs may require network access and will be
  **unavailable** inside this container. Do not temporarily reenable network for a failing package.

## Non-goals

No tests (unit, fuzz, fork or integration), no source-defined deployment execution, no
new controller, no campaign initialization, no durable storage of deployment packages
in Contract-Automation, and no edits to the current Machine Intelligence v8 skill/receipts.

The GitHub workflow, permissions and container setup have not been executed or operationally
qualified by simply committing this source. A real authorized Phase-0 run must be verified
against its actual job logs and artifacts before claiming production readiness.

## Reconciliation with the live Machine Intelligence Phase 0 (21 November 2026)

Verified source baseline: `curveyield3/Contract-Automation@fe4d778ff28b842cc2918e828ef829dcba660cd0` on
`machine-intelligence-audit-controller-v1`. This is the **actual current live** Phase 0
source, not an assumed historical release. The live workflows are:
`.github/workflows/lite-solo-cloudflare-phase0-bootstrap-v1.yml` and
`.github/workflows/lite-solo-cloudflare-phase0-intelligence-v1.yml`.

The standalone fork starts from the *additional* isolated deterministic-extraction copy
on the same branch. File-by-file SHA comparison against the current live paths showed
77 matching copies among 91 shared paths before this reconciliation, plus 14 divergences.
The changes in this reconciliation synchronize the copied AI transport helper exactly to
the current live Git blob and restore the live scanner bound of **64 compiler units** in
the forked build dispatcher, while retaining compilation-unit-qualified identities.
Afterward, 78 paths match exactly and 13 have documented deliberate differences:

| Fork-only difference from live source | Why it is retained |
| --- | --- |
| `README.md` | Standalone workflow instructions |
| `packages/github-native-sim/src/adr-flow-plan-v1.mjs` | Source-context-bound graph investigation support inherited from isolated fork |
| `packages/github-native-sim/src/lite-solo-phase0-intelligence-v1.mjs` | Retains current build, SBOM, Slither, Source Intelligence and readiness discovery; **adds** compiled contract identity, separate relational Slither facts and mandatory review inventory; replaces authenticated source checkout with verified local ZIP |
| `packages/github-native-sim/src/phase0-execution-input-v2.mjs` | Adds exact compilation-unit identities, immutable references and metadata |
| `packages/github-native-sim/src/phase0-private-build-cache-v1.mjs` | Intentionally disables private production build-cache credentials |
| `packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs` | Isolated-fork experiment only; **not executed by standalone Phase 0** |
| `packages/runner/src/build-dispatch.mjs` | Compiled artifact identity is qualified by compilation unit; restores live 64-unit input limit |
| `packages/runner/src/compiler.mjs` | Adds compiler immutable and generated-source metadata |
| `packages/runner/src/embedded-profile-build-v1.mjs` | Adds compiler immutable and generated-source metadata |
| `packages/runner/src/native-build.mjs` | Disambiguates repeated sources and multi-unit AST identities |
| `scripts/lib/lite-solo-phase-prefill-v1.mjs` | Additional isolated-fork graph mapping; **not invoked by standalone preflight** |
| `scripts/run-phase0-fork-deploy-config-v1.mjs` | Isolated-fork-specific deploy implementation; **not invoked by standalone preflight** |
| `scripts/write-phase0-fork-deploy-outputs-v1.mjs` | Isolated-fork-specific receipt writer; **not invoked by standalone preflight** |

The original live Phase 0 also has a **separate on-fork deploy/configuration job, a
controller finalizer, phase receipts, and a Worker callback**. The standalone preflight
deliberately does not include those workflows: it is a pre-audit **data collector only**,
not an exact clone of the production end-to-end campaign initializer.

Every matching shared runtime dependency (including the current Source Intelligence
generator, review inventory builder, taxonomy, lockfile, and local actions) is at the
same exact Git blob as the live source as of the above baseline.

This is source-code parity evidence, **not execution qualification**. The isolated
Docker build and package-specific compilation still require actual authorized GitHub
Actions run evidence to establish operational success. No Solidity tests, deployments
or automated campaigns are authorized or executed by this reconciliation.


## Standalone Phase 0 — Stage 1 portability revision v2 (November 2026)

This revision is **standalone-fork only**. It does not modify Machine
Intelligence v8, the original Lite-Solo Phase 0 workflows, or campaign
controller authority. The workflow path and v1 output names remain stable so
installed v5 security skills can consume them without a breaking rename.

### Declarative, source-bound preparation (no source execution at admission)

The trusted admission job SHA-verifies the ZIP and reads package manifests,
Solidity/Vyper version directives and project configuration as inert data.
A bounded toolchain plan is published separately from the source ZIP.
The collector job receives **only that data plan**, then builds its toolchain
with available compiler versions and version-locked npm dependencies.
The original ZIP is downloaded only **after** the image has been built.

The preparation script refuses unsupported dependency schemes and does not
execute package lifecycle scripts. Unsupported versions, missing pins or
download failures remain explicit source-only/partial limitations; neither the
image builder nor the source sandbox silently fetches unknown resources.
The source sandbox retains no network, no tokens, read-only root, dropped
capabilities and no privilege escalation. Exact package manifest and lock
hashes are verified a second time before preinstalled dependencies are copied
into the isolated extracted source.

### Project-root and language coverage

The scanner recognizes both Solidity and Vyper, including Vyper-only
packages, roots at \`src/\`, \`contracts/\` or project root, and independently
configured nested projects. **Every admitted source file** appears in
\`SOURCE_ADMISSION_INVENTORY_v1.json\` with SHA-256 and import syntax, even
when compilation is unavailable. The collector chooses one primary project
for the full compiled AST/Slither path and explicitly lists any additional
roots not compiled. An uncompiled root is not claimed as compiler-reviewed.

Native Foundry compilation is attempted unchanged first. If the source's
original build fails, the copied adapter can try bounded individual source
roots identified generically from local declaration/import relationships.
No BoostHub-specific filename or contract-name branch is used. Successful
independent compiler units are labeled as such; they are **not proof of an
original whole-project build**. Uncompiled units and source-only gaps are
retained in the reported limitations.

### Partial evidence is a first-class outcome

If build configuration or compilation cannot be resolved, the exact source
identity and source admission inventory are still published. The existing
\`BUILD_AND_SOURCE_IDENTITY_v1.json\` and
\`SOURCE_INTELLIGENCE_AUTOMATED_v1.json\` report unavailable compiler
evidence and never fabricate ABIs, ASTs, bytecode or semantic flow coverage.
The summary and manifest must report \`PARTIAL\`, not \`COLLECTED\`. The
workflow gate permits this source-only data handoff only when the ZIP digest
and complete textual-source inventory are verified. Passing the GitHub
workflow is not passing a security audit.

The pre-existing \`REVIEW_INVENTORY_v1.json\`, \`SYSTEM_FACTS_v1.json\`,
Slither and contract identity artifacts continue to be generated only when
their required compiled evidence is available. Partial source inventory can
support audit scoping, but cannot satisfy v5's source-traced function-coverage
or economic-security conclusions.

### Scope and verification

- Only the forked standalone workflow and dependencies are edited.
- No new contract tests, fuzzers, deployment scripts, campaigns or controller
  receipts are added or executed by this implementation.
- Source-authorized compilation and static analysis remain part of the
  original preflight workflow, not a new testing system.
- Stage 1 adds one data-only toolchain prepass and one source admission
  inventory because the prior image was BoostHub-pinned and failed to retain
  source evidence when compilation was unavailable.
- Runtime behavior is **not** established by a successful code commit.
  Before production use, compare actual run logs and evidence artifacts for
  both a known baseline and a structurally different package; no test execution
  is implied or authorized by this documentation.


## Stage 2 — normalized entrypoints and source-state evidence (v3)

The existing standalone preflight's successful compiled path now enriches
\`SOURCE_INTELLIGENCE_AUTOMATED_v1.json\` **after** it writes the same source-bound
\`REVIEW_INVENTORY_v1.json\`. This reuses original compiler, AST, Vyper analysis,
and review-inventory context work; it does **not** add a second scanning engine.

- **\`effectiveEntrypoints\`** enumerates the compiler ABI of every *deployable,
  in-scope* artifact with a compilation-unit-qualified identity, including
  payable/fallback/receive operations. State-changing entries form an objective
  Round-2/Round-11 **coverage denominator**; this is not a declaration count,
  deployed-state attestation, or proof of invocation reachability.
- **\`implementationOrigin\`** distinguishes source-backed direct, inherited,
  generated getter, ambiguous, and unresolved ABI items. Every unresolved
  origin stays unresolved; the agent must trace it from actual source rather
  than accepting a source-name guess.
- **\`stateDeclarations\`** projects AST-backed state/constant/immutable
  declarations with source lines and compiler types where available. Compiler
  storage slots and offsets are included **only when emitted by the compiler**;
  the existing \`storageLayout\` field remains compiler-layout evidence alone.
- **\`stateEffects\`** mirrors source-review contexts' per-function
  state reads/writes with source anchors and inherited \`effectiveIn\`
  relationships. Effects are **local syntax observations**, not a
  transitive call-flow simulation or proof of economic consequences.
- Vyper functions gain source anchors when the existing compiler-backed
  Vyper structural AST matches their ABI; structural sensitive-call
  observations appear as explicitly unresolved call/interface candidates.
  Vyper state-read completeness and semantic Slither detectors are **not**
  claimed.

The existing \`DISCOVERY_SUMMARY_v1.md\` now groups effective state-changing
entrypoints by deployed-capable first-party artifact, with implementation
origin, line reference, and compiler unit. This is the quick navigation surface
for v5 Rounds 1–2; the full JSON remains the authoritative machine data.

The Source Intelligence digest is recalculated after adding these fields so
the enriched document's provenance stays consistent. The scope/tier data comes
from the existing source review inventory, not repository or contract names.

**Known boundaries:** Uncompiled additional roots stay marked unavailable;
ABI-only and ambiguous mappings require manual interpretation; no storage
slot or direct-effect completion is fabricated. The preflight has not run
any user-contract tests, fork deployments, or exploit trials.


### Stage 2 v4 Vyper evidence-preservation correction

Artifact inspection of the first Stage 2 BoostHub collection revealed that the
source-bound Vyper AST correctly emitted \`stateWrites\` and \`sensitiveCalls\`,
but the generic Solidity review-context traversal replaced those entries with
empty arrays. The fork-owned review-inventory writer now preserves Vyper
compiler-AST contexts, state writes, and source anchors, and no longer
classifies mere \`convert(...)\` builtins as external-message calls.

The Vyper compiler-AST analyzer additionally projects module-level state,
constant, and immutable declarations with exact source-line syntax. Their
types are recorded as syntax, not fabricated compiler storage layout; Vyper
state reads remain incomplete and require manual reasoning. Raw static
observations, exact source identities, and language limitations are retained.


### Stage 2 v5 Vyper internal function ownership

The compiler-backed Vyper function inventory excludes indented interface
signatures from the concrete module's implemented method list. The unified
Source Intelligence index additionally includes Vyper *internal* source-only
functions and their anchored bodies, separate from ABI-authorized external
entrypoints. Parameter lists for internal source-only functions are labeled
unresolved rather than asserted as compiler ABI signatures. This allows
Vyper internal \`raw_call\` sites to retain real caller-function ownership.


## Stage 3 — source-flow-prioritized Slither evidence

Stage 3 keeps the existing Phase 0 workflow, compiler pass, review-inventory builder,
and raw Slither outputs. It adds a deterministic navigation layer to the existing
SOURCE_INTELLIGENCE_AUTOMATED_v1.json, REVIEW_INVENTORY_v1.json, and
DISCOVERY_SUMMARY_v1.md outputs.

- staticRecon.slither.candidateIndex now retains each raw detector's per-run
  candidate ID, stable content-fingerprint ID, and Slither finding ID,
  impact/confidence labels, source anchors, resolved contract/function identities,
  direct local state/privilege/value-flow context, and source-call-graph path
  candidates to compiler-effective ABI entrypoints. Per-contract priority counts
  are calculated from each contract's own source anchors, using the highest
  priority reached by that detector within that contract, not copied from another
  contract's anchor or the detector's overall queue priority.
- staticRecon.slither.prioritization records the priority policy, per-priority
  counts, mapping coverage, contract grouping, unresolved IDs, limitations, and
  a digest of the derived index.
- REVIEW_INVENTORY_v1.json adds payload.slitherTriage, a compact per-contract
  review queue that links back to the canonical candidate IDs in Source Intelligence.
- DISCOVERY_SUMMARY_v1.md is the concise agent navigation surface: build and
  coverage facts, significant contracts and entrypoint counts, state evidence,
  prioritized Slither observations, contract groupings, and exact evidence hashes.

The order is deliberately conservative: P1 is reserved for High/Critical Slither
labels with a source call-graph path candidate to a state-changing effective ABI
entrypoint; P2 covers other state-changing-path candidates or High/Critical
in-scope observations without a resolved path; P3 covers other in-scope observations;
P4 covers dependency-only or unresolved observations. Tie-breaking is deterministic
by impact, confidence, source path, source line, and original detector order.

No finding is promoted. Slither impact/confidence remain analyzer labels;
source call-graph links are structural path candidates, not proof of runtime
reachability, dynamic dispatch, or deployed behavior. The auditor still assigns
semantic F# flows in Round 2 and adjudicates every candidate through the existing
eleven rounds. The full SLITHER_v1.json and SLITHER_RELATIONAL_FACTS_v1.json
remain unchanged and are included in the evidence manifest by exact SHA-256.

Stage 3 does not add workflows, tests, deployment actions, contract-specific rules,
a second scanner, or another audit round. The existing artifact names and
eleven-round v5 handoff remain compatible. Operational qualification requires
the existing BoostHub v55 regression and a structurally different source package.

## Fork-only Phase 0 coverage repair — v4 (22 November 2026)

This change is strictly confined to `security-intelligence-phase0/`. The
primary `packages/`, Machine Intelligence controller, original workflows,
production contracts, and pinned user-source ZIP are unchanged.

- The existing Vyper 0.4.3 compiler-AST visitor now retains `ExtCall` and
  `StaticCall` wrappers, low-level external calls, source-only internal-call
  ownership and state references. A state reference at an assignment target
  does **not** establish a true read; all call candidates require review.
- The existing review inventory preserves these observations and source
  anchors, including unresolved internal callee identities.
- Stage 2 now attempts unique source name/arity reconciliation for Solidity
  structs/interfaces, Vyper default-argument ABI variants, public mapping
  getters and inherited compiler-AST implementations. It records the exact
  matching basis and does not invent an implementation on ambiguity.
- Exact source-bound compiler output includes Foundry `storageLayout` and
  Vyper `layout` where supported. No slot is inferred from declaration order.
- The existing evidence manifest identifies independent capability gaps and
  lists unresolved state-changing ABI origins. The existing Actions job emits
  a **warning**, not a new hard workflow gate, when data collection is partial.
- The installed Security Intelligence **v9** audit skill retains final Phase 0
  gate authority. `PARTIAL` evidence, a green Actions run and an artifact
  upload never satisfy the skill's gate; Slither 0.11.6's missing Vyper 0.4.3
  semantic detectors remain an explicit limitation.

The existing workflow path and output filenames are preserved. The only
permitted execution is existing Phase 0 source compilation/static inspection.
There are no added tests, deploys, fuzzers, or audit-controller systems.

## Automated Security Pipeline v1 — implementation guidance from specification v14

The Automated Security Pipeline is **v1**; **v14** names only the implementation specification. This repository's standalone Phase 0 request retains `runMode: SOURCE_PREFLIGHT` and its original immutable `source` fields. The **request template** documents `extendedSecurityPipeline: false` as the safe opt-out default. Setting it to `true` requests additional analysis; it does **not** grant permission to execute deployments, native source, local models, fuzzers, or prover workloads. The optional `qualificationProfile` describes a desired, separately accepted scope; empty `profileId`, `authorizationRefSha256`, `requestedOperations`, and `allowedChainIds` are examples only and never establish authority. Do not fabricate an authorization hash or reuse credentials from another controller.

An operator initiates the existing workflow by intentionally updating `security-intelligence-phase0/requests/active-request.json` in a **separate, explicitly authorized request action**. Code implementation commits must not edit that file, broaden the existing push-path trigger, change `main`, or modify the original MI controller. The extended pipeline is optional and must preserve original source-ZIP SHA-256 admission, source-blind toolchain preparation, and the network-disabled read-only collection container. Failed optional diagnostics produce field-specific Actions warnings and matching redacted after-workflow artifacts; unsafe or unavailable individual operations are `NOT_EXECUTED`, not silently authorized or claimed complete.

While implementing against `machine-intelligence-audit-controller-v1`, resolve the live branch HEAD and actual file blobs immediately before each edit. Reconcile other agents' changes semantically, reuse compatible existing stages/scripts, publish only a fresh-parent non-forcing commit, and verify the committed files. Do not reset to historical plan SHAs. Every running Actions job uses the **immutable** `${{ github.sha }}` checkout and binds evidence to the original archive digest plus `github.run_id` / `github.run_attempt`; new implementation commits must never alter a running audit's source identity or mix evidence from separate attempts. Toolkit caches are keyed by independently verified component inputs, not by the moving branch HEAD. This section explains implementation behavior, not an extra runtime approval gate.

## Automated Security Pipeline v1 — implemented stage inventory (implementation specification v14)

The running system is **Automated Security Pipeline v1**. The separate document **Implementation Specification v14** governs work order and repository concurrency; it is not a pipeline or analyzer version. Implementation takes place only on `machine-intelligence-audit-controller-v1`, with each new commit based on freshly observed branch HEAD. The original request-file trigger, source ZIP admission, source-blind toolchain build, network-disabled source collector, and original Machine Intelligence controller authority remain unchanged.

**Currently source-visible job IDs:** `admit`, `collect`, `prepare_targets`, `toolkit_prepare`, `toolkit_qualify`, `mimo_configure`, `fork_setup`, `storage_inspect`, `medusa_analyze`, `wake_analyze`, `mythril_analyze`, `prover_qualify`, `mimo_provider_qualify`, `autoprover_run`, `reconcile`, `qualify_release`, `publish_warnings`. The 15 stage IDs G0/G1/G2/G2T/G2A/G2B/G2C/G2D/G3/G4/G5/G6/G7/G8/G9 are represented by their source or native-evidence program owners. All opt-in diagnostic jobs use `extendedSecurityPipeline:true` as a request to perform safe source-bound discovery. Admission's separate `extended_approved` disposition remains necessary before any controlled MiMo inference or other unsafe native operation. A request-provided hash, a cached executable, and a green GitHub Actions job do not establish execution authority. Until independent authority is actually accepted, affected native operations are `NOT_EXECUTED` and issue exact warnings, while safe independent source evidence work continues.

**MiMo reuse:** G2A reads the model revision, model SHA-256, CPU llama.cpp commit and filename directly from the existing read-only `.github/workflows/lite-solo-ai-inference-v1.yml`. Its standalone `security-pipeline-mimo-v1.mjs` calls the same loopback-only alias `lite-solo-mimo-v1` at `127.0.0.1:8080`, limited to one typed model response per eligible target and bounded request size/time. It does not call or impersonate the Machine Intelligence controller's private Worker, leasing, tailnet or continuation. The job owns and terminates its local model process. Model prompts/replies remain in job-private scratch and are not published in the public warnings artifact; a separately accepted restricted evidence channel is still needed for durable round recovery.

**Specialized toolkit:** ten fixed component IDs have distinct cache identities. The same pinned MiMo GGUF can be downloaded from its trusted revision, checked against original SHA-256, cached under an exact component key, and independently rechecked in each consumer job. A verified warm cache is not inferred from cache-service success alone. Unpinned external components such as Wake, Mythril, Medusa, Certora Prover and AutoProver report unresolved exact native pins until independently qualified. The source archive, contract bytecode and C2 state are never stored in the universal software cache; the original Phase 0 private compilation cache stays disabled.

**Native handoffs:** G2B, G2C and G2D currently produce source-bound fork deployment/configuration discovery, compiler-linked storage query candidates, and Medusa eligibility/exclusion records. They **do not** run a source deployment script, restore a C2 checkpoint, perform a storage RPC read or run a Medusa campaign merely because a plan exists. Existing controller-shaped fork deployment APIs cannot accept an arbitrary standalone preflight directory as a trusted controller receipt. Actual approved local fork identity, source script SHA, protected egress, funding/configuration readback, C2 verification and native tool/Medusa property eligibility must be separately established before corresponding native execution can be reported.

**After-workflow evidence:** the existing always-attempted `publish_warnings` job consolidates stage-owned warnings into `security-pipeline-warnings-<runId>-<attempt>` containing `SECURITY_PIPELINE_WARNINGS_v1.json`, `SECURITY_PIPELINE_WARNINGS_v1.md` and `SECURITY_PIPELINE_STAGE_STATUS_v1.json`. Each names the field, observed and expected values, the affected target/operation where known, the concrete consequence and required correction. Never equate an uploaded artifact with controller acceptance or a completed security audit. The G3 Wake, G4 Mythril, G5 local Certora Prover, G6 Composer provider and G7 AutoProver jobs now classify actual original source targets, ABI and bytecode eligibility, with explicit missing original program-source/CLI/binary/solver pins. They do **not** execute an unqualified binary, infer findings from an absent native output, or create tests. G8 reconciles original stage/native evidence and actual metrics; G9 emits an honest release-status artifact. Native analyzer execution, formal-prover qualification and private accepted C2 handoff remain incomplete until independently verified prerequisites exist.

## G6 original AutoProver provider-compatibility decision (pipeline v1)

This is a **conditional, out-of-tree source adapter**, not a Certora fork, new AI engine or completed native qualification. The following construction decision is grounded in original upstream source at **Certora/AutoProver commit `81d9626c249a70c0a0f0648a89de175443c0344c`** (read-only upstream; verify live SHA and interfaces again before native installation):

- **EXISTING_MECHANISM_REVIEWED:** `composer/llm/registry.py` exposes `ProviderSpec` through entry point `certora.autoprove.llm_provider`; `composer/llm/provider.py` defines `ProviderService`, `ModelProvider`, `ProviderSpec` and callbacks. The original `composer/llm/openai.py` handles named GPT/O models and routes document uploads through the external OpenAI Files API rather than a pinned localhost-only source path.
- **PROVEN_CAPABILITY_GAP:** Model alias `lite-solo-mimo-v1` is not recognized by that built-in provider; the original public OpenAI uploader would breach the intended local-only/private-source boundary. Merely changing an API base URL neither registers the new alias nor provides safe document semantics.
- **WHY_MINIMAL_EXISTING_MODIFICATION_IS_INSUFFICIENT:** Upstream Composer/AutoProver files are strictly read-only in this implementation, and changing the private Machine Intelligence lease protocol to impersonate an existing MI campaign is prohibited. Its supported provider entry point is the documented and narrower interface.
- **ADDED_FILE_SINGLE_RESPONSIBILITY:** The two files under `security-intelligence-phase0/autoprover-local-provider/` register exactly one fixed `ProviderSpec` for the existing model alias; the Python module implements `ModelProvider` and `ProviderService`, fixed `127.0.0.1:8080/v1` Chat Completions, original-like memory tool, zero remote model-token billing with separate runner telemetry, explicit UTF-8-only document inlining, and rejection of PDF/binary documents and oversize context instead of silent loss or remote upload.
- **REPLACED_OR_SUPERSEDED_IMPLEMENTATION:** None. No original Composer prompt, agent, prover, memory engine, or private MiMo script is copied, overwritten, or removed.

**G6 remains `NOT_EXECUTED` for native qualification:** provider registration/import, actual Composer memory/tool calls, context capacity, local model server, original document behavior and native retry semantics have not been exercised. Unsupported binary/PDF context remains an explicit scope limitation. The provider package is not automatically installed or used as trusted execution authority; it can be installed only in an independently approved, source-pinned Composer environment. G7 may not claim formal proof, generated specs or a completed AutoProver run from the mere presence of these files.
