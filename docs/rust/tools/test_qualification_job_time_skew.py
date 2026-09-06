#!/usr/bin/env python3
"""Closed compatibility tests for GitHub skipped-job timestamp skew."""

from __future__ import annotations

import copy
import unittest

from qualification_subject_integrity import validate_job_time


class QualificationJobTimeSkewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.skipped = {
            "id": 1,
            "name": "nonrequired-skipped",
            "status": "completed",
            "conclusion": "skipped",
            "startedAt": "2026-09-06T02:44:13Z",
            "completedAt": "2026-09-06T02:44:12Z",
            "steps": [],
        }

    def test_one_second_nonrequired_skipped_empty_job_is_accepted_verbatim(self) -> None:
        before = copy.deepcopy(self.skipped)
        validate_job_time(self.skipped, ["required-context"])
        self.assertEqual(self.skipped, before)

    def test_skew_above_one_second_is_rejected(self) -> None:
        job = {**self.skipped, "startedAt": "2026-09-06T02:44:14Z"}
        with self.assertRaisesRegex(ValueError, "qualification_job_time_order"):
            validate_job_time(job, ["required-context"])

    def test_required_or_executed_job_inversion_is_rejected(self) -> None:
        cases = [
            (self.skipped, ["nonrequired-skipped"]),
            ({**self.skipped, "conclusion": "success", "steps": [{
                "number": 1, "name": "Execute", "status": "completed", "conclusion": "success",
            }]}, ["required-context"]),
        ]
        for job, required in cases:
            with self.subTest(name=job["name"], required=required):
                with self.assertRaisesRegex(ValueError, "qualification_job_time_order"):
                    validate_job_time(job, required)


if __name__ == "__main__":
    unittest.main(verbosity=2)
