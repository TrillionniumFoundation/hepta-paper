#!/usr/bin/env python3
"""Collect one complete, latest, exact-head GitHub check-run matrix."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time
from typing import Any
import urllib.error
import urllib.request


def fail(message: str) -> None:
    raise ValueError(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument(
        "--required-checks",
        default="docs/rust/qualification/source-required-checks.v1.json",
        type=Path,
    )
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def fetch_page(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hepta-rust-required-check-collector",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            value = json.load(response)
    except (urllib.error.URLError, TimeoutError) as error:
        fail(f"check_run_api_failed:{error}")
    if not isinstance(value, dict):
        fail("check_run_api_object_required")
    return value


def fetch_all(api_url: str, repository: str, commit: str, token: str) -> dict[str, Any]:
    runs: list[dict[str, Any]] = []
    page = 1
    reported_total = 0
    while True:
        value = fetch_page(
            f"{api_url.rstrip('/')}/repos/{repository}/commits/{commit}/check-runs"
            f"?per_page=100&page={page}",
            token,
        )
        current = value.get("check_runs")
        if not isinstance(current, list) or any(not isinstance(row, dict) for row in current):
            fail("check_run_api_shape_invalid")
        reported_total = int(value.get("total_count", len(current)))
        runs.extend(current)
        if len(current) < 100:
            break
        page += 1
        if page > 20:
            fail("check_run_api_pagination_overflow")
    return {"total_count": reported_total, "check_runs": runs}


def latest_required(
    payload: dict[str, Any],
    contexts: list[str],
    commit: str,
    required_app_id: int,
) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for run in payload["check_runs"]:
        name = run.get("name")
        if name not in contexts:
            continue
        if run.get("head_sha") != commit:
            fail(f"required_check_wrong_head:{name}")
        app = run.get("app")
        if not isinstance(app, dict) or app.get("id") != required_app_id:
            fail(f"required_check_wrong_app:{name}")
        identifier = run.get("id")
        if not isinstance(identifier, int) or identifier <= 0:
            fail(f"required_check_invalid_id:{name}")
        previous = latest.get(str(name))
        if previous is None or identifier > int(previous["id"]):
            latest[str(name)] = run
    return latest


def main() -> int:
    args = parse_args()
    if args.repository != "TrillionniumFoundation/hepta-paper":
        fail("unexpected_repository")
    if len(args.commit) != 40 or any(character not in "0123456789abcdef" for character in args.commit):
        fail("invalid_commit")
    if not args.token:
        fail("missing_github_token")

    required = json.loads(args.required_checks.read_text(encoding="utf-8"))
    contexts = required.get("contexts")
    if not isinstance(contexts, list) or not contexts or len(contexts) != len(set(contexts)):
        fail("required_contexts_invalid")
    if any(not isinstance(context, str) or not context for context in contexts):
        fail("required_context_name_invalid")
    expected_status = required.get("acceptedStatus")
    expected_conclusion = required.get("acceptedConclusion")
    required_app_id = required.get("requiredAppId")
    collector = required.get("collector")
    if expected_status != "completed" or expected_conclusion != "success":
        fail("required_result_policy_invalid")
    if required_app_id != 15368:
        fail("required_app_policy_invalid")
    if not isinstance(collector, dict):
        fail("collector_policy_invalid")
    maximum_wait = collector.get("maximumWaitSeconds")
    poll_seconds = collector.get("pollSeconds")
    if not isinstance(maximum_wait, int) or maximum_wait <= 0:
        fail("collector_maximum_wait_invalid")
    if not isinstance(poll_seconds, int) or poll_seconds <= 0:
        fail("collector_poll_invalid")

    deadline = time.monotonic() + maximum_wait
    args.output.parent.mkdir(parents=True, exist_ok=True)
    while True:
        payload = fetch_all(args.api_url, args.repository, args.commit, args.token)
        args.output.write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        latest = latest_required(payload, contexts, args.commit, required_app_id)
        missing = sorted(set(contexts) - set(latest))
        pending: list[str] = []
        failed: list[str] = []
        for context in contexts:
            run = latest.get(context)
            if run is None:
                continue
            status = run.get("status")
            conclusion = run.get("conclusion")
            if status != expected_status:
                pending.append(f"{context}:{status}")
            elif conclusion != expected_conclusion:
                failed.append(f"{context}:{conclusion}")

        if failed:
            fail("required_check_failed:" + ",".join(failed))
        if not missing and not pending:
            if int(payload.get("total_count", 0)) <= 0 or not payload["check_runs"]:
                fail("zero_job_check_collection")
            print(
                json.dumps(
                    {
                        "status": "required_check_matrix_complete",
                        "commit": args.commit,
                        "contexts": len(contexts),
                        "checkRuns": len(payload["check_runs"]),
                    },
                    sort_keys=True,
                )
            )
            return 0
        if time.monotonic() >= deadline:
            fail(
                "required_check_matrix_timeout:"
                f"missing={missing},pending={pending}"
            )
        print(
            json.dumps(
                {
                    "status": "waiting_for_required_checks",
                    "missing": missing,
                    "pending": pending,
                },
                sort_keys=True,
            ),
            flush=True,
        )
        time.sleep(poll_seconds)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"required check matrix not accepted: {error}", file=sys.stderr)
        raise SystemExit(1)
