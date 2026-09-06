# Bounded planning pipeline

## 1. Purpose

`paper-application/orchestration/bounded-planning-pipeline.mjs` composes the
current pure Node source boundaries in one identity-preserving path:

```text
PlanningStateSnapshotV1
  -> PlanningRequestV1
  -> CandidateFrontierV1
  -> GlobalPlanSelectionRequestV1
  -> BoundedGlobalPlanSelectionV1
  -> BoundedPlanningDecisionV1
```

The pipeline prevents callers from copying or inventing hashes between stages.
It is not a production control-plane service, execution dispatcher, commit
sequencer, module qualifier or authority transfer.

## 2. Derived identities

The caller supplies a snapshot stage, a candidate-request template, candidate
module bindings and candidate records, then a selection-request template.

The candidate template has no `stateSnapshotHash` field. The pipeline inserts the
hash produced by the snapshot builder. The selection template has no planning,
snapshot, frontier, constraint, objective or price hash fields. The pipeline
inserts those identities from the canonical frontier.

Unknown repeated identity fields fail rather than being compared and silently
normalized. Candidate records still carry the snapshot identity required by the
module protocol; the router checks those records against the pipeline-created
planning request. Future producer collection must issue that exact request to
modules rather than asking callers to preconstruct candidates.

## 3. Shared clock and validity interval

One explicit integer clock observation is supplied to all stages. It must be
inside the ECMAScript Date range. No stage reads ambient wall clock.

A planning request and selection request may not outlive the snapshot from which
they were derived. Existing candidate, module-binding and frontier expiry checks
still apply. The resulting decision expires at the earliest snapshot, frontier or
selection deadline.

A valid hash does not renew an expired snapshot. Rebuilding after expiry requires
a new trusted read transaction, new components, new candidates and a new
selection request.

## 4. Result

The immutable `BoundedPlanningDecisionV1` binds:

- observation time;
- snapshot request and state snapshot hashes;
- planning request and candidate set hashes;
- selection request and plan-selection hashes;
- selected candidate IDs or the exact no-incumbent disposition;
- earliest expiry;
- authority flags fixed to false.

The complete snapshot, frontier and selection objects are returned for inspection
and evidence retention. Their own hashes bind their contents. The planning
decision hash commits the stage identities and result disposition; it is not an
execution command or commit authorization.

## 5. Failure semantics

Malformed stage records, accessors, unknown fields, stale candidates, invalid
module bindings, infeasible hard constraints and expired inputs retain the typed
errors of their owning stage. The pipeline does not catch a denial and replace it
with an empty frontier, fallback candidate, weaker snapshot or successful
decision.

`bounded_no_incumbent` and `bounded_feasible` remain incomplete search results.
The pipeline never promotes them to `optimal` or `infeasible`.

## 6. Tests

`paper-core/tests/bounded-planning-pipeline.test.mjs` exercises:

- exact snapshot/frontier/selection identity chaining;
- derived-field injection rejection;
- rejection of a candidate from an earlier snapshot revision;
- snapshot-expiry propagation to both downstream requests;
- explicit optimal empty frontiers;
- preservation of bounded-search dispositions;
- earliest-deadline output;
- malformed/accessor/invalid-clock input;
- decision-hash sensitivity to snapshot, objective and search changes;
- deeply immutable non-authorizing results.

The tests use pure local records. They do not prove an upstream atomic database
snapshot, module qualification, calibrated utility, physical resource
availability or external authority.

## 7. Remaining production work

Before this path can satisfy G3/G6, it still requires:

- a production candidate-producer collection boundary;
- a production composition root sourcing current readonly-store transactions,
  module bindings, policies, prices and calibrated evaluations;
- independent feasibility revalidation before execution;
- production Rust implementation or a reviewed compatibility/retirement plan;
- cancellation, recovery, persistence and target-host performance evidence;
- exact-head/merge qualification and independent review.

No module or work-item status, activation, writer, provider, release or submission
authority is changed by this source increment.
