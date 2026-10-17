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
transaction. The report separates missing implementation from external
qualification. Restored-runtime replay, complete matrix/policy replay,
provenance composition, signing integration and publication/recovery remain
implementation work; a key or an account cannot substitute for those owners.
Independent owner/operational acceptance, release-key custody and physical
deletion authority require actual external evidence. The machine lists in
`hepta-cutover/src/retirement_attest.rs` remain the source for this classification.
The separate V3 release replay observer covers only its fixed minimal legacy
P0/P1 corpus, and is not composed into this V1 drill. Both ordinary commands
remain blocked until their actual requirements are satisfied.

## Receipt-bound reference inspection

`hepta-paper-rust retirement-reference ROOT` is a separate read-only V1 owner.
It retains the root/directory descriptors, rejects escaped names, symlinks,
hardlinks and nonregular members, and streams the selected original archives.
It reuses the duplicate-free JSON parser and the existing bounded process-group
owner for fixed `/usr/bin/lsattr`; ambient PATH cannot select that tool. SIGINT
and SIGTERM use the ordinary CLI cancellation adapter. Unknown process outcomes,
changed named/held metadata, expired operation time and exceeded read budgets
refuse without a verified report or a mutation.

Limits are declared in `hepta-paper-service/src/retirement_reference.rs`: 4 MiB
per receipt, 1 GiB per archive, 4 GiB total reads, 128 archive entries, 256
immutable entries and 120 seconds for the operation. The valid V1 report keeps
the Node field/exit-code contract. A reference verification result grants no
retirement, research, release or submission authority. The ordinary differential,
unsafe path/file/input, fixed-tool and actual open-archive cancellation cases are
in `tests/retirement_reference_parity.rs`; held-file replacement and bounded
stream cases are in `src/retirement_reference/files.rs`.
