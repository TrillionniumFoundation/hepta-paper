#!/usr/bin/env python3
"""Derive capability-specific exact-head source status from authenticated evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

from strict_json_schema import SchemaValidationError, validate as validate_schema

GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
PROMOTABLE = "source_implemented"
PROMOTED = "source_qualified"
UNCHANGED = {
    "not_started", "design_ready", "blocked_external", "retired",
    "target_host_qualified", "external_authority_qualified",
}
BINDING_SECTIONS = {
    "currentStatusRows",
    "workstreams",
    "workstreamRepositoryLocalStatus",
    "backlogItemStatus",
    "parityItemStatus",
    "gaps",
    "gapRepositoryLocalStatus",
    "supplementalRepositoryLocalStatus",
}


def fail(message: str) -> None:
    raise ValueError(message)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return f"sha256:{hasher.hexdigest()}"


def command(*args: str) -> str:
    return subprocess.check_output(args, text=True).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--static-truth", default="docs/rust/current-status.v1.json", type=Path)
    parser.add_argument("--required-checks", default="docs/rust/qualification/source-required-checks.v1.json", type=Path)
    parser.add_argument("--producer-manifest", default="docs/rust/qualification/source-check-producers.v1.json", type=Path)
    parser.add_argument("--capability-evidence", default="docs/rust/qualification/source-capability-evidence.v1.json", type=Path)
    parser.add_argument("--check-evidence-schema", default="docs/rust/qualification/required-check-evidence-v2.schema.json", type=Path)
    parser.add_argument("--effective-schema", default="docs/rust/qualification/effective-status-v1.schema.json", type=Path)
    parser.add_argument("--check-runs", required=True, type=Path, help="Normalized producer-authenticated check evidence")
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--skip-checkout-verification", action="store_true")
    return parser.parse_args()


def validate_static_status(status: str) -> str:
    if status == PROMOTABLE or status in UNCHANGED:
        return status
    if status in {"source_qualified", "hosted_installed_qualified"}:
        fail(f"static truth already contains derived status: {status}")
    fail(f"unsupported static status: {status}")
    return status


def validate_capability_manifest(
    manifest: dict[str, Any],
    static: dict[str, Any],
    contexts: list[str],
) -> tuple[dict[str, list[str]], int]:
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "HeptaSourceCapabilityEvidenceManifestV1":
        fail("capability evidence manifest identity invalid")
    if manifest.get("program") != "hepta-paper-rust-rewrite" or manifest.get("status") != "canonical_capability_specific_source_evidence":
        fail("capability evidence manifest program/status invalid")
    if manifest.get("authority") != {"productionAuthorized": False, "externalAuthorityClaimed": False}:
        fail("capability evidence manifest claims authority")
    context_sets = manifest.get("contextSets")
    bindings = manifest.get("bindings")
    if not isinstance(context_sets, dict) or not context_sets or not isinstance(bindings, dict):
        fail("capability evidence manifest lacks contextSets/bindings")
    if set(bindings) != BINDING_SECTIONS:
        fail("capability evidence binding section drift")
    for name, values in context_sets.items():
        if not isinstance(name, str) or not name or not isinstance(values, list) or not values:
            fail(f"invalid capability context set: {name}")
        if len(values) != len(set(values)) or any(value not in contexts for value in values):
            fail(f"capability context set contains duplicate/unknown context: {name}")

    resolved: dict[str, list[str]] = {}
    binding_count = 0
    for section, rows in bindings.items():
        if not isinstance(rows, dict):
            fail(f"capability binding section must be an object: {section}")
        for identifier, set_names in rows.items():
            if not isinstance(identifier, str) or not identifier or not isinstance(set_names, list) or not set_names:
                fail(f"invalid capability binding: {section}:{identifier}")
            if len(set_names) != len(set(set_names)) or any(name not in context_sets for name in set_names):
                fail(f"unknown/duplicate context set binding: {section}:{identifier}")
            values: list[str] = []
            for name in set_names:
                for context in context_sets[name]:
                    if context not in values:
                        values.append(context)
            if not values:
                fail(f"resolved capability binding is empty: {section}:{identifier}")
            resolved[f"{section}:{identifier}"] = values
            binding_count += 1

    expected: dict[str, set[str]] = {section: set() for section in BINDING_SECTIONS}
    for identifier, status in static["currentStatusRows"].items():
        validate_static_status(str(status))
        if status == PROMOTABLE:
            expected["currentStatusRows"].add(identifier)
    for row in static["workstreams"]:
        if row["status"] == PROMOTABLE:
            expected["workstreams"].add(row["id"])
        if row.get("repositoryLocalStatus") == PROMOTABLE:
            expected["workstreamRepositoryLocalStatus"].add(row["id"])
    for identifier, status in static["backlogItemStatus"].items():
        if status == PROMOTABLE:
            expected["backlogItemStatus"].add(identifier)
    for identifier, status in static["parityItemStatus"].items():
        if status == PROMOTABLE:
            expected["parityItemStatus"].add(identifier)
    for row in static["gaps"]:
        if row.get("external") is not True and row["status"] == PROMOTABLE:
            expected["gaps"].add(row["id"])
        if row.get("repositoryLocalStatus") == PROMOTABLE:
            expected["gapRepositoryLocalStatus"].add(row["id"])
    for row in static["supplementalBlockers"]:
        if row.get("repositoryLocalStatus") == PROMOTABLE:
            expected["supplementalRepositoryLocalStatus"].add(row["id"])
    for section in BINDING_SECTIONS:
        actual = set(bindings[section])
        if actual != expected[section]:
            fail(f"capability binding coverage drift: {section}:missing={sorted(expected[section]-actual)}:extra={sorted(actual-expected[section])}")
    return resolved, binding_count


def promote(
    section: str,
    identifier: str,
    status: str,
    bindings: dict[str, list[str]],
    successful_contexts: set[str],
) -> str:
    status = validate_static_status(status)
    if status != PROMOTABLE:
        return status
    key = f"{section}:{identifier}"
    required = bindings.get(key)
    if not required:
        fail(f"source_implemented row lacks capability-specific evidence: {key}")
    missing = sorted(set(required) - successful_contexts)
    if missing:
        fail(f"capability-specific evidence missing: {key}:{missing}")
    return PROMOTED


def promote_mapping(
    section: str,
    mapping: dict[str, str],
    bindings: dict[str, list[str]],
    successful_contexts: set[str],
) -> dict[str, str]:
    return {
        key: promote(section, key, str(value), bindings, successful_contexts)
        for key, value in sorted(mapping.items())
    }


def main() -> int:
    args = parse_args()
    if args.repository != "TrillionniumFoundation/hepta-paper":
        fail("unexpected repository")
    if not GIT_SHA.fullmatch(args.commit) or not GIT_SHA.fullmatch(args.tree):
        fail("commit and tree must be lowercase 40-character Git SHAs")
    if not args.run_id.isdigit() or not args.run_attempt.isdigit() or int(args.run_id) <= 0 or int(args.run_attempt) <= 0:
        fail("run id and attempt must be positive decimal integers")

    static = json.loads(args.static_truth.read_text(encoding="utf-8"))
    required = json.loads(args.required_checks.read_text(encoding="utf-8"))
    producer_manifest = json.loads(args.producer_manifest.read_text(encoding="utf-8"))
    capability_manifest = json.loads(args.capability_evidence.read_text(encoding="utf-8"))
    check_schema = json.loads(args.check_evidence_schema.read_text(encoding="utf-8"))
    effective_schema = json.loads(args.effective_schema.read_text(encoding="utf-8"))
    evidence = json.loads(args.check_runs.read_text(encoding="utf-8"))
    validate_schema(evidence, check_schema)

    policy = static.get("qualificationPolicy")
    expected_policy = {
        "staticSourceMaySelfAssertQualified": False,
        "requiredResult": "completed_success",
        "derivedArtifact": "effective-status.v1.json",
        "schema": "qualification/effective-status-v1.schema.json",
        "producerManifest": "qualification/source-check-producers.v1.json",
        "capabilityEvidence": "qualification/source-capability-evidence.v1.json",
        "requiredCheckOriginBinding": "workflow_id_path_git_blob_sha256_event_pr_run_attempt_job_steps",
        "producerRunMutationInvalidatesEffectiveQualification": True,
        "fullSchemaValidationRequired": True,
        "artifactValidity": "live_revalidation_required",
        "revalidationWorkflow": ".github/workflows/rust-source-qualification-revalidation.yml",
        "revalidationContext": "source-qualification-current",
        "promotion": "capability_specific_source_implemented_to_source_qualified",
    }
    if not isinstance(policy, dict) or any(policy.get(key) != value for key, value in expected_policy.items()):
        fail("static truth qualificationPolicy does not enforce Plan v4.1")

    contexts = required.get("contexts")
    if not isinstance(contexts, list) or not contexts or len(contexts) != len(set(contexts)):
        fail("required contexts must be nonempty and unique")
    if required.get("acceptedStatus") != "completed" or required.get("acceptedConclusion") != "success" or required.get("requiredAppId") != 15368:
        fail("required-check acceptance policy drift")
    if evidence["repository"] != args.repository or evidence["source"]["commit"] != args.commit or evidence["source"]["tree"] != args.tree:
        fail("check evidence subject mismatch")
    if evidence["requiredContexts"] != contexts:
        fail("check evidence required-context order/coverage mismatch")
    if evidence["source"]["requiredChecksSha256"] != digest(args.required_checks):
        fail("check evidence required-check manifest digest mismatch")
    if evidence["source"]["producerManifestSha256"] != digest(args.producer_manifest):
        fail("check evidence producer manifest digest mismatch")
    if producer_manifest.get("requiredAppId") != 15368 or producer_manifest.get("acceptedEvent") != "pull_request":
        fail("producer manifest trust policy drift")
    producer_rows = producer_manifest.get("producers")
    if not isinstance(producer_rows, list):
        fail("producer manifest rows missing")
    producers = {row["context"]: row for row in producer_rows if isinstance(row, dict) and isinstance(row.get("context"), str)}
    if set(producers) != set(contexts) or len(producers) != len(producer_rows):
        fail("producer manifest context coverage invalid")

    observed = evidence.get("observedChecks")
    if not isinstance(observed, list) or len(observed) != len(contexts):
        fail("observed check coverage invalid")
    observed_by_context = {row["context"]: row for row in observed}
    if set(observed_by_context) != set(contexts) or len(observed_by_context) != len(observed):
        fail("observed check duplicate/context drift")
    successful_contexts: set[str] = set()
    for context in contexts:
        row = observed_by_context[context]
        spec = producers[context]
        for key in ("workflowId", "workflowPath", "workflowGitBlobSha", "workflowSha256"):
            if row[key] != spec[key]:
                fail(f"observed producer definition mismatch: {context}:{key}")
        if row["event"] != "pull_request" or row["headSha"] != args.commit:
            fail(f"observed producer event/head mismatch: {context}")
        if row["status"] != "completed" or row["conclusion"] != "success" or not row["steps"]:
            fail(f"observed required job not successful/nonempty: {context}")
        successful_contexts.add(context)

    bindings, binding_count = validate_capability_manifest(capability_manifest, static, contexts)

    parity_dependencies = static.get("parityDependencies")
    if not isinstance(parity_dependencies, dict) or set(parity_dependencies) != set(static["parityItemStatus"]):
        fail("parity dependency map drift")
    for identifier, status in static["parityItemStatus"].items():
        deps = parity_dependencies[identifier]
        if not isinstance(deps, list) or len(deps) != len(set(deps)):
            fail(f"parity dependencies invalid: {identifier}")
        if status == PROMOTABLE and not deps:
            fail(f"promotable parity row has no capability dependency: {identifier}")
        if any(dep not in static["backlogItemStatus"] for dep in deps):
            fail(f"parity dependency is unknown: {identifier}")

    if not args.skip_checkout_verification:
        if command("git", "rev-parse", "HEAD") != args.commit:
            fail("checked-out commit does not match requested commit")
        if command("git", "rev-parse", "HEAD^{tree}") != args.tree:
            fail("checked-out tree does not match requested tree")
        if command("git", "status", "--porcelain=v1", "--untracked-files=all"):
            fail("worktree is not clean before effective-status derivation")

    current_rows = static["currentStatusRows"]
    backlog = static["backlogItemStatus"]
    parity = static["parityItemStatus"]
    workstreams = static["workstreams"]
    gaps = static["gaps"]
    supplemental = static["supplementalBlockers"]

    effective_backlog = promote_mapping("backlogItemStatus", backlog, bindings, successful_contexts)
    effective_parity: dict[str, str] = {}
    for identifier, status in sorted(parity.items()):
        promoted = promote("parityItemStatus", identifier, str(status), bindings, successful_contexts)
        if promoted == PROMOTED:
            missing_dependencies = [dep for dep in parity_dependencies[identifier] if effective_backlog.get(dep) != PROMOTED]
            if missing_dependencies:
                fail(f"parity capability dependencies are not qualified: {identifier}:{missing_dependencies}")
        effective_parity[identifier] = promoted

    effective_workstreams = []
    for raw in workstreams:
        row = dict(raw)
        row["status"] = promote("workstreams", row["id"], str(row["status"]), bindings, successful_contexts)
        if row["status"] == PROMOTED:
            row["evidenceTier"] = "source"
        if row.get("repositoryLocalStatus") == PROMOTABLE:
            row["repositoryLocalStatus"] = promote(
                "workstreamRepositoryLocalStatus", row["id"], PROMOTABLE, bindings, successful_contexts
            )
        effective_workstreams.append(row)

    effective_gaps = []
    for raw in gaps:
        row = dict(raw)
        if row.get("external") is True:
            if row.get("repositoryLocalStatus") == PROMOTABLE:
                row["repositoryLocalStatus"] = promote(
                    "gapRepositoryLocalStatus", row["id"], PROMOTABLE, bindings, successful_contexts
                )
        else:
            row["status"] = promote("gaps", row["id"], str(row["status"]), bindings, successful_contexts)
            if row["status"] == PROMOTED:
                row["evidenceTier"] = "source"
        effective_gaps.append(row)

    effective_supplemental = []
    for raw in supplemental:
        row = dict(raw)
        if row.get("repositoryLocalStatus") == PROMOTABLE:
            row["repositoryLocalStatus"] = promote(
                "supplementalRepositoryLocalStatus", row["id"], PROMOTABLE, bindings, successful_contexts
            )
        effective_supplemental.append(row)

    workflow_paths = sorted({row["workflowPath"] for row in producer_rows})
    bound_files = [
        args.static_truth,
        Path("docs/rust/CURRENT_STATUS.md"),
        Path("docs/rust/RUST_REWRITE_MASTER_PLAN.md"),
        Path("docs/rust/RUST_REWRITE_BACKLOG.md"),
        Path("docs/rust/RUST_PARITY_MATRIX.md"),
        Path("docs/rust/QUALIFICATION_STATE_MACHINE.md"),
        args.required_checks,
        args.producer_manifest,
        args.capability_evidence,
        args.check_evidence_schema,
        args.effective_schema,
        Path("docs/rust/qualification/external-package-map.v1.json"),
        Path("docs/rust/tools/collect-required-checks.py"),
        Path("docs/rust/tools/derive-effective-status.py"),
        Path("docs/rust/tools/verify-effective-status-current.py"),
        Path("docs/rust/tools/strict_json_schema.py"),
        Path("docs/rust/tools/qualification_subject_integrity.py"),
        Path("docs/rust/tools/qualification_subject_v3.py"),
        Path("docs/rust/tools/derive_effective_status_v2.py"),
        Path("docs/rust/tools/verify_effective_status_v2_current.py"),
        Path("docs/rust/tools/run-qualification-subject-v3.sh"),
        Path("docs/qualification/schemas/qualification-subject-runtime-v3.schema.json"),
        Path("docs/rust/qualification/effective-status-runtime-v2.schema.json"),
        Path(".github/workflows/rust-effective-source-qualification.yml"),
        Path(".github/workflows/rust-source-qualification-revalidation.yml"),
        Path("rust/Cargo.toml"),
        Path("rust/Cargo.lock"),
    ] + [Path(path) for path in workflow_paths]
    file_digests: dict[str, str] = {}
    for path in bound_files:
        if not path.is_file():
            fail(f"bound source file is missing: {path}")
        file_digests[path.as_posix()] = digest(path)

    artifact = {
        "schemaVersion": 1,
        "kind": "HeptaRustEffectiveSourceStatusV1",
        "status": "exact_head_source_qualified",
        "repository": args.repository,
        "source": {
            "commit": args.commit,
            "tree": args.tree,
            "staticTruthSha256": digest(args.static_truth),
            "requiredChecksSha256": digest(args.required_checks),
            "producerManifestSha256": digest(args.producer_manifest),
            "capabilityEvidenceSha256": digest(args.capability_evidence),
            "checkEvidenceSha256": digest(args.check_runs),
            "effectiveSchemaSha256": digest(args.effective_schema),
            "boundFiles": dict(sorted(file_digests.items())),
        },
        "pullRequest": dict(evidence["pullRequest"]),
        "workflow": {
            "name": args.workflow,
            "runId": int(args.run_id),
            "runAttempt": int(args.run_attempt),
        },
        "requiredContexts": contexts,
        "observedChecks": observed,
        "effective": {
            "currentStatusRows": promote_mapping("currentStatusRows", current_rows, bindings, successful_contexts),
            "workstreams": effective_workstreams,
            "backlogItemStatus": effective_backlog,
            "parityItemStatus": effective_parity,
            "gaps": effective_gaps,
            "supplementalBlockers": effective_supplemental,
        },
        "validity": {
            "mode": "live_revalidation_required",
            "snapshotIdentity": evidence["snapshotIdentity"],
            "consumerMustRevalidateBeforeMergeOrActivation": True,
            "revalidatorPath": "docs/rust/tools/verify-effective-status-current.py",
        },
        "invalidation": {
            "headChangeInvalidates": True,
            "producerRunMutationInvalidates": True,
            "requiredCheckRerunInvalidatesOnNonSuccess": True,
            "missingOrSkippedJobInvalidates": True,
            "dirtyWorktreeInvalidates": True,
            "staticTruthDigestChangeInvalidates": True,
            "producerDefinitionChangeInvalidates": True,
            "capabilityEvidenceChangeInvalidates": True,
        },
        "authority": {
            "productionAuthorized": False,
            "campaignWriterActivated": False,
            "liveProviderAuthorized": False,
            "releaseAuthorized": False,
            "submissionAuthorized": False,
            "externalAuthorityClaimed": False,
            "classification": "exact_head_repository_source_evidence_only",
        },
    }
    validate_schema(artifact, effective_schema)
    if binding_count <= 0:
        fail("capability evidence binding count is zero")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if not args.skip_checkout_verification:
        if command("git", "rev-parse", "HEAD") != args.commit or command("git", "rev-parse", "HEAD^{tree}") != args.tree:
            fail("source identity changed during effective-status derivation")
        if command("git", "status", "--porcelain=v1", "--untracked-files=all"):
            fail("worktree became dirty during effective-status derivation")

    print(json.dumps({
        "status": artifact["status"],
        "commit": args.commit,
        "tree": args.tree,
        "requiredContexts": len(contexts),
        "observedChecks": len(observed),
        "capabilityBindings": binding_count,
        "snapshotIdentity": evidence["snapshotIdentity"],
        "output": str(args.output),
        "productionAuthorized": False,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, SchemaValidationError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"effective source status not derived: {error}", file=sys.stderr)
        raise SystemExit(1)
