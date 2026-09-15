# Local maintenance and byte-backup contract

This is an additive implementation under `module.rust-control-plane-service`, not a new global module or status authority. Source delivery is separate from executed tests, exact-head qualification, semantic recovery and production operation. This increment does not close the legacy `gc`, `retention-recovery-readiness`, `provision-retention-recovery` or `cancel-node` parity rows.

## Implemented call chain

`hepta-local-maintenance` calls `LocalMaintenanceSessionV1::acquire`, then `inspect` or `backup`. `verify` calls `verify_local_backup_v1` with an independently retained manifest digest. The implementation lives in `src/maintenance.rs`; cooperative locking lives in `src/state_access.rs` and is held by `ObjectStoreV1` clones. `run_service_v1` retains an additional clone until after both executor and SQLite sequencer teardown.

This is byte preservation only. The archive may preserve an invalid database, an unresolved attempt, an expired local lease or invalid workflow bytes. Neither successful copying nor a matching hash establishes a valid workflow or permission to resume it. Every receipt keeps `semanticRecoveryVerified`, `productionActivation` and `nodeRetirementVerified` false.

## Exclusion and enrollment

Updated service code holds shared `state-access-v1.lock` access for the object-store lifetime. Maintenance requires exclusive nonblocking access and the existing exclusive `workflow.lock`. Readers may coexist; an exclusive maintenance session conflicts with readers and other maintenance sessions. Missing, nonempty, linked, replaced, wrongly owned or publicly readable lock files are denied. Clone lifetime retains the shared lock.

These are cooperative locks, not a hostile-process sandbox or production writer lease. Before the first updated service opens an existing root, independently stop and drain old binaries, direct database writers and external filesystem tools. They do not participate in the new lock. The maintenance API does not create a missing lock, kill writers, install services or change ownership. Lock acquisition failure is a bounded persistence rejection, not permission to bypass it.

## Inventory and filesystem contract

Roots must be canonical absolute private directories with a consistent owner. Files must be regular, private, singly linked and unchanged across no-follow/nonblocking descriptor reads. Root and child-directory identity and entry sets are rechecked. Reads are bounded and compare size, inode, device, owner, permissions, link count and modification/change timestamps.

The closed file inventory admits only `campaign.sqlite`, `workflow.json`, the two empty lock files, `step-NNNN.json`, flat `objects/<64-lowercase-hex>` entries and flat `attempts/<64-lowercase-hex>.started|.prepared` records. CAS bytes must match the filename hash. Both child directories and the four fixed files must exist. Unknown files, nested children, symlinks, hardlinks and SQLite WAL/SHM/journal sidecars fail closed. Maintenance never checkpoints or repairs the source. Stop the normal owner cleanly to produce a consistent closed copy; do not delete a WAL merely to pass this gate.

Limits: 4,096 files, 256 MiB per file, 1 GiB total retained bytes and a 1 MiB manifest. These are implementation safety bounds, not measured capacity or production SLO claims. Oversized inputs fail rather than being silently omitted.

## Backup and verification

The destination must be absent, outside the source, below a canonical private parent owned by the same owner. A source-root ancestor or descendant is rejected. Every payload file is created exclusively with mode 0600; directories use mode 0700. Files and directories are synchronized. Source bytes are rehashed during copying and the source and destination inventories must match. `manifest.json` is published last. Failed partial destinations are retained for investigation and are never adopted by a retry.

A bundle contains exactly `manifest.json` and `payload/`. `LocalBackupManifestV1` is closed camelCase JSON: `version`, `kind`, `sourceDirectory`, `files`, `totalBytes`, `semanticRecoveryVerified`, `productionActivation`, `nodeRetirementVerified`. The kind is `HeptaLocalByteBackupV1`; version is 1. Each sorted unique file row contains `path`, `bytes` and `sha256`. The expected manifest digest binds exact encoded bytes, not a reparsed/reordered JSON document. Verification rejects mismatched hashes, unknown fields, invalid paths, duplicate/unsorted entries, incorrect totals, extra/missing files, changed payloads and self-asserted acceptance fields.

Keep bundle contents private: workflow files and attempt records may include confidential content or local lease material. The receipt contains counts and hashes, not payload bytes. An expected digest copied from an untrusted bundle is not an independent trust anchor. Byte verification is not an immutable-storage custody, fsync-fault or 72-hour-soak proof.

## Build, commands and tests

Use the repository-pinned toolchain and lockfile from the repository root:

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --bins
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service state_access::tests
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_maintenance
cargo test --manifest-path rust/Cargo.toml --locked --workspace --all-targets
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets -- -D warnings
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
```

Commands, using a built binary and operator-selected private paths:

```text
hepta-local-maintenance inspect STATE
hepta-local-maintenance backup STATE ABSENT_DESTINATION
hepta-local-maintenance verify BUNDLE EXPECTED_MANIFEST_HASH
```

No restore, GC-delete, production or cutover command exists. Errors exit nonzero and do not echo file contents or parser diagnostics. Tests include actual local SQLite files, actual CAS bytes, actual CLI calls, clone/exclusion behavior, corruption, links, WAL refusal, unknown-file refusal, missing manifests, no-overwrite behavior and authority-overclaim rejection. Test source presence is not a passing run; acceptance must retain exact-head execution results.

## Remaining work before broader maintenance parity

Semantic recovery must validate the complete local workflow/amendment/plan/result/receipt/budget history and every referenced artifact, then exercise a fresh recovery without replaying ambiguous work. Restoration needs atomic no-overwrite publication, original-path/config binding, enrollment and incomplete-restore fencing, retained post-backup history and qualified forward/reverse recovery rules. GC requires a complete pin/root/lease inventory and durable reviewed mark/sweep semantics; this implementation deletes nothing. In-flight node cancellation still needs child lifecycle and ambiguity reconciliation. Production host, external authority, writer transfer and Node retirement remain under their existing independent gates.
