# Session-collected bounded planning pipeline

## 1. Scope

`paper-application/orchestration/session-collected-planning-pipeline.mjs` is the
current highest-level pure Node planning composition. It requires a successfully
closed planning snapshot read session before candidate producers are invoked,
then delegates to the complete producer, selector and independent-verifier path.

It does not execute a candidate, reserve runtime resources, persist a plan, mutate
campaign state, issue credentials, authorize an external effect or grant writer
or production authority.

## 2. Sequence

The sequence is fail-closed:

```text
open synchronous read session
  -> collect all required snapshot components
  -> close session successfully
  -> rebuild and verify the same PlanningStateSnapshotV1
  -> issue exact PlanningRequestV1 to all candidate producers
  -> require complete candidate collection
  -> apply hard-constraint bounded selection
  -> independently verify a feasible incumbent when one exists
  -> emit SessionCollectedBoundedPlanningDecisionV1
```

A read, session-close, producer, selection or verification failure returns no
higher-level decision. Snapshot failure prevents any candidate producer call.

## 3. Double snapshot verification

The session collector returns a `CollectedPlanningStateSnapshotV1`. The wrapper
passes its immutable component records through the existing collected planning
pipeline, which rebuilds the snapshot with the same request, bindings and builder
limits. The state and request hashes must equal the session receipt. A mismatch
fails instead of selecting candidates.

This duplication is an intentional composition check. It does not create atomic
storage semantics; those belong to the supplied readonly session adapter.

## 4. Cancellation

One outer cancellation signal is used by snapshot component reads and candidate
producer collection. Propagation-resistant subscriptions prevent an earlier
ordinary listener from hiding cancellation. Cancellation during snapshot
acquisition closes the accepted session and invokes no candidate producer.
Cancellation after snapshot close rejects producer collection and emits no final
decision.

Cancellation and timeout do not prove arbitrary in-process code physically
stopped. Read and producer ports must remain non-authorizing and separately
reconciled by their adapters.

## 5. Decision

`SessionCollectedBoundedPlanningDecisionV1` binds:

- closed snapshot collection hash;
- snapshot request and state snapshot hashes;
- candidate collection and candidate-set hashes;
- plan-selection and optional independent-verification hashes;
- underlying collected planning decision hash;
- exact selection/verification dispositions and selected IDs;
- earliest expiry;
- `executionEligible:false` and all authority fields false;
- immutable snapshot collection and planning decision objects;
- a canonical top-level decision hash.

The record is evidence of source-level composition only. A verified finite optimum
is not an execution command or production authorization.

## 6. Tests

`paper-core/tests/session-collected-planning-pipeline.test.mjs` covers:

- successful close-before-producer ordering;
- exact snapshot identity observed by the producer;
- read and close failure with zero producer calls;
- binding of snapshot and planning decision hashes;
- all-empty exact plan and bounded-feasible preservation;
- cancellation during snapshot and producer phases;
- accessor rejection before port open;
- deep immutability and authority-false output.

The schema test validates a real produced decision and rejects execution,
authority, disposition and nested-null splicing. Cross-object hash equality is
verified by runtime reconstruction, not claimed by JSON Schema.

## 7. Remaining work

This source composition still requires:

- a real atomic readonly-store session adapter and target-host evidence;
- registry-to-qualified module and producer resolution with revocation;
- calibrated objective/evidence evaluation;
- independent infeasibility proof where required;
- an execution-command preparation boundary that rechecks current generations;
- persistent Rust control-plane integration and recovery;
- exact-head/merge qualification and independent review.

No module/work-item state or production authority is upgraded here.
