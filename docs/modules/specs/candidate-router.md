# module.candidate-router

Status: normative module specification  
Manifest: [`../manifests/candidate-router.v1.json`](../manifests/candidate-router.v1.json)  
Registry: [`../../system/truth/modules.v1.json`](../../system/truth/modules.v1.json)

## Identity

```text
moduleId: module.candidate-router
implementationKind: trusted_in_process
staticImplementationState: source_implemented
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

Request, bound, validate, canonicalize, and deduplicate module planning candidates against one immutable snapshot before global selection. The current source accepts caller-supplied module qualification metadata but does not authenticate it; production composition must pass a separately verified currentness receipt.

It does not hold credentials, execute external effects, or mutate authoritative state. A source implementation, fixture, model narrative, repository administrator statement, or this document is never sufficient production authority.

## Inputs and outputs

Inputs:

- planning request bound to one snapshot
- caller-supplied, self-consistent module qualification metadata whose external currentness receipt has been authenticated by composition
- hard policy
- candidate byte/count/aggregate-structure budgets

Outputs:

- canonical candidate frontier
- rejection and dominance reasons
- candidate-set hash

Every request, result, event, health record, and receipt carries explicit schema/kind/version, canonical encoding, maximum bytes/counts, freshness and authority requirements, idempotency identity where applicable, unknown-field policy, and confidentiality classification. Large or confidential content moves by immutable artifact reference rather than unbounded protocol payload.

## State and authority

Maximum authority class: `pure`. Current static activation: `disabled`. The registry declaration is a ceiling and request, not an authority grant. The module owns no durable state and returns values only.

Declared side-effect classes: `none`.

Module-private journals may support idempotency and recovery but never become a second campaign-state authority. All durable or irreversible boundaries emit a typed receipt or conservative ambiguity disposition.

## Dependencies

Hard registered module dependencies:

- `module.module-registry`

Current implementation and contract roots:

- `docs/modules/MODULE_PROTOCOL.md`
- `docs/control-plane/COMPOSITION_ROOT.md`
- `paper-application/orchestration/candidate-router.mjs`

Imports of another module's private source are not a dependency contract. Runtime, schema, trust, host, dataset, provider, and external-authority dependencies must also be bound by exact identity in the deployment subject.

## Concurrency and resources

Uses the caller's bounded executor and declares maximum inflight work, queue depth, result bytes, CPU/memory budget, blocking boundary, and cancellation point in the qualified deployment profile. It may not create an unbounded pool or consume undeclared provider, GPU, storage, or network capacity.

The qualified profile records minimum/typical/hard maximum resources, startup and warm-cache cost, maximum inflight work and queue depth, preemption points, affinity/anti-affinity, expected duration/confidence, overload response, and settlement evidence.

## Determinism and optimization contract

Declared class: `deterministic`. The same canonical input, module version, configuration, and explicit clock produce byte-identical canonical output. Map iteration, wall-clock observation order, process IDs, and ambient environment are not semantic inputs.

A candidate-producing module must expose feasible alternatives or a justified singleton, finite resource/cost/latency/risk estimates, uncertainty, expiry, dependency effects, and a canonical payload hash. Local utility is advisory; global priority and integration remain control-plane decisions.

## Failure, recovery, and idempotency

Reject late, stale, duplicate, oversize, infeasible, unauthorized, non-finite, uncalibrated, or semantically conflicting candidates. The pure source boundary does not invoke producers or implement timeouts; a separate bounded producer-collection layer must return a typed incomplete-frontier disposition rather than partial success.

Retries occur only at the documented layer and use a new attempt when identity, method, policy, tolerance, dataset, runtime, or irreversible-effect disposition changes. Exact duplicates return the original result/receipt; conflicting reuse of an idempotency identity is rejected.

## Security and privacy

Candidate producers receive no writer, provider, release, or submission credentials. Payloads are bounded and secrets/prose are referenced by immutable artifact identity.

Logs and telemetry use an allowlist of bounded machine fields. Credential bytes, private keys, unrestricted prompts/provider responses, confidential manuscript content, developer home paths, and environment dumps are prohibited unless an independently reviewed evidence contract explicitly requires a protected representation.

## Compatibility and migration

Candidate envelopes use explicit protocol/schema versions. Semantic changes to feasibility, units, dominance, or uncertainty require a new version.

Compatibility is one of exact, semantic, evaluation-based, or retired. A breaking protocol, state, authority, resource-unit, side-effect, or rubric change requires a new module version, migration/rollback plan, fresh conformance, and downstream qualification invalidation.

## SLO, capacity, and observability

Track bounded latency, result bytes, rejection classes, resource use, replay determinism, recovery disposition, and capability-specific zero-tolerance counters. Thresholds are attached to named canonical workloads and exact evidence subjects.

Every signal binds module/version/configuration, campaign/plan/attempt/reservation identities as applicable, schema version, producer trust class, privacy class, and retention rule. A dashboard or healthy heartbeat is not qualification or authority.

## Operational runbook

No long-lived service lifecycle is assumed. Callers validate module/version/configuration before use, record typed failures, invalidate cached results on any bound subject change, and rerun the module's conformance suite after protocol, policy, dependency, resource, ownership, or implementation changes.

## Verification and evidence

Capability bindings: `CAP-MOD-CANDIDATES`. Related work identifiers: `CTL-004`, `MOD-002`. Implementation/contract roots: `docs/modules/MODULE_PROTOCOL.md`, `docs/control-plane/COMPOSITION_ROOT.md`, `paper-application/orchestration/candidate-router.mjs`. Required evidence includes positive, negative, malformed, oversize, replay, cancellation/crash, resource, authority, compatibility, and secrecy tests as applicable. Source conformance never substitutes for target-host or external-authority evidence.

### Executable candidate-frontier source candidate

`paper-application/orchestration/candidate-router.mjs` provides the pure,
deterministic `routeActionCandidatesV1` boundary. Its JavaScript object API is
explicitly limited to `trusted_same_realm_plain_data`. Accessor properties,
unknown fields, sparse arrays, symbols, unsupported prototypes and malformed
records fail closed. Reflection on a JavaScript `Proxy` can itself execute proxy
traps; the module catches reflection failures but does not claim that same-realm
Proxy input is inert. Untrusted input must first cross a duplicate-key-safe,
bounded serialized or process-isolation boundary which produces ordinary
plain/null-prototype data.

Opaque candidate records are copied into null-prototype objects using explicit
data-property definition. Legal own keys including `__proto__`, `constructor`
and `prototype` therefore remain hash-visible and cannot mutate the captured
prototype. Strings and keys are bounded by UTF-8 bytes. One aggregate node
budget covers every opaque `duration`, `cost`, `value` and `risk` field across
the complete routing transaction; it is not reset per field or candidate.
Per-candidate and aggregate canonical byte ceilings remain separate limits.

The V1 hash domain uses deterministic canonical JSON with object keys ordered by
unsigned UTF-8 bytes. It does not call `localeCompare`, inherit process locale,
or rely on JavaScript's integer-key enumeration order. Candidate/module/request
input order is separately canonicalized. Non-ASCII subprocess vectors under
multiple locale environments must produce identical module, candidate,
candidate-set and frontier hashes.

The source accepts closed `PlanningModuleQualificationMetadataV1` records. Each
record binds module/version/capabilities, claimed qualification status and
identity, monotonic generation, observation/expiry interval, revocation-set
identity and an external-currentness receipt identity. The complete payload is
rehashable through `qualificationMetadataHash`, and the planning request binds
the complete metadata-set hash. Routing time must lie within every supplied
interval and the frontier expires no later than the earliest module, request or
candidate expiry.

These records deliberately carry:

```text
qualificationTrustClass: caller_supplied_unverified
qualificationCurrentnessMode: external_live_revalidation_required
externalCurrentnessGateRequired: true
```

The router checks internal identity, interval and hash consistency only. It does
not authenticate the currentness receipt, query a revocation service, qualify a
module or convert metadata into production trust. Trusted composition must
verify the receipt against the current registry/revocation subject before
calling the router and again before consuming the frontier.

`sealActionCandidateV1` recomputes a candidate payload hash. Exact duplicate
candidates collapse idempotently; conflicting candidate IDs or payload hashes
reject the whole request. Request, snapshot, capability, module version, expiry
and side-effect identities must match before a candidate enters the frontier.
A one-candidate frontier requires an explicit singleton reason; an empty
frontier remains explicit. All authority fields remain false.

The source deliberately performs **no Pareto reduction**. Local value, cost or
resource dominance is not a context-safe replacement proof when dependency
effects, permissions, evidence, compatibility or downstream feasibility differ.
Candidates remain available unless a future version supplies and independently
verifies a bounded contextual-replacement certificate covering every hard
constraint. Global selection remains the scheduler/control-plane decision.

`paper-core/tests/candidate-router.test.mjs` covers order and locale
independence, exact deduplication, special-key preservation, aggregate structure
budgets, request/module/currentness identity, expiry and side-effect boundaries,
malformed numbers, accessor and Proxy failure classification, sparse/cyclic
inputs, count/byte limits, request-hash sensitivity and post-call mutation.
These are source controls, not registry authentication, external currentness,
source qualification or accepted MOD-002/CTL-004 evidence. The static module
state therefore remains `design_ready` pending isolated-input composition,
current exact-source qualification, consumer integration and independent review.

The module documentation validator additionally proves one-to-one registry/spec/manifest coverage, required section presence, registry-field consistency, source-path existence, and authority-specific safety language.

### Runtime migration implementation details

The actual JavaScript source path is `paper-application/orchestration/candidate-router.mjs` in the registry, manifest and implementation roots above. The static state remains `design_ready`; this registration repairs source inventory and confers no currentness or activation authority.

## Rollout and rollback

Current channel is `disabled`. A new version progresses through registered/contract-ready/source-implemented/conformance-qualified and then shadow/canary/authoritative where applicable. Rollback binds exact version, protocol/state compatibility, in-flight work, prepared results, and post-rollback verification.

## Open blockers

- `CTL-004` — `source_implemented`
- `MOD-002` — `source_implemented`
