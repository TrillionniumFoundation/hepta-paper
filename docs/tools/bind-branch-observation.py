#!/usr/bin/env python3
"""Bind stable public remote-ref observations to an exact local tree audit.

This verifies source/capture consistency only. It never approves dispositions,
merges branches, transfers CI, or grants deployment/retirement authority.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

MAX_BYTES = 64 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{40}\Z")


def parse_heads(text):
    rows = {}
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            raise ValueError("invalid remote head row")
        sha, ref = parts
        if not SHA.fullmatch(sha) or not ref.startswith("refs/heads/"):
            raise ValueError("invalid remote head identity")
        if ref in rows or any(ord(c) <= 32 or ord(c) == 127 for c in ref):
            raise ValueError("duplicate or invalid remote ref")
        rows[ref] = sha
    if not rows or len(rows) > 4096:
        raise ValueError("empty or oversized remote head set")
    return rows


def bind_observation(before, after, audit, expected_commit, expected_branch):
    first, last = parse_heads(before), parse_heads(after)
    if first != last:
        raise ValueError("remote head set moved during capture")
    if not SHA.fullmatch(expected_commit):
        raise ValueError("invalid expected commit")
    if first.get("refs/heads/" + expected_branch) != expected_commit:
        raise ValueError("candidate is not the observed branch head")
    if (audit.get("kind") != "BranchConvergenceAuditV1"
            or type(audit.get("schemaVersion")) is not int
            or audit["schemaVersion"] != 1
            or audit.get("candidateCommit") != expected_commit
            or not isinstance(audit.get("candidateTree"), str)
            or not SHA.fullmatch(audit["candidateTree"])
            or audit.get("refNamespace") != "refs/remotes/origin/"
            or audit.get("automaticMerge") is not False
            or audit.get("productionActivationVerified") is not False):
        raise ValueError("invalid exact audit subject or authority ceiling")
    unsigned = {key: value for key, value in audit.items() if key != "reportSha256"}
    encoded = json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode()
    digest = "sha256:" + hashlib.sha256(encoded).hexdigest()
    if audit.get("reportSha256") != digest:
        raise ValueError("audit digest mismatch")
    rows = audit.get("branches")
    if not isinstance(rows, list) or type(audit.get("branchCount")) is not int:
        raise ValueError("invalid audited branch list")
    observed = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("ref"), str):
            raise ValueError("invalid audited ref")
        ref = row["ref"]
        if not ref.startswith("refs/remotes/origin/"):
            raise ValueError("unexpected audited ref namespace")
        remote = "refs/heads/" + ref.removeprefix("refs/remotes/origin/")
        if remote in observed or row.get("evidenceTransfers") is not False:
            raise ValueError("duplicate ref or transferred evidence")
        observed[remote] = row.get("commit")
    if observed != first or audit["branchCount"] != len(first):
        raise ValueError("fetched/audited and remote branch sets differ")
    canonical_heads = json.dumps(first, sort_keys=True, separators=(",", ":")).encode()
    return {
        "kind": "BranchObservationBindingV1", "schemaVersion": 1,
        "scope": "observed_remote_refs_and_local_audit_consistency_only",
        "candidateCommit": expected_commit, "candidateTree": audit["candidateTree"],
        "candidateBranch": expected_branch, "branchCount": len(first),
        "remoteHeadsSha256": "sha256:" + hashlib.sha256(canonical_heads).hexdigest(),
        "auditSha256": digest, "stableDuringCapture": True,
        "independentReviewVerified": False, "automaticMerge": False,
        "productionActivationVerified": False, "nodeRetirementVerified": False,
    }


def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def read_bounded(path):
    with Path(path).open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("capture input exceeds byte bound")
    return data.decode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("before", "after", "audit", "commit", "branch"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        audit = json.loads(read_bounded(args.audit), object_pairs_hook=unique_pairs)
        if not isinstance(audit, dict):
            raise ValueError("expected audit object")
        result = bind_observation(read_bounded(args.before), read_bounded(args.after),
                                  audit, args.commit, args.branch)
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, TypeError, KeyError, RecursionError):
        print("branch-observation: inconsistent or invalid capture", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
