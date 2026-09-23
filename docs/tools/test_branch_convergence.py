import importlib.util
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("branch_audit", Path(__file__).with_name("audit-branch-convergence.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BranchAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.command("init", "-q", "-b", "main")
        self.command("config", "user.name", "Audit fixture")
        self.command("config", "user.email", "audit@invalid.example")
        self.commit("base.txt", "base")
        self.base = self.command("rev-parse", "HEAD")
        self.command("branch", "old")
        self.command("checkout", "-q", "-b", "side")
        self.commit("file with spaces.txt", "side")
        self.command("checkout", "-q", "main")
        self.commit("candidate.txt", "candidate")
        self.candidate = self.command("rev-parse", "HEAD")

    def tearDown(self):
        self.temporary.cleanup()

    def command(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL).decode().strip()

    def commit(self, name, content):
        (self.root / name).write_text(content)
        self.command("add", "--", name)
        self.command("commit", "-q", "-m", "fixture")

    def report(self):
        return module.audit(self.root, self.candidate, "refs/heads/")

    def test_all_refs_and_exact_two_tree_differences_are_retained(self):
        result = self.report()
        self.assertEqual(result["branchCount"], 3)
        rows = {row["ref"]: row for row in result["branches"]}
        self.assertEqual(rows["refs/heads/old"]["relation"], "ancestor")
        self.assertEqual(rows["refs/heads/main"]["relation"], "same_tree")
        side = rows["refs/heads/side"]
        self.assertEqual(side["relation"], "diverged")
        self.assertEqual(side["mergeBases"], [self.base])
        self.assertEqual({row["path"] for row in side["changes"]}, {"candidate.txt", "file with spaces.txt"})
        self.assertTrue(side["requiresDisposition"])

    def test_same_tree_never_transfers_acceptance(self):
        self.command("branch", "identical")
        result = self.report()
        row = next(row for row in result["branches"] if row["ref"] == "refs/heads/identical")
        self.assertEqual(row["relation"], "same_tree")
        self.assertFalse(row["evidenceTransfers"])
        self.assertFalse(result["automaticMerge"])
        self.assertFalse(result["productionActivationVerified"])

    def test_audit_is_deterministic_and_read_only(self):
        before = self.command("status", "--porcelain=v1")
        self.assertEqual(self.report(), self.report())
        self.assertEqual(self.command("status", "--porcelain=v1"), before)
        self.assertEqual(self.command("rev-parse", "HEAD"), self.candidate)

    def test_option_injection_and_unknown_namespace_rejected(self):
        with self.assertRaises(ValueError):
            module.audit(self.root, "--help", "refs/heads/")
        with self.assertRaises(ValueError):
            module.audit(self.root, self.candidate, "--all")


    def plan(self):
        report = self.report()
        side = next(row for row in report["branches"] if row["requiresDisposition"])
        return report, {"kind": "BranchDispositionPlanV1", "schemaVersion": 1,
            "candidateCommit": report["candidateCommit"], "candidateTree": report["candidateTree"],
            "auditSha256": report["reportSha256"], "decisions": [{
                "ref": side["ref"], "commit": side["commit"], "changes": side["changes"],
                "decision": "retain_reference", "owner": "fixture-owner", "rationale": "Fixture source binding only",
                "reviewEvidenceSha256": "sha256:" + "1" * 64}]}

    def test_complete_disposition_bindings_never_manufacture_independent_review(self):
        report, plan = self.plan()
        result = module.validate_disposition_plan(report, plan)
        self.assertTrue(result["dispositionBindingsComplete"])
        self.assertFalse(result["independentReviewVerified"])
        self.assertFalse(result["automaticMerge"])
        self.assertEqual(report["unresolvedBranchCount"], 1)

    def test_missing_disposition_stays_unplanned(self):
        report, plan = self.plan()
        plan["decisions"] = []
        result = module.validate_disposition_plan(report, plan)
        self.assertFalse(result["dispositionBindingsComplete"])
        self.assertEqual(result["unplannedRefs"], ["refs/heads/side"])

    def test_stale_subject_tip_paths_and_refset_are_rejected(self):
        report, plan = self.plan()
        variants = []
        for key in ("candidateCommit", "candidateTree", "auditSha256"):
            bad = copy.deepcopy(plan)
            bad[key] = "0" * 40
            variants.append(bad)
        bad = copy.deepcopy(plan)
        bad["decisions"][0]["changes"] = []
        variants.append(bad)
        bad = copy.deepcopy(plan)
        bad["decisions"][0]["commit"] = self.base
        variants.append(bad)
        for bad in variants:
            with self.assertRaises(ValueError):
                module.validate_disposition_plan(report, bad)
        self.command("branch", "new-branch")
        with self.assertRaises(ValueError):
            module.validate_disposition_plan(self.report(), plan)

    def test_duplicate_dispositions_unknown_fields_and_boolean_approval_rejected(self):
        report, plan = self.plan()
        variants = []
        bad = copy.deepcopy(plan)
        bad["decisions"] *= 2
        variants.append(bad)
        bad = copy.deepcopy(plan)
        bad["productionActivation"] = True
        variants.append(bad)
        bad = copy.deepcopy(plan)
        bad["decisions"][0]["reviewEvidenceSha256"] = True
        variants.append(bad)
        bad = copy.deepcopy(plan)
        bad["decisions"][0]["decision"] = "auto_merge"
        variants.append(bad)
        for bad in variants:
            with self.assertRaises(ValueError):
                module.validate_disposition_plan(report, bad)

    def test_plan_json_rejects_duplicate_keys_nonfinite_values_and_symlinks(self):
        plan = self.root / "plan.json"
        for text in ('{"kind":1,"kind":2}', '{"value":NaN}'):
            plan.write_text(text)
            with self.assertRaises(ValueError):
                module.read_disposition_plan(plan)
        alias = self.root / "alias.json"
        alias.symlink_to(plan)
        with self.assertRaises(OSError):
            module.read_disposition_plan(alias)

    def test_cli_requires_dispositions_without_modifying_refs(self):
        args = ["python3", str(Path(module.__file__)), "--root", str(self.root),
                "--candidate", self.candidate, "--ref-prefix", "refs/heads/", "--require-dispositions"]
        result = subprocess.run(args, capture_output=True, check=False)
        self.assertEqual(result.returncode, 2)
        report, plan = self.plan()
        path = self.root / "plan.json"
        path.write_text(json.dumps(plan))
        result = subprocess.run([*args, "--dispositions", str(path)], capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["dispositions"]["independentReviewVerified"])
        self.assertEqual(self.command("rev-parse", "HEAD"), report["candidateCommit"])


if __name__ == "__main__":
    unittest.main()
