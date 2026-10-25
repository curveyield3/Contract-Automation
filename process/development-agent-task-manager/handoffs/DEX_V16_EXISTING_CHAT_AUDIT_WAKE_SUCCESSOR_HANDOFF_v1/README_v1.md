# DEX v16 Existing-Chat Audit Wake Successor Handoff v1

## Objective

Continue the live Lite audit campaign `curveyield-dex-v16-source-r3` from the existing Phase-1 boundary. Do **not** restart Phase 0.

Immediate target: deliver the full Phase-1 wake exactly once into the pre-created reviewer-1 chat, verify it as a real rendered user message, then arm the watchdog.

No Project creation. No Project URL capture. No new reviewer chats.

## Fixed inputs

Source:
https://github.com/curveyield3/Audit-Controller/blob/main/campaigns/CurveYield%20DEX%20v16%20Source.zip

Reviewer chats:
- reviewer-1: https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da50-e3a0-83e8-88ea-843db6f426f0
- reviewer-2: https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da6a-3e4c-83e8-9154-73b4c7388f85
- reviewer-3L: https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da70-dbfc-83e8-89f8-532603efc0af
- reviewer-4: https://chatgpt.com/g/g-p-6ac1d4cc4d6481918fdb4eb38519ea67-dex-v16-audit/c/6ac1da76-f048-83e8-9cdc-26399ce8b161

## Sealed audit state

Audit-Controller directory:
`Audit Campaign Directory/campaigns/curveyield-dex-v16-source.json`

Current authoritative state:
- campaignId: `curveyield-dex-v16-source-r3`
- campaignStatus: `ACTIVE`
- last sealed receipt: `campaigns/CurveYield DEX v16 Source r3/receipts/PHASE_00_RECEIPT_v1.json`
- current phase: `phase-1`
- current reviewer: `reviewer-1`
- current assignment status: `ACTIVE`
- Phase-1 work form: `campaigns/CurveYield DEX v16 Source r3/work/phase-01/PHASE_01_WORK_FORM_v1.json`
- Phase-1 packet: `campaigns/CurveYield DEX v16 Source r3/submissions/PHASE_01_WORK_PACKET_v1.json`

Phase 0 is complete. Machine intelligence, build identity, SBOM, ABI telemetry, Anvil/Medusa simulation evidence and the Phase-0 receipt exist. Do not redo Phase 0.

## Critical truth

**There has NOT been a confirmed successful initial reviewer-1 chat write.**

The user manually checked the reviewer-1 chat and confirmed the initial wake is not there.

Do not trust GitHub Actions success by itself.

### False-positive run 37192624049

https://github.com/curveyield3/Contract-Automation/actions/runs/37192624049

This run concluded success but did not send the full initial wake.

The registration already contained a false `wakeDelivery`, so the idempotency path logged that the initial wake was already delivered and replaced the full wake with `GET BACK TO WORK`.

The run typed only 16 normalized characters. Old verification accepted page text with `userCount: 0`, persisted wake/watchdog state, and reported workflow success. User inspection disproved delivery.

Treat this run as a false positive.

### Earlier full-wake attempt 37192140753

https://github.com/curveyield3/Contract-Automation/actions/runs/37192140753

This run entered the full ~2916-character wake and clicked Send.

Evidence:
- `composer-human-x11-type-verification`
- `normalizedFilledLength: 2916`
- `normalizedMessageLength: 2916`
- `prefixMatches: true`
- `send-strategy=human-pointer-click`

But a ChatGPT/Cloudflare challenge appeared and the run failed with `BROWSER_CHALLENGE`. At that time verification could still falsely accept page text with `userCount: 0`.

Do not count it as a confirmed write.

## Poisoned live state

Registration:
`process/browser-agent-wake/registrations/curveyield-dex-v16-source-r3.json`

It currently contains:
- activeAssignment phase-1 / reviewer-1
- `wakeMessage = "GET BACK TO WORK"`
- false `wakeDelivery.milestoneId = PHASE_1_WORK_PACKET`
- false `wakeDelivery.chatUrl = reviewer-1 URL`
- false `wakeDelivery.deliveredAt = 2026-10-04T09:36:15Z`

That false `wakeDelivery` suppresses the required full initial wake.

Stale watchdog:
`process/browser-agent-watchdog/active/curveyield-dex-v16-source-r3-PHASE_1_WORK_PACKET-reviewer-1.json`

It is ACTIVE, has `assistantCount = 0`, and was armed from the false delivery state.

Before the next initial wake:
1. clear/reset only the false initial-wake delivery bookkeeping;
2. stop/disable the stale reviewer-1 watchdog until a real initial wake is verified;
3. preserve all four `agentChats` bindings;
4. preserve all Phase-0 evidence and receipts;
5. preserve the current Phase-1 packet.

## Current browser-runtime direction

At handoff creation, Contract-Automation main was `b53a9a35405cad4f1f39b5b2a937fb89a358364d`. Main contains unrelated concurrent Katana work; do not globally revert main.

Important later browser-runtime fixes already on main include:
- `8117366f753f9f9bda39e4a50d6fd953230a7306` require an actual rendered user message for wake success
- `ee28d96e07131705814f7db3a5159e4ad82b6500` skilled-human keyboard-only wake entry
- `599204193fbbe60a9c8ac4972d41dc31aadbba04` Project-scoped reviewer chats treated as viewable
- `dab9731f33ed3d276ed9fe36134b591a70680206` skip reload after visible existing-chat wake
- `0c3bf8c697280a3feea8a0bfd0646bf8afd9199c` X11 typing for long reviewer wake
- `6c09bdfe21c7b6a10e8c0a74898f77acc54c0160` preserve pre-created chat thinking configuration
- `b933f5f903518c5d98457f924dcd2e851a4f2a11` remove legacy Project URL bookkeeping
- `6c06fe8deb56934bb92f590586efa755faa9b81a` existing-chat initial wake followed by watchdog

Current `scripts/browser-agent-wake.mjs` has strict verification:
- `wakeMarkerVisible()` checks only `[data-message-author-role="user"]`
- initial existing-chat success requires the marker in a real rendered user message
- `userCount >= 1`
- page-body-only text is not sufficient
- `USER_MESSAGE_NOT_RENDERED` is failure
- `post()` waits up to 90 seconds for an actual rendered user message

Current composer strategy is per-character human keyboard entry with progress checks and final composer verification before Send.

## Exact next steps

1. **Do not restart Phase 0.**
2. Repair the false `wakeDelivery` state for only:
   `curveyield-dex-v16-source-r3 / PHASE_1_WORK_PACKET / reviewer-1`.
3. Disable/reset the stale reviewer-1 watchdog instance until initial wake success is real.
4. Redrive the normal Lite orchestrator. It should regenerate the dynamic Phase-1 wake and call Browser Agent Wake with:
   - `mode=resume_existing`
   - reviewer-1 supplied chat URL
   - `messagePurpose=initial_wake`
5. Do not manually substitute `GET BACK TO WORK` for this initial wake.
6. Do not create a Project or a new chat.
7. Only after verified delivery should the workflow persist `wakeDelivery` and arm the watchdog.

## Acceptance criteria

Do **not** accept these as proof:
- workflow conclusion success
- `bodyHasMarker`
- composer text disappeared
- Send was clicked
- `posted:true`
- `wakeDelivery` exists
- watchdog is armed
- marker appears somewhere in the page body

Required:
1. full Phase-1 wake populated in the composer;
2. Send activated through visible human-style interaction;
3. marker appears inside a visible `[data-message-author-role="user"]` message;
4. `userCount >= 1`;
5. no challenge invalidates delivery;
6. then persist valid wakeDelivery;
7. then arm watchdog.

If the user manually checks the chat and says the write did not occur, that overrides automation success flags.

## Non-regression

- Do not restore Project creation.
- Do not restore Project URL capture.
- Do not create replacement reviewer chats.
- Do not change supplied reviewer URLs.
- Do not restart sealed Phase 0.
- Do not touch unrelated Katana simulator work.
- Do not globally revert main.
- Do not arm watchdog before real initial-wake verification.
- Do not let the false wakeDelivery suppress the required Phase-1 wake.

## Completion target

Success means:
1. reviewer-1 supplied chat visibly contains the full Phase-1 wake as a real user message;
2. strict user-role verification confirms it;
3. false durable delivery state is replaced with valid delivery evidence;
4. reviewer-1 watchdog is armed afterward;
5. no Project/chat was created;
6. the audit continues from Phase 1 without rerunning Phase 0.
