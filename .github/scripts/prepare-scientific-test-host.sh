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
