# Observability model

## 1. Scope and authority

Observability records what the system attempted, observed, committed, rejected,
and reconciled. It supports operations, qualification, performance analysis,
audit, and incident response. Telemetry is not an authority source: a metric,
log, trace, dashboard, or alert cannot grant a lease, accept evidence, commit
state, authorize an external effect, or promote a release.

Authoritative decisions remain in their versioned state stores and signed or
hash-bound receipts. Observability references those records by identity rather
than duplicating mutable decision state.

## 2. Signal classes

The system defines four signal classes:

- **audit events** for security-, authority-, policy-, and state-transition facts;
- **operational events** for lifecycle, queue, lease, recovery, and health facts;
- **metrics** for bounded aggregates and service-level indicators;
- **traces** for causal timing across one request, plan, attempt, or recovery path.

Every signal declares its schema version, producer, trust class, retention
class, privacy class, and cardinality budget. Unknown or malformed signal types
are rejected at trusted ingestion boundaries.

## 3. Common identity envelope

Where applicable, signals bind:

```text
program and release identity
campaign, DAG, node, and plan generation
attempt, reservation, lease, and fence generation
operation and idempotency identity
producer module, process, host, and runtime identity
capability and evidence tier
resource/accounting generation
monotonic sequence or journal position
observed and signed evidence times
content or receipt hashes
```

Optional fields are explicitly nullable; omission is not interpreted as a zero,
success, or legacy default.

## 4. Audit events

Audit events are append-only and ordered within their authoritative journal.
Security-relevant events include admission decisions, permit issuance and
consumption, writer transitions, evidence promotion, credential or trust-store
rotation, external-action intent and reconciliation, release/submission handoff,
retention/deletion, recovery claims, and policy override attempts.

An audit event contains normalized reason codes and bounded diagnostics. Secret
material, raw credentials, private keys, hidden datasets, manuscript confidential
content, and unrestricted provider responses are never copied into telemetry.

## 5. Metrics and cardinality

Metric names, units, label sets, and aggregation rules are registered. Dynamic
identifiers such as campaign, paper, user, path, prompt, artifact hash, provider
request, or error prose are not unrestricted labels. High-cardinality identity
is retained in journals or sampled traces and linked through a bounded opaque
reference.

Counters are monotonic within a generation. Gauges declare their observation
scope. Histograms use versioned finite buckets. Missing observations remain
missing and are not manufactured as zero.

Cardinality, memory, export bandwidth, and retention budgets are enforced before
publication. Budget exhaustion drops or coarsens only signals allowed by policy;
it never suppresses required audit records silently.

## 6. Privacy and redaction

Each field is classified as public, internal, confidential, secret-derived, or
prohibited. Redaction occurs before a signal crosses its process or storage
boundary. Redacted values use typed reason codes, not reversible truncation.

Free-form diagnostics are bounded, normalized, and excluded from durable public
receipts unless explicitly reviewed. Paths are workspace-relative or opaque;
host usernames, home directories, tokens, request bodies, and environment dumps
are prohibited.

## 7. Time semantics

Signals may contain wall-clock time for operations and signed evidence time for
trust decisions. Ordering and correctness do not rely solely on wall-clock time.
Journals use sequence numbers or durable positions, leases use monotonic/fenced
generations, and external receipts retain their verified validity windows.

Clock rollback, implausible skew, or disagreement between observation and signed
time is recorded and handled by the owning gate. Telemetry never rewrites the
authoritative time decision.

## 8. Tracing

Trace propagation uses opaque, bounded identifiers. A span binds one declared
operation and parent context; it cannot expand authority or carry secret
capabilities. Provider, worker, database, filesystem, GPU, build, formal,
release, and submission boundaries create explicit spans when policy permits.

Sampling is deterministic for required qualification workloads and policy-based
for ordinary operations. Audit events and externally uncertain outcomes are not
lost merely because a trace is unsampled.

## 9. Service-level indicators and objectives

Canonical indicators include:

- admission and dispatch latency;
- queue age and fairness deferral;
- reservation and lease renewal health;
- completion, failure, cancellation, and recovery latency;
- deadline and budget compliance;
- provider and external-action uncertainty duration;
- commit sequencer throughput and contention;
- evidence and qualification freshness;
- fallback, replan, rollback, and quarantine rates;
- telemetry loss, rejection, and cardinality pressure.

SLO definitions bind a workload, measurement window, population, exclusions,
version, and evidence source. A dashboard value without the bound workload and
receipt is not qualification evidence.

## 10. Health and alerts

Health separates process liveness, startup reconciliation, dependency
readiness, machine-intake readiness, writer readiness, and capability-specific
qualification. One healthy component cannot mask another blocked boundary.

Alerts are derived from versioned rules with deduplication, routing, and
suppression limits. Alert acknowledgement changes incident workflow state only;
it does not clear the underlying safety or authority blocker.

## 11. Evidence export and retention

Qualification exports contain the minimum exact signal subset required by the
workload and gate. Exports bind query definition, source journal positions,
schema versions, aggregation code, time window, omissions, hashes, and reviewer
identity. Raw operational telemetry is not automatically public evidence.

Retention is class-specific and legal-hold aware. Deletion uses the same
identity-bound, journalled, recoverable mechanisms as other protected artifacts.
A local retention action cannot delete independently controlled evidence.

## 12. Failure behaviour

Telemetry pipeline failure is visible and typed. Required audit ingestion fails
closed at the owning mutation boundary when policy says the audit record is part
of the transaction. Optional metrics may degrade without blocking work only when
the policy explicitly permits it and records the loss.

Exporter outage, duplicate delivery, reordering, restart, partial batch,
cardinality attack, malformed payload, and storage pressure are tested. Replay
is idempotent by signal identity and journal position.

## 13. Required qualification

Source qualification covers schemas, redaction, prohibited-field tests,
cardinality bounds, deterministic aggregation, sequence integrity, duplicate and
out-of-order replay, retention classification, and fail-closed audit coupling.

Target-host qualification covers sustained volume, exporter failure, disk and
network pressure, restart, clock behaviour, long-running SLO windows, privacy
inspection, and alert delivery. Independent external evidence is still required
for release, portal, submission, immutable-storage, KMS/HSM, and other external
authority claims.

## 14. Non-claims

Observability does not prove scientific correctness, global scheduler optimality,
resource isolation, external non-occurrence, or production readiness. A green
metric is not a signed decision, a trace is not a permit, and a local dashboard
cannot close an external qualification gap.
