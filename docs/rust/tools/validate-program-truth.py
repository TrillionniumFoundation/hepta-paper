#!/usr/bin/env python3
"""Validate Plan v4.1 static program truth and canonical projections."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
DOC = ROOT / "docs/rust"
QUAL = DOC / "qualification"
TRUTH = DOC / "current-status.v1.json"
STATUS_MD = DOC / "CURRENT_STATUS.md"
BACKLOG_MD = DOC / "RUST_REWRITE_BACKLOG.md"
PARITY_MD = DOC / "RUST_PARITY_MATRIX.md"
PACKAGE_MAP = QUAL / "external-package-map.v1.json"
CHECKS = QUAL / "source-required-checks.v1.json"
PRODUCERS = QUAL / "source-check-producers.v1.json"
CAPABILITY_EVIDENCE = QUAL / "source-capability-evidence.v1.json"
CHECK_EVIDENCE_SCHEMA = QUAL / "required-check-evidence-v2.schema.json"
EFFECTIVE_SCHEMA = QUAL / "effective-status-v1.schema.json"
LEGACY_SCHEMA = QUAL / "legacy-matrix-replay-closure-v1.schema.json"

STATUSES = {
    "not_started", "design_ready", "source_implemented", "source_qualified",
    "hosted_installed_qualified", "target_host_qualified",
    "external_authority_qualified", "blocked_external", "retired",
}
TIERS = {"none", "design", "source", "hosted_installed", "target_host", "external_authority"}
DERIVED = {"source_qualified", "hosted_installed_qualified"}
BACKLOG_ID = re.compile(r"RUST-(?:FND|BRK|WS|CMP|RO|MVP|DB)-\d{3}")
PARITY_ID = re.compile(r"PAR-(?:DET|CODEX)-\d{3}")
GAP_ID = re.compile(r"GAP-[A-Z]+-\d{3}")
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
BINDING_SECTIONS = {
    "currentStatusRows", "workstreams", "workstreamRepositoryLocalStatus",
    "backlogItemStatus", "parityItemStatus", "gaps",
    "gapRepositoryLocalStatus", "supplementalRepositoryLocalStatus",
}
CANONICAL = {
    "docs/rust/CURRENT_STATUS.md", "docs/rust/current-status.v1.json",
    "docs/rust/RUST_REWRITE_MASTER_PLAN.md", "docs/rust/RUST_REWRITE_BACKLOG.md",
    "docs/rust/RUST_PARITY_MATRIX.md", "docs/rust/QUALIFICATION_STATE_MACHINE.md",
    "docs/rust/RUST_RISK_REGISTER.md", "docs/rust/RUST_TCB_BOUNDARY.md",
    "docs/rust/PRINCIPAL_AND_FILESYSTEM_MATRIX.md",
    "docs/rust/EVIDENCE_AND_QUALIFICATION_MODEL.md",
    "docs/rust/CRASH_AND_RECOVERY_MATRIX.md", "docs/rust/OPERATIONS_RUNBOOK.md",
    "docs/rust/DOCUMENTATION_INDEX.md", "docs/rust/LEGACY_MATRIX_REFERENCE_PUBLICATION.md",
    "docs/rust/qualification/source-required-checks.v1.json",
    "docs/rust/qualification/source-check-producers.v1.json",
    "docs/rust/qualification/source-capability-evidence.v1.json",
    "docs/rust/qualification/required-check-evidence-v2.schema.json",
    "docs/rust/qualification/external-package-map.v1.json",
    "docs/rust/qualification/effective-status-v1.schema.json",
    "docs/rust/qualification/legacy-matrix-replay-closure-v1.schema.json",
    "docs/rust/tools/strict_json_schema.py",
    "docs/rust/tools/collect-required-checks.py",
    "docs/rust/tools/derive-effective-status.py",
    "docs/rust/tools/verify-effective-status-current.py",
    "docs/rust/tools/test-plan-v4-qualification.py",
    ".github/workflows/rust-program-truth.yml",
    ".github/workflows/rust-effective-source-qualification.yml",
    ".github/workflows/rust-source-qualification-revalidation.yml",
    "rust/README.md",
}


def fail(message: str) -> None:
    raise ValueError(message)


def obj(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(f"{name} must be an object")
    return value


def arr(value: Any, name: str) -> list[Any]:
    if not isinstance(value, list):
        fail(f"{name} must be a list")
    return value


def load(path: Path) -> dict[str, Any]:
    return obj(json.loads(path.read_text(encoding="utf-8")), str(path))


def sha256_file(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def git_blob_sha(path: Path) -> str:
    content = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()


def cells(line: str) -> list[str]:
    return [part.strip().strip("`") for part in line.strip().strip("|").split("|")]


def table(path: Path, pattern: re.Pattern[str], status_col: int) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.lstrip().startswith("|"):
            continue
        row = cells(line)
        if len(row) <= status_col or not pattern.fullmatch(row[0]):
            continue
        if row[0] in out:
            fail(f"duplicate {row[0]} in {path.name}")
        if row[status_col] not in STATUSES:
            fail(f"invalid status for {row[0]} in {path.name}")
        out[row[0]] = row[status_col]
    return out


def labelled_rows(path: Path, labels: set[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.lstrip().startswith("|"):
            continue
        row = cells(line)
        if len(row) >= 2 and row[0] in labels:
            if row[0] in out:
                fail(f"duplicate product row {row[0]}")
            out[row[0]] = row[1]
    return out


def issue_rows(path: Path, identifiers: set[str]) -> dict[str, tuple[str, int]]:
    out: dict[str, tuple[str, int]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.lstrip().startswith("|"):
            continue
        row = cells(line)
        if len(row) < 3 or row[0] not in identifiers:
            continue
        found = re.search(r"#(\d+)", row[2])
        if not found:
            fail(f"missing issue for {row[0]} in {path.name}")
        if row[0] in out:
            fail(f"duplicate issue row {row[0]} in {path.name}")
        out[row[0]] = (row[1], int(found.group(1)))
    return out


def static_status(identifier: str, status: Any, row: dict[str, Any] | None = None) -> str:
    if status not in STATUSES:
        fail(f"invalid status for {identifier}: {status}")
    if status in DERIVED:
        fail(f"static source self-asserts derived qualification: {identifier}")
    if status in {"target_host_qualified", "external_authority_qualified"}:
        if row is None or not isinstance(row.get("evidenceReference"), str):
            fail(f"qualified external row lacks evidenceReference: {identifier}")
    return str(status)


def strict_schema(path: Path, constants: dict[str, Any]) -> dict[str, Any]:
    schema = load(path)
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        fail(f"schema draft drift: {path.name}")
    if schema.get("type") != "object" or schema.get("additionalProperties") is not False:
        fail(f"schema must be a strict object: {path.name}")
    props = obj(schema.get("properties"), f"{path.name}.properties")
    for key, expected in constants.items():
        if obj(props.get(key), f"{path.name}.{key}").get("const") != expected:
            fail(f"schema constant drift: {path.name}.{key}")
    return schema


def validate_capability_manifest(truth: dict[str, Any], contexts: list[str]) -> int:
    manifest = load(CAPABILITY_EVIDENCE)
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "HeptaSourceCapabilityEvidenceManifestV1":
        fail("capability evidence identity drift")
    if manifest.get("program") != "hepta-paper-rust-rewrite" or manifest.get("status") != "canonical_capability_specific_source_evidence":
        fail("capability evidence program/status drift")
    if manifest.get("authority") != {"productionAuthorized": False, "externalAuthorityClaimed": False}:
        fail("capability evidence claims authority")
    context_sets = obj(manifest.get("contextSets"), "capability contextSets")
    bindings = obj(manifest.get("bindings"), "capability bindings")
    if set(bindings) != BINDING_SECTIONS:
        fail("capability binding section drift")
    for name, values in context_sets.items():
        rows = arr(values, f"context set {name}")
        if not name or not rows or len(rows) != len(set(rows)) or any(value not in contexts for value in rows):
            fail(f"invalid capability context set: {name}")

    expected: dict[str, set[str]] = {section: set() for section in BINDING_SECTIONS}
    expected["currentStatusRows"] = {key for key, status in truth["currentStatusRows"].items() if status == "source_implemented"}
    expected["backlogItemStatus"] = {key for key, status in truth["backlogItemStatus"].items() if status == "source_implemented"}
    expected["parityItemStatus"] = {key for key, status in truth["parityItemStatus"].items() if status == "source_implemented"}
    for row in truth["workstreams"]:
        if row["status"] == "source_implemented":
            expected["workstreams"].add(row["id"])
        if row.get("repositoryLocalStatus") == "source_implemented":
            expected["workstreamRepositoryLocalStatus"].add(row["id"])
    for row in truth["gaps"]:
        if row.get("external") is not True and row["status"] == "source_implemented":
            expected["gaps"].add(row["id"])
        if row.get("repositoryLocalStatus") == "source_implemented":
            expected["gapRepositoryLocalStatus"].add(row["id"])
    for row in truth["supplementalBlockers"]:
        if row.get("repositoryLocalStatus") == "source_implemented":
            expected["supplementalRepositoryLocalStatus"].add(row["id"])

    count = 0
    for section in BINDING_SECTIONS:
        rows = obj(bindings.get(section), f"bindings.{section}")
        if set(rows) != expected[section]:
            fail(f"capability binding coverage drift: {section}")
        for identifier, names in rows.items():
            selected = arr(names, f"binding {section}:{identifier}")
            if not selected or len(selected) != len(set(selected)) or any(name not in context_sets for name in selected):
                fail(f"invalid capability binding: {section}:{identifier}")
            resolved = {context for name in selected for context in context_sets[name]}
            if not resolved:
                fail(f"empty resolved capability binding: {section}:{identifier}")
            count += 1
    return count


def main() -> int:
    missing = sorted(path for path in CANONICAL if not (ROOT / path).is_file())
    if missing:
        fail("missing canonical files: " + ", ".join(missing))

    truth = load(TRUTH)
    if truth.get("schemaVersion") != 1 or truth.get("program") != "hepta-paper-rust-rewrite":
        fail("program identity/schema drift")
    if truth.get("truthStatus") != "canonical":
        fail("program truth is not canonical")
    generated = obj(truth.get("generatedFrom"), "generatedFrom")
    if generated.get("planVersion") != "4.1" or generated.get("repository") != "TrillionniumFoundation/hepta-paper":
        fail("Plan v4 generatedFrom drift")
    for key in ("baselineCommit", "baselineTree"):
        if not isinstance(generated.get(key), str) or not SHA.fullmatch(generated[key]):
            fail(f"invalid generatedFrom.{key}")
    if set(arr(truth.get("statusVocabulary"), "statusVocabulary")) != STATUSES:
        fail("status vocabulary drift")
    if set(arr(truth.get("evidenceTiers"), "evidenceTiers")) != TIERS:
        fail("evidence-tier vocabulary drift")

    current = obj(truth.get("current"), "current")
    expected_current = {
        "staticTruthMode": "implementation_only",
        "effectiveQualificationSource": "exact_head_workflow_artifact",
        "productionActivation": "disabled", "realCodexCredentials": "forbidden",
        "liveProviderCalls": "forbidden", "campaignWriterAuthority": "absent",
        "releaseAuthority": "absent", "submissionAuthority": "absent",
    }
    for key, expected in expected_current.items():
        if current.get(key) != expected:
            fail(f"current.{key} must be {expected}")

    policy = obj(truth.get("qualificationPolicy"), "qualificationPolicy")
    expected_policy = {
        "version": 2,
        "staticSourceMaySelfAssertQualified": False,
        "headChangeInvalidatesEffectiveQualification": True,
        "zeroJobRunIsFailure": True,
        "skippedRequiredJobIsFailure": True,
        "externalGapsNeverAutoPromote": True,
        "supplementalBlockersNeverAutoPromote": True,
        "requiredResult": "completed_success",
        "derivedArtifact": "effective-status.v1.json",
        "promotion": "capability_specific_source_implemented_to_source_qualified",
        "schema": "qualification/effective-status-v1.schema.json",
        "producerManifest": "qualification/source-check-producers.v1.json",
        "capabilityEvidence": "qualification/source-capability-evidence.v1.json",
        "requiredCheckOriginBinding": "workflow_id_path_git_blob_sha256_event_pr_run_attempt_job_steps",
        "producerRunMutationInvalidatesEffectiveQualification": True,
        "fullSchemaValidationRequired": True,
        "artifactValidity": "live_revalidation_required",
        "revalidationWorkflow": ".github/workflows/rust-source-qualification-revalidation.yml",
        "revalidationContext": "source-qualification-current",
    }
    for key, expected in expected_policy.items():
        if policy.get(key) != expected:
            fail(f"qualificationPolicy.{key} drift")

    product = obj(truth.get("currentStatusRows"), "currentStatusRows")
    for key, status in product.items():
        static_status(key, status)
    if labelled_rows(STATUS_MD, set(product)) != product:
        fail("CURRENT_STATUS projection drift")

    backlog = obj(truth.get("backlogItemStatus"), "backlogItemStatus")
    for key, status in backlog.items():
        if not BACKLOG_ID.fullmatch(key):
            fail(f"invalid backlog id: {key}")
        static_status(key, status)
    if table(BACKLOG_MD, BACKLOG_ID, 2) != backlog:
        fail("backlog projection drift")

    parity = obj(truth.get("parityItemStatus"), "parityItemStatus")
    for key, status in parity.items():
        if not PARITY_ID.fullmatch(key):
            fail(f"invalid parity id: {key}")
        static_status(key, status)
    if table(PARITY_MD, PARITY_ID, 5) != parity:
        fail("parity projection drift")
    dependencies = obj(truth.get("parityDependencies"), "parityDependencies")
    if set(dependencies) != set(parity):
        fail("parity dependency key drift")
    for parity_id, values in dependencies.items():
        rows = arr(values, f"dependencies for {parity_id}")
        if len(rows) != len(set(rows)):
            fail(f"duplicate parity dependency: {parity_id}")
        if parity[parity_id] == "source_implemented" and not rows:
            fail(f"promotable parity row has no dependency: {parity_id}")
        for dependency in rows:
            if dependency not in backlog:
                fail(f"unknown parity dependency: {parity_id}->{dependency}")

    workstreams = arr(truth.get("workstreams"), "workstreams")
    seen: set[str] = set()
    for raw in workstreams:
        row = obj(raw, "workstream")
        identifier = row.get("id")
        if not isinstance(identifier, str) or identifier in seen:
            fail(f"invalid/duplicate workstream: {identifier}")
        seen.add(identifier)
        static_status(identifier, row.get("status"), row)
        if row.get("evidenceTier") not in TIERS:
            fail(f"invalid workstream tier: {identifier}")

    gaps = arr(truth.get("gaps"), "gaps")
    external: dict[str, tuple[str, int]] = {}
    for raw in gaps:
        row = obj(raw, "gap")
        identifier = row.get("id")
        if not isinstance(identifier, str) or not GAP_ID.fullmatch(identifier) or identifier in seen:
            fail(f"invalid/duplicate gap: {identifier}")
        seen.add(identifier)
        status = static_status(identifier, row.get("status"), row)
        if row.get("evidenceTier") not in TIERS or not isinstance(row.get("closesWhen"), list) or not row["closesWhen"]:
            fail(f"invalid gap metadata: {identifier}")
        if row.get("external") is True:
            issue = row.get("issue")
            if not isinstance(issue, int) or issue <= 0:
                fail(f"external gap lacks issue: {identifier}")
            if status == "blocked_external" and row.get("repositoryLocalStatus") != "source_implemented":
                fail(f"external gap lacks repositoryLocalStatus: {identifier}")
            external[identifier] = (status, issue)
        elif status == "blocked_external":
            fail(f"internal gap cannot be blocked_external: {identifier}")
    for path in (STATUS_MD, BACKLOG_MD):
        if issue_rows(path, set(external)) != external:
            fail(f"external gap ledger drift: {path.name}")

    supplemental: dict[str, tuple[str, int]] = {}
    for raw in arr(truth.get("supplementalBlockers"), "supplementalBlockers"):
        row = obj(raw, "supplemental blocker")
        identifier = row.get("id")
        if not isinstance(identifier, str) or identifier in seen:
            fail(f"invalid/duplicate supplemental blocker: {identifier}")
        seen.add(identifier)
        if static_status(identifier, row.get("status"), row) != "blocked_external" or row.get("external") is not True:
            fail(f"supplemental blocker must be external/blocked: {identifier}")
        issue = row.get("issue")
        if not isinstance(issue, int) or issue <= 0 or row.get("repositoryLocalStatus") != "source_implemented":
            fail(f"invalid supplemental blocker metadata: {identifier}")
        supplemental[identifier] = ("blocked_external", issue)
    if supplemental != {"LEGACY-REPLAY-001": ("blocked_external", 28)}:
        fail("supplemental blocker drift")
    for path in (STATUS_MD, BACKLOG_MD):
        if issue_rows(path, set(supplemental)) != supplemental:
            fail(f"supplemental ledger drift: {path.name}")

    packages = arr(load(PACKAGE_MAP).get("packages"), "external packages")
    mapped: set[str] = set()
    package_ids: set[str] = set()
    for raw in packages:
        row = obj(raw, "external package")
        gap_id, package_id = row.get("gapId"), row.get("packageId")
        if gap_id not in external or row.get("issue") != external[gap_id][1]:
            fail(f"external package subject drift: {package_id}")
        if not isinstance(package_id, str) or not package_id.startswith("EXT-") or package_id in package_ids:
            fail(f"invalid/duplicate package id: {package_id}")
        if row.get("automaticActivation") is not False:
            fail(f"package may auto-activate: {package_id}")
        schemas = arr(row.get("schemas"), f"schemas for {package_id}")
        if len(schemas) != 1 or not (QUAL / schemas[0]).is_file():
            fail(f"missing package schema: {package_id}")
        package_ids.add(package_id)
        mapped.add(str(gap_id))
    if mapped != set(external):
        fail("external package coverage drift")

    checks = load(CHECKS)
    contexts = arr(checks.get("contexts"), "required contexts")
    if len(contexts) != 20 or len(contexts) != len(set(contexts)) or any(not isinstance(x, str) or not x for x in contexts):
        fail("required contexts must contain 20 unique names")
    if checks.get("acceptedStatus") != "completed" or checks.get("acceptedConclusion") != "success" or checks.get("requiredAppId") != 15368:
        fail("required-check acceptance/app drift")
    forbidden = set(arr(checks.get("forbiddenConclusions"), "forbidden conclusions"))
    if not {"action_required", "failure", "skipped", "cancelled", "timed_out", "stale"} <= forbidden:
        fail("forbidden check conclusions incomplete")
    collector = obj(checks.get("collector"), "collector")
    expected_collector = {
        "workflow": ".github/workflows/rust-effective-source-qualification.yml",
        "context": "derive-effective-source-status",
        "producerManifest": "docs/rust/qualification/source-check-producers.v1.json",
        "capabilityEvidence": "docs/rust/qualification/source-capability-evidence.v1.json",
        "checkEvidenceSchema": "docs/rust/qualification/required-check-evidence-v2.schema.json",
        "effectiveSchema": "docs/rust/qualification/effective-status-v1.schema.json",
        "revalidationWorkflow": ".github/workflows/rust-source-qualification-revalidation.yml",
        "revalidationContext": "source-qualification-current",
        "artifactValidity": "live_revalidation_required",
    }
    for key, expected in expected_collector.items():
        if collector.get(key) != expected:
            fail(f"collector.{key} drift")
    if collector.get("context") in contexts or collector.get("revalidationContext") in contexts:
        fail("collector/revalidation context is circular")
    if checks.get("authority") != {"productionAuthorized": False, "externalAuthorityClaimed": False}:
        fail("required-check manifest claims authority")

    producers = load(PRODUCERS)
    if producers.get("schemaVersion") != 1 or producers.get("kind") != "HeptaSourceCheckProducerManifestV1":
        fail("producer manifest identity drift")
    if producers.get("program") != "hepta-paper-rust-rewrite" or producers.get("repository") != "TrillionniumFoundation/hepta-paper":
        fail("producer manifest program/repository drift")
    if producers.get("status") != "canonical_exact_workflow_producers" or producers.get("requiredAppId") != 15368 or producers.get("acceptedEvent") != "pull_request":
        fail("producer manifest trust policy drift")
    if producers.get("authority") != {"productionAuthorized": False, "externalAuthorityClaimed": False}:
        fail("producer manifest claims authority")
    producer_rows = arr(producers.get("producers"), "producer rows")
    by_context: dict[str, dict[str, Any]] = {}
    workflow_identity: dict[int, tuple[str, str, str]] = {}
    for raw in producer_rows:
        row = obj(raw, "producer")
        if set(row) != {"context", "workflowId", "workflowPath", "workflowGitBlobSha", "workflowSha256"}:
            fail("producer row shape drift")
        context = row.get("context")
        workflow_id = row.get("workflowId")
        path_text = row.get("workflowPath")
        if context not in contexts or context in by_context:
            fail(f"producer context invalid/duplicate: {context}")
        if not isinstance(workflow_id, int) or workflow_id <= 0 or not isinstance(path_text, str):
            fail(f"producer identity invalid: {context}")
        path = ROOT / path_text
        if not path.is_file():
            fail(f"producer workflow missing: {path_text}")
        if row.get("workflowGitBlobSha") != git_blob_sha(path) or row.get("workflowSha256") != sha256_file(path):
            fail(f"producer workflow digest drift: {context}")
        identity = (path_text, row["workflowGitBlobSha"], row["workflowSha256"])
        if workflow_id in workflow_identity and workflow_identity[workflow_id] != identity:
            fail(f"workflow ID maps to multiple definitions: {workflow_id}")
        workflow_identity[workflow_id] = identity
        by_context[str(context)] = row
    if set(by_context) != set(contexts) or len(producer_rows) != len(contexts):
        fail("producer context coverage drift")

    capability_binding_count = validate_capability_manifest(truth, contexts)

    effective_schema = strict_schema(EFFECTIVE_SCHEMA, {
        "schemaVersion": 1, "kind": "HeptaRustEffectiveSourceStatusV1",
        "status": "exact_head_source_qualified", "repository": "TrillionniumFoundation/hepta-paper",
    })
    if "validity" not in effective_schema.get("required", []) or "observedChecks" not in effective_schema.get("required", []):
        fail("effective schema lacks validity/producer evidence")
    authority = effective_schema["properties"]["authority"]["properties"]
    for key in ("productionAuthorized", "campaignWriterActivated", "liveProviderAuthorized", "releaseAuthorized", "submissionAuthorized", "externalAuthorityClaimed"):
        if authority[key].get("const") is not False:
            fail(f"effective schema grants authority: {key}")

    check_schema = strict_schema(CHECK_EVIDENCE_SCHEMA, {
        "schemaVersion": 1, "kind": "HeptaRequiredCheckEvidenceV2",
        "status": "complete_success_snapshot", "repository": "TrillionniumFoundation/hepta-paper",
    })
    if "observedChecks" not in check_schema.get("required", []) or "snapshotIdentity" not in check_schema.get("required", []):
        fail("check-evidence schema lacks producer snapshot identity")

    legacy_schema = strict_schema(LEGACY_SCHEMA, {
        "schemaVersion": 1, "kind": "HeptaLegacyMatrixReplayClosureV1",
        "blockerId": "LEGACY-REPLAY-001", "issue": 28, "decision": "approved",
        "repository": "TrillionniumFoundation/hepta-paper",
    })
    legacy_props = legacy_schema["properties"]
    if legacy_props["archive"]["properties"]["matrixEntries"].get("const") != 263:
        fail("legacy matrix count drift")
    for key in ("productionAuthorized", "externalAuthorityClaimed", "releaseAuthorized", "submissionAuthorized"):
        if legacy_props["authority"]["properties"][key].get("const") is not False:
            fail(f"legacy replay schema grants authority: {key}")

    revalidation = (ROOT / ".github/workflows/rust-source-qualification-revalidation.yml").read_text(encoding="utf-8")
    for needle in ("workflow_run:", "source-qualification-current", "collect-required-checks.py", "verify-effective-status-current.py"):
        if needle not in revalidation:
            fail(f"revalidation workflow lacks {needle}")
    for workflow_name in sorted({Path(identity[0]).stem for identity in workflow_identity.values()}):
        if workflow_name not in revalidation:
            fail(f"revalidation workflow does not observe producer: {workflow_name}")

    candidate = obj(truth.get("qualificationCandidate"), "qualificationCandidate")
    if candidate.get("branch") != "codex/rust-plan-v4-rc1-20260831" or candidate.get("binding") != "exact_head_workflow_evidence":
        fail("qualification candidate drift")
    if "commit" in candidate or "tree" in candidate or candidate.get("productionAuthority") is not False:
        fail("qualification candidate is self-staling or activating")

    for path, needles in {
        DOC / "RUST_REWRITE_MASTER_PLAN.md": ("plan v4.1", "source_implemented", "effective-status.v1.json"),
        DOC / "QUALIFICATION_STATE_MACHINE.md": ("source_implemented", "source_qualified", "zero-job"),
        STATUS_MD: ("source_implemented", "source_qualified", "LEGACY-REPLAY-001"),
    }.items():
        text = path.read_text(encoding="utf-8")
        for needle in needles:
            if needle not in text:
                fail(f"{path.name} lacks {needle}")

    print(json.dumps({
        "status": "rust_plan_v4_program_truth_valid", "schemaVersion": 1,
        "workstreams": len(workstreams), "gaps": len(gaps),
        "externalGaps": len(external), "supplementalBlockers": len(supplemental),
        "backlogItems": len(backlog), "parityItems": len(parity),
        "currentStatusRows": len(product), "requiredContexts": len(contexts),
        "producerWorkflows": len(workflow_identity),
        "capabilityBindings": capability_binding_count,
        "canonicalFiles": len(CANONICAL),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError) as error:
        print(f"rust Plan v4 program truth invalid: {error}", file=sys.stderr)
        raise SystemExit(1)
