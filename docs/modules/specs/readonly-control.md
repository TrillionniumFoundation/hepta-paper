# module.readonly-control

Status: normative module specification  
Manifest: [`../manifests/readonly-control.v1.json`](../manifests/readonly-control.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.readonly-control
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: read_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-STATE
secondaryOwnerTeam: TEAM-PROTOCOL
independentReviewerTeam: TEAM-EVIDENCE
```

Common identity, wire, retry, resource, privacy and compatibility requirements
are normative in the [shared module contract](../MODULE_MODEL.md#shared-engineering-requirements).
The sections below define this module's implementation-specific boundaries.

## Mission and non-goals

Expose validated read-only campaign and control projections without leaking writable database handles or silently accepting schema drift.

It does not mutate campaign state, issue external effects, or self-promote evidence. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- database/read-model identity
- expected schema and integrity policy
- bounded query

Outputs:

- typed immutable projection
- schema/integrity receipt
- staleness marker

## State and authority

Maximum authority class: `read_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may read only declared projections/artifacts and cannot mutate campaign or external state.

Declared side-effect classes: `none`.

## Dependencies

Hard registered module dependencies:

- `module.protocol-kernel`

Current implementation and contract roots:

- `rust/crates/hepta-readonly-store`
- `rust/crates/hepta-readonly-control`

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

## Failure, recovery, and idempotency

Reject foreign database identity, unsupported schema, integrity failure, mutable handles, unbounded queries, or projection staleness. Missing data remains missing and is not synthesized as success.

## Security and privacy

Open state read-only, validate file/schema identity, cap queries/results, and prevent read paths from exposing credential or writer material.

## Compatibility and migration

Readers declare supported state/schema ranges. Unsupported future schemas fail before any query; caches are invalidated by generation.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

## Operational runbook

Operate only the explicitly selected database/read model through the
[read-only store contract](../../../rust/crates/hepta-readonly-store/README.md).
An immutable-file path requires a separately captured stable copy without active
WAL/SHM sidecars. A live SQLite reader follows its own snapshot contract; the two
modes cannot be exchanged by renaming a file.

On foreign schema, missing history, corruption or identity change, return the
actual rejection and leave source bytes untouched. Do not run migrations,
checkpoint a live writer, create missing metadata, or treat a failed inspection
as an empty campaign. The owner captures a new valid snapshot or supplies a
qualified recovery before retry. Read-only success never grants a writer lease.

## Verification and evidence

Capability bindings: `CAP-STATE-READ`. Related work identifiers: `CTL-002`. Implementation/contract roots: `rust/crates/hepta-readonly-store`, `rust/crates/hepta-readonly-control`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Runtime migration implementation details

See the [database detection and read-only compatibility contract](../../../rust/crates/hepta-readonly-store/README.md). It specifies recognition of real Node `schema_migrations` and metadata with `PRAGMA user_version=0`, structural and migration-history checks, the separate Rust HPCW discriminator, snapshot decoding and adversarial tests. Read-only inspection preserves the source database; it neither upgrades native schema nor grants a writer lease.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-002` — `source_implemented`
