# Independent plan selection verification

## 1. Scope

`paper-application/orchestration/plan-selection-verifier.mjs` independently
revalidates one feasible `BoundedGlobalPlanSelectionV1` before any future
execution boundary may consume it.

It does not trust the selector's self-reported feasibility, resource totals,
utility, upper bound or `optimal` label. It also does not execute candidates,
mutate state, authenticate module qualification, calibrate estimates, issue
credentials or grant production authority.

## 2. Exact subject validation

The verifier recaptures and rehashes:

- every canonical `ActionCandidateV1`;
- the complete ordered `CandidateFrontierV1`;
- the exact `GlobalPlanSelectionRequestV1`;
- the complete source selection result.

Request/frontier/selection planning, snapshot, candidate-set, constraint,
objective, price, expansion-budget and payload identities must agree. Unknown
fields, accessors, sparse arrays, forged hashes, expired inputs, authority
escalation, status/proof splicing and local dominance claims fail closed.

Only `optimal` and `bounded_feasible` source results have an incumbent to verify.
`infeasible` and `bounded_no_incumbent` cannot be transformed into an executable
receipt by this function. Independent infeasibility certification remains a
separate proof obligation.

## 3. Independent hard-constraint calculation

The verifier rebuilds the selected set from candidate IDs and payload hashes,
then independently checks:

- exact required-candidate inclusion;
- selected-count limit;
- dependency closure;
- mutex-group exclusivity;
- CPU/GPU milli-units, memory, storage, token and maximum-cost limits;
- exact signed integer utility sum;
- exact componentwise resource totals.

It does not reuse the selector's search traversal or incumbent-accounting result.
A self-consistent, rehashed source result that exceeds a resource ceiling or
misstates utility/resource totals is rejected.

## 4. Independent bounds and exact enumeration

For a frontier at or below the configured exact-enumeration limit, the verifier
enumerates every subset using separate testable code. It applies the same declared
hard constraints and deterministic lexical tie rule. The exact optimum must not
exceed the source upper bound. A source `optimal` claim is accepted only when the
selected identity and utility equal the independent optimum.

The default exact limit is 18 candidates and the hard maximum is 20. This is a
bounded source policy, not a claim that exponential enumeration is suitable for
large production frontiers.

For larger frontiers, the verifier computes the conservative upper bound equal to
the sum of all positive candidate utilities. It can certify the incumbent's
feasibility and provide an independent gap, but it sets
`sourceOptimalityClaimAccepted:false`. The source `optimal` label alone has no
authority.

The verifier also checks source bound arithmetic with safe-integer operations.
An upper bound below the incumbent or exact optimum, an inconsistent gap, or an
integer overflow is rejected rather than rounded.

## 5. Receipt

`VerifiedFeasiblePlanSelectionV1` binds:

- candidate set, selection request and source selection hashes;
- selected candidate IDs and payload hashes;
- independently computed utility and resources;
- independent upper bound and gap;
- whether exact enumeration was performed;
- whether exact optimality was verified;
- whether the source optimality claim was accepted;
- proof flags and authority fields fixed to false.

The receipt is immutable and canonically hashed. It is not an execution command,
reservation, commit certificate, external authorization or production activation.
A later dispatcher must additionally revalidate snapshot freshness, module
qualification, resource reservation, policy and writer generation.

## 6. Tests

`paper-core/tests/plan-selection-verifier.test.mjs` covers:

- exact optimum acceptance;
- bounded incumbent verification and independent exact gap;
- large-frontier feasibility without self-accepted optimality;
- rehashed resource-overcommit, suboptimal-optimal and understated-upper-bound
  attacks;
- no-incumbent/infeasible denial;
- status/proof and selected-hash splicing;
- request/frontier/evaluation identity changes;
- accessor suppression and immutable authority-false output;
- fifty deterministic finite problems cross-checked between selector and the
  verifier's independent exhaustive oracle.

These are source tests over synthetic finite inputs. They do not establish
objective calibration, target-host performance, real module qualification or
production safety.

## 7. Remaining work

Before G6 or execution integration can close, the project still needs:

- a machine schema for this receipt and schema-negative tests;
- independent infeasibility verification where required;
- calibrated and versioned objective/evidence-gain inputs;
- integration into the execution-command preparation boundary;
- production Rust implementation or reviewed compatibility decision;
- current-head/merge qualification and independent review;
- target-host resource, latency, cancellation and recovery evidence.

No work-item status, module activation or authority is upgraded by this source
increment.
