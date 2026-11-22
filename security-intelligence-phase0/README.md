# CurveYield Standalone Security Intelligence — clean fork v1

Source baseline: `curveyield3/Contract-Automation` @ `8e0a73c96286c25a06a1ca5fbfbb7009287a63ed` (primary source read-only).
Location: `security-intelligence-phase0/` on `machine-intelligence-audit-controller-v1`.
Dedicated workflow: `.github/workflows/security-intelligence-phase0-v1.yml`.

All previous standalone fork-specific implementations were discarded. A fresh copy of the current primary source collector, runner, taxonomy and required scripts has been made **inside** this folder. Primary files were not changed. The collector was adapted only to consume a locally SHA-verified ZIP.

## Usage

Create `requests/active-request.json` from `requests/REQUEST_TEMPLATE_v1.json` with actual source commit and archive SHA-256, then commit it to the standalone branch. The existing push trigger starts the two-job source preflight. The active request was intentionally removed during this reset to avoid running against an obsolete archive.

The trusted admission job downloads the source ZIP, verifies its Git blob, SHA-256, size and toolchain plan without executing source. The isolated collector builds source-blind tooling before obtaining the ZIP; it has no network access, controller credentials, writeable root or privileges. Compilation private cache is disabled. Source compilation, Slither and source evidence are reported exactly; partial native results produce warnings, never a false security verdict.

## Not yet implemented

The clean baseline implements the original standalone source preflight only. MiMo configuration, fork deployment, C2 state transfer, deployed-state Slither, Medusa, Wake, Mythril, local Certora, AutoProver, final extended reporting and persistent toolkit caching are **not** implemented. Implement them in the existing v16 order, with native tools before caching. No opt-in switch, external approval provider, new external service, or extra workflow was added.

## Isolation

Only the standalone fork directory and its dedicated workflow were replaced. Original primary files, other forks, shared workflows, controller records and source archives remain unchanged. No smart-contract tests or deployments are run by this reset. Previous fork history remains recoverable from Git.
