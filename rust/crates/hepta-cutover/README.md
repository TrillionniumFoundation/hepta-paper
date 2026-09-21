# Durable cutover coordinator

`DurableCutoverCoordinatorV1` coordinates participating Node and Rust writers
through a SQLite journal independent of either application database schema. It
supplements existing external mutation authorization; holding this fence does
not authorize a provider action, qualify scientific evidence, or translate the
legacy native database into the Rust campaign writer's HPCW format.

## Enrollment and identity

Call `create` only while all old writer processes are stopped and drained under
the existing maintenance boundary. A callback that started before enrollment
cannot retroactively acquire the new fence. Restart participating Node writers
after enrollment. Subsequent handoffs need no process race assumptions: every
participating mutation holds the coordinator transaction throughout its commit.

An existing absolute canonical database is required. Enrollment creates two
non-overwritable files:

- `<database>.rust-cutover.sqlite`: FULL-synchronous WAL journal and state row.
- `<database>.rust-cutover.enrolled.json`: target path plus target and journal
  device/inode identities. Node notices enrollment before each mutation.

Missing, replaced, symlinked or corrupt enrollment files reject writes. The
marker survives journal deletion, including for newly opened Node stores.
Existing store instances also remember observed identities. Removing both
enrollment artifacts is an out-of-protocol administrative action and is not a
supported rollback procedure. Application and enrollment files require the same
trusted filesystem administration as the existing SQLite stores.

A crash during first enrollment can leave an unpublished enrollment; writers
fail closed. An operator must inspect and complete/recreate that initial
enrollment while the maintenance boundary is still held. The API does not guess
the authority or target identity from partial initialization.

## Fresh external storage V2

`create_with_storage_v2(..., DurableCutoverStorageV2::ExternalRoot { root })`
enrolls a previously unenrolled database with its coordinator journal outside the
business database tree. `AdjacentSidecars` delegates to the incumbent `create`;
the V1 default layout, final enrollment JSON, journal schema and writer epochs
remain unchanged. Marker reads reject oversized, nonregular, symlinked or
hardlinked inputs before opening their bytes.

The external root must already be an absolute canonical directory owned by the
effective user, with mode `0700`, disjoint from the application database's parent
directory in both directions. Root and per-database slot directory handles are
retained. The application database must be a canonical, owned, single-link
regular file without group/other write permission. Marker and journal files
must be owned single-link regular files with mode `0600`.

The fixed adjacent `<database>.rust-cutover.enrolled.json` remains mandatory.
It prevents an older Node writer from interpreting external enrollment as an
unenrolled database. Its strict V2 wire fields are:

```json
{
  "version": 2,
  "kind": "HeptaDurableCutoverExternalEnrollment",
  "databasePath": "/runtime/hepta-paper.sqlite",
  "databaseIdentity": "device:inode",
  "storageRoot": "/private-coordinators",
  "storageRootIdentity": "device:inode",
  "storageSlot": "lowercase-sha256-hex",
  "storageSlotIdentity": "device:inode",
  "journalIdentity": "device:inode",
  "markerIdentity": "device:inode"
}
```

`storageSlot` is SHA-256 hex over UTF-8 JSON encoding of
`["HeptaDurableCutoverExternalStorageV2", databasePath, databaseIdentity]`.
The only journal path is `<storageRoot>/<storageSlot>/journal.sqlite`; neither
reader accepts an arbitrary journal path. Identities use exact decimal device
and inode values, including BigInt filesystem statistics in Node. The marker
also retains an exact byte hash; it is local coordination evidence, not a
signature or production authorization.

Rust `open(database)` and Node `createRustCutoverFence({dbPath})` dispatch solely
from that adjacent marker. Existing V1 clients reject V2 before invoking a
writer callback. Rust `open_with_expected_external_storage_v2(database, root,
optional_marker_hash)` and Node's optional `expectedStorageRoot` /
`expectedEnrollmentHash` only constrain the existing marker selection; they
never redirect it or fall back to another root. Rust exposes the diagnostic pin
through `external_storage_enrollment_hash_v2()`.

Creation exclusively reserves the adjacent marker with an unusable
`HeptaDurableCutoverEnrollmentPending` record before creating the external slot
or journal. It commits the original journal/state schema, syncs the containing
directories, then writes and syncs the final marker through the same inode.
Incomplete, truncated or pending markers always deny writes. Any existing
marker, deterministic slot, legacy adjacent journal or its WAL/SHM/journal
remnants rejects fresh enrollment. Mixed layouts also reject subsequent opens
and writes. A failed enrollment leaves its evidence in place: no API removes,
migrates, replaces, retries over or guesses the authority of those artifacts.
Recovery requires operator inspection under the existing stopped/drained
maintenance boundary. Moving an existing V1 enrollment, especially an active
production epoch, is a separate unimplemented migration protocol.

V2 checks the exact coordinator schema and retained namespace identities before
use and again after acquiring the writer/transition lock. SQLite owns all
database handles. Identity probes must **never open and close raw descriptors
for the target, coordinator journal, WAL or SHM**: POSIX descriptor close can
release another connection's process-wide advisory locks. Only directories and
the JSON marker retain auxiliary descriptors. File namespace observations are
not a VFS-level atomic defense against hostile administrative renames.

This storage extension leaves the original ten-database inventory and its
hashes unchanged. It supplies a shared Node/Rust coordination location only;
native executable provenance, signed writer/epoch/scope admission and the
transaction-aware online scope are still separate prerequisites for a writable
native production composition.

## State and transitions

| Operation | Required state | Writer after operation | Evidence |
|---|---|---|---|
| `create` | No enrollment | Node, epoch 1 | Nonproduction enrollment record |
| `quiesce` | Planned | None; epoch advances | All participating writes drained by coordinator lock |
| `backup_restore_drill` | Quiesced | None | SQLite `VACUUM INTO`, restored-file integrity, exact copied digest |
| `compare_shadow` | Backed up or shadow verified | None | Exact executed output bytes, hashes, explicit mismatch count |
| `start_local_canary` | Passing shadow, local mode | Rust; new epoch | Explicit allowed campaign scopes |
| `start_production_canary` | Passing shadow, production mode | Rust; new epoch | Existing Ed25519 authorization and exact database preimage |
| `promote_local` | Local canary | Rust | Local promotion, production flag remains false |
| `rollback_local` | Any progressed local state | Node; new epoch | Ownership-only rollback, committed files preserved |

Every transition takes `expected_revision`; a stale revision fails without
changing state or journal. Every entry includes event, measured evidence, full
resulting state, previous digest and domain-separated SHA-256 digest. The
entry and current state commit in the same SQLite transaction. Updates and
deletes of journal entries are blocked by triggers. `open` verifies the complete
chain and its equality to the current state; it does not treat hashes as digital
signatures or independent authority.

Before either runtime's callback can run, its reader compares current state with
the latest journal revision and exact serialized state, recomputes the same
domain-separated entry hash, and checks the previous-entry link. Rust performs
this check inside every state load, including an already-open coordinator's
mutations and transitions; one SQL snapshot binds the state and journal rows.
A state-only ownership edit cannot re-enable Node or enlarge an active Rust
canary scope while the journal still records the prior authority boundary.

If a crash interrupts backup creation before its journal transition commits,
the earlier cutover state remains authoritative. Partial backup/restore output
files are not adopted automatically; inspect them and retry with new output
paths. Existing output files are never overwritten or confused with committed
backup evidence.

At least one actual shadow comparison is required; any recorded mismatch blocks
promotion for that enrollment. Comparison receipts always carry
`productionQualification: false`. A caller must execute both implementations;
the comparison method does not assert the provenance of caller-supplied bytes.

## Mutation boundaries and generations

Rust uses `with_writer(&WriterFenceV1, scope, callback)`. Node uses
`createRustCutoverFence({dbPath}).withWrite(callback)`, integrated into the native
SQLite StorePort's open, query, run, execute, transaction, online mutation,
recovery and checkpoint paths. The complete synchronous callback executes under
the same coordinator `BEGIN IMMEDIATE` lock used for handoff. The lock order is
coordinator then application database. Never acquire them in reverse order.

`with_writer_state_v1(&lease, scope, |state| ...)` additionally passes the actual
durable state loaded under that same held journal lock. `with_writer` delegates
to it and preserves its previous behavior. All storage, lease, scope and phase
checks still precede the callback. Native admission can use this callback to
require Production/Canary, the exact new writer and reconciliation scope, and
the independently verified authorization hash without checking an unlocked
snapshot. The base protocol still permits Planned and RolledBack writers;
receiving or cloning its state does not grant production qualification. An
error or unwind releases the coordinator lock; it cannot undo an application
transaction that the callback has already committed. The focused
`writer_state_callback` tests cover current peer-updated state, rejection before
callback entry, and real cross-process writer exclusion for both storage layouts.

External V2 callers can use `with_writer_state_and_external_storage_v2` to receive
the same locked state plus an opaque callback-local storage observation. Its
`assert_current()` rechecks the retained root, slot and marker, journal schema
and exact locked state through the original pins and SQLite connection. It never
reopens a replacement marker or database file. The canonical root and immutable
enrollment digest getters are diagnostic bindings, not authorization. This API
rejects V1 enrollment and leaves the existing callback APIs unchanged. Storage
is checked before and after the callback; the caller must also check it at each
required precommit boundary. A later failure cannot undo an already committed
business transaction, and an application error is preserved. The observation
owns no file handles and cannot escape the journal lock. The focused
`external_storage_observation` tests exercise DELETE and existing WAL with real
cross-process lock probes, marker/database aliases, root and slot replacement,
postcommit failure, and unwinding. These checks provide no native qualification
or VFS-level protection against hostile administrative changes.

`with_production_shadow_observation_v2` provides the same retained storage
observation for a production `ShadowVerified` enrollment whose writer remains
disabled, with no canary scope or activation receipt and no shadow mismatch.
It takes no writer lease and writes no journal state. This permits a separate
signer diagnostic to derive a proposed Canary subject from the actual locked
state; the observation itself grants no writer permission or production
qualification. Full filesystem captures must finish before opening the
coordinator, since its idle WAL connection can also retain SQLite locks. The
callback and all rejection paths use retained checks, and the coordinator must
close before those captured files are dropped. Existing activation APIs and
their independent authorization requirements remain unchanged.

The fence compares writer ID, generation and token. Tokens identify epochs;
they are not bearer credentials. A Node process remembers the first accepted
epoch and cannot automatically adopt a rollback epoch. Restarting Node after
rollback acquires the new current epoch. Canary writes additionally require an
exact scope from the allowlist; Node remains fenced globally during canary.

Coordinator state does not change during application callbacks; releasing its
read-only transaction does not create a second commit record. A process crash
releases the SQLite lock. Recovery must consult the application database's own
durable commit journal for the outcome of an interrupted callback; this protocol
does not claim distributed atomicity between databases.

Read-only Node stores remain usable throughout. A read-write Node StorePort is
fenced even through its `query` API because SQL can write via `RETURNING`.
Callbacks must be synchronous; promises are rejected.

## Production boundary and rollback limits

Production canary verifies `WriterCutoverAuthorizationV1` using the existing
`verify_writer_cutover_authorization_v1`, trusted Ed25519 keys, exact runtime
subject and current time. It binds the cutover ID and current sidecar-free
database preimage. It does not create signing keys or self-sign activation.
The downstream campaign writer still independently checks its signed initial
writer lease and schema. `production_activation` records that this writer
handoff was authorized; it is not proof of whole-product compatibility.

No local-drill method can activate a production enrollment. Production expansion
and production rollback are intentionally absent until their external authority
and reverse-schema compatibility contracts are supplied. A schema-changing Rust
service cannot safely be rolled back simply by restoring an old backup: that
would erase committed records. Local rollback changes only writer epoch and
ownership; it never replaces live database bytes.

The legacy `CutoverStateV1` remains an in-memory evidence-shape helper. Its hash
fields alone must not authorize runtime writes; use the durable coordinator and
existing signed authority instead.

## Execution and validation

From the repository root, run a disposable end-to-end drill (directory must not already exist):

```sh
cargo run --manifest-path rust/Cargo.toml --offline -p hepta-cutover --example local_cutover_drill -- /tmp/hepta-cutover-demo
cargo test --manifest-path rust/Cargo.toml --offline -p hepta-cutover
node --test paper-core/tests/rust-cutover-fence.test.mjs paper-core/tests/rust-cutover-external-storage.test.mjs
```

The example executes real Node and Rust queries, verifies byte parity, creates
and restores a SQLite snapshot, commits a canary record, reopens the coordinator,
promotes locally and rolls ownership back while preserving both records. Its
JSON output explicitly states `productionActivation: false` and
`legacySchemaTranslationVerified: false`.

The native retirement boundary is the separate
`hepta-paper-rust retirement-drill-attest REQUEST` command documented in
[`docs/modules/RETIREMENT_DRILL_ATTEST_HANDOFF.md`](../../../docs/modules/RETIREMENT_DRILL_ATTEST_HANDOFF.md).
It is read-only and always fail-closed until external Node replay, release
signing, publication, and independent retirement evidence are supplied.

Integration tests additionally kill a child process mid-transition, verify the
previous durable state on restart, and hold a Node process inside an actual
native database write while a concurrent Rust handoff waits. Other tests cover
scope rejection, stale Node/Rust generations, revision conflicts, shadow
mismatches, missing markers, file substitution and the actual native StorePort.

The external-storage suite uses the qualified Node 22.23.1 / ICU 78.2 / CLDR
48.0 profile. Its six Rust cases cover fresh/V1 interoperability, exact original
ten-database inventory equality, refused duplicate/mixed/pending enrollment,
identity/schema substitution, and actual interprocess writer exclusion. Both
Node and Rust lock tests open and drop a second observer in the same process
while the first writer transaction remains active. The Node tests additionally
exercise the preserved V1 reader fixture, expected root/hash mismatches,
hardlinked markers, generation changes and callback error unwinding. The V1
fixture at `rust/oracle/fixtures/rust-cutover-fence-v1.mjs` is the exact previous
module (SHA-256 `779b14deb75e9b4fbb5cc6121b32b86045118573d7df2ff98f1e88b44201541a`).
