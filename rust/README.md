# hepta-paper Rust control plane

This workspace is the additive, compatibility-preserving Rust replacement for
first-party `hepta-paper` control-plane authority. It is a release-candidate
source implementation, not a production writer. Real provider credentials and
all production authority remain forbidden until their independent gates close.

Canonical plan and truth:

- `docs/rust/current-status.v1.json` — committed static implementation truth;
- `docs/rust/CURRENT_STATUS.md` — human static projection;
- `docs/rust/RUST_REWRITE_MASTER_PLAN.md` — Plan v4;
- `docs/rust/RUST_REWRITE_BACKLOG.md` — implementation backlog;
- `docs/rust/RUST_PARITY_MATRIX.md` — stable parity rows;
- `docs/rust/QUALIFICATION_STATE_MACHINE.md` — promotion and demotion rules.

The exact-head workflow emits `effective-status.v1.json` only after the complete
required check matrix succeeds. Source files do not self-assert
`source_qualified`.

## Workspace crates

- `hepta-codex-protocol` — versioned request/receipt and digest contracts;
- `hepta-codex-event-stream` — bounded strict Codex JSONL decoder;
- `hepta-codex-journal` — deterministic external-operation state machine;
- `hepta-codex-runtime` — runtime identity, environment isolation, bounded
  process execution, schema authority and durable pre-exec gate;
- `hepta-codex-broker` — Unix framing/peer/capability admission, trust bundles,
  listener lifecycle, broker SQLite journal, recovery and prepared-result
  acknowledgement;
- `hepta-codex-testkit` — deterministic fault-injecting fake executor;
- `hepta-workspace-authority` — descriptor-bound COW inventory, mutation policy
  and prepared workspace results;
- `hepta-campaign-writer` — generation-fenced persistence and signed cutover;
- `hepta-compatibility` / `hepta-legacy-compatibility` — canonical and
  historical verification;
- `hepta-readonly-store` / `hepta-readonly-control` — immutable inspection;
- `hepta-scientific-evidence`, `hepta-external-authority`, `hepta-cutover` and
  `hepta-qualification-ingest` — non-activating evidence/cutover boundaries.

OpenClaw is excluded from the Rust source, manifest and runtime graph.

## Authority boundary

The current Rust source cannot and must not:

```text
load real Codex credentials
perform authenticated provider calls
write the production campaign database
activate the production Rust writer
sign or publish a release
access KMS/HSM/WORM write authority
hold portal credentials
submit a paper
```

Hosted CI evidence is not target-host or external-authority evidence.

## Local validation

The toolchain is pinned in `rust/rust-toolchain.toml` and the lockfile is
mandatory.

```bash
cargo metadata --manifest-path rust/Cargo.toml --locked --no-deps --format-version 1
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace --all-features --locked
RUSTDOCFLAGS=-Dwarnings cargo doc --manifest-path rust/Cargo.toml --workspace --all-features --locked --no-deps
python3 docs/rust/tools/validate-program-truth.py
python3 docs/rust/tools/test-plan-v4-qualification.py
```

`derive-effective-status.py` is not a local self-approval command. It requires a
complete exact-head GitHub check-run snapshot bound to the GitHub Actions app.

## Development rule

Every production-relevant change updates, or explicitly records no delta to:

```text
static status and backlog
parity state and dependencies
TCB and principal matrix
risk register
crash/recovery behavior
operator impact
external package contracts
required check contexts
qualification invalidation
```

Do not describe a source fixture, hosted runner or implementation-author review
as production qualification.
