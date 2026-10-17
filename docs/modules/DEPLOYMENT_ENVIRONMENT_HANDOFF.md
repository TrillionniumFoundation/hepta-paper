# Native readiness deployment environment

This component ports `paper-adapters/automation/deployment-environment-file.mjs`.
It overlays an explicitly supplied environment map with an explicitly selected,
owner-private file. It does not inspect ambient process secrets, execute a shell,
expand variables, load credentials from referenced paths, or activate a runtime.

## API and data contract

`parse_deployment_environment_file_v1(&str)` implements the closed assignment
grammar. The 58-key allowlist is checked against the actual incumbent export by
the test oracle. Lines support blank space, comments beginning with `#`, a single
key/value separator, unquoted values without whitespace or `#`, literal single
quotes, and double quotes that decode only escaped quotes and backslashes.
Duplicate keys and unlisted keys fail. JavaScript whitespace, including BOM and
excluding U+0085, is handled explicitly for parity. Variables and command syntax
remain literal strings.

`load_readiness_deployment_environment_v1(base, path)` requires an explicit JSON
object for the base environment. An absent or empty path preserves that map and
returns the ambient-source inspection. An accepted private file overlays only its
declared keys. The returned `environment` may contain sensitive values supplied
by the caller and must not be logged. `inspection` contains only source identity,
file hash, sorted loaded names, the exact Node-compatible record hash, and the
incumbent `credentialMaterialLoaded: false` marker. This marker describes this
loader's behavior and is not a certificate that arbitrary supplied values are
non-sensitive.

## Filesystem boundary

Paths must be absolute and lexically normalized. Every parent is opened relative
to a held descriptor without following symlinks. The leaf uses nonblocking open,
must be regular with one link, owned by root or the current user, and have no group
or other permission bits. Input is limited to 1 MiB and strict UTF-8. Read length,
device/inode, modes, links, ownership, size and modification/change timestamps
are checked before and after reading and again before returning the inspection.
Held parent identities detect observed directory rebinding.

Symlink ancestors, hard links, invalid UTF-8 and excessive file sizes are rejected
more strictly than the original Node helper. Snapshot checks are bounded current
observations, not a future immutability lease. No API accepts an arbitrary callback
while file authority is held.

## Verification

The parity suite uses only synthetic values and temporary private files; it never
reads the real process environment. The pinned Node oracle reads the same actual
files and compares full overlay outputs and inspection hashes. Cases cover every
allowlisted key, CRLF, Unicode whitespace, quoting, literals, duplicates, invalid
assignments, empty values and preservation of unrelated base properties. Native
negative cases cover permissions, symbolic/hard links, parent aliases, malformed
UTF-8, oversized files, FIFOs, directories, missing files and traversal. A separate
assertion checks that the inspection does not contain a loaded synthetic value.

```bash
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test deployment_environment_parity --locked
```

## Integration remaining

The whole readiness observation and operator CLI must call this loader when its
original environment-file flag is selected. This adapter is not a substitute for
the probes, authority chains, live provider configuration or production readiness
qualification required by that route. It does not close that command gap alone.
