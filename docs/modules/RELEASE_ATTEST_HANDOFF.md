# Native release-attestation inspection

This handoff documents the Rust local inspection corresponding to
`node paper-core/bin/release-evidence.mjs --execute`. The native command is a
read-only preflight and remains blocked until the independent release contract
is supplied.

## Input and command

`hepta-paper-rust release-attest REQUEST` reads a bounded JSON request with a
`ReleaseAttestationRequest` envelope. It contains the existing schema-25
`LegacyDeletionDrillAttestationRequest`, a release-state consistency request,
and release trust-layer counts. The command validates the release subject,
evaluates the native release-state and trust gate implementations, and reuses
the native archive identity and legacy freeze inspection.

## Local boundary

The report includes the release-state result, trust-layer result, drill report,
deduplicated blockers, and a domain-separated report hash. It never reads a
signing key, writes runtime evidence, mutates or deletes a legacy database,
publishes a bundle, or grants release or Node-retirement authority.

## External blockers

The result is always `release_attestation_blocked` with
`releaseEvidenceReady=false`. Node p0/p1 differential and policy replays,
release provenance, independent owner and operational acceptance, release-key
signing, no-clobber publication, and physical deletion remain external
requirements. A blocked report is printed before the CLI exits non-zero.

## Validation

The focused Rust unit test verifies release-subject mismatch rejection, while
the reused drill-attest tests cover real schema-25 freeze, archive identity,
hardlink rejection, unchanged database bytes, and blocked CLI behavior. Compile
and test with:

```sh
rustup run 1.98.0 cargo check --manifest-path rust/Cargo.toml -p hepta-paper-service --all-targets --locked
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service release_attest -- --nocapture
```

This is a `partial_local_source` candidate only. The incumbent Node route
remains required for complete release-evidence qualification.
