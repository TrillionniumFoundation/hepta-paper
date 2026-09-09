# Rust Broker Foundation source audit

Date: 2026-08-28  
Base: `codex/rust-foundation-20260828@7c0ee455429c43cd0e453e1177343635110c0cf4`  
Branch: `codex/rust-broker-foundation-20260828`

## Implemented source

The stacked branch now contains an additive `hepta-codex-runtime` crate with:

- canonical executable path, owner, mode, inode, link, size and content identity;
- private `CODEX_HOME`, exact `config.toml`, and metadata-only credential identity;
- versioned parent/model-child environment allowlists and secret-pattern rejection;
- bounded stdin, stdout, stderr, tails, wall time, termination grace and cleanup;
- a new Unix process group, TERM-to-KILL escalation and descendant cleanup check;
- hard upper bounds that callers cannot raise;
- pre-spawn rejection of symlink paths, set-ID/mutable executables and NUL args;
- preflight/postflight runtime identity comparison;
- exact source-reviewed `codex exec` argv/config construction;
- output-schema/final-message inode, permission and hash contracts;
- negative fixtures for path, permission, environment, output and process failures.

This source has no campaign database writer, provider credential serialization,
release authority, KMS/WORM/backup authority, portal credential, submission
permit, or production composition path.

## Available static validation

The working source was checked with:

```text
TOML parsing
module-path existence
Rust lexical/string/comment scan
balanced delimiter scan
OpenClaw source/manifest exclusion
absolute system kill syntax/metadata smoke inspection
official openai/codex source review
```

The current upstream source baseline used for the CLI review is:

```text
openai/codex@6be2a6ca952ac9f70676ce4dd07fda27175aa9dd
```

Static source review does not establish Rust type correctness, formatting,
Clippy cleanliness, runtime behavior, installed Codex identity, authentication,
or provider protocol compatibility.

## P0 merge blockers

### 1. No executed Rust CI

GitHub Actions continues to fail before runner assignment. Jobs report no
runner and no executed steps. Rust 1.98.0 compilation, formatting, Clippy, tests,
rustdoc and `Cargo.lock` generation remain unproven.

### 2. Volatile Codex-home directory metadata

The current aggregate home identity still includes directory metadata that a
normal Codex execution may change when creating cache/session entries. Before
real qualification, directory identity must bind stable object/permission fields
while exact config and known credential contracts remain independently checked.
Otherwise legitimate cache activity may produce a false postflight drift.

### 3. Schema authority separation

The current schema check requires an owner-read-only private file and postflight
hash/inode equality. That does not stop the same Unix owner from temporarily
changing permissions, modifying the schema, and restoring it. Real Codex remains
blocked until the schema is owned by a separate authority or passed through an
OS-enforced sealed descriptor.

### 4. Installed binary qualification

The exact flags and configuration keys exist in reviewed upstream source, but no
installed executable has been content-pinned and tested for version/help/config,
JSONL events, authentication, sandbox, cancellation, or cost/usage behavior.

## Required evidence before merge or credentials

```text
Rust 1.98.0 toolchain identity
committed Cargo.lock and cargo metadata --locked
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
RUSTDOCFLAGS=-D warnings cargo doc --workspace --all-features --locked --no-deps
full existing repository CI
stable-directory identity correction and tests
privileged schema-authority separation test
exact Codex binary qualification receipt
credential leakage and process-tree attack suite
```

## Safe next slice

While those blockers remain, development may continue only with local fake
executables and isolated state:

1. Unix-socket frame parser and peer-credential contract;
2. signed expiring request capability verification;
3. broker-owned SQLite operation journal and idempotency index;
4. simultaneous stdout/stderr and inherited-pipe fault fixtures;
5. replacement-race and crash-injection fixtures.

No real `codex exec`, login status, provider credential, campaign write, release,
or submission operation is authorized by this branch.
