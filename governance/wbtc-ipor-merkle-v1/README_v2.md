# WBTC IPOR Aragon DAO — v2 development source

**Current design**: official deployed Aragon OSx DAOFactory + **one directly deployed custom voting plugin** + **one RISC Zero proof-adapter contract**. No separate Guardian, market-source registry, action policy, plugin setup, governance token, proxy, or helper deployment.

See [CONTRACT_DESIGN_SPEC_v5.md](CONTRACT_DESIGN_SPEC_v5.md) for exact source addresses, deployment/bootstrap order, economics, core rules, known incomplete integrations and security constraints.

The `contracts/src/WbtcIporTokenVoting_v2.sol` contract adapts official Aragon TokenVoting v1.4, with the abstract inherited `contracts/src/base/MajorityVotingBase.sol` narrowly changed to `Plugin` nonupgradeable; `contracts/src/WbtcIporZkProofVerifier_v1.sol` verifies real RISC Zero receipts through the existing mainnet router. Other `src/base` and `src/lib` files are unmodified official Aragon or MIT library dependencies. The `contracts/reference` directory preserves exact upstream examples as **non-deployable references**.

The main-branch GitHub Merkle preparation/fork runner from v1 is an earlier, incomplete scaffold and **does not automatically build or verify this v5 two-contract architecture**. Its prepare job requires integration with the eventual real guest/host. No claim of valid ZK proof generation, code compilation, deployed governance or live fork test is made.

Do not use v1 historical source files or the archive's obsolete example source as deployment authority. Current active Solidity sources are the single voting plugin, the single verifier, and abstract/interface/library dependencies. No mainnet contracts have been deployed by this work.
