# Upgrade Agent Execution Authority v1

## Scope

This authority governs repository development, maintenance, repair and upgrade tasks launched through the Upgrade Agent Launcher and executed by the Development Agent Task Manager.

It does not govern audit execution reviewers or audit campaign methodology.

## Governing sources

For every task, use this precedence:

1. the human-requested end-state preserved in the task specification;
2. the exact task-specific authority explicitly selected for the task, if any;
3. this execution authority;
4. the Development/Upgrade Agent Task-Lock Protocol.

Live repository state is evidence of what already exists; it does not override an explicit human requirement.

## Required execution behavior

Before editing:

- inspect current target-repository `main`;
- inspect the assigned target branch;
- inspect the exact task specification and selected authority;
- read the existing task-lock state;
- identify what is already satisfied;
- work only the smallest remaining delta.

Discovery is not authorization to repair unrelated problems.

Keep one implementation branch for the managed task.

Do not reopen a SATISFIED requirement unless live verification proves it is no longer satisfied.

Do not refactor, reorganize, modernize or clean adjacent systems unless required for the requested end-state.

Prefer existing admitted workflows, scripts, modules, schemas and processes over parallel replacements.

## Verification

Implementation is not complete merely because code was written.

Run the tests and repository qualification needed to verify the requested change. Diagnose, repair, retry and re-run failures that are caused by the task.

Do not claim passing results that were not observed.

The task lock must close before the machine completion receipt is written.

## Final integration

A successful launcher-managed task must ultimately be merged into the target repository's `main`.

Before writing the completion receipt:

- refresh current target `main`;
- ensure the implementation branch is based on a state that can be safely merged;
- resolve relevant conflicts or integration drift;
- rerun tests required by reconciliation;
- leave the target branch in a verified merge-ready state.

After the completion receipt is admitted, the Development Agent Task Manager owns PR creation/reuse and the actual merge.

If the manager reports that final merge requires branch reconciliation, resume the same task and branch, refresh `main`, repair the merge blocker, rerun affected tests, update the task lock, and write a new completion receipt.

Do not create a second task or replacement implementation branch for merge repair.

## Repository boundaries

GitHub Actions workflows belong in `curveyield3/Contract-Automation`.

Never add a GitHub Actions workflow to `curveyield3/Audit-Controller`.

A development task may modify audit automation code when that is explicitly the task, but development task-lock instructions must not be injected into audit execution reviewer wakes, audit campaign watchdog policy, audit campaign handoffs, or audit methodology unless the human explicitly requests that change.

## Merge safety

Do not force-push `main`.

Do not bypass branch protection.

Do not merge unrelated changes.

Do not use a merge result as a substitute for required tests.

## Completion

The repository-development lifecycle is complete only when the manager has:

1. verified the exact completion receipt and closed task lock;
2. created or reused the task PR to target `main`;
3. successfully merged the verified implementation;
4. verified the resulting target-`main` commit;
5. persisted the merged output URL and ChatGPT Project URL in terminal manager state.
