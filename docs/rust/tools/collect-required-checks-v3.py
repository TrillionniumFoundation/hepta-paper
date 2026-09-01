#!/usr/bin/env python3
"""Collect an exact QualificationSubjectV3 and authenticated check matrix.

The V3 subject binds the exact base/head/prospective-merge Git objects and the
complete current attempt state of every eligible producer run. A non-selected
older run rerun therefore invalidates the prior subject instead of being hidden
behind the numerically newest run ID.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time
from typing import Any
import urllib.error
import urllib.request

from strict_json_schema import validate as validate_schema

GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
RUN_URL = re.compile(r"/actions/runs/(\d+)(?:/job/\d+)?")
BAD_CONCLUSIONS = {
    "action_required", "cancelled", "failure", "neutral", "skipped", "stale",
    "startup_failure", "timed_out",
}


def fail(message: str) -> None:
    raise ValueError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def sha256_value(value: Any) -> str:
    return sha256_bytes(canonical_bytes(value))


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return f"sha256:{hasher.hexdigest()}"


def git_blob_sha(path: Path) -> str:
    content = path.read_bytes()
    return hashlib.sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--head-branch", required=True)
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--pull-request", required=True, type=int)
    parser.add_argument("--token", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--required-checks", default="docs/rust/qualification/source-required-checks.v1.json", type=Path)
    parser.add_argument("--producer-manifest", default="docs/rust/qualification/source-check-producers.v1.json", type=Path)
    parser.add_argument("--evidence-schema", default="docs/rust/qualification/required-check-evidence-v3.schema.json", type=Path)
    parser.add_argument("--subject-schema", default="docs/qualification/schemas/qualification-subject-v3.schema.json", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--raw-output-dir", type=Path)
    return parser.parse_args()


def request_json(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hepta-rust-required-check-collector-v3",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        fail(f"github_api_http_error:{error.code}:{url}")
    except (urllib.error.URLError, TimeoutError) as error:
        fail(f"github_api_failed:{error}:{url}")
    if not isinstance(value, dict):
        fail(f"github_api_object_required:{url}")
    return value


def fetch_pages(base_url: str, list_key: str, token: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    page = 1
    separator = "&" if "?" in base_url else "?"
    while True:
        value = request_json(f"{base_url}{separator}per_page=100&page={page}", token)
        current = value.get(list_key)
        if not isinstance(current, list) or any(not isinstance(row, dict) for row in current):
            fail(f"github_api_list_shape_invalid:{list_key}")
        pages.append(value)
        rows.extend(current)
        if len(current) < 100:
            break
        page += 1
        if page > 30:
            fail(f"github_api_pagination_overflow:{list_key}")
    return rows, pages


def write_raw(root: Path | None, name: str, value: Any) -> None:
    if root is None:
        return
    root.mkdir(parents=True, exist_ok=True)
    (root / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def load_policy(required_path: Path, producer_path: Path, repository: str) -> tuple[dict[str, Any], list[str], dict[str, dict[str, Any]]]:
    required = json.loads(required_path.read_text(encoding="utf-8"))
    producers = json.loads(producer_path.read_text(encoding="utf-8"))
    contexts = required.get("contexts")
    if not isinstance(contexts, list) or not contexts or len(contexts) != len(set(contexts)):
        fail("required_contexts_invalid")
    if any(not isinstance(context, str) or not context for context in contexts):
        fail("required_context_name_invalid")
    if required.get("acceptedStatus") != "completed" or required.get("acceptedConclusion") != "success":
        fail("required_result_policy_invalid")
    app_id = required.get("requiredAppId")
    if app_id != 15368:
        fail("required_app_policy_invalid")
    if producers.get("schemaVersion") != 1 or producers.get("kind") != "HeptaSourceCheckProducerManifestV1":
        fail("producer_manifest_identity_invalid")
    if producers.get("repository") != repository or producers.get("requiredAppId") != app_id:
        fail("producer_manifest_repository_or_app_invalid")
    if producers.get("acceptedEvent") != "pull_request":
        fail("producer_manifest_event_invalid")
    raw_rows = producers.get("producers")
    if not isinstance(raw_rows, list) or not raw_rows:
        fail("producer_manifest_rows_invalid")
    by_context: dict[str, dict[str, Any]] = {}
    workflow_identity: dict[int, tuple[str, str, str]] = {}
    for raw in raw_rows:
        if not isinstance(raw, dict) or set(raw) != {
            "context", "workflowId", "workflowPath", "workflowGitBlobSha", "workflowSha256"
        }:
            fail("producer_manifest_row_shape_invalid")
        context = raw["context"]
        workflow_id = raw["workflowId"]
        path_text = raw["workflowPath"]
        if context in by_context or context not in contexts:
            fail(f"producer_context_invalid_or_duplicate:{context}")
        if not isinstance(workflow_id, int) or workflow_id <= 0:
            fail(f"producer_workflow_id_invalid:{context}")
        if not isinstance(path_text, str) or not path_text.startswith(".github/workflows/") or not path_text.endswith((".yml", ".yaml")):
            fail(f"producer_workflow_path_invalid:{context}")
        path = Path(path_text)
        if not path.is_file():
            fail(f"producer_workflow_missing:{context}:{path_text}")
        actual_sha256 = sha256_file(path)
        actual_blob = git_blob_sha(path)
        if raw["workflowSha256"] != actual_sha256 or raw["workflowGitBlobSha"] != actual_blob:
            fail(f"producer_workflow_definition_drift:{context}")
        identity = (path_text, actual_blob, actual_sha256)
        prior = workflow_identity.setdefault(workflow_id, identity)
        if prior != identity:
            fail(f"workflow_id_maps_to_multiple_definitions:{workflow_id}")
        by_context[context] = dict(raw)
    if set(by_context) != set(contexts):
        fail(f"producer_context_coverage_invalid:missing={sorted(set(contexts)-set(by_context))}:extra={sorted(set(by_context)-set(contexts))}")
    return required, contexts, by_context


def repository_identity(value: Any) -> tuple[int, str]:
    if not isinstance(value, dict):
        fail("repository_identity_missing")
    identifier = value.get("id")
    full_name = value.get("full_name")
    if not isinstance(identifier, int) or identifier <= 0 or not isinstance(full_name, str) or "/" not in full_name:
        fail("repository_identity_invalid")
    return identifier, full_name


def ref_identity(value: Any) -> tuple[str, str, int, str]:
    if not isinstance(value, dict):
        fail("pull_request_ref_missing")
    ref = value.get("ref")
    sha = value.get("sha")
    repo_id, repo_name = repository_identity(value.get("repo"))
    if not isinstance(ref, str) or not ref or not isinstance(sha, str) or not GIT_SHA.fullmatch(sha):
        fail("pull_request_ref_invalid")
    return ref, sha, repo_id, repo_name


def git_tree(api: str, repository: str, commit: str, token: str) -> str:
    value = request_json(f"{api}/repos/{repository}/git/commits/{commit}", token)
    tree = value.get("tree")
    sha = tree.get("sha") if isinstance(tree, dict) else None
    if not isinstance(sha, str) or not GIT_SHA.fullmatch(sha):
        fail(f"git_tree_missing:{repository}:{commit}")
    return sha


def load_exact_pr_subject(api: str, repository: str, pull_request: int, expected_commit: str, expected_tree: str, expected_head_branch: str, expected_base_ref: str, token: str) -> dict[str, Any]:
    pr = request_json(f"{api}/repos/{repository}/pulls/{pull_request}", token)
    if pr.get("number") != pull_request or pr.get("state") != "open":
        fail("pull_request_identity_invalid")
    repo_id, repo_name = repository_identity(pr.get("base", {}).get("repo"))
    base_ref, base_sha, base_repo_id, base_repo = ref_identity(pr.get("base"))
    head_ref, head_sha, head_repo_id, head_repo = ref_identity(pr.get("head"))
    if repo_name != repository or repo_id != base_repo_id:
        fail("base_repository_identity_invalid")
    if head_repo != repository or head_sha != expected_commit or head_ref != expected_head_branch:
        fail("head_subject_mismatch")
    if base_ref != expected_base_ref:
        fail("base_ref_mismatch")
    merge_sha = pr.get("merge_commit_sha")
    if not isinstance(merge_sha, str) or not GIT_SHA.fullmatch(merge_sha):
        raise RuntimeError("prospective_merge_not_materialized")
    base_tree = git_tree(api, base_repo, base_sha, token)
    head_tree = git_tree(api, head_repo, head_sha, token)
    merge_tree = git_tree(api, base_repo, merge_sha, token)
    if head_tree != expected_tree:
        fail("head_tree_mismatch")
    return {
        "repository": {"id": repo_id, "fullName": repository},
        "pullRequestNumber": pull_request,
        "base": {
            "repositoryId": base_repo_id,
            "repository": base_repo,
            "ref": base_ref,
            "commit": base_sha,
            "tree": base_tree,
        },
        "head": {
            "repositoryId": head_repo_id,
            "repository": head_repo,
            "ref": head_ref,
            "commit": head_sha,
            "tree": head_tree,
        },
        "testedMerge": {"commit": merge_sha, "tree": merge_tree},
    }


def pr_binding_matches(run: dict[str, Any], exact: dict[str, Any]) -> bool:
    rows = run.get("pull_requests")
    if not isinstance(rows, list):
        return False
    run_base = run.get("repository")
    run_head = run.get("head_repository")
    run_base_id = run_base.get("id") if isinstance(run_base, dict) else None
    run_base_name = run_base.get("full_name") if isinstance(run_base, dict) else None
    run_head_id = run_head.get("id") if isinstance(run_head, dict) else None
    run_head_name = run_head.get("full_name") if isinstance(run_head, dict) else None
    for row in rows:
        if not isinstance(row, dict) or row.get("number") != exact["pullRequestNumber"]:
            continue
        base = row.get("base")
        head = row.get("head")
        if not isinstance(base, dict) or not isinstance(head, dict):
            continue
        base_repo = base.get("repo")
        head_repo = head.get("repo")
        base_repo_id = base_repo.get("id") if isinstance(base_repo, dict) else run_base_id
        head_repo_id = head_repo.get("id") if isinstance(head_repo, dict) else run_head_id
        base_repo_name = (base_repo.get("full_name") if isinstance(base_repo, dict) else None) or run_base_name
        head_repo_name = (head_repo.get("full_name") if isinstance(head_repo, dict) else None) or run_head_name
        if (
            base.get("ref") == exact["base"]["ref"]
            and base.get("sha") == exact["base"]["commit"]
            and base_repo_id == exact["base"]["repositoryId"]
            and base_repo_name == exact["base"]["repository"]
            and head.get("ref") == exact["head"]["ref"]
            and head.get("sha") == exact["head"]["commit"]
            and head_repo_id == exact["head"]["repositoryId"]
            and head_repo_name == exact["head"]["repository"]
        ):
            return True
    return False


def normalize_steps(job: dict[str, Any], context: str, *, require_successful_execution: bool) -> list[dict[str, Any]]:
    raw_steps = job.get("steps")
    if not isinstance(raw_steps, list) or not raw_steps:
        fail(f"required_job_has_no_steps:{context}")
    steps: list[dict[str, Any]] = []
    successful_execution = False
    for raw in raw_steps:
        if not isinstance(raw, dict):
            fail(f"required_job_step_shape_invalid:{context}")
        number = raw.get("number")
        name = raw.get("name")
        status = raw.get("status")
        conclusion = raw.get("conclusion")
        if not isinstance(number, int) or number <= 0 or not isinstance(name, str) or not name:
            fail(f"required_job_step_identity_invalid:{context}")
        if status not in {"completed", "in_progress", "queued", "pending"}:
            fail(f"required_job_step_status_invalid:{context}:{name}:{status}")
        if require_successful_execution and conclusion in BAD_CONCLUSIONS:
            fail(f"required_job_step_failed:{context}:{name}:{conclusion}")
        if status == "completed" and conclusion == "success" and name not in {"Set up job", "Complete job"}:
            successful_execution = True
        steps.append({"number": number, "name": name, "status": status, "conclusion": conclusion})
    if require_successful_execution and not successful_execution:
        fail(f"required_job_lacks_successful_execution_step:{context}")
    return steps


def normalize_artifacts(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        identifier = row.get("id")
        name = row.get("name")
        if not isinstance(identifier, int) or identifier <= 0 or not isinstance(name, str) or not name:
            fail("workflow_artifact_identity_invalid")
        result.append({
            "id": identifier,
            "name": name,
            "sizeInBytes": row.get("size_in_bytes"),
            "digest": row.get("digest"),
            "expired": row.get("expired"),
            "createdAt": row.get("created_at"),
            "updatedAt": row.get("updated_at"),
        })
    return sorted(result, key=lambda row: (row["name"], row["id"]))


def normalize_jobs(rows: list[dict[str, Any]], run_id: int) -> list[dict[str, Any]]:
    result = []
    for row in rows:
        identifier = row.get("id")
        name = row.get("name")
        if not isinstance(identifier, int) or identifier <= 0 or not isinstance(name, str) or not name:
            fail(f"workflow_job_identity_invalid:{run_id}")
        steps = normalize_steps(row, name, require_successful_execution=False)
        result.append({
            "id": identifier,
            "name": name,
            "status": row.get("status"),
            "conclusion": row.get("conclusion"),
            "startedAt": row.get("started_at"),
            "completedAt": row.get("completed_at"),
            "steps": steps,
        })
    return sorted(result, key=lambda row: (row["name"], row["id"]))


def build_history_row(run: dict[str, Any], spec: dict[str, Any], jobs: list[dict[str, Any]], artifacts: list[dict[str, Any]]) -> dict[str, Any]:
    run_id = run.get("id")
    attempt = run.get("run_attempt", 1)
    if not isinstance(run_id, int) or run_id <= 0 or not isinstance(attempt, int) or attempt <= 0:
        fail("workflow_run_attempt_invalid")
    normalized_jobs = normalize_jobs(jobs, run_id)
    all_steps = [{"jobId": job["id"], **step} for job in normalized_jobs for step in job["steps"]]
    normalized_artifacts = normalize_artifacts(artifacts)
    return {
        "workflowId": spec["workflowId"],
        "workflowPath": spec["workflowPath"],
        "workflowGitBlobSha": spec["workflowGitBlobSha"],
        "workflowSha256": spec["workflowSha256"],
        "runId": run_id,
        "runNumber": run.get("run_number"),
        "runAttempt": attempt,
        "event": run.get("event"),
        "status": run.get("status"),
        "conclusion": run.get("conclusion"),
        "createdAt": run.get("created_at"),
        "updatedAt": run.get("updated_at"),
        "runStartedAt": run.get("run_started_at"),
        "checkSuiteId": run.get("check_suite_id"),
        "jobSetSha256": sha256_value(normalized_jobs),
        "stepSetSha256": sha256_value(all_steps),
        "artifactSetSha256": sha256_value(normalized_artifacts),
        "jobs": normalized_jobs,
        "artifacts": normalized_artifacts,
    }


def qualification_subject(exact: dict[str, Any], definition_set_sha256: str, history: list[dict[str, Any]], selected_runs: list[dict[str, Any]]) -> dict[str, Any]:
    if not history:
        fail("eligible_run_history_empty")
    watermark_values = [row.get("updatedAt") for row in history]
    if any(not isinstance(value, str) or not value for value in watermark_values):
        fail("producer_history_watermark_invalid")
    subject = {
        "schemaVersion": 3,
        "kind": "QualificationSubjectV3",
        **exact,
        "definitionSetSha256": definition_set_sha256,
        "eligibleRunSetSha256": sha256_value(history),
        "producerHistoryWatermark": max(watermark_values),
        "selectedRunSetSha256": sha256_value(selected_runs),
        "artifactSetSha256": sha256_value([
            {"runId": row["runId"], "artifactSetSha256": row["artifactSetSha256"]}
            for row in history
        ]),
    }
    subject["snapshotIdentity"] = sha256_value(subject)
    return subject


def validate_all_eligible_runs(history: list[dict[str, Any]]) -> None:
    pending = []
    failed = []
    for row in history:
        if row["status"] != "completed":
            pending.append(f"{row['workflowPath']}:{row['runId']}:{row['runAttempt']}:{row['status']}")
        elif row["conclusion"] != "success":
            failed.append(f"{row['workflowPath']}:{row['runId']}:{row['runAttempt']}:{row['conclusion']}")
    if failed:
        fail("eligible_producer_attempt_failed:" + ",".join(sorted(failed)))
    if pending:
        raise RuntimeError(json.dumps({"pendingEligibleRuns": sorted(pending)}, sort_keys=True))


def select_snapshot(*, required: dict[str, Any], contexts: list[str], by_context: dict[str, dict[str, Any]], workflow_runs: list[dict[str, Any]], jobs_by_attempt: dict[tuple[int, int], list[dict[str, Any]]], artifacts_by_run: dict[int, list[dict[str, Any]]], check_runs: list[dict[str, Any]], exact: dict[str, Any], required_path: Path, producer_path: Path, api: str, token: str) -> dict[str, Any]:
    workflow_specs: dict[int, dict[str, Any]] = {}
    for context in contexts:
        spec = by_context[context]
        workflow_specs.setdefault(spec["workflowId"], spec)
    eligible: dict[int, list[dict[str, Any]]] = {workflow_id: [] for workflow_id in workflow_specs}
    for run in workflow_runs:
        workflow_id = run.get("workflow_id")
        if workflow_id not in workflow_specs:
            continue
        spec = workflow_specs[workflow_id]
        if run.get("path") != spec["workflowPath"] or run.get("event") != "pull_request":
            continue
        if run.get("head_sha") != exact["head"]["commit"] or run.get("head_branch") != exact["head"]["ref"]:
            continue
        if not pr_binding_matches(run, exact):
            continue
        run_id = run.get("id")
        attempt = run.get("run_attempt", 1)
        if not isinstance(run_id, int) or not isinstance(attempt, int):
            fail("eligible_run_identity_invalid")
        jobs = jobs_by_attempt.get((run_id, attempt))
        if not isinstance(jobs, list) or not jobs:
            fail(f"selected_workflow_has_zero_jobs:{spec['workflowPath']}:{run_id}:{attempt}")
        eligible[workflow_id].append(build_history_row(run, spec, jobs, artifacts_by_run.get(run_id, [])))
    missing = [workflow_id for workflow_id, rows in eligible.items() if not rows]
    if missing:
        raise RuntimeError(json.dumps({"missingWorkflowIds": sorted(missing)}, sort_keys=True))
    history = sorted([row for rows in eligible.values() for row in rows], key=lambda row: (row["workflowId"], row["createdAt"], row["runId"]))
    validate_all_eligible_runs(history)
    selected_by_workflow = {workflow_id: max(rows, key=lambda row: (row["createdAt"], row["runId"])) for workflow_id, rows in eligible.items()}
    selected_rows = sorted([
        {"workflowId": workflow_id, "runId": row["runId"], "runAttempt": row["runAttempt"], "jobSetSha256": row["jobSetSha256"], "stepSetSha256": row["stepSetSha256"], "artifactSetSha256": row["artifactSetSha256"]}
        for workflow_id, row in selected_by_workflow.items()
    ], key=lambda row: row["workflowId"])
    definition_subject = sorted({
        (spec["workflowId"], spec["workflowPath"], spec["workflowGitBlobSha"], spec["workflowSha256"])
        for spec in by_context.values()
    })
    definition_set_sha256 = sha256_value([
        {"workflowId": row[0], "workflowPath": row[1], "workflowGitBlobSha": row[2], "workflowSha256": row[3]}
        for row in definition_subject
    ])
    subject = qualification_subject(exact, definition_set_sha256, history, selected_rows)
    checks_by_id: dict[int, dict[str, Any]] = {}
    for check in check_runs:
        identifier = check.get("id")
        if isinstance(identifier, int) and identifier > 0:
            if identifier in checks_by_id:
                fail(f"duplicate_check_run_id:{identifier}")
            checks_by_id[identifier] = check
    observed = []
    eligible_run_ids_by_workflow = {workflow_id: {row["runId"] for row in rows} for workflow_id, rows in eligible.items()}
    run_event_cache: dict[int, str | None] = {}
    for context in contexts:
        spec = by_context[context]
        selected = selected_by_workflow[spec["workflowId"]]
        jobs = selected["jobs"]
        matches = [job for job in jobs if job["name"] == context]
        if len(matches) != 1:
            fail(f"required_job_missing_or_duplicate:{context}:count={len(matches)}")
        job = matches[0]
        if job["status"] != "completed" or job["conclusion"] != "success":
            fail(f"required_job_not_successful:{context}:{job['status']}:{job['conclusion']}")
        raw_job = next(row for row in jobs_by_attempt[(selected["runId"], selected["runAttempt"])] if row.get("id") == job["id"])
        steps = normalize_steps(raw_job, context, require_successful_execution=True)
        check = checks_by_id.get(job["id"])
        if check is None:
            fail(f"required_job_check_run_missing:{context}:{job['id']}")
        app = check.get("app")
        if check.get("name") != context or check.get("head_sha") != exact["head"]["commit"] or not isinstance(app, dict) or app.get("id") != required["requiredAppId"]:
            fail(f"required_job_check_binding_mismatch:{context}")
        details = check.get("details_url") or check.get("html_url")
        match = RUN_URL.search(details) if isinstance(details, str) else None
        if match is None or int(match.group(1)) != selected["runId"]:
            fail(f"required_job_check_run_mismatch:{context}")
        check_suite = check.get("check_suite")
        check_suite_id = check_suite.get("id") if isinstance(check_suite, dict) else None
        if not isinstance(check_suite_id, int) or check_suite_id <= 0:
            fail(f"required_job_check_suite_missing:{context}")
        observed.append({
            "context": context,
            "workflowId": spec["workflowId"],
            "workflowPath": spec["workflowPath"],
            "workflowGitBlobSha": spec["workflowGitBlobSha"],
            "workflowSha256": spec["workflowSha256"],
            "event": "pull_request",
            "runId": selected["runId"],
            "runAttempt": selected["runAttempt"],
            "runNumber": selected["runNumber"],
            "checkSuiteId": check_suite_id,
            "jobId": job["id"],
            "jobName": job["name"],
            "headSha": exact["head"]["commit"],
            "headBranch": exact["head"]["ref"],
            "baseRef": exact["base"]["ref"],
            "pullRequestNumber": exact["pullRequestNumber"],
            "status": "completed",
            "conclusion": "success",
            "startedAt": job["startedAt"] or check.get("started_at"),
            "completedAt": job["completedAt"] or check.get("completed_at"),
            "detailsUrl": details,
            "steps": steps,
        })
    for check in check_runs:
        context = check.get("name")
        if context not in by_context or check.get("head_sha") != exact["head"]["commit"]:
            continue
        app = check.get("app")
        if not isinstance(app, dict) or app.get("id") != required["requiredAppId"]:
            fail(f"required_context_wrong_app_collision:{context}")
        details = check.get("details_url") or check.get("html_url")
        match = RUN_URL.search(details) if isinstance(details, str) else None
        if match is None:
            fail(f"required_context_unbound_run_url:{context}")
        run_id = int(match.group(1))
        expected_workflow = by_context[context]["workflowId"]
        if run_id in eligible_run_ids_by_workflow[expected_workflow]:
            continue
        if run_id not in run_event_cache:
            try:
                run_event_cache[run_id] = request_json(f"{api}/repos/{exact['repository']['fullName']}/actions/runs/{run_id}", token).get("event")
            except ValueError:
                run_event_cache[run_id] = None
        if run_event_cache[run_id] == "pull_request":
            fail(f"required_context_producer_collision:{context}:run={run_id}")
    return {
        "schemaVersion": 3,
        "kind": "HeptaRequiredCheckEvidenceV3",
        "status": "complete_success_snapshot",
        "repository": exact["repository"]["fullName"],
        "qualificationSubject": subject,
        "source": {
            "commit": exact["head"]["commit"],
            "tree": exact["head"]["tree"],
            "requiredChecksSha256": sha256_file(required_path),
            "producerManifestSha256": sha256_file(producer_path),
            "definitionSetSha256": definition_set_sha256,
            "eligibleRunSetSha256": subject["eligibleRunSetSha256"],
        },
        "pullRequest": {
            "number": exact["pullRequestNumber"],
            "baseRef": exact["base"]["ref"],
            "headBranch": exact["head"]["ref"],
            "base": exact["base"],
            "head": exact["head"],
            "testedMerge": exact["testedMerge"],
        },
        "requiredContexts": contexts,
        "observedChecks": observed,
        "eligibleRuns": history,
        "snapshotIdentity": subject["snapshotIdentity"],
        "authority": {"productionAuthorized": False, "externalAuthorityClaimed": False},
    }


def main() -> int:
    args = parse_args()
    if args.repository != "TrillionniumFoundation/hepta-paper":
        fail("unexpected_repository")
    if not GIT_SHA.fullmatch(args.commit) or not GIT_SHA.fullmatch(args.tree):
        fail("invalid_commit_or_tree")
    if args.pull_request <= 0 or not args.base_ref or not args.head_branch or not args.token:
        fail("invalid_pull_request_subject")
    required, contexts, by_context = load_policy(args.required_checks, args.producer_manifest, args.repository)
    collector = required.get("collector")
    if not isinstance(collector, dict):
        fail("collector_policy_invalid")
    maximum_wait = collector.get("maximumWaitSeconds")
    poll_seconds = collector.get("pollSeconds")
    if not isinstance(maximum_wait, int) or maximum_wait <= 0 or not isinstance(poll_seconds, int) or poll_seconds <= 0:
        fail("collector_timing_policy_invalid")
    deadline = time.monotonic() + maximum_wait
    api = args.api_url.rstrip("/")
    workflow_ids = {spec["workflowId"] for spec in by_context.values()}
    while True:
        try:
            exact_before = load_exact_pr_subject(api, args.repository, args.pull_request, args.commit, args.tree, args.head_branch, args.base_ref, args.token)
            workflow_runs, workflow_pages = fetch_pages(f"{api}/repos/{args.repository}/actions/runs?head_sha={args.commit}&event=pull_request", "workflow_runs", args.token)
            check_runs, check_pages = fetch_pages(f"{api}/repos/{args.repository}/commits/{args.commit}/check-runs", "check_runs", args.token)
            jobs_by_attempt: dict[tuple[int, int], list[dict[str, Any]]] = {}
            artifacts_by_run: dict[int, list[dict[str, Any]]] = {}
            job_pages: dict[str, Any] = {}
            artifact_pages: dict[str, Any] = {}
            for run in workflow_runs:
                if run.get("workflow_id") not in workflow_ids or run.get("event") != "pull_request" or run.get("head_sha") != args.commit:
                    continue
                run_id = run.get("id")
                attempt = run.get("run_attempt", 1)
                if not isinstance(run_id, int) or not isinstance(attempt, int):
                    fail("workflow_run_identity_invalid")
                try:
                    jobs, pages = fetch_pages(f"{api}/repos/{args.repository}/actions/runs/{run_id}/attempts/{attempt}/jobs", "jobs", args.token)
                except ValueError as error:
                    if "github_api_http_error:404" not in str(error):
                        raise
                    jobs, pages = fetch_pages(f"{api}/repos/{args.repository}/actions/runs/{run_id}/jobs?filter=latest", "jobs", args.token)
                artifacts, apages = fetch_pages(f"{api}/repos/{args.repository}/actions/runs/{run_id}/artifacts", "artifacts", args.token)
                jobs_by_attempt[(run_id, attempt)] = jobs
                artifacts_by_run[run_id] = artifacts
                job_pages[f"{run_id}-{attempt}"] = pages
                artifact_pages[str(run_id)] = apages
            write_raw(args.raw_output_dir, "workflow-runs.json", workflow_pages)
            write_raw(args.raw_output_dir, "check-runs.json", check_pages)
            write_raw(args.raw_output_dir, "jobs.json", job_pages)
            write_raw(args.raw_output_dir, "artifacts.json", artifact_pages)
            snapshot = select_snapshot(
                required=required, contexts=contexts, by_context=by_context,
                workflow_runs=workflow_runs, jobs_by_attempt=jobs_by_attempt,
                artifacts_by_run=artifacts_by_run, check_runs=check_runs,
                exact=exact_before, required_path=args.required_checks,
                producer_path=args.producer_manifest, api=api, token=args.token,
            )
            exact_after = load_exact_pr_subject(api, args.repository, args.pull_request, args.commit, args.tree, args.head_branch, args.base_ref, args.token)
            if exact_after != exact_before:
                fail("qualification_subject_changed_during_collection")
        except RuntimeError as pending:
            if time.monotonic() >= deadline:
                fail(f"required_check_matrix_timeout:{pending}")
            print(json.dumps({"status": "waiting_for_qualification_subject_v3", "detail": str(pending)}, sort_keys=True), flush=True)
            time.sleep(poll_seconds)
            continue
        validate_schema(snapshot["qualificationSubject"], json.loads(args.subject_schema.read_text(encoding="utf-8")))
        validate_schema(snapshot, json.loads(args.evidence_schema.read_text(encoding="utf-8")))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps({
            "status": "qualification_subject_v3_matrix_complete",
            "commit": args.commit,
            "tree": args.tree,
            "baseCommit": snapshot["pullRequest"]["base"]["commit"],
            "mergeCommit": snapshot["pullRequest"]["testedMerge"]["commit"],
            "contexts": len(contexts),
            "eligibleRuns": len(snapshot["eligibleRuns"]),
            "snapshotIdentity": snapshot["snapshotIdentity"],
        }, sort_keys=True))
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"QualificationSubjectV3 matrix not accepted: {error}", file=sys.stderr)
        raise SystemExit(1)
