# Native architecture conformance checker

Status: **implemented read-only static boundary inspection; no production or
Node-retirement authority**.

`hepta-paper-rust verify-architecture ROOT [--json] [--strict]` reads the
checked-in `paper-core/src/architecture-entrypoint-manifest.mjs` as data. It
does not evaluate JavaScript or start Node. The checker resolves the same
bounded local candidates used by the incumbent reachability inspection
(`specifier`, `specifier.mjs`, and `specifier/index.mjs`), follows relative
`import`, `export … from`, and literal dynamic `import()` edges, and reports
missing, escaped, unreadable, or unresolved modules.

The report also checks the retired direct-workflow paths, the production graph
reference boundary, domain filesystem/clock restrictions, compatibility
manifest paths and forbidden production reachability, and the research versus
submission-dispatcher network boundary. The result is a diagnostic projection:
`ready=true` means these local source checks passed. It does not mean the Node
test suite has run, independent command acceptance has occurred, production has
been activated, or the Node implementation can be retired.

## Evidence

The native tests in
`rust/crates/hepta-paper-service/tests/architecture_conformance.rs` execute
the current repository checker and assert every declared manifest category has
an import graph, no current source blocker is hidden, and the explicit
diagnostic contract retains `executesNode=false`. Unit tests cover comment,
template, static, export, and dynamic-import scanning.

Validation from the repository root:

```text
rustup run 1.98.0 cargo fmt --manifest-path rust/Cargo.toml --all -- --check
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --test architecture_conformance -- --nocapture
node --test --test-concurrency=1 paper-core/tests/architecture-conformance.test.mjs
```

The Node test remains the incumbent behavior source. Native static checks are
deliberately recorded as a partial local source candidate until the complete
Node runtime assertions, argument/error matrix, and independent acceptance are
qualified.

## Boundary and remaining work

The checker is read-only and never writes package files, stores, receipts,
credentials, or authority evidence. It does not prove runtime behavior of the
artifact repository, SQLite adapter, formal verifier, submission delivery
contracts, provider sandbox, campaign orchestration, complexity budgets, or
external host/key/reviewer qualification covered by the incumbent test. Those
runtime and independent acceptance surfaces remain open in the migration gap
ledger.
