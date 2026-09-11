# Durable cutover and legacy retirement

`hepta-cutover` contains two complementary source contracts:

1. `DurableCutoverCoordinatorV1` — cooperative Node/Rust writer fencing used for
   local/shadow comparison, backup/restore drills and controlled ownership handoff;
2. `retirement` — immutable schema-25 Node database drain/freeze verification for
   the final forward-only production retirement path.

Neither contract grants provider, scientific, release, portal or submission
authority.

## Cooperative cutover coordinator

Create the coordinator only while incumbent writers are stopped and drained under
the maintenance boundary. Enrollment binds the exact application database and
creates non-overwritable journal/marker files. Participating Node and Rust writes
hold the same coordinator lock; stale generations and missing/replaced enrollment
state fail closed.

The durable transition sequence supports:

```text
enroll -> quiesce -> backup/restore drill -> shadow comparison
       -> local canary -> local promotion/ownership rollback
```

Every transition uses an expected revision and appends a chained SQLite journal
entry. Backup output is never silently adopted after a crash. Shadow comparison
requires actual output bytes from both implementations and any mismatch blocks
progression.

The coordinator is intentionally schema-neutral. It proves writer exclusion,
replay and ownership mechanics; it is not the final legacy-retirement proof.

## Final production retirement

`verify_legacy_node_freeze_v1` implements the final production boundary on the
actual immutable Node migration-ledger database. It requires schema version 25
and inspects the typed logical snapshot for all known runtime surfaces.

The freeze fails unless:

- campaigns, nodes, jobs and job attempts are in accepted terminal states;
- prepared integrations are terminal;
- submission outbox/response/release-lock state is terminal;
- automation resource leases and waiters are empty;
- all lease/claim columns are empty;
- the database remains byte-identical throughout read-only inspection.

Consequently final retirement does **not** translate an active Node campaign into
the Rust writer schema. Active work must first drain to a terminal state. The exact
legacy database is then retained as an immutable historical archive, readable by
the Rust `hepta-readonly-store` compatibility implementation.

The verified freeze receipt binds repository/commit/tree, exact database content
hash, complete logical database hash, schema version, closed quiescence policy and
all table observations. It records:

```text
rollback_mode = pre_activation_only_then_forward_recovery
immutable_archive_required = true
node_writer_quiesced = true
```

## Rollback and forward recovery

Before the first authoritative Rust commit, the independently controlled cutover
process may abort and restore incumbent ownership under the accepted cutover
package. After the first authoritative Rust commit, restoring a stale Node database
would erase committed Rust records and is therefore forbidden. Recovery proceeds
forward from Rust state instead.

This is deliberately different from maintaining permanent reverse-schema
compatibility with a retired runtime. Historical Node state remains verifiable in
the immutable archive; future Rust-only state does not have to remain writable or
understandable by Node after retirement.

## Production composition boundary

The production Rust service independently requires all of the following opaque,
verified subjects before it can report production activation:

- complete external qualification closure;
- Node-free production deployment identity;
- verified legacy Node freeze receipt;
- independent writer-cutover authorization bound to the exact database preimage;
- exact running binary/configuration/host/service identities;
- a registry in which every legacy Node adapter is `retired`;
- native Rust workers only for the production composition.

The ordinary local/shadow service cannot manufacture these values and cannot turn
production on with a boolean or environment variable.

## Validation

Representative repository-local checks are:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-cutover
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-readonly-store
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service
node --test paper-core/tests/rust-cutover-fence.test.mjs
```

A successful local drill proves source behavior only. Target-host shadow/canary,
real authority packages, destructive storage/soak evidence and the final writer
transfer remain independently controlled production facts.
