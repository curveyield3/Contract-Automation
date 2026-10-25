# Focus Lock — Upgrade Agent Task-Lock + Browser Manager Repair v2

## END-STATE INVARIANT

Upgrade the development-agent control plane in `curveyield3/Contract-Automation` so development/upgrade agents:

1. remain anchored to one explicit human-requested end-state;
2. work only the smallest remaining live delta;
3. preserve satisfied work across supervision/replacement;
4. use the corrected browser automation pathway already finalized on current `main`, instead of the stale direct browser wake/poke setup still embedded in the Development Agent Task Manager;
5. default to a persistent ChatGPT Project so agents can survive context exhaustion, replacement, and multi-agent handoff without losing task continuity.

## BROWSER CONTINUITY DEFAULT

Project-backed execution is the default for managed development/upgrade tasks.

Rationale: development agents commonly exhaust conversation context or chat length before completing non-trivial tasks. The durable Project is therefore the normal continuity boundary, while individual chats are replaceable workers.

Default behavior:

- First worker creates one ChatGPT Project for the managed task.
- The private Project share URL is captured through the normal UI and persisted durably.
- The first chat is created inside that Project.
- Replacement/successor agents reopen that exact persisted Project URL and create a fresh chat inside the same Project.
- If a chat disappears or exhausts context, replace the chat, not the Project.
- Never create a second Project for the same manager ID unless the human explicitly requests a reset.

Lightweight exception:

- A clearly tiny task that is expected to require only one agent and no successor/replacement may use a normal standalone chat.
- This is an exception, not the default.
- If such a task later needs replacement or continuation, migrate into a Project-backed managed task rather than repeatedly creating unrelated standalone chats.

## CORRECTED BROWSER PATHWAY

Use the current corrected browser automation primitives already finalized on `main`, including:

- visible Chrome under Xvfb;
- GitHub-hosted Playwright as the production browser provider;
- encrypted ChatGPT session-state restore and persistence;
- Tailscale connection and home exit-node routing;
- private tailnet VNC support where the current shared pathway requires it;
- durable write verification before treating a wake/poke as delivered;
- persisted Project URL handling;
- deterministic Project creation/opening;
- Project-local fresh-chat creation;
- safe replacement behavior that reuses the Project and replaces only the chat.

Do not reuse the Development Agent Task Manager's stale direct browser setup when the corrected shared primitives already exist.

Do not copy audit-specific wake-message content into development tasks. Reuse browser transport and generic browser operations, not audit reviewer instructions.

## HARD EXCLUSION

Do **not** incorporate the development task-lock policy into the existing audit execution pathway.

That exclusion includes:

- audit reviewer wake instructions;
- audit reviewer watchdog/monitor policy;
- audit campaign phase orchestration;
- audit phase handoffs;
- Audit V7 execution/qualification workflows;
- audit-source initialization;
- lite audit phase workflows;
- audit-specific registration, receipt, or campaign-state semantics.

Audit browser files may be inspected as the current source of the corrected generic browser transport/Project primitives. Reuse of those generic browser primitives is allowed. The development task-lock behavior itself must remain development-only.

## CURRENT MAIN BASELINE

- Repository: `curveyield3/Contract-Automation`
- Baseline main commit: `5a34b046e2211a4cb4a3f4065156ab91d8770c80`
- Working branch: `upgrade-agent-focus-lock-v1`

## AUTHORITATIVE IMPLEMENTATION AREA

Primary implementation surface:

`process/development-agent-task-manager/`

Primary launcher/supervisor:

`.github/workflows/development-agent-task-manager.yml`

Generic browser primitives may be reused from the current shared browser stack, especially:

- `scripts/browser-agent-wake.mjs`
- `scripts/browser-operations-v1.mjs`
- `scripts/browser-routine-engine-v1.mjs`
- `.github/actions/setup-browser-agent-runtime`
- current home-exit/session-state mechanics already used by the corrected browser pathway.

## SATISFIED

- Located the existing Development Agent Task Manager.
- Confirmed `process/development-agent-task-manager/` is the correct home for the permanent task-lock protocol.
- Created a dedicated implementation branch.
- Added `TASK_LOCK_PROTOCOL_v1.md`.
- Added `TASK_LOCK_STATE_TEMPLATE_v1.md`.
- Wired task-lock identity and state-path requirements into initial, supervision, replacement, and completion logic.
- Added completion gating on `REMAINING DELTA: - None` and `ACTIVE BLOCKER: None`.
- Located the corrected browser pathway on current `main`, including home-exit Playwright and deterministic Project create/open/share-link behavior.
- Removed audit-specific routine-ID coupling from the shared browser script while preserving the same Project semantics.
- Added development-specific Project create/open routines that reuse the corrected generic Project operations.
- Added `managed_project` as the default continuity mode and `standalone` as the explicit tiny-task exception.
- Initial managed workers create one Project and require a private Project share URL before success.
- Durable manager state persists continuity mode plus Project name/private URL.
- Replacement workers reopen the exact persisted Project and create a fresh child chat; they do not create a second Project.
- Replaced Development Agent Task Manager Browserless/Browserbase environment with GitHub-hosted Playwright + Xvfb + Tailscale home-exit + encrypted session-state handling.
- Updated development-agent documentation.
- Opened draft PR #490 for GitHub-side validation; no merge has been performed.
- First qualification failure was diagnosed as a stale regression assertion requiring an audit routine ID in the now-generic shared script; that test was repaired.
- Rechecked `main`; baseline remains `5a34b046e2211a4cb4a3f4065156ab91d8770c80`.

## REMAINING DELTA

- None

## PARKED OBSERVATIONS

- General repository organization issues are outside this task.
- Audit methodology changes are outside this task.
- Audit-specific wake-message redesign is outside this task.
- Unrelated workflow cleanup is outside this task.
- Any defect discovered outside the development-agent manager/browser continuity path is parked unless it directly prevents this implementation.

## ACTIVE BLOCKER

None

## NEXT ACTION

Human merge approval for draft PR #490. No implementation work remains on this branch.

## ANTI-DRIFT CHECK

Before every new implementation action, answer:

`Which REMAINING DELTA item does this action eliminate or verify?`

If the answer is none, do not perform the action.
