# module.observability

Status: normative module specification  
Manifest: [`../manifests/observability.v1.json`](../manifests/observability.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.observability
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
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

Record privacy-bounded audit, operational, metric, and trace signals linked to authoritative receipts without becoming an authority source.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- bounded typed signals and receipt references
- privacy/cardinality policy
- journal positions
- retention class

Outputs:

- validated audit/metric/trace records
- loss/rejection counters
- bounded export artifact

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- No hard module dependency.

Current implementation and contract roots:

- `docs/control-plane/OBSERVABILITY_MODEL.md`
- `paper-application/automation/resource-governor.mjs`
- `rust/crates/hepta-control-plane`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject malformed/prohibited fields, cardinality overflow, sequence conflict, invalid retention class, duplicate-conflicting replay, or required audit loss. Optional signal loss is explicit and cannot hide safety events.

## Security and privacy

Classify every field; prohibit secrets, prompts, private paths, and confidential content; enforce label/cardinality and retention budgets before export.

## Compatibility and migration

Signal schemas and aggregation rules are versioned; unknown fields fail at trusted ingestion and historical journal positions remain replayable.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-OBS-TELEMETRY`. Related work identifiers: `OBS-001`, `OBS-002`. Implementation/contract roots: `docs/control-plane/OBSERVABILITY_MODEL.md`, `paper-application/automation/resource-governor.mjs`, `rust/crates/hepta-control-plane`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Standalone Rust orchestration compatibility contract

[`TelemetryAggregatorV1`](../../../rust/crates/hepta-orchestration-kernel/src/telemetry.rs) remains available only from the standalone
`hepta-orchestration-kernel` crate. It is not re-exported by the product control plane and is not a selected telemetry owner. This accumulator accepts only closed labels/event classes and produces bounded counters and per-bucket latency counts. It does not persist raw events, implement retention or expose the existing control-plane observability journal. Bucket counts are non-cumulative; exporters must explicitly convert semantics. The handoff specifies allowed fields, cardinality, clock/error behavior and hash identity.

See the [Rust orchestration development handoff](../../../rust/crates/hepta-orchestration-kernel/HANDOFF.md)
for exact fields/units, bounds, hash domains, failure/recovery behavior and
implementation selection. This standalone compatibility API is not wired into
an existing product command. Focused source validation from `rust` is
`cargo test -p hepta-orchestration-kernel --locked`; those fixtures do not establish
Node parity, production activation or independent qualification.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `OBS-001` — `source_implemented`
- `OBS-002` — `source_implemented`
