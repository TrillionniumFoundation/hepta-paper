# Native schema target projection and SQL application

This slice implements the fixed SQLite target-schema operations used by the
schema-transition executor. It executes real DDL and verifies actual SQLite
schema rows. It does not acquire migration authority, normalize source journals,
install authority/genesis metadata, publish transition state, or expose the full
operator CLI.

## Source and implementation

The reviewed source is the target-schema, target-object assertion,
handoff-migration validation/application, schema hash and bundle hash chain in
`paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs`.
The SQL definitions come from `autonomous-research-online-authority-journal.mjs`
and `paper-adapters/persistence/autonomous-submission-handoff-store.mjs`.

Native implementation is `online_schema_transition/target_schema.rs`:

- `SchemaTransitionTargetV1::for_role` selects the fixed mutation-marker schema,
  adds the authority journal for `resident-instance`, and adds the v2 handoff
  migration for `submission-handoff`. It creates in-memory SQLite schemas and
  reads `sqlite_schema` to derive the expected objects. Private target fields
  and no Deserialize prevent callers from substituting arbitrary SQL.
- `schema_transition_bundle_hash_v1` computes the journal/marker contract hashes
  and complete bundle hash from the actual SQL and migration definitions.
- `assert_schema_transition_target_objects_v1` compares existing objects against
  those derived from real SQLite. Existing conflicting definitions are refused
  with the same object name and source error code.
- `apply_schema_transition_statements_v1` applies missing fixed objects, inserts
  a pending handoff migration record, and verifies the final definitions and
  migration history. It leaves transaction commit/rollback to the caller, as
  the source helper does. Handoff requires an already-active transaction. A
  transaction by itself is not proof of an external migration reservation.
- `project_schema_transition_target_v1` copies the actual database with SQLite's
  Backup API into an isolated in-memory connection and applies/commits the
  target there. It computes pre/post schema hashes from actual rows and checks
  quick_check and foreign keys. No source DDL or journal-mode changes occur.

`schema_data.json` contains fixed source SQL/migration definitions mechanically
extracted from the original exports. It is implementation data, not a fixture
of expected inspection outputs. The differential test compares all statements,
actual derived objects, migration metadata, and computed bundle hash with the
currently running original source, detecting any definition drift.

## Handoff v1 to v2 invariants

The implementation checks the exact migration count, versions, names, hashes
and valid timestamps. A v2 migration row without the target table is partial
state; a target table without the matching migration history is a conflicting
preimage. An already-completed upgrade remains idempotent, including when no new
applied-at time was supplied.

A pending upgrade requires one active cutover with a valid activation timestamp,
an empty submission outbox, successful SQLite quick_check, no foreign-key
violations, the fixed v2 migration identity, and a valid applied-at time. The
migration row is written with a canonical UTC timestamp and the final history is
verified. The caller retains its transaction on both success and failure and
owns rollback. Integration tests actually roll back failed DDL/migration writes
and compare the resulting complete schema against the original source.

## Bounds and authority boundary

Projection refuses an already-active source transaction. It holds one deferred
read snapshot across the page-size/page-count bound and backup, preventing an
external writer from increasing the snapshot beyond the checked 256 MiB limit.
Backup performs one complete step and refuses a non-Done result rather than
retrying indefinitely. Schema/metadata reads are bounded to 2,048 rows, sixteen
columns and 16 MiB of text, with valid UTF-8 required. Timestamp acceptance uses
the existing native canonical UTC-millisecond profile.

The projection result is an unauthenticated local report, not an opaque ready
capability or a plan pinned to a live filename. It observes the SQLite snapshot
provided by the caller. A complete executor must separately obtain actual
inventory/file identities, verify an opaque external reservation and lease,
normalize journals, bind expected pre/post hashes, manage interrupted state,
install metadata and collect signed finalization/observation before claiming
completion. The exported DDL helper cannot establish these conditions.

## Verification

`tests/online_schema_target_parity.rs` and
`rust/oracle/online-schema-target-v1.mjs` run original Node 22.23.1 and real native
SQLite:

1. `fixed_schema_templates_objects_and_bundle_hash_match_original_node` compares
   eight role/time combinations, complete SQL, actual object rows, migration
   metadata and bundle hashes.
2. `actual_sqlite_handoff_upgrade_and_failure_rollback_match_node_twenty_one_paths`
   compares complete outcomes for twenty-one cases: normal/idempotent upgrades,
   transaction absence, missing/altered history, partial v2 state, cutover
   problems, nonempty outbox, actual foreign-key violations, invalid target
   times, injected migration-insert/postcondition failures, and target-schema conflicts before
   or after DDL. Failure rollback leaves the complete original schema intact.
3. `projection_uses_a_real_private_sqlite_copy_and_leaves_source_schema_and_rows_untouched`
   compares six successful/failing projections against real source application,
   checks unchanged source schema and migration rows, and verifies refusal does
   not roll back a caller's existing transaction.

All databases in these tests are disposable in-memory databases. No deployment
database, private key, or external authority service is accessed.

All three tests passed after holding the source read snapshot across the bounded
backup (0.70 seconds, zero failures). Strict production Clippy with warnings,
unwrap/expect/panic and unsafe-code denied also passed after this change.
