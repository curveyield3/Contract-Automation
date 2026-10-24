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

## Reviewer repair

Current assignment-v2 repair is resume-first and uses the assigned pre-created reviewer chat through `browser-agent-wake.yml`.

Legacy reviewer repair that could create a fresh Playwright-driven chat is retired. A campaign that has not been migrated to the current Audit Campaign Directory assignment-v2 registration fails closed instead of using the legacy browser path.

## Tailnet connection — native GitHub OIDC (current)

**One credential, no API-generated auth keys.** The five browser workflows use the existing `TS_OAUTH_CLIENT_ID` federated identity plus GitHub's runtime OIDC token. They invoke the shared local action `.github/actions/connect-browser-tailnet-oidc/action.yml`, which runs `scripts/browser-agent-tailnet-oidc.sh`. It installs the pinned Tailscale static binaries (cached by OS/architecture), starts `tailscaled --state=mem:`, and runs the supported direct native registration command:

```sh
sudo -E tailscale up --client-id="$TS_OAUTH_CLIENT_ID" \
  --audience="api.tailscale.com/$TS_OAUTH_CLIENT_ID" \
  --advertise-tags=tag:audit-browser --accept-dns=false
```

Tailscale v1.94+ supports native GitHub OIDC discovery with `--client-id` and `--audience`. With `id-token: write`, Tailscale retrieves the existing GitHub-signed workload token itself and joins the tailnet directly. The wrapper intentionally does not call the separate Tailscale API auth-key creation endpoint; this avoids the `unexpected error while creating authkey: Status: 404` failure previously seen with `tailscale/github-action@v4`. The runner still registers as a distinct temporary device using in-memory state, and the daemon logs out on exit.

Setup:

1. Configure a GitHub Actions OpenID Connect federated identity at https://login.tailscale.com/admin/settings/trust-credentials with the exact issuer and subject reported by GitHub. For this repository the verified subject was `repo:curveyield3@346794407/Contract-Automation@1430753271:ref:refs/heads/main`. Authorize `tag:audit-browser` and `auth_keys` write.
2. At https://github.com/curveyield3/Contract-Automation/settings/secrets/actions store its Client ID as `TS_OAUTH_CLIENT_ID`. The audience is derived as `api.tailscale.com/<Client ID>`; there is no `TS_AUDIENCE`, `TS_OAUTH_SECRET` or `TAILSCALE_AUTHKEY` requirement.
3. Preserve `CHATGPT_STORAGE_STATE_B64`, the authenticated ChatGPT browser-session secret. This is unrelated to Tailscale authentication.
4. Preserve the existing `BROWSER_HOME_EXIT_NODE` variable (or its configured fallback) and allow `tag:audit-browser` to reach that exit node. Only authorized tailnet peers may reach the runner's private VNC port 5900 (and noVNC port 6080 where used). Do not expose VNC publicly.
5. Run just one authorized wake; before testing check that no other shared browser session/wake/watchdog job is active.

Workflow authentication is `permissions: id-token: write` and local `uses: ./.github/actions/connect-browser-tailnet-oidc` with `client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}` plus the existing `ping` home exit-node input. The workflow fails closed if the identity or session state is missing, or the direct tailnet connection cannot authenticate; it must never bypass the home exit-node contract.

Official reference: https://tailscale.com/docs/features/workload-identity-federation — *Register new nodes using workload identity* and *Automatic cloud token discovery and exchange*. Linux binary installation: https://tailscale.com/docs/install/linux.

## Shared browser ownership

All live audit browser owners serialize on:

`chatgpt-shared-browser-session-v1`

Only one wake/watchdog browser owner may use the saved ChatGPT state at a time.

Lifecycle:

`WAKE owns browser → wake input completes → WATCHDOG owns browser → phase boundary reached → watchdog retires → next WAKE owns browser`

A successor wake must not overlap the predecessor watchdog.

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
- watchdog and wake remain serialized on the shared browser-state concurrency group;
- watchdog is retired at the successor boundary before the next wake takes ownership.

If a proposed feature cannot satisfy these requirements, it must fail closed rather than fall back to machine-style ChatGPT interaction.


If the token exchange succeeds but `tailscale up` reports `unexpected error while creating authkey: Status: 404, Message: "not found"`, the OIDC subject and audience are no longer the immediate blocker; key creation failed at the Tailscale API. First check that the same federated identity has **Keys → Auth Keys → Write** (scope `auth_keys`) and is authorized for the exact `tag:audit-browser` requested by this workflow; the tag must exist in `tagOwners`. This error does not establish whether the missing resource is the auth-key permission, tag, or another tailnet-specific setting; inspect the trust credential's assigned permissions and tag before retrying. Never change tags or retry an unchanged failed run speculatively.
