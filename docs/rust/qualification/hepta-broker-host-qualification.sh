#!/usr/bin/env bash
set -euo pipefail

# Target-host qualification harness for a dedicated, non-production broker
# instance. Repository CI cannot replace the evidence produced here.

fatal() {
  printf 'qualification_error=%s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fatal "missing_command:$1"
}

require_environment() {
  local name=$1
  [[ -n "${!name:-}" ]] || fatal "missing_environment:$name"
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || fatal root_required

for command in systemctl journalctl findmnt mountpoint stat sha256sum getent id \
  python3 timeout; do
  require_command "$command"
done

for name in \
  HEPTA_QUALIFICATION_ID \
  HEPTA_SOURCE_COMMIT \
  HEPTA_BROKER_UNIT \
  HEPTA_BROKER_DATABASE \
  HEPTA_JOURNAL_PREFLIGHT \
  HEPTA_GATE_EXECUTABLE \
  HEPTA_SCHEMA_FILE \
  HEPTA_TRUST_BUNDLE_FILE \
  HEPTA_AUTHORITY_USER \
  HEPTA_BROKER_USER \
  HEPTA_CODEX_USER \
  HEPTA_TEST_MOUNT \
  HEPTA_EVIDENCE_ROOT; do
  require_environment "$name"
done

[[ $HEPTA_QUALIFICATION_ID =~ ^[A-Za-z0-9._-]{8,128}$ ]] \
  || fatal invalid_qualification_id
[[ $HEPTA_SOURCE_COMMIT =~ ^[0-9a-f]{40}$ ]] || fatal invalid_source_commit

for path in \
  "$HEPTA_JOURNAL_PREFLIGHT" \
  "$HEPTA_GATE_EXECUTABLE" \
  "$HEPTA_SCHEMA_FILE" \
  "$HEPTA_TRUST_BUNDLE_FILE"; do
  [[ $path = /* ]] || fatal "non_absolute_path:$path"
  [[ -e $path ]] || fatal "missing_path:$path"
done

mountpoint -q "$HEPTA_TEST_MOUNT" || fatal qualification_mount_required
case "$HEPTA_BROKER_DATABASE" in
  "$HEPTA_TEST_MOUNT"/*) ;;
  *) fatal database_must_be_on_dedicated_qualification_mount ;;
esac

for user in "$HEPTA_AUTHORITY_USER" "$HEPTA_BROKER_USER" "$HEPTA_CODEX_USER"; do
  getent passwd "$user" >/dev/null || fatal "unknown_user:$user"
done
authority_uid=$(id -u "$HEPTA_AUTHORITY_USER")
broker_uid=$(id -u "$HEPTA_BROKER_USER")
codex_uid=$(id -u "$HEPTA_CODEX_USER")
[[ $authority_uid != "$broker_uid" ]] || fatal authority_equals_broker
[[ $authority_uid != "$codex_uid" ]] || fatal authority_equals_codex
[[ $broker_uid != "$codex_uid" ]] || fatal broker_equals_codex

umask 077
install -d -o root -g root -m 0700 "$HEPTA_EVIDENCE_ROOT"
evidence_dir="$HEPTA_EVIDENCE_ROOT/$HEPTA_QUALIFICATION_ID"
[[ ! -e $evidence_dir ]] || fatal evidence_directory_already_exists
install -d -o root -g root -m 0700 "$evidence_dir"
exec > >(tee "$evidence_dir/harness.log") 2>&1

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
boot_id=$(cat /proc/sys/kernel/random/boot_id)
kernel=$(uname -srvmo)

record_object() {
  local label=$1 path=$2
  stat -Lc \
    "$label path=%n dev=%d inode=%i uid=%u gid=%g mode=%a links=%h bytes=%s" \
    "$path" | tee -a "$evidence_dir/objects.txt"
  sha256sum "$path" | tee -a "$evidence_dir/object-sha256.txt"
}

record_object gate "$HEPTA_GATE_EXECUTABLE"
record_object schema "$HEPTA_SCHEMA_FILE"
record_object trust_bundle "$HEPTA_TRUST_BUNDLE_FILE"
record_object journal_preflight "$HEPTA_JOURNAL_PREFLIGHT"

{
  id "$HEPTA_AUTHORITY_USER"
  id "$HEPTA_BROKER_USER"
  id "$HEPTA_CODEX_USER"
  findmnt -T "$HEPTA_BROKER_DATABASE" -o TARGET,SOURCE,FSTYPE,OPTIONS
  systemctl cat "$HEPTA_BROKER_UNIT"
  systemctl show "$HEPTA_BROKER_UNIT" \
    -p User -p Group -p ExecStart -p FragmentPath -p DropInPaths \
    -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp \
    -p RestrictAddressFamilies -p ReadWritePaths -p ReadOnlyPaths
} > "$evidence_dir/installed-topology.txt"\n
broker_database_parent=$(dirname "$HEPTA_BROKER_DATABASE")
parent_uid=$(stat -Lc %u "$broker_database_parent")
[[ $parent_uid = "$broker_uid" ]] || fatal journal_parent_not_owned_by_broker

# The installed preflight must succeed before destructive drills.
sudo -u "$HEPTA_BROKER_USER" -- \
  "$HEPTA_JOURNAL_PREFLIGHT" "$HEPTA_BROKER_DATABASE" "$broker_uid" \
  | tee "$evidence_dir/preflight-before.txt"

# Real broker-main SIGKILL followed by bounded restart and journal audit.
systemctl start "$HEPTA_BROKER_UNIT"
timeout 30 systemctl is-active --quiet "$HEPTA_BROKER_UNIT" \
  || fatal broker_not_active_before_sigkill
systemctl kill --kill-who=main --signal=SIGKILL "$HEPTA_BROKER_UNIT"
for _ in $(seq 1 300); do
  if ! systemctl is-active --quiet "$HEPTA_BROKER_UNIT"; then break; fi
  sleep 0.1
done
systemctl reset-failed "$HEPTA_BROKER_UNIT" || true
systemctl start "$HEPTA_BROKER_UNIT"
timeout 30 systemctl is-active --quiet "$HEPTA_BROKER_UNIT" \
  || fatal broker_failed_restart_after_sigkill
sudo -u "$HEPTA_BROKER_USER" -- \
  "$HEPTA_JOURNAL_PREFLIGHT" "$HEPTA_BROKER_DATABASE" "$broker_uid" \
  | tee "$evidence_dir/preflight-after-sigkill.txt"
journalctl -u "$HEPTA_BROKER_UNIT" --since "$started_at" --no-pager \
  > "$evidence_dir/journal-after-sigkill.txt"

run_destructive=${HEPTA_DESTRUCTIVE_STORAGE_DRILL:-NO}
if [[ $run_destructive = YES ]]; then
  # The mount was already required to be dedicated and to contain only the
  # qualification database. Stop the service before storage mutation.
  systemctl stop "$HEPTA_BROKER_UNIT"

  # Read-only remount: writer startup must fail without silently replacing data.
  mount -o remount,ro "$HEPTA_TEST_MOUNT"
  if sudo -u "$HEPTA_BROKER_USER" -- \
    "$HEPTA_JOURNAL_PREFLIGHT" "$HEPTA_BROKER_DATABASE" "$broker_uid"; then
    fatal preflight_unexpectedly_succeeded_on_read_only_mount
  fi
  mount -o remount,rw "$HEPTA_TEST_MOUNT"
  sudo -u "$HEPTA_BROKER_USER" -- \
    "$HEPTA_JOURNAL_PREFLIGHT" "$HEPTA_BROKER_DATABASE" "$broker_uid" \
    | tee "$evidence_dir/preflight-after-read-only-remount.txt"

  # Disk exhaustion: fill only the dedicated qualification mount. Failure must
  # be explicit; cleanup must restore successful preflight.
  filler="$HEPTA_TEST_MOUNT/.hepta-qualification-filler"
  if dd if=/dev/zero of="$filler" bs=1M status=none; then
    fatal disk_fill_did_not_reach_enospc
  fi
  sync || true
  if sudo -u "$HEPTA_BROKER_USER" -- \
    "$HEPTA_JOURNAL_PREFLIGHT" "$HEPTA_BROKER_DATABASE" "$broker_uid"; then
    printf 'disk_full_preflight=read_only_success\n' \
      > "$evidence_dir/disk-full-observation.txt"
  else
    printf 'disk_full_preflight=explicit_failure\n' \
      > "$evidence_dir/disk-full-observation.txt"
  fi
  rm -f "$filler"
  sync
  sudo -u "$HEPTA_BROKER_USER" -- \
    "$HEPTA_JOURNAL_PREFLIGHT" "$HEPTA_BROKER_DATABASE" "$broker_uid" \
    | tee "$evidence_dir/preflight-after-disk-full.txt"

  systemctl start "$HEPTA_BROKER_UNIT"
  timeout 30 systemctl is-active --quiet "$HEPTA_BROKER_UNIT" \
    || fatal broker_failed_after_storage_drills
else
  printf 'destructive_storage_drills=not_run\n' \
    > "$evidence_dir/destructive-storage-status.txt"
fi

# Corruption is performed only on a private copy, never on the live journal.
corrupt_parent="$evidence_dir/corruption-fixture"
install -d -o "$HEPTA_BROKER_USER" -g "$HEPTA_BROKER_USER" -m 0700 \
  "$corrupt_parent"
corrupt_database="$corrupt_parent/broker.sqlite"
cp --reflink=never --preserve=mode "$HEPTA_BROKER_DATABASE" "$corrupt_database"
chown "$HEPTA_BROKER_USER:$HEPTA_BROKER_USER" "$corrupt_database"
chmod 0600 "$corrupt_database"
python3 - "$corrupt_database" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
data = bytearray(path.read_bytes())
if len(data) < 512:
    raise SystemExit("database too small for corruption drill")
offset = min(4096, len(data) - 1)
data[offset] ^= 0x5A
path.write_bytes(data)
PY
if sudo -u "$HEPTA_BROKER_USER" -- \
  "$HEPTA_JOURNAL_PREFLIGHT" "$corrupt_database" "$broker_uid"; then
  fatal corrupt_database_was_accepted
fi
printf 'corrupt_copy_rejected=true\n' > "$evidence_dir/corruption-result.txt"

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$evidence_dir/evidence.json" <<PY
import json
import os
import sys
record = {
    "version": 1,
    "qualificationId": os.environ["HEPTA_QUALIFICATION_ID"],
    "sourceCommit": os.environ["HEPTA_SOURCE_COMMIT"],
    "startedAt": "$started_at",
    "completedAt": "$completed_at",
    "host": {"bootId": "$boot_id", "kernel": "$kernel"},
    "principals": {
        "authorityUid": $authority_uid,
        "brokerUid": $broker_uid,
        "codexUid": $codex_uid,
    },
    "drills": {
        "brokerSigkillRestart": "passed",
        "corruptCopyRejected": True,
        "destructiveStorage": "$run_destructive",
    },
    "independentReview": "pending",
}
with open(sys.argv[1], "x", encoding="utf-8") as handle:
    json.dump(record, handle, sort_keys=True, separators=(",", ":"))
PY

find "$evidence_dir" -type f ! -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 sha256sum > "$evidence_dir/SHA256SUMS"
chmod -R a-w "$evidence_dir"
printf 'qualification_evidence=%s\n' "$evidence_dir"
