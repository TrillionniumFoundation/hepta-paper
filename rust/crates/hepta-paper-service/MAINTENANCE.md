# Local recovery and maintenance contract

This implementation belongs to `module.rust-control-plane-service`; it introduces
no new global module, status authority or production permission. Three legacy
maintenance modes now have partial local call-chain mappings, not accepted Node
parity. The in-flight `cancel-node` mode remains unmapped in this source tree. Full recovery after ambiguous provider work, permanent retention deletion,
remote cancellation/cost reconciliation and production retirement remain separate.

## Exact source and callable contracts

`src/maintenance.rs` retains V1 byte backup and inventory. Its `recovery.rs` child
implements semantic verification, explicit SQLite quiescence and original-path
no-overwrite restore; its `gc.rs` child implements reviewed-plan quarantine and
resume. `src/workflow/recovery.rs` reuses actual workflow replay, not a duplicate
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
shared access until its exact quarantine transaction is reconciled.

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
files keep the state fenced. No object is permanently deleted, so quarantine does
not reclaim disk space. A reviewed retention/purge protocol and complete external
pin/lease inventory are still needed for general production GC.

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
```

Errors are the existing closed ServiceError/WorkflowError categories; CLI exits
nonzero without echoing private input or parser diagnostics. Tests under
`tests/workflow_extensions` execute real workflows, SQLite event/projection
corruption, actual original-path continuation, no-overwrite refusal, GC move/crash
resumption and actual maintenance CLI commands. Simulated crash residues
are not target-host power-loss/72-hour-soak qualification. There is no source-state,
production, independent-review or Node-retirement promotion from these tests.
