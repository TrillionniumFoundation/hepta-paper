# ControlPlaneV1 execution failure disposition

`ControlPlaneV1::run` is the existing consumer of `ResourceAllocatorV1`, the
executor, the sealed prepared-result verifier and the sealed commit sequencer.
Its successful V1 receipt fields, serialization order and receipt hash input are
unchanged. `ControlPlaneV1::new` and `run` retain their signatures.

Before the first call to `ModuleExecutorV1::execute_batch_with_admission`, ordinary validation
and admission errors retain their original error. If admission reserved only a
prefix of the selected plan, those reservations are released before returning.
There has been no executor call through this runtime at that boundary.

Immediately before its first executor call, the owner records the snapshot hash,
plan hash and every selected reservation ID. The record remains set through all
dependency waves, verification, resource reconciliation and finalization. A
returned error after that point becomes `ControlPlaneError::RunRequiresInspection`;
`inspection_required()` borrows a `ControlPlaneRunInspectionV1` with the original
`cause()`, the last `phase()` entered, and those identities. The complete selected
plan remains charged, including later waves that were never dispatched. A
successful prepared result or failed commit does not itself prove that an
executor has settled its physical or external consumption.

The same owner rejects every subsequent `run` with `RunRequiresInspection`
before snapshot validation, sequencer preparation, events, reservations or
executor calls. The inspection record has private fields and no deserialization,
reset or release operation. Its clone is a diagnostic, not a capability. A caller
cannot supply a receipt hash to clear the block. An executor panic is not caught;
if an outer caller catches it, the preinstalled record still blocks this owner
and `cause()` is `None`, since no returned error was observed. Successful completion
clears the record only after atomic finalization returns its original V1 receipt.
No error or phase here asserts that a business transaction committed or did not
commit; the original cause and actual sequencer observations remain available.

This is an in-memory guard on this particular owner. Dropping it, restarting, or
constructing another owner does not persist or reconcile the unknown execution.
There is no automatic restart protection, worker termination, physical resource
containment, durable dispatch journal or mandatory hierarchical admission in this
change. The separate hierarchical allocator and durable resource ledger are not
wired into `ControlPlaneV1`. Future recovery must obtain real terminal and resource
reconciliation evidence before making retained capacity reusable; ordinary
caller-supplied hashes are insufficient. Production qualification remains open.

The additive public diagnostic types are `ControlPlaneRunInspectionV1` and
`ControlPlaneRunFailurePhaseV1` (`Execution` or `Finalization`). The new unit error
preserves `ControlPlaneError: Copy`, but external exhaustive matches must add the
new variant. Callers previously matching a post-dispatch `ExecutionInvalid`,
`VerificationInvalid`, `CommitInvalid` or another original error must now inspect
`inspection_required().cause()` after `RunRequiresInspection`. Pre-dispatch error
ordering and success receipts are unchanged.

The tests in `../tests/runtime_failure.rs` use the real runtime and deterministic
verifier/sequencer. They exercise an actual owned child that writes an execution
marker and remains alive after its executor returns an error; missing and duplicate
results; verifier rejection; an error in a later dependency wave; a partially
reserved plan refused before execution; blocked repeat calls; and successful V1
receipt serialization/hash consistency. The existing commit-failure regression
checks finalization cause and retained charges. Child cleanup in the test is not
presented to the runtime as a reconciliation receipt. These are source fixtures,
not independent worker, restart, Node-parity or production acceptance evidence.

Run from `rust`:

```sh
cargo test -p hepta-control-plane --lib --locked
```


## Existing service executor restart fence

`hepta-paper-service::ServiceExecutorV1` now checks its existing durable
`attempts/*.started` and `attempts/*.prepared` records before every dispatch
batch, under a nonblocking exclusive flock on the existing attempts directory.
It retains that descriptor for the entire dependency wave. All participating
service instances use this same boundary: another plan, campaign or newly
constructed owner cannot bypass an unmatched start left by an earlier owner.
No second journal, recovery cursor or lock file is introduced. Maintenance still
uses the existing state-access guard, which the object store retains.

Admission refuses unknown filenames, non-private/symlink/hard-linked records,
changed bytes/identities, malformed prepared records, mismatching start identities,
and either an unmatched start or an orphan prepared record. Every paired prepared
record must also reference a readable, content-hash-verified service evidence
object with exactly one typed `version: 1` and `requestHash` equal to the start
identity. An unrelated prepared result, including one copied with all its valid
CAS bytes, cannot settle another attempt. Missing/corrupt evidence and duplicate
identity fields refuse admission even when supplied hashes are recomputed.
Producer-specific detail fields remain accepted; this shared binding is not an
independent scientific verifier or a cryptographic producer attestation.

Reads are bounded to 4096 records, 1 MiB per record and 16 MiB aggregate including
captured evidence bytes. Each CAS read retains the existing 16 MiB per-object
bound; the aggregate is checked immediately after capture, so peak capture may
include one final bounded object before refusal. Capacity exhaustion is a refusal,
not truncation or permission to delete history. Artifact payload bytes and full
result semantics still pass the existing exact-request/CAS verifier when consumed
for replay or commit; admission does not rescan all historical artifact payloads. The linked native implementation
digest includes the recovery source, so an older native configuration must be
explicitly rebound rather than silently reinterpreted.

This is a cooperative local service fence, not a replacement for the generic
control-plane inspection guard or a production terminal observer. Old binaries
and direct writers must be drained before enrollment. It never kills a worker,
refunds uncertain resource consumption, deletes an intent, manufactures a
terminal result or grants a writer/cutover capability. Existing prepared-only
reconciliation can integrate a genuinely verified prepared result; a start
without such a result remains blocked pending an independently observed terminal
outcome and an owning reconciliation implementation. Keep the retained state
for inspection rather than removing the start to force another execution.

The additional real SQLite/CAS service regressions live in
`hepta-paper-service/tests/native_business_service/dispatch_recovery.rs`. They
cover a failed start followed by a changed-plan/new-owner attempt, an independent
held directory lock, orphan/corrupt records, unknown residue, unrelated copied
prepared results, missing/corrupt evidence, and self-rehashed invalid/duplicate
request bindings. The different-campaign test retains an intact-evidence positive
control, so denial is not merely an unrelated configuration error. Existing tests
retain the positive native build, exact replay and pre-intent capability denial.

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test native_business_service
```

These source tests do not establish complete autonomous-research orchestration,
installed principal isolation, target-host qualification or Node retirement.

## Per-request admission inside one dependency wave

`ControlPlaneV1::run_with_clock` passes a live admission callback through
`ModuleExecutorV1::execute_batch_with_admission`. It borrows the same run clock
and SQLite commit sequencer as the surrounding wave, and rechecks the current
lease and campaign before each request handoff. A check at wave entry alone
cannot cover later sequential workers after an earlier worker has consumed the
remaining lease interval.

The default adapter invokes legacy executors with singleton batches, in order,
and rejects an incomplete singleton result before invoking the next request.
Batch-aware implementations may override it and preserve concurrency; they must
invoke the callback at every actual handoff, not precheck the whole queue and
later launch work under an old check. The unsealed executor is trusted to honor
this interface. Existing pure test doubles preserve their wave-level recording
and malformed-result fixtures; they launch no deferred or external work.

`ServiceExecutorV1` keeps its existing attempts-directory lock across the entire
wave. After validating that retained guard, it calls the callback before each
`execute_one`, including an exact prepared-result replay. Callback errors retain
the original control error and stop later requests. Completed local prepared
bytes remain in the same CAS/attempt records. The runtime retains all selected
reservations and its existing inspection guard; there is no refund, second
writer, new durable ledger, implicit renewal or fabricated terminal observation.

This boundary is immediately before request handoff, not an atomic kernel
check-and-spawn or a continuously valid permit. I/O inside `execute_one` can
still advance time before a process starts. Already running processes are not
interrupted by this callback. Physical cancellation, installed-process authority
and final resource reconciliation remain separate work. Direct compatibility
calls to `execute_batch` still supply no live observer; the real control-plane
path always uses the admission-aware method.

The existing `tests/runtime_clock.rs` target adds a sequential legacy executor
regression for same-wave success, expiry, rollback and unavailable time, plus a
wrong-singleton-count regression. The service's existing
`tests/native_business_service/dispatch_recovery.rs` target adds actual local
SQLite/CAS cases requiring only one durable start after a denied second handoff,
retained prepared bytes, unchanged expired retry and successful two-request
commit/replay. These are executable regression requirements, not a declaration
that a particular source or target host has already passed them.
