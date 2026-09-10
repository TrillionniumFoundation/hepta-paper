#!/usr/bin/env python3
"""v8 wrapper: prefer ordinary protected merge, then auto-merge fallback.

All source validation, CI stability, promotion and exact-review logic is inherited
from v7/v6. This wrapper only replaces the final `gh pr merge` invocation. The
REST merge endpoint is not an admin endpoint and cannot bypass branch protection.
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
from typing import Any

MODULE_PATH = pathlib.Path(__file__).with_name("converge_internal_source_v7.py")
spec = importlib.util.spec_from_file_location("internal_source_v7", MODULE_PATH)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load credential-safe convergence wrapper")
module: Any = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

original_run = module.module.run


def protected_merge_run(
    argv: list[str],
    *,
    cwd: pathlib.Path | None = None,
    timeout: int = 3600,
    capture: bool = True,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    if len(argv) >= 4 and argv[:3] == ["gh", "pr", "merge"]:
        pr_number = argv[3]
        try:
            repo = argv[argv.index("--repo") + 1]
            head = argv[argv.index("--match-head-commit") + 1]
        except (ValueError, IndexError) as exc:
            raise module.module.ConvergenceError("final merge invocation lacks exact repo/head binding") from exc
        api_argv = ["gh", "api", "-X", "PUT", f"repos/{repo}/pulls/{pr_number}/merge", "--input", "-"]
        print("+ gh api -X PUT protected pull merge (exact head)", flush=True)
        direct = subprocess.run(
            api_argv,
            input=json.dumps({"merge_method": "merge", "sha": head}, separators=(",", ":")),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=min(timeout, 600),
            check=False,
        )
        if direct.stdout:
            sys.stdout.write(direct.stdout)
        if direct.returncode == 0:
            try:
                value = json.loads(direct.stdout)
            except json.JSONDecodeError:
                value = {}
            if value.get("merged") is True:
                return subprocess.CompletedProcess(argv, 0, direct.stdout)
        print("ordinary protected merge not yet accepted; falling back to configured auto-merge", flush=True)
        return original_run(argv, cwd=cwd, timeout=timeout, capture=capture, check=check)
    return original_run(argv, cwd=cwd, timeout=timeout, capture=capture, check=check)


module.module.run = protected_merge_run

if __name__ == "__main__":
    try:
        raise SystemExit(module.module.main())
    except (
        module.module.ConvergenceError,
        module.module.subprocess.TimeoutExpired,
        OSError,
        module.module.json.JSONDecodeError,
    ) as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        raise SystemExit(1)
