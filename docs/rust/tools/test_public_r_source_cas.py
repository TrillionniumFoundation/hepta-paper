#!/usr/bin/env python3
"""Portable adversarial controls; synthetic bytes are never R qualification."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('r_source', Path(__file__).with_name('materialize-public-r-source-cas.py'))
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class PublicSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / R.TARGET
        self.target.parent.mkdir(parents=True)
        self.files = {'manifest.json': b'fixture, not R authority',
                      'src/contrib/example.tar.gz': b'opaque source fixture'}

    def test_fresh_and_existing_materializations_are_exact_and_idempotent(self):
        self.target.mkdir()
        self.assertEqual(R.publish(self.root, self.files), 'public_source_materialized')
        before = (self.target / 'manifest.json').stat()
        self.assertEqual(R.publish(self.root, self.files), 'existing_public_source_verified')
        self.assertEqual((self.target / 'manifest.json').stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual((self.target / 'manifest.json').stat().st_ino, before.st_ino)

    def test_existing_tampered_or_extra_bytes_are_never_rewritten(self):
        R.publish(self.root, self.files)
        selected = self.target / 'manifest.json'
        selected.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            R.publish(self.root, self.files)
        self.assertEqual(selected.read_bytes(), b'changed')
        selected.write_bytes(self.files['manifest.json'])
        (self.target / 'extra').write_bytes(b'keep me')
        with self.assertRaises(ValueError):
            R.publish(self.root, self.files)
        self.assertEqual((self.target / 'extra').read_bytes(), b'keep me')

    def test_existing_symlink_and_hardlink_are_rejected(self):
        R.publish(self.root, self.files)
        selected = self.target / 'manifest.json'
        outside = self.root / 'outside'
        outside.write_bytes(self.files['manifest.json'])
        selected.unlink()
        selected.symlink_to(outside)
        with self.assertRaises(ValueError):
            R.publish(self.root, self.files)
        selected.unlink()
        selected.hardlink_to(outside)
        with self.assertRaises(ValueError):
            R.publish(self.root, self.files)
        self.assertEqual(outside.read_bytes(), self.files['manifest.json'])

    def test_target_symlink_is_rejected_before_writes(self):
        outside = self.root / 'outside'
        outside.mkdir()
        self.target.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'target_unsafe'):
            R.publish(self.root, self.files)
        self.assertEqual(list(outside.iterdir()), [])

    def test_parent_symlink_is_rejected_before_writes(self):
        parent = self.target.parent
        parent.rmdir()
        outside = self.root / 'outside'
        outside.mkdir()
        parent.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'parent_unsafe'):
            R.publish(self.root, self.files)
        self.assertEqual(list(outside.iterdir()), [])

    def test_unsafe_paths_and_oversized_source_fail_before_staging(self):
        for name in ['../outside', '/outside', 'src//bad', 'src/./bad', 'src\\bad']:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'publication_input_invalid'):
                R.publish(self.root, {name: b'a'})
        with patch.object(R, 'MAX_TOTAL', 1), self.assertRaises(ValueError):
            R.publish(self.root, self.files)
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_publish_failure_removes_only_owned_stage(self):
        self.target.mkdir()
        with patch.object(R.os, 'replace', side_effect=OSError('injected rename failure')):
            with self.assertRaises(OSError):
                R.publish(self.root, self.files)
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    def test_unverified_or_noncanonical_source_is_not_accepted(self):
        with self.assertRaisesRegex(ValueError, 'manifest_identity_mismatch'):
            R.validate_bundle(self.files)
        with patch.object(R, 'git', return_value=b'wrong-tree\n'):
            with self.assertRaisesRegex(ValueError, 'source_tree_unavailable'):
                R.capture(self.root)
        R.publish(self.root, self.files)
        (self.target / 'manifest.json').chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'file_unsafe'):
            R.publish(self.root, self.files)


if __name__ == '__main__':
    unittest.main(verbosity=2)
