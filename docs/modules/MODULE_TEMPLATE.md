# Module specification template

Copy this structure only for a real registered module. Replace every field and sentence; an incomplete section is a blocker, not optional prose. Every registered module must have exactly one specification under `docs/modules/specs/`, one manifest under `docs/modules/manifests/`, and one entry in `module-documentation.v1.json`.

## Identity

```text
moduleId:
moduleVersion or deployment-bound version rule:
implementationKind:
capabilityIds:
protocol minimum/maximum:
authorityClass:
sideEffectClasses:
determinismClass:
primaryOwnerTeam:
secondaryOwnerTeam:
independentReviewerTeam:
specPath:
manifestPath:
```

State which identity is static source truth and which fields are supplied only by the exact qualified deployment registry. A source document cannot grant activation or authority.

## Mission and non-goals

State the bounded responsibility, capability outcomes, and responsibilities explicitly excluded. Name the authoritative owner for every excluded write or external effect.

## Inputs and outputs

For every request, candidate, command, result, event, health report, and receipt:

```text
schema/kind/version
canonical encoding and maximum bytes/counts
authority and freshness requirements
idempotency identity
unknown-field policy
confidentiality classification
artifact/CAS handoff
```

## State and authority

Document module-private state, read models, prepared effects, external effects, and every forbidden state or credential. Identify the authoritative owner for each transition. A non-sequencer module must not expose a central-state write path.

## Dependencies

List registered module IDs, protocol versions, external authorities, runtime artifacts, datasets, schemas, and failure assumptions. Source-directory imports are not a substitute for a declared module dependency.

## Concurrency and resources

Specify:

```text
maximum inflight and queue depth
CPU/GPU/memory/storage/PID/token/provider/cost vector
reservation and settlement semantics
cancellation/preemption boundary
fairness class and starvation bound
blocking/async execution model
backpressure and overload response
startup/recovery reserve
```

## Determinism and optimization contract

State whether output is deterministic, seeded, externally observed, or bounded/model-nondeterministic. Candidate generators document feasible-set completeness, Pareto reduction, prediction uncertainty, units/calibration, expiry, and why any singleton is justified.

## Failure, recovery, and idempotency

Enumerate failures before and after every durable or irreversible boundary. Specify restart discovery, retry layer, exact duplicate versus conflict behavior, ambiguous disposition, prepared-result replay, orphan cleanup, reconciliation, and operator escalation.

## Security and privacy

Describe principals, credential roots, filesystem/socket/database authority, secret redaction, telemetry allowlists, artifact access, prompt/data classification, and threat-model limits. Explicitly state what the module cannot read, write, sign, release, or submit.

## Compatibility and migration

Define supported protocol/state/schema versions, N/N-1 policy where applicable, golden vectors, Node/Rust parity class, migration procedure, rollback version, and final retirement condition.

## SLO, capacity, and observability

Bind canonical workload IDs, metrics, thresholds or `baseline_pending` state, zero-tolerance counters, trace identifiers, cardinality limits, retention, alert ownership, and runbook owner.

## Operational runbook

Document startup preflight, readiness, normal operation, backpressure, shutdown, crash/restart recovery, ambiguous-effect reconciliation, backup/restore or journal handling where applicable, rollback, and escalation. Pure libraries state their caller obligations and revalidation triggers.

## Verification and evidence

List capability evidence-binding IDs, exact tests, workflow contexts, fault cases, performance workloads, required evidence tier, producer/reviewer separation, expiry, and revalidation rule. Source conformance must not be represented as target-host or external-authority proof.

## Rollout and rollback

Document disabled, shadow, canary, authoritative, retiring, and retired transitions. Specify mutual-exclusion groups, exact rollback target, in-flight/prepared-result disposition, and proof that rollback cannot restore dual authority.

## Open blockers

List only stable work-item, risk, milestone, issue, and external-gap IDs with their current static state. Do not copy a dated narrative or claim that static documentation closes independently controlled evidence.
