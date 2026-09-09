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
node --test paper-core/tests/rust-cutover-fence.test.mjs
```

The example executes real Node and Rust queries, verifies byte parity, creates
and restores a SQLite snapshot, commits a canary record, reopens the coordinator,
promotes locally and rolls ownership back while preserving both records. Its
JSON output explicitly states `productionActivation: false` and
`legacySchemaTranslationVerified: false`.

Integration tests additionally kill a child process mid-transition, verify the
previous durable state on restart, and hold a Node process inside an actual
native database write while a concurrent Rust handoff waits. Other tests cover
scope rejection, stale Node/Rust generations, revision conflicts, shadow
mismatches, missing markers, file substitution and the actual native StorePort.
