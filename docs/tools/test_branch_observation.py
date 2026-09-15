"""Host-independent regression tests for public branch-capture consistency."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "branch_observation", Path(__file__).with_name("bind-branch-observation.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.commit = "a" * 40
        self.before = self.commit + "\trefs/heads/candidate\n" + "b" * 40 + "\trefs/heads/main\n"
        self.audit = {
            "kind": "BranchConvergenceAuditV1", "schemaVersion": 1,
            "candidateCommit": self.commit, "candidateTree": "c" * 40,
            "refNamespace": "refs/remotes/origin/", "branchCount": 2,
            "automaticMerge": False, "productionActivationVerified": False,
            "branches": [{"ref": "refs/remotes/origin/candidate", "commit": self.commit,
                          "evidenceTransfers": False},
                         {"ref": "refs/remotes/origin/main", "commit": "b" * 40,
                          "evidenceTransfers": False}],
        }
        self.sign(self.audit)

    @staticmethod
    def sign(audit):
        unsigned = {k: v for k, v in audit.items() if k != "reportSha256"}
        audit["reportSha256"] = "sha256:" + hashlib.sha256(
            json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def bind(self, audit=None, before=None, after=None):
        return module.bind_observation(before or self.before, after or self.before,
                                       audit or self.audit, self.commit, "candidate")

    def test_exact_complete_capture_is_non_authorizing(self):
        result = self.bind(after="\n".join(reversed(self.before.strip().splitlines())) + "\n")
        self.assertEqual(result["branchCount"], 2)
        self.assertTrue(result["stableDuringCapture"])
        for field in ("independentReviewVerified", "automaticMerge",
                      "productionActivationVerified", "nodeRetirementVerified"):
            self.assertIs(result[field], False)

    def test_new_deleted_or_moved_remote_ref_denies(self):
        for after in (self.before + "d" * 40 + "\trefs/heads/new\n",
                      self.before.splitlines()[0] + "\n", self.before.replace("b" * 40, "d" * 40)):
            with self.assertRaises(ValueError):
                self.bind(after=after)

    def test_duplicate_or_malformed_remote_rows_deny(self):
        for text in (self.before + self.before, "garbage", "", "a" * 40 + "\trefs/tags/x\n"):
            with self.assertRaises(ValueError):
                module.parse_heads(text)

    def test_stale_candidate_denies(self):
        before = self.before.replace(self.commit, "d" * 40)
        with self.assertRaises(ValueError):
            self.bind(before=before, after=before)

    def test_incomplete_or_duplicate_audit_denies_even_if_rehashed(self):
        for change in (lambda a: a["branches"].pop(),
                       lambda a: a["branches"].append(copy.deepcopy(a["branches"][0])),
                       lambda a: a.update(branchCount=3)):
            audit = copy.deepcopy(self.audit)
            change(audit)
            self.sign(audit)
            with self.assertRaises(ValueError):
                self.bind(audit=audit)

    def test_digest_subject_and_authority_drift_deny(self):
        for key, value in (("candidateCommit", "d" * 40), ("candidateTree", "invalid"),
                           ("schemaVersion", True), ("automaticMerge", True),
                           ("productionActivationVerified", True)):
            audit = copy.deepcopy(self.audit)
            audit[key] = value
            self.sign(audit)
            with self.assertRaises(ValueError):
                self.bind(audit=audit)
        audit = copy.deepcopy(self.audit)
        audit["candidateTree"] = "e" * 40
        with self.assertRaises(ValueError):
            self.bind(audit=audit)

    def test_duplicate_json_key_denies(self):
        with self.assertRaises(ValueError):
            json.loads('{"a":1,"a":2}', object_pairs_hook=module.unique_pairs)


if __name__ == "__main__":
    unittest.main()
