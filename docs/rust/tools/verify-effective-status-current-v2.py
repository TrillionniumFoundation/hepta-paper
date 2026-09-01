#!/usr/bin/env python3
"""Revalidate an exact-subject V2 effective artifact against live V3 evidence."""
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
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--current-check-runs", required=True, type=Path)
    parser.add_argument("--schema", default="docs/rust/qualification/effective-status-v2.schema.json", type=Path)
    parser.add_argument("--check-schema", default="docs/rust/qualification/required-check-evidence-v3.schema.json", type=Path)
    parser.add_argument("--subject-schema", default="docs/qualification/schemas/qualification-subject-v3.schema.json", type=Path)
    parser.add_argument("--legacy-verify", default="docs/rust/tools/verify-effective-status-current.py", type=Path)
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
    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    current = json.loads(args.current_check_runs.read_text(encoding="utf-8"))
    validate_schema(artifact, json.loads(args.schema.read_text(encoding="utf-8")))
    validate_schema(current, json.loads(args.check_schema.read_text(encoding="utf-8")))
    validate_schema(current["qualificationSubject"], json.loads(args.subject_schema.read_text(encoding="utf-8")))
    if artifact.get("qualificationSubject") != current.get("qualificationSubject"):
        raise ValueError("qualification_subject_v3_not_current")
    if artifact.get("source") != current.get("source") or artifact.get("pullRequest") != current.get("pullRequest"):
        raise ValueError("exact_source_or_pull_request_subject_not_current")
    if artifact.get("checkEvidenceSha256") != sha256_value(current):
        raise ValueError("current_check_evidence_hash_mismatch")
    projection = legacy_projection(current)
    if artifact.get("legacyCheckEvidenceSha256") != sha256_value(projection):
        raise ValueError("legacy_check_projection_hash_mismatch")
    legacy = artifact.get("legacyEffectiveStatus")
    if not isinstance(legacy, dict) or artifact.get("legacyEffectiveStatusSha256") != sha256_value(legacy):
        raise ValueError("legacy_effective_status_hash_mismatch")
    legacy_schema = Path("docs/rust/qualification/effective-status-v1.schema.json")
    if artifact.get("legacyEffectiveStatusSchemaSha256") != sha256_file(legacy_schema):
        raise ValueError("legacy_effective_schema_hash_mismatch")
    reject_true_authority(artifact)
    with tempfile.TemporaryDirectory(prefix="hepta-effective-current-v2-") as temporary:
        root = Path(temporary)
        legacy_artifact = root / "effective-status.v1.json"
        legacy_check = root / "check-evidence.v2.json"
        legacy_artifact.write_text(json.dumps(legacy, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        legacy_check.write_text(json.dumps(projection, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        completed = subprocess.run([
            sys.executable, str(args.legacy_verify),
            "--artifact", str(legacy_artifact),
            "--current-check-runs", str(legacy_check),
        ], text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            raise ValueError(f"legacy_live_revalidation_failed:{completed.stderr.strip()}:{completed.stdout.strip()}")
    print(json.dumps({
        "status": "effective_source_status_v2_current",
        "snapshotIdentity": current["snapshotIdentity"],
        "baseCommit": current["pullRequest"]["base"]["commit"],
        "mergeCommit": current["pullRequest"]["testedMerge"]["commit"],
        "eligibleRuns": len(current["eligibleRuns"]),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"effective status V2 not current: {error}", file=sys.stderr)
        raise SystemExit(1)
