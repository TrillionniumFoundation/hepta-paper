#!/usr/bin/env python3
"""Run a complete, disjoint partition of Cargo's actual service test targets.

This is test scheduling only. It neither qualifies a source tree nor changes
ignored-test policy. The ordinary foundation job remains the full workspace gate.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = "hepta-paper-service"


def select_targets(metadata: dict, index: int, count: int) -> list[str]:
    if type(index) is not int or type(count) is not int or not 1 <= count <= 16 or not 0 <= index < count:
        raise ValueError("invalid integration shard")
    packages = [p for p in metadata["packages"] if p["name"] == PACKAGE]
    if len(packages) != 1 or packages[0]["id"] not in metadata["workspace_members"]:
        raise ValueError("service must be a unique workspace member")
    names = []
    for target in packages[0]["targets"]:
        if target["kind"] != ["test"]:
            continue
        name = target["name"]
        if target.get("test") is not True or not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError("unsupported or disabled integration target")
        names.append(name)
    if not names or len(names) > 4096 or len(names) != len(set(names)):
        raise ValueError("empty, duplicate or oversized integration inventory")
    selected = sorted(names)[index::count]
    if not selected:
        raise ValueError("empty integration partition")
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", required=True, type=int)
    parser.add_argument("--count", required=True, type=int)
    args = parser.parse_args()
    result = subprocess.run(
        ["cargo", "metadata", "--manifest-path", "rust/Cargo.toml", "--locked",
         "--all-features", "--no-deps", "--format-version", "1"],
        cwd=ROOT, check=True, stdout=subprocess.PIPE, timeout=120,
    )
    if len(result.stdout) > 16 * 1024 * 1024:
        raise ValueError("Cargo metadata exceeds bound")
    targets = select_targets(json.loads(result.stdout), args.index, args.count)
    print(json.dumps({"package": PACKAGE, "index": args.index, "count": args.count,
                      "targets": targets}, sort_keys=True), flush=True)
    command = ["cargo", "test", "--manifest-path", "rust/Cargo.toml", "--locked",
               "--all-features", "-p", PACKAGE]
    for target in targets:
        command.extend(["--test", target])
    # One Cargo invocation builds the selected targets once; no shell, test-name
    # filtering, success on failure, or hand-maintained list of test binaries.
    subprocess.run(command, cwd=ROOT, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
