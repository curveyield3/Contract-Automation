#!/usr/bin/env bash
# One X11 delivery path for reviewer wakes and watchdog pokes; only WAKE_MESSAGE differs.
# Stdout carries only ok/send_attempted/skipped/rc lines (GITHUB_OUTPUT format); the
# browser runtime's own log goes to stderr. The full result is at $WAKE_RESULT_PATH.
set -euo pipefail
: "${WAKE_MESSAGE:?}" "${WAKE_RESULT_PATH:?}"
export WAKE_ACTION='wake'
export WAKE_MODE="${WAKE_MODE:-resume_existing}"
# Same delivery semantics as the reviewer wake: no idle wait before sending.
export WAKE_MESSAGE_PURPOSE="${WAKE_MESSAGE_PURPOSE:-initial_wake}"
# Stop-first only when the reviewer has stopped advancing (watchdog pokes set it
# explicitly; repair notices here). A routine controller wake must never stop a
# reviewer that is already working on its next unit.
if [ -z "${STOP_BEFORE_SEND:-}" ]; then
  case "$WAKE_MESSAGE_PURPOSE" in repair_notice) STOP_BEFORE_SEND=true;; *) STOP_BEFORE_SEND=false;; esac
fi
export STOP_BEFORE_SEND
set +e
timeout -k 10s 360s node scripts/browser-agent-wake.mjs >&2
rc=$?
set -e
if [ ! -s "$WAKE_RESULT_PATH" ]; then
  jq -n --argjson rc "$rc" '{ok:false,wakeId:"unknown",failures:[{provider:"github-playwright",code:"NO_RESULT",retryable:false,error:("browser runtime exited without a result; rc="+($rc|tostring))}]}' > "$WAKE_RESULT_PATH"
fi
ok="$(jq -r '.ok // false' "$WAKE_RESULT_PATH")"
sent="$(jq -r '.sendAttempted // false' "$WAKE_RESULT_PATH")"
skipped="$(jq -r '.skipped // empty' "$WAKE_RESULT_PATH")"
# A visible send is required; a skipped send is not a delivery.
if [ "$ok" = true ] && [ "$sent" != true ]; then
  [ -n "$skipped" ] || echo "::error::Browser result claimed an X11 send without input evidence" >&2
  ok=false
fi
echo "ok=$ok"
echo "send_attempted=$sent"
echo "skipped=$skipped"
echo "rc=$rc"
