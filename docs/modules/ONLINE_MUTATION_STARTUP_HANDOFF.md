# Native online mutation startup reconciliation

This is the native implementation of
`paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs`.
It recovers committed local markers and resolves proven remote-only reservations.
It does not execute business DML or activate a runtime.

## API and ownership

Source: `rust/crates/hepta-paper-service/src/sqlite_mutation_coordinator/startup.rs`.

`reconcile_online_mutation_database_startup_v1(&mut Connection, role, instance,
&mut PinnedMutationAuthorityV1, &manifest, &mut dyn MutationClockV1)` returns an
opaque `StartupMutationReconciliationV1`. Callers may inspect its `value()` and
`authority_configuration_hash()`, but cannot construct it from JSON or booleans.
`assert_confirmation_current(&authority, now_millis)` rechecks the retained signed
confirmation against the same pinned authority. It does not re-observe the database.

The caller owns an existing database connection and its filesystem authority.
The activation database layer separately pins file descriptors and path identities;
this startup API is not a path opener. The mutable borrow prevents a caller from
reusing or replacing that same connection during the call. Test transport callbacks
return untrusted JSON; the pinned client verifies actual Ed25519 signatures and
current configuration/public-key files before an opaque receipt is created.

## Actual recovery sequence

1. Validate the complete manifest, exact role/instance and current database
   metadata/schema/scope binding before the first external request.
2. Generate an independent UUID nonce and obtain an authenticated unresolved list.
   Recheck freshness using a new clock reading after the response arrives.
3. Bind each signed reservation to its actual writer implementation and operation.
   A matching committed marker is pending recovery, never remote-only.
4. Validate local pending JSON and signatures, then finalize committed markers.
   Business SQL is never executed again.
5. For a remote-only reservation, acquire an IMMEDIATE transaction; re-read marker
   absence, integrity/foreign-key checks, metadata, exact schema and previous local
   head. Only then request a signed abort with reason `local-commit-failed`.
6. Obtain another independently nonce-bound signed list. It must have zero unresolved
   entries, remain fresh after the call and still match the database role/instance.
   The local journal must also have zero pending finalizations.

Every successful projection retains `businessDmlReplayed: false`,
`runtimeReady: false`, and the requirements for finalized-head reconciliation and
an active startup challenge. The retained confirmation can expire; an earlier
success is not permanent readiness.

## Transaction and adversarial boundaries

The general recovery function was strengthened along with startup. Pending rows
and metadata are read under one bounded snapshot. For each finalization, recovery
holds an IMMEDIATE transaction, rechecks the exact current metadata/schema/marker,
then retains that lock across external finalization and the local receipt write.
It commits only that journal update. Failure or Rust unwinding rolls back local
work through the transaction guard. An externally finalized result whose local
write fails remains recoverable; recovery never issues an abort for it.

Same-reservation/same-receipt local insertion remains idempotent. A different
receipt hash is a conflict. A successful abort followed by lost confirmation also
remains an error until a later fresh reconciliation verifies completion.

Persisted JSON rejects duplicate members and malformed UTF-8. Pending journal
materialization is limited to 4,096 rows, 32 MiB per text cell and 64 MiB aggregate
text, including non-JSON columns. Bounds are checked under the same SQLite read
snapshot. Metadata has narrower limits. Oversized valid data requires operator
review rather than an unbounded allocation or guessed recovery.

The clock is checked for valid instants and monotonic observations within startup.
Wrong role/instance is rejected even when the signed unresolved list would be empty.
These checks, post-response freshness, duplicate-key rejection and resource bounds
are deliberate stricter native behavior; incumbent incidental exceptions or
acceptance of these attacks are not reproduced.

## Verification and remaining integration

`tests/online_mutation_startup_parity.rs` invokes the pinned Node 22.23.1 incumbent
through `rust/oracle/online-mutation-startup-v1.mjs`. Ten genuine signed scenarios
compare the full requests, output/receipt hashes, database counters and errors:
empty, remote-only, committed, finalization failure, abort failure, unresolved
confirmation, unknown operation, wrong signature, marker conflict and wrong head.
The fixture captures a real SQLite Session changeset, and both sides verify real
Ed25519 signatures with temporary synthetic keys.

Additional tests cover duplicate JSON, oversized journal inputs, invalid configuration,
wrong database identity before external calls, expiry during either list request,
clock rollback, retained-proof expiry, and direct recovery without startup.
A real second SQLite connection attempts schema and business writes during the
finalization RPC: both are blocked. The same test injects transport unwinding and
checks rollback and lock release. Five startup tests and the six existing coordinator
regressions pass before the final shared workspace gate.

```bash
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test online_mutation_startup_parity --test sqlite_mutation_coordinator_parity --locked
```

Live inventory discovery, finalized-head evidence, active source/authority refresh,
restore-source/epoch ownership, schema-transition qualification, and the final
activation constructor must be connected through their verified native APIs.
This component and its synthetic tests do not supply external production authority.
