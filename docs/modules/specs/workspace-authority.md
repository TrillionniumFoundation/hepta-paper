# module.workspace-authority

Status: normative module specification  
Manifest: [`../manifests/workspace-authority.v1.json`](../manifests/workspace-authority.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.workspace-authority
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-WORKSPACE
secondaryOwnerTeam: TEAM-STATE
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Own attempt-scoped mutable workspaces and descriptor-bound inventory, mutation, artifact, integration, cleanup, and recovery boundaries.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- source snapshot and attempt identity
- mutation policy
- opened root descriptors
- artifact/integration request

Outputs:

- before/after inventories
- prepared mutation descriptor
- content-addressed artifacts
- cleanup/recovery receipt

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.protocol-kernel`

Current implementation and contract roots:

- `rust/crates/hepta-workspace`
- `rust/crates/hepta-workspace-authority`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject symlinks, forbidden hard links, special nodes, mount crossing, descriptor replacement, ownership/mode drift, inventory overflow, stale attempts, or no-clobber conflicts. Cleanup revalidates object identity before deletion.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Use descriptor-relative no-follow traversal, private attempt principals, bounded roots, exact inventories, and no ambient credentials.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Workspace and inventory schemas are versioned; rollback must retain descriptor/object compatibility and prepared-result replay.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track readiness, admission/dispatch latency, busy and rejection rates, queue depth, crash/restart reconciliation, prepared-result durability, cleanup time, and identity/security violations. Identity violations and duplicate effects are zero-tolerance.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-WS-AUTHORITY`. Related work identifiers: `MIG-003`, `GAP-HOST-002`. Implementation/contract roots: `rust/crates/hepta-workspace`, `rust/crates/hepta-workspace-authority`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `MIG-003` — `design_ready`
- `GAP-HOST-002` — `blocked_external`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
