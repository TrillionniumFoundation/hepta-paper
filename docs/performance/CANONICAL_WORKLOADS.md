# Canonical workload catalog

The machine workload catalog is `docs/system/truth/canonical-workloads.v1.json`.
Workloads are immutable by ID/version. A semantic change creates a new version.

## Workload families

| ID | Purpose | Core assertions |
|---|---|---|
| PERF-WL-001 | one campaign, 100-node mixed DAG | readiness, critical path, bounded concurrency, deterministic plan |
| PERF-WL-002 | 32 campaigns, 10,000 nodes | scheduler/allocator/state throughput and memory bounds |
| PERF-WL-003 | sustained small GPU jobs plus one large GPU job | aging/reservation prevents starvation |
| PERF-WL-004 | mixed CPU/GPU/memory dominant shares | DRF and weighted fairness |
| PERF-WL-005 | provider quota and worst-case cost exhaustion | no over-admission or unknown-as-zero settlement |
| PERF-WL-006 | broker connection burst/slow clients | bounded queue, busy response, no thread/FD leak |
| PERF-WL-007 | writer commit burst | short transactions, queue bound, idempotency, fsync latency |
| PERF-WL-008 | process and control-plane crash storm | deterministic reconciliation and no duplicate effects |
| PERF-WL-009 | prepared-result replay after restart | no provider rerun; exactly-once commit |
| PERF-WL-010 | module version rolling shadow/canary | compatibility, routing, rollback, no mixed semantics |
| PERF-WL-011 | candidate explosion/adversarial duplicates | byte/count caps and deterministic Pareto reduction |
| PERF-WL-012 | solver timeout/invalid plan | safe deterministic fallback and hard-constraint preservation |
| PERF-WL-013 | snapshot/resource drift during solve | stale plan rejected/replanned before dispatch/commit |
| PERF-WL-014 | target-host storage pressure | disk-full/corruption/reboot recovery; external issue #12 |
| PERF-WL-015 | live author/reviewer provider path | separated credentials, quality/cost; external issue #21 |

## Workload definition

Each record binds:

```text
workloadId and version
purpose and immutable-by-ID/version rule
owner teams and related capabilities/milestones
input determinism class and minimum repetitions
maximum duration
campaign/DAG/candidate/module registry inputs
resource topology and failure schedule
core assertions and zero-tolerance counters
required metrics and evidence tier
implementation-time generator/source digest and fixed seeds
```

## Result envelope

```text
source commit/tree
binary/config/module registry hashes
host/kernel/runtime identities
workload and data hashes
start/end and sample count
raw result artifact hashes
aggregated metrics
zero-tolerance counters
threshold decision
reviewer and expiry
```

## Workload governance

A workload change that makes a regression easier to pass is a policy change and
requires performance plus independent review. Old workload versions remain
verifiable through Git/artifacts but are removed from the active catalog when
superseded.
