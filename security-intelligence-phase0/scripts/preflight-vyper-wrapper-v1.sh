#!/bin/sh
set -eu
version="${SECURITY_PREFLIGHT_VYPER_VERSION:-}"
if [ -n "$version" ]; then
  case "$version" in *[!0-9.]*|'') echo 'invalid Vyper compiler version' >&2; exit 64;; esac
  if [ -x "/opt/preflight/vyper-envs/$version/bin/vyper" ]; then
    exec "/opt/preflight/vyper-envs/$version/bin/vyper" "$@"
  fi
  echo "requested pinned Vyper version $version was not prepared" >&2
  exit 69
fi
exec /opt/slither/bin/vyper "$@"
