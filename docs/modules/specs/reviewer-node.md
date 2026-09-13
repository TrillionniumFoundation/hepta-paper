# module.reviewer-node

Status: normative module specification  
Manifest: [`../manifests/reviewer-node.v1.json`](../manifests/reviewer-node.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.reviewer-node
implementationKind: isolated_process
staticImplementationState: source_implemented
staticActivation: authoritative
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-REVIEW
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-AUTHOR
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Independently assess exact author outputs against versioned rubrics and evidence, producing read-only review findings and signed/hashed review receipts.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- read-only exact author output
- review rubric and evidence graph
- reviewer runtime identity
- conflict-of-interest policy

Outputs:

- structured findings and severity
- accept/revise/reject recommendation
- independent review receipt

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `authoritative`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.node-control-plane`

Current implementation and contract roots:

- `paper-application/automation`
- `paper-domain/research`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs behind a qualified process/container runner with explicit CPU, memory, PID, storage, deadline, network, token/provider, and optional GPU envelopes. Child concurrency is included in the reservation; overload returns a bounded busy/retry disposition rather than bypassing central admission.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `bounded_nondeterministic`. Output content may vary, but schemas, authority, tools, resources, side effects, quality metrics, and evidence requirements are hard bounded. Predictions are advisory and actual outcomes feed a separately versioned calibration process.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject mutable author workspaces, hidden author session state, stale subjects, missing rubric/evidence, conflicts of interest, unbounded prose, or recommendations without normalized findings and exact reviewer identity.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Use a distinct reviewer principal and private read-only clone; deny author credential/session access and mutation of the reviewed attempt.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Review rubric, severity taxonomy, recommendation rules, model/runtime, and receipt schema are versioned; old reviews bind the old subject.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track admission/start latency, execution duration, success/timeout/cancel rate, resource and cost settlement, output validity, evidence/quality gain, reproducibility, and recovery time. Quality and scientific metrics are versioned by workload and cannot be replaced by repository-wide green CI.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

Startup validates exact source/binary or image, configuration, principal, paths, schema/state versions, dependency health, qualification freshness, and recovery residue before readiness. Operators stop admission before shutdown, preserve journals and prepared artifacts, reconcile ambiguous effects, and use the owning work-item/external package for escalation. No operator command may bypass idempotency, fencing, independent verification, or the authority ceiling.

## Verification and evidence

Capability bindings: `CAP-REVIEW`. Related work identifiers: `REVIEW-001`. Implementation/contract roots: `paper-application/automation`, `paper-domain/research`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `authoritative`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `REVIEW-001` — `source_implemented`
- No additional repository-local implementation blocker is asserted by this specification; qualification, activation, and operation remain separate.
