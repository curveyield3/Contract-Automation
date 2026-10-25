# Development Agent Task-Lock State v2

MANAGER ID:
curveyield-ephemeral-anvil-simulation

END-STATE INVARIANT:
curveyield3/Contract-Automation runs required Ethereum fork simulations entirely inside ordinary GitHub-hosted Ubuntu Actions jobs. dRPC (`https://eth.drpc.org/`) supplies read-only upstream Ethereum fork state; each workflow launches and uses its own local mutable Anvil instance for deployment, mutation, Medusa, ABI telemetry, randomized testing, targeted testing, and evidence generation. No persistent remote Anvil service, public RPC endpoint, Cloudflare service, Codespace, VM, self-hosted runner, DNS, proxy, or persistent hosting is required.

CURRENT MAIN:
- Contract-Automation main verified at `b04294466dc5e8808a5fd2ac2c087b081b9b432a`.
- Implementation commit: `2059bb81f5793f90af7f7820a8115f2adc6645d2`.
- Qualification commit: `b1f96af78ea323bcbc2032a540b0feb25ec2f681`.
- Final successful combined qualification run: `37502694198`.
- One-off qualification wrapper cleanup commit: `b04294466dc5e8808a5fd2ac2c087b081b9b432a`.

AUTHORITY:
- Human requirement: use the simplest mechanism necessary to run forked-chain simulations only while Contract-Automation simulation workflows execute.
- Human clarification: no persistent always-on RPC server is required.
- Human clarification: no Cloudflare service is required.
- Human clarification: dRPC supplies the Ethereum state source.
- Existing Contract-Automation simulation acceptance gates remain unchanged and authoritative.
- `Contract-Automation/AGENTS.md`.
- `FOCUS/TASK LOCKS/TASK_LOCK_PROTOCOL_v1.md`.

SATISFIED:
- `.github/workflows/lite-phase0-randomized-simulation-v1.yml` uses `https://eth.drpc.org/` as the upstream Ethereum fork source and launches the existing local Anvil simulation path through `--fork-url`.
- `.github/workflows/lite-phase0-simulation-testing-v1.yml` uses the same dRPC upstream and local Anvil path.
- `.github/workflows/lite-phase0-simulation-rebind-v1.yml` uses the same dRPC upstream and local Anvil path.
- All three workflows preflight dRPC for Ethereum chain ID 1 and historical WETH code at block 18,000,000 before spending simulation budget.
- The runner's existing `--fork-url` interface remains intact; dRPC was not hardwired into the simulation engine.
- GitHub-hosted `ubuntu-latest` supplies all Linux compute required for the local mutable Anvil instance.
- Mutable simulation operations remain local to Anvil; dRPC is used only as upstream fork-state RPC.
- Current live Phase-0/Anvil workflow inventory was checked and none of the simulation-related workflows still reference `SIM_ARCHIVE_PRIMARY_ETHEREUM_01`.
- Combined qualification run `37502694198` passed the existing 1,000-call Phase-0 smoke workflow using dRPC/local Anvil. The smoke produced deployment PASS and Medusa `COMPLETE_WITH_ORACLE_GAPS` with 66,028 observed calls, exceeding its requested 1,000-call minimum.
- The same run then passed the full existing Phase-0 randomized workflow, including deployment simulation, Medusa, ABI telemetry, complete-evidence enforcement, later-phase projection, and evidence publication.
- The full workflow retained its existing requirements, including the >100K Medusa requirement, four 1,200-call telemetry shards with zero errors, variety checks, deployment coverage checks, and canonical Ethereum Anvil execution normalization.
- Evidence and workflow summaries continue to identify the state engine as an Anvil Ethereum fork rather than dRPC as the mutable execution engine.
- The temporary one-off qualification wrapper was removed after the green qualification run; the permanent production/smoke workflows remain.
- Obsolete wording describing the smoke path as a remote/real Anvil deployment was corrected to describe the local ephemeral Anvil fork.
- No Cloudflare, public RPC server, Codespace, external VM, DNS, Caddy, persistent host, or self-hosted runner is part of the active architecture.

REMAINING DELTA:
- None

PARKED OBSERVATIONS:
- `curveyield3/anvil-node` commit `79ee877cbeee3a783e1e065dc4f1cea3c7524379` remains intact but is superseded and not required by this architecture.
- This task lock was created directly from explicit human instruction rather than through an active Development Agent Task Manager request/state record, so there is no matching manager instance to retire with a machine completion receipt.
- Future replacement of dRPC, if ever required, can use the preserved workflow-level `--fork-url` interface without redesigning the local Anvil simulation engine.

ACTIVE BLOCKER:
None

NEXT ACTION:
None — end-state verified and task complete.
