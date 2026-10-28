#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/audit-source-initialization/resolve-source-v1.sh"
source "$ROOT/scripts/audit-source-initialization/extract-v1.sh"

DELIVERY_TRANSPORT=DIRECT
SOURCE_URL="${SOURCE_URL:-}"
SCAN_URLS="${SCAN_URLS:-[]}"
if [ -n "$SOURCE_URL" ] && [ "$SCAN_URLS" != '[]' ]; then
  echo "::error::SOURCE_INPUT_CONFLICT" >&2; exit 1
fi
if [ -z "$SOURCE_URL" ] && [ "$SCAN_URLS" = '[]' ]; then
  echo "::error::SOURCE_INPUT_MISSING" >&2; exit 1
fi
input_mode='ZIP'
if [ "$SCAN_URLS" != '[]' ]; then
  input_mode='LIVE_SCAN'
  : "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY secret must be configured for LIVE_SCAN}"
fi
: "${REQUEST_ID:?REQUEST_ID is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${AUDIT_CONTROLLER_TOKEN:?AUDIT_CONTROLLER_TOKEN is required}"
: "${CONTRACT_AUTOMATION_TOKEN:?CONTRACT_AUTOMATION_TOKEN is required}"
safe_request="$(printf '%s' "$REQUEST_ID" | tr -c 'A-Za-z0-9._-' '_')"
report_path="process/lite-solo-source-initialization/reports/$safe_request.json"

# Normalize publication consent exactly once, before request recovery or admission.
# Absent whole object means ten OFF; an explicitly supplied object must be complete.
PUBLISH_FILES_JSON="$(printf '%s' "${PUBLISH_FILES_JSON:-\"__ABSENT__\"}" | python3 -c '
import json,sys
keys = ("report_pdf","audited_source","scope_summary","findings_remediation","methodology_analysis","properties_hypotheses","execution_results","architecture_dependencies","residual_risks","evidence_index")
try:
    data=json.load(sys.stdin)
    if data=="__ABSENT__": data={key:True for key in keys}
    if type(data) is not dict or set(data)!=set(keys) or any(type(data[k]) is not bool for k in keys):
        raise ValueError("INVALID_PUBLICATION_POLICY")
    print(json.dumps(data,sort_keys=True,separators=(",",":"),ensure_ascii=True))
except (ValueError,TypeError):
    sys.exit("INVALID_PUBLICATION_POLICY")
')"
export PUBLISH_FILES_JSON
policy_sha_for_ids() {
    POLICY_CAMPAIGN_ID="$1" POLICY_GENERATION_ID="$2" python3 -c '
import hashlib,json,os
p={"schemaVersion":"curveyield-report-publication-policy-v1",
   "catalogueVersion":"curveyield-report-file-catalogue-v1",
   "campaignId":os.environ["POLICY_CAMPAIGN_ID"],
   "campaignGenerationId":os.environ["POLICY_GENERATION_ID"],
   "selectionSource":"CAMPAIGN_INITIALIZATION",
   "publicationPolicyRevision":1,
   "publishFiles":json.loads(os.environ["PUBLISH_FILES_JSON"])}
print(hashlib.sha256(json.dumps(p,sort_keys=True,separators=(",",":"),ensure_ascii=True).encode("utf-8")).hexdigest())
'
}
publication_any_on() { printf '%s' "$PUBLISH_FILES_JSON" | jq -e 'any(.[]; . == true)' >/dev/null; }



# Exact workflow retries are idempotent. A new request using the same ZIP is NOT
# deduplicated; it intentionally creates the next rN campaign revision.
report_api="repos/$GITHUB_REPOSITORY/contents/$report_path"
report_sha="$(gh api "$report_api?ref=main" --jq '.sha // empty' 2>/dev/null || true)"
if [[ "$report_sha" =~ ^[0-9a-f]{40}$ ]]; then
  encoded="$(gh api "$report_api?ref=main" --jq '.content')"
  printf '%s' "$encoded" | base64 -d > /tmp/prior-source-init.json
  jq -e --arg url "$SOURCE_URL" --argjson scans "$SCAN_URLS" \
    '.schemaVersion=="curveyield-lite-solo-source-report-v1" and .mode=="LITE_SOLO" and .status=="PASS" and .actor.actorId=="lite-solo-agent" and .source.inputUrl==$url and .source.scanUrls==$scans' \
    /tmp/prior-source-init.json >/dev/null
  campaign_id="$(jq -r '.campaign.campaignId' /tmp/prior-source-init.json)"
  generation_id="$(jq -r '.campaign.campaignGenerationId' /tmp/prior-source-init.json)"
  campaign_name="$(jq -r '.campaign.campaignName' /tmp/prior-source-init.json)"
  campaign_root="$(jq -r '.campaign.workspacePath' /tmp/prior-source-init.json)"
  prior_policy_sha="$(jq -r '.publicationPolicySha256 // empty' /tmp/prior-source-init.json)"
  expected_policy_sha="$(policy_sha_for_ids "$campaign_id" "$generation_id")"
  if [ -n "$prior_policy_sha" ] && [ "$prior_policy_sha" != "$expected_policy_sha" ]; then
    echo "::error::PUBLICATION_POLICY_CONFLICT" >&2; exit 1
  fi
  if [ -z "$prior_policy_sha" ]; then
    # A previously admitted request without a frozen policy may resume Phase 0.
    # Do not retroactively bind or change its publication settings on retry.
    echo "::notice::LEGACY_PUBLICATION_POLICY_UNBOUND: resuming source-bound campaign without changing release selection"
  fi
else
  # New campaigns bind the installed lite-solo-v4 authority and its immutable manifest.
  export GH_TOKEN="$AUDIT_CONTROLLER_TOKEN"
  gh auth setup-git
  work='/tmp/audit-source-initialization'
  if [ "$input_mode" = 'LIVE_SCAN' ]; then
    rm -rf "$work"
    mkdir -p "$work"
    python3 "$ROOT/scripts/audit-source-initialization/resolve-scan-source-v1.py" "$SCAN_URLS" "$work"
  else
    resolve_audit_source_zip "$SOURCE_URL" "$work" "$AUDIT_CONTROLLER_TOKEN"
  fi

  filename="$(cat "$work/filename")"
  source_sha="$(cat "$work/sha256")"
  source_size="$(cat "$work/size")"
  provider="$(cat "$work/provider")"
  canonical_url="$(cat "$work/canonical-url")"
  display_base="$(cat "$work/display-base")"
  slug="$(cat "$work/slug")"

  repo='/tmp/audit-controller-source-init'
  rm -rf "$repo"
  # Materialize only what initialization reads or writes: the current authority package, the
  # campaign directory entries, and (added below) the new campaign folder. Everything else in
  # Audit-Controller stays unfetched; revision and collision checks read the Git tree instead.
  gh repo clone curveyield3/Audit-Controller "$repo" -- --branch main --depth 1 --filter=blob:none --sparse
  cd "$repo"
  git sparse-checkout set --no-cone '/Audit Skill - Lite-Solo Authority/**' '/Audit Campaign Directory/campaigns/**'
  git config user.name 'CurveYield Lite-Solo Source Initialization'
  git config user.email 'lite-solo@users.noreply.github.com'
  authority_parent='Audit Skill - Lite-Solo Authority'
  authority_root="$authority_parent/lite-solo-v4"
  skill_home="$authority_root/SKILL.md"
  # One active Solo skill only. Historical campaign bindings use pinned Git commits.
  shopt -s nullglob
  active_solo_skills=("$authority_parent"/*/SKILL.md)
  shopt -u nullglob
  [ "${#active_solo_skills[@]}" -eq 1 ] && [ "${active_solo_skills[0]}" = "$skill_home" ] || { echo '::error::Expected exactly one active Lite-Solo skill: lite-solo-v4' >&2; exit 1; }
  test -f "$authority_root/MANIFEST.json" || { echo '::error::Registered Lite-Solo v4 authority package is missing' >&2; exit 1; }
  authority_packages=("$authority_root")
  skill_repo_path='curveyield3/Audit-Controller/Audit Skill - Lite-Solo Authority'
  skill_release="$(jq -r .release "$authority_root/MANIFEST.json")"
  skill_revision="$(jq -r .packageRevision "$authority_root/MANIFEST.json")"
  [ "$skill_release" = 'lite-solo-v4' ] && [ "$skill_revision" = 'v4' ] || { echo "::error::Lite-Solo manifest version mismatch" >&2; exit 1; }
  test -f "$skill_home" || { echo "::error::Current Lite-Solo SKILL.md missing" >&2; exit 1; }
  node "$ROOT/scripts/lite-solo-verify-authority-v1.mjs" "$authority_root"
  skill_sha="$(sha256sum "$skill_home" | awk '{print $1}')"
  skill_blob="$(git rev-parse "HEAD:$skill_home")"
  jq -e --arg release "$skill_release" --arg rev "$skill_revision" '.release==$release and .packageRevision==$rev and .mode=="LITE_SOLO" and (.reviewerLineup.masterSegments|length)==0' "$authority_root/MANIFEST.json" >/dev/null
  # A previous attempt can publish the campaign and receipt before the report
  # or browser registration write succeeds. Recover by immutable request ID;
  # never create a new rN for that same request after a 409/interruption.
  recovered=false
  while IFS= read -r directory_file; do
    if jq -e --arg id "$REQUEST_ID" '.sourceInitializationRequestId==$id' "$directory_file" >/dev/null; then
      [ "$recovered" = false ] || { echo "::error::AMBIGUOUS_SOURCE_REQUEST_RECOVERY"; exit 1; }
      recovered=true
      campaign_id="$(jq -r '.campaignId' "$directory_file")"
      generation_id="$(jq -r '.campaignGenerationId' "$directory_file")"
      campaign_name="$(jq -r '.campaignName' "$directory_file")"
      campaign_root="$(jq -r '.workspacePath' "$directory_file")"
    fi
  done < <(find 'Audit Campaign Directory/campaigns' -type f -name '*.json' -print 2>/dev/null | LC_ALL=C sort)
  if [ "$recovered" = true ]; then
    jq -e '.mode=="LITE_SOLO" and .agent.actorId=="lite-solo-agent" and .deliveryTransport=="DIRECT"' "Audit Campaign Directory/campaigns/${campaign_id%-r*}.json" >/dev/null || { echo "::error::SOLO_REQUEST_IDENTITY_MISMATCH"; exit 1; }
    literal_recovery="$(printf '%s' "$campaign_root" | sed -e 's/[][*?!#\\]/\\&/g')"
    git sparse-checkout add "/$literal_recovery/"
    prior_receipt="$campaign_root/receipts/PHASE_00_RECEIPT_v1.json"
    test -f "$prior_receipt" || { echo "::error::SOURCE_ALREADY_ADMITTED_RECEIPT_MISSING"; exit 1; }
    jq -e --arg id "$REQUEST_ID" '.campaign.sourceInitializationRequestId==$id' "$prior_receipt" >/dev/null || {
      echo "::error::SOURCE_REQUEST_RECOVERY_IDENTITY_CONFLICT"; exit 1
    }
    if [ "$input_mode" = LIVE_SCAN ]; then
      jq -e --argjson urls "$SCAN_URLS" '.source.inputMode=="LIVE_SCAN" and .source.originUrls==$urls' "$prior_receipt" >/dev/null || {
        echo "::error::SOURCE_REQUEST_RECOVERY_URL_SET_CONFLICT"; exit 1
      }
    else
      jq -e --arg url "$canonical_url" '.source.inputMode=="ZIP" and .source.originUrl==$url' "$prior_receipt" >/dev/null || {
        echo "::error::SOURCE_REQUEST_RECOVERY_ZIP_CONFLICT"; exit 1
      }
    fi
    recorded_policy_sha="$(jq -r '.automation[]? | select(.role=="REPORT_PUBLICATION_POLICY") | .sha256' "$prior_receipt")"
    expected_policy_sha="$(policy_sha_for_ids "$campaign_id" "$generation_id")"
    if [ -n "$recorded_policy_sha" ] && [ "$recorded_policy_sha" != "$expected_policy_sha" ]; then
      echo "::error::PUBLICATION_POLICY_CONFLICT" >&2; exit 1
    fi
    if [ -z "$recorded_policy_sha" ] && publication_any_on; then
      echo "::error::PUBLICATION_POLICY_CONFLICT: legacy source has no selection" >&2; exit 1
    fi
    source_sha="$(jq -r '.source.sha256' "$prior_receipt")"
    source_size="$(jq -r '.source.byteLength' "$prior_receipt")"
    source_path="$(jq -r '.source.archivePath' "$prior_receipt")"
    source_blob="$(jq -r '.source.archiveGitBlobSha' "$prior_receipt")"
    admission_commit="$(jq -r '.source.archiveCommit' "$prior_receipt")"
    tree_sha="$(jq -r '.source.extractedTreeSha256' "$prior_receipt")"
    provider="$(jq -r '.source.originProvider' "$prior_receipt")"
    canonical_url="$(jq -r '.source.originUrl' "$prior_receipt")"
    filename="$(jq -r '.source.generatedArchiveFilename // .source.uploadedFilename' "$prior_receipt")"
    init_commit="$(git rev-parse HEAD)"
    echo "::notice::SOURCE_ALREADY_ADMITTED: recovering existing $campaign_id for request $REQUEST_ID"
  fi

  if [ "$recovered" = false ]; then
  success=false
  for attempt in 1 2 3 4 5; do
    git fetch --depth 1 --filter=blob:none origin main
    git reset --hard origin/main
    git clean -fdx

    # Freeze the complete authority identity from this exact initialization
    # snapshot, not a pre-retry tree that might have moved on main.
    skill_manifest="${authority_packages[0]}/MANIFEST.json"
    test -f "$skill_home" && test -f "$skill_manifest"
    shopt -s nullglob
    active_solo_skills=("$authority_parent"/*/SKILL.md)
    shopt -u nullglob
    [ "${#active_solo_skills[@]}" -eq 1 ] && [ "${active_solo_skills[0]}" = "$skill_home" ] || { echo '::error::Multiple or missing active Lite-Solo skill packages at admission' >&2; exit 1; }
    node "$ROOT/scripts/lite-solo-verify-authority-v1.mjs" "$authority_root"
    skill_sha="$(sha256sum "$skill_home" | awk '{print $1}')"
    skill_blob="$(git rev-parse "HEAD:$skill_home")"
    manifest_sha="$(sha256sum "$skill_manifest" | awk '{print $1}')"
    manifest_blob="$(git rev-parse "HEAD:$skill_manifest")"
    authority_commit="$(git rev-parse HEAD)"
    jq -e --arg sha "$skill_sha" '
      (.files | type) == "array" and
      any(.files[]; .path=="SKILL.md" and .sha256==$sha)
    ' "$skill_manifest" >/dev/null

    max=0
    while IFS= read -r f; do
      id="$(jq -r '.campaignId // empty' "$f" 2>/dev/null || true)"
      if [[ "$id" =~ ^${slug}-r([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" -gt "$max" ]; then
        max="${BASH_REMATCH[1]}"
      fi
    done < <(find 'Audit Campaign Directory/campaigns' -type f -name '*.json' -print 2>/dev/null | LC_ALL=C sort)
    # Campaign folders are not materialized; take existing revisions from the tree's folder names.
    while IFS= read -r folder; do
      suffix="${folder#"campaigns/$display_base r"}"
      if [ "$suffix" != "$folder" ] && [[ "$suffix" =~ ^[0-9]+$ ]] && [ "$suffix" -gt "$max" ]; then
        max="$suffix"
      fi
    done < <(git ls-tree -d --name-only HEAD -- campaigns/)

    revision=$((max + 1))
    campaign_id="$slug-r$revision"
    campaign_name="$display_base r$revision"
    campaign_root="campaigns/$campaign_name"
    source_dir="$campaign_root/source"
    source_path="$source_dir/$filename"
    receipts_dir="$campaign_root/receipts"
    campaign_directory_path="Audit Campaign Directory/campaigns/$slug.json"
    created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    compact="$(date -u +%Y%m%dT%H%M%SZ)"
    generation_id="$campaign_id-g1-$compact"

    ! git cat-file -e "HEAD:$campaign_root" 2>/dev/null || { echo "::error::Campaign path collision: $campaign_root"; exit 1; }
    literal_root="$(printf '%s' "$campaign_root" | sed -e 's/[][*?!#\\]/\\&/g')"
    git sparse-checkout add "/$literal_root/"

    mkdir -p "$source_dir" "$receipts_dir" "$campaign_root/reports" "Audit Campaign Directory/campaigns"
    cp "$work/$filename" "$source_path"
    tree_sha="$(safe_extract_audit_zip "$source_path" "$source_dir" "$filename")"

    git add -- "$source_dir"
    git commit -m "audit(source): admit $campaign_id"
    admission_commit="$(git rev-parse HEAD)"
    source_blob="$(git rev-parse "HEAD:$source_path")"

    REQUEST_ID="$REQUEST_ID" CAMPAIGN_ID="$campaign_id" GENERATION_ID="$generation_id" CAMPAIGN_NAME="$campaign_name" SLUG="$slug" \
    CAMPAIGN_ROOT="$campaign_root" SOURCE_PROVIDER="$provider" SOURCE_URL_CANONICAL="$canonical_url" \
    SOURCE_FILENAME="$filename" SOURCE_SHA="$source_sha" SOURCE_SIZE="$source_size" SOURCE_PATH="$source_path" \
    SOURCE_DIR="$source_dir" ADMISSION_COMMIT="$admission_commit" SOURCE_BLOB="$source_blob" TREE_SHA="$tree_sha" \
    SOURCE_INPUT_MODE="$input_mode" SCAN_TARGETS_JSON="$SCAN_URLS" \
    SCAN_MANIFEST_SHA="$(cat "$work/scan-manifest-sha256" 2>/dev/null || true)" \
    SCAN_TARGET_SET_SHA="$(cat "$work/scan-target-set-sha256" 2>/dev/null || true)" \
    CREATED_AT="$created_at" SKILL_RELEASE="$skill_release" SKILL_REVISION="$skill_revision" SKILL_HOME="$skill_home" \
    DELIVERY_TRANSPORT="$DELIVERY_TRANSPORT" PUBLISH_FILES_JSON="$PUBLISH_FILES_JSON" \
    SKILL_SHA="$skill_sha" SKILL_BLOB="$skill_blob" SKILL_REPO_PATH="$skill_repo_path" \
    MANIFEST_SHA="$manifest_sha" MANIFEST_BLOB="$manifest_blob" AUTHORITY_COMMIT="$authority_commit" \
    RECEIPTS_DIR="$receipts_dir" CAMPAIGN_DIRECTORY_PATH="$campaign_directory_path" \
      python3 "$ROOT/scripts/lite-solo-source-initialization/write-phase0-receipt-v1.py"

    git add -- "$receipts_dir" "$campaign_directory_path" "$campaign_root/reports/REPORT_PUBLICATION_POLICY_v1.json"
    git commit -m "audit(receipt): initialize $campaign_id phase 0"
    init_commit="$(git rev-parse HEAD)"

    if git push origin HEAD:main; then
      success=true
      break
    fi

    echo "::warning::Audit-Controller main moved; rebuilding the initialization on latest main (attempt $attempt/5)."
    sleep $((attempt * 2))
  done
  [ "$success" = true ] || { echo "::error::Failed to publish Audit Source Initialization to Audit-Controller main."; exit 1; }
  fi

  export GH_TOKEN="$CONTRACT_AUTOMATION_TOKEN"
  resolved_policy_sha="$(policy_sha_for_ids "$campaign_id" "$generation_id")"
  jq -n --arg policySha "$resolved_policy_sha" --arg requestId "$REQUEST_ID" --arg inputUrl "$SOURCE_URL" --argjson scanUrls "$SCAN_URLS" --arg campaignId "$campaign_id" --arg generation "$generation_id" --arg campaignName "$campaign_name" --arg workspace "$campaign_root" --arg sha "$source_sha" \
    '{schemaVersion:"curveyield-lite-solo-source-report-v1",mode:"LITE_SOLO",status:"PASS",requestId:$requestId,publicationPolicySha256:$policySha,actor:{actorId:"lite-solo-agent"},source:{sha256:$sha,inputUrl:$inputUrl,scanUrls:$scanUrls},campaign:{campaignId:$campaignId,campaignGenerationId:$generation,campaignName:$campaignName,workspacePath:$workspace},completedAt:(now|todate)}' > /tmp/source-init-report.json

  body="$(base64 -w0 /tmp/source-init-report.json)"
  api="repos/$GITHUB_REPOSITORY/contents/$report_path"
  current="$(gh api "$api?ref=main" --jq '.sha' 2>/dev/null || true)"
  if [[ "$current" =~ ^[0-9a-f]{40}$ ]]; then
    gh api --method PUT "$api" -f message="chore(audit): record source initialization $REQUEST_ID" \
      -f content="$body" -f sha="$current" -f branch=main >/dev/null
  else
    gh api --method PUT "$api" -f message="chore(audit): record source initialization $REQUEST_ID" \
      -f content="$body" -f branch=main >/dev/null
  fi
fi

export GH_TOKEN="$CONTRACT_AUTOMATION_TOKEN"

# Idempotent retry: retain successful, source-bound Phase-0 intelligence
# instead of recompiling solely because a later deploy/config checkout failed.
resume_from_deploy=false
if [[ "$report_sha" =~ ^[0-9a-f]{40}$ ]]; then
  export GH_TOKEN="$AUDIT_CONTROLLER_TOKEN"
  evidence_ready=true
  for evidence in \
    evidence/build/BUILD_AND_SOURCE_IDENTITY_v1.json \
    evidence/build/PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json \
    evidence/static-analysis/SLITHER_v1.json \
    evidence/source-intelligence/SOURCE_INTELLIGENCE_AUTOMATED_v1.json; do
    encoded="$(jq -rn --arg p "$campaign_root/$evidence" '$p|split("/")|map(@uri)|join("/")')"
    if ! gh api "repos/curveyield3/Audit-Controller/contents/$encoded?ref=main" --jq '.sha' >/dev/null 2>&1; then
      evidence_ready=false
      break
    fi
  done
  # A previous intelligence pass can succeed but produce an incomplete source
  # inventory. If the Phase-0 finalizer could not publish FLOW_PLAN, regenerate
  # actual compiled source contexts rather than reusing incomplete evidence.
  if [ "$evidence_ready" = true ]; then
    plan_path="$campaign_root/evidence/review-inventory/FLOW_PLAN_v1.json"
    encoded_plan="$(jq -rn --arg p "$plan_path" '$p|split("/")|map(@uri)|join("/")')"
    if gh api "repos/curveyield3/Audit-Controller/contents/$encoded_plan?ref=main" --jq '.sha' >/dev/null 2>&1; then
      resume_from_deploy=true
    else
      echo "::notice::Phase-0 flow plan not sealed; regenerate source review inventory from existing immutable source."
    fi
  fi
fi
export GH_TOKEN="$CONTRACT_AUTOMATION_TOKEN"
gh workflow run lite-solo-phase0-bootstrap-v1.yml --repo "$GITHUB_REPOSITORY" --ref main \
  -f campaign_id="$campaign_id" \
  -f campaign_path="$campaign_root" \
  -f audit_controller_ref=main \
  -f resume_from_deploy="$resume_from_deploy"

{
 echo "## lite-solo Source Initialization"
 echo "- Campaign: $campaign_id"
 echo "- Agent: lite-solo-agent (direct repository/controller work; no chat registration or wake)"
 echo "- Authority: ${skill_home:-campaign-bound authority retained on idempotent retry}"
 echo "- Phase-0 machine work dispatched automatically on admitted source"
} >> "$GITHUB_STEP_SUMMARY"
