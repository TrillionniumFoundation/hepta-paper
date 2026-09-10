# Scheduler state machine

## 1. Planning cycle states

```text
idle
  -> snapshotting
  -> collecting_candidates
  -> validating_candidates
  -> solving
  -> validating_plan
  -> reserving
  -> dispatching
  -> observing
  -> settling
  -> idle
```

Exceptional states:

```text
replan_required
fallback_planning
blocked_infrastructure
blocked_policy
blocked_no_feasible_plan
reconciling
stopping
```

Every state transition records a bounded reason and subject hash.

## 2. Snapshotting

The scheduler reads campaign projections, module registry, resource state,
qualification, policy, budgets, deadlines, and outstanding operations into one
canonical `PlanningSnapshotV1`.

A snapshot has an expiry and monotonic generation. A partial read is rejected.

## 3. Candidate collection

Candidate requests are concurrent but bounded by:

- per-module and global inflight limits;
- request deadline;
- response byte/count limits;
- circuit breaker;
- capability substitution policy;
- snapshot expiry.

Timeout/unavailability is a classified module outcome. It may reduce the
feasible set but cannot relax hard constraints.

## 4. Solving and fallback

The selected optimizer receives only validated canonical candidates. It returns
one plan or an infeasibility certificate.

Fallback occurs for timeout, crash, invalid output, nondeterminism, unavailable
solver, or configured safety mode. The fallback planner uses the same snapshot
and candidate set and emits its own plan hash and reason.

## 5. Reservation

Before dispatch, the scheduler atomically or transactionally reserves:

- resource vector;
- provider/action/cost ceilings;
- campaign/node claim;
- module execution capacity;
- applicable workspace/CAS capacity.

Failure to reserve invalidates the selected plan portion and triggers bounded
replanning. The scheduler does not spin indefinitely on a stale plan.

## 6. Dispatch

Dispatch commands bind the plan and reservation. A module acknowledgement
records accepted, existing, busy, rejected, or unavailable. A busy response
contains bounded retry guidance; the scheduler may replan rather than preserve
head-of-line blocking.

## 7. Observation

Progress does not alter authoritative state. Terminal/prepared observations are
verified and submitted to settlement/commit.

A module heartbeat cannot extend campaign, resource, or authority leases beyond
the central policy.

## 8. Replanning conditions

`replan_required` is set by:

- snapshot generation change;
- reservation failure/loss;
- module health, version, or qualification change;
- policy/objective update;
- candidate expiry;
- new prepared/terminal result;
- operator pause/cancel/priority change;
- deadline threshold;
- detected prediction drift.

In-flight work is retained, cancelled, or reconciled according to side-effect
class. Replanning does not duplicate it.

## 9. Shutdown

Graceful shutdown:

1. stops new snapshot/candidate cycles;
2. stops dispatch;
3. cancels safely preemptible work;
4. persists scheduler and reservation dispositions;
5. waits a bounded period for acknowledgements;
6. leaves ambiguous external work for startup reconciliation;
7. releases the control-plane lease only after durable state is current.

Forced death is recovered from the same durable facts; process absence is not a
success signal.
