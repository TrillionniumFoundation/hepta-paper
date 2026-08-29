#!/usr/bin/env python3
"""Fail-closed structural, subject, challenge, attachment and hash validation.

Cryptographic signature verification is deliberately performed by the Rust verifier
against a separately provisioned trust store; this script never treats shape as authority.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import time

REPOSITORY = "TrillionniumFoundation/hepta-paper"
KINDS = {
    "independent_linux_review": "independent_reviewer",
    "target_host_qualification": "target_host_operator",
    "storage_destructive_drill": "storage_operator",
    "capability_key_owner_drill": "capability_key_owner",
    "authenticated_codex_role_qualification": "provider_account_owner",
    "campaign_writer_cutover_soak": "campaign_database_owner",
    "release_external_authority": "release_authority",
}
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
ATTACHMENT_PATH = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$")
TOP_KEYS = {
    "schemaVersion", "evidenceKind", "packageId", "challenge", "subject", "issuer",
    "observedAtUnixMs", "expiresAtUnixMs", "claims", "attachments",
    "previousEvidenceHash", "recordHash", "signature",
}
CHALLENGE_KEYS = {
    "challengeId", "nonce", "issuedAtUnixMs", "expiresAtUnixMs", "repository", "commit", "tree",
}
SUBJECT_KEYS = {
    "repository", "commit", "tree", "binaryDigests", "configurationDigests",
    "hostIdentityHash", "trustStoreHash",
}
ISSUER_KEYS = {"authorityId", "authorityClass", "keyId"}
SIGNATURE_KEYS = {"algorithm", "valueBase64Url"}
CLAIM_KEYS = {
    "independent_linux_review": {
        "passed", "reviewedUnsafeBoundaries", "reviewedKernelAssumptions",
        "openCriticalFindings", "reviewerIndependenceAttestationHash",
    },
    "target_host_qualification": {
        "passed", "kernelRelease", "cgroupV2Qualified", "systemdHardeningQualified",
        "listenerAuthorizedPeerSucceeded", "listenerUnauthorizedPeerRejected",
        "gateAuthoritySeparated", "schemaAuthoritySeparated", "rebootRecoveryPassed",
    },
    "storage_destructive_drill": {
        "passed", "sigkillMatrixPassed", "hostRebootPassed", "diskFullPassed",
        "readOnlyRemountPassed", "walCorruptionRejected", "pageCorruptionRejected",
        "restoreDrillPassed", "liveProductionDataTouched",
    },
    "capability_key_owner_drill": {
        "passed", "overlapRotationPassed", "revocationPassed", "rollbackRejected",
        "bundleSignerCompromiseDrillPassed", "requestSignerCompromiseDrillPassed",
        "emergencyAdmissionStopPassed",
    },
    "authenticated_codex_role_qualification": {
        "passed", "authorPrincipalDistinct", "reviewerPrincipalDistinct",
        "authorCanaryPassed", "reviewerCanaryPassed", "freshEphemeralSessions",
        "credentialLeakCount", "crossRoleReadCount", "providerNetworkCallsBounded",
    },
    "campaign_writer_cutover_soak": {
        "passed", "schemaVersion", "mixedWriterExcluded", "durationSeconds",
        "staleCommitCount", "duplicateIntegrationCount", "unexplainedBudgetDeltaMicrousd",
        "backupRestorePassed", "rollbackPassed",
    },
    "release_external_authority": {
        "passed", "kmsOrHsmQualified", "wormCustodyQualified", "releaseSignatureVerified",
        "singleUseDispatchQualified", "modelPrincipalSecretAccessCount",
        "ambiguousExternalActionReconciled",
    },
}


def fail(message: str) -> None:
    raise ValueError(message)


def exact_keys(value: dict, allowed: set[str], required: set[str], subject: str) -> None:
    unknown = sorted(set(value) - allowed)
    missing = sorted(required - set(value))
    if unknown:
        fail(f"{subject} has unknown fields: {', '.join(unknown)}")
    if missing:
        fail(f"{subject} is missing fields: {', '.join(missing)}")


def expect_bool(claims: dict, key: str, expected: bool) -> None:
    if claims.get(key) is not expected:
        fail(f"claim {key} must be {expected}")


def validate_claims(kind: str, claims: dict) -> None:
    if not isinstance(claims, dict):
        fail("claims must be an object")
    expected = CLAIM_KEYS[kind]
    exact_keys(claims, expected, expected, "claims")
    expect_bool(claims, "passed", True)
    if kind == "independent_linux_review":
        expect_bool(claims, "reviewedUnsafeBoundaries", True)
        expect_bool(claims, "reviewedKernelAssumptions", True)
        if claims["openCriticalFindings"] != 0 or not DIGEST.fullmatch(claims["reviewerIndependenceAttestationHash"]):
            fail("independent review claims are not closed")
    elif kind == "target_host_qualification":
        for key in expected - {"passed", "kernelRelease"}:
            expect_bool(claims, key, True)
        if not isinstance(claims["kernelRelease"], str) or not claims["kernelRelease"]:
            fail("kernelRelease is required")
    elif kind == "storage_destructive_drill":
        for key in expected - {"passed", "liveProductionDataTouched"}:
            expect_bool(claims, key, True)
        expect_bool(claims, "liveProductionDataTouched", False)
    elif kind == "capability_key_owner_drill":
        for key in expected - {"passed"}:
            expect_bool(claims, key, True)
    elif kind == "authenticated_codex_role_qualification":
        for key in {
            "authorPrincipalDistinct", "reviewerPrincipalDistinct", "authorCanaryPassed",
            "reviewerCanaryPassed", "freshEphemeralSessions", "providerNetworkCallsBounded",
        }:
            expect_bool(claims, key, True)
        if claims["credentialLeakCount"] != 0 or claims["crossRoleReadCount"] != 0:
            fail("Codex role qualification detected authority leakage")
    elif kind == "campaign_writer_cutover_soak":
        expect_bool(claims, "mixedWriterExcluded", True)
        expect_bool(claims, "backupRestorePassed", True)
        expect_bool(claims, "rollbackPassed", True)
        if claims["schemaVersion"] != 25 or claims["durationSeconds"] < 259200:
            fail("writer qualification did not complete schema-25 72-hour soak")
        for key in {"staleCommitCount", "duplicateIntegrationCount", "unexplainedBudgetDeltaMicrousd"}:
            if claims[key] != 0:
                fail(f"writer claim {key} must be zero")
    elif kind == "release_external_authority":
        for key in expected - {"passed", "modelPrincipalSecretAccessCount"}:
            expect_bool(claims, key, True)
        if claims["modelPrincipalSecretAccessCount"] != 0:
            fail("model principal accessed external authority secret")


def digest_bytes(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    return f"sha256:{hasher.hexdigest()}"


def signing_payload(record: dict) -> bytes:
    selected = {key: value for key, value in record.items() if key not in {"recordHash", "signature"}}
    encoded = json.dumps(selected, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    domain = b"HeptaExternalQualificationEvidenceV1"
    return len(domain).to_bytes(8, "big") + domain + len(encoded).to_bytes(8, "big") + encoded


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--challenge", required=True, type=Path)
    parser.add_argument("--attachments-root", required=True, type=Path)
    parser.add_argument("--expected-kind", required=True, choices=sorted(KINDS))
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--expected-tree", required=True)
    parser.add_argument("--now-unix-ms", type=int)
    args = parser.parse_args()
    if not GIT_SHA.fullmatch(args.expected_commit) or not GIT_SHA.fullmatch(args.expected_tree):
        parser.error("expected commit/tree must be lower-case Git SHAs")
    if not args.attachments_root.is_absolute() or not args.attachments_root.is_dir():
        parser.error("attachments root must be an absolute directory")
    record = json.loads(args.evidence.read_text(encoding="utf-8"))
    challenge_file = json.loads(args.challenge.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or not isinstance(challenge_file, dict):
        fail("evidence and challenge must be objects")
    required_top = TOP_KEYS - {"previousEvidenceHash"}
    exact_keys(record, TOP_KEYS, required_top, "evidence")
    if record["schemaVersion"] != 1 or record["evidenceKind"] != args.expected_kind:
        fail("evidence schema or kind mismatch")
    if not IDENTIFIER.fullmatch(record["packageId"]):
        fail("packageId is invalid")

    challenge = record["challenge"]
    exact_keys(challenge, CHALLENGE_KEYS, CHALLENGE_KEYS, "challenge")
    for key in CHALLENGE_KEYS:
        if challenge.get(key) != challenge_file.get(key):
            fail(f"challenge field differs: {key}")
    if challenge["repository"] != REPOSITORY or challenge["commit"] != args.expected_commit or challenge["tree"] != args.expected_tree:
        fail("challenge subject mismatch")
    if challenge_file.get("consumed") is not False:
        fail("challenge has already been consumed or is malformed")

    subject = record["subject"]
    exact_keys(subject, SUBJECT_KEYS, {"repository", "commit", "tree", "binaryDigests", "configurationDigests"}, "subject")
    if subject["repository"] != REPOSITORY or subject["commit"] != args.expected_commit or subject["tree"] != args.expected_tree:
        fail("evidence subject mismatch")
    for map_name in ("binaryDigests", "configurationDigests"):
        values = subject[map_name]
        if not isinstance(values, dict) or (map_name == "binaryDigests" and not values):
            fail(f"{map_name} is invalid")
        if any(not IDENTIFIER.fullmatch(key) or not DIGEST.fullmatch(value) for key, value in values.items()):
            fail(f"{map_name} contains an invalid identity")
    for optional_digest in ("hostIdentityHash", "trustStoreHash"):
        if optional_digest in subject and not DIGEST.fullmatch(subject[optional_digest]):
            fail(f"{optional_digest} is invalid")

    issuer = record["issuer"]
    exact_keys(issuer, ISSUER_KEYS, ISSUER_KEYS, "issuer")
    if issuer["authorityClass"] != KINDS[args.expected_kind]:
        fail("issuer authority class does not match evidence kind")
    if not IDENTIFIER.fullmatch(issuer["authorityId"]) or not IDENTIFIER.fullmatch(issuer["keyId"]):
        fail("issuer identity is invalid")

    now = args.now_unix_ms if args.now_unix_ms is not None else int(time.time() * 1000)
    for key in ("observedAtUnixMs", "expiresAtUnixMs"):
        if not isinstance(record[key], int) or record[key] <= 0:
            fail(f"{key} is invalid")
    if not challenge["issuedAtUnixMs"] <= record["observedAtUnixMs"] < record["expiresAtUnixMs"]:
        fail("evidence time interval is invalid")
    if now >= record["expiresAtUnixMs"] or now >= challenge["expiresAtUnixMs"]:
        fail("evidence or challenge has expired")

    validate_claims(args.expected_kind, record["claims"])
    attachments = record["attachments"]
    if not isinstance(attachments, list) or not 1 <= len(attachments) <= 1024:
        fail("attachments must be a bounded nonempty list")
    seen: set[str] = set()
    for attachment in attachments:
        exact_keys(attachment, {"path", "bytes", "sha256"}, {"path", "bytes", "sha256"}, "attachment")
        relative = attachment["path"]
        if not isinstance(relative, str) or not ATTACHMENT_PATH.fullmatch(relative) or relative in seen:
            fail("attachment path is invalid or duplicated")
        seen.add(relative)
        selected = args.attachments_root / relative
        resolved = selected.resolve(strict=True)
        if args.attachments_root.resolve() not in resolved.parents or not resolved.is_file() or selected.is_symlink():
            fail(f"attachment escapes or is not a regular file: {relative}")
        if selected.stat().st_size != attachment["bytes"] or digest_bytes(selected) != attachment["sha256"]:
            fail(f"attachment identity differs: {relative}")

    if "previousEvidenceHash" in record and not DIGEST.fullmatch(record["previousEvidenceHash"]):
        fail("previousEvidenceHash is invalid")
    expected_hash = digest_bytes_from_payload(signing_payload(record))
    if record["recordHash"] != expected_hash:
        fail("recordHash differs from canonical signing payload")
    signature = record["signature"]
    exact_keys(signature, SIGNATURE_KEYS, SIGNATURE_KEYS, "signature")
    if signature["algorithm"] != "ed25519" or not isinstance(signature["valueBase64Url"], str):
        fail("signature metadata is invalid")
    try:
        decoded = base64.urlsafe_b64decode(signature["valueBase64Url"] + "==")
    except ValueError as error:
        raise ValueError("signature encoding is invalid") from error
    if len(decoded) != 64 or "=" in signature["valueBase64Url"]:
        fail("signature must be an unpadded 64-byte Ed25519 value")

    print(json.dumps({
        "status": "external_evidence_shape_valid_signature_unverified",
        "evidenceKind": args.expected_kind,
        "packageId": record["packageId"],
        "recordHash": record["recordHash"],
        "attachments": len(attachments),
    }, sort_keys=True))
    return 0


def digest_bytes_from_payload(payload: bytes) -> str:
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"external evidence invalid: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
