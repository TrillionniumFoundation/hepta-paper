# ADR-0009: modules submit Pareto candidates; the control plane selects globally

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

A collection of module-local optima is generally not a global optimum under
shared GPU, memory, provider, cost, deadline, evidence, and authority
constraints.

## Decision

Planning modules return a bounded set of feasible alternatives or a justified
singleton. Candidates declare resources, duration, cost, value, evidence gain,
risk, uncertainty, side-effect class, rollback class, and expiry. The central
planner removes dominated candidates and selects a feasible combination under a
versioned global objective and independently verified hard constraints.

Module utility is predictive, not authoritative evidence. Outcome evaluators
measure actual value, cost, quality, and risk for calibration.

The phrase `model_global_optimum` is permitted only for a fixed hash-bound
snapshot/candidate/constraint/objective subject with a zero solver gap.

## Consequences

Module teams can optimize internals without deciding system priority. Candidate
flooding and hidden cost become protocol violations. Solver certificates and
fallback plans are replayable.

## Adoption gates

`MOD-002`, `SCH-001` through `SCH-006`, canonical counterexamples, and outcome
calibration must pass.
