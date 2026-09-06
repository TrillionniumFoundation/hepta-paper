# module.candidate-router

Status: normative module specification  
Manifest: [`../manifests/candidate-router.v1.json`](../manifests/candidate-router.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.candidate-router
implementationKind: trusted_in_process
staticImplementationState: design_ready
staticActivation: disabled
authorityClass: pure
qualificationRequirement: source
protocolMinimum: 1
protocolMaximum: 1
primaryOwnerTeam: TEAM-KERNEL
secondaryOwnerTeam: TEAM-SCHEDULER
independentReviewerTeam: TEAM-EVIDENCE
```

The exact executable/image/source digest, configuration digest, deployment generation, host identity, active qualification evidence, and rollback version are supplied by the qualified deployment registry. This static document cannot grant them.

## Mission and non-goals

Request, bound, validate, canonicalize, and deduplicate module planning candidates against one immutable snapshot before global selection.

It does not hold credentials, execute external effects, mutate authoritative state, choose the global plan, or independently qualify a module binding. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- planning request bound to one snapshot
- exact module-version bindings supplied by trusted composition
- qualified module registry projection
- hard policy
- candidate byte/count budgets
- explicit clock observation

Outputs:

- canonical candidate frontier
- rejection and duplicate reasons
- planning-request, module-binding-set, and candidate-set hashes
- explicit empty or singleton disposition

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `pure`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. The module owns no durable state and returns values only.

Declared side-effect classes: `none`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.module-registry`

Current implementation and contract roots:

- `paper-application/orchestration/candidate-router.mjs`
- `paper-core/tests/candidate-router.test.mjs`
- `docs/control-plane/CANDIDATE_ROUTER_IMPLEMENTATION.md`
- `docs/modules/MODULE_PROTOCOL.md`
- `docs/control-plane/COMPOSITION_ROOT.md`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

The current source increment is synchronous and performs no I/O. It enforces compiled ceilings for candidate count, per-candidate bytes, total bytes, JSON depth/nodes/items, and string bytes. Caller limits may narrow but cannot exceed those ceilings. It creates no pool, worker, process, timer, provider call, storage mutation, or network action.

A later qualified deployment profile still records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same captured input, module version, configuration, and explicit clock produce byte-identical canonical output in the qualified runtime. Candidate input order and semantic-set order do not affect the frontier. Ambient wall clock, inherited environment, process identity, map insertion order, and provider state are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

The current implementation deliberately reports `dominanceReductionApplied:false`. A candidate with better local value and cost may introduce dependency, authority, compatibility, resource, evidence, consumer, or output-semantic effects that make another candidate the only globally feasible option. Dominance removal is permitted only after a versioned contextual-substitutability proof and executable conformance suite establish that replacement is safe in every allowed global context.

## Failure, recovery, and idempotency

Reject late, stale, duplicate-conflicting, oversize, infeasible, unauthorized, non-finite, uncalibrated, or semantically conflicting candidates. Accessor properties, inherited fields, symbols, sparse arrays, unknown fields, NUL text, invalid hashes/timestamps, unsafe integers, duplicate set entries, expired requests/candidates/bindings, and exact request/snapshot/capability/module-version mismatches fail before frontier construction.

Exact canonical duplicates collapse idempotently and are counted. Conflicting reuse of a candidate ID or payload hash is rejected. An empty frontier requires an explicit bounded reason; a singleton requires an explicit singleton reason. These dispositions are not proof of global infeasibility or uniqueness.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the same canonical result; conflicting identity reuse is rejected.

## Security and privacy

Candidate producers receive no writer, provider, release, or submission credentials. Payloads are bounded and secrets/prose are referenced by immutable artifact identity. Output authority flags are all false.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Candidate envelopes use explicit protocol/schema versions. Semantic changes to feasibility, units, dominance, set ordering, payload hashing, expiry, module-binding interpretation, or uncertainty require a new version and fresh qualification.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track bounded latency, input/result bytes, candidate and duplicate counts, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

Every signal binds module/version/configuration, planning request/snapshot/frontier identities, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

No long-lived service lifecycle is assumed. Callers capture a current planning request and exact accepted module bindings, supply an explicit clock, retain the returned frontier hash, and invalidate it after any snapshot, objective, constraint, price, module-binding, protocol, qualification, or source change. A rejection triggers correction or replan; it must not be converted into an empty or successful frontier.

Consumers rerun the conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes. Rollback restores the prior exact router version and invalidates frontiers produced by the reverted semantics.

## Verification and evidence

`paper-core/tests/candidate-router.test.mjs` covers valid payload-hash round trips, deterministic input-order/set-order handling, exact duplicate collapse, identity conflicts, forged hashes, empty/singleton dispositions, request/snapshot/capability/module/expiry/side-effect bindings, malformed resources, accessor suppression, sparse and unknown input, count/byte ceilings, planning-hash sensitivity and immutable capture.

A specific regression retains two candidates where one has better local value/cost but a materially different dependency effect. This prevents unproved local Pareto reduction from deleting a globally necessary candidate.

Capability bindings: `CAP-MOD-CANDIDATES`. Related work identifiers: `CTL-004`, `MOD-002`. Source implementation and focused tests are now present, but this static module status remains `design_ready` until manifest/registry path alignment, scheduler integration, exact-head and merge qualification, protocol compatibility review, and independent evidence acceptance are completed. Source conformance never substitutes for target-host or external-authority evidence.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight plans, cached frontiers, and post-rollback verification.

## Open blockers

- `CTL-004` — `design_ready`
- `MOD-002` — `design_ready`
- machine registry and manifest implementation-path alignment
- scheduler/composition integration and exact current qualification
- independent protocol and evidence review
