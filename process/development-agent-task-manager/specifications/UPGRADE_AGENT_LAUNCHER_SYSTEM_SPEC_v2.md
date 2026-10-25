# Upgrade Agent Launcher System Specification v2

## Purpose

Build a minimal launch surface for the existing Development Agent Task Manager.

The launcher has two user-facing responsibilities:

1. admit a new repository-development task into the existing manager flow;
2. after the task is fully finished and merged to the target repository's `main`, show the final output link and the ChatGPT Project link.

The page is not a dashboard, monitor, browser controller, or merge controller.

## Required end-to-end lifecycle

```
Private Cloudflare Launch Page
        |
        v
Cloudflare Worker
        |
        | one atomic GitHub admission commit
        v
curveyield3/Contract-Automation main
        |
        v
existing Development Agent Task Manager
        |
        v
focus-locked Project-backed worker lifecycle
        |
        v
implementation complete + verified
        |
        v
automatic PR creation/reuse
        |
        v
required merge into target repository main
        |
        v
terminal COMPLETE state
        |
        v
Cloudflare page shows:
- Open output
- Open ChatGPT Project
```

A managed upgrade task is not terminally COMPLETE merely because implementation and tests pass. Successful conclusion requires the implementation to be merged into the target repository's `main`.

## Cloudflare role

Use a very small private Cloudflare Worker application with static assets.

Recommended repository location:

`process/development-agent-task-manager/launcher/cloudflare/`

The Cloudflare layer is intake plus final-result display only.

It must not:

- browse ChatGPT;
- supervise or poke agents;
- create replacement chats;
- own durable manager state;
- perform the final merge;
- act as an audit orchestrator.

GitHub remains the durable authority and backend.

## Launch inputs

Default visible fields:

- **Task name**
- **What should the agent accomplish?**
- **Target repository**
- **Launch**

Default target repository:

`curveyield3/Contract-Automation`

Allowed target repositories are server-side allowlisted and must include at least:

- `curveyield3/Contract-Automation`
- `curveyield3/Audit-Controller`

Defaults:

- base ref: `main`
- continuity mode: `managed_project`
- authority: `process/development-agent-task-manager/UPGRADE_AGENT_EXECUTION_AUTHORITY_v1.md`
- target branch: generated automatically
- final merge target: `main`

Optional advanced fields may include base ref, target branch, authority path, acceptance criteria, initial assignment, and standalone continuity.

## Default execution authority

Implementation must add:

`process/development-agent-task-manager/UPGRADE_AGENT_EXECUTION_AUTHORITY_v1.md`

This is the default `skillPath` for launcher-created tasks.

It must require:

- inspect current live `main` before editing;
- inspect the selected authority before editing;
- obey the development task-lock protocol;
- keep one implementation branch;
- do not reopen SATISFIED work without contradictory live evidence;
- park unrelated discoveries;
- prefer existing admitted processes over parallel replacements;
- verify tests before completion;
- never add GitHub Actions workflows to Audit-Controller;
- never inject the development task lock into audit execution agents;
- continue through final integration so a successful task ends merged to target `main`.

## Generated task specification

Each submission creates:

`process/development-agent-task-manager/specifications/<SAFE_MANAGER_ID>_SPEC_v1.md`

The original user instruction must be preserved verbatim under **Human Requested End-State**.

The launcher may add metadata headings, but it must not paraphrase the task into a broader project.

The specification includes:

- manager ID;
- target repository;
- target branch;
- base ref;
- selected authority;
- continuity mode;
- supplied acceptance criteria;
- explicit non-goals if supplied;
- required final merge target `main`.

## Generated manager request

Each submission creates exactly one:

`process/development-agent-task-manager/requests/<SAFE_MANAGER_ID>_v1.json`

using the existing schema:

`curveyield-development-agent-task-request-v1`

The launcher should reuse the existing request contract. Final merge behavior belongs to the manager/finalization backend, not the browser form.

## Atomic admission

The generated specification and request must land in one atomic commit on Contract-Automation `main`.

Required behavior:

1. read current `main`;
2. create specification blob;
3. create request blob;
4. create a tree based on current `main`;
5. create one commit;
6. fast-forward `main`;
7. never force-push.

The admission commit must change exactly one manager-request JSON file.

If `main` moves during submission, rebuild against the new head and retry boundedly.

## Naming

Default manager ID:

`upgrade-<task-slug>-rN`

Default target branch:

`upgrade/<task-slug>-rN`

Revision is allocated by checking existing requests, active/completed manager state, and existing target branches.

Never reuse an active manager ID.

## Required merge finalization

After implementation and verification pass:

1. re-check target repository `main`;
2. rebase/reconcile the completed implementation branch if required;
3. rerun any tests made necessary by that reconciliation;
4. create a PR from the target branch to target `main`, or reuse the existing PR for that exact branch;
5. wait for required GitHub checks if branch protection requires them;
6. merge the PR into target `main`;
7. verify target `main` contains the implementation;
8. persist the merged PR URL, merge commit SHA, and final target-main SHA in terminal manager state;
9. only then mark the manager terminally COMPLETE.

No successful task should stop in a permanent "ready to merge" state.

If merge is blocked by a genuine GitHub protection or conflict that cannot be repaired automatically, the task remains BLOCKED rather than COMPLETE.

No force-push or branch-protection bypass is allowed.

## Page lifecycle

The page only needs these states:

- **Ready**
- **Submitting**
- **Running**
- **Completed**
- **Launch/merge failed**

After admission, the page may poll only the known manager state for the submitted task.

It does not expose ongoing operational controls.

## Completed-task links

When terminal COMPLETE is reached, show exactly two primary links.

### Open output

Preferred resolution order:

1. **Merged pull request URL** for the task's implementation branch. This is the preferred output because it contains the human-readable change description, changed-file list, diff, checks, and merge record.
2. If no PR URL is available, the **merge commit URL** on target `main`.
3. If the task's primary deliverable is one clearly identified file or folder and the completed state records that artifact path, the UI may link that exact file/folder as an additional or substituted output target.

The launcher must never link an unmerged development branch as the final successful output.

### Open ChatGPT Project

For `managed_project` tasks, use:

`.continuity.project.url`

from the terminal manager state.

For `standalone`, omit this link.

The page does not need to expose individual worker chat URLs.

## Terminal manager state requirements

The completed-state record should include, in addition to existing completion data:

```json
{
  "merge": {
    "status": "MERGED",
    "targetBranch": "main",
    "pullRequestUrl": "https://github.com/.../pull/...",
    "mergeCommitSha": "<40-hex>",
    "targetMainSha": "<40-hex>"
  },
  "output": {
    "url": "https://github.com/.../pull/...",
    "kind": "pull_request",
    "artifactPath": null
  }
}
```

`output.url` is the canonical link shown by the page.

If a task has a natural primary artifact path, `artifactPath` may record it and the UI may offer an additional **Open artifact** link.

## Authentication

Protect the launcher with Cloudflare Access.

Preferred GitHub authentication is a dedicated GitHub App.

GitHub credentials stay only in Worker secrets. No GitHub or ChatGPT credential may reach browser JavaScript.

The Cloudflare application must never hold ChatGPT session state or perform ChatGPT browser automation.

## Minimal completion lookup

For the submitted manager ID, the Worker reads only:

- active manager state;
- completed manager state.

When COMPLETE it uses the recorded:

- `output.url`;
- `merge.pullRequestUrl` / merge commit if needed;
- `continuity.project.url`.

No separate task database is required.

## Failure behavior

- invalid input: reject before GitHub write;
- duplicate active manager: reject;
- atomic admission race: retry against fresh `main`;
- manager startup failure: preserve admitted request and report failure;
- implementation failure: existing manager owns recovery;
- merge conflict: repair/reconcile and retry;
- protected-branch/check failure: remain BLOCKED until resolved;
- Cloudflare outage after admission: no effect on execution.

## Audit boundary

The launcher may target Audit-Controller for repository-development work.

It must not:

- become an audit orchestrator;
- inject task-lock text into audit reviewer wakes;
- change audit watchdog semantics as part of launcher operation;
- add Actions workflows to Audit-Controller.

## Acceptance criteria

Launcher implementation passes only if:

1. normal launch requires only task name, task instruction, and target repository;
2. admission creates one atomic commit containing one specification and exactly one manager request;
3. the existing Development Agent Task Manager starts from that request;
4. `managed_project` remains the default;
5. no parallel browser/runtime/manager is introduced;
6. a successful task is not terminal until merged into target `main`;
7. terminal state records PR URL, merge commit SHA, and resulting target-main SHA;
8. the page shows **Open output** using the merged PR when available;
9. the page shows **Open ChatGPT Project** for managed-project tasks;
10. the final output link never points to an unmerged working branch;
11. Cloudflare secrets never reach the browser;
12. no audit execution pathway is modified.
