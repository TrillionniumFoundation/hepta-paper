# module.node-legacy-adapter

Status: normative module specification  
Manifest: [`../manifests/node-legacy-adapter.v1.json`](../manifests/node-legacy-adapter.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.node-legacy-adapter
implementationKind: legacy_adapter
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
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

Expose current Node capabilities through Module Protocol V1 as bounded shadow/prepared-result implementations for differential migration.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- Module Protocol V1 request
- frozen Node input snapshot
- compatibility policy
- shadow/canary scope

Outputs:

- bounded candidate/prepared result
- translation and parity evidence
- no-authority receipt

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

## Dependencies

Hard registered module dependencies:

- `module.node-control-plane`
- `module.module-registry`

Current implementation and contract roots:

- `docs/migration/NODE_RUST_MIGRATION.md`
- `rust/crates/hepta-module-platform/src/legacy_adapter.rs`

## Concurrency and resources

Uses the incumbent Node runtime's bounded worker, storage, and provider controls. Migration/shadow work has separate quotas and cannot starve authoritative traffic or create hidden child concurrency. Resource use is reported in the common settlement format.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject unsupported Node commands/events, translation loss outside the declared parity class, stale snapshots, direct writer handles, external effects, or shadow results that attempt authoritative integration.

## Security and privacy

Run shadow/read-only by default; expose no central writer, provider, release, or submission handles. Translation artifacts are untrusted until verified.

## Compatibility and migration

Translations bind source and target protocol versions and a parity class. Lossy mappings require evaluation evidence and cannot claim exact parity.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-MOD-CANDIDATES`, `CAP-MOD-EXECUTION`, `CAP-CMP-LEGACY`. Related work identifiers: `MIG-001`, `MIG-002`, `MIG-004`. Implementation/contract roots: `docs/migration/NODE_RUST_MIGRATION.md`, `rust/crates/hepta-module-platform/src/legacy_adapter.rs`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Bounded Rust strangler source

The Rust source implements the generic `MIG-002` execution adapter boundary. It accepts a closed set of hash-bound legacy capability bindings, emits one deterministic Module Protocol V1 candidate, reserves an exact execution identity before a separately controlled Node port may run, and translates one bounded observation into a common prepared result. Exact duplicate observations replay the retained result; changed command, candidate, invocation, output, resource, cost, or authority facts fail closed. Running work and unknown cancellation identities require reconciliation rather than inferred success.

The source receives no Node executable handle, central writer, provider credential, release signer, portal session, or submission capability. It rejects central-state-write and irreversible-external-effect observations, caps retained execution identities, resources, cost, artifacts, deadlines and source bindings, and keeps activation `disabled`. The complete Rust workspace, rustfmt, Clippy and documentation build passed on the exact implementation head before this static status update.

This source does not close `MIG-001`: the repository still needs a closed per-capability inventory binding every incumbent Node entrypoint, contract, parity class, resource profile and rollback target. It also does not close `MIG-004`: no production-shaped per-capability shadow comparator, evaluation decision, or authority-safe consumer rollout is activated.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `MIG-001` — `source_implemented`
- `MIG-002` — `source_implemented`
- `MIG-004` — `source_implemented`
