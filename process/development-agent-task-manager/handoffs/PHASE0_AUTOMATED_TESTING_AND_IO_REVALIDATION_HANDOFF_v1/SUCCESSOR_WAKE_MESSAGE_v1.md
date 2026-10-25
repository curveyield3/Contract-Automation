# Successor Wake Message v1

Continue upgrading the curveyield3 Lite audit automation.

Use the GitHub connector app only for repository work.

The live methodology/process authority is the current package under:

\`curveyield3/Audit-Controller/Audit Skill - Current Authority/\`

At handoff creation it is \`Audit_Litemode_v10.3\`. Read its root \`SKILL.md\` first and treat it as the ultimate audit-process authority.

Then read this handoff folder in order:

\`curveyield3/Contract-Automation/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/\`

Start at \`README_v1.md\`.

Your primary implementation task is to add broad Phase-0 automated testing with these hard requirements:

- Phase 0 remains automation-only.
- Execute real known contract functions with ABI-typed arguments.
- Do not treat arbitrary random bytes as meaningful testing.
- Include coverage-guided function fuzzing.
- Include coverage-guided stateful real-function sequence simulation.
- Coverage guidance is mandatory, not optional.
- Preserve deterministic seeds, exact source/build/environment identity, corpus, traces and minimized counterexamples.
- Phase-0 machine outputs are neutral signals only; they cannot become vulnerability findings/severity without later semantic review.
- Reuse existing V7 runner/Foundry/Medusa/Anvil/evidence infrastructure; do not create parallel systems.
- Preserve Phase-5 AI-guided targeted test design and Phase-9 reviewer-controlled remediation reruns.

After implementation, perform the complete cross-phase agent-vs-automation I/O audit described in the handoff folder. Check every phase 0–10, every form/schema/contract, every prefill/validator/canonical/derived path, every fresh-reviewer handoff and the final evidence view. Repair any mismatch you find and add regression tests so it cannot recur.

Do not stop at a design document. Implement, test, repair and verify every presently executable part. Use paired branches/PRs when Audit-Controller and Contract-Automation must change together. Run full paired qualification before merge and verify production main plus authority ZIP synchronization afterward.

Do not restart completed v10.3 work. Recover exact durable state and continue forward.
