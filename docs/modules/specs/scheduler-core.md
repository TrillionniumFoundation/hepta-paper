# module.scheduler-core

Status: normative module specification  
Manifest: [`../manifests/scheduler-core.v1.json`](../manifests/scheduler-core.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.scheduler-core
implementationKind: pure_library
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: pure
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-SCHEDULER
secondaryOwnerTeam: TEAM-KERNEL
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Select a dependency-closed feasible plan under hard policy and resource constraints and emit a recomputable non-authorizing plan certificate.

It does not hold credentials, execute external effects, or mutate authoritative state. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- immutable snapshot
- validated candidate frontier
- hard policy
- planner policy and deterministic tie-break inputs

Outputs:

- dependency-closed plan certificate
- rejected-candidate reasons
- fallback/optimality metadata

## State and authority

This pure result cannot grant execution, writer, or external authority.

Maximum authority class: `pure`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. The module owns no durable state and returns values only.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.candidate-router`
- `module.resource-allocator`

Current implementation and contract roots:

- `docs/control-plane/GLOBAL_OPTIMIZATION.md`
- `docs/control-plane/SCHEDULER_STATE_MACHINE.md`
- `rust/crates/hepta-control-plane`

## Concurrency and resources

Runs in-process with bounded input and output sizes and no independently created threads, network calls, child processes, or mutable global state. CPU and memory limits are inherited from the calling command; algorithmic bounds and maximum collection sizes are part of the protocol.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject infeasible snapshots, arithmetic overflow, cyclic dependencies, non-deterministic tie inputs, certificate tampering, stale inputs, or solver output that violates hard constraints. Timeout selects only the declared deterministic fallback.

## Security and privacy

The planner has no provider or writer credentials. Hard policy is independently rechecked at admission, dispatch, and commit boundaries.

## Compatibility and migration

Plan certificates bind optimizer and objective versions. Fallback ordering and historical certificates remain reproducible across upgrades.

## SLO, capacity, and observability

Track p50/p95/p99 latency, maximum queue age/depth, throughput, timeout/fallback rate, recovery time, and all zero-tolerance safety counters. Canonical workload and threshold versions are bound in the deployment evidence; source documents do not invent production numbers.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-SCH-PLAN`. Related work identifiers: `SCH-001`, `SCH-002`, `SCH-003`, `SCH-004`, `SCH-005`, `SCH-006`, `SCH-007`. Implementation/contract roots: `docs/control-plane/GLOBAL_OPTIMIZATION.md`, `docs/control-plane/SCHEDULER_STATE_MACHINE.md`, `rust/crates/hepta-control-plane`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Standalone Rust orchestration compatibility contract

[`calibrate_predictions_v1`](../../../rust/crates/hepta-orchestration-kernel/src/calibration.rs) remains available only from the standalone
`hepta-orchestration-kernel` crate. It is not re-exported by the product control plane and is not a selected scheduler owner. This compatibility/experimental API computes integer calibration errors from bounded caller-supplied observations. It is distinct from the similarly named optimizer_v2 types and does not promote a planner or authenticate samples. The V1 report hash binds observations and policy ID but not numeric policy thresholds; a qualified integration must bind the complete policy separately with explicit versioning.

See the [Rust orchestration development handoff](../../../rust/crates/hepta-orchestration-kernel/HANDOFF.md)
for exact fields/units, bounds, hash domains, failure/recovery behavior and
implementation selection. This standalone compatibility API is not wired into
an existing product command. Focused source validation from `rust` is
`cargo test -p hepta-orchestration-kernel --locked`; those fixtures do not establish
Node parity, production activation or independent qualification.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `SCH-001` — `source_implemented`
- `SCH-002` — `source_implemented`
- `SCH-003` — `source_implemented`
- `SCH-004` — `source_implemented`
- `SCH-005` — `source_implemented`
- `SCH-006` — `source_implemented`
- `SCH-007` — `source_implemented`
