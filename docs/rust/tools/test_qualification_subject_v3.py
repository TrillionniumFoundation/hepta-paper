#!/usr/bin/env python3
"""Hostile tests for Qualification Subject V3 identity and history semantics."""

from __future__ import annotations

import copy
import unittest

from derive_effective_status_v2 import derive
from qualification_subject_v3 import (
    assemble_subject,
    repository_matches,
    sha256_value,
    validate_history_freshness,
)

SHA_A = "a" * 40
SHA_B = "b" * 40
SHA_C = "c" * 40
SHA_D = "d" * 40
SHA_E = "e" * 40
SHA_F = "f" * 40
HASH = "sha256:" + "1" * 64


def successful_job(name: str, identifier: int) -> dict:
    return {
        "id": identifier,
        "name": name,
        "status": "completed",
        "conclusion": "success",
        "startedAt": "2026-09-01T00:00:00Z",
        "completedAt": "2026-09-01T00:01:00Z",
        "steps": [
            {
                "number": 1,
                "name": "Set up job",
                "status": "completed",
                "conclusion": "success",
            },
            {
                "number": 2,
                "name": "Execute qualification",
                "status": "completed",
                "conclusion": "success",
            },
        ],
    }


def attempt(
    *,
    run_id: int,
    run_number: int,
    attempt_number: int,
    updated: str,
    context: str = "required-context",
    conclusion: str = "success",
) -> dict:
    jobs = [successful_job(context, run_id * 10 + attempt_number)]
    if conclusion != "success":
        jobs[0]["conclusion"] = conclusion
        jobs[0]["steps"][-1]["conclusion"] = conclusion
    artifacts = [
        {
            "id": run_id * 100 + attempt_number,
            "name": f"evidence-{run_id}-{attempt_number}",
            "sizeInBytes": 10,
            "expired": False,
            "createdAt": updated,
            "expiresAt": "2026-12-01T00:00:00Z",
            "digest": HASH,
        }
    ]
    flattened_steps = [
        {"jobId": jobs[0]["id"], **step} for step in jobs[0]["steps"]
    ]
    return {
        "workflowId": 99,
        "workflowPath": ".github/workflows/producer.yml",
        "runId": run_id,
        "runNumber": run_number,
        "runAttempt": attempt_number,
        "event": "pull_request",
        "headSha": SHA_B,
        "headBranch": "candidate",
        "baseRef": "product",
        "baseCommit": SHA_A,
        "status": "completed",
        "conclusion": conclusion,
        "createdAt": "2026-09-01T00:00:00Z",
        "updatedAt": updated,
        "checkSuiteId": run_id * 1000,
        "jobs": jobs,
        "jobSetSha256": sha256_value(jobs),
        "stepSetSha256": sha256_value(flattened_steps),
        "artifacts": artifacts,
        "artifactSetSha256": sha256_value(artifacts),
    }


def history(rows: list[dict]) -> dict:
    canonical = max(rows, key=lambda row: (row["runNumber"], row["runId"]))
    return {
        "workflowId": 99,
        "workflowPath": ".github/workflows/producer.yml",
        "requiredContexts": ["required-context"],
        "canonicalRunId": canonical["runId"],
        "canonicalRunAttempt": canonical["runAttempt"],
        "canonicalUpdatedAt": canonical["updatedAt"],
        "eligibleRuns": rows,
        "historyHash": sha256_value(rows),
    }


def subject(
    histories: list[dict] | None = None,
    required_snapshot: str = HASH,
) -> dict:
    if histories is None:
        row = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        histories = [history([row])]
    return assemble_subject(
        repository={
            "id": 1349108143,
            "fullName": "TrillionniumFoundation/hepta-paper",
        },
        pull_request={
            "number": 42,
            "state": "open",
            "base": {
                "repositoryId": 1349108143,
                "repository": "TrillionniumFoundation/hepta-paper",
                "ref": "product",
                "commit": SHA_A,
                "tree": SHA_C,
            },
            "head": {
                "repositoryId": 1349108143,
                "repository": "TrillionniumFoundation/hepta-paper",
                "ref": "candidate",
                "commit": SHA_B,
                "tree": SHA_D,
            },
            "testedMerge": {
                "commit": SHA_E,
                "tree": SHA_F,
                "parents": [SHA_A, SHA_B],
            },
        },
        producer_definitions=[
            {
                "workflowId": 99,
                "workflowPath": ".github/workflows/producer.yml",
                "workflowGitBlobSha": "0" * 40,
                "workflowSha256": HASH,
                "requiredContexts": ["required-context"],
            }
        ],
        histories=histories,
        required_check_snapshot_identity=required_snapshot,
        required_checks_sha256=HASH,
        producer_manifest_sha256=HASH,
    )


def mutated_subject(left: dict, mutate) -> dict:
    right = copy.deepcopy(left)
    right.pop("snapshotIdentity")
    mutate(right)
    right["snapshotIdentity"] = sha256_value(right)
    return right


class QualificationSubjectV3Tests(unittest.TestCase):
    def test_repository_identity_accepts_actions_compact_shape(self) -> None:
        self.assertTrue(repository_matches(
            {
                "id": 1349108143,
                "name": "hepta-paper",
                "url": "https://api.github.com/repos/TrillionniumFoundation/hepta-paper",
            },
            1349108143,
            "TrillionniumFoundation/hepta-paper",
        ))

    def test_base_commit_movement_changes_snapshot_identity(self) -> None:
        left = subject()
        right = mutated_subject(
            left,
            lambda value: value["pullRequest"]["base"].__setitem__("commit", "9" * 40),
        )
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_base_tree_movement_changes_snapshot_identity(self) -> None:
        left = subject()
        right = mutated_subject(
            left,
            lambda value: value["pullRequest"]["base"].__setitem__("tree", "8" * 40),
        )
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_base_ref_movement_changes_snapshot_identity(self) -> None:
        left = subject()
        right = mutated_subject(
            left,
            lambda value: value["pullRequest"]["base"].__setitem__("ref", "other"),
        )
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_merge_commit_movement_changes_snapshot_identity(self) -> None:
        left = subject()
        right = mutated_subject(
            left,
            lambda value: value["pullRequest"]["testedMerge"].__setitem__("commit", "7" * 40),
        )
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_merge_tree_movement_changes_snapshot_identity(self) -> None:
        left = subject()
        right = mutated_subject(
            left,
            lambda value: value["pullRequest"]["testedMerge"].__setitem__("tree", "6" * 40),
        )
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_merge_parent_movement_changes_snapshot_identity(self) -> None:
        left = subject()
        right = mutated_subject(
            left,
            lambda value: value["pullRequest"]["testedMerge"].__setitem__(
                "parents", ["5" * 40, SHA_B]
            ),
        )
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_canonical_run_must_succeed(self) -> None:
        failed = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
            conclusion="failure",
        )
        with self.assertRaisesRegex(ValueError, "canonical_producer_run_not_successful"):
            validate_history_freshness(
                ".github/workflows/producer.yml",
                ["required-context"],
                [failed],
            )

    def test_canonical_required_job_must_be_nonempty(self) -> None:
        row = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        row["jobs"][0]["steps"] = row["jobs"][0]["steps"][:1]
        with self.assertRaisesRegex(ValueError, "not_nonempty_success"):
            validate_history_freshness(
                ".github/workflows/producer.yml",
                ["required-context"],
                [row],
            )

    def test_older_run_rerun_success_after_newer_run_is_rejected(self) -> None:
        canonical = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        old_rerun = attempt(
            run_id=10,
            run_number=1,
            attempt_number=2,
            updated="2026-09-01T00:03:00Z",
        )
        with self.assertRaisesRegex(ValueError, "noncanonical_run_mutated_after_canonical"):
            validate_history_freshness(
                ".github/workflows/producer.yml",
                ["required-context"],
                [canonical, old_rerun],
            )

    def test_older_run_rerun_failure_after_newer_run_is_rejected(self) -> None:
        canonical = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        old_rerun = attempt(
            run_id=10,
            run_number=1,
            attempt_number=2,
            updated="2026-09-01T00:03:00Z",
            conclusion="failure",
        )
        with self.assertRaisesRegex(ValueError, "noncanonical_run_mutated_after_canonical"):
            validate_history_freshness(
                ".github/workflows/producer.yml",
                ["required-context"],
                [canonical, old_rerun],
            )

    def test_same_second_noncanonical_update_is_rejected_ambiguously(self) -> None:
        canonical = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        old = attempt(
            run_id=10,
            run_number=1,
            attempt_number=2,
            updated="2026-09-01T00:02:00Z",
        )
        with self.assertRaisesRegex(ValueError, "noncanonical_run_mutated_after_canonical"):
            validate_history_freshness(
                ".github/workflows/producer.yml",
                ["required-context"],
                [old, canonical],
            )

    def test_precanonical_history_is_accepted_and_bound(self) -> None:
        old = attempt(
            run_id=10,
            run_number=1,
            attempt_number=1,
            updated="2026-09-01T00:01:00Z",
        )
        canonical = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        selected = validate_history_freshness(
            ".github/workflows/producer.yml",
            ["required-context"],
            [old, canonical],
        )
        self.assertEqual(selected["runId"], 20)

    def test_attempt_artifact_mutation_changes_complete_history_identity(self) -> None:
        old = attempt(
            run_id=10,
            run_number=1,
            attempt_number=1,
            updated="2026-09-01T00:01:00Z",
        )
        canonical = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        left_history = history([old, canonical])
        left = subject([left_history])
        mutated = copy.deepcopy(left_history)
        mutated["eligibleRuns"][0]["artifacts"][0]["expired"] = True
        mutated["eligibleRuns"][0]["artifactSetSha256"] = sha256_value(
            mutated["eligibleRuns"][0]["artifacts"]
        )
        mutated["historyHash"] = sha256_value(mutated["eligibleRuns"])
        right = subject([mutated])
        self.assertNotEqual(left["eligibleRunSetSha256"], right["eligibleRunSetSha256"])
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_required_check_snapshot_mutation_changes_identity(self) -> None:
        left = subject(required_snapshot=HASH)
        right = subject(required_snapshot="sha256:" + "2" * 64)
        self.assertNotEqual(left["snapshotIdentity"], right["snapshotIdentity"])

    def test_history_hash_mismatch_is_rejected(self) -> None:
        row = attempt(
            run_id=20,
            run_number=2,
            attempt_number=1,
            updated="2026-09-01T00:02:00Z",
        )
        hostile = history([row])
        hostile["historyHash"] = "sha256:" + "3" * 64
        with self.assertRaisesRegex(ValueError, "producer_history_hash_invalid"):
            subject([hostile])

    def test_v2_wrapper_binds_exact_base_head_and_merge(self) -> None:
        exact = subject()
        legacy = {
            "schemaVersion": 1,
            "status": "source_qualified",
            "source": {"commit": SHA_B, "tree": SHA_D},
            "authority": {
                "productionAuthorized": False,
                "externalAuthorityClaimed": False,
            },
        }
        result = derive(legacy, exact)
        self.assertEqual(result["source"]["baseCommit"], SHA_A)
        self.assertEqual(result["source"]["commit"], SHA_B)
        self.assertEqual(result["source"]["mergeCommit"], SHA_E)
        self.assertTrue(all(value is False for value in result["authority"].values()))

    def test_v2_wrapper_rejects_head_mismatch(self) -> None:
        exact = subject()
        legacy = {
            "source": {"commit": "9" * 40, "tree": SHA_D},
            "productionAuthorized": False,
        }
        with self.assertRaisesRegex(ValueError, "legacy_effective_source_mismatch"):
            derive(legacy, exact)

    def test_v2_wrapper_rejects_authority_escalation(self) -> None:
        exact = subject()
        legacy = {
            "source": {"commit": SHA_B, "tree": SHA_D},
            "production_activation": True,
        }
        with self.assertRaisesRegex(ValueError, "authority_escalation"):
            derive(legacy, exact)


if __name__ == "__main__":
    unittest.main(verbosity=2)
