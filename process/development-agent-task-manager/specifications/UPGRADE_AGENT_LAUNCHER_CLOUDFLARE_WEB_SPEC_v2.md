# Upgrade Agent Launcher — Cloudflare Web Specification v2

## Goal

Provide one private web page whose main purpose is to start a managed development/upgrade task.

After launch, the page only needs to show that the submitted task is running and, when the backend has successfully merged the completed work to target `main`, show:

- **Open output**
- **Open ChatGPT Project** for Project-backed tasks.

No general dashboard or operational control surface is required.

## Routes

Required:

- `GET /` — launch page
- `POST /api/tasks` — admit a task
- `GET /api/tasks/:managerId` — minimal status/results for the submitted task
- `GET /health` — optional no-secret health response

Do not add routes for:

- browser pokes;
- watchdog sweeps;
- replacing agents;
- stopping agents;
- merging;
- audit campaign control.

Merge finalization belongs to the durable GitHub manager backend, so it continues even if the browser page is closed.

## Page before launch

Show:

- Task name
- What should the agent accomplish?
- Target repository
- Launch button

Optional Advanced section:

- base ref;
- target branch;
- authority path;
- acceptance criteria;
- initial assignment;
- continuity mode.

Default continuity is `managed_project`.

## Page after launch

Show the same submitted task only.

States:

- Submitting
- Running
- Completed
- Failed/Blocked

While Running, a short message such as:

`Task is running. The page can be closed; execution continues in GitHub.`

No live task dashboard is required.

## Completed state

Do not display Completed until terminal manager state confirms:

- implementation verified;
- merge status `MERGED`;
- target `main` SHA recorded.

Then display:

### Open output

Use terminal `output.url`.

Expected default is the merged pull request URL because it provides:

- description of the changes;
- changed files;
- diff;
- test/check history;
- merge record.

Fallback is the merge commit URL.

If terminal state records a natural primary artifact path, the page may additionally show **Open artifact** linking directly to that file/folder on `main`.

### Open ChatGPT Project

For managed-project tasks, link terminal:

`continuity.project.url`

Do not expose worker chat URLs.

## POST /api/tasks

Request body should minimally support:

```json
{
  "taskName": "Upgrade the development manager",
  "instruction": "Implement the requested repository change.",
  "targetRepository": "curveyield3/Contract-Automation"
}
```

Server defaults:

- `baseRef=main`
- `continuityMode=managed_project`
- generic upgrade execution authority
- generated target branch

Server behavior:

1. authenticate;
2. validate fields;
3. validate target-repository allowlist;
4. allocate manager ID/revision;
5. allocate target branch;
6. generate deterministic specification;
7. generate existing manager request JSON;
8. create both in one atomic commit to Contract-Automation `main`;
9. return manager ID and admission commit SHA.

The Worker must not create the target branch. The existing manager owns that.

## Specification generation

Do not use an LLM.

The exact submitted instruction must appear verbatim in the generated task specification.

This prevents the launcher from introducing drift.

## Minimal GET /api/tasks/:managerId

Read only the known active/completed manager state.

Example running response:

```json
{
  "managerId": "upgrade-example-r1",
  "status": "RUNNING"
}
```

Example completed response:

```json
{
  "managerId": "upgrade-example-r1",
  "status": "COMPLETE",
  "outputUrl": "https://github.com/curveyield3/Contract-Automation/pull/123",
  "projectUrl": "https://chatgpt.com/...",
  "artifactUrl": null
}
```

The endpoint must not infer COMPLETE from branch state alone. It uses terminal manager state.

## Authentication and secrets

Protect the site with Cloudflare Access.

Preferred backend auth to GitHub:

- dedicated GitHub App;
- App ID/private key/installation ID stored as Worker secrets.

No GitHub token or ChatGPT credential may appear in:

- browser JavaScript;
- HTML;
- localStorage/sessionStorage;
- logs;
- API response bodies.

## Deployment

Prefer Cloudflare Workers Git integration / Workers Builds.

No GitHub Actions deployment workflow is required.

## Tests

At minimum:

- input validation;
- slug/revision allocation;
- deterministic specification rendering;
- exact manager request rendering;
- atomic Git commit behavior;
- duplicate-active rejection;
- repository allowlist;
- minimal running-state response;
- completed-state response;
- output URL selection;
- managed-project Project URL response;
- secret redaction;
- mocked GitHub API integration.

## Non-goals

- no dashboard;
- no active-task list;
- no detailed progress display;
- no Project/chat controls;
- no sweep button;
- no merge button;
- no browser automation;
- no audit orchestration;
- no automatic task database.
