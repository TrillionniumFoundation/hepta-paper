# module.performance-qualification

Status: normative module specification  
Manifest: [`../manifests/performance-qualification.v1.json`](../manifests/performance-qualification.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.performance-qualification
implementationKind: isolated_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-SRE
secondaryOwnerTeam: TEAM-SCHEDULER
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

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

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.observability`

Current implementation and contract roots:

- `docs/performance`
- `rust/crates/hepta-control-plane/src/performance_qualification.rs`
- `rust/crates/hepta-control-plane/src/source_closure.rs`

## Concurrency and resources

Runs behind a qualified process/container runner with explicit CPU, memory, PID, storage, deadline, network, token/provider, and optional GPU envelopes. Child concurrency is included in the reservation; overload returns a bounded busy/retry disposition rather than bypassing central admission.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject unbound hosts/workloads, missing warm/cold policy, inadequate samples, measurement drift, safety-counter violations, non-reproducible aggregates, or thresholds without independent applicability review.

## Security and privacy

Benchmark data contains no secrets and cannot grant activation. Exact-host identifiers and raw artifacts follow restricted evidence custody.

## Compatibility and migration

Workload, measurement, host profile, aggregation, and threshold versions are immutable evidence inputs. Threshold changes do not rewrite old results.

## SLO, capacity, and observability

Primary indicators are workload validity, sample sufficiency, measurement reproducibility, confidence bounds, zero-tolerance safety counters, and review freshness. Numeric thresholds remain `baseline_pending` until an exact-host baseline is accepted; the absence of a baseline blocks target-host qualification rather than inventing values.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-PERF-QUALIFICATION`. Related work identifiers: `PERF-001`, `PERF-002`, `PERF-003`. Implementation/contract roots: `docs/performance`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Standalone Rust orchestration compatibility contract

[`qualify_performance_v1`](../../../rust/crates/hepta-orchestration-kernel/src/performance.rs) remains available only from the standalone
`hepta-orchestration-kernel` crate. It is not re-exported by the product control plane and is not a selected performance owner. This pure Rust function computes integer median, nearest-rank p95, throughput and regression from supplied samples. It bounds the complete workload/observation sets before map construction, binds supplied subject digests and keeps productionAuthorityGranted false. It does not run a benchmark, observe binary provenance or consume independent target-host signatures; it is separate from the existing control-plane performance evaluator.

See the [Rust orchestration development handoff](../../../rust/crates/hepta-orchestration-kernel/HANDOFF.md)
for exact fields/units, bounds, hash domains, failure/recovery behavior and
implementation selection. This standalone compatibility API is not wired into
an existing product command. Focused source validation from `rust` is
`cargo test -p hepta-orchestration-kernel --locked`; those fixtures do not establish
Node parity, production activation or independent qualification.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `PERF-001` — `source_implemented`
- `PERF-002` — `source_implemented`
- `PERF-003` — `source_implemented`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
