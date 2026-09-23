# module.module-registry

Status: normative module specification  
Manifest: [`../manifests/module-registry.v1.json`](../manifests/module-registry.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.module-registry
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-PROTOCOL
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Register versioned capability implementations, ownership, authority ceilings, dependencies, qualification requirements, and rollout metadata.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- static module declarations
- capability/work/owner graph
- deployment qualification observations
- rollout policy

Outputs:

- validated registry artifact
- eligible implementation set
- registry change classification

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.program-truth`
- `module.protocol-kernel`

Current implementation and contract roots:

- `docs/modules`
- `rust/crates/hepta-module-platform`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject unknown capabilities, owners, paths, work items, cyclic dependencies, overlapping writer/external authority, incompatible protocol ranges, stale qualification, or rollout states that violate mutual exclusion.

## Security and privacy

A manifest declares requested authority but cannot grant it. Writer/external-effect implementations use mutual-exclusion groups and cross-team review.

## Compatibility and migration

Registry changes are classified as metadata, compatible addition, rollout, protocol/state/resource, authority, ownership, or retirement changes.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-MOD-REGISTRY`, `CAP-GOV-OWNERSHIP`. Related work identifiers: `MOD-001`, `MOD-004`, `MOD-005`, `MOD-007`, `MOD-008`, `ORG-001`, `ORG-002`, `ORG-003`, `ORG-004`. Implementation/contract roots: `docs/modules`, `rust/crates/hepta-module-platform`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `MOD-001` — `source_implemented`
- `MOD-004` — `source_implemented`
- `MOD-005` — `source_implemented`
- `MOD-007` — `blocked_external`
- `MOD-008` — `source_implemented`
- `ORG-001` — `design_ready`
- `ORG-002` — `design_ready`
- `ORG-003` — `design_ready`
- `ORG-004` — `source_implemented`
