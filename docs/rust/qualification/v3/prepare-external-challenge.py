#!/usr/bin/env python3
"""Create a fresh, single-use external qualification challenge."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import secrets
import time

REPOSITORY = "TrillionniumFoundation/hepta-paper"
KINDS = {
    "independent_linux_review",
    "target_host_qualification",
    "storage_destructive_drill",
    "capability_key_owner_drill",
    "authenticated_codex_role_qualification",
    "campaign_writer_cutover_soak",
    "release_external_authority",
}


def git_sha(value: str) -> str:
    if len(value) != 40 or any(character not in "0123456789abcdef" for character in value):
        raise argparse.ArgumentTypeError("expected a lower-case 40-character Git SHA")
    return value


def identifier(value: str) -> str:
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")
    if not value or len(value) > 160 or not value[0].isalnum() or any(character not in allowed for character in value):
        raise argparse.ArgumentTypeError("invalid identifier")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=sorted(KINDS))
    parser.add_argument("--commit", required=True, type=git_sha)
    parser.add_argument("--tree", required=True, type=git_sha)
    parser.add_argument("--package-id", required=True, type=identifier)
    parser.add_argument("--ttl-seconds", type=int, default=86_400)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not 300 <= args.ttl_seconds <= 604_800:
        parser.error("ttl must be between 300 seconds and seven days")
    if args.output.exists() or not args.output.is_absolute():
        parser.error("output must be an absent absolute path")
    now = int(time.time() * 1000)
    expires = now + args.ttl_seconds * 1000
    nonce = secrets.token_urlsafe(48).rstrip("=")
    challenge_id = f"{args.kind}:{args.package_id}:{now}"
    record = {
        "schemaVersion": 1,
        "evidenceKind": args.kind,
        "packageId": args.package_id,
        "challengeId": challenge_id,
        "nonce": nonce,
        "issuedAtUnixMs": now,
        "expiresAtUnixMs": expires,
        "repository": REPOSITORY,
        "commit": args.commit,
        "tree": args.tree,
        "consumed": False,
    }
    args.output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    args.output.write_text(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    args.output.chmod(0o600)
    print(json.dumps({"status": "challenge_created", "challengeId": challenge_id, "output": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
