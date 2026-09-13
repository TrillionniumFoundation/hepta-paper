#!/usr/bin/env python3
"""Read local Git refs and compare exact trees; never merge or grant qualification."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

SHA = re.compile(r"[0-9a-f]{40}\Z")
MAX_BYTES = 64 * 1024 * 1024


def git(root, *args, allowed=(0,)):
    result = subprocess.run(
        ["git", "--no-pager", "-c", "core.fsmonitor=false", "-C", str(root), *args],
        capture_output=True, timeout=30, check=False,
    )
    if result.returncode not in allowed:
        raise ValueError("git read failed: " + " ".join(args[:2]))
    if len(result.stdout) > MAX_BYTES:
        raise ValueError("git output exceeds audit bound")
    return result.stdout


def resolve(root, candidate):
    if candidate != "HEAD" and not SHA.fullmatch(candidate):
        raise ValueError("candidate must be HEAD or an exact commit SHA")
    value = git(root, "rev-parse", "--verify", candidate + "^{commit}").decode().strip()
    if not SHA.fullmatch(value):
        raise ValueError("invalid candidate commit")
    return value


def refs(root, prefix):
    if prefix not in ("refs/remotes/origin/", "refs/heads/"):
        raise ValueError("unsupported ref namespace")
    raw = git(root, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", prefix)
    rows = []
    for line in raw.decode("utf-8").splitlines():
        name, sha, symbolic = line.split("\0")
        if symbolic:
            continue
        if not name.startswith(prefix) or not SHA.fullmatch(sha):
            raise ValueError("invalid branch identity")
        rows.append((name, sha))
    if not rows or len(rows) > 4096:
        raise ValueError("branch inventory empty or too large")
    return sorted(rows)


def tree_changes(root, candidate, tip):
    raw = git(root, "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
              "--name-status", "-z", candidate, tip, "--")
    parts = raw.split(b"\0")
    if parts[-1] != b"" or (len(parts) - 1) % 2:
        raise ValueError("invalid NUL-delimited diff")
    return [{"status": parts[i].decode("ascii"), "path": parts[i + 1].decode("utf-8")}
            for i in range(0, len(parts) - 1, 2)]


def audit(root, candidate="HEAD", prefix="refs/remotes/origin/"):
    root = Path(root).resolve(strict=True)
    head = resolve(root, candidate)
    before = refs(root, prefix)
    rows = []
    for name, tip in before:
        counts = git(root, "rev-list", "--left-right", "--count", head + "..." + tip).decode().split()
        candidate_only, branch_only = map(int, counts)
        changes = tree_changes(root, head, tip)
        bases = git(root, "merge-base", "--all", head, tip, allowed=(0, 1)).decode().split()
        if not changes:
            relation = "same_tree"
        elif branch_only == 0:
            relation = "ancestor"
        elif candidate_only == 0:
            relation = "descendant"
        else:
            relation = "diverged" if bases else "unrelated"
        rows.append({
            "ref": name, "commit": tip, "mergeBases": bases,
            "candidateOnlyCommits": candidate_only, "branchOnlyCommits": branch_only,
            "relation": relation, "changedFileCount": len(changes), "changes": changes,
            "requiresDisposition": relation not in ("ancestor", "same_tree"),
            "evidenceTransfers": False,
        })
    if refs(root, prefix) != before or resolve(root, candidate) != head:
        raise ValueError("local refs changed during audit")
    result = {
        "kind": "BranchConvergenceAuditV1", "schemaVersion": 1,
        "scope": "local_fetched_public_git_objects_not_remote_or_production_attestation",
        "candidateCommit": head,
        "candidateTree": git(root, "rev-parse", head + "^{tree}").decode().strip(),
        "refNamespace": prefix, "branchCount": len(rows), "branches": rows,
        "unresolvedBranchCount": sum(row["requiresDisposition"] for row in rows),
        "automaticMerge": False, "productionActivationVerified": False,
        "policy": "Different trees require explicit absorb, supersede, retain-reference or reject decisions; equal trees do not transfer reviews or CI.",
    }
    canonical = json.dumps(result, sort_keys=True, separators=(",", ":")).encode()
    if len(canonical) > MAX_BYTES:
        raise ValueError("audit report exceeds byte bound")
    result["reportSha256"] = "sha256:" + hashlib.sha256(canonical).hexdigest()
    return result



def validate_disposition_plan(report, plan):
    """Validate exact source bindings, NOT the truth/independence of a review.

    The audit stays unresolved until external review accepts the dispositions.
    A digest-shaped reference, owner name or complete plan cannot grant approval.
    """
    required = {"kind", "schemaVersion", "candidateCommit", "candidateTree", "auditSha256", "decisions"}
    if not isinstance(plan, dict) or set(plan) != required:
        raise ValueError("closed disposition plan required")
    if plan["kind"] != "BranchDispositionPlanV1" or type(plan["schemaVersion"]) is not int or plan["schemaVersion"] != 1:
        raise ValueError("invalid disposition plan version")
    for field, actual in (("candidateCommit", report["candidateCommit"]), ("candidateTree", report["candidateTree"]), ("auditSha256", report["reportSha256"])):
        if plan[field] != actual:
            raise ValueError("stale disposition subject: " + field)
    decisions = plan["decisions"]
    if not isinstance(decisions, list) or len(decisions) > 4096:
        raise ValueError("disposition plan exceeds bound")
    expected = {row["ref"]: row for row in report["branches"] if row["requiresDisposition"]}
    seen = set()
    fields = {"ref", "commit", "decision", "changes", "owner", "rationale", "reviewEvidenceSha256"}
    for row in decisions:
        if not isinstance(row, dict) or set(row) != fields:
            raise ValueError("closed disposition record required")
        name = row["ref"]
        if not isinstance(name, str) or name not in expected or name in seen:
            raise ValueError("unknown, duplicate or unnecessary branch disposition")
        seen.add(name)
        baseline = expected[name]
        if row["commit"] != baseline["commit"] or row["changes"] != baseline["changes"]:
            raise ValueError("disposition must bind exact tip and all two-tree changes")
        if row["decision"] not in ("absorb", "supersede", "retain_reference", "reject"):
            raise ValueError("unknown disposition decision")
        for key, limit in (("owner", 128), ("rationale", 8192)):
            value = row[key]
            if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > limit or any(ord(c) < 32 for c in value):
                raise ValueError("invalid disposition " + key)
        evidence = row["reviewEvidenceSha256"]
        if not isinstance(evidence, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", evidence):
            raise ValueError("review evidence digest required, not a boolean approval")
    return {"kind": "BranchDispositionBindingCheckV1", "boundDecisionCount": len(seen),
            "unplannedRefs": sorted(set(expected) - seen),
            "dispositionBindingsComplete": set(expected) == seen,
            "independentReviewVerified": False, "automaticMerge": False,
            "productionActivationVerified": False}


def read_disposition_plan(path):
    import os
    import stat
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_BYTES:
            raise ValueError("invalid disposition plan file")
        raw = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
        if len(raw) > MAX_BYTES or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError("disposition plan changed while reading")
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError("duplicate JSON key in disposition plan")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("non-finite JSON value in disposition plan")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--candidate", default="HEAD")
    parser.add_argument("--ref-prefix", default="refs/remotes/origin/", choices=("refs/remotes/origin/", "refs/heads/"))
    parser.add_argument("--dispositions", help="external exact-audit disposition plan; no review authority inferred")
    parser.add_argument("--require-dispositions", action="store_true", help="exit 2 if source disposition bindings are incomplete")
    args = parser.parse_args()
    try:
        report = audit(args.root, args.candidate, args.ref_prefix)
        binding = validate_disposition_plan(report, read_disposition_plan(args.dispositions)) if args.dispositions else {
            "kind": "BranchDispositionBindingCheckV1", "boundDecisionCount": 0,
            "unplannedRefs": [row["ref"] for row in report["branches"] if row["requiresDisposition"]],
            "dispositionBindingsComplete": report["unresolvedBranchCount"] == 0,
            "independentReviewVerified": False, "automaticMerge": False,
            "productionActivationVerified": False,
        }
        print(json.dumps({"audit": report, "dispositions": binding} if args.dispositions or args.require_dispositions else report, indent=2))
        if args.require_dispositions and not binding["dispositionBindingsComplete"]:
            return 2
    except (ValueError, OSError, subprocess.TimeoutExpired, RecursionError) as error:
        print("branch-audit: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
