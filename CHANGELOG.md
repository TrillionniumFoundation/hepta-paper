# Changelog

## 0.2.0 - 2026-07-10

- Added capability matrix v3 for all 249 explicitly retired legacy surfaces.
- Replaced conditional batch orchestration with an execution context,
  declarative mode registry, workflow engine, and stage receipts.
- Added Store and ArtifactRepository ports and migrated production SQLite
  calls to the SQLite adapter.
- Split research claim, evidence, experiment, gap planning, formal verifier,
  and change proposal capabilities into bounded contexts.
- Added submission delivery contracts for dispatch authorization, response
  intake, redrive, reconciliation, and release locking without adding a live
  executor.
- Renamed the deterministic review path to local diagnostic review loop; it no
  longer produces or implies academic acceptance.
- Moved 97 journal profiles to a versioned, schema-validated dataset.
- Added portable CI, architecture contract tests, coverage thresholds, and
  release verification commands.

This release remains production `No-Go`: runtime trust keys, real evidence,
independent review authority, dual live authorization, and an external provider
executor are absent.
