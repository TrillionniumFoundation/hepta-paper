# Native retirement drill-attest inspection

This handoff documents the Rust implementation of the locally reproducible
portion of `node paper-core/bin/legacy-deletion-drill.mjs --attest --execute`.
The command is intentionally an inspection boundary. It does not sign a
release receipt, delete a legacy tree, publish runtime evidence, or authorize
Node retirement.

## Input contract

`hepta-paper-rust retirement-drill-attest REQUEST` reads one bounded JSON file
matching `LegacyDeletionDrillAttestationRequest` (version 1). The request
contains absolute normalized paths for a schema-25 Node database and an
immutable reference archive, the repository/commit/tree subject, the release
commit, and a release-state snapshot hash. The release fields bind the
operator's intended subject only; this command cannot independently qualify a
release state or an external signer.

## Local checks

The native checker opens the Node database through the existing immutable
read-only store and runs the complete legacy freeze policy: schema migration
history, required tables and columns, terminal statuses, empty leases and
queues, and unchanged file identity. It captures archive bytes through one
opened file, compares device/inode/size/timestamps before and after the read,
rejects symlinks and hardlinks, checks the canonical parent, computes the
archive SHA-256, and records the `lsattr` immutable-bit observation.

The result carries the local freeze receipt hash and archive identity when
those checks pass. Its own report hash is domain separated and covers every
preceding field, so a caller can retain the blocked inspection as an input to
the external qualification workflow.

## Fail-closed boundary

The result is always
`legacy_reference_restore_drill_attestation_blocked` until independently
retained evidence is supplied for the Node p0/p1 differential replay, matrix
policy replay, release provenance and current release state, owner acceptance,
operational proof, release-key signature, and no-clobber receipt publication.
`physicalDeletionAllowed`, `signingKeyRead`, `runtimeEvidenceWritten`, and
`externalActionPerformed` remain false. A blocked report exits non-zero from the
CLI after printing its JSON report.

## Validation

`rust/crates/hepta-cutover/src/retirement_attest.rs` unit tests cover invalid
paths, unknown contract kinds, missing databases, and non-immutable archives.
`rust/crates/hepta-paper-service/tests/retirement_drill_attest.rs` builds a
real schema-25 database from the embedded Node migration SQL, verifies the
database is unchanged, rejects an archive hardlink, and executes the native
CLI to prove a blocked report is printed before a non-zero exit. Run:

```sh
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml -p hepta-cutover --lib
rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml -p hepta-paper-service --test retirement_drill_attest
```

## Open qualification work

The Rust report is not a compatibility claim for the Node command. The
incumbent runs actual Node migration tests in an isolated restored runtime,
captures release-state/provenance snapshots, signs with a separately managed
release key, and publishes a receipt under a no-clobber identity-bound
transaction. Those steps require the external replay archive, release signer,
owner and operational authorities, and independent acceptance. Until those
inputs are verified, this command remains a local blocked inspection and the
Node route must remain available.
