# Changelog

## 0.3.0 - 2026-07-10

- Split capability state into decision, contract, implementation and owner
  acceptance axes; added independent conformance suites for all 14 capability
  families.
- Moved batch stage handlers and the local diagnostic review loop into
  application use cases and made ExecutionContext the dependency boundary.
- Added the persistent receipt/job ledger, idempotent lease/attempt/failure
  jobs, persistent submission delivery state, release locks and schema v2.
- Added byte/hash/provenance evidence verification, ClaimGraph invariants,
  experiment aggregates, Lake certificate/replay verification and a real
  fail-closed OS sandbox backend.
- Replaced paper-runtime dependence on the full vendored core with a small
  workflow kernel; the vendored core remains a hash-bound reference fork.
- Physically separated the hepta repository, paper assets, native runtime/store
  and frozen legacy archive, and removed runtime scanning of the legacy worker
  catalog.
- Recorded all seven retirement waves plus freeze, quarantine and active
  control-plane removal receipts. Legacy source was not destructively deleted.

This release remains production `No-Go`: owner acceptance is 0/249, real trust
and evidence material are absent, and no provider executor is implemented.

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
