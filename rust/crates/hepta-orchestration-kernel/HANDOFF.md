# Orchestration kernel development handoff

This crate implements six deterministic Rust library contracts. Its public
re-export at `hepta_control_plane::orchestration_kernel` is an API path; it does
not select these implementations for the existing scheduler or replace a Node
command. The current direct callers are the crate's unit tests and
[`tests/source_closure.rs`](tests/source_closure.rs). No constructor in this
crate authenticates a caller, captures a database transaction, runs a workload,
opens credentials or performs an external action.

## Implementation selection and compatibility

| Responsibility | Additive Rust API | Existing boundary that remains separate |
|---|---|---|
| Snapshot | `build_planning_snapshot_v1` in [`snapshot.rs`](src/snapshot.rs) | Node `planning-snapshot-builder.mjs` and the control-plane snapshot model have their own fields, schemas and currentness rules. |
| Routing | `route_candidate_v1` in [`router.rs`](src/router.rs) | Node `routeActionCandidatesV1` collects and validates rich module candidates; it deliberately avoids context-free Pareto deletion. This Rust API instead ranks a fixed five-dimensional integer tuple. |
| Resources | `ResourceLedgerV1` in [`resource.rs`](src/resource.rs) | The control-plane resource allocator, hierarchical allocator and SQLite durable lease ledger are distinct owners and contracts. |
| Telemetry | `TelemetryAggregatorV1` in [`telemetry.rs`](src/telemetry.rs) | The control-plane observability journal has separate identity, retention, policy and export semantics. |
| Performance | `qualify_performance_v1` in [`performance.rs`](src/performance.rs) | The control-plane performance evaluator and external target-host qualification have different evidence boundaries. |
| Calibration | `calibrate_predictions_v1` in [`calibration.rs`](src/calibration.rs) | `hepta_control_plane::optimizer_v2` exposes different types with the same short names; planner promotion remains separate. |

Use the full crate/module path when discussing or importing these contracts.
There is no implicit conversion between similarly named types. Adopting this
router requires an explicit mapping of the original candidate context and
hard-policy/currentness checks before applying Pareto reduction. Adopting this
snapshot requires a real read owner to establish the observations. A re-export,
passing source test or matching field name is not a parity adapter.

## Encoding, identity and trust

Public record types use camelCase fields and reject unknown struct fields;
enum values use the spelling declared in their source. They are serializable
and deserializable data, not opaque verified capabilities. Hashes identify
locally computed data; accepting an arbitrary decoded receipt does not rerun
its producer or authenticate the source observations.

The shared hash pattern is SHA-256 over two length-framed byte strings: the
domain and `serde_json::to_vec` output, each preceded by its big-endian u64 byte
length. Typed record field order and BTreeMap order determine those bytes. This
is not a claim of RFC 8785 or Node JSON byte compatibility. Integer i128 scores
must not pass through a floating-point or JavaScript Number conversion.

| Output | Domain and bound data |
|---|---|
| Snapshot | `HeptaPlanningSnapshotV1`; sorted components, revision/barrier, caller times and reported payload sizes. |
| Router policy / route | `HeptaCandidateRouterPolicyV1` binds the full policy; `HeptaCandidateRouteReceiptV1` binds its hash, eligible/frontier IDs and winning ID/score. Raw candidate records are not included in the route receipt body. |
| Resource receipt | `HeptaResourceReservationReceiptV1`; reservation/scope/generation, state, requested and actual vectors. Creation/expiry times are not in this receipt body. |
| Telemetry | `HeptaTelemetrySnapshotV1`; count, first/last times, counters and bucket counts. |
| Performance | `HeptaCanonicalPerformancePolicyV1` binds workloads; `HeptaPerformanceQualificationReceiptV1` binds the subject, policy hash and computed results. Raw durations are not in the receipt body. |
| Calibration | `HeptaPlannerCalibrationV1`; sorted observations, policy ID, aggregates and decision. Numeric policy thresholds are not included in that body. |

Callers must retain the original candidates, lease intervals, workload samples
and policies when their own audit requires them. In particular a calibration
report hash is not a full policy commitment. Adding these fields to a signed or
independently accepted subject needs an explicit versioned integration; do not
silently reinterpret the V1 hashes.

## Snapshot contract

`PlanningSnapshotRequestV1` supplies version 1, campaign ID, nonzero expected
revision, barrier ID, nonzero observation time, later expiry and 1–256 component
records. IDs use bounded ASCII identifiers of at most 256 bytes. Each component
must have a unique ID, the exact requested revision/barrier, a nonzero observation
time no later than the request time, a lower-case `sha256:` digest and positive
reported payload size. Checked total payload size is capped at 64 GiB. This is
a bound on declared sizes; the function never reads or allocates those payloads.

The producer sorts components into a BTreeMap, then derives the snapshot hash.
Mixed revisions/barriers, duplicate IDs, invalid request intervals and size
overflow fail with typed errors. It does not compare expiry with a host clock,
verify payload bytes, authenticate component producers or create snapshot
isolation. Those checks belong to the real read owner and the eventual consumer.
Retrying the same valid request is pure and deterministic.

## Candidate routing contract

The policy fixes positive integer weights (each at most 1,000,000,000), minimum
evidence in parts per million and risk/cost/latency ceilings. A request contains
1–4,096 unique candidates; each has a bounded ID/capability ID, signed i64 utility,
evidence in 0–1,000,000 ppm, unsigned risk/cost/latency, a feasible flag and at most
32 unique bounded disqualifier strings. Malformed candidates are rejected even
when they would later be ineligible.

The producer orders candidates by ID, filters eligibility, then computes the
Pareto frontier. Dominance means no worse on all five axes and strictly better
on at least one: larger utility/evidence and smaller risk/cost/latency. It scores
the frontier with checked i128 arithmetic:

`utility*Wu + evidence*We - risk*Wr - cost*Wc - latency*Wl`.

Highest score wins; equal scores choose the lexicographically smaller ID.
No eligible candidate is an error. Pairwise dominance is quadratic in eligible
candidate count, bounded by the 4,096 ceiling. There is no asynchronous producer
invocation, cancellation mechanism, external qualification check, candidate
expiry or payload hash verification in this API. Preserve these original
requirements in any future composition rather than dropping them during mapping.

## Resource state, accounting and recovery

`ResourceLedgerV1::new` validates 1–4,096 scopes with unique bounded IDs, nonzero
generations and nonzero limits. Every parent must exist, children fit their
parent's vector limit and the graph must be acyclic. Units are cumulative
CPU-ms, memory-MiB-ms, GPU-ms, storage-byte-ms and micro-USD, not instantaneous
machine capacity. There are at most 100,000 lifetime reservation records;
finalized/cancelled records are retained and no eviction API exists.

| Operation | Preconditions | Accounting and resulting state |
|---|---|---|
| `prepare` | New ID, matching leaf generation, nonzero request and valid creation/expiry; every ancestor has capacity. | Charges reserved resources at the leaf and every ancestor; creates `Prepared`. |
| `commit` | `Prepared`, matching generation, supplied time within the inclusive creation/expiry interval. | Becomes `Committed`; retains the entire reservation. |
| `finalize` | `Committed`; actual vector is no larger than reserved. | Releases the reservation throughout the hierarchy and adds actual consumption; becomes `Finalized`. |
| `cancel` | `Prepared` only. | Releases reserved resources and becomes `Cancelled`. |
| `recover_expired` | Nonzero supplied time; expiry strictly earlier than it. | Cancels expired prepared work, but lists committed work as ambiguous and keeps its full charge. |
| `fence_scope` | No prepared/committed reservation in that scope or its descendants. | Increments that scope's generation with checked arithmetic. |

Commit before creation, commit after expiry and repeated state transitions are
errors. Rejection leaves a valid prepared reservation available for a later
valid commit. Finalization has no new clock/expiry test: uncertain committed
work is reconciled, not automatically refunded. Generations belong to individual
scopes; fencing a parent does not increment each child's generation.

This ledger is in memory and has no persistence/load, journal replay, fsync,
cross-process locking or physical resource enforcement. `recover_expired` acts
on records already in that instance; constructing a new empty ledger after a
crash does not reconstruct or release prior charges safely. A durable owner
must bind external consumption and preserve ambiguity before production use.
Receipts are not idempotent replay commands or spend authorization.

## Telemetry contract

The input uses closed event/module/outcome/severity enums and at most four closed
label keys. It has no free-form message, path, campaign/account ID or credential
field. Labels are validated by their types but are not retained or broken out
in the aggregate. Timestamps must be nonzero and nondecreasing relative to the
instance's last accepted observation. Equal timestamps are allowed.

Counters group by event/module/outcome/severity. Histograms group by
event/module/outcome and place each observation into one upper-bound bucket:
1, 5, 10, 25, 50, 100, 250, 500, 1,000 or u64::MAX milliseconds. These are
per-bucket counts, not cumulative Prometheus buckets. Fixed enums bound the
possible series to 2,688 counters and 6,720 histogram buckets. Counts cannot
exceed i64::MAX. Empty export, clock regression and overflow return errors.

The aggregator stores only in-memory aggregates. It neither authenticates
reported timestamps nor exports a network service, enforces retention or
persists a crash-recoverable journal. A downstream adapter must explicitly map
bucket semantics and apply the required storage/privacy policy.

## Performance and calibration contracts

Performance accepts 1–256 unique canonical workloads and no more than 256
observations, checking the complete-set bound before constructing the observation
map. Each workload needs exactly one observation with 7–10,000 positive durations.
Missing, duplicate and extra records fail. The subject requires the exact
repository literal and correctly shaped commit/tree/binary/configuration/host
digests; it does not observe those sources or verify their provenance.

Samples are sorted. Median uses the middle value or the checked, floored average
of the middle pair; p95 uses the nearest-rank ceiling. Throughput is floored
`operations * 1e9 / median_ns`; positive regression is floored ppm against the
baseline, with improvements represented as zero regression. All three workload
thresholds must pass. Checked arithmetic or output conversion overflow returns
an error. The caller supplies the samples; this API launches no benchmark and
does not independently qualify a host. `productionAuthorityGranted` stays false.

Calibration accepts the policy's positive minimum through 10,000 unique candidate
observations. Predicted cost and latency must be positive; observed zero is
allowed. It computes mean absolute utility error and per-observation relative
cost/latency error against the prediction in ppm, using u128 totals and integer
flooring. Duplicates, invalid identifiers, zero predictions, insufficient samples
and unrepresentable results fail. It returns a comparison decision with
`productionAuthorityGranted=false`; it neither trains a model nor promotes a
planner nor authenticates an observation. See the policy-hash limitation above.

## Development and acceptance

From the repository's `rust` directory run:

```sh
cargo test -p hepta-orchestration-kernel --locked
cargo clippy -p hepta-orchestration-kernel --all-targets --locked -- -D warnings
```

Unit tests cover order invariance, duplicate and malformed inputs, dominance,
hierarchical accounting, lease interval boundaries, conservative committed
recovery, telemetry field restrictions/clock regression and deterministic
performance/calibration decisions. The two integration tests compose these
public Rust APIs from explicit data fixtures; they do not exercise Node parity,
real database read barriers, restart persistence or production services.

Before replacing an existing command, add an explicit adapter and test the full
original argument/error/ordering contract, then integrate the real read owner,
durable resource and telemetry owners, live qualification/currentness and
independent workload evidence as required. Update the command map only from
that actual call chain. The term `source_closure` in a test filename does not
close a migration gap or grant deployment authority.
