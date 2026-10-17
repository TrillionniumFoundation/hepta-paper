#!/usr/bin/env python3
"""Validate load-bearing projections omitted by the raw pagination gate.

This composes with ``validate_qualification_collection_completeness``. The first
verifier proves raw page/map coverage; this verifier proves exact check-run
metadata binding and strict workflow-run artifact semantics. GitHub exposes
artifacts at workflow-run scope, not workflow-attempt scope, so repeated
per-attempt arrays are accepted only when identical and are explicitly treated
as ``workflow_run_unattributed`` observations rather than attempt provenance.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any

from validate_qualification_collection_completeness import (
    MAX_ROWS,
    RUN_ID_KEY,
    load,
    positive_integer,
    require_id,
    subject_history_rows,
    validate_pages,
    validate_required,
    validate_subject,
)

MAX_SAFE_INTEGER = 2**53 - 1
REQUIRED_APP_ID = 15368
RUN_ARTIFACT_ATTRIBUTION = 'workflow_run_unattributed'
SHA256 = re.compile(r'^sha256:[0-9a-f]{64}$')


def fail(code: str) -> None:
    raise ValueError(code)


def nonnegative_integer(value: Any, code: str) -> int:
    if type(value) is not int or value < 0 or value > MAX_SAFE_INTEGER:
        fail(code)
    return value


def strict_artifacts(raw_rows: list[dict[str, Any]], label: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for raw in raw_rows:
        identifier = require_id(raw, label)
        name = raw.get('name')
        if not isinstance(name, str) or not name:
            fail(f'raw_artifact_name_invalid:{label}:{identifier}')
        if 'size_in_bytes' not in raw:
            fail(f'raw_artifact_size_missing:{label}:{identifier}')
        size = nonnegative_integer(raw.get('size_in_bytes'),
                                   f'raw_artifact_size_invalid:{label}:{identifier}')
        if 'expired' not in raw:
            fail(f'raw_artifact_expired_missing:{label}:{identifier}')
        expired = raw.get('expired')
        if type(expired) is not bool:
            fail(f'raw_artifact_expired_invalid:{label}:{identifier}')
        created = raw.get('created_at')
        expires = raw.get('expires_at')
        if not isinstance(created, str) or not created:
            fail(f'raw_artifact_created_at_invalid:{label}:{identifier}')
        if not isinstance(expires, str) or not expires:
            fail(f'raw_artifact_expires_at_invalid:{label}:{identifier}')
        digest = raw.get('digest')
        if digest is not None and (not isinstance(digest, str) or SHA256.fullmatch(digest) is None):
            fail(f'raw_artifact_digest_invalid:{label}:{identifier}')
        result.append({
            'id': identifier,
            'name': name,
            'sizeInBytes': size,
            'expired': expired,
            'createdAt': created,
            'expiresAt': expires,
            'digest': digest,
        })
    return sorted(result, key=lambda row: row['id'])


def raw_check_projection(raw: dict[str, Any], label: str) -> dict[str, Any]:
    identifier = require_id(raw, label)
    name = raw.get('name')
    head_sha = raw.get('head_sha')
    if not isinstance(name, str) or not name:
        fail(f'raw_check_name_invalid:{label}:{identifier}')
    if not isinstance(head_sha, str) or not head_sha:
        fail(f'raw_check_head_invalid:{label}:{identifier}')
    app = raw.get('app')
    suite = raw.get('check_suite')
    if not isinstance(app, dict) or app.get('id') != REQUIRED_APP_ID:
        fail(f'raw_check_app_invalid:{label}:{identifier}')
    if not isinstance(suite, dict):
        fail(f'raw_check_suite_invalid:{label}:{identifier}')
    suite_id = positive_integer(suite.get('id'),
                                f'raw_check_suite_invalid:{label}:{identifier}')
    details = raw.get('details_url') or raw.get('html_url')
    if not isinstance(details, str) or not details:
        fail(f'raw_check_details_invalid:{label}:{identifier}')
    started = raw.get('started_at')
    completed = raw.get('completed_at')
    if started is not None and (not isinstance(started, str) or not started):
        fail(f'raw_check_started_at_invalid:{label}:{identifier}')
    if completed is not None and (not isinstance(completed, str) or not completed):
        fail(f'raw_check_completed_at_invalid:{label}:{identifier}')
    return {
        'id': identifier,
        'name': name,
        'status': raw.get('status'),
        'conclusion': raw.get('conclusion'),
        'headSha': head_sha,
        'checkSuiteId': suite_id,
        'appId': REQUIRED_APP_ID,
        'startedAt': started,
        'completedAt': completed,
        'detailsUrl': details,
    }


def validate_required_projection(root: Path, evidence_path: Path) -> dict[str, Any]:
    baseline = validate_required(root, evidence_path)
    check_rows = validate_pages(load(root / 'check-runs.json'),
                                'check_runs', 'projection:check-runs')
    checks_by_id = {require_id(row, 'projection:check-run'): row for row in check_rows}
    evidence = load(evidence_path)
    observed_rows = evidence.get('observedChecks')
    if not isinstance(observed_rows, list):
        fail('projection_observed_checks_invalid')
    for observed in observed_rows:
        if not isinstance(observed, dict):
            fail('projection_observed_check_invalid')
        job_id = positive_integer(observed.get('jobId'),
                                  'projection_observed_job_invalid')
        context = observed.get('context')
        if not isinstance(context, str) or not context:
            fail(f'projection_observed_context_invalid:{job_id}')
        raw = checks_by_id.get(job_id)
        if raw is None:
            fail(f'projection_check_run_missing:{job_id}')
        expected = {
            'id': job_id,
            'name': context,
            'status': observed.get('status'),
            'conclusion': observed.get('conclusion'),
            'headSha': observed.get('headSha'),
            'checkSuiteId': observed.get('checkSuiteId'),
            'appId': REQUIRED_APP_ID,
            'startedAt': observed.get('startedAt'),
            'completedAt': observed.get('completedAt'),
            'detailsUrl': observed.get('detailsUrl'),
        }
        if raw_check_projection(raw, f'projection:check-run:{job_id}') != expected:
            fail(f'projection_check_run_mismatch:{job_id}')
    return {**baseline, 'checkRunProjection': 'exact'}


def validate_subject_projection(root: Path, subject_path: Path) -> dict[str, Any]:
    baseline = validate_subject(root, subject_path)
    subject = load(subject_path)
    history_rows, _ = subject_history_rows(subject)
    artifacts_raw = load(root / 'artifacts.json')
    if not isinstance(artifacts_raw, dict) or len(artifacts_raw) > MAX_ROWS:
        fail('projection_artifact_map_invalid')
    raw_by_run: dict[int, list[dict[str, Any]]] = {}
    for text, pages in artifacts_raw.items():
        if not isinstance(text, str) or RUN_ID_KEY.fullmatch(text) is None:
            fail(f'projection_artifact_run_invalid:{text}')
        run_id = int(text)
        raw_by_run[run_id] = strict_artifacts(
            validate_pages(pages, 'artifacts', f'projection:artifacts:{run_id}'),
            f'projection:artifacts:{run_id}',
        )
    represented_runs = {run_id for run_id, _ in history_rows}
    if set(raw_by_run) != represented_runs:
        fail('projection_artifact_run_coverage_mismatch')
    projected_by_run: dict[int, Any] = {}
    for (run_id, _), row in sorted(history_rows.items()):
        projection = row.get('artifacts')
        if not isinstance(projection, list):
            fail(f'projection_artifact_list_invalid:{run_id}')
        prior = projected_by_run.setdefault(run_id, projection)
        if prior != projection:
            fail(f'projection_attempt_artifact_attribution_forbidden:{run_id}')
    for run_id, expected in raw_by_run.items():
        if projected_by_run.get(run_id) != expected:
            fail(f'projection_artifact_mismatch:{run_id}')
    return {**baseline, 'artifactAttribution': RUN_ARTIFACT_ATTRIBUTION}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=('required', 'subject'), required=True)
    parser.add_argument('--raw-root', type=Path, required=True)
    parser.add_argument('--artifact', type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = validate_required_projection(args.raw_root, args.artifact) \
        if args.mode == 'required' else validate_subject_projection(args.raw_root, args.artifact)
    print(json.dumps({'status': 'qualification_evidence_projection_complete',
                      'mode': args.mode, **result}, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RecursionError) as error:
        print(f'qualification evidence projection rejected: {error}', file=sys.stderr)
        raise SystemExit(1)
