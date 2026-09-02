# Migration policy

Status: normative

## Scope

This policy covers native SQLite schema migrations and the separate legacy semantic migration/retirement evidence under `migration/`.

## Native database migrations

Files in `store/migrations/` are ordered, append-only SQL migrations. Once a migration can have been applied outside a disposable fixture, its bytes, number, and meaning are immutable. Corrections add a new migration.

Each migration defines prerequisites, forward transformation, postconditions, indexes and constraints, expected scale, transaction behavior, backfill strategy, interruption recovery, and compatibility window. Store tooling records schema metadata and refuses application access when the required version is absent or inconsistent.

A migration change includes tests for a fresh database, upgrade from the previous supported schema, duplicate invocation, partial/interrupted state when applicable, logical-integrity verification, backup, and restore.

## Data backfill

Large or externally dependent backfills are separate resumable commands rather than unbounded schema-startup work. Backfill progress is fenced, idempotent, observable, and bound to source/target schema versions. Completion is verified from persisted state, not inferred from process exit alone.

## Legacy semantic migration

`migration/legacy-semantic-migration-matrix.json` is the only source of verified legacy semantic disposition claims. A similarly named adapter, path, report, or receipt is not evidence.

A behavioral replacement binds the exact legacy source hashes and symbols, exact current target hashes and symbols, and the hash of a local differential or behavior test. An explicit retirement records absence of parity; it must not be reported as migration success.

Capability implementation, local administrative acceptance, independent external-owner acceptance, source-bound conformance replay, and independent operational proof are separate axes. Current counts live only in `paper-core/docs/CURRENT_STATUS.md`.

## Compatibility and retirement

Compatibility code is read-only or narrowly bounded, explicitly classified, unreachable from new production graphs, and assigned a retirement condition. Legacy data and fixtures are immutable evidence. Production features are reimplemented against current domain contracts and ports rather than copied into a second control plane.

## Rollback

Schema rollback is restore-based unless a separately reviewed reversible migration exists. Destructive down-migrations are not assumed safe. Before irreversible change, operators create and verify a consistent backup and rehearse restore. A failed or ambiguous migration blocks startup until inspected; tooling must not mark it complete based only on a partially written marker.
