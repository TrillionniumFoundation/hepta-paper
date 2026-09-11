# ADR-0010: use hierarchical DRF, aging, and explicit reservations

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

A capacity-only queue can continuously admit small fitting jobs while starving
large GPU or memory requests. Shared capacity also spans campaigns, modules,
providers, tokens, cost, storage, and external-action quotas.

## Decision

The target allocator combines:

- hierarchical accounting across global, tenant, campaign, module, node, and
  child scopes;
- dominant-resource fairness within policy classes;
- bounded aging and deadline boost;
- reservations for scarce or large jobs;
- exact pre-admission and post-settlement accounting;
- explicit overload/backpressure and cancellation dispositions.

Fairness never overrides safety, evidence, authority, or hard budget limits.
Preemption is allowed only before the task's irreversible side-effect boundary.

## Consequences

Resource use becomes auditable and starvation-bounded. Utilization may be lower
than opportunistic greedy packing when a reservation protects a large job; that
cost is measured and governed rather than hidden.

## Adoption gates

`RES-001` through `RES-007` and workloads `PERF-WL-003` to `PERF-WL-005` must
pass on the exact implementation subject.
