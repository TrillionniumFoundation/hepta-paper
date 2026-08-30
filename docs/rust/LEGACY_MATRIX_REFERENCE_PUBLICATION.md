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

The release API records asset `536563599` as uploaded with digest
`sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d`
and size `22,506,525`. GitHub reports the release container itself as mutable,
so the digest must be recomputed on every download; the companion commit/tag,
LFS object ID, and retention policy provide the content-addressed binding rather
than an unsupported WORM claim.

## Verification procedure

Use a trusted, authenticated environment to download the private release. Do
not place the archive in the public `hepta-paper` tree or expose it to fork PR
jobs:

```sh
gh release download legacy-reference-v0.6.0-e431c4c7 \
  --repo TrillionniumFoundation/hepta-paper-legacy-reference \
  --pattern 'paper-factory-control-plane-reference.tar.gz' \
  --dir "$RUNNER_TEMP/legacy-reference"
gh release download legacy-reference-v0.6.0-e431c4c7 \
  --repo TrillionniumFoundation/hepta-paper-legacy-reference \
  --pattern 'PUBLICATION_MANIFEST.v1.json' \
  --dir "$RUNNER_TEMP/legacy-reference"

node /path/to/trusted-workflow/migration/bin/verify-legacy-matrix-reference-publication.mjs \
  --pointer /path/to/trusted-workflow/migration/fixtures/legacy-matrix-reference-publication-v1.json \
  --matrix /path/to/trusted-workflow/migration/legacy-semantic-migration-matrix.json \
  --archive "$RUNNER_TEMP/legacy-reference/paper-factory-control-plane-reference.tar.gz" \
  --companion-manifest "$RUNNER_TEMP/legacy-reference/PUBLICATION_MANIFEST.v1.json" \
  --extract-dir "$RUNNER_TEMP/legacy-matrix-reference-prepared" \
  --json
```

The verifier first checks the canonical archive and matrix digests, then audits
tar member types and extracts only the 263 matrix-listed regular files. It
recomputes every source hash and fails closed on missing, duplicate, unsafe,
symlink, or mismatched members. `--metadata-only` verifies the locator without
requiring private materialization.

After the archive gate, remove the archive and use the trusted replay helper to
run the exact candidate commands against the sealed extraction. The helper
performs the execution in a networkless namespace with an explicit minimal
environment; the following commands are only a diagnostic checklist, not a
replacement for the sandboxed hosted run:

```sh
test ! -e "$RUNNER_TEMP/hepta-legacy-reference/paper-factory-control-plane-reference.tar.gz"
test ! -e "$RUNNER_TEMP/hepta-legacy-reference/PUBLICATION_MANIFEST.v1.json"
node /path/to/trusted-workflow/migration/bin/run-legacy-matrix-reference-replay.mjs \
  --candidate-root /path/to/candidate \
  --prepared-root "$RUNNER_TEMP/legacy-matrix-reference-prepared" \
  --matrix /path/to/candidate/migration/legacy-semantic-migration-matrix.json \
  --expected-sha 37543c9e06113199bc2aa8a6a344203ece6c71e5 \
  --expected-tree c490cb85b33637f9882f640ab3718323fb47c7df \
  --expected-archive-sha256 sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d \
  --expected-matrix-sha256 sha256:59446f5e96cc5f086b27266f0fb0604d4f7f0e5bf1f62cb1a90933208a0f162a \
  --output "$RUNNER_TEMP/legacy-matrix-reference-evidence/replay.json" \
  --log-dir "$RUNNER_TEMP/legacy-matrix-reference-private-logs"
```

The checked-in policy
[`legacy-matrix-reference-verification-policy-v1.json`](../../migration/fixtures/legacy-matrix-reference-verification-policy-v1.json)
allowlists the reviewed post-Plan-v3 candidate snapshot (`37543c9e…` /
`c490cb85…`) and binds the archive, matrix and companion release identifiers.
The exact-head receipt contract is described by
[`legacy-matrix-reference-exact-head-receipt-v1.schema.json`](../../migration/fixtures/legacy-matrix-reference-exact-head-receipt-v1.schema.json).

The secret-bearing run is intentionally owned by the private companion
repository's administrator-controlled workflow. The public repository workflow
is only a guarded diagnostic fallback: it runs on protected `main` with
`HEPTA_LEGACY_REFERENCE_TRUSTED=1`, never on a pull-request or fork ref, and
the receipt writer rejects it as a trusted source. The
workflow installs the candidate lockfile before private materialization, verifies
the release API asset identity, extracts only the 263 allowlisted regular files,
destroys the archive and manifest, then runs the exact npm migration commands in
a bubblewrap namespace with no network, no candidate secrets, and read-only
candidate/reference/runtime mounts. It emits one receipt binding candidate and
workflow SHA/tree, policy digest, run/attempt, release/manifest/matrix digests,
tool and action pins, dependency-install hashes, replay commands/results and
artifact digest. Raw private replay logs are discarded after hashing.

A successful archive verification does not by itself promote Rust parity,
production, release, submission, or external-authority status; those plan gates
remain independent. Until an administrator completes a trusted hosted run and
retains the resulting receipt, issue #28 remains open and this publication is
classified as `published_locator_pending_hosted_replay`, not as a closed
external-authority gap.

## Custody boundary

The canonical tar is an opaque historical integrity object (22,506,525 bytes),
not a source bundle. It contains a historical SQLite database, Python bytecode,
and two absolute symlinks, so only the private companion/release is in scope.
The companion manifest records the source package commit, receipt digests, owner
boundary, and an indefinite-retention/no-rewrite policy. The local read-only and
Ed25519 receipts retain their original authority limit: build/archive integrity
only, not runtime, academic, reviewer, release, or submission authority.

The private companion closes local artifact availability and content provenance
for the exact `e431…` object. Hosted exact-head replay and independent owner
acceptance are still required to close the migration evidence gap. Nothing here
changes the Rust rewrite's broader compatibility or production status.
