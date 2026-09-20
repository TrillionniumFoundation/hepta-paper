# Native schema transition source projection and execution dependencies

This slice implements actual migration-source observation, private SQLite journal
normalization/target-schema projection, complete registered-scope v1/v2 local
planning, signed maintenance reservation, ten-database installation with
durable progress/recovery, and finalization post-state/publication primitives.
It is not the complete operator CLI, a target-host restart/activation proof, an
externally durable final receipt, or independent production qualification.

The native module is exposed as `online_schema_execution`; its actual source observer is crate-private `state_database_inventory::schema_source`. The public types retain real source and signature evidence rather than accepting a serialized readiness claim.

## Source and native entry points

Original behavior comes from `paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs`: source path/identity, stable identity hashing, journal preimage hashing, `expectedNormalizedSourceSha256`, private journal normalization and expected target-schema projection. The later maintenance and installation sources are `autonomous-research-online-schema-transition-journal-normalization.mjs` and `autonomous-research-online-schema-transition-installation.mjs`. The all-scope signed reservation, live local writes, durable progress/recovery and finalization post-state checks are implemented; target restart/authority linearizability and complete CLI modes remain open.

`online_schema_execution::observe_schema_transition_source_v1(runtime_root, relative_path, role, applied_at)` returns `ObservedSchemaTransitionSourceV1` only after actual filesystem and SQLite operations. All fields are private; `.value()` exposes diagnostic/hash data and `.assert_current()` rechecks the captured physical sources. There is no Deserialize, claim constructor, ready flag, public arbitrary callback, or public live database connection.

The single-source role and relative path select the fixed migration template. This helper does not independently prove manifest registration, exactly ten database roles, business-schema provisioning, a common database scope, writer quiescence, trusted deployment configuration or authority freshness. The eventual complete plan factory must bind these observations to the actual full inventory, checked manifest and pinned authority, then obtain and repeatedly validate the signed all-scope reservation before any live source write.

## Actual physical observation

`state_database_inventory::schema_source::SchemaSource` reuses the existing internal `files::DatabaseObservation` reader without making it a ready inventory. The reader holds no-follow, nonblocking file descriptors for DB/WAL/SHM and any rollback journal; checks regular-file type, permissions, single-link identity, bounded bytes, hash and parent directories; and checks missing sidecars remain absent. A nonzero rollback-journal header is refused instead of recovering the source. Pre-transition databases may lack the target marker or handoff schema and therefore must not be manufactured into `ObservedStateDatabaseInventoryV1`.

The native path profile rejects symlink ancestors/final files, hardlinks, world-write, inappropriate group-write, aliases using empty/dot/dot-dot components and unsupported roles. The original permits a hardlinked main database and some normalized path spellings; these are explicit native restrictions. The retained observation is a checked snapshot, not a lease against future writers.

The source SHA, exact file identity and stable identity hash use actual source bytes and Unix stat fields. WAL and SHM identities/content hashes enter the original journal-preimage domain; SHM is included in this binding but carries no durable SQLite content.

## Private projection

The private mutable copy is created in a random 0700 directory with exclusive 0600 files. It copies the DB and any WAL from held source descriptors, verifies copied content, and deliberately does not copy SHM. An empty owned SHM inode is created before SQLite rebuilds it. The source and directory identities are rechecked before and after copy and before returning.

Only the private copied database is opened by SQLite. The actual sequence checks journal mode, handles a WAL alongside DELETE mode, performs `wal_checkpoint(TRUNCATE)`, requires a non-busy result, selects DELETE journaling and FULL synchronization, closes SQLite, requires sidecars absent, and hashes actual resulting database bytes. Target DDL is projected by the existing fixed `SchemaTransitionTargetV1` operation on a further private SQLite backup. Handoff v1-to-v2 migration history/cutover invariants, target-object conflicts, quick-check and foreign-key checks remain enforced by that operation. A second source/copy check follows this work.

Ordinary user schema objects hidden by the original `LIKE 'sqlite_%'` underscore wildcard are refused independently. The original historical schema-hash domain is preserved for normal objects; a populated `sqliteXbusiness` cannot disappear from the native safety decision.

Cleanup tracks held inodes of created DB/WAL/SHM files, tolerates their expected SQLite deletion, and never recursively walks the directory or removes a replacement inode. The private directory is removed only when it still has the owned identity and is empty. This protects the source files and avoids deleting unrelated replacements. It is not a custom fd-bound SQLite VFS or a guarantee against an adversarial process with the same user privileges altering a private namespace between every check.

## SQLite engine byte compatibility

The pinned Node 22.23.1 runtime uses SQLite 3.51.3; the current locked Rust rusqlite/libsqlite3-sys build uses SQLite 3.53.2. A real WAL normalization differential proves that the resulting complete database bytes differ only at header offsets 96–99, the last-writing SQLite version number (`3051003` versus `3053002`). Consequently the exact raw normalized SHA differs. All other source-identity, journal-preimage, schema, integrity and target-schema fields match. A DELETE source requiring no header write retains exact hash equality.

The implementation returns the genuine native raw-byte hash. It does not overwrite header bytes, return a fabricated old hash, or treat distinct raw hashes as interchangeable. A future native plan/reservation must bind this native projection. A pre-existing Node reservation that binds the old engine's different normalization hash must fail before writes or be handled by an explicitly qualified same-engine execution profile. Resuming such an old reservation across the engine change is an open compatibility gap, not a passed parity case.

## Whole-scope local plans and signed maintenance

`online_schema_execution::plan::build_schema_transition_plan_v1` reads the actual inventory itself and refuses caller-supplied inventory claims. It requires exactly the ten roles and unique sorted instance IDs, the manifest/scope hashes, registered business schema objects, quick-check and foreign-key success. The only allowed inventory blockers are missing fixed transition objects. Each database is independently projected and its effective schema/source digest must match the actual inventory. The complete inventory and every retained source are inspected again before a plan is returned.

The returned `ObservedSchemaTransitionPlanV1` has private fields and no Deserialize. Initial v1 computes the original not-applicable pristine domains. V2 reads the actual old metadata/schema contract, verifies real pristine observations for all ten databases, binds the old writer/global scope, computes the full runtime pristine hash and requires the caller's independent expected pristine pin. The plan, identity and transition-inventory hashes match the original source. Fixed journal/marker/handoff bundle hashes are computed from checked-in SQL. Local planning never invokes the authority transport.

`online_schema_execution::maintenance::reserve_schema_maintenance_v1` consumes this actual plan. It first rechecks source pins and rejects clocks before the plan timestamp, then sends the real reserve request through `PinnedMutationAuthorityV1`. Actual signature verification checks the complete subject, request hash, exact instances, version-specific genesis, all-registered-writers fencing and quiescence mode. After the RPC, all sources and the inventory are inspected again, the current pinned configuration/key files are verified, and a final memory-only clock sample enforces expiry and the required remaining execution window. Equality at the required remaining-window boundary is accepted; expiry itself is exclusive.

Only then can `QuiescedSchemaMaintenanceV1` exist. It has no public constructor, Deserialize or Clone, and exposes no live write operation. Retained revalidation keeps a clock high-water mark even on failed checks, so a previously observed expiry cannot be undone by supplying an older sample. Different authority configuration identity, changed sources, bad signatures or a signed but false fencing claim fail closed. This verifies the signed authority assertion; it does not establish that an unqualified raw transport/service is externally linearizable. V2's signed target-configuration hash remains a binding for the later actual configuration/restart chain, not proof that that target deployment is already active.

The runtime root's observed path/device/inode/mode/UID/GID is privately retained and rechecked; the plan stores its canonical absolute root. This complements the existing source/parent pins and avoids changing the plan's meaning if the process working directory changes later.

## Actual differential tests

`tests/schema_source_projection_parity.rs` is the integration target for this source-plan/maintenance stage. The Node oracle invokes the real original source. A test-only loader appends exports for the two private projection helpers and private journal normalizer; it does not replace any function body, cryptographic validator or dependency. Every fixture is an isolated temporary SQLite database, with effective WAL frames created by a real Node writer and copied while that writer is open. No deployed runtime, user key, or production database is accessed.

The source/projection five-group slice passed in 6.93 seconds. The expanded seven-group suite adds whole-scope planning and signed maintenance; its final validation is recorded below:

- `actual_file_identity_schema_and_journal_projection_match_original_without_source_writes`: DELETE, effective WAL, missing SHM, checkpointed WAL/stale SHM, and actual handoff-v1 migration. Complete objects are compared except the explicitly asserted engine-dependent raw hash; source bytes and identities remain unchanged.
- `wal_normalization_hashes_bind_actual_writer_engine_bytes`: runs real original Node and native normalization against separate copies of the same WAL source, compares all bytes, proves the exact writer-version-header difference and verifies the native returned hash against actual native file bytes.
- `actual_target_conflicts_foreign_keys_and_hidden_user_surface_fail_closed`: real conflicting target table, foreign-key violation, and original-accepted/native-rejected hidden user object.
- `retained_source_proof_rejects_byte_mode_and_sidecar_drift`: actual byte, permission, WAL, SHM and rollback-journal changes after observation.
- `physical_sources_refuse_aliases_hot_journals_and_path_escapes`: real symlink, hardlink, FIFO, writable file, pending rollback journal and dot-alias path refusal.
- `actual_ten_database_initial_and_pristine_rebind_plans_match_node`: original actual ten-database fixtures, complete v1 and v2 plan/identity/hash equality, real v2 pristine pin rejection, current-source invalidation, and actual signed v2 old-head/new-genesis reservation verification.
- `signed_maintenance_requires_exact_scope_fencing_fresh_final_clock_and_source_pins`: genuine temporary authority signatures and original verifier acceptance/rejection, bad signature, signed false fencing, signed instance splice, late final sample, exact remaining-window boundary, expiry/rollback refusal, actual source changes during the RPC and zero RPCs for pre-existing source drift/clock rollback.

The final isolated seven-group suite passed (121.01 seconds). After the final guard rejecting clocks before `plannedAt`, the affected signed-maintenance group passed again (116.30 seconds). Strict production Clippy passed with warnings, unwrap, expect, panic and unsafe-code denied; test Clippy and oracle ESLint passed. These are isolated-workspace results, separate from the production checkpoint. No live-write or installation completion is claimed by these tests.

## Next execution work

The local full-scope planner and signed reservation are implemented. The live executor consumes these opaque objects and preserves their subject, source/root pins and fresh lease checks throughout every filesystem and SQLite write; passing a caller Boolean or a detached serialized receipt is insufficient.

The [journal normalization stage](SCHEMA_JOURNAL_NORMALIZATION_HANDOFF.md) and [schema genesis installation](SCHEMA_GENESIS_INSTALLATION_HANDOFF.md) now implement actual ten-database normalization, signed genesis/metadata installation, identity-bound stale-SHM handling, live signed-lease checks, durable per-instance progress and recovery across process death. Recovery compares complete expected and actual SQLite state, while an independent final inventory/pristine aggregation and authority finalization remain open. External linearizability and deployment qualification remain separate from local implementation.
