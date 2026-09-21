# State recoverability service and epoch controller

## Status and original sources

This native library slice connects actual SQLite state, pinned external authority signatures, stored backup evidence, isolated restore execution, resident leases, and the recoverability epoch state machine. The native CLI is documented in [STATE_BACKUP_CLI_HANDOFF.md](STATE_BACKUP_CLI_HANDOFF.md). Complete autonomous activation assembly, offhost deployment, and independent operational acceptance remain separate requirements; library and CLI availability do not establish them. No production authority, live portal, credentials, or production runtime was used by its tests.

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

`StateRecoverabilityControllerV1` owns this concrete service, resident lease claim, and clock. It starts dirty with no verified head; there is deliberately no caller-supplied initial verified head. Its methods are `reconcile_with_validity`, `reconcile_existing_heartbeat_history_v1`, `assert_for_action`, `mark_finalized`, `require_reconciliation`, `epoch_status`, and `policy`. The epoch permit has private fields and a read-only value projection. The controller implements the coordinator's `RecoverabilityEpochFenceV1`; production composition must use this real implementation rather than an arbitrary successful test fence.

The internal `sqlite_mutation_coordinator::backup_replay` bridge accepts an already verified finalized-journal range and pinned online verifier. It does not publish generic system-table write helpers. The live activation database's dedicated `startup` child performs only startup reconciliation; read-only pending counts use the inventory's private snapshot API.

## Actual data and authority chain

A backup obtains opaque actual inventory, reserves it through the backup authority, checks every local signed finalized head or pinned genesis metadata against that reservation, and observes inventory stability again. Native SQLite backup copies are made from the inventory's held-file private DB/WAL snapshots. The original database, WAL, and SHM are never passed to a backup/inspection callback. Copies undergo schema, quick-check, foreign-key, byte-length, and hash validation. The real signed finalization binds the exact resulting content hash before no-replace publication.

A restore drill verifies the historical reservation/finalization, current signed head, exact bundle/database set, and snapshot hashes. Stored immutable files are read from held descriptors into private copies before SQLite opens them. An advanced head requires a genuinely signed range for the same reservation, scope, snapshot, online authority, and writer manifest, with every nested online reservation/finalization verified and causally continuous. SQLite Session changesets are applied only to private copies. Each entry's business changeset, immutable system-row comparison, marker, finalization record, integrity checks, and resulting verified head share one IMMEDIATE transaction. Changeset conflicts and system-table modifications abort. Internally, `PreparedRestoreDrillV1` retains the actual manifest, database files, held directory and previous receipt hash. `prepare` performs the restore without replacing the stored receipt; consuming `publish` rechecks those files and performs the existing atomic replacement. The public standalone drill still prepares and publishes historical evidence. Heartbeat refresh additionally proves current live state before consuming this publication object.

Pending reconciliation first observes an exact ten-role inventory and trust/manifest binding, then runs actual signed startup recovery on restricted live handles. It obtains a fresh complete inventory after these authorized writes and verifies stable scope. Final pending counts are read only from fresh private snapshots. These operations may repair the original system journal; business DML is not replayed during pending reconciliation. The combined renewal receipt explicitly reports `businessDmlReplayed:false`; the backup/drill receipts separately report their own `productionStateMutated:false`.

The controller gates initial, current, dirty, reconciliation-required, fresh-snapshot renewal, journal renewal, transient deferred, and sticky fatal states. Finalized-head notifications can dirty an epoch and cannot create one. Readiness requires an actual source/inventory, fresh pinned signed observation, actual valid resident lease, causal head coverage, and no unresolved requirements. Every common `ready` path for a journal-backed source also actually replays the authenticated range in private copies and compares every current effective SQLite row against the result. A stored historical receipt and matching schema/scope/head cannot substitute for that proof. The private `VerifiedCurrentReplayV1` can cache a completed comparison only for the exact still-pinned actual inventory hash and restore receipt hash; it has no public constructor and grants no epoch by itself. Snapshot-current sources retain their original exact inventory-hash binding. Authority rollback, equivocation, invalid signatures, and contradictory finalized heads fail. Required validity, exclusive expiry, maximum observation age, and monotonic clock checks apply. After all file/SQLite/signature checks, a final clock sample is checked against immutable observation and resident validity before returning readiness or an epoch permit.

## Files, concurrent publication, and interruption recovery

Runtime trust, receipts, and database files are opened through no-follow component walks and checked for regular-file ownership, permissions, link count, identity, size, and modification metadata. Stored database checks use held bytes materialized in random 0700 directories with 0600 files. Source and private-copy identities are checked before/after inspection. These are observed identity/currentness checks; they do not exclude every future same-user modification after the final check and are not a distributed writer lock.

Publication uses held parent directories, owner-private staging, fsynced files/directories, and Linux `renameat2(RENAME_NOREPLACE)` for new bundles. Receipt updates require the expected old byte hash and use `RENAME_EXCHANGE`, validating the displaced identity/bytes while retaining the previous bytes as hidden evidence. A persistent private per-receipt file is protected by nonblocking kernel flock. Its pathname is not unlinked; process death releases the kernel lock. Cooperating concurrent writers cannot both replace the same expected generation. Noncooperating same-user races are detected at the documented observation boundaries; this is not an absolute filesystem CAS guarantee against arbitrary future modifications.

Before finalization dispatch, `PENDING_BACKUP.json` durably records the original signed reservation, exact content, exact finalization request, and both pinned configuration hashes. A transport error may hide remote success, so staged bytes are preserved and the error records the staging path and uncertainty. `recover_backup` accepts only the configured root's private pending-directory namespace. It acquires a kernel recovery lock, validates every staged database, its actual signed finalized head or pinned genesis metadata, and the exact signed/configuration bindings, then either verifies an already persisted finalization or reissues the exact original finalization request. Only a valid external response permits publication. A new service instance can recover without in-memory success flags. The authority must support retrieving/repeating that transaction; absence or refusal remains an error. Recovery publishes historical evidence and does not itself authorize a live epoch.

Incomplete pre-finalization staging without valid evidence, malformed or tampered staging, collisions, and unresolved authority outcomes are retained/rejected rather than deleted or declared successful. There is no broad recursive cleanup of a production backup root. Hidden displaced receipt files and rejected staging require an explicit retention/cleanup policy in future CLI/operations composition; they are excluded from source selection and never treated as current receipts.

## Bounds and deliberate compatibility differences

Database files are bounded at 256 MiB each, with 256 database entries and 1 GiB aggregate stored snapshot limit. Manifest input is bounded at 64 MiB, restore receipts at 256 MiB, journal ranges at 4096 entries, source directory enumeration at 4096 entries, and queued reconciliation requirements at 4096. Native SQLite copy steps have a 60-second deadline. These are rejection bounds, not promises that production workloads of the maximum size complete within an authority lease.

The Node and bundled Rust SQLite engines write their own engine version into database header bytes 96–99. The backup differential test compares every byte and requires all differences to be confined to exactly that header field. Native hashes are computed from actual native bytes; content hashes, bundle hashes, paths, and signed finalizations consequently differ. Other manifest fields match the original. A native-produced bundle's fresh drill and source inspection match the original Node full JSON, and actual finalized-journal replay matches its complete receipt. No header is patched to masquerade as another engine.

An epoch still pins the observed inventory and resident file; a finalized heartbeat invalidates those observations and must mark the epoch dirty. The explicit `reconcile_existing_heartbeat_history_v1(bundle_path, required_validity_ms)` route now refreshes that epoch without creating another backup: authenticate the historical bundle; obtain and verify the complete fresh signed range; accept only the original fixed `heartbeatInstanceLease` operation and its permitted resident-row columns; really replay every entry; compare all current effective rows and signed local heads; recheck the complete snapshot file namespace and actual inventory after the completion clock; then publish the drill and obtain a fresh head and actual lease before common readiness. Both Node-generated and native-coordinator-generated heartbeat changesets are tested. A heartbeat with an optional cycle receipt is supported. Normal `reconcile_with_validity` now discovers those historical candidates automatically when native source currentness rejects the previous zero-journal inventory. This restores the original Node normal-controller behavior while retaining the stronger native row proof. Discovery keeps the original candidate order, skips locally invalid snapshots without authority calls, and performs the complete replay before publishing. Once a candidate is selected, validation failure cannot silently renew a backup or try another historical candidate. A newer authenticated snapshot whose inventory is still exactly current immediately retains the original fresh-renewal path, including when its drill is missing and older historical snapshots coexist. The normal already-selected/advanced-head branch supports the general signed replay engine and now also compares current rows before publication. Source-fallback discovery also supports business-only and mixed business/heartbeat ranges under the complete original 134-operation/16-writer manifest. Custom manifests retain only the previous bounded heartbeat fallback.

General automatic recovery independently reloads and validates the original fixed plan registry, matches its recomputed manifest hash, and binds every already-verified reservation to its integrated operation, assigned writer, actual inventory role/instance/schema, and writer implementation hash. Each bounded changeset may affect only table/write-operation pairs allowed by that exact fixed plan; system tables remain forbidden. The private replay also passes the live coordinator's plan-specific database-surface checks. Common already-selected and current-source proof applies the same registry guard when the complete builtin manifest is used. Signed historical evidence cannot reconstruct the original callback's statement invocation trace or SQL parameters; this layer authenticates fixed-plan membership/effects and exact current-row equivalence, not an invented callback trace. Arbitrary external/custom non-heartbeat registries remain unsupported for the new automatic source-fallback selection unless a complete independently pinned registry is added; the preexisting selected-source replay contract remains available. No new backup or extra authority probe is used for successful candidate selection.

The row comparison encodes SQLite value types and all cells, preserves duplicate/no-primary-key/NULL-primary-key rows, includes hidden rowids, and compares WITHOUT ROWID tables by their complete row multiset. It canonicalizes only already-authenticated system journal JSON and ignores the valid local `recorded_at` bookkeeping time; signed finalization times remain compared. Views are covered by the separately verified exact schema. Virtual/shadow tables, inaccessible hidden rowids, invalid UTF-8, oversized cells and exhausted comparison budgets are rejected. Comparison bounds are 1024 schema objects, 4096 columns per table, one million rows and one GiB cell bytes per database, with a 16 MiB cell limit. This is an observed-state proof with before/after file checks, not a distributed lock excluding every later writer.

Further explicit tightenings include independent raw configuration pins, duplicate-field and unsafe-file rejection, actual inventory instead of a readiness claim, final clock sampling, held-byte private SQLite copies, no caller-seeded verified epoch, and no-replace publication. Typed safe integers accept integral JSON number spellings; native timestamps use the canonical UTC profile. The pure source observation helper accepts an inventory value for binding only; production epoch construction uses the concrete service's opaque observed inventory.

Coordinator journal persistence uses the production JavaScript-compatible stable JSON encoder, so authenticated integral values such as `1.0` are stored as `1` and satisfy the original SQLite integer constraints. These journal fields bind canonical hashes and signatures; their object-member order is not a raw-text authority condition. This does not change the separate raw member-order checks for restore evidence and schema audit records. The replay differential includes genuinely re-signed integral-float receipts and verifies both the resulting native source and the complete Node drill receipt.

## Historical-source authorization regression

Before the common readiness fix, a real reproduction created a native ten-database backup, committed a genuine Node-coordinated heartbeat with valid Ed25519 reservation/finalization, then changed `native-store.records` outside that signed journal. An actual private restore drill still correctly passed: the historical snapshot plus signed range was recoverable. A newly constructed controller nevertheless returned `autonomous_research_state_recoverability_ready`, `mode: current`, at head 1. The failing regression confirmed this response before the fix. Its root cause was treating historical recoverability plus current schema/scope/head as proof of the current business rows.

The fixed common `ready` path requires the real current-row proof described above, including for a new controller with no cached proof. The regression must now reject the same data mismatch and withhold an epoch. The separate heartbeat path must preserve the old drill receipt on an invalid nested signature, an extra unsigned row, a NULL-primary-key row, or a change injected during its completion clock. A legitimate fresh controller with exact recovered rows remains a positive control. Historical `inspect_sources`/standalone drill reports remain available as historical diagnostics and do not themselves issue live authority.

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

`state_recoverability_heartbeat_parity` covers real Node and native fixed-plan heartbeat writes, exact changeset/post-state comparison, complete Node restore receipt parity, same-bundle refresh without additional snapshot reserve/finalize calls, the new-controller unsigned-live-row regression, and completion-clock mutation before publication. Private comparison tests cover duplicate/no-PK/NULL-PK rows, hidden rowids, TEXT/BLOB distinction, invalid UTF-8, unsupported virtual/hidden-column layouts, cell limits, and bounded exact database-set revalidation.

`state_recoverability_automatic_parity` adds normal discovery for running and fresh controllers, full original Node controller/drill JSON comparison from identical stored preimages, first and second genuine heartbeats, invalid-newer-candidate handling, and exact head/range/head calls with no additional backup. Unsigned normal/NULL-key/BLOB-type changes, corrupt nested signatures, and completion-clock changes preserve the old receipt and withhold an epoch. A finalized current snapshot without a drill keeps its original renewal behavior, including with an older snapshot present after actual SQLite VACUUM. Private SQLite comparisons include generated columns and preserve a stricter existing engine limit. `SQLITE_LIMIT_LENGTH` is applied before private replay/current-row queries; actual oversized generated values produce SQLite `SQLITE_TOOBIG` before Rust row materialization. The 16 MiB engine limit also constrains encoded rows, in addition to the existing individual-cell and aggregate bounds.

`state_recoverability_mixed_parity` uses the complete original operation registry, original native-store migrations, and actual fixed `createJob` plus resident heartbeat operations. It compares full original Node controller/drill output for business-only and mixed ranges, and independently compares native-coordinator-produced changesets/state/provenance before complete recovery. Re-signed unknown operations, cross-role assignments, incorrect code provenance, effects outside the registered plan, system-table writes, invalid nested signatures, and unsigned NULL-key BLOB rows must fail without replacing the old drill, writing live databases, reserving a new backup, or returning an epoch. These are synthetic authority tests, not runtime activation or production qualification.

Seven publication unit tests exercise two simultaneous writers, actual child-process death while holding the kernel lock, hidden interrupted staging, unsafe lock aliases, stale expected hashes, concurrent child-directory churn, and actual parent replacement. Directory identity checks bind type, device, inode, owner, group and permissions; a directory link count may legitimately change as child directories are created or removed. Ordinary-file hardlink checks remain enforced. A 20,000-check concurrent child-churn regression must have zero false refusals, while real directory replacement remains an error and foreign data is preserved. Existing backup authority and stored-source differential suites must also pass after the read-only content-validation helper extraction. Strict production Clippy denies warnings, unsafe code, todo, unimplemented, unwrap, expect, and panic.

Tests use private temporary synthetic runtimes and deterministic fixture-only Ed25519 keys; no production private key is read, written, or emitted. These results establish the native implementation slice and its tested boundaries. They do not constitute external authority deployment acceptance, a human live-action permit, or evidence that every remaining Node route has been replaced.


## Native-store transaction evidence lifetime

The concrete process-transport fence provides an internal retained native-store
token. Its constructor performs full original activation binding checks before
opening the owning SQLite connection. It requires the guard's actual original
inventory and the recovery evidence's independently observed inventory to have
identical whole reports and runtime roots. The actual validated resident
snapshot must match the fixed resident role/path and its exact source-file
identity; an otherwise valid resident lease from another root is rejected.

Controller evidence uses `Rc`, and the token retains the same allocation without
cloning descriptors. Fatal transitions, clock rollback, generation changes and
coordinator feedback can invalidate the capability and clear controller evidence
without closing those database/WAL/SHM descriptors. A weak active-scope marker
makes full observe/assert/reconcile operations reject before file I/O through
all clones of that fence. It is not a process-global lock against unrelated raw
opens. Memory feedback remains available and invalidates the old generation.

Scoped checks use the original inventory guard, held stored-source and head
snapshots, exact resident identity/validated row and expiry, genuine process pins,
original activation projection, clean state and original evidence identity.
Resident SQLite is not re-opened: unchanged non-target inventory bytes preserve
the already validated row. The terminal time check performs no I/O. Any scoped
failure invalidates that scope and preserves its retained allocation until drop.
The owning caller must close every target SQLite connection before dropping the
token and every original inventory, even on unwind; transaction rollback alone
is insufficient for idle WAL handles. The token itself is not native writer
admission or permission to run an arbitrary SQL operation.

Eight new native transaction tests pass, including actual DELETE and pre-existing
WAL cases where coordinator feedback itself first clears populated evidence,
clock rollback, pin rejection, non-target mutation, wrong resident root,
same-head renewal and unwind. Independent subprocesses remain blocked until
SQLite closes. The original five activation-binding regressions also pass.
