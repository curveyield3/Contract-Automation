# Browser Project-Wake Successor Handoff v1

## Purpose

Resume the current browser-automation task from the exact live state without restarting solved work or reopening old branches.

The immediate task is **not** general browser redesign, Tailscale work, audit-process work, or upgrade-launcher redesign. The immediate task is to make the existing dedicated v10 browser workflow create a ChatGPT Project through the normal visible UI, then create/send the test wake inside that Project.

## Canonical repository state

Repository:

- https://github.com/curveyield3/Contract-Automation

Evidence-capture main head before this handoff documentation commit:

- `7c85ce1a08573cff16012b463ffa4010775ab060`

Before doing any code work, refetch current `main`. Do **not** assume the SHA above remains current because qualification workflows can advance `main`.

### Already merged — do not restart these branches

1. `browser-bootstrap-secret-only-v1`
   - PR #505: https://github.com/curveyield3/Contract-Automation/pull/505
   - Merge commit: `3bcea11b624a08da94681261766964f124afc09a`
   - Purpose: immutable bootstrap-secret state, exact human Project flow, randomized human pacing.
   - Both validation lanes passed.

2. `browser-project-sidebar-scroll-v1`
   - PR #506: https://github.com/curveyield3/Contract-Automation/pull/506
   - Merge commit: `aaddd6dc3915ab9e6551e75b314b04039bfa4816`
   - Purpose: correctly treat the sidebar as potentially already open and human-scroll it until Projects is visible.
   - Both validation lanes passed.

These branches are historical implementation branches now. **Start any new repair branch from current `main`, not from either branch above.**

## Current live request

Request file:

- `process/browser-agent-home-exit-v10/current-request-v10.json`

Current request:

```json
{
  "schemaVersion": "curveyield-browser-home-exit-request-v10",
  "action": "project_wake",
  "mode": "create_fresh",
  "chat_url": "",
  "wake_message": "[HOME_EXIT_PROJECT_WAKE_VERIFY1] Assistant: when you personally receive this as a new user message inside this new Project, reply exactly HOME_EXIT_PROJECT_WAKE_PERSONALLY_SEEN_VERIFY1",
  "home_exit_node": "100.112.238.56",
  "interactive_view": true,
  "manual_challenge_wait_minutes": 5,
  "requested_at": "2026-10-03T13:55:00-07:00",
  "project_name": "HOME_EXIT_PROJECT_WAKE_VERIFY1"
}
```

Do not casually change the marker or Project name. Reusing the same request makes successive runs directly comparable.

## Browser architecture that is already correct

The dedicated v10 path uses:

- Google Chrome, controlled by Playwright Core.
- Headed/visible browser mode.
- Xvfb display `:99` on the GitHub runner.
- Tailscale home exit node for browser egress.
- Chrome `--disable-quic` so web traffic remains on TCP through the runner routing path.

The home-exit routing has repeatedly verified successfully with:

- `HOME_EXIT_EGRESS_ACTIVE=true`

Do not redesign Tailscale unless a finalized run specifically proves a routing failure.

## Session-state invariant — already implemented

Every browser run must start from the immutable stored secret:

- `CHATGPT_STORAGE_STATE_B64`

Rolling automated browser state is intentionally abandoned.

Required behavior:

`CHATGPT_STORAGE_STATE_B64 -> new Chrome context -> one run -> discard run state`

Do not restore or save an Actions browser-session cache. Do not persist refreshed automated state for reuse.

Reason: repeated automated sessions had accumulated Cloudflare-challenged state and introduced an uncontrolled variable. The immutable manually captured secret is the single authentication baseline.

## Human-interaction invariant — already implemented

All visible browser interaction must mimic normal human behavior.

Required pacing:

- **0.3–1.5 seconds randomized between visible browser actions**
- **0.2–0.4 seconds randomized between each typed character**

Do not collapse these back into fixed or machine-speed delays.

Forbidden ChatGPT interaction methods include:

- direct `/backend-api/...` reads or writes;
- direct `fetch()` to ChatGPT;
- request/response network listeners used as verification;
- synthetic DOM `.click()`;
- force-click;
- `requestSubmit()` / `form.submit()`;
- programmatic `.fill()`;
- page-context clipboard injection.

Local DOM inspection used only to identify the currently visible UI is acceptable; it must not generate external ChatGPT requests.

## Cloudflare rule — already implemented

If a visible Cloudflare / human-verification challenge appears:

- abort immediately;
- do not wait for it to clear;
- do not retry the same send on a fresh runner;
- do not save that run's browser state.

The ordinary non-challenge readiness timeout is 5 minutes.

The user has observed that once this Cloudflare state appears it does not clear usefully during the run.

## Exact Project creation sequence required by the user

Follow this sequence exactly:

1. Go to the left sidebar; open it only if it is actually closed.
2. Find the visible **Projects** section.
3. If Projects is below the fold, move the mouse into the visible left sidebar and human-scroll until Projects becomes visible.
4. Hover the mouse over the **Projects** title.
5. Click the **plus sign that appears to the right of Projects**.
6. In the Project-create box, enter the Project name **one letter at a time**, using the 0.2–0.4 second randomized per-character pacing.
7. Click the **Create Project** button at the bottom-right of the visible box.
8. Once inside the new Project, create/use the new chat there and send the wake through the normal visible composer.

No generic “New Project” fallback should replace this sequence.

## Code path currently executing the Project experiment

Primary file:

- `packages/browser-agent-original-phase0-v10/browser-agent-wake-v10.mjs`

Relevant functions include:

- `ensureSidebarOpenForProject(...)`
- `humanScrollSidebarForProjects(...)`
- `findProjectsPlusAfterHover(...)`
- `createProjectExactHumanFlow(...)`

Workflow:

- `.github/workflows/browser-agent-home-exit-v10.yml`

Shared Project primitives also exist in:

- `scripts/browser-operations-v1.mjs`

Do not broaden the shared manager unless the dedicated v10 experiment proves the specific UI behavior first.

## What has been proven

### Fresh immutable secret works

The post-PR-505 Project-wake test successfully reached ChatGPT using:

- immutable bootstrap-secret state;
- home-exit routing;
- no initial Cloudflare challenge.

### Sidebar handling was repaired

First merged Project-wake run after PR #505:

- Run: https://github.com/curveyield3/Contract-Automation/actions/runs/37152260428
- Result: failure in Project navigation.
- Narrow cause: Projects was not visible and the routine incorrectly treated absence of an explicit sidebar-open button as failure.

PR #506 fixed that by allowing an already-open sidebar and human-scrolling the sidebar until Projects is visible.

### Latest run advanced beyond the sidebar blocker

Latest merged Project-wake run:

- Run: https://github.com/curveyield3/Contract-Automation/actions/runs/37152694131
- Browser job ID: `111289642878`
- Home exit: success.
- Fresh immutable bootstrap state: success.
- Initial ChatGPT load: success.
- Cloudflare before Project interaction: **none**.
- Sidebar/Projects handling: advanced past the previous blocker.
- Current terminal failure:

```text
Project-name input was not found in the visible Project dialog
```

The run reached normal browser readiness at approximately `20:47:38Z` and failed at approximately `20:47:49Z`.

This is now the **only proven live blocker**.

## Current blocker

After the browser follows the Projects-hover-plus path, the v10 code expects one of these Project-name controls:

```text
[role="dialog"] input[placeholder*="Project name" i]
[role="dialog"] input[aria-label*="Project name" i]
[role="dialog"] input[name="name"]
[role="dialog"] input
```

The current ChatGPT UI did not match those assumptions.

Do **not** infer from this that Tailscale, login state, sidebar handling, or the Project plus control is broken. The finalized run proves those earlier stages were no longer the terminal failure.

## Exact next action for successor

1. Refetch current `main`.
2. Update the focus lock to state that PR #506 is merged and the live blocker is now the Project-name field after the plus-click.
3. Create **one** new narrow repair branch from current `main`.
4. Reproduce/inspect the visible UI immediately after clicking the hover-revealed Projects plus.
5. Determine the actual visible Project-name editing control.
   - Use visible UI / local DOM structure only.
   - Do not call ChatGPT backend endpoints.
   - Do not use network request/response telemetry.
6. Update only the Project-name field locator/interaction needed for the current UI.
7. Preserve the exact human flow and randomized pacing.
8. Add/update a regression test so the current Project-name control is recognized without reintroducing generic or non-human fallbacks.
9. Run both existing repository validation lanes.
10. Merge the narrow repair to `main` only after both pass.
11. Let the re-armed `project_wake` test run on merged code.
12. Success criterion:
    - create Project `HOME_EXIT_PROJECT_WAKE_VERIFY1`;
    - create/use a chat inside that Project;
    - visibly send the exact wake;
    - no machine backend reads/writes;
    - if Cloudflare appears, terminate immediately;
    - obtain/persist the Project URL when the Project flow reaches the existing share-link step.

## Do not regress these solved invariants

Do not:

- restore the rolling session-state cache;
- save automated browser state for future runs;
- change the immutable secret-state baseline;
- remove the randomized human pacing;
- replace user-required Project creation with a shortcut;
- add direct ChatGPT backend/API reads;
- add network-response verification;
- add non-human write fallbacks;
- alter audit wake/monitor/orchestration pathways;
- restart work from PR #505 or PR #506 branches;
- redesign Tailscale because a GitHub step label looks stale;
- resend blindly after a post-Send challenge.

## Focus lock

Current lock path:

- `process/development-agent-task-manager/status/FOCUS_LOCK_UPGRADE_AGENT_LAUNCHER_IMPLEMENTATION_v1.md`

At handoff time, that file still describes `browser-project-sidebar-scroll-v1` as the active repair even though PR #506 has already merged. The successor must re-anchor it to current `main` and the Project-name-input blocker before making further code changes.

## Validation evidence

PR #505 head validations:

- Lite Structured Phase Regression v2 — run `37152130552` — success
- V7 Execution Infrastructure Qualification — run `37152130474` — success

PR #506 head validations:

- Lite Structured Phase Regression v2 — run `37152595362` — success
- V7 Execution Infrastructure Qualification — run `37152595455` — success

Post-merge PR #506 validation also completed successfully before the latest browser experiment.

## Successor anti-drift rule

Before every meaningful action, ask:

> Which exact current blocker does this action eliminate or verify?

The current blocker is:

> **The browser reaches the Project-create UI but cannot identify the visible Project-name editing control after clicking the hover-revealed Projects plus.**

If an action does not directly diagnose, repair, validate, or retest that blocker, do not do it.

## Final state at handoff

Completed:

- bootstrap-secret-only session baseline;
- rolling browser-session cache removal;
- human randomized pacing;
- exact Projects-title hover + plus flow;
- sidebar-open/already-open handling;
- human sidebar scrolling;
- home-exit routing;
- immediate Cloudflare abort policy;
- 5-minute ordinary readiness cap;
- validation for PR #505 and PR #506;
- merges of PR #505 and PR #506.

Not completed:

- adapting the Project-name control to the current UI;
- successful creation of `HOME_EXIT_PROJECT_WAKE_VERIFY1`;
- successful wake inside that Project;
- return to the full upgrade-agent launcher smoke after the Project experiment succeeds.

Resume **exactly** at the Project-name-input blocker.
