# Performance, capacity, and SLO qualification

## 1. Scope

Performance is a qualified capability, not an informal benchmark screenshot.
Every claim binds exact source, binary/image, configuration, host, runtime,
workload, data, warm/cold state, measurement tool, and threshold version.

Safety invariants are zero-tolerance gates and are not converted into
availability percentages.

## 2. SLO hierarchy

### Control-plane SLOs

- snapshot construction latency;
- candidate collection latency and timeout rate;
- plan latency P50/P95/P99;
- plan validation latency;
- replan convergence time;
- readiness/recovery time;
- maximum control queue depth.

### Resource SLOs

- CPU/GPU/memory utilization;
- dominant-share fairness;
- large-job maximum wait;
- resource fragmentation;
- reservation leak rate;
- deadline miss rate attributable to allocation;
- provider/token/cost quota accuracy.

### Execution SLOs

- broker admission throughput and busy rate;
- module start latency;
- execution success/timeout/cancel rates;
- prepared-result durability latency;
- process cleanup/reconciliation time;
- module circuit-breaker availability.

### State SLOs

- commit queue latency;
- transaction and fsync latency;
- conflict/stale rejection rate;
- recovery audit time;
- backup/checkpoint duration;
- prepared-result integration throughput.

### Quality and cost SLOs

- predicted versus actual cost and duration calibration;
- evidence/quality gain per unit cost;
- unknown-cost frequency;
- plan objective regret against offline replay where measurable;
- model-global optimality gap on fixed workloads.

## 3. Zero-tolerance counters

The following must remain zero in every workload:

```text
duplicate external effects
stale-generation commits
out-of-plan commits
unreserved resource use
central state writes outside the sequencer
authority or credential boundary violations
historical hash drift
nondeterministic plan hash for deterministic input
accepted invalid/expired module versions
unclassified recovery residue treated as success
```

## 4. Baseline process

1. Freeze source, toolchain, lockfiles, module registry, and configuration.
2. Record host/kernel/CPU/GPU/memory/storage identities.
3. Verify no unrelated workload or thermal/power constraint drift.
4. Run correctness and zero-tolerance gates first.
5. Run cold and warm repetitions with fixed seeds/inputs.
6. Retain raw bounded results and a canonical aggregate.
7. Record confidence intervals and sample count.
8. Obtain independent review of workload applicability.
9. Freeze the first threshold version only after baseline evidence exists.

This document intentionally does not invent numeric thresholds before a
qualified baseline is measured.

## 5. Regression budgets

A change declares one of:

- no expected performance impact;
- module-local performance impact;
- shared control/resource/state impact;
- workload/measurement change;
- intentional regression with approved tradeoff and expiry.

Module-local changes run module and direct-consumer workloads. Changes to
protocol, scheduler, allocator, writer, broker, workspace, or qualification run
the relevant system workloads.

A threshold exception binds owner, reason, exact metrics, expiry, and rollback.

## 6. Capacity model

Capacity planning records:

```text
arrival rates and burst envelopes
service-time distributions
resource vectors
module concurrency and queue caps
provider and cost quotas
writer transaction/fsync capacity
failure/retry amplification
headroom and recovery reserve
```

Capacity claims distinguish steady state, burst, degraded mode, and recovery.
The system reserves headroom for reconciliation and external-authority checks.

## 7. Planner evaluation

For fixed candidate/constraint problems, record:

- feasibility;
- selected objective;
- best bound and gap;
- solve time and memory;
- fallback frequency;
- plan stability under small input changes;
- fairness and deadline outcomes;
- comparison to deterministic baseline and offline optimum.

For uncertain outcomes, record calibration and realized utility without calling
it a proof of real-world global optimality.

## 8. Qualification tiers

| Tier | Establishes |
|---|---|
| source microbenchmark | algorithm/source regression signal only |
| hosted benchmark | repeatable disposable-host behavior |
| target-host benchmark | named deployment-topology capacity/SLO evidence |
| production observation | live bounded behavior under actual workload |

A hosted result cannot establish production storage, GPU tenancy, provider, or
network behavior.

## 9. Machine traceability

The active workload catalog is
[`../system/truth/canonical-workloads.v1.json`](../system/truth/canonical-workloads.v1.json).
Every workload names owner teams, capabilities, milestone gates, metrics,
determinism, repetitions, duration, and zero-tolerance counters. Capability
evidence bindings reciprocally list every related workload. Thresholds and raw
results remain exact-subject artifacts and are not committed as timeless facts.
