# WBTC IPOR Governance Merkle Preparation v1

This folder contains the exact source files from WBTC IPOR Governance Merkle Workflow v1, repackaged losslessly as a .tar.xz archive for compact storage. Extract it to review the original source and documentation.

The dispatchable workflow is installed at [../../../.github/workflows/wbtc-ipor-merkle-proof-v1.yml](../../../.github/workflows/wbtc-ipor-merkle-proof-v1.yml). It extracts this archive on each dispatch.

**This is an integration scaffold, not a working ZK validity prover.** It lacks the Rust RISC Zero Steel guest/host, deployed governance plugin, ABI integration, deployed verifier and live configuration. Until those are implemented the job fails closed, before any submission bundle is published. No GitHub-hosted key or automatic on-chain transaction is needed.

To integrate after deployment: add `config/protocol.json` in this folder with deployment addresses and approved market identifiers, provision the `GOVERNANCE_ARCHIVE_RPC_URL` secret, integrate the verified guest/host prover into the source package, and update the pinned archive/version. Proving and on-chain acceptance are separate; only a successfully verified on-chain `submitVerifiedSnapshot` transaction activates a proposal.

**Archive integrity**: SHA-256 `b8f398470ad2168ca48e6e8bfcfb78759e89cb5f0d975c062c86e90b8287e82d`; Git blob SHA `d427b0ae8562ec75379d96ced2852d890affe3dd`.


## Ethereum mainnet fork rehearsal (workflow revision v2, added November 2026)

The **existing** GitHub workflow also supports two fork modes, preserving the original proof-preparation job:

- `fork_preflight` launches pinned Ethereum Anvil, confirms its historical block hash against `RPC_ETHEREUM`, checks for real deployed Morpho Blue bytecode, and uploads a provenance report. An infrastructure-only PASS is **not** a governance test.
- `fork_full` starts the same authenticated fork and additionally deploys the **actual** governance contracts, executes source-bound Aragon tests, requires real RISC Zero proof generation and submission, and validates an on-chain snapshot-acceptance receipt. It fails explicitly until those implementation components exist.

Use the existing workflow's **Run workflow** control with `mode=fork_preflight` or `mode=fork_full`. A blank `fork_block` pins 80 blocks behind current Ethereum head; an explicit block must be at least 64 blocks behind head. The existing `RPC_ETHEREUM` secret is required; no signing key is needed.

No transactions are broadcast to the upstream RPC. The workflow binds all deployment and test writes to `http://127.0.0.1:8545`, uses a known Anvil-only development account, and strips the upstream RPC secret from source-bound testing. The localhost fork is destroyed when the job finishes.

Before `fork_full` can pass, supply the actual Foundry governance project at `governance/wbtc-ipor-merkle-v1/contracts`, with `foundry.toml`, `script/ForkDeploy.s.sol`, `test/fork/WbtcIporGovernanceFork.t.sol`, and executable `scripts/ForkProveAndSubmit.sh`. This final runner must perform real receipt generation and local on-chain submission, and write verified transaction identity to `../fork-output/fork-report.json`. The governance plugin must expose `isVerifiedSnapshot(uint256)(bool)` for independent local verification.

Mandatory scenario coverage before deployment: combined self-delegation and activation; ineligible share exclusion from quorum; Morpho/Curve deposit attribution without double counting; exactly 15% Safe voting weight; 10% proposer power; 0.001-share bond; 14-day duration, 25% quorum and 67% approval; 3-month/two-missed-proposals inactivity; spam classification; atomic snapshot scalability; valid and manipulated proof rejection; correct Aragon permissions, actual vault calls and forbidden-call rejection. Include `evm_warp` / Foundry time travel and real gas measurements where applicable.

**Current verified limit:** the archive contains only the earlier JavaScript preparation scaffold. The Aragon governance contracts, RISC Zero guest/host prover, official verifier integration and source-bound fork acceptance suite do **not** exist in this package. The fork-full job is necessarily **BLOCKED**, not PASS, until these are implemented. Do not claim the project has passed a live-fork rehearsal from a successful `fork_preflight`.

## Governance contract-development branch — draft v4

Source development is in draft [PR #43](https://github.com/curveyield3/Contract-Automation/pull/43) on `feature/wbtc-ipor-aragon-governance-v1`. The `contracts/src/` folder contains source-derived Aragon OSx voting, Gardens/AragonOne weighted sources, one-way Guardian constitution and an existing calendar-month library. The `contracts/reference/` folder retains exact original upstream source for reconciliation.

The draft standard atomic route now calls the plugin-only census implementation; it is **not deployable** without real OSx plugin setup, authenticated market restrictions and permissions, source compilation, and fork execution. Guardian-removal atomic snapshots and Merkle validity proofs remain explicitly blocked until the full economic-denominator proof is designed and implemented. No mainnet writes, tests or full fork runs have occurred.
