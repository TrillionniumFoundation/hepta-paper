# Native observed state database inventory

This slice ports the real local discovery and SQLite inspection performed by
`paper-adapters/automation/autonomous-research-state-database-inventory.mjs`.
It does not turn a serialized inventory, configured authority, or local inspection
into permission to start online writers.

Current integration state: the fourth-wave service module is connected. Public
fixed observations and the internal restricted live-recovery opener consume the
actual opaque inventory. Full runtime activation and production admission remain
separate work; local inventory readiness cannot substitute for either.

## Source and public interface

Implementation lives in `rust/crates/hepta-paper-service/src/state_database_inventory.rs`
and its `files.rs`, `tree.rs`, `snapshot.rs`, and `inspection.rs` children.

- `inspect_state_database_inventory_v1(root, manifest)` resolves the complete
  manifest and returns the actual ready/blocked legacy report.
- `inspect_submission_handoff_inventory_v1(root, manifest)` resolves the original
  handoff-only projection and its distinct manifest hash.
- `observe_state_database_inventory_v1(root, manifest)` performs the same real
  observations and returns `ObservedStateDatabaseInventoryV1` only for a ready
  local report. The type has private fields and no claim/JSON constructor or
  `Deserialize` implementation.
- `value()` exposes the report, `runtime_root()` exposes the observed canonical
  root, and `assert_current()` checks held source files and repeats complete
  actual discovery/inspection against the retained manifest.
- `inspect_database_v1(instance_id)` offers only the fixed quick-check, foreign
  key count, schema hash, user version, and application ID observation. It opens
  a private SQLite copy and never opens the source through SQLite.

The internal fixed `inspect_pending_finalizations_v1` likewise queries only a
private copy and binds the report role/instance to the actual observation.
The restricted startup opener can recheck one still-pinned instance while the
reconciler's authorized changes to earlier instances have made the complete old
inventory stale. This requires a fresh full inventory and stable-scope comparison
after all recoveries; it does not waive the enclosing reconciliation checks.

All operations return the shared `sqlite_mutation_coordinator::Result`.
A blocked opaque construction returns
`autonomous_research_state_database_inventory_blocked` with the actual report in
`details.inventory`. Namespace/file drift, unsafe files, invalid UTF-8, and
resource exhaustion have explicit failure codes. Invalid database inspection is
reported as a blocker in the legacy report and cannot construct the opaque type.

The in-crate `with_database_snapshot` callback is reserved for trusted backup
composition. Its result is arbitrary unauthenticated data. It exposes only a
temporary copy path and closes no caller-owned handles on the caller's behalf;
consumers must finish their SQLite use before returning. No callback value can
construct an observation, authority receipt, or activated coordinator.

## Actual resolution and binding

The resolver validates all ten manifest roles and required online-authority
schema object declarations, resolves singleton and per-paper paths, applies
minimum instance counts, and walks the registered namespace. Unregistered
top-level/autonomous-research SQLite files, tree links, special SQLite files,
missing required files, and invalid retired placeholders block readiness.
Handoff inspection retains the narrower original directory scope.

Each database binds the actual source identity and SHA-256, optional WAL identity
and SHA-256, effective SQLite schema hash and object list, required-object
coverage, integrity result, foreign-key count, and SQLite version/application
pragmas. SHM is pinned and checked although the legacy report does not serialize
it. Empty or zero-header persistent rollback journals are likewise pinned.
Nonzero rollback headers are rejected: the resolver will neither recover the
source nor accept potentially uncommitted pages as current state.

Instance ordering and scope hashes use the actual legacy compatibility engine
and production collation profile. No fixed inventory/scope hash is embedded.
The manifest itself is caller-supplied validated input; upper layers must bind its
hash to their trusted configuration and signed contracts. This observer does not
declare an arbitrary caller-selected manifest to be the production manifest.

## Filesystem and SQLite boundaries

The supported native path profile requires a canonical absolute runtime root
after resolving a relative root against the process working directory. Every
directory component is opened with `openat` and `O_NOFOLLOW`, held, and compared
with its named inode. Source and sidecar files must be regular, single-link files
without world write access; group write access is allowed only for the submission
handoff role. Held files are copied and hashed with positional reads, so repeated
snapshot consumers do not share or exhaust a file offset.

Every SQLite inspection uses a random private directory with mode `0700` and
private files with mode `0600`. The database and WAL are copied from held source
descriptors; the source SHM is never copied. For WAL inspection the snapshot owns
its initially empty SHM inode before SQLite initializes it. Immutable mode is
used when no effective WAL is present. SQLite never opens a mutable source path,
including a `/proc/self/fd` alias: SQLite can canonicalize such aliases back to
ordinary filenames, so they are not treated as descriptor-bound SQLite handles.

The resolver checks source and private DB/WAL identities and bytes before and
after inspection. The private directory's complete metadata snapshot is also
rechecked, detecting a directory swap restored before callback return. Cleanup
removes only the exact private inodes it created. A
replaced foreign entry is retained and the operation fails. Callback failure and
unwinding release owned temporary files. Cleanup is best effort if another actor
has replaced the private namespace; it does not recursively delete unknown
entries to make cleanup appear successful.

Limits are 256 candidate databases, 256 MiB per source/sidecar, 1 GiB aggregate
observed file bytes, 10,000 entries per namespace walk, depth 64, 4,096 required
objects per role, 256 exclusions, and 4,096-byte manifest paths. SQLite inspection
queries are bounded to 100,000 rows, 4 MiB per text cell, and 64 MiB total text per
query. Raw invalid UTF-8 is rejected instead of replaced. A supplementary complete
schema-object query rejects user objects hidden by the original SQL `LIKE`
underscore pattern while retaining the exact legacy schema hash projection.

These are observations over a bounded interval, not a filesystem lease or a
globally atomic transaction across ten databases. Rechecks do not prevent a
writer changing state after the final check or an attacker controlling the whole
process from altering its private state. Upstream activation still requires
actual authority/current-head, startup reconciliation, schema-transition, writer,
restore, and evidence-cache chains. The type grants no write permission.

## Validation

`state_database_inventory/tests.rs` and
`rust/oracle/state-database-inventory-v1.mjs` use isolated real SQLite databases
and invoke the production Node resolver exports under Node 22.23.1 / ICU 78.2 /
CLDR 48. They compare complete reports, hashes, and source byte/identity snapshots.
The eleven test groups cover:

1. All ten database roles and the handoff projection.
2. A held live WAL writer, WAL-only schema/rows, and repeated private snapshots.
3. Eight actual missing/schema/FK/unknown/exclusion mutants.
4. Per-paper Unicode instance ordering and minimum counts.
5. Hard links, links, unsafe permissions, hidden schema, and sparse file limits.
6. Source/root replacement, new databases, and SHM changes after observation.
7. Callback errors and source changes during private inspection.
8. Foreign private-entry preservation, private-directory ABA detection, and
   unwind cleanup.
9. Real directory-count/invalid-filename bounds, manifest and aggregate limits.
10. A killed writer leaving a real pending rollback journal; no source recovery
    occurs, while an ordinary zeroed persistent journal remains supported.
11. Real pending/finalized rows compared against the original Node count query;
    copied readonly inspection and live opening from current instance pins.

The fixture schema objects are synthetic real SQLite objects with the required
names; passing them validates inventory behavior, not production business-schema
semantics or external qualification. Differences deliberately rejected by the
native safety profile are not advertised as successful Node equivalence.

Formal service-target Rust 1.98.0 run: **11 passed, 0 failed**. The restricted live
opening/race target passed **2/2**, and the retained activation-claim parity target
passed **4/4**. Isolated strict production Clippy passed; the integrated
all-target check reported no diagnostics in this slice. The final workspace
gate is recorded when the fourth-wave checkpoint is assembled.


## Fixed native-store transaction observations

The crate-private `native_store_transaction_guard_v1` derives the one
`native-store` instance from the actual retained inventory. It accepts no
caller-selected role, skip instance, alternate manifest or JSON readiness claim.
It first performs full inventory checks and records the complete candidate and
blocker fingerprint, fixed target identity, all directory identities and owners,
and existing sidecar identities. The guard borrows the inventory and all original
file descriptors; dropping the guard cannot close those SQLite descriptors.

Mint the guard **before opening the owning SQLite connection**, including a WAL
connection that has not yet begun a transaction. Full `assert_current`/`resolve`
can open and close additional raw main/WAL/SHM descriptors. On POSIX, closing such
a descriptor can release SQLite's process-wide locks. The inventory must remain
owned until the transaction finishes and the SQLite connection closes. Full
observations resume only after that boundary.

`assert_during_transaction` uses retained descriptors and `read_at` for every
non-target database and its sidecars, named metadata for the target and sidecars,
and directory-only namespace traversal. It never opens/closes a target database
or sidecar, invokes SQLite, or resolves a full inventory. All non-target content,
sidecar membership and complete database candidates/blockers remain unchanged.
The target may change bytes/length/timestamps, but its inode, device, owner,
mode, safe regular-file type and single link cannot change. Only exact SQLite
`-wal`, `-shm` and `-journal` dash siblings are allowed; their owner/device/mode
must remain safe, and once observed their inode is latched for the transaction.
Replacement or disappearance is rejected. The external-cutover dot-suffix marker
is left to its independent concrete binding; this guard never trusts it as
permission or adds an inventory exemption.

This primitive proves local observations only. Fixed operation/plan and actual
changeset checks, original head, runtime origin/generation, independent native
admission and cutover scope must be owned by the upper composition. That owner
must invalidate on failure/panic/commit, close SQLite before dropping inventory,
and obtain a complete new observation for another transaction. Reusing this
guard after sidecar cleanup or as an arbitrary write capability is unsupported.

The targeted suite passes 15 tests (13 scenario tests and two subprocess helper
entrypoints). DELETE, PERSIST, newly created WAL and already existing WAL cases
verify a real separate process receives SQLITE_BUSY throughout guard checks and
guard drop, and acquires the write lock only after commit. Negatives cover
non-target bytes/retained WAL/new sidecars/path and directory replacement,
symlinks/hardlinks, extra database membership/blockers, target mode/identity and
unsafe or replaced/disappearing sidecars. Existing WAL is held by a separate
process while the guard is minted, avoiding unsafe same-process preflight.
Strict service Clippy lib/tests checks pass. No native writer is activated.


The guard additionally exposes its original opaque pre-inventory only inside the
crate and can assert pointer identity against an expected producer. A genuinely
independent observation with an identical report is refused as a replacement;
this prevents retained upper evidence from switching origins mid-connection.
The added origin regression also checks actual independent-process lock retention.


## Original target check before opening the native writer

The fixed guard now provides crate-private `assert_original_target_current_v1`.
It first checks the complete retained transaction namespace, then validates the
original target bytes and original sidecar presence using the observation's
already-held descriptors. It never resolves a fresh inventory or opens/closes a
regular file. This is used after acquiring an external cutover journal lock but
before opening the native-store writer, to bind a previously measured signed
preimage. The ordinary transaction guard intentionally permits target DML; this
separate check does not and must not be used to reject legitimate staged writes.

Three additional real interprocess tests pass: original DELETE target checks
preserve its lock and reject a newly created rollback sidecar; original DELETE
and existing-WAL targets are checked while another actual WAL journal is locked,
then changed target bytes are rejected without releasing that journal lock; a
single-link target replacement by the actual journal inode is rejected while
its independent process lock probe remains busy. The owning composition must
capture every raw file before opening either SQLite connection and keep them
until both connections close, including idle WAL state and failure/unwind.
