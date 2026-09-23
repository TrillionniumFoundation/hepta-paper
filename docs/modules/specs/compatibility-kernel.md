# module.compatibility-kernel

Status: normative module specification  
Manifest: [`../manifests/compatibility-kernel.v1.json`](../manifests/compatibility-kernel.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.compatibility-kernel
implementationKind: pure_library
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-PROTOCOL
secondaryOwnerTeam: TEAM-STATE
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Preserve historical Node/Rust protocol and state semantics through bounded codecs, golden vectors, differential replay, and explicit retirement rules.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- legacy bytes/values and exact schema version
- Node/Rust implementation identities
- golden vectors or immutable replay archive

Outputs:

- canonical translation
- differential result
- compatibility/retirement disposition

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.protocol-kernel`

Current implementation and contract roots:

- `rust/crates/hepta-legacy-compatibility`

The standalone `hepta-compatibility` crate remains only a Rust-draft/reference
surface for differential verification. It is not selected by this product
module, and product control/service crates must not depend on it.

## Concurrency and resources

Runs in-process with bounded input and output sizes and no independently created threads, network calls, child processes, or mutable global state. CPU and memory limits are inherited from the calling command; algorithmic bounds and maximum collection sizes are part of the protocol.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject unknown historical versions, lossy conversion without an explicit evaluation class, golden-vector drift, missing oracle identity, incomplete archive replay, or retirement before production reachability is zero.

## Security and privacy

Historical/reference code is never production authority. Oracles and archives are immutable, hash-bound, and isolated from writer/release graphs.

## Compatibility and migration

The module itself owns N/N-1, golden vectors, exact/semantic/evaluation parity classes, and final retirement only after historical verification remains available.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-CMP-LEGACY`. Related work identifiers: `LEGACY-REPLAY-001`, `MIG-003`. Implementation/contract roots: `rust/crates/hepta-compatibility`, `rust/crates/hepta-legacy-compatibility`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

See the [legacy serialization and oracle contract](../../../rust/crates/hepta-legacy-compatibility/README.md). It specifies the actual production Node serializer oracle, JavaScript integer-property enumeration, string ordering, number formatting, limits and the distinction between real production compatibility and an independent test implementation. Cross-runtime vectors are source evidence only.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `LEGACY-REPLAY-001` — `blocked_external`
- `MIG-003` — `source_implemented`
