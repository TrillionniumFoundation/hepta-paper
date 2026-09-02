# store

Status: normative module guide

## Purpose

`store` owns the ordered SQL migrations for the native hepta-paper SQLite state. Runtime database files do not belong in this directory or in Git.

## Responsibilities

`migrations/` evolves canonical paper state, runtime and receipt ledgers, evidence isolation, automation campaigns and operations, multiprocess leases, lineage, reviewer identity, resource admission, schema metadata, telemetry, and later native capabilities.

Store adapters apply these migrations and expose typed ports; SQL files do not become an application API.

## Dependencies

Migrations use SQLite features supported by the pinned operational environment. They may not call external commands, read repository-relative data, or depend on legacy databases. Application and domain code do not import SQL directly.

## Contracts

Migration numbers are monotonically increasing and unique. Applied migration bytes are immutable. Schema metadata records the applied version and consistency information. Constraints, indexes, foreign identities, append-only rows, fencing generations, and uniqueness are part of the persisted contract.

Application access requires a validated schema-version receipt produced after migration and logical-integrity checks.

## Failure and recovery

Migration execution is transactional where SQLite permits. Multi-step backfills use separately fenced, resumable commands. Interruption, duplicate invocation, partially present objects, schema drift, and unsupported version fail closed.

Rollback is restore-based unless a migration explicitly supplies a reviewed reversible path. Operators verify a consistent backup and restore drill before destructive change.

## Security

The database and its WAL/SHM files use a protected runtime root and restrictive OS permissions. Every principal with direct write access is part of the trusted computing base. Trusted ledger status cannot be obtained by direct row insertion or caller-supplied metadata; integrity checks and external attestations remain separate.

## Testing

Tests apply all migrations to a fresh database, upgrade representative previous schemas, rerun migration detection, inspect required indexes/constraints, exercise concurrency/fencing, run logical integrity, and verify backup/restore. Schema changes also run affected repository and system tests.

## Change rules

Never edit, reorder, delete, or reuse an applied migration. Add the next migration with rationale, scale/locking analysis, upgrade tests, backfill/recovery plan, documentation, and compatibility impact. Do not commit runtime SQLite files.
