# Plan v3 repository-local source closure acceptance

A candidate is `source_qualified` only when one exact final Git tree satisfies
all requirements below in one transactional qualification run.

## Source graph

- all production and qualification crates are workspace members;
- the committed `Cargo.lock` resolves under Rust 1.98.0 with `--locked`;
- the Codex runtime exposes cgroup-v2 production containment and rejects
  process-group-only production eligibility;
- compatibility, read-only control, workspace authority, campaign writer,
  scientific evidence, external authority and cutover crates compile together;
- no Rust/OpenClaw runtime dependency exists.

## Required gates

```text
validate-program-truth.py
cargo fmt --all -- --check
cargo check --workspace --all-targets --all-features --locked
cargo test --workspace --all-features --locked
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
RUSTDOCFLAGS=-D warnings cargo doc --workspace --all-features --locked --no-deps
npm run static:check
npm run legacy:fixture-verify
npm run test:migration-differential
qualification JSON and shell-contract tests
```

The complete matrix is rerun after any rebase and before the exact final commit
is pushed. The final commit receives a `rust-plan-v3-finalize-v2` status and a
90-day evidence artifact binding its SHA, tree, toolchain, lockfile and logs.

## Truth boundary

Source closure grants none of the following:

```text
production activation
real Codex credential use
live provider calls
production campaign-writer cutover
independent target-host approval
external capability key ownership
release or KMS/HSM authority
WORM custody
portal mutation
paper submission
```

Those remain `blocked_external` until independently signed records conforming to
the packages under `docs/rust/qualification/` are verified and accepted.
