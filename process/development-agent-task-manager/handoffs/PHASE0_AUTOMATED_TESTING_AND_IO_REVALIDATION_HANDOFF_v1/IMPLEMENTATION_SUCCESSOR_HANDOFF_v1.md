# Phase-0 Automated Testing v2 — Implementation Successor Handoff v1

Status: active implementation/qualification handoff. This file is durable recovery state for the Phase-0 Medusa + ABI telemetry v2 implementation task.

## 1. Primary task

Implement and qualify the reviewed Phase-0 automated Medusa and ABI telemetry v2 specification in `curveyield3/Contract-Automation`.

Do not stop at code review or unit tests. Completion requires the bounded acceptance package requested by the user:
- reviewable implementation PR(s);
- A01–A34 results tied to exact commits and GitHub runs;
- meaningful target-property execution with non-vacuity evidence;
- successful supported lifecycle transitions;
- held-out/generalization packets;
- unchanged CurveYield DEX v16 r3 regression in isolation;
- performance/resource measurements;
- precise implemented / verified / unsupported / incomplete distinction.

All compile/install/run activity must remain in GitHub. Use the existing qualification/Anvil infrastructure. One mutable execution lane at a time.

## 2. Current implementation state

Repository: https://github.com/curveyield3/Contract-Automation

Implementation branch:
`impl/phase0-medusa-telemetry-v2`

Draft implementation PR:
https://github.com/curveyield3/Contract-Automation/pull/544

Current branch/PR head when this handoff was written:
`82b31fac3a9094e66259d9d846e8ce03b4219da9`

PR state:
- draft;
- unmerged;
- mergeable;
- 77 commits;
- 22 changed files at the most recent inspection.

Do not merge this PR without separate user authorization.

## 3. Governing reviewed specifications

Read these in order before changing implementation behavior:

1. README/scope:
https://github.com/curveyield3/Contract-Automation/blob/94207081af8c4a292750a0bfdc20176b5ead6ad7/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/README_v2.md

2. Live-state diagnosis:
https://github.com/curveyield3/Contract-Automation/blob/94207081af8c4a292750a0bfdc20176b5ead6ad7/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/CURRENT_LIVE_STATE_v2.md

3. System specification:
https://github.com/curveyield3/Contract-Automation/blob/94207081af8c4a292750a0bfdc20176b5ead6ad7/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/PHASE0_AUTOMATED_TESTING_SYSTEM_SPEC_v2.md

4. Data contracts:
https://github.com/curveyield3/Contract-Automation/blob/94207081af8c4a292750a0bfdc20176b5ead6ad7/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/PHASE0_EXECUTION_DATA_CONTRACTS_v2.md

5. Test/acceptance plan:
https://github.com/curveyield3/Contract-Automation/blob/94207081af8c4a292750a0bfdc20176b5ead6ad7/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/TEST_AND_ACCEPTANCE_PLAN_v2.md

6. Implementation plan:
https://github.com/curveyield3/Contract-Automation/blob/94207081af8c4a292750a0bfdc20176b5ead6ad7/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/PHASE0_AUTOMATED_TESTING_IMPLEMENTATION_PLAN_v2.md

7. Source map:
https://github.com/curveyield3/Contract-Automation/blob/94207081af8c4a292750a0bfdc20176b5ead6ad7/process/development-agent-task-manager/handoffs/PHASE0_AUTOMATED_TESTING_AND_IO_REVALIDATION_HANDOFF_v1/SOURCE_MAP_AND_REFERENCE_FILES_v2.md

Current Audit Skill authority:
https://github.com/curveyield3/Audit-Controller/tree/main/Audit%20Skill%20-%20Current%20Authority

Specification snapshot authority:
https://github.com/curveyield3/Audit-Controller/blob/78943917711d0c56ebedd2ddc4ec267d1b1efc89/Audit%20Skill%20-%20Current%20Authority/Audit_Litemode_v10.3/SKILL.md

Diagnostic campaign review context:
https://github.com/curveyield3/Audit-Controller/pull/113

## 4. Core implementation already completed

The main repaired engine remains:
`packages/github-native-sim/src/phase0-randomized-simulation-v1.mjs`

New/shared v2 helpers:
- `packages/github-native-sim/src/phase0-execution-contract-v2.mjs`
- `packages/github-native-sim/src/phase0-execution-input-v2.mjs`

Important completed behavior:

### Shared inputs / exact binding
- Phase-0 intelligence exports the accepted compiler artifacts once.
- Randomized simulation consumes exported build artifacts instead of performing a second default build.
- Build/SI/Slither/readiness/receipt data are joined into one execution input view.
- Source/digest/compiler inventory drift fails closed.
- Campaign generation identity is retained.
- Standard-json / hermetic / embedded-profile / Hardhat compiler-unit input and output identities are retained where available.
- Null compiler-unit identity cannot be promoted to exactness.
- Build/profile/generation/ABI mismatch cases have explicit negative tests.

### ABI typing / semantics
- Recursive ABI generation supports nested tuples, tuple arrays, signed boundaries, bytesN, and fixed arrays >4.
- Resource-limit overflow is a typed gap.
- Economic classification is recipe-qualified rather than derived from names.
- Standard-looking lookalike ABIs without qualifying semantic evidence become oracle gaps.
- ERC20, ERC4626 and ERC3156 callback-flow recipes are represented.
- Unknown custom semantics remain explicit gaps.

### ABI telemetry
- Per-attempt stages:
  `ARG_GEN -> PREFLIGHT -> SUBMISSION -> RECEIPT -> OBSERVATION`.
- Terminal outcomes distinguish:
  - encoding/planning failure;
  - simulated protocol rejection;
  - simulation infrastructure error;
  - submission infrastructure error;
  - submitted outcome unknown;
  - mined success;
  - mined revert.
- Pre/post observations retain failures rather than silently zeroing them.
- Sender native delta is fee-adjusted using actual receipt fee.
- Related ERC20 asset/token balances, allowances and supply are observed for qualified vault/flash contexts.
- Positive state transitions and positive economic transitions are separate.
- Raw transcript SHA/reference and action/outcome sequence digests are retained.
- Raw rows are fully reconciled against aggregate counters/maps.
- Duplicate/missing call indexes fail validation.
- Transition observations change later action weights; feedback evidence is retained.
- Repeated wrong-context failures trigger bounded adaptation/gap behavior.
- Per-lifecycle positive / expected-negative reachability is retained.
- Low-level false-return / revert / panic data are retained.
- Empty/no-op behavior is not misclassified as economic movement.

### State lifecycle
- `evm_revert` success is verified.
- Baseline sentinel digest is recomputed after reset.
- Expired/failed revert blocks reuse.
- Sentinel mismatch blocks reuse.
- Live deterministic replay compares serialized action and declared-outcome sequence digests.

### Medusa
- Typed wrappers preserve tuple structure instead of collapsing to raw bytes.
- Caller semantics are preserved with the supported Medusa prank cheatcode.
- Packet-declared `property_*() -> bool` functions become target-behavior checks.
- Harness self-check controls are separately labeled and cannot satisfy target assurance.
- Checked mode enables real property/assertion checking.
- Checked mode fails closed on zero tests.
- Target properties require precondition/transition witness plus engine execution evidence.
- `UNEXERCISED` and `OBSERVATION_GAP` are separate from checked/no-deviation.
- Achieved weighting is measured from retained dispatch evidence rather than wrapper-count ratio alone.
- Property deviations are neutral execution evidence, not vulnerability severity.

### Consumers / finalizer / legacy
- New execution/check/reachability/observation fields are projected downstream.
- Finalizer validates v2 capability contract, raw transcript identity, counters, reset evidence, target property evidence, and explicit oracle gaps.
- Legacy quantity-only PASS is preserved as `LEGACY_LIMITED`; it cannot satisfy v2 gates.
- No Phase-0 helper assigns vulnerability severity/security verdicts.

### Deployment/script execution
- Per-script dispositions are retained.
- Original/adapted script digests and command evidence are retained.
- Filesystem confinement is qualified.
- Generic script dispositions cannot be hidden by success from another script.
- Remaining network-confinement capability must not be overstated if the admitted Node/runtime sandbox cannot prove it.

## 5. Live qualification already proven

Existing qualification workflow:
`.github/workflows/v7-execution-infrastructure-qualification.yml`

Latest inspected run:
https://github.com/curveyield3/Contract-Automation/actions/runs/37223524257
Run number: 1167
Head:
`82b31fac3a9094e66259d9d846e8ce03b4219da9`

The Phase-0 v2 live behavioral/performance step PASSED.

Exact retained live totals from run 1167:
- Medusa observed calls: **136,925**
- Main ABI telemetry attempts: **4,800**
- Positive observed transitions: **3,791**
- Positive qualified economic transitions: **3,588**
- Deterministic replay:
  - `a11-replay-001`: 96 calls, 77 mined successes, 19 simulated rejections, 77 positive transitions
  - `a11-replay-002`: same declared results; replay digest checks passed.

The overall workflow conclusion is FAILURE because the later broad package test stage still contains unrelated browser/task-manager regressions. The Phase-0 v2 live step itself is green.

Do not treat unrelated browser/runtime failures as Phase-0 v2 failures. Do not repair unrelated browser/watchdog code as part of this task.

## 6. Recent important commits

Recent branch commits at handoff creation include:

- `34d424659330bfe96c3cb8b42817a81820c9af34` — measure Medusa achieved weight from retained dispatches
- `8e323d6b919ab313ebe2ed288ef2ebd497610c3b` — per-lifecycle positive and expected-negative reachability
- `52b8303f7c5f1a2baa34cdfa7a6b0a7a5ebfc208` — deployment script digests/dispositions/fs sandbox
- `cf6234466ea91790b45a41cfe0171a0cb9a9e308` — deployment qualification cases
- `5599cec0f8e0e5a3bba0022d55d858df02b702f0` — recipe observations and burn semantics
- `f7475891329dcf7cb4edf10c5e5a7153f45bad49` — distinguish observation gaps from unexercised properties
- `d9527ca9b142a254b2e9588d38d7ac993f0561a6` — prove UNEXERCISED and OBSERVATION_GAP
- `9dc39b96526e6c0110fd1313fa2f6af16b43bfb4` — retain low-level returns/reverts/panics
- `0e945e6a7352c13d134f1d4a492a9da9cb7d569e` — false/revert/panic/no-op live controls
- `ad87a265c50de82fe09e8335d70e56a1107dc1ea` — retain generation identity in simulation request binding
- `82b31fac3a9094e66259d9d846e8ce03b4219da9` — project reset/reachability/feedback/dispatch evidence downstream

Earlier exact-binding/reset/reconciliation commits also exist in PR #544 and should be preserved.

## 7. Current exact stopping point

Implementation hardening and the main live fixture are substantially complete.

The current work phase is **final qualification packaging**, in this order:

1. Held-out / generalization packet.
2. Deployment-gap packet.
3. Unchanged CurveYield DEX v16 r3 regression, in isolation, without changing campaign state.
4. Final performance/resource comparison.
5. A01–A34 evidence matrix tied to exact commits/runs/artifacts.
6. Precise remaining-gap ledger.
7. PR #544 review summary.

At the moment this handoff was written, no new held-out fixture commit had yet been made after head `82b31...`.

## 8. Held-out/generalization requirements still to execute

Acceptance plan requires a **renamed/reordered held-out packet**:
- naming/layout must differ from the development fixture;
- target addresses/IDs must be created only at runtime;
- use the same generator, recipe registry and engine unchanged;
- no special cases keyed to CurveYield, campaign name, fixture owner or fixed addresses;
- supported behavior must work without interactive prompts;
- unknown semantic variants must return typed gaps rather than invented invariants.

Preferred implementation approach:
- add a second qualification-only Solidity/source packet under the existing test fixture tree;
- rename/reorder contracts and file layout;
- exercise it through the existing live qualification helper / production seams;
- do not add packet-specific branches to production engine code.

The unknown custom contract / standard-looking ABI case already exists in the main qualification family, but the held-out packet must independently prove generalization.

## 9. Deployment-gap packet still to execute

Acceptance plan requires a packet with:
- missing normalized-chain dependencies;
- multiple script variants;
- pending handoff actions.

Expected result:
- safe automated execution;
- per-script dispositions;
- one script's success never hides another script's unsupported/blocked disposition;
- adapted copies retain their own digests and normalization evidence;
- no unsupported behavior is promoted to production handoff readiness.

Use the existing deployment detection/execution functions; do not create another deployment runner.

## 10. Unchanged CurveYield DEX v16 r3 regression still to execute

Important boundary:
- retained DEX r3 campaign is regression input only;
- do not edit/reseal campaign data;
- do not advance the campaign;
- do not wake Phase 2 or any successor;
- do not mutate sealed receipts/prefills.

Historic retained evidence must stay historic/limited.

Known historic DEX v16 r3 baseline:
- Medusa: **138,521** observed calls;
- ABI telemetry: **4,800** attempts;
- legacy successes: **133**;
- legacy reverts: **4,667**;
- legacy execution errors: **0**;
- no target property assurance;
- several apparent successes were hooks / empty multicalls rather than lifecycle completion.

The upgraded regression must consume existing upstream indexes/facts, not rerun full SI/Slither/function indexing.

Required DEX assertions:
- formerly omitted supported tuple inputs are routable;
- caller/context semantics preserved;
- failed normalized script variants stay explicit;
- positive transitions exist for each lifecycle family that is supported by a pre-existing qualified generic recipe;
- unsupported protocol-specific lifecycle families remain typed reachability/semantic gaps;
- settlement/migration applicability is inferred only from trusted structural evidence and otherwise remains a typed gap.

The DEX packet is a held-out regression/generalization input, not a reason to add protocol-specific production logic. Do not add Balancer-, CurveYield-, campaign-, contract-name-, or fixed-address-specific behavior solely to make this packet pass.

## 11. Performance qualification still to finalize

The main live qualification already records:
- RPC method counts through a counting proxy;
- wall time;
- CPU resource usage;
- memory delta;
- artifact bytes;
- useful transition counts.

Final report still needs:
- at least three short-run seeds;
- baseline vs upgraded comparison on the same fixture/build/fork reconstruction/serialized decision conditions where possible;
- positive-path fixture, not rejection-only;
- full four-shard telemetry;
- >100K Medusa discovery;
- enabled check lane measured separately;
- observation coverage;
- useful transitions/minute;
- wall-clock distribution;
- CPU/memory;
- artifact bytes;
- RPC calls by stage/method;
- explicit disclosure of unpaired conditions;
- no claimed speedup from omitted reads/checks.

Investigate any material regression rather than suppressing it.

## 12. A01–A34 completion matrix still to file

Create a durable versioned qualification report in this same handoff folder or another clearly owned Phase-0 qualification folder.

For every A01–A34 row, record:
- status: VERIFIED / UNSUPPORTED / INCOMPLETE;
- exact implementation commit(s);
- exact GitHub run(s);
- exact retained artifact/file evidence;
- behavioral result;
- limitation if any.

Do not use static/string-search tests as the sole proof where the plan requires behavior.

Key already-covered families include:
- A01–A05 input/build/ABI exactness;
- A06–A08 deployment behavior;
- A09–A10 context/callback/delegate;
- A11 reset/replay;
- A12 semantic lookalikes;
- A13–A21 Medusa properties/anti-vacuity/typing/weighting/raw behavior;
- A22–A30 telemetry semantics/lifecycle/observations/reconciliation;
- A31 legacy limitation;
- A32 downstream projection;
- A34 no severity/security verdict.

A33 must explicitly prove that failed required acceptance retains failed evidence and does not launch a successor.

## 13. Important run discipline

Before every new execution:
1. inspect active/queued runs;
2. keep only one mutable qualification lane;
3. do not create retry workflow siblings;
4. use existing V7 qualification/Anvil paths;
5. retain failed evidence;
6. make a relevant repair before retrying;
7. verify exact run SHA.

Several intermediate runs were cancelled because new commits superseded them. Do not confuse those with functional failures.

## 14. Boundaries that must not be crossed

This task authorizes program implementation and isolated qualification only.

Do **not**:
- merge production PR #544;
- advance any audit campaign;
- wake another audit phase;
- rewrite/reseal existing campaign receipts;
- modify controller-owned prefills;
- adopt PR #113's campaign correction candidate;
- turn historic DEX evidence into v2 PASS;
- fix unrelated browser/watchdog/task-manager code just to make a broad repository suite green;
- claim semantic assurance from call counts alone;
- claim universal network sandboxing unless evidence actually proves it.

## 15. Immediate successor actions

Resume from the final qualification phase, not from implementation discovery.

1. Check branch head/PR #544 and active runs.
2. Re-read this handoff plus TEST_AND_ACCEPTANCE_PLAN_v2.
3. Add and run renamed/reordered held-out qualification packet through the existing engine.
4. Add/run deployment-gap packet through existing deployment execution path.
5. Run unchanged DEX r3 as a held-out generic regression without campaign mutation; supported generic behaviors must work and unsupported protocol-specific semantics must remain explicit gaps.
6. Collect performance metrics.
7. Produce A01–A34 matrix + remaining-gap list.
8. Update PR #544 body/review summary with exact evidence.
9. Leave PR draft/unmerged unless the user separately authorizes merge.

Completion means supported behavior is backed by retained evidence and every remaining unsupported behavior is explicit.
