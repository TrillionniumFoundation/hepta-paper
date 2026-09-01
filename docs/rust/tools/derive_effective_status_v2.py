#!/usr/bin/env python3
"""Wrap the capability-specific V1 effective result in Qualification Subject V3."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
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
    parser.add_argument("--legacy-effective", required=True, type=Path)
    parser.add_argument("--qualification-subject", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def source_identity(value: Any) -> tuple[str, str] | None:
    if not isinstance(value, dict):
        return None
    source = value.get("source")
    if isinstance(source, dict):
        commit = source.get("commit") or source.get("headCommit")
        tree = source.get("tree") or source.get("headTree")
        if isinstance(commit, str) and isinstance(tree, str):
            return commit, tree
    commit = value.get("commit")
    tree = value.get("tree")
    if isinstance(commit, str) and isinstance(tree, str):
        return commit, tree
    for nested in value.values():
        found = source_identity(nested)
        if found is not None:
            return found
    return None


def assert_non_authorizing(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        forbidden_true = {
            "productionAuthorized",
            "productionActivation",
            "providerAuthorized",
            "providerCallsAuthorized",
            "campaignWriterActivated",
            "writerActivated",
            "releaseAuthorized",
            "submissionAuthorized",
            "externalAuthorityClaimed",
        }
        for key, nested in value.items():
            if key in forbidden_true and nested is not False:
                fail(f"legacy_effective_authority_escalation:{path}.{key}")
            assert_non_authorizing(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            assert_non_authorizing(nested, f"{path}[{index}]")


def validate_subject(subject: dict[str, Any]) -> None:
    if (
        subject.get("schemaVersion") != 3
        or subject.get("kind") != "QualificationSubjectV3"
        or subject.get("status") != "exact_subject_complete"
    ):
        fail("qualification_subject_identity_invalid")
    snapshot = subject.get("snapshotIdentity")
    body = dict(subject)
    body.pop("snapshotIdentity", None)
    if snapshot != sha256_value(body):
        fail("qualification_subject_snapshot_hash_invalid")
    authority = subject.get("authority")
    if not isinstance(authority, dict) or any(authority.values()):
        fail("qualification_subject_authority_invalid")


def derive(legacy: dict[str, Any], subject: dict[str, Any]) -> dict[str, Any]:
    validate_subject(subject)
    assert_non_authorizing(legacy)
    identity = source_identity(legacy)
    expected = (
        subject["pullRequest"]["head"]["commit"],
        subject["pullRequest"]["head"]["tree"],
    )
    if identity != expected:
        fail(f"legacy_effective_source_mismatch:{identity}:{expected}")
    base = subject["pullRequest"]["base"]
    merge = subject["pullRequest"]["testedMerge"]
    authority = {
        "productionAuthorized": False,
        "providerAuthorized": False,
        "campaignWriterActivated": False,
        "releaseAuthorized": False,
        "submissionAuthorized": False,
        "externalAuthorityClaimed": False,
    }
    return {
        "schemaVersion": 2,
        "kind": "HeptaEffectiveSourceStatusV2",
        "status": "source_qualified_nonactivating",
        "repository": "TrillionniumFoundation/hepta-paper",
        "source": {
            "commit": expected[0],
            "tree": expected[1],
            "baseCommit": base["commit"],
            "baseTree": base["tree"],
            "mergeCommit": merge["commit"],
            "mergeTree": merge["tree"],
        },
        "qualificationSubject": subject,
        "qualificationSubjectSha256": sha256_value(subject),
        "legacyEffectiveStatus": legacy,
        "legacyEffectiveStatusSha256": sha256_value(legacy),
        "authority": authority,
    }


def main() -> int:
    args = parse_args()
    legacy = json.loads(args.legacy_effective.read_text(encoding="utf-8"))
    subject = json.loads(args.qualification_subject.read_text(encoding="utf-8"))
    result = derive(legacy, subject)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "status": "effective_source_status_v2_derived",
                "commit": result["source"]["commit"],
                "baseCommit": result["source"]["baseCommit"],
                "mergeCommit": result["source"]["mergeCommit"],
                "snapshotIdentity": subject["snapshotIdentity"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"effective source status v2 not derived: {error}", file=sys.stderr)
        raise SystemExit(1)
