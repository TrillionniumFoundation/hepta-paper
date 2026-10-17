# Local recovery and maintenance contract

This implementation belongs to `module.rust-control-plane-service`; it introduces
no new global module, status authority or production permission. Three legacy
maintenance modes now have partial local call-chain mappings, not accepted Node
parity. The in-flight `cancel-node` mode remains unmapped in this source tree. Full recovery after ambiguous provider work, general production retention,
remote cancellation/cost reconciliation and production retirement remain separate.

## Exact source and callable contracts

`src/maintenance.rs` retains V1 byte backup and inventory. Its `recovery.rs` child
implements semantic verification, explicit SQLite quiescence and original-path
no-overwrite restore; its `gc.rs` child implements reviewed-plan quarantine and
resume. Its `purge.rs` child adds explicit native-local quarantine unlinking;
`reconcile.rs` adds cache-only prepared-result integration with no executor that
can launch a worker. `src/workflow/recovery.rs` reuses actual workflow replay, not a duplicate
pretend workflow. `hepta-campaign-writer/src/local_recovery.rs` independently
checks the immutable SQLite projection against its event payloads and initial
workflow inputs. This source increment does not change process supervision.

The byte, recovery and GC reports are distinct types. A successful
byte report never changes `semanticRecoveryVerified` to true. Every report keeps
production/retirement authority absent; no boolean can activate a deployment.

## Exclusion, filesystem identity and enrollment

Service objects retain shared `state-access-v1.lock` access through clone and
SQLite teardown. Maintenance needs exclusive nonblocking state access and the
existing exclusive `workflow.lock`. Read-only recovery reuses the held exclusive
state guard without creating directories or acquiring a second lock.
Missing, replaced, linked, nonempty, wrongly owned or nonprivate locks fail.

These are cooperative locks. Independently stop/drain old binaries, direct SQL
writers and external file tools before enrollment or immutable reading. They do
not participate in this protocol. No command grants a production writer lease.
`restore-incomplete-v1` blocks normal access. `gc-pending-v1.json` blocks normal
shared access until its exact quarantine transaction is reconciled. A distinct
`purge-pending-v1.json` fences interrupted permanent unlink operations. Explicit
SQLite quiescence refuses both pending markers because their plans bind database
bytes; do not change the database merely to make a pending operation pass.

Roots are canonical absolute private directories. Reads are bounded, no-follow
and nonblocking, with regular-file, owner, mode, link, size, inode/device and
change-timestamp checks. The byte inventory admits only campaign/workflow files,
empty locks, `step-NNNN.json`, flat SHA-256 objects, and exact attempt suffixes
`started` and `prepared`. Unknown files, links,
corrupt CAS hashes and SQLite sidecars are not silently omitted. Limits are
4,096 files, 256 MiB per file, 1 GiB total and a 1 MiB manifest. They are safety
bounds, not measured capacity or SLO values.

## Quiescence and byte backup

`quiesce` is explicit and mutating: under both locks it asks a normal SQLite
connection to checkpoint WAL and transition to DELETE journaling. It checks the
local marker, schema, event chain and SQLite integrity, and requires sidecars to
be removed by SQLite itself. It never manually unlinks WAL/SHM, renews leases or
changes campaign state. A rollback journal is refused. Stop uncooperative writers
first; running `quiesce` without excluding them is not a safety guarantee.

`inspect`, `backup` and immutable verification remain separate operations. The
backup destination must be absent and outside the source under a same-owner
private parent. Exclusive creates, file/directory synchronization and repeated
source/payload inventories precede manifest-last publication. Partial failed
bundles are retained and never adopted. Verify requires a separately retained
SHA-256 of the exact manifest bytes. Hashes copied from an untrusted bundle do
not establish independent authority. Keep all payloads private: workflow and
attempt bytes may contain confidential text or local lease material.

## Immutable semantic recovery

`verify_recovery` / `verify_local_backup_recovery_v1` require a quiesced,
sidecar-free local-only database. The reader uses SQLite `mode=ro&immutable=1`,
checks bytes/identity before and after, and never creates WAL/SHM. An immutable
URI is safe only while every writer is excluded; a URI flag is not a lock.

The supported denominator is one sequential local workflow: exactly one campaign,
one control stream, one writer lease, no node-table work, at most 128 committed
results (64 MiB encoded bodies/receipts) and 4,096 events. Verification replays
creation, control-result, state-transition and amendment events into the actual
revision, state, budget, clock and lease projection; unknown events, wrong writer
generations and foreign campaigns are rejected. It then replays all historical
workflow versions, plans, result/receipt bytes, routing gates and actual artifact
and evidence bytes. Prepared caches and dispatch identities must match committed
history exactly. Missing files, extra/uncommitted plans, unmatched starts and
cancellation residue cause rejection rather than unsafe automatic retry.

`LocalRecoveryReportV1` contains version, definition/inventory hashes, revision,
state, committed/total steps, event count, remaining budget, clock floor,
`historyVerified`, `artifactBytesVerified`, `pendingExecution`, `leaseCurrent`,
`historyAllowsLocalResume`, `productionActivation` and `nodeRetirementVerified`.
The last two remain false. Historical validity does not renew an expired lease.
`historyAllowsLocalResume` describes only history/lifecycle/clock admissibility,
not installed-runtime identity, scientific acceptance, credentials or authority.
Actual execution still passes the normal registry, source and runtime checks.

## Atomic original-path restoration

`restore_local_backup_v1` takes the bundle, ABSENT original destination, ABSENT
same-parent staging path, independent manifest/definition hashes, expected latest
campaign revision and explicit time. It validates the source bundle semantically,
copies exact bytes into a private incomplete-marked staging tree, synchronizes,
verifies that tree while retaining the original logical path, then publishes with
Linux `renameat2(RENAME_NOREPLACE)`. There is no overwrite or unsafe rename fallback.

The source path may be missing; the original path binding inside configuration and
hashes is never rewritten to disguise a different deployment. Existing destination
state always wins: post-backup writes cannot be overwritten. The externally
selected latest revision must equal the recovered revision. That supplied number
is NOT an authenticated external high-water mark; independent custody is required
to know it is latest. The command restores historical bytes, not writer authority,
and must not be used as a production rollback. There is no lease renewal. A crash
before publication leaves the destination absent and retained staging; a crash
after rename but before parent fsync has an ambiguous publication outcome which
must be inspected, not blindly retried. Interrupted staging is not auto-adopted.

## Native-local mark and quarantine

GC requires a quiesced Paused/Completed/Cancelled native-only local workflow,
exact current definition/revision, explicit pins (including an explicit empty
set), and an absent same-parent quarantine destination. Opaque process-worker and
Node-database jobs are refused. Roots include all historical/current definitions,
input-inventory hashes, committed payloads/results/evidence, explicit pins and
conservatively every SHA-256 token in retained object bytes. Over-retention and
cycles are safe leaks, not proof of a minimal live set.

`LocalGcPlanV1` is closed camelCase JSON with version, state/quarantine directories,
definition hash, campaign revision, pins, complete source inventory, selected
quarantine rows, and false production/permanent-deletion flags. The plan hash is
domain-bound and applying it recomputes the exact plan. A stale source, missing pin
or changed selection fails before moving data. `gc-plan` emits `{planHash,plan}`;
store the `plan` member as the input file for `gc-apply`, and retain `planHash`
separately. The wrapper is not the raw plan schema.

The exact plan is synchronized in quarantine and source before any move. Each
object moves with no-overwrite descriptor-relative rename and both directories
are fsynced. A pending marker blocks service use after a crash. `gc-resume` checks
that every original file exists exactly once in source or its selected quarantine,
with exact bytes, and rechecks semantic roots before completing. It publishes a
receipt before removing the pending marker. Duplicate, missing, corrupt or foreign
files keep the state fenced. This quarantine phase never permanently deletes
objects. Permanent removal is a separate explicit native-local operation below,
not a silent extension of `gc-apply`. General production GC still requires a
complete independently controlled external pin/lease/retention inventory.

## Explicit native-local quarantine purge

`plan_purge` / `apply_purge` / `resume_purge` operate only on an already completed
`LocalGcPlanV1`. The source must still exactly match its post-quarantine inventory,
revision and native-only paused/terminal workflow. A changed workflow, resumed
campaign, new object, missing pin or contradictory GC receipt requires a new
reviewed operation; an old plan cannot delete data under a new source subject.
No live CAS, backup, workflow, database or journal file is selected for deletion.

`LocalPurgePolicyV1` is closed camelCase JSON with `notBeforeUnixMs`,
`expiresAtUnixMs`, and an explicit `pins` array (possibly empty). It requires
`0 < notBeforeUnixMs < expiresAtUnixMs <= i64::MAX`. Pins are unioned with the
original GC pins and checked against current semantic roots. For example:

```json
{"notBeforeUnixMs":2000,"expiresAtUnixMs":5000,"pins":[]}
```

These are synthetic local-clock examples, NOT actual custody timestamps or a
production retention policy. The caller-supplied clock and pin list are not
independently authenticated; callers must supply every external pin. V1 deliberately
rejects opaque process-worker state. It is not a general backup-retention service.

`LocalPurgePlanV1` contains version, the `HeptaNativeLocalPurgeV1` kind, the entire
original GC plan and digest, the policy, and false `productionActivation`.
`purge-plan` is read-only and returns `{planHash,plan}`. Store the raw `plan`
member and retain its hash separately; apply checks the complete exact proposal
and time window before creating a new private `purge-v1` journal. Input and
retained manifests are bounded to 1 MiB, and file counts/bytes retain the existing
GC/inventory bounds. Duplicate/noncanonical selected rows are rejected.

The journal retains `plan.json`, an `intents` directory and a final `receipt.json`.
The source pending marker is synchronized before the first unlink. Each object
gets a bounded hash-bound `intents/<object-hash>.json`, synchronized before an
individual descriptor-relative unlink and directory fsync. A missing object
without its exact intent is corruption, not successful deletion. Extra, linked,
replaced or corrupt payloads, an altered marker, or a mismatched journal fail.
The implementation never recursively deletes an operator-selected directory.

A pre-arm crash may resume only an exact plan with an empty intent directory.
After arming, the same plan hash permits recovery before/after individual unlinks.
Expiry denies new unlinks; only an already completed set of unlink intents may
finish publication after expiry. Even a completed replay rejects a clock before
the retention floor. The final receipt is synchronized before clearing the source
fence. Incomplete metadata publication remains an operator-reconciliation blocker,
never permission to bypass missing records or assume a deletion succeeded.

`LocalPurgeReceiptV1` records the plan hash, selected object count, unlinked payload
bytes and unchanged source-inventory hash. `secureErasureVerified`,
`productionActivation` and `nodeRetirementVerified` remain false. Unlink counts
are not measured physical free blocks or secure erasure: the filesystem or another
retained copy can preserve bytes. GC receipts, purge plans and per-object intents
remain retained. Replays return the same receipt without another source mutation.

## Prepared-only local commit reconciliation

`plan_prepared_reconciliation` is read-only and recognizes exactly one next-step
native-business plan with a matching durable `started` record and complete
`prepared` result. It verifies all committed history, the original/amended
configuration, current definition, frozen candidate, plan, attempt, snapshot,
actual payload/artifact/evidence bytes and absence of foreign attempt/plan residue.
Ordinary `recovery-readiness`, backup semantic verification and GC remain strict:
they still reject this uncommitted work until explicit reconciliation succeeds.
A start alone, a malformed cache, opaque process work, or a failed routing gate
cannot fall back to running a worker.

The closed `PreparedReconciliationPlanV1` binds state/definition/inventory hashes,
current revision, next sequence, selected control-plan hash, prepared-result hash,
configuration hash and false production activation. `prepared-plan` emits
`{requestHash,plan}`; apply takes the raw `plan` member and independently retained
request hash. This request hash is domain-separated from the control plan.

`prepared-commit` requires the exact source preimage, Running lifecycle, existing
unexpired lease and a clock no earlier than the frozen dispatch or durable history.
It uses the normal registry, planner, resource admission, sealed artifact-byte
verifier and SQLite commit sequencer. Its private `PreparedOnlyExecutorV1` holds
only the cached result, with no native job, worker table, process handle or provider
interface. There is no cache-miss dispatch path. The existing result/receipt,
revision and accounting transaction performs the sole commit and cost debit.
Quiescence after that transaction is SQLite-owned; leases are never renewed.

A lost-response retry returns the matching durable control receipt with
`newlyCommitted=false`, after history, saved configuration and expected revision
checks, even after lease expiry. It does not reconstruct the old database byte
preimage: `sourcePreimageVerified=false` explicitly describes that replay scope;
only a newly committed operation sets it true. The returned request hash binds
the supplied request, not a separately retained maintenance-authorization ledger.
Both receipts keep `workerExecutionPerformed`, `providerActionPerformed`,
`productionActivation` and `nodeRetirementVerified` false. A successful native
result integration is neither scientific acceptance nor live-provider recovery.
Normal workflow advancement performs any subsequent final lifecycle transition.

## Unresolved execution and cancellation

Between-step workflow cancellation remains the existing lifecycle operation.
This source tree does not add in-flight `cancel-node`, process termination,
budget settlement or remote-effect reconciliation. Unmatched started work and
unknown attempt residue are preserved and reject semantic recovery and GC. A
successful backup is not permission to repeat an ambiguous external action.

## Commands, errors and executable regression

From the root, build/test with the pinned toolchain and unchanged Cargo.lock:

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --bins
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test local_workflow --test local_recovery_gc --test local_maintenance
cargo test --manifest-path rust/Cargo.toml --locked --workspace --all-targets
cargo clippy --manifest-path rust/Cargo.toml --locked --workspace --all-targets -- -D warnings
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
```

```text
hepta-local-maintenance inspect STATE
hepta-local-maintenance quiesce STATE
hepta-local-maintenance backup STATE ABSENT_DESTINATION
hepta-local-maintenance verify BUNDLE EXPECTED_MANIFEST_HASH
hepta-local-maintenance recovery-readiness STATE DEFINITION_HASH NOW
hepta-local-maintenance verify-recovery BUNDLE MANIFEST_HASH DEFINITION_HASH NOW
hepta-local-maintenance restore BUNDLE ORIGINAL_DEST STAGE MANIFEST_HASH DEFINITION_HASH REVISION NOW
hepta-local-maintenance gc-plan STATE DEFINITION_HASH REVISION PINS_JSON QUARANTINE
hepta-local-maintenance gc-apply STATE PLAN_JSON PLAN_HASH
hepta-local-maintenance gc-resume STATE QUARANTINE PLAN_HASH
hepta-local-maintenance purge-plan STATE QUARANTINE GC_HASH POLICY_JSON
hepta-local-maintenance purge-apply STATE PLAN_JSON PURGE_HASH NOW
hepta-local-maintenance purge-resume STATE QUARANTINE PURGE_HASH NOW
hepta-local-maintenance prepared-plan STATE DEFINITION_HASH
hepta-local-maintenance prepared-commit STATE PLAN_JSON REQUEST_HASH NOW
```

Errors are the existing closed ServiceError/WorkflowError categories; CLI exits
nonzero without echoing private input or parser diagnostics. Tests under
`tests/workflow_extensions` execute real workflows, SQLite event/projection
corruption, actual original-path continuation, no-overwrite refusal, GC move/crash
resumption, purge unlink-intent recovery, prepared-cache-only commit/replay and
actual maintenance CLI commands. The purge and reconciliation suites are in
`tests/workflow_extensions/purge.rs` and `reconcile.rs`, imported by
`tests/local_recovery_gc.rs`. Simulated crash residues
are not target-host power-loss/72-hour-soak qualification. There is no source-state,
production, independent-review or Node-retirement promotion from these tests.
