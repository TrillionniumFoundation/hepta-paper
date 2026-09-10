#!/usr/bin/env python3
"""Security wrapper for converge_internal_source_v6.

It replaces ref resolution with the GitHub Ref API so credentials never enter a
process argument or log line. The imported v6 module remains the reviewed state
machine; no product authority ceiling is changed here.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
import urllib.parse
from typing import Any

MODULE_PATH = pathlib.Path(__file__).with_name("converge_internal_source_v6.py")
spec = importlib.util.spec_from_file_location("internal_source_v6", MODULE_PATH)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load convergence state machine")
module: Any = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def safe_remote_sha(repo: str, branch: str) -> str:
    encoded = urllib.parse.quote(branch, safe="")
    value = module.gh_json(repo, f"git/ref/heads/{encoded}")
    sha = value.get("object", {}).get("sha") if isinstance(value, dict) else None
    if not isinstance(sha, str) or len(sha) != 40:
        raise module.ConvergenceError(f"invalid remote ref object for {branch}")
    return sha


module.remote_sha = safe_remote_sha

if __name__ == "__main__":
    try:
        raise SystemExit(module.main())
    except (
        module.ConvergenceError,
        module.subprocess.TimeoutExpired,
        OSError,
        module.json.JSONDecodeError,
    ) as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        raise SystemExit(1)
