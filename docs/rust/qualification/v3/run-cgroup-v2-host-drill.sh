#!/usr/bin/env bash
set -euo pipefail

: "${HEPTA_CGROUP_DRILL_OUTPUT:?absolute absent output directory required}"
: "${HEPTA_QUALIFICATION_MOUNT:?dedicated qualification mount required}"
: "${HEPTA_CGROUP_DRILL_CONFIRMATION:?set to YES_CGROUP_V2_QUALIFICATION}"

if [[ "$HEPTA_CGROUP_DRILL_CONFIRMATION" != YES_CGROUP_V2_QUALIFICATION ]]; then
  echo 'cgroup-v2 drill confirmation is missing' >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo 'cgroup-v2 target-host drill must run as root' >&2
  exit 2
fi
for selected in "$HEPTA_CGROUP_DRILL_OUTPUT" "$HEPTA_QUALIFICATION_MOUNT"; do
  [[ "$selected" = /* ]] || { echo "path is not absolute: $selected" >&2; exit 2; }
  [[ ! -L "$selected" ]] || { echo "symlink path rejected: $selected" >&2; exit 2; }
done
[[ -d "$HEPTA_QUALIFICATION_MOUNT" ]] || { echo 'qualification mount is absent' >&2; exit 2; }
[[ -f "$HEPTA_QUALIFICATION_MOUNT/.hepta-qualification-only" ]] || {
  echo 'qualification-only mount marker is absent' >&2
  exit 2
}
[[ ! -e "$HEPTA_CGROUP_DRILL_OUTPUT" ]] || { echo 'output already exists' >&2; exit 2; }

mount_target=$(findmnt -n -o TARGET --target "$HEPTA_QUALIFICATION_MOUNT")
mount_source=$(findmnt -n -o SOURCE --target "$HEPTA_QUALIFICATION_MOUNT")
mount_fstype=$(findmnt -n -o FSTYPE --target "$HEPTA_QUALIFICATION_MOUNT")
[[ "$mount_target" = "$HEPTA_QUALIFICATION_MOUNT" ]] || {
  echo 'qualification mount is not a distinct mount point' >&2
  exit 2
}
case "$mount_target" in
  /|/boot|/home|/usr|/var|/data|/data/home-data) echo 'unsafe qualification mount' >&2; exit 2 ;;
esac
[[ $(stat -fc %T /sys/fs/cgroup) = cgroup2fs ]] || { echo 'unified cgroup v2 is required' >&2; exit 2; }
grep -qw cpu /sys/fs/cgroup/cgroup.controllers
grep -qw memory /sys/fs/cgroup/cgroup.controllers
grep -qw pids /sys/fs/cgroup/cgroup.controllers
command -v systemd-run >/dev/null
command -v systemctl >/dev/null

install -d -o root -g root -m 0700 "$HEPTA_CGROUP_DRILL_OUTPUT"
unit="hepta-cgroup-drill-$RANDOM-$$"
cleanup() {
  systemctl stop "$unit.service" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit.service" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cat > "$HEPTA_CGROUP_DRILL_OUTPUT/daemonize.sh" <<'SH'
#!/bin/sh
set -eu
setsid sh -c '
  sh -c "sleep 600" &
  first=$!
  setsid sh -c "sleep 600" &
  second=$!
  printf "%s %s\n" "$first" "$second" > "$1/escaped-pids"
  wait
' sh "$1" &
wait
SH
chmod 0500 "$HEPTA_CGROUP_DRILL_OUTPUT/daemonize.sh"

systemd-run \
  --unit "$unit" \
  --property Type=simple \
  --property Delegate=yes \
  --property TasksMax=64 \
  --property MemoryMax=536870912 \
  --property CPUQuota=50% \
  --property NoNewPrivileges=yes \
  --property PrivateTmp=yes \
  --property ProtectSystem=strict \
  --property ProtectHome=yes \
  --property RestrictSUIDSGID=yes \
  --property LockPersonality=yes \
  --property RestrictNamespaces=yes \
  --property SystemCallArchitectures=native \
  "$HEPTA_CGROUP_DRILL_OUTPUT/daemonize.sh" "$HEPTA_CGROUP_DRILL_OUTPUT"

for _ in $(seq 1 200); do
  [[ -s "$HEPTA_CGROUP_DRILL_OUTPUT/escaped-pids" ]] && break
  sleep 0.05
done
[[ -s "$HEPTA_CGROUP_DRILL_OUTPUT/escaped-pids" ]] || { echo 'daemonization fixture did not start' >&2; exit 1; }
control_group=$(systemctl show -p ControlGroup --value "$unit.service")
[[ "$control_group" = /* ]] || { echo 'systemd did not publish a control group' >&2; exit 1; }
cgroup_path="/sys/fs/cgroup$control_group"
[[ -d "$cgroup_path" && ! -L "$cgroup_path" ]] || { echo 'control group path invalid' >&2; exit 1; }

read -r first_pid second_pid < "$HEPTA_CGROUP_DRILL_OUTPUT/escaped-pids"
for pid in "$first_pid" "$second_pid"; do
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo 'fixture PID malformed' >&2; exit 1; }
  grep -qx "$pid" "$cgroup_path/cgroup.procs" || {
    found=$(find "$cgroup_path" -mindepth 1 -type f -name cgroup.procs -exec grep -l -x "$pid" {} + | head -n 1 || true)
    [[ -n "$found" ]] || { echo "escaped PID is outside delegated cgroup: $pid" >&2; exit 1; }
  }
done

{
  uname -a
  echo "mount_target=$mount_target"
  echo "mount_source=$mount_source"
  echo "mount_fstype=$mount_fstype"
  echo "unit=$unit.service"
  echo "control_group=$control_group"
  systemctl show "$unit.service" \
    -p MainPID -p ControlGroup -p Delegate -p TasksMax -p MemoryMax -p CPUQuotaPerSecUSec \
    -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p RestrictSUIDSGID \
    -p LockPersonality -p RestrictNamespaces -p SystemCallArchitectures
  cat "$cgroup_path/cgroup.events"
  cat "$cgroup_path/pids.max"
  cat "$cgroup_path/memory.max"
  cat "$cgroup_path/cpu.max"
} > "$HEPTA_CGROUP_DRILL_OUTPUT/before-kill.txt"

systemctl kill --kill-who=all --signal=KILL "$unit.service"
for _ in $(seq 1 400); do
  alive=0
  for pid in "$first_pid" "$second_pid"; do
    if kill -0 "$pid" 2>/dev/null; then alive=1; fi
  done
  [[ $alive -eq 0 ]] && break
  sleep 0.05
done
for pid in "$first_pid" "$second_pid"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "cgroup kill did not terminate escaped descendant: $pid" >&2
    exit 1
  fi
done

systemctl stop "$unit.service" >/dev/null 2>&1 || true
systemctl reset-failed "$unit.service" >/dev/null 2>&1 || true
{
  echo 'setsid_descendant_contained=true'
  echo 'double_fork_descendant_contained=true'
  echo 'cgroup_kill_emptied_process_set=true'
  echo 'live_production_data_touched=false'
} > "$HEPTA_CGROUP_DRILL_OUTPUT/result.txt"
sha256sum "$HEPTA_CGROUP_DRILL_OUTPUT"/* > "$HEPTA_CGROUP_DRILL_OUTPUT/SHA256SUMS.tmp"
mv "$HEPTA_CGROUP_DRILL_OUTPUT/SHA256SUMS.tmp" "$HEPTA_CGROUP_DRILL_OUTPUT/SHA256SUMS"
chmod -R a-w "$HEPTA_CGROUP_DRILL_OUTPUT"
trap - EXIT
printf '%s\n' 'cgroup-v2 target-host drill passed'
