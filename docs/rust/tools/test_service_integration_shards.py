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
            self.assertIn("test -x rust/target/debug/examples/native-authority-fixture-client", command)
            self.assertNotIn("continue-on-error", body)
            self.assertNotIn("|| true", body)
            if name == "rust-migration-acceptance":
                self.assertIn("if: matrix.lane != 'core'", body)
                self.assertLess(index, names.index("Verify complete service integration partition"))
            else:
                self.assertNotIn("        if:", body)

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
