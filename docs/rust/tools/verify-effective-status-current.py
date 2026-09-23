#!/usr/bin/env python3
"""Revalidate an effective-status artifact against the latest producer snapshot.

The artifact is intentionally not a durable capability. Any producer run or
attempt mutation, including a successful rerun, invalidates the prior snapshot
and requires regeneration. A failed latest rerun prevents the collector from
creating current success evidence at all.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from strict_json_schema import SchemaValidationError, validate as validate_schema


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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--current-check-runs", required=True, type=Path)
    parser.add_argument("--effective-schema", default="docs/rust/qualification/effective-status-v1.schema.json", type=Path)
    parser.add_argument("--check-evidence-schema", default="docs/rust/qualification/required-check-evidence-v2.schema.json", type=Path)
    parser.add_argument("--skip-checkout-verification", action="store_true")
    args = parser.parse_args()

    artifact = json.loads(args.artifact.read_text(encoding="utf-8"))
    current = json.loads(args.current_check_runs.read_text(encoding="utf-8"))
    effective_schema = json.loads(args.effective_schema.read_text(encoding="utf-8"))
    check_schema = json.loads(args.check_evidence_schema.read_text(encoding="utf-8"))
    validate_schema(artifact, effective_schema)
    validate_schema(current, check_schema)

    if artifact["repository"] != current["repository"]:
        fail("repository changed since effective-status derivation")
    if artifact["source"]["commit"] != current["source"]["commit"] or artifact["source"]["tree"] != current["source"]["tree"]:
        fail("source commit/tree changed since effective-status derivation")
    if artifact["pullRequest"] != current["pullRequest"]:
        fail("pull-request subject changed since effective-status derivation")
    if artifact["requiredContexts"] != current["requiredContexts"]:
        fail("required context policy changed since effective-status derivation")
    if artifact["validity"]["snapshotIdentity"] != current["snapshotIdentity"]:
        fail("producer run/attempt snapshot changed; effective status must be regenerated")
    if artifact["source"]["checkEvidenceSha256"] != digest(args.current_check_runs):
        fail("current check evidence bytes differ from the qualified snapshot")
    if artifact["observedChecks"] != current["observedChecks"]:
        fail("observed producer/job/step identity changed")
    if artifact["source"]["requiredChecksSha256"] != current["source"]["requiredChecksSha256"]:
        fail("required-check manifest changed")
    if artifact["source"]["producerManifestSha256"] != current["source"]["producerManifestSha256"]:
        fail("producer manifest changed")

    for path_text, expected in artifact["source"]["boundFiles"].items():
        path = Path(path_text)
        if not path.is_file() or digest(path) != expected:
            fail(f"bound source file changed or is missing: {path_text}")

    if not args.skip_checkout_verification:
        if command("git", "rev-parse", "HEAD") != artifact["source"]["commit"]:
            fail("checked-out commit is not the qualified commit")
        if command("git", "rev-parse", "HEAD^{tree}") != artifact["source"]["tree"]:
            fail("checked-out tree is not the qualified tree")
        if command("git", "status", "--porcelain=v1", "--untracked-files=all"):
            fail("worktree is dirty during live revalidation")

    print(json.dumps({
        "status": "effective_source_status_current",
        "commit": artifact["source"]["commit"],
        "tree": artifact["source"]["tree"],
        "snapshotIdentity": current["snapshotIdentity"],
        "productionAuthorized": False,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, SchemaValidationError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"effective source status is not current: {error}", file=sys.stderr)
        raise SystemExit(1)
