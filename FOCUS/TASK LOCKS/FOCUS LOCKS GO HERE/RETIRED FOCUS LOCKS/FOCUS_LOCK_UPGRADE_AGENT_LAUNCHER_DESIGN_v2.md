# Focus Lock — Upgrade Agent Launcher Design v2

## END-STATE INVARIANT

Produce implementation-ready design specifications for a minimal Upgrade Agent Launcher that:

1. starts a focus-locked repository-development task through the existing Development Agent Task Manager;
2. requires every successful task to conclude by merging the verified implementation into the target repository's `main`;
3. shows the final merged output link and ChatGPT Project link.

The Cloudflare page is intentionally minimal and is not a dashboard or control plane.

## CURRENT MAIN

- Repository: `curveyield3/Contract-Automation`
- Baseline main commit: `9b3e5556d173567b04b31c37fd5f97c356e54fc5`
- Design branch: `upgrade-agent-launcher-design-v1`

## CURRENT EXECUTION BACKEND

Already on `main`:

- Development Agent Task Manager
- declarative task request
- development task-lock protocol/template
- Project-backed continuity
- corrected human-style browser automation
- scheduled supervision/replacement
- machine verification/completion gate

## HARD BOUNDARIES

- Cloudflare performs intake and final-result display only.
- GitHub is durable authority.
- Do not introduce a second development manager/browser/watchdog.
- Do not alter audit execution wakes/monitors/orchestration.
- Never add GitHub Actions workflows to Audit-Controller.
- Do not put ChatGPT credentials in Cloudflare.
- A successful task is not COMPLETE until its verified branch is merged into target `main`.
- No force-push or branch-protection bypass.

## SATISFIED

- Confirmed existing manager request is the correct launcher handoff.
- Selected Cloudflare Worker + Cloudflare Access as the preferred launch surface.
- Selected GitHub-only workflow-dispatch intake as fallback.
- Reduced the page to launch + submitted-task state + final links.
- Specified atomic Git admission.
- Specified managed Project as the default.
- Specified mandatory backend merge into target `main`.
- Specified **Open output** to prefer the merged PR because it contains description, diff and changed files.
- Specified merge-commit fallback and optional direct artifact file/folder link.
- Specified **Open ChatGPT Project** from persisted Project URL.

## REMAINING DELTA

- None

## PARKED OBSERVATIONS

- General monitoring dashboard is unnecessary.
- Active task controls are unnecessary.
- Audit methodology changes are out of scope.
- General repo organization is out of scope.

## ACTIVE BLOCKER

None

## NEXT ACTION

Human review of launcher design v2. Implementation has not started.

## ANTI-DRIFT CHECK

The launcher exists to initiate a development task and return the final merged result. Features not required for that flow are out of scope.
