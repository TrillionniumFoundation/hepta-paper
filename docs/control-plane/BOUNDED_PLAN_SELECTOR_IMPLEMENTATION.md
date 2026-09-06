# Bounded global plan selector implementation contract

## 1. Scope

`paper-application/orchestration/bounded-plan-selector.mjs` is a finite,
deterministic, in-process reference implementation of a hard-constraint global
selection boundary. It consumes one already validated `CandidateFrontierV1` and
one exact `GlobalPlanSelectionRequestV1`.

It does not execute candidates, mutate campaign state, authenticate evidence,
qualify modules, observe ambient prices, issue credentials, or grant provider,
writer, release, submission, or production authority.

## 2. Frozen subject

The selection request must exactly bind:

```text
planningRequestHash
stateSnapshotHash
candidateSetHash
hardConstraintSetHash
objectiveVersion
resourcePriceSnapshotHash
deadline
```

The selector independently revalidates the canonical candidate frontier and its
hash. It rejects an expired frontier, any authority escalation, a forged
candidate payload hash, noncanonical candidate order, or a claim that local
dominance reduction has already been applied.

Every evaluation binds one exact candidate ID and payload hash. Coverage must be
one-to-one. Unknown, duplicate or self dependencies fail before search.

## 3. Hard constraints

The following are feasibility constraints and are never converted into objective
penalties:

- exact required-candidate inclusion;
- maximum selected-candidate count;
- dependency closure;
- at most one selected candidate per non-null mutex group;
- componentwise CPU, GPU, memory, storage, token and maximum-cost limits.

CPU and GPU values from `ActionCandidateV1` are converted to integer
milli-units. Values that are not exactly representable at that precision fail
closed rather than being rounded. Every integer addition is checked against the
JavaScript safe-integer domain.

A feasible incumbent therefore certifies only this finite declared model. It is
not evidence that estimates are calibrated or that physical workers obey the
resource declaration.

## 4. Objective and search

The objective is the exact sum of signed integer `utilityMicrounits` supplied by
trusted objective composition. The selector does not infer utility from the
candidate's advisory `value`, `cost`, or `risk` objects.

Candidates are searched in deterministic utility/identity order. Each search
node has an admissible optimistic upper bound:

```text
current utility + sum of positive utility of all undecided candidates
```

The bound ignores resource, dependency, mutex and cardinality constraints, so it
can overestimate but cannot underestimate the best descendant objective. A node
is pruned only when its upper bound is strictly below a verified incumbent.
Equal-bound branches remain searchable so deterministic lexical tie breaking is
preserved.

No local Pareto or dominance assumption is used. The selector consumes the full
validated frontier.

## 5. Deterministic budget and dispositions

Stopping is controlled by an integer node-expansion budget, not wall-clock time.
The result has one of four dispositions:

- `optimal`: the finite search frontier is exhausted and the selected incumbent
  is globally optimal for the declared model;
- `infeasible`: the finite search frontier is exhausted with no feasible
  incumbent;
- `bounded_feasible`: a feasible incumbent exists but unexplored nodes remain;
- `bounded_no_incumbent`: the budget ended before a feasible incumbent was found.

For a feasible incumbent the result reports a lower bound `L`. Unexplored node
bounds give an upper bound `U`, with `L <= OPT <= U` for the frozen finite model.
The optimality gap is `U-L`. `bounded_no_incumbent` has no lower bound and must
not be relabeled as infeasible. An exhaustive result reports equal lower/upper
bounds for `optimal`, and no numeric objective bounds for `infeasible`.

Tie breaking chooses the lexicographically smallest sorted candidate-ID set among
plans with equal objective value. Candidate IDs cannot contain the separator
used by the comparison.

## 6. Determinism and authority

The selector is pure and synchronous. The explicit integer clock is its only time
observation. It performs no I/O, process, timer, storage, provider, or network
action. Selection output, selected payload identities, resource totals, proof
flags and the complete result are immutable and canonically hashed.

All authority flags are fixed to false. A plan selection is not an execution
command, commit command, qualification receipt, external authorization or
activation decision.

## 7. Verification

`paper-core/tests/bounded-plan-selector.test.mjs` covers:

- exact finite optimum and resource accounting;
- resources as hard constraints rather than penalties;
- dependency closure through negative-utility candidates;
- mutex groups, required candidates and cardinality;
- honest distinction between optimal, infeasible, bounded-feasible and
  bounded-no-incumbent results;
- deterministic tie breaking and evaluation order;
- exact candidate/evaluation/frontier/request binding;
- forged hash and authority/dominance rejection;
- exact CPU/GPU milli-unit conversion and integer overflow;
- immutable non-authorizing output;
- eighty deterministic eight-candidate problems checked against a separate
  exhaustive subset oracle.

The exhaustive oracle is independent test code, not an external solver or target
host qualification. The random workload is deterministic and bounded; it does
not prove correctness for arbitrary implementation changes outside the stated
finite model.

## 8. Remaining work

Before `SCH-001..007`, G6 or a production scheduler can be considered complete,
the project still needs:

- versioned machine schemas for the selection request/result;
- integration with current snapshot, candidate, policy, resource-price and
  qualification producers;
- calibrated objective/evidence inputs and uncertainty semantics;
- production Rust implementation or a reviewed compatibility decision;
- independent feasibility revalidation before execution;
- exact-head and merge qualification plus independent review;
- target-host performance, cancellation and recovery evidence.

This source increment does not alter machine work-item status, module activation,
writer authority or any external gate.
