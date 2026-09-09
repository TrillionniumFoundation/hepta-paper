# ADR-0015: qualify performance with immutable canonical workloads

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

Functional and security tests can remain green while throughput, tail latency,
cost, fairness, recovery time, or resource fragmentation regress enough to make
the system unusable.

## Decision

Maintain versioned canonical workloads covering scale, contention, starvation,
provider quotas, broker bursts, writer pressure, crash recovery, module rollout,
candidate explosion, solver failure, and snapshot drift. Results bind exact
source, binaries, configuration, module registry, host/runtime, workload, raw
artifacts, metrics, and reviewer.

Zero-tolerance correctness/authority counters are separate from statistical SLO
thresholds. Initial thresholds are frozen only after an exact-host baseline.

## Consequences

Performance becomes evidence rather than anecdote. Module-local and system-wide
regression budgets can gate affected changes without requiring the full suite on
every small edit.

## Adoption gates

`PERF-001` through `PERF-003`, exact-host baseline reproducibility, and rollback
from a deliberately regressed challenger must pass.
