#!/usr/bin/env bash

set -euo pipefail

# The locked rusqlite build uses bindgen for SQLite Session bindings.  GitHub
# hosted images currently include a C compiler, but libclang is not a stable
# image contract.  Install the smallest missing dependency and export the
# exact directory so every Rust lane discovers the same library.
find_libclang() {
  find /usr/lib /usr/local/lib -type f,l -name 'libclang.so*' -print -quit 2>/dev/null || true
}

libclang="$(find_libclang)"
if [[ -z "$libclang" ]]; then
  if [[ ! -x /usr/bin/sudo || ! -x /usr/bin/apt-get ]]; then
    echo 'libclang is required for the locked SQLite bindings, but apt/sudo is unavailable.' >&2
    exit 1
  fi
  sudo apt-get -o Acquire::Retries=3 update
  sudo env DEBIAN_FRONTEND=noninteractive \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
      clang libclang-dev
  libclang="$(find_libclang)"
fi

test -n "$libclang"
libclang_dir="$(dirname "$libclang")"
printf 'LIBCLANG_PATH=%s\n' "$libclang_dir" >> "${GITHUB_ENV:-/dev/stdout}"
printf 'libclang=%s\n' "$libclang"
