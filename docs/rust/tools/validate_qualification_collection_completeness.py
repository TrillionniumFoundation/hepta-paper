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
RUN_KEY = re.compile(r"^(\d+)-(\d+)$")


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


def require_id(row: dict[str, Any], label: str) -> int:
    identifier = row.get('id')
    if type(identifier) is not int or identifier <= 0:
        fail(f'raw_collection_identity_invalid:{label}')
    return identifier


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
    attempt = row.get('run_attempt', 1)
    if type(attempt) is not int or attempt <= 0:
        fail(f'raw_run_attempt_invalid:{label}:{identifier}')
    return identifier, attempt


def validate_job_rows(rows: list[dict[str, Any]], run_id: int, attempt: int, label: str) -> None:
    for job in rows:
        if job.get('run_id') not in (None, run_id):
            fail(f'raw_job_run_mismatch:{label}:{job.get("id")}')
        observed_attempt = job.get('run_attempt')
        if observed_attempt not in (None, attempt):
            fail(f'raw_job_attempt_mismatch:{label}:{job.get("id")}')


def validate_required(root: Path, evidence_path: Path) -> dict[str, Any]:
    workflow_rows = validate_pages(load(root / 'workflow-runs.json'), 'workflow_runs', 'required:workflow-runs')
    check_rows = validate_pages(load(root / 'check-runs.json'), 'check_runs', 'required:check-runs')
    jobs_raw = load(root / 'jobs.json')
    if not isinstance(jobs_raw, dict) or len(jobs_raw) > MAX_ROWS:
        fail('raw_jobs_map_invalid')
    run_by_key = {run_identity(row, 'required:workflow-run'): row for row in workflow_rows}
    jobs_by_key: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for text, access in jobs_raw.items():
        match = RUN_KEY.fullmatch(text) if isinstance(text, str) else None
        if match is None or not isinstance(access, dict):
            fail('raw_jobs_key_invalid')
        key = (int(match.group(1)), int(match.group(2)))
        if key not in run_by_key:
            fail(f'raw_jobs_unknown_run:{text}')
        if access.get('runId') != key[0] or access.get('runAttempt') != key[1]:
            fail(f'raw_jobs_access_identity_mismatch:{text}')
        pages = access.get('pages')
        rows = validate_pages(pages, 'jobs', f'required:jobs:{text}')
        validate_job_rows(rows, *key, f'required:jobs:{text}')
        jobs_by_key[key] = rows
    evidence = load(evidence_path)
    if not isinstance(evidence, dict) or evidence.get('status') != 'complete_success_snapshot':
        fail('required_evidence_status_invalid')
    check_ids = {require_id(row, 'required:check-run') for row in check_rows}
    for observed in evidence.get('observedChecks', []):
        if not isinstance(observed, dict):
            fail('required_observed_check_invalid')
        key = (observed.get('runId'), observed.get('runAttempt'))
        if key not in run_by_key or key not in jobs_by_key:
            fail(f'required_observed_run_missing:{key}')
        job_id = observed.get('jobId')
        if job_id not in {job.get('id') for job in jobs_by_key[key]}:
            fail(f'required_observed_job_missing:{job_id}')
        if job_id not in check_ids:
            fail(f'required_observed_check_run_missing:{job_id}')
    return {'workflowRuns': len(workflow_rows), 'checkRuns': len(check_rows),
            'jobAttempts': len(jobs_by_key)}


def validate_subject(root: Path, subject_path: Path) -> dict[str, Any]:
    workflow_rows = validate_pages(load(root / 'workflow-runs.json'), 'workflow_runs', 'subject:workflow-runs')
    run_by_id = {require_id(row, 'subject:workflow-run'): row for row in workflow_rows}
    attempts = load(root / 'attempts.json')
    jobs = load(root / 'jobs.json')
    artifacts = load(root / 'artifacts.json')
    if not all(isinstance(value, dict) for value in (attempts, jobs, artifacts)):
        fail('subject_raw_map_invalid')
    raw_attempt_keys: set[tuple[int, int]] = set()
    for text, metadata in attempts.items():
        match = RUN_KEY.fullmatch(text) if isinstance(text, str) else None
        if match is None or not isinstance(metadata, dict):
            fail('subject_attempt_key_invalid')
        key = (int(match.group(1)), int(match.group(2)))
        if key[0] not in run_by_id:
            fail(f'subject_attempt_unknown_run:{text}')
        observed_id = metadata.get('id')
        observed_attempt = metadata.get('run_attempt', 1)
        if observed_id != key[0] or observed_attempt != key[1]:
            fail(f'subject_attempt_identity_mismatch:{text}')
        raw_attempt_keys.add(key)
    job_keys: set[tuple[int, int]] = set()
    for text, pages in jobs.items():
        match = RUN_KEY.fullmatch(text) if isinstance(text, str) else None
        if match is None:
            fail('subject_jobs_key_invalid')
        key = (int(match.group(1)), int(match.group(2)))
        if key not in raw_attempt_keys:
            fail(f'subject_jobs_without_attempt:{text}')
        rows = validate_pages(pages, 'jobs', f'subject:jobs:{text}')
        validate_job_rows(rows, *key, f'subject:jobs:{text}')
        job_keys.add(key)
    for text, pages in artifacts.items():
        if not isinstance(text, str) or not text.isdigit() or int(text) not in run_by_id:
            fail(f'subject_artifact_run_invalid:{text}')
        validate_pages(pages, 'artifacts', f'subject:artifacts:{text}')
    subject = load(subject_path)
    if not isinstance(subject, dict) or subject.get('status') != 'exact_subject_complete':
        fail('subject_status_invalid')
    for history in subject.get('producerHistories', []):
        if not isinstance(history, dict):
            fail('subject_history_invalid')
        for row in history.get('eligibleRuns', []):
            if not isinstance(row, dict):
                fail('subject_history_row_invalid')
            key = (row.get('runId'), row.get('runAttempt'))
            if key not in raw_attempt_keys or key not in job_keys:
                fail(f'subject_history_raw_identity_missing:{key}')
    return {'workflowRuns': len(workflow_rows), 'attempts': len(raw_attempt_keys),
            'jobAttempts': len(job_keys), 'artifactRuns': len(artifacts)}


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
