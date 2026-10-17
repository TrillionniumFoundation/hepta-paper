#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from validate_qualification_evidence_projection import (
    RUN_ARTIFACT_ATTRIBUTION,
    validate_required_projection,
    validate_subject_projection,
)

SHA_A = 'a' * 40
SHA_B = 'b' * 40
DIGEST = 'sha256:' + 'd' * 64
WORKFLOW = '.github/workflows/producer.yml'
DETAILS = 'https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/10/job/100'


def page(key, rows, total=None):
    return {'total_count': len(rows) if total is None else total, key: rows}


def run(attempt=1):
    return {'id': 10, 'run_attempt': attempt, 'workflow_id': 99, 'path': WORKFLOW,
            'event': 'pull_request', 'head_sha': SHA_B, 'head_branch': 'candidate',
            'run_number': 5, 'status': 'completed', 'conclusion': 'success',
            'created_at': '2026-09-01T00:00:00Z', 'updated_at': '2026-09-01T00:02:00Z',
            'check_suite_id': 1001, 'pull_requests': [{'number': 64,
                'base': {'ref': 'base', 'sha': SHA_A},
                'head': {'ref': 'candidate', 'sha': SHA_B}}]}


def job(identifier=100, attempt=1):
    return {'id': identifier, 'run_id': 10, 'run_attempt': attempt,
            'name': 'required-context', 'status': 'completed', 'conclusion': 'success',
            'started_at': '2026-09-01T00:00:00Z',
            'completed_at': '2026-09-01T00:01:00Z',
            'steps': [{'number': 1, 'name': 'Execute qualification',
                       'status': 'completed', 'conclusion': 'success'}]}


def normalized_job(identifier=100):
    return {'id': identifier, 'name': 'required-context', 'status': 'completed',
            'conclusion': 'success', 'startedAt': '2026-09-01T00:00:00Z',
            'completedAt': '2026-09-01T00:01:00Z',
            'steps': [{'number': 1, 'name': 'Execute qualification',
                       'status': 'completed', 'conclusion': 'success'}]}


def check():
    return {'id': 100, 'name': 'required-context', 'status': 'completed',
            'conclusion': 'success', 'head_sha': SHA_B, 'app': {'id': 15368},
            'check_suite': {'id': 1001}, 'started_at': '2026-09-01T00:00:00Z',
            'completed_at': '2026-09-01T00:01:00Z', 'details_url': DETAILS}


def artifact():
    return {'id': 200, 'name': 'evidence', 'size_in_bytes': 123, 'expired': False,
            'created_at': '2026-09-01T00:00:00Z',
            'expires_at': '2026-12-01T00:00:00Z', 'digest': DIGEST}


def normalized_artifact():
    return {'id': 200, 'name': 'evidence', 'sizeInBytes': 123, 'expired': False,
            'createdAt': '2026-09-01T00:00:00Z',
            'expiresAt': '2026-12-01T00:00:00Z', 'digest': DIGEST}


def attempt_row(attempt=1, job_id=100):
    return {'workflowId': 99, 'workflowPath': WORKFLOW, 'runId': 10, 'runNumber': 5,
            'runAttempt': attempt, 'event': 'pull_request', 'headSha': SHA_B,
            'headBranch': 'candidate', 'baseRef': 'base', 'baseCommit': SHA_A,
            'status': 'completed', 'conclusion': 'success',
            'createdAt': '2026-09-01T00:00:00Z', 'updatedAt': '2026-09-01T00:02:00Z',
            'checkSuiteId': 1001, 'jobs': [normalized_job(job_id)],
            'artifacts': [normalized_artifact()]}


class RequiredProjectionTests(unittest.TestCase):
    def fixture(self, root: Path):
        (root / 'workflow-runs.json').write_text(json.dumps([page('workflow_runs', [run()])]))
        (root / 'check-runs.json').write_text(json.dumps([page('check_runs', [check()])]))
        (root / 'jobs.json').write_text(json.dumps({'10-1': {'runId': 10, 'runAttempt': 1,
            'pages': [page('jobs', [job()])]}}))
        evidence = root / 'evidence.json'
        evidence.write_text(json.dumps({'status': 'complete_success_snapshot', 'observedChecks': [{
            'context': 'required-context', 'runId': 10, 'runAttempt': 1, 'jobId': 100,
            'jobName': 'required-context', 'status': 'completed', 'conclusion': 'success',
            'headSha': SHA_B, 'checkSuiteId': 1001,
            'startedAt': '2026-09-01T00:00:00Z',
            'completedAt': '2026-09-01T00:01:00Z', 'detailsUrl': DETAILS,
            'steps': normalized_job()['steps']}]}))
        return evidence

    def test_complete_projection_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); evidence = self.fixture(root)
            self.assertEqual(validate_required_projection(root, evidence)['checkRunProjection'], 'exact')

    def test_projection_still_rejects_incomplete_pages_and_missing_jobs(self):
        for file, value in [
            ('workflow-runs.json', [page('workflow_runs', [run()], total=2)]),
            ('check-runs.json', [page('check_runs', [check()], total=2)]),
            ('jobs.json', {}),
        ]:
            with self.subTest(file=file), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); evidence = self.fixture(root)
                (root / file).write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    validate_required_projection(root, evidence)

    def test_same_id_metadata_splice_is_rejected(self):
        for field, value in [('name', 'other'), ('head_sha', SHA_A), ('status', 'queued'),
                             ('conclusion', None), ('started_at', None),
                             ('completed_at', None), ('details_url', DETAILS + '-other')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); evidence = self.fixture(root)
                pages = json.loads((root / 'check-runs.json').read_text())
                pages[0]['check_runs'][0][field] = value
                (root / 'check-runs.json').write_text(json.dumps(pages))
                with self.assertRaisesRegex(ValueError,
                    'projection_check_run_mismatch|required_observed_check_projection_mismatch'):
                    validate_required_projection(root, evidence)

    def test_wrong_app_or_suite_is_rejected(self):
        for target in ('app', 'suite'):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); evidence = self.fixture(root)
                pages = json.loads((root / 'check-runs.json').read_text())
                row = pages[0]['check_runs'][0]
                if target == 'app': row['app']['id'] = 1
                else: row['check_suite']['id'] = 999
                (root / 'check-runs.json').write_text(json.dumps(pages))
                with self.assertRaisesRegex(ValueError,
                    'raw_check_(app|suite)_invalid|projection_check_run_mismatch|'
                    'required_observed_check_projection_mismatch'):
                    validate_required_projection(root, evidence)


class SubjectProjectionTests(unittest.TestCase):
    def fixture(self, root: Path, attempts=1):
        (root / 'workflow-runs.json').write_text(json.dumps([page('workflow_runs', [run(attempts)])]))
        attempt_map, job_map, rows = {}, {}, []
        for number in range(1, attempts + 1):
            metadata = run(number); metadata.pop('pull_requests')
            attempt_map[f'10-{number}'] = metadata
            job_map[f'10-{number}'] = [page('jobs', [job(99 + number, number)])]
            rows.append(attempt_row(number, 99 + number))
        (root / 'attempts.json').write_text(json.dumps(attempt_map))
        (root / 'jobs.json').write_text(json.dumps(job_map))
        (root / 'artifacts.json').write_text(json.dumps({'10': [page('artifacts', [artifact()])]}))
        subject = root / 'subject.json'
        subject.write_text(json.dumps({'status': 'exact_subject_complete',
            'pullRequest': {'number': 64, 'base': {'ref': 'base', 'commit': SHA_A},
                            'head': {'ref': 'candidate', 'commit': SHA_B}},
            'producerHistories': [{'workflowId': 99, 'workflowPath': WORKFLOW,
                                   'eligibleRuns': rows}]}))
        return subject

    def test_complete_projection_is_explicitly_run_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); subject = self.fixture(root, 2)
            self.assertEqual(validate_subject_projection(root, subject)['artifactAttribution'],
                             RUN_ARTIFACT_ATTRIBUTION)

    def test_projection_still_rejects_missing_runs_attempts_and_artifacts(self):
        for file, value in [
            ('workflow-runs.json', [page('workflow_runs', [], total=1)]),
            ('attempts.json', {}), ('jobs.json', {}), ('artifacts.json', {}),
        ]:
            with self.subTest(file=file), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); subject = self.fixture(root, 2)
                (root / file).write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    validate_subject_projection(root, subject)

    def test_distinct_attempt_artifact_credit_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); subject = self.fixture(root, 2)
            value = json.loads(subject.read_text())
            value['producerHistories'][0]['eligibleRuns'][1]['artifacts'][0]['id'] = 201
            subject.write_text(json.dumps(value))
            with self.assertRaisesRegex(
                    ValueError, 'artifact_attribution_forbidden|subject_artifact_projection_mismatch'):
                validate_subject_projection(root, subject)

    def test_missing_or_nonboolean_expired_is_rejected(self):
        for value in ('missing', 'false', 0):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); subject = self.fixture(root)
                pages = json.loads((root / 'artifacts.json').read_text())
                row = pages['10'][0]['artifacts'][0]
                if value == 'missing': row.pop('expired')
                else: row['expired'] = value
                (root / 'artifacts.json').write_text(json.dumps(pages))
                subject_value = json.loads(subject.read_text())
                subject_value['producerHistories'][0]['eligibleRuns'][0]['artifacts'][0]['expired'] = \
                    bool(None if value == 'missing' else value)
                subject.write_text(json.dumps(subject_value))
                with self.assertRaisesRegex(ValueError, 'artifact_expired_'):
                    validate_subject_projection(root, subject)

    def test_missing_or_invalid_size_is_rejected(self):
        for value in ('missing', True, -1, 2**53):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); subject = self.fixture(root)
                pages = json.loads((root / 'artifacts.json').read_text())
                row = pages['10'][0]['artifacts'][0]
                if value == 'missing': row.pop('size_in_bytes')
                else: row['size_in_bytes'] = value
                (root / 'artifacts.json').write_text(json.dumps(pages))
                subject_value = json.loads(subject.read_text())
                subject_value['producerHistories'][0]['eligibleRuns'][0]['artifacts'][0]['sizeInBytes'] = \
                    0 if value == 'missing' else value
                subject.write_text(json.dumps(subject_value))
                with self.assertRaisesRegex(ValueError, 'artifact_size_'):
                    validate_subject_projection(root, subject)

    def test_invalid_digest_and_timestamp_are_rejected(self):
        for field, value, pattern in [('digest', 'md5:bad', 'artifact_digest_invalid'),
                                      ('created_at', None, 'artifact_created_at_invalid'),
                                      ('expires_at', '', 'artifact_expires_at_invalid')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); subject = self.fixture(root)
                pages = json.loads((root / 'artifacts.json').read_text())
                pages['10'][0]['artifacts'][0][field] = value
                (root / 'artifacts.json').write_text(json.dumps(pages))
                subject_value = json.loads(subject.read_text())
                normalized_field = {
                    'digest': 'digest', 'created_at': 'createdAt', 'expires_at': 'expiresAt',
                }[field]
                subject_value['producerHistories'][0]['eligibleRuns'][0]['artifacts'][0][normalized_field] = value
                subject.write_text(json.dumps(subject_value))
                with self.assertRaisesRegex(ValueError, pattern):
                    validate_subject_projection(root, subject)


class RunnerProjectionWiringTests(unittest.TestCase):
    def test_runner_retains_all_four_complete_projection_boundaries(self):
        import re
        runner = (Path(__file__).parent / 'run-qualification-subject-v3.sh').read_text()
        calls = re.findall(
            r'python3 docs/rust/tools/validate_qualification_evidence_projection\.py \\\n'
            r'  --mode (required|subject) \\\n'
            r'  --raw-root "\$EVIDENCE_ROOT/raw/([^"]+)" \\\n'
            r'  --artifact "\$EVIDENCE_ROOT/([^"]+)" \\\n', runner)
        self.assertEqual(calls, [
            ('required', 'required', 'check-evidence.v2.json'),
            ('subject', 'subject', 'qualification-subject.v3.json'),
            ('required', 'current-required', 'current-check-evidence.v2.json'),
            ('subject', 'current-subject', 'current-qualification-subject.v3.json'),
        ])
        self.assertNotIn('python3 docs/rust/tools/validate_qualification_collection_completeness.py', runner)
        self.assertIn('python3 docs/rust/tools/test_qualification_collection_completeness.py', runner)


if __name__ == '__main__':
    unittest.main(verbosity=2)
