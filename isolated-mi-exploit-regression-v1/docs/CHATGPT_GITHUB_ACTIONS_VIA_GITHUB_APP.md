# ChatGPT GitHub Actions via GitHub App — General Agent Guide

The ChatGPT GitHub app does **not** expose GitHub's direct `workflow_dispatch` / **Run workflow** button. That does **not** mean the agent cannot create or run GitHub Actions.

The normal pattern is:

`ChatGPT GitHub app → create/update GitHub state → GitHub receives event → matching workflow starts automatically → agent reads run/jobs/logs/artifacts through the GitHub app`

Never conclude that GitHub Actions are unavailable merely because a direct `workflow_dispatch` tool is absent.

## 1. Inspect the workflow before triggering it

Before attempting any Action:

1. Use the GitHub app to inspect `.github/workflows/`.
2. Open the intended `.yml` / `.yaml` workflow.
3. Read its `on:` block.
4. Determine the exact trigger event, target branch, path filters, labels, event subtypes, and job-level `if:` conditions.
5. Create that exact GitHub event with the GitHub app.
6. Verify a workflow run appeared.
7. Inspect the run through completion and retrieve required logs/artifacts.

Do not guess how a workflow is triggered.

## 2. Agent-operable workflow triggers

### Pull request

Example:

```yaml
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]
    paths:
      - "requests/**"
```

Trigger procedure:

1. Create a branch.
2. Create/update a matching file.
3. Commit it.
4. Open a PR against the required branch.
5. GitHub automatically starts the workflow.

Updating the PR branch creates a `synchronize` event and normally starts the workflow again.

### Push

Example:

```yaml
on:
  push:
    branches: [main]
    paths:
      - "queue/**"
```

Trigger by creating/updating a matching path and producing the required push, usually through a reviewed branch/merge when appropriate.

### Issue opened

```yaml
on:
  issues:
    types: [opened]
```

Creating the issue starts the workflow.

### Issue label

```yaml
on:
  issues:
    types: [labeled]
```

A job may additionally require:

```yaml
if: github.event.label.name == 'run-job'
```

Trigger by creating/locating the correct issue and applying the exact label. This is a useful agent-operable replacement for a manual Run Workflow button.

### Issue or PR comment

```yaml
on:
  issue_comment:
    types: [created]
```

The workflow may inspect commands such as `/run`, `/test`, `/recheck`, or `/deploy-preview`.

Validate commenter authority before permitting sensitive work. PR conversation comments are represented through the issue-comment event model.

## 3. How to create a new workflow

When ChatGPT web agents must operate a new workflow autonomously, design it around a trigger the GitHub app can produce.

Recommended triggers:

1. request PR;
2. issue label;
3. controlled push/path change;
4. authorized issue/PR comment command.

`workflow_dispatch` may also be included for human use, but it should not be the **only** trigger when ChatGPT web agents need to launch the workflow.

Recommended creation procedure:

1. Create a dedicated branch.
2. Create `.github/workflows/<workflow-name>.yml`.
3. Use minimum required permissions.
4. Open a PR.
5. Review the workflow, especially permissions, secrets, untrusted-input behavior, and trigger scope.
6. Merge it into the branch on which GitHub recognizes the workflow.
7. Create the configured event using the GitHub app.
8. Verify the workflow run and inspect its jobs/logs/artifacts.

Do not casually install new workflows directly on production `main` when a reviewed PR can be used.

## 4. Example: issue-label workflow

```yaml
name: Agent Job

on:
  workflow_dispatch:
  issues:
    types: [labeled]

permissions:
  contents: read
  issues: write

jobs:
  run-job:
    if: github.event.label.name == 'run-agent-job'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run job
        run: echo "Job triggered by issue #${{ github.event.issue.number }}"
```

Human trigger: use **Run workflow**.

ChatGPT-agent trigger: apply `run-agent-job` to the intended issue.

## 5. Example: request-PR workflow

```yaml
name: Validate Request

on:
  workflow_dispatch:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened]
    paths:
      - "requests/**"

permissions:
  contents: read

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate request
        run: echo "Validating request"
```

Agent procedure: create branch → add `requests/<job>/request.json` → open PR → GitHub starts the workflow automatically.

## 6. Example: file-based job trigger

For a durable request queue:

```yaml
on:
  push:
    paths:
      - ".agent-triggers/**"
```

The agent creates a request file such as:

```json
{
  "job": "compile",
  "target": "contracts",
  "requestId": "job-123"
}
```

This provides reviewable inputs and durable request history. For sensitive/important work, a PR-based request file is usually safer than a direct push.

## 7. Observe and consume workflow results

After creating the trigger event:

1. resolve the relevant commit/PR/issue event;
2. locate the resulting workflow run;
3. inspect run status;
4. inspect jobs;
5. inspect job steps;
6. read logs when needed;
7. retrieve workflow artifacts;
8. record exact run/job/artifact identities required by the task.

Do not assume the workflow did not run merely because nothing appeared in chat.

## 8. Retry behavior

The ChatGPT GitHub app may expose retry operations for existing failed jobs/runs. Use those when the workflow already executed and the correct response is a retry.

Create a new request/event instead when source, inputs, configuration, or immutable request semantics changed.

## 9. Permissions and secrets

Use least privilege.

Prefer:

```yaml
permissions:
  contents: read
```

Add write permissions only when required.

Never put secrets in workflow YAML, issue bodies, PR bodies, request JSON, committed source, or logs. Use GitHub Actions secrets/variables and do not print secret values.

## 10. Untrusted PR safety

Never execute requester-controlled code with privileged secrets merely because a PR was opened.

For sensitive execution, prefer separating:

- trusted runner/workflow code from a controlled branch; and
- requester-controlled request data from the PR/event.

Treat requests as data where possible.

## 11. If an expected workflow does not start

Use:

`DIAGNOSE → REPAIR → RETRY → VERIFY`

Check:

1. correct repository;
2. correct workflow;
3. workflow exists/enabled on the relevant branch;
4. correct `on:` event;
5. correct target branch;
6. `paths:` / `paths-ignore:` match;
7. required event subtype matches;
8. exact label/command matches;
9. job-level `if:` condition is true;
10. GitHub app operation actually succeeded;
11. a run did not start and immediately fail or skip;
12. permissions/secrets/environment are available for that event.

Inspect the resulting run before assuming the trigger failed.

## 12. Existing workflow first

If an appropriate workflow already exists, use it. Do not create a duplicate merely because its trigger is not immediately obvious.

Inspect `on:` first and create the required event.

## 13. Workflow-dispatch-only workflows

If a workflow contains only:

```yaml
on:
  workflow_dispatch:
```

then the current ChatGPT GitHub app cannot directly press Run Workflow.

Before asking a human to run it:

1. confirm no agent-operable trigger already exists;
2. determine whether it is appropriate to add one;
3. if authorized, modify the workflow through a reviewed PR to add an agent-operable trigger while retaining `workflow_dispatch` for humans;
4. merge and use the new event trigger.

Example:

```yaml
on:
  workflow_dispatch:
  issues:
    types: [labeled]
```

or:

```yaml
on:
  workflow_dispatch:
  pull_request:
    paths:
      - "requests/**"
```

## Final rule

No direct **Run workflow** tool does not mean GitHub Actions cannot be run.

For an existing workflow:

`READ WORKFLOW → IDENTIFY on: EVENT → CREATE THAT EVENT WITH GITHUB APP → VERIFY RUN → INSPECT JOBS/LOGS/ARTIFACTS`

For a new workflow:

`DESIGN AGENT-OPERABLE TRIGGER → CREATE WORKFLOW ON BRANCH → PR/REVIEW → MERGE → CREATE TRIGGER EVENT → VERIFY EXECUTION`

Do not ask a human to manually start an Action until the agent has established that no authorized event-based trigger exists or can appropriately be added.