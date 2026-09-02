# module.commit-sequencer

Status: normative module specification  
Manifest: [`../manifests/commit-sequencer.v1.json`](../manifests/commit-sequencer.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.commit-sequencer
implementationKind: host_service
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: central_state_write
qualificationRequirement: target_host
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-STATE
secondaryOwnerTeam: TEAM-KERNEL
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Provide the sole authoritative campaign-state commit path, validating fenced prepared results and returning idempotent durable receipts.

It does not perform long-running scientific/provider work or own release/submission credentials. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- verified prepared result
- expected campaign/node revisions
- writer and lease generations
- resource settlement identity

Outputs:

- committed/already-committed/stale/conflict receipt
- hash-linked authoritative event

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `central_state_write`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It is a logical single-writer boundary for its state domain. Raw writable handles are never exposed; writer generation, expected revision, idempotency, and fencing are mandatory.

Declared side-effect classes: `central_commit`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.policy-engine`

Current implementation and contract roots:

- `rust/crates/hepta-campaign-writer`
- `docs/control-plane/COMMIT_SEQUENCER.md`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs as a role-specific service with bounded listeners/workers, queue depth, file descriptors, CPU, memory, storage, and deadlines. Startup/recovery capacity is reserved separately. Backpressure is machine-readable, and every accepted operation is linked to a reservation or a documented control-plane exemption.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject stale revisions, attempts, leases, plans, reservations, verifier identities, writer generations, or conflicting idempotency. Unknown residue disables admission; exact duplicates return the original receipt.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Only the sequencer owns the writable campaign connection. Writer leases and generations prevent stale or dual writers; callers receive no raw database handle.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Command, event, receipt, and database schema versions are explicit. Rollback is restore/migration based and cannot reopen terminal commands.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track p50/p95/p99 latency, maximum queue age/depth, throughput, timeout/fallback rate, recovery time, and all zero-tolerance safety counters. Canonical workload and threshold versions are bound in the deployment evidence; source documents do not invent production numbers.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-STATE-COMMIT`. Related work identifiers: `CTL-007`, `GAP-HOST-002`. Implementation/contract roots: `rust/crates/hepta-campaign-writer`, `docs/control-plane/COMMIT_SEQUENCER.md`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. Promotion follows disabled → shadow/read-only comparison → bounded canary → authoritative, with an exact rollback version and atomic mutual-exclusion fencing. A failed or ambiguous canary stops admission and invokes reconciliation before rollback; dual authority is forbidden.

## Open blockers

- `CTL-007` — `source_implemented`
- `GAP-HOST-002` — `blocked_external`
- Effective `target_host` evidence remains deployment/external-subject specific and cannot be committed as static success.
