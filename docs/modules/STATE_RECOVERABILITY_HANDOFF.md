# State recoverability service and epoch controller

## Status and original sources

This native library slice connects actual SQLite state, pinned external authority signatures, stored backup evidence, isolated restore execution, resident leases, and the recoverability epoch state machine. It is a **partial command route**, not a claim that the autonomous-state-backup CLI, complete autonomous activation assembly, offhost deployment, or independent operational acceptance is complete. No production authority, live portal, credentials, or production runtime was used by its tests.

Original behavior is taken from:

- `paper-application/automation/autonomous-research-state-recoverability-controller.mjs`
- `paper-application/automation/autonomous-research-state-reconcile-and-renew.mjs`
- `paper-adapters/automation/autonomous-research-state-backup-repository.mjs`
- `paper-adapters/automation/autonomous-research-state-backup-journal-replay.mjs`
- `paper-adapters/automation/autonomous-research-state-backup-source-operations.mjs`
- `paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs`
- `paper-adapters/persistence/sqlite-consistent-copy.mjs`

The Node oracle is fixed to Node 22.23.1, ICU 78.2, CLDR 48, en-US production collation. Native production code does not invoke Node.

## API and ownership

`state_recoverability::service::BackupRecoveryServiceV1<B, O>` owns independently pinned backup and online mutation clients. Its options contain the actual runtime root, backup root, state database manifest, and writer manifest. Construction validates both manifests and requires the backup configuration's pinned online verifier configuration hash to equal the actual online client's configuration hash. Matching public labels alone are insufficient.

Public methods are `backup`, `restore_drill`, `recover_backup`, `inspect_sources`, `reconcile_pending`, and `reconcile_and_renew`. They return real execution results or typed coordinator errors. A JSON status supplied by a caller cannot construct their internal verified source/inventory evidence.

`ResidentLeaseV1::new` accepts an identity claim. Only `assert_current` obtains an `ObservedResidentLeaseV1`, by reading the actual resident SQLite row, validating its complete persisted state, and binding its file observation. `LiveBackupHeadObservationV1` proves a fresh signed head for a verified stored source. Neither type alone is an epoch.

`StateRecoverabilityControllerV1` owns this concrete service, resident lease claim, and clock. It starts dirty with no verified head; there is deliberately no caller-supplied initial verified head. Its methods are `reconcile_with_validity`, `assert_for_action`, `mark_finalized`, `require_reconciliation`, `epoch_status`, and `policy`. The epoch permit has private fields and a read-only value projection. The controller implements the coordinator's `RecoverabilityEpochFenceV1`; production composition must use this real implementation rather than an arbitrary successful test fence.

The internal `sqlite_mutation_coordinator::backup_replay` bridge accepts an already verified finalized-journal range and pinned online verifier. It does not publish generic system-table write helpers. The live activation database's dedicated `startup` child performs only startup reconciliation; read-only pending counts use the inventory's private snapshot API.

## Actual data and authority chain

A backup obtains opaque actual inventory, reserves it through the backup authority, checks every local signed finalized head or pinned genesis metadata against that reservation, and observes inventory stability again. Native SQLite backup copies are made from the inventory's held-file private DB/WAL snapshots. The original database, WAL, and SHM are never passed to a backup/inspection callback. Copies undergo schema, quick-check, foreign-key, byte-length, and hash validation. The real signed finalization binds the exact resulting content hash before no-replace publication.

A restore drill verifies the historical reservation/finalization, current signed head, exact bundle/database set, and snapshot hashes. Stored immutable files are read from held descriptors into private copies before SQLite opens them. An advanced head requires a genuinely signed range for the same reservation, scope, snapshot, online authority, and writer manifest, with every nested online reservation/finalization verified and causally continuous. SQLite Session changesets are applied only to private copies. Each entry's business changeset, immutable system-row comparison, marker, finalization record, integrity checks, and resulting verified head share one IMMEDIATE transaction. Changeset conflicts and system-table modifications abort.

Pending reconciliation first observes an exact ten-role inventory and trust/manifest binding, then runs actual signed startup recovery on restricted live handles. It obtains a fresh complete inventory after these authorized writes and verifies stable scope. Final pending counts are read only from fresh private snapshots. These operations may repair the original system journal; business DML is not replayed during pending reconciliation. The combined renewal receipt explicitly reports `businessDmlReplayed:false`; the backup/drill receipts separately report their own `productionStateMutated:false`.

The controller gates initial, current, dirty, reconciliation-required, fresh-snapshot renewal, journal renewal, transient deferred, and sticky fatal states. Finalized-head notifications can dirty an epoch and cannot create one. Readiness requires an actual source/inventory, fresh pinned signed observation, actual valid resident lease, causal head coverage, and no unresolved requirements. Authority rollback, equivocation, invalid signatures, and contradictory finalized heads fail. Required validity, exclusive expiry, maximum observation age, and monotonic clock checks apply. After all file/SQLite/signature checks, a final clock sample is checked against immutable observation and resident validity before returning readiness or an epoch permit.

## Files, concurrent publication, and interruption recovery

Runtime trust, receipts, and database files are opened through no-follow component walks and checked for regular-file ownership, permissions, link count, identity, size, and modification metadata. Stored database checks use held bytes materialized in random 0700 directories with 0600 files. Source and private-copy identities are checked before/after inspection. These are observed identity/currentness checks; they do not exclude every future same-user modification after the final check and are not a distributed writer lock.

Publication uses held parent directories, owner-private staging, fsynced files/directories, and Linux `renameat2(RENAME_NOREPLACE)` for new bundles. Receipt updates require the expected old byte hash and use `RENAME_EXCHANGE`, validating the displaced identity/bytes while retaining the previous bytes as hidden evidence. A persistent private per-receipt file is protected by nonblocking kernel flock. Its pathname is not unlinked; process death releases the kernel lock. Cooperating concurrent writers cannot both replace the same expected generation. Noncooperating same-user races are detected at the documented observation boundaries; this is not an absolute filesystem CAS guarantee against arbitrary future modifications.

Before finalization dispatch, `PENDING_BACKUP.json` durably records the original signed reservation, exact content, exact finalization request, and both pinned configuration hashes. A transport error may hide remote success, so staged bytes are preserved and the error records the staging path and uncertainty. `recover_backup` accepts only the configured root's private pending-directory namespace. It acquires a kernel recovery lock, validates every staged database, its actual signed finalized head or pinned genesis metadata, and the exact signed/configuration bindings, then either verifies an already persisted finalization or reissues the exact original finalization request. Only a valid external response permits publication. A new service instance can recover without in-memory success flags. The authority must support retrieving/repeating that transaction; absence or refusal remains an error. Recovery publishes historical evidence and does not itself authorize a live epoch.

Incomplete pre-finalization staging without valid evidence, malformed or tampered staging, collisions, and unresolved authority outcomes are retained/rejected rather than deleted or declared successful. There is no broad recursive cleanup of a production backup root. Hidden displaced receipt files and rejected staging require an explicit retention/cleanup policy in future CLI/operations composition; they are excluded from source selection and never treated as current receipts.

## Bounds and deliberate compatibility differences

Database files are bounded at 256 MiB each, with 256 database entries and 1 GiB aggregate stored snapshot limit. Manifest input is bounded at 64 MiB, restore receipts at 256 MiB, journal ranges at 4096 entries, source directory enumeration at 4096 entries, and queued reconciliation requirements at 4096. Native SQLite copy steps have a 60-second deadline. These are rejection bounds, not promises that production workloads of the maximum size complete within an authority lease.

The Node and bundled Rust SQLite engines write their own engine version into database header bytes 96–99. The backup differential test compares every byte and requires all differences to be confined to exactly that header field. Native hashes are computed from actual native bytes; content hashes, bundle hashes, paths, and signed finalizations consequently differ. Other manifest fields match the original. A native-produced bundle's fresh drill and source inspection match the original Node full JSON, and actual finalized-journal replay matches its complete receipt. No header is patched to masquerade as another engine.

An observed inventory and resident file are currently fixed for an epoch. A normal heartbeat that updates resident database bytes therefore also invalidates the cached observation and defers the next action until reconciliation, even when owner/token/generation still match. This is a deliberate conservative liveness boundary, not full legacy heartbeat equivalence. Production integration must account for coordinator-finalized heartbeats marking the epoch dirty; supporting other legitimate heartbeat paths needs a separately verified inventory/lease refresh design, not removal of all database-currentness checks.

Further explicit tightenings include independent raw configuration pins, duplicate-field and unsafe-file rejection, actual inventory instead of a readiness claim, final clock sampling, held-byte private SQLite copies, no caller-seeded verified epoch, and no-replace publication. Typed safe integers accept integral JSON number spellings; native timestamps use the canonical UTC profile. The pure source observation helper accepts an inventory value for binding only; production epoch construction uses the concrete service's opaque observed inventory.

Coordinator journal persistence uses the production JavaScript-compatible stable JSON encoder, so authenticated integral values such as `1.0` are stored as `1` and satisfy the original SQLite integer constraints. These journal fields bind canonical hashes and signatures; their object-member order is not a raw-text authority condition. This does not change the separate raw member-order checks for restore evidence and schema audit records. The replay differential includes genuinely re-signed integral-float receipts and verifies both the resulting native source and the complete Node drill receipt.

## Verification

`state_recoverability_resident_parity` has three groups: real Node-created resident row equality/exclusive expiry; invalid identities and persisted state; and replacement, aliases, permissions, sidecar, and deterministic observation races.

`state_recoverability_parity` covers:

- Actual ten-database backup, every-byte SQLite comparison with the stated version-field exception, complete fresh drill/source JSON parity, and collision preservation.
- Real ten-database startup reconciliation, fresh renewal, epoch gating, pending requirements, dirty heads, and sticky fatal conflicts.
- Invalid real signatures/scope and validly signed authority equivocation.
- Actual SQLite Session replay and full Node receipt parity, with independently signed system-row changesets, data conflicts, and invalid nested signatures rejected; stored/production bytes remain unchanged.
- Lost finalization reply, durable exact request, tampered staged bytes rejected before authority invocation, new-service recovery, and subsequent successful drill.
- Original Node controller receipt/state/error-flag parity, including transient timeout and causal dirty/fatal transitions.
- A controllable clock crossing expiry only after file checks, rejecting both readiness and epoch issuance while the resident lease is still valid.

Three publication unit tests exercise two simultaneous writers, actual child-process death while holding the kernel lock, hidden interrupted staging, unsafe lock aliases, and stale expected hashes. Existing backup authority and stored-source differential suites must also pass after the read-only content-validation helper extraction. Strict production Clippy denies warnings, unsafe code, todo, unimplemented, unwrap, expect, and panic.

Tests use private temporary synthetic runtimes and deterministic fixture-only Ed25519 keys; no production private key is read, written, or emitted. These results establish the native implementation slice and its tested boundaries. They do not constitute external authority deployment acceptance, a human live-action permit, or evidence that every remaining Node route has been replaced.
