# Native schema transition source projection and execution dependencies

This slice implements actual migration-source observation, private SQLite journal
normalization/target-schema projection, complete registered-scope v1/v2 local
planning, signed maintenance reservation, ten-database installation with
durable progress/recovery, durable v1 finalization/observation, and the v2
target-configuration observation/final-receipt boundary. The ordinary native
CLI exposes read-only pristine review/planning and independently pinned installed
execute/recovery. The installed composition uses the existing kernels and a
separate physical service-manager owner. Source implementation is distinct from
actual target-host canary, rollback and independent deployment qualification.

The native module is exposed as `online_schema_execution`; its actual source observer is crate-private `state_database_inventory::schema_source`. The public types retain real source and signature evidence rather than accepting a serialized readiness claim.

## Source and native entry points

Original behavior comes from `paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs`: source path/identity, stable identity hashing, journal preimage hashing, `expectedNormalizedSourceSha256`, private journal normalization and expected target-schema projection. The later maintenance and installation sources are `autonomous-research-online-schema-transition-journal-normalization.mjs` and `autonomous-research-online-schema-transition-installation.mjs`. The all-scope signed reservation, live local writes, durable progress/recovery, finalization post-state checks and the v2 target-authority observation protocol are implemented. The source projection/planner does not control services. Installed execution borrows a separately observed root profile and completes actual fixed-unit stop/restart operations before entering the relevant kernel scopes; independently qualified installed acceptance remains separate.

`online_schema_execution::observe_schema_transition_source_v1(runtime_root, relative_path, role, applied_at)` returns `ObservedSchemaTransitionSourceV1` only after actual filesystem and SQLite operations. All fields are private; `.value()` exposes diagnostic/hash data and `.assert_current()` rechecks the captured physical sources. There is no Deserialize, claim constructor, ready flag, public arbitrary callback, or public live database connection.

The single-source role and relative path select the fixed migration template. This helper does not independently prove manifest registration, exactly ten database roles, business-schema provisioning, a common database scope, writer quiescence, trusted deployment configuration or authority freshness. The whole-scope factory described below binds these observations to the actual full inventory, checked manifest and pinned authority. Live writes separately require the signed all-scope reservation and its retained checks; a local plan never supplies that capability.

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

The executable source/projection and signed-maintenance cases below remain registered in the existing source-evidence producer. Runtime results belong to their exact-head and prospective-merge receipts, not this contract:

- `actual_file_identity_schema_and_journal_projection_match_original_without_source_writes`: DELETE, effective WAL, missing SHM, checkpointed WAL/stale SHM, and actual handoff-v1 migration. Complete objects are compared except the explicitly asserted engine-dependent raw hash; source bytes and identities remain unchanged.
- `wal_normalization_hashes_bind_actual_writer_engine_bytes`: runs real original Node and native normalization against separate copies of the same WAL source, compares all bytes, proves the exact writer-version-header difference and verifies the native returned hash against actual native file bytes.
- `actual_target_conflicts_foreign_keys_and_hidden_user_surface_fail_closed`: real conflicting target table, foreign-key violation, and original-accepted/native-rejected hidden user object.
- `retained_source_proof_rejects_byte_mode_and_sidecar_drift`: actual byte, permission, WAL, SHM and rollback-journal changes after observation.
- `physical_sources_refuse_aliases_hot_journals_and_path_escapes`: real symlink, hardlink, FIFO, writable file, pending rollback journal and dot-alias path refusal.
- `actual_ten_database_initial_and_pristine_rebind_plans_match_node`: original actual ten-database fixtures, complete v1 and v2 plan/identity/hash equality, real v2 pristine pin rejection, current-source invalidation, and actual signed v2 old-head/new-genesis reservation verification.
- `signed_maintenance_requires_exact_scope_fencing_fresh_final_clock_and_source_pins`: genuine temporary authority signatures and original verifier acceptance/rejection, bad signature, signed false fencing, signed instance splice, late final sample, exact remaining-window boundary, expiry/rollback refusal, actual source changes during the RPC and zero RPCs for pre-existing source drift/clock rollback.

The source tests do not qualify installed authority or claim that the production checkpoint has advanced. Strict Clippy, real execution results and failure reproductions are recorded by the existing source-owner evidence and PR/run logs; those observations are not duplicated here.

## Ordinary read-only review and planning entry

For v2, first observe the exact pristine preimage without constructing a plan or
reservation:

```sh
hepta-paper-rust autonomous-online-schema-transition --action inspect-pristine \
  --runtime-root /absolute/native-runtime \
  --authority-process-config /absolute/authority-process.json \
  --authority-process-config-sha256 sha256:<exact-file-digest> \
  [--expected-previous-final-receipt-sha256 sha256:<raw-FINAL-file-digest>]
```

A separate invocation must pin the returned `prePristineRuntimeStateHash`:

```sh
hepta-paper-rust autonomous-online-schema-transition --action plan \
  --runtime-root /absolute/native-runtime \
  --authority-process-config /absolute/authority-process.json \
  --authority-process-config-sha256 sha256:<exact-file-digest> \
  --expected-pre-rebind-pristine-runtime-state-hash sha256:<reviewed-hash> \
  [--expected-previous-final-receipt-sha256 sha256:<raw-FINAL-file-digest>]
```

`online_schema_execution::cli::schema_transition_plan_cli_v1` calls the existing
shared source/inventory owner. `inspect-pristine` and `plan` observe the same ten
databases, descriptors, private SQLite projections and authority configuration;
the former cannot deserialize into a plan or reservation. The CLI does not
assemble a replacement inventory, writer, migration engine or recovery journal. It uses the compiled canonical
state-database manifest and the existing `state_backup_writer_manifest_v1`
source. The public process configuration, referenced verifier configuration,
public key document and executable are retained by the original pinned authority
loader. Planning invokes no process or authority RPC and reads no private key.
The actual ordinary-CLI fixtures select a pinned executable that returns failure
if called; both initial v1 and pristine-rebind v2 plans still succeed.

The command supports `--requested-lease-ms` (default 120000),
`--required-execution-window-ms` (default 30000), the separately selected
`--expected-pre-rebind-pristine-runtime-state-hash`, and an optional exact raw
`--expected-previous-final-receipt-sha256`. Each plan is based on the
real registered ten-database source observations and private SQLite projections.
The whole inventory, source descriptors, public authority inputs and command
are revalidated after the final clock observation; a negative/regressing clock,
changed public trust, changed executable or concurrent database change rejects
without overwriting the concurrent bytes. This is an observation, not an atomic
cross-database transaction or hostile-same-UID filesystem guarantee.

The response retains the original plan-report fields and adds explicit native
scope and false execution/release/submission/production/retirement authority
fields. `ready=true` means a fresh source plan was produced, never that a writer
can activate. The actual plan hash is recomputed by the tests before independent
observation times and their dependent hash are normalized for Node comparison.
Fresh retries produce the same transition identity without database writes.

This profile requires explicit canonical absolute runtime/configuration paths
and an externally selected raw configuration-file SHA-256. It does not auto-pin
an arbitrary current filename or inherit production layout/credentials from the
environment. Numeric CLI options are ASCII unsigned decimal and bounded by
the native authority contract (at most 900000 milliseconds); broader Node
Number/path/environment coercions are not claimed equivalent. The existing v2
planner remains fail-closed for unsupported genesis inputs.

An existing control directory remains fail-closed unless the caller pins the raw
`FINAL.json` file and the directory is one of two closed finalized shapes:
`ACTIVE.json + FINAL.json` from the incumbent Node owner, or
`NORMALIZATION.native.v1.json + FINAL.json` from the canonical Rust owner. The
Node form must bind a finalized ACTIVE plan/request/reservation/installations to
the exact FINAL receipt. The Rust form must bind the durable plan, reserve,
installation, finalization and v1 observation or v2 target-restart observation
progress to that receipt. Both paths verify the historical signed audit chain and
retain all source/control descriptors through the new observation. Unknown files,
unresolved progress, absent/wrong pins, substituted bytes or configuration drift
remain refused. The CLI never treats persisted JSON as execution authority,
erases an interrupted plan or changes a final receipt. The control path is checked
both before and after the complete source observation. Actual process-death tests
kill the ordinary binary after private-copy creation, then retry through the same
entry: source bytes remain unchanged and surviving private-copy residue is neither
adopted nor erased.

A finalized native v2 predecessor additionally requires
`--historical-source-authority-process-config ABSOLUTE_PATH` and
`--historical-source-authority-process-config-sha256 sha256:HASH`. This separately
pinned historical public verifier must match the original journal's public
configuration hash and verify the original reservation/finalization. The current
target public verifier independently verifies the complete final audit and must
retain the same authority, key, scope and database identity with the finalized
target writer manifest. Both public configuration owners and process inputs are
retained and rechecked; neither process is invoked during planning. A public
verifier configuration hash is a different domain from the signed private daemon
`targetAuthorityConfigurationHash`. Missing historical pins, altered source
configuration or journal hash, and substituted target writer/scope/key fail
before source planning. V1 retains its original current-configuration equality;
neither CLI profile silently adopts a historical configuration from the journal.

Before a v2 reservation, installed execution first performs the stopped-source
authority bootstrap. The installed Node 0.21 protocol only implements the v1
schema request family and cannot issue v2 pristine-rebind receipts. The fixed
authority unit is therefore stopped under its independent persistent condition,
its complete DB/WAL/SHM/journal preimage is retained, and the existing read-only
signed-history owner builds the native journal under the exact source
configuration. The root publisher installs that image without replacing an
unknown file, then starts the separately pinned native daemon with the source
configuration. Only then does the existing v2 reserve/normalize/install/finalize
kernel run. The later target restart changes to the signed target configuration;
it does not repeat the legacy journal conversion. A lost start reply queries
the exact running native command instead of launching another daemon.

Historical Node initial genesis retains its exact eight-field instance and
six-field installation signature domains. The versioned public verifier checks
those original signed bytes and complete SQL heads; it never translates them
into a newly signed current genesis. Pending native rebind rows remain pending
until the existing target-daemon activation owner validates and activates them.
Source and target drop-ins cannot silently rewind a selected target on retry.
The authority stop condition is durable before publishing either command, and
the four business-writer barriers remain held throughout bootstrap and target
activation. Source conversion and target switching use the same physical
publisher and service-manager owner.

`--action execute` and `--action recover` require `--execute`, the original
`--transition-id`, `--expected-plan-hash`, `--planned-at`, and an independently
pinned `--installed-maintenance-profile`/SHA-256 pair. The real and effective UID
must both be root. The closed profile names the four fixed business writer
units, exact fragment/drop-in/executable/argument/input hashes, service
principals and the source/target authority handoff. It grants schema maintenance
only. The native authority executable is separately pinned as actual ELF bytes;
its command, configuration and effective manager properties are verified.

`installed_owner::execution` composes reserve, normalization, installation,
finalization, target restart, signed observation and the original final-receipt
publisher. Root-owned persistent conditions live under the independent
`/var/lib/hepta-paper-maintenance/schema-v1` hierarchy. Every ancestor excludes
non-root renames and each new directory entry is synced before SQL effects.
Typed stop jobs, authenticated PID-1 manager ownership and actual recursive
cgroup-v2 population establish physical quiescence. D-Bus readers close before
kernel scopes; continued checks use only retained profile/barrier/boot/pidfd and
cgroup facts. Errors and process death retain barriers.

The authority has a separate persistent stop barrier while its legacy journal
is preserved and published through the existing public-key history, backup and
native image builders. Actual original DB/WAL/SHM/journal bytes, rowids and raw
signed records remain retained. Durable intent plus no-replace rename/publication
lets recovery query completed steps; it cannot overwrite an unknown file or
renew an old lease. Only verified publication releases the authority stop marker.
An exact already-running native target is observed after a lost reply rather
than restarted again. All four business writer barriers remain in place after
schema publication; canary, rollback, writer activation and accepted Node
retirement require their separate current-subject evidence.

The control predecessor is archived as the complete verified historical
namespace before a fresh root-owned control is created. Versioned incumbent
wire validation remains a historical observation path and never grants current
reservation or writer authority. Multiple retained generations form a verified
signed chain to an independently pinned endpoint, with each archive consumed
once; filename timestamps do not choose a history.

The version 2 installed intent records `never-dispatched` before bootstrap and
reserve, and durably changes that field to `dispatch-unknown` before either
external effect. `--action rollback` admits only the independently pinned
predecessor before both dispatches, with no new reservation/final receipt. The
same global maintenance lock captures the original manager frames and complete
control preimages before stopping source writers. The selected inverse retains
the displaced empty control, then advances to `writer_resume_pending`; recovery
after that boundary does not copy the old control over new source results.

A failed source restart or final completion clock/CAS physically fences the
source again while that global lock is still held. It first reinstates durable
conditions, then authenticates the same PID 1 and boot, reloads conditions,
completes actual `StopUnit` jobs, and retains exact unit/cgroup-empty observations.
`ConditionPathExists` prevents a future start; its file alone does not stop an
already running writer. A failed stop or observation remains an unknown physical
result and leaves the durable rollback pending. Neither this early inverse nor
the private source tests accept rollback after a v2 dispatch or target canary.

The opt-in `systemd::rollback_refence_tests` selector creates solely a randomly
named runtime unit under `/run/systemd/system`, running fixed `/usr/bin/sleep` as
UID/GID 65534. It uses actual PID 1 Start/Stop jobs and cgroup observations for an
error after Start, a completion clock error and a real changed-journal CAS error.
It also demonstrates that an existing marker plus a refused unit observation
does not prove that the source PID stopped. Its runtime files/unit are cleaned
up; no installed product unit, key or authority is changed. This requires a real
systemd host and noninteractive sudo and does not qualify a production canary:

```sh
cargo test -p hepta-paper-service --lib --locked \
  online_schema_execution::installed_owner::systemd::rollback_refence_tests::actual_pid1_restart_errors_and_clock_or_cas_failure_stop_the_private_writer \
  -- --exact --ignored --test-threads=1
```

The original stopped cgroup remains bound to its held cgroup2 descriptor, inode,
fixed `/sys/fs/cgroup` ancestors and exact kernel descriptor path. A removed
kernfs group may retain its link count; the adapter accepts it only when the
original descriptor resolves to its complete original path plus ` (deleted)`
and that named path is absent. A newly created group at the same path cannot
reuse the original empty witness. JobRemoved streams are asynchronously released
before normal exchange completion. Cancellation shuts down the bounded wire and
drains the same lexical executor for at most five seconds; the descriptor owner
count must still be zero before any kernel work can continue.

After a verified final receipt, `installed_owner::research_view` publishes the
original signed inventory and held original DB/WAL bytes into
`runtimeRoot/online-schema-checkpoints/<transitionHex>`. This fixed historical
namespace stays outside the recursive `autonomous-research` business inventory;
no historical copy is registered as a live business database. The reader comes
from the pinned research supervisor UID/GID/groups, rather than the authority
principal or the caller. Files are root-owned, reader-group `0440`; checkpoint
folders are `0550`, their parent and the final control are `0750`. Only FINAL is
readable there; execution intent, private keys and preimages remain private.

A root-only versioned intent pins the selected original inventory before copies
are published with no-replace operations. Existing intents are opened through
the retained execution directory with no-follow/nonblocking flags, a hard byte
limit and full held/named identity checks before and after reading. Only those
bounded original bytes can become a JSON snapshot. Recovery verifies that original signed
graph and never photographs later business results as its predecessor. The
opt-in `research_view::tests` case executes the real Node signed fixture and an
actual UID/GID 65534 Rust reader. It verifies the full graph, readonly boundaries,
crash recovery, preserved later business results and tamper refusal. Those source
fixtures grant no canary qualification or release/submission authority.

The CLI cases in `tests/schema_source_projection_parity/cli.rs`,
`tests/finalization_publication.rs`, and the finalization-recovery shard exercise
actual Node/Rust entrypoints, complete v1/v2 reports, independent pristine review,
Node and Rust finalized predecessors, invalid modes, pinned-input substitution,
unresolved control-state refusal, late observation drift and process death.
They reuse the original ten-database fixtures; no local test supplies installed
credentials or claims independent live authority.

## Execution and installed acceptance

The local full-scope planner and signed reservation are implemented. The live executor consumes these opaque objects and preserves their subject, source/root pins and fresh lease checks throughout every filesystem and SQLite write; passing a caller Boolean or a detached serialized receipt is insufficient.

The [journal normalization stage](SCHEMA_JOURNAL_NORMALIZATION_HANDOFF.md) and [schema genesis installation](SCHEMA_GENESIS_INSTALLATION_HANDOFF.md) now implement actual ten-database normalization, signed genesis/metadata installation, identity-bound stale-SHM handling, live signed-lease checks, durable per-instance progress and recovery across process death. Recovery compares complete expected and actual SQLite state, recognizes an already-installed target only through current schema, pinned file identity and sidecar checks, and validates `1 <= commitSafetyMarginMs < requiredExecutionWindowMs` like Node. The [finalization and observation contract](SCHEMA_FINALIZATION_OBSERVATION_HANDOFF.md) owns current post-state, durable v1 recovery, and the v2 source-to-target authority handoff. V2 persists the exact target observation before service control is handed out, retries only that request after an unknown reply, and publishes the existing no-clobber `FINAL.json` from exact verified Node-wire bytes after the target authority signs activation. The installed owner above supplies ordinary execution and physical service control. Actual host canary/rollback, independently qualified custody/roles and Node retirement remain separate acceptance work; historical receipt replay/publication grants no release or submission authority.
