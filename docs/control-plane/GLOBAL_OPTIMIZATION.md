# Global optimization contract

## 1. Purpose and authority

The global optimizer converts one immutable scheduling snapshot into a bounded set
of admissible execution plans. It is a planning component only. It does not own
campaign state, allocate resources, dispatch work, commit results, issue external
action permits, or activate production authority.

The commit sequencer remains the only central state writer. Resource admission,
execution, evidence promotion, release, and submission each retain their own
independent gates.

## 2. Immutable input snapshot

Every optimization request binds the following values before candidate
generation:

- plan schema and optimizer implementation versions;
- campaign, DAG, node, attempt, and dependency revisions;
- ready-node set and terminal-node projection;
- resource capacities, reservations, leases, quotas, and accounting generation;
- worker, provider, runtime, dataset, model, and capability identities;
- policy, evidence, qualification, deadline, cost, and risk constraints;
- canonical workload and calibration identities;
- deterministic clock and randomness inputs when a model requires them.

The optimizer rejects missing, duplicated, stale, non-finite, out-of-range, or
internally inconsistent input. It never repairs authoritative state while
planning.

## 3. Candidate generation

Candidate producers are registered by versioned capability and return immutable
`ActionCandidate` records. A candidate includes:

- exact node and operation identity;
- required capabilities and evidence tier;
- resource vector and reservation horizon;
- expected utility, latency, cost, reliability, and risk estimates;
- hard constraints and declared model uncertainty;
- deterministic provenance and content hash.

Unknown fields, implicit defaults, ambient provider selection, and unbounded
candidate counts fail closed. Candidate generation cannot call providers or
perform filesystem, database, portal, release, or submission mutation.

## 4. Feasibility and dominance

A candidate is feasible only when every hard policy, dependency, capability,
qualification, deadline, budget, isolation, and resource constraint is
satisfied against the same snapshot. Feasibility is checked before scoring.

The Pareto frontier is computed over the declared objective dimensions. A
candidate is dominated only when another feasible candidate is no worse in all
comparable dimensions and strictly better in at least one. Missing or
incomparable dimensions cannot be silently treated as zero.

## 5. Global objective

The global objective is lexicographic and policy-bounded:

1. preserve safety, authority, evidence, and hard deadline invariants;
2. avoid starvation and quota violation;
3. maximize completed admissible value under capacity;
4. minimize expected deadline loss and recovery exposure;
5. minimize bounded cost and resource fragmentation;
6. prefer simpler, better-calibrated plans when all preceding dimensions tie.

Weights and normalization ranges are versioned machine inputs. A model may not
convert a hard constraint into a soft penalty.

## 6. Determinism and tie breaking

For one canonical snapshot and optimizer version, candidate ordering, frontier
construction, scoring, and the selected plan are deterministic. Final ties are
resolved by the canonical tuple:

```text
policy priority
campaign fairness rank
node topological rank
candidate semantic hash
```

Wall-clock observation order, map iteration order, process identity, and random
UUIDs are not tie breakers.

## 7. Plan certificate

The optimizer emits a non-authorizing plan certificate containing:

- complete input snapshot hash;
- optimizer and model identities;
- candidate-set and feasible-frontier hashes;
- selected actions in deterministic order;
- rejected-candidate reason codes;
- objective values and constraint margins;
- resource demand submitted for admission;
- fallback mode and calibration status;
- certificate self-hash.

The scheduler, resource allocator, and commit sequencer independently revalidate
the fields they consume. A certificate grants no lease or side-effect permit.

## 8. Bounded fallback

Fallback is selected when the optimizer times out, exceeds a declared resource
limit, encounters unsupported model input, or fails certificate validation. The
fallback is deterministic, capacity-safe, and policy-preserving. It may reduce
throughput but may not weaken authority, evidence, isolation, budget, or deadline
checks.

Fallback ordering uses the same fairness and topological ranks as the primary
optimizer. A fallback result is explicitly labelled and recorded for later
calibration; it is never represented as globally optimal.

## 9. Replanning boundary

A plan is invalid after any bound input generation changes. Dispatch therefore
performs a fresh snapshot comparison before resource reservation and again
before consuming a side-effect permit. Replanning creates a new plan identity;
it cannot mutate or reinterpret an old certificate.

Completed, integrating, externally uncertain, or otherwise point-of-no-return
operations are fenced from speculative replacement. Their recovery path is
defined by the replan and recovery contract.

## 10. Required tests and evidence

Source qualification covers:

- deterministic replay and canonical serialization;
- infeasible and dominated candidate rejection;
- non-finite, overflow, missing-dimension, and adversarial weight inputs;
- tie-order and map-order independence;
- hard-constraint preservation under primary and fallback modes;
- stale-snapshot rejection at reservation and dispatch boundaries;
- bounded candidate, memory, and runtime limits;
- certificate tamper and partial-plan rejection.

Target-host qualification additionally measures canonical workloads, scheduler
overhead, starvation bounds, deadline behaviour, fallback frequency, and model
calibration. These measurements do not by themselves authorize activation.

## 11. Non-claims

A feasible plan is not proof of global mathematical optimality. A local or
hosted benchmark is not production qualification. An optimizer certificate is
not a resource lease, commit decision, external-action permit, release receipt,
or submission receipt.
