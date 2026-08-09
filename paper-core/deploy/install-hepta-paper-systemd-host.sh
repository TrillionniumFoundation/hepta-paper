#!/bin/sh
set -eu

if [ "${HEPTA_HOST_INSTALL_SANITIZED:-}" != 1 ]; then
  exec /usr/bin/env -i \
    PATH=/usr/sbin:/usr/bin \
    LC_ALL=C \
    HEPTA_HOST_INSTALL_SANITIZED=1 \
    /bin/sh "$0" "$@"
fi

install_root=/
manage_systemd=yes
enable_full_auto=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      [ "$#" -ge 2 ] || { echo "--root requires an absolute path" >&2; exit 64; }
      install_root=$2
      shift 2
      ;;
    --no-systemctl)
      manage_systemd=no
      shift
      ;;
    --enable-full-auto)
      if [ "$enable_full_auto" = yes ]; then
        echo "duplicate option: --enable-full-auto" >&2
        exit 64
      fi
      enable_full_auto=yes
      shift
      ;;
    *)
      echo "usage: install-hepta-paper-systemd-host.sh [--root PATH --no-systemctl] [--enable-full-auto]" >&2
      exit 64
      ;;
  esac
done
case "$install_root" in
  /*) ;;
  *) echo "install root must be absolute" >&2; exit 64 ;;
esac
if [ "$install_root" != / ] && [ "$manage_systemd" != no ]; then
  echo "--root requires --no-systemctl" >&2
  exit 64
fi
if [ "$enable_full_auto" = yes ]; then
  echo "hepta_full_auto_enable_blocked:non_mutating_accepted_readiness_preflight_unavailable" >&2
  echo "production hold remains required; use the strict acceptance operator separately and do not enable resident automation from the host installer" >&2
  exit 78
fi

effective_uid=$(/usr/bin/id -u)
effective_gid=$(/usr/bin/id -g)
if [ "$install_root" = / ] && [ "$effective_uid" -ne 0 ]; then
  echo "production host installation requires root" >&2
  exit 77
fi
owner_arguments=
if [ "$effective_uid" -eq 0 ]; then
  owner_arguments="-o root -g root"
fi

if [ ! -d "$install_root" ] || [ -L "$install_root" ]; then
  echo "install root must already be a non-symlink directory" >&2
  exit 64
fi
install_root=$(CDPATH='' cd -- "$install_root" && /usr/bin/pwd -P)
target() {
  if [ "$install_root" = / ]; then
    echo "$1"
  else
    echo "$install_root$1"
  fi
}

deploy_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && /usr/bin/pwd -P)
candidate_root=$(CDPATH='' cd -- "$deploy_root/../.." && /usr/bin/pwd -P)
attestor_preflight="$candidate_root/paper-core/bin/hepta-paper-release-attestor-daemon.mjs"
if [ ! -f "$attestor_preflight" ] || [ -L "$attestor_preflight" ]; then
  echo "candidate release-attestor preflight entrypoint is missing or unsafe" >&2
  exit 74
fi
signer_configuration=$(target \
  /etc/hepta-paper/release-attestor/signer-daemon.json)
probe_configuration=$(target \
  /etc/hepta-paper/release-attestor/probe-daemon.json)
signer_private_key_owner_uid=$effective_uid
probe_private_key_owner_uid=$effective_uid
if [ "$install_root" = / ]; then
  if ! signer_private_key_owner_uid=$(/usr/bin/id -u hepta-release-attestor) \
    || ! probe_private_key_owner_uid=$(/usr/bin/id -u hepta-release-probe); then
    echo "release-attestor identities must exist before host installation" >&2
    echo "migration: apply the reviewed sysusers identity declaration, provision v2 signer/probe configuration, then rerun the installer" >&2
    exit 78
  fi
fi
if ! /usr/bin/env -i PATH=/usr/sbin:/usr/bin LC_ALL=C \
  /usr/bin/node "$attestor_preflight" \
    --preflight-configuration-pair \
    --signer-configuration "$signer_configuration" \
    --probe-configuration "$probe_configuration" \
    --signer-private-key-owner-uid "$signer_private_key_owner_uid" \
    --probe-private-key-owner-uid "$probe_private_key_owner_uid" \
    >/dev/null; then
  echo "release-attestor v2 configuration preflight failed before installation mutation" >&2
  echo "migration: stage both version 2 configurations with explicit socketPolicy, matching signer/probe pins, and correct dedicated-UID key ownership; then rerun" >&2
  exit 78
fi

compiler=/usr/bin/cc
if [ ! -x "$compiler" ]; then
  echo "/usr/bin/cc is required" >&2
  exit 69
fi

build_root=$(/usr/bin/mktemp -d /var/tmp/hepta-paper-host-install.XXXXXX)
case "$build_root" in
  /var/tmp/hepta-paper-host-install.*) ;;
  *) echo "unsafe build root" >&2; exit 70 ;;
esac
cleanup() {
  /usr/bin/rm -rf -- "$build_root"
}
trap cleanup EXIT HUP INT TERM
/usr/bin/chmod 0700 "$build_root"
snapshot_root="$build_root/source"
/usr/bin/mkdir -m 0700 "$snapshot_root"

artifact_allowlist='
autonomous-submission-handoff-layout-provision.c
install-hepta-paper-systemd-host.sh
codex-openclaw-managed
hepta-paper-state-authority-client
hepta-paper-release-attestor-client
hepta-paper-release-env
local-release-attestor-daemon.schema.json
local-release-attestor-signer.config.example.json
local-release-attestor-probe.config.example.json
hepta-paper.sysusers.conf
hepta-paper.tmpfiles.conf
hepta-paper-host-bootstrap.service
hepta-paper-state-authority.service
hepta-paper-release-attestor.service
hepta-paper-release-attestor-probe.service
autonomous-submission-handoff-layout-provision.service
autonomous-submission-handoff-layout-provision.path
autonomous-research-supervisor.service
autonomous-submission-dispatcher.service
strict-full-auto-acceptance.service
strict-full-auto-acceptance.timer
autonomous-research-state-backup-renew.service
autonomous-research-state-backup-renew.timer
'
for artifact in $artifact_allowlist; do
  source_artifact="$deploy_root/$artifact"
  snapshot_artifact="$snapshot_root/$artifact"
  if [ ! -f "$source_artifact" ] || [ -L "$source_artifact" ]; then
    echo "deployment artifact is missing, non-regular, or a symlink: $artifact" >&2
    exit 74
  fi
  set -- $(/usr/bin/sha256sum "$source_artifact")
  source_hash_before=$1
  /usr/bin/cp --no-dereference --reflink=never \
    "$source_artifact" "$snapshot_artifact"
  if [ ! -f "$snapshot_artifact" ] || [ -L "$snapshot_artifact" ]; then
    echo "deployment snapshot is non-regular: $artifact" >&2
    exit 74
  fi
  /usr/bin/chmod 0600 "$snapshot_artifact"
  set -- $(/usr/bin/sha256sum "$snapshot_artifact")
  snapshot_hash=$1
  set -- $(/usr/bin/sha256sum "$source_artifact")
  source_hash_after=$1
  if [ "$source_hash_before" != "$snapshot_hash" ] \
    || [ "$snapshot_hash" != "$source_hash_after" ]; then
    echo "deployment artifact changed while snapshotting: $artifact" >&2
    exit 75
  fi
done

source_path="$snapshot_root/autonomous-submission-handoff-layout-provision.c"
set -- $(/usr/bin/sha256sum "$source_path")
source_sha256=$1
/usr/bin/env -i PATH=/usr/sbin:/usr/bin LC_ALL=C "$compiler" \
  -O2 -std=c17 -Wall -Wextra -Werror \
  -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=2 \
  "$source_path" \
  -pie -Wl,-z,relro,-z,now -Wl,-z,noexecstack \
  -o "$build_root/autonomous-submission-handoff-layout-provision"
set -- $(/usr/bin/sha256sum "$source_path")
if [ "$1" != "$source_sha256" ]; then
  echo "snapshotted helper source changed during compilation" >&2
  exit 75
fi
set -- $(/usr/bin/sha256sum \
  "$build_root/autonomous-submission-handoff-layout-provision")
binary_sha256=$1
compiler_realpath=$(/usr/bin/readlink -f "$compiler")
set -- $(/usr/bin/sha256sum "$compiler_realpath")
compiler_sha256=$1

/usr/bin/install -d $owner_arguments -m 0755 \
  "$(target /usr/libexec/hepta-paper)" \
  "$(target /usr/share/hepta-paper/deploy)" \
  "$(target /usr/lib/sysusers.d)" \
  "$(target /usr/lib/tmpfiles.d)" \
  "$(target /etc/systemd/system)"
/usr/bin/install $owner_arguments -m 0755 \
  "$build_root/autonomous-submission-handoff-layout-provision" \
  "$(target /usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision)"
/usr/bin/install $owner_arguments -m 0644 "$source_path" \
  "$(target /usr/share/hepta-paper/deploy/autonomous-submission-handoff-layout-provision.c)"
/usr/bin/install $owner_arguments -m 0755 \
  "$snapshot_root/install-hepta-paper-systemd-host.sh" \
  "$(target /usr/share/hepta-paper/deploy/install-hepta-paper-systemd-host.sh)"
for public_configuration_document in \
  local-release-attestor-daemon.schema.json \
  local-release-attestor-signer.config.example.json \
  local-release-attestor-probe.config.example.json
do
  /usr/bin/install $owner_arguments -m 0644 \
    "$snapshot_root/$public_configuration_document" \
    "$(target /usr/share/hepta-paper/deploy/$public_configuration_document)"
done
for launcher in \
  codex-openclaw-managed \
  hepta-paper-state-authority-client \
  hepta-paper-release-attestor-client \
  hepta-paper-release-env
do
  /usr/bin/install $owner_arguments -m 0755 \
    "$snapshot_root/$launcher" "$(target /usr/libexec/hepta-paper/$launcher)"
done

umask 0022
{
  echo "version=1"
  echo "source_sha256=$source_sha256"
  echo "binary_sha256=$binary_sha256"
  echo "compiler_realpath=$compiler_realpath"
  echo "compiler_sha256=$compiler_sha256"
  echo "compiler_flags=-O2 -std=c17 -Wall -Wextra -Werror -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=2 -pie -Wl,-z,relro,-z,now -Wl,-z,noexecstack"
  echo "binary_owner=root"
  echo "binary_group=root"
  echo "binary_mode=0755"
} > "$build_root/autonomous-submission-handoff-layout-provision.build-receipt"
/usr/bin/install $owner_arguments -m 0644 \
  "$build_root/autonomous-submission-handoff-layout-provision.build-receipt" \
  "$(target /usr/share/hepta-paper/deploy/)"

/usr/bin/install $owner_arguments -m 0644 \
  "$snapshot_root/hepta-paper.sysusers.conf" \
  "$(target /usr/lib/sysusers.d/hepta-paper.conf)"
/usr/bin/install $owner_arguments -m 0644 \
  "$snapshot_root/hepta-paper.tmpfiles.conf" \
  "$(target /usr/lib/tmpfiles.d/hepta-paper.conf)"

for unit in \
  hepta-paper-host-bootstrap.service \
  hepta-paper-state-authority.service \
  hepta-paper-release-attestor.service \
  hepta-paper-release-attestor-probe.service \
  autonomous-submission-handoff-layout-provision.service \
  autonomous-submission-handoff-layout-provision.path \
  autonomous-research-supervisor.service \
  autonomous-submission-dispatcher.service \
  strict-full-auto-acceptance.service \
  strict-full-auto-acceptance.timer \
  autonomous-research-state-backup-renew.service \
  autonomous-research-state-backup-renew.timer
do
  /usr/bin/install $owner_arguments -m 0644 \
    "$snapshot_root/$unit" "$(target /etc/systemd/system/$unit)"
done

: > "$build_root/hepta-paper-systemd-host.manifest.sha256"
for artifact in $artifact_allowlist; do
  case "$artifact" in
    autonomous-submission-handoff-layout-provision.c)
      manifest_path=usr/share/hepta-paper/deploy/autonomous-submission-handoff-layout-provision.c
      ;;
    install-hepta-paper-systemd-host.sh)
      manifest_path=usr/share/hepta-paper/deploy/install-hepta-paper-systemd-host.sh
      ;;
    local-release-attestor-daemon.schema.json|local-release-attestor-*.config.example.json)
      manifest_path=usr/share/hepta-paper/deploy/$artifact
      ;;
    codex-openclaw-managed|hepta-paper-state-authority-client|hepta-paper-release-attestor-client|hepta-paper-release-env)
      manifest_path=usr/libexec/hepta-paper/$artifact
      ;;
    hepta-paper.sysusers.conf)
      manifest_path=usr/lib/sysusers.d/hepta-paper.conf
      ;;
    hepta-paper.tmpfiles.conf)
      manifest_path=usr/lib/tmpfiles.d/hepta-paper.conf
      ;;
    *)
      manifest_path=etc/systemd/system/$artifact
      ;;
  esac
  set -- $(/usr/bin/sha256sum "$snapshot_root/$artifact")
  echo "$1  $manifest_path" \
    >> "$build_root/hepta-paper-systemd-host.manifest.sha256"
done
echo "$binary_sha256  usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision" \
  >> "$build_root/hepta-paper-systemd-host.manifest.sha256"
set -- $(/usr/bin/sha256sum \
  "$build_root/autonomous-submission-handoff-layout-provision.build-receipt")
echo "$1  usr/share/hepta-paper/deploy/autonomous-submission-handoff-layout-provision.build-receipt" \
  >> "$build_root/hepta-paper-systemd-host.manifest.sha256"
/usr/bin/install $owner_arguments -m 0644 \
  "$build_root/hepta-paper-systemd-host.manifest.sha256" \
  "$(target /usr/share/hepta-paper/deploy/)"

for artifact in $artifact_allowlist; do
  case "$artifact" in
    autonomous-submission-handoff-layout-provision.c)
      installed_artifact=$(target \
        /usr/share/hepta-paper/deploy/autonomous-submission-handoff-layout-provision.c)
      ;;
    install-hepta-paper-systemd-host.sh)
      installed_artifact=$(target \
        /usr/share/hepta-paper/deploy/install-hepta-paper-systemd-host.sh)
      ;;
    local-release-attestor-daemon.schema.json|local-release-attestor-*.config.example.json)
      installed_artifact=$(target "/usr/share/hepta-paper/deploy/$artifact")
      ;;
    codex-openclaw-managed|hepta-paper-state-authority-client|hepta-paper-release-attestor-client|hepta-paper-release-env)
      installed_artifact=$(target "/usr/libexec/hepta-paper/$artifact")
      ;;
    hepta-paper.sysusers.conf)
      installed_artifact=$(target /usr/lib/sysusers.d/hepta-paper.conf)
      ;;
    hepta-paper.tmpfiles.conf)
      installed_artifact=$(target /usr/lib/tmpfiles.d/hepta-paper.conf)
      ;;
    *)
      installed_artifact=$(target "/etc/systemd/system/$artifact")
      ;;
  esac
  set -- $(/usr/bin/sha256sum "$snapshot_root/$artifact")
  expected_hash=$1
  set -- $(/usr/bin/sha256sum "$installed_artifact")
  if [ "$1" != "$expected_hash" ]; then
    echo "installed deployment artifact hash mismatch: $artifact" >&2
    exit 74
  fi
done
expected_launcher_uid=$effective_uid
expected_launcher_gid=$effective_gid
if [ "$effective_uid" -eq 0 ]; then
  expected_launcher_uid=0
  expected_launcher_gid=0
fi
for launcher in \
  codex-openclaw-managed \
  hepta-paper-state-authority-client \
  hepta-paper-release-attestor-client \
  hepta-paper-release-env
do
  set -- $(/usr/bin/stat -c '%u %g %a' \
    "$(target /usr/libexec/hepta-paper/$launcher)")
  if [ "$1" -ne "$expected_launcher_uid" ] \
    || [ "$2" -ne "$expected_launcher_gid" ] \
    || [ "$3" != 755 ]; then
    echo "installed operational launcher owner or mode mismatch: $launcher" >&2
    exit 74
  fi
done
set -- $(/usr/bin/sha256sum \
  "$(target /usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision)")
if [ "$1" != "$binary_sha256" ]; then
  echo "installed helper hash mismatch" >&2
  exit 74
fi
(CDPATH='' cd -- "$install_root" \
  && /usr/bin/sha256sum -c \
    usr/share/hepta-paper/deploy/hepta-paper-systemd-host.manifest.sha256)

/usr/bin/systemd-analyze verify \
  "$(target /etc/systemd/system/hepta-paper-host-bootstrap.service)" \
  "$(target /etc/systemd/system/hepta-paper-state-authority.service)" \
  "$(target /etc/systemd/system/hepta-paper-release-attestor.service)" \
  "$(target /etc/systemd/system/hepta-paper-release-attestor-probe.service)" \
  "$(target /etc/systemd/system/autonomous-submission-handoff-layout-provision.service)" \
  "$(target /etc/systemd/system/autonomous-submission-handoff-layout-provision.path)" \
  "$(target /etc/systemd/system/autonomous-research-supervisor.service)" \
  "$(target /etc/systemd/system/autonomous-submission-dispatcher.service)" \
  "$(target /etc/systemd/system/strict-full-auto-acceptance.service)" \
  "$(target /etc/systemd/system/strict-full-auto-acceptance.timer)" \
  "$(target /etc/systemd/system/autonomous-research-state-backup-renew.service)" \
  "$(target /etc/systemd/system/autonomous-research-state-backup-renew.timer)"

if [ "$manage_systemd" = yes ]; then
  /usr/bin/systemctl daemon-reload
  /usr/bin/systemctl disable --now \
    strict-full-auto-acceptance.timer \
    strict-full-auto-acceptance.service \
    autonomous-submission-dispatcher.service \
    autonomous-research-supervisor.service
  /usr/bin/systemctl enable \
    hepta-paper-host-bootstrap.service \
    hepta-paper-state-authority.service \
    hepta-paper-release-attestor.service \
    hepta-paper-release-attestor-probe.service \
    autonomous-submission-handoff-layout-provision.path \
    autonomous-research-state-backup-renew.timer
  /usr/bin/systemctl stop \
    strict-full-auto-acceptance.timer \
    strict-full-auto-acceptance.service \
    autonomous-submission-dispatcher.service \
    autonomous-research-supervisor.service \
    hepta-paper-release-attestor-probe.service \
    hepta-paper-release-attestor.service \
    hepta-paper-state-authority.service \
    autonomous-submission-handoff-layout-provision.path \
    autonomous-submission-handoff-layout-provision.service
  /usr/bin/systemctl clean --what=runtime \
    autonomous-submission-handoff-layout-provision.service
  /usr/bin/systemctl restart hepta-paper-host-bootstrap.service
  /usr/bin/systemctl restart hepta-paper-state-authority.service
  /usr/bin/systemctl restart hepta-paper-release-attestor.service
  /usr/bin/systemctl restart hepta-paper-release-attestor-probe.service
  /usr/bin/systemctl start autonomous-submission-handoff-layout-provision.path
  /usr/bin/systemctl restart autonomous-research-state-backup-renew.timer
fi

echo "hepta-paper systemd host installation completed (production hold active)"
