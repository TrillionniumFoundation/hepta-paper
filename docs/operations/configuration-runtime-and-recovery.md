# Configuration, runtime, and recovery

Status: normative

## Scope

This guide defines configuration handling, execution profiles, filesystem separation, native store lifecycle, logging, backup, restore, and operational evidence. Command-specific procedures remain in [`../../paper-core/docs/OPERATIONS.md`](../../paper-core/docs/OPERATIONS.md).

## Configuration

Configuration enters only through documented CLI arguments, configuration files, environment variables, or injected authority services. Parsing produces validated typed values before composition creates adapters. Unknown options, duplicate options, malformed paths, unsupported modes, and capability/profile mismatch fail closed.

Precedence is: immutable command or release policy, explicit CLI option, explicitly approved configuration document, environment value, then a documented safe default. A lower-precedence source may not weaken a release, trust, sandbox, or external-action requirement.

Secrets are references to protected roots or external services, not values committed to source or printed in reports. Configuration reports redact credentials while preserving identity hashes and purpose.

## Execution profiles

Application profiles include handoff, handoff-export, inventory, automation, batch, submission, and bounded legacy compatibility. Each profile has an exact required service set and derived capability list. Composition must not inject optional write or external-action authority “for convenience.”

The default execution context forbids external action and legacy control-plane imports, requires declared-port writes, and withholds raw store access outside the legacy profile.

## Filesystem layout

Repository source, assets, mutable runtime/store state, and immutable retirement/reference data use disjoint real paths. Bootstrap repeats symlink-safe overlap checks. Runtime roots use restrictive permissions, owned staging directories, atomic publication, and no-follow access.

Temporary work is attempt-owned. Published packages, archives, CAS objects, prepared results, receipts, and deletion lanes have distinct lifecycle rules; generic temporary-file cleanup must not remove them.

## Native store

The production SQLite path and permissions are defined by deployment configuration. Store initialization applies ordered migrations in a transaction or documented recoverable sequence and records schema metadata. Application access requires a current schema-version receipt.

Ledger rows are append-only. Logical integrity verifies foreign identities, hashes, issuer policy, supersession, and current projections. Direct database repair outside the repair-ledger process is unsupported.

## Backup and restore

A valid backup binds database bytes, WAL/checkpoint state, schema version, code/release identity, time, storage object/version, retention lock where required, and a verification receipt. Copying a live database file without its consistency protocol is not a backup.

Restore occurs into an isolated path, verifies bytes and logical integrity, runs schema and authority checks, and proves the expected inventory before any production switch. Restore drills must be repeated; a backup with no verified restore is not release evidence.

Published-package deletion additionally requires exact immutable storage and independent restore attestation for the exact package inventory. Ambiguity leaves the package recovery-protected.

## Observability

Structured events include campaign, node, attempt, generation, operation, artifact, authority epoch, result class, duration, and blocker identifiers. Logs do not contain credentials, restricted dataset rows, manuscript secrets, or unbounded model/provider responses. Metrics distinguish waiting, contention, execution, verification, reconciliation, and operator intervention.

## Operational completion

A green local check establishes only the evidence named by that check. External owner/observer signatures, KMS/HSM identities, off-host replay, provider accounts, live canaries, resident supervision, cold storage, GPU hardware, and production qualification must come from their real authorities. Operators must leave missing evidence blocked rather than create nominal substitutes.
