#!/usr/bin/env python3
"""Emit and enforce exact-head/exact-tree CI qualification evidence."""
from __future__ import annotations
import hashlib, json, os, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()

def main() -> int:
    expected = os.environ.get("EXPECTED_HEAD_SHA") or os.environ.get("GITHUB_SHA")
    if not expected:
        raise ValueError("EXPECTED_HEAD_SHA is required")
    tested = git("rev-parse", "HEAD")
    head = git("rev-parse", expected)
    tested_tree = git("rev-parse", "HEAD^{tree}")
    head_tree = git("rev-parse", f"{expected}^{{tree}}")
    if tested != head or tested_tree != head_tree:
        raise ValueError(
            f"exact-head mismatch: expected={head}/{head_tree} tested={tested}/{tested_tree}"
        )
    lock = ROOT / "rust/Cargo.lock"
    payload = {
        "schemaVersion": 1,
        "repository": os.environ.get("GITHUB_REPOSITORY"),
        "workflow": os.environ.get("GITHUB_WORKFLOW"),
        "workflowRef": os.environ.get("GITHUB_WORKFLOW_REF"),
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "runAttempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "eventName": os.environ.get("GITHUB_EVENT_NAME"),
        "headSha": head,
        "testedSha": tested,
        "headTree": head_tree,
        "testedTree": tested_tree,
        "baseSha": os.environ.get("BASE_SHA") or None,
        "rustToolchain": "1.98.0",
        "cargoLockSha256": hashlib.sha256(lock.read_bytes()).hexdigest(),
        "authority": "non_authorizing_ci_evidence",
    }
    output = Path(os.environ.get("EVIDENCE_OUTPUT", "/tmp/hepta-exact-head-evidence.json"))
    output.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")
    print(output.read_text(), end="")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, subprocess.CalledProcessError, ValueError) as exc:
        print(f"exact-head evidence rejected: {exc}", file=sys.stderr)
        raise SystemExit(1)
