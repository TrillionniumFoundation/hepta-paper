#!/usr/bin/env python3
"""Hostile controls for the public historical R source route."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "docs/rust/tools"
sys.path.insert(0, str(TOOLS))

specification = importlib.util.spec_from_file_location(
    "verify_r_source_route", TOOLS / "verify-r-source-route.py")
ROUTE = importlib.util.module_from_spec(specification)
assert specification.loader is not None
specification.loader.exec_module(ROUTE)


class RSourceRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # The exact-head workflow deliberately materializes the public R source
        # bundle before impacted tests.  That makes the caller's gitlink dirty,
        # while the route verifier must continue to reject every dirty worktree.
        # Exercise the real verifier in a detached worktree of the same HEAD
        # instead of weakening that production-facing invariant.
        cls._temporary_directory = tempfile.TemporaryDirectory(
            prefix="hepta-r-source-route-tests-"
        )
        cls.root = (Path(cls._temporary_directory.name) / "checkout").resolve()
        try:
            ROUTE.git(
                ROOT,
                "worktree",
                "add",
                "--detach",
                str(cls.root),
                "HEAD",
            )
        except BaseException:
            cls._temporary_directory.cleanup()
            raise
        cls.tools = cls.root / "docs/rust/tools"
        cls.route = ROUTE.read_json(
            cls.root / "docs/rust/qualification/r-source-route.v1.json"
        )
        cls.schema = ROUTE.read_json(
            cls.root / "docs/rust/qualification/r-source-route.v1.schema.json"
        )

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            ROUTE.git(
                ROOT,
                "worktree",
                "remove",
                "--force",
                str(cls.root),
                check=False,
            )
        finally:
            cls._temporary_directory.cleanup()

    def test_real_repository_route_verifies_content_without_authority(self) -> None:
        result = ROUTE.verify_route(self.root, self.route, self.schema)
        self.assertEqual(
            result["status"],
            "public_historical_source_content_verified_nonactivating",
        )
        self.assertEqual(result["historical"]["fileCount"], 107)
        self.assertEqual(result["historical"]["packageCount"], 104)
        self.assertFalse(result["originalGitlink"]["commitObjectFetchedAndVerified"])
        self.assertFalse(result["originalGitlink"]["equivalenceClaimed"])
        self.assertFalse(result["currentBuildClosureVerified"])
        self.assertFalse(result["independentAcceptance"])
        self.assertFalse(result["productionAuthorized"])

    def test_static_route_cannot_claim_original_gitlink_or_acceptance(self) -> None:
        for mutate in [
            lambda value: value["originalGitlink"].update(verified=True),
            lambda value: value["originalGitlink"].update(equivalenceClaimed=True),
            lambda value: value["authority"].update(sourceContentVerified=True),
            lambda value: value["authority"].update(originalGitlinkVerified=True),
            lambda value: value["authority"].update(productionAuthorized=True),
            lambda value: value["acceptance"].update(independentReviewRequired=False),
        ]:
            candidate = copy.deepcopy(self.route)
            mutate(candidate)
            with self.subTest(candidate=candidate):
                with self.assertRaises(ValueError):
                    ROUTE.validate_schema(candidate, self.schema)

    def test_materializer_binding_drift_fails_before_capture(self) -> None:
        fake = types.SimpleNamespace(
            PUBLIC_TREE="0" * 40,
            MANIFEST_BLOB=self.route["publicHistoricalRoute"]["manifestBlob"],
            TARGET=self.route["targetPath"],
            ROOT=self.root,
            capture=mock.Mock(side_effect=AssertionError("capture must not run")),
        )
        with mock.patch.object(ROUTE, "load_materializer", return_value=fake):
            with self.assertRaisesRegex(ValueError, "materializer_binding_drift"):
                ROUTE.verify_route(self.root, self.route, self.schema)
        fake.capture.assert_not_called()

    def test_current_gitlink_drift_fails_before_historical_capture(self) -> None:
        original = ROUTE.git

        def changed(root: Path, *args: str, **kwargs):
            if args[:2] == ("ls-tree", "HEAD"):
                return subprocess.CompletedProcess(
                    args,
                    0,
                    "160000 commit "
                    + "0" * 40
                    + "\t"
                    + self.route["targetPath"]
                    + "\n",
                    "",
                )
            return original(root, *args, **kwargs)

        with mock.patch.object(ROUTE, "git", side_effect=changed), mock.patch.object(
            ROUTE, "load_materializer"
        ) as materializer:
            with self.assertRaisesRegex(ValueError, "current_gitlink_drift"):
                ROUTE.verify_route(self.root, self.route, self.schema)
        materializer.assert_not_called()

    def test_historical_subtree_drift_fails_before_loading_materializer(self) -> None:
        original = ROUTE.git

        def changed(root: Path, *args: str, **kwargs):
            if args[:2] == (
                "rev-parse",
                "18b20af983e32575a2faab7dd8fa721a61d2e68c:runtime-images/r-scientific/source-cas",
            ):
                return subprocess.CompletedProcess(args, 0, "0" * 40 + "\n", "")
            return original(root, *args, **kwargs)

        with mock.patch.object(ROUTE, "git", side_effect=changed), mock.patch.object(
            ROUTE, "load_materializer"
        ) as materializer:
            with self.assertRaisesRegex(ValueError, "historical_subtree_drift"):
                ROUTE.verify_route(self.root, self.route, self.schema)
        materializer.assert_not_called()

    def test_dirty_worktree_denies_before_route_inspection(self) -> None:
        def dirty(_root: Path, *args: str, **_kwargs):
            if args and args[0] == "status":
                return subprocess.CompletedProcess(args, 0, " M controlled\n", "")
            raise AssertionError(f"unexpected git call after dirty status: {args}")

        with mock.patch.object(ROUTE, "git", side_effect=dirty):
            with self.assertRaisesRegex(ValueError, "worktree_not_clean"):
                ROUTE.verify_route(self.root, self.route, self.schema)

    def test_cli_output_is_bounded_nonactivating_json(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(self.tools / "verify-r-source-route.py")],
            cwd=self.root,
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
            env={
                "PATH": "/usr/bin:/bin",
                "HOME": "/nonexistent",
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertFalse(value["productionAuthorized"])
        self.assertFalse(value["externalAuthorityClaimed"])
        self.assertFalse(value["originalGitlink"]["commitObjectFetchedAndVerified"])
        self.assertLess(len(completed.stdout.encode("utf-8")), 64 * 1024)


if __name__ == "__main__":
    unittest.main(verbosity=2)
