#!/usr/bin/env python3
"""No ancestry, stale blob or absent object can become current absorption."""
import gzip
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('history_dispositions', pathlib.Path(__file__).with_name('revalidate-history-dispositions.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DispositionTests(unittest.TestCase):
    def test_old_source_bytes_can_be_absorbed_without_runtime_authority(self):
        selected = [{'path': 'a.rs', 'current': {'gitBlob': 'a' * 40}}]
        self.assertEqual(MODULE.source_decision('a' * 40, selected, {}, 'retained-current'), 'absorb')
        self.assertEqual(MODULE.source_decision('a' * 40, selected, {}, 'archived-not-runtime'), 'reject')

    def test_changed_or_missing_successor_is_not_automatically_certified(self):
        prior = {'a.rs': {'gitBlobCalculatedFromObservedWorkingBytes': 'b' * 40}}
        selected = [{'path': 'a.rs', 'current': {'gitBlob': 'b' * 40}}]
        self.assertEqual(MODULE.source_decision('a' * 40, selected, prior, 'superseded'), 'supersede')
        selected[0]['current']['gitBlob'] = 'c' * 40
        self.assertEqual(MODULE.source_decision('a' * 40, selected, prior, 'superseded'), 'reference')
        selected[0]['current'] = None
        self.assertEqual(MODULE.source_decision('a' * 40, selected, prior, 'superseded'), 'reference')

    def test_compatibility_path_is_not_equality_and_empty_mapping_is_not_absorption(self):
        selected = [{'path': 'legacy/a.rs', 'current': {'gitBlob': 'b' * 40}}]
        self.assertEqual(MODULE.source_decision('a' * 40, selected, {}, 'compatibility-port'), 'reference')
        self.assertEqual(MODULE.source_decision('a' * 40, [], {}, 'retained-current'), 'reference')

    def test_full_snapshot_is_bound_to_candidate_bytes_and_old_ancestor_stays_reference(self):
        with tempfile.TemporaryDirectory(prefix='hepta-history-disposition-') as directory:
            root = pathlib.Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.PIPE).decode().strip()
            git('init', '-q')
            git('config', 'user.name', 'test')
            git('config', 'user.email', 'test@invalid.example')
            (root / 'a.rs').write_text('fn original() {}\n')
            git('add', 'a.rs'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'old')
            old = git('rev-parse', 'HEAD'); old_blob = git('rev-parse', 'HEAD:a.rs')
            archive = root / MODULE.ARCHIVE; archive.mkdir(parents=True)
            (archive / 'remote-heads-before.txt').write_text(f'{old}\trefs/heads/old\n{old}\trefs/heads/alias\n')
            ledger = {'branchHistoryDecisions': [], 'observedCurrentFiles': {},
                      'sourceDecisions': [{'id': 'source-1', 'oldPath': 'a.rs', 'oldGitBlob': old_blob,
                      'newPaths': ['a.rs'], 'decision': 'retained-current', 'rationale': 'retain source'}]}
            ledger_path = archive / 'final-source-decision-ledger.json.gz'
            ledger_path.write_bytes(gzip.compress(json.dumps(ledger).encode(), mtime=0))
            (root / 'a.rs').write_text('fn current() {}\n')
            git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'current')
            head = git('rev-parse', 'HEAD')
            report = MODULE.build_report(root, head)
            self.assertTrue(report['completeContentObservation'])
            self.assertEqual(report['branchCount'], 2)
            self.assertEqual(report['uniqueTipCount'], 1)
            self.assertEqual(report['sourceDispositionCounts'], {'reference': 1})
            self.assertEqual(report['branchDispositionCounts'], {'reference': 2})
            self.assertTrue(all(not value for value in report['authority'].values()))
            # Uncommitted edits to the archive cannot substitute the frozen input.
            ledger['sourceDecisions'][0]['oldGitBlob'] = 'f' * 40
            ledger_path.write_bytes(gzip.compress(json.dumps(ledger).encode(), mtime=0))
            self.assertEqual(MODULE.build_report(root, head), report)
            git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'missing historical object')
            missing = MODULE.build_report(root, git('rev-parse', 'HEAD'))
            self.assertFalse(missing['completeContentObservation'])
            self.assertEqual(missing['missingObjects'], ['f' * 40])
            self.assertEqual(missing['sourceDispositionCounts'], {'reference': 1})


    def test_malformed_duplicate_and_non_head_names_are_rejected(self):
        oid = 'a' * 40
        for data in [f'{oid} refs/heads/a\n{oid} refs/heads/a\n',
                     f'{oid} refs/tags/a\n', 'invalid refs/heads/a\n']:
            with self.assertRaises(ValueError):
                MODULE.parse_heads(data.encode())

    def test_fetches_only_missing_frozen_tip_and_preserves_current_refs(self):
        with tempfile.TemporaryDirectory(prefix='hepta-history-fetch-') as directory:
            root = pathlib.Path(directory)
            origin = root / 'origin'; origin.mkdir()
            def git(repository, *args):
                return subprocess.check_output(['git', *args], cwd=repository,
                                               stderr=subprocess.PIPE).decode().strip()
            git(origin, 'init', '-q', '-b', 'main')
            git(origin, 'config', 'user.name', 'test')
            git(origin, 'config', 'user.email', 'test@invalid.example')
            (origin / 'a.rs').write_text('fn source() {}\n')
            git(origin, 'add', '.')
            git(origin, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial')
            blob = git(origin, 'rev-parse', 'HEAD:a.rs')
            old = git(origin, '-c', 'commit.gpgsign=false', 'commit-tree',
                      git(origin, 'rev-parse', 'HEAD^{tree}'), '-m', 'separate historical tip')
            git(origin, 'update-ref', 'refs/heads/history-only', old)
            archive = origin / MODULE.ARCHIVE; archive.mkdir(parents=True)
            (archive / 'remote-heads-before.txt').write_text(f'{old} refs/heads/history-only\n')
            ledger = {'branchHistoryDecisions': [], 'observedCurrentFiles': {},
                      'sourceDecisions': [{'id': 'source-1', 'oldPath': 'a.rs', 'oldGitBlob': blob,
                      'newPaths': ['a.rs'], 'decision': 'retained-current', 'rationale': 'retain source'}]}
            (archive / 'final-source-decision-ledger.json.gz').write_bytes(
                gzip.compress(json.dumps(ledger).encode(), mtime=0))
            git(origin, 'add', '.')
            git(origin, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'current source')
            clone = root / 'clone'
            subprocess.check_call(['git', 'clone', '--quiet', '--no-local', '--single-branch',
                                   '--branch', 'main', str(origin), str(clone)])
            head = git(clone, 'rev-parse', 'HEAD')
            refs = git(clone, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads')
            report = MODULE.build_report(clone, head)
            self.assertFalse(report['completeContentObservation'])
            self.assertEqual(report['missingObjects'], [old])
            fetch = MODULE.fetch_missing_history(clone, head)
            self.assertTrue(fetch['attempted'])
            self.assertEqual(fetch['requestedTips'], [old])
            self.assertEqual(fetch['exitCode'], 0)
            self.assertEqual(fetch['remainingTips'], [])
            self.assertEqual(git(clone, 'rev-parse', 'HEAD'), head)
            self.assertEqual(git(clone, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), refs)
            self.assertEqual(git(clone, 'status', '--porcelain=v1'), '')
            self.assertTrue(MODULE.build_report(clone, head)['completeContentObservation'])
            self.assertFalse(MODULE.fetch_missing_history(clone, head)['attempted'])
            # A valid tree object must not be accepted as a historical commit.
            with self.assertRaisesRegex(ValueError, 'not a commit'):
                MODULE.missing_commits(clone, [(git(clone, 'rev-parse', 'HEAD^{tree}'), 'refs/heads/fake')])
            # The CI completeness mode must be a real failing exit, not a label.
            ledger['sourceDecisions'][0]['oldGitBlob'] = 'f' * 40
            target = clone / MODULE.ARCHIVE / 'final-source-decision-ledger.json.gz'
            target.write_bytes(gzip.compress(json.dumps(ledger).encode(), mtime=0))
            git(clone, 'config', 'user.name', 'test')
            git(clone, 'config', 'user.email', 'test@invalid.example')
            git(clone, 'add', '.')
            git(clone, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'unavailable source object')
            destination = root / 'incomplete.json'
            result = subprocess.run(['python3', '-B', str(pathlib.Path(MODULE.__file__)),
                                     '--root', str(clone), '--candidate', git(clone, 'rev-parse', 'HEAD'),
                                     '--require-complete', '--output', str(destination)],
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertFalse(json.loads(destination.read_text())['completeContentObservation'])


if __name__ == '__main__':
    unittest.main()
