# Agent Delivery — Operator and Repair Instructions v1

## Purpose and strict isolation

This is the optional `AGENT_DELIVERY` campaign transport. The original `GITHUB_BROWSER` wake workflow, X11 browser sender, browser watchdog, and `WAKE_ACK` mechanism remain independent and unchanged. Neither transport changes audit phase validation, audit authority, or test authorization.

## Start a new Work-mode campaign

Run `.github/workflows/audit-source-initialization-v1.yml`, choose `delivery_transport=AGENT_DELIVERY`, and supply the same seven existing reviewer/master/test/standby chat URLs. The initializer creates exactly one command document in `curveyield3/Audit-Controller`:

`campaigns/<CAMPAIGN_NAME>/work/browser/DELIVERY_COMMAND_v1.md`

The file begins `IDLE`. After Phase 0 the controller queues instructions in that same file. Its name and path within each campaign do not change between commands. All wake, master review, discovery, rework, targeted-executor, repair, and watchdog messages from this delivery lane use this file.

## Required Work relay session setup

Start a dedicated ChatGPT **Work task** with permission to read the private Audit-Controller repository through the connected GitHub app. On the desktop Work experience, enable a browser extension that actually supports interaction with the existing ChatGPT chats. The read-only Opera Browser Connector is **not** a message-sending transport. A cloud Work browser is not automatically the user's signed-in Chrome/Opera browser. Sign into the actual target ChatGPT account and confirm extension/browser access before relying on this mode.

Copy the following instructions into that dedicated Work task, replacing the campaign URL:

> Your only job is message transport for this campaign; do not audit, create a new chat, run tests, or edit any phase or evidence file. Poll the exact GitHub file `<CAMPAIGN_DELIVERY_COMMAND_URL>` about every 60 seconds **while this Work task remains active**. Fetch its latest `main` version each time. If its first line is `PENDING`, read the `## MESSAGE TO DELIVER` section and current JSON control block. Open the exact `current.chatUrl` using the authorized Chrome/Opera extension, and submit the message section **verbatim** to that pre-existing chat. Do not send stale commands with a changed command ID or transport epoch. Never write `COMPLETE-...` yourself; only the receiving agent may place that code at the top of the file. Check the file again to observe the recipient check-in. If first line is `IDLE`, do not send anything; continue polling while active. If a message cannot be sent, diagnose extension/login access; preserve the queued command and notify the operator rather than inventing delivery. Do not trigger additional tests or phase submissions. You must not claim to be polling while the task is inactive or paused.

ChatGPT Work is **not** guaranteed to remain active forever or receive GitHub file-change notifications. This requires a live, authorized Work session. GitHub Actions continues the five-minute repository-side watchdog, but cannot wake a paused Work task by itself. Unattended continuous delivery must not be claimed until proven with a supported external mechanism.

## Recipient first action — applies to every Work-relay message

Each Work-delivered instruction begins with the exact minimum first action:

```text
DO THIS FIRST NOW
<EXACT_CAMPAIGN_DELIVERY_COMMAND_FILE_URL>
COMPLETE-<RANDOM_COMMAND_CODE>
Edit the linked file on main: replace its FIRST LINE with the exact code above, as the first text. Save without changing anything else.
```

The recipient completes this before doing any audit, repair, or reply. Controller-side command verification compares the first line to the currently expected code and command/epoch; it **does not** replace controller evidence or mean an audit phase passed. The Work relay itself does not write the code. The original browser option continues to use its unmodified `WAKE_ACK` procedure.

## Timed watchdog

The scheduled branch of `lite-work-relay-v1.yml` runs every five minutes (subject to GitHub Actions scheduling delays), reads only canonical GitHub state, promotes verified completion codes, tracks reviewer-authored progress, and places new `GET BACK TO WORK` instructions in the **same** file after the inactivity interval. It does not open any browser. A pending/unacknowledged message remains queued; a watchdog does not overwrite it, report delivery, or infer phase acceptance.

## Mid-campaign change or transport repair

Use the existing new Work-relay workflow's manual dispatch with `operation=switch`, exact `campaign_id`, and `target_mode=GITHUB_BROWSER` or `AGENT_DELIVERY`. The switch increments the delivery epoch, preserves all substantive audit artifacts and bound chat URLs, and directs further messages only through the selected path. Do not switch based on a failed audit test or rejected reviewer work: switch only for repeated **transport** failure and verify the other option is ready.

After three successive thirty-minute windows without a valid Work command check-in, classify the Work transport `UNCONFIRMED`; have a repair agent inspect GitHub permissions, Work task activity, browser-extension access, and exact chat availability. If Work delivery still cannot be restored but the original browser path is ready, the repair agent should dispatch `operation=switch`, `target_mode=GITHUB_BROWSER`. Conversely, repeated verified original browser transport failure warrants switching to `AGENT_DELIVERY` **only once** the dedicated Work relay session is visibly active. Avoid flip-flopping modes without new failure evidence.

Current assignments, submitted shards, receipts, master decisions, and prior validation errors remain unchanged during switching. A switch is not authorization to run simulation tests. Existing controller and reviewer start instructions continue to govern audit work.

## Implementation owners

- Initializer UI: `.github/workflows/audit-source-initialization-v1.yml`.
- Canonical mode: Audit-Controller Campaign Directory `deliveryTransport` and `transportEpoch`; derived chat registration: `process/browser-agent-wake/registrations/<SAFE_CAMPAIGN_ID>.json`.
- Work-only runtime: `scripts/work-relay-v1.mjs`.
- Work-only Actions routing and timed watchdog: `.github/workflows/lite-work-relay-v1.yml`.
- Controller choice without modifying original browser files: `.github/workflows/lite-phase0-bootstrap-v1.yml` and `.github/workflows/lite-phase-work-packet-controller-v1.yml`.
- Original browser workflows remain: `.github/workflows/lite-audit-browser-orchestrator-v1.yml`, `.github/workflows/browser-agent-wake.yml`, and `.github/workflows/browser-agent-watchdog.yml`.

**Verification restriction:** No tests are authorized by this document and no test execution is part of enabling the transport.
