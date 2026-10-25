# Source Map and Reference Files v1

## Live methodology authority

Repository: \`curveyield3/Audit-Controller\`

Stable folder:

\`Audit Skill - Current Authority/\`

Snapshot at handoff creation:

\`Audit Skill - Current Authority/Audit_Litemode_v10.3/\`

Read first:

- \`SKILL.md\`
- \`phases/phase-0/PHASE_CONTRACT.json\`
- \`phases/phase-0/START_HERE.md\`
- \`phases/phase-5/PHASE_CONTRACT.json\`
- \`phases/phase-6/PHASE_CONTRACT.json\`
- \`shared/controller/LITE_PHASE_SCHEMA_POLICY.md\`
- \`shared/controller/LITE_PHASE_RECEIPT_PROTOCOL.md\`
- \`shared/controller/AUTOMATIC_PHASE_ADVANCEMENT_PROTOCOL.md\`
- \`shared/controller/DOMAIN_APPLICABILITY_MATRIX.json\`
- \`shared/source-intelligence/SOURCE_INTELLIGENCE_TEMPLATE.json\`
- \`shared/source-intelligence/SOURCE_INTELLIGENCE_BUNDLE_TEMPLATE.json\`
- \`shared/source-intelligence/SOURCE_INTELLIGENCE_REUSE_PROTOCOL.md\`
- \`shared/execution/TECHNICAL_EXECUTION_REQUEST_PLAYBOOK.md\`
- \`shared/execution/GITHUB_ACTIONS_VIA_GITHUB_APP.md\`

## Contract-Automation Phase-0 path

Repository: \`curveyield3/Contract-Automation\`

Primary files to inspect:

- \`.github/workflows/lite-phase0-bootstrap-v1.yml\`
- \`.github/workflows/lite-phase0-intelligence-v1.yml\`
- \`scripts/lite-phase0-finalize-v1.mjs\`
- \`packages/github-native-sim/src/lite-phase0-skill-outputs-v1.mjs\`
- \`packages/github-native-sim/src/lite-boundary-artifacts-v1.mjs\`

## Execution infrastructure

Inspect/reuse rather than replace:

- \`packages/github-native-sim/src/schema.mjs\`
- \`packages/github-native-sim/src/schema-v26.mjs\`
- \`packages/github-native-sim/src/v26-request-config-v1.mjs\`
- \`packages/github-native-sim/src/run-job-file.mjs\`
- \`packages/github-native-sim/src/run-job-file-v2.mjs\`
- \`packages/github-native-sim/src/native-fuzz.mjs\`
- existing Foundry/Medusa/Anvil helpers in \`packages/github-native-sim/src/\`
- existing evidence observer/ingestion modules

## Controller/interface files

- \`scripts/lib/lite-phase-work-v1.mjs\`
- \`scripts/lib/lite-phase-prefill-v1.mjs\`
- \`scripts/lite-phase-packet-controller-v1.mjs\`
- \`scripts/prepare-lite-assignment-successor-v2.mjs\`
- \`scripts/validate-lite-authority-v1.py\`

## Regression tests to extend

- \`packages/github-native-sim/test/lite-semantic-prefill-v1.test.mjs\`
- \`packages/github-native-sim/test/lite-phase-packet-controller-integration-v1.test.mjs\`
- \`packages/github-native-sim/test/lite-boundary-artifacts-v1.test.mjs\`
- \`packages/github-native-sim/test/lite-phase-schema-policy-v1.test.mjs\`
- \`packages/github-native-sim/test/lite-single-receipt-v1.test.mjs\`
- successor-assignment tests
- runner/Medusa/Foundry tests
- Phase-0 workflow qualification tests

## Qualification workflows

- V7 Execution Infrastructure Qualification
- Lite Structured Phase Regression v2
- Sync Lite Authority ZIP v1
- paired cross-repo authority validation path used by Contract-Automation PR qualification

## Production SHAs at handoff creation

- Audit-Controller main: \`27d23ee9995600f068832a4511d7e9c4a543632e\`
- Contract-Automation main: \`85c47a8b2dbdcdc6e8a1ba2ef744996f0889ea5c\`

If main has advanced, inspect the new commits and live authority first. Do not blindly reset to these SHAs.

## Recent repaired PRs

- Audit-Controller PR #100 — reviewer/automation I/O authority synchronization
- Contract-Automation PR #434 — end-to-end I/O consistency enforcement

These PRs are historical context only. Production main and current authority outrank them.
