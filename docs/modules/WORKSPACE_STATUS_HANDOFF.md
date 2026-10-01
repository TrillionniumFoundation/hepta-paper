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

Execution results belong to the current source-evidence receipt; this contract
does not carry a reusable test count.

## Boundary

The command is diagnostic only. It does not provision roots, mutate stores, or
authorize runtime activation. Rust accepts UTF-8 paths and environment values;
non-UTF-8 Unix path bytes are outside this JSON command contract and are not
claimed as Node parity. The normal adapter is `hepta-paper-rust operator workspace [-- FLAGS]`.
It accepts the registered boolean grammar before layout I/O; flat native root
overrides do not expand that ordinary route. Complete current-subject command
acceptance comes from the independent consumer described in the
[migration ledger contract](../migration/NODE_RUST_MIGRATION.md).

## Ordinary store inspection

The adjacent ordinary route is `hepta-paper-rust operator store [-- FLAGS]`.
Its two Boolean options are `--allow-isolated-verification-evidence` and
`--require-trust-clean`; duplicates, inline values, unknown options and stray
separators refuse before store access. The explicit native extension is
`store-status [IMMUTABLE_DB [RUNTIME_ROOT]]` with the same options. A successful
inspection exits 2 when trust-clean is required and the actual report is blocked.
Inspection does not repair a database or authorize a submission.

`store_status.rs` owns the complete report. Its `cli`, `sql`, `handoff`, `date`
and `timezone` modules respectively own argument/layout selection, actual SQLite
values, submission-handoff boundaries, incumbent finite-date parsing and local
timezone rules. The SQL reader opens the main database read-only, sets
`query_only`, uses memory temporary storage and a ten-second busy timeout.
Missing required schema is an actual SQL refusal, rather than an invented zero
count. Main-store aliases retain incumbent observation semantics; the handoff
reader separately checks its fixed runtime containment, regular single-link
database, permissions, schema and observed identity.

Read-only SQLite may create or coordinate WAL shared-memory files. Ordinary
route acceptance therefore retains actual namespace and file observations,
ownership/mode/link/size, complete WAL/SHM geometry and content, both execution
orders, cancellation and a fresh retry. The consumer admits only the declared
coordination changes and rejects a blanket unchanged-side-effects claim. It
validates the complete bounded record against the shared strict schema before
replaying the actual Node and Rust commands. A supplied report or self-hash does
not accept a route.

Executable verification uses the existing source owners:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --test store_status_parity
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --lib store_status::date::tests::finite_schema_dates_match_the_actual_qualified_node_parser \
  -- --exact
node --test paper-core/tests/node-rust-route-acceptance.test.mjs
```

The date test compares actual qualified Node parsing in separate processes with
the default host timezone and its declared timezone cases. The ordinary suite
also exercises SQL value types, malformed schema, handoff file boundaries,
argument refusals and interrupted WAL coordination. Results bind the current
commit and selected tool bytes; this document stores no reusable passing count.
