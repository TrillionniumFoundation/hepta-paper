#!/usr/bin/env python3
"""Tests for complete migration partitions and coordinated CI observation windows."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import unittest

from run_service_integration_shard import PACKAGE, ROOT, select_targets


def fixture(count=125):
    targets = [{"name": f"target_{n:03}", "kind": ["test"], "test": True} for n in range(count)]
    targets += [{"name": "service", "kind": ["lib"], "test": True}]
    return {"packages": [{"name": PACKAGE, "id": "service", "targets": targets}],
            "workspace_members": ["service"]}


class ServiceIntegrationShards(unittest.TestCase):
    def test_partitions_cover_every_target_exactly_once(self):
        for count in [4, 5, 125, 129]:
            data = fixture(count)
            selected = [name for shard in range(4) for name in select_targets(data, shard, 4)]
            self.assertEqual(len(selected), count)
            self.assertEqual(len(set(selected)), count)
            self.assertEqual(sorted(selected), [f"target_{n:03}" for n in range(count)])

    def test_metadata_order_cannot_change_assignment(self):
        data = fixture()
        other = copy.deepcopy(data)
        other["packages"][0]["targets"].reverse()
        for shard in range(4):
            self.assertEqual(select_targets(data, shard, 4), select_targets(other, shard, 4))

    def test_invalid_shards_fail(self):
        for index, count in [(-1, 4), (4, 4), (0, 0), (0, 17), (True, 4), (0, True)]:
            with self.assertRaises(ValueError):
                select_targets(fixture(), index, count)

    def test_invalid_inventory_fails(self):
        for mode in ["empty", "duplicate", "disabled", "unsafe", "foreign", "ambiguous"]:
            data = fixture()
            package = data["packages"][0]
            if mode == "empty": package["targets"] = []
            if mode == "duplicate": package["targets"].append(package["targets"][0])
            if mode == "disabled": package["targets"][0]["test"] = False
            if mode == "unsafe": package["targets"][0]["name"] = "*"
            if mode == "foreign": data["workspace_members"] = []
            if mode == "ambiguous": data["packages"].append(copy.deepcopy(package))
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                select_targets(data, 0, 4)
        with self.assertRaises(ValueError):
            select_targets(fixture(1), 3, 4)

    def test_native_fixture_is_built_before_every_service_test_lane(self):
        # These suites exec the normal example, not its libtest harness. This
        # checks the actual workflow prerequisite, not a claim of Rust execution.
        for name, target in [
            ("rust-foundation", "Run tests"),
            ("rust-migration-acceptance", "Verify service unit targets and documentation tests"),
        ]:
            source = (ROOT / f".github/workflows/{name}.yml").read_text()
            steps = re.split(r"(?m)^      - name: ", source)[1:]
            names = [step.splitlines()[0] for step in steps]
            self.assertEqual(names.count("Build native authority test executable"), 1)
            index = names.index("Build native authority test executable")
            self.assertLess(index, names.index(target))
            body = steps[index]
            command = " ".join(body.replace("\\\n", " ").split())
            self.assertIn("set -euo pipefail", command)
            self.assertIn("command -v strip", command)
            self.assertIn(
                "cargo build --manifest-path rust/Cargo.toml --locked --all-features "
                "-p hepta-paper-service --example native-authority-fixture-client",
                command,
            )
            example = ("$CARGO_TARGET_DIR" if name == "rust-foundation" else "rust/target")
            executable = f"{example}/debug/examples/native-authority-fixture-client"
            if name == "rust-foundation":
                executable = f'"{executable}"'
            self.assertIn(f"test -x {executable}", command)
            self.assertNotIn("continue-on-error", body)
            self.assertNotIn("|| true", body)
            if name == "rust-migration-acceptance":
                self.assertIn("if: matrix.lane != 'core'", body)
                self.assertLess(index, names.index("Verify complete service integration partition"))
            else:
                self.assertNotIn("        if:", body)

    def assert_foundation_target_isolation(self, source):
        # Inspect configuration only. No Cargo, executable, installer or oracle
        # is run, and these checks are not a behavioral qualification receipt.
        before_steps = source.split("    steps:\n", 1)[0]
        # runner context is unavailable in job-level env. Persist the prepared
        # runner path with GITHUB_ENV before every Cargo-producing step instead.
        self.assertNotIn("${{ runner.", before_steps)
        self.assertNotIn("CARGO_TARGET_DIR:", source)
        self.assertEqual(source.count("CARGO_TARGET_DIR="), 1)
        self.assertNotRegex(source, r"(?m)^\s*(?:export\s+)?CARGO_TARGET_DIR=")
        self.assertNotIn("--target-dir", source)
        self.assertIn("    timeout-minutes: 90\n", before_steps)
        steps = re.split(r"(?m)^      - name: ", source)[1:]
        names = [step.splitlines()[0] for step in steps]
        prepare = "Prepare isolated Cargo target directory"
        self.assertEqual(names.count(prepare), 1)
        index = names.index(prepare)
        body = steps[index]
        for text in (
            "set -euo pipefail",
            'target="$(realpath "$RUNNER_TEMP")/hepta-rust-foundation-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"',
            'workspace="$(realpath "$GITHUB_WORKSPACE")"',
            'case "$target/" in',
            '"$workspace/"*)',
            "exit 1",
            'mkdir -- "$target"',
            "printf 'CARGO_TARGET_DIR=%s\\n' \"$target\" >> \"$GITHUB_ENV\"",
        ):
            self.assertIn(text, body)
        for text in ("        if:", "continue-on-error", "|| true", "mkdir -p", "rm -"):
            self.assertNotIn(text, body)
        self.assertLess(body.index('mkdir -- "$target"'), body.index("printf 'CARGO_TARGET_DIR="))
        for name in ("Validate locked dependency metadata", "Check formatting", "Run Clippy",
                     "Build native authority test executable", "Build documentation", "Run tests"):
            self.assertLess(index, names.index(name))
        commands = {name: " ".join(step.replace("\\\n", " ").split())
                    for name, step in zip(names, steps)}
        self.assertIn('test -x "$CARGO_TARGET_DIR/debug/examples/native-authority-fixture-client"',
                      commands["Build native authority test executable"])
        self.assertIn("cargo doc --manifest-path rust/Cargo.toml --workspace --all-features "
                      "--locked --no-deps 2>&1 | tee /tmp/hepta-rust-validation/rustdoc.log",
                      commands["Build documentation"])
        self.assertIn("cargo test --manifest-path rust/Cargo.toml --workspace --all-features "
                      "--locked 2>&1 | tee /tmp/hepta-rust-validation/test.log",
                      commands["Run tests"])
        host = "Prepare and verify scientific test host"
        self.assertIn("run: bash .github/scripts/prepare-scientific-test-host.sh", commands[host])
        self.assertLess(names.index("Build documentation"), names.index(host))
        self.assertLess(names.index(host), names.index("Run tests"))

    def test_foundation_uses_one_exclusive_external_target_for_all_cargo_steps(self):
        source = (ROOT / ".github/workflows/rust-foundation.yml").read_text()
        self.assert_foundation_target_isolation(source)

    def test_foundation_target_configuration_rejects_incomplete_migrations(self):
        source = (ROOT / ".github/workflows/rust-foundation.yml").read_text()
        mutations = {
            "workspace_target": ('$(realpath "$RUNNER_TEMP")/hepta-rust-foundation-', "rust/target-"),
            "shared_attempts": ("-$GITHUB_RUN_ATTEMPT", ""),
            "invalid_job_context": ("    steps:\n", "    env:\n      CARGO_TARGET_DIR: ${{ runner.temp }}/target\n    steps:\n"),
            "step_only_environment": ("printf 'CARGO_TARGET_DIR=%s\\n' \"$target\" >> \"$GITHUB_ENV\"", 'export CARGO_TARGET_DIR="$target"'),
            "reused_directory": ('mkdir -- "$target"', 'mkdir -p -- "$target"'),
            "missing_workspace_guard": ('"$workspace/"*)', '"/unrelated-workspace/"*)'),
            "stale_example_consumer": ('test -x "$CARGO_TARGET_DIR/debug/examples/native-authority-fixture-client"',
                                       "test -x rust/target/debug/examples/native-authority-fixture-client"),
            "unguarded_creation": ('mkdir -- "$target"', 'mkdir -- "$target" || true'),
            "changed_full_test_command": ("          cargo test \\\n", "          cargo test --lib \\\n"),
            "changed_doc_command": ("          cargo doc \\\n", "          cargo doc --lib \\\n"),
            "missing_host_gate": ("run: bash .github/scripts/prepare-scientific-test-host.sh", "run: true"),
        }
        for name, (old, new) in mutations.items():
            with self.subTest(name=name):
                self.assertIn(old, source)
                changed = source.replace(old, new, 1)
                with self.assertRaises(AssertionError):
                    self.assert_foundation_target_isolation(changed)

    def test_functional_producer_and_parent_oracle_share_bounded_job_headroom(self):
        source = (ROOT / ".github/workflows/rust-functional-source-closure.yml").read_text()
        jobs = re.split(r"(?m)^  (?:exact-head|prospective-merge):\n", source)[1:]
        self.assertEqual(len(jobs), 2)
        for job in jobs:
            self.assertEqual(re.findall(r"(?m)^    timeout-minutes: (\d+)$", job), ["90"])
            self.assertNotRegex(job, r"(?m)^        timeout-minutes:")
            commands = [line for line in job.splitlines()
                        if "node paper-core/bin/with-locked-parent-node-oracle.mjs " in line]
            self.assertEqual(len(commands), 1)
            self.assertIn(" --budget-profile functional-ci -- /bin/bash -euc '", commands[0])
        repository = (ROOT / ".github/workflows/repository-source-evidence.yml").read_text()
        self.assertNotIn("--budget-profile", repository)
        self.assertNotIn("--job-timeout-minutes", source + repository)
        self.assertEqual(re.findall(r"(?m)^    timeout-minutes: (\d+)$", repository), ["30", "30"])

    def test_observation_windows_outlive_producers_without_relaxing_acceptance(self):
        required = json.loads((ROOT / "docs/rust/qualification/source-required-checks.v1.json").read_text())
        producers = json.loads((ROOT / "docs/rust/qualification/source-check-producers.v1.json").read_text())
        producer_budget = max(int(n) for row in producers["producers"] for n in re.findall(
            r"timeout-minutes: (\d+)", (ROOT / row["workflowPath"]).read_text())) * 60
        wait = required["collector"]["maximumWaitSeconds"]
        self.assertGreaterEqual(wait, producer_budget + 600)
        self.assertEqual(required["acceptedConclusion"], "success")
        self.assertIn("cancelled", required["forbiddenConclusions"])
        self.assertIn("skipped", required["forbiddenConclusions"])
        for name in ["rust-effective-source-qualification", "rust-qualification-subject-v3"]:
            source = (ROOT / f".github/workflows/{name}.yml").read_text()
            budget = int(re.search(r"timeout-minutes: (\d+)", source)[1]) * 60
            self.assertGreaterEqual(budget, wait + 600)
        for name in ["rust-source-qualification-revalidation", "rust-qualification-subject-v3-revalidation"]:
            source = (ROOT / f".github/workflows/{name}.yml").read_text()
            outer = int(re.search(r"timeout-minutes: (\d+)", source)[1]) * 60
            inner = int(re.search(r"deadline = time.monotonic\(\) \+ (\d+)", source)[1])
            self.assertGreaterEqual(inner, wait + 600)
            self.assertGreaterEqual(outer, inner + 600)


if __name__ == "__main__":
    unittest.main()
