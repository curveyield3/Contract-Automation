# CurveYield Standalone Security Intelligence — clean fork v1

Source baseline: `curveyield3/Contract-Automation` @ `8e0a73c96286c25a06a1ca5fbfbb7009287a63ed` (primary source read-only).
Location: `security-intelligence-phase0/` on `machine-intelligence-audit-controller-v1`.
Dedicated workflow: `.github/workflows/security-intelligence-phase0-v1.yml`.

All previous standalone fork-specific implementations were discarded. A fresh copy of the current primary source collector, runner, taxonomy and required scripts has been made **inside** this folder. Primary files were not changed. The collector was adapted only to consume a locally SHA-verified ZIP.

## Usage

Create `requests/active-request.json` from `requests/REQUEST_TEMPLATE_v1.json` with actual source commit and archive SHA-256, then commit it to the standalone branch. The existing push trigger starts the two-job source preflight. The active request was intentionally removed during this reset to avoid running against an obsolete archive.

The trusted admission job downloads the source ZIP, verifies its Git blob, SHA-256, size and toolchain plan without executing source. The isolated collector builds source-blind tooling before obtaining the ZIP; it has no network access, controller credentials, writeable root or privileges. Compilation private cache is disabled. Source compilation, Slither, Wake, Mythril and source evidence are reported exactly; partial native results produce warnings, never a false security verdict. Wake 4.21.0 runs its built-in Solidity detectors on source-only, isolated copies of the exact compiled source units (no source-authored Python detector plugins, wake.toml, tests or deployment). Its Solidity compilers are prepared and checksum-verified before the network-disabled collection job. Wake is not applicable to Vyper-only source; that limitation is reported explicitly.

Mythril 0.24.8 runs offline bytecode-level symbolic execution on every executable in-scope Solidity runtime artifact from the exact admitted build, using the source-bound audit-scope.json, without recompiling, onchain reads, deployment, tests or source-authored scripts. Its deliberately bounded configuration is 2 symbolic transactions, 64 maximum depth, 12 seconds execution time per contract and a 3-second SMT query bound. This is a finite static candidate-discovery scan, **not** full state-space verification or deployed-state analysis. The native report records exact contract/bytecode identity, per-contract completion, raw symbolic issues and explicit reasons for ineligible interfaces/abstract code or unresolved library links. Unlinked bytecode is never silently treated as scanned.

## Native detector evidence

The existing collector emits `SLITHER_v1.json`, `WAKE_v1.json` and `MYTHRIL_v1.json` separately. `WAKE_v1.json` includes detector descriptions and source locations, impact, confidence, suppressed flags, compilation-unit coverage and errors. `PREFLIGHT_MANIFEST_v1.json` records `wakeStatus`, Wake findings and any incomplete scanner warnings; collection is not complete when Wake or Mythril fails on an eligible Solidity project. Static detections are investigation leads, never automatic confirmed vulnerabilities.

## Not yet implemented

The clean baseline implements the original standalone source preflight only. MiMo configuration, fork deployment, C2 state transfer, deployed-state Slither, Medusa, local Certora, AutoProver, final extended reporting and persistent toolkit caching are **not** implemented. Implement them in the existing v16 order, with native tools before caching. No opt-in switch, external approval provider, new external service, or extra workflow was added.

## Isolation

Only the standalone fork directory and its dedicated workflow were replaced. Original primary files, other forks, shared workflows, controller records and source archives remain unchanged. No smart-contract tests or deployments are run by this reset. Previous fork history remains recoverable from Git.
