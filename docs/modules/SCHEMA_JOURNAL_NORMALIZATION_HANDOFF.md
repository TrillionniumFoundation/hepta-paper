# Native schema journal normalization and interrupted recovery

This native execution stage follows the observed source plan and signed maintenance reservation. It implements actual normalization of the ten registered SQLite files and a durable per-database progress journal. It does not install marker metadata or genesis rows, finalize a schema reservation, activate the runtime, qualify an external authority service, or deploy a production configuration.

## Source and API boundaries

The behavioral source is `paper-adapters/automation/autonomous-research-online-schema-transition-journal-normalization.mjs`, with the real schema-source projection, fixed DDL, inventory and Ed25519 contract already ported in the preceding slices. The added public module is `online_schema_execution::maintenance::normalization`:

- `normalize_schema_maintenance_v1` consumes a genuine `QuiescedSchemaMaintenanceV1`; there is no public constructor, deserializer, Boolean permission or arbitrary JSON authority argument.
- `resume_schema_normalization_v1` requires an expected transition ID and independently retained original plan hash, together with the actual manifest, writer manifest, pinned authority and clock. `ResumeSchemaNormalizationOptionsV1::expected_plan_hash` has no optional/default fallback. The stored journal is untrusted data until all cryptographic, physical and fixed-schema comparisons succeed.
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

After a process crash, an invalid plan pin is refused before source observation, root-lock enrollment or clock sampling. Recovery takes the real root lock, compares the journal with the independently retained original plan hash and transition ID before reading the clock, verifies the signed reservation and current lease, rebuilds a real local plan from actual files and the supplied fixed manifests, verifies all immutable subject/schema/pristine/instance/root fields, and requires its reconstructed reserve request to equal the journal request. Current normalized projections must exactly match the original reservation. It then re-observes every database; a completed flag cannot skip a check. Before returning a completed normalization token, every database must physically have the exact normalized digest and no WAL/SHM; merely having a valid future normalization projection is insufficient. An already checkpointed or already normalized file can complete recovery when its real reserved projection matches, even if the process exited before progress publication. If the target schema is already installed, recovery accepts only the current target schema hash, exact registered path/instance/schema contract, pinned file identity and absent sidecars, and emits Node-compatible `alreadyInstalled` records.

The stable transition ID is not the complete plan identity: the authority reserve
request excludes `plannedAt` and `planHash`. Rehashing a substituted plan can keep
the transition ID and all original signatures valid. Recovery therefore requires
the same independent original plan pin already required by installation recovery.
A pin copied from the journal under inspection is not independent. Refusal keeps
the conflicting journal and database bytes; it does not replan or request another
reservation. The pin is an identity constraint, not new execution or publication
authority. Restoring the original journal permits the normal recovery path.

An expired reservation cannot authorize a recovery write. Re-reservation after expiry, finalization and transition to a new normalization cycle require the later schema execution protocol. This slice deliberately preserves the current journal rather than overwriting it with an unrelated operation.

## SQLite engine byte compatibility

Pinned Node 22.23.1 uses SQLite 3.51.3; current bundled native SQLite is 3.53.2. Real WAL normalization updates the writer-version field at bytes 96–99 differently. The native implementation binds the genuine native normalized bytes and digest. It never rewrites that header to imitate another engine. A prior Node reservation whose expected normalized digest differs must fail before source writes. This cross-engine reservation interoperability remains an explicit qualification gap. DELETE fixtures not rewritten by SQLite can have fully identical bytes and records.

## Representation compatibility boundary

Node's v2 `validGenesis` compares generated genesis rows using `JSON.stringify`, which makes object member order observable even when the signed canonical JSON values are unchanged. The native authority API receives `serde_json::Value` and checks those signed semantic values; it does not reproduce that incidental member-order rejection after a Rust Value reserialization. The differential oracle preserves its genuine originally issued Node response object, checks that its complete signed payload and signature exactly match the native input, and invokes the unchanged Node verifier and normalization function with that original object. It does not forge a receipt, modify a source function body or freeze an output snapshot. Exact parity for rejecting alternate genesis member order remains a separate representation gap; successful normalization comparisons do not close it.

## Executable verification

The [canonical route ledger](../migration/NODE_RUST_GAP_CLOSURE.md) maps the
normalization, installation and physical-source owners to executable test symbols.
The existing `native-state-provisioning-source` bundle in
`docs/system/evidence/rust-functional-source-closure-v1.json` binds this recovery
owner and its original-plan-pin regressions. Exact commit/tree results belong in
the existing exact-head and deterministic prospective-merge execution receipts,
not duplicated historical timings or temporary paths in this contract.

`tests/schema_normalization_parity.rs` invokes the original Node normalization
function with real Ed25519 verification and temporary ten-database fixtures. The
suite covers both transition versions, original-output comparison, exclusive root
locks, process death after checkpoint and before progress publication, current
lease refusal, effective WAL data, exact normalized bytes, signature/request/root
and plan substitution, state drift and cross-engine refusal before writes.

The rehashed-plan regression retains the transition ID and valid original
reservation but alters unsigned `plannedAt`. Recovery must reject that different
complete plan, preserve all ten databases and the conflicting journal, and then
resume the restored original journal using the independent pin. Invalid-pin
coverage requires refusal before source and clock observation. Installation's
existing child-process recovery receives the original plan hash from its parent,
not the journal being recovered. Physical-source tests retain actual competing
SQLite writers, replaced stale SHM and WAL appearance during quarantine.

These local fixtures do not establish independent installed-service acceptance.

## Remaining execution work

This normalization token covers the signed lease and source-side journal
normalization boundary. The subsequent schema-genesis installation stage now
supplies all ten EXCLUSIVE transactions, fixed target DDL application, v1/v2
metadata and pristine validation, post-schema checks, durable per-database
installation records, and crash recovery; see
[SCHEMA_GENESIS_INSTALLATION_HANDOFF.md](SCHEMA_GENESIS_INSTALLATION_HANDOFF.md).
Fresh runtime activation, externally durable finalization and actual external
service qualification remain separate capabilities.

Run from the repository root with the pinned Node oracle runtime:

```bash
cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --test schema_normalization_parity --locked
cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --lib state_database_inventory::schema_source::normalization_support --locked
```
