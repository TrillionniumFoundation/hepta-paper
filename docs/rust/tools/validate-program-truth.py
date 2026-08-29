#!/usr/bin/env python3
"""Validate canonical Rust rewrite program truth using only the Python stdlib."""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
STATUS = ROOT / "docs/rust/current-status.v1.json"

ALLOWED_STATUS = {
    "not_started",
    "design_ready",
    "source_implemented",
    "source_qualified",
    "hosted_installed_qualified",
    "target_host_qualified",
    "external_authority_qualified",
    "blocked_external",
    "retired",
}
ALLOWED_TIERS = {
    "none",
    "design",
    "source",
    "hosted_installed",
    "target_host",
    "external_authority",
}
CANONICAL_FILES = {
    "docs/rust/CURRENT_STATUS.md",
    "docs/rust/current-status.v1.json",
    "docs/rust/RUST_REWRITE_MASTER_PLAN.md",
    "docs/rust/RUST_REWRITE_BACKLOG.md",
    "docs/rust/RUST_PARITY_MATRIX.md",
    "docs/rust/RUST_RISK_REGISTER.md",
    "docs/rust/RUST_TCB_BOUNDARY.md",
    "docs/rust/PRINCIPAL_AND_FILESYSTEM_MATRIX.md",
    "docs/rust/EVIDENCE_AND_QUALIFICATION_MODEL.md",
    "docs/rust/CRASH_AND_RECOVERY_MATRIX.md",
    "docs/rust/OPERATIONS_RUNBOOK.md",
    "docs/rust/DOCUMENTATION_INDEX.md",
}


def fail(message: str) -> None:
    raise ValueError(message)


def main() -> int:
    data = json.loads(STATUS.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != 1:
        fail("unsupported program-truth schemaVersion")
    if data.get("truthStatus") != "canonical":
        fail("program truth must be canonical")
    if set(data.get("statusVocabulary", [])) != ALLOWED_STATUS:
        fail("status vocabulary drift")
    if set(data.get("evidenceTiers", [])) != ALLOWED_TIERS:
        fail("evidence tier vocabulary drift")

    seen: set[str] = set()
    for section in ("workstreams", "gaps"):
        values = data.get(section)
        if not isinstance(values, list) or not values:
            fail(f"{section} must be a nonempty list")
        for item in values:
            identifier = item.get("id")
            if not isinstance(identifier, str) or not identifier:
                fail(f"{section} item missing id")
            if identifier in seen:
                fail(f"duplicate program id: {identifier}")
            seen.add(identifier)
            if item.get("status") not in ALLOWED_STATUS:
                fail(f"invalid status for {identifier}")
            if item.get("evidenceTier") not in ALLOWED_TIERS:
                fail(f"invalid evidence tier for {identifier}")
            if section == "gaps":
                criteria = item.get("closesWhen")
                if not isinstance(criteria, list) or not criteria:
                    fail(f"gap lacks closure criteria: {identifier}")
                external = item.get("external")
                if not isinstance(external, bool):
                    fail(f"gap external flag must be boolean: {identifier}")
                if item["status"] == "blocked_external" and not external:
                    fail(f"non-external gap cannot be blocked_external: {identifier}")
                if external and item["status"] not in {
                    "blocked_external",
                    "target_host_qualified",
                    "external_authority_qualified",
                    "retired",
                }:
                    fail(f"external gap has an invalid lifecycle state: {identifier}")

    missing = sorted(path for path in CANONICAL_FILES if not (ROOT / path).is_file())
    if missing:
        fail(f"missing canonical documents: {', '.join(missing)}")

    current = data.get("current", {})
    if current.get("productionActivation") != "disabled":
        fail("production activation cannot be enabled by this program-truth file")
    for key in (
        "realCodexCredentials",
        "liveProviderCalls",
    ):
        if current.get(key) != "forbidden":
            fail(f"{key} must remain forbidden at this stage")

    print(
        json.dumps(
            {
                "status": "rust_program_truth_valid",
                "schemaVersion": data["schemaVersion"],
                "workstreams": len(data["workstreams"]),
                "gaps": len(data["gaps"]),
                "canonicalFiles": len(CANONICAL_FILES),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"rust program truth invalid: {error}", file=sys.stderr)
        raise SystemExit(1)
