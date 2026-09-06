# Collected bounded planning pipeline

## 1. Purpose

`paper-application/orchestration/collected-bounded-planning-pipeline.mjs`
composes the current pure planning source boundaries without accepting a
caller-assembled candidate frontier:

```text
PlanningStateSnapshotV1
  -> internally derived PlanningRequestV1
  -> complete ModuleCandidateResponseV1 collection
  -> CandidateFrontierV1
  -> internally bound GlobalPlanSelectionRequestV1
  -> BoundedGlobalPlanSelectionV1
  -> VerifiedFeasiblePlanSelectionV1 when an incumbent exists
  -> CollectedBoundedPlanningDecisionV1
```

It remains a non-authorizing Node composition function. It is not a production
service, execution dispatcher, resource reservation, commit sequencer, external
authority or deployment activation.

## 2. Cross-stage identity ownership

The caller supplies:

- exact snapshot request, module bindings and component records;
- a planning-request template without `stateSnapshotHash`;
- exact candidate module bindings and producer planning ports;
- a selection-request template whose evaluations contain candidate IDs,
  utilities, dependencies and mutex groups but no payload hashes;
- one explicit clock and optional cancellation signal.

The pipeline inserts the snapshot hash into the planning request. Candidate
producers receive that exact request. After complete producer collection, the
pipeline inserts each candidate payload hash into its evaluation and inserts all
planning, snapshot, candidate-set, hard-constraint, objective and price hashes
into the selection request.

A caller cannot repeat a derived field and ask the pipeline to compare it. Such
fields are outside the template schemas and fail as unknown input. This prevents
stale or attacker-selected hashes from being normalized into a current request.

## 3. Validity and cancellation

All stages use one explicit Date-valid integer clock. Planning and selection
deadlines cannot exceed the snapshot expiry. Candidate, module-binding, frontier
and producer timeouts remain separately enforced. The decision expires at the
earliest snapshot, frontier or selection deadline.

Outer cancellation is passed to producer collection through a propagation-
resistant subscription. No partial producer result, frontier, plan or decision is
returned after failure, timeout or cancellation.

A timeout rejects the planning operation; it does not prove arbitrary in-process
producer code or a spawned descendant has physically stopped. Candidate producer
ports therefore remain planning-only, non-authorizing ports.

## 4. Selection and independent verification

The selector preserves its four dispositions:

```text
optimal
infeasible
bounded_feasible
bounded_no_incumbent
```

The pipeline does not promote incomplete search. When an incumbent exists, it
runs the independent plan-selection verifier. That verifier recomputes hard
constraints, resource totals and utility. Small frontiers receive independent
exact enumeration; large frontiers receive a conservative independent upper
bound and do not self-accept the selector's optimality claim.

`infeasible` and `bounded_no_incumbent` do not receive a feasible-plan receipt.
Independent infeasibility certification remains a separate source obligation.

## 5. Decision

`CollectedBoundedPlanningDecisionV1` binds:

- snapshot request/state hashes;
- planning request and module-binding-set hashes;
- candidate collection and candidate-set hashes;
- selection request and plan-selection hashes;
- optional verified feasible-selection hash;
- exact source and verification dispositions;
- selected candidate IDs;
- earliest expiry;
- `executionEligible:false`;
- all authority fields fixed to false.

Complete snapshot, planning request, collection, selection request, selection and
optional verifier receipt are returned as immutable inspection data. The decision
hash commits their identities and disposition, not permission to execute.

The closed JSON schema constrains outer disposition and null/array/object shapes.
Cross-object hash equality is not expressible as ordinary JSON Schema and is
therefore recomputed by the runtime boundaries rather than claimed by schema
validation alone.

## 6. Tests

`paper-core/tests/collected-bounded-planning-pipeline.test.mjs` covers:

- a complete snapshot-to-producer-to-selection-to-verifier path;
- payload-hash and stage-identity injection rejection;
- producer failure, timeout, stale candidate and outer cancellation;
- explicit all-empty producer results and optimal empty selection;
- preservation and independent bounding of `bounded_feasible`;
- unknown and duplicate objective evaluations;
- snapshot deadline propagation;
- deeply immutable non-authorizing output.

The broader focused stack also covers candidate routing, snapshot construction,
selector/oracle agreement, independent verification and producer collection.
These are source tests with local ports, not real module qualification or target-
host evidence.

## 7. Remaining work

Before this can satisfy G3/G6 or feed execution, the project still requires:

- atomic snapshot component acquisition from current readonly-store ports;
- production registry-to-qualified-producer resolution;
- calibrated, versioned objective/evidence-gain evaluation rather than caller-
  supplied utility;
- independent infeasibility certification where policy requires it;
- execution-command preparation that revalidates snapshot, module, resource,
  policy and writer generations;
- Rust implementation or reviewed compatibility/retirement decision;
- persistence, cancellation/recovery and target-host performance evidence;
- exact-head/merge qualification and independent review.

No module/work-item state or authority is upgraded by this source increment.
