# module.policy-engine

Status: normative module specification  
Manifest: [`../manifests/policy-engine.v1.json`](../manifests/policy-engine.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.policy-engine
implementationKind: pure_library
staticImplementationState: source_implemented
staticActivation: disabled
authorityClass: pure
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-EVIDENCE
independentReviewerTeam: TEAM-STATE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Evaluate hard authority, evidence, compatibility, dependency, budget, privacy, and external-effect constraints without converting them into soft penalties.

It does not hold credentials, execute external effects, or mutate authoritative state. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- snapshot
- authority and evidence rules
- budget/resource limits
- compatibility and privacy policies

Outputs:

- hard admissibility decision
- normalized reason codes
- policy hash

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `pure`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. The module owns no durable state and returns values only.

Declared side-effect classes: `none`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.snapshot-builder`

Current implementation and contract roots:

- `docs/control-plane/COMPOSITION_ROOT.md`
- `docs/system/INVARIANTS.md`
- `rust/crates/hepta-control-plane`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Runs in-process with bounded input and output sizes and no independently created threads, network calls, child processes, or mutable global state. CPU and memory limits are inherited from the calling command; algorithmic bounds and maximum collection sizes are part of the protocol.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject unknown rules, conflicting hard policies, invalid hashes, unsupported authority classes, or missing decision inputs. A policy evaluation failure is denial, never a default allow.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Policy code is pure, versioned, and independently reviewed; override attempts are audit events and never silently widen authority.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Policy versions and hashes are immutable inputs. A policy change invalidates affected plans and prepared results unless explicitly compatible and reverified.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-CTL-POLICY`. Related work identifiers: `CTL-003`. Implementation/contract roots: `docs/control-plane/COMPOSITION_ROOT.md`, `docs/system/INVARIANTS.md`, `rust/crates/hepta-control-plane`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-003` — `source_implemented`
- No additional repository-local implementation blocker is asserted by this specification; qualification, activation, and operation remain separate.
