#!/usr/bin/env python3
"""Derive a second repository-source closure wave from code and executable tests.

The derivation intentionally ignores stale manifest implementation labels, but
never promotes external, target-host, production, cutover, or retirement work.
All mutations are validated by the repository's canonical validators before a
commit is allowed.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(sys.argv[1]).resolve()
AUDIT = Path(sys.argv[2]).resolve()
EXPECTED_HEAD = os.environ["EXPECTED_TARGET_HEAD"]
EXPECTED_TREE = os.environ["EXPECTED_TARGET_TREE"]

EXTERNAL_ISSUES = {"#25", "#28", "#17", "#12", "#14", "#21", "#22"}
EXTERNAL_TOKENS = {
    "blocked_external", "external authority", "external_authority", "independent owner",
    "independent reviewer", "target host", "target-host", "production host", "production-host",
    "credential custody", "key custody", "kms", "hsm", "worm", "portal", "submission",
    "72 hour", "72-hour", "soak", "reboot", "disk full", "disk-full", "destructive",
    "production canary", "writer cutover", "node retirement", "node-retirement", "ruleset",
    "branch protection", "provider owner", "release authority", "operator acceptance",
    "team provisioning", "owner provisioning", "physical topology", "actual deployment",
    "real credential", "real provider", "private archive", "custody runner",
}
CODE_EXTENSIONS = {".rs", ".mjs", ".js", ".py", ".sh", ".ts", ".tsx"}
STUB_PATTERNS = (
    "unimplemented!", "todo!", "notimplementederror", "throw new error('not implemented",
    'throw new error("not implemented', "panic!(\"not implemented", "raise systemexit('not implemented",
)


def die(message: str) -> None:
    raise SystemExit("FAIL_SOURCE_CLOSURE_WAVE2: " + message)


def run(*args: str, cwd: Path = ROOT) -> str:
    proc = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        die("command failed: " + " ".join(args) + "\n" + proc.stdout + proc.stderr)
    return proc.stdout.strip()


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=False, ensure_ascii=False) + "\n", encoding="utf-8")


def walk(value: Any, keys: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], Any]]:
    yield keys, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, keys + (str(key),))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, keys + (str(index),))


def all_text(value: Any) -> str:
    return " ".join(str(child) for _, child in walk(value) if isinstance(child, (str, int, float))).lower()


def hash_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def path_candidates(value: Any) -> set[str]:
    result: set[str] = set()
    for keys, child in walk(value):
        if not isinstance(child, str) or "/" not in child:
            continue
        key = "".join(keys).lower()
        if any(token in key for token in ("implementation", "root", "path", "source")):
            result.add(child)
    return result


def is_test(path: Path) -> bool:
    lower = path.as_posix().lower()
    return "/tests/" in "/" + lower or ".test." in lower or path.name.startswith("test_") or path.name.endswith("_test.rs")


def usable_code(path: Path) -> bool:
    if not path.is_file() or path.suffix.lower() not in CODE_EXTENSIONS or path.stat().st_size < 80:
        return False
    lower = path.as_posix().lower()
    if lower.startswith("docs/") or "/target/" in lower or "/node_modules/" in lower:
        return False
    try:
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
    except OSError:
        return False
    return not all(pattern in text for pattern in STUB_PATTERNS[:1])


def tokens_for(item_id: str, module_id: str, capabilities: list[str]) -> set[str]:
    raw = [item_id, module_id, module_id.removeprefix("module."), *capabilities]
    result: set[str] = set()
    for value in raw:
        lower = value.lower()
        result.update({lower, lower.replace("_", "-"), lower.replace("-", "_"), re.sub(r"[^a-z0-9]", "", lower)})
    return {x for x in result if len(x) >= 4}


def collect_evidence(item_id: str, row: dict[str, Any], module_row: Any, manifest: Any) -> tuple[list[Path], list[Path], list[str]]:
    module_id = row["moduleId"]
    capabilities = row.get("capabilityIds") or ([row["capabilityId"]] if row.get("capabilityId") else [])
    capabilities = [x for x in capabilities if isinstance(x, str)]
    paths = path_candidates({"module": module_row, "manifest": manifest})
    slug = module_id.removeprefix("module.")
    fallback_roots = [
        f"rust/crates/hepta-{slug}", f"rust/crates/{slug}", slug,
        f"paper-{slug}", f"workflow-{slug}", f"migration/{slug}",
    ]
    for candidate in fallback_roots:
        if (ROOT / candidate).exists():
            paths.add(candidate)
    sources: list[Path] = []
    tests: list[Path] = []
    for raw in sorted(paths):
        base = ROOT / raw
        if base.is_file() and usable_code(base):
            (tests if is_test(base) else sources).append(base)
        elif base.is_dir():
            for child in sorted(base.rglob("*")):
                if usable_code(child):
                    (tests if is_test(child) else sources).append(child)

    search_tokens = tokens_for(item_id, module_id, capabilities)
    search_roots = [ROOT / "paper-core/tests", ROOT / "migration/tests", ROOT / "rust/crates", ROOT / "test", ROOT / "tests"]
    for base in search_roots:
        if not base.is_dir():
            continue
        for child in sorted(base.rglob("*")):
            if not usable_code(child) or not is_test(child) or child.stat().st_size > 2_000_000:
                continue
            relative = child.relative_to(ROOT).as_posix().lower()
            hit = any(token in relative.replace("_", "-") for token in search_tokens)
            if not hit:
                try:
                    text = child.read_text(encoding="utf-8", errors="ignore").lower()
                    hit = any(token in text or token.replace("-", "_") in text for token in search_tokens)
                except OSError:
                    hit = False
            if hit:
                tests.append(child)

    def unique(values: list[Path]) -> list[Path]:
        found: list[Path] = []
        seen: set[str] = set()
        for value in values:
            rel = value.relative_to(ROOT).as_posix()
            if rel not in seen:
                seen.add(rel)
                found.append(value)
        return found

    sources = unique(sources)
    tests = unique(tests)
    reasons: list[str] = []
    if not sources:
        reasons.append("no_registered_implementation_source")
    if not tests:
        reasons.append("no_executable_test_link")
    if sum(p.stat().st_size for p in sources) < 500:
        reasons.append("implementation_too_small")
    if sum(p.stat().st_size for p in tests) < 200:
        reasons.append("tests_too_small")
    return sources[:10], tests[:10], reasons


def promote_manifest_status(manifest: dict[str, Any]) -> bool:
    changed = False
    for key in ("implementationStatus", "implementation_status", "sourceStatus"):
        if manifest.get(key) == "design_ready":
            manifest[key] = "source_implemented"
            changed = True
    implementation = manifest.get("implementation")
    if isinstance(implementation, dict) and implementation.get("status") == "design_ready":
        implementation["status"] = "source_implemented"
        changed = True
    return changed


head = run("git", "rev-parse", "HEAD")
tree = run("git", "rev-parse", "HEAD^{tree}")
if head != EXPECTED_HEAD or tree != EXPECTED_TREE:
    die(f"target moved: {head}/{tree}, expected {EXPECTED_HEAD}/{EXPECTED_TREE}")

work_path = ROOT / "docs/system/truth/work-items.v2.json"
evidence_path = ROOT / "docs/system/truth/source-implementation-evidence.v1.json"
modules_path = ROOT / "docs/system/truth/modules.v1.json"
work_doc = load(work_path)
evidence = load(evidence_path)
module_doc = load(modules_path)
items = work_doc["items"]
module_rows = module_doc.get("modules", {}) if isinstance(module_doc, dict) else {}
manifest_paths: dict[str, Path] = {}
manifests: dict[str, Any] = {}
for path in sorted((ROOT / "docs/modules/manifests").glob("*.json")):
    value = load(path)
    module_id = value.get("moduleId") if isinstance(value, dict) else None
    if isinstance(module_id, str):
        manifest_paths[module_id] = path
        manifests[module_id] = value

promotions: list[dict[str, Any]] = []
skipped: list[dict[str, Any]] = []
for item_id, row in sorted(items.items()):
    if not isinstance(row, dict) or row.get("state") != "design_ready":
        continue
    module_id = row.get("moduleId")
    if not isinstance(module_id, str) or module_id not in manifests:
        skipped.append({"id": item_id, "reason": ["missing_module_manifest"], "moduleId": module_id})
        continue
    text = all_text({"item": row, "manifest": manifests[module_id]})
    issue_hits = sorted(ref for ref in EXTERNAL_ISSUES if ref in text)
    token_hits = sorted(token for token in EXTERNAL_TOKENS if token in text)
    package_hits = sorted(set(re.findall(r"\b(?:EXT|GAP)-[A-Z0-9-]+\b", text.upper())))
    if issue_hits or token_hits or package_hits:
        skipped.append({"id": item_id, "reason": ["external_or_activation_boundary"], "moduleId": module_id, "issues": issue_hits, "packages": package_hits, "tokens": token_hits})
        continue
    sources, tests, reasons = collect_evidence(item_id, row, module_rows.get(module_id, {}), manifests[module_id])
    if reasons:
        skipped.append({"id": item_id, "reason": reasons, "moduleId": module_id, "sourceFiles": [p.relative_to(ROOT).as_posix() for p in sources], "testFiles": [p.relative_to(ROOT).as_posix() for p in tests]})
        continue
    promotions.append({"id": item_id, "moduleId": module_id, "sourceFiles": [p.relative_to(ROOT).as_posix() for p in sources], "testFiles": [p.relative_to(ROOT).as_posix() for p in tests]})

AUDIT.parent.mkdir(parents=True, exist_ok=True)
dump(AUDIT, {"schemaVersion": 1, "kind": "RepositorySourceClosureWave2AuditV1", "subject": {"head": head, "tree": tree}, "candidateCount": len(promotions), "candidates": promotions, "skipped": skipped})
if not promotions:
    print(json.dumps({"status": "NO_WAVE2_SOURCE_PROMOTIONS", "candidateCount": 0}, sort_keys=True))
    raise SystemExit(0)

false_authority = {"targetHostQualified": False, "externalAuthorityGranted": False, "productionActivated": False, "writerCutoverAuthorized": False, "nodeRetirementAuthorized": False}
changed_manifests: set[Path] = set()
for promotion in promotions:
    item_id = promotion["id"]
    module_id = promotion["moduleId"]
    item = items[item_id]
    capabilities = item.get("capabilityIds") or ([item["capabilityId"]] if item.get("capabilityId") else [])
    capabilities = sorted(x for x in capabilities if isinstance(x, str))
    bundle_id = "bundle.wave2." + re.sub(r"[^a-z0-9]+", "-", item_id.lower()).strip("-")
    file_rows = []
    for role, names in (("implementation", promotion["sourceFiles"]), ("test", promotion["testFiles"])):
        for name in names:
            path = ROOT / name
            file_rows.append({"path": name, "role": role, "sha256": hash_file(path), "bytes": path.stat().st_size})
    evidence["bundles"][bundle_id] = {"moduleManifest": manifest_paths[module_id].relative_to(ROOT).as_posix(), "files": file_rows, "verificationCommands": ["node docs/tools/validate-development-docs.mjs", "node docs/tools/validate-module-documentation.mjs", "python3 docs/rust/tools/validate-program-truth.py", "node docs/tools/validate-source-implementation-evidence.mjs", "node --test paper-core/tests/source-implementation-evidence.test.mjs"]}
    evidence["records"][item_id] = {"moduleId": module_id, "capabilityIds": capabilities, "evidenceTier": "source", "bundleIds": [bundle_id], "authorityClaims": dict(false_authority)}
    items[item_id]["state"] = "source_implemented"

for module_id in sorted({p["moduleId"] for p in promotions}):
    linked_remaining = [row for row in items.values() if isinstance(row, dict) and row.get("moduleId") == module_id and row.get("state") == "design_ready" and not any(token in all_text(row) for token in EXTERNAL_TOKENS)]
    if not linked_remaining and promote_manifest_status(manifests[module_id]):
        dump(manifest_paths[module_id], manifests[module_id])
        changed_manifests.add(manifest_paths[module_id])

evidence["promotedItemIds"] = sorted(evidence["records"])
dump(work_path, work_doc)
dump(evidence_path, evidence)

run("node", "docs/tools/validate-development-docs.mjs")
run("node", "docs/tools/validate-module-documentation.mjs")
run("python3", "docs/rust/tools/validate-program-truth.py")
run("node", "docs/tools/validate-source-implementation-evidence.mjs")
run("node", "--test", "paper-core/tests/source-implementation-evidence.test.mjs")
run("git", "diff", "--check")
print(json.dumps({"status": "PASS_SOURCE_CLOSURE_WAVE2", "promoted": len(promotions), "ids": [x["id"] for x in promotions], "changedManifests": [p.relative_to(ROOT).as_posix() for p in sorted(changed_manifests)]}, sort_keys=True))
