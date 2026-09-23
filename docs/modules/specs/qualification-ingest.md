# module.qualification-ingest

Status: normative module specification  
Manifest: [`../manifests/qualification-ingest.v1.json`](../manifests/qualification-ingest.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.qualification-ingest
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-EVIDENCE
secondaryOwnerTeam: TEAM-RELEASE
independentReviewerTeam: TEAM-KERNEL
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Ingest, quarantine, validate, deduplicate, and record external qualification packages without allowing the producer to self-promote status.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- untrusted external package bytes
- schema and trust policy
- ingest idempotency key
- quarantine metadata

Outputs:

- quarantined/accepted/rejected record
- deduplication receipt
- verified status projection

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.external-authority-verifier`

Current implementation and contract roots:

- `rust/crates/hepta-qualification-ingest`

The [implementation handoff](../../../rust/crates/hepta-qualification-ingest/HANDOFF.md)
specifies the actual CLI and opaque factory, independent file ownership,
per-package and aggregate limits, cross-package host/database checks, exact
receipt compatibility, the retained minimum envelope/payload/inner-receipt
validity window, post-read and post-writer-lock system-clock checks, replay
ledger transaction and remaining native consumers.

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

## Determinism and optimization contract

Declared class: `external_observation`. Determinism applies to validation of a frozen external receipt set, not to the external system. Every observation binds authority, time window, generation, request/idempotency identity, and reconciliation provenance.

## Failure, recovery, and idempotency

Malformed, oversize, duplicate-conflicting, untrusted, expired, revoked, or unverifiable packages remain quarantined. Partial writes and restarts are idempotently recovered without promoting status.

## Security and privacy

Parse untrusted packages in bounded quarantine, verify before persistence, redact prohibited material, and keep accepted status append-only and generation-fenced.

## Compatibility and migration

Ingest accepts only declared package/schema versions and stores original bytes/hash. Normalization that changes semantics creates a new package identity.

## SLO, capacity, and observability

Track verification/ingest/reconciliation latency, stale/revoked/duplicate/conflict rates, unresolved ambiguity age, and trust/currentness failures. False acceptance, duplicate external effects, and self-issued promotion are zero-tolerance.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-QUAL-SOURCE`, `CAP-REL-VERIFY`. Related work identifiers: `GAP-REL-001`. Implementation/contract roots: `rust/crates/hepta-qualification-ingest`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `GAP-REL-001` — `blocked_external`
