# Native all-database startup reconciliation set

Status: **implemented local evidence, not runtime activation**.

`online_runtime_activation::startup_inventory::reconcile_online_mutation_startup_set_v1`
composes the existing per-database startup reconciler over the ten actual
databases in `ObservedStateDatabaseInventoryV1`. Each database is opened only
through the restricted inventory-bound handle, then the existing signed
unresolved-reservation/recovery/abort state machine runs. The composition
retains every `StartupMutationReconciliationV1` as an opaque value and emits a
hash-bound diagnostic projection with `runtimeReady: false`.

The aggregate requires a closed writer manifest, the real ten-database
inventory, matching authority trust scope and writer hash, and a monotonic
clock. It rechecks every database identity and every confirmation signature on
`assert_current`, including one final in-memory expiry check after all file and
signature I/O. A changed source, parent/file identity, authority configuration,
inventory, signature, or clock causes rejection. No business DML is replayed by
the composition, no active coordinator is constructed, and no activation
receipt is minted.

Each database now captures a bounded exact logical digest before and after the
reconciler, excluding only rows in the durable finalization-receipt table. The
post-state check requires every old receipt row to remain byte-for-byte equal
and every new row to match one recovered reservation, its receipt hash, permit,
timestamp, and finalized global head. A fresh complete inventory is retained
in the opaque proof after all ten databases; parent directories and source
device/inode/mode/link identity remain bound while authorized receipt appends
are allowed to change content hashes.

## Evidence

`tests/online_runtime_startup_set_parity.rs` uses the real ten-database fixture
and a disposable in-memory signed broker. It verifies all ten receipts, exact
Node receipt hashes through `rust/oracle/online-runtime-startup-set-v1.mjs`,
zero unresolved reservations, descriptor-bound currentness, invalid-signature
rejection, source identity drift rejection, and post-window expiry rejection.
`tests/online_runtime_startup_set_nonempty_parity.rs` adds a real signed pending
marker in the resident database, verifies the aggregate finalization append,
and proves a subsequent business-table write invalidates the retained proof.
The module unit tests also reject a changed non-receipt digest and any
unexpected or removed finalization row.

Validation used for this slice:

```text
rustup run 1.98.0 cargo fmt --manifest-path rust/Cargo.toml --all
rustup run 1.98.0 cargo clippy --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --all-features --all-targets --locked -- -D warnings
PATH=../toolchains/node-npm/node_modules/node-linux-x64/bin:$PATH \
  rustup run 1.98.0 cargo test --manifest-path rust/Cargo.toml \
  -p hepta-paper-service --all-features --locked \
  --test online_runtime_startup_set_parity \
  --test online_runtime_startup_set_nonempty_parity -- --nocapture
```

The focused result is **3 passed, 0 failed**; the startup-inventory unit
delta tests add **2 passed**. The Node process is a test oracle only; its
private signing key is created in process memory and no production authority
or credential is used.

## Remaining boundary

This type does not perform the later active-refresh challenge, complete
finalized-head inspection, state-safety composition, evidence-cache write, or
runtime activation constructor. Those steps still require their own opaque
proofs and external authority/target-host qualification. The aggregate is a
real startup-recovery prerequisite, not evidence that Node can be retired.
