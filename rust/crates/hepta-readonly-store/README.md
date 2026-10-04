# Read-only production Node database compatibility

`ReadOnlyStoreV1::open` accepts a canonical absolute path to a closed, complete
SQLite database. It uses `mode=ro&immutable=1`, `query_only=ON`, memory temporary
storage and an untrusted schema. It rejects WAL, SHM and rollback-journal entries
(including dangling symlinks), unsafe file identity, and any change to the file
identity or byte hash during inspection. Obtain a consistent, checkpointed copy
before inspecting a running service; never copy only a live WAL database file.

## Ordinary inspection profile v1

`OrdinaryReadOnlyStoreV1::open(absolute_path)` is the separate ordinary reader for
arbitrary user schemas. It uses SQLite `mode=ro`, a consistent read transaction,
`query_only`, untrusted schema and memory temporary storage. It never runs a
migration or grants source, release, cutover, writer-fencing or submission authority.
It accepts ordinary WAL coordination; the strict immutable opener above still
rejects every sidecar and still requires its recognized complete schema.

`node_logical_integrity_report()` preserves the complete production Node fields,
including blocked results for foreign-key or receipt errors. Serialize its
`OrdinaryNodeLogicalIntegrityReportV1` directly with `serde_json::to_writer` or
`to_string`: `invalidReceiptRows` retains raw JSON for ECMAScript numbers and
surrogate values, so converting the whole report to `serde_json::Value` loses that
wire scope. SQLite TEXT uses Node's UTF-8 replacement behavior in this ordinary
profile; the strict reader retains its invalid-UTF-8 refusal. Receipt selection
uses original property order, including duplicate updates and the last falsy
`*ReceiptHash` fallback; it reuses the existing production raw hash kernel.

The connection still opens by pathname. Held main/WAL/journal file hashes and
full named/held metadata, canonical target and held path directories are checked
before and after inspection. Every captured directory must retain mtime/ctime;
concurrent unrelated ancestor changes are an explicit native safety refusal.
This is not a claim that SQLite opened the held descriptor. SQLite WAL reads can
create coordination files. For WAL headers, this owner atomically prepares only
missing fixed WAL/SHM leaves as zero files through the held parent with NoReplace,
checks the exact entry delta, then captures the directory baseline before SQLite
opens. It never overwrites an existing leaf or deletes a possibly shared leaf on
failure. After this window, directory drift is refused without an SHM exception.
`coordination_observation()` reports these preparation effects separately from the
Node report. SHM content/readmarks may change; main/WAL/journal bytes must remain
fixed. If the prepared leaf cannot be reopened with SQLite's required permissions,
the ordinary read refuses; it never changes a preexisting file's permissions.

The closed native safety profile is **version 1**: 16 GiB per main/WAL/journal,
4096 schema objects and parent entries, 2 million rows per table, 1 MiB borrowed
cell, 16 MiB row and SQLite value limit, 4 GiB aggregate logical input, 2 MiB schema
and table-metadata preallocation budgets, 4 MiB retained invalid-receipt JSON and
8 MiB report serialization. The existing raw hash kernel's size/node/collation
limits still apply, including unpaired surrogate key refusal. These caps and path
stability rules are native refusals; Node does not have matching product limits.
The ordinary route therefore remains partial outside tested parameter and effect
profiles. Row hashes stream; the complete row set is never materialized in Rust.

`open_with_cancellation(path, Arc<AtomicBool>, Instant)` accepts the CLI's existing
signal flag and one absolute deadline. The maximum lifetime is 300 seconds; a caller may shorten that deadline.
SQLite VM progress and per-row/per-block file hashing check cancellation. A
blocking filesystem call or SQLite's bounded ten-second busy wait finishes before
the next check. Libraries install no process signal handlers. Cancelling may leave
new coordination leaves; reopening observes them rather than replaying deletion.

`fixed_inventory_projection_v1(&FixedInventoryBudgetV1::default())` exposes only
the fixed papers/submission-ledger/campaign join and venues query used by the
Node inventory producer. Typed raw cells preserve SQL NULL/text/number/BLOB values;
papers and venues retain separate failures. The profile preflights each input and
unsorted join to 1024 rows, then checks borrowed 64 KiB cells and a conservative
4 MiB aggregate JSON allocation bound before copying output. It does not expose
arbitrary SQL, alter YAML fallback rules, or turn missing columns/malformed JSON
into null values. Consumers still own normalization and selection policy.

The shipping `hepta-paper-rust verify store -- DB` normal entry resolves database and runtime defaults from its actual frontend, emits the raw report directly, exits one for a blocked report, and closes SQLite before output or signal termination. The ordinary Node/native process owner in `paper-core/tests/native-store-integrity-normal.test.mjs` executes default/relative paths, raw receipts, actual SIGTERM/SIGKILL and same-input retry, including the explicitly different cold 0400 SHM effects. These tests bind source behavior; complete route and live host acceptance remain separate.

The focused ordinary tests run the actual `hepta-paper verify store -- DB` Node
wrapper for arbitrary schemas, SQL values, live/closed WAL and explicit cap
differences, and exercise actual path replacement, cancellation and retry. The
`ordinary-report-v1` example is an explicit owner diagnostic harness for external
sealed inputs; it is not a delivery or host qualification command.

## Schema recognition

The production Node store records migrations in `schema_migrations`; it leaves
both `PRAGMA application_id` and `PRAGMA user_version` at zero. The effective schema
version is therefore **not** the user-version header.

`schema_version()` returns the validated migration version. `user_version()`
returns the unmodified SQLite header, normally zero for a Node database.
`schema()` also identifies `node_migration_ledger` versus the separate
`rust_campaign_writer` database format. A Rust campaign database is not a migrated
Node native store and cannot obtain a Node logical compatibility report.

Recognition requires:

- Exactly contiguous migration versions 1 through the effective version (1–25).
- Each recorded migration name and SHA-256 equal to its embedded production SQL.
- Exact tables, indexes, views and triggers equal to an in-memory replay of those
  same production migration files. Unknown extensions and altered constraints fail.
- The `store_metadata.schema_version` marker equal to the value produced by that
  replay. Historical migrations 9 and 11 do not advance this secondary marker;
  they remain valid when their ledger and schema agree with the actual migration.
- Expected header identifiers, SQLite quick-check success, and no foreign-key
  violations.

The shared verifier lives in `hepta-readonly-control::node_schema`. It never
executes migrations against the input database. The separate Rust campaign schema
is verified using its exported production schema, application ID and version.
Only complete exported control-log schema groups are allowed; the optional local
identity marker must contain its exact `local_only` row. `schema().local_only`
reports that distinction and never grants production cutover authority.
An arbitrary database with `PRAGMA user_version=25` is deliberately rejected.

## Hash contracts

`logical_snapshot()` is the typed Rust snapshot. It preserves SQLite value types
and exact signed 64-bit integers. Its domain-separated hash is a Rust protocol
value and is not interchangeable with Node's historical hash.

`node_logical_snapshot()` reproduces the production
`buildSqliteLogicalIntegrityReport` schema hash, per-table canonical-row hashes,
logical database hash and row counts. It uses the actual production hash encoding
implemented in `hepta-legacy-compatibility`, the same primary-key row ordering,
and the same schema-object projection as Node. SQLite BLOB values become objects
with numeric properties, matching Node's `Uint8Array` enumeration. JSON stored in
TEXT remains a string; it is not parsed or canonicalized again. Integers outside
Node's safe Number range are rejected instead of silently rounded. Invalid UTF-8
TEXT is rejected. This method produces hash evidence; it does not issue receipt
qualification or declare a campaign safe to cut over.

`node_logical_integrity_report()` adds the complete Node report envelope around
that snapshot: file-byte preimage/postimage hashes, SQLite `quick_check`, foreign
key violation count, receipt-ledger hash validation, and ordered blockers/status.
The `hepta-paper-rust store-integrity IMMUTABLE_DB` command emits this report as
JSON and exits nonzero when its status is blocked. `inspect-db` remains the
snapshot-only compatibility route.

`database_content_hash()` exposes the captured file-byte SHA-256 for worker
commands that pin an expected database preimage. Both snapshot APIs require
immutable inputs and verify that original byte hash again after reading. Header/schema validation is shared, so callers cannot bypass it by
selecting the other hash contract.

## Verification

`node rust/tools/create-node-store-compat-fixtures.mjs <empty-output-directory>`
creates all 25 databases through production `createDefaultPaperStore` and records
the actual production Node integrity reports. The generator uses real schema
columns for Unicode TEXT, numeric-key JSON strings, NULL, INTEGER, REAL and BLOB.
It never changes an existing database or production migration file.

`cargo test -p hepta-readonly-control -p hepta-readonly-store` regenerates these
fixtures and compares every version and table against the production reports.
It also exercises history gaps, spoofed names/hashes/header fields, future
versions, stale metadata, dropped indexes/triggers, added columns/tables,
foreign-key violations, active sidecars, byte preservation, logical data changes,
and unsafe integer rejection. A Node runtime with `node:sqlite` is required; use
`HEPTA_NODE_BINARY` to select it explicitly.

Earlier Rust diagnostic wire contracts are retained in an explicit compatibility
namespace; see [COMPATIBILITY.md](COMPATIBILITY.md) for provenance and limits.
