#!/usr/bin/env python3
"""Validate canonical Rust rewrite program truth using only the Python stdlib."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[3]
STATUS = ROOT / "docs/rust/current-status.v1.json"
CURRENT_STATUS = ROOT / "docs/rust/CURRENT_STATUS.md"
BACKLOG = ROOT / "docs/rust/RUST_REWRITE_BACKLOG.md"

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
BACKLOG_ID = re.compile(r"RUST-(?:FND|BRK|WS|CMP|RO|MVP|DB)-\d{3}")
GAP_ID = re.compile(r"GAP-[A-Z]+-\d{3}")
WORKSTREAM_PREFIX = {
    "FND": "RUST-FND-",
    "BRK": "RUST-BRK-",
    "WS": "RUST-WS-",
    "CMP": "RUST-CMP-",
    "RO": "RUST-RO-",
    "MVP": "RUST-MVP-",
    "DB": "RUST-DB-",
}


def fail(message: str) -> None:
    raise ValueError(message)


def markdown_cells(line: str) -> list[str]:
    return [cell.strip().strip("`") for cell in line.strip().strip("|").split("|")]


def parse_backlog_statuses() -> dict[str, str]:
    observed: dict[str, str] = {}
    for line in BACKLOG.read_text(encoding="utf-8").splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = markdown_cells(line)
        if len(cells) < 3 or not BACKLOG_ID.fullmatch(cells[0]):
            continue
        identifier = cells[0]
        status = cells[2]
        if identifier in observed:
            fail(f"duplicate backlog row: {identifier}")
        if status not in ALLOWED_STATUS:
            fail(f"invalid backlog status for {identifier}: {status}")
        observed[identifier] = status
    return observed


def parse_gap_ledger(path: Path) -> dict[str, tuple[str, int]]:
    observed: dict[str, tuple[str, int]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = markdown_cells(line)
        if len(cells) < 3 or not GAP_ID.fullmatch(cells[0]):
            continue
        identifier = cells[0]
        status = cells[1]
        issue_match = re.search(r"#(\d+)", cells[2])
        if not issue_match:
            fail(f"external gap row lacks issue number in {path.name}: {identifier}")
        if identifier in observed:
            fail(f"duplicate external gap row in {path.name}: {identifier}")
        observed[identifier] = (status, int(issue_match.group(1)))
    return observed


def parse_current_status_rows(expected_labels: set[str]) -> dict[str, str]:
    observed: dict[str, str] = {}
    for line in CURRENT_STATUS.read_text(encoding="utf-8").splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = markdown_cells(line)
        if len(cells) < 2 or cells[0] not in expected_labels:
            continue
        if cells[0] in observed:
            fail(f"duplicate CURRENT_STATUS row: {cells[0]}")
        if cells[1] not in ALLOWED_STATUS:
            fail(f"invalid CURRENT_STATUS status for {cells[0]}: {cells[1]}")
        observed[cells[0]] = cells[1]
    return observed


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
    workstreams: dict[str, dict[str, object]] = {}
    external_gaps: dict[str, tuple[str, int]] = {}
    for section in ("workstreams", "gaps"):
        values = data.get(section)
        if not isinstance(values, list) or not values:
            fail(f"{section} must be a nonempty list")
        for item in values:
            if not isinstance(item, dict):
                fail(f"{section} item must be an object")
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
            if section == "workstreams":
                workstreams[identifier] = item
                continue
            criteria = item.get("closesWhen")
            if not isinstance(criteria, list) or not criteria:
                fail(f"gap lacks closure criteria: {identifier}")
            external = item.get("external")
            if not isinstance(external, bool):
                fail(f"gap external flag must be boolean: {identifier}")
            if item["status"] == "blocked_external" and not external:
                fail(f"non-external gap cannot be blocked_external: {identifier}")
            if external:
                if item["status"] not in {
                    "blocked_external",
                    "target_host_qualified",
                    "external_authority_qualified",
                    "retired",
                }:
                    fail(f"external gap has an invalid lifecycle state: {identifier}")
                issue = item.get("issue")
                if not isinstance(issue, int) or issue <= 0:
                    fail(f"external gap lacks a positive issue number: {identifier}")
                external_gaps[identifier] = (str(item["status"]), issue)

    missing = sorted(path for path in CANONICAL_FILES if not (ROOT / path).is_file())
    if missing:
        fail(f"missing canonical documents: {', '.join(missing)}")

    current = data.get("current", {})
    if not isinstance(current, dict):
        fail("current state must be an object")
    if current.get("productionActivation") != "disabled":
        fail("production activation cannot be enabled by this program-truth file")
    for key in ("realCodexCredentials", "liveProviderCalls"):
        if current.get(key) != "forbidden":
            fail(f"{key} must remain forbidden at this stage")
    for key in ("campaignWriterAuthority", "releaseAuthority", "submissionAuthority"):
        if current.get(key) != "absent":
            fail(f"{key} must remain absent at this stage")

    machine_backlog = data.get("backlogItemStatus")
    if not isinstance(machine_backlog, dict) or not machine_backlog:
        fail("backlogItemStatus must be a nonempty object")
    for identifier, status in machine_backlog.items():
        if not isinstance(identifier, str) or not BACKLOG_ID.fullmatch(identifier):
            fail(f"invalid machine backlog id: {identifier}")
        if status not in ALLOWED_STATUS:
            fail(f"invalid machine backlog status for {identifier}")
    human_backlog = parse_backlog_statuses()
    if human_backlog != machine_backlog:
        missing_rows = sorted(set(machine_backlog) - set(human_backlog))
        extra_rows = sorted(set(human_backlog) - set(machine_backlog))
        drift = sorted(
            identifier
            for identifier in set(machine_backlog) & set(human_backlog)
            if machine_backlog[identifier] != human_backlog[identifier]
        )
        fail(
            "backlog status drift: "
            f"missing={missing_rows}, extra={extra_rows}, mismatched={drift}"
        )

    for workstream_id, prefix in WORKSTREAM_PREFIX.items():
        workstream = workstreams.get(workstream_id)
        if workstream is None:
            fail(f"missing workstream for backlog prefix: {workstream_id}")
        item_statuses = [
            status
            for identifier, status in machine_backlog.items()
            if identifier.startswith(prefix)
        ]
        if not item_statuses:
            fail(f"workstream has no machine backlog items: {workstream_id}")
        if workstream["status"] == "source_qualified" and any(
            status not in {"source_qualified", "blocked_external"}
            for status in item_statuses
        ):
            fail(f"source-qualified workstream contains an unqualified item: {workstream_id}")

    machine_rows = data.get("currentStatusRows")
    if not isinstance(machine_rows, dict) or not machine_rows:
        fail("currentStatusRows must be a nonempty object")
    for label, status in machine_rows.items():
        if not isinstance(label, str) or not label or status not in ALLOWED_STATUS:
            fail(f"invalid current-status row: {label}")
    human_rows = parse_current_status_rows(set(machine_rows))
    if human_rows != machine_rows:
        fail(f"CURRENT_STATUS product table drift: machine={machine_rows}, human={human_rows}")

    for path in (CURRENT_STATUS, BACKLOG):
        human_external = parse_gap_ledger(path)
        if human_external != external_gaps:
            fail(
                f"external gap ledger drift in {path.name}: "
                f"machine={external_gaps}, human={human_external}"
            )

    candidate = data.get("qualificationCandidate")
    if not isinstance(candidate, dict):
        fail("qualificationCandidate must be an object")
    if candidate.get("binding") != "exact_head_workflow_evidence":
        fail("qualificationCandidate must bind through exact-head workflow evidence")
    if "commit" in candidate:
        fail("qualificationCandidate must not embed a self-staling commit literal")
    if candidate.get("productionAuthority") is not False:
        fail("qualificationCandidate cannot grant production authority")

    print(
        json.dumps(
            {
                "status": "rust_program_truth_valid",
                "schemaVersion": data["schemaVersion"],
                "workstreams": len(data["workstreams"]),
                "gaps": len(data["gaps"]),
                "externalGaps": len(external_gaps),
                "backlogItems": len(machine_backlog),
                "currentStatusRows": len(machine_rows),
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
