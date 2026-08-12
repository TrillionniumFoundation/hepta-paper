# Repository asset externalization

`paper-core/config/repository-asset-externalization.v1.json` records the two
large repository boundaries that must move without weakening reproducibility:

- the R source closure moves to an immutable OCI artifact or content-addressed
  artifact registry;
- `core/` moves to a signed release artifact or read-only, commit-pinned
  submodule after its differential fixture remains independently verifiable.

`npm run hepta-paper -- verify repository-assets` verifies the current local identity bytes
and reports migration blockers without claiming that an external registry
exists. `--require-externalized` fails until every entry has a digest-pinned
external reference and a hash-bound restore-drill receipt.

Tracked bytes must not be deleted merely to reduce checkout size. The safe
sequence is upload, verify the immutable digest, perform a clean restore drill,
record the reference, switch builders/readers, then delete tracked payloads in
a dedicated migration. Until those external facts exist, the manifest remains
explicitly pending and release behavior stays fail-closed.
