#!/usr/bin/env bash
set -euo pipefail

repository="${AUDIT_CONTROLLER_PROBE_REPOSITORY:-curveyield3/Audit-Controller}"
primary="${AUDIT_CONTROLLER_PRIMARY_TOKEN:-}"
required="${AUDIT_CONTROLLER_TOKEN_REQUIRED:-true}"

probe_token() {
  local token="$1"
  [ -n "$token" ] || return 1
  GH_TOKEN="$token" gh api "repos/$repository" --silent >/dev/null 2>&1
}

selected=""
source="NONE"

if probe_token "$primary"; then
  selected="$primary"
  source="AUDIT_CONTROLLER_GITHUB_TOKEN"
elif [ "$required" = "true" ]; then
  echo "::error::AUDIT_CONTROLLER_GITHUB_TOKEN missing or denied for $repository" >&2
  exit 1
fi

if [ -n "$selected" ]; then
  {
    echo 'AUDIT_CONTROLLER_GITHUB_TOKEN<<__CURVEYIELD_AUDIT_CONTROLLER_TOKEN__'
    printf '%s\n' "$selected"
    echo '__CURVEYIELD_AUDIT_CONTROLLER_TOKEN__'
    echo "AUDIT_CONTROLLER_CREDENTIAL_SOURCE=$source"
  } >> "$GITHUB_ENV"
  echo "audit_controller_credential_source=$source" >> "$GITHUB_STEP_SUMMARY"
else
  echo 'AUDIT_CONTROLLER_GITHUB_TOKEN=' >> "$GITHUB_ENV"
  echo 'AUDIT_CONTROLLER_CREDENTIAL_SOURCE=NONE' >> "$GITHUB_ENV"
  echo 'audit_controller_credential_source=NONE' >> "$GITHUB_STEP_SUMMARY"
fi
