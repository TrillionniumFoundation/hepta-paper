# Rust Broker Protocol and Journal validation record

Status: **not merge-qualified**  
Date: 2026-08-28

## Source-level checks represented by tests

```text
frame length checked before allocation
frame raw SHA-256 checked before JSON decode
unknown wire fields rejected
kernel peer UID/GID policy applied before request admission
capability binds exact request, peer and broker instance
expired/tampered capabilities rejected
operation/request/idempotency/nonce uniqueness
transition state and revision compare-and-swap
transaction rollback on injected SQL failure
prepared-result recovery without provider rerun
private canonical database path and symlink rejection
sanitized response/error frame round trip
```

## Evidence not yet available

No claim is made that the new crates compile or pass tests. GitHub Actions has
not assigned a runner to the inherited Rust workflows, and the exact dependency
lockfile has not been generated. The following remain mandatory:

```text
rustc 1.98.0 --verbose
cargo metadata --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
RUSTDOCFLAGS=-D warnings cargo doc --workspace --all-features --locked --no-deps
full existing repository CI
```

## Additional qualification required

- inspect and record the exact Rustix source/revision and bundled SQLite version;
- run malformed/truncated frame fuzzing;
- run capability subject differential/property tests;
- kill the broker at every reservation/transition/checkpoint boundary;
- verify WAL recovery after SIGKILL and host restart;
- test disk-full, read-only filesystem, corrupt WAL and stale sidecars;
- prove foreign databases are rejected before persistent mutation;
- qualify key custody and secret-memory treatment;
- demonstrate no socket peer receives internal error text;
- run all tests as the intended non-root broker UID.

## Authority statement

The source may create a local `reserved` operation in a broker-only test
database. It cannot spawn Codex, access credentials, write campaign state,
integrate workspaces, release artifacts or submit papers.
