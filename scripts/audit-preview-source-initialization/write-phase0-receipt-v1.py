#!/usr/bin/env python3
import json, os
from pathlib import Path

e=os.environ
workspace=e["CAMPAIGN_ROOT"]
receipt_path=f"{workspace}/receipts/PHASE_00_RECEIPT_v1.json"
directory_path=e["CAMPAIGN_DIRECTORY_PATH"]
source={
  "sha256":e["SOURCE_SHA"],
  "kind":"URL_INITIALIZED_EXACT_ARCHIVE",
  "originProvider":e["SOURCE_PROVIDER"],
  "originUrl":e["SOURCE_URL_CANONICAL"],
  "uploadedFilename":e["SOURCE_FILENAME"],
  "byteLength":int(e["SOURCE_SIZE"]),
  "archiveRepository":"curveyield3/Audit-Controller",
  "archiveCommit":e["ADMISSION_COMMIT"],
  "archivePath":e["SOURCE_PATH"],
  "archiveGitBlobSha":e["SOURCE_BLOB"],
  "extractedContentPath":e["SOURCE_DIR"],
  "extractedTreeSha256":e["TREE_SHA"]
}
if e.get("SOURCE_INPUT_MODE") == "LIVE_SCAN":
  targets=json.loads(e["SCAN_TARGETS_JSON"])
  if not isinstance(targets,list) or not targets or not e.get("SCAN_MANIFEST_SHA"):
    raise ValueError("LIVE_SCAN_RECEIPT_PROVENANCE_MISSING")
  source["kind"]="EXPLORER_INITIALIZED_VERIFIED_LIVE_SNAPSHOT"
  source["inputMode"]="LIVE_SCAN"
  source["originProvider"]="etherscan-v2"
  source["originUrls"]=targets
  source["generatedArchiveFilename"]=source.pop("uploadedFilename")
  source["scanManifestPath"]=f"{e['SOURCE_DIR']}/live-scan-project/scan-source-manifest.json"
  source["scanManifestSha256"]=e["SCAN_MANIFEST_SHA"]
  source["scanTargetSetSha256"]=e["SCAN_TARGET_SET_SHA"]
else:
  source["inputMode"]="ZIP"

authority={
  "repository":"curveyield3/Audit-Controller",
  "ref":"audit-preview-v1",
  "authorityFolderPath":"Audit Skill - Audit Preview",
  "homepagePath":e["SKILL_HOME"],
  "liteSkillPath":e["SKILL_REPO_PATH"],
  "liteSkillBlobSha":e["SKILL_BLOB"],
  "liteSkillSha256":e["SKILL_SHA"],
  "manifestSha256":e["MANIFEST_SHA"],
  "manifestGitBlobSha":e["MANIFEST_BLOB"],
  "authorityCommitSha":e["AUTHORITY_COMMIT"],
  "liteRelease":e["SKILL_RELEASE"],
  "packageRevision":e["SKILL_REVISION"]
}
permit=int(e["PERMITTED_CONTRACTS"])
if permit<1:
  raise ValueError("AUDIT_PREVIEW_INVALID_PERMIT")
audit_preview={"permittedContracts":permit,"terminalPhase":4,"product":"AUDIT_PREVIEW"}

receipt={
  "schemaVersion":"curveyield-lite-phase-receipt-v1",
  "campaign":{
    "campaignId":e["CAMPAIGN_ID"],
    "sourceInitializationRequestId":e["REQUEST_ID"],
    "campaignGenerationId":e["GENERATION_ID"],
    "campaignName":e["CAMPAIGN_NAME"],
    "workspacePath":workspace,
    "campaignDirectoryEntryPath":directory_path,
    "mode":"LITE_SOLO"
  },
  "phase":{"sequence":0,"id":"phase-0","revision":1,"status":"ACTIVE"},
  "executor":{"type":"GITHUB_ACTIONS","lineage":"audit-preview-phase0","workflow":"lite-solo-phase0-bootstrap-v1.yml"},
  "authority":authority,"auditPreview":audit_preview,
  "source":source,
  "startedAt":e["CREATED_AT"],"updatedAt":e["CREATED_AT"],"sealedAt":None,
  "inputs":([{"role":"SCAN_URL_SET","urls":json.loads(e["SCAN_TARGETS_JSON"]),"sha256":e["SCAN_TARGET_SET_SHA"]},
              {"role":"GENERATED_SOURCE_ARCHIVE","path":e["SOURCE_PATH"],"sha256":e["SOURCE_SHA"]},
              {"role":"FROZEN_DEPLOYED_TARGETS","path":source["scanManifestPath"],"sha256":e["SCAN_MANIFEST_SHA"]}]
              if e.get("SOURCE_INPUT_MODE")=="LIVE_SCAN" else
              [{"role":"SOURCE_ZIP","path":e["SOURCE_PATH"],"sha256":e["SOURCE_SHA"]}]),
  "evidence":[],"outputs":[],
  "globalControls":{"securityTraceabilityGraph":None,"carriedForwardObligationLedger":None,"evidenceInvalidationMatrix":None,"sourceIntelligenceBundle":None},
  "obligations":{"due":[],"created":[],"closed":[],"carriedForward":[]},
  "invalidation":{"status":"NO_MATERIAL_CHANGE","events":[]},
  "automation":[],
  "validation":{"status":"PENDING","validatedAt":None,"failures":[]},
  "handoff":{"required":False,"boundary":None,"incomingReviewer":None,"assignedWork":None,"nextPhaseSequence":1,"sameReviewer":True,"status":"NOT_APPLICABLE"},
  "errors":[]
}
directory={
  "schemaVersion":"curveyield-audit-campaign-directory-entry-v1",
  "campaignId":e["CAMPAIGN_ID"],"campaignGenerationId":e["GENERATION_ID"],"campaignName":e["CAMPAIGN_NAME"],
  "workspacePath":workspace,"mode":"LITE_SOLO","product":"AUDIT_PREVIEW","auditPreview":audit_preview,"sourceSha256":e["SOURCE_SHA"],
  "sourceInitializationRequestId":e["REQUEST_ID"],
  "deliveryTransport":"DIRECT",
  "transportEpoch":0,
  "agentModel":"PARALLEL_WORKER_UNITS",
  "executionModel":"PARALLEL_WORKER_UNITS",
  "authorityRelease":e["SKILL_RELEASE"],
  "authorityDigest":e["MANIFEST_SHA"],
  "agent":{"actorId":"lite-solo-agent"},
  "currentReceiptPath":receipt_path,"currentPhaseSequence":0,"currentReviewer":"phase0-automation",
  "status":"ACTIVE","updatedAt":e["CREATED_AT"]
}
rp=Path(e["RECEIPTS_DIR"]); rp.mkdir(parents=True,exist_ok=True)
(rp/"PHASE_00_RECEIPT_v1.json").write_text(json.dumps(receipt,indent=2)+"\n")
dp=Path(directory_path); dp.parent.mkdir(parents=True,exist_ok=True); dp.write_text(json.dumps(directory,indent=2)+"\n")
