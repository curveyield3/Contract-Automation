#!/usr/bin/env bash
# Lite-Solo-only sparse checkout. Materialize the exact receipt-bound authority
# from its immutable commit while keeping campaign writes on the live branch.
# The shared multi-reviewer checkout is deliberately unchanged.
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo 'usage: lite-solo-checkout-bound-controller-v1.sh <destination> <branch> <campaign-path>' >&2
  exit 2
fi
destination="$1"
ref="$2"
campaign_path="${3%/}"
case "$destination" in .audit-controller) ;; *) echo 'unsupported checkout destination' >&2; exit 2;; esac
case "$campaign_path" in campaigns/*) ;; *) echo 'unsafe campaign path' >&2; exit 2;; esac
case "/$campaign_path/" in */../*|*/./*|*//*) echo 'unsafe campaign path' >&2; exit 2;; esac
git check-ref-format --branch "$ref" >/dev/null || { echo 'invalid checkout branch' >&2; exit 2; }
[ -n "${GH_TOKEN:-}" ] || { echo 'Audit-Controller credential required' >&2; exit 1; }
gh auth setup-git
rm -rf -- "$destination"
git init --quiet "$destination"
git -C "$destination" remote add origin https://github.com/curveyield3/Audit-Controller.git
git -C "$destination" fetch --no-tags --depth=1 --filter=blob:none origin "$ref"
head="$(git -C "$destination" rev-parse FETCH_HEAD)"
receipt_path="$campaign_path/receipts/PHASE_00_RECEIPT_v1.json"
receipt="$(git -C "$destination" show "$head:$receipt_path")"
read_field() { printf '%s' "$receipt" | jq -er "$1"; }
[ "$(read_field '.campaign.mode')" = LITE_SOLO ] || { echo 'not a Lite-Solo campaign' >&2; exit 1; }
[ "$(read_field '.campaign.workspacePath')" = "$campaign_path" ] || { echo 'campaign path mismatch' >&2; exit 1; }
homepage="$(read_field '.authority.homepagePath')"
{ [ "$homepage" = 'Audit Skill - Audit Preview/audit-preview-v1/SKILL.md' ]; } || { echo 'unexpected Audit Preview authority root' >&2; exit 1; }
[ "$(read_field '.auditPreview.terminalPhase')" = "4" ] || { echo 'not an Audit Preview campaign' >&2; exit 1; }
authority_root="${homepage%/SKILL.md}"
authority_commit="$(read_field '.authority.authorityCommitSha')"
authority_digest="$(read_field '.authority.liteSkillSha256')"
manifest_digest="$(read_field '.authority.manifestSha256')"
directory_entry="$(read_field '.campaign.campaignDirectoryEntryPath')"
[[ "$authority_commit" =~ ^[0-9a-f]{40}$ && "$authority_digest" =~ ^[0-9a-f]{64}$ && "$manifest_digest" =~ ^[0-9a-f]{64}$ ]] || { echo 'invalid bound authority identity' >&2; exit 1; }
campaign_id="$(read_field '.campaign.campaignId')"
[[ "$campaign_id" =~ ^[A-Za-z0-9_.-]+-r[0-9]+$ ]] || { echo 'invalid Lite-Solo campaign id' >&2; exit 1; }
expected_directory="Audit Campaign Directory/campaigns/${campaign_id%-r*}.json"
[ "$directory_entry" = "$expected_directory" ] || { echo 'unexpected campaign directory entry' >&2; exit 1; }
# GitHub permits fetching this historical commit by object ID. It must match
# the Phase-0 receipt; never substitute the latest authority contents.
git -C "$destination" fetch --no-tags --depth=1 --filter=blob:none origin "$authority_commit"
[ "$(git -C "$destination" rev-parse FETCH_HEAD)" = "$authority_commit" ] || { echo 'bound authority commit mismatch' >&2; exit 1; }
old_skill_digest="$(git -C "$destination" show "$authority_commit:$homepage" | sha256sum | cut -d' ' -f1)"
old_manifest_digest="$(git -C "$destination" show "$authority_commit:$authority_root/MANIFEST.json" | sha256sum | cut -d' ' -f1)"
[ "$old_skill_digest" = "$authority_digest" ] || { echo 'bound SKILL digest mismatch' >&2; exit 1; }
[ "$old_manifest_digest" = "$manifest_digest" ] || { echo 'bound manifest digest mismatch' >&2; exit 1; }
literal_pattern() { printf '/%s' "$(printf '%s' "$1" | sed -e 's/[][*?!#\\]/\\&/g')"; }
git -C "$destination" config core.sparseCheckout true
git -C "$destination" config core.sparseCheckoutCone false
{
  printf '%s/\n' "$(literal_pattern "$campaign_path")"
  printf '%s\n' "$(literal_pattern "$directory_entry")"
  printf '%s/\n' "$(literal_pattern "$authority_root")"
  printf '%s\n' "$(literal_pattern 'packages/controller-core/src/lite-phase-receipt-v1.mjs')"
} > "$destination/.git/info/sparse-checkout"
git -C "$destination" checkout --quiet -B "$ref" "$head"
# Worktree-only restoration: retain live main as commit parent, never publish
# the older authority or alter the original multi-agent authority package.
git -C "$destination" restore --source="$authority_commit" --worktree -- "$authority_root"
[ "$(sha256sum "$destination/$homepage" | cut -d' ' -f1)" = "$authority_digest" ] || { echo 'materialized SKILL digest mismatch' >&2; exit 1; }
[ "$(sha256sum "$destination/$authority_root/MANIFEST.json" | cut -d' ' -f1)" = "$manifest_digest" ] || { echo 'materialized manifest digest mismatch' >&2; exit 1; }
[ "$(git -C "$destination" rev-parse HEAD)" = "$head" ] || { echo 'live branch head changed unexpectedly' >&2; exit 1; }
echo "Lite-Solo checkout verified: live campaign $campaign_path at $head; bound authority at $authority_commit"
