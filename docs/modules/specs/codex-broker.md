# module.codex-broker

Status: normative module specification  
Manifest: [`../manifests/codex-broker.v1.json`](../manifests/codex-broker.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.codex-broker
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-RUNTIME
secondaryOwnerTeam: TEAM-SRE
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Mediate bounded role-separated Codex execution through authenticated local admission, durable journaling, pre-exec gating, containment, and prepared-result recovery.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- bounded authenticated local frame
- role capability
- qualified runtime and schema identity
- deadline and idempotency key

Outputs:

- reservation/admission disposition
- bounded execution events
- durable prepared result and recovery receipt

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.protocol-kernel`

Current implementation and contract roots:

- `rust/crates/hepta-codex-broker`
- `rust/crates/hepta-codex-journal`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Fail closed on peer, capability, socket, runtime, schema, journal, gate, containment, stream, or prepared-result mismatch. Restart reconciliation distinguishes pre-release, may-have-started, prepared, and committed outcomes without duplicate provider calls.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Use role-separated Unix principals, private sockets/homes/journals, peer credentials, expiring capabilities, non-writable schema/gate identities, and cgroup containment.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Broker request, journal, event, trust-bundle, and prepared-result versions remain independently migratable with exact restart/rollback rules.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track readiness, admission/dispatch latency, busy and rejection rates, queue depth, crash/restart reconciliation, prepared-result durability, cleanup time, and identity/security violations. Identity violations and duplicate effects are zero-tolerance.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-EXE-BROKER`. Related work identifiers: `GAP-CODEX-001`, `GAP-HOST-001`, `GAP-KEY-001`. Implementation/contract roots: `rust/crates/hepta-codex-broker`, `rust/crates/hepta-codex-journal`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `GAP-CODEX-001` — `blocked_external`
- `GAP-HOST-001` — `blocked_external`
- `GAP-KEY-001` — `blocked_external`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
