#!/usr/bin/env bash
# Connect one ephemeral GitHub Actions browser runner directly with Tailscale OIDC.
# No Tailscale API auth-key creation and no stored TAILSCALE_AUTHKEY.
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP required}"
: "${TS_CLIENT_ID:?TS_OAUTH_CLIENT_ID is not configured}"
: "${TAILNET_TAG:?Tailscale federated device tag required}"
if [[ ! "$TAILNET_TAG" =~ ^tag:[A-Za-z0-9][A-Za-z0-9._-]*(,tag:[A-Za-z0-9][A-Za-z0-9._-]*)*$ ]]; then
  echo "::error::Expected comma-separated authorized Tailscale tags: tag:one,tag:two" >&2
  exit 1
fi
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?GitHub OIDC token URL unavailable; grant id-token: write}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?GitHub OIDC request token unavailable}"

version="1.104.2"
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "::error::Unsupported Tailscale runner architecture" >&2; exit 1 ;;
esac

cache_root="$RUNNER_TEMP/tailscale-static-v$version"
bin_dir="$cache_root/tailscale_${version}_$arch"
if [ ! -x "$bin_dir/tailscale" ] || [ ! -x "$bin_dir/tailscaled" ]; then
  mkdir -p "$cache_root"
  archive="$RUNNER_TEMP/tailscale_${version}_$arch.tgz"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    --retry 3 --max-time 150 \
    "https://pkgs.tailscale.com/stable/tailscale_${version}_$arch.tgz" \
    --output "$archive"
  tar -xzf "$archive" -C "$cache_root"
  rm -f "$archive"
  [ -x "$bin_dir/tailscale" ] && [ -x "$bin_dir/tailscaled" ] || {
    echo "::error::Tailscale distribution archive did not contain expected executables" >&2
    exit 1
  }
fi

sudo install -m 0755 "$bin_dir/tailscale" /usr/local/bin/tailscale
sudo install -m 0755 "$bin_dir/tailscaled" /usr/local/bin/tailscaled
sudo mkdir -p /var/run/tailscale

# In-memory state means no long-lived device or node credentials persist on disk.
# Keep the daemon running only for this ephemeral GitHub Actions job.
sudo /usr/local/bin/tailscaled --state=mem: \
  --socket=/var/run/tailscale/tailscaled.sock \
  > "$RUNNER_TEMP/browser-tailscaled-oidc.log" 2>&1 &
echo $! > "$RUNNER_TEMP/browser-tailscaled-oidc.pid"

ready=false
for attempt in $(seq 1 30); do
  if sudo /usr/local/bin/tailscale status --json 2>/dev/null | jq -e '.BackendState == "NeedsLogin" or .BackendState == "Running"' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "::error::Tailscale daemon did not become ready" >&2
  tail -n 20 "$RUNNER_TEMP/browser-tailscaled-oidc.log" | sed -E 's/(token|secret|key)=[^ ]+/\\1=[REDACTED]/g' >&2
  exit 1
fi

# GitHub-hosted runners can intermittently fail Tailscale's automatic OIDC
# discovery. Request the job's actual signed JWT from GitHub and pass the short-
# lived token explicitly; no long-lived auth keys or extra credentials required.
[[ "$TS_CLIENT_ID" =~ ^[A-Za-z0-9_-]+$ ]] || {
  echo "::error::Invalid Tailscale workload-identity client identifier" >&2
  exit 1
}
audience="api.tailscale.com/$TS_CLIENT_ID"
oidc_url="$ACTIONS_ID_TOKEN_REQUEST_URL"
if [[ "$oidc_url" == *\?* ]]; then oidc_url+="&"; else oidc_url+="?"; fi
oidc_url+="audience=api.tailscale.com%2F$TS_CLIENT_ID"
umask 077
oidc_file="$(mktemp "$RUNNER_TEMP/tailscale-id-token.XXXXXXXX")"
trap 'rm -f "$oidc_file"' EXIT
if ! curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --retry 2 --retry-all-errors --max-time 30 \
    -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$oidc_url" |
   jq -er '.value | select(type=="string" and (split(".")|length==3))' > "$oidc_file"; then
  echo "::error::GitHub OIDC JWT issuance failed for Tailscale workload identity" >&2
  exit 1
fi
test -s "$oidc_file" || { echo "::error::GitHub returned no valid OIDC token" >&2; exit 1; }
echo "Connecting via explicit, short-lived GitHub OIDC JWT (no credential logging)."
if ! timeout -k 5s 120s sudo /usr/local/bin/tailscale up \
  --client-id="$TS_CLIENT_ID" \
  --id-token="file:$oidc_file" \
  --advertise-tags="$TAILNET_TAG" \
  --accept-dns=false; then
  echo "::error::Tailscale workload-identity authentication failed; inspect issuer, subject, audience and tag permissions." >&2
  exit 1
fi
rm -f "$oidc_file"

sudo /usr/local/bin/tailscale status --json | jq -e '.BackendState == "Running"' >/dev/null || {
  echo "::error::Tailscale connected without entering Running state" >&2
  exit 1
}

# Preserve prior action's ping-to-home exit-node readiness contract.
if [ -n "${TAILNET_PING:-}" ]; then
  timeout -k 5s 70s sudo /usr/local/bin/tailscale ping --until-direct=false --c=2 --timeout=10s "$TAILNET_PING" >/dev/null || {
    echo "::error::Tailscale established but home exit-node peer is unreachable" >&2
    exit 1
  }
fi
echo "Authenticated to tailnet via direct OIDC and verified peer reachability."
