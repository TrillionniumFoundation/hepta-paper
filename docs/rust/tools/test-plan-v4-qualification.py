#!/usr/bin/env python3
"""Adversarial deterministic tests for Plan v4.1 source qualification."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "docs/rust/tools"
sys.path.insert(0, str(TOOLS))
DERIVE = TOOLS / "derive-effective-status.py"
VERIFY = TOOLS / "verify-effective-status-current.py"
VALIDATE = TOOLS / "validate-program-truth.py"
REQUIRED = ROOT / "docs/rust/qualification/source-required-checks.v1.json"
PRODUCERS = ROOT / "docs/rust/qualification/source-check-producers.v1.json"
CAPABILITIES = ROOT / "docs/rust/qualification/source-capability-evidence.v1.json"
STATIC = ROOT / "docs/rust/current-status.v1.json"
EFFECTIVE_SCHEMA = ROOT / "docs/rust/qualification/effective-status-v1.schema.json"
COMMIT = "a" * 40
TREE = "b" * 40
PR = 42
HEAD_BRANCH = "codex/rust-plan-v4-rc1-20260831"
BASE_REF = "codex/rust-plan-v3-final-product-20260830"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


COLLECT = load_module("hepta_collect_required_checks", TOOLS / "collect-required-checks.py")
SCHEMA = load_module("hepta_strict_json_schema", TOOLS / "strict_json_schema.py")


def recompute_snapshot_identity(evidence: dict[str, object]) -> None:
    subject = {
        "repository": evidence["repository"],
        "commit": evidence["source"]["commit"],
        "tree": evidence["source"]["tree"],
        "pullRequestNumber": evidence["pullRequest"]["number"],
        "baseRef": evidence["pullRequest"]["baseRef"],
        "headBranch": evidence["pullRequest"]["headBranch"],
        "producerManifestSha256": evidence["source"]["producerManifestSha256"],
        "requiredChecksSha256": evidence["source"]["requiredChecksSha256"],
        "observedChecks": evidence["observedChecks"],
    }
    encoded = json.dumps(subject, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    evidence["snapshotIdentity"] = "sha256:" + hashlib.sha256(encoded).hexdigest()


class Fixture:
    def __init__(self) -> None:
        self.required, self.producers, self.contexts, self.by_context = COLLECT.load_policy(
            REQUIRED, PRODUCERS, "TrillionniumFoundation/hepta-paper"
        )
        by_workflow: dict[int, list[str]] = {}
        for context in self.contexts:
            by_workflow.setdefault(self.by_context[context]["workflowId"], []).append(context)
        self.workflow_runs: list[dict[str, object]] = []
        self.jobs_by_attempt: dict[tuple[int, int], list[dict[str, object]]] = {}
        self.check_runs: list[dict[str, object]] = []
        for index, (workflow_id, contexts) in enumerate(sorted(by_workflow.items()), start=1):
            spec = self.by_context[contexts[0]]
            run_id = 10_000 + index
            run = {
                "id": run_id,
                "workflow_id": workflow_id,
                "path": spec["workflowPath"],
                "event": "pull_request",
                "head_sha": COMMIT,
                "head_branch": HEAD_BRANCH,
                "status": "completed",
                "conclusion": "success",
                "run_attempt": 1,
                "run_number": index,
                "pull_requests": [{
                    "number": PR,
                    "base": {"ref": BASE_REF},
                    "head": {"sha": COMMIT},
                }],
            }
            self.workflow_runs.append(run)
            jobs: list[dict[str, object]] = []
            for position, context in enumerate(contexts, start=1):
                job_id = run_id * 100 + position
                job = {
                    "id": job_id,
                    "run_id": run_id,
                    "head_sha": COMMIT,
                    "name": context,
                    "status": "completed",
                    "conclusion": "success",
                    "started_at": "2026-08-31T00:00:00Z",
                    "completed_at": "2026-08-31T00:01:00Z",
                    "steps": [
                        {"number": 1, "name": "Set up job", "status": "completed", "conclusion": "success"},
                        {"number": 2, "name": "Run bound verification", "status": "completed", "conclusion": "success"},
                        {"number": 3, "name": "Complete job", "status": "completed", "conclusion": "success"},
                    ],
                }
                jobs.append(job)
                self.check_runs.append({
                    "id": job_id,
                    "name": context,
                    "head_sha": COMMIT,
                    "status": "completed",
                    "conclusion": "success",
                    "started_at": "2026-08-31T00:00:00Z",
                    "completed_at": "2026-08-31T00:01:00Z",
                    "details_url": f"https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/{run_id}/job/{job_id}",
                    "app": {"id": 15368},
                    "check_suite": {"id": run_id + 50_000},
                })
            self.jobs_by_attempt[(run_id, 1)] = jobs

    def snapshot(self) -> dict[str, object]:
        return COLLECT.select_snapshot(
            required=self.required,
            producers=self.producers,
            contexts=self.contexts,
            by_context=self.by_context,
            workflow_runs=self.workflow_runs,
            jobs_by_attempt=self.jobs_by_attempt,
            check_runs=self.check_runs,
            repository="TrillionniumFoundation/hepta-paper",
            commit=COMMIT,
            tree=TREE,
            head_branch=HEAD_BRANCH,
            base_ref=BASE_REF,
            pull_request=PR,
            required_path=REQUIRED,
            producer_path=PRODUCERS,
        )


class PlanV4QualificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Fixture()
        self.complete = self.fixture.snapshot()

    def run_derive(
        self,
        payload: dict[str, object],
        expect_success: bool,
        *,
        static_path: Path = STATIC,
        capability_path: Path = CAPABILITIES,
    ) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
        temporary = tempfile.TemporaryDirectory(prefix="hepta-plan-v4-test-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        evidence = root / "check-evidence.v2.json"
        output = root / "effective-status.v1.json"
        evidence.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(DERIVE),
                "--static-truth", str(static_path),
                "--capability-evidence", str(capability_path),
                "--check-runs", str(evidence),
                "--repository", "TrillionniumFoundation/hepta-paper",
                "--commit", COMMIT,
                "--tree", TREE,
                "--workflow", "qualification-selftest",
                "--run-id", "1",
                "--run-attempt", "1",
                "--output", str(output),
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
        return result, output, evidence

    def test_static_program_truth_validates(self) -> None:
        result = subprocess.run([sys.executable, str(VALIDATE)], cwd=ROOT, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("rust_plan_v4_program_truth_valid", result.stdout)

    def test_complete_authenticated_matrix_derives_nonactivating_status(self) -> None:
        _, output, _ = self.run_derive(copy.deepcopy(self.complete), True)
        value = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(value["status"], "exact_head_source_qualified")
        self.assertEqual(len(value["observedChecks"]), 20)
        self.assertEqual(value["validity"]["mode"], "live_revalidation_required")
        self.assertFalse(value["authority"]["productionAuthorized"])
        self.assertEqual(value["effective"]["parityItemStatus"]["PAR-DET-010"], "source_qualified")
        self.assertEqual(value["effective"]["parityItemStatus"]["PAR-DET-011"], "source_qualified")

    def test_zero_workflow_run_collection_fails_closed(self) -> None:
        self.fixture.workflow_runs.clear()
        with self.assertRaises(RuntimeError):
            self.fixture.snapshot()

    def test_wrong_workflow_path_cannot_supply_context(self) -> None:
        self.fixture.workflow_runs[0]["path"] = ".github/workflows/attacker.yml"
        with self.assertRaises(RuntimeError):
            self.fixture.snapshot()

    def test_attempt_jobs_permission_denied_uses_revalidated_latest_endpoint(self) -> None:
        run = copy.deepcopy(self.fixture.workflow_runs[0])
        run_id, attempt = COLLECT.run_key(run)
        jobs = copy.deepcopy(self.fixture.jobs_by_attempt[(run_id, attempt)])

        def fake_fetch_pages(url: str, list_key: str, token: str):
            self.assertEqual(list_key, "jobs")
            self.assertEqual(token, "token")
            if "/attempts/" in url:
                raise COLLECT.GitHubApiError(403, url)
            self.assertIn("/jobs?filter=latest", url)
            return jobs, [{"jobs": jobs}]

        with (
            mock.patch.object(COLLECT, "fetch_pages", side_effect=fake_fetch_pages),
            mock.patch.object(COLLECT, "fetch_json", return_value=copy.deepcopy(run)),
        ):
            observed, access = COLLECT.fetch_jobs_for_attempt(
                api="https://api.github.test",
                repository="TrillionniumFoundation/hepta-paper",
                run=run,
                token="token",
            )

        self.assertEqual(observed, jobs)
        self.assertEqual(
            access["accessMode"],
            "latest_endpoint_after_attempt_permission_denied",
        )
        self.assertEqual(access["attemptEndpointStatus"], 403)
        self.assertEqual(access["runId"], run_id)
        self.assertEqual(access["runAttempt"], attempt)

    def test_missing_jobs_read_permission_is_explicitly_classified(self) -> None:
        run = copy.deepcopy(self.fixture.workflow_runs[0])

        def denied(url: str, list_key: str, token: str):
            del list_key, token
            raise COLLECT.GitHubApiError(403, url)

        with mock.patch.object(COLLECT, "fetch_pages", side_effect=denied):
            with self.assertRaisesRegex(
                ValueError,
                "github_api_permission_denied:actions_jobs_read",
            ):
                COLLECT.fetch_jobs_for_attempt(
                    api="https://api.github.test",
                    repository="TrillionniumFoundation/hepta-paper",
                    run=run,
                    token="token",
                )

    def test_latest_jobs_fallback_rejects_attempt_change(self) -> None:
        run = copy.deepcopy(self.fixture.workflow_runs[0])
        run_id, attempt = COLLECT.run_key(run)
        jobs = copy.deepcopy(self.fixture.jobs_by_attempt[(run_id, attempt)])
        changed = copy.deepcopy(run)
        changed["run_attempt"] = attempt + 1

        def fake_fetch_pages(url: str, list_key: str, token: str):
            del list_key, token
            if "/attempts/" in url:
                raise COLLECT.GitHubApiError(403, url)
            return jobs, [{"jobs": jobs}]

        with (
            mock.patch.object(COLLECT, "fetch_pages", side_effect=fake_fetch_pages),
            mock.patch.object(COLLECT, "fetch_json", return_value=changed),
        ):
            with self.assertRaisesRegex(
                ValueError,
                "workflow_run_mutated_during_jobs_fallback",
            ):
                COLLECT.fetch_jobs_for_attempt(
                    api="https://api.github.test",
                    repository="TrillionniumFoundation/hepta-paper",
                    run=run,
                    token="token",
                )

    def test_colliding_context_from_other_workflow_is_rejected(self) -> None:
        collision = copy.deepcopy(self.fixture.check_runs[0])
        collision["id"] = 999_999_999
        collision["details_url"] = "https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/999999/job/999999999"
        self.fixture.check_runs.append(collision)
        with self.assertRaisesRegex(ValueError, "producer_collision"):
            self.fixture.snapshot()

    def test_zero_step_job_is_rejected(self) -> None:
        first_key = next(iter(self.fixture.jobs_by_attempt))
        self.fixture.jobs_by_attempt[first_key][0]["steps"] = []
        with self.assertRaisesRegex(ValueError, "no_steps"):
            self.fixture.snapshot()

    def test_failed_job_step_is_rejected(self) -> None:
        first_key = next(iter(self.fixture.jobs_by_attempt))
        self.fixture.jobs_by_attempt[first_key][0]["steps"][1]["conclusion"] = "failure"
        with self.assertRaisesRegex(ValueError, "step_failed"):
            self.fixture.snapshot()

    def test_latest_failed_rerun_invalidates_older_success(self) -> None:
        old = self.fixture.workflow_runs[0]
        newer = copy.deepcopy(old)
        newer["id"] = old["id"] + 1_000_000
        newer["run_attempt"] = 2
        newer["conclusion"] = "failure"
        self.fixture.workflow_runs.append(newer)
        with self.assertRaisesRegex(ValueError, "latest_producer_workflow_failed"):
            self.fixture.snapshot()

    def test_wrong_pull_request_binding_is_rejected(self) -> None:
        for run in self.fixture.workflow_runs:
            run["pull_requests"][0]["number"] = 7
        with self.assertRaises(RuntimeError):
            self.fixture.snapshot()

    def test_missing_required_context_cannot_derive(self) -> None:
        payload = copy.deepcopy(self.complete)
        payload["observedChecks"].pop()
        recompute_snapshot_identity(payload)
        self.run_derive(payload, False)

    def test_capability_binding_cannot_be_omitted(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="hepta-capability-map-")
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "capability.json"
        value = json.loads(CAPABILITIES.read_text(encoding="utf-8"))
        del value["bindings"]["parityItemStatus"]["PAR-DET-010"]
        path.write_text(json.dumps(value), encoding="utf-8")
        self.run_derive(copy.deepcopy(self.complete), False, capability_path=path)

    def test_promotable_parity_requires_nonempty_dependencies(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="hepta-static-truth-")
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "truth.json"
        value = json.loads(STATIC.read_text(encoding="utf-8"))
        value["parityDependencies"]["PAR-DET-010"] = []
        path.write_text(json.dumps(value), encoding="utf-8")
        self.run_derive(copy.deepcopy(self.complete), False, static_path=path)

    def test_complete_schema_rejects_unexpected_artifact_field(self) -> None:
        _, output, _ = self.run_derive(copy.deepcopy(self.complete), True)
        value = json.loads(output.read_text(encoding="utf-8"))
        value["unexpected"] = True
        schema = json.loads(EFFECTIVE_SCHEMA.read_text(encoding="utf-8"))
        with self.assertRaises(SCHEMA.SchemaValidationError):
            SCHEMA.validate(value, schema)

    def test_new_successful_run_invalidates_prior_artifact_until_regenerated(self) -> None:
        _, output, _ = self.run_derive(copy.deepcopy(self.complete), True)
        workflow = self.fixture.workflow_runs[0]
        old_key = (workflow["id"], workflow["run_attempt"])
        newer = copy.deepcopy(workflow)
        newer["id"] += 2_000_000
        newer["run_attempt"] = 2
        newer["run_number"] += 100
        self.fixture.workflow_runs.append(newer)
        new_jobs = copy.deepcopy(self.fixture.jobs_by_attempt[old_key])
        old_to_new: dict[int, int] = {}
        for position, job in enumerate(new_jobs, start=1):
            old_id = job["id"]
            job["id"] = newer["id"] * 100 + position
            job["run_id"] = newer["id"]
            old_to_new[old_id] = job["id"]
        self.fixture.jobs_by_attempt[(newer["id"], 2)] = new_jobs
        for check in list(self.fixture.check_runs):
            if check["id"] not in old_to_new:
                continue
            newer_check = copy.deepcopy(check)
            newer_check["id"] = old_to_new[check["id"]]
            newer_check["details_url"] = f"https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/{newer['id']}/job/{newer_check['id']}"
            newer_check["check_suite"]["id"] += 2_000_000
            self.fixture.check_runs.append(newer_check)
        current = self.fixture.snapshot()
        temporary = tempfile.TemporaryDirectory(prefix="hepta-revalidate-")
        self.addCleanup(temporary.cleanup)
        current_path = Path(temporary.name) / "current.json"
        current_path.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(VERIFY), "--artifact", str(output), "--current-check-runs", str(current_path), "--skip-checkout-verification"],
            cwd=ROOT, text=True, capture_output=True, check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be regenerated", result.stderr)

    def test_producer_manifest_digest_drift_is_rejected(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="hepta-producer-map-")
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "producers.json"
        value = json.loads(PRODUCERS.read_text(encoding="utf-8"))
        value["producers"][0]["workflowSha256"] = "sha256:" + "0" * 64
        path.write_text(json.dumps(value), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "definition_drift"):
            COLLECT.load_policy(REQUIRED, path, "TrillionniumFoundation/hepta-paper")


if __name__ == "__main__":
    unittest.main(verbosity=2)
