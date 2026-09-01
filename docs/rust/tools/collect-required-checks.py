#!/usr/bin/env python3
"""Collect a producer-authenticated, exact-head GitHub Actions job matrix.

A context name and the shared GitHub Actions App identity are not sufficient.
Every accepted job is bound to a checked-in workflow ID/path/blob/digest,
pull-request event and subject, workflow run/attempt, check suite, job ID, and
non-empty step execution. The newest eligible producer run is authoritative;
a newer non-successful rerun invalidates every older success.
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
    "action_required", "cancelled", "failure", "startup_failure", "stale", "timed_out",
}


def fail(message: str) -> None:
    raise ValueError(message)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


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
    parser.add_argument(
        "--required-checks",
        default="docs/rust/qualification/source-required-checks.v1.json",
        type=Path,
    )
    parser.add_argument(
        "--producer-manifest",
        default="docs/rust/qualification/source-check-producers.v1.json",
        type=Path,
    )
    parser.add_argument(
        "--evidence-schema",
        default="docs/rust/qualification/required-check-evidence-v2.schema.json",
        type=Path,
    )
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
            "User-Agent": "hepta-rust-required-check-collector-v2",
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
        value = fetch_json(f"{base_url}{separator}per_page=100&page={page}", token)
        current = value.get(list_key)
        if not isinstance(current, list) or any(not isinstance(row, dict) for row in current):
            fail(f"github_api_list_shape_invalid:{list_key}")
        pages.append(value)
        rows.extend(current)
        if len(current) < 100:
            break
        page += 1
        if page > 20:
            fail(f"github_api_pagination_overflow:{list_key}")
    return rows, pages


def load_policy(required_path: Path, producer_path: Path, repository: str) -> tuple[dict[str, Any], dict[str, Any], list[str], dict[str, dict[str, Any]]]:
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
        missing = sorted(set(contexts) - set(by_context))
        extra = sorted(set(by_context) - set(contexts))
        fail(f"producer_context_coverage_invalid:missing={missing}:extra={extra}")
    return required, producers, contexts, by_context


def pr_binding_matches(run: dict[str, Any], pull_request: int, base_ref: str, commit: str) -> bool:
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
        if base.get("ref") == base_ref and head.get("sha") == commit:
            return True
    return False


def normalize_steps(job: dict[str, Any], context: str) -> list[dict[str, Any]]:
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
        if conclusion in BAD_CONCLUSIONS:
            fail(f"required_job_step_failed:{context}:{name}:{conclusion}")
        if status == "completed" and conclusion == "success" and name not in {"Set up job", "Complete job"}:
            successful_execution = True
        steps.append({"number": number, "name": name, "status": status, "conclusion": conclusion})
    if not successful_execution:
        fail(f"required_job_lacks_successful_execution_step:{context}")
    return steps


def run_key(run: dict[str, Any]) -> tuple[int, int]:
    identifier = run.get("id")
    attempt = run.get("run_attempt", 1)
    if not isinstance(identifier, int) or identifier <= 0 or not isinstance(attempt, int) or attempt <= 0:
        fail("workflow_run_identity_invalid")
    return identifier, attempt


def select_snapshot(
    *,
    required: dict[str, Any],
    producers: dict[str, Any],
    contexts: list[str],
    by_context: dict[str, dict[str, Any]],
    workflow_runs: list[dict[str, Any]],
    jobs_by_attempt: dict[tuple[int, int], list[dict[str, Any]]],
    check_runs: list[dict[str, Any]],
    repository: str,
    commit: str,
    tree: str,
    head_branch: str,
    base_ref: str,
    pull_request: int,
    required_path: Path,
    producer_path: Path,
) -> dict[str, Any]:
    accepted_event = producers["acceptedEvent"]
    required_app_id = required["requiredAppId"]
    workflow_specs: dict[int, dict[str, Any]] = {}
    for context in contexts:
        spec = by_context[context]
        workflow_specs.setdefault(spec["workflowId"], spec)

    eligible_by_workflow: dict[int, list[dict[str, Any]]] = {workflow_id: [] for workflow_id in workflow_specs}
    all_eligible_run_ids: dict[int, set[int]] = {workflow_id: set() for workflow_id in workflow_specs}
    for run in workflow_runs:
        workflow_id = run.get("workflow_id")
        if workflow_id not in workflow_specs:
            continue
        spec = workflow_specs[workflow_id]
        if run.get("path") != spec["workflowPath"]:
            continue
        if run.get("event") != accepted_event or run.get("head_sha") != commit or run.get("head_branch") != head_branch:
            continue
        if not pr_binding_matches(run, pull_request, base_ref, commit):
            continue
        run_key(run)
        eligible_by_workflow[workflow_id].append(run)
        all_eligible_run_ids[workflow_id].add(run["id"])

    selected_runs: dict[int, dict[str, Any]] = {}
    missing_workflows: list[int] = []
    pending_workflows: list[str] = []
    failed_workflows: list[str] = []
    for workflow_id, spec in workflow_specs.items():
        eligible = eligible_by_workflow[workflow_id]
        if not eligible:
            missing_workflows.append(workflow_id)
            continue
        selected = max(eligible, key=run_key)
        selected_runs[workflow_id] = selected
        if selected.get("status") != "completed":
            pending_workflows.append(f"{spec['workflowPath']}:{selected.get('status')}")
        elif selected.get("conclusion") != "success":
            failed_workflows.append(f"{spec['workflowPath']}:{selected.get('conclusion')}")
    if failed_workflows:
        fail("latest_producer_workflow_failed:" + ",".join(sorted(failed_workflows)))
    if missing_workflows or pending_workflows:
        raise RuntimeError(json.dumps({
            "missingWorkflowIds": sorted(missing_workflows),
            "pendingWorkflows": sorted(pending_workflows),
        }, sort_keys=True))

    # Any required-name check emitted by a different workflow/run is a collision.
    for check in check_runs:
        context = check.get("name")
        if context not in by_context or check.get("head_sha") != commit:
            continue
        app = check.get("app")
        if not isinstance(app, dict) or app.get("id") != required_app_id:
            fail(f"required_context_wrong_app_collision:{context}")
        details = check.get("details_url") or check.get("html_url")
        match = RUN_URL.search(details) if isinstance(details, str) else None
        if match is None:
            fail(f"required_context_unbound_run_url:{context}")
        run_id = int(match.group(1))
        expected_workflow_id = by_context[context]["workflowId"]
        if run_id not in all_eligible_run_ids[expected_workflow_id]:
            fail(f"required_context_producer_collision:{context}:run={run_id}")

    checks_by_id: dict[int, dict[str, Any]] = {}
    for check in check_runs:
        identifier = check.get("id")
        if isinstance(identifier, int) and identifier > 0:
            if identifier in checks_by_id:
                fail(f"duplicate_check_run_id:{identifier}")
            checks_by_id[identifier] = check

    observed: list[dict[str, Any]] = []
    for context in contexts:
        spec = by_context[context]
        run = selected_runs[spec["workflowId"]]
        key = run_key(run)
        jobs = jobs_by_attempt.get(key)
        if not isinstance(jobs, list) or not jobs:
            fail(f"selected_workflow_has_zero_jobs:{spec['workflowPath']}:{key}")
        matches = [job for job in jobs if job.get("name") == context]
        if len(matches) != 1:
            fail(f"required_job_missing_or_duplicate:{context}:count={len(matches)}")
        job = matches[0]
        job_id = job.get("id")
        if not isinstance(job_id, int) or job_id <= 0:
            fail(f"required_job_id_invalid:{context}")
        if job.get("run_id") not in (None, run["id"]):
            fail(f"required_job_run_id_mismatch:{context}")
        if job.get("head_sha") not in (None, commit):
            fail(f"required_job_head_mismatch:{context}")
        if job.get("status") != "completed" or job.get("conclusion") != "success":
            fail(f"required_job_not_successful:{context}:{job.get('status')}:{job.get('conclusion')}")
        steps = normalize_steps(job, context)
        check = checks_by_id.get(job_id)
        if check is None:
            fail(f"required_job_check_run_missing:{context}:{job_id}")
        if check.get("name") != context or check.get("head_sha") != commit:
            fail(f"required_job_check_binding_mismatch:{context}")
        app = check.get("app")
        if not isinstance(app, dict) or app.get("id") != required_app_id:
            fail(f"required_job_check_app_mismatch:{context}")
        check_suite = check.get("check_suite")
        check_suite_id = check_suite.get("id") if isinstance(check_suite, dict) else None
        if not isinstance(check_suite_id, int) or check_suite_id <= 0:
            fail(f"required_job_check_suite_missing:{context}")
        if check.get("status") != "completed" or check.get("conclusion") != "success":
            fail(f"required_check_not_successful:{context}")
        observed.append({
            "context": context,
            "workflowId": spec["workflowId"],
            "workflowPath": spec["workflowPath"],
            "workflowGitBlobSha": spec["workflowGitBlobSha"],
            "workflowSha256": spec["workflowSha256"],
            "event": run["event"],
            "runId": run["id"],
            "runAttempt": run.get("run_attempt", 1),
            "runNumber": run.get("run_number"),
            "checkSuiteId": check_suite_id,
            "jobId": job_id,
            "jobName": job.get("name"),
            "headSha": commit,
            "headBranch": head_branch,
            "baseRef": base_ref,
            "pullRequestNumber": pull_request,
            "status": "completed",
            "conclusion": "success",
            "startedAt": job.get("started_at") or check.get("started_at"),
            "completedAt": job.get("completed_at") or check.get("completed_at"),
            "detailsUrl": check.get("details_url") or check.get("html_url"),
            "steps": steps,
        })

    identity_subject = {
        "repository": repository,
        "commit": commit,
        "tree": tree,
        "pullRequestNumber": pull_request,
        "baseRef": base_ref,
        "headBranch": head_branch,
        "producerManifestSha256": sha256_file(producer_path),
        "requiredChecksSha256": sha256_file(required_path),
        "observedChecks": observed,
    }
    snapshot_identity = sha256_bytes(canonical_bytes(identity_subject))
    return {
        "schemaVersion": 1,
        "kind": "HeptaRequiredCheckEvidenceV2",
        "status": "complete_success_snapshot",
        "repository": repository,
        "source": {
            "commit": commit,
            "tree": tree,
            "requiredChecksSha256": sha256_file(required_path),
            "producerManifestSha256": sha256_file(producer_path),
        },
        "pullRequest": {
            "number": pull_request,
            "baseRef": base_ref,
            "headBranch": head_branch,
        },
        "requiredContexts": contexts,
        "observedChecks": observed,
        "snapshotIdentity": snapshot_identity,
        "authority": {
            "productionAuthorized": False,
            "externalAuthorityClaimed": False,
        },
    }


def write_raw(root: Path | None, name: str, value: Any) -> None:
    if root is None:
        return
    root.mkdir(parents=True, exist_ok=True)
    (root / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    if args.repository != "TrillionniumFoundation/hepta-paper":
        fail("unexpected_repository")
    if not GIT_SHA.fullmatch(args.commit) or not GIT_SHA.fullmatch(args.tree):
        fail("invalid_commit_or_tree")
    if args.pull_request <= 0 or not args.base_ref or not args.head_branch:
        fail("invalid_pull_request_subject")
    if not args.token:
        fail("missing_github_token")

    required, producers, contexts, by_context = load_policy(
        args.required_checks, args.producer_manifest, args.repository
    )
    collector = required.get("collector")
    if not isinstance(collector, dict):
        fail("collector_policy_invalid")
    maximum_wait = collector.get("maximumWaitSeconds")
    poll_seconds = collector.get("pollSeconds")
    if not isinstance(maximum_wait, int) or maximum_wait <= 0 or not isinstance(poll_seconds, int) or poll_seconds <= 0:
        fail("collector_timing_policy_invalid")

    deadline = time.monotonic() + maximum_wait
    api = args.api_url.rstrip("/")
    while True:
        workflow_runs, workflow_pages = fetch_pages(
            f"{api}/repos/{args.repository}/actions/runs?head_sha={args.commit}&event=pull_request",
            "workflow_runs",
            args.token,
        )
        check_runs, check_pages = fetch_pages(
            f"{api}/repos/{args.repository}/commits/{args.commit}/check-runs",
            "check_runs",
            args.token,
        )
        jobs_by_attempt: dict[tuple[int, int], list[dict[str, Any]]] = {}
        job_pages: dict[str, Any] = {}
        for run in workflow_runs:
            workflow_id = run.get("workflow_id")
            if workflow_id not in {spec["workflowId"] for spec in by_context.values()}:
                continue
            if run.get("head_sha") != args.commit or run.get("event") != "pull_request":
                continue
            run_id, attempt = run_key(run)
            try:
                jobs, pages = fetch_pages(
                    f"{api}/repos/{args.repository}/actions/runs/{run_id}/attempts/{attempt}/jobs",
                    "jobs",
                    args.token,
                )
            except ValueError as error:
                if "github_api_http_error:404" not in str(error):
                    raise
                jobs, pages = fetch_pages(
                    f"{api}/repos/{args.repository}/actions/runs/{run_id}/jobs?filter=latest",
                    "jobs",
                    args.token,
                )
            jobs_by_attempt[(run_id, attempt)] = jobs
            job_pages[f"{run_id}-{attempt}"] = pages

        write_raw(args.raw_output_dir, "workflow-runs.json", workflow_pages)
        write_raw(args.raw_output_dir, "check-runs.json", check_pages)
        write_raw(args.raw_output_dir, "jobs.json", job_pages)
        try:
            snapshot = select_snapshot(
                required=required,
                producers=producers,
                contexts=contexts,
                by_context=by_context,
                workflow_runs=workflow_runs,
                jobs_by_attempt=jobs_by_attempt,
                check_runs=check_runs,
                repository=args.repository,
                commit=args.commit,
                tree=args.tree,
                head_branch=args.head_branch,
                base_ref=args.base_ref,
                pull_request=args.pull_request,
                required_path=args.required_checks,
                producer_path=args.producer_manifest,
            )
        except RuntimeError as pending:
            if time.monotonic() >= deadline:
                fail(f"required_check_matrix_timeout:{pending}")
            print(json.dumps({"status": "waiting_for_authenticated_producer_runs", "detail": str(pending)}, sort_keys=True), flush=True)
            time.sleep(poll_seconds)
            continue
        evidence_schema = json.loads(args.evidence_schema.read_text(encoding="utf-8"))
        validate_schema(snapshot, evidence_schema)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps({
            "status": "producer_authenticated_required_check_matrix_complete",
            "commit": args.commit,
            "tree": args.tree,
            "contexts": len(contexts),
            "snapshotIdentity": snapshot["snapshotIdentity"],
        }, sort_keys=True))
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"required check matrix not accepted: {error}", file=sys.stderr)
        raise SystemExit(1)
