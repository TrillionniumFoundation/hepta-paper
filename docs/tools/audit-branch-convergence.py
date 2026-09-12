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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--candidate", default="HEAD")
    parser.add_argument("--ref-prefix", default="refs/remotes/origin/", choices=("refs/remotes/origin/", "refs/heads/"))
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.root, args.candidate, args.ref_prefix), indent=2))
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        print("branch-audit: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
