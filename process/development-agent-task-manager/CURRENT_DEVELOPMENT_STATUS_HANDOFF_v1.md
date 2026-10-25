# Current Development Status Handoff v1

Updated: 2026-09-25 UTC

## Authority order

1. Current explicit human instructions.
2. Live GitHub state for implementation/merge/run status.
3. Human-supplied automation-upgrade development packet for design intent.
4. Human-supplied Audit V7 v38.3.4 skill package for methodology/process constraints.

## Governing implementation ethos

- Existing-process-first: reuse an existing workflow/module/process whenever possible; extend/refactor before creating parallel infrastructure.
- GitHub Actions workflows belong in `curveyield3/Contract-Automation` only. `curveyield3/Audit-Controller` must not gain workflows.
- Durable GitHub state is recovery authority; chat memory is not.
- Replacement development agents must resume from exact committed state and must not repeat completed work.
- Liveness failure policy: if the chat is unviewable, replace; otherwise on an unanswered watchdog prompt wait 120 seconds, refresh immediately, retry; after three consecutive unanswered prompts replace. There is no five-minute delay between those three attempts.
- Browser-provider failure alone must not be misclassified as agent death.

## Exact human-supplied authority files

### Audit V7 skill package

Filename: `Audit_V7_independent_Review_skill_v38.3.4_Web_Bootstrap_Optimized(4).zip`

- Size: 627729 bytes
- SHA-256: `aed298c90c3de3bf9e64bf7e49853b7efd994c47ef9e88cc8f35f60977314cd8`

The exact Lite Phase-0 Step-2 source transport authority is inside this ZIP at:

`optional-modes/lite-pathway/phases/phase-0/resources/PHASE0_SOURCE_ZIP_FANOUT_PROTOCOL.md`

Its required transport pattern is connected Google Drive raw upload -> link-readable Drive object -> Contract-Automation import request -> Contract-Automation importer verification/write -> independent GitHub verification.

### Original automation-upgrade handoff packet

Filename: `CurveYield_Audit_Automation_Upgrade_Handoff_v1(1).zip`

- Size: 24042 bytes
- SHA-256: `f2d38c0d23a03322028d79fbc6bbbd0e8cb484f57978d7ebe5bd6183e6111b12`

### Canonical extracted automation-upgrade specification

Filename: `AUDIT_AUTOMATION_UPGRADE_SPECIFICATION_v1.md`

- Size: 11593 bytes
- SHA-256: `b23743f626cc159f869f22bfa4921b50ed103f600c4e7981d94463861dd1b86a`

## Contract-Automation live state

Current `main` at time of this handoff:

`84ace1d0fc1859534217a4d4629d833b680775ad`

Commit message:

`chore(task-manager): start audit automation upgrade v1`

### Development Agent Task Manager

PR #326 — merged

`feat: add resilient development agent task manager v1`

Merge commit:

`2badca4b2bb7af9eb40ad3083875324450d21b8a`

Qualification run:

`36109580361` — PASS

Core behavior now on main:

- specification-driven fresh ChatGPT development-agent creation;
- durable manager state under `process/development-agent-task-manager/`;
- scheduled approximately-five-minute supervisory sweep;
- existing browser wake/runtime reuse;
- three-prompt / 120-second liveness policy;
- refresh before attempts 2 and 3;
- unviewable-chat failure signal;
- durable branch checkpoint before replacement-agent creation;
- machine completion receipt;
- exact specification/skill digest binding;
- Audit-Controller workflow prohibition.

PR #327 — merged

`fix: harden development task-manager branch recovery`

Merge commit:

`633a3110c47d14253badc9a2a1ecc069d8abf0f3`

Qualification run:

`36109810429` — PASS

Important repair: durable branches containing `/`, including `upgrade/lite-evidence-ingestion-v1`, are supported by ref-safe branch lookup.

PR #328 — merged

`feat: add declarative intake for development task manager`

Merge commit:

`eb17106e825fbed9c57a9d1626cba4a758ad2804`

Qualification run:

`36110060329` — PASS

Purpose: allow a request JSON committed on `main` to start the same task-manager workflow without requiring a manual `workflow_dispatch` UI action.

### First real task-manager request

Request commit:

`84ace1d0fc1859534217a4d4629d833b680775ad`

Manager ID:

`audit-automation-upgrade-v1`

Target durable development branch:

`upgrade/lite-evidence-ingestion-v1`

The first push-triggered task-manager workflow run was:

`36110208849`

Result: FAILURE before agent creation.

Observed defect:

The declarative intake duplicate-active guard treated the GitHub API response for a missing active-state path as truthy instead of requiring a real 40-hex content/blob SHA. It therefore reported the manager as already active even though no active state file existed.

Required repair:

- require a valid 40-hex SHA before treating an active manager record as existing;
- rerun the request intake path;
- verify fresh agent URL and durable active manager state.

The run environment also showed no browser-provider secret values in the job log environment summary. Before declaring the first live worker armed, verify the existing browser-agent wake/watchdog credential path and reuse/repair that admitted path rather than creating a parallel browser integration.

## Active audit-automation upgrade implementation lane

Contract-Automation PR #325 remains open:

`feat(lite): auto-ingest terminal execution evidence`

Branch:

`upgrade/lite-evidence-ingestion-v1`

Head:

`a3a82bd97ddc6dbd124ed56f21a8ba31ff84c7a4`

This remains the Stage C.7 forward-development lane.

Do not restart C.1-C.6.

Do not create another evidence ingestor, observer, watcher, queue, bridge, or execution engine unless the admitted path is first proven unable to satisfy the requirement.

C.7 must not be called complete until its required qualification is PASS and the merge is verified.

## Audit-Controller live state

Current `main` at time of this handoff:

`613b1b1fc012e57e5c76c0728d08790448af7edb`

No task-manager or upload workflow is permitted in Audit-Controller.

## Exact next work

1. Follow Lite Phase-0 Step-2 transport semantics to preserve the exact skill ZIP and development authority package through Google Drive and the existing Contract-Automation importer path.
2. Extend the existing `agent-zip-import-v1` importer with a bounded development-authority import mode if the current admitted schema cannot safely represent the new destinations. Do not create another import workflow.
3. Verify exact Drive file ID, URL, size and SHA-256 for every uploaded raw authority file.
4. Repair the declarative task-manager false duplicate-active check.
5. Verify/repair the existing browser-agent credential path.
6. Re-run the first manager request and prove:
   - a fresh ChatGPT conversation is created;
   - its URL is persisted in active manager state;
   - target branch checkpoint is exact;
   - scheduled supervision can observe that exact worker.
7. Resume C.7 from PR #325 rather than restarting completed work.

