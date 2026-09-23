#!/usr/bin/env python3
"""Regression controls for GitHub synthetic skipped-job clock inversions."""

from __future__ import annotations

import copy
import unittest

from qualification_subject_integrity import validate_subject
from test_qualification_subject_v3 import reseal, subject


def jobs(value: dict) -> list[dict]:
    return value["producerHistories"][0]["eligibleRuns"][0]["jobs"]


class QualificationJobTimeCompatibilityTests(unittest.TestCase):
    def test_nonrequired_zero_step_skips_preserve_raw_reversed_clocks(self) -> None:
        value = subject()
        jobs(value).extend([
            {
                "id": 9001,
                "name": "non-required-skipped-one-second",
                "status": "completed",
                "conclusion": "skipped",
                "startedAt": "2026-09-01T00:00:02Z",
                "completedAt": "2026-09-01T00:00:01Z",
                "steps": [],
            },
            {
                "id": 9002,
                "name": "non-required-skipped-nine-seconds",
                "status": "completed",
                "conclusion": "skipped",
                "startedAt": "2026-09-01T00:00:10Z",
                "completedAt": "2026-09-01T00:00:01Z",
                "steps": [],
            },
        ])
        validate_subject(reseal(value))

    def test_required_executed_and_failed_jobs_remain_strict(self) -> None:
        required = subject()
        jobs(required)[0].update(
            startedAt="2026-09-01T00:01:00Z",
            completedAt="2026-09-01T00:00:59Z",
        )

        executed = subject()
        jobs(executed).append({
            "id": 9003,
            "name": "non-required-executed",
            "status": "completed",
            "conclusion": "skipped",
            "startedAt": "2026-09-01T00:00:02Z",
            "completedAt": "2026-09-01T00:00:01Z",
            "steps": [{
                "number": 1,
                "name": "Observed step",
                "status": "completed",
                "conclusion": "skipped",
            }],
        })

        failed = subject()
        jobs(failed).append({
            "id": 9004,
            "name": "non-required-failed",
            "status": "completed",
            "conclusion": "failure",
            "startedAt": "2026-09-01T00:00:02Z",
            "completedAt": "2026-09-01T00:00:01Z",
            "steps": [],
        })

        for value in (required, executed, failed):
            with self.subTest(job=jobs(value)[-1]["name"]), self.assertRaisesRegex(
                ValueError, "qualification_job_time_order"
            ):
                validate_subject(reseal(value))

    def test_compatible_skip_clocks_must_stay_inside_the_run_interval(self) -> None:
        value = subject()
        jobs(value).append({
            "id": 9005,
            "name": "non-required-skipped-outside-run",
            "status": "completed",
            "conclusion": "skipped",
            "startedAt": "2026-09-01T00:03:00Z",
            "completedAt": "2026-09-01T00:00:01Z",
            "steps": [],
        })
        with self.assertRaisesRegex(ValueError, "qualification_job_time_outside_run"):
            validate_subject(reseal(value))


if __name__ == "__main__":
    unittest.main(verbosity=2)
