# V7 Phase-1 Canonical Source Intelligence — Technical Output Contract v1

## Purpose

Audit V7 Phase 1 now creates one exact-source/exact-build Canonical Source Intelligence artifact immediately after build admission and attaches neutral Slither/SBOM/static-recon evidence before Phase 1 seals. Later phases reuse that artifact instead of repeatedly rediscovering the same structural code facts.

This document defines what Contract-Automation should expose so an auditor can fill the canonical controller/skill template deterministically and cheaply. It does **not** automate security judgment.

## Critical execution rule

**DO NOT COMPILE OR STAGE THE SAME SOURCE AGAIN MERELY TO BUILD SOURCE INTELLIGENCE.**

Source Intelligence must be generated from the already admitted exact Phase-1 checkout/staged project and the accepted build outputs. If additional compiler output such as AST is required, request it as part of the same admitted build configuration/output selection rather than launching an unrelated second source checkout/build path.

Source/build identity must bind every generated fact.

## Existing reusable foundation

Current Contract-Automation already exposes important pieces that must be reused rather than replaced:

- exact source checkout/archive staging;
- source inventory;
- exact compiler identity/configuration;
- Solidity ABI;
- metadata in standard-json builds;
- storage layout in standard-json builds;
- creation and deployed bytecode;
- Solidity method identifiers in standard-json builds;
- gas estimates;
- Hardhat native build-info identities;
- mixed Solidity/Vyper artifact merging;
- Vyper ABI/creation/runtime bytecode and source digests;
- neutral Slither evidence;
- exact Phase-6 staged-snapshot infrastructure for later execution.

Do not build a parallel compiler system.

## Required Phase-1 structural output families

The technical execution plane should expose deterministic evidence sufficient to populate these canonical artifact sections:

```text
identity
build
sourceFiles
compilerArtifacts
contracts
functions
storageLayout
inheritanceGraph
callGraph
privilegeCandidates
externalInterfaces
valueFlowCandidates
eventsAndErrors
sourceAnchors
staticRecon
limitations
completion
```

### Structural facts vs candidates

Compiler/source syntax facts must remain distinct from heuristic/static candidates.

Allowed confidence classes expected by the skill/controller artifact are:

```text
COMPILER_FACT
SOURCE_SYNTAX_FACT
DETERMINISTIC_STATIC_DERIVATION
NEUTRAL_ANALYZER_CANDIDATE
NOT_APPLICABLE
UNSUPPORTED
```

Do not assign finding severity or vulnerability disposition here.

## Minimum deterministic data contract

### Source files

For every admitted production source file expose:

- canonical relative path;
- language;
- SHA-256;
- source fence/scope identity;
- source-to-compiler-unit mapping.

### Compiler artifacts

For every compiled contract expose, where supported:

- qualified name;
- source path;
- language;
- ABI and digest;
- creation bytecode and digest;
- deployed bytecode and digest;
- storage layout;
- metadata/build-info reference;
- method identifier mapping;
- compiler identity/configuration.

### Contract/function inventory

Derive contract and public/external function records from compiler/source facts. Include:

- stable source-local identity;
- qualified contract name;
- contract kind;
- function signature;
- selector where applicable;
- visibility;
- state mutability/payability;
- source location;
- modifier invocation names where deterministically available.

### Inheritance

Use compiler AST/build-info when available. Record derived/base relationships and linearized base order with source anchors.

### Calls

Record deterministic direct internal-call edges and source-syntax call candidates for external/delegate/static/create/low-level calls. Unresolved dynamic targets remain candidates; do not guess the callee.

### Privilege candidates

Record raw access-control indicators only, such as modifier invocations and deterministic source guard expressions. Security interpretation remains Phase 3/4 work.

### External interfaces

Record source-side interface/dependency touchpoints, signatures/selectors, call kinds, and source anchors where deterministically derivable.

### Value-flow candidates

Record neutral candidate asset/value-moving operations such as token transfer-style calls, native-value sends/calls, mint/burn patterns where deterministically identified, and relevant source anchors. Economic meaning remains Phase 5 work.

### Events/errors

Expose events and custom errors from compiler ABI/AST evidence.

### Source anchors

Convert compiler source locations into stable source-path + line-range anchors tied to source-file digest when possible.

## Solidity AST requirement

The current standard-json output selection should be extended to request source AST as part of the **same admitted compilation**. Native Hardhat builds should reuse existing build-info `output.sources[*].ast` where available rather than compiling a second time.

If AST is unavailable for a supported build mode, emit a typed limitation instead of silently fabricating inheritance/call/source-location facts.

## Mixed Solidity/Vyper requirement

Mixed-language projects remain one accepted build/source fence. Vyper structural fields unsupported by the pinned Vyper toolchain must be explicitly typed `UNSUPPORTED`/limited; do not omit the Vyper source/contracts from the artifact.

## Static reconnaissance attachment

After the Source Intelligence core is generated from source/build facts, Phase 1 neutral Slither/SBOM/static reconnaissance should attach:

- exact tool version;
- terminal status;
- raw evidence reference/digest;
- candidate count/index;
- typed limitations.

Slither observations remain `NEUTRAL_ANALYZER_CANDIDATE`, not findings.

## No later-phase rediscovery

For an unchanged accepted source/build digest, Contract-Automation requests in later phases should be able to reference the accepted Source Intelligence artifact/digest rather than asking agents to rebuild source inventories manually.

Later execution may verify source/build binding and may discover audit-only harness/test functions. It must not require reconstructing production contract/function/storage/inheritance/interface inventories simply to orient the runner.

## Remediation behavior

If Phase 9 changes production source or build identity:

1. preserve old Source Intelligence as historical evidence;
2. compile/admit the exact remediated source under its exact build profile;
3. generate a new Source Intelligence version from the same output contract;
4. compare affected old/new structural sections;
5. bind regression evidence to the new Source Intelligence/source/build identity.

## Proof-of-function requirement

Before the runner advertises automated Source Intelligence generation as supported, qualification must prove at least:

- Solidity standard-json target populates source/contract/function/storage/inheritance/source-anchor data;
- native Hardhat target reuses build-info rather than recompiling independently;
- mixed Solidity/Vyper target preserves both languages and types unsupported fields explicitly;
- exact same source/build inputs produce deterministic structural output/digest;
- source change changes the bound Source Intelligence identity;
- build-profile change invalidates/replaces affected build-derived facts;
- analyzer candidates never become authoritative findings;
- no second source checkout or redundant build is performed solely for Source Intelligence generation.

The universal preflight project should eventually register Source Intelligence generation/validation as an operation with positive and negative proof-of-function.