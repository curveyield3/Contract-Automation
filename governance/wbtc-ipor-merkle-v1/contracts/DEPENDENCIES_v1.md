# WBTC IPOR Aragon governance build dependencies — v1

This source is adapted from `aragon/token-voting-plugin` commit `e726c28061486114d601c547e4da1180ed5ab6da`. Use the *same exact dependencies* as that known original Aragon source, never floating main/latest.

| Dependency | Pinned commit | Upstream |
|---|---|---|
| `lib/osx` | `fc7403fcef660aa952c7e635e95257ee7f466efb` | `https://github.com/aragon/osx` |
| `lib/osx-commons` | `869045b069679fad94d640a8a3e1a1b5538cf0f0` | `https://github.com/aragon/osx-commons` |
| `lib/openzeppelin-contracts` | `dc44c9f1a4c3b10af99492eed84f83ed244203f6` | `https://github.com/OpenZeppelin/openzeppelin-contracts` |
| `lib/openzeppelin-contracts-upgradeable` | `2d081f24cac1a867f6f73d512f2022e1fa987854` | `https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable` |
| `lib/forge-std` | `77041d2ce690e692d6e03cc812b57d1ddaa4d505` | `https://github.com/foundry-rs/forge-std` |
| `lib/ens-contracts` | `f5f2ededccbb7e52be44925c0050620d71762e32` | `https://github.com/ensdomains/ens-contracts` |

The original Aragon repository also imports `ensdomains/buffer`; its exact commit is not recorded in the Git tree root and must be resolved through the pinned osx submodule before compiling. **No dependencies are installed or compiled in this draft yet.**

`foundry.toml` and `remappings.txt` adapt the original project layout, not a new testing framework. Do not create or execute new tests without authorization; the existing main-branch authenticated fork workflow is the deployment rehearsal lane when source integration is ready.

The IPOR vault-side `PlasmaVaultVotesPlugin` remains an existing BUSL-licensed dependency (not copied or modified); its exact deployed-version commitment must be matched at integration.
