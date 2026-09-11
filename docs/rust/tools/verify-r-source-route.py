#!/usr/bin/env python3
"""Verify the repository-owned public R source route without granting acceptance.

The verifier proves content identity for one historical subtree and its current
materializer binding. It deliberately does not claim that the inaccessible
external gitlink commit has been fetched or is equivalent to this route.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ROUTE = ROOT / "docs/rust/qualification/r-source-route.v1.json"
DEFAULT_SCHEMA = ROOT / "docs/rust/qualification/r-source-route.v1.schema.json"
MAX_JSON_BYTES = 1024 * 1024
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")

sys.path.insert(0, str(ROOT / "docs/rust/tools"))
from strict_json_schema import strict_json_loads, validate as validate_schema  # noqa: E402


def fail(code: str) -> None:
    raise ValueError(code)


def read_json(path: Path) -> Any:
    with path.open("rb") as stream:
        raw = stream.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        fail("r_source_route_json_byte_limit")
    return strict_json_loads(raw.decode("utf-8"))


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    environment = {
        "PATH": "/usr/bin:/bin",
        "HOME": "/nonexistent",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_OPTIONAL_LOCKS": "0",
    }
    return subprocess.run(
        ["/usr/bin/git", "-c", "core.hooksPath=/dev/null",
         "-c", "core.fsmonitor=false", *args],
        cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=30, check=check, env=environment,
    )


def load_materializer(path: Path):
    if path.is_symlink() or not path.is_file() or path.resolve() != path:
        fail("r_source_route_materializer_path_unsafe")
    specification = importlib.util.spec_from_file_location(
        "hepta_public_r_source_materializer", path)
    if specification is None or specification.loader is None:
        fail("r_source_route_materializer_unloadable")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def verify_route(root: Path, route: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    if root.resolve() != root or not (root / ".git").exists():
        fail("r_source_route_repository_root_invalid")
    validate_schema(route, schema)
    before = git(root, "status", "--porcelain=v1", "--untracked-files=all").stdout
    if before:
        fail("r_source_route_worktree_not_clean")

    target = route["targetPath"]
    original = route["originalGitlink"]["commit"]
    historical = route["publicHistoricalRoute"]
    if not all(GIT_SHA.fullmatch(value) for value in (
        original, historical["commit"], historical["subtree"],
        historical["manifestBlob"],
    )):
        fail("r_source_route_git_identity_invalid")

    row = git(root, "ls-tree", "HEAD", "--", target).stdout.rstrip("\n")
    match = re.fullmatch(r"160000 commit ([0-9a-f]{40})\t(.+)", row)
    if match is None or match.group(1) != original or match.group(2) != target:
        fail("r_source_route_current_gitlink_drift")

    selected = git(root, "rev-parse", f"{historical['commit']}:{historical['path']}").stdout.strip()
    if selected != historical["subtree"]:
        fail("r_source_route_historical_subtree_drift")
    if git(root, "cat-file", "-t", selected).stdout.strip() != "tree":
        fail("r_source_route_historical_object_not_tree")

    materializer_path = root / route["materializer"]["path"]
    materializer = load_materializer(materializer_path)
    bindings = {
        "PUBLIC_TREE": historical["subtree"],
        "MANIFEST_BLOB": historical["manifestBlob"],
        "TARGET": target,
    }
    for name, expected in bindings.items():
        if getattr(materializer, name, None) != expected:
            fail(f"r_source_route_materializer_binding_drift:{name}")
    if Path(getattr(materializer, "ROOT", "")).resolve() != root:
        fail("r_source_route_materializer_root_drift")

    files = materializer.capture(root)
    if len(files) != historical["fileCount"]:
        fail("r_source_route_file_count_drift")
    manifest_bytes = files.get("manifest.json")
    if not isinstance(manifest_bytes, bytes):
        fail("r_source_route_manifest_missing")
    git_blob = hashlib.sha1(
        b"blob " + str(len(manifest_bytes)).encode("ascii") + b"\0" + manifest_bytes
    ).hexdigest()
    if git_blob != historical["manifestBlob"]:
        fail("r_source_route_manifest_blob_drift")
    manifest = strict_json_loads(manifest_bytes.decode("utf-8"))
    if manifest.get("packageCount") != historical["packageCount"] \
            or len(manifest.get("packages", [])) != historical["packageCount"]:
        fail("r_source_route_package_count_drift")

    after = git(root, "status", "--porcelain=v1", "--untracked-files=all").stdout
    if after != before:
        fail("r_source_route_verification_mutated_worktree")
    head = git(root, "rev-parse", "HEAD").stdout.strip()
    tree = git(root, "rev-parse", "HEAD^{tree}").stdout.strip()
    return {
        "schemaVersion": 1,
        "kind": "HeptaRSourceRouteVerificationV1",
        "status": "public_historical_source_content_verified_nonactivating",
        "repository": route["repository"],
        "source": {"commit": head, "tree": tree},
        "routeSha256": sha256(canonical(route)),
        "historical": {
            "commit": historical["commit"],
            "subtree": historical["subtree"],
            "manifestBlob": historical["manifestBlob"],
            "fileCount": len(files),
            "packageCount": historical["packageCount"],
        },
        "originalGitlink": {
            "commit": original,
            "presentInCurrentTree": True,
            "commitObjectFetchedAndVerified": False,
            "equivalenceClaimed": False,
        },
        "currentBuildClosureVerified": False,
        "independentAcceptance": False,
        "targetHostQualified": False,
        "productionAuthorized": False,
        "externalAuthorityClaimed": False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--route", type=Path, default=DEFAULT_ROUTE)
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    route = read_json(args.route.resolve())
    schema = read_json(args.schema.resolve())
    result = verify_route(root, route, schema)
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, UnicodeError, ValueError, subprocess.SubprocessError) as error:
        print(f"R source route not verified: {error}", file=sys.stderr)
        raise SystemExit(1)
