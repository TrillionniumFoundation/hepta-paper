#!/usr/bin/env python3
"""Wrap the capability-specific V1 derivation in an exact V3 subject."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any

from strict_json_schema import validate as validate_schema


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_value(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return f"sha256:{hasher.hexdigest()}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-runs", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--legacy-derive", default="docs/rust/tools/derive-effective-status.py", type=Path)
    parser.add_argument("--legacy-schema", default="docs/rust/qualification/effective-status-v1.schema.json", type=Path)
    parser.add_argument("--schema", default="docs/rust/qualification/effective-status-v2.schema.json", type=Path)
    return parser.parse_args()


def legacy_projection(check: dict[str, Any]) -> dict[str, Any]:
    old_source_keys = ["commit", "tree", "requiredChecksSha256", "producerManifestSha256"]
    old_check_keys = [
        "context", "workflowId", "workflowPath", "workflowGitBlobSha", "workflowSha256",
        "event", "runId", "runAttempt", "runNumber", "checkSuiteId", "jobId", "jobName",
        "headSha", "headBranch", "baseRef", "pullRequestNumber", "status", "conclusion",
        "startedAt", "completedAt", "detailsUrl", "steps",
    ]
    return {
        "schemaVersion": 1,
        "kind": "HeptaRequiredCheckEvidenceV2",
        "status": "complete_success_snapshot",
        "repository": check["repository"],
        "source": {key: check["source"][key] for key in old_source_keys},
        "pullRequest": {
            "number": check["pullRequest"]["number"],
            "baseRef": check["pullRequest"]["baseRef"],
            "headBranch": check["pullRequest"]["headBranch"],
        },
        "requiredContexts": check["requiredContexts"],
        "observedChecks": [{key: row[key] for key in old_check_keys} for row in check["observedChecks"]],
        "snapshotIdentity": check["snapshotIdentity"],
        "authority": {"productionAuthorized": False, "externalAuthorityClaimed": False},
    }


def reject_true_authority(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = key.lower()
            if child is True and any(token in lowered for token in ("authorized", "activated", "authorityclaimed")):
                raise ValueError(f"authorizing_boolean_forbidden:{path}.{key}")
            reject_true_authority(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_true_authority(child, f"{path}[{index}]")


def main() -> int:
    args = parse_args()
    check = json.loads(args.check_runs.read_text(encoding="utf-8"))
    if check.get("schemaVersion") != 3 or check.get("kind") != "HeptaRequiredCheckEvidenceV3":
        raise ValueError("required_check_evidence_v3_required")
    subject = check.get("qualificationSubject")
    if not isinstance(subject, dict) or subject.get("snapshotIdentity") != check.get("snapshotIdentity"):
        raise ValueError("qualification_subject_v3_binding_invalid")
    if args.repository != check.get("repository") or args.commit != check["source"]["commit"] or args.tree != check["source"]["tree"]:
        raise ValueError("effective_status_source_mismatch")
    projection = legacy_projection(check)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hepta-effective-v2-") as temporary:
        root = Path(temporary)
        legacy_check = root / "check-evidence.v2.json"
        legacy_output = root / "effective-status.v1.json"
        legacy_check.write_text(json.dumps(projection, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        completed = subprocess.run([
            sys.executable, str(args.legacy_derive),
            "--check-runs", str(legacy_check),
            "--repository", args.repository,
            "--commit", args.commit,
            "--tree", args.tree,
            "--workflow", args.workflow,
            "--run-id", args.run_id,
            "--run-attempt", args.run_attempt,
            "--output", str(legacy_output),
        ], text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            raise ValueError(f"legacy_effective_derivation_failed:{completed.stderr.strip()}:{completed.stdout.strip()}")
        legacy = json.loads(legacy_output.read_text(encoding="utf-8"))
    legacy_schema = json.loads(args.legacy_schema.read_text(encoding="utf-8"))
    validate_schema(legacy, legacy_schema)
    reject_true_authority(legacy)
    artifact = {
        "schemaVersion": 2,
        "kind": "HeptaEffectiveSourceStatusV2",
        "status": "exact_subject_source_qualified",
        "repository": args.repository,
        "qualificationSubject": subject,
        "source": check["source"],
        "pullRequest": check["pullRequest"],
        "checkEvidenceSha256": sha256_value(check),
        "legacyCheckEvidenceSha256": sha256_value(projection),
        "legacyEffectiveStatusSha256": sha256_value(legacy),
        "legacyEffectiveStatusSchemaSha256": sha256_file(args.legacy_schema),
        "legacyEffectiveStatus": legacy,
        "generatedBy": {
            "workflow": args.workflow,
            "runId": str(args.run_id),
            "runAttempt": str(args.run_attempt),
        },
        "authority": {
            "productionAuthorized": False,
            "externalAuthorityClaimed": False,
            "providerAuthorized": False,
            "campaignWriterActivated": False,
            "releaseAuthorized": False,
            "submissionAuthorized": False,
        },
    }
    validate_schema(artifact, json.loads(args.schema.read_text(encoding="utf-8")))
    args.output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "effective_source_status_v2_derived",
        "snapshotIdentity": subject["snapshotIdentity"],
        "baseCommit": subject["base"]["commit"],
        "mergeCommit": subject["testedMerge"]["commit"],
        "legacyEffectiveStatusSha256": artifact["legacyEffectiveStatusSha256"],
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"effective status V2 not derived: {error}", file=sys.stderr)
        raise SystemExit(1)
