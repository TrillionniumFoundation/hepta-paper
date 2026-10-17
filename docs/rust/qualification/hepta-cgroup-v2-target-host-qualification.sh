#!/usr/bin/env bash
set -euo pipefail

umask 077

fail() {
  printf 'qualification_error=%s\n' "$1" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail root_required
[[ ${HEPTA_CGROUP_QUALIFICATION_ACK:-} == YES ]] || fail explicit_ack_required
[[ -n ${HEPTA_CGROUP_ROOT:-} ]] || fail cgroup_root_required
[[ -n ${HEPTA_EVIDENCE_DIR:-} ]] || fail evidence_dir_required
[[ ${HEPTA_CGROUP_ROOT} == /sys/fs/cgroup/* ]] || fail cgroup_root_outside_v2_mount
[[ ! -e ${HEPTA_EVIDENCE_DIR} ]] || fail evidence_directory_must_be_absent

repo_root=$(git rev-parse --show-toplevel)
commit=$(git -C "$repo_root" rev-parse HEAD)
tree=$(git -C "$repo_root" rev-parse 'HEAD^{tree}')
lock_hash=$(sha256sum "$repo_root/rust/Cargo.lock" | awk '{print $1}')
script_hash=$(sha256sum "$0" | awk '{print $1}')

mount_type=$(findmnt -n -o FSTYPE --target /sys/fs/cgroup)
[[ $mount_type == cgroup2 ]] || fail unified_cgroup_v2_required
[[ -d ${HEPTA_CGROUP_ROOT} ]] || fail delegated_root_missing
[[ ! -L ${HEPTA_CGROUP_ROOT} ]] || fail delegated_root_symlink
[[ -w ${HEPTA_CGROUP_ROOT} ]] || fail delegated_root_not_writable
[[ -f ${HEPTA_CGROUP_ROOT}/cgroup.controllers ]] || fail controllers_missing

install -d -m 0700 "$HEPTA_EVIDENCE_DIR"
operation=${HEPTA_CGROUP_ROOT}/hepta-qualification-${commit:0:12}-$$
[[ ! -e $operation ]] || fail operation_cgroup_exists
mkdir "$operation"
cleanup() {
  if [[ -e $operation/cgroup.kill ]]; then
    printf '1' > "$operation/cgroup.kill" 2>/dev/null || true
  fi
  for _ in $(seq 1 200); do
    populated=$(awk '$1=="populated"{print $2}' "$operation/cgroup.events" 2>/dev/null || printf '0')
    [[ $populated == 0 ]] && break
    sleep 0.05
  done
  rmdir "$operation" 2>/dev/null || true
}
trap cleanup EXIT

printf '64' > "$operation/pids.max"
printf '%s' "${HEPTA_MEMORY_MAX:-536870912}" > "$operation/memory.max"
printf '%s %s' "${HEPTA_CPU_QUOTA_US:-100000}" "${HEPTA_CPU_PERIOD_US:-100000}" > "$operation/cpu.max"

helper="$HEPTA_EVIDENCE_DIR/daemonize.py"
cat > "$helper" <<'PY'
import json
import os
import signal
import time
from pathlib import Path

ready = Path(os.environ["HEPTA_READY"])
pids = Path(os.environ["HEPTA_PIDS"])
os.setsid()
os.kill(os.getpid(), signal.SIGSTOP)
first = os.fork()
if first == 0:
    second = os.fork()
    if second == 0:
        pids.write_text(json.dumps({
            "leader": os.getppid(),
            "escaped": os.getpid(),
            "sid": os.getsid(0),
            "pgrp": os.getpgrp(),
        }) + "\n")
        ready.write_text("ready\n")
        while True:
            time.sleep(60)
    os._exit(0)
os.waitpid(first, 0)
while True:
    time.sleep(60)
PY
chmod 0500 "$helper"

ready="$HEPTA_EVIDENCE_DIR/ready"
pids_json="$HEPTA_EVIDENCE_DIR/pids.json"
HEPTA_READY="$ready" HEPTA_PIDS="$pids_json" python3 -I "$helper" &
leader=$!

for _ in $(seq 1 200); do
  state=$(awk '{print $3}' "/proc/$leader/stat" 2>/dev/null || true)
  [[ $state == T || $state == t ]] && break
  sleep 0.01
done
state=$(awk '{print $3}' "/proc/$leader/stat" 2>/dev/null || true)
[[ $state == T || $state == t ]] || fail initial_child_not_stopped

printf '%s' "$leader" > "$operation/cgroup.procs"
kill -CONT "$leader"
for _ in $(seq 1 400); do
  [[ -f $ready && -f $pids_json ]] && break
  sleep 0.025
done
[[ -f $ready && -f $pids_json ]] || fail daemonization_fixture_timeout

escaped=$(python3 -I - "$pids_json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["escaped"])
PY
)
mapfile -t members < "$operation/cgroup.procs"
printf '%s\n' "${members[@]}" > "$HEPTA_EVIDENCE_DIR/cgroup-members-before-kill.txt"
printf '%s\n' "$leader" "$escaped" | sort -n > "$HEPTA_EVIDENCE_DIR/expected-live-pids.txt"
for pid in "$leader" "$escaped"; do
  grep -Fxq "$pid" "$operation/cgroup.procs" || fail escaped_process_not_contained
  [[ -d /proc/$pid ]] || fail expected_process_not_live
  {
    printf 'pid=%s ' "$pid"
    awk '{printf "state=%s pgrp=%s sid=%s start=%s\n", $3, $5, $6, $22}' "/proc/$pid/stat"
  } >> "$HEPTA_EVIDENCE_DIR/process-identities.txt"
done

printf '1' > "$operation/cgroup.kill"
for _ in $(seq 1 400); do
  populated=$(awk '$1=="populated"{print $2}' "$operation/cgroup.events")
  [[ $populated == 0 ]] && break
  sleep 0.025
done
populated=$(awk '$1=="populated"{print $2}' "$operation/cgroup.events")
[[ $populated == 0 ]] || fail cgroup_remained_populated
for pid in "$leader" "$escaped"; do
  [[ ! -d /proc/$pid ]] || fail process_survived_cgroup_kill
done

rmdir "$operation"
trap - EXIT

kernel=$(uname -srmo)
mount_line=$(findmnt -n -o SOURCE,TARGET,FSTYPE,OPTIONS --target /sys/fs/cgroup)
controllers=$(cat "$HEPTA_CGROUP_ROOT/cgroup.controllers")
completed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$HEPTA_EVIDENCE_DIR/evidence.json" <<EOF
{
  "schemaVersion": 1,
  "packageId": "EXT-HOST-CGROUP-001",
  "repository": "TrillionniumFoundation/hepta-paper",
  "commit": "$commit",
  "tree": "$tree",
  "cargoLockSha256": "sha256:$lock_hash",
  "harnessSha256": "sha256:$script_hash",
  "kernel": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$kernel"),
  "cgroupMount": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$mount_line"),
  "delegatedRoot": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$HEPTA_CGROUP_ROOT"),
  "controllers": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$controllers"),
  "initialPid": $leader,
  "escapedPid": $escaped,
  "setsidAndDoubleForkContained": true,
  "cgroupKillReachedPopulatedZero": true,
  "completedAt": "$completed",
  "result": "package_executed_pending_independent_review",
  "productionAuthority": false
}
EOF

find "$HEPTA_EVIDENCE_DIR" -type f -print0 | sort -z | xargs -0 sha256sum \
  > "$HEPTA_EVIDENCE_DIR/file-sha256.txt"
chmod -R a-w "$HEPTA_EVIDENCE_DIR"
printf 'qualification_result=package_executed_pending_independent_review\n'
