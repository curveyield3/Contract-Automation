# Stake DAO harvest bot — setup

Design: `SPEC.md`. Parts: `contracts/` (helper contract), `monitor/` (GitHub Actions, every 5 min),
`worker/` (Cloudflare Worker + Durable Object, every minute). Transactions go only through MEV Blocker
`/noreverts` (revert protection + no front-running; searchers may only backrun). Not `/fullprivacy`: no revert protection.

## 1. Bot wallet (new, dedicated)
```
cast wallet new
```
Keep the private key only in the Cloudflare secret (step 4). Fund the address with ~0.003 ETH.

## 2. Deploy the helper contract (you broadcast)
Owner + admin = fee Safe, bot = the new address, bot reserve = 0.001 ETH (changeable later: `setBotReserve`).
```
cd contracts
forge create src/StakeDaoHarvester.sol:StakeDaoHarvester --rpc-url <mainnet rpc> --account <deployer keystore> --broadcast --constructor-args 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49 <BOT_ADDRESS> 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49 1000000000000000
```
Put the deployed address in `worker/wrangler.toml` → `HARVESTER`.

## 3. GitHub monitor (curveyield3/Contract-Automation) — manual backup only
The bot tracks every vault itself inside the Worker (SPEC.md "Vault tracking inside the Worker"); this workflow only
runs on demand (Actions → Stake DAO Harvester Monitor → Run workflow).
Code lives in `process/stakedao-harvester/`; the workflow is `.github/workflows/stakedao-harvester-monitor.yml`
(every 5 min, public repo = free Actions). Repo secrets (prefixed so they never clash with other workflows):
- `SD_ETH_RPC_URL` = `https://lb.drpc.live/ethereum/<DRPC_KEY>`
- `SD_WORKER_URL` = the Worker URL from step 4
- `SD_HMAC_SECRET` = the same secret as the Worker's `HMAC_SECRET`

## 4. Cloudflare (free plan)
```
cd worker
npm install
npx wrangler login
npx wrangler secret put ETH_RPC_URL      # https://lb.drpc.live/ethereum/<DRPC_KEY>
npx wrangler secret put BOT_PRIVATE_KEY  # the bot key from step 1
npx wrangler secret put HMAC_SECRET      # same as GitHub
npx wrangler deploy
```

## 5. Check / change settings
Every setting in `worker/src/plan.js` `DEFAULT_CONFIG` can be changed live with a signed POST to `/config`
(e.g. `{"minTotalProfitUsd":0.15,"maxBaseFeeGwei":0.1}`); `/stats` returns counters, last result, pending tx.
Monitor settings: `monitor/config.json` (`hotGasGwei` 0.04, …).

## Free-plan budget (routine)
Worker ≈ 1,750 requests/day (limit 100k) · ≤ 4 subrequests per run (limit 50) · Durable Object ≤ 2 rows written per
run (limit 100k/day) · GitHub: free for public repos.
