# Changelog

## 0.4.0 - 2026-07-10

- Replaced file-presence capability completion with executed, ledger-backed
  verification receipts that bind the test result and current target hashes;
  added a separate `operationally_proven` axis that remains false without
  production-bound receipts.
- Hardened the OS sandbox with read-only source mounts, isolated ephemeral
  work/output roots, no host `/etc` mount, and before/after source Merkle
  verification.
- Upgraded artifact storage to content-addressed immutable objects and
  manifests with atomic materialization, retention policy, garbage collection,
  and mandatory persistent receipt-ledger injection.
- Preserved Claim versions, added hash-bound transition receipts, and bound
  research gap plans to persistent idempotent jobs, leases, and attempts.
- Added full repair apply/rollback proof and submission restart, duplicate
  response, provider-receipt, dead-letter, and concurrent release-lock tests.
- Split batch service bootstrap, state projection, report writing, and local
  diagnostic round execution into dedicated application modules; paper-domain
  now hashes only through the workflow kernel.
- Ran a real-paper pilot for `A_Theory_of__Expectations`: the native source
  integrity worker passed and generated replayable receipts; the chain then
  correctly stopped at missing real academic evidence, independent referee,
  and dual live authorization. No provider executor or external action exists.

This release remains production `No-Go`: owner acceptance is 0/249,
`operationally_proven` is 0/161, and the real pilot lacks external authority
materials.

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
