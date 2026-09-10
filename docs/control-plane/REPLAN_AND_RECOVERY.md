# Replanning and recovery contract

## 1. Purpose

Replanning replaces a stale or no-longer-feasible future execution plan without
reinterpreting completed work or replaying an uncertain side effect. Recovery
converges durable intent, leases, prepared results, commit state, and external
action journals after interruption.

Neither mechanism grants new authority. Every replacement action must pass the
same capability, qualification, resource, evidence, and external-action gates as
a fresh action.

## 2. Bound state model

Each action attempt is classified at one of the following durable boundaries:

```text
planned
reservation_prepared
reservation_finalized
execution_permit_committed
external_action_started
result_prepared
integration_intent_committed
integrated
terminal
externally_uncertain
quarantined
```

Transitions are monotonic for one attempt identity. A new plan creates a new
plan generation and, when execution is retried, a new attempt identity. A later
generation cannot edit an earlier journal or claim its permit.

## 3. Replanning triggers

A replan is required when any bound input changes before its point of no return,
including:

- DAG, campaign, dependency, policy, or evidence revision;
- capability, credential, provider, model, runtime, dataset, or worker identity;
- resource capacity, quota, reservation, or accounting generation;
- deadline, budget, risk, or canonical workload identity;
- optimizer, scoring, calibration, or fallback version;
- target-host or external qualification status.

Transient delay alone does not authorize a retry after an external action marker
or an uncertain response.

## 4. Safe replacement rules

A planned or reservation-prepared action may be abandoned after its durable
reservation is aborted. A finalized reservation may be replaced only after the
exact fence is released or expires and reconciliation proves that no protected
action began.

An action at or beyond `execution_permit_committed` is not speculatively
re-executed. Recovery first determines whether the operation completed, failed
before action, produced a prepared result, entered integration, or has an
unknown external outcome.

Completed and integrated results remain immutable inputs to later plans. A
replan may schedule compensating or follow-up work, but cannot erase their
lineage.

## 5. Recovery ownership

Recovery is claimed through a renewable lease bound to:

- campaign, node, plan, and attempt identities;
- prior owner and fence generation;
- recovery operation and generation;
- inspected durable snapshot hash;
- claimant principal and process identity;
- issue and expiry times.

Only one claimant may mutate a recovery scope. A stale recovery context cannot
commit after its lease is replaced. Cross-host uncertainty requires the declared
external fencing authority; local process absence is not enough.

## 6. Reconciliation order

Recovery uses the following fixed order:

1. pin and validate runtime roots, databases, journals, and sidecars;
2. verify schema, lineage, self-hashes, and exact object identities;
3. reconcile active writer, deletion, reservation, and execution leases;
4. settle prepared reservations and dispatch permits;
5. inspect provider, worker, container, and external-action outcomes;
6. integrate an already prepared result exactly once when its fence remains valid;
7. finish or roll back local publication intents by identity;
8. mark unresolved outcomes externally uncertain or quarantined;
9. emit a recovery receipt and only then release the recovery lease.

A later step cannot compensate for a failed earlier trust check.

## 7. External and irreversible actions

Before an external effect, durable intent and a single-use permit are committed.
After the action marker, transport loss, timeout, process death, or an ambiguous
response is classified as uncertain. Recovery queries the authoritative remote
system using the exact idempotency identity and verifies any returned receipt.

The system never blindly repeats a provider call, portal mutation, release,
submission, destructive storage operation, or key action. A verified not-found
result may permit a new attempt only when the governing policy requires and a
fresh human or external authorization is supplied.

## 8. Prepared result recovery

A prepared result binds the original action, attempt, lease generation,
execution identity, inputs, outputs, resource observations, and content hashes.
Recovery may integrate it without rerunning the executor only when:

- the campaign and node remain in the compatible state;
- the original attempt and integration fence are live or validly recovered;
- every artifact and receipt is present and untampered;
- no competing result or terminal transition exists;
- current policy explicitly permits integration of that prepared generation.

Any conflict abandons or quarantines the prepared result according to policy; it
does not merge partial outputs.

## 9. Publication and deletion recovery

Filesystem, package, release, retention, and deletion operations use durable
prepare records, descriptor- or inode-bound staging, no-clobber installation,
and postimage validation. Recovery removes or restores only the exact identities
owned by the failed operation.

A concurrent replacement is preserved. Incomplete rollback remains visibly
quarantined. A tombstone, pointer, or receipt is authoritative only after its
bound durable commit and required directory synchronization.

## 10. Deterministic replan output

The replacement plan records:

- superseded plan and triggering generation changes;
- immutable recovery observations and unresolved states;
- actions retained, cancelled, recovered, quarantined, or newly proposed;
- resource refunds and conservative unresolved charges;
- optimizer/fallback identity and new plan certificate;
- rollback and monitoring obligations.

The same canonical recovery snapshot produces the same classification and
replacement-plan content hash.

## 11. Required tests

Tests cover interruption before and after every durable boundary, stale lease
replacement, owner death, restart, concurrent recovery, acknowledgement loss,
prepared-result reuse, integration races, publication/deletion identity swaps,
external not-found and unknown responses, replayed permits, clock rollback,
corrupt journals, and incomplete rollback.

Host qualification covers process and container death, reboot, WAL and sidecar
state, cgroup/resource reconciliation, storage faults, long-running recovery,
and operator rollback. External effects require independent receipts from their
actual authority domains.

## 12. Non-claims

Recovery success is not evidence that an unobserved external effect never
occurred. Replanning is not rollback of committed facts. A local fixture, model
narrative, or self-signed receipt cannot close target-host, provider, release,
storage, portal, submission, key-owner, or external-authority uncertainty.
