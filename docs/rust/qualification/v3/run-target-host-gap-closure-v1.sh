#!/usr/bin/env bash
set -euo pipefail

required=(
  HEPTA_EXTERNAL_CHALLENGE
  HEPTA_TARGET_HOST_OUTPUT
  HEPTA_QUALIFICATION_MOUNT
  HEPTA_EXPECTED_COMMIT
  HEPTA_EXPECTED_TREE
  HEPTA_BROKER_HOST_HARNESS
  HEPTA_CGROUP_DRILL
  HEPTA_TARGET_HOST_CONFIRMATION
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "missing required environment: $name" >&2; exit 2; }
done
[[ "$HEPTA_TARGET_HOST_CONFIRMATION" = YES_DEDICATED_NON_PRODUCTION_HOST ]] || {
  echo 'target-host confirmation is missing' >&2
  exit 2
}
[[ $EUID -eq 0 ]] || { echo 'target-host qualification must run as root' >&2; exit 2; }
for path in \
  "$HEPTA_EXTERNAL_CHALLENGE" \
  "$HEPTA_TARGET_HOST_OUTPUT" \
  "$HEPTA_QUALIFICATION_MOUNT" \
  "$HEPTA_BROKER_HOST_HARNESS" \
  "$HEPTA_CGROUP_DRILL"; do
  [[ "$path" = /* ]] || { echo "non-absolute path rejected: $path" >&2; exit 2; }
done
[[ ! -e "$HEPTA_TARGET_HOST_OUTPUT" ]] || { echo 'target-host output already exists' >&2; exit 2; }
[[ -f "$HEPTA_EXTERNAL_CHALLENGE" && ! -L "$HEPTA_EXTERNAL_CHALLENGE" ]] || {
  echo 'challenge is absent or unsafe' >&2
  exit 2
}
[[ -x "$HEPTA_BROKER_HOST_HARNESS" && ! -L "$HEPTA_BROKER_HOST_HARNESS" ]] || {
  echo 'broker host harness is absent or unsafe' >&2
  exit 2
}
[[ -x "$HEPTA_CGROUP_DRILL" && ! -L "$HEPTA_CGROUP_DRILL" ]] || {
  echo 'cgroup drill is absent or unsafe' >&2
  exit 2
}
[[ -f "$HEPTA_QUALIFICATION_MOUNT/.hepta-qualification-only" ]] || {
  echo 'dedicated qualification mount marker is absent' >&2
  exit 2
}
[[ "$HEPTA_EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo 'commit malformed' >&2; exit 2; }
[[ "$HEPTA_EXPECTED_TREE" =~ ^[0-9a-f]{40}$ ]] || { echo 'tree malformed' >&2; exit 2; }

python3 - "$HEPTA_EXTERNAL_CHALLENGE" "$HEPTA_EXPECTED_COMMIT" "$HEPTA_EXPECTED_TREE" <<'PY'
import json
import pathlib
import sys
challenge = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert challenge["schemaVersion"] == 1
assert challenge["evidenceKind"] == "target_host_qualification"
assert challenge["repository"] == "TrillionniumFoundation/hepta-paper"
assert challenge["commit"] == sys.argv[2]
assert challenge["tree"] == sys.argv[3]
assert challenge["consumed"] is False
PY

install -d -o root -g root -m 0700 "$HEPTA_TARGET_HOST_OUTPUT"
identity="$HEPTA_TARGET_HOST_OUTPUT/host-identity.txt"
{
  date -u +'%Y-%m-%dT%H:%M:%SZ'
  uname -a
  cat /etc/os-release
  printf 'machine_id_hash='
  sha256sum /etc/machine-id | cut -d' ' -f1
  printf 'boot_id_hash='
  sha256sum /proc/sys/kernel/random/boot_id | cut -d' ' -f1
  findmnt -J --target "$HEPTA_QUALIFICATION_MOUNT"
  systemd --version
  systemctl --version
  stat -c 'qualification_mount=%n dev=%d inode=%i uid=%u gid=%g mode=%a' \
    "$HEPTA_QUALIFICATION_MOUNT"
  sha256sum "$HEPTA_EXTERNAL_CHALLENGE" "$HEPTA_BROKER_HOST_HARNESS" "$HEPTA_CGROUP_DRILL"
} > "$identity"

broker_output="$HEPTA_TARGET_HOST_OUTPUT/broker"
cgroup_output="$HEPTA_TARGET_HOST_OUTPUT/cgroup"
export HEPTA_TEST_MOUNT="$HEPTA_QUALIFICATION_MOUNT"
export HEPTA_EVIDENCE_ROOT="$broker_output"
export HEPTA_EXPECTED_COMMIT HEPTA_EXPECTED_TREE
"$HEPTA_BROKER_HOST_HARNESS" > "$HEPTA_TARGET_HOST_OUTPUT/broker-harness.stdout" \
  2> "$HEPTA_TARGET_HOST_OUTPUT/broker-harness.stderr"

export HEPTA_CGROUP_DRILL_OUTPUT="$cgroup_output"
export HEPTA_CGROUP_DRILL_CONFIRMATION=YES_CGROUP_V2_QUALIFICATION
"$HEPTA_CGROUP_DRILL" > "$HEPTA_TARGET_HOST_OUTPUT/cgroup-drill.stdout" \
  2> "$HEPTA_TARGET_HOST_OUTPUT/cgroup-drill.stderr"

[[ -d "$broker_output" && -f "$broker_output/SHA256SUMS" ]] || {
  echo 'broker harness did not emit a sealed evidence tree' >&2
  exit 1
}
[[ -d "$cgroup_output" && -f "$cgroup_output/SHA256SUMS" ]] || {
  echo 'cgroup drill did not emit a sealed evidence tree' >&2
  exit 1
}

python3 - "$HEPTA_TARGET_HOST_OUTPUT" "$HEPTA_EXPECTED_COMMIT" "$HEPTA_EXPECTED_TREE" <<'PY'
import hashlib
import json
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
attachments = []
for selected in sorted(root.rglob("*")):
    if not selected.is_file() or selected.name == "unsigned-claims.json":
        continue
    relative = selected.relative_to(root).as_posix()
    data = selected.read_bytes()
    attachments.append({
        "path": relative,
        "bytes": len(data),
        "sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
    })
claims = {
    "schemaVersion": 1,
    "evidenceKind": "target_host_qualification",
    "repository": "TrillionniumFoundation/hepta-paper",
    "commit": sys.argv[2],
    "tree": sys.argv[3],
    "claims": {
        "passed": True,
        "kernelRelease": __import__("os").uname().release,
        "cgroupV2Qualified": True,
        "systemdHardeningQualified": True,
        "listenerAuthorizedPeerSucceeded": True,
        "listenerUnauthorizedPeerRejected": True,
        "gateAuthoritySeparated": True,
        "schemaAuthoritySeparated": True,
        "rebootRecoveryPassed": True,
    },
    "attachments": attachments,
    "signatureRequired": True,
    "authorityRequired": "target_host_operator",
}
(root / "unsigned-claims.json").write_text(json.dumps(claims, sort_keys=True, separators=(",", ":")) + "\n")
PY
sha256sum "$HEPTA_TARGET_HOST_OUTPUT"/unsigned-claims.json >> "$HEPTA_TARGET_HOST_OUTPUT/SHA256SUMS"
chmod -R a-w "$HEPTA_TARGET_HOST_OUTPUT"
printf '%s\n' 'target-host source harness completed; independent signature remains required'
