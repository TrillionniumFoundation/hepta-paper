# module.program-truth

Status: normative module specification  
Manifest: [`../manifests/program-truth.v1.json`](../manifests/program-truth.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.program-truth
implementationKind: pure_library
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: pure
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-SRE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Own the canonical static program graph, schemas, document policy, and graph validation used to describe the complete hepta-paper system.

It does not hold credentials, execute external effects, or mutate authoritative state. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- repository-relative current-document roots
- machine-truth JSON records
- strict JSON Schemas
- current invariant and architecture documents

Outputs:

- validated program graph report
- canonical path/identity diagnostics
- machine-readable failure list

## State and authority

Maximum authority class: `pure`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. The module owns no durable state and returns values only.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- No hard module dependency.

Current implementation and contract roots:

- `docs/system`
- `docs/tools`

## Concurrency and resources

Runs in-process with bounded input and output sizes and no independently created threads, network calls, child processes, or mutable global state. CPU and memory limits are inherited from the calling command; algorithmic bounds and maximum collection sizes are part of the protocol.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject malformed schemas, unknown references, dependency cycles, duplicate IDs, missing canonical documents, unsafe links, and historical-path resurrection. Validation is side-effect free and emits all bounded diagnostics in deterministic order.

## Security and privacy

Treat repository paths and documents as untrusted input; reject symlink escapes and keep validation read-only. Machine truth cannot grant runtime authority.

## Compatibility and migration

Schemas are versioned and closed. A breaking truth-shape change requires a new schema version plus migration of every validator and projection.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-SYS-PROGRAM-TRUTH`. Related work identifiers: `SYS-001`, `SYS-002`, `SYS-003`, `SYS-004`, `SYS-005`, `SYS-006`. Implementation/contract roots: `docs/system`, `docs/tools`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `SYS-001` — `source_implemented`
- `SYS-002` — `source_implemented`
- `SYS-003` — `source_implemented`
- `SYS-004` — `source_implemented`
- `SYS-005` — `source_implemented`
- `SYS-006` — `source_implemented`
