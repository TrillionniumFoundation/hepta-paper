# module.protocol-kernel

Status: normative module specification  
Manifest: [`../manifests/protocol-kernel.v1.json`](../manifests/protocol-kernel.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.protocol-kernel
implementationKind: pure_library
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: pure
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-PROTOCOL
secondaryOwnerTeam: TEAM-KERNEL
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Provide canonical identifiers, hashing, bounded wire values, clocks, and protocol primitives shared by Node and Rust without acquiring business authority.

It does not hold credentials, execute external effects, or mutate authoritative state. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- typed domain values
- schema versions
- bounded canonical payloads
- explicit time/randomness inputs

Outputs:

- canonical encodings and hashes
- validated protocol values
- stable error dispositions

## State and authority

This pure result cannot grant execution, writer, or external authority.

Maximum authority class: `pure`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. The module owns no durable state and returns values only.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- No hard module dependency.

Current implementation and contract roots:

- `workflow-kernel`
- `paper-domain/contracts`
- `rust/crates/hepta-codex-protocol`

## Concurrency and resources

Runs in-process with bounded input and output sizes and no independently created threads, network calls, child processes, or mutable global state. CPU and memory limits are inherited from the calling command; algorithmic bounds and maximum collection sizes are part of the protocol.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject unknown required semantics, oversize values, non-canonical encoding, invalid identifiers, time rollback, overflow, duplicate fields, or unsupported versions. Callers must not reinterpret rejected bytes.

## Security and privacy

Use closed object shapes, bounded allocation, canonical hashing, explicit audience and expiry, and no ambient credentials or filesystem access.

## Compatibility and migration

Readers reject unknown required semantics. N/N-1 support exists only where declared; historical canonical encodings are immutable.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-PROTOCOL-CANONICAL`. Related work identifiers: `MOD-006`. Implementation/contract roots: `workflow-kernel`, `paper-domain/contracts`, `rust/crates/hepta-codex-protocol`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

The Rust protocol contract lives in `rust/crates/hepta-codex-protocol`, alongside the production Node hashing boundary in `workflow-kernel/record-hash.mjs`. See the [legacy serialization compatibility implementation](../../../rust/crates/hepta-legacy-compatibility/README.md) for numeric-property ordering, IEEE-754 number semantics, UTF-16 key ordering, negative cases and cross-runtime oracle tests. Protocol and legacy byte domains remain explicit; a protocol digest is not automatically a legacy record hash.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `MOD-006` — `source_implemented`
