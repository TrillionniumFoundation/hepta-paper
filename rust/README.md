# hepta-paper Rust control plane

This workspace is the additive, compatibility-first Rust replacement for the
first-party hepta-paper control plane. It is not yet a production writer.

The current stacked slices contain:

- `hepta-codex-protocol`: versioned request/receipt contracts and role policy;
- `hepta-codex-event-stream`: bounded `codex exec --json` decoder;
- `hepta-codex-journal`: deterministic external-operation state machine;
- `hepta-codex-runtime`: Unix runtime identity, environment isolation, bounded
  process groups, schema authority, and qualified invocation construction;
- `hepta-codex-broker`: bounded Unix-socket framing, peer credentials,
  signed/expiring request capabilities, exact role/runtime binding, and an
  isolated append-only SQLite operation journal with idempotency, nonce replay,
  schema-manifest and crash-rollback protection;
- `hepta-codex-testkit`: fault-injecting `fake-codex` process fixtures.

OpenClaw is deliberately outside the Rust target architecture. Existing Node
code remains the production compatibility oracle until capability-by-capability
cutover gates are met.

The broker-state slice introduces no real Codex credentials, live model calls,
campaign database writer, release authority, or submission authority. Its
SQLite database is broker-local operational state only.

`rust/Cargo.lock` is a required merge artifact; CI fails closed when it is
missing or stale.

## Local validation

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace --all-features --locked
cargo doc --manifest-path rust/Cargo.toml --workspace --all-features --locked --no-deps
```
