# Native local release-integrity key management

`maintenance/release-integrity-key` now has real Rust implementations of both
`status` and `provision`, including the existing-key public/private loaders.
It belongs to `module.rust-control-plane-service`. The command is create-once key
management for build/archive integrity. It does not grant owner, academic,
referee, submission, independent acceptance, external KMS/HSM, or full-production
authority. Command-level migration acceptance remains tracked in
[the migration gap report](../migration/NODE_RUST_GAP_CLOSURE.md).

## Source and entry points

The incumbent source chain is:

- `paper-core/bin/release-integrity-key.mjs`: arguments, help, command dispatch,
  environment defaults, output and exit behavior;
- `release-integrity-key-management.mjs`: compatibility exports;
- `release-integrity-key-reader.mjs`: status, pair validation and existing-key
  loading;
- `release-integrity-key-provisioning.mjs`: independent lock and publication;
- `release-integrity-key-storage.mjs` / `release-integrity-filesystem.mjs`: file and
  directory identity checks, exclusive writes, publication and cleanup;
- `paper-adapters/runtime/workspace-layout.mjs`: physical root separation.

The Rust implementation does not import or spawn those files at runtime.

| File below `rust/crates/hepta-paper-service/` | Ownership and principal symbols |
|---|---|
| `src/bin/hepta-release-integrity-key.rs` | `main`, stdout JSON/help, stderr error, process exit |
| `src/release_integrity_key.rs` | `release_integrity_key_cli_v1`, `ReleaseIntegrityKeyContextV1::from_environment`, `inspect_local_release_integrity_key_v1`, `provision_local_release_integrity_key_v1`, `load_existing_local_release_integrity_key_v1` |
| `src/release_integrity_key/layout.rs` | `assert_decoupled`, physical resolution including symlink hops and absent suffixes |
| `src/release_integrity_key/storage.rs` | `safe_directory`, `snapshot`, `unchanged`, `read_key`, `write_exclusive`, `harden_staging`, `publish`, `remove_exact`, `remove_pair_directory`, `remove_empty_directory`, `acquire_lock`, `release_lock` |
| `src/release_integrity_key/crypto.rs` | `validate_pair`, `validate_public`, `generate` |
| `tests/release_integrity_key_parity.rs` | actual Node differential, failure/race/crash and executable tests |
| `rust/oracle/release-integrity-key-v1.mjs` from the repository root | test-only incumbent execution and synthetic fixture generation |

The static call chain is `main` → `release_integrity_key_cli_v1` → context and
layout validation → status or provision → reader/storage/crypto helpers. This is
a source mapping, not a recorded dynamic call graph. The `_with_hooks_v1`
functions expose deterministic failure/race injection for tests; production
entry points use `NoHooks`. Hooks receive an event and path, never key bytes.

## Command interface and data ownership

Build using the pinned Rust toolchain and lockfile:

```sh
cargo build --manifest-path rust/Cargo.toml --locked \
  -p hepta-paper-service --bin hepta-release-integrity-key
```

`--action status|provision` defaults to `status`; `--runtime-root PATH` selects
an existing runtime root. `--action provision` requires `--execute`. `status`
rejects `--execute`. Help, strict option names, duplicate flags, missing/empty
values, positional arguments and `--` follow the incumbent parser. The result is
pretty JSON plus a newline; help is text. Exit 0 means ready/help, exit 2 means a
valid blocked or absent status, and exit 1 means argument or operation failure.

`HEPTA_PAPER_RUNTIME_ROOT` supplies the runtime root when no option is given.
`HEPTA_PAPER_ASSET_ROOT` and `PAPER_FACTORY_LEGACY_ROOT` supply the other roots.
`HEPTA_PAPER_RUNTIME_ISOLATED=1` forbids status, provisioning and private loading.
The public-only loader remains allowed but validates the root, pair shape,
private-file metadata and public key. It does not read private file content.
Default roots follow the incumbent repository-sibling layout; the Rust workspace
root is anchored at the build's repository location. Relocating the executable
without that workspace has not been qualified.

Workspace, asset, runtime and legacy roots must be pairwise physically separate.
Physical layout checks resolve symlinks (maximum 40 hops) and absent suffixes,
then reject containment, aliasing and failed resolution. Key access additionally
rejects symlinks in the runtime directory chain. Neither status nor provisioning
creates the runtime root or repairs unsafe existing directories.

The runtime root owns exactly:

```text
release-signing/                                  0700
  release-integrity-ed25519-private.pem           0600
  release-integrity-ed25519-public.pem            0444
```

The directory and files must belong to the runtime-root owner. The public and
private files must each be regular, single-linked files of 1–16384 bytes. Extra,
missing, symbolic-linked, hard-linked, wrong-mode, FIFO, oversized, wrong-owner
or mismatched key material is refused without repair or rotation. A successful
existing pair is returned unchanged, including inode and byte identities.

## Reads and cryptography

Directory snapshots bind device/inode identity across the entire path. Each key
read compares the selected path with an `O_NOFOLLOW` descriptor, reads a bounded
buffer, then checks descriptor identity/length/timestamps and current path
identity/link count. A final directory postflight prevents a newly substituted,
otherwise valid pair from being accepted under the original directory snapshot.
`O_NONBLOCK` avoids waiting on a special file substituted immediately before open.

The implementation uses `ed25519-dalek` 3.0.0 with PKCS8/PEM support. Private
PKCS8 PEM and public SPKI PEM are parsed as Ed25519 keys; the derived public PEM
must equal the supplied public bytes exactly. A fresh 64-byte challenge is signed
and verified before a pair is accepted. Public-only loading validates SPKI and
reports `sha256:` over the public PEM bytes. RSA and EC keys are rejected with
the incumbent non-Ed25519 error classifications.

`getrandom` obtains operating-system randomness. Rust-owned private buffers,
seeds and encoded documents use `Zeroizing` or the cryptography dependency's
zeroization. `LoadedReleaseIntegrityKeyV1` intentionally has neither `Debug` nor
`Serialize`; retaining private PEM requires `include_private=true`, and access
is through the explicit getter. Reports and test oracles never serialize private
PEM. This is host-resident exportable key material, not protected hardware storage.
Process termination does not guarantee Rust destructors execute; crash safety is
provided by publication/link invariants and refusal to repair partial state.

## Provisioning, concurrency and rollback

Provisioning acquires the independent sibling lock
`.<runtime-basename>.release-integrity-key-provision.lock` with exclusive creation.
An existing lock fails immediately, including after a crashed provisioner.
Different runtime roots have different locks. There is no stale-lock takeover.

A new pair is generated only when `release-signing` is absent. A sibling staging
directory is created and its selected identity checked before descriptor-based
0700 hardening. Both key files are exclusively created, written, hardened,
fsynced, reread and cryptographically checked. The staging directory is fsynced
before publication, and the original runtime chain must remain unchanged.

The final directory is created without replacement. If another writer has
created it, that pair must independently pass the full existing-pair reader;
otherwise provisioning refuses it. Each final file uses a no-clobber hard link
from staging. The public file is published first and private signing authority
last. Publication validates device/inode, link count 2, owner and mode. Staging
cleanup then reduces the final link counts to 1. Relevant directories are synced
and the resulting pair is inspected again before returning `created:true`.

Failure rollback acts only on saved identities. Files/directories are first moved
to unpredictable quarantine paths using Linux `renameat2(RENAME_NOREPLACE)`.
Only the matching selected inode is deleted. A concurrently replaced file is
restored through a no-clobber hard link when possible; ambiguous state is retained
and reported as incomplete rollback. A substituted directory is quarantined and
preserved. The implementation never recursively deletes a directory during
provisioning rollback and never overwrites a concurrent final file.

A process stopped after public publication leaves no final private key. A process
stopped after private publication but before staging cleanup leaves multi-linked
files that the reader refuses. The lock remains and a later provision refuses
rather than recovering, rotating, or repairing this state. Tests cover both
abrupt termination points. There is no claim that arbitrary host-administrator
mutation or every possible filesystem failure schedule has been exhaustively
modeled.

## Compatibility and acceptance limits

Standard Ed25519 PKCS8/SPKI key pairs interoperate in both directions with pinned
Node 22.23.1. Native create-once generation and all CLI action modes execute without
Node on `PATH`. Status/provision reports, supported CLI errors, regular filesystem
refusals, key mismatch/algorithm refusals and six injected failure families are
compared directly with the incumbent implementation.

Three boundaries remain explicit:

1. Malformed PEM/DER produces stable native `release_integrity_private_key_encoding_invalid`
   or `release_integrity_public_key_encoding_invalid` errors, rather than OpenSSL's
   implementation-specific decoder strings/stack traces. A dedicated test proves
   both refuse the file and records this diagnostic difference. It is not full
   byte-for-byte error equivalence.
2. Additional Node/OpenSSL containers (such as public certificates), noncanonical
   DER and the complete decoder acceptance language have not been qualified.
   Unrecognized encodings fail closed. The Rust secure filesystem implementation
   is currently Unix/Linux-specific, including no-replace quarantine rename.

3. Rust rechecks both key-file metadata snapshots and the exact directory shape
   after validating a pair. The public-only loader likewise rechecks the private
   metadata it inspected before reading the public key. A dedicated 12-case
   differential race test demonstrates that the incumbent can still return ready
   or load a key when the private file is replaced, made readable to other users,
   hard-linked, or accompanied by an extra directory entry during the public
   read. Rust rejects these cases with a changed-file or invalid-shape error,
   retains no private output, and does not repair or delete the concurrent data.
   This is an intentional safety tightening of the original read snapshot window.
   The result is a checked read snapshot, not a filesystem lease: it does not
   exclude another owner-authorized process modifying a file after the final
   check or after the API returns.

The existing-payload signing and release-evidence/artifact publishing commands
are separate migration surfaces; passing the incumbent combined key-management
suite does not claim those commands have been ported here. Hosted exact-candidate
CI, independent owner acceptance, production host evidence and migration cutover
remain separate checks. No real user key or production trust was created, read,
rotated or changed by the migration fixtures.

## Verification and regression ownership

Use Node **22.23.1** on `PATH` for differential tests. The oracle returns the
production Node/ICU/CLDR/hash profile and the test qualifies it before comparing
results. Its file operations are restricted to explicit `/tmp/hepta-release-key-rust-`
fixture roots. Fixtures use private disposable roots; test diagnostics never
print private key bytes.

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --test release_integrity_key_parity
cargo clippy --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --lib --bins -- -D warnings -D clippy::unwrap_used \
  -D clippy::expect_used -D clippy::panic
node --test paper-core/tests/release-integrity-key.test.mjs
```

Concrete regression symbols in `release_integrity_key_parity.rs`:

- `status_and_cli_arguments_are_readonly_and_match_node`;
- `native_provision_and_node_provision_interoperate_without_rotation`;
- `invalid_existing_pairs_and_unsafe_paths_remain_unchanged`;
- `isolation_decoupling_and_explicit_execution_prevent_key_access`;
- `public_and_private_loading_and_non_ed25519_pairs_match_node`;
- `malformed_pem_fails_closed_with_explicit_native_encoding_diagnostics`;
- `read_races_bind_directory_and_file_identities_without_deleting_concurrent_bytes`;
- `valid_directory_substitution_is_rejected_by_status_and_public_loader`;
- `final_pair_snapshot_rejects_private_mutation_while_public_is_read`;
- `publication_failures_roll_back_only_owned_files_and_never_overwrite`;
- `staging_and_cleanup_substitutions_preserve_concurrent_objects`;
- `independent_locks_serialize_same_root_and_allow_other_roots`;
- `concurrent_processes_respect_the_same_lock_without_blocking_other_roots`;
- `abrupt_crash_leaves_partial_or_multilink_pair_blocked_and_lock_intact`;
- `shipped_binary_matches_readonly_cli_and_provisions_without_node_runtime`.

`crash_worker` is the subprocess helper used by the crash and true concurrent
process tests. It does no work during an ordinary test invocation.
