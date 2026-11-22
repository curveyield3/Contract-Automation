#!/usr/bin/env python3
"""Trusted, source-bound optional security-pipeline status and warning writer.

Only Python's standard library. Never execute the admitted source archive.
This script is not an authority provider and cannot approve an unsigned request.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

WARNING_SCHEMA = "curveyield-security-pipeline-warning-v1"
STAGE_SCHEMA = "curveyield-security-pipeline-stage-v1"
MODES = ("admit-extended", "summarize-job", "verify-stage", "emit-warning",
         "finalize-stage", "verify-toolkit-component")
MAX_JSON = 8 * 1024 * 1024
SHA256 = re.compile(r"^[a-f0-9]{64}$")


def sha256_bytes(raw):
    return hashlib.sha256(raw).hexdigest()


def bounded_file(file_path, root=None, max_bytes=MAX_JSON):
    path = Path(file_path)
    if path.is_symlink():
        raise ValueError("SYMLINK_NOT_PERMITTED:" + str(path))
    if root is not None:
        parent = Path(root).resolve()
        if not path.resolve().is_relative_to(parent):
            raise ValueError("PATH_OUTSIDE_BOUND_ROOT:" + str(path))
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
        raise ValueError("FILE_NOT_REGULAR_OR_TOO_LARGE:" + str(path))
    return path.read_bytes()


def strict_json(path, max_bytes=MAX_JSON):
    def distinct(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("DUPLICATE_JSON_KEY:" + str(key))
            result[key] = value
        return result
    return json.loads(bounded_file(path, max_bytes=max_bytes), object_pairs_hook=distinct)


def parse_args_strict(argv):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    for name in ("mode", "job", "stage", "run-id", "run-attempt", "report-root"):
        parser.add_argument("--" + name, required=True)
    for name in ("request-file", "source-zip", "toolchain-plan", "github-output",
                 "input-root", "output-root", "native-result", "native-exit-code",
                 "native-outcome", "summary-outcome", "inventory-outcome",
                 "run-identity", "component", "profile", "warning-input",
                 "toolkit-root", "source-manifest"):
        parser.add_argument("--" + name)
    args = parser.parse_args(argv)
    if args.mode not in MODES:
        parser.error("mode must be one of " + ",".join(MODES))
    # argparse normally permits last-one-wins. For provenance this is not allowed.
    observed = [x for x in argv if x.startswith("--") and "=" not in x]
    observed += [x.split("=", 1)[0] for x in argv if x.startswith("--") and "=" in x]
    if len(observed) != len(set(observed)):
        parser.error("duplicate singleton option")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", args.job):
        parser.error("invalid --job")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,40}", args.stage):
        parser.error("invalid --stage")
    if not args.run_id.isdigit() or not args.run_attempt.isdigit() or int(args.run_attempt) < 1:
        parser.error("invalid run ID/attempt")
    return args


def parse_run_context(args):
    environ_id = os.environ.get("GITHUB_RUN_ID")
    environ_attempt = os.environ.get("GITHUB_RUN_ATTEMPT")
    if environ_id and environ_id != args.run_id:
        raise ValueError("RUN_ID_ENV_MISMATCH")
    if environ_attempt and environ_attempt != args.run_attempt:
        raise ValueError("RUN_ATTEMPT_ENV_MISMATCH")
    return {"runId": args.run_id, "runAttempt": int(args.run_attempt),
            "workflowHeadSha": os.environ.get("GITHUB_SHA") or None,
            "repository": os.environ.get("GITHUB_REPOSITORY") or None}


def _utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _safe(value, limit=320):
    if value is None:
        return "null"
    if not isinstance(value, str):
        value = json.dumps(value, sort_keys=True, ensure_ascii=True)
    value = "".join(ch if 32 <= ord(ch) < 127 else "?" for ch in value)
    return value[:limit] + ("..." if len(value) > limit else "")


def make_warning(ctx, args, code, check_id, field, expected, observed,
                 impact, correction, evidence=None, component=None,
                 operation=None, observation_failure=None, native_exit=None):
    source = {"value": _safe(expected, 320),
              "source": "verified original input or trusted workflow configuration"}
    evidence_sha = sha256_bytes(json.dumps(observed, sort_keys=True, default=str).encode())
    seen = {"value": _safe(observed, 320),
            "source": _safe(evidence or "current trusted job-local observation", 220)}
    identity = {"run": ctx["runId"], "attempt": ctx["runAttempt"],
                "stage": args.stage, "check": check_id, "field": field,
                "evidenceSha256": evidence_sha}
    return {
        "schemaVersion": WARNING_SCHEMA,
        "warningId": sha256_bytes(json.dumps(identity, sort_keys=True).encode()),
        "code": _safe(code, 90), "stage": args.stage, "operation": _safe(operation or args.job, 90),
        "componentId": _safe(component, 90) if component else None,
        "targetId": None, "checkId": _safe(check_id, 100),
        "configurationField": _safe(field, 240), "expected": source, "observed": seen,
        "observationFailure": observation_failure,
        "mismatch": "{}: expected {}; observed {}".format(field, _safe(expected), _safe(observed)),
        "impact": _safe(impact, 420), "requiredCorrection": _safe(correction, 420),
        "nativeEvidenceRefs": [evidence] if evidence else [],
        "runIdentitySha256": None, "runId": ctx["runId"], "runAttempt": ctx["runAttempt"],
        "status": "WARNING", "affectedOperationStatus": "NOT_EXECUTED",
        "recordedAtUTC": _utc(), "severity": "CONFIGURATION",
        "redactions": [], "nativeExitCode": native_exit,
        "sourceArtifactName": None,
        "sourceArchiveSha256": None, "workflowHeadSha": ctx["workflowHeadSha"],
        "jobId": args.job, "fieldPath": field, "correction": correction,
        "operationDisposition": "NOT_EXECUTED", "privacyClass": "PUBLIC_SAFE"
    }


def safe_github_annotation(record):
    def esc(value):
        return _safe(value, 450).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A").replace(":", "%3A").replace(",", "%2C")
    title = esc(record["code"])
    msg = esc(record["mismatch"] + "; correction: " + record["requiredCorrection"])
    print("::warning title={}::{}".format(title, msg), flush=True)


def append_github_step_summary(record):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as out:
        out.write("| Code | Stage | Field | Expected | Observed | Evidence | Impact | Correction |\n")
        out.write("|---|---|---|---|---|---|---|---|\n")
        vals = (record["code"], record["stage"], record["configurationField"],
                record["expected"]["value"], record["observed"]["value"],
                record["nativeEvidenceRefs"], record["impact"], record["requiredCorrection"])
        out.write("| " + " | ".join(_safe(v, 160).replace("|", "\\|") for v in vals) + " |\n")


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def record_warning_jsonl(root, warning):
    with open(root / "SECURITY_PIPELINE_WARNINGS_v1.jsonl", "a", encoding="utf-8") as out:
        out.write(json.dumps(warning, sort_keys=True, separators=(",", ":")) + "\n")
    safe_github_annotation(warning)
    append_github_step_summary(warning)


def write_stage_disposition(root, args, ctx, status, warnings, extra=None):
    rec = {"schemaVersion": STAGE_SCHEMA, "stage": args.stage, "jobId": args.job,
           "status": status, "attempted": 0, "completed": 0, "notExecuted": 1 if status == "NOT_EXECUTED" else 0,
           "nativeFailed": 0, "unsupported": 0, "sourceBound": False,
           "originalNativeExit": None, "originalNativeEvidenceSha256": None,
           "warnings": [x["warningId"] for x in warnings], "dependencyFacts": {},
           "sourceIdentity": None, "jobRunId": ctx["runId"],
           "jobRunAttempt": ctx["runAttempt"], "workflowHeadSha": ctx["workflowHeadSha"]}
    rec.update(extra or {})
    _write_json(root / ("PIPELINE_STAGE_" + args.stage + "_v1.json"), rec)


def _source_binding(request, zip_path, plan_path):
    source = request.get("source") if isinstance(request, dict) else None
    source = source if isinstance(source, dict) else {}
    expected = source.get("archiveSha256")
    observed = sha256_bytes(bounded_file(zip_path, max_bytes=16 * 1024 * 1024))
    plan = strict_json(plan_path)
    plan_sha = plan.get("sourceZipSha256")
    valid = isinstance(expected, str) and bool(SHA256.fullmatch(expected)) and observed == expected and plan_sha == expected
    return valid, expected, observed, plan_sha


def assess_extended_authority(profile, source_sha):
    # No independently qualified extended-standalone authority source has been
    # exposed through this workflow. A request-supplied digest is never approval.
    if not isinstance(profile, dict):
        return False, "qualificationProfile is absent/not an object"
    required = {"schemaVersion": str, "profileId": str, "authorizationRefSha256": str,
                "requestedOperations": list, "allowedChainIds": list}
    for key, typ in required.items():
        if not isinstance(profile.get(key), typ):
            return False, "qualificationProfile." + key + " has invalid/missing type"
    if profile["schemaVersion"] != "curveyield-security-pipeline-qualification-profile-v1":
        return False, "qualificationProfile.schemaVersion does not match supported schema"
    if not all(isinstance(x, str) for x in profile["requestedOperations"]):
        return False, "qualificationProfile.requestedOperations must contain strings"
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in profile["allowedChainIds"]):
        return False, "qualificationProfile.allowedChainIds must contain integer chain IDs"
    return False, "no independently accepted issuer/ref, signed scope and source-bound authorization provider available"


def _read_optional_json(path):
    if not path:
        return None, "argument not supplied"
    try:
        return strict_json(path), None
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return None, "{}:{}".format(type(error).__name__, _safe(str(error)))


def _finish(root, args, ctx, warnings, status, extra=None):
    ledger = root / "SECURITY_PIPELINE_WARNINGS_v1.jsonl"
    previous = []
    if ledger.exists():
        for line in ledger.read_text(encoding="utf-8").splitlines():
            if line.strip():
                old = json.loads(line)
                if old.get("runId") != ctx["runId"] or old.get("runAttempt") != ctx["runAttempt"]:
                    raise ValueError("EXISTING_LEDGER_RUN_IDENTITY_MISMATCH")
                previous.append(old)
    previous_ids = {w["warningId"] for w in previous}
    new = [w for w in warnings if w["warningId"] not in previous_ids]
    for w in new:
        record_warning_jsonl(root, w)
    total = previous + new
    if not total:
        ledger.touch()
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as out:
                out.write("Security pipeline {} / {}: zero configuration warnings recorded.\n".format(args.job, args.stage))
    prior_stage_path = root / ("PIPELINE_STAGE_" + args.stage + "_v1.json")
    prior_stage, prior_err = _read_optional_json(str(prior_stage_path))
    if isinstance(prior_stage, dict) and not prior_err:
        if (prior_stage.get("jobRunId") != ctx["runId"] or
                prior_stage.get("jobRunAttempt") != ctx["runAttempt"]):
            raise ValueError("EXISTING_STAGE_RUN_IDENTITY_MISMATCH")
        if args.mode == "summarize-job" and args.stage == "ADMIT" and not new:
            status = prior_stage["status"]
            extra = {**{key: prior_stage.get(key) for key in (
                "sourceBound", "sourceIdentity", "dependencyFacts")}, **(extra or {})}
    write_stage_disposition(root, args, ctx, status, total, extra)
    (root / "SECURITY_PIPELINE_STAGE_SUMMARY_v1.md").write_text(
        "# Security pipeline {} / {}\n\nStatus: **{}**\nWarnings: **{}**\nRun: {} attempt {}\n".format(
            args.job, args.stage, status, len(total), ctx["runId"], ctx["runAttempt"]), encoding="utf-8")


def admit_extended(root, args, ctx):
    if not all((args.request_file, args.source_zip, args.toolchain_plan, args.github_output)):
        raise ValueError("admit-extended requires request-file/source-zip/toolchain-plan/github-output")
    request, err = _read_optional_json(args.request_file)
    warnings = []
    requested = isinstance(request, dict) and request.get("extendedSecurityPipeline") is True
    authorized = False
    disposition = "OPTED_OUT"
    source_sha = None
    if err:
        warnings.append(make_warning(ctx, args, "ADMIT.REQUEST_UNAVAILABLE", "ADMIT.REQUEST", args.request_file,
            "valid original request JSON", err, "extended mode not authorized",
            "Restore the admitted exact request file", args.request_file, observation_failure=err))
        disposition = "REQUEST_UNAVAILABLE"
    elif request.get("extendedSecurityPipeline", False) not in (True, False):
        warnings.append(make_warning(ctx, args, "ADMIT.OPT_IN_TYPE", "ADMIT.OPT_IN",
            "extendedSecurityPipeline", "literal JSON boolean", request.get("extendedSecurityPipeline"),
            "extended mode not authorized", "Set explicit true or false in a separately approved request"))
        disposition = "INVALID_OPT_IN_TYPE"
    try:
        valid, expected, observed, plan_sha = _source_binding(request or {}, args.source_zip, args.toolchain_plan)
        source_sha = observed
    except (OSError, ValueError, json.JSONDecodeError) as error:
        valid, expected, observed, plan_sha = False, None, str(error), None
    if not valid:
        warnings.append(make_warning(ctx, args, "ADMIT.SOURCE_IDENTITY", "ADMIT.SOURCE_IDENTITY",
            "source.archiveSha256 / toolchainPlan.sourceZipSha256", expected,
            {"actualZipSha256": observed, "planSha256": plan_sha},
            "optional source-dependent work NOT_EXECUTED; original admission remains authoritative",
            "Restore exact SHA-verified source archive and matching original source toolchain plan",
            args.toolchain_plan, observation_failure=None if SHA256.fullmatch(str(observed)) else str(observed)))
        disposition = "SOURCE_IDENTITY_INVALID"
    elif requested:
        authorized, reason = assess_extended_authority(request.get("qualificationProfile"), source_sha)
        if not authorized:
            warnings.append(make_warning(ctx, args, "ADMIT.AUTHORITY_REFERENCE_UNAVAILABLE", "ADMIT.AUTHORITY",
                "qualificationProfile.acceptedAuthority", "independent accepted issuer and source-bound approval",
                reason, "unsafe optional operations remain NOT_EXECUTED; Phase 0 source collection continues",
                "Integrate and verify an existing approved authority source before enabling requested capabilities",
                "security-intelligence-phase0/requests/active-request.json"))
            disposition = "AUTHORITY_NOT_VERIFIED"
        else:
            disposition = "AUTHORIZED"
    if not requested and not warnings:
        disposition = "OPTED_OUT"
    # Disposition is non-secret and cannot authorize operations on its own.
    payload = {"schemaVersion": "curveyield-security-pipeline-extended-disposition-v1",
               "requested": requested, "approved": authorized and valid,
               "sourceArchiveSha256": source_sha, "authorizationRefSha256": None,
               "authorizedCapabilities": [], "requestedCapabilities":
               [x for x in (request or {}).get("qualificationProfile", {}).get("requestedOperations", [])
                if isinstance(x, str)][:40] if isinstance((request or {}).get("qualificationProfile"), dict) else [],
               "warningIds": [w["warningId"] for w in warnings], "disposition": disposition,
               "runId": ctx["runId"], "runAttempt": ctx["runAttempt"],
               "workflowHeadSha": ctx["workflowHeadSha"]}
    _write_json(Path(args.source_zip).parent / "extended-mode-disposition.json", payload)
    # Existing admission warning artifact carries a redacted digest-only copy.
    # Downstream G2A can verify same-run provenance without downloading source.zip.
    _write_json(root / "EXTENDED_MODE_DISPOSITION_v1.json", payload)
    with open(args.github_output, "a", encoding="utf-8") as out:
        out.write("extended_requested={}\nextended_approved={}\n".format(
            str(requested).lower(), str(payload["approved"]).lower()))
    _finish(root, args, ctx, warnings, "NOT_EXECUTED" if warnings else "NOT_REQUIRED",
            {"sourceBound": valid, "sourceIdentity": {"archiveSha256": source_sha},
             "dependencyFacts": {"extendedDisposition": disposition}})


def summarize_job(root, args, ctx):
    warnings = []
    if args.stage == "G2A":
        target_root = Path(args.input_root) if args.input_root else None
        records = []
        expected_source = None
        if args.source_manifest:
            manifest, failure = _read_optional_json(args.source_manifest)
            if (failure or not isinstance(manifest, dict) or
                manifest.get("sourceAdmissionVerified") is not True):
                warnings.append(make_warning(ctx, args, "G2A.SOURCE_MANIFEST_UNVERIFIED",
                    "G2A.SOURCE", "PREFLIGHT_MANIFEST_v1.json.sourceAdmissionVerified",
                    True, failure or (manifest or {}).get("sourceAdmissionVerified"),
                    "model source facts are not admitted", "Restore original exact current-run source manifest",
                    args.source_manifest, observation_failure=failure))
            else:
                expected_source = (manifest.get("source") or {}).get("expectedSha256")
                if not SHA256.fullmatch(str(expected_source or "")) or (
                    (manifest.get("source") or {}).get("observedSha256") != expected_source):
                    warnings.append(make_warning(ctx, args, "G2A.SOURCE_DIGEST_MISMATCH",
                        "G2A.SOURCE_SHA", "PREFLIGHT_MANIFEST_v1.json.source",
                        "matching expected/observed SHA-256", (manifest.get("source") or {}),
                        "MiMo response is not attributable to admitted bytes",
                        "Re-admit the exact original source archive and source manifest",
                        args.source_manifest))
        else:
            warnings.append(make_warning(ctx, args, "G2A.SOURCE_MANIFEST_MISSING",
                "G2A.SOURCE", "--source-manifest", "exact original collector manifest",
                None, "model source identity unverified",
                "Provide the original preflight manifest from this same run"))
        entries = []
        if target_root and target_root.is_dir():
            entries = sorted(p for p in target_root.iterdir()
                             if p.is_dir() and re.fullmatch(r"TARGET-[0-9a-f]{32}", p.name))
        if not entries:
            warnings.append(make_warning(ctx, args, "G2A.NO_TARGET_RECORDS",
                "G2A.TARGETS", "mimo_configure/native-targets",
                "one same-run typed record per compiled target", None,
                "native MiMo coverage is NOT_EXECUTED", "Repair source-bound target enumeration or artifact download"))
        for item in entries:
            state_path = item / "MIMO_STAGE_STATE_v1.json"
            record, error = _read_optional_json(str(state_path))
            if error or not isinstance(record, dict):
                warnings.append(make_warning(ctx, args, "G2A.TARGET_STATE_MISSING",
                    "G2A.STATE." + item.name, str(state_path),
                    "typed current-run model state", error or "not object",
                    "target model round unverified", "Write and retain original G2A target state",
                    str(state_path), observation_failure=error))
                continue
            if (record.get("schemaVersion") != "curveyield-mimo-stage-state-v1" or
                record.get("targetId") != item.name or
                str(record.get("runId")) != ctx["runId"] or
                str(record.get("runAttempt")) != str(ctx["runAttempt"]) or
                record.get("workflowHeadSha") != ctx["workflowHeadSha"] or
                record.get("sourceArchiveSha256") != expected_source):
                warnings.append(make_warning(ctx, args, "G2A.TARGET_STATE_IDENTITY",
                    "G2A.STATE_ID." + item.name,
                    "mimoTargets[{}].runIdentity/sourceArchiveSha256".format(item.name),
                    {"targetId": item.name, "runId": ctx["runId"],
                     "runAttempt": ctx["runAttempt"], "sourceArchiveSha256": expected_source},
                    {"targetId": record.get("targetId"), "runId": record.get("runId"),
                     "runAttempt": record.get("runAttempt"),
                     "sourceArchiveSha256": record.get("sourceArchiveSha256")},
                    "target observations cannot be counted as valid evidence",
                    "Regenerate from the exact original source and trusted run identity",
                    str(state_path)))
                continue
            records.append({"targetId": item.name,
                            "status": record.get("status"),
                            "nativeAttempted": record.get("nativeAttempted") is True,
                            "modelReplySha256": record.get("modelReplySha256"),
                            "acceptedConfigSha256": record.get("acceptedConfigSha256")})
            for issue in record.get("warnings", []):
                if not isinstance(issue, dict):
                    continue
                warnings.append(make_warning(ctx, args,
                    str(issue.get("code") or "G2A.TARGET_WARNING"),
                    "G2A.ROUND." + item.name,
                    "mimoTargets[{}].{}".format(item.name, issue.get("configurationField") or "configuration"),
                    issue.get("expected"), issue.get("observed"),
                    str(issue.get("impact") or "model stage incomplete"),
                    str(issue.get("requiredCorrection") or "repair exact source-bound target issue"),
                    str(state_path)))
        # Model proposals require a separate independent validator and an
        # accepted configuration receipt before any stage can claim completion.
        native_attempted = sum(1 for r in records if r["nativeAttempted"])
        completed = sum(1 for r in records if r["acceptedConfigSha256"])
        disposition = "PARTIAL" if records else "NOT_EXECUTED"
        _finish(root, args, ctx, warnings, disposition, {
            "attempted": native_attempted, "completed": completed,
            "notExecuted": max(0, len(entries) - completed),
            "sourceBound": bool(expected_source),
            "sourceIdentity": {"archiveSha256": expected_source},
            "dependencyFacts": {"targetCount": len(entries),
                "validStateCount": len(records),
                "sourceArchiveSha256": expected_source,
                "perTarget": records,
                "continuationQualified": False}})
        return
    if args.stage == "G2T":
        components = ("foundry-node", "source-compilers", "slither-storage", "medusa",
                      "wake", "mythril", "certora-prover", "autoprover",
                      "mimo-runtime", "mimo-weights")
        statuses = {}
        for component in components:
            artifact_name = "security-pipeline-toolkit-component-{}-{}-{}".format(
                component, ctx["runId"], ctx["runAttempt"])
            filepath = Path(args.input_root or "") / artifact_name / "TOOLKIT_CACHE_COMPONENT_METRICS_v1.json"
            data, error = _read_optional_json(str(filepath) if args.input_root else None)
            if error or not isinstance(data, dict):
                statuses[component] = "NOT_EXECUTED"
                warnings.append(make_warning(ctx, args, "TOOLKIT.COMPONENT_METADATA_MISSING",
                    "G2T.METADATA." + component,
                    artifact_name + "/TOOLKIT_CACHE_COMPONENT_METRICS_v1.json",
                    "same-run source-bound component metadata", error or "not object",
                    "toolkit readiness is unverified",
                    "Restore the named component's verified same-run metadata artifact",
                    str(filepath), component=component, observation_failure=error))
                continue
            if (data.get("componentId") != component or
                str(data.get("runId")) != ctx["runId"] or
                str(data.get("runAttempt")) != str(ctx["runAttempt"]) or
                data.get("workflowHeadSha") != ctx["workflowHeadSha"]):
                statuses[component] = "UNVERIFIED"
                warnings.append(make_warning(ctx, args, "TOOLKIT.COMPONENT_METADATA_IDENTITY",
                    "G2T.IDENTITY." + component, artifact_name + ".runIdentity",
                    {"runId": ctx["runId"], "runAttempt": ctx["runAttempt"],
                     "head": ctx["workflowHeadSha"]},
                    {"runId": data.get("runId"), "runAttempt": data.get("runAttempt"),
                     "head": data.get("workflowHeadSha")},
                    "component metadata cannot establish readiness",
                    "Use component metadata from this exact GitHub run/attempt and checkout",
                    str(filepath), component=component))
                continue
            state = str(data.get("status") or "UNVERIFIED")
            statuses[component] = state
            if data.get("usableForExecution") is not True and state != "NOT_REQUIRED":
                warnings.append(make_warning(ctx, args, "TOOLKIT.COMPONENT_UNVERIFIED",
                    "G2T.READINESS." + component,
                    "toolkitComponents[{}].usableForExecution".format(component),
                    "verified original binary and current approved pin",
                    {"status": state, "pinQualified": data.get("pinQualified"),
                     "expectedBinarySha256": data.get("expectedBinarySha256")},
                    "native operations requiring this component remain NOT_EXECUTED",
                    "Qualify and attest the named current component's original bytes and ABI",
                    str(filepath), component=component))
        status = "COMPLETE" if all(x in ("RESTORED_VERIFIED", "INSTALLED_VERIFIED", "NOT_REQUIRED")
                                   for x in statuses.values()) else "PARTIAL"
        _finish(root, args, ctx, warnings, status,
                {"attempted": len(components), "completed": len(components) - len(warnings),
                 "notExecuted": len(warnings), "dependencyFacts": {"componentStatuses": statuses}})
        return
    outcome_pairs = (("native", args.native_outcome), ("summary", args.summary_outcome),
                     ("inventory", args.inventory_outcome))
    for label, actual in outcome_pairs:
        if actual is not None and actual != "success":
            warnings.append(make_warning(ctx, args, "COLLECT.STEP_NOT_SUCCESS", "COLLECT." + label.upper(),
                "steps." + label + ".outcome", "success", actual,
                "affected original collection observation unavailable or partial",
                "Inspect the named GitHub Actions step and original job log"))
    manifest = Path(args.input_root or "") / "PREFLIGHT_MANIFEST_v1.json"
    data, err = _read_optional_json(str(manifest) if args.input_root else None)
    if args.stage == "COLLECT" and err:
        warnings.append(make_warning(ctx, args, "COLLECT.MANIFEST_UNAVAILABLE", "COLLECT.MANIFEST",
            str(manifest), "source-bound PREFLIGHT_MANIFEST_v1.json", err,
            "collection scope cannot be established", "Restore the existing collector and summary output",
            str(manifest), observation_failure=err))
    elif args.stage == "COLLECT" and data:
        facts = data.get("machineCoverageReasons")
        if data.get("status") != "COLLECTED" or data.get("machineCoverageReadyForGateReview") is not True:
            warnings.append(make_warning(ctx, args, "COLLECT.COVERAGE_PARTIAL", "COLLECT.COVERAGE",
                "PREFLIGHT_MANIFEST_v1.json.machineCoverageReadyForGateReview",
                True, {"status": data.get("status"), "machineCoverageReadyForGateReview":
                       data.get("machineCoverageReadyForGateReview"), "reasons": facts},
                "no full static coverage claim", "Inspect the named missing source/ABI/AST/compiler coverage in the original preflight artifact",
                str(manifest)))
    status = "PARTIAL" if warnings else ("COMPLETE" if data else "UNVERIFIED")
    _finish(root, args, ctx, warnings, status, {"sourceBound": bool(data and data.get("sourceAdmissionVerified")),
         "sourceIdentity": data.get("source") if data else None,
         "dependencyFacts": {"nativeOutcome": args.native_outcome, "summaryOutcome": args.summary_outcome,
                             "inventoryOutcome": args.inventory_outcome}})


def verify_stage(root, args, ctx):
    data, err = _read_optional_json(args.native_result)
    warnings = []
    if err or not isinstance(data, dict):
        warnings.append(make_warning(ctx, args, "STAGE.NATIVE_RESULT_UNAVAILABLE", "STAGE.NATIVE",
            "nativeResult", "original observed native result JSON", err or "not a JSON object",
            "native operation not claimed completed", "Provide same-run source-bound native evidence",
            args.native_result, observation_failure=err))
        _finish(root, args, ctx, warnings, "NOT_EXECUTED",
                {"dependencyFacts": {"nativeResultPresent": False}})
        return
    if data.get("schemaVersion") == "curveyield-security-pipeline-config-result-v1" and data.get("mode") == "enumerate-targets":
        bound = data.get("sourceBound") is True and (
            str(data.get("runId")) == ctx["runId"] and
            str(data.get("runAttempt")) == str(ctx["runAttempt"]))
        target, target_error = _read_optional_json(str(
            Path(args.input_root) / "SECURITY_TARGET_PLAN_v1.json") if args.input_root else None)
        manifest_bound = bool(bound and isinstance(target, dict) and
                              target.get("sourceBound") is True)
        counts = target.get("census") if isinstance(target, dict) else {}
        counts = counts if isinstance(counts, dict) else {}
        for issue in data.get("issues", []):
            if not isinstance(issue, dict):
                continue
            warnings.append(make_warning(ctx, args,
                str(issue.get("code") or "CONFIG.ISSUE_UNCLASSIFIED"),
                str(issue.get("code") or "CONFIG.ISSUE_UNCLASSIFIED"),
                str(issue.get("fieldPath") or "config.issue"),
                issue.get("expected"), issue.get("observed"),
                str(issue.get("impact") or "source-bound configuration partial"),
                str(issue.get("correction") or "inspect original source evidence"),
                args.native_result))
        if not manifest_bound:
            warnings.append(make_warning(ctx, args, "CONFIG.TARGET_PLAN_NOT_BOUND",
                "G0.SOURCE_BOUND", "SECURITY_TARGET_PLAN_v1.json.sourceBound",
                True, {"resultSourceBound": bound, "planPresent": isinstance(target, dict),
                       "planError": target_error},
                "Source-derived targets cannot be used as native executable authority",
                "Restore the original same-run identity and exact indexed preflight evidence",
                args.native_result))
        status0 = "COMPLETE" if manifest_bound else "PARTIAL"
        status1 = "COMPLETE" if manifest_bound and counts.get("compiledTargets", 0) > 0 else "PARTIAL"
        status2 = ("COMPLETE" if manifest_bound and
                   data.get("status") == "SOURCE_BOUND" and
                   len(data.get("issues", [])) == 0 else "PARTIAL")
        for gate, state in (("G0", status0), ("G1", status1), ("G2", status2)):
            record_args = argparse.Namespace(**vars(args))
            record_args.stage = gate
            fact = {"sourceBound": manifest_bound,
                    "sourceIdentity": {"archiveSha256": target.get("sourceArchiveSha256")}
                        if isinstance(target, dict) else None,
                    "attempted": 1, "completed": 1 if state == "COMPLETE" else 0,
                    "notExecuted": 0 if state == "COMPLETE" else 1,
                    "dependencyFacts": {"targetCensus": counts,
                                        "sourceManifestVerified": manifest_bound,
                                        "targetPlanPath": "SECURITY_TARGET_PLAN_v1.json"}}
            if gate == "G0":
                _finish(root, record_args, ctx, warnings, state, fact)
            else:
                write_stage_disposition(root, record_args, ctx, state, warnings, fact)
        return
    expected_modes = {"G2B": ("fork-plan", "FORK_EXECUTION_PLAN_v1.json",
                             "curveyield-fork-execution-plan-v1"),
                      "G2C": ("storage-plan", "FORK_STORAGE_QUERY_PLAN_v1.json",
                             "curveyield-fork-storage-query-plan-v1"),
                      "G2D": ("medusa-config", "MEDUSA_ELIGIBILITY_v1.json",
                             "curveyield-medusa-eligibility-v1")}
    if args.stage in expected_modes:
        expected_mode, filename, expected_schema = expected_modes[args.stage]
        named = Path(args.input_root or "") / filename
        doc, failure = _read_optional_json(str(named) if args.input_root else None)
        matching = (data.get("schemaVersion") == "curveyield-security-pipeline-config-result-v1" and
                    data.get("mode") == expected_mode and
                    str(data.get("runId")) == ctx["runId"] and
                    str(data.get("runAttempt")) == str(ctx["runAttempt"]) and
                    isinstance(doc, dict) and doc.get("schemaVersion") == expected_schema and
                    doc.get("sourceBound") == data.get("sourceBound"))
        if not matching:
            warnings.append(make_warning(ctx, args, "CONFIG.STAGE_NATIVE_DATA_UNVERIFIED",
                args.stage + ".SOURCE_BINDING", filename + ".schemaVersion/sourceBound",
                {"schemaVersion": expected_schema, "sameRun": True,
                 "sourceBound": data.get("sourceBound")},
                {"actualSchema": doc.get("schemaVersion") if isinstance(doc, dict) else None,
                 "actualSourceBound": doc.get("sourceBound") if isinstance(doc, dict) else None,
                 "failure": failure},
                "dependent native execution NOT_EXECUTED",
                "Recreate the exact original source-bound per-stage plan from this run",
                str(named), observation_failure=failure))
        for issue in data.get("issues", []):
            if not isinstance(issue, dict):
                continue
            warnings.append(make_warning(ctx, args,
                str(issue.get("code") or "CONFIG.STAGE_ISSUE"),
                args.stage + ".REQUIREMENT",
                str(issue.get("fieldPath") or filename),
                issue.get("expected"), issue.get("observed"),
                str(issue.get("impact") or "native prerequisite unavailable"),
                str(issue.get("correction") or "inspect original planned prerequisite"),
                args.native_result))
        # A genuine C2 capture, live storage observation, or native Medusa
        # result is not established by a compiler-derived plan.
        _finish(root, args, ctx, warnings, "NOT_EXECUTED", {
            "attempted": 0, "completed": 0, "notExecuted": 1,
            "sourceBound": bool(matching and doc.get("sourceBound") is True),
            "sourceIdentity": {"archiveSha256": doc.get("sourceArchiveSha256") or
                               doc.get("originalSourceArchiveSha256")}
                if matching else None,
            "dependencyFacts": {"planType": filename, "nativeNotExecuted": True,
                                "originalNativeEvidenceSha256": None,
                                "exactIssueCount": len(warnings)}})
        return
    if args.stage in ("G3", "G4", "G5", "G6", "G7"):
        programs = {
            "G3": ("wake", "wake_analyze"),
            "G4": ("mythril", "mythril_analyze"),
            "G5": ("certora-prover", "prover_qualify"),
            "G6": ("mimo-provider", "mimo_provider_qualify"),
            "G7": ("autoprover", "autoprover_run")
        }
        expected_program, expected_job = programs[args.stage]
        name = "NATIVE_ANALYZER_ELIGIBILITY_v1.json"
        source = Path(args.input_root or "") / name
        record, absent = _read_optional_json(str(source) if args.input_root else None)
        valid = bool(
            data.get("schemaVersion") == "curveyield-security-pipeline-config-result-v1" and
            data.get("mode") == "native-analyzer-eligibility" and
            data.get("status") == "NOT_EXECUTED" and
            str(data.get("runId")) == ctx["runId"] and
            str(data.get("runAttempt")) == str(ctx["runAttempt"]) and
            expected_job == args.job and
            isinstance(record, dict) and
            record.get("schemaVersion") == "curveyield-security-native-analyzer-eligibility-v1" and
            record.get("gate") == args.stage and
            record.get("analyzer") == expected_program and
            record.get("nativeCommandsExecuted") == 0 and
            record.get("status") == "NOT_EXECUTED" and
            record.get("sourceBound") == data.get("sourceBound") and
            str((record.get("runIdentity") or {}).get("runId")) == ctx["runId"] and
            str((record.get("runIdentity") or {}).get("runAttempt")) == str(ctx["runAttempt"]) and
            (record.get("runIdentity") or {}).get("workflowHeadSha") == ctx["workflowHeadSha"]
        )
        if not valid:
            warnings.append(make_warning(
                ctx, args, "NATIVE.ELIGIBILITY_OR_ORIGINAL_IDENTITY_MISSING",
                args.stage + ".IDENTITY",
                "NATIVE_ANALYZER_ELIGIBILITY_v1.json.gate/analyzer/runIdentity",
                {"gate": args.stage, "analyzer": expected_program,
                 "originalRunId": ctx["runId"], "head": ctx["workflowHeadSha"]},
                {"schema": record.get("schemaVersion") if isinstance(record, dict) else None,
                 "gate": record.get("gate") if isinstance(record, dict) else None,
                 "analyzer": record.get("analyzer") if isinstance(record, dict) else None,
                 "unavailable": absent},
                "original native execution cannot be established",
                "Regenerate exact qualified original source and native tool plan on this run",
                str(source), observation_failure=absent))
        observations = (record.get("issues") if isinstance(record, dict) else []) or []
        for requirement in observations:
            if not isinstance(requirement, dict):
                continue
            warnings.append(make_warning(
                ctx, args, str(requirement.get("code") or "NATIVE.ISSUE"),
                args.stage + ".PIN_OR_SCOPE",
                str(requirement.get("fieldPath") or name),
                requirement.get("expected"), requirement.get("observed"),
                "affected native analyzer cannot execute without qualified inputs",
                str(requirement.get("correction") or "inspect source-bound tool and ABI provenance"),
                str(source), component=expected_program))
        _finish(root, args, ctx, warnings, "NOT_EXECUTED", {
            "sourceBound": bool(valid and record.get("sourceBound") is True),
            "sourceIdentity": {"archiveSha256": record.get("sourceArchiveSha256")}
                if valid else None,
            "attempted": 0, "completed": 0,
            "notExecuted": record.get("targetCount", 0) if valid else 1,
            "dependencyFacts": {
                "sourceCompatibleTargets": record.get("languageSupportedCount") if valid else None,
                "nativeExecutionNotAttempted": True,
                "originalNativeOutputSha256": None,
                "program": expected_program,
                "exactMissingRequirementCount": len(warnings)
            }})
        return
    if args.stage in ("G8", "G9"):
        if args.stage == "G8":
            expected_mode = "reconcile-native"
            filename = "SECURITY_PIPELINE_NATIVE_EVIDENCE_INDEX_v1.json"
            expected_schema = "curveyield-security-pipeline-native-evidence-index-v1"
        else:
            expected_mode = "qualify-dossier"
            filename = "SECURITY_PIPELINE_RELEASE_STATUS_v1.json"
            expected_schema = "curveyield-security-pipeline-release-status-v1"
        doc_path = Path(args.input_root or "") / filename
        doc, missing = _read_optional_json(str(doc_path) if args.input_root else None)
        receipt_valid = bool(
            isinstance(doc, dict) and doc.get("schemaVersion") == expected_schema and
            data.get("operation") == expected_mode and
            str(data.get("runId")) == ctx["runId"] and
            str(data.get("runAttempt")) == str(ctx["runAttempt"]) and
            data.get("workflowHeadSha") == ctx["workflowHeadSha"] and
            str(doc.get("runId")) == ctx["runId"] and
            str(doc.get("runAttempt")) == str(ctx["runAttempt"]) and
            doc.get("headSha") == ctx["workflowHeadSha"]
        )
        if not receipt_valid:
            warnings.append(make_warning(
                ctx, args, "EVIDENCE.STAGE_PRODUCER_IDENTITY_MISMATCH",
                args.stage + ".RECEIPT", filename + ".runId/runAttempt/headSha",
                {"schemaVersion": expected_schema, "runId": ctx["runId"],
                 "runAttempt": ctx["runAttempt"], "headSha": ctx["workflowHeadSha"]},
                {"schemaVersion": doc.get("schemaVersion") if isinstance(doc, dict) else None,
                 "runId": doc.get("runId") if isinstance(doc, dict) else None,
                 "headSha": doc.get("headSha") if isinstance(doc, dict) else None,
                 "sourceFailure": missing},
                "stage does not establish original native evidence or a release",
                "Re-run only this stage with original same-attempt evidence and immutable source identity",
                str(doc_path), observation_failure=missing))
        if not data.get("issues"):
            if args.stage == "G8" and (not isinstance(doc, dict) or doc.get("nativeQualifiedCount") != 5):
                warnings.append(make_warning(
                    ctx, args, "EVIDENCE.NATIVE_QUALIFICATION_INCOMPLETE",
                    "G8.NATIVE_COVERAGE", filename + ".nativeQualifiedCount",
                    "5 independently qualified native analyzer results",
                    doc.get("nativeQualifiedCount") if isinstance(doc, dict) else None,
                    "Native security analysis cannot be declared complete",
                    "Qualify exact program binary pins and preserve each native output",
                    str(doc_path)))
            elif args.stage == "G9" and isinstance(doc, dict) and doc.get("status") != "COMPLETE":
                warnings.append(make_warning(
                    ctx, args, "EVIDENCE.RELEASE_SCOPE_INCOMPLETE", "G9.RELEASE",
                    filename + ".status", "COMPLETE for a verified declared scope",
                    doc.get("status"), "release dossier is not qualified",
                    "Resolve original stage/native results while retaining all limitations",
                    str(doc_path)))
        for issue in data.get("issues", []):
            if not isinstance(issue, dict):
                continue
            warnings.append(make_warning(
                ctx, args, "EVIDENCE.ORIGINAL_REQUIREMENT_NOT_MET",
                args.stage + ".NATIVE_REQUIREMENT",
                str(issue.get("fieldPath") or filename),
                issue.get("expected"), issue.get("observed"),
                "source-bound native reconciliation or dossier incomplete",
                str(issue.get("correction") or "restore exact observed evidence"),
                args.native_result))
        actual_status = str(doc.get("status") or "UNVERIFIED") if receipt_valid else "UNVERIFIED"
        qualified = bool(receipt_valid and actual_status == "COMPLETE" and
                         not warnings and data.get("status") == "COMPLETE")
        _finish(root, args, ctx, warnings,
                "COMPLETE" if qualified else ("PARTIAL" if receipt_valid else "UNVERIFIED"), {
                    "attempted": 1, "completed": 1 if qualified else 0,
                    "notExecuted": 0 if qualified else 1,
                    "sourceBound": bool(receipt_valid and (
                        doc.get("sourceAdmissionVerified") is True if args.stage == "G8" else
                        doc.get("originalSourceArchiveSha256"))),
                    "sourceIdentity": {"archiveSha256": doc.get("sourceArchiveSha256")
                        if args.stage == "G8" else doc.get("originalSourceArchiveSha256")}
                        if receipt_valid else None,
                    "originalNativeEvidenceSha256": None,
                    "dependencyFacts": {"nativeQualificationCount": doc.get("nativeQualifiedCount")
                        if args.stage == "G8" else doc.get("qualifiedNativeCount"),
                        "reportProducerStatus": actual_status,
                        "controllerAccepted": False,
                        "originalNativeEvidenceNotSynthesized": True}})
        return
    # Other native result types have not been independently classified. A
    # parseable JSON object is not proof that a native analyzer completed.
    _finish(root, args, ctx, [], "UNVERIFIED",
            {"dependencyFacts": {"nativeResultPresent": True,
                                 "schemaVersion": data.get("schemaVersion")}})


def emit_warning(root, args, ctx):
    data, err = _read_optional_json(args.warning_input)
    if err or not isinstance(data, dict):
        w = make_warning(ctx, args, "STAGE.WARNING_INPUT_INVALID", "STAGE.WARNING_INPUT",
            "warningInput", "trusted structured warning JSON", err or "not object",
            "cannot accept caller's warning as evidence", "Provide an actual typed warning observation",
            args.warning_input, observation_failure=err)
    else:
        w = make_warning(ctx, args,
            _safe(data.get("code") or "STAGE.OBSERVED_MISMATCH", 70),
            _safe(data.get("checkId") or "STAGE.OBSERVED", 90),
            _safe(data.get("configurationField") or "stage.configuration", 180),
            data.get("expected"), data.get("observed"),
            _safe(data.get("impact") or "affected operation NOT_EXECUTED", 300),
            _safe(data.get("requiredCorrection") or "Inspect original input evidence", 300),
            args.warning_input, component=data.get("componentId"))
    _finish(root, args, ctx, [w], "WARNING")


def verify_toolkit_component(root, args, ctx):
    warnings = []
    metric, error = _read_optional_json(args.profile)
    component = args.component
    expected = metric.get("expectedBinarySha256") if isinstance(metric, dict) else None
    observed = None
    if not isinstance(metric, dict) or metric.get("schemaVersion") != "curveyield-toolkit-component-metrics-v1":
        error = error or "TOOLKIT_METRICS_SCHEMA_INVALID"
    elif (metric.get("componentId") != component or
          str(metric.get("runId")) != ctx["runId"] or
          str(metric.get("runAttempt")) != str(ctx["runAttempt"]) or
          metric.get("workflowHeadSha") != ctx["workflowHeadSha"]):
        error = "TOOLKIT_METRICS_COMPONENT_OR_RUN_IDENTITY_MISMATCH"
    elif (metric.get("componentRequired") is False and
          metric.get("status") == "NOT_REQUIRED" and
          metric.get("usableForExecution") is False):
        # A legitimate source-derived non-required component must not produce a
        # fictitious binary-missing defect. It never becomes usableForExecution.
        record = {"schemaVersion": "curveyield-toolkit-component-verification-v1",
                  "componentId": component, "status": "NOT_REQUIRED",
                  "usableForExecution": False, "expectedBinarySha256": expected,
                  "observedBinarySha256": None, "runId": ctx["runId"],
                  "runAttempt": ctx["runAttempt"], "workflowHeadSha": ctx["workflowHeadSha"],
                  "sourceRequirement": "DECLARED_NOT_REQUIRED_IN_CURRENT_RUN"}
        _write_json(root / "TOOLKIT_CACHE_COMPONENT_VERIFICATION_v1.json", record)
        if args.github_output:
            with open(args.github_output, "a", encoding="utf-8") as out:
                out.write("usableForExecution=false\n")
        _finish(root, args, ctx, [], "NOT_REQUIRED",
                {"attempted": 0, "completed": 0, "notExecuted": 0,
                 "dependencyFacts": {"component": component,
                                     "sourceRequirement": "NOT_REQUIRED"}})
        return
    else:
        # Binary SHA must originate independently from the trusted code checkout.
        # At present only the current pinned MiMo GGUF has a verified absolute
        # original-byte reference in the source-controlled inference workflow.
        if component == "mimo-weights" and args.toolkit_root:
            try:
                workflow = bounded_file(
                    ".github/workflows/lite-solo-ai-inference-v1.yml").decode("utf-8")
                pinned = re.findall(r"^\s*MODEL_SHA256:\s*([0-9a-f]{64})\s*$", workflow, re.MULTILINE)
                files = re.findall(r"^\s*MODEL_FILE:\s*([A-Za-z0-9._-]+)\s*$", workflow, re.MULTILINE)
                if len(pinned) != 1 or len(files) != 1:
                    raise ValueError("TRUSTED_MIMO_PIN_NOT_UNIQUE")
                if expected != pinned[0]:
                    raise ValueError("PROFILE_BINARY_SHA_DIFFERS_FROM_TRUSTED_MIMO_PIN")
                file = Path(args.toolkit_root) / files[0]
                if file.is_symlink() or not file.is_file():
                    raise ValueError("MODEL_BINARY_UNAVAILABLE_OR_SYMLINK")
                hasher = hashlib.sha256()
                with file.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        hasher.update(chunk)
                observed = hasher.hexdigest()
                if observed != expected:
                    raise ValueError("MODEL_BINARY_SHA_MISMATCH")
            except (OSError, ValueError) as exc:
                error = str(exc)
        else:
            error = "NO_INDEPENDENT_APPROVED_BINARY_BYTE_PIN_FOR_COMPONENT"
    if error or not isinstance(expected, str) or not SHA256.fullmatch(expected) or observed != expected:
        warnings.append(make_warning(ctx, args, "TOOLKIT.COMPONENT_PIN_MISMATCH", "TOOLKIT.BINARY_SHA",
            "toolkitComponents[{}].expectedBinarySha256".format(component),
            expected, observed or error, "unverified executable must not be run",
            "Verify current trusted source pin and exact component original binary SHA, then restore/rebuild from approved recipe",
            args.profile, component=component, observation_failure=error))
    result = {"schemaVersion": "curveyield-toolkit-component-verification-v1", "componentId": component,
              "usableForExecution": not bool(warnings), "expectedBinarySha256": expected,
              "observedBinarySha256": observed, "runId": ctx["runId"], "runAttempt": ctx["runAttempt"],
              "workflowHeadSha": ctx["workflowHeadSha"], "originalTrustedPin": component == "mimo-weights"}
    _write_json(root / "TOOLKIT_CACHE_COMPONENT_VERIFICATION_v1.json", result)
    if args.github_output:
        with open(args.github_output, "a", encoding="utf-8") as out:
            out.write("usableForExecution={}\n".format(str(not bool(warnings)).lower()))
    _finish(root, args, ctx, warnings, "NOT_EXECUTED" if warnings else "COMPLETE")


def main(argv):
    args = parse_args_strict(argv)
    ctx = parse_run_context(args)
    root = Path(args.report_root)
    root.mkdir(parents=True, exist_ok=True)
    if args.mode == "admit-extended":
        admit_extended(root, args, ctx)
    elif args.mode == "summarize-job":
        summarize_job(root, args, ctx)
    elif args.mode == "verify-stage":
        verify_stage(root, args, ctx)
    elif args.mode == "emit-warning":
        emit_warning(root, args, ctx)
    elif args.mode == "verify-toolkit-component":
        verify_toolkit_component(root, args, ctx)
    elif args.mode == "finalize-stage":
        warnings_file = root / "SECURITY_PIPELINE_WARNINGS_v1.jsonl"
        warnings = []
        if warnings_file.exists():
            for line in warnings_file.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    warnings.append(json.loads(line))
        write_stage_disposition(root, args, ctx, "WARNING" if warnings else "UNVERIFIED", warnings)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as error:
        # An unavailable verifier itself is an infrastructure fault, never a PASS.
        print("::error title=SECURITY_PIPELINE_VERIFIER_UNAVAILABLE::{}:{}".format(
            type(error).__name__, _safe(str(error))), file=sys.stderr)
        raise SystemExit(2)
