# Executable Rust migration: implementation and acceptance boundaries

This document describes the source implementation added on top of
`6e56a3508e871018e1b4e0c5a573b50818032e38`, the canonical planning-provider replay
development baseline. It is a technical implementation record, not a qualification
receipt, deployment authorization, or declaration that Node is retired.

## Implementation map

| Layer | Concrete implementation | Technical development contract |
|---|---|---|
| Production hash compatibility | Actual Node source oracle; native JavaScript number/property and pinned locale collation semantics | [Legacy compatibility](../../rust/crates/hepta-legacy-compatibility/README.md) |
| Production SQLite read compatibility | Actual Node migration ledger versions 1–25; replayed SQL schema; production logical-report parity | [Read-only store](../../rust/crates/hepta-readonly-store/README.md) |
| Durable campaign authority | Writer lease, atomic state/accounting/event and full result/receipt log, crash recovery | [Campaign writer](../../rust/crates/hepta-campaign-writer/README.md) |
| Durable control execution | Persistent sequencer, replay validation and independent artifact-byte verifier | [Control plane](../../rust/crates/hepta-control-plane/README.md) |
| Runnable service | CLI/stdin composition, CAS, dispatch intent, native jobs and pinned process workers | [Service](../../rust/crates/hepta-paper-service/README.md) |
| Real broker dispatch | Authenticated request, role invocation, pre-exec gate, cgroup containment, output-schema validation, durable recovery | [Broker dispatch](../../rust/crates/hepta-codex-broker/DISPATCH.md) |
| Cooperative single writer | Durable journal, Node adapter fencing, backup/restore and same-database handoff/rollback | [Cutover](../../rust/crates/hepta-cutover/README.md) |

The module registry, manifests and module specifications link these roots.
Documentation coverage and source implementation remain separate from capability
equivalence and effective qualification.

## Database and hash compatibility

Node production leaves `PRAGMA user_version` at zero and records migrations in
`schema_migrations`. Recognition validates the complete contiguous migration
history, production SQL digests, exact replayed tables/indexes/triggers/views and
metadata. Merely changing a version header cannot make an unrelated schema valid.
The Rust campaign-writer schema is explicitly a different format.

The fixture generator calls the actual production `createDefaultPaperStore` for
each of 25 versions. The Rust reader compares schema hash, logical database hash,
row counts and every table's canonical row hash with Node's real integrity report.
It covers SQLite NULL/INTEGER/REAL/TEXT/BLOB and rejects unsupported unsafe Number
integers, changed files and active SQLite sidecars. Inspection requires a closed,
consistent copy; it does not checkpoint or migrate a live input database.

The original draft lexical hash format remains versioned. Production compatibility
uses the actual `workflow-kernel/record-hash.mjs` functions as oracle. The contract
includes JavaScript integer-index property order, stable locale comparisons,
number formatting and raw JSON insertion order. ICU/CLDR and Node identities are
pinned because a library's default collation is insufficient evidence of parity.
The compatibility README specifies supported inputs and fail-closed cases.

## Control, execution and failure behavior

The local Rust service runs the real planner/admission/dispatch/verifier/SQLite
pipeline. It no longer relies on an in-memory sequencer for durable acceptance.
The independent verifier checks actual artifact/evidence bytes; a hash-shaped
string or a self-described successful worker response is insufficient.

Commit persists the prepared body, receipt, expected/new state, campaign revision,
resource/budget debit and event atomically. Replay reads the original durable
history. Old snapshots cannot execute new work, and writer generation conflicts
cannot acquire authority through an alternate service instance.

Dispatch persists intent before launching a worker. A restart after intent but
before a complete prepared record requires reconciliation. The process bridge
records its actual language and pinned executable/source configuration; it never
counts a Node worker as a native Rust rewrite. The local process runner supervises
trusted code but does not enforce a production security sandbox.

The real broker API requires a caller-supplied, independently verified production
authority implementation. It checks authority at irreversible boundaries and
uses the existing gate and cgroup containment. Schema-validated provider output
does not automatically become an accepted campaign result: workspace mutation,
scientific validation, prepared-result integration and sequencer acceptance remain
separate contracts. No universal accept-all authority adapter is installed.

Broker recovery includes a quiesced backup bundle containing the journal and
durable result sidecars. Restore verifies an independently retained manifest hash
and requires fresh destinations. Active gates/cgroups and concurrent dispatch
prevent backup; restored evidence does not restore provider or host authority.
The older journal-only API rejects actual Codex dispatch history that requires
the complete bundle.

## Shadow, canary and rollback

The cutover coordinator binds its journal and enrollment marker to the exact
database identity. Node's real SQLite store adapter wraps mutating operations in
the same coordinator lock and generation check used by Rust. An old Node process
cannot silently refresh its writer generation when the database changes owner.

Initial enrollment requires maintenance mode, stopped admission and drained old
writers. A newly installed fence cannot retroactively stop a write already in
progress in code that never participated in the fence. Once enrolled, writer
callbacks and handoff share SQLite locking; missing/replaced authority state
fails closed. Direct database writers outside these adapters are outside this
cooperative guarantee and must be removed from the deployment's writer set.

The Node adapter also prevents scoped transaction callbacks from escaping their
owner's transaction through `query`, `run` or `execute`. The SQL boundary scanner
recognizes quoted strings/identifiers, comments, multiple statements and complete
trigger bodies, then rejects top-level transaction-control statements before
execution. A rejected statement poisons the entire unit of work even if its
caller catches the error. Outer migration transactions remain supported.

The disposable drill performs actual Node/Rust query comparison, consistent
backup and restore verification, canary ownership, process reopen, promotion and
rollback. Rollback changes ownership/epoch and **preserves post-cutover writes**;
it never replaces the current database with a stale backup.

This proves same-database ownership mechanics. It does not establish that every
Node business table has been translated into the separate Rust campaign schema,
or that Node can read every new Rust business state after a production rollback.
Production actions require the signed authorization path and exact database
preimage; local-mode commands cannot substitute for those requirements.

## Reproducible acceptance

```sh
cargo test --manifest-path rust/Cargo.toml --locked \
  -p hepta-legacy-compatibility -p hepta-compatibility \
  -p hepta-readonly-control -p hepta-readonly-store
cargo test --manifest-path rust/Cargo.toml --locked \
  -p hepta-campaign-writer -p hepta-control-plane \
  -p hepta-paper-service -p hepta-cutover
node --test paper-core/tests/rust-cutover-fence.test.mjs \
  paper-core/tests/sqlite-transaction-control-boundary.test.mjs \
  paper-core/tests/sqlite-store-failure-contract.test.mjs \
  paper-core/tests/typed-persistence-ports.test.mjs
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --example local_service_drill -- /absolute/new/service-drill
cargo run --manifest-path rust/Cargo.toml --locked -p hepta-cutover \
  --example local_cutover_drill -- /absolute/new/cutover-drill
```

The supplemental `rust-migration-acceptance` workflow records exact source and
runtime identities and retains logs/drill receipts. Existing foundation, supply
chain, architecture, documentation and qualification policies continue to apply.
Changes to a workflow update its declared producer file hashes; they do not
manufacture a successful run, external acceptance or `source_qualified` status.

The development container cannot exercise some original Unix-listener and
pre-exec gate tests: socket creation is denied and mounted `/proc` does not match
the child PID namespace. These failures must remain visible and be rerun on a
proper Linux host. They are not reasons to bypass containment checks or skip the
hosted tests. Production cgroup and credential tests still need the real target.

## Capability migration and completion criteria

| Scope | Current source result | Remaining acceptance |
|---|---|---|
| Native database reading and hash generation | Concrete native implementation and actual Node differential tests | Full historical/private corpus and deployed-runtime acceptance |
| Control and durable commit | Executable local/shadow composition with actual bytes and SQLite | Qualified production composition, live clock and host identity |
| Native artifact inventory and DB inspection | Small native workers in the service | Business capability-specific inputs, receipts and parity |
| Author/reviewer, empirical, formal/numerical, build/package, submission | Existing Node behavior remains the baseline; explicit process boundary supports gradual migration | Real Rust implementations and corresponding capability replay, scientific/external-effect authority |
| Broker provider execution | Concrete supervised dispatch API with mandatory authority callback | Real credential custody, deployment adapter, workspace/result integration and provider canaries |
| Single-writer control and recovery | Durable same-database local exercise and Node adapter fencing | Node-to-Rust data translation, reverse compatibility, host workloads and signed cutover |
| Node retirement | Not declared | Full capability equivalence, accepted shadow/canary, recovery/rollback and removal of every Node writer/entrypoint |

No percentage based on crate count, documentation count or passing fixture count
can establish full replacement. `CTL-001` and production activation remain open
until the complete production service and its independent evidence are accepted.
