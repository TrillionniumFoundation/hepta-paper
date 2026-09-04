# module.rust-control-plane-service

Status: normative module specification  
Manifest: [`../manifests/rust-control-plane-service.v1.json`](../manifests/rust-control-plane-service.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.rust-control-plane-service
implementationKind: host_service
staticImplementationState: design_ready
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-RUNTIME
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Compose the production Rust control-plane process around qualified registry, snapshot, policy, planning, admission, dispatch, verification, commit, and observability ports.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- qualified service configuration
- registry and policy artifacts
- read-only state
- module health and resource observations

Outputs:

- plan/dispatch/verification/commit orchestration
- run receipt
- bounded events and readiness state

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.scheduler-core`
- `module.execution-dispatcher`
- `module.commit-sequencer`

Current implementation and contract roots:

- `docs/control-plane/COMPOSITION_ROOT.md`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Startup fails before readiness on identity, schema, registry, qualification, reconciliation, writer-generation, or dependency failure. Runtime failure fences new dispatch, preserves prepared work, and requires deterministic recovery before restart.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Run under a dedicated principal with read-only policy/registry inputs and narrow broker/sequencer ports. It holds no provider, KMS/HSM, WORM, portal, or submission secrets.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Service upgrades require protocol/state compatibility, reconciliation of in-flight work, exact rollback target, and no dual-writer/external-effect reachability.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track p50/p95/p99 latency, maximum queue age/depth, throughput, timeout/fallback rate, recovery time, and all zero-tolerance safety counters. Canonical workload and threshold versions are bound in the deployment evidence; source documents do not invent production numbers.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-CTL-SNAPSHOT`, `CAP-CTL-POLICY`, `CAP-EXE-DISPATCH`. Related work identifiers: `CTL-001`, `CTL-008`. Implementation/contract roots: `docs/control-plane/COMPOSITION_ROOT.md`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-001` — `design_ready`
- `CTL-008` — `source_implemented`
