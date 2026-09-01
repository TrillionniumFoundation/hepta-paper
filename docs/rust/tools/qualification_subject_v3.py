#!/usr/bin/env python3
"""Collect an exact Qualification Subject V3 from live GitHub state.

The subject binds the exact base/head/prospective-merge identity and every
eligible workflow run attempt. A canonical successful run is still selected per
workflow, but a later rerun of an older run is rejected rather than ignored.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys
from typing import Any
import urllib.error
import urllib.request

GIT_SHA = __import__("re").compile(r"^[0-9a-f]{40}$")
BAD_CONCLUSIONS = {
    "action_required",
    "cancelled",
    "failure",
    "neutral",
    "skipped",
    "stale",
    "startup_failure",
    "timed_out",
}


def fail(message: str) -> None:
    raise ValueError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_value(value: Any) -> str:
    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return f"sha256:{hasher.hexdigest()}"


def git_blob_sha(path: Path) -> str:
    content = path.read_bytes()
    return hashlib.sha1(
        b"blob " + str(len(content)).encode("ascii") + b"\0" + content
    ).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--pull-request", required=True, type=int)
    parser.add_argument("--head-commit", required=True)
    parser.add_argument("--head-tree", required=True)
    parser.add_argument("--head-branch", required=True)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument(
        "--producer-manifest",
        default="docs/rust/qualification/source-check-producers.v1.json",
        type=Path,
    )
    parser.add_argument(
        "--required-checks",
        default="docs/rust/qualification/source-required-checks.v1.json",
        type=Path,
    )
    parser.add_argument("--check-evidence", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--raw-output-dir", type=Path)
    return parser.parse_args()


def fetch_json(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hepta-qualification-subject-v3",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        fail(f"github_api_http_error:{error.code}:{url}")
    except (urllib.error.URLError, TimeoutError) as error:
        fail(f"github_api_failed:{error}:{url}")
    if not isinstance(value, dict):
        fail(f"github_api_object_required:{url}")
    return value


def fetch_pages(
    base_url: str,
    list_key: str,
    token: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    separator = "&" if "?" in base_url else "?"
    for page in range(1, 21):
        value = fetch_json(
            f"{base_url}{separator}per_page=100&page={page}",
            token,
        )
        current = value.get(list_key)
        if not isinstance(current, list) or any(
            not isinstance(row, dict) for row in current
        ):
            fail(f"github_api_list_shape_invalid:{list_key}")
        pages.append(value)
        rows.extend(current)
        if len(current) < 100:
            return rows, pages
    fail(f"github_api_pagination_overflow:{list_key}")


def write_raw(root: Path | None, name: str, value: Any) -> None:
    if root is None:
        return
    root.mkdir(parents=True, exist_ok=True)
    (root / name).write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def required_policy(
    repository: str,
    required_path: Path,
    producer_path: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[int, dict[str, Any]]]:
    required = json.loads(required_path.read_text(encoding="utf-8"))
    producers = json.loads(producer_path.read_text(encoding="utf-8"))
    contexts = required.get("contexts")
    if (
        not isinstance(contexts, list)
        or not contexts
        or len(contexts) != len(set(contexts))
    ):
        fail("required_contexts_invalid")
    rows = producers.get("producers")
    if (
        producers.get("kind") != "HeptaSourceCheckProducerManifestV1"
        or producers.get("repository") != repository
        or not isinstance(rows, list)
        or not rows
    ):
        fail("producer_manifest_invalid")
    by_workflow: dict[int, dict[str, Any]] = {}
    observed_contexts: set[str] = set()
    for raw in rows:
        if not isinstance(raw, dict) or set(raw) != {
            "context",
            "workflowId",
            "workflowPath",
            "workflowGitBlobSha",
            "workflowSha256",
        }:
            fail("producer_manifest_row_shape_invalid")
        context = raw["context"]
        workflow_id = raw["workflowId"]
        workflow_path = raw["workflowPath"]
        if context in observed_contexts or context not in contexts:
            fail(f"producer_context_invalid_or_duplicate:{context}")
        if not isinstance(workflow_id, int) or workflow_id <= 0:
            fail(f"producer_workflow_id_invalid:{context}")
        path = Path(workflow_path)
        if not path.is_file():
            fail(f"producer_workflow_missing:{context}:{workflow_path}")
        if (
            raw["workflowGitBlobSha"] != git_blob_sha(path)
            or raw["workflowSha256"] != sha256_file(path)
        ):
            fail(f"producer_workflow_definition_drift:{context}")
        observed_contexts.add(context)
        group = by_workflow.setdefault(
            workflow_id,
            {
                "workflowId": workflow_id,
                "workflowPath": workflow_path,
                "workflowGitBlobSha": raw["workflowGitBlobSha"],
                "workflowSha256": raw["workflowSha256"],
                "requiredContexts": [],
            },
        )
        if (
            group["workflowPath"] != workflow_path
            or group["workflowGitBlobSha"] != raw["workflowGitBlobSha"]
            or group["workflowSha256"] != raw["workflowSha256"]
        ):
            fail(f"workflow_id_maps_to_multiple_definitions:{workflow_id}")
        group["requiredContexts"].append(context)
    if observed_contexts != set(contexts):
        fail("producer_context_coverage_invalid")
    for group in by_workflow.values():
        group["requiredContexts"].sort()
    return required, producers, by_workflow


def repo_identity(value: Any) -> tuple[int, str] | None:
    if not isinstance(value, dict):
        return None
    identifier = value.get("id")
    full_name = value.get("full_name")
    if not isinstance(identifier, int) or identifier <= 0 or not isinstance(full_name, str):
        return None
    return identifier, full_name


def pr_binding_matches(
    run: dict[str, Any],
    *,
    pull_request: int,
    base_repo_id: int,
    base_repo: str,
    base_ref: str,
    base_commit: str,
    head_repo_id: int,
    head_repo: str,
    head_branch: str,
    head_commit: str,
) -> bool:
    rows = run.get("pull_requests")
    if not isinstance(rows, list):
        return False
    for row in rows:
        if not isinstance(row, dict) or row.get("number") != pull_request:
            continue
        base = row.get("base")
        head = row.get("head")
        if not isinstance(base, dict) or not isinstance(head, dict):
            continue
        if (
            base.get("ref") == base_ref
            and base.get("sha") == base_commit
            and repo_identity(base.get("repo")) == (base_repo_id, base_repo)
            and head.get("ref") == head_branch
            and head.get("sha") == head_commit
            and repo_identity(head.get("repo")) == (head_repo_id, head_repo)
        ):
            return True
    return False


def normalize_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list):
        return []
    result: list[dict[str, Any]] = []
    for raw in raw_steps:
        if not isinstance(raw, dict):
            fail("job_step_shape_invalid")
        number = raw.get("number")
        name = raw.get("name")
        status = raw.get("status")
        conclusion = raw.get("conclusion")
        if not isinstance(number, int) or number <= 0 or not isinstance(name, str) or not name:
            fail("job_step_identity_invalid")
        result.append(
            {
                "number": number,
                "name": name,
                "status": status,
                "conclusion": conclusion,
            }
        )
    return sorted(result, key=lambda row: (row["number"], row["name"]))


def normalize_jobs(raw_jobs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    seen: set[int] = set()
    for raw in raw_jobs:
        identifier = raw.get("id")
        name = raw.get("name")
        if (
            not isinstance(identifier, int)
            or identifier <= 0
            or identifier in seen
            or not isinstance(name, str)
            or not name
        ):
            fail("workflow_job_identity_invalid")
        seen.add(identifier)
        jobs.append(
            {
                "id": identifier,
                "name": name,
                "status": raw.get("status"),
                "conclusion": raw.get("conclusion"),
                "startedAt": raw.get("started_at"),
                "completedAt": raw.get("completed_at"),
                "steps": normalize_steps(raw.get("steps")),
            }
        )
    return sorted(jobs, key=lambda row: row["id"])


def normalize_artifacts(raw_artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    seen: set[int] = set()
    for raw in raw_artifacts:
        identifier = raw.get("id")
        name = raw.get("name")
        if (
            not isinstance(identifier, int)
            or identifier <= 0
            or identifier in seen
            or not isinstance(name, str)
            or not name
        ):
            fail("workflow_artifact_identity_invalid")
        seen.add(identifier)
        artifacts.append(
            {
                "id": identifier,
                "name": name,
                "sizeInBytes": raw.get("size_in_bytes", 0),
                "expired": bool(raw.get("expired")),
                "createdAt": raw.get("created_at"),
                "expiresAt": raw.get("expires_at"),
                "digest": raw.get("digest"),
            }
        )
    return sorted(artifacts, key=lambda row: row["id"])


def successful_execution(job: dict[str, Any]) -> bool:
    if job.get("status") != "completed" or job.get("conclusion") != "success":
        return False
    return any(
        step.get("status") == "completed"
        and step.get("conclusion") == "success"
        and step.get("name") not in {"Set up job", "Complete job"}
        for step in job.get("steps", [])
    )


def validate_history_freshness(
    workflow_path: str,
    required_contexts: list[str],
    attempts: list[dict[str, Any]],
) -> dict[str, Any]:
    if not attempts:
        fail(f"producer_workflow_has_no_eligible_runs:{workflow_path}")
    latest_by_run: dict[int, dict[str, Any]] = {}
    for attempt in attempts:
        run_id = attempt["runId"]
        prior = latest_by_run.get(run_id)
        if prior is None or attempt["runAttempt"] > prior["runAttempt"]:
            latest_by_run[run_id] = attempt
    canonical = max(
        latest_by_run.values(),
        key=lambda row: (row["runNumber"], row["runId"]),
    )
    if canonical["status"] != "completed" or canonical["conclusion"] != "success":
        fail(
            f"canonical_producer_run_not_successful:{workflow_path}:"
            f"{canonical['status']}:{canonical['conclusion']}"
        )
    matches = [job for job in canonical["jobs"] if job["name"] in required_contexts]
    if len(matches) != len(required_contexts):
        fail(f"canonical_required_context_count_invalid:{workflow_path}")
    if {job["name"] for job in matches} != set(required_contexts):
        fail(f"canonical_required_context_set_invalid:{workflow_path}")
    for job in matches:
        if not successful_execution(job):
            fail(f"canonical_required_context_not_nonempty_success:{job['name']}")
    canonical_updated = canonical["updatedAt"]
    for run_id, latest in latest_by_run.items():
        if run_id == canonical["runId"]:
            continue
        if latest["updatedAt"] > canonical_updated:
            fail(
                f"noncanonical_run_mutated_after_canonical:{workflow_path}:"
                f"run={run_id}:attempt={latest['runAttempt']}"
            )
    return canonical


def assemble_subject(
    *,
    repository: dict[str, Any],
    pull_request: dict[str, Any],
    producer_definitions: list[dict[str, Any]],
    histories: list[dict[str, Any]],
    required_check_snapshot_identity: str,
    required_checks_sha256: str,
    producer_manifest_sha256: str,
) -> dict[str, Any]:
    histories = sorted(histories, key=lambda row: (row["workflowId"], row["workflowPath"]))
    all_attempts = [
        attempt
        for history in histories
        for attempt in history["eligibleRuns"]
    ]
    if not all_attempts:
        fail("eligible_run_set_empty")
    watermark = max(attempt["updatedAt"] for attempt in all_attempts)
    selected = [
        {
            "workflowId": history["workflowId"],
            "workflowPath": history["workflowPath"],
            "runId": history["canonicalRunId"],
            "runAttempt": history["canonicalRunAttempt"],
            "updatedAt": history["canonicalUpdatedAt"],
            "requiredContexts": history["requiredContexts"],
        }
        for history in histories
    ]
    artifacts = [
        {
            "workflowId": history["workflowId"],
            "runId": attempt["runId"],
            "runAttempt": attempt["runAttempt"],
            "artifacts": attempt["artifacts"],
        }
        for history in histories
        for attempt in history["eligibleRuns"]
    ]
    definition_subject = {
        "requiredChecksSha256": required_checks_sha256,
        "producerManifestSha256": producer_manifest_sha256,
        "producers": producer_definitions,
    }
    body = {
        "schemaVersion": 3,
        "kind": "QualificationSubjectV3",
        "status": "exact_subject_complete",
        "repository": repository,
        "pullRequest": pull_request,
        "definitionSetHash": sha256_value(definition_subject),
        "eligibleRunSetSha256": sha256_value(histories),
        "producerHistoryWatermark": watermark,
        "selectedRunSetSha256": sha256_value(selected),
        "artifactSetHash": sha256_value(artifacts),
        "requiredCheckSnapshotIdentity": required_check_snapshot_identity,
        "producerHistories": histories,
        "reviewBoundary": "separate_latest_head_merge_gate",
        "authority": {
            "productionAuthorized": False,
            "providerAuthorized": False,
            "campaignWriterActivated": False,
            "releaseAuthorized": False,
            "submissionAuthorized": False,
            "externalAuthorityClaimed": False,
        },
    }
    return {**body, "snapshotIdentity": sha256_value(body)}


def collect(args: argparse.Namespace) -> dict[str, Any]:
    if args.repository != "TrillionniumFoundation/hepta-paper":
        fail("unexpected_repository")
    if (
        args.pull_request <= 0
        or not GIT_SHA.fullmatch(args.head_commit)
        or not GIT_SHA.fullmatch(args.head_tree)
        or not args.head_branch
        or not args.base_ref
        or not args.token
    ):
        fail("qualification_subject_arguments_invalid")

    required, producers, by_workflow = required_policy(
        args.repository,
        args.required_checks,
        args.producer_manifest,
    )
    check_evidence = json.loads(args.check_evidence.read_text(encoding="utf-8"))
    required_snapshot = check_evidence.get("snapshotIdentity")
    source = check_evidence.get("source")
    if (
        check_evidence.get("status") != "complete_success_snapshot"
        or not isinstance(required_snapshot, str)
        or not isinstance(source, dict)
        or source.get("commit") != args.head_commit
        or source.get("tree") != args.head_tree
    ):
        fail("required_check_evidence_not_exact_complete_success")

    api = args.api_url.rstrip("/")
    pr = fetch_json(
        f"{api}/repos/{args.repository}/pulls/{args.pull_request}",
        args.token,
    )
    if pr.get("state") != "open":
        fail("pull_request_not_open")
    base = pr.get("base")
    head = pr.get("head")
    if not isinstance(base, dict) or not isinstance(head, dict):
        fail("pull_request_source_shape_invalid")
    base_repo_identity = repo_identity(base.get("repo"))
    head_repo_identity = repo_identity(head.get("repo"))
    if base_repo_identity is None or head_repo_identity is None:
        fail("pull_request_repository_identity_missing")
    base_repo_id, base_repo = base_repo_identity
    head_repo_id, head_repo = head_repo_identity
    base_commit = base.get("sha")
    merge_commit = pr.get("merge_commit_sha")
    if (
        base.get("ref") != args.base_ref
        or head.get("ref") != args.head_branch
        or head.get("sha") != args.head_commit
        or not isinstance(base_commit, str)
        or not GIT_SHA.fullmatch(base_commit)
        or not isinstance(merge_commit, str)
        or not GIT_SHA.fullmatch(merge_commit)
    ):
        fail("pull_request_exact_identity_mismatch")

    base_git = fetch_json(
        f"{api}/repos/{base_repo}/git/commits/{base_commit}",
        args.token,
    )
    head_git = fetch_json(
        f"{api}/repos/{head_repo}/git/commits/{args.head_commit}",
        args.token,
    )
    merge_git = fetch_json(
        f"{api}/repos/{args.repository}/git/commits/{merge_commit}",
        args.token,
    )
    base_tree = (base_git.get("tree") or {}).get("sha")
    observed_head_tree = (head_git.get("tree") or {}).get("sha")
    merge_tree = (merge_git.get("tree") or {}).get("sha")
    parents = [row.get("sha") for row in merge_git.get("parents", []) if isinstance(row, dict)]
    if (
        not isinstance(base_tree, str)
        or not GIT_SHA.fullmatch(base_tree)
        or observed_head_tree != args.head_tree
        or not isinstance(merge_tree, str)
        or not GIT_SHA.fullmatch(merge_tree)
        or parents != [base_commit, args.head_commit]
    ):
        fail("git_base_head_merge_identity_invalid")

    runs, run_pages = fetch_pages(
        f"{api}/repos/{args.repository}/actions/runs?"
        f"head_sha={args.head_commit}&event=pull_request",
        "workflow_runs",
        args.token,
    )
    write_raw(args.raw_output_dir, "workflow-runs.json", run_pages)

    histories: list[dict[str, Any]] = []
    raw_attempts: dict[str, Any] = {}
    raw_jobs: dict[str, Any] = {}
    raw_artifacts: dict[str, Any] = {}
    producer_definitions: list[dict[str, Any]] = []

    for workflow_id, specification in sorted(by_workflow.items()):
        eligible = [
            run
            for run in runs
            if run.get("workflow_id") == workflow_id
            and run.get("path") == specification["workflowPath"]
            and run.get("event") == "pull_request"
            and run.get("head_sha") == args.head_commit
            and run.get("head_branch") == args.head_branch
            and pr_binding_matches(
                run,
                pull_request=args.pull_request,
                base_repo_id=base_repo_id,
                base_repo=base_repo,
                base_ref=args.base_ref,
                base_commit=base_commit,
                head_repo_id=head_repo_id,
                head_repo=head_repo,
                head_branch=args.head_branch,
                head_commit=args.head_commit,
            )
        ]
        if not eligible:
            fail(f"producer_workflow_has_no_exact_runs:{specification['workflowPath']}")
        attempt_rows: list[dict[str, Any]] = []
        for run in eligible:
            run_id = run.get("id")
            current_attempt = run.get("run_attempt", 1)
            run_number = run.get("run_number")
            if (
                not isinstance(run_id, int)
                or run_id <= 0
                or not isinstance(current_attempt, int)
                or current_attempt <= 0
                or not isinstance(run_number, int)
                or run_number <= 0
            ):
                fail("workflow_run_identity_invalid")
            artifacts, artifact_pages = fetch_pages(
                f"{api}/repos/{args.repository}/actions/runs/{run_id}/artifacts",
                "artifacts",
                args.token,
            )
            normalized_artifacts = normalize_artifacts(artifacts)
            raw_artifacts[str(run_id)] = artifact_pages
            for attempt_number in range(1, current_attempt + 1):
                if attempt_number == current_attempt:
                    attempt_meta = run
                else:
                    attempt_meta = fetch_json(
                        f"{api}/repos/{args.repository}/actions/runs/"
                        f"{run_id}/attempts/{attempt_number}",
                        args.token,
                    )
                jobs, job_pages = fetch_pages(
                    f"{api}/repos/{args.repository}/actions/runs/"
                    f"{run_id}/attempts/{attempt_number}/jobs",
                    "jobs",
                    args.token,
                )
                normalized_jobs = normalize_jobs(jobs)
                flattened_steps = [
                    {"jobId": job["id"], **step}
                    for job in normalized_jobs
                    for step in job["steps"]
                ]
                check_suite_id = attempt_meta.get("check_suite_id")
                if not isinstance(check_suite_id, int) or check_suite_id <= 0:
                    fail("workflow_run_check_suite_invalid")
                row = {
                    "workflowId": workflow_id,
                    "workflowPath": specification["workflowPath"],
                    "runId": run_id,
                    "runNumber": run_number,
                    "runAttempt": attempt_number,
                    "event": "pull_request",
                    "headSha": args.head_commit,
                    "headBranch": args.head_branch,
                    "baseRef": args.base_ref,
                    "baseCommit": base_commit,
                    "status": attempt_meta.get("status"),
                    "conclusion": attempt_meta.get("conclusion"),
                    "createdAt": attempt_meta.get("created_at"),
                    "updatedAt": attempt_meta.get("updated_at"),
                    "checkSuiteId": check_suite_id,
                    "jobs": normalized_jobs,
                    "jobSetSha256": sha256_value(normalized_jobs),
                    "stepSetSha256": sha256_value(flattened_steps),
                    "artifacts": normalized_artifacts,
                    "artifactSetSha256": sha256_value(normalized_artifacts),
                }
                attempt_rows.append(row)
                raw_attempts[f"{run_id}-{attempt_number}"] = attempt_meta
                raw_jobs[f"{run_id}-{attempt_number}"] = job_pages
        attempt_rows.sort(
            key=lambda row: (row["runNumber"], row["runId"], row["runAttempt"])
        )
        canonical = validate_history_freshness(
            specification["workflowPath"],
            specification["requiredContexts"],
            attempt_rows,
        )
        histories.append(
            {
                "workflowId": workflow_id,
                "workflowPath": specification["workflowPath"],
                "requiredContexts": specification["requiredContexts"],
                "canonicalRunId": canonical["runId"],
                "canonicalRunAttempt": canonical["runAttempt"],
                "canonicalUpdatedAt": canonical["updatedAt"],
                "eligibleRuns": attempt_rows,
                "historyHash": sha256_value(attempt_rows),
            }
        )
        producer_definitions.append(specification)

    write_raw(args.raw_output_dir, "attempts.json", raw_attempts)
    write_raw(args.raw_output_dir, "jobs.json", raw_jobs)
    write_raw(args.raw_output_dir, "artifacts.json", raw_artifacts)
    write_raw(args.raw_output_dir, "pull-request.json", pr)
    write_raw(
        args.raw_output_dir,
        "git-identities.json",
        {"base": base_git, "head": head_git, "merge": merge_git},
    )

    subject = assemble_subject(
        repository={"id": int(pr["base"]["repo"]["id"]), "fullName": args.repository},
        pull_request={
            "number": args.pull_request,
            "state": "open",
            "base": {
                "repositoryId": base_repo_id,
                "repository": base_repo,
                "ref": args.base_ref,
                "commit": base_commit,
                "tree": base_tree,
            },
            "head": {
                "repositoryId": head_repo_id,
                "repository": head_repo,
                "ref": args.head_branch,
                "commit": args.head_commit,
                "tree": args.head_tree,
            },
            "testedMerge": {
                "commit": merge_commit,
                "tree": merge_tree,
                "parents": parents,
            },
        },
        producer_definitions=producer_definitions,
        histories=histories,
        required_check_snapshot_identity=required_snapshot,
        required_checks_sha256=sha256_file(args.required_checks),
        producer_manifest_sha256=sha256_file(args.producer_manifest),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(subject, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return subject


def main() -> int:
    args = parse_args()
    subject = collect(args)
    print(
        json.dumps(
            {
                "status": "qualification_subject_v3_collected",
                "snapshotIdentity": subject["snapshotIdentity"],
                "workflows": len(subject["producerHistories"]),
                "attempts": sum(
                    len(row["eligibleRuns"])
                    for row in subject["producerHistories"]
                ),
                "baseCommit": subject["pullRequest"]["base"]["commit"],
                "mergeCommit": subject["pullRequest"]["testedMerge"]["commit"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"qualification subject v3 not accepted: {error}", file=sys.stderr)
        raise SystemExit(1)
