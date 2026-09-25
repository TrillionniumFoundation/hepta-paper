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


if __name__ == '__main__':
    unittest.main()
