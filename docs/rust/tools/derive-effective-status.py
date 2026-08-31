#!/usr/bin/env python3
"""Derive exact-head effective source status from GitHub check-run evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
PROMOTABLE = "source_implemented"
PROMOTED = "source_qualified"
UNCHANGED = {
    "not_started",
    "design_ready",
    "blocked_external",
    "retired",
    "target_host_qualified",
    "external_authority_qualified",
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


def promote_status(status: str) -> str:
    if status == PROMOTABLE:
        return PROMOTED
    if status in UNCHANGED:
        return status
    if status in {"source_qualified", "hosted_installed_qualified"}:
        fail(f"static truth already contains derived status: {status}")
    fail(f"unsupported static status: {status}")


def promote_mapping(mapping: dict[str, str]) -> dict[str, str]:
    return {key: promote_status(value) for key, value in sorted(mapping.items())}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--static-truth",
        default="docs/rust/current-status.v1.json",
        type=Path,
    )
    parser.add_argument(
        "--required-checks",
        default="docs/rust/qualification/source-required-checks.v1.json",
        type=Path,
    )
    parser.add_argument(
        "--effective-schema",
        default="docs/rust/qualification/effective-status-v1.schema.json",
        type=Path,
    )
    parser.add_argument("--check-runs", required=True, type=Path)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--workflow", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--skip-checkout-verification", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.repository != "TrillionniumFoundation/hepta-paper":
        fail("unexpected repository")
    if not GIT_SHA.fullmatch(args.commit) or not GIT_SHA.fullmatch(args.tree):
        fail("commit and tree must be lowercase 40-character Git SHAs")
    if not args.run_id.isdigit() or not args.run_attempt.isdigit():
        fail("run id and attempt must be decimal integers")

    static = json.loads(args.static_truth.read_text(encoding="utf-8"))
    required = json.loads(args.required_checks.read_text(encoding="utf-8"))
    schema = json.loads(args.effective_schema.read_text(encoding="utf-8"))
    evidence = json.loads(args.check_runs.read_text(encoding="utf-8"))

    policy = static.get("qualificationPolicy")
    if not isinstance(policy, dict):
        fail("static truth lacks qualificationPolicy")
    if policy.get("staticSourceMaySelfAssertQualified") is not False:
        fail("static source self-qualification is enabled")
    if policy.get("derivedArtifact") != "effective-status.v1.json":
        fail("unexpected effective artifact name")
    if policy.get("schema") != "qualification/effective-status-v1.schema.json":
        fail("unexpected effective status schema")
    schema_properties = schema.get("properties")
    if not isinstance(schema_properties, dict):
        fail("effective status schema lacks properties")
    for key, expected in {
        "schemaVersion": 1,
        "kind": "HeptaRustEffectiveSourceStatusV1",
        "status": "exact_head_source_qualified",
        "repository": "TrillionniumFoundation/hepta-paper",
    }.items():
        if schema_properties.get(key, {}).get("const") != expected:
            fail(f"effective status schema constant drift: {key}")
    if policy.get("requiredResult") != "completed_success":
        fail("unexpected required result")

    contexts = required.get("contexts")
    if not isinstance(contexts, list) or not contexts or len(contexts) != len(set(contexts)):
        fail("required contexts must be nonempty and unique")
    if required.get("acceptedStatus") != "completed":
        fail("accepted status must be completed")
    if required.get("acceptedConclusion") != "success":
        fail("accepted conclusion must be success")
    required_app_id = required.get("requiredAppId")
    if required_app_id != 15368:
        fail("required checks are not bound to the GitHub Actions app")
    authority = required.get("authority")
    if authority != {
        "productionAuthorized": False,
        "externalAuthorityClaimed": False,
    }:
        fail("required-check manifest claims authority")

    check_runs = evidence.get("check_runs")
    if not isinstance(check_runs, list) or not check_runs:
        fail("zero-job or empty check-run collection cannot qualify source")

    latest: dict[str, dict[str, Any]] = {}
    for raw in check_runs:
        if not isinstance(raw, dict):
            fail("check-run entry must be an object")
        name = raw.get("name")
        if name not in contexts:
            continue
        if raw.get("head_sha") != args.commit:
            fail(f"required check {name} is bound to a different head")
        app = raw.get("app")
        if not isinstance(app, dict) or app.get("id") != required_app_id:
            fail(f"required check {name} is not produced by the required app")
        run_id = raw.get("id")
        if not isinstance(run_id, int) or run_id <= 0:
            fail(f"required check {name} lacks a valid id")
        prior = latest.get(name)
        if prior is None or run_id > prior["id"]:
            latest[name] = raw

    missing = sorted(set(contexts) - set(latest))
    if missing:
        fail(f"required checks are missing: {', '.join(missing)}")

    forbidden = set(required.get("forbiddenConclusions", []))
    observed: list[dict[str, Any]] = []
    for name in contexts:
        run = latest[name]
        status = run.get("status")
        conclusion = run.get("conclusion")
        if status != "completed":
            fail(f"required check is not completed: {name}={status}")
        if conclusion != "success":
            if conclusion in forbidden:
                fail(f"required check has forbidden conclusion: {name}={conclusion}")
            fail(f"required check is not successful: {name}={conclusion}")
        observed.append(
            {
                "name": name,
                "id": run["id"],
                "status": status,
                "conclusion": conclusion,
                "headSha": run["head_sha"],
                "startedAt": run.get("started_at"),
                "completedAt": run.get("completed_at"),
                "detailsUrl": run.get("details_url"),
                "appId": required_app_id,
            }
        )

    if not args.skip_checkout_verification:
        if command("git", "rev-parse", "HEAD") != args.commit:
            fail("checked-out commit does not match requested commit")
        if command("git", "rev-parse", "HEAD^{tree}") != args.tree:
            fail("checked-out tree does not match requested tree")
        if command("git", "status", "--porcelain=v1", "--untracked-files=all"):
            fail("worktree is not clean before effective-status derivation")

    current_rows = static.get("currentStatusRows")
    backlog = static.get("backlogItemStatus")
    parity = static.get("parityItemStatus")
    workstreams = static.get("workstreams")
    gaps = static.get("gaps")
    supplemental = static.get("supplementalBlockers")
    if not all(
        isinstance(value, expected)
        for value, expected in (
            (current_rows, dict),
            (backlog, dict),
            (parity, dict),
            (workstreams, list),
            (gaps, list),
            (supplemental, list),
        )
    ):
        fail("static truth is missing effective-status source fields")

    effective_workstreams = []
    for raw in workstreams:
        if not isinstance(raw, dict):
            fail("workstream must be an object")
        row = dict(raw)
        row["status"] = promote_status(str(row["status"]))
        if row["status"] == PROMOTED:
            row["evidenceTier"] = "source"
        if row.get("repositoryLocalStatus") == PROMOTABLE:
            row["repositoryLocalStatus"] = PROMOTED
        effective_workstreams.append(row)

    effective_gaps = []
    for raw in gaps:
        if not isinstance(raw, dict):
            fail("gap must be an object")
        row = dict(raw)
        if row.get("external") is True:
            if row.get("repositoryLocalStatus") == PROMOTABLE:
                row["repositoryLocalStatus"] = PROMOTED
        else:
            row["status"] = promote_status(str(row["status"]))
            if row["status"] == PROMOTED:
                row["evidenceTier"] = "source"
        effective_gaps.append(row)

    effective_supplemental = []
    for raw in supplemental:
        if not isinstance(raw, dict):
            fail("supplemental blocker must be an object")
        row = dict(raw)
        if row.get("repositoryLocalStatus") == PROMOTABLE:
            row["repositoryLocalStatus"] = PROMOTED
        effective_supplemental.append(row)

    bound_files = [
        args.static_truth,
        Path("docs/rust/CURRENT_STATUS.md"),
        Path("docs/rust/RUST_REWRITE_MASTER_PLAN.md"),
        Path("docs/rust/RUST_REWRITE_BACKLOG.md"),
        Path("docs/rust/RUST_PARITY_MATRIX.md"),
        Path("docs/rust/QUALIFICATION_STATE_MACHINE.md"),
        args.required_checks,
        args.effective_schema,
        Path("docs/rust/qualification/external-package-map.v1.json"),
        Path("rust/Cargo.toml"),
        Path("rust/Cargo.lock"),
    ]
    file_digests = {}
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
            "boundFiles": file_digests,
        },
        "workflow": {
            "name": args.workflow,
            "runId": int(args.run_id),
            "runAttempt": int(args.run_attempt),
        },
        "requiredContexts": contexts,
        "observedChecks": observed,
        "effective": {
            "currentStatusRows": promote_mapping(current_rows),
            "workstreams": effective_workstreams,
            "backlogItemStatus": promote_mapping(backlog),
            "parityItemStatus": promote_mapping(parity),
            "gaps": effective_gaps,
            "supplementalBlockers": effective_supplemental,
        },
        "invalidation": {
            "headChangeInvalidates": True,
            "requiredCheckRerunInvalidatesOnNonSuccess": True,
            "missingOrSkippedJobInvalidates": True,
            "dirtyWorktreeInvalidates": True,
            "staticTruthDigestChangeInvalidates": True,
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

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    if not args.skip_checkout_verification:
        if command("git", "rev-parse", "HEAD") != args.commit:
            fail("commit changed during effective-status derivation")
        if command("git", "rev-parse", "HEAD^{tree}") != args.tree:
            fail("tree changed during effective-status derivation")
        if command("git", "status", "--porcelain=v1", "--untracked-files=all"):
            fail("worktree became dirty during effective-status derivation")

    print(
        json.dumps(
            {
                "status": artifact["status"],
                "commit": args.commit,
                "tree": args.tree,
                "requiredContexts": len(contexts),
                "observedChecks": len(observed),
                "output": str(args.output),
                "productionAuthorized": False,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"effective source status not derived: {error}", file=sys.stderr)
        raise SystemExit(1)
