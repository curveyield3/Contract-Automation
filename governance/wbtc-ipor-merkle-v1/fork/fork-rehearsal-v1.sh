#!/usr/bin/env bash
set -euo pipefail

# Authenticated Ethereum-mainnet fork. All transactions must target the loopback node.
# This is the fork test runner for the existing governance workflow (revision v2).
LOCAL_RPC='http://127.0.0.1:8545'
ROOT="\${GITHUB_WORKSPACE:-$(pwd)}"
OUT="$ROOT/governance/wbtc-ipor-merkle-v1/fork-output"
PROJECT="$ROOT/governance/wbtc-ipor-merkle-v1/contracts"
mkdir -p "$OUT"
ANVIL_PID=''
cleanup() {
  if [[ -n "$ANVIL_PID" ]]; then kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT
fail() { printf 'FORK BLOCKED: %s\n' "$*" >&2; return 1; }

[[ -n "\${UPSTREAM_RPC_URL:-}" ]] || fail 'RPC_ETHEREUM secret is missing'
[[ -z "\${ETH_RPC_URL:-}" || "$ETH_RPC_URL" == "$LOCAL_RPC" ]] || fail 'ETH_RPC_URL must be unset or local only'
UPSTREAM_CHAIN="$(cast chain-id --rpc-url "$UPSTREAM_RPC_URL")"
[[ "$UPSTREAM_CHAIN" == '1' ]] || fail 'upstream is not Ethereum mainnet (chainId 1)'
LATEST="$(cast block-number --rpc-url "$UPSTREAM_RPC_URL")"
[[ "$LATEST" =~ ^[0-9]+$ && "$LATEST" -gt 120 ]] || fail 'unexpected upstream height'
PIN="\${FORK_BLOCK:-}"
if [[ -z "$PIN" ]]; then PIN="$((LATEST - 80))"; fi
[[ "$PIN" =~ ^[0-9]+$ && "$PIN" -gt 0 && "$PIN" -le $((LATEST - 64)) ]] || fail 'fork block must be at least 64 blocks behind head'
UPSTREAM_HASH="$(cast block "$PIN" --field hash --rpc-url "$UPSTREAM_RPC_URL" | tr -d '\r\n')"
[[ "$UPSTREAM_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail 'archive RPC did not provide pinned block hash'

anvil --fork-url "$UPSTREAM_RPC_URL" --fork-block-number "$PIN" --chain-id 1 --host 127.0.0.1 --port 8545 > "$OUT/anvil.log" 2>&1 &
ANVIL_PID="$!"
READY=0
for _ in $(seq 1 75); do
  if cast chain-id --rpc-url "$LOCAL_RPC" >/dev/null 2>&1; then READY=1; break; fi
  if ! kill -0 "$ANVIL_PID" 2>/dev/null; then break; fi
  sleep 2
done
[[ "$READY" == 1 ]] || { tail -70 "$OUT/anvil.log" >&2 || true; fail 'local Anvil did not start'; }
[[ "$(cast chain-id --rpc-url "$LOCAL_RPC")" == '1' ]] || fail 'local chain ID mismatch'
LOCAL_HASH="$(cast block "$PIN" --field hash --rpc-url "$LOCAL_RPC" | tr -d '\r\n')"
[[ "\${LOCAL_HASH,,}" == "\${UPSTREAM_HASH,,}" ]] || fail 'local pinned block hash differs from authenticated upstream'
MORPHO_BLUE='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'
MORPHO_CODE="$(cast code "$MORPHO_BLUE" --rpc-url "$LOCAL_RPC")"
[[ "$MORPHO_CODE" != '0x' && "$MORPHO_CODE" != '0x0' ]] || fail 'real Morpho Blue mainnet contract bytecode is missing'

jq -n --arg status FORK_READY_ONLY --arg block "$PIN" --arg blockHash "$UPSTREAM_HASH" --arg head "$LATEST" --arg gitSha "\${GITHUB_SHA:-unknown}" --arg morphoBlue "$MORPHO_BLUE" \
 '{schema:"wbtc-ipor-governance-fork-rehearsal-v1",status:$status,chainId:1,upstreamHeight:$head,upstreamBlock:$block,upstreamBlockHash:$blockHash,morphoBlue:$morphoBlue,runnerCommit:$gitSha,localRPC:"http://127.0.0.1:8545",liveGovernanceExecuted:false,realProofVerifiedOnchain:false}' > "$OUT/fork-report.json"
printf 'Verified mainnet fork: block=%s hash=%s; Morpho Blue code present. Mainnet was not modified.\n' "$PIN" "$UPSTREAM_HASH"

if [[ "\${FORK_ONLY_PREFLIGHT:-0}" == '1' ]]; then
  echo 'Fork infrastructure ready. No governance or proof tests were executed.'
  exit 0
fi

# Never substitute mock contracts or claim passing governance tests before deployment/proving code exists.
[[ -s "$PROJECT/foundry.toml" ]] || fail 'governance Foundry project is not implemented'
[[ -s "$PROJECT/script/ForkDeploy.s.sol" ]] || fail 'actual fork deployment script is not implemented'
[[ -s "$PROJECT/test/fork/WbtcIporGovernanceFork.t.sol" ]] || fail 'source-bound Aragon fork scenario suite is not implemented'
[[ -x "$PROJECT/scripts/ForkProveAndSubmit.sh" ]] || fail 'real-proof generation/onchain acceptance runner is not implemented'

unset UPSTREAM_RPC_URL RPC_ETHEREUM GOVERNANCE_ARCHIVE_RPC_URL || true
export ETH_RPC_URL="$LOCAL_RPC" FORK_RPC_URL="$LOCAL_RPC" RISC0_DEV_MODE=0
cd "$PROJECT"
forge build --out "$OUT/build" 2>&1 | tee "$OUT/forge-build.log"
# Public default Anvil development key, used only with an explicitly pinned loopback RPC.
ANVIL_TEST_KEY='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
forge script script/ForkDeploy.s.sol:ForkDeploy --rpc-url "$LOCAL_RPC" --private-key "$ANVIL_TEST_KEY" --broadcast -vv 2>&1 | tee "$OUT/deploy.log"
forge test --match-path 'test/fork/WbtcIporGovernanceFork.t.sol' --fork-url "$LOCAL_RPC" -vv 2>&1 | tee "$OUT/governance-tests.log"
bash scripts/ForkProveAndSubmit.sh 2>&1 | tee "$OUT/zk-proof-submission.log"

# Independently cross-check the generated evidence against the forked EVM.
status="$(jq -r '.status // empty' "$OUT/fork-report.json")"
[[ "$status" == 'FORK_GOVERNANCE_VERIFIED' ]] || fail 'real-proof submission integration not complete'
[[ "$(jq -r '.liveGovernanceExecuted // false' "$OUT/fork-report.json")" == true ]] || fail 'live fork governance assertions missing'
[[ "$(jq -r '.realProofVerifiedOnchain // false' "$OUT/fork-report.json")" == true ]] || fail 'real proof not accepted by on-chain verifier'
PLUGIN="$(jq -r '.governancePlugin // empty' "$OUT/fork-report.json")"
PROPOSAL="$(jq -r '.proposalId // empty' "$OUT/fork-report.json")"
TX="$(jq -r '.proofSubmissionTxHash // empty' "$OUT/fork-report.json")"
[[ "$PLUGIN" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail 'proof recipient plugin address missing'
[[ "$PROPOSAL" =~ ^[0-9]+$ ]] || fail 'proof proposal ID missing'
[[ "$TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail 'proof submission transaction hash missing'
[[ "$(cast code "$PLUGIN" --rpc-url "$LOCAL_RPC")" != '0x' ]] || fail 'governance plugin has no code'
RECEIPT_STATUS="$(cast receipt "$TX" --field status --rpc-url "$LOCAL_RPC" | tr -d '\r\n')"
[[ "$RECEIPT_STATUS" == '1' || "$RECEIPT_STATUS" == '0x1' ]] || fail 'real proof submission transaction failed or missing'
VERIFIED="$(cast call "$PLUGIN" 'isVerifiedSnapshot(uint256)(bool)' "$PROPOSAL" --rpc-url "$LOCAL_RPC" | tr -d '\r\n')"
[[ "$VERIFIED" == true ]] || fail 'Aragon plugin does not report verified on-chain snapshot'
echo 'Fork-only proof submission mined, and governance plugin confirms verified snapshot. Inspect artifact receipts.'
