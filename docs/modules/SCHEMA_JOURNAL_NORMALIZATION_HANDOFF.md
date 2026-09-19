# Native schema journal normalization and interrupted recovery

This native execution stage follows the observed source plan and signed maintenance reservation. It implements actual normalization of the ten registered SQLite files and a durable per-database progress journal. It does not install marker metadata or genesis rows, finalize a schema reservation, activate the runtime, qualify an external authority service, or deploy a production configuration.

## Source and API boundaries

The behavioral source is `paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs`, with the real schema-source projection, fixed DDL, inventory and Ed25519 contract already ported in the preceding slices. The added public module is `online_schema_execution::maintenance::normalization`:

- `normalize_schema_maintenance_v1` consumes a genuine `QuiescedSchemaMaintenanceV1`; there is no public constructor, deserializer, Boolean permission or arbitrary JSON authority argument.
- `resume_schema_normalization_v1` accepts an expected transition ID and the actual manifest, writer manifest, pinned authority and clock. The stored journal is untrusted data until all cryptographic, physical and fixed-schema comparisons succeed.
- `NormalizedSchemaMaintenanceV1` retains the maintenance token, root-inode flock, exact journal bytes hash and actual records. Its `assert_current` rechecks both journal and full source evidence and performs the final lease check after file I/O. No SQLite connection is exposed.
- `SchemaNormalizationCheckpointV1` is an observation/fault checkpoint interface. Its callbacks receive only a point and an instance ID. Return values cannot grant permission or skip verification. An error does not claim rollback of an already completed SQLite checkpoint.

The implementation is `online_schema_execution::maintenance::normalization`, with crate-private source-normalization helpers and a durable journal repository. Only the typed source-plan and signed-maintenance chain can construct its input capability. The source plan/reservation APIs retain their existing contracts.

## Actual authority and physical scope

The root maintenance lock uses a distinct open file description and a nonblocking exclusive `flock` on the actual runtime root directory inode. This avoids split locks from replacing a lock pathname. The held root and all ancestors are rechecked. It excludes cooperating native maintenance runners; it is not a distributed lock or a substitute for the signed authority's all-writer fencing.

Every step checks the real ten-role inventory, registered paths, instance IDs, schema contracts, scope and manifest. It retains original source inode/device/mode/link-count bindings. A new source state is accepted only when a genuine private-copy normalization computes the exact raw digest reserved by the pinned authority, with the same pre-schema and fixed post-schema hashes. A previously computed schema/integrity observation and projection are reused only from the private typed plan when two real namespace scans and two rounds of all held source/sidecar identity and byte-hash checks prove the registered scope and every file unchanged. Any change returns to full real inventory inspection and native normalization projection. Stored progress records never supply that cache.

Before source writes, the actual Ed25519 reservation is verified again against the exact request and current pinned configuration and key. A fresh final clock sample follows verifier and source I/O; time cannot move backward within a token, and remaining lease must cover the requested execution window. No new RPC or caller readiness claim substitutes for a valid reservation.

The live SQLite operation is checkpoint(TRUNCATE), journal_mode=DELETE, synchronous=FULL and close, followed by actual file hash and sidecar checks. Native live busy timeout is zero: an allegedly quiesced source with a competing SQLite lock fails immediately. The Node implementation's ten-second busy wait could acquire a lock only after a short signed lease expires. This intentional tightening avoids that deferred-write window; ordinary filesystem I/O is not represented as a hard real-time guarantee.

For stale SHM, the implementation first rechecks absence of WAL, held source/parent identity and the exact SHM snapshot. It moves the shared-name entry into a fresh 0700 private quarantine using `RENAME_NOREPLACE`, then verifies the inode actually moved. A foreign replacement is never deliberately deleted or overwritten: restoration uses no-replace semantics, and an un-restorable quarantine is retained. Cleanup does not recursively traverse paths. Empty private directories may remain as harmless audit/crash artifacts. These checks do not claim exclusion of every future same-UID attack against private directories.

The SQLite connection still uses its named-path VFS with before/after held-file identity checks. This does not eliminate every same-user swap-to-another-inode-and-back window during SQLite open. No descriptor-bound VFS guarantee is claimed. The public API provides no raw handle or callback capable of escaping that connection.

## Durable progress and recovery

The native progress file is `autonomous-research/online-schema-transition/NORMALIZATION.native.v1.json`. It contains the original plan, exact reserve request, genuine signed reservation, original root identity, authority configuration hash, checked clock and recomputed normalization records. Before the first live SQLite write, it is published through the existing held-directory CAS helper with file and directory fsync and a no-clobber publication lock. Parsing is bounded to 4 MiB and rejects duplicate keys. Safe integral JSON number spellings are normalized without changing the original signature's JS Number semantics.

A new normalization attempt cannot overwrite an existing journal. It must use the explicit recovery entry point. After each database, including after a checkpoint callback and immediately before progress publication, the actual digest and absence of sidecars are rechecked, the full authority/scope guard is repeated, and progress is atomically compared-and-replaced against the previous byte hash. A competing or changed journal fails closed.

After a process crash, recovery takes the real root lock, verifies the signed reservation and current lease, checks the original plan hash and transition ID, rebuilds a real local plan from actual files and the supplied fixed manifests, verifies all immutable subject/schema/pristine/instance/root fields, and requires its reconstructed reserve request to equal the journal request. Current normalized projections must exactly match the original reservation. It then re-observes every database; a completed flag cannot skip a check. Before returning a completed normalization token, every database must physically have the exact normalized digest and no WAL/SHM; merely having a valid future normalization projection is insufficient. An already checkpointed or already normalized file can complete recovery when its real reserved projection matches, even if the process exited before progress publication.

An expired reservation cannot authorize a recovery write. Re-reservation after expiry, finalization and transition to a new normalization cycle require the later schema execution protocol. This slice deliberately preserves the current journal rather than overwriting it with an unrelated operation.

## SQLite engine byte compatibility

Pinned Node 22.23.1 uses SQLite 3.51.3; current bundled native SQLite is 3.53.2. Real WAL normalization updates the writer-version field at bytes 96–99 differently. The native implementation binds the genuine native normalized bytes and digest. It never rewrites that header to imitate another engine. A prior Node reservation whose expected normalized digest differs must fail before source writes. This cross-engine reservation interoperability remains an explicit qualification gap. DELETE fixtures not rewritten by SQLite can have fully identical bytes and records.

## Representation compatibility boundary

Node's v2 `validGenesis` compares generated genesis rows using `JSON.stringify`, which makes object member order observable even when the signed canonical JSON values are unchanged. The native authority API receives `serde_json::Value` and checks those signed semantic values; it does not reproduce that incidental member-order rejection after a Rust Value reserialization. The differential oracle preserves its genuine originally issued Node response object, checks that its complete signed payload and signature exactly match the native input, and invokes the unchanged Node verifier and normalization function with that original object. It does not forge a receipt, modify a source function body or freeze an output snapshot. Exact parity for rejecting alternate genesis member order remains a separate representation gap; successful normalization comparisons do not close it.

## Validation status

Focused tests are under `tests/schema_normalization_parity.rs` and the physical helper's `normalization_support/tests.rs`. The oracle invokes the original Node normalization function with real Ed25519 verification and actual temporary ten-database fixtures. It generates private signing keys only in memory; no private key bytes are persisted or logged.

The current tests cover actual original-output comparison, exclusive root lock retention, genuine child-process exit after checkpoint and before progress publication, current-lease refusal on resume, reconstruction from signed stored evidence, malformed signature/request/plan/root refusal, effective WAL data preservation and genuine normalized file SHA. Separate physical tests exercise a second process holding a SQLite writer lock and replacement of stale SHM between its final shared-name snapshot and quarantine.

Validation completed in the isolated native service package:

- Full integration baseline: 7 passed, 0 failed, 316.09 seconds (`/tmp/hepta-normalization-complete.log`). This includes six substantive scenario groups and the separate child-process entry point. It covers actual wall-clock completion under a real 60-second signed lease, both real crash locations, both Node versions of the transition, signed Number spelling, adversarial current-state changes and cross-engine refusal before writes.
- The final small SHM checkpoint hardening repeats authority/clock/WAL checks after the callback and restores rather than deletes if WAL appears after quarantine. Its exact delta is `/tmp/hepta-normalization-final-guard.diff`; the full-seven baseline hashes are recorded in `/tmp/hepta-normalization-seven-test-baseline.json`. After that delta, the affected physical suite passed 4/4 in 6.49 seconds (`/tmp/hepta-normalization-final-physical.log`), including the child entry point and three real race/locking scenarios. The prior seven-group run is not represented as an unperformed full run of this final delta.
- Final production Clippy passed in 17.39 seconds with `RUSTFLAGS=-Dunsafe-code` and `-D warnings -D clippy::unwrap_used -D clippy::expect_used -D clippy::panic` (`/tmp/hepta-normalization-final-strict.log`). All service library/test targets passed Clippy `-D warnings` in 20.38 seconds (`/tmp/hepta-normalization-all-test-clippy.log`). Oracle ESLint passed under its final `.mjs` filename.
- `/tmp/hepta-schema-normalization-stable-files.json` records exact current bytes, promotion paths, minimal parent wiring and validation boundaries. Main-workspace integration and its full regression gate remain owned by the root task.

Exact integration symbols: `actual_process_crash_after_checkpoint_and_before_publication_resumes_signed_bytes`, `actual_ten_database_normalization_records_match_node_and_keep_exclusive_lock`, `actual_wall_clock_signed_lease_completes_ten_database_wal_normalization`, `cached_scope_rechecks_namespace_inode_sidecars_and_final_lease`, `pristine_rebind_normalization_preserves_verified_genesis_and_matches_node`, and `signed_node_engine_wal_reservation_is_rejected_before_native_source_writes`.

Exact physical symbols: `real_other_process_write_lock_cannot_wait_past_maintenance_lease`, `replaced_stale_shm_is_restored_without_deleting_foreign_inode`, and `wal_appearing_at_quarantine_checkpoint_preserves_original_shm`.

## Remaining execution work

Metadata/genesis installation requires all ten EXCLUSIVE transactions, fixed target DDL application, v1 exact metadata insertion or v2 source-genesis/pristine validation and exact trigger-preserving rebinding, real post-schema/pristine checks, commit lease checks, durable per-database installation records and recovery of commits that occurred before progress publication. Those operations are not supplied by this normalization token yet. Fresh runtime activation and actual external service qualification remain separate capabilities.

Run from the repository root with the pinned Node oracle runtime:

```bash
cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --test schema_normalization_parity --locked
cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --lib state_database_inventory::schema_source::normalization_support --locked
```
