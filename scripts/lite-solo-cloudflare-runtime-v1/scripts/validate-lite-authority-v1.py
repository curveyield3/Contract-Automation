#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote

root=Path(sys.argv[1] if len(sys.argv)>1 else "Audit Skill - Current Authority").resolve()
packages=sorted(p for p in root.iterdir() if p.is_dir() and (p/"SKILL.md").is_file())
if len(packages)!=1:
    raise SystemExit(f"expected exactly one unpacked Lite authority package under {root}, found {len(packages)}")
pkg=packages[0]

prohibited=[
    "shared/handoff/",
    "SOLO_WORKFLOW_STATE_MACHINE.json",
    "SOLO_AUDIT_STATE.json",
    "web-bootstrap-agent",
    "WAKE_UP_MESSAGE_TEMPLATE.md",
    "SUCCESSOR_HANDOFF_PROTOCOL.md",
    "HANDOFF_DISCOVERY_AND_CONTEXT_RECOVERY.md",
    "START_HERE_SUCCESSOR_TEMPLATE.md",
    "PROCESS_BLOCKER_RECEIPT.json",
]
term_excludes={"PACKAGE_PROVENANCE.md","LITE_PHASE_RECEIPT_PROTOCOL.md"}
errors=[]

text_files=[p for p in pkg.rglob("*") if p.is_file() and p.suffix.lower() in {".md",".json",".yaml",".yml",".txt"}]
for p in text_files:
    try:
        text=p.read_text()
    except UnicodeDecodeError:
        continue
    rel=p.relative_to(pkg).as_posix()
    if p.name not in term_excludes:
        for term in prohibited:
            if term in text:
                errors.append(f"{rel}: prohibited current-Lite reference {term!r}")

    if p.suffix.lower()==".md":
        for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)",text):
            raw=match.group(1).strip()
            if not raw or raw.startswith(("http://","https://","mailto:","#")):
                continue
            if raw.startswith("<") and raw.endswith(">"):
                raw=raw[1:-1]
            target=unquote(raw.split("#",1)[0].split("?",1)[0]).strip()
            if not target:
                continue
            candidate=(p.parent/target).resolve()
            try:
                candidate.relative_to(pkg.resolve())
            except ValueError:
                errors.append(f"{rel}: local link escapes authority package: {raw}")
                continue
            if not candidate.exists():
                errors.append(f"{rel}: broken local link: {raw}")



# Structured-action / one-schema-per-phase invariants.
policy=pkg/"shared/controller/LITE_PHASE_SCHEMA_POLICY.md"
if not policy.exists():
    errors.append("shared/controller/LITE_PHASE_SCHEMA_POLICY.md missing")
packet_template=pkg/"shared/controller/PHASE_WORK_PACKET_TEMPLATE_v1.json"
if not packet_template.exists():
    errors.append("shared/controller/PHASE_WORK_PACKET_TEMPLATE_v1.json missing")

obligation_disposition_phases=set()
custom_obligation_required_phases=set()

for phase in range(1,11):
    phase_dir=pkg/f"phases/phase-{phase}"
    expected_schema=phase_dir/f"PHASE_{phase:02d}_SCHEMA_v1.json"
    schemas=sorted(phase_dir.glob("PHASE_*_SCHEMA_v*.json"))
    if schemas != [expected_schema]:
        errors.append(f"phase-{phase}: expected exactly one phase work schema {expected_schema.name}; found {[p.name for p in schemas]}")
        continue
    try:
        schema=json.loads(expected_schema.read_text())
        contract=json.loads((phase_dir/"PHASE_CONTRACT.json").read_text())
        template_path=pkg/schema["workForm"]["template"]
        form_template=json.loads(template_path.read_text())
        start_here=(phase_dir/"START_HERE.md").read_text()
    except Exception as exc:
        errors.append(f"phase-{phase}: failed to load schema/contract/form template: {exc}")
        continue

    if schema.get("schemaVersion")!="curveyield-lite-phase-work-schema-v1" or schema.get("phase")!=phase:
        errors.append(f"phase-{phase}: schema identity mismatch")
    if contract.get("workSchema")!=f"phases/phase-{phase}/PHASE_{phase:02d}_SCHEMA_v1.json":
        errors.append(f"phase-{phase}: contract workSchema mismatch")
    if contract.get("workForm")!=schema.get("workForm",{}).get("campaignPath"):
        errors.append(f"phase-{phase}: contract workForm mismatch")
    if schema.get("submission",{}).get("packetPath")!=contract.get("submissionPolicy",{}).get("packetPath"):
        errors.append(f"phase-{phase}: contract/schema packet path mismatch")
    required_outputs={x.get("artifact"):x for x in contract.get("requiredOutputs",[]) if isinstance(x,dict) and x.get("artifact")}
    if schema.get("workForm",{}).get("campaignPath") not in required_outputs:
        errors.append(f"phase-{phase}: contract requiredOutputs missing schema work form")
    if not schema.get("automationOnly") and schema.get("finalReport",{}).get("campaignPath") not in required_outputs:
        errors.append(f"phase-{phase}: contract requiredOutputs missing schema final report")
    if not schema.get("automationOnly"):
        report_output=required_outputs.get(schema.get("finalReport",{}).get("campaignPath"),{})
        if report_output.get("producer")!="CONTROLLER":
            errors.append(f"phase-{phase}: final report requiredOutput producer must be CONTROLLER")
    auth=contract.get("authorization",{})
    automation_only=bool(schema.get("automationOnly"))
    if auth.get("activeReceiptExistsDuringAgentWork") is not False:
        errors.append(f"phase-{phase}: activeReceiptExistsDuringAgentWork must be false")
    if automation_only:
        if phase==7:
            bound_manifest=json.loads((pkg/"MANIFEST.json").read_text())
            new_topology=bound_manifest.get("reviewerLineup",{}).get("phaseReviewers",{}).get("7")=="phase7-automation"
            expected="AFTER_PHASE6_MASTER_REVIEW_ACCEPTED" if new_topology else "IN_SAME_PHASE6_CONTROLLER_PASS_TRANSACTION"
            if auth.get("controllerBookkeepingTiming")!=expected:
                errors.append("phase-7: controllerBookkeepingTiming must match the exactly bound manifest topology")
    elif auth.get("controllerBookkeepingTiming")!="AFTER_PACKET_VALIDATION_PASS_ONLY":
        errors.append(f"phase-{phase}: controllerBookkeepingTiming mismatch")
    submission=contract.get("submissionPolicy",{})
    if submission.get("agentCreatesReceipt") is not False or submission.get("agentPerformsBookkeeping") is not False:
        errors.append(f"phase-{phase}: agent receipt/bookkeeping ownership must be false")
    if submission.get("controllerCreatesAndSealsReceiptAfterPass") is not True:
        errors.append(f"phase-{phase}: controller must create/seal receipt only after PASS")
    if submission.get("laterPhasesRecheckPriorBookkeeping") is not False:
        errors.append(f"phase-{phase}: later phases must not re-check predecessor bookkeeping")

    actions=schema.get("actions",{})
    steps=contract.get("steps",[])
    controller_generated_paths={x.get("path") for x in schema.get("controllerGeneratedOutputs",[]) if isinstance(x,dict) and x.get("path")}
    obligation_fields=[]
    for action_key,action in actions.items():
        for field in action.get("fields",[]):
            if field.get("name")=="obligationDispositions":
                obligation_fields.append((action_key,field))
                obligation_disposition_phases.add(phase)
            if field.get("name")=="customValidationObligations":
                allowed=field.get("itemFieldAllowedValues",{}).get("requiredPhase",[])
                custom_obligation_required_phases.update(int(x) for x in allowed if str(x).isdigit())
    if obligation_fields and "expectedDueObligationIds" not in {x.get("name") for x in schema.get("controllerAutomationInputs",[]) if isinstance(x,dict)}:
        errors.append(f"phase-{phase}: obligationDispositions requires controllerAutomationInputs.expectedDueObligationIds")
    controller_inputs=schema.get("controllerAutomationInputs",[])
    input_names=[x.get("name") for x in controller_inputs if isinstance(x,dict)]
    if len(input_names)!=len(set(input_names)):
        errors.append(f"phase-{phase}: duplicate controllerAutomationInputs names")
    for item in controller_inputs:
        if not isinstance(item,dict) or not item.get("name") or not item.get("type") or not item.get("consumers"):
            errors.append(f"phase-{phase}: controllerAutomationInputs entries require name/type/consumers")
    generated_paths=[x.get("path") for x in schema.get("controllerGeneratedOutputs",[]) if isinstance(x,dict)]
    if len(generated_paths)!=len(set(generated_paths)):
        errors.append(f"phase-{phase}: duplicate controllerGeneratedOutputs paths")
    for item in schema.get("controllerGeneratedOutputs",[]):
        if not isinstance(item,dict) or not item.get("path") or not item.get("type") or not item.get("source") or not item.get("consumers"):
            errors.append(f"phase-{phase}: controllerGeneratedOutputs entries require path/type/source/consumers")
    if len(actions)!=len(steps):
        errors.append(f"phase-{phase}: schema action count {len(actions)} != contract step count {len(steps)}")
    for step in steps:
        n=step.get("step")
        key=f"step-{n}"
        action=actions.get(key)
        if not action:
            errors.append(f"phase-{phase}: contract step {n} has no schema action")
            continue
        if step.get("action")!=action.get("title"):
            errors.append(f"phase-{phase} step {n}: contract action title does not exactly match schema title")
        expected_start_heading=f"## Step {n} — {action.get('title')}"
        if expected_start_heading not in start_here:
            errors.append(f"phase-{phase} step {n}: START_HERE missing exact action heading {expected_start_heading!r}")
        schema_anchor=f"PHASE_{phase:02d}_SCHEMA_v1.json#actions.{key}"
        if schema_anchor not in start_here:
            errors.append(f"phase-{phase} step {n}: START_HERE missing exact schema action reference {schema_anchor}")
        if schema.get("workForm",{}).get("campaignPath") not in start_here:
            errors.append(f"phase-{phase} step {n}: START_HERE missing campaign work-form path")
        dest=step.get("outputDestination")
        if not isinstance(dest,dict):
            errors.append(f"phase-{phase} step {n}: outputDestination is mandatory")
            continue
        if dest.get("document")!=schema.get("workForm",{}).get("campaignPath"):
            errors.append(f"phase-{phase} step {n}: output document mismatch")
        if dest.get("section")!=action.get("section"):
            errors.append(f"phase-{phase} step {n}: section mismatch")
        expected_schema_ref=f"phases/phase-{phase}/PHASE_{phase:02d}_SCHEMA_v1.json#actions.{key}"
        if dest.get("schema")!=expected_schema_ref:
            errors.append(f"phase-{phase} step {n}: schema reference mismatch")
        field_names=[x.get("name") for x in action.get("fields",[])]
        if dest.get("requiredFields")!=field_names:
            errors.append(f"phase-{phase} step {n}: requiredFields do not exactly match schema")
        form_action=form_template.get("actions",{}).get(key)
        if not form_action:
            errors.append(f"phase-{phase} step {n}: work-form template section missing")
        else:
            if form_action.get("section")!=action.get("section"):
                errors.append(f"phase-{phase} step {n}: work-form section title mismatch")
            outputs=form_action.get("outputs",{})
            if set(outputs.keys())!=set(field_names):
                errors.append(f"phase-{phase} step {n}: work-form output keys do not exactly match schema fields")
            for field in action.get("fields",[]):
                name=field.get("name")
                if name not in outputs:
                    errors.append(f"phase-{phase} step {n}: form field {name} missing")
                if not field.get("consumers"):
                    errors.append(f"phase-{phase} step {n}: required field {name} has no declared consumer/purpose")
                if field.get("type")=="REQUIRED_RECORD_LIST":
                    value=outputs.get(name)
                    template_keys=set(value[0].keys()) if isinstance(value,list) and value and isinstance(value[0],dict) else set()
                    missing=[k for k in field.get("itemRequiredFields",[]) if template_keys and k not in template_keys]
                    if missing:
                        errors.append(f"phase-{phase} step {n}: form record {name} missing itemRequiredFields {missing}")
                    valid_item_keys=set(field.get("itemRequiredFields",[]))|template_keys
                    for key_name in field.get("controllerPrefillFields",[])+field.get("controllerCollectedFields",[]):
                        if key_name not in valid_item_keys:
                            errors.append(f"phase-{phase} step {n}: field-level controller-owned item {key_name} is absent from record schema/template")
            record_item_keys=set()
            for field in action.get("fields",[]):
                if field.get("type")=="REQUIRED_RECORD_LIST":
                    record_item_keys.update(field.get("itemRequiredFields",[]))
                    value=outputs.get(field.get("name"))
                    if isinstance(value,list) and value and isinstance(value[0],dict):
                        record_item_keys.update(value[0].keys())
            for key_name in action.get("controllerPrefillFields",[])+action.get("controllerCollectedFields",[]):
                if key_name not in record_item_keys:
                    errors.append(f"phase-{phase} step {n}: action controller-owned field {key_name} is absent from record schema/template")
        for resource in step.get("resources",[]):
            if not isinstance(resource,str) or not resource:
                errors.append(f"phase-{phase} step {n}: invalid empty/non-string resource reference")
                continue
            if resource.startswith("campaign:"):
                continue
            candidate=(phase_dir/resource).resolve()
            try:
                candidate.relative_to(pkg.resolve())
            except ValueError:
                errors.append(f"phase-{phase} step {n}: resource escapes authority package: {resource}")
                continue
            if not candidate.exists():
                errors.append(f"phase-{phase} step {n}: missing referenced resource: {resource}")
        if not action.get("fields"):
            errors.append(f"phase-{phase} step {n}: every agent/automation action must produce defined output fields")

    for key in actions:
        try:
            n=int(key.split("-",1)[1])
        except Exception:
            errors.append(f"phase-{phase}: invalid schema action key {key}")
            continue
        if not any(s.get("step")==n for s in steps):
            errors.append(f"phase-{phase}: schema action {key} has no matching contract step")

    contract_derived=sorted(contract.get("derivedOutputPolicy",{}).get("outputs",[]))
    schema_derived=sorted(x.get("path") for x in schema.get("derivedOutputs",[]) if isinstance(x,dict) and x.get("path"))
    if contract_derived!=schema_derived:
        errors.append(f"phase-{phase}: contract derived outputs do not exactly match schema derivedOutputs")

    declared_action_paths=set()
    for action_key,action in actions.items():
        for field in action.get("fields",[]):
            declared_action_paths.add(f"actions.{action_key}.outputs.{field.get('name')}")
    valid_output_paths=declared_action_paths|controller_generated_paths
    for mapping_name,paths in schema.get("bookkeepingMappings",{}).items():
        for output_path in paths:
            if output_path.startswith("actions.") and output_path not in valid_output_paths:
                errors.append(f"phase-{phase}: {mapping_name} references undeclared output {output_path}")
            if mapping_name=="obligationRecordPaths" and output_path:
                leaf=output_path.rsplit(".",1)[-1]
                if leaf not in {"obligationDispositions","customValidationObligations"}:
                    errors.append(f"phase-{phase}: obligationRecordPaths contains non-obligation output {output_path}")
    for spec in schema.get("derivedOutputs",[]):
        for selector in spec.get("selectors",[]):
            if selector in {"actions","automationOutputs"}:
                continue
            if selector.startswith("actions.") and selector not in valid_output_paths:
                errors.append(f"phase-{phase}: derived selector references undeclared output {selector}")

    report=schema.get("finalReport")
    if schema.get("automationOnly"):
        if phase!=7:
            errors.append(f"phase-{phase}: only Phase 7 may be automationOnly")
    else:
        if not report:
            errors.append(f"phase-{phase}: agent-executed phase requires one schema-governed final report")
        else:
            report_template=pkg/report.get("template","")
            if not report_template.exists():
                errors.append(f"phase-{phase}: final-report template missing: {report.get('template')}")
            if contract.get("finalReport")!=report.get("campaignPath"):
                errors.append(f"phase-{phase}: contract finalReport mismatch")
            try:
                report_text=report_template.read_text()
                headings={line[3:].strip() for line in report_text.splitlines() if line.startswith("## ")}
                for required_heading in report.get("requiredSections",[]):
                    if required_heading not in headings:
                        errors.append(f"phase-{phase}: final-report template missing required section {required_heading!r}")
            except Exception as exc:
                errors.append(f"phase-{phase}: failed to inspect final-report template: {exc}")

phase0=json.loads((pkg/"phases/phase-0/PHASE_CONTRACT.json").read_text())
phase0_outputs={x.get("artifact") for x in phase0.get("requiredOutputs",[]) if isinstance(x,dict)}
for required_output in {
    "evidence/readiness/PROJECT_READINESS_AUTOMATED_v1.json",
    "evidence/phase0/PHASE0_DEPLOY_CONFIG_EXECUTION_v1.json",
    "work/phase-06/LITE_DEPLOY_CONFIG_MATRIX.md",
}:
    if required_output not in phase0_outputs:
        errors.append(f"phase-0: finalizer-required machine output is undeclared: {required_output}")

domain_matrix=json.loads((pkg/"shared/controller/DOMAIN_APPLICABILITY_MATRIX.json").read_text())
for domain in domain_matrix.get("domains",[]):
    phases={int(x) for x in domain.get("requiredExecutionPhases",[]) if str(x).isdigit()}
    if 7 in phases:
        errors.append(f"DOMAIN_APPLICABILITY_MATRIX: {domain.get('domainId')} assigns substantive work to automation-only Phase 7")
    future_phases={p for p in phases if p>3}
    unsupported=future_phases-obligation_disposition_phases
    if unsupported:
        errors.append(f"DOMAIN_APPLICABILITY_MATRIX: {domain.get('domainId')} assigns future obligations to phase(s) without obligationDispositions: {sorted(unsupported)}")
if 7 in domain_matrix.get("executionReusePhases",[]):
    errors.append("DOMAIN_APPLICABILITY_MATRIX: executionReusePhases still includes automation-only Phase 7")
unsupported_custom=custom_obligation_required_phases-obligation_disposition_phases
if unsupported_custom:
    errors.append(f"customValidationObligations allows unsupported disposition phase(s): {sorted(unsupported_custom)}")

phase7=json.loads((pkg/"phases/phase-7/PHASE_CONTRACT.json").read_text())
auth=phase7.get("authorization",{})
if auth.get("independentExecutionAuthorized") is not False:
    errors.append("phase-7/PHASE_CONTRACT.json: independentExecutionAuthorized must be false")
if auth.get("reviewerExecutionAuthorized") is not False:
    errors.append("phase-7/PHASE_CONTRACT.json: reviewerExecutionAuthorized must be false")
if auth.get("executorType")!="GITHUB_ACTIONS_AUTOMATION":
    errors.append("phase-7/PHASE_CONTRACT.json: executorType must be GITHUB_ACTIONS_AUTOMATION")
if phase7.get("phase",{}).get("reviewerLineage")!="phase7-automation":
    errors.append("phase-7/PHASE_CONTRACT.json: reviewerLineage must be phase7-automation")

if errors:
    print("Lite authority validation FAILED:")
    for e in errors:
        print(f"- {e}")
    raise SystemExit(1)
print(f"Lite authority validation PASS: {pkg.name}; checked {len(text_files)} text files")
