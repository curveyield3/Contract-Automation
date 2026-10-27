# Contract Automation Workflow Inventory

**Version:** v2

This README inventories the core Contract Automation workflows currently organized under `.github/workflows`. The workflows are grouped by functional role within the larger automation system.

## 1. Audit control plane & phase orchestration — 9 workflows

1. [**V7 Audit Controller Execution**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/audit-controller-execution.yml) — `audit-controller-execution.yml`  
   The main V7 execution/controller bridge. It validates execution or controller-operation requests, runs the qualified audit machinery, writes controller results back to Audit-Controller, preserves evidence, and can dispatch the browser-agent wake for the next reviewer.

2. [**Audit Source Initialization**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/audit-source-initialization-v1.yml) — `audit-source-initialization-v1.yml`  
   Initializes a new audit from a supplied source and reviewer-chat request. It resolves the source, selects Audit-Controller credentials, and creates/initializes the corresponding Lite audit campaign.

3. [**Lite Audit Browser Orchestrator Request v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-audit-browser-orchestrator-request-v1.yml) — `lite-audit-browser-orchestrator-request-v1.yml`  
   Converts a pushed orchestrator request into a dispatch of the existing browser orchestrator. It is essentially a request-admission/dispatch shim.

4. [**Lite Audit Browser Orchestrator v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-audit-browser-orchestrator-v1.yml) — `lite-audit-browser-orchestrator-v1.yml`  
   Resolves the campaign and current reviewer assignment, prepares the appropriate wake message, binds the reviewer to the supplied chat, and wakes that reviewer. It supports the persistent reviewer/project routing used by the automated audit system.

5. [**Lite Phase Receipt Controller v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase-receipt-controller-v1.yml) — `lite-phase-receipt-controller-v1.yml`  
   Validates a submitted phase receipt, advances the audit when it passes, publishes the transition, and dispatches fresh successor orchestration.

6. [**Lite Phase Boundary Controller v2**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase-work-packet-controller-v1.yml) — `lite-phase-work-packet-controller-v1.yml`  
   This is the heavier phase-boundary controller. It validates phase work semantically, performs bookkeeping only after PASS, sends deficiencies back to the existing reviewer when needed, advances phases, dispatches successor reviewers, and handles the persistent master-reviewer path.

7. [**Lite Phase 0 Bootstrap Recovery Dispatch v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase0-bootstrap-recovery-dispatch-v1.yml) — `lite-phase0-bootstrap-recovery-dispatch-v1.yml`  
   Recovers a failed/interrupted Phase-0 bootstrap request by resolving one recovery request and redispatching the same campaign through the normal Phase-0 path.

8. [**Lite Fully Automated Phase 0 v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase0-bootstrap-v1.yml) — `lite-phase0-bootstrap-v1.yml`  
   Top-level Phase-0 pipeline. It chains intelligence generation and targeted Phase-0 deployment/evidence processing, finalizes/seals the machine Phase-0 receipt, and then activates Reviewer 1 through the existing browser/orchestrator system.

9. [**Lite V7 Execution Dispatch v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-v7-execution-dispatch-v1.yml) — `lite-v7-execution-dispatch-v1.yml`  
   Validates a V7 execution-dispatch request against the exact campaign/request binding and dispatches it to the qualified V7 execution system with automatic evidence ingestion.

---

## 2. Phase-0 analysis and simulation — 4 workflows

1. [**Lite Phase 0 Intelligence v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase0-intelligence-v1.yml) — `lite-phase0-intelligence-v1.yml`  
   Generates Phase-0 machine intelligence from the submitted source using the retained audit toolchain. It writes the useful intelligence outputs directly into the corresponding Audit-Controller campaign.

2. [**Lite Phase 0 Randomized Simulation v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase0-randomized-simulation-v1.yml) — `lite-phase0-randomized-simulation-v1.yml`  
   Runs or imports the automated Phase-0 testing stages: Anvil baseline/deployment simulation, Medusa, and ABI telemetry. It checks evidence completeness, retains raw outputs, projects results into later audit formats, and publishes the Phase-0 simulation evidence.

3. [**Lite Phase 0 Simulation Rebind v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase0-simulation-rebind-v1.yml) — `lite-phase0-simulation-rebind-v1.yml`  
   Re-runs corrected randomized simulation against an already sealed campaign without modifying the original sealed Phase-0 outputs. It produces supplemental evidence while explicitly verifying that the existing Phase-1 handoff remains unchanged.

4. [**Lite Phase 0 Simulation Testing v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/lite-phase0-simulation-testing-v1.yml) — `lite-phase0-simulation-testing-v1.yml`  
   Manual smoke test of the production Phase-0 Medusa stage: deploys the campaign on the Anvil fork and runs Medusa with a small call budget (default 1,000), skipping telemetry and publishing nothing. Use it to prove Medusa fixes before a full Phase-0 run.


---

## 3. Browser automation, reviewer wake & watchdog system — 7 workflows

1. [**Browser Active Screenshare v2**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/browser-active-screenshare-v2.yml) — `browser-active-screenshare-v2.yml`  
   Creates an interactive visible Chrome session with desktop/noVNC access, Tailscale connectivity, and the home-exit route. Its purpose is to let a human actually see and interact with the browser session rather than merely running headless automation.

2. [**Original Phase0 Home-Exit Browser v10**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/browser-agent-home-exit-v10.yml) — `browser-agent-home-exit-v10.yml`  
   Runs the proven visible Playwright browser path through the configured home-exit node. It handles authenticated Chrome interaction and records evidence for Project creation and wake-message delivery.

3. [**Browser Agent Reviewer Repair v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/browser-agent-reviewer-repair-v1.yml) — `browser-agent-reviewer-repair-v1.yml`  
   Repairs a reviewer whose current browser/chat assignment became broken. It retires obsolete watchdog states, restores the assigned reviewer/chat binding, and resumes that exact reviewer from the current audit receipt.

4. [**Browser Agent Wake**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/browser-agent-wake.yml) — `browser-agent-wake.yml`  
   Primary reviewer wake workflow. It resolves an idempotent reviewer wake, launches the visible home-exit Chrome path, delivers the wake message through the normal browser UI, persists reviewer/watchdog state, activates prepared successors when applicable, and records wake evidence.

5. [**Browser Agent Watchdog**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/browser-agent-watchdog.yml) — `browser-agent-watchdog.yml`  
   Scheduled/manual supervisory loop for active reviewer chats. It discovers active watchdog targets, opens the appropriate browser session through the home-exit path, and performs one supervisory sweep of each qualifying active agent.

6. [**Browser Session Bootstrap Recovery v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/browser-session-bootstrap-recovery-v1.yml) — `browser-session-bootstrap-recovery-v1.yml`  
   Recovery path for failed browser-session bootstrap/wake attempts. It validates the failure, clears only the relevant encrypted session caches, retries the failed wake, observes the watchdog, and can route confirmed temporary-chat failures into reviewer repair.

7. [**One Shot Watchdog Sweep v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/watchdog-sweep-once-v1.yml) — `watchdog-sweep-once-v1.yml`  
   Tiny dispatch wrapper used to request exactly one browser-agent watchdog sweep rather than waiting for the scheduled watchdog cycle.

---

## 4. General development-agent automation — 2 workflows

1. [**Development Agent Task Manager**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/development-agent-task-manager.yml) — `development-agent-task-manager.yml`  
   Starts and supervises browser-driven development agents from declarative task requests. It maintains durable task-manager state, checks machine completion gates, handles repair/continuation, and can finalize a verified implementation into the target repository’s `main`.

2. [**Upgrade Agent Launcher v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/upgrade-agent-launcher-v1.yml) — `upgrade-agent-launcher-v1.yml`  
   Admission/front-end workflow for upgrade-agent jobs. It validates the requested repository and authorities, allocates the task identity, renders the deterministic specification/manager request, and commits the admitted task to `main` for the task manager to execute.

---

## 5. Authority/package management — 2 workflows

1. [**Authority File Import v4**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/agent-zip-import-v1.yml) — `agent-zip-import-v1.yml`  
   Imports verified authority packages into the appropriate repository. It validates the import request and exact source identity, then installs either audit authority into Audit-Controller or development authority into Contract-Automation and records the result.

2. [**Sync Lite Authority ZIP v1**](https://github.com/curveyield3/Contract-Automation/blob/main/.github/workflows/sync-lite-authority-zip-v1.yml) — `sync-lite-authority-zip-v1.yml`  
   Rebuilds the audit-authority ZIP from the current Audit-Controller authority directory in a deterministic form. It only publishes a new synchronized authority package when its contents have actually changed.
