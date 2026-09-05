#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from validate_qualification_collection_completeness import validate_pages, validate_required, validate_subject


def page(key, rows, total):
    return {'total_count': total, key: rows}


def run(identifier=10, attempt=1):
    return {'id': identifier, 'run_attempt': attempt}


def job(identifier=100, run_id=10, attempt=1):
    return {'id': identifier, 'run_id': run_id, 'run_attempt': attempt}


class PageTests(unittest.TestCase):
    def test_short_final_page_matches_declared_total(self):
        rows = [{'id': i + 1} for i in range(101)]
        self.assertEqual(len(validate_pages([page('jobs', rows[:100], 101),
                                             page('jobs', rows[100:], 101)], 'jobs', 'ok')), 101)

    def test_declared_two_but_returned_one_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'page_incomplete'):
            validate_pages([page('jobs', [{'id': 1}], 2)], 'jobs', 'short')

    def test_declared_count_change_is_rejected(self):
        first = [{'id': i + 1} for i in range(100)]
        with self.assertRaisesRegex(ValueError, 'count_changed'):
            validate_pages([page('jobs', first, 101), page('jobs', [{'id': 101}], 102)], 'jobs', 'changed')

    def test_duplicate_identity_across_pages_is_rejected(self):
        first = [{'id': i + 1} for i in range(100)]
        with self.assertRaisesRegex(ValueError, 'duplicate_id'):
            validate_pages([page('jobs', first, 101), page('jobs', [{'id': 100}], 101)], 'jobs', 'duplicate')

    def test_incomplete_results_flag_is_rejected(self):
        value = page('check_runs', [], 0); value['incomplete_results'] = True
        with self.assertRaisesRegex(ValueError, 'incomplete_results'):
            validate_pages([value], 'check_runs', 'incomplete')

    def test_boolean_total_count_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'count_invalid'):
            validate_pages([page('jobs', [], False)], 'jobs', 'bool')


class RawBindingTests(unittest.TestCase):
    def write(self, root: Path, name: str, value):
        (root / name).write_text(json.dumps(value), encoding='utf-8')

    def test_required_raw_identity_binds_observed_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, 'workflow-runs.json', [page('workflow_runs', [run()], 1)])
            self.write(root, 'check-runs.json', [page('check_runs', [{'id': 100}], 1)])
            self.write(root, 'jobs.json', {'10-1': {'runId': 10, 'runAttempt': 1,
                'pages': [page('jobs', [job()], 1)]}})
            evidence = root / 'evidence.json'
            self.write(root, evidence.name, {'status': 'complete_success_snapshot',
                'observedChecks': [{'runId': 10, 'runAttempt': 1, 'jobId': 100}]})
            result = validate_required(root, evidence)
            self.assertEqual(result, {'workflowRuns': 1, 'checkRuns': 1, 'jobAttempts': 1})

    def test_required_job_attempt_splice_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, 'workflow-runs.json', [page('workflow_runs', [run()], 1)])
            self.write(root, 'check-runs.json', [page('check_runs', [{'id': 100}], 1)])
            self.write(root, 'jobs.json', {'10-1': {'runId': 10, 'runAttempt': 1,
                'pages': [page('jobs', [job(attempt=2)], 1)]}})
            evidence = root / 'evidence.json'; self.write(root, evidence.name,
                {'status': 'complete_success_snapshot', 'observedChecks': []})
            with self.assertRaisesRegex(ValueError, 'job_attempt_mismatch'):
                validate_required(root, evidence)

    def test_subject_attempt_metadata_must_match_requested_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, 'workflow-runs.json', [page('workflow_runs', [run(attempt=2)], 1)])
            self.write(root, 'attempts.json', {'10-1': {'id': 10, 'run_attempt': 2}})
            self.write(root, 'jobs.json', {})
            self.write(root, 'artifacts.json', {'10': [page('artifacts', [], 0)]})
            subject = root / 'subject.json'; self.write(root, subject.name,
                {'status': 'exact_subject_complete', 'producerHistories': []})
            with self.assertRaisesRegex(ValueError, 'attempt_identity_mismatch'):
                validate_subject(root, subject)

    def test_subject_history_requires_raw_attempt_and_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, 'workflow-runs.json', [page('workflow_runs', [run()], 1)])
            self.write(root, 'attempts.json', {'10-1': run()})
            self.write(root, 'jobs.json', {'10-1': [page('jobs', [job()], 1)]})
            self.write(root, 'artifacts.json', {'10': [page('artifacts', [], 0)]})
            subject = root / 'subject.json'; self.write(root, subject.name,
                {'status': 'exact_subject_complete', 'producerHistories': [
                    {'eligibleRuns': [{'runId': 10, 'runAttempt': 1}]}]})
            result = validate_subject(root, subject)
            self.assertEqual(result['attempts'], 1)

    def test_subject_history_splice_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, 'workflow-runs.json', [page('workflow_runs', [run()], 1)])
            self.write(root, 'attempts.json', {'10-1': run()})
            self.write(root, 'jobs.json', {'10-1': [page('jobs', [job()], 1)]})
            self.write(root, 'artifacts.json', {'10': [page('artifacts', [], 0)]})
            subject = root / 'subject.json'; self.write(root, subject.name,
                {'status': 'exact_subject_complete', 'producerHistories': [
                    {'eligibleRuns': [{'runId': 10, 'runAttempt': 2}]}]})
            with self.assertRaisesRegex(ValueError, 'raw_identity_missing'):
                validate_subject(root, subject)

    def test_subject_artifact_pagination_is_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write(root, 'workflow-runs.json', [page('workflow_runs', [run()], 1)])
            self.write(root, 'attempts.json', {'10-1': run()})
            self.write(root, 'jobs.json', {'10-1': [page('jobs', [job()], 1)]})
            self.write(root, 'artifacts.json', {'10': [page('artifacts', [{'id': 200}], 2)]})
            subject = root / 'subject.json'; self.write(root, subject.name,
                {'status': 'exact_subject_complete', 'producerHistories': []})
            with self.assertRaisesRegex(ValueError, 'page_incomplete'):
                validate_subject(root, subject)


if __name__ == '__main__':
    unittest.main(verbosity=2)
