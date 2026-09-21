# Legacy authority source schema inspection

`migration::inspect_legacy_authority_journal_schema_v1(&Connection)` inspects the
exact original Node authority journal structure. It returns a schema-only JSON
report, with no migration, process-stop, signed-history, file-identity, or
production authorization. The sealed `SourceProfile` is constructed only by the
actual inspection; callers cannot deserialize a claimed successful observation.

The caller must already own an actual READ or WRITE transaction on `main`.
Autocommit, a bare deferred BEGIN without a main snapshot, and a transaction
holding only another attached database are rejected. The inspector does not
start, commit, or roll back a transaction, change connection PRAGMAs, or change
rows. It accepts a read-only connection and preserves `query_only` settings.
It requires both `ignore_check_constraints` and `writable_schema` to be OFF;
inspection rejects an ON setting without changing it. In particular, SQLite
can return `quick_check=ok` for a CHECK-violating row while
`ignore_check_constraints` is ON, so that result cannot be accepted.

`source_schema.sql` contains the six original CREATE TABLE statements from
`paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs`.
It excludes that initializer's journal/synchronous/foreign-key PRAGMAs. A fresh
memory-only SQLite reference supplies the expected schema metadata. Inspection
requires `user_version=0`, the complete twelve-object catalog (including every
autoindex), and exact table/index SQL, `table_xinfo`, `index_list`, and
`index_xinfo` results. There are six autoindexes overall, including all three
original mutation uniqueness indexes. Extra tables, indexes, triggers, views,
changed constraints/collations/defaults, mixed native objects, and native schema
versions are rejected. `quick_check` must return exactly one `ok` row.

All source statements must pass SQLite's `readonly()` check before stepping.
Queries are restricted to `main`; names passed to table-valued PRAGMAs are bound
parameters. The complete catalog is compared before querying any source index
metadata. Each query accepts at most 64 rows, seven columns, 4,096 bytes per text
cell, and 32 KiB of cell payload; limits are checked before copying values. Once
the catalog matches, the six tables and six known autoindexes bound the remaining
query count and report size. These limits bound collected output, not SQLite's
internal schema parsing or the time required for `quick_check` to scan a large
database.

The schema hash uses `HeptaLocalStateAuthorityNodeJournalSourceSchemaV1` with the
existing canonical record hash implementation. Root pages must be positive,
distinct, and within the actual page count, but physical allocation is excluded
from the schema hash. The hash does not cover row history, current signed heads,
database bytes, or WAL contents. A corrupt CHECK-constrained row is caught by
`quick_check`; a structurally valid but false receipt remains the responsibility
of a future complete history verifier.

No source path is opened or source file descriptor cloned or closed. Inspection
uses the caller's held SQLite connection plus a separate in-memory reference,
so it does not release process-scoped SQLite locks by closing a raw alias. The
caller remains responsible for source-path ownership and lifetime outside this
API. The supplied connection's historical schema cache, custom authorizer, and
extensions are not independently authenticated by this inspection. Rejecting
current unsafe PRAGMA settings does not attest to that connection's history or
to an independently opened source. No public migration executor or maintenance
capability is added.

Tests use the actual Node 22.23.1/ICU 78.2/CLDR 48 profile and original runtime to
create isolated files with a fixture-provided key. They compare the full schema,
preserve actual rows/bytes/settings, reject structural and collection-limit
changes, exercise genuine main-transaction requirements, and use a separate
process to prove both DELETE and existing WAL writer locks survive inspection
success and failure. Actual CHECK-violating rows with ignored constraints and
current writable-schema settings are rejected while rows, settings, transaction
state, and the cross-process writer exclusion remain unchanged. Fixture keys
never enter reports. Raw byte comparison is
performed only before opening and after closing the source SQLite connection.

Run from the Rust workspace with the qualified Node on PATH:

```text
cargo test -p hepta-paper-service --lib local_state_authority::migration::source_profile::tests
```

The remaining migration work is described in
`../../JOURNAL_MIGRATION_DESIGN.md`: complete signed-history validation, explicit
legacy-daemon stop/restart exclusion, archive and transaction publication, and
recovery behavior. This source-profile layer implements none of those steps.
