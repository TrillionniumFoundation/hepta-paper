# Global risk register

The complete machine record is `docs/system/truth/risks.v2.json`. Scores use
likelihood 1–5 and impact 1–5. Score 20 or higher blocks the affected independent
milestone unless the named authority accepts a bounded residual risk with an
expiry. “Mitigated” requires executable negative evidence.

## Architecture, modules, and optimization

| ID | Risk | L | I | State | Owner | Required evidence |
|---|---|---:|---:|---|---|---|
| RR-044 | Node and Rust documents expose competing global truth | 4 | 5 | mitigating | SYS | single global manifest, scoped projections, validator |
| RR-045 | A module bypasses the commit sequencer and writes authoritative state | 3 | 5 | open | CTL/State | reachability gate, capability denial tests, process authority proof |
| RR-046 | Modules expose only local preferred actions and force a globally inferior combination | 4 | 4 | open | SCH/MOD | candidate/Pareto protocol and counterexample workloads |
| RR-047 | A module inflates utility or hides cost/risk | 4 | 4 | open | SCH/Evidence | independent measurement, calibration, confidence and penalty policy |
| RR-048 | Continuous small work starves GPU or large-memory jobs | 5 | 4 | open | RES | DRF, aging, reservation, maximum-wait workload |
| RR-049 | Optimizer timeout, nondeterminism, or infeasibility blocks control progress | 4 | 5 | open | SCH/CTL | deterministic fallback and plan replay corpus |
| RR-050 | Module protocol/version combinations drift beyond tested coverage | 4 | 5 | open | MOD/Protocol | compatibility matrix, N/N-1 gates, rollback test |
| RR-051 | One CODEOWNER remains an organizational serialization point | 5 | 4 | blocked_external | ORG | real team provisioning and denial/approval workflow evidence |
| RR-052 | Functional CI passes while throughput, P99, cost, or fairness regresses | 4 | 4 | open | PERF | canonical workloads and regression budgets |
| RR-053 | Central scheduler or registry becomes a throughput/availability bottleneck | 3 | 5 | open | CTL/SRE | capacity model, bounded failover/recovery, load evidence |
| RR-054 | Module upgrade changes durable state or prepared-result semantics incompatibly | 3 | 5 | open | MOD/State | migration contract, golden replay, rollback version |
| RR-055 | High-cardinality telemetry leaks prompts, manuscripts, paths, or identities | 4 | 5 | open | OBS/Security | schema allowlist, redaction and artifact scans |
| RR-056 | Over-modularization multiplies deployments and operational failure modes | 3 | 4 | controlled | Architecture | module-versus-process decision record and deployment budget |
| RR-057 | Parallel Rust crates retain overlapping canonical responsibility | 4 | 4 | open | Rust Architecture | owner/retirement ADR and dependency reachability tests |
| RR-058 | Planner operates on stale module/resource/campaign state | 4 | 5 | open | CTL/SCH | snapshot hash, expiry, revalidation and commit fence |
| RR-059 | State changes between plan selection and commit | 4 | 5 | open | CTL/State | revision, attempt, reservation and plan-subject CAS |
| RR-060 | Plan certificate overstates global optimality under uncertain real outcomes | 4 | 4 | open | SCH/Evidence | model-relative terminology, bound/gap, post-outcome calibration |
| RR-061 | Module teams optimize private metrics at the expense of scientific/evidence quality | 4 | 5 | open | Product/Evidence | centralized objective governance and independent outcome scoring |
| RR-062 | Candidate explosion makes exact global planning impractical | 4 | 4 | open | SCH/MOD | bounded K, Pareto reduction, decomposition and time budgets |
| RR-063 | Unavailable module prevents all planning despite substitutes | 3 | 4 | open | CTL/MOD | capability substitution policy and degraded-plan tests |
| RR-064 | A fallback schedule is safe but persistently inefficient | 3 | 3 | open | SCH/PERF | fallback SLO, alerting and optimizer recovery policy |

## Documentation and governance

| ID | Risk | L | I | State | Owner | Required evidence |
|---|---|---:|---:|---|---|---|
| RR-065 | Historical status or plan re-enters current search and misleads implementation | 5 | 4 | mitigating | SYS | no history paths, manifest coverage, forbidden-name gate |
| RR-066 | Human projections drift from machine truth | 5 | 4 | mitigating | SYS | generation or semantic comparison in CI |
| RR-067 | New modules or documents are added without owner/reviewer coverage | 4 | 4 | open | ORG/SYS | registry and CODEOWNER consistency validator |
| RR-068 | Large documentation-only changes silently alter qualification subjects | 4 | 5 | open | Qualification | exact subject invalidation and fresh evidence requirement |
| RR-069 | Compatibility forwarding files become a second permanent documentation layer | 3 | 3 | controlled | SYS | explicit projection classification and retirement deadline |

## Retained Rust and production risks

The detailed Rust source and production risk register remains
`docs/rust/RUST_RISK_REGISTER.md`. It covers canonical hash drift, dual writers,
credential leakage, provider ambiguity, process identity, storage corruption,
qualification producer impersonation, stale workflow artifacts, external key
custody, target-host evidence, and release/submission authority.

A global risk may depend on a Rust risk; neither duplicates nor replaces the
other. Closure requires both records to reach an accepted state where relevant.

## Review rule

Every milestone review updates:

```text
state
owner
mitigation/evidence reference
residual likelihood and impact
expiry or next review date
affected capabilities/modules/milestones
```

A risk cannot be marked `accepted` without naming the authority permitted to
accept it. `blocked_external` never means mitigated or qualified.
