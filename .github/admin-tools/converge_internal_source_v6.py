#!/usr/bin/env python3
"""Fail-closed convergence of the repository-owned source-closure wave.

The program is intentionally bounded to ten pre-audited repository-owned work items.
It never grants external authority, target-host qualification, production activation,
writer cutover, or Node retirement.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
from collections.abc import Iterable
from typing import Any

BLOB_SHAS = (
    "05d3b20d14cf05473ecca8da6a15b3919192fa87",
    "bb392f41843b9fc6c60404ca318b8dcc0fc42c27",
    "df468481fda2741158ba1279bb18669f40796f9a",
    "e95ae33a076d887e7de5b16e98cfdbf2bebb9771",
)
EXPECTED_PATHS = {
    "docs/system/evidence/repository-source-implementation-v1.json",
    "docs/system/schemas/source-implementation-evidence-v1.schema.json",
    "paper-core/bin/verify-source-implementation-evidence.mjs",
    "paper-core/tests/source-implementation-evidence.test.mjs",
}
REVIEWERS = {"Franksudoman", "Tomasrgbsf"}
MIN_WORKFLOW_FAMILIES = 16
MIN_CHECK_RUNS = 20
SUCCESS_CONCLUSIONS = {"success", "neutral", "skipped"}
EXTERNAL_PREFIXES = ("GAP-", "LEGACY-REPLAY-")


class ConvergenceError(RuntimeError):
    pass


def run(
    argv: list[str],
    *,
    cwd: pathlib.Path | None = None,
    timeout: int = 3600,
    capture: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(argv), flush=True)
    result = subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
        timeout=timeout,
        check=False,
    )
    if capture and result.stdout:
        sys.stdout.write(result.stdout)
        sys.stdout.flush()
    if check and result.returncode != 0:
        raise ConvergenceError(f"command failed ({result.returncode}): {' '.join(argv)}")
    return result


def output(argv: list[str], *, cwd: pathlib.Path | None = None, timeout: int = 300) -> str:
    return run(argv, cwd=cwd, timeout=timeout).stdout.strip()


def gh_json(repo: str, endpoint: str, *, method: str = "GET", fields: dict[str, Any] | None = None) -> Any:
    argv = ["gh", "api", f"repos/{repo}/{endpoint}"]
    if method != "GET":
        argv[2:2] = ["-X", method]
    input_bytes: str | None = None
    if fields is not None:
        input_bytes = json.dumps(fields, separators=(",", ":"))
        argv.extend(["--input", "-"])
    print("+", " ".join(argv), flush=True)
    result = subprocess.run(
        argv,
        input=input_bytes,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=300,
        check=False,
    )
    if result.returncode != 0:
        raise ConvergenceError(f"GitHub API failed ({endpoint}): {result.stdout}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ConvergenceError(f"non-JSON GitHub API response for {endpoint}") from exc


def gh_optional_json(repo: str, endpoint: str) -> Any | None:
    argv = ["gh", "api", f"repos/{repo}/{endpoint}"]
    result = subprocess.run(argv, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
    if result.returncode != 0:
        return None
    return json.loads(result.stdout)


def git_sha(repo_dir: pathlib.Path, rev: str = "HEAD") -> str:
    return output(["git", "rev-parse", rev], cwd=repo_dir)


def remote_sha(repo: str, branch: str) -> str:
    token = os.environ["GH_TOKEN"]
    remote = f"https://x-access-token:{token}@github.com/{repo}.git"
    text = output(["git", "ls-remote", remote, f"refs/heads/{branch}"])
    if not text:
        raise ConvergenceError(f"missing remote branch: {branch}")
    return text.split()[0]


def json_file(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def is_complete_promotion(repo_dir: pathlib.Path) -> tuple[bool, list[str]]:
    evidence_path = repo_dir / "docs/system/evidence/repository-source-implementation-v1.json"
    work_path = repo_dir / "docs/system/truth/work-items.v2.json"
    if not evidence_path.exists() or not work_path.exists():
        return False, []
    try:
        evidence = json_file(evidence_path)
        work = json_file(work_path)
    except (json.JSONDecodeError, OSError):
        return False, []
    records = evidence.get("records") if isinstance(evidence, dict) else None
    items = work.get("items") if isinstance(work, dict) else None
    if not isinstance(records, dict) or len(records) != 10 or not isinstance(items, dict):
        return False, []
    ids = sorted(records)
    if any(not isinstance(records[item_id], dict) for item_id in ids):
        return False, ids
    flags = [records[item_id].get("promotionRequested") for item_id in ids]
    if all(flag is False for flag in flags) and all(
        isinstance(items.get(item_id), dict) and items[item_id].get("state") == "source_implemented"
        for item_id in ids
    ):
        return True, ids
    if any(flag is False for flag in flags) and any(flag is True for flag in flags):
        raise ConvergenceError("partial promotion state is forbidden")
    return False, ids


def fetch_blob(repo: str, sha: str, destination: pathlib.Path) -> None:
    value = gh_json(repo, f"git/blobs/{sha}")
    if value.get("encoding") != "base64" or not isinstance(value.get("content"), str):
        raise ConvergenceError(f"unexpected blob response: {sha}")
    raw = base64.b64decode(value["content"], validate=False)
    destination.write_bytes(raw)
    computed = output(["git", "hash-object", str(destination)])
    if computed != sha:
        raise ConvergenceError(f"blob hash mismatch: expected={sha} actual={computed}")


def classify_blob(path: pathlib.Path) -> str:
    text = path.read_text(encoding="utf-8")
    value: Any = None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        pass
    if isinstance(value, dict) and value.get("kind") == "RepositorySourceImplementationEvidenceV1":
        return "docs/system/evidence/repository-source-implementation-v1.json"
    if isinstance(value, dict):
        properties = value.get("properties")
        if isinstance(properties, dict):
            kind = properties.get("kind")
            if isinstance(kind, dict) and kind.get("const") == "RepositorySourceImplementationEvidenceV1":
                return "docs/system/schemas/source-implementation-evidence-v1.schema.json"
    if "node:test" in text:
        return "paper-core/tests/source-implementation-evidence.test.mjs"
    if "parseStrictJson" in text or "source implementation evidence" in text.lower():
        return "paper-core/bin/verify-source-implementation-evidence.mjs"
    raise ConvergenceError(f"unclassified audited blob: {path.name}")


def materialize_audited_objects(repo: str, repo_dir: pathlib.Path, temp_dir: pathlib.Path) -> tuple[bool, list[str]]:
    already_promoted, prior_ids = is_complete_promotion(repo_dir)
    blob_dir = temp_dir / "blobs"
    shutil.rmtree(blob_dir, ignore_errors=True)
    blob_dir.mkdir(parents=True)
    mapping: dict[str, pathlib.Path] = {}
    for sha in BLOB_SHAS:
        blob_path = blob_dir / sha
        fetch_blob(repo, sha, blob_path)
        destination = classify_blob(blob_path)
        if destination in mapping:
            raise ConvergenceError(f"duplicate audited content class: {destination}")
        mapping[destination] = blob_path
    if set(mapping) != EXPECTED_PATHS:
        raise ConvergenceError(f"audited four-class mismatch: {sorted(mapping)}")
    for destination, source in mapping.items():
        if already_promoted and destination.endswith("repository-source-implementation-v1.json"):
            continue
        target = repo_dir / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    os.chmod(repo_dir / "paper-core/bin/verify-source-implementation-evidence.mjs", 0o755)
    return already_promoted, prior_ids


def validate_closed_evidence(repo_dir: pathlib.Path) -> list[str]:
    evidence = json_file(repo_dir / "docs/system/evidence/repository-source-implementation-v1.json")
    records = evidence.get("records") if isinstance(evidence, dict) else None
    if not isinstance(records, dict) or len(records) != 10:
        raise ConvergenceError("source evidence must contain exactly ten records")
    ids = sorted(records)
    requested = []
    for item_id in ids:
        record = records[item_id]
        if not isinstance(record, dict):
            raise ConvergenceError(f"record is not an object: {item_id}")
        if item_id.startswith(EXTERNAL_PREFIXES):
            raise ConvergenceError(f"external item in internal source wave: {item_id}")
        claims = record.get("authorityClaims")
        if not isinstance(claims, dict) or not claims or any(value is not False for value in claims.values()):
            raise ConvergenceError(f"invalid authority ceiling: {item_id}")
        flag = record.get("promotionRequested")
        if flag is True:
            requested.append(item_id)
        elif flag is not False:
            raise ConvergenceError(f"non-boolean promotion flag: {item_id}")
    if len(requested) not in (0, 10):
        raise ConvergenceError(f"partial promotion request set: {requested}")
    return ids


def validate_and_test(repo_dir: pathlib.Path, rust_log: pathlib.Path) -> None:
    commands = (
        ["node", "paper-core/bin/verify-source-implementation-evidence.mjs"],
        ["node", "--test", "paper-core/tests/source-implementation-evidence.test.mjs"],
        ["node", "docs/tools/validate-development-docs.mjs"],
        ["node", "docs/tools/validate-module-documentation.mjs"],
        ["python3", "docs/rust/tools/validate-program-truth.py"],
    )
    for command in commands:
        run(list(command), cwd=repo_dir, timeout=900)
    validate_closed_evidence(repo_dir)
    with rust_log.open("w", encoding="utf-8") as sink:
        print("+ cargo +1.98.0 test --locked --workspace --all-targets", flush=True)
        process = subprocess.Popen(
            ["cargo", "+1.98.0", "test", "--locked", "--workspace", "--all-targets"],
            cwd=repo_dir / "rust",
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        assert process.stdout is not None
        for line in process.stdout:
            sys.stdout.write(line)
            sink.write(line)
        returncode = process.wait(timeout=7200)
        if returncode != 0:
            raise ConvergenceError(f"Rust workspace owner-test superset failed: {returncode}")


def configure_git(repo_dir: pathlib.Path) -> None:
    run(["git", "config", "user.name", "Qian QI"], cwd=repo_dir)
    run(
        ["git", "config", "user.email", "102159240+ProfHepta@users.noreply.github.com"],
        cwd=repo_dir,
    )


def commit_and_cas_push(
    repo: str,
    repo_dir: pathlib.Path,
    branch: str,
    observed_sha: str,
    paths: Iterable[str],
    subject: str,
    body: str,
) -> tuple[str, str]:
    configure_git(repo_dir)
    run(["git", "add", "--", *paths], cwd=repo_dir)
    changed = bool(output(["git", "diff", "--cached", "--name-only"], cwd=repo_dir))
    if changed:
        run(
            [
                "git",
                "commit",
                "-m",
                subject,
                "-m",
                body,
                "-m",
                "Signed-off-by: Qian QI <102159240+ProfHepta@users.noreply.github.com>",
            ],
            cwd=repo_dir,
        )
        candidate = git_sha(repo_dir)
        result = run(
            [
                "git",
                "push",
                f"--force-with-lease=refs/heads/{branch}:{observed_sha}",
                "origin",
                f"HEAD:refs/heads/{branch}",
            ],
            cwd=repo_dir,
            timeout=600,
            check=False,
        )
        if result.returncode == 0:
            head = candidate
        else:
            live = remote_sha(repo, branch)
            run(["git", "fetch", "--no-tags", "origin", live], cwd=repo_dir, timeout=600)
            run(["git", "reset", "--hard", live], cwd=repo_dir)
            head = live
    else:
        head = git_sha(repo_dir)
    return head, git_sha(repo_dir, "HEAD^{tree}")


def find_open_main_pr(repo: str, branch: str) -> dict[str, Any] | None:
    pulls = gh_json(repo, f"pulls?state=open&head=TrillionniumFoundation:{branch}&base=main&per_page=20")
    if not isinstance(pulls, list):
        raise ConvergenceError("pull request query was not a list")
    return pulls[0] if pulls else None


def ensure_main_pr(repo: str, branch: str) -> int:
    existing = find_open_main_pr(repo, branch)
    if existing:
        return int(existing["number"])
    created = gh_json(
        repo,
        "pulls",
        method="POST",
        fields={
            "title": "feat(truth): converge repository source closure",
            "head": branch,
            "base": "main",
            "draft": True,
            "body": (
                "Full exact-head repository source-closure candidate. "
                "No external authority, target-host qualification, production activation, "
                "writer cutover, or Node retirement is granted."
            ),
        },
    )
    return int(created["number"])


def update_pr(repo: str, pr_number: int, body: str) -> None:
    gh_json(
        repo,
        f"pulls/{pr_number}",
        method="PATCH",
        fields={"title": "feat(truth): converge repository source closure", "body": body},
    )
    gh_json(
        repo,
        f"pulls/{pr_number}/requested_reviewers",
        method="POST",
        fields={"reviewers": sorted(REVIEWERS)},
    )


def check_snapshot(repo: str, pr_number: int, subject_head: str) -> dict[str, Any]:
    pr = gh_json(repo, f"pulls/{pr_number}")
    if pr.get("state") != "open":
        raise ConvergenceError(f"pull request is not open: {pr_number}")
    if pr.get("head", {}).get("sha") != subject_head:
        raise ConvergenceError("pull request head drifted")
    merge_sha = pr.get("merge_commit_sha")
    runs = gh_json(repo, f"actions/runs?head_sha={subject_head}&per_page=100").get("workflow_runs", [])
    selected_runs = []
    for item in runs:
        pull_numbers = {value.get("number") for value in item.get("pull_requests", []) if isinstance(value, dict)}
        if pr_number in pull_numbers:
            selected_runs.append(item)
    latest_runs: dict[str, dict[str, Any]] = {}
    for item in sorted(selected_runs, key=lambda value: value.get("created_at", "")):
        latest_runs[item.get("name", "")] = item
    checks: list[dict[str, Any]] = []
    for sha in dict.fromkeys(value for value in (subject_head, merge_sha) if isinstance(value, str) and value):
        response = gh_json(repo, f"commits/{sha}/check-runs?per_page=100")
        checks.extend(response.get("check_runs", []))
    latest_checks: dict[str, dict[str, Any]] = {}
    for item in sorted(checks, key=lambda value: (value.get("name", ""), int(value.get("id", 0)))):
        latest_checks[item.get("name", "")] = item
    run_values = list(latest_runs.values())
    check_values = list(latest_checks.values())
    return {
        "workflowFamilies": len(run_values),
        "workflowPending": sum(item.get("status") != "completed" for item in run_values),
        "workflowFailed": sum(
            item.get("status") == "completed" and item.get("conclusion") not in SUCCESS_CONCLUSIONS
            for item in run_values
        ),
        "checkRuns": len(check_values),
        "checkPending": sum(item.get("status") != "completed" for item in check_values),
        "checkFailed": sum(
            item.get("status") == "completed" and item.get("conclusion") not in SUCCESS_CONCLUSIONS
            for item in check_values
        ),
        "runs": [
            {
                "name": item.get("name"),
                "status": item.get("status"),
                "conclusion": item.get("conclusion"),
                "id": item.get("id"),
                "createdAt": item.get("created_at"),
            }
            for item in sorted(run_values, key=lambda value: value.get("name", ""))
        ],
        "checks": [
            {
                "name": item.get("name"),
                "status": item.get("status"),
                "conclusion": item.get("conclusion"),
                "id": item.get("id"),
                "headSha": item.get("head_sha"),
            }
            for item in sorted(check_values, key=lambda value: value.get("name", ""))
        ],
    }


def snapshot_fingerprint(snapshot: dict[str, Any]) -> str:
    compact = {
        "runs": [(item["name"], item["status"], item["conclusion"]) for item in snapshot["runs"]],
        "checks": [(item["name"], item["status"], item["conclusion"]) for item in snapshot["checks"]],
    }
    return hashlib.sha256(json.dumps(compact, sort_keys=True).encode()).hexdigest()


def wait_stable_ci(repo: str, pr_number: int, subject_head: str, label: str) -> dict[str, Any]:
    previous = ""
    stable = 0
    deadline = time.monotonic() + 9000
    latest: dict[str, Any] = {}
    while time.monotonic() < deadline:
        latest = check_snapshot(repo, pr_number, subject_head)
        good = (
            latest["workflowFamilies"] >= MIN_WORKFLOW_FAMILIES
            and latest["checkRuns"] >= MIN_CHECK_RUNS
            and latest["workflowPending"] == 0
            and latest["workflowFailed"] == 0
            and latest["checkPending"] == 0
            and latest["checkFailed"] == 0
        )
        fingerprint = snapshot_fingerprint(latest)
        if good:
            stable = stable + 1 if fingerprint == previous else 1
        else:
            stable = 0
        previous = fingerprint
        print(
            f"{label}: stable={stable} workflows={latest['workflowFamilies']} "
            f"pending={latest['workflowPending']} failed={latest['workflowFailed']} "
            f"checks={latest['checkRuns']} pending={latest['checkPending']} failed={latest['checkFailed']}",
            flush=True,
        )
        if stable >= 3:
            return latest
        time.sleep(30)
    raise ConvergenceError(f"{label} CI did not reach a stable green terminal snapshot")


def promote(repo_dir: pathlib.Path, receipt_path: pathlib.Path) -> dict[str, Any]:
    work_path = repo_dir / "docs/system/truth/work-items.v2.json"
    modules_path = repo_dir / "docs/system/truth/modules.v1.json"
    evidence_path = repo_dir / "docs/system/evidence/repository-source-implementation-v1.json"
    work = json_file(work_path)
    modules = json_file(modules_path)
    evidence = json_file(evidence_path)
    records = evidence.get("records")
    items = work.get("items")
    if not isinstance(records, dict) or len(records) != 10 or not isinstance(items, dict):
        raise ConvergenceError("closed evidence/work-item maps are missing")
    target_ids = sorted(records)
    requested = sorted(item_id for item_id in target_ids if records[item_id].get("promotionRequested") is True)
    if len(requested) not in (0, 10):
        raise ConvergenceError(f"partial promotion set: {requested}")
    already = len(requested) == 0
    promoted_modules: set[str] = set()
    for item_id in target_ids:
        record = records[item_id]
        row = items.get(item_id)
        if not isinstance(row, dict):
            raise ConvergenceError(f"missing work item: {item_id}")
        if item_id.startswith(EXTERNAL_PREFIXES) or row.get("type") == "external_gap":
            raise ConvergenceError(f"external item forbidden: {item_id}")
        if any(record.get("authorityClaims", {}).values()):
            raise ConvergenceError(f"authority escalation: {item_id}")
        if row.get("moduleId") != record.get("moduleId"):
            raise ConvergenceError(f"module mismatch: {item_id}")
        declared = row.get("capabilityIds")
        if declared is None and row.get("capabilityId") is not None:
            declared = [row["capabilityId"]]
        if sorted(declared or []) != sorted(record.get("capabilityIds", [])):
            raise ConvergenceError(f"capability mismatch: {item_id}")
        if already:
            if row.get("state") != "source_implemented":
                raise ConvergenceError(f"zero-request item is not promoted: {item_id}")
        else:
            if row.get("state") != "design_ready":
                raise ConvergenceError(f"promotion pre-state drift: {item_id}:{row.get('state')}")
            row["state"] = "source_implemented"
            record["promotionRequested"] = False
        promoted_modules.add(str(row["moduleId"]))

    changed_manifests: list[str] = []
    if not already:
        module_rows = modules.get("modules")
        if isinstance(module_rows, dict):
            for module_id in sorted(promoted_modules):
                remaining = [
                    row
                    for row in items.values()
                    if isinstance(row, dict)
                    and row.get("moduleId") == module_id
                    and row.get("state") in {"not_started", "design_ready"}
                ]
                module = module_rows.get(module_id)
                if not remaining and isinstance(module, dict) and module.get("state") == "design_ready":
                    module["state"] = "source_implemented"
        for path in sorted((repo_dir / "docs/modules/manifests").glob("*.json")):
            value = json_file(path)
            if not isinstance(value, dict) or value.get("moduleId") not in promoted_modules:
                continue
            module_id = value["moduleId"]
            remaining = [
                row
                for row in items.values()
                if isinstance(row, dict)
                and row.get("moduleId") == module_id
                and row.get("state") in {"not_started", "design_ready"}
            ]
            if remaining:
                continue
            changed = False
            for key in ("implementationStatus", "implementation_status", "sourceStatus"):
                if value.get(key) == "design_ready":
                    value[key] = "source_implemented"
                    changed = True
            implementation = value.get("implementation")
            if isinstance(implementation, dict) and implementation.get("status") == "design_ready":
                implementation["status"] = "source_implemented"
                changed = True
            if changed:
                path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                changed_manifests.append(path.relative_to(repo_dir).as_posix())
        work_path.write_text(json.dumps(work, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
        modules_path.write_text(
            json.dumps(modules, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8"
        )
        evidence_path.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    receipt = {
        "schemaVersion": 1,
        "kind": "InternalRepositorySourcePromotionV6",
        "promotedItemIds": target_ids,
        "alreadyPromoted": already,
        "promotedModuleIds": sorted(promoted_modules),
        "changedManifests": changed_manifests,
        "externalAuthorityGranted": False,
        "targetHostQualified": False,
        "productionActivated": False,
        "writerCutoverAuthorized": False,
        "nodeRetirementAuthorized": False,
    }
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt


def wait_exact_review(repo: str, pr_number: int, head: str) -> tuple[str, list[dict[str, Any]]]:
    deadline = time.monotonic() + 7200
    latest_reviews: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        values = gh_json(repo, f"pulls/{pr_number}/reviews?per_page=100")
        latest_reviews = [
            {
                "user": item.get("user", {}).get("login"),
                "state": item.get("state"),
                "commitId": item.get("commit_id"),
                "submittedAt": item.get("submitted_at"),
            }
            for item in values
        ]
        exact = [
            item
            for item in latest_reviews
            if item["user"] in REVIEWERS and item["state"] == "APPROVED" and item["commitId"] == head
        ]
        if exact:
            exact.sort(key=lambda item: item.get("submittedAt") or "")
            return str(exact[-1]["user"]), latest_reviews
        print("independent exact-head review: pending", flush=True)
        time.sleep(30)
    raise ConvergenceError("fresh independent exact-head approval did not arrive")


def write_status(repo: str, audit_branch: str, path: str, value: dict[str, Any]) -> None:
    raw = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    existing = gh_optional_json(repo, f"contents/{path}?ref={audit_branch}")
    fields: dict[str, Any] = {
        "message": "chore(admin): record verified internal source closure v6",
        "content": base64.b64encode(raw).decode(),
        "branch": audit_branch,
    }
    if isinstance(existing, dict) and isinstance(existing.get("sha"), str):
        fields["sha"] = existing["sha"]
    gh_json(repo, f"contents/{path}", method="PUT", fields=fields)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--audit-branch", required=True)
    parser.add_argument("--target-dir", required=True, type=pathlib.Path)
    parser.add_argument("--evidence-dir", required=True, type=pathlib.Path)
    args = parser.parse_args()

    repo_dir = args.target_dir.resolve()
    evidence_dir = args.evidence_dir.resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    observed = remote_sha(args.repo, args.source_branch)
    if git_sha(repo_dir) != observed:
        raise ConvergenceError("checkout is not the observed source branch head")

    already_promoted, _ = materialize_audited_objects(args.repo, repo_dir, evidence_dir)
    run(["git", "diff", "--check"], cwd=repo_dir)
    validate_and_test(repo_dir, evidence_dir / "first-rust.log")
    item_ids = validate_closed_evidence(repo_dir)
    first_head, first_tree = commit_and_cas_push(
        args.repo,
        repo_dir,
        args.source_branch,
        observed,
        EXPECTED_PATHS,
        "feat(truth): request strict internal source promotions",
        (
            "Bind exactly ten repository-owned items to audited source objects and the complete Rust owner-test "
            "superset while preserving all external and production authority ceilings."
        ),
    )

    # Adopt the winning concurrent first-stage head only after strict verification.
    if git_sha(repo_dir) != first_head:
        run(["git", "reset", "--hard", first_head], cwd=repo_dir)
    validate_closed_evidence(repo_dir)
    pr_number = ensure_main_pr(args.repo, args.source_branch)
    first_body = "\n".join(
        [
            "## Full exact-head repository source-closure candidate",
            "",
            "Base: main",
            f"Head branch: {args.source_branch}",
            f"First-stage head: {first_head}",
            f"First-stage tree: {first_tree}",
            "",
            "Closed evidence item set: " + ", ".join(item_ids),
            "",
            "Exact Git blobs, strict JSON/schema semantics, hostile tests, documentation owners, program truth, "
            "and the complete Rust 1.98.0 workspace with all targets passed before CAS publication.",
            "",
            "No external authority, target-host qualification, production activation, writer cutover, or Node "
            "retirement is granted. Final exact-head CI and an independent exact-head approval remain mandatory.",
        ]
    ) + "\n"
    update_pr(args.repo, pr_number, first_body)
    first_ci = wait_stable_ci(args.repo, pr_number, first_head, "first-stage")

    # Rebind to the exact winning first-stage head before promotion.
    live = remote_sha(args.repo, args.source_branch)
    if live != first_head:
        raise ConvergenceError(f"source branch advanced before promotion: expected={first_head} live={live}")
    run(["git", "reset", "--hard", live], cwd=repo_dir)
    promotion = promote(repo_dir, evidence_dir / "promotion.json")
    run(["git", "diff", "--check"], cwd=repo_dir)
    validate_and_test(repo_dir, evidence_dir / "final-rust.log")
    final_paths = [
        "docs/system/truth/work-items.v2.json",
        "docs/system/truth/modules.v1.json",
        "docs/system/evidence/repository-source-implementation-v1.json",
        "docs/modules/manifests",
    ]
    final_head, final_tree = commit_and_cas_push(
        args.repo,
        repo_dir,
        args.source_branch,
        first_head,
        final_paths,
        "feat(truth): promote verified internal source states",
        (
            "Promote exactly ten repository-owned work items after stable green main-target checks and a second "
            "complete Rust owner-test pass. Preserve every external and production authority ceiling."
        ),
    )
    complete, complete_ids = is_complete_promotion(repo_dir)
    if not complete or complete_ids != item_ids:
        raise ConvergenceError("final head is not the exact complete ten-item promotion")

    final_body = "\n".join(
        [
            "## Full exact-head repository source closure",
            "",
            "Base: main",
            f"Head branch: {args.source_branch}",
            f"Final head: {final_head}",
            f"Final tree: {final_tree}",
            "",
            "Promoted source work items: " + ", ".join(item_ids),
            "",
            f"First-stage gate: {first_ci['workflowFamilies']} stable workflow families and "
            f"{first_ci['checkRuns']} stable non-failing check runs.",
            "Strict evidence, hostile tests, documentation owners, program truth, and the complete Rust 1.98.0 "
            "workspace with all targets were replayed after promotion and before the final CAS push.",
            "",
            "No external authority, target-host qualification, production activation, writer cutover, or Node "
            "retirement is granted. A fresh independent approval must bind this final head before ordinary merge.",
        ]
    ) + "\n"
    update_pr(args.repo, pr_number, final_body)
    final_ci = wait_stable_ci(args.repo, pr_number, final_head, "final-stage")
    approver, reviews = wait_exact_review(args.repo, pr_number, final_head)

    status = {
        "schemaVersion": 1,
        "kind": "InternalRepositorySourceClosureStatusV6",
        "pullRequest": pr_number,
        "firstHead": first_head,
        "firstTree": first_tree,
        "finalHead": final_head,
        "finalTree": final_tree,
        "promotedItemIds": item_ids,
        "promotionWasAlreadyCompleteAtStart": already_promoted,
        "promotionReceipt": promotion,
        "firstCi": first_ci,
        "finalCi": final_ci,
        "reviews": reviews,
        "independentExactHeadApprover": approver,
        "allTerminalSuccess": True,
        "independentReviewAccepted": True,
        "externalAuthorityGranted": False,
        "targetHostQualified": False,
        "productionActivated": False,
        "writerCutoverAuthorized": False,
        "nodeRetirementAuthorized": False,
    }
    write_status(
        args.repo,
        args.audit_branch,
        ".github/admin-status/internal-source-main-closure-v6-20260911.json",
        status,
    )
    run(["gh", "pr", "ready", str(pr_number), "--repo", args.repo], check=False)
    # This is the ordinary protected path. It cannot bypass missing checks, approval, or branch policy.
    merge = run(
        [
            "gh",
            "pr",
            "merge",
            str(pr_number),
            "--repo",
            args.repo,
            "--merge",
            "--auto",
            "--match-head-commit",
            final_head,
        ],
        timeout=600,
        check=False,
    )
    if merge.returncode != 0:
        raise ConvergenceError("ordinary protected auto-merge request was rejected")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ConvergenceError, subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        raise SystemExit(1)
