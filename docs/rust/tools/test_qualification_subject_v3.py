#!/usr/bin/env python3
"""Hostile tests for Qualification Subject V3 identity and history semantics."""

from __future__ import annotations

import copy
import unittest
import json
import subprocess
import sys
import importlib.util
from pathlib import Path
import tempfile
from unittest import mock

from qualification_subject_integrity import validate_subject, read_json, LEGACY_SCHEMA, validate_record
from verify_effective_status_v2_current import verify

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


def legacy_for_subject(exact: dict) -> dict:
    """Structurally complete local test evidence, never a GitHub attestation."""
    checks = []
    for h in exact["producerHistories"]:
        row = next(r for r in h["eligibleRuns"] if
                   (r["runId"], r["runAttempt"]) == (h["canonicalRunId"], h["canonicalRunAttempt"]))
        for context in h["requiredContexts"]:
            j = next(j for j in row["jobs"] if j["name"] == context)
            checks.append({
                **{k: row[k] for k in ("workflowId", "workflowPath", "runId", "runAttempt",
                    "runNumber", "checkSuiteId", "event", "headSha", "headBranch", "baseRef")},
                "workflowGitBlobSha": "0" * 40, "workflowSha256": HASH,
                "context": context, "jobId": j["id"], "jobName": j["name"],
                "pullRequestNumber": exact["pullRequest"]["number"],
                **{k: j[k] for k in ("status", "conclusion", "startedAt", "completedAt", "steps")},
                "detailsUrl": f"https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/{row['runId']}/job/{j['id']}",
            })
    schema = json.loads(LEGACY_SCHEMA.read_text())
    value = {
        "schemaVersion": 1, "kind": "HeptaRustEffectiveSourceStatusV1",
        "status": "exact_head_source_qualified", "repository": "TrillionniumFoundation/hepta-paper",
        "source": {"commit": exact["pullRequest"]["head"]["commit"],
                   "tree": exact["pullRequest"]["head"]["tree"],
                   **{k: HASH for k in ("staticTruthSha256", "requiredChecksSha256", "producerManifestSha256",
                       "capabilityEvidenceSha256", "checkEvidenceSha256", "effectiveSchemaSha256")},
                   "boundFiles": {"fixture-only.json": HASH}},
        "pullRequest": {"number": exact["pullRequest"]["number"],
                        "baseRef": exact["pullRequest"]["base"]["ref"],
                        "headBranch": exact["pullRequest"]["head"]["ref"]},
        "workflow": {"name": "local-fixture-only", "runId": 1, "runAttempt": 1},
        "requiredContexts": sorted(c["context"] for c in checks), "observedChecks": checks,
        "effective": {
            "currentStatusRows": {"fixture": "source_implemented"},
            "backlogItemStatus": {"fixture": "source_implemented"},
            "parityItemStatus": {"fixture": "source_implemented"},
            "workstreams": [{"id": "fixture", "name": "local-only", "status": "source_implemented", "evidenceTier": "source"}],
            "gaps": [{"id": "external", "title": "Not independently accepted", "status": "blocked_external",
                      "evidenceTier": "external_authority", "external": True, "closesWhen": ["independent acceptance"]}],
            "supplementalBlockers": []},
        "validity": {"mode": "live_revalidation_required", "snapshotIdentity": exact["requiredCheckSnapshotIdentity"],
                     "consumerMustRevalidateBeforeMergeOrActivation": True,
                     "revalidatorPath": "docs/rust/tools/verify-effective-status-current.py"},
        "invalidation": {k: v["const"] for k, v in schema["properties"]["invalidation"]["properties"].items()},
        "authority": {k: v["const"] for k, v in schema["properties"]["authority"]["properties"].items()},
    }
    validate_record(value, LEGACY_SCHEMA)
    return value


def reseal(exact: dict) -> dict:
    """Rehash hostile contents to prove that self-hashes cannot hide bad semantics."""
    for h in exact["producerHistories"]:
        for row in h["eligibleRuns"]:
            row["jobSetSha256"] = sha256_value(row["jobs"])
            row["stepSetSha256"] = sha256_value([{"jobId": j["id"], **step} for j in row["jobs"] for step in j["steps"]])
            row["artifactSetSha256"] = sha256_value(row["artifacts"])
        h["historyHash"] = sha256_value(h["eligibleRuns"])
    exact["eligibleRunSetSha256"] = sha256_value(exact["producerHistories"])
    exact["selectedRunSetSha256"] = sha256_value([
        {"workflowId": h["workflowId"], "workflowPath": h["workflowPath"], "runId": h["canonicalRunId"],
         "runAttempt": h["canonicalRunAttempt"], "updatedAt": h["canonicalUpdatedAt"],
         "requiredContexts": h["requiredContexts"]} for h in exact["producerHistories"]])
    exact["artifactSetHash"] = sha256_value([
        {"workflowId": h["workflowId"], "runId": r["runId"], "runAttempt": r["runAttempt"],
         "artifacts": r["artifacts"]} for h in exact["producerHistories"] for r in h["eligibleRuns"]])
    exact.pop("snapshotIdentity", None)
    exact["snapshotIdentity"] = sha256_value(exact)
    return exact


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
        legacy = legacy_for_subject(exact)
        result = derive(legacy, exact)
        self.assertEqual(result["source"]["baseCommit"], SHA_A)
        self.assertEqual(result["source"]["commit"], SHA_B)
        self.assertEqual(result["source"]["mergeCommit"], SHA_E)
        self.assertTrue(all(value is False for value in result["authority"].values()))

    def test_v2_wrapper_rejects_head_mismatch(self) -> None:
        exact = subject()
        legacy = legacy_for_subject(exact)
        legacy["source"]["commit"] = "9" * 40
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


class QualificationIntegrityBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.subject = subject()
        self.legacy = legacy_for_subject(self.subject)

    def test_complete_pair_passes_without_mutating_inputs(self):
        original = copy.deepcopy((self.legacy, self.subject))
        result = derive(self.legacy, self.subject)
        self.assertEqual(result["status"], "source_qualified_nonactivating")
        self.assertEqual((self.legacy, self.subject), original)
        self.assertTrue(all(v is False for v in result["authority"].values()))

    def test_incomplete_failed_or_nested_legacy_cannot_be_promoted(self):
        for legacy in [{"source": {"commit": SHA_B, "tree": SHA_D}, "status": "FAILED"},
                       {"payload": self.legacy}, {**self.legacy, "status": "failed"},
                       {**self.legacy, "schemaVersion": True}, {**self.legacy, "extra": False}]:
            with self.subTest(legacy_keys=list(legacy)), self.assertRaises(ValueError):
                derive(legacy, self.subject)

    def test_schema_shape_and_authority_are_closed_even_after_rehash(self):
        for mutate in [lambda s: s.update(extra=True), lambda s: s.update(producerHistories=[]),
                       lambda s: s.update(authority={"unrecognized": False}),
                       lambda s: s["authority"].update(productionAuthorized=0),
                       lambda s: s["repository"].update(id=True)]:
            value = copy.deepcopy(self.subject); mutate(value)
            with self.assertRaises(ValueError):
                derive(self.legacy, reseal(value))

    def test_all_history_hash_layers_are_verified_not_only_outer_hash(self):
        for key in ("definitionSetHash", "eligibleRunSetSha256", "selectedRunSetSha256", "artifactSetHash"):
            value = mutated_subject(self.subject, lambda s: s.__setitem__(key, "sha256:" + "9" * 64))
            with self.subTest(key=key), self.assertRaises(ValueError):
                derive(self.legacy, value)
        for key in ("jobSetSha256", "stepSetSha256", "artifactSetSha256"):
            value = copy.deepcopy(self.subject)
            value["producerHistories"][0]["eligibleRuns"][0][key] = "sha256:" + "9" * 64
            value = mutated_subject(value, lambda _: None)
            with self.subTest(key=key), self.assertRaises(ValueError):
                derive(self.legacy, value)

    def test_failed_queued_and_empty_canonical_execution_cannot_be_promoted(self):
        mutations = [lambda r: r.update(conclusion="failure"), lambda r: r.update(status="queued"),
                     lambda r: r["jobs"][0].update(conclusion="failure"),
                     lambda r: r["jobs"][0].update(steps=r["jobs"][0]["steps"][:1]),
                     lambda r: r["jobs"][0]["steps"][1].update(conclusion="failure"),
                     lambda r: r["jobs"][0]["steps"][1].update(status="in_progress")]
        for mutate in mutations:
            value = copy.deepcopy(self.subject); mutate(value["producerHistories"][0]["eligibleRuns"][0])
            with self.assertRaises(ValueError):
                derive(self.legacy, reseal(value))

    def test_run_repository_base_and_head_must_be_exact(self):
        for field, changed in [("headSha", SHA_A), ("headBranch", "other"), ("baseCommit", SHA_B),
                               ("baseRef", "other"), ("workflowId", 100), ("workflowPath", ".github/workflows/other.yml")]:
            value = copy.deepcopy(self.subject); value["producerHistories"][0]["eligibleRuns"][0][field] = changed
            with self.subTest(field=field), self.assertRaises(ValueError):
                derive(self.legacy, reseal(value))
        value = copy.deepcopy(self.subject); value["pullRequest"]["base"]["repositoryId"] += 1
        with self.assertRaisesRegex(ValueError, 'repository_mismatch'):
            derive(self.legacy, reseal(value))

    def test_duplicate_workflows_runs_jobs_steps_and_artifacts_are_rejected(self):
        mutations = [lambda s: s["producerHistories"].append(copy.deepcopy(s["producerHistories"][0])),
                     lambda s: s["producerHistories"][0]["eligibleRuns"].append(copy.deepcopy(s["producerHistories"][0]["eligibleRuns"][0])),
                     lambda s: s["producerHistories"][0]["eligibleRuns"][0]["jobs"].append(copy.deepcopy(s["producerHistories"][0]["eligibleRuns"][0]["jobs"][0])),
                     lambda s: s["producerHistories"][0]["eligibleRuns"][0]["jobs"][0]["steps"].append(copy.deepcopy(s["producerHistories"][0]["eligibleRuns"][0]["jobs"][0]["steps"][0])),
                     lambda s: s["producerHistories"][0]["eligibleRuns"][0]["artifacts"].append(copy.deepcopy(s["producerHistories"][0]["eligibleRuns"][0]["artifacts"][0]))]
        for mutate in mutations:
            value = copy.deepcopy(self.subject); mutate(value)
            with self.assertRaises(ValueError):
                derive(self.legacy, reseal(value))

    def test_missing_attempt_cannot_be_hidden_by_recomputed_hashes(self):
        value = copy.deepcopy(self.subject)
        h = value["producerHistories"][0]; h["eligibleRuns"][0]["runAttempt"] = 2; h["canonicalRunAttempt"] = 2
        with self.assertRaisesRegex(ValueError, 'attempt_history_gap'):
            derive(self.legacy, reseal(value))

    def test_forged_canonical_selection_and_watermark_are_rejected(self):
        for mutate in [lambda s: s["producerHistories"][0].update(canonicalRunId=77),
                       lambda s: s["producerHistories"][0].update(canonicalUpdatedAt="2026-09-01T00:03:00Z"),
                       lambda s: s.update(producerHistoryWatermark="2026-09-01T00:03:00Z")]:
            value = copy.deepcopy(self.subject); mutate(value)
            with self.assertRaises(ValueError):
                derive(self.legacy, reseal(value))

    def test_legacy_policy_check_snapshot_contexts_and_jobs_cannot_be_spliced(self):
        mutations = [lambda l: l["pullRequest"].update(number=41),
                     lambda l: l["validity"].update(snapshotIdentity="sha256:" + "9" * 64),
                     lambda l: l.update(requiredContexts=["different"]),
                     lambda l: l["observedChecks"][0].update(runId=21),
                     lambda l: l["observedChecks"][0].update(jobId=999),
                     lambda l: l["observedChecks"][0].update(workflowSha256="sha256:" + "9" * 64),
                     lambda l: l["source"].update(producerManifestSha256="sha256:" + "9" * 64),
                     lambda l: l["observedChecks"][0].update(detailsUrl="https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/20/job/999")]
        for mutate in mutations:
            legacy = copy.deepcopy(self.legacy); mutate(legacy)
            with self.assertRaises(ValueError): derive(legacy, self.subject)

    def test_same_second_and_late_noncanonical_reruns_still_block(self):
        for stamp in ["2026-09-01T00:02:00Z", "2026-09-01T00:03:00Z"]:
            value = copy.deepcopy(self.subject)
            old = attempt(run_id=10, run_number=1, attempt_number=1, updated=stamp)
            value["producerHistories"][0]["eligibleRuns"].insert(0, old)
            with self.assertRaisesRegex(ValueError, 'noncanonical_run_mutated'):
                derive(self.legacy, reseal(value))

    def test_strict_timestamp_minutes_apply_to_history_not_just_schema(self):
        from qualification_subject_v3 import parse_timestamp
        for invalid in ["2026-09-01T00:00:00+00:60", "2026-09-01T00:00:00", "2026-02-30T00:00:00Z"]:
            with self.assertRaises(ValueError): parse_timestamp(invalid)

    def test_input_bytes_reject_duplicates_nonfinite_and_oversize(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'input.json'
            for raw in ['{"a":1,"a":2}', '{"nested":{"a":1,"a":2}}', 'NaN', '1e999']:
                file.write_text(raw)
                with self.assertRaises(ValueError): read_json(file)
            file.write_text(' ' * 100)
            with mock.patch('qualification_subject_integrity.MAX_DOCUMENT_BYTES', 10):
                with self.assertRaisesRegex(ValueError, 'byte_limit'): read_json(file)

    def test_verifier_revalidates_embedded_history_before_child_verifier(self):
        artifact = derive(self.legacy, self.subject)
        for mutate in [lambda a: a["qualificationSubject"]["producerHistories"][0]["eligibleRuns"][0].update(conclusion='failure'),
                       lambda a: a.update(legacyEffectiveStatus={"source": {"commit": SHA_B, "tree": SHA_D}})]:
            value = copy.deepcopy(artifact); mutate(value)
            reseal(value['qualificationSubject'])
            value['qualificationSubjectSha256'] = sha256_value(value['qualificationSubject'])
            value['legacyEffectiveStatusSha256'] = sha256_value(value['legacyEffectiveStatus'])
            with mock.patch('verify_effective_status_v2_current.subprocess.run') as child:
                with self.assertRaises(ValueError): verify(value, value['qualificationSubject'], Path('checks'), Path(__file__))
                child.assert_not_called()

    def test_verifier_cannot_skip_existing_live_v1_verification(self):
        artifact = derive(self.legacy, self.subject)
        with mock.patch('verify_effective_status_v2_current.subprocess.run',
                        return_value=mock.Mock(returncode=1, stderr='fixture denial', stdout='')) as child:
            with self.assertRaisesRegex(ValueError, 'legacy_effective_status_not_current'):
                verify(artifact, self.subject, Path('checks'), Path(__file__))
            child.assert_called_once()
        with mock.patch('verify_effective_status_v2_current.subprocess.run',
                        return_value=mock.Mock(returncode=0)) as child:
            result = verify(artifact, self.subject, Path('checks'), Path(__file__))
            self.assertEqual(result['status'], 'effective_source_status_v2_current')
            child.assert_called_once() # local port control, not actual live qualification


class QualificationCliIntegrationTests(unittest.TestCase):
    def test_actual_cli_accepts_complete_local_fixture_and_rejects_incomplete_input(self):
        exact = subject(); legacy = legacy_for_subject(exact)
        tool = Path(__file__).with_name('derive_effective_status_v2.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); a, b, out = [root / n for n in ('legacy.json', 'subject.json', 'out.json')]
            a.write_text(json.dumps(legacy)); b.write_text(json.dumps(exact))
            command = [sys.executable, str(tool), '--legacy-effective', str(a),
                       '--qualification-subject', str(b), '--output', str(out)]
            result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(out.read_text()), derive(legacy, exact))
            out.unlink()
            for raw in [json.dumps({'source': legacy['source'], 'status': 'FAILED'}),
                        json.dumps(legacy)[:-1] + ',"status":"exact_head_source_qualified"}', 'NaN']:
                a.write_text(raw)
                result = subprocess.run(command, capture_output=True, text=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(out.exists())

    def test_real_v1_deriver_output_binds_to_v3_without_mocking_validators(self):
        tools = Path(__file__).parent
        specification = importlib.util.spec_from_file_location('local_plan_v4_fixture', tools / 'test-plan-v4-qualification.py')
        fixture_module = importlib.util.module_from_spec(specification); specification.loader.exec_module(fixture_module)
        fixture = fixture_module.Fixture()
        snapshot = fixture.snapshot()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); checks, output = root / 'checks.json', root / 'v1.json'
            checks.write_text(json.dumps(snapshot, sort_keys=True, indent=2) + '\n')
            result = subprocess.run([sys.executable, str(tools / 'derive-effective-status.py'),
                '--check-runs', str(checks), '--repository', 'TrillionniumFoundation/hepta-paper',
                '--commit', fixture_module.COMMIT, '--tree', fixture_module.TREE,
                '--workflow', 'local-fixture-only', '--run-id', '1', '--run-attempt', '1',
                '--output', str(output), '--skip-checkout-verification'],
                capture_output=True, text=True, timeout=30, cwd=tools.resolve().parents[2])
            self.assertEqual(result.returncode, 0, result.stderr)
            legacy = json.loads(output.read_text())
            from qualification_subject_v3 import normalize_jobs
            histories, definitions = [], []
            for run in sorted(fixture.workflow_runs, key=lambda r: r['workflow_id']):
                bound = [c for c in legacy['observedChecks'] if c['workflowId'] == run['workflow_id']]
                contexts = sorted(c['context'] for c in bound)
                row = attempt(run_id=run['id'], run_number=run['run_number'], attempt_number=1,
                              updated='2026-08-31T00:02:00Z')
                row.update(workflowId=run['workflow_id'], workflowPath=run['path'],
                    headSha=fixture_module.COMMIT, headBranch=fixture_module.HEAD_BRANCH,
                    baseRef=fixture_module.BASE_REF, baseCommit=SHA_A, createdAt='2026-08-31T00:00:00Z',
                    checkSuiteId=bound[0]['checkSuiteId'], artifacts=[],
                    jobs=normalize_jobs(fixture.jobs_by_attempt[(run['id'], 1)]))
                row['jobSetSha256'] = sha256_value(row['jobs'])
                row['stepSetSha256'] = sha256_value([{'jobId': j['id'], **step} for j in row['jobs'] for step in j['steps']])
                row['artifactSetSha256'] = sha256_value(row['artifacts'])
                h = history([row]); h.update(workflowId=run['workflow_id'], workflowPath=run['path'], requiredContexts=contexts)
                histories.append(h)
                definitions.append({**{k: bound[0][k] for k in ('workflowId', 'workflowPath', 'workflowGitBlobSha', 'workflowSha256')},
                                    'requiredContexts': contexts})
            pr = copy.deepcopy(subject()['pullRequest'])
            pr['number'] = fixture_module.PR; pr['base']['ref'] = fixture_module.BASE_REF
            pr['head'].update(ref=fixture_module.HEAD_BRANCH, commit=fixture_module.COMMIT, tree=fixture_module.TREE)
            pr['testedMerge']['parents'] = [pr['base']['commit'], pr['head']['commit']]
            exact = assemble_subject(repository=subject()['repository'], pull_request=pr,
                producer_definitions=definitions, histories=histories,
                required_check_snapshot_identity=legacy['validity']['snapshotIdentity'],
                required_checks_sha256=legacy['source']['requiredChecksSha256'],
                producer_manifest_sha256=legacy['source']['producerManifestSha256'])
            derived = derive(legacy, exact)
            self.assertEqual(derived['status'], 'source_qualified_nonactivating')
            self.assertEqual(len(legacy['observedChecks']), 20)
            self.assertIn('docs/rust/tools/qualification_subject_integrity.py', legacy['source']['boundFiles'])
            self.assertTrue(all(value is False for value in derived['authority'].values()))

    def test_complete_failed_earlier_attempt_and_later_success_are_accepted(self):
        old = attempt(run_id=20, run_number=2, attempt_number=1,
                      updated='2026-09-01T00:01:00Z', conclusion='failure')
        latest = attempt(run_id=20, run_number=2, attempt_number=2,
                         updated='2026-09-01T00:02:00Z')
        h = history([old, latest]); h.update(canonicalRunAttempt=2, canonicalUpdatedAt=latest['updatedAt'])
        exact = subject([h])
        self.assertEqual(derive(legacy_for_subject(exact), exact)['status'], 'source_qualified_nonactivating')



if __name__ == "__main__":
    unittest.main(verbosity=2)
