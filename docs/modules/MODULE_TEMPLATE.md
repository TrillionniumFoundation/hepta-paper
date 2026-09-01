# Module specification template

Copy this structure only for a real registered module. Replace every placeholder;
an incomplete section is a blocker, not optional prose.

## Identity

```text
moduleId:
name:
moduleVersion:
implementationKind:
capabilityIds:
protocol minimum/maximum:
authorityClass:
sideEffectClasses:
determinismClass:
primaryOwnerTeam:
secondaryOwnerTeam:
independentReviewerTeam:
```

## Mission and non-goals

State the bounded responsibility, the capability outcomes it owns, and the
responsibilities it explicitly does not own.

## Inputs and outputs

For every request, candidate, command, result, health report, and receipt:

```text
schema/kind/version
canonical encoding and maximum bytes/counts
authority and freshness requirements
idempotency identity
unknown-field policy
confidentiality classification
```

## State and authority

Document module-private state, read models, prepared effects, external effects,
and every forbidden state/credential. Identify the authoritative owner for each
state transition. A non-sequencer module must not expose a central-state write
path.

## Dependencies

List registered module IDs, protocol versions, external authorities, runtime
artifacts, and failure assumptions. Source-directory imports are not a substitute
for a declared module dependency.

## Concurrency and resources

Specify:

```text
maximum inflight and queue depth
CPU/GPU/memory/storage/process/token/provider/cost vector
reservation and settlement semantics
cancellation/preemption boundary
fairness class and starvation bound
blocking/async execution model
backpressure and overload response
```

## Determinism and optimization contract

State whether output is deterministic, seeded, externally observed, or model-
nondeterministic. Candidate generators document feasible-set completeness,
Pareto reduction, prediction uncertainty, and why any singleton is justified.

## Failure, recovery, and idempotency

Enumerate failures before and after every durable or irreversible boundary.
Specify restart discovery, retry layer, ambiguous disposition, prepared-result
replay, orphan cleanup, and operator escalation.

## Security and privacy

Describe principals, credential roots, filesystem/socket/database authority,
secret redaction, telemetry allowlists, artifact access, and threat-model limits.

## Compatibility and migration

Define supported protocol/state versions, N/N-1 policy where applicable, golden
vectors, Node/Rust parity class, migration procedure, rollback version, and final
retirement condition.

## SLO, capacity, and observability

Bind canonical workload IDs, metrics, thresholds or baseline-pending state,
zero-tolerance counters, trace identifiers, cardinality limits, and alert/runbook
ownership.

## Verification and evidence

List capability evidence-binding IDs, exact tests, workflow contexts, fault
cases, performance workloads, required evidence tier, reviewer domain, expiry,
and revalidation rule.

## Rollout and rollback

Document disabled, shadow, canary, authoritative, retiring, and retired
transitions. Specify mutual-exclusion groups and prove rollback does not restore
dual authority.

## Open blockers

List only stable work-item, risk, milestone, and external-gap IDs. Do not copy a
dated status narrative into the module document.
