#!/usr/bin/env python3
"""Derive and apply repository-only Global Plan source state closure.

This administrative helper is executed from a non-candidate helper branch. It
mutates only the dedicated stacked source-closure branch and refuses to make any
external-authority or production-activation claim.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

EXPECTED_BASE_COMMIT = "38ccd556d4c741c5b0e25bd0941f419857ea314f"
EXPECTED_BASE_TREE = "3887089a102eb4414bac1e01085973d79ea1026d"
EXPECTED_TARGET_HEAD = "d90efa3bee65a782d276479aa003656ae035cdf4"
EXPECTED_PROMOTION_COUNT = 20

ROOT = Path(sys.argv[1]).resolve()
AUDIT = Path(sys.argv[2]).resolve()


def die(message: str) -> None:
    raise SystemExit("FAIL_SOURCE_CLOSURE: " + message)


def run(*args: str, cwd: Path = ROOT) -> str:
    proc = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        die("command failed: " + " ".join(args) + "\n" + proc.stdout + proc.stderr)
    return proc.stdout.strip()


def load(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def dump(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=False, ensure_ascii=False) + "\n", encoding="utf-8")


def walk(value: Any, key_path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], Any]]:
    yield key_path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from walk(child, key_path + (str(key),))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from walk(child, key_path + (str(index),))


def strings(value: Any) -> set[str]:
    return {child for _, child in walk(value) if isinstance(child, str)}


def source_implemented(value: Any) -> bool:
    for path, child in walk(value):
        if child != "source_implemented" or not path:
            continue
        joined = "".join(path).lower().replace("_", "").replace("-", "")
        if "status" in joined or "implementation" in joined or "state" in joined:
            return True
    return False


def path_strings(value: Any) -> set[str]:
    found: set[str] = set()
    for key_path, child in walk(value):
        if not isinstance(child, str):
            continue
        key = "".join(key_path).lower()
        if "/" in child and ("path" in key or "root" in key or "implementation" in key or "test" in key or "evidence" in key):
            found.add(child)
    return found


def file_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def representative_files(paths: set[str], module_slug: str) -> tuple[list[Path], list[Path]]:
    source: list[Path] = []
    tests: list[Path] = []
    extensions = {".rs", ".mjs", ".js", ".py", ".sh"}

    def classify(path: Path) -> None:
        if not path.is_file() or path.suffix not in extensions:
            return
        relative = path.relative_to(ROOT).as_posix()
        lowered = relative.lower()
        if lowered.startswith("docs/") or lowered.startswith(".github/"):
            return
        if "/tests/" in "/" + lowered or ".test." in lowered or path.name.startswith("test_"):
            tests.append(path)
        else:
            source.append(path)

    for raw in sorted(paths):
        candidate = ROOT / raw
        if candidate.is_file():
            classify(candidate)
        elif candidate.is_dir():
            for child in sorted(candidate.rglob("*")):
                classify(child)

    tokens = {module_slug, module_slug.replace("-", "_"), module_slug.replace("-", "")}
    for base in [ROOT / "paper-core/tests", ROOT / "migration/tests", ROOT / "rust/crates"]:
        if not base.is_dir():
            continue
        for child in sorted(base.rglob("*")):
            if not child.is_file() or child.suffix not in extensions:
                continue
            relative = child.relative_to(ROOT).as_posix().lower()
            name_hit = any(token and token in relative.replace("_", "-") for token in tokens)
            content_hit = False
            if not name_hit and child.stat().st_size <= 512_000:
                try:
                    text = child.read_text(encoding="utf-8", errors="ignore").lower()
                    content_hit = any(token and token in text for token in tokens)
                except OSError:
                    pass
            if name_hit or content_hit:
                classify(child)

    def unique(values: list[Path]) -> list[Path]:
        seen: set[str] = set()
        result: list[Path] = []
        for value in values:
            key = value.relative_to(ROOT).as_posix()
            if key not in seen:
                seen.add(key)
                result.append(value)
        return result

    return unique(source)[:6], unique(tests)[:6]


head = run("git", "rev-parse", "HEAD")
base = run("git", "rev-parse", "HEAD^")
base_tree = run("git", "rev-parse", "HEAD^^{tree}")
if head != EXPECTED_TARGET_HEAD:
    die(f"target branch moved: {head}")
if base != EXPECTED_BASE_COMMIT or base_tree != EXPECTED_BASE_TREE:
    die(f"unexpected source base: {base} / {base_tree}")

work_path = ROOT / "docs/system/truth/work-items.v2.json"
modules_path = ROOT / "docs/system/truth/modules.v1.json"
manifest_dir = ROOT / "docs/modules/manifests"
work_doc = load(work_path)
module_doc = load(modules_path)
items = work_doc.get("items")
if not isinstance(items, dict):
    die("work-items.v2.json items must be an object")

manifests: dict[str, tuple[Path, Any]] = {}
for path in sorted(manifest_dir.glob("*.json")):
    value = load(path)
    module_id = value.get("moduleId") if isinstance(value, dict) else None
    if isinstance(module_id, str):
        if module_id in manifests:
            die("duplicate module manifest: " + module_id)
        manifests[module_id] = (path, value)

module_rows = module_doc.get("modules") if isinstance(module_doc, dict) else None
if not isinstance(module_rows, dict):
    module_rows = {}

candidates: list[dict[str, Any]] = []
skipped: list[dict[str, Any]] = []
for item_id, row in sorted(items.items()):
    if not isinstance(row, dict) or row.get("state") != "design_ready":
        continue
    module_id = row.get("moduleId")
    capability_ids = row.get("capabilityIds") or ([] if row.get("capabilityId") is None else [row.get("capabilityId")])
    if not isinstance(module_id, str) or module_id not in manifests:
        skipped.append({"id": item_id, "reason": "missing_module_manifest", "moduleId": module_id})
        continue
    manifest_path, manifest = manifests[module_id]
    if not source_implemented(manifest):
        skipped.append({"id": item_id, "reason": "manifest_not_source_implemented", "moduleId": module_id})
        continue
    linked_strings = strings(manifest)
    linked = item_id in linked_strings or any(isinstance(cap, str) and cap in linked_strings for cap in capability_ids)
    if not linked:
        skipped.append({"id": item_id, "reason": "manifest_has_no_item_or_capability_link", "moduleId": module_id})
        continue
    paths = path_strings(manifest)
    if module_id in module_rows:
        paths |= path_strings(module_rows[module_id])
    slug = module_id.removeprefix("module.")
    source_files, test_files = representative_files(paths, slug)
    if not source_files or not test_files:
        skipped.append({
            "id": item_id,
            "reason": "missing_source_or_test_evidence",
            "moduleId": module_id,
            "sourceFiles": [p.relative_to(ROOT).as_posix() for p in source_files],
            "testFiles": [p.relative_to(ROOT).as_posix() for p in test_files],
        })
        continue
    candidates.append({
        "id": item_id,
        "moduleId": module_id,
        "capabilityIds": sorted(cap for cap in capability_ids if isinstance(cap, str)),
        "manifest": manifest_path.relative_to(ROOT).as_posix(),
        "sourceFiles": [p.relative_to(ROOT).as_posix() for p in source_files],
        "testFiles": [p.relative_to(ROOT).as_posix() for p in test_files],
    })

AUDIT.parent.mkdir(parents=True, exist_ok=True)
dump(AUDIT, {
    "schemaVersion": 1,
    "kind": "RepositorySourceClosureDerivationAuditV1",
    "baseCommit": EXPECTED_BASE_COMMIT,
    "baseTree": EXPECTED_BASE_TREE,
    "candidateCount": len(candidates),
    "candidates": candidates,
    "skipped": skipped,
})
if len(candidates) != EXPECTED_PROMOTION_COUNT:
    die(f"expected {EXPECTED_PROMOTION_COUNT} promotions, derived {len(candidates)}")

false_authority = {
    "targetHostQualified": False,
    "externalAuthorityGranted": False,
    "productionActivated": False,
    "writerCutoverAuthorized": False,
    "nodeRetirementAuthorized": False,
}
bundles: dict[str, Any] = {}
records: dict[str, Any] = {}
for candidate in candidates:
    item_id = candidate["id"]
    bundle_id = "bundle." + re.sub(r"[^a-z0-9]+", "-", item_id.lower()).strip("-")
    file_rows = []
    for role, names in (("implementation", candidate["sourceFiles"]), ("test", candidate["testFiles"])):
        for name in names:
            path = ROOT / name
            file_rows.append({
                "path": name,
                "role": role,
                "sha256": file_hash(path),
                "bytes": path.stat().st_size,
            })
    bundles[bundle_id] = {
        "moduleManifest": candidate["manifest"],
        "files": file_rows,
        "verificationCommands": [
            "node docs/tools/validate-development-docs.mjs",
            "node docs/tools/validate-module-documentation.mjs",
            "python3 docs/rust/tools/validate-program-truth.py",
            "node docs/tools/validate-source-implementation-evidence.mjs",
            "node --test paper-core/tests/source-implementation-evidence.test.mjs",
        ],
    }
    records[item_id] = {
        "moduleId": candidate["moduleId"],
        "capabilityIds": candidate["capabilityIds"],
        "evidenceTier": "source",
        "bundleIds": [bundle_id],
        "authorityClaims": dict(false_authority),
    }
    items[item_id]["state"] = "source_implemented"

schema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": False,
    "required": ["schemaVersion", "kind", "baseCommit", "baseTree", "promotionPolicy", "promotedItemIds", "bundles", "records"],
    "properties": {
        "schemaVersion": {"const": 1},
        "kind": {"const": "RepositorySourceImplementationEvidenceV1"},
        "baseCommit": {"pattern": "^[0-9a-f]{40}$"},
        "baseTree": {"pattern": "^[0-9a-f]{40}$"},
        "promotionPolicy": {"const": "exact_tree_ci_plus_required_source_and_test_hashes"},
        "promotedItemIds": {"type": "array", "minItems": 1, "uniqueItems": True, "items": {"type": "string"}},
        "bundles": {"type": "object", "minProperties": 1},
        "records": {"type": "object", "minProperties": 1},
    },
}
evidence = {
    "schemaVersion": 1,
    "kind": "RepositorySourceImplementationEvidenceV1",
    "baseCommit": EXPECTED_BASE_COMMIT,
    "baseTree": EXPECTED_BASE_TREE,
    "promotionPolicy": "exact_tree_ci_plus_required_source_and_test_hashes",
    "promotedItemIds": [candidate["id"] for candidate in candidates],
    "bundles": bundles,
    "records": records,
}

dump(ROOT / "docs/system/schemas/source-implementation-evidence-v1.schema.json", schema)
dump(ROOT / "docs/system/truth/source-implementation-evidence.v1.json", evidence)
dump(work_path, work_doc)

validator = r'''#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const root = path.resolve(value('--root', process.cwd()));
const evidencePath = path.resolve(value('--evidence', path.join(root, 'docs/system/truth/source-implementation-evidence.v1.json')));
const workPath = path.resolve(value('--work-items', path.join(root, 'docs/system/truth/work-items.v2.json')));
const load = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = (message) => { throw new Error(`source implementation evidence: ${message}`); };
const digest = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
const evidence = load(evidencePath);
const work = load(workPath);
if (evidence.schemaVersion !== 1 || evidence.kind !== 'RepositorySourceImplementationEvidenceV1') fail('schema identity');
if (!/^[0-9a-f]{40}$/.test(evidence.baseCommit) || !/^[0-9a-f]{40}$/.test(evidence.baseTree)) fail('base identity');
if (evidence.promotionPolicy !== 'exact_tree_ci_plus_required_source_and_test_hashes') fail('promotion policy');
const promoted = evidence.promotedItemIds;
if (!Array.isArray(promoted) || promoted.length === 0 || new Set(promoted).size !== promoted.length) fail('promotion set');
if (JSON.stringify([...promoted].sort()) !== JSON.stringify(Object.keys(evidence.records).sort())) fail('record coverage');
for (const itemId of promoted) {
  const item = work.items?.[itemId];
  const record = evidence.records[itemId];
  if (!item || item.state !== 'source_implemented') fail(`${itemId} state`);
  if (record.moduleId !== item.moduleId) fail(`${itemId} module`);
  const itemCaps = [...(item.capabilityIds ?? (item.capabilityId ? [item.capabilityId] : []))].sort();
  if (JSON.stringify([...record.capabilityIds].sort()) !== JSON.stringify(itemCaps)) fail(`${itemId} capabilities`);
  if (!Array.isArray(record.bundleIds) || record.bundleIds.length === 0) fail(`${itemId} bundles`);
  for (const claim of Object.values(record.authorityClaims ?? {})) if (claim !== false) fail(`${itemId} authority`);
  for (const bundleId of record.bundleIds) {
    const bundle = evidence.bundles[bundleId];
    if (!bundle) fail(`${itemId} missing ${bundleId}`);
    const roles = new Set();
    for (const row of bundle.files ?? []) {
      const file = path.resolve(root, row.path);
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile()) fail(`${itemId} file ${row.path}`);
      if (!['implementation', 'test'].includes(row.role)) fail(`${itemId} role`);
      roles.add(row.role);
      if (fs.statSync(file).size !== row.bytes || digest(file) !== row.sha256) fail(`${itemId} hash ${row.path}`);
    }
    if (!roles.has('implementation') || !roles.has('test')) fail(`${itemId} source/test roles`);
    if (!Array.isArray(bundle.verificationCommands) || bundle.verificationCommands.length === 0) fail(`${itemId} commands`);
  }
}
console.log(JSON.stringify({status:'PASS_SOURCE_IMPLEMENTATION_EVIDENCE', promoted: promoted.length, authorityGranted:false}));
'''
validator_path = ROOT / "docs/tools/validate-source-implementation-evidence.mjs"
validator_path.write_text(validator, encoding="utf-8")

test = r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const validator = path.join(root, 'docs/tools/validate-source-implementation-evidence.mjs');
const evidencePath = path.join(root, 'docs/system/truth/source-implementation-evidence.v1.json');
const run = (extra=[]) => spawnSync(process.execPath, [validator, '--root', root, ...extra], {encoding:'utf8'});

test('repository source implementation evidence validates', () => {
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'PASS_SOURCE_IMPLEMENTATION_EVIDENCE');
  assert.equal(value.authorityGranted, false);
});

test('source evidence rejects a substituted implementation hash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-source-evidence-'));
  try {
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    const bundle = evidence.bundles[Object.keys(evidence.bundles)[0]];
    bundle.files[0].sha256 = 'sha256:' + '0'.repeat(64);
    const hostile = path.join(tmp, 'hostile.json');
    fs.writeFileSync(hostile, JSON.stringify(evidence));
    const result = run(['--evidence', hostile]);
    assert.notEqual(result.status, 0);
  } finally {
    fs.rmSync(tmp, {recursive:true, force:true});
  }
});
'''
test_path = ROOT / "paper-core/tests/source-implementation-evidence.test.mjs"
test_path.write_text(test, encoding="utf-8")

run("node", "docs/tools/validate-development-docs.mjs")
run("node", "docs/tools/validate-module-documentation.mjs")
run("python3", "docs/rust/tools/validate-program-truth.py")
run("node", "docs/tools/validate-source-implementation-evidence.mjs")
run("node", "--test", "paper-core/tests/source-implementation-evidence.test.mjs")
run("git", "diff", "--check")
print(json.dumps({"status": "PASS_SOURCE_CLOSURE_DERIVATION", "promoted": len(candidates), "ids": [c["id"] for c in candidates]}, sort_keys=True))
