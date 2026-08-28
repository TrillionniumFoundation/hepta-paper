# hepta-paper Rust control plane

This workspace is the additive, compatibility-first Rust replacement for the
first-party hepta-paper control plane. It is not yet a production writer.

The first foundation slice contains:

- `hepta-codex-protocol`: versioned request/receipt contracts and role policy;
- `hepta-codex-event-stream`: bounded `codex exec --json` decoder;
- `hepta-codex-journal`: deterministic external-operation state machine;
- `hepta-codex-testkit`: fault-injecting `fake-codex` process fixtures.

OpenClaw is deliberately outside the Rust target architecture. Existing Node
code remains the production compatibility oracle until capability-by-capability
cutover gates are met. `rust/Cargo.lock` is a required merge artifact; CI fails
closed when it is missing or stale.

## Local validation

```bash
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace --all-features --locked
cargo doc --manifest-path rust/Cargo.toml --workspace --all-features --locked --no-deps
```
