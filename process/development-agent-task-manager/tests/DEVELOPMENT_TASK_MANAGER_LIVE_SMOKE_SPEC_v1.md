# Development Agent Task Manager Live Smoke Specification v1

## Objective

Prove the production Development Agent Task Manager can create a fresh ChatGPT development agent, give it a bounded repository task, persist durable progress, and complete through the manager's machine completion contract.

This is a control-plane smoke test only. Do not modify audit logic, execution logic, existing workflows, Audit-Controller, or unrelated files.

## Target work

On the assigned durable target branch:

1. Inspect the current branch state before writing.
2. Create exactly:
   `process/development-agent-task-manager/smoke/LIVE_SMOKE_RESULT_v1.json`
3. The file must contain valid JSON with:
   - `schemaVersion: "curveyield-development-task-manager-live-smoke-v1"`
   - `managerId: "task-manager-live-smoke-v1"`
   - `status: "PASS"`
   - `repository: "curveyield3/Contract-Automation"`
   - `branch: "task-manager-live-smoke-v1"`
   - `note: "fresh agent created and durable GitHub write succeeded"`
4. Commit that file as the implementation commit.
5. Re-read the committed file from the exact target branch and verify every required field.
6. Create the manager completion receipt at:
   `process/development-agent-task-manager/completions/task-manager-live-smoke-v1.json`
7. The receipt must follow `curveyield-development-task-completion-v1` and bind:
   - `managerId: "task-manager-live-smoke-v1"`
   - `status: "COMPLETE"`
   - the exact specification SHA-256 supplied by the task manager;
   - the exact supporting-skill SHA-256 supplied by the task manager;
   - `implementationHeadSha` equal to the smoke-result implementation commit immediately before the receipt commit;
   - at least one test entry with `status: "PASS"`.
8. Commit the completion receipt as the next commit and stop.

## Hard boundaries

- Do not edit any GitHub Actions workflow.
- Do not edit Audit-Controller.
- Do not edit the audit automation upgrade implementation.
- Do not create additional files beyond the smoke result and required completion receipt.
- Do not create a pull request.
- Do not restart or broaden the task.
- If a repository operation fails, diagnose/retry it within this bounded task.

## Success

Success means the target branch contains the exact smoke result followed by a valid completion-receipt commit accepted by the Development Agent Task Manager.
