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
                 "toolkit-root"):
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
    source = {"value": expected, "source": "verified original input or trusted workflow configuration"}
    seen = {"value": observed, "source": evidence or "current trusted job-local observation"}
    evidence_sha = sha256_bytes(json.dumps(seen, sort_keys=True, default=str).encode())
    identity = {"run": ctx["runId"], "attempt": ctx["runAttempt"],
                "stage": args.stage, "check": check_id, "field": field,
                "evidenceSha256": evidence_sha}
    return {
        "schemaVersion": WARNING_SCHEMA,
        "warningId": sha256_bytes(json.dumps(identity, sort_keys=True).encode()),
        "code": code, "stage": args.stage, "operation": operation or args.job,
        "componentId": component, "targetId": None, "checkId": check_id,
        "configurationField": field, "expected": source, "observed": seen,
        "observationFailure": observation_failure,
        "mismatch": "{}: expected {}; observed {}".format(field, _safe(expected), _safe(observed)),
        "impact": impact, "requiredCorrection": correction,
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
    for w in warnings:
        record_warning_jsonl(root, w)
    if not warnings:
        (root / "SECURITY_PIPELINE_WARNINGS_v1.jsonl").touch()
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as out:
                out.write("Security pipeline {} / {}: zero configuration warnings recorded.\n".format(args.job, args.stage))
    write_stage_disposition(root, args, ctx, status, warnings, extra)
    (root / "SECURITY_PIPELINE_STAGE_SUMMARY_v1.md").write_text(
        "# Security pipeline {} / {}\n\nStatus: **{}**\nWarnings: **{}**\nRun: {} attempt {}\n".format(
            args.job, args.stage, status, len(warnings), ctx["runId"], ctx["runAttempt"]), encoding="utf-8")


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
    with open(args.github_output, "a", encoding="utf-8") as out:
        out.write("extended_requested={}\nextended_approved={}\n".format(
            str(requested).lower(), str(payload["approved"]).lower()))
    _finish(root, args, ctx, warnings, "NOT_EXECUTED" if warnings else "NOT_REQUIRED",
            {"sourceBound": valid, "sourceIdentity": {"archiveSha256": source_sha},
             "dependencyFacts": {"extendedDisposition": disposition}})


def summarize_job(root, args, ctx):
    warnings = []
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
    status = "NOT_EXECUTED" if warnings else "UNVERIFIED"
    _finish(root, args, ctx, warnings, status, {"dependencyFacts": {"nativeResultPresent": not bool(err)}})


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
    profile, error = _read_optional_json(args.profile)
    component = args.component
    expected = profile.get("binarySha256") if isinstance(profile, dict) else None
    artifact = profile.get("relativeBinaryPath") if isinstance(profile, dict) else None
    observed = None
    if args.toolkit_root and artifact and isinstance(artifact, str):
        try:
            observed = sha256_bytes(bounded_file(Path(args.toolkit_root) / artifact, args.toolkit_root, 512 * 1024 * 1024))
        except (OSError, ValueError) as exc:
            error = str(exc)
    if error or not isinstance(expected, str) or not SHA256.fullmatch(expected) or observed != expected:
        warnings.append(make_warning(ctx, args, "TOOLKIT.COMPONENT_PIN_MISMATCH", "TOOLKIT.BINARY_SHA",
            "toolkitComponents[{}].binarySha256".format(component), expected, observed or error,
            "unverified executable must not be run", "Rebuild/restore from trusted recipe and verify expected binary SHA",
            args.profile, component=component, observation_failure=error))
    result = {"schemaVersion": "curveyield-toolkit-component-verification-v1", "componentId": component,
              "usableForExecution": not bool(warnings), "expectedBinarySha256": expected,
              "observedBinarySha256": observed, "runId": ctx["runId"], "runAttempt": ctx["runAttempt"]}
    _write_json(root / "TOOLKIT_CACHE_COMPONENT_VERIFICATION_v1.json", result)
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
