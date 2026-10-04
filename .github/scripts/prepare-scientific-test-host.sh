#!/usr/bin/env bash
# Prepare the Linux CI host before existing scientific tests. Probes do not
# qualify a product runtime, authorize publication, or renew test deadlines.
set -euo pipefail

if [[ "$(/usr/bin/uname -s)" != Linux || "${EUID}" -eq 0 ]]; then
  printf '%s\n' 'scientific_test_host_requires_linux_nonroot' >&2
  exit 1
fi
for scientific_bootstrap in /usr/bin/env /usr/bin/timeout /bin/true; do
  if [[ ! -x "$scientific_bootstrap" ]]; then
    printf 'scientific_test_host_missing_bootstrap:%s\n' "$scientific_bootstrap" >&2
    exit 1
  fi
done

scientific_packages=()
[[ -x /usr/bin/bwrap ]] || scientific_packages+=(bubblewrap)
[[ -x /usr/bin/strace ]] || scientific_packages+=(strace)
[[ -x /usr/bin/prlimit ]] || scientific_packages+=(util-linux)
if (( ${#scientific_packages[@]} )); then
  if [[ ! -x /usr/bin/sudo || ! -x /usr/bin/apt-get ]]; then
    printf '%s\n' 'scientific_test_host_package_manager_unavailable' >&2
    exit 1
  fi
  /usr/bin/sudo -n -- /usr/bin/apt-get -o Acquire::Retries=3 update
  /usr/bin/sudo -n -- /usr/bin/env DEBIAN_FRONTEND=noninteractive \
    /usr/bin/apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    "${scientific_packages[@]}"
fi
for scientific_tool in /usr/bin/bwrap /usr/bin/strace /usr/bin/prlimit; do
  if [[ ! -x "$scientific_tool" ]]; then
    printf 'scientific_test_host_missing_tool:%s\n' "$scientific_tool" >&2
    exit 1
  fi
done

scientific_apparmor_failure_diagnostics() {
  if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ]]; then
    return 0
  fi
  printf '%s\n' 'scientific_test_host_apparmor_failure_audit:3000ms:cleanup2000ms' >&2
  if [[ -x /usr/bin/sudo && -x /usr/bin/journalctl && -x /usr/bin/awk ]]; then
    if ! /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
      /usr/bin/timeout --signal=TERM --kill-after=2s 3s \
      /usr/bin/sudo -n -- /usr/bin/journalctl -k -n 500 --no-pager -o short-iso \
      | /usr/bin/awk '/apparmor|bwrap|userns/ { print; found=1 } END { if (!found) print "scientific_test_host_apparmor_audit_no_matching_rows" }'; then
      printf '%s\n' 'scientific_test_host_apparmor_audit_unavailable' >&2
    fi
  else
    printf '%s\n' 'scientific_test_host_apparmor_audit_tool_unavailable' >&2
  fi
}
# Diagnostics preserve the original failing operation's status.
trap 'scientific_original_status=$?; scientific_apparmor_failure_diagnostics; exit "$scientific_original_status"' ERR

# Provision only the reviewed executable-scoped policy on a fresh Noble CI host.
# The actual nonroot scientific probes below retain their original controls.
if [[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == Linux ]]; then
  scientific_os_id=''
  scientific_os_version=''
  while IFS='=' read -r scientific_os_key scientific_os_value; do
    scientific_os_value="${scientific_os_value#\"}"
    scientific_os_value="${scientific_os_value%\"}"
    case "$scientific_os_key" in
      ID) scientific_os_id="$scientific_os_value" ;;
      VERSION_ID) scientific_os_version="$scientific_os_value" ;;
    esac
  done < /etc/os-release
  if [[ "$scientific_os_id" == ubuntu && "$scientific_os_version" == 24.04 ]]; then
    [[ -x /usr/bin/sudo && -x /usr/bin/python3 ]] || {
      printf '%s\n' 'scientific_test_host_apparmor_bootstrap_unavailable' >&2
      exit 1
    }
    /usr/bin/sudo -n -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
      /usr/bin/python3 -I - "${BASH_SOURCE[0]%/*}/../apparmor/bwrap-userns-restrict" "${EUID}" "$$" <<'SCIENTIFIC_APPARMOR_PY'
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

EXPECTED = "11d39094f044f0cda0febb3ad517b830301da6b2ce929664af09ee9e4dd264f9"
POLICY = Path("/etc/apparmor.d/hepta-scientific-bwrap")
PARSER = Path("/usr/sbin/apparmor_parser")
KEYS = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_nlink",
        "st_size", "st_mtime_ns", "st_ctime_ns")

def emit(kind, **fields):
    print(json.dumps({"kind": kind, **fields}, sort_keys=True), flush=True)

def require(ok, cause):
    if not ok:
        raise SystemExit("scientific_test_host_apparmor:" + cause)

def pin(metadata):
    return {key: getattr(metadata, key) for key in KEYS}

def kernel_text(path):
    with Path(path).open("rb") as observed:
        raw = observed.read(256 * 1024 + 1)
    require(len(raw) <= 256 * 1024, "kernel_state_observation_limit:" + path)
    return raw.decode().strip()

require(os.geteuid() == 0 and sys.platform == "linux", "privileged_linux_setup_required")
enabled = kernel_text("/sys/module/apparmor/parameters/enabled")
restricted = kernel_text("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
emit("scientific_test_host_apparmor_state", kernel=os.uname().release,
     enabled=enabled, restrictedUnprivilegedUserns=restricted,
     maxUserNamespaces=kernel_text("/proc/sys/user/max_user_namespaces"))
if enabled != "Y" or restricted != "1":
    emit("scientific_test_host_apparmor_not_required")
    sys.exit(0)

for tool in (PARSER, Path("/usr/bin/bwrap")):
    metadata = tool.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0
            and not metadata.st_mode & 0o6022, "unsafe_installed_tool:" + str(tool))
    emit("scientific_test_host_installed_tool", path=str(tool), identity=pin(metadata))
try:
    capabilities = os.getxattr("/usr/bin/bwrap", "security.capability", follow_symlinks=False)
except OSError as error:
    require(error.errno in (errno.ENODATA, errno.ENOTSUP), "bwrap_capability_observation_failed")
else:
    require(not capabilities, "bwrap_file_capabilities_forbidden")
subprocess.run([str(PARSER), "--config-file", "/dev/null", "--version"], check=True,
               timeout=5, env=dict(os.environ))
profiles = kernel_text("/sys/kernel/security/apparmor/profiles").splitlines()
emit("scientific_test_host_apparmor_profiles_before", profiles=profiles)
require(not any("bwrap" in name for name in profiles), "loaded_bwrap_profile_conflict")
current_label = kernel_text("/proc/self/attr/current")
emit("scientific_test_host_apparmor_current_label", label=current_label)
require(current_label == "unconfined", "confined_setup_context_requires_review")
# Read actual kernel attachment expressions, rather than infer them from names.
# A disjoint literal prefix proves exclusion; other wildcard cases need review.
kernel_profiles = Path("/sys/kernel/security/apparmor/policy/profiles")
require(kernel_profiles.is_dir(), "kernel_attachment_inventory_unavailable")
attachments = []
pending_unconfined = []
for attached in kernel_profiles.rglob("attach"):
    require(len(attachments) < 512, "kernel_attachment_inventory_limit")
    name = kernel_text(str(attached.parent / "name"))
    expression = kernel_text(str(attached))
    mode = kernel_text(str(attached.parent / "mode"))
    row = {"name": name, "attach": expression, "mode": mode}
    attachments.append(row)
    emit("scientific_test_host_apparmor_attachment", **row)
    require(expression, "kernel_attachment_missing:" + name)
    if expression == "<unknown>":
        require(mode == "unconfined", "kernel_attachment_unknown:" + name)
        pending_unconfined.append(row)
        continue  # Pending only: complete effective child and real denial are mandatory.
    metacharacters = "*?[]{}\\@^"
    special = [index for index, char in enumerate(expression) if char in metacharacters]
    if expression == name and not expression.startswith("/") and not special:
        continue  # Kernel fallback name for a profile with no exec attachment.
    if special:
        prefix = expression[:min(special)]
        require(prefix.startswith("/") and not "/usr/bin/bwrap".startswith(prefix),
                "potential_bwrap_attachment_conflict:" + name)
    else:
        require(expression.startswith("/") and expression != "/usr/bin/bwrap",
                "bwrap_attachment_conflict_or_unknown:" + name)
require(len(attachments) == len(profiles), "kernel_attachment_inventory_incomplete")
require(kernel_text("/sys/kernel/security/apparmor/profiles").splitlines() == profiles,
        "kernel_profile_inventory_changed")
emit("scientific_test_host_apparmor_attachment_inventory", observedCount=len(attachments),
     pendingUnconfined=pending_unconfined)
directory = POLICY.parent
metadata = directory.lstat()
require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == 0
        and not metadata.st_mode & 0o022 and directory.resolve() == directory,
        "unsafe_policy_directory")
require(not os.path.lexists(POLICY), "existing_policy_destination_conflict")
for local in (directory / "local/bwrap-userns-restrict", directory / "local/unpriv_bwrap"):
    require(not os.path.lexists(local), "local_policy_override_conflict:" + str(local))
for installed in sorted(directory.iterdir()):
    installed_metadata = installed.lstat()
    require(not stat.S_ISLNK(installed_metadata.st_mode),
            "installed_policy_symlink_requires_review:" + str(installed))
    if stat.S_ISREG(installed_metadata.st_mode):
        require(installed_metadata.st_uid == 0 and not installed_metadata.st_mode & 0o022,
                "unsafe_installed_policy:" + str(installed))
        descriptor = os.open(installed, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as held:
            require(pin(os.fstat(held.fileno())) == pin(installed_metadata),
                    "installed_policy_changed:" + str(installed))
            text = held.read(1024 * 1024 + 1)
            require(pin(os.fstat(held.fileno())) == pin(installed_metadata)
                    and pin(installed.lstat()) == pin(installed_metadata),
                    "installed_policy_changed:" + str(installed))
        require(len(text) <= 1024 * 1024, "installed_policy_observation_limit")
        require(b"/usr/bin/bwrap" not in text and b"unpriv_bwrap" not in text,
                "installed_bwrap_profile_conflict:" + str(installed))
abi = directory / "abi/4.0"
abi_metadata = abi.lstat()
require(stat.S_ISREG(abi_metadata.st_mode) and abi_metadata.st_uid == 0
        and not abi_metadata.st_mode & 0o022, "unsafe_or_missing_abi4")
emit("scientific_test_host_apparmor_abi", path=str(abi), identity=pin(abi_metadata),
     sha256=hashlib.sha256(abi.read_bytes()).hexdigest())
source = Path(sys.argv[1])
descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(descriptor, "rb") as held:
    before = held.fileno()
    metadata = os.fstat(before)
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
            and metadata.st_size == 1936, "unsafe_vendored_policy")
    identity = pin(metadata)
    raw = held.read(1937)
    require(pin(os.fstat(before)) == identity and pin(source.lstat()) == identity,
            "vendored_policy_changed")
require(hashlib.sha256(raw).hexdigest() == EXPECTED, "vendored_policy_hash_mismatch")
emit("scientific_test_host_vendored_policy", sha256=EXPECTED, identity=identity)
arguments = [str(PARSER), "--config-file", "/dev/null", "--skip-cache", "--jobs=0",
             "--base", str(directory), "--warn=rule-not-enforced", "--Werror=rule-not-enforced"]
# Compile the pinned bytes against this actual kernel before any host write.
subprocess.run([*arguments, "--skip-kernel-load", "--add"], input=raw, check=True, timeout=5)
descriptor = os.open(POLICY, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
with os.fdopen(descriptor, "wb") as installed:
    os.fchmod(installed.fileno(), 0o644)
    installed.write(raw)
    installed.flush()
    os.fsync(installed.fileno())
    installed_identity = pin(os.fstat(installed.fileno()))
require(pin(POLICY.lstat()) == installed_identity and POLICY.read_bytes() == raw,
        "installed_policy_changed")
emit("scientific_test_host_policy_install", path=str(POLICY), sha256=EXPECTED,
     identity=installed_identity)
# --add refuses an existing policy; no other application's policy is replaced.
subprocess.run([*arguments, "--add"], input=raw, check=True, timeout=5)
after = kernel_text("/sys/kernel/security/apparmor/profiles").splitlines()
emit("scientific_test_host_apparmor_profiles_after", profiles=after)
require("bwrap (enforce)" in after and "unpriv_bwrap (enforce)" in after,
        "expected_enforced_profiles_not_observed")
require(len(after) == len(profiles) + 2
        and set(after) == set(profiles) | {"bwrap (enforce)", "unpriv_bwrap (enforce)"},
        "unexpected_kernel_profile_state_change")
require(kernel_text("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") == restricted,
        "global_userns_restriction_changed")
def exact_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "ambiguous_guard_json")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)

def proc_status(pid):
    rows = {}
    for line in kernel_text("/proc/" + str(pid) + "/status").splitlines():
        key, separator, value = line.partition(":")
        require(separator and key not in rows, "ambiguous_guard_proc_status")
        rows[key] = value.split()
    return rows

def proc_start(pid):
    raw = kernel_text("/proc/" + str(pid) + "/stat")
    fields = raw.rsplit(")", 1)
    require(len(fields) == 2 and fields[0].split(" ", 1)[0] == str(pid),
            "guard_proc_stat_identity_invalid")
    tail = fields[1].split()
    require(len(tail) >= 20 and tail[19].isdigit(), "guard_proc_start_invalid")
    return int(tail[19])

# BEGIN EXACT CONTROLLER4 PIDFD OWNERSHIP HELPER
import os,signal
from pathlib import Path

def _owned_proc_identity(pid):
    p=Path('/proc')/str(pid)
    try:
        with (p/'stat').open('r') as f:
            raw=f.read(4097)
        if len(raw)>4096:
            raise RuntimeError('owned process stat exceeds fixed bound')
        fields=raw.rsplit(') ',1)[1].split()
        uid=p.stat().st_uid
        return {'state':fields[0],'starttime':fields[19],'uid':uid,'pgid':int(fields[2]),'sid':int(fields[3])}
    except (FileNotFoundError,ProcessLookupError):
        return None

def _owned_pidfd_target(fd):
    with (Path('/proc/self/fdinfo')/str(fd)).open('r') as f:
        raw=f.read(4097)
    if len(raw)>4096:
        raise RuntimeError('owned pidfd info exceeds fixed bound')
    values=[line.split(':',1)[1].strip() for line in raw.splitlines() if line.startswith('Pid:')]
    if len(values)!=1:
        raise RuntimeError('owned pidfd target is unavailable')
    return int(values[0])

def _owned_identity_matches(actual, expected):
    return actual is not None and all(actual[key]==expected[key] for key in ('starttime','uid','pgid','sid'))

def record_owned_descendants(snapshot, owned, refusals):
    changed=False
    for pid, actual in snapshot.items():
        parent=actual['parent']
        if pid in owned or parent not in owned:
            continue
        current_parent=snapshot.get(parent)
        if current_parent is None or current_parent['starttime']!=owned[parent]['starttime']:
            key=(pid,actual['starttime'],parent)
            if key not in refusals['keys']:
                if len(refusals['entries'])<128:
                    refusals['keys'].add(key)
                    refusals['entries'].append({'pid':pid,'observed':actual,'parent':parent,
                                                'originalParent':owned[parent],'currentParent':current_parent,
                                                'refusal':'original_parent_starttime_changed_or_absent'})
                else:
                    refusals['omittedObservations']+=1
            continue
        owned[pid]=actual
        changed=True
    return changed

def pidfd_signal_owned(pid, expected, signum):
    if (type(pid) is not int or pid<=0 or set(expected)!=set(('starttime','uid','pgid','sid'))
            or not isinstance(expected['starttime'],str) or not expected['starttime'].isdecimal()
            or any(type(expected[k]) is not int or expected[k]<0 for k in ('uid','pgid','sid'))
            or signum not in (int(signal.SIGTERM),int(signal.SIGKILL))):
        raise RuntimeError('invalid exact owned cleanup input')
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
        return {'signalSent':False,'refusal':'pidfd_unavailable'}
    try:
        fd=os.pidfd_open(pid,0)
    except ProcessLookupError:
        return {'signalSent':False,'targetGone':True,'phase':'pidfd_open'}
    try:
        before=_owned_proc_identity(pid)
        fd_target=_owned_pidfd_target(fd)
        if before is None or fd_target==-1 or before['state'] in ('Z','X'):
            return {'signalSent':False,'targetGone':True,'pidfdTargetBefore':fd_target,'before':before}
        if fd_target!=pid or not _owned_identity_matches(before,expected):
            return {'signalSent':False,'refusal':'original_owned_identity_changed','pidfdTargetBefore':fd_target,'before':before,'expected':expected}
        before_send=_owned_proc_identity(pid)
        fd_target_before_send=_owned_pidfd_target(fd)
        if before_send is None or fd_target_before_send==-1 or before_send['state'] in ('Z','X'):
            return {'signalSent':False,'targetGone':True,'pidfdTargetBefore':fd_target_before_send,'before':before,'beforeSend':before_send}
        if fd_target_before_send!=pid or not _owned_identity_matches(before_send,expected):
            return {'signalSent':False,'refusal':'original_owned_identity_changed_before_signal','before':before,'beforeSend':before_send,'expected':expected}
        try:
            signal.pidfd_send_signal(fd,signum,None,0)
        except ProcessLookupError:
            return {'signalSent':False,'targetGone':True,'phase':'pidfd_send_signal','before':before,'beforeSend':before_send}
        except PermissionError:
            raise
        except OSError as cause:
            return {'signalSent':None,'signalAttempted':True,'outcome':'unknown','phase':'pidfd_send_signal','cause':str(cause),'before':before,'beforeSend':before_send}
        try:
            after=_owned_proc_identity(pid)
            fd_target_after=_owned_pidfd_target(fd)
        except (OSError,RuntimeError,ValueError,IndexError) as cause:
            return {'signalSent':True,'pidfdTargetBefore':fd_target,'pidfdTargetBeforeSend':fd_target_before_send,
                    'before':before,'beforeSend':before_send,'postflightState':'inspection_unavailable_after_actual_signal',
                    'postflightCause':str(cause)}
        if fd_target_after==-1 or after is None or after['state'] in ('Z','X'):
            state='target_exited'
        elif fd_target_after==pid and _owned_identity_matches(after,expected):
            state='original_owned_identity_current'
        else:
            state='identity_changed_after_actual_signal'
        return {'signalSent':True,'pidfdTargetBefore':fd_target,'pidfdTargetBeforeSend':fd_target_before_send,'pidfdTargetAfter':fd_target_after,
                'before':before,'beforeSend':before_send,'after':after,'postflightState':state}
    finally:
        os.close(fd)
# END EXACT CONTROLLER4 PIDFD OWNERSHIP HELPER

def effective_child_guard():
    # This is an independent CI guard, with one absolute five-second budget.
    # Unknown attachments are pending evidence until this real child is checked.
    deadline = time.monotonic() + 5.0
    started_us = time.monotonic_ns() // 1000
    owners = []
    owned = {}
    ownership_refusals = {"keys": set(), "entries": [], "omittedObservations": 0}
    expected_label = "bwrap//&unpriv_bwrap (enforce)"
    nonce = os.urandom(16).hex()
    caller_uid, caller_pid = int(sys.argv[2]), int(sys.argv[3])
    require(caller_uid > 0 and caller_pid > 0, "guard_nonroot_caller_required")
    caller = proc_status(caller_pid)
    require(caller.get("Uid") == [str(caller_uid)] * 4
            and len(caller.get("Gid", [])) == 4
            and len(set(caller["Gid"])) == 1
            and caller["Gid"][0].isdigit(), "guard_actual_caller_identity_invalid")
    caller_gid = int(caller["Gid"][0])
    caller_start = proc_start(caller_pid)
    pid_namespace = os.readlink("/proc/self/ns/pid")
    boot_id = kernel_text("/proc/sys/kernel/random/boot_id").replace("-", "")
    fixed_environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}

    def remaining():
        budget = deadline - time.monotonic()
        require(budget > 0, "effective_child_guard_deadline")
        return budget

    def ownership_refusal(refusal, **fields):
        key = (refusal, fields.get("pid"), fields.get("starttime"), fields.get("parent"))
        if key not in ownership_refusals["keys"]:
            if len(ownership_refusals["entries"]) < 128:
                ownership_refusals["keys"].add(key)
                ownership_refusals["entries"].append({"refusal": refusal, **fields})
            else:
                ownership_refusals["omittedObservations"] += 1

    def ownership_time(limit):
        if time.monotonic() >= limit:
            raise RuntimeError("owned process observation deadline")

    def observed_process(pid):
        before = _owned_proc_identity(pid)
        if before is None:
            return None
        try:
            with (Path("/proc") / str(pid) / "stat").open("r") as observed:
                raw = observed.read(4097)
        except (FileNotFoundError, ProcessLookupError):
            return None
        if len(raw) > 4096:
            raise RuntimeError("owned process stat exceeds fixed bound")
        parts = raw.rsplit(") ", 1)
        if len(parts) != 2 or parts[0].split(" ", 1)[0] != str(pid):
            raise RuntimeError("owned process stat PID is ambiguous")
        fields = parts[1].split()
        if len(fields) < 20 or not fields[19].isdecimal():
            raise RuntimeError("owned process stat is incomplete")
        row = {"state": fields[0], "parent": int(fields[1]), "pgid": int(fields[2]),
               "sid": int(fields[3]), "starttime": fields[19], "uid": before["uid"]}
        after_identity = _owned_proc_identity(pid)
        if after_identity is None:
            return None
        if not _owned_identity_matches(row, before) or not _owned_identity_matches(row, after_identity):
            raise RuntimeError("owned process snapshot identity changed")
        return row

    def ownership_snapshot(limit):
        snapshot = {}
        count = 0
        for path in Path("/proc").iterdir():
            ownership_time(limit)
            if not path.name.isdecimal():
                continue
            count += 1
            if count > 4096:
                raise RuntimeError("owned process inventory exceeds fixed bound")
            pid = int(path.name)
            actual = observed_process(pid)
            if actual is not None:
                snapshot[pid] = actual
        return snapshot

    def observe_owned(limit):
        snapshot = ownership_snapshot(limit)
        changed = True
        while changed:
            ownership_time(limit)
            candidates = [(pid, row) for pid, row in snapshot.items()
                          if pid not in owned and row["parent"] in owned]
            if len(owned) + len(candidates) > 128:
                raise RuntimeError("owned descendants exceed fixed bound")
            validated = dict(snapshot)
            # Re-observe each original parent after the child's snapshot. The
            # unchanged helper also checks its original parent start identity.
            for parent in {row["parent"] for _, row in candidates}:
                ownership_time(limit)
                current_parent = _owned_proc_identity(parent)
                if current_parent is None:
                    validated.pop(parent, None)
                else:
                    validated[parent] = {**validated.get(parent, {}), **current_parent}
            changed = record_owned_descendants(validated, owned, ownership_refusals)
        for pid, original in owned.items():
            actual = snapshot.get(pid)
            if actual is not None and not _owned_identity_matches(actual, original):
                ownership_refusal("original_owned_identity_changed", pid=pid,
                                  starttime=original["starttime"], original=original, observed=actual)
        for owner in owners:
            original = owner["binding"]
            if original is None:
                continue
            for pid, actual in snapshot.items():
                if actual["pgid"] == original["pgid"] and actual["sid"] == original["sid"]:
                    expected = owned.get(pid)
                    if expected is None or not _owned_identity_matches(actual, expected):
                        ownership_refusal("unknown_or_changed_original_group_member", pid=pid,
                                          starttime=actual["starttime"], observed=actual,
                                          originalMonitor=original)
        return snapshot

    def spawn(arguments, output_limit, error_limit, nonroot=False):
        remaining()
        options = {"user": caller_uid, "group": caller_gid, "extra_groups": []} if nonroot else {}
        # Arm the owner before Popen; returned PID is stored before any I/O.
        owner = {"process": None, "binding": None, "out": bytearray(), "err": bytearray(),
                 "limits": {"out": output_limit, "err": error_limit}, "open": {"out", "err"}}
        owners.append(owner)
        process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=fixed_environment, cwd="/",
                                   start_new_session=True, **options)
        owner["process"] = process
        actual = observed_process(process.pid)
        require(actual is not None and actual["parent"] == os.getpid()
                and actual["uid"] == (caller_uid if nonroot else os.geteuid())
                and actual["pgid"] == process.pid and actual["sid"] == process.pid,
                "guard_spawn_actual_owner_binding_required")
        owner["binding"] = dict(actual)
        owned[process.pid] = dict(actual)
        for stream in (process.stdout, process.stderr):
            os.set_blocking(stream.fileno(), False)
        observe_owned(deadline)
        return owner

    def capture(owner, ready=False):
        process = owner["process"]
        with selectors.DefaultSelector() as observed:
            for key, stream in (("out", process.stdout), ("err", process.stderr)):
                if key in owner["open"]:
                    observed.register(stream, selectors.EVENT_READ, key)
            while True:
                observe_owned(deadline)
                if ready and b"\n" in owner["out"]:
                    return bytes(owner["out"]).split(b"\n", 1)[0]
                if not owner["open"] and process.poll() is not None:
                    require(process.returncode == 0, "guard_observation_process_failed")
                    return bytes(owner["out"])
                budget = min(remaining(), 0.05)
                if not owner["open"]:
                    try:
                        process.wait(timeout=budget)
                    except subprocess.TimeoutExpired:
                        pass
                    continue
                for key, _ in observed.select(budget):
                    chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                    name = key.data
                    if not chunk:
                        observed.unregister(key.fileobj)
                        owner["open"].remove(name)
                    else:
                        owner[name].extend(chunk)
                        require(len(owner[name]) <= owner["limits"][name],
                                "guard_observation_output_limit")

    def journal(arguments):
        observed = spawn(["/usr/bin/journalctl", "-k", "--no-pager", "-o", "json", *arguments],
                         512 * 1024, 16 * 1024)
        raw = capture(observed)
        result = []
        for line in raw.splitlines():
            row = exact_json(line)
            require(isinstance(row, dict), "guard_journal_row_invalid")
            result.append(row)
        return result

    def live_child(frame):
        pid = frame["pid"]
        require(type(pid) is int and pid > 0 and type(frame["startTime"]) is int,
                "guard_child_pid_invalid")
        actual_owned = observe_owned(deadline).get(pid)
        require(pid in owned and owned[pid]["starttime"] == str(frame["startTime"])
                and _owned_identity_matches(actual_owned, owned[pid]),
                "guard_live_child_original_ownership_required")
        before_start = proc_start(pid)
        status = proc_status(pid)
        label = kernel_text("/proc/" + str(pid) + "/attr/current")
        require(before_start == frame["startTime"] == proc_start(pid)
                and status.get("Uid") == [str(caller_uid)] * 4
                and status.get("NSpid") == [str(pid)]
                and os.readlink("/proc/" + str(pid) + "/ns/pid") == pid_namespace
                and frame["pidNamespace"] == pid_namespace
                and label == expected_label
                and status.get("CapEff") is not None and len(status["CapEff"]) == 1
                and int(status["CapEff"][0], 16) & (1 << 21)
                and int(status["CapEff"][0], 16) == frame["capEffAfter"],
                "guard_child_not_live_or_identity_changed")
        return pid

    def cleanup():
        # One shared budget, with individual original-identity pidfds only.
        # Unknown or reused identities remain inspection facts, never targets.
        cleanup_deadline = time.monotonic() + 2.0
        clean = True
        signals = []
        final_snapshot = None

        def snapshot_for_cleanup():
            nonlocal clean
            try:
                return observe_owned(cleanup_deadline)
            except BaseException as cause:
                clean = False
                ownership_refusal("cleanup_observation_unavailable",
                                  cause=type(cause).__name__ + ":" + str(cause))
                return None

        def monitors_done():
            nonlocal clean
            done = True
            for owner in owners:
                process = owner["process"]
                if process is None:
                    clean = False
                    ownership_refusal("spawn_did_not_return_an_observable_owner")
                    continue
                if owner["binding"] is None:
                    clean = False
                    ownership_refusal("returned_owner_lacks_original_binding", pid=process.pid)
                try:
                    if process.poll() is None:
                        done = False
                except BaseException as cause:
                    clean = False
                    done = False
                    ownership_refusal("monitor_state_unavailable", pid=process.pid,
                                      cause=type(cause).__name__ + ":" + str(cause))
            return done

        def remaining_live(snapshot):
            if snapshot is None:
                return None
            return {pid: actual for pid, actual in snapshot.items()
                    if pid in owned and actual["state"] not in ("Z", "X")
                    and _owned_identity_matches(actual, owned[pid])}

        def signal_phase(signum):
            nonlocal clean
            snapshot_for_cleanup()
            for pid, original in list(owned.items()):
                if time.monotonic() >= cleanup_deadline:
                    clean = False
                    ownership_refusal("cleanup_signal_budget_expired", pid=pid,
                                      starttime=original["starttime"])
                    break
                expected = {key: original[key] for key in ("starttime", "uid", "pgid", "sid")}
                try:
                    actual = pidfd_signal_owned(pid, expected, int(signum))
                except BaseException as cause:
                    clean = False
                    actual = {"signalSent": None, "outcome": "unknown",
                              "cause": type(cause).__name__ + ":" + str(cause)}
                signals.append({"pid": pid, "originalExpected": expected,
                                "signal": signal.Signals(signum).name, "actual": actual})
                if (actual.get("refusal") or actual.get("outcome") == "unknown"
                        or actual.get("postflightState") in (
                            "inspection_unavailable_after_actual_signal", "identity_changed_after_actual_signal")):
                    clean = False

        try:
            signal_phase(signal.SIGTERM)
            grace_deadline = min(cleanup_deadline, time.monotonic() + 0.5)
            while time.monotonic() < grace_deadline:
                final_snapshot = snapshot_for_cleanup()
                live = remaining_live(final_snapshot)
                done = monitors_done()
                if live is not None and not live and done:
                    break
                time.sleep(min(0.025, max(0.0, grace_deadline - time.monotonic())))
            signal_phase(signal.SIGKILL)
            while time.monotonic() < cleanup_deadline:
                final_snapshot = snapshot_for_cleanup()
                live = remaining_live(final_snapshot)
                done = monitors_done()
                if live is not None and not live and done:
                    break
                time.sleep(min(0.025, max(0.0, cleanup_deadline - time.monotonic())))
            if time.monotonic() >= cleanup_deadline:
                clean = False
                ownership_refusal("cleanup_shared_deadline_expired")
            if remaining_live(final_snapshot) is None or remaining_live(final_snapshot) or not monitors_done():
                clean = False
        except BaseException as cause:
            clean = False
            ownership_refusal("cleanup_incomplete", cause=type(cause).__name__ + ":" + str(cause))
        finally:
            for owner in owners:
                process = owner["process"]
                if process is None:
                    continue
                for stream in (process.stdin, process.stdout, process.stderr):
                    try:
                        stream.close()
                    except BaseException as cause:
                        clean = False
                        ownership_refusal("cleanup_stream_close_unavailable", pid=process.pid,
                                          cause=type(cause).__name__ + ":" + str(cause))
        if time.monotonic() >= cleanup_deadline:
            clean = False
            ownership_refusal("cleanup_shared_deadline_expired_after_close")
        if ownership_refusals["entries"] or ownership_refusals["omittedObservations"]:
            clean = False
        try:
            emit("scientific_test_host_apparmor_guard_cleanup", complete=clean,
                 cleanupMillis=2000, strategy="exact_owned_pidfds", ownedProcesses=owned,
                 signals=signals, remainingOwnedLive=remaining_live(final_snapshot),
                 ownershipRefusals=ownership_refusals["entries"],
                 omittedOwnershipRefusals=ownership_refusals["omittedObservations"],
                 requiresInspection=not clean)
        except BaseException:
            # Reporting failure cannot prevent completed ownership cleanup.
            clean = False
        return clean

    child_source = r'''
import ctypes, errno, json, os, sys
from pathlib import Path

def require(ok, cause):
    if not ok:
        raise SystemExit("scientific_test_host_apparmor_child:" + cause)

def status():
    rows = {}
    for line in Path("/proc/self/status").read_text().splitlines():
        key, separator, value = line.partition(":")
        require(separator and key not in rows, "ambiguous_status")
        rows[key] = value.split()
    return rows

def label():
    return Path("/proc/self/attr/current").read_text().strip()

expected = "bwrap//&unpriv_bwrap (enforce)"
nonce = sys.argv[1]
require(label() == expected, "complete_enforced_stack_required")
pid = os.getpid()
before = status()
require(before.get("NSpid") == [str(pid)], "host_pid_required")
start = Path("/proc/self/stat").read_text().rsplit(")", 1)[1].split()[19]
require(start.isdigit(), "start_time_required")
pid_namespace = os.readlink("/proc/self/ns/pid")
old_user_namespace = os.readlink("/proc/self/ns/user")
libc = ctypes.CDLL(None, use_errno=True)
libc.unshare.argtypes = [ctypes.c_int]
libc.unshare.restype = ctypes.c_int
ctypes.set_errno(0)
require(libc.unshare(0x10000000) == 0, "new_user_namespace_required")
require(os.readlink("/proc/self/ns/user") != old_user_namespace, "user_namespace_identity_unchanged")
after = status()
require(after.get("CapEff") is not None and len(after["CapEff"]) == 1, "capability_observation_required")
cap_effective = int(after["CapEff"][0], 16)
require(cap_effective & (1 << 21), "effective_sys_admin_bit_required")
require(label() == expected, "stack_changed_before_capability_test")
ctypes.set_errno(0)
result = libc.unshare(0x00020000)
error = ctypes.get_errno()
require(result == -1 and error == errno.EPERM, "actual_sys_admin_refusal_required")
require(label() == expected, "stack_changed_after_capability_test")
print(json.dumps({"kind": "scientific_test_host_apparmor_child_ready", "nonce": nonce,
                  "pid": pid, "startTime": int(start), "pidNamespace": pid_namespace,
                  "labelBefore": expected, "labelAfter": label(),
                  "capEffAfter": cap_effective, "unshareResult": result, "unshareErrno": error},
                 sort_keys=True), flush=True)
# Remain alive until the same-PID kernel audit and identity have been checked.
require(sys.stdin.readline(34) == nonce + "\n", "parent_audit_ack_required")
require(label() == expected, "stack_changed_before_ack")
print(json.dumps({"kind": "scientific_test_host_apparmor_child_ack", "nonce": nonce,
                  "pid": pid, "label": label()}, sort_keys=True), flush=True)
'''

    failure = None
    try:
        require(hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"),
                "guard_exact_owned_pidfd_api_required")
        cursor_rows = journal(["-n", "1"])
        require(len(cursor_rows) == 1, "guard_journal_cursor_required")
        cursor_row = cursor_rows[0]
        cursor = cursor_row.get("__CURSOR")
        require(isinstance(cursor, str) and 0 < len(cursor) <= 4096
                and "\n" not in cursor and "\0" not in cursor
                and cursor_row.get("_TRANSPORT") == "kernel"
                and cursor_row.get("_BOOT_ID") == boot_id,
                "guard_journal_cursor_invalid")
        require(proc_start(caller_pid) == caller_start
                and proc_status(caller_pid).get("Uid") == [str(caller_uid)] * 4,
                "guard_caller_changed")
        emit("scientific_test_host_apparmor_guard_begin", callerUid=caller_uid,
             callerGid=caller_gid, callerPid=caller_pid, callerStartTime=caller_start,
             cursor=cursor, bootId=boot_id, nonce=nonce, deadlineMillis=5000, cleanupMillis=2000)
        guard = spawn(["/usr/bin/timeout", "--signal=TERM", "--kill-after=2s",
                       format(remaining(), ".9f") + "s", "/usr/bin/bwrap",
                       "--unshare-user-try", "--unshare-net", "--die-with-parent", "--ro-bind", "/", "/",
                       "/usr/bin/python3", "-I", "-c", child_source, nonce], 8 * 1024, 32 * 1024,
                      nonroot=True)
        frame = exact_json(capture(guard, ready=True))
        require(isinstance(frame, dict) and set(frame) == {
            "kind", "nonce", "pid", "startTime", "pidNamespace", "labelBefore", "labelAfter",
            "capEffAfter", "unshareResult", "unshareErrno"}, "guard_child_frame_invalid")
        require(frame["kind"] == "scientific_test_host_apparmor_child_ready"
                and frame["nonce"] == nonce and frame["labelBefore"] == expected_label
                and frame["labelAfter"] == expected_label and type(frame["capEffAfter"]) is int
                and frame["capEffAfter"] & (1 << 21)
                and type(frame["unshareResult"]) is int and frame["unshareResult"] == -1
                and type(frame["unshareErrno"]) is int and frame["unshareErrno"] == errno.EPERM
                and guard["process"].poll() is None, "guard_child_refusal_or_label_invalid")
        pid = live_child(frame)
        emit("scientific_test_host_apparmor_effective_child", frame=frame)
        matches = []
        audit_rows = journal(["--after-cursor", cursor, "-n", "500"])
        for row in audit_rows:
            message = row.get("MESSAGE")
            if not isinstance(message, str):
                continue
            fields = {}
            ambiguous = False
            for match in re.finditer(r'(?:^|\s)([A-Za-z_]+)=("[^"\n]*"|[^\s]+)', message):
                name, value = match.groups()
                if name in fields:
                    ambiguous = True
                fields[name] = value[1:-1] if value.startswith('"') else value
            if fields.get("pid") != str(pid):
                continue
            require(not ambiguous, "ambiguous_guard_pid_audit")
            if fields.get("apparmor") != "DENIED" or fields.get("operation") != "capable":
                continue
            require(row.get("_TRANSPORT") == "kernel" and row.get("_BOOT_ID") == boot_id
                    and isinstance(row.get("__CURSOR"), str) and row["__CURSOR"] != cursor
                    and isinstance(row.get("__MONOTONIC_TIMESTAMP"), str)
                    and row["__MONOTONIC_TIMESTAMP"].isdigit()
                    and started_us <= int(row["__MONOTONIC_TIMESTAMP"]) <= time.monotonic_ns() // 1000
                    and fields.get("profile") == "unpriv_bwrap" and "namespace" not in fields
                    and fields.get("capability") == "21" and fields.get("capname") == "sys_admin",
                    "guard_pid_audit_not_exact_capability_refusal")
            matches.append(row)
        require(len(matches) == 1, "guard_exact_pid_capability_audit_required")
        remaining()
        require(live_child(frame) == pid and guard["process"].poll() is None,
                "guard_child_changed_before_ack")
        emit("scientific_test_host_apparmor_capability_refusal_audit", pid=pid,
             startTime=frame["startTime"], nonce=nonce, audit=matches[0])
        guard["process"].stdin.write((nonce + "\n").encode())
        guard["process"].stdin.flush()
        transcript = capture(guard)
        rows = transcript.splitlines()
        require(len(rows) == 2 and exact_json(rows[0]) == frame, "guard_child_transcript_invalid")
        ack = exact_json(rows[1])
        require(ack == {"kind": "scientific_test_host_apparmor_child_ack", "nonce": nonce,
                        "pid": pid, "label": expected_label}, "guard_child_final_ack_invalid")
        remaining()
        final_profiles = kernel_text("/sys/kernel/security/apparmor/profiles").splitlines()
        final_restriction = kernel_text("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        emit("scientific_test_host_apparmor_guard_kernel_state", profiles=final_profiles,
             restrictedUnprivilegedUserns=final_restriction)
        require(sorted(final_profiles) == sorted(after) and final_restriction == restricted,
                "guard_kernel_policy_or_global_state_changed")
        remaining()
    except BaseException as error:
        failure = error
        try:
            emit("scientific_test_host_apparmor_effective_child_guard_failure",
                 cause=type(error).__name__ + ":" + str(error), nonce=nonce,
                 observations=[{"ownerPid": owner["process"].pid if owner["process"] else None,
                                "returnCode": owner["process"].poll() if owner["process"] else None,
                                "stdoutTail": bytes(owner["out"][-2048:]).decode("utf-8", errors="replace"),
                                "stderrTail": bytes(owner["err"][-4096:]).decode("utf-8", errors="replace")}
                               for owner in owners])
        except BaseException:
            pass  # A failed diagnostic sink must still reach ownership cleanup.
    finally:
        try:
            clean = cleanup()
        except BaseException as cleanup_error:
            clean = False
            if failure is None:
                failure = cleanup_error
    if failure is not None:
        raise failure
    require(clean, "effective_child_guard_cleanup_incomplete")
    remaining()
    emit("scientific_test_host_apparmor_effective_child_guard_passed", pid=pid,
         nonce=nonce, label=expected_label, deadlineMillis=5000, cleanupMillis=2000,
         runtimeQualified=False)

effective_child_guard()

emit("scientific_test_host_apparmor_compatibility_provisioned", runtimeQualified=False)
SCIENTIFIC_APPARMOR_PY
  fi
fi
# GNU timeout owns a separate process group for each probe; TERM is followed
# by KILL after two seconds. --foreground would remove that group boundary.
printf '%s\n' 'scientific_test_host_probe:bwrap:5000ms:cleanup2000ms'
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  /usr/bin/timeout --signal=TERM --kill-after=2s 5s \
  /usr/bin/bwrap --unshare-user-try --unshare-net --die-with-parent \
  --ro-bind / / /bin/true

printf '%s\n' 'scientific_test_host_probe:prlimit:3000ms:cleanup2000ms'
scientific_nproc="$(
  /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    /usr/bin/timeout --signal=TERM --kill-after=2s 3s \
    /usr/bin/prlimit --nproc=17:17 -- \
    /usr/bin/prlimit --nproc --noheadings --output SOFT,HARD
)"
if [[ ! "$scientific_nproc" =~ ^[[:space:]]*17[[:space:]]+17[[:space:]]*$ ]]; then
  printf 'scientific_test_host_nproc_mismatch:%s\n' "$scientific_nproc" >&2
  exit 1
fi
printf 'scientific_test_host_nproc:%s\n' "$scientific_nproc"

printf '%s\n' 'scientific_test_host_probe:strace:3000ms:cleanup2000ms'
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  /usr/bin/timeout --signal=TERM --kill-after=2s 3s \
  /usr/bin/strace -qq -e trace=none /bin/true

printf 'scientific_test_host_probes_passed:linux_nonroot_uid=%s\n' "${EUID}"
