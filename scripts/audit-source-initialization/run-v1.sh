#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/scripts/audit-source-initialization/resolve-source-v1.sh"
source "$ROOT/scripts/audit-source-initialization/extract-v1.sh"

SINGLE_AGENT_SIMULATION="${SINGLE_AGENT_SIMULATION:-false}"
DELIVERY_TRANSPORT="${DELIVERY_TRANSPORT:-GITHUB_BROWSER}"
[[ "$DELIVERY_TRANSPORT" == GITHUB_BROWSER || "$DELIVERY_TRANSPORT" == AGENT_DELIVERY ]] || { echo "::error::Invalid DELIVERY_TRANSPORT" >&2; exit 1; }
[[ "$SINGLE_AGENT_SIMULATION" == true || "$SINGLE_AGENT_SIMULATION" == false ]] || {
  echo "::error::SINGLE_AGENT_SIMULATION must be true or false" >&2
  exit 1
}

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
: "${AGENT_CHAT_1_URL:?AGENT_CHAT_1_URL is required}"
: "${AGENT_CHAT_2_URL:?AGENT_CHAT_2_URL is required}"
: "${AGENT_CHAT_3_URL:?AGENT_CHAT_3_URL is required}"
: "${AGENT_CHAT_4_URL:?AGENT_CHAT_4_URL is required}"
: "${MASTER_CHAT_URL:?MASTER_CHAT_URL is required}"
: "${TEST_EXECUTOR_CHAT_URL:?TEST_EXECUTOR_CHAT_URL is required}"
: "${BACKUP_CHAT_URL:?BACKUP_CHAT_URL is required}"

safe_request="$(printf '%s' "$REQUEST_ID" | tr -c 'A-Za-z0-9._-' '_')"
report_path="process/audit-source-initialization/reports/$safe_request.json"

# Exact workflow retries are idempotent. A new request using the same ZIP is NOT
# deduplicated; it intentionally creates the next rN campaign revision.
report_api="repos/$GITHUB_REPOSITORY/contents/$report_path"
report_sha="$(gh api "$report_api?ref=main" --jq '.sha // empty' 2>/dev/null || true)"
if [[ "$report_sha" =~ ^[0-9a-f]{40}$ ]]; then
  encoded="$(gh api "$report_api?ref=main" --jq '.content')"
  printf '%s' "$encoded" | base64 -d > /tmp/prior-source-init.json
  jq -e \
    --arg u "$SOURCE_URL" --argjson scans "$SCAN_URLS" --arg transport "$DELIVERY_TRANSPORT" \
    --arg c1 "$AGENT_CHAT_1_URL" --arg c2 "$AGENT_CHAT_2_URL" \
    --arg c3 "$AGENT_CHAT_3_URL" --arg c4 "$AGENT_CHAT_4_URL" --arg master "$MASTER_CHAT_URL" --arg tester "$TEST_EXECUTOR_CHAT_URL" --arg backup "$BACKUP_CHAT_URL" \
    '.schemaVersion=="curveyield-audit-source-initialization-report-v1"
     and .status=="PASS"
     and (.request.deliveryTransport // "GITHUB_BROWSER")==$transport
     and .request.sourceUrl==$u
     and (.request.scanUrls // [])==$scans
     and .request.agentChats["reviewer-1"]==$c1
     and .request.agentChats["reviewer-2"]==$c2
     and (.request.agentChats["reviewer-3"] // .request.agentChats["reviewer-3L"])==$c3
     and .request.agentChats["reviewer-4"]==$c4
     and .request.masterChatUrl==$master
     and .request.testExecutorChatUrl==$tester
     and .request.backupChatUrl==$backup' \
    /tmp/prior-source-init.json >/dev/null
  campaign_id="$(jq -r '.campaign.campaignId' /tmp/prior-source-init.json)"
  generation_id="$(jq -r '.campaign.campaignGenerationId' /tmp/prior-source-init.json)"
  campaign_name="$(jq -r '.campaign.campaignName' /tmp/prior-source-init.json)"
  campaign_root="$(jq -r '.campaign.workspacePath' /tmp/prior-source-init.json)"
else
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
  git sparse-checkout set --no-cone '/Audit Skill - Current Authority/*/' '/Audit Campaign Directory/campaigns/'
  git config user.name 'CurveYield Audit Source Initialization'
  git config user.email 'audit-source-initialization@users.noreply.github.com'

  authority_folder='Audit Skill - Current Authority'
  mapfile -t authority_packages < <(find "$authority_folder" -mindepth 1 -maxdepth 1 -type d -exec test -f '{}/SKILL.md' ';' -print | sort)
  [ "${#authority_packages[@]}" -eq 1 ] || { echo "::error::Authority folder must contain exactly one unpacked package directory with root SKILL.md."; exit 1; }
  skill_home="${authority_packages[0]}/SKILL.md"
  skill_repo_path='curveyield3/Audit-Controller/Audit Skill - Current Authority'
  skill_release="$(sed -n 's/^Release identity: `\(.*\)`$/\1/p' "$skill_home" | head -n1)"
  skill_revision="$(sed -n 's/^Package revision: `\(.*\)`$/\1/p' "$skill_home" | head -n1)"
  skill_sha="$(sha256sum "$skill_home" | awk '{print $1}')"
  skill_blob="$(git rev-parse "HEAD:$skill_home")"
  test -n "$skill_release"
  test -n "$skill_revision"
  third_reviewer_key="reviewer-3L"
  if [ "$skill_release" = "Audit_Litemode_v13" ]; then
    third_reviewer_key="reviewer-3"
    jq -e '.reviewerLineup.schemaVersion=="curveyield-v13-reviewer-lineup-v1" and .reviewerLineup.discoveryAttacker=="reviewer-2"' "${authority_packages[0]}/MANIFEST.json" >/dev/null
  fi

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
    skill_sha="$(sha256sum "$skill_home" | awk '{print $1}')"
    skill_blob="$(git rev-parse "HEAD:$skill_home")"
    manifest_sha="$(sha256sum "$skill_manifest" | awk '{print $1}')"
    manifest_blob="$(git rev-parse "HEAD:$skill_manifest")"
    authority_commit="$(git rev-parse HEAD)"
    jq -e --arg sha "$skill_sha" '
      (.files | type) == "array" and
      any(.files[]; .path=="SKILL.md" and .sha256==$sha)
    ' "$skill_manifest" >/dev/null

    master_base="${display_base#audit-preview-}"
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
      if [ "$suffix" = "$folder" ]; then suffix="${folder#"campaigns/$master_base/$display_base r"}"; fi
      if [ "$suffix" != "$folder" ] && [[ "$suffix" =~ ^[0-9]+$ ]] && [ "$suffix" -gt "$max" ]; then
        max="$suffix"
      fi
    done < <( { git ls-tree -d --name-only HEAD -- campaigns/; git ls-tree -d --name-only HEAD -- "campaigns/$master_base/"; } | LC_ALL=C sort -u )

    revision=$((max + 1))
    campaign_id="$slug-r$revision"
    campaign_name="$display_base r$revision"
    campaign_root="campaigns/$master_base/$campaign_name"
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

    mkdir -p "$source_dir" "$receipts_dir" "Audit Campaign Directory/campaigns"
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
    MASTER_CHAT_URL="$MASTER_CHAT_URL" TEST_EXECUTOR_CHAT_URL="$TEST_EXECUTOR_CHAT_URL" DELIVERY_TRANSPORT="$DELIVERY_TRANSPORT" \
    SKILL_SHA="$skill_sha" SKILL_BLOB="$skill_blob" SKILL_REPO_PATH="$skill_repo_path" \
    MANIFEST_SHA="$manifest_sha" MANIFEST_BLOB="$manifest_blob" AUTHORITY_COMMIT="$authority_commit" \
    RECEIPTS_DIR="$receipts_dir" CAMPAIGN_DIRECTORY_PATH="$campaign_directory_path" \
      python3 "$ROOT/scripts/audit-source-initialization/write-phase0-receipt-v1.py"

    git add -- "$receipts_dir" "$campaign_directory_path"
    if [ "$DELIVERY_TRANSPORT" = AGENT_DELIVERY ]; then git add -- "$campaign_root/work/browser/DELIVERY_COMMAND_v1.md"; fi
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
  jq -n \
    --arg requestId "$REQUEST_ID" --arg sourceUrl "$SOURCE_URL" --argjson scanUrls "$SCAN_URLS" --arg mode "$input_mode" --arg provider "$provider" \
    --arg canonicalUrl "$canonical_url" --arg filename "$filename" --arg sha "$source_sha" \
    --argjson size "$source_size" --arg campaignId "$campaign_id" --arg generation "$generation_id" \
    --arg campaignName "$campaign_name" --arg workspace "$campaign_root" --arg sourcePath "$source_path" \
    --arg admission "$admission_commit" --arg blob "$source_blob" --arg tree "$tree_sha" \
    --arg init "$init_commit" --arg run "$GITHUB_RUN_ID" \
    --arg chat1 "$AGENT_CHAT_1_URL" --arg chat2 "$AGENT_CHAT_2_URL" \
    --arg chat3 "$AGENT_CHAT_3_URL" --arg chat4 "$AGENT_CHAT_4_URL" --arg thirdReviewer "$third_reviewer_key" --arg masterChat "$MASTER_CHAT_URL" --arg tester "$TEST_EXECUTOR_CHAT_URL" --arg backup "$BACKUP_CHAT_URL" \
    --argjson singleAgentSimulation "$SINGLE_AGENT_SIMULATION" --arg deliveryTransport "$DELIVERY_TRANSPORT" \
    '{
      schemaVersion:"curveyield-audit-source-initialization-report-v1",
      request:{
        requestId:$requestId,
        singleAgentSimulation:$singleAgentSimulation,
        deliveryTransport:$deliveryTransport,
        sourceUrl:$sourceUrl,
        scanUrls:$scanUrls,
        inputMode:$mode,
        agentChats:{
          "reviewer-1":$chat1,
          "reviewer-2":$chat2,
          ($thirdReviewer):$chat3,
          "reviewer-4":$chat4
        },
        masterChatUrl:$masterChat,
        testExecutorChatUrl:$tester,
        backupChatUrl:$backup
      },
      status:"PASS",
      source:{
        provider:$provider,inputMode:$mode,canonicalUrl:$canonicalUrl,filename:$filename,sha256:$sha,byteLength:$size,
        repository:"curveyield3/Audit-Controller",ref:"main",path:$sourcePath,
        gitBlobSha:$blob,admissionCommit:$admission,unpackedTreeSha256:$tree
      },
      campaign:{
        campaignId:$campaignId,campaignGenerationId:$generation,campaignName:$campaignName,
        workspacePath:$workspace,controllerRef:"main",initializationCommit:$init
      },
      workflowRunId:$run,completedAt:(now|todate)
    }' > /tmp/source-init-report.json

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

safe_campaign="$(printf '%s' "$campaign_id" | tr -c 'A-Za-z0-9._-' '_')"
registration_path="process/browser-agent-wake/registrations/$safe_campaign.json"
registration_api="repos/$GITHUB_REPOSITORY/contents/$registration_path"
existing_registration_payload="$(gh api "$registration_api?ref=main" 2>/dev/null || true)"
existing_registration_sha="$(printf '%s' "$existing_registration_payload" | jq -r '.sha // empty' 2>/dev/null || true)"

if [[ "$existing_registration_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s' "$existing_registration_payload" | jq -r '.content' | tr -d '\n' | base64 -d > /tmp/existing-audit-browser-registration.json
  jq \
    --arg campaignId "$campaign_id" \
    --arg chat1 "$AGENT_CHAT_1_URL" --arg chat2 "$AGENT_CHAT_2_URL" \
    --arg chat3 "$AGENT_CHAT_3_URL" --arg chat4 "$AGENT_CHAT_4_URL" --arg thirdReviewer "$third_reviewer_key" --arg master "$MASTER_CHAT_URL" --arg tester "$TEST_EXECUTOR_CHAT_URL" --arg backup "$BACKUP_CHAT_URL" \
    --argjson singleAgentSimulation "$SINGLE_AGENT_SIMULATION" --arg deliveryTransport "$DELIVERY_TRANSPORT" \
    '.singleAgentSimulation=$singleAgentSimulation
     | .schemaVersion="curveyield-browser-agent-wake-registration-v1"
     | .deliveryTransport=$deliveryTransport
     | .transportEpoch=(.transportEpoch // 0)
     | .campaignId=$campaignId
     | .agentChats={
         "reviewer-1":$chat1,
         "reviewer-2":$chat2,
         ($thirdReviewer):$chat3,
         "reviewer-4":$chat4,
         "master-reviewer":$master,
         "test-executor":$tester,
          "backup":$backup
       }
     | .backupChatUrl=$backup
     | .masterReviewer={chatUrl:$master,reasoning:"MAXIMUM",repairModel:"SOL",repairReasoning:"HIGH"}
     | .browserInteractionPolicy=(.browserInteractionPolicy // "phase1-fixed-x11-normal-chrome-no-chatgpt-page-read-v1")
     | .repair=((.repair // {}) + {enabled:true,idlePokeThreshold:(.repair.idlePokeThreshold // 3),unviewableThreshold:(.repair.unviewableThreshold // 2)})
     | .watchdog=((.watchdog // {}) + {enabled:true,idleMessage:"GET BACK TO WORK",pokeIntervalMinutes:20})
     | .updatedAt=(now|todate)' \
    /tmp/existing-audit-browser-registration.json > /tmp/audit-browser-registration.json
else
  jq -n \
    --arg campaignId "$campaign_id" \
    --arg chat1 "$AGENT_CHAT_1_URL" --arg chat2 "$AGENT_CHAT_2_URL" \
    --arg chat3 "$AGENT_CHAT_3_URL" --arg chat4 "$AGENT_CHAT_4_URL" --arg thirdReviewer "$third_reviewer_key" --arg master "$MASTER_CHAT_URL" --arg tester "$TEST_EXECUTOR_CHAT_URL" --arg backup "$BACKUP_CHAT_URL" \
    --argjson singleAgentSimulation "$SINGLE_AGENT_SIMULATION" --arg deliveryTransport "$DELIVERY_TRANSPORT" \
    '{
      schemaVersion:"curveyield-browser-agent-wake-registration-v1",
      singleAgentSimulation:$singleAgentSimulation,
      deliveryTransport:$deliveryTransport,
      transportEpoch:0,
      campaignId:$campaignId,
      mode:"resume_existing",
      chatUrl:"",
      browserRoutine:"",
      agentChats:{
        "reviewer-1":$chat1,
        "reviewer-2":$chat2,
        ($thirdReviewer):$chat3,
        "reviewer-4":$chat4,
        "master-reviewer":$master,
        "test-executor":$tester,
          "backup":$backup
      },
      backupChatUrl:$backup,
      masterReviewer:{chatUrl:$master,reasoning:"MAXIMUM",repairModel:"SOL",repairReasoning:"HIGH"},
      chatgptProject:{name:"",url:""},
      activeChat:{name:"",url:""},
      wakeMessage:"",
      thinkingEffort:"high",
      browserInteractionPolicy:"phase1-fixed-x11-normal-chrome-no-chatgpt-page-read-v1",
      activeAssignment:{},
      watchdog:{enabled:true,idleMessage:"GET BACK TO WORK",pokeIntervalMinutes:20},
      repair:{enabled:true,idlePokeThreshold:3,unviewableThreshold:2},
      updatedAt:(now|todate)
    }' > /tmp/audit-browser-registration.json
fi

registration_body="$(base64 -w0 /tmp/audit-browser-registration.json)"
if [[ "$existing_registration_sha" =~ ^[0-9a-f]{40}$ ]]; then
  gh api --method PUT "$registration_api" \
    -f message="chore(audit): refresh four reviewer chats for $campaign_id" \
    -f content="$registration_body" -f sha="$existing_registration_sha" -f branch=main >/dev/null
else
  gh api --method PUT "$registration_api" \
    -f message="chore(audit): bind four reviewer chats for $campaign_id" \
    -f content="$registration_body" -f branch=main >/dev/null
fi

gh workflow run lite-phase0-bootstrap-v1.yml --repo "$GITHUB_REPOSITORY" --ref main \
  -f campaign_id="$campaign_id" \
  -f campaign_path="$campaign_root" \
  -f audit_controller_ref=main

{
  echo '## Audit Source Initialization'
  echo
  echo "- Campaign: $campaign_name"
  echo "- Campaign ID: $campaign_id"
  echo "- Generation: $generation_id"
  echo "- Workspace: $campaign_root"
  echo '- Source archive (user ZIP or generated from verified scan pages) and unpacked source are both under campaign source/.'
  echo '- Audit-Controller ref: main'
  echo "- Single-agent simulation: $SINGLE_AGENT_SIMULATION"
  echo "- Selected delivery: $DELIVERY_TRANSPORT"
  echo '- Fully automated Phase 0: dispatched'
  echo '- Four pre-created reviewer chats are bound to reviewer-1 through reviewer-4.'
  echo '- One persistent Maximum master-review chat is bound for every reviewer-segment gate.'
  if [ "$DELIVERY_TRANSPORT" = AGENT_DELIVERY ]; then
    echo "- After P0_TO_P1, Agent Delivery publishes the instruction to $campaign_root/work/browser/DELIVERY_COMMAND_v1.md and the GitHub watchdog supervises it."
    echo '- A separately started, authorized ChatGPT Work delivery agent must poll that file and forward instructions through its connected extension.'
  else
    echo '- After validated P0_TO_P1 completion, the original browser automation opens the assigned chat and arms its original watchdog.'
  fi
} >> "$GITHUB_STEP_SUMMARY"
