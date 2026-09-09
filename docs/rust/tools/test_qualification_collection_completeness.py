#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from validate_qualification_collection_completeness import (
    validate_pages, validate_required, validate_subject,
)

SHA_A = 'a' * 40
SHA_B = 'b' * 40
DIGEST = 'sha256:' + 'd' * 64
PATH = '.github/workflows/producer.yml'


def page(key, rows, total):
    return {'total_count': total, key: rows}


def raw_run(identifier=10, attempt=1):
    return {
        'id': identifier,
        'run_attempt': attempt,
        'workflow_id': 99,
        'path': PATH,
        'event': 'pull_request',
        'head_sha': SHA_B,
        'head_branch': 'candidate',
        'run_number': 5,
        'status': 'completed',
        'conclusion': 'success',
        'created_at': '2026-09-01T00:00:00Z',
        'updated_at': '2026-09-01T00:02:00Z',
        'check_suite_id': 1000 + attempt,
        'pull_requests': [{
            'number': 64,
            'base': {'ref': 'base', 'sha': SHA_A},
            'head': {'ref': 'candidate', 'sha': SHA_B},
        }],
    }


def attempt_metadata(identifier=10, attempt=1):
    value = raw_run(identifier, attempt)
    value.pop('pull_requests')
    return value


def raw_step(number=1, name='Execute qualification'):
    return {'number': number, 'name': name, 'status': 'completed', 'conclusion': 'success'}


def raw_job(identifier=100, run_id=10, attempt=1):
    return {
        'id': identifier,
        'run_id': run_id,
        'run_attempt': attempt,
        'name': 'required-context',
        'status': 'completed',
        'conclusion': 'success',
        'started_at': '2026-09-01T00:00:00Z',
        'completed_at': '2026-09-01T00:01:00Z',
        'steps': [raw_step()],
    }


def normalized_job(identifier=100):
    return {
        'id': identifier,
        'name': 'required-context',
        'status': 'completed',
        'conclusion': 'success',
        'startedAt': '2026-09-01T00:00:00Z',
        'completedAt': '2026-09-01T00:01:00Z',
        'steps': [{
            'number': 1,
            'name': 'Execute qualification',
            'status': 'completed',
            'conclusion': 'success',
        }],
    }


def raw_artifact(identifier=200):
    return {
        'id': identifier,
        'name': 'qualification-evidence',
        'size_in_bytes': 123,
        'expired': False,
        'created_at': '2026-09-01T00:00:00Z',
        'expires_at': '2026-12-01T00:00:00Z',
        'digest': DIGEST,
    }


def normalized_artifact(identifier=200):
    return {
        'id': identifier,
        'name': 'qualification-evidence',
        'sizeInBytes': 123,
        'expired': False,
        'createdAt': '2026-09-01T00:00:00Z',
        'expiresAt': '2026-12-01T00:00:00Z',
        'digest': DIGEST,
    }


def normalized_attempt(identifier=10, attempt=1, job_id=100):
    metadata = attempt_metadata(identifier, attempt)
    return {
        'workflowId': 99,
        'workflowPath': PATH,
        'runId': identifier,
        'runNumber': metadata['run_number'],
        'runAttempt': attempt,
        'event': metadata['event'],
        'headSha': metadata['head_sha'],
        'headBranch': metadata['head_branch'],
        'baseRef': 'base',
        'baseCommit': SHA_A,
        'status': metadata['status'],
        'conclusion': metadata['conclusion'],
        'createdAt': metadata['created_at'],
        'updatedAt': metadata['updated_at'],
        'checkSuiteId': metadata['check_suite_id'],
        'jobs': [normalized_job(job_id)],
        'artifacts': [normalized_artifact()],
    }


def subject_value(rows=None):
    rows = rows or [normalized_attempt()]
    return {
        'status': 'exact_subject_complete',
        'pullRequest': {
            'number': 64,
            'base': {'ref': 'base', 'commit': SHA_A},
            'head': {'ref': 'candidate', 'commit': SHA_B},
        },
        'producerHistories': [{
            'workflowId': 99,
            'workflowPath': PATH,
            'eligibleRuns': rows,
        }],
    }


class Fixture:
    def __init__(self, root: Path, *, attempt=1):
        self.root = root
        self.write('workflow-runs.json', [page('workflow_runs', [raw_run(attempt=attempt)], 1)])
        self.write('attempts.json', {
            f'10-{number}': attempt_metadata(attempt=number)
            for number in range(1, attempt + 1)
        })
        self.write('jobs.json', {
            f'10-{number}': [page('jobs', [raw_job(identifier=99 + number, attempt=number)], 1)]
            for number in range(1, attempt + 1)
        })
        self.write('artifacts.json', {'10': [page('artifacts', [raw_artifact()], 1)]})
        rows = [normalized_attempt(attempt=number, job_id=99 + number)
                for number in range(1, attempt + 1)]
        self.subject = root / 'subject.json'
        self.write(self.subject.name, subject_value(rows))

    def write(self, name: str, value):
        (self.root / name).write_text(json.dumps(value), encoding='utf-8')

    def read(self, name: str):
        return json.loads((self.root / name).read_text())


class PageTests(unittest.TestCase):
    def test_short_final_page_matches_declared_total(self):
        rows = [{'id': i + 1} for i in range(101)]
        self.assertEqual(len(validate_pages([page('jobs', rows[:100], 101),
                                             page('jobs', rows[100:], 101)],
                                            'jobs', 'ok')), 101)

    def test_declared_two_but_returned_one_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'page_incomplete'):
            validate_pages([page('jobs', [{'id': 1}], 2)], 'jobs', 'short')

    def test_declared_count_change_is_rejected(self):
        first = [{'id': i + 1} for i in range(100)]
        with self.assertRaisesRegex(ValueError, 'count_changed'):
            validate_pages([page('jobs', first, 101),
                            page('jobs', [{'id': 101}], 102)], 'jobs', 'changed')

    def test_duplicate_identity_across_pages_is_rejected(self):
        first = [{'id': i + 1} for i in range(100)]
        with self.assertRaisesRegex(ValueError, 'duplicate_id'):
            validate_pages([page('jobs', first, 101),
                            page('jobs', [{'id': 100}], 101)], 'jobs', 'duplicate')

    def test_incomplete_results_flag_is_rejected(self):
        value = page('check_runs', [], 0)
        value['incomplete_results'] = True
        with self.assertRaisesRegex(ValueError, 'incomplete_results'):
            validate_pages([value], 'check_runs', 'incomplete')

    def test_boolean_total_count_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'count_invalid'):
            validate_pages([page('jobs', [], False)], 'jobs', 'bool')


class RequiredBindingTests(unittest.TestCase):
    def prepare(self, root: Path):
        (root / 'workflow-runs.json').write_text(json.dumps(
            [page('workflow_runs', [raw_run()], 1)]))
        (root / 'check-runs.json').write_text(json.dumps(
            [page('check_runs', [{'id': 100}], 1)]))
        (root / 'jobs.json').write_text(json.dumps({
            '10-1': {'runId': 10, 'runAttempt': 1,
                     'pages': [page('jobs', [raw_job()], 1)]},
        }))
        evidence = root / 'evidence.json'
        evidence.write_text(json.dumps({
            'status': 'complete_success_snapshot',
            'observedChecks': [{
                'runId': 10, 'runAttempt': 1, 'jobId': 100,
                'jobName': 'required-context', 'status': 'completed',
                'conclusion': 'success',
                'startedAt': '2026-09-01T00:00:00Z',
                'completedAt': '2026-09-01T00:01:00Z',
                'steps': normalized_job()['steps'],
            }],
        }))
        return evidence

    def test_required_raw_identity_binds_observed_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = self.prepare(root)
            self.assertEqual(validate_required(root, evidence),
                             {'workflowRuns': 1, 'checkRuns': 1, 'jobAttempts': 1})

    def test_required_job_attempt_splice_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = self.prepare(root)
            jobs = json.loads((root / 'jobs.json').read_text())
            jobs['10-1']['pages'][0]['jobs'][0]['run_attempt'] = 2
            (root / 'jobs.json').write_text(json.dumps(jobs))
            with self.assertRaisesRegex(ValueError, 'job_attempt_mismatch'):
                validate_required(root, evidence)

    def test_required_job_must_have_explicit_run_id(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = self.prepare(root)
            jobs = json.loads((root / 'jobs.json').read_text())
            jobs['10-1']['pages'][0]['jobs'][0].pop('run_id')
            (root / 'jobs.json').write_text(json.dumps(jobs))
            with self.assertRaisesRegex(ValueError, 'job_run_missing'):
                validate_required(root, evidence)

    def test_required_normalized_job_projection_must_match_raw(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = self.prepare(root)
            value = json.loads(evidence.read_text())
            value['observedChecks'][0]['jobName'] = 'spliced'
            evidence.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'job_projection_mismatch'):
                validate_required(root, evidence)


class SubjectBindingTests(unittest.TestCase):
    def test_complete_subject_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            self.assertEqual(validate_subject(fixture.root, fixture.subject),
                             {'workflowRuns': 1, 'eligibleRuns': 1, 'attempts': 1,
                              'jobAttempts': 1, 'artifactRuns': 1})

    def test_complete_artifact_map_omission_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.write('artifacts.json', {})
            with self.assertRaisesRegex(ValueError, 'artifact_map_coverage'):
                validate_subject(fixture.root, fixture.subject)

    def test_empty_artifact_page_cannot_satisfy_claimed_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            fixture.write('artifacts.json', {'10': [page('artifacts', [], 0)]})
            with self.assertRaisesRegex(ValueError, 'artifact_projection_mismatch'):
                validate_subject(fixture.root, fixture.subject)

    def test_latest_attempt_omission_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory), attempt=2)
            attempts = fixture.read('attempts.json')
            attempts.pop('10-2')
            fixture.write('attempts.json', attempts)
            with self.assertRaisesRegex(ValueError, 'attempt_map_coverage'):
                validate_subject(fixture.root, fixture.subject)

    def test_normalized_job_id_splice_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            value = json.loads(fixture.subject.read_text())
            value['producerHistories'][0]['eligibleRuns'][0]['jobs'][0]['id'] = 999
            fixture.subject.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'job_projection_mismatch'):
                validate_subject(fixture.root, fixture.subject)

    def test_workflow_run_requires_explicit_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            pages = fixture.read('workflow-runs.json')
            pages[0]['workflow_runs'][0].pop('run_attempt')
            fixture.write('workflow-runs.json', pages)
            with self.assertRaisesRegex(ValueError, 'run_attempt_missing'):
                validate_subject(fixture.root, fixture.subject)

    def test_attempt_metadata_requires_explicit_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            attempts = fixture.read('attempts.json')
            attempts['10-1'].pop('run_attempt')
            fixture.write('attempts.json', attempts)
            with self.assertRaisesRegex(ValueError, 'attempt_number_missing'):
                validate_subject(fixture.root, fixture.subject)

    def test_subject_job_requires_explicit_run_id(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            jobs = fixture.read('jobs.json')
            jobs['10-1'][0]['jobs'][0].pop('run_id')
            fixture.write('jobs.json', jobs)
            with self.assertRaisesRegex(ValueError, 'job_run_missing'):
                validate_subject(fixture.root, fixture.subject)

    def test_subject_job_requires_explicit_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            jobs = fixture.read('jobs.json')
            jobs['10-1'][0]['jobs'][0].pop('run_attempt')
            fixture.write('jobs.json', jobs)
            with self.assertRaisesRegex(ValueError, 'job_attempt_missing'):
                validate_subject(fixture.root, fixture.subject)

    def test_unexpected_attempt_map_entry_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            attempts = fixture.read('attempts.json')
            attempts['10-2'] = attempt_metadata(attempt=2)
            fixture.write('attempts.json', attempts)
            with self.assertRaisesRegex(ValueError, 'attempt_unexpected'):
                validate_subject(fixture.root, fixture.subject)

    def test_unexpected_jobs_map_entry_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            jobs = fixture.read('jobs.json')
            jobs['10-2'] = [page('jobs', [raw_job(attempt=2)], 1)]
            fixture.write('jobs.json', jobs)
            with self.assertRaisesRegex(ValueError, 'jobs_unexpected'):
                validate_subject(fixture.root, fixture.subject)

    def test_unexpected_artifact_map_entry_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            artifacts = fixture.read('artifacts.json')
            artifacts['11'] = [page('artifacts', [], 0)]
            fixture.write('artifacts.json', artifacts)
            with self.assertRaisesRegex(ValueError, 'artifact_run_unexpected'):
                validate_subject(fixture.root, fixture.subject)

    def test_artifact_name_or_digest_splice_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory))
            artifacts = fixture.read('artifacts.json')
            artifacts['10'][0]['artifacts'][0]['digest'] = 'sha256:' + 'e' * 64
            fixture.write('artifacts.json', artifacts)
            with self.assertRaisesRegex(ValueError, 'artifact_projection_mismatch'):
                validate_subject(fixture.root, fixture.subject)

    def test_cross_attempt_job_splice_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Fixture(Path(directory), attempt=2)
            jobs = fixture.read('jobs.json')
            jobs['10-2'][0]['jobs'][0]['run_attempt'] = 1
            fixture.write('jobs.json', jobs)
            with self.assertRaisesRegex(ValueError, 'job_attempt_mismatch'):
                validate_subject(fixture.root, fixture.subject)


if __name__ == '__main__':
    unittest.main(verbosity=2)
