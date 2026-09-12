import importlib.util
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


if __name__ == "__main__":
    unittest.main()
