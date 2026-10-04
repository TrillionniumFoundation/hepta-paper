#!/usr/bin/env python3
"""Source contracts only: never install policy or claim kernel/runtime proof."""

import ast
import hashlib
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
UPSTREAM_SHA256 = "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9"
DERIVED_SHA256 = "407f98d83892642cd025337bafcab0ff0520b905f3afcab2886511ce4998399b"
REMOVED_GRANT = b"  allow io_uring,\n"


def verify_derivative(upstream, derived):
    if hashlib.sha256(upstream).hexdigest() != UPSTREAM_SHA256:
        raise ValueError("upstream provenance changed")
    if hashlib.sha256(derived).hexdigest() != DERIVED_SHA256:
        raise ValueError("reviewed derivative changed")
    header, separator, body = derived.partition(b"\n\n")
    if not separator or not all(line.startswith(b"#") for line in header.splitlines()):
        raise ValueError("derivative header must be comments")
    if upstream.count(REMOVED_GRANT) != 2:
        raise ValueError("upstream rule inventory changed")
    if body != upstream.replace(REMOVED_GRANT, b""):
        raise ValueError("unreviewed rule delta")


class ScientificHostSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = (ROOT / ".github/apparmor/bwrap-userns-restrict").read_bytes()
        cls.derived = (ROOT / ".github/apparmor/bwrap-userns-restrict-abi4-v1").read_bytes()
        cls.script = (ROOT / ".github/scripts/prepare-scientific-test-host.sh").read_text()
        cls.workflow = (ROOT / ".github/workflows/rust-foundation.yml").read_text()
        cls.python = cls.script.split("<<'SCIENTIFIC_APPARMOR_PY'\n", 1)[1].split(
            "\nSCIENTIFIC_APPARMOR_PY\n", 1
        )[0]
        cls.tree = ast.parse(cls.python)

    def test_only_two_unrestricted_grants_removed(self):
        verify_derivative(self.upstream, self.derived)

    def test_denial_removal_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "derivative changed"):
            verify_derivative(self.upstream, self.derived.replace(b"  audit deny capability,\n", b""))

    def test_attachment_change_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "derivative changed"):
            verify_derivative(self.upstream, self.derived.replace(b"/usr/bin/bwrap", b"/**"))

    def test_upstream_drift_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "provenance changed"):
            verify_derivative(self.upstream + b"\n", self.derived)

    def test_host_validator_rejects_wrong_count_and_additional_edits(self):
        # Execute only the pure source validator extracted from the real script.
        # Synthetic digests here exercise shape checks, never kernel claims.
        functions = [node for node in self.tree.body if isinstance(node, ast.FunctionDef)
                     and node.name in ("verify_derivative", "require")]
        self.assertEqual(len(functions), 2)
        namespace = {"hashlib": hashlib, "UPSTREAM_EXPECTED": UPSTREAM_SHA256}
        exec(compile(ast.Module(body=functions, type_ignores=[]), "pure-validator", "exec"), namespace)
        validate = namespace["verify_derivative"]
        validate(self.upstream, self.derived)
        for changed in (
            self.derived.replace(b"  audit deny capability,\n", b""),
            self.derived.replace(b"  allow pix /** -> &unpriv_bwrap,", b"  allow pix /**,"),
            self.derived.replace(b"/usr/bin/bwrap", b"/**"),
            self.derived + b"\n",
        ):
            with self.subTest(change=hashlib.sha256(changed).hexdigest()):
                with self.assertRaisesRegex(SystemExit, "unreviewed_derived_policy_delta"):
                    validate(self.upstream, changed)
        for count in (0, 1, 3):
            upstream = self.upstream.replace(REMOVED_GRANT, b"") + REMOVED_GRANT * count
            namespace["UPSTREAM_EXPECTED"] = hashlib.sha256(upstream).hexdigest()
            with self.subTest(rule_count=count):
                with self.assertRaisesRegex(SystemExit, "rule_inventory_changed"):
                    validate(upstream, self.derived)

    def test_policy_and_kernel_features_are_observed_separately(self):
        self.assertIn('sha256=hashlib.sha256(abi_raw).hexdigest(), content=abi_raw.decode("utf-8")', self.python)
        self.assertIn('feature_root = Path("/sys/kernel/security/apparmor/features")', self.python)
        self.assertIn('("io_uring/mask", "namespaces/mask", "domain/stack", "caps/mask")', self.python)
        self.assertIn('feature_observations[feature] = {"present": False}', self.python)
        self.assertIn('ioUringRestrictionClaimed=False', self.python)
        self.assertNotIn('ioUringRestrictionClaimed=True', self.python)

    def test_entire_existing_load_guard_cleanup_and_probe_tail_is_unchanged(self):
        tail = self.script[self.script.index("# --add refuses an existing policy;"):]
        self.assertEqual(hashlib.sha256(tail.encode()).hexdigest(),
                         "595f3588f05e6d9e526100afc43b1d499041e3b8412b974aea978a8a4f39ded3")

    def test_host_pins_exact_derivative_before_exclusive_install(self):
        self.assertIn('../apparmor/bwrap-userns-restrict-abi4-v1"', self.script)
        self.assertIn(f'EXPECTED = "{DERIVED_SHA256}"', self.python)
        self.assertIn(f"metadata.st_size == {len(self.derived)}", self.python)
        self.assertIn(f"raw = held.read({len(self.derived) + 1})", self.python)
        digest = self.python.index('require(hashlib.sha256(raw).hexdigest() == EXPECTED')
        compile_at = self.python.index('subprocess.run([*arguments, "--skip-kernel-load", "--add"]')
        install = self.python.index('descriptor = os.open(POLICY, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW')
        self.assertLess(digest, compile_at)
        self.assertLess(compile_at, install)
        self.assertIn('"--warn=rule-not-enforced", "--Werror=rule-not-enforced"', self.python)
        for forbidden in ("--kernel-features", "--policy-features", "--override-policy-abi", "--warn=no-", "--replace", "--complain", "--quiet"):
            self.assertNotIn(forbidden, self.python)

    def test_child_and_kernel_refusal_obligations_remain(self):
        for required in (
            'expected = "bwrap//&unpriv_bwrap (enforce)"',
            'require(label() == expected, "complete_enforced_stack_required")',
            'require(cap_effective & (1 << 21), "effective_sys_admin_bit_required")',
            'result = libc.unshare(0x00020000)',
            'require(result == -1 and error == errno.EPERM, "actual_sys_admin_refusal_required")',
            'fields.get("pid") != str(pid)',
            'fields.get("apparmor") != "DENIED"',
            'fields.get("operation") != "capable"',
            'fields.get("profile") == "unpriv_bwrap"',
            'fields.get("capability") == "21" and fields.get("capname") == "sys_admin"',
            'require(len(matches) == 1, "guard_exact_pid_capability_audit_required")',
            'require(clean, "effective_child_guard_cleanup_incomplete")',
            'effective_child_guard()\n',
        ):
            self.assertIn(required, self.python)

    def test_nested_child_program_compiles_without_execution(self):
        sources = [node.value.value for node in ast.walk(self.tree)
                   if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == "child_source"
                           for target in node.targets)]
        self.assertEqual(len(sources), 1)
        compile(sources[0], "scientific-child-source-only", "exec")
        compile(self.tree, "scientific-setup-source-only", "exec")

    def test_static_feedback_precedes_host_but_all_tests_remain_gated(self):
        names = [block.splitlines()[0] for block in self.workflow.split("      - name: ")[1:]]
        host = names.index("Prepare and verify scientific test host")
        for name in ("Verify scientific host source contracts", "Check formatting", "Run Clippy", "Build documentation"):
            self.assertLess(names.index(name), host)
        self.assertLess(host, names.index("Run tests"))
        test_block = self.workflow.split("      - name: Run tests\n", 1)[1].split("      - name:", 1)[0]
        self.assertIn("cargo test \\\n            --manifest-path rust/Cargo.toml \\\n            --workspace \\\n            --all-features \\\n            --locked", test_block)
        self.assertNotIn("--skip", test_block)
        self.assertNotIn("continue-on-error", self.workflow)


if __name__ == "__main__":
    unittest.main()
