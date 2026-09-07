#!/usr/bin/env python3
"""Direct controls for GitHub non-evidentiary skipped-job clock inversions."""

from __future__ import annotations

import copy
import unittest

from qualification_subject_integrity import validate_job_time

RUN_CREATED = "2026-09-06T02:44:00Z"
RUN_UPDATED = "2026-09-06T02:45:00Z"


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

    def validate(self, job: dict, required: set[str] | None = None) -> None:
        validate_job_time(
            job,
            required or {"required-context"},
            RUN_CREATED,
            RUN_UPDATED,
        )

    def test_nonrequired_skipped_empty_job_inversions_are_accepted_verbatim(self) -> None:
        for started in ("2026-09-06T02:44:13Z", "2026-09-06T02:44:21Z"):
            job = {**self.skipped, "startedAt": started}
            before = copy.deepcopy(job)
            self.validate(job)
            self.assertEqual(job, before)

    def test_required_or_executed_job_inversion_is_rejected(self) -> None:
        cases = [
            (self.skipped, {"nonrequired-skipped"}),
            ({**self.skipped, "conclusion": "success", "steps": [{
                "number": 1,
                "name": "Execute",
                "status": "completed",
                "conclusion": "success",
            }]}, {"required-context"}),
        ]
        for job, required in cases:
            with self.subTest(name=job["name"], required=required):
                with self.assertRaisesRegex(ValueError, "qualification_job_time_order"):
                    self.validate(job, required)

    def test_compatible_skip_clocks_must_remain_inside_run_interval(self) -> None:
        job = {**self.skipped, "startedAt": "2026-09-06T02:46:00Z"}
        with self.assertRaisesRegex(ValueError, "qualification_job_time_outside_run"):
            self.validate(job)


if __name__ == "__main__":
    unittest.main(verbosity=2)
