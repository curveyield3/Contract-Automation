# Audit Browser Automation + Controller Successor Handoff v1

## Purpose

This handoff preserves the critical browser-automation and automated-audit control-plane knowledge learned while making the CurveYield Lite audit system actually deliver reviewer wakes through ChatGPT and move campaigns across controller boundaries.

Repository:

`curveyield3/Contract-Automation`

Related controller repository:

`curveyield3/Audit-Controller`

This handoff is intentionally focused on the live audit automation pathway:

`Audit-Controller state -> Lite browser orchestrator -> reviewer registration -> browser wake -> watchdog -> controller boundary -> next orchestrator/wake`

It also records the exact browser interaction method that produced the first confirmed successful reviewer wake and the regressions that repeatedly broke it.

The successor MUST preserve newer unrelated audit-system improvements already on `main`. Do **not** wholesale-revert entire workflows merely to recover browser behavior. Restore only the browser-interaction/control-plane portions that have regressed unless a full-file regression is proven.

---

## Current live campaign state at handoff creation

Campaign:

`curveyield-dex-v16-source-r3`

Audit-Controller directory entry:

`Audit Campaign Directory/campaigns/curveyield-dex-v16-source.json`

Current canonical state at handoff creation:

- campaign status: `WAITING_FOR_SUCCESSOR_AGENT`
- current assignment: Phase 2
- reviewer: `reviewer-2`
- Phase 1 is sealed
- last sealed receipt: `campaigns/CurveYield DEX v16 Source r3/receipts/PHASE_01_RECEIPT_v2.json`
- Phase-2 work form: `campaigns/CurveYield DEX v16 Source r3/work/phase-02/PHASE_02_WORK_FORM_v1.json`
- Phase-2 packet path: `campaigns/CurveYield DEX v16 Source r3/submissions/PHASE_02_WORK_PACKET_v1.json`

Current browser registration:

`process/browser-agent-wake/registrations/curveyield-dex-v16-source-r3.json`

Registered fixed reviewer chats:

- reviewer-1: `https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da50-e3a0-83e8-88ea-843db6f426f0`
- reviewer-2: `https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da6a-3e4c-83e8-9154-73b4c7388f85`
- reviewer-3L: `https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da70-dbfc-83e8-89f8-532603efc0af`
- reviewer-4: `https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da76-f048-83e8-9cdc-26399ce8b161`

Current registration interaction policy:

`phase1-fixed-x11-normal-chrome-no-chatgpt-page-read-v1`

Current registration watchdog poke interval:

`20 minutes`

Current registration `wakeDelivery` still records the proven Phase-1 delivery, not Phase 2.

At handoff creation there were **no active browser-agent wake, watchdog, home-exit, or Lite browser-orchestrator runs**.

---

# 1. The browser interaction that actually worked

## Human-confirmed Phase-1 success

The decisive audit-path breakthrough was a reviewer-1 wake delivered using **normal system Chrome launched directly**, with OS/X11 interaction rather than Playwright browser launch/input.

The user personally saw the Phase-1 wake appear in reviewer-1 and saw the reviewer respond/start.

Relevant proof-era commits:

- `9436ea0d848632731ce4ac66a8fec8e287c576fb`
  - `fix(home-exit): use normal system Chrome plus X11 for existing wake v7`
- `98af93460cfe927cc6e4d87debd251e7a8b48edb`
  - `fix(home-exit): verify normal Chrome wake without destructive reload v8`

The successful audit wake run discussed during recovery was:

`37200094496`

The important behavior was not the later workflow conclusion. The user visually confirmed that the wake appeared in the reviewer chat and the agent started.

## Proven interaction pattern

The browser behavior to preserve is:

1. GitHub-hosted Ubuntu runner.
2. Xvfb visible display.
3. Tailscale joins the private tailnet.
4. Browser traffic routes through the user's home exit node.
5. **System Google Chrome is launched directly**.
6. No headless mode.
7. No `--enable-automation` style browser launch.
8. ChatGPT bootstrap cookies/session data are loaded.
9. Navigation is performed with real X11 keyboard input.
10. ChatGPT composer is targeted at the **same fixed screen point used by the successful Phase-1 wake**.
11. Wake text is entered with the proven X11 typing cadence.
12. Submission is X11 `Enter`.
13. Do not use machine-style ChatGPT composer writes.
14. Do not use ChatGPT DOM/page reads as the basis for the audit wake/watchdog path.

The fixed composer point used by the proven Phase-1 implementation is:

`composerX = round(displayWidth * 0.63)`

`composerY = displayHeight - 72`

On the fixed 1920x1080 X11 display this targets the same visible composer location for all four pre-created reviewer chats.

The user's explicit direction is to reuse this **same exact interaction process** for:

- reviewer wakes;
- future phase reviewer wakes;
- watchdog `GET BACK TO WORK` pokes;
- reviewer repair/resume messages.

Do not invent a new interaction method when the proven method already exists.

---

# 2. Hard browser rules / non-regression invariant

For the live audit pathway:

## Required

- normal system Chrome;
- visible X11 display;
- home-exit/Tailscale routing;
- pre-created reviewer chat URLs;
- `resume_existing`;
- X11 address-bar navigation;
- X11 mouse movement/click;
- fixed Phase-1 composer point;
- X11 human typing;
- X11 Enter to send;
- one browser owner at a time.

## Forbidden

Do not reintroduce any of the following into the live audit reviewer/watchdog message path:

- Playwright-launched Chrome;
- headless Chrome;
- Playwright `fill()`;
- Playwright `press()` for ChatGPT message entry;
- `page.keyboard.insertText()`;
- DOM-based composer writes;
- DOM-based composer coordinate targeting;
- DOM focus checks used to position the mouse;
- ChatGPT transcript scraping to decide whether the reviewer is idle;
- ChatGPT assistant-message count/hash scraping for watchdog activity;
- parallel workflows using the same saved ChatGPT browser state;
- destructive post-send reload verification;
- old create-fresh reviewer flows when a fixed reviewer chat already exists.

The user's browser rule is stricter than merely "make Playwright look human":

**All interaction with the ChatGPT site must use normal human-style browser interaction. Machine-style ChatGPT reads/writes are prohibited.**

Playwright/CDP libraries may exist in the runtime for bootstrap plumbing, but they must not replace the human-style X11 interaction path on ChatGPT.

---

# 3. Important browser failure history

## A. Playwright-launched browser caused Cloudflare rejection

A headful browser was not enough.

Earlier attempts used OS-level typing but Chrome was still launched/controlled through Playwright. ChatGPT could optimistically show the user message locally, but the backend rejected it with a Cloudflare challenge.

Critical observation:

- browser looked like it sent;
- blue user bubble could appear temporarily;
- after reload, the message was absent;
- page exposed `cloudflare_challenge / Retry`.

The breakthrough came from launching **normal system Chrome directly**.

## B. Old user-message DOM selector produced false failure

An old verifier depended on:

`[data-message-author-role="user"]`

Current ChatGPT DOM no longer reliably exposed that role selector.

This led to false `userCount: 0` results even when the blue user message was visibly rendered.

Do not rebuild audit correctness around unstable ChatGPT DOM selectors.

## C. Destructive reload verification caused false negatives

After successful-looking sends, forced reloads sometimes produced:

`We couldn't load your account`

or Cloudflare browser-state failures.

Do not require a post-send reload to declare browser input successful.

Controller progression is the durable audit-system signal.

## D. Mutable-main request race

The isolated home-exit workflow once started as a monitor test but checked out mutable `main`, then consumed the newer DEX wake request instead.

Result: the wrong payload ran.

The proof workflow was repaired to resolve push-triggered request data from the **triggering commit**, not mutable later `main`.

General rule:

**A workflow must not resolve a mutable request after launch if a later commit can replace that request.**

## E. One saved browser state cannot be used concurrently

Wake and watchdog workflows must not run in parallel against the same ChatGPT browser state.

Shared concurrency key used during recovery:

`chatgpt-shared-browser-session-v1`

Required behavior:

`cancel-in-progress: false`

Queue browser ownership. Do not cancel the current owner merely because another phase/wake/watchdog request arrives.

## F. X11 fixed point is safer than DOM->screen coordinate translation

One failed experiment found a Playwright composer bounding box and sent those coordinates directly to `xdotool`.

That is unsafe because:

- Playwright `boundingBox()` coordinates are viewport/page coordinates;
- `xdotool mousemove` expects X11 screen coordinates.

The artifact showed an entirely blank composer after the system claimed to type the whole wake.

The user rejected replacing the known-good method with DOM/focus machine reads.

The correct recovery was:

**reuse the exact fixed Phase-1 X11 composer point.**

## G. Blank artifact / `NORMAL_CHROME_NOT_READY`

One retry produced a completely blank artifact because system Chrome never exposed the local CDP endpoint before the readiness timeout.

This was a Chrome startup/readiness failure, not a typing failure.

The readiness gate was widened from 30 seconds to 60 seconds.

Do not confuse a blank pre-browser artifact with a ChatGPT send failure.

## H. Do not overinterpret cancelled runs

A run the user cancels is not evidence that the underlying typing/send logic failed.

Separate:

- real automation failure;
- explicit human cancellation;
- transport/setup failure;
- verifier false-negative;
- actual server rejection.

---

# 4. Current important browser files and identities

As inspected immediately before this handoff:

## Standard wake workflow

`.github/workflows/browser-agent-wake.yml`

Current content blob SHA observed:

`1af4d45d0fe03f147b8aafcd981780f847eaf5ac`

The workflow currently includes newer roles such as:

- `reviewer`
- `interphase_mechanical`
- `master_reviewer`
- `repair_child`

Do not remove newer audit-system roles merely to recover browser behavior.

## Standard watchdog

`.github/workflows/browser-agent-watchdog.yml`

Current content blob SHA observed:

`31abc6ee0ab36ad7e3c16ddb6a2a4c0335ea49ec`

## Lite browser orchestrator

`.github/workflows/lite-audit-browser-orchestrator-v1.yml`

Current content blob SHA observed:

`76977f3905b18da7e39103859124921bf6ef34d4`

## Standard browser runtime

`scripts/browser-agent-wake.mjs`

Current content blob SHA observed:

`e23ff78497d00910d7981c72a2f59969a91d39e1`

## Short wake generator

`scripts/prepare-lite-assignment-successor-v2.mjs`

Current content blob SHA observed:

`5a65982a540bd6491299b9b5571f23be98bd5b3b`

## Current reviewer repair workflow

`.github/workflows/browser-agent-reviewer-repair-v1.yml`

Current content blob SHA observed:

`f7fd927337883cfc737808ae5040bfe539e123f9`

These SHAs are snapshot identities, not instructions to revert entire files.

---

# 5. Recent restore anchors after suspected overwrite/regression

Recent commits on `main` show that another workstream changed the browser/audit code and then browser-specific pieces were restored.

Important restore anchors:

## Fixed-X11 sender restoration

`15ad05e37f93c6d82a8a1266a1579c6cbe8d69eb`

Message:

`restore(browser): remove model blocker from proven fixed X11 sender v1`

Touches:

`scripts/browser-agent-wake.mjs`

## Short reviewer wake restoration

`0338cfc7c70baad9d62ba9601b5729ffaf814521`

Message:

`restore(wake): reinstate short reviewer successor message v1`

Touches:

`scripts/prepare-lite-assignment-successor-v2.mjs`

## Master repair payload follow-up

`51cef0189de0eaae511ceb176fbcd27529a5f9ff`

Message:

`fix(browser): preserve explicit master repair verification payload v1`

Touches:

`.github/workflows/browser-agent-wake.yml`

Successor instruction:

**When restoring browser behavior, compare these commits and current `main` carefully. Do not blindly reset whole files because later master-review/controller work may be intentional.**

Use local proven code first, then minimal modification.

---

# 6. Short future reviewer wake message

The correct current reviewer wake generator is:

`scripts/prepare-lite-assignment-successor-v2.mjs`

At handoff creation it generated only:

```
LITE audit: <campaign name>
Reviewer: <reviewer>
Current phase: <phase>
Campaign: <campaign URL>
Current Audit Skill Authority: <authority URL>

The Audit Skill Authority above is the ultimate authority for this audit. Follow every instruction it gives, in order, precisely, with no deviation. Use the GitHub connector app exactly as required by that authority.

Start <phase> now. Use the sealed predecessor evidence and controller-derived inputs already present in the campaign. Do not redo sealed earlier phases.
```

Do not re-add the old wake block containing:

- phase schema URL;
- work-form URL;
- final-report URL;
- packet URL;
- receipt URL;
- Phase-0 evidence links;
- explicit controller-validation workflow directions.

Those obligations belong in the skill/controller state, not in the wake message.

The wake message should be short enough that normal human-style X11 typing is practical.

---

# 7. Audit automation architecture

## Canonical authority

The Audit-Controller repository is the durable source of campaign state.

For current Lite assignment-v2 campaigns, the key campaign directory entry is:

`Audit Campaign Directory/campaigns/<campaign-slug>.json`

It tells the browser orchestrator:

- campaign status;
- current phase;
- current reviewer;
- current work form;
- packet path;
- predecessor receipt;
- derived inputs.

Browser automation must not invent campaign progression independently.

## Orchestrator

Current orchestrator:

`.github/workflows/lite-audit-browser-orchestrator-v1.yml`

Responsibilities:

1. read canonical Audit-Controller directory state;
2. derive the incoming phase/reviewer;
3. generate the short reviewer wake;
4. load campaign browser registration;
5. resolve the assigned reviewer's pre-created chat from `.agentChats`;
6. bind `.activeChat` / `.activeAssignment`;
7. dispatch `browser-agent-wake.yml` in `resume_existing` mode.

Important invariant:

**The orchestrator does not need to create new ChatGPT projects/chats for the current DEX audit because all four reviewer chats are already pre-created.**

## Registration

One registration per campaign:

`process/browser-agent-wake/registrations/<safe-campaign-id>.json`

Important fields:

- `agentChats`
- `activeChat`
- `activeAssignment`
- `browserInteractionPolicy`
- `watchdog`
- `repair`
- `wakeDelivery`

For current audits, registration should carry:

`browserInteractionPolicy: phase1-fixed-x11-normal-chrome-no-chatgpt-page-read-v1`

## Wake workflow

Current standard wake:

`.github/workflows/browser-agent-wake.yml`

Required semantics:

- `resume_existing`;
- target URL must be a pre-created registered reviewer chat;
- shared browser concurrency;
- route browser traffic through home exit;
- normal system Chrome;
- Phase-1 fixed X11 interaction;
- arm watchdog only after the wake path completes successfully enough for the controller system to continue.

## Watchdog

Current standard watchdog:

`.github/workflows/browser-agent-watchdog.yml`

The intended current design is:

- scheduled every five minutes;
- inspect **controller/campaign state**, not ChatGPT transcript/DOM;
- if assignment already advanced or campaign terminal, retire;
- if assignment is still active, avoid immediate interruption;
- default poke interval in registration: 20 minutes;
- when elapsed gate is reached, send exactly:
  `GET BACK TO WORK`
- use the same normal-Chrome/fixed-X11 sender as reviewer wakes;
- never use a second browser simultaneously;
- transport failures are infrastructure failures, not reviewer guilt.

Why 20 minutes:

The user observed a reviewer work productively for approximately **18 minutes continuously** after a manual reprompt before completing Phase 1. A five-minute blind poke cadence would interrupt legitimate long work.

The watchdog must stop/retire at the next phase/reviewer boundary before the next wake gets browser ownership.

## Browser ownership lifecycle

Required lifecycle:

`WAKE owns browser`
-> wake interaction completes
-> `WATCHDOG owns browser`
-> controller seals/advances assignment
-> watchdog retires
-> next `WAKE owns browser`

Wake and watchdog must share one concurrency group.

Do not run them in parallel.

---

# 8. Reviewer repair

Current workflow:

`.github/workflows/browser-agent-reviewer-repair-v1.yml`

Current assignment-v2 repair is intended to be resume-first.

For current audits, repair should use the assigned pre-created reviewer chat and standard browser wake path.

Do not revive old legacy reviewer-repair flows that create unrelated fresh chats via a different browser mechanism.

A repair message must preserve exact controller-reported deficiencies/verification requirements when the controller provides them.

Recent commit relevant to this area:

`51cef0189de0eaae511ceb176fbcd27529a5f9ff`

---

# 9. Master-review / newer audit-system work

Recent `main` includes substantial master-review / qualification work after the browser recovery.

Examples in recent history include:

- mandatory Lite segment master-review gate;
- trusted master transport proofs;
- repair transport proof requirements;
- master-review integrity/identity gates;
- new wake worker roles such as `master_reviewer` and `repair_child`.

The successor MUST distinguish:

1. browser-transport regressions that should be restored to the proven X11 path; from
2. legitimate newer controller/master-review logic that must be preserved.

Do not "restore the browser" by resetting the repository to an old commit.

Instead:

- inspect diffs;
- copy the proven browser block;
- make minimal edits;
- preserve current controller schemas, roles, gates, and master-review machinery.

---

# 10. Controller / watchdog / orchestrator lessons

## Controller owns truth

The controller decides phase status, sealing, deficiencies, and successor assignment.

The browser layer should not manufacture controller bookkeeping.

## Orchestrator owns successor routing

At a successor boundary, let the orchestrator derive:

- reviewer;
- phase;
- correct registered chat;
- short wake.

Avoid duplicate successor launch logic buried inside watchdog code.

## Watchdog should supervise, not become a second orchestrator

The watchdog's core jobs are:

- inspect canonical controller state;
- decide whether current assignment remains active;
- time-gate a simple wake/poke;
- retire at successor boundary;
- hand control back to orchestrator.

Avoid large duplicated successor-generation logic inside watchdog.

## Browser state is exclusive

All workflows touching the ChatGPT browser state must serialize.

A separate "monitor" workflow may not concurrently reuse the same saved state.

## Idempotency matters

A workflow retry must distinguish:

- nothing typed;
- message possibly typed but not sent;
- message sent;
- controller already advanced.

Do not resend merely because a verifier is uncertain.

Controller state is stronger evidence than a brittle ChatGPT DOM probe.

---

# 11. Current suspected-overwrite recovery strategy

The user explicitly suspects another agent overwrote the working browser workflows without permission.

Successor recovery procedure:

1. Inspect recent commits touching:
   - `scripts/browser-agent-wake.mjs`
   - `.github/workflows/browser-agent-wake.yml`
   - `.github/workflows/browser-agent-watchdog.yml`
   - `.github/workflows/lite-audit-browser-orchestrator-v1.yml`
   - `scripts/prepare-lite-assignment-successor-v2.mjs`
   - `.github/workflows/browser-agent-reviewer-repair-v1.yml`
2. Compare the browser-interaction sections to the proven Phase-1 implementation.
3. Preserve newer non-browser controller/master-review work.
4. Restore only the minimal browser-interaction sections needed.
5. Verify:
   - normal system Chrome direct launch;
   - no Playwright ChatGPT writes;
   - fixed Phase-1 composer coordinate;
   - X11 typing;
   - X11 Enter;
   - fixed registered reviewer chat;
   - shared concurrency;
   - no ChatGPT DOM activity read in watchdog;
   - short wake message.
6. Do not start multiple browser workflows to test simultaneously.
7. Prove one isolated wake first if testing is required.
8. Only after proof should current Phase-2 automation be restarted.

Historical code anchors:

- direct normal Chrome + X11 introduction:
  `9436ea0d848632731ce4ac66a8fec8e287c576fb`
- non-destructive verification follow-up:
  `98af93460cfe927cc6e4d87debd251e7a8b48edb`
- recent restored current sender:
  `15ad05e37f93c6d82a8a1266a1579c6cbe8d69eb`
- recent restored short wake:
  `0338cfc7c70baad9d62ba9601b5729ffaf814521`

---

# 12. What not to do

Do not:

- rewrite the automation system from scratch;
- create another browser package just to test;
- create parallel watchdog/browser variants;
- add automated bureaucracy to compensate for unreliable browser interaction;
- restore deprecated create-fresh reviewer creation unless explicitly required;
- use DOM screenshots/reads as a substitute for controller state;
- run several browser workflows concurrently;
- overwrite working browser code while changing unrelated audit/controller features;
- remove current master-review/controller work during browser recovery;
- re-add the verbose old wake text;
- treat GitHub-green as proof of ChatGPT delivery;
- treat GitHub-red/cancelled as proof of failed delivery without inspecting what happened.

Always prefer:

**existing proven local code -> copy -> minimal modification -> verify.**

---

# 13. Immediate successor priorities

1. First verify whether the working browser interaction sections on current `main` have been overwritten since the restore anchors above.
2. If overwritten, restore only those browser sections from the proven implementation.
3. Preserve current master-review/controller upgrades.
4. Confirm the DEX registration still binds all four reviewer chats.
5. Confirm current campaign remains at Phase 2/reviewer-2 before sending anything.
6. Confirm there are no active browser workflows.
7. Verify watchdog and wake share one browser-state concurrency group.
8. Verify the watchdog retires before successor wake.
9. Verify future wakes use the short message generator.
10. Only then resume Phase-2 automated wake/watchdog progression.

At handoff creation there are no active browser runs, so the successor has a clean recovery point.

---

# 14. Concise successor wake message

Use this to brief the next agent:

> Continue the audit-browser automation recovery in curveyield3/Contract-Automation from `process/development-agent-task-manager/handoffs/AUDIT_BROWSER_AUTOMATION_CONTROLLER_SUCCESSOR_HANDOFF_v1/README_v1.md`. Preserve all newer controller/master-review work. First inspect whether the proven browser path was overwritten. The browser invariant is normal system Chrome + home exit + fixed Phase-1 X11 composer point + X11 typing + X11 Enter, using pre-created registered reviewer chats and one shared browser owner. Do not use Playwright/DOM ChatGPT writes or watchdog ChatGPT DOM reads. Restore only minimal browser sections, verify no active browser workflow, then continue the current DEX v16 r3 Phase-2 automation from canonical Audit-Controller state.
