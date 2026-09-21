# Explicit Node authority journal migration design

Status: **live migration executor design only, 2026-09-21**. Read-only schema, bounded authenticated history and detached memory-image conversion are implemented below. No live migrator, maintenance capability or deployment approval is implemented by this document. Existing native `LocalStateAuthorityRuntimeV1::open` must continue refusing populated `user_version=0` journals with `local_state_authority_explicit_journal_migration_required`.

The first read-only prerequisite is now implemented in
[`migration/source_profile.rs`](migration/source_profile.rs), exposed by
`migration::inspect_legacy_authority_journal_schema_v1`. It checks the exact
source schema under the caller's actual main transaction, preserves connection
settings and locks, and returns only a structural observation. See its
[contract and limits](migration/source_profile/HANDOFF.md).

The second prerequisite, `migration::LegacyAuthorityJournalVerifierV1`, now
loads independently pinned public inputs and observes the complete admitted
SQL history under the same held transaction. Initial genesis, activated pristine
rebinds, settled finalized mutations and a genuine aborted tail are re-derived
and compared with actual metadata and all ten heads. Its
[contract and limits](migration/history/HANDOFF.md) explicitly refuse pending
operations, all backup history, unknown configurations and oversized histories.
It opens no private key and grants no migration or stopped-service capability.
The same pinned owner also provides `build_offline_native_image(&Connection)`:
the already verified SQL snapshot is copied into a fresh memory-only native
database, preserving all six original tables' rowids and raw TEXT, adding the
actual pinned public-key identity and native format, and safely serializing a
standalone image. See the [offline artifact contract](migration/offline_image/HANDOFF.md).
It accepts no destination path and leaves the source transaction untouched.
Durable archive/publication, uncertain live-commit recovery and maintenance
capabilities proposed below remain unimplemented.

## Concrete source compatibility

The source is the six-table authority database initialized by `paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs`, not the ten business databases and not `campaign.sqlite`.

An actual Node 22.23.1 in-memory DDL comparison performed for this design found:

| Table | Node/native stored `sqlite_schema.sql` |
|---|---|
| `authority_metadata` | Exact match, 493 bytes |
| `authority_database_head` | Exact match, 244 bytes |
| `authority_schema_transition` | Exact match, 245 bytes |
| `authority_schema_rebind` | Exact match, 266 bytes |
| `authority_backup_reservation` | Exact match, 229 bytes |
| `authority_mutation` | Node 473 bytes; native 466 bytes |

The seven-byte difference is the unconditional ` UNIQUE` on `global_sequence`. Node has three mutation autoindexes (attempt PK, reservation UNIQUE, global sequence UNIQUE), leaves `user_version=0`, and uses WAL/FULL. Native removes that global constraint, adds `authority_live_global_sequence WHERE status != 'aborted'`, adds `authority_native_identity(singleton,key_hash)`, and sets `user_version=1`. The key hash is `hash_bytes(actual Ed25519 verifying_key.as_bytes())`, not a caller-supplied public-key label. A separate schema-only in-memory experiment executed rename/create/copy/drop plus `user_version=1`, matched the exact native schema inside the transaction, then rolled back to the exact Node schema and version zero. This validates the DDL shape only; it is not a migration implementation or a signed-history test.

Node's initializer does not inspect `user_version`; `CREATE TABLE IF NOT EXISTS` allows it to open the migrated database and continue operating. A format version, native identity table, adjacent marker, successful SQLite lock or absent socket therefore **cannot fence the old implementation**.

The actual deployed unit is `paper-core/deploy/hepta-paper-state-authority.service`, with `Restart=always`, `User=hepta-state-authority`, Node `ExecStart`, a configured private key, and `/var/lib/hepta-paper-state-authority` state. Existing `hepta-cutover::VerifiedLegacyNodeFreezeV1` validates a schema-25 business database and is not an authority-service stop or authority-journal proof.

## Minimum executable boundary

Use an explicit, one-shot, **same-path in-place schema migration**. Keep the complete daemon configuration, key, authority/key/scope identifiers and all receipt bytes unchanged. Do not combine migration with key rotation, path relocation, schema rebind activation, business writes, backup recovery or service start.

Proposed source files are `local_state_authority/migration.rs`, `migration/source_schema.sql`, `migration/history.rs`, `migration/tests.rs`, and a separately implemented maintenance owner. The Node schema reference must be a reviewed source-owned constant, not DDL supplied by a request. Reuse native `schema.sql` for the replacement table and native additions.

Illustrative API; these types/functions **do not yet exist**:

```rust
pub struct NodeAuthorityJournalMigrationRequestV1 {
    pub configuration_path: PathBuf,
    pub expected_configuration_hash: String,
    pub online_authority_configuration_path: PathBuf,
    pub expected_online_configuration_file_hash: String,
    pub expected_source_logical_hash: String,
    pub archive_directory: PathBuf, // existing private directory; fresh output only
}

// No Deserialize, Clone, public constructor or caller-set stopped boolean.
// Owns actual supervisor/restart-exclusion observations for this installation.
pub struct StoppedLocalAuthorityMaintenanceV1 { /* sealed */ }

pub fn migrate_node_authority_journal_v1(
    request: NodeAuthorityJournalMigrationRequestV1,
    maintenance: StoppedLocalAuthorityMaintenanceV1,
) -> Result<NodeAuthorityJournalMigrationReportV1, MigrationError>;
```

A separate inspection entry point may calculate the source logical hash and blockers. Its serializable report conveys no migration permission. `expected_*` values are optimistic concurrency requirements, not authorization. The executing owner reloads and verifies actual inputs and all journal state. Configuration parsing/private-key retention can be factored from `storage::Inputs::load`; it must not call `open_database`, whose normal operation intentionally refuses Node format. The owner must retain the installation/namespace guards until all SQLite connections close. Load the actual pinned online authority configuration/public-key document through the existing `PinnedMutationAuthorityV1` file-verification path without invoking a transport. Factor a crate-private comparison of its retained public key with the supplied signing key, or factor the closed identity loader, rather than accept a public-key hash string as proof. The public verifier configuration must match the daemon authority/key/scope/writer/lease settings; this is especially necessary for an uninitialized journal with no historical signature. Capture these snapshots before SQLite too.

The report should contain source/native schema profile IDs, actual configuration/key hashes, source and post-migration logical hashes, per-table row counts, original path identity, verified archive hash, and `committed: true|false|null`. It must not contain private key bytes or claim deployment qualification, native writer admission or production activation. An uncertain commit yields inspection-required and no automatic retry.

## Stop and restart exclusion is a real prerequisite

A production maintenance producer must bind the exact installed authority unit, canonical database/configuration/key paths, actual configured principal and old executable/argv identity. It must stop the service through its actual supervisor, wait for the tracked process identities and descendants to exit, and retain an effective restart blocker throughout validation, commit and native handoff. For the current systemd installation this needs real manager/job/unit observations, the actual unit/control-group identity, empty stopped service group, and an installed maintenance/restart barrier. A raw PID, one `is-active` result, `/proc` search, `systemctl stop` exit code or JSON certificate is insufficient. No such producer currently exists in this module.

The barrier must remain effective after migration; releasing it while the old `Restart=always` unit still names Node is unsafe. An error/unwind must leave an installed, inspectable maintenance state, not silently restart Node. Finishing requires the separately authorized deployment owner to select the real Rust daemon and verify its installed executable/configuration before removing the barrier. Manual same-principal processes or another service with access to the key/database require that same installation access-control policy; a journal parser cannot prove their absence.

SQLite supplies transaction exclusion, not service retirement. `BEGIN IMMEDIATE` excludes another writer transaction; in WAL mode `BEGIN EXCLUSIVE` has the same concurrency behavior. Neither proves an idle old process has exited. See [SQLite transaction semantics](https://www.sqlite.org/lang_transaction.html).

Until the maintenance producer exists, locally implementable preparation may validate and transform **a detached archive** and report its result, but must not expose live publication or return a stopped-service capability. That narrower tool must describe itself as an offline artifact conversion.

## Admitted SQL states for the first closed version

Always require the exact six-table Node schema, expected autoindexes/constraints, `user_version=0`, no native additions, no extra trigger/view/index/table, `quick_check`/`integrity_check` success, and finite safe integer sequences. Compare a memory-only reference schema and `table_xinfo`/`index_list`/`index_xinfo`; do not disable constraints or use `writable_schema`.

| Actual state | First-version disposition |
|---|---|
| `uninitialized`; zero heads; no transition, rebind, mutation or backup rows | Admit after exact deterministic initial global hash/config identity validation |
| Initial schema transition `reserved`, including expired reservation | Refuse; source protocol recovery must finish first |
| `finalized`; genuinely signed initial schema transition; exactly all ten heads; no mutation/rebind/backup rows | Admit after reconstructing genesis and exact heads |
| `finalized`; complete signed finalized mutation chain; no reserved mutation and no backup rows | Admit only after complete chain replay reproduces every current head and metadata |
| Same as previous, with a genuinely signed aborted terminal attempt against the current head | Admit; preserve the aborted row and its sequence. The new partial index repairs next-reservation liveness without deleting evidence |
| Any reserved mutation, even expired | Refuse. A local business commit may already exist; expiration is not proof that an abort is safe |
| Pending or finalized-but-not-activated rebind; metadata `reserved` | Refuse; settle/activate under the correct source protocol/configuration before format migration |
| Completed, activated rebind history; no pending transition and no backup rows | Admit only when the complete unique signed rebind chain reconstructs the current configuration and all ten heads; otherwise refuse |
| Any backup row, including completed or expired | Refuse in the first closed version; see the historical-fencing issue below |
| Missing/wrong key, unknown old schema, extra objects, gaps, mismatched hashes, malformed/ambiguous JSON or inconsistent nullable columns | Refuse without rewriting source rows |
| Native version 1 or mixed Node/native schema | Do not migrate or repair automatically; identify it read-only, and use exact native validation for uncertain-commit inspection |

Read the classification under the same transaction used for the eventual rewrite. One suitable initial rejection query is:

```sql
SELECT count(*) FROM authority_mutation WHERE status='reserved';
SELECT count(*) FROM authority_backup_reservation;
SELECT count(*) FROM authority_schema_rebind
WHERE finalization_receipt_json IS NULL;
```

These counts are necessary, not sufficient; the signed history validation below is still mandatory. Neither `max(global_sequence)` nor a receipt count substitutes for replay.

## Complete history validation before rewriting

1. Require exactly one metadata row and complete actual configuration hash agreement using `HeptaLocalAutonomousResearchStateAuthorityConfiguration`. The actual supplied key must verify every retained online and schema receipt. Reject mixed keys/identities; do not re-sign history under a replacement key. An uninitialized journal has no signed key history, so its initial binding additionally depends on the real installed configuration and independent authority public-key pin, not merely matching textual key IDs.
2. Parse every persisted request/receipt with the existing strict parser. Preserve each original TEXT byte sequence for copying; normalize only for contract validation/hashing. Reject duplicate keys, nonfinite numbers, unsupported encodings and unsigned extra fields. Check each SQL key/sequence/instance/status column against its signed payload and exact NULL pattern.
3. Validate initial reserve/finalize with `contracts::schema_transition` at their signed historical times and the same actual key. Reconstruct the incumbent `HeptaLocalStateAuthorityGenesisGlobalHead`, `...DatabaseGenesisHead`, and `...DatabaseGenesisState` from the initial request/configuration. Compare signed genesis and actual initial state; a well-formed hash alone is insufficient.
4. Replay rebinds as one unique content-linked chain from that genesis, not merely `ORDER BY rowid`. Verify each reservation/finalization, source writer hash, previous global/hash/ten heads, deterministic `build_pristine_schema_rebind_genesis_v2`, and complete target configuration hash. Source-to-target transitions change only the fields permitted by the existing rebind producer. Historical configuration values that cannot be reconstructed or independently provided/pinned cause refusal. Check the preserved rowid/latest-row interpretation used by `inspect`; retain rowids during copying. The final activated epoch must exactly match current metadata. Mutations must belong to the final epoch because pristine rebind forbids *all* mutation rows.
5. Replay finalized mutations from sequence 1 through the actual metadata sequence. Use `verify_reservation_v1` at `issuedAt`, `verify_finalization_v1` at `finalizedAt`, actual Ed25519 verification, and the existing state/local-marker hash calculations. Recompute the incumbent global/database head hashes from the actual reserve request. Verify every global predecessor and each touched database predecessor, schema/state continuity, changeset hash/length, reservation/request bindings, and final side-effect permit hash. Reconstructed **all ten** heads must equal `authority_database_head`, including untouched roles. Late authority finalization remains legal when the original local commit met the reservation contract; do not incorrectly require finalization before the mutation lease expired.
6. Verify every abort with its stored reservation, original request and actual signature. A genuine Node journal with the unconditional unique index can contain an aborted next-sequence tail but cannot legitimately continue through that consumed index slot. The aborted reservation must branch from the reconstructed current head and must not advance global/database state. Reject apparently repaired/custom histories outside the exact Node profile. Preserve the abort's request, receipt, rowid and global sequence; only the uniqueness rule changes.
7. Require mutually exclusive status columns: `reserved` has no finalize/abort pair; `finalized` has exactly a finalize pair and no abort pair; `aborted` has exactly an abort pair and no finalize pair. Partial pairs, wrong SQL keys, duplicate identities, phantom heads, truncated chains and signed rows transplanted under another SQL key all fail.

Existing helpers in `mutation.rs`, `schema.rs`, `schema_rebind.rs` and `backup.rs` verify individual retained receipts. Calling a handler to "check" data would sign/mutate and is inappropriate. The implemented pure `migration/schema_history.rs` and `migration/mutation_history.rs` now add deterministic Node genesis/head reconstruction and complete replay for the bounded admitted source matrix; `migration/history.rs` binds them to actual public-key/configuration pins and terminal SQL state. This is an authenticated observation, not a migration capability. An executing owner must still prove the private/public key relationship, exact installed source provenance, archive and held maintenance barrier before any rewrite.

### Why first-version backup refusal is necessary

The actual Node handler can sign `allRegisteredMutationsFencedThroughFinalize=true` for an old backup head while a mutation was reserved and finalized in its interval. This was reproduced against the real Node source. A valid Ed25519 signature therefore does not establish the claimed fencing invariant. Simply importing a completed row would allow native backup finalize's historical idempotent path to return that old signed claim.

Do not silently discard, re-sign, relabel or trust these rows. An unrestricted backup-history importer needs independently verified snapshot/restore evidence and a concrete history/epoch binding, or a new explicit imported-evidence provenance format whose consumers refuse to treat old claims as newly qualified native fencing. Timestamp ordering alone is not a robust replacement: the Node clock did not enforce monotonicity. That is a separate protocol/schema change, not part of the two-object native format delta. Conservative refusal of *all* backup rows makes the initial migration admission decidable and honest, albeit intentionally narrower than existing deployed histories.

## In-place transaction and durable archive

Prefer an in-place transaction because it preserves the signed `stateDatabasePath` and complete configuration hash, does not replace an inode under a live SQLite handle, and avoids publishing a separate database/WAL/SHM file family.

The owning sequence is:

1. Acquire and retain the actual maintenance barrier. Capture configuration/key/directory observations before any SQLite connection. Prepare a fresh private archive location without overwrite. Never open/close a raw descriptor that can alias the source main/WAL/SHM while a SQLite connection exists; source/currentness checks during transactions use retained observations, SQLite queries and namespace metadata.
2. Produce a consistent logical archive using SQLite's backup API, with its own SQLite-managed destination. Finish and close both SQLite connections before raw archive hashing/fsync/permission publication. Do not `fs::copy` just the main file: committed state can still be in WAL. Hold the maintenance barrier, then reopen the source and compare its complete logical hash against both the reviewed expected hash and the archived snapshot under the final IMMEDIATE transaction.
3. Under that transaction, revalidate all six tables/history and exact source identities. Execute the closed schema rewrite below. Preserve every original row, rowid and TEXT byte sequence. Do not update metadata heads, configuration hash or signed payloads.
4. Check native schema against `schema.sql`, key identity, per-table counts and a row-stream hash of all original columns/rowids. That hash must be unchanged; only schema/version/native-key additions may differ. Re-run integrity checks and retained maintenance/configuration/namespace checks before COMMIT.
5. COMMIT, close the owning connection, and only then release file evidence or perform new regular-file observations. Return the report. Keep the external maintenance state in force until a separate qualified native service handoff completes. On COMMIT uncertainty, inspect exact Node/native schema plus current logical hashes; do not repeat a possibly completed transformation or restart Node.

The WAL file is part of SQLite's persistent state when it contains uncheckpointed commits. Do not delete `-wal`, `-shm` or a journal to satisfy a sidecar-free precondition; let SQLite complete any explicit checkpoint and check its result. See [SQLite WAL persistence](https://www.sqlite.org/wal.html) and [checkpoint return values](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint).

The backup API must complete successfully, including `SQLITE_DONE`, before treating its destination as an archive. It uses a separate destination connection and has source-write-transaction restrictions; do the archive phase before the final migration write transaction, then compare the source again under that transaction. The workspace already enables rusqlite's `backup` feature. See [SQLite backup API contract](https://www.sqlite.org/c3ref/backup_finish.html).

The concrete rewrite, expressed schematically, is:

```sql
BEGIN IMMEDIATE;
-- Exact source schema + full signed replay + archive/CAS checks occur here.
ALTER TABLE authority_mutation RENAME TO authority_mutation_node_v0;
-- Execute source-owned native schema.sql: this creates the replacement table,
-- the partial live-sequence index and authority_native_identity.
INSERT INTO authority_mutation(
  rowid,mutation_attempt_id,reservation_id,status,global_sequence,
  database_instance_id,reserve_request_json,reservation_receipt_json,
  finalize_request_json,finalization_receipt_json,abort_request_json,abort_receipt_json
)
SELECT rowid,mutation_attempt_id,reservation_id,status,global_sequence,
  database_instance_id,reserve_request_json,reservation_receipt_json,
  finalize_request_json,finalization_receipt_json,abort_request_json,abort_receipt_json
FROM authority_mutation_node_v0 ORDER BY rowid;
DROP TABLE authority_mutation_node_v0;
INSERT INTO authority_native_identity(singleton,key_hash) VALUES(1,?1);
PRAGMA user_version=1;
-- Exact native schema + original row-stream equality + final guards.
COMMIT;
```

`?1` comes from the actual retained signing key's verifying key. The owner executes the embedded schema constant; it accepts no caller SQL. A pre-commit failure rolls back the rename/copy/drop/index/key/version changes together. Test SQLite interruption/full/IO failures explicitly rather than assuming every error automatically rolls back. [SQLite documents transaction error behavior](https://www.sqlite.org/lang_transaction.html).

## Why not copy-and-publish first

A fresh native copy is useful as a **detached review artifact** and keeps the original untouched. Live publication is more complex: changing the configured path changes a signed configuration hash; replacing the same path requires all old SQLite handles to be gone and correct treatment of the complete WAL family; an ordinary rename alone does not establish authority ownership. Publishing the new journal, selecting the native unit, retaining the original archive and recovering an interrupted publication need an additional durable state machine. No such publisher exists here.

Therefore the first implementation should either perform the guarded in-place migration above, or stop at explicitly detached artifact conversion. It must not claim atomic live cutover from an unguarded copy/rename.

## Meaningful local acceptance tests

- Generate **actual Node** journals with an isolated supplied fixture key, using the incumbent runtime and signed requests; test both clean close and genuinely nonempty committed WAL. Never use a caller-created "verified" migration object.
- Migrate uninitialized, signed pristine genesis, a settled multirole mutation chain, a genuine aborted-next-sequence tail, and completed activated rebind history. Verify original TEXT bytes/rowids and all heads survive; actual native runtime opens; abort-tail next reservation succeeds without erasing the aborted row; supplied-key verification and incumbent Node contract verifiers still accept preserved receipts.
- Refuse wrong key/configuration, pending mutation (including expired), pending schema/rebind, every backup-row state, actual reproduced false-fence backup history, altered signatures, transplanted SQL identities, missing chain entries, extra heads, unsafe integers, duplicate JSON keys, custom indexes/triggers and mixed native/source schema. Confirm zero source row changes.
- Keep a real idle Node authority alive: show that IMMEDIATE/WAL EXCLUSIVE acquisition and absent/unpublished socket do not qualify as process retirement. Separately demonstrate that the old Node runtime can still open the migrated native schema; do not accidentally describe `user_version=1` as an old-client fence.
- Exercise the real maintenance producer with an isolated managed service/process, its actual descendant lifetime and a restart attempt while the barrier is held. If CI cannot run a real service manager, mark that acceptance unavailable; an injected `stopped=true` stub cannot satisfy production retirement.
- Inject errors after each rename/create/copy/drop/key/version step and before commit; kill a separate migrator process at durable boundaries; reopen and require a complete Node or complete native format. Cover uncertain COMMIT without automatic replay.
- Test symlink/hardlink/ancestor replacement, a peer SQLite writer blocked during migration, and same-process observer lifetimes. Hashing, logging and failure cleanup must not reopen/close source main/WAL/SHM raw descriptors while SQLite owns locks.
- Archive source changing between snapshot and final transaction must fail the logical CAS. Archive collision, failed backup, full disk and incomplete publication leave a clear failure plus retained source; never overwrite an archive or delete sidecars as cleanup.

## External conditions still required

Locally writing/testing the format transformer, complete signed replay, archive handling and failure recovery is possible. A running deployment's actual private/public key pins, exact configuration and Node journal, controlled shutdown of all legitimate authority writers, restart exclusion, root-owned native executable/unit selection, independent backup evidence when applicable, and operational acceptance are installation inputs. No local fixture or hash report supplies those facts. Production migration must remain unavailable until the real maintenance/handoff path supplies them.
