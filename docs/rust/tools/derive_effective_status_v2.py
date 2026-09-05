#!/usr/bin/env python3
"""Wrap the capability-specific V1 effective result in Qualification Subject V3."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

from qualification_subject_integrity import (
    sha256_value, read_json, validate_evidence_pair,
)


def fail(message: str) -> None:
    raise ValueError(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--legacy-effective", required=True, type=Path)
    parser.add_argument("--qualification-subject", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def assert_non_authorizing(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        forbidden_true = {
            "productionAuthorized",
            "productionActivation",
            "production_activation",
            "providerAuthorized",
            "providerCallsAuthorized",
            "provider_authorized",
            "campaignWriterActivated",
            "writerActivated",
            "campaign_writer_activated",
            "releaseAuthorized",
            "release_authorized",
            "submissionAuthorized",
            "submission_authorized",
            "externalAuthorityClaimed",
            "external_authority_claimed",
        }
        for key, nested in value.items():
            if key in forbidden_true and nested is not False:
                fail(f"legacy_effective_authority_escalation:{path}.{key}")
            assert_non_authorizing(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            assert_non_authorizing(nested, f"{path}[{index}]")


def derive(legacy: dict[str, Any], subject: dict[str, Any]) -> dict[str, Any]:
    assert_non_authorizing(legacy)
    validate_evidence_pair(legacy, subject)
    head = subject["pullRequest"]["head"]
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
            "commit": head["commit"],
            "tree": head["tree"],
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
    legacy = read_json(args.legacy_effective)
    subject = read_json(args.qualification_subject)
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
    except (OSError, ValueError, RecursionError) as error:
        print(f"effective source status v2 not derived: {error}", file=sys.stderr)
        raise SystemExit(1)
