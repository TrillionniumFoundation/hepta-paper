#!/usr/bin/env python3
"""Deterministic self-tests for Plan v4 program-truth qualification."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
DERIVE = ROOT / "docs/rust/tools/derive-effective-status.py"
VALIDATE = ROOT / "docs/rust/tools/validate-program-truth.py"
REQUIRED = ROOT / "docs/rust/qualification/source-required-checks.v1.json"
COMMIT = "a" * 40
TREE = "b" * 40


def check_run(name: str, identifier: int) -> dict[str, object]:
    return {
        "id": identifier,
        "name": name,
        "status": "completed",
        "conclusion": "success",
        "head_sha": COMMIT,
        "started_at": "2026-08-31T00:00:00Z",
        "completed_at": "2026-08-31T00:01:00Z",
        "details_url": f"https://example.invalid/check/{identifier}",
        "app": {"id": 15368},
    }


class PlanV4QualificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.required = json.loads(REQUIRED.read_text(encoding="utf-8"))
        cls.complete = {
            "total_count": len(cls.required["contexts"]),
            "check_runs": [
                check_run(name, index)
                for index, name in enumerate(cls.required["contexts"], start=1)
            ],
        }

    def run_derive(
        self,
        payload: dict[str, object],
        expect_success: bool,
    ) -> tuple[subprocess.CompletedProcess[str], Path]:
        temporary = tempfile.TemporaryDirectory(prefix="hepta-plan-v4-test-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        evidence = root / "check-runs.json"
        output = root / "effective-status.v1.json"
        evidence.write_text(json.dumps(payload), encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(DERIVE),
                "--check-runs",
                str(evidence),
                "--repository",
                "TrillionniumFoundation/hepta-paper",
                "--commit",
                COMMIT,
                "--tree",
                TREE,
                "--workflow",
                "qualification-selftest",
                "--run-id",
                "1",
                "--run-attempt",
                "1",
                "--output",
                str(output),
                "--skip-checkout-verification",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if expect_success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.is_file())
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertFalse(output.exists())
        return result, output

    def test_static_program_truth_validates(self) -> None:
        result = subprocess.run(
            [sys.executable, str(VALIDATE)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("rust_plan_v4_program_truth_valid", result.stdout)

    def test_complete_exact_head_matrix_derives_nonactivating_status(self) -> None:
        _, output = self.run_derive(copy.deepcopy(self.complete), True)
        value = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(value["status"], "exact_head_source_qualified")
        self.assertFalse(value["authority"]["productionAuthorized"])
        self.assertFalse(value["authority"]["externalAuthorityClaimed"])
        self.assertEqual(
            value["effective"]["currentStatusRows"]["Foundation contracts"],
            "source_qualified",
        )
        self.assertEqual(
            value["effective"]["currentStatusRows"]["Production target host"],
            "blocked_external",
        )
        self.assertEqual(
            value["effective"]["supplementalBlockers"][0]["status"],
            "blocked_external",
        )

    def test_zero_job_collection_fails_closed(self) -> None:
        self.run_derive({"total_count": 0, "check_runs": []}, False)

    def test_missing_required_context_fails_closed(self) -> None:
        payload = copy.deepcopy(self.complete)
        payload["check_runs"].pop()
        payload["total_count"] = len(payload["check_runs"])
        self.run_derive(payload, False)

    def test_skipped_required_context_fails_closed(self) -> None:
        payload = copy.deepcopy(self.complete)
        payload["check_runs"][0]["conclusion"] = "skipped"
        self.run_derive(payload, False)

    def test_wrong_app_cannot_impersonate_required_context(self) -> None:
        payload = copy.deepcopy(self.complete)
        payload["check_runs"][0]["app"]["id"] = 1
        self.run_derive(payload, False)

    def test_wrong_head_cannot_be_reused(self) -> None:
        payload = copy.deepcopy(self.complete)
        payload["check_runs"][0]["head_sha"] = "c" * 40
        self.run_derive(payload, False)

    def test_latest_failed_rerun_invalidates_older_success(self) -> None:
        payload = copy.deepcopy(self.complete)
        first = payload["check_runs"][0]
        failed = copy.deepcopy(first)
        failed["id"] = 10_000
        failed["conclusion"] = "failure"
        payload["check_runs"].append(failed)
        payload["total_count"] = len(payload["check_runs"])
        self.run_derive(payload, False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
