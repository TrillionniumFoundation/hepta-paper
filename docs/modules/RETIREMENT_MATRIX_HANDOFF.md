# Native retirement capability matrix inspection

`hepta-paper-rust retirement-matrix` is the Rust read-only candidate for the
incumbent `npm run migration:capability-matrix-v3` route. It reads the version-2
legacy semantic migration matrix, rebuilds the same conservative permanent
retirement/superseded decision classes, binds each superseded row to the
registered capability target paths, checks source and target identities, and
imports the existing native owner-acceptance status report.

```bash
hepta-paper-rust retirement-matrix \
  --workspace-root ABSOLUTE_WORKSPACE_ROOT \
  --runtime-root ABSOLUTE_RUNTIME_ROOT
```

The command is bounded and read-only. It refuses relative roots, rejects
symlinked or oversized JSON/source files, never executes a legacy module, never
creates a conformance or operational receipt, and never writes the runtime
directory. A blocked result is emitted as JSON before the process exits with
status 1, so automation can retain the diagnostic without mistaking it for an
approval.

The report is intentionally named `LegacyCapabilityMigrationMatrixReadOnly` and
sets `authorityGranted`, `productionActivation`, and `nodeRetirement` to
`false`. `implementationVerified` and `operationallyProven` remain zero because
the native capability receipt replay, production-bound operational proofs,
external owner signature, exact legacy archive, and independent retirement
authority are not available to a local source inspection. `ownerAcceptance` is
the existing native summary; individual entries say
`imported_summary_only` rather than claiming per-row acceptance.

This closes the command-map entry's *unmapped* state to a
`partial_local_source` candidate. It does not claim full parity with the Node
release profile, which also runs capability verification, computes release
provenance, and requires external evidence. The corresponding Rust source is
`rust/crates/hepta-paper-service/src/retirement_matrix.rs`; the CLI is wired
through `hepta-paper-rust` and covered by
`rust/crates/hepta-paper-service/tests/retirement_matrix.rs`.

Verification:

```bash
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --test retirement_matrix --locked
```
