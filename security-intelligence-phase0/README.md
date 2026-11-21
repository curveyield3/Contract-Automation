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
