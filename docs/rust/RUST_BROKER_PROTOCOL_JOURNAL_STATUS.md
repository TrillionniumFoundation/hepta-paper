# Rust Broker Protocol and Journal Slice status

Branch: `codex/rust-broker-protocol-journal-20260828`  
Stacked base: `codex/rust-broker-foundation-20260828`  
Authority introduced: **local admission reservation only**

## Source implemented

- `hepta-codex-broker-protocol` crate;
- fixed 56-byte bounded frame and exact payload SHA-256;
- JSON deny-unknown wire contracts;
- Linux `SO_PEERCRED` PID/UID/GID observation;
- exact peer UID/GID policy and policy hash;
- HMAC-SHA256 request capability bound to peer, broker instance and all request fields;
- short expiry and nonce validation;
- `hepta-codex-broker-journal` crate;
- private canonical database and WAL/SHM path checks;
- bundled-SQLite schema with immutable operation identity;
- unique operation/request/idempotency/nonce indexes;
- append-only transition rows and transition hashes;
- current-state/revision compare-and-swap;
- prepared-receipt and provider-action monotonicity;
- transaction rollback, replay and recovery tests;
- `hepta-codex-broker-local` admission-only service;
- successful and sanitized-error response frames;
- end-to-end Unix socket integration tests.

## Explicitly absent

- listener creation or stale-socket recovery;
- systemd socket activation;
- real Codex executable inspection or spawn;
- real Codex credentials;
- model/network qualification;
- campaign database access;
- workspace integration;
- release, KMS, WORM, backup or submission authority.

## Validation state

This is source implementation, not compile qualification. The repository's
Actions runner problem remains a hard dependency. Required evidence:

```text
Rust 1.98.0 exact identity
committed Cargo.lock
cargo metadata --locked
cargo fmt --check
cargo clippy -D warnings
cargo test --locked
rustdoc -D warnings
full existing repository CI
```

The newly pinned Git sources and bundled SQLite must appear in the reviewed
lockfile and provenance record.

## Open source-review blockers

1. Existing-database initialization must never adopt or mutate a foreign SQLite
   database before application ID, schema version and schema fingerprint are
   verified.
2. Symmetric capability key storage, rotation and guaranteed zeroization need a
   qualified implementation.
3. Runtime P0s for stable `CODEX_HOME` identity and schema authority separation
   remain blockers for real Codex.
4. Listener/socket path ownership, backlog, stale inode handling and shutdown
   semantics are intentionally deferred.
5. Fault injection must expand from transactional rollback to abrupt process
   termination at fsync/WAL/checkpoint boundaries.

## Next slice after qualification

```text
private UnixListener lifecycle
socket activation / exact inode ownership
stale-socket reconciliation journal
key-file or local signer principal
broker SQLite startup recovery and WAL crash matrix
request-bound runtime preflight
fake-codex spawn transition integration
```

Real Codex remains disabled until all inherited and new P0 gates are closed.
