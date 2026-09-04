# module.execution-dispatcher

Status: normative module specification  
Manifest: [`../manifests/execution-dispatcher.v1.json`](../manifests/execution-dispatcher.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.execution-dispatcher
implementationKind: trusted_in_process
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: prepared_result_only
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-RUNTIME
secondaryOwnerTeam: TEAM-KERNEL
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Translate admitted plan actions into identity-bound execution commands, route them to qualified modules, and classify cancellation and ambiguous outcomes.

It does not commit campaign state, authorize release/submission, or declare its own result accepted. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- admitted action
- reservation lease
- qualified module identity
- workspace/artifact and cancellation identities

Outputs:

- execution command and ordered events
- prepared result or conservative ambiguity
- resource-use observation

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `prepared_result_only`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. It may write only attempt-local workspace or prepared-result state. A verifier and the commit sequencer decide whether any result becomes authoritative.

Declared side-effect classes: `local_ephemeral`, `workspace_mutation`, `prepared_result`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.codex-broker`
- `module.workspace-authority`

Current implementation and contract roots:

- `docs/control-plane/COMPOSITION_ROOT.md`
- `docs/control-plane/REPLAN_AND_RECOVERY.md`
- `rust/crates/hepta-control-plane`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject stale plans/reservations, incompatible module versions, expired commands, conflicting idempotency, unsafe cancellation, missing workspace identity, or unclassified post-effect failure. Timeouts never prove non-execution.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Commands carry least-privilege audiences and exact expiry. The dispatcher cannot mint credentials or broaden module authority.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Support declared protocol ranges and explicit cancellation/result dispositions. Unknown future terminal events fail closed.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track readiness, admission/dispatch latency, busy and rejection rates, queue depth, crash/restart reconciliation, prepared-result durability, cleanup time, and identity/security violations. Identity violations and duplicate effects are zero-tolerance.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-EXE-DISPATCH`, `CAP-MOD-EXECUTION`. Related work identifiers: `CTL-005`, `MOD-003`. Implementation/contract roots: `docs/control-plane/COMPOSITION_ROOT.md`, `docs/control-plane/REPLAN_AND_RECOVERY.md`, `rust/crates/hepta-control-plane`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-005` — `design_ready`
- `MOD-003` — `design_ready`
