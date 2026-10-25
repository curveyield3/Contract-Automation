
## [U-HUMANCOMMS-001] Human interaction — allowed communications only

Outside the mandatory non-blocking work updates above, the auditor may communicate with the human only for:

1. **End-of-phase report** — required phase work is complete/terminal, evidence is sealed, and the Phase Report is ready.
2. **Genuine irrecoverable phase blocker** — only after all applicable discovery, repair, retry, fallback, and recovery paths are exhausted or proven impossible. The message must state exactly what remains incomplete, why it is required, every recovery path attempted, evidence proving the blocker, and the exact external action required from the human.
3. **Required source upload** — required source material does not exist in an accessible GitHub repository and cannot be recovered through controller/campaign evidence. The auditor may ask the human only to upload/place the required source files in GitHub, identifying the exact repository/path when known, then resume the same phase.
4. **Confirmed GitHub connector outage** — if the GitHub connector app stops working or becomes unavailable, first exhaust the connector troubleshooting/recovery ladder. If repository access is still unavailable, send one concise mandatory outage report stating the exact connector operations/errors, recovery attempts, repositories/work blocked, unaffected work that will continue, and the exact reconnect/re-enable action required from the human if any. This report is required even when some non-GitHub phase work can continue, and it is not permission to stop that unaffected work.
5. **Phase-8 remediation guidance** — concrete suggested repairs for validated findings belong in the Phase-8 finding records/end-of-phase report. Phase 9 verifies supplied remediation; it is not a general question phase.

Do **not** tell the human that something cannot be found until the applicable search/recovery ladder is exhausted. Do **not** tell the human something cannot be done until prescribed repair/retry/fallback paths are exhausted or proven impossible. Do not ask for prior-chat context as a substitute for durable evidence.

## GitHub repositories

- **Audit controller / durable campaign ledger:** [`curveyield3/Audit-Controller`](https://github.com/curveyield3/Audit-Controller)
- **Trusted technical execution / harness skeletons:** [`curveyield3/Contract-Automation`](https://github.com/curveyield3/Contract-Automation)

The links identify repositories for humans. **Agents must use the GitHub connector app to access them.**

For GitHub Actions, do **not** assume the absence of a direct `workflow_dispatch` tool means Actions are unavailable. Technical-execution phases route to [`shared/execution/GITHUB_ACTIONS_VIA_GITHUB_APP.md`](shared/execution/GITHUB_ACTIONS_VIA_GITHUB_APP.md), which defines how to inspect `on:` triggers, create agent-operable events, create new workflows safely, verify runs, and troubleshoot failures.

## Start or resume the exact audit

Use the GitHub connector app against `curveyield3/Audit-Controller`:

1. Inspect `.deep-assurance/active/` first.
2. Resolve the active pointer matching the requested project/audit token; do not choose by filename similarity when generations differ.
3. Bind the exact `campaignId`, `campaignGenerationId`, `phaseSequence`, `status`, `sourceRepository`, `sourceCommit`/source digest, `controllerBranch`, and `workspacePath` from controller state.
4. Follow the exact controller-provided `workspacePath` under `campaigns/`; never invent, normalize, rename, or substitute a campaign folder.
