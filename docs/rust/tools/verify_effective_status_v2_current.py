#!/usr/bin/env python3
"""Fail closed unless an effective V2 artifact matches current V3 GitHub state."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_value(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


def fail(message: str) -> None:
    raise ValueError(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--current-subject", required=True, type=Path)
    parser.add_argument("--current-check-runs", required=True, type=Path)
    parser.add_argument(
        "--legacy-verifier",
        default="docs/rust/tools/verify-effective-status-current.py",
        type=Path,
    )
    return parser.parse_args()


def validate_subject(subject: dict[str, Any]) -> None:
    if (
        subject.get("schemaVersion") != 3
        or subject.get("kind") != "QualificationSubjectV3"
        or subject.get("status") != "exact_subject_complete"
    ):
        fail("qualification_subject_identity_invalid")
    body = dict(subject)
    snapshot = body.pop("snapshotIdentity", None)
    if snapshot != sha256_value(body):
        fail("qualification_subject_snapshot_hash_invalid")
    authority = subject.get("authority")
    if not isinstance(authority, dict) or any(authority.values()):
        fail("qualification_subject_authority_invalid")


def verify(
    artifact: dict[str, Any],
    current_subject: dict[str, Any],
    current_check_runs: Path,
    legacy_verifier: Path,
) -> dict[str, Any]:
    if (
        artifact.get("schemaVersion") != 2
        or artifact.get("kind") != "HeptaEffectiveSourceStatusV2"
        or artifact.get("status") != "source_qualified_nonactivating"
        or artifact.get("repository") != "TrillionniumFoundation/hepta-paper"
    ):
        fail("effective_v2_identity_invalid")
    embedded = artifact.get("qualificationSubject")
    legacy = artifact.get("legacyEffectiveStatus")
    if not isinstance(embedded, dict) or not isinstance(legacy, dict):
        fail("effective_v2_embedded_objects_invalid")
    validate_subject(embedded)
    validate_subject(current_subject)
    if artifact.get("qualificationSubjectSha256") != sha256_value(embedded):
        fail("effective_v2_subject_digest_invalid")
    if artifact.get("legacyEffectiveStatusSha256") != sha256_value(legacy):
        fail("effective_v2_legacy_digest_invalid")
    if canonical_bytes(embedded) != canonical_bytes(current_subject):
        fail(
            "qualification_subject_v3_stale:"
            f"artifact={embedded.get('snapshotIdentity')}:"
            f"current={current_subject.get('snapshotIdentity')}"
        )
    source = artifact.get("source")
    if not isinstance(source, dict):
        fail("effective_v2_source_missing")
    base = current_subject["pullRequest"]["base"]
    head = current_subject["pullRequest"]["head"]
    merge = current_subject["pullRequest"]["testedMerge"]
    expected_source = {
        "commit": head["commit"],
        "tree": head["tree"],
        "baseCommit": base["commit"],
        "baseTree": base["tree"],
        "mergeCommit": merge["commit"],
        "mergeTree": merge["tree"],
    }
    if source != expected_source:
        fail("effective_v2_exact_source_mismatch")
    authority = artifact.get("authority")
    if not isinstance(authority, dict) or any(authority.values()):
        fail("effective_v2_authority_escalation")
    if not legacy_verifier.is_file():
        fail("legacy_currentness_verifier_missing")
    with tempfile.TemporaryDirectory(prefix="hepta-effective-v2-") as directory:
        legacy_path = Path(directory) / "legacy-effective-status.v1.json"
        legacy_path.write_text(
            json.dumps(legacy, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(legacy_verifier),
                "--artifact",
                str(legacy_path),
                "--current-check-runs",
                str(current_check_runs),
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            fail(
                "legacy_effective_status_not_current:"
                + (completed.stderr.strip() or completed.stdout.strip())
            )
    return {
        "status": "effective_source_status_v2_current",
        "commit": head["commit"],
        "tree": head["tree"],
        "baseCommit": base["commit"],
        "mergeCommit": merge["commit"],
        "snapshotIdentity": current_subject["snapshotIdentity"],
    }


def main() -> int:
    args = parse_args()
    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    current_subject = json.loads(args.current_subject.read_text(encoding="utf-8"))
    result = verify(
        artifact,
        current_subject,
        args.current_check_runs,
        args.legacy_verifier,
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"effective source status v2 not current: {error}", file=sys.stderr)
        raise SystemExit(1)
