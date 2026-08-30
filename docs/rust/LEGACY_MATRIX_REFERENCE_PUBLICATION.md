# Legacy 263-file matrix reference publication

Issue [#28](https://github.com/TrillionniumFoundation/hepta-paper/issues/28)
identified a missing historical input: `migration/fixtures/legacy-matrix-reference-v1.json`
binds the migration audit to an archive with SHA-256
`e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d` and 263
matrix source paths.

The exact object is now retained in the private companion repository
[`TrillionniumFoundation/hepta-paper-legacy-reference`](https://github.com/TrillionniumFoundation/hepta-paper-legacy-reference),
at commit `e275812d279007a87be536df6af3d5d6e9d84955` and tag
`legacy-reference-v0.6.0-e431c4c7-r1`. A release asset is also available at
[`legacy-reference-v0.6.0-e431c4c7`](https://github.com/TrillionniumFoundation/hepta-paper-legacy-reference/releases/tag/legacy-reference-v0.6.0-e431c4c7).
The repository-local locator is
[`migration/fixtures/legacy-matrix-reference-publication-v1.json`](../../migration/fixtures/legacy-matrix-reference-publication-v1.json).

## Verification procedure

Use a trusted, authenticated environment to download the private release. Do
not place the archive in the public `hepta-paper` tree or expose it to fork PR
jobs:

```sh
gh release download legacy-reference-v0.6.0-e431c4c7 \
  --repo TrillionniumFoundation/hepta-paper-legacy-reference \
  --pattern 'paper-factory-control-plane-reference.tar.gz' \
  --dir "$RUNNER_TEMP/legacy-reference"

node migration/bin/verify-legacy-matrix-reference-publication.mjs \
  --archive "$RUNNER_TEMP/legacy-reference/paper-factory-control-plane-reference.tar.gz"
```

The verifier first checks the canonical archive and matrix digests, then audits
tar member types and extracts only the 263 matrix-listed regular files. It
recomputes every source hash and fails closed on missing, duplicate, unsafe,
symlink, or mismatched members. `--metadata-only` verifies the locator without
requiring private materialization.

After the archive gate, run the matrix integrity and differential commands on
the same exact candidate commit:

```sh
HEPTA_LEGACY_REFERENCE_ARCHIVE="$RUNNER_TEMP/legacy-reference/paper-factory-control-plane-reference.tar.gz" \
  npm run migration:matrix-integrity
HEPTA_LEGACY_REFERENCE_ARCHIVE="$RUNNER_TEMP/legacy-reference/paper-factory-control-plane-reference.tar.gz" \
  npm run test:migration-differential
```

The manual workflow
`.github/workflows/legacy-matrix-reference-verification.yml` performs this
sequence with the `HEPTA_LEGACY_REFERENCE_READ_TOKEN` secret. It is deliberately
`workflow_dispatch`-only: an untrusted fork must never receive the private
companion credential. A successful archive verification does not by itself
promote Rust parity, production, release, submission, or external-authority
status; those plan gates remain independent.

## Custody boundary

The canonical tar is an opaque historical integrity object (22,506,525 bytes),
not a source bundle. It contains a historical SQLite database, Python bytecode,
and two absolute symlinks, so only the private companion/release is in scope.
The companion manifest records the source package commit, receipt digests, owner
boundary, and an indefinite-retention/no-rewrite policy. The local read-only and
Ed25519 receipts retain their original authority limit: build/archive integrity
only, not runtime, academic, reviewer, release, or submission authority.

This closes artifact availability/provenance for the exact `e431…` object. It
does not change the Rust rewrite's broader compatibility or production status.
