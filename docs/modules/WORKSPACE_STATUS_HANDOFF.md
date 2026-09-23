# Native workspace status and layout

Status: **implemented read-only workspace diagnostics; no deployment or
production authority**.

`workspace_status::resolve_workspace_layout_v1` ports the incumbent layout
contract without embedding `CARGO_MANIFEST_DIR` into the library's caller
contract. The CLI accepts `--workspace-root`, then
`HEPTA_PAPER_WORKSPACE_ROOT`, then the compiled deployment root used by the
Node entrypoint. Asset, runtime and legacy roots use explicit options, their
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
blockers against a Node oracle for ordinary, missing-suffix, symlink-hop, and
overlap fixtures. It also checks the 40-hop boundary, read-only status, the
Node compiled-root default, and a relocated native binary CLI invocation. The
CLI relocation and `--require-decoupled` behavior are native assertions
because the incumbent Node command has no equivalent root override. It uses disposable
`/tmp/hepta-workspace-status-*` directories only.

Validation:

```text
rustup run 1.98.0 cargo fmt --manifest-path rust/Cargo.toml --all
rustup run 1.98.0 cargo clippy --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --all-features --all-targets --locked -- -D warnings
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --all-features --locked \
  --test workspace_status_parity -- --nocapture
```

Current focused result: **4 passed, 0 failed**.

## Boundary

The command is diagnostic only. It does not provision roots, mutate stores, or
authorize runtime activation. Rust accepts UTF-8 paths and environment values;
non-UTF-8 Unix path bytes are outside this JSON command contract and are not
claimed as Node parity. Independent command acceptance remains separate work.
