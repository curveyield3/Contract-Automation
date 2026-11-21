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
