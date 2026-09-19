# Native workspace status and layout

Status: **implemented read-only workspace diagnostics; no deployment or
production authority**.

`workspace_status::resolve_workspace_layout_v1` ports the incumbent layout
contract without embedding `CARGO_MANIFEST_DIR` as a deployment root. The
caller supplies an explicit workspace root; the CLI accepts
`--workspace-root`, then `HEPTA_PAPER_WORKSPACE_ROOT`, then the process working
directory. Asset, runtime and legacy roots use explicit options, their
environment variables, and the incumbent sibling defaults.

All roots are first lexically resolved with Unix `path.resolve` semantics.
Physical comparison then walks directory components, follows at most 40
symlink hops, retains a missing suffix, rejects non-directory components and
returns the same `workspace_layout_path_resolution_failed:*` and
`workspace_layout_paths_overlap:*` blocker forms. No directory is created and
no file handle is retained. The status report performs the incumbent
realpath-or-lexical fallback and existence checks, including the native store
path, and `--require-decoupled` exits 2 when roots overlap.

## Evidence

`tests/workspace_status_parity.rs` compares root projections and decoupling
blockers against a Node oracle, exercises relative symlinks with a missing
suffix, 40/41-hop loops, all overlap pairs, read-only status, and a relocated
binary CLI invocation. It uses disposable `/tmp/hepta-workspace-status-*`
directories only.

Validation:

```text
rustup run 1.98.0 cargo fmt --manifest-path rust/Cargo.toml --all
rustup run 1.98.0 cargo clippy --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --all-features --all-targets --locked -- -D warnings
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --all-features --locked \
  --test workspace_status_parity -- --nocapture
```

Current focused result: **3 passed, 0 failed**.

## Boundary

The command is diagnostic only. It does not provision roots, mutate stores,
perform package graph checks, or authorize runtime activation. Full Node command
registry acceptance and target-host qualification remain separate work.
