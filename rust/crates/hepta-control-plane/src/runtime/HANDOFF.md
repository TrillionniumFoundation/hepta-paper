# ControlPlaneV1 execution failure disposition

`ControlPlaneV1::run` is the existing consumer of `ResourceAllocatorV1`, the
executor, the sealed prepared-result verifier and the sealed commit sequencer.
Its successful V1 receipt fields, serialization order and receipt hash input are
unchanged. `ControlPlaneV1::new` and `run` retain their signatures.

Before the first call to `ModuleExecutorV1::execute_batch`, ordinary validation
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
