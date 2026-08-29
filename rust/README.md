# hepta-paper Rust control plane

This workspace is the additive, compatibility-preserving Rust replacement for
first-party hepta-paper control-plane authority. It is currently a **broker
source candidate**. It is not a production writer and real provider credentials
remain forbidden.

Canonical status and plan:

- [`docs/rust/CURRENT_STATUS.md`](../docs/rust/CURRENT_STATUS.md)
- [`docs/rust/current-status.v1.json`](../docs/rust/current-status.v1.json)
- [`docs/rust/RUST_REWRITE_MASTER_PLAN.md`](../docs/rust/RUST_REWRITE_MASTER_PLAN.md)
- [`docs/rust/RUST_REWRITE_BACKLOG.md`](../docs/rust/RUST_REWRITE_BACKLOG.md)

## Workspace crates

- `hepta-codex-protocol` — versioned request/receipt and digest contracts;
- `hepta-codex-event-stream` — bounded strict Codex JSONL decoder;
- `hepta-codex-journal` — deterministic external-operation state machine;
- `hepta-codex-runtime` — runtime identity, environment isolation, bounded
  process execution, schema authority and durable pre-exec gate;
- `hepta-codex-broker` — Unix framing/peer/capability admission, trust bundles,
  listener lifecycle, broker-owned SQLite journal, recovery and prepared-result
  acknowledgement;
- `hepta-codex-testkit` — deterministic fault-injecting fake executor.

OpenClaw is excluded from the Rust source, manifest and runtime graph.

## Authority boundary

The current Rust source cannot and must not:

```text
load real Codex credentials
perform authenticated provider calls
write the campaign database
sign or publish a release
access KMS/HSM/WORM
hold portal credentials
submit a paper
```

Hosted CI evidence is not target-host or external-authority evidence.

## Local validation

The exact toolchain is pinned in `rust/rust-toolchain.toml` and the lockfile is
mandatory.

```bash
cargo metadata --manifest-path rust/Cargo.toml --locked --no-deps --format-version 1
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace --all-features --locked
RUSTDOCFLAGS=-Dwarnings cargo doc --manifest-path rust/Cargo.toml --workspace --all-features --locked --no-deps
python3 docs/rust/tools/validate-program-truth.py
```

## Development rule

Every source change updates the backlog/gap it implements, its failure and
recovery behavior, its authority/non-authority statement, and exact-head
evidence. Do not describe a source or hosted fixture as production
qualification.
