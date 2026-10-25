# Development Agent Task Manager v1

## Purpose

This control-plane workflow turns a development specification into a durable, supervised sequence of ordinary ChatGPT web development agents.

The task manager is derived from the existing browser-agent watchdog architecture. It deliberately reuses:

- `.github/actions/setup-browser-agent-runtime`
- `scripts/browser-agent-wake.mjs`
- the existing Browserless / Browserbase / GitHub-hosted browser-provider redundancy
- the existing short scheduled-sweep model

It does **not** create another browser driver or another private-repository workflow system.

All GitHub Actions workflows remain in `curveyield3/Contract-Automation`. `curveyield3/Audit-Controller` must not gain GitHub Actions workflows.

## Starting a managed development task

Two equivalent start surfaces feed the **same** task-manager workflow.

### Declarative request file — preferred for automation

Create exactly one JSON file per commit under:

`process/development-agent-task-manager/requests/<REQUEST_ID>.json`

using schema:

`protocol/schemas/curveyield-development-agent-task-request-v1.schema.json`

A push of that file to `main` triggers the existing `.github/workflows/development-agent-task-manager.yml` start lane automatically. No second workflow or external dispatcher is introduced.

The request binds:
- stable manager ID;
- specification path;
- supporting skill/authority path;
- authority ref;
- target repository;
- durable target branch;
- base ref if needed;
- optional initial assignment.

If the same manager ID already has active state, request-file intake fails closed rather than spawning a duplicate agent.

### Manual workflow dispatch

The same workflow can also be dispatched manually with:

- `operation=start`
- a stable `manager_id`
- `specification_path` in Contract-Automation
- `skill_path` / supporting authority file in Contract-Automation
- exact `authority_ref`
- target repository
- durable target branch
- base ref if the durable target branch does not yet exist
- optional extra assignment text

The start lane:

1. reads the specification and skill authority bytes;
2. records SHA-256 identities for both;
3. resolves or creates the durable target branch;
4. creates a fresh ChatGPT development chat with the existing browser-agent driver;
5. stores the chat URL, branch checkpoint and response policy under:
   `process/development-agent-task-manager/active/<SAFE_MANAGER_ID>.json`.

The scheduled supervisor re-verifies the admitted specification and skill bytes before each sweep. Authority drift fails closed.

## Development/upgrade task lock

Every development agent launched by this manager is governed by:

`process/development-agent-task-manager/TASK_LOCK_PROTOCOL_v1.md`

and starts from:

`process/development-agent-task-manager/TASK_LOCK_STATE_TEMPLATE_v1.md`

The agent must maintain exactly one task-specific lock file on the target branch:

`process/development-agent-task-manager/task-locks/<SAFE_MANAGER_ID>_v1.md`

Before implementation work, the agent records one externally verifiable end-state invariant, the current target-repository `main` SHA, already-satisfied requirements, the smallest remaining delta, parked observations, any active blocker, and exactly one next action.

The manager pins the exact protocol/template digests in durable manager state. Initial wakes receive the lock metadata and must create/update the task-specific state before implementation. Idle supervision tells the worker to re-read that state and continue only the remaining delta. Replacement agents receive the same pinned lock identity and must resume the existing lock rather than reconstructing completed work from scratch.

Machine completion also requires the task-lock state to exist on the target branch with:

- `REMAINING DELTA:` equal to `- None`;
- `ACTIVE BLOCKER:` equal to `None`.

This task lock is a **development/upgrade-agent control only**. It must not be injected into audit reviewer wakes, audit watchdogs/monitors, audit campaign orchestration, audit phase handoffs, audit-source initialization, Audit V7 execution/qualification, lite-audit workflows, or other audit-specific execution paths.

## Browser continuity and Project default

The Development Agent Task Manager uses the current GitHub-hosted home-exit Playwright transport used by the corrected browser automation path:

- visible Chrome under Xvfb;
- encrypted ChatGPT session-state handling;
- Tailscale home exit-node routing;
- private tailnet VNC support;
- durable message-write verification through `scripts/browser-agent-wake.mjs`;
- the shared browser operation/routine engine.

The manager does not use Browserless or Browserbase fallback providers.

### Managed Project mode — default

`managed_project` is the default continuity mode because development agents frequently exhaust chat context before a non-trivial task is complete.

The first worker:

1. creates exactly one ChatGPT Project for the manager ID;
2. obtains the Project's private Share link through the normal UI;
3. persists that URL in durable task-manager state;
4. creates its worker chat inside that Project.

Replacement workers reopen the exact persisted Project URL and create a fresh chat inside that same Project. A dead, missing, or context-exhausted chat is replaced; the Project is not recreated.

### Standalone mode — lightweight exception

`standalone` skips Project creation and uses a normal ChatGPT conversation. It is intended only for clearly small tasks expected to finish with one agent and no handoff.

Declarative requests may set:

`"continuityMode": "standalone"`

Otherwise `managed_project` is used.

The browser transport is shared infrastructure only. Development wake text and task-lock instructions remain development-specific; audit reviewer wake instructions are not reused.

## Liveness and failure rule

The scheduled manager checks active workers approximately every five minutes.

A currently generating worker or a chat whose assistant output advanced is left alone.

When the worker is idle, liveness is tested with a direct prompt. A worker is declared dead only by either of these signals:

1. the target conversation is no longer viewable; or
2. three consecutive prompts receive no assistant response.

For case 2, the sequence is exact:

`prompt 1 → wait up to 120 seconds → refresh → prompt 2 → wait up to 120 seconds → refresh → prompt 3 → wait up to 120 seconds`

There is **no five-minute delay between the three attempts**. Attempts 2 and 3 refresh the browser page immediately before posting.

A browser-provider outage is not treated as agent death. If all configured browser providers fail, the current worker is preserved and the next scheduled sweep retries.

## Recovery and replacement

When a worker is confirmed dead:

1. the manager reads the exact current target-branch HEAD;
2. that checkpoint, predecessor chat URL and failure reason are written durably to the manager state on `main`;
3. only after the checkpoint write succeeds does the manager create a fresh ChatGPT conversation;
4. the replacement receives the exact specification identity, skill identity, target branch and checkpoint commit;
5. the replacement is explicitly told to reconstruct current GitHub state and continue without repeating completed work;
6. the new chat URL replaces the dead chat URL in durable manager state.

The repository checkpoint, not chat memory, is the recovery authority.

## Completion

A chat message saying “done” is not completion.

The development worker must commit:

`process/development-agent-task-manager/completions/<SAFE_MANAGER_ID>.json`

on the target branch using schema:

`protocol/schemas/curveyield-development-task-completion-v1.schema.json`

The receipt must bind:

- manager ID;
- specification SHA-256;
- skill SHA-256;
- implementation commit;
- one or more verification/test records, all with `status: PASS`.

The completion-receipt commit itself must be the current target-branch HEAD and its first parent must equal `implementationHeadSha`. This prevents a stale completion receipt or unrelated later changes from retiring the manager.

After verification, the active manager state is moved to:

`process/development-agent-task-manager/completed/<SAFE_MANAGER_ID>.json`

and supervision stops.

## Audit automation upgrade authority

The first admitted development specification is:

`process/development-agent-task-manager/specifications/AUDIT_AUTOMATION_UPGRADE_SPECIFICATION_v1.md`

Expected SHA-256:

`b23743f626cc159f869f22bfa4921b50ed103f600c4e7981d94463861dd1b86a`

The human-supplied Audit V7 v38.3.4 top-level skill authority is pinned under:

`process/development-agent-task-manager/authority/audit-v7-v38.3.4/`

Start with:

`SKILL_AUTHORITY_INDEX_v1.md`

The index records the source package identity, the complete original `SKILL.md` SHA-256, and the exact five-part reconstruction order.

## Governing development ethos

Development agents must preserve these rules:

- inspect current GitHub state before coding;
- do not repeat completed work;
- reuse existing workflows/modules/processes first;
- extend or refactor an admitted primitive before creating a parallel one;
- create a new workflow only when no existing workflow can safely own the responsibility;
- never put a GitHub Actions workflow in Audit-Controller;
- preserve exact evidence/state identities;
- diagnose, repair, retry and verify failures;
- commit coherent progress so a successor can recover from GitHub alone;
- do not write the completion receipt until implementation and required tests/qualification actually pass.
