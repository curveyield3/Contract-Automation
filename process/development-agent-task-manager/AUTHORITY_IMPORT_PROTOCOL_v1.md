# Development Authority Import Protocol v1

## Purpose

Preserve exact development-authority files through the already-admitted Lite Phase-0 transport pattern:

Google Drive raw object → public link-readable object → Contract-Automation import request → exact byte verification → Contract-Automation writeback → independent verification.

This extends the existing `.github/workflows/agent-zip-import-v1.yml` importer. It does not create a parallel importer or any workflow in Audit-Controller.

## Request path

Create one request JSON per imported authority object under:

`process/agent-upload/requests/<REQUEST_ID>.json`

Use schema:

`curveyield-development-authority-import/v1`

The machine schema is:

`protocol/schemas/curveyield-development-authority-import-v1.schema.json`

## Required request shape

```json
{
  "schema": "curveyield-development-authority-import/v1",
  "request_id": "stable-unique-id",
  "source": {
    "type": "google-drive",
    "url": "https://drive.google.com/file/d/<FILE_ID>/view?usp=drivesdk",
    "drive_file_id": "<FILE_ID>",
    "filename": "<EXACT_FILENAME>",
    "format": "raw",
    "sha256": "<64-hex-sha256>",
    "size": 123
  },
  "target": {
    "repository": "curveyield3/Contract-Automation",
    "branch": "main",
    "path": "process/development-agent-task-manager/<SAFE_DESTINATION>/<EXACT_FILENAME>"
  }
}
```

Use `format: "zip"` for ZIP authority objects. ZIP magic is then verified before writeback.

## Hard boundaries

- Target repository is exactly `curveyield3/Contract-Automation`.
- Target branch is exactly `main`.
- Target path must stay under `process/development-agent-task-manager/`.
- Target basename must equal the exact source filename.
- Drive file ID in the URL must equal `source.drive_file_id`.
- Source byte size and SHA-256 must match before writeback.
- The remote GitHub copy is re-read and SHA-256 checked after writeback.
- Concurrent main changes use fetch/rebase/retry; force-push is forbidden.
- Cross-repository Audit-Controller credentials are not used for development-authority imports.
- Audit-Controller receives no workflow.
- The existing audit-source fan-out mode remains unchanged.

## Completion evidence

A successful authority import writes:

`process/development-agent-task-manager/authority-import/reports/<REQUEST_ID>.json`

with schema:

`curveyield-development-authority-import-report-v1`

The report binds:

- exact Drive file ID and URL;
- exact filename;
- source SHA-256 and byte size;
- Contract-Automation destination path;
- independently re-read remote SHA-256 and byte size;
- workflow run ID;
- terminal `PASS`.

Starting the workflow is not completion. The destination bytes and completion report must both be verified on `main`.
