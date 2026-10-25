# Managed Upgrade Task Specification v1

## Manager

- Manager ID: `upgrade-launcher-live-smoke-r1`
- Target repository: `curveyield3/Contract-Automation`
- Target branch: `upgrade/launcher-live-smoke-r1`
- Base ref: `main`
- Final merge target: `main`
- Continuity: `managed_project`
- Authority: `process/development-agent-task-manager/UPGRADE_AGENT_EXECUTION_AUTHORITY_v1.md`

## Human Requested End-State

Create exactly one primary deliverable file at `process/development-agent-task-manager/tests/UPGRADE_AGENT_LAUNCHER_LIVE_SMOKE_v1.md` documenting that this live smoke task successfully exercised the Upgrade Agent Launcher backend. Keep implementation changes limited to that primary deliverable plus the task-lock and completion control artifacts required by the Development Agent Task Manager. Run the relevant repository tests. Do not alter audit execution workflows, audit reviewer wakes/monitors, or browser automation. Complete the managed task so the manager finalizes it by merging the verified branch into target repository `main`.

## Acceptance Criteria

- `process/development-agent-task-manager/tests/UPGRADE_AGENT_LAUNCHER_LIVE_SMOKE_v1.md` is present after final merge.
- Relevant repository tests pass.
- Audit execution workflows, wakes, monitors and browser automation are unchanged.
- The task uses managed Project continuity.
- The Development Agent Task Manager merges the verified result into `main` before terminal completion.

## Execution Contract

- Preserve the human-requested end-state exactly; do not broaden it.
- Read the selected authority and Development/Upgrade Agent Task-Lock Protocol before implementation.
- Inspect live target-repository `main` and the target branch before edits.
- Work only the smallest remaining delta.
- Park non-blocking discoveries.
- Keep one implementation branch.
- Verify required tests before completion.
- A successful task concludes only after the verified implementation is merged into target repository `main`.
- The Development Agent Task Manager owns final PR creation/reuse and merge after the completion receipt is valid.
