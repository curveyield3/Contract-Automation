# Phase 6 Harness Skeleton Kit v2

Purpose: repo-native Audit V7 Phase 6 harness templates for `curveyield3/Contract-Automation`, with mandatory use of the existing CurveYield mutable Anvil RPC system.

## Canonical discovery contract

This file is the canonical Phase-6 skeleton entrypoint:

`curveyield3/Contract-Automation/packages/github-native-sim/harness-skeletons-v2/README_v2.md`

Agents working on Phase 6 MUST start here before authoring or repairing Medusa/Foundry harness code. If a caller reaches this repository through a stale/guessed path, search the repository for `harness-skeletons-v2` or one of the exact filenames in the Skeleton map below and return to this README. Do not ask the human where the skeleton code is and do not recreate it from memory while this repository is accessible.

## Non-negotiable mutable-RPC rule

Any Phase 6 operation that consumes fork state or requires mutable-RPC semantics MUST use the existing GitHub Actions dRPC archive secret `RPC_ETHEREUM`, projected only at runtime as `ETHEREUM_FORK_RPC_URL`. Auditors and request authors MUST NOT provide another RPC URL, create a parallel Anvil service, use a public/read-only RPC directly, or serialize the secret into a request, harness manifest, corpus, artifact, log, or report.

The trusted runner performs the binding automatically:

1. Phase 6 preflight resolves `ETHEREUM_FORK_RPC_URL` from `secrets.RPC_ETHEREUM` in the trusted V7 execution workflow. It is the **upstream archival provider** for a locally launched Anvil fork, not an RPC URL the agent provides.
2. It verifies Ethereum chain ID 1 and freezes the requested historical block number and block hash when the request supplies a pin. Required historical state must come from the archive-backed Anvil fork; do not substitute a latest-state local deployment.
3. Medusa is invoked with `--rpc-url <runtime-secret> --rpc-block <frozen-block>`, which forces Medusa fork mode even if a target config attempts otherwise.
4. Foundry is invoked with `--fork-url <runtime-secret> --fork-block-number <frozen-block>` and receives the same URL through runtime environment only.
5. Evidence records the secret profile name, block number/hash, and policy identity, never the URL.

**Provider rate and query limits are not fork-unavailability.** For archived deployment/governance verification, use pinned Anvil local state to execute real ABI actions. If dRPC returns `eth_getLogs` code 35 / >10,000-block range errors, split log reads into at most 9,000-block inclusive chunks, validate full contiguous coverage, deduplicate receipts/log indices and cross-check the reconstructed ward/role roster against frozen-block getters. Do not substitute synthetic state or claim `RPC_ETHEREUM` is absent: DAI r2 historical proof recorded successful archive `eth_call` and `eth_getCode` on this endpoint. Log-query history is distinct from the mutable Anvil fork.

This is the same existing **local ephemeral Anvil** fork setup used by Contract-Automation simulation infrastructure: Anvil fetches historical state through dRPC and allows local state-changing ABI calls with no mainnet writes. Phase 6 does not provision a separate remote mutable RPC system. A missing `ETHEREUM_FORK_RPC_URL` is an execution-workflow secret-routing failure to repair, **not** a conclusion that the `RPC_ETHEREUM` archive source is unavailable.

## Runtime materialization

| Checked-in skeleton | Runtime materialization |
|---|---|
| `medusa/medusa-discovery-template_v2.json` | `medusa.json` for Campaign A-M |
| `medusa/medusa-property-template_v2.json` | `medusa.json` for Campaign B-M |
| `medusa/medusa-targeted-template_v2.json` | `medusa.json` for Campaign C-M/D-M |
| `foundry/foundry-template_v2.toml` | `foundry.toml` |
| Solidity `*_v2.sol.template` files | auditor-chosen `test/phase6/*.sol` / `*.t.sol` paths |

The Medusa templates deliberately contain the unusable marker `PHASE6_RUNTIME_INJECTION_REQUIRED`. Direct/manual Medusa execution without the trusted runner therefore fails closed. The runner CLI override supplies the real mutable Anvil RPC and frozen block.

The Foundry template deliberately contains no RPC endpoint. Do not add one. The trusted runner supplies the fork URL/block at invocation time.

## Source and harness boundary

- Frozen production source remains unchanged.
- Audit-only harnesses/configs/models are separately hashed and source-bound.
- Never edit production contracts merely to make a harness compile.
- Never place the mutable RPC URL in a Solidity test, JSON/TOML template, request, manifest, or evidence artifact.
- Requester-controlled `rpc`, `rpcUrl`, and equivalent dynamic execution fields remain forbidden by the V2 request schema.

## Skeleton map

- `medusa/medusa-discovery-template_v2.json` — broad coverage/corpus discovery with mandatory fork mode and no selector narrowing.
- `medusa/medusa-property-template_v2.json` — invariant/property/state-machine campaign on the same frozen mutable fork.
- `medusa/medusa-targeted-template_v2.json` — hypothesis-specific selectors/actors/corpus refinement on the same frozen mutable fork.
- `medusa/Phase6MedusaHarness_v2.sol.template` — property harness skeleton.
- `foundry/foundry-template_v2.toml` — fuzz/invariant profile; RPC is runner-injected only.
- `foundry/Phase6InvariantTargeting_v2.sol.template` — target/selector/sender plumbing.
- `foundry/Phase6StatefulHandler_v2.sol.template` — stateful multi-actor handler.
- `foundry/Phase6InvariantSuite_v2.t.sol.template` — invariant suite and ghost-state checks.
- `foundry/Phase6BoundaryFuzz_v2.t.sol.template` — boundary/dictionary-directed fuzzing.
- `foundry/Phase6DifferentialFuzz_v2.t.sol.template` — same-input differential fuzzing.
- `models/Phase6GhostModel_v2.sol.template` — independent expected-state model.
- `phase6-harness-manifest-template_v2.json` — source/fork/evidence binding without secret material.

## Auditor success

A correct Phase 6 campaign proves that Medusa and Foundry used the same preflight-frozen mutable fork identity, preserves the strict Medusa-before-Foundry order, executes the v12+ layered campaign tree, records multidimensional coverage and refinement evidence, and never exposes or substitutes the mutable RPC.

## Auditor failure

Treat any of the following as an execution/policy failure, not a harmless implementation choice:

- Medusa fork mode disabled;
- Medusa or Foundry run without the existing mutable RPC binding;
- a different/public/requester-supplied RPC is used;
- a new local/remote Anvil fork path is invented instead of the existing system;
- the RPC URL appears in evidence or committed artifacts;
- Medusa and Foundry start from different fork blocks without an explicitly approved rerun reason;
- production source is modified to embed harness/RPC behavior.
