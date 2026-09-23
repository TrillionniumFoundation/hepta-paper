# Legacy Node drain, immutable archive, and forward-only Rust cutover

## Purpose

This document defines the executable boundary between the historical Node.js
campaign database and the authoritative Rust campaign writer. It supplements
`NODE_RUST_MIGRATION.md`, the cutover-controller module specification, and the
Rust production service contract.

The replacement does **not** create a second writer and does not pretend that the
schema-25 Node database and the Rust campaign-writer database are the same data
model. The safe transition is:

1. stop new legacy admissions;
2. drain all active Node work, leases, claims, waits, release locks, and pending
   submission consumption;
3. inspect the closed schema-25 database through the immutable Rust reader;
4. retain that exact database as a read-only historical archive;
5. bind the drain receipt to the exact repository commit and tree;
6. obtain independent external qualification, Node-free deployment, and writer
   cutover authorization for the same subject;
7. start the unique Rust writer;
8. after the first authoritative Rust commit, recover forward rather than
   restoring a stale Node image over committed Rust state.

## Executable implementation

The normative implementation is
`rust/crates/hepta-cutover/src/retirement.rs`.

`verify_legacy_node_freeze_v1` opens the database through
`hepta-readonly-store`, requires the complete production migration ledger at
schema version 25, and creates a typed logical snapshot. It never opens the
legacy database for writing, checkpoints it, changes journal mode, or creates a
sidecar.

The verifier fails closed unless all critical runtime surfaces are drained:

- every paper campaign is terminal;
- every campaign node and job is terminal;
- every job attempt has a closed recovery disposition;
- every prepared result is integrated or explicitly absent;
- submission outbox work is responded, superseded, or dead-lettered;
- release locks are released and carry a release timestamp;
- submission responses are consumed or rejected;
- resource leases and waiters are empty;
- all known job, node, outbox, and response-consumption lease/claim columns are
  empty.

Missing tables, missing columns, an unsupported schema version, duplicate table
identities, malformed source identities, active rows, or an unreadable immutable
snapshot all reject the freeze.

## Receipt binding

A successful `LegacyNodeFreezeReceiptV1` binds:

```text
repository
exact commit
aexact tree
exact database byte hash
complete typed logical database hash
schema version 25
closed quiescence policy hash
per-table row and active-row observations
rollback mode
immutable archive requirement
canonical receipt hash
```

The production Rust service receives an opaque
`VerifiedLegacyNodeFreezeV1`; it cannot deserialize one from arbitrary JSON.
`run_production_service_v1` requires the freeze subject to match the external
qualification closure, writer-cutover permit, and Node-free deployment subject
before opening or acquiring the Rust campaign writer. Its production receipt
includes the freeze receipt hash.

The bounded operator command is:

```text
hepta-paper-rust verify-legacy-freeze \
  IMMUTABLE_DB REPOSITORY COMMIT TREE
```

The command emits the canonical receipt only after a real immutable database
inspection. A copied prose assertion, source boolean, or administrator approval
cannot create the opaque value required by the in-process production API.

## Rollback boundary

The only accepted mode is
`pre_activation_only_then_forward_recovery`.

Before the first authoritative Rust commit, an independently authorized
cutover may abandon the candidate and restore the old writer against the exact
preimage. After the first Rust commit, rollback must not replace current Rust
state with the historical Node database. Recovery preserves Rust commits and
continues forward, or uses a separately designed and independently qualified
reverse migration that explicitly accounts for every post-cutover effect.

This rule prevents a nominal rollback from silently losing completed work,
resource settlement, release state, or external-effect reconciliation.

## Historical access

The schema-25 database remains an immutable audit archive. Approved Rust
compatibility readers and verifiers may inspect it after retirement. Retention of
that read-only archive does not retain Node execution authority, credentials,
services, timers, sockets, queues, or writer leases.

## Production prerequisites

The drain receipt closes a repository-local source gap; it does not establish
facts owned by external systems. Production activation still requires accepted,
current evidence for:

- protected-main governance and independent review;
- target-host principals, services, listeners, cgroup containment, and reboot
  behavior;
- destructive storage and corruption testing plus the required production-topology
  soak;
- independent capability-key custody and compromise recovery;
- real Codex credential custody and separated role canaries;
- KMS/HSM, WORM, release, portal, and submission authority;
- the private full legacy replay archive.

All packages must bind the same exact source, binary, configuration, host,
service, database preimage, deployment, and writer generation. No hosted fixture
or implementation-author self-attestation may substitute for these facts.

## Acceptance tests

Repository-local acceptance includes:

- a fully quiescent typed snapshot produces a deterministic receipt;
- an active job blocks the freeze;
- a missing critical table blocks the freeze;
- the production service cannot run without the opaque freeze result;
- repository, commit, or tree mismatch rejects before writer acquisition;
- the production receipt commits the freeze receipt hash;
- formatter, Clippy, workspace tests, rustdoc, migration acceptance, exact-head
  qualification, supply-chain, and documentation validation succeed on the
  unchanged final head.
