# Rust control plane: persistent composition

The crate runs immutable snapshot → bounded plan → resource admission → executor
→ verifier → atomic campaign commit. `ControlPlaneV1<E, V, C>` accepts a real
`ModuleExecutorV1`, a sealed verifier and a sealed commit sequencer. The persistent
implementation is `SqliteCommitSequencerV1`; its store is the existing
`hepta-campaign-writer` SQLite writer. It does not clone database connections to
simulate transaction staging.

This is an executable integration foundation. Persistence and artifact byte
verification do not establish Node business-workflow parity, scientific validity,
provider permission, release qualification or automatic production activation.
`productionActivation` and `automaticActivation` remain false in these receipts.

## Composition API

1. Open `CampaignWriterStoreV1` using the signed `open_for_cutover` API, or the
   explicitly marked `create_local` / `open_local` development APIs.
2. Acquire a fenced `WriterLeaseV1`; create or load the campaign.
3. Construct `SqliteCommitSequencerV1::new(store, writer, campaign_id,
   initial_state_hash, authorized_verifier_hash, now_unix_ms)`.
4. Supply the sequencer, executor, verifier, immutable registry, policies,
   resource allocator and event limits to `ControlPlaneV1::new`.
5. Call `run(snapshot, frontier, tenant_id, now_unix_ms)`.

The store moves into the sequencer and is exclusively owned. `store()` exposes
read/backup operations; `into_store()` consumes the sequencer. `receipt_count()`,
`current_state_hash()` and the trait's `next_sequence()` expose recovered state.
`store().load_control_log(campaign_id)` returns all committed result bodies and
receipts for typed consumers or export.

## Executor and verification boundary

`ModuleExecutorV1::execute_batch` receives admitted `ExecutionRequestV1` objects,
including snapshot, plan, candidate and resource-reservation identities. Every
response must match the exact request attempt ID, candidate hash and plan. Each
dependency wave completes verification before the next wave is dispatched.
Attempt and reservation IDs include the plan hash, preventing reuse across
different plans while preserving retries of the identical plan.

`VerifiedPreparedResultV1` and `CommitRequestV1` cannot be deserialized from an
untrusted wire object. Their private fields are only constructed by the sealed
verification boundary. `DeterministicPreparedResultVerifierV1` checks contracts
for tests/local replay. `FilesystemPreparedResultVerifierV1` also opens private
CAS objects without following leaf symlinks, bounds their sizes, hashes their
actual bytes and checks identity/change metadata. Evidence and all artifact
objects must exist and match their hashes. This is content verification, not a
claim that the artifact's scientific conclusions are correct.

The in-process `artifact_contents_verified` provenance flag is not serialized.
The SQLite sequencer rejects contract-only capabilities on a signed/nonlocal
store. This check supplements the existing signed writer authorization; it does
not replace or issue that authorization. Real external workers still need their
own process containment, durable dispatch journal and ambiguity handling.

## Atomic finalization

`CommitSequencerV1` is sealed and has two relevant operations:

- `preview_batch` verifies the complete batch and computes exact immutable
  receipts without writing storage.
- `commit_batch` applies the same batch atomically; a persistence failure does
  not publish the staged in-memory state.

The runtime first stages resource reconciliation/release, final bounded events,
the resource report, event hash and complete run receipt. Only after every
fallible preparation step succeeds does it call the real `commit_batch` once.
There are no fallible report/event operations after the durable boundary. Thus
an event-budget, resource-reconciliation or encoding error cannot accidentally
leave a successful database commit hidden behind a failed run result.

SQLite commits result JSON, original receipt JSON, campaign cost/revision and
audit event entries in one `BEGIN IMMEDIATE` transaction with WAL and
`synchronous=FULL`. The deterministic fixture's pure transition calculator is
reused to compute receipts; authoritative result storage is the SQLite journal.
See the campaign writer README for exact tables and transaction invariants.

## Snapshot, revision and time bindings

`begin_run` checks campaign identity and advances the lease-check clock before
execution. For a fresh snapshot, its state hash must equal the recovered control
state, and its planning revision must equal `campaigns.revision + 1`. A new
campaign starts at persisted revision zero, so its first planning snapshot is
revision one. Each newly committed result increments the persisted revision.

The caller supplies observed Unix milliseconds; a long-lived caller must advance
that clock for each run. Clock rollback and lease expiry fail closed. A signed
store also requires the run snapshot binding before direct sequencer commits.

An exact historical snapshot can be admitted for replay. At finalization, any
batch containing a new result must still bind the current state and planning
revision. A historical snapshot cannot be used to append extra results. The
separate persisted budget is checked inside the SQLite transaction, so an
optimistic or stale budget in a submitted snapshot cannot overdraw the campaign.

## Restart and idempotency

On construction, the sequencer reads entries in sequence order. It recomputes
every prepared-result hash, verifier receipt and chained committed-state hash;
checks result metadata/cost against the row; compares every stored receipt field;
and verifies the persisted next sequence. Changed initial-state/verifier
bindings, missing/reordered entries or corrupt receipt bodies are rejected.

A retry of the exact result receives its original sequence/state hash with
`newlyCommitted=false`. The stored receipt retains `newlyCommitted=true`, so its
bytes are immutable. A changed result for the same attempt fails the database's
unique attempt identity. Replays never debit budget or add events again.

If the process stops after COMMIT but before returning its run receipt, reopening
and retrying recovers the original commit. The executor must also recover its
prepared output from a durable dispatch/output journal; commit idempotency alone
does not authorize re-executing a provider operation. CAS objects written before
a failed commit can remain unreferenced and are safe to inspect; garbage
collection requires a separate reference-aware policy.

## Validation and errors

From the Rust workspace:

```sh
cargo test --locked -p hepta-control-plane -p hepta-campaign-writer
cargo clippy --locked -p hepta-control-plane -p hepta-campaign-writer --all-targets -- -D warnings
```

The integration tests exercise a complete control run through real SQLite,
idempotent replay, restart, second-item budget failure rolling back the first
insert, changed-result/same-attempt rejection, verifier binding mismatch, stale
snapshot/revision rejection, and expired writer rejection. Writer tests include
an actual child process exiting with an open transaction, WAL recovery,
signed-cutover preservation and backup/restore.

Control errors remain bounded: `SnapshotInvalid` for snapshot/version bindings,
`VerificationInvalid` for rejected prepared capabilities, `CommitInvalid` for
bad sequencing/request contracts and `PersistenceInvalid` for storage, lease,
budget or replay conflicts. The writer's detailed error enum is available for
storage diagnostics. No test result is a production qualification certificate.
