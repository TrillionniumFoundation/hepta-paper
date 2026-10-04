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
      /usr/bin/python3 -I - "${BASH_SOURCE[0]%/*}/../apparmor/bwrap-userns-restrict" <<'SCIENTIFIC_APPARMOR_PY'
import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

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
for attached in kernel_profiles.rglob("attach"):
    require(len(attachments) < 512, "kernel_attachment_inventory_limit")
    name = kernel_text(str(attached.parent / "name"))
    expression = kernel_text(str(attached))
    mode = kernel_text(str(attached.parent / "mode"))
    row = {"name": name, "attach": expression, "mode": mode}
    attachments.append(row)
    emit("scientific_test_host_apparmor_attachment", **row)
    require(expression and expression != "<unknown>", "kernel_attachment_unknown:" + name)
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
emit("scientific_test_host_apparmor_attachment_inventory", observedCount=len(attachments))
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
require(set(after) == set(profiles) | {"bwrap (enforce)", "unpriv_bwrap (enforce)"},
        "unexpected_kernel_profile_state_change")
require(kernel_text("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") == restricted,
        "global_userns_restriction_changed")
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
