# module.performance-qualification

Status: normative module specification  
Manifest: [`../manifests/performance-qualification.v1.json`](../manifests/performance-qualification.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.performance-qualification
implementationKind: isolated_process
staticImplementationState: design_ready
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-SRE
secondaryOwnerTeam: TEAM-SCHEDULER
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Measure canonical workloads on exact hosts and produce reviewed capacity, latency, fairness, recovery, quality, and regression evidence.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- exact source/binary/config/host
- canonical workload and data
- measurement and threshold version
- warm/cold policy

Outputs:

- raw bounded measurements
- canonical aggregate and confidence bounds
- reviewed SLO/capacity disposition

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.observability`

Current implementation and contract roots:

- `docs/performance`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs behind a qualified process/container runner with explicit CPU, memory, PID, storage, deadline, network, token/provider, and optional GPU envelopes. Child concurrency is included in the reservation; overload returns a bounded busy/retry disposition rather than bypassing central admission.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject unbound hosts/workloads, missing warm/cold policy, inadequate samples, measurement drift, safety-counter violations, non-reproducible aggregates, or thresholds without independent applicability review.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Benchmark data contains no secrets and cannot grant activation. Exact-host identifiers and raw artifacts follow restricted evidence custody.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Workload, measurement, host profile, aggregation, and threshold versions are immutable evidence inputs. Threshold changes do not rewrite old results.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Primary indicators are workload validity, sample sufficiency, measurement reproducibility, confidence bounds, zero-tolerance safety counters, and review freshness. Numeric thresholds remain `baseline_pending` until an exact-host baseline is accepted; the absence of a baseline blocks target-host qualification rather than inventing values.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-PERF-QUALIFICATION`. Related work identifiers: `PERF-001`, `PERF-002`, `PERF-003`. Implementation/contract roots: `docs/performance`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `PERF-001` — `design_ready`
- `PERF-002` — `design_ready`
- `PERF-003` — `design_ready`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
