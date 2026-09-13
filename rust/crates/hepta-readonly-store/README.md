# Read-only production Node database compatibility

`ReadOnlyStoreV1::open` accepts a canonical absolute path to a closed, complete
SQLite database. It uses `mode=ro&immutable=1`, `query_only=ON`, memory temporary
storage and an untrusted schema. It rejects WAL, SHM and rollback-journal entries
(including dangling symlinks), unsafe file identity, and any change to the file
identity or byte hash during inspection. Obtain a consistent, checkpointed copy
before inspecting a running service; never copy only a live WAL database file.

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
