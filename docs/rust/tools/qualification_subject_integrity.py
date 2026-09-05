"""Offline integrity checks shared by V2 derivation and live revalidation.

Hashes bind content, not authenticity or completeness of GitHub observations.
The existing live collector and V1 currentness verifier remain mandatory.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from strict_json_schema import strict_json_loads, validate as validate_schema
from qualification_subject_v3 import parse_timestamp, validate_history_freshness

ROOT = Path(__file__).resolve().parents[3]
MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
SUBJECT_SCHEMA = ROOT / 'docs/qualification/schemas/qualification-subject-runtime-v3.schema.json'
LEGACY_SCHEMA = ROOT / 'docs/rust/qualification/effective-status-v1.schema.json'
WRAPPER_SCHEMA = ROOT / 'docs/rust/qualification/effective-status-runtime-v2.schema.json'


def require(condition: bool, code: str) -> None:
    if not condition:
        raise ValueError(code)


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def sha256_value(value: Any) -> str:
    return 'sha256:' + hashlib.sha256(canonical_bytes(value)).hexdigest()


def read_json(path: Path) -> Any:
    """Read each bounded input once and reject duplicate keys/nonfinite JSON."""
    with path.open('rb') as stream:
        raw = stream.read(MAX_DOCUMENT_BYTES + 1)
    require(len(raw) <= MAX_DOCUMENT_BYTES, 'qualification_document_byte_limit')
    return strict_json_loads(raw.decode('utf-8'))


def validate_record(value: Any, schema_path: Path) -> None:
    validate_schema(value, read_json(schema_path))
    require(len(canonical_bytes(value)) <= MAX_DOCUMENT_BYTES,
            'qualification_document_byte_limit')


def check_hash(value: Any, expected: str, code: str) -> None:
    require(sha256_value(value) == expected, code)


def unique_sorted(values: list, code: str) -> None:
    require(values == sorted(set(values)), code)


def validate_subject(subject: dict[str, Any]) -> None:
    """Recompute every embedded history projection and exact subject binding."""
    validate_record(subject, SUBJECT_SCHEMA)
    body = dict(subject)
    snapshot = body.pop('snapshotIdentity')
    check_hash(body, snapshot, 'qualification_subject_snapshot_hash_invalid')
    repository = subject['repository']
    pr = subject['pullRequest']
    base, head = pr['base'], pr['head']
    for side in (base, head):
        require((side['repositoryId'], side['repository']) ==
                (repository['id'], repository['fullName']),
                'qualification_subject_repository_mismatch')
    require(pr['testedMerge']['parents'] == [base['commit'], head['commit']],
            'qualification_subject_merge_parent_mismatch')
    histories = subject['producerHistories']
    require(len(histories) <= 128, 'qualification_history_limit')
    unique_sorted([h['workflowId'] for h in histories], 'qualification_workflow_identity_duplicate_or_order')
    require(len({h['workflowPath'] for h in histories}) == len(histories),
            'qualification_workflow_path_duplicate')
    all_attempts, artifact_projection, selected = [], [], []
    seen_runs, seen_contexts = set(), set()
    for history in histories:
        contexts, rows = history['requiredContexts'], history['eligibleRuns']
        unique_sorted(contexts, 'qualification_context_order')
        require(not seen_contexts.intersection(contexts), 'qualification_context_duplicate')
        seen_contexts.update(contexts)
        require(len(rows) <= 4096, 'qualification_attempt_limit')
        unique_sorted([(r['runNumber'], r['runId'], r['runAttempt']) for r in rows],
                      'qualification_attempt_duplicate_or_order')
        groups, numbers = {}, {}
        for row in rows:
            require((row['workflowId'], row['workflowPath']) ==
                    (history['workflowId'], history['workflowPath']), 'qualification_run_producer_mismatch')
            require((row['headSha'], row['headBranch'], row['baseRef'], row['baseCommit']) ==
                    (head['commit'], head['ref'], base['ref'], base['commit']),
                    'qualification_run_subject_mismatch')
            require(parse_timestamp(row['createdAt']) <= parse_timestamp(row['updatedAt']),
                    'qualification_run_time_order')
            groups.setdefault(row['runId'], []).append(row)
            prior_id = numbers.setdefault(row['runNumber'], row['runId'])
            require(prior_id == row['runId'], 'qualification_run_number_collision')
            unique_sorted([j['id'] for j in row['jobs']], 'qualification_job_identity_duplicate_or_order')
            for job in row['jobs']:
                unique_sorted([s['number'] for s in job['steps']], 'qualification_step_identity_duplicate_or_order')
                if job['startedAt'] is not None and job['completedAt'] is not None:
                    require(parse_timestamp(job['startedAt']) <= parse_timestamp(job['completedAt']),
                            'qualification_job_time_order')
            unique_sorted([a['id'] for a in row['artifacts']], 'qualification_artifact_identity_duplicate_or_order')
            check_hash(row['jobs'], row['jobSetSha256'], 'qualification_job_hash_invalid')
            check_hash([{'jobId': j['id'], **s} for j in row['jobs'] for s in j['steps']],
                       row['stepSetSha256'], 'qualification_step_hash_invalid')
            check_hash(row['artifacts'], row['artifactSetSha256'], 'qualification_artifact_hash_invalid')
            artifact_projection.append({'workflowId': history['workflowId'], 'runId': row['runId'],
                                        'runAttempt': row['runAttempt'], 'artifacts': row['artifacts']})
        for run_id, attempts in groups.items():
            require(run_id not in seen_runs, 'qualification_run_cross_producer_collision')
            seen_runs.add(run_id)
            require([r['runAttempt'] for r in attempts] == list(range(1, len(attempts) + 1)),
                    'qualification_attempt_history_gap')
            require(len({r['runNumber'] for r in attempts}) == 1,
                    'qualification_attempt_identity_drift')
        canonical = validate_history_freshness(history['workflowPath'], contexts, rows)
        require((history['canonicalRunId'], history['canonicalRunAttempt'], history['canonicalUpdatedAt']) ==
                (canonical['runId'], canonical['runAttempt'], canonical['updatedAt']),
                'qualification_canonical_selection_mismatch')
        check_hash(rows, history['historyHash'], 'qualification_history_hash_invalid')
        selected.append({key: history[key] for key in ('workflowId', 'workflowPath') } |
                        {'runId': canonical['runId'], 'runAttempt': canonical['runAttempt'],
                         'updatedAt': canonical['updatedAt'], 'requiredContexts': contexts})
        all_attempts.extend(rows)
    require(len(all_attempts) <= 4096, 'qualification_total_attempt_limit')
    check_hash(histories, subject['eligibleRunSetSha256'], 'qualification_run_set_hash_invalid')
    check_hash(selected, subject['selectedRunSetSha256'], 'qualification_selection_hash_invalid')
    check_hash(artifact_projection, subject['artifactSetHash'], 'qualification_artifact_set_hash_invalid')
    watermark = max(all_attempts, key=lambda r: parse_timestamp(r['updatedAt']))['updatedAt']
    require(watermark == subject['producerHistoryWatermark'], 'qualification_watermark_invalid')


def validate_evidence_pair(legacy: dict[str, Any], subject: dict[str, Any]) -> None:
    """Require schema-valid V1 evidence for the SAME canonical V3 jobs and policy."""
    validate_subject(subject)
    validate_record(legacy, LEGACY_SCHEMA)
    head, base = subject['pullRequest']['head'], subject['pullRequest']['base']
    require((legacy['source']['commit'], legacy['source']['tree']) == (head['commit'], head['tree']),
            'legacy_effective_source_mismatch')
    require(legacy['repository'] == subject['repository']['fullName'], 'legacy_repository_mismatch')
    require(legacy['pullRequest'] == {'number': subject['pullRequest']['number'],
                                     'baseRef': base['ref'], 'headBranch': head['ref']},
            'legacy_pull_request_mismatch')
    require(legacy['validity']['snapshotIdentity'] == subject['requiredCheckSnapshotIdentity'],
            'legacy_check_snapshot_mismatch')
    checks = legacy['observedChecks']
    required_contexts = legacy['requiredContexts']
    contexts = [c for h in subject['producerHistories'] for c in h['requiredContexts']]
    require(sorted(required_contexts) == sorted(contexts), 'legacy_required_context_mismatch')
    require(sorted(c['context'] for c in checks) == sorted(contexts), 'legacy_observed_context_mismatch')
    definitions = []
    for history in subject['producerHistories']:
        canonical = next(r for r in history['eligibleRuns'] if
                         (r['runId'], r['runAttempt']) == (history['canonicalRunId'], history['canonicalRunAttempt']))
        bound = [c for c in checks if c['context'] in history['requiredContexts']]
        definition = {k: bound[0][k] for k in ('workflowId', 'workflowPath', 'workflowGitBlobSha', 'workflowSha256')}
        for check in bound:
            require({k: check[k] for k in definition} == definition, 'legacy_producer_definition_drift')
            for key in ('workflowId', 'workflowPath', 'runId', 'runAttempt', 'runNumber',
                        'checkSuiteId', 'headSha', 'headBranch', 'baseRef', 'event'):
                require(check[key] == canonical[key], 'legacy_canonical_run_mismatch:' + key)
            require(check['pullRequestNumber'] == subject['pullRequest']['number'], 'legacy_check_pr_mismatch')
            jobs = [j for j in canonical['jobs'] if j['name'] == check['context']]
            require(len(jobs) == 1, 'legacy_canonical_job_missing')
            job = jobs[0]
            expected = {'id': check['jobId'], 'name': check['jobName'],
                        **{k: check[k] for k in ('status', 'conclusion', 'startedAt', 'completedAt', 'steps')}}
            require(job == expected, 'legacy_canonical_job_mismatch')
            require(check['detailsUrl'] == f"https://github.com/{legacy['repository']}/actions/runs/{check['runId']}/job/{job['id']}",
                    'legacy_job_url_mismatch')
        definitions.append({**definition, 'requiredContexts': history['requiredContexts']})
    check_hash({'requiredChecksSha256': legacy['source']['requiredChecksSha256'],
                'producerManifestSha256': legacy['source']['producerManifestSha256'],
                'producers': definitions}, subject['definitionSetHash'], 'legacy_definition_set_mismatch')
