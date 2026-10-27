# Browser-Agent Audit Wake Control Plane

## Current authority

This directory documents the live audit browser pathway in `curveyield3/Contract-Automation`.

The audit-browser interaction invariant is:

1. reviewer chats are pre-created and stored in the campaign registration;
2. every reviewer wake and watchdog poke uses `resume_existing`;
3. Chrome is launched as ordinary visible system Chrome, not by Playwright;
4. the browser is navigated with real X11 keyboard input;
5. the ChatGPT composer is targeted at the same proven Phase-1 point on the fixed 1920×1080 display:
   - `x = round(displayWidth * 0.63)`
   - `y = displayHeight - 72`;
6. the composer is clicked with X11;
7. message text is typed one character at a time through X11 using the proven Phase-1 skilled-typist cadence;
8. line breaks use X11 `Shift+Enter`;
9. submission uses X11 `Enter`;
10. the audit wake/poke path does not read the ChatGPT DOM, composer contents, focus state, assistant text, generating state, or other ChatGPT page state.

Do not replace this path with Playwright `fill`, `press`, `keyboard.insertText`, DOM-based composer targeting, DOM activity inspection, or other machine-style ChatGPT reads/writes.

The durable policy identifier is:

`phase1-fixed-x11-normal-chrome-no-chatgpt-page-read-v1`

## Registration

Each current audit campaign has one registration:

`process/browser-agent-wake/registrations/<SAFE_CAMPAIGN_ID>.json`

The registration must contain pre-created URLs for:

- `reviewer-1`
- `reviewer-2`
- `reviewer-3L`
- `reviewer-4`

Current reviewer automation is `resume_existing` only. The standard audit wake workflow rejects `create_fresh`.

The template is:

`process/browser-agent-wake/REGISTRATION_TEMPLATE_v1.json`

## Future reviewer wakes

The current Lite successor path is:

`lite-audit-browser-orchestrator-v1.yml`
→ `browser-agent-wake.yml`
→ `scripts/browser-agent-wake.mjs`

The orchestrator resolves the assigned reviewer from Audit-Controller, obtains that reviewer's pre-created chat URL from the registration, generates the short current wake message, and dispatches the standard wake workflow in `resume_existing` mode.

No reviewer successor may bypass this path with a direct browser write.

The retired legacy create-fresh successor launcher in the watchdog fails closed.

## Controller rework continuation and terminal recovery

A published phase `NEEDS_REWORK` is an active, incomplete assignment, **not** a successful phase or a terminal stop. The existing Lite boundary controller now dispatches the existing `browser-agent-wake.yml` to the same registered reviewer after publishing that result. Its substantive message names the current controller work packet and requires a new first-action GitHub acknowledgement; a green boundary Actions job is not a phase PASS. The controller does not rerun test execution merely to wake the reviewer.

The existing watchdog independently checks the active campaign and exact failed packet. It counts reviewer-authored Git progress, not controller-produced submission/evidence commits, and immediately surfaces a newly rejected attempt. A browser `sendAttempted` or successful watchdog job does not prove the reviewer resumed: only a matching new acknowledgement and subsequent durable work can establish takeover/progress.

After the configured number of verified no-progress pokes, the watchdog must hand the still-active `REWORK_REQUIRED` assignment to the **already registered, one-time standby chat** (preserving the campaign, receipt, shards, reviewer identity and unresolved obligations), rather than repeatedly re-dispatching the same unproductive reviewer chat and declaring a successful recovery. If no standby is eligible, use the existing reviewer-repair path and surface its outcome; never invent a chat or a new workflow. The standby is eligible even while `currentAssignment.status` is `REWORK_REQUIRED`.

No controller or watchdog notification authorizes extra tests. An environment/runner defect must be assessed against the actual failed execution's SHA/time and the current runner code before another diagnosis. If progressing requires machine execution and the audit owner has not authorized it, preserve the failure and report that precise authorization blocker; do not execute tests, bypass evidence, or advance the phase.

## Reviewer repair

Current assignment-v2 repair is resume-first and uses the assigned pre-created reviewer chat through `browser-agent-wake.yml`.

Legacy reviewer repair that could create a fresh Playwright-driven chat is retired. A campaign that has not been migrated to the current Audit Campaign Directory assignment-v2 registration fails closed instead of using the legacy browser path.

## Tailnet connection — native GitHub OIDC with authorized device tag

The five browser workflows call `.github/actions/connect-browser-tailnet-oidc/action.yml`, which runs `scripts/browser-agent-tailnet-oidc.sh` with the existing `TS_OAUTH_CLIENT_ID` secret and the **fixed** device identity `tag:audit-browser`. GitHub Actions supplies its signed OIDC identity using `id-token: write`. Tailscale validates the federated identity and internally creates a short-lived, tagged node authorization. No separate `TS_AUDIENCE`, `TAILSCALE_AUTHKEY`, or `TAILSCALE_NODE_TAG` is required.

The effective Tailscale command is:

```bash
sudo -E tailscale up --client-id="$TS_CLIENT_ID" \
  --audience="api.tailscale.com/$TS_CLIENT_ID" \
  --advertise-tags="tag:audit-browser" \
  --accept-dns=false
```

**Tailnet administrator configuration (handled separately from GitHub):** Define `tag:audit-browser` in the tailnet `tagOwners` policy (without replacing existing policy) and authorize that device tag for the existing GitHub OpenID Connect credential. The verified GitHub federated identity subject for this repository is `repo:curveyield3@346794407/Contract-Automation@1430753271:ref:refs/heads/main`. The relevant Tailscale trust credential must allow tagged node registration and `auth_keys` write. Preserve the issuer URL, Client ID, and scopes.

The home exit-node peer must remain reachable by this tagged runner, and the existing private VNC access policy must continue to restrict access to authorized tailnet devices. Keep the existing `BROWSER_HOME_EXIT_NODE` repository variable (or its fallback). The `CHATGPT_STORAGE_STATE_B64` secret is required for the separate authenticated ChatGPT browser session.

**Prior failures and evidence:** The tag-free wake reported `federated identity authkeys require --advertise-tags`. A tagged attempt reported `requested tags [tag:audit-browser] are invalid or not permitted`, showing that the Tailscale-side tag definition/authorization must be corrected. Do not claim success or rerun the wake until the Tailscale administrator confirms the tag is authorized. Only the campaign's current `WAKE_ACK` and controller state can establish successful reviewer takeover.

Official documentation: https://tailscale.com/docs/features/workload-identity-federation and https://tailscale.com/docs/features/tags.

## Concurrent, isolated browser sessions

Each wake and watchdog for a single durable `wake_id` serialize on the same
`chatgpt-browser-session-<wake_id>` GitHub Actions concurrency group. Separate
campaign wake IDs use different groups, and the watchdog matrix allows up to
eight independent browser sessions to be supervised concurrently.

Each GitHub-hosted runner starts a fresh isolated Chrome profile and X11 display.
The configured ChatGPT storage state is read-only bootstrap material, not a
shared mutable Chrome profile. Each interaction must still use the registered
durable chat URL, and no two jobs may write to the same wake session at once.

Lifecycle within one wake session:

`WAKE owns session → wake input completes → WATCHDOG owns same session → boundary reached → watchdog retires`

A successor in another session may run concurrently; stale watchdog targets are
retired by their existing campaign/chat identity checks.

## Audit reviewer wake check-in (v1)

**Every substantive Lite audit reviewer and master-reviewer wake** prepends **DO THIS FIRST, RIGHT NOW** to its custom instructions, including first assignment, later phase-continuation messages, subsequent master-review handoffs, controller rework feedback, and repair notices. Before any other task, the receiving agent must use the GitHub connector to fetch the exact acknowledgement file in its Audit-Controller campaign folder, replace its entire contents using the fetched SHA if it exists, or create the same file only on HTTP 404. Any other lookup error stops the write:

`campaigns/<campaign name>/work/browser/WAKE_ACK_<reviewer>_v1.json`

The message supplies the exact path and exact JSON object containing `schemaVersion`, `ackId`, `wakeId`, `runId`, `phaseId`, and `reviewer`. The acknowledgement is a one-file mutable check-in per reviewer, not a phase receipt, controller transition, or test artifact.

After a visible X11 send attempt, the wake workflow checks that exact file **immediately and every 30 seconds up to five minutes** (11 checks at t=0,30,...,300 seconds). Only a matching acknowledgement constitutes verified reception of the current reviewer instruction; absence is **UNCONFIRMED**, not proof of failure, and does not trigger a duplicate message. A valid check-in can independently verify delivery even when an OS screenshot transition is inconclusive.

**Only** a literal `GET BACK TO WORK` poke is excluded from the check-in instruction and five-minute verification. This includes watchdog and routine technical callback pokes. All other Lite reviewer/master-reviewer messages retain their custom caller-authored payload after the mandatory check-in header. The reviewer identity is resolved from the exact bound ChatGPT chat URL in the campaign registration, so master-reviewer acknowledgements cannot be misattributed to the phase reviewer.

This mechanism never machine-reads ChatGPT. The browser uses only visible system Chrome with human-style X11 interactions and OS screenshots. The GitHub acknowledgement is read via ordinary GitHub repository API operations, not ChatGPT browser inspection.

## Watchdog

`.github/workflows/browser-agent-watchdog.yml` runs scheduled sweeps every five minutes.

The watchdog does **not** inspect ChatGPT.

It reads only durable controller/campaign state from GitHub to determine whether the assignment has advanced or terminated.

If the assignment is still active:

- no browser interaction occurs until the elapsed-time poke gate is reached;
- the default poke interval is 20 minutes;
- this avoids interrupting a legitimate long-running reviewer task such as an 18-minute work stretch;
- once eligible, the watchdog sends exactly `GET BACK TO WORK` using the same Phase-1 fixed X11 sender;
- a successful poke resets the elapsed-time reference;
- transport failures are infrastructure noise and do not count as reviewer failure;
- repeated successful pokes without controller advancement may trigger the current reviewer-repair pathway.

When the controller advances to the next phase/reviewer boundary, the watchdog retires before the successor wake takes browser ownership.

## Wake message

Future reviewer wake text is generated by:

`scripts/prepare-lite-assignment-successor-v2.mjs`

The current short reviewer wake contains only:

- audit/campaign identity;
- reviewer identity;
- current phase;
- campaign URL;
- current Audit Skill Authority URL;
- instruction that the authority is ultimate and must be followed precisely;
- instruction to start the current phase from sealed predecessor/controller-derived state without repeating sealed phases.

Do not restore the old schema/work-form/final-report/controller-validation link block to the wake message.

## Retired browser paths

The scheduled `browser-agent-chat-watchdog-v40.yml` workflow and its live request were removed because they used direct Playwright/DOM interaction.

The legacy reviewer-repair workflow was also removed.

The isolated `browser-agent-home-exit-v10.yml` package remains a development/proof harness. It is not the current audit reviewer/watchdog control path and must not be substituted into the audit pathway without explicitly matching this invariant.

## Browser runtime

The live audit path still uses the isolated browser runtime package to obtain browser libraries needed for session bootstrap, but Playwright does not launch Chrome for the reviewer wake/poke interaction.

The normal audit wake process:

- launches system Google Chrome directly;
- uses the saved bootstrap ChatGPT cookies;
- navigates through the visible browser;
- performs the actual ChatGPT interaction only with X11 input;
- discards the ephemeral runner/browser profile after the run.

## Safety rule for future changes

Before changing any audit browser automation, verify all of the following:

- reviewer target is a pre-created durable chat URL;
- workflow mode is `resume_existing`;
- standard wake workflow is used;
- no direct Playwright/DOM ChatGPT write exists;
- no ChatGPT page observation/read is required;
- fixed Phase-1 X11 composer point is used;
- per-character Phase-1 typing cadence is preserved;
- watchdog and wake for the same wake ID remain serialized by a session-specific group;
- watchdog is retired at the successor boundary before the next wake takes ownership.

If a proposed feature cannot satisfy these requirements, it must fail closed rather than fall back to machine-style ChatGPT interaction.
