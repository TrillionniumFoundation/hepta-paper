#!/usr/bin/env python3
"""Independent controls for GitHub skipped-job timestamp compatibility."""
from __future__ import annotations
import copy
import unittest
from qualification_subject_integrity import validate_job_time
RUN_CREATED = "2026-09-06T02:44:00Z"
RUN_UPDATED = "2026-09-06T02:45:00Z"
class QualificationJobTimeSkewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.skipped = {"id": 1, "name": "nonrequired-skipped", "status": "completed",
            "conclusion": "skipped", "startedAt": "2026-09-06T02:44:21Z",
            "completedAt": "2026-09-06T02:44:12Z", "steps": []}
    def test_nonrequired_skipped_empty_job_is_accepted_verbatim_inside_run(self) -> None:
        before = copy.deepcopy(self.skipped)
        validate_job_time(self.skipped, {"required-context"}, RUN_CREATED, RUN_UPDATED)
        self.assertEqual(self.skipped, before)
    def test_required_or_executed_job_inversion_is_rejected(self) -> None:
        cases = [(self.skipped, {"nonrequired-skipped"}),
            ({**self.skipped, "conclusion": "success", "steps": [{"number": 1,
             "name": "Execute", "status": "completed", "conclusion": "success"}]},
             {"required-context"})]
        for job, required in cases:
            with self.subTest(name=job["name"], required=required), self.assertRaisesRegex(
                    ValueError, "qualification_job_time_order"):
                validate_job_time(job, required, RUN_CREATED, RUN_UPDATED)
    def test_compatible_skip_clocks_must_remain_inside_run(self) -> None:
        job = {**self.skipped, "startedAt": "2026-09-06T02:46:00Z"}
        with self.assertRaisesRegex(ValueError, "qualification_job_time_outside_run"):
            validate_job_time(job, {"required-context"}, RUN_CREATED, RUN_UPDATED)
if __name__ == "__main__":
    unittest.main(verbosity=2)
