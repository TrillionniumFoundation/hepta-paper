#!/usr/bin/env python3
"""Fail-closed regression tests for QualificationSubjectV3."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "docs" / "rust" / "tools"
sys.path.insert(0, str(TOOLS))


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collector = load("collect_required_checks_v3", TOOLS / "collect-required-checks-v3.py")
strict_schema = load("strict_schema_v3_tests", TOOLS / "strict_json_schema.py")

SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40
SHA_D = "d" * 40
DIGEST_A = "sha256:" + "1" * 64
DIGEST_B = "sha256:" + "2" * 64


def exact_subject() -> dict:
    return {
        "repository": {"id": 1349108143, "fullName": "TrillionniumFoundation/hepta-paper"},
        "pullRequestNumber": 42,
        "base": {
            "repositoryId": 1349108143,
            "repository": "TrillionniumFoundation/hepta-paper",
            "ref": "codex/rust-plan-v3-final-product-20260830",
            "commit": SHA_A,
            "tree": SHA_B,
        },
        "head": {
            "repositoryId": 1349108143,
            "repository": "TrillionniumFoundation/hepta-paper",
            "ref": "codex/rust-plan-v4-rc1-20260831",
            "commit": SHA_C,
            "tree": SHA_D,
        },
        "testedMerge": {"commit": SHA_B, "tree": SHA_A},
    }


def step(number: int = 1, conclusion: str | None = "success") -> dict:
    return {"number": number, "name": f"step-{number}", "status": "completed", "conclusion": conclusion}


def job(identifier: int = 101, conclusion: str | None = "success") -> dict:
    steps = [step(1, conclusion)]
    return {
        "id": identifier,
        "name": "required-context",
        "status": "completed",
        "conclusion": conclusion,
        "startedAt": "2026-08-31T00:00:00Z",
        "completedAt": "2026-08-31T00:01:00Z",
        "steps": steps,
    }


def history(run_id: int = 1001, attempt: int = 1, conclusion: str | None = "success") -> dict:
    jobs = [job(101 + run_id, conclusion)]
    all_steps = [{"jobId": row["id"], **item} for row in jobs for item in row["steps"]]
    artifacts = [{
        "id": 2000 + run_id,
        "name": f"artifact-{run_id}",
        "sizeInBytes": 42,
        "digest": DIGEST_A,
        "expired": False,
        "createdAt": "2026-08-31T00:01:01Z",
        "updatedAt": "2026-08-31T00:01:02Z",
    }]
    return {
        "workflowId": 345000001,
        "workflowPath": ".github/workflows/producer.yml",
        "workflowGitBlobSha": SHA_A,
        "workflowSha256": DIGEST_A,
        "runId": run_id,
        "runNumber": run_id,
        "runAttempt": attempt,
        "event": "pull_request",
        "status": "completed",
        "conclusion": conclusion,
        "createdAt": "2026-08-31T00:00:00Z",
        "updatedAt": f"2026-08-31T00:0{min(attempt, 9)}:00Z",
        "runStartedAt": "2026-08-31T00:00:00Z",
        "checkSuiteId": 3000 + run_id,
        "jobSetSha256": collector.sha256_value(jobs),
        "stepSetSha256": collector.sha256_value(all_steps),
        "artifactSetSha256": collector.sha256_value(artifacts),
        "jobs": jobs,
        "artifacts": artifacts,
    }


def selected(row: dict) -> dict:
    return {
        "workflowId": row["workflowId"],
        "runId": row["runId"],
        "runAttempt": row["runAttempt"],
        "jobSetSha256": row["jobSetSha256"],
        "stepSetSha256": row["stepSetSha256"],
        "artifactSetSha256": row["artifactSetSha256"],
    }


def subject(exact: dict | None = None, rows: list[dict] | None = None) -> dict:
    exact = exact or exact_subject()
    rows = rows or [history()]
    return collector.qualification_subject(exact, DIGEST_B, rows, [selected(rows[-1])])


class QualificationSubjectV3Tests(unittest.TestCase):
    def assert_subject_changes(self, mutate) -> None:
        baseline = subject()
        hostile = exact_subject()
        mutate(hostile)
        self.assertNotEqual(baseline["snapshotIdentity"], subject(hostile)["snapshotIdentity"])

    def test_subject_validates_against_strict_schema(self) -> None:
        schema = json.loads((ROOT / "docs/qualification/schemas/qualification-subject-v3.schema.json").read_text(encoding="utf-8"))
        strict_schema.validate(subject(), schema)

    def test_base_commit_tree_repository_and_ref_are_identity(self) -> None:
        mutations = [
            lambda value: value["base"].__setitem__("commit", SHA_D),
            lambda value: value["base"].__setitem__("tree", SHA_C),
            lambda value: value["base"].__setitem__("repositoryId", 1),
            lambda value: value["base"].__setitem__("repository", "other/repository"),
            lambda value: value["base"].__setitem__("ref", "other-base"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.assert_subject_changes(mutate)

    def test_merge_commit_and_tree_are_identity(self) -> None:
        self.assert_subject_changes(lambda value: value["testedMerge"].__setitem__("commit", SHA_D))
        self.assert_subject_changes(lambda value: value["testedMerge"].__setitem__("tree", SHA_D))

    def test_older_run_rerun_after_newer_run_changes_identity(self) -> None:
        older = history(1001, 1)
        newer = history(1002, 1)
        before = subject(rows=[older, newer])
        rerun = copy.deepcopy(older)
        rerun["runAttempt"] = 2
        rerun["updatedAt"] = "2026-08-31T00:09:00Z"
        after = subject(rows=[rerun, newer])
        self.assertNotEqual(before["eligibleRunSetSha256"], after["eligibleRunSetSha256"])
        self.assertNotEqual(before["snapshotIdentity"], after["snapshotIdentity"])

    def test_old_run_failed_rerun_is_rejected_even_with_newer_success(self) -> None:
        older = history(1001, 2, "failure")
        newer = history(1002, 1, "success")
        with self.assertRaisesRegex(ValueError, "eligible_producer_attempt_failed"):
            collector.validate_all_eligible_runs([older, newer])

    def test_pending_noncanonical_run_is_rejected(self) -> None:
        pending = history(1001)
        pending["status"] = "in_progress"
        pending["conclusion"] = None
        with self.assertRaises(RuntimeError):
            collector.validate_all_eligible_runs([pending, history(1002)])

    def test_job_step_artifact_and_definition_mutation_change_identity(self) -> None:
        baseline_row = history()
        baseline = subject(rows=[baseline_row])
        for field in ["jobSetSha256", "stepSetSha256", "artifactSetSha256", "workflowSha256"]:
            hostile = copy.deepcopy(baseline_row)
            hostile[field] = DIGEST_B
            with self.subTest(field=field):
                self.assertNotEqual(baseline["snapshotIdentity"], subject(rows=[hostile])["snapshotIdentity"])

    def test_snapshot_identity_is_hash_of_subject_without_itself(self) -> None:
        value = subject()
        identity = value.pop("snapshotIdentity")
        self.assertEqual(identity, collector.sha256_value(value))

    def test_exact_pr_binding_checks_base_and_head_repository_and_sha(self) -> None:
        exact = exact_subject()
        run = {
            "repository": {"id": 1349108143, "full_name": "TrillionniumFoundation/hepta-paper"},
            "head_repository": {"id": 1349108143, "full_name": "TrillionniumFoundation/hepta-paper"},
            "pull_requests": [{
                "number": 42,
                "base": {"ref": exact["base"]["ref"], "sha": exact["base"]["commit"], "repo": {"id": 1349108143}},
                "head": {"ref": exact["head"]["ref"], "sha": exact["head"]["commit"], "repo": {"id": 1349108143}},
            }],
        }
        self.assertTrue(collector.pr_binding_matches(run, exact))
        run["pull_requests"][0]["base"]["sha"] = SHA_D
        self.assertFalse(collector.pr_binding_matches(run, exact))


if __name__ == "__main__":
    unittest.main(verbosity=2)
