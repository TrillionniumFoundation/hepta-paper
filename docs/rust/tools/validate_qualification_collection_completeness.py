#!/usr/bin/env python3
"""Validate completeness/identity of raw GitHub qualification collections.

This is a mandatory post-collection, pre-derivation control. It distrusts a
collector's stopping condition and recomputes pagination completeness from the
saved GitHub response pages. It does not authenticate GitHub independently and
does not make multi-endpoint observations transactionally atomic.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any

from strict_json_schema import strict_json_loads

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_PAGES = 20
MAX_ROWS = 2000
PAGE_SIZE = 100
RUN_KEY = re.compile(r"^([1-9][0-9]*)-([1-9][0-9]*)$")
RUN_ID_KEY = re.compile(r"^[1-9][0-9]*$")


def fail(code: str) -> None:
    raise ValueError(code)


def load(path: Path) -> Any:
    with path.open('rb') as stream:
        raw = stream.read(MAX_FILE_BYTES + 1)
    if len(raw) > MAX_FILE_BYTES:
        fail(f'raw_collection_byte_limit:{path.name}')
    try:
        return strict_json_loads(raw.decode('utf-8'))
    except (UnicodeError, ValueError, RecursionError):
        fail(f'raw_collection_json_invalid:{path.name}')


def positive_integer(value: Any, code: str) -> int:
    if type(value) is not int or value <= 0:
        fail(code)
    return value


def require_id(row: dict[str, Any], label: str) -> int:
    return positive_integer(row.get('id'), f'raw_collection_identity_invalid:{label}')


def validate_pages(pages: Any, list_key: str, label: str) -> list[dict[str, Any]]:
    if not isinstance(pages, list) or not pages or len(pages) > MAX_PAGES:
        fail(f'raw_collection_pages_invalid:{label}')
    expected: int | None = None
    rows: list[dict[str, Any]] = []
    seen: set[int] = set()
    for index, page in enumerate(pages, start=1):
        if not isinstance(page, dict):
            fail(f'raw_collection_page_shape_invalid:{label}:{index}')
        count = page.get('total_count')
        current = page.get(list_key)
        if type(count) is not int or count < 0 or count > MAX_ROWS:
            fail(f'raw_collection_count_invalid:{label}:{index}')
        if page.get('incomplete_results', False) is not False:
            fail(f'raw_collection_incomplete_results:{label}:{index}')
        if expected is None:
            expected = count
        elif count != expected:
            fail(f'raw_collection_count_changed:{label}:{index}')
        if not isinstance(current, list) or any(not isinstance(row, dict) for row in current):
            fail(f'raw_collection_rows_invalid:{label}:{index}')
        remaining = expected - len(rows)
        wanted = min(PAGE_SIZE, max(0, remaining))
        if len(current) != wanted:
            fail(f'raw_collection_page_incomplete:{label}:{index}:expected={wanted}:actual={len(current)}')
        for row in current:
            identifier = require_id(row, label)
            if identifier in seen:
                fail(f'raw_collection_duplicate_id:{label}:{identifier}')
            seen.add(identifier)
        rows.extend(current)
    if expected is None or len(rows) != expected:
        fail(f'raw_collection_total_mismatch:{label}')
    if expected > len(pages) * PAGE_SIZE:
        fail(f'raw_collection_pagination_truncated:{label}')
    return rows


def run_identity(row: dict[str, Any], label: str) -> tuple[int, int]:
    identifier = require_id(row, label)
    if 'run_attempt' not in row:
        fail(f'raw_run_attempt_missing:{label}:{identifier}')
    attempt = positive_integer(row.get('run_attempt'),
                               f'raw_run_attempt_invalid:{label}:{identifier}')
    return identifier, attempt


def parse_run_key(text: Any, code: str) -> tuple[int, int]:
    match = RUN_KEY.fullmatch(text) if isinstance(text, str) else None
    if match is None:
        fail(code)
    return int(match.group(1)), int(match.group(2))


def validate_job_rows(rows: list[dict[str, Any]], run_id: int, attempt: int,
                      label: str) -> None:
    for job_row in rows:
        job_id = require_id(job_row, label)
        observed_run = positive_integer(
            job_row.get('run_id'), f'raw_job_run_missing_or_invalid:{label}:{job_id}')
        observed_attempt = positive_integer(
            job_row.get('run_attempt'),
            f'raw_job_attempt_missing_or_invalid:{label}:{job_id}')
        if observed_run != run_id:
            fail(f'raw_job_run_mismatch:{label}:{job_id}')
        if observed_attempt != attempt:
            fail(f'raw_job_attempt_mismatch:{label}:{job_id}')


def normalized_steps(raw_steps: Any, label: str) -> list[dict[str, Any]]:
    if raw_steps is None:
        return []
    if not isinstance(raw_steps, list):
        fail(f'raw_job_steps_invalid:{label}')
    rows: list[dict[str, Any]] = []
    seen: set[int] = set()
    for raw in raw_steps:
        if not isinstance(raw, dict):
            fail(f'raw_job_step_shape_invalid:{label}')
        number = positive_integer(raw.get('number'),
                                  f'raw_job_step_identity_invalid:{label}')
        name = raw.get('name')
        if not isinstance(name, str) or not name:
            fail(f'raw_job_step_identity_invalid:{label}')
        if number in seen:
            fail(f'raw_job_step_duplicate:{label}:{number}')
        seen.add(number)
        rows.append({
            'number': number,
            'name': name,
            'status': raw.get('status'),
            'conclusion': raw.get('conclusion'),
        })
    return sorted(rows, key=lambda row: (row['number'], row['name']))


def normalized_jobs(raw_jobs: list[dict[str, Any]], label: str) -> list[dict[str, Any]]:
    rows = []
    for raw in raw_jobs:
        identifier = require_id(raw, label)
        name = raw.get('name')
        if not isinstance(name, str) or not name:
            fail(f'raw_job_name_invalid:{label}:{identifier}')
        rows.append({
            'id': identifier,
            'name': name,
            'status': raw.get('status'),
            'conclusion': raw.get('conclusion'),
            'startedAt': raw.get('started_at'),
            'completedAt': raw.get('completed_at'),
            'steps': normalized_steps(raw.get('steps'), f'{label}:{identifier}'),
        })
    return sorted(rows, key=lambda row: row['id'])


def normalized_artifacts(raw_artifacts: list[dict[str, Any]], label: str) -> list[dict[str, Any]]:
    rows = []
    for raw in raw_artifacts:
        identifier = require_id(raw, label)
        name = raw.get('name')
        if not isinstance(name, str) or not name:
            fail(f'raw_artifact_name_invalid:{label}:{identifier}')
        rows.append({
            'id': identifier,
            'name': name,
            'sizeInBytes': raw.get('size_in_bytes', 0),
            'expired': bool(raw.get('expired')),
            'createdAt': raw.get('created_at'),
            'expiresAt': raw.get('expires_at'),
            'digest': raw.get('digest'),
        })
    return sorted(rows, key=lambda row: row['id'])


def validate_required(root: Path, evidence_path: Path) -> dict[str, Any]:
    workflow_rows = validate_pages(load(root / 'workflow-runs.json'),
                                   'workflow_runs', 'required:workflow-runs')
    check_rows = validate_pages(load(root / 'check-runs.json'),
                                'check_runs', 'required:check-runs')
    jobs_raw = load(root / 'jobs.json')
    if not isinstance(jobs_raw, dict) or len(jobs_raw) > MAX_ROWS:
        fail('raw_jobs_map_invalid')
    run_by_key: dict[tuple[int, int], dict[str, Any]] = {}
    for row in workflow_rows:
        key = run_identity(row, 'required:workflow-run')
        if key in run_by_key:
            fail(f'raw_run_identity_duplicate:{key}')
        run_by_key[key] = row
    jobs_by_key: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for text, access in jobs_raw.items():
        key = parse_run_key(text, 'raw_jobs_key_invalid')
        if not isinstance(access, dict):
            fail('raw_jobs_key_invalid')
        if key not in run_by_key:
            fail(f'raw_jobs_unknown_run:{text}')
        if access.get('runId') != key[0] or access.get('runAttempt') != key[1]:
            fail(f'raw_jobs_access_identity_mismatch:{text}')
        rows = validate_pages(access.get('pages'), 'jobs', f'required:jobs:{text}')
        validate_job_rows(rows, *key, f'required:jobs:{text}')
        if key in jobs_by_key:
            fail(f'raw_jobs_duplicate_key:{text}')
        jobs_by_key[key] = rows

    evidence = load(evidence_path)
    if not isinstance(evidence, dict) or evidence.get('status') != 'complete_success_snapshot':
        fail('required_evidence_status_invalid')
    observed_rows = evidence.get('observedChecks')
    if not isinstance(observed_rows, list):
        fail('required_observed_checks_invalid')
    checks_by_id = {require_id(row, 'required:check-run'): row for row in check_rows}
    observed_keys: set[tuple[int, int, int]] = set()
    for observed in observed_rows:
        if not isinstance(observed, dict):
            fail('required_observed_check_invalid')
        key = (
            positive_integer(observed.get('runId'), 'required_observed_run_invalid'),
            positive_integer(observed.get('runAttempt'), 'required_observed_attempt_invalid'),
        )
        if key not in run_by_key or key not in jobs_by_key:
            fail(f'required_observed_run_missing:{key}')
        job_id = positive_integer(observed.get('jobId'),
                                  'required_observed_job_invalid')
        identity = (*key, job_id)
        if identity in observed_keys:
            fail(f'required_observed_duplicate:{identity}')
        observed_keys.add(identity)
        raw_job = next((job for job in jobs_by_key[key] if job.get('id') == job_id), None)
        if raw_job is None:
            fail(f'required_observed_job_missing:{job_id}')
        if job_id not in checks_by_id:
            fail(f'required_observed_check_run_missing:{job_id}')
        expected_job = normalized_jobs([raw_job], f'required:observed:{job_id}')[0]
        projection = {
            'id': job_id,
            'name': observed.get('jobName'),
            'status': observed.get('status'),
            'conclusion': observed.get('conclusion'),
            'startedAt': observed.get('startedAt'),
            'completedAt': observed.get('completedAt'),
            'steps': observed.get('steps'),
        }
        if projection != expected_job:
            fail(f'required_observed_job_projection_mismatch:{job_id}')
    return {'workflowRuns': len(workflow_rows), 'checkRuns': len(check_rows),
            'jobAttempts': len(jobs_by_key)}


def pr_binding_matches(run: dict[str, Any], subject: dict[str, Any]) -> bool:
    pr = subject.get('pullRequest')
    if not isinstance(pr, dict):
        fail('subject_pull_request_invalid')
    number = positive_integer(pr.get('number'), 'subject_pull_request_invalid')
    base, head = pr.get('base'), pr.get('head')
    if not isinstance(base, dict) or not isinstance(head, dict):
        fail('subject_pull_request_invalid')
    rows = run.get('pull_requests')
    if not isinstance(rows, list):
        return False
    for row in rows:
        if not isinstance(row, dict) or row.get('number') != number:
            continue
        raw_base, raw_head = row.get('base'), row.get('head')
        if not isinstance(raw_base, dict) or not isinstance(raw_head, dict):
            continue
        if (raw_base.get('ref'), raw_base.get('sha'),
            raw_head.get('ref'), raw_head.get('sha')) == (
                base.get('ref'), base.get('commit'),
                head.get('ref'), head.get('commit')):
            return True
    return False


def subject_history_rows(subject: dict[str, Any]) -> tuple[
        dict[tuple[int, int], dict[str, Any]], dict[int, tuple[int, str]]]:
    histories = subject.get('producerHistories')
    if not isinstance(histories, list) or not histories:
        fail('subject_histories_invalid')
    rows_by_key: dict[tuple[int, int], dict[str, Any]] = {}
    producers: dict[int, tuple[int, str]] = {}
    for history in histories:
        if not isinstance(history, dict):
            fail('subject_history_invalid')
        workflow_id = positive_integer(history.get('workflowId'),
                                       'subject_workflow_identity_invalid')
        workflow_path = history.get('workflowPath')
        if not isinstance(workflow_path, str) or not workflow_path:
            fail('subject_workflow_identity_invalid')
        producer = (workflow_id, workflow_path)
        if workflow_id in producers and producers[workflow_id] != producer:
            fail(f'subject_workflow_identity_conflict:{workflow_id}')
        producers[workflow_id] = producer
        eligible = history.get('eligibleRuns')
        if not isinstance(eligible, list) or not eligible:
            fail(f'subject_history_rows_invalid:{workflow_id}')
        for row in eligible:
            if not isinstance(row, dict):
                fail('subject_history_row_invalid')
            key = (
                positive_integer(row.get('runId'), 'subject_history_run_invalid'),
                positive_integer(row.get('runAttempt'), 'subject_history_attempt_invalid'),
            )
            if key in rows_by_key:
                fail(f'subject_history_duplicate_run_attempt:{key}')
            if row.get('workflowId') != workflow_id or row.get('workflowPath') != workflow_path:
                fail(f'subject_history_workflow_mismatch:{key}')
            rows_by_key[key] = row
    return rows_by_key, producers


def validate_subject(root: Path, subject_path: Path) -> dict[str, Any]:
    subject = load(subject_path)
    if not isinstance(subject, dict) or subject.get('status') != 'exact_subject_complete':
        fail('subject_status_invalid')
    history_rows, producers = subject_history_rows(subject)

    workflow_rows = validate_pages(load(root / 'workflow-runs.json'),
                                   'workflow_runs', 'subject:workflow-runs')
    raw_runs: dict[int, dict[str, Any]] = {}
    for row in workflow_rows:
        run_id, latest_attempt = run_identity(row, 'subject:workflow-run')
        if run_id in raw_runs:
            fail(f'subject_workflow_run_duplicate:{run_id}')
        raw_runs[run_id] = row
        positive_integer(latest_attempt, f'subject_workflow_attempt_invalid:{run_id}')

    head = subject['pullRequest']['head']
    expected_runs: dict[int, dict[str, Any]] = {}
    for run_id, row in raw_runs.items():
        workflow_id = row.get('workflow_id')
        producer = producers.get(workflow_id)
        if producer is None:
            continue
        if (row.get('path') != producer[1]
                or row.get('event') != 'pull_request'
                or row.get('head_sha') != head.get('commit')
                or row.get('head_branch') != head.get('ref')
                or not pr_binding_matches(row, subject)):
            continue
        expected_runs[run_id] = row
    if not expected_runs:
        fail('subject_expected_run_set_empty')

    expected_attempts = {
        (run_id, attempt)
        for run_id, row in expected_runs.items()
        for attempt in range(1, row['run_attempt'] + 1)
    }
    if set(history_rows) != expected_attempts:
        fail('subject_history_attempt_coverage_mismatch')

    attempts = load(root / 'attempts.json')
    jobs = load(root / 'jobs.json')
    artifacts = load(root / 'artifacts.json')
    if not all(isinstance(value, dict) and len(value) <= MAX_ROWS
               for value in (attempts, jobs, artifacts)):
        fail('subject_raw_map_invalid')

    attempt_by_key: dict[tuple[int, int], dict[str, Any]] = {}
    for text, metadata in attempts.items():
        key = parse_run_key(text, 'subject_attempt_key_invalid')
        if not isinstance(metadata, dict):
            fail('subject_attempt_key_invalid')
        if key not in expected_attempts:
            fail(f'subject_attempt_unexpected:{text}')
        observed_id = positive_integer(metadata.get('id'),
                                       f'subject_attempt_run_missing_or_invalid:{text}')
        if 'run_attempt' not in metadata:
            fail(f'subject_attempt_number_missing:{text}')
        observed_attempt = positive_integer(
            metadata.get('run_attempt'),
            f'subject_attempt_number_invalid:{text}')
        if (observed_id, observed_attempt) != key:
            fail(f'subject_attempt_identity_mismatch:{text}')
        attempt_by_key[key] = metadata
    if set(attempt_by_key) != expected_attempts:
        fail('subject_attempt_map_coverage_mismatch')

    jobs_by_key: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for text, pages in jobs.items():
        key = parse_run_key(text, 'subject_jobs_key_invalid')
        if key not in expected_attempts:
            fail(f'subject_jobs_unexpected:{text}')
        rows = validate_pages(pages, 'jobs', f'subject:jobs:{text}')
        validate_job_rows(rows, *key, f'subject:jobs:{text}')
        jobs_by_key[key] = rows
    if set(jobs_by_key) != expected_attempts:
        fail('subject_jobs_map_coverage_mismatch')

    artifacts_by_run: dict[int, list[dict[str, Any]]] = {}
    for text, pages in artifacts.items():
        if not isinstance(text, str) or RUN_ID_KEY.fullmatch(text) is None:
            fail(f'subject_artifact_run_invalid:{text}')
        run_id = int(text)
        if run_id not in expected_runs:
            fail(f'subject_artifact_run_unexpected:{text}')
        artifacts_by_run[run_id] = validate_pages(
            pages, 'artifacts', f'subject:artifacts:{text}')
    if set(artifacts_by_run) != set(expected_runs):
        fail('subject_artifact_map_coverage_mismatch')

    base = subject['pullRequest']['base']
    for key, normalized in history_rows.items():
        run_id, attempt = key
        metadata = attempt_by_key[key]
        raw_run = expected_runs[run_id]
        identity_projection = {
            'workflowId': metadata.get('workflow_id'),
            'workflowPath': metadata.get('path'),
            'runId': metadata.get('id'),
            'runNumber': metadata.get('run_number'),
            'runAttempt': metadata.get('run_attempt'),
            'event': metadata.get('event'),
            'headSha': metadata.get('head_sha'),
            'headBranch': metadata.get('head_branch'),
            'baseRef': base.get('ref'),
            'baseCommit': base.get('commit'),
            'status': metadata.get('status'),
            'conclusion': metadata.get('conclusion'),
            'createdAt': metadata.get('created_at'),
            'updatedAt': metadata.get('updated_at'),
            'checkSuiteId': metadata.get('check_suite_id'),
        }
        for field, value in identity_projection.items():
            if normalized.get(field) != value:
                fail(f'subject_attempt_projection_mismatch:{key}:{field}')
        if (metadata.get('workflow_id'), metadata.get('path'),
            metadata.get('event'), metadata.get('head_sha'),
            metadata.get('head_branch'), metadata.get('run_number')) != (
                raw_run.get('workflow_id'), raw_run.get('path'),
                raw_run.get('event'), raw_run.get('head_sha'),
                raw_run.get('head_branch'), raw_run.get('run_number')):
            fail(f'subject_attempt_workflow_identity_mismatch:{key}')
        expected_jobs = normalized_jobs(jobs_by_key[key], f'subject:jobs:{run_id}-{attempt}')
        if normalized.get('jobs') != expected_jobs:
            fail(f'subject_job_projection_mismatch:{key}')
        expected_artifacts = normalized_artifacts(
            artifacts_by_run[run_id], f'subject:artifacts:{run_id}')
        if normalized.get('artifacts') != expected_artifacts:
            fail(f'subject_artifact_projection_mismatch:{key}')

    return {'workflowRuns': len(workflow_rows), 'eligibleRuns': len(expected_runs),
            'attempts': len(attempt_by_key), 'jobAttempts': len(jobs_by_key),
            'artifactRuns': len(artifacts_by_run)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('required', 'subject'), required=True)
    parser.add_argument('--raw-root', type=Path, required=True)
    parser.add_argument('--artifact', type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = validate_required(args.raw_root, args.artifact) if args.mode == 'required' \
        else validate_subject(args.raw_root, args.artifact)
    print(json.dumps({'status': 'qualification_raw_collection_complete',
                      'mode': args.mode, **result}, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RecursionError) as error:
        print(f'qualification raw collection rejected: {error}', file=sys.stderr)
        raise SystemExit(1)
