# module.resource-allocator

Status: normative module specification  
Manifest: [`../manifests/resource-allocator.v1.json`](../manifests/resource-allocator.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.resource-allocator
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-SCHEDULER
secondaryOwnerTeam: TEAM-SRE
independentReviewerTeam: TEAM-STATE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Admit, reserve, fence, account, reconcile, and release multi-resource capacity with hierarchical fairness and bounded starvation policy.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- plan certificate
- capacity and accounting generation
- hierarchical entitlements
- finite resource vectors

Outputs:

- prepared/finalized reservations
- single-use dispatch capability
- settlement and accounting reports

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `read_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- No hard module dependency.

Current implementation and contract roots:

- `paper-application/automation/resource-governor.mjs`
- `docs/control-plane/RESOURCE_MODEL.md`
- `rust/crates/hepta-control-plane`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject negative/overflowing units, stale generations, hierarchy violations, double reservations, unreserved use, owner loss, overuse, or ambiguous release. Unknown consumption remains charged until reconciled.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Reservation handles are audience-bound and single-use. Capacity never implies execution, credential, writer, release, or submission permission.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Resource dimensions and units are schema-versioned. State upgrades preserve prepared/finalized reservations or explicitly reconcile them before rollback.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track p50/p95/p99 latency, maximum queue age/depth, throughput, timeout/fallback rate, recovery time, and all zero-tolerance safety counters. Canonical workload and threshold versions are bound in the deployment evidence; source documents do not invent production numbers.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

The current Node helper's exact interface, units, policy bounds, accounting
invariant and non-claims are specified in
[`RESOURCE_MODEL.md`](../../control-plane/RESOURCE_MODEL.md#13-current-node-governor-executable-bounded-admission).
`createResourceGovernor` now provides idempotent release handles, strict integer
vectors, bounded waiting and opt-in bounded conflicting overtaking. Legacy
first-fit remains the default because nested acquisitions need a separate
dependency-aware policy; finite barriers are only for independent work. Pending cancellation
uses a propagation-resistant disposable subscription, removes its listener and
reconsiders queued work even when an earlier native listener suppresses ordinary
abort propagation; granted work remains charged
until explicitly released. Tests in
`paper-core/tests/resource-governor-invariants.test.mjs` bind these behaviors to
executable positive, adversarial, capacity and deterministic-sequence checks.
The legacy defaults are not qualified production capacity. Hierarchical DRF,
durable fenced leases, host measurements and whole-work-item acceptance remain
open; the local governor must not be presented as their implementation.


Capability bindings: `CAP-RES-ALLOCATE`. Related work identifiers: `RES-001`, `RES-002`, `RES-003`, `RES-004`, `RES-005`, `RES-006`, `RES-007`. Implementation/contract roots: `paper-application/automation/resource-governor.mjs`, `docs/control-plane/RESOURCE_MODEL.md`, `rust/crates/hepta-control-plane`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `RES-001` — `design_ready`
- `RES-002` — `design_ready`
- `RES-003` — `design_ready`
- `RES-004` — `design_ready`
- `RES-005` — `design_ready`
- `RES-006` — `design_ready`
- `RES-007` — `design_ready`
