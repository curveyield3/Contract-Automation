# WBTC IPOR Governance Merkle Preparation v1

This folder contains the exact source files from WBTC IPOR Governance Merkle Workflow v1, repackaged losslessly as a .tar.xz archive for compact storage. Extract it to review the original source and documentation.

The dispatchable workflow is installed at [../../../.github/workflows/wbtc-ipor-merkle-proof-v1.yml](../../../.github/workflows/wbtc-ipor-merkle-proof-v1.yml). It extracts this archive on each dispatch.

**This is an integration scaffold, not a working ZK validity prover.** It lacks the Rust RISC Zero Steel guest/host, deployed governance plugin, ABI integration, deployed verifier and live configuration. Until those are implemented the job fails closed, before any submission bundle is published. No GitHub-hosted key or automatic on-chain transaction is needed.

To integrate after deployment: add `config/protocol.json` in this folder with deployment addresses and approved market identifiers, provision the `GOVERNANCE_ARCHIVE_RPC_URL` secret, integrate the verified guest/host prover into the source package, and update the pinned archive/version. Proving and on-chain acceptance are separate; only a successfully verified on-chain `submitVerifiedSnapshot` transaction activates a proposal.

**Archive integrity**: SHA-256 `b8f398470ad2168ca48e6e8bfcfb78759e89cb5f0d975c062c86e90b8287e82d`; Git blob SHA `d427b0ae8562ec75379d96ced2852d890affe3dd`.
