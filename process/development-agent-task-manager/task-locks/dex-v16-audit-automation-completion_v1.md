# Development Agent Task-Lock State v1

MANAGER ID:
dex-v16-audit-automation-completion

END-STATE INVARIANT:
From the existing sealed Phase-0 state of `curveyield-dex-v16-source-r3`, the development/supervision work must keep the existing automated audit pathway on one repair-and-execution path until the audit system verifiably advances through every remaining required phase and Audit-Controller records the campaign COMPLETE with all required final receipts/deliverables present. The currently missing reviewer-1 Phase-1 wake must first be delivered and verified as a real rendered user-role message. Completed/sealed work must not be restarted; the four fixed reviewer chat URLs must not be replaced; false-positive wake/watchdog state must not count as progress. This task lock governs only the development/repair/supervision agent and must never be injected into audit reviewer wakes, audit watchdog prompts, or audit phase authority.

CURRENT MAIN:
- curveyield3/Contract-Automation main: `599bd028cbfa1b597c2e1ef8bad790e05744469f`
- curveyield3/Audit-Controller main checked for campaign state: `e1292fd6c77a97801e49d739a5bf1411dbb6d964`

AUTHORITY:
- Task-lock protocol: `process/development-agent-task-manager/TASK_LOCK_PROTOCOL_v1.md` @ Contract-Automation main, blob `1f464444e1f0d148b46aeba2bd93ffda7846f834`
- Successor handoff: `process/development-agent-task-manager/handoffs/DEX_V16_EXISTING_CHAT_AUDIT_WAKE_SUCCESSOR_HANDOFF_v1/README_v1.md` @ Contract-Automation main, blob `d01256c84645cfd600649e58c559c603f6a6067a`
- Audit execution authority remains the campaign's current Audit Skill authority referenced by Audit-Controller; this task lock does not supersede or enter that execution path.

SATISFIED:
- Phase 0 is sealed and must remain closed.
- Campaign `curveyield-dex-v16-source-r3` is ACTIVE at phase-1 / reviewer-1 with the Phase-1 work form and packet already present.
- All four fixed reviewer chat URLs are durably bound in the wake registration and must be preserved.
- Existing-chat wake runtime now requires a marker inside a real `[data-message-author-role="user"]` message with `userCount >= 1`; page-body-only evidence is not valid.
- The successor handoff captures the known false-positive wake history and exact non-regression constraints.

REMAINING DELTA:
- Remove only the false reviewer-1 `wakeDelivery` for `PHASE_1_WORK_PACKET` and disable/reset the stale reviewer-1 watchdog without changing fixed chats, Phase-0 evidence, or the Phase-1 packet.
- Redrive the normal Lite orchestrator so reviewer-1 receives the full dynamic Phase-1 initial wake in `resume_existing` mode; accept success only after strict visible user-role verification and absence of an invalidating browser challenge.
- After verified delivery, persist valid wake evidence and arm the reviewer-1 watchdog.
- Continue supervising the existing automated audit pathway phase-by-phase. For each failure, repair only the blocking automation defect, retry the same intended path, verify the real external result, and continue; do not create parallel workflows, replacement chats/projects, or redo sealed phases.
- Require the controller's normal phase-end validation/receipt before advancing each phase, and preserve live campaign state as the recovery authority across agent/chat replacements.
- Continue until every remaining required audit phase and finalization step completes under the current audit authority, final required receipts/deliverables exist, and Audit-Controller records `campaignStatus: COMPLETE`.
- At completion, update this lock so `REMAINING DELTA` is `- None` and `ACTIVE BLOCKER` is `None`; do not declare completion from chat text, workflow conclusion, or internal flags alone.

PARKED OBSERVATIONS:
- Unrelated Contract-Automation/Katana changes and general repo cleanup are out of scope unless live evidence proves they block this end-state.

ACTIVE BLOCKER:
The Phase-1 initial wake has never been confirmed in reviewer-1. Registration still contains false `wakeDelivery` state and the reviewer-1 watchdog is stale/ACTIVE from that false delivery, so the normal initial-wake path is currently suppressed/poisoned.

NEXT ACTION:
Reset only the poisoned reviewer-1 initial-wake delivery bookkeeping and stale watchdog state, preserving the four reviewer URLs and all sealed/current audit artifacts, then redrive the normal Lite orchestrator for the same Phase-1 assignment.
