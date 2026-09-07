#!/usr/bin/env bash
set -euo pipefail

: "${PROVIDER_SOURCE_MANIFEST:?PROVIDER_SOURCE_MANIFEST is required}"
: "${PROVIDER_TARGET_PROFILE:?PROVIDER_TARGET_PROFILE is required}"
: "${EVIDENCE_ROOT:?EVIDENCE_ROOT is required}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
SOURCE_SCHEMA="$ROOT/docs/provider-sandbox/schemas/provider-external-companion-source-manifest-v1.schema.json"
HOST_SCHEMA="$ROOT/docs/provider-sandbox/schemas/provider-external-target-host-profile-v1.schema.json"
VECTOR_SCHEMA="$ROOT/docs/provider-sandbox/schemas/provider-external-conformance-vectors-v1.schema.json"
VECTORS="$ROOT/docs/provider-sandbox/fixtures/provider-external-conformance-vectors-v1.json"
STRICT_SCHEMA="$ROOT/docs/rust/tools/strict_json_schema.py"
EXTERNAL_TEST="$ROOT/paper-core/operational/provider-sandbox-external.operational.mjs"
CANONICAL_COMPANION="$ROOT/../hepta-paper-provider-sandbox/provider-sandbox.mjs"

case "$EVIDENCE_ROOT" in
  /*) ;;
  *) printf '%s\n' 'provider_acceptance_evidence_root_must_be_absolute' >&2; exit 2 ;;
esac

if [ -e "$EVIDENCE_ROOT" ]; then
  if [ ! -d "$EVIDENCE_ROOT" ] || [ -n "$(find "$EVIDENCE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    printf '%s\n' 'provider_acceptance_evidence_root_not_empty' >&2
    exit 2
  fi
else
  install -d -m 0700 "$EVIDENCE_ROOT"
fi
install -d -m 0700 "$EVIDENCE_ROOT/home" "$EVIDENCE_ROOT/tmp" "$EVIDENCE_ROOT/vectors"

export PYTHONDONTWRITEBYTECODE=1
python3 "$STRICT_SCHEMA" --schema "$SOURCE_SCHEMA" --instance "$PROVIDER_SOURCE_MANIFEST" \
  | tee "$EVIDENCE_ROOT/source-manifest-schema.json"
python3 "$STRICT_SCHEMA" --schema "$HOST_SCHEMA" --instance "$PROVIDER_TARGET_PROFILE" \
  | tee "$EVIDENCE_ROOT/target-host-profile-schema.json"
python3 "$STRICT_SCHEMA" --schema "$VECTOR_SCHEMA" --instance "$VECTORS" \
  | tee "$EVIDENCE_ROOT/conformance-vector-schema.json"

python3 - "$ROOT" "$CANONICAL_COMPANION" "$PROVIDER_SOURCE_MANIFEST" \
  "$PROVIDER_TARGET_PROFILE" "$EVIDENCE_ROOT/preflight.json" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve(strict=True)
expected_companion = Path(sys.argv[2])
manifest_path = Path(sys.argv[3]).resolve(strict=True)
profile_path = Path(sys.argv[4]).resolve(strict=True)
output_path = Path(sys.argv[5])


def read_regular_single_link(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise SystemExit('provider_acceptance_input_unsafe')
        raw = bytearray()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            raw.extend(chunk)
            if len(raw) > 16 * 1024 * 1024:
                raise SystemExit('provider_acceptance_input_too_large')
        after = os.fstat(descriptor)
        named = os.lstat(path)
        identity = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        if any(getattr(before, key) != getattr(after, key) or
               getattr(before, key) != getattr(named, key) for key in identity):
            raise SystemExit('provider_acceptance_input_changed')
        return bytes(raw)
    finally:
        os.close(descriptor)


def load(path: Path) -> tuple[dict, bytes]:
    raw = read_regular_single_link(path)
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit('provider_acceptance_input_malformed') from error
    if not isinstance(value, dict):
        raise SystemExit('provider_acceptance_input_not_object')
    return value, raw

manifest, manifest_raw = load(manifest_path)
profile, profile_raw = load(profile_path)
companion = Path(manifest['source']['executablePath'])
if companion != expected_companion:
    raise SystemExit('provider_acceptance_companion_path_not_canonical')
try:
    canonical_companion = companion.resolve(strict=True)
except FileNotFoundError as error:
    raise SystemExit('provider_acceptance_companion_missing') from error
if canonical_companion != companion:
    raise SystemExit('provider_acceptance_companion_path_not_canonical')
companion_raw = read_regular_single_link(companion)
observed_digest = 'sha256:' + hashlib.sha256(companion_raw).hexdigest()
if observed_digest != manifest['source']['executableSha256']:
    raise SystemExit('provider_acceptance_companion_digest_mismatch')
if profile['filesystem']['sourceRoot'] != str(companion.parent):
    raise SystemExit('provider_acceptance_source_root_mismatch')
if profile['process']['uid'] != profile['filesystem']['ownerUid'] or \
        profile['process']['gid'] != profile['filesystem']['ownerGid']:
    raise SystemExit('provider_acceptance_service_owner_mismatch')
for document in (manifest, profile):
    if any(document['authority'].values()):
        raise SystemExit('provider_acceptance_authority_escalation')
record = {
    'schemaVersion': 1,
    'kind': 'ProviderExternalAcceptancePreflightV1',
    'status': 'preflight_source_and_profile_bound_non_authorizing',
    'repositoryRoot': str(root),
    'sourceManifestSha256': 'sha256:' + hashlib.sha256(manifest_raw).hexdigest(),
    'targetHostProfileSha256': 'sha256:' + hashlib.sha256(profile_raw).hexdigest(),
    'companionPath': str(companion),
    'companionSha256': observed_digest,
    'providerAuthorized': False,
    'productionAuthorized': False,
    'externalAuthorityClaimed': False,
}
output_path.write_text(json.dumps(record, sort_keys=True, indent=2) + '\n', encoding='utf-8')
os.chmod(output_path, 0o600)
PY

PROVIDER_COMPANION="$CANONICAL_COMPANION" \
PROVIDER_VECTORS="$VECTORS" \
PROVIDER_VECTOR_EVIDENCE="$EVIDENCE_ROOT/vectors/result.json" \
PROVIDER_VECTOR_RUNTIME="$EVIDENCE_ROOT/tmp/vector-runtime" \
env -i \
  PATH="/usr/bin:/bin" \
  HOME="$EVIDENCE_ROOT/home" \
  TMPDIR="$EVIDENCE_ROOT/tmp" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  PROVIDER_COMPANION="$CANONICAL_COMPANION" \
  PROVIDER_VECTORS="$VECTORS" \
  PROVIDER_VECTOR_EVIDENCE="$EVIDENCE_ROOT/vectors/result.json" \
  PROVIDER_VECTOR_RUNTIME="$EVIDENCE_ROOT/tmp/vector-runtime" \
  node "$ROOT/docs/provider-sandbox/tools/run-provider-conformance-vectors.mjs" \
  | tee "$EVIDENCE_ROOT/vector-run.log"

env -i \
  PATH="/usr/bin:/bin" \
  HOME="$EVIDENCE_ROOT/home" \
  TMPDIR="$EVIDENCE_ROOT/tmp" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  node --test --test-concurrency=1 "$EXTERNAL_TEST" \
  | tee "$EVIDENCE_ROOT/external-quarantine-test.log"

sha256sum \
  "$PROVIDER_SOURCE_MANIFEST" \
  "$PROVIDER_TARGET_PROFILE" \
  "$VECTORS" \
  "$CANONICAL_COMPANION" \
  "$EVIDENCE_ROOT/preflight.json" \
  "$EVIDENCE_ROOT/vectors/result.json" \
  "$EVIDENCE_ROOT/external-quarantine-test.log" \
  > "$EVIDENCE_ROOT/SHA256SUMS"

python3 - "$EVIDENCE_ROOT" <<'PY'
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
entries = []
for path in sorted(p for p in root.rglob('*') if p.is_file() and p.name != 'index.json'):
    raw = path.read_bytes()
    entries.append({
        'path': path.relative_to(root).as_posix(),
        'bytes': len(raw),
        'sha256': 'sha256:' + hashlib.sha256(raw).hexdigest(),
    })
body = {
    'schemaVersion': 1,
    'kind': 'ProviderExternalAcceptanceEvidenceIndexV1',
    'status': 'external_acceptance_execution_complete_non_authorizing',
    'entries': entries,
    'providerAuthorized': False,
    'releaseAuthorized': False,
    'submissionAuthorized': False,
    'productionAuthorized': False,
    'externalAuthorityClaimed': False,
}
body['indexSha256'] = 'sha256:' + hashlib.sha256(
    json.dumps(body, sort_keys=True, separators=(',', ':')).encode('utf-8')
).hexdigest()
output = root / 'index.json'
output.write_text(json.dumps(body, sort_keys=True, indent=2) + '\n', encoding='utf-8')
output.chmod(0o600)
print(json.dumps({
    'status': body['status'],
    'entries': len(entries),
    'indexSha256': body['indexSha256'],
    'productionAuthorized': False,
}, sort_keys=True))
PY
