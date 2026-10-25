# Phase-0 Automated Testing + Cross-Phase I/O Revalidation Handoff v1

## Purpose

This folder is the durable successor-agent handoff for the next curveyield3 audit-automation upgrade.

It has **two coupled objectives**:

1. **Implement the next major Phase-0 machine-testing upgrade**: broad, always coverage-guided testing that executes real contract functions, including function-level fuzzing and stateful transaction-sequence simulation.
2. **Perform another complete agent-vs-automation I/O consistency audit after implementation**, using the same class of checks that produced the v10.3 repairs.

Do not treat this folder as audit methodology authority. The live Lite authority remains the controlling methodology/process source.

## Live authority

Stable authority folder:

\`curveyield3/Audit-Controller/Audit Skill - Current Authority/\`

Authority snapshot at handoff creation:

\`Audit_Litemode_v10.3\`

Mandatory entrypoint:

\`Audit Skill - Current Authority/Audit_Litemode_v10.3/SKILL.md\`

Runtime references should prefer the stable authority folder where supported so future package-version bumps do not require widespread repointing.

## Production repository state at handoff creation

- Audit-Controller main: \`27d23ee9995600f068832a4511d7e9c4a543632e\`
  - message: \`chore(authority): sync current Lite authority package and zip\`
- Contract-Automation main: \`85c47a8b2dbdcdc6e8a1ba2ef744996f0889ea5c\`
  - message: \`chore(v7): refresh canonical qualification status\`
- Audit-Controller PR #100: merged
- Contract-Automation PR #434: merged
- V7 Execution Infrastructure Qualification run \`36605563062\`: PASS
- Lite Structured Phase Regression v2 run \`36605563140\`: PASS
- authority ZIP sync run \`36608247000\`: PASS

## Read order

1. \`README_v1.md\`
2. \`CURRENT_LIVE_STATE_v1.md\`
3. \`PHASE0_AUTOMATED_TESTING_SYSTEM_SPEC_v1.md\`
4. \`PHASE0_EXECUTION_DATA_CONTRACTS_v1.md\`
5. \`PHASE0_AUTOMATED_TESTING_IMPLEMENTATION_PLAN_v1.md\`
6. \`CROSS_PHASE_AGENT_AUTOMATION_IO_AUDIT_PLAYBOOK_v1.md\`
7. \`CROSS_PHASE_IO_CHECK_MATRIX_v1.md\`
8. \`TEST_AND_ACCEPTANCE_PLAN_v1.md\`
9. \`FAILURE_RECOVERY_AND_NONREGRESSION_RULES_v1.md\`
10. \`SOURCE_MAP_AND_REFERENCE_FILES_v1.md\`
11. \`SUCCESSOR_WAKE_MESSAGE_v1.md\`
12. \`HANDOFF_STATE_v1.json\`

## Non-negotiable process constraints

- Use the GitHub connector app for repository work.
- Do not create workflows in Audit-Controller. GitHub Actions remain in Contract-Automation.
- Reuse/extend existing execution infrastructure before creating a parallel runner, evidence ingestor, observer, controller, queue, or campaign engine.
- Phase 0 is automation-only: **no AI is required to operate Phase-0 tests**.
- Phase-0 randomized testing must call **real known contract functions**. Do not count arbitrary random byte payloads as meaningful test coverage.
- Phase 0 must always use coverage feedback. “Where possible” is not sufficient.
- Machine-generated Phase-0 signals are neutral evidence/candidates, never vulnerability findings.
- Phase 5 retains AI-guided targeted test design; machine execution remains at the Phase-5 boundary.
- Phase 9 remediation reruns remain the intentional reviewer-controlled sub-phase exception.
- Agent-executed phases produce semantic data only; controller automation owns deterministic bookkeeping, report/packet creation, structural prefills, machine-result transcription, and other mechanically derivable work.
- Every durable new file delivered to the human or intentionally introduced as a versioned artifact must carry a whole-number version suffix beginning at v1.

## Completion definition

The successor is not done merely when a Phase-0 fuzz command executes.

Completion requires:

- the new Phase-0 machine testing is source/build/campaign bound;
- it uses real function calls and typed arguments;
- stateful simulation uses real function sequences;
- coverage feedback always influences corpus/seed/sequence selection;
- seeds and minimized counterexamples are reproducible;
- all outputs are durable and schema-governed;
- later phases receive only the information they actually need;
- no Phase-0 machine signal is silently promoted to a finding;
- authority, templates, automation, validators, controller routing, derived outputs, receipts, and final evidence views agree;
- paired repository qualification is green;
- a second complete I/O consistency audit reports no unresolved interface mismatch.

Start from current production state. Do not restart already-completed v10.3 repairs.
